/**
 * R413 a, d: before a batch that copies files starts, the files to be copied (what the dry run of the same source
 * found, else the source's own cheap total), with a margin and, for a Zotero local import, the database copy, must fit
 * in the free room on the library's disk; otherwise the start is refused with a plain sentence, nothing written. The
 * dry run says the same. The Zotero database copy keeps the same margin free instead of 64 MB.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { buildZoteroFixture } from "../../../tests/fixtures/zotero/build-fixture.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { ZOTERO_REASONS, zoteroLocalAdapter } from "../zotero-local.js";
import { createBulkImport, folderAdapter, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";
import { DISK_FULL_NOTE, bulkSpaceSeams, fitSentence, sizeWords, zoteroCopyBytes } from "./space.js";

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
let free: number;
/** The repo's clock (R436 b: a dry run is used for 30 minutes). */
let now: number;

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

async function project(): Promise<Project> {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } });
  return project;
}

/** A PDF of exactly `bytes` bytes (padded), different for each `tag`. */
async function pdfOf(tag: string, bytes: number): Promise<Buffer> {
  const pdf = await buildPdf({ extra: tag });
  return Buffer.concat([pdf, Buffer.alloc(Math.max(0, bytes - pdf.length), 32)]);
}

/** A folder of `n` PDFs of `bytes` each, each different (R436 b: only files the run would copy count, so real PDFs). */
async function folder(name: string, n: number, bytes: number): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `file-${i}.pdf`), await pdfOf(`${name} ${i}`, bytes));
  return dir;
}

/** Every file under a folder, as text. */
async function allText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += await readFile(join(e.parentPath, e.name), "utf8").catch(() => "");
  }
  return out;
}

/** Nothing of an import was written in the project: no batch folder, no import event in its audit. */
async function nothingWritten(p: Project): Promise<void> {
  expect(await stat(join(lib.root, p.folder, "imports", "batch-0001")).catch(() => null)).toBeNull();
  expect(await allText(join(lib.root, p.folder))).not.toMatch(/"import\./u);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-space-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  now = Date.parse("2026-11-17T09:00:00Z");
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(now), index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  agent = new MockAgent();
  agent.disableNetConnect();
  const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  bulk = createBulkImport({ repo, http, index: handle });
  free = Number.POSITIVE_INFINITY;
  bulkSpaceSeams.freeSpace = async () => free;
  // The per-file check during the run (R413 b) is another test's: here only the start's.
  bulkSpaceSeams.fileMargin = 0;
});

