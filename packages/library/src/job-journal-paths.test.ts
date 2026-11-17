/**
 * R379 (FR-A15): the job journal stores no absolute path. A pending job's input and output are kept
 * relative to the library root and resolved against the root of the moment the job runs; a file
 * linked in place from outside the library is kept as the asset it is (its path is read from the
 * asset's record). Lines written before this (absolute paths) still resume.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, type Project, type SourceFile } from "@ao/core";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { OPEN_GOV, PASS, addSource, type Kit } from "./export/test-kit.js";
import { OcrQueue } from "./import/ocr.js";
import { ProxyQueue } from "./import/proxies.js";
import { openIndex } from "./index/db.js";
import { appendJobRecords, journalPath, markLegacyJobs, readJobJournal, upgradeLegacyJobs, type JobRecord } from "./job-journal.js";
import { createLinkCapture } from "./capture/link-capture.js";
import { createLibrary, openLibrary, type Library } from "./library.js";
import { editPendingProxies, projectDataKey, relinkLinkedAsset, type Repo } from "./repo/repo.js";
import { openTestRepo } from "./repo/testing.js";
import { transcriptionJob, transcriptionRerun } from "./transcription-jobs.js";
import { WorkerClient, WorkerJobError, WorkerUnavailableError } from "./worker-client.js";
import { stubWorker, type StubJob, type StubWorker } from "./worker-testing.js";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
const closers: Array<() => Promise<void> | void> = [];
const clock = { now: new Date("2026-11-17T09:30:00.000Z") };

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

const openRepo = (l: Library) => openTestRepo(l, ring, { scryptN: 2 ** 10, actor: "tester", tz: "UTC" });
const kit = (): Kit => ({ repo, clock }) as unknown as Kit;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-job-paths-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openRepo(lib);
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function makeProject(encrypted: boolean): Promise<Project> {
  const r = await repo.createProject({
    name: `P${Math.random().toString(36).slice(2, 7)}`,
    governanceYaml: OPEN_GOV,
    encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false },
  });
  return r.project;
}

/** A file outside the library (what a researcher adds or links). */
async function outsideFile(name: string, data: string | Uint8Array): Promise<string> {
  const path = join(tmp, "in", Math.random().toString(36).slice(2, 8), name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

async function withOriginal(p: Project, name: string, data: string | Uint8Array, handling: "copy" | "link" = "copy"): Promise<SourceFile> {
  return addSource(kit(), p, { title: name, files: [{ path: await outsideFile(name, data), role: "original", handling }] });
}

/** A worker address that refuses connections (jobs stay pending). */
async function downWorker(): Promise<StubWorker> {
  const w = await stubWorker(() => ({ status: "done" }), { closers });
  await closers.pop()!();
  return w;
}

/** A worker that, like the real one, fails a job whose input does not exist, else writes its output. */
const okWorker = (seen: StubJob[] = []) =>
  stubWorker(
    async (job) => {
      seen.push(job);
      if (!existsSync(job.body.input)) return { status: "failed", error: { code: "INPUT_NOT_FOUND", message: "the input file does not exist" } };
      await mkdir(dirname(job.body.output), { recursive: true });
      await writeFile(job.body.output, "out");
      return { status: "done", result: { output: job.body.output, meta: {} } };
    },
    { closers },
  );

const clientOf = (worker: StubWorker, r: Repo = repo) => new WorkerClient({ repo: r, worker, pollMs: 5 });

/** Every string anywhere in a value. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

/** The journal's records (opened with the key in an encrypted project), and its raw text. */
async function journalOf(p: Project, root = lib.root, r: Repo = repo): Promise<{ text: string; records: JobRecord[] }> {
  const text = await readFile(journalPath(root, p.folder), "utf8");
  const records = [...(await readJobJournal(root, p.folder, p.id, projectDataKey(r, p.id))).records.values()];
  return { text, records };
}

/** The journal holds no absolute path: not the library's root, not the temporary folder, no string starting with "/". */
async function expectNoAbsolutePath(p: Project): Promise<JobRecord[]> {
  const { text, records } = await journalOf(p);
  const opened = JSON.stringify(records);
  for (const t of [text, opened]) {
    expect(t).not.toContain(lib.root);
    expect(t).not.toContain(tmp);
  }
  expect(strings(records).filter((s) => s.startsWith("/"))).toEqual([]);
  const pending = records.filter((r) => r.job);
  expect(pending.length).toBeGreaterThan(0);
  return records;
}

describe("R379: the journal of a submitted job holds library-relative paths only", () => {
  for (const encrypted of [false, true]) {
    const kind = encrypted ? "an encrypted project (the opened lines)" : "a plain project";

    it(`a viewing proxy, in ${kind}`, async () => {
      const p = await makeProject(encrypted);
      const sf = await withOriginal(p, "photo.png", "png");
      const asset = sf.assets[0]!;
      await editPendingProxies(repo, p.id, sf.source.id, (list) => [
        ...list,
        { id: newId(), type: "image.proxy", assetId: asset.id, location: "keep", queuedAt: new Date().toISOString() },
      ]);
      const queue = new ProxyQueue({ repo, worker: clientOf(await downWorker()), attempts: 1 });
      expect((await queue.resumePending(p.id)).map((r) => r.code)).toEqual(["PENDING"]);
      const recs = await expectNoAbsolutePath(p);
      expect(recs[0]!.job).toMatchObject({ type: "image.proxy", input: asset.path });
      expect(recs[0]!.job!.output).toMatch(/^\.tmp\/worker-proxy-[0-9a-f-]+\/proxy\.jpg$/);
    });

    it(`text recognition, in ${kind}`, async () => {
      const p = await makeProject(encrypted);
      const sf = await withOriginal(p, "scan.pdf", "%PDF-1.4\n%%EOF\n");
      const queue = new OcrQueue({ repo, attempts: 1 });
      expect(await queue.enqueue(p.id, sf.source.id)).toBe(1);
      queue.setWorker(clientOf(await downWorker()));
      await queue.resumePending(p.id);
      const recs = await expectNoAbsolutePath(p);
      expect(recs[0]!.job).toMatchObject({ type: "pdf.ocr", input: sf.assets[0]!.path });
      expect(recs[0]!.job!.output).toMatch(/^\.tmp\/worker-ocr-[0-9a-f-]+\/ocr\.pdf$/);
    });

    it(`a transcription, in ${kind}`, async () => {
      const p = await makeProject(encrypted);
      const sf = await withOriginal(p, "talk.mp3", Buffer.alloc(64, 1));
      const id = randomUUID();
      const job = await transcriptionJob(repo, p.id, sf.source.id, { model: "small" }, { id });
      await expect(clientOf(await downWorker()).submit(p.id, job)).rejects.toBeInstanceOf(WorkerUnavailableError);
      const recs = await expectNoAbsolutePath(p);
      expect(recs[0]!.job).toMatchObject({ type: "audio.transcribe", input: sf.assets[0]!.path, output: `.tmp/worker-${id}/transcript` });
    });
  }
});

describe("R379: a pending job resumes against the library's current place", () => {
  it("the library is moved with a job pending: the resume finds the input under the new root and the job completes", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const asset = sf.assets[0]!;
    const work = join(lib.root, ".tmp", `worker-proxy-${randomUUID()}`);
    await expect(
      clientOf(await downWorker()).submit(p.id, { type: "image.proxy", input: join(lib.root, ...asset.path.split("/")), output: join(work, "proxy.jpg"), params: {} }),
    ).rejects.toBeInstanceOf(WorkerUnavailableError);
    const oldRoot = lib.root;
    await lib.close();
    const newRoot = join(tmp, "Elsewhere", "Moved Lib");
    await mkdir(dirname(newRoot), { recursive: true });
    await rename(oldRoot, newRoot);
    lib = await openLibrary(newRoot, deps());
    repo = await openRepo(lib);
    const seen: StubJob[] = [];
    const out = await clientOf(await okWorker(seen)).resumePending();
    expect(out.map((x) => x.error)).toEqual([undefined]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.input).toBe(join(newRoot, ...asset.path.split("/")));
    expect(out[0]!.result!.output.startsWith(newRoot)).toBe(true);
    const recs = (await journalOf(p, newRoot)).records;
    expect(recs.map((r) => r.status)).toEqual(["done"]);
  });
});

describe("R379: a file linked in place is kept as its asset, never as a path", () => {
  it("no path in the journal; the job runs on the linked file; after a relink a resumed job uses the new place", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "linked.png", "png", "link");
    const asset = sf.assets[0]!;
    expect(asset.linked).toBeDefined();
    await editPendingProxies(repo, p.id, sf.source.id, (list) => [
      ...list,
      { id: newId(), type: "image.proxy", assetId: asset.id, location: "keep", queuedAt: new Date().toISOString() },
    ]);
    const queue = new ProxyQueue({ repo, worker: clientOf(await downWorker()), attempts: 1 });
    expect((await queue.resumePending(p.id)).map((r) => r.code)).toEqual(["PENDING"]);
    const recs = await expectNoAbsolutePath(p);
    expect(recs[0]!.job).toMatchObject({ input: "", inputAsset: { sourceId: sf.source.id, assetId: asset.id } });
    expect(JSON.stringify(recs)).not.toContain(asset.linked!.libraryRelativePath);

    // The linked file moves (into the library's folder) and the asset is relinked to it.
    const moved = join(lib.root, "Relinked", "linked.png");
    await mkdir(dirname(moved), { recursive: true });
    await rename(asset.linked!.absolutePath, moved);
    await relinkLinkedAsset(repo, p.id, sf.source.id, asset.id, "Relinked/linked.png");
    const seen: StubJob[] = [];
    const out = await clientOf(await okWorker(seen)).resumePending(p.id);
    expect(out.map((x) => x.error)).toEqual([undefined]);
    expect(seen.map((j) => j.body.input)).toEqual([moved]);
    expect(strings((await journalOf(p)).records).filter((s) => s.startsWith("/"))).toEqual([]);
  });

  it("a linked file's job submitted directly runs on the linked file, and its lines hold only the asset", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "linked.png", "png", "link");
    const asset = sf.assets[0]!;
    const seen: StubJob[] = [];
    const r = await clientOf(await okWorker(seen)).submit(p.id, {
      type: "image.proxy",
      input: asset.linked!.absolutePath,
      inputAsset: { sourceId: sf.source.id, assetId: asset.id },
      output: join(lib.root, ".tmp", `worker-proxy-${randomUUID()}`, "proxy.jpg"),
      params: {},
    });
    expect(seen.map((j) => j.body.input)).toEqual([asset.linked!.absolutePath]);
    expect(r.files).toHaveLength(1);
    const { text } = await journalOf(p);
    expect(text).not.toContain(tmp);
    expect(text).toContain(asset.id);
  });

  it("a path neither inside the library nor a linked asset's is refused, naming no path; nothing is recorded or sent", async () => {
    const p = await makeProject(false);
    const copied = await withOriginal(p, "copied.png", "png");
    const outside = await outsideFile("stray.png", "png");
    const seen: StubJob[] = [];
    const c = clientOf(await okWorker(seen));
    const inLib = join(lib.root, ...copied.assets[0]!.path.split("/"));
    const out = join(lib.root, ".tmp", "worker-proxy-x", "proxy.jpg");
    const cases = [
      { type: "image.proxy" as const, input: outside, output: out, params: {} },
      // an asset that is not linked does not make an outside path acceptable
      { type: "image.proxy" as const, input: outside, inputAsset: { sourceId: copied.source.id, assetId: copied.assets[0]!.id }, output: out, params: {} },
      { type: "image.proxy" as const, input: inLib, output: join(tmp, "elsewhere", "proxy.jpg"), params: {} },
      { type: "image.proxy" as const, input: join(lib.root, "..", "Lib", "..", "x.png"), output: out, params: {} },
    ];
    for (const job of cases) {
      const err = await c.submit(p.id, job).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).not.toContain(tmp);
      expect((err as Error).message).not.toContain("/");
    }
    expect(seen).toEqual([]);
    expect(existsSync(journalPath(lib.root, p.folder))).toBe(false);
  });
});

