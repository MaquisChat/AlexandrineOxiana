/**
 * Task 51 (R31): worker job records live in each project's job journal; the `jobs` table of
 * library.sqlite is a cache that a rebuild fills from the journals.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { INDEX_FILE, IndexHandle, createIndexSink, getMeta, rebuildIndex, setMeta } from "./index/index.js";
import {
  JOBS_FILE, appendJobRecords, assertNoSecrets, compactJobJournal, journalPath, readJobJournal, upgradeLegacyJobs, type JobRecord,
} from "./job-journal.js";
import { createLibrary, openLibrary, type Library } from "./library.js";
import type { Repo } from "./repo/index.js";
import { encryptBytes } from "./repo/io.js";
import { projectDataKey } from "./repo/repo.js";
import { openTestRepo } from "./repo/testing.js";
import { scanIncompleteLines } from "./repo/incomplete-lines.js";
import { WorkerClient, WorkerUnavailableError } from "./worker-client.js";
import { stubWorker as sharedStubWorker, type StubWorker } from "./worker-testing.js";

const TOKEN = "stub-token-0123456789";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const MARKER = "zebra-marker-7f3a9c";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
const closers: Array<() => Promise<void> | void> = [];

function deps(device = "dev-A"): Deps {
  return {
    clock: () => new Date(),
    deviceId: device,
    hostname: `host-${device}`,
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, `config-${device}`),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

const stubWorker = (onSubmit: Parameters<typeof sharedStubWorker>[0], opts: Parameters<typeof sharedStubWorker>[1] = {}) =>
  sharedStubWorker(onSubmit, { ...opts, token: TOKEN, closers });

/** A worker that writes the output file and finishes. */
const okWorker = () =>
  stubWorker(async (job) => {
    await mkdir(dirname(job.body.output), { recursive: true });
    await writeFile(job.body.output, "jpeg");
    return { status: "done", result: { output: job.body.output, meta: {} } };
  });

/** A worker address that refuses connections. */
async function downWorker(): Promise<StubWorker> {
  const w = await stubWorker(() => ({ status: "done" }));
  await closers.pop()!();
  return w;
}

const mkRepo = () => openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
const client = (worker: StubWorker) => new WorkerClient({ repo, worker, index: handle, pollMs: 5 });
const jobRows = () =>
  handle.db.prepare("SELECT id, project_id, kind, status, payload_json FROM jobs ORDER BY created_at, id").all() as Array<Record<string, string>>;

async function dropIndex(): Promise<void> {
  handle.close();
  for (const s of ["", "-wal", "-shm"]) await rm(join(lib.root, INDEX_FILE + s), { force: true });
  handle.reopen(); // the same handle: the repo's index sink keeps writing to it
}

