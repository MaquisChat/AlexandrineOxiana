/**
 * What the service holds while it runs: the one open library (its repo, key ring, index, the one
 * shared lookup HttpClient, Bulk Import, viewing-proxy and OCR queues, watched folders, running
 * batches), the media worker, the event bus and the daily backup scheduler (R96 carry-overs).
 * Everything that changes the library goes through `@ao/library`.
 */
import { resolve as resolvePath } from "node:path";
import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  HttpClient,
  IndexHandle,
  KeyRing,
  WorkerUnavailableError,
  backupFailure,
  backupIfDue,
  backupsAwaitingRemoval,
  dueLookUps,
  lookUpAgain,
  type LookUpAgainResult,
  oldCopiesAwaitingDeletion,
  oldCopiesBehindWarning,
  resumeDestruction,
  createBulkImport,
  createIndexSink,
  disposeOcrQueue,
  disposeProxyQueue,
  ocrQueueFor,
  openRepo,
  projectWarnings,
  proxyQueueFor,
  resumeZoteroWebImport,
  scrubPaths,
  startMediaWorker,
  startWatchedFolders,
  WatchedFoldersUnreadableError,
  type BackupFailure,
  type PendingRemoval,
  type BatchHandle,
  type BulkImport,
  type Deps,
  type FolderWatch,
  type BatchResult,
  type WatchDeps,
  type WatchStatus,
  type Library,
  type Repo,
  type ToolsUpdate,
  type WorkerClient,
  type WorkerEndpoint,
  type WorkerToolsClient,
  type CaptureOptions,
  JobInterruptedError,
  CaptureQueueRegistry,
  createLinkCapture,
  forgetLastOpenLibrary,
  lastOpenLibrary,
  listLibraries,
  indexIsPartial,
  openIndexChecked,
  openLibrary,
  rebuildIndexIfNeeded,
  rememberLastOpenLibrary,
  type RebuildResult,
  createFindRunner,
  DEFAULT_SEARCH_SETTINGS,
  type FindRunner,
  type IndexDb,
  // Task F12: "Search sources" — the settings file, the keys by host, the e-mail by host.
  getSecret,
  readSearchSettings,
  searchContactEmail,
  type SearchSettings,
  type SearchSettingsRead,
  writeQueueTurn,
} from "@ao/library";
import type { CaptureQueueProgressEvent, CaptureStartedBy, DestructionOldCopiesPending, DestructionOldCopiesState, DestructionOldCopy, DeviceNotice, FindProgressEvent, IncompleteRollback } from "@ao/shared";
import { DESTRUCTION_OLD_COPIES_PENDING_WARNING, oldCopiesPendingText } from "@ao/shared";
import { AppSettingUnreadableError, readDeviceNotices } from "@ao/library";

import { ApiError } from "./errors.js";
import { EventBus } from "./events.js";
import { MediaTickets } from "./media.js";
import { ZoteroSyncHolder } from "./routes/zotero-sync.js";
import { readFindScreen } from "./find-screen.js";
import { Transcriptions } from "./transcriptions.js";

/** A running media worker, shared by every library the service opens. */
export interface ServiceWorker {
  /** A client bound to `repo` (jobs recorded in its index). */
  clientFor(repo: Repo, index?: IndexHandle): WorkerClient;
  versions(): Promise<Record<string, string | null>>;
  updateTools(): Promise<ToolsUpdate>;
  /** The optional tools (Task 48a): absent in a worker that cannot install them. */
  tools?: WorkerToolsClient;
  stop(): Promise<void>;
}

export interface WorkerProvider {
  start(): Promise<ServiceWorker>;
}

/**
 * The worker client of an open library. It is given the index handle itself, not its current
 * connection, so that job rows reach the live database after a rebuild swaps it.
 */
export function workerClientFor(Client: typeof WorkerClient, worker: WorkerEndpoint, repo: Repo, index?: IndexHandle): WorkerClient {
  return new Client({ repo, worker, pollMs: 200, ...(index ? { index } : {}) });
}

/** The default worker: `AO_WORKER_BIN`, or the venv made by `pnpm setup:py`. */
export const defaultWorkerProvider = (onLog?: (line: string) => void): WorkerProvider => ({
  async start() {
    const mw = await startMediaWorker(onLog ? { onLog } : {});
    const { WorkerClient } = await import("@ao/library");
    return {
      clientFor: (repo, index) => workerClientFor(WorkerClient, mw.handle, repo, index),
      versions: () => mw.versions(),
      updateTools: () => mw.updateTools(),
      tools: mw.tools,
      stop: () => mw.stop(),
    };
  },
});

/** The session warning when this computer's watched folders could not be read at open (Rm4). */
export const WATCHED_FOLDERS_UNREADABLE = "watched-folders-unreadable";

export interface Session {
  lib: Library;
  repo: Repo;
  ring: KeyRing;
  /** Absent for a read-only library (nothing may write its index). */
  index: IndexHandle | undefined;
  /** The one lookup client of this library (R96: shared by attach, Bulk Import and watched folders). */
  http: HttpClient;
  /**
   * FR-749 (R546 2, 3): aborted the moment a close of this library begins (the close route, the close inside opening
   * or creating another library, the service's stop). An attach or a watched folder's bringing-in not yet in its store
   * turn is then cancelled; with it the lookup client is stopped (`beginClosing`).
   */
  closing: AbortController;
  bulk: BulkImport | undefined;
  watches: Map<string, FolderWatch[]>;
  /** Batches started (or resumed) by this service, by id. */
  batches: Map<string, { projectId: string; handle: BatchHandle }>;
  /** Old library folders awaiting deletion after a move, by confirm token. */
  moveTokens: Map<string, string>;
  workerClient: WorkerClient | undefined;
  unsubscribe: Array<() => void>;
  /** The index is being rebuilt, could not be rebuilt, or cannot be written (read-only); absent when it is ready (D8). */
  indexStatus?: IndexStatus;
  /** The rebuild running now (stopped when the library closes or moves). */
  indexRebuild?: { ac: AbortController; done: Promise<unknown> };
  /** While on, index writes record no change stamps: from the open until the staleness check has run (M6). */
  stampHold: { on: boolean };
  /**
   * Warnings for this session only, shown with the library's integrity warnings (Task 68 fix round 2,
   * Rm4): e.g. this computer's watched folders could not be read at open, so none run now.
   */
  sessionWarnings?: Array<{ kind: string; detail: string }>;
  /** FR-720: the start of the watches that did not start at open, under way after the list could be read again. */
  watchRestart?: Promise<void>;
  /** R508 M3: each project's start of its watches under way (the opening's or a restart's): one per project at a time. */
  watchStarting: Map<string, Promise<void>>;
  /** Find and acquire's runner (Task F5): one per open read-write library, made at `activate`; see "Find and acquire" below. */
  find?: FindRunner;
  /** The index errors already seen when the index was last known good (Task F5): a new one means it cannot be trusted. */
  findIndexErrors?: number;
}

/**
 * The state of the open library's index, as `index` in GET /libraries, the open's answer,
 * `library.state` and the source list (D8): absent when it is ready.
 */
export type IndexStatus =
  /**
   * `partial`: the index was missing or unreadable and no rebuild has completed since, so it holds
   * only what was written meanwhile: the list is not the library's content (C1); the interface shows
   * "being rebuilt" (or the failure) in its place, never a short list.
   */
  | { state: "rebuilding"; done: number; total: number; partial?: true }
  /** `message`: plain language, paths scrubbed. */
  | { state: "failed"; message: string; partial?: true }
  /** A read-only library: nothing may write its index, so sources are listed from the files. */
  | { state: "unavailable"; reason: string };

export interface StateOptions {
  deps: Deps;
  worker: WorkerProvider | null;
  autoStartWorker: boolean;
  now: () => Date;
  /** How often the backup scheduler checks for due backups (default 1 hour). */
  backupCheckMs: number;
  /** How often the automatic "Look up again" pass runs while a library is open (default LOOK_UP_AGAIN_CHECK_MS). */
  lookUpAgainCheckMs?: number;
  log: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void };
  watchStabilityMs?: number;
  /** How long an import may take to reach a safe point when paused (default SUSPEND_TIMEOUT_MS). */
  suspendTimeoutMs?: number;
  /** Opens a library (test seam; default the library's openLibrary). */
  openLibrary?: typeof openLibrary;
  /** How long a close waits for registered work before abandoning what can be (test seam; default CLOSE_GRACE_MS). */
  closeGraceMs?: number;
  /** Rebuilds the index when needed (test seam; default the library's rebuildIndexIfNeeded). */
  rebuildIndexIfNeeded?: typeof rebuildIndexIfNeeded;
  /** Test seam (a fake clock): starts the timer of GET /libraries' wait at start; returns its cancel. */
  startupTimer?: (fire: () => void, ms: number) => () => void;
  /** Test seam: the tick of the automatic Zotero sync's scheduler (Task Z10; default 60,000 ms). Not an environment variable. */
  zoteroTickMs?: number;
}

/**
 * Decision 31 (c), R566 (3): the automatic "Look up again" pass takes at most this many entries, one after another; the
 * next pass (the timer's, an unlock's, the next opening's) takes the rest.
 */
export const LOOK_UP_AGAIN_PASS_MAX = 20;
/** Decision 31 (c): the automatic pass's quiet timer while a library is open (ten minutes). */
export const LOOK_UP_AGAIN_CHECK_MS = 10 * 60_000;

/** How long GET /libraries waits, once, for the reopen at start (D5, I1). */
export const STARTUP_WAIT_MS = 30_000;

/**
 * A finished move whose old copy may still be deleted: its single-use token, for 15 minutes (R99),
 * or until the old copy is deleted; with the move's own warnings (scrubbed), so that a screen that
 * lost the move's stream shows them too (R379, I2).
 */
export interface PendingMove {
  oldRoot: string;
  newRoot: string;
  confirmToken: string;
  expiresAt: string;
  warnings: string[];
}
export const MOVE_TOKEN_TTL_MS = 15 * 60_000;
/**
 * The last move that stopped with an error, for the screen that lost its connection to it (R379):
 * kept for MOVE_TOKEN_TTL_MS or until a later move finishes or fails (a refused request without an
 * attempt of its own never erases it, R399 c). `attempt` is the screen's own id for the request, so
 * an earlier failure is never taken for this one; the message is scrubbed.
 */
export interface FailedMove {
  newRoot: string;
  attempt: string | null;
  error: { code: string; message: string; reason?: string };
  expiresAt: string;
}
/** How long a running batch may take to reach a safe point when it is paused for shutdown or a move. */
export const SUSPEND_TIMEOUT_MS = 60_000;

/** Lets registered background work stop between its items (R106). */
export interface WorkControl {
  stopping: boolean;
  /**
   * Set by work that can be abandoned part-way (Task 62, N-5): a close or shutdown calls it for
   * what is still running when its grace period ends; the work stops at once, writes nothing more
   * and leaves its job pending, to run again at the next open.
   */
  interrupt?: () => void;
  /** A rerun of pending jobs (`worker-resume`) whose job in hand is a transcription (R466 I1): a move stops it as it stops one. */
  transcribing?: boolean;
}

/** A transcription running now, whatever started it: one asked for here, or a rerun of a pending one (R466 I1). */
const isTranscribing = (w: { kind: string; ctl: WorkControl }): boolean => w.kind === "transcription" || (w.kind === "worker-resume" && w.ctl.transcribing === true);

/** How long a close waits for registered work before abandoning what can be (default; Task 62). */
export const CLOSE_GRACE_MS = 30_000;
/**
 * F12 (R297 b, R298 g): the longest any request waits for the password store's first answer about OpenAlex's key
 * (one read, shared by every caller, counted from when it started). Past it the request goes without the key.
 */
export const SEARCH_KEY_WAIT_MS = 1_500;
/** A password store that failed (or a read that never answered) is not asked again for this long. */
const SEARCH_STORE_RETRY_MS = 60_000;
/** Work a close or shutdown asks to stop between its items, and abandons after the grace period (N-5). */
const STOPPED_AT_CLOSE: ReadonlySet<string> = new Set(["worker-resume", "transcription"]);

