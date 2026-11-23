/**
 * The optional tools' routes (Task 48a, R126): the catalogue, installs / updates / removals as jobs
 * with progress and cancel that a reloaded interface can read again, and missing tools named.
 * Against a stand-in media worker; nothing here downloads anything.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerJobError, WorkerToolError, deviceDeps, type Deps, type JobResult, type WorkerClient, type WorkerJob, type WorkerToolsClient } from "@ao/library";
import type { ToolJob, ToolsResponse } from "@ao/shared";
import { toApiError } from "./errors.js";
import { failureTool } from "./routes/jobs.js";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let tmp: string;
let deps: Deps;
let svc: LibraryService;

const CATALOGUE = {
  platform: "linux-x64",
  tools: [
    { id: "ffmpeg", group: "media", name: "Video tools (ffmpeg)", purpose: "Makes viewing copies of videos.", without: "Media stays proxy pending.", version: "9.0.2", downloadSize: 66_000_000, sizeApproximate: false, remainingSize: 66_000_000, installed: false, usable: false, managed: false, updateAvailable: false, available: true, components: [] },
    { id: "speech-small", group: "speech", name: "Speech model: small", purpose: "Transcribes.", without: "No small model.", version: "536b066", downloadSize: 486_000_000, sizeApproximate: false, remainingSize: 486_000_000, installed: false, usable: false, managed: false, updateAvailable: false, available: true, components: [] },
  ],
};

interface Run {
  action: string;
  toolId: string;
  signal: AbortSignal | undefined;
  progress: (p: number) => void;
  finish: (r: Record<string, unknown> | Error) => void;
}

/** A stand-in worker whose tool jobs the test finishes by hand. */
function stubWorker(over: { transcribeError?: Error; ignoreAbort?: boolean; missingModels?: boolean } = {}): WorkerProvider & { runs: Run[]; updateError?: Error } {
  const runs: Run[] = [];
  const p: WorkerProvider & { runs: Run[]; updateError?: Error } = {
    runs,
    async start() {
      const tools = {
        catalogue: async () => CATALOGUE,
        updateCaptureTools: async () => ({}),
        run: (action: string, toolId: string, opts: { onProgress?: (n: number) => void; signal?: AbortSignal } = {}) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const r: Run = {
              action,
              toolId,
              signal: opts.signal,
              progress: (n) => opts.onProgress?.(n),
              finish: (x) => (x instanceof Error ? reject(x) : resolve(x)),
            };
            if (!over.ignoreAbort) opts.signal?.addEventListener("abort", () => reject(new WorkerJobError("CANCELLED", "the job was cancelled")));
            runs.push(r);
          }),
      } as unknown as WorkerToolsClient;
      const client = {
        async submit(_pid: string, job: WorkerJob): Promise<JobResult> {
          if (over.missingModels && job.type === "audio.transcribe") {
            const m = String(job.params?.model);
            throw new WorkerToolError("TOOL_NOT_INSTALLED", `Speech model: ${m} is not installed.`, `speech-${m}`);
          }
          throw over.transcribeError ?? new WorkerJobError("TOOL_FAILED", "no");
        },
        async resumePending() {
          return [];
        },
      } as unknown as WorkerClient;
      return {
        clientFor: () => client,
        versions: async () => ({}),
        updateTools: async () => {
          if (p.updateError) throw p.updateError;
          return { ytDlp: { old: "a", new: "b", managed: true }, galleryDl: { version: null, pinned: true } };
        },
        tools,
        stop: async () => {},
      };
    },
  };
  return p;
}

