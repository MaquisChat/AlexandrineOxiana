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
 * ONE routine reads and classifies the file's lines (`scanLines`), for the reader and for compaction alike, so that
 * what the reader sees and what compaction keeps cannot differ: every complete, non-blank line is either an
 * ENTRY (a line of at most 1 MiB that holds a good entry of this project: any length up to that is accepted on
 * read; the 64 KiB bound is on the entry's plain JSON and is enforced on WRITE only) or UNREADABLE (not JSON, a
 * state or shape this build does not know, a seal that does not open, another project's, or over 1 MiB, in
 * which case it is not even parsed).
 *
 * Compaction rewrites the file as one governed change (`project.find.compact`) and one atomic replacement, so
 * that a crash leaves the old file or the new one. It drops the superseded lines and the removed entries
 * ("dead" lines), and NOTHING ELSE: every unreadable complete line is carried over verbatim and in its place
 * among the others, because it may be a newer build's. Such lines are counted (`unreadableLines`) but are not
 * dead. Only a torn last line (no newline after it) is no committed line (R28) and goes. THE RULE: it is due
 * when `dead > live && dead >= 64`, where dead = the readable lines minus the live entries, whatever the file's
 * size (a large queue of live entries is not rewritten at every update, and a small queue is not rewritten at
 * every second change). It does not run when more than half of the file's lines cannot be read, when a line is
 * over 64 MiB or the file over 256 MiB (a note is left in `core.indexErrors`, once); it never runs on a file in
 * which no line can be read.
 *
 * Reading folds the lines by id, streaming (memory: one entry per id, never one per line), and is tolerant of
 * the past and strict about shape: an unreadable line is skipped and counted, never an error and never deleted
 * by a read or a write. But when the file holds lines and NONE can be read, the queue is not "empty": reads and
 * writes refuse (`FindQueueUnreadableError`) and nothing is written. The only thing a write removes is a last
 * line torn by an unclean stop (no newline after it); a read passes it by.
 */
import { statSync } from "node:fs";
import { Readable } from "node:stream";
import * as fsp from "node:fs/promises";
import { Creator, SourceType, isId } from "@ao/core";
import { InvalidInputError, ProjectLockedError } from "../repo/errors.js";
import { openLine, readMaybe, sealLine } from "../repo/io.js";
import { CHANGE_LOG_MODE, runMutation, type Tx } from "../repo/mutate.js";
import { PURPOSE_FIND_QUEUE } from "../repo/sealed-purposes.js";
import { lockPurges, type ProjectState, type RepoCore } from "../repo/state.js";
import type { WorkCandidate } from "./candidates.js";
import { FIND_DOI_MAX, FIND_LINE_MAX_BYTES, FIND_QUEUE_MAX, FIND_QUEUE_OPS, FIND_STATES, FIND_TYPED_MAX, type FindEntry, type FindState, type OfferLink, type PersonCandidate } from "./types.js";
import { KeyNotAvailableError } from "../crypto/format.js";

const PURPOSE = PURPOSE_FIND_QUEUE;
const DIR = "find";
const FILE = "queue.jsonl";
/** The policy request of every queue write: library data with nothing identifying in it, as the watch register's. */
const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
/** The longest line the reader takes in (memory safety): a longer one is unreadable and is not parsed. */
const RAW_LINE_MAX_BYTES = 1024 * 1024;
/** The longest line a compaction holds in order to carry it over verbatim; a longer one stops the compaction (and is left alone). */
const CARRY_MAX_BYTES = 64 * 1024 * 1024;
/** A file larger than this is not compacted (the new file is built in memory). */
const COMPACT_FILE_MAX_BYTES = 256 * 1024 * 1024;
/** Compaction is due only with at least this many dead lines (and more dead lines than live entries). */
const COMPACT_MIN_DEAD = 64;
/** At most this many notes are left in `core.indexErrors` for one repository. */
const NOTES_MAX = 20;

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
  identifiers = put(identifiers, "doi", opt(ids.doi, (v) => str(v, FIND_DOI_MAX)));
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
  // R270 e: subject names in place of sample titles. A line written before (with `sampleTitles`, never released) reads with none.
  out.subjects = p.subjects === undefined ? [] : list(p.subjects, 3, (t) => str(t, 100));
  return out as unknown as PersonCandidate;
}

function offerOf(x: unknown): OfferLink {
  const o = obj(x);
  const label = str(o.label, 40);
  if (!OFFER_LABELS.includes(label)) throw new Bad();
  return { label: label as OfferLink["label"], url: str(o.url, 2000), host: str(o.host, 253) };
}

