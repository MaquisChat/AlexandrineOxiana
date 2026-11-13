/**
 * The runner of Find and acquire (Task F4): takes each typed line through its life.
 *
 *   looking-up ──► choose            (several works fit; `choose` picks one, or none: not-found)
 *              ──► record-complete   (sure, or chosen: ONE source without a file is created; final in slice 1)
 *              ──► already           (the same DOI or ISBN is in this project, or — "Check everything I have" —
 *                                     in another unlocked project: `elsewhere: true` and nothing else about it)
 *              ──► maybe-duplicate   (a likely duplicate: `confirmDuplicate` answers it)
 *              ──► not-found         (every service asked answered, and nothing scored)
 *              ──► failed            (the rules or the settings refuse; or the services stayed unreachable
 *                                     through every retry of FIND_RETRY_DELAYS_MS; `retry` starts again)
 *
 * One work, one source, under every race. The duplicate check and the creation run inside the project's store
 * turn (`serialStore`, shared with drag-and-drop, watched folders and Bulk Import), with nothing awaited between
 * them that lets another creation in; every change an entry makes after a lookup is decided in such a turn
 * against the entry as it is then (an entry removed, chosen, retried or stopped meanwhile is left alone).
 *
 * Crash safety. The source made for an entry carries the entry's id in its provenance from its creation
 * (`provenance.externalKeys["find-entry"]`; provenance is immutable). A crash between the creation and the
 * entry's line leaves the entry "looking-up" beside a source that names it: the next turn on that entry (at
 * resume: before any lookup) ADOPTS that source — "record-complete" with its id — never a second source and
 * never "Already in your library".
 *
 * Nothing of another project is written here: a match elsewhere stores `elsewhere: true` and the state; where
 * it is is worked out again by `elsewhere()` at request time. A locked project is not looked into (its record is
 * not in the index while it is locked, R30) and is counted by `lockedNotChecked()`.
 *
 * The rules decide and fail closed: making a record is the way of acquiring `reference_lookup` (F1), checked
 * before anything is asked and again, governed and audited, by the creation itself; a project whose rules cannot
 * be read refuses. The "Search sources" settings only narrow. Audit entries hold ids, counts and states only;
 * the creation is audited as `source.create`. What was typed reaches no audit entry, note or error.
 *
 * Running. At most FIND_CONCURRENCY entries are worked on at once for the whole open library, the project
 * served longest ago first (one project's fifty lines do not starve another's one). `stop` (lock, close) writes
 * nothing further for the project and drops its work in flight: a late answer is not acted on. `resume` (open,
 * unlock) restarts the "looking-up" entries and nothing else; a read-only library starts nothing.
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
  type Source,
} from "@ao/core";
import { findSourceBy, type IndexDb } from "../index/db.js";
import { serialStore, storeTurn } from "../import/project-queue.js";
import { lookupContextFor, providerAllowed, type LookupContext } from "../lookup/context.js";
import type { HttpClient } from "../lookup/http.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError, RecoveryPendingError } from "../repo/errors.js";
import { createSourceRefusing, projectCollectionsAndTags, repoLibrary, type Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { libraryVersion } from "../resources.js";
import type { WorkCandidate } from "./candidates.js";
import { FindQueueUnreadableError, appendFindEntries, readFindQueue, readFindQueueDetailed, sanitizeEntry } from "./queue-store.js";
import { parseReference, type Reference } from "./reference.js";
import { decideMatch, scoreCandidate, searchWorks, type SearchSource } from "./search.js";
import { FIND_LINE_MAX_BYTES, FIND_TYPED_MAX, type FindEntry, type FindReason, type FindState, type SearchSettings } from "./types.js";

/** At most this many entries are worked on at once, for the whole open library. */
export const FIND_CONCURRENCY = 2;
/** After a network failure the entry is tried again after each of these delays in turn, then it is "failed". */
export const FIND_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000];
/** One Add holds at most this many lines. */
export const FIND_ADD_MAX_LINES = 50;
/** The tool a record made by Find and acquire names in its provenance. */
export const FIND_TOOL = "find-and-acquire";
/** The provenance external key that holds the queue entry's id (set once, at creation). */
export const FIND_ENTRY_KEY = "find-entry";
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

