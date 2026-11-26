/**
 * Download runs (whole channels, R668, R669): a channel, playlist or profile downloaded one video at
 * a time, every video written to the project's job journal (lists/run-journal.ts), so a run survives
 * a sleep, a lock, a quit and a restart and a screen line always says where it is.
 *
 * - `start` writes the run (state `queued`) and waits its TURN (`ctl.turn`, R669): one run of a
 *   project downloads at a time; a Stop while it waits ends it `stopped` with nothing asked of the
 *   platform. When the turn comes, the profile capture (profile-capture.ts) does the work, steered
 *   through its `RunHooks`: the list is journaled before any download; before each video the
 *   researcher's Pause or Stop is honoured, the gap (`DOWNLOAD_GAP_MS`) is waited, and the disk is
 *   checked against the 10 GB floor; each final outcome is journaled; each slow-down or lost-
 *   connection wait is journaled as `waiting` and woken at once by a Pause or Stop.
 * - `resume` (the researcher's press of "Resume downloads", or a continuation by itself) takes the
 *   videos not done again, in their order, with the project's rules asked again (an audited decision
 *   of its own, R668).
 * - A run cut from outside (a lock, a close, a move: `ctl.cancelled`) writes nothing more. A run whose
 *   journal says queued, downloading or waiting but which nothing holds is shown `interrupted`.
 * - `finished` is written only when every video of the run is done or failed (R678): a segment that
 *   completed with videos still to do (its listing did not come back whole) ends `failed` with
 *   LIST_INCOMPLETE, and Resume downloads takes them.
 *
 * Every wait (the turn, the gap, a slow-down or lost-connection wait) goes through the injected
 * `sleep` or the caller's promise, so tests never wait on a real timer.
 */
import {
  BYTES_PER_SECOND,
  DEFAULT_QUALITY,
  DISK_FLOOR_BYTES,
  DOWNLOAD_QUALITIES,
  downloadProblemText,
  type CaptureEstimate,
  type DownloadProblemsResponse,
  type DownloadRunState,
  type DownloadRunSummary,
} from "@ao/shared";
import type { IndexDb } from "../index/db.js";
import { DISCARDED_CODE, updateJobRecords } from "../job-journal.js";
import {
  createRun,
  discardRun,
  readRun,
  readRunItems,
  readRuns,
  recordRunItem,
  requeueFailedItems,
  setRunItems,
  setRunState,
  type RunView,
} from "../lists/run-journal.js";
import { addToTranscriptionList } from "../lists/transcription-list.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { projectDataKey, repoClock, repoLibrary, type Repo } from "../repo/repo.js";
import type { WorkerClient } from "../worker-client.js";
import { diskName, freeBytes } from "./disk.js";
import { CaptureCancelledError, plainReason } from "./errors.js";
import { estimateCapture } from "./estimate.js";
import { createLinkCapture, type CaptureOutcome, type DownloadQuality } from "./link-capture.js";
import { classifyUrl, type ClassifiedUrl } from "./platforms.js";
import type { ProfileCaptureOptions, ProfileCaptureReport, ProfileEntry, RunHooks } from "./profile-capture.js";

/** The wait between two downloads (plan's decision), on top of the downloader's own sleeps. */
export const DOWNLOAD_GAP_MS = 10_000;

export interface RunOptions extends Omit<ProfileCaptureOptions, "transcribe" | "transcribeModel" | "quality" | "onlyIds" | "resume"> {
  quality?: DownloadQuality;
  /** Each new video goes on the project's transcription list (the capture itself never transcribes). */
  transcribe: boolean;
  transcribeModel?: string;
}

export interface RunControl {
  /** The researcher's Pause or Stop. */
  requested(): "pause" | "stop" | undefined;
  /** Aborted when Pause or Stop is asked: wakes the gap and a wait at once. */
  requestedSignal: AbortSignal;
  /** A lock, a close or a move: nothing more is written. */
  cancelled(): boolean;
  /** Aborted with cancelled: the download in flight is asked to stop. */
  signal: AbortSignal;
  /** A move or close asks to stop between videos (beforeItem throws CaptureCancelledError). */
  halt(): boolean;
  /** After every journal write. */
  onChange(run: DownloadRunSummary): void;
  onItem?(done: number, total: number, out: CaptureOutcome): void;
  onReport?(report: ProfileCaptureReport): void;
  onQueuedForTranscription?(sourceId: string): void;
  /** (coordinator, R669) Resolves when this run may download; absent = at once. */
  turn?(): Promise<void>;
}

