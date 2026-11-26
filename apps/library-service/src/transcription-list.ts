/**
 * The project's transcription list, run by the service (whole channels, Task 7; R668, R669, R672, R679): the
 * sources on the list (packages/library lists/transcription-list.ts, written to the project's job journal) are
 * transcribed one at a time, in the order they were put on it, by the existing transcription jobs
 * (`Transcriptions`).
 *
 * - **The loop**, one per project, is registered work (`transcription-list`). It takes the head entry, starts its
 *   transcription (or follows the one already running for it: after a restart, an unlock, or one started by hand),
 *   awaits its end and records it on the entry; then the next. A source gone before its turn, or one without a
 *   recording, ends as cancelled and the list goes on (Review Focus 5). A refusal by the project's rules fails the
 *   entry (POLICY_DENIED) and pauses the list. An entry is never failed with the bare UNRECOVERABLE (R672).
 * - **Pause** lets the transcription in hand finish, then the loop ends. **Stop** empties the list and cancels the
 *   transcription in hand. A Stop that falls between the start of a job and the mark of its entry: the mark answers
 *   false and the loop cancels the job it just started (R672).
 * - **A lock** ends the project's loop at once and nothing of it stays here (R30, R50); the transcription in hand is
 *   cancelled by the lock and runs again at the unlock (R142), where the loop is started again: transcriptions carry
 *   on by themselves (nothing leaves the Mac). After a restart, the loop starts when the media helper is attached.
 * - **A move** ends the loop between its waits; it is started again on the library open after the move.
 * - Every change is published as `background.progress { transcriptions }` (only while the project is unlocked). A
 *   failure of the loop is logged and published, never lost in silence.
 * - **The speed** (SpeedMeter) is measured in memory, per speech model, over the last 10 transcriptions of the list
 *   with a known length that this service started and saw end.
 */
import { randomUUID } from "node:crypto";
import {
  NoMediaError,
  NotFoundError,
  PolicyDeniedError,
  WorkerUnavailableError,
  cancelPendingJob,
  markTranscriptionEntry,
  readTranscriptionList,
  setTranscriptionListState,
  stopTranscriptionList,
  transcriptionRecords,
  type TranscriptionEntryView,
} from "@ao/library";
import type { TranscriptionJob, TranscriptionListSummary } from "@ao/shared";
import type { ServiceState, Session } from "./state.js";

/** The last transcriptions per speech model the speed is measured over. */
export const SPEED_SAMPLES = 10;
/** A loop that failed is tried once more after this long; failing again, the list is paused (R692). */
export const LIST_RETRY_MS = 30_000;

const realTimer = (fire: () => void, ms: number): (() => void) => {
  const t = setTimeout(fire, ms);
  t.unref();
  return () => clearTimeout(t);
};

export class SpeedMeter {
  private readonly samples = new Map<string, Array<{ sound: number; wall: number }>>();

  record(model: string, soundSec: number, wallSec: number): void {
    if (!(soundSec > 0) || !(wallSec > 0) || !Number.isFinite(soundSec) || !Number.isFinite(wallSec)) return;
    const list = [...(this.samples.get(model) ?? []), { sound: soundSec, wall: wallSec }].slice(-SPEED_SAMPLES);
    this.samples.set(model, list);
  }

  /** Seconds of sound transcribed per second, for the model; undefined before the first. */
  speed(model: string): number | undefined {
    const list = this.samples.get(model);
    if (!list?.length) return undefined;
    const sound = list.reduce((a, x) => a + x.sound, 0);
    const wall = list.reduce((a, x) => a + x.wall, 0);
    return wall > 0 ? sound / wall : undefined;
  }
}

/** The loop was ended (a lock, a close, a move, a Stop's wake): not a failure. */
class LoopEnded extends Error {
  override name = "LoopEnded";
}

