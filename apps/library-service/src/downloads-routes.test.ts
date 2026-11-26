/**
 * The service runs the downloads (whole channels, Task 5; R668, R669, R679, R680): a channel, playlist or
 * profile pasted on the Capture screen becomes a download run written to the project's job journal, held by
 * the service's DownloadRunner, one run of a project downloading at a time (a second one waits its turn),
 * with Pause, Stop, Resume downloads, Discard, "Show them", the estimate, and `background.progress` events.
 *
 * The media worker is the library's in-process stand-in (packages/library/src/capture/testing.ts), running
 * the fake yt-dlp (tests/fixtures/fake-tools) over synthetic TikTok profiles; every wait between downloads
 * goes through the injected sleep, and the free space through the injected freeBytes.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Writable } from "node:stream";
import type { AuditEvent } from "@ao/core";
import { InvalidInputError, WorkerClient, WorkerJobError, deviceDeps, plainReason, type Deps, type DownloadRuns, type WorkerToolsClient } from "@ao/library";
import {
  RUN_ALREADY_RUNNING,
  RUN_ALREADY_RUNNING_TEXT,
  RUN_NOT_RUNNING_TEXT,
  VIDEO_TOOLS_NEEDED_TEXT,
  estimateRateLimitedText,
  type DownloadRunSummary,
} from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_TOOLS_DIR, startToolWorker, type SubmittedJob, type ToolWorker } from "../../../packages/library/src/capture/testing.js";
import { downloadFreeBytesFromEnv } from "./downloads.js";
import { TOOL_NOT_INSTALLED_TEXT } from "./errors.js";
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
const T0 = 1767312000;

/** Two synthetic TikTok profiles the fake yt-dlp lists and downloads (switched by the handle in each job's address). */
const A = "https://www.tiktok.com/@fake.dancer";
const B = "https://www.tiktok.com/@other.dancer";
const idA = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
const idB = (n: number) => `72000000000000000${String(n).padStart(2, "0")}`;
interface Item {
  id: string;
  caption: string;
  timestamp: number;
  duration?: number;
  error?: "private" | "removed";
}
const profile = (handle: string, displayName: string, id: (n: number) => string, n = 3) => ({
  platform: "tiktok",
  handle,
  displayName,
  bio: "Synthetic test profile. Nothing here is real.",
  links: [],
  avatar: "https://p16.example/avatar.jpeg",
  followers: 1200,
  following: 34,
  // newest first, as platforms list them
  items: Array.from({ length: n }, (_, i): Item => ({ id: id(n - i), caption: `Dance number ${n - i} at the market`, timestamp: T0 + (n - i) * 86400 })),
});
type Profile = ReturnType<typeof profile>;

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let tw: ToolWorker;
let profileFile: string;
let profiles: Record<string, Profile>;
/** The addresses the fake yt-dlp was asked for, in order, with markers the tests add ("END …"). */
let runLog: string[];
let logs: string;
/** Downloads held back until released (all released after each test). */
let holds: Array<{ pred: (j: SubmittedJob) => boolean; used: boolean; reach: () => void; gate: Promise<void> }>;
const releases: Array<() => void> = [];
const savedEnv = { PATH: process.env.PATH, FAKE_PROFILE_FILE: process.env.FAKE_PROFILE_FILE, FAKE_TOOL_MODE: process.env.FAKE_TOOL_MODE };

/** Holds the first download `pred` matches until released; `reached` resolves when it is asked of the platform. */
function hold(pred: (j: SubmittedJob) => boolean): { reached: Promise<void>; release(): void } {
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  releases.push(open);
  holds.push({ pred, used: false, reach, gate });
  return { reached, release: open };
}
const itemOf = (id: string) => (j: SubmittedJob) => j.input.includes(`/video/${id}`);

async function beforeCapture(job: SubmittedJob): Promise<void> {
  const handle = /@([\w.]+)/.exec(job.input)?.[1];
  if (handle && profiles[handle]) writeFileSync(profileFile, JSON.stringify(profiles[handle]));
  runLog.push(job.input);
  for (const h of holds) {
    if (h.used || !h.pred(job)) continue;
    h.used = true;
    h.reach();
    await h.gate;
  }
}

function provider(opts: { ffmpeg?: boolean } = {}): WorkerProvider {
  const tools = opts.ffmpeg === undefined ? undefined : ({ catalogue: async () => ({ platform: "linux-x64", tools: [{ id: "ffmpeg", installed: opts.ffmpeg }] }) } as unknown as WorkerToolsClient);
  return {
    async start() {
      return {
        clientFor: (repo, index) => new WorkerClient({ repo, worker: { baseUrl: tw.baseUrl, token: tw.token }, pollMs: 5, ...(index ? { index } : {}) }),
        versions: async () => ({}),
        updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }),
        ...(tools ? { tools } : {}),
        stop: async () => {},
      };
    },
  };
}

let serviceOpts: Partial<ServiceOptions> = {};
async function start(over: Partial<ServiceOptions> = {}, worker: { ffmpeg?: boolean } = {}): Promise<void> {
  serviceOpts = {
    token: TOKEN,
    deps,
    worker: provider(worker),
    autoStartWorker: false,
    closeGraceMs: 2_000,
    logStream: new Writable({ write: (c, _e, cb) => ((logs += c.toString()), cb()) }),
    pairing: { confirmPerMinute: 100 },
    downloadSleep: async () => {},
    downloadFreeBytes: async () => null,
    ...over,
  };
  svc = await createService(serviceOpts as ServiceOptions);
}