export interface DownloadRunsDeps {
  repo: Repo;
  worker: WorkerClient;
  index?: { readonly db: IndexDb };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  freeBytes?: (dir: string) => Promise<number | null>;
}

export interface DownloadRuns {
  estimate(projectId: string, url: string, opts: RunOptions, signal?: AbortSignal): Promise<CaptureEstimate>;
  start(projectId: string, runId: string, url: string, opts: RunOptions, ctl: RunControl): Promise<DownloadRunSummary>;
  resume(projectId: string, runId: string, how: "researcher" | "continue", ctl: RunControl): Promise<DownloadRunSummary>;
  list(projectId: string, held: (runId: string) => boolean): Promise<DownloadRunSummary[]>;
  get(projectId: string, runId: string, held: (runId: string) => boolean): Promise<DownloadRunSummary | undefined>;
  problems(projectId: string, runId: string): Promise<DownloadProblemsResponse>;
  stopNotRunning(projectId: string, runId: string): Promise<DownloadRunSummary | undefined>;
  discard(projectId: string, runId: string): Promise<boolean>;
}

/** Said when Resume downloads is asked of a run that has nothing left to do. */
const NOTHING_TO_RESUME = "Every video of these downloads is already in the project, so there is nothing to resume.";
const TITLE_MAX = 300;

/** A real timer, woken early by the signal. */
function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The link's own key, the run's title until the list is read: the handle, the playlist id, the last path part. */
function linkKey(c: ClassifiedUrl, url: string): string {
  if (c.handle) return c.handle;
  try {
    const u = new URL(c.canonicalUrl);
    return u.searchParams.get("list") ?? u.pathname.split("/").filter(Boolean).at(-1) ?? url;
  } catch {
    return url;
  }
}