afterEach(async () => {
  delete bulkSpaceSeams.freeSpace;
  delete bulkSpaceSeams.minMargin;
  delete bulkSpaceSeams.fileMargin;
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

describe("the sentence (R436 c)", () => {
  it("says what is needed: the files, the room the library keeps free, against what is free; the way out the source allows", () => {
    expect(fitSentence(50e6, 0, 400e6, true)).toBe(
      "This import needs about 550 MB free on the library's disk (50 MB of files to copy, and room the library keeps free to work), but only 400 MB is free. Free some space, or choose to leave the files where they are, and start again.",
    );
    expect(fitSentence(3e6, 0, 100e6, false)).toBe(
      "This import needs about 503 MB free on the library's disk (3 MB of files to copy, and room the library keeps free to work), but only 100 MB is free. Free some space and start again.",
    );
  });

  it("names the Zotero database's working copy when the source has one", () => {
    expect(fitSentence(2e9, 300e6, 2.1e9, true)).toBe(
      "This import needs about 2.8 GB free on the library's disk (2 GB of files to copy, a working copy of the Zotero database, and room the library keeps free to work), but only 2.1 GB is free. Free some space, or choose to leave the files where they are, and start again.",
    );
  });
});

describe("before a batch that copies files starts (R413 a)", () => {
  it("is refused when the files, with the margin (at least 500 MB), do not fit; nothing is written or audited", async () => {
    const p = await project();
    const src = await folder("Papers", 3, 1e6);
    free = 100e6;
    // R436 b: the start goes by the dry run of the same source.
    await bulk.dryRun(p.id, folderAdapter(src));
    await expect(bulk.startBatch(p.id, folderAdapter(src))).rejects.toMatchObject({
      name: "BatchRefusedError",
      reason: "This import needs about 503 MB free on the library's disk (3 MB of files to copy, and room the library keeps free to work), but only 100 MB is free. Free some space, or choose to leave the files where they are, and start again.",
    });
    await nothingWritten(p);
    // With the room for the files and the 500 MB margin it starts.
    free = 3e6 + 500e6;
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    expect((await h.done).state).toBe("finished");
  });

  it("the margin is 10% of the size when that is more than the least margin", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    const src = await folder("Papers", 3, 4e6);
    free = 12e6 + 1.2e6 - 1;
    await bulk.dryRun(p.id, folderAdapter(src));
    await expect(bulk.startBatch(p.id, folderAdapter(src))).rejects.toMatchObject({ reason: fitSentence(12e6, 0, free, true) });
    await nothingWritten(p);
    free = 12e6 + 1.2e6;
    expect((await (await bulk.startBatch(p.id, folderAdapter(src))).done).state).toBe("finished");
  });

  it("goes by a dry run of the same source; with none, the start is not refused (the check before each item's files protects)", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    const src = await folder("Papers", 3, 1e6);
    free = 5e6;
    const summary = await bulk.dryRun(p.id, folderAdapter(src));
    expect(summary.totalBytes).toBe(3e6);
    // A file added after the dry run: the start still goes by the scan's number (the run's own check is not this test's:
    // the room is made ample once the start has been let through).
    await writeFile(join(src, "late.pdf"), await pdfOf("late", 3e6));
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    free = Number.POSITIVE_INFINITY;
    expect((await h.done).state).toBe("finished");
    // Another source of the project has no dry run: the start is not refused (no walk of the folder in the request).
    free = 5e6;
    const other = await folder("More", 6, 1e6);
    const h2 = await bulk.startBatch(p.id, folderAdapter(other));
    free = Number.POSITIVE_INFINITY;
    expect((await h2.done).state).toBe("finished");
  });

  it("a dry run older than 30 minutes is not used (R436 b)", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    const src = await folder("Papers", 6, 1e6);
    free = 5e6;
    expect((await bulk.dryRun(p.id, folderAdapter(src))).spaceWarning).toBeDefined();
    now += 29 * 60_000;
    await expect(bulk.startBatch(p.id, folderAdapter(src))).rejects.toMatchObject({ name: "BatchRefusedError" });
    now += 2 * 60_000;
    // Older: not used, so the start is not refused (how far the run gets on 5 MB is not what this test checks).
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    expect(["finished", "failed"]).toContain((await h.done).state);
  });

  it("with no dry run the start is allowed, and a disk too small stops the batch at the check before the files (R413 b)", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    bulkSpaceSeams.fileMargin = 2e6;
    const src = await folder("Papers", 6, 1e6);
    free = 2.5e6;
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    const res = await h.done;
    expect(res.state).toBe("failed");
    expect(res.counts.failed).toBe(0);
    expect((await bulk.batchReport(p.id, h.batchId)).notes).toContain(DISK_FULL_NOTE);
  });

  it("a re-import of a folder already imported, one small file added, is not refused: only what would be copied counts (R436 b, the review's P2)", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    const src = await folder("Papers", 3, 2e6);
    expect((await (await bulk.startBatch(p.id, folderAdapter(src))).done).state).toBe("finished");
    await writeFile(join(src, "new.pdf"), await pdfOf("new", 5000));
    free = 4e6;
    const s = await bulk.dryRun(p.id, folderAdapter(src));
    expect(s.alreadyImported).toBe(3);
    expect(s.totalBytes).toBe(5000);
    expect(s.copyBytes).toBe(5000);
    expect(s.spaceWarning).toBeUndefined();
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    expect((await h.done).state).toBe("finished");
  });

  it("the dry run's total leaves out files of a kind not imported and a second copy of the same file within the scan (R436 b)", async () => {
    const p = await project();
    const src = await folder("Papers", 1, 1e6);
    await writeFile(join(src, "copy.pdf"), await readFile(join(src, "file-0.pdf")));
    await writeFile(join(src, "notes.txt"), Buffer.alloc(3e6, 97));
    const s = await bulk.dryRun(p.id, folderAdapter(src));
    expect(s.totalBytes).toBe(1e6);
    expect(s.copyBytes).toBe(1e6);
  });

  it("is never refused for room when the files are left where they are", async () => {
    const p = await project();
    const src = await folder("Papers", 3, 1e6);
    free = 1;
    const h = await bulk.startBatch(p.id, folderAdapter(src), { fileHandling: "link" });
    expect((await h.done).state).toBe("finished");
  });

  it("is skipped when no size can be had (an export of references names files only as it is read)", async () => {
    const p = await project();
    free = 1;
    const items: ScanItem[] = [{ key: "a", files: [], referenceMetadata: { type: "book", title: { variants: [{ lang: "en", kind: "original", value: "A book" }] } } }];
    const a: ImportSourceAdapter = {
      kind: "csl-json",
      location: join(tmp, "export.json"),
      roots: [tmp],
      async *scan() {
        yield* items;
      },
    };
    const h = await bulk.startBatch(p.id, a);
    expect((await h.done).state).toBe("finished");
  });

  it("a Zotero local import counts its database copy too", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 0;
    const dataDir = join(tmp, "Zotero");
    buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "okafor" }), linkedPdf: await buildPdf({ extra: "linked" }), linkedDir: join(tmp, "Elsewhere") });
    const db = await zoteroCopyBytes(dataDir);
    expect(db).toBeGreaterThan(0);
    // R436 b: the start goes by the dry run (what it would copy: the stored files; linked ones stay links).
    const files = (await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir))).copyBytes!;
    expect(files).toBeGreaterThan(0);
    const need = files + Math.ceil(files / 10) + db;
    free = need - 1;
    await expect(bulk.startBatch(p.id, zoteroLocalAdapter(dataDir))).rejects.toMatchObject({ reason: fitSentence(files, db, need - 1, true) });
    await nothingWritten(p);
    free = need;
    const h = await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir));
    expect((await h.done).state).toBe("finished");
  });
});

