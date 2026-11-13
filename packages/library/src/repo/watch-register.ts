/**
 * The register of a watched folder (cloud-drive folders, Task W3; R207 2 and 3): which file in the folder
 * became which source, and what has happened to that file since. `<Project>/watched/<watchId>.jsonl`, one
 * entry per line, append-only; the later line for a key wins. In an encrypted project every line is sealed
 * with the project key (purpose "ao-watch-register"), so a file's name never sits in plain text there; in a
 * project that is not encrypted the lines are plain and the file is owner-only (0600), like `batch.json`
 * locations (R69, flagged for the pseudonymisation review, R64).
 *
 * The register is library data (R26): every append is one governed change (`runMutation`: the policy decision,
 * a write-ahead transaction marker, the audit event `project.watched-folder.register`) whose audit details hold
 * the watch's id and counts only — never a key, a file name or a hash (R177, R69). A crash anywhere in the write
 * leaves the old register or the new one (the marker takes the appended lines back).
 *
 * What a line is NOT: a change to a source. A note "changed", "may-have-changed" or "gone" is a line here and
 * nothing else; no source, file or `annotations.json` changes because of what happened in the drive (Decision 4).
 *
 * Growth: one line per CHANGE of a file's state (a file that came in; a change, a removal, a return, a rename,
 * a settle), never one per scan. Reading folds the lines by key, streaming them (memory: one entry per key,
 * not per line).
 */
import { statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createInterface } from "node:readline";
import { isId } from "@ao/core";
import { InvalidInputError } from "./errors.js";
import { openLine, readMaybe, sealLine } from "./io.js";
import { CHANGE_LOG_MODE, runMutation } from "./mutate.js";
import { PURPOSE_WATCH_REGISTER } from "./sealed-purposes.js";
import type { RepoCore } from "./state.js";

/** What the register says about a file of the folder. */
export type WatchedFileState = "in-library" | "changed" | "may-have-changed" | "gone" | "settled";
export const WATCHED_FILE_STATES: readonly WatchedFileState[] = ["in-library", "changed", "may-have-changed", "gone", "settled"];

/**
 * One entry. `key` is `fileKey(file)` (NFC, "/"-separated, letter case kept); `file` is the name relative to the
 * watched folder as on disk. `sha256` is the content the source holds from this file. `size` and `mtimeNs` are
 * the file's reading (from `lstat`) when its content was last known — when it came in, or was last hashed — and
 * `mtimeNs` is the exact time in nanoseconds as a decimal string (A7: a JSON line cannot hold a bigint). For
 * "changed": `newSha256`/`newSize` are the content now in the folder; for "may-have-changed" (not read):
 * `newSize` is the size the file now has. `renamedFrom`: the key this file had before it was renamed or moved
 * (that key's entry is dropped when the register is read).
 */
export interface WatchRegisterEntry {
  key: string;
  file: string;
  sourceId: string;
  sha256: string;
  size: number;
  mtimeNs: string;
  state: WatchedFileState;
  newSha256?: string;
  newSize?: number;
  renamedFrom?: string;
  at: string;
}

export const WATCH_REGISTER_OP = "project.watched-folder.register";
const PURPOSE = PURPOSE_WATCH_REGISTER;
const DIR = "watched";
/** A name longer than this is not a name (a path component is at most 255 bytes; 20 levels deep at most). */
const NAME_MAX = 8192;
const SHA = /^[0-9a-f]{64}$/u;
const DIGITS = /^\d{1,30}$/u;
/** The register write's policy request: library data with nothing identifying in it (as the project's import settings). */
const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

const registerRel = (projectRel: string, watchId: string) => `${projectRel}/${DIR}/${watchId}.jsonl`;

function checkWatchId(watchId: string): void {
  if (typeof watchId !== "string" || !isId(watchId)) throw new InvalidInputError("This is not a watched folder's id.");
}

/** A relative name, "/"-separated: never absolute, no "." or ".." part, no NUL. */
function relativeName(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > NAME_MAX || s.includes("\0") || s.startsWith("/") || s.includes("\\") || /^[A-Za-z]:/u.test(s)) return false;
  return s.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

/** Whether `e` is a well-formed entry (anything else is refused on write and skipped on read). */
export function isRegisterEntry(e: unknown): e is WatchRegisterEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    relativeName(x.key) &&
    relativeName(x.file) &&
    typeof x.sourceId === "string" &&
    isId(x.sourceId) &&
    typeof x.sha256 === "string" &&
    SHA.test(x.sha256) &&
    Number.isSafeInteger(x.size) &&
    (x.size as number) >= 0 &&
    typeof x.mtimeNs === "string" &&
    DIGITS.test(x.mtimeNs) &&
    (WATCHED_FILE_STATES as readonly unknown[]).includes(x.state) &&
    (x.newSha256 === undefined || (typeof x.newSha256 === "string" && SHA.test(x.newSha256))) &&
    (x.newSize === undefined || (Number.isSafeInteger(x.newSize) && (x.newSize as number) >= 0)) &&
    (x.renamedFrom === undefined || relativeName(x.renamedFrom)) &&
    typeof x.at === "string"
  );
}

