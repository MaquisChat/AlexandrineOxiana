/**
 * R413 b, c: during the run, a full disk (or a project that refuses every write) STOPS the batch at once, as a batch
 * that stopped and can be resumed, instead of failing item after item. The item in hand is not recorded as failed: a
 * resume takes it up again. What its change had already written is undone by that change's own rollback (R26).
 *
 * The four places a write of the run can fail — the item's own store, the journal, the checkpoint and the group's
 * commit — are made to fail once here with ENOSPC (or EDQUOT) through the modules the engine calls; the rollback
 * itself is the real one.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf, buildZip } from "../../../../../tests/fixtures/generate.mjs";
import { buildZoteroFixture } from "../../../tests/fixtures/zotero/build-fixture.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo, seams } from "../../repo/testing.js";
import { zoteroLocalAdapter } from "../zotero-local.js";
import { createBulkImport, folderAdapter, type BatchHandle, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";
import { DISK_FULL_NOTE, RECOVERY_NOTE, bulkSpaceSeams } from "./space.js";

/** Writes made to fail, each once per count, with this code. */
const faults = vi.hoisted(() => ({
  code: "ENOSPC",
  journal: 0,
  record: 0,
  group: 0,
  single: 0,
  /** Any other error (not a full disk) from the group's commit, inside its change. */
  groupOther: 0,
  /** Any other error (not a full disk) from an item's own store, inside its change (after its writes). */
  singleOther: 0,
  /** A full disk inside an item's own store, inside its change (after its writes): the change rolls back. */
  singleInside: 0,
  /** Unpacking an archive (R436 a): writes part of it into the work folder, then fails with this code. */
  unpack: 0,
  /** Any other error from unpacking an archive (a damaged archive). */
  unpackOther: 0,
  /** Copying the Zotero database (R436 a), after its own check of the room passed. */
  dbCopy: 0,
  error(code?: string): NodeJS.ErrnoException {
    const c = code ?? this.code;
    return Object.assign(new Error(`${c}: no space left on device, write '/Users/jane/Library/x.json'`), { code: c, syscall: "write" });
  },
}));

vi.mock("./batch.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("./batch.js")>();
  return {
    ...m,
    appendJournal: async (...a: Parameters<typeof m.appendJournal>) => {
      if (faults.journal > 0) {
        faults.journal--;
        throw faults.error();
      }
      return m.appendJournal(...a);
    },
    writeBatchRecord: async (...a: Parameters<typeof m.writeBatchRecord>) => {
      if (faults.record > 0) {
        faults.record--;
        throw faults.error();
      }
      return m.writeBatchRecord(...a);
    },
  };
});

vi.mock("../../extract/zip.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../extract/zip.js")>();
  return {
    ...m,
    extractArchive: async (...a: Parameters<typeof m.extractArchive>) => {
      if (faults.unpack > 0 || faults.unpackOther > 0) {
        const other = faults.unpack === 0;
        if (other) faults.unpackOther--;
        else faults.unpack--;
        // What the unpack wrote before the disk filled is left in the work folder for the caller to remove.
        await mkdir(a[1], { recursive: true });
        await writeFile(join(a[1], "partial.pdf"), "partial");
        throw other ? new Error("invalid central directory file header signature") : faults.error();
      }
      return m.extractArchive(...a);
    },
  };
});

vi.mock("../sqlite-copy.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../sqlite-copy.js")>();
  return {
    ...m,
    copyDatabases: async (...a: Parameters<typeof m.copyDatabases>) => {
      if (faults.dbCopy > 0) {
        faults.dbCopy--;
        throw faults.error();
      }
      return m.copyDatabases(...a);
    },
  };
});

