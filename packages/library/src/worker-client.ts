/**
 * Client for the Python media worker (`services/media-worker`, spec 2.1 / 5.2 / 5.3).
 *
 * `startWorker` spawns the worker with a random token and waits for `AO_WORKER_READY port=<n>`.
 * `WorkerClient.submit` runs one job for a project:
 *
 *   1. policy: `process` with `{ op, provider: 'local' }` (transcription, image_proxy, video_proxy,
 *      ocr), evaluated by the repo with the system tz and `now`; a deny is audited through the repo
 *      and thrown as PolicyDeniedError before the worker is contacted. `capture.download` is not
 *      evaluated here: the caller has already passed a `capture` decision.
 *   2. a record in the project's job journal (`<Project>/jobs/journal.jsonl`, sealed in encrypted
 *      projects, R31; see job-journal.ts), written before the `jobs` row of the index, which is
 *      only a cache of it (status queued → running → done | failed | cancelled), so that a job
 *      the app did not see finish is resubmitted on the next launch (`resumePending`, which reads
 *      the journals). `capture.download` is never resumed (its capture decision and caller are
 *      gone): it is marked failed `INTERRUPTED`, and leftover `.tmp/capture-*` / `worker-*` /
 *      `batch-*` folders are swept. A read-only library records nothing (and resumes nothing).
 *   3. a private temp folder `<Library>/.tmp/worker-<id>/` (0700): an encrypted input is decrypted
 *      into it (0600), and the worker writes its outputs there.
 *   4. polling every 500 ms, progress forwarded; an aborted signal cancels the worker job.
 *   5. outputs are moved to the caller's `output` (encrypted with the project key when the project
 *      is encrypted or the decision requires it); the temp folder is removed in `finally`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { EntityType, PolicyDecision, ProcessingOp } from "@ao/core";
import { decryptStream, encryptStream } from "./crypto/format.js";
import { copyFileAtomic, renameWithRetry } from "./fs/atomic.js";
import type { IndexDb } from "./index/db.js";
import {
  LOCKED_CODE, UNFINISHED, appendJobRecords, assertNoSecrets, compactJobJournal, errorCode, isPending, refreshJobRows, upgradeLegacyJobs,
  upsertJobRow, type JobRecord, type JobStatus, type ProjectKey, type StoredJob, type WorkerJobType,
} from "./job-journal.js";
import { ProjectLockedError } from "./repo/errors.js";
import { activeTemp, isStaleWorkDir } from "./tmp-registry.js";
import { authorizeProcessing, onProjectUnlocked, projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";

export type { WorkerJobType } from "./job-journal.js";

/** The processing op each job type is evaluated as (null: the caller passed a `capture` decision). */
export const JOB_OPS: Record<WorkerJobType, ProcessingOp | null> = {
  "audio.transcribe": "transcription",
  "capture.download": null,
  "image.proxy": "image_proxy",
  "video.proxy": "video_proxy",
  "pdf.ocr": "ocr",
};

/** Job types whose `output` is a folder; the others produce a file (pdf.ocr also `<output>.txt`). */
const DIR_OUTPUTS: ReadonlySet<WorkerJobType> = new Set(["audio.transcribe", "capture.download"]);

export interface WorkerJob {
  type: WorkerJobType;
  /** Absolute path of the input file, or the URL for `capture.download`. */
  input: string;
  /** The input is in the library's encrypted file format (decrypted with the project key first). */
  inputEncrypted?: boolean;
  /** Final destination: a folder for audio.transcribe and capture.download, else a file. */
  output: string;
  params?: Record<string, unknown>;
  /** Entity recorded on a deny audit event. */
  entity?: { type: EntityType; id: string };
  /** Called with 0..1 whenever the worker reports progress. */
  onProgress?: (progress: number) => void;
  /** Aborting cancels the job (the worker kills its child processes). */
  signal?: AbortSignal;
}

export interface JobResult {
  /** The client's job id (the `jobs` row). */
  id: string;
  type: WorkerJobType;
  /** The caller's `output`. */
  output: string;
  /** Every file written under the destination. */
  files: string[];
  /** Worker meta, with worker temp paths rewritten to their final paths. */
  meta: Record<string, unknown>;
  /** True when the files were written encrypted with the project key. */
  encrypted: boolean;
}

