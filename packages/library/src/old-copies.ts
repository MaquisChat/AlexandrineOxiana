/**
 * Old copies left behind by library moves, waiting for the user to confirm
 * their deletion. Kept in the app config folder (outside every library, like
 * the registry), so the offer survives an app restart:
 * `<appConfigDir>/pending-old-copies.json` plus, per record, the list of
 * verified file hashes in `<appConfigDir>/old-copies/<id>.json`.
 *
 * The list follows the registry's rule (Task 68, ruling 1): missing is "none yet"; a read error
 * other than "missing" refuses (OldCopiesUnreadableError) and nothing is written; damaged content is
 * kept aside as `pending-old-copies.json.corrupt-<stamp>` by the next change, which starts a fresh
 * list (reading never moves anything: a damaged list reads as empty). Changes run one at a time.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { realpath as realpathCb } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Deps } from "./deps.js";
import { raiseDeviceNotice } from "./device-notices.js";
import { writeFileAtomic } from "./fs/atomic.js";

export const OLD_COPY_TTL_MS = 24 * 3600_000;

export interface PendingOldCopy {
  id: string;
  /** Absolute path of the old copy (on this device). */
  oldRoot: string;
  newRoot: string;
  libraryId: string;
  /** Absolute path of the verified-hash list in the app config folder. */
  verifiedHashesFile: string;
  createdAt: string;
  /** True when the old folder kept excluded projects and is now a separate library. */
  split: boolean;
  movedFolders: string[];
  movedProjectIds: string[];
  /** `Projects/<n>` folders of the old copy already moved away earlier (not part of this move; never deleted by it). */
  movedAway?: string[];
  moveId: string;
  /** False while the move's switch has not finished. */
  complete: boolean;
  /** When the switch finished (its record marked complete): the day-long offer of deletion runs from it (R583). */
  completedAt?: string;
  /**
   * Set when the app deleted the old copy (deleteOldCopy) but the record was kept (R409 a): something
   * of the library stayed at the old place (`remains`: a file it kept or could not remove, or data
   * of the moved projects outside what it deletes), or a destruction under the retention rule still
   * names the copy. Later retry passes go on looking at the place; the record is dropped once the
   * place holds nothing of the library and no destruction names it. Never offered for deletion again.
   */
  deleted?: { at: string; remains: boolean };
}

export interface VerifiedHashes {
  /** Library-relative path → SHA-256 of the verified file. */
  files: Record<string, string>;
  dirs: string[];
}

type CfgDeps = Pick<Deps, "appConfigDir" | "clock">;
const listFile = (d: CfgDeps) => join(d.appConfigDir, "pending-old-copies.json");

/**
 * The list of old library copies could not be read (Task 68, ruling 1): nothing was written. The
 * old copies themselves are untouched. The message carries no path.
 */
export class OldCopiesUnreadableError extends Error {
  /** `during: "move"`: a library move needed the list and was stopped before anything was switched. */
  constructor(readonly during?: "move") {
    super(
      during === "move"
        ? "The move was stopped before anything was switched: this computer's list of old library copies awaiting deletion could not be read. The library is still where it was and nothing was deleted; the copy made at the new place is not used, and no old copy is listed for deletion. Check that the app's settings folder can be read and try again."
        : "This computer's list of old library copies awaiting deletion could not be read, so it was not changed. Old copies stay where they are; check that the app's settings folder can be read and try again.",
    );
    this.name = "OldCopiesUnreadableError";
  }
}

const usable = (r: unknown): r is PendingOldCopy => typeof (r as PendingOldCopy | null)?.id === "string" && typeof (r as PendingOldCopy).oldRoot === "string";

/** The records, and whether anything in the file was unusable (`damaged`). Throws on a read error other than "missing". */
async function readList(deps: CfgDeps): Promise<{ records: PendingOldCopy[]; damaged: boolean }> {
  let raw: string;
  try {
    raw = await fsp.readFile(listFile(deps), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], damaged: false };
    throw new OldCopiesUnreadableError();
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { records: [], damaged: true };
  }
  const list = (v as { records?: unknown } | null)?.records;
  if (!Array.isArray(list)) return { records: [], damaged: true };
  const records = list.filter(usable);
  return { records, damaged: records.length !== list.length };
}

async function load(deps: CfgDeps): Promise<PendingOldCopy[]> {
  return (await readList(deps)).records;
}

