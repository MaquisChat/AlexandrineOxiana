/**
 * Searching by what was typed, and deciding when the app is sure (Find and acquire, F2).
 *
 * `searchWorks` asks Crossref (`query.bibliographic`) and OpenAlex (`search=`) for works by the
 * typed words, through the governed lookup client: each provider only when the project's rules
 * allow it (`providerAllowed`; a refusal is a debug note), and nothing but the typed words is
 * sent (the client's User-Agent; no e-mail, project or library identifier). Answers are untrusted:
 * at most 5 items read per service, every string cut and cleaned (title ≤ 1,000 characters, a
 * name ≤ 200, at most 100 creators), a DOI kept only when it is one, and a broken answer gives a
 * note, never an exception. Candidates are merged by DOI (case folded) or by normalised title,
 * first family name and year, at most 10 are kept, the likeliest first.
 *
 * `decideMatch` is the plan's rule "Sure enough to complete without asking" (Global Constraints),
 * six conditions and the score 0.6·titleCover + 0.3·creator + 0.1·year. Where the plan left a
 * reading open, the stricter one is taken (see `isSure`): never sure when it should ask.
 *
 * OpenAlex's daily allowance: a 429 that shows the budget spent (X-RateLimit-Remaining: 0, or a
 * body that names a daily budget) is not retried; OpenAlex searches through that same HttpClient
 * pause until X-RateLimit-Reset (or 00:00 UTC), with the note "openalex-budget". The pause is kept
 * in `budgetPause`, a WeakMap keyed by the HttpClient, so it lasts as long as the client does and
 * no longer. An ordinary 429 is retried by the client as before and pauses nothing.
 */
import { createHash } from "node:crypto";
import { normalizeTitle, titleSimilarity, type Creator } from "@ao/core";
import { isSensitive, providerAllowed, type LookupContext, type LookupResult } from "../lookup/context.js";
import { mapCrossref } from "../lookup/crossref.js";
import { LookupHttpError, type HttpClient, type RateLimitAnswer } from "../lookup/http.js";
import { mapOpenAlex } from "../lookup/openalex.js";
import type { WorkCandidate } from "./candidates.js";
import { cleanText, segmentTokens, segmentsOf, tokensOf, type Reference, type Segment } from "./reference.js";

export type { WorkCandidate } from "./candidates.js";

export type SearchNote = "openalex-budget" | "crossref-failed" | "openalex-failed";
export type SearchSource = "crossref" | "openalex";
export type MatchDecision = { kind: "sure"; id: string } | { kind: "choose"; ids: string[] } | { kind: "none" };
export type CandidateScore = { score: number; titleCover: number; creator: boolean; year: boolean };

export const FIND_MAX_CANDIDATES = 10;
export const FIND_TITLE_MAX = 1000;
export const FIND_NAME_MAX = 200;
export const FIND_CREATORS_MAX = 100;
/** Items read from one service's answer: as many as were asked for. */
const PER_SERVICE = 5;
/** Any string from a service is cut to this many UTF-16 units before any other work on it. */
const RAW_MAX = 4000;
const CONTAINER_MAX = 1000;
const ISBN_MAX = 20;
const DOI_MAX = 300;
const DOI_RE = /^10\.\d{4,9}\/\S+$/u;
const SEARCH_TTL_DAYS = 7;
const HOUR_MS = 3_600_000;
/** A reset further away than this is not believed (00:00 UTC is used instead). */
const MAX_PAUSE_MS = 48 * HOUR_MS;

/** Typed words that need no explaining (rule 3). */
const STOP_WORDS: ReadonlySet<string> = new Set(["and", "et", "al", "by", "the", "of", "in"]);
/** Parts of a family name that do not identify it on their own ("de" Beauvoir, "van" Gennep). */
const PARTICLES: ReadonlySet<string> = new Set(["de", "da", "di", "du", "del", "della", "der", "den", "des", "van", "von", "la", "le", "y", "bin", "ibn", "al", "el", "ten", "ter"]);

const CROSSREF_SELECT = "DOI,title,subtitle,author,editor,issued,type,container-title,publisher,ISBN";

