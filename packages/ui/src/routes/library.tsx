/**
 * The library screens' routes (R113): "/" and "/library" show the open library, or the chooser
 * when none is open, or "Library not found" for a library that is not where it was. Links to other
 * screens (the review queue at /import/review, appearance settings) use `navigate()`, which keeps
 * the app in one page (history.pushState) and tells listeners through a popstate event.
 */
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import { libraryApi, type CurrentLibrary, type LibraryEntry } from "../api/library";
import { Library } from "../screens/Library";
import { LibraryChooser } from "../screens/LibraryChooser";
import { LibraryNotFound } from "../screens/LibraryNotFound";

export const LIBRARY_PATHS = ["/", "/library"] as const;
export const isLibraryPath = (path: string): boolean => (LIBRARY_PATHS as readonly string[]).includes(path.replace(/\/+$/, "") || "/");

/** In-app navigation: pushes the path and fires popstate so usePathname() listeners update. */
export function navigate(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`navigate() takes an in-app path starting with "/" (got "${path}").`);
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePathname(): string {
  const [path, setPath] = useState(() => (typeof window === "undefined" ? "/" : window.location.pathname));
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

type View = { kind: "loading" } | { kind: "chooser" } | { kind: "not-found"; library: LibraryEntry } | { kind: "library"; current: CurrentLibrary; path?: string | undefined };

export function LibraryRoutes({ client }: { client: ApiClient }) {
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
  const chooser = () => setView({ kind: "chooser" });

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
          onSwitchLibrary={() => {
            void api.libraries.close().catch(() => {});
            chooser();
          }}
        />
      );
  }
}
