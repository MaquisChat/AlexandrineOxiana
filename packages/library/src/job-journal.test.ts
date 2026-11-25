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
  JOBS_FILE, MAX_FAILED_KEPT, MAX_SUCCEEDED_KEPT, SUCCEEDED_MAX_AGE_DAYS, appendJobRecords, assertNoSecrets, claimJobRecord, compactJobJournal,
  journalPath, readJobJournal, refreshJobRows, upgradeLegacyJobs, upsertJobRow, type JobRecord,
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
/** A folder inside the library for the jobs' inputs and outputs. */
let files: string;
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
  const input = join(files, "a.png");
  await writeFile(input, "png");
  const r = await client(await okWorker()).submit(projectId, { type: "image.proxy", input, output: join(files, "done.jpg"), params: { label: MARKER } });
  const output = join(files, "pending.jpg");
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
  // Job inputs and outputs live in the library's work folder (R379: the journal stores no absolute
  // path; R400 b: a job writes only below `.tmp`).
  files = join(lib.root, ".tmp", "test-files");
  await mkdir(files, { recursive: true });
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
    const c = client(w);
    expect(await c.resumePending()).toEqual([]); // nothing runs while locked
    expect(w.jobs.size).toBe(0);
    // the unlock loads the rows from the journal; the app then resubmits the project's pending job (R142)
    await repo.unlockProject(project.id, "pw");
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "queued"],
    ]);
    await c.resumePending(project.id);
    expect(jobRows().map((r) => [r.id, r.status])).toEqual([
      [done, "done"],
      [pending, "done"],
    ]);
    expect(w.jobs.size).toBe(1);
    expect(await client(w).resumePending()).toEqual([]);
    expect(w.jobs.size).toBe(1);
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
    expect(await compactJobJournal(lib.root, project.folder, project.id, key, undefined, Date.parse(at))).toBe(true);
    const after = await readJobJournal(lib.root, project.folder, project.id, key);
    expect(after.lines).toBe(41);
    expect(after.unreadable).toEqual(["foreign-line"]);
    expect([...after.records.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...before.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await compactJobJournal(lib.root, project.folder, project.id, key, undefined, Date.parse(at))).toBe(false); // nothing to gain
  });

  it("a job parameter named like a secret is refused and nothing is recorded", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    expect(() => assertNoSecrets({ cookiesFromBrowser: "firefox", quality: "best" })).not.toThrow();
    for (const params of [{ cookie: "sid=1" }, { nested: { apiKey: "k" } }, { Authorization: "Bearer x" }, { passphrase: "pw" }]) {
      await expect(client(await okWorker()).submit(project.id, { type: "image.proxy", input: join(files, "x"), output: join(files, "y.jpg"), params })).rejects.toBeInstanceOf(TypeError);
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
  /** Turns the database back into a schema-2 one (before the journal) holding job rows (as an older version wrote them). */
  async function legacyIndex(rows: Array<[string, string, string, string, string]>): Promise<void> {
    const db = handle.db;
    db.exec("CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, payload_json TEXT NOT NULL)");
    db.prepare("DELETE FROM meta WHERE key = 'jobsLegacy'").run();
    for (const [id, pid, kind, status, payload] of rows) {
      db.prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, pid, kind, status, payload, `2026-01-01T00:00:0${rows.findIndex((r) => r[0] === id)}.000Z`);
    }
    setMeta(db, "schemaVersion", "2");
    handle.reopen(); // migration 0003 runs
  }

  it("migration 0003 drops import_batches and marks existing job rows; a new database is not marked", async () => {
    expect(getMeta(handle.db, "schemaVersion")).toBe("3");
    const tables = () => (handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables()).not.toContain("import_batches");
    expect(getMeta(handle.db, "jobsLegacy")).toBeUndefined();
    await legacyIndex([["old", "p", "pdf.ocr", "done", "{}"]]);
    expect(getMeta(handle.db, "schemaVersion")).toBe("3");
    expect(tables()).not.toContain("import_batches");
    expect(getMeta(handle.db, "jobsLegacy")).toBe("1");
  });

  it("writes legacy rows into the journals once (plain now, encrypted when unlocked), then survives deleting library.sqlite", async () => {
    const { project: plain } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const { project: enc } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const input = join(files, "a.png");
    await writeFile(input, "png");
    const job = (output: string) => ({ type: "image.proxy", input, output, params: { label: MARKER } });
    const k = projectDataKey(repo, enc.id)!;
    const sealed = JSON.stringify({ sealed: (await encryptBytes(k.key, k.keyId, JSON.stringify(job(join(files, "e.jpg"))))).toString("base64") });
    await legacyIndex([
      ["p-done", plain.id, "image.proxy", "done", "{}"],
      ["p-queued", plain.id, "image.proxy", "queued", JSON.stringify(job(join(files, "p.jpg")))],
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
    expect(ej.records.get("e-running")).toMatchObject({ status: "running", job: { output: ".tmp/test-files/e.jpg", params: { label: MARKER } } });
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

describe("R142: a lock while a job runs", () => {
  /** An encrypted project, an encrypted input, and the key (copied) to read outputs with. */
  async function encryptedJob() {
    const { project } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const k = projectDataKey(repo, project.id)!;
    const key = { key: Uint8Array.from(k.key), keyId: k.keyId };
    const input = join(files, "a.png.enc");
    await writeFile(input, await encryptBytes(key.key, key.keyId, "png"));
    return { project, key, input };
  }
  const journalOf = async (project: { id: string; folder: string }) =>
    readJobJournal(lib.root, project.folder, project.id, projectDataKey(repo, project.id));

  it("a lock while the job runs: it finishes with the key it captured, is recorded done once, and never runs again", async () => {
    const { project, key, input } = await encryptedJob();
    const w = await stubWorker(
      async (job) => {
        await mkdir(dirname(job.body.output), { recursive: true });
        await writeFile(job.body.output, "jpeg");
        return { status: "done", result: { output: job.body.output, meta: {} } };
      },
      { pollsUntilDone: 3 },
    );
    const c = client(w);
    let heldWhileRunning = -1;
    const output = join(files, "out", "p.jpg");
    const r = await c.submit(project.id, {
      type: "image.proxy", input, inputEncrypted: true, output, params: {},
      onProgress: () => {
        if (heldWhileRunning === -1) heldWhileRunning = c.heldKeys;
        if (repo.isUnlocked(project.id)) repo.lockProject(project.id);
      },
    });
    expect(repo.isUnlocked(project.id)).toBe(false);
    expect(heldWhileRunning).toBe(1);
    expect(c.heldKeys).toBe(0); // dropped when the job ended
    // the real result, published once, readable with the project key
    expect(r.encrypted).toBe(true);
    const { decryptBytes } = await import("./repo/io.js");
    expect((await decryptBytes((id) => (id === key.keyId ? key.key : undefined), await readFile(output))).toString("utf8")).toBe("jpeg");
    expect(jobRows().map((x) => x.status)).toEqual(["done"]);
    // no second run, neither at the next launch nor after unlock
    const later = client(await okWorker());
    expect(await later.resumePending()).toEqual([]);
    await repo.unlockProject(project.id, "pw");
    expect(await later.resumePending(project.id)).toEqual([]);
    expect(await later.resumePending()).toEqual([]);
    expect(w.jobs.size).toBe(1);
    const j = await journalOf(project);
    expect([...j.records.values()].map((x) => x.status)).toEqual(["done"]);
  });

  it("a lock before the job runs: the worker job is cancelled, recorded cancelled-locked, and resubmitted once at unlock", async () => {
    const { project, input } = await encryptedJob();
    let first = true;
    const w = await stubWorker(async (job) => {
      if (first) {
        first = false;
        repo.lockProject(project.id); // the lock lands while the worker accepts the job
      }
      await mkdir(dirname(job.body.output), { recursive: true });
      await writeFile(job.body.output, "jpeg");
      return { status: "done", result: { output: job.body.output, meta: {} } };
    }, { pollsUntilDone: 3 });
    const c = client(w);
    const err = await c.submit(project.id, { type: "image.proxy", input, inputEncrypted: true, output: join(files, "o.jpg"), params: {} }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("ProjectLockedError");
    expect(w.requests).toContain("POST /jobs/j1/cancel");
    expect(c.heldKeys).toBe(0);
    expect(jobRows().map((x) => [x.status, x.payload_json])).toEqual([["cancelled", '{"error":"PROJECT_LOCKED"}']]);
    // still locked: nothing runs at a launch
    expect(await client(w).resumePending()).toEqual([]);
    await repo.unlockProject(project.id, "pw");
    await client(w).resumePending(project.id); // what the app runs at an unlock
    expect([...w.jobs.keys()]).toEqual(["j1", "j2"]); // resubmitted exactly once
    expect(jobRows().map((x) => x.status)).toEqual(["done"]);
    expect(await client(w).resumePending()).toEqual([]);
    expect(w.jobs.size).toBe(2);
    expect([...(await journalOf(project)).records.values()].map((x) => x.status)).toEqual(["done"]);
  });

  it("the captured key is dropped after a failure and after a cancellation", async () => {
    const { project, input } = await encryptedJob();
    const failing = client(await stubWorker(() => ({ status: "failed", error: { code: "UNSUPPORTED_INPUT", message: "no" } })));
    await expect(failing.submit(project.id, { type: "image.proxy", input, inputEncrypted: true, output: join(files, "f.jpg"), params: {} })).rejects.toThrow();
    expect(failing.heldKeys).toBe(0);
    const slow = client(await stubWorker(() => ({ status: "done", result: { output: "", meta: {} } }), { pollsUntilDone: 1000 }));
    const ac = new AbortController();
    await expect(
      slow.submit(project.id, { type: "image.proxy", input, inputEncrypted: true, output: join(files, "c.jpg"), params: {}, signal: ac.signal, onProgress: () => ac.abort() }),
    ).rejects.toThrow();
    expect(slow.heldKeys).toBe(0);
  });
});

describe("R142: the journal stays bounded", () => {
  const DAY = 86_400_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const rec = (projectId: string, id: string, status: JobRecord["status"], msAgo: number, extra: Partial<JobRecord> = {}): JobRecord => ({
    v: 1, id, projectId, kind: "pdf.ocr", status, createdAt: iso(msAgo), updatedAt: iso(msAgo), ...(status === "failed" || status === "cancelled" ? { error: "X" } : {}), ...extra,
  });

  it("keeps succeeded jobs of the last 30 days up to 500, failed and cancelled up to 500, and every unfinished job", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const recs: JobRecord[] = [];
    for (let i = 0; i < 700; i++) recs.push(rec(project.id, `done-${i}`, "done", (i + 1) * 60_000)); // newest first
    for (let i = 0; i < 20; i++) recs.push(rec(project.id, `old-done-${i}`, "done", 40 * DAY));
    for (let i = 0; i < 499; i++) recs.push(rec(project.id, `failed-${i}`, i % 2 ? "failed" : "cancelled", (i + 1) * 60_000));
    recs.push(rec(project.id, "old-failed", "failed", 100 * DAY));
    recs.push(rec(project.id, "old-queued", "queued", 400 * DAY, { job: { type: "pdf.ocr", input: "/x", output: "/y", params: {} } }));
    recs.push(rec(project.id, "old-locked", "cancelled", 400 * DAY, { error: "PROJECT_LOCKED", job: { type: "pdf.ocr", input: "/x", output: "/y", params: {} } }));
    await appendJobRecords(lib.root, project.folder, null, recs);
    expect(await compactJobJournal(lib.root, project.folder, project.id, null)).toBe(true);
    const ids = [...(await readJobJournal(lib.root, project.folder, project.id, null)).records.keys()];
    const done = ids.filter((i) => i.startsWith("done-"));
    expect(done).toHaveLength(MAX_SUCCEEDED_KEPT);
    expect(new Set(done)).toEqual(new Set(Array.from({ length: 500 }, (_, i) => `done-${i}`))); // the most recent
    expect(ids.filter((i) => i.startsWith("old-done-"))).toEqual([]); // older than 30 days
    expect(ids.filter((i) => i.startsWith("failed-"))).toHaveLength(499);
    expect(ids).toContain("old-failed"); // failed: kept however old until retried, within the cap
    expect(ids).toContain("old-queued"); // unfinished: never dropped
    expect(ids).toContain("old-locked"); // waits for an unlock
    expect(SUCCEEDED_MAX_AGE_DAYS).toBe(30);
    // beyond the cap the oldest failed record goes
    await appendJobRecords(lib.root, project.folder, null, [rec(project.id, "new-failed", "failed", 0)]);
    await compactJobJournal(lib.root, project.folder, project.id, null, 0);
    const ids2 = [...(await readJobJournal(lib.root, project.folder, project.id, null)).records.keys()];
    expect(ids2.filter((i) => i.includes("failed"))).toHaveLength(MAX_FAILED_KEPT);
    expect(ids2).not.toContain("old-failed");
    expect(ids2).toContain("old-queued");
    // a retry supersedes the failed record; the record then follows the succeeded rules
    await appendJobRecords(lib.root, project.folder, null, [rec(project.id, "old-failed", "done", 0)]);
    await compactJobJournal(lib.root, project.folder, project.id, null, 0);
    expect((await readJobJournal(lib.root, project.folder, project.id, null)).records.get("old-failed")!.status).toBe("done");
  });

  it("20,000 finished jobs: the first launch compacts to the cap (rows too) and the next launch reads only that", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const key = projectDataKey(repo, project.id);
    const recs: JobRecord[] = [];
    for (let i = 0; i < 20_000; i++) recs.push(rec(project.id, `j${i}`, "done", i * 1000));
    await appendJobRecords(lib.root, project.folder, key, recs);
    await rebuildIndex(handle, ring, lib);
    expect(jobRows()).toHaveLength(20_000);
    const c = client(await okWorker());
    let t = Date.now();
    await c.resumePending();
    const first = Date.now() - t;
    const after = await readJobJournal(lib.root, project.folder, project.id, key);
    expect(after.lines).toBe(MAX_SUCCEEDED_KEPT);
    expect(jobRows()).toHaveLength(MAX_SUCCEEDED_KEPT);
    t = Date.now();
    await c.resumePending();
    const second = Date.now() - t;
    expect(second).toBeLessThan(Math.max(first, 50)); // flat: no longer proportional to history
  }, 120_000);
});

describe("R142 fix round 2: a rerun happens once", () => {
  /**
   * An encrypted project with `n` jobs cancelled by a lock before they started (their journal
   * records, as the client writes them), left unlocked. `ms[i]` is how long job i takes.
   */
  async function lockCancelled(n: number) {
    const { project } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    const key = projectDataKey(repo, project.id);
    const input = join(files, "a.png");
    await writeFile(input, "png");
    const recs: JobRecord[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.now() - (n - i) * 1000).toISOString();
      recs.push({
        v: 1, id: `job-${i}`, projectId: project.id, kind: "image.proxy", status: "cancelled", error: "PROJECT_LOCKED", createdAt: at, updatedAt: at,
        job: { type: "image.proxy", input, output: join(files, `out-${i}`, "p.jpg"), params: { n: i } },
      });
    }
    await appendJobRecords(lib.root, project.folder, key, recs);
    return { project, key };
  }

  /**
   * A worker whose job i takes ms[i] (by its `n` param). `completed` lists the runs that were
   * carried through (a run the client cancelled, e.g. because of a lock before it started, does not count).
   */
  async function countingWorker(ms: number[]) {
    const w = await stubWorker(async (job) => {
      const i = Number(job.body.params.n);
      await new Promise((r) => setTimeout(r, ms[i] ?? 0));
      await mkdir(dirname(job.body.output), { recursive: true });
      await writeFile(job.body.output, "jpeg");
      return { status: "done", result: { output: job.body.output, meta: {} } };
    });
    const runs = () => [...w.jobs.values()].filter((j) => !j.cancelled).map((j) => Number(j.body.params.n));
    return { w, completed: { sort: () => runs().sort() } };
  }

  const statuses = async (project: { id: string; folder: string }) =>
    [...(await readJobJournal(lib.root, project.folder, project.id, projectDataKey(repo, project.id))).records.values()].map((r) => r.status);

  it("a launch and an unlock overlapping: each job runs once (jobs of different lengths)", async () => {
    const { project } = await lockCancelled(2);
    const { w, completed } = await countingWorker([120, 10]);
    await Promise.all([client(w).resumePending(), client(w).resumePending(project.id)]);
    expect(completed.sort()).toEqual([0, 1]);
    expect(w.jobs.size).toBe(2);
    expect(await statuses(project)).toEqual(["done", "done"]);
  });

  it("two unlocks at once (two resubmissions of the project, two clients): each job runs once", async () => {
    const { project } = await lockCancelled(3);
    const { w, completed } = await countingWorker([60, 5, 30]);
    const a = client(w);
    await Promise.all([a.resumePending(project.id), client(w).resumePending(project.id), a.resumePending(project.id)]);
    expect(completed.sort()).toEqual([0, 1, 2]);
    expect(await statuses(project)).toEqual(["done", "done", "done"]);
    // and later resubmissions find nothing to do
    await client(w).resumePending();
    expect(w.jobs.size).toBe(3);
  });

  it("unlock, lock, unlock in quick succession: each job completes once", async () => {
    const { project } = await lockCancelled(2);
    const { w, completed } = await countingWorker([80, 5]);
    const first = client(w).resumePending(project.id); // the first unlock's resubmission
    while (!(await statuses(project)).includes("running")) await new Promise((r) => setTimeout(r, 2)); // its first job is running
    repo.lockProject(project.id); // a running job may finish (R142)
    await repo.unlockProject(project.id, "pw");
    const second = client(w).resumePending(project.id); // the second unlock's
    await Promise.all([first, second]);
    await client(w).resumePending(project.id); // a lock may have sent one back to wait: offered again
    expect(completed.sort()).toEqual([0, 1]);
    expect(await statuses(project)).toEqual(["done", "done"]);
  });

  it("a crash between the claim and the submission: the next launch runs the job exactly once", async () => {
    const { project, key } = await lockCancelled(1);
    const rec = (await readJobJournal(lib.root, project.folder, project.id, key)).records.get("job-0")!;
    // the claim is written ... and the process dies before submitting to the worker
    const { error: _e, ...base } = rec;
    expect(await claimJobRecord(lib.root, project.folder, key, rec, { ...base, status: "queued", updatedAt: new Date().toISOString(), attempt: "crashed-run" })).toBe(true);
    // a second claim on the record it was decided on is refused
    expect(await claimJobRecord(lib.root, project.folder, key, rec, { ...base, status: "queued", updatedAt: new Date().toISOString(), attempt: "other" })).toBe(false);
    const { w, completed } = await countingWorker([0]);
    await client(w).resumePending();
    await client(w).resumePending();
    expect(completed.sort()).toEqual([0]);
    expect(await statuses(project)).toEqual(["done"]);
  });
});

describe("R142 fix round 2: smaller points", () => {
  it("N-3: a lock that lands before the job starts decrypts nothing", async () => {
    const { project } = await repo.createProject({ name: "E", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "pw" } });
    // An "encrypted input" that cannot be read: decrypting it would fail the job instead.
    const input = join(files, "dir.png.enc");
    await mkdir(input);
    let armed = true;
    const index = {
      get db() {
        // read right after the `queued` line is appended: the lock lands there
        if (armed) {
          armed = false;
          repo.lockProject(project.id);
        }
        return handle.db;
      },
    };
    const w = await okWorker();
    const c = new WorkerClient({ repo, worker: w, index, pollMs: 5 });
    const err = await c.submit(project.id, { type: "image.proxy", input, inputEncrypted: true, output: join(files, "o.jpg"), params: {} }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("ProjectLockedError");
    expect(w.requests).toEqual([]);
    expect(jobRows().map((r) => [r.status, r.payload_json])).toEqual([["cancelled", '{"error":"PROJECT_LOCKED"}']]);
  });

  it("N-4: compaction removes what a crash during an earlier compaction left, and nothing else", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const at = new Date().toISOString();
    await appendJobRecords(lib.root, project.folder, null, [{ v: 1, id: "a", projectId: project.id, kind: "pdf.ocr", status: "done", createdAt: at, updatedAt: at }]);
    const dir = dirname(journalPath(lib.root, project.folder));
    await writeFile(join(dir, "journal.jsonl.tmp-0123456789abcdef"), "half a journal");
    await writeFile(join(dir, "journal.jsonl.tmp-notours"), "x");
    await writeFile(join(dir, "other.jsonl.tmp-0123456789abcdef"), "x");
    await compactJobJournal(lib.root, project.folder, project.id, null);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).sort()).toEqual(["journal.jsonl", "journal.jsonl.tmp-notours", "other.jsonl.tmp-0123456789abcdef"]);
    expect([...(await readJobJournal(lib.root, project.folder, project.id, null)).records.keys()]).toEqual(["a"]);
  });

  it("M-4: a row written while the rows are being refreshed is neither removed nor overwritten by the older read", async () => {
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const at = new Date().toISOString();
    const old: JobRecord = { v: 1, id: "old", projectId: project.id, kind: "pdf.ocr", status: "done", createdAt: at, updatedAt: at };
    await appendJobRecords(lib.root, project.folder, null, [old]);
    const fresh: JobRecord = { ...old, id: "fresh", status: "queued" };
    const finishedOld: JobRecord = { ...old, status: "failed", error: "X" };
    // the refresh starts first; a submit and a status change land while it runs
    await Promise.all([
      refreshJobRows(() => handle.db, lib.root, project.folder, project.id, null),
      (async () => {
        await appendJobRecords(lib.root, project.folder, null, [fresh, finishedOld]);
        upsertJobRow(handle.db, fresh);
        upsertJobRow(handle.db, finishedOld);
      })(),
    ]);
    expect(jobRows().map((r) => [r.id, r.status]).sort()).toEqual([
      ["fresh", "queued"],
      ["old", "failed"],
    ]);
  });
});