/** Only the entry's own fields, in a fixed order (nothing else a caller put on the object is written). */
function clean(e: WatchRegisterEntry): WatchRegisterEntry {
  return {
    key: e.key,
    file: e.file,
    sourceId: e.sourceId,
    sha256: e.sha256,
    size: e.size,
    mtimeNs: e.mtimeNs,
    state: e.state,
    ...(e.newSha256 !== undefined ? { newSha256: e.newSha256 } : {}),
    ...(e.newSize !== undefined ? { newSize: e.newSize } : {}),
    ...(e.renamedFrom !== undefined ? { renamedFrom: e.renamedFrom } : {}),
    at: e.at,
  };
}

/** Applies one entry to a folded map (the later wins; a rename drops the old key). */
function apply(map: Map<string, WatchRegisterEntry>, e: WatchRegisterEntry): void {
  if (e.renamedFrom !== undefined && e.renamedFrom !== e.key) map.delete(e.renamedFrom);
  map.delete(e.key); // re-inserted last: the map's order is the order of the latest lines
  map.set(e.key, Object.freeze(e));
}

/** Folds one line into the map. False when the line is unreadable (torn, damaged, of another project). */
function fold(map: Map<string, WatchRegisterEntry>, line: string, projectId: string, key: Uint8Array | null): boolean {
  try {
    const e = JSON.parse(key ? openLine(key, projectId, line, PURPOSE) : line) as unknown;
    if (!isRegisterEntry(e)) return false;
    apply(map, e);
    return true;
  } catch {
    return false;
  }
}

/** Whether an open file is empty or ends with a newline (one byte read). */
async function lastByteIsNewline(fh: fsp.FileHandle): Promise<boolean> {
  const { size } = await fh.stat();
  if (size === 0) return true;
  const b = Buffer.alloc(1);
  await fh.read(b, 0, 1, size - 1);
  return b[0] === 0x0a;
}

/** The register could not be read (A8, review I4). The message carries no path. */
export class WatchRegisterUnreadableError extends Error {
  constructor() {
    super("The record of which files in this folder are already in the library could not be read.");
    this.name = "WatchRegisterUnreadableError";
  }
}
/** The register could not be written because of the file system (A8, review I4). The message carries no path. */
export class WatchRegisterUnwritableError extends Error {
  constructor() {
    super("The record of which files in this folder are in the library could not be saved.");
    this.name = "WatchRegisterUnwritableError";
  }
}
const isSystemError = (err: unknown) => typeof (err as NodeJS.ErrnoException | null)?.code === "string" && typeof (err as NodeJS.ErrnoException).syscall === "string";

/**
 * The folded registers kept in memory (A8: not read whole again and again), per repository and file, with the
 * file's identity when they were read (size, time, inode). A read whose file is unchanged returns the folded map
 * without reading the file; a governed write updates the kept map in its commit.
 */
const caches = new WeakMap<RepoCore, Map<string, { sig: string; map: Map<string, WatchRegisterEntry> }>>();
const sigOf = (st: { size: bigint; mtimeNs: bigint; ino: bigint }) => `${st.size}:${st.mtimeNs}:${st.ino}`;
function cacheOf(core: RepoCore): Map<string, { sig: string; map: Map<string, WatchRegisterEntry> }> {
  let c = caches.get(core);
  if (!c) caches.set(core, (c = new Map()));
  return c;
}

/**
 * The register of a watch, folded by key. Refuses a locked encrypted project (ProjectLockedError) before
 * anything is read. Missing → empty. Unreadable lines — a last line torn by an unclean stop, a damaged line, a
 * line of another project — are skipped. A file that cannot be read at all → WatchRegisterUnreadableError.
 * The caller gets its own Map (the entries are frozen).
 */