async function indexBytes(): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const s of ["", "-wal", "-shm"]) parts.push(await readFile(join(lib.root, INDEX_FILE + s)).catch(() => Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** One finished job and one left pending (the worker was unreachable) in the project. */
async function finishedAndPending(projectId: string): Promise<{ done: string; pending: string; input: string; output: string }> {
  const input = join(tmp, "a.png");
  await writeFile(input, "png");
  const r = await client(await okWorker()).submit(projectId, { type: "image.proxy", input, output: join(tmp, "done.jpg"), params: { label: MARKER } });
  const output = join(tmp, "pending.jpg");
  await expect(client(await downWorker()).submit(projectId, { type: "image.proxy", input, output, params: { label: MARKER } })).rejects.toBeInstanceOf(
    WorkerUnavailableError,
  );
  const pending = jobRows().find((x) => x.status === "queued")!.id!;
  return { done: r.id, pending, input, output };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-job-journal-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await mkRepo();
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("job journal", () => {
  it("records every job in <Project>/jobs/journal.jsonl before its row; the newest line per id wins", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { done, pending } = await finishedAndPending(project.id);
    const j = await readJobJournal(lib.root, project.folder, project.id, null);
    expect([...j.records.values()].map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "queued"],
    ]);
    expect(j.records.get(done)!.job).toBeUndefined(); // a finished job keeps no paths
    expect(j.records.get(pending)!.job).toMatchObject({ type: "image.proxy", params: { label: MARKER } });
    // the cache row holds nothing but id, project, type, status and time
    expect(jobRows().map((r) => r.payload_json)).toEqual(["{}", "{}"]);
    expect((await indexBytes()).includes(MARKER)).toBe(false);
  });

  it("deleting library.sqlite loses nothing: rebuild restores the rows, the pending job is resubmitted, the finished one stays done", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { done, pending, output } = await finishedAndPending(project.id);
    await dropIndex();
    expect(jobRows()).toEqual([]);
    await rebuildIndex(handle, ring, lib);
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "queued"],
    ]);
    // resubmission works from the journal alone (a fresh, empty index too)
    await dropIndex();
    const w = await okWorker();
    const resumed = await client(w).resumePending();
    expect(resumed.map((r) => [r.id, r.error])).toEqual([[pending, undefined]]);
    expect(await readFile(output, "utf8")).toBe("jpeg");
    expect(w.jobs.size).toBe(1);
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "done"],
    ]);
  });

  it("encrypted project, unlocked: lines are sealed, nothing of the job reaches library.sqlite, rebuild and resubmission work", async () => {
    const { project } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const { done, pending } = await finishedAndPending(project.id);
    const raw = await readFile(journalPath(lib.root, project.folder));
    expect(raw.includes(MARKER)).toBe(false);
    expect(raw.includes("image.proxy")).toBe(false);
    expect((await indexBytes()).includes(MARKER)).toBe(false);
    await dropIndex();
    await rebuildIndex(handle, ring, lib);
    expect(jobRows().map((r) => [r.id, r.status, r.payload_json])).toEqual([
      [done, "done", "{}"],
      [pending, "queued", "{}"],
    ]);
    expect((await indexBytes()).includes(MARKER)).toBe(false);
    const resumed = await client(await okWorker()).resumePending();
    expect(resumed.map((r) => [r.id, r.error])).toEqual([[pending, undefined]]);
    expect((await indexBytes()).includes(MARKER)).toBe(false);
  });

  it("encrypted project that stays locked: its jobs are unknown to the index until it is unlocked, and nothing is lost", async () => {
    const { project } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const { done, pending } = await finishedAndPending(project.id);
    repo.lockProject(project.id);
    await dropIndex();
    await rebuildIndex(handle, ring, lib);
    expect(jobRows()).toEqual([]); // sealed: neither ids nor statuses can be read
    const w = await okWorker();
    expect(await client(w).resumePending()).toEqual([]); // nothing runs while locked
    expect(w.jobs.size).toBe(0);
    await repo.unlockProject(project.id, "pw");
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "queued"],
    ]);
    const resumed = await client(w).resumePending();
    expect(resumed.map((r) => [r.id, r.error])).toEqual([[pending, undefined]]);
  });

  it("an incomplete last line is ignored, trimmed at open, and the next append is whole", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { done, pending } = await finishedAndPending(project.id);
    const path = journalPath(lib.root, project.folder);
    const before = await readFile(path);
    await appendFile(path, '{"v":1,"id":"torn","projectId":');
    const j = await readJobJournal(lib.root, project.folder, project.id, null);
    expect(j.torn).toBe(true);
    expect([...j.records.keys()]).toEqual([done, pending]);
    await dropIndex();
    await rebuildIndex(handle, ring, lib);
    expect(jobRows().map((r) => r.id)).toEqual([done, pending]);
    // the open finds and trims it (R28)
    const lines = await scanIncompleteLines(lib.root, project.folder, true);
    expect(lines.map((l) => [l.file, l.trimmed])).toEqual([[`${project.folder}/${JOBS_FILE}`, true]]);
    expect(await readFile(path)).toEqual(before);
    // an append after a torn line (left by a failed append) cuts it off first
    await appendFile(path, '{"v":1,"id":"torn2"');
    await expect(client(await okWorker()).resumePending()).resolves.toHaveLength(1);
    const after = await readJobJournal(lib.root, project.folder, project.id, null);
    expect(after.torn).toBe(false);
    expect(after.unreadable).toEqual([]);
    expect(after.records.get(pending)!.status).toBe("done");
  });

  it("a crash between the journal append and the row: the next launch repairs the row from the journal", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { done, pending } = await finishedAndPending(project.id);
    const at = new Date().toISOString();
    // the journal says the pending job was cancelled, and knows a new queued job; the rows do not
    const p = (await readJobJournal(lib.root, project.folder, project.id, null)).records.get(pending)!;
    const cancelled: JobRecord = { v: 1, id: pending, projectId: project.id, kind: p.kind, status: "cancelled", createdAt: p.createdAt, updatedAt: at, error: "CANCELLED" };
    const fresh: JobRecord = { ...p, id: "job-after-crash", createdAt: at, updatedAt: at };
    await appendJobRecords(lib.root, project.folder, null, [cancelled, fresh]);
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "queued"],
    ]);
    const w = await okWorker();
    const resumed = await client(w).resumePending();
    expect(resumed.map((r) => r.id)).toEqual(["job-after-crash"]); // the cancelled one is not run
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "cancelled"],
      ["job-after-crash", "done"],
    ]);
  });

  it("compaction keeps the newest state of every job (and unreadable lines) and is atomic", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const key = projectDataKey(repo, project.id);
    const at = "2026-11-11T10:00:00.000Z";
    const recs: JobRecord[] = [];
    for (let i = 0; i < 40; i++) {
      for (const status of ["queued", "running", i % 2 ? "done" : "failed"] as const) {
        recs.push({ v: 1, id: `j${i}`, projectId: project.id, kind: "pdf.ocr", status, createdAt: at, updatedAt: at, ...(status === "failed" ? { error: "X" } : {}) });
      }
    }
    await appendJobRecords(lib.root, project.folder, key, recs);
    await appendFile(journalPath(lib.root, project.folder), "foreign-line\n");
    const before = await readJobJournal(lib.root, project.folder, project.id, key);
    expect(before.lines).toBe(121);
    expect(await compactJobJournal(lib.root, project.folder, project.id, key)).toBe(true);
    const after = await readJobJournal(lib.root, project.folder, project.id, key);
    expect(after.lines).toBe(41);
    expect(after.unreadable).toEqual(["foreign-line"]);
    expect([...after.records.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...before.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await compactJobJournal(lib.root, project.folder, project.id, key)).toBe(false); // nothing to gain
  });

  it("a job parameter named like a secret is refused and nothing is recorded", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    expect(() => assertNoSecrets({ cookiesFromBrowser: "firefox", quality: "best" })).not.toThrow();
    for (const params of [{ cookie: "sid=1" }, { nested: { apiKey: "k" } }, { Authorization: "Bearer x" }, { passphrase: "pw" }]) {
      await expect(client(await okWorker()).submit(project.id, { type: "image.proxy", input: join(tmp, "x"), output: join(tmp, "y.jpg"), params })).rejects.toBeInstanceOf(TypeError);
    }
    expect(jobRows()).toEqual([]);
    expect((await readJobJournal(lib.root, project.folder, project.id, null)).lines).toBe(0);
  });

  it("a read-only library writes neither journal nor row", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { pending } = await finishedAndPending(project.id);
    const path = journalPath(lib.root, project.folder);
    const before = await readFile(path);
    const ro = await openLibrary(lib.root, deps("dev-B"));
    expect(ro.mode).toBe("read-only");
    try {
      const roRepo = await openTestRepo(ro, new KeyRing(), { scryptN: 2 ** 10, actor: "tester" });
      const w = await okWorker();
      const c = new WorkerClient({ repo: roRepo, worker: w, pollMs: 5 });
      expect(await c.resumePending()).toEqual([]);
      expect(w.jobs.size).toBe(0);
      expect(await readFile(path)).toEqual(before);
      expect(jobRows().find((r) => r.id === pending)!.status).toBe("queued");
    } finally {
      await ro.close();
    }
  });
});

