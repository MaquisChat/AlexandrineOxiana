/**
 * Watched folders (spec 5.4; Task 26, R78c, R81; cloud-drive folders, Task W2, R207, R208): files that
 * appear in a folder the researcher chose are added to a project, one at a time, under the drag-and-drop
 * attach rules (attach.ts: sniffed type, capture/store governance, R55–R58 identification, R56 location
 * refusal, review queue below the confidence threshold, provenance `manual_upload`). Every store goes
 * through the project's queue (project-queue.ts), shared with drag-and-drop and Bulk Import (R81 I4).
 *
 * THE RULE ABOVE ALL (W2): no byte of a file in the folder is read before "is this file's content on this
 * computer?" (watch-local.ts `contentState`) answered "local" for it. In a Google Drive, OneDrive or Dropbox
 * folder, reading an online-only file makes the service download it. For every file, on every path that
 * leads to a read (an event, the first scan, the rescan, the re-check of files not downloaded, the folder's
 * return, an unlock, a resume after a call that did not answer), the order is:
 *   1. the name rule (`nameRule`: skipped in silence, or skipped and listed — Google's pointer files);
 *   2. stable: two `lstat`s (bigint) at least `stabilityMs` apart with equal inode, size, blocks and time
 *      (ns); a file still changing waits for the next round;
 *   3. `contentState` says "local" (anything else is counted and listed, never read: not hashed, not sniffed,
 *      not copied, not used as a sidecar, not given to metadata extraction);
 *   4. immediately before the first byte is read, `contentState` is asked again for that one file and the
 *      state it judged must equal the stability reading exactly; then the hash, then attach, which asks
 *      `readable` (the same check) again before its type sniff and for each sidecar beside the file.
 *
 * Calls that never answer (R208 d): a time limit around a promise does not free the thread a stuck call
 * holds. So every file-system call this module makes for a folder goes through that folder's one gate
 * (`FolderGate`): at most ONE call in flight per watched folder (the `lstat`s `contentState` makes included —
 * it is given the gate's `lstat`; on macOS its `/usr/bin/stat` process runs only after its `lstat`s have
 * answered, while this folder's one worker waits for it, so it is never beside another call of this folder).
 * A call unanswered after `fsTimeoutMs` marks the folder "unreachable" (notResponding), closes the watcher,
 * and NO further call is made on that folder until the stuck one settles; then the folder is checked again
 * and scanned.
 *
 * Other behaviour kept from Task 26:
 *   - a file whose content changes after it came in is imported again (its new content is a new source;
 *     unchanged content is recognised by its SHA-256 and skipped) — R81's rule, replaced in W3;
 *   - when the watch starts, when the folder returns and when a locked encrypted project is unlocked, the
 *     folder is scanned; files already in the project (by SHA-256) are skipped silently;
 *   - links: the watched folder is the file's only allowed root (R67). A link to a file elsewhere is
 *     refused (WATCH_REASONS.outside); links to folders are never followed (WATCH_REASONS.folderLink); a
 *     link to a file inside the folder brings in that file (under its own name);
 *   - a folder inside the library, or one that holds the library, is refused (by real path);
 *   - an encrypted project that is locked pauses the watch until it is unlocked;
 *   - every problem is an event (`failed` / `error`) and an entry in the problem list, with a plain reason
 *     and the file's name relative to the folder — never an absolute path — and the watch goes on;
 *   - the watch ends by itself when the library is closed or this computer loses its lock.
 *
 * Settings (R69): which folder is watched is an absolute path on this computer, so it is a device
 * setting (`<appConfigDir>/watched-folders.json`, by library id, project id and watch id, 0600 in a
 * 0700 folder), never stored in the library. project.json keeps only each watch's id and options (a
 * governed, audited change); another computer chooses its own folder with setWatchFolder. An
 * unreadable settings file is moved aside (`watched-folders.unreadable-<time>.json`) with a warning,
 * never silently emptied.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, watch as nodeWatch, type BigIntStats, type FSWatcher } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WatchedFolderOptions, type WatchedFolder, type WatchedFolderOptions as WatchedFolderOptionsT } from "@ao/core";
import { raiseDeviceNotice } from "../device-notices.js";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { isClosed, type Library } from "../library.js";
import type { LocationEnv } from "../location.js";
import type { HttpClient } from "../lookup/index.js";
import { addWatchedFolderEntry, projectEncrypted, removeWatchedFolderEntry, type Repo } from "../repo/repo.js";
import { ATTACH_REASONS, NOT_DOWNLOADED_REASON, createAttach, type Attach, type AttachOutcome, type AttachStatus } from "./attach.js";
import { proxyQueueFor, type ProxyQueue } from "./proxies.js";
import { SIDECAR_EXTS } from "./sidecar.js";
import { PROVIDER_NAMES, WATCH_LOCAL_BATCH, cloudProviderOf, contentState, nameRule, type CloudProvider, type ContentState } from "./watch-local.js";

/** Names never imported (moved to watch-local.ts so the two modules do not import each other; A2). */
export { ignoredName } from "./watch-local.js";

/** How long a file must stay unchanged (inode, size, blocks, time) before it is read (R78). */
export const WATCH_STABILITY_MS = 2000;
/** How often the whole folder is listed again (`lstat` only) to catch files whose events were missed. */
export const WATCH_RESCAN_MS = 300_000;
/** At most one status per folder per this many ms (a change of state is pushed at once). */
export const WATCH_STATUS_INTERVAL_MS = 1000;
/** File problems kept per watch, newest first. */
export const WATCH_PROBLEMS_MAX = 5000;
/** A file-system call on the folder unanswered for this long marks it "Cannot be reached". */
export const WATCH_FS_TIMEOUT_MS = 30_000;
/** How often the files that were not downloaded are asked again (A6: not every poll — a standing cost on a laptop). */
export const WATCH_RECHECK_MS = 60_000;
/** How often the folder, the project's lock and the library are checked (R81: at most 10 s). */
const POLL_MS = 2000;
const MAX_DEPTH = 20;
/** Files not downloaded that each poll checks again (round robin). */
const RECHECK_PER_ROUND = 2000;
/** How often a file waits for an undecided sidecar beside it before it comes in without it. */
const SIDECAR_WAITS = 3;
/** Files in a watched folder are opened read-only and never through a symbolic link swapped in meanwhile. */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
/** Files per step (one `contentState` call; on macOS one `/usr/bin/stat` process). */
const BATCH = WATCH_LOCAL_BATCH;
/** Files read once and waiting for their second reading; more wait as names only. */
const SETTLING_MAX = 10_000;
/** Bytes read per call while hashing (each read is one call through the folder's gate). */
const HASH_CHUNK = 1024 * 1024;

export const WATCH_REASONS = {
  outside: "The file is outside the watched folder (it is a link to somewhere else), so it was not imported.",
  folderLink: "This is a link to a folder; links to folders are not followed in a watched folder.",
  failed: "The file could not be imported.",
  watchFailed: "The folder could not be watched (it may have been renamed or disconnected).",
  library: "A watched folder cannot be inside the library or contain it. Choose another folder.",
  locked: "The project is locked; new files are imported when it is unlocked.",
  libraryClosed: "The library was closed or another computer took it over, so the folder is no longer watched.",
  settingsUnreadable: "The list of watched folders on this computer was damaged; it was set aside and a new one started.",
  /** A file whose content is not on this computer. */
  notDownloaded: NOT_DOWNLOADED_REASON,
  /** A file whose state could not be told (W1's "unknown"): counted with the files not downloaded. */
  unknownPresence: "The app could not tell whether this file is on this Mac, so it has left it alone.",
  /** A file the system did not let the app look at. */
  fileNotPermitted: "The app was not allowed to read this file.",
  /** The folder: `{provider}` is filled by `withProvider`. */
  notPermitted: "macOS did not allow the app to read files managed by {provider}, so this folder is not watched. Press “Try again” and choose Allow if macOS asks.",
  notResponding: "The folder did not answer for 30 seconds ({provider} may be starting, signed out or offline). Watching goes on when it answers.",
  missing: "The folder cannot be found. If {provider} is signed out or still starting, watching resumes when the folder is back.",
} as const;

