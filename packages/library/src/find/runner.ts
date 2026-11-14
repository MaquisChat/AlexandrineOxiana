/**
 * The runner of Find and acquire (Task F4; fix round 1, R237): takes each typed line through its life.
 *
 *   looking-up ──► choose            (several works fit, or the answer was partial; `choose` picks one, or none)
 *              ──► record-complete   (sure on a complete answer, or chosen: ONE source without a file; final in slice 1)
 *              ──► already           (the same DOI or ISBN is in this project, or — "Check everything I have" —
 *                                     in another unlocked project: `elsewhere: true` and nothing else about it)
 *              ──► maybe-duplicate   (a likely duplicate: `confirmDuplicate` answers it)
 *              ──► not-found         (every service asked answered, and nothing scored)
 *              ──► failed            (the rules or the settings refuse; the services stayed unreachable or the
 *                                     settings did not answer through every retry; or something unexpected
 *                                     happened: reason "unexpected". `retry` starts it afresh)
 *
 * One work, one source, under every race. The duplicate check and the creation run inside the project's store
 * turn (`serialStore`, shared with drag-and-drop, watched folders and Bulk Import), with nothing awaited between
 * them that lets another creation in. The check asks the index (DOI, ISBN and the fuzzy keys) inside that turn and
 * keeps no cache of its own: a source made outside the turn (a browser capture) or changed by an edit is seen, and
 * no entry reads every source record while it holds the turn. Every change an entry makes after a lookup is
 * decided in a turn against the entry as it is then (removed, chosen, retried or stopped meanwhile: left alone).
 *
 * Crash safety. The source made for an entry carries the entry's id in its provenance from its creation
 * (`provenance.externalKeys["find-entry"]`; provenance is immutable). A crash between the creation and the
 * entry's line leaves the entry "looking-up" beside a source that names it: `resume` reads the project's source
 * records once (outside any turn, and only when some entry is "looking-up") and the entry ADOPTS that source —
 * "record-complete" with its id, before any lookup — never a second source and never "Already in your library".
 *
 * The record is stored under the project's own rules, like every other import (R237 a): `identifiable` and the
 * legal basis come from `storeInputs` (category "reference-lookup"); where the rules refuse it, the entry is
 * "failed" by the rules and nothing is created. Making a record is the way of acquiring `reference_lookup`
 * (checked before anything is asked, and again, governed and audited, by the creation itself).
 *
 * Nothing waits for ever (R237 b). Every outside call the runner awaits is under a time limit and is let go at
 * `stop`: the settings (FIND_SETTINGS_TIMEOUT_MS), the lookups (FIND_LOOKUP_TIMEOUT_MS overall, besides the
 * client's own per-attempt limits). The index and `checkEverything()` are synchronous calls (they cannot be left
 * waiting). A call that does not answer in time frees its place and the entry is tried again by the ordinary
 * delays. `stopAll()` settles within FIND_STOP_SETTLE_MS whatever is in flight.
 *
 * When nothing can be written for a project — its rules or its queue cannot be read, or the library is read-only —
 * the runner stops for that project and says so (`stoppedFor`), instead of leaving entries that seem to be looked up.
 */
import {
  EdtfLite,
  SourceDraft,
  evaluate,
  findDuplicate,
  isId,
  newId,
  primary,
  verifyDraft,
  type DupKey,
  type FieldEvidence,
  type Provenance,
} from "@ao/core";
import { findSourceBy, type IndexDb } from "../index/db.js";
import { storeInputs } from "../import/common.js";
import { serialStore } from "../import/project-queue.js";
import { lookupContextFor, providerAllowed, type LookupContext } from "../lookup/context.js";
import type { HttpClient } from "../lookup/http.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError, RecoveryPendingError } from "../repo/errors.js";
import {
  appendFindEntriesIn,
  createSourceRefusing,
  lookupPolicyInfo,
  projectCollectionsAndTags,
  projectPolicy,
  recoveryPendingProjects,
  readFindQueueDetailedIn,
  readFindQueueIn,
  repoLibrary,
  type Repo,
} from "../repo/repo.js";
import { libraryVersion } from "../resources.js";
import type { WorkCandidate } from "./candidates.js";
import { FIND_CHOOSE_WORKS_MAX, FindPeopleError, authorOfferProbe, childTyped, fetchWork, fitAuthorEntry, fitPeople, hasInitial, isPersonId, isWorkId, peopleSearchWanted, sameWork, searchPeople, titleCovered, worksOf, type PersonDecision } from "./people.js";
import { FindQueueUnreadableError, sanitizeEntry } from "./queue-store.js";
import { parseReference, type Reference } from "./reference.js";
import { decideMatch, openAlexSearchPausedUntil, scoreCandidate, searchWorks, type SearchSource } from "./search.js";
import {
  FIND_DOI_MAX,
  FIND_LINE_MAX_BYTES,
  FIND_TYPED_MAX,
  type FindEntry,
  type FindMatch,
  type FindReason,
  type FindReasonCode,
  type FindState,
  type SearchSettings,
} from "./types.js";

/** At most this many entries are worked on at once, for the whole open library. */
export const FIND_CONCURRENCY = 2;
/** After a failure to get an answer the entry is tried again after each of these delays in turn, then it is "failed". */
export const FIND_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];
/** How long the "Search sources" settings may take to answer (a local file: a stall is a fault, retried). */
export const FIND_SETTINGS_TIMEOUT_MS = 5_000;
/**
 * How long one entry's search may take in all, both services together. The lookup client's own limits are 60 s per
 * attempt (30 s for headers and body) and up to 3 retries with back-off; this bounds the whole, however it stalls.
 */
export const FIND_LOOKUP_TIMEOUT_MS = 240_000;
/** `stopAll()` settles within this time (wall clock) whatever is in flight; what is still running then writes nothing. */
export const FIND_STOP_SETTLE_MS = 5_000;
/** While the index cannot be trusted, the runner asks again after this long (one timer, no busy loop). */
export const FIND_INDEX_WAIT_MS = 2_000;
/**
 * At resume, a source made for a waiting entry has an id (UUIDv7, time-ordered) no older than the entry itself: only
 * the source records whose id time is at or after the oldest waiting entry's `createdAt`, less this margin for clock
 * steps, are read (R237 Q8).
 */
export const FIND_ADOPT_MARGIN_MS = 300_000;
/** One Add holds at most this many lines. */
export const FIND_ADD_MAX_LINES = 50;
/** The tool a record made by Find and acquire names in its provenance. */
export const FIND_TOOL = "find-and-acquire";
/** The provenance external key that holds the queue entry's id (set once, at creation). */
export const FIND_ENTRY_KEY = "find-entry";
/** The legal-basis category of a record made from a typed reference (`consent.defaultLegalBasis`), as Bulk Import names its kinds. */
export const FIND_LEGAL_CATEGORY = "reference-lookup";
/** At most this many candidates are kept on an entry. */
const CANDIDATES_KEPT = 10;

const VERSION: string = libraryVersion();

/** The entry is not (or no longer) in the state the action needs. Nothing was changed. */
export class FindEntryStateError extends Error {
  override name = "FindEntryStateError";
  constructor() {
    super("This entry is no longer waiting for that. Nothing was changed.");
  }
}

/** The runner was stopped for good (the library closed). Nothing was changed. */
export class FindRunnerClosedError extends Error {
  override name = "FindRunnerClosedError";
  constructor() {
    super("Find and acquire has stopped for this library. Nothing was changed.");
  }
}

/** The index cannot be trusted yet (still being rebuilt, or a change was not indexed): nothing is created. Nothing was changed. */
export class FindIndexNotReadyError extends Error {
  override name = "FindIndexNotReadyError";
  constructor() {
    super("The library's index is still being prepared. Try again in a moment. Nothing was changed.");
  }
}

/**
 * Find and acquire is stopped for this project now (`stop(projectId)`: its lock, or a stop the runner made itself),
 * so the researcher's act was not carried out (R245). Nothing was changed.
 */
export class FindProjectStoppedError extends Error {
  override name = "FindProjectStoppedError";
  constructor() {
    super("Find and acquire is stopped for this project now. Nothing was changed.");
  }
}

/**
 * Task F8: a person or a work that is not one of THOSE stored on the entry (no request can make the app fetch an
 * arbitrary author or work). Nothing was changed.
 */
export class FindUnknownOptionError extends Error {
  override name = "FindUnknownOptionError";
  constructor(readonly kind: "person" | "work") {
    super(kind === "person" ? "That is not one of the people offered for this entry. Nothing was changed." : "That is not one of the works offered for this entry. Nothing was added.");
  }
}

/** Task F8b (R279 c): `asAuthor` on an entry that is not in "choose" with an author offer. Nothing was changed. */
export class FindNoAuthorError extends Error {
  override name = "FindNoAuthorError";
  constructor() {
    super("This entry has no author to show.");
  }
}

/** Task F8: a work already added from this entry, named by its position in the request only. Nothing was added. */
export class FindAlreadyAddedError extends Error {
  override name = "FindAlreadyAddedError";
  constructor(readonly position: number) {
    super(`Work ${position} was already added from this entry. Nothing was added.`);
  }
}

/**
 * Test seams (R47: honoured only under NODE_ENV=test): run just before and just after a record's creation; `inAct`,
 * awaited inside a researcher's act, in its store turn, right after its check (R245); and `inCreate`, awaited inside
 * the store turn just before a record is made (R247 d).
 */
export const runnerSeams: { beforeCreate?: () => void; afterCreate?: () => void; inAct?: () => Promise<void>; inCreate?: () => Promise<void> } = {};
const seam = (f: (() => void) | undefined) => {
  if (f && process.env.NODE_ENV === "test") f();
};