describe("R379: lines written before (absolute paths) still resume", () => {
  const oldLine = (p: Project, input: string, output: string, extra: Partial<JobRecord> = {}): JobRecord => ({
    v: 1,
    id: randomUUID(),
    projectId: p.id,
    kind: "image.proxy",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    job: { type: "image.proxy", input, output, params: {} },
    ...extra,
  });

  it("an old line inside the current root runs, and its next line is written relative", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const input = join(lib.root, ...sf.assets[0]!.path.split("/"));
    const rec = oldLine(p, input, join(lib.root, ".tmp", "worker-proxy-old", "proxy.jpg"));
    await appendJobRecords(lib.root, p.folder, null, [rec]);
    const seen: StubJob[] = [];
    const out = await clientOf(await okWorker(seen)).resumePending(p.id);
    expect(out.map((x) => x.error)).toEqual([undefined]);
    expect(seen.map((j) => j.body.input)).toEqual([input]);
    const lines = (await readFile(journalPath(lib.root, p.folder), "utf8")).split("\n").filter(Boolean);
    // Every line after the old one (the claim, running, done) holds no absolute path.
    for (const l of lines.slice(1)) expect(l).not.toContain(lib.root);
    const claim = JSON.parse(lines[1]!) as JobRecord;
    expect(claim.job).toMatchObject({ input: sf.assets[0]!.path, output: ".tmp/worker-proxy-old/proxy.jpg" });
  });

  it("an old line outside the current root (the library was moved) that cannot be re-derived fails as a missing input; nothing throws", async () => {
    const p = await makeProject(false);
    const rec = oldLine(p, "/Users/someone/Old Library/P/original/photo.png", "/Users/someone/Old Library/.tmp/worker-proxy-old/proxy.jpg");
    await appendJobRecords(lib.root, p.folder, null, [rec]);
    const seen: StubJob[] = [];
    const out = await clientOf(await okWorker(seen)).resumePending(p.id);
    expect(seen).toEqual([]); // never sent to the worker: the old place is not this library
    expect(out).toHaveLength(1);
    expect(out[0]!.error).toBeInstanceOf(WorkerJobError);
    expect(out[0]!.error).toMatchObject({ code: "INPUT_NOT_FOUND", message: "the input file does not exist" });
    const after = (await journalOf(p)).records;
    expect(after.map((r) => [r.status, r.error, r.job])).toEqual([["failed", "INPUT_NOT_FOUND", undefined]]);
    // Asked again: nothing more happens.
    expect(await clientOf(await okWorker(seen)).resumePending(p.id)).toEqual([]);
  });

  it("an old transcription line outside the current root is re-derived from its source and completes", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "talk.mp3", Buffer.alloc(64, 1));
    const id = randomUUID();
    const rec = oldLine(p, "/Users/someone/Old Library/P/original/talk.mp3", `/Users/someone/Old Library/.tmp/worker-${id}/transcript`, {
      id,
      kind: "audio.transcribe",
      about: { sourceId: sf.source.id, model: "small" },
    });
    rec.job = { type: "audio.transcribe", input: rec.job!.input, output: rec.job!.output, params: { model: "small" }, entity: { type: "asset", id: sf.assets[0]!.id } };
    await appendJobRecords(lib.root, p.folder, null, [rec]);
    const seen: StubJob[] = [];
    const w = await stubWorker(
      async (job) => {
        seen.push(job);
        await mkdir(job.body.output, { recursive: true });
        await writeFile(join(job.body.output, "segments.json"), JSON.stringify([{ start: 0, end: 1, text: "Hi.", lang: "en", flags: [] }]));
        await writeFile(join(job.body.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi.\n");
        return { status: "done", result: { output: job.body.output, meta: { model: "small", detectedLanguages: ["en"], flaggedCount: 0 } } };
      },
      { closers },
    );
    const out = await clientOf(w).resumePending(p.id, { prepare: (r) => transcriptionRerun(repo, r) });
    expect(out.map((x) => x.error)).toEqual([undefined]);
    expect(seen.map((j) => j.body.input)).toEqual([join(lib.root, ...sf.assets[0]!.path.split("/"))]);
  });

  it("legacy job rows (from before the journal) are written into it relative; one outside the root is recorded failed", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const db = openIndex(lib.root);
    closers.push(() => void db.close());
    markLegacyJobs(db);
    const inside = randomUUID();
    const outside = randomUUID();
    const insert = db.prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const at = new Date().toISOString();
    insert.run(inside, p.id, "image.proxy", "queued", JSON.stringify({ type: "image.proxy", input: join(lib.root, ...sf.assets[0]!.path.split("/")), output: join(lib.root, ".tmp", "w", "p.jpg"), params: {} }), at);
    insert.run(outside, p.id, "image.proxy", "queued", JSON.stringify({ type: "image.proxy", input: "/Users/someone/Old/x.png", output: "/Users/someone/Old/.tmp/w/p.jpg", params: {} }), at);
    const r = await upgradeLegacyJobs(db, lib.root, ring);
    expect(r.migrated).toBe(2);
    const { text, records } = await journalOf(p);
    expect(text).not.toContain(lib.root);
    expect(text).not.toContain("/Users/");
    const byId = new Map(records.map((x) => [x.id, x]));
    expect(byId.get(inside)!.job).toMatchObject({ input: sf.assets[0]!.path, output: ".tmp/w/p.jpg" });
    expect([byId.get(outside)!.status, byId.get(outside)!.error, byId.get(outside)!.job]).toEqual(["failed", "INPUT_NOT_FOUND", undefined]);
  });
});

