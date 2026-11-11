/**
 * Capture routes that had no tests (Task 34a e): capture-profile, transcribe, the one-time
 * acknowledgement, and the capture tools' update, against a stand-in media worker.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerJobError, deviceDeps, type Deps, type JobResult, type WorkerClient, type WorkerJob } from "@ao/library";
import type { TranscriptListResponse, TranscriptResponse } from "@ao/shared";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const CAPTURE_GOV = `${GOV}captureMethods: [manual_upload, downloader]\n`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;

/** A stand-in worker: transcription writes a canned transcript (one of two segments flagged); downloads fail. */
function stubWorker(): WorkerProvider & { calls: WorkerJob[]; updates: number } {
  const calls: WorkerJob[] = [];
  const p = {
    calls,
    updates: 0,
    async start() {
      const client = {
        async submit(_pid: string, job: WorkerJob): Promise<JobResult> {
          calls.push(job);
          if (job.type === "audio.transcribe") {
            await mkdir(job.output, { recursive: true });
            const segments = [
              { start: 0, end: 2, text: "Welcome to the market.", lang: "en", flags: [] },
              { start: 2, end: 4, text: "Thanks for watching!", lang: "en", flags: ["outside-speech", "stock-phrase"] },
            ];
            await writeFile(join(job.output, "segments.json"), JSON.stringify(segments));
            await writeFile(join(job.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the market.\n\nNOTE flags: outside-speech, stock-phrase\n\n00:00:02.000 --> 00:00:04.000\nThanks for watching!\n");
            return { id: "t1", type: job.type, output: job.output, files: [join(job.output, "transcript.vtt"), join(job.output, "segments.json")], meta: { model: (job.params.model as string) ?? "small", detectedLanguages: ["en"], flaggedCount: 1 }, encrypted: false };
          }
          throw new WorkerJobError("TOOL_FAILED", "the tool failed");
        },
        async resumePending() {
          return [];
        },
      } as unknown as WorkerClient;
      return {
        clientFor: () => client,
        versions: async () => ({ "yt-dlp": "2026.10.01", "gallery-dl": "1.30.0" }),
        updateTools: async () => {
          p.updates++;
          return { ytDlp: { old: "2026.10.01", new: "2026.11.01", managed: true }, galleryDl: { version: "1.30.0", pinned: true } };
        },
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

async function library(gov = CAPTURE_GOV): Promise<string> {
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: gov, encryption: { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id;
}

async function extensionToken(): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-capture-routes-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /projects/:id/acknowledge", () => {
  it("records the one-time browser-session acknowledgement; only kind cookies; listed on the project", async () => {
    await start();
    const pid = await library();
    expect((await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: { kind: "camera" } })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: {} })).status).toBe(400);
    expect((await call({ method: "POST", url: "/projects/01ZZZZZZZZZZZZZZZZZZZZZZZZ/acknowledge", body: { kind: "cookies" } })).status).toBe(404);
    const r = await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: { kind: "cookies" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ acknowledgements: ["cookies"] });
    // Again: the same answer (idempotent).
    expect((await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: { kind: "cookies" } })).json).toEqual({ acknowledgements: ["cookies"] });
    const projects = await call({ url: "/projects" });
    const listed = (projects.json.projects ?? projects.json).find((p: { id: string }) => p.id === pid);
    expect(listed.acknowledgements).toEqual(["cookies"]);
    // The extension cannot acknowledge for the researcher.
    const ext = await extensionToken();
    expect((await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: { kind: "cookies" }, noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } })).status).toBe(403);
  });
});

describe("POST /projects/:id/capture-profile", () => {
  it("validates its options; asks for the acknowledgement before using the browser session; queues and reports progress", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const pid = await library();
    const url = `/projects/${pid}/capture-profile`;
    const profile = "https://www.instagram.com/some.researcher/";
    for (const body of [
      {},
      { url: "ftp://example.com/x" },
      { url: profile, options: { since: "2026/01/01" } },
      { url: profile, options: { until: "yesterday" } },
      { url: profile, options: { maxItems: 0 } },
      { url: profile, options: { maxItems: 2.5 } },
      { url: profile, options: { contentTypes: ["stories"] } },
      { url: profile, options: { cookiesFromBrowser: "netscape" } },
      { url: profile, options: { transcribeModel: "huge" } },
    ]) {
      const r = await call({ method: "POST", url, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
    const needsAck = await call({ method: "POST", url, body: { url: profile, options: { cookiesFromBrowser: "firefox" } } });
    expect(needsAck.status).toBe(409);
    expect(needsAck.json.error).toMatchObject({ code: "ACKNOWLEDGEMENT_REQUIRED", reason: "cookies" });
    expect(worker.calls).toHaveLength(0);

    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const ok = await call({ method: "POST", url, body: { url: profile, options: { since: "2026-01-01", until: "2026-06-30", maxItems: 5, contentTypes: ["posts", "reels"], metadataOnly: true } } });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.queueId).toEqual(expect.any(String));
    await svc.state.idle();
    const mine = events.filter((e) => e.type === "capture.progress" && e.data.queueId === ok.json.queueId);
    expect(mine.at(-1)?.data).toMatchObject({ projectId: pid, finished: true });
    expect(worker.calls.length).toBeGreaterThan(0);
    expect(worker.calls[0]!.type).toBe("capture.download");

    // After the acknowledgement, the browser session may be used.
    await call({ method: "POST", url: `/projects/${pid}/acknowledge`, body: { kind: "cookies" } });
    expect((await call({ method: "POST", url, body: { url: profile, options: { cookiesFromBrowser: "firefox" } } })).status).toBe(200);
    await svc.state.idle();
  });

  it("a project whose rules do not allow the downloader: 403 POLICY_DENIED with the reason, nothing queued", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const pid = await library(`${GOV}captureMethods: [manual_upload]\n`);
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: "https://www.youtube.com/@channel" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect(typeof r.json.error.reason).toBe("string");
    expect(worker.calls).toHaveLength(0);
  });

  it("no media helper: 503 WORKER_UNAVAILABLE", async () => {
    await start();
    const pid = await library();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: "https://www.youtube.com/@channel" } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("WORKER_UNAVAILABLE");
  });
});

