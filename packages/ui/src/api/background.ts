/**
 * The download runs and the transcription list of a project (whole channels, R668, R669), built on the client's
 * `request()`. The shapes and every sentence are declared once, in @ao/shared (api/background.ts):
 *
 *   GET  /projects/:id/downloads                         → DownloadRunListResponse
 *   GET  /projects/:id/downloads/:runId/problems         → DownloadProblemsResponse
 *   POST /projects/:id/downloads/:runId/{pause|stop|resume} → DownloadRunResponse
 *   POST /projects/:id/downloads/:runId/discard          → DownloadRunDiscarded
 *   GET  /projects/:id/transcription-list                → TranscriptionListResponse
 *   POST /projects/:id/transcription-list/{pause|continue|stop} → TranscriptionListResponse
 *   GET/PUT /projects/:id/automation                     → ProjectAutomation (Task 9: the project's switch)
 *   GET/PUT /settings/background                         → BackgroundSettings (Task 9: keeping the Mac awake)
 *   GET  /projects/:id/untranscribed                     → UntranscribedResponse
 *   POST /projects/:id/transcription-list (TranscribeAllRequest) → TranscribeAllResponse ("Transcribe everything")
 *
 * Progress comes as `background.progress` events on GET /events (BackgroundProgressEvent).
 */
import {
  BACKGROUND_EVENT,
  type BackgroundProgressEvent,
  type BackgroundSettings,
  type DownloadProblemsResponse,
  type DownloadRunDiscarded,
  type DownloadRunListResponse,
  type DownloadRunResponse,
  type DownloadRunSummary,
  type ProjectAutomation,
  type SpeechModel,
  type TranscribeAllRequest,
  type TranscribeAllResponse,
  type TranscriptionListResponse,
  type TranscriptionListSummary,
  type UntranscribedResponse,
} from "@ao/shared";
import type { ApiClient, ServiceEvent } from "./client";

const seg = (s: string) => encodeURIComponent(s);
const proj = (id: string) => `/projects/${seg(id)}`;
const withSignal = (opts: { signal?: AbortSignal }) => (opts.signal ? { signal: opts.signal } : {});

export function backgroundApi(client: ApiClient) {
  const r = client.request;
  return {
    downloads: async (projectId: string, opts: { signal?: AbortSignal } = {}): Promise<DownloadRunSummary[]> =>
      (await r<DownloadRunListResponse>("GET", `${proj(projectId)}/downloads`, withSignal(opts))).runs,
    problems: (projectId: string, runId: string, opts: { signal?: AbortSignal } = {}): Promise<DownloadProblemsResponse> =>
      r<DownloadProblemsResponse>("GET", `${proj(projectId)}/downloads/${seg(runId)}/problems`, withSignal(opts)),
    runAction: async (projectId: string, runId: string, what: "pause" | "stop" | "resume"): Promise<DownloadRunSummary> =>
      (await r<DownloadRunResponse>("POST", `${proj(projectId)}/downloads/${seg(runId)}/${what}`)).run,
    discard: async (projectId: string, runId: string): Promise<void> => {
      await r<DownloadRunDiscarded>("POST", `${proj(projectId)}/downloads/${seg(runId)}/discard`);
    },
    transcriptionList: async (projectId: string, opts: { signal?: AbortSignal } = {}): Promise<TranscriptionListSummary> =>
      (await r<TranscriptionListResponse>("GET", `${proj(projectId)}/transcription-list`, withSignal(opts))).list,
    listAction: async (projectId: string, what: "pause" | "continue" | "stop"): Promise<TranscriptionListSummary> =>
      (await r<TranscriptionListResponse>("POST", `${proj(projectId)}/transcription-list/${what}`)).list,
    automation: (projectId: string, opts: { signal?: AbortSignal } = {}): Promise<ProjectAutomation> =>
      r<ProjectAutomation>("GET", `${proj(projectId)}/automation`, withSignal(opts)),
    setAutomation: (projectId: string, a: ProjectAutomation): Promise<ProjectAutomation> =>
      r<ProjectAutomation>("PUT", `${proj(projectId)}/automation`, { body: { transcribeNewMedia: a.transcribeNewMedia } }),
    untranscribed: (projectId: string, opts: { signal?: AbortSignal } = {}): Promise<UntranscribedResponse> =>
      r<UntranscribedResponse>("GET", `${proj(projectId)}/untranscribed`, withSignal(opts)),
    transcribeAll: (projectId: string, model?: SpeechModel): Promise<TranscribeAllResponse> =>
      r<TranscribeAllResponse>("POST", `${proj(projectId)}/transcription-list`, { body: (model ? { model } : {}) satisfies TranscribeAllRequest }),
    settings: (opts: { signal?: AbortSignal } = {}): Promise<BackgroundSettings> => r<BackgroundSettings>("GET", "/settings/background", withSignal(opts)),
    setSettings: (s: BackgroundSettings): Promise<BackgroundSettings> => r<BackgroundSettings>("PUT", "/settings/background", { body: { keepAwake: s.keepAwake } }),
  };
}

export type BackgroundApi = ReturnType<typeof backgroundApi>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isRun(v: unknown): v is DownloadRunSummary {
  return isObj(v) && typeof v.runId === "string" && typeof v.title === "string" && typeof v.url === "string" && typeof v.state === "string" && typeof v.platform === "string" && isNum(v.total) && isNum(v.done) && isNum(v.failed) && isNum(v.notCompleted);
}

function isList(v: unknown): v is TranscriptionListSummary {
  return isObj(v) && (v.state === "running" || v.state === "paused" || v.state === "idle") && isNum(v.total) && isNum(v.done) && isNum(v.failed);
}

/** A `background.progress` event of this project, its parts checked; anything else (another project's, a malformed one) is undefined. */
export function backgroundProgress(e: ServiceEvent, projectId: string): BackgroundProgressEvent | undefined {
  if (e.type !== BACKGROUND_EVENT || !isObj(e.data)) return undefined;
  const d = e.data;
  if (d.projectId !== projectId) return undefined;
  if (d.downloads !== undefined && !(isRun(d.downloads) && d.downloads.projectId === projectId)) return undefined;
  if (d.discarded !== undefined && typeof d.discarded !== "string") return undefined;
  if (d.transcriptions !== undefined && !(isList(d.transcriptions) && d.transcriptions.projectId === projectId)) return undefined;
  return d as unknown as BackgroundProgressEvent;
}