interface Loop {
  projectId: string;
  /** Ends the loop (a lock, a close, a move). */
  cut: AbortController;
  /** Asked again while it ran: it reads the list once more before it ends. */
  again: boolean;
  /** Wakes the wait for the job in hand (a Stop): the loop reads the list again. */
  wake: AbortController;
  /** Ended for a move: started again on the library open afterwards. */
  halted: boolean;
}

const pendingJob = (r: { status: string; error?: string }) => r.status === "queued" || r.status === "running" || (r.status === "cancelled" && r.error === "PROJECT_LOCKED");

/** The code an ended job leaves on its entry (never the bare UNRECOVERABLE, R672). */
function endCode(job: TranscriptionJob): string {
  const e = job.error;
  let code = e?.code ?? "FAILED";
  if (code === "INTERNAL" && e?.reason && /^[A-Z][A-Z0-9_]*$/.test(e.reason)) code = e.reason;
  return code === "UNRECOVERABLE" ? "TRANSCRIPTION_UNRECOVERABLE" : code;
}

export class TranscriptionListRunner {
  private readonly loops = new Map<string, Loop>();
  /** Per project: the loop failed once and is tried again (R692): the retry's cancel. */
  private readonly retries = new Map<string, () => void>();

  constructor(private readonly state: ServiceState) {}

  /** A loop is going on in some project. */
  active(): boolean {
    return this.loops.size > 0;
  }

  /** What this runner holds, for tests and diagnostics: project ids only. */
  memory(): Array<{ projectId: string }> {
    return [...this.loops.keys()].map((projectId) => ({ projectId }));
  }

  /** Projects kicked while a move of the library ran: kicked again when it has ended (R692 M9). */
  private readonly afterMoveKicks = new Set<string>();

  /** Starts the project's loop (it ends by itself when the list is paused or has nothing pending). */
  kick(s: Session, projectId: string): void {
    const { state } = this;
    if (state.session === s && state.moving && !state.shuttingDown) {
      // No loop writes while the library is being moved (R692 M9): it is started when the move has ended.
      this.afterMoveKicks.add(projectId);
      return;
    }
    if (state.session !== s || s.lib.mode !== "read-write" || state.startsHeld || state.shuttingDown) return;
    try {
      if (!s.repo.isUnlocked(projectId)) return;
    } catch {
      return; // not a project of this library
    }
    const running = this.loops.get(projectId);
    if (running) {
      running.again = true;
      return;
    }
    const l: Loop = { projectId, cut: new AbortController(), again: false, wake: new AbortController(), halted: false };
    this.loops.set(projectId, l);
    void state.startWork("transcription-list", async (work) => {
      const halt = () => {
        l.halted = true;
        l.cut.abort(new LoopEnded());
      };
      work.onStopping = halt;
      work.interrupt = () => l.cut.abort(new LoopEnded());
      if (work.stopping) halt();
      try {
        await this.run(s, l);
        if (!l.cut.signal.aborted) this.failedOnce.delete(projectId);
      } catch (err) {
        if (!l.cut.signal.aborted) {
          // Never lost in silence (R687 I1): logged; tried once more, then paused (R692); the list published.
          state.opts.log.warn({ err: state.describe(err) }, "transcription-list failed");
          await this.failed(s, projectId);
          await this.publish(s, projectId);
        }
      } finally {
        if (this.loops.get(projectId) === l) this.loops.delete(projectId);
        state.updateKeepAwake();
      }
      if (l.halted && work.stopping) return (next: Session) => this.kick(next, projectId);
      return;
    });
  }

  /** Projects whose loop failed once and has not since run to its end (R692). */
  private readonly failedOnce = new Set<string>();

