/**
 * The queue of Find and acquire (Task F3): what the researcher typed, and where each line stands.
 * `<Project>/find/queue.jsonl`, one entry per line, append-only; the later line for an id wins. It follows
 * the register of a watched folder (`repo/watch-register.ts`): in an encrypted project every line is sealed
 * with the project key (purpose "ao-find-queue", declared in `repo/sealed-purposes.ts` so that a restore of a
 * backup knows it), so a typed word or a title never sits in plain text there; in a project that is not
 * encrypted the lines are plain and the file is owner-only (0600), like other files of the project that hold
 * what the researcher wrote (flagged for the pseudonymisation review, R64).
 *
 * The queue is library data (R26): every change is ONE governed change (`runMutation`: the policy decision
 * `store {identifiable:false, hasLocation:false}`, a write-ahead transaction marker, an audit event). The audit
 * holds entry ids, counts by state and counts of lines, nothing else: never the typed text, a title, a name, a
 * host or an address (R177, R69). A crash anywhere in a write leaves the old queue or the new one.
 *
 * Lines. A change of an entry is a line: an add and an update write the entry; a remove writes a short line
 * with `removed: true` (the typed text is not repeated in it). Nothing is ever rewritten in place except by a
 * compaction. An id whose latest line is `removed` may be added again (before and after a compaction alike).
 *
 * What an entry may hold is checked by ONE function (`sanitizeEntry`), on the way in and on the way out: the
 * type's fields only (unknown fields, nested ones too, are dropped), ids as ids, and the plan's bounds (a title
 * at most 1,000 characters, a name 200, 100 creators, 10 candidates, 20 people, 200 works). An entry beyond
 * them is REFUSED with a plain sentence, never cut. What is handed in is copied, and what a read gives out is
 * frozen all the way down (the cache is shared between readers, so nothing a caller holds can change it).
 *
 * Compaction rewrites the file as one governed change (`project.find.compact`) and one atomic replacement, so
 * that a crash leaves the old file or the new one. It drops the superseded lines and the removed entries, and
 * NOTHING ELSE: every complete line it cannot read (not JSON, a state or shape this build does not know, a seal
 * that does not open, too long) is carried over verbatim and in its place among the others, because it may be a
 * newer build's. Such lines are counted (`unreadableLines`) but do not count towards "due". Only a torn last
 * line (no newline after it) is no committed line (R28) and goes. It is due when the lines that CAN be read
 * outnumber twice the live entries (at least 2): `readable > 2 × max(live, 1)`, whatever the file's size (a
 * large queue of live entries is not rewritten at every update). It does not run when more than half of the
 * file's lines cannot be read, or one is over 1 MiB (a note is left in `core.indexErrors`); it never runs on a
 * file in which no line can be read.
 *
 * Reading folds the lines by id, streaming (memory: one entry per id, never one per line), and is tolerant of
 * the past and strict about shape: an unreadable line is skipped and counted, never an error and never deleted
 * by a read or a write. But when the file holds lines and NONE can be read, the queue is not "empty": reads and
 * writes refuse (`FindQueueUnreadableError`) and nothing is written. The only thing a write removes is a last
 * line torn by an unclean stop (no newline after it); a read passes it by.
 */
import { statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { Creator, SourceType, isId } from "@ao/core";
import { InvalidInputError } from "../repo/errors.js";
import { openLine, readMaybe, sealLine } from "../repo/io.js";
import { CHANGE_LOG_MODE, runMutation } from "../repo/mutate.js";
import { PURPOSE_FIND_QUEUE } from "../repo/sealed-purposes.js";
import type { ProjectState, RepoCore } from "../repo/state.js";
import type { WorkCandidate } from "./candidates.js";
import { FIND_LINE_MAX_BYTES, FIND_QUEUE_MAX, FIND_QUEUE_OPS, FIND_STATES, FIND_TYPED_MAX, type FindEntry, type FindState, type OfferLink, type PersonCandidate } from "./types.js";

const PURPOSE = PURPOSE_FIND_QUEUE;
const DIR = "find";
const FILE = "queue.jsonl";
/** The policy request of every queue write: library data with nothing identifying in it, as the watch register's. */
const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
/** The longest line a compaction can carry over verbatim; a line over it stops the compaction (and is left alone). */
const CARRY_MAX_BYTES = 1024 * 1024;

/** What a caller is told when the queue is full: nothing is written. */
export class FindQueueFullError extends Error {
  override name = "FindQueueFullError";
  constructor() {
    super(`The queue holds ${FIND_QUEUE_MAX} entries. Remove some finished ones first.`);
  }
}

/** A single entry would make a line over `FIND_LINE_MAX_BYTES`: it is refused whole, never cut. The message carries nothing of the entry. */
export class FindEntryTooLargeError extends Error {
  override name = "FindEntryTooLargeError";
  constructor() {
    super("This entry is too large to be kept in the queue (more than 64 KiB). Nothing was added.");
  }
}

/** The queue could not be read: the file system failed, or the file holds lines and none of them can be read. Nothing has been changed. */
export class FindQueueUnreadableError extends Error {
  override name = "FindQueueUnreadableError";
  constructor() {
    super("The Find and acquire queue of this project could not be read. Nothing has been changed.");
  }
}
/** The queue could not be written because of the file system. The message carries no path. */
export class FindQueueUnwritableError extends Error {
  override name = "FindQueueUnwritableError";
  constructor() {
    super("The queue of this project could not be saved.");
  }
}
const isSystemError = (err: unknown) => typeof (err as NodeJS.ErrnoException | null)?.code === "string" && typeof (err as NodeJS.ErrnoException).syscall === "string";

const statBig = (abs: string) => fsp.stat(abs, { bigint: true });
const queueRel = (projectRel: string) => `${projectRel}/${DIR}/${FILE}`;

// ---------------------------------------------------------------------------------------------------------------
// Shape: one function says what an entry may hold

class Bad extends Error {}

const TITLE_MAX = 1000;
const NAME_MAX = 200;
const CREATORS_MAX = 100;
const CANDIDATES_MAX = 10;
const PEOPLE_MAX = 20;
const WORKS_MAX = 200;
const ROLES: readonly string[] = Creator.shape.role.options;
const TYPES: readonly string[] = SourceType.options;
const OFFER_LABELS: readonly string[] = ["Publisher's page", "Your library's catalogue", "Open Library", "WorldCat", "A free copy may be at"];

const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Bad();
  return v as Record<string, unknown>;
};
const str = (v: unknown, max: number, min = 0): string => {
  if (typeof v !== "string" || v.length > max || v.length < min) throw new Bad();
  return v;
};
const opt = <T>(v: unknown, f: (x: unknown) => T): T | undefined => (v === undefined ? undefined : f(v));
const id = (v: unknown): string => {
  if (typeof v !== "string" || !isId(v)) throw new Bad();
  return v;
};
const list = <T>(v: unknown, max: number, f: (x: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) throw new Bad();
  return v.map(f);
};
const put = <T extends object>(o: T, k: string, v: unknown): T => (v === undefined ? o : Object.assign(o, { [k]: v }));

function creatorOf(x: unknown): Creator {
  const c = obj(x);
  const role = str(c.role, 40);
  if (!ROLES.includes(role)) throw new Bad();
  let out: Record<string, unknown> = { role };
  for (const k of ["family", "given", "literal", "handle"]) out = put(out, k, opt(c[k], (v) => str(v, NAME_MAX)));
  return out as Creator;
}

function workOf(x: unknown): WorkCandidate {
  const w = obj(x);
  const ids = obj(w.identifiers);
  const type = str(w.type, 40);
  if (!TYPES.includes(type)) throw new Bad();
  let identifiers: Record<string, unknown> = {};
  identifiers = put(identifiers, "doi", opt(ids.doi, (v) => str(v, 200)));
  identifiers = put(identifiers, "isbn", opt(ids.isbn, (v) => list(v, 20, (i) => str(i, 20))));
  let out: Record<string, unknown> = { id: str(w.id, 200, 1), title: str(w.title, TITLE_MAX), creators: list(w.creators, CREATORS_MAX, creatorOf) };
  out = put(out, "issued", opt(w.issued, (v) => str(v, 40)));
  out.type = type;
  out = put(out, "container", opt(w.container, (v) => str(v, TITLE_MAX)));
  out = put(out, "publisher", opt(w.publisher, (v) => str(v, TITLE_MAX)));
  out.identifiers = identifiers;
  out.providers = list(w.providers, 10, (p) => str(p, 40));
  return out as unknown as WorkCandidate;
}

