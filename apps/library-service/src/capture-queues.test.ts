/**
 * A capture's state can be read again (Task 63, R146): GET /projects/:id/captures and
 * GET /projects/:id/captures/:queueId list a project's running and recent queues and return one
 * queue's items, for the desktop app only (R96, R116); a second capture of an address still waiting
 * or being captured in the same project is refused in plain words.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WorkerJobError, WorkerToolError, deviceDeps, type Deps, type JobResult, type WorkerClient, type WorkerJob } from "@ao/library";
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
function gatedWorker(opts: { honoursCancel?: boolean } = {}): WorkerProvider & { calls: WorkerJob[]; release(): void } {
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
          // A worker that honours a cancel stops the job when its signal is aborted (as the worker
          // client's poll does: POST /jobs/:id/cancel, then the job ends cancelled). By default the
          // download does not stop by itself, as a slow one would not.
          const cancelled = opts.honoursCancel && job.signal ? new Promise<void>((r) => (job.signal!.aborted ? r() : job.signal!.addEventListener("abort", () => r()))) : new Promise<void>(() => {});
          await Promise.race([gate, cancelled]);
          if (opts.honoursCancel && job.signal?.aborted) throw new WorkerJobError("CANCELLED", "the job was cancelled");
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

  it("a link whose handle cannot be decoded is refused like any unrecognised link, never 500 (R379, WB1 I4)", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project();
    const ext = await extensionToken();
    const send = (urls: string[]) => call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls } });
    const unrecognised = await send(["https://www.tiktok.com/@someone/followers"]);
    expect(unrecognised.status).toBe(400);
    for (const u of ["https://www.tiktok.com/@%ZZ", "https://www.youtube.com/@%E0%A4%A", "https://www.tiktok.com/@%ZZ/video/123"]) {
      const r = await send([u]);
      expect(r.status, u).toBe(400);
      expect(r.json.error, u).toEqual(unrecognised.json.error);
    }
    expect(worker.calls).toHaveLength(0);
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

describe("a locked project (Task 63 fix round 1: I1, I2; R30, R50, R142)", () => {
  async function lockedWhileRunning(): Promise<{ pid: string; plain: string; queueId: string; plainQueue: string; worker: ReturnType<typeof gatedWorker>; events: Array<{ type: string; data: any }> }> {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const plain = await project("Plain");
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, YT2, IG] } });
    expect(q.status, q.body).toBe(200);
    const pq = await call({ method: "POST", url: `/projects/${plain}/capture`, body: { urls: ["https://www.youtube.com/watch?v=plain000001"] } });
    expect(pq.status, pq.body).toBe(200);
    await until(() => worker.calls.length > 0);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    return { pid, plain, queueId: q.json.queueId as string, plainQueue: pq.json.queueId as string, worker, events };
  }

  it("I1: a capture of a locked project answers 423 whatever the address (desktop and extension routes): nothing tells what it is capturing", async () => {
    const { pid, worker } = await lockedWhileRunning();
    const ext = await extensionToken();
    const answers = [];
    for (const urls of [[YT2], ["https://www.youtube.com/watch?v=other000001"]]) {
      const ui = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls } });
      const fromExt = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls } });
      answers.push([ui.status, ui.json.error], [fromExt.status, fromExt.json.error]);
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]![0]).toBe(423);
    expect((answers[0]![1] as { code: string }).code).toBe("PROJECT_LOCKED");
    const profile = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } });
    expect(profile.status).toBe(423);
    worker.release();
    await svc.state.idle();
  });

  it("Task 66 (R171): a paired browser's port is still recorded when its capture is refused with 423, and the answer is the same as the desktop app's", async () => {
    const { pid, worker } = await lockedWhileRunning();
    // Paired while the service was on another port (as before a relaunch), then it listens on a new one.
    svc.pairing.setPort(50001);
    const ext = await extensionToken();
    const port = await svc.listen(0);
    const host = { host: `127.0.0.1:${port}` };
    const urls = [YT2];
    const ui = await call({ method: "POST", url: `/projects/${pid}/capture`, headers: host, body: { urls } });
    const fromExt = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { ...host, authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls } });
    expect(fromExt.status).toBe(423);
    expect([fromExt.status, fromExt.json.error]).toEqual([ui.status, ui.json.error]);
    await svc.pairing.idle();
    expect(svc.pairing.list()[0]!.port).toBe(port);
    worker.release();
    await svc.state.idle();
  });

  it("I2: at the lock, the running queue's record is forgotten at once and it stops before its next link; another project's queue is untouched", async () => {
    const { pid, plain, queueId, plainQueue, worker, events } = await lockedWhileRunning();
    expect(svc.state.captureQueues.detail(pid, queueId)).toBeUndefined();
    // Its download still occupies the worker (fix round 2, I3): only its progress counters remain, no address.
    expect(Object.keys(svc.state.captureQueue(queueId) ?? {}).sort()).toEqual(["done", "finished", "lib", "projectId", "total"]);
    // Its end is published at the lock itself.
    expect(events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId).at(-1)?.data).toMatchObject({ finished: true });
    expect(svc.state.captureQueues.detail(plain, plainQueue)).toBeDefined();
    worker.release();
    await svc.state.idle();
    // The link in progress ended; the others were not tried (R142: nothing more runs for a locked project).
    const secretCalls = worker.calls.filter((j) => j.input !== "https://www.youtube.com/watch?v=plain000001");
    expect(secretCalls).toHaveLength(1);
    expect(svc.state.captureQueues.detail(pid, queueId)).toBeUndefined();
    expect(svc.state.captureQueue(queueId)).toBeUndefined();
    // No outcome of the locked project's queue was published after the lock; its end says why.
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId);
    expect(mine.filter((e) => e.data.outcome)).toHaveLength(0);
    expect(mine.at(-1)?.data).toMatchObject({ finished: true });
    expect(mine.at(-1)?.data.error).toMatch(/^ProjectLockedError/);
    expect(svc.state.captureQueues.detail(plain, plainQueue)).toMatchObject({ finished: true, done: 1 });
    // After the unlock the screen reads what the service has: nothing of before, but the count of the links it cut.
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [], cutByLock: 3 }); // only the count of the links it cut (R464 b)
  });

  it("I2: a finished queue of a project is forgotten when the project is locked", async () => {
    const worker = gatedWorker();
    worker.release();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
    await svc.state.idle();
    expect(svc.state.captureQueues.detail(pid, q.json.queueId)).toMatchObject({ finished: true });
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(svc.state.captureQueues.detail(pid, q.json.queueId)).toBeUndefined();
    expect(svc.state.captureQueue(q.json.queueId)).toBeUndefined();
  });

  it("I2: closing the library forgets an encrypted project's queues (its key goes with it); a plain project's stay readable when it is opened again", async () => {
    const worker = gatedWorker();
    worker.release();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const plain = await project("Plain");
    const a = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
    const b = await call({ method: "POST", url: `/projects/${plain}/capture`, body: { urls: [YT] } });
    await svc.state.idle();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(svc.state.captureQueues.detail(pid, a.json.queueId)).toBeUndefined();
    expect(svc.state.captureQueue(a.json.queueId)).toBeUndefined();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    expect((await call({ url: `/projects/${plain}/captures/${b.json.queueId as string}` })).json).toMatchObject({ finished: true });
  });
});

describe("a lock ends a project's running captures for good (fix round 2: I3, R116)", () => {
  async function running(encrypted = true, over: Partial<ServiceOptions> = {}): Promise<{ pid: string; queueId: string; worker: ReturnType<typeof gatedWorker>; events: Array<{ type: string; data: any }> }> {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false, ...over });
    await openLibrary();
    const pid = await project(encrypted ? "Secret" : "Plain", encrypted);
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, YT2, IG] } });
    expect(q.status, q.body).toBe(200);
    await until(() => worker.calls.length > 0);
    return { pid, queueId: q.json.queueId as string, worker, events };
  }
  const lock = (pid: string) => call({ method: "POST", url: `/projects/${pid}/lock` });
  const unlock = (pid: string) => call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } });

  it("lock then unlock while a download is in flight: the queue is over; its late result is discarded; the address is taken again only once that download has ended, as a new visible capture", async () => {
    const { pid, queueId, worker, events } = await running();
    expect((await lock(pid)).status).toBe(200);
    expect((await unlock(pid)).status).toBe(200);
    // The old download still runs: nothing new in this project until it has ended, in plain words.
    const again = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "CONFLICT", reason: "CAPTURE_STOPPING" });
    expect(again.json.error.message).not.toMatch(/https?:/);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [], cutByLock: 3 }); // only the count of the links it cut (R464 b)
    worker.release();
    await svc.state.idle();
    // Only the download in flight at the lock ran; nothing of the queue was published after its end.
    expect(worker.calls).toHaveLength(1);
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data).toMatchObject({ finished: true });
    expect(mine[0]!.data.error).toMatch(/^ProjectLockedError/);
    expect(svc.state.captureQueue(queueId)).toBeUndefined();
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [], cutByLock: 3 });
    // Now a new capture of the same address is accepted, and visible.
    const fresh = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
    expect(fresh.status).toBe(200);
    expect((await call({ url: `/projects/${pid}/captures` })).json.queues.map((q: { queueId: string }) => q.queueId)).toEqual([fresh.json.queueId]);
    await svc.state.idle();
  });

  it("Task 66 (R171): a paired browser's port is still recorded when its capture is refused with 409 CAPTURE_STOPPING", async () => {
    const { pid, worker } = await running();
    svc.pairing.setPort(50001);
    const ext = await extensionToken();
    const port = await svc.listen(0);
    const host = { host: `127.0.0.1:${port}` };
    expect((await call({ method: "POST", url: `/projects/${pid}/lock`, headers: host })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, headers: host, body: { secret: PASS } })).status).toBe(200);
    const fromExt = await call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { ...host, authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls: [YT] } });
    expect(fromExt.status).toBe(409);
    expect(fromExt.json.error).toMatchObject({ code: "CONFLICT", reason: "CAPTURE_STOPPING" });
    await svc.pairing.idle();
    expect(svc.pairing.list()[0]!.port).toBe(port);
    worker.release();
    await svc.state.idle();
  });

  it("the extension's limit of one running and one waiting list holds across a lock and an unlock", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const ext = await extensionToken();
    const send = (urls: string[]) => call({ method: "POST", url: "/capture/browser/links", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT }, body: { projectId: pid, urls } });
    expect((await send([YT])).status).toBe(200);
    expect((await send([YT2])).status).toBe(200);
    await until(() => worker.calls.length > 0);
    expect((await lock(pid)).status).toBe(200);
    expect((await unlock(pid)).status).toBe(200);
    // Both still occupy their slots while the first one's download runs.
    expect((await send([IG])).status).toBe(429);
    worker.release();
    await svc.state.idle();
    expect(worker.calls).toHaveLength(1);
    expect((await send([IG])).status).toBe(200);
    await svc.state.idle();
  });

  it("locking a project that is not encrypted changes nothing: its queue runs on, visible, and its addresses are still refused", async () => {
    const { pid, queueId, worker, events } = await running(false);
    expect((await lock(pid)).status).toBe(200);
    expect(svc.state.captureQueues.detail(pid, queueId)).toMatchObject({ finished: false });
    const again = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT2] } });
    expect(again.status).toBe(409);
    expect(again.json.error.reason).toBe("CAPTURE_RUNNING");
    worker.release();
    await svc.state.idle();
    expect(worker.calls).toHaveLength(3);
    expect(svc.state.captureQueues.detail(pid, queueId)).toMatchObject({ finished: true, done: 3 });
    expect(events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId && e.data.error)).toHaveLength(0);
  });

  it("two locks in a row: one end, published once; the queue stays over after the unlock", async () => {
    const { pid, queueId, worker, events } = await running();
    expect((await lock(pid)).status).toBe(200);
    expect((await lock(pid)).status).toBe(200);
    expect((await unlock(pid)).status).toBe(200);
    worker.release();
    await svc.state.idle();
    expect(worker.calls).toHaveLength(1);
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data.error).toMatch(/^ProjectLockedError/);
  });

  it("a profile run: a lock then an unlock ends it; nothing more of it is published", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } });
    expect(r.status).toBe(200);
    await until(() => worker.calls.length > 0);
    expect((await lock(pid)).status).toBe(200);
    expect((await unlock(pid)).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } })).json.error?.reason).toBe("CAPTURE_STOPPING");
    worker.release();
    await svc.state.idle();
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === r.json.queueId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data.error).toMatch(/^ProjectLockedError/);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });
  });

  it("a close while a download runs ends an encrypted project's queue: nothing more runs or is published, also after reopening", async () => {
    const { pid, queueId, worker, events } = await running();
    const closing = call({ method: "POST", url: "/libraries/close" });
    await until(() => events.some((e) => e.type === "capture.progress" && e.data.queueId === queueId && e.data.finished));
    worker.release();
    expect((await closing).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    expect((await unlock(pid)).status).toBe(200);
    await svc.state.idle();
    expect(worker.calls).toHaveLength(1);
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data.error).toMatch(/^LibraryClosedError/);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });
    expect((await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } })).status).toBe(200);
    await svc.state.idle();
  });

  it("a move ends an encrypted project's queue; it is not continued on the moved library (R534 b: nothing of it begins after the move's stop)", async () => {
    // Since FR-733 (R503 l, R513 M1) a queue may go on while the move's plan is taken; what must hold is that nothing of it
    // begins after the move stops running work, nothing of it reports during the copy, and it is ended, not carried on.
    // The first link is held so that it is still downloading when the plan is accepted and when the stop reaches it.
    let atPlan: number | undefined;
    let atStop: number | undefined;
    let atCopy: number | undefined;
    const mine = () => events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId);
    const { pid, queueId, worker, events } = await running(true, {
      afterMovePlan: async () => void (atPlan = worker.calls.length),
      beforeExecuteMove: async () => void (atCopy = mine().length),
    });
    // The stop: the move's drain marks running work to stop before it returns; the held download is let go only then.
    const drain = svc.state.drainWork.bind(svc.state);
    const spy = vi.spyOn(svc.state, "drainWork").mockImplementation((ms, which) => {
      const drained = drain(ms, which);
      if (atStop === undefined) {
        atStop = worker.calls.length;
        worker.release();
      }
      return drained;
    });
    onTestFinished(() => spy.mockRestore());
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    // The first link was still downloading when the plan was accepted and when the stop came.
    expect(atPlan).toBe(1);
    expect(atStop).toBe(1);
    expect(atCopy).toBeDefined();
    // During the copy and the switch nothing of the queue reported but its end at the close.
    expect(mine().slice(atCopy).map((e) => e.data.error)).toEqual([expect.stringMatching(/^LibraryClosedError/)]);
    expect((await unlock(pid)).status).toBe(200);
    await svc.state.idle();
    // No download began after the stop, and none on the moved library.
    expect(worker.calls).toHaveLength(atStop!);
    expect(worker.calls).toHaveLength(1);
    // At most the link that was downloading when the move stopped work reports its outcome (before the close).
    expect(mine().filter((e) => e.data.outcome).length).toBeLessThanOrEqual(1);
    expect(mine().at(-1)!.data.error).toMatch(/^LibraryClosedError/);
    expect(svc.state.captureQueue(queueId)).toBeUndefined();
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });
    expect((await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT2] } })).status).toBe(200);
    await svc.state.idle();
  });

  it("R503 l (FR-733): a move refused at its plan stops nothing: an encrypted project's queue captures its remaining links in the library still open", async () => {
    let planned = false;
    const { pid, queueId, worker, events } = await running(true, { afterMovePlan: async () => void (planned = true) });
    const drain = vi.spyOn(svc.state, "drainWork");
    onTestFinished(() => drain.mockRestore());
    // A destination that already holds someone else's file: the move is refused at its plan.
    const dest = join(tmp, "Full");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "notes.txt"), "someone else's file");
    const refused = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    expect(JSON.parse(refused.body.trim().split("\n").at(-1)!)).toHaveProperty("error");
    expect(refused.body).not.toContain('"done":true');
    expect(planned).toBe(false);
    // Nothing was stopped: the queue is still running, its first link still downloading.
    expect(drain).not.toHaveBeenCalled();
    expect(svc.state.captureQueues.detail(pid, queueId)).toMatchObject({ finished: false });
    worker.release();
    await svc.state.idle();
    expect(worker.calls).toHaveLength(3);
    expect(svc.state.captureQueues.detail(pid, queueId)).toMatchObject({ finished: true, done: 3 });
    expect(events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId && e.data.error)).toHaveLength(0);
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Lib"));
  });

  it("N5: the lock asks the in-flight download to stop; the project's captures are accepted again without waiting for it; nothing of it is published", async () => {
    const worker = gatedWorker({ honoursCancel: true });
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, YT2] } });
    await until(() => worker.calls.length > 0);
    expect((await lock(pid)).status).toBe(200);
    expect(worker.calls[0]!.signal?.aborted).toBe(true);
    expect((await unlock(pid)).status).toBe(200);
    // The gate is never opened: the slow download ended because it was asked to.
    let status = 0;
    await until(async () => (status = (await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } })).status) === 200);
    expect(status).toBe(200);
    expect(worker.calls.filter((j) => j.input.includes("aoTest00001"))).toHaveLength(0);
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === q.json.queueId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data.error).toMatch(/^ProjectLockedError/);
    expect(svc.state.captureQueue(q.json.queueId as string)).toBeUndefined();
  });

  it("N5: a profile run's download is asked to stop at the lock too", async () => {
    const worker = gatedWorker({ honoursCancel: true });
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    expect((await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } })).status).toBe(200);
    await until(() => worker.calls.length > 0);
    expect((await lock(pid)).status).toBe(200);
    expect(worker.calls[0]!.signal?.aborted).toBe(true);
    expect((await unlock(pid)).status).toBe(200);
    await until(async () => (await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: PROFILE } })).status === 200);
  });

  it("N6: while a capture ended by a close or move still finishes, the refusal says the library was closed or moved", async () => {
    const { pid, worker } = await running();
    svc.state.endCaptures(pid, "close");
    const r = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT] } });
    expect(r.status).toBe(409);
    expect(r.json.error.reason).toBe("CAPTURE_STOPPING");
    expect(r.json.error.message).toMatch(/library was closed or moved/);
    expect(r.json.error.message).not.toMatch(/locked/);
    worker.release();
    await svc.state.idle();
  });
});

describe("what a lock cut from a project's capture queue: only its COUNT is kept, to remind after the unlock (FR-370, FR-371; R464 b)", () => {
  const ACK = (pid: string) => `/projects/${pid}/captures/cut-by-lock/acknowledge`;
  const ADDRESSES = [YT, YT2, IG];
  /** Every address of the cut queue, and the part of each that names the post (without the site). */
  const held = (text: string) => ADDRESSES.some((u) => text.includes(u) || text.includes(new URL(u).pathname + new URL(u).search));

  it("after the lock no address of the cut links is held anywhere the service can reach; the count is told only after the unlock, until 'Got it'", async () => {
    const worker = gatedWorker();
    let logs = "";
    await start({ worker, autoStartWorker: false, logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }) });
    await openLibrary();
    const pid = await project("Secret", true);
    const events: Array<{ type: string; data: any }> = [];
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: ADDRESSES } });
    expect(q.status, q.body).toBe(200);
    const queueId = q.json.queueId as string;
    await until(() => worker.calls.length > 0);
    svc.state.events.subscribe((e) => events.push(e));
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);

    // The count's record is a number, and the queue's what remains holds counters only.
    expect(svc.state.capturesCutByLock(pid)).toBe(3);
    const reachable = () => [JSON.stringify(svc.state.captureQueue(queueId) ?? null), JSON.stringify(svc.state.captureQueues.list(pid)), JSON.stringify(svc.state.capturesCutByLock(pid)), JSON.stringify(events), logs];
    for (const text of reachable()) expect(held(text), text.slice(0, 300)).toBe(false);

    // While the project is locked the count is not told: the queues' route refuses as it did, and so does the acknowledgement.
    const whileLocked = await call({ url: `/projects/${pid}/captures` });
    expect(whileLocked.status).toBe(423);
    expect(whileLocked.body).not.toMatch(/cut|3/i);
    expect((await call({ method: "POST", url: ACK(pid) })).status).toBe(423);
    expect(svc.state.capturesCutByLock(pid)).toBe(3);

    // The download in flight returns; still nothing of the addresses, an error included.
    worker.release();
    await svc.state.idle();
    for (const text of reachable()) expect(held(text), text.slice(0, 300)).toBe(false);

    // After the unlock the capture state the screen reads carries the count.
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [], cutByLock: 3 });

    // The acknowledgement is the desktop app's own: the extension's token does not reach it.
    const ext = await extensionToken();
    const fromExt = await call({ method: "POST", url: ACK(pid), noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } });
    expect(fromExt.status).toBe(403);
    expect((await call({ method: "POST", url: ACK(pid), noAuth: true })).status).toBe(401);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [], cutByLock: 3 });

    // "Got it": the count is gone, and another lock with nothing running brings nothing back.
    expect((await call({ method: "POST", url: ACK(pid) })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });
    expect(svc.state.capturesCutByLock(pid)).toBeUndefined();
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/captures` })).json).toEqual({ queues: [] });
  });

  it("only the links not reached are counted; another project and a project not encrypted count nothing", async () => {
    const worker = gatedWorker();
    await start({ worker, autoStartWorker: false });
    await openLibrary();
    const pid = await project("Secret", true);
    const other = await project("Other", true);
    const plain = await project("Plain");
    const q = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [YT, YT2] } });
    expect(q.status, q.body).toBe(200);
    const p = await call({ method: "POST", url: `/projects/${plain}/capture`, body: { urls: [IG] } });
    expect(p.status, p.body).toBe(200);
    await until(() => worker.calls.length > 1);
    expect((await call({ method: "POST", url: `/projects/${plain}/lock` })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${other}/lock` })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(svc.state.capturesCutByLock(pid)).toBe(2);
    expect(svc.state.capturesCutByLock(other)).toBeUndefined();
    expect(svc.state.capturesCutByLock(plain)).toBeUndefined();
    worker.release();
    await svc.state.idle();
    expect((await call({ url: `/projects/${plain}/captures` })).json.cutByLock).toBeUndefined();
  });
});