describe("POST /projects/:id/sources/:sid/transcribe", () => {
  async function audioSource(pid: string): Promise<string> {
    const dir = join(tmp, "in");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "talk.mp3"), Buffer.alloc(64, 1));
    const sf = await svc.state.session!.repo.createSource(
      pid,
      { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: join(dir, "talk.mp3"), role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    return sf.source.id;
  }

  it("transcribes a source's recording; the versions read back as segments with their flags", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    const pid = await library();
    const sid = await audioSource(pid);
    for (const body of [{ model: "huge" }, { language: "English" }]) {
      expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/01ZZZZZZZZZZZZZZZZZZZZZZZZ/transcribe`, body: {} })).status).toBe(404);
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "small", language: "en" } });
    expect(r.status, r.body).toBe(200);
    const job = worker.calls.find((c) => c.type === "audio.transcribe")!;
    expect(job.params).toMatchObject({ model: "small", language: "en" });
    const list = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse;
    expect(list.versions.map((v) => v.format).sort()).toEqual(["json", "vtt"]);
    for (const v of list.versions) {
      expect(v).toMatchObject({ origin: "machine", flaggedSegments: 1, tool: "faster-whisper" });
      const t = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts/${v.id}` })).json as TranscriptResponse;
      expect(t.segments).toEqual([
        { start: 0, end: 2, lang: "en", text: "Welcome to the market.", flags: [] },
        { start: 2, end: 4, lang: "en", text: "Thanks for watching!", flags: ["outside-speech", "stock-phrase"] },
      ]);
    }
  });

  it("a source without a recording: 400; no media helper: 503", async () => {
    await start({ worker: stubWorker(), autoStartWorker: false });
    const pid = await library();
    const sf = await svc.state.session!.repo.createSource(
      pid,
      { projectIds: [pid], type: "report", title: { variants: [{ lang: "en", kind: "original", value: "Paper" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sf.source.id}/transcribe`, body: {} });
    expect(r.status).toBe(400);
    await svc.close();
    await start();
    await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
    const sid = await audioSource(pid);
    const none = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    expect(none.status).toBe(503);
    expect(none.json.error.code).toBe("WORKER_UNAVAILABLE");
  });
});

describe("POST /tools/update and GET /tools/versions", () => {
  it("updates the capture tools through the media helper and reports old and new versions", async () => {
    const worker = stubWorker();
    await start({ worker, autoStartWorker: false });
    expect((await call({ url: "/tools/versions" })).json).toEqual({ versions: { "yt-dlp": "2026.10.01", "gallery-dl": "1.30.0" } });
    const r = await call({ method: "POST", url: "/tools/update" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ ytDlp: { old: "2026.10.01", new: "2026.11.01", managed: true }, galleryDl: { version: "1.30.0", pinned: true } });
    expect(worker.updates).toBe(1);
    // Not for the extension, and not without the token.
    const ext = await extensionToken();
    expect((await call({ method: "POST", url: "/tools/update", noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } })).status).toBe(403);
    expect((await call({ method: "POST", url: "/tools/update", noAuth: true })).status).toBe(401);
    expect(worker.updates).toBe(1);
  });

  it("no media helper: 503 WORKER_UNAVAILABLE", async () => {
    await start();
    const r = await call({ method: "POST", url: "/tools/update" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("WORKER_UNAVAILABLE");
  });

  it("a failed update is reported, not thrown as an unknown error", async () => {
    const worker = stubWorker();
    worker.start = (async () => ({
      clientFor: () => ({}) as WorkerClient,
      versions: async () => ({}),
      updateTools: async () => {
        throw new WorkerJobError("UPDATE_FAILED", "pip failed");
      },
      stop: async () => {},
    })) as typeof worker.start;
    await start({ worker, autoStartWorker: false });
    const r = await call({ method: "POST", url: "/tools/update" });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatchObject({ code: "INTERNAL", reason: "UPDATE_FAILED" });
  });
});