/** Percent-encodes every character outside the URL-unreserved set (so the URL parser changes nothing). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The one address Crossref is asked, for the typed text. */
export const crossrefSearchUrl = (text: string) => `https://api.crossref.org/works?query.bibliographic=${enc(text)}&rows=5&select=${CROSSREF_SELECT}`;
/** The one address OpenAlex is asked, for the typed text. */
export const openAlexSearchUrl = (text: string) => `https://api.openalex.org/works?search=${enc(text)}&per-page=5`;

// ---------------------------------------------------------------------------------------------
// OpenAlex's daily allowance

/** Per lookup client: until when (ms since the epoch) OpenAlex searches are paused. */
const budgetPause = new WeakMap<HttpClient, number>();

/** Until when OpenAlex searches through this client are paused (ms since the epoch), or undefined. */
export function openAlexSearchPausedUntil(http: HttpClient): number | undefined {
  return budgetPause.get(http);
}

/** A 429 that says the daily budget is spent: retrying cannot help today. */
export function isOpenAlexBudgetSpent(a: RateLimitAnswer): boolean {
  return a.remaining?.trim() === "0" || /daily|budget|per[ -]day/iu.test(a.body);
}

/** When the allowance comes back: X-RateLimit-Reset (seconds from now, epoch seconds or ms, or a date), else 00:00 UTC. */
function budgetResetAt(a: RateLimitAnswer, now: number): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const v = a.reset?.trim();
  let t: number | undefined;
  if (v && /^\d{1,13}$/u.test(v)) {
    const n = Number(v);
    t = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : now + n * 1000;
  } else if (v) {
    const p = Date.parse(v);
    if (!Number.isNaN(p)) t = p;
  }
  return t === undefined || t <= now || t > now + MAX_PAUSE_MS ? midnight : t;
}

const nowOf = (ctx: LookupContext) => (ctx.clock?.() ?? new Date()).getTime();

// ---------------------------------------------------------------------------------------------
// Bounding what a service returned

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}

/** A string from a service, cut and cleaned; undefined when it is not a string or nothing is left. */
function str(v: unknown, max = RAW_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = cleanText(cut(v, max));
  return t || undefined;
}

/** A short code (type, date, DOI) kept only when it is a string of at most `max` units. */
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

const firstStr = (v: unknown): string | undefined => (Array.isArray(v) ? str(v.slice(0, 5).find((x) => typeof x === "string")) : undefined);

function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

type CrossrefWorkIn = Parameters<typeof mapCrossref>[0];
type OpenAlexWorkIn = Parameters<typeof mapOpenAlex>[0];

function crossrefPerson(p: unknown) {
  if (!isRecord(p)) return null;
  return defined({ given: str(p.given), family: str(p.family), name: str(p.name) });
}

/** One Crossref item reduced to the selected fields, each bounded; null when it is not an object. */
function crossrefItem(v: unknown): CrossrefWorkIn | null {
  if (!isRecord(v)) return null;
  const people = (a: unknown) =>
    Array.isArray(a) ? a.slice(0, FIND_CREATORS_MAX).map(crossrefPerson).filter((p): p is NonNullable<typeof p> => p !== null) : undefined;
  const title = firstStr(v.title);
  const subtitle = firstStr(v.subtitle);
  const container = firstStr(v["container-title"]);
  const issued = isRecord(v.issued) && Array.isArray(v.issued["date-parts"]) && Array.isArray(v.issued["date-parts"][0])
    ? [(v.issued["date-parts"][0] as unknown[]).slice(0, 3).map((n) => (typeof n === "number" ? n : null))]
    : undefined;
  const isbn = Array.isArray(v.ISBN) ? v.ISBN.slice(0, ISBN_MAX).filter((s): s is string => typeof s === "string" && s.length <= 40) : undefined;
  return defined({
    DOI: short(v.DOI, DOI_MAX),
    type: short(v.type, 60),
    title: title ? [title] : undefined,
    subtitle: subtitle ? [subtitle] : undefined,
    author: people(v.author),
    editor: people(v.editor),
    issued: issued ? { "date-parts": issued } : undefined,
    "container-title": container ? [container] : undefined,
    publisher: str(v.publisher),
    ISBN: isbn,
  });
}