/** Test seams (R47: honoured only under NODE_ENV=test): run just before and just after a record's creation. */
export const runnerSeams: { beforeCreate?: () => void; afterCreate?: () => void } = {};
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
  /** The "Search sources" settings (F12); until F12 exists, a function returning DEFAULT_SEARCH_SETTINGS. */
  settings: () => Promise<SearchSettings>;
  /** "Check everything I have": a match in another unlocked project counts. */
  checkEverything: () => boolean;
  now?: () => Date;
  onChange(e: { projectId: string; entryId: string; state: FindState }): void;
  /** Beyond the plan's Interfaces: the timers of the retries (default: the process's, unref'd). Tests pass fake ones. */
  timers?: FindTimers;
  /** Beyond the plan's Interfaces: short notes (error kinds only; never what was typed). */
  debug?: (note: string) => void;
}

export interface FindRunner {
  add(projectId: string, lines: string[], collectionId?: string): Promise<{ added: FindEntry[]; mergedLines: number }>;
  choose(projectId: string, entryId: string, candidateId: string | null): Promise<FindEntry>;
  confirmDuplicate(projectId: string, entryId: string, same: boolean): Promise<FindEntry>;
  addHereAsWell(projectId: string, entryId: string): Promise<FindEntry>;
  retry(projectId: string, entryId: string): Promise<FindEntry>;
  remove(projectId: string, entryId: string): Promise<void>;
  resume(projectId: string): void;
  stop(projectId: string): void;
  stopAll(): Promise<void>;
  elsewhere(projectId: string, entryId: string): Promise<{ projectId: string; sourceId: string } | null>;
  lockedNotChecked(): number;
}

/** The queue store works on the repository's core; the Repo keeps it in a private field (package-internal use). */
const coreOf = (repo: Repo): RepoCore => (repo as unknown as { core: RepoCore }).core;

/**
 * The project's queue as it stands (for the service's GET, F5): the live entries, and how many lines could not be
 * read. A queue none of whose lines can be read is `FindQueueUnreadableError`; a locked project `ProjectLockedError`.
 */
export function readFindQueueOf(repo: Repo, projectId: string): Promise<{ entries: Map<string, FindEntry>; unreadableLines: number }> {
  return readFindQueueDetailed(coreOf(repo), projectId);
}

type Existing = DupKey & { sourceId: string };
/** What the runner knows of a project's sources inside its store turns (rebuilt when anyone else had a turn). */
interface Known {
  turn: number;
  keys: Existing[];
  /** Entry id → the source made for it (from provenance). */
  made: Map<string, string>;
}

interface Run {
  gen: number;
  stopped: boolean;
  stopSignal: Promise<void>;
  signalStop: () => void;
  pending: string[];
  timers: Map<string, unknown>;
  /** When this project was last given a place (fairness: the one served longest ago goes first). */
  served: number;
  known?: Known;
}

const STOPPED = Symbol("stopped");

/** A new entry from `e`: its fields without those in `drop`, then `patch` (keys it sets to undefined are left out). */
function evolve(e: FindEntry, patch: Partial<FindEntry>, drop: Array<keyof FindEntry>, at: string): FindEntry {
  const out: Record<string, unknown> = { ...e };
  for (const k of drop) delete out[k];
  Object.assign(out, patch, { updatedAt: at });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as FindEntry;
}

const sameVersion = (a: FindEntry, b: FindEntry) => a.state === b.state && a.updatedAt === b.updatedAt && a.attempts === b.attempts;

