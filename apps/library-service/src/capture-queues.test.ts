/**
 * A capture's state can be read again (Task 63, R146): GET /projects/:id/captures and
 * GET /projects/:id/captures/:queueId list a project's running and recent queues and return one
 * queue's items, for the desktop app only (R96, R116); a second capture of an address still waiting
 * or being captured in the same project is refused in plain words.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerToolError, deviceDeps, type Deps, type JobResult, type WorkerClient, type WorkerJob } from "@ao/library";
import type { CaptureQueueDetail, CaptureQueueListResponse } from "@ao/shared";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PASS = "correct horse battery staple";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
captureMethods: [manual_upload, downloader, browser_capture]
`;
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YT2 = "https://www.youtube.com/watch?v=aoTest00001";
const IG = "https://www.instagram.com/p/Cabc123/";
const PROFILE = "https://www.instagram.com/some.researcher/";

let tmp: string;
let deps: Deps;
let svc: LibraryService;
/** Every gate opened after each test, so a failing test never leaves a queue waiting. */
const gates: Array<() => void> = [];

/**
 * A stand-in worker whose downloads wait until released, then fail because the video downloader is
 * not installed (TOOL_NOT_INSTALLED naming the tool): a queue stays running until `release()`.
 */
function gatedWorker(): WorkerProvider & { calls: WorkerJob[]; release(): void } {
  const calls: WorkerJob[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  gates.push(() => open());
  return {
    calls,
    release() {
      open();
    },
    async start() {
      const client = {
        async submit(_pid: string, job: WorkerJob): Promise<JobResult> {
          calls.push(job);
          await gate;
          throw new WorkerToolError("TOOL_NOT_INSTALLED", "yt-dlp is not installed", "video-downloader");
        },
        async resumePending() {
          return [];
        },
      } as unknown as WorkerClient;
      return { clientFor: () => client, versions: async () => ({}), updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }), stop: async () => {} };
    },
  };
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

async function openLibrary(): Promise<void> {
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
}

async function project(name = "Study", encrypted = false): Promise<string> {
  const gov = encrypted ? GOV.replace("atRest: optional", "atRest: required") : GOV;
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: gov, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id;
}

async function extensionToken(): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

