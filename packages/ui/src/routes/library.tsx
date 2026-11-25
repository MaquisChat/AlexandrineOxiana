/**
 * The library screens (R113): the open library, or the chooser when none is open, or "Library not
 * found" for a library that is not where it was. App.tsx's route table (R118) shows this on "/" and
 * "/library"; links use the shared navigate() (navigation.tsx). The selected project is kept in the
 * address (`?project=<id>`, replacing the history entry), so every way back into the library (Back to
 * library, the browser's Back, a link) returns to that project (41b2 I1). The first-use tools
 * question is placed on the open library's screen only, never over the chooser (Task 48c, D9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SERVICE_NO_ANSWER, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, readWithin } from "../api/firstRead";
import { libraryApi, type CurrentLibrary, type LibraryEntry, type LibraryList } from "../api/library";
import { toolsApi } from "../api/tools";
import { FirstUseTools } from "../components/FirstUseTools";
import { UserText } from "../components/UserText";
import { navigate, normalisePath, PATHS, projectInQuery, type AppLocation } from "../navigation";
import { Library } from "../screens/Library";
import { LibraryChooser } from "../screens/LibraryChooser";
import { LibraryNotFound } from "../screens/LibraryNotFound";

export const LIBRARY_PATHS = [PATHS.library, PATHS.libraryAlias] as const;

/**
 * When the screen checks again while the last library is still being opened (I1): after 2, 4 and 8
 * seconds, then every 15 seconds until it opens or the researcher chooses (Ruling R469 a, FR-368).
 */
const REOPEN_CHECK_MS = [2_000, 4_000, 8_000, 15_000] as const;
export const isLibraryPath = (path: string): boolean => (LIBRARY_PATHS as readonly string[]).includes(normalisePath(path));

type View =
  | { kind: "loading" }
  /** FR-756 A: the first look at the libraries was given up at its time limit; whether a library is open is not known. */
  | { kind: "no-answer" }
  /** `reopening`: the library open last time is still being opened by the service (I1); the chooser stays usable. */
  | { kind: "chooser"; reopening?: { libraryId: string; name: string } }
  | { kind: "not-found"; library: LibraryEntry } | { kind: "library"; current: CurrentLibrary; path?: string | undefined };

/**
 * `firstReadMs` (FR-756 A): how long each look at the libraries (the first, and each check while the last library is
 * still being opened) is waited for before it is given up (FIRST_READ_TIMEOUT_MS; smaller in tests).
 */
export function LibraryRoutes({ client, loc, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; loc?: AppLocation; firstReadMs?: number }) {
  return <LibraryFlow client={client} loc={loc ?? { pathname: window.location.pathname, search: window.location.search }} firstReadMs={firstReadMs} />;
}

/** The address with this project in its query, on the same library path. */
const withProject = (loc: AppLocation, projectId?: string) => {
  const q = new URLSearchParams(loc.search);
  if (projectId) q.set("project", projectId);
  else q.delete("project");
  const s = q.toString();
  return `${normalisePath(loc.pathname)}${s ? `?${s}` : ""}`;
};