/** A reason with `{provider}` filled: the cloud service's name, or "the system" for a plain folder. */
export function withProvider(reason: string, provider: CloudProvider | null): string {
  return reason.replaceAll("{provider}", provider ? PROVIDER_NAMES[provider] : "the system");
}

export interface WatchEvent {
  kind: "imported" | "failed" | "error" | "stopped" | "paused" | "resumed";
  /** The file, relative to the watched folder ("/"-separated). Never absolute. */
  file?: string;
  outcome?: AttachStatus;
  sourceId?: string;
  reason?: string;
}

/** How one folder is, pushed through `onStatus` (coalesced) and read with `status()`. */
export interface WatchStatus {
  watchId?: string;
  state: "watching" | "paused" | "unreachable" | "locked" | "stopped";
  reason?: string;
  provider: CloudProvider | null;
  /** The folder is being listed, or files found by a listing are still to be looked at. */
  scanning: boolean;
  counts: {
    /** Files that became sources (or files of a source) here. */
    cameIn: number;
    /** Files whose content was already in the project. */
    alreadyInLibrary: number;
    /** Files not downloaded to this computer, and files whose state could not be told. */
    notDownloaded: number;
    /** Their total size (from `lstat`). */
    notDownloadedBytes: number;
    /** Files seen and not yet decided (still changing, or waiting for their turn). */
    waiting: number;
    /** Files that did not come in for another reason (listed in `problems()`). */
    didNotComeIn: number;
  };
}

export type WatchFileKind = "not-downloaded" | "online-only-document" | "not-supported" | "could-not-import" | "not-permitted" | "could-not-download";

export interface WatchFileProblem {
  /** Relative to the watched folder, "/"-separated, as on disk. Never absolute. */
  file: string;
  kind: WatchFileKind;
  reason: string;
  bytes?: number;
}

/** The file-system calls the engine makes on a folder (each one through the folder's gate). Test seam. */
export interface WatchFs {
  lstat(path: string): Promise<BigIntStats>;
  readdir(path: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
  /** Opens with `flags` (the engine passes read-only and, where the platform has it, O_NOFOLLOW). */
  open(path: string, flags: number): Promise<FileHandle>;
}

const realFs: WatchFs = {
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  stat: (p) => fsp.stat(p),
  realpath: (p) => fsp.realpath(p),
  open: (p, flags) => fsp.open(p, flags),
};

export interface WatchDeps {
  /** Viewing proxies (R83); default: the library's queue (proxyQueueFor). */
  proxies?: ProxyQueue;
  repo: Repo;
  http: HttpClient;
  lib: Library;
  /**
   * The attach used for each file (default: createAttach({ repo, http, readable })). A caller's own attach
   * is not given the engine's `readable` check: it must not read what the engine has not checked.
   */
  attach?: Attach;
  onEvent?: (e: WatchEvent) => void;
  /** The folder's status: at most once per WATCH_STATUS_INTERVAL_MS, and at once when `state` changes. */
  onStatus?: (s: WatchStatus) => void;
  debug?: (note: string) => void;
  /** "Is this file's content on this computer?" (default: watch-local's contentState; A3 makes it the judged state). */
  presence?: typeof contentState;
  /** How often the folder is listed again (default WATCH_RESCAN_MS). */
  rescanMs?: number;
  /** How often the files that were not downloaded are asked again (default WATCH_RECHECK_MS). */
  recheckMs?: number;
  /** How long one file-system call on the folder may go unanswered (default WATCH_FS_TIMEOUT_MS). */
  fsTimeoutMs?: number;
  /** Test seams: the stability period (default WATCH_STABILITY_MS) and how often the folder and library are checked. */
  stabilityMs?: number;
  pollMs?: number;
  /** Test seam: the file-system calls (each replaced one still goes through the folder's gate). */
  fs?: Partial<WatchFs>;
  /** Test seam: where the cloud services' folders are (default: this computer's home folder and platform). */
  locationEnv?: LocationEnv;
  /** Test seam (honoured only when NODE_ENV=test, R47): false starts no file-system watcher, so only scans find files. */
  watchEvents?: boolean;
  /**
   * How the folder is watched (default: "tree" on macOS and Windows, "per-folder" elsewhere). "tree": ONE watcher for
   * the whole tree (the system's own recursion, so setting it up is one call). "per-folder": one watcher per folder
   * (Linux, whose system watches one folder at a time). Injected so that both forms are tested on every platform.
   */
  watcherForm?: "tree" | "per-folder";
  /** Test seam: Node's `fs.watch`. */
  fsWatch?: typeof nodeWatch;
}

export interface FolderWatch {
  /** Settles when the folder is being watched and its first scan is queued (or the watch could not start: see the events and status). */
  readonly ready: Promise<void>;
  /** True once the watch has ended for good (stop(), library closed, folder refused). */
  readonly stopped: boolean;
  /** Stops watching; a file being imported finishes first. Safe to call more than once. */
  stop(): Promise<void>;
  /** How the folder is now. */
  status(): WatchStatus;
  /** Files that did not come in, newest first (at most WATCH_PROBLEMS_MAX are kept). */
  problems(o: { kind?: WatchFileKind; offset: number; limit: number }): { total: number; items: WatchFileProblem[] };
}

const within = (folder: string, p: string) => {
  const rel = relative(folder, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Whether `dir` (a real path) is the library, inside it, or holds it. */
async function overlapsLibrary(dir: string, lib: Pick<Library, "root">): Promise<boolean> {
  const root = await fsp.realpath(lib.root).catch(() => resolve(lib.root));
  return dir === root || within(root, dir) || within(dir, root);
}

/** A call on the folder did not answer in time (or the folder is waiting for one that did not). */
export class FolderNotAnsweringError extends Error {
  constructor() {
    super("The folder did not answer.");
    this.name = "FolderNotAnsweringError";
  }
}

/**
 * One watched folder's file-system calls: one at a time (the next waits for the previous to SETTLE, not
 * merely to time out), each with a time limit. A call unanswered after `timeoutMs` makes the gate "stuck":
 * that call's caller and every waiting caller get FolderNotAnsweringError, the abort signal given to
 * `contentState` fires, and every new call is refused at once — without being issued — until the stuck call
 * settles. So this folder never holds more than one of Node's file-system threads through this module.
 */
class FolderGate {
  private busy = false;
  private queue: Array<{ go: () => void; fail: () => void }> = [];
  private freeWaiters: Array<() => void> = [];
  private settleWaiters: Array<() => void> = [];
  private ctl = new AbortController();
  stuck = false;
  /** Grows each time a call does not answer: answers obtained across a change are not trusted. */
  epoch = 0;
  constructor(
    private readonly timeoutMs: number,
    private readonly onStuck: () => void,
  ) {}
  get signal(): AbortSignal {
    return this.ctl.signal;
  }
  call<T>(op: () => Promise<T>): Promise<T> {
    if (this.stuck) return Promise.reject(new FolderNotAnsweringError());
    return new Promise<T>((resolveCall, rejectCall) => {
      const go = () => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          this.stuck = true;
          this.epoch++;
          this.ctl.abort();
          for (const q of this.queue.splice(0)) q.fail();
          rejectCall(new FolderNotAnsweringError());
          this.onStuck();
        }, this.timeoutMs);
        timer.unref?.();
        let p: Promise<T>;
        try {
          p = op();
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(
          (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolveCall(v);
          },
          (err: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            rejectCall(err);
          },
        ).finally(() => this.settled());
      };
      if (this.busy) this.queue.push({ go, fail: () => rejectCall(new FolderNotAnsweringError()) });
      else {
        this.busy = true;
        go();
      }
    });
  }
  /** The call in flight settled (answered, failed, or answered at last after being given up on). */
  private settled(): void {
    if (this.stuck) {
      this.stuck = false;
      this.ctl = new AbortController();
      this.busy = false;
      for (const f of this.settleWaiters.splice(0)) f();
      for (const f of this.freeWaiters.splice(0)) f();
      return;
    }
    const next = this.queue.shift();
    if (next) next.go();
    else this.busy = false;
  }
  /** Resolves when no call is stuck (at once if none is), or when the watch stops. */
  whenFree(): Promise<void> {
    return this.stuck ? new Promise((r) => this.freeWaiters.push(r)) : Promise.resolve();
  }
  /** Resolves only when the stuck call has settled (never merely because the watch stopped): for clean-up calls. */
  afterSettle(): Promise<void> {
    return this.stuck ? new Promise((r) => this.settleWaiters.push(r)) : Promise.resolve();
  }
  /** A call made on this folder by an earlier watch is still outstanding: this gate is stuck until it settles (A6). */
  adopt(outstanding: Promise<unknown>): void {
    if (this.stuck || this.busy) return;
    this.stuck = true;
    this.busy = true;
    this.epoch++;
    this.ctl.abort();
    const done = () => this.settled();
    void outstanding.then(done, done);
  }
  /** The watch stops: nobody waits for the stuck call any longer (it is still not followed by another). */
  release(): void {
    for (const f of this.freeWaiters.splice(0)) f();
  }
}

/** What the engine compares: the exact state of a file from `lstat` with `bigint: true`. */
interface Reading {
  ino: bigint;
  size: number;
  blocks: number;
  mtimeNs: bigint;
}
const readingOf = (s: BigIntStats): Reading => ({ ino: s.ino, size: Number(s.size), blocks: Number(s.blocks), mtimeNs: s.mtimeNs });
const sameReading = (a: Reading, b: Reading) => a.ino === b.ino && a.size === b.size && a.blocks === b.blocks && a.mtimeNs === b.mtimeNs;

/**
 * What the engine keeps per file it has decided on (memory at 40,000 files: these five numbers and a short
 * word per file, keyed by the relative name — measured in watch.scale.test.ts). Inode and time are kept as
 * numbers (the time in microseconds) for "is it unchanged?"; the exact bigint readings are kept only for
 * files in flight.
 */
type Kind = "in" | "known" | "nd" | "unknown" | "problem";
interface Rec {
  ino: number;
  size: number;
  blocks: number;
  mtimeUs: number;
  kind: Kind;
}
const sameRec = (rec: Rec, r: Reading) => rec.ino === Number(r.ino) && rec.size === r.size && rec.blocks === r.blocks && rec.mtimeUs === Number(r.mtimeNs / 1000n);

/** Flags of a file waiting to be looked at. QUIET: from a scan or a change (content already in the project is skipped silently). FORCE: look even if unchanged (a re-check found it local). */
const QUIET = 1;
const FORCE = 2;
const mergeFlags = (a: number, b: number) => (a & b & QUIET) | ((a | b) & FORCE);

function defaultLocationEnv(): LocationEnv {
  const vars: NonNullable<LocationEnv["vars"]> = {};
  for (const k of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const) {
    const v = process.env[k];
    if (v) vars[k] = v;
  }
  return { homeDir: homedir(), platform: process.platform, mounts: [], mountsKnown: false, vars };
}

const errCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;
const isRefusal = (err: unknown) => errCode(err) === "EACCES" || errCode(err) === "EPERM";

/**
 * Folders with a call outstanding that did not answer, by the folder as given and by its real path, for the life of
 * the process (A6): a new watch on such a folder (a restart, W7's "Try again") starts "Cannot be reached" and makes
 * no call until that one settles — the thread it holds is not joined by another.
 */
const outstandingFolders = new Map<string, Promise<void>>();

/** A reading of nothing (a file the system would not let the app look at). */
const NO_READING: Reading = { ino: 0n, size: 0, blocks: 0, mtimeNs: 0n };

/**
 * Watches `dir` (absolute) and adds each new file to the project. Errors are reported through
 * `onEvent` and the status, never thrown.
 */
export function watchFolder(deps: WatchDeps, projectId: string, dir: string, options: Partial<WatchedFolderOptionsT> = {}, watchId?: string): FolderWatch {
  const opts = WatchedFolderOptions.parse(options);
  const root = resolve(dir);
  const emit = (e: WatchEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // a listener's error never stops the watch
    }
  };
  const fsx: WatchFs = { ...realFs, ...deps.fs };
  const presence = deps.presence ?? contentState;
  const stability = deps.stabilityMs ?? WATCH_STABILITY_MS;
  const pollMs = Math.min(deps.pollMs ?? POLL_MS, 10_000);
  const rescanMs = deps.rescanMs ?? WATCH_RESCAN_MS;
  const recheckMs = deps.recheckMs ?? WATCH_RECHECK_MS;
  const form = deps.watcherForm ?? (process.platform === "darwin" || process.platform === "win32" ? "tree" : "per-folder");
  const fsWatch = deps.fsWatch ?? nodeWatch;
  const env = deps.locationEnv ?? defaultLocationEnv();
  const eventsOn = deps.watchEvents !== false || process.env.NODE_ENV !== "test";
  // EVERY folder is checked, whatever the provider (A3): `provider` only names the service in the sentences.
  let realRoot = root;
  let provider: CloudProvider | null = cloudProviderOf(root, env);