/** Waits until `fn` holds (a hang detector, not a budget). */
async function until(fn: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-capture-queues-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  for (const g of gates.splice(0)) g();
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("GET /projects/:id/captures and /captures/:queueId", () => {
  it("lists a running links queue and returns its items; the missing tool's code, sentence and id come through unchanged", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });

    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, YT2] } });
    expect(q.status, q.body).toBe(200);
    const queueId = q.json.queueId as string;
    await until(() => worker.calls.length > 0);
    const list = (await call({ url: `/projects/${pid}/captures` })).json as CaptureQueueListResponse;
    expect(list.queues).toHaveLength(1);
    expect(list.queues[0]).toMatchObject({ queueId, projectId: pid, kind: "links", startedBy: "desktop", done: 0, total: 2, finished: false });
    expect(list.queues[0]).not.toHaveProperty("items");
    const running = (await call({ url: `/projects/${pid}/captures/${queueId}` })).json as CaptureQueueDetail;
    expect(running).toMatchObject({ queueId, urls: [YT, YT2], items: [], done: 0, finished: false });

    worker.release();
    await svc.state.idle();
    const d = (await call({ url: `/projects/${pid}/captures/${queueId}` })).json as CaptureQueueDetail;
    expect(d.finished).toBe(true);
    expect(d.done).toBe(2);
    expect(d.finishedAt).toEqual(expect.any(String));
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ url: YT, status: "failed", errorCode: "TOOL_NOT_INSTALLED", tool: "video-downloader" });
    expect(d.items[0]!.reason).toMatch(/video downloader is not installed/);
  });

  it("a profile run: its address, its posts so far and its report (with its stop sentence)", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } });
    expect(r.status, r.body).toBe(200);
    const queueId = r.json.queueId as string;
    await until(() => worker.calls.length > 0);
    expect((await call({ url: `/projects/${pid}/captures/${queueId}` })).json).toMatchObject({ kind: "profile", url: PROFILE, finished: false, total: null });
    worker.release();
    await svc.state.idle();
    const d = (await call({ url: `/projects/${pid}/captures/${queueId}` })).json as CaptureQueueDetail;
    expect(d.finished).toBe(true);
    expect(d.urls).toBeUndefined();
    expect(d.report).toBeDefined();
    expect(d.report!.status).toBe("failed");
    expect(d.report).toMatchObject({ errorCode: "TOOL_NOT_INSTALLED", tool: "video-downloader" });
    expect(typeof d.report!.reason).toBe("string");
    expect(d.report).not.toHaveProperty("items");
  });

  it("a queue the paired extension started is listed, marked as the extension's", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    const ext = await extensionToken();
    const r = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls: [YT] } });
    expect(r.status, r.body).toBe(200);
    const list = (await call({ url: `/projects/${pid}/captures` })).json as CaptureQueueListResponse;
    expect(list.queues.map((q) => [q.queueId, q.startedBy])).toEqual([[r.json.queueId, "extension"]]);
    worker.release();
    await svc.state.idle();
  });

  describe("refusals", () => {
    async function running(): Promise<{ pid: string; other: string; queueId: string; worker: ReturnType<typeof gatedWorker> }> {
      const worker = gatedWorker();
      await start({ worker, autoStartWorker: false });
      await openLibrary();
      const pid = await project();
      const other = await project("Other");
      const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
      expect(q.status, q.body).toBe(200);
      return { pid, other, queueId: q.json.queueId as string, worker };
    }

    it("no token: 401", async () => {
      const { pid, queueId, worker } = await running();
      expect((await call({ url: `/projects/${pid}/captures`, noAuth: true })).status).toBe(401);
      expect((await call({ url: `/projects/${pid}/captures/${queueId}`, noAuth: true })).status).toBe(401);
      worker.release();
      await svc.state.idle();
    });

    it("a wrong Origin or Host: 403", async () => {
      const { pid, queueId, worker } = await running();
      const bad: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { origin: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }, { host: "evil.example" }];
      for (const headers of bad) {
        for (const url of [`/projects/${pid}/captures`, `/projects/${pid}/captures/${queueId}`]) {
          const r = await call({ url, headers });
          expect(r.status, `${url} ${JSON.stringify(headers)}`).toBe(403);
          expect(r.json.error.code).toBe("FORBIDDEN");
        }
      }
      // The desktop shell's origin is allowed.
      expect((await call({ url: `/projects/${pid}/captures`, headers: { origin: "tauri://localhost" } })).status).toBe(200);
      worker.release();
      await svc.state.idle();
    });

    it("the paired extension cannot read queues, not even its own (R116): 403", async () => {
      const { pid, worker } = await running();
      const ext = await extensionToken();
      const r = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls: [IG] } });
      expect(r.status, r.body).toBe(200);
      for (const url of [`/projects/${pid}/captures`, `/projects/${pid}/captures/${r.json.queueId as string}`]) {
        const res = await call({ url, noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } });
        expect(res.status, url).toBe(403);
      }
      worker.release();
      await svc.state.idle();
    });

    it("another project's queue id, an unknown one, an unknown project: 404, and nothing of the queue in the answer", async () => {
      const { pid, other, queueId, worker } = await running();
      const r = await call({ url: `/projects/${other}/captures/${queueId}` });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("NOT_FOUND");
      expect(r.body).not.toContain(YT);
      expect(r.body).not.toContain(pid);
      expect((await call({ url: `/projects/${other}/captures` })).json).toEqual({ queues: [] });
      expect((await call({ url: `/projects/${pid}/captures/not-a-queue` })).status).toBe(404);
      expect((await call({ url: `/projects/01ZZZZZZZZZZZZZZZZZZZZZZZZ/captures` })).status).toBe(404);
      worker.release();
      await svc.state.idle();
    });

    it("a locked project: 423 PROJECT_LOCKED", async () => {
      await start();
      await openLibrary();
      const pid = await project("Secret", true);
      expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
      for (const url of [`/projects/${pid}/captures`, `/projects/${pid}/captures/any-queue`]) {
        const r = await call({ url });
        expect(r.status, url).toBe(423);
        expect(r.json.error.code).toBe("PROJECT_LOCKED");
      }
      expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
      expect((await call({ url: `/projects/${pid}/captures` })).status).toBe(200);
    });
  });
});

describe("the same address again while its queue runs", () => {
  it("is refused with 409 CONFLICT (reason CAPTURE_RUNNING) in plain words; nothing new is queued", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    const other = await project("Other");
    const first = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, IG] } });
    expect(first.status).toBe(200);
    await until(() => worker.calls.length > 0);

    // The same address, also written differently (a short link, a tracking parameter).
    for (const urls of [[YT], [YT2, "https://youtu.be/dQw4w9WgXcQ"], ["https://www.instagram.com/p/Cabc123/?igsh=abc"]]) {
      const again = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls } });
      expect(again.status, JSON.stringify(urls)).toBe(409);
      expect(again.json.error).toMatchObject({ code: "CONFLICT", reason: "CAPTURE_RUNNING" });
      expect(again.json.error.message).toMatch(/already waiting or being captured in this project/);
      expect(again.json.error.message).not.toMatch(/https?:/);
    }
    expect((await call({ url: `/projects/${pid}/captures` })).json.queues).toHaveLength(1);
    // Another address, or another project, is queued.
    expect((await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT2] } })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${other}/capture`, body: { urls: [YT] } })).status).toBe(200);
    // From the extension too.
    const ext = await extensionToken();
    const fromExt = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls: [IG] } });
    expect(fromExt.status).toBe(409);
    expect(fromExt.json.error.reason).toBe("CAPTURE_RUNNING");
    // The refused list did not keep the extension's slot.
    worker.release();
    await svc.state.idle();
    // Once the queue has finished, the address may be captured again.
    expect((await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } })).status).toBe(200);
    await svc.state.idle();
  });

  it("parallel requests for the same address: one is queued, the other refused", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    const rs = await Promise.all([1, 2, 3].map(() => call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    worker.release();
    await svc.state.idle();
  });

  it("a profile still being captured is refused the same way", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    expect((await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } })).status).toBe(200);
    const again = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: "https://instagram.com/some.researcher?hl=en" } });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "CONFLICT", reason: "CAPTURE_RUNNING" });
    expect(again.json.error.message).toMatch(/already being captured in this project/);
    worker.release();
    await svc.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } })).status).toBe(200);
    await svc.state.idle();
  });
});