async function call(r: { method?: "GET" | "POST" | "PUT"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean }) {
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
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function openLibrary(): Promise<void> {
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
}

async function project(opts: { encrypted?: boolean; gov?: string } = {}): Promise<string> {
  const gov = opts.gov ?? GOV;
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: gov, encryption: opts.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id;
}

/** The service closed and started again over the same library (a quit and a relaunch). */
async function restart(): Promise<void> {
  await svc.close();
  svc = await createService(serviceOpts as ServiceOptions);
  expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
}

/** Closes the service while a download is held: the close cuts the run, then the held download is let go. */
async function restartWhileHeld(release: () => void): Promise<void> {
  const runner = svc.state.downloads;
  const stop = runner.stopProject.bind(runner);
  let cut!: () => void;
  const wasCut = new Promise<void>((r) => (cut = r));
  vi.spyOn(runner, "stopProject").mockImplementation((p, why) => {
    stop(p, why);
    if (why === "close") cut();
  });
  const closing = svc.close();
  await wasCut;
  release();
  await closing;
  svc = await createService(serviceOpts as ServiceOptions);
  expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
}

const captureProfile = (pid: string, url: string, options?: Record<string, unknown>) => call({ method: "POST", url: `/projects/${pid}/capture-profile`, body: { url, ...(options ? { options } : {}) } });
const runs = async (pid: string): Promise<DownloadRunSummary[]> => {
  const r = await call({ url: `/projects/${pid}/downloads` });
  expect(r.status, r.body).toBe(200);
  return r.json.runs;
};
const runOf = async (pid: string, runId: string) => (await runs(pid)).find((r) => r.runId === runId);
const act = (pid: string, runId: string, what: "pause" | "stop" | "resume" | "discard") => call({ method: "POST", url: `/projects/${pid}/downloads/${runId}/${what}` });
const itemDownloads = () => tw.submitted.filter((j) => j.type === "capture.download" && !j.params.flatList).map((j) => /\/video\/(\d+)/.exec(j.input)?.[1]);

async function auditOps(pid: string): Promise<string[]> {
  const s = svc.state.session!;
  const dir = join(s.lib.root, s.repo.getProject(pid).folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  return out.filter((e) => e.action === "capture" && e.decision?.result === "allow").map((e) => String((e.details as { op?: string } | undefined)?.op));
}

function collect(): Array<{ type: string; data: any }> {
  const events: Array<{ type: string; data: any }> = [];
  svc.state.events.subscribe((e) => events.push(e));
  return events;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-downloads-routes-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  profileFile = join(tmp, "profile.json");
  profiles = { "fake.dancer": profile("fake.dancer", "Fake Dancer", idA), "other.dancer": profile("other.dancer", "Other Dancer", idB) };
  writeFileSync(profileFile, JSON.stringify(profiles["fake.dancer"]));
  process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedEnv.PATH ?? ""}`;
  process.env.FAKE_PROFILE_FILE = profileFile;
  delete process.env.FAKE_TOOL_MODE;
  runLog = [];
  logs = "";
  holds = [];
  tw = await startToolWorker({ beforeCapture });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of releases.splice(0)) r();
  await svc?.close();
  await tw?.close();
  process.env.PATH = savedEnv.PATH;
  if (savedEnv.FAKE_PROFILE_FILE === undefined) delete process.env.FAKE_PROFILE_FILE;
  else process.env.FAKE_PROFILE_FILE = savedEnv.FAKE_PROFILE_FILE;
  if (savedEnv.FAKE_TOOL_MODE === undefined) delete process.env.FAKE_TOOL_MODE;
  else process.env.FAKE_TOOL_MODE = savedEnv.FAKE_TOOL_MODE;
  await rm(tmp, { recursive: true, force: true });
});

describe("the estimate", () => {
  it("capture-estimate answers the counts, the lengths, the free space and whether Video tools are installed", async () => {
    profiles["fake.dancer"]!.items[0]!.duration = 600;
    profiles["fake.dancer"]!.items[1]!.duration = 1200;
    await start({ downloadFreeBytes: async () => 50_000_000_000 }, { ffmpeg: true });
    await openLibrary();
    const pid = await project();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A, options: { quality: "720p" } } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({
      kind: "profile",
      platform: "tiktok",
      count: 3,
      alreadyInProject: 0,
      soundSeconds: 1800,
      unknownLengths: 1,
      listComplete: true,
      freeBytes: 50_000_000_000,
      diskName: null,
      videoToolsInstalled: true,
      speechModel: "medium",
      metadataOnly: false,
    });
    // Nothing was downloaded: only the list was read, and no run was written.
    expect(itemDownloads()).toEqual([]);
    expect(await runs(pid)).toEqual([]);
  });

  it("capture-estimate of a project whose rules forbid the downloader is 403 with the rule's reason, and nothing is listed", async () => {
    await start();
    await openLibrary();
    const pid = await project({ gov: GOV.replace("captureMethods: [manual_upload, downloader]", "captureMethods: [manual_upload]") });
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect(typeof r.json.error.reason).toBe("string");
    expect(r.json.error.reason.length).toBeGreaterThan(0);
    expect(tw.submitted).toHaveLength(0);
  });

  it("a slowed-down listing is 429 RATE_LIMITED in plain words; Video tools not known is null", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatchObject({ code: "RATE_LIMITED", message: estimateRateLimitedText("tiktok") });
    delete process.env.FAKE_TOOL_MODE;
    const ok = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.videoToolsInstalled).toBeNull();
  });
});

describe("the estimate says what happened (R687 C)", () => {
  it("a lock during the estimate's listing is 423 and no title is answered", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    // The listing has come back (the channel's title is known); the lock falls before the answer.
    let reach!: () => void;
    const listed = new Promise<void>((r) => (reach = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    releases.push(open);
    vi.spyOn(svc.state.downloads, "videoToolsInstalled").mockImplementation(async () => {
      reach();
      await gate;
      return null;
    });
    const estimating = call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    await listed;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    open();
    const r = await estimating;
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe("PROJECT_LOCKED");
    expect(r.body).not.toMatch(/Fake Dancer|fake\.dancer/);
  });

  it("a listing that fails for another reason answers the capture's own plain sentence", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    for (const [mode, code] of [
      ["login", "LOGIN_REQUIRED"],
      ["notfound", "NOT_FOUND_OR_REMOVED"],
    ] as const) {
      process.env.FAKE_TOOL_MODE = mode;
      const r = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
      expect(r.status, r.body).toBe(502);
      expect(r.json.error).toEqual({ code: "INTERNAL", message: plainReason(code), reason: code });
    }
  });

  it("a missing tool is 409 TOOL_NOT_INSTALLED: with its id when the listing names it, in general words when it does not", async () => {
    await tw.close();
    tw = await startToolWorker({ beforeCapture, missing: ["video-downloader"] });
    await start();
    await openLibrary();
    const pid = await project();
    const named = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    expect(named.status).toBe(409);
    expect(named.json.error).toEqual({ code: "TOOL_NOT_INSTALLED", message: TOOL_NOT_INSTALLED_TEXT, reason: "video-downloader" });
    vi.spyOn(svc.state.downloads, "estimate").mockRejectedValue(new WorkerJobError("TOOL_NOT_INSTALLED", plainReason("TOOL_NOT_INSTALLED")));
    const general = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } });
    expect(general.status).toBe(409);
    expect(general.json.error).toEqual({ code: "TOOL_NOT_INSTALLED", message: TOOL_NOT_INSTALLED_TEXT });
  });

  it("an estimate with an unknown quality is 400 in plain words, and nothing is listed", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A, options: { quality: "4k" } } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe('"4k" is not a quality.');
    expect(tw.submitted).toHaveLength(0);
  });
});

describe("a run started from capture-profile", () => {
  it("capture-profile starts a journaled run; background.progress and capture.progress events follow it to the end", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const events = collect();
    const r = await captureProfile(pid, A);
    expect(r.status, r.body).toBe(200);
    const runId = r.json.queueId as string;
    await svc.state.idle();
    const mine = events.filter((e) => e.type === "background.progress" && e.data.downloads?.runId === runId).map((e) => e.data.downloads as DownloadRunSummary);
    // The first event as soon as the run's record exists (R679), the last at its end.
    expect(mine[0]).toMatchObject({ projectId: pid, url: A, state: "queued", total: 0 });
    expect(mine.at(-1)).toMatchObject({ state: "finished", total: 3, done: 3, failed: 0, notCompleted: 0, title: "Fake Dancer" });
    for (const e of events.filter((x) => x.type === "background.progress")) expect(e.data.projectId).toBe(pid);
    // The Capture screen's queue is fed as before (scenario 10).
    const queue = events.filter((e) => e.type === "capture.progress" && e.data.queueId === runId);
    expect(queue.filter((e) => e.data.outcome).map((e) => e.data.outcome.status)).toEqual(["created", "created", "created"]);
    expect(queue.at(-1)!.data).toMatchObject({ finished: true, report: { status: "completed", created: 3 } });
    expect((await call({ url: `/projects/${pid}/captures/${runId}` })).json).toMatchObject({ kind: "profile", url: A, finished: true });
    // Journaled: read again from the job journal.
    expect(await runs(pid)).toEqual([expect.objectContaining({ runId, state: "finished", done: 3, transcribe: false })]);
    expect(itemDownloads()).toEqual([idA(3), idA(2), idA(1)]);
    expect(svc.state.downloads.held(runId)).toBe(false);
  });

  it("a run with transcribe left out follows the project's automation switch", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    // Off by default: the run does not transcribe.
    const off = await captureProfile(pid, A, { maxItems: 1 });
    expect(off.status, off.body).toBe(200);
    await svc.state.idle();
    expect((await runOf(pid, off.json.queueId))?.transcribe).toBe(false);
    // The project's switch on (its setter is Task 7's: the project as the library reads it).
    const repo = svc.state.session!.repo;
    const getProject = repo.getProject.bind(repo);
    vi.spyOn(repo, "getProject").mockImplementation((id: string) => {
      const p = getProject(id);
      return id === pid ? { ...p, automation: { transcribeNewMedia: true } } : p;
    });
    const queued: string[] = [];
    svc.state.downloads.onQueuedForTranscription = (p, sid) => void (p === pid && queued.push(sid));
    const on = await captureProfile(pid, B);
    expect(on.status, on.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, on.json.queueId)).toMatchObject({ transcribe: true, state: "finished", done: 3 });
    expect(queued).toHaveLength(3);
    // Said explicitly, the request wins over the switch.
    profiles["other.dancer"] = profile("other.dancer", "Other Dancer", idB, 4);
    const no = await captureProfile(pid, B, { transcribe: false });
    expect(no.status, no.body).toBe(200);
    await svc.state.idle();
    expect((await runOf(pid, no.json.queueId))?.transcribe).toBe(false);
    expect(queued).toHaveLength(3);
  });

  it("a second channel while one downloads waits its turn and starts by itself when the first has finished", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const events = collect();
    const first = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    expect(a.status, a.body).toBe(200);
    await first.reached;
    expect(svc.state.downloads.active()).toBe(true);
    const b = await captureProfile(pid, B);
    expect(b.status, b.body).toBe(200);
    const aId = a.json.queueId as string;
    const bId = b.json.queueId as string;
    expect(await runOf(pid, bId)).toMatchObject({ state: "queued", total: 0 });
    expect(svc.state.downloads.held(bId)).toBe(true);
    events.length = 0;
    svc.state.events.subscribe((e) => {
      const run = (e.data as { downloads?: DownloadRunSummary }).downloads;
      if (e.type === "background.progress" && run?.runId === aId && run.state === "finished") runLog.push("END A");
    });
    first.release();
    await svc.state.idle();
    // Nothing of the second address was asked of the platform before the first run ended.
    const end = runLog.indexOf("END A");
    expect(end).toBeGreaterThan(0);
    expect(runLog.slice(0, end).some((u) => u.includes("other.dancer"))).toBe(false);
    expect(runLog.slice(end).some((u) => u.includes("other.dancer"))).toBe(true);
    expect(await runOf(pid, aId)).toMatchObject({ state: "finished", done: 3 });
    expect(await runOf(pid, bId)).toMatchObject({ state: "finished", done: 3, title: "Other Dancer" });
    expect(svc.state.downloads.active()).toBe(false);
  });

  it("a paused or stopped first run lets the next one begin", async () => {
    await start();
    await openLibrary();
    for (const what of ["pause", "stop"] as const) {
      const pid = await project();
      runLog.length = 0;
      const first = hold(itemOf(idA(2)));
      const a = await captureProfile(pid, A);
      const aId = a.json.queueId as string;
      await first.reached;
      const b = await captureProfile(pid, B);
      expect(b.status, b.body).toBe(200);
      const ended = what === "pause" ? "paused" : "stopped";
      const off = svc.state.events.subscribe((e) => {
        const run = (e.data as { downloads?: DownloadRunSummary }).downloads;
        if (e.type === "background.progress" && run?.runId === aId && run.state === ended) runLog.push("END A");
      });
      expect((await act(pid, aId, what)).status).toBe(200);
      first.release();
      await svc.state.idle();
      off();
      expect(await runOf(pid, aId)).toMatchObject({ state: ended, done: 2 });
      expect(await runOf(pid, b.json.queueId)).toMatchObject({ state: "finished", done: 3 });
      // Nothing of the second address was asked of the platform before the first run paused or stopped.
      const end = runLog.indexOf("END A");
      expect(end).toBeGreaterThan(0);
      expect(runLog.slice(0, end).some((u) => u.includes("other.dancer"))).toBe(false);
      expect(runLog.slice(end).some((u) => u.includes("other.dancer"))).toBe(true);
    }
  });

  it("Stop on a run waiting its turn takes it out of the queue with nothing asked of the platform; Pause on it is 409 in plain words", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const first = hold(itemOf(idA(1)));
    const a = await captureProfile(pid, A);
    await first.reached;
    const b = await captureProfile(pid, B);
    const bId = b.json.queueId as string;
    const pause = await act(pid, bId, "pause");
    expect(pause.status).toBe(409);
    expect(pause.json.error).toMatchObject({ code: "CONFLICT", message: RUN_NOT_RUNNING_TEXT });
    const stop = await act(pid, bId, "stop");
    expect(stop.status, stop.body).toBe(200);
    expect(stop.json.run).toMatchObject({ runId: bId, state: "stopped", total: 0 });
    expect(svc.state.downloads.held(bId)).toBe(false);
    first.release();
    await svc.state.idle();
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "finished" });
    expect(await runOf(pid, bId)).toMatchObject({ state: "stopped", total: 0 });
    expect(runLog.some((u) => u.includes("other.dancer"))).toBe(false);
    // Pause of a run nothing holds is refused the same way.
    expect((await act(pid, bId, "pause")).json.error).toMatchObject({ code: "CONFLICT", message: RUN_NOT_RUNNING_TEXT });
  });

  it("the same address started while its run is held is 409 RUN_ALREADY_RUNNING in plain words", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const first = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await first.reached;
    expect((await act(pid, runId, "stop")).status).toBe(200);
    first.release();
    await svc.state.idle();
    // Resumed: held again (its first start's capture queue has ended, so this is the run's own refusal).
    const again = hold(itemOf(idA(1)));
    const resumed = await act(pid, runId, "resume");
    expect(resumed.status, resumed.body).toBe(200);
    await again.reached;
    for (const url of [A, "https://tiktok.com/@fake.dancer?lang=en"]) {
      const r = await captureProfile(pid, url);
      expect(r.status).toBe(409);
      expect(r.json.error).toEqual({ code: "CONFLICT", message: RUN_ALREADY_RUNNING_TEXT, reason: RUN_ALREADY_RUNNING });
    }
    expect((await act(pid, runId, "resume")).json.error).toEqual({ code: "CONFLICT", message: RUN_ALREADY_RUNNING_TEXT, reason: RUN_ALREADY_RUNNING });
    expect((await act(pid, runId, "discard")).json.error).toEqual({ code: "CONFLICT", message: RUN_ALREADY_RUNNING_TEXT, reason: RUN_ALREADY_RUNNING });
    again.release();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
  });

  it("a quality that needs Video tools is 409 TOOL_NOT_INSTALLED ffmpeg when the catalogue says they are missing", async () => {
    await start({}, { ffmpeg: false });
    await openLibrary();
    const pid = await project();
    for (const quality of ["best", "720p", "1080p", "audio"]) {
      const r = await captureProfile(pid, A, { quality });
      expect(r.status).toBe(409);
      expect(r.json.error).toEqual({ code: "TOOL_NOT_INSTALLED", message: VIDEO_TOOLS_NEEDED_TEXT, reason: "ffmpeg" });
    }
    const bad = await captureProfile(pid, A, { quality: "4k" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe('"4k" is not a quality.');
    expect(tw.submitted).toHaveLength(0);
    expect(await runs(pid)).toEqual([]);
    const ready = await captureProfile(pid, A, { quality: "ready" });
    expect(ready.status, ready.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, ready.json.queueId)).toMatchObject({ quality: "ready", state: "finished" });
  });
});

describe("capture-profile says what happened (R687 C)", () => {
  it("a run started without a quality on a computer without Video tools downloads: no quality is passed on", async () => {
    await tw.close();
    tw = await startToolWorker({ beforeCapture, ffmpeg: false });
    await start({}, { ffmpeg: false });
    await openLibrary();
    const pid = await project();
    const r = await captureProfile(pid, A);
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, r.json.queueId)).toMatchObject({ state: "finished", done: 3 });
    expect(itemDownloads()).toEqual([idA(3), idA(2), idA(1)]);
    expect(tw.submitted.filter((j) => j.type === "capture.download").every((j) => j.params.quality === undefined)).toBe(true);
  });

  it("a link the runs refuse (a single post, another site) is 400 in plain words before any capture or run exists", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    for (const url of [`https://www.tiktok.com/@fake.dancer/video/${idA(1)}`, "https://example.com/somebody"]) {
      const r = await captureProfile(pid, url);
      expect(r.status, url).toBe(400);
      expect(r.json.error).toEqual({ code: "VALIDATION", message: plainReason("UNSUPPORTED_URL") });
    }
    expect((await call({ url: `/projects/${pid}/captures` })).json.queues).toEqual([]);
    expect(await runs(pid)).toEqual([]);
    expect(tw.submitted).toHaveLength(0);
  });
});