function reasonOf(v: unknown): { code: string; by?: "rules" | "settings" } {
  const r = obj(v);
  const by = r.by;
  if (by !== undefined && by !== "rules" && by !== "settings") throw new Bad();
  return { code: str(r.code, 40, 1), ...(by !== undefined ? { by } : {}) };
}

/** Task F15: a `returnTo` of its shape (one of the two resting states, a reason), else undefined (not kept). */
function returnToOf(v: unknown): { state: "no-open-copy" | "record-complete"; reason?: { code: string; by?: "rules" | "settings" } } | undefined {
  if (v === undefined) return undefined;
  try {
    const t = obj(v);
    if (Object.keys(t).some((k) => k !== "state" && k !== "reason")) return undefined;
    if (t.state !== "no-open-copy" && t.state !== "record-complete") return undefined;
    return { state: t.state, ...(t.reason !== undefined ? { reason: reasonOf(t.reason) } : {}) };
  } catch (err) {
    if (err instanceof Bad) return undefined;
    throw err;
  }
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
    if (e.morePeople !== undefined && e.morePeople !== true) throw new Bad();
    if (e.moreWorks !== undefined && e.moreWorks !== true) throw new Bad();
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
    out = put(out, "reason", opt(e.reason, reasonOf));
    out = put(
      out,
      "match",
      opt(e.match, (v) => {
        const m = obj(v);
        const method = str(m.method, 40);
        if (method !== "find-match" && method !== "find-chosen") throw new Bad();
        const c = m.confidence;
        if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) throw new Bad();
        return { method, confidence: c };
      }),
    );
    out.attempts = attempts;
    out = put(out, "nextTryAt", opt(e.nextTryAt, (v) => str(v, 64)));
    out = put(out, "parentId", opt(e.parentId, id));
    out = put(out, "offers", opt(e.offers, (v) => list(v, 20, offerOf)));
    // Task F8 (R267): an author's entry says whether more people or works exist than are kept; an entry made from it
    // names the work it was made from (R271 M5: what was added is worked out from these, never stored; a round-1
    // line's `added` list is not read).
    out = put(out, "morePeople", e.morePeople);
    out = put(out, "moreWorks", e.moreWorks);
    out = put(out, "work", opt(e.work, (v) => str(v, 40, 1)));
    // Task F15 (R324 b): what a "waiting-sign-in" entry returns to — on that state only (elsewhere it is not kept). One
    // that is not of its shape is not kept either (the entry stays readable; the runner then says honestly that what it
    // was could not be read back, "library-unfinished").
    if (state === "waiting-sign-in") out = put(out, "returnTo", returnToOf(e.returnTo));
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
  } catch (err) {
    if (err instanceof KeyNotAvailableError) throw err; // a wiped key: the read was cut short by a lock (R386 a)
    return null;
  }
}

/** One complete, non-blank line of the file: its text (null when it is over the `holdMax` it was read with), and its classification. */
interface ScannedLine {
  text: string | null;
  /** The entry the line holds; null when the line is unreadable (see the top of this file). */
  entry: FindEntry | null;
}

/** A byte of blank space: the ONE definition of "blank" (a line of nothing but these is no line, however long). */
const isSpaceByte = (b: number) => b === 0x20 || (b >= 0x09 && b <= 0x0d);

/**
 * THE routine that reads and classifies the lines of the queue, in order, from a stream of chunks: used by the
 * reader (`foldFile`), by compaction, and by compaction's check of what it built, so that none of them can
 * disagree about what a line is. Nothing outside this routine decides that. A last line with no newline after it
 * is a torn line: not yielded. A line of nothing but blank space (`isSpaceByte`) is no line at all, whatever its
 * length and whatever `holdMax` is. A line is never held in memory beyond `holdMax` bytes (then `text` is null);
 * classification does not depend on `holdMax`: a line over `RAW_LINE_MAX_BYTES` is unreadable and is not parsed.
 */
