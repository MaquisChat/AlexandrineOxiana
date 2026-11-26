/**
 * The growing waits of a run the platform asked to slow down (or whose connection kept dropping):
 * 1, 2, 4, 15, 30 and 60 minutes, then every 2 hours, the last wait cut so that the waits add up
 * to exactly 12 hours. One more try follows the last wait; if it fails too, the run pauses.
 */

/** The first waits, in order. */
export const RATE_LIMIT_WAITS_MS: readonly number[] = Object.freeze([60_000, 120_000, 240_000, 900_000, 1_800_000, 3_600_000]);
/** The wait repeated after the first ones. */
export const RATE_LIMIT_REPEAT_MS = 7_200_000;
/** The waits never add up to more than this (12 hours). */
export const RATE_LIMIT_GIVE_UP_MS = 43_200_000;

/**
 * The wait before the next try, given how many waits came before it (`attempt`, from 0) and how
 * long they lasted together (`waitedMs`); undefined when the 12 hours are used up (the run pauses).
 */
export function nextWaitMs(attempt: number, waitedMs: number): number | undefined {
  const left = RATE_LIMIT_GIVE_UP_MS - waitedMs;
  if (!(left > 0)) return undefined;
  const base = attempt < RATE_LIMIT_WAITS_MS.length ? RATE_LIMIT_WAITS_MS[Math.max(0, attempt)]! : RATE_LIMIT_REPEAT_MS;
  return Math.min(base, left);
}
