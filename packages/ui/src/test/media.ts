/**
 * A controllable `window.matchMedia` for tests (jsdom has none): `setMedia({ dark: true })` changes
 * what `(prefers-color-scheme: dark)` and `(prefers-reduced-motion: reduce)` report and notifies
 * listeners, as a browser does when the OS setting changes.
 */
type Listener = (e: MediaQueryListEvent) => void;

const state = { dark: false, reducedMotion: false };
const listeners = new Map<string, Set<Listener>>();

function matches(query: string): boolean {
  if (/prefers-color-scheme:\s*dark/.test(query)) return state.dark;
  if (/prefers-color-scheme:\s*light/.test(query)) return !state.dark;
  if (/prefers-reduced-motion:\s*reduce/.test(query)) return state.reducedMotion;
  return false;
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const set = listeners.get(query) ?? new Set<Listener>();
    listeners.set(query, set);
    const mql = {
      media: query,
      get matches() {
        return matches(query);
      },
      onchange: null,
      addEventListener: (_t: string, fn: Listener) => set.add(fn),
      removeEventListener: (_t: string, fn: Listener) => set.delete(fn),
      addListener: (fn: Listener) => set.add(fn),
      removeListener: (fn: Listener) => set.delete(fn),
      dispatchEvent: () => true,
    };
    return mql as unknown as MediaQueryList;
  };
}

export function setMedia(next: Partial<typeof state>): void {
  Object.assign(state, next);
  for (const [query, set] of listeners) for (const fn of [...set]) fn({ matches: matches(query), media: query } as MediaQueryListEvent);
}

export function resetMedia(): void {
  state.dark = false;
  state.reducedMotion = false;
  listeners.clear();
}

/** Number of live listeners (tests: the provider removes its listeners on unmount). */
export function mediaListenerCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}
