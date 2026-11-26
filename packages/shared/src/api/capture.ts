/**
 * A capture queue's state, readable again (Task 63, R146): the capture screen reads it on opening and
 * after a reconnect, so a running capture is always visible and outcomes it missed are replaced by
 * the truth. Desktop app only (the UI token, from the shell's origin); a paired extension cannot read
 * queues (R116: its token reaches only its own capture routes and the project list).
 *
 * - `GET /projects/:id/captures` → CaptureQueueListResponse: the project's running queues and its
 *   recent finished ones that this run of the service knows of (started from the screen, the
 *   extension or the command line through the service), newest first: every running queue, and at
 *   most CAPTURE_QUEUES_LISTED finished ones. Summaries only.
 * - `GET /projects/:id/captures/:queueId` → CaptureQueueDetail: one queue with its items' outcomes.
 *   404 for a queue of another project, an unknown one, or one no longer kept.
 * - Both refuse a locked project (423 PROJECT_LOCKED).
 * - `POST /projects/:id/captures/cut-by-lock/acknowledge` → CaptureCutByLockAcknowledged: the
 *   researcher's "Got it" for `cutByLock` (FR-370, FR-371; R464 b); the count is forgotten. Desktop
 *   app only; refuses a locked project (423) as the reads do.
 *
 * A finished queue stays readable for CAPTURE_QUEUE_KEEP_MS after it ended, and the service keeps at
 * most CAPTURE_QUEUES_KEPT finished queues (the oldest finished go first). Running queues are always
 * kept. A queue's items are kept up to CAPTURE_ITEMS_KEPT (a links queue has at most 500); a longer
 * profile run keeps counting but keeps no more items (`itemsOmitted`).
 *
 * Starting a capture of an address that is still waiting or being captured in a running queue of the
 * same project is refused: 409 CONFLICT with reason CAPTURE_RUNNING (R146; Task 63).
 */

/**
 * The count of a profile run's possible caption edits that could not be checked (FR-106), said one
 * way wherever it is shown: the command line, the capture queue and the run's report file (R473 M6).
 */
export function editsNotCheckedText(n: number): string {
  return n === 1
    ? "1 possible edit could not be checked. Capture the profile again later to check it."
    : `${n} possible edits could not be checked. Capture the profile again later to check them.`;
}

/** How long a finished queue stays readable (1 hour). */
export const CAPTURE_QUEUE_KEEP_MS = 60 * 60_000;
/** Finished queues kept by the service at most (all projects together). */
export const CAPTURE_QUEUES_KEPT = 50;
/** Finished queues listed per project at most (after every running one). */
export const CAPTURE_QUEUES_LISTED = 20;
/** Items kept per queue at most. */
export const CAPTURE_ITEMS_KEPT = 2000;

/** The refusal reason of a capture whose address is already waiting or being captured. */
export const CAPTURE_RUNNING = "CAPTURE_RUNNING";
/**
 * The refusal reason while a capture of the project that was ended (its project was locked) is still
 * finishing its current download: its addresses are forgotten, so the project waits as a whole
 * (Task 63 fix round 2, I3).
 */
export const CAPTURE_STOPPING = "CAPTURE_STOPPING";

export type CaptureQueueKind = "links" | "profile";
/** Who started the queue: the desktop app (or the command line through the service), or the paired extension. */
export type CaptureStartedBy = "desktop" | "extension";

/** One link's outcome (the library's CaptureOutcome, carried through unchanged). */
export interface CaptureItemOutcome {
  url: string;
  /** One of CAPTURE_ITEM_STATUSES (a later service may send another). */
  status: CaptureItemStatus | (string & {});
  sourceId?: string;
  /** The library's own plain sentence. */
  reason?: string;
  errorCode?: string;
  /** The optional tool that was missing (a ToolId), with TOOL_NOT_INSTALLED or a transcript note. */
  tool?: string;
  /** The platform's own words for why it refused (no link, at most 200 characters); shown through UserText. */
  platformReason?: string;
}