/** A candidate within what the queue keeps (F3's bounds, which are not all F2's): fields the store would refuse are left out. */
function boundCandidate(c: WorkCandidate): WorkCandidate {
  const isbn = (c.identifiers.isbn ?? []).filter((i) => i.length <= 20).slice(0, 20);
  const doi = c.identifiers.doi && c.identifiers.doi.length <= 200 ? c.identifiers.doi : undefined;
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
function fit(e: FindEntry): FindEntry {
  if (!e.candidates) return e;
  let candidates = e.candidates.slice(0, CANDIDATES_KEPT).map(boundCandidate);
  const size = (cs: WorkCandidate[]) => Buffer.byteLength(JSON.stringify({ ...e, candidates: cs }), "utf8");
  while (size(candidates) > FIND_LINE_MAX_BYTES && candidates.length > 1) {
    const i = candidates.map((c) => c.id !== e.chosen).lastIndexOf(true);
    candidates = candidates.filter((_, j) => j !== (i < 0 ? candidates.length - 1 : i));
  }
  if (size(candidates) > FIND_LINE_MAX_BYTES) candidates = candidates.map((c) => ({ ...c, creators: c.creators.slice(0, 10) }));
  const out = { ...e, candidates };
  return sanitizeEntry(out) ? out : evolve(e, {}, ["candidates"], e.updatedAt);
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

/** The duplicate keys of a stored source (no files: a record made from a reference has none to compare). */
function keyOfSource(s: Source): Existing {
  const c = s.creators[0];
  const family = c?.family ?? c?.literal;
  const title = primary(s.title);
  return {
    sourceId: s.id,
    sha256s: [],
    ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}),
    ...(s.identifiers.isbn?.length ? { isbns: s.identifiers.isbn } : {}),
    ...(title ? { title } : {}),
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(s.issued ? { year: s.issued.slice(0, 4) } : {}),
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

class CollectionGone extends Error {}

export function createFindRunner(deps: FindRunnerDeps): FindRunner {
  const { repo, http } = deps;
  const core = coreOf(repo);
  const now = () => deps.now?.() ?? new Date();
  const debug = (n: string) => deps.debug?.(n);
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
  /** Entry → the source this runner made for it (a creation whose entry line could not be written is adopted). */
  const madeHere = new Map<string, string>();

  const readOnly = () => repoLibrary(repo).mode !== "read-write";
  const keyOfRun = (pid: string, eid: string) => `${pid}\u0000${eid}`;

  function freshRun(): Run {
    let signalStop!: () => void;
    const stopSignal = new Promise<void>((r) => (signalStop = r));
    return { gen: 0, stopped: false, stopSignal, signalStop, pending: [], timers: new Map(), served: -1 };
  }
  function runOf(pid: string): Run {
    let r = runs.get(pid);
    if (!r) {
      r = freshRun();
      runs.set(pid, r);
    }
    return r;
  }
  /** Starts a new generation (the caller bumps `gen`): work of the old one is let go at once and writes nothing more. */
  function restart(r: Run): void {
    r.signalStop();
    let signalStop!: () => void;
    r.stopSignal = new Promise<void>((res) => (signalStop = res));
    r.signalStop = signalStop;
    r.stopped = false;
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
    r.known = undefined;
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
      .catch((err: unknown) => failedUnexpectedly(pid, err))
      .finally(() => {
        active--;
        running.delete(k);
        inflight.delete(p);
        pump();
      });
    inflight.add(p);
  }

  function failedUnexpectedly(pid: string, err: unknown): void {
    if (err instanceof ProjectLockedError || err instanceof FindQueueUnreadableError || err instanceof ReadOnlyLibraryError || err instanceof RecoveryPendingError) {
      stopRun(pid);
      return;
    }
    debug(`find: an entry could not go on (${err instanceof Error ? err.name : "error"})`);
  }

  function later(pid: string, eid: string, at: string): void {
    const r = runOf(pid);
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

  async function write(pid: string, next: FindEntry[], op: "add" | "update" | "remove"): Promise<FindEntry[]> {
    const fitted = next.map(fit);
    await appendFindEntries(core, pid, fitted, op);
    if (op !== "remove") for (const e of fitted) deps.onChange({ projectId: pid, entryId: e.id, state: e.state });
    return fitted;
  }
  const stamp = () => now().toISOString();

  /** The entry as the queue holds it now (a read refused as unreadable stops the runner for the project). */
  async function current(pid: string, eid: string): Promise<FindEntry | undefined> {
    return (await readFindQueue(core, pid)).get(eid);
  }

  /** The project's store turn, with what the runner knows of its sources kept only while nobody else had a turn. */
  function turn<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    return serialStore(repo, pid, async () => {
      const r = runOf(pid);
      const t = storeTurn(repo, pid);
      if (r.known && r.known.turn !== t - 1) r.known = undefined;
      try {
        return await fn();
      } finally {
        if (r.known) r.known.turn = t;
      }
    });
  }

  /** Inside a turn: the project's sources' duplicate keys and the entries they were made for. */
  async function known(pid: string): Promise<Known> {
    const r = runOf(pid);
    if (r.known) return r.known;
    const k: Known = { turn: storeTurn(repo, pid), keys: [], made: new Map() };
    for (const id of repo.listSourceIds(pid)) {
      let s: Source;
      try {
        s = await repo.getSourceRecord(pid, id);
      } catch (err) {
        if (err instanceof ProjectLockedError) throw err;
        continue; // an unreadable source cannot be compared
      }
      k.keys.push(keyOfSource(s));
      const tag = s.provenance.externalKeys?.[FIND_ENTRY_KEY];
      if (tag && s.provenance.captureMethod === "reference_lookup" && s.provenance.tool.name === FIND_TOOL) k.made.set(tag, id);
    }
    r.known = k;
    return k;
  }

  /** The source made for this entry earlier (a crash or a stop between its creation and the entry's line), if it still exists. */
  async function madeFor(pid: string, eid: string): Promise<string | undefined> {
    const live = new Set(repo.listSourceIds(pid));
    const here = madeHere.get(eid);
    if (here && live.has(here)) return here;
    const k = await known(pid);
    const id = k.made.get(eid);
    return id && live.has(id) ? id : undefined;
  }

  /** A duplicate in this project: the runner's keys (inside the turn), and the index for a DOI or ISBN as a second net. */
  async function matchHere(pid: string, key: DupKey): Promise<ReturnType<typeof findDuplicate>> {
    const live = new Set(repo.listSourceIds(pid));
    const k = await known(pid);
    const dup = findDuplicate(key, k.keys.filter((x) => live.has(x.sourceId)));
    if (dup?.certainty === "certain") return dup;
    for (const row of indexRows(key)) if (row.projectId === pid && live.has(row.id)) return { sourceId: row.id, reason: "same-doi", certainty: "certain" };
    return dup;
  }

  function indexRows(key: DupKey): Array<{ id: string; projectId: string; locked: boolean }> {
    const out: Array<{ id: string; projectId: string; locked: boolean }> = [];
    try {
      if (key.doi) out.push(...findSourceBy(deps.index, { doi: key.doi }));
      for (const i of key.isbns ?? []) out.push(...findSourceBy(deps.index, { isbn: i }));
    } catch {
      debug("find: the index could not be asked");
    }
    return out;
  }

  /** Other projects of the open library that can be looked into now (unlocked), and how many are locked. */
  function otherProjects(pid: string): { open: string[]; locked: number } {
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
    const exists = (projectId: string, id: string) => {
      try {
        return repo.listSourceIds(projectId).includes(id);
      } catch {
        return false;
      }
    };
    for (const row of indexRows(key)) {
      if (row.projectId !== pid && openSet.has(row.projectId) && !row.locked && exists(row.projectId, row.id)) {
        return { projectId: row.projectId, sourceId: row.id, certainty: "certain" };
      }
    }
    if (!likely) return null;
    const y = key.year && /^\d{4}$/u.test(key.year) ? Number(key.year) : null;
    if (!key.title || !key.firstCreatorFamily || y === null) return null;
    for (const projectId of open) {
      let rows: Array<{ id: string; title: string; creators_text: string; issued_year: string | null; doi: string | null }>;
      try {
        rows = deps.index
          .prepare(
            `SELECT id, title, creators_text, issued_year, doi FROM main.sources WHERE project_id = ? AND locked = 0 AND issued_year IN (?,?,?)
             UNION ALL SELECT id, title, creators_text, issued_year, doi FROM temp.t_sources WHERE project_id = ? AND issued_year IN (?,?,?)`,
          )
          .all(projectId, String(y - 1), String(y), String(y + 1), projectId, String(y - 1), String(y), String(y + 1)) as typeof rows;
      } catch {
        debug("find: the index could not be asked");
        return null;
      }
      const existing: Existing[] = rows
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
      const dup = findDuplicate(key, existing);
      if (dup && exists(projectId, dup.sourceId)) return { projectId, sourceId: dup.sourceId, certainty: dup.certainty };
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------------------
  // The rules

  /** Whether the project's rules allow making a record from a reference (null rules: refused). */
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
  const SETTINGS: FindReason = { code: "switched-off", by: "settings" };

  // ------------------------------------------------------------------------------------------------------------
  // Completing an entry with a candidate: the duplicate check and the creation in one store turn.

  interface CompleteOpts {
    method: "find-match" | "find-chosen";
    confidence: number;
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
  async function completeIn(pid: string, eid: string, cand: WorkCandidate, o: CompleteOpts): Promise<FindEntry | null> {
    const live = o.live ?? (() => !closed);
    if (!live()) return null;
    const cur = await current(pid, eid);
    if (!cur || !o.expect(cur)) return null;
    const at = stamp();
    const keep = { candidates: cur.candidates?.some((c) => c.id === cand.id) ? cur.candidates : [cand], chosen: cand.id };
    const settle = async (patch: Partial<FindEntry>, drop: Array<keyof FindEntry> = []) => {
      if (!live()) return null;
      const [w] = await write(pid, [evolve(cur, { ...keep, ...patch }, ["reason", "nextTryAt", ...drop], at)], "update");
      return w!;
    };

    // A source made for this entry already (a crash or a stop after its creation): adopted, never made twice.
    const adopted = await madeFor(pid, eid);
    if (adopted) return settle({ state: "record-complete", sourceId: adopted }, ["duplicateOf", "elsewhere"]);

    const key = keyOf(cand);
    const dup = await matchHere(pid, key);
    if (dup?.certainty === "certain") return settle({ state: "already", duplicateOf: dup.sourceId }, ["sourceId", "elsewhere"]);
    if (dup && !o.skipLikely) return settle({ state: "maybe-duplicate", duplicateOf: dup.sourceId }, ["sourceId", "elsewhere"]);
    if (!o.skipElsewhere && deps.checkEverything()) {
      const m = matchElsewhere(pid, key, !o.skipLikely);
      if (m?.certainty === "certain") return settle({ state: "already", elsewhere: true }, ["sourceId", "duplicateOf"]);
      if (m) return settle({ state: "maybe-duplicate", elsewhere: true }, ["sourceId", "duplicateOf"]);
    }
    if (!live()) return null;

    // The record: one source without a file, in one governed change (capture `reference_lookup` and store,
    // evaluated and audited as `source.create`). Its provenance names this entry from its creation.
    const provenance: Provenance = {
      captureMethod: "reference_lookup",
      capturedAt: at,
      tool: { name: FIND_TOOL, version: VERSION },
      fileHashes: {},
      identification: { method: o.method, confidence: o.confidence },
      externalKeys: { [FIND_ENTRY_KEY]: eid },
      legal: { status: "public" },
      identifiable: false,
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
      if (err instanceof PolicyDeniedError) return settle({ state: "failed", reason: RULES });
      throw err;
    }
    madeHere.set(eid, sourceId);
    runOf(pid).known?.keys.push({ ...key, sourceId } as Existing);
    runOf(pid).known?.made.set(eid, sourceId);
    seam(runnerSeams.afterCreate);
    // Stopped meanwhile: the record stands and the entry stays "looking-up"; resume adopts it.
    return settle({ state: "record-complete", sourceId }, ["duplicateOf", "elsewhere", ...(collectionGone ? (["collectionId"] as const) : [])]);
  }

  // ------------------------------------------------------------------------------------------------------------
  // The runner's own work on one entry.

  async function work(pid: string, eid: string, gen: number): Promise<void> {
    const live = () => alive(pid, gen);
    const r = runOf(pid);
    const entry = await current(pid, eid);
    if (!live() || !entry || entry.state !== "looking-up") return;
    if (entry.nextTryAt && Date.parse(entry.nextTryAt) > now().getTime()) {
      later(pid, eid, entry.nextTryAt);
      return;
    }
    /** Writes `patch` on the entry in a turn, if it is still the version this work started from. */
    const finish = (patch: Partial<FindEntry>, drop: Array<keyof FindEntry> = []) =>
      turn(pid, async () => {
        if (!live()) return null;
        const cur = await current(pid, eid);
        if (!cur || !sameVersion(cur, entry)) return null;
        const [w] = await write(pid, [evolve(cur, patch, drop, stamp())], "update");
        return w!;
      });

    // A source already made for this entry (a crash or a stop between its creation and its line): adopted
    // before anything is asked.
    const adopted = await turn(pid, async () => {
      if (!live()) return true;
      const sid = await madeFor(pid, eid);
      if (!sid) return false;
      const cur = await current(pid, eid);
      if (cur && sameVersion(cur, entry)) await write(pid, [evolve(cur, { state: "record-complete", sourceId: sid }, ["reason", "nextTryAt"], stamp())], "update");
      return true;
    });
    if (adopted) return;

    const ctx = await lookupContextFor(repo, pid, http, deps.debug ? { debug: deps.debug } : {});
    if (!live()) return;
    if (!acquireAllowed(ctx)) {
      await finish({ state: "failed", reason: RULES }, ["nextTryAt"]);
      return;
    }
    const s = await deps.settings();
    if (!live()) return;
    const on = s.record.filter((x) => x.on && (x.id === "crossref" || x.id === "openalex")).map((x) => x.id as SearchSource);
    if (!on.length) {
      await finish({ state: "failed", reason: SETTINGS }, ["nextTryAt"]);
      return;
    }
    const sources = on.filter((x) => providerAllowed(ctx, x));
    if (!sources.length) {
      await finish({ state: "failed", reason: RULES }, ["nextTryAt"]);
      return;
    }
    const ref: Reference | null = parseReference(entry.typed);
    if (!ref) {
      await finish({ state: "not-found" }, ["nextTryAt", "reason"]);
      return;
    }
    const search = searchWorks(ref, ctx, { sources });
    search.catch(() => {});
    const res = await Promise.race([search, r.stopSignal.then((): typeof STOPPED => STOPPED)]);
    // A late answer (after a stop or a lock) is not acted on.
    if (res === STOPPED || !live()) return;

    const failed = sources.filter((x) => res.notes.includes(`${x}-failed`));
    const budget = sources.includes("openalex") && res.notes.includes("openalex-budget");
    const answered = sources.length - failed.length - (budget ? 1 : 0);
    const decision = decideMatch(ref, res.candidates);
    if (decision.kind === "none" && (failed.length > 0 || answered === 0)) {
      // Nobody (or not everybody) answered: tried again later, then "failed".
      const attempts = entry.attempts + 1;
      const delay = FIND_RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) {
        await finish({ state: "failed", attempts, reason: { code: failed.length || !budget ? "unreachable" : "budget" } }, ["nextTryAt"]);
        return;
      }
      const at = new Date(now().getTime() + delay).toISOString();
      const w = await finish({ attempts, nextTryAt: at });
      if (w && live()) later(pid, eid, at);
      return;
    }
    if (decision.kind === "none") {
      await finish({ state: "not-found" }, ["nextTryAt", "reason", "candidates"]);
      return;
    }
    if (decision.kind === "choose") {
      const byId = new Map(res.candidates.map((c) => [c.id, c]));
      const candidates = decision.ids.map((id) => byId.get(id)!).filter(Boolean);
      await finish({ state: "choose", candidates }, ["nextTryAt", "reason"]);
      return;
    }
    const cand = res.candidates.find((c) => c.id === decision.id)!;
    await turn(pid, async () => {
      try {
        await completeIn(pid, eid, cand, {
          method: "find-match",
          confidence: scoreCandidate(ref, cand).score,
          expect: (cur) => sameVersion(cur, entry),
          live,
        });
      } catch (err) {
        if (err instanceof PolicyDeniedError) return;
        throw err;
      }
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
    const given = lines.filter((l) => typeof l === "string" && l.trim() !== "");
    if (given.length === 0) throw new InvalidInputError("Type at least one reference.");
    if (given.length > FIND_ADD_MAX_LINES) throw new InvalidInputError(`At most ${FIND_ADD_MAX_LINES} lines can be added at once.`);
    const seen = new Set<string>();
    const at = stamp();
    const added: FindEntry[] = [];
    let mergedLines = 0;
    for (const line of given) {
      const ref = parseReference(line);
      if (!ref || ref.text.length > FIND_TYPED_MAX) throw new InvalidInputError("Each line must be 2 to 500 characters.");
      const norm = ref.tokens.length ? ref.tokens.join(" ") : ref.text.toLowerCase();
      if (seen.has(norm)) {
        mergedLines++;
        continue;
      }
      seen.add(norm);
      added.push({ id: newId(), projectId, ...(collectionId ? { collectionId } : {}), typed: ref.text, state: "looking-up", createdAt: at, updatedAt: at, attempts: 0 });
    }
    const written = await write(projectId, added, "add");
    const r = runOf(projectId);
    if (r.stopped) {
      r.gen++;
      restart(r);
    }
    for (const e of written) enqueue(projectId, e.id);
    return { added: written, mergedLines };
  }

  async function choose(projectId: string, entryId: string, candidateId: string | null): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    return turn(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "choose") {
        // Pressed twice: the first press already decided it.
        if (candidateId !== null && cur.chosen === candidateId && ["record-complete", "already", "maybe-duplicate", "failed"].includes(cur.state)) return cur;
        if (candidateId === null && cur.state === "not-found") return cur;
        throw new FindEntryStateError();
      }
      if (candidateId === null) {
        const [w] = await write(projectId, [evolve(cur, { state: "not-found" }, ["chosen", "reason", "nextTryAt"], stamp())], "update");
        return w!;
      }
      const cand = cur.candidates?.find((c) => c.id === candidateId);
      if (!cand) throw new FindEntryStateError();
      const done = await completeIn(projectId, entryId, cand, { method: "find-chosen", confidence: 1, expect: (e) => sameVersion(e, cur) });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function confirmDuplicate(projectId: string, entryId: string, same: boolean): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    return turn(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (cur.state !== "maybe-duplicate") throw new FindEntryStateError();
      if (same) {
        const [w] = await write(projectId, [evolve(cur, { state: "already" }, ["reason", "nextTryAt"], stamp())], "update");
        return w!;
      }
      const cand = cur.candidates?.find((c) => c.id === cur.chosen) ?? cur.candidates?.[0];
      if (!cand) throw new FindEntryStateError();
      const done = await completeIn(projectId, entryId, cand, {
        method: cur.chosen && cur.candidates!.length > 1 ? "find-chosen" : "find-match",
        confidence: 1,
        expect: (e) => sameVersion(e, cur),
        skipLikely: true,
      });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function addHereAsWell(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    return turn(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      if (!cur.elsewhere || (cur.state !== "already" && cur.state !== "maybe-duplicate")) throw new FindEntryStateError();
      const cand = cur.candidates?.find((c) => c.id === cur.chosen) ?? cur.candidates?.[0];
      if (!cand) throw new FindEntryStateError();
      const done = await completeIn(projectId, entryId, cand, {
        method: "find-chosen",
        confidence: 1,
        expect: (e) => sameVersion(e, cur),
        skipElsewhere: true,
      });
      if (!done) throw new FindEntryStateError();
      return done;
    });
  }

  async function retry(projectId: string, entryId: string): Promise<FindEntry> {
    assertOpen();
    assertId(entryId);
    const w = await turn(projectId, async () => {
      const cur = await current(projectId, entryId);
      if (!cur) throw new NotFoundError("Queue entry", entryId);
      const waiting = cur.state === "looking-up" && !!cur.nextTryAt;
      if (cur.state !== "failed" && cur.state !== "not-found" && !waiting) throw new FindEntryStateError();
      cancelLater(projectId, entryId);
      const [next] = await write(
        projectId,
        [evolve(cur, { state: "looking-up", attempts: 0 }, ["reason", "nextTryAt", "candidates", "chosen", "duplicateOf", "elsewhere"], stamp())],
        "update",
      );
      return next!;
    });
    const r = runOf(projectId);
    if (r.stopped) {
      r.gen++;
      restart(r);
    }
    enqueue(projectId, entryId);
    return w;
  }

  async function remove(projectId: string, entryId: string): Promise<void> {
    assertOpen();
    assertId(entryId);
    await turn(projectId, async () => {
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
    const r = runOf(projectId);
    r.gen++;
    restart(r);
    r.known = undefined;
    const gen = r.gen;
    const p = (async () => {
      const q = await readFindQueue(core, projectId);
      if (!alive(projectId, gen)) return;
      for (const e of q.values()) {
        if (e.state !== "looking-up") continue;
        if (e.nextTryAt && Date.parse(e.nextTryAt) > now().getTime()) later(projectId, e.id, e.nextTryAt);
        else enqueue(projectId, e.id);
      }
    })()
      .catch((err: unknown) => failedUnexpectedly(projectId, err))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  function stop(projectId: string): void {
    stopRun(projectId);
  }

  async function stopAll(): Promise<void> {
    closed = true;
    for (const pid of runs.keys()) stopRun(pid);
    await Promise.allSettled([...inflight]);
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
    return repo.listProjects().filter((p) => !repo.isUnlocked(p.id)).length;
  }

  return { add, choose, confirmDuplicate, addHereAsWell, retry, remove, resume, stop, stopAll, elsewhere, lockedNotChecked };
}