vi.mock("../../repo/repo.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../repo/repo.js")>();
  return {
    ...m,
    createSourcesRefusing: async (...a: Parameters<typeof m.createSourcesRefusing>) => {
      if (faults.group > 0) {
        faults.group--;
        throw faults.error();
      }
      if (faults.groupOther > 0) {
        faults.groupOther--;
        // Fails inside the change, after its first source is written: the change rolls back.
        const [repo, projectId, items, hook] = a;
        return m.createSourcesRefusing(
          repo,
          projectId,
          items.map((it, i) => (i === 0 ? { ...it, inTx: async () => Promise.reject(Object.assign(new Error("I/O error"), { code: "EIO" })) } : it)),
          hook,
        );
      }
      return m.createSourcesRefusing(...a);
    },
    createSourceRefusing: async (...a: Parameters<typeof m.createSourceRefusing>) => {
      if (faults.single > 0) {
        faults.single--;
        throw faults.error();
      }
      if (faults.singleOther > 0) {
        faults.singleOther--;
        const [repo, projectId, draft, files, opts, refuse] = a;
        return m.createSourceRefusing(repo, projectId, draft, files, opts, refuse, async () => Promise.reject(Object.assign(new Error("I/O error"), { code: "EIO" })));
      }
      if (faults.singleInside > 0) {
        faults.singleInside--;
        const [repo, projectId, draft, files, opts, refuse] = a;
        return m.createSourceRefusing(repo, projectId, draft, files, opts, refuse, async () => Promise.reject(faults.error()));
      }
      return m.createSourceRefusing(...a);
    },
  };
});

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload, refman_import, zotero_import]
processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let agent: MockAgent;
let bulk: BulkImport;
let notes: string[];

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

async function open(l: Library): Promise<void> {
  lib = l;
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  bulk = createBulkImport({ repo, http, index: handle, debug: (n) => notes.push(n) });
}

async function project(): Promise<Project> {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } });
  return project;
}

const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });
const item = (key: string): ScanItem => ({ key, files: [], referenceMetadata: { type: "book", title: mt(`Book ${key}`) } });

/** An adapter over `items` that calls `after(n)` once the n-th item (from 1) has been taken by the engine. */
function adapter(items: ScanItem[], after: (n: number) => void = () => {}): ImportSourceAdapter {
  return {
    kind: "csl-json",
    location: join(tmp, "export.json"),
    roots: [tmp],
    async *scan() {
      let n = 0;
      for (const it of items) {
        yield it;
        after(++n);
      }
    },
  };
}

