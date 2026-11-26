/**
 * Whole channels (Task 7; R668, R669, R672, R679, R684): the project's transcription list, run by the service one
 * transcription at a time, with Pause, Continue and Stop; "Transcribe everything without a transcript"; the project's
 * automatic transcription switch; the background settings (keeping the Mac awake); and `background.progress` events.
 *
 * The media worker is a stand-in over HTTP behind the real worker client: each transcription is held until the test
 * releases it (or ends at once with `instant`). Every wait is for an event or for the service's own resting state
 * (`state.idle()`), never a timer.
 */
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Writable } from "node:stream";
import { WorkerClient, deviceDeps, type Deps, type WorkerToolsClient } from "@ao/library";
import { BACKGROUND_EVENT, transcriptionLines, type BackgroundProgressEvent, type CaptureEstimate, type TranscriptionListSummary } from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FAKE_TOOLS_DIR, startToolWorker, type SubmittedJob, type ToolWorker } from "../../../packages/library/src/capture/testing.js";
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
captureMethods: [manual_upload, downloader]
`;
const NO_TRANSCRIPTION = `${GOV.replace("processing:\n  metadata_lookup: []\n", "processing:\n  metadata_lookup: []\n  transcription: []\n")}`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let worker: StubWorker | undefined;
let logs = "";
let clock = new Date("2026-11-26T10:00:00.000Z");

// ---- the stand-in media worker ----

interface Run {
  id: string;
  type: string;
  output: string;
  params: Record<string, unknown>;
  released: boolean;
  cancelled: boolean;
}

interface StubWorker {
  runs: Run[];
  endpoint: { baseUrl: string; token: string };
  /** Every transcription ends at once. */
  instant: boolean;
  /** Resolves when the n-th job (1-based) has been posted. */
  posted(n: number): Promise<Run>;
  close(): Promise<void>;
}

async function stubWorker(): Promise<StubWorker> {
  const runs: Run[] = [];
  const waiting: Array<{ n: number; resolve: (r: Run) => void }> = [];
  const w: StubWorker = {
    runs,
    endpoint: { baseUrl: "", token: "stub-token" },
    instant: false,
    posted: (n) =>
      new Promise<Run>((resolve) => {
        if (runs.length >= n) resolve(runs[n - 1]!);
        else waiting.push({ n, resolve });
      }),
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
      const run: Run = { id: `w${runs.length + 1}`, type: body.type, output: body.output, params: body.params, released: w.instant, cancelled: false };
      runs.push(run);
      for (const x of waiting.splice(0)) {
        if (runs.length >= x.n) x.resolve(runs[x.n - 1]!);
        else waiting.push(x);
      }
      return send(202, { id: run.id });
    }
    const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(req.url ?? "");
    const run = runs.find((r) => r.id === m?.[1]);
    if (!run) return send(404, { error: { code: "NOT_FOUND", message: "no" } });
    if (m![2]) {
      run.cancelled = true;
      return send(202, { id: run.id, status: "running" });
    }
    if (run.cancelled) return send(200, { id: run.id, status: "cancelled" });
    if (!run.released && !w.instant) return send(200, { id: run.id, status: "running", progress: 0 });
    await mkdir(run.output, { recursive: true });
    await writeFile(join(run.output, "segments.json"), JSON.stringify([{ start: 0, end: 2, text: "Welcome.", lang: "en", flags: [] }]));
    await writeFile(join(run.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome.\n");
    return send(200, { id: run.id, status: "done", progress: 1, result: { output: run.output, meta: { model: run.params.model, detectedLanguages: ["en"], flaggedCount: 0 } } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  w.endpoint.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  w.close = () => new Promise<void>((r) => server.close(() => r()));
  return w;
}

function provider(w: { endpoint: { baseUrl: string; token: string } }, catalogue?: Array<{ id: string; installed: boolean }>): WorkerProvider {
  return {
    start: async () => ({
      clientFor: (repo, index) => new WorkerClient({ repo, worker: w.endpoint, pollMs: 5, ...(index ? { index } : {}) }),
      versions: async () => ({}),
      updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }),
      ...(catalogue ? { tools: { catalogue: async () => ({ platform: "linux-x64", tools: catalogue }) } as unknown as WorkerToolsClient } : {}),
      stop: async () => {},
    }),
  };
}

// ---- the service ----

let serviceOpts: Partial<ServiceOptions> = {};
async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  serviceOpts = {
    token: TOKEN,
    deps,
    worker: worker ? provider(worker) : null,
    autoStartWorker: true,
    closeGraceMs: 2_000,
    now: () => clock,
    logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }),
    pairing: { confirmPerMinute: 100 },
    ...over,
  };
  svc = await createService(serviceOpts as ServiceOptions);
  return svc;
}

/** A quit and a relaunch over the same library: the new service opens it and its media helper starts by itself. */
async function restart(): Promise<void> {
  await svc!.close();
  svc = await createService(serviceOpts as ServiceOptions);
  expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
}

async function call(r: { method?: "GET" | "POST" | "PUT"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean }) {
  const res = await svc!.app.inject({
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

async function project(opts: { encrypted?: boolean; gov?: string } = {}): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: opts.gov ?? GOV, encryption: opts.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

/** A source with a recording; `duration` is the platform's length of it, in seconds. */
async function audioSource(pid: string, title: string, duration?: number): Promise<string> {
  const dir = join(tmp, "in");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${title}.mp3`);
  await writeFile(file, Buffer.alloc(64, title.length));
  const sf = await svc!.state.session!.repo.createSource(
    pid,
    { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [{ path: file, role: "original", handling: "copy" }],
    {
      provenance: {
        captureMethod: "manual_upload", capturedAt: clock.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false,
        ...(duration !== undefined ? { platformSnapshot: { id: title, duration } } : {}),
      },
    },
  );
  return sf.source.id;
}

