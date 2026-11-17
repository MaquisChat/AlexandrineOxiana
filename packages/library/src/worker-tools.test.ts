/**
 * The optional tools through the worker (Task 48a, R126): the catalogue, install / update / remove
 * as worker jobs with progress and cancel, and missing tools named on ordinary jobs.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { openIndex, type IndexDb } from "./index/db.js";
import { createLibrary, type Library } from "./library.js";
import type { Repo } from "./repo/index.js";
import { openTestRepo } from "./repo/testing.js";
import { WorkerClient, WorkerJobError, WorkerToolError, WorkerToolsClient, WorkerUnavailableError } from "./worker-client.js";
import { stubWorker } from "./worker-testing.js";

const TOKEN = "stub-token-0123456789";

interface FakeTools {
  baseUrl: string;
  token: string;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  close(): Promise<void>;
}

/** A stand-in for the worker's /tools routes and the /jobs routes of its tool jobs. */
async function fakeTools(script: { final: Record<string, unknown>; polls?: number; submitStatus?: number; submitBody?: unknown; ignoreCancel?: boolean } = { final: { status: "done", result: { tool: "ffmpeg", action: "install", installed: ["ffmpeg"] } } }): Promise<FakeTools> {
  const requests: FakeTools["requests"] = [];
  let polls = 0;
  let cancelled = false;
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
    if (req.method === "GET" && req.url === "/tools") return send(200, { platform: "linux-x64", tools: [{ id: "ffmpeg", installed: false }] });
    if (req.method === "POST" && /^\/tools\/[a-z0-9-]+\/(install|update|remove)$/.test(req.url ?? "")) {
      if (script.submitStatus) return send(script.submitStatus, script.submitBody);
      return send(202, { id: "w1" });
    }
    if (req.method === "POST" && req.url === "/tools/update") return send(script.submitStatus ?? 200, script.submitBody ?? {});
    if (req.method === "POST" && req.url === "/jobs/w1/cancel") {
      cancelled = !script.ignoreCancel;
      return send(202, { id: "w1", status: "running" });
    }
    if (req.method === "GET" && req.url === "/jobs/w1") {
      polls++;
      if (cancelled) return send(200, { id: "w1", type: "tool.install", status: "cancelled", progress: 0.5 });
      if (polls < (script.polls ?? 3)) return send(200, { id: "w1", type: "tool.install", status: "running", progress: polls / 4 });
      return send(200, { id: "w1", type: "tool.install", progress: 1, ...script.final });
    }
    send(404, { error: { code: "NOT_FOUND", message: "no" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function started(script?: Parameters<typeof fakeTools>[0]): Promise<FakeTools> {
  const f = await fakeTools(script);
  closers.push(f.close);
  return f;
}

describe("WorkerToolsClient", () => {
  it("reads the catalogue with the worker's token", async () => {
    const f = await started();
    const tools = new WorkerToolsClient(f);
    expect(await tools.catalogue()).toEqual({ platform: "linux-x64", tools: [{ id: "ffmpeg", installed: false }] });
    expect(f.requests).toEqual([{ method: "GET", url: "/tools", auth: `Bearer ${TOKEN}` }]);
  });

  it("runs an install as a worker job, reports its progress and returns its result", async () => {
    const f = await started();
    const seen: number[] = [];
    const r = await new WorkerToolsClient(f, { pollMs: 5 }).run("install", "ffmpeg", { onProgress: (p) => seen.push(p) });
    expect(r).toEqual({ tool: "ffmpeg", action: "install", installed: ["ffmpeg"] });
    expect(f.requests[0]).toMatchObject({ method: "POST", url: "/tools/ffmpeg/install" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("a failed install throws WorkerToolError with the worker's code and the tool", async () => {
    const f = await started({ final: { status: "failed", error: { code: "TOOL_CHECKSUM_MISMATCH", message: "the download does not match its published checksum", tool: "ffmpeg" } } });
    const err = await new WorkerToolsClient(f, { pollMs: 5 }).run("install", "ffmpeg").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerToolError);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerToolError).code).toBe("TOOL_CHECKSUM_MISMATCH");
    expect((err as WorkerToolError).tool).toBe("ffmpeg");
  });

  it("aborting cancels the worker job", async () => {
    const f = await started({ final: { status: "done", result: {} }, polls: 1000 });
    const ac = new AbortController();
    const p = new WorkerToolsClient(f, { pollMs: 5 }).run("install", "ffmpeg", { signal: ac.signal, onProgress: () => ac.abort() });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerJobError).code).toBe("CANCELLED");
    expect(f.requests.some((r) => r.method === "POST" && r.url === "/jobs/w1/cancel")).toBe(true);
  });

  it("a worker that does not confirm a cancel is given up on after the grace period, as unconfirmed", async () => {
    const f = await started({ final: { status: "done", result: {} }, polls: 100000, ignoreCancel: true });
    const ac = new AbortController();
    const t = Date.now();
    const p = new WorkerToolsClient(f, { pollMs: 5, cancelGraceMs: 100 }).run("install", "ffmpeg", { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const err = await p.catch((e: unknown) => e);
    expect((err as WorkerJobError).code).toBe("CANCEL_UNCONFIRMED");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("an install that completes although a cancel was asked for returns its result", async () => {
    const f = await started({ final: { status: "done", result: { tool: "ffmpeg", installed: ["ffmpeg"] } }, polls: 4, ignoreCancel: true });
    const ac = new AbortController();
    ac.abort();
    const p = new WorkerToolsClient(f, { pollMs: 5 }).run("install", "ffmpeg", { signal: ac.signal });
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" }); // aborted before it was even sent
    const ac2 = new AbortController();
    const r = await new WorkerToolsClient(f, { pollMs: 5 }).run("install", "ffmpeg", { signal: ac2.signal, onProgress: () => ac2.abort() });
    expect(r).toMatchObject({ installed: ["ffmpeg"] });
  });

  it("an unknown tool is the worker's 404 code, not a crash", async () => {
    const f = await started({ final: {}, submitStatus: 404, submitBody: { error: { code: "UNKNOWN_TOOL", message: "there is no such tool" } } });
    const err = await new WorkerToolsClient(f).run("install", "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerJobError).code).toBe("UNKNOWN_TOOL");
  });

  it("a failed capture-tools update keeps the worker's code (never a bare error)", async () => {
    const f = await started({ final: {}, submitStatus: 502, submitBody: { error: { code: "TOOL_UPDATE_FAILED", message: "yt-dlp could not be updated", tool: "video-downloader" } } });
    const err = await new WorkerToolsClient(f).updateCaptureTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerToolError);
    expect((err as WorkerToolError).code).toBe("TOOL_UPDATE_FAILED");
    expect((err as WorkerToolError).tool).toBe("video-downloader");
  });

  it("an unreachable worker is WorkerUnavailableError", async () => {
    const err = await new WorkerToolsClient({ baseUrl: "http://127.0.0.1:9", token: TOKEN }).catalogue().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerUnavailableError);
  });
});

// ---- a project job whose tool is missing ----

const FAST = 2 ** 10;
let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let db: IndexDb;
let files: string;

function deps(): Deps {
  return {
    clock: () => new Date(),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

describe("WorkerClient.submit with a missing tool", () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-worker-tools-"));
    ring = new KeyRing();
    lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
    files = join(lib.root, "test-files"); // job paths inside the library (R379)
    await mkdir(files, { recursive: true });
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
    db = openIndex(lib.root);
  });
  afterEach(async () => {
    db.close();
    await lib.close();
    ring.clear();
    await rm(tmp, { recursive: true, force: true });
  });

  it("throws WorkerToolError naming the tool (a WorkerJobError, so existing handling still applies)", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n", encryption: { enabled: false } });
    const input = join(files, "clip.mov");
    await writeFile(input, "video");
    const worker = await stubWorker(() => ({ status: "failed", error: { code: "TOOL_NOT_INSTALLED", message: "Video tools (ffmpeg) is not installed.", tool: "ffmpeg" } }), { token: TOKEN, closers });
    const err = await new WorkerClient({ repo, worker, index: { db }, pollMs: 10 })
      .submit(project.id, { type: "video.proxy", input, output: join(files, "out", "p.mp4"), params: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerToolError);
    expect(err).toBeInstanceOf(WorkerJobError);
    expect((err as WorkerToolError).code).toBe("TOOL_NOT_INSTALLED");
    expect((err as WorkerToolError).tool).toBe("ffmpeg");
  });
});
