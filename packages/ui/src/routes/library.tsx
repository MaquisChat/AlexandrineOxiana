/**
 * The library screens (R113): the open library, or the chooser when none is open, or "Library not
 * found" for a library that is not where it was. App.tsx's route table (R118) shows this on "/" and
 * "/library"; links use the shared navigate() (navigation.tsx). The selected project is kept in the
 * address (`?project=<id>`, replacing the history entry), so every way back into the library (Back to
 * library, the browser's Back, a link) returns to that project (41b2 I1). The first-use tools
 * question is placed on the open library's screen only, never over the chooser (Task 48c, D9).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import { libraryApi, type CurrentLibrary, type LibraryEntry, type LibraryList } from "../api/library";
import { toolsApi } from "../api/tools";
import { FirstUseTools } from "../components/FirstUseTools";
import { UserText } from "../components/UserText";
import { navigate, normalisePath, PATHS, projectInQuery, type AppLocation } from "../navigation";
import { Library } from "../screens/Library";
import { LibraryChooser } from "../screens/LibraryChooser";
import { LibraryNotFound } from "../screens/LibraryNotFound";

export const LIBRARY_PATHS = [PATHS.library, PATHS.libraryAlias] as const;

/** How often the screen checks again while the last library is still being opened (I1). */
const REOPEN_CHECK_MS = 2_000;
export const isLibraryPath = (path: string): boolean => (LIBRARY_PATHS as readonly string[]).includes(normalisePath(path));

type View =
  | { kind: "loading" }
  /** `reopening`: the library open last time is still being opened by the service (I1); the chooser stays usable. */
  | { kind: "chooser"; reopening?: { libraryId: string; name: string } }
  | { kind: "not-found"; library: LibraryEntry } | { kind: "library"; current: CurrentLibrary; path?: string | undefined };

export function LibraryRoutes({ client, loc }: { client: ApiClient; loc?: AppLocation }) {
  return <LibraryFlow client={client} loc={loc ?? { pathname: window.location.pathname, search: window.location.search }} />;
}

/** The address with this project in its query, on the same library path. */
const withProject = (loc: AppLocation, projectId?: string) => {
  const q = new URLSearchParams(loc.search);
  if (projectId) q.set("project", projectId);
  else q.delete("project");
  const s = q.toString();
  return `${normalisePath(loc.pathname)}${s ? `?${s}` : ""}`;
};

function LibraryFlow({ client, loc }: { client: ApiClient; loc: AppLocation }) {
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

  useEffect(() => {
    let live = true;
    api.libraries
      .list()
      .then((r) => {
        if (!live) return;
        setKnown(r.libraries);
        setView(viewOf(r));
      })
      .catch(() => live && setView({ kind: "chooser" }));
    return () => {
      live = false;
    };
  }, [api, viewOf]);

  // While the last library is still being opened, check again every 2 s (I1). An answer that comes
  // after the researcher chose something else (the view changed, or the screen went away) is dropped.
  const reopeningId = view.kind === "chooser" ? view.reopening?.libraryId : undefined;
  useEffect(() => {
    if (!reopeningId) return;
    let live = true;
    const timer = setTimeout(() => {
      api.libraries
        .list()
        .then((r) => {
          if (!live) return;
          setKnown(r.libraries);
          setView((v) => (v.kind === "chooser" && v.reopening?.libraryId === reopeningId ? viewOf(r) : v));
        })
        // Not answered: keep checking (a new view object re-arms this effect).
        .catch(() => live && setView((v) => (v.kind === "chooser" && v.reopening ? { ...v } : v)));
    }, REOPEN_CHECK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, viewOf, reopeningId, view]);

  const opened = (current: CurrentLibrary) => setView({ kind: "library", current, path: known.find((l) => l.libraryId === current.libraryId)?.lastKnownPaths[0] });
  const chooser = () => {
    // A project of the library that was open means nothing to the next one.
    if (isLibraryPath(window.location.pathname) && projectInQuery(window.location.search)) navigate(withProject({ pathname: window.location.pathname, search: window.location.search }), { replace: true });
    setView({ kind: "chooser" });
  };

  switch (view.kind) {
    case "loading":
      return (
        <p className="ao-page" aria-live="polite">
          Connecting to the library…
        </p>
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
