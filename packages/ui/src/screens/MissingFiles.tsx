/**
 * Missing-files report (spec 4.5): files the library expects but cannot find, from the integrity
 * check. "Search a folder…" looks there for each one by hash and name and relinks what it finds.
 * On Windows, looking into a cloud-synced folder (OneDrive, Dropbox, …) can make files that are
 * kept online only download, so the search warns before it starts (Task 14 deferred minor).
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { GovernanceApi, IntegrityAnswer, RelinkResult } from "../api/governance";
import "./GovernanceScreens.css";

const SKIP_REASON: Record<string, string> = {
  "project-locked": "its project is locked; unlock it, then search again",
  placeholder: "only online-only copies were found; make them available offline, then search again",
  "outside-library": "the matching file is outside the library",
  "not-linkable": "the matching file is in a place a link may not point to",
  "verify-failed": "a file with the same name was found but its content is different",
  "target-exists": "a different file already sits where it belongs",
};

const files = (n: number) => (n === 1 ? "1 file" : `${n.toLocaleString("en-US")} files`);

export function MissingFiles({ api }: { api: GovernanceApi }) {
  const ids = useId();
  const [integrity, setIntegrity] = useState<IntegrityAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelinkResult | null>(null);

  const load = useCallback(async () => {
    try {
      setIntegrity(await api.integrity());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The library could not be checked.");
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

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
      {!integrity ? (
        !error ? <p role="status">Checking the library…</p> : null
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
          <p className="ao-warning">
            On Windows, searching a folder kept in OneDrive or another cloud-storage service can make it download files that are stored online only. Choose the folder that holds the missing files, not a whole drive.
          </p>
          <div className="ao-field">
            <label htmlFor={`${ids}-dir`}>Folder to search</label>
            <input id={`${ids}-dir`} type="text" value={folder} onChange={(e) => setFolder(e.target.value)} />
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
    </main>
  );
}
