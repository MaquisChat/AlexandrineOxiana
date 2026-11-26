/**
 * The mocked service for the transcript viewer (Task 34c): a source with a video, its machine
 * transcript (a WebVTT and a segments file from one run), media tickets, revocation, saving an edit
 * and transcribing again as a job (Task 62: the job's state, cancelling it, and its progress as
 * `job.progress` events a test pushes with `emit`). Shapes follow
 * apps/library-service/src/routes/sources.ts, transcription.ts and media.ts and the shared types.
 */
import { http, HttpResponse } from "msw";
import type { TranscriptionJob, TranscriptResponse, TranscriptSegment, TranscriptVersionSummary } from "@ao/shared";
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

export const machineTranscript = (id = "v1", segments = SEGMENTS): TranscriptResponse => ({ id, text: "WEBVTT\n", format: "vtt", origin: "machine", timed: true, flagsStored: true, segments });

/** A human edit saved before flags were stored (Task 62): every segment `flags: null`, no marks. */
export const humanTranscript = (id: string, segments = SEGMENTS): TranscriptResponse => ({
  id,
  text: "WEBVTT\n",
  format: "vtt",
  origin: "human-edit",
  basedOn: "v1",
  timed: true,
  flagsStored: false,
  segments: segments.map(({ edit: _e, ...s }) => ({ ...s, flags: null })),
});

/** A human edit with its stored flags (Task 62), as the service reads it: `segments` carry `edit` and the flags they keep. */
export const storedHumanTranscript = (id: string, segments: TranscriptSegment[]): TranscriptResponse => ({
  id,
  text: "WEBVTT\n",
  format: "vtt",
  origin: "human-edit",
  basedOn: "v1",
  timed: true,
  flagsStored: true,
  segments,
});

