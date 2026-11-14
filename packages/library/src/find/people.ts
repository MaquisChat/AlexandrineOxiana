/**
 * An author alone (Find and acquire, Task F8; Ruling R267): when a researcher types a person's name and nothing else
 * ("Arlie Hochschild"), the app does not guess a work. It finds the people of that name (OpenAlex's authors), asks
 * which person is meant when more than one fits, then offers that person's works, newest first; each work ticked
 * becomes an entry of its own (the runner's `chooseWorks`), whose record is made from a fresh request for that one
 * work by its OpenAlex id.
 *
 * Every answer is untrusted: ids are checked (`A<digits>`, `W<digits>`), every string is cut and cleaned of control
 * and invisible characters as the works search does, at most 20 people and 200 works (two pages of 100) are read,
 * and what is kept for choosing is bounded so that a queue line fits the store's 64 KiB by construction
 * (`fitAuthorEntry`). Nothing but the typed words, or an id that an earlier answer gave, is sent.
 *
 * Cost (OpenAlex's budget, Global Constraints): the people search is a search (`search=`), a person's works a filtered
 * list; both count against the daily allowance and both stop while it is paused (the works search's pause, shared:
 * `openAlexSearchPaused`). A single work by its id is free and is asked whatever the pause.
 */
import { SourceType, normalizeTitle } from "@ao/core";
import { InvalidInputError } from "../repo/errors.js";
import { parseName } from "../extract/names.js";
import { isSensitive, providerAllowed, type LookupContext } from "../lookup/context.js";
import { LookupHttpError } from "../lookup/http.js";
import { mapOpenAlex } from "../lookup/openalex.js";
import type { WorkCandidate } from "./candidates.js";
import { cleanText, segmentsOf, tokensOf, type Reference } from "./reference.js";
import { BadAnswer, canonDoi, fetchItems, isOpenAlexBudgetSpent, openAlexCandidate, openAlexSearchPaused, pauseOpenAlexSearches, scoreCandidate } from "./search.js";
import { FIND_DOI_MAX, FIND_LINE_MAX_BYTES, type FindEntry, type PersonCandidate } from "./types.js";

/** At most this many people are read from OpenAlex's answer and kept (`per-page=20`). */
export const FIND_PEOPLE_MAX = 20;
/** At most this many works of a person are kept for choosing (two pages of 100, newest first). */
export const FIND_PERSON_WORKS_MAX = 200;
export const FIND_PERSON_WORKS_PAGE = 100;
/** What is kept of a work for choosing: its title cut to this many characters … */
export const FIND_PERSON_TITLE_MAX = 300;
/** … and where it was published, cut to this many. */
export const FIND_PERSON_VENUE_MAX = 100;
/** A person's name and affiliation are cut to this many characters. */
export const FIND_PERSON_NAME_MAX = 200;
/** A work's first author kept for choosing (and for the line typed for it) is cut to this many characters. */
const FIRST_AUTHOR_MAX = 100;
/** At most this many subject names per person (R270 e), each cut to FIND_PERSON_SUBJECT_MAX. */
export const FIND_PERSON_SUBJECTS = 3;
export const FIND_PERSON_SUBJECT_MAX = 100;
/** The people search is asked only for a line of at most this many words … */
export const FIND_PEOPLE_WORDS_MAX = 6;
/** … and only when no work candidate covers this much of its title (a title is then plainly meant). */
export const FIND_PEOPLE_TITLE_COVER = 0.6;
/** One tick adds at most this many works. */
export const FIND_CHOOSE_WORKS_MAX = 50;
/** A typed line's longest length (the queue's own bound). */
const TYPED_MAX = 500;
/** Any string from the service is cut to this many UTF-16 units before any other work on it. */
const RAW_MAX = 4000;
const SEARCH_TTL_DAYS = 7;

/** The kinds of work the library knows: a work of any other kind is never kept (R271 M1). */
const SOURCE_TYPES: readonly string[] = SourceType.options;
const PERSON_ID = /^A\d{1,12}$/u;
const WORK_ID = /^W\d{1,12}$/u;
const PERSON_URI = /^https:\/\/openalex\.org\/(A\d{1,12})$/u;
const WORK_URI = /^https:\/\/openalex\.org\/(W\d{1,12})$/u;

