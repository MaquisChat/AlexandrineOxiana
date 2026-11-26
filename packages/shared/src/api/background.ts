/**
 * Whole channels, transcribed without watching over them (R668, R669): the shapes of the download runs, the
 * transcription list, the estimate before a capture and the switches, and every sentence the service and the
 * screens both show, said once here.
 *
 * - Download runs: `GET /projects/:id/downloads` → DownloadRunListResponse; `…/downloads/:runId/problems` →
 *   DownloadProblemsResponse; `POST …/downloads/:runId/{pause|stop|resume}` → DownloadRunResponse;
 *   `POST …/downloads/:runId/discard` → DownloadRunDiscarded. `POST /projects/:id/capture-estimate`
 *   (CaptureEstimateRequest) → CaptureEstimate.
 * - The transcription list: `GET /projects/:id/transcription-list` → TranscriptionListResponse;
 *   `POST …/transcription-list/{pause|continue|stop}` → TranscriptionListResponse; `GET /projects/:id/untranscribed`
 *   → UntranscribedResponse; `POST /projects/:id/transcription-list` (TranscribeAllRequest) → TranscribeAllResponse.
 * - Switches: `GET`/`PUT /projects/:id/automation` (ProjectAutomation); `GET`/`PUT /settings/background`
 *   (BackgroundSettings).
 * - Progress: `background.progress` events (BackgroundProgressEvent).
 *
 * No Node or DOM API here (the package rule).
 */
import type { ProfileCaptureRequestOptions } from "./capture.js";
import type { SpeechModel } from "./tools.js";

// ---- qualities and sizes ---------------------------------------------------------------------------

export type DownloadQuality = "best" | "1080p" | "720p" | "audio" | "ready";
/** In the order the estimate offers them. */
export const DOWNLOAD_QUALITIES: readonly DownloadQuality[] = ["best", "720p", "1080p", "audio", "ready"];
/** The qualities the downloader can give only with ffmpeg ("Video tools") installed. */
export const QUALITIES_NEEDING_VIDEO_TOOLS: readonly DownloadQuality[] = ["best", "720p", "1080p", "audio"];
export const DEFAULT_QUALITY: DownloadQuality = "720p";
/** The quality offered when Video tools are not installed. */
export const FALLBACK_QUALITY: DownloadQuality = "ready";

export const QUALITY_LABELS: Record<DownloadQuality, string> = {
  best: "Best available",
  "720p": "Up to 720p",
  "1080p": "Up to 1080p",
  audio: "Audio only",
  ready: "Ready-made file (lower quality)",
};

/** Bytes per second of recording, low and high, by quality (plan's decision). */
export const BYTES_PER_SECOND: Record<DownloadQuality, { low: number; high: number }> = {
  best: { low: 400_000, high: 1_500_000 },
  "1080p": { low: 270_000, high: 450_000 },
  "720p": { low: 135_000, high: 225_000 },
  audio: { low: 12_000, high: 20_000 },
  ready: { low: 60_000, high: 110_000 },
};

/** Downloading pauses before a download that would leave less than this free (10 GB). */
export const DISK_FLOOR_BYTES = 10_000_000_000;

export type CapturePlatform = "youtube" | "instagram" | "tiktok";

const PLATFORM_NAMES: Record<CapturePlatform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

export function platformName(p: CapturePlatform): string {
  return PLATFORM_NAMES[p];
}