export interface FindTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FindRunnerDeps {
  repo: Repo;
  index: IndexDb;
  http: HttpClient;
  /**
   * The "Search sources" settings (F12: `search-sources.json`, read by the service), asked when each entry's work
   * starts: a save takes effect for the next entry, and an entry already at work finishes under what it started with.
   */
  settings: () => Promise<SearchSettings>;
  /**
   * F12 (R290 c): Elicit's key from the password store, or undefined when none is stored. Asked only when Elicit is
   * on in the settings AND the project's rules allow it (never for a source that is off); without it Elicit is not
   * asked. Absent: Elicit is never asked.
   */
  elicitKey?: () => Promise<string | undefined>;
  /** "Check everything I have": a match in another unlocked project counts. */
  checkEverything: () => boolean;
  now?: () => Date;
  onChange(e: { projectId: string; entryId: string; state: FindState }): void;
  /** Beyond the plan's Interfaces: the timers of the retries and time limits (default: the process's, unref'd). */
  timers?: FindTimers;
  /** Beyond the plan's Interfaces: short notes (error kinds only; never what was typed, never an error's text). */
  debug?: (note: string) => void;
  /**
   * Whether the index can be trusted for the duplicate check (default: always). While false the runner starts no
   * entry and creates nothing; it asks again every FIND_INDEX_WAIT_MS and goes on by itself.
   */
  indexReady?: () => boolean;
}

/** Why the runner does nothing for a project now. */
export type FindStoppedFor = {
  code: "rules-unreadable" | "queue-unreadable" | "read-only" | "recovery-pending" | "unexpected" | "index-not-ready";
};

export interface FindRunner {
  /**
   * Adds the lines as entries. Like every act of the researcher (choose, confirmDuplicate, addHereAsWell, retry,
   * remove), it is refused and writes nothing once `stopAll()` (FindRunnerClosedError) or `stop(projectId)`
   * (FindProjectStoppedError, until `resume`) has been called, whatever it was waiting on (R245, replacing M1).
   */
  add(projectId: string, lines: string[], collectionId?: string): Promise<{ added: FindEntry[]; mergedLines: number }>;
  /** The researcher's choice; it makes the record now, in the press's own turn (refused after `stop` or `stopAll`, R245). */
  choose(projectId: string, entryId: string, candidateId: string | null): Promise<FindEntry>;
  confirmDuplicate(projectId: string, entryId: string, same: boolean): Promise<FindEntry>;
  addHereAsWell(projectId: string, entryId: string): Promise<FindEntry>;
  /** Writes the entry back to "looking-up" (refused after `stop` or `stopAll`, R245). */
  retry(projectId: string, entryId: string): Promise<FindEntry>;
  /**
   * Task F8: the researcher's person, for an entry in "choose-person" only; `personId` must be one of THAT entry's
   * people (else FindUnknownOptionError; not `A<digits>`: InvalidInputError). The entry is written "looking-up" with
   * that person (`chosen`) at once; the runner then fetches the person's works and makes it "choose-works" (a failure
   * or the spent allowance: the ordinary retries, or the wait). A second press, or one on another state:
   * FindEntryStateError. Nothing is asked in the press itself.
   */
  choosePerson(projectId: string, entryId: string, personId: string): Promise<FindEntry>;
  /**
   * Task F8 (R267): for an entry in "choose-works" only; 1 to 50 ids, each one of THAT entry's works (else
   * FindUnknownOptionError; not `W<digits>`: InvalidInputError) and not already added from it (FindAlreadyAddedError
   * with its position); a repeated id counts once. Each becomes a NEW entry ("looking-up", `parentId`, `chosen` = the
   * work id, the typed line `childTyped`), written in ONE governed change with the parent's own new line (`added`);
   * a full queue refuses the whole (FindQueueFullError). The parent STAYS "choose-works". Each new entry's record is
   * then made from a fresh request for that one work by its id, through the duplicate check, as a chosen candidate.
   */
  chooseWorks(projectId: string, entryId: string, workIds: string[]): Promise<{ added: FindEntry[]; parent: FindEntry }>;
  /**
   * Task F8b (R279 c): for an entry in "choose" that carries an author offer (people stored beside its candidates)
   * only — else FindNoAuthorError, nothing changed. Turns it into the author's flow with the people ALREADY stored (no
   * new people search), its work candidates dropped in the same one governed write: "choose-person" when more than one
   * person is stored, a single letter was typed (an initial), or more people exist than are stored; otherwise
   * "looking-up" with that one person chosen, whose works the runner then fetches (as after `choosePerson`) to make it
   * "choose-works". Refused after `stop` or `stopAll` (R245).
   */
  asAuthor(projectId: string, entryId: string): Promise<FindEntry>;
  remove(projectId: string, entryId: string): Promise<void>;
  /** At open and unlock: clears `stoppedFor`, and restarts every "looking-up" entry (nothing else). */
  resume(projectId: string): void;
  /** At lock (together with the lock) or close: nothing more is written for the project; its work in flight is let go. */
  stop(projectId: string): void;
  /** At close: settles within FIND_STOP_SETTLE_MS whatever is in flight, acts already inside their turn included (R245). */
  stopAll(): Promise<void>;
  elsewhere(projectId: string, entryId: string): Promise<{ projectId: string; sourceId: string } | null>;
  /** How many projects of the open library are locked and so were not looked into: 0 while "Check everything I have" is off. */
  lockedNotChecked(): number;
  /** Why nothing is being done for the project now, or null. */
  stoppedFor(projectId: string): FindStoppedFor | null;
}

/**
 * The project's queue as it stands (for the service's GET, F5): the live entries, and how many lines could not be
 * read. A queue none of whose lines can be read is `FindQueueUnreadableError`; a locked project `ProjectLockedError`.
 */
export function readFindQueueOf(repo: Repo, projectId: string): Promise<{ entries: Map<string, FindEntry>; unreadableLines: number }> {
  return readFindQueueDetailedIn(repo, projectId);
}

type Existing = DupKey & { sourceId: string };

interface Run {
  gen: number;
  stopped: boolean;
  stopSignal: Promise<void>;
  signalStop: () => void;
  pending: string[];
  timers: Map<string, unknown>;
  /** When this project was last given a place (fairness: the one served longest ago goes first). */
  served: number;
  /** Entry → a source made for it, found by `resume` in the project's source records (crash recovery). */
  adoptable: Map<string, string>;
}

/** The run was stopped (or the project's generation moved on) while waiting: nothing more is done. */
class Abandoned extends Error {}
/** An outside call did not answer within its time limit. */
class TimedOut extends Error {}
class CollectionGone extends Error {}

/** A new entry from `e`: its fields without those in `drop`, then `patch` (keys it sets to undefined are left out). */
function evolve(e: FindEntry, patch: Partial<FindEntry>, drop: Array<keyof FindEntry>, at: string): FindEntry {
  const out: Record<string, unknown> = { ...e };
  for (const k of drop) delete out[k];
  Object.assign(out, patch, { updatedAt: at });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as FindEntry;
}

const sameVersion = (a: FindEntry, b: FindEntry) => a.state === b.state && a.updatedAt === b.updatedAt && a.attempts === b.attempts;

/** A candidate within what the queue keeps (the store's bounds): fields the store would refuse are left out. */
function boundCandidate(c: WorkCandidate): WorkCandidate {
  const isbn = (c.identifiers.isbn ?? []).filter((i) => i.length <= 20).slice(0, 20);
  const doi = c.identifiers.doi && c.identifiers.doi.length <= FIND_DOI_MAX ? c.identifiers.doi : undefined;
  const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length <= n ? s : undefined);
  const out: WorkCandidate = {
    id: c.id.slice(0, 200),
    title: c.title.slice(0, 1000),
    creators: c.creators.slice(0, 100).map((x) => {
      const y: Record<string, unknown> = { role: x.role };
      for (const k of ["family", "given", "literal", "handle"] as const) if (x[k] !== undefined) y[k] = x[k]!.slice(0, 200);
      return y as WorkCandidate["creators"][number];
    }),
    type: c.type,
    identifiers: { ...(doi ? { doi } : {}), ...(isbn.length ? { isbn } : {}) },
    providers: c.providers.filter((p) => p.length <= 40).slice(0, 10),
  };
  const issued = cut(c.issued, 40);
  const container = cut(c.container, 1000);
  const publisher = cut(c.publisher, 1000);
  return { ...out, ...(issued ? { issued } : {}), ...(container ? { container } : {}), ...(publisher ? { publisher } : {}) };
}

/**
 * The entry as the store will take it: candidates bounded (at most 10), and, if the line would be over 64 KiB, the
 * least likely candidates (never the chosen one) dropped, then names cut down, so the store never refuses a size the
 * runner could have known.
 */
function fit(given: FindEntry): FindEntry {
  // F8b (R279 c): an entry asking among works that also carries an author offer (people beside its candidates): the
  // candidates are fitted first, leaving room for at least one person (`authorOfferProbe`), then the people that fit.
  const offer = !!given.people?.length && !!given.candidates && !given.works;
  // An author's entry (F8): its people and works bounded so that the line fits by construction.
  const e = (given.people || given.works) && !offer ? fitAuthorEntry(given) : given;
  if (!e.candidates) return e;
  let candidates = e.candidates.slice(0, CANDIDATES_KEPT).map(boundCandidate);
  const base = offer ? authorOfferProbe(e) : e;
  const size = (cs: WorkCandidate[]) => Buffer.byteLength(JSON.stringify({ ...base, candidates: cs }), "utf8");
  while (size(candidates) > FIND_LINE_MAX_BYTES && candidates.length > 1) {
    const i = candidates.map((c) => c.id !== e.chosen).lastIndexOf(true);
    candidates = candidates.filter((_, j) => j !== (i < 0 ? candidates.length - 1 : i));
  }
  if (size(candidates) > FIND_LINE_MAX_BYTES) candidates = candidates.map((c) => ({ ...c, creators: c.creators.slice(0, 10) }));
  const out = offer ? fitAuthorEntry({ ...e, candidates }) : { ...e, candidates };
  return sanitizeEntry(out) ? out : evolve(out, {}, ["candidates"], e.updatedAt);
}

/**
 * R285 b: whether an entry in "choose" carrying an author offer keeps at least one work candidate once fitted for the
 * store. When it would not, the offer is never made: the entry goes to the author's flow instead (never "choose" with
 * an offer and nothing to choose).
 */
export function offerLeavesAChoice(e: FindEntry): boolean {
  return (fit(e).candidates?.length ?? 0) > 0;
}

/** The duplicate keys of a work candidate. */
function keyOf(c: WorkCandidate): DupKey {
  const first = c.creators[0];
  const family = first?.family ?? first?.literal;
  return {
    sha256s: [],
    ...(c.identifiers.doi ? { doi: c.identifiers.doi } : {}),
    ...(c.identifiers.isbn?.length ? { isbns: c.identifiers.isbn } : {}),
    title: c.title,
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(c.issued ? { year: c.issued.slice(0, 4) } : {}),
  };
}