  let stopped = false;
  let stopReason: string | undefined;
  /** Why the folder cannot be used now (missing, not permitted, not responding), or null. */
  let unreachable: string | null = null;
  /** Paused because the project is locked: a full scan follows the unlock. */
  let locked = false;
  /** SHA-256 of every file already in the project (read when first needed, kept up to date). */
  let known: Set<string> | null = null;

  const records = new Map<string, Rec>();
  const tally: Record<Kind, number> = { in: 0, known: 0, nd: 0, unknown: 0, problem: 0 };
  let ndBytes = 0;
  /** The files not downloaded (or unknown), in the order they are next re-checked (round robin). */
  const ndOrder = new Set<string>();
  const problemList = new Map<string, WatchFileProblem>();

  /** Files to look at (relative names), with their flags. */
  const pending = new Map<string, number>();
  /** Files read once, waiting for the second reading `stability` ms later (oldest first). */
  const settling = new Map<string, { a: Reading; at: number; flags: number; waits?: number }>();
  /** Stable, local files waiting for their turn to be read. */
  const imports: Array<{ rel: string; b: Reading; flags: number; waits?: number }> = [];
  /**
   * Sidecar files (`.bib`, `.ris`, `.json`, `.opf`) that passed the whole order by themselves — name rule, stable,
   * "local", judged state equal to the stability reading — with that state: attach may read one only while a fresh
   * `lstat` still equals it (A6, C1). Small: sidecar names only.
   */
  const sidecarOk = new Map<string, Reading>();
  /** Which file came in with which content (came-in files only): a renamed one is not imported again (M3). */
  const cameInBySha = new Map<string, string>();
  /** The listing in progress: folders still to read, and what was found (to drop files that went away). */
  let walk: { dirs: Array<{ dir: string; depth: number; entries?: Entry[] }>; found: Set<string>; complete: boolean } | null = null;
  let pollDue = false;
  let nextRescan = Date.now() + rescanMs;
  let nextRecheck = Date.now() + recheckMs;
  /** The file being imported and its stability reading (for attach's `readable`). */
  let current: { abs: string; b: Reading } | null = null;

  const relName = (p: string) => relative(realRoot, p).split(sep).join("/");
  const absOf = (rel: string) => join(realRoot, ...rel.split("/"));
  const libraryGone = () => isClosed(deps.lib) || deps.lib.mode !== "read-write";
  const projectLocked = () => projectEncrypted(deps.repo, projectId) && !deps.repo.isUnlocked(projectId);