export class WorkerJobError extends Error {
  override name = "WorkerJobError";
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** The worker could not be reached (or no longer accepts our token). The job stays pending. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
}

export interface WorkerEndpoint {
  baseUrl: string;
  token: string;
}

export interface WorkerClientOptions {
  repo: Repo;
  worker: WorkerEndpoint;
  /**
   * The library index (an IndexHandle, or anything whose `db` is the live connection): its `jobs`
   * table is kept as a cache of the job journals. Optional: the journals are the record.
   */
  index?: { readonly db: IndexDb };
  /** Poll interval (default 500 ms). */
  pollMs?: number;
}

interface WorkerJobState {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress?: number;
  result?: { output: string; meta?: Record<string, unknown> };
  error?: { code: string; message: string; detail?: string };
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Failed polls retried (with backoff) before the worker is treated as gone. */
const POLL_RETRIES = 3;

/** Job ids being run by any client of this process: one run per job. */
const claimed = new Set<string>();
/** The newest client of each repository: the one that resubmits a project's jobs when it is unlocked (R142). */
const latestClient = new WeakMap<Repo, WorkerClient>();
onProjectUnlocked(async (repo, projectId) => {
  latestClient.get(repo)?.resumeAfterUnlock(projectId);
});

export class WorkerClient {
  private readonly repo: Repo;
  private readonly worker: WorkerEndpoint;
  private readonly index?: { readonly db: IndexDb };
  /** The newest record of each job this client is running (the base of its next line). */
  private readonly records = new Map<string, JobRecord>();
  private readonly pollMs: number;
  private readonly active = new Set<string>();
  /** R142: the project key each running job captured at its start (a copy, zeroed when the job ends). */
  private readonly keys = new Map<string, NonNullable<ProjectKey>>();
  /** Background work this client started on its own (resubmission after an unlock). */
  private readonly background = new Set<Promise<unknown>>();

  constructor(opts: WorkerClientOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker;
    this.index = opts.index;
    this.pollMs = opts.pollMs ?? 500;
    latestClient.set(this.repo, this);
  }

  /** Test seam: how many captured project keys running jobs hold (0 once every job has ended). */
  get heldKeys(): number {
    return this.keys.size;
  }