function personOf(x: unknown): PersonCandidate {
  const p = obj(x);
  const wc = p.worksCount;
  if (typeof wc !== "number" || !Number.isSafeInteger(wc) || wc < 0) throw new Bad();
  let out: Record<string, unknown> = { id: str(p.id, 64, 1), name: str(p.name, NAME_MAX) };
  out = put(out, "affiliation", opt(p.affiliation, (v) => str(v, TITLE_MAX)));
  out.worksCount = wc;
  out.sampleTitles = list(p.sampleTitles, 3, (t) => str(t, TITLE_MAX));
  return out as unknown as PersonCandidate;
}

function offerOf(x: unknown): OfferLink {
  const o = obj(x);
  const label = str(o.label, 40);
  if (!OFFER_LABELS.includes(label)) throw new Bad();
  return { label: label as OfferLink["label"], url: str(o.url, 2000), host: str(o.host, 253) };
}

/**
 * The entry as the queue keeps it, or null when `x` is not an entry of the type or is beyond what the queue keeps.
 * The result is a NEW object, deep: nothing is shared with `x`, and nothing `x` holds beyond the type's fields is in it.
 */
export function sanitizeEntry(x: unknown): FindEntry | null {
  try {
    const e = obj(x);
    const state = str(e.state, 40) as FindState;
    if (!(FIND_STATES as readonly string[]).includes(state)) throw new Bad();
    const attempts = e.attempts;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0) throw new Bad();
    if (e.elsewhere !== undefined && e.elsewhere !== true) throw new Bad();
    if (e.removed !== undefined && e.removed !== true) throw new Bad();
    let out: Record<string, unknown> = { id: id(e.id), projectId: str(e.projectId, 64, 1) };
    out = put(out, "collectionId", opt(e.collectionId, id));
    out.typed = str(e.typed, FIND_TYPED_MAX);
    out.state = state;
    out.createdAt = str(e.createdAt, 64);
    out.updatedAt = str(e.updatedAt, 64);
    out = put(out, "candidates", opt(e.candidates, (v) => list(v, CANDIDATES_MAX, workOf)));
    out = put(out, "people", opt(e.people, (v) => list(v, PEOPLE_MAX, personOf)));
    out = put(out, "works", opt(e.works, (v) => list(v, WORKS_MAX, workOf)));
    out = put(out, "chosen", opt(e.chosen, (v) => str(v, 200)));
    out = put(out, "sourceId", opt(e.sourceId, id));
    out = put(out, "duplicateOf", opt(e.duplicateOf, id));
    out = put(out, "elsewhere", e.elsewhere);
    out = put(
      out,
      "reason",
      opt(e.reason, (v) => {
        const r = obj(v);
        const by = r.by;
        if (by !== undefined && by !== "rules" && by !== "settings") throw new Bad();
        return { code: str(r.code, 40, 1), ...(by !== undefined ? { by } : {}) };
      }),
    );
    out.attempts = attempts;
    out = put(out, "nextTryAt", opt(e.nextTryAt, (v) => str(v, 64)));
    out = put(out, "parentId", opt(e.parentId, id));
    out = put(out, "offers", opt(e.offers, (v) => list(v, 20, offerOf)));
    out = put(out, "removed", e.removed);
    return out as unknown as FindEntry;
  } catch (err) {
    if (err instanceof Bad) return null;
    throw err;
  }
}

/** Whether `e` is an entry of the queue as the type describes it and the queue keeps it. */
export const isFindEntry = (e: unknown): e is FindEntry => sanitizeEntry(e) !== null;

const NOT_WELL_FORMED =
  "A queue entry is not well formed, or holds more than the queue keeps (a title over 1,000 characters, a name over 200, more than 100 creators, 10 candidates, 20 people or 200 works). Nothing was added.";

/** The line that takes an entry out of the queue: what is needed to fold it, and not the typed text. */
function removalOf(cur: FindEntry, at: string): FindEntry {
  return { id: cur.id, projectId: cur.projectId, typed: "", state: cur.state, createdAt: cur.createdAt, updatedAt: at, attempts: cur.attempts, removed: true };
}