describe("after a restart (R668)", () => {
  it("after a restart the run is shown interrupted and nothing is downloaded until Resume downloads", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    await restartWhileHeld(held.release);
    const asked = tw.submitted.length;
    expect(await runOf(pid, runId)).toMatchObject({ state: "interrupted", total: 3, done: 1, notCompleted: 2 });
    await svc.state.idle();
    expect(tw.submitted).toHaveLength(asked);
    expect(svc.state.downloads.held(runId)).toBe(false);
  });

  it("Resume downloads after a restart carries on where it stopped, audits one capture.profile.resume and asks the rules again", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    await restartWhileHeld(held.release);
    const before = itemDownloads().length;
    const events = collect();
    const r = await act(pid, runId, "resume");
    expect(r.status, r.body).toBe(200);
    expect(r.json.run).toMatchObject({ runId, state: "downloading" });
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", total: 3, done: 3 });
    // Carried on where it stopped: the video in hand at the quit and the one after it.
    expect(itemDownloads().slice(before)).toEqual([idA(2), idA(1)]);
    expect((await auditOps(pid)).filter((op) => op === "capture.profile.resume")).toHaveLength(1);
    expect(events.filter((e) => e.type === "background.progress" && e.data.downloads?.runId === runId).at(-1)!.data.downloads).toMatchObject({ state: "finished" });
    // Asked again: with the rules now forbidding the downloader, a Resume is refused with their reason.
    const pid2 = await project();
    const held2 = hold(itemOf(idA(2)));
    const a2 = await captureProfile(pid2, A);
    await held2.reached;
    await restartWhileHeld(held2.release);
    const g = await call({ url: `/projects/${pid2}/governance` });
    const put = await call({ method: "PUT", url: `/projects/${pid2}/governance`, body: { yaml: GOV.replace("captureMethods: [manual_upload, downloader]", "captureMethods: [manual_upload]"), reason: "no more downloads" }, headers: { "if-match": String(g.headers.etag) } });
    expect(put.status, put.body).toBe(200);
    const denied = await act(pid2, a2.json.queueId, "resume");
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("POLICY_DENIED");
    expect(typeof denied.json.error.reason).toBe("string");
  });

  it("two presses of Resume downloads start one run and audit one decision", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    await restartWhileHeld(held.release);
    const again = hold(itemOf(idA(2)));
    const [one, two] = await Promise.all([act(pid, runId, "resume"), act(pid, runId, "resume")]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect((one.status === 409 ? one : two).json.error).toEqual({ code: "CONFLICT", message: RUN_ALREADY_RUNNING_TEXT, reason: RUN_ALREADY_RUNNING });
    again.release();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect((await auditOps(pid)).filter((op) => op === "capture.profile.resume")).toHaveLength(1);
  });

  it("after a restart a run that was waiting its turn is shown interrupted before it began, and starts only on Resume downloads", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    await held.reached;
    const b = await captureProfile(pid, B);
    const bId = b.json.queueId as string;
    await restartWhileHeld(held.release);
    expect(await runOf(pid, bId)).toMatchObject({ state: "interrupted", total: 0 });
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "interrupted" });
    await svc.state.idle();
    expect(runLog.some((u) => u.includes("other.dancer"))).toBe(false);
    const r = await act(pid, bId, "resume");
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, bId)).toMatchObject({ state: "finished", total: 3, done: 3 });
    // The other run was not touched by that press.
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "interrupted" });
  });

  it("pause stays paused across a restart", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    const p = await act(pid, runId, "pause");
    expect(p.status, p.body).toBe(200);
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "paused", done: 2, notCompleted: 1 });
    const asked = tw.submitted.length;
    await restart();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "paused", done: 2, notCompleted: 1 });
    expect(tw.submitted).toHaveLength(asked);
  });
});