  /** Resolves once the work this client started on its own (resubmission at an unlock) has settled. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** R142: an unlocked project's pending jobs (including those cancelled by its lock) are offered again. */
  resumeAfterUnlock(projectId: string): void {
    const p = this.resumePending(projectId).catch(() => []);
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  submit(projectId: string, job: WorkerJob): Promise<JobResult> {
    return this.run(randomUUID(), projectId, job);
  }

  /**
   * Resubmits jobs whose newest journal record is queued or running (the app quit or the worker
   * died before they finished). Call once at launch, before new submissions; stale worker temp
   * folders are removed. Works from the journals alone: rows written before the journal existed
   * are first written into them (`upgradeLegacyJobs`), each readable journal is compacted when
   * mostly superseded, and the index rows are made to match it. Journals of locked encrypted
   * projects cannot be read: their jobs stay pending (rows the index knows are reported with
   * ProjectLockedError). A read-only library is not written to: nothing is resumed. Jobs cancelled
   * because their project was locked before they started are resubmitted too (R142); this runs
   * by itself for one project when it is unlocked (`projectId`).
   */
  async resumePending(projectId?: string): Promise<Array<{ id: string; projectId: string; result?: JobResult; error?: unknown }>> {
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write") return [];
    await this.removeStaleTemp();
    const db = this.db();
    if (db) await upgradeLegacyJobs(db, library.root, { get: (keyId: string) => this.keyById(keyId) }).catch(() => undefined);
    const out: Array<{ id: string; projectId: string; result?: JobResult; error?: unknown }> = [];
    const todo: JobRecord[] = [];
    for (const p of this.repo.listProjects()) {
      if (projectId !== undefined && p.id !== projectId) continue;
      let key: { key: Uint8Array; keyId: string } | null;
      try {
        key = projectDataKey(this.repo, p.id);
      } catch (error) {
        if (!(error instanceof ProjectLockedError)) throw error;
        const rows = (db ? db.prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY created_at, id").all(p.id) : []) as Array<{ id: string }>;
        for (const r of rows) out.push({ id: r.id, projectId: p.id, error });
        continue;
      }
      try {
        await compactJobJournal(library.root, p.folder, p.id, key);
        const journal = await refreshJobRows(() => this.db(), library.root, p.folder, p.id, key);
        for (const r of journal.records.values()) if (isPending(r)) todo.push(r);
      } catch (error) {
        out.push({ id: "", projectId: p.id, error });
      }
    }
    todo.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
    for (const rec of todo) {
      // One run per job across this process's clients (a launch and an unlock may overlap).
      if (claimed.has(rec.id)) continue;
      if (rec.kind === "capture.download" || !rec.job) {
        // Never resumed: a capture's caller (and the capture decision it made) is gone, and its
        // output folder has been swept; the researcher captures the link again. A record without
        // its job (from before the journal, unreadable) cannot run again either.
        const code = rec.kind === "capture.download" ? "INTERRUPTED" : "UNRECOVERABLE";
        claimed.add(rec.id);
        this.records.set(rec.id, rec);
        await this.transition(rec.id, "failed", code).catch(() => {});
        this.records.delete(rec.id);
        claimed.delete(rec.id);
        out.push({
          id: rec.id,
          projectId: rec.projectId,
          error: new WorkerJobError(code, code === "INTERRUPTED" ? "the capture was interrupted; capture the link again" : "the job's record cannot be read; start it again"),
        });
        continue;
      }
      try {
        out.push({ id: rec.id, projectId: rec.projectId, result: await this.run(rec.id, rec.projectId, rec.job, rec) });
      } catch (error) {
        out.push({ id: rec.id, projectId: rec.projectId, error });
      }
    }
    return out;
  }

  // ---- internals ----

  private async run(id: string, projectId: string, job: WorkerJob, resumed?: JobRecord): Promise<JobResult> {
    if (claimed.has(id)) throw new WorkerJobError("ALREADY_RUNNING", "the job is already running");
    claimed.add(id);
    try {
      return await this.runClaimed(id, projectId, job, resumed);
    } finally {
      claimed.delete(id);
    }
  }

  private async runClaimed(id: string, projectId: string, job: WorkerJob, resumed?: JobRecord): Promise<JobResult> {
    const op = JOB_OPS[job.type];
    if (op === undefined) throw new TypeError(`unknown worker job type "${String(job.type)}"`);
    assertNoSecrets(job.params ?? {}); // job records are kept in files: never a secret (R31)
    let decision: PolicyDecision | undefined;
    if (op !== null) {
      decision = await authorizeProcessing(
        this.repo,
        projectId,
        { action: "process", process: { op, provider: "local" } },
        { op: `worker.${job.type}`, entity: job.entity },
      );
    }
    const live = projectDataKey(this.repo, projectId); // throws ProjectLockedError when locked
    // R142: the job keeps its own copy of the key from here to its end (a lock zeroes the ring's),
    // for its input, its sealed output and its journal lines; the copy is zeroed when it ends.
    const dataKey = live ? { key: Uint8Array.from(live.key), keyId: live.keyId } : null;
    if (dataKey) this.keys.set(id, dataKey);
    const lockedNow = () => dataKey !== null && !this.repo.isUnlocked(projectId);
    const mustEncrypt = decision?.result === "allow_with_conditions" && decision.conditions.some((c) => c.type === "encrypt");
    if (mustEncrypt && !dataKey) throw new WorkerJobError("ENCRYPTION_REQUIRED", "the decision requires encryption but the project is not encrypted");
    const stored: StoredJob = {
      type: job.type,
      input: job.input,
      ...(job.inputEncrypted ? { inputEncrypted: true } : {}),
      output: job.output,
      params: job.params ?? {},
      ...(job.entity ? { entity: job.entity } : {}),
    };
    const now = new Date().toISOString();
    this.records.set(id, resumed ?? { v: 1, id, projectId, kind: stored.type, status: "queued", createdAt: now, updatedAt: now, job: stored });
    try {
      await this.transition(id, "queued");
    } catch (err) {
      this.records.delete(id);
      this.dropKey(id);
      throw err;
    }

    const root = repoLibrary(this.repo).root;
    const tmp = join(root, ".tmp", `worker-${id}`);
    this.active.add(id);
    activeTemp.add(`worker-${id}`);
    try {
      await fsp.mkdir(join(root, ".tmp"), { recursive: true });
      await fsp.rm(tmp, { recursive: true, force: true });
      await privateDir(tmp);
      let input = job.input;
      if (job.inputEncrypted) {
        if (!dataKey) throw new WorkerJobError("INPUT_NOT_DECRYPTABLE", "the input is encrypted but the project is not");
        await privateDir(join(tmp, "in"));
        input = join(tmp, "in", basename(job.input).replace(/\.enc$/i, ""));
        const getKey = (keyId: string) => (keyId === dataKey.keyId ? dataKey.key : undefined);
        await copyFileAtomic(job.input, input, { transform: (r) => r.pipe(decryptStream(getKey)), mode: 0o600 });
      }
      const outDir = join(tmp, "out");
      await privateDir(outDir);
      const isDir = DIR_OUTPUTS.has(job.type);
      const workerOutput = isDir ? outDir : join(outDir, basename(job.output));
      const finalBase = isDir ? job.output : dirname(job.output);

      if (job.signal?.aborted) throw new WorkerJobError("CANCELLED", "the job was cancelled");
      // R142: a job whose project is locked before it starts does not start; it runs again at the next unlock.
      if (lockedNow()) await this.cancelForLock(id, projectId);
      const { id: workerId } = await this.request<{ id: string }>("POST", "/jobs", {
        type: job.type,
        input,
        output: workerOutput,
        params: job.params ?? {},
      });
      if (lockedNow()) {
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
        await this.cancelForLock(id, projectId);
      }
      try {
        await this.transition(id, "running");
      } catch (err) {
        // Not recorded as running: the worker must not go on with a job the library is not tracking.
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
        throw err;
      }
      const state = await this.poll(workerId, job);

      if (state.status === "cancelled") throw new WorkerJobError("CANCELLED", "the job was cancelled");
      if (state.status === "failed") {
        const e = state.error ?? { code: "FAILED", message: "the job failed" };
        throw new WorkerJobError(e.code, e.message, e.detail);
      }
      const files = await publish(outDir, finalBase, dataKey);
      const meta = rewritePaths(state.result?.meta ?? {}, outDir, finalBase) as Record<string, unknown>;
      await this.transition(id, "done");
      return { id, type: job.type, output: job.output, files, meta, encrypted: dataKey !== null };
    } catch (err) {
      const recorded = this.records.get(id)?.status;
      if (!(err instanceof WorkerUnavailableError) && recorded !== undefined && UNFINISHED.has(recorded)) {
        const cancelled = err instanceof WorkerJobError && err.code === "CANCELLED";
        // A failure to record the outcome leaves the job pending (resubmitted later): the job's own error is the useful one.
        await this.transition(id, cancelled ? "cancelled" : "failed", errorCode(err instanceof WorkerJobError ? err.code : undefined)).catch(() => {});
      }
      throw err;
    } finally {
      this.records.delete(id);
      this.dropKey(id);
      this.active.delete(id);
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      activeTemp.delete(`worker-${id}`);
    }
  }

  private async poll(workerId: string, job: WorkerJob): Promise<WorkerJobState> {
    let cancelSent = false;
    let last = -1;
    let failures = 0;
    for (;;) {
      if (job.signal?.aborted && !cancelSent) {
        cancelSent = true;
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
      let state: WorkerJobState;
      try {
        state = await this.request<WorkerJobState>("GET", `/jobs/${encodeURIComponent(workerId)}`);
        failures = 0;
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError)) throw err;
        if (++failures <= POLL_RETRIES) {
          await new Promise((r) => setTimeout(r, this.pollMs * 2 ** failures)); // backoff
          continue;
        }
        // Give up: ask the worker (best effort) to stop, so it does not keep writing into the temp
        // folder we are about to delete. The job stays pending and is resubmitted on next launch.
        await this.request("POST", `/jobs/${encodeURIComponent(workerId)}/cancel`).catch(() => {});
        throw err;
      }
      if (typeof state.progress === "number" && state.progress !== last && state.status !== "cancelled") {
        last = state.progress;
        try {
          job.onProgress?.(state.progress);
        } catch {
          // a progress callback must not break the job
        }
      }
      if (TERMINAL.has(state.status)) return state;
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.worker.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.worker.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new WorkerUnavailableError(`the media worker is not reachable (${err instanceof Error ? err.message : String(err)})`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status === 401) throw new WorkerUnavailableError("the media worker rejected the token (was it restarted?)");
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; detail?: string } } | undefined)?.error;
      throw new WorkerJobError(e?.code ?? `HTTP_${res.status}`, e?.message ?? `the media worker answered ${res.status}`, e?.detail);
    }
    return json as T;
  }

  /** Records the job as cancelled by its project's lock (it keeps its job, to run at the next unlock) and stops it. */
  private async cancelForLock(id: string, projectId: string): Promise<never> {
    await this.transition(id, "cancelled", LOCKED_CODE, true);
    throw new ProjectLockedError(projectId);
  }

  private dropKey(id: string): void {
    this.keys.get(id)?.key.fill(0);
    this.keys.delete(id);
  }

  private db(): IndexDb | undefined {
    const db = this.index?.db;
    return db?.open ? db : undefined;
  }

  /** The key of an unlocked encrypted project, by key id (opens sealed rows of the legacy upgrade). */
  private keyById(keyId: string): Uint8Array | undefined {
    for (const p of this.repo.listProjects()) {
      try {
        const k = projectDataKey(this.repo, p.id);
        if (k && k.keyId === keyId) return k.key;
      } catch {
        // locked
      }
    }
    return undefined;
  }

  /**
   * The one writer of job records: appends the job's new state to its project's journal (sealed
   * in encrypted projects), then updates the cache row. Finished jobs keep no paths or parameters.
   * Nothing is written in a read-only library. Throws (writing nothing more) when the journal
   * cannot be appended, e.g. the project was locked meanwhile.
   */
  private async transition(id: string, status: JobStatus, error?: string, keepJob = false): Promise<void> {
    const prev = this.records.get(id);
    if (!prev) return;
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write") return;
    const { job, error: _previous, ...base } = prev;
    const rec: JobRecord = {
      ...base,
      status,
      updatedAt: new Date().toISOString(),
      ...((UNFINISHED.has(status) || keepJob) && job ? { job } : {}),
      ...(error && !UNFINISHED.has(status) ? { error } : {}),
    };
    // The job's captured key (R142), else the project's (ProjectLockedError while locked).
    const key = this.keys.get(id) ?? projectDataKey(this.repo, prev.projectId);
    await appendJobRecords(library.root, this.repo.getProject(prev.projectId).folder, key, [rec]);
    this.records.set(id, rec);
    const db = this.db();
    if (db) upsertJobRow(db, rec);
  }

  private async removeStaleTemp(): Promise<void> {
    const dir = join(repoLibrary(this.repo).root, ".tmp");
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (isStaleWorkDir(n) && !this.active.has(n.slice("worker-".length))) {
        await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

async function privateDir(path: string): Promise<void> {
  await fsp.mkdir(path, { mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(path, 0o700); // the umask may have narrowed nothing, but be explicit
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Moves (or encrypts) every file under `from` to the same relative path under `to`. */
async function publish(from: string, to: string, dataKey: { key: Uint8Array; keyId: string } | null): Promise<string[]> {
  const written: string[] = [];
  for (const src of await walkFiles(from)) {
    const dest = join(to, relative(from, src));
    await fsp.mkdir(dirname(dest), { recursive: true });
    if (dataKey) {
      await copyFileAtomic(src, dest, { transform: (r) => r.pipe(encryptStream(dataKey.key, dataKey.keyId)), mode: 0o600 });
    } else {
      try {
        await renameWithRetry(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await copyFileAtomic(src, dest);
      }
    }
    written.push(dest);
  }
  return written;
}

function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (value === from) return to;
    if (value.startsWith(from + sep)) return join(to, value.slice(from.length + 1));
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePaths(v, from, to)]));
  }
  return value;
}

// ---------- starting the worker ----------

export interface StartWorkerOptions {
  /** Explicit argv. Default: `$AO_WORKER_BIN` (packaged sidecar), else `<venv python> -m ao_worker`. */
  command?: string[];
  /** Python for the dev worker (default `services/media-worker/.venv`'s). */
  python?: string;
  /** Extra environment, e.g. AO_MODELS_DIR and AO_TOOLS_DIR. */
  env?: Record<string, string>;
  /** Default 30 s. */
  readyTimeoutMs?: number;
  /** Worker stderr lines (its log). */
  onLog?: (line: string) => void;
}

export interface WorkerHandle extends WorkerEndpoint {
  process: ChildProcess;
  /** Stops the worker (SIGTERM, SIGKILL after 5 s) and waits for it to exit. */
  stop(): Promise<void>;
}

const WORKER_DIR = fileURLToPath(new URL("../../../services/media-worker/", import.meta.url));
const READY_RE = /^AO_WORKER_READY port=(\d+)\s*$/;

// The worker (and the tools it runs) get only what they need from the app's environment.
const WORKER_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "TESSDATA_PREFIX",
]);
const WORKER_ENV_PREFIXES = ["LC_", "XDG_", "AO_"];
// Secrets of the app that the worker (and the tools it runs) must never see.
const WORKER_ENV_DENY = new Set(["AO_WORKER_TOKEN", "AO_PASSPHRASE"]);