function countStates(entries: readonly FindEntry[]): Record<FindState, number> {
  const out = Object.fromEntries(FIND_STATES.map((s) => [s, 0])) as Record<FindState, number>;
  for (const e of entries) out[e.state]++;
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** The queue folded by id (removed entries are kept as such, so that nothing brings them back), with what the file holds. */
interface Folded {
  map: Map<string, FindEntry>;
  /** The index (among the file's complete, non-blank lines) of each id's latest readable line. */
  at: Map<string, number>;
  /** Complete, non-blank lines in the file (readable or not). */
  lines: number;
  /** Of those, the lines that cannot be read. */
  unreadable: number;
  /** The file's size in bytes. */
  size: number;
}

const emptyFolded = (): Folded => ({ map: new Map(), at: new Map(), lines: 0, unreadable: 0, size: 0 });
const liveOf = (f: Folded): FindEntry[] => [...f.map.values()].filter((e) => e.removed !== true);

/** The longest line the reader takes in: a sealed line is the entry's JSON in base64 inside a small envelope. */
const lineMax = (sealed: boolean) => (sealed ? Math.ceil((FIND_LINE_MAX_BYTES + 16) / 3) * 4 + 512 : FIND_LINE_MAX_BYTES);

/** Applies one entry to a folded map (the later wins; the map's order is the order of the latest lines). */
function apply(f: Folded, e: FindEntry, index: number): void {
  f.map.delete(e.id);
  f.map.set(e.id, deepFreeze(e));
  f.at.set(e.id, index);
}

/** The entry a line holds when it is a good entry of this project; else null. */
function parseLine(line: string, projectId: string, key: Uint8Array | null): FindEntry | null {
  try {
    const e = sanitizeEntry(JSON.parse(key ? openLine(key, projectId, line, PURPOSE) : line));
    return e && e.projectId === projectId ? e : null;
  } catch {
    return null;
  }
}

/**
 * The complete, non-blank lines of a file in order, as text; `null` for one over `holdMax` bytes (never held in
 * memory). A last line with no newline after it is a torn line: not yielded.
 */
async function* readLines(abs: string, holdMax: number): AsyncGenerator<string | null> {
  const fh = await fsp.open(abs, "r");
  try {
    let carry: Buffer[] = [];
    let carryLen = 0;
    let discarding = false;
    for await (const chunk of fh.createReadStream() as AsyncIterable<Buffer>) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) {
          if (!discarding) {
            carryLen += chunk.length - start;
            if (carryLen > holdMax) {
              discarding = true;
              carry = [];
              carryLen = 0;
            } else carry.push(chunk.subarray(start));
          }
          break;
        }
        const piece = chunk.subarray(start, nl);
        if (discarding || carryLen + piece.length > holdMax) yield null;
        else {
          const text = (carry.length ? Buffer.concat([...carry, piece]) : piece).toString("utf8");
          if (text.trim()) yield text;
        }
        carry = [];
        carryLen = 0;
        discarding = false;
        start = nl + 1;
      }
    }
  } finally {
    await fh.close();
  }
}

async function foldFile(abs: string, projectId: string, key: Uint8Array | null, size: number): Promise<Folded> {
  const out = emptyFolded();
  out.size = size;
  for await (const text of readLines(abs, lineMax(key !== null))) {
    const index = out.lines++;
    const e = text === null ? null : parseLine(text, projectId, key);
    if (e) apply(out, e, index);
    else out.unreadable++;
  }
  return out;
}

/** The folded queues kept in memory per repository and file, with the file's identity when they were read. */
const caches = new WeakMap<RepoCore, Map<string, { sig: string; folded: Folded }>>();
const sigOf = (st: { size: bigint; mtimeNs: bigint; ino: bigint }) => `${st.size}:${st.mtimeNs}:${st.ino}`;
function cacheOf(core: RepoCore): Map<string, { sig: string; folded: Folded }> {
  let c = caches.get(core);
  if (!c) caches.set(core, (c = new Map()));
  return c;
}

/** Notes left for the developer in `core.indexErrors` (the repository's place for what does not fail a committed change). */
const noted = new WeakMap<RepoCore, Set<string>>();
function note(core: RepoCore, message: string, once?: string): void {
  if (once !== undefined) {
    let s = noted.get(core);
    if (!s) noted.set(core, (s = new Set()));
    if (s.has(once)) return;
    s.add(once);
  }
  core.indexErrors.push({ op: FIND_QUEUE_OPS.compact, error: new Error(message) });
}

