/**
 * Task 62: transcription as a job (R99, R142, R106) and N-5 (a close stops the rerun of interrupted
 * jobs), against the real worker client and a stand-in media worker over HTTP.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerClient, WorkerUnavailableError, deviceDeps, type Deps, type WorkerToolsClient } from "@ao/library";
import type { TranscriptListResponse, TranscriptionJob, TranscriptResponse } from "@ao/shared";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";
import { workerClientFor } from "./state.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const PASS = "correct horse battery staple";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let worker: StubWorker | undefined;

interface WorkerRun {
  id: string;
  type: string;
  output: string;
  params: Record<string, unknown>;
  polls: number;
  cancelled: boolean;
}

/**
 * A stand-in media worker. A transcription reports progress 0.25, 0.5, 0.75 on its polls and is done
 * once `release()` has been called (or at once with `instant`); its outputs are written at the end.
 * `postDelayMs` delays accepting each job (a rerun of many jobs takes a while).
 */
interface StubWorker {
  runs: WorkerRun[];
  endpoint: { baseUrl: string; token: string };
  release(): void;
  instant: boolean;
  postDelayMs: number;
  /** The progress each poll adds (default 0.25, up to 0.75; with a step set, up to 0.99). */
  progressStep?: number;
  failWith?: { code: string; message: string; tool?: string };
  onPost?: (run: WorkerRun) => void;
  close(): Promise<void>;
}

async function stubWorker(): Promise<StubWorker> {
  const runs: WorkerRun[] = [];
  let released = false;
  const w: StubWorker = {
    runs,
    endpoint: { baseUrl: "", token: "stub-token" },
    release: () => {
      released = true;
    },
    instant: false,
    postDelayMs: 0,
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/jobs") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type: string; output: string; params: Record<string, unknown> };
      const run: WorkerRun = { id: `w${runs.length + 1}`, type: body.type, output: body.output, params: body.params, polls: 0, cancelled: false };
      runs.push(run);
      w.onPost?.(run);
      if (w.postDelayMs) await new Promise((r) => setTimeout(r, w.postDelayMs));
      return send(202, { id: run.id });
    }
    const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(req.url ?? "");
    const run = runs.find((r) => r.id === m?.[1]);
    if (!run) return send(404, { error: { code: "NOT_FOUND", message: "no" } });
    if (m![2]) {
      run.cancelled = true;
      return send(202, { id: run.id, status: "running" });
    }
    run.polls++;
    if (run.cancelled) return send(200, { id: run.id, status: "cancelled", progress: 0.5 });
    if (w.failWith) return send(200, { id: run.id, status: "failed", error: w.failWith });
    if (!w.instant && (!released || run.polls < 3)) return send(200, { id: run.id, status: "running", progress: w.progressStep ? Math.min(0.99, run.polls * w.progressStep) : Math.min(0.75, run.polls * 0.25) });
    if (run.type === "audio.transcribe") {
      await mkdir(run.output, { recursive: true });
      await writeFile(join(run.output, "segments.json"), JSON.stringify([{ start: 0, end: 2, text: "Welcome.", lang: "en", flags: ["outside-speech"] }]));
      await writeFile(join(run.output, "transcript.vtt"), "WEBVTT\n\nNOTE flags: outside-speech\n\n00:00:00.000 --> 00:00:02.000\nWelcome.\n");
      return send(200, { id: run.id, status: "done", progress: 1, result: { output: run.output, meta: { model: run.params.model, detectedLanguages: ["en"], flaggedCount: 1 } } });
    }
    await mkdir(join(run.output, ".."), { recursive: true });
    await writeFile(run.output, "jpeg");
    return send(200, { id: run.id, status: "done", progress: 1, result: { output: run.output, meta: {} } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  w.endpoint.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  w.close = () => new Promise<void>((r) => server.close(() => r()));
  return w;
}

/** The service's worker: the real client over the stand-in; `catalogue` is the optional tools' list, when given. */
function provider(w: StubWorker, catalogue?: Array<{ id: string; installed: boolean }>): WorkerProvider {
  return {
    start: async () => ({
      clientFor: (repo, index) => workerClientFor(WorkerClient, w.endpoint, repo, index),
      versions: async () => ({}),
      updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }),
      ...(catalogue ? { tools: { catalogue: async () => ({ platform: "linux-x64", tools: catalogue }) } as unknown as WorkerToolsClient } : {}),
      stop: async () => {},
    }),
  };
}

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }), pairing: { confirmPerMinute: 100 }, ...over });
  return svc;
}

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
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