async function* scanChunks(source: AsyncIterable<Buffer>, projectId: string, key: Uint8Array | null, holdMax: number): AsyncGenerator<ScannedLine> {
  let carry: Buffer[] = [];
  let carryLen = 0;
  let discarding = false;
  let blank = true; // every byte of the line so far is blank space
  const classify = (text: string | null, bytes: number): ScannedLine => ({ text, entry: text !== null && bytes <= RAW_LINE_MAX_BYTES ? parseLine(text, projectId, key) : null });
  const looksBlank = (seg: Buffer) => {
    if (!blank) return;
    for (const b of seg) {
      if (!isSpaceByte(b)) {
        blank = false;
        return;
      }
    }
  };
  for await (const chunk of source) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) {
        const seg = chunk.subarray(start);
        looksBlank(seg);
        if (!discarding) {
          carryLen += seg.length;
          if (carryLen > holdMax) {
            discarding = true;
            carry = [];
            carryLen = 0;
          } else carry.push(seg);
        }
        break;
      }
      const piece = chunk.subarray(start, nl);
      looksBlank(piece);
      if (!blank) {
        if (discarding || carryLen + piece.length > holdMax) yield classify(null, Infinity);
        else {
          const bytes = Buffer.concat([...carry, piece]);
          yield classify(bytes.toString("utf8"), bytes.length);
        }
      }
      carry = [];
      carryLen = 0;
      discarding = false;
      blank = true;
      start = nl + 1;
    }
  }
}

/** `scanChunks` over the queue file. */
async function* scanLines(abs: string, projectId: string, key: Uint8Array | null, holdMax: number): AsyncGenerator<ScannedLine> {
  const fh = await fsp.open(abs, "r");
  try {
    yield* scanChunks(fh.createReadStream() as AsyncIterable<Buffer>, projectId, key, holdMax);
  } finally {
    await fh.close();
  }
}

