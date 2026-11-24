import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { newId } from "@ao/core";
import type { Deps } from "./deps.js";
import { writeFileAtomic } from "./fs/atomic.js";
import { CloseInsideChangeError } from "./repo/errors.js";
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
  /**
   * With `locked-by-other-device`: the name of the device holding the lock (its hostname from the
   * lock file), when known and plausible. Only the device's name: the lock records no user name.
   */
  lockedBy?: string;
  /** App-level config folder (outside the library), from Deps; holds the registry and audit anchors. */
  appConfigDir: string;
  /** This device's id, from Deps; recorded in audit events and change log entries. */
  deviceId: string;
  /**
   * Refuses every further write, waits for the change in its store turn (and a backup in flight), then releases the
   * lock (R247 c, d; R546 1). `beforeRelease` runs after that wait and before the release (R551 M7: the index, which
   * the change still updated, is closed there — its file is in the library). A second call returns the first's promise.
   */
  close(opts?: { beforeRelease?: () => void | Promise<void> }): Promise<void>;
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
/**
 * FR-047: the Finder's housekeeping files, which it writes into any folder it has shown. A folder whose only entries are
 * these — regular files of exactly these names — counts as empty where the library needs an empty folder (a new
 * library, a move's destination); they are left where they are. Anything else (another hidden file, a folder or a
 * link of such a name) still counts.
 */
export const FINDER_FILES: ReadonlySet<string> = new Set([".DS_Store", ".localized"]);

/** The names in `dir` other than the Finder's own housekeeping files (FINDER_FILES, as regular files). */
export async function entriesBesidesFinderFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => !(FINDER_FILES.has(e.name) && e.isFile())).map((e) => e.name);
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
/** The folder holds a different library than the one expected (reconnect). */
export class WrongLibraryError extends Error {
  override name = "WrongLibraryError";
  constructor(
    readonly expectedId: string,
    readonly foundId: string,
  ) {
    super(`This folder holds a different library (${foundId}), not the one being reconnected (${expectedId})`);
  }
}

/**
 * The folder is the old copy of a library that was moved elsewhere (MOVED.json). `movedTo` is
 * where it went, from this device's records, when known; `toHint` is the marker's
 * `host:folder` hint.
 */
export class LibraryMovedError extends Error {
  override name = "LibraryMovedError";
  constructor(
    readonly root: string,
    readonly movedTo?: { newRoot: string; unfinished: boolean },
    readonly toHint?: string,
  ) {
    super(
      `This folder is an old copy of a library that was moved${movedTo ? ` to ${movedTo.newRoot}` : toHint ? ` (to ${toHint})` : ""}; reconnect to the new location instead`,
    );
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
    if ((await entriesBesidesFinderFiles(root)).length > 0) throw new FolderNotEmptyError(root);
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

/** Reads and validates `<root>/library.json` (NotALibraryError, CorruptLibraryError). Writes nothing. */
export async function readLibraryMeta(root: string): Promise<LibraryJson> {
  return readMeta(root);
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
  const readOnly = (reason: NonNullable<Library["readOnlyReason"]>, movedTo?: Library["movedTo"], holder?: LockInfo | null): Library =>
    makeHandle(meta, root, deps, { mode: "read-only", reason, ...holderName(holder) }, movedTo);

  // Read-only opens must not touch the library folder at all.
  if ((meta.formatVersion as number) > FORMAT_VERSION) {
    await note(root, meta, deps);
    return readOnly("newer-format");
  }
  // A moved-away copy or an unfinished move: read-only, and not recorded as the library's location.
  if (await exists(join(root, MOVED_MARKER))) {
    const movedTo = await movedToFor(deps, resolve(root), meta.libraryId).catch(() => undefined);
    return readOnly("moved", movedTo);
  }
  if (!internal.ignoreMoveJournal && (await exists(join(root, MOVE_JOURNAL)))) return readOnly("move-incomplete");
  // Same-process double open: the lock on disk is ours, so the lock rules
  // alone would let a second handle through.
  const onDisk = await readLock(root);
  if (openRoots.has(key) && onDisk !== null && onDisk !== "corrupt" && onDisk.deviceId === deps.deviceId && onDisk.pid === deps.pid) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device", undefined, onDisk);
  }
  const peeked = await peekLock(root, deps);
  if (peeked) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device", undefined, peeked);
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
    return readOnly("locked-by-other-device", undefined, got.holder);
  }