export interface BackupRun {
  projectId: string;
  ok: boolean;
  backedUp: boolean;
  error?: string;
}

const actor = (): string => {
  try {
    return userInfo().username;
  } catch {
    return "researcher";
  }
};

export class ServiceState {
  session: Session | undefined;
  readonly events = new EventBus();
  /** Media tickets (R135): memory only; all end when the library closes or moves, or the service stops. */
  readonly media = new MediaTickets(() => this.opts.now().getTime());
  /** Transcriptions as jobs (Task 62): live state over the projects' job journals. */
  readonly transcriptions = new Transcriptions(this);
  /** Zotero account sync (Task Z8): the one run in progress, its abort and the back-off; stopped (with its record) before batches are suspended at a close or move. */
  readonly zoteroSync = new ZoteroSyncHolder();
  private worker: ServiceWorker | undefined;
  private workerStarting: Promise<ServiceWorker> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  private backupTimer: ReturnType<typeof setInterval> | undefined;
  /** Decision 31 (c): the automatic "Look up again" pass's timer (started in `activate`, stopped at close and quiesce). */
  private lookUpTimer: ReturnType<typeof setInterval> | undefined;
  /** The pass running now (one at a time), and whether another was asked for while it ran (an unlock, the timer). */
  private lookUpPass: Promise<void> | undefined;
  private lookUpPassAgain = false;
  /** Look-ups take turns: the automatic pass's entries and the researcher's act, one at a time per service. */
  private lookUpTurn: Promise<unknown> = Promise.resolve();
  /** Roots of libraries seen this run: paths inside them are shown library-relative in errors. */
  readonly roots = new Set<string>();
  readonly tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private move: PendingMove | undefined;
  private moveFailure: FailedMove | undefined;
  /** A library move is running: every change is refused (503 MOVE_IN_PROGRESS) (R102 N2). */
  moving = false;
  /**
   * R513 M1: the running move is still waiting for changes in flight or taking its plan, and has stopped nothing yet:
   * background work starts as at any other time (the stop that follows an accepted plan stops whatever runs then), so
   * that a move refused at its plan has skipped nothing — a media worker that became ready meanwhile resumes its pending
   * work at once, as it would without a move. From the plan's acceptance to the move's end no background work starts
   * (R102 N2, R106 C1).
   */
  planningMove = false;
  /** Background work waits for the move (see planningMove). */
  get startsHeld(): boolean {
    return this.moving && !this.planningMove;
  }
  /**
   * Move requests asked for (marked in the move route's own onRequest hook) and not yet ended or
   * refused: move/status says `running` from the earliest point of the request (R399 b).
   */
  movesAsked = 0;
  /** Shutdown has started: no library may be opened or adopted any more (R101 M7). */
  shuttingDown = false;

  /** Opens a library folder (honours the shutdown gate before and after the lock is taken). */
  async openLibrary(root: string): Promise<Library> {
    if (this.shuttingDown) throw new ApiError(503, "UNAVAILABLE", "The library service is shutting down.");
    const open = this.opts.openLibrary ?? openLibrary;
    return open(root, this.deps, { onLockLost: () => this.publishState() });
  }

  // ---- the work registry (R106 C1) -----------------------------------------------------

  private workSeq = 0;
  /** Background work running now: capture queues, profile captures, recheck jobs, retries, worker resumption, backups. */
  private readonly work = new Map<number, { kind: string; ctl: WorkControl; done: Promise<void> }>();
  /** Work stopped part-way for a move (or shutdown): continued only on its own library (by root, R108). */
  private stoppedWork: Array<{ root: string | undefined; cont: (s: Session) => void }> = [];
  /** Mutating requests in progress (set by the server; the move waits for them, R106 I1). */
  inFlightMutating: () => number = () => 0;
  /** After a move whose new copy could not be opened: what to resume once it is (R106). */
  private pendingResume: { root: string; batches: Array<{ projectId: string; batchId: string }> } | undefined;

  /**
   * Runs background work in the registry. `fn` checks `ctl.stopping` between its items; when it
   * stops early it returns how to continue (given the library open then), which runs after the
   * move. Work that cannot stop part-way simply finishes (it is drained).
   */
  /** Runs `fn` in the work registry; the promise settles (never rejects) when it has ended. */
  startWork(kind: string, fn: (ctl: WorkControl) => Promise<((s: Session) => void) | void>): Promise<void> {
    const id = ++this.workSeq;
    const ctl: WorkControl = { stopping: false };
    const root = this.session?.lib.root;
    const done = fn(ctl)
      .then(
        (cont) => {
          if (cont) this.stoppedWork.push({ root, cont });
        },
        (err: unknown) => this.opts.log.warn({ err: this.describe(err) }, `${kind} failed`),
      )
      .finally(() => this.work.delete(id));
    this.work.set(id, { kind, ctl, done });
    this.track(done, kind);
    return done;
  }

  /** Background work running now, by kind (diagnostics, tests). */
  workKinds(): string[] {
    return [...this.work.values()].map((w) => w.kind);
  }

  /** Asks every registered item (those `which` selects) to stop between items and waits for all to end; false if one did not in time. */
  async drainWork(timeoutMs: number, which: (w: { kind: string; ctl: WorkControl }) => boolean = () => true): Promise<boolean> {
    const items = [...this.work.values()].filter(which);
    for (const w of items) w.ctl.stopping = true;
    const all = Promise.allSettled(items.map((w) => w.done)).then(() => true);
    const ok = (await withTimeout(all, timeoutMs).catch(() => undefined)) === true;
    if (!ok) for (const w of items) w.ctl.stopping = false; // rolled back: the rest carries on
    return ok;
  }

  /**
   * After a move refused before anything was copied (FR-385): the transcriptions its quiesce stopped
   * stay pending in their journals; once they have ended here, they run again in the library still
   * open (not awaited by the refusal).
   */
  resumeStoppedTranscriptions(s: Session): void {
    const stopped = [...this.work.values()].filter(isTranscribing).map((w) => w.done);
    this.track(
      Promise.allSettled(stopped).then(() => {
        if (this.session === s && !this.startsHeld) this.resumeWorkerJobs(s);
      }),
      "resuming transcriptions after a refused move",
    );
  }

  /** Continues the work stopped for a move, when it belongs to the library open now (R108); the rest waits for its own. */
  restartStoppedWork(): void {
    const s = this.session;
    if (!s) return;
    const mine = this.stoppedWork.filter((w) => w.root === s.lib.root);
    this.stoppedWork = this.stoppedWork.filter((w) => w.root !== s.lib.root);
    for (const { cont } of mine) {
      try {
        cont(s);
      } catch (err) {
        this.opts.log.warn({ err: this.describe(err) }, "resuming stopped work failed");
      }
    }
  }

  /**
   * After a move from `fromRoot` to `root`: the work stopped for it now belongs to `root`, and what
   * was paused resumes when the library there is opened (now, or after a failed open).
   */
  resumeWhenOpened(root: string, batches: Array<{ projectId: string; batchId: string }>, fromRoot?: string): void {
    if (fromRoot !== undefined) for (const w of this.stoppedWork) if (w.root === fromRoot) w.root = root;
    this.pendingResume = { root, batches };
  }

  // ---- capture queues ----

  /** `lib`: the library the queue's current run belongs to (it changes when a move carries the queue on, 41a N4). */
  private readonly captures = new Map<string, { projectId: string; done: number; total: number; finished: boolean; lib?: object }>();
  /** Every capture queue and profile run this service started, readable again (Task 63; bounded: queues.ts). */
  private captureRegistry: CaptureQueueRegistry | undefined;
  get captureQueues(): CaptureQueueRegistry {
    return (this.captureRegistry ??= new CaptureQueueRegistry({ now: () => this.opts.now().getTime() }));
  }

  /** Queues and profile runs ended from outside whose run has not returned yet (queue id → project and why; no address). */
  private readonly endedCaptures = new Map<string, { projectId: string; why: "lock" | "close" }>();
  /** The abort signal of each running capture: aborted when it is ended, so its worker job is asked to stop (N5). */
  private readonly captureAborts = new Map<string, AbortController>();

  /** The signal a running capture passes to its downloads (one per queue or profile run). */
  captureSignal(queueId: string): AbortSignal {
    let c = this.captureAborts.get(queueId);
    if (!c) this.captureAborts.set(queueId, (c = new AbortController()));
    return c.signal;
  }
  /** Profile runs running now (queue id → project id). */
  private readonly profileRuns = new Map<string, string>();

  /**
   * Ends every running capture of `projectId` at once, as a fact (Task 63 fix round 2, I3): at its
   * lock, and for an encrypted project when its library closes or moves (R30, R50). Each running
   * queue or profile run is marked ended here, and its end is published here, once. From then on it
   * stores, records and publishes nothing, whatever the project's state is later. Its download in
   * flight is asked to stop (its signal is aborted: the worker client sends the worker's cancel, N5),
   * and whatever comes back is discarded. It keeps its
   * extension slot and holds the project's new captures off (409 CAPTURE_STOPPING) until its run has
   * really returned. The readable records of the project's queues are forgotten at once; the ended
   * queues keep only their progress counters (no address) until they return.
   */
  endCaptures(projectId: string, why: "lock" | "close"): void {
    const error = why === "lock" ? "ProjectLockedError: the project was locked, so the capture stopped" : "LibraryClosedError: the library was closed or moved, so the capture stopped";
    const end = (queueId: string) => {
      if (this.endedCaptures.has(queueId)) return; // ended already (a second lock)
      this.endedCaptures.set(queueId, { projectId, why });
      this.captureAborts.get(queueId)?.abort();
      this.events.publish("capture.progress", { queueId, projectId, finished: true, error } satisfies CaptureQueueProgressEvent);
    };
    let cut = 0;
    for (const [id, q] of this.captures) {
      if (q.projectId !== projectId) continue;
      if (q.finished) this.captures.delete(id);
      else {
        // The links not captured (the one in flight too: what it brings back is discarded), counted
        // from the queue's counters before it is ended; no address is read (R464 b).
        if (why === "lock" && !this.endedCaptures.has(id)) cut += Math.max(0, q.total - q.done);
        end(id);
      }
    }
    if (cut > 0) this.cutByLock.set(projectId, (this.cutByLock.get(projectId) ?? 0) + cut);
    for (const [id, pid] of this.profileRuns) if (pid === projectId) end(id);
    this.captureQueues.forgetProject(projectId);
  }

  /**
   * How many links a lock cut from each project's capture queues before they were captured (FR-370,
   * FR-371; R464 b): a COUNT only, never an address (an encrypted project's addresses leave memory at
   * its lock: R30, R50, R435), in memory only, until the desktop app's "Got it" or the service ends.
   * Told with the project's queues, which a locked project does not answer (423).
   */
  private readonly cutByLock = new Map<string, number>();

  /** The links a lock cut from `projectId`'s queues and not yet acknowledged, if any. */
  capturesCutByLock(projectId: string): number | undefined {
    return this.cutByLock.get(projectId);
  }

  /** The desktop app's "Got it": the count is forgotten. */
  acknowledgeCapturesCutByLock(projectId: string): void {
    this.cutByLock.delete(projectId);
  }

  /** Whether the queue or profile run was ended from outside (it then stores, records and publishes nothing). */
  captureEnded(queueId: string): boolean {
    return this.endedCaptures.has(queueId);
  }

  /** Why an ended capture of `projectId` is still finishing its current download (a lock, or a close or move), if one is. */
  captureStopping(projectId: string): "lock" | "close" | undefined {
    for (const e of this.endedCaptures.values()) if (e.projectId === projectId) return e.why;
    return undefined;
  }

  /** A profile run starts (its end is `profileRunEnded`). */
  profileRunStarted(queueId: string, projectId: string): void {
    this.profileRuns.set(queueId, projectId);
  }