const list = async (pid: string): Promise<TranscriptionListSummary> => {
  const r = await call({ url: `/projects/${pid}/transcription-list` });
  expect(r.status, r.body).toBe(200);
  return r.json.list;
};
const listAct = (pid: string, what: "pause" | "continue" | "stop") => call({ method: "POST", url: `/projects/${pid}/transcription-list/${what}` });
const transcribeAll = (pid: string, body: unknown = {}) => call({ method: "POST", url: `/projects/${pid}/transcription-list`, body });
const transcripts = async (pid: string, sid: string) => ((await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as { versions: unknown[] }).versions.length;

/** Every event published from now on. */
function collect(): Array<{ type: string; data: any }> {
  const events: Array<{ type: string; data: any }> = [];
  const off = svc!.state.events.subscribe((e) => events.push(e));
  onTestFinished(() => off?.());
  return events;
}

/** Resolves with the first `background.progress` list of the project (from now on) that `pred` accepts. */
function listEvent(pid: string, pred: (l: TranscriptionListSummary) => boolean): Promise<TranscriptionListSummary> {
  return new Promise((resolve) => {
    const off = svc!.state.events.subscribe((e) => {
      if (e.type !== BACKGROUND_EVENT) return;
      const d = e.data as unknown as BackgroundProgressEvent;
      if (d.projectId === pid && d.transcriptions && pred(d.transcriptions)) {
        off?.();
        resolve(d.transcriptions);
      }
    });
    onTestFinished(() => off?.());
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-transcription-list-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  logs = "";
  clock = new Date("2026-11-26T10:00:00.000Z");
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (worker) worker.instant = true; // a held run ends, so the close need not wait out its grace period
  await svc?.close();
  svc = undefined;
  await worker?.close();
  worker = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe("transcribe everything without a transcript", () => {
  it("transcribe everything says how many and how many hours, then puts them on the list", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const a = await audioSource(pid, "Alpha", 600);
    const b = await audioSource(pid, "Beta", 1200);
    const c = await audioSource(pid, "Gamma");
    expect((await call({ url: `/projects/${pid}/untranscribed` })).json).toEqual({ count: 3, soundSeconds: 1800, unknownLengths: 1 });

    const events = collect();
    const r = await transcribeAll(pid, { model: "small" });
    expect(r.status, r.body).toBe(200);
    expect(r.json.added).toBe(3);
    expect(r.json.list).toMatchObject({ projectId: pid, state: "running", total: 3, done: 0, failed: 0 });
    // Published before the answer (R679): a screen that showed nothing learns of the list from its stream.
    expect(events.some((e) => e.type === BACKGROUND_EVENT && e.data.projectId === pid && e.data.transcriptions?.total === 3)).toBe(true);
    // On the list now: not counted again, not added again.
    expect((await call({ url: `/projects/${pid}/untranscribed` })).json).toEqual({ count: 0, soundSeconds: 0, unknownLengths: 0 });

    const finished = listEvent(pid, (l) => l.state === "idle" && l.done === 3);
    worker.instant = true;
    for (const run of worker.runs) run.released = true;
    expect(await finished).toMatchObject({ total: 3, done: 3, failed: 0 });
    await svc!.state.idle();
    expect(transcriptionLines(await list(pid)).title).toBe("Transcriptions finished: all 3 done.");
    expect(worker.runs.map((x) => x.params.model)).toEqual(["small", "small", "small"]);
    for (const sid of [a, b, c]) expect(await transcripts(pid, sid)).toBe(2);
    // Nothing is left without a transcript.
    expect((await transcribeAll(pid)).json).toMatchObject({ added: 0 });
  });

  it("transcribe everything is refused by the project's rules (403) and for a speech model that is not installed (409)", async () => {
    worker = await stubWorker();
    await start({ worker: provider(worker, [{ id: "speech-small", installed: false }, { id: "speech-medium", installed: true }]) });
    await openLibrary();
    const denied = await project({ gov: NO_TRANSCRIPTION });
    await audioSource(denied, "Alpha", 60);
    const r = await transcribeAll(denied);
    expect(r.status, r.body).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect((await list(denied)).total).toBe(0);

    const pid = await project();
    await audioSource(pid, "Beta", 60);
    const m = await transcribeAll(pid, { model: "small" });
    expect(m.status, m.body).toBe(409);
    expect(m.json.error).toMatchObject({ code: "TOOL_NOT_INSTALLED", reason: "speech-small" });
    expect((await list(pid)).total).toBe(0);
    expect((await transcribeAll(pid, { model: "enormous" })).status).toBe(400);
    expect(worker.runs).toHaveLength(0);
  });
});

describe("the transcription list", () => {
  it("the list transcribes one at a time in order and carries on by itself after a restart", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const ids = [await audioSource(pid, "One", 60), await audioSource(pid, "Two", 60), await audioSource(pid, "Three", 60)];
    expect((await transcribeAll(pid)).json.added).toBe(3);
    const first = await worker.posted(1);
    expect(worker.runs).toHaveLength(1);
    expect((await list(pid)).current).toMatchObject({ sourceId: ids[0], title: "One" });
    const second = worker.posted(2);
    first.released = true;
    await second;
    expect(worker.runs).toHaveLength(2);
    expect(await list(pid)).toMatchObject({ state: "running", total: 3, done: 1, current: { sourceId: ids[1], title: "Two" } });

    // A quit while the second is transcribed: after the relaunch it runs again, then the third, by themselves.
    await restart();
    const done = listEvent(pid, (l) => l.state === "idle" && l.done === 3);
    await worker.posted(3); // the second, run again after the relaunch
    expect((await list(pid)).current).toMatchObject({ sourceId: ids[1] });
    worker.instant = true;
    expect(await done).toMatchObject({ total: 3, done: 3, failed: 0 });
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(4);
    for (const sid of ids) expect(await transcripts(pid, sid)).toBe(2);
  });

  it("pause lets the transcription in hand finish and stays paused across a restart", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const one = await audioSource(pid, "One", 60);
    await audioSource(pid, "Two", 60);
    await transcribeAll(pid);
    const first = await worker.posted(1);
    const p = await listAct(pid, "pause");
    expect(p.status, p.body).toBe(200);
    expect(p.json.list).toMatchObject({ state: "paused", total: 2, done: 0 });
    const ended = listEvent(pid, (l) => l.done === 1);
    first.released = true;
    expect(await ended).toMatchObject({ state: "paused", done: 1, total: 2 });
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(1);
    expect(await transcripts(pid, one)).toBe(2);
    expect(transcriptionLines(await list(pid)).title).toBe("Transcriptions paused: 1 of 2 done.");
    await restart();
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(1);
    expect(await list(pid)).toMatchObject({ state: "paused", done: 1, total: 2 });
  });

  it("continue starts again", async () => {
    worker = await stubWorker();
    worker.instant = true;
    await start();
    await openLibrary();
    const pid = await project();
    await audioSource(pid, "One", 60);
    await audioSource(pid, "Two", 60);
    expect((await listAct(pid, "pause")).status).toBe(200);
    await transcribeAll(pid);
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(0);
    expect(await list(pid)).toMatchObject({ state: "paused", total: 2, done: 0 });
    const done = listEvent(pid, (l) => l.state === "idle" && l.done === 2);
    const c = await listAct(pid, "continue");
    expect(c.status, c.body).toBe(200);
    expect(c.json.list).toMatchObject({ state: "running", total: 2 });
    expect(await done).toMatchObject({ total: 2, done: 2, failed: 0 });
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(2);
  });

  it("stop empties the list and cancels the transcription in hand; the sources stay without transcripts", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const ids = [await audioSource(pid, "One", 60), await audioSource(pid, "Two", 60)];
    await transcribeAll(pid);
    const first = await worker.posted(1);
    const events = collect();
    const s = await listAct(pid, "stop");
    expect(s.status, s.body).toBe(200);
    expect(s.json.list).toMatchObject({ state: "idle", total: 0, done: 0, failed: 0 });
    expect(transcriptionLines(s.json.list)).toEqual({});
    expect(events.some((e) => e.type === BACKGROUND_EVENT && e.data.projectId === pid && e.data.transcriptions?.total === 0)).toBe(true);
    await svc!.state.idle();
    expect(first.cancelled).toBe(true);
    expect(worker.runs).toHaveLength(1);
    for (const sid of ids) expect(await transcripts(pid, sid)).toBe(0);
    expect((await call({ url: `/projects/${pid}/untranscribed` })).json.count).toBe(2);
    expect(await list(pid)).toMatchObject({ state: "idle", total: 0 });
    // A stop of an idle list is allowed and does only that (R679).
    const again = await listAct(pid, "stop");
    expect(again.status).toBe(200);
    expect(again.json.list).toMatchObject({ state: "idle", total: 0 });
  });

  it("a Stop that falls between starting a job and marking its entry leaves no job running and no entry on the list", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const sid = await audioSource(pid, "One", 60);
    const t = svc!.state.transcriptions;
    const real = t.start.bind(t);
    let stopped: Promise<unknown> | undefined;
    vi.spyOn(t, "start").mockImplementation(async (...args) => {
      const job = await real(...args);
      await worker!.posted(1);
      stopped = listAct(pid, "stop"); // answered before the loop marks the entry running
      await stopped;
      return job;
    });
    await transcribeAll(pid);
    await svc!.state.idle();
    expect(((await stopped) as { status: number }).status).toBe(200);
    expect(worker.runs).toHaveLength(1);
    expect(worker.runs[0]!.cancelled).toBe(true);
    const job = (await call({ url: `/projects/${pid}/sources/${sid}/transcription` })).json.job;
    expect(job.status).toBe("cancelled");
    expect(await list(pid)).toMatchObject({ state: "idle", total: 0, done: 0, failed: 0 });
    expect(svc!.state.transcriptionList.active()).toBe(false);
  });

  it("a source deleted before its turn is skipped and the list goes on", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    const one = await audioSource(pid, "One", 60);
    const two = await audioSource(pid, "Two", 60);
    const three = await audioSource(pid, "Three", 60);
    await transcribeAll(pid);
    const first = await worker.posted(1);
    await svc!.state.session!.repo.deleteSource(pid, two);
    const done = listEvent(pid, (l) => l.state === "idle" && l.total > 0);
    worker.instant = true;
    first.released = true;
    expect(await done).toMatchObject({ total: 2, done: 2, failed: 0 });
    await svc!.state.idle();
    expect(transcriptionLines(await list(pid)).title).toBe("Transcriptions finished: all 2 done.");
    expect(worker.runs).toHaveLength(2);
    expect(await transcripts(pid, one)).toBe(2);
    expect(await transcripts(pid, three)).toBe(2);
  });

  it("a lock stops the list at once and nothing more is transcribed; the unlock lets it carry on", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const one = await audioSource(pid, "Secret interview one", 60);
    const two = await audioSource(pid, "Secret interview two", 60);
    await transcribeAll(pid);
    const first = await worker.posted(1);
    expect(svc!.state.transcriptionList.memory()).toEqual([{ projectId: pid }]);
    const events = collect();
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    // Nothing of the locked project's list stays in the runner (R30, R50).
    expect(svc!.state.transcriptionList.memory()).toEqual([]);
    expect(svc!.state.transcriptionList.active()).toBe(false);
    first.released = true; // its store step finds the key gone: cancelled as locked, to run again at the unlock (R142)
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(1);
    expect((await call({ url: `/projects/${pid}/transcription-list` })).status).toBe(423);
    expect(JSON.stringify(events)).not.toMatch(/Secret interview/);
    expect(events.some((e) => e.type === BACKGROUND_EVENT)).toBe(false);

    const done = listEvent(pid, (l) => l.state === "idle" && l.done === 2);
    worker.instant = true;
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect(await done).toMatchObject({ total: 2, done: 2, failed: 0 });
    await svc!.state.idle();
    expect(worker.runs).toHaveLength(3); // the first run again, then the second
    expect(await transcripts(pid, one)).toBe(2);
    expect(await transcripts(pid, two)).toBe(2);
  });

  it("the speed is measured from what this Mac did and the time left follows; before the first, none is given", async () => {
    worker = await stubWorker();
    await start();
    await openLibrary();
    const pid = await project();
    await audioSource(pid, "One", 120);
    await audioSource(pid, "Two", 300);
    await audioSource(pid, "Three");
    await transcribeAll(pid);
    const first = await worker.posted(1);
    const before = await list(pid);
    expect(before).toMatchObject({ soundSecondsLeft: 420, unknownLeft: 1 });
    expect(before.soundPerSecond).toBeUndefined();
    expect(transcriptionLines(before).time).toBe("measuring…");
    // The first took a minute for two minutes of sound.
    const next = listEvent(pid, (l) => l.done === 1);
    clock = new Date(clock.getTime() + 60_000);
    first.released = true;
    const after = await next;
    expect(after).toMatchObject({ soundPerSecond: 2, soundSecondsLeft: 300, unknownLeft: 1 });
    expect(transcriptionLines(after).time).toBe("about 3 minutes left at this Mac's speed (2 minutes of sound per minute), not counting 1 recording of unknown length");

    // The estimate before a capture gives the measured speed of its speech model.
    vi.spyOn(svc!.state.downloads, "estimate").mockResolvedValue({
      kind: "profile", platform: "tiktok", title: "T", count: 1, alreadyInProject: 0, soundSeconds: 60, unknownLengths: 0, listComplete: true,
      freeBytes: null, diskName: null, videoToolsInstalled: null, speechModel: "medium", metadataOnly: false,
    } satisfies CaptureEstimate);
    const e = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: "https://www.tiktok.com/@fake.dancer" } });
    expect(e.status, e.body).toBe(200);
    expect(e.json.measuredSpeed).toBe(2);
    vi.mocked(svc!.state.downloads.estimate).mockResolvedValue({ ...(e.json as CaptureEstimate), measuredSpeed: undefined, speechModel: "small" } as CaptureEstimate);
    const unmeasured = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: "https://www.tiktok.com/@fake.dancer" } });
    expect(unmeasured.json.measuredSpeed).toBeUndefined();
  });
});

