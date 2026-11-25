/**
 * Decision 31 (c): the lookup client's holds as the service reads them for "Look up again" — the ONE rule the queue's
 * `lookUp` (routes/review.ts, R600 I1) and the automatic pass (state.ts, R608 n3) both apply.
 */
import { PROVIDER_HOSTS, type HttpClient } from "@ao/library";

/** Per service, until when (ms) the session's lookup client holds it, or undefined (R411). */
export type HeldUntil = (service: string) => number | undefined;

export const heldBy =
  (http: HttpClient): HeldUntil =>
  (service) => {
    const host = (PROVIDER_HOSTS as Record<string, string>)[service];
    return host ? http.heldUntil(host) : undefined;
  };

/** Until when (ms) a lookup waits for the client's holds: the latest of them when EVERY one of its services is held, else undefined. */
export function lookupHeldUntil(l: { services: readonly string[] }, held: HeldUntil): number | undefined {
  const hs = l.services.map(held);
  return hs.length > 0 && hs.every((h) => h !== undefined) ? Math.max(...(hs as number[])) : undefined;
}