  /**
   * A loop that failed (not a lock, a close, a move or a Stop): the first time it is kicked again after
   * LIST_RETRY_MS; failing again, the list is paused saying so (`stalled`), and Continue tries again (R692 M1).
   */
  private async failed(s: Session, projectId: string): Promise<void> {
    if (!this.failedOnce.has(projectId)) {
      this.failedOnce.add(projectId);
      this.retries.get(projectId)?.();
      const timer = this.state.opts.transcriptionListTimer ?? realTimer;
      const cancel = timer(() => {
        if (this.retries.get(projectId) === cancel) this.retries.delete(projectId);
        this.kick(s, projectId);
      }, LIST_RETRY_MS);
      this.retries.set(projectId, cancel);
      return;
    }
    this.failedOnce.delete(projectId);
    try {
      await setTranscriptionListState(s.repo, projectId, "paused", { stalled: true });
    } catch (err) {
      this.state.opts.log.warn({ err: this.state.describe(err) }, "transcription-list could not be paused");
    }
  }

  private async run(s: Session, l: Loop): Promise<void> {
    const pid = l.projectId;
    for (;;) {
      if (l.cut.signal.aborted) return;
      l.again = false;
      const view = await readTranscriptionList(s.repo, pid);
      if (l.cut.signal.aborted) return;
      const head = view.pending[0];
      if (view.state !== "running" || !head) {
        if (l.again) continue;
        return;
      }
      const go = await this.take(s, l, head);
      if (!go) return;
    }
  }

  /** One entry, from its start (or the job already running for it) to its end. False: the loop ends. */
  private async take(s: Session, l: Loop, head: TranscriptionEntryView): Promise<boolean> {
    const { state } = this;
    const pid = l.projectId;
    const sid = head.entry.sourceId;
    let jobId = head.status === "running" ? head.entry.jobId : undefined;
    let startedAt: number | undefined;
    if (jobId && !state.transcriptions.byId(jobId, s.lib) && !(await transcriptionRecords(s.repo, pid)).some((r) => r.id === jobId)) {
      jobId = undefined; // its job was never recorded (a quit right after the start): it starts again
    }
    if (!jobId) {
      // A transcription of the source already pending (started by hand, or before a restart) is followed, not doubled.
      const live = state.transcriptions.current(pid, sid, s.lib);
      const pending = (await transcriptionRecords(s.repo, pid, sid)).filter(pendingJob).at(-1);
      if (l.cut.signal.aborted) return false;
      const following = live && (live.status === "queued" || live.status === "running") ? live.jobId : pending?.id;
      if (following) jobId = following;
      else {
        const started = await this.start(s, l, head);
        if (started === "next") return true;
        if (started === "end") return false;
        if (started === "busy") {
          // Being started by hand at this very moment (R692 M3): that job is followed once it is made.
          let hand: string | undefined;
          try {
            hand = await state.transcriptions.whenStarted(pid, sid, AbortSignal.any([l.cut.signal, l.wake.signal]));
          } catch (err) {
            if (l.cut.signal.aborted) return false;
            if (l.wake.signal.aborted) {
              l.wake = new AbortController();
              return true;
            }
            throw err;
          }
          if (l.cut.signal.aborted) return false;
          if (hand === undefined) return true; // the hand start gave up: read the list again
          jobId = hand;
        } else {
          jobId = started;
          startedAt = state.opts.now().getTime();
        }
      }
      const marked = await markTranscriptionEntry(s.repo, pid, head.entryId, { status: "running", jobId });
      if (l.cut.signal.aborted) return false;
      if (!marked) {
        // A Stop fell between the start of the job and this mark (R672): the job goes too.
        if (startedAt !== undefined) state.transcriptions.cancel(jobId, s.lib);
        return true;
      }
      await this.publish(s, pid);
    }
    let job: TranscriptionJob;
    try {
      job = await state.transcriptions.whenEnded(s, pid, jobId, AbortSignal.any([l.cut.signal, l.wake.signal]));
    } catch (err) {
      if (l.cut.signal.aborted) return false;
      if (l.wake.signal.aborted) {
        l.wake = new AbortController();
        return true; // read the list again
      }
      throw err;
    }
    if (l.cut.signal.aborted) return false;
    if (job.status === "cancelled" && job.error?.code === "PROJECT_LOCKED") return false; // runs again at the unlock (R142)
    if (job.status === "failed" && job.error?.code === "TOOL_NOT_INSTALLED") {
      // A tool not installed (R692): the entry waits again and the list is paused for it; Continue tries again.
      if (await markTranscriptionEntry(s.repo, pid, head.entryId, { status: "queued" })) {
        await setTranscriptionListState(s.repo, pid, "paused", { tool: job.error.reason ?? "unknown" });
      }
      await this.publish(s, pid);
      return false;
    }
    let next: Parameters<typeof markTranscriptionEntry>[3];
    if (job.status === "done") next = { status: "done" };
    else if (job.status === "cancelled") next = { status: "cancelled", error: "CANCELLED" };
    else next = { status: "failed", error: endCode(job) };
    const moved = await markTranscriptionEntry(s.repo, pid, head.entryId, next);
    if (moved && job.status === "done" && startedAt !== undefined && head.entry.soundSec !== undefined) {
      state.speedMeter.record(head.entry.model, head.entry.soundSec, (state.opts.now().getTime() - startedAt) / 1000);
    }
    await this.publish(s, pid);
    return !l.cut.signal.aborted;
  }