async function library(encrypted = false): Promise<{ pid: string; folder: string }> {
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return { pid: r.json.project.id as string, folder: r.json.project.folder as string };
}

async function audioSource(pid: string): Promise<string> {
  const dir = join(tmp, "in");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "talk.mp3"), Buffer.alloc(64, 1));
  const sf = await svc!.state.session!.repo.createSource(
    pid,
    { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [{ path: join(dir, "talk.mp3"), role: "original", handling: "copy" }],
    { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
  );
  return sf.source.id;
}

const stateOf = async (pid: string, sid: string) => (await call({ url: `/projects/${pid}/sources/${sid}/transcription` })).json.job as TranscriptionJob | null;
async function until(fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const journal = (folder: string) => readFile(join(tmp, "Lib", ...folder.split("/"), "jobs", "journal.jsonl")).catch(() => Buffer.alloc(0));

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-transcription-jobs-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  worker?.release(); // a run still going ends, so the close need not wait out its grace period
  await svc?.close();
  svc = undefined;
  await worker?.close();
  worker = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe("transcription as a job (Task 62)", () => {
  it("answers at once with a job; progress arrives as job events; the state is read again; the transcript is stored when it is done", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    const events: Array<Record<string, any>> = [];
    svc!.state.events.subscribe((e) => {
      if (e.type === "job.progress" && (e.data as { kind?: string }).kind === "transcription") events.push(e.data as Record<string, any>);
    });
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "small", language: "en" } });
    expect(r.status, r.body).toBe(202);
    const job = r.json.job as TranscriptionJob;
    expect(job).toMatchObject({ projectId: pid, sourceId: sid, model: "small", status: "queued" });
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
    // The stand-in answers 0.25, 0.5, then 0.75 on every later poll until released: 0.5 is only passed through, so the
    // wait is for the rest at 0.75; the 50 of 100 on the way is asserted among the events.
    await until(async () => (await stateOf(pid, sid))?.progress === 0.75);
    expect(await stateOf(pid, sid)).toMatchObject({ jobId: job.jobId, status: "running", progress: 0.75 });
    expect(events.some((e) => e.job.status === "running" && e.done === 50 && e.total === 100 && e.jobId === job.jobId)).toBe(true);
    expect(events.some((e) => e.job.status === "running" && e.done === 75 && e.total === 100 && e.jobId === job.jobId)).toBe(true);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    const done = (await stateOf(pid, sid))!;
    expect(done.result?.flaggedSegments).toBe(1);
    const list = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse;
    expect(list.versions.map((v) => v.path).sort()).toEqual([...done.result!.files].sort());
    expect(events.at(-1)).toMatchObject({ finished: true, job: { status: "done" } });
    expect(worker.runs[0]!.params).toEqual({ model: "small", language: "en" });
    expect(JSON.stringify(events)).not.toContain(tmp); // no absolute path reaches the interface
  });

  it("one transcription per source: a second request while one is queued or running is refused in plain words; two at once start one", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    const both = await Promise.all([1, 2].map(() => call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })));
    expect(both.map((x) => x.status).sort()).toEqual([202, 409]);
    const refused = both.find((x) => x.status === 409)!;
    expect(refused.json.error).toMatchObject({ code: "CONFLICT", reason: "TRANSCRIPTION_RUNNING" });
    expect(refused.json.error.message).toMatch(/already being transcribed/i);
    await until(() => worker!.runs.length === 1);
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(409);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(2);
  });

  it("the run can be cancelled: the worker stops, the job is recorded cancelled, and the source can be transcribed again", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid, folder } = await library();
    const sid = await audioSource(pid);
    const { jobId } = (await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).json.job as TranscriptionJob;
    await until(() => worker!.runs.length === 1);
    const c = await call({ method: "POST", url: `/projects/${pid}/transcriptions/${jobId}/cancel` });
    expect(c.status, c.body).toBe(200);
    await until(async () => (await stateOf(pid, sid))?.status === "cancelled");
    expect((await stateOf(pid, sid))?.error).toMatchObject({ code: "CANCELLED" });
    expect(worker.runs[0]!.cancelled).toBe(true);
    const last = (await journal(folder)).toString("utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(last)).toMatchObject({ id: jobId, status: "cancelled", error: "CANCELLED" });
    expect((await call({ method: "POST", url: `/projects/${pid}/transcriptions/00000000-0000-4000-8000-000000000000/cancel` })).status).toBe(404);
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
  });

  it("the state is read again after a restart, from the journal; the run left unfinished runs once more at the next open and is stored once", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, closeGraceMs: 100 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    const { jobId } = (await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "tiny" } })).json.job as TranscriptionJob;
    await until(async () => (await stateOf(pid, sid))?.status === "running");
    await svc!.close(); // the run is interrupted: it stays pending in the journal
    svc = undefined;
    expect(worker.runs[0]!.cancelled).toBe(true);
    // A service without a media helper reads the state from the journal.
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    expect(await stateOf(pid, sid)).toMatchObject({ jobId, status: "queued", waiting: true, model: "tiny" }); // M2: waiting to run again
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(409); // it will run again
    await svc!.close();
    // With the media helper, it runs again once and is stored once.
    worker.release();
    await start({ worker: provider(worker), autoStartWorker: true });
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs.map((r) => r.params.model)).toEqual(["tiny", "tiny"]);
    const list = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse;
    expect(list.versions).toHaveLength(2);
  });

  it("a missing speech model gives the missing-tool answer: refused at the start when the tools list says so, else the job carries the same answer", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker, [{ id: "speech-small", installed: false }, { id: "speech-medium", installed: true }]), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "small" } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "TOOL_NOT_INSTALLED", reason: "speech-small" });
    expect(worker.runs).toHaveLength(0);
    expect(await stateOf(pid, sid)).toBeNull();
    // The worker says so itself (no tools list): the job fails with the same code and the tool's id.
    worker.failWith = { code: "TOOL_NOT_INSTALLED", message: "Speech model: medium is not installed.", tool: "speech-medium" };
    worker.instant = true;
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: { model: "medium" } })).status).toBe(202);
    await until(async () => (await stateOf(pid, sid))?.status === "failed");
    expect((await stateOf(pid, sid))!.error).toEqual({ code: "TOOL_NOT_INSTALLED", message: expect.stringMatching(/not installed/), reason: "speech-medium" });
  });

  it("a lock before the run starts cancels it as locked (R142); it runs once at the unlock", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid } = await library(true);
    const sid = await audioSource(pid);
    worker.instant = true;
    worker.onPost = (run) => {
      if (run.id === "w1") svc!.state.session!.repo.lockProject(pid);
    };
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && svc!.state.workKinds().length === 0);
    expect((await stateOf(pid, sid).catch(() => null)) ?? null).toBeNull(); // locked: nothing is shown (423)
    expect((await call({ url: `/projects/${pid}/sources/${sid}/transcription` })).status).toBe(423);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs.filter((r) => !r.cancelled)).toHaveLength(1);
  });

  it("a human edit read back through the service carries the stored flags", async () => {
    worker = await stubWorker();
    worker.instant = true;
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    const list = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse;
    const vtt = list.versions.find((v) => v.format === "vtt")!;
    const saved = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcripts`, body: { format: "vtt", basedOn: vtt.id, text: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome.\n\n00:00:02.000 --> 00:00:03.000\nMore.\n" } });
    expect(saved.status, saved.body).toBe(200);
    const t = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts/${saved.json.id}` })).json as TranscriptResponse;
    expect(t.flagsStored).toBe(true);
    expect(t.segments.map((s) => [s.edit, s.flags])).toEqual([
      ["unchanged", ["outside-speech"]],
      ["added", null],
    ]);
  });
});