/** A profile run's report (the library's ProfileCaptureReport without its items, which are the queue's). */
export interface CaptureRunReport {
  status: "completed" | "paused-rate-limited" | "failed" | (string & {});
  profileSourceId?: string;
  batchId?: string;
  listComplete: boolean;
  created: number;
  duplicates: number;
  incomplete: number;
  failed: number;
  newlyUnavailable: number;
  reappeared: number;
  edited: number;
  /** Posts whose caption looks edited but could not be checked (FR-106); absent from older reports. */
  editsNotChecked?: number;
  errorCode?: string;
  /** The library's own sentence for a stopped or paused run. */
  reason?: string;
  tool?: string;
}

export interface CaptureQueueSummary {
  queueId: string;
  projectId: string;
  kind: CaptureQueueKind;
  startedBy: CaptureStartedBy;
  /** The profile's address (profile runs). */
  url?: string;
  /** Items finished so far. */
  done: number;
  /** Items in all; null while a profile is still being listed. */
  total: number | null;
  finished: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Why the queue stopped as a whole: the kind of error only (for example "WorkerUnavailableError"), never its message. */
  error?: string;
  report?: CaptureRunReport;
}

export interface CaptureQueueDetail extends CaptureQueueSummary {
  /** A links queue's addresses in order (every one, captured or not); absent for a profile run. */
  urls?: string[];
  /** The outcomes so far, in order: `items[i]` is item i. */
  items: CaptureItemOutcome[];
  /** Items finished but not kept (a profile run longer than CAPTURE_ITEMS_KEPT). */
  itemsOmitted?: number;
}

export interface CaptureQueueListResponse {
  queues: CaptureQueueSummary[];
  /**
   * How many links a lock of this project stopped before they were captured, not yet acknowledged
   * (R464 b). Only the count: the addresses were not kept while the project was locked. Absent when none.
   */
  cutByLock?: number;
}

export interface CaptureCutByLockAcknowledged {
  acknowledged: true;
}

// ---- starting a capture (Task 47: one declaration for the service and the interface) ----
//
// - `POST /projects/:id/capture`         CaptureLinksRequest   → CaptureStartedResponse
// - `POST /projects/:id/capture-profile` CaptureProfileRequest → CaptureStartedResponse
// - `POST /projects/:id/acknowledge`     AcknowledgeRequest    → AcknowledgeResponse
// - `GET /tools/versions`                → CaptureToolVersionsResponse
// - `POST /tools/update`                 → CaptureToolsUpdateResponse
// Outcomes arrive as `capture.progress` events (CaptureProgressEvent) on `GET /events`.

/** Links queued at once (R111: an extension's link list too); more is 400 VALIDATION. */
export const CAPTURE_LINKS_MAX = 500;

/** The browsers whose signed-in session the downloader can use (`cookiesFromBrowser`). */
export const CAPTURE_BROWSERS = ["chrome", "firefox", "safari", "edge", "brave"] as const;
export type CaptureBrowser = (typeof CAPTURE_BROWSERS)[number];

/** The parts of a profile a profile capture can list (`contentTypes`). */
export const CAPTURE_CONTENT_TYPES = ["posts", "reels", "videos", "shorts", "highlights"] as const;
export type CaptureContentType = (typeof CAPTURE_CONTENT_TYPES)[number];

/** A captured link's outcome (`CaptureItemOutcome.status`; the library's CaptureStatus). */
export const CAPTURE_ITEM_STATUSES = ["created", "duplicate", "refreshed", "incomplete", "failed", "needs-review"] as const;
export type CaptureItemStatus = (typeof CAPTURE_ITEM_STATUSES)[number];

/**
 * The options of a links capture as the service reads them (routes/capture.ts `captureOptions`);
 * anything else in `options` is ignored. A browser outside CAPTURE_BROWSERS, or a model outside
 * SPEECH_MODELS, is 400 VALIDATION.
 */
