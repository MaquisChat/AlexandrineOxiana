/** Transcript versions (Task 34a c) and transcription as a job (Task 62). */

/** What became of a segment of a human edit, compared with the version it was edited from (Task 62). */
export type TranscriptSegmentEdit = "unchanged" | "edited" | "added";

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** BCP 47 language of the segment ("und" when not known; "mul" never appears per segment). */
  lang: string;
  text: string;
  /**
   * Hallucination-check flags (e.g. "outside-speech", "stock-phrase"); `[]` when checked and
   * nothing was found. `null` where no check ran: a segment a person edited or added (the checks
   * ran on the machine's text, not on what a person wrote), and every segment of a human edit saved
   * before flags were stored (`flagsStored: false`).
   */
  flags: string[] | null;
  /**
   * Human edits saved with stored flags only: "unchanged" (same timing and text as the version it
   * was edited from; `flags` are that version's), "edited" or "added" by a person (`flags: null`).
   */
  edit?: TranscriptSegmentEdit;
}

/** One stored version in `GET /projects/:id/sources/:sid/transcripts`. */
export interface TranscriptVersionSummary {
  id: string;
  /** Library-relative path (never absolute). */
  path: string;
  mime: string;
  bytes: number;
  /** The provider that made it ("faster-whisper", "researcher"). */
  tool?: string;
  derivation?: unknown;
  origin: "machine" | "human-edit";
  format: "vtt" | "txt" | "json";
  /** How many segments carry flags (a machine version; a human edit: the unchanged ones carrying flags). */
  flaggedSegments?: number;
}

export interface TranscriptListResponse {
  versions: TranscriptVersionSummary[];
}

/** `GET /projects/:id/sources/:sid/transcripts/:aid`. */
export interface TranscriptResponse {
  id: string;
  /** The stored text of the version (WebVTT, plain text, or the segments file as stored). */
  text: string;
  format: "vtt" | "txt" | "json";
  origin: "machine" | "human-edit";
  /** For a human edit: the version it was edited from. */
  basedOn?: string;
  /** False for a plain-text edit: it has no timings, so `segments` is empty. */
  timed: boolean;
  /**
   * Whether each segment's flags are known (Task 62): true for a machine version and a human edit
   * saved with stored flags; false for a human edit saved before (show its segments as not checked).
   */
  flagsStored: boolean;
  segments: TranscriptSegment[];
}

/** `POST /projects/:id/sources/:sid/transcripts` (unchanged; declared here for the UI). */
export interface TranscriptSaveRequest {
  text: string;
  format: "vtt" | "txt";
  basedOn?: string;
  lang?: string;
}

// ---- transcription as a job (Task 62, R99, R142) ----

export type TranscriptionJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * A transcription of one source. Its status is recorded in the project's job journal, so it is read
 * back after a reload and after the service restarts; progress, the cancel request and the result
 * are known only to the service run that holds the job.
 */
export interface TranscriptionJob {
  jobId: string;
  projectId: string;
  sourceId: string;
  /** The speech model asked for. */
  model?: string;
  status: TranscriptionJobStatus;
  /** 0..1 while running, when the worker has reported it. */
  progress?: number;
  /**
   * Pending in the journal and run by no one now (after a restart, a close or the media helper
   * stopping): it runs again when the media helper is ready or the library is next opened.
   */
  waiting?: boolean;
  /** A cancel was asked for and the media helper has not yet confirmed that it stopped. */
  cancelRequested?: boolean;
  /**
   * Failed or cancelled: what happened, as an error body's fields (`code`, plain `message`,
   * `reason`). A missing tool is `TOOL_NOT_INSTALLED` with the tool's id as `reason`; a run
   * cancelled because the project was locked is `PROJECT_LOCKED` and runs again at the next unlock.
   */
  error?: { code: string; message: string; reason?: string };
  /** Done, in the service run that made it: the stored files (library-relative) and the flagged count. */
  result?: { files: string[]; flaggedSegments: number };
  startedAt: string;
  updatedAt: string;
}

/** `POST /projects/:id/sources/:sid/transcribe` (202), `GET …/transcription`, `POST /projects/:id/transcriptions/:jobId/cancel`. */
export interface TranscriptionJobResponse {
  /** null: no transcription of this source is recorded. */
  job: TranscriptionJob | null;
}

/** The `job.progress` event of a transcription (`kind: "transcription"`). */
export interface TranscriptionProgressEvent {
  kind: "transcription";
  job: TranscriptionJob;
  /** For the jobs indicator: progress in percent (0..100), and whether the job has ended. */
  jobId: string;
  projectId: string;
  done: number;
  total: 100;
  finished: boolean;
}

/** The `reason` of the 409 CONFLICT for a second transcription of a source while one is queued, running or pending. */
export const TRANSCRIPTION_RUNNING = "TRANSCRIPTION_RUNNING";