  // ---- the folder's one gate, and the calls made through it ----------------------------------------------
  const gate = new FolderGate(deps.fsTimeoutMs ?? WATCH_FS_TIMEOUT_MS, () => {
    const settledAt = gate.afterSettle();
    const keys = [...new Set([root, realRoot])];
    for (const k of keys) outstandingFolders.set(k, settledAt);
    void settledAt.then(() => {
      for (const k of keys) if (outstandingFolders.get(k) === settledAt) outstandingFolders.delete(k);
    });
    goUnreachable(withProvider(WATCH_REASONS.notResponding, provider));
    wake();
  });
  const g = {
    lstat: (p: string) => gate.call(() => fsx.lstat(p)),
    readdir: (p: string) => gate.call(() => fsx.readdir(p)),
    stat: (p: string) => gate.call(() => fsx.stat(p)),
    realpath: (p: string) => gate.call(() => fsx.realpath(p)),
  };
  /** `contentState`'s own `lstat`, through the gate (W1 runs two at a time; the gate makes them one). */
  const presenceLstat = async (p: string) => {
    const s = await g.lstat(p);
    return { size: Number(s.size), blocks: Number(s.blocks), ino: s.ino, mtimeNs: s.mtimeNs, isFile: () => s.isFile() };
  };
  /** "Is this content on this computer?" for `abs` paths; answers given across a call that did not answer are thrown away. */
  async function judge(abs: string[]): Promise<Map<string, ContentState>> {
    const epoch = gate.epoch;
    const m = await presence(abs, { lstat: presenceLstat, signal: gate.signal });
    if (gate.epoch !== epoch || gate.stuck) throw new FolderNotAnsweringError();
    return m;
  }

  // ---- the per-file record, the counts and the problem list -------------------------------------------------
  function untally(old: Rec) {
    tally[old.kind]--;
    if (old.kind === "nd" || old.kind === "unknown") ndBytes -= old.size;
  }
  function setRec(rel: string, r: Reading, kind: Kind) {
    const old = records.get(rel);
    if (old) untally(old);
    records.set(rel, { ino: Number(r.ino), size: r.size, blocks: r.blocks, mtimeUs: Number(r.mtimeNs / 1000n), kind });
    tally[kind]++;
    if (kind === "nd" || kind === "unknown") {
      ndBytes += r.size;
      if (!ndOrder.has(rel)) ndOrder.add(rel);
    } else ndOrder.delete(rel);
    touch();
  }
  function removeRec(rel: string) {
    const old = records.get(rel);
    if (old) {
      untally(old);
      records.delete(rel);
      ndOrder.delete(rel);
    }
    settling.delete(rel);
    sidecarOk.delete(rel);
    dropProblem(rel);
    touch();
  }
  function setProblem(rel: string, p: WatchFileProblem) {
    problemList.delete(rel);
    problemList.set(rel, p);
    while (problemList.size > WATCH_PROBLEMS_MAX) problemList.delete(problemList.keys().next().value!);
    touch();
  }
  function dropProblem(rel: string) {
    if (problemList.delete(rel)) touch();
  }
  /** A file that did not come in: recorded, listed and told (once per state of the file). */
  function report(rel: string, r: Reading, kind: WatchFileKind, reason: string) {
    const old = records.get(rel);
    if (old && old.kind === "problem" && sameRec(old, r) && problemList.get(rel)?.reason === reason) return;
    setRec(rel, r, "problem");
    setProblem(rel, { file: rel, kind, reason });
    emit({ kind: "failed", file: rel, reason });
  }
  /** A file whose content is not on this computer (or cannot be told): counted and listed, never read. */
  function notLocal(rel: string, b: Reading, p: "not-downloaded" | "unknown" | "local") {
    const kind: Kind = p === "not-downloaded" ? "nd" : "unknown";
    const old = records.get(rel);
    const changed = !old || old.kind !== kind || !sameRec(old, b);
    setRec(rel, b, kind);
    if (changed) setProblem(rel, { file: rel, kind: "not-downloaded", reason: kind === "nd" ? WATCH_REASONS.notDownloaded : WATCH_REASONS.unknownPresence, bytes: b.size });
  }