export async function readWatchRegister(core: RepoCore, projectId: string, watchId: string): Promise<Map<string, WatchRegisterEntry>> {
  checkWatchId(watchId);
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const key = core.encrypted(st) ? core.key(st).key : null;
  const abs = core.abs(registerRel(st.rel, watchId));
  const cache = cacheOf(core);
  let sig: string;
  try {
    sig = sigOf(await fsp.stat(abs, { bigint: true }));
  } catch (err) {
    cache.delete(abs);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new WatchRegisterUnreadableError();
  }
  const kept = cache.get(abs);
  if (kept && kept.sig === sig) return new Map(kept.map);
  const map = new Map<string, WatchRegisterEntry>();
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(abs, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return map;
    throw new WatchRegisterUnreadableError();
  }
  // A last line without its newline is skipped, whole or torn, just as the next governed write cuts it away (N2).
  let endsWithNewline: boolean;
  try {
    endsWithNewline = await lastByteIsNewline(fh);
  } catch {
    await fh.close().catch(() => {});
    throw new WatchRegisterUnreadableError();
  }
  const stream = fh.createReadStream({ encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let held: string | null = null; // each line is folded once the next one shows it was finished
    for await (const line of lines) {
      if (held !== null && held.trim()) fold(map, held, st.project.id, key);
      held = line;
    }
    if (held !== null && held.trim() && endsWithNewline) fold(map, held, st.project.id, key);
  } catch {
    throw new WatchRegisterUnreadableError();
  } finally {
    lines.close();
    stream.destroy();
  }
  cache.set(abs, { sig, map });
  return new Map(map);
}

/** Counts by state, every state present (the audit's `states`). */
export function countStates(entries: readonly WatchRegisterEntry[]): Record<WatchedFileState, number> {
  const out = Object.fromEntries(WATCHED_FILE_STATES.map((s) => [s, 0])) as Record<WatchedFileState, number>;
  for (const e of entries) out[e.state]++;
  return out;
}

/**
 * Appends `entries` to a watch's register: ONE governed change (R26: policy, transaction marker, audit
 * `project.watched-folder.register` with `{ watch, entries, states }` — counts only). Nothing is written for no
 * entries. Refuses a read-only library and a locked project (in plain words, before anything is written).
 */
export async function recordWatchedFiles(core: RepoCore, projectId: string, watchId: string, entries: WatchRegisterEntry[]): Promise<void> {
  core.assertWritable();
  checkWatchId(watchId);
  if (!Array.isArray(entries)) throw new InvalidInputError("The register entries are not a list.");
  if (entries.length === 0) return;
  for (const e of entries) if (!isRegisterEntry(e)) throw new InvalidInputError("A register entry is not well formed.");
  const lines = entries.map(clean);
  try {
    await write(core, projectId, watchId, lines);
  } catch (err) {
    // A file-system error's message names the file: never passed on (R96, review I4).
    if (isSystemError(err)) throw new WatchRegisterUnwritableError();
    throw err;
  }
}

function write(core: RepoCore, projectId: string, watchId: string, lines: WatchRegisterEntry[]): Promise<void> {
  return runMutation(
    core,
    projectId,
    REQ,
    async (tx) => {
      const st = tx.state;
      const rel = registerRel(st.rel, watchId);
      const abs = core.abs(rel);
      // A last line torn by an unclean stop (not by this app's own writes, which the marker takes back) is removed
      // in this change, so that the register can be appended to again (A8, review I4).
      // Only the last byte is read to tell (N3); the whole file only when it is torn (rare).
      let torn = false;
      try {
        const fh = await fsp.open(abs, "r");
        try {
          torn = !(await lastByteIsNewline(fh));
        } finally {
          await fh.close();
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const raw = torn ? await readMaybe(abs) : null;
      if (raw && raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
        const end = raw.lastIndexOf(0x0a) + 1;
        await tx.writeFile(rel, raw.subarray(0, end), { mode: CHANGE_LOG_MODE });
      }
      tx.onCommit(() => {
        const cache = cacheOf(core);
        const kept = cache.get(abs);
        if (!kept) return;
        try {
          for (const e of lines) apply(kept.map, { ...e });
          kept.sig = sigOf(statSync(abs, { bigint: true }));
        } catch {
          cache.delete(abs);
        }
      });
      if (tx.encrypted) {
        const { key, keyId } = tx.key();
        for (const e of lines) await tx.appendLine(rel, sealLine(key, keyId, st.project.id, JSON.stringify(e), PURPOSE));
      } else {
        for (const e of lines) await tx.appendLine(rel, JSON.stringify(e), { mode: CHANGE_LOG_MODE });
      }
    },
    { op: WATCH_REGISTER_OP, entity: { type: "project", id: projectId }, auditDetails: { watch: watchId, entries: lines.length, states: countStates(lines) } },
  );
}

/** Every register of the project that names `sourceId`: which watch, and that file's entry (one per watch and key). */
export async function readWatchOrigins(core: RepoCore, projectId: string, sourceId: string): Promise<Array<{ watchId: string; entry: WatchRegisterEntry }>> {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  let names: string[];
  try {
    names = await fsp.readdir(core.abs(`${st.rel}/${DIR}`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WatchRegisterUnreadableError();
  }
  const out: Array<{ watchId: string; entry: WatchRegisterEntry }> = [];
  for (const n of names.sort()) {
    const watchId = n.endsWith(".jsonl") ? n.slice(0, -".jsonl".length) : "";
    if (!isId(watchId)) continue;
    for (const entry of (await readWatchRegister(core, projectId, watchId)).values()) if (entry.sourceId === sourceId) out.push({ watchId, entry });
  }
  return out;
}
