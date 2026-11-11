/**
 * The library screens (R113): the open library, or the chooser when none is open, or "Library not
 * found" for a library that is not where it was. App.tsx's route table (R118) shows this on "/" and
 * "/library"; links use the shared navigate() (navigation.tsx). The selected project is kept in the
 * address (`?project=<id>`, replacing the history entry), so every way back into the library (Back to
 * library, the browser's Back, a link) returns to that project (41b2 I1).
 */
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import { libraryApi, type CurrentLibrary, type LibraryEntry } from "../api/library";
import { navigate, normalisePath, PATHS, projectInQuery, type AppLocation } from "../navigation";
import { Library } from "../screens/Library";
import { LibraryChooser } from "../screens/LibraryChooser";
import { LibraryNotFound } from "../screens/LibraryNotFound";

export const LIBRARY_PATHS = [PATHS.library, PATHS.libraryAlias] as const;
export const isLibraryPath = (path: string): boolean => (LIBRARY_PATHS as readonly string[]).includes(normalisePath(path));

type View = { kind: "loading" } | { kind: "chooser" } | { kind: "not-found"; library: LibraryEntry } | { kind: "library"; current: CurrentLibrary; path?: string | undefined };

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
  const [view, setView] = useState<View>({ kind: "loading" });
  const [known, setKnown] = useState<LibraryEntry[]>([]);

  useEffect(() => {
    let live = true;
    api.libraries
      .list()
      .then((r) => {
        if (!live) return;
        setKnown(r.libraries);
        setView(r.current ? { kind: "library", current: r.current, path: r.libraries.find((l) => l.libraryId === r.current?.libraryId)?.lastKnownPaths[0] } : { kind: "chooser" });
      })
      .catch(() => live && setView({ kind: "chooser" }));
    return () => {
      live = false;
    };
  }, [api]);

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
      return <LibraryChooser api={api} onOpened={opened} onNotFound={(library) => setView({ kind: "not-found", library })} />;
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