  // ---- status ------------------------------------------------------------------------------------------------
  const stateNow = (): WatchStatus["state"] => (stopped ? "stopped" : unreachable ? "unreachable" : locked ? "locked" : "watching");
  function status(): WatchStatus {
    const state = stateNow();
    const reason = state === "stopped" ? stopReason : state === "unreachable" ? unreachable! : state === "locked" ? WATCH_REASONS.locked : undefined;
    return {
      ...(watchId ? { watchId } : {}),
      state,
      ...(reason ? { reason } : {}),
      provider,
      scanning: walk !== null || pending.size > 0,
      counts: {
        cameIn: tally.in,
        alreadyInLibrary: tally.known,
        notDownloaded: tally.nd + tally.unknown,
        notDownloadedBytes: ndBytes,
        waiting: pending.size + settling.size + imports.length,
        didNotComeIn: tally.problem,
      },
    };
  }
  let lastPushAt = 0;
  let lastPushedState: string | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  function send() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = undefined;
    const s = status();
    lastPushAt = Date.now();
    lastPushedState = s.state;
    try {
      deps.onStatus?.(s);
    } catch {
      // a listener's error never stops the watch
    }
  }
  /** Something changed: a new state is pushed at once, anything else at most once per interval. */
  function touch() {
    if (!deps.onStatus) return;
    if (stateNow() !== lastPushedState) return send();
    if (pushTimer || stopped) return;
    pushTimer = setTimeout(send, Math.max(0, lastPushAt + WATCH_STATUS_INTERVAL_MS - Date.now()));
    pushTimer.unref?.();
  }

  // ---- the folder ---------------------------------------------------------------------------------------------
  const folderReason = (err: unknown) =>
    withProvider(errCode(err) === "EACCES" || errCode(err) === "EPERM" ? WATCH_REASONS.notPermitted : WATCH_REASONS.missing, provider);

  /** The folder's checks (at start and on every return): real path, a folder, apart from the library. */
  async function checkRoot(): Promise<{ stop?: string; reason?: string } | null> {
    try {
      realRoot = await g.realpath(root);
      provider = cloudProviderOf(realRoot, env);
      if (!(await g.stat(realRoot)).isDirectory()) return { reason: withProvider(WATCH_REASONS.missing, provider) };
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      return { reason: folderReason(err) };
    }
    return (await overlapsLibrary(realRoot, deps.lib)) ? { stop: WATCH_REASONS.library } : null;
  }
  /** Null when the folder is there (one `stat`), else why not. */
  async function rootProblem(): Promise<string | null> {
    try {
      return (await g.stat(root)).isDirectory() ? null : withProvider(WATCH_REASONS.missing, provider);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      return folderReason(err);
    }
  }
  function goUnreachable(reason: string) {
    if (stopped || unreachable === reason) return;
    const was = unreachable;
    unreachable = reason;
    walk = null;
    void closeWatcher();
    if (!was) emit({ kind: "stopped", reason });
    touch();
  }
  /** The folder may be usable again: checked, listed, watched and scanned. */
  async function tryResume(): Promise<void> {
    const bad = await checkRoot();
    if (bad?.stop) {
      void stopWith(bad.stop, true);
      return;
    }
    if (bad) {
      goUnreachable(bad.reason!);
      return;
    }
    let entries: Entry[];
    try {
      entries = await g.readdir(realRoot);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      goUnreachable(folderReason(err));
      return;
    }
    unreachable = null;
    emit({ kind: "resumed" });
    touch();
    await startWatcher();
    startWalk(entries);
  }

  // ---- the watcher ------------------------------------------------------------------------------------------
  // Events come from Node's own `fs.watch` on FOLDERS, never one per file (A6, R213). In the "tree" form (macOS,
  // Windows) ONE watcher covers the whole tree through the system's own recursion, so setting it up is one call;
  // in the "per-folder" form (Linux) each watched folder has its own, closed when its folder goes, and a folder
  // made again under the same name is watched and listed at once. `fs.watch` does not poll, makes no
  // `stat`/`lstat`/`readdir` of its own and opens no file: an event only names a file to look at (the steps below
  // decide everything, through the gate). A watcher is set up only immediately after the folder answered an
  // asynchronous call within its time limit, never while a call on it is stuck. What remains outside the gate:
  // setting a watcher up is a synchronous system call on the main thread (inotify on Linux; on macOS libuv opens
  // the folder, reads its real path and starts an FSEvents stream). On the owner's Mac list. (chokidar 5.0.0 is
  // not used: it keeps one watch, on macOS one open descriptor, per FILE — 80 MB at 40,000 files — and `lstat`s
  // every entry at start, all outside any gate.)
  const dirWatchers = new Map<string, FSWatcher>();
  /** The inode of each folder inside the watched one that has been listed (per-folder form: watched too). */
  const dirInos = new Map<string, bigint>();
  async function closeWatcher(): Promise<void> {
    for (const w of dirWatchers.values()) w.close();
    dirWatchers.clear();
    dirInos.clear();
  }
  /** Forgets the folder `abs` and every folder below it (their watchers closed). */
  function closeDirsUnder(abs: string) {
    const under = (k: string) => k === abs || k.startsWith(abs + sep);
    for (const [k, w] of dirWatchers) {
      if (!under(k)) continue;
      w.close();
      dirWatchers.delete(k);
    }
    for (const k of [...dirInos.keys()]) if (under(k)) dirInos.delete(k);
  }
  function watchDir(d: string): void {
    if (!eventsOn || stopped || unreachable || gate.stuck || dirWatchers.has(d)) return;
    if (form === "tree" && d !== realRoot) return; // the tree's one watcher already covers it
    let w: FSWatcher;
    try {
      w = fsWatch(d, form === "tree" ? { recursive: opts.recursive, persistent: true } : { persistent: true });
    } catch {
      if (d === realRoot) emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
      return; // the next scan finds what this folder holds
    }
    dirWatchers.set(d, w);
    w.on("change", (eventType: string, name: string | Buffer | null) => {
      if (stopped || unreachable) return;
      if (name === null || name === undefined) {
        if (!walk) startWalk(); // the system lost track of names: the folder is listed again
      } else {
        // The tree form names a path relative to the watched folder ("Sub/Deeper/x.pdf"), as FSEvents gives it.
        const abs = resolve(d, String(name));
        if (!within(realRoot, abs)) return;
        const rel = relName(abs);
        const parts = rel.split("/");
        if (parts.length > MAX_DEPTH + 1 || parts.some((s) => nameRule(s)?.skip === "silent")) return;
        const kind = records.get(rel)?.kind;
        // A new or renamed name is told (an "add"); a change of content is quiet (already-known content is skipped
        // silently); a file that was not downloaded is asked again at once (A6).
        addPending(rel, (eventType === "change" ? QUIET : 0) | (kind === "nd" || kind === "unknown" ? FORCE : 0));
      }
      wake();
    });
    w.on("error", () => {
      w.close();
      dirWatchers.delete(d);
      if (d === realRoot && !unreachable && !stopped) emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
    });
  }
  /** Called right after the folder's listing answered. */
  async function startWatcher(): Promise<void> {
    watchDir(realRoot);
  }

  // ---- the worker: everything this folder does, one step at a time --------------------------------------------
  function addPending(rel: string, flags: number) {
    const old = pending.get(rel);
    pending.set(rel, old === undefined ? flags : mergeFlags(old, flags));
    touch();
  }
  function startWalk(entries?: Entry[]) {
    walk = { dirs: [{ dir: realRoot, depth: 0, ...(entries ? { entries } : {}) }], found: new Set(), complete: true };
    touch();
  }
  /** Lists one folder of the walk; its files wait in `pending`. */
  async function walkStep(): Promise<void> {
    const w = walk!;
    const { dir: d, depth, entries: given } = w.dirs.pop()!;
    let entries = given;
    if (!entries) {
      try {
        if (d !== realRoot) {
          const ino = (await g.lstat(d)).ino;
          if (dirInos.has(d) && dirInos.get(d) !== ino) closeDirsUnder(d); // a different folder under the same name
          dirInos.set(d, ino);
        }
        entries = await g.readdir(d);
      } catch (err) {
        w.complete = false;
        if (err instanceof FolderNotAnsweringError) throw err;
        if (d === realRoot) goUnreachable(folderReason(err));
        else if (isRefusal(err)) {
          const rel = relName(d);
          w.found.add(rel);
          report(rel, NO_READING, "not-permitted", WATCH_REASONS.fileNotPermitted);
        }
        return;
      }
      watchDir(d); // the folder has just answered
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (nameRule(e.name)?.skip === "silent") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (opts.recursive && depth < MAX_DEPTH) w.dirs.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile() || e.isSymbolicLink()) {
        const rel = relName(p);
        w.found.add(rel);
        addPending(rel, QUIET);
      }
    }
  }
  /** The walk is over: a file it did not find (and nobody is looking at) has gone away. */
  function finishWalk() {
    const w = walk!;
    walk = null;
    if (w.complete) for (const rel of [...records.keys()]) if (!w.found.has(rel) && !pending.has(rel) && !settling.has(rel) && !imports.some((j) => j.rel === rel)) removeRec(rel);
    touch();
  }

  /** The first reading of up to BATCH waiting files: the name rule, then one `lstat` each. */
  async function readStep(): Promise<void> {
    let gone: Promise<string | null> | undefined;
    const folderGone = () => (gone ??= rootProblem());
    let n = 0;
    for (const [rel, flags] of pending) {
      if (n++ >= BATCH || settling.size >= SETTLING_MAX || stopped || unreachable || locked) return;
      pending.delete(rel);
      try {
        await readOne(rel, flags, folderGone);
      } catch (err) {
        if (err instanceof FolderNotAnsweringError) pending.set(rel, flags);
        throw err;
      }
    }
  }
  async function readOne(rel: string, flags: number, folderGone: () => Promise<string | null>): Promise<void> {
    if (rel.split("/").some((s) => nameRule(s)?.skip === "silent")) {
      removeRec(rel);
      return;
    }
    const abs = absOf(rel);
    let st: BigIntStats;
    try {
      st = await g.lstat(abs);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      if (isRefusal(err)) return report(rel, NO_READING, "not-permitted", WATCH_REASONS.fileNotPermitted);
      // Gone — unless the whole folder is gone (then nothing is decided until it is back).
      if (!(await folderGone())) {
        removeRec(rel);
        closeDirsUnder(abs); // a folder that went: its watcher is closed, no handle left
      }
      return;
    }
    const r = readingOf(st);
    const rule = nameRule(basename(abs));
    if (rule?.skip === "report") {
      report(rel, r, rule.kind, rule.reason);
      return;
    }
    if (st.isSymbolicLink()) {
      await linkOne(rel, abs, r, flags);
      return;
    }
    if (st.isDirectory()) {
      // A folder put in a recursive watch: watched, and listed (what it holds goes through the same steps).
      // Listed (and, per folder, watched) unless it is the very folder already listed under that name.
      const depth = rel.split("/").length;
      if (opts.recursive && depth <= MAX_DEPTH && dirInos.get(abs) !== st.ino) {
        closeDirsUnder(abs);
        if (walk) walk.dirs.push({ dir: abs, depth });
        else walk = { dirs: [{ dir: abs, depth }], found: new Set(), complete: false };
      }
      return;
    }
    if (!st.isFile()) return;
    const rec = records.get(rel);
    if (rec && sameRec(rec, r) && !(flags & FORCE) && (flags & QUIET || rec.kind === "problem")) return; // unchanged: not looked at again
    const waiting = settling.get(rel);
    if (waiting && sameReading(waiting.a, r)) {
      waiting.flags = mergeFlags(waiting.flags, flags); // the same state: its wait goes on from its first reading
      return;
    }
    settling.delete(rel);
    settling.set(rel, { a: r, at: Date.now(), flags });
  }
  /** A link: never read; a link to a file inside the folder brings in that file under its own name. */
  async function linkOne(rel: string, abs: string, r: Reading, flags: number): Promise<void> {
    let target: string;
    let st: { isFile(): boolean; isDirectory(): boolean };
    try {
      target = await g.realpath(abs);
      st = await g.stat(target);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      return; // a link to nothing
    }
    if (st.isDirectory()) return report(rel, r, "could-not-import", WATCH_REASONS.folderLink);
    if (!within(realRoot, target)) return report(rel, r, "could-not-import", WATCH_REASONS.outside);
    if (st.isFile() && relName(target) !== rel) addPending(relName(target), flags);
  }

  function firstDue(): number | null {
    for (const s of settling.values()) return s.at + stability;
    return null;
  }
  /** The second reading of files read at least `stability` ms ago; the stable ones are judged; local ones queued. */
  async function settleStep(): Promise<void> {
    const now = Date.now();
    const due: Array<[string, { a: Reading; at: number; flags: number; waits?: number }]> = [];
    for (const e of settling) {
      if (e[1].at + stability > now || due.length >= BATCH) break;
      due.push(e);
    }
    let gone: Promise<string | null> | undefined;
    const stable: Array<{ rel: string; abs: string; b: Reading; flags: number; waits?: number }> = [];
    try {
      for (const [rel, s] of due) {
        settling.delete(rel);
        let st: BigIntStats;
        try {
          st = await g.lstat(absOf(rel));
        } catch (err) {
          if (err instanceof FolderNotAnsweringError) {
            settling.set(rel, s);
            throw err;
          }
          if (!(await (gone ??= rootProblem()))) removeRec(rel);
          continue;
        }
        if (!st.isFile()) continue;
        const b = readingOf(st);
        if (!sameReading(s.a, b)) {
          settling.set(rel, { a: b, at: Date.now(), flags: s.flags }); // still changing: waits for the next round
          continue;
        }
        stable.push({ rel, abs: absOf(rel), b, flags: s.flags, ...(s.waits ? { waits: s.waits } : {}) });
      }
      if (stable.length === 0) return;
      const judged = await judge(stable.map((s) => s.abs));
      for (const s of stable) {
        const c = judged.get(s.abs);
        if (!c || c.presence !== "local") {
          notLocal(s.rel, s.b, c?.presence ?? "unknown");
          sidecarOk.delete(s.rel);
        } else if (!sameReading(s.b, c)) settling.set(s.rel, { a: c, at: Date.now(), flags: s.flags });
        else {
          if (isSidecarName(s.rel)) sidecarOk.set(s.rel, s.b); // passed the whole order by itself (A6)
          imports.push({ rel: s.rel, b: s.b, flags: s.flags, ...(s.waits ? { waits: s.waits } : {}) });
        }
      }
      stable.length = 0;
    } finally {
      // Not decided because the folder stopped answering: they wait again.
      for (const s of stable) if (!settling.has(s.rel)) settling.set(s.rel, { a: s.b, at: Date.now(), flags: s.flags });
      touch();
    }
  }

  /** Files not downloaded are asked again, up to RECHECK_PER_ROUND per round (one round per `recheckMs`; an event naming one asks it at once): one that is local now is looked at. */
  async function recheck(): Promise<void> {
    if (ndOrder.size === 0) return;
    const take: string[] = [];
    for (const rel of ndOrder) {
      take.push(rel);
      if (take.length >= RECHECK_PER_ROUND) break;
    }
    for (const rel of take) {
      ndOrder.delete(rel);
      ndOrder.add(rel);
    }
    for (let i = 0; i < take.length && !stopped && !unreachable; i += BATCH) {
      const part = take.slice(i, i + BATCH);
      const judged = await judge(part.map(absOf));
      for (const rel of part) {
        if (judged.get(absOf(rel))?.presence !== "local" || settling.has(rel) || imports.some((j) => j.rel === rel)) continue;
        addPending(rel, QUIET | FORCE);
      }
    }
  }

  async function knownHashes(): Promise<Set<string>> {
    if (known) return known;
    const out = new Set<string>();
    for (const id of deps.repo.listSourceIds(projectId)) {
      try {
        for (const a of (await deps.repo.getSource(projectId, id)).assets) out.add(a.sha256);
      } catch {
        // unreadable source: its files are compared by attach itself
      }
    }
    known = out;
    return out;
  }

  let hashBuf: Buffer | undefined;
  /** SHA-256 of a file: open, each read and close are calls through the gate. Only for a file just judged local. */
  async function hashOf(abs: string): Promise<string> {
    const fh = await gate.call(() => fsx.open(abs, OPEN_FLAGS));
    try {
      const h = createHash("sha256");
      const buf = (hashBuf ??= Buffer.allocUnsafe(HASH_CHUNK));
      for (;;) {
        const { bytesRead } = await gate.call(() => fh.read(buf, 0, buf.length, null));
        if (bytesRead === 0) break;
        h.update(buf.subarray(0, bytesRead));
      }
      return h.digest("hex");
    } finally {
      // Closing is a call too: it takes its turn at the gate; if the folder is stuck (on this handle's read), it
      // waits until that call has settled — even when the watch has stopped meanwhile — and is never issued beside it.
      await gate.call(() => fh.close()).catch((err: unknown) => {
        if (err instanceof FolderNotAnsweringError) void gate.afterSettle().then(() => gate.call(() => fh.close()).catch(() => {}));
      });
    }
  }

  const isSidecarName = (rel: string) => (SIDECAR_EXTS as readonly string[]).some((ext) => rel.toLowerCase().endsWith(ext));
  /**
   * attach's check, asked immediately before EACH open of the item (the sniff, the hash, the metadata, the copy) and
   * before each sidecar is read: a fresh `lstat` (bigint) must equal the state judged "local" — the item's stability
   * reading, or the sidecar's own (a sidecar that has not passed the whole order by itself is not read). A provider
   * that evicts a file drops its blocks, so this catches it without starting a process (A6).
   */
  async function readable(p: string): Promise<boolean> {
    if (!within(realRoot, p)) return false;
    const expected = current && current.abs === p ? current.b : sidecarOk.get(relName(p));
    if (!expected) return false;
    try {
      const st = await g.lstat(p);
      return st.isFile() && sameReading(expected, readingOf(st));
    } catch {
      return false;
    }
  }
  // Viewing proxies go through the library's one queue (R85), unless the caller gives one.
  const attach =
    deps.attach ?? createAttach({ repo: deps.repo, http: deps.http, proxies: deps.proxies ?? proxyQueueFor(deps.repo), readable, ...(deps.debug ? { debug: deps.debug } : {}) });

  /** Reads and imports one stable, local file. */
  async function importNext(): Promise<void> {
    const job = imports.shift()!;
    if (libraryGone()) {
      imports.unshift(job);
      void stopWith(WATCH_REASONS.libraryClosed, true);
      return;
    }
    if (projectLocked()) {
      imports.unshift(job);
      pauseForLock();
      return;
    }
    const { rel, b, flags } = job;
    const abs = absOf(rel);
    let c: ContentState | undefined;
    try {
      c = (await judge([abs])).get(abs);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) imports.unshift(job);
      throw err;
    }
    if (!c || c.presence !== "local") return notLocal(rel, b, c?.presence ?? "unknown");
    if (!sameReading(b, c)) {
      settling.set(rel, { a: c, at: Date.now(), flags });
      return;
    }
    // A sidecar beside it still undecided (seen, not yet stable and judged): the file waits a few rounds for it,
    // then comes in without it.
    const waits = job.waits ?? 0;
    if (!isSidecarName(rel) && waits < SIDECAR_WAITS && sidecarsOf(rel).some((r) => pending.has(r) || settling.has(r))) {
      settling.set(rel, { a: b, at: Date.now(), flags, waits: waits + 1 });
      return;
    }
    // Checked: "local", and exactly the state the stability rule saw. Between this check and the first read
    // there is a window nobody can close (a cloud service may evict the file at any moment); it is kept to
    // this one file, read at once.
    const epoch = gate.epoch;
    let sha: string;
    try {
      sha = await hashOf(abs);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err; // looked at again once the folder answers (the rescan)
      if (errCode(err) === "ELOOP") return addPending(rel, flags); // a link swapped in: not followed, looked at as a link
      if (isRefusal(err)) return report(rel, b, "not-permitted", WATCH_REASONS.fileNotPermitted);
      deps.debug?.(`watched folder: a file could not be read (${errCode(err) ?? "error"})`);
      return report(rel, b, "could-not-import", WATCH_REASONS.failed);
    }
    // The same content as a file that came in here and is no longer under its old name: a rename (M3) — it stays
    // counted as it was, and is not imported or announced again.
    const prev = cameInBySha.get(sha);
    if (prev !== undefined && prev !== rel && (await goneFrom(prev))) {
      removeRec(prev);
      setRec(rel, b, "in");
      cameInBySha.set(sha, rel);
      dropProblem(rel);
      return;
    }
    if (flags & QUIET && (await knownHashes()).has(sha)) {
      setRec(rel, b, "known");
      dropProblem(rel);
      return;
    }
    current = { abs, b };
    let o: AttachOutcome | undefined;
    try {
      [o] = await attach.attachFiles(projectId, [abs]);
    } catch (err) {
      deps.debug?.(`watched folder: import failed (${err instanceof Error ? err.name : "error"})`);
      o = { path: abs, outcome: "failed", reason: WATCH_REASONS.failed };
    } finally {
      current = null;
    }
    if (gate.epoch !== epoch) throw new FolderNotAnsweringError(); // decided again once the folder answers
    if (!o) return;
    if (o.outcome === "failed" && o.reason === NOT_DOWNLOADED_REASON) {
      settling.set(rel, { a: b, at: Date.now(), flags }); // changed or evicted since the check: decided again
      return;
    }
    if (o.outcome === "failed" && o.reason === ATTACH_REASONS.locked) {
      addPending(rel, flags);
      pauseForLock();
      return;
    }
    if (o.outcome === "failed") {
      const reason = o.reason ?? WATCH_REASONS.failed;
      setRec(rel, b, "problem");
      setProblem(rel, { file: rel, kind: reason === ATTACH_REASONS.unsupported ? "not-supported" : "could-not-import", reason });
    } else {
      (await knownHashes()).add(sha);
      setRec(rel, b, o.outcome === "duplicate" ? "known" : "in");
      if (o.outcome !== "duplicate") cameInBySha.set(sha, rel);
      dropProblem(rel);
    }
    emit({
      kind: o.outcome === "failed" ? "failed" : "imported",
      file: rel,
      outcome: o.outcome,
      ...(o.sourceId ? { sourceId: o.sourceId } : {}),
      ...(o.reason ? { reason: o.reason } : {}),
    });
  }

  /** The sidecar names beside a file (same folder, same base name). */
  function sidecarsOf(rel: string): string[] {
    const slash = rel.lastIndexOf("/");
    const name = rel.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = rel.slice(0, slash + 1) + (dot > 0 ? name.slice(0, dot) : name);
    return SIDECAR_EXTS.map((ext) => stem + ext).filter((r) => r !== rel);
  }
  /** Whether the file `rel` is no longer there (one `lstat`, through the gate). */
  async function goneFrom(rel: string): Promise<boolean> {
    if (!records.has(rel)) return true;
    try {
      await g.lstat(absOf(rel));
      return false;
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      return errCode(err) === "ENOENT";
    }
  }

  function pauseForLock() {
    if (locked) return;
    locked = true;
    known = null;
    emit({ kind: "paused", reason: WATCH_REASONS.locked });
    touch();
  }

  /** The library, the project's lock, the folder; then the files not downloaded; then the rescan when due. */
  async function poll(): Promise<void> {
    if (libraryGone()) {
      void stopWith(WATCH_REASONS.libraryClosed, true);
      return;
    }
    const lockedNow = projectLocked();
    if (lockedNow) pauseForLock();
    else if (locked) {
      locked = false;
      emit({ kind: "resumed" });
      touch();
      if (!unreachable) startWalk(); // files that arrived meanwhile
    }
    if (unreachable) {
      await tryResume();
      return;
    }
    const bad = await rootProblem();
    if (bad) {
      goUnreachable(bad);
      return;
    }
    if (locked) return;
    if (Date.now() >= nextRecheck) {
      nextRecheck = Date.now() + recheckMs;
      await recheck();
    }
    if (Date.now() >= nextRescan) {
      nextRescan = Date.now() + rescanMs;
      if (!walk) startWalk();
    }
  }

  let wakeUp: (() => void) | null = null;
  function wake() {
    const w = wakeUp;
    wakeUp = null;
    w?.();
  }
  const idle = (ms: number) =>
    new Promise<void>((r) => {
      const done = () => {
        clearTimeout(t);
        if (wakeUp === done) wakeUp = null;
        r();
      };
      const t = setTimeout(done, Math.max(0, ms));
      t.unref?.();
      wakeUp = done;
    });

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        if (gate.stuck) {
          await gate.whenFree();
          if (!stopped) await tryResume();
          continue;
        }
        if (pollDue) {
          pollDue = false;
          await poll();
          continue;
        }
        if (unreachable || locked) {
          await idle(pollMs);
          continue;
        }
        if (imports.length > 0) {
          await importNext();
          continue;
        }
        const due = firstDue();
        if (due !== null && due <= Date.now()) {
          await settleStep();
          continue;
        }
        if (pending.size > 0 && settling.size < SETTLING_MAX) {
          await readStep();
          continue;
        }
        if (walk && walk.dirs.length > 0) {
          await walkStep();
          continue;
        }
        if (walk) finishWalk();
        await idle(due !== null ? due - Date.now() : pollMs);
      } catch (err) {
        if (err instanceof FolderNotAnsweringError) continue;
        deps.debug?.(`watched folder: ${err instanceof Error ? err.name : "error"}`);
        await idle(pollMs); // never a busy loop on an unexpected error
      }
    }
  }

  const timer = setInterval(() => {
    pollDue = true;
    wake();
  }, pollMs);
  timer.unref?.();

  let loopDone: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  /** `inside`: called by the watch's own work, which must not wait for itself. */
  function stopWith(reason?: string, inside = false): Promise<void> {
    stopping ??= (async () => {
      stopped = true;
      stopReason = reason;
      clearInterval(timer);
      gate.release();
      wake();
      await closeWatcher();
      if (!inside) {
        await ready.catch(() => {});
        await loopDone.catch(() => {});
      }
      emit({ kind: "stopped", ...(reason ? { reason } : {}) });
      send();
    })();
    return stopping;
  }

  // A call an earlier watch made on this folder is still outstanding: nothing is issued until it settles (A6).
  const prior = outstandingFolders.get(root);
  if (prior) {
    gate.adopt(prior);
    goUnreachable(withProvider(WATCH_REASONS.notResponding, provider));
  }

  const ready: Promise<void> = (async () => {
    try {
      const bad = await checkRoot();
      if (bad?.stop) {
        emit({ kind: "error", reason: bad.stop });
        await stopWith(undefined, true);
        return;
      }
      if (stopped) return;
      if (bad) goUnreachable(bad.reason!);
      else {
        let entries: Entry[] | undefined;
        try {
          entries = await g.readdir(realRoot);
        } catch (err) {
          if (!(err instanceof FolderNotAnsweringError)) goUnreachable(folderReason(err));
        }
        if (entries && !stopped) {
          await startWatcher();
          startWalk(entries); // files that arrived while nothing was watching
        }
      }
    } catch (err) {
      if (!(err instanceof FolderNotAnsweringError)) emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
    }
    if (!stopped) {
      touch();
      loopDone = run();
    }
  })();

  return {
    ready,
    get stopped() {
      return stopped;
    },
    stop: () => stopWith(),
    status,
    problems: ({ kind, offset, limit }) => {
      const all = [...problemList.values()].reverse().filter((p) => !kind || p.kind === kind);
      return { total: all.length, items: all.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit)).map((p) => ({ ...p })) };
    },
  };
}

