/**
 * Client for the Python media worker (`services/media-worker`, spec 2.1 / 5.2 / 5.3).
 *
 * `startWorker` spawns the worker, writes a random token as one line on its standard input (which stays
 * open: the worker stops when it closes, R155), and waits for `AO_WORKER_READY port=<n>`.
 * `WorkerClient.submit` runs one job for a project:
 *
 *   1. policy: `process` with `{ op, provider: 'local' }` (transcription, image_proxy, video_proxy,
 *      ocr), evaluated by the repo with the system tz and `now`; a deny is audited through the repo
 *      and thrown as PolicyDeniedError before the worker is contacted. An allow is audited once per
 *      run of the job (R367): at its submission, not again when a pending job is resubmitted.
 *      `capture.download` is not evaluated here: the caller has already passed (and audited) a
 *      `capture` decision.
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
import type { EntityType, PolicyDecision, ProcessingOp } from "@ao/core";
import { decryptStream, encryptStream } from "./crypto/format.js";
import { copyFileAtomic, renameWithRetry } from "./fs/atomic.js";
import type { IndexDb } from "./index/db.js";
import {
  LOCKED_CODE, UNFINISHED, appendJobRecords, appendNewJobRecord, assertNoSecrets, claimJobRecord, compactJobJournal, errorCode, isPending, readJobJournal,
  refreshJobRows, upgradeLegacyJobs, upsertJobRow, type JobAbout, type JobRecord, type JobStatus, type ProjectKey, type StoredJob, type WorkerJobType,
} from "./job-journal.js";
import { PolicyDeniedError, ProjectLockedError } from "./repo/errors.js";
import { activeTemp, isStaleWorkDir } from "./tmp-registry.js";
import { authorizeProcessing, projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";
import { mediaWorkerSourceDir } from "./resources.js";

export type { JobAbout, JobRecord, WorkerJobType } from "./job-journal.js";

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
  /**
   * Aborting cancels the job (the worker kills its child processes); it is recorded cancelled.
   * Aborting with a JobInterruptedError as the reason stops it the same way but leaves it pending
   * (no final line): it runs again at the next resubmission (a close, a shutdown; Task 62).
   */
  signal?: AbortSignal;
  /** The job's id (a UUID the caller chose, Task 62); refused when the journal already has it. Default: a new one. */
  id?: string;
  /** What the job is for (recorded on every line of it, Task 62). */
  about?: JobAbout;
  /**
   * Runs once the outputs are in place and before the job is recorded done (Task 62): e.g. storing
   * them in the library. When it throws, the job is recorded failed and the error is thrown. A crash
   * during it leaves the job running in the journal, so it runs once more at the next launch.
   */
  finish?: (result: JobResult) => Promise<void>;
}

/** What a resubmission's `prepare` may add to a job it reruns, and be told how it ended (Task 62). */
export interface ResumeExtras {
  /** The input and output worked out again from the library as it is now (e.g. after a move). */
  input?: string;
  inputEncrypted?: boolean;
  output?: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  finish?: (result: JobResult) => Promise<void>;
  /** After the rerun: `claimed` false when another resubmission took the job first (nothing ran). */
  onEnd?: (outcome: { claimed: boolean; result?: JobResult; error?: unknown }) => void;
}

/**
 * The reason to abort a job's signal with to stop it without recording an outcome: the job stays
 * pending and runs again at the next resubmission (Task 62: a close or shutdown, R142's rerun).
 */
export class JobInterruptedError extends Error {
  override name = "JobInterruptedError";
  constructor() {
    super("the job was interrupted; it runs again when the library is next opened");
  }
}

/** Tells a rerun's `onEnd` how it ended (its own failure must not break the resubmission). */
function tell(extras: ResumeExtras, outcome: Parameters<NonNullable<ResumeExtras["onEnd"]>>[0]): void {
  try {
    extras.onEnd?.(outcome);
  } catch {
    // the caller's bookkeeping
  }
}

const isInterrupt = (signal: AbortSignal | undefined): boolean => !!signal?.aborted && signal.reason instanceof JobInterruptedError;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOSED = "the library was closed; the job runs again when it is next opened";

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

/**
 * A worker failure about one of the optional tools (Task 48a, R126), naming it by its catalogue id
 * (`ffmpeg`, `ocr`, `speech-small`, `video-downloader` ...): TOOL_NOT_INSTALLED on an ordinary job
 * whose tool is missing, or a failed install, update or removal. Still a WorkerJobError.
 */
