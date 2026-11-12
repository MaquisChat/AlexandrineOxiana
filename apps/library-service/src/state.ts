/**
 * What the service holds while it runs: the one open library (its repo, key ring, index, the one
 * shared lookup HttpClient, Bulk Import, viewing-proxy and OCR queues, watched folders, running
 * batches), the media worker, the event bus and the daily backup scheduler (R96 carry-overs).
 * Everything that changes the library goes through `@ao/library`.
 */
import { userInfo } from "node:os";
import {
  HttpClient,
  IndexHandle,
  KeyRing,
  WorkerUnavailableError,
  backupIfDue,
  createBulkImport,
  createIndexSink,
  disposeOcrQueue,
  disposeProxyQueue,
  ocrQueueFor,
  openRepo,
  projectWarnings,
  proxyQueueFor,
  scrubPaths,
  startMediaWorker,
  startWatchedFolders,
  type BatchHandle,
  type BulkImport,
  type Deps,
  type FolderWatch,
  type BatchResult,
  type WatchDeps,
  type Library,
  type Repo,
  type ToolsUpdate,
  type WorkerClient,
  type WorkerEndpoint,
  type WorkerToolsClient,
  type CaptureOptions,
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
} from "@ao/library";
import { ApiError } from "./errors.js";
import { EventBus } from "./events.js";
import { MediaTickets } from "./media.js";

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

export interface Session {
  lib: Library;
  repo: Repo;
  ring: KeyRing;
  /** Absent for a read-only library (nothing may write its index). */
  index: IndexHandle | undefined;
  /** The one lookup client of this library (R96: shared by attach, Bulk Import and watched folders). */
  http: HttpClient;
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
  log: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void };
  watchStabilityMs?: number;
  /** How long an import may take to reach a safe point when paused (default SUSPEND_TIMEOUT_MS). */
  suspendTimeoutMs?: number;
  /** Opens a library (test seam; default the library's openLibrary). */
  openLibrary?: typeof openLibrary;
  /** Rebuilds the index when needed (test seam; default the library's rebuildIndexIfNeeded). */
  rebuildIndexIfNeeded?: typeof rebuildIndexIfNeeded;
  /** Test seam (a fake clock): starts the timer of GET /libraries' wait at start; returns its cancel. */
  startupTimer?: (fire: () => void, ms: number) => () => void;
}

/** How long GET /libraries waits, once, for the reopen at start (D5, I1). */
export const STARTUP_WAIT_MS = 30_000;

/** A finished move whose old copy may still be deleted: its single-use token, for 15 minutes (R99). */
export interface PendingMove {
  oldRoot: string;
  newRoot: string;
  confirmToken: string;
  expiresAt: string;
}
export const MOVE_TOKEN_TTL_MS = 15 * 60_000;
/** How long a running batch may take to reach a safe point when it is paused for shutdown or a move. */
export const SUSPEND_TIMEOUT_MS = 60_000;