  /** A profile run has returned: true when it had been ended from outside (then nothing of it is published). */
  profileRunEnded(queueId: string): boolean {
    this.profileRuns.delete(queueId);
    this.captureAborts.delete(queueId);
    return this.endedCaptures.delete(queueId);
  }

  /** The progress of a capture queue (also after a move). */
  captureQueue(queueId: string): { projectId: string; done: number; total: number; finished: boolean; lib?: object } | undefined {
    return this.captures.get(queueId);
  }

  /**
   * Captures `urls` one at a time in the registry: progress as `capture.progress`; a move stops it
   * between links and it continues with the rest on the moved library (R106 C1). With `after`, the
   * queue waits for that (another queue) to end before its first link (R116). The promise settles
   * when this run of the queue has ended. The queue is recorded (readable again) at once, before
   * anything is awaited.
   */
  startCaptureQueue(
    queueId: string,
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    at: { offset?: number; total?: number; after?: Promise<unknown>; startedBy?: CaptureStartedBy } = {},
  ): Promise<void> {
    // A queue ended while it was stopped for a move (an encrypted project's queue at the close): it
    // is not continued, and only now gives its extension slot back.
    if (this.endedCaptures.delete(queueId)) {
      this.captures.delete(queueId);
      this.captureAborts.delete(queueId);
      return Promise.resolve();
    }
    const offset = at.offset ?? 0;
    const total = at.total ?? urls.length;
    // Bounded as the readable queues are: a finished queue they have forgotten is forgotten here too.
    for (const [id, q] of this.captures) if (q.finished && !this.captureQueues.has(id)) this.captures.delete(id);
    const info = this.captures.get(queueId) ?? { projectId, done: offset, total, finished: false };
    if (this.session) info.lib = this.session.lib;
    this.captures.set(queueId, info);
    this.captureQueues.startLinks(queueId, projectId, urls, at.startedBy ?? "desktop");
    // Every way out but a continuation after a move marks the queue finished (41a I3): an unfinished
    // queue keeps an extension's links slot taken.
    const fail = (err: unknown) => {
      info.finished = true;
      this.captureAborts.delete(queueId);
      this.captureQueues.finish(queueId, { error: err });
      this.events.publish("capture.progress", { queueId, projectId, finished: true, error: this.describe(err) } satisfies CaptureQueueProgressEvent);
    };
    return this.startWork("capture", async (ctl) => {
      await at.after?.catch(() => {});
      let outcomes: Awaited<ReturnType<ReturnType<typeof createLinkCapture>["captureUrls"]>>;
      // Ended from outside (a lock, a close): decided then, whatever the project's state is later (I3).
      const ended = () => this.endedCaptures.has(queueId);
      /** The run has returned: an ended queue only now frees its slot and its project's new captures. */
      const release = () => {
        this.endedCaptures.delete(queueId);
        this.captures.delete(queueId);
        this.captureAborts.delete(queueId);
      };
      try {
        const s = this.requireSession();
        const worker = await this.workerClient();
        const capture = createLinkCapture({ repo: s.repo, worker, index: s.index });
        outcomes = await capture.captureUrls(
          projectId,
          urls,
          opts,
          (done, _t, outcome) => {
            if (ended()) return;
            info.done = offset + done;
            info.finished = info.done === total;
            this.captureQueues.progress(queueId, info.done, total, outcome);
            if (info.finished) this.captureQueues.finish(queueId, {});
            this.events.publish("capture.progress", { queueId, projectId, done: info.done, total, outcome, finished: info.finished } satisfies CaptureQueueProgressEvent);
          },
          { shouldStop: () => ctl.stopping, cancelled: ended, signal: this.captureSignal(queueId) },
        );
      } catch (err) {
        if (ended()) release();
        else fail(err);
        return;
      }
      if (ended()) {
        release();
        return;
      }
      if (outcomes.length < urls.length) {
        const rest = urls.slice(outcomes.length);
        const next = offset + outcomes.length;
        return () => void this.startCaptureQueue(queueId, projectId, rest, opts, { offset: next, total });
      }
      info.finished = true;
      this.captureAborts.delete(queueId);
      this.captureQueues.finish(queueId, {});
      return;
    });
  }

  /** 503 MOVE_IN_PROGRESS while a library move runs. */
  assertNotMoving(): void {
    if (this.moving) throw new ApiError(503, "MOVE_IN_PROGRESS", "The library is being moved. Try again when the move has finished.");
  }

  constructor(readonly opts: StateOptions) {}

  get deps(): Deps {
    return this.opts.deps;
  }

  /** The current library's shared lookup client. */
  get http(): HttpClient | undefined {
    return this.session?.http;
  }

  // ---- background work ----------------------------------------------------------------

  /** Runs `p` in the background; failures are logged (scrubbed), never thrown. */
  track<T>(p: Promise<T>, what = "background work"): void {
    const t = p.catch((err: unknown) => {
      this.opts.log.warn({ err: this.describe(err) }, `${what} failed`);
    });
    this.tasks.add(t);
    void t.finally(() => this.tasks.delete(t));
  }