/** The source draft for a chosen or sure candidate (its fields are already mapped by F2 through mapCrossref/mapOpenAlex). */
function draftFor(c: WorkCandidate, collectionIds: string[]): SourceDraft {
  const mt = (value: string) => ({ variants: [{ lang: "und", kind: "original" as const, value }] });
  const issued = c.issued && EdtfLite.safeParse(c.issued).success ? c.issued : undefined;
  return SourceDraft.parse({
    projectIds: [],
    caseAttributes: {},
    collectionIds,
    tagIds: [],
    participantIds: [],
    type: c.type,
    title: mt(c.title),
    creators: c.creators,
    ...(c.container ? { container: mt(c.container) } : {}),
    ...(c.publisher ? { publisher: c.publisher } : {}),
    ...(issued ? { issued } : {}),
    identifiers: { ...(c.identifiers.doi ? { doi: c.identifiers.doi } : {}), ...(c.identifiers.isbn?.length ? { isbn: c.identifiers.isbn } : {}) },
  });
}

/** Per-field evidence naming the service: the first service that gave the candidate (its values win when F2 merges). */
function evidenceFor(draft: SourceDraft, c: WorkCandidate, at: string): FieldEvidence[] {
  const source = { kind: "lookup" as const, provider: c.providers[0] ?? "lookup" };
  const out: FieldEvidence[] = [];
  const add = (field: string, value: unknown) => out.push({ field, value, source, at });
  add("/title", primary(draft.title));
  if (draft.creators.length) add("/creators", draft.creators);
  if (draft.issued) add("/issued", draft.issued);
  if (draft.container) add("/container", primary(draft.container));
  if (draft.publisher) add("/publisher", draft.publisher);
  if (draft.identifiers.doi) add("/identifiers/doi", draft.identifiers.doi);
  if (draft.identifiers.isbn?.length) add("/identifiers/isbn", draft.identifiers.isbn);
  add("/type", draft.type);
  return out;
}

/** The match an entry already carries, or (an entry written before R237) the rule's score again. */
function matchOf(e: FindEntry, cand: WorkCandidate): FindMatch {
  if (e.match) return e.match;
  const ref = parseReference(e.typed);
  return { method: "find-match", confidence: ref ? scoreCandidate(ref, cand).score : 0 };
}

/**
 * Task F8: the OpenAlex work an entry was made from, when it was made from an author's entry (`parentId`): its `work`
 * (or, on a line written before R271, its `chosen` if that is a work's id).
 */
function workOfAdded(e: FindEntry): string | undefined {
  if (e.parentId === undefined) return undefined;
  if (isWorkId(e.work)) return e.work;
  return isWorkId(e.chosen) ? e.chosen : undefined;
}

/**
 * R271 M5: the works counted as added from the author's entry `parentId` — those of the LIVE entries made from it
 * (`readFindQueue` gives live entries only). Worked out at each use, never stored: an entry the researcher removed
 * frees its work to be added again. Used by `chooseWorks`, and by the service for `addedCount` and `options`.
 */
export function worksAddedFrom(entries: Iterable<FindEntry>, parentId: string): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.parentId !== parentId || e.removed) continue;
    const w = workOfAdded(e);
    if (w) out.add(w);
  }
  return out;
}

/** The time (ms since the epoch) a UUIDv7 was made: its first 48 bits. */
const idTime = (id: string): number => parseInt(id.replace(/-/gu, "").slice(0, 12), 16);

const errName = (err: unknown) => (err instanceof Error ? err.name : "error");

