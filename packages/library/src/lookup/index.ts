/**
 * Governed metadata lookups (spec 5.1, 5.4 step 3.6; R14, R50). Each provider is asked only after
 * `evaluate({action:'process', process:{op:'metadata_lookup', provider}})` allows it for the
 * project; a denied provider is skipped silently (a debug note) and the next one is tried.
 *
 *  - lookupDoi: Crossref, then OpenAlex.
 *  - lookupIsbn: Open Library, then the Library of Congress (SRU; plain HTTP, so never for a
 *    sensitive / encrypted-project lookup).
 *  - searchTitle: OpenAlex search.
 *
 * Returns null (or []) when no permitted provider knows the item or every provider is denied.
 * Throws LookupHttpError only when every permitted provider failed to answer.
 * Decision 31 (b), R556 (2): with `ctx.askedToWait: "leave-out"`, a provider that asks to wait is left out (no wait) and
 * the next one is asked; when none gave the item and at least one was left out, LookupLeftOutError names those left out.
 */
import { toIsbn13 } from "@ao/core";
import { isSensitive, providerAllowed, type LookupContext, type LookupResult, type Provider } from "./context.js";
import { crossrefWork } from "./crossref.js";
import { LookupHttpError, LookupLeftOutError } from "./http.js";
import { LOC_SRU_BASE, locIsbn } from "./loc.js";
import { openAlexSearch, openAlexWork } from "./openalex.js";
import { openLibraryIsbn } from "./openlibrary.js";

export { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_RATE_LIMITS, HttpClient, LookupCancelledError, LookupHttpError, LookupLeftOutError, USER_AGENT } from "./http.js";
export type { GetOptions, HttpClientOptions } from "./http.js";
export { isSensitive, lookupContextFor, providerAllowed } from "./context.js";
export type { LookupContext, LookupResult, Provider } from "./context.js";
export { LOC_SRU_BASE } from "./loc.js";

/**
 * Decision 31 (c), "Look up again" (R566 5): a per-call option of `lookupDoi`, `lookupIsbn` and `searchTitle` — only these
 * providers are asked (the others of the chain are passed over, as a denied one is). Absent: the whole chain, as before.
 * It is an argument of the one call, never kept anywhere: no other caller's lookups can see it.
 */
export interface LookupOnly {
  only?: readonly string[];
}

/** Decision 31 (c): the host each provider's lookups go to (where the client keeps a service's hold, R411). */
export const PROVIDER_HOSTS: Readonly<Record<Provider, string>> = {
  crossref: "api.crossref.org",
  openalex: "api.openalex.org",
  openlibrary: "openlibrary.org",
  loc: new URL(LOC_SRU_BASE).hostname,
  elicit: "elicit.com",
};

async function firstAnswer(
  ctx: LookupContext,
  chain: Array<[Provider, () => Promise<LookupResult | null>]>,
  opts: LookupOnly = {},
): Promise<LookupResult | null> {
  let failed: LookupHttpError | undefined;
  let answered = false;
  const leftOut: LookupLeftOutError[] = [];
  /** Decision 31 (c), R577 iv: the providers that failed outright, named on the error that says so (not enumerable). */
  const failedProviders: string[] = [];
  for (const [provider, ask] of chain) {
    if (opts.only && !opts.only.includes(provider)) continue;
    if (provider === "loc" && isSensitive(ctx)) {
      ctx.debug?.("metadata lookup via loc skipped: its endpoint is plain HTTP, never used for encrypted (sensitive) projects");
      continue;
    }
    if (!providerAllowed(ctx, provider)) continue;
    try {
      const r = await ask();
      answered = true;
      if (r) return r;
    } catch (e) {
      if (e instanceof LookupLeftOutError) {
        ctx.debug?.(`metadata lookup via ${provider} left out: the service asked to wait`);
        leftOut.push(new LookupLeftOutError(e.host, e.notBefore, [provider]));
        continue;
      }
      if (!(e instanceof LookupHttpError)) throw e;
      ctx.debug?.(`metadata lookup via ${provider} failed: ${e.message}`);
      failed = e;
      failedProviders.push(provider);
    }
  }
  if (leftOut.length) throw withFailed(mergeLeftOut(leftOut), answered ? [] : failedProviders);
  if (failed && !answered) throw withFailed(failed, failedProviders);
  return null;
}

/**
 * Decision 31 (c), R577 iv: names on `e` the providers that failed outright (`failedServices`, not enumerable: it stays out
 * of serialised errors, as `retryAfter` does). On a LookupLeftOutError: those that failed beside the ones left out, when
 * none answered.
 */
function withFailed<E extends Error>(e: E, providers: string[]): E {
  if (providers.length) Object.defineProperty(e, "failedServices", { value: Object.freeze([...providers]), enumerable: false });
  return e;
}

/** The providers a lookup error says failed outright (see `withFailed`); [] when it names none. */
export function failedServicesOf(e: unknown): readonly string[] {
  const v = (e as { failedServices?: unknown } | null)?.failedServices;
  return Array.isArray(v) ? (v as string[]) : [];
}

/** One LookupLeftOutError for several providers left out: every one named, the latest "not before". */
function mergeLeftOut(list: LookupLeftOutError[]): LookupLeftOutError {
  const latest = list.reduce((a, b) => (b.notBefore > a.notBefore ? b : a));
  return new LookupLeftOutError(latest.host, latest.notBefore, list.flatMap((e) => e.services));
}

/** Canonical DOI: lowercase, without a doi.org URL or `doi:` prefix. */
function canonDoi(raw: string): string | null {
  const d = raw.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/u.test(d) ? d : null;
}

export async function lookupDoi(doi: string, ctx: LookupContext, opts: LookupOnly = {}): Promise<LookupResult | null> {
  const d = canonDoi(doi);
  if (!d) return null;
  return firstAnswer(
    ctx,
    [
      ["crossref", () => crossrefWork(d, ctx)],
      ["openalex", () => openAlexWork(d, ctx)],
    ],
    opts,
  );
}

export async function lookupIsbn(isbn: string, ctx: LookupContext, opts: LookupOnly = {}): Promise<LookupResult | null> {
  const i = toIsbn13(isbn);
  if (!i) return null;
  return firstAnswer(
    ctx,
    [
      ["openlibrary", () => openLibraryIsbn(i, ctx)],
      ["loc", () => locIsbn(i, ctx)],
    ],
    opts,
  );
}

/** Candidate matches for a title (and optionally a creator name) from OpenAlex. */
export async function searchTitle(title: string, creator: string | undefined, ctx: LookupContext, opts: LookupOnly = {}): Promise<LookupResult[]> {
  if (opts.only && !opts.only.includes("openalex")) return [];
  if (!providerAllowed(ctx, "openalex")) return [];
  try {
    return await openAlexSearch(title, creator, ctx);
  } catch (e) {
    if (e instanceof LookupLeftOutError) throw new LookupLeftOutError(e.host, e.notBefore, ["openalex"]);
    if (e instanceof LookupHttpError) throw withFailed(e, ["openalex"]);
    throw e;
  }
}
