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
  type Library,
  type Repo,
  type ToolsUpdate,
  type WorkerClient,
} from "@ao/library";
import { ApiError } from "./errors.js";
import { EventBus } from "./events.js";

/** A running media worker, shared by every library the service opens. */
export interface ServiceWorker {
  /** A client bound to `repo` (jobs recorded in its index). */
  clientFor(repo: Repo, index?: IndexHandle): WorkerClient;
  versions(): Promise<Record<string, string | null>>;
  updateTools(): Promise<ToolsUpdate>;
  stop(): Promise<void>;
}

export interface WorkerProvider {
  start(): Promise<ServiceWorker>;
}

/** The default worker: `AO_WORKER_BIN`, or the venv made by `pnpm setup:py`. */
export const defaultWorkerProvider = (onLog?: (line: string) => void): WorkerProvider => ({
  async start() {
    const mw = await startMediaWorker(onLog ? { onLog } : {});
    const { WorkerClient } = await import("@ao/library");
    return {
      clientFor: (repo, index) => new WorkerClient({ repo, worker: mw.handle, pollMs: 200, ...(index ? { index: { db: index.db } } : {}) }),
      versions: () => mw.versions(),
      updateTools: () => mw.updateTools(),
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
}

export interface StateOptions {
  deps: Deps;
  worker: WorkerProvider | null;
  autoStartWorker: boolean;
  now: () => Date;
  /** How often the backup scheduler checks for due backups (default 1 hour). */
  backupCheckMs: number;
  log: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void };
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
  private worker: ServiceWorker | undefined;
  private workerStarting: Promise<ServiceWorker> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  private backupTimer: ReturnType<typeof setInterval> | undefined;
  /** Roots of libraries seen this run: paths inside them are shown library-relative in errors. */
  readonly roots = new Set<string>();
  readonly tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
    const s = this.requireSession();
    if (s.lib.mode === "read-only" || !s.index || !s.bulk) {
      throw new ApiError(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.", s.lib.readOnlyReason ?? "read-only");
    }
    return s as Session & { index: IndexHandle; bulk: BulkImport };
  }

  /** Makes `lib` the open library (closing any other first). */
  async adopt(lib: Library): Promise<Session> {
    if (this.session && this.session.lib !== lib) await this.closeLibrary();
    this.roots.add(lib.root);
    const ring = new KeyRing();
    let index: IndexHandle | undefined;
    let repo: Repo;
    try {
      index = lib.mode === "read-write" ? new IndexHandle(lib.root) : undefined;
      repo = await openRepo(lib, ring, { actor: actor(), tz: this.tz, ...(index ? { index: createIndexSink(index, { root: lib.root, keyRing: ring }) } : {}) });
    } catch (err) {
      index?.close();
      await lib.close().catch(() => {});
      throw err;
    }
    const http = new HttpClient({ libraryRoot: lib.root });
    const proxies = proxyQueueFor(repo);
    const ocr = ocrQueueFor(repo);
    const s: Session = {
      lib,
      repo,
      ring,
      index,
      http,
      bulk: index ? createBulkImport({ repo, http, index, proxies, queueOcr: (p, sid) => void this.track(ocr.enqueue(p, sid), "OCR queueing") }) : undefined,
      watches: new Map(),
      batches: new Map(),
      moveTokens: new Map(),
      workerClient: undefined,
      unsubscribe: [],
    };
    s.unsubscribe.push(proxies.onResult((r) => this.events.publish("job.progress", { kind: "proxy", ...r })));
    s.unsubscribe.push(ocr.onResult((r) => this.events.publish("job.progress", { kind: "ocr", ...r })));
    this.session = s;

    if (lib.mode === "read-write") {
      for (const p of repo.listProjects()) this.track(this.startWatches(s, p.id), "watched folders");
    }
    if (this.worker) this.attachWorker(s, this.worker);
    else if (this.opts.autoStartWorker && this.opts.worker) this.track(this.ensureWorker(), "starting the media helper");
    this.startBackupScheduler();
    this.publishState();
    return s;
  }

  private async startWatches(s: Session, projectId: string): Promise<void> {
    const watches = await startWatchedFolders(
      {
        repo: s.repo,
        http: s.http,
        lib: s.lib,
        proxies: proxyQueueFor(s.repo),
        onEvent: (e) => this.events.publish("job.progress", { kind: "watch", projectId, event: JSON.parse(scrubPaths(JSON.stringify(e), this.roots)) }),
        onWarning: (w) => this.opts.log.warn({ warning: scrubPaths(w, this.roots) }, "watched folders"),
      },
      projectId,
    );
    if (this.session !== s) {
      await Promise.all(watches.map((w) => w.stop()));
      return;
    }
    s.watches.set(projectId, [...(s.watches.get(projectId) ?? []), ...watches]);
  }

  /** Closes the open library: running batches cancelled, watches stopped, queues disposed of, lock released. */
  async closeLibrary(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    this.stopBackupScheduler();
    for (const { handle } of s.batches.values()) {
      try {
        handle.cancel();
      } catch {
        // already finished
      }
    }
    await Promise.allSettled([...s.batches.values()].map(({ handle }) => withTimeout(handle.done, 30_000)));
    await Promise.allSettled([...s.watches.values()].flat().map((w) => w.stop()));
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
    if (s.lib.mode !== "read-write") return;
    this.track(client.resumePending(), "resuming interrupted worker jobs");
    for (const p of s.repo.listProjects()) if (s.repo.isUnlocked(p.id)) this.resumeProject(s, p.id);
  }

  /** Resumes a project's pending viewing proxies and OCR (at open / worker ready / unlock). */
  resumeProject(s: Session, projectId: string): void {
    if (!s.workerClient || s.lib.mode !== "read-write") return;
    this.track(proxyQueueFor(s.repo).resumePending(projectId), "resuming viewing proxies");
    this.track(ocrQueueFor(s.repo).resumePending(projectId), "resuming OCR");
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
  async runScheduledBackups(): Promise<BackupRun[]> {
    const s = this.session;
    if (!s || s.lib.mode !== "read-write") return [];
    const out: BackupRun[] = [];
    for (const p of s.repo.listProjects()) {
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
    const t = setInterval(() => this.track(this.runScheduledBackups(), "scheduled backups"), this.opts.backupCheckMs);
    t.unref?.();
    this.backupTimer = t;
  }

  private stopBackupScheduler(): void {
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.backupTimer = undefined;
  }

  // ---- shutdown --------------------------------------------------------------------------

  async shutdown(): Promise<void> {
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