describe("fix round 1", () => {
  const FORBID = `${GOV}  transcription: []\n`;
  const denies = async (pid: string) =>
    (await svc!.state.session!.repo.readAudit(pid, { limit: 1000 })).events.filter((e) => e.decision?.result === "deny" && (e.details as { op?: string } | undefined)?.op === "worker.audio.transcribe").length;
  async function setRules(pid: string, yaml: string) {
    const repo = svc!.state.session!.repo;
    const g = await repo.getGovernance(pid);
    await repo.setGovernance(pid, yaml, { baseSha256: g.sha256, reason: "test" });
  }

  it("I1: a transcription the rules forbid is refused at the start: 403 with the reason, audited, no job", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid, folder } = await library();
    const sid = await audioSource(pid);
    await setRules(pid, FORBID);
    const r = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    expect(r.status, r.body).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect(r.json.error.message).toMatch(/rules do not allow/);
    expect(await denies(pid)).toBe(1);
    expect((await journal(folder)).length).toBe(0);
    expect(await stateOf(pid, sid)).toBeNull();
    expect(worker.runs).toHaveLength(0);
  });

  it("I3: a rerun the rules refuse ends for good: refused once over three launches, read back with its reason, the source free again", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, closeGraceMs: 100 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(async () => (await stateOf(pid, sid))?.status === "running");
    await svc!.close(); // interrupted: pending
    await start({ worker: provider(worker), autoStartWorker: false });
    await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
    await setRules(pid, FORBID);
    await svc!.close();
    for (let i = 0; i < 3; i++) {
      await start({ worker: provider(worker), autoStartWorker: true });
      await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
      await until(() => !!svc!.state.session?.workerClient);
      await svc!.state.idle();
      const job = await stateOf(pid, sid);
      expect(job, `launch ${i}`).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
      expect(job!.error!.message).toMatch(/rules do not allow/);
      if (i < 2) await svc!.close();
    }
    expect(await denies(pid)).toBe(1);
    expect(worker.runs).toHaveLength(1); // only the interrupted first run
    // The source is free: a new start is refused at the start, for the same reason, not as "already running".
    const again = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    expect(again.status).toBe(403);
    expect(await denies(pid)).toBe(2);
    await setRules(pid, GOV);
    worker.release();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(async () => (await stateOf(pid, sid))?.status === "done");
  });

  async function encryptedRun() {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true });
    const { pid } = await library(true);
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    const versions = async () => ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    const unlock = async () => expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    return { pid, sid, versions, unlock };
  }

  it("I2: a lock while the worker runs: cancelled as locked, nothing stored; at the unlock it runs once and one version is stored", async () => {
    const { pid, sid, versions, unlock } = await encryptedRun();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    svc!.state.session!.repo.lockProject(pid);
    worker!.release();
    await until(() => svc!.state.workKinds().length === 0);
    expect(worker!.runs).toHaveLength(1);
    await unlock();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker!.runs).toHaveLength(2);
    expect(await versions()).toBe(2); // one run: its WebVTT and its segments file
  });

  it("I2: a lock at the moment of the store step: cancelled as locked; at the unlock it runs once and is stored once", async () => {
    const { pid, sid, versions, unlock } = await encryptedRun();
    worker!.instant = true;
    const repo = svc!.state.session!.repo;
    const original = repo.addDerivedAssets.bind(repo);
    let first = true;
    repo.addDerivedAssets = (async (...args: Parameters<typeof original>) => {
      if (first) {
        first = false;
        repo.lockProject(pid);
      }
      return original(...args);
    }) as typeof original;
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => svc!.state.workKinds().length === 0);
    expect(worker!.runs).toHaveLength(1);
    await unlock();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker!.runs).toHaveLength(2);
    expect(await versions()).toBe(2);
  });

  it("I2: lock, unlock, lock, unlock in quick succession, and a restart: the run happens once and is stored once", async () => {
    const { pid, sid, versions, unlock } = await encryptedRun();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    const repo = svc!.state.session!.repo;
    repo.lockProject(pid);
    worker!.release();
    await until(() => svc!.state.workKinds().length === 0);
    await unlock();
    repo.lockProject(pid);
    await unlock();
    await svc!.state.idle();
    await svc!.close();
    await start({ worker: provider(worker!), autoStartWorker: true });
    await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
    await unlock();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker!.runs.filter((r) => !r.cancelled).length).toBeGreaterThanOrEqual(2);
    expect(await versions()).toBe(2); // stored exactly once
  });

  it("R1-2: a lock removes everything the registry holds of the project; the run is rerun once at the unlock from the journal; another project's run goes on", async () => {
    const { pid, sid, versions, unlock } = await encryptedRun();
    // A second, unencrypted project with its own run.
    const other = await call({ method: "POST", url: "/projects", body: { name: "Other", governanceYaml: GOV, encryption: { enabled: false } } });
    const pid2 = other.json.project.id as string;
    const sid2 = await audioSource(pid2);
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    expect((await call({ method: "POST", url: `/projects/${pid2}/sources/${sid2}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 2);
    const held = () => JSON.stringify([...((svc!.state.transcriptions as unknown as { live: Map<string, unknown> }).live.values())]);
    expect(held()).toContain(sid);
    const ends: Array<Record<string, unknown>> = [];
    svc!.state.events.subscribe((e) => {
      if (e.type === "job.progress" && (e.data as { kind?: string }).kind === "transcription") ends.push(e.data as Record<string, unknown>);
    });
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(held()).not.toContain(pid);
    expect(held()).not.toContain(sid);
    expect(held()).toContain(sid2); // the other project's run is still followed
    worker!.release();
    await until(() => svc!.state.workKinds().length === 0);
    expect(held()).not.toContain(pid); // its end added nothing back
    // ... but its end is marked by a bare event (the job's id only), so an open viewer reads the journal again.
    const bare = ends.filter((e) => e.job === undefined && e.finished === true);
    expect(bare.length).toBeGreaterThan(0);
    for (const e of bare) expect(JSON.stringify(e)).not.toContain(sid);
    expect((await stateOf(pid2, sid2))?.status).toBe("done");
    await unlock();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(await versions()).toBe(2);
    expect(worker!.runs.filter((r) => r.type === "audio.transcribe")).toHaveLength(3); // pid twice (cancelled-locked, rerun), pid2 once
  });

  it("R1-3: Stop on a run waiting for the unlock that this service still holds cancels it in the journal", async () => {
    const { pid, sid } = await encryptedRun();
    worker!.instant = true;
    const repo = svc!.state.session!.repo;
    worker!.onPost = () => repo.lockProject(pid); // locked by the repository itself, not the lock route
    const { jobId } = (await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).json.job as TranscriptionJob;
    await until(() => svc!.state.workKinds().length === 0);
    await repo.unlockProject(pid, PASS); // no rerun: not the unlock route
    expect((await stateOf(pid, sid))?.error?.code).toBe("PROJECT_LOCKED");
    const c = await call({ method: "POST", url: `/projects/${pid}/transcriptions/${jobId}/cancel` });
    expect(c.status, c.body).toBe(200);
    expect(c.json.job).toMatchObject({ status: "cancelled", error: { code: "CANCELLED" } });
    expect(await stateOf(pid, sid)).toMatchObject({ status: "cancelled", error: { code: "CANCELLED" } });
  });

  it("R1-2: a move forgets every entry of the library; the state is read again from the journal", async () => {
    worker = await stubWorker();
    worker.instant = true;
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    const held = () => (svc!.state.transcriptions as unknown as { live: Map<string, unknown> }).live.size;
    expect(held()).toBe(1);
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    expect(held()).toBe(0);
    expect((await stateOf(pid, sid))?.status).toBe("done"); // from the journal
  });

  it("FR-385: a move during a running transcription stops it at once, moves the library, and carries the run on there: stored once", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, suspendTimeoutMs: 2_000 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    expect(worker.runs[0]!.cancelled).toBe(true);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs.filter((r) => r.type === "audio.transcribe" && !r.cancelled)).toHaveLength(1);
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2); // one run: its WebVTT and its segments file
  });

  it("R466 I1: a second move while the run the first move carried on is going stops it too, at once: the move goes through, and the run is carried on again: stored once", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, suspendTimeoutMs: 1_500 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).body).toContain('"done":true');
    // The run carried on in the moved library (a rerun of pending jobs) is going.
    await until(() => worker!.runs.length === 2 && worker!.runs[1]!.polls > 0);
    expect(svc!.state.workKinds()).toContain("worker-resume");
    const second = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved2") } });
    expect(second.status, second.body).toBe(200);
    expect(second.body).toContain('"done":true');
    expect(worker.runs[1]!.cancelled).toBe(true);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs.filter((r) => r.type === "audio.transcribe" && !r.cancelled)).toHaveLength(1);
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2);
  });

  it("R466 M1: a move refused because other work could not pause does not stop the transcription: it carries on, one run, stored once", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, suspendTimeoutMs: 300 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    let free!: () => void;
    const stuck = svc!.state.startWork("stuck", () => new Promise<void>((r) => (free = r)));
    try {
      const refused = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
      expect(refused.status).toBe(409);
    } finally {
      free();
      await stuck;
    }
    expect(worker.runs[0]!.cancelled).toBe(false);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(1);
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2);
  });

  it("R503 l (FR-733): a move refused at its own plan (a destination that is not empty) does not stop the transcription: the move's usual answer, one run, stored once", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, suspendTimeoutMs: 2_000 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    const dest = join(tmp, "Full");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "notes.txt"), "someone else's file");
    const refused = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    // The move's usual answer for a destination it may not use: a line of its stream, the stream's 200.
    expect(refused.status).toBe(200);
    const lines = refused.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines.at(-1)).toEqual({ error: { code: "POLICY_DENIED", message: "The library cannot be moved there.", reason: expect.stringContaining("not empty") } });
    expect(refused.body).not.toContain('"done":true');
    expect(refused.body).not.toContain(tmp);
    expect(await readdir(dest)).toEqual(["notes.txt"]);
    // The refusal is kept as the last failed move, as before.
    expect((await call({ url: "/libraries/move/status" })).json).toMatchObject({ running: false, failed: { error: { code: "POLICY_DENIED" } } });
    expect(worker.runs[0]!.cancelled).toBe(false);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(1);
    expect(worker.runs[0]!.cancelled).toBe(false);
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2); // one run: its WebVTT and its segments file
  });

  it("R503 l (FR-733): an accepted plan stops the transcription before the first byte is copied (as before)", async () => {
    worker = await stubWorker();
    let atCopy: { cancelled: boolean; destThere: boolean } | undefined;
    const dest = () => join(tmp, "Moved");
    await start({
      worker: provider(worker),
      autoStartWorker: true,
      suspendTimeoutMs: 2_000,
      beforeExecuteMove: async () => {
        atCopy = { cancelled: worker!.runs[0]!.cancelled, destThere: await readdir(dest()).then(() => true, () => false) };
      },
    });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: dest() } })).body).toContain('"done":true');
    expect(atCopy).toEqual({ cancelled: true, destThere: false });
  });

  it("R503 l (FR-733): a transcription that FINISHES between the plan and the stop is moved with the library: the move copies what is there after the stop, not a stale list", async () => {
    worker = await stubWorker();
    let pid = "";
    let sid = "";
    let between = false;
    await start({
      worker: provider(worker),
      autoStartWorker: true,
      suspendTimeoutMs: 2_000,
      // Between the plan's acceptance and the stop: the run finishes and its transcript is stored in the library.
      afterMovePlan: async () => {
        between = true;
        worker!.release();
        await until(async () => (await stateOf(pid, sid))?.status === "done");
      },
    });
    ({ pid } = await library());
    sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(between).toBe(true);
    expect(moved.body).toContain('"done":true');
    // Nothing was left to stop; the run happened once, and its transcript is in the moved library.
    expect(worker.runs).toHaveLength(1);
    expect(worker.runs[0]!.cancelled).toBe(false);
    expect(svc!.state.session!.lib.root).toBe(join(tmp, "Moved"));
    await svc!.state.idle();
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2);
    expect(worker.runs).toHaveLength(1);
  });

  it("FR-385 (R466 M1): a move that fails after it stopped the transcription starts the run again in the library still open: stored once", async () => {
    worker = await stubWorker();
    await start({
      worker: provider(worker),
      autoStartWorker: true,
      suspendTimeoutMs: 2_000,
      beforeExecuteMove: async () => {
        throw new Error("the copy could not start");
      },
    });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(() => worker!.runs.length === 1 && worker!.runs[0]!.polls > 0);
    const failed = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(failed.body).toContain('"error"');
    expect(worker.runs[0]!.cancelled).toBe(true);
    await until(() => worker!.runs.length === 2);
    worker.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker.runs.filter((r) => r.type === "audio.transcribe" && !r.cancelled)).toHaveLength(1);
    const versions = ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse).versions.length;
    expect(versions).toBe(2);
  });

  it("M7: a close during a live transcription does not wait out the grace period", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker!), autoStartWorker: false });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(() => worker!.runs.length === 1);
    const t0 = Date.now();
    await svc!.state.closeLibrary();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(worker.runs[0]!.cancelled).toBe(true);
  });

  it("M2: a run pending in the journal and not running now reads as waiting to run again", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: true, closeGraceMs: 100 });
    const { pid } = await library();
    const sid = await audioSource(pid);
    await until(() => !!svc!.state.session?.workerClient);
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(async () => (await stateOf(pid, sid))?.status === "running");
    await svc!.close();
    await start();
    await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } });
    expect(await stateOf(pid, sid)).toMatchObject({ status: "queued", waiting: true });
  });

  it("R466 M6 (FR-392): a run that goes on after a lock and an unlock is shown as running, and the jobs indicator follows it again", async () => {
    const { pid, sid, versions, unlock } = await encryptedRun();
    worker!.progressStep = 0.01;
    const seen: Array<Record<string, unknown>> = [];
    svc!.state.events.subscribe((e) => {
      if (e.type === "job.progress" && (e.data as { kind?: string }).kind === "transcription") seen.push(e.data as Record<string, unknown>);
    });
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} })).status).toBe(202);
    await until(async () => (await stateOf(pid, sid))?.status === "running");
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    await unlock();
    // The worker's run went on through the lock (its own copy of the key): it is running, not waiting.
    expect(worker!.runs).toHaveLength(1);
    expect(worker!.runs[0]!.cancelled).toBe(false);
    const job = await stateOf(pid, sid);
    expect(job?.status).toBe("running");
    expect(job?.waiting).toBeUndefined();
    // The next progress it reports reaches the jobs indicator with the job again.
    const from = seen.length;
    await until(() => seen.slice(from).some((e) => (e.job as { status?: string } | undefined)?.status === "running"));
    worker!.release();
    await until(async () => (await stateOf(pid, sid))?.status === "done");
    await svc!.state.idle();
    expect(worker!.runs).toHaveLength(1);
    expect(await versions()).toBe(2);
  });

  it("M10: while the project is locked, events carry nothing of its job", async () => {
    const { pid, sid } = await encryptedRun();
    const seen: Array<Record<string, unknown>> = [];
    svc!.state.events.subscribe((e) => {
      if (e.type === "job.progress" && (e.data as { kind?: string }).kind === "transcription") seen.push(e.data as Record<string, unknown>);
    });
    await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcribe`, body: {} });
    await until(() => worker!.runs.length === 1 && seen.length > 0);
    svc!.state.session!.repo.lockProject(pid);
    const from = seen.length;
    worker!.release();
    await until(() => svc!.state.workKinds().length === 0);
    for (const e of seen.slice(from)) {
      expect(e.job).toBeUndefined();
      expect(JSON.stringify(e)).not.toContain(sid);
    }
  });
});

