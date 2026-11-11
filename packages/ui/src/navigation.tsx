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

/** Moves to an in-app path ("/…", query allowed) without reloading; listeners of popstate re-render. */
export function navigate(href: string): void {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error(`navigate() takes an in-app path starting with "/" (got "${href}").`);
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

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

/** The link every screen other than the library shows at its top. */
export function BackToLibrary() {
  return (
    <nav aria-label="Library" className="ao-back">
      <a href={PATHS.library} onClick={inAppLink}>
        Back to library
      </a>
    </nav>
  );
}

/** Files dropped anywhere but a drop zone must not make the webview open them (and leave the app). */
export function useDropGuard(): void {
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
}
