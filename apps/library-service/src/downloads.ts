/**
 * The download runs this service holds (whole channels, R668, R669, R679, R680): a channel, playlist or
 * profile downloaded one video at a time by the library's download runs (download-run.ts), each written
 * to its project's job journal.
 *
 * - **Held.** A run is held from its start or its Resume until its promise has ended, and recorded as
 *   held before anything is awaited, so of two requests at once for the same run (or the same address)
 *   exactly one passes. A run the journal says is running but which nothing holds is shown interrupted.
 * - **The turn (R669).** Per project, the runs are kept in the order they were started or resumed; a
 *   run's turn comes when every run before it has ended (finished, paused, stopped, failed or cut). So
 *   one run of a project downloads at a time and the next begins by itself, in this run of the app only:
 *   nothing is kept across a close, so after a restart nothing begins by itself (R668).
 * - **A start keeps the capture queue alive** (`captureQueues.startProfile`, `capture.progress`), so the
 *   Capture screen's queue goes on as before. Every change of a run is published as `background.progress`
 *   (the first as soon as its record exists), only while its project is unlocked.
 * - **A lock** of an encrypted project cuts every held run of it and forgets it at once: no address, no
 *   title, no run id stays here (R30, R50, R464 b). Nothing more is written or published; after the
 *   unlock its runs are shown interrupted, with Resume downloads (R669 item 1).
 * - **A close** cuts every run (nothing more is written once the library's lock goes; nothing continues
 *   after a quit, R668). **A move** asks each run to stop between videos and wakes its waits at once
 *   (R680). A move that is refused or rolled back leaves the runs as they were: each halted run takes
 *   its place in the order again at once (R687). A move that goes ahead: a plain project's run that was
 *   downloading continues on the moved library by itself (`capture.profile.continue`, R106), only if its
 *   journal still says queued, downloading or waiting and nobody paused, stopped or resumed it meanwhile;
 *   an encrypted project's run, or one only waiting its turn, does not (R534 b, R668) and is shown
 *   interrupted. A continuation that does not go on is dropped, never kept for a later move.
 */
import { randomUUID } from "node:crypto";
import { classifyUrl } from "@ao/core";
import {
  CaptureCancelledError,
  WorkerUnavailableError,
  checkCaptureAllowed,
  plainReason,
  createDownloadRuns,
  type CaptureOutcome,
  type DownloadRuns,
  type ProfileCaptureReport,
  type RunControl,
  type RunOptions,
  type WorkerClient,
} from "@ao/library";
import {
  RUN_ALREADY_RUNNING,
  RUN_ALREADY_RUNNING_TEXT,
  RUN_NOT_RUNNING_TEXT,
  type CaptureEstimate,
  type CaptureQueueProgressEvent,
  type DownloadProblemsResponse,
  type DownloadRunState,
  type DownloadRunSummary,
} from "@ao/shared";
import { ApiError, notFound } from "./errors.js";
import type { ServiceState, Session } from "./state.js";

/** Test seams (R47: the service honours them only under NODE_ENV=test or VITEST). */
export interface DownloadSeams {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  freeBytes?: (dir: string) => Promise<number | null>;
}

interface Held {
  runId: string;
  projectId: string;
  /** The order of starts and Resumes in this service. */
  seq: number;
  /** The address in its canonical form (forgotten with the entry at a lock). */
  key: string | undefined;
  asked: "pause" | "stop" | undefined;
  req: AbortController;
  cut: AbortController;
  stop: AbortController;
  cancelled: boolean;
  /** Asked to stop between videos: by a move (it may continue on the moved library). */
  halted: boolean;
  /** Its turn came: it has been downloading or waiting. */
  begun: boolean;
  state: DownloadRunState | undefined;
  /** It feeds the Capture screen's queue (a start, and its continuation after a move). */
  queue: boolean;
  report: ProfileCaptureReport | undefined;
  /** Resolves when the run is no longer held (it ended, or it never began: an early exit). */
  settled: Promise<void>;
  settle: () => void;
}

/** The journal states of a run that is going on (a continuation goes on only from one of them, R687). */
const LIVE = new Set<DownloadRunState>(["queued", "downloading", "waiting"]);

