/** Transcript versions (Task 34a c). */

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** BCP 47 language of the segment ("und" when not known; "mul" never appears per segment). */
  lang: string;
  text: string;
  /**
   * Hallucination-check flags (e.g. "outside-speech", "stock-phrase"); `[]` when checked and
   * nothing was found. `null` for a human-edited version: the checks ran on the machine's text,
   * not on what a person wrote, so no result exists for it.
   */
  flags: string[] | null;
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
  /** For a machine version: how many segments the checks flagged. */
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
  segments: TranscriptSegment[];
}

/** `POST /projects/:id/sources/:sid/transcripts` (unchanged; declared here for the UI). */
export interface TranscriptSaveRequest {
  text: string;
  format: "vtt" | "txt";
  basedOn?: string;
  lang?: string;
}