function LibraryFlow({ client, loc, firstReadMs }: { client: ApiClient; loc: AppLocation; firstReadMs: number }) {
  const api = useMemo(() => libraryApi(client), [client]);
  const tools = useMemo(() => toolsApi(client), [client]);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [known, setKnown] = useState<LibraryEntry[]>([]);

  /** The view an answer of GET /libraries calls for. */
  const viewOf = useCallback((r: LibraryList): View => {
    // The library open when the app last ran: reopened by the service, still being opened, or not found there (D5, I1).
    const missing = r.notFound ? r.libraries.find((l) => l.libraryId === r.notFound?.libraryId) : undefined;
    return r.current
      ? { kind: "library", current: r.current, path: r.libraries.find((l) => l.libraryId === r.current?.libraryId)?.lastKnownPaths[0] }
      : r.reopening
        ? { kind: "chooser", reopening: r.reopening }
        : missing
          ? { kind: "not-found", library: missing }
          : { kind: "chooser" };
  }, []);

  // The first look. FR-756 A: one that FAILED shows the chooser, which reads the list itself and says why (as before);
  // one given up at the time limit (it neither answered nor failed) says so, with "Try again" (`looks` counts them).
  const [looks, setLooks] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    readWithin((signal) => api.libraries.list({ signal }), firstReadMs, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setKnown(r.libraries);
        setView(viewOf(r));
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setView(isNoAnswerInTime(err) ? { kind: "no-answer" } : { kind: "chooser" });
      });
    return () => ac.abort();
  }, [api, viewOf, firstReadMs, looks]);
  /** "Try again" was pressed: focus follows the screen (the loading words, then what replaces them), never the page. */
  const retried = useRef(false);
  const loadingRef = useRef<HTMLParagraphElement>(null);
  const tryAgainRef = useRef<HTMLButtonElement>(null);
  const tryAgain = () => {
    retried.current = true;
    setView({ kind: "loading" });
    setLooks((n) => n + 1);
  };
  useEffect(() => {
    if (!retried.current) return;
    if (view.kind === "loading") return loadingRef.current?.focus();
    if (view.kind === "no-answer") return tryAgainRef.current?.focus();
    retried.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) document.querySelector<HTMLElement>("main h1[tabindex], main[tabindex]")?.focus();
  }, [view.kind]);

  // While the last library is still being opened, check again, less and less often (I1, R469 a). An
  // answer that comes after the researcher chose something else (the view changed, or the screen went
  // away) is dropped. `checks` counts the checks made for this library, so each wait is the next one.
  const reopeningId = view.kind === "chooser" ? view.reopening?.libraryId : undefined;
  const checks = useRef<{ libraryId?: string; made: number }>({ made: 0 });
  useEffect(() => {
    if (!reopeningId) {
      checks.current = { made: 0 };
      return;
    }
    if (checks.current.libraryId !== reopeningId) checks.current = { libraryId: reopeningId, made: 0 };
    const delay = REOPEN_CHECK_MS[Math.min(checks.current.made, REOPEN_CHECK_MS.length - 1)];
    let live = true;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      checks.current.made++;
      // FR-756 A: each check has the time limit too, so one that never settles does not stop the checking.
      readWithin((signal) => api.libraries.list({ signal }), firstReadMs, ac.signal)
        .then((r) => {
          if (!live) return;
          setKnown(r.libraries);
          setView((v) => (v.kind === "chooser" && v.reopening?.libraryId === reopeningId ? viewOf(r) : v));
        })
        // Not answered (or not in time): keep checking (a new view object re-arms this effect).
        .catch(() => live && setView((v) => (v.kind === "chooser" && v.reopening ? { ...v } : v)));
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
      ac.abort();
    };
  }, [api, viewOf, reopeningId, view, firstReadMs]);

  const opened = (current: CurrentLibrary) => setView({ kind: "library", current, path: known.find((l) => l.libraryId === current.libraryId)?.lastKnownPaths[0] });
  const chooser = () => {
    // A project of the library that was open means nothing to the next one.
    if (isLibraryPath(window.location.pathname) && projectInQuery(window.location.search)) navigate(withProject({ pathname: window.location.pathname, search: window.location.search }), { replace: true });
    setView({ kind: "chooser" });
  };

  switch (view.kind) {
    case "loading":
      return (
        <p className="ao-page" aria-live="polite" ref={loadingRef} tabIndex={-1}>
          Connecting to the library…
        </p>
      );
    case "no-answer":
      return (
        <main className="ao-page">
          <p role="alert" className="ao-error">
            {SERVICE_NO_ANSWER}
          </p>
          <p>
            <button type="button" ref={tryAgainRef} onClick={tryAgain}>
              Try again
            </button>
          </p>
        </main>
      );
    case "chooser":
      return (
        <>
          {view.reopening && (
            <p className="ao-page" role="status">
              Still opening <UserText>{view.reopening.name}</UserText>, the library that was open last time. Its folder is taking a while to answer (a network or external drive can be slow);
              it opens here as soon as it is ready. You can choose another library meanwhile.
            </p>
          )}
          <LibraryChooser api={api} onOpened={opened} onNotFound={(library) => setView({ kind: "not-found", library })} />
        </>
      );
    case "not-found":
      return <LibraryNotFound api={api} library={view.library} onOpened={opened} onOpenDifferent={chooser} />;
    case "library":
      return (
        <Library
          key={view.current.libraryId}
          api={api}
          current={view.current}
          firstReadMs={firstReadMs}
          {...(view.path ? { libraryPath: view.path } : {})}
          navigate={navigate}
          firstUse={(hidden) => <FirstUseTools api={tools} hidden={hidden} />}
          projectFromAddress={projectInQuery(loc.search)}
          onProjectSelected={(id) => {
            // Only while the library is the screen shown: never rewrite another screen's address.
            if (isLibraryPath(window.location.pathname) && projectInQuery(window.location.search) !== id) navigate(withProject({ pathname: window.location.pathname, search: window.location.search }, id), { replace: true });
          }}
          onClosed={chooser}
          onSwitchLibrary={() => {
            void api.libraries.close().catch(() => {});
            chooser();
          }}
        />
      );
  }
}