/** A continuation that found its run no longer going on (paused, stopped, finished, discarded): it is dropped. */
class NotContinued extends Error {
  override name = "NotContinued";
}

const runningConflict = () => new ApiError(409, "CONFLICT", RUN_ALREADY_RUNNING_TEXT, RUN_ALREADY_RUNNING);

/** Stands in for the media helper where none is needed (reading the journal). */
const NO_WORKER = {
  submit: () => Promise.reject(new WorkerUnavailableError("the media helper is not ready")),
} as unknown as WorkerClient;

/** An address in the form two spellings of it share. */
export function addressKey(url: string): string {
  try {
    return classifyUrl(url).canonicalUrl;
  } catch {
    return url;
  }
}

export class DownloadRunner {
  private readonly runs = new Map<string, Held>();
  private readonly order = new Map<string, Held[]>();
  private seq = 0;
  /** Told for each video a run put on the transcription list (Task 7 sets it). */
  onQueuedForTranscription: (projectId: string, sourceId: string) => void = () => {};

  constructor(private readonly state: ServiceState) {}

  /** Downloading, waiting, or waiting its turn in this service. */
  held(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** A run downloading or waiting in any project (one only waiting its turn does not count). */
  active(): boolean {
    for (const h of this.runs.values()) if (h.state === "downloading" || h.state === "waiting") return true;
    return false;
  }

  /** What this runner holds, for tests and diagnostics: ids, states and addresses, nothing else. */
  memory(): Array<{ runId: string; projectId: string; key?: string; state?: string }> {
    return [...this.runs.values()].map((h) => ({ runId: h.runId, projectId: h.projectId, ...(h.key ? { key: h.key } : {}), ...(h.state ? { state: h.state } : {}) }));
  }

  private seams(): DownloadSeams {
    return this.state.opts.downloads ?? {};
  }

  private library(s: Session, worker: WorkerClient): DownloadRuns {
    const seams = this.seams();
    return createDownloadRuns({
      repo: s.repo,
      worker,
      ...(s.index ? { index: s.index } : {}),
      ...(seams.sleep ? { sleep: seams.sleep } : {}),
      ...(seams.freeBytes ? { freeBytes: seams.freeBytes } : {}),
    });
  }

  private reader(s: Session): DownloadRuns {
    return this.library(s, s.workerClient ?? NO_WORKER);
  }

  private readonly isHeld = (runId: string) => this.runs.has(runId);

  /** Whether Video tools (ffmpeg) are installed, as far as the optional tools list knows (null: not known). */
  async videoToolsInstalled(): Promise<boolean | null> {
    const tools = (await this.state.ensureWorker()).tools;
    if (!tools) return null;
    const cat = await tools.catalogue<{ tools?: Array<{ id?: unknown; installed?: unknown }> }>().catch(() => undefined);
    const t = cat?.tools?.find((x) => x.id === "ffmpeg");
    return typeof t?.installed === "boolean" ? t.installed : null;
  }

  async estimate(s: Session, projectId: string, url: string, opts: RunOptions): Promise<CaptureEstimate> {
    const worker = await this.state.workerClient();
    const e = await this.library(s, worker).estimate(projectId, url, opts, s.closing.signal);
    return { ...e, videoToolsInstalled: await this.videoToolsInstalled() };
  }

  /**
   * Records a run as held, in its project's order, before anything is awaited. A continuation keeps the place
   * (`seq`) its run had, so after a refused move the runs go on in the order they were in (R687).
   */
  private register(projectId: string, runId: string, key: string | undefined, queue: boolean, seq = ++this.seq): { h: Held; before: Held[] } {
    const all = this.order.get(projectId) ?? [];
    const before = all.filter((x) => x.seq < seq);
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const h: Held = {
      runId,
      projectId,
      seq,
      key,
      asked: undefined,
      req: new AbortController(),
      cut: new AbortController(),
      stop: new AbortController(),
      cancelled: false,
      halted: false,
      begun: false,
      state: undefined,
      queue,
      report: undefined,
      settled,
      settle,
    };
    this.runs.set(runId, h);
    this.order.set(projectId, [...before, h, ...all.filter((x) => x.seq >= seq)]);
    return { h, before };
  }

  /** The run is no longer held here (it ended, or a lock or close cut it). */
  private forget(h: Held): void {
    if (this.runs.get(h.runId) === h) this.runs.delete(h.runId);
    const rest = (this.order.get(h.projectId) ?? []).filter((x) => x !== h);
    if (rest.length) this.order.set(h.projectId, rest);
    else this.order.delete(h.projectId);
  }

  /**
   * Runs `body` as registered work with the run's control. The answer is the first summary `answerWhen`
   * accepts (or the run's end); a rejection before it rejects the answer.
   */
  private launch(
    s: Session,
    h: Held,
    body: (ctl: RunControl) => Promise<DownloadRunSummary>,
    answerWhen: (run: DownloadRunSummary) => boolean,
  ): Promise<DownloadRunSummary> {
    const { state } = this;
    const pid = h.projectId;
    let answered = false;
    let answer!: (run: DownloadRunSummary) => void;
    let refuse!: (err: unknown) => void;
    const answering = new Promise<DownloadRunSummary>((res, rej) => {
      answer = res;
      refuse = rej;
    });
    // The turn comes when no run before it in the project's order is held any more. Read again after each
    // wait: a run halted by a refused move takes its place again at once (R687).
    const ahead = () => (this.order.get(pid) ?? []).filter((x) => x.seq < h.seq);
    const turn = async (): Promise<void> => {
      for (let a = ahead(); a.length; a = ahead()) await Promise.all(a.map((x) => x.settled));
    };
    const ctl: RunControl = {
      requested: () => h.asked,
      requestedSignal: h.req.signal,
      cancelled: () => h.cancelled,
      signal: h.cut.signal,
      halt: () => h.halted,
      haltSignal: h.stop.signal,
      onChange: (run) => {
        if (h.cancelled) return;
        h.state = run.state;
        if (run.state === "downloading" || run.state === "waiting") h.begun = true;
        state.publishBackground(pid, { downloads: run });
        if (!answered && answerWhen(run)) {
          answered = true;
          answer(run);
        }
      },
      onItem: (done: number, total: number, outcome: CaptureOutcome) => {
        // Ended meanwhile (a lock, a close): nothing more of it is recorded or published (Task 63 I3).
        if (!h.queue || h.cancelled || state.captureEnded(h.runId)) return;
        state.captureQueues.progress(h.runId, done, total, outcome);
        state.events.publish("capture.progress", { queueId: h.runId, projectId: pid, done, total, outcome, finished: false } satisfies CaptureQueueProgressEvent);
      },
      onReport: (report) => {
        if (!h.cancelled) h.report = report;
      },
      onQueuedForTranscription: (sourceId) => {
        if (!h.cancelled) this.onQueuedForTranscription(pid, sourceId);
      },
      turn,
    };
    void state.startWork("download-run", async (work) => {
      // A move's drain: the run stops between videos and its waits wake at once (R680).
      work.onStopping = () => this.haltForMove(h);
      if (work.stopping) this.haltForMove(h);
      let failure: unknown;
      let ended = false;
      try {
        const run = await body(ctl);
        ended = true;
        if (!answered) {
          answered = true;
          answer(run);
        }
      } catch (err) {
        failure = err;
        if (!answered) {
          answered = true;
          refuse(err);
        }
      } finally {
        this.forget(h);
        h.settle();
      }
      // Halted by a move between videos. While the move still stops work, what comes next is decided when the
      // library it belongs to is open again (refused: the same library; moved: the new one). A move already rolled
      // back (its drain ran out of time) leaves the run as it was: it takes its place again at once (R687).
      if (!ended && h.halted && !h.cancelled && failure instanceof CaptureCancelledError) {
        const fromRoot = s.lib.root;
        if (work.stopping) return (next: Session) => this.afterMove(next, h, fromRoot);
        this.afterMove(s, h, fromRoot);
        return;
      }
      if (failure instanceof NotContinued) {
        // A continuation whose run the researcher paused, stopped, finished or discarded meanwhile: dropped.
        this.endQueue(h, new CaptureCancelledError());
        await this.publishRun(s, h);
        return;
      }
      this.endQueue(h, ended ? undefined : failure);
      return;
    });
    return answering;
  }

  private encrypted(s: Session, projectId: string): boolean {
    try {
      return s.repo.getProject(projectId).encryption.enabled;
    } catch {
      return true;
    }
  }

  /** The Capture screen's queue of a start ends with the run (unless a lock or close already ended it). */
  private endQueue(h: Held, failure: unknown): void {
    if (!h.queue) return;
    const { state } = this;
    if (state.profileRunEnded(h.runId)) return; // its end was published when it was ended
    const pid = h.projectId;
    if (h.cancelled) failure ??= new CaptureCancelledError();
    if (h.report && !h.cancelled) {
      state.captureQueues.finish(h.runId, { report: h.report });
      state.events.publish("capture.progress", { queueId: h.runId, projectId: pid, finished: true, report: h.report } satisfies CaptureQueueProgressEvent);
    } else if (failure !== undefined) {
      state.captureQueues.finish(h.runId, { error: failure });
      state.events.publish("capture.progress", { queueId: h.runId, projectId: pid, finished: true, error: state.describe(failure) } satisfies CaptureQueueProgressEvent);
    } else {
      // Stopped while it waited its turn: nothing was asked of the platform.
      state.captureQueues.finish(h.runId, {});
      state.events.publish("capture.progress", { queueId: h.runId, projectId: pid, finished: true } satisfies CaptureQueueProgressEvent);
    }
  }

  private haltForMove(h: Held): void {
    if (h.cancelled || h.halted) return;
    h.halted = true;
    h.stop.abort();
  }

  /**
   * A run halted by a move, once the library it belongs to is open again (R687, R668):
   * - the move was refused or rolled back (the same library): every halted run goes on, in its place in the order;
   * - the move went ahead: only a plain project's run that was downloading carries on by itself
   *   (`capture.profile.continue`); an encrypted project's run, and one that was only waiting its turn, do not.
   * Never a run the researcher asked to pause or stop, one held again meanwhile, one of a project that is locked
   * now, or (checked against its journal as it continues) one no longer queued, downloading or waiting.
   * A continuation that does not go on is dropped, and its run is published as it now reads.
   */
  private afterMove(next: Session, old: Held, fromRoot: string): void {
    const pid = old.projectId;
    const refused = next.lib.root === fromRoot;
    let unlocked = false;
    try {
      unlocked = next.repo.isUnlocked(pid);
    } catch {
      // not a project of this library
    }
    const goesOn = this.state.session === next && unlocked && old.asked === undefined && !this.runs.has(old.runId) && (refused || (old.begun && !this.encrypted(next, pid)));
    if (!goesOn) {
      this.endQueue(old, new CaptureCancelledError());
      this.state.track(this.publishRun(next, old), "publishing a download run");
      return;
    }
    const { h } = this.register(pid, old.runId, old.key, old.queue, old.seq);
    this.launch(
      next,
      h,
      async (ctl) => {
        const now = await this.reader(next).get(pid, old.runId, () => true);
        if (!now || !LIVE.has(now.state)) throw new NotContinued();
        return this.library(next, await this.state.workerClient()).resume(pid, old.runId, "continue", ctl);
      },
      () => true,
    ).catch(() => {});
  }

  /** Publishes the run as it now reads (a Stop asked of it while it ended is written first). Never throws. */
  private async publishRun(s: Session, h: Held): Promise<void> {
    if (h.cancelled) return;
    try {
      const reader = this.reader(s);
      if (h.asked === "stop" && !this.runs.has(h.runId)) await reader.stopNotRunning(h.projectId, h.runId);
      const run = await reader.get(h.projectId, h.runId, this.isHeld);
      if (run) this.state.publishBackground(h.projectId, { downloads: run });
    } catch {
      // a project locked or gone meanwhile: nothing is told of it
    }
  }

  async start(s: Session, projectId: string, url: string, opts: RunOptions): Promise<DownloadRunSummary> {
    const key = addressKey(url);
    // Checked and recorded with nothing awaited in between.
    for (const x of this.runs.values()) if (x.projectId === projectId && x.key === key) throw runningConflict();
    const runId = randomUUID();
    const { h } = this.register(projectId, runId, key, true);
    this.state.captureQueues.startProfile(runId, projectId, url, "desktop");
    this.state.profileRunStarted(runId, projectId);
    return this.launch(
      s,
      h,
      async (ctl) => {
        const runs = this.library(s, await this.state.workerClient());
        // Starting an address again: its older unfinished runs that nothing holds go (the new run takes
        // everything missing anyway). A finished one stays.
        for (const old of await runs.list(projectId, this.isHeld)) {
          if (ctl.cancelled()) break;
          if (old.runId === runId || old.state === "finished" || this.runs.has(old.runId) || addressKey(old.url) !== key) continue;
          if (await runs.discard(projectId, old.runId)) this.state.publishBackground(projectId, { discarded: old.runId });
        }
        return runs.start(projectId, runId, url, opts, ctl);
      },
      () => true,
    );
  }

  /**
   * The researcher's press of "Resume downloads": the project's rules are asked first (403 with their reason,
   * the refusal audited), then the run is held and waits its turn; its own decision is audited when it begins
   * (`capture.profile.resume`, R668).
   */
  async resume(s: Session, projectId: string, runId: string): Promise<DownloadRunSummary> {
    const found = await this.reader(s).get(projectId, runId, this.isHeld);
    if (!found) throw notFound("That download run");
    if (this.runs.has(runId)) throw runningConflict();
    if (found.state === "finished" && found.failed === 0) throw new ApiError(409, "CONFLICT", plainReason("RUN_FINISHED"), "RUN_FINISHED");
    await checkCaptureAllowed(s.repo, projectId, [found.url]);
    const worker = await this.state.workerClient();
    // Checked and recorded with nothing awaited in between: of two presses, one passes.
    if (this.runs.has(runId)) throw runningConflict();
    const { h, before } = this.register(projectId, runId, addressKey(found.url), false);
    return this.launch(
      s,
      h,
      (ctl) => this.library(s, worker).resume(projectId, runId, "researcher", ctl),
      // The answer says queued only while another run of the project is before it.
      (run) => run.state !== "queued" || before.length > 0,
    );
  }

  async request(s: Session, projectId: string, runId: string, what: "pause" | "stop"): Promise<DownloadRunSummary> {
    const h = this.runs.get(runId);
    const reader = this.reader(s);
    if (!h || h.projectId !== projectId) {
      if (what === "pause") throw new ApiError(409, "CONFLICT", RUN_NOT_RUNNING_TEXT);
      const run = await reader.stopNotRunning(projectId, runId);
      if (!run) throw notFound("That download run");
      this.state.publishBackground(projectId, { downloads: run });
      return run;
    }
    if (what === "pause") {
      // A run only waiting its turn is not running: it is stopped, not paused.
      if (!h.begun) throw new ApiError(409, "CONFLICT", RUN_NOT_RUNNING_TEXT);
      if (h.asked !== "stop") h.asked = "pause";
    } else h.asked = "stop";
    h.req.abort();
    // Waiting its turn: it leaves the queue at once.
    if (!h.begun) await h.settled;
    const run = await reader.get(projectId, runId, this.isHeld);
    if (!run) throw notFound("That download run");
    return run;
  }

  async discard(s: Session, projectId: string, runId: string): Promise<void> {
    if (this.runs.has(runId)) throw runningConflict();
    if (!(await this.reader(s).discard(projectId, runId))) throw notFound("That download run");
    this.state.publishBackground(projectId, { discarded: runId });
  }

  list(s: Session, projectId: string): Promise<DownloadRunSummary[]> {
    return this.reader(s).list(projectId, this.isHeld);
  }

  problems(s: Session, projectId: string, runId: string): Promise<DownloadProblemsResponse> {
    return this.reader(s).problems(projectId, runId);
  }

  /**
   * A lock or a close cuts every held run of the project at once: nothing more is written or published,
   * the download in flight is asked to stop, and the run is forgotten here (no address, title or id).
   * A move asks the runs to stop between videos (as its drain does).
   */
  stopProject(projectId: string, why: "lock" | "close" | "move"): void {
    for (const h of [...this.runs.values()]) {
      if (h.projectId !== projectId) continue;
      if (why === "move") {
        this.haltForMove(h);
        continue;
      }
      h.cancelled = true;
      h.cut.abort();
      h.key = undefined;
      h.report = undefined;
      this.forget(h);
    }
  }
}