  /** Waits until no background work is running (tests, shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const s = this.session;
      if (this.tasks.size === 0) {
        if (!s) return;
        await proxyQueueFor(s.repo).idle();
        await ocrQueueFor(s.repo).idle();
        if (this.tasks.size === 0) return;
      }
      await Promise.allSettled([...this.tasks]);
    }
  }

  describe(err: unknown): string {
    return scrubPaths(err instanceof Error ? `${err.name}: ${err.message}` : String(err), this.roots);
  }

  // ---- the open library --------------------------------------------------------------

  requireSession(): Session {
    const s = this.session;
    if (!s) throw new ApiError(503, "LIBRARY_OFFLINE", "No library is open.");
    if (s.lib.mode === "read-only" && s.lib.readOnlyReason === "offline") throw new ApiError(503, "LIBRARY_OFFLINE", "The library's folder is not reachable.", "offline");
    return s;
  }

  /** The session, refusing a read-only library with 409 READ_ONLY (reason: why it is read-only). */
  requireWritable(): Session & { index: IndexHandle; bulk: BulkImport } {
    this.assertNotMoving();
    const s = this.requireSession();
    if (s.lib.mode === "read-only" || !s.index || !s.bulk) {
      throw new ApiError(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.", s.lib.readOnlyReason ?? "read-only");
    }
    return s as Session & { index: IndexHandle; bulk: BulkImport };
  }

  /**
   * Makes `lib` the open library (closing any other first) and remembers it for the next start
   * (D5). A read-write library's index is checked: missing or unreadable, it is rebuilt from the
   * files in the background, as is a stale one (D8); `newLibrary` skips that (nothing to index).
   */
  async adopt(lib: Library, opts: { newLibrary?: boolean; stillWanted?: () => boolean } = {}): Promise<Session> {
    const unwanted = async (): Promise<never> => {
      // The reopen at start was superseded (I1): released at once, never replacing the open library.
      await lib.close().catch(() => {});
      throw new Error("superseded");
    };
    if (opts.stillWanted && !opts.stillWanted()) return unwanted();
    if (this.shuttingDown) {
      // Opened while the service was stopping: released at once, never adopted (R101 M7).
      await lib.close().catch(() => {});
      throw new ApiError(503, "UNAVAILABLE", "The library service is shutting down.");
    }
    if (this.session && this.session.lib !== lib) await this.closeLibrary();
    this.roots.add(lib.root);
    const ring = new KeyRing();
    let index: IndexHandle | undefined;
    let repo: Repo;
    let needsRebuild = false;
    let partial = false;
    // Held until the staleness check has run (a new library has nothing to check).
    const stampHold = { on: !opts.newLibrary };
    try {
      if (lib.mode === "read-write") {
        const checked = await openIndexChecked(lib.root, this.opts.now, opts.newLibrary ? { newLibrary: true } : {});
        index = checked.handle;
        needsRebuild = checked.needsRebuild !== undefined;
        partial = checked.partial;
        for (const w of checked.warnings) this.opts.log.warn({ warning: w }, "index");
      }
      repo = await openRepo(lib, ring, {
        actor: actor(),
        tz: this.tz,
        // The service's clock (Task 49): the destruction retry's back-off and the audit log use the same time.
        clock: this.opts.now,
        ...(index ? { index: createIndexSink(index, { root: lib.root, keyRing: ring }, { holdStamps: () => stampHold.on }) } : {}),
      });
    } catch (err) {
      index?.close();
      await lib.close().catch(() => {});
      throw err;
    }
    const s: Session = {
      lib,
      repo,
      ring,
      index,
      // F12 (R290 a, e): OpenAlex's key and Crossref's e-mail by the request's host, from "Search sources".
      http: new HttpClient({
        libraryRoot: lib.root,
        keyFor: (h) => this.searchKeyForHost(h),
        keyReady: (h) => this.searchKeyReady(h),
        contactEmailFor: (h) => this.searchEmailForHost(h),
      }),
      closing: new AbortController(),
      bulk: undefined,
      watches: new Map(),
      watchStarting: new Map(),
      batches: new Map(),
      moveTokens: new Map(),
      workerClient: undefined,
      unsubscribe: [],
      stampHold,
    };
    if (!index) s.indexStatus = { state: "unavailable", reason: lib.readOnlyReason ?? "read-only" };
    // Never shown as an empty library while the index is rebuilt (D8).
    else if (needsRebuild) s.indexStatus = { state: "rebuilding", done: 0, total: 0, ...(partial ? { partial: true as const } : {}) };
    if (opts.stillWanted && !opts.stillWanted()) {
      index?.close();
      return unwanted();
    }
    this.session = s;
    this.notFound = undefined;
    this.activate(s);
    if (index && !opts.newLibrary) this.startIndexRebuild(s, needsRebuild);
    await rememberLastOpenLibrary(lib.id, this.deps).catch((err: unknown) => this.opts.log.warn({ err: this.describe(err) }, "remembering the open library"));
    return s;
  }

  // ---- the index (D8) --------------------------------------------------------------------

  /**
   * Rebuilds the open library's index when `force` is set or it no longer matches the files: the
   * state says `rebuilding` while it runs (progress as `job.progress` kind "index"), then ready, or
   * `failed` with a plain reason (also sent as `job.progress` with ok:false). Resolves with the
   * result (undefined when the index was current); rejects when it failed. One at a time: while one
   * runs, a second is refused (409).
   */
  async rebuildIndex(s: Session, force: boolean): Promise<RebuildResult | undefined> {
    const index = s.index;
    if (!index || s.lib.mode !== "read-write") throw new ApiError(409, "READ_ONLY", "This library is open read-only, so its index cannot be rebuilt.", s.lib.readOnlyReason ?? "read-only");
    if (s.indexRebuild) throw new ApiError(409, "CONFLICT", "The library's index is already being rebuilt.");
    const ac = new AbortController();
    const rebuild = this.opts.rebuildIndexIfNeeded ?? rebuildIndexIfNeeded;
    const live = () => this.session === s && !ac.signal.aborted;
    // Whether the live index holds only part of the library (its mark says so until a rebuild completes).
    const partialOf = (): { partial?: true } => (index.isOpen && indexIsPartial(index.db) ? { partial: true } : {});
    const run = (async () => {
      try {
        const r = await rebuild(index, s.ring, s.lib, {
          force,
          signal: ac.signal,
          // Decided (and marked when stale): writes may record their stamps again (M6).
          onChecked: () => {
            s.stampHold.on = false;
          },
          onStart: () => {
            if (!live()) return;
            s.indexStatus = { state: "rebuilding", done: 0, total: 0, ...partialOf() };
            this.publishState();
          },
          onProgress: (done, total) => {
            if (!live()) return;
            s.indexStatus = { state: "rebuilding", done, total, ...partialOf() };
            this.events.publish("job.progress", { kind: "index", done, total });
          },
        });
        if (live()) {
          const wasShown = s.indexStatus !== undefined;
          s.indexStatus = undefined;
          if (r?.errors.length) this.opts.log.warn({ errors: r.errors.length }, "index rebuild: some folders could not be read");
          if (wasShown || r) this.publishState();
          s.findIndexErrors = this.findIndexErrorCount(s);
        }
        return r;
      } catch (err) {
        if (live()) {
          const message = `The library's search index could not be rebuilt (${scrubPaths(err instanceof Error ? err.message : String(err), this.roots)}). Your sources are safe in the library folder; try "Rebuild library from folder" again.`;
          s.indexStatus = { state: "failed", message, ...partialOf() };
          this.events.publish("job.progress", { kind: "index", ok: false, error: message });
          this.publishState();
        }
        throw err;
      } finally {
        if (s.indexRebuild?.ac === ac) s.indexRebuild = undefined;
      }
    })();
    s.indexRebuild = { ac, done: run.catch(() => {}) };
    return run;
  }

  /** `rebuildIndex` in the background (work registry); a failure is in the state, never thrown. */
  startIndexRebuild(s: Session, force: boolean): void {
    if (s.indexRebuild) {
      // One already runs: a forced one follows it.
      if (force) void this.startWork("index", async () => {
        await s.indexRebuild?.done;
        if (this.session === s && !s.indexRebuild) await this.rebuildIndex(s, true).catch(() => {});
      });
      return;
    }
    void this.startWork("index", async () => {
      await this.rebuildIndex(s, force).catch(() => {});
    });
  }

  /** Stops a running rebuild between sources (the old index stays) and waits for it to end. */
  async stopIndexRebuild(s: Session): Promise<void> {
    const r = s.indexRebuild;
    if (!r) return;
    r.ac.abort();
    await r.done;
  }

  // ---- the library open when the service last ran (D5, I1) -------------------------------

  /** The remembered library could not be opened at start: named for the "Library not found" screen. */
  notFound: { libraryId: string; name: string } | undefined;
  /** The remembered library is still being opened (the attempt at start has not ended): named for the interface. */
  reopening: { libraryId: string; name: string } | undefined;
  /** Settles when the reopen at start has ended. */
  startup: Promise<void> = Promise.resolve();
  /** The one attempt at start; `superseded` once the researcher opens, creates or closes a library. */
  private reopenAttempt: { superseded: boolean } | undefined;
  /** GET /libraries' one wait for the attempt (shared by every request that comes during it). */
  private startupWait: Promise<void> | undefined;

  /**
   * At start: reopens the library open when the service last ran, at its last known place, as one
   * tracked attempt (I1). While it runs, `reopening` names it. A folder that is gone, unreadable or
   * holds another library leaves it closed and named in `notFound`. Once the attempt is superseded
   * (the researcher opened, created or closed a library: `supersedeReopen`) or the service is
   * stopping, its late result is dropped: what it opened is closed again and its lock released, and
   * it never replaces the library open now. Never throws.
   */
  reopenLast(): Promise<void> {
    const attempt = { superseded: false };
    this.reopenAttempt = attempt;
    this.startupWait = undefined; // a new attempt: GET /libraries may wait for it once
    const dropped = () => attempt.superseded || this.shuttingDown;
    this.startup = (async () => {
      try {
        const id = await lastOpenLibrary(this.deps);
        if (!id || this.session || dropped()) return;
        const entry = (await listLibraries(this.deps).catch(() => [])).find((e) => e.libraryId === id);
        if (!entry || dropped()) return; // not known any more: the chooser
        this.reopening = { libraryId: entry.libraryId, name: entry.name };
        const at = entry.lastKnownPaths[0];
        try {
          if (!at) throw new Error("no known location");
          const lib = await this.openLibrary(at);
          if (dropped()) {
            await lib.close().catch(() => {});
            return;
          }
          if (lib.id !== id) {
            await lib.close().catch(() => {});
            throw new Error("another library is at the remembered place");
          }
          this.roots.add(lib.root);
          await this.adopt(lib, { stillWanted: () => !dropped() });
        } catch (err) {
          if (dropped()) return; // superseded meanwhile: nothing to report
          this.notFound = { libraryId: entry.libraryId, name: entry.name };
          this.opts.log.warn({ err: this.describe(err) }, "the last open library could not be reopened");
        }
      } finally {
        if (this.reopenAttempt === attempt) {
          this.reopenAttempt = undefined;
          this.reopening = undefined;
        }
      }
    })().catch((err: unknown) => this.opts.log.warn({ err: this.describe(err) }, "reopening the last library"));
    return this.startup;
  }

  /** The researcher chose (opened, created or closed a library): the reopen at start no longer applies (I1). */
  supersedeReopen(): void {
    if (!this.reopenAttempt) return;
    this.reopenAttempt.superseded = true;
    this.reopenAttempt = undefined;
    this.reopening = undefined;
  }

  /**
   * For GET /libraries: waits for the reopen at start, once and for at most STARTUP_WAIT_MS (a network
   * drive that does not answer). Requests during that wait share it; afterwards it resolves at once,
   * and the answer names the library still being opened (`reopening`).
   */
  waitForStartup(): Promise<void> {
    if (!this.startupWait) {
      const setTimer =
        this.opts.startupTimer ??
        ((fire: () => void, ms: number) => {
          const t = setTimeout(fire, ms);
          return () => clearTimeout(t);
        });
      let cancel = () => {};
      const deadline = new Promise<void>((r) => (cancel = setTimer(r, STARTUP_WAIT_MS)));
      this.startupWait = Promise.race([this.startup, deadline]).finally(() => cancel());
    }
    return this.startupWait;
  }

  /** The researcher closed the library: the next start shows the chooser (D5). */
  async forgetOpenLibrary(): Promise<void> {
    this.notFound = undefined;
    await forgetLastOpenLibrary(this.deps).catch((err: unknown) => this.opts.log.warn({ err: this.describe(err) }, "forgetting the open library"));
  }

  /**
   * Starts the open library's background work: Bulk Import with the library's queues (job events
   * subscribed), the worker attached (pending work resumed), watched folders, a backup check and the
   * daily scheduler. Run at open, and again after a move that failed after `quiesce`.
   */
  activate(s: Session): void {
    for (const u of s.unsubscribe.splice(0)) u();
    const proxies = proxyQueueFor(s.repo);
    const ocr = ocrQueueFor(s.repo);
    s.bulk = s.index
      ? createBulkImport({
          repo: s.repo,
          http: s.http,
          index: s.index,
          proxies,
          queueOcr: async (p, ids) => {
            // Awaited by the batch: one governed change per group, recorded before the batch moves on (R106).
            await ocr.enqueueMany(p, ids);
          },
          debug: this.importLog,
        }) : undefined;
    s.unsubscribe.push(proxies.onResult((r) => this.events.publish("job.progress", { kind: "proxy", ...r })));
    s.unsubscribe.push(ocr.onResult((r) => this.events.publish("job.progress", { kind: "ocr", ...r })));
    if (s.lib.mode === "read-write") {
      void this.startProjectsWatches(
        s,
        s.repo.listProjects().map((p) => p.id),
      );
      // A backup that came due while the app was closed is made now (R99 I7).
      this.startWork("backup", async () => {
        await this.runScheduledBackups();
      });
      // Decision 31 (c): the entries whose left-out lookups came due while the app was closed are looked up again now,
      // in the background (the opening's answer does not wait for it).
      this.startLookUpAgain();
    }
    s.http.setDiskCache(true); // in use again (after a move that was not made)
    this.startFind(s);
    if (this.worker) this.attachWorker(s, this.worker);
    else if (this.opts.autoStartWorker && this.opts.worker) this.track(this.ensureWorker(), "starting the media helper");
    this.startBackupScheduler();
    this.startLookUpAgainTimer();
    // Automatic Zotero syncs (Task Z10): the first no sooner than 2 minutes from now; read-write only. Stopped (awaited)
    // before the sync's holder at close, switch, quiesce and shutdown, and started again here after a move or a reopen.
    this.zoteroSync.startScheduler(this, s);
    this.publishState();
    // Opened at last after a move whose first open failed: what was paused for it resumes (R106).
    if (this.pendingResume && this.pendingResume.root === s.lib.root && s.lib.mode === "read-write") {
      const { batches } = this.pendingResume;
      this.pendingResume = undefined;
      this.resumeBatches(batches);
      this.restartStoppedWork();
    }
  }

  /** Receives each watched folder's status (set by routes/watched-folders.ts, which coalesces and publishes it; Task W7). */
  onWatchStatus?: (s: Session, projectId: string, st: WatchStatus) => void;

  /** What every watched folder of the open library is started with (its status included, R99, W7). */
  watchDeps(s: Session, projectId: string): WatchDeps & { onWarning: (w: string) => void } {
    return {
      repo: s.repo,
      http: s.http,
      lib: s.lib,
      closing: s.closing.signal,
      proxies: proxyQueueFor(s.repo),
      ...(this.opts.watchStabilityMs !== undefined ? { stabilityMs: this.opts.watchStabilityMs, pollMs: Math.max(50, this.opts.watchStabilityMs) } : {}),
      // Task W7: per-file events are no longer published; the folder's status is, as `watch.status` (routes/watched-folders.ts).
      onStatus: (st) => this.onWatchStatus?.(s, projectId, st),
      onWarning: (w) => this.opts.log.warn({ warning: scrubPaths(w, this.roots) }, "watched folders"),
    };
  }

  /**
   * Starts the watched folders of these projects, each tracked as background work: at the library's opening (every
   * project), and again for those that did not start then once this computer's list can be read (FR-720). True when
   * every one started. A project whose start is still under way is not started beside it: that start is waited for and
   * counts as this one (R508 M3), so a folder never gets two watches.
   */
  async startProjectsWatches(s: Session, projectIds: string[]): Promise<boolean> {
    const runs = projectIds.map((id) => {
      const under = s.watchStarting.get(id);
      if (under) return under;
      const run: Promise<void> = this.startWatches(s, id).finally(() => {
        if (s.watchStarting.get(id) === run) s.watchStarting.delete(id);
      });
      s.watchStarting.set(id, run);
      this.track(run, "watched folders");
      return run;
    });
    return (await Promise.allSettled(runs)).every((r) => r.status === "fulfilled");
  }

  /**
   * FR-720: this computer's list of watched folders was read successfully (the list route). When it could not be read
   * at the opening, the watches that did not start then are started the opening's way, and once every one has, the
   * warning that they were not started is taken away; a start that fails again leaves it. One at a time.
   *
   * R508 I1: never while a move or the service's stop is under way (nothing may write into a library being copied, R102
   * N2; the move has stopped every watch), and only in a read-write library, as at the opening; the warning then stays and
   * the next successful read afterwards starts them in the library open then. A locked project's list is refused before
   * this is reached (423); a locked project's watch is started as the opening starts it, and waits until the unlock.
   */
  async watchedFoldersReadAgain(s: Session): Promise<void> {
    if (this.moving || this.shuttingDown) return;
    if (this.session !== s || s.lib.mode !== "read-write" || !s.sessionWarnings?.some((w) => w.kind === WATCHED_FOLDERS_UNREADABLE)) return;
    if (s.watchRestart) return s.watchRestart;
    const run = (async () => {
      const ids = s.repo.listProjects().map((p) => p.id).filter((id) => !s.watches.has(id));
      // A move or the stop that began meanwhile has stopped (or will stop) these watches: the warning stays (R515 N1).
      if (!(await this.startProjectsWatches(s, ids)) || this.session !== s || this.moving || this.shuttingDown) return;
      s.sessionWarnings = (s.sessionWarnings ?? []).filter((w) => w.kind !== WATCHED_FOLDERS_UNREADABLE);
      this.publishState();
    })().finally(() => {
      if (s.watchRestart === run) s.watchRestart = undefined;
    });
    s.watchRestart = run;
    return run;
  }

  /** Starts the project's watched folders (all of them; replaces any running). */
  async startWatches(s: Session, projectId: string): Promise<void> {
    await this.stopWatches(s, projectId);
    let watches: FolderWatch[];
    try {
      watches = await startWatchedFolders(this.watchDeps(s, projectId), projectId);
    } catch (err) {
      // Never silent (R154; Task 68 round 2, Rm4): said on screen for this session, once.
      if (err instanceof WatchedFoldersUnreadableError && this.session === s) {
        s.sessionWarnings ??= [];
        if (!s.sessionWarnings.some((w) => w.kind === WATCHED_FOLDERS_UNREADABLE)) {
          s.sessionWarnings.push({ kind: WATCHED_FOLDERS_UNREADABLE, detail: err.message });
          this.publishState();
        }
      }
      throw err;
    }
    if (this.session !== s) {
      await Promise.all(watches.map((w) => w.stop()));
      return;
    }
    s.watches.set(projectId, [...(s.watches.get(projectId) ?? []), ...watches]);
  }

  /**
   * Stops the project's watches, or every watch of the library. For the whole library (a move, a close), every start of
   * watches still under way (`watchStarting`: the opening's or a restart's) is waited for first, so that none ends after
   * this stop and leaves a watch running (R515 N1); the wait is bounded by the time the service gives background work to
   * reach a safe point (`suspendTimeoutMs`). A start still under way after it stays in `watchStarting` (the move refuses).
   */
  async stopWatches(s: Session, projectId?: string): Promise<void> {
    if (projectId === undefined && s.watchStarting.size) {
      await withTimeout(Promise.allSettled([...s.watchStarting.values()]), this.opts.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS).catch(() => {});
    }
    const ids = projectId ? [projectId] : [...s.watches.keys()];
    await Promise.allSettled(ids.flatMap((id) => s.watches.get(id) ?? []).map((w) => w.stop()));
    for (const id of ids) s.watches.delete(id);
  }

  // ---- import batches ------------------------------------------------------------------

  /** R436 e: handles whose run has settled (each stays in `s.batches` until followBatch's end has run). */
  private readonly settledHandles = new WeakSet<BatchHandle>();

  /** R436 e: whether this handle's run has settled (it is then not running, though still kept for a moment). */
  batchSettled(h: BatchHandle): boolean {
    return this.settledHandles.has(h);
  }

  /** Follows a running batch: progress and its end as `import.progress`; it leaves the registry when it ends (R99 I3). */
  followBatch(s: Session, projectId: string, h: BatchHandle): void {
    const settled = () => void this.settledHandles.add(h);
    h.done.then(settled, settled);
    s.batches.set(h.batchId, { projectId, handle: h });
    this.track(
      (async () => {
        try {
          // R392: `total` only when the source told one (never a guess).
          for await (const p of h.progress) this.events.publish("import.progress", { batchId: h.batchId, projectId, state: "running", done: p.done, ...(p.total !== undefined ? { total: p.total } : {}) });
          const r = await h.done;
          this.events.publish("import.progress", { batchId: h.batchId, projectId, state: r.state, counts: r.counts });
        } catch (err) {
          this.events.publish("import.progress", { batchId: h.batchId, projectId, state: "failed", error: this.describe(err) });
        } finally {
          if (s.batches.get(h.batchId)?.handle === h) s.batches.delete(h.batchId);
          if (this.session === s) this.publishState();
        }
      })(),
      "import",
    );
  }

  /**
   * Pauses every running batch at its next safe point and leaves it `paused` on disk (R99 I4/I5).
   * Returns the batches paused and those that did not reach a safe point in time (still running).
   */
  async suspendBatches(s: Session): Promise<{
    paused: Array<{ projectId: string; batchId: string }>;
    stuck: Array<{ projectId: string; batchId: string; handle: BatchHandle; pending: Promise<BatchResult | undefined> }>;
  }> {
    const running = [...s.batches.entries()].map(([batchId, b]) => ({ batchId, ...b }));
    const ms = this.opts.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS;
    const results = await Promise.all(
      running.map(async (b) => {
        const pending = b.handle.suspend().catch(() => undefined as BatchResult | undefined);
        return { b: { ...b, pending }, r: await withTimeout(pending, ms).catch(() => undefined) };
      }),
    );
    return {
      paused: results.filter((x) => x.r?.state === "paused").map((x) => ({ projectId: x.b.projectId, batchId: x.b.batchId })),
      stuck: results.filter((x) => x.r === undefined && s.batches.get(x.b.batchId)?.handle === x.b.handle).map((x) => x.b),
    };
  }

  // ---- library move --------------------------------------------------------------------

  /**
   * Before a library move (R99 I5): running batches paused (refused if one cannot be), watches
   * stopped, viewing-proxy and OCR queues disposed of and the backup scheduler stopped, so nothing
   * writes to the library while it is copied. Returns the batches to resume afterwards.
   */
  async quiesce(s: Session): Promise<Array<{ projectId: string; batchId: string }>> {
    // A ticket never outlives the library where it was issued (R135 2): ended as the move starts.
    this.media.revokeAll();
    // An index rebuild stops between sources (the library at its new place checks its index again).
    await this.stopIndexRebuild(s);
    await this.zoteroSync.stopScheduler();
    await this.zoteroSync.stop("library-closed");
    const ms = this.opts.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS;
    // Background work first: captures and rechecks stop between items, the rest finishes (R106 C1).
    // A running transcription is not waited for here: it is stopped below, once nothing else refuses the move.
    if (!(await this.drainWork(ms, (w) => !isTranscribing(w)))) {
      this.zoteroSync.startScheduler(this, s);
      this.restartStoppedWork();
      throw new ApiError(409, "CONFLICT", "Some background work could not be paused in time, so the library was not moved; try again in a moment.");
    }
    const { paused, stuck } = await this.suspendBatches(s);
    if (stuck.length) {
      // Refused: everything paused for it carries on (R102 N3). A suspend that lands late is counted:
      // it is awaited (a while longer) and that batch resumed; one that never lands is withdrawn.
      const late = await Promise.all(stuck.map(async (b) => ({ b, r: await withTimeout(b.pending, ms).catch(() => undefined) })));
      for (const { b, r } of late) {
        if (r?.state === "paused") paused.push({ projectId: b.projectId, batchId: b.batchId });
        else {
          try {
            b.handle.resume();
          } catch {
            // already ended
          }
        }
      }
      this.resumeBatches(paused);
      this.zoteroSync.startScheduler(this, s);
      this.restartStoppedWork();
      throw new ApiError(409, "CONFLICT", "An import could not be paused in time, so the library was not moved; try again in a moment.");
    }
    // The move goes ahead: every transcription running in the library is stopped at once, as at a close
    // (N-5), whatever started it (FR-385; R466 I1, M1) — one asked for here, or a rerun of a pending one
    // (after an unlock, a launch, or a move that carried it on). It stays pending in its project's journal;
    // a write already under way finishes first (the worker client's guarded write). Then it is waited for.
    for (const w of this.work.values()) if (isTranscribing(w)) w.ctl.interrupt?.();
    if (!(await this.drainWork(ms))) {
      this.resumeBatches(paused);
      this.zoteroSync.startScheduler(this, s);
      this.restartStoppedWork();
      throw new ApiError(409, "CONFLICT", "Some background work could not be paused in time, so the library was not moved; try again in a moment.");
    }
    try {
      this.stopBackupScheduler();
      this.stopLookUpAgainTimer();
      await this.stopWatches(s);
      // A start of watches that did not end in time could still leave a watch running during the copy: refused (R515 N1).
      if (s.watchStarting.size) throw new ApiError(409, "CONFLICT", "Some background work could not be paused in time, so the library was not moved; try again in a moment.");
      await disposeProxyQueue(s.repo);
      await disposeOcrQueue(s.repo);
      // Last, so that a rollback above leaves the queue running (R247 M6); `stopAll` always settles, never throws.
      await this.endFind(s);
      // Nothing is written into the folder being copied, the lookup cache included (R247 c).
      s.http.setDiskCache(false);
    } catch (err) {
      this.activate(s);
      this.resumeBatches(paused);
      this.restartStoppedWork();
      throw err;
    }
    return paused;
  }

  /**
   * After a move (or a failed one): the batches paused for it are resumed in the library now open.
   * Each resume is in the work registry (R108), so a move's quiesce waits until the batch runs (and
   * can be paused) instead of missing it.
   */
  resumeBatches(list: Array<{ projectId: string; batchId: string }>): void {
    const s = this.session;
    const bulk = s?.bulk;
    const index = s?.index;
    // Bulk Import exists only with an index (activate), so a Web batch never falls back to the generic resume (M10).
    if (!s || !bulk || !index) return;
    for (const b of list) {
      if (!s.repo.listProjects().some((p) => p.id === b.projectId)) continue;
      this.startWork("resume-import", async () => {
        // A Zotero Web batch finishes as every Web resume does: it records the library version (Z2, A5).
        const listed = (await bulk.listBatches(b.projectId)).find((x) => x.batchId === b.batchId);
        const kind = listed?.kind;
        // R252: its Zotero library claimed in this same step; taken (or the batch is a sync's own), it stays paused.
        const release = listed?.ref ? (listed.origin === "zotero-sync" ? undefined : this.zoteroSync.claim(listed.ref, s)) : () => {};
        if (!release) return;
        const h = await (kind === "zotero-web"
          ? resumeZoteroWebImport({ repo: s.repo, http: s.http, index, proxies: proxyQueueFor(s.repo) }, b.projectId, b.batchId)
          : bulk.resumeBatch(b.projectId, b.batchId)
        ).catch((err: unknown) => (release(), Promise.reject(err)));
        void h.done.then(release, release);
        this.followBatch(s, b.projectId, h);
      });
    }
  }

  recordMove(m: Omit<PendingMove, "expiresAt">): PendingMove {
    this.move = { ...m, expiresAt: new Date(this.opts.now().getTime() + MOVE_TOKEN_TTL_MS).toISOString() };
    return this.move;
  }

  /** The finished move whose old copy may still be deleted, while its token is valid. */
  pendingMove(): PendingMove | undefined {
    if (this.move && Date.parse(this.move.expiresAt) <= this.opts.now().getTime()) this.move = undefined;
    return this.move;
  }

  forgetMove(): void {
    this.move = undefined;
  }

  recordMoveFailure(m: Omit<FailedMove, "expiresAt">): void {
    this.moveFailure = { ...m, expiresAt: new Date(this.opts.now().getTime() + MOVE_TOKEN_TTL_MS).toISOString() };
  }

  /** The last move that stopped with an error, while it is kept (R379). */
  failedMove(): FailedMove | undefined {
    if (this.moveFailure && Date.parse(this.moveFailure.expiresAt) <= this.opts.now().getTime()) this.moveFailure = undefined;
    return this.moveFailure;
  }

  forgetMoveFailure(): void {
    this.moveFailure = undefined;
  }

  /** Closes the open library: running batches cancelled, watches stopped, queues disposed of, lock released. */
  /**
   * Closes the open library. Every request that opens, creates, reconnects or closes a library calls
   * this first, so it is also where the reopen at start is superseded (I1).
   */
  async closeLibrary(): Promise<void> {
    this.supersedeReopen();
    // Media tickets end with the library (R135 2), and so do their streams.
    this.media.revokeAll();
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    // An encrypted project's capture queues go with its key (R30, R50); a plain project's stay readable.
    for (const p of s.repo.listProjects()) if (p.encryption.enabled) this.endCaptures(p.id, "close");
    // Find and acquire stops for good, awaited (bounded): its own work and the researcher's acts already in their store
    // turn end first, and any act still waiting for its turn is refused by the runner (R245). So none of its writes
    // lands after the lock is released. Then the lookup client sends nothing more (FR-749, R546): see beginClosing.
    await this.beginClosing(s);
    this.stopBackupScheduler();
    this.stopLookUpAgainTimer();
    // N-5: the rerun of interrupted jobs starts no further job, and a transcription is asked to stop
    // too; what is still running when the grace period ends is abandoned below.
    const stoppable = [...this.work.values()].filter((w) => STOPPED_AT_CLOSE.has(w.kind));
    for (const w of stoppable) w.ctl.stopping = true;
    // A live transcription is resumable: abandoned at once rather than after the grace period (M7).
    for (const w of stoppable) if (w.kind === "transcription") w.ctl.interrupt?.();
    await this.stopIndexRebuild(s);
    // A Zotero sync stops first, with its record, its batch suspended (Task Z8): nothing of it is written after the lock goes.
    // Its scheduler before it (Task Z10): no automatic run can start once the holder has stopped.
    await this.zoteroSync.stopScheduler();
    await this.zoteroSync.stop(this.shuttingDown ? "app-closed" : "library-closed");
    // Running imports are paused (resumable), never cancelled (R99 I4); one that cannot reach a safe
    // point in time is cancelled instead (state `cancelled`, still resumable) before the lock goes (R102 N3).
    const { stuck } = await this.suspendBatches(s).catch(() => ({ paused: [], stuck: [...s.batches.entries()].map(([batchId, b]) => ({ batchId, ...b })) }));
    for (const b of stuck) {
      try {
        b.handle.cancel();
      } catch {
        // already ended
      }
    }
    await Promise.allSettled(stuck.map((b) => withTimeout(b.handle.done, this.opts.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS)));
    await this.stopWatches(s);
    for (const u of s.unsubscribe) u();
    await disposeProxyQueue(s.repo).catch(() => {});
    await disposeOcrQueue(s.repo).catch(() => {});
    await withTimeout(Promise.allSettled([...this.tasks]), this.opts.closeGraceMs ?? CLOSE_GRACE_MS).catch(() => {});
    // Abandoned now (they stay pending in their journals and run again at the next open) ...
    const left = [...this.work.values()].filter((w) => STOPPED_AT_CLOSE.has(w.kind));
    for (const w of left) w.ctl.interrupt?.();
    await withTimeout(Promise.allSettled(left.map((w) => w.done)), 5_000).catch(() => {});
    // ... and whatever has not ended writes nothing more: no journal line after the lock is released.
    await s.workerClient?.close?.().catch(() => {});
    this.transcriptions.forget(s.lib);
    s.http.purgeSensitive();
    // No late lookup answer writes into this library once its lock is released (R247 c).
    s.http.setDiskCache(false);
    // The engine's close waits for the change in its store turn (and a backup in flight) before the lock goes (R247 d);
    // that change still needs its project's key and updates the index, so both go only after it (R551 M7) — the index
    // before the lock is released (its file is in the library, R247 c), the keys once it is.
    await s.lib
      .close({
        beforeRelease: () => {
          try {
            s.index?.close();
          } catch {
            // already closed
          }
        },
      })
      .catch(() => {});
    s.ring.clear();
    this.publishState();
  }

  // ---- Find and acquire (Task F5; R237, A3) ---------------------------------------------
  //
  // One runner per open read-write library, made at `activate`. `resume(projectId)` for each unlocked project at open
  // and at unlock, whatever the index's state (R247 a): while the index is not ready the runner itself starts no entry
  // and makes no record, and goes on by itself once it is; `stop(projectId)` at an encrypted project's lock, before
  // its key is dropped (routes/projects.ts);
  // `stopAll()` awaited (it is bounded) at close, at a library switch (both `closeLibrary`), before a move and at
  // quiesce (R106, `quiesce`), so that no write of the runner lands after the library's lock is released.

  /** "Check everything I have", as remembered on this computer (`find-screen.json`): read at open, set by PUT /find/screen. */
  findCheckEverything = false;

  /**
   * Task F15 (R328 f): when the last hand-over through the library was (ms; -Infinity: none). Kept by the service, in
   * memory only, so that the pause outlives a library's close and reopening; given to each runner.
   */
  private libraryHandOverAt = Number.NEGATIVE_INFINITY;

  // ---- "Search sources" (Task F12; R290) ---------------------------------------------------
  //
  // The settings file is read anew for each entry and each GET; the copy kept here (`searchSettingsNow`) is what the
  // lookup client's per-host e-mail follows between reads. Keys are read from the password store when needed and then
  // held in memory only; a PUT or DELETE of the secret replaces what is held at once (no restart). A key is never
  // logged, put in an error, an event, an audit line or a settings file.
  //   - OpenAlex's key belongs to OpenAlex (R297 b), not to Find's switches: when one is saved it goes with every
  //     request the app makes to api.openalex.org, imports included. It is read lazily, when the first such request
  //     is about to be made (the client's `keyReady`): ONE read in flight, shared by every caller, and no request
  //     waits for it beyond SEARCH_KEY_WAIT_MS from its start (R298 g); past that, or when the store fails, the
  //     request goes without the key and the store is not asked again for a minute. An entry never waits or fails
  //     because of it (the runner's settings step does not read it).
  //   - Elicit's key is read only when the runner asks for it (Elicit on, allowed, about to be asked), or for a Test.

  /** The "Search sources" settings as last read or saved. */
  searchSettingsNow: SearchSettings = { record: DEFAULT_SEARCH_SETTINGS.record.map((x) => ({ ...x })), copies: (DEFAULT_SEARCH_SETTINGS.copies ?? []).map((x) => ({ ...x })) };
  /** Keys read from the password store (null: none stored); a name absent has not been read yet. Memory only. */
  private readonly searchKeys = new Map<"elicit-api-key" | "openalex-api-key", string | null>();
  /** Bumped by every PUT or DELETE of a key: a read that started before it does not overwrite what it set. */
  private readonly searchKeyGen = new Map<string, number>();
  /** When the password store last failed to answer for a key (it is not asked again for a minute). */
  private readonly searchStoreFailedAt = new Map<string, number>();
  /** The read of a key in flight (one per key, shared by every caller), and when it started. */
  private readonly searchKeyReads = new Map<string, { read: Promise<string | undefined>; startedAt: number }>();

  /** Reads the settings file anew (never throws: an unreadable file gives the defaults and says so). */
  async readSearchSources(): Promise<SearchSettingsRead> {
    const r = await readSearchSettings(this.deps.appConfigDir);
    this.searchSettingsNow = r.settings;
    return r;
  }

  /** After a save: what the client follows from now on (no key is read here: OpenAlex's is read lazily). */
  searchSourcesSaved(s: SearchSettings): void {
    this.searchSettingsNow = s;
  }

  /**
   * A key, read from the password store once and then held (undefined when none is stored or the store cannot be
   * read). One read in flight per key, shared by every caller; a store that fails, or a read that has not answered in
   * a minute, is not asked again for a minute.
   */
  searchKey(name: "elicit-api-key" | "openalex-api-key"): Promise<string | undefined> {
    if (this.searchKeys.has(name)) return Promise.resolve(this.searchKeys.get(name) ?? undefined);
    const now = Date.now();
    if ((this.searchStoreFailedAt.get(name) ?? -Infinity) > now - SEARCH_STORE_RETRY_MS) return Promise.resolve(undefined);
    const inFlight = this.searchKeyReads.get(name);
    if (inFlight && inFlight.startedAt > now - SEARCH_STORE_RETRY_MS) return inFlight.read;
    const gen = this.searchKeyGen.get(name) ?? 0;
    const entry = { read: Promise.resolve<string | undefined>(undefined), startedAt: now };
    entry.read = (async () => {
      let v: string | null;
      try {
        v = await getSecret(name);
      } catch {
        // No password store (or a locked one): nothing held; asked again after a minute, or at once after a PUT.
        this.searchStoreFailedAt.set(name, Date.now());
        return undefined;
      } finally {
        if (this.searchKeyReads.get(name) === entry) this.searchKeyReads.delete(name);
      }
      if ((this.searchKeyGen.get(name) ?? 0) === gen) this.searchKeys.set(name, v);
      return v ?? undefined;
    })();
    // Set before anything of the read has run past its first await (its own `finally` clears it).
    this.searchKeyReads.set(name, entry);
    return entry.read;
  }

  /**
   * A key within the bound (R298 g, R304 a, b): what is held, or else the one shared read (started or joined), waited
   * for at most until SEARCH_KEY_WAIT_MS after that read began — the same bound for both keys, so a hung store delays
   * only the first caller of its minute. `unreadable` when the store failed or did not answer in that time (nothing is
   * held then); `key` undefined and `unreadable` false: none is saved. Never rejects.
   */
  async searchKeyWithin(name: "elicit-api-key" | "openalex-api-key"): Promise<{ key?: string; unreadable: boolean }> {
    const held = (): { key?: string; unreadable: boolean } => {
      const v = this.searchKeys.get(name);
      return { ...(v ? { key: v } : {}), unreadable: false };
    };
    if (this.searchKeys.has(name)) return held();
    const read = this.searchKey(name);
    const inFlight = this.searchKeyReads.get(name);
    if (inFlight) {
      const left = inFlight.startedAt + SEARCH_KEY_WAIT_MS - Date.now();
      if (left > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([read.then(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, left)))]);
        } finally {
          clearTimeout(timer);
        }
      }
    } else {
      await read;
    }
    return this.searchKeys.has(name) ? held() : { unreadable: true };
  }

  /**
   * The lookup client's wait before a request to `host` (R297 b, R298 g): for api.openalex.org, `searchKeyWithin` its
   * key (a request then goes with what is held, or without). Nothing for any other host.
   */
  async searchKeyReady(host: string): Promise<void> {
    if (host !== "api.openalex.org") return;
    await this.searchKeyWithin("openalex-api-key");
  }

  /** A key saved (`value`) or removed (null) through the secrets routes: used by the next request. */
  searchKeyChanged(name: "elicit-api-key" | "openalex-api-key", value: string | null): void {
    this.searchKeyGen.set(name, (this.searchKeyGen.get(name) ?? 0) + 1);
    this.searchStoreFailedAt.delete(name);
    this.searchKeys.set(name, value);
  }

  /**
   * The lookup client's key for a host: OpenAlex's for api.openalex.org, whatever Find's switches say (R297 b);
   * nothing for any other host. Only what is held: the read is `searchKeyReady`'s.
   */
  searchKeyForHost(host: string): string | undefined {
    if (host !== "api.openalex.org") return undefined;
    return this.searchKeys.get("openalex-api-key") ?? undefined;
  }

  /** The lookup client's contact e-mail for a host: Crossref's, to api.crossref.org only. */
  searchEmailForHost(host: string): string | undefined {
    return searchContactEmail(this.searchSettingsNow, host);
  }

  private findIndexErrorCount(s: Session): number {
    // A compaction's note is not an index error (the queue store leaves its notes there too).
    return s.repo.indexErrors.filter((e) => e.op !== "project.find.compact").length;
  }

  /**
   * Whether the index can be trusted for Find and acquire's duplicate check: open, its check after the open has run,
   * no rebuild running or failed, and no change that could not be indexed since it was last known good.
   */
  findIndexReady(s: Session): boolean {
    return this.findIndexState(s) === "ready";
  }

  /**
   * The index as Find and acquire sees it (R247 b): "rebuilding" while a rebuild (or the check after an open) really
   * runs; "needs-rebuild" when it cannot be trusted and nothing runs: a change could not be indexed since it was last
   * known good, or a rebuild failed. The index errors carry no project (`repo.indexErrors` holds an operation and an
   * error only), so they are counted for the whole library.
   */
  findIndexState(s: Session): "ready" | "rebuilding" | "needs-rebuild" {
    if (this.session !== s || !s.index || !s.index.isOpen) return "needs-rebuild";
    if (s.stampHold.on || s.indexRebuild || s.indexStatus?.state === "rebuilding") return "rebuilding";
    if (s.indexStatus !== undefined || this.findIndexErrorCount(s) > (s.findIndexErrors ?? 0)) return "needs-rebuild";
    return "ready";
  }

  /** Makes the open library's runner (once) and resumes what may run now. */
  private startFind(s: Session): void {
    if (s.lib.mode !== "read-write" || !s.index || s.find) return;
    void readFindScreen(this.deps.appConfigDir).then((v) => {
      if (this.session === s) this.findCheckEverything = v.checkEverything;
    });
    // F12: the e-mail by host follows "Search sources" from the open on (imports' lookups included). OpenAlex's key is
    // read lazily, by the first request to api.openalex.org (R297 b).
    void this.readSearchSources();
    const handle = s.index;
    // Always the index's live connection: a rebuild swaps it.
    const index = new Proxy({} as IndexDb, {
      get: (_t, k) => {
        const db = handle.db;
        const v: unknown = Reflect.get(db, k, db);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v;
      },
    });
    s.findIndexErrors = this.findIndexErrorCount(s);
    s.find = createFindRunner({
      repo: s.repo,
      index,
      http: s.http,
      // Task F12: "Search sources", read anew when each entry's work starts (a save takes effect for the next entry).
      // No key is read here (R298 g): OpenAlex's is read lazily by its first request, within its own short bound.
      settings: async () => (await this.readSearchSources()).settings,
      // Asked by the runner only when Elicit is on and the project's rules allow it.
      // Read as OpenAlex's is (R304 b): one shared read, bounded from its start; unreadable → the entry goes on without Elicit.
      elicitKey: async () => (await this.searchKeyWithin("elicit-api-key")).key,
      checkEverything: () => this.findCheckEverything,
      onChange: (e) => {
        if (this.session === s) this.events.publish("find.progress", { projectId: e.projectId, entryId: e.entryId, state: e.state } satisfies FindProgressEvent);
      },
      indexReady: () => this.findIndexReady(s),
      // F15 (R328 f): the pause after a hand-over is the service's, not the runner's.
      libraryHandOver: {
        get: () => this.libraryHandOverAt,
        set: (at) => {
          this.libraryHandOverAt = at;
        },
      },
      // Error kinds only (never what was typed, never an error's text: the runner's promise).
      debug: (note) => this.opts.log.info({ note }, "find and acquire"),
    });
    this.resumeFind(s);
  }

  /**
   * R393 b: the import's debug sink. Only the engine's own notes ("bulk import …": an unexpected error's kind, code and
   * the program's stack frames, built without the error's message) are logged; other notes that reach the sink (a
   * lookup's error text) are not, since they may hold a title or an address.
   */
  readonly importLog = (note: string): void => {
    if (note.startsWith("bulk import")) this.opts.log.warn({ note }, "import");
  };

  /**
   * Resumes the queue of every unlocked project (or of `projectId`), whatever the index's state (R247 a). R534 c: the
   * opening's pass over the resting entries is background work `idle()` waits for (a lock or a close ends it).
   */
  resumeFind(s: Session, projectId?: string): void {
    const r = s.find;
    if (!r || this.startsHeld) return;
    for (const p of s.repo.listProjects()) if ((projectId === undefined || p.id === projectId) && s.repo.isUnlocked(p.id)) this.track(r.resume(p.id), "find's opening");
  }

  /**
   * R312 c (R297 c): an OpenAlex key was saved — in every unlocked project of the open library, the entries waiting for
   * OpenAlex's spent allowance go on now (the runner's `wakeAllowance`: only those; nothing in flight is aborted).
   */
  wakeFindAllowance(): void {
    const s = this.session;
    const r = s?.find;
    if (!s || !r || this.startsHeld) return;
    for (const p of s.repo.listProjects()) if (s.repo.isUnlocked(p.id)) void r.wakeAllowance(p.id);
  }

  /**
   * R326: the researcher's "Search sources" were saved — in every unlocked project of the open library, the entries
   * resting "switched off" by the settings go on if the settings now allow it (the runner's `wakeSettings`: only those;
   * nothing in flight is touched). The save does not wait for it.
   */
  wakeFindSettings(): void {
    const s = this.session;
    const r = s?.find;
    if (!s || !r || this.startsHeld) return;
    for (const p of s.repo.listProjects()) if (s.repo.isUnlocked(p.id)) void r.wakeSettings(p.id);
  }

  /** At an encrypted project's lock, before its key is dropped: nothing more is written for it until `resumeFind`. */
  stopFind(s: Session, projectId: string): void {
    s.find?.stop(projectId);
  }

  /** Stops the runner for good and waits for it (bounded: FIND_STOP_SETTLE_MS); `activate` makes a new one. */
  /**
   * FR-749 (R546 2, 3; R247 c): the start of every close of the library, and of the service's stop. At once, the session's
   * closing signal: an attach or a watched folder's bringing-in that has written nothing yet is cancelled (its lookup's
   * waits cut short; nothing of it is written), and none of their changes begins; a change in its store turn finishes.
   * Then Find and acquire stops (its runner lets go of its own lookups and records nothing of them), and the session's
   * lookup client is stopped: it sends nothing more, for any caller (Bulk Import, Find, whatever holds it). Idempotent.
   */
  async beginClosing(s: Session): Promise<void> {
    s.closing.abort();
    await this.endFind(s);
    s.http.stop();
  }

  private async endFind(s: Session): Promise<void> {
    const r = s.find;
    s.find = undefined;
    await r?.stopAll();
  }

  // ---- the media worker --------------------------------------------------------------

  /** The media worker, started on first need; when it becomes ready, pending work resumes (R96). */
  async ensureWorker(): Promise<ServiceWorker> {
    if (this.worker) return this.worker;
    if (!this.opts.worker) throw new WorkerUnavailableError("the media helper is not available in this service");
    this.workerStarting ??= this.opts.worker.start().then(
      (w) => {
        this.worker = w;
        this.workerStarting = undefined;
        if (this.session) this.attachWorker(this.session, w);
        return w;
      },
      (err: unknown) => {
        this.workerStarting = undefined;
        throw new WorkerUnavailableError(err instanceof Error ? err.message : String(err));
      },
    );
    return this.workerStarting;
  }

  /** The worker client of the open library (starting the worker if needed). */
  async workerClient(): Promise<WorkerClient> {
    const s = this.requireSession();
    await this.ensureWorker();
    if (!s.workerClient) throw new WorkerUnavailableError("the media helper is not ready");
    return s.workerClient;
  }

  /** Worker ready for this library: queues get it, and interrupted jobs and pending proxies / OCR resume. */
  private attachWorker(s: Session, w: ServiceWorker): void {
    const client = w.clientFor(s.repo, s.index);
    s.workerClient = client;
    proxyQueueFor(s.repo).setWorker(client);
    ocrQueueFor(s.repo).setWorker(client);
    // Once a move is stopping work for itself nothing is resumed: the library open after it resumes (R106 C1, R513 M1).
    if (s.lib.mode !== "read-write" || this.startsHeld) return;
    this.resumeWorkerJobs(s);
    for (const p of s.repo.listProjects()) if (s.repo.isUnlocked(p.id)) this.resumeProject(s, p.id);
  }

  /**
   * Resubmits the worker jobs left pending (all projects at launch; one project at its unlock,
   * including jobs a lock cancelled before they started, R142), as registered work (R106 C1): a
   * move or close waits for it, it stops between jobs when asked and continues on the library open
   * afterwards, and nothing starts during a move. The journal claim keeps each rerun to one run.
   */
  resumeWorkerJobs(s: Session, projectId?: string): void {
    const client = s.workerClient;
    if (!client || s.lib.mode !== "read-write" || this.startsHeld) return;
    void this.startWork("worker-resume", async (ctl) => {
      // A close abandons the job in hand once its grace period ends (N-5): it stays pending.
      const ac = new AbortController();
      let interrupted = false;
      ctl.interrupt = () => {
        interrupted = true;
        ac.abort(new JobInterruptedError());
      };
      await client.resumePending(projectId, {
        shouldStop: () => ctl.stopping,
        signal: ac.signal,
        // A pending transcription runs again with its finish step and is followed like a new one (Task 62).
        prepare: (rec) => {
          ctl.transcribing = rec.kind === "audio.transcribe"; // the job in hand (R466 I1)
          return this.transcriptions.rerun(s, rec);
        },
      });
      // Stopped between jobs: carried on in the library open next. Abandoned part-way (a close, a move: R466 I1):
      // not carried on from here, since the library open next reruns every pending job when its worker is
      // attached (or, after a refused move, resumeStoppedTranscriptions does), and two reruns at once would race.
      if (ctl.stopping && !interrupted) return (next: Session) => this.resumeWorkerJobs(next, projectId);
    });
  }

  /**
   * Resumes a project's pending viewing proxies and OCR (at open / worker ready / unlock); at an
   * unlock (`workerJobs`) also its pending worker jobs.
   */
  resumeProject(s: Session, projectId: string, opts: { workerJobs?: boolean } = {}): void {
    if (!s.workerClient || s.lib.mode !== "read-write" || this.startsHeld) return;
    this.track(proxyQueueFor(s.repo).resumePending(projectId), "resuming viewing proxies");
    this.track(ocrQueueFor(s.repo).resumePending(projectId), "resuming OCR");
    if (opts.workerJobs) this.resumeWorkerJobs(s, projectId);
  }

  // ---- state for the UI ----------------------------------------------------------------

  /** `library.state` (also part of GET /libraries/integrity): mode, integrity and project warnings. */
  libraryState(): Record<string, unknown> {
    const s = this.session;
    if (!s) return { open: false };
    const names = new Map(s.repo.listProjects().map((p) => [p.id, p.name]));
    return {
      open: true,
      libraryId: s.lib.id,
      name: s.lib.name,
      mode: s.lib.mode,
      ...(s.lib.readOnlyReason ? { readOnlyReason: s.lib.readOnlyReason } : {}),
      ...(s.lib.lockedBy ? { lockedBy: s.lib.lockedBy } : {}),
      ...(s.indexStatus ? { index: s.indexStatus } : {}),
      integrityWarnings: this.integrityWarnings(s, names),
      projectWarnings: this.cachedProjectWarnings,
      // Why a project shows `backup-failed` (R125: a refusal gives the engine's reason), path-scrubbed.
      backupFailures: this.cachedBackupFailures,
      // What stands behind `destruction-backups-pending` (R147): which backups still wait to be
      // removed after a destruction, and why the app does not remove them by itself when it does not.
      destructionBackupsPending: this.cachedPendingRemovals,
      // What stands behind `destruction-old-copies-pending` (R379, R409 d): the sentence that fits, for
      // each destruction the old copies still holding its files (by the time of the move), and each
      // old copy with its place from this computer's list — for the researcher's own screen only:
      // the place is never written into the library, a certificate, an audit entry or an export.
      destructionOldCopiesPending: this.cachedOldCopies,
      // This computer's own notices (Task 68, R154, R178): kind and time only; shown in the banner area.
      notices: this.cachedNotices,
    };
  }

  private cachedNotices: DeviceNotice[] = [];

  /** This computer's notices as last read (refreshNotices). */
  get notices(): DeviceNotice[] {
    return this.cachedNotices;
  }
  private noticesUnreadableLogged = false;

  /**
   * Reads this computer's device-level notices again (Task 68). A notices file that cannot be read
   * shows none, and the log says so once, in plain words without a path; nothing is written.
   */
  async refreshNotices(): Promise<void> {
    try {
      this.cachedNotices = await readDeviceNotices(this.deps.appConfigDir);
      this.noticesUnreadableLogged = false;
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError)) throw err;
      this.cachedNotices = [];
      if (!this.noticesUnreadableLogged) this.opts.log.warn({}, "The app's list of notices on this computer could not be read, so none are shown.");
      this.noticesUnreadableLogged = true;
    }
  }

  private cachedProjectWarnings: Record<string, string[]> = {};
  private cachedBackupFailures: Record<string, BackupFailure> = {};
  private cachedPendingRemovals: Record<string, PendingRemoval[]> = {};
  private cachedOldCopies: Record<string, DestructionOldCopiesState> = {};

  /**
   * What the researcher's screen is told of the old copies behind `destruction-old-copies-pending`
   * (R409 d): each by the date of its move, its place when this computer's list knows it, and
   * whether the app can still delete it (its offer is open AND this service holds its token).
   */
  private async oldCopiesState(s: Session, projectId: string): Promise<DestructionOldCopiesState> {
    const behind = await oldCopiesBehindWarning(s.repo, projectId).catch(() => ({ destructions: [] as DestructionOldCopiesPending[], unchecked: true, oldCopies: [] }));
    const move = this.pendingMove();
    const oldCopies: DestructionOldCopy[] = behind.oldCopies.map((c) => ({
      ...(c.movedOn ? { movedOn: c.movedOn } : {}),
      ...(c.place ? { place: c.place } : {}),
      canDelete: !!c.place && c.offerOpen && !!move && resolvePath(move.oldRoot) === c.place,
    }));
    const unchecked = behind.unchecked;
    return { message: oldCopiesPendingText({ oldCopies, ...(unchecked ? { unchecked: true } : {}) }), destructions: behind.destructions, oldCopies, ...(unchecked ? { unchecked: true as const } : {}) };
  }

  /** The open library's way into its write queue, for a check that confirms a finding there (FR-420, R469 b). */
  writeQueueTurn(s: Session): <T>(fn: () => Promise<T>) => Promise<T> {
    return writeQueueTurn(s.repo);
  }

  integrityWarnings(
    s: Session,
    names = new Map(s.repo.listProjects().map((p) => [p.id, p.name])),
  ): Array<{ projectId: string; project: string; kind: string; detail: string; state?: IncompleteRollback; keptId?: string }> {
    return [
      ...s.repo.integrityWarnings.map((w) => ({
        projectId: w.projectId,
        project: w.projectId === "*" ? "library" : (names.get(w.projectId) ?? "a project"),
        kind: w.kind,
        detail: scrubPaths(w.detail, this.roots),
        // FR-736: an undo not complete says its state (never its paths here: those are for the list only, R503 d).
        ...(w.rollback ? { state: w.rollback } : {}),
        // FR-729: kept with the library until dismissed (POST /libraries/recovery-warnings/:id/dismiss).
        ...(w.keptId ? { keptId: w.keptId } : {}),
      })),
      ...(s.sessionWarnings ?? []).map((w) => ({ projectId: "*", project: "library", kind: w.kind, detail: scrubPaths(w.detail, this.roots) })),
    ];
  }

  /** The projects' standing warnings (backup failed, deletion records unreadable), by project id. */
  async projectWarnings(s: Session): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    const failures: Record<string, BackupFailure> = {};
    const waiting: Record<string, PendingRemoval[]> = {};
    const copies: Record<string, DestructionOldCopiesState> = {};
    for (const p of s.repo.listProjects()) {
      out[p.id] = await projectWarnings(s.repo, p.id).catch(() => []);
      const f = out[p.id]!.includes("backup-failed") ? await backupFailure(s.repo, p.id).catch(() => undefined) : undefined;
      if (f) failures[p.id] = { ...f, reason: scrubPaths(f.reason, this.roots) };
      const w = out[p.id]!.includes("destruction-backups-pending") ? await this.pendingRemovals(s, p.id) : [];
      if (w.length) waiting[p.id] = w;
      if (out[p.id]!.includes(DESTRUCTION_OLD_COPIES_PENDING_WARNING)) {
        copies[p.id] = await this.oldCopiesState(s, p.id);
      }
    }
    this.cachedProjectWarnings = out;
    this.cachedBackupFailures = failures;
    this.cachedPendingRemovals = waiting;
    this.cachedOldCopies = copies;
    return out;
  }

  /** Which backups still wait to be removed after a destruction in the project, and why (R147), as the interface is told: path-scrubbed. */
  private async pendingRemovals(s: Session, projectId: string): Promise<PendingRemoval[]> {
    const w = await backupsAwaitingRemoval(s.repo, projectId).catch((): PendingRemoval[] => []);
    return w.map((x) => (x.reason ? { ...x, reason: scrubPaths(x.reason, this.roots) } : x));
  }

  /** Recomputes the project warnings, then sends `library.state`. */
  publishState(): void {
    const s = this.session;
    if (!s) {
      this.cachedProjectWarnings = {};
      this.cachedBackupFailures = {};
      this.cachedPendingRemovals = {};
      this.cachedOldCopies = {};
      this.events.publish("library.state", this.libraryState());
      return;
    }
    this.track(
      Promise.all([this.projectWarnings(s), this.refreshNotices()]).then(() => {
        if (this.session === s) this.events.publish("library.state", this.libraryState());
      }),
      "library state",
    );
  }

  // ---- daily backups (R90 b, R96) --------------------------------------------------------

  /** One pass of the backup scheduler: every project whose automatic backup is due is backed up. */
  async runScheduledBackups(onlyProjectId?: string): Promise<BackupRun[]> {
    const s = this.session;
    if (!s || s.lib.mode !== "read-write" || this.startsHeld || this.shuttingDown) return [];
    const out: BackupRun[] = [];
    let retried = false;
    for (const p of s.repo.listProjects()) {
      if (onlyProjectId && p.id !== onlyProjectId) continue;
      // A destruction whose backups could not all be removed is retried on every pass (R138 e, N1):
      // at open, at unlock and hourly, until the audit log records every listed backup as gone
      // (R147). Never for a locked project: nothing of it can be read or recorded.
      if (s.repo.isUnlocked(p.id)) {
        const worked = await resumeDestruction(s.repo, p.id).catch((err: unknown) => {
          this.opts.log.warn({ err: this.describe(err) }, "resuming a destruction failed");
          return ["failed"];
        });
        // A pass that only observes (the files and the audit log disagree) tries nothing, yet may
        // change what stands behind the warning: the interface is told whenever that is no longer
        // what it was last told.
        if (worked.length || !isDeepStrictEqual(await this.pendingRemovals(s, p.id), this.cachedPendingRemovals[p.id] ?? [])) retried = true;
        // So may what stands behind `destruction-old-copies-pending` (R379: an old copy deleted by hand, a list read again).
        const copies = await oldCopiesAwaitingDeletion(s.repo, p.id).catch((): DestructionOldCopiesPending[] => []);
        if (!isDeepStrictEqual(copies, this.cachedOldCopies[p.id]?.destructions ?? [])) retried = true;
      }
      if (p.backups?.automatic === false) continue;
      try {
        // R551 I2: a close that begins meanwhile cancels it: nothing made, nothing recorded (it could not run now).
        const r = await backupIfDue(s.repo, p.id, this.opts.now(), { signal: s.closing.signal });
        out.push({ projectId: p.id, ok: true, backedUp: r !== null });
        if (r) this.events.publish("job.progress", { kind: "backup", projectId: p.id, ok: true });
      } catch (err) {
        // Kept as the project's warning `backup-failed` by the library; surfaced here too.
        out.push({ projectId: p.id, ok: false, backedUp: false, error: this.describe(err) });
        this.events.publish("job.progress", { kind: "backup", projectId: p.id, ok: false, error: this.describe(err) });
      }
    }
    if (out.length || retried) this.publishState();
    return out;
  }

  private startBackupScheduler(): void {
    this.stopBackupScheduler();
    const t = setInterval(
      () =>
        this.startWork("backup", async () => {
          await this.runScheduledBackups();
        }),
      this.opts.backupCheckMs,
    );
    t.unref?.();
    this.backupTimer = t;
  }

  stopBackupScheduler(): void {
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.backupTimer = undefined;
  }

  // ---- "Look up again" (decision 31 (c); R566 3, 4, 5; R577 i, iv) --------------------------

  /**
   * Starts the automatic pass as registered work of the session (`idle()` waits for it, a move's quiesce drains it): at
   * the opening, at an unlock, and on the quiet timer. One pass at a time: asked for while one runs, another runs once
   * that one has ended (so an unlock during a pass is not missed). Read-write libraries only.
   */
  startLookUpAgain(): void {
    const s = this.session;
    if (!s || s.lib.mode !== "read-write" || this.startsHeld || this.shuttingDown || s.closing.signal.aborted) return;
    if (this.lookUpPass) {
      this.lookUpPassAgain = true;
      return;
    }
    this.lookUpPass = this.startWork("lookup-again", async (ctl) => {
      try {
        do {
          this.lookUpPassAgain = false;
          await this.runLookUpAgain(ctl);
        } while (this.lookUpPassAgain && !ctl.stopping);
      } finally {
        this.lookUpPass = undefined;
        this.lookUpPassAgain = false;
      }
    });
  }

  /**
   * One automatic pass (R566 3): for each unlocked project of the open read-write library, the entries `dueLookUps`
   * lists (oldest first), each looked up again by the library's `lookUpAgain` — strictly one after another, at most
   * LOOK_UP_AGAIN_PASS_MAX entries in all. It stops at once when the library begins to close, when a move holds work
   * back or asks the work to stop, or when another library is open. A service that asks to wait again is held by the
   * session's lookup client, and `lookUpAgain` leaves a held service out without sending (R411), so the rest of the pass
   * sends it nothing. A lookup that failed outright is never due (R577 iv): only the researcher's act asks it. Returns
   * how many entries it took.
   */
  async runLookUpAgain(ctl: WorkControl = { stopping: false }): Promise<number> {
    const s = this.session;
    let taken = 0;
    const stop = () => ctl.stopping || this.startsHeld || this.shuttingDown || s?.closing.signal.aborted === true || this.session !== s;
    if (!s || s.lib.mode !== "read-write" || stop()) return taken;
    for (const p of s.repo.listProjects()) {
      if (stop()) return taken;
      // A locked project waits for its unlock (R566 4): nothing of it is read or asked.
      if (!s.repo.isUnlocked(p.id)) continue;
      let due: Awaited<ReturnType<typeof dueLookUps>>;
      try {
        due = await dueLookUps(s.repo, p.id, this.opts.now());
      } catch (err) {
        this.opts.log.warn({ err: this.describe(err) }, "looking up again: the review queue could not be read");
        continue;
      }
      for (const d of due) {
        if (taken >= LOOK_UP_AGAIN_PASS_MAX || stop()) return taken;
        taken++;
        let r: LookUpAgainResult;
        try {
          r = await this.lookUpInTurn(() => lookUpAgain(s.repo, s.http, p.id, d.entryId, { by: "automatic", closing: s.closing.signal, now: this.opts.now() }));
        } catch (err) {
          // A refusal by the project's rules (audited by the library) or a failure of this one entry: the next goes on.
          this.opts.log.warn({ err: this.describe(err) }, "looking up again: an entry was not looked up");
          continue;
        }
        if (r.done) continue;
        // The library began to close (or another opened): nothing more is sent or written.
        if (r.why === "closing" || r.why === "cancelled" || r.why === "read-only") return taken;
        // Locked meanwhile: the rest of this project waits for its unlock.
        if (r.why === "locked") break;
      }
    }
    return taken;
  }

  /** The researcher's "Look up again" (the route): takes its turn with the automatic pass's entries. */
  lookUpAgainByHand(s: Session, projectId: string, entryId: string): Promise<LookUpAgainResult> {
    return this.lookUpInTurn(() => lookUpAgain(s.repo, s.http, projectId, entryId, { by: "researcher", closing: s.closing.signal, now: this.opts.now() }));
  }

  /** The service's clock (the entries' times and the pass's "now"). */
  now(): Date {
    return this.opts.now();
  }

  /** One look-up at a time: two look-ups of one entry at once would both send (the engine report's §9 item 6). */
  private lookUpInTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lookUpTurn.then(fn, fn);
    this.lookUpTurn = run.catch(() => {});
    return run;
  }

  private startLookUpAgainTimer(): void {
    this.stopLookUpAgainTimer();
    const t = setInterval(() => this.startLookUpAgain(), this.opts.lookUpAgainCheckMs ?? LOOK_UP_AGAIN_CHECK_MS);
    t.unref?.();
    this.lookUpTimer = t;
  }

  stopLookUpAgainTimer(): void {
    if (this.lookUpTimer) clearInterval(this.lookUpTimer);
    this.lookUpTimer = undefined;
  }

  // ---- shutdown --------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.closeLibrary();
    const w = this.worker ?? (await this.workerStarting?.catch(() => undefined));
    this.worker = undefined;
    await w?.stop().catch(() => {});
    this.events.clear();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