describe("N-5: a close stops the rerun of interrupted jobs", () => {
  it("a close in the middle of a rerun of many jobs: nothing is written after it returns, the rest run once at the next open, and it does not wait 30 s", async () => {
    worker = await stubWorker();
    worker.instant = true;
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid, folder } = await library();
    // Eight jobs left pending: submitted while the worker could not be reached.
    const repo = svc!.state.session!.repo;
    const down = new WorkerClient({ repo, worker: { baseUrl: "http://127.0.0.1:9", token: "x" }, index: svc!.state.session!.index!, pollMs: 5 });
    // Job paths inside the library (R379).
    const input = join(tmp, "Lib", "test-files", "a.png");
    await mkdir(dirname(input), { recursive: true });
    await writeFile(input, "png");
    for (let i = 0; i < 8; i++) {
      await expect(down.submit(pid, { type: "image.proxy", input, output: join(tmp, "Lib", ".tmp", "test-files", "out", `${i}.jpg`), params: {} })).rejects.toBeInstanceOf(WorkerUnavailableError);
    }
    await svc!.close();
    worker.postDelayMs = 300;
    await start({ worker: provider(worker), autoStartWorker: true });
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    await until(() => worker!.runs.length >= 2);
    const t0 = Date.now();
    await svc!.state.closeLibrary();
    const took = Date.now() - t0;
    const after = await journal(folder);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await journal(folder)).equals(after)).toBe(true); // not one byte after the close returned
    expect(took).toBeLessThan(10_000);
    const ranBefore = worker.runs.length;
    expect(ranBefore).toBeLessThan(8);
    const newest = new Map<string, { status: string }>();
    for (const l of after.toString("utf8").split("\n").filter(Boolean)) newest.set(JSON.parse(l).id, JSON.parse(l));
    expect([...newest.values()].filter((r) => r.status === "done")).toHaveLength(ranBefore); // the job in hand finished
    expect([...newest.values()].filter((r) => r.status === "queued")).toHaveLength(8 - ranBefore);
    // The next open reruns each of the rest exactly once.
    worker.postDelayMs = 0;
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    await until(() => worker!.runs.length === 8);
    await svc!.state.idle();
    await new Promise((r) => setTimeout(r, 200));
    expect(worker.runs).toHaveLength(8);
    expect(new Set(worker.runs.map((r) => r.output)).size).toBe(8);
  });

  it("a rerun job still running when the close's grace ends is abandoned: it stays pending and nothing is written after the close", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker), autoStartWorker: false });
    const { pid, folder } = await library();
    const repo = svc!.state.session!.repo;
    const down = new WorkerClient({ repo, worker: { baseUrl: "http://127.0.0.1:9", token: "x" }, index: svc!.state.session!.index!, pollMs: 5 });
    // Job paths inside the library (R379).
    const input = join(tmp, "Lib", "test-files", "a.png");
    await mkdir(dirname(input), { recursive: true });
    await writeFile(input, "png");
    await expect(down.submit(pid, { type: "image.proxy", input, output: join(tmp, "Lib", ".tmp", "test-files", "out", "x.jpg"), params: {} })).rejects.toBeInstanceOf(WorkerUnavailableError);
    await svc!.close();
    await start({ worker: provider(worker), autoStartWorker: true, closeGraceMs: 200 });
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    await until(() => worker!.runs.length === 1);
    await svc!.state.closeLibrary(); // the worker never finishes this one on its own
    const after = await journal(folder);
    expect(worker.runs[0]!.cancelled).toBe(true);
    worker.release();
    await new Promise((r) => setTimeout(r, 500));
    expect((await journal(folder)).equals(after)).toBe(true);
    const lines = after.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { status: string });
    expect(lines.at(-1)!.status).toBe("running"); // pending: it runs again at the next open
  });
});