async function foldFile(abs: string, projectId: string, key: Uint8Array | null, size: number): Promise<Folded> {
  const out = emptyFolded();
  out.size = size;
  for await (const line of scanLines(abs, projectId, key, RAW_LINE_MAX_BYTES)) {
    const index = out.lines++;
    if (line.entry) apply(out, line.entry, index);
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

/** At lock (R386 a): the project's kept queue is dropped; no decrypted entry stays behind the lock. */
lockPurges.push((core, st) => {
  caches.get(core)?.delete(core.abs(queueRel(st.rel)));
});

/** Test seam: how many queues are kept for this repository. */
export function findCacheSize(repo: object): number {
  return caches.get((repo as { core: RepoCore }).core)?.size ?? 0;
}

/** Notes left for the developer in `core.indexErrors` (the repository's place for what does not fail a committed change): each kind once, and a few at most. */
const noted = new WeakMap<RepoCore, Set<string>>();
function note(core: RepoCore, message: string, once: string): void {
  let s = noted.get(core);
  if (!s) noted.set(core, (s = new Set()));
  if (s.has(once) || s.size >= NOTES_MAX) return;
  s.add(once);
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
    // Locked while it was read: refused as locked, and nothing is kept (R386 a).
    if (err instanceof KeyNotAvailableError) throw new ProjectLockedError(st.project.id);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyFolded();
    throw new FindQueueUnreadableError();
  }
  if (folded.lines > 0 && folded.unreadable === folded.lines) {
    cache.delete(abs);
    throw new FindQueueUnreadableError();
  }
  // R435 c: locked (key wiped) or being locked since the last line was opened: nothing decrypted is kept, nor handed
  // out after the lock: refused as locked.
  if (key && (!key.some((b) => b !== 0) || !core.keyRing.has(st.project.encryption.keyId ?? ""))) {
    cache.delete(abs);
    throw new ProjectLockedError(st.project.id);
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

/**
 * Task F15: "library-start" is an update (one entry, written "waiting-sign-in") governed with the capture of
 * `library_access` too — the rules are asked again inside the change, fail closed — and audited with that method.
 * Task F18c (R345): a start at one of the entry's own links is the same change with the method `free_copy`.
 */
type Op = "add" | "update" | "remove" | "library-start";
/** The method a start through the sign-in window is governed and audited with. */
export type FindStartMethod = "library_access" | "free_copy";
const startReq = (method: FindStartMethod) => ({ action: "capture" as const, capture: { method } });

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
 * - `alongside` (Task F8, R267; with `add` only): new lines of entries that ARE live in the queue (an author's entry
 *   whose works are added), written after the added entries in the same change and audited with them; one that is no
 *   longer in the queue refuses the whole add (InvalidInputError). They do not count against `FIND_QUEUE_MAX`.
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
export async function appendFindEntries(core: RepoCore, projectId: string, entries: FindEntry[], op: Op, alongside: FindEntry[] = [], method: FindStartMethod = "library_access"): Promise<void> {
  core.assertWritable();
  if (op !== "add" && op !== "update" && op !== "remove" && op !== "library-start") throw new InvalidInputError("This is not a change the queue knows.");
  if (op === "library-start" && (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.state !== "waiting-sign-in")) throw new InvalidInputError("This is not a change the queue knows.");
  if (method !== "library_access" && method !== "free_copy") throw new InvalidInputError("This is not a change the queue knows.");
  const st0 = core.state(projectId);
  core.assertUnlocked(st0);
  if (!Array.isArray(entries)) throw new InvalidInputError("The queue entries are not a list.");
  if (entries.length > FIND_QUEUE_MAX) {
    if (op === "add") throw new FindQueueFullError();
    throw new InvalidInputError("The queue entries are not a list of at most 500.");
  }
  // Task F8 (R267): an add may carry the new lines of entries already in the queue (the author's entry whose works
  // are added), written in the SAME governed change; each must be live in the queue then, or the whole add is refused.
  if (!Array.isArray(alongside) || alongside.length > FIND_QUEUE_MAX || (alongside.length > 0 && op !== "add")) throw new InvalidInputError("This is not a change the queue knows.");
  const seen = new Set<string>();
  const clean = (e: FindEntry): FindEntry => {
    const c = sanitizeEntry(e);
    if (!c) throw new InvalidInputError(NOT_WELL_FORMED);
    if (c.projectId !== projectId) throw new InvalidInputError("A queue entry belongs to another project.");
    if (seen.has(c.id) && op === "add") throw new InvalidInputError("A queue entry is given twice.");
    seen.add(c.id);
    if (Buffer.byteLength(JSON.stringify(c), "utf8") > FIND_LINE_MAX_BYTES) throw new FindEntryTooLargeError();
    return c;
  };
  const cleaned = entries.map(clean);
  const updates = alongside.map(clean);
  if (cleaned.length === 0) return;
  try {
    await write(core, projectId, op, cleaned, updates, method);
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
    const kind = err instanceof Error ? err.name : "Error";
    note(core, `The queue could not be compacted (${kind}); it will be tried again at the next change.`, `${core.abs(queueRel(st0.rel))}:failed:${kind}`);
  }
}

function write(core: RepoCore, projectId: string, op: Op, given: FindEntry[], alongside: FindEntry[] = [], method: FindStartMethod = "library_access"): Promise<void> {
  let written: FindEntry[] = [];
  const library = op === "library-start";
  return runMutation(
    core,
    projectId,
    library ? [startReq(method), REQ] : REQ,
    async (tx) => {
      written = await linesInTx(core, tx, op, given, alongside);
    },
    {
      op: FIND_QUEUE_OPS[op],
      entity: { type: "project", id: projectId },
      auditDetails: () => ({ entries: written.map((e) => e.id), count: written.length, states: countStates(written), ...(library ? { method } : {}) }),
    },
  );
}

/** Inside a running change: decides what is to be written against the queue as it is now, and appends it. */
async function linesInTx(core: RepoCore, tx: Tx, op: Op, given: FindEntry[], alongside: FindEntry[] = []): Promise<FindEntry[]> {
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
      if (op === "update" || op === "library-start") {
        const { removed: _r, ...rest } = c;
        byId.set(c.id, rest);
      } else byId.set(c.id, removalOf(cur, c.updatedAt));
    }
  }
  const added = [...byId.values()];
  if (added.length === 0) throw new NothingToWrite();
  if (op === "add" && liveOf(folded).length + added.length > FIND_QUEUE_MAX) throw new FindQueueFullError();
  // The lines of live entries that go with this add (F8): an entry no longer in the queue refuses the whole add.
  const along = alongside.map((c) => {
    const cur = folded.map.get(c.id);
    if (!cur || cur.removed === true) throw new InvalidInputError("That entry is no longer in the queue. Nothing was added.");
    const { removed: _r, ...rest } = c;
    return rest;
  });
  const todo = [...added, ...along];

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
  return todo;
}

/**
 * Task F11: new lines of entries written INSIDE a change another part of the library runs (the held file, its review
 * entry and the entry's line in one change; a decision in the review queue; a removal that discards a held file):
 * checked as `appendFindEntries` checks them. `update` and `remove` only. Returns what was written: an entry that is
 * no longer live in the queue is passed by (an empty list when nothing is left), so the caller decides whether that
 * undoes its whole change. The caller audits it (ids and counts only, R177).
 */
export async function appendFindLinesInTx(core: RepoCore, tx: Tx, op: "update" | "remove", entries: FindEntry[]): Promise<FindEntry[]> {
  if (op !== "update" && op !== "remove") throw new InvalidInputError("This is not a change the queue knows.");
  const cleaned = entries.map((e) => {
    const c = sanitizeEntry(e);
    if (!c) throw new InvalidInputError(NOT_WELL_FORMED);
    if (c.projectId !== tx.projectId) throw new InvalidInputError("A queue entry belongs to another project.");
    if (Buffer.byteLength(JSON.stringify(c), "utf8") > FIND_LINE_MAX_BYTES) throw new FindEntryTooLargeError();
    return c;
  });
  if (!cleaned.length) return [];
  try {
    return await linesInTx(core, tx, op, cleaned);
  } catch (err) {
    if (err instanceof NothingToWrite) return [];
    throw err;
  }
}

/** Counts by state of entries (for an audit entry: counts only). */
export const findStateCounts = (entries: readonly FindEntry[]): Record<FindState, number> => countStates(entries);

/**
 * Compaction's check of what it built: scans `text` with the routine the reader uses and compares with what the
 * reader saw. Returns what differs, or null when the new content holds exactly the live entries the reader saw
 * (same ids, same serialised content) and every carried line, byte for byte, in the same order.
 */
async function checkBuilt(text: string, projectId: string, key: Uint8Array | null, folded: Folded, sameCounts: boolean, carriedLines: readonly string[]): Promise<string | null> {
  if (!sameCounts) return "the lines counted differently";
  const seen = new Map<string, string>();
  const carried: string[] = [];
  for await (const { text: t, entry } of scanChunks(Readable.from([Buffer.from(text, "utf8")]), projectId, key, CARRY_MAX_BYTES)) {
    if (entry) seen.set(entry.id, JSON.stringify(entry));
    else carried.push(t ?? "");
  }
  const live = liveOf(folded);
  if (seen.size !== live.length) return "a different number of entries";
  for (const e of live) if (seen.get(e.id) !== JSON.stringify(e)) return "an entry that differs";
  if (carried.length !== carriedLines.length || carried.some((l, i) => l !== carriedLines[i])) return "lines carried over that differ";
  return null;
}

/** THE rule: due when dead > live && dead >= 64, dead being the readable lines minus the live entries, whatever the file's size. */
const compactionDue = (f: Folded): boolean => {
  const live = liveOf(f).length;
  const dead = f.lines - f.unreadable - live;
  return dead > live && dead >= COMPACT_MIN_DEAD;
};
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
        if (folded.size > COMPACT_FILE_MAX_BYTES) {
          note(core, "The Find and acquire queue is too large to be compacted. Nothing has been changed.", `${abs}:size`);
          throw new NothingToWrite();
        }
        const seal = tx.encrypted ? tx.key() : undefined;
        const key = seal ? seal.key : null;
        const out: string[] = [];
        const live: FindEntry[] = [];
        const carriedLines: string[] = [];
        let carried = 0;
        let index = 0;
        // The same routine as the reader's: an entry line is kept only as its id's latest and live; every other line is carried whole.
        for await (const { text, entry } of scanLines(abs, st.project.id, key, CARRY_MAX_BYTES)) {
          const i = index++;
          if (text === null) {
            note(core, "A line of the Find and acquire queue is too long to be carried over, so it was not compacted. Nothing has been changed.", `${abs}:long`);
            throw new NothingToWrite();
          }
          if (entry === null) {
            out.push(text); // unreadable: carried over whole, in its place
            carriedLines.push(text);
            carried++;
            continue;
          }
          const cur = folded.map.get(entry.id);
          if (folded.at.get(entry.id) === i && cur && cur.removed !== true) {
            live.push(entry);
            out.push(seal ? sealLine(seal.key, seal.keyId, st.project.id, JSON.stringify(entry), PURPOSE) : JSON.stringify(entry));
          }
        }
        const built = process.env.NODE_ENV === "test" && compactionSeams.mutateBuilt ? compactionSeams.mutateBuilt(out) : out;
        const text = built.map((l) => `${l}\n`).join("");
        // The check, before anything is written: the new content is scanned by the SAME routine and must hold exactly
        // what the reader saw (the same live entries, equal in content) and every carried line, byte for byte and in
        // order. If it does not, nothing is written: the file stays as it was.
        const disagreement = await checkBuilt(text, st.project.id, key, folded, live.length === liveOf(folded).length && index === folded.lines, carriedLines);
        if (disagreement !== null) {
          note(core, `The Find and acquire queue was not compacted: the new file did not hold what the old one did (${disagreement}). Nothing has been changed.`, `${abs}:invariant`);
          throw new NothingToWrite();
        }
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

/** Test-only seam (honoured only under NODE_ENV=test, R47): replaces the lines the compaction built, to force a disagreement. */
export const compactionSeams: { mutateBuilt?: (lines: string[]) => string[] } = {};