/** "video"/"videos", or "post"/"posts" for Instagram. */
function noun(p: CapturePlatform, n: number): string {
  const one = p === "instagram" ? "post" : "video";
  return n === 1 ? one : `${one}s`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function estimateBytes(soundSeconds: number, q: DownloadQuality): { low: number; high: number } {
  const r = BYTES_PER_SECOND[q];
  return { low: soundSeconds * r.low, high: soundSeconds * r.high };
}

const UNITS: ReadonlyArray<[number, string]> = [
  [1e12, "TB"],
  [1e9, "GB"],
  [1e6, "MB"],
];

/** Two significant figures in the largest unit that fits (rounding up into the next unit when it reaches 1000). */
function sizeParts(bytes: number): { value: number; unit: string } | undefined {
  if (!(bytes >= 1e6)) return undefined;
  for (let i = 0; i < UNITS.length; i++) {
    const [size, unit] = UNITS[i]!;
    if (bytes < size) continue;
    const value = Number((bytes / size).toPrecision(2));
    if (value >= 1000 && i > 0) {
      const [up, upUnit] = UNITS[i - 1]!;
      return { value: Number((bytes / up).toPrecision(2)), unit: upUnit };
    }
    return { value, unit };
  }
  return undefined;
}

export function formatSize(bytes: number): string {
  const s = sizeParts(bytes);
  return s ? `${s.value} ${s.unit}` : "less than 1 MB";
}

/** "150–250 GB" in one unit, else "900 MB–1.5 GB" (en dash, no spaces); "up to 1.2 MB" when only the high end reaches 1 MB. */
export function formatSizeRange(low: number, high: number): string {
  const a = sizeParts(low);
  const b = sizeParts(high);
  if (a && b && a.unit === b.unit) return a.value === b.value ? `${b.value} ${b.unit}` : `${a.value}–${b.value} ${b.unit}`;
  if (!b) return "less than 1 MB";
  if (!a) return `up to ${formatSize(high)}`;
  const lo = formatSize(low);
  const hi = formatSize(high);
  return lo === hi ? hi : `${lo}–${hi}`;
}

export function formatSoundLength(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.max(1, Math.round(seconds / 60));
    return m >= 60 ? "about 1 hour" : `about ${plural(m, "minute")}`;
  }
  if (seconds < 36_000) {
    const h = Math.round(seconds / 360) / 10;
    return h === 1 ? "about 1 hour" : `about ${h} hours`;
  }
  return `about ${Math.round(seconds / 3600)} hours`;
}

export function formatWait(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  return plural(Math.max(1, Math.round(ms / 60_000)), "minute");
}

export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  if (seconds < 7200) {
    const m = Math.round(seconds / 60);
    return m >= 120 ? "about 2 hours" : `about ${plural(m, "minute")}`;
  }
  if (seconds < 172_800) {
    const h = Math.round(seconds / 3600);
    return h >= 48 ? "about 2 days" : `about ${plural(h, "hour")}`;
  }
  return `about ${plural(Math.round(seconds / 86_400), "day")}`;
}

/** Seconds of sound transcribed per second of the Mac's time, in words. */
export function formatSpeed(soundPerSecond: number): string {
  if (soundPerSecond >= 1) return `${plural(Math.round(soundPerSecond), "minute")} of sound per minute`;
  return `${plural(Math.round(1 / soundPerSecond), "minute")} for each minute of sound`;
}

// ---- the estimate ------------------------------------------------------------------------------------

export interface CaptureEstimateRequest {
  url: string;
  options?: ProfileCaptureRequestOptions;
}

export interface CaptureEstimate {
  kind: "channel" | "playlist" | "profile";
  platform: CapturePlatform;
  title: string;
  /** What will be downloaded: listed and not yet in the project. */
  count: number;
  alreadyInProject: number;
  /** The sum of the known lengths of what will be downloaded. */
  soundSeconds: number;
  unknownLengths: number;
  listComplete: boolean;
  freeBytes: number | null;
  diskName: string | null;
  videoToolsInstalled: boolean | null;
  speechModel: string;
  /** Seconds of sound per second, measured on this Mac for `speechModel`; absent until measured. */
  measuredSpeed?: number;
  metadataOnly: boolean;
}

function freePart(e: CaptureEstimate): string {
  if (e.freeBytes === null) return "";
  return e.diskName !== null ? ` ${formatSize(e.freeBytes)} are free on "${e.diskName}".` : ` ${formatSize(e.freeBytes)} are free on this computer's disk.`;
}