/** A transcription job (Task 62) of source s1 in p1. */
export const job = (over: Partial<TranscriptionJob> = {}): TranscriptionJob => ({
  jobId: "00000000-0000-4000-8000-0000000000a1",
  projectId: "p1",
  sourceId: "s1",
  model: "medium",
  status: "queued",
  startedAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...over,
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
  /** Versions read (asset ids), in order. */
  reads: string[];
  /** Transcription jobs asked to stop (job ids). */
  cancelled: string[];
  /** Times the job's state was read. */
  jobReads: number;
}

/**
 * Handlers for one source `s1` in project `p1` (other ids answer with the same shapes, their own
 * title). `versions` and `transcripts` may be changed by a test between requests.
 */
export function transcriptService(opts: { versions?: TranscriptVersionSummary[]; transcripts?: Record<string, TranscriptResponse>; media?: "video" | "audio" | "none"; job?: TranscriptionJob | null;
  /** The idle end a ticket answer gives (the issue time is its `expiresAt` less 8 hours); the service's own ten minutes when not given. */
  ticketIdleExpiresAt?: string;
} = {}) {
  const log: TranscriptServiceLog = { tickets: [], revoked: [], saved: [], transcribed: [], reads: [], cancelled: [], jobReads: 0 };
  const state = {
    versions: [...(opts.versions ?? MACHINE_VERSIONS)],
    transcripts: { v1: machineTranscript("v1"), j1: machineTranscript("j1"), ...(opts.transcripts ?? {}) } as Record<string, TranscriptResponse>,
    /** The source's newest transcription job (GET …/transcription). */
    job: (opts.job ?? null) as TranscriptionJob | null,
    /** The service found the recording's file changed outside the app: a revoke says so (FR-219). */
    fileChanged: false,
    /** The app destroyed the recording's raw data while it played: a revoke says so (R467 M3). */
    fileDestroyed: false,
  };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const held: Request[] = [];
  const enc = new TextEncoder();
  /** Pushes one SSE event to every open /events stream. */
  const emit = (type: string, data: unknown) => {
    for (const c of [...streams]) {
      try {
        c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        streams.delete(c);
      }
    }
  };
  /** Sets the job and pushes its `job.progress` event, as the service does on every change. */
  const update = (j: TranscriptionJob) => {
    state.job = j;
    const finished = j.status !== "queued" && j.status !== "running";
    emit("job.progress", { kind: "transcription", jobId: j.jobId, projectId: j.projectId, job: j, done: Math.round((j.progress ?? 0) * 100), total: 100, finished });
  };
  let n = 0;
  const handlers = [
    // The optional tools' catalogue (Task 48b), asked for by the transcript route: refused as in a plain browser.
    http.get(url("/tools"), () => HttpResponse.json({ error: { code: "FORBIDDEN", message: "The tools are managed from the desktop app." } }, { status: 403 })),
    http.get(url("/projects/:id/sources/:sid"), ({ params }) => HttpResponse.json(sourceFile(String(params.sid), params.sid === "s1" ? "Interview with a baker" : "Second interview", opts.media ?? "video"))),
    http.get(url("/projects/:id/sources/:sid/transcripts"), () => HttpResponse.json({ versions: state.versions })),
    http.get(url("/projects/:id/sources/:sid/transcripts/:aid"), ({ params }) => {
      log.reads.push(String(params.aid));
      const t = state.transcripts[String(params.aid)];
      return t ? HttpResponse.json(t) : HttpResponse.json({ error: { code: "NOT_FOUND", message: "That transcript was not found." } }, { status: 404 });
    }),
    http.post(url("/projects/:id/sources/:sid/assets/:aid/media-ticket"), ({ params }) => {
      const path = ticketPath(++n);
      log.tickets.push({ sid: String(params.sid), aid: String(params.aid), path });
      return HttpResponse.json({ path, mime: "video/mp4", size: 1000, idleExpiresAt: opts.ticketIdleExpiresAt ?? "2026-11-11T10:10:00.000Z", expiresAt: "2026-11-11T18:00:00.000Z" });
    }),
    http.post(url("/media-tickets/revoke"), async ({ request }) => {
      const body = (await request.json()) as { path: string };
      log.revoked.push(body.path);
      return HttpResponse.json(state.fileDestroyed ? { revoked: false, ended: "FILE_DESTROYED" } : state.fileChanged ? { revoked: true, ended: "FILE_CHANGED" } : { revoked: true });
    }),
    http.post(url("/projects/:id/sources/:sid/transcripts"), async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      log.saved.push({ sid: String(params.sid), body });
      const id = `h${log.saved.length}`;
      state.versions.push(humanVersion(id));
      // As the service stores it (Task 62): segments the person left keep their machine flags.
      state.transcripts[id] = storedHumanTranscript(id, SEGMENTS.map((x) => ({ ...x, edit: "unchanged" as const })));
      return HttpResponse.json({ id, path: `Project/sources/s1/derived/${id}.vtt`, derivation: {} });
    }),
    http.get(url("/projects/:id/sources/:sid/transcription"), () => {
      log.jobReads++;
      return HttpResponse.json({ job: state.job });
    }),
    http.post(url("/projects/:id/sources/:sid/transcribe"), async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      log.transcribed.push({ sid: String(params.sid), body });
      const j = job({ jobId: `00000000-0000-4000-8000-${String(log.transcribed.length).padStart(12, "0")}`, sourceId: String(params.sid), model: String(body.model ?? "medium"), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      state.job = j;
      return HttpResponse.json({ job: j }, { status: 202 });
    }),
    http.post(url("/projects/:id/transcriptions/:jobId/cancel"), ({ params }) => {
      log.cancelled.push(String(params.jobId));
      if (state.job && state.job.jobId === params.jobId) state.job = { ...state.job, cancelRequested: true };
      return HttpResponse.json({ job: state.job });
    }),
    http.get(url("/events"), ({ request }) => {
      let ctl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          streams.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() {
          streams.delete(ctl);
        },
      });
      // The request is kept: Node's Request passes the caller's abort on through a weak reference, so a listener on the
      // signal of a request no longer held can miss it.
      held.push(request);
      request.signal.addEventListener("abort", () => streams.delete(ctl));
      return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
    }),
  ];
  return {
    handlers,
    log,
    state,
    emit,
    update,
    /** Open /events streams. */
    streams: () => streams.size,
    /** Ends every open /events stream (the client reconnects). */
    closeStreams() {
      for (const c of [...streams]) {
        streams.delete(c);
        try {
          c.close();
        } catch {
          // already closed
        }
      }
    },
  };
}

export const serviceErrorBody = (status: number, code: string, message: string, reason?: string) =>
  HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

export { machine as machineVersion };