async function start(over: Partial<ServiceOptions> = {}): Promise<void> {
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }), pairing: { confirmPerMinute: 100 }, ...over });
}

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.noAuth ? {} : auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function until(f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function extensionToken(): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-tools-routes-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("GET /tools", () => {
  it("lists the catalogue with no library open, and no jobs yet", async () => {
    await start({ worker: stubWorker(), autoStartWorker: false });
    const r = await call({ url: "/tools" });
    expect(r.status, r.body).toBe(200);
    const body = r.json as ToolsResponse;
    expect(body.platform).toBe("linux-x64");
    expect(body.tools.map((t) => t.id)).toEqual(["ffmpeg", "speech-small"]);
    expect(body.jobs).toEqual([]);
  });

  it("is for the desktop app only: not the extension's token, not another page with the UI token", async () => {
    await start({ worker: stubWorker(), autoStartWorker: false });
    const token = await extensionToken();
    const ext = await call({ url: "/tools", noAuth: true, headers: { authorization: `Bearer ${token}`, origin: EXT } });
    expect(ext.status).toBe(403);
    // the paired extension's origin carrying the desktop app's token
    const mixed = await call({ url: "/tools", headers: { origin: EXT } });
    expect(mixed.status).toBe(403);
    expect(mixed.json.error.code).toBe("FORBIDDEN");
    const install = await call({ method: "POST", url: "/tools/ffmpeg/install", headers: { origin: EXT } });
    expect(install.status).toBe(403);
    const shell = await call({ url: "/tools", headers: { origin: "tauri://localhost" } });
    expect(shell.status).toBe(200);
    expect((await call({ url: "/tools", noAuth: true })).status).toBe(401);
  });

  it("without a media helper is 503 WORKER_UNAVAILABLE in plain words", async () => {
    await start({ worker: null, autoStartWorker: false });
    const r = await call({ url: "/tools" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("WORKER_UNAVAILABLE");
  });
});

describe("installing a tool", () => {
  it("runs as a job with progress that GET /tools and GET /tools/jobs/:id show again after a reload", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const r = await call({ method: "POST", url: "/tools/ffmpeg/install" });
    expect(r.status, r.body).toBe(202);
    const job = r.json.job as ToolJob;
    expect(job).toMatchObject({ toolId: "ffmpeg", action: "install", status: "running", progress: 0 });
    await until(() => worker.runs.length === 1);
    expect(worker.runs[0]).toMatchObject({ action: "install", toolId: "ffmpeg" });
    worker.runs[0]!.progress(0.4);
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.progress === 0.4);
    // a reloaded interface finds the running job
    const listed = (await call({ url: "/tools" })).json as ToolsResponse;
    expect(listed.jobs.map((j) => j.jobId)).toEqual([job.jobId]);
    expect(listed.tools.find((t) => t.id === "ffmpeg")!.job).toMatchObject({ jobId: job.jobId, status: "running" });
    worker.runs[0]!.finish({ tool: "ffmpeg", action: "install", installed: ["ffmpeg"] });
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status === "done");
    const done = (await call({ url: `/tools/jobs/${job.jobId}` })).json.job as ToolJob;
    expect(done.progress).toBe(1);
    expect(done.finishedAt).toBeTypeOf("string");
  });

  it("publishes its progress as job.progress events of kind tool", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const seen: Array<Record<string, unknown>> = [];
    const off = svc.state.events.subscribe((e) => {
      if (e.type === "job.progress" && e.data.kind === "tool") seen.push(e.data);
    });
    const job = (await call({ method: "POST", url: "/tools/ffmpeg/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    worker.runs[0]!.progress(0.5);
    worker.runs[0]!.finish({});
    await until(() => seen.some((e) => (e.job as ToolJob).status === "done"));
    off();
    expect(seen.every((e) => (e.job as ToolJob).jobId === job.jobId)).toBe(true);
    expect(seen.some((e) => (e.job as ToolJob).progress === 0.5)).toBe(true);
  });

  it("a second request for the same tool while it runs gets the same job (one install)", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const [a, b] = await Promise.all([call({ method: "POST", url: "/tools/ffmpeg/install" }), call({ method: "POST", url: "/tools/ffmpeg/install" })]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.json.job.jobId).toBe(a.json.job.jobId);
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.runs.length).toBe(1);
    // removing it meanwhile is a conflict
    const rm = await call({ method: "POST", url: "/tools/ffmpeg/remove" });
    expect(rm.status).toBe(409);
    expect(rm.json.error.code).toBe("CONFLICT");
  });

  it("can be cancelled; the job is recorded as cancelled", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/speech-small/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    const c = await call({ method: "POST", url: `/tools/jobs/${job.jobId}/cancel` });
    expect(c.status).toBe(200);
    expect(worker.runs[0]!.signal?.aborted).toBe(true);
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status === "cancelled");
  });

  it("a cancel the media helper confirms ends the job cancelled; until then it shows the cancel was asked for", async () => {
    const worker = stubWorker({ ignoreAbort: true });
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/ffmpeg/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    const c = await call({ method: "POST", url: `/tools/jobs/${job.jobId}/cancel` });
    expect(c.json.job).toMatchObject({ status: "running", cancelRequested: true });
    expect(worker.runs[0]!.signal?.aborted).toBe(true);
    worker.runs[0]!.finish(new WorkerJobError("CANCELLED", "the job was cancelled"));
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status === "cancelled");
    const again = await call({ method: "POST", url: "/tools/ffmpeg/install" });
    expect(again.json.job.jobId).not.toBe(job.jobId);
  });

  it("an install that completed before the cancel took effect ends installed and says so", async () => {
    const worker = stubWorker({ ignoreAbort: true });
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/ffmpeg/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    await call({ method: "POST", url: `/tools/jobs/${job.jobId}/cancel` });
    worker.runs[0]!.finish({ tool: "ffmpeg", action: "install", installed: ["ffmpeg"] });
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status !== "running");
    const done = (await call({ url: `/tools/jobs/${job.jobId}` })).json.job as ToolJob;
    expect(done).toMatchObject({ status: "done", cancelRequested: true, result: { installed: ["ffmpeg"] } });
  });

  it("a cancel the media helper never confirms ends the job failed, not cancelled", async () => {
    const worker = stubWorker({ ignoreAbort: true });
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/ffmpeg/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    await call({ method: "POST", url: `/tools/jobs/${job.jobId}/cancel` });
    worker.runs[0]!.finish(new WorkerJobError("CANCEL_UNCONFIRMED", "the worker did not confirm"));
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status !== "running");
    const j = (await call({ url: `/tools/jobs/${job.jobId}` })).json.job as ToolJob;
    expect(j.status).toBe("failed");
    expect(j.error?.code).toBe("CANCEL_UNCONFIRMED");
    expect(j.error?.message).toMatch(/tools list/);
  });

  it("a failed install is recorded with the worker's code and a plain message, never a bare 500", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/ffmpeg/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    worker.runs[0]!.finish(new WorkerToolError("TOOL_CHECKSUM_MISMATCH", "the download does not match its published checksum, so it was not used", "ffmpeg"));
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status === "failed");
    const failed = (await call({ url: `/tools/jobs/${job.jobId}` })).json.job as ToolJob;
    expect(failed.error?.code).toBe("TOOL_CHECKSUM_MISMATCH");
    expect(failed.error?.message).toMatch(/checksum/i);
    expect(failed.error?.message).not.toMatch(/\//);
    // and it can be retried
    const again = await call({ method: "POST", url: "/tools/ffmpeg/install" });
    expect(again.status).toBe(202);
    expect(again.json.job.jobId).not.toBe(job.jobId);
  });

  it("a download refused for an unverifiable certificate is told apart, in plain words, and can be retried (R476 b)", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const job = (await call({ method: "POST", url: "/tools/speech-tiny/install" })).json.job as ToolJob;
    await until(() => worker.runs.length === 1);
    worker.runs[0]!.finish(new WorkerToolError("TOOL_DOWNLOAD_UNTRUSTED", "the download was refused: the server's certificate could not be verified", "speech-tiny"));
    await until(async () => (await call({ url: `/tools/jobs/${job.jobId}` })).json.job.status === "failed");
    const failed = (await call({ url: `/tools/jobs/${job.jobId}` })).json.job as ToolJob;
    expect(failed.error?.code).toBe("TOOL_DOWNLOAD_UNTRUSTED");
    expect(failed.error?.message).toBe(
      "The download was stopped because the secure connection to the publisher could not be verified, so nothing was installed. A VPN, a security program or a network that inspects secure connections can cause this: try again without it, or on another network.",
    );
    const again = await call({ method: "POST", url: "/tools/speech-tiny/install" });
    expect(again.status).toBe(202);
  });

  it("an unknown tool, action or job is 404", async () => {
    await start({ worker: stubWorker(), autoStartWorker: false });
    expect((await call({ method: "POST", url: "/tools/nope/install" })).status).toBe(404);
    expect((await call({ method: "POST", url: "/tools/ffmpeg/explode" })).status).toBe(404);
    expect((await call({ url: "/tools/jobs/nope" })).status).toBe(404);
    expect((await call({ method: "POST", url: "/tools/jobs/nope/cancel" })).status).toBe(404);
  });

  it("starting a job without a media helper is 503", async () => {
    await start({ worker: null, autoStartWorker: false });
    const r = await call({ method: "POST", url: "/tools/ffmpeg/install" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("WORKER_UNAVAILABLE");
  });
});

