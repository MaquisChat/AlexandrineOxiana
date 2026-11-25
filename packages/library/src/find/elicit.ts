/**
 * Elicit's paper search as one more source of Find and acquire (Task F12; Ruling R290 c; plan Global Constraints
 * "Hosts", "Rates", "What is sent").
 *
 * `POST https://elicit.com/api/v2/search/papers` with the JSON body `{ query: <the typed text>, maxResults: 10 }` and
 * the researcher's key as `Authorization: Bearer <key>` (bound to elicit.com by the lookup client, never in an
 * address). The body holds the typed words and nothing else: no project, library or device name or id, no e-mail, no
 * other field. Never cached (`postJson`), never retried, never redirected, bounded in time (ELICIT_TIMEOUT_MS, its
 * wait for a place included) and in size (the client's 5 MB; at most ELICIT_MAX_RESULTS papers read, every string
 * cut and cleaned as the search cuts them). A hostile or malformed answer gives no candidates and a debug note.
 *
 * It maps `title`, `authors`, `year`, `doi` and `venue` to WorkCandidates with the provider `elicit`. `fullTextUrl` is
 * ignored in this task (offers are the copy part's, F11). A candidate only Elicit gave is never sure by itself
 * (`decideMatch`, unchanged).
 *
 * Asked only when the project's rules name Elicit (`providerAllowed(ctx, "elicit")`; a refusal is a debug note) — and
 * by the runner only when it is switched on and a key is stored. A 401 (the key refused), a 400 (the plan's cap, as
 * far as its wording can tell), a 5xx, a timeout or any failure never throws: no candidates and a note. A 429 stops
 * Elicit for ELICIT_PAUSE_MS in this process: it is not asked at all in that time.
 *
 * UNVERIFIED against the live service (the owner's first real run, "Test" says): the answer's shape (`papers`, each
 * with `title`, `authors` as names, `year`, `doi`, `venue`), the 400's wording for the plan's cap, the 429's form.
 */
import type { Creator } from "@ao/core";
import { providerAllowed, type LookupContext, type LookupResult } from "../lookup/context.js";
import { LookupHttpError } from "../lookup/http.js";
import type { WorkCandidate } from "./candidates.js";
import { parseReference, type Reference } from "./reference.js";
import { boundCandidate, boundedText } from "./search.js";

export const ELICIT_URL = "https://elicit.com/api/v2/search/papers";
/** The results asked for (the plan's `maxResults`). */
export const ELICIT_MAX_RESULTS = 10;
/** Elicit's own time limit: no search waits longer for it. */
export const ELICIT_TIMEOUT_MS = 20_000;
/** After a 429 Elicit is not asked for this long, in this process (docs.elicit.com: a 429 blocks for 5 minutes). */
export const ELICIT_PAUSE_MS = 300_000;
const NAME_RAW_MAX = 1000;
const DOI_MAX = 300;
const DOI_RE = /^10\.\d{4,9}\/\S+$/u;

/** What one ask of Elicit came to. Never the key, never the answer's own words. */
export type ElicitOutcome =
  | { kind: "answered"; candidates: WorkCandidate[] }
  | { kind: "not-allowed" }
  | { kind: "paused" }
  | { kind: "key-refused" }
  | { kind: "plan-cap" }
  | { kind: "rate-limited" }
  | { kind: "bad-answer" }
  | { kind: "failed" };

/** Until when (ms since the epoch) Elicit is not asked in this process; 0 when it may be. */
let pausedUntil = 0;
/** The last refusal Elicit gave (for the settings screen's note); cleared by an answer or a new key. */
let lastRefusal: "key-refused" | "plan-cap" | undefined;

/** Until when Elicit is paused after a 429 (ms since the epoch), or undefined when it is not paused at `now`. */
export function elicitPausedUntil(now: number = Date.now()): number | undefined {
  return pausedUntil > now ? pausedUntil : undefined;
}

/** The last refusal Elicit gave in this process: its key refused (401) or its plan's cap (400). */
export function elicitLastRefusal(): "key-refused" | "plan-cap" | undefined {
  return lastRefusal;
}

/** Forgets the last refusal (a key was saved or removed: the next answer says again). */
export function forgetElicitRefusal(): void {
  lastRefusal = undefined;
}

/** TESTS ONLY (honoured under NODE_ENV=test): forgets the pause and the last refusal. */
export function _resetElicitForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  pausedUntil = 0;
  lastRefusal = undefined;
}

const nowOf = (ctx: LookupContext) => (ctx.clock?.() ?? new Date()).getTime();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A name as Elicit gives it ("Given Family", "Family, Given", or `{ name }`), as a creator; null when there is none. */
function creatorOf(v: unknown): Creator | null {
  const raw = boundedText(isRecord(v) ? v.name : v, NAME_RAW_MAX);
  if (!raw) return null;
  const comma = raw.indexOf(",");
  if (comma > 0) {
    const family = raw.slice(0, comma).trim();
    const given = raw.slice(comma + 1).trim();
    return family ? { ...(given ? { given } : {}), family, role: "author" } : null;
  }
  const words = raw.split(/\s+/u).filter(Boolean);
  if (words.length === 1) return { family: words[0]!, role: "author" };
  return { given: words.slice(0, -1).join(" "), family: words[words.length - 1]!, role: "author" };
}

/** A four-digit year from a number or a string, or undefined. */
function yearOf(v: unknown): string | undefined {
  const s = typeof v === "number" && Number.isInteger(v) ? String(v) : typeof v === "string" && v.length <= 10 ? v.trim() : "";
  return /^\d{4}$/u.test(s) && Number(s) >= 1000 && Number(s) <= 2100 ? s : undefined;
}

