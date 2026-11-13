/**
 * The queue of Find and acquire (Task F3): what the researcher typed, and where each line stands.
 * `<Project>/find/queue.jsonl`, one entry per line, append-only; the later line for an id wins. It follows
 * the register of a watched folder (`repo/watch-register.ts`): in an encrypted project every line is sealed
 * with the project key (purpose "ao-find-queue"), so a typed word or a title never sits in plain text there;
 * in a project that is not encrypted the lines are plain and the file is owner-only (0600), like other files of
 * the project that hold what the researcher wrote (flagged for the pseudonymisation review, R64).
 *
 * The queue is library data (R26): every change is ONE governed change (`runMutation`: the policy decision
 * `store {identifiable:false, hasLocation:false}`, a write-ahead transaction marker, an audit event). The audit
 * holds entry ids, counts by state and counts of lines, nothing else: never the typed text, a title, a name, a
 * host or an address (R177, R69). A crash anywhere in a write leaves the old queue or the new one.
 *
 * Lines. A change of an entry is a line: an add and an update write the entry; a remove writes a short line
 * with `removed: true` (the typed text is not repeated in it). Nothing is ever rewritten in place except by a
 * compaction.
 *
 * Compaction rewrites the file with only the live entries (those not removed), as one governed change
 * (`project.find.compact`) and one atomic replacement of the file, so that a crash leaves the old file or the new
 * one. It is due when the file passes 4 MB or holds more than 5 lines per live entry (at least 5 lines, however
 * few are live), provided that it would drop something; the append that makes it due does it.
 *
 * Reading folds the lines by id, streaming (memory: one entry per id, never one per line), and is tolerant of
 * the past and strict about shape: a line that does not parse, does not open, is of another project, has an
 * unknown state or a shape the type does not allow, or is too long, is skipped and counted (`skipped`), never
 * an error, and never deleted by a read or a write. The only thing a write removes is a last line torn by an
 * unclean stop (no newline after it), which is no committed line (R28); a read passes it by.
 */
import { statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { isId } from "@ao/core";
import { InvalidInputError } from "../repo/errors.js";
import { openLine, readMaybe, sealLine } from "../repo/io.js";
import { CHANGE_LOG_MODE, runMutation } from "../repo/mutate.js";
import type { ProjectState, RepoCore } from "../repo/state.js";
import { FIND_LINE_MAX_BYTES, FIND_QUEUE_MAX, FIND_QUEUE_OPS, FIND_STATES, FIND_TYPED_MAX, type FindEntry, type FindState } from "./types.js";

const PURPOSE = "ao-find-queue";
const DIR = "find";
const FILE = "queue.jsonl";
/** The policy request of every queue write: library data with nothing identifying in it, as the watch register's. */
const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

/** The file passes this many bytes: compaction is due. */
export const FIND_COMPACT_BYTES = 4 * 1024 * 1024;
/** The file holds more than this many lines for each live entry: compaction is due. */
export const FIND_COMPACT_LINES_PER_ENTRY = 5;

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

/** The queue could not be read because of the file system. The message carries no path. */
export class FindQueueUnreadableError extends Error {
  override name = "FindQueueUnreadableError";
  constructor() {
    super("The queue of this project could not be read.");
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
// Shape

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isOptStr = (v: unknown, max: number) => v === undefined || isStr(v, max);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isList = (v: unknown, max: number, each: (x: unknown) => boolean) => v === undefined || (Array.isArray(v) && v.length <= max && v.every(each));
const hasStrings = (...keys: string[]) => (x: unknown) => isObject(x) && keys.every((k) => typeof x[k] === "string");

/** Whether `e` is an entry of the queue as the type describes it (anything else is refused on write and skipped on read). */
export function isFindEntry(e: unknown): e is FindEntry {
  if (!isObject(e)) return false;
  const reason = e.reason;
  return (
    typeof e.id === "string" &&
    isId(e.id) &&
    isStr(e.projectId, 64) &&
    e.projectId.length > 0 &&
    (e.collectionId === undefined || (typeof e.collectionId === "string" && isId(e.collectionId))) &&
    isStr(e.typed, FIND_TYPED_MAX) &&
    (FIND_STATES as readonly unknown[]).includes(e.state) &&
    isStr(e.createdAt, 64) &&
    isStr(e.updatedAt, 64) &&
    isList(e.candidates, 10, hasStrings("id", "title")) &&
    isList(e.people, 20, hasStrings("id", "name")) &&
    isList(e.works, 200, hasStrings("id", "title")) &&
    isOptStr(e.chosen, 200) &&
    isOptStr(e.sourceId, 64) &&
    isOptStr(e.duplicateOf, 64) &&
    (e.elsewhere === undefined || e.elsewhere === true) &&
    (reason === undefined || (isObject(reason) && isStr(reason.code, 40) && (reason.by === undefined || reason.by === "rules" || reason.by === "settings"))) &&
    typeof e.attempts === "number" &&
    Number.isSafeInteger(e.attempts) &&
    e.attempts >= 0 &&
    isOptStr(e.nextTryAt, 64) &&
    isOptStr(e.parentId, 64) &&
    isList(e.offers, 20, hasStrings("label", "url", "host")) &&
    (e.removed === undefined || e.removed === true)
  );
}

/** Only the entry's own fields, in a fixed order (nothing else a caller put on the object is written). */
function clean(e: FindEntry): FindEntry {
  return {
    id: e.id,
    projectId: e.projectId,
    ...(e.collectionId !== undefined ? { collectionId: e.collectionId } : {}),
    typed: e.typed,
    state: e.state,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(e.candidates !== undefined ? { candidates: e.candidates } : {}),
    ...(e.people !== undefined ? { people: e.people } : {}),
    ...(e.works !== undefined ? { works: e.works } : {}),
    ...(e.chosen !== undefined ? { chosen: e.chosen } : {}),
    ...(e.sourceId !== undefined ? { sourceId: e.sourceId } : {}),
    ...(e.duplicateOf !== undefined ? { duplicateOf: e.duplicateOf } : {}),
    ...(e.elsewhere !== undefined ? { elsewhere: e.elsewhere } : {}),
    ...(e.reason !== undefined ? { reason: { code: e.reason.code, ...(e.reason.by !== undefined ? { by: e.reason.by } : {}) } } : {}),
    attempts: e.attempts,
    ...(e.nextTryAt !== undefined ? { nextTryAt: e.nextTryAt } : {}),
    ...(e.parentId !== undefined ? { parentId: e.parentId } : {}),
    ...(e.offers !== undefined ? { offers: e.offers } : {}),
    ...(e.removed !== undefined ? { removed: e.removed } : {}),
  };
}

/** The line that takes an entry out of the queue: what is needed to fold it, and not the typed text. */
function removalOf(cur: FindEntry, at: string): FindEntry {
  return {
    id: cur.id,
    projectId: cur.projectId,
    typed: "",
    state: cur.state,
    createdAt: cur.createdAt,
    updatedAt: at,
    attempts: cur.attempts,
    removed: true,
  };
}

function countStates(entries: readonly FindEntry[]): Record<FindState, number> {
  const out = Object.fromEntries(FIND_STATES.map((s) => [s, 0])) as Record<FindState, number>;
  for (const e of entries) out[e.state]++;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** The queue folded by id (removed entries are kept as such, so that nothing brings them back), with what the file holds. */
interface Folded {
  map: Map<string, FindEntry>;
  /** Lines in the file that end with a newline and are not blank (readable or not). */
  lines: number;
  /** Of those, the lines skipped. */
  skipped: number;
  /** The file's size in bytes. */
  size: number;
}

const liveOf = (f: Folded): FindEntry[] => [...f.map.values()].filter((e) => e.removed !== true);

/** The longest line the reader takes in: a sealed line is the entry's JSON in base64 inside a small envelope. */
const lineMax = (sealed: boolean) => (sealed ? Math.ceil((FIND_LINE_MAX_BYTES + 16) / 3) * 4 + 512 : FIND_LINE_MAX_BYTES);

/** Applies one entry to a folded map (the later wins; the map's order is the order of the latest lines). */
function apply(map: Map<string, FindEntry>, e: FindEntry): void {
  map.delete(e.id);
  map.set(e.id, Object.freeze(e));
}

/** Whether a line is a good entry of this project; the entry, or null. */
function parseLine(line: string, projectId: string, key: Uint8Array | null): FindEntry | null {
  try {
    const e = JSON.parse(key ? openLine(key, projectId, line, PURPOSE) : line) as unknown;
    return isFindEntry(e) && e.projectId === projectId ? e : null;
  } catch {
    return null;
  }
}

async function foldFile(abs: string, projectId: string, key: Uint8Array | null, size: number): Promise<Folded> {
  const out: Folded = { map: new Map(), lines: 0, skipped: 0, size };
  const max = lineMax(key !== null);
  const fh = await fsp.open(abs, "r");
  try {
    let carry: Buffer[] = [];
    let carryLen = 0;
    let discarding = false; // the line being read is over the limit: only its end is looked for
    const finish = (piece: Buffer) => {
      if (discarding) {
        out.lines++;
        out.skipped++;
      } else if (carryLen + piece.length > max) {
        out.lines++;
        out.skipped++;
      } else {
        const text = (carry.length ? Buffer.concat([...carry, piece]) : piece).toString("utf8");
        if (text.trim()) {
          out.lines++;
          const e = parseLine(text, projectId, key);
          if (e) apply(out.map, e);
          else out.skipped++;
        }
      }
      carry = [];
      carryLen = 0;
      discarding = false;
    };
    for await (const chunk of fh.createReadStream() as AsyncIterable<Buffer>) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) {
          if (!discarding) {
            carryLen += chunk.length - start;
            if (carryLen > max) {
              discarding = true;
              carry = [];
              carryLen = 0;
            } else carry.push(chunk.subarray(start));
          }
          break;
        }
        finish(chunk.subarray(start, nl));
        start = nl + 1;
      }
    }
    // What is left (no newline after it) is a line torn by an unclean stop: not a committed line, passed by here, cut away by the next write.
  } finally {
    await fh.close();
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

/** The project's queue folded (kept while the file is unchanged). The project must be unlocked. */
async function loadFolded(core: RepoCore, st: ProjectState): Promise<Folded> {
  const key = core.encrypted(st) ? core.key(st).key : null;
  const abs = core.abs(queueRel(st.rel));
  const cache = cacheOf(core);
  let stat: Awaited<ReturnType<typeof statBig>>;
  try {
    stat = await statBig(abs);
  } catch (err) {
    cache.delete(abs);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { map: new Map(), lines: 0, skipped: 0, size: 0 };
    throw new FindQueueUnreadableError();
  }
  const sig = sigOf(stat);
  const kept = cache.get(abs);
  if (kept && kept.sig === sig) return kept.folded;
  try {
    const folded = await foldFile(abs, st.project.id, key, Number(stat.size));
    cache.set(abs, { sig, folded });
    return folded;
  } catch (err) {
    cache.delete(abs);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { map: new Map(), lines: 0, skipped: 0, size: 0 };
    throw new FindQueueUnreadableError();
  }
}

/**
 * The project's queue: the entries that are not removed, by id, in the order of their latest lines, and how
 * many lines were skipped (see the top of this file). Refuses a locked encrypted project (ProjectLockedError)
 * before anything is read. Missing file → empty. The caller gets its own Map (the entries are frozen).
 */
export async function readFindQueueDetailed(core: RepoCore, projectId: string): Promise<{ entries: Map<string, FindEntry>; skipped: number }> {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const f = await loadFolded(core, st);
  return { entries: new Map(liveOf(f).map((e) => [e.id, e])), skipped: f.skipped };
}

/** The entries of the queue that are not removed, by id (see `readFindQueueDetailed` for the count of skipped lines). */
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
 * - `add`: the ids must not be in the queue (not even removed); more than `FIND_QUEUE_MAX` entries not removed
 *   after the add is `FindQueueFullError`, the whole batch refused. The count is made inside the governed
 *   change, which runs one at a time, so that two adds at once cannot both pass.
 * - `update`: an entry that is not in the queue or is removed is passed by (the runner may finish work on an
 *   entry the researcher removed meanwhile; it must not come back). `removed` is not written by an update.
 * - `remove`: writes a line `removed: true`; an entry not in the queue or already removed is passed by.
 *
 * Nothing is written, and nothing audited, when nothing is left to write. Refuses a read-only library
 * (ReadOnlyLibraryError) and a locked project (ProjectLockedError) before anything is written; an entry of
 * another project, one that is not an entry of the type, or two with one id in an add, is `InvalidInputError`;
 * an entry whose line would be over `FIND_LINE_MAX_BYTES` is `FindEntryTooLargeError` (refused, never cut).
 * Afterwards, when the file is due for compaction (see the top of this file), it is compacted by a change of
 * its own, which never fails this call.
 */
export async function appendFindEntries(core: RepoCore, projectId: string, entries: FindEntry[], op: Op): Promise<void> {
  core.assertWritable();
  if (op !== "add" && op !== "update" && op !== "remove") throw new InvalidInputError("This is not a change the queue knows.");
  const st0 = core.state(projectId);
  core.assertUnlocked(st0);
  if (!Array.isArray(entries) || entries.length > FIND_QUEUE_MAX) throw new InvalidInputError("The queue entries are not a list of at most 500.");
  const seen = new Set<string>();
  const cleaned: FindEntry[] = [];
  for (const e of entries) {
    if (!isFindEntry(e)) throw new InvalidInputError("A queue entry is not well formed.");
    if (e.projectId !== projectId) throw new InvalidInputError("A queue entry belongs to another project.");
    if (seen.has(e.id) && op === "add") throw new InvalidInputError("A queue entry is given twice.");
    seen.add(e.id);
    const c = clean(e);
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
  } catch {
    // Housekeeping: the change above is committed, and the next change tries again.
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
      const todo: FindEntry[] = [];
      const byId = new Map<string, FindEntry>();
      for (const c of given) {
        const cur = folded.map.get(c.id);
        if (op === "add") {
          if (cur) throw new InvalidInputError("A queue entry with this id is already there.");
          const { removed: _r, ...rest } = c;
          byId.set(c.id, rest);
        } else if (cur && cur.removed !== true) {
          if (op === "update") {
            const { removed: _r, ...rest } = c;
            byId.set(c.id, rest);
          } else byId.set(c.id, removalOf(cur, c.updatedAt));
        }
      }
      todo.push(...byId.values());
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
          for (const e of todo) apply(folded.map, { ...e });
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

const compactionDue = (f: Folded): boolean => {
  const live = liveOf(f).length;
  return f.lines > live && (f.size > FIND_COMPACT_BYTES || f.lines > FIND_COMPACT_LINES_PER_ENTRY * Math.max(live, 1));
};

/**
 * Rewrites the queue with only the live entries, when it is due (the file passes 4 MB, or holds more than 5 lines
 * per live entry, and there is something to drop); otherwise it changes nothing and audits nothing. ONE governed
 * change (`project.find.compact`; the audit holds `count`, `states`, `linesBefore`, `linesAfter` and `skipped`,
 * the lines that were not readable and are not carried over): the new file replaces the old one atomically
 * under the transaction marker, so a crash leaves the old queue or the new one, never a half. Refuses a
 * read-only library and a locked project before anything is written.
 */
export async function compactFindQueue(core: RepoCore, projectId: string): Promise<void> {
  core.assertWritable();
  const st0 = core.state(projectId);
  core.assertUnlocked(st0);
  if (!compactionDue(await loadFolded(core, st0))) return;
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
        const live = liveOf(folded);
        const seal = tx.encrypted ? tx.key() : undefined;
        const text = live.map((e) => `${seal ? sealLine(seal.key, seal.keyId, st.project.id, JSON.stringify(clean(e)), PURPOSE) : JSON.stringify(clean(e))}\n`).join("");
        const rel = queueRel(st.rel);
        const abs = core.abs(rel);
        details = { count: live.length, states: countStates(live), linesBefore: folded.lines, linesAfter: live.length, skipped: folded.skipped };
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
