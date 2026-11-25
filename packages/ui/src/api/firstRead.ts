/**
 * FR-750 (R579): the first reads of a screen opened by its address have a time limit. A read the browser never settles
 * (neither answered nor failed) would otherwise leave the screen at "Reading…" for ever. These are reads from the
 * service on the same machine, so twenty seconds is long; acts (an add, an attach, a move) have no such limit.
 */
import { ApiClientError, noAnswerInTime } from "./client";

/** How long a screen's first read is waited for before it is given up. */
export const FIRST_READ_TIMEOUT_MS = 20_000;

/**
 * Runs `read` with a signal of its own. If it has not settled after `ms`, its request is cancelled (so a late answer
 * changes nothing) and the promise rejects with "The library service did not answer in time." (R586 M5). An
 * abort of `outer` cancels it too (it then rejects as the request does).
 */
export function readWithin<T>(read: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (outer?.aborted) ac.abort();
  else outer?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(noAnswerInTime());
    }, ms);
  });
  return Promise.race([read(ac.signal), limit]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  });
}

/** A read that got no answer (the service could not be reached, or it did not answer in time): "Try again" may help. */
export const isUnreachable = (err: unknown): boolean => err instanceof ApiClientError && err.status === 0 && err.code === "UNAVAILABLE";