/** The allowlisted subset of `env` passed to the worker (names compared case-insensitively). */
export function workerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || WORKER_ENV_DENY.has(k.toUpperCase())) continue;
    const u = k.toUpperCase();
    if (WORKER_ENV_NAMES.has(u) || WORKER_ENV_PREFIXES.some((p) => u.startsWith(p))) out[k] = v;
  }
  return out;
}

export function devWorkerPython(): string {
  return join(WORKER_DIR, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  let argv = opts.command;
  let cwd: string | undefined;
  if (!argv) {
    if (process.env.AO_WORKER_BIN) {
      argv = [process.env.AO_WORKER_BIN];
    } else {
      const py = opts.python ?? devWorkerPython();
      if (!existsSync(py)) throw new Error(`media worker venv not found (${py}); run \`pnpm setup:py\``);
      argv = [py, "-m", "ao_worker"];
      cwd = WORKER_DIR;
    }
  }
  const token = randomBytes(32).toString("hex");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: {
      ...workerEnv(process.env),
      ...opts.env,
      AO_WORKER_TOKEN: token,
      AO_WORKER_PORT: "0",
      AO_WORKER_EXIT_ON_STDIN_EOF: "1",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const stderrTail: string[] = [];
  createInterface({ input: child.stderr! }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
    opts.onLog?.(line);
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const stop = async (): Promise<void> => {
    if (!isRunning()) return exited;
    child.stdin?.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (isRunning()) child.kill("SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(timer);
  };

  const port = await new Promise<number>((resolve, reject) => {
    const timeoutMs = opts.readyTimeoutMs ?? 30_000;
    const lines = createInterface({ input: child.stdout! });
    let done = false;
    const finish = (err: Error | null, p?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(p!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      void exited.then(() => finish(new Error(`media worker was not ready within ${timeoutMs} ms`)));
    }, timeoutMs);
    lines.on("line", (line) => {
      const m = READY_RE.exec(line);
      if (m) finish(null, Number(m[1]));
    });
    child.once("error", (err) => finish(new Error(`media worker could not be started: ${err.message}`)));
    child.once("exit", (code, signal) => {
      // let stderr drain so the reason is in the message
      setTimeout(() => {
        finish(new Error(`media worker exited with ${code !== null ? `code ${code}` : `signal ${signal}`} before it was ready${stderrTail.length ? `: ${stderrTail.slice(-5).join(" | ")}` : ""}`));
      }, 50);
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, token, process: child, stop };
}