/** `pending-old-copies.json.corrupt-<stamp>`, with `-n` when taken (nothing kept before is overwritten). */
async function corruptName(deps: CfgDeps): Promise<string> {
  const stamp = deps.clock().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  for (let n = 0; ; n++) {
    const name = `${listFile(deps)}.corrupt-${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      await fsp.lstat(name);
    } catch {
      return name;
    }
  }
}

async function save(deps: CfgDeps, records: PendingOldCopy[]): Promise<void> {
  await fsp.mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(listFile(deps), JSON.stringify({ formatVersion: 1, records }, null, 2), { mode: 0o600 });
}

const turns = new Map<string, Promise<unknown>>();

/**
 * A change of the list, in its turn: read (a read error refuses, nothing written), keep a damaged
 * file aside before anything is written over it, then write what `edit` returns.
 */
function changeList<T>(deps: CfgDeps, edit: (records: PendingOldCopy[]) => Promise<{ records: PendingOldCopy[] | null; result: T }>): Promise<T> {
  const key = listFile(deps);
  const run = (turns.get(key) ?? Promise.resolve()).then(async () => {
    const { records, damaged } = await readList(deps);
    const out = await edit(records);
    if (out.records === null) return out.result; // nothing to change
    if (damaged) {
      await fsp.rename(key, await corruptName(deps));
      // Never silent (R154, R178): a device-level notice says so (raising never throws).
      await raiseDeviceNotice(deps.appConfigDir, "old-copies-list-set-aside", deps.clock());
    }
    await save(deps, out.records);
    return out.result;
  });
  turns.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** Records a pending old copy (complete: false) with its verified hashes. */
export async function addPendingOldCopy(
  deps: CfgDeps,
  rec: Omit<PendingOldCopy, "id" | "verifiedHashesFile" | "createdAt" | "complete">,
  hashes: VerifiedHashes,
): Promise<PendingOldCopy> {
  // The list is read first: a list that cannot be read refuses before any hash list is written.
  return changeList(deps, async (records) => {
    const id = randomBytes(12).toString("hex");
    const dir = join(deps.appConfigDir, "old-copies");
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(dir, 0o700);
    const verifiedHashesFile = join(dir, `${id}.json`);
    await writeFileAtomic(verifiedHashesFile, JSON.stringify(hashes), { mode: 0o600 });
    const full: PendingOldCopy = { ...rec, id, verifiedHashesFile, createdAt: deps.clock().toISOString(), complete: false };
    return { records: [...records, full], result: full };
  });
}

/**
 * Moves whose switch has started but not finished (e.g. the app crashed): the
 * old copy may already be read-only. Finish each with `completeMove(newRoot, …)`.
 * With `at`, only the moves of the library `at.libraryId` out of or into the folder `at.folder`, matched by real path
 * (R599 M-3).
 */
export async function listUnfinishedMoves(
  deps: CfgDeps,
  at?: { libraryId: string; folder: string },
): Promise<Array<{ libraryId: string; oldRoot: string; newRoot: string; moveId: string; startedAt: string }>> {
  const out: Array<{ libraryId: string; oldRoot: string; newRoot: string; moveId: string; startedAt: string }> = [];
  for (const r of await load(deps)) {
    if (r.complete) continue;
    if (at && (r.libraryId !== at.libraryId || !((await sameFolder(r.oldRoot, at.folder)) || (await sameFolder(r.newRoot, at.folder))))) continue;
    out.push({ libraryId: r.libraryId, oldRoot: r.oldRoot, newRoot: r.newRoot, moveId: r.moveId, startedAt: r.createdAt });
  }
  return out;
}

/**
 * R583 M1, R590 N5: the two paths name the same folder — compared by what the folder is (its real path: links resolved,
 * the disk's own letter case), not by their text. A path that cannot be resolved is compared as written.
 */
const realpathNative = promisify(realpathCb.native);
export async function sameFolder(a: string, b: string): Promise<boolean> {
  const real = (p: string) => realpathNative(p).catch(() => resolve(p));
  return (await real(a)) === (await real(b));
}

/** This device's newest record of a move of the library `libraryId` out of the folder `oldRoot` (matched by real path). */
async function recordFrom(deps: CfgDeps, oldRoot: string, libraryId: string): Promise<PendingOldCopy | undefined> {
  const mine = (await load(deps)).filter((x) => x.libraryId === libraryId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of mine) if (await sameFolder(r.oldRoot, oldRoot)) return r;
  return undefined;
}

/**
 * R583 M2, R590 N4, N5: the one judgement of whether a recorded move has finished. "unfinished": the record is not
 * complete, or its journal is still at the new place; "damaged": a journal is at the new place but cannot be read, so the
 * app cannot finish the move; "cannot-tell": the record is complete but the new place cannot be read (its drive is not
 * connected), so whether its journal is still there is not known; "finished" otherwise. Everything but "finished" counts
 * as unfinished where it decides (it fails closed): the old copy is not deletable, and an old library of a split stays
 * read-only. The words (movedToOf) claim "has not finished" only for "unfinished" and "damaged" (R596 b).
 */
export type MoveFinished = "finished" | "unfinished" | "damaged" | "cannot-tell";
export async function moveFinished(rec: Pick<PendingOldCopy, "id" | "newRoot" | "complete">): Promise<MoveFinished> {
  const at = await journalAt(rec);
  if (at === "damaged") return "damaged";
  if (!rec.complete || at === "here") return "unfinished";
  return at === "unreachable" ? "cannot-tell" : "finished";
}

/** The move's journal at the record's new place: this record's ("here"), none or another move's ("absent"), unreadable as a journal ("damaged"), or the new place itself cannot be read ("unreachable"). */
async function journalAt(rec: Pick<PendingOldCopy, "id" | "newRoot">): Promise<"here" | "absent" | "damaged" | "unreachable"> {
  let raw: string;
  try {
    raw = await fsp.readFile(join(rec.newRoot, ".move-journal.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "unreachable";
    return (await fsp.stat(rec.newRoot).then((st) => st.isDirectory(), () => false)) ? "absent" : "unreachable";
  }
  let j: { libraryId?: unknown; filesDone?: unknown; switch?: { pendingId?: unknown } } | null;
  try {
    j = JSON.parse(raw) as typeof j;
  } catch {
    return "damaged";
  }
  // As the move reads its journal (move.ts readJournal): without these it is not a journal it can use.
  if (typeof j?.libraryId !== "string" || !Array.isArray(j.filesDone)) return "damaged";
  return j.switch?.pendingId === rec.id ? "here" : "absent";
}

/** Where the library at `oldRoot` was moved, from this device's records (newest first; the folder matched by real path). */
export async function movedToFor(deps: CfgDeps, oldRoot: string, libraryId: string): Promise<MovedTo | undefined> {
  const r = await recordFrom(deps, oldRoot, libraryId);
  return r ? movedToOf(r, await moveFinished(r)) : undefined;
}

export interface MovedTo {
  newRoot: string;
  unfinished: boolean;
  /** R590 N5: the move's journal at the new place is damaged: the app cannot finish this move. */
  journalDamaged?: true;
}
/**
 * The words say only what this computer knows (R596 b): "has not finished" only when it is seen to be unfinished (or its
 * journal is damaged); "cannot-tell" (a complete record, the new place unreadable) gives the plain moved words. The
 * deletion of the old copy still fails closed on it (deleteOldCopy).
 */
const movedToOf = (r: PendingOldCopy, state: MoveFinished): MovedTo => ({
  newRoot: r.newRoot,
  unfinished: state === "unfinished" || state === "damaged",
  ...(state === "damaged" ? { journalDamaged: true as const } : {}),
});

/**
 * R590 N1: this device's record shows an unfinished SPLIT out of the folder `root` (real path) for the library
 * `libraryId`, and at least one moved project there is already marked: the old library is then to open read-only as
 * moved, the projects that stayed included, until the new place has finished the move. (Once every moved project is
 * marked, its library.json carries the remaining library's id, and this no longer matches; while no project is marked
 * the move cannot be finished at the new place, and the old library is still the library.)
 */
export async function unfinishedSplitFrom(deps: CfgDeps, root: string, libraryId: string): Promise<MovedTo | undefined> {
  const r = await recordFrom(deps, root, libraryId);
  if (!r?.split) return undefined;
  const state = await moveFinished(r);
  if (state === "finished") return undefined;
  for (const f of r.movedFolders) {
    try {
      const m = JSON.parse(await fsp.readFile(join(root, ...f.split("/"), "MOVED.json"), "utf8")) as { libraryId?: unknown };
      if (m.libraryId === libraryId) return movedToOf(r, state);
    } catch {
      // not marked
    }
  }
  return undefined;
}

/**
 * FR-068 (R607 c): the folder `root`, of the library `libraryId`, holds the copy of this computer's move that stopped
 * after its switch began and before the old copy was marked, and the old place is seen to be the living library still:
 * the journal at `root` in its switching phase with no mark recorded; this computer's record of that move naming this
 * folder; the old place reachable, holding that library (its library.json's id) and no mark of any move (no top
 * MOVED.json, no moved project's MOVED.json). Returns the old place; undefined in every other case (no such journal,
 * another computer's move, another folder, the old place out of reach, marked by any move, or another library there).
 * Reads only.
 */
export async function staleMoveCopyAt(deps: CfgDeps, root: string, libraryId: string): Promise<string | undefined> {
  let j: { libraryId?: unknown; phase?: unknown; switch?: { pendingId?: unknown; done?: unknown; movedFolders?: unknown } } | null;
  try {
    j = JSON.parse(await fsp.readFile(join(root, ".move-journal.json"), "utf8")) as typeof j;
  } catch {
    return undefined;
  }
  const sw = j?.switch;
  if (j?.phase !== "switching" || j.libraryId !== libraryId || typeof sw?.pendingId !== "string" || !Array.isArray(sw.done) || sw.done.includes("mark-old")) return undefined;
  const rec = await getPendingOldCopy(deps, sw.pendingId).catch(() => undefined);
  if (!rec || rec.libraryId !== libraryId || !(await sameFolder(rec.newRoot, root))) return undefined;
  try {
    const meta = JSON.parse(await fsp.readFile(join(rec.oldRoot, "library.json"), "utf8")) as { libraryId?: unknown };
    if (meta.libraryId !== libraryId) return undefined;
  } catch {
    return undefined;
  }
  // A mark is anything but a folder of that name (a folder cannot be read as one); a place that cannot be looked at counts as marked.
  const marked = (p: string) => fsp.lstat(p).then((st) => !st.isDirectory(), (err: NodeJS.ErrnoException) => err.code !== "ENOENT");
  const folders = [...rec.movedFolders, ...(Array.isArray(sw.movedFolders) ? sw.movedFolders.filter((f): f is string => typeof f === "string") : [])];
  for (const p of [join(rec.oldRoot, "MOVED.json"), ...folders.map((f) => join(rec.oldRoot, ...f.split("/"), "MOVED.json"))]) {
    if (await marked(p)) return undefined;
  }
  return rec.oldRoot;
}

/**
 * R612 m-B: the folder `root`, of the library `libraryId`, holds the copy of this computer's move whose switch began and
 * whose own mark is neither recorded in the journal nor seen at the old place: the journal at `root` in its switching
 * phase without "mark-old" done; this computer's record of THAT move (its id) naming this folder; and the old place out
 * of reach, or showing no mark of that move (the top's MOVED.json, or for a split a moved project's, naming the library
 * with that move's id or with none, as the finishing at an opening counts it; for a split, nor its library.json rewritten
 * as that split's remaining library). No audit anchor can then be newer than this copy unless the library went on
 * elsewhere, so the copy's logs are not compared with this computer's record of them. Reads only.
 */
export async function unmarkedMoveCopyAt(deps: CfgDeps, root: string, libraryId: string): Promise<boolean> {
  let j: { libraryId?: unknown; phase?: unknown; switch?: { pendingId?: unknown; moveId?: unknown; done?: unknown; movedFolders?: unknown; remainingLibraryId?: unknown } } | null;
  try {
    j = JSON.parse(await fsp.readFile(join(root, ".move-journal.json"), "utf8")) as typeof j;
  } catch {
    return false;
  }
  const sw = j?.switch;
  if (j?.phase !== "switching" || j.libraryId !== libraryId || typeof sw?.pendingId !== "string" || typeof sw.moveId !== "string" || !Array.isArray(sw.done) || sw.done.includes("mark-old")) return false;
  const rec = await getPendingOldCopy(deps, sw.pendingId).catch(() => undefined);
  if (!rec || rec.libraryId !== libraryId || rec.moveId !== sw.moveId || !(await sameFolder(rec.newRoot, root))) return false;
  if (!(await fsp.stat(rec.oldRoot).then((st) => st.isDirectory(), () => false))) return true;
  const folders = Array.isArray(sw.movedFolders) ? sw.movedFolders.filter((f): f is string => typeof f === "string") : [];
  const marks = rec.split ? folders.map((f) => join(rec.oldRoot, ...f.split("/"), "MOVED.json")) : [join(rec.oldRoot, "MOVED.json")];
  for (const p of marks) {
    try {
      const m = JSON.parse(await fsp.readFile(p, "utf8")) as { libraryId?: unknown; moveId?: unknown };
      if (m.libraryId === libraryId && (m.moveId === undefined || m.moveId === sw.moveId)) return false;
    } catch {
      // no mark of that move here
    }
  }
  if (rec.split && typeof sw.remainingLibraryId === "string") {
    try {
      if ((JSON.parse(await fsp.readFile(join(rec.oldRoot, "library.json"), "utf8")) as { libraryId?: unknown }).libraryId === sw.remainingLibraryId) return false;
    } catch {
      // not rewritten
    }
  }
  return true;
}

export async function getPendingOldCopy(deps: CfgDeps, id: string): Promise<PendingOldCopy | undefined> {
  return (await load(deps)).find((r) => r.id === id);
}

/**
 * Every old copy this computer lists for the library `libraryId`, finished or not, its offer expired
 * or not, deleted with remains or not (a destruction under the retention rule must know them all,
 * R379), and whether the list is `damaged` (unparsable, or a record without a usable place: which
 * library it was cannot be told, so the list is not the whole truth, R409 a, b). Throws
 * OldCopiesUnreadableError when the list cannot be read.
 */
export async function oldCopiesOfLibrary(deps: CfgDeps, libraryId: string): Promise<{ records: PendingOldCopy[]; damaged: boolean }> {
  const { records, damaged } = await readList(deps);
  return { records: records.filter((r) => r.libraryId === libraryId), damaged };
}

/**
 * The app deleted the old copy `id` but its record is kept, marked deleted (R409 a): see
 * PendingOldCopy.deleted. Throws OldCopiesUnreadableError when the list cannot be read.
 */
export async function markPendingDeleted(deps: CfgDeps, id: string, remains: boolean): Promise<void> {
  return changeList(deps, async (all) => {
    const r = all.find((x) => x.id === id);
    if (!r) return { records: null, result: undefined };
    r.deleted = { at: deps.clock().toISOString(), remains: remains || r.deleted?.remains === true };
    return { records: all, result: undefined };
  });
}

export async function markPendingComplete(deps: CfgDeps, id: string): Promise<void> {
  return changeList(deps, async (all) => {
    const r = all.find((x) => x.id === id);
    if (!r || r.complete) return { records: null, result: undefined };
    r.complete = true;
    r.completedAt = deps.clock().toISOString();
    return { records: all, result: undefined };
  });
}

export async function removePendingOldCopy(deps: CfgDeps, id: string): Promise<void> {
  const r = await changeList(deps, async (all) => {
    const found = all.find((x) => x.id === id);
    return found ? { records: all.filter((x) => x.id !== id), result: found } : { records: null, result: undefined };
  });
  if (r) await fsp.rm(r.verifiedHashesFile, { force: true });
}

export async function readVerifiedHashes(rec: PendingOldCopy): Promise<VerifiedHashes> {
  return JSON.parse(await fsp.readFile(rec.verifiedHashesFile, "utf8")) as VerifiedHashes;
}

/** From when the offer of deletion runs: the switch's finishing (a move finished later, R583), else the record's making. */
const offerFrom = (rec: PendingOldCopy) => {
  const done = typeof rec.completedAt === "string" ? Date.parse(rec.completedAt) : Number.NaN;
  return Number.isNaN(done) ? Date.parse(rec.createdAt) : done;
};
export const isExpired = (rec: PendingOldCopy, deps: Pick<Deps, "clock">) => deps.clock().getTime() > offerFrom(rec) + OLD_COPY_TTL_MS;

/** Old copies of finished moves that can still be deleted with `deleteOldCopy(oldRoot, { confirm: true })`. */
export async function listPendingOldCopies(deps: CfgDeps): Promise<Array<PendingOldCopy & { expiresAt: string; expired: boolean }>> {
  return (await load(deps))
    // A copy the app already deleted (kept only to be looked at again, R409 a) is not offered again.
    .filter((r) => r.complete && !r.deleted)
    .map((r) => ({ ...r, expiresAt: new Date(offerFrom(r) + OLD_COPY_TTL_MS).toISOString(), expired: isExpired(r, deps) }));
}
