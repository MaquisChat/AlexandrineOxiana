/**
 * The mocked service for the transcript viewer (Task 34c): a source with a video, its machine
 * transcript (a WebVTT and a segments file from one run), media tickets, revocation, saving an edit
 * and transcribing again. Shapes follow apps/library-service/src/routes/sources.ts, capture.ts and
 * media.ts (Task 34a) and the shared types.
 */
import { http, HttpResponse } from "msw";
import type { TranscriptResponse, TranscriptSegment, TranscriptVersionSummary } from "@ao/shared";
import { url } from "./service";

export const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 2, lang: "en", text: "Hello and welcome.", flags: [] },
  { start: 2, end: 5, lang: "en", text: "Thanks for watching.", flags: ["no-speech", "known-phrase"] },
  { start: 5, end: 8, lang: "ar", text: "مرحبا بكم", flags: ["repetition"] },
];

export const RUN_AT = "2026-11-01T10:00:00.000Z";

const machine = (id: string, format: "vtt" | "json", at = RUN_AT, model = "small"): TranscriptVersionSummary => ({
  id,
  path: `Project/sources/s1/derived/${id}.${format}`,
  mime: format === "json" ? "application/json" : "text/vtt",
  bytes: 100,
  tool: "faster-whisper",
  derivation: { parents: ["m1"], operation: "transcribe", provider: "faster-whisper", model, ranAt: "local", params: { model }, at, triggeredBy: "capture" },
  origin: "machine",
  format,
  flaggedSegments: 2,
});

export const MACHINE_VERSIONS: TranscriptVersionSummary[] = [machine("v1", "vtt"), machine("j1", "json")];

export const humanVersion = (id: string, at = "2026-11-02T09:00:00.000Z"): TranscriptVersionSummary => ({
  id,
  path: `Project/sources/s1/derived/${id}.vtt`,
  mime: "text/vtt",
  bytes: 90,
  tool: "researcher",
  derivation: { parents: ["m1"], operation: "human-edit", provider: "researcher", ranAt: "local", params: { basedOn: "v1" }, at, triggeredBy: "user" },
  origin: "human-edit",
  format: "vtt",
});

export const machineTranscript = (id = "v1", segments = SEGMENTS): TranscriptResponse => ({ id, text: "WEBVTT\n", format: "vtt", origin: "machine", timed: true, segments });

export const humanTranscript = (id: string, segments = SEGMENTS): TranscriptResponse => ({
  id,
  text: "WEBVTT\n",
  format: "vtt",
  origin: "human-edit",
  basedOn: "v1",
  timed: true,
  segments: segments.map((s) => ({ ...s, flags: null })),
});

export const sourceFile = (sid = "s1", title = "Interview with a baker", media: "video" | "audio" | "none" = "video") => ({
  formatVersion: 1,
  source: { id: sid, type: "video", title: { variants: [{ value: title, kind: "original", lang: "en" }] }, creators: [], collectionIds: [], tagIds: [], folder: `sources/${sid}` },
  assets: [
    ...(media === "none"
      ? []
      : [{ id: `m-${sid}`, sourceId: sid, role: "original", kind: media, path: `sources/${sid}/original/rec.${media === "video" ? "mp4" : "m4a"}`, encrypted: false, bytes: 1000, mime: media === "video" ? "video/mp4" : "audio/mp4" }]),
    { id: "v1", sourceId: sid, role: "derived", kind: "transcript", path: `sources/${sid}/derived/v1.vtt`, encrypted: false, mime: "text/vtt" },
  ],
});

/** A ticket address: `/media/` and 43 base64url characters. */
export const ticketPath = (n: number): string => `/media/${String(n).padStart(43, "T")}`;

export interface TranscriptServiceLog {
  tickets: Array<{ sid: string; aid: string; path: string }>;
  revoked: string[];
  saved: Array<{ sid: string; body: Record<string, unknown> }>;
  transcribed: Array<{ sid: string; body: Record<string, unknown> }>;
}

/**
 * Handlers for one source `s1` in project `p1` (other ids answer with the same shapes, their own
 * title). `versions` and `transcripts` may be changed by a test between requests.
 */
export function transcriptService(opts: { versions?: TranscriptVersionSummary[]; transcripts?: Record<string, TranscriptResponse>; media?: "video" | "audio" | "none" } = {}) {
  const log: TranscriptServiceLog = { tickets: [], revoked: [], saved: [], transcribed: [] };
  const state = {
    versions: [...(opts.versions ?? MACHINE_VERSIONS)],
    transcripts: { v1: machineTranscript("v1"), j1: machineTranscript("j1"), ...(opts.transcripts ?? {}) } as Record<string, TranscriptResponse>,
  };
  let n = 0;
  const handlers = [
    http.get(url("/projects/:id/sources/:sid"), ({ params }) => HttpResponse.json(sourceFile(String(params.sid), params.sid === "s1" ? "Interview with a baker" : "Second interview", opts.media ?? "video"))),
    http.get(url("/projects/:id/sources/:sid/transcripts"), () => HttpResponse.json({ versions: state.versions })),
    http.get(url("/projects/:id/sources/:sid/transcripts/:aid"), ({ params }) => {
      const t = state.transcripts[String(params.aid)];
      return t ? HttpResponse.json(t) : HttpResponse.json({ error: { code: "NOT_FOUND", message: "That transcript was not found." } }, { status: 404 });
    }),
    http.post(url("/projects/:id/sources/:sid/assets/:aid/media-ticket"), ({ params }) => {
      const path = ticketPath(++n);
      log.tickets.push({ sid: String(params.sid), aid: String(params.aid), path });
      return HttpResponse.json({ path, mime: "video/mp4", size: 1000, idleExpiresAt: "2026-11-11T10:10:00.000Z", expiresAt: "2026-11-11T18:00:00.000Z" });
    }),
    http.post(url("/media-tickets/revoke"), async ({ request }) => {
      const body = (await request.json()) as { path: string };
      log.revoked.push(body.path);
      return HttpResponse.json({ revoked: true });
    }),
    http.post(url("/projects/:id/sources/:sid/transcripts"), async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      log.saved.push({ sid: String(params.sid), body });
      const id = `h${log.saved.length}`;
      state.versions.push(humanVersion(id));
      state.transcripts[id] = humanTranscript(id);
      return HttpResponse.json({ id, path: `Project/sources/s1/derived/${id}.vtt`, derivation: {} });
    }),
  ];
  return { handlers, log, state };
}

export const serviceErrorBody = (status: number, code: string, message: string, reason?: string) =>
  HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

export { machine as machineVersion };