describe("around a Resume (R687)", () => {
  /** Holds the next request for the media helper (inside a Resume's awaits) until released. */
  function holdWorkerClient(): { reached: Promise<void>; release(): void } {
    const orig = svc.state.workerClient.bind(svc.state);
    let reach!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    releases.push(open);
    let used = false;
    vi.spyOn(svc.state, "workerClient").mockImplementation(async () => {
      if (!used) {
        used = true;
        reach();
        await gate;
      }
      return orig();
    });
    return { reached, release: open };
  }
  /** The library's download runs as the runner makes them, with `resume` replaced. */
  function wrapLibraryResume(resume: (real: DownloadRuns["resume"], ...args: Parameters<DownloadRuns["resume"]>) => ReturnType<DownloadRuns["resume"]>): void {
    const runner = svc.state.downloads as unknown as { library: (s: unknown, w: unknown) => DownloadRuns };
    const lib = runner.library.bind(runner);
    vi.spyOn(runner, "library").mockImplementation((s, w) => {
      const real = lib(s, w);
      return { ...real, resume: (...args: Parameters<DownloadRuns["resume"]>) => resume(real.resume.bind(real), ...args) };
    });
  }
  /** A run stopped after its second video (one still to do). */
  async function stoppedRun(pid: string): Promise<string> {
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    await held.reached;
    expect((await act(pid, a.json.queueId, "stop")).status).toBe(200);
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "stopped", done: 2 });
    return a.json.queueId as string;
  }
  const conflict = { code: "CONFLICT", message: RUN_ALREADY_RUNNING_TEXT, reason: RUN_ALREADY_RUNNING };

  it("a Resume of a run whose address another held run is downloading is 409 in plain words; the platform is asked once", async () => {
    profiles["fake.dancer"]!.items[1]!.error = "private";
    await start();
    await openLibrary();
    const pid = await project();
    const first = await captureProfile(pid, A);
    await svc.state.idle();
    const oldId = first.json.queueId as string;
    expect(await runOf(pid, oldId)).toMatchObject({ state: "finished", failed: 1 });
    // The same channel started again: a newer run of the address is held.
    const held = hold(itemOf(idA(2)));
    const again = await captureProfile(pid, A);
    expect(again.status, again.body).toBe(200);
    await held.reached;
    const listings = () => runLog.filter((u) => u.includes("fake.dancer") && !u.includes("/video/")).length;
    const listed = listings();
    const r = await act(pid, oldId, "resume");
    expect(r.status).toBe(409);
    expect(r.json.error).toEqual(conflict);
    expect(svc.state.downloads.held(oldId)).toBe(false);
    held.release();
    await svc.state.idle();
    expect(listings()).toBe(listed);
    expect(runLog.filter((u) => u.includes(`/video/${idA(2)}`))).toHaveLength(2);
    expect(await runOf(pid, oldId)).toMatchObject({ state: "finished", failed: 1 });
  });

  it("a run being resumed is held from the press: Discard, Pause, a start of its address and a second Resume are refused as for a held run", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const runId = await stoppedRun(pid);
    const gate = holdWorkerClient();
    const resuming = act(pid, runId, "resume");
    await gate.reached;
    expect(svc.state.downloads.held(runId)).toBe(true);
    const discard = await act(pid, runId, "discard");
    expect(discard.status).toBe(409);
    expect(discard.json.error).toEqual(conflict);
    expect((await act(pid, runId, "resume")).json.error).toEqual(conflict);
    expect((await act(pid, runId, "pause")).json.error).toMatchObject({ code: "CONFLICT", message: RUN_NOT_RUNNING_TEXT });
    const startAgain = await captureProfile(pid, A);
    expect(startAgain.status).toBe(409);
    expect(startAgain.json.error).toEqual(conflict);
    gate.release();
    const r = await resuming;
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect(await runs(pid)).toHaveLength(1);
  });

  it("a Stop of a run being resumed stops it with nothing asked of the platform", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const runId = await stoppedRun(pid);
    const asked = runLog.length;
    const gate = holdWorkerClient();
    const resuming = act(pid, runId, "resume");
    await gate.reached;
    const stopping = act(pid, runId, "stop");
    gate.release();
    const [r, s] = await Promise.all([resuming, stopping]);
    expect(s.status, s.body).toBe(200);
    expect(s.json.run).toMatchObject({ runId, state: "stopped" });
    expect([200, 409]).toContain(r.status);
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "stopped", done: 2 });
    expect(runLog).toHaveLength(asked);
  });

  it("a lock during a Resume's awaits is 423 and nothing is held or asked of the library", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const runId = await stoppedRun(pid);
    let resumed = 0;
    wrapLibraryResume((real, ...args) => {
      resumed++;
      return real(...args);
    });
    const gate = holdWorkerClient();
    const resuming = act(pid, runId, "resume");
    await gate.reached;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    gate.release();
    const r = await resuming;
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe("PROJECT_LOCKED");
    expect(svc.state.downloads.held(runId)).toBe(false);
    expect(svc.state.downloads.memory()).toEqual([]);
    expect(resumed).toBe(0);
  });

  it("a Resume whose run fails after the answer is logged and published as it now reads", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const runId = await stoppedRun(pid);
    wrapLibraryResume((real, projectId, id, how, ctl) =>
      real(projectId, id, how, {
        ...ctl,
        onChange: (run) => {
          ctl.onChange(run);
          if (run.state === "downloading") throw new Error("the journal could not be written");
        },
      }),
    );
    const events = collect();
    const r = await act(pid, runId, "resume");
    expect(r.status, r.body).toBe(200);
    expect(r.json.run).toMatchObject({ state: "downloading" });
    await svc.state.idle();
    const mine = events.filter((e) => e.type === "background.progress" && e.data.downloads?.runId === runId).map((e) => e.data.downloads as DownloadRunSummary);
    expect(mine.at(-1)).toMatchObject({ state: "interrupted" });
    expect(svc.state.downloads.held(runId)).toBe(false);
    expect(logs).toContain("the journal could not be written");
    expect(logs).toContain("download-run failed");
  });

  it("a Resume that reaches the library after its run finished is 409 with the finished sentence", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const runId = await stoppedRun(pid);
    wrapLibraryResume(() => Promise.reject(new InvalidInputError(plainReason("RUN_FINISHED"))));
    const r = await act(pid, runId, "resume");
    expect(r.status).toBe(409);
    expect(r.json.error).toEqual({ code: "CONFLICT", message: plainReason("RUN_FINISHED"), reason: "RUN_FINISHED" });
    expect(svc.state.downloads.held(runId)).toBe(false);
  });
});

