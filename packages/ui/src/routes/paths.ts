/** Where the Bulk Import screens live (R113): the wizard and its review queue. */
export const IMPORT_PATHS = { wizard: "/import", review: "/import/review" } as const;

/**
 * Moves to an in-app path without reloading the page (a reload would lose the service connection,
 * which the app takes from the window once at start-up). Listeners of `popstate` re-render.
 */
export function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Click handler for an in-app link: plain clicks navigate in place; modified clicks are left alone. */
export function inAppLink(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void; currentTarget: { getAttribute(n: string): string | null } }): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  navigate(href);
}