export class WorkerToolError extends WorkerJobError {
  override name = "WorkerToolError";
  constructor(
    code: string,
    message: string,
    readonly tool: string,
    detail?: string,
  ) {
    super(code, message, detail);
  }
}

/** The error for a worker `{ code, message, detail?, tool? }`. */
function workerError(e: { code: string; message: string; detail?: string | undefined; tool?: string | undefined }): WorkerJobError {
  return typeof e.tool === "string" && e.tool ? new WorkerToolError(e.code, e.message, e.tool, e.detail) : new WorkerJobError(e.code, e.message, e.detail);
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
  error?: { code: string; message: string; detail?: string; tool?: string };
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Failed polls retried (with backoff) before the worker is treated as gone. */
const POLL_RETRIES = 3;

/** Job ids being run by any client of this process (a fast path; the journal claim is what guarantees one run). */
const claimed = new Set<string>();

/** Another resubmission claimed the job first (or it has finished): nothing to do. */
class NotClaimed extends Error {}

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

  constructor(opts: WorkerClientOptions) {
    this.repo = opts.repo;
    this.worker = opts.worker;
    this.index = opts.index;
    this.pollMs = opts.pollMs ?? 500;
  }

  /** Test seam: how many captured project keys running jobs hold (0 once every job has ended). */
  get heldKeys(): number {
    return this.keys.size;
  }

  /** Closed (Task 62): nothing more is written to any journal, nothing more is stored. */
  private closed = false;
  /** Journal writes and `finish` steps in progress (`close` waits for them). */
  private readonly writing = new Set<Promise<unknown>>();

  /** Runs one write unless the client is closed (then WorkerUnavailableError: the job stays pending). */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new WorkerUnavailableError(CLOSED);
    const p = fn();
    this.writing.add(p);
    try {
      return await p;
    } finally {
      this.writing.delete(p);
    }
  }

  /**
   * Closes the client before its library's lock is released (Task 62, N-5): from now on it appends
   * no journal line, stores nothing and starts nothing; resolves once the writes in progress have
   * ended. A job still running then gets no final line: it stays pending and runs again at the
   * next launch. Stop running jobs first (abort with JobInterruptedError) so the worker stops too.
   */
  async close(): Promise<void> {
    this.closed = true;
    while (this.writing.size) await Promise.allSettled([...this.writing]);
  }

  submit(projectId: string, job: WorkerJob): Promise<JobResult> {
    if (job.id !== undefined && !JOB_ID.test(job.id)) return Promise.reject(new TypeError("a worker job's id must be a UUID"));
    return this.run(job.id ?? randomUUID(), projectId, job, undefined, job.id !== undefined);
  }

  /**
   * Records a pending job (queued, running in no process, or cancelled by a lock) as cancelled, so
   * it is never run again (Task 62). Claimed like a rerun, so a resubmission and a cancel cannot
   * both win. False when the job is not pending, unknown, or running in this process (stop that
   * one through its signal instead).
   */
  async cancelPending(projectId: string, id: string): Promise<boolean> {
    if (this.closed) return false;
    return this.write(() => cancelPendingJob(this.repo, projectId, id, this.index));
  }

  /**
   * Resubmits jobs whose newest journal record is queued or running (the app quit or the worker
   * died before they finished). Call once at launch, before new submissions; stale worker temp
   * folders are removed. Works from the journals alone: rows written before the journal existed
   * are first written into them (`upgradeLegacyJobs`), each readable journal is compacted when
   * mostly superseded, and the index rows are made to match it. Journals of locked encrypted
   * projects cannot be read: their jobs stay pending (rows the index knows are reported with
   * ProjectLockedError). A read-only library is not written to: nothing is resumed. Jobs cancelled
   * because their project was locked before they started are resubmitted too (R142): the app calls
   * this for that one project (`projectId`) when it is unlocked, as registered work (R106).
   *
   * Each rerun is claimed in the journal first (`claimJobRecord`): of overlapping resubmissions
   * exactly one runs a given pending record; the others skip it. `shouldStop` is asked before each
   * job (a move or close stops resubmission between jobs; calling this again later continues).
   * `signal` is given to each rerun: aborted with JobInterruptedError, it stops the job in hand,
   * which stays pending, and no further job starts (Task 62, N-5). `prepare` may add progress, a
   * signal and a finish step to a rerun (e.g. storing a transcript) and is told how it ended.
   */
  async resumePending(
    projectId?: string,
    opts: { shouldStop?: () => boolean; signal?: AbortSignal; prepare?: (rec: JobRecord) => ResumeExtras | undefined | Promise<ResumeExtras | undefined> } = {},
  ): Promise<Array<{ id: string; projectId: string; result?: JobResult; error?: unknown }>> {
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write" || this.closed) return [];
    await this.removeStaleTemp();
    const db = this.db();
    if (db) await this.write(() => upgradeLegacyJobs(db, library.root, { get: (keyId: string) => this.keyById(keyId) })).catch(() => undefined);
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
        await this.write(() => compactJobJournal(library.root, p.folder, p.id, key));
        const journal = await this.write(() => refreshJobRows(() => this.db(), library.root, p.folder, p.id, key));
        for (const r of journal.records.values()) if (isPending(r)) todo.push(r);
      } catch (error) {
        out.push({ id: "", projectId: p.id, error });
      }
    }
    todo.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
    for (const rec of todo) {
      if (opts.shouldStop?.() || opts.signal?.aborted || this.closed) break;
      if (claimed.has(rec.id)) continue; // running in this process now
      if (rec.kind === "capture.download" || !rec.job) {
        // Never resumed: a capture's caller (and the capture decision it made) is gone, and its
        // output folder has been swept; the researcher captures the link again. A record without
        // its job (from before the journal, unreadable) cannot run again either.
        const code = rec.kind === "capture.download" ? "INTERRUPTED" : "UNRECOVERABLE";
        const ok = await this.claim(rec, { ...this.next(rec, "failed", code), attempt: randomUUID() }).catch(() => false);
        if (!ok) continue;
        out.push({
          id: rec.id,
          projectId: rec.projectId,
          error: new WorkerJobError(code, code === "INTERRUPTED" ? "the capture was interrupted; capture the link again" : "the job's record cannot be read; start it again"),
        });
        continue;
      }
      let extras: ResumeExtras;
      try {
        extras = (await opts.prepare?.(rec)) ?? {};
      } catch (error) {
        out.push({ id: rec.id, projectId: rec.projectId, error }); // left pending, as it was
        continue;
      }
      const signals = [opts.signal, extras.signal].filter((s): s is AbortSignal => s !== undefined);
      const job: WorkerJob = {
        ...rec.job,
        ...(extras.input !== undefined ? { input: extras.input, inputEncrypted: extras.inputEncrypted === true } : {}),
        ...(extras.output !== undefined ? { output: extras.output } : {}),
        ...(extras.onProgress ? { onProgress: extras.onProgress } : {}),
        ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}),
        ...(extras.finish ? { finish: extras.finish } : {}),
      };
      try {
        const result = await this.run(rec.id, rec.projectId, job, rec);
        tell(extras, { claimed: true, result });
        out.push({ id: rec.id, projectId: rec.projectId, result });
      } catch (error) {
        const took = !(error instanceof NotClaimed);
        tell(extras, { claimed: took, error });
        if (took) out.push({ id: rec.id, projectId: rec.projectId, error });
      }
    }
    return out;
  }

  // ---- internals ----

  private async run(id: string, projectId: string, job: WorkerJob, resumed?: JobRecord, chosenId = false): Promise<JobResult> {
    if (this.closed) throw new WorkerUnavailableError(CLOSED);
    if (claimed.has(id)) throw new WorkerJobError("ALREADY_RUNNING", "the job is already running");
    claimed.add(id);
    try {
      return await this.runClaimed(id, projectId, job, resumed, chosenId);
    } finally {
      claimed.delete(id);
    }
  }

  private async runClaimed(id: string, projectId: string, job: WorkerJob, resumed: JobRecord | undefined, chosenId: boolean): Promise<JobResult> {
    let decision: PolicyDecision | undefined;
    try {
      const op = JOB_OPS[job.type];
      if (op === undefined) throw new TypeError(`unknown worker job type "${String(job.type)}"`);
      assertNoSecrets(job.params ?? {}); // job records are kept in files: never a secret (R31)
      if (op !== null) {
        // R367: an allow is audited here, once per run of the job: when it is first submitted, not
        // when a pending job is run again (after a restart, an unlock or an interrupt it is the
        // same run, under the same journal record). The entry names the job's kind, its entity and
        // the processing asked for; nothing of the content. A deny is audited every time.
        const processing = { op, provider: "local" } as const;
        decision = await authorizeProcessing(
          this.repo,
          projectId,
          { action: "process", process: processing },
          { op: `worker.${job.type}`, entity: job.entity, ...(resumed ? {} : { auditAllow: { details: { process: processing } } }) },
        );
      }
    } catch (err) {
      // Task 62 (I3): a rerun refused for good (the rules, a job that can never run) ends with that
      // reason, claimed once in the journal, so no later launch evaluates (and audits) it again.
      if (resumed && (err instanceof PolicyDeniedError || err instanceof TypeError)) {
        const code = err instanceof PolicyDeniedError ? "POLICY_DENIED" : "UNRECOVERABLE";
        await this.claim(resumed, { ...this.next(resumed, "failed", code), attempt: randomUUID() }).catch(() => false);
      }
      throw err;
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
    const first: JobRecord = { v: 1, id, projectId, kind: stored.type, status: "queued", createdAt: now, updatedAt: now, job: stored, ...(job.about ? { about: job.about } : {}) };
    this.records.set(id, resumed ?? first);
    try {
      if (resumed) {
        // A rerun: claimed in the journal, once (R142); a second resubmission finds the claim.
        const next: JobRecord = { ...this.next(resumed, "queued"), attempt: randomUUID() };
        if (!(await this.claim(resumed, next, dataKey))) throw new NotClaimed();
        this.records.set(id, next);
      } else if (chosenId) {
        // An id the caller chose is used once: never a second job under the same record.
        if (!(await this.appendFirst(first, dataKey))) throw new WorkerJobError("ALREADY_RUNNING", "a job with this id is already recorded");
      } else {
        await this.transition(id, "queued");
      }
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
      // R142: a job whose project is locked before it starts does not start (and decrypts nothing);
      // it runs again at the next unlock.
      if (lockedNow()) await this.cancelForLock(id, projectId);
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

      if (job.signal?.aborted) throw isInterrupt(job.signal) ? (job.signal.reason as JobInterruptedError) : new WorkerJobError("CANCELLED", "the job was cancelled");
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

      if (state.status === "cancelled") throw isInterrupt(job.signal) ? (job.signal!.reason as JobInterruptedError) : new WorkerJobError("CANCELLED", "the job was cancelled");
      if (state.status === "failed") {
        throw workerError(state.error ?? { code: "FAILED", message: "the job failed" });
      }
      // R142 (Task 62, I2): a job whose finish step stores into the library cannot finish on a
      // project locked by now: nothing is published or stored, it is recorded cancelled-locked (its
      // job kept) and runs once at the next unlock. A job without one finishes with its captured key.
      if (job.finish && lockedNow()) await this.cancelForLock(id, projectId);
      // Publishing, the finish step and the `done` line are one guarded write (M8, M9): a closed
      // client starts none of them (the job stays pending), and `close()` waits for all of them.
      return await this.write(async () => {
        const files = await publish(outDir, finalBase, dataKey);
        const meta = rewritePaths(state.result?.meta ?? {}, outDir, finalBase) as Record<string, unknown>;
        const result: JobResult = { id, type: job.type, output: job.output, files, meta, encrypted: dataKey !== null };
        if (job.finish) {
          try {
            await job.finish(result);
          } catch (err) {
            if (err instanceof ProjectLockedError || lockedNow()) {
              await this.transition(id, "cancelled", LOCKED_CODE, true, false);
              throw new ProjectLockedError(projectId);
            }
            throw err;
          }
        }
        await this.transition(id, "done", undefined, false, false);
        return result;
      });
    } catch (err) {
      const recorded = this.records.get(id)?.status;
      // Not recorded: a worker that went away, an interrupt or a close leave the job pending.
      if (!(err instanceof WorkerUnavailableError) && !(err instanceof JobInterruptedError) && recorded !== undefined && UNFINISHED.has(recorded)) {
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

  /** The job's next state, from its current record (finished jobs keep no paths or parameters). */
  private next(prev: JobRecord, status: JobStatus, error?: string, keepJob = false): JobRecord {
    const { job, error: _previous, ...base } = prev;
    return {
      ...base,
      status,
      updatedAt: new Date().toISOString(),
      ...((UNFINISHED.has(status) || keepJob) && job ? { job } : {}),
      ...(error && !UNFINISHED.has(status) ? { error } : {}),
    };
  }

  /** Claims a pending record for one run (see claimJobRecord); then updates its cache row. */
  private async claim(expected: JobRecord, next: JobRecord, key?: ProjectKey): Promise<boolean> {
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write") return false;
    const k = key !== undefined ? key : projectDataKey(this.repo, expected.projectId);
    return this.write(async () => {
      if (!(await claimJobRecord(library.root, this.repo.getProject(expected.projectId).folder, k, expected, next))) return false;
      const db = this.db();
      if (db) upsertJobRow(db, next);
      return true;
    });
  }

  /** The first record of a job whose id the caller chose: appended only if the id is new. */
  private async appendFirst(rec: JobRecord, key: ProjectKey): Promise<boolean> {
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write") return true; // a read-only library records nothing
    return this.write(async () => {
      if (!(await appendNewJobRecord(library.root, this.repo.getProject(rec.projectId).folder, key, rec))) return false;
      const db = this.db();
      if (db) upsertJobRow(db, rec);
      return true;
    });
  }

  /**
   * The one writer of job records: appends the job's new state to its project's journal (sealed
   * in encrypted projects), then updates the cache row. Finished jobs keep no paths or parameters.
   * Nothing is written in a read-only library. Throws (writing nothing more) when the journal
   * cannot be appended, e.g. the project was locked meanwhile.
   */
  private async transition(id: string, status: JobStatus, error?: string, keepJob = false, guarded = true): Promise<void> {
    const prev = this.records.get(id);
    if (!prev) return;
    const library = repoLibrary(this.repo);
    if (library.mode !== "read-write") return;
    const rec = this.next(prev, status, error, keepJob);
    // The job's captured key (R142), else the project's (ProjectLockedError while locked).
    const key = this.keys.get(id) ?? projectDataKey(this.repo, prev.projectId);
    const append = async () => {
      await appendJobRecords(library.root, this.repo.getProject(prev.projectId).folder, key, [rec]);
      this.records.set(id, rec);
      const db = this.db();
      if (db) upsertJobRow(db, rec);
    };
    // Unguarded only from inside a guarded write (the step it ends is already tracked).
    await (guarded ? this.write(append) : append());
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

/**
 * WorkerClient.cancelPending without a client (the media worker need not be running): records a
 * pending job of the project as cancelled (`CANCELLED`, its job dropped), claimed in the journal's
 * turn so that a resubmission and the cancel cannot both win. False when it is not pending, is
 * unknown, is running in this process, or the library is read-only.
 */
export async function cancelPendingJob(repo: Repo, projectId: string, id: string, index?: { readonly db: IndexDb }): Promise<boolean> {
  const library = repoLibrary(repo);
  if (library.mode !== "read-write" || claimed.has(id)) return false;
  const key = projectDataKey(repo, projectId);
  const folder = repo.getProject(projectId).folder;
  const rec = (await readJobJournal(library.root, folder, projectId, key)).records.get(id);
  if (!rec || !isPending(rec)) return false;
  const { job: _job, error: _error, ...base } = rec;
  const next: JobRecord = { ...base, status: "cancelled", updatedAt: new Date().toISOString(), error: "CANCELLED", attempt: randomUUID() };
  if (!(await claimJobRecord(library.root, folder, key, rec, next))) return false;
  const db = index?.db;
  if (db?.open) upsertJobRow(db, next);
  return true;
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

// ---------- the optional tools (Task 48a, R126) ----------

export type ToolAction = "install" | "update" | "remove";

const TOOL_ID = /^[a-z0-9-]{1,64}$/;

async function workerRequest<T>(worker: WorkerEndpoint, method: "GET" | "POST", path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(worker.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${worker.token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
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
    const e = (json as { error?: { code?: string; message?: string; detail?: string; tool?: string } } | undefined)?.error;
    throw workerError({ code: e?.code ?? `HTTP_${res.status}`, message: e?.message ?? `the media worker answered ${res.status}`, detail: e?.detail, tool: e?.tool });
  }
  return json as T;
}

/**
 * The worker's optional tools, not bound to any library: the catalogue (`GET /tools`), and
 * installing, updating and removing a tool as a worker job (`POST /tools/<id>/<action>`, then
 * `GET /jobs/<id>` until it ends) with progress and cancel. Downloads go to the tools and models
 * folders the worker was started with, never into a library.
 */
export class WorkerToolsClient {
  private readonly pollMs: number;
  private readonly cancelGraceMs: number;

  /**
   * `cancelGraceMs`: how long the worker may take to confirm a cancel (default 2 min) before the job
   * is given up on as CANCEL_UNCONFIRMED (not CANCELLED: only the worker says it stopped).
   */
  constructor(
    private readonly worker: WorkerEndpoint,
    opts: { pollMs?: number; cancelGraceMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? 500;
    this.cancelGraceMs = opts.cancelGraceMs ?? 120_000;
  }

  /** `GET /tools`: every optional tool with its purpose, size, version and whether it is installed. */
  catalogue<T = unknown>(): Promise<T> {
    return workerRequest<T>(this.worker, "GET", "/tools");
  }

  /** `POST /tools/update` (ADR 0009: yt-dlp updates itself in place). Failures keep the worker's code. */
  updateCaptureTools<T = unknown>(): Promise<T> {
    return workerRequest<T>(this.worker, "POST", "/tools/update");
  }

  /** Runs one install, update or removal to its end; the result is the worker job's result. */
  async run(action: ToolAction, toolId: string, opts: { onProgress?: (progress: number) => void; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!TOOL_ID.test(toolId)) throw new WorkerJobError("UNKNOWN_TOOL", "there is no such tool");
    if (opts.signal?.aborted) throw new WorkerJobError("CANCELLED", "the job was cancelled");
    const { id } = await workerRequest<{ id: string }>(this.worker, "POST", `/tools/${toolId}/${action}`);
    const jobPath = `/jobs/${encodeURIComponent(id)}`;
    let cancelSent = 0;
    let last = -1;
    let failures = 0;
    for (;;) {
      if (opts.signal?.aborted && !cancelSent) {
        cancelSent = Date.now();
        await workerRequest(this.worker, "POST", `${jobPath}/cancel`).catch(() => {});
      }
      // A job the worker does not end after a cancel is not waited for for ever.
      if (cancelSent && Date.now() - cancelSent > this.cancelGraceMs) throw new WorkerJobError("CANCEL_UNCONFIRMED", "the media worker did not confirm that the job stopped");
      await new Promise((r) => setTimeout(r, this.pollMs));
      let state: WorkerJobState;
      try {
        state = await workerRequest<WorkerJobState>(this.worker, "GET", jobPath);
        failures = 0;
      } catch (err) {
        if (!(err instanceof WorkerUnavailableError) || ++failures > POLL_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, this.pollMs * 2 ** failures));
        continue;
      }
      if (typeof state.progress === "number" && state.progress !== last && state.status === "running") {
        last = state.progress;
        try {
          opts.onProgress?.(state.progress);
        } catch {
          // a progress callback must not break the job
        }
      }
      if (state.status === "done") return (state.result ?? {}) as unknown as Record<string, unknown>;
      if (state.status === "cancelled") throw new WorkerJobError("CANCELLED", "the job was cancelled");
      if (state.status === "failed") throw workerError(state.error ?? { code: "FAILED", message: "the job failed" });
    }
  }
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

/** The media worker's source folder (its dev venv); none in a built folder, where AO_WORKER_BIN is required. */
const workerDir = (): string => {
  const dir = mediaWorkerSourceDir();
  if (!dir) throw new Error("The media worker is not configured: set AO_WORKER_BIN to the packaged worker.");
  return dir;
};
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
// AO_SERVICE_TOKEN: the library service refuses to start with it set (it takes its token on standard
// input, R98), so it cannot be here; denied anyway, in case another host process ever sets it.
const WORKER_ENV_DENY = new Set(["AO_WORKER_TOKEN", "AO_PASSPHRASE", "AO_SERVICE_TOKEN"]);

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
  return join(workerDir(), ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
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
      cwd = workerDir();
    }
  }
  const token = randomBytes(32).toString("hex");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    // The token travels on standard input only, as one line (R98, R155); the worker refuses one in
    // its environment or arguments. Standard input then stays open for the worker's whole life: the
    // worker stops when it closes, so this process exiting, crashing or being killed leaves no worker.
    env: {
      ...workerEnv(process.env),
      ...opts.env,
      AO_WORKER_PORT: "0",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin!.on("error", () => {}); // the worker gone early: its exit is reported below
  child.stdin!.write(`${token}\n`);
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
