/**
 * Missing-files report (spec 4.5): files the library expects but cannot find, from the integrity
 * check. "Search a folder…" looks there for each one by hash and name and relinks what it finds.
 * On Windows, looking into a cloud-synced folder (OneDrive, Dropbox, …) can make files that are
 * kept online only download, so the search warns before it starts (Task 14 deferred minor). The
 * library's other maintenance action, "Rebuild library from folder" (spec 4.3, D8), is here too.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GovernanceApi, IntegrityAnswer, RelinkResult } from "../api/governance";
import { RebuildIndex } from "../components/RebuildIndex";
import { PathField } from "../components/PathField";
import "./GovernanceScreens.css";

const SKIP_REASON: Record<string, string> = {
  "project-locked": "its project is locked; unlock it, then search again",
  placeholder: "only online-only copies were found; make them available offline, then search again",
  "outside-library": "the matching file is outside the library",
  "not-linkable": "the matching file is in a place a link may not point to",
  "verify-failed": "a file with the same name was found but its content is different",
  "target-exists": "a different file already sits where it belongs",
};

/** Review M3: the check's progress is told to a screen reader at most this often (it is shown as it comes). */
const SAY_PROGRESS_MS = 5_000;

const files = (n: number) => (n === 1 ? "1 file" : `${n.toLocaleString("en-US")} files`);

/** Whether the app runs on Windows (the webview's user agent names it). */
function onWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

export function MissingFiles({ api, isWindows = onWindows() }: { api: GovernanceApi; isWindows?: boolean }) {
  const ids = useId();
  const [integrity, setIntegrity] = useState<IntegrityAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelinkResult | null>(null);
  /** R641 D3: how far the running check is (none while its files are listed), and whether it was stopped. */
  const [progress, setProgress] = useState<{ checked: number; total: number } | null>(null);
  const [stopped, setStopped] = useState(false);
  const running = useRef<AbortController | null>(null);
  const checkAgainRef = useRef<HTMLButtonElement>(null);
  /** Review M3: the progress line as last told to a screen reader, and when. */
  const [said, setSaid] = useState("");
  const saidAt = useRef(Number.NEGATIVE_INFINITY);
  const line = progress ? `Checked ${progress.checked.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")} files…` : null;
  useEffect(() => {
    if (line === null) return;
    const say = () => {
      saidAt.current = Date.now();
      setSaid(line);
    };
    const wait = saidAt.current + SAY_PROGRESS_MS - Date.now();
    if (wait <= 0) return say();
    const t = setTimeout(say, wait);
    return () => clearTimeout(t);
  }, [line]);

  const load = useCallback(async () => {
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    saidAt.current = Number.NEGATIVE_INFINITY;
    setSaid("");
    setError(null);
    setStopped(false);
    setProgress(null);
    setIntegrity(null);
    try {
      // No time limit (R601): a large library on a slow disk takes as long as it takes; "Stop" ends it.
      const answer = await api.integrityProgress({ signal: ac.signal, onProgress: (checked, total) => !ac.signal.aborted && setProgress({ checked, total }) });
      if (!ac.signal.aborted) setIntegrity(answer);
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "The library could not be checked.");
    } finally {
      if (running.current === ac) {
        running.current = null;
        setProgress(null);
      }
    }
  }, [api]);
  useEffect(() => {
    void load();
    return () => running.current?.abort();
  }, [load]);
  /** Stops the running check: it only reads, so nothing was changed; the page says so and offers to check again. */
  const stop = () => {
    running.current?.abort();
    running.current = null;
    setProgress(null);
    setStopped(true);
  };
  useEffect(() => {
    if (stopped) checkAgainRef.current?.focus();
  }, [stopped]);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.relink(folder.trim()));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The folder could not be searched.");
    } finally {
      setBusy(false);
    }
  };

  const missing = integrity?.report.missing ?? [];
  return (
    <main className="ao-screen">
      <h1>Missing files</h1>
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
      {stopped ? (
        <div className="ao-actions">
          <p role="status">The check was stopped. Nothing was changed.</p>
          <button type="button" ref={checkAgainRef} onClick={() => void load()}>
            Check again
          </button>
        </div>
      ) : !integrity ? (
        error ? (
          // A check that failed (partway or at once) has a way on (review I2).
          <div className="ao-actions">
            <button type="button" onClick={() => void load()}>
              Check again
            </button>
          </div>
        ) : progress ? (
          <div className="ao-actions">
            {/* Shown as it comes; told to a screen reader by the status below, at most every SAY_PROGRESS_MS (review M3). */}
            <p>{line}</p>
            <p role="status" className="ao-visually-hidden">
              {said}
            </p>
            <button type="button" onClick={stop}>
              Stop
            </button>
          </div>
        ) : (
          <p role="status">Checking the library…</p>
        )
      ) : missing.length === 0 ? (
        <p>No files are missing.</p>
      ) : (
        <>
          <p>{files(missing.length)} cannot be found where the library expects them.</p>
          <ul className="ao-list" aria-label="Missing files">
            {missing.map((m) => (
              <li key={m.path}>
                <code>{m.path}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {integrity && integrity.report.placeholders.length ? (
        <p className="ao-hint">{files(integrity.report.placeholders.length)} are kept online only by a cloud-storage service; they are not missing, and are downloaded when opened.</p>
      ) : null}

      <div className="ao-actions">
        <button type="button" aria-expanded={searching} aria-controls={`${ids}-search`} onClick={() => setSearching((s) => !s)}>
          Search a folder…
        </button>
      </div>
      {searching ? (
        <form
          id={`${ids}-search`}
          className="ao-card"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          {isWindows ? (
          <p className="ao-warning">
            On Windows, searching a folder kept in OneDrive or another cloud-storage service can make it download files that are stored online only. Choose the folder that holds the missing files, not a whole drive.
          </p>
          ) : null}
          <div className="ao-field">
            <PathField id={`${ids}-dir`} label="Folder to search" pick="folder" pickerTitle="Choose the folder that holds the missing files" value={folder} onChange={setFolder} />
            <button type="submit" disabled={busy || !folder.trim()}>
              Search and relink
            </button>
          </div>
          {busy ? <p role="status">Searching…</p> : null}
        </form>
      ) : null}

      {result ? (
        <section className="ao-card" aria-labelledby={`${ids}-res`}>
          <h2 id={`${ids}-res`}>Relink results</h2>
          <p>
            {files(result.relinked)} relinked; {result.stillMissing.toLocaleString("en-US")} still missing.
          </p>
          {result.relinkedPaths.length ? (
            <ul className="ao-list">
              {result.relinkedPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {result.skipped.length ? (
            <>
              <h3>Not relinked</h3>
              <ul className="ao-list">
                {result.skipped.map((s) => (
                  <li key={s.path}>
                    <code>{s.path}</code>: {SKIP_REASON[s.reason] ?? s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.placeholderCandidates.length ? (
            <>
              <h3>Online-only files in that folder (not downloaded)</h3>
              <ul className="ao-list">
                {result.placeholderCandidates.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.warnings.map((w) => (
            <p key={w} className="ao-warning">
              {w}
            </p>
          ))}
        </section>
      ) : null}
      <RebuildIndex api={api} />
    </main>
  );
}