/** The options as written to the journal (a Resume reads them back); never `onlyIds` or `resume`. */
function storedOptions(opts: RunOptions): Record<string, unknown> {
  const { onlyIds: _o, resume: _r, ...rest } = opts as RunOptions & { onlyIds?: unknown; resume?: unknown };
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

function runOptionsOf(stored: Record<string, unknown>): RunOptions {
  return { ...(stored as Partial<RunOptions>), transcribe: stored.transcribe === true } as RunOptions;
}

/** What the profile capture is asked: never to transcribe (the transcription list does that, one at a time). */
function profileOptions(opts: RunOptions): ProfileCaptureOptions {
  const { transcribe: _t, transcribeModel: _m, quality, onlyIds: _o, resume: _r, ...rest } = opts as RunOptions & { onlyIds?: unknown; resume?: unknown };
  return { ...rest, transcribe: false, ...(quality ? { quality } : {}) };
}

function qualityOf(v: unknown): DownloadQuality | undefined {
  return typeof v === "string" && (DOWNLOAD_QUALITIES as readonly string[]).includes(v) ? (v as DownloadQuality) : undefined;
}

/** The title of one listed video: as listed, else the caption's first line. */
function itemTitle(e: ProfileEntry): string | undefined {
  const t = (e.title ?? e.caption?.split("\n").find((l) => l.trim()))?.trim();
  return t ? t.slice(0, TITLE_MAX) : undefined;
}

/** The run as the screens and the service see it; a live run nothing holds is shown interrupted. */
function summarize(v: RunView, held: (runId: string) => boolean): DownloadRunSummary {
  const r = v.record.run;
  const live = r.state === "queued" || r.state === "downloading" || r.state === "waiting";
  const state: DownloadRunState = live && !held(v.runId) ? "interrupted" : r.state;
  const quality = qualityOf(r.options.quality);
  return {
    runId: v.runId,
    projectId: v.record.projectId,
    url: r.url,
    title: r.title,
    platform: r.platform,
    ...(quality ? { quality } : {}),
    transcribe: r.options.transcribe === true,
    state,
    total: r.total,
    done: r.done,
    failed: r.failed,
    notCompleted: Math.max(0, r.total - r.done),
    ...(state === "waiting" && r.wait ? { wait: { ms: r.wait.ms, why: r.wait.why } } : {}),
    ...(r.tool ? { tool: r.tool } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    startedAt: v.record.createdAt,
    updatedAt: v.record.updatedAt,
  };
}

/**
 * The run's title once the list is read (run-journal.ts has no setter for it; this writes the run's
 * record again with the title, in the journal's own turn, as every run-journal write does).
 */
async function setRunTitle(repo: Repo, projectId: string, runId: string, title: string): Promise<RunView | undefined> {
  const library = repoLibrary(repo);
  if (library.mode !== "read-write") throw new ReadOnlyLibraryError(library.readOnlyReason);
  let changed = false;
  await updateJobRecords(library.root, repo.getProject(projectId).folder, projectId, projectDataKey(repo, projectId), (records) => {
    const r = records.get(runId);
    if (!r || r.kind !== "capture.run" || !r.run || r.run.title === title || (r.status === "cancelled" && r.error === DISCARDED_CODE)) return [];
    changed = true;
    return [{ ...r, updatedAt: repoClock(repo)().toISOString(), run: { ...r.run, title } }];
  });
  return changed ? readRun(repo, projectId, runId) : undefined;
}

export function createDownloadRuns(deps: DownloadRunsDeps): DownloadRuns {
  const { repo } = deps;
  const sleep = deps.sleep ?? timerSleep;
  const readFree = deps.freeBytes ?? freeBytes;
  // Every wait of a run goes through hooks.wait (below), so the capture's own sleep is never used by a run.
  const capture = createLinkCapture({ repo, worker: deps.worker, ...(deps.index ? { index: deps.index } : {}), sleep: (ms) => sleep(ms) });

  /** The turn (R669), raced with a Stop and a cancel; a Pause asked meanwhile is ignored (the service refuses it). */
  async function awaitTurn(ctl: RunControl): Promise<"go" | "stop"> {
    const stopAsked = () => ctl.requested() === "stop";
    const cut = () => ctl.cancelled() || ctl.signal.aborted;
    if (ctl.turn && !cut() && !stopAsked()) {
      const turn = ctl.turn();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          ctl.requestedSignal.removeEventListener("abort", onAsk);
          ctl.signal.removeEventListener("abort", finish);
        };
        function finish() {
          cleanup();
          resolve();
        }
        function onAsk() {
          if (stopAsked()) finish();
        }
        ctl.requestedSignal.addEventListener("abort", onAsk);
        ctl.signal.addEventListener("abort", finish);
        turn.then(finish, (err: unknown) => {
          cleanup();
          reject(err);
        });
      });
    }
    if (cut()) throw new CaptureCancelledError();
    return stopAsked() ? "stop" : "go";
  }

  /** One segment of a run: the turn, then the capture steered through its hooks, then the run's end. */
  async function segment(projectId: string, runId: string, ctl: RunControl, resume?: "researcher" | "continue"): Promise<DownloadRunSummary> {
    const guard = () => {
      if (ctl.cancelled()) throw new CaptureCancelledError();
    };
    /** One journal write (none once cut from outside), then onChange. */
    const write = async (fn: () => Promise<RunView | undefined>): Promise<RunView | undefined> => {
      guard();
      const v = await fn();
      if (v) ctl.onChange(summarize(v, () => true));
      return v;
    };

    if ((await awaitTurn(ctl)) === "stop") {
      // Stopped while it waited its turn: nothing was asked of the platform.
      return summarize((await write(() => setRunState(repo, projectId, runId, "stopped", { reason: plainReason("RUN_STOPPED") })))!, () => true);
    }
    const started = (await write(() => setRunState(repo, projectId, runId, "downloading")))!;
    const run = started.record.run;
    const opts = runOptionsOf(run.options);
    /** A run that never read its list is resumed as a start (its decision is still the resume's). */
    const readList = resume === undefined || run.total === 0;
    let onlyIds: string[] | undefined;
    if (!readList) {
      await write(() => requeueFailedItems(repo, projectId, runId));
      onlyIds = (await readRunItems(repo, projectId, runId)).filter((i) => i.status !== "done").map((i) => i.item.postId);
    }

    const root = repoLibrary(repo).root;
    const wake = AbortSignal.any([ctl.requestedSignal, ctl.signal]);
    const quality = opts.quality ?? DEFAULT_QUALITY;
    const bytesPerSecond = opts.metadataOnly === true ? 0 : BYTES_PER_SECOND[quality].high;
    let title = run.title;
    let first = true;
    /** The last video needed no download (a duplicate): no gap after it. */
    let lastNoDownload = false;
    /** The video asked "go" and not yet told: put back when the segment ends without it. */
    let inHand: string | undefined;
    /** A failure left less than the floor free: the next video pauses on the disk (Review Focus 2). */
    let diskPause = false;
    /** The project's rules refused transcription: not asked again in this segment. */
    let transcribeRefused = false;

    const hooks: RunHooks = {
      onListed: async (fresh, meta) => {
        if (readList) {
          await write(() =>
            setRunItems(repo, projectId, runId, fresh.map((e) => ({ postId: e.id, url: e.url, ...(itemTitle(e) ? { title: itemTitle(e)! } : {}), ...(e.durationSec !== undefined ? { durationSec: e.durationSec } : {}) }))),
          );
        }
        const named = meta.title.trim().slice(0, TITLE_MAX);
        if (named && named !== title) {
          await write(() => setRunTitle(repo, projectId, runId, named));
          title = named;
        }
        await write(() => setRunState(repo, projectId, runId, "downloading"));
      },
      beforeItem: async (e) => {
        if (ctl.halt()) throw new CaptureCancelledError();
        const asked = ctl.requested();
        if (asked) return asked;
        if (diskPause) return "pause-disk";
        if (!first && !lastNoDownload) {
          await sleep(DOWNLOAD_GAP_MS, wake);
          guard();
          if (ctl.halt()) throw new CaptureCancelledError();
          const meanwhile = ctl.requested();
          if (meanwhile) return meanwhile;
        }
        const free = await readFree(root);
        if (free !== null && free - (e.durationSec ?? 0) * bytesPerSecond < DISK_FLOOR_BYTES) return "pause-disk";
        await write(() => recordRunItem(repo, projectId, runId, e.id, { status: "running" }));
        inHand = e.id;
        first = false;
        return "go";
      },
      afterItem: async (e, out) => {
        inHand = undefined;
        lastNoDownload = out.status === "duplicate";
        if (out.status === "failed") {
          const free = await readFree(root);
          if (free !== null && free < DISK_FLOOR_BYTES) {
            // Not this video's fault: it stays to do, and the run pauses on the disk.
            diskPause = true;
            await write(() => recordRunItem(repo, projectId, runId, e.id, { status: "queued" }));
          } else {
            await write(() =>
              recordRunItem(repo, projectId, runId, e.id, { status: "failed", errorCode: out.errorCode ?? "CAPTURE_FAILED", ...(out.platformReason ? { platformReason: out.platformReason } : {}) }),
            );
          }
          return;
        }
        await write(() => recordRunItem(repo, projectId, runId, e.id, { status: "done", ...(out.sourceId ? { sourceId: out.sourceId } : {}) }));
        if (opts.transcribe && out.sourceId && out.status !== "duplicate" && !transcribeRefused) {
          guard();
          try {
            const { added } = await addToTranscriptionList(repo, projectId, [{ sourceId: out.sourceId, ...(opts.transcribeModel ? { model: opts.transcribeModel } : {}) }]);
            if (added > 0) ctl.onQueuedForTranscription?.(out.sourceId);
          } catch (err) {
            // The deny is audited; the downloads go on without it.
            if (err instanceof PolicyDeniedError) transcribeRefused = true;
            else throw err;
          }
        }
      },
      wait: async (ms, why) => {
        await write(() => setRunState(repo, projectId, runId, "waiting", { wait: { ms, why } }));
        await sleep(ms, wake);
        guard();
        const asked = ctl.requested();
        if (asked) return asked;
        await write(() => setRunState(repo, projectId, runId, "downloading"));
        return "go";
      },
    };

    const report = await capture.captureProfile(
      projectId,
      run.url,
      { ...profileOptions(opts), ...(onlyIds ? { onlyIds } : {}), ...(resume ? { resume } : {}) },
      (done, total, out) => ctl.onItem?.(done, total, out),
      { cancelled: () => ctl.cancelled(), signal: ctl.signal, hooks },
    );

    // The segment's end.
    if (inHand !== undefined) {
      const back = inHand;
      await write(() => recordRunItem(repo, projectId, runId, back, { status: "queued" }));
    }
    let state: Exclude<DownloadRunState, "interrupted">;
    let extra: { tool?: string; errorCode?: string; reason?: string } = {};
    if (report.status === "completed") {
      const items = await readRunItems(repo, projectId, runId);
      if (items.every((i) => i.status === "done" || i.status === "failed")) state = "finished";
      else if (diskPause) {
        state = "paused-disk";
        extra = { reason: plainReason("DISK_NEARLY_FULL") };
      } else {
        // R678: the listing did not come back whole; the videos past the cut are still to do.
        state = "failed";
        extra = { errorCode: "LIST_INCOMPLETE", reason: plainReason("LIST_INCOMPLETE") };
      }
    } else {
      state = report.status;
      extra = {
        ...(report.tool ? { tool: report.tool } : {}),
        ...(report.errorCode ? { errorCode: report.errorCode } : {}),
        ...(report.reason ? { reason: report.reason } : {}),
      };
    }
    guard();
    const end = await setRunState(repo, projectId, runId, state, extra);
    ctl.onReport?.(report);
    const summary = summarize(end, () => true);
    ctl.onChange(summary);
    return summary;
  }

  return {
    async estimate(projectId, url, opts, signal) {
      const listing = await capture.listProfile(projectId, url, profileOptions(opts), signal);
      if (listing.status !== "listed") return estimateCapture(listing, opts, { freeBytes: null, diskName: null }); // throws
      const root = repoLibrary(repo).root;
      const [free, name] = await Promise.all([readFree(root), diskName(root)]);
      return estimateCapture(listing, opts, { freeBytes: free, diskName: name });
    },

    async start(projectId, runId, url, opts, ctl) {
      const c = classifyUrl(url);
      if (c.platform === "other" || (c.kind !== "profile" && c.kind !== "playlist")) throw new InvalidInputError(plainReason("UNSUPPORTED_URL"));
      if (ctl.cancelled()) throw new CaptureCancelledError();
      const created = await createRun(repo, projectId, runId, { url, title: linkKey(c, url), platform: c.platform, options: storedOptions(opts), startedBy: "desktop" });
      ctl.onChange(summarize(created, () => true));
      return segment(projectId, runId, ctl);
    },

    async resume(projectId, runId, how, ctl) {
      const v = await readRun(repo, projectId, runId);
      if (!v) throw new NotFoundError("Download run", runId);
      if (v.record.run.state === "finished" && v.record.run.failed === 0) throw new InvalidInputError(NOTHING_TO_RESUME);
      if (ctl.cancelled()) throw new CaptureCancelledError();
      ctl.onChange(summarize(await setRunState(repo, projectId, runId, "queued"), () => true));
      return segment(projectId, runId, ctl, how);
    },

    async list(projectId, held) {
      return (await readRuns(repo, projectId)).map((v) => summarize(v, held));
    },

    async get(projectId, runId, held) {
      const v = await readRun(repo, projectId, runId);
      return v ? summarize(v, held) : undefined;
    },

    async problems(projectId, runId) {
      const v = await readRun(repo, projectId, runId);
      if (!v) throw new NotFoundError("Download run", runId);
      const platform = v.record.run.platform;
      const items = await readRunItems(repo, projectId, runId);
      return {
        platform,
        problems: items
          .filter((i) => i.status === "failed")
          .map((i) => ({
            ...(i.item.title ? { title: i.item.title } : {}),
            url: i.item.url,
            reason: downloadProblemText(i.item.errorCode, platform),
            ...(i.item.platformReason ? { platformReason: i.item.platformReason } : {}),
          })),
      };
    },

    async stopNotRunning(projectId, runId) {
      const v = await readRun(repo, projectId, runId);
      if (!v) return undefined;
      const state = v.record.run.state;
      // A finished or stopped run stays as it is.
      if (state === "finished" || state === "stopped") return summarize(v, () => false);
      return summarize(await setRunState(repo, projectId, runId, "stopped", { reason: plainReason("RUN_STOPPED") }), () => false);
    },

    discard(projectId, runId) {
      return discardRun(repo, projectId, runId);
    },
  };
}
