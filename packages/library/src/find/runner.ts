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
  sourceRecordStampIn,
  type Repo,
} from "../repo/repo.js";
import { libraryVersion } from "../resources.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { FIND_LIBRARY_TEXT, LIBRARY_FILE_MAX_BYTES, LIBRARY_PAUSE_MS, LIBRARY_TICKET_MS, libraryReadyIn, type FindLibraryFileOutcome } from "@ao/shared";
import { idsOf, libraryAddressFor, type LibraryAccess } from "./where.js";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { AcquiredFrom, SourceFile } from "@ao/core";
import { heldWaitingCountIn, holdMismatchedFileIn, removeFindEntryIn, resolveHeldFileIn } from "../repo/repo.js";
import { FIND_HELD_MAX, HeldFileEntryGoneError, HeldFileLimitError, HeldFileSourceHasFileError, sourceHasFile, type HeldFileFacts } from "../repo/review.js";
import type { WorkCandidate } from "./candidates.js";
import { FETCH_FILE_DEADLINE_MS, FetchFileError, fetchFile, fileTypeByBytes, holdFindTemp } from "./fetch-file.js";
import { checkFileAgainstRecord, type FileCheckResult } from "./file-check.js";
import { FREE_COPY_ELSEWHERE_MAX, FREE_COPY_MAX_BYTES, FREE_COPY_SOURCES, findFreeCopies, type CopyOffer, type FreeCopySource } from "./free-copy.js";
import { FIND_CHOOSE_WORKS_MAX, FindPeopleError, authorOfferProbe, childTyped, fetchWork, fitAuthorEntry, fitPeople, hasInitial, isPersonId, isWorkId, peopleSearchWanted, sameWork, searchPeople, titleCovered, worksOf, type PersonDecision } from "./people.js";
import { FindQueueUnreadableError, sanitizeEntry } from "./queue-store.js";
import { parseReference, type Reference } from "./reference.js";
import { decideMatch, openAlexSearchPausedUntil, scoreCandidate, searchWorks, type SearchSource } from "./search.js";
import {
  FIND_DOI_MAX,
  FIND_LINE_MAX_BYTES,
  FIND_QUEUE_MAX,
  FIND_TYPED_MAX,
  type FindEntry,
  type FindMatch,
  type FindReason,
  type FindReasonCode,
  type FindReturnTo,
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
/**
 * Task F11: one download call may take this long IN ALL, its wait for a download place included (F10 counts its own
 * 180 s from the place granted): 60 s to get a place, then F10's 180 s. Past it the call is aborted through its signal
 * and leaves nothing behind (F10).
 */
export const FIND_DOWNLOAD_TIMEOUT_MS = 60_000 + FETCH_FILE_DEADLINE_MS;
/** Task F11: the file check of one file (the library's extraction, in this process) may take this long; past it the file "needs a check" ("no-text"). */
export const FIND_CHECK_TIMEOUT_MS = 60_000;
/**
 * R282 g (M1): while an entry's file is downloaded and checked, whether its record is still in the library is looked at
 * this often (an in-memory read); a record removed meanwhile aborts the download.
 */
export const FIND_SOURCE_WATCH_MS = 2_000;

/**
 * Task F11: a free copy's address as `Asset.acquired` keeps it: user name, password, query and fragment removed
 * (a session token or a key in a query never survives), at most 2,000 characters. "" when it does not parse.
 */
export function cleanAcquiredAddress(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const out = u.href;
  return out.length <= 2000 ? out : "";
}

/** Task F11: the states of the free-copy part of an entry's life (an entry with its record made, and no file yet). */
const COPY_STATES: ReadonlySet<FindState> = new Set(["record-complete", "looking-for-copy", "fetching"]);
/**
 * An entry with its record waiting for a place among the files waiting for the researcher's check: "record-complete /
 * held-full", or (R310 b) "failed / held-full" as builds before R296 d stored it — woken alike, and judged again from
 * "looking for a copy" like the others.
 */
const waitsForPlace = (e: FindEntry): boolean => !!e.sourceId && (e.state === "record-complete" || e.state === "failed") && e.reason?.code === "held-full";
/** R297 c: waiting for OpenAlex's daily allowance (the record part's wait; a saved key wakes it: `wakeAllowance`). */
const waitsForAllowance = (e: FindEntry): boolean => e.state === "looking-up" && e.reason?.code === "budget" && !!e.nextTryAt;
const inCopyPart = (e: FindEntry): boolean => (!!e.sourceId && COPY_STATES.has(e.state)) || waitsForPlace(e);
/**
 * R326: an entry resting because the researcher's Search sources switch off what its part needs ("switched off" by the
 * settings): in the copy part "record-complete" (every copy service off), in the record part "failed" with no record
 * (every source that could give one off). A save of those settings wakes exactly these (`wakeSettings`).
 */
const restsSwitchedOff = (e: FindEntry): boolean => e.reason?.code === "switched-off" && e.reason.by === "settings";
const copyRestsSwitchedOff = (e: FindEntry): boolean => !!e.sourceId && e.state === "record-complete" && restsSwitchedOff(e);
const recordRestsSwitchedOff = (e: FindEntry): boolean => !e.sourceId && e.state === "failed" && restsSwitchedOff(e);

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
 * Task F15 (R324): a start "through my library" refused, and why — nothing was changed. The message is the shared
 * sentence (FIND_LIBRARY_TEXT; the pause's is `libraryReadyIn`); nothing of the entry, the address or a ticket is in it.
 */
export class FindLibraryRefusedError extends Error {
  override name = "FindLibraryRefusedError";
  constructor(
    readonly code: "not-offered" | "no-library" | "busy" | "pause" | "held-full",
    /** "pause": the whole seconds left, rounded up. */
    readonly seconds?: number,
  ) {
    super(
      code === "pause"
        ? libraryReadyIn(seconds ?? 1)
        : code === "no-library"
          ? FIND_LIBRARY_TEXT.noLibrary
          : code === "busy"
            ? FIND_LIBRARY_TEXT.busy
            : code === "held-full"
              ? FIND_LIBRARY_TEXT.heldFull
              : FIND_LIBRARY_TEXT.notOffered,
    );
  }
}

/** Task F15: the record as a work (for the free-copy lookups, the file check, a library address and "Where to get it"). */
function workOfSourceFile(sf: SourceFile): WorkCandidate {
  const s = sf.source;
  return {
    id: s.id,
    title: primary(s.title) ?? "",
    creators: s.creators.slice(0, 100),
    type: s.type,
    identifiers: { ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}), ...(s.identifiers.isbn?.length ? { isbn: s.identifiers.isbn.slice(0, 20) } : {}) },
    ...(s.issued ? { issued: s.issued } : {}),
    providers: [],
  };
}

/**
 * R324 a: the copy part's resting states a fetch through the library may start from, and whose view gives "Where to get
 * it": "no-open-copy" (any reason but the record's removal), or "record-complete" because free copies are not allowed by
 * the rules or every copy service is switched off — always with the entry's record (`sourceId`).
 */
export function restsForLibrary(e: FindEntry): boolean {
  if (!e.sourceId) return false;
  if (e.state === "no-open-copy") return e.reason?.code !== "record-removed";
  return e.state === "record-complete" && (e.reason?.code === "copy-not-allowed" || e.reason?.code === "switched-off");
}

type PolicyInfo = Awaited<ReturnType<typeof lookupPolicyInfo>>;
/** What the store of a record's file is asked with: its provenance's identifiable flag and legal basis. */
type StoreFacts = { identifiable: boolean; legalBasis?: string };
/**
 * Whether the rules allow a fetch through the library for this record AND would let its file be kept: the capture of
 * `library_access` and the store of the file as the copy part asks them before a download (identifiable data, the legal
 * basis). Fails closed (no rules, or a rule that cannot be evaluated).
 */
function libraryAllowedBy(info: PolicyInfo, projectId: string, facts: StoreFacts): boolean {
  if (!info.policy) return false;
  const base = { projectId, actor: info.actor, now: info.clock().toISOString(), ...(info.tz ? { tz: info.tz } : {}) };
  try {
    if (evaluate(info.policy, { ...base, action: "capture", capture: { method: "library_access" } }).result === "deny") return false;
    const store = { identifiable: facts.identifiable, hasLocation: false, ...(facts.legalBasis ? { legalBasis: facts.legalBasis } : {}) };
    return evaluate(info.policy, { ...base, action: "store", store }).result !== "deny";
  } catch {
    return false;
  }
}

/** Task F15: what the entry's view says of the library (R324 a, d). `chance` absent: no start offered. */
export type FindLibraryChanceOf = { work: WorkCandidate; chance?: "yes" | "no-library"; lastFile?: FindLibraryFileOutcome };

/**
 * Task F17 (R329): a file handed over for an entry, as the runner is given it. The runner never touches the place the
 * file was handed over in (the shell's inbox): the caller's `take` copies it, read from a handle it opened and checked,
 * into `to` — a new file (created exclusively, 0600) in the runner's own temporary folder for the entry — at most
 * `maxBytes`, and removes it from where it was; `discard` removes it without reading it. Both are the caller's, and
 * the runner calls exactly one of them, once. Neither throws: a file that cannot be taken is `{ ok: false, why }`.
 */