describe("tool errors elsewhere", () => {
  it("a failed capture-tools update is 502 TOOL_FAILED with the worker's code", async () => {
    const worker = stubWorker();
    worker.updateError = new WorkerToolError("TOOL_UPDATE_FAILED", "yt-dlp could not be updated", "video-downloader");
    await start({ worker, autoStartWorker: false });
    const r = await call({ method: "POST", url: "/tools/update" });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatchObject({ code: "TOOL_FAILED", reason: "TOOL_UPDATE_FAILED" });
  });

  it("a damaged model is the media helper's failure, not a failed tool install", async () => {
    const e = toApiError(new WorkerToolError("MODEL_UNAVAILABLE", "the small model on disk could not be read", "speech-small"));
    expect(e.status).toBe(502);
    expect(e.code).toBe("INTERNAL");
    expect(e.reason).toBe("MODEL_UNAVAILABLE");
    expect(toApiError(new WorkerToolError("TOOL_UPDATE_FAILED", "x", "video-downloader")).code).toBe("TOOL_FAILED");
  });

  it("a transcription whose speech model is missing is 409 TOOL_NOT_INSTALLED naming the tool", async () => {
    const worker = stubWorker({ transcribeError: new WorkerToolError("TOOL_NOT_INSTALLED", "Speech model: small is not installed.", "speech-small") });
    await start({ worker, autoStartWorker: false });
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
    const p = await call({ method: "POST", url: "/projects", body: { name: "S", governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n", encryption: { enabled: false } } });
    const pid = p.json.project.id as string;
    const dir = join(tmp, "in");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "talk.mp3"), Buffer.alloc(64, 1));
    const sf = await svc.state.session!.repo.createSource(
      pid,
      { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: join(dir, "talk.mp3"), role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    const sid = sf.source.id;
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "small" } });
    expect(r.status, r.body).toBe(409);
    expect(r.json.error).toMatchObject({ code: "TOOL_NOT_INSTALLED", reason: "speech-small" });
  });
});

