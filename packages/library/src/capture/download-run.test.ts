/**
 * Download runs (whole channels, Task 4): a channel, playlist or profile downloaded one video at a
 * time, each video written to the project's job journal, with the gap, the disk floor, the waits,
 * Pause, Stop, Resume and the turn (R669). The fake tools (tests/fixtures/fake-tools) play the
 * platform; every wait goes through the injected sleep, and no test waits on a real timer.
 */
import { readFile, readdir, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AuditEvent, SourceFile } from "@ao/core";
import { runLines, type DownloadRunSummary } from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { journalPath } from "../job-journal.js";
import { createLibrary, type Library } from "../library.js";
import { readRun, readRunItems } from "../lists/run-journal.js";
import { readTranscriptionList } from "../lists/transcription-list.js";
import { InvalidInputError, PolicyDeniedError, type Repo } from "../repo/index.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient } from "../worker-client.js";
import { CaptureCancelledError, plainReason } from "./errors.js";
import { DOWNLOAD_GAP_MS, createDownloadRuns, type DownloadRuns, type RunControl, type RunOptions } from "./download-run.js";
import { FAKE_TOOLS_DIR, startToolWorker, type ToolWorker } from "./testing.js";

const FAST = 2 ** 10;
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [downloader]
`;
const TT_PROFILE = "https://www.tiktok.com/@fake.dancer";
const T0 = 1767312000;

interface Item {
  id: string;
  caption: string;
  timestamp: number;
  duration?: number;
  error?: "private" | "removed" | "network" | "disk";
}
interface Profile {
  platform: "tiktok";
  handle: string;
  displayName: string;
  bio: string;
  links: string[];
  avatar: string;
  followers: number;
  following: number;
  items: Item[];
  rateLimitAfter?: number;
  cutAfter?: number;
}
const ttId = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
const synthetic = (n = 3): Profile => ({
  platform: "tiktok",
  handle: "fake.dancer",
  displayName: "Fake Dancer",
  bio: "Synthetic test profile. Nothing here is real.",
  links: [],
  avatar: "https://p16.example/avatar.jpeg",
  followers: 1200,
  following: 34,
  // newest first, as platforms list them
  items: Array.from({ length: n }, (_, i) => ({ id: ttId(n - i), caption: `Dance number ${n - i} at the market`, timestamp: T0 + (n - i) * 86400 })),
});

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let worker: ToolWorker;
let client: WorkerClient;
let runs: DownloadRuns;
let profileFile: string;
/** The sleeps asked of the injected sleep, and how each is answered (at once, by default). */
let sleeps: number[];
let sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
/** What the injected freeBytes answers. */
let free: number | null;
const savedEnv = { PATH: process.env.PATH, FAKE_TOOL_MODE: process.env.FAKE_TOOL_MODE, FAKE_PROFILE_FILE: process.env.FAKE_PROFILE_FILE };
const closers: Array<() => Promise<void> | void> = [];

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

const setProfile = (p: Profile) => writeFile(profileFile, JSON.stringify(p));

async function project(gov = GOV) {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: { enabled: false } });
  return project;
}

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}
const captureAllows = async (folder: string) => (await auditEvents(folder)).filter((e) => e.action === "capture" && e.decision?.result === "allow");

async function posts(projectId: string): Promise<SourceFile[]> {
  const all = await Promise.all(repo.listSourceIds(projectId).map((id) => repo.getSource(projectId, id)));
  return all.filter((sf) => sf.source.caseAttributes.genre !== "profile");
}

const idOfUrl = (u: string) => /\/video\/(\d+)/.exec(u)?.[1];
const itemDownloads = () => worker.submitted.filter((j) => j.type === "capture.download" && !j.params.flatList).map((j) => idOfUrl(j.input));
const listings = () => worker.submitted.filter((j) => j.type === "capture.download" && j.params.flatList).length;

/** A RunControl a test steers: `ask` is the researcher's Pause or Stop, `cancel` a lock, a close or a quit. */
function control(over: Partial<RunControl> = {}) {
  const req = new AbortController();
  const cut = new AbortController();
  let asked: "pause" | "stop" | undefined;
  let cancelled = false;
  const changes: DownloadRunSummary[] = [];
  const ctl: RunControl = {
    requested: () => asked,
    requestedSignal: req.signal,
    cancelled: () => cancelled,
    signal: cut.signal,
    halt: () => false,
    onChange: (r) => void changes.push(r),
    ...over,
  };
  return {
    ctl,
    changes,
    ask(a: "pause" | "stop") {
      asked = a;
      req.abort();
    },
    cancel() {
      cancelled = true;
      cut.abort();
    },
    /** The states the run went through, each once in a row. */
    states: () => changes.map((c) => c.state).filter((s, i, a) => i === 0 || a[i - 1] !== s),
  };
}

const OPTS: RunOptions = { transcribe: false, quality: "720p" };
let runN = 0;
const newRunId = () => `run-${++runN}`;

/** Calls `fn` when the item with this id is about to be downloaded (before the worker runs it). */
function onDownloadOf(id: string, fn: () => void | Promise<void>) {
  const submit = client.submit.bind(client);
  vi.spyOn(client, "submit").mockImplementation(async (...args) => {
    if (args[1].input.includes(id) && !args[1].params?.flatList) await fn();
    return submit(...args);
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-download-run-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", tz: "UTC", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedEnv.PATH ?? ""}`;
  delete process.env.FAKE_TOOL_MODE;
  profileFile = join(tmp, "profile.json");
  process.env.FAKE_PROFILE_FILE = profileFile;
  await setProfile(synthetic());
  worker = await startToolWorker();
  client = new WorkerClient({ repo, worker, index: { db: handle.db }, pollMs: 5 });
  sleeps = [];
  sleepImpl = async () => {};
  free = 1e12;
  runs = createDownloadRuns({
    repo,
    worker: client,
    index: handle,
    sleep: (ms, signal) => (sleeps.push(ms), sleepImpl(ms, signal)),
    freeBytes: async () => free,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
  await worker.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("download runs", { timeout: 120_000 }, () => {
  it("a run lists, journals and downloads one video at a time with the gap between downloads", async () => {
    const prof = synthetic(3);
    const p = await project();
    const c = control();
    const id = newRunId();
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(sleeps).toEqual([DOWNLOAD_GAP_MS, DOWNLOAD_GAP_MS]);
    expect(DOWNLOAD_GAP_MS).toBe(10_000);
    expect(run).toMatchObject({ runId: id, projectId: p.id, url: TT_PROFILE, title: "Fake Dancer", platform: "tiktok", quality: "720p", transcribe: false, state: "finished", total: 3, done: 3, failed: 0, notCompleted: 0 });
    expect(c.changes.at(-1)).toEqual(run);
    expect(c.states()).toEqual(["queued", "downloading", "finished"]);
    expect(c.changes[0]).toMatchObject({ state: "queued", total: 0, title: "@fake.dancer" }); // the link key until the list is read
    expect(itemDownloads()).toEqual(prof.items.map((it) => it.id));
    expect(worker.maxConcurrent).toBe(1);
    const items = await readRunItems(repo, p.id, id);
    expect(items.map((i) => [i.item.postId, i.status])).toEqual(prof.items.map((it) => [it.id, "done"]));
    expect(items.every((i) => typeof i.item.sourceId === "string")).toBe(true);
    // every change on the way was told, with the counters moving one video at a time
    expect(c.changes.filter((ch) => ch.state === "downloading").map((ch) => ch.done)).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(await runs.get(p.id, id, () => false)).toEqual({ ...run, updatedAt: expect.any(String) });
    expect(await runs.list(p.id, () => false)).toHaveLength(1);
  });

  it("a video that cannot be downloaded gets its error and the run goes on", async () => {
    const prof = synthetic(3);
    prof.items[1]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl);
    expect(run).toMatchObject({ state: "finished", total: 3, done: 2, failed: 1, notCompleted: 1 });
    expect(runLines(run).title).toBe('"Fake Dancer": 2 of 3 downloaded. 1 could not be downloaded.');
    const pr = await runs.problems(p.id, id);
    expect(pr.platform).toBe("tiktok");
    expect(pr.problems).toHaveLength(1);
    expect(pr.problems[0]).toMatchObject({ url: `https://www.tiktok.com/@fake.dancer/video/${prof.items[1]!.id}`, reason: "This video is private.", title: "Dance number 2 at the market" });
    expect(pr.problems[0]!.platformReason).toContain("Private video");
  });

  it("Resume tries again the failed and the not reached ones, in order", async () => {
    const prof = synthetic(4);
    prof.items[0]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    const c = control({ onItem: (done) => (done === 2 ? c.ask("pause") : undefined) });
    const paused = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(paused).toMatchObject({ state: "paused", total: 4, done: 1, failed: 1, notCompleted: 3 });
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["failed", "done", "queued", "queued"]);
    expect(runLines(paused).resume).toBe("Resume downloads (3 did not complete)");

    delete prof.items[0]!.error;
    await setProfile(prof);
    const before = itemDownloads().length;
    sleeps.length = 0;
    const r = control();
    const run = await runs.resume(p.id, id, "researcher", r.ctl);
    expect(itemDownloads().slice(before)).toEqual([prof.items[0]!.id, prof.items[2]!.id, prof.items[3]!.id]);
    expect(run).toMatchObject({ state: "finished", total: 4, done: 4, failed: 0, notCompleted: 0 });
    expect(r.states()).toEqual(["queued", "downloading", "finished"]);
    expect(sleeps).toEqual([DOWNLOAD_GAP_MS, DOWNLOAD_GAP_MS]);
  });

  it("a video that fails again keeps its error and notCompleted stays", async () => {
    const prof = synthetic(3);
    prof.items[1]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    expect(await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl)).toMatchObject({ state: "finished", done: 2, failed: 1, notCompleted: 1 });
    const before = itemDownloads().length;
    const run = await runs.resume(p.id, id, "researcher", control().ctl);
    expect(itemDownloads().slice(before)).toEqual([prof.items[1]!.id]);
    expect(run).toMatchObject({ state: "finished", total: 3, done: 2, failed: 1, notCompleted: 1 });
    expect(runLines(run).resume).toBe("Resume downloads (1 did not complete)");
    expect((await runs.problems(p.id, id)).problems.map((x) => x.reason)).toEqual(["This video is private."]);
  });

  it("pause finishes the video in hand and the run stays paused across a re-read", async () => {
    const prof = synthetic(3);
    const p = await project();
    const id = newRunId();
    const c = control();
    onDownloadOf(prof.items[1]!.id, () => c.ask("pause"));
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(run).toMatchObject({ state: "paused", done: 2, failed: 0, notCompleted: 1, reason: plainReason("RUN_PAUSED") });
    expect(itemDownloads()).toEqual([prof.items[0]!.id, prof.items[1]!.id]);
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["done", "done", "queued"]);
    // read again, not held by anything: still paused, not interrupted
    const again = await runs.get(p.id, id, () => false);
    expect(again).toMatchObject({ state: "paused", done: 2, notCompleted: 1 });
    expect(runLines(again!).title).toBe('"Fake Dancer" is paused: 2 of 3 downloaded.');
  });

  it("stop ends the run and keeps what was downloaded", async () => {
    const p = await project();
    const id = newRunId();
    const c = control({ onItem: (done) => (done === 1 ? c.ask("stop") : undefined) });
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(run).toMatchObject({ state: "stopped", done: 1, notCompleted: 2, reason: plainReason("RUN_STOPPED") });
    expect(await posts(p.id)).toHaveLength(1);
    expect(itemDownloads()).toHaveLength(1);
    expect(sleeps).toEqual([]); // a Stop asked before a video ends the run before the gap
    expect(runLines(run).title).toBe('"Fake Dancer" was stopped: 1 of 3 downloaded.');
  });

  it("a pause asked during a slow-down wait ends the wait at once", async () => {
    await setProfile({ ...synthetic(3), rateLimitAfter: 1 });
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const p = await project();
    const id = newRunId();
    let woken = false;
    const c = control({
      onChange: (r) => {
        c.changes.push(r);
        if (r.state === "waiting") c.ask("pause");
      },
    });
    sleepImpl = (ms, signal) =>
      ms === DOWNLOAD_GAP_MS
        ? Promise.resolve()
        : new Promise<void>((res) => {
            // held until the Pause wakes it (and released when the test ends)
            const end = () => ((woken = true), res());
            if (signal?.aborted) return end();
            signal?.addEventListener("abort", end, { once: true });
            onTestFinished(() => res());
          });
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(woken).toBe(true);
    expect(c.changes.find((ch) => ch.state === "waiting")).toMatchObject({ wait: { ms: 60_000, why: "rate-limited" } });
    expect(runLines(c.changes.find((ch) => ch.state === "waiting")!).wait).toBe("waiting 1 minute — TikTok asked to slow down");
    expect(run).toMatchObject({ state: "paused", done: 1, notCompleted: 2 });
    expect(run.wait).toBeUndefined();
    expect(sleeps).toEqual([DOWNLOAD_GAP_MS, 60_000]);
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["done", "queued", "queued"]);
  });

  it("the disk floor pauses before a download that would leave less than 10 GB", async () => {
    const prof = synthetic(3);
    prof.items[1]!.duration = 3600; // 1 h at up to 720p: at most 810 MB
    await setProfile(prof);
    free = 10.5e9; // 10.5 GB − 0.81 GB < 10 GB; the first item has no known length and counts 0
    const p = await project();
    const id = newRunId();
    const run = await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl);
    expect(run).toMatchObject({ state: "paused-disk", done: 1, failed: 0, notCompleted: 2 });
    expect(itemDownloads()).toEqual([prof.items[0]!.id]);
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["done", "queued", "queued"]);
    expect(runLines(run).why).toBe("Paused: the disk is nearly full. Free some space, then press Resume downloads.");
    // the free space cannot be read: never a pause
    free = null;
    expect(await runs.resume(p.id, id, "researcher", control().ctl)).toMatchObject({ state: "finished", done: 3 });
  });

  it("a download that fails for lack of space pauses the run and leaves the video to do", async () => {
    // (a) the worker says the disk became full
    const prof = synthetic(3);
    prof.items[1]!.error = "disk";
    await setProfile(prof);
    const p = await project();
    const a = newRunId();
    const ra = await runs.start(p.id, a, TT_PROFILE, OPTS, control().ctl);
    expect(ra).toMatchObject({ state: "paused-disk", done: 1, failed: 0, notCompleted: 2 });
    expect((await readRunItems(repo, p.id, a)).map((i) => i.status)).toEqual(["done", "queued", "queued"]);
    expect(runLines(ra).why).toBe("Paused: the disk is nearly full. Free some space, then press Resume downloads.");

    // (b) another failure, after which less than the floor is free: not failed, the run pauses before the next
    const q = await project();
    const prof2 = synthetic(3);
    prof2.items[1]!.error = "private";
    await setProfile(prof2);
    free = 50e9;
    onDownloadOf(prof2.items[1]!.id, () => void (free = 5e9));
    const b = newRunId();
    const rb = await runs.start(q.id, b, TT_PROFILE, OPTS, control().ctl);
    expect(rb).toMatchObject({ state: "paused-disk", done: 1, failed: 0, notCompleted: 2 });
    expect((await readRunItems(repo, q.id, b)).map((i) => [i.status, i.item.errorCode])).toEqual([["done", undefined], ["queued", undefined], ["queued", undefined]]);
    expect(itemDownloads().filter((x) => x === prof2.items[2]!.id)).toHaveLength(0);

    // (c) the same on the last video: the run pauses on the disk, never "the list came back incomplete"
    vi.restoreAllMocks();
    const s = await project();
    const prof3 = synthetic(2);
    prof3.items[1]!.error = "private";
    await setProfile(prof3);
    free = 50e9;
    onDownloadOf(prof3.items[1]!.id, () => void (free = 5e9));
    const rc = await runs.start(s.id, newRunId(), TT_PROFILE, OPTS, control().ctl);
    expect(rc).toMatchObject({ state: "paused-disk", done: 1, failed: 0, notCompleted: 1 });
  });

  it("a missing tool pauses the run and fails no video", async () => {
    const noFfmpeg = await startToolWorker({ ffmpeg: false });
    closers.push(() => noFfmpeg.close());
    const c2 = new WorkerClient({ repo, worker: noFfmpeg, index: { db: handle.db }, pollMs: 5 });
    const runs2 = createDownloadRuns({ repo, worker: c2, index: handle, sleep: async (ms) => void sleeps.push(ms), freeBytes: async () => free });
    const p = await project();
    const id = newRunId();
    const run = await runs2.start(p.id, id, TT_PROFILE, OPTS, control().ctl);
    expect(run).toMatchObject({ state: "paused-tool", tool: "ffmpeg", done: 0, failed: 0, notCompleted: 3 });
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["queued", "queued", "queued"]);
    expect(runLines(run).why).toBe("Paused: Video tools are not installed. Install them from the Optional tools screen, then press Resume downloads.");
  });

  it("a run with transcribe puts each new video on the transcription list and says so", async () => {
    const prof = synthetic(3);
    prof.items[2]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const told: string[] = [];
    const id = newRunId();
    const run = await runs.start(p.id, id, TT_PROFILE, { transcribe: true, transcribeModel: "small", quality: "720p" }, control({ onQueuedForTranscription: (sid) => void told.push(sid) }).ctl);
    expect(run).toMatchObject({ state: "finished", done: 2, failed: 1, transcribe: true });
    const items = await readRunItems(repo, p.id, id);
    const stored = items.filter((i) => i.status === "done").map((i) => i.item.sourceId);
    expect(told).toEqual(stored);
    const list = await readTranscriptionList(repo, p.id);
    expect(list.pending.map((e) => [e.entry.sourceId, e.entry.model])).toEqual(stored.map((sid) => [sid, "small"]));
    // the downloads themselves are not transcribed by the capture: the list does it, one at a time
    expect(worker.submitted.filter((j) => j.type === "audio.transcribe")).toHaveLength(0);
  });

  it("a run cut by a cancel writes nothing more and shows as interrupted when not held", async () => {
    const prof = synthetic(3);
    const p = await project();
    const id = newRunId();
    const c = control();
    /** The run's own journal lines (the worker's job records are the worker client's, not the run's). */
    const runLinesOf = async () =>
      (await readFile(journalPath(lib.root, p.folder), "utf8")).split("\n").filter((l) => /"kind":"capture\.(run|item)"/.test(l));
    let journalAtCut: string[] = [];
    onDownloadOf(prof.items[1]!.id, async () => {
      c.cancel();
      journalAtCut = await runLinesOf();
    });
    await expect(runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl)).rejects.toBeInstanceOf(CaptureCancelledError);
    expect(journalAtCut.length).toBeGreaterThan(0);
    expect(await runLinesOf()).toEqual(journalAtCut);
    const changesAtEnd = c.changes.length;
    expect(c.changes.at(-1)).toMatchObject({ state: "downloading", done: 1 });
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual(["done", "running", "queued"]);
    const shown = await runs.get(p.id, id, () => false);
    expect(shown).toMatchObject({ state: "interrupted", done: 1, total: 3, notCompleted: 2 });
    expect(runLines(shown!).title).toBe("The capture of 'Fake Dancer' was interrupted: 1 of 3 done.");
    expect(runLines(shown!).resume).toBe("Resume downloads (2 did not complete)");
    expect(await runs.get(p.id, id, (r) => r === id)).toMatchObject({ state: "downloading" });
    expect(c.changes).toHaveLength(changesAtEnd);
  });

  it("resume after a quit audits capture.profile.resume and asks the rules again", async () => {
    const prof = synthetic(3);
    prof.items[0]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    const c = control();
    onDownloadOf(prof.items[1]!.id, () => c.cancel());
    await expect(runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl)).rejects.toBeInstanceOf(CaptureCancelledError);
    vi.restoreAllMocks();
    expect(await runs.get(p.id, id, () => false)).toMatchObject({ state: "interrupted", done: 0, failed: 1 });

    // the rules changed meanwhile: the press is refused, audited, and nothing is asked of the platform;
    // the run ends failed with the rule's own reason, and the failure it knew is kept (I1, Minor 3)
    const gov = join(lib.root, p.folder, "governance.yaml");
    await writeFile(gov, GOV.replace("[downloader]", "[manual_upload]"));
    const asked = worker.submitted.length;
    const r = control();
    const err = await runs.resume(p.id, id, "researcher", r.ctl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(worker.submitted.length).toBe(asked);
    expect((await auditEvents(p.folder)).filter((e) => e.action === "capture").at(-1)?.decision?.result).toBe("deny");
    const refused = await runs.get(p.id, id, () => false);
    expect(refused).toMatchObject({ state: "failed", done: 0, failed: 1, notCompleted: 3, reason: (err as PolicyDeniedError).reason });
    expect(r.changes.at(-1)).toEqual({ ...refused, updatedAt: expect.any(String) });
    expect((await readRun(repo, p.id, id))?.record.run.errorCode).toBe("POLICY_DENIED");
    expect(runLines(refused!).why).toBe((err as PolicyDeniedError).reason);
    expect(runLines(refused!).resume).toBe("Resume downloads (3 did not complete)");
    expect((await runs.problems(p.id, id)).problems.map((x) => x.reason)).toEqual(["This video is private."]);
    expect((await readRunItems(repo, p.id, id)).map((i) => [i.status, i.item.errorCode])).toEqual([["failed", "PRIVATE"], ["running", undefined], ["queued", undefined]]);

    await writeFile(gov, GOV);
    delete prof.items[0]!.error;
    await setProfile(prof);
    const run = await runs.resume(p.id, id, "researcher", control().ctl);
    expect(run).toMatchObject({ state: "finished", done: 3, failed: 0 });
    const allows = await captureAllows(p.folder);
    expect(allows.map((e) => (e.details as { op?: string }).op)).toEqual(["capture.profile", "capture.profile.resume"]);
    expect(allows.at(-1)?.details).toMatchObject({ resume: true });
  });

  it("a start the project's rules refuse ends failed with the rule's reason and still offers Resume downloads", async () => {
    const p = await project(GOV.replace("[downloader]", "[manual_upload]"));
    const id = newRunId();
    const c = control();
    const err = await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(worker.submitted).toHaveLength(0);
    const shown = await runs.get(p.id, id, () => false);
    expect(shown).toMatchObject({ state: "failed", total: 0, reason: (err as PolicyDeniedError).reason });
    expect(c.states()).toEqual(["queued", "downloading", "failed"]);
    expect((await readRun(repo, p.id, id))?.record.run.errorCode).toBe("POLICY_DENIED");
    expect(runLines(shown!).resume).toBe("Resume downloads");
  });

  it("a Resume whose listing fails keeps the failures the run knew", async () => {
    const prof = synthetic(3);
    prof.items[0]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    const c = control({ onItem: (done) => (done === 2 ? c.ask("pause") : undefined) });
    expect(await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl)).toMatchObject({ state: "paused", done: 1, failed: 1 });
    process.env.FAKE_TOOL_MODE = "enumnetwork";
    const run = await runs.resume(p.id, id, "researcher", control().ctl);
    expect(run).toMatchObject({ state: "failed", done: 1, failed: 1, reason: plainReason("NETWORK_LOST_GAVE_UP") });
    expect((await runs.problems(p.id, id)).problems.map((x) => x.reason)).toEqual(["This video is private."]);
    expect((await readRunItems(repo, p.id, id)).map((i) => [i.status, i.item.errorCode])).toEqual([["failed", "PRIVATE"], ["done", undefined], ["queued", undefined]]);
  });

  it("a Resume whose listing came back cut short before a failed video keeps its failure and says why", async () => {
    const prof = synthetic(12);
    prof.items[9]!.error = "private";
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    expect(await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl)).toMatchObject({ state: "finished", done: 11, failed: 1 });
    await setProfile({ ...prof, cutAfter: 5 });
    process.env.FAKE_TOOL_MODE = "enumbroken";
    const cut = await runs.resume(p.id, id, "researcher", control().ctl);
    expect(cut).toMatchObject({ state: "failed", done: 11, failed: 1, reason: plainReason("LIST_INCOMPLETE") });
    expect((await runs.problems(p.id, id)).problems.map((x) => x.reason)).toEqual(["This video is private."]);
  });

  it("a run finished with no failure cannot be resumed", async () => {
    const p = await project();
    const id = newRunId();
    expect(await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl)).toMatchObject({ state: "finished", failed: 0 });
    const asked = worker.submitted.length;
    const c = control();
    await expect(runs.resume(p.id, id, "researcher", c.ctl)).rejects.toBeInstanceOf(InvalidInputError);
    expect(worker.submitted.length).toBe(asked);
    expect(c.changes).toHaveLength(0);
    expect(await runs.get(p.id, id, () => false)).toMatchObject({ state: "finished" });
  });

  it("discard hides the run; the sources stay", async () => {
    const p = await project();
    const id = newRunId();
    await runs.start(p.id, id, TT_PROFILE, OPTS, control().ctl);
    expect(await runs.discard(p.id, id)).toBe(true);
    expect(await runs.list(p.id, () => false)).toEqual([]);
    expect(await runs.get(p.id, id, () => false)).toBeUndefined();
    expect(await posts(p.id)).toHaveLength(3);
    expect(await runs.discard(p.id, id)).toBe(false);
  });

  it("a run whose turn has not come is written queued, asks nothing of the platform, and starts when the turn comes", async () => {
    const p = await project();
    let release: () => void = () => {};
    const turn = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let called: () => void = () => {};
    const waitingTurn = new Promise<void>((r) => (called = r));
    const c = control({ turn: () => (called(), turn) });
    const id = newRunId();
    const started = runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    await waitingTurn;
    expect(worker.submitted).toHaveLength(0);
    expect(c.changes).toHaveLength(1);
    expect(c.changes[0]).toMatchObject({ state: "queued", total: 0 });
    expect(runLines(c.changes[0]!).title).toBe('"@fake.dancer" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.');
    expect(await runs.get(p.id, id, (r) => r === id)).toMatchObject({ state: "queued" });
    release();
    const run = await started;
    expect(run).toMatchObject({ state: "finished", done: 3 });
    expect(c.states()).toEqual(["queued", "downloading", "finished"]);
  });

  it("Stop while waiting its turn ends the run stopped with nothing asked of the platform", async () => {
    const p = await project();
    let release: () => void = () => {};
    const turn = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let called: () => void = () => {};
    const waitingTurn = new Promise<void>((r) => (called = r));
    const c = control({ turn: () => (called(), turn) });
    const id = newRunId();
    const started = runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    await waitingTurn;
    c.ask("stop");
    const run = await started;
    expect(run).toMatchObject({ state: "stopped", total: 0, done: 0 });
    expect(runLines(run).title).toBe('"@fake.dancer" was stopped before it began.');
    expect(worker.submitted).toHaveLength(0);
    expect(c.states()).toEqual(["queued", "stopped"]);
    expect(await auditEvents(p.folder).then((a) => a.filter((e) => e.action === "capture"))).toHaveLength(0);
  });

  it("a queued run that is not held shows as interrupted before it began, and Resume starts it from the list", async () => {
    const prof = synthetic(3);
    const p = await project();
    let release: () => void = () => {};
    const turn = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let called: () => void = () => {};
    const waitingTurn = new Promise<void>((r) => (called = r));
    const c = control({ turn: () => (called(), turn) });
    const id = newRunId();
    const started = runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    await waitingTurn;
    c.cancel(); // a quit while it waited its turn
    await expect(started).rejects.toBeInstanceOf(CaptureCancelledError);
    expect(c.changes).toHaveLength(1);
    const shown = await runs.get(p.id, id, () => false);
    expect(shown).toMatchObject({ state: "interrupted", total: 0, notCompleted: 0 });
    expect(runLines(shown!).title).toBe("The capture of '@fake.dancer' was interrupted before it began.");
    expect(runLines(shown!).resume).toBe("Resume downloads");
    expect(worker.submitted).toHaveLength(0);

    const r = control();
    const run = await runs.resume(p.id, id, "researcher", r.ctl);
    expect(run).toMatchObject({ state: "finished", total: 3, done: 3, title: "Fake Dancer" });
    expect(itemDownloads()).toEqual(prof.items.map((it) => it.id));
    expect((await captureAllows(p.folder)).map((e) => (e.details as { op?: string }).op)).toEqual(["capture.profile.resume"]);
  });

  it("a Resume whose listing came back cut short leaves the videos past the cut to do and says why", async () => {
    const prof = synthetic(12);
    await setProfile(prof);
    const p = await project();
    const id = newRunId();
    const c = control({ onItem: (done) => (done === 2 ? c.ask("pause") : undefined) });
    expect(await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl)).toMatchObject({ state: "paused", total: 12, done: 2 });

    // the platform lists only the first five, then fails: the videos past the cut cannot be looked for
    await setProfile({ ...prof, cutAfter: 5 });
    process.env.FAKE_TOOL_MODE = "enumbroken";
    const cut = await runs.resume(p.id, id, "researcher", control().ctl);
    expect(cut).toMatchObject({ state: "failed", total: 12, done: 5, failed: 0, notCompleted: 7, reason: "The platform's list came back incomplete, so some videos could not be looked for." });
    expect(runLines(cut).why).toBe("The platform's list came back incomplete, so some videos could not be looked for.");
    expect(runLines(cut).resume).toBe("Resume downloads (7 did not complete)");
    expect((await readRunItems(repo, p.id, id)).map((i) => i.status)).toEqual([...Array(5).fill("done"), ...Array(7).fill("queued")]);
    const journal = (await readRunItems(repo, p.id, id)).filter((i) => i.item.errorCode);
    expect(journal).toHaveLength(0);

    // the whole list again: the rest is taken and the run finishes
    delete process.env.FAKE_TOOL_MODE;
    await setProfile(prof);
    expect(await runs.resume(p.id, id, "researcher", control().ctl)).toMatchObject({ state: "finished", total: 12, done: 12, failed: 0 });
  });

  it("a run that loses its connection for 12 hours ends failed with its reason and offers Resume downloads", async () => {
    process.env.FAKE_TOOL_MODE = "enumnetwork";
    const p = await project();
    const c = control();
    const run = await runs.start(p.id, newRunId(), TT_PROFILE, OPTS, c.ctl);
    expect(run).toMatchObject({ state: "failed", total: 0, reason: plainReason("NETWORK_LOST_GAVE_UP") });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(12 * 3600 * 1000); // every wait through the injected sleep
    expect(c.changes.filter((ch) => ch.state === "waiting").every((ch) => ch.wait?.why === "connection")).toBe(true);
    expect(runLines(run).why).toBe("The connection stayed lost for 12 hours, so the capture was paused.");
    expect(runLines(run).resume).toBe("Resume downloads");
  });

  it("stopNotRunning ends a paused run stopped and leaves a finished one as it is", async () => {
    const p = await project();
    const id = newRunId();
    const c = control({ onItem: (done) => (done === 1 ? c.ask("pause") : undefined) });
    await runs.start(p.id, id, TT_PROFILE, OPTS, c.ctl);
    expect(await runs.stopNotRunning(p.id, id)).toMatchObject({ state: "stopped", done: 1 });
    const done = newRunId();
    await runs.start(p.id, done, TT_PROFILE, OPTS, control().ctl);
    expect(await runs.stopNotRunning(p.id, done)).toMatchObject({ state: "finished" });
    expect(await runs.stopNotRunning(p.id, "no-such-run")).toBeUndefined();
  });

  it("estimate lists once, counts what is new and asks the project's rules first", async () => {
    const prof = synthetic(3);
    prof.items[0]!.duration = 600;
    await setProfile(prof);
    const p = await project();
    free = 380e9;
    const e = await runs.estimate(p.id, TT_PROFILE, OPTS);
    expect(e).toMatchObject({ kind: "profile", platform: "tiktok", title: "Fake Dancer", count: 3, alreadyInProject: 0, soundSeconds: 600, unknownLengths: 2, freeBytes: 380e9, videoToolsInstalled: null });
    expect(listings()).toBe(1);
    expect(itemDownloads()).toHaveLength(0);

    const denied = await project(GOV.replace("[downloader]", "[manual_upload]"));
    await expect(runs.estimate(denied.id, TT_PROFILE, OPTS)).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(listings()).toBe(1);
    expect((await auditEvents(denied.folder)).filter((x) => x.action === "capture").at(-1)?.decision?.result).toBe("deny");
  });
});