/**
 * The project's queue folded (kept while the file is unchanged). The project must be unlocked. A file that holds
 * lines of which NONE can be read is not an empty queue: FindQueueUnreadableError, and nothing is changed.
 */
async function loadFolded(core: RepoCore, st: ProjectState): Promise<Folded> {
  const key = core.encrypted(st) ? core.key(st).key : null;
  const abs = core.abs(queueRel(st.rel));
  const cache = cacheOf(core);
  let stat: Awaited<ReturnType<typeof statBig>>;
  try {
    stat = await statBig(abs);
  } catch (err) {
    cache.delete(abs);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFolded();
    throw new FindQueueUnreadableError();
  }
  const sig = sigOf(stat);
  const kept = cache.get(abs);
  if (kept && kept.sig === sig) return kept.folded;
  let folded: Folded;
  try {
    folded = await foldFile(abs, st.project.id, key, Number(stat.size));
  } catch (err) {
    cache.delete(abs);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFolded();
    throw new FindQueueUnreadableError();
  }
  if (folded.lines > 0 && folded.unreadable === folded.lines) {
    cache.delete(abs);
    throw new FindQueueUnreadableError();
  }
  cache.set(abs, { sig, folded });
  return folded;
}

/**
 * The project's queue: the entries that are not removed, by id, in the order of their latest lines, and how many
 * lines cannot be read (`unreadableLines`: kept in the file, see the top of this file). Refuses a locked
 * encrypted project (ProjectLockedError) before anything is read. Missing file → empty. A file of which no line
 * can be read → FindQueueUnreadableError. The caller gets its own Map; the entries are frozen all the way down
 * (a read costs nothing per entry; the freeze is done once, when a line is folded).
 */
export async function readFindQueueDetailed(core: RepoCore, projectId: string): Promise<{ entries: Map<string, FindEntry>; unreadableLines: number }> {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const f = await loadFolded(core, st);
  return { entries: new Map(liveOf(f).map((e) => [e.id, e])), unreadableLines: f.unreadable };
}

