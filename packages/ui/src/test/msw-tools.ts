/**
 * Fixtures for the optional tools screen and the first-use dialogue (Task 48b): MSW handlers shaped
 * like the service's tool routes (apps/library-service/src/routes/tools.ts, Task 48a) and a
 * catalogue shaped like the worker's (services/media-worker/ao_worker/tools.py `catalogue()`).
 * Nothing is downloaded: a job's progress moves only when a test moves it.
 */
import type { ToolAction, ToolId, ToolInfo, ToolJob } from "@ao/shared";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createClient } from "../api/client";
import { toolsApi } from "../api/tools";

export const BASE = "http://127.0.0.1:4319";
export const TOKEN = "t".repeat(40) + "-task48b";
export const url = (path: string) => `${BASE}${path}`;

export const server = setupServer();

export function useMsw(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export const makeClient = () => createClient(BASE, TOKEN);
export const makeApi = () => toolsApi(makeClient());

export const apiError = (status: number, code: string, message: string, reason?: string) => HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

const MB = 1_000_000;

function comp(id: string, name: string, size: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    version: "1.0",
    licence: "MIT",
    installed: false,
    usable: false,
    source: null,
    installedVersion: null,
    outdated: false,
    available: true,
    downloadSize: size,
    sizeApproximate: false,
    hosts: ["example-host.test"],
    ...extra,
  };
}

function tool(id: ToolId, group: ToolInfo["group"], name: string, size: number, components: ToolInfo["components"], extra: Partial<ToolInfo> = {}): ToolInfo {
  return {
    id,
    group,
    name,
    purpose: `Purpose of ${name}.`,
    without: `Without ${name}, its feature does not work.`,
    version: "1.0",
    downloadSize: size,
    remainingSize: size,
    sizeApproximate: false,
    installed: false,
    usable: false,
    managed: false,
    updateAvailable: false,
    available: true,
    components,
    ...extra,
  };
}

/** The eight tools of the 48a catalogue, none installed; OCR unavailable on this computer. */
export function catalogue(): ToolInfo[] {
  return [
    tool("speech-tiny", "speech", "Speech model: tiny", 75 * MB, [comp("model-tiny", "faster-whisper tiny", 75 * MB, { hosts: ["huggingface.co", "cdn-lfs.hf.co"] })]),
    tool("speech-small", "speech", "Speech model: small", 484 * MB, [comp("model-small", "faster-whisper small", 484 * MB, { hosts: ["huggingface.co", "cdn-lfs.hf.co"] })]),
    tool("speech-medium", "speech", "Speech model: medium", 1528 * MB, [comp("model-medium", "faster-whisper medium", 1528 * MB, { hosts: ["huggingface.co", "cdn-lfs.hf.co"] })]),
    tool("speech-large-v3", "speech", "Speech model: large-v3", 3087 * MB, [comp("model-large-v3", "faster-whisper large-v3", 3087 * MB, { hosts: ["huggingface.co", "cdn-lfs.hf.co"] })]),
    tool(
      "video-downloader",
      "capture",
      "Video downloader",
      (38 + 40) * MB,
      [
        comp("yt-dlp", "yt-dlp", 38 * MB, { version: "latest", licence: "Unlicense", sizeApproximate: true, hosts: ["github.com", "objects.githubusercontent.com"] }),
        comp("deno", "Deno (JavaScript runtime)", 40 * MB, { version: "2.9.8", hosts: ["dl.deno.land"] }),
      ],
      { sizeApproximate: true, version: "latest + 2.9.8" },
    ),
    tool("image-downloader", "capture", "Picture-post downloader", 1 * MB, [comp("gallery-dl", "gallery-dl", 1 * MB, { licence: "GPL-2.0-only", hosts: ["files.pythonhosted.org"] })], {
      notice: "gallery-dl is free software under the GPL-2.0 licence.",
    }),
    tool("ffmpeg", "media", "ffmpeg (video and audio conversion)", 30 * MB, [comp("ffmpeg", "ffmpeg", 30 * MB, { hosts: ["ffmpeg.martin-riedl.de"] })]),
    tool(
      "ocr",
      "documents",
      "Text recognition (OCR)",
      20 * MB,
      [comp("tesseract", "tesseract", 0, { available: false, unavailableReason: "No signed build of tesseract exists for this computer yet.", hosts: [] }), comp("tessdata", "English language data", 4 * MB, { hosts: ["raw.githubusercontent.com"] })],
      { available: false, unavailableReason: "No signed build of tesseract exists for this computer yet." },
    ),
  ];
}

