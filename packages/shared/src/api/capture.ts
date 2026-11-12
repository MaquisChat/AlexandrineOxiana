/**
 * A capture queue's state, readable again (Task 63, R146): the capture screen reads it on opening and
 * after a reconnect, so a running capture is always visible and outcomes it missed are replaced by
 * the truth. Desktop app only (the UI token, from the shell's origin); a paired extension cannot read
 * queues (R116: its token reaches only its own capture routes and the project list).
 *
 * - `GET /projects/:id/captures` → CaptureQueueListResponse: the project's running queues and its
 *   recent finished ones that this run of the service knows of (started from the screen, the
 *   extension or the command line through the service), newest first, at most
 *   CAPTURE_QUEUES_LISTED. Summaries only.
 * - `GET /projects/:id/captures/:queueId` → CaptureQueueDetail: one queue with its items' outcomes.
 *   404 for a queue of another project, an unknown one, or one no longer kept.
 * - Both refuse a locked project (423 PROJECT_LOCKED).
 *
 * A finished queue stays readable for CAPTURE_QUEUE_KEEP_MS after it ended, and the service keeps at
 * most CAPTURE_QUEUES_KEPT finished queues (the oldest finished go first). Running queues are always
 * kept. A queue's items are kept up to CAPTURE_ITEMS_KEPT (a links queue has at most 500); a longer
 * profile run keeps counting but keeps no more items (`itemsOmitted`).
 *
 * Starting a capture of an address that is still waiting or being captured in a running queue of the
 * same project is refused: 409 CONFLICT with reason CAPTURE_RUNNING (R146; Task 63).
 */

/** How long a finished queue stays readable (1 hour). */
export const CAPTURE_QUEUE_KEEP_MS = 60 * 60_000;
/** Finished queues kept by the service at most (all projects together). */
export const CAPTURE_QUEUES_KEPT = 50;
/** Queues listed per project at most (running first, then the most recently finished). */
export const CAPTURE_QUEUES_LISTED = 20;
/** Items kept per queue at most. */
export const CAPTURE_ITEMS_KEPT = 2000;

/** The refusal reason of a capture whose address is already waiting or being captured. */
export const CAPTURE_RUNNING = "CAPTURE_RUNNING";

export type CaptureQueueKind = "links" | "profile";
/** Who started the queue: the desktop app (or the command line through the service), or the paired extension. */
export type CaptureStartedBy = "desktop" | "extension";

/** One link's outcome (the library's CaptureOutcome, carried through unchanged). */
export interface CaptureItemOutcome {
  url: string;
  /** created | duplicate | refreshed | incomplete | failed | needs-review */
  status: string;
  sourceId?: string;
  /** The library's own plain sentence. */
  reason?: string;
  errorCode?: string;
  /** The optional tool that was missing (a ToolId), with TOOL_NOT_INSTALLED or a transcript note. */
  tool?: string;
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
}