export const estimateText = {
  heading(kind: CaptureEstimate["kind"], title: string): string {
    return `Capture ${kind}: "${title}"`;
  },
  listing(p: CapturePlatform): string {
    return `Asking ${platformName(p)} for the list of ${noun(p, 2)}…`;
  },
  count(e: CaptureEstimate): string {
    if (e.count === 0) return estimateText.nothingNew(e.platform);
    const what = `${e.count} ${noun(e.platform, e.count)}`;
    if (e.unknownLengths >= e.count) return e.count === 1 ? `${what}; its length is not known.` : `${what}; their lengths are not known.`;
    const length = formatSoundLength(e.soundSeconds);
    return e.unknownLengths > 0 ? `${what}, ${length} (${e.unknownLengths} of unknown length).` : `${what}, ${length}.`;
  },
  alreadyIn(e: CaptureEstimate): string | undefined {
    if (e.alreadyInProject <= 0) return undefined;
    return e.alreadyInProject === 1
      ? "1 more is already in this project and is not downloaded again."
      : `${e.alreadyInProject} more are already in this project and are not downloaded again.`;
  },
  nothingNew(p: CapturePlatform): string {
    return `Nothing new to download: every ${noun(p, 1)} listed is already in this project. Starting checks the listed ${noun(p, 2)} for changes and removals.`;
  },
  cutShort(e: CaptureEstimate): string | undefined {
    return e.listComplete ? undefined : `${platformName(e.platform)} stopped listing part-way, so this may not be the whole ${e.kind}.`;
  },
  disk(e: CaptureEstimate, q: DownloadQuality): string {
    if (e.count === 0) return "Nothing new will be downloaded, so no disk space is needed.";
    if (e.metadataOnly) return "Metadata only: almost no disk space is needed.";
    if (e.count > 0 && e.unknownLengths >= e.count) {
      return `Size unknown: ${platformName(e.platform)} did not give the ${noun(e.platform, 2)}' lengths.${freePart(e)}`;
    }
    const { low, high } = estimateBytes(e.soundSeconds, q);
    const range = formatSizeRange(low, high);
    const more = e.unknownLengths > 0 ? `, and more for the ${e.unknownLengths} ${noun(e.platform, e.unknownLengths)} of unknown length` : "";
    return `Roughly ${range} at this quality${more}.${freePart(e)}`;
  },
  tooBig(e: CaptureEstimate, q: DownloadQuality): string | undefined {
    if (e.count === 0 || e.metadataOnly || e.freeBytes === null) return undefined;
    return estimateBytes(e.soundSeconds, q).high > e.freeBytes - DISK_FLOOR_BYTES
      ? "This may need more space than the disk has free, less the 10 GB the app keeps free."
      : undefined;
  },
  downloadTime(e: CaptureEstimate): string {
    const s = e.count * 30;
    const how = s < 3600 ? "less than an hour" : s >= 86_400 ? "a day or more" : "some hours";
    return `Downloading: ${how}; it depends on ${platformName(e.platform)}.`;
  },
  transcribeTime(e: CaptureEstimate): string {
    if (e.measuredSpeed !== undefined && e.measuredSpeed > 0) {
      if (e.soundSeconds === 0 && e.unknownLengths > 0) return "Transcribing: the lengths are not known, so the app cannot say how long.";
      const measured = `Transcribing: ${formatTimeLeft(e.soundSeconds / e.measuredSpeed)} at this Mac's speed (${formatSpeed(e.measuredSpeed)}).`;
      if (e.unknownLengths <= 0) return measured;
      const n = e.unknownLengths;
      return `${measured} The ${n} ${noun(e.platform, n)} of unknown length ${n === 1 ? "is" : "are"} not counted.`;
    }
    const first = `the first ${noun(e.platform, 1)} on this Mac`;
    return e.soundSeconds >= 86_400
      ? `Transcribing: days rather than hours. The app will say more exactly once it has transcribed ${first}.`
      : `Transcribing: the app will say how long once it has transcribed ${first}.`;
  },
  transcribeLabel(model: string): string {
    return `Transcribe each video on this Mac (speech model: ${model})`;
  },
  videoToolsNeeded: "These need Video tools.",
  installVideoTools: "Install Video tools",
  start: "Start",
  startAnyway: "Start anyway — it will pause when the disk is nearly full",
  cancel: "Cancel",
  settingsChanged: "The settings changed, so the estimate was closed. Press “Capture profile” to see it again.",
  switchNotRead:
    "The project's switch for automatic transcription could not be read. This capture follows the switch as it stands, unless you tick the box.",
  listingSlow(p: CapturePlatform): string {
    return `Still asking ${platformName(p)} for the list. A long list can take a few minutes.`;
  },
  legends: { quality: "Quality", transcribe: "Transcribe", disk: "Disk", time: "Time" },
};