type Line = { key: string; outcome: string; reason?: string; cause?: string };
async function journal(p: Project): Promise<Line[]> {
  const text = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "journal.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}
const record = async (p: Project) => JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8")) as { state: string; notes: string[]; stopCause?: string };

/** The source folders on disk (a half-written item would leave one without its line). */
async function sourceDirs(p: Project): Promise<string[]> {
  return (await readdir(join(lib.root, p.folder, "sources"), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** The batch stopped for a full disk: the note, no failed line, resumable. */
async function stoppedFull(p: Project, h: BatchHandle): Promise<void> {
  const res = await h.done;
  expect(res.state).toBe("failed");
  expect(res.counts.failed).toBe(0);
  expect((await journal(p)).filter((e) => e.outcome === "failed")).toEqual([]);
  const rec = await record(p);
  expect(rec.notes).toContain(DISK_FULL_NOTE);
  expect((await bulk.batchReport(p.id, h.batchId)).notes).toContain(DISK_FULL_NOTE);
  // Every source on disk is one the journal names (no half item left).
  const named = new Set((await journal(p)).map((e) => (e as { sourceId?: string }).sourceId).filter(Boolean));
  expect((await sourceDirs(p)).filter((d) => !named.has(d))).toEqual([]);
  expect(repo.listSourceIds(p.id).length).toBe(named.size);
}

/** Resumed: every item imported once. */
async function resumedAll(p: Project, h: BatchHandle, a: ImportSourceAdapter, keys: string[]): Promise<void> {
  const h2 = await bulk.resumeBatch(p.id, h.batchId, a);
  const res = await h2.done;
  expect(res.state).toBe("finished");
  expect(res.counts.failed).toBe(0);
  const lines = await journal(p);
  expect([...new Set(lines.map((e) => e.key))].sort()).toEqual([...keys].sort());
  expect(lines.filter((e) => e.outcome === "created" || e.outcome === "needs-review").map((e) => e.key).sort()).toEqual([...keys].sort());
  expect(repo.listSourceIds(p.id).length).toBe(keys.length);
  expect((await record(p)).notes).not.toContain(DISK_FULL_NOTE);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-diskfull-"));
  ring = new KeyRing();
  agent = new MockAgent();
  agent.disableNetConnect();
  notes = [];
  Object.assign(faults, { code: "ENOSPC", journal: 0, record: 0, group: 0, single: 0, groupOther: 0, singleOther: 0, singleInside: 0, unpack: 0, unpackOther: 0, dbCopy: 0 });
  await open(await createLibrary(join(tmp, "Lib"), "Lib", deps()));
});

afterEach(async () => {
  delete seams.failUndo;
  delete bulkSpaceSeams.freeSpace;
  delete bulkSpaceSeams.fileMargin;
  delete bulkSpaceSeams.minMargin;
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

const KEYS = ["a", "b", "c", "d", "e"];

describe("a full disk during the run stops the batch at once (R413 b)", () => {
  it("in the group's commit: no item is failed, the batch stops with the sentence, and a resume imports every item once", async () => {
    const p = await project();
    const a = adapter(KEYS.map(item), (n) => {
      if (n === 3) faults.group = 1;
    });
    const h = await bulk.startBatch(p.id, a);
    await stoppedFull(p, h);
    expect((await record(p)).stopCause).toBe("ENOSPC");
    // The group was not retried item by item (each would have failed the same way).
    expect(notes.filter((n) => n.startsWith("bulk import group store failed"))).toEqual([]);
    expect(notes.filter((n) => n.startsWith("bulk import item failed"))).toEqual([]);
    await resumedAll(p, h, adapter(KEYS.map(item)), KEYS);
  });

  it("a quota exceeded (EDQUOT) is a full disk too", async () => {
    const p = await project();
    faults.code = "EDQUOT";
    const h = await bulk.startBatch(p.id, adapter(KEYS.map(item), (n) => n === 1 && (faults.group = 1)));
    await stoppedFull(p, h);
    expect((await record(p)).stopCause).toBe("EDQUOT");
  });

  it("in the journal, inside the group's change: the change's own rollback leaves no half item", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, adapter(KEYS.map(item), (n) => n === 5 && (faults.journal = 1)));
    await stoppedFull(p, h);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(await sourceDirs(p)).toEqual([]);
    await resumedAll(p, h, adapter(KEYS.map(item)), KEYS);
  });

  it("in a checkpoint: the batch stops there", async () => {
    const p = await project();
    let h!: BatchHandle;
    const a = adapter(KEYS.map(item), (n) => {
      if (n === 2) {
        // The pause's checkpoint is the next write of the batch record.
        faults.record = 1;
        h.pause();
      }
    });
    h = await bulk.startBatch(p.id, a);
    await stoppedFull(p, h);
    await resumedAll(p, h, adapter(KEYS.map(item)), KEYS);
  });

  it("in an item's own store: the item in hand is not failed, a resume takes it up", async () => {
    const p = await project();
    // Keys inside an archive are stored one by one, each in its own change.
    const keys = KEYS.map((k) => `x.zip!/${k}`);
    const h = await bulk.startBatch(p.id, adapter(keys.map(item), (n) => n === 2 && (faults.single = 1)));
    await stoppedFull(p, h);
    const lines = await journal(p);
    expect(lines.map((e) => e.key)).toEqual(keys.slice(0, 2));
    await resumedAll(p, h, adapter(keys.map(item)), keys);
  });

  it("the disk still full when the batch stops: the report still says why (the record could not be saved)", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, adapter(KEYS.map(item), (n) => n === 3 && Object.assign(faults, { group: 1, record: 99, journal: 99 })));
    const res = await h.done;
    expect(res.state).toBe("failed");
    Object.assign(faults, { record: 0, journal: 0 });
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(DISK_FULL_NOTE);
    expect(report.failures).toEqual([]);
    await resumedAll(p, h, adapter(KEYS.map(item)), KEYS);
  });
});

describe("the room for an item's files is checked before they are copied (R413 b)", () => {
  it("under the files' size plus the margin, the batch stops before anything of the item is written", async () => {
    const p = await project();
    const src = join(tmp, "Papers");
    await mkdir(src, { recursive: true });
    for (const k of ["one", "two", "three"]) await writeFile(join(src, `${k}.pdf`), await buildPdf({ extra: `paper ${k}` }));
    let free = 150e6; // under 200 MB beyond the first file
    bulkSpaceSeams.freeSpace = async () => free;
    bulkSpaceSeams.minMargin = 0; // the start's check (R413 a) is another test's
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    await stoppedFull(p, h);
    expect(await journal(p)).toEqual([]);
    expect(await sourceDirs(p)).toEqual([]);
    expect((await record(p)).stopCause).toBe("ENOSPC");
    free = 10e9;
    const h2 = await bulk.resumeBatch(p.id, h.batchId);
    expect((await h2.done).state).toBe("finished");
    expect((await journal(p)).filter((e) => e.outcome === "created" || e.outcome === "needs-review").map((e) => e.key).sort()).toEqual(["one.pdf", "three.pdf", "two.pdf"]);
  });
});

describe("a project that refuses every write stops the batch too (R413 c)", () => {
  it("at the first refusal the batch stops with its own sentence, no item failed for it; settled, a resume imports the rest", async () => {
    const p = await project();
    const keys = KEYS.map((k) => `x.zip!/${k}`);
    // The second item's change fails (not for room) and its rollback cannot write either: from then on the project
    // refuses every write until it is settled (H6).
    const h = await bulk.startBatch(
      p.id,
      adapter(keys.map(item), (n) => {
        if (n === 1) {
          faults.singleOther = 1;
          seams.failUndo = "dir"; // the new source folder's undo step
        }
      }),
    );
    const res = await h.done;
    expect(res.state).toBe("failed");
    // Not two hundred failed items: only the item whose own change failed is failed (with its kind); the rest wait.
    expect(res.counts.failed).toBeLessThanOrEqual(1);
    expect(notes.filter((n) => n.includes("kind=RecoveryPendingError") && n.startsWith("bulk import item failed"))).toEqual([]);
    // The record cannot be saved in a project that refuses writes: the report still says why it stopped.
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(RECOVERY_NOTE);
    expect(report.failures.filter((f) => /earlier change|RecoveryPending/u.test(f.reason))).toEqual([]);

    // Settled: the library is opened again (the open finishes the rollback), and the batch resumed.
    delete seams.failUndo;
    handle.close();
    await lib.close();
    await open(await openLibrary(join(tmp, "Lib"), deps()));
    await resumedAll(p, h, adapter(keys.map(item)), keys);
  });
});

describe("a full disk during the scan stops the batch too (R436 a)", () => {
  /** A folder holding one archive of three PDFs. */
  async function archiveFolder(): Promise<{ src: string; keys: string[] }> {
    const src = join(tmp, "Papers");
    await mkdir(src, { recursive: true });
    const names = ["one.pdf", "two.pdf", "three.pdf"];
    const entries = await Promise.all(names.map(async (name) => ({ name, data: await buildPdf({ extra: `archived ${name}` }) })));
    await writeFile(join(src, "a.zip"), buildZip(entries));
    return { src, keys: names.map((n) => `a.zip!/${n}`) };
  }
  /** The work folders the run unpacks into (removed when it stops). */
  const leftInTmp = async () => (await readdir(join(lib.root, ".tmp"), { recursive: true }).catch(() => [] as string[])).filter((n) => n.includes("zip-"));

  it("an archive whose unpacking fills the disk: stopped with the sentence, no failed line, nothing left unpacked; a resume imports its files once", async () => {
    const p = await project();
    const { src, keys } = await archiveFolder();
    faults.unpack = 1;
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    await stoppedFull(p, h);
    expect(await journal(p)).toEqual([]);
    expect((await record(p)).stopCause).toBe("ENOSPC");
    expect(await leftInTmp()).toEqual([]);
    const h2 = await bulk.resumeBatch(p.id, h.batchId);
    expect((await h2.done).state).toBe("finished");
    const lines = await journal(p);
    expect(lines.map((e) => e.key).sort()).toEqual([...keys].sort());
    expect(lines.filter((e) => e.outcome === "created" || e.outcome === "needs-review").length).toBe(3);
    expect(repo.listSourceIds(p.id).length).toBe(3);
  });

  it("an archive that truly cannot be read is still one failed line, and the batch goes on", async () => {
    const p = await project();
    const { src } = await archiveFolder();
    await writeFile(join(src, "b.pdf"), await buildPdf({ extra: "loose paper" }));
    faults.unpackOther = 1;
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    const res = await h.done;
    expect(res.state).toBe("finished");
    const lines = await journal(p);
    expect(lines.filter((e) => e.outcome === "failed")).toEqual([{ key: "a.zip", outcome: "failed", reason: "The archive could not be read, so its files were not imported." }]);
    expect(lines.map((e) => e.key).sort()).toEqual(["a.zip", "b.pdf"]);
    expect(await leftInTmp()).toEqual([]);
  });

  it("the Zotero database copy failing for a full disk after its check passed: stopped with the sentence, not \"missing or damaged\"; a resume imports", async () => {
    const p = await project();
    const dataDir = join(tmp, "Zotero");
    buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "okafor" }), linkedPdf: await buildPdf({ extra: "linked" }), linkedDir: join(tmp, "Elsewhere") });
    faults.dbCopy = 1;
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir));
    await stoppedFull(p, h);
    expect(await journal(p)).toEqual([]);
    expect((await bulk.batchReport(p.id, h.batchId)).failures).toEqual([]);
    const h2 = await bulk.resumeBatch(p.id, h.batchId);
    const res = await h2.done;
    expect(res.state).toBe("finished");
    expect(res.counts.failed).toBe(0);
    const lines = await journal(p);
    expect(new Set(lines.map((e) => e.key)).size).toBe(lines.length);
    expect(lines.filter((e) => e.outcome === "created" || e.outcome === "needs-review").length).toBeGreaterThan(0);
  });
});