export interface HandedFile {
  take(path: string, to: string, maxBytes: number): Promise<{ ok: true; bytes: number } | { ok: false; why: "too-large" | "unreadable" }>;
  discard(path: string): Promise<void>;
}

/**
 * R328 e: what the queue's view needs of a record, and nothing more — the work as "Where to get it" and a library
 * address use it (its id, title, type, DOI and ISBNs, and the one creator's name the catalogue's query takes), whether
 * the record has a file, and the two facts the store of a file is asked with.
 */
type RecordFacts = { work: WorkCandidate; hasFile: boolean; store: StoreFacts };

function factsOf(sf: SourceFile): RecordFacts {
  const w = workOfSourceFile(sf);
  // The name the catalogue's query takes (whereToGetIt): the first family name, else the first creator's literal one.
  const named = w.creators.find((c) => c.family);
  const creator = named ? { role: named.role, family: named.family } : w.creators[0]?.literal ? { role: w.creators[0].role, literal: w.creators[0].literal } : undefined;
  const prov = sf.source.provenance;
  return {
    work: { id: w.id, title: w.title, creators: creator ? [creator] : [], type: w.type, identifiers: w.identifiers, providers: [] },
    hasFile: sourceHasFile(sf),
    store: { identifiable: prov.identifiable, ...(prov.legal.basis ? { legalBasis: prov.legal.basis } : {}) },
  };
}

/** At most this many records' facts are kept (four full queues); the one used longest ago goes first. */
export const RECORD_FACTS_MAX = 4 * FIND_QUEUE_MAX;

/**
 * R328 e: the records' facts the queue's view read last, each with the stamp of its file when it was read (a `stat`:
 * inode, size, modification and change times). Kept by the runner — one per open library, in memory only — per
 * project; a project's are dropped at its lock (`stop`) and all at the close (`stopAll`). Never shared between
 * projects: a record is looked up under the project it was read in.
 */
interface RecordFactsCache {
  get(projectId: string, sourceId: string, stamp: string): RecordFacts | undefined;
  set(projectId: string, sourceId: string, stamp: string, facts: RecordFacts): void;
  dropProject(projectId: string): void;
  clear(): void;
}

function createRecordFactsCache(max = RECORD_FACTS_MAX): RecordFactsCache {
  const byProject = new Map<string, Map<string, { stamp: string; facts: RecordFacts }>>();
  /** Every key kept, in the order of its last use (`projectId \0 sourceId`): the bound. */
  const order = new Map<string, [string, string]>();
  const key = (p: string, id: string) => `${p}\u0000${id}`;
  const forget = (p: string, id: string) => {
    byProject.get(p)?.delete(id);
    if (byProject.get(p)?.size === 0) byProject.delete(p);
    order.delete(key(p, id));
  };
  return {
    get(p, id, stamp) {
      const hit = byProject.get(p)?.get(id);
      if (!hit) return undefined;
      if (hit.stamp !== stamp) {
        forget(p, id);
        return undefined;
      }
      order.delete(key(p, id));
      order.set(key(p, id), [p, id]);
      return hit.facts;
    },
    set(p, id, stamp, facts) {
      forget(p, id);
      let m = byProject.get(p);
      if (!m) byProject.set(p, (m = new Map()));
      m.set(id, { stamp, facts });
      order.set(key(p, id), [p, id]);
      while (order.size > max) {
        const [oldest] = order.values();
        forget(oldest![0], oldest![1]);
      }
    },
    dropProject(p) {
      for (const id of [...(byProject.get(p)?.keys() ?? [])]) forget(p, id);
    },
    clear() {
      byProject.clear();
      order.clear();
    },
  };
}

/**
 * Task F15 (R324 a, d): for each entry of `entries` that rests as R324 a names and whose record is still in the library,
 * the record as a work (for "Where to get it", given whether or not a library is set) and whether "Get through my library"
 * may start: "yes" when its record has no file, no file of it waits for the researcher's check (no entry of the queue
 * for the same record is "needs-check"), it is not at work (`atWork`), it has a DOI or ISBN that gives an address
 * through `access`, and the rules allow `library_access` and would keep the file; "no-library" when all of that holds
 * but no library is set (`access` null; then a DOI is needed, R328 g: an ISBN alone gives no address through EZproxy
 * or OpenAthens, so it carries no such promise). One read of the rules, one read of each
 * resting entry's record. A locked project gives nothing.
 */
export async function libraryChancesOf(
  repo: Repo,
  projectId: string,
  entries: Iterable<FindEntry>,
  o: { access: LibraryAccess | null; atWork?: (entryId: string) => boolean; only?: string; records?: RecordFactsCache },
): Promise<Map<string, FindLibraryChanceOf>> {
  const out = new Map<string, FindLibraryChanceOf>();
  const all = [...entries];
  const resting = all.filter((e) => restsForLibrary(e) && (o.only === undefined || e.id === o.only));
  if (!resting.length) return out;
  let info: PolicyInfo;
  try {
    info = await lookupPolicyInfo(repo, projectId);
  } catch (err) {
    if (err instanceof ProjectLockedError) return out;
    throw err;
  }
  const waitingFor = new Set(all.filter((e) => e.state === "needs-check" && e.sourceId).map((e) => e.sourceId!));
  // The rules' answer depends only on the two facts the store is asked with: asked once per kind in this read (R328 e).
  const asked = new Map<string, boolean>();
  const allowed = (f: StoreFacts): boolean => {
    const k = JSON.stringify([f.identifiable, f.legalBasis ?? null]);
    let v = asked.get(k);
    if (v === undefined) asked.set(k, (v = libraryAllowedBy(info, projectId, f)));
    return v;
  };
  // R328 e: with the runner's cache, each record's file is stat'ed (first, all of them) and read only when its stamp
  // changed.
  const cache = o.records;
  let stamps: Array<string | null> = [];
  try {
    if (cache) stamps = resting.map((e) => sourceRecordStampIn(repo, projectId, e.sourceId!));
  } catch (err) {
    if (err instanceof ProjectLockedError) return new Map();
    throw err;
  }
  for (const [i, e] of resting.entries()) {
    let facts: RecordFacts | undefined;
    const stamp = cache ? stamps[i] : undefined;
    if (cache && stamp === null) continue; // the record is not there (deleted)
    if (cache && stamp) facts = cache.get(projectId, e.sourceId!, stamp);
    if (!facts) {
      let sf: SourceFile;
      try {
        sf = await repo.getSource(projectId, e.sourceId!);
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        throw err;
      }
      facts = factsOf(sf);
      if (cache && stamp) cache.set(projectId, e.sourceId!, stamp, facts);
    }
    const work = facts.work;
    const ids = idsOf(work);
    const free = !facts.hasFile && !waitingFor.has(e.sourceId!) && !(o.atWork?.(e.id) ?? false);
    // R328 g: with no library set, a DOI is needed for the promise "set your library" (every kind of library gives an
    // address for a DOI; an ISBN alone gives one only through a link resolver).
    const target = o.access ? libraryAddressFor(o.access, work) !== null : !!ids.doi;
    const may = free && target && allowed(facts.store);
    out.set(e.id, { work, ...(may ? { chance: o.access ? ("yes" as const) : ("no-library" as const) } : {}) });
  }
  return out;
}

