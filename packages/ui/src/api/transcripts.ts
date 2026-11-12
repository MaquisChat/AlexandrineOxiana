/**
 * Typed service calls for the transcript viewer (Task 34c, R113: this screen's own module, built on
 * the shared client's `request()`). Shapes are the shared Task 34a types (`@ao/shared`); the routes
 * are apps/library-service/src/routes/sources.ts (transcripts), routes/capture.ts (transcribe) and
 * media.ts (media tickets).
 *
 * A media ticket address is a secret (R135 5, R140): `ticket()` returns it to the player only; it is
 * never shown, logged, stored or put in the page address. `revokeTicket()` sends it in the body.
 */
import type { MediaTicketResponse, MediaTicketRevokeResponse, TranscriptListResponse, TranscriptResponse, TranscriptSaveRequest } from "@ao/shared";
import { SPEECH_MODELS, type SpeechModel } from "@ao/shared";
import type { ApiClient } from "./client";
import type { SourceFile } from "./library";

/** The speech models the app accepts: the one definition in @ao/shared (R158). */
export const TRANSCRIPTION_MODELS = SPEECH_MODELS;
export type TranscriptionModel = SpeechModel;

/** What POST …/transcribe answers (TranscribeSourceResult in packages/library). */
export interface TranscribeResult {
  sourceId: string;
  folder: string;
  files: string[];
  flaggedSegments: number;
}

/** What POST …/transcripts answers for a saved edit. */
export interface SavedTranscript {
  id: string;
  path: string;
  derivation?: unknown;
}

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

export function transcriptApi(client: ApiClient) {
  const r = client.request;
  return {
    /** The source record (title, assets: which recording to play). */
    source: (pid: string, sid: string) => r<SourceFile>("GET", src(pid, sid)),
    versions: (pid: string, sid: string) => r<TranscriptListResponse>("GET", `${src(pid, sid)}/transcripts`),
    read: (pid: string, sid: string, aid: string) => r<TranscriptResponse>("GET", `${src(pid, sid)}/transcripts/${seg(aid)}`),
    /** Stores a person's edit as a new version; the version it came from is kept. */
    save: (pid: string, sid: string, body: TranscriptSaveRequest) => r<SavedTranscript>("POST", `${src(pid, sid)}/transcripts`, { body }),
    /** Runs speech recognition again; answers when the new version is stored. */
    transcribe: (pid: string, sid: string, opts: { model?: TranscriptionModel }) => r<TranscribeResult>("POST", `${src(pid, sid)}/transcribe`, { body: opts }),
    /** A media ticket for one audio or video asset (R135). The answer's `path` is a secret. */
    ticket: (pid: string, sid: string, aid: string) => r<MediaTicketResponse>("POST", `${src(pid, sid)}/assets/${seg(aid)}/media-ticket`),
    revokeTicket: (path: string) => r<MediaTicketRevokeResponse>("POST", "/media-tickets/revoke", { body: { path } }),
    /** The address the media element loads (client.mediaUrl: the exact ticket form only). */
    mediaUrl: (ticketPath: string) => client.mediaUrl(ticketPath),
  };
}

export type TranscriptApi = ReturnType<typeof transcriptApi>;