// ---- download runs ---------------------------------------------------------------------------------

/** "queued": waiting its turn behind another run of the project (coordinator, R669). */
export type DownloadRunState =
  | "queued" | "downloading" | "waiting" | "paused" | "paused-disk" | "paused-rate-limited"
  | "paused-tool" | "interrupted" | "stopped" | "finished" | "failed";

export interface DownloadRunSummary {
  runId: string;
  projectId: string;
  url: string;
  title: string;
  platform: CapturePlatform;
  quality?: DownloadQuality;
  transcribe: boolean;
  state: DownloadRunState;
  total: number;
  done: number;
  failed: number;
  /** total − done */
  notCompleted: number;
  wait?: { ms: number; why: "rate-limited" | "connection" };
  tool?: string;
  reason?: string;
  startedAt: string;
  updatedAt: string;
}

export interface DownloadProblem {
  title?: string;
  url: string;
  reason: string;
  platformReason?: string;
}
export interface DownloadRunListResponse {
  runs: DownloadRunSummary[];
}
export interface DownloadRunResponse {
  run: DownloadRunSummary;
}
export interface DownloadProblemsResponse {
  platform: CapturePlatform;
  problems: DownloadProblem[];
}
export interface DownloadRunDiscarded {
  discarded: true;
}

/** The `reason` of a 409 CONFLICT for a run (or an address) already being downloaded. */
export const RUN_ALREADY_RUNNING = "RUN_ALREADY_RUNNING";
export const RUN_ALREADY_RUNNING_TEXT = "These downloads are already running.";
export const RUN_NOT_RUNNING_TEXT = "These downloads are not running.";
export const VIDEO_TOOLS_NEEDED_TEXT =
  "Video tools are not installed, so this quality cannot be downloaded. Install them from the Optional tools screen, or choose “Ready-made file (lower quality)”.";

export function estimateRateLimitedText(p: CapturePlatform): string {
  return `${platformName(p)} is asking the app to slow down, so the list could not be read. Try again in a few minutes.`;
}

const RUNNING_STATES: ReadonlySet<DownloadRunState> = new Set(["queued", "downloading", "waiting"]);

function toolMissing(tool: string | undefined): string {
  const then = "from the Optional tools screen, then press Resume downloads.";
  if (tool === "ffmpeg") return `Paused: Video tools are not installed. Install them ${then}`;
  if (tool === "video-downloader") return `Paused: the video downloader is not installed. Install it ${then}`;
  if (tool === "image-downloader") return `Paused: the image downloader is not installed. Install it ${then}`;
  return `Paused: a tool this needs is not installed. Install it ${then}`;
}

/** The sentences of a run's line on the screens. */
export function runLines(run: DownloadRunSummary): { title: string; wait?: string; failures?: string; why?: string; resume?: string } {
  const t = run.title;
  const of = `${run.done} of ${run.total}`;
  const downloading = run.total === 0 ? `Downloading "${t}": reading the list of ${noun(run.platform, 2)}…` : `Downloading "${t}": ${of}`;
  /** The paused and failed title of a run whose list was never read (total 0). */
  const notRead = run.total === 0 ? `"${t}": the list of ${noun(run.platform, 2)} has not been read yet.` : undefined;
  let title: string;
  let why: string | undefined;
  let wait: string | undefined;
  switch (run.state) {
    case "queued":
      title = `"${t}" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.`;
      break;
    case "downloading":
      title = downloading;
      break;
    case "waiting":
      title = downloading;
      if (run.wait) {
        wait = `waiting ${formatWait(run.wait.ms)} — ${run.wait.why === "rate-limited" ? `${platformName(run.platform)} asked to slow down` : "the connection was lost"}`;
      }
      break;
    case "interrupted":
      title = run.total === 0 ? `The capture of '${t}' was interrupted before it began.` : `The capture of '${t}' was interrupted: ${of} done.`;
      break;
    case "paused":
      title = run.total === 0 ? `"${t}" is paused. The list of ${noun(run.platform, 2)} has not been read yet.` : `"${t}" is paused: ${of} downloaded.`;
      break;
    case "paused-disk":
      title = notRead ?? `"${t}": ${of} downloaded.`;
      why = "Paused: the disk is nearly full. Free some space, then press Resume downloads.";
      break;
    case "paused-rate-limited":
      title = notRead ?? `"${t}": ${of} downloaded.`;
      why = `Paused: ${platformName(run.platform)} kept asking the app to slow down for 12 hours. Press Resume downloads to try again.`;
      break;
    case "paused-tool":
      title = notRead ?? `"${t}": ${of} downloaded.`;
      why = toolMissing(run.tool);
      break;
    case "failed":
      title = notRead ?? `"${t}": ${of} downloaded.`;
      why = run.reason;
      break;
    case "stopped":
      title = run.total === 0 ? `"${t}" was stopped before it began.` : `"${t}" was stopped: ${of} downloaded.`;
      break;
    case "finished":
      title =
        run.failed > 0
          ? `"${t}": ${of} downloaded. ${run.failed} could not be downloaded.`
          : run.total === 0
            ? `"${t}": nothing new to download.`
            : `"${t}": all ${run.total} downloaded.`;
      break;
  }
  const failures = run.failed > 0 && run.state !== "finished" ? `${run.failed} could not be downloaded` : undefined;
  let resume: string | undefined;
  if (!RUNNING_STATES.has(run.state)) {
    if (run.notCompleted > 0) resume = `Resume downloads (${run.notCompleted} did not complete)`;
    else if (run.total === 0 && run.state !== "finished") resume = "Resume downloads";
  }
  return {
    title,
    ...(wait !== undefined ? { wait } : {}),
    ...(failures !== undefined ? { failures } : {}),
    ...(why !== undefined ? { why } : {}),
    ...(resume !== undefined ? { resume } : {}),
  };
}