/** A worker that writes a transcript (segments and .vtt) into the job's output folder, failing a missing input as the real one does. */
const transcriptWorker = (seen: StubJob[] = []) =>
  stubWorker(
    async (job) => {
      seen.push(job);
      if (!existsSync(job.body.input)) return { status: "failed", error: { code: "INPUT_NOT_FOUND", message: "the input file does not exist" } };
      await mkdir(job.body.output, { recursive: true });
      await writeFile(join(job.body.output, "segments.json"), JSON.stringify([{ start: 0, end: 1, text: "Hi.", lang: "en", flags: [] }]));
      await writeFile(join(job.body.output, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi.\n");
      return { status: "done", result: { output: job.body.output, meta: { model: "small", detectedLanguages: ["en"], flaggedCount: 0 } } };
    },
    { closers },
  );

describe("R400 (a): `ao transcribe` (link capture's transcribeSource) on a recording", () => {
  for (const handling of ["link", "copy"] as const) {
    it(`${handling === "link" ? "linked in place" : "stored in the library"}: the job is submitted, the journal holds no path for it, the transcript is made`, async () => {
      const p = await makeProject(false);
      const sf = await withOriginal(p, "talk.mp3", Buffer.alloc(64, 1), handling);
      const media = sf.assets[0]!;
      expect(!!media.linked).toBe(handling === "link");
      const seen: StubJob[] = [];
      const capture = createLinkCapture({ repo, worker: clientOf(await transcriptWorker(seen)) });
      const r = await capture.transcribeSource(p.id, sf.source.id, { model: "small" });
      expect(seen.map((j) => j.body.input)).toEqual([handling === "link" ? media.linked!.absolutePath : join(lib.root, ...media.path.split("/"))]);
      expect(r.files).toHaveLength(2);
      const after = await repo.getSource(p.id, sf.source.id);
      expect(after.assets.filter((a) => a.kind === "transcript")).toHaveLength(2);
      const { text, records } = await journalOf(p);
      expect(text).not.toContain(lib.root);
      expect(text).not.toContain(tmp);
      if (handling === "link") expect(text).not.toContain(media.linked!.libraryRelativePath);
      expect(records.map((x) => x.status)).toEqual(["done"]);
    });
  }
});

/** A pending line as this code writes it (library-relative paths), written by hand. */
const relLine = (p: Project, input: string, output: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  v: 1,
  id: randomUUID(),
  projectId: p.id,
  kind: "image.proxy",
  status: "queued",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  job: { type: "image.proxy", input, output, params: {} },
  ...extra,
});

/** Resumes the project's jobs with a worker that would write any output; asserts each line failed once as a missing input and nothing was sent. */
async function expectEachRefused(p: Project, recs: JobRecord[]): Promise<void> {
  await appendJobRecords(lib.root, p.folder, null, recs);
  const seen: StubJob[] = [];
  const out = await clientOf(await okWorker(seen)).resumePending(p.id);
  expect(seen).toEqual([]);
  expect(out).toHaveLength(recs.length);
  for (const o of out) {
    expect(o.error).toBeInstanceOf(WorkerJobError);
    expect(o.error).toMatchObject({ code: "INPUT_NOT_FOUND", message: "the input file does not exist" });
    expect((o.error as Error).message).not.toContain("/");
  }
  const after = (await journalOf(p)).records;
  expect(after.map((r) => [r.status, r.error, r.job])).toEqual(recs.map(() => ["failed", "INPUT_NOT_FOUND", undefined]));
  // Not retried at the next launch.
  expect(await clientOf(await okWorker(seen)).resumePending(p.id)).toEqual([]);
  expect(seen).toEqual([]);
}

describe("R400 (b): a job reads only inside the library (by real path) and writes only into its work folder", () => {
  it("stored outputs outside `.tmp` or through a link to outside, and an input through such a link, are refused; nothing is touched or written outside", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const input = sf.assets[0]!.path;
    const outside = join(tmp, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "y.png"), "png");
    await symlink(outside, join(lib.root, "escape"));
    await mkdir(join(lib.root, ".tmp"), { recursive: true });
    await symlink(outside, join(lib.root, ".tmp", "esc"));
    const libraryJson = await readFile(join(lib.root, "library.json"));
    await writeFile(join(lib.root, p.folder, "source-overwrite.json"), "keep");
    await expectEachRefused(p, [
      relLine(p, input, "library.json"),
      relLine(p, input, `${p.folder}/source-overwrite.json`),
      relLine(p, input, "escape/x.jpg"),
      relLine(p, input, ".tmp/esc/x.jpg"),
      relLine(p, "escape/y.png", ".tmp/worker-proxy-a/proxy.jpg"),
    ]);
    expect(await readFile(join(lib.root, "library.json"))).toEqual(libraryJson);
    expect(await readFile(join(lib.root, p.folder, "source-overwrite.json"), "utf8")).toBe("keep");
    expect((await readdir(outside)).sort()).toEqual(["y.png"]);
  });

  it("at submit: an output outside `.tmp`, or through a link to outside, and an input through such a link are refused (TypeError, no path); nothing recorded or sent", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const input = join(lib.root, ...sf.assets[0]!.path.split("/"));
    const outside = join(tmp, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "y.png"), "png");
    await symlink(outside, join(lib.root, "escape"));
    await mkdir(join(lib.root, ".tmp"), { recursive: true });
    await symlink(outside, join(lib.root, ".tmp", "esc"));
    const seen: StubJob[] = [];
    const c = clientOf(await okWorker(seen));
    const cases = [
      { input, output: join(lib.root, "library.json") },
      { input, output: join(lib.root, p.folder, "x.json") },
      { input, output: join(lib.root, "escape", "x.jpg") },
      { input, output: join(lib.root, ".tmp", "esc", "x.jpg") },
      { input, output: join(lib.root, ".tmp", "x.jpg") },
      { input: join(lib.root, "escape", "y.png"), output: join(lib.root, ".tmp", "worker-proxy-b", "proxy.jpg") },
    ];
    for (const job of cases) {
      const err = await c.submit(p.id, { type: "image.proxy", ...job, params: {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).not.toContain("/");
    }
    expect(seen).toEqual([]);
    expect(existsSync(journalPath(lib.root, p.folder))).toBe(false);
    expect((await readdir(outside)).sort()).toEqual(["y.png"]);
  });
});