describe("stop, discard and the problems", () => {
  it("starting an address again discards its older unfinished run", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const old = a.json.queueId as string;
    await held.reached;
    expect((await act(pid, old, "pause")).status).toBe(200);
    held.release();
    await svc.state.idle();
    const events = collect();
    const again = await captureProfile(pid, "https://tiktok.com/@fake.dancer?lang=en");
    expect(again.status, again.body).toBe(200);
    await svc.state.idle();
    const list = await runs(pid);
    expect(list.map((r) => r.runId)).toEqual([again.json.queueId]);
    expect(list[0]).toMatchObject({ state: "finished", total: 1, done: 1 });
    expect(events.filter((e) => e.type === "background.progress" && e.data.discarded).map((e) => e.data)).toEqual([{ projectId: pid, discarded: old }]);
    // A finished run of the address stays.
    const third = await captureProfile(pid, A);
    await svc.state.idle();
    expect((await runs(pid)).map((r) => r.runId).sort()).toEqual([again.json.queueId, third.json.queueId].sort());
  });

  it("stop ends the run; capturing the same channel later takes only what is missing", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    const s = await act(pid, runId, "stop");
    expect(s.status, s.body).toBe(200);
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "stopped", done: 2, notCompleted: 1 });
    expect(itemDownloads()).toEqual([idA(3), idA(2)]);
    const later = await captureProfile(pid, A);
    expect(later.status, later.body).toBe(200);
    await svc.state.idle();
    expect(itemDownloads()).toEqual([idA(3), idA(2), idA(1)]);
    expect(await runOf(pid, later.json.queueId)).toMatchObject({ state: "finished", total: 1, done: 1 });
    // Stop of a run nothing holds: it stays as it is.
    expect((await act(pid, later.json.queueId, "stop")).json.run).toMatchObject({ state: "finished" });
  });

  it("show them lists title, address and reason", async () => {
    profiles["fake.dancer"]!.items[1]!.error = "private";
    await start();
    await openLibrary();
    const pid = await project();
    const a = await captureProfile(pid, A);
    await svc.state.idle();
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "finished", done: 2, failed: 1, notCompleted: 1 });
    const r = await call({ url: `/projects/${pid}/downloads/${a.json.queueId}/problems` });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ platform: "tiktok", problems: [{ title: "Dance number 2 at the market", url: expect.stringContaining(`/video/${idA(2)}`), reason: "This video is private.", platformReason: "Private video. Sign in if you've been granted access to this video" }] });
    expect((await call({ url: `/projects/${pid}/downloads/nope/problems` })).status).toBe(404);
  });

  it("discard takes the run off the list; its sources stay", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const a = await captureProfile(pid, A);
    await svc.state.idle();
    const events = collect();
    const r = await act(pid, a.json.queueId, "discard");
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ discarded: true });
    expect(await runs(pid)).toEqual([]);
    expect(events.filter((e) => e.type === "background.progress").map((e) => e.data)).toEqual([{ projectId: pid, discarded: a.json.queueId }]);
    // The three videos and the profile's own record stay.
    expect(svc.state.session!.repo.listSourceIds(pid)).toHaveLength(4);
    expect((await act(pid, a.json.queueId, "discard")).status).toBe(404);
  });
});