describe("a run with transcribe", () => {
  const savedEnv = { PATH: process.env.PATH, FAKE_PROFILE_FILE: process.env.FAKE_PROFILE_FILE };
  afterEach(() => {
    process.env.PATH = savedEnv.PATH;
    if (savedEnv.FAKE_PROFILE_FILE === undefined) delete process.env.FAKE_PROFILE_FILE;
    else process.env.FAKE_PROFILE_FILE = savedEnv.FAKE_PROFILE_FILE;
  });

  it("a run with transcribe feeds the list as each video is stored", async () => {
    const id = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
    const profileFile = join(tmp, "profile.json");
    writeFileSync(
      profileFile,
      JSON.stringify({
        platform: "tiktok", handle: "fake.dancer", displayName: "Fake Dancer", bio: "Synthetic test profile.", links: [], avatar: "https://p16.example/avatar.jpeg", followers: 1, following: 1,
        items: [3, 2, 1].map((n) => ({ id: id(n), caption: `Dance number ${n}`, timestamp: 1767312000 + n * 86400 })),
      }),
    );
    process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedEnv.PATH ?? ""}`;
    process.env.FAKE_PROFILE_FILE = profileFile;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let reach!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const tw: ToolWorker = await startToolWorker({
      beforeCapture: async (job: SubmittedJob) => {
        if (job.input.includes(`/video/${id(1)}`)) {
          reach();
          await gate;
        }
      },
    });
    onTestFinished(() => tw.close());
    await start({ worker: provider({ endpoint: { baseUrl: tw.baseUrl, token: tw.token } }), downloadSleep: async () => {}, downloadFreeBytes: async () => null });
    await openLibrary();
    const pid = await project();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url: "https://www.tiktok.com/@fake.dancer", options: { transcribe: true } } });
    expect(r.status, r.body).toBe(200);
    await reached;
    // The last video (listed newest first) is still being downloaded; the two stored before it get their transcripts
    // meanwhile: each is put on the list as it is stored, and the list drains (each end is a published event).
    const videos = async () => {
      const s = svc!.state.session!;
      const out: string[] = [];
      for (const sid of s.repo.listSourceIds(pid)) if ((await s.repo.getSource(pid, sid)).assets.some((a) => a.kind === "video")) out.push(sid);
      return out;
    };
    const stored = await videos();
    expect(stored).toHaveLength(2);
    for (;;) {
      const next = listEvent(pid, (l) => l.state === "idle"); // listened for before the check, so no end is missed
      const counts = await Promise.all(stored.map((sid) => transcripts(pid, sid)));
      if (counts.every((n) => n === 2)) break;
      await next;
    }
    expect(tw.submitted.filter((j) => j.type === "audio.transcribe")).toHaveLength(2);
    release();
    await svc!.state.idle();
    const all = await videos();
    expect(all).toHaveLength(3);
    for (const sid of all) expect(await transcripts(pid, sid)).toBe(2);
    expect(await list(pid)).toMatchObject({ state: "idle", failed: 0 });
    expect(tw.submitted.filter((j) => j.type === "audio.transcribe")).toHaveLength(3);
  });
});

describe("the switches", () => {
  it("the automation switch is read and saved", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    expect((await call({ url: `/projects/${pid}/automation` })).json).toEqual({ transcribeNewMedia: false });
    const put = await call({ method: "PUT", url: `/projects/${pid}/automation`, body: { transcribeNewMedia: true } });
    expect(put.status, put.body).toBe(200);
    expect(put.json).toEqual({ transcribeNewMedia: true });
    expect((await call({ url: `/projects/${pid}/automation` })).json).toEqual({ transcribeNewMedia: true });
    expect(svc!.state.session!.repo.getProject(pid).automation).toEqual({ transcribeNewMedia: true });
    const bad = await call({ method: "PUT", url: `/projects/${pid}/automation`, body: { transcribeNewMedia: "yes" } });
    expect(bad.status).toBe(400);
    expect((await call({ url: `/projects/${pid}/automation` })).json).toEqual({ transcribeNewMedia: true });
    // Audited as a change of the project.
    const s = svc!.state.session!;
    const dir = join(s.lib.root, s.repo.getProject(pid).folder, "audit");
    const { readdir } = await import("node:fs/promises");
    let ops = "";
    for (const f of await readdir(dir)) ops += await readFile(join(dir, f), "utf8");
    expect(ops).toContain('"op":"project.automation"');
  });

  it("background settings default to keeping awake and are saved", async () => {
    await start();
    expect((await call({ url: "/settings/background" })).json).toEqual({ keepAwake: true });
    const put = await call({ method: "PUT", url: "/settings/background", body: { keepAwake: false } });
    expect(put.status, put.body).toBe(200);
    expect(put.json).toEqual({ keepAwake: false });
    expect((await call({ url: "/settings/background" })).json).toEqual({ keepAwake: false });
    expect(JSON.parse(await readFile(join(tmp, "config", "background.json"), "utf8"))).toEqual({ keepAwake: false });
    expect((await call({ method: "PUT", url: "/settings/background", body: { keepAwake: 1 } })).status).toBe(400);
    // Read again by the next run of the service.
    await svc!.close();
    await start();
    expect((await call({ url: "/settings/background" })).json).toEqual({ keepAwake: false });
  });

  it("every new route refuses a locked project with 423 and the extension token with 403", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const locked: Array<{ method: "GET" | "POST"; url: string; body?: unknown }> = [
      { method: "GET", url: `/projects/${pid}/transcription-list` },
      { method: "POST", url: `/projects/${pid}/transcription-list/pause` },
      { method: "POST", url: `/projects/${pid}/transcription-list/continue` },
      { method: "POST", url: `/projects/${pid}/transcription-list/stop` },
      { method: "GET", url: `/projects/${pid}/untranscribed` },
      { method: "POST", url: `/projects/${pid}/transcription-list`, body: {} },
    ];
    const all: Array<{ method: "GET" | "POST" | "PUT"; url: string; body?: unknown }> = [
      ...locked,
      { method: "GET", url: `/projects/${pid}/automation` },
      { method: "PUT", url: `/projects/${pid}/automation`, body: { transcribeNewMedia: true } },
      { method: "GET", url: "/settings/background" },
      { method: "PUT", url: "/settings/background", body: { keepAwake: false } },
    ];
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = c.json().token as string;
    for (const r of all) {
      const fromExt = await call({ ...r, noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } });
      expect(fromExt.status, r.url).toBe(403);
    }
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    for (const r of locked) {
      const res = await call(r);
      expect(res.status, r.url).toBe(423);
      expect(res.json.error.code).toBe("PROJECT_LOCKED");
    }
    // Locked: refused before the body is even read.
    expect((await call({ method: "POST", url: `/projects/${pid}/transcription-list`, body: { model: "enormous" } })).status).toBe(423);
  });
});
