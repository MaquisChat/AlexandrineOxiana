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
 */
import { toIsbn13 } from "@ao/core";
import { isSensitive, providerAllowed, type LookupContext, type LookupResult, type Provider } from "./context.js";
import { crossrefWork } from "./crossref.js";
import { LookupHttpError } from "./http.js";
import { locIsbn } from "./loc.js";
import { openAlexSearch, openAlexWork } from "./openalex.js";
import { openLibraryIsbn } from "./openlibrary.js";

export { DEFAULT_ATTEMPT_TIMEOUT_MS, DEFAULT_RATE_LIMITS, HttpClient, LookupCancelledError, LookupHttpError, USER_AGENT } from "./http.js";
export type { GetOptions, HttpClientOptions } from "./http.js";
export { isSensitive, lookupContextFor, providerAllowed } from "./context.js";
export type { LookupContext, LookupResult, Provider } from "./context.js";
export { LOC_SRU_BASE } from "./loc.js";

async function firstAnswer(
  ctx: LookupContext,
  chain: Array<[Provider, () => Promise<LookupResult | null>]>,
): Promise<LookupResult | null> {
  let failed: LookupHttpError | undefined;
  let answered = false;
  for (const [provider, ask] of chain) {
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
      if (!(e instanceof LookupHttpError)) throw e;
      ctx.debug?.(`metadata lookup via ${provider} failed: ${e.message}`);
      failed = e;
    }
  }
  if (failed && !answered) throw failed;
  return null;
}

/** Canonical DOI: lowercase, without a doi.org URL or `doi:` prefix. */
function canonDoi(raw: string): string | null {
  const d = raw.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/u.test(d) ? d : null;
}

export async function lookupDoi(doi: string, ctx: LookupContext): Promise<LookupResult | null> {
  const d = canonDoi(doi);
  if (!d) return null;
  return firstAnswer(ctx, [
    ["crossref", () => crossrefWork(d, ctx)],
    ["openalex", () => openAlexWork(d, ctx)],
  ]);
}

export async function lookupIsbn(isbn: string, ctx: LookupContext): Promise<LookupResult | null> {
  const i = toIsbn13(isbn);
  if (!i) return null;
  return firstAnswer(ctx, [
    ["openlibrary", () => openLibraryIsbn(i, ctx)],
    ["loc", () => locIsbn(i, ctx)],
  ]);
}

/** Candidate matches for a title (and optionally a creator name) from OpenAlex. */
export async function searchTitle(title: string, creator: string | undefined, ctx: LookupContext): Promise<LookupResult[]> {
  if (!providerAllowed(ctx, "openalex")) return [];
  return openAlexSearch(title, creator, ctx);
}
