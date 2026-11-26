/**
 * Transcriptions as jobs (Task 62, R99, R142, R106): the service's view of each running or recent
 * transcription, over the job records of the project's journal.
 *
 * - A transcription is a worker job recorded in its project's job journal under the id the
 *   interface follows; it runs as registered work (`transcription`, or `worker-resume` when it is a
 *   rerun of a pending one). A move stops every one at once, whatever started it, once nothing else
 *   refuses the move (FR-385; R466 I1, M1), and it stays pending in its project's journal. What
 *   happens next depends on the move (R466 M2): when the move goes through, it runs again once the
 *   library is open at its new place — for an encrypted project only once that project is unlocked
 *   there; when its project was left behind by a split move, it stays with the old copy, now a
 *   library of its own, and runs when that library is opened; when the move fails after the stop,
 *   it runs again at once in the library still open. A close or shutdown abandons it, leaving it
 *   pending to run again at the next open (Task 62, N-5).
 * - At most one per source: `reserve` takes the source synchronously, before anything is awaited,
 *   so of two requests at once exactly one passes; the route then refuses a source whose journal
 *   still holds a pending transcription (from before a restart, or cancelled by a lock, R142).
 * - Live state (progress, the cancel request, the result) is held here for this run of the service;
 *   the journal holds the status, so after a reload or a restart `fromRecord` reads it back.
 * - Progress is published as `job.progress` events of kind `transcription`, at most once per whole
 *   percent, and at every change of status.
 */
import { randomUUID } from "node:crypto";
import {
  JobInterruptedError,
  ProjectLockedError,
  WorkerJobError,
  WorkerUnavailableError,
  transcriptionJob,
  transcriptionRecords,
  transcriptionRerun,
  type JobRecord,
  type ResumeExtras,
  type StoredTranscript,
  type TranscriptionParams,
  type WorkerClient,
} from "@ao/library";
import { TRANSCRIPTION_RUNNING, type TranscriptionJob, type TranscriptionProgressEvent } from "@ao/shared";
import { ApiError, errorBody, toApiError } from "./errors.js";
import type { ServiceState, Session } from "./state.js";

const TOOL_MESSAGE = "A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.";
const CANCELLED = { code: "CANCELLED", message: "The transcription was stopped before it finished. Nothing was saved." };
const LOCKED = { code: "PROJECT_LOCKED", message: "The project was locked before the transcription could finish, so nothing was saved. It runs again when the project is unlocked.", reason: "PROJECT_LOCKED" };
const DENIED_MESSAGE = "This project's rules do not allow that.";
/** Plain words for the fixed codes a failed transcription's journal line can hold (M11); worker codes are the media helper's. */
const RECORDED: Record<string, string> = {
  FAILED: "The transcription could not be finished, and nothing was saved. Try again.",
  UNRECOVERABLE: "This transcription's record cannot be read, so it cannot run again. Start it again.",
  INTERRUPTED: "The transcription was interrupted before it finished. Nothing was saved; start it again.",
};
/** Finished transcriptions kept for a reloaded interface (this run of the service only). */
const KEEP_FINISHED = 200;

export const busyError = () =>
  new ApiError(409, "CONFLICT", "This recording is already being transcribed. Wait until that has finished, or cancel it, before starting another.", TRANSCRIPTION_RUNNING);

interface Live {
  job: TranscriptionJob;
  lib: object;
  /** Whether the job's project is unlocked now (nothing of a locked project goes into an event, M10). */
  unlocked: () => boolean;
  ac: AbortController;
  percent: number;
  /** Removed from the registry (its project was locked): what the run does next is not followed here. */
  forgotten?: boolean;
}

/**
 * The state recorded in the journal, for a job this run of the service does not hold. `runningHere`: a worker
 * client of this process is running it now (a run that went on through a lock and an unlock, R466 M6).
 */
