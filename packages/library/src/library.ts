import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { newId } from "@ao/core";
import type { Deps } from "./deps.js";
import { writeFileAtomic } from "./fs/atomic.js";
import {
  LockNotWritableError,
  NOT_WRITABLE_CODES,
  acquireLock,
  peekLock,
  readLock,
  releaseLock,
  startHeartbeat,
  type LockInfo,
} from "./lock.js";
import { movedToFor } from "./old-copies.js";
import { registerLibrary } from "./registry.js";

export const FORMAT_VERSION = 1;
const SUBDIRS = ["Projects", "Exports", "Backups", ".cache", ".tmp"];
const MAX_HISTORY = 50;

export interface LibraryJson {
  libraryId: string;
  name: string;
  formatVersion: 1;
  createdAt: string;
  locationHistory: Array<{ at: string; hint: string }>;
  /** Set on the library left behind by a move that excluded projects: the id of the library it was split from. */
  splitFrom?: string;
}

export interface Library {
  id: string;
  name: string;
  root: string;
  mode: "read-write" | "read-only";
  /**
   * `moved`: the library was moved elsewhere and this folder is the old copy (MOVED.json).
   * `move-incomplete`: a move into this folder has not finished (.move-journal.json).
   */
  readOnlyReason?: "locked-by-other-device" | "newer-format" | "offline" | "not-writable" | "moved" | "move-incomplete";
  /**
   * For a `moved` old copy: where it went, from this device's records. `unfinished` means the
   * move's switch did not finish; complete it with `completeMove(newRoot, …)`.
   */
  movedTo?: { newRoot: string; unfinished: boolean };
  /** App-level config folder (outside the library), from Deps; holds the registry and audit anchors. */
  appConfigDir: string;
  /** This device's id, from Deps; recorded in audit events and change log entries. */
  deviceId: string;
  close(): Promise<void>;
}

export class NotALibraryError extends Error {
  constructor(root: string) {
    super(`Not a library (no library.json): ${root}`);
    this.name = "NotALibraryError";
  }
}
export class CorruptLibraryError extends Error {
  constructor(detail: string) {
    super(`Corrupt library: ${detail}`);
    this.name = "CorruptLibraryError";
  }
}
export class FolderNotEmptyError extends Error {
  constructor(root: string) {
    super(`Folder is not empty: ${root}`);
    this.name = "FolderNotEmptyError";
  }
}
export class LibraryNotWritableError extends Error {
  constructor(root: string) {
    super(`Library folder is not writable: ${root}`);
    this.name = "LibraryNotWritableError";
  }
}
export interface OpenOptions {
  /** Called when a read-write handle loses its lock (see startHeartbeat). */
  onLockLost?: (holder: LockInfo | null) => void;
}

/** Roots opened read-write by this process (guards a same-process double open). */
const openRoots = new Set<string>();

export class AlreadyALibraryError extends Error {
  constructor(root: string) {
    super(`Folder already contains a library: ${root}`);
    this.name = "AlreadyALibraryError";
  }
}

/** Left in the old folder (or old project folder) after a library move. */
export const MOVED_MARKER = "MOVED.json";
/** Journal of a library move, in the destination until the move has finished. */
export const MOVE_JOURNAL = ".move-journal.json";

/**
 * True when `Projects/<folderName>` holds a valid marker of a project moved to
 * another library: it parses, names this library or the one it was split
 * from, and its project.json has not changed since the marker was written.
 * Anything else is an ordinary project folder (governed, loaded, moved).
 */
export async function projectMovedAway(root: string, folderName: string): Promise<boolean> {
  const dir = join(root, "Projects", folderName);
  try {
    const mst = await lstat(join(dir, MOVED_MARKER));
    if (!mst.isFile()) return false;
    const m = JSON.parse(await readFile(join(dir, MOVED_MARKER), "utf8")) as { libraryId?: unknown; movedAt?: unknown };
    if (typeof m.libraryId !== "string" || typeof m.movedAt !== "string" || Number.isNaN(Date.parse(m.movedAt))) return false;
    const meta = JSON.parse(await readFile(metaPath(root), "utf8")) as Partial<LibraryJson>;
    if (m.libraryId !== meta.libraryId && m.libraryId !== meta.splitFrom) return false;
    const pj = await lstat(join(dir, "project.json")).catch(() => null);
    return !(pj && pj.mtimeMs > Math.max(Date.parse(m.movedAt), mst.mtimeMs));
  } catch {
    return false;
  }
}