  /**
   * Starts the entry's transcription: its job id, "next" (the entry ended; go on), "end" (the loop ends) or "busy" (a
   * start by hand holds the source at this very moment).
   */
  private async start(s: Session, l: Loop, head: TranscriptionEntryView): Promise<string | "next" | "end" | "busy"> {
    const { state } = this;
    const pid = l.projectId;
    const sid = head.entry.sourceId;
    let client;
    try {
      client = await state.workerClient();
    } catch (err) {
      // No media helper now: the list waits; it is started again when the helper is attached.
      if (err instanceof WorkerUnavailableError) {
        state.opts.log.info({}, "transcription-list waits for the media helper");
        return "end";
      }
      throw err;
    }
    if (l.cut.signal.aborted) return "end";
    let reserved: { token: symbol; release: () => void };
    try {
      reserved = state.transcriptions.reserve(pid, sid);
    } catch {
      return "busy"; // being started by hand at this very moment: followed (R692 M3)
    }
    try {
      const job = await state.transcriptions.start(s, client, pid, sid, { model: head.entry.model }, reserved.token);
      return job.jobId;
    } catch (err) {
      if (l.cut.signal.aborted) return "end";
      if (err instanceof NoMediaError || err instanceof NotFoundError) {
        // Gone before its turn, or its recording destroyed (Review Focus 5): it ends as cancelled; the list goes on.
        await markTranscriptionEntry(s.repo, pid, head.entryId, { status: "cancelled", error: err instanceof NoMediaError ? "NO_MEDIA" : "SOURCE_GONE" });
        await this.publish(s, pid);
        return "next";
      }
      if (err instanceof PolicyDeniedError) {
        await markTranscriptionEntry(s.repo, pid, head.entryId, { status: "failed", error: "POLICY_DENIED" });
        await setTranscriptionListState(s.repo, pid, "paused");
        await this.publish(s, pid);
        return "end";
      }
      throw err;
    } finally {
      reserved.release();
    }
  }