/** Task F15 (R324 b): the entry as it rested before the start, or (nothing kept) "no-open-copy" saying so honestly. */
function returnedFrom(cur: FindEntry, at: string): FindEntry {
  const t: FindReturnTo | undefined = cur.returnTo;
  const back: Partial<FindEntry> = t ? { state: t.state, ...(t.reason ? { reason: t.reason } : {}) } : { state: "no-open-copy", reason: { code: "library-unfinished" } };
  return evolve(cur, back, ["returnTo", "reason", "nextTryAt"], at);
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
  /**
   * Task F15 (R328 f): where the time of the last hand-over (ms since the epoch; -Infinity: none) is kept — by the
   * caller (the service), so that it outlives this runner: a runner made for a library closed and opened again sees
   * it. Absent: kept in this runner only.
   */
  libraryHandOver?: { get(): number; set(at: number): void };
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
  /** Removes the entry; a file held for it is destroyed and its review entry closed in the same change (F11, R277 c). */
  remove(projectId: string, entryId: string): Promise<void>;
  /**
   * Task F11: the researcher's decision in the review queue on a file held for an entry ("Use this file": "attach";
   * "Not this file": "discard"), one governed change (refused after `stop` or `stopAll`, like every act).
   */
  resolveHeld(projectId: string, reviewId: string, decision: "attach" | "discard"): Promise<FindEntry | null>;
  /**
   * R305 b: wakes ONLY the project's entries waiting for a place among the waiting files ("held-full", stored
   * "record-complete" or, R310 b, "failed"); nothing in flight is touched (no download aborted or restarted, no service
   * asked again for an entry already at work). R310 a: every way a waiting file goes calls it — `resolveHeld` after each
   * decision, `remove` after removing an entry whose file was waiting, and the service after it deletes a record (whose
   * change resolves that record's waiting file). The project-wide `resume` stays for a save of the rules, an opening and
   * an unlocking. Does nothing for a project the runner is not running (stopped or never resumed).
   */
  wakeHeldFull(projectId: string): Promise<void>;
  /**
   * R312 c (R297 c): an OpenAlex key was saved — the project's entries waiting for OpenAlex's daily allowance
   * ("looking-up", reason "budget", a `nextTryAt`) go on now instead of at the pause's end: their wait is cleared in one
   * write and they are queued (the allowance's pause is kept per key, so the next search asks with the new key). Nothing
   * else is touched: no other waiting entry, nothing in flight. Does nothing for a project the runner is not running.
   */
  wakeAllowance(projectId: string): Promise<void>;
  /**
   * R326: the researcher's "Search sources" were saved — the project's entries resting "switched off" by the settings
   * (the copy part's "record-complete", the record part's "failed" with no record) are put back to work when the
   * settings now switch on what they need: a copy entry is queued (it looks for a copy), a record entry goes back to
   * "looking-up" in one write. An entry the settings still stop is left as it is (nothing asked, nothing written). Entries
   * the project's rules stopped, waiting entries, and everything in flight are not touched. Does nothing for a project the
   * runner is not running, a locked project or a read-only library.
   */
  wakeSettings(projectId: string): Promise<void>;
  /**
   * At open and unlock: clears `stoppedFor`, and restarts every "looking-up" entry, and (F11) every entry in the free
   * copy's part — "record-complete" (its source without a file), "looking-for-copy", and "fetching" (which resumes as
   * "looking-for-copy": a download is never resumed).
   */
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
  /**
   * Task F15 (R324 a, c): the researcher's press "Get through my library" on an entry — never called by the runner
   * itself (no timer, no resume, no "Try again" starts one). Refused with FindLibraryRefusedError, nothing changed:
   * another ticket open anywhere in this runner ("busy" — checked synchronously at the call, so two calls at the same
   * moment give one ticket), within LIBRARY_PAUSE_MS of the last hand-over ("pause", with the whole seconds left), the
   * entry not offered a start by `libraryChancesOf` ("not-offered"), no library set ("no-library"), FIND_HELD_MAX files
   * waiting in the project ("held-full"); a read-only library (ReadOnlyLibraryError), a locked project
   * (ProjectLockedError), a stopped project or runner (as every act). Otherwise, in one governed change (op
   * `project.find.library-start`, the capture of `library_access` asked again inside it), the entry becomes
   * "waiting-sign-in" keeping what it returns to (`returnTo`), and the call returns the library's address for the work
   * and a ticket (32 hex from the system's random source, single use, LIBRARY_TICKET_MS, held in this runner's memory
   * only). Neither is written, logged, audited or sent in an event.
   */
  libraryStart(projectId: string, entryId: string, access: LibraryAccess | null): Promise<{ url: string; ticket: string; entry: FindEntry }>;
  /**
   * Task F15 (R324 b): "Cancel" on an entry "waiting-sign-in": it returns to exactly the state and reason it had (or,
   * nothing kept, "no-open-copy" / "library-unfinished"), and its ticket, if open, ends. Any other state:
   * FindEntryStateError, nothing changed.
   */
  libraryCancel(projectId: string, entryId: string): Promise<FindEntry>;
  /**
   * Task F15's seam for Task F17 (the file handed over): ends the open ticket as handed over and starts the pause
   * (LIBRARY_PAUSE_MS from now), returning the project and entry it was for. The entry is left "waiting-sign-in" for F17
   * to write its outcome (R324 h: the file waits for the researcher's check). For anything else — a wrong, used, expired
   * or malformed ticket, or a closed runner — null, the same null whatever the cause (compared in constant time). Synchronous.
   */
  libraryHandedOver(ticket: unknown): { projectId: string; entryId: string } | null;
  /**
   * Task F17 (R329 d): the library's starting address this runner built at the entry's start and kept with its ticket
   * (in memory only), without user name, password, query or fragment — for an entry handed over through the seam and
   * not yet taken; otherwise null. It is the address a held file's record keeps: never one the shell or a page gave.
   */
  libraryAddressOf(projectId: string, entryId: string): string | null;
  /**
   * Task F17 (R329 c–g): the file handed over for an entry the seam (`libraryHandedOver`) has just answered for. From
   * the seam's answer until this ends the entry is at work: "Cancel" is refused (FindEntryStateError), and a resume (a
   * save of the rules, an unlock) leaves it waiting. The file is taken (`file.take`) into the runner's temporary folder
   * for the entry, its type decided by its complete bytes (a PDF or EPUB, as for a downloaded copy), checked against the
   * record as advice, and HELD as a found copy is — one governed change: the review entry, the held file, the entry's
   * "needs-check" — with the record of how it was got (`library_access`, `via`, `signed-in-session`, `address`). R301:
   * nothing is attached. FIND_HELD_MAX does not refuse it (R329 f). Written only if the entry is still the one that
   * waited (its version as first read after the seam). Otherwise:
   *  - the entry removed, or its record deleted, meanwhile: nothing is held; nothing is written about the file;
   *  - the project locked or the runner closed: nothing is written; the entry comes back at the unlock or the next open;
   *  - not a PDF or EPUB, too large, unreadable, the rules refuse (`library_access`, the store, the legal basis): the
   *    file is destroyed and the entry returns to exactly what it was (`returnTo`); the view says why (`lastFile`, in
   *    memory only, dropped at the entry's next start);
   *  - the record gained a file meanwhile: nothing is held, "in-library".
   * Called without a hand-over for the entry, or with an address other than the one kept (`libraryAddressOf`), the
   * file is discarded and nothing is taken. Never rejects; nothing of the path or the address is logged or audited.
   */
  acceptLibraryFile(projectId: string, entryId: string, path: string, via: "sign-in-window" | "browser-extension", address: string, file: HandedFile): Promise<void>;
  /** Task F15: whether the runner is working on the entry, or has it queued or waiting for a retry (no start is offered then). */
  atWork(projectId: string, entryId: string): boolean;
  /**
   * Task F15 (R328 e): `libraryChancesOf` for the queue's view, with this runner's `atWork` and its cache of the
   * records' facts: a record's file is read only when its stamp (one `stat`) changed since it was last read; the cache
   * holds only what the view needs, per project, dropped at the project's `stop` (a lock) and at `stopAll` (a close).
   * A locked project gives nothing; after `stopAll`, FindRunnerClosedError.
   */
  libraryChances(projectId: string, entries: Iterable<FindEntry>, access: LibraryAccess | null): Promise<Map<string, FindLibraryChanceOf>>;
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
  /** `stopAll()` has returned: from then on nothing at all is written into the library's folder (R247 c). */
  let released = false;
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
  /** F17 (R338 i): the view's last outcome of the entry's handed-over file goes (see `fileOutcomes`). */
  function dropFileOutcome(pid: string, eid: string): void {
    fileOutcomes.delete(keyOfRun(pid, eid));
  }

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
  async function write(pid: string, next: FindEntry[], op: "add" | "update" | "remove" | "library-start", alongside: FindEntry[] = []): Promise<FindEntry[]> {
    const fitted = [...next.map(fit), ...alongside.map(fit)];
    await appendFindEntriesIn(repo, pid, fitted.slice(0, next.length), op, fitted.slice(next.length));
    // F17 (R338 i): the view's last outcome of a handed-over file is dropped at any later write of the entry's line.
    for (const e of fitted) dropFileOutcome(pid, e.id);
    if (op !== "remove") {
      for (const e of fitted) {
        if (e.state !== "looking-up") madeHere.delete(e.id);
        notify(pid, e.id, e.state);
        // F11: a record this queue just completed goes on by itself to look for a free copy.
        if (e.state === "record-complete" && e.sourceId && !e.reason) enqueue(pid, e.id);
      }
    }
    return fitted;
  }
  function notify(pid: string, eid: string, state: FindState): void {
    try {
      deps.onChange({ projectId: pid, entryId: eid, state });
    } catch {
      // a listener's error never undoes a committed change
    }
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
    if (!live() || !entry) return;
    const copying = inCopyPart(entry);
    if (entry.state !== "looking-up" && !copying) return;
    if (entry.nextTryAt && Date.parse(entry.nextTryAt) > now().getTime()) {
      later(pid, eid, entry.nextTryAt);
      return;
    }
    /** The version of the entry this work last saw or wrote: every write is made only on it. */
    let at0 = entry;

    /** Writes `patch` on the entry in a turn, if it is still the version this work last saw or wrote. */
    const finish = async (patch: Partial<FindEntry>, drop: Array<keyof FindEntry> = []) => {
      const w =
        (await inTurn(r, pid, live, async () => {
          const cur = await current(pid, eid);
          if (!cur || !sameVersion(cur, at0)) return null;
          const [w] = await write(pid, [evolve(cur, patch, drop, stamp())], "update");
          return w!;
        })) ?? null;
      if (w) at0 = w;
      return w;
    };

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
      if (copying) {
        await copyOn(pid, eid, at0, r, live, finish, tryLater, {
          get: () => at0,
          set: (e: FindEntry) => {
            at0 = e;
          },
        });
      } else await workOn(pid, eid, at0, r, live, finish, tryLater);
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
  // Task F11: the free copy — looked for, downloaded, checked against the record, and held for the researcher, who
  // alone attaches it ("Use this file"; R301: the app never attaches a found file by itself).

  /** Whether the project's rules allow the acquiring method `free_copy` (asked before ANY free-copy service). */
  function copyAllowed(ctx: LookupContext): boolean {
    if (!ctx.policy) return false;
    const d = evaluate(ctx.policy, {
      action: "capture",
      projectId: ctx.projectId,
      actor: ctx.actor,
      now: (ctx.clock?.() ?? new Date()).toISOString(),
      ...(ctx.tz ? { tz: ctx.tz } : {}),
      capture: { method: "free_copy" },
    });
    return d.result !== "deny";
  }
  const COPY_RULES: FindReason = { code: "copy-not-allowed", by: "rules" };
  /** R282 g (M8): the rules' STORE part refuses the file (or a legal basis is missing), said as such. */
  const COPY_STORE: FindReason = { code: "copy-store-not-allowed", by: "rules" };
  const COPY_NO_BASIS: FindReason = { code: "copy-no-legal-basis", by: "rules" };
  /** The reasons of an entry the rules stopped (R282 f: woken when the rules are saved; "Try again" accepted). */
  const STOPPED_BY_RULES: ReadonlySet<string> = new Set([COPY_RULES.code, COPY_STORE.code, COPY_NO_BASIS.code]);
  const RECORD_REMOVED: FindReason = { code: "record-removed" };
  /** R296 d: FIND_HELD_MAX files already wait for the researcher: the entry waits, "record-complete", asking nothing. */
  const HELD_FULL: FindReason = { code: "held-full" };
  /**
   * Why the rules refused a free copy's file at its hold (M8): the capture of `free_copy`, or its store. (At "Use this
   * file" the same rules are evaluated again by `resolveHeldFile`, and a refusal is the service's usual sentence.)
   */
  async function copyRefusal(pid: string, err: PolicyDeniedError, prov: Provenance): Promise<FindReason> {
    if (err.action !== "store") return COPY_RULES;
    return (await refusalOf(pid, err, { identifiable: prov.identifiable, ...(prov.legal.basis ? { legalBasis: prov.legal.basis } : {}) })) === NO_LEGAL_BASIS ? COPY_NO_BASIS : COPY_STORE;
  }
  /** Whether the rules' store part refuses a file for the record now (asked before ANY free-copy service, M8). */
  async function storeRefusal(ctx: LookupContext, pid: string, prov: Provenance): Promise<FindReason | null> {
    const d = evaluate(ctx.policy!, {
      action: "store",
      projectId: ctx.projectId,
      actor: ctx.actor,
      now: (ctx.clock?.() ?? new Date()).toISOString(),
      ...(ctx.tz ? { tz: ctx.tz } : {}),
      store: { identifiable: prov.identifiable, hasLocation: false, ...(prov.legal.basis ? { legalBasis: prov.legal.basis } : {}) },
    });
    return d.result === "deny" ? copyRefusal(pid, new PolicyDeniedError(d.reason ?? "", "store"), prov) : null;
  }
  /** Entry → the abort of its download in flight (R282 g, M2: removing the entry aborts it). */
  const downloads = new Map<string, AbortController>();

  /** The free-copy services the settings switch on, in the plan's order (F12's settings; until then its defaults). */
  function copySources(s: SearchSettings): FreeCopySource[] {
    const on = new Set((s.copies ?? []).filter((x) => x.on).map((x) => x.id));
    return FREE_COPY_SOURCES.filter((x) => on.has(x));
  }

  /** The record as the free-copy lookups and the file check take it (from the source as stored now). */
  const workOfSource = workOfSourceFile;

  /** "Where to get it": the free copies on other hosts (and, when nothing could be downloaded, the offers), at most FREE_COPY_ELSEWHERE_MAX. */
  function linksOf(elsewhere: Array<{ host: string; url: string }>, offers: CopyOffer[] = []): FindEntry["offers"] {
    const out: NonNullable<FindEntry["offers"]> = [];
    const seen = new Set<string>();
    const add = (url: string) => {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      if (seen.has(url) || url.length > 2000 || host.length > 253 || out.length >= FREE_COPY_ELSEWHERE_MAX) return;
      seen.add(url);
      out.push({ label: "A free copy may be at", url, host });
    };
    for (const l of elsewhere) add(l.url);
    for (const o of offers) add(o.url);
    return out;
  }

  /** How the file was got (its address cleaned), for `Asset.acquired` and a held file's facts. */
  function acquiredFor(offer: CopyOffer): Omit<AcquiredFrom, "check"> {
    return { method: "free_copy", via: "service", service: offer.source, address: cleanAcquiredAddress(offer.url), at: stamp(), tool: { name: FIND_TOOL, version: VERSION }, access: "public" };
  }

  /**
   * One download, bounded AS A WHOLE (its wait for a place included) by FIND_DOWNLOAD_TIMEOUT_MS, and aborted through
   * its signal at a stop, a lock or a close. F10 removes what it wrote on every ending but success.
   */
  async function download(url: string, into: string, stop: AbortSignal): Promise<Awaited<ReturnType<typeof fetchFile>>> {
    const ac = new AbortController();
    const onStop = () => ac.abort(stop.reason);
    if (stop.aborted) onStop();
    else stop.addEventListener("abort", onStop, { once: true });
    const h = timers.setTimeout(() => ac.abort(new TimedOut()), FIND_DOWNLOAD_TIMEOUT_MS);
    try {
      // R317: in test mode with the lookup-fixtures switch on, the lookup client's recorded file answers (else undefined).
      return await fetchFile(url, { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: FETCH_FILE_DEADLINE_MS, into, signal: ac.signal, recorded: http.recordedFiles });
    } finally {
      timers.clearTimeout(h);
      stop.removeEventListener("abort", onStop);
    }
  }

  /**
   * The free-copy part of an entry's life (R277): its record made, its source without a readable file. R301: no path
   * of it attaches a file to the source; only the researcher's "Use this file" on the held file does (`resolveHeld`).
   *
   *   record-complete ──► looking-for-copy ──► no-open-copy   (no offer: the "elsewhere" links are kept)
   *                                       ──► fetching ──► needs-check   (R296 a: the first file the check matches is held,
   *                                                                       "file-looks-right"; no offer matches: the FIRST
   *                                                                       file that did not is held, "file-<why>")
   *                                                    ──► record-complete / held-full (the hold found FIND_HELD_MAX
   *                                                                       files waiting meanwhile: the file is dropped)
   *                                                    ──► in-library    (R305 c: the source gained a readable file
   *                                                                       meanwhile: refused inside the hold's change,
   *                                                                       nothing held, the file dropped)
   *                                                    ──► no-open-copy  (no offer could be downloaded: its links kept)
   *   record-complete / held-full (R296 d): FIND_HELD_MAX files already wait — looked at BEFORE any free-copy service
   *   is asked or any file downloaded; the entry waits, asking nothing, until a waiting file goes — a decision on it,
   *   the removal of its entry, the deletion of its record (`wakeHeldFull`, R305 b, R310 a: only such entries) — or
   *   "Try again", opening or unlocking wakes it.
   *
   * Nothing is asked of any free-copy service, and nothing downloaded, unless the rules allow `free_copy` (else the
   * entry stays "record-complete" with the reason "copy-not-allowed", and is looked at again at a save of the rules,
   * "Try again", an opening and an unlocking). Settings that switch every copy service off leave a "record-complete" entry as it is. A source that has
   * a readable file is "in-library". A crash, a lock or a close in the middle resumes as "looking-for-copy".
   */
  async function copyOn(
    pid: string,
    eid: string,
    entry: FindEntry,
    r: Run,
    live: () => boolean,
    finish: (patch: Partial<FindEntry>, drop?: Array<keyof FindEntry>) => Promise<FindEntry | null>,
    tryLater: (code: FindReasonCode, patch?: Partial<FindEntry>) => Promise<void>,
    version: { get(): FindEntry; set(e: FindEntry): void },
  ): Promise<void> {
    const sid = entry.sourceId!;
    let sf: SourceFile;
    try {
      sf = await guard(r, repo.getSource(pid, sid));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      // The record is no longer in the library: no file will be fetched for it; the entry says so (R282 g).
      await finish({ state: "no-open-copy", reason: RECORD_REMOVED }, ["nextTryAt", "offers"]);
      return;
    }
    if (!live()) return;
    if (sourceHasFile(sf)) {
      // Its source has a readable file already (the researcher's own: added by hand, or a held file used).
      await finish({ state: "in-library" }, ["nextTryAt", "reason"]);
      return;
    }
    const ctx = await guard(r, lookupContextFor(repo, pid, http, deps.debug ? { debug } : {}));
    if (!live()) return;
    if (!ctx.policy) {
      block(pid, "rules-unreadable");
      return;
    }
    // Said in words on the entry; not tried again until the rules change (their save, "Try again", the next open or
    // unlock: R282 f). The store part too, before anything is asked (M8).
    const refused = copyAllowed(ctx) ? await storeRefusal(ctx, pid, sf.source.provenance) : COPY_RULES;
    if (refused) {
      if (!(entry.state === "record-complete" && entry.reason?.code === refused.code)) await finish({ state: "record-complete", reason: refused }, ["nextTryAt"]);
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
    const sources = copySources(s);
    if (!sources.length) {
      // R312 c: every copy service switched off in Search sources: the entry rests with its record complete and says
      // so ("switched off" by the settings) — a record just made included; written once (nothing when it already says so).
      if (!(entry.state === "record-complete" && entry.reason?.code === SETTINGS.code)) await finish({ state: "record-complete", reason: SETTINGS }, ["nextTryAt"]);
      return;
    }
    // R296 d: no service is asked and nothing downloaded while FIND_HELD_MAX files already wait for the researcher's
    // check (one read of the project's review file); the entry waits with its record complete, and is woken by a
    // decision on a waiting file, "Try again", opening or unlocking. Woken while the limit is still reached, it goes
    // back to waiting having asked nothing (and writes nothing when it was already waiting).
    if ((await guard(r, heldWaitingCountIn(repo, pid))) >= FIND_HELD_MAX) {
      if (!live()) return;
      if (!(entry.state === "record-complete" && entry.reason?.code === HELD_FULL.code)) await finish({ state: "record-complete", reason: HELD_FULL }, ["nextTryAt", "offers"]);
      return;
    }
    if (!live()) return;
    if (entry.state !== "looking-for-copy") {
      if (!(await finish({ state: "looking-for-copy", attempts: 0 }, ["nextTryAt", "reason", "offers"]))) return;
    }
    const email = typeof s.unpaywallEmail === "string" && s.unpaywallEmail ? s.unpaywallEmail : undefined;
    let found: Awaited<ReturnType<typeof findFreeCopies>>;
    try {
      // findFreeCopies takes no signal and never rejects: bounded here by the runner's own limit (R254 c).
      found = await guard(r, findFreeCopies(workOfSource(sf), ctx, sources, email), FIND_LOOKUP_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimedOut) {
        debug("find: the free-copy services did not answer in time");
        await tryLater("unreachable");
        return;
      }
      throw err;
    }
    if (!live()) return;
    if (!found.offers.length) {
      // R282 e: every service asked failed: "could not be reached", tried again by the ordinary retries. Some failed:
      // "no open copy", saying that a copy may still exist ("Try again" is accepted). Unpaywall is asked only with an e-mail.
      const asked = sources.filter((x) => x !== "unpaywall" || email);
      if (found.failed.length && found.failed.length >= asked.length) {
        debug("find: no free-copy service could be reached");
        await tryLater("unreachable");
        return;
      }
      const links = linksOf(found.elsewhere);
      await finish({ state: "no-open-copy", ...(found.failed.length ? { reason: { code: "copy-some-unreachable" } } : {}), ...(links?.length ? { offers: links } : {}) }, ["nextTryAt", "reason", "offers"]);
      return;
    }
    if (!(await finish({ state: "fetching" }, ["nextTryAt", "reason", "offers"]))) return;

    const record = { title: primary(sf.source.title) ?? "", creators: sf.source.creators, ...(sf.source.identifiers.doi ? { doi: sf.source.identifiers.doi } : {}), ...(sf.source.container && primary(sf.source.container) ? { container: primary(sf.source.container)! } : {}) };
    const folderName = `find-${eid}`;
    const folder = join(repoLibrary(repo).root, ".tmp", folderName);
    // The folder is held in use from before the first download until the file is stored or dropped (R257 b, R261 e).
    const release = holdFindTemp(folderName);
    const stop = new AbortController();
    void r.stopSignal.then(() => stop.abort(new Abandoned()));
    // R282 g: removing the entry (M2), or its record (M1, looked at every FIND_SOURCE_WATCH_MS), aborts the download.
    const dk = keyOfRun(pid, eid);
    downloads.set(dk, stop);
    let gone = false;
    let watch: unknown;
    const look = () => {
      watch = timers.setTimeout(() => {
        if (stop.signal.aborted) return;
        if (liveIds(pid).has(sid)) return look();
        gone = true;
        stop.abort(new Abandoned());
      }, FIND_SOURCE_WATCH_MS);
    };
    look();
    const removedRecord = () => finish({ state: "no-open-copy", reason: RECORD_REMOVED }, ["nextTryAt", "offers"]);
    let held: { path: string; offer: CopyOffer; check: FileCheckResult } | undefined;
    try {
      let n = 0;
      for (const offer of found.offers) {
        if (!live()) return;
        const into = join(folder, `${++n}.${offer.kind}`);
        let got: Awaited<ReturnType<typeof fetchFile>>;
        try {
          got = await download(offer.url, into, stop.signal);
        } catch (err) {
          if (!live()) return;
          if (stop.signal.aborted) {
            if (gone) await removedRecord();
            return;
          }
          // Refused or failed (its sentence names no address): the next offer is tried.
          debug(`find: a free copy could not be downloaded (${err instanceof FetchFileError ? err.code : errName(err)})`);
          continue;
        }
        let check: FileCheckResult;
        try {
          check = await guard(r, checkFileAgainstRecord(got.path, record), FIND_CHECK_TIMEOUT_MS);
        } catch (err) {
          if (err instanceof Abandoned) return;
          if (!(err instanceof TimedOut)) throw err;
          debug("find: the file check did not end in time");
          check = { match: false, why: "no-text", evidence: { kind: offer.kind, bytes: got.bytes } };
        }
        if (!live() || stop.signal.aborted) {
          if (live() && gone) await removedRecord();
          return;
        }
        if (check.match) {
          // R296 a, R301: the app never attaches a found file by itself. The file the check matched waits for the
          // researcher like any other, with the advice that it looks right; a file kept before it that did not match is
          // dropped (one held file per entry).
          if (held) await fsp.rm(held.path, { force: true });
          await holdOne(pid, eid, r, live, version, sid, sf.source.provenance, { path: got.path, offer, check });
          return;
        }
        // A file that fails the check is dropped — except the first, kept until every offer was tried (R277 b).
        if (!held) held = { path: got.path, offer, check };
        else await fsp.rm(got.path, { force: true });
      }
      if (!live()) return;
      if (held) {
        await holdOne(pid, eid, r, live, version, sid, sf.source.provenance, held);
        return;
      }
      // Nothing could be downloaded: no open copy here; the addresses stay as links for the researcher.
      const links = linksOf(found.elsewhere, found.offers);
      await finish({ state: "no-open-copy", ...(links?.length ? { offers: links } : {}) }, ["nextTryAt", "reason", "offers"]);
    } finally {
      timers.clearTimeout(watch);
      if (downloads.get(dk) === stop) downloads.delete(dk);
      stop.abort(new Abandoned());
      release();
      // The folder is removed when the entry is done (also at a stop or a close, while stopAll waits for the work in
      // flight); once the library's lock is released nothing is written (the next open sweeps what is left, R59).
      if (!released) await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * What the entry says when a file could not be held (R282 g), or null for an error not foreseen: the record removed
   * meanwhile (M1); the record gained a readable file meanwhile ("in-library", R305 c: refused inside the hold's change,
   * nothing held, the download dropped with its folder); the rules (M8).
   */
  async function copyEnded(pid: string, err: unknown, prov: Provenance): Promise<Partial<FindEntry> | null> {
    if (err instanceof NotFoundError) return { state: "no-open-copy", reason: RECORD_REMOVED };
    if (err instanceof HeldFileSourceHasFileError) return { state: "in-library" };
    if (err instanceof PolicyDeniedError) return { state: "record-complete", reason: await copyRefusal(pid, err, prov) };
    return null;
  }

  /**
   * A found file held for the researcher (R277; R296 a: the first file the check matched, or else the first that did
   * not): the file, its review entry and the entry's line in ONE change. The check's answer goes with it as advice
   * (R296 b): "looks-right" (with what it matched by) or why it did not clearly match.
   */
  async function holdOne(
    pid: string,
    eid: string,
    r: Run,
    live: () => boolean,
    version: { get(): FindEntry; set(e: FindEntry): void },
    sid: string,
    prov: Provenance,
    held: { path: string; offer: CopyOffer; check: FileCheckResult },
  ): Promise<void> {
    await inTurn(r, pid, live, async () => {
      const cur = await current(pid, eid);
      if (!cur || !sameVersion(cur, version.get())) return;
      const ev = held.check.evidence;
      const facts: HeldFileFacts = {
        ...(held.check.match ? { why: "looks-right", by: held.check.by } : { why: held.check.why }),
        kind: ev.kind,
        bytes: ev.bytes,
        ...(ev.fileDoi ? { fileDoi: ev.fileDoi } : {}),
        ...(ev.embeddedTitle ? { embeddedTitle: ev.embeddedTitle } : {}),
        ...(ev.textStart ? { textStart: ev.textStart } : {}),
        acquired: acquiredFor(held.offer),
      };
      const next = fit(evolve(cur, { state: "needs-check", reason: { code: `file-${facts.why}` } }, ["nextTryAt", "offers"], stamp()));
      try {
        await holdMismatchedFileIn(repo, pid, { entry: next, sourceId: sid, fromPath: held.path, facts });
      } catch (err) {
        if (err instanceof HeldFileEntryGoneError) return;
        if (err instanceof HeldFileLimitError) {
          // R296 d: the last place was taken while this file was fetched (the limit is looked at before asking): not
          // kept (the folder goes as the work ends); the entry waits, as one that found the limit before asking does.
          const [w] = await write(pid, [evolve(cur, { state: "record-complete", reason: HELD_FULL }, ["nextTryAt", "offers"], stamp())], "update");
          if (w) version.set(w);
          return;
        }
        const said = await copyEnded(pid, err, prov);
        if (!said) throw err;
        const [w] = await write(pid, [evolve(cur, said, ["nextTryAt", "reason", "offers"], stamp())], "update");
        if (w) version.set(w);
        return;
      }
      version.set(next);
      notify(pid, eid, "needs-check");
    });
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
      const waiting = (cur.state === "looking-up" || cur.state === "looking-for-copy") && !!cur.nextTryAt;
      // R282 e, f: "no open copy" because some services could not be reached, and an entry the rules stopped (their
      // free-copy or store part: the rules are evaluated again), look for a copy again; so does (R296 d) an entry
      // waiting because FIND_HELD_MAX files wait (the limit is looked at again, before anything is asked).
      const copyAgain =
        !!cur.sourceId &&
        ((cur.state === "no-open-copy" && cur.reason?.code === "copy-some-unreachable") ||
          (cur.state === "record-complete" && (STOPPED_BY_RULES.has(cur.reason?.code ?? "") || cur.reason?.code === HELD_FULL.code)) ||
          copyRestsSwitchedOff(cur));
      // R283 a: a "choose" made while people of the name could not be looked up: Try again looks again (afresh).
      const peopleUnseen = cur.state === "choose" && cur.reason?.code === "people-unavailable";
      if (cur.state !== "failed" && cur.state !== "not-found" && !waiting && !copyAgain && !peopleUnseen) throw new FindEntryStateError();
      cancelLater(projectId, entryId);
      // F11: an entry whose record is made failed in the free copy's part (the services unreachable, …; "held-full" as
      // stored by builds before R296 d): it looks for a copy again, never for its record.
      if (cur.sourceId && (cur.state === "failed" || cur.state === "looking-for-copy" || copyAgain)) {
        const [next] = await write(projectId, [evolve(cur, { state: "looking-for-copy", attempts: 0 }, ["reason", "nextTryAt", "offers"], stamp())], "update");
        return next!;
      }
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
    const freed = await act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      cancelLater(projectId, entryId);
      const r = runs.get(projectId);
      if (r) r.pending = r.pending.filter((e) => e !== entryId);
      // Only the entry goes: a source it made stays in the library. A file held for it goes with it, and its review
      // entry is closed, in the same change (F11, R277 c).
      if (cur.state !== "needs-check") {
        await write(projectId, [cur], "remove");
        return false;
      }
      await removeFindEntryIn(repo, projectId, cur);
      return true;
    });
    // R282 g (M2): its download in flight is aborted (its folder removed and given up as the work ends).
    downloads.get(keyOfRun(projectId, entryId))?.abort(new Abandoned());
    // F15: an entry waiting in the sign-in window that is removed ends its ticket.
    if (ticketFor(projectId, entryId)) dropTicket();
    // R310 a: its waiting file went with it, so a place is free: the entries waiting for one go on (the same light
    // wake as after a decision; nothing in flight is touched). An entry that had no waiting file wakes nothing.
    if (freed) await wakeHeldFull(projectId);
  }

  async function resolveHeld(projectId: string, reviewId: string, decision: "attach" | "discard"): Promise<FindEntry | null> {
    assertOpen();
    if (typeof reviewId !== "string" || !isId(reviewId)) throw new NotFoundError("Review entry", "unknown");
    const done = await act(projectId, async () => {
      const { entry } = await resolveHeldFileIn(repo, projectId, reviewId, decision);
      if (entry) notify(projectId, entry.id, entry.state);
      return entry;
    });
    // R296 d, R305 b: the decision freed a place: the entries waiting for one go on (and nothing else is touched).
    await wakeHeldFull(projectId);
    return done;
  }

  async function wakeHeldFull(projectId: string): Promise<void> {
    if (closed || readOnly()) return;
    const r = runs.get(projectId);
    if (!r || r.stopped) return;
    let q: Map<string, FindEntry>;
    try {
      q = await readFindQueueIn(repo, projectId);
    } catch {
      return; // locked or unreadable meanwhile: the next open or unlock resumes the project
    }
    for (const e of q.values()) if (waitsForPlace(e)) enqueue(projectId, e.id);
  }

  async function wakeAllowance(projectId: string): Promise<void> {
    if (closed || readOnly()) return;
    const r = runs.get(projectId);
    if (!r || r.stopped) return;
    let woken: string[];
    try {
      woken = await act(projectId, async () => {
        const waiting = [...(await readFindQueueIn(repo, projectId)).values()].filter(waitsForAllowance);
        if (waiting.length) await write(projectId, waiting.map((e) => evolve(e, {}, ["nextTryAt", "reason"], stamp())), "update");
        return waiting.map((e) => e.id);
      });
    } catch {
      return; // stopped, locked or unreadable meanwhile: the pause's end, Try again, the next open or unlock look again
    }
    for (const id of woken) {
      cancelLater(projectId, id);
      enqueue(projectId, id);
    }
  }

  async function wakeSettings(projectId: string): Promise<void> {
    if (closed || readOnly()) return;
    const r = runs.get(projectId);
    if (!r || r.stopped) return;
    // The settings are read once, before the project's turn is taken: what they switch on decides who is woken.
    let s: SearchSettings;
    try {
      s = await guard(r, deps.settings(), FIND_SETTINGS_TIMEOUT_MS);
    } catch {
      return; // stopped, or the settings did not answer: "Try again", the next open or unlock look again
    }
    const copiesOn = copySources(s).length > 0;
    const recordOn = new Set(s.record.filter((x) => x.on && (x.id === "crossref" || x.id === "openalex" || x.id === "elicit")).map((x) => x.id));
    // The record part needs OpenAlex for a work added from a person's list or a person chosen (as `workOn` decides).
    const recordNeeds = (e: FindEntry) => (workOfAdded(e) !== undefined || (isPersonId(e.chosen) && !!e.people?.some((x) => x.id === e.chosen)) ? recordOn.has("openalex") : recordOn.size > 0);
    let woken: string[];
    try {
      woken = await act(projectId, async () => {
        const q = [...(await readFindQueueIn(repo, projectId)).values()];
        const copy = copiesOn ? q.filter(copyRestsSwitchedOff) : [];
        const record = q.filter(recordRestsSwitchedOff).filter(recordNeeds);
        if (record.length) await write(projectId, record.map((e) => evolve(e, { state: "looking-up", attempts: 0 }, ["reason", "nextTryAt"], stamp())), "update");
        return [...copy, ...record].map((e) => e.id);
      });
    } catch {
      return; // stopped, locked or unreadable meanwhile: "Try again", the next open or unlock look again
    }
    for (const id of woken) {
      cancelLater(projectId, id);
      enqueue(projectId, id);
    }
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
      // F15 (R324 b): an entry waiting in the sign-in window whose ticket is not open here (start-up, after a lock or a
      // close: tickets are in memory only) returns to what it was — never resumed as a fetch. One with an open ticket
      // (a resume after the rules were saved) is left waiting. Back in the copy part, it goes on as at any resume.
      for (const e of q.values()) {
        if (e.state !== "waiting-sign-in" || ticketFor(projectId, e.id) || handed.has(keyOfRun(projectId, e.id))) continue;
        const back = await inTurn(r, projectId, () => alive(projectId, gen), async () => {
          const cur = await current(projectId, e.id);
          if (!cur || cur.state !== "waiting-sign-in" || ticketFor(projectId, e.id) || handed.has(keyOfRun(projectId, e.id))) return null;
          const [w] = await write(projectId, [returnedFrom(cur, stamp())], "update");
          return w ?? null;
        });
        if (!alive(projectId, gen)) return;
        if (back && inCopyPart(back)) enqueue(projectId, back.id);
      }
      const waiting = [...q.values()].filter((e) => e.state === "looking-up");
      // R247 (e): a record can be made for an entry in other states too (a choose, a duplicate answer, "add it here as
      // well"); a lock or a crash between its creation and the entry's line leaves the entry as it was, without a
      // `sourceId`. Only the states a record is made from are candidates ("choose", "maybe-duplicate", and "already"
      // with `elsewhere`): "not-found", "failed" and "already" here neither are nor move the scan's bound back (m1).
      const madeFrom = (e: FindEntry) => e.state === "choose" || e.state === "maybe-duplicate" || (e.state === "already" && e.elsewhere === true);
      const unmade = [...q.values()].filter((e) => madeFrom(e) && !e.sourceId);
      // F11: the free copy's part goes on (a "fetching" entry resumes as "looking-for-copy": a download is never resumed).
      for (const e of q.values()) {
        if (!inCopyPart(e)) continue;
        if (e.nextTryAt && Date.parse(e.nextTryAt) > now().getTime()) later(projectId, e.id, e.nextTryAt);
        else enqueue(projectId, e.id);
      }
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
    // F15 (R328 e): nothing read from a locked project's records is kept.
    records.dropProject(projectId);
    // F15 (R324 b): a lock ends the project's open ticket; its entry comes back at the next resume (nothing can be
    // written for a locked project now).
    if (libTicket?.projectId === projectId) dropTicket();
  }

  async function stopAll(): Promise<void> {
    closed = true;
    // F15 (R324 b, c): a close ends the open ticket at once (in memory only); its entry comes back at the next open.
    dropTicket();
    // F15 (R328 e): nothing read from the records outlives the close.
    records.clear();
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
    released = true;
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

  // ------------------------------------------------------------------------------------------------------------
  // Task F15 (R324 a–c): a fetch through the researcher's library — only the "waiting-sign-in" state: entered on the
  // researcher's press, left by cancel, the ticket's end, start-up (`resume`), a lock or a close. The runner never
  // fetches anything from the library: it hands back an address and a ticket. ONE ticket at a time, in memory only.

  /** The open ticket (at most one). */
  let libTicket: { ticket: string; projectId: string; entryId: string; expires: number; timer: unknown; address: string } | undefined;
  /**
   * F17 (R329 c, d): the entries handed over through the seam whose file is not yet taken or refused (`keyOfRun`), each
   * with the starting address kept from its ticket. At work while here. In memory only.
   */
  const handed = new Map<string, { address: string; taking?: true }>();
  /**
   * F17 (R329 g): what became of the last file of an entry that could not be held. In memory only; set only with the
   * entry's own return (`bringBack`, which writes the entry back: never for an entry that is gone), dropped at any later
   * write of the entry's line, its removal included (`write`, R338 i). An entry with an outcome rests; every write of a
   * resting entry goes through `write` (the other writers of the queue — a hold, a decision, a removal with its waiting
   * file, a record's removal — touch only an entry that is fetching or holds a waiting file).
   */
  const fileOutcomes = new Map<string, FindLibraryFileOutcome>();
  /** A start between its synchronous check and its ticket: another start meanwhile is "busy". */
  let libClaimed = false;
  /** When the last hand-over was (the pause): the caller's (R328 f), else this runner's own. */
  let ownHandOver = Number.NEGATIVE_INFINITY;
  const handOver = deps.libraryHandOver ?? { get: () => ownHandOver, set: (at: number) => void (ownHandOver = at) };

  function dropTicket(): void {
    if (libTicket) timers.clearTimeout(libTicket.timer);
    libTicket = undefined;
  }
  const ticketFor = (pid: string, eid: string) => libTicket !== undefined && libTicket.projectId === pid && libTicket.entryId === eid;

  /** R328 e: the records' facts the queue's view read last (see `libraryChances`). */
  const records = createRecordFactsCache();

  async function libraryChances(projectId: string, entries: Iterable<FindEntry>, access: LibraryAccess | null): Promise<Map<string, FindLibraryChanceOf>> {
    assertOpen();
    const out = await libraryChancesOf(repo, projectId, entries, { access, atWork: (id) => atWork(projectId, id), records });
    // F17 (R329 g): what became of the last file of an entry that could not be held.
    for (const [id, c] of out) {
      const last = fileOutcomes.get(keyOfRun(projectId, id));
      if (last) c.lastFile = last;
    }
    // Closed or the project locked while it was read: what was read is not kept.
    if (closed) records.clear();
    else if (!repo.isUnlocked(projectId)) records.dropProject(projectId);
    return out;
  }

  function atWork(projectId: string, entryId: string): boolean {
    const r = runs.get(projectId);
    const k = keyOfRun(projectId, entryId);
    return running.has(k) || handed.has(k) || !!r?.pending.includes(entryId) || !!r?.timers.has(entryId);
  }

  async function libraryStart(projectId: string, entryId: string, access: LibraryAccess | null): Promise<{ url: string; ticket: string; entry: FindEntry }> {
    assertOpen();
    assertId(entryId);
    if (readOnly()) throw new ReadOnlyLibraryError();
    // Checked and claimed without awaiting anything: two presses at the same moment, in any projects, give one ticket.
    if (libTicket || libClaimed) throw new FindLibraryRefusedError("busy");
    const at = now().getTime();
    // R328 f: a clock stepped backwards (the last hand-over now in the future) counts the pause from now: never more
    // than the pause's own length is said, and it ends after it.
    if (handOver.get() > at) handOver.set(at);
    const since = at - handOver.get();
    if (since < LIBRARY_PAUSE_MS) throw new FindLibraryRefusedError("pause", Math.min(LIBRARY_PAUSE_MS / 1000, Math.max(1, Math.ceil((LIBRARY_PAUSE_MS - since) / 1000))));
    libClaimed = true;
    try {
      return await act(projectId, async () => {
        const q = await readFindQueueIn(repo, projectId);
        const cur = q.get(entryId);
        if (!cur) throw new NotFoundError("Queue entry", entryId);
        const ch = (await libraryChancesOf(repo, projectId, q.values(), { access, atWork: (id) => atWork(projectId, id), only: entryId })).get(entryId);
        if (!ch?.chance) throw new FindLibraryRefusedError("not-offered");
        if (ch.chance === "no-library" || !access) throw new FindLibraryRefusedError("no-library");
        // R324 a: the file the library gives will wait for the researcher's check too.
        if ((await heldWaitingCountIn(repo, projectId)) >= FIND_HELD_MAX) throw new FindLibraryRefusedError("held-full");
        const url = libraryAddressFor(access, ch.work);
        if (!url) throw new FindLibraryRefusedError("not-offered");
        const returnTo: FindReturnTo = { state: cur.state as FindReturnTo["state"], ...(cur.reason ? { reason: cur.reason } : {}) };
        const [entry] = await write(projectId, [evolve(cur, { state: "waiting-sign-in", returnTo }, ["reason", "nextTryAt"], stamp())], "library-start");
        // Stopped (a lock) or closed while it was written: no ticket; the entry comes back at the next resume.
        if (closed || runs.get(projectId)?.stopped) throw new FindProjectStoppedError();
        const ticket = randomBytes(16).toString("hex");
        const timer = timers.setTimeout(() => void ticketEnded(ticket), LIBRARY_TICKET_MS);
        // F17 (R329 d): the address a file got this way records — this start's own, without its query (so without
        // the work's DOI) or any user name, password or fragment; in memory only, with the ticket.
        libTicket = { ticket, projectId, entryId, expires: now().getTime() + LIBRARY_TICKET_MS, timer, address: cleanAcquiredAddress(url) };
        return { url, ticket, entry: entry! };
      });
    } finally {
      libClaimed = false;
    }
  }

  /**
   * The entry back to what it was, in an act's turn, if it is still waiting and has no open ticket. With `outcome` (the
   * hand-over's own return, R329 g): what became of its file, kept for the view only when the entry was written back.
   * (Never called for an entry handed over and not yet done: the ticket's end cannot meet one, and the hand-over clears
   * its mark first — R338 e.)
   */
  async function bringBack(projectId: string, entryId: string, outcome?: FindLibraryFileOutcome): Promise<FindEntry | null> {
    return act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur || cur.state !== "waiting-sign-in" || ticketFor(projectId, entryId)) return null;
      const [w] = await write(projectId, [returnedFrom(cur, stamp())], "update");
      if (w && outcome) fileOutcomes.set(keyOfRun(projectId, entryId), outcome);
      return w ?? null;
    });
  }

  /** The ticket ran out (its timer, or the seam found it past its end): it ends, and its entry comes back. */
  async function ticketEnded(ticket: string): Promise<void> {
    const t = libTicket;
    if (!t || t.ticket !== ticket) return;
    dropTicket();
    // A stopped project (locked) or a closed runner writes nothing: the entry comes back at the next resume.
    await bringBack(t.projectId, t.entryId).catch(() => undefined);
  }

  async function libraryCancel(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    return act(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "waiting-sign-in") throw new FindEntryStateError();
      // F17 (R329 c): its file is being taken: the hand-over's outcome is written first.
      if (handed.has(keyOfRun(projectId, entryId))) throw new FindEntryStateError();
      if (ticketFor(projectId, entryId)) dropTicket();
      const [w] = await write(projectId, [returnedFrom(cur, stamp())], "update");
      return w!;
    });
  }

  function libraryHandedOver(ticket: unknown): { projectId: string; entryId: string } | null {
    const t = libTicket;
    if (closed || !t || typeof ticket !== "string" || !/^[0-9a-f]{32}$/u.test(ticket)) return null;
    if (!timingSafeEqual(Buffer.from(ticket, "utf8"), Buffer.from(t.ticket, "utf8"))) return null;
    const at = now().getTime();
    if (at >= t.expires) {
      void ticketEnded(t.ticket);
      return null;
    }
    dropTicket();
    handOver.set(at);
    // F17 (R329 c): from this answer until its outcome is written, the entry is at work.
    handed.set(keyOfRun(t.projectId, t.entryId), { address: t.address });
    return { projectId: t.projectId, entryId: t.entryId };
  }

  function libraryAddressOf(projectId: string, entryId: string): string | null {
    return handed.get(keyOfRun(projectId, entryId))?.address ?? null;
  }

  /** F17 (R329 g): why the rules refused the file at its hold, as the view says it. */
  async function heldRefusal(pid: string, err: PolicyDeniedError, prov: Provenance): Promise<FindLibraryFileOutcome> {
    if (err.action !== "store") return "rules-method";
    return (await refusalOf(pid, err, { identifiable: prov.identifiable, ...(prov.legal.basis ? { legalBasis: prov.legal.basis } : {}) })) === NO_LEGAL_BASIS ? "rules-legal-basis" : "rules-store";
  }

  function acceptLibraryFile(projectId: string, entryId: string, path: string, via: "sign-in-window" | "browser-extension", address: string, file: HandedFile): Promise<void> {
    const k = keyOfRun(projectId, entryId);
    const mine = handed.get(k);
    const drop = () => file.discard(path).catch(() => undefined);
    if (!mine || mine.taking || closed) {
      // Not handed over through the seam (or already being taken): nothing is read; the file goes. A closed runner
      // clears the mark of the hand-over it will never take (R338 f).
      if (mine && !mine.taking) handed.delete(k);
      return drop();
    }
    // Taken once: a second call for the same hand-over is refused like one without a hand-over.
    mine.taking = true;
    const p = takeLibraryFile(projectId, entryId, path, via, address, mine.address, file, k).catch((err: unknown) => {
      debug(`find: a file from the library could not be kept (${errName(err)})`);
    });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  }

  async function takeLibraryFile(
    projectId: string,
    entryId: string,
    path: string,
    via: "sign-in-window" | "browser-extension",
    address: string,
    kept: string,
    file: HandedFile,
    k: string,
  ): Promise<void> {
    // At work until the end (R329 c): the entry stays in `handed` (`atWork`, Cancel and a resume see it there).
    let taken = false;
    let written = false;
    let outcome: FindLibraryFileOutcome | undefined;
    let folder: string | undefined;
    let release: (() => void) | undefined;
    const folderName = `find-${entryId}`;
    // R338 h: the check stops when the project is locked or the library closed, as the copy part's does.
    const r = runOf(projectId);
    // R338 f: every statement after the seam's mark is inside this `try`; the outer `finally` clears the mark and
    // discards the handed file whatever was thrown.
    try {
      folder = join(repoLibrary(repo).root, ".tmp", folderName);
      release = holdFindTemp(folderName);
      // The address is the one this runner built at the start, never one the caller was told by anyone else.
      if (address !== kept) {
        outcome = "unreadable";
        return;
      }
      // The entry as it is now (the version the outcome is written against) and its record.
      const first = await act(projectId, () => current(projectId, entryId));
      if (!first || first.state !== "waiting-sign-in" || !first.sourceId) return;
      let sf: SourceFile;
      try {
        sf = await repo.getSource(projectId, first.sourceId);
      } catch (err) {
        if (err instanceof NotFoundError) return; // the record was deleted: nothing is held
        throw err;
      }
      await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
      const st = await fsp.lstat(folder);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("not a folder");
      const into = join(folder, "handed-over");
      taken = true;
      const got = await file.take(path, into, LIBRARY_FILE_MAX_BYTES);
      if (!got.ok) {
        outcome = got.why;
        return;
      }
      // The type by the complete file's bytes, as for a downloaded copy: a file the shell called a PDF may be refused.
      const mime = await fileTypeByBytes(into).catch(() => undefined);
      if (!mime) {
        outcome = "not-pdf";
        return;
      }
      const kind = mime === "application/pdf" ? "pdf" : "epub";
      const fromPath = join(folder, `handed-over.${kind}`);
      await fsp.rename(into, fromPath);
      const record = { title: primary(sf.source.title) ?? "", creators: sf.source.creators, ...(sf.source.identifiers.doi ? { doi: sf.source.identifiers.doi } : {}), ...(sf.source.container && primary(sf.source.container) ? { container: primary(sf.source.container)! } : {}) };
      let check: FileCheckResult;
      try {
        check = await guard(r, checkFileAgainstRecord(fromPath, record), FIND_CHECK_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof TimedOut)) throw err;
        debug("find: the file check did not end in time");
        check = { match: false, why: "no-text", evidence: { kind, bytes: got.bytes } };
      }
      const ev = check.evidence;
      await act(projectId, async () => {
        const cur = await current(projectId, entryId);
        // R329 c: only if the entry is still the one that waited.
        if (!cur || cur.state !== "waiting-sign-in" || !sameVersion(cur, first)) return;
        const facts: HeldFileFacts = {
          ...(check.match ? { why: "looks-right", by: check.by } : { why: check.why }),
          kind: ev.kind,
          bytes: ev.bytes,
          ...(ev.fileDoi ? { fileDoi: ev.fileDoi } : {}),
          ...(ev.embeddedTitle ? { embeddedTitle: ev.embeddedTitle } : {}),
          ...(ev.textStart ? { textStart: ev.textStart } : {}),
          acquired: { method: "library_access", via, address: kept, at: stamp(), tool: { name: FIND_TOOL, version: VERSION }, access: "signed-in-session" },
        };
        const next = fit(evolve(cur, { state: "needs-check", reason: { code: `file-${facts.why}` } }, ["returnTo", "nextTryAt", "offers"], stamp()));
        try {
          await holdMismatchedFileIn(repo, projectId, { entry: next, sourceId: cur.sourceId!, fromPath, facts, handedOver: true });
        } catch (err) {
          if (err instanceof HeldFileEntryGoneError || err instanceof NotFoundError) return;
          if (err instanceof HeldFileSourceHasFileError) {
            await write(projectId, [evolve(cur, { state: "in-library" }, ["returnTo", "reason", "nextTryAt", "offers"], stamp())], "update");
            written = true;
            return;
          }
          if (err instanceof PolicyDeniedError) {
            outcome = await heldRefusal(projectId, err, sf.source.provenance);
            return;
          }
          throw err;
        }
        written = true;
        notify(projectId, entryId, "needs-check");
      });
    } catch (err) {
      // R338 g: a file taken and not kept is always said — any failure not foreseen above gives "could not be read"
      // (shown only if the entry is written back: not after a lock or a close, which write nothing).
      if (!(err instanceof Abandoned || err instanceof FindProjectStoppedError || err instanceof FindRunnerClosedError)) {
        debug(`find: a file from the library could not be kept (${errName(err)})`);
      }
      outcome = "unreadable";
    } finally {
      // R338 f: whatever was thrown, the handed file is discarded (if it was never taken) and the mark goes.
      try {
        if (!taken) await file.discard(path).catch(() => undefined);
        if (folder !== undefined && !released) await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
        release?.();
      } finally {
        handed.delete(k);
      }
      // Not held: the entry returns to exactly what it was (R324 b, R329 g), saying what became of its file — now,
      // unless the project is stopped or the runner closed (then at the unlock's or the next open's resume, as F15
      // built it).
      if (!written && !closed && !runs.get(projectId)?.stopped) {
        const back = await bringBack(projectId, entryId, outcome).catch(() => null);
        if (back && inCopyPart(back)) enqueue(projectId, back.id);
      }
    }
  }

  return {
    add,
    choose,
    confirmDuplicate,
    addHereAsWell,
    retry,
    remove,
    resolveHeld,
    wakeHeldFull,
    wakeAllowance,
    wakeSettings,
    resume,
    stop,
    stopAll,
    elsewhere,
    lockedNotChecked,
    stoppedFor,
    choosePerson,
    chooseWorks,
    asAuthor,
    libraryStart,
    libraryCancel,
    libraryHandedOver,
    atWork,
    libraryChances,
    libraryAddressOf,
    acceptLibraryFile,
  };
}