/** One OpenAlex result reduced to the fields mapOpenAlex reads (no biblio), each bounded. */
function openAlexItem(v: unknown): OpenAlexWorkIn | null {
  if (!isRecord(v)) return null;
  const authorships = Array.isArray(v.authorships)
    ? v.authorships.slice(0, FIND_CREATORS_MAX).flatMap((a) =>
        isRecord(a) ? [{ author: isRecord(a.author) ? { display_name: str(a.author.display_name, 1000) ?? null } : null, raw_author_name: str(a.raw_author_name, 1000) ?? null }] : [],
      )
    : undefined;
  const source = isRecord(v.primary_location) && isRecord(v.primary_location.source) ? v.primary_location.source : undefined;
  return defined({
    doi: short(v.doi, DOI_MAX),
    title: str(v.title),
    display_name: str(v.display_name),
    publication_date: short(v.publication_date, 50),
    publication_year: typeof v.publication_year === "number" && Number.isInteger(v.publication_year) ? v.publication_year : undefined,
    type: short(v.type, 60),
    authorships,
    primary_location: source ? { source: { display_name: str(source.display_name) ?? null, host_organization_name: str(source.host_organization_name) ?? null } } : undefined,
  });
}

/** A DOI in canonical form (lower case, no resolver prefix), or undefined when it is not a DOI. */
function canonDoi(raw: string | undefined): string | undefined {
  if (!raw || raw.length > DOI_MAX) return undefined;
  const d = raw.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "").toLowerCase();
  return DOI_RE.test(d) ? d : undefined;
}

function boundCreator(c: Creator): Creator | null {
  const name = (v: string | undefined) => (v ? cut(cleanText(v), FIND_NAME_MAX) || undefined : undefined);
  const out = defined({ family: name(c.family), given: name(c.given), literal: name(c.literal), role: c.role });
  return out.family || out.given || out.literal ? out : null;
}

/** A mapped answer as a candidate (id given later), bounded; null without a title. */
function toCandidate(r: LookupResult, provider: SearchSource): WorkCandidate | null {
  const title = cut(cleanText(r.title), FIND_TITLE_MAX);
  if (!title) return null;
  const doi = canonDoi(r.identifiers.doi);
  const isbn = (r.identifiers.isbn ?? []).slice(0, ISBN_MAX);
  const container = r.container ? cut(cleanText(r.container), CONTAINER_MAX) : "";
  const publisher = r.publisher ? cut(cleanText(r.publisher), FIND_NAME_MAX) : "";
  return {
    id: "",
    title,
    creators: r.creators.slice(0, FIND_CREATORS_MAX).map(boundCreator).filter((c): c is Creator => c !== null),
    ...(r.issued ? { issued: r.issued } : {}),
    type: r.type,
    ...(container ? { container } : {}),
    ...(publisher ? { publisher } : {}),
    identifiers: { ...(doi ? { doi } : {}), ...(isbn.length ? { isbn } : {}) },
    providers: [provider],
  };
}

// ---------------------------------------------------------------------------------------------
// Asking the services

type Asked = { found: WorkCandidate[]; note?: SearchNote };

function failed(ctx: LookupContext, provider: SearchSource, e: unknown): Asked {
  // The note names the provider and an HTTP status only: never the address or the typed words.
  const status = e instanceof LookupHttpError && e.status ? ` (HTTP ${e.status})` : "";
  ctx.debug?.(`work search via ${provider} failed${status}`);
  return { found: [], note: provider === "crossref" ? "crossref-failed" : "openalex-failed" };
}

function badShape(ctx: LookupContext, provider: SearchSource): Asked {
  ctx.debug?.(`work search via ${provider}: the answer was not of the expected shape; no candidates from it`);
  return { found: [], note: provider === "crossref" ? "crossref-failed" : "openalex-failed" };
}