describe("R400 (c): a stored path holding a control character is refused before anything is sent", () => {
  it("NUL, C0 and C1 characters in a stored input or output (relative or old absolute): failed once as a missing input, no path in the error", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    const input = sf.assets[0]!.path;
    const out = ".tmp/worker-proxy-c/proxy.jpg";
    const recs: JobRecord[] = [];
    for (const c of ["\u0000", "\u0001", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      recs.push(relLine(p, input, `.tmp/worker-proxy-c/a${c}/x.jpg`));
      recs.push(relLine(p, `${input}${c}`, out));
    }
    recs.push(relLine(p, join(lib.root, ...input.split("/")) + "\u0000", join(lib.root, ".tmp", "w", "x.jpg")));
    recs.push(relLine(p, join(lib.root, ...input.split("/")), join(lib.root, ".tmp", "w\u0000", "x.jpg")));
    await expectEachRefused(p, recs);
    expect(existsSync(join(lib.root, ".tmp", "worker-proxy-c"))).toBe(false);
  });

  it("an error Node raises while a line is resumed (it quotes the path) is returned without the path", async () => {
    const p = await makeProject(false);
    const sf = await withOriginal(p, "photo.png", "png");
    await appendJobRecords(lib.root, p.folder, null, [relLine(p, sf.assets[0]!.path, ".tmp/worker-proxy-d/proxy.jpg")]);
    const out = await clientOf(await okWorker()).resumePending(p.id, { prepare: async () => (await readFile(join(lib.root, "no-such-file")), {}) });
    expect(out).toHaveLength(1);
    expect(out[0]!.error).toBeInstanceOf(Error);
    expect(String((out[0]!.error as Error).message)).not.toContain(lib.root);
    expect((out[0]!.error as { path?: unknown }).path).toBeUndefined();
  });
});