function doiOf(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > DOI_MAX) return undefined;
  const d = v.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "").toLowerCase();
  return DOI_RE.test(d) ? d : undefined;
}

/** One paper as a candidate (id given by the search's merge), bounded; null without a title. */
function paperOf(v: unknown): WorkCandidate | null {
  if (!isRecord(v)) return null;
  const title = boundedText(v.title);
  if (!title) return null;
  const authors = Array.isArray(v.authors) ? v.authors.slice(0, 100).map(creatorOf).filter((c): c is Creator => c !== null) : [];
  const year = yearOf(v.year);
  const doi = doiOf(v.doi);
  const venue = boundedText(v.venue);
  const r: LookupResult = {
    title,
    creators: authors,
    ...(year ? { issued: year } : {}),
    ...(venue ? { container: venue } : {}),
    type: "article-journal",
    identifiers: { ...(doi ? { doi } : {}) },
    provider: "elicit",
  };
  return boundCandidate(r, "elicit");
}

/** The papers of an answer, or null when it is not of the expected shape (UNVERIFIED: `papers`, or `results`). */
function papersOf(json: unknown): unknown[] | null {
  if (!isRecord(json)) return null;
  const list = Array.isArray(json.papers) ? json.papers : Array.isArray(json.results) ? json.results : null;
  return list;
}

/** A 400's start that names the plan, a limit or `maxResults`: the plan's cap (UNVERIFIED wording). */
const CAP_WORDS = /\b(?:plan|limit|maxResults|max_results|tier|upgrade)\b/iu;

/**
 * Asks Elicit for `text` (the caller's typed words, or Test's fixed words) with `key`. Never throws. The text must
 * already be the cleaned typed line: nothing else is sent.
 */
export async function elicitAsk(text: string, key: string, ctx: LookupContext, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ElicitOutcome> {
  if (!providerAllowed(ctx, "elicit")) return { kind: "not-allowed" };
  const now = nowOf(ctx);
  if (pausedUntil > now) {
    ctx.debug?.("paper search via elicit skipped: it asked the app to slow down (five minutes)");
    return { kind: "paused" };
  }
  let refusal: { status: number; start: string } | undefined;
  let json: unknown;
  try {
    const timeoutMs = opts.timeoutMs ?? ELICIT_TIMEOUT_MS;
    const call = ctx.http.postJson(
      ELICIT_URL,
      { query: text, maxResults: ELICIT_MAX_RESULTS },
      {
        key: { host: "elicit.com", value: key },
        timeoutMs,
        // FR-765: the caller's signal, else the context's stop (a Find run's).
        ...(opts.signal ?? ctx.signal ? { signal: opts.signal ?? ctx.signal } : {}),
        onRefusal: (status, start) => (refusal = { status, start }),
      },
    );
    // Elicit's own time limit bounds the whole ask, whatever the client does.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LookupHttpError("The service did not answer in time")), timeoutMs + 50);
    });
    try {
      json = (await Promise.race([call, late])).json;
    } finally {
      clearTimeout(timer);
      call.catch(() => undefined);
    }
  } catch (e) {
    const status = e instanceof LookupHttpError ? e.status : undefined;
    if (status === 429) {
      pausedUntil = nowOf(ctx) + ELICIT_PAUSE_MS;
      ctx.debug?.("paper search via elicit: it asked the app to slow down; not asked for five minutes");
      return { kind: "rate-limited" };
    }
    if (status === 401 || status === 403) {
      lastRefusal = "key-refused";
      ctx.debug?.(`paper search via elicit: the key was not accepted (HTTP ${status})`);
      return { kind: "key-refused" };
    }
    const r = refusal as { status: number; start: string } | undefined;
    if (status === 400 && r && CAP_WORDS.test(r.start)) {
      lastRefusal = "plan-cap";
      ctx.debug?.("paper search via elicit: the plan does not allow this many results (HTTP 400)");
      return { kind: "plan-cap" };
    }
    ctx.debug?.(`paper search via elicit failed${status ? ` (HTTP ${status})` : ""}`);
    return { kind: "failed" };
  }
  const papers = papersOf(json);
  if (!papers) {
    ctx.debug?.("paper search via elicit: the answer was not of the expected shape; no candidates from it");
    return { kind: "bad-answer" };
  }
  lastRefusal = undefined;
  const candidates: WorkCandidate[] = [];
  for (const p of papers.slice(0, ELICIT_MAX_RESULTS)) {
    const c = paperOf(p);
    if (c) candidates.push(c);
  }
  return { kind: "answered", candidates };
}

/**
 * Works for a typed reference from Elicit (`POST …/search/papers`, the typed text and maxResults 10, the key in the
 * header). Never throws: a refusal, a failure, a pause or a broken answer is no candidates and a debug note. The
 * reference is parsed again from its `text`, as `searchWorks` does: a reference with no words sends nothing.
 */
export async function elicitSearch(given: Reference, key: string, ctx: LookupContext, opts: { timeoutMs?: number } = {}): Promise<WorkCandidate[]> {
  const ref = typeof given?.text === "string" ? parseReference(given.text) : null;
  if (!ref || !ref.tokens.length || typeof key !== "string" || !key) return [];
  const out = await elicitAsk(ref.text, key, ctx, opts);
  return out.kind === "answered" ? out.candidates : [];
}
