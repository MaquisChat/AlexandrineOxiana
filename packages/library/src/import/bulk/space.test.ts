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
import { buildPdf, buildZip } from "../../../../../tests/fixtures/generate.mjs";
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
import { createBulkImport, folderAdapter, zipAdapter, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";
import { bulkSpaceSeams, fitSentence, sizeWords, zoteroCopyBytes } from "./space.js";

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

/** A folder of `n` files of `bytes` each (text: their content does not matter to the room). */
async function folder(name: string, n: number, bytes: number): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `file-${i}.txt`), Buffer.alloc(bytes, 97));
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
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
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

describe("the sentence (R413 a)", () => {
  it("names the two sizes in the interface's style, and the way out the source allows", () => {
    expect(fitSentence(2.4e9, 812e6, true)).toBe(
      "This import would copy about 2.4 GB of files into the library, but its disk has only 812 MB free. Free some space, or choose to leave the files where they are, and start again.",
    );
    expect(fitSentence(3e6, 100e6, false)).toBe("This import would copy about 3 MB of files into the library, but its disk has only 100 MB free. Free some space and start again.");
  });
});

describe("before a batch that copies files starts (R413 a)", () => {
  it("is refused when the files, with the margin (at least 500 MB), do not fit; nothing is written or audited", async () => {
    const p = await project();
    const src = await folder("Papers", 3, 1e6);
    free = 100e6;
    await expect(bulk.startBatch(p.id, folderAdapter(src))).rejects.toMatchObject({
      name: "BatchRefusedError",
      reason: "This import would copy about 3 MB of files into the library, but its disk has only 100 MB free. Free some space, or choose to leave the files where they are, and start again.",
    });
    await nothingWritten(p);
    // With the room for the files and the 500 MB margin it starts.
    free = 3e6 + 500e6;
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    expect((await h.done).state).toBe("finished");
  });

  it("the margin is 10% of a large import's size", async () => {
    const p = await project();
    const zip = join(tmp, "big.zip");
    // An archive whose entries declare 8 GB in all (the archive itself is small).
    await writeFile(zip, buildZip([{ name: "a.pdf", data: "x", declaredSize: 4e9 }, { name: "b.pdf", data: "y", declaredSize: 4e9 }]));
    free = 8e9 + 0.8e9 - 1;
    await expect(bulk.startBatch(p.id, zipAdapter(zip))).rejects.toMatchObject({
      // A ZIP's files are unpacked and always copied: there is no "leave them where they are".
      reason: "This import would copy about 8 GB of files into the library, but its disk has only 8.8 GB free. Free some space and start again.",
    });
    await nothingWritten(p);
  });

  it("goes by the dry run of the same source, else by the source's own total", async () => {
    const p = await project();
    bulkSpaceSeams.minMargin = 1e6;
    const src = await folder("Papers", 3, 1e6);
    free = 5e6;
    const summary = await bulk.dryRun(p.id, folderAdapter(src));
    expect(summary.totalBytes).toBe(3e6);
    // A file added after the dry run: the folder's own total (7 MB with the margin) would not fit; the scan's does.
    await writeFile(join(src, "late.txt"), Buffer.alloc(3e6, 98));
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    expect((await h.done).state).toBe("finished");
    // Another source of the project has no scan to go by: its own total counts.
    const other = await folder("More", 6, 1e6);
    await expect(bulk.startBatch(p.id, folderAdapter(other))).rejects.toMatchObject({ reason: fitSentence(6e6, 5e6, true) });
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
    // The cheap total of a Zotero data folder: the files under its storage folder.
    let files = 0;
    for (const e of await readdir(join(dataDir, "storage"), { withFileTypes: true, recursive: true })) if (e.isFile()) files += (await stat(join(e.parentPath, e.name))).size;
    const need = files + Math.ceil(files / 10) + db;
    free = need - 1;
    await expect(bulk.startBatch(p.id, zoteroLocalAdapter(dataDir))).rejects.toMatchObject({ reason: fitSentence(files, need - 1, true) });
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
    expect(s.spaceWarning).toBe(fitSentence(3e6, 100e6, true));
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