  /** The list as the screens show it. */
  async summary(s: Session, projectId: string): Promise<TranscriptionListSummary> {
    const view = await readTranscriptionList(s.repo, projectId);
    const head = view.pending[0];
    let soundSecondsLeft = 0;
    let unknownLeft = 0;
    let current: TranscriptionListSummary["current"];
    for (const e of view.pending) {
      const live = e === head && e.status === "running" && e.entry.jobId ? this.state.transcriptions.byId(e.entry.jobId, s.lib) : undefined;
      const progress = live?.progress;
      if (e === head && e.status === "running") {
        current = { sourceId: e.entry.sourceId, ...(e.entry.title !== undefined ? { title: e.entry.title } : {}), ...(progress !== undefined ? { progress } : {}) };
      }
      if (e.entry.soundSec === undefined) unknownLeft++;
      else soundSecondsLeft += e === head ? e.entry.soundSec * (1 - Math.min(1, Math.max(0, progress ?? 0))) : e.entry.soundSec;
    }
    const soundPerSecond = head ? this.state.speedMeter.speed(head.entry.model) : undefined;
    const paused = head !== undefined && view.state === "paused";
    return {
      projectId,
      state: head ? view.state : "idle",
      ...(paused && view.tool !== undefined ? { tool: view.tool } : {}),
      ...(paused && view.stalled ? { stalled: true } : {}),
      total: view.total,
      done: view.done,
      failed: view.failed,
      ...(current ? { current } : {}),
      soundSecondsLeft,
      unknownLeft,
      ...(soundPerSecond !== undefined ? { soundPerSecond } : {}),
    };
  }

  /** Publishes the list as it now reads (only while the project is unlocked). Never throws. */
  async publish(s: Session, projectId: string): Promise<TranscriptionListSummary | undefined> {
    try {
      const list = await this.summary(s, projectId);
      this.state.publishBackground(projectId, { transcriptions: list });
      return list;
    } catch {
      return undefined; // locked or gone meanwhile: nothing is told of it
    }
  }

  /** The researcher's Pause: the transcription in hand finishes, then the list waits. */
  async pause(s: Session, projectId: string): Promise<TranscriptionListSummary> {
    await setTranscriptionListState(s.repo, projectId, "paused");
    return this.answer(s, projectId);
  }

  /** The researcher's Continue. */
  async continue(s: Session, projectId: string): Promise<TranscriptionListSummary> {
    await setTranscriptionListState(s.repo, projectId, "running");
    this.kick(s, projectId);
    return this.answer(s, projectId);
  }

  /**
   * The researcher's Stop (also of an idle list: it only sets the counters to 0, R679): the list is emptied and the
   * transcription in hand cancelled (held here, or still pending in the journal).
   */
  async stop(s: Session, projectId: string): Promise<TranscriptionListSummary> {
    const { jobIds } = await stopTranscriptionList(s.repo, projectId);
    for (const jobId of jobIds) {
      if (this.state.transcriptions.cancel(jobId, s.lib)) continue;
      await cancelPendingJob(s.repo, projectId, jobId, s.index).catch(() => {});
      this.state.transcriptions.cancel(jobId, s.lib); // a rerun may have taken it meanwhile
    }
    const l = this.loops.get(projectId);
    if (l) l.wake.abort(new LoopEnded());
    return this.answer(s, projectId);
  }

  /** The answer of a route that changed the list: published first (R679). */
  async answer(s: Session, projectId: string): Promise<TranscriptionListSummary> {
    const list = await this.summary(s, projectId);
    this.state.publishBackground(projectId, { transcriptions: list });
    return list;
  }

  /** At the lock: the project's loop ends at once and nothing of it stays here. */
  stopProject(projectId: string): void {
    this.retries.get(projectId)?.();
    this.retries.delete(projectId);
    this.failedOnce.delete(projectId);
    const l = this.loops.get(projectId);
    if (!l) return;
    l.cut.abort(new LoopEnded());
    this.loops.delete(projectId);
  }

  /** A move of the library has ended (moved, refused or failed): what was kicked meanwhile is kicked now (R692 M9). */
  afterMove(): void {
    const s = this.state.session;
    const kicked = [...this.afterMoveKicks];
    this.afterMoveKicks.clear();
    if (s) for (const pid of kicked) this.kick(s, pid);
  }

  /** At a close: every loop ends. */
  stopAll(): void {
    this.afterMoveKicks.clear();
    for (const pid of new Set([...this.loops.keys(), ...this.retries.keys(), ...this.failedOnce])) this.stopProject(pid);
  }
}