/** Lets registered background work stop between its items (R106). */
export interface WorkControl {
  stopping: boolean;
}

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
  private worker: ServiceWorker | undefined;
  private workerStarting: Promise<ServiceWorker> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  private backupTimer: ReturnType<typeof setInterval> | undefined;
  /** Roots of libraries seen this run: paths inside them are shown library-relative in errors. */
  readonly roots = new Set<string>();
  readonly tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private move: PendingMove | undefined;
  /** A library move is running: every change is refused (503 MOVE_IN_PROGRESS), background work waits (R102 N2). */
  moving = false;
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

  /** Asks every registered item to stop between items and waits for all to end; false if one did not in time. */
  async drainWork(timeoutMs: number): Promise<boolean> {
    const items = [...this.work.values()];
    for (const w of items) w.ctl.stopping = true;
    const all = Promise.allSettled(items.map((w) => w.done)).then(() => true);
    const ok = (await withTimeout(all, timeoutMs).catch(() => undefined)) === true;
    if (!ok) for (const w of items) w.ctl.stopping = false; // rolled back: the rest carries on
    return ok;
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

  /** The progress of a capture queue (also after a move). */
  captureQueue(queueId: string): { projectId: string; done: number; total: number; finished: boolean; lib?: object } | undefined {
    return this.captures.get(queueId);
  }

  /**
   * Captures `urls` one at a time in the registry: progress as `capture.progress`; a move stops it
   * between links and it continues with the rest on the moved library (R106 C1). With `after`, the
   * queue waits for that (another queue) to end before its first link (R116). The promise settles
   * when this run of the queue has ended.
   */
  startCaptureQueue(queueId: string, projectId: string, urls: string[], opts: CaptureOptions, at: { offset?: number; total?: number; after?: Promise<unknown> } = {}): Promise<void> {
    const offset = at.offset ?? 0;
    const total = at.total ?? urls.length;
    const info = this.captures.get(queueId) ?? { projectId, done: offset, total, finished: false };
    if (this.session) info.lib = this.session.lib;
    this.captures.set(queueId, info);
    // Every way out but a continuation after a move marks the queue finished (41a I3): an unfinished
    // queue keeps an extension's links slot taken.
    const fail = (err: unknown) => {
      info.finished = true;
      this.events.publish("capture.progress", { queueId, projectId, finished: true, error: this.describe(err) });
    };
    return this.startWork("capture", async (ctl) => {
      await at.after?.catch(() => {});
      let outcomes: Awaited<ReturnType<ReturnType<typeof createLinkCapture>["captureUrls"]>>;
      try {
        const s = this.requireSession();
        const worker = await this.workerClient();
        const capture = createLinkCapture({ repo: s.repo, worker, index: s.index });
        outcomes = await capture.captureUrls(
          projectId,
          urls,
          opts,
          (done, _t, outcome) => {
            info.done = offset + done;
            info.finished = info.done === total;
            this.events.publish("capture.progress", { queueId, projectId, done: info.done, total, outcome, finished: info.finished });
          },
          { shouldStop: () => ctl.stopping },
        );
      } catch (err) {
        fail(err);
        return;
      }
      if (outcomes.length < urls.length) {
        const rest = urls.slice(outcomes.length);
        const next = offset + outcomes.length;
        return () => void this.startCaptureQueue(queueId, projectId, rest, opts, { offset: next, total });
      }
      info.finished = true;
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
      http: new HttpClient({ libraryRoot: lib.root }),
      bulk: undefined,
      watches: new Map(),
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
        }) : undefined;
    s.unsubscribe.push(proxies.onResult((r) => this.events.publish("job.progress", { kind: "proxy", ...r })));
    s.unsubscribe.push(ocr.onResult((r) => this.events.publish("job.progress", { kind: "ocr", ...r })));
    if (s.lib.mode === "read-write") {
      for (const p of s.repo.listProjects()) this.track(this.startWatches(s, p.id), "watched folders");
      // A backup that came due while the app was closed is made now (R99 I7).
      this.startWork("backup", async () => {
        await this.runScheduledBackups();
      });
    }
    if (this.worker) this.attachWorker(s, this.worker);
    else if (this.opts.autoStartWorker && this.opts.worker) this.track(this.ensureWorker(), "starting the media helper");
    this.startBackupScheduler();
    this.publishState();
    // Opened at last after a move whose first open failed: what was paused for it resumes (R106).
    if (this.pendingResume && this.pendingResume.root === s.lib.root && s.lib.mode === "read-write") {
      const { batches } = this.pendingResume;
      this.pendingResume = undefined;
      this.resumeBatches(batches);
      this.restartStoppedWork();
    }
  }

  /** What every watched folder of the open library is started with (events included, R99). */
  watchDeps(s: Session, projectId: string): WatchDeps & { onWarning: (w: string) => void } {
    return {
      repo: s.repo,
      http: s.http,
      lib: s.lib,
      proxies: proxyQueueFor(s.repo),
      ...(this.opts.watchStabilityMs !== undefined ? { stabilityMs: this.opts.watchStabilityMs, pollMs: Math.max(50, this.opts.watchStabilityMs) } : {}),
      onEvent: (e) => this.events.publish("job.progress", { kind: "watch", projectId, event: JSON.parse(scrubPaths(JSON.stringify(e), this.roots)) as unknown }),
      onWarning: (w) => this.opts.log.warn({ warning: scrubPaths(w, this.roots) }, "watched folders"),
    };
  }

  /** Starts the project's watched folders (all of them; replaces any running). */
  async startWatches(s: Session, projectId: string): Promise<void> {
    await this.stopWatches(s, projectId);
    const watches = await startWatchedFolders(this.watchDeps(s, projectId), projectId);
    if (this.session !== s) {
      await Promise.all(watches.map((w) => w.stop()));
      return;
    }
    s.watches.set(projectId, [...(s.watches.get(projectId) ?? []), ...watches]);
  }

  async stopWatches(s: Session, projectId?: string): Promise<void> {
    const ids = projectId ? [projectId] : [...s.watches.keys()];
    await Promise.allSettled(ids.flatMap((id) => s.watches.get(id) ?? []).map((w) => w.stop()));
    for (const id of ids) s.watches.delete(id);
  }

  // ---- import batches ------------------------------------------------------------------

  /** Follows a running batch: progress and its end as `import.progress`; it leaves the registry when it ends (R99 I3). */
  followBatch(s: Session, projectId: string, h: BatchHandle): void {
    s.batches.set(h.batchId, { projectId, handle: h });
    this.track(
      (async () => {
        try {
          for await (const p of h.progress) this.events.publish("import.progress", { batchId: h.batchId, projectId, state: "running", done: p.done, total: p.total });
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
    const ms = this.opts.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS;
    // Background work first: captures and rechecks stop between items, the rest finishes (R106 C1).
    if (!(await this.drainWork(ms))) {
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
      this.restartStoppedWork();
      throw new ApiError(409, "CONFLICT", "An import could not be paused in time, so the library was not moved; try again in a moment.");
    }
    try {
      this.stopBackupScheduler();
      await this.stopWatches(s);
      await disposeProxyQueue(s.repo);
      await disposeOcrQueue(s.repo);
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
    if (!s || !bulk) return;
    for (const b of list) {
      if (!s.repo.listProjects().some((p) => p.id === b.projectId)) continue;
      this.startWork("resume-import", async () => {
        const h = await bulk.resumeBatch(b.projectId, b.batchId);
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
    this.stopBackupScheduler();
    await this.stopIndexRebuild(s);
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
    await withTimeout(Promise.allSettled([...this.tasks]), 30_000).catch(() => {});
    try {
      s.index?.close();
    } catch {
      // already closed
    }
    s.http.purgeSensitive();
    s.ring.clear();
    await s.lib.close().catch(() => {});
    this.publishState();
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
    // During a move nothing is resumed: the library open after it resumes (R106 C1).
    if (s.lib.mode !== "read-write" || this.moving) return;
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
    if (!client || s.lib.mode !== "read-write" || this.moving) return;
    void this.startWork("worker-resume", async (ctl) => {
      await client.resumePending(projectId, { shouldStop: () => ctl.stopping });
      if (ctl.stopping) return (next: Session) => this.resumeWorkerJobs(next, projectId);
    });
  }

  /**
   * Resumes a project's pending viewing proxies and OCR (at open / worker ready / unlock); at an
   * unlock (`workerJobs`) also its pending worker jobs.
   */
  resumeProject(s: Session, projectId: string, opts: { workerJobs?: boolean } = {}): void {
    if (!s.workerClient || s.lib.mode !== "read-write" || this.moving) return;
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
    };
  }

  private cachedProjectWarnings: Record<string, string[]> = {};

  integrityWarnings(s: Session, names = new Map(s.repo.listProjects().map((p) => [p.id, p.name]))): Array<{ projectId: string; project: string; kind: string; detail: string }> {
    return s.repo.integrityWarnings.map((w) => ({
      projectId: w.projectId,
      project: w.projectId === "*" ? "library" : (names.get(w.projectId) ?? "a project"),
      kind: w.kind,
      detail: scrubPaths(w.detail, this.roots),
    }));
  }

  /** The projects' standing warnings (backup failed, deletion records unreadable), by project id. */
  async projectWarnings(s: Session): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const p of s.repo.listProjects()) out[p.id] = await projectWarnings(s.repo, p.id).catch(() => []);
    this.cachedProjectWarnings = out;
    return out;
  }

  /** Recomputes the project warnings, then sends `library.state`. */
  publishState(): void {
    const s = this.session;
    if (!s) {
      this.cachedProjectWarnings = {};
      this.events.publish("library.state", this.libraryState());
      return;
    }
    this.track(
      this.projectWarnings(s).then(() => {
        if (this.session === s) this.events.publish("library.state", this.libraryState());
      }),
      "library state",
    );
  }

  // ---- daily backups (R90 b, R96) --------------------------------------------------------

  /** One pass of the backup scheduler: every project whose automatic backup is due is backed up. */
  async runScheduledBackups(onlyProjectId?: string): Promise<BackupRun[]> {
    const s = this.session;
    if (!s || s.lib.mode !== "read-write" || this.moving || this.shuttingDown) return [];
    const out: BackupRun[] = [];
    for (const p of s.repo.listProjects()) {
      if (onlyProjectId && p.id !== onlyProjectId) continue;
      if (p.backups?.automatic === false) continue;
      try {
        const r = await backupIfDue(s.repo, p.id, this.opts.now());
        out.push({ projectId: p.id, ok: true, backedUp: r !== null });
        if (r) this.events.publish("job.progress", { kind: "backup", projectId: p.id, ok: true });
      } catch (err) {
        // Kept as the project's warning `backup-failed` by the library; surfaced here too.
        out.push({ projectId: p.id, ok: false, backedUp: false, error: this.describe(err) });
        this.events.publish("job.progress", { kind: "backup", projectId: p.id, ok: false, error: this.describe(err) });
      }
    }
    if (out.length) this.publishState();
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
