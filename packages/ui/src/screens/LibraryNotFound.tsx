/**
 * "Library not found" (spec 4.5): the library is not at its last known place. Locate it (a typed
 * folder), search for it (folders found stream in as the service finds them), wait for its drive to
 * come back (the last known place is tried again every few seconds), or open a different library.
 * Reconnecting checks the library id, format and integrity in the service.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { errorText } from "../api/library";
import type { CurrentLibrary, FoundLibrary, LibraryApi, LibraryEntry } from "../api/library";
import { volumeOf } from "../components/StatusBanner";
import { UserText } from "../components/UserText";
import { PathField } from "../components/PathField";
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

const message = (err: unknown, fallback: string) => errorText(err, fallback);
/** The drive is simply not back yet: keep waiting. Anything else is shown and ends the wait. */
const notYet = (err: unknown) => err instanceof ApiClientError && (err.code === "NOT_FOUND" || err.code === "LIBRARY_OFFLINE");

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function LibraryNotFound({ api, library, onOpened, onOpenDifferent, waitIntervalMs = 5000 }: LibraryNotFoundProps) {
  const [mode, setMode] = useState<Mode>("none");
  const [path, setPath] = useState("");
  const [found, setFound] = useState<FoundLibrary[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const search = useRef<AbortController | undefined>(undefined);
  const waiting = useRef<AbortController | undefined>(undefined);
  const id = useId();
  const last = library.lastKnownPaths[0];
  const volume = last ? volumeOf(last) : "the library's drive";

  const stopAll = () => {
    search.current?.abort();
    search.current = undefined;
    waiting.current?.abort();
    waiting.current = undefined;
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

  // Tries the last known place (reconnect checks it is this library, by id) until it answers, the
  // wait is stopped (Stop, another choice, unmount) or a real error comes back. Every await is
  // followed by a check of the wait's own AbortController, so nothing opens after it stopped.
  const startWaiting = () => {
    if (!last) return setError("This library has no last known place to wait for. Locate it or search for it instead.");
    const ac = new AbortController();
    waiting.current = ac;
    const loop = async () => {
      while (!ac.signal.aborted) {
        try {
          const r = await api.libraries.reconnect(last, library.libraryId, { signal: ac.signal });
          if (ac.signal.aborted) return;
          waiting.current = undefined;
          onOpened(r);
          return;
        } catch (err) {
          if (ac.signal.aborted) return;
          if (!notYet(err)) {
            waiting.current = undefined;
            setMode("none");
            setError(message(err, "The library could not be reconnected there."));
            return;
          }
        }
        await pause(waitIntervalMs, ac.signal);
      }
    };
    void loop();
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
          <PathField id={`${id}-path`} label="Library folder" pick="folder" pickerTitle="Choose the library's folder" value={path} onChange={setPath} inputProps={{ dir: "auto" }} />
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