export function fromRecord(rec: JobRecord, runningHere = false): TranscriptionJob {
  const model = rec.about?.model;
  const job: TranscriptionJob = {
    jobId: rec.id,
    projectId: rec.projectId,
    sourceId: rec.about?.sourceId ?? "",
    ...(model ? { model } : {}),
    // Pending in the journal and run by no one now (M2): waiting to run again, not "running".
    status: rec.status === "running" ? (runningHere ? "running" : "queued") : rec.status,
    ...((rec.status === "running" || rec.status === "queued") && !runningHere ? { waiting: true } : {}),
    startedAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (rec.status === "cancelled") job.error = rec.error === "PROJECT_LOCKED" ? { ...LOCKED } : { ...CANCELLED };
  if (rec.status === "failed") {
    const code = rec.error ?? "FAILED";
    job.error =
      code === "TOOL_NOT_INSTALLED"
        ? { code, message: TOOL_MESSAGE, ...(model ? { reason: `speech-${model}` } : {}) }
        : code === "POLICY_DENIED"
          ? { code, message: DENIED_MESSAGE }
          : RECORDED[code] !== undefined
            ? { code, message: RECORDED[code] }
            : { code: "INTERNAL", message: "The media helper could not finish the job.", reason: code };
  }
  return job;
}

export class Transcriptions {
  private readonly live = new Map<string, Live>();
  /** Per source (project and source id): the live job's id, or a reservation token. */
  private readonly bySource = new Map<string, string | symbol>();
  /** Told when a job this run holds has ended (whenEnded). */
  private readonly waiters = new Map<string, Set<(job: TranscriptionJob) => void>>();
  /** Per source key: told when a reservation becomes a job (its id) or is given up (undefined) (whenStarted). */
  private readonly starts = new Map<string, Set<(jobId: string | undefined) => void>>();

  constructor(private readonly state: ServiceState) {}

  private key(projectId: string, sourceId: string): string {
    return `${projectId}\u0000${sourceId}`;
  }

  /** The job this run of the service holds for the source (the newest), if any. */
  current(projectId: string, sourceId: string, lib: object): TranscriptionJob | undefined {
    let found: Live | undefined;
    for (const l of this.live.values()) if (l.lib === lib && l.job.projectId === projectId && l.job.sourceId === sourceId) found = l;
    return found ? { ...found.job } : undefined;
  }

  byId(jobId: string, lib: object): TranscriptionJob | undefined {
    const l = this.live.get(jobId);
    return l && l.lib === lib ? { ...l.job } : undefined;
  }

  private active(l: Live | undefined): boolean {
    return !!l && (l.job.status === "queued" || l.job.status === "running");
  }

  /**
   * Takes the source for a new transcription, synchronously (409 when one is queued or running in
   * this run of the service). Returns the release, for a start that does not go ahead.
   */
  reserve(projectId: string, sourceId: string): { token: symbol; release: () => void } {
    const key = this.key(projectId, sourceId);
    const held = this.bySource.get(key);
    if (typeof held === "symbol" || (typeof held === "string" && this.active(this.live.get(held)))) throw busyError();
    const token = Symbol("reserved");
    this.bySource.set(key, token);
    return {
      token,
      release: () => {
        if (this.bySource.get(key) !== token) return;
        this.bySource.delete(key);
        this.told(key, undefined);
      },
    };
  }

  /** Starts a reserved transcription as registered work and returns its first state. */
  async start(s: Session, client: WorkerClient, projectId: string, sourceId: string, params: TranscriptionParams, token: symbol): Promise<TranscriptionJob> {
    const id = randomUUID();
    let entry: Live | undefined;
    const job = await transcriptionJob(s.repo, projectId, sourceId, params, { id, onStored: (st) => entry && this.stored(entry, st) });
    const key = this.key(projectId, sourceId);
    if (this.bySource.get(key) !== token) throw busyError(); // released meanwhile (a close, a lock)
    // Locked meanwhile (R692 M4): nothing of the project is tracked or kept here.
    if (!s.repo.isUnlocked(projectId)) {
      this.bySource.delete(key);
      this.told(key, undefined);
      throw new ProjectLockedError(projectId);
    }
    entry = this.track(s, id, projectId, sourceId, typeof job.about?.model === "string" ? job.about.model : undefined);
    const live = entry;
    void this.state.startWork("transcription", async (ctl) => {
      ctl.interrupt = () => live.ac.abort(new JobInterruptedError());
      try {
        await client.submit(projectId, { ...job, signal: live.ac.signal, onProgress: (p) => this.progress(live, p) });
        this.finish(live, "done");
      } catch (err) {
        this.failed(live, err);
      }
    });
    return { ...entry.job };
  }

  /**
   * For the rerun of interrupted jobs (state.resumeWorkerJobs): a pending transcription runs again
   * with its finish step, held here like a new one. A transcription whose source or recording is
   * gone is cancelled rather than run with nothing to store it in.
   */
  async rerun(s: Session, rec: JobRecord): Promise<ResumeExtras | undefined> {
    if (rec.kind !== "audio.transcribe" || !rec.about?.sourceId) return undefined;
    const sourceId = rec.about.sourceId;
    let entry: Live | undefined;
    // Undefined only when the source or its recording is gone; any other error is thrown and the
    // record stays pending for the next resubmission (M12).
    const extras = await transcriptionRerun(s.repo, rec, (st) => entry && this.stored(entry, st));
    if (!extras) {
      const ac = new AbortController();
      ac.abort();
      return { signal: ac.signal };
    }
    entry = this.track(s, rec.id, rec.projectId, sourceId, rec.about.model, rec.createdAt);
    const live = entry;
    return {
      ...extras,
      signal: live.ac.signal,
      onProgress: (p) => this.progress(live, p),
      onEnd: (o) => {
        if (!o.claimed) {
          // Another resubmission runs it: it is not ours to show.
          this.live.delete(live.job.jobId);
          if (this.bySource.get(this.key(live.job.projectId, sourceId)) === live.job.jobId) this.bySource.delete(this.key(live.job.projectId, sourceId));
          return;
        }
        if (o.error === undefined) this.finish(live, "done");
        else this.failed(live, o.error);
      },
    };
  }

  /**
   * Asks a transcription this run holds to stop (the worker confirms it, then it is recorded
   * cancelled). False when this run does not hold it as queued or running.
   */
  cancel(jobId: string, lib: object): TranscriptionJob | undefined {
    const l = this.live.get(jobId);
    if (!l || l.lib !== lib || !this.active(l)) return undefined;
    if (!l.job.cancelRequested) {
      l.job.cancelRequested = true;
      l.job.updatedAt = new Date().toISOString();
      l.ac.abort();
      this.publish(l);
    }
    return { ...l.job };
  }

  /**
   * Resolves with the job once it has ended (done, failed, or cancelled — except cancelled by a lock, which runs again
   * at the unlock, R142): at once when the journal record has ended, else when the run this service holds (a new one,
   * or a rerun of a pending one) ends. A job left pending (interrupted, the media helper gone) is waited for until it
   * runs again. `signal` gives up the wait (it rejects with the signal's reason).
   */
  whenEnded(s: Session, projectId: string, jobId: string, signal?: AbortSignal): Promise<TranscriptionJob> {
    return new Promise<TranscriptionJob>((resolve, reject) => {
      const set = this.waiters.get(jobId) ?? new Set();
      this.waiters.set(jobId, set);
      let settled = false;
      const cleanup = () => {
        settled = true;
        set.delete(done);
        if (set.size === 0 && this.waiters.get(jobId) === set) this.waiters.delete(jobId);
        signal?.removeEventListener("abort", aborted);
      };
      const done = (job: TranscriptionJob) => {
        if (settled) return;
        cleanup();
        resolve(job);
      };
      const aborted = () => {
        if (settled) return;
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("the wait was given up"));
      };
      if (signal?.aborted) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      set.add(done);
      // Registered first, then the journal read: an end between the two is not missed.
      transcriptionRecords(s.repo, projectId).then(
        (recs) => {
          const rec = recs.find((r) => r.id === jobId);
          if (rec && recordEnded(rec)) done(fromRecord(rec));
        },
        (err: unknown) => {
          if (settled) return;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * For a source taken by a start at this moment (`reserve` refused): resolves with the job's id once that start has
   * made it, or with undefined when the start gave up (or nothing holds the source any more). A job already queued or
   * running for the source is answered at once. `signal` gives up the wait (R692 M3).
   */
  whenStarted(projectId: string, sourceId: string, signal?: AbortSignal): Promise<string | undefined> {
    const key = this.key(projectId, sourceId);
    return new Promise<string | undefined>((resolve, reject) => {
      const held = this.bySource.get(key);
      if (typeof held === "string" && this.active(this.live.get(held))) return resolve(held);
      if (typeof held !== "symbol") return resolve(undefined);
      if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("the wait was given up"));
      const set = this.starts.get(key) ?? new Set();
      this.starts.set(key, set);
      const cleanup = () => {
        set.delete(done);
        if (set.size === 0 && this.starts.get(key) === set) this.starts.delete(key);
        signal?.removeEventListener("abort", aborted);
      };
      const done = (jobId: string | undefined) => {
        cleanup();
        resolve(jobId);
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("the wait was given up"));
      };
      signal?.addEventListener("abort", aborted, { once: true });
      set.add(done);
    });
  }

  private told(key: string, jobId: string | undefined): void {
    const set = this.starts.get(key);
    if (set) for (const fn of [...set]) fn(jobId);
  }

  /** What this run holds, for tests and diagnostics: the live jobs' and held sources' project ids; the waited job ids, and the projects of waited starts. */
  memory(): { live: string[]; waiters: string[]; sources: string[] } {
    return {
      live: [...this.live.values()].map((l) => l.job.projectId),
      waiters: [...this.waiters.keys(), ...[...this.starts.keys()].map((k) => k.split("\u0000")[0]!)],
      sources: [...this.bySource.keys()].map((k) => k.split("\u0000")[0]!),
    };
  }

  /** Forgets everything held for a library that was closed (its jobs stay in its journal). */
  forget(lib: object): void {
    this.drop((l) => l.lib === lib);
  }

  /**
   * Forgets everything held for a project at its lock (R1-2; R30, R50): what a locked project was
   * doing does not stay in memory. A run the lock interrupts is remembered by the project's journal
   * (R142: cancelled-locked), rerun once at the unlock and followed again from there; until then GET
   * reads the journal. Another project's entries are untouched.
   */
  forgetProject(projectId: string): void {
    this.drop((l) => l.job.projectId === projectId);
  }

  /** Forgets one job this run holds (its state is then read from the journal). */
  forgetJob(jobId: string): void {
    this.drop((l) => l.job.jobId === jobId);
  }

  private drop(which: (l: Live) => boolean): void {
    for (const [id, l] of this.live) {
      if (!which(l)) continue;
      l.forgotten = true;
      this.live.delete(id);
    }
    for (const [key, v] of this.bySource) {
      if (typeof v !== "symbol" && this.live.has(v)) continue;
      this.bySource.delete(key);
      if (typeof v === "symbol") this.told(key, undefined);
    }
  }

  // ---- internals ----

  private track(s: Session, id: string, projectId: string, sourceId: string, model: string | undefined, startedAt = new Date().toISOString()): Live {
    const entry: Live = {
      job: { jobId: id, projectId, sourceId, ...(model ? { model } : {}), status: "queued", startedAt, updatedAt: new Date().toISOString() },
      lib: s.lib,
      unlocked: () => s.repo.isUnlocked(projectId),
      ac: new AbortController(),
      percent: -1,
    };
    this.live.set(id, entry);
    this.bySource.set(this.key(projectId, sourceId), id);
    this.told(this.key(projectId, sourceId), id);
    this.prune();
    this.publish(entry);
    this.state.updateKeepAwake(); // a job the list follows is live again (R692 M5)
    return entry;
  }

  private progress(l: Live, p: number): void {
    if (l.forgotten && !this.readopt(l)) return;
    if (!this.active(l) || l.ac.signal.aborted) return;
    const percent = Math.max(0, Math.min(100, Math.floor(p * 100)));
    const changed = l.job.status !== "running" || percent > l.percent;
    if (!changed) return;
    l.job.status = "running";
    l.job.progress = Math.min(1, Math.max(0, p));
    l.job.updatedAt = new Date().toISOString();
    l.percent = percent;
    this.publish(l);
  }

  /**
   * A run forgotten at its project's lock that goes on after the unlock (its worker run kept its own copy of the
   * key, R142) is followed again from its next progress (R466 M6): nothing of it was held while the project was
   * locked. Only in the library it was started in, and only while its project is unlocked.
   */
  private readopt(l: Live): boolean {
    let unlocked = false;
    try {
      unlocked = l.unlocked();
    } catch {
      // the project is gone
    }
    if (!unlocked || this.state.session?.lib !== l.lib || this.live.has(l.job.jobId)) return false;
    l.forgotten = false;
    this.live.set(l.job.jobId, l);
    this.bySource.set(this.key(l.job.projectId, l.job.sourceId), l.job.jobId);
    return true;
  }

  private stored(l: Live, st: StoredTranscript): void {
    if (l.forgotten) return;
    l.job.result = { files: [...st.files], flaggedSegments: st.flaggedSegments };
  }

  private finish(l: Live, status: "done"): void {
    l.job.status = status;
    l.job.progress = 1;
    delete l.job.cancelRequested;
    this.end(l);
  }

  private failed(l: Live, err: unknown): void {
    if (l.forgotten) return this.endForgotten(l);
    if (err instanceof JobInterruptedError || err instanceof WorkerUnavailableError) {
      // Left pending in the journal (an interrupt, a close, the media helper gone): it runs again
      // at the next open or when the media helper is back; this run no longer holds it.
      this.live.delete(l.job.jobId);
      const key = this.key(l.job.projectId, l.job.sourceId);
      if (this.bySource.get(key) === l.job.jobId) this.bySource.delete(key);
      this.send(l, { ...l.job, status: "queued", waiting: true }, true);
      return;
    }
    if (err instanceof WorkerJobError && err.code === "CANCELLED") {
      l.job.status = "cancelled";
      l.job.error = { ...CANCELLED };
    } else if (err instanceof ProjectLockedError) {
      l.job.status = "cancelled";
      l.job.error = { ...LOCKED };
    } else {
      l.job.status = "failed";
      l.job.error = errorBody(toApiError(err), this.state.roots).error;
    }
    delete l.job.cancelRequested;
    this.end(l);
  }

  private end(l: Live): void {
    if (l.forgotten) return this.endForgotten(l);
    l.job.updatedAt = new Date().toISOString();
    const key = this.key(l.job.projectId, l.job.sourceId);
    if (this.bySource.get(key) === l.job.jobId) this.bySource.delete(key);
    this.publish(l);
    const waiting = this.waiters.get(l.job.jobId);
    if (waiting) for (const fn of [...waiting]) fn({ ...l.job });
  }

  /**
   * A run forgotten at its project's lock has ended: a bare event (its id only, nothing of the
   * project) tells an open viewer to read the journal again, which now holds how it ended.
   */
  private endForgotten(l: Live): void {
    this.state.events.publish("job.progress", { kind: "transcription", jobId: l.job.jobId, done: 0, total: 100, finished: true });
  }

  private publish(l: Live): void {
    this.send(l, { ...l.job }, !this.active(l));
  }

  /** A job's event; for a locked project only that the job left the jobs indicator (M10). */
  private send(l: Live, job: TranscriptionJob, finished: boolean): void {
    let unlocked = false;
    try {
      unlocked = l.unlocked();
    } catch {
      // the project is gone
    }
    this.state.events.publish("job.progress", unlocked ? event(job, finished) : { kind: "transcription", jobId: job.jobId, done: 0, total: 100, finished: true });
  }

  private prune(): void {
    const finished = [...this.live.values()].filter((l) => !this.active(l));
    for (const l of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.live.delete(l.job.jobId);
  }
}

/** A job record that has ended for good (a cancel by a lock is pending: it runs again at the unlock, R142). */
function recordEnded(rec: JobRecord): boolean {
  return rec.status === "done" || rec.status === "failed" || (rec.status === "cancelled" && rec.error !== "PROJECT_LOCKED");
}

function event(job: TranscriptionJob, finished: boolean): TranscriptionProgressEvent & Record<string, unknown> {
  return { kind: "transcription", jobId: job.jobId, projectId: job.projectId, job, done: Math.round((job.progress ?? 0) * 100), total: 100, finished };
}