async function askCrossref(ref: Reference, ctx: LookupContext): Promise<Asked> {
  if (!providerAllowed(ctx, "crossref")) return { found: [] };
  let res: unknown;
  try {
    res = await ctx.http.getJson<unknown>(crossrefSearchUrl(ref.text), {
      cacheKey: `find:crossref:works:${ref.text}`,
      ttlDays: SEARCH_TTL_DAYS,
      sensitive: isSensitive(ctx),
    });
  } catch (e) {
    return failed(ctx, "crossref", e);
  }
  if (res === null) return { found: [] };
  const items = isRecord(res) && isRecord(res.message) && Array.isArray(res.message.items) ? res.message.items : null;
  if (!items) return badShape(ctx, "crossref");
  const found: WorkCandidate[] = [];
  for (const item of items.slice(0, PER_SERVICE)) {
    const w = crossrefItem(item);
    const r = w ? mapCrossref(w, "") : null;
    const c = r ? toCandidate(r, "crossref") : null;
    if (c) found.push(c);
  }
  return { found };
}

async function askOpenAlex(ref: Reference, ctx: LookupContext): Promise<Asked> {
  if (!providerAllowed(ctx, "openalex")) return { found: [] };
  const until = budgetPause.get(ctx.http);
  if (until !== undefined) {
    if (nowOf(ctx) < until) {
      ctx.debug?.("work search via openalex skipped: its free daily allowance is used up");
      return { found: [], note: "openalex-budget" };
    }
    budgetPause.delete(ctx.http);
  }
  let res: unknown;
  try {
    res = await ctx.http.getJson<unknown>(openAlexSearchUrl(ref.text), {
      cacheKey: `find:openalex:works:${ref.text}`,
      ttlDays: SEARCH_TTL_DAYS,
      sensitive: isSensitive(ctx),
      final429: isOpenAlexBudgetSpent,
    });
  } catch (e) {
    if (e instanceof LookupHttpError && e.status === 429 && e.rateLimit && isOpenAlexBudgetSpent(e.rateLimit)) {
      budgetPause.set(ctx.http, budgetResetAt(e.rateLimit, nowOf(ctx)));
      ctx.debug?.("work search via openalex paused: its free daily allowance is used up");
      return { found: [], note: "openalex-budget" };
    }
    return failed(ctx, "openalex", e);
  }
  if (res === null) return { found: [] };
  const results = isRecord(res) && Array.isArray(res.results) ? res.results : null;
  if (!results) return badShape(ctx, "openalex");
  const found: WorkCandidate[] = [];
  for (const item of results.slice(0, PER_SERVICE)) {
    const w = openAlexItem(item);
    const r = w ? mapOpenAlex(w) : null;
    const c = r ? toCandidate(r, "openalex") : null;
    if (c) found.push(c);
  }
  return { found };
}

// ---------------------------------------------------------------------------------------------
// Merging

const firstFamily = (c: WorkCandidate) => {
  const p = c.creators[0];
  return p ? normalizeTitle(p.family ?? p.literal ?? "") : "";
};
const yearOf = (issued: string | undefined): number | undefined => {
  const m = issued ? /^(\d{4})/u.exec(issued) : null;
  return m ? Number(m[1]) : undefined;
};
const mergeKey = (c: WorkCandidate) => `${normalizeTitle(c.title)}|${firstFamily(c)}|${yearOf(c.issued) ?? ""}`;

function disjoint(a: readonly string[], b: readonly string[]): boolean {
  return !a.some((x) => b.includes(x));
}

/**
 * One work: the same DOI; or, with no conflicting identifier, the same normalised title, first
 * family name and year (both needed: two records with no author are never merged by title alone).
 */
function sameWork(a: WorkCandidate, b: WorkCandidate): boolean {
  const da = a.identifiers.doi;
  const db = b.identifiers.doi;
  if (da && db) return da === db;
  const ia = a.identifiers.isbn ?? [];
  const ib = b.identifiers.isbn ?? [];
  if (ia.length && ib.length && disjoint(ia, ib)) return false;
  return normalizeTitle(a.title) !== "" && firstFamily(a) !== "" && mergeKey(a) === mergeKey(b);
}