/** The entries of the queue that are not removed, by id (see `readFindQueueDetailed` for the count of lines that cannot be read). */
export async function readFindQueue(core: RepoCore, projectId: string): Promise<Map<string, FindEntry>> {
  return (await readFindQueueDetailed(core, projectId)).entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

/** Thrown inside a governed change that finds nothing to do, so that nothing is audited; never leaves this module. */
class NothingToWrite extends Error {}

/** Whether a whole last line is missing its newline (one byte read). */
async function endsTorn(abs: string): Promise<boolean> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(abs, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

type Op = "add" | "update" | "remove";

/**
 * Appends changes of entries to the queue: ONE governed change (R26: policy, transaction marker, audit
 * `project.find.add`, `.update` or `.remove` with `{ entries: <ids>, count, states }` and nothing else).
 *
 * - `add`: the ids must not be live in the queue (an id whose latest line is `removed` may come back); more than
 *   `FIND_QUEUE_MAX` live entries after the add is `FindQueueFullError`, the whole batch refused, whatever its
 *   size. The count is made inside the governed change, which runs one at a time, so that two adds at once
 *   cannot both pass.
 * - `update`: an entry that is not in the queue or is removed is passed by (the runner may finish work on an
 *   entry the researcher removed meanwhile; it must not come back). `removed` is not written by an update.
 * - `remove`: writes a line `removed: true`; an entry not in the queue or already removed is passed by.
 *
 * What is handed in is copied (nothing the caller keeps can change the queue). Nothing is written, and nothing
 * audited, when nothing is left to write. Refuses a read-only library (ReadOnlyLibraryError) and a locked
 * project (ProjectLockedError) before anything is written; an entry of another project, one that is not an entry
 * of the type or is beyond what the queue keeps, or two with one id in an add, is `InvalidInputError`; an entry
 * whose line would be over `FIND_LINE_MAX_BYTES` is `FindEntryTooLargeError` (refused, never cut); a file in
 * which no line can be read is `FindQueueUnreadableError`. Afterwards, when the file is due for compaction (see
 * the top of this file), it is compacted by a change of its own, which never fails this call (a failure leaves
 * a note in `core.indexErrors`).
 */
export async function appendFindEntries(core: RepoCore, projectId: string, entries: FindEntry[], op: Op): Promise<void> {
  core.assertWritable();
  if (op !== "add" && op !== "update" && op !== "remove") throw new InvalidInputError("This is not a change the queue knows.");
  const st0 = core.state(projectId);
  core.assertUnlocked(st0);
  if (!Array.isArray(entries)) throw new InvalidInputError("The queue entries are not a list.");
  if (entries.length > FIND_QUEUE_MAX) {
    if (op === "add") throw new FindQueueFullError();
    throw new InvalidInputError("The queue entries are not a list of at most 500.");
  }
  const seen = new Set<string>();
  const cleaned: FindEntry[] = [];
  for (const e of entries) {
    const c = sanitizeEntry(e);
    if (!c) throw new InvalidInputError(NOT_WELL_FORMED);
    if (c.projectId !== projectId) throw new InvalidInputError("A queue entry belongs to another project.");
    if (seen.has(c.id) && op === "add") throw new InvalidInputError("A queue entry is given twice.");
    seen.add(c.id);
    if (Buffer.byteLength(JSON.stringify(c), "utf8") > FIND_LINE_MAX_BYTES) throw new FindEntryTooLargeError();
    cleaned.push(c);
  }
  if (cleaned.length === 0) return;
  try {
    await write(core, projectId, op, cleaned);
  } catch (err) {
    if (err instanceof NothingToWrite) return;
    // A file-system error's message names the file: never passed on (R96).
    if (isSystemError(err)) throw new FindQueueUnwritableError();
    throw err;
  }
  try {
    await compactFindQueue(core, projectId);
  } catch (err) {
    // Housekeeping: the change above is committed, and the next change tries again. A note is left.
    note(core, `The queue could not be compacted (${err instanceof Error ? err.name : "Error"}); it will be tried again at the next change.`);
  }
}

function write(core: RepoCore, projectId: string, op: Op, given: FindEntry[]): Promise<void> {
  let written: FindEntry[] = [];
  return runMutation(
    core,
    projectId,
    REQ,
    async (tx) => {
      const st = tx.state;
      const folded = await loadFolded(core, st);
      // What is to be written, decided against the queue as it is now (this runs one change at a time).
      const byId = new Map<string, FindEntry>();
      for (const c of given) {
        const cur = folded.map.get(c.id);
        if (op === "add") {
          if (cur && cur.removed !== true) throw new InvalidInputError("A queue entry with this id is already there.");
          const { removed: _r, ...rest } = c;
          byId.set(c.id, rest);
        } else if (cur && cur.removed !== true) {
          if (op === "update") {
            const { removed: _r, ...rest } = c;
            byId.set(c.id, rest);
          } else byId.set(c.id, removalOf(cur, c.updatedAt));
        }
      }
      const todo = [...byId.values()];
      if (todo.length === 0) throw new NothingToWrite();
      if (op === "add" && liveOf(folded).length + todo.length > FIND_QUEUE_MAX) throw new FindQueueFullError();
      written = todo;

      const rel = queueRel(st.rel);
      const abs = core.abs(rel);
      // A last line torn by an unclean stop (not by this app's own writes, which the marker takes back) is
      // removed in this change, so that the file can be appended to again.
      if (await endsTorn(abs)) {
        const raw = await readMaybe(abs);
        if (raw && raw.length > 0 && raw[raw.length - 1] !== 0x0a) await tx.writeFile(rel, raw.subarray(0, raw.lastIndexOf(0x0a) + 1), { mode: CHANGE_LOG_MODE });
      }
      tx.onCommit(() => {
        const kept = cacheOf(core).get(abs);
        if (!kept || kept.folded !== folded) return;
        try {
          const first = folded.lines;
          todo.forEach((e, i) => apply(folded, structuredClone(e), first + i));
          folded.lines += todo.length;
          const after = statSync(abs, { bigint: true });
          folded.size = Number(after.size);
          kept.sig = sigOf(after);
        } catch {
          cacheOf(core).delete(abs);
        }
      });
      if (tx.encrypted) {
        const { key, keyId } = tx.key();
        for (const e of todo) await tx.appendLine(rel, sealLine(key, keyId, st.project.id, JSON.stringify(e), PURPOSE));
      } else {
        for (const e of todo) await tx.appendLine(rel, JSON.stringify(e), { mode: CHANGE_LOG_MODE });
      }
    },
    { op: FIND_QUEUE_OPS[op], entity: { type: "project", id: projectId }, auditDetails: () => ({ entries: written.map((e) => e.id), count: written.length, states: countStates(written) }) },
  );
}

/** Due: the lines that can be read outnumber twice the live entries (at least 2), whatever the file's size. */
const compactionDue = (f: Folded): boolean => f.lines - f.unreadable > 2 * Math.max(liveOf(f).length, 1);
/** More than half of the file's lines cannot be read: it is not compacted. */
const mostlyUnreadable = (f: Folded): boolean => f.unreadable * 2 > f.lines;
const MOSTLY_UNREADABLE = "More than half of the lines of the Find and acquire queue could not be read, so it was not compacted. Nothing has been changed.";

/**
 * Rewrites the queue without the superseded lines and the removed entries, when it is due (see the top of this
 * file); otherwise it changes nothing and audits nothing. ONE governed change (`project.find.compact`; the audit
 * holds `count`, `states`, `linesBefore`, `linesAfter` and `unreadable`, the lines carried over): the new file
 * replaces the old one atomically under the transaction marker, so a crash leaves the old queue or the new one,
 * never a half. Every line that cannot be read is carried over verbatim and in order; each entry written is read
 * again from the file and checked, never taken from the memory a caller could have changed. Refuses a read-only
 * library and a locked project before anything is written, and a file in which no line can be read.
 */
export async function compactFindQueue(core: RepoCore, projectId: string): Promise<void> {
  core.assertWritable();
  const st0 = core.state(projectId);
  core.assertUnlocked(st0);
  const pre = await loadFolded(core, st0);
  if (!compactionDue(pre)) return;
  if (mostlyUnreadable(pre)) {
    note(core, MOSTLY_UNREADABLE, `${core.abs(queueRel(st0.rel))}:half`);
    return;
  }
  let details: Record<string, unknown> = {};
  try {
    await runMutation(
      core,
      projectId,
      REQ,
      async (tx) => {
        const st = tx.state;
        const folded = await loadFolded(core, st);
        if (!compactionDue(folded)) throw new NothingToWrite();
        if (mostlyUnreadable(folded)) {
          note(core, MOSTLY_UNREADABLE, `${core.abs(queueRel(st.rel))}:half`);
          throw new NothingToWrite();
        }
        const rel = queueRel(st.rel);
        const abs = core.abs(rel);
        const seal = tx.encrypted ? tx.key() : undefined;
        const key = seal ? seal.key : null;
        const out: string[] = [];
        const live: FindEntry[] = [];
        let carried = 0;
        let index = 0;
        for await (const text of readLines(abs, CARRY_MAX_BYTES)) {
          const i = index++;
          if (text === null) {
            note(core, "A line of the Find and acquire queue is too long to be carried over, so it was not compacted. Nothing has been changed.", `${abs}:long`);
            throw new NothingToWrite();
          }
          const e = parseLine(text, st.project.id, key);
          if (e === null) {
            out.push(text); // unreadable: carried over whole, in its place
            carried++;
            continue;
          }
          const cur = folded.map.get(e.id);
          if (folded.at.get(e.id) === i && cur && cur.removed !== true) {
            live.push(e);
            out.push(seal ? sealLine(seal.key, seal.keyId, st.project.id, JSON.stringify(e), PURPOSE) : JSON.stringify(e));
          }
        }
        const text = out.map((l) => `${l}\n`).join("");
        details = { count: live.length, states: countStates(live), linesBefore: folded.lines, linesAfter: out.length, unreadable: carried };
        // One atomic replacement, recorded in the marker first: a crash leaves the old file or this one.
        await tx.writeFile(rel, text, { mode: CHANGE_LOG_MODE });
        tx.onCommit(() => cacheOf(core).delete(abs));
      },
      { op: FIND_QUEUE_OPS.compact, entity: { type: "project", id: projectId }, auditDetails: () => details },
    );
  } catch (err) {
    if (err instanceof NothingToWrite) return;
    if (isSystemError(err)) throw new FindQueueUnwritableError();
    throw err;
  }
}