  openRoots.add(key);
  const state: HandleState = { mode: "read-write" };
  let hb: ReturnType<typeof startHeartbeat> | undefined;
  /** Lock lost: demote this handle to read-only and tell the caller. */
  const lockLost = (holder: LockInfo | null) => {
    state.mode = "read-only";
    state.reason = "locked-by-other-device";
    state.lockedBy = holderName(holder).lockedBy;
    state.held = false;
    openRoots.delete(key);
    opts.onLockLost?.(holder);
  };
  try {
    hb = startHeartbeat(root, deps, lockLost);
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
  state.held = true;

  const lib = makeHandle(meta, root, deps, state, undefined, async () => {
    if (state.held) openRoots.delete(key);
    state.held = false;
    await hb?.stop();
    await releaseLock(root, deps);
  });
  const ctl = controls.get(lib)!;
  ctl.stopLock = async () => {
    // Offline: the heartbeat could neither refresh nor read the lock; stop it rather than let it
    // report a lost lock after the stale window. The lock file (if still there) is left as is.
    await hb?.stop();
    hb = undefined;
  };
  ctl.reacquire = async (acceptNotWritable: boolean) => {
    // Back online: the lock must be ours again before the handle may write.
    const holder = await peekLock(root, deps);
    if (ctl.closed) return;
    if (holder) {
      lockLost(holder);
      return;
    }
    let again: Awaited<ReturnType<typeof acquireLock>>;
    try {
      again = await acquireLock(root, deps);
    } catch (err) {
      // A drive that is still coming back may refuse writes for a moment: stay offline (the
      // caller retries) unless the caller has seen this persist.
      if (err instanceof LockNotWritableError && acceptNotWritable) {
        state.mode = "read-only";
        state.reason = "not-writable";
        state.held = false;
        openRoots.delete(key);
        return;
      }
      throw err;
    }
    if (ctl.closed) {
      // Closed while we were re-acquiring: give the lock back.
      if (again.acquired) await releaseLock(root, deps).catch(() => {});
      return;
    }
    if (!again.acquired) {
      lockLost(again.holder);
      return;
    }
    hb = startHeartbeat(root, deps, lockLost);
    state.mode = "read-write";
    state.reason = undefined;
    state.lockedBy = undefined;
  };
  return lib;
}

/**
 * The device name to show for a lock holder: its hostname, if it is a plausible device name (1 to
 * 253 characters, no control, format or line-separator characters). The lock file is written by
 * whatever device holds the library, so anything else is not passed on.
 */
function holderName(holder: LockInfo | null | undefined): { lockedBy?: string } {
  const h = holder?.hostname;
  if (typeof h !== "string") return {};
  const name = h.trim();
  if (name.length === 0 || name.length > 253 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) return {};
  return { lockedBy: name };
}

interface HandleState {
  mode: Library["mode"];
  reason?: Library["readOnlyReason"];
  /** The lock holder's device name while `reason` is locked-by-other-device. */
  lockedBy?: string | undefined;
  /** True while this handle holds the library lock. */
  held?: boolean;
}

/** Package-internal control of a handle's availability (see `watchAvailability` in reconnect.ts). */
interface HandleControl {
  state: HandleState;
  closed: boolean;
  /**
   * FR-749 (R546 1): what `close()` waits for before the lock is released — the change already in its store turn of
   * each repository opened on this handle (registered with `onClose`), without a time limit (R247 d).
   */
  drains: Array<CloseDrain>;
  /** FR-749 (R551 M1): the first `close()`'s promise; every later call returns it (never before the lock is released). */
  closing?: Promise<void>;
  /** The mode and reason before the library went offline. */
  beforeOffline?: { mode: Library["mode"]; reason?: Library["readOnlyReason"] };
  /** Read-write handles only: stop the heartbeat while offline. */
  stopLock?: () => Promise<void>;
  /** Read-write handles only: re-acquire the lock when the library is back. */
  reacquire?: (acceptNotWritable: boolean) => Promise<void>;
}
const controls = new WeakMap<Library, HandleControl>();

function makeHandle(
  meta: LibraryJson,
  root: string,
  deps: Deps,
  state: HandleState,
  movedTo: Library["movedTo"],
  release?: () => Promise<void>,
): Library {
  const ctl: HandleControl = { state, closed: false, drains: [] };
  const lib: Library = {
    id: meta.libraryId,
    name: meta.name,
    root,
    get mode() {
      return state.mode;
    },
    get readOnlyReason() {
      return state.reason;
    },
    get lockedBy() {
      return state.reason === "locked-by-other-device" ? state.lockedBy : undefined;
    },
    ...(movedTo ? { movedTo } : {}),
    appConfigDir: deps.appConfigDir,
    deviceId: deps.deviceId,
    close(opts) {
      // R551 M1: a second call (while the first still waits for a change in its turn) is the first call.
      if (ctl.closing) return ctl.closing;
      // R551 M2: a change that closes its own library would wait for itself for ever: refused, and the library stays
      // open (the change's own turn then ends as it would have).
      if (ctl.drains.some((d) => d.holdsTurn())) return Promise.reject(new CloseInsideChangeError());
      // From here every further write through this handle is refused (`isClosed`, R546 1); a change already in its
      // store turn finishes and is recorded first, and only then is the lock released (R247 c, d).
      ctl.closed = true;
      ctl.closing = (async () => {
        await Promise.allSettled(ctl.drains.map((d) => d.drain()));
        try {
          await opts?.beforeRelease?.();
        } catch {
          // the caller's own step; the lock is released all the same
        }
        await release?.();
      })();
      return ctl.closing;
    },
  };
  controls.set(lib, ctl);
  return lib;
}

/**
 * Package-internal: the library folder is unreachable (drive unplugged, network gone). The handle
 * becomes read-only with reason `offline`, remembering its previous mode; a read-write handle stops
 * its heartbeat. No-op when already offline or closed.
 */
export async function markOffline(lib: Library): Promise<void> {
  const ctl = controls.get(lib);
  if (!ctl || ctl.closed || ctl.beforeOffline) return;
  ctl.beforeOffline = { mode: ctl.state.mode, reason: ctl.state.reason };
  ctl.state.mode = "read-only";
  ctl.state.reason = "offline";
  if (ctl.beforeOffline.mode === "read-write") await ctl.stopLock?.();
}

/**
 * Package-internal: the library folder is reachable again. A handle that was read-write re-acquires
 * the lock first (another device may have taken it meanwhile: then it stays read-only,
 * `locked-by-other-device`); any other handle gets its previous reason back. No-op unless offline.
 * With `acceptNotWritable: false`, a lock that cannot be written (LockNotWritableError) leaves the
 * handle offline and is thrown, so the caller can retry; otherwise the handle becomes `not-writable`.
 */
export async function markOnline(lib: Library, opts: { acceptNotWritable?: boolean } = {}): Promise<void> {
  const ctl = controls.get(lib);
  if (!ctl || !ctl.beforeOffline) return;
  const before = ctl.beforeOffline;
  ctl.beforeOffline = undefined;
  if (ctl.closed) return;
  if (before.mode === "read-write" && ctl.reacquire) {
    try {
      await ctl.reacquire(opts.acceptNotWritable ?? true);
    } catch (err) {
      ctl.beforeOffline = before; // still unreachable after all: stay offline, retry later
      throw err;
    }
    return;
  }
  ctl.state.mode = before.mode;
  ctl.state.reason = before.reason;
}

/**
 * What a repository opened on a handle gives its `close()` (FR-749, R546 1; R551 M2): `drain` is awaited before the lock
 * is released (its write queue: the change in its store turn finishes); `holdsTurn` is true while the caller runs inside
 * one of its changes (that change cannot close its own library: it would wait for itself).
 */
export interface CloseDrain {
  drain: () => Promise<void>;
  holdsTurn: () => boolean;
}

/** Package-internal (FR-749, R546 1): registers a repository's `CloseDrain` with its handle. Never throws. */
export function onClose(lib: Library, d: CloseDrain): void {
  controls.get(lib)?.drains.push(d);
}

/**
 * FR-749 (R546 2): the closing signal of the library session a piece of work runs for (an attach, a watched folder's
 * bringing-in). Once it is aborted — the service has begun to close the library — that work begins no further change
 * (its repository refuses it with LibraryClosedError, as a closed handle does), and the lookup client cuts its waits
 * short (a wait cut is never a request sent again). A change already in its store turn is not touched by it.
 * R551 M3: the scope is bound to ITS library: only that library's repository (and its lookup client) consult it.
 */
const closingScope = new AsyncLocalStorage<{ lib: Library; signal: AbortSignal }>();

/** Runs `fn` as work of `lib`'s session that `signal` closes (see `closingSignal`); without a signal, `fn` as it is. */
export function whileOpen<T>(lib: Library, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? closingScope.run({ lib, signal }, fn) : fn();
}

/** The closing signal of `lib`'s session the current work runs for (`whileOpen`), if any; another library's: none. */
export function closingSignal(lib: Library): AbortSignal | undefined {
  const s = closingScope.getStore();
  return s && s.lib === lib ? s.signal : undefined;
}

/** As `closingSignal`, for the library at `root` (the lookup client knows its library by its folder). */
export function closingSignalAt(root: string): AbortSignal | undefined {
  const s = closingScope.getStore();
  return s && s.lib.root === root ? s.signal : undefined;
}

/**
 * R551 M3: runs `fn` outside any session's closing scope. Background work a piece of work merely STARTS (a viewing
 * proxy an attach queued) is not that work: it is not refused because the attach's session began to close later; it
 * meets the closed library as any other work does.
 */
export function outsideClosingScope<T>(fn: () => T): T {
  return closingScope.exit(fn);
}

/** Package-internal: true once `close()` was called on the handle. */
export function isClosed(lib: Library): boolean {
  return controls.get(lib)?.closed ?? false;
}

/** Records the library in the app-level registry (outside the library folder). */
async function note(root: string, meta: LibraryJson, deps: Deps): Promise<void> {
  try {
    await registerLibrary({ libraryId: meta.libraryId, name: meta.name, path: root }, deps);
  } catch {
    // the registry is a convenience; never fail an open because of it
  }
}