/** `a` with what only `b` knows: the first service's values win. */
function merge(a: WorkCandidate, b: WorkCandidate): WorkCandidate {
  const isbn = [...new Set([...(a.identifiers.isbn ?? []), ...(b.identifiers.isbn ?? [])])].slice(0, ISBN_MAX);
  const doi = a.identifiers.doi ?? b.identifiers.doi;
  const issued = a.issued ?? b.issued;
  const container = a.container ?? b.container;
  const publisher = a.publisher ?? b.publisher;
  return {
    ...a,
    creators: a.creators.length ? a.creators : b.creators,
    ...(issued ? { issued } : {}),
    type: a.type === "other" ? b.type : a.type,
    ...(container ? { container } : {}),
    ...(publisher ? { publisher } : {}),
    identifiers: { ...(doi ? { doi } : {}), ...(isbn.length ? { isbn } : {}) },
    providers: [...new Set([...a.providers, ...b.providers])],
  };
}

function withIds(list: WorkCandidate[]): WorkCandidate[] {
  const used = new Set<string>();
  return list.map((c) => {
    const basis = c.identifiers.doi ? `doi:${c.identifiers.doi}` : c.identifiers.isbn?.length ? `isbn:${c.identifiers.isbn[0]}` : `key:${mergeKey(c)}`;
    let id = `w${createHash("sha256").update(basis).digest("hex").slice(0, 20)}`;
    for (let n = 2; used.has(id); n++) id = `${id.split("-")[0]}-${n}`;
    used.add(id);
    return { ...c, id };
  });
}

/**
 * Works for a typed reference from Crossref and OpenAlex (in `opts.sources`, each asked at most
 * once and only when the project's rules allow it): merged, at most 10, the likeliest first.
 * Never throws for a service's failure or a broken answer: those become `notes` (in source order).
 */
export async function searchWorks(
  ref: Reference,
  ctx: LookupContext,
  opts: { sources: SearchSource[] },
): Promise<{ candidates: WorkCandidate[]; notes: SearchNote[] }> {
  if (!ref.tokens.length || !ref.text) return { candidates: [], notes: [] };
  const sources = [...new Set(opts.sources)].filter((s): s is SearchSource => s === "crossref" || s === "openalex");
  const asked = await Promise.all(sources.map((s) => (s === "crossref" ? askCrossref(ref, ctx) : askOpenAlex(ref, ctx))));
  const merged: WorkCandidate[] = [];
  for (const c of asked.flatMap((a) => a.found)) {
    const i = merged.findIndex((m) => sameWork(m, c));
    if (i >= 0) merged[i] = merge(merged[i]!, c);
    else merged.push(c);
  }
  const prep = prepare(ref);
  const ranked = merged
    .map((c, i) => ({ c, i, s: scoreWith(prep, c).score }))
    .sort((x, y) => y.s - x.s || y.c.providers.length - x.c.providers.length || x.i - y.i)
    .slice(0, FIND_MAX_CANDIDATES)
    .map((x) => x.c);
  return { candidates: withIds(ranked), notes: asked.flatMap((a) => (a.note ? [a.note] : [])) };
}

// ---------------------------------------------------------------------------------------------
// The confidence rule

interface Prepared {
  typed: Set<string>;
  segments: Segment[];
  year?: number;
  /** How often each typed word occurs (a word may be both a title word and a name only if typed twice). */
  wordCount: Map<string, number>;
  /** The typed runs of scripts written without spaces. */
  runs: string[];
}

function prepare(ref: Reference): Prepared {
  // A Reference built elsewhere (a stored queue entry) is bounded here too.
  const segments = segmentsOf(cut(ref.text, RAW_MAX));
  const wordCount = new Map<string, number>();
  const runs: string[] = [];
  for (const s of segments) {
    if ("word" in s) wordCount.set(s.word, (wordCount.get(s.word) ?? 0) + 1);
    else runs.push(s.chars.join(""));
  }
  return { typed: new Set(ref.tokens), segments, ...(ref.year !== undefined ? { year: ref.year } : {}), wordCount, runs };
}

