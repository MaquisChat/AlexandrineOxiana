/** R586 M4: what `gotoWhenQuiet` (fixtures.ts) says when the page before never finished its requests to the service. */

/** How long `gotoWhenQuiet` waits for the page before to finish its requests. */
export const QUIET_WAIT_MS = 30_000;

/** How long the page before must stay without a request out before it counts as quiet (R614). */
export const QUIET_SETTLE_MS = 150;

/** Each request still out by its method and path only: a query can hold what a researcher typed. */
export function stillOutMessage(requests: ReadonlyArray<{ method: string; url: string }>): string {
  const named = requests.map((r) => `${r.method} ${new URL(r.url).pathname}`).join("; ");
  return `The page before still had requests to the service out after ${QUIET_WAIT_MS / 1000} seconds: ${named}.`;
}
