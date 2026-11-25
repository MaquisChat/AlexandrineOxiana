/**
 * FR-750 (R579): the first reads of a screen opened by its address have a time limit. A read the browser never settles
 * (neither answered nor failed) would otherwise leave the screen at "Reading…" for ever. These are reads from the
 * service on the same machine, so twenty seconds is long; acts (an add, an attach, a move) have no such limit.
 */
import { ApiClientError, noAnswerInTime, SERVICE_NO_ANSWER, SERVICE_UNREACHABLE } from "./client";

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

/**
 * FR-756: like `readWithin`, but the limit is on the ANSWER BEGINNING, not on the whole read: `read` is given a signal
 * and `answered`, which it calls once the service's answer has begun (its headers arrived). From then on the limit no
 * longer applies, however long the body takes to arrive (a large file on a slow drive is never cut while it arrives).
 * An answer not begun after `ms` is given up as `readWithin` gives a read up ("did not answer in time").
 */
export function answerWithin<T>(read: (signal: AbortSignal, answered: () => void) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
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
  // The caller's abort still cancels the read after its answer began; only the limit stops at the beginning.
  return Promise.race([read(ac.signal, () => clearTimeout(timer)), limit]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  });
}

/** A read that got no answer (the service could not be reached, or it did not answer in time): "Try again" may help. */
export const isUnreachable = (err: unknown): boolean => err instanceof ApiClientError && err.status === 0 && err.code === "UNAVAILABLE";

/** FR-756: a read given up at its time limit (it neither answered nor failed), as `readWithin` gives it up. */
export const isNoAnswerInTime = (err: unknown): boolean => isUnreachable(err) && (err as ApiClientError).message === SERVICE_NO_ANSWER;

/**
 * R602 M1: one sentence per screen at a time. Of the sentences of a screen's unanswered first reads, "The library
 * service could not be reached." alone where any read failed with no answer; "The library service did not answer in
 * time." only where every one was given up at the limit. None: undefined.
 */
export function oneNoAnswerSentence(sentences: Iterable<string | undefined>): string | undefined {
  const all = [...sentences].filter((x): x is string => x !== undefined);
  if (all.includes(SERVICE_UNREACHABLE)) return SERVICE_UNREACHABLE;
  return all.includes(SERVICE_NO_ANSWER) ? SERVICE_NO_ANSWER : all[0];
}

/**
 * FR-756, R605 M6: several requests that make ONE limited read (inside one `readWithin`): the first to fail cancels the
 * others at once, rather than leaving them out until they settle or the limit passes. `signal` (the read's own) still
 * cancels them all.
 */
export function allOrCancel<const T extends readonly unknown[]>(signal: AbortSignal, reads: { [K in keyof T]: (signal: AbortSignal) => Promise<T[K]> }): Promise<T> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", stop, { once: true });
  const all = (reads as readonly ((s: AbortSignal) => Promise<unknown>)[]).map((read) =>
    read(ac.signal).catch((err: unknown) => {
      ac.abort();
      throw err;
    }),
  );
  return Promise.all(all).finally(() => signal.removeEventListener("abort", stop)) as Promise<unknown> as Promise<T>;
}