const metaPath = (root: string) => join(root, "library.json");
const hintFor = (root: string, deps: Deps) => `${deps.hostname}:${basename(root)}`;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function createLibrary(
  root: string,
  name: string,
  deps: Deps,
  opts: OpenOptions = {},
): Promise<Library> {
  if (await exists(metaPath(root))) throw new AlreadyALibraryError(root);
  try {
    await mkdir(root, { recursive: true });
    if ((await readdir(root)).length > 0) throw new FolderNotEmptyError(root);
    for (const d of SUBDIRS) await mkdir(join(root, d), { recursive: true });
    const at = deps.clock().toISOString();
    const meta: LibraryJson = {
      libraryId: newId(),
      name,
      formatVersion: FORMAT_VERSION,
      createdAt: at,
      locationHistory: [{ at, hint: hintFor(root, deps) }],
    };
    await writeFileAtomic(metaPath(root), JSON.stringify(meta, null, 2));
  } catch (err) {
    if (NOT_WRITABLE_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw new LibraryNotWritableError(root);
    throw err;
  }
  const lib = await openLibrary(root, deps, opts);
  if (lib.readOnlyReason === "not-writable") throw new LibraryNotWritableError(root);
  return lib;
}

async function readMeta(root: string): Promise<LibraryJson> {
  let raw: string;
  try {
    raw = await readFile(metaPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new NotALibraryError(root);
    }
    throw err;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new CorruptLibraryError("library.json is not valid JSON");
  }
  const o = v as Partial<LibraryJson> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    typeof o.libraryId !== "string" ||
    typeof o.name !== "string" ||
    typeof o.formatVersion !== "number" ||
    !Number.isInteger(o.formatVersion) ||
    o.formatVersion < 1
  ) {
    throw new CorruptLibraryError("library.json is missing required fields or has a bad formatVersion");
  }
  return {
    ...(o as LibraryJson),
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    locationHistory: Array.isArray(o.locationHistory) ? o.locationHistory : [],
  };
}

export function openLibrary(root: string, deps: Deps, opts: OpenOptions = {}): Promise<Library> {
  return openLibraryInternal(root, deps, opts, {});
}

/** Package-internal: `ignoreMoveJournal` lets the move itself open its destination before the move has finished. */
export async function openLibraryInternal(
  root: string,
  deps: Deps,
  opts: OpenOptions,
  internal: { ignoreMoveJournal?: boolean },
): Promise<Library> {
  const meta = await readMeta(root);
  const key = resolve(root);
  const readOnly = (reason: NonNullable<Library["readOnlyReason"]>): Library => ({
    id: meta.libraryId,
    name: meta.name,
    root,
    mode: "read-only",
    readOnlyReason: reason,
    appConfigDir: deps.appConfigDir,
    deviceId: deps.deviceId,
    close: async () => {},
  });

  // Read-only opens must not touch the library folder at all.
  if ((meta.formatVersion as number) > FORMAT_VERSION) {
    await note(root, meta, deps);
    return readOnly("newer-format");
  }
  // A moved-away copy or an unfinished move: read-only, and not recorded as the library's location.
  if (await exists(join(root, MOVED_MARKER))) {
    const movedTo = await movedToFor(deps, resolve(root), meta.libraryId).catch(() => undefined);
    return { ...readOnly("moved"), ...(movedTo ? { movedTo } : {}) };
  }
  if (!internal.ignoreMoveJournal && (await exists(join(root, MOVE_JOURNAL)))) return readOnly("move-incomplete");
  // Same-process double open: the lock on disk is ours, so the lock rules
  // alone would let a second handle through.
  const onDisk = await readLock(root);
  if (openRoots.has(key) && onDisk !== null && onDisk !== "corrupt" && onDisk.deviceId === deps.deviceId && onDisk.pid === deps.pid) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device");
  }
  if (await peekLock(root, deps)) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device");
  }
  let got: Awaited<ReturnType<typeof acquireLock>>;
  try {
    got = await acquireLock(root, deps);
  } catch (err) {
    if (err instanceof LockNotWritableError) {
      await note(root, meta, deps);
      return readOnly("not-writable");
    }
    throw err;
  }
  if (!got.acquired) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device");
  }

  openRoots.add(key);
  const state: { mode: Library["mode"]; reason?: Library["readOnlyReason"] } = { mode: "read-write" };
  let hb: ReturnType<typeof startHeartbeat> | undefined;
  try {
    hb = startHeartbeat(root, deps, (holder) => {
      // Lock lost: demote this handle to read-only and tell the caller.
      state.mode = "read-only";
      state.reason = "locked-by-other-device";
      openRoots.delete(key);
      opts.onLockLost?.(holder);
    });
    // Re-read: library.json may have changed while we waited for the lock.
    const fresh = await readMeta(root);
    const hint = hintFor(root, deps);
    const history = fresh.locationHistory;
    if (history[history.length - 1]?.hint !== hint) {
      history.push({ at: deps.clock().toISOString(), hint });
      fresh.locationHistory = history.slice(-MAX_HISTORY);
      await writeFileAtomic(metaPath(root), JSON.stringify(fresh, null, 2));
    }
    await note(root, fresh, deps);
  } catch (err) {
    openRoots.delete(key);
    await hb?.stop();
    await releaseLock(root, deps).catch(() => {});
    throw err;
  }

  let closed = false;
  return {
    id: meta.libraryId,
    name: meta.name,
    root,
    get mode() {
      return state.mode;
    },
    get readOnlyReason() {
      return state.reason;
    },
    appConfigDir: deps.appConfigDir,
    deviceId: deps.deviceId,
    async close() {
      if (closed) return;
      closed = true;
      openRoots.delete(key);
      await hb?.stop();
      await releaseLock(root, deps);
    },
  };
}

/** Records the library in the app-level registry (outside the library folder). */
async function note(root: string, meta: LibraryJson, deps: Deps): Promise<void> {
  try {
    await registerLibrary({ libraryId: meta.libraryId, name: meta.name, path: root }, deps);
  } catch {
    // the registry is a convenience; never fail an open because of it
  }
}