describe("GET /jobs names the missing tool of a failed viewing copy or OCR job", () => {
  it("video proxies need ffmpeg, OCR needs ocr; other failures and image proxies name none", () => {
    expect(failureTool("video.proxy", "TOOL_NOT_INSTALLED")).toBe("ffmpeg");
    expect(failureTool("ocr", "TOOL_NOT_INSTALLED")).toBe("ocr");
    expect(failureTool("video.proxy", "FFMPEG_FAILED")).toBeUndefined();
    expect(failureTool("image.proxy", "TOOL_NOT_INSTALLED")).toBeUndefined();
  });
});

describe("speech models (R158)", () => {
  it("a transcription accepts exactly the shared models, and a missing one is named by its tool id", async () => {
    const { SPEECH_MODELS } = await import("@ao/shared");
    await start({ worker: stubWorker({ missingModels: true }), autoStartWorker: false });
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
    const p = await call({ method: "POST", url: "/projects", body: { name: "S", governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n", encryption: { enabled: false } } });
    const pid = p.json.project.id as string;
    const dir = join(tmp, "in");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "talk.mp3"), Buffer.alloc(64, 1));
    const sf = await svc.state.session!.repo.createSource(
      pid,
      { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: join(dir, "talk.mp3"), role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    for (const model of SPEECH_MODELS) {
      const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sf.source.id}/transcribe`, body: { model } });
      // Task 62: refused at the start when the tools list says so; else the job fails with the same answer.
      let error = r.json.error as { code: string; reason?: string; message: string } | undefined;
      if (r.status === 202) {
        await svc.state.idle();
        const job = (await call({ url: `/projects/${pid}/sources/${sf.source.id}/transcription` })).json.job;
        expect(job.status, model).toBe("failed");
        error = job.error;
      } else expect(r.status, model).toBe(409);
      expect(error).toMatchObject({ code: "TOOL_NOT_INSTALLED", reason: `speech-${model}` });
      expect(error!.message).toMatch(/The Optional tools screen/);
    }
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sf.source.id}/transcribe`, body: { model: "huge" } })).status).toBe(400);
  });
});
