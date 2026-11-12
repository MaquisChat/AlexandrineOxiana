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

/** The worker's own words for each speech model (services/media-worker/ao_worker/toolpins.py). */
const MODEL_PURPOSE: Record<string, string> = {
  tiny: "Transcribes recordings quickly with the smallest speech model (least accurate; good for trying things out).",
  small: "Transcribes recordings with the small speech model (a good balance of speed and accuracy).",
  medium: "Transcribes recordings with the medium speech model (more accurate, slower).",
  "large-v3": "Transcribes recordings with the largest speech model (most accurate, slowest; needs a fast computer).",
};

const HF = ["huggingface.co", "cdn-lfs.hf.co"];
const speech = (n: string, size: number) =>
  tool(`speech-${n}` as ToolId, "speech", `Speech model: ${n}`, size, [comp(`model-${n}`, `Speech model (${n})`, size, { hosts: HF })], {
    purpose: MODEL_PURPOSE[n]!,
    without: `Transcription with the ${n} model is not available.`,
  });

/** The eight tools of the 48a catalogue, with the worker's names and texts; none installed; OCR unavailable on this computer. */
export function catalogue(): ToolInfo[] {
  return [
    speech("tiny", 75 * MB),
    speech("small", 484 * MB),
    speech("medium", 1528 * MB),
    speech("large-v3", 3087 * MB),
    tool(
      "video-downloader",
      "capture",
      "Video downloader",
      (38 + 40) * MB,
      [
        comp("yt-dlp", "Video downloader (yt-dlp)", 38 * MB, { version: "latest", licence: "Unlicense", sizeApproximate: true, hosts: ["github.com", "objects.githubusercontent.com"] }),
        comp("deno", "JavaScript runtime (deno)", 40 * MB, { version: "2.9.8", hosts: ["dl.deno.land"] }),
      ],
      {
        sizeApproximate: true,
        version: "latest + 2.9.8",
        purpose: "Saves videos, subtitles and the platform's details from YouTube, TikTok, Instagram and other sites. Two parts: yt-dlp and the JavaScript runtime it needs for YouTube.",
        without: "Links to videos cannot be captured; pages can still be saved from the browser extension.",
        notice: "yt-dlp is always the latest release (sites change often); it is checked against the checksums its authors publish. Downloading from platforms may conflict with their terms of service.",
      },
    ),
    tool("image-downloader", "capture", "Image downloader", 1 * MB, [comp("gallery-dl", "Image downloader (gallery-dl)", 1 * MB, { licence: "GPL-2.0-only", hosts: ["files.pythonhosted.org"] })], {
      purpose: "Saves photos and carousels from Instagram and TikTok posts (gallery-dl).",
      without: "Instagram photo posts and TikTok photo carousels cannot be captured.",
      notice: "gallery-dl is free software under the GNU GPL version 2; it runs as its own program.",
    }),
    tool("ffmpeg", "media", "Video tools (ffmpeg)", 30 * MB, [comp("ffmpeg", "ffmpeg and ffprobe", 30 * MB, { version: "9.0.2", hosts: ["ffmpeg.martin-riedl.de"] })], {
      purpose: "Makes viewing copies of videos, and copies that leave out or coarsen a recorded location.",
      without: 'Videos get no viewing copies. Media that carries a location stays "proxy pending" and is left out of exports until ffmpeg is installed.',
      notice: "This ffmpeg is free software under the GNU GPL; its source is published by its builder.",
    }),
    tool(
      "ocr",
      "documents",
      "Text recognition (OCR)",
      20 * MB,
      [
        comp("tesseract", "Text recognition (tesseract)", 0, { available: false, unavailableReason: "No signed build of tesseract exists for this computer yet.", hosts: [] }),
        comp("tessdata", "Text recognition language data (English)", 4 * MB, { hosts: ["raw.githubusercontent.com"] }),
      ],
      {
        available: false,
        unavailableReason: "No signed build of tesseract exists for this computer yet.",
        purpose: "Makes the text of scanned PDFs searchable (tesseract with English language data).",
        without: "Scanned PDFs are kept, but their text cannot be searched.",
      },
    ),
  ];
}

/** The catalogue as 48a sends it before its R158 addition: no `hosts` on any component. */
export function catalogueWithoutHosts(): ToolInfo[] {
  return catalogue().map((t) => ({ ...t, components: t.components.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "hosts")) as typeof c) }));
}

/** `id` found on this computer (on PATH), not installed by the app. */
export function onComputer(tools: ToolInfo[], id: ToolId): ToolInfo[] {
  return tools.map((t) =>
    t.id === id ? { ...t, installed: true, usable: true, managed: false, remainingSize: 0, components: t.components.map((c) => ({ ...c, installed: true, usable: true, source: "system" as const })) } : t,
  );
}

export interface ToolsState {
  tools: ToolInfo[];
  jobs: ToolJob[];
  /** Every request the screen made, "METHOD /path". */
  requests: string[];
  /** The answer to the next POST of an action, if a test wants an error. */
  failNextPost?: { status: number; code: string; message: string; reason?: string };
  /** The answer to the next cancel, if a test wants an error (the job is left as it is). */
  failNextCancel?: { status: number; code: string; message: string; reason?: string };
  /** Each GET /tools takes the first gate, if any: its answer is the catalogue as it was when asked, sent once the gate opens. */
  gates: Array<Promise<void>>;
  /** The platform the catalogue reports (null: no tool is offered for this computer). */
  platform: string | null;
  /** The answer to GET /tools, if a test wants an error. */
  failCatalogue?: { status: number; code: string; message: string };
  /** Holds GET /tools until released (for stale-answer tests). */
  holdCatalogue?: Promise<void>;
  seq: number;
}

/** The service's tool routes over a catalogue the test can change. */
export function toolsService(opts: { tools?: ToolInfo[]; jobs?: ToolJob[]; base?: string } = {}) {
  const url = (path: string) => `${opts.base ?? BASE}${path}`;
  const state: ToolsState = { tools: opts.tools ?? catalogue(), jobs: [...(opts.jobs ?? [])], requests: [], seq: 0, gates: [], platform: "linux-x64" };
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
        const gate = state.gates.shift();
        const snapshot = JSON.parse(JSON.stringify({ platform: state.platform, tools: withJobs(), jobs: state.jobs })) as unknown;
        if (gate) await gate;
        if (state.holdCatalogue) await state.holdCatalogue;
        if (state.failCatalogue) return apiError(state.failCatalogue.status, state.failCatalogue.code, state.failCatalogue.message);
        return HttpResponse.json(gate ? (snapshot as never) : { platform: state.platform, tools: withJobs(), jobs: state.jobs });
      }),
      http.post(url("/tools/jobs/:jobId/cancel"), ({ params }) => {
        state.requests.push(`POST /tools/jobs/${String(params.jobId)}/cancel`);
        if (state.failNextCancel) {
          const f = state.failNextCancel;
          delete state.failNextCancel;
          return apiError(f.status, f.code, f.message, f.reason);
        }
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
          return apiError(f.status, f.code, f.message, f.reason);
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