export interface ToolsState {
  tools: ToolInfo[];
  jobs: ToolJob[];
  /** Every request the screen made, "METHOD /path". */
  requests: string[];
  /** The answer to the next POST of an action, if a test wants an error. */
  failNextPost?: { status: number; code: string; message: string };
  /** The answer to GET /tools, if a test wants an error. */
  failCatalogue?: { status: number; code: string; message: string };
  /** Holds GET /tools until released (for stale-answer tests). */
  holdCatalogue?: Promise<void>;
  seq: number;
}

/** The service's tool routes over a catalogue the test can change. */
export function toolsService(opts: { tools?: ToolInfo[]; jobs?: ToolJob[] } = {}) {
  const state: ToolsState = { tools: opts.tools ?? catalogue(), jobs: [...(opts.jobs ?? [])], requests: [], seq: 0 };
  const latest = (id: string) => [...state.jobs].reverse().find((j) => j.toolId === id);
  const withJobs = () => state.tools.map((t) => (latest(t.id) ? { ...t, job: { ...latest(t.id)! } } : t));
  const find = (jobId: string) => state.jobs.find((j) => j.jobId === jobId);

  const api = {
    state,
    /** Moves a job on (as the worker's progress would). */
    progress(jobId: string, p: number) {
      const j = find(jobId);
      if (j) j.progress = p;
    },
    /** Ends a job; `done` marks its tool installed (or removed). */
    finish(jobId: string, status: "done" | "failed" | "cancelled" = "done", error?: { code: string; message: string }) {
      const j = find(jobId);
      if (!j) return;
      j.status = status;
      j.finishedAt = new Date().toISOString();
      if (status === "done") {
        j.progress = 1;
        const t = state.tools.find((x) => x.id === j.toolId);
        if (t) {
          const on = j.action !== "remove";
          Object.assign(t, { installed: on, usable: on, managed: on, remainingSize: on ? 0 : t.downloadSize });
        }
      }
      if (error) j.error = error;
    },
    jobOf(toolId: string) {
      return latest(toolId);
    },
    handlers: [
      http.get(url("/tools"), async () => {
        state.requests.push("GET /tools");
        if (state.holdCatalogue) await state.holdCatalogue;
        if (state.failCatalogue) return apiError(state.failCatalogue.status, state.failCatalogue.code, state.failCatalogue.message);
        return HttpResponse.json({ platform: "linux-x64", tools: withJobs(), jobs: state.jobs });
      }),
      http.post(url("/tools/jobs/:jobId/cancel"), ({ params }) => {
        state.requests.push(`POST /tools/jobs/${String(params.jobId)}/cancel`);
        const j = find(String(params.jobId));
        if (!j) return apiError(404, "NOT_FOUND", "That tool job was not found.");
        if (j.status === "running") {
          j.status = "cancelled";
          j.finishedAt = new Date().toISOString();
        }
        return HttpResponse.json({ job: { ...j } });
      }),
      http.get(url("/tools/jobs/:jobId"), ({ params }) => {
        state.requests.push(`GET /tools/jobs/${String(params.jobId)}`);
        const j = find(String(params.jobId));
        if (!j) return apiError(404, "NOT_FOUND", "That tool job was not found.");
        return HttpResponse.json({ job: { ...j } });
      }),
      http.post(url("/tools/:toolId/:action"), ({ params }) => {
        const toolId = String(params.toolId);
        const action = String(params.action) as ToolAction;
        state.requests.push(`POST /tools/${toolId}/${action}`);
        if (state.failNextPost) {
          const f = state.failNextPost;
          delete state.failNextPost;
          return apiError(f.status, f.code, f.message);
        }
        if (!state.tools.some((t) => t.id === toolId)) return apiError(404, "NOT_FOUND", "That tool was not found.");
        const busy = state.jobs.find((j) => j.toolId === toolId && j.status === "running");
        if (busy) {
          if (busy.action === action) return HttpResponse.json({ job: { ...busy } }, { status: 202 });
          return apiError(409, "CONFLICT", "This tool is being changed already. Wait until that has finished.");
        }
        const job: ToolJob = { jobId: `job-${++state.seq}`, toolId: toolId as ToolId, action, status: "running", progress: 0, startedAt: new Date().toISOString() };
        state.jobs.push(job);
        return HttpResponse.json({ job: { ...job } }, { status: 202 });
      }),
    ],
  };
  return api;
}

/** A store for the first-use answer that a test can read (the app keeps it in its own settings). */
export function memoryStore(initial: "not-now" | "chosen" | null = null) {
  let v = initial;
  return {
    get: () => v,
    set: (x: "not-now" | "chosen") => {
      v = x;
    },
    get value() {
      return v;
    },
  };
}