export const isPersonId = (s: unknown): s is string => typeof s === "string" && PERSON_ID.test(s);
export const isWorkId = (s: unknown): s is string => typeof s === "string" && WORK_ID.test(s);

/** Percent-encodes every character outside the URL-unreserved set (as the works search does). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The one address the people search asks, for the typed text. */
export const peopleSearchUrl = (text: string): string => `https://api.openalex.org/authors?search=${enc(text)}&per-page=${FIND_PEOPLE_MAX}`;
/** A page (1 or 2) of a person's works, newest first. `id` is checked by the caller (`A<digits>`: nothing to encode). */
export const personWorksUrl = (id: string, page: number): string =>
  `https://api.openalex.org/works?filter=authorships.author.id:${id}&sort=publication_date:desc&per-page=${FIND_PERSON_WORKS_PAGE}&page=${page}`;
/** One work by its id (`W<digits>`), free of the daily allowance. */
export const workUrl = (id: string): string => `https://api.openalex.org/works/${id}`;

/**
 * The people search or a person's works could not be had: OpenAlex's daily allowance is used up (`budget`: the
 * entry waits for its end), or the service failed or answered something else (`failed`: the ordinary retries).
 * Never an empty answer in disguise: the caller does not guess.
 */
export class FindPeopleError extends Error {
  override name = "FindPeopleError";
  constructor(readonly code: "budget" | "failed") {
    super(code === "budget" ? "OpenAlex's free daily allowance is used up." : "OpenAlex could not be reached.");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bounding what the service sent

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}
/** A string from the service: cut, cleaned of control and invisible characters, cut again; undefined when empty. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = cut(cleanText(cut(v, RAW_MAX)), max);
  return t || undefined;
}
const firstRecord = (v: unknown): Record<string, unknown> | undefined => (Array.isArray(v) ? v.slice(0, 5).find(isRecord) : undefined);

function personOf(v: unknown): PersonCandidate | null {
  if (!isRecord(v) || typeof v.id !== "string") return null;
  const id = PERSON_URI.exec(v.id)?.[1] ?? (PERSON_ID.test(v.id) ? v.id : undefined);
  const name = text(v.display_name, FIND_PERSON_NAME_MAX);
  if (!id || !name) return null;
  // Where the person works now, as OpenAlex gives it (`last_known_institutions`; older answers `last_known_institution`,
  // else the first of `affiliations`).
  const aff0 = firstRecord(v.affiliations);
  const inst =
    firstRecord(v.last_known_institutions) ??
    (isRecord(v.last_known_institution) ? v.last_known_institution : undefined) ??
    (aff0 && isRecord(aff0.institution) ? aff0.institution : undefined);
  const affiliation = text(inst?.display_name, FIND_PERSON_NAME_MAX);
  const wc = v.works_count;
  const worksCount = typeof wc === "number" && Number.isSafeInteger(wc) && wc >= 0 ? wc : 0;
  // R270 e: no sample titles (a request per person); up to three subject names from this same answer instead.
  return { id, name, ...(affiliation ? { affiliation } : {}), worksCount, subjects: subjectsOf(v) };
}

/**
 * Up to FIND_PERSON_SUBJECTS subject names of a person, from the same answer: `topics[].display_name`, else
 * `x_concepts[].display_name` (UNVERIFIED shapes: anything else gives none, never an error); each cleaned and cut to
 * FIND_PERSON_SUBJECT_MAX.
 */
function subjectsOf(v: Record<string, unknown>): string[] {
  const names = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const item of list.slice(0, 20)) {
      const name = isRecord(item) ? text(item.display_name, FIND_PERSON_SUBJECT_MAX) : undefined;
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= FIND_PERSON_SUBJECTS) break;
    }
    return out;
  };
  const topics = names(v.topics);
  return topics.length ? topics : names(v.x_concepts);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** One work of a person as kept for choosing: id, title (300), year or date, kind, where published (100), DOI, first author. */