/** The title before its subtitle ("Distinction" of "Distinction: A Social Critique …"), or null. */
function mainTitle(title: string): string | null {
  const m = /[:：]|\s[—–-]\s/u.exec(title);
  return m && m.index > 0 ? title.slice(0, m.index).trim() || null : null;
}

interface TitleInfo {
  full: string;
  main: string | null;
  fullTokens: string[];
  mainTokens: string[] | null;
  /** The title's runs of scripts written without spaces, joined. */
  runs: string;
}

function titleInfo(c: WorkCandidate): TitleInfo {
  const full = cut(c.title, FIND_TITLE_MAX);
  const main = mainTitle(full);
  const segs = segmentsOf(full);
  return {
    full,
    main,
    fullTokens: [...new Set(segs.flatMap(segmentTokens))],
    mainTokens: main ? tokensOf(main) : null,
    runs: segs.flatMap((s) => ("chars" in s ? [s.chars.join("")] : [])).join(" "),
  };
}

function coverOf(tokens: string[], typed: Set<string>): number {
  if (!tokens.length) return 0;
  let n = 0;
  for (const t of tokens) if (typed.has(t)) n++;
  return n / tokens.length;
}

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

const creatorsOf = (c: WorkCandidate) => c.creators.slice(0, FIND_CREATORS_MAX);

/**
 * Rule 2: a family name (or a whole literal name) is typed. A part of it that is also a word of
 * the candidate's title counts only when typed twice, so one typed word is never both the title
 * and the author ("Granovetter" typed for a work titled "Granovetter").
 */
function creatorTyped(p: Prepared, c: WorkCandidate, t: TitleInfo): boolean {
  const titleWords = new Set(t.fullTokens);
  const typedEnough = (seg: Segment): boolean => {
    if ("word" in seg) return (p.wordCount.get(seg.word) ?? 0) >= (titleWords.has(seg.word) ? 2 : 1);
    const s = seg.chars.join("");
    const typed = p.runs.reduce((n, r) => n + occurrences(r, s), 0);
    return typed >= (t.runs.includes(s) ? 2 : 1);
  };
  for (const person of creatorsOf(c)) {
    if (person.family) {
      const segs = segmentsOf(cut(person.family, FIND_NAME_MAX));
      const named = segs.length > 1 ? segs.filter((s) => !("word" in s && PARTICLES.has(s.word))) : segs;
      if (named.some(typedEnough)) return true;
    } else if (person.literal) {
      const segs = segmentsOf(cut(person.literal, FIND_NAME_MAX)).filter((s) => !("word" in s && STOP_WORDS.has(s.word)));
      if (segs.length && segs.every(typedEnough)) return true;
    }
  }
  return false;
}

function yearMatches(p: Prepared, c: WorkCandidate): boolean {
  if (p.year === undefined) return true;
  const y = yearOf(c.issued);
  return y !== undefined && Math.abs(y - p.year) <= 1;
}

function scoreWith(p: Prepared, c: WorkCandidate, t: TitleInfo = titleInfo(c)): CandidateScore {
  const titleCover = Math.max(coverOf(t.fullTokens, p.typed), t.mainTokens ? coverOf(t.mainTokens, p.typed) : 0);
  const creator = creatorTyped(p, c, t);
  const year = yearMatches(p, c);
  const score = Math.round((0.6 * titleCover + 0.3 * (creator ? 1 : 0) + 0.1 * (year ? 1 : 0)) * 1e6) / 1e6;
  return { score, titleCover: Math.round(titleCover * 1e6) / 1e6, creator, year };
}

/**
 * How well a candidate fits the typed reference. `titleCover` is the share of the candidate's
 * title tokens that were typed, taken over the whole title or, when it has one, the title before
 * its subtitle (whichever is higher); `creator` is rule 2; `year` is true when the typed year is
 * within ±1 of the candidate's, or no year was typed. Score = 0.6·titleCover + 0.3·creator + 0.1·year.
 */
export function scoreCandidate(ref: Reference, c: WorkCandidate): CandidateScore {
  return scoreWith(prepare(ref), c);
}