export interface CaptureRequestOptions {
  /** Use this browser's signed-in session (needs the project's acknowledgement: 409 ACKNOWLEDGEMENT_REQUIRED). */
  cookiesFromBrowser?: CaptureBrowser;
  /** Left out: the project's own setting. */
  transcribe?: boolean;
  /** One of SPEECH_MODELS (any other is 400 VALIDATION). */
  transcribeModel?: string;
  /** For a post already in the project: save a new dated snapshot. */
  refreshIfExists?: boolean;
  /** At most 2000 characters; the project's default for social media when left out (R41). */
  legalBasis?: string;
  /** The requested quality of a video download (the downloader's own choice when left out). */
  quality?: "best" | "1080p" | "720p" | "audio" | "ready";
}

/** A profile run's options: the links options and these (`since`/`until` are YYYY-MM-DD). */
export interface ProfileCaptureRequestOptions extends CaptureRequestOptions {
  since?: string;
  until?: string;
  /** A whole number of 1 or more. Setting it turns off removed-item detection (R43). */
  maxItems?: number;
  contentTypes?: CaptureContentType[];
  metadataOnly?: boolean;
  includeComments?: boolean;
}

/** `POST /projects/:id/capture`: at most CAPTURE_LINKS_MAX web addresses. */
export interface CaptureLinksRequest {
  urls: string[];
  options?: CaptureRequestOptions;
}

/** `POST /projects/:id/capture-profile`. */
export interface CaptureProfileRequest {
  url: string;
  options?: ProfileCaptureRequestOptions;
}

/** Both start routes: the queue whose `capture.progress` events and state (`GET …/captures/:queueId`) follow. */
export interface CaptureStartedResponse {
  queueId: string;
}

// Refusals the start routes name (besides the codes any route can answer): the project's rules
// (403 POLICY_DENIED with the rule's reason), a locked project (423), the browser session not
// acknowledged (409 ACKNOWLEDGEMENT_REQUIRED, reason "cookies"), the media helper not running (503
// WORKER_UNAVAILABLE), an address already being captured or an ended capture still finishing (409
// CONFLICT, reason CAPTURE_RUNNING or CAPTURE_STOPPING).

/** A profile run's report with its items, as a `capture.progress` event carries it (the library's ProfileCaptureReport). */
export interface CaptureProfileReport extends CaptureRunReport {
  items: CaptureItemOutcome[];
}

/**
 * A `capture.progress` event of a queue: after each item (`done`, `total`, `outcome`), and at its
 * end (`finished: true`, with a profile run's `report`, or `error` when the queue stopped as a
 * whole: the error's kind and message, which are never shown).
 */
export interface CaptureQueueProgressEvent {
  queueId: string;
  projectId: string;
  done?: number;
  total?: number;
  outcome?: CaptureItemOutcome;
  finished: boolean;
  report?: CaptureProfileReport;
  error?: string;
}

/** A `capture.progress` event of a page captured by the browser extension (no queue). */
export interface BrowserCaptureProgressEvent {
  kind: "browser";
  projectId: string;
  sourceId: string;
  status: string;
  finished: true;
}

export type CaptureProgressEvent = CaptureQueueProgressEvent | BrowserCaptureProgressEvent;

/** `POST /projects/:id/acknowledge`: the one-time browser-session acknowledgement (spec 5.1). */
export interface AcknowledgeRequest {
  kind: "cookies";
}

/** The project's acknowledgements after it (e.g. `["cookies"]`). */
export interface AcknowledgeResponse {
  acknowledgements: string[];
}

/** `GET /tools/versions`: each capture tool's version, null when it is not there. */
export interface CaptureToolVersionsResponse {
  versions: Record<string, string | null>;
}

/**
 * `POST /tools/update` (the downloader). A failure is 502 TOOL_FAILED with the media helper's code
 * as `reason` (502 INTERNAL for another failure of its job), or 503 WORKER_UNAVAILABLE.
 */
export interface CaptureToolsUpdateResponse {
  ytDlp: { old: string | null; new: string | null; managed: boolean };
  galleryDl: { version: string | null; pinned: boolean };
}
