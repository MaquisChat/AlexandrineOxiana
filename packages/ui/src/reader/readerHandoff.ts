/**
 * The hand-over of a library search's words to the reader (Task R12; Rulings R192 f, R195).
 *
 * A search hit "Found in an annotation" offers "Show in the reader". The words searched for go to
 * the reader through this module and nowhere else: in memory, never in the address (path, query or
 * fragment), never in history state, never in `localStorage` or `sessionStorage`, never in a log.
 * They are taken ONCE (`takePendingFind` clears them), are gone after 60 seconds (FIND_TTL_MS), and
 * are dropped at once by `clearPendingFind`, which the screens call when the project is locked or
 * the library closed or switched. While they wait, `guardPendingFind` watches the service's state
 * (the stream every screen uses: its first event is the state as it is, a later one is a change:
 * a lock, a close, a switch, a mode change) and drops them at the first change, and when the watch
 * is lost (it fails closed: words are never kept unwatched). A search in an encrypted project
 * therefore leaves nothing behind.
 */

/** How long handed-over words wait for the reader. */
export const FIND_TTL_MS = 60_000;

interface Pending {
  projectId: string;
  sourceId: string;
  words: string;
  timer: ReturnType<typeof setTimeout>;
}

let pending: Pending | undefined;
let watch: AbortController | undefined;

function stopWatching(): void {
  watch?.abort();
  watch = undefined;
}

/** Drops the words, if any: a lock, a close, a switch, the end of the reader. */
export function clearPendingFind(): void {
  if (pending) clearTimeout(pending.timer);
  pending = undefined;
  stopWatching();
}

/** Whether words wait (for tests and for screens that must not hold a second copy). */
export function hasPendingFind(): boolean {
  return pending !== undefined;
}

/** Hands the words of a search over for the reader of this source; replaces any words still waiting. */
export function setPendingFind(projectId: string, sourceId: string, words: string): void {
  clearPendingFind();
  const timer = setTimeout(clearPendingFind, FIND_TTL_MS);
  pending = { projectId, sourceId, words, timer };
}

/**
 * The words handed over for this source, once: they are cleared by being taken. Words waiting for
 * another source or project are dropped too (a reader that opens is not the one they were for).
 */
export function takePendingFind(projectId: string, sourceId: string): string | undefined {
  const p = pending;
  clearPendingFind();
  return p && p.projectId === projectId && p.sourceId === sourceId ? p.words : undefined;
}

/**
 * Watches the service's events for as long as words wait; `events` is the client's stream. Any
 * `library.state` after the first, and the loss of the stream, drop the words. Does nothing when no
 * words wait.
 */
export function guardPendingFind(events: (opts: { signal?: AbortSignal }) => AsyncIterable<{ type: string }>): void {
  if (!pending) return;
  stopWatching();
  const mine = pending;
  const ac = new AbortController();
  watch = ac;
  void (async () => {
    let first = true;
    try {
      for await (const e of events({ signal: ac.signal })) {
        if (ac.signal.aborted) return;
        if (e.type !== "library.state") continue;
        if (first) {
          first = false;
          continue;
        }
        break;
      }
    } catch {
      // A lost watch: the words are not kept unwatched.
    }
    if (!ac.signal.aborted && pending === mine) clearPendingFind();
  })();
}