describe("upgrade of a library made before the journal", () => {
  /** Turns the database back into a schema-1 one holding job rows (as an older version wrote them). */
  async function legacyIndex(rows: Array<[string, string, string, string, string]>): Promise<void> {
    const db = handle.db;
    db.exec("CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, payload_json TEXT NOT NULL)");
    db.prepare("DELETE FROM meta WHERE key = 'jobsLegacy'").run();
    for (const [id, pid, kind, status, payload] of rows) {
      db.prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, pid, kind, status, payload, `2026-01-01T00:00:0${rows.findIndex((r) => r[0] === id)}.000Z`);
    }
    setMeta(db, "schemaVersion", "1");
    handle.reopen(); // migration 0002 runs
  }

  it("migration 0002 drops import_batches and marks existing job rows; a new database is not marked", async () => {
    expect(getMeta(handle.db, "schemaVersion")).toBe("2");
    const tables = () => (handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables()).not.toContain("import_batches");
    expect(getMeta(handle.db, "jobsLegacy")).toBeUndefined();
    await legacyIndex([["old", "p", "pdf.ocr", "done", "{}"]]);
    expect(getMeta(handle.db, "schemaVersion")).toBe("2");
    expect(tables()).not.toContain("import_batches");
    expect(getMeta(handle.db, "jobsLegacy")).toBe("1");
  });

  it("writes legacy rows into the journals once (plain now, encrypted when unlocked), then survives deleting library.sqlite", async () => {
    const { project: plain } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { project: enc } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const input = join(tmp, "a.png");
    await writeFile(input, "png");
    const job = (output: string) => ({ type: "image.proxy", input, output, params: { label: MARKER } });
    const k = projectDataKey(repo, enc.id)!;
    const sealed = JSON.stringify({ sealed: (await encryptBytes(k.key, k.keyId, JSON.stringify(job(join(tmp, "e.jpg"))))).toString("base64") });
    await legacyIndex([
      ["p-done", plain.id, "image.proxy", "done", "{}"],
      ["p-queued", plain.id, "image.proxy", "queued", JSON.stringify(job(join(tmp, "p.jpg")))],
      ["e-running", enc.id, "image.proxy", "running", sealed],
      ["gone", "no-such-project", "pdf.ocr", "queued", "{}"],
    ]);
    repo.lockProject(enc.id);

    // rebuild: the plain project's rows are written to its journal; the locked one's wait (kept)
    await rebuildIndex(handle, ring, lib);
    const pj = await readJobJournal(lib.root, plain.folder, plain.id, null);
    expect([...pj.records.values()].map((r) => [r.id, r.status])).toEqual([
      ["p-done", "done"],
      ["p-queued", "queued"],
    ]);
    expect(jobRows().map((r) => [r.id, r.status, r.payload_json])).toEqual([
      ["p-done", "done", "{}"],
      ["p-queued", "queued", "{}"],
      ["e-running", "running", sealed],
    ]);
    expect(getMeta(handle.db, "jobsLegacy")).toBe("1");
    // idempotent: running it again writes nothing twice
    await upgradeLegacyJobs(handle.db, lib.root, ring);
    expect((await readJobJournal(lib.root, plain.folder, plain.id, null)).lines).toBe(2);

    await repo.unlockProject(enc.id, "pw");
    expect(getMeta(handle.db, "jobsLegacy")).toBeUndefined();
    const ej = await readJobJournal(lib.root, enc.folder, enc.id, projectDataKey(repo, enc.id));
    expect(ej.records.get("e-running")).toMatchObject({ status: "running", job: { output: join(tmp, "e.jpg"), params: { label: MARKER } } });
    expect(jobRows().map((r) => r.payload_json)).toEqual(["{}", "{}", "{}"]);

    await dropIndex();
    await rebuildIndex(handle, ring, lib);
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      ["p-done", "done"],
      ["p-queued", "queued"],
      ["e-running", "running"],
    ]);
    const resumed = await client(await okWorker()).resumePending();
    expect(resumed.map((r) => [r.id, r.error]).sort()).toEqual([
      ["e-running", undefined],
      ["p-queued", undefined],
    ]);
  });
});