type Entry = Awaited<ReturnType<WatchFs["readdir"]>>[number];

// ------------------------------------------------------------------------------------------
// Settings: project.json (id + options) and this device's folder for each watch (R69).

const FILE = "watched-folders.json";
type Store = Record<string, Record<string, Record<string, string>>>;

/**
 * The list of watched folders on this computer could not be read (Task 68 fix round 1, I1; R178 a):
 * nothing was moved or written. The message carries no path.
 */
export class WatchedFoldersUnreadableError extends Error {
  constructor() {
    super("This computer's list of watched folders could not be read, so it was not changed. Check that the app's settings folder can be read and try again.");
    this.name = "WatchedFoldersUnreadableError";
  }
}

/**
 * The store, by the registry's rule (Task 68, R178 a): missing is empty; a read error other than
 * "missing" throws WatchedFoldersUnreadableError (nothing is moved or written on its strength);
 * `corrupt` only when the CONTENT is damaged (not JSON, the wrong shape, an entry this app cannot
 * use): the file is then kept aside before any write.
 */
async function readStore(appConfigDir: string): Promise<{ store: Store; corrupt: boolean }> {
  const out = Object.create(null) as Store;
  let text: string;
  try {
    text = await fsp.readFile(join(appConfigDir, FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { store: out, corrupt: false };
    throw new WatchedFoldersUnreadableError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { store: out, corrupt: true };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { store: out, corrupt: true };
  let dropped = false;
  for (const libId of Object.keys(raw)) {
    const projects = (raw as Record<string, unknown>)[libId];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
      dropped = true;
      continue;
    }
    const p = Object.create(null) as Record<string, Record<string, string>>;
    for (const projectId of Object.keys(projects)) {
      const watches = (projects as Record<string, unknown>)[projectId];
      if (!watches || typeof watches !== "object" || Array.isArray(watches)) {
        dropped = true;
        continue;
      }
      const w = Object.create(null) as Record<string, string>;
      for (const id of Object.keys(watches)) {
        const d = (watches as Record<string, unknown>)[id];
        if (typeof d === "string" && isAbsolute(d)) w[id] = d;
        else dropped = true;
      }
      p[projectId] = w;
    }
    out[libId] = p;
  }
  // An entry this app cannot use is not dropped in silence: the whole file is kept aside first.
  return { store: out, corrupt: dropped };
}

export interface WatchSettingsDeps {
  repo: Repo;
  lib: Pick<Library, "id" | "appConfigDir" | "root">;
  /** Receives plain warnings (an unreadable settings file set aside). */
  onWarning?: (warning: string) => void;
}

/**
 * Keeps a damaged settings file aside as `watched-folders.json.corrupt-<stamp>` (never deleted, never
 * overwritten: `-n` when that name is taken), warns, and raises the device-level notice (Task 68).
 * When it cannot be set aside, nothing may be written over it: WatchedFoldersUnreadableError.
 */
async function setAside(deps: WatchSettingsDeps): Promise<void> {
  const dir = deps.lib.appConfigDir;
  const now = new Date();
  const stamp = now.toISOString().replace(/\.\d+Z$/u, "").replace(/[-:]/gu, "").replace("T", "-");
  let name = `${FILE}.corrupt-${stamp}`;
  for (let n = 1; await fsp.lstat(join(dir, name)).then(() => true, () => false); n++) name = `${FILE}.corrupt-${stamp}-${n}`;
  try {
    await fsp.rename(join(dir, FILE), join(dir, name));
  } catch {
    throw new WatchedFoldersUnreadableError();
  }
  deps.onWarning?.(WATCH_REASONS.settingsUnreadable);
  await raiseDeviceNotice(dir, "watched-folders-list-set-aside", now);
}

let lock: Promise<unknown> = Promise.resolve();
function updateStore(deps: WatchSettingsDeps, fn: (s: Store) => void): Promise<void> {
  const lib = deps.lib;
  const next = lock.then(async () => {
    const { store, corrupt } = await readStore(lib.appConfigDir); // re-read under the lock
    if (corrupt) await setAside(deps);
    fn(store);
    await fsp.mkdir(lib.appConfigDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(lib.appConfigDir, 0o700).catch(() => {});
    await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
  });
  lock = next.catch(() => {});
  return next;
}

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** The folder's real path, checked: absolute, a folder, not inside the library nor holding it. */
async function checkedFolder(deps: WatchSettingsDeps, dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new TypeError("The watched folder must be an absolute path.");
  const real = await fsp.realpath(dir);
  if (!(await fsp.stat(real)).isDirectory()) throw new TypeError("The watched folder must be a folder.");
  if (await overlapsLibrary(real, deps.lib)) throw new TypeError(WATCH_REASONS.library);
  return real;
}

function putFolder(deps: WatchSettingsDeps, projectId: string, id: string, real: string): Promise<void> {
  return updateStore(deps, (s) => {
    const projects = own(s, deps.lib.id) ?? (Object.create(null) as Record<string, Record<string, string>>);
    const watches = own(projects, projectId) ?? (Object.create(null) as Record<string, string>);
    watches[id] = real;
    projects[projectId] = watches;
    s[deps.lib.id] = projects;
  });
}

/** Adds a watched folder: its id and options to project.json (governed, audited), its folder to this device's settings. */
export async function addWatchedFolder(deps: WatchSettingsDeps, projectId: string, dir: string, options: Partial<WatchedFolderOptionsT> = {}): Promise<WatchedFolder> {
  const real = await checkedFolder(deps, dir);
  deps.repo.getProject(projectId); // NotFoundError for an unknown project
  // A list that cannot be read refuses before the project is changed (Task 68, R178 a).
  await readStore(deps.lib.appConfigDir);
  const wf = await addWatchedFolderEntry(deps.repo, projectId, options);
  await putFolder(deps, projectId, wf.id, real);
  return wf;
}

/** Chooses this computer's folder for a watch the project already has (e.g. one added on another computer). */
export async function setWatchFolder(deps: WatchSettingsDeps, projectId: string, id: string, dir: string): Promise<void> {
  if (!(deps.repo.getProject(projectId).watchedFolders ?? []).some((w) => w.id === id)) throw new TypeError("This project has no such watched folder.");
  await putFolder(deps, projectId, id, await checkedFolder(deps, dir));
}

/** Removes a watched folder from project.json and from this device's settings. */
export async function removeWatchedFolder(deps: WatchSettingsDeps, projectId: string, id: string): Promise<void> {
  // A list that cannot be read refuses before the project is changed (Task 68, R178 a).
  await readStore(deps.lib.appConfigDir);
  await removeWatchedFolderEntry(deps.repo, projectId, id);
  await updateStore(deps, (s) => {
    const watches = own(own(s, deps.lib.id) ?? {}, projectId);
    if (watches && Object.hasOwn(watches, id)) delete watches[id];
  });
}

/** The project's watched folders, each with its folder on this computer (`dir` undefined when none was chosen here). */
export async function listWatchedFolders(deps: WatchSettingsDeps, projectId: string): Promise<Array<WatchedFolder & { dir?: string }>> {
  const { store, corrupt } = await readStore(deps.lib.appConfigDir);
  if (corrupt) await updateStore(deps, () => {}); // set aside (with the warning and the notice) under the lock
  const watches = own(own(store, deps.lib.id) ?? {}, projectId) ?? {};
  return (deps.repo.getProject(projectId).watchedFolders ?? []).map((w) => {
    const dir = own(watches, w.id);
    return { ...structuredClone(w), ...(dir ? { dir } : {}) };
  });
}

/** Starts every watched folder of the project that has a folder on this computer. */
export async function startWatchedFolders(deps: WatchDeps & Pick<WatchSettingsDeps, "onWarning">, projectId: string): Promise<FolderWatch[]> {
  const out: FolderWatch[] = [];
  for (const w of await listWatchedFolders(deps, projectId)) if (w.dir) out.push(watchFolder(deps, projectId, w.dir, w.options, w.id));
  return out;
}