export function createFindRunner(deps: FindRunnerDeps): FindRunner {
  const { repo, http } = deps;
  const now = () => deps.now?.() ?? new Date();
  const debug = (n: string) => {
    try {
      deps.debug?.(n);
    } catch {
      // a listener's error never stops the runner
    }
  };
  const timers: FindTimers = deps.timers ?? {
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  let closed = false;
  let active = 0;
  let serveSeq = 0;
  const runs = new Map<string, Run>();
  const running = new Set<string>();
  const inflight = new Set<Promise<void>>();
  /**
   * What is inside a store turn now: a researcher's act past its check, an add writing its entries, the runner's own
   * work that has started its turn (R247 d). `stopAll` waits for these without a time limit, like every governed write
   * (they do no network); the FIND_STOP_SETTLE_MS bound is for what the runner does outside a turn.
   */
  const inTurnNow = new Set<Promise<void>>();
  function holdUntilDone<T>(p: Promise<T>): Promise<T> {
    const done = p.then(
      () => undefined,
      () => undefined,
    );
    inTurnNow.add(done);
    void done.finally(() => inTurnNow.delete(done));
    return p;
  }
  /** Entry → the source this runner made for it whose entry line is not written yet (adopted, never made twice). */
  const madeHere = new Map<string, string>();
  /** Projects for which nothing can be written now (cleared by `resume`). */
  const blocked = new Map<string, FindStoppedFor>();

  const readOnly = () => repoLibrary(repo).mode !== "read-write";
  /** Whether the index can be trusted for the duplicate check (a throw counts as not ready: fail closed). */
  const indexReady = () => {
    try {
      return deps.indexReady ? deps.indexReady() : true;
    } catch {
      return false;
    }
  };
  /** The one timer that asks again whether the index is ready (no busy loop). */
  let indexWait: unknown;
  function waitForIndex(): void {
    if (indexWait !== undefined || closed) return;
    indexWait = timers.setTimeout(() => {
      indexWait = undefined;
      pump();
    }, FIND_INDEX_WAIT_MS);
  }
  const keyOfRun = (pid: string, eid: string) => `${pid}\u0000${eid}`;

  function freshRun(): Run {
    let signalStop!: () => void;
    const stopSignal = new Promise<void>((r) => (signalStop = r));
    return { gen: 0, stopped: false, stopSignal, signalStop, pending: [], timers: new Map(), served: -1, adoptable: new Map() };
  }
  function runOf(pid: string): Run {
    let r = runs.get(pid);
    if (!r) {
      r = freshRun();
      runs.set(pid, r);
    }
    return r;
  }
  const alive = (pid: string, gen: number) => {
    const r = runs.get(pid);
    return !closed && !!r && !r.stopped && r.gen === gen;
  };

  function stopRun(pid: string): void {
    const r = runOf(pid);
    r.gen++;
    r.stopped = true;
    r.signalStop();
    r.pending = [];
    for (const h of r.timers.values()) timers.clearTimeout(h);
    r.timers.clear();
  }

  /** Nothing can be written for the project: the runner stops for it and says so. */
  function block(pid: string, code: FindStoppedFor["code"]): void {
    blocked.set(pid, { code });
    stopRun(pid);
  }

  /**
   * `p`, unless the run is stopped first (Abandoned) or `ms` passes first (TimedOut). What `p` does later is not
   * acted on. Nothing of the race is left behind: its timer is cleared.
   */
  function guard<T>(r: Run, p: Promise<T>, ms?: number): Promise<T> {
    p.catch(() => {});
    let h: unknown;
    const races: Array<Promise<T>> = [
      p,
      r.stopSignal.then(() => {
        throw new Abandoned();
      }),
    ];
    if (ms !== undefined) races.push(new Promise<T>((_, reject) => (h = timers.setTimeout(() => reject(new TimedOut()), ms))));
    return Promise.race(races).finally(() => {
      if (h !== undefined) timers.clearTimeout(h);
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Scheduling: at most FIND_CONCURRENCY at once; the project served longest ago first.

  function enqueue(pid: string, eid: string): void {
    const r = runOf(pid);
    if (closed || r.stopped) return;
    if (!r.pending.includes(eid)) r.pending.push(eid);
    pump();
  }

  function pump(): void {
    if (closed) return;
    if (!indexReady()) {
      // Entries wait (they stay "looking-up"); the runner asks again after FIND_INDEX_WAIT_MS.
      if ([...runs.values()].some((r) => !r.stopped && r.pending.length > 0)) waitForIndex();
      return;
    }
    while (!closed && active < FIND_CONCURRENCY) {
      let pick: { pid: string; r: Run; idx: number } | undefined;
      for (const [pid, r] of runs) {
        if (r.stopped || !r.pending.length) continue;
        const idx = r.pending.findIndex((e) => !running.has(keyOfRun(pid, e)));
        if (idx < 0) continue;
        if (!pick || r.served < pick.r.served) pick = { pid, r, idx };
      }
      if (!pick) return;
      const eid = pick.r.pending.splice(pick.idx, 1)[0]!;
      pick.r.served = ++serveSeq;
      start(pick.pid, eid, pick.r.gen);
    }
  }

  function start(pid: string, eid: string, gen: number): void {
    const k = keyOfRun(pid, eid);
    active++;
    running.add(k);
    const p = work(pid, eid, gen)
      .catch((err: unknown) => debug(`find: an entry's work ended unexpectedly (${errName(err)})`))
      .finally(() => {
        active--;
        running.delete(k);
        inflight.delete(p);
        pump();
      });
    inflight.add(p);
  }

  function later(pid: string, eid: string, at: string): void {
    const r = runOf(pid);
    if (r.stopped) return;
    const old = r.timers.get(eid);
    if (old !== undefined) timers.clearTimeout(old);
    const ms = Math.max(0, Date.parse(at) - now().getTime());
    const h = timers.setTimeout(() => {
      r.timers.delete(eid);
      enqueue(pid, eid);
    }, ms);
    r.timers.set(eid, h);
  }
  function cancelLater(pid: string, eid: string): void {
    const r = runs.get(pid);
    const h = r?.timers.get(eid);
    if (h !== undefined) {
      timers.clearTimeout(h);
      r!.timers.delete(eid);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Writing an entry: one governed change, then the event.

  /** `alongside` (with an add only, F8): new lines of live entries written in the same governed change; returned after `next`. */
  async function write(pid: string, next: FindEntry[], op: "add" | "update" | "remove", alongside: FindEntry[] = []): Promise<FindEntry[]> {
    const fitted = [...next.map(fit), ...alongside.map(fit)];
    await appendFindEntriesIn(repo, pid, fitted.slice(0, next.length), op, fitted.slice(next.length));
    if (op !== "remove") {
      for (const e of fitted) {
        if (e.state !== "looking-up") madeHere.delete(e.id);
        try {
          deps.onChange({ projectId: pid, entryId: e.id, state: e.state });
        } catch {
          // a listener's error never undoes a committed change
        }
      }
    }
    return fitted;
  }
  const stamp = () => now().toISOString();

  async function current(pid: string, eid: string): Promise<FindEntry | undefined> {
    return (await readFindQueueIn(repo, pid)).get(eid);
  }

  /** The project's store turn (shared with every import into the project). */
  function turn<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    return serialStore(repo, pid, fn);
  }

  /**
   * A researcher's act in the project's store turn (R245). INSIDE the turn and before anything is written it checks
   * that the runner is not closed (`stopAll`) and the project not stopped (`stop`, or a stop the runner made itself):
   * whatever the act waited on, after either has been called it writes nothing and is refused. An act that has passed
   * its check is finished, and `stopAll` waits for it without a time limit (R247 d: it does no network).
   */
  function act<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    return turn(pid, async () => {
      if (closed) throw new FindRunnerClosedError();
      if (runs.get(pid)?.stopped) throw new FindProjectStoppedError();
      return holdUntilDone(
        (async () => {
          if (runnerSeams.inAct && process.env.NODE_ENV === "test") await runnerSeams.inAct();
          return fn();
        })(),
      );
    });
  }

  /**
   * The runner's own work in a store turn. While it WAITS for the turn (behind an import, say) a stop lets it go at
   * once, and when the turn comes it does nothing; once it has STARTED it is awaited to its end (internal and finite:
   * it checks the generation before every write), so that `stopAll` never returns while a write is under way.
   */
  async function inTurn<T>(r: Run, pid: string, live: () => boolean, fn: () => Promise<T>): Promise<T | undefined> {
    let started = false;
    const p = turn(pid, async () => {
      started = true;
      return holdUntilDone(live() ? fn() : Promise.resolve(undefined));
    });
    p.catch(() => {});
    try {
      return await guard(r, p);
    } catch (err) {
      if (err instanceof Abandoned && started) return await p;
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Duplicates: asked of the index inside the store turn (it is updated by every committed change before that
  // change returns, R30: an encrypted project's keys only while it is unlocked).

  type Row = { id: string; projectId: string; locked: boolean };
  function indexRows(key: DupKey): Row[] {
    const out: Row[] = [];
    if (key.doi) out.push(...findSourceBy(deps.index, { doi: key.doi }));
    for (const i of key.isbns ?? []) out.push(...findSourceBy(deps.index, { isbn: i }));
    return out;
  }

  /** The fuzzy keys (title, first family name, year ±1) of a project's indexed sources. */
  function fuzzyRows(projectId: string, key: DupKey): Existing[] {
    const y = key.year && /^\d{4}$/u.test(key.year) ? Number(key.year) : null;
    if (!key.title || !key.firstCreatorFamily || y === null) return [];
    const years = [String(y - 1), String(y), String(y + 1)];
    const rows = deps.index
      .prepare(
        `SELECT id, title, creators_text, issued_year, doi FROM main.sources WHERE project_id = ? AND locked = 0 AND issued_year IN (?,?,?)
         UNION ALL SELECT id, title, creators_text, issued_year, doi FROM temp.t_sources WHERE project_id = ? AND issued_year IN (?,?,?)`,
      )
      .all(projectId, ...years, projectId, ...years) as Array<{ id: string; title: string; creators_text: string; issued_year: string | null; doi: string | null }>;
    return rows
      .filter((r) => r.title)
      .map((r) => {
        const family = r.creators_text.split(";")[0]!.split(",")[0]!.trim();
        return {
          sourceId: r.id,
          sha256s: [],
          title: r.title,
          ...(family ? { firstCreatorFamily: family } : {}),
          ...(r.issued_year ? { year: r.issued_year } : {}),
          ...(r.doi ? { doi: r.doi } : {}),
        };
      });
  }

  const liveIds = (projectId: string): Set<string> => {
    try {
      return new Set(repo.listSourceIds(projectId));
    } catch {
      return new Set();
    }
  };

  /** A duplicate in this project (inside the turn). Certain: the same DOI or ISBN; likely: the fuzzy rule. */
  function matchHere(pid: string, key: DupKey): { sourceId: string; certainty: "certain" | "likely" } | null {
    const live = liveIds(pid);
    for (const row of indexRows(key)) if (row.projectId === pid && live.has(row.id)) return { sourceId: row.id, certainty: "certain" };
    const dup = findDuplicate(key, fuzzyRows(pid, key).filter((e) => live.has(e.sourceId)));
    return dup ? { sourceId: dup.sourceId, certainty: dup.certainty } : null;
  }

  /** Other projects of the open library that can be looked into now (unlocked), and how many are locked. */
  function otherProjects(pid: string | null): { open: string[]; locked: number } {
    const open: string[] = [];
    let locked = 0;
    for (const p of repo.listProjects()) {
      if (p.id === pid) continue;
      if (repo.isUnlocked(p.id)) open.push(p.id);
      else locked++;
    }
    return { open, locked };
  }

  /**
   * A match in another unlocked project (certain: the same DOI or ISBN through the index; likely: the fuzzy rule
   * over the index's titles). Ids only, and only ever returned, never written here.
   */
  function matchElsewhere(pid: string, key: DupKey, likely: boolean): { projectId: string; sourceId: string; certainty: "certain" | "likely" } | null {
    const { open } = otherProjects(pid);
    const openSet = new Set(open);
    for (const row of indexRows(key)) {
      if (row.projectId !== pid && openSet.has(row.projectId) && !row.locked && liveIds(row.projectId).has(row.id)) {
        return { projectId: row.projectId, sourceId: row.id, certainty: "certain" };
      }
    }
    if (!likely) return null;
    for (const projectId of open) {
      const live = liveIds(projectId);
      const dup = findDuplicate(key, fuzzyRows(projectId, key).filter((e) => live.has(e.sourceId)));
      if (dup) return { projectId, sourceId: dup.sourceId, certainty: dup.certainty };
    }
    return null;
  }

  /** A source made for this entry and not yet on its line (this run's creations, and those `resume` found), if it still exists. */
  function madeFor(pid: string, eid: string): string | undefined {
    const live = liveIds(pid);
    const here = madeHere.get(eid);
    if (here && live.has(here)) return here;
    const found = runs.get(pid)?.adoptable.get(eid);
    return found && live.has(found) ? found : undefined;
  }

  // ------------------------------------------------------------------------------------------------------------
  // The rules

  /** Whether the project's rules allow making a record from a reference. */
  function acquireAllowed(ctx: LookupContext): boolean {
    if (!ctx.policy) return false;
    const d = evaluate(ctx.policy, {
      action: "capture",
      projectId: ctx.projectId,
      actor: ctx.actor,
      now: (ctx.clock?.() ?? new Date()).toISOString(),
      ...(ctx.tz ? { tz: ctx.tz } : {}),
      capture: { method: "reference_lookup" },
    });
    return d.result !== "deny";
  }

  const RULES: FindReason = { code: "not-allowed", by: "rules" };
  const NO_LEGAL_BASIS: FindReason = { code: "no-legal-basis", by: "rules" };

  /**
   * Why the engine refused the record (N1). Told apart by what the engine itself decides, never by its sentence:
   * the refusal is the missing legal basis when it refused the STORE of identifiable data with no basis recorded,
   * and the same store WITH a basis would not be refused.
   */
  async function refusalOf(pid: string, err: PolicyDeniedError, store: { identifiable: boolean; legalBasis?: string }): Promise<FindReason> {
    if (err.action !== "store" || !store.identifiable || store.legalBasis) return RULES;
    const info = await lookupPolicyInfo(repo, pid);
    if (!info.policy) return RULES;
    const base = { action: "store" as const, projectId: pid, actor: info.actor, now: info.clock().toISOString(), ...(info.tz ? { tz: info.tz } : {}) };
    const without = evaluate(info.policy, { ...base, store: { identifiable: true, hasLocation: false } });
    const withBasis = evaluate(info.policy, { ...base, store: { identifiable: true, hasLocation: false, legalBasis: "a recorded basis" } });
    return without.result === "deny" && withBasis.result !== "deny" ? NO_LEGAL_BASIS : RULES;
  }
  const SETTINGS: FindReason = { code: "switched-off", by: "settings" };
  /** R297 a: the only record source switched on and allowed needs a key that is not saved (Elicit). */
  const NEEDS_KEY: FindReason = { code: "needs-key", by: "settings" };

  // ------------------------------------------------------------------------------------------------------------
  // Completing an entry with a candidate: the duplicate check and the creation in one store turn.

  interface CompleteOpts {
    match: FindMatch;
    /** F8: the candidate is a fresh record that replaces the entry's candidates. */
    fresh?: boolean;
    /** The entry must be as this says (else nothing is done and null returned). */
    expect: (e: FindEntry) => boolean;
    /** A likely duplicate does not stop it (the researcher said it is not the same work). */
    skipLikely?: boolean;
    /** Another project's match does not stop it ("Add it to this project as well"). */
    skipElsewhere?: boolean;
    /** The work stops being acted on when this is false (the runner's own work: the project's generation). */
    live?: () => boolean;
  }

  /** Inside a turn. Returns the entry as written, or null when the entry was not as expected (nothing written). */
  async function completeIn(pid: string, eid: string, given: WorkCandidate, o: CompleteOpts): Promise<FindEntry | null> {
    const live = o.live ?? (() => !closed);
    if (!live()) return null;
    const cur = await current(pid, eid);
    if (!cur || !o.expect(cur)) return null;
    // The candidate as the queue keeps it: what is checked, stored and made is one and the same (M2).
    const cand = boundCandidate(given);
    const at = stamp();
    // A work added from an author's entry (F8) keeps its fresh record as its one candidate: anything made from it later
    // (a duplicate answered, "add it here as well") is made from the fresh record, never from the line kept for choosing.
    const keep = { candidates: !o.fresh && cur.candidates?.some((c) => c.id === cand.id) ? cur.candidates : [cand], chosen: cand.id, match: o.match };
    // Once the record is made, its entry's line is written whatever happened meanwhile (`force`): a stop or a close
    // waits for this turn (R247 d), and a lock in between is healed at `resume` (R247 e).
    const settle = async (patch: Partial<FindEntry>, drop: Array<keyof FindEntry> = [], force = false) => {
      if (!force && !live()) return null;
      // F8b: an author offer the entry carried goes in this same write (a work was taken, R279 c).
      const [w] = await write(pid, [evolve(cur, { ...keep, ...patch }, ["reason", "nextTryAt", "people", "morePeople", ...drop], at)], "update");
      return w!;
    };

    // A source made for this entry already (a crash or a stop after its creation): adopted, never made twice.
    const adopted = madeFor(pid, eid);
    if (adopted) return settle({ state: "record-complete", sourceId: adopted }, ["duplicateOf", "elsewhere"]);
    // No duplicate check, and so no creation, on an index that cannot be trusted (N4).
    if (!indexReady()) throw new FindIndexNotReadyError();

    const key = keyOf(cand);
    const dup = matchHere(pid, key);
    if (dup?.certainty === "certain") return settle({ state: "already", duplicateOf: dup.sourceId }, ["sourceId", "elsewhere"]);
    if (dup && !o.skipLikely) return settle({ state: "maybe-duplicate", duplicateOf: dup.sourceId }, ["sourceId", "elsewhere"]);
    if (!o.skipElsewhere && deps.checkEverything()) {
      const m = matchElsewhere(pid, key, !o.skipLikely);
      if (m?.certainty === "certain") return settle({ state: "already", elsewhere: true }, ["sourceId", "duplicateOf"]);
      if (m) return settle({ state: "maybe-duplicate", elsewhere: true }, ["sourceId", "duplicateOf"]);
    }
    if (!live()) return null;

    // The record: one source without a file, in one governed change (capture `reference_lookup` and store,
    // evaluated and audited as `source.create`), under the project's own rules like every other import (R237 a).
    // Its provenance names this entry from its creation.
    if (runnerSeams.inCreate && process.env.NODE_ENV === "test") await runnerSeams.inCreate();
    const { identifiable, legalBasis } = await storeInputs(repo, pid, FIND_LEGAL_CATEGORY, deps.debug);
    const provenance: Provenance = {
      captureMethod: "reference_lookup",
      capturedAt: at,
      tool: { name: FIND_TOOL, version: VERSION },
      fileHashes: {},
      identification: { method: o.match.method, confidence: o.match.confidence },
      externalKeys: { [FIND_ENTRY_KEY]: eid },
      legal: { status: "unknown", ...(legalBasis ? { basis: legalBasis } : {}) },
      identifiable,
    };
    const create = (collectionIds: string[], check?: () => Promise<void>) => {
      const draft = draftFor(cand, collectionIds);
      const fieldEvidence = evidenceFor(draft, cand, at);
      const report = verifyDraft(draft, fieldEvidence, {});
      return createSourceRefusing(repo, pid, draft, [], { provenance, fieldEvidence, verification: report.fields }, () => undefined, check ? async () => check() : undefined);
    };
    let collectionGone = false;
    let sourceId: string;
    try {
      seam(runnerSeams.beforeCreate);
      const wanted = cur.collectionId;
      const exists = async () => !!wanted && (await projectCollectionsAndTags(repo, pid)).collections.some((c) => c.id === wanted);
      if (!wanted) sourceId = (await create([])).source.id;
      else if (!(await exists())) {
        collectionGone = true;
        sourceId = (await create([])).source.id;
      } else {
        try {
          sourceId = (
            await create([wanted], async () => {
              if (!(await exists())) throw new CollectionGone();
            })
          ).source.id;
        } catch (err) {
          if (!(err instanceof CollectionGone)) throw err;
          collectionGone = true;
          sourceId = (await create([])).source.id;
        }
      }
    } catch (err) {
      if (err instanceof PolicyDeniedError) return settle({ state: "failed", reason: await refusalOf(pid, err, { identifiable, ...(legalBasis ? { legalBasis } : {}) }) });
      throw err;
    }
    madeHere.set(eid, sourceId);
    seam(runnerSeams.afterCreate);
    // A lock meanwhile: the line cannot be written; the record stands, and this run (madeHere) or the next resume
    // (the source records) adopts it, whatever state the entry is in (R247 e).
    return settle({ state: "record-complete", sourceId }, ["duplicateOf", "elsewhere", ...(collectionGone ? (["collectionId"] as const) : [])], true);
  }

  // ------------------------------------------------------------------------------------------------------------
  // The runner's own work on one entry.

  /** Is this error one that stops all work for the project (nothing can be written)? Acts on it if so. */
  async function projectLevel(pid: string, err: unknown): Promise<boolean> {
    if (err instanceof ProjectLockedError) {
      stopRun(pid);
      return true;
    }
    if (err instanceof RecoveryPendingError) {
      block(pid, "recovery-pending");
      return true;
    }
    if (err instanceof FindQueueUnreadableError) {
      block(pid, "queue-unreadable");
      return true;
    }
    if (err instanceof ReadOnlyLibraryError) {
      block(pid, "read-only");
      return true;
    }
    if (err instanceof PolicyDeniedError && (await projectPolicy(repo, pid).catch(() => null)) === null) {
      block(pid, "rules-unreadable");
      return true;
    }
    return false;
  }

  async function work(pid: string, eid: string, gen: number): Promise<void> {
    const live = () => alive(pid, gen);
    const r = runOf(pid);
    let entry: FindEntry | undefined;
    try {
      entry = await current(pid, eid);
    } catch (err) {
      if (!(await projectLevel(pid, err))) {
        // Not foreseen (an I/O fault, say): the runner stops for the project and says so; `resume` tries again (N2).
        debug(`find: the queue could not be read (${errName(err)})`);
        block(pid, "unexpected");
      }
      return;
    }
    if (!live() || !entry || entry.state !== "looking-up") return;
    if (entry.nextTryAt && Date.parse(entry.nextTryAt) > now().getTime()) {
      later(pid, eid, entry.nextTryAt);
      return;
    }
    const at0 = entry;

    /** Writes `patch` on the entry in a turn, if it is still the version this work started from. */
    const finish = async (patch: Partial<FindEntry>, drop: Array<keyof FindEntry> = []) =>
      (await inTurn(r, pid, live, async () => {
        const cur = await current(pid, eid);
        if (!cur || !sameVersion(cur, at0)) return null;
        const [w] = await write(pid, [evolve(cur, patch, drop, stamp())], "update");
        return w!;
      })) ?? null;

    /**
     * No answer this time: tried again after the next delay, then "failed" with `code`. `patch` is what was decided
     * before the failure and is kept for the next try (F8: the one person found, whose works did not come).
     */
    const tryLater = async (code: FindReasonCode, patch: Partial<FindEntry> = {}) => {
      const attempts = at0.attempts + 1;
      const delay = FIND_RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) {
        await finish({ ...patch, state: "failed", attempts, reason: { code } }, ["nextTryAt"]);
        return;
      }
      const at = new Date(now().getTime() + delay).toISOString();
      const w = await finish({ ...patch, attempts, nextTryAt: at }, ["reason"]);
      if (w && live()) later(pid, eid, at);
    };

    try {
      await workOn(pid, eid, at0, r, live, finish, tryLater);
    } catch (err) {
      if (err instanceof Abandoned || !live()) return;
      if (err instanceof Error && err.name === "SimulatedCrash" && process.env.NODE_ENV === "test") {
        // Tests only (R47): the process "died" here. Nothing more is done or written by this runner.
        debug(`find: ${err.name}`);
        closed = true;
        for (const id of runs.keys()) stopRun(id);
        return;
      }
      if (await projectLevel(pid, err)) return;
      // Anything not foreseen: the entry says so (R237 c), with a code of its own; the error's kind goes to the note only.
      debug(`find: unexpected failure of an entry's lookup (${errName(err)})`);
      try {
        await finish({ state: "failed", reason: { code: "unexpected" } }, ["nextTryAt"]);
      } catch (err2) {
        if (!(err2 instanceof Abandoned) && !(await projectLevel(pid, err2))) debug(`find: the failure could not be written (${errName(err2)})`);
      }
    }
  }

  async function workOn(
    pid: string,
    eid: string,
    entry: FindEntry,
    r: Run,
    live: () => boolean,
    finish: (patch: Partial<FindEntry>, drop?: Array<keyof FindEntry>) => Promise<FindEntry | null>,
    tryLater: (code: FindReasonCode, patch?: Partial<FindEntry>) => Promise<void>,
  ): Promise<void> {
    /**
     * OpenAlex's daily allowance is used up: the entry waits for the pause's end (never less than the first retry
     * delay, so a clock that disagrees cannot make it spin), saying why; no attempt is counted. `patch` is kept (F8).
     */
    const waitForAllowance = async (patch: Partial<FindEntry> = {}) => {
      const pausedUntil = openAlexSearchPausedUntil(http);
      const midnight = new Date(now().getTime());
      midnight.setUTCHours(24, 0, 0, 0);
      const at = new Date(Math.max(pausedUntil ?? midnight.getTime(), now().getTime() + FIND_RETRY_DELAYS_MS[0]!)).toISOString();
      const w = await finish({ ...patch, nextTryAt: at, reason: { code: "budget" } });
      if (w && live()) later(pid, eid, at);
    };
    /** A people search, a person's works or a single work that did not come: the wait (budget) or the ordinary retries. */
    const notHad = async (err: unknown, patch: Partial<FindEntry> = {}): Promise<boolean> => {
      if (err instanceof FindPeopleError && err.code === "budget") {
        await waitForAllowance(patch);
        return true;
      }
      if (err instanceof FindPeopleError || err instanceof TimedOut) {
        if (err instanceof TimedOut) debug("find: an OpenAlex request did not answer in time");
        await tryLater("unreachable", patch);
        return true;
      }
      return false;
    };
    // A source already made for this entry (a crash or a stop between its creation and its line): adopted
    // before anything is asked.
    if (madeFor(pid, eid)) {
      await inTurn(r, pid, live, async () => {
        const sid = madeFor(pid, eid);
        const cur = await current(pid, eid);
        if (sid && cur && sameVersion(cur, entry)) await write(pid, [evolve(cur, { state: "record-complete", sourceId: sid }, ["reason", "nextTryAt"], stamp())], "update");
      });
      return;
    }

    const ctx = await guard(r, lookupContextFor(repo, pid, http, deps.debug ? { debug } : {}));
    if (!live()) return;
    if (!ctx.policy) {
      // Rules that cannot be read: nothing is asked, and nothing can be written (the queue is governed too).
      block(pid, "rules-unreadable");
      return;
    }
    if (!acquireAllowed(ctx)) {
      await finish({ state: "failed", reason: RULES }, ["nextTryAt"]);
      return;
    }
    let s: SearchSettings;
    try {
      s = await guard(r, deps.settings(), FIND_SETTINGS_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimedOut) {
        debug("find: the search settings did not answer in time");
        await tryLater("unexpected");
        return;
      }
      throw err;
    }
    if (!live()) return;
    // F12 (R290 b, c): the sources Find and acquire asks by the typed words, in the settings' order — Crossref,
    // OpenAlex and Elicit (Open Library and the Library of Congress are never asked by it). Settings narrow, the rules
    // decide: a source is asked only when it is on AND the rules allow it; the reason says which of the two refused.
    const on = s.record.filter((x) => x.on && (x.id === "crossref" || x.id === "openalex" || x.id === "elicit")).map((x) => x.id as SearchSource);
    if (!on.length) {
      await finish({ state: "failed", reason: SETTINGS }, ["nextTryAt"]);
      return;
    }
    const allowed = on.filter((x) => providerAllowed(ctx, x));
    if (!allowed.length) {
      await finish({ state: "failed", reason: RULES }, ["nextTryAt"]);
      return;
    }
    // Elicit only with a stored key, read only now that it is on and allowed (never for a source that is off).
    let elicitKey: string | undefined;
    if (allowed.includes("elicit") && deps.elicitKey) {
      try {
        elicitKey = (await guard(r, deps.elicitKey(), FIND_SETTINGS_TIMEOUT_MS)) || undefined;
      } catch (err) {
        if (err instanceof Abandoned) throw err;
        // No password store, or one that did not answer in time: Elicit is not asked (it is an extra; the others decide).
        debug(err instanceof TimedOut ? "find: the Elicit key could not be read in time" : "find: the Elicit key could not be read");
      }
      if (!live()) return;
      if (!elicitKey) debug("find: Elicit is on but no key is stored; it is not asked");
    }
    const sources = allowed.filter((x) => x !== "elicit" || elicitKey !== undefined);
    if (!sources.length) {
      // Only Elicit was on and allowed, and it has no key (R297 a): said so, and ends as "switched off" ends ("Try again"
      // goes on once the key is saved).
      await finish({ state: "failed", reason: NEEDS_KEY }, ["nextTryAt"]);
      return;
    }

    // Task F8: a work added from a person's list, or a person chosen. Both are OpenAlex's alone.
    const addedWork = workOfAdded(entry);
    const chosenPerson = !addedWork && isPersonId(entry.chosen) && !!entry.people?.some((x) => x.id === entry.chosen);
    if (addedWork || chosenPerson) {
      if (!on.includes("openalex")) {
        await finish({ state: "failed", reason: SETTINGS }, ["nextTryAt"]);
        return;
      }
      if (!sources.includes("openalex")) {
        await finish({ state: "failed", reason: RULES }, ["nextTryAt"]);
        return;
      }
    }
    if (addedWork) {
      // Its record is made from a fresh request for that one work by its OpenAlex id (free of the allowance), checked
      // and bounded as a search's candidate — never from the trimmed line kept for choosing (R267 c); then the
      // duplicate check and the record, exactly as for a chosen candidate.
      let got: WorkCandidate | null;
      try {
        got = await guard(r, fetchWork(addedWork, ctx), FIND_LOOKUP_TIMEOUT_MS);
      } catch (err) {
        if (await notHad(err)) return;
        throw err;
      }
      if (!live()) return;
      if (!got) {
        // No such work, or OpenAlex answered for another one (R271 M3): nothing found, never "could not be reached".
        await finish({ state: "not-found" }, ["nextTryAt", "reason"]);
        return;
      }
      const work = got;
      // R271 M4: the fresh record must BE the work ticked (the DOI and the title kept for choosing). Otherwise — or
      // when nothing was kept to compare with — the researcher is asked, with that one fresh candidate; nothing is
      // made by itself.
      const kept = entry.candidates?.find((c) => c.id === addedWork);
      if (!kept || !sameWork(kept, work)) {
        await finish({ state: "choose", candidates: [work] }, ["nextTryAt", "reason", "chosen", "match"]);
        return;
      }
      try {
        await inTurn(r, pid, live, () => completeIn(pid, eid, work, { match: { method: "find-chosen", confidence: 1 }, expect: (cur) => sameVersion(cur, entry), live, fresh: true }));
      } catch (err) {
        if (!(err instanceof FindIndexNotReadyError)) throw err;
        enqueue(pid, eid);
      }
      return;
    }
    if (chosenPerson) {
      // The person is known (chosen by the researcher, or the one that fitted): their works, then "choose-works".
      let got: Awaited<ReturnType<typeof worksOf>>;
      try {
        got = await guard(r, worksOf(entry.chosen!, ctx), FIND_LOOKUP_TIMEOUT_MS);
      } catch (err) {
        if (await notHad(err)) return;
        throw err;
      }
      if (!live()) return;
      await finish({ state: "choose-works", works: got.works, ...(got.more ? { moreWorks: true as const } : {}) }, ["nextTryAt", "reason", "candidates", "moreWorks"]);
      return;
    }

    const ref: Reference | null = parseReference(entry.typed);
    if (!ref) {
      await finish({ state: "not-found" }, ["nextTryAt", "reason"]);
      return;
    }
    let res: Awaited<ReturnType<typeof searchWorks>>;
    try {
      res = await guard(r, searchWorks(ref, ctx, { sources, ...(elicitKey ? { elicitKey } : {}) }), FIND_LOOKUP_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimedOut) {
        debug("find: a search did not answer in time");
        await tryLater("unreachable");
        return;
      }
      throw err;
    }
    // A late answer (after a stop or a lock) is not acted on.
    if (!live()) return;

    // Task F8 (R267 d, as changed by R279 a): an author alone? The people search is asked for a line that may be a
    // name and that the works rule is not sure of (the exact condition is `peopleSearchWanted`: no digit, at most 6
    // words, not sure), and only when OpenAlex is on and allowed. A failure or the spent allowance: the retries or the
    // wait, never a guess.
    /** R279 c: people that fit while a work's title is covered too — offered beside the works' "choose". */
    let offer: Partial<FindEntry> = {};
    /** R283 a: the people search could not be had, but the works rule offers a choice: "choose" at once, saying so. */
    let note: Partial<FindEntry> = {};
    const worksChoice = (): WorkCandidate[] => {
      const d = decideMatch(ref, res.candidates);
      const byId = new Map(res.candidates.map((c) => [c.id, c]));
      return d.kind === "choose" ? d.ids.map((id) => byId.get(id)!).filter(Boolean) : [];
    };
    if (sources.includes("openalex") && peopleSearchWanted(ref, res.candidates)) {
      let found: Awaited<ReturnType<typeof searchPeople>> | undefined;
      try {
        found = await guard(r, searchPeople(ref, ctx), FIND_LOOKUP_TIMEOUT_MS);
      } catch (err) {
        // R283 a: refused by the spent allowance, failed or timed out — an entry with work candidates the works rule
        // offers is not held back; only one with none waits or retries, as F8 ruled (the name may be a person's).
        if ((err instanceof FindPeopleError || err instanceof TimedOut) && worksChoice().length > 0) note = { reason: { code: "people-unavailable" } };
        else if (await notHad(err)) return;
        else throw err;
      }
      if (!live()) return;
      const fits = found ? fitPeople(ref, found.people) : ({ kind: "none" } as const);
      // R279 b, c: a person fits and no work's title is covered: the author's flow as built (below). A person fits AND a
      // work's title is covered: the works' outcome as built, carrying the people as an offer (never a guess either way).
      let who = titleCovered(ref, res.candidates) ? ({ kind: "none" } as PersonDecision) : fits;
      if (fits.kind !== "none" && who.kind === "none") {
        offer = { people: fits.kind === "one" ? [fits.person] : fits.people, ...(found?.more ? { morePeople: true as const } : {}) };
        // R285 b: an offer whose stored line would keep no work candidate is never made: the author's flow instead.
        if (!offerLeavesAChoice(evolve(entry, { state: "choose", candidates: worksChoice(), ...offer }, ["nextTryAt", "reason"], stamp()))) {
          offer = {};
          who = fits;
        }
      }
      const more = found?.more ? { morePeople: true as const } : {};
      const drop: Array<keyof FindEntry> = ["nextTryAt", "reason", "candidates", "chosen", "works", "morePeople", "moreWorks", "match"];
      // More people than the 20 read may fit as well: the one that fitted is offered, never chosen in silence.
      // Nor when the one that fitted did so only through a typed initial (R270 d).
      if (who.kind === "several" || (who.kind === "one" && (found?.more || who.byInitial))) {
        await finish({ state: "choose-person", people: who.kind === "one" ? [who.person] : who.people, ...more }, drop);
        return;
      }
      if (who.kind === "one") {
        const person = { people: [who.person], chosen: who.person.id };
        let got: Awaited<ReturnType<typeof worksOf>>;
        try {
          got = await guard(r, worksOf(who.person.id, ctx), FIND_LOOKUP_TIMEOUT_MS);
        } catch (err) {
          // The person is kept for the next try (which asks only for the works); no work is kept from half an answer.
          if (await notHad(err, person)) return;
          throw err;
        }
        if (!live()) return;
        await finish({ state: "choose-works", ...person, works: got.works, ...(got.more ? { moreWorks: true as const } : {}) }, drop);
        return;
      }
      // Nobody of that name: the entry stays whatever the works search makes it.
    }

    // F12 (R290 c): Elicit is an extra, not one of the sources a complete answer needs — its failure counts only when
    // it was the one source asked (then nothing answered: the ordinary retries).
    const needed = sources.length > 1 ? sources.filter((x) => x !== "elicit") : sources;
    const failed = needed.filter((x) => res.notes.includes(`${x}-failed`));
    const budget = sources.includes("openalex") && res.notes.includes("openalex-budget");
    /** Every source asked answered: the list is complete (one source left by the rules or the settings counts). */
    const complete = failed.length === 0 && !budget;
    const decision = decideMatch(ref, res.candidates);
    if (decision.kind === "none" && !complete) {
      // "Not found" only when every source that may be asked has answered (N3).
      if (failed.length > 0) {
        await tryLater("unreachable");
        return;
      }
      // OpenAlex is paused for the day: the entry waits for the pause's end.
      await waitForAllowance();
      return;
    }
    if (decision.kind === "none") {
      await finish({ state: "not-found" }, ["nextTryAt", "reason", "candidates"]);
      return;
    }
    if (decision.kind === "choose" || !complete) {
      // Several works fit; or the app could be sure only on a partial answer (another edition may be in the part
      // that did not come): the researcher chooses (M4).
      const byId = new Map(res.candidates.map((c) => [c.id, c]));
      const ids = decision.kind === "choose" ? decision.ids : res.candidates.map((c) => c.id);
      const candidates = ids.map((id) => byId.get(id)!).filter(Boolean);
      // F8b: with the author offer, if any (the people found; R279 c), or the note that people could not be looked up (R283 a).
      await finish({ state: "choose", candidates, ...offer, ...note }, ["nextTryAt", "reason", "people", "morePeople"]);
      return;
    }
    const cand = res.candidates.find((c) => c.id === decision.id)!;
    try {
      await inTurn(r, pid, live, () =>
        completeIn(pid, eid, cand, {
          match: { method: "find-match", confidence: scoreCandidate(ref, cand).score },
          expect: (cur) => sameVersion(cur, entry),
          live,
        }),
      );
    } catch (err) {
      if (!(err instanceof FindIndexNotReadyError)) throw err;
      // Held back until the index can be trusted (N4): the entry waits, unchanged, and is worked on again then.
      enqueue(pid, eid);
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // What the researcher does.

  function assertOpen(): void {
    if (closed) throw new FindRunnerClosedError();
  }
  function assertId(id: string): void {
    if (typeof id !== "string" || !isId(id)) throw new NotFoundError("Queue entry", "unknown");
  }

  async function add(projectId: string, lines: string[], collectionId?: string): Promise<{ added: FindEntry[]; mergedLines: number }> {
    assertOpen();
    repo.getProject(projectId); // NotFoundError for an unknown project
    if (!Array.isArray(lines)) throw new InvalidInputError("The lines to add are not a list.");
    if (collectionId !== undefined && (typeof collectionId !== "string" || !isId(collectionId))) throw new InvalidInputError("The collection is not one of this project's.");
    const given = lines.map((l, i) => ({ l, n: i + 1 })).filter((x): x is { l: string; n: number } => typeof x.l === "string" && x.l.trim() !== "");
    if (given.length === 0) throw new InvalidInputError("Type at least one reference.");
    if (given.length > FIND_ADD_MAX_LINES) throw new InvalidInputError(`At most ${FIND_ADD_MAX_LINES} lines can be added at once.`);
    const seen = new Set<string>();
    const at = stamp();
    const added: FindEntry[] = [];
    let mergedLines = 0;
    for (const { l: line, n } of given) {
      const ref = parseReference(line);
      // Named by its number with the true cause, never by its text (R247 M2).
      if (!ref || ref.text.length > FIND_TYPED_MAX) {
        throw new InvalidInputError(`Line ${n} is not 2 to 500 characters long once characters that cannot be shown (such as control characters) are left out. Nothing was added.`);
      }
      const norm = ref.tokens.length ? ref.tokens.join(" ") : ref.text.toLowerCase();
      if (seen.has(norm)) {
        mergedLines++;
        continue;
      }
      seen.add(norm);
      added.push({ id: newId(), projectId, ...(collectionId ? { collectionId } : {}), typed: ref.text, state: "looking-up", createdAt: at, updatedAt: at, attempts: 0 });
    }
    // Not in the project's store turn (R247 M4: an import holds it for a whole file, lookups included): the check is
    // made here, at once, and an add past it is waited for by `stopAll` like an act in its turn.
    if (closed) throw new FindRunnerClosedError();
    if (runs.get(projectId)?.stopped) throw new FindProjectStoppedError();
    const written = await holdUntilDone(write(projectId, added, "add"));
    // A stop that comes after the write: nothing runs until `resume` (enqueue does nothing for a stopped run).
    for (const e of written) enqueue(projectId, e.id);
    return { added: written, mergedLines };
  }

  /** A press that may create a record is refused while the index cannot be trusted (N4); nothing is changed. */
  function assertIndexReady(): void {
    if (!indexReady()) throw new FindIndexNotReadyError();
  }

  async function choose(projectId: string, entryId: string, candidateId: string | null): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    assertIndexReady();
    return act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "choose") {
        // Pressed twice: the first press already decided it.
        if (candidateId !== null && cur.chosen === candidateId && ["record-complete", "already", "maybe-duplicate", "failed"].includes(cur.state)) return cur;
        if (candidateId === null && cur.state === "not-found") return cur;
        throw new FindEntryStateError();
      }
      if (candidateId === null) {
        // F8b: "None of these" ends an author offer too (R279 c).
        const [w] = await write(projectId, [evolve(cur, { state: "not-found" }, ["chosen", "reason", "nextTryAt", "people", "morePeople"], stamp())], "update");
        return w!;
      }
      const cand = cur.candidates?.find((c) => c.id === candidateId);
      if (!cand) throw new FindEntryStateError();
      const done = await completeIn(projectId, entryId, cand, { match: { method: "find-chosen", confidence: 1 }, expect: (e) => sameVersion(e, cur), live: () => true });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function confirmDuplicate(projectId: string, entryId: string, same: boolean): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    assertIndexReady();
    return act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "maybe-duplicate") throw new FindEntryStateError();
      if (same) {
        const [w] = await write(projectId, [evolve(cur, { state: "already" }, ["reason", "nextTryAt"], stamp())], "update");
        return w!;
      }
      const cand = cur.candidates?.find((c) => c.id === cur.chosen) ?? cur.candidates?.[0];
      if (!cand) throw new FindEntryStateError();
      // The researcher answered a duplicate question: the match is what it was (M3).
      const done = await completeIn(projectId, entryId, cand, { match: matchOf(cur, cand), expect: (e) => sameVersion(e, cur), live: () => true, skipLikely: true });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function addHereAsWell(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    assertIndexReady();
    return act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (!cur.elsewhere || (cur.state !== "already" && cur.state !== "maybe-duplicate")) throw new FindEntryStateError();
      const cand = cur.candidates?.find((c) => c.id === cur.chosen) ?? cur.candidates?.[0];
      if (!cand) throw new FindEntryStateError();
      const done = await completeIn(projectId, entryId, cand, { match: matchOf(cur, cand), expect: (e) => sameVersion(e, cur), live: () => true, skipElsewhere: true });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function retry(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    const w = await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      const waiting = cur.state === "looking-up" && !!cur.nextTryAt;
      // R283 a: a "choose" made while people of the name could not be looked up: Try again looks again (afresh).
      const peopleUnseen = cur.state === "choose" && cur.reason?.code === "people-unavailable";
      if (cur.state !== "failed" && cur.state !== "not-found" && !waiting && !peopleUnseen) throw new FindEntryStateError();
      cancelLater(projectId, entryId);
      // F8: a work added from a person's list keeps its work (it is asked again by its id, never searched by text),
      // and an author's entry keeps the person whose works did not come.
      // An added work keeps `work` (never dropped); the line kept for choosing (its candidate) is kept only when no fresh
      // record replaced it — a "failed" entry — so that a researcher's "None of these" is never undone by a retry: with
      // nothing to compare with, the work is asked about again.
      const keepCandidates = workOfAdded(cur) !== undefined && cur.state === "failed" && cur.candidates?.some((c) => c.id === workOfAdded(cur));
      const keepChosen = isPersonId(cur.chosen) && !!cur.people?.some((x) => x.id === cur.chosen);
      // F8b: otherwise it starts afresh — people stored for an author offer are not kept (R279 c).
      const drop: Array<keyof FindEntry> = ["reason", "nextTryAt", "duplicateOf", "elsewhere", "match", ...(keepCandidates ? [] : (["candidates"] as const)), ...(keepChosen ? [] : (["chosen", "people", "morePeople"] as const))];
      const [next] = await write(projectId, [evolve(cur, { state: "looking-up", attempts: 0 }, drop, stamp())], "update");
      return next!;
    });
    enqueue(projectId, entryId);
    return w;
  }

  async function remove(projectId: string, entryId: string): Promise<void> {
    assertOpen();
    assertId(entryId);
    await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      cancelLater(projectId, entryId);
      const r = runs.get(projectId);
      if (r) r.pending = r.pending.filter((e) => e !== entryId);
      // Only the entry goes: a source it made stays in the library.
      await write(projectId, [cur], "remove");
    });
  }

  function resume(projectId: string): void {
    if (closed || readOnly()) return;
    let unlocked: boolean;
    try {
      unlocked = repo.isUnlocked(projectId);
    } catch {
      return; // not a project of this library
    }
    if (!unlocked) return;
    blocked.delete(projectId);
    const r = runOf(projectId);
    r.signalStop(); // the previous generation's work is let go at once
    r.gen++;
    let signalStop!: () => void;
    r.stopSignal = new Promise<void>((res) => (signalStop = res));
    r.signalStop = signalStop;
    r.stopped = false;
    r.adoptable = new Map();
    const gen = r.gen;
    const p = (async () => {
      if (recoveryPendingProjects(repo).includes(projectId)) {
        // Its writes wait for the library to be reopened (N2).
        if (alive(projectId, gen)) block(projectId, "recovery-pending");
        return;
      }
      if ((await projectPolicy(repo, projectId)) === null) {
        if (alive(projectId, gen)) block(projectId, "rules-unreadable");
        return;
      }
      const q = await readFindQueueIn(repo, projectId);
      if (!alive(projectId, gen)) return;
      const waiting = [...q.values()].filter((e) => e.state === "looking-up");
      // R247 (e): a record can be made for an entry in other states too (a choose, a duplicate answer, "add it here as
      // well"); a lock or a crash between its creation and the entry's line leaves the entry as it was, without a
      // `sourceId`. Only the states a record is made from are candidates ("choose", "maybe-duplicate", and "already"
      // with `elsewhere`): "not-found", "failed" and "already" here neither are nor move the scan's bound back (m1).
      const madeFrom = (e: FindEntry) => e.state === "choose" || e.state === "maybe-duplicate" || (e.state === "already" && e.elsewhere === true);
      const unmade = [...q.values()].filter((e) => madeFrom(e) && !e.sourceId);
      if (!waiting.length && !unmade.length) return;
      // Sources made for an entry whose line was never written (a crash or a stop in between): read once here,
      // outside any store turn, never per entry. Ids are UUIDv7, ordered by the time they were made, and such a
      // source was made after its entry: only the sources whose id time is at or after the oldest waiting entry's
      // `createdAt` (for any other entry: its last line, `updatedAt`), less FIND_ADOPT_MARGIN_MS for clock steps, are
      // read (Q8). An id that is not a UUIDv7 is read.
      const want = new Set([...waiting, ...unmade].map((e) => e.id));
      const oldest = Math.min(...waiting.map((e) => Date.parse(e.createdAt)), ...unmade.map((e) => Date.parse(e.updatedAt)));
      const from = Number.isFinite(oldest) ? oldest - FIND_ADOPT_MARGIN_MS : -Infinity;
      const madeHow = new Map<string, FindMatch>();
      for (const id of repo.listSourceIds(projectId)) {
        if (!alive(projectId, gen)) return;
        if (isId(id) && idTime(id) < from) continue;
        try {
          const s = await repo.getSourceRecord(projectId, id);
          const tag = s.provenance.externalKeys?.[FIND_ENTRY_KEY];
          if (tag && want.has(tag) && s.provenance.captureMethod === "reference_lookup" && s.provenance.tool.name === FIND_TOOL) {
            r.adoptable.set(tag, id);
            const how = s.provenance.identification;
            if (how && (how.method === "find-match" || how.method === "find-chosen") && typeof how.confidence === "number") madeHow.set(tag, { method: how.method, confidence: how.confidence });
          }
        } catch (err) {
          if (err instanceof ProjectLockedError) throw err;
          // an unreadable source cannot be adopted
        }
      }
      if (!alive(projectId, gen)) return;
      for (const e of unmade) {
        if (!r.adoptable.has(e.id)) continue;
        await inTurn(r, projectId, () => alive(projectId, gen), async () => {
          const sid = madeFor(projectId, e.id);
          const cur = await current(projectId, e.id);
          if (!sid || !cur || cur.sourceId || !sameVersion(cur, e)) return;
          const how = madeHow.get(e.id);
          await write(projectId, [evolve(cur, { state: "record-complete", sourceId: sid, ...(how ? { match: how } : {}) }, ["reason", "nextTryAt", "duplicateOf", "elsewhere", "people", "morePeople"], stamp())], "update");
        });
        if (!alive(projectId, gen)) return;
      }
      for (const e of waiting) {
        if (e.nextTryAt && Date.parse(e.nextTryAt) > now().getTime() && !r.adoptable.has(e.id)) later(projectId, e.id, e.nextTryAt);
        else enqueue(projectId, e.id);
      }
    })()
      .catch(async (err: unknown) => {
        if (!(await projectLevel(projectId, err))) {
          debug(`find: the queue could not be resumed (${errName(err)})`);
          if (alive(projectId, gen)) block(projectId, "unexpected");
        }
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  function stop(projectId: string): void {
    stopRun(projectId);
  }

  async function stopAll(): Promise<void> {
    closed = true;
    for (const pid of runs.keys()) stopRun(pid);
    if (indexWait !== undefined) {
      timers.clearTimeout(indexWait);
      indexWait = undefined;
    }
    let h: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((res) => {
      h = setTimeout(res, FIND_STOP_SETTLE_MS);
      h.unref?.();
    });
    await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), bound]);
    if (h) clearTimeout(h);
    // What is inside a store turn finishes: no time limit (R247 d), so nothing of it lands after the lock is released.
    while (inTurnNow.size) await Promise.allSettled([...inTurnNow]);
  }

  async function elsewhere(projectId: string, entryId: string): Promise<{ projectId: string; sourceId: string } | null> {
    assertId(entryId);
    const cur = await current(projectId, entryId);
    if (!cur) throw new NotFoundError("Queue entry", entryId);
    if (!cur.elsewhere) return null;
    const cand = cur.candidates?.find((c) => c.id === cur.chosen) ?? cur.candidates?.[0];
    if (!cand) return null;
    const m = matchElsewhere(projectId, keyOf(cand), true);
    return m ? { projectId: m.projectId, sourceId: m.sourceId } : null;
  }

  function lockedNotChecked(): number {
    let on = false;
    try {
      on = deps.checkEverything();
    } catch {
      on = false;
    }
    return on ? otherProjects(null).locked : 0;
  }

  function stoppedFor(projectId: string): FindStoppedFor | null {
    if (readOnly()) return { code: "read-only" };
    const b = blocked.get(projectId);
    if (b) return b;
    if (!indexReady()) return { code: "index-not-ready" };
    return null;
  }

  async function choosePerson(projectId: string, entryId: string, personId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    if (!isPersonId(personId)) throw new InvalidInputError("That is not a person's id that OpenAlex gives. Nothing was changed.");
    const w = await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      // Only an entry asking which person: a second press, or a press on any other state, changes nothing.
      if (cur.state !== "choose-person") throw new FindEntryStateError();
      // One of THAT entry's people: no request can make the app fetch an arbitrary author (R267 e).
      if (!cur.people?.some((x) => x.id === personId)) throw new FindUnknownOptionError("person");
      cancelLater(projectId, entryId);
      // "More people have this name" is no longer said once a person is chosen (R271 M6).
      const [next] = await write(projectId, [evolve(cur, { state: "looking-up", chosen: personId, attempts: 0 }, ["reason", "nextTryAt", "works", "moreWorks", "morePeople"], stamp())], "update");
      return next!;
    });
    // The person's works are asked by the runner's own work, like every lookup (time-limited, retried, waiting for the allowance).
    enqueue(projectId, entryId);
    return w;
  }

  async function chooseWorks(projectId: string, entryId: string, workIds: string[]): Promise<{ added: FindEntry[]; parent: FindEntry }> {
    assertOpen();
    assertId(entryId);
    if (!Array.isArray(workIds) || workIds.length === 0) throw new InvalidInputError("Tick at least one work. Nothing was added.");
    if (workIds.length > FIND_CHOOSE_WORKS_MAX) throw new InvalidInputError(`At most ${FIND_CHOOSE_WORKS_MAX} works can be added at once. Nothing was added.`);
    workIds.forEach((id, i) => {
      if (!isWorkId(id)) throw new InvalidInputError(`Work ${i + 1} is not a work's id that OpenAlex gives. Nothing was added.`);
    });
    // A work ticked twice in one call is added once.
    const ids = [...new Set(workIds)];
    const done = await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "choose-works") throw new FindEntryStateError();
      const offered = new Map((cur.works ?? []).map((x) => [x.id, x]));
      // R271 M5: what was added is worked out from the queue's live entries (in this turn, so two calls at once add a
      // work once); an entry the researcher removed frees its work to be added again.
      const already = worksAddedFrom((await readFindQueueIn(repo, projectId)).values(), entryId);
      workIds.forEach((id, i) => {
        // One of THAT entry's works (R267 e), and not one already added from it (named by its position only).
        if (!offered.has(id)) throw new FindUnknownOptionError("work");
        if (already.has(id)) throw new FindAlreadyAddedError(i + 1);
      });
      const at = stamp();
      const kids: FindEntry[] = ids.map((id) => ({
        id: newId(),
        projectId,
        ...(cur.collectionId ? { collectionId: cur.collectionId } : {}),
        typed: childTyped(offered.get(id)!),
        state: "looking-up",
        createdAt: at,
        updatedAt: at,
        attempts: 0,
        parentId: entryId,
        // The work it is made from (set once), and the line kept for choosing, which its fresh record must match (M4).
        work: id,
        candidates: [offered.get(id)!],
      }));
      // The new entries and the parent's own new line in ONE governed change: a crash leaves all of it or none, and a
      // parent removed meanwhile refuses the whole. The parent stays "choose-works" (more of that person's works can be
      // added later; it ends when it is removed).
      const written = await write(projectId, kids, "add", [evolve(cur, {}, [], at)]);
      return { added: written.slice(0, kids.length), parent: written[kids.length]! };
    });
    for (const k of done.added) enqueue(projectId, k.id);
    return done;
  }

  async function asAuthor(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    const w = await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      // Only an entry asking among works that carries an author offer: any other state, a second press, or an entry
      // whose work was chosen meanwhile (its people went in that write) changes nothing.
      if (cur.state !== "choose" || !cur.people?.length) throw new FindNoAuthorError();
      cancelLater(projectId, entryId);
      const ref = parseReference(cur.typed);
      // F8's own conditions for going straight to a person's works: exactly one fits, no initial typed (R270 d, R273
      // M10), and no more people than those stored. Otherwise the researcher says which person is meant.
      const ask = cur.people.length > 1 || cur.morePeople === true || !ref || hasInitial(ref);
      const drop: Array<keyof FindEntry> = ["candidates", "chosen", "match", "reason", "nextTryAt", "works", "moreWorks", "duplicateOf", "elsewhere"];
      const next = ask
        ? evolve(cur, { state: "choose-person", attempts: 0 }, drop, stamp())
        : evolve(cur, { state: "looking-up", chosen: cur.people[0]!.id, attempts: 0 }, [...drop, "morePeople"], stamp());
      const [written] = await write(projectId, [next], "update");
      return written!;
    });
    // The one person's works are asked by the runner's own work, as after `choosePerson` (time-limited, retried,
    // waiting for the allowance).
    if (w.state === "looking-up") enqueue(projectId, entryId);
    return w;
  }

  return { add, choose, confirmDuplicate, addHereAsWell, retry, remove, resume, stop, stopAll, elsewhere, lockedNotChecked, stoppedFor, choosePerson, chooseWorks, asAuthor };
}