describe("the stop sentences name what exists when a change could not be undone (R436 d)", () => {
  const FULL_UNDONE = "The import stopped because the disk is full, and its last change could not be undone. Free some space, close and reopen the library, then resume the import.";
  const REFUSING = "The import stopped because an earlier change in this project could not be undone. Close and reopen the library, then resume the import.";

  /** Closes and reopens the library (the open finishes the rollback the session could not). */
  async function reopen(): Promise<void> {
    delete seams.failUndo;
    handle.close();
    await lib.close();
    await open(await openLibrary(join(tmp, "Lib"), deps()));
  }

  it("a full disk whose change cannot be undone: the sentence says to close and reopen; reopened, a resume imports every item once (the review's P4)", async () => {
    const p = await project();
    const keys = KEYS.map((k) => `x.zip!/${k}`);
    const h = await bulk.startBatch(
      p.id,
      adapter(keys.map(item), (n) => {
        if (n === 1) {
          faults.singleInside = 1; // the second item's change fails for a full disk…
          seams.failUndo = "dir"; // …and its undo cannot write either
        }
      }),
    );
    const res = await h.done;
    expect(res.state).toBe("failed");
    expect(res.counts.failed).toBe(0);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(FULL_UNDONE);
    expect(report.notes).not.toContain(DISK_FULL_NOTE);
    expect(report.failures).toEqual([]);
    // What the sentence says is what works: the library closed and reopened, the import resumed.
    await reopen();
    await resumedAll(p, h, adapter(keys.map(item)), keys);
    expect((await bulk.batchReport(p.id, h.batchId)).notes).not.toContain(FULL_UNDONE);
  });

  it("a project that refuses writes from the batch's first item: the other sentence; reopened, a resume imports every item once", async () => {
    const p = await project();
    // The first group's change fails (not for room) and its undo cannot write: from then on the project refuses
    // every write, and the first item, taken again on its own, meets that refusal.
    faults.groupOther = 1;
    seams.failUndo = "dir";
    const h = await bulk.startBatch(p.id, adapter(KEYS.map(item)));
    const res = await h.done;
    expect(res.state).toBe("failed");
    expect(res.counts.failed).toBe(0);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(REFUSING);
    expect(report.failures).toEqual([]);
    await reopen();
    await resumedAll(p, h, adapter(KEYS.map(item)), KEYS);
    expect((await bulk.batchReport(p.id, h.batchId)).notes).not.toContain(REFUSING);
  });
});
