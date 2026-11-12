/**
 * The optional tools offered on first use (Task 48, R126): the catalogue, and installing, updating
 * and removing a tool as a job. Desktop app only (the UI token, from the shell's origin).
 *
 * - `GET /tools` → ToolsResponse: every tool, and the tool jobs of this run of the service (a
 *   reloaded interface finds a running install here).
 * - `POST /tools/:toolId/install` | `/update` | `/remove` (no body) → 202 ToolJobResponse. Asking
 *   again while the same action runs gives the same job; another action meanwhile is 409 CONFLICT.
 * - `GET /tools/jobs/:jobId` → ToolJobResponse; `POST /tools/jobs/:jobId/cancel` → ToolJobResponse.
 * - Progress: `job.progress` events with `{ kind: "tool", job: ToolJob }`.
 *
 * A job of a project whose tool is missing (capture, transcription, viewing copies, OCR) fails with
 * TOOL_NOT_INSTALLED naming the tool id: a route answers `409 { error: { code: "TOOL_NOT_INSTALLED",
 * reason: <ToolId> } }`; a capture outcome carries `errorCode: "TOOL_NOT_INSTALLED"`.
 */

export const TOOL_IDS = ["speech-tiny", "speech-small", "speech-medium", "speech-large-v3", "video-downloader", "image-downloader", "ffmpeg", "ocr"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export function isToolId(v: string): v is ToolId {
  return (TOOL_IDS as readonly string[]).includes(v);
}

/**
 * The speech models the app accepts (R158): the one definition used by the worker's catalogue
 * (checked by services/media-worker/tests/test_tools.py), the service's validation, the capture
 * code, the transcript viewer and the tools dialogue. Nothing else can be installed or asked for.
 */
export const SPEECH_MODELS = ["tiny", "small", "medium", "large-v3"] as const;
export type SpeechModel = (typeof SPEECH_MODELS)[number];
/** The model used when none is named (R158: SPEC 5.2 names none; the transcript viewer's default). */
export const DEFAULT_SPEECH_MODEL: SpeechModel = "medium";

export function isSpeechModel(v: string): v is SpeechModel {
  return (SPEECH_MODELS as readonly string[]).includes(v);
}

/** The speech model tool for a transcription model name (`small` → `speech-small`). */
export function speechToolId(model: SpeechModel): ToolId {
  return `speech-${model}`;
}

export type ToolGroup = "speech" | "capture" | "media" | "documents";
export type ToolAction = "install" | "update" | "remove";
export const TOOL_ACTIONS: readonly ToolAction[] = ["install", "update", "remove"];

/** One part of a tool (the video downloader has two: yt-dlp and its JavaScript runtime). */
export interface ToolComponent {
  id: string;
  name: string;
  /** The version the app installs ("latest" for yt-dlp, which follows its releases: ADR 0009). */
  version: string;
  licence: string;
  installed: boolean;
  /** Installed and its quick self-check passed. */
  usable: boolean;
  /** managed: installed by the app; system: found on this computer; override: named by an AO_*_BIN variable. */
  source: "managed" | "system" | "override" | null;
  installedVersion: string | null;
  /** The app's own copy is older than the version it now installs. */
  outdated: boolean;
  /** Whether it can be downloaded for this computer. */
  available: boolean;
  unavailableReason?: string;
  downloadSize: number;
  sizeApproximate: boolean;
  /**
   * The host names its download contacts (R158), derived from its pins: the pinned addresses' hosts
   * and the exact hosts a redirect may lead to; for yt-dlp the release host and its file hosts.
   * Absent in answers from before Task 48a fix round 2.
   */
  hosts?: string[];
}

export interface ToolInfo {
  id: ToolId;
  group: ToolGroup;
  name: string;
  /** What it is for, in plain words. */
  purpose: string;
  /** What stops working without it. */
  without: string;
  version: string;
  /** Bytes of the whole download; `remainingSize`: what is still to be downloaded. */
  downloadSize: number;
  remainingSize: number;
  sizeApproximate: boolean;
  installed: boolean;
  usable: boolean;
  /** At least one part was installed by the app (so it can be removed). */
  managed: boolean;
  updateAvailable: boolean;
  /** Every missing part can be downloaded for this computer. */
  available: boolean;
  unavailableReason?: string;
  /** A licence or terms note to show with the choice. */
  notice?: string;
  components: ToolComponent[];
  /** The latest job of this tool in this run of the service, if any. */
  job?: ToolJob;
}

/** Codes a failed tool job carries in `error.code`. */
export type ToolErrorCode =
  | "TOOL_DOWNLOAD_FAILED"
  | "TOOL_CHECKSUM_MISMATCH"
  | "TOOL_ARCHIVE_UNSAFE"
  | "TOOL_WRITE_FAILED"
  | "TOOL_UNUSABLE"
  | "TOOL_UNAVAILABLE"
  | "TOOL_NOT_MANAGED"
  | "TOOL_UPDATE_FAILED"
  | "WORKER_UNAVAILABLE"
  | "CANCEL_UNCONFIRMED"
  | "FAILED";

export interface ToolJob {
  jobId: string;
  toolId: ToolId;
  action: ToolAction;
  status: "running" | "done" | "failed" | "cancelled";
  /** 0..1 */
  progress: number;
  startedAt: string;
  finishedAt?: string;
  /**
   * A cancel was asked for (fix round 2). The job stays `running` until the worker answers: then
   * `cancelled` (it stopped, nothing half-installed) or `done` (the install completed before the
   * cancel could take effect), or `failed` with CANCEL_UNCONFIRMED.
   */
  cancelRequested?: boolean;
  error?: { code: ToolErrorCode | string; message: string };
  /** For a finished job: which parts were installed, updated, removed or already in place. */
  result?: { installed?: string[]; updated?: Array<{ component: string; old: string | null; new: string | null }>; removed?: string[]; skipped?: string[] };
}

export interface ToolsResponse {
  /** `macos-arm64`, `macos-x64`, `linux-x64`, or null for a computer no tool is offered for. */
  platform: string | null;
  tools: ToolInfo[];
  jobs: ToolJob[];
}

export interface ToolJobResponse {
  job: ToolJob;
}
