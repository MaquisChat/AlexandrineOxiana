/**
 * Typed service calls for the transcript viewer (Task 34c, R113: this screen's own module, built on
 * the shared client's `request()`). Shapes are the shared types (`@ao/shared`); the routes are
 * apps/library-service/src/routes/sources.ts (transcripts), routes/transcription.ts (transcription
 * as a job, Task 62) and media.ts (media tickets).
 *
 * A media ticket address is a secret (R135 5, R140): `ticket()` returns it to the player only; it is
 * never shown, logged, stored or put in the page address. `revokeTicket()` sends it in the body.
 */
import type {
  MediaTicketResponse,
  MediaTicketRevokeRequest,
  MediaTicketRevokeResponse,
  TranscribeRequest,
  TranscriptionJob,
  TranscriptionJobResponse,
  TranscriptListResponse,
  TranscriptResponse,
  TranscriptSavedResponse,
  TranscriptSaveRequest,
} from "@ao/shared";
import { SPEECH_MODELS, type SpeechModel } from "@ao/shared";
import type { ApiClient } from "./client";
import type { SourceFile } from "./library";

/** The speech models the app accepts: the one definition in @ao/shared (R158). */
export const TRANSCRIPTION_MODELS = SPEECH_MODELS;
export type TranscriptionModel = SpeechModel;

/** What POST …/transcripts answers for a saved edit (@ao/shared). */
export type SavedTranscript = TranscriptSavedResponse;

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

/** A transcription job in a `job.progress` event (kind "transcription"), when the event is one. */
export function transcriptionJobOf(data: unknown): TranscriptionJob | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as { kind?: unknown; job?: unknown };
  if (d.kind !== "transcription" || !d.job || typeof d.job !== "object") return undefined;
  const j = d.job as Partial<TranscriptionJob>;
  return typeof j.jobId === "string" && typeof j.projectId === "string" && typeof j.sourceId === "string" && typeof j.status === "string" && typeof j.updatedAt === "string"
    ? (j as TranscriptionJob)
    : undefined;
}

export function transcriptApi(client: ApiClient) {
  const r = client.request;
  return {
    /** The source record (title, assets: which recording to play). */
    source: (pid: string, sid: string) => r<SourceFile>("GET", src(pid, sid)),
    versions: (pid: string, sid: string) => r<TranscriptListResponse>("GET", `${src(pid, sid)}/transcripts`),
    read: (pid: string, sid: string, aid: string) => r<TranscriptResponse>("GET", `${src(pid, sid)}/transcripts/${seg(aid)}`),
    /** Stores a person's edit as a new version; the version it came from is kept. */
    save: (pid: string, sid: string, body: TranscriptSaveRequest) => r<SavedTranscript>("POST", `${src(pid, sid)}/transcripts`, { body }),
    /** Starts speech recognition again: answers at once with the job (its progress arrives as events). */
    transcribe: (pid: string, sid: string, body: TranscribeRequest) => r<TranscriptionJobResponse>("POST", `${src(pid, sid)}/transcribe`, { body }),
    /** The source's newest transcription job (null: none recorded). */
    transcription: (pid: string, sid: string) => r<TranscriptionJobResponse>("GET", `${src(pid, sid)}/transcription`),
    /** Asks a transcription to stop. */
    cancelTranscription: (pid: string, jobId: string) => r<TranscriptionJobResponse>("POST", `/projects/${seg(pid)}/transcriptions/${seg(jobId)}/cancel`),
    /** The service's events (the transcription's progress is `job.progress` of kind "transcription"). */
    events: (opts: { signal?: AbortSignal; onOpen?: () => void }) => client.events(opts),
    /** A media ticket for one audio or video asset (R135). The answer's `path` is a secret. */
    ticket: (pid: string, sid: string, aid: string) => r<MediaTicketResponse>("POST", `${src(pid, sid)}/assets/${seg(aid)}/media-ticket`),
    revokeTicket: (path: string) => {
      const body: MediaTicketRevokeRequest = { path };
      return r<MediaTicketRevokeResponse>("POST", "/media-tickets/revoke", { body });
    },
    /** The address the media element loads (client.mediaUrl: the exact ticket form only). */
    mediaUrl: (ticketPath: string) => client.mediaUrl(ticketPath),
  };
}

export type TranscriptApi = ReturnType<typeof transcriptApi>;