describe("a lock (R669, R30, R50, R464 b)", () => {
  it("a lock stops the run at once and nothing more is asked of the platform; after the unlock the run is shown interrupted and nothing is downloaded until Resume downloads", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    const b = await captureProfile(pid, B);
    const events = collect();
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const atLock = tw.submitted.length;
    expect(svc.state.downloads.held(runId)).toBe(false);
    expect(svc.state.downloads.held(b.json.queueId)).toBe(false);
    held.release();
    await svc.state.idle();
    // Nothing more was published of the runs; the capture queue's end is the lock's, once.
    expect(events.filter((e) => e.type === "background.progress")).toEqual([]);
    expect(events.filter((e) => e.type === "capture.progress" && e.data.queueId === runId).map((e) => e.data.error)).toEqual([expect.stringMatching(/^ProjectLockedError/)]);
    expect((await call({ url: `/projects/${pid}/downloads` })).status).toBe(423);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "interrupted", done: 1 });
    expect(await runOf(pid, b.json.queueId)).toMatchObject({ state: "interrupted", total: 0 });
    expect(tw.submitted).toHaveLength(atLock);
    const r = await act(pid, runId, "resume");
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect(runLog.some((u) => u.includes("other.dancer"))).toBe(false);
  });

  it("at the lock no address or title of the run is held anywhere the service can reach", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    const b = await captureProfile(pid, B);
    const named = (text: string) => /fake\.dancer|other\.dancer|Fake Dancer|Other Dancer|Dance number/.test(text);
    // Before the lock the runner does hold the addresses (so the check below can fail).
    expect(named(JSON.stringify(svc.state.downloads.memory()))).toBe(true);
    const events = collect();
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const reachable = () => [JSON.stringify(svc.state.downloads.memory()), JSON.stringify(svc.state.captureQueues.list(pid)), JSON.stringify(svc.state.captureQueue(runId) ?? null), JSON.stringify(events), logs];
    for (const text of reachable()) expect(named(text), text.slice(0, 300)).toBe(false);
    // Not even the run ids.
    expect(JSON.stringify(svc.state.downloads.memory())).not.toContain(runId);
    expect(JSON.stringify(svc.state.downloads.memory())).not.toContain(b.json.queueId);
    held.release();
    await svc.state.idle();
    for (const text of reachable()) expect(named(text), text.slice(0, 300)).toBe(false);
  });

  it("a project that is not encrypted is not touched by its lock", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    await held.reached;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(svc.state.downloads.held(a.json.queueId)).toBe(true);
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "finished", done: 3 });
  });
});