/** A failed item's error code in plain words. */
export function downloadProblemText(code: string | undefined, p: CapturePlatform): string {
  const it = noun(p, 1);
  switch (code) {
    case "PRIVATE":
      return `This ${it} is private.`;
    case "NOT_FOUND_OR_REMOVED":
      return `This ${it} has been removed, or its address is wrong.`;
    case "GEO_BLOCKED":
      return `This ${it} is not available in your country.`;
    case "LOGIN_REQUIRED":
      return `This ${it} needs a sign-in the app does not have.`;
    case "NETWORK_LOST":
      return "The connection was lost three times.";
    case "EXTRACTOR_ERROR":
      return `The downloader could not read this ${it}. Updating the capture tools may help.`;
    case "NOTHING_SAVED":
      return `Nothing came back from the platform for this ${it}.`;
    case "LEGAL_BASIS_REQUIRED":
      return `This project's rules need a legal basis for this ${it}, and none was given.`;
    default:
      return `This ${it} could not be downloaded.`;
  }
}

export function platformSays(p: CapturePlatform, words: string): string {
  return `${platformName(p)} says: “${words}”`;
}

export const PROBLEMS_TEXT = {
  heading: "Could not be downloaded",
  copy: "Copy the list",
  copied: "The list was copied.",
  copyFailed: "The list could not be copied. Select it and copy it by hand.",
  noTitle: "(no title)",
};

/** One problem as a line of the copied list. */
export function problemLine(pr: DownloadProblem, p: CapturePlatform): string {
  const says = pr.platformReason ? ` ${platformSays(p, pr.platformReason)}` : "";
  return `${pr.title || PROBLEMS_TEXT.noTitle} — ${pr.url} — ${pr.reason}${says}`;
}

/** `remove` (R679 C1): the one button of a finished run with nothing left to do; it discards the run. */
export const RUN_BUTTONS = { pause: "Pause", stop: "Stop", showThem: "Show them", discard: "Discard", remove: "Remove from this list" };

// ---- the transcription list --------------------------------------------------------------------------

export interface TranscriptionListSummary {
  projectId: string;
  state: "running" | "paused" | "idle";
  total: number;
  done: number;
  failed: number;
  current?: { sourceId: string; title?: string; progress?: number };
  soundSecondsLeft: number;
  unknownLeft: number;
  soundPerSecond?: number;
}
export interface TranscriptionListResponse {
  list: TranscriptionListSummary;
}
export interface UntranscribedResponse {
  count: number;
  soundSeconds: number;
  unknownLengths: number;
}
export interface TranscribeAllRequest {
  model?: SpeechModel;
}
export interface TranscribeAllResponse {
  added: number;
  list: TranscriptionListSummary;
}