/** Rule 3: typed tokens explained by none of the title, the creators' names, a 4-digit number or the small words. */
function unexplained(p: Prepared, c: WorkCandidate, t: TitleInfo): number {
  const known = new Set<string>([...t.fullTokens, ...STOP_WORDS]);
  for (const person of creatorsOf(c)) {
    for (const n of [person.family, person.given, person.literal]) if (n) for (const tok of tokensOf(cut(n, FIND_NAME_MAX))) known.add(tok);
  }
  let count = 0;
  for (const seg of p.segments) {
    if ("word" in seg) {
      if (!known.has(seg.word) && !/^\d{4}$/u.test(seg.word)) count++;
      continue;
    }
    // A run without spaces: a character is explained when a known pair (or a known single
    // character) covers it; each stretch of unexplained characters counts as one token.
    const ch = seg.chars;
    const covered = ch.map((x) => known.has(x));
    for (let i = 0; i + 1 < ch.length; i++) {
      if (known.has(ch[i]! + ch[i + 1]!)) covered[i] = covered[i + 1] = true;
    }
    for (let i = 0; i < ch.length; i++) if (!covered[i] && (i === 0 || covered[i - 1])) count++;
  }
  return count;
}

/** The highest titleSimilarity between two candidates' whole titles or titles before the subtitle. */
function closeTitles(a: TitleInfo, b: TitleInfo): number {
  let best = 0;
  for (const x of [a.full, a.main]) for (const y of [b.full, b.main]) if (x && y) best = Math.max(best, titleSimilarity(x, y));
  return best;
}

/**
 * Two records known to be one work: they share a DOI or an ISBN, and neither has a DOI or an
 * ISBN list the other contradicts (a chapter shares its book's ISBN but has its own DOI).
 */
function provablySame(a: WorkCandidate, b: WorkCandidate): boolean {
  const da = a.identifiers.doi;
  const db = b.identifiers.doi;
  const ia = a.identifiers.isbn ?? [];
  const ib = b.identifiers.isbn ?? [];
  if (da && db && da !== db) return false;
  if (ia.length && ib.length && disjoint(ia, ib)) return false;
  return (!!da && da === db) || ia.some((i) => ib.includes(i));
}

type Scored = { c: WorkCandidate; i: number; s: CandidateScore; t: TitleInfo };

/**
 * The six conditions. Readings the plan left open, each taken the strict way:
 *  - rule 5 blocks unless the other record is provably the same work (see provablySame): a
 *    close title with no identifier at all may be another edition;
 *  - rule 2 does not let one typed word be both a title word and the author (see creatorTyped);
 *  - a candidate given only by Elicit is never sure on its own.
 */
function isSure(p: Prepared, best: Scored, all: Scored[]): boolean {
  const { c, s, t } = best;
  if (!c.providers.length || c.providers.every((x) => x === "elicit")) return false;
  if (s.titleCover < 0.9) return false; // 1
  if (!s.creator) return false; // 2
  if (unexplained(p, c, t) > 1) return false; // 3
  if (!s.year) return false; // 4
  for (const o of all) {
    if (o === best) continue;
    if (closeTitles(t, o.t) >= 0.8 && !provablySame(c, o.c)) return false; // 5
  }
  const next = all.find((o) => o !== best);
  if (next && next.s.score > s.score - 0.2 + 1e-9) return false; // 6
  return true;
}

/**
 * Sure (complete the record without asking), choose (the candidates, likeliest first), or none
 * (no candidate scores 0.4). Pure: it reads only the reference and the candidates given.
 */
export function decideMatch(ref: Reference, candidates: WorkCandidate[]): MatchDecision {
  if (!candidates.length) return { kind: "none" };
  const p = prepare(ref);
  const scored: Scored[] = candidates
    .map((c, i) => {
      const t = titleInfo(c);
      return { c, i, s: scoreWith(p, c, t), t };
    })
    .sort((x, y) => y.s.score - x.s.score || x.i - y.i);
  const best = scored[0]!;
  if (best.s.score < 0.4) return { kind: "none" };
  if (isSure(p, best, scored)) return { kind: "sure", id: best.c.id };
  return { kind: "choose", ids: scored.map((x) => x.c.id) };
}