describe("the dry run (R413 a)", () => {
  it("carries the size to be copied and the free room, and the sentence as a warning when they do not fit", async () => {
    const p = await project();
    const src = await folder("Papers", 3, 1e6);
    free = 100e6;
    const s = await bulk.dryRun(p.id, folderAdapter(src));
    expect(s.copyBytes).toBe(3e6);
    expect(s.freeBytes).toBe(100e6);
    expect(s.spaceWarning).toBe(
      "This import needs about 503 MB free on the library's disk (3 MB of files to copy, and room the library keeps free to work), but only 100 MB is free. Free some space, or choose to leave the files where they are, and start again.",
    );
    free = 600e6;
    const ok = await bulk.dryRun(p.id, folderAdapter(src));
    expect(ok.freeBytes).toBe(600e6);
    expect(ok.spaceWarning).toBeUndefined();
  });

  it("a Zotero data folder's database copy keeps the import's margin free, not 64 MB (R413 d)", async () => {
    const p = await project();
    const dataDir = join(tmp, "Zotero");
    buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "okafor" }), linkedPdf: await buildPdf({ extra: "linked" }), linkedDir: join(tmp, "Elsewhere") });
    const db = await zoteroCopyBytes(dataDir);
    // Room for the copy and 64 MB (enough before R413), but not for the copy and 500 MB.
    const s = await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir, { freeSpace: async () => db + 100e6 }));
    expect(s.unreadable.map((u) => u.reason)).toContain(ZOTERO_REASONS.noSpace);
    const ok = await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir, { freeSpace: async () => db + 500e6 }));
    expect(ok.unreadable.map((u) => u.reason)).not.toContain(ZOTERO_REASONS.noSpace);
    expect(sizeWords(500e6)).toBe("500 MB");
  });
});
