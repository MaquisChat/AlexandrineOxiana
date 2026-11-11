/**
 * "Library not found" (spec 4.5): the library is not at its last known place. Locate it (a typed
 * folder), search for it (folders found stream in as the service finds them), wait for its drive to
 * come back (the last known place is tried again every few seconds), or open a different library.
 * Reconnecting checks the library id, format and integrity in the service.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import type { CurrentLibrary, FoundLibrary, LibraryApi, LibraryEntry } from "../api/library";
import { volumeOf } from "../components/StatusBanner";
import { UserText } from "../components/UserText";
import "../components/library.css";

export interface LibraryNotFoundProps {
  api: Pick<LibraryApi, "libraries">;
  library: LibraryEntry;
  onOpened: (current: CurrentLibrary) => void;
  onOpenDifferent: () => void;
  /** How often "Wait" tries the last known place again (default 5 s). */
  waitIntervalMs?: number;
}

type Mode = "none" | "locate" | "search" | "wait";

const message = (err: unknown, fallback: string) => (err instanceof ApiClientError ? err.message : fallback);

export function LibraryNotFound({ api, library, onOpened, onOpenDifferent, waitIntervalMs = 5000 }: LibraryNotFoundProps) {
  const [mode, setMode] = useState<Mode>("none");
  const [path, setPath] = useState("");
  const [found, setFound] = useState<FoundLibrary[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const search = useRef<AbortController | undefined>(undefined);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const last = library.lastKnownPaths[0];
  const volume = last ? volumeOf(last) : "the library's drive";

  const stopAll = () => {
    search.current?.abort();
    search.current = undefined;
    clearTimeout(waitTimer.current);
    waitTimer.current = undefined;
    setSearching(false);
  };
  useEffect(() => stopAll, []);

  const choose = (m: Mode) => {
    stopAll();
    setError(undefined);
    setMode(m);
    if (m === "search") void runSearch();
    if (m === "wait") startWaiting();
  };

  const reconnect = async (at: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.libraries.reconnect(at, library.libraryId);
      stopAll();
      onOpened(r);
    } catch (err) {
      setError(message(err, "The library could not be reconnected there."));
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    const ac = new AbortController();
    search.current = ac;
    setFound([]);
    setSearching(true);
    try {
      for await (const f of api.libraries.locate(library.libraryId, { signal: ac.signal })) {
        if (ac.signal.aborted) return;
        setFound((list) => (list.some((x) => x.path === f.path) ? list : [...list, f]));
      }
    } catch (err) {
      if (!ac.signal.aborted) setError(message(err, "The search stopped before it finished."));
    } finally {
      if (search.current === ac) setSearching(false);
    }
  };

  const startWaiting = () => {
    if (!last) return setError("This library has no last known place to wait for. Locate it or search for it instead.");
    const tryOnce = async () => {
      try {
        const r = await api.libraries.open(last);
        waitTimer.current = undefined;
        onOpened(r);
        return;
      } catch {
        // still not there: try again
      }
      waitTimer.current = setTimeout(() => void tryOnce(), waitIntervalMs);
    };
    waitTimer.current = setTimeout(() => void tryOnce(), 0);
  };

  const submitLocate = (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p)) return setError("Give the library folder's full path.");
    void reconnect(p);
  };

  return (
    <main className="ao-page">
      <h1>
        Library not found: <UserText>{library.name}</UserText>
      </h1>
      <p>It is not where it was last seen. If it is on a removable drive or a network share, connect it; otherwise find where it went.</p>
      {last && (
        <p className="ao-path">
          Last seen at <UserText>{last}</UserText>
        </p>
      )}
      <div className="ao-row" role="group" aria-label="What to do">
        <button type="button" aria-pressed={mode === "locate"} onClick={() => choose("locate")}>
          Locate library…
        </button>
        <button type="button" aria-pressed={mode === "search"} onClick={() => choose("search")}>
          Search for library
        </button>
        <button type="button" aria-pressed={mode === "wait"} onClick={() => choose("wait")}>
          Wait for the drive
        </button>
        <button
          type="button"
          onClick={() => {
            stopAll();
            onOpenDifferent();
          }}
        >
          Open a different library
        </button>
      </div>

      {mode === "locate" && (
        <form className="ao-inline-form" onSubmit={submitLocate}>
          <label htmlFor={`${id}-path`}>Library folder</label>
          <input id={`${id}-path`} dir="auto" value={path} onChange={(e) => setPath(e.target.value)} />
          <button type="submit" disabled={busy}>
            Reconnect
          </button>
        </form>
      )}

      {mode === "search" && (
        <section aria-label="Search results">
          <p aria-live="polite">{searching ? "Searching drives and cloud folders…" : found.length ? "Search finished." : "Search finished. The library was not found."}</p>
          <ul aria-label="Libraries found" className="ao-plain-list">
            {found.map((f) => (
              <li key={f.path} className="ao-card">
                <p className="ao-path">
                  <UserText>{f.path}</UserText>
                </p>
                {f.moved && <p className="ao-muted">This copy says the library was moved from here.</p>}
                <button type="button" disabled={busy} aria-label={`Use this library at ${f.path}`} onClick={() => void reconnect(f.path)}>
                  Use this library
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode === "wait" && last && (
        <div role="status" className="ao-card">
          <UserText as="p">{`Waiting for ${volume} to come back. The library opens by itself when it does.`}</UserText>
          <button type="button" onClick={() => choose("none")}>
            Stop waiting
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
    </main>
  );
}
