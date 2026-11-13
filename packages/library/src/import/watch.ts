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
 *      state it judged must equal the stability reading exactly; then the hash (opened with O_NOFOLLOW), then
 *      attach, which asks `readable` again immediately before EACH of its opens — the type sniff, its hash, the
 *      metadata, the copy — and before each sidecar read: a fresh `lstat` must still equal the judged state (A6).
 *   Sidecars (`.bib`, `.ris`, `.json`, `.opf`) are files like any other: one is read only after it passed steps
 *   1–4 by itself (`sidecarOk`); one that has not is not used this time (A6, C1).
 *
 * Calls that never answer (R208 d, A6): a time limit around a promise does not free the thread a stuck call
 * holds. So every file-system call this module makes for a folder goes through that folder's one gate
 * (`FolderGate`): at most ONE call in flight per watched folder (the `lstat`s `contentState` makes included —
 * it is given the gate's `lstat`; on macOS its `/usr/bin/stat` process runs only after its `lstat`s have
 * answered, while this folder's one worker waits for it, so it is never beside another call of this folder;
 * the close of a handle whose read did not answer takes its turn after that read has settled). A call
 * unanswered after `fsTimeoutMs` marks the folder "unreachable" (notResponding), closes the watchers, and NO
 * further call is made on that folder until the stuck one settles — not by this watch, not by `stop()`, and
 * not by a new watch of the same folder (`outstandingFolders`); then the folder is checked again and scanned.
 *
 * Left as they are (review M2, M6): attach's own reads of a file judged local are not time-limited (they run
 * while this folder's worker waits, so they are still its one call, but a stuck one is not reported as "not
 * responding" and it holds the project's store queue); and what is kept per file (`Rec`, about 255 bytes at
 * 40,000 files) grows with the folder, not with time.
 *
 * The register (Task W3; R207 2 and 3, which replace R81's "a changed file is imported again"): each watch keeps,
 * in the project, which file became which source (repo/watch-register.ts). The engine NOTES what a colleague later
 * does to such a file and never acts on it:
 *   - a registered file whose size and exact time are unchanged is not read again (not even at start);
 *   - one whose size or time changed is hashed if it is local (through the whole order above): the same content
 *     updates the reading; other content is noted "changed". One that is not local is noted "may-have-changed"
 *     and is not read;
 *   - one missing from a complete listing is noted "gone" — unless at least WATCH_MASS_GONE_MIN of the folder's
 *     "in-library" entries, and at least half of them, are missing at once (a provider signed out or starting):
 *     then nothing is noted and the status says `massGone`. A folder that cannot be reached is never listed
 *     completely, so it never marks anything;
 *   - a new file whose content is a registered entry's whose old name is gone (renamed, moved, or its name now
 *     differs only by case or normalisation, A3) takes that entry over: no second source;
 *   - content the register holds for a source the researcher deleted is not imported again (it counts as
 *     already in the library);
 *   - a source the watch created whose register line was lost (a crash between the two) is adopted, never
 *     imported again (its provenance names the watch).
 * A note is a register line and NOTHING else: no source, file or annotations.json changes because of the drive
 * (Decision 4). Only the researcher's own act brings a changed file in (`bringInNewVersion`, a further original
 * of the same source; `settleWatchedFile` keeps the library's copy). Lines are written in batches (at most
 * WATCH_REGISTER_BATCH, or WATCH_REGISTER_FLUSH_MS after the first, and at stop()), each one governed change.
 *
 * Other behaviour kept from Task 26:
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
import { WatchedFolderOptions, isId, type WatchedFolder, type WatchedFolderOptions as WatchedFolderOptionsT } from "@ao/core";
import { raiseDeviceNotice } from "../device-notices.js";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { isClosed, type Library } from "../library.js";
import type { LocationEnv } from "../location.js";
import type { HttpClient } from "../lookup/index.js";
import { InvalidInputError, ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { addWatchedFolderEntry, projectCollectionsAndTags, projectEncrypted, removeWatchedFolderEntry, type Repo } from "../repo/repo.js";
import { WATCHED_FILE_STATES, isRegisterEntry, type WatchRegisterEntry, type WatchedFileState } from "../repo/watch-register.js";
import { ATTACH_REASONS, NOT_DOWNLOADED_REASON, WATCHED_FOLDER_TOOL, createAttach, type Attach, type AttachOutcome, type AttachStatus } from "./attach.js";
import { proxyQueueFor, type ProxyQueue } from "./proxies.js";
import { SIDECAR_EXTS } from "./sidecar.js";
import { PROVIDER_NAMES, WATCH_LOCAL_BATCH, cloudProviderOf, contentState, fileKey, nameRule, type CloudProvider, type ContentState } from "./watch-local.js";

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
/** Register lines written in one change at most (Task W3). */
export const WATCH_REGISTER_BATCH = 50;
/** A register line waits at most this long before it is written. */
export const WATCH_REGISTER_FLUSH_MS = 5000;
/** At least this many "in-library" entries, and at least half of them, missing at once: nothing is marked gone. */
export const WATCH_MASS_GONE_MIN = 20;

/** A file the researcher asked to bring in is not on this computer now, or not as it was checked: nothing was read. */
export class WatchFileNotLocalError extends Error {
  constructor() {
    super("The file in the folder is not downloaded to this Mac, or it is still changing, so it was not read. Download it in Finder, then try again.");
    this.name = "WatchFileNotLocalError";
  }
}

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
  /** Task W3: most of the register missing at once; `{provider}` is filled by `withProvider`. */
  massGone: "Most files in this folder disappeared at once. This usually means {provider} is signed out or still starting. Nothing in the library has changed.",
  noCollection: "The collection chosen for this folder no longer exists, so new files go into the project without a collection.",
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
    /** Registered files noted "changed" or "may-have-changed" (Task W3). */
    changed: number;
    /** Registered files noted "gone". */
    gone: number;
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
  /** Test seam: how long a register line waits before it is written (default WATCH_REGISTER_FLUSH_MS). */
  registerFlushMs?: number;
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

/** "Is this content on this computer?" with the gate's `lstat`; answers given across a call that did not answer are thrown away. */
async function gatedJudge(gate: FolderGate, fsx: WatchFs, presence: typeof contentState, abs: string[]): Promise<Map<string, ContentState>> {
  const epoch = gate.epoch;
  const lstat = async (p: string) => {
    const s = await gate.call(() => fsx.lstat(p));
    return { size: Number(s.size), blocks: Number(s.blocks), ino: s.ino, mtimeNs: s.mtimeNs, isFile: () => s.isFile() };
  };
  const m = await presence(abs, { lstat, signal: gate.signal });
  if (gate.epoch !== epoch || gate.stuck) throw new FolderNotAnsweringError();
  return m;
}

/** SHA-256 of a file: open (read-only, O_NOFOLLOW), each read and close are calls through the gate. Only for a file just judged local. */
async function gatedHash(gate: FolderGate, fsx: WatchFs, abs: string, buf: Buffer): Promise<string> {
  const fh = await gate.call(() => fsx.open(abs, OPEN_FLAGS));
  try {
    const h = createHash("sha256");
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

/** The calls a researcher's act on one file makes (bringInNewVersion), each through the folder's one gate. */
interface FileIo {
  realRoot: string;
  stabilityMs: number;
  lstat(abs: string): Promise<BigIntStats>;
  judge(abs: string[]): Promise<Map<string, ContentState>>;
  hash(abs: string): Promise<string>;
  /** attach with `readable` answering for `abs` only while a fresh `lstat` equals `b`. */
  attach(abs: string, b: Reading, toSourceId: string): Promise<AttachOutcome | undefined>;
}

/** A running watch, for the researcher's acts on its files (one per repo, project and watch id). */
interface LiveWatch {
  /** Runs `fn` as one step of the watch's own worker (so its calls are the folder's one call in flight). */
  exclusive<T>(fn: (io: FileIo) => Promise<T>): Promise<T>;
  /** Writes the register lines waiting to be written. */
  flush(): Promise<void>;
  /** A line written by the researcher's act: the watch's own view follows it. */
  apply(e: WatchRegisterEntry): void;
}
const liveWatches = new WeakMap<Repo, Map<string, LiveWatch>>();
const liveKey = (projectId: string, watchId: string) => `${projectId}\u0000${watchId}`;

/** Two names of the same file on a file system that ignores case and normalisation (macOS): equal when folded. */
const foldedName = (rel: string) => rel.normalize("NFC").toLowerCase();
const sameStored = (e: WatchRegisterEntry, r: Reading) => e.size === r.size && e.mtimeNs === r.mtimeNs.toString();

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
  /** The listing in progress: folders still to read, and what was found (to drop files that went away). */
  let walk: { dirs: Array<{ dir: string; depth: number; entries?: Entry[] }>; found: Set<string>; complete: boolean } | null = null;
  let pollDue = false;
  let nextRescan = Date.now() + rescanMs;
  let nextRecheck = Date.now() + recheckMs;
  /** The file being imported and its stability reading (for attach's `readable`). */
  let current: { abs: string; b: Reading } | null = null;

  // ---- the register (Task W3) ---------------------------------------------------------------------------------
  /** Written to the library only for a watch with an id (the service's watches); otherwise kept for this run. */
  const persist = watchId !== undefined && isId(watchId);
  const flushMs = deps.registerFlushMs ?? WATCH_REGISTER_FLUSH_MS;
  /** The register by key; null until read, and while the project is locked (sealed content is not kept then). */
  let reg: Map<string, WatchRegisterEntry> | null = persist ? null : new Map();
  /** The register has been read (and the collection checked) since the start or the last lock. */
  let regReady = false;
  /** Keys by content (`sha256`, and `newSha256`): renames, copies and sources deleted here. */
  const regBySha = new Map<string, Set<string>>();
  /** Keys by source: a source of this watch with no entry is adopted (Accept 1). */
  const regBySource = new Map<string, string>();
  const regCounts = Object.fromEntries(WATCHED_FILE_STATES.map((st) => [st, 0])) as Record<WatchedFileState, number>;
  /** Lines noted and not yet written (already in `reg`). */
  const unwritten: WatchRegisterEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> = Promise.resolve();
  /** The last complete listing missed most of the register at once (nothing was marked gone). */
  let massGone = false;
  /** The collection chosen for this folder no longer exists. */
  let noCollection = false;

  const indexShas = (e: WatchRegisterEntry) => (e.newSha256 && e.newSha256 !== e.sha256 ? [e.sha256, e.newSha256] : [e.sha256]);
  function unindex(e: WatchRegisterEntry) {
    for (const sha of indexShas(e)) {
      const keys = regBySha.get(sha);
      keys?.delete(e.key);
      if (keys && keys.size === 0) regBySha.delete(sha);
    }
    if (regBySource.get(e.sourceId) === e.key) regBySource.delete(e.sourceId);
    regCounts[e.state]--;
  }
  /** Applies an entry to the register in memory (a rename drops the old key). */
  function putEntry(e: WatchRegisterEntry) {
    if (!reg) return;
    if (e.renamedFrom !== undefined && e.renamedFrom !== e.key) {
      const was = reg.get(e.renamedFrom);
      if (was) {
        unindex(was);
        reg.delete(e.renamedFrom);
      }
    }
    const old = reg.get(e.key);
    if (old) unindex(old);
    reg.set(e.key, e);
    for (const sha of indexShas(e)) {
      let keys = regBySha.get(sha);
      if (!keys) regBySha.set(sha, (keys = new Set()));
      keys.add(e.key);
    }
    regBySource.set(e.sourceId, e.key);
    regCounts[e.state]++;
    touch();
  }
  /** A change of a file's state: in the register now, written with the next batch. The ONLY write a note makes. */
  function note(e: WatchRegisterEntry) {
    putEntry(e);
    if (!persist) return;
    if (!isRegisterEntry(e)) {
      deps.debug?.("watched folder: a register entry was not well formed and is kept for this run only");
      return;
    }
    unwritten.push(e);
    if (unwritten.length >= WATCH_REGISTER_BATCH) void flush();
    else scheduleFlush();
  }
  function scheduleFlush() {
    if (flushTimer || stopped || unwritten.length === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, flushMs);
    flushTimer.unref?.();
  }
  /** Writes the lines not yet written, in batches of WATCH_REGISTER_BATCH (each one governed change); a failure keeps them for later. */
  function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    flushing = flushing.then(async () => {
      while (unwritten.length > 0) {
        const batch = unwritten.slice(0, WATCH_REGISTER_BATCH);
        try {
          await deps.repo.recordWatchedFiles(projectId, watchId!, batch);
        } catch (err) {
          deps.debug?.(`watched folder: the register could not be written now (${err instanceof Error ? err.name : "error"})`);
          scheduleFlush(); // tried again later (e.g. once the project is unlocked)
          return;
        }
        unwritten.splice(0, batch.length);
      }
    });
    return flushing;
  }
  /** Whether the chosen collection exists (none chosen: nothing to say). */
  async function checkCollection(): Promise<void> {
    const id = opts.collectionId;
    let gone = false;
    if (id) {
      try {
        gone = !(await projectCollectionsAndTags(deps.repo, projectId)).collections.some((c) => c.id === id);
      } catch {
        gone = noCollection; // unreadable now: what was known stays
      }
    }
    if (gone !== noCollection) {
      noCollection = gone;
      touch();
    }
  }
  /** Reads the register (sealed: only while unlocked) and checks the collection. False when it cannot be read now. */
  async function loadRegister(): Promise<boolean> {
    if (projectLocked()) {
      pauseForLock();
      return false;
    }
    if (persist) {
      let m: Map<string, WatchRegisterEntry>;
      try {
        m = await deps.repo.watchRegister(projectId, watchId!);
      } catch (err) {
        if (err instanceof ProjectLockedError) pauseForLock();
        else deps.debug?.(`watched folder: the register could not be read (${err instanceof Error ? err.name : "error"})`);
        return false;
      }
      reg = new Map();
      regBySha.clear();
      regBySource.clear();
      for (const st of WATCHED_FILE_STATES) regCounts[st] = 0;
      for (const e of m.values()) putEntry(e);
      for (const e of unwritten) putEntry(e); // noted before the lock and not yet written: they are the latest
    }
    await checkCollection();
    regReady = true;
    touch();
    return true;
  }

  /**
   * The project's sources and the content they hold, kept up to date with the project: sources added since are
   * read, sources removed (deleted here, or taken away by an undo) are dropped, and then every file counted as
   * "already in the library" is looked at again (its content may no longer be in the library).
   */
  type LibIndex = { ids: Set<string>; shas: Map<string, Set<string>>; ofSource: Map<string, { shas: string[]; ours: boolean }> };
  let libIdx: LibIndex | null = null;
  async function libraryIndex(): Promise<LibIndex> {
    const ids = deps.repo.listSourceIds(projectId);
    const first = libIdx === null;
    const idx: LibIndex = libIdx ?? { ids: new Set(), shas: new Map(), ofSource: new Map() };
    libIdx = idx;
    const now = new Set(ids);
    let removed = false;
    for (const id of [...idx.ids]) {
      if (now.has(id)) continue;
      removed = true;
      idx.ids.delete(id);
      for (const sha of idx.ofSource.get(id)?.shas ?? []) {
        const owners = idx.shas.get(sha);
        owners?.delete(id);
        if (owners && owners.size === 0) idx.shas.delete(sha);
      }
      idx.ofSource.delete(id);
    }
    for (const id of ids) {
      if (idx.ids.has(id)) continue;
      idx.ids.add(id);
      try {
        const sf = await deps.repo.getSource(projectId, id);
        const shas = sf.assets.map((a) => a.sha256);
        const ours = persist && sf.source.provenance.externalKeys?.[WATCHED_FOLDER_TOOL] === watchId;
        idx.ofSource.set(id, { shas, ours });
        for (const sha of shas) {
          let owners = idx.shas.get(sha);
          if (!owners) idx.shas.set(sha, (owners = new Set()));
          owners.add(id);
        }
      } catch {
        // unreadable source: its files are compared by attach itself
      }
    }
    if (removed && !first) for (const [rel, rec] of records) if (rec.kind === "known") addPending(rel, QUIET | FORCE);
    return idx;
  }
  /** Whether the source holds content `sha` now (read afresh: a further original may have been added). */
  async function sourceHolds(sourceId: string, sha: string): Promise<boolean> {
    try {
      return (await deps.repo.getSource(projectId, sourceId)).assets.some((a) => a.sha256 === sha);
    } catch {
      return false;
    }
  }
  const sameEntry = (a: WatchRegisterEntry, b: WatchRegisterEntry) => JSON.stringify({ ...a, at: "" }) === JSON.stringify({ ...b, at: "" });
  /** `e` without the parts that describe a change (an entry "in-library" again). */
  const settledShape = (e: WatchRegisterEntry): WatchRegisterEntry => {
    const { newSha256: _n, newSize: _s, renamedFrom: _r, ...rest } = e;
    return rest;
  };
  /** Notes `next` unless it says nothing new about the file. */
  function noteIfChanged(prev: WatchRegisterEntry, next: WatchRegisterEntry) {
    const { renamedFrom: _r, ...clean } = next;
    if (!sameEntry(settledShape(prev), settledShape(clean)) || prev.newSha256 !== clean.newSha256 || prev.newSize !== clean.newSize) note({ ...clean, at: new Date().toISOString() });
  }

  /** A registered file whose size and exact time are as when its content was last known: not read. */
  async function registeredUnchanged(rel: string, e: WatchRegisterEntry, b: Reading): Promise<void> {
    setRec(rel, b, "in");
    dropProblem(rel);
    let next: WatchRegisterEntry = { ...e, file: rel };
    if (e.state === "gone") {
      // Back, as it was when last known: "changed" if that was a change, else in the library again.
      next = e.newSha256 && e.newSha256 !== e.sha256 ? { ...next, state: "changed" } : { ...settledShape(next), state: "in-library" };
    } else if (e.state === "changed" && e.newSha256 && (await sourceHolds(e.sourceId, e.newSha256))) {
      // The new version was brought in and the process stopped before its line was written: healed.
      next = { ...settledShape(next), sha256: e.newSha256, state: "in-library" };
    }
    noteIfChanged(e, next);
  }
  /** A registered file whose size or time changed and which is not on this computer: noted, never read. */
  function registeredNotLocal(rel: string, e: WatchRegisterEntry, b: Reading) {
    setRec(rel, b, "in");
    dropProblem(rel);
    if (e.state === "may-have-changed" && e.newSize === b.size && e.file === rel) return;
    const { newSha256: _n, renamedFrom: _r, ...rest } = e;
    note({ ...rest, file: rel, state: "may-have-changed", newSize: b.size, at: new Date().toISOString() });
  }
  /** A registered file whose size or time changed, read through the whole order: what its content is now. */
  async function registeredHashed(rel: string, e: WatchRegisterEntry, b: Reading, sha: string): Promise<void> {
    setRec(rel, b, "in");
    dropProblem(rel);
    const reading = { file: rel, size: b.size, mtimeNs: b.mtimeNs.toString() };
    let next: WatchRegisterEntry;
    if (sha === e.sha256) next = { ...settledShape(e), ...reading, state: "in-library" };
    else if (await sourceHolds(e.sourceId, sha)) next = { ...settledShape(e), ...reading, sha256: sha, state: "in-library" };
    else if (sha === e.newSha256 && (e.state === "changed" || e.state === "settled")) next = { ...e, ...reading };
    else next = { ...e, ...reading, state: "changed", newSha256: sha, newSize: b.size };
    noteIfChanged(e, next);
  }
  /**
   * A new file whose content is a registered entry's, whose old name is gone — "gone" already, missing now, or
   * (macOS) the same file under a name differing only by case or normalisation (A3): renamed or moved.
   */
  async function renamedFrom(rel: string, b: Reading, sha: string): Promise<WatchRegisterEntry | undefined> {
    const keys = [...(regBySha.get(sha) ?? [])].filter((k) => k !== fileKey(rel));
    const entries = keys.map((k) => reg!.get(k)!).filter((e) => e && (e.sha256 === sha || e.newSha256 === sha));
    const gone = entries.find((e) => e.state === "gone");
    if (gone) return gone;
    for (const e of entries) if (await goneFrom(e.file, rel, b)) return e;
    return undefined;
  }

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
  /** "Is this content on this computer?" for `abs` paths (`contentState`'s own `lstat`s through the gate: W1 runs two at a time, the gate makes them one). */
  const judge = (abs: string[]) => gatedJudge(gate, fsx, presence, abs);

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
    const reason =
      state === "stopped"
        ? stopReason
        : state === "unreachable"
          ? unreachable!
          : state === "locked"
            ? WATCH_REASONS.locked
            : massGone
              ? withProvider(WATCH_REASONS.massGone, provider)
              : noCollection
                ? WATCH_REASONS.noCollection
                : undefined;
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
        changed: regCounts.changed + regCounts["may-have-changed"],
        gone: regCounts.gone,
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
    // The watcher is set up right after the folder answered, before the folder counts as watched again.
    if (!watchDir(realRoot, true)) {
      goUnreachable(WATCH_REASONS.watchFailed);
      return;
    }
    unreachable = null;
    emit({ kind: "resumed" });
    touch();
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
  /**
   * A watcher failed or closed by itself (N1). The folder's own: the folder is "Cannot be reached" (never "watching"
   * without a watcher) and is asked again at once, inside the per-folder limit — `tryResume` checks it, sets the
   * watcher up again right after it answers, and scans it so that nothing that arrived meanwhile is missed. A
   * subfolder's (per-folder form): that folder is listed again at once, which watches it again after it answers.
   */
  function watcherLost(d: string, w: FSWatcher) {
    if (dirWatchers.get(d) !== w) return; // closed by this module
    dirWatchers.delete(d);
    w.close();
    if (stopped || unreachable) return;
    if (d === realRoot) {
      goUnreachable(WATCH_REASONS.watchFailed);
      pollDue = true;
    } else {
      dirInos.delete(d);
      const entry = { dir: d, depth: relName(d).split("/").length };
      if (walk) walk.dirs.push(entry);
      else walk = { dirs: [entry], found: new Set(), complete: false };
    }
    wake();
  }
  /** Sets up the folder's watcher; false when it could not be. `resuming`: the folder has just answered while it was "unreachable". */
  function watchDir(d: string, resuming = false): boolean {
    if (!eventsOn || (form === "tree" && d !== realRoot)) return true; // the tree's one watcher already covers it
    if (stopped || (unreachable && !resuming) || gate.stuck) return false;
    if (dirWatchers.has(d)) return true;
    let w: FSWatcher;
    try {
      w = fsWatch(d, form === "tree" ? { recursive: opts.recursive, persistent: true } : { persistent: true });
    } catch {
      return false; // the root: "Cannot be reached" (asked again at the next poll); a subfolder: the next scan finds what it holds
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
    w.on("error", () => watcherLost(d, w));
    w.on("close", () => watcherLost(d, w)); // a close this module did not make
    return true;
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
    if (w.complete) {
      for (const rel of [...records.keys()]) if (!w.found.has(rel) && !pending.has(rel) && !settling.has(rel) && !imports.some((j) => j.rel === rel)) removeRec(rel);
      markGone(w.found);
    }
    touch();
  }
  /**
   * After a COMPLETE listing (a folder that cannot be reached is never listed completely): registered files it
   * did not find are noted "gone" — unless at least WATCH_MASS_GONE_MIN "in-library" entries, and at least half of
   * them, are missing at once (a provider signed out or still starting): then nothing is noted (`massGone`).
   * A note is a register line and nothing else: the sources stay as they are.
   */
  function markGone(found: Set<string>) {
    if (!reg || !regReady) return;
    const present = new Set<string>();
    for (const rel of found) present.add(fileKey(rel));
    const missing: WatchRegisterEntry[] = [];
    let missingInLibrary = 0;
    for (const e of reg.values()) {
      if (e.state === "gone" || e.state === "settled" || present.has(e.key)) continue;
      missing.push(e);
      if (e.state === "in-library") missingInLibrary++;
    }
    const mass = missingInLibrary >= WATCH_MASS_GONE_MIN && missingInLibrary * 2 >= regCounts["in-library"];
    if (mass !== massGone) {
      massGone = mass;
      touch();
    }
    if (mass) return;
    const at = new Date().toISOString();
    for (const e of missing) {
      const { renamedFrom: _r, ...rest } = e;
      note({ ...rest, state: "gone", at });
    }
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
      // A registered file as it was when its content was last known: nothing to read (Task W3).
      for (let i = stable.length - 1; i >= 0; i--) {
        const s = stable[i]!;
        const e = reg?.get(fileKey(s.rel));
        if (e && sameStored(e, s.b)) {
          stable.splice(i, 1);
          await registeredUnchanged(s.rel, e, s.b);
        }
      }
      if (stable.length === 0) return;
      const judged = await judge(stable.map((s) => s.abs));
      for (const s of stable) {
        const c = judged.get(s.abs);
        const e = reg?.get(fileKey(s.rel));
        if (e && (!c || c.presence !== "local")) registeredNotLocal(s.rel, e, s.b);
        else if (!c || c.presence !== "local") {
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

  let hashBuf: Buffer | undefined;
  /** SHA-256 of a file (O_NOFOLLOW; open, each read and close through the gate). Only for a file just judged local. */
  const hashOf = (abs: string) => gatedHash(gate, fsx, abs, (hashBuf ??= Buffer.allocUnsafe(HASH_CHUNK)));

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
    const key = fileKey(rel);
    // A registered file whose size or time changed: what its content is now is noted; it is never imported (W3).
    const known = reg!.get(key);
    if (known) return registeredHashed(rel, known, b, sha);
    // The same content as a registered file whose old name is gone: a rename or move (M3, W3 Accept 4) — the entry
    // follows the file; nothing is imported or announced, and it stays counted as it was.
    const moved = await renamedFrom(rel, b, sha);
    if (moved) {
      if (moved.file !== rel) removeRec(moved.file);
      const reading = { key, file: rel, size: b.size, mtimeNs: b.mtimeNs.toString(), renamedFrom: moved.key, at: new Date().toISOString() };
      const state: WatchedFileState = sha === moved.sha256 ? "in-library" : moved.state === "gone" || moved.state === "may-have-changed" ? "changed" : moved.state;
      note(state === "in-library" ? { ...settledShape(moved), ...reading, state } : { ...moved, ...reading, state, newSha256: sha, newSize: b.size });
      setRec(rel, b, "in");
      dropProblem(rel);
      return;
    }
    // Content the register holds — a copy of a registered file, or the file of a source deleted here (which stays
    // deleted, W3 Accept 5): already in the library.
    if (regBySha.has(sha)) {
      setRec(rel, b, "known");
      dropProblem(rel);
      return;
    }
    const lib = await libraryIndex();
    const owners = lib.shas.get(sha);
    if (owners) {
      // A source this watch created whose register line was lost (a crash between the two): adopted (Accept 1).
      const adopt = [...owners].find((id) => lib.ofSource.get(id)?.ours && !regBySource.has(id));
      if (adopt) {
        note({ key, file: rel, sourceId: adopt, sha256: sha, size: b.size, mtimeNs: b.mtimeNs.toString(), state: "in-library", at: new Date().toISOString() });
        setRec(rel, b, "in");
        dropProblem(rel);
        return;
      }
      if (flags & QUIET) {
        setRec(rel, b, "known");
        dropProblem(rel);
        return;
      }
    }
    current = { abs, b };
    let o: AttachOutcome | undefined;
    try {
      [o] = await attach.attachFiles(projectId, [abs], { ...(persist ? { origin: { watchId: watchId! } } : {}), ...(opts.collectionId ? { collectionId: opts.collectionId } : {}) });
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
      setRec(rel, b, o.outcome === "duplicate" ? "known" : "in");
      if (o.outcome !== "duplicate" && o.sourceId) note({ key, file: rel, sourceId: o.sourceId, sha256: sha, size: b.size, mtimeNs: b.mtimeNs.toString(), state: "in-library", at: new Date().toISOString() });
      if (o.noCollection && !noCollection) {
        noCollection = true;
        touch();
      }
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
  /**
   * Whether the file `rel` is no longer there (one `lstat`, through the gate) — or is the very file `now` (`r`) under
   * a name that differs only by case or normalisation (a file system that ignores both answers the old name).
   */
  async function goneFrom(rel: string, now: string, r: Reading): Promise<boolean> {
    try {
      const st = await g.lstat(absOf(rel));
      return rel !== now && foldedName(rel) === foldedName(now) && st.ino === r.ino;
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      return errCode(err) === "ENOENT";
    }
  }

  function pauseForLock() {
    if (locked) return;
    locked = true;
    libIdx = null;
    regReady = false;
    if (persist) {
      // Sealed content is not kept while the project is locked; it is read again after the unlock.
      reg = null;
      regBySha.clear();
      regBySource.clear();
    }
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
      if (regReady) {
        await libraryIndex(); // sources removed since (deleted, or an undo): their files are looked at again
        await checkCollection();
      }
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
        if (jobs.length > 0) {
          await jobs.shift()!();
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
        if (!regReady) {
          if (!(await loadRegister())) await idle(pollMs);
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
      if (persist && liveWatches.get(deps.repo)?.get(liveKey(projectId, watchId!)) === live) liveWatches.get(deps.repo)!.delete(liveKey(projectId, watchId!));
      for (const j of jobs.splice(0)) void j(); // each refuses: the watch has stopped
      wake();
      await closeWatcher();
      if (!inside) {
        await ready.catch(() => {});
        await loopDone.catch(() => {});
      }
      // The register lines noted and not yet written (if the library or project allows it now; otherwise the next
      // start finds the same again: adoption, the readings, the listing).
      if (persist) await flush().catch(() => {});
      emit({ kind: "stopped", ...(reason ? { reason } : {}) });
      send();
    })();
    return stopping;
  }

  // ---- the researcher's acts on this watch's files (bringInNewVersion, settleWatchedFile) -----------------------
  const jobs: Array<() => Promise<void>> = [];
  const io: FileIo = {
    get realRoot() {
      return realRoot;
    },
    stabilityMs: stability,
    lstat: (abs) => g.lstat(abs),
    judge,
    hash: hashOf,
    attach: async (abs, b, toSourceId) => {
      current = { abs, b };
      try {
        return (await attach.attachFiles(projectId, [abs], { toSourceId }))[0];
      } finally {
        current = null;
      }
    },
  };
  const live: LiveWatch = {
    exclusive: <T>(fn: (io: FileIo) => Promise<T>) =>
      new Promise<T>((resolveJob, rejectJob) => {
        if (gate.stuck) return rejectJob(new FolderNotAnsweringError()); // never queued behind a call that does not answer
        jobs.push(async () => {
          try {
            if (stopped) throw new FolderNotAnsweringError();
            await flush();
            resolveJob(await fn(io));
          } catch (err) {
            rejectJob(err);
          }
        });
        wake();
      }),
    flush: () => (persist ? flush() : Promise.resolve()),
    apply: (e) => {
      if (regReady) putEntry(e);
    },
  };
  if (persist) {
    let m = liveWatches.get(deps.repo);
    if (!m) liveWatches.set(deps.repo, (m = new Map()));
    m.set(liveKey(projectId, watchId!), live);
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
          if (watchDir(realRoot)) startWalk(entries); // files that arrived while nothing was watching
          else goUnreachable(WATCH_REASONS.watchFailed); // asked again at the next poll
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
// The researcher's acts on a registered file (Task W3; W7 puts routes on them).

/** A read-only library and a locked project are refused in plain words, before anything is read or written. */
function refuseUnwritable(deps: Pick<WatchDeps, "repo" | "lib">, projectId: string): void {
  if (isClosed(deps.lib) || deps.lib.mode !== "read-write") throw new ReadOnlyLibraryError(deps.lib.readOnlyReason);
  if (projectEncrypted(deps.repo, projectId) && !deps.repo.isUnlocked(projectId)) throw new ProjectLockedError(projectId);
}

/**
 * The folder's calls for one act when no watch of it runs here: its own one-call gate (a folder with a call that
 * did not answer is refused, A6), and attach's `readable` answering for the one file being read.
 */
async function standaloneIo(deps: WatchDeps, projectId: string, watchId: string): Promise<FileIo> {
  const dir = (await listWatchedFolders(deps, projectId)).find((w) => w.id === watchId)?.dir;
  if (!dir) throw new InvalidInputError("This watched folder has no folder chosen on this computer.");
  const root = resolve(dir);
  if (outstandingFolders.has(root)) throw new FolderNotAnsweringError();
  const fsx: WatchFs = { ...realFs, ...deps.fs };
  const presence = deps.presence ?? contentState;
  const gate = new FolderGate(deps.fsTimeoutMs ?? WATCH_FS_TIMEOUT_MS, () => {
    const settledAt = gate.afterSettle();
    outstandingFolders.set(root, settledAt);
    void settledAt.then(() => {
      if (outstandingFolders.get(root) === settledAt) outstandingFolders.delete(root);
    });
  });
  const realRoot = await gate.call(() => fsx.realpath(root));
  if (outstandingFolders.has(realRoot)) throw new FolderNotAnsweringError();
  let current: { abs: string; b: Reading } | null = null;
  const readable = async (p: string) => {
    if (!current || current.abs !== p) return false;
    try {
      const st = await gate.call(() => fsx.lstat(p));
      return st.isFile() && sameReading(current.b, readingOf(st));
    } catch {
      return false;
    }
  };
  const attach = createAttach({ repo: deps.repo, http: deps.http, proxies: deps.proxies ?? proxyQueueFor(deps.repo), readable, ...(deps.debug ? { debug: deps.debug } : {}) });
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  return {
    realRoot,
    stabilityMs: deps.stabilityMs ?? WATCH_STABILITY_MS,
    lstat: (abs) => gate.call(() => fsx.lstat(abs)),
    judge: (abs) => gatedJudge(gate, fsx, presence, abs),
    hash: (abs) => gatedHash(gate, fsx, abs, buf),
    attach: async (abs, b, toSourceId) => {
      current = { abs, b };
      try {
        return (await attach.attachFiles(projectId, [abs], { toSourceId }))[0];
      } finally {
        current = null;
      }
    },
  };
}

/** Runs one act: inside the running watch of the folder (its one call in flight, its lines written first), or on its own. */
async function act<T>(deps: WatchDeps, projectId: string, watchId: string, needsFolder: boolean, fn: (io: FileIo | null, apply: (e: WatchRegisterEntry) => void) => Promise<T>): Promise<T> {
  const live = liveWatches.get(deps.repo)?.get(liveKey(projectId, watchId));
  if (live) return live.exclusive((io) => fn(io, live.apply));
  return fn(needsFolder ? await standaloneIo(deps, projectId, watchId) : null, () => {});
}

async function registeredEntry(deps: WatchDeps, projectId: string, watchId: string, key: string, states: readonly WatchedFileState[], refusal: string): Promise<WatchRegisterEntry> {
  if (typeof key !== "string") throw new InvalidInputError("This file is not in the watched folder's register.");
  const e = (await deps.repo.watchRegister(projectId, watchId)).get(key);
  if (!e) throw new InvalidInputError("This file is not in the watched folder's register.");
  if (!states.includes(e.state)) throw new InvalidInputError(refusal);
  return e;
}

/**
 * "Bring in the new version as a new file of this source" (the researcher's act; W9). Needs the state "changed" or
 * "may-have-changed" AND a file that passes the whole order NOW — the name rule, stable (two `lstat`s
 * `stabilityMs` apart), `contentState` "local", the judged state equal to the stability reading — else
 * WatchFileNotLocalError and nothing is read. Then the hash (O_NOFOLLOW) and attach onto the same source (its
 * `readable` compares a fresh `lstat` before each open): a further original; the first is kept. The register
 * line "in-library" with the new content follows in the same act; a crash between the two is healed when the
 * watch next looks at the file (the source holds the folder's content: "in-library").
 */
export async function bringInNewVersion(deps: WatchDeps, projectId: string, watchId: string, key: string): Promise<AttachOutcome> {
  refuseUnwritable(deps, projectId);
  return act(deps, projectId, watchId, true, async (io, apply) => {
    const e = await registeredEntry(deps, projectId, watchId, key, ["changed", "may-have-changed"], "The file in the folder has not changed since it came in.");
    const f = io!;
    if (e.file.split("/").some((part) => nameRule(part) !== null)) throw new WatchFileNotLocalError();
    const abs = join(f.realRoot, ...e.file.split("/"));
    if (!within(f.realRoot, abs)) throw new WatchFileNotLocalError();
    const read = async (): Promise<Reading | null> => {
      try {
        const st = await f.lstat(abs);
        return st.isFile() ? readingOf(st) : null;
      } catch (err) {
        if (err instanceof FolderNotAnsweringError) throw err;
        return null;
      }
    };
    const a = await read();
    if (!a) throw new WatchFileNotLocalError();
    await new Promise((r) => setTimeout(r, f.stabilityMs));
    const b = await read();
    if (!b || !sameReading(a, b)) throw new WatchFileNotLocalError();
    const c = (await f.judge([abs])).get(abs);
    if (!c || c.presence !== "local" || !sameReading(b, c)) throw new WatchFileNotLocalError();
    // Checked: "local", exactly as the stability rule saw it; read at once (the window W2 describes, one file).
    let sha: string;
    try {
      sha = await f.hash(abs);
    } catch (err) {
      if (err instanceof FolderNotAnsweringError) throw err;
      throw new WatchFileNotLocalError();
    }
    const o = await f.attach(abs, b, e.sourceId);
    if (!o || (o.outcome === "failed" && o.reason === NOT_DOWNLOADED_REASON)) throw new WatchFileNotLocalError();
    if (o.outcome !== "attached" && o.outcome !== "duplicate") return o;
    const next: WatchRegisterEntry = { key: e.key, file: e.file, sourceId: e.sourceId, sha256: sha, size: b.size, mtimeNs: b.mtimeNs.toString(), state: "in-library", at: new Date().toISOString() };
    await deps.repo.recordWatchedFiles(projectId, watchId, [next]);
    apply(next);
    return o;
  });
}

/** "Keep the library's copy as it is" (the researcher's act; W9): a changed, may-have-changed or gone file is noted "settled". Nothing is read. */
export async function settleWatchedFile(deps: WatchDeps, projectId: string, watchId: string, key: string): Promise<void> {
  refuseUnwritable(deps, projectId);
  await act(deps, projectId, watchId, false, async (_io, apply) => {
    const e = await registeredEntry(deps, projectId, watchId, key, ["changed", "may-have-changed", "gone"], "There is nothing to settle for this file: it is as it came in.");
    const { renamedFrom: _r, ...rest } = e;
    const next: WatchRegisterEntry = { ...rest, state: "settled", at: new Date().toISOString() };
    await deps.repo.recordWatchedFiles(projectId, watchId, [next]);
    apply(next);
  });
}

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