describe("a move (R680, R106, R534 b)", () => {
  /** Moves the library; the download held at the move's stop is let go only once the drain has asked the run to stop. */
  async function moveWhileHeld(release: () => void): Promise<void> {
    const drain = svc.state.drainWork.bind(svc.state);
    let released = false;
    vi.spyOn(svc.state, "drainWork").mockImplementation((ms, which) => {
      const drained = drain(ms, which);
      if (!released) {
        released = true;
        release();
      }
      return drained;
    });
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
  }

  it("a plain project's run stops between videos for the move and carries on by itself on the moved library", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    await moveWhileHeld(held.release);
    await svc.state.idle();
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Moved"));
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect(itemDownloads()).toEqual([idA(3), idA(2), idA(1)]);
    expect((await auditOps(pid)).filter((op) => op === "capture.profile.continue")).toHaveLength(1);
    // Continued once; nothing is kept for a later move.
    expect(svc.state.stoppedWorkCount()).toBe(0);
  });

  it("a move refused for time leaves the runs as they were: the run halted for it and the run waiting behind it go on, and no continuation is left (R687)", async () => {
    await start({ suspendTimeoutMs: 300 });
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const aId = a.json.queueId as string;
    await held.reached;
    const b = await captureProfile(pid, B);
    const bId = b.json.queueId as string;
    svc.state.events.subscribe((e) => {
      const run = (e.data as { downloads?: DownloadRunSummary }).downloads;
      if (e.type === "background.progress" && run?.runId === aId && run.state === "finished") runLog.push("END A");
    });
    // The video in hand outlasts the move's drain: the move is refused and rolled back.
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.status).toBe(409);
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Lib"));
    // Both runs are still held: the first downloading, the second waiting its turn behind it.
    expect(svc.state.downloads.held(aId)).toBe(true);
    expect(svc.state.downloads.held(bId)).toBe(true);
    expect(await runOf(pid, bId)).toMatchObject({ state: "queued" });
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, aId)).toMatchObject({ state: "finished", done: 3 });
    expect(await runOf(pid, bId)).toMatchObject({ state: "finished", done: 3 });
    expect(itemDownloads()).toEqual([idA(3), idA(2), idA(1), idB(3), idB(2), idB(1)]);
    // Still in their order: nothing of the second address before the first run ended.
    const end = runLog.indexOf("END A");
    expect(end).toBeGreaterThan(0);
    expect(runLog.slice(0, end).some((u) => u.includes("other.dancer"))).toBe(false);
    expect(svc.state.stoppedWorkCount()).toBe(0);
  });

  it("after a refused move, a run paused meanwhile stays paused through a later successful move, and nothing is asked of the platform (R687)", async () => {
    profiles["fake.dancer"] = profile("fake.dancer", "Fake Dancer", idA, 4);
    await start({ suspendTimeoutMs: 300 });
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(3)));
    const a = await captureProfile(pid, A);
    const aId = a.json.queueId as string;
    await held.reached;
    const b = await captureProfile(pid, B);
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).status).toBe(409);
    // The first run goes on; the researcher pauses it at its next video.
    const next = hold(itemOf(idA(2)));
    held.release();
    await next.reached;
    expect((await act(pid, aId, "pause")).status).toBe(200);
    next.release();
    await svc.state.idle();
    expect(await runOf(pid, aId)).toMatchObject({ state: "paused", done: 3, notCompleted: 1 });
    expect(await runOf(pid, b.json.queueId)).toMatchObject({ state: "finished", done: 3 });
    const asked = runLog.length;
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    await svc.state.idle();
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Moved"));
    expect(await runOf(pid, aId)).toMatchObject({ state: "paused", done: 3, notCompleted: 1 });
    expect(runLog).toHaveLength(asked);
    expect(svc.state.stoppedWorkCount()).toBe(0);
  });

  it("a run stopped after the move halted it is not continued on the moved library; its continuation is dropped (R687)", async () => {
    await start();
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const aId = a.json.queueId as string;
    await held.reached;
    // The run is stopped (as a Stop of a run nothing holds writes it) once the move's drain has ended it.
    const drain = svc.state.drainWork.bind(svc.state);
    let first = true;
    vi.spyOn(svc.state, "drainWork").mockImplementation(async (ms, which) => {
      const drained = drain(ms, which);
      if (!first) return drained;
      first = false;
      held.release();
      const ok = await drained;
      expect(svc.state.downloads.held(aId)).toBe(false);
      await svc.state.downloads.request(svc.state.session!, pid, aId, "stop");
      return ok;
    });
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    await svc.state.idle();
    expect(await runOf(pid, aId)).toMatchObject({ state: "stopped", done: 2 });
    expect(itemDownloads()).toEqual([idA(3), idA(2)]);
    expect((await auditOps(pid)).filter((op) => op === "capture.profile.continue")).toHaveLength(0);
    expect(svc.state.downloads.held(aId)).toBe(false);
    expect(svc.state.stoppedWorkCount()).toBe(0);
  });

  it("an encrypted project's run, and a run waiting its turn, do not begin again after the move: they are shown interrupted", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const plain = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    await held.reached;
    const b = await captureProfile(pid, B);
    const asked = () => runLog.filter((u) => !u.startsWith("END")).length;
    await moveWhileHeld(held.release);
    await svc.state.idle();
    const atMove = asked();
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc.state.idle();
    expect(await runOf(pid, a.json.queueId)).toMatchObject({ state: "interrupted" });
    expect(await runOf(pid, b.json.queueId)).toMatchObject({ state: "interrupted", total: 0 });
    expect(asked()).toBe(atMove);
    expect(runLog.some((u) => u.includes("other.dancer"))).toBe(false);
    expect(await runs(plain)).toEqual([]);
  });
});

describe("the test-only free space (R687 D, R47)", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
  });

  it("AO_TEST_FREE_BYTES gives the download runs their free space only when NODE_ENV is exactly test", async () => {
    const read = downloadFreeBytesFromEnv({ NODE_ENV: "test", AO_TEST_FREE_BYTES: "500000000000" });
    expect(await read?.("/anywhere")).toBe(500_000_000_000);
    for (const NODE_ENV of [undefined, "production", "development", "Test", "test "]) {
      expect(downloadFreeBytesFromEnv({ ...(NODE_ENV === undefined ? {} : { NODE_ENV }), AO_TEST_FREE_BYTES: "500000000000" }), String(NODE_ENV)).toBeUndefined();
    }
    expect(downloadFreeBytesFromEnv({ NODE_ENV: "test" })).toBeUndefined();
    // In test mode a value that is not a whole number of bytes refuses the start, naming the variable.
    for (const bad of ["", "12.5", "-1", "1e9", "lots"]) expect(() => downloadFreeBytesFromEnv({ NODE_ENV: "test", AO_TEST_FREE_BYTES: bad }), bad).toThrow(/AO_TEST_FREE_BYTES/);
  });

  it("the download runs' test seams are ignored unless NODE_ENV is exactly test", async () => {
    process.env.NODE_ENV = "development";
    await start({ downloadFreeBytes: async () => 1, downloadSleep: async () => {} });
    expect(svc.state.opts.downloads).toBeUndefined();
    await svc.close();
    process.env.NODE_ENV = "test";
    await start({ downloadFreeBytes: async () => 1 });
    expect(svc.state.opts.downloads?.freeBytes).toBeDefined();
  });
});