/** The sentences of the transcription line on the screens. */
export function transcriptionLines(l: TranscriptionListSummary): { title?: string; time?: string } {
  if (l.state === "paused") return { title: `Transcriptions paused: ${l.done} of ${l.total} done.` };
  if (l.state === "idle") {
    if (l.total <= 0) return {};
    return { title: l.failed > 0 ? `Transcriptions finished: ${l.done} of ${l.total} done; ${l.failed} could not be made.` : `Transcriptions finished: all ${l.total} done.` };
  }
  const name = l.current?.title;
  const title = name !== undefined ? `Transcribing: ${l.done} of ${l.total} — "${name}"` : `Transcribing: ${l.done} of ${l.total}`;
  const sps = l.soundPerSecond;
  if (sps === undefined || !(sps > 0)) return { title, time: "measuring…" };
  const unknown = l.unknownLeft > 0 ? `, not counting ${plural(l.unknownLeft, "recording")} of unknown length` : "";
  return { title, time: `${formatTimeLeft(l.soundSecondsLeft / sps)} left at this Mac's speed (${formatSpeed(sps)})${unknown}` };
}

/** `remove` (R679 C1): the one button of a finished list; it empties the list (a stop of an idle list). */
export const LIST_BUTTONS = { pause: "Pause", continue: "Continue", stop: "Stop", remove: "Remove from this list" };

/** Said once after a Stop of the transcription list (R672). */
export const LIST_STOPPED_TEXT: string =
  "The transcriptions were stopped. The sources stay; “Transcribe everything without a transcript” puts them on the list again.";

const ONE_AT_A_TIME = "They are transcribed one at a time on this Mac, after anything already on the list.";
const ONE_SOURCE = "It is transcribed on this Mac, after anything already on the list.";

export const transcribeAllText = {
  button: "Transcribe everything without a transcript",
  confirm(r: UntranscribedResponse): string {
    if (r.count <= 0) return transcribeAllText.none;
    const after = r.count === 1 ? ONE_SOURCE : ONE_AT_A_TIME;
    const have = r.count === 1 ? "1 source has audio or video and no transcript" : `${r.count} sources have audio or video and no transcript`;
    if (r.unknownLengths >= r.count) return `${have}; ${r.count === 1 ? "its length is" : "their lengths are"} not known. ${after}`;
    const unknown = r.unknownLengths > 0 ? ` ${r.unknownLengths} of them ${r.unknownLengths === 1 ? "has" : "have"} no known length.` : "";
    return `${have}: ${formatSoundLength(r.soundSeconds)} of sound.${unknown} ${after}`;
  },
  none: "Every source with audio or video already has a transcript, or is already on the transcription list.",
  added(n: number): string {
    return n === 1 ? "1 source was put on the transcription list." : `${n} sources were put on the transcription list.`;
  },
  confirmButton: "Transcribe them",
  cancel: "Cancel",
};

// ---- switches, the work lines and the event -----------------------------------------------------------

export interface ProjectAutomation {
  transcribeNewMedia: boolean;
}
export const AUTOMATION_TEXT = {
  heading: "Automatic transcription",
  label: "Transcribe captured audio and video automatically",
  hint: "Applies to captures from links, channels, playlists and profiles. Files you import or drop in are not transcribed by this switch; “Transcribe everything without a transcript” in the sources list covers them.",
};

export interface BackgroundSettings {
  keepAwake: boolean;
}
export const KEEP_AWAKE_TEXT = {
  heading: "While downloads or transcriptions run",
  label: "Keep this Mac awake while downloads or transcriptions run",
  hint: "The screen may still switch off. Closing the lid still puts the Mac to sleep; downloads and transcriptions carry on when it wakes.",
};

export const WORK_LINES_TEXT = {
  heading: "Downloads and transcriptions",
  lost: "Progress updates for downloads and transcriptions are not available right now. They keep running in the library service.",
  reconnect: "Reconnect",
};

export const BACKGROUND_EVENT = "background.progress";

export interface BackgroundProgressEvent {
  projectId: string;
  downloads?: DownloadRunSummary;
  /** The id of a run that was discarded. */
  discarded?: string;
  transcriptions?: TranscriptionListSummary;
}
