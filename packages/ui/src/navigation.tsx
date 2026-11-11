/**
 * In-app navigation (R118): the one place the app moves between screens. The app is a single page
 * that uses history.pushState (never hash routing, never a reload — a reload would lose the
 * service connection, which the app takes from the window once at start-up). `navigate()` pushes
 * the path and fires popstate, so every useLocation() listener re-renders. App.tsx owns the route
 * table; screens only link to the paths below.
 */
import { useEffect, useState, type MouseEvent } from "react";
import "./navigation.css";

/** Every in-app path the route table in App.tsx knows. */
export const PATHS = {
  library: "/",
  libraryAlias: "/library",
  appearance: "/settings/appearance",
  importWizard: "/import",
  reviewQueue: "/import/review",
  governance: "/governance",
  audit: "/audit",
  fieldwork: "/fieldwork",
  moveLibrary: "/move-library",
  missingFiles: "/missing-files",
} as const;

/** Where the Bulk Import screens live (R113): the wizard and its review queue. */
export const IMPORT_PATHS = { wizard: PATHS.importWizard, review: PATHS.reviewQueue } as const;

export interface AppLocation {
  pathname: string;
  search: string;
}

/** "/library/" → "/library"; "/" stays "/". */
export const normalisePath = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p || "/");

/** While set, navigate() moves nowhere and calls it instead (see blockNavigation). */
let navigationBlock: (() => void) | null = null;

/**
 * Refuses in-app navigation (links and navigate()) until the returned function is called; each
 * refused attempt calls `onRefused` (to say why). Used while something shown once must not be lost,
 * such as a new project's recovery code (R134). The browser's Back and Forward are guarded by the
 * caller (they do not go through navigate()).
 */
export function blockNavigation(onRefused: () => void): () => void {
  navigationBlock = onRefused;
  return () => {
    if (navigationBlock === onRefused) navigationBlock = null;
  };
}

/**
 * Moves to an in-app path ("/…", query allowed) without reloading; listeners of popstate re-render.
 * `replace` rewrites the current history entry instead of adding one (for example to keep the
 * selected project in the library's address).
 */
export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error(`navigate() takes an in-app path starting with "/" (got "${href}").`);
  if (navigationBlock) {
    navigationBlock();
    return;
  }
  if (opts.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The project named in an address's query (`?project=<id>`), or undefined. */
export const projectInQuery = (search: string): string | undefined => new URLSearchParams(search).get("project") || undefined;

/** The library's address, naming a project when there is one (41b2 I1). */
export const libraryHref = (projectId?: string): string => (projectId ? `${PATHS.library}?project=${encodeURIComponent(projectId)}` : PATHS.library);

type LinkClick = Pick<MouseEvent<HTMLElement>, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault"> & {
  currentTarget: { getAttribute(n: string): string | null };
};

/** Click handler for an in-app link: plain clicks navigate in place; modified clicks are left alone. */
export function inAppLink(e: LinkClick): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  e.preventDefault();
  navigate(href);
}

const here = (): AppLocation => (typeof window === "undefined" ? { pathname: "/", search: "" } : { pathname: window.location.pathname, search: window.location.search });

/** The window's current location, following in-app navigation and the browser's back/forward. */
export function useLocation(): AppLocation {
  const [loc, setLoc] = useState<AppLocation>(here);
  useEffect(() => {
    const on = () => setLoc(here());
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return loc;
}

export const usePathname = (): string => useLocation().pathname;

/** The link every screen other than the library shows at its top; it keeps the screen's project. */
export function BackToLibrary({ projectId }: { projectId?: string | undefined } = {}) {
  return (
    <nav aria-label="Library" className="ao-back">
      <a href={libraryHref(projectId)} onClick={inAppLink}>
        Back to library
      </a>
    </nav>
  );
}

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);

/** Whether a drag may carry files or links the webview would open (unknown counts as yes). */
const carriesFiles = (e: DragEvent): boolean => {
  const types = e.dataTransfer?.types;
  if (!types) return true;
  return Array.from(types).some((t) => t === "Files" || t === "text/uri-list");
};

/**
 * Files dropped anywhere but a drop zone must not make the webview open them (and leave the app).
 * Text dragged into a field is left alone, so it still drops there (41b1 M9).
 */
export function useDropGuard(): void {
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (editable(e.target) && !carriesFiles(e)) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
}