describe("a slow-down wait across a move (R690)", () => {
  /** The download runs' sleep, under the test's hand: each sleep ends when woken (by its signal, or by the test). */
  function controlledSleep(): {
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    sleeps: Array<{ ms: number; wake: () => void; done: boolean }>;
    next: () => Promise<{ ms: number; wake: () => void }>;
    /** From now on every sleep ends at once (the gaps between the downloads that follow). */
    free: () => void;
  } {
    let freed = false;
    const sleeps: Array<{ ms: number; wake: () => void; done: boolean }> = [];
    let waiting: ((x: { ms: number; wake: () => void }) => void) | undefined;
    releases.push(() => {
      for (const x of sleeps) x.wake();
    });
    return {
      sleeps,
      next: () => new Promise((r) => (waiting = r)),
      free: () => (freed = true),
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const x = { ms, done: false, wake: () => ((x.done = true), resolve()) };
          if (freed || signal?.aborted) return x.wake();
          signal?.addEventListener("abort", x.wake, { once: true });
          sleeps.push(x);
          const w = waiting;
          waiting = undefined;
          w?.(x);
        }),
    };
  }
  const listings = () => runLog.filter((u) => !u.includes("/video/")).length;

  it("after a successful move a run that was waiting on a slow-down sleeps the rest of the wait before it asks the platform again; then it goes on", async () => {
    const clock = controlledSleep();
    await start({ downloadSleep: clock.sleep });
    await openLibrary();
    const pid = await project();
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    const waited = clock.next();
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    const first = await waited;
    expect(await runOf(pid, runId)).toMatchObject({ state: "waiting", wait: { why: "rate-limited" } });
    const ms = (await runOf(pid, runId))!.wait!.ms;
    expect(listings()).toBe(1);
    const rest = clock.next();
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    expect(first).toMatchObject({ ms });
    const restOf = await rest;
    // The rest of the wait, nothing asked of the platform meanwhile; the run still waiting, and held.
    expect(restOf.ms).toBeGreaterThan(0);
    expect(restOf.ms).toBeLessThanOrEqual(ms);
    expect(restOf.ms).toBeGreaterThan(ms - 30_000);
    expect(listings()).toBe(1);
    expect(await runOf(pid, runId)).toMatchObject({ state: "waiting" });
    expect(svc.state.downloads.held(runId)).toBe(true);
    delete process.env.FAKE_TOOL_MODE;
    clock.free();
    restOf.wake();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect(listings()).toBe(2);
  });

  it("after a refused move a run that was waiting on a slow-down sleeps the rest of the wait before it asks the platform again", async () => {
    const clock = controlledSleep();
    await start({ downloadSleep: clock.sleep });
    await openLibrary();
    const pid = await project();
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    const waited = clock.next();
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await waited;
    const ms = (await runOf(pid, runId))!.wait!.ms;
    const asked = runLog.length;
    // The move's drain ends the run, then the move is refused (as when other work did not stop in time).
    const drain = svc.state.drainWork.bind(svc.state);
    vi.spyOn(svc.state, "drainWork").mockImplementation(async (t, which) => {
      await drain(t, which);
      return false;
    });
    const rest = clock.next();
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).status).toBe(409);
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Lib"));
    const restOf = await rest;
    expect(restOf.ms).toBeGreaterThan(0);
    expect(restOf.ms).toBeLessThanOrEqual(ms);
    expect(runLog).toHaveLength(asked);
    expect(await runOf(pid, runId)).toMatchObject({ state: "waiting" });
    expect(svc.state.downloads.held(runId)).toBe(true);
    delete process.env.FAKE_TOOL_MODE;
    clock.free();
    restOf.wake();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "finished", done: 3 });
    expect(svc.state.stoppedWorkCount()).toBe(0);
  });

  it("a Stop during the rest of the wait ends the run stopped, with nothing asked of the platform", async () => {
    const clock = controlledSleep();
    await start({ downloadSleep: clock.sleep });
    await openLibrary();
    const pid = await project();
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    const waited = clock.next();
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await waited;
    const asked = runLog.length;
    const rest = clock.next();
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).body).toContain('"done":true');
    const restOf = await rest;
    expect(runLog).toHaveLength(asked);
    delete process.env.FAKE_TOOL_MODE;
    expect((await act(pid, runId, "stop")).status).toBe(200);
    await svc.state.idle();
    expect(clock.sleeps.find((y) => y === (restOf as unknown))?.done).toBe(true);
    expect(await runOf(pid, runId)).toMatchObject({ state: "stopped" });
    expect(runLog).toHaveLength(asked);
    expect(svc.state.downloads.held(runId)).toBe(false);
  });

  it("a Pause asked while a run finishes its video after a refused move ends it paused, and it is not continued", async () => {
    await start({ suspendTimeoutMs: 300 });
    await openLibrary();
    const pid = await project();
    const held = hold(itemOf(idA(2)));
    const a = await captureProfile(pid, A);
    const runId = a.json.queueId as string;
    await held.reached;
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).status).toBe(409);
    expect((await act(pid, runId, "pause")).status).toBe(200);
    held.release();
    await svc.state.idle();
    expect(await runOf(pid, runId)).toMatchObject({ state: "paused", done: 2, notCompleted: 1 });
    expect(itemDownloads()).toEqual([idA(3), idA(2)]);
    expect(svc.state.downloads.held(runId)).toBe(false);
  });
});

describe("the routes' guards", () => {
  it("every new route refuses a locked project with 423 and the extension token with 403", async () => {
    await start();
    await openLibrary();
    const pid = await project({ encrypted: true });
    const a = await captureProfile(pid, A);
    await svc.state.idle();
    const runId = a.json.queueId as string;
    const routes: Array<{ method: "GET" | "POST"; url: string; body?: unknown }> = [
      { method: "POST", url: `/projects/${pid}/capture-estimate`, body: { url: A } },
      { method: "GET", url: `/projects/${pid}/downloads` },
      { method: "GET", url: `/projects/${pid}/downloads/${runId}/problems` },
      { method: "POST", url: `/projects/${pid}/downloads/${runId}/pause` },
      { method: "POST", url: `/projects/${pid}/downloads/${runId}/stop` },
      { method: "POST", url: `/projects/${pid}/downloads/${runId}/resume` },
      { method: "POST", url: `/projects/${pid}/downloads/${runId}/discard` },
    ];
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = c.json().token as string;
    for (const r of routes) {
      const fromExt = await call({ ...r, noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } });
      expect(fromExt.status, r.url).toBe(403);
    }
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    for (const r of routes) {
      const locked = await call(r);
      expect(locked.status, r.url).toBe(423);
      expect(locked.json.error.code).toBe("PROJECT_LOCKED");
    }
    // Locked: refused before the body is even read.
    expect((await call({ method: "POST", url: `/projects/${pid}/capture-estimate`, body: {} })).status).toBe(423);
  });
});