function personWorkOf(v: unknown): WorkCandidate | null {
  if (!isRecord(v) || typeof v.id !== "string") return null;
  const id = WORK_URI.exec(v.id)?.[1] ?? (WORK_ID.test(v.id) ? v.id : undefined);
  const title = text(v.title, FIND_PERSON_TITLE_MAX) ?? text(v.display_name, FIND_PERSON_TITLE_MAX);
  if (!id || !title) return null;
  const date = typeof v.publication_date === "string" && DATE.test(v.publication_date) ? v.publication_date : undefined;
  const year = typeof v.publication_year === "number" && Number.isInteger(v.publication_year) && v.publication_year >= 1000 && v.publication_year <= 9999 ? String(v.publication_year) : undefined;
  const type = mapOpenAlex({ title: "x", type: typeof v.type === "string" && v.type.length <= 60 ? v.type : null })!.type;
  const source = isRecord(v.primary_location) && isRecord(v.primary_location.source) ? v.primary_location.source : undefined;
  const container = text(source?.display_name, FIND_PERSON_VENUE_MAX);
  const doi = typeof v.doi === "string" ? canonDoi(v.doi.slice(0, FIND_DOI_MAX + 32).replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")) : undefined;
  const a = firstRecord(v.authorships);
  const raw = a ? (text(isRecord(a.author) ? a.author.display_name : undefined, RAW_MAX) ?? text(a.raw_author_name, RAW_MAX)) : undefined;
  const parsed = raw ? parseName(raw) : undefined;
  const family = parsed?.family ? cut(parsed.family, FIRST_AUTHOR_MAX) : undefined;
  const literal = !family && parsed?.literal ? cut(parsed.literal, FIRST_AUTHOR_MAX) : undefined;
  return {
    id,
    title,
    creators: family ? [{ family, role: "author" }] : literal ? [{ literal, role: "author" }] : [],
    ...(date ?? year ? { issued: (date ?? year)! } : {}),
    type,
    ...(container ? { container } : {}),
    identifiers: doi && doi.length <= FIND_DOI_MAX ? { doi } : {},
    providers: ["openalex"],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// When the people search is asked, and what it decides

/**
 * THE CONDITION (R267 d): the people search is asked only when it can change the outcome — ALL of:
 *  1. the line holds no digit (Unicode `Nd`): so no DOI, no ISBN, no year and no number (each of those has a digit);
 *  2. it has at most FIND_PEOPLE_WORDS_MAX (6) words — `segmentsOf` of the typed text: a word, or a run of a script
 *     written without spaces, each counts one;
 *  3. no work candidate of the works search has `titleCover` ≥ FIND_PEOPLE_TITLE_COVER (0.6): then no title is
 *     plainly meant (so the entry is not sure either: being sure needs 0.9).
 * So a line with a clear title costs no people request. The runner also asks it only when OpenAlex is both on in the
 * settings and allowed by the project's rules.
 */
export function peopleSearchWanted(ref: Reference, candidates: WorkCandidate[]): boolean {
  if (!ref.tokens.length || /\p{Nd}/u.test(ref.text)) return false;
  if (segmentsOf(ref.text).length > FIND_PEOPLE_WORDS_MAX) return false;
  return candidates.every((c) => scoreCandidate(ref, c).titleCover < FIND_PEOPLE_TITLE_COVER);
}

export type PersonDecision = { kind: "one"; person: PersonCandidate; byInitial: boolean } | { kind: "several"; people: PersonCandidate[] } | { kind: "none" };

/**
 * The Global Constraint's person rule, exactly: a person fits when the tokens of their name (`normalizeTitle` words, as
 * the typed tokens) cover EVERY typed token, and no work candidate has `titleCover` ≥ 0.6. Exactly one person fits:
 * "one" (the runner goes to that person's works); more than one: "several", those that fit, in OpenAlex's order (never
 * a silent choice among them); none: "none" (the entry stays whatever the works search made it).
 * R270 d: a typed single letter is covered by a name token that begins with it ("J. Smith", "P. Bourdieu"); "one"
 * then says `byInitial`, and the runner asks which person is meant even though only one fits.
 */
export function decidePerson(ref: Reference, people: PersonCandidate[], works: WorkCandidate[]): PersonDecision {
  if (!ref.tokens.length) return { kind: "none" };
  if (works.some((c) => scoreCandidate(ref, c).titleCover >= FIND_PEOPLE_TITLE_COVER)) return { kind: "none" };
  // R270 d: a typed single letter (with or without a full stop: "J." is the token "j") is covered by a name token that
  // begins with it. A person who fits only because a typed word matched as an initial is never chosen in silence.
  const isInitial = (t: string) => Array.from(t).length === 1 && /^\p{L}$/u.test(t);
  const fitOf = (p: PersonCandidate): { fits: boolean; byInitial: boolean } => {
    const named = tokensOf(cut(p.name, FIND_PERSON_NAME_MAX));
    const set = new Set(named);
    // R273 M10: a typed single letter is always an initial, whatever the name holds.
    let byInitial = ref.tokens.some(isInitial);
    for (const t of ref.tokens) {
      if (set.has(t)) continue;
      if (isInitial(t) && named.some((n) => n.startsWith(t))) {
        byInitial = true;
        continue;
      }
      return { fits: false, byInitial };
    }
    return { fits: true, byInitial };
  };
  const judged = people.map((p) => ({ p, ...fitOf(p) })).filter((x) => x.fits);
  const fits = judged.map((x) => x.p);
  if (fits.length === 1) return { kind: "one", person: fits[0]!, byInitial: judged[0]!.byInitial };
  if (fits.length > 1) return { kind: "several", people: fits };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------------------------------------------
// Asking OpenAlex

const nowOf = (ctx: LookupContext) => (ctx.clock?.() ?? new Date()).getTime();

/** A search or a filtered list on OpenAlex: paused while the allowance is used up; a 429 that shows it spent pauses it. */
async function askListed(ctx: LookupContext, url: string, cacheKey: string): Promise<{ items: unknown[]; count: number | undefined }> {
  if (openAlexSearchPaused(ctx)) {
    ctx.debug?.("people search via openalex skipped: its free daily allowance is used up");
    throw new FindPeopleError("budget");
  }
  let count: number | undefined;
  const pick = (json: unknown): unknown[] | null => {
    if (!isRecord(json) || !Array.isArray(json.results)) return null;
    const c = isRecord(json.meta) ? json.meta.count : undefined;
    count = typeof c === "number" && Number.isSafeInteger(c) && c >= 0 ? c : undefined;
    return json.results;
  };
  try {
    const items = await fetchItems(ctx, url, { cacheKey, ttlDays: SEARCH_TTL_DAYS, sensitive: isSensitive(ctx), final429: (a) => isOpenAlexBudgetSpent(a, nowOf(ctx)) }, pick);
    return { items: items ?? [], count: items ? count : 0 };
  } catch (e) {
    if (e instanceof LookupHttpError && e.status === 429 && e.rateLimit?.final) {
      pauseOpenAlexSearches(ctx, e.rateLimit.reset);
      ctx.debug?.("people search via openalex paused: its free daily allowance is used up");
      throw new FindPeopleError("budget");
    }
    // The note names an HTTP status only: never the address, the typed words or a person.
    const status = e instanceof LookupHttpError && e.status ? ` (HTTP ${e.status})` : e instanceof BadAnswer ? " (an answer of another shape)" : "";
    ctx.debug?.(`people search via openalex failed${status}`);
    throw new FindPeopleError("failed");
  }
}

/**
 * The people OpenAlex knows by the typed words: ONE request (`authors?search=<text>&per-page=20`), at most 20 people,
 * each checked and bounded; `more` when OpenAlex reports more than 20. Nothing is asked when the project's rules
 * refuse OpenAlex (an empty list). A failure or the allowance used up is FindPeopleError, never an empty list.
 */
export async function searchPeople(ref: Reference, ctx: LookupContext): Promise<{ people: PersonCandidate[]; more: boolean }> {
  if (!providerAllowed(ctx, "openalex")) return { people: [], more: false };
  const { items, count } = await askListed(ctx, peopleSearchUrl(ref.text), `find:openalex:authors:${ref.text}`);
  const people: PersonCandidate[] = [];
  for (const item of items.slice(0, FIND_PEOPLE_MAX)) {
    const p = personOf(item);
    if (p && !people.some((x) => x.id === p.id)) people.push(p);
  }
  // R271 M2: with no count, a full page means more may exist (so the app asks rather than choose in silence).
  const more = count === undefined ? items.length >= FIND_PEOPLE_MAX : count > FIND_PEOPLE_MAX || items.length > FIND_PEOPLE_MAX;
  return { people, more };
}

/**
 * A person's works, newest first: page 1 of 100, and page 2 only when page 1 was full and OpenAlex reports more — at
 * most two requests, at most 200 works, each checked and bounded for choosing (`more` when OpenAlex has more than are
 * kept). `personId` must be `A<digits>` (else InvalidInputError, nothing asked). A page that fails, or the allowance
 * used up before or between the pages, is FindPeopleError: nothing of a half answer is given.
 */
export async function worksOf(personId: string, ctx: LookupContext): Promise<{ works: WorkCandidate[]; more: boolean }> {
  if (!isPersonId(personId)) throw new InvalidInputError("That is not a person's id that OpenAlex gives.");
  if (!providerAllowed(ctx, "openalex")) return { works: [], more: false };
  const first = await askListed(ctx, personWorksUrl(personId, 1), `find:openalex:person-works:${personId}:1`);
  let items = first.items.slice(0, FIND_PERSON_WORKS_PAGE);
  // R271 M2: an answer with no count is taken as "more may exist" when its page is full.
  const count = first.count;
  const firstFull = items.length >= FIND_PERSON_WORKS_PAGE;
  let lastFull = firstFull;
  if (firstFull && (count === undefined || count > FIND_PERSON_WORKS_PAGE)) {
    const second = await askListed(ctx, personWorksUrl(personId, 2), `find:openalex:person-works:${personId}:2`);
    const more = second.items.slice(0, FIND_PERSON_WORKS_PAGE);
    lastFull = more.length >= FIND_PERSON_WORKS_PAGE;
    items = [...items, ...more];
  }
  const works: WorkCandidate[] = [];
  for (const item of items) {
    // One bad item is skipped, never the whole list (R271 M1).
    let w: WorkCandidate | null = null;
    try {
      w = personWorkOf(item);
    } catch {
      w = null;
    }
    if (w && SOURCE_TYPES.includes(w.type) && !works.some((x) => x.id === w.id)) works.push(w);
  }
  // Newest first whatever order they came in (a date or a year; undated last), keeping OpenAlex's order otherwise.
  const kept = works
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (b.w.issued ?? "").localeCompare(a.w.issued ?? "") || a.i - b.i)
    .map((x) => x.w)
    .slice(0, FIND_PERSON_WORKS_MAX);
  return { works: kept, more: count === undefined ? lastFull : count > kept.length };
}

/**
 * One work by its OpenAlex id (`works/<id>`, free of the daily allowance), checked and bounded as a works search's
 * candidate (`openAlexCandidate`), with that id. Null when OpenAlex has no such work; FindPeopleError("failed") when
 * the request fails or the answer is not that work.
 */
export async function fetchWork(workId: string, ctx: LookupContext): Promise<WorkCandidate | null> {
  if (!isWorkId(workId)) throw new InvalidInputError("That is not a work's id that OpenAlex gives.");
  if (!providerAllowed(ctx, "openalex")) return null;
  let found: WorkCandidate | null = null;
  let other = false;
  const check = (body: string) => {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new BadAnswer();
    }
    if (!isRecord(json) || typeof json.id !== "string") throw new BadAnswer();
    // An answer for ANOTHER work (a merged work, say) is not this work: nothing found (R271 M3), never a retry.
    if ((WORK_URI.exec(json.id)?.[1] ?? json.id) !== workId) {
      other = true;
      return;
    }
    // A work with a title; one bad field (a hostile kind, say) never throws out of here (R271 M1).
    try {
      found = openAlexCandidate(json);
    } catch {
      found = null;
    }
    if (!found) throw new BadAnswer();
  };
  try {
    const body = await ctx.http.getText(workUrl(workId), {
      cacheKey: `find:openalex:work:${workId}`,
      ttlDays: SEARCH_TTL_DAYS,
      sensitive: isSensitive(ctx),
      validate: check,
      final429: (a) => isOpenAlexBudgetSpent(a, nowOf(ctx)),
    });
    if (body === null) return null;
    if (!found && !other) check(body);
    if (other) {
      ctx.debug?.("a single work via openalex answered for another work: not found");
      return null;
    }
  } catch (e) {
    // A 429 that shows the daily allowance spent: the wait, as for every OpenAlex request (R271 M3).
    if (e instanceof LookupHttpError && e.status === 429 && e.rateLimit?.final) {
      pauseOpenAlexSearches(ctx, e.rateLimit.reset);
      ctx.debug?.("a single work via openalex: its free daily allowance is used up");
      throw new FindPeopleError("budget");
    }
    const status = e instanceof LookupHttpError && e.status ? ` (HTTP ${e.status})` : e instanceof BadAnswer ? " (an answer of another shape)" : "";
    ctx.debug?.(`a single work via openalex failed${status}`);
    throw new FindPeopleError("failed");
  }
  return { ...(found as unknown as WorkCandidate), id: workId, providers: ["openalex"] };
}

// ---------------------------------------------------------------------------------------------------------------
// What is stored, and the line typed for a work added

function boundPerson(p: PersonCandidate): PersonCandidate {
  const name = cut(p.name, FIND_PERSON_NAME_MAX);
  const affiliation = p.affiliation === undefined ? undefined : cut(p.affiliation, FIND_PERSON_NAME_MAX);
  return { id: p.id, name, ...(affiliation ? { affiliation } : {}), worksCount: p.worksCount, subjects: (p.subjects ?? []).slice(0, FIND_PERSON_SUBJECTS).map((t) => cut(t, FIND_PERSON_SUBJECT_MAX)) };
}

function boundWork(w: WorkCandidate): WorkCandidate {
  const first = w.creators[0];
  const creator = first
    ? first.family
      ? { family: cut(first.family, FIRST_AUTHOR_MAX), role: first.role }
      : first.literal
        ? { literal: cut(first.literal, FIRST_AUTHOR_MAX), role: first.role }
        : undefined
    : undefined;
  const doi = w.identifiers.doi && w.identifiers.doi.length <= FIND_DOI_MAX ? w.identifiers.doi : undefined;
  const container = w.container === undefined ? undefined : cut(w.container, FIND_PERSON_VENUE_MAX);
  return {
    id: w.id,
    title: cut(w.title, FIND_PERSON_TITLE_MAX),
    creators: creator ? [creator] : [],
    ...(w.issued && w.issued.length <= 40 ? { issued: w.issued } : {}),
    type: w.type,
    ...(container ? { container } : {}),
    identifiers: doi ? { doi } : {},
    providers: w.providers.slice(0, 1),
  };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/**
 * An author's entry (people, works) as the queue keeps it, so that its line fits FIND_LINE_MAX_BYTES by construction
 * (A2: the store refuses a longer line and never cuts it). Every person and work is bounded (a name and an affiliation
 * 200, a work's title 300 and where published 100, its first author only); once a person is chosen only that person
 * is kept beside the works (and `morePeople` is dropped). The size is measured as if a reason, a time to try again and
 * both "more" flags were set, so that no later line of this entry can grow past the bound. When it would not fit,
 * fewer works are kept — the newest — and `moreWorks` is set; failing that, fewer people, and `morePeople` is set.
 */
export function fitAuthorEntry(e: FindEntry): FindEntry {
  if (!e.people && !e.works) return e;
  let people = e.people?.slice(0, FIND_PEOPLE_MAX).map(boundPerson);
  const works = e.works?.slice(0, FIND_PERSON_WORKS_MAX).map(boundWork);
  let morePeople = e.morePeople === true || (e.people?.length ?? 0) > FIND_PEOPLE_MAX;
  let moreWorks = e.moreWorks === true || (e.works?.length ?? 0) > FIND_PERSON_WORKS_MAX;
  if (people && e.state !== "choose-person" && e.chosen && people.some((p) => p.id === e.chosen)) {
    // Once a person is chosen only that person is kept, and "more people have this name" is no longer said (R271 M6).
    people = people.filter((p) => p.id === e.chosen);
    morePeople = false;
  }
  const build = (ps: PersonCandidate[] | undefined, n: number, probe: boolean): FindEntry => {
    const out: Record<string, unknown> = { ...e };
    delete out.people;
    delete out.works;
    delete out.morePeople;
    delete out.moreWorks;
    const kept = works?.slice(0, n);
    if (ps) out.people = ps;
    if (kept) out.works = kept;
    if (probe) {
      // Room for what a later line of this entry may add (a reason and a time to try again, R271 M5: no list of
      // works added is stored any more).
      out.reason = { code: "no-legal-basis", by: "settings" };
      out.nextTryAt = "2026-11-14T00:00:00.000Z";
      out.attempts = Number.MAX_SAFE_INTEGER;
      out.morePeople = true;
      out.moreWorks = true;
    } else {
      if (morePeople) out.morePeople = true;
      if (moreWorks || (works && n < works.length)) out.moreWorks = true;
    }
    return out as unknown as FindEntry;
  };
  const fits = (ps: PersonCandidate[] | undefined, n: number) => bytes(build(ps, n, true)) <= FIND_LINE_MAX_BYTES;
  // People first (they must fit with no works), dropping sample titles, then the last people.
  if (people && !fits(people, 0)) {
    people = people.map((p) => ({ ...p, subjects: [] }));
    while (people.length > 1 && !fits(people, 0)) {
      people = people.slice(0, -1);
      morePeople = true;
    }
  }
  // Then as many works as fit, the newest first (a binary search on the count).
  let n = works?.length ?? 0;
  if (works && !fits(people, n)) {
    let lo = 0;
    let hi = works.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(people, mid)) lo = mid;
      else hi = mid - 1;
    }
    n = lo;
  }
  return build(people, n, false);
}

/**
 * The line typed for a work added from a person's list (what the queue shows for that entry): EXACTLY the work's title
 * (cleaned, cut to FIND_PERSON_TITLE_MAX), then ", " and its first author's family name (or whole name when it has no
 * family name; cut to 100) — "The Managed Heart, Hochschild" — or the title alone when it has no author. At most 402
 * characters, so within a typed line's 2–500; a line that would be shorter than 2 characters gets the work's id after it.
 */
/**
 * R271 M4: whether the fresh record of a ticked work (`fresh`, from `works/<id>`) IS the work kept for choosing (`kept`):
 *  - when a DOI was kept, the fresh one has that same DOI;
 *  - the titles' normalised words are the same, whole (R273 I2); only a kept title cut at FIND_PERSON_TITLE_MAX is
 *    compared on its words, without its last word, as the beginning of the fresh title.
 * Otherwise the entry asks ("choose", with that one fresh candidate) and nothing is made by itself.
 */
export function sameWork(kept: WorkCandidate, fresh: WorkCandidate): boolean {
  const keptDoi = kept.identifiers.doi?.toLowerCase();
  if (keptDoi && fresh.identifiers.doi?.toLowerCase() !== keptDoi) return false;
  const words = (s: string) => normalizeTitle(s.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")).split(" ").filter(Boolean);
  const keptTitle = cleanText(kept.title);
  const a = words(keptTitle);
  const b = words(cleanText(fresh.title));
  if (!a.length) return false;
  // R273 I2: whole titles, word for word. Only a kept title that was cut at the stored limit is compared on its words:
  // without its last word (the cut may have split it) it must be the first words of the fresh title.
  if (Array.from(keptTitle).length < FIND_PERSON_TITLE_MAX) return a.length === b.length && a.every((w, i) => w === b[i]);
  const head = a.slice(0, -1);
  return head.length > 0 && head.every((w, i) => w === b[i]);
}

export function childTyped(w: WorkCandidate): string {
  const title = cut(cleanText(w.title), FIND_PERSON_TITLE_MAX);
  const first = w.creators[0];
  const name = first ? cut(cleanText(first.family ?? first.literal ?? ""), FIRST_AUTHOR_MAX) : "";
  let line = name ? `${title}, ${name}` : title;
  if (Array.from(line).length < 2) line = `${line} ${w.id}`.trim();
  return cut(line, TYPED_MAX);
}
