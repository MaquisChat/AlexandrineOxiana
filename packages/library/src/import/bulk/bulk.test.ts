import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExifTool } from "exiftool-vendored";
import { primary, type AuditEvent, type Project, type SourceDraft } from "@ao/core";
import { FIXTURE_DOI, buildCameraTiff, buildImportFolder, buildPdf, buildZip, type ImportFolderFixture } from "../../../../../tests/fixtures/generate.mjs";
import { LOCATION_REASON, createAttach } from "../attach.js";
import { ProxyQueue } from "../proxies.js";
import { gpsOf, proxyStub } from "../proxy-testing.js";
import { WorkerClient } from "../../worker-client.js";
import { stubWorker } from "../../worker-testing.js";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import { decryptBytes } from "../../repo/io.js";
import type { Repo } from "../../repo/repo.js";
import { importChange, projectCollectionsAndTags, projectDataKey } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { BatchRefusedError, createBulkImport, folderAdapter, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";
import { useMemorySecrets } from "../../secrets-testing.js";
import { setSecret } from "../../secrets.js";
import { ZOTERO_WEB_FILE_NOTES, resumeZoteroWebImport, startZoteroWebImport, zoteroWebAdapter, zoteroWebSince, type ZoteroWebOptions } from "../zotero-web.js";
import { FakeZotero, guardNetwork } from "../../../tests/zotero/fake-zotero.js";
import { referenceMetadata } from "../refman.js";

const FAST = 2 ** 10;
const LOOKUP_FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/lookup");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload, refman_import, downloader]
processing:
  metadata_lookup: []
`;
/** Lookups through Crossref only (DOIs); no title searches. */
const CROSSREF_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: [crossref]
`;
const ENC_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let agent: MockAgent;
let http: HttpClient;
let bulk: BulkImport;
let fx: ImportFolderFixture;
let folder: string;

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

async function project(gov = GOV, encrypted = false): Promise<Project> {
  const { project } = await repo.createProject({
    name: `P${Math.random().toString(36).slice(2, 7)}`,
    governanceYaml: gov,
    encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
  });
  return project;
}

async function auditEvents(p: Project): Promise<AuditEvent[]> {
  const dir = join(lib.root, p.folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

/** Every file under a folder: relative path → sha256 (SQLite's shared-memory index, changed by reads, left out). */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.endsWith("-shm")) out.set(relative(dir, p), createHash("sha256").update(await readFile(p)).digest("hex"));
    }
  };
  await walk(dir);
  return out;
}

async function readProjectFile(p: Project, rel: string): Promise<string> {
  const k = projectDataKey(repo, p.id);
  const raw = await readFile(join(lib.root, p.folder, ...(k ? `${rel}.enc` : rel).split("/")));
  if (!k) return raw.toString("utf8");
  return (await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw)).toString("utf8");
}

async function run(p: Project, adapter: ImportSourceAdapter, options: Parameters<BulkImport["startBatch"]>[2] = {}) {
  const h = await bulk.startBatch(p.id, adapter, options);
  return { handle: h, result: await h.done };
}

const sum = (c: { created: number; needsReview: number; duplicates: number; merged: number; failed: number }) =>
  c.created + c.needsReview + c.duplicates + c.merged + c.failed;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-bulk-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  agent = new MockAgent();
  agent.disableNetConnect();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  bulk = createBulkImport({ repo, http, index: handle });
  folder = join(tmp, "Papers");
  fx = await buildImportFolder(folder);
});

afterEach(async () => {
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

describe("dryRun", () => {
  it("counts the folder (ZIP included) and writes nothing to the library", async () => {
    const p = await project();
    const before = await tree(lib.root);
    const s = await bulk.dryRun(p.id, folderAdapter(folder));
    expect(s.items).toBe(fx.items);
    expect(s.byType.pdf).toBe(fx.items);
    expect(s.likelyDuplicates).toBe(1);
    expect(s.alreadyImported).toBe(0);
    expect(s.unreadable).toEqual([{ path: "Damaged - 2020 - Broken Scan.pdf", reason: expect.stringMatching(/could not be read/) }]);
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain(tmp);
    expect(await tree(lib.root)).toEqual(before);
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("batch-"))).toEqual([]);
  });
});

describe("startBatch", () => {
  it("imports the folder: totals equal items, nested folders become nested collections, the corrupt PDF fails with a reason", async () => {
    const p = await project();
    const seen: number[] = [];
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    const progress = (async () => {
      for await (const e of h.progress) seen.push(e.done);
    })();
    const r = await h.done;
    await progress;
    expect(r.state).toBe("finished");
    expect(r.counts.items).toBe(fx.items);
    expect(sum(r.counts)).toBe(fx.items);
    expect(r.counts.duplicates).toBe(1);
    expect(r.counts.failed).toBe(1);
    expect(r.counts.merged).toBe(0);
    expect(seen.at(-1)).toBe(fx.items);

    // Sources: one per created/needs-review item, each carrying the batch id.
    const ids = repo.listSourceIds(p.id);
    expect(ids).toHaveLength(r.counts.created + r.counts.needsReview);
    const sfs = await Promise.all(ids.map((id) => repo.getSource(p.id, id)));
    expect(sfs.every((sf) => sf.source.provenance.importBatchId === h.batchId && sf.source.provenance.captureMethod === "manual_upload")).toBe(true);

    // Nested collections: Fieldwork > 2021, Fieldwork > 2022, Theory > Classics, Bundle > Sub.
    const { projectCollectionsAndTags } = await import("../../repo/repo.js");
    const { collections } = await projectCollectionsAndTags(repo, p.id);
    const byName = (n: string, parent?: string) => collections.find((c) => c.name === n && c.parentId === parent);
    const fieldwork = byName("Fieldwork");
    expect(fieldwork).toBeDefined();
    const y2021 = byName("2021", fieldwork!.id);
    expect(y2021).toBeDefined();
    expect(byName("Classics", byName("Theory")!.id)).toBeDefined();
    expect(byName("Sub", byName("Bundle")!.id)).toBeDefined();
    const ito = sfs.find((sf) => sf.source.title.variants[0]!.value === "Market Days")!;
    expect(ito.source.collectionIds).toEqual([y2021!.id]);

    // Report: failure with its reason, no absolute paths; sealed nowhere (plain project); audited.
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures).toEqual([{ item: "Damaged - 2020 - Broken Scan.pdf", reason: expect.stringMatching(/could not be read/) }]);
    expect(report.pendingReview).toHaveLength(r.counts.needsReview);
    expect(report.governance.some((g) => g.action === "capture" && g.result !== "deny")).toBe(true);
    const files = await readdir(join(lib.root, p.folder, "imports", "batch-0001"));
    expect(files).toEqual(expect.arrayContaining(["batch.json", "journal.jsonl", "report.json", "report.md"]));
    const md = await readFile(join(lib.root, p.folder, "imports", "batch-0001", "report.md"), "utf8");
    expect(md).toContain("Broken Scan");
    expect(md).not.toContain(tmp);
    expect(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "report.json"), "utf8")).not.toContain(tmp);
    const journal = (await readFile(join(lib.root, p.folder, "imports", "batch-0001", "journal.jsonl"), "utf8")).trim().split("\n");
    expect(new Set(journal.map((l) => (JSON.parse(l) as { key: string }).key)).size).toBe(fx.items);
    const events = await auditEvents(p);
    const batchEvents = events.filter((e) => e.action === "import.batch");
    expect(batchEvents.length).toBeGreaterThanOrEqual(1);
    expect(batchEvents.at(-1)!.details).toMatchObject({ batchId: h.batchId, created: r.counts.created, failed: 1 });
    // Each store is a governed change with its txn.
    expect(events.filter((e) => e.details?.op === "source.create" && e.action === "store").length).toBe(ids.length);

    // Review entries are persisted with the batch id (R31).
    const review = await bulk.listReview(p.id, h.batchId);
    expect(review).toHaveLength(r.counts.needsReview);
    expect(review.every((e) => e.batchId === h.batchId && e.status === "pending")).toBe(true);

    // The work folder is gone.
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("batch-"))).toEqual([]);
    expect((await bulk.listBatches(p.id))[0]).toMatchObject({ batchId: h.batchId, state: "finished" });
  });

  it("a DOI-identified PDF (lookup confirms it) is created at or above the threshold", async () => {
    const p = await project(CROSSREF_GOV);
    agent.get("https://api.crossref.org").intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, readFileSync(join(LOOKUP_FIX, "crossref-work.json"), "utf8"), JSON_HEADERS).persist();
    const src = join(tmp, "two");
    await mkdir(src);
    await copyFile(fx.doiPdf, join(src, "a.pdf"));
    const { result } = await run(p, folderAdapter(src));
    expect(result.counts.created).toBe(1);
    const [id] = repo.listSourceIds(p.id);
    expect((await repo.getSource(p.id, id!)).source.identifiers.doi).toBe(FIXTURE_DOI);
  });

  it("two identical files in one batch: one created, one duplicate (in-batch keys)", async () => {
    const p = await project();
    const src = join(tmp, "same");
    await mkdir(src);
    const bytes = await buildPdf({ title: "Twin", author: "Doe", lines: ["Twin"] });
    await writeFile(join(src, "one.pdf"), bytes);
    await writeFile(join(src, "two.pdf"), bytes);
    const { result } = await run(p, folderAdapter(src));
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    expect(result.counts.duplicates).toBe(1);
  });

  it("running the same source again creates nothing: every item is a duplicate (or the same failure)", async () => {
    const p = await project();
    const first = await run(p, folderAdapter(folder));
    const count = repo.listSourceIds(p.id).length;
    const second = await run(p, folderAdapter(folder));
    expect(second.result.counts.created).toBe(0);
    expect(second.result.counts.needsReview).toBe(0);
    expect(second.result.counts.duplicates).toBe(fx.items - 1);
    expect(second.result.counts.failed).toBe(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(count);
    expect(first.handle.batchId).not.toBe(second.handle.batchId);
  });

  it("an encrypted project: journal, batch record and report are sealed; dedupe uses the in-memory keys (R30)", async () => {
    const p = await project(ENC_GOV, true);
    const src = join(tmp, "enc");
    await mkdir(src);
    for (const n of fx.generated.slice(1, 4)) await copyFile(n, join(src, n.split(/[\\/]/).pop()!));
    const first = await run(p, folderAdapter(src));
    expect(first.result.counts.created + first.result.counts.needsReview).toBe(3);
    const dir = join(lib.root, p.folder, "imports", "batch-0001");
    const names = await readdir(dir);
    expect(names).toEqual(expect.arrayContaining(["batch.json.enc", "journal.jsonl", "report.json.enc", "report.md.enc"]));
    expect(names).not.toContain("report.md");
    const journal = await readFile(join(dir, "journal.jsonl"), "utf8");
    expect(journal).not.toContain("Okafor");
    expect(journal).toContain('"ct"');
    expect(await readProjectFile(p, "imports/batch-0001/report.md")).toContain("Created: ");
    const again = await run(p, folderAdapter(src));
    expect(again.result.counts.duplicates).toBe(3);
  });
});

describe("link option (R24)", () => {
  it("stores both paths and copies nothing", async () => {
    const p = await project();
    const src = join(tmp, "linkme");
    await mkdir(src);
    const file = join(src, "Okafor - 2019 - Feeding the Feed.pdf");
    await copyFile(fx.generated[1]!, file);
    const { result } = await run(p, folderAdapter(src), { fileHandling: "link" });
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
    const a = sf.assets[0]!;
    expect(a.linked).toEqual({ absolutePath: file, libraryRelativePath: "../linkme/Okafor - 2019 - Feeding the Feed.pdf" });
    expect(a.path).toBe(a.linked!.libraryRelativePath);
    expect(a.encrypted).toBe(false);
    expect(await readdir(join(lib.root, sf.source.folder, "original"))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("is refused in a project that requires encryption at rest; the batch does not start", async () => {
    const p = await project(ENC_GOV, true);
    const err = await bulk.startBatch(p.id, folderAdapter(folder), { fileHandling: "link" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchRefusedError);
    expect((err as BatchRefusedError).reason).toMatch(/cannot be linked/);
    expect(await readdir(join(lib.root, p.folder, "imports")).catch(() => [])).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });
});

describe("ZIP archives", () => {
  it("an archive with a traversal name is refused as a whole, with a reason; nothing is written outside", async () => {
    const p = await project();
    const src = join(tmp, "zips");
    await mkdir(src);
    const pdf = await buildPdf({ title: "Escape", lines: ["Escape"] });
    await writeFile(join(src, "evil.zip"), buildZip([{ name: "ok.pdf", data: pdf }, { name: "../../escape.pdf", data: pdf }]));
    await writeFile(join(src, "link.zip"), buildZip([{ name: "target", data: "/etc/passwd", unixMode: 0o120777 }, { name: "fine.pdf", data: pdf }]));
    const { handle: h, result } = await run(p, folderAdapter(src));
    expect(result.counts).toMatchObject({ items: 2, failed: 2, created: 0, needsReview: 0 });
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures.map((f) => f.item).sort()).toEqual(["evil.zip", "link.zip"]);
    expect(report.failures.every((f) => /points outside it/.test(f.reason))).toBe(true);
    expect(existsSync(join(lib.root, "escape.pdf"))).toBe(false);
    expect(existsSync(join(lib.root, ".tmp", "escape.pdf"))).toBe(false);
    expect(existsSync(join(tmp, "escape.pdf"))).toBe(false);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });
});

describe("user file-name patterns (R49d)", () => {
  it("a pattern with nested quantifiers is rejected when the options are accepted", async () => {
    const p = await project();
    const err = await bulk
      .startBatch(p.id, folderAdapter(folder), { fileNamePatterns: [{ id: "bad", regex: "^(?<title>(a+)+)$" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchRefusedError);
    expect((err as BatchRefusedError).reason).toMatch(/"bad".*nested repetition/);
  });

  it("a slow pattern that passes vetting times out in the watchdog, is switched off for the batch and noted in the report", async () => {
    const p = await project();
    const src = join(tmp, "names");
    await mkdir(src);
    const plain = (s: string) => buildPdf({ lines: [s, "no title metadata here"], extra: s });
    await writeFile(join(src, `${"a".repeat(26)}!.pdf`), await plain("one"));
    await writeFile(join(src, "1999_Patterned Title.pdf"), await plain("two"));
    await writeFile(join(src, `${"a".repeat(26)}?.pdf`), await plain("three"));
    const started = Date.now();
    const { handle: h, result } = await run(p, folderAdapter(src), {
      fileNamePatterns: [
        { id: "slow", regex: "^(?<title>(a|a)*)$" },
        { id: "good", regex: "^(?<year>\\d{4})_(?<title>.+)$" },
      ],
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.counts.failed).toBe(0);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes.some((n) => n.includes('"slow"') && n.includes("switched off"))).toBe(true);
    const titles = await Promise.all(repo.listSourceIds(p.id).map(async (id) => (await repo.getSource(p.id, id)).source.title.variants[0]!.value));
    expect(titles).toContain("Patterned Title");
  });
});

describe("pause, cancel and resume", () => {
  it("cancel after 7 items, resumeBatch: the same final counts as an uninterrupted run, no duplicate sources", async () => {
    const whole = await project();
    const reference = await run(whole, folderAdapter(folder));

    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    for await (const e of h.progress) {
      if (e.done >= 7) {
        h.cancel();
        break;
      }
    }
    const stopped = await h.done;
    expect(stopped.state).toBe("cancelled");
    expect(stopped.counts.items).toBe(7);
    expect((await bulk.listBatches(p.id))[0]!.state).toBe("cancelled");
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("batch-"))).toEqual([]);

    const resumed = await bulk.resumeBatch(p.id, h.batchId);
    expect(resumed.batchId).toBe(h.batchId);
    const final = await resumed.done;
    expect(final.state).toBe("finished");
    expect(final.counts).toEqual(reference.result.counts);
    expect(repo.listSourceIds(p.id)).toHaveLength(repo.listSourceIds(whole.id).length);
    const titles = await Promise.all(repo.listSourceIds(p.id).map(async (id) => (await repo.getSource(p.id, id)).source.title.variants[0]!.value));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("pause holds the run until resume", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    h.pause();
    await new Promise((r) => setTimeout(r, 300));
    const during = repo.listSourceIds(p.id).length;
    expect(during).toBeLessThanOrEqual(1);
    expect((await bulk.listBatches(p.id))[0]!.state).toMatch(/paused|running/);
    h.resume();
    const r = await h.done;
    expect(r.state).toBe("finished");
    expect(sum(r.counts)).toBe(fx.items);
  });

  it("a batch left 'running' by a crash is shown as interrupted (R45) and can be resumed", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    await h.done;
    // Simulate a crash mid-run: the record still says running and no process runs it.
    const recPath = join(lib.root, p.folder, "imports", "batch-0001", "batch.json");
    const rec = JSON.parse(await readFile(recPath, "utf8")) as Record<string, unknown>;
    await writeFile(recPath, JSON.stringify({ ...rec, state: "running" }));
    expect((await bulk.listBatches(p.id))[0]!.state).toBe("interrupted");
    const again = await (await bulk.resumeBatch(p.id, h.batchId)).done;
    expect(again.state).toBe("finished");
    expect(again.counts.items).toBe(fx.items);
  });
});

describe("review queue: workspace tags being deleted (41a N2)", () => {
  it("a bulk review edit cannot put a workspace tag being deleted on a source, whether it is marked already or the delete races it", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const items = await bulk.listReview(p.id, h.batchId);
    expect(items.length).toBeGreaterThanOrEqual(2);
    // Already marked: the delete stopped part-way (another project could not take it).
    const marked = await repo.createTag("workspace", "marked");
    const tagsFile = join(lib.root, "tags.json");
    const tj = JSON.parse(await readFile(tagsFile, "utf8")) as Record<string, unknown>;
    await writeFile(tagsFile, JSON.stringify({ ...tj, deleting: [marked.id] }));
    await expect(bulk.bulkEditReview(p.id, [items[0]!.id], { tagIds: [marked.id] })).rejects.toThrow(/not found/i);
    expect((await repo.getSource(p.id, items[0]!.sourceId!)).source.tagIds).not.toContain(marked.id);
    // Racing: the edit checks its tags, the whole delete runs, then the edit writes.
    for (let round = 0; round < 3; round++) {
      const tag = await repo.createTag("workspace", `racing ${round}`);
      let done = false;
      const del = repo.deleteWorkspaceTag(tag.id).finally(() => {
        done = true;
      });
      while (!done) await bulk.bulkEditReview(p.id, [items[1]!.id], { tagIds: [tag.id] }).catch(() => {});
      await del;
      expect((await repo.listWorkspaceTags()).some((t) => t.id === tag.id)).toBe(false);
      expect((await repo.getSource(p.id, items[1]!.sourceId!)).source.tagIds).not.toContain(tag.id);
    }
  });

  it("createSource refuses a workspace tag whose deletion has started", async () => {
    const p = await project();
    const tag = await repo.createTag("workspace", "going");
    const tagsFile = join(lib.root, "tags.json");
    const tj = JSON.parse(await readFile(tagsFile, "utf8")) as Record<string, unknown>;
    await writeFile(tagsFile, JSON.stringify({ ...tj, deleting: [tag.id] }));
    const before = repo.listSourceIds(p.id).length;
    await expect(
      repo.createSource(p.id, { projectIds: [], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "T" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [tag.id], participantIds: [] }, [], {
        provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      }),
    ).rejects.toThrow(/not found/i);
    expect(repo.listSourceIds(p.id).length).toBe(before);
  });
});

describe("review queue", () => {
  it("decideReview and bulkEditReview are governed, audited changes", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const items = await bulk.listReview(p.id, h.batchId);
    expect(items.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = items;
    const tag = await repo.createTag(p.id, "to read");

    await bulk.bulkEditReview(p.id, [a!.id, b!.id], { type: "book", tagIds: [tag.id] });
    for (const it of [a!, b!]) {
      const sf = await repo.getSource(p.id, it.sourceId!);
      expect(sf.source.type).toBe("book");
      expect(sf.source.tagIds).toContain(tag.id);
    }
    await bulk.decideReview(p.id, a!.id, { action: "accept", draft: { title: { variants: [{ lang: "en", kind: "original", value: "Accepted Title" }] } } as Partial<SourceDraft> as SourceDraft });
    expect((await repo.getSource(p.id, a!.sourceId!)).source.title.variants[0]!.value).toBe("Accepted Title");
    await bulk.decideReview(p.id, b!.id, { action: "skip" });
    expect(repo.listSourceIds(p.id)).not.toContain(b!.sourceId);
    await bulk.decideReview(p.id, c!.id, { action: "merge", sourceId: a!.sourceId! });
    expect(repo.listSourceIds(p.id)).not.toContain(c!.sourceId);
    expect((await repo.getSource(p.id, a!.sourceId!)).assets.filter((x) => x.role === "original")).toHaveLength(2);

    const left = await bulk.listReview(p.id, h.batchId);
    expect(left.map((e) => e.id)).not.toEqual(expect.arrayContaining([a!.id, b!.id, c!.id]));
    const ops = (await auditEvents(p)).map((e) => e.details?.op);
    expect(ops).toEqual(expect.arrayContaining(["review.decide", "review.bulk-edit"]));
  });

  it("listProjectReview (Task 67, R172): every pending entry of the project, of every kind, oldest first, paged, with titles; decided entries and entries of removed sources are left out", async () => {
    const p = await project();
    const other = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const batchItems = await bulk.listReview(p.id, h.batchId);
    expect(batchItems.length).toBeGreaterThanOrEqual(3);
    // Entries with no batch, as a drag-and-drop attach (import) and a capture or a consent withdrawal (verification) queue them.
    const attached = await repo.createSource(p.id, plainDraft("Attached by hand"), [], { provenance: plainProvenance(), reviewItem: { kind: "import", fields: {}, reasons: ["Check it."] } });
    const captured = await repo.createSource(p.id, plainDraft("A captured page"), [], { provenance: plainProvenance(), reviewItem: { fields: { "/title": "conflict" }, reasons: ["The title disagrees."] } });
    const flagged = await repo.createSource(p.id, plainDraft("An interview"), [], { provenance: plainProvenance(), reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."] } });
    await repo.createSource(other.id, plainDraft("Another project's"), [], { provenance: plainProvenance(), reviewItem: { kind: "import", fields: {}, reasons: ["x"] } });
    // One batch item decided, one whose source is gone.
    await bulk.decideReview(p.id, batchItems[0]!.id, { action: "keep-both" });
    await repo.deleteSource(p.id, batchItems[1]!.sourceId!);

    const all = await bulk.listProjectReview(p.id);
    const expected = batchItems.length - 2 + 3;
    expect(all.total).toBe(expected);
    expect(all.items).toHaveLength(expected);
    expect(all.items.every((e) => e.status === "pending" && e.projectId === p.id)).toBe(true);
    const ids = all.items.map((e) => e.id);
    expect(ids).not.toContain(batchItems[0]!.id);
    expect(ids).not.toContain(batchItems[1]!.id);
    const bySource = new Map(all.items.map((e) => [e.sourceId, e]));
    expect(bySource.get(attached.source.id)).toMatchObject({ kind: "import", title: "Attached by hand" });
    expect(bySource.get(attached.source.id)!.batchId).toBeUndefined();
    expect(bySource.get(captured.source.id)).toMatchObject({ kind: "verification", fields: { "/title": "conflict" }, title: "A captured page" });
    expect(bySource.get(flagged.source.id)).toMatchObject({ kind: "verification", fields: {}, title: "An interview" });
    const times = all.items.map((e) => e.createdAt);
    expect([...times].sort()).toEqual(times);

    const page = await bulk.listProjectReview(p.id, { offset: 1, limit: 2 });
    expect(page.total).toBe(expected);
    expect(page.items.map((e) => e.id)).toEqual(ids.slice(1, 3));
    const one = await bulk.listProjectReview(p.id, { sourceId: captured.source.id });
    expect(one).toMatchObject({ total: 1, items: [{ sourceId: captured.source.id }] });
    expect((await bulk.listProjectReview(p.id, { limit: 0 })).items).toEqual([]);
  });

  it("listProjectReview refuses a locked project", async () => {
    const p = await project(ENC_GOV, true);
    await repo.createSource(p.id, plainDraft("Sealed"), [], { provenance: plainProvenance(), reviewItem: { kind: "import", fields: {}, reasons: ["x"] } });
    repo.lockProject(p.id);
    await expect(bulk.listProjectReview(p.id)).rejects.toThrow(/locked/i);
  });
});

describe("undoBatch", () => {
  it("removes what the batch created and restores a merged source to its snapshot", async () => {
    const p = await project(CROSSREF_GOV);
    agent.get("https://api.crossref.org").intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, readFileSync(join(LOOKUP_FIX, "crossref-work.json"), "utf8"), JSON_HEADERS).persist();
    // A source already in the project with the article's DOI (and nothing else).
    const existing = await repo.createSource(
      p.id,
      {
        projectIds: [],
        type: "other",
        title: { variants: [{ lang: "en", kind: "original", value: "Rivers and Memory in Upland Villages" }] },
        creators: [],
        identifiers: { doi: FIXTURE_DOI },
        caseAttributes: {},
        availability: { status: "available" },
        collectionIds: [],
        tagIds: [],
        participantIds: [],
      },
      [],
      {
        provenance: {
          captureMethod: "manual_upload",
          capturedAt: new Date().toISOString(),
          tool: { name: "test", version: "0" },
          fileHashes: {},
          legal: { status: "unknown" },
          identifiable: false,
        },
      },
    );
    const before = await repo.getSource(p.id, existing.source.id);
    const pre = repo.listSourceIds(p.id).length;

    const { handle: h, result } = await run(p, folderAdapter(folder));
    expect(result.counts.merged).toBe(1);
    const merged = await repo.getSource(p.id, existing.source.id);
    expect(merged.assets).toHaveLength(1);
    expect(merged.source.type).not.toBe("other");
    const { collections } = await (await import("../../repo/repo.js")).projectCollectionsAndTags(repo, p.id);
    expect(collections.length).toBeGreaterThan(0);

    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.revertedMerges).toBe(1);
    expect(u.removedSources).toBe(result.counts.created + result.counts.needsReview);
    expect(repo.listSourceIds(p.id)).toHaveLength(pre);
    const after = await repo.getSource(p.id, existing.source.id);
    expect({ ...after, source: { ...after.source, modifiedAt: "", modifiedBy: "" } }).toEqual({ ...before, source: { ...before.source, modifiedAt: "", modifiedBy: "" } });
    expect((await (await import("../../repo/repo.js")).projectCollectionsAndTags(repo, p.id)).collections).toEqual([]);
    // The user's files are untouched.
    expect(existsSync(fx.doiPdf)).toBe(true);
    expect((await bulk.listBatches(p.id))[0]!.state).toBe("undone");
    expect((await auditEvents(p)).some((e) => e.action === "import.undo")).toBe(true);
    expect(await bulk.listReview(p.id, h.batchId)).toEqual([]);
  });

  it("a linked batch's undo never touches the linked originals", async () => {
    const p = await project();
    const src = join(tmp, "linked");
    await mkdir(src);
    await copyFile(fx.generated[2]!, join(src, "x.pdf"));
    const { handle: h } = await run(p, folderAdapter(src), { fileHandling: "link" });
    await bulk.undoBatch(p.id, h.batchId);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(await readFile(join(src, "x.pdf"))).toEqual(await readFile(fx.generated[2]!));
  });

  it("finds sources by provenance importBatchId as well as batch.json (R45), and removes a profile batch's post ids from profile.json and archive.txt (R44)", async () => {
    const p = await project();
    const batchId = "019a0000-0000-7000-8000-000000000001";
    const mk = async (title: string, postId: string, inBatch = true) =>
      repo.createSource(
        p.id,
        {
          projectIds: [],
          type: "social-post",
          title: { variants: [{ lang: "en", kind: "original", value: title }] },
          creators: [],
          identifiers: { platform: "instagram", platformPostId: postId },
          caseAttributes: {},
          availability: { status: "available" },
          collectionIds: [],
          tagIds: [],
          participantIds: [],
        },
        [],
        {
          provenance: {
            captureMethod: "downloader",
            capturedAt: new Date().toISOString(),
            tool: { name: "test", version: "0" },
            fileHashes: {},
            ...(inBatch ? { importBatchId: batchId } : {}),
            legal: { status: "unknown" },
            identifiable: false,
          },
        },
      );
    const keep = await mk("Older post", "P0", false);
    const a = await mk("Post A", "PA");
    const b = await mk("Post B", "PB"); // created but not in batch.json (crash before the record was saved)
    const c = await mk("Post C", "PC"); // deleted by the user before the undo (R44: stays known)
    const profileDir = "profiles/instagram-someone";
    await repo.mutate(p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async (tx) => {
      const base = `${p.folder}/imports/batch-0001`;
      await tx.mkdir(base);
      await tx.writeFile(
        `${base}/batch.json`,
        JSON.stringify({
          id: batchId,
          projectId: p.id,
          number: 1,
          source: { kind: "profile-capture", location: profileDir },
          options: {},
          startedAt: new Date().toISOString(),
          counts: { created: 2, merged: 0, skipped: 0, failed: 0, needsReview: 0 },
          state: "finished",
          createdSourceIds: [a.source.id],
        }),
      );
      await tx.appendLine(`${base}/journal.jsonl`, JSON.stringify({ key: "PA", outcome: "created", sourceId: a.source.id }));
      await tx.appendLine(`${base}/journal.jsonl`, JSON.stringify({ key: "PB", outcome: "created", sourceId: b.source.id }));
      await tx.appendLine(`${base}/journal.jsonl`, JSON.stringify({ key: "PC", outcome: "created", sourceId: c.source.id }));
      await tx.mkdir(`${p.folder}/${profileDir}`);
      await tx.writeFile(
        `${p.folder}/${profileDir}/profile.json`,
        JSON.stringify({ platform: "instagram", handle: "someone", knownPostIds: ["P0", "PA", "PB", "PC"], knownPosts: { P0: { listing: "posts" }, PA: { listing: "posts" }, PB: { listing: "posts" }, PC: { listing: "posts" } } }),
      );
      await tx.writeFile(`${p.folder}/${profileDir}/archive.txt`, "instagram P0\ninstagram PA\ninstagram PB\ninstagram PC\n");
    });
    await repo.deleteSource(p.id, c.source.id);
    const u = await bulk.undoBatch(p.id, batchId);
    expect(u.removedSources).toBe(2);
    expect(repo.listSourceIds(p.id)).toEqual([keep.source.id]);
    const profile = JSON.parse(await readProjectFile(p, `${profileDir}/profile.json`)) as { knownPostIds: string[]; knownPosts: Record<string, unknown> };
    expect(profile.knownPostIds).toEqual(["P0", "PC"]);
    expect(Object.keys(profile.knownPosts)).toEqual(["P0", "PC"]);
    expect(await readProjectFile(p, `${profileDir}/archive.txt`)).toBe("instagram P0\ninstagram PC\n");
  });
});

const plainDraft = (title: string, extra: Partial<SourceDraft> = {}): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
  ...extra,
});
const plainProvenance = () => ({
  captureMethod: "manual_upload" as const,
  capturedAt: new Date().toISOString(),
  tool: { name: "test", version: "0" },
  fileHashes: {},
  legal: { status: "unknown" as const },
  identifiable: false,
});

describe("duplicates (R55, R59)", () => {
  const doiFolder = async () => {
    const src = join(tmp, "doi");
    await mkdir(src);
    await copyFile(fx.doiPdf, join(src, "article.pdf"));
    return src;
  };
  const crossref = () =>
    agent.get("https://api.crossref.org").intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, readFileSync(join(LOOKUP_FIX, "crossref-work.json"), "utf8"), JSON_HEADERS).persist();

  it("a certain DOI match with duplicates: 'skip' is a duplicate and changes nothing", async () => {
    const p = await project(CROSSREF_GOV);
    crossref();
    const existing = await repo.createSource(p.id, plainDraft("Rivers and Memory in Upland Villages", { identifiers: { doi: FIXTURE_DOI } }), [], { provenance: plainProvenance() });
    const { result } = await run(p, folderAdapter(await doiFolder()), { duplicates: "skip" });
    expect(result.counts).toMatchObject({ duplicates: 1, created: 0, merged: 0 });
    expect(await repo.getSource(p.id, existing.source.id)).toEqual(existing);
  });

  it("a certain DOI match with duplicates: 'keep-both' creates a second source", async () => {
    const p = await project(CROSSREF_GOV);
    crossref();
    await repo.createSource(p.id, plainDraft("Rivers and Memory in Upland Villages", { identifiers: { doi: FIXTURE_DOI } }), [], { provenance: plainProvenance() });
    const { result } = await run(p, folderAdapter(await doiFolder()), { duplicates: "keep-both" });
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  });

  it("a fuzzy match (title, first creator, year) is created and goes to review with the candidate", async () => {
    const p = await project();
    const existing = await repo.createSource(
      p.id,
      plainDraft("Feeding the Feed", { creators: [{ role: "author", family: "Okafor" }], issued: "2019" }),
      [],
      { provenance: plainProvenance() },
    );
    const src = join(tmp, "fuzzy");
    await mkdir(src);
    await copyFile(fx.generated[1]!, join(src, "Okafor - 2019 - Feeding the Feed.pdf"));
    const { handle: h, result } = await run(p, folderAdapter(src));
    expect(result.counts).toMatchObject({ needsReview: 1, duplicates: 0, merged: 0 });
    const [entry] = await bulk.listReview(p.id, h.batchId);
    expect(entry!.duplicateOf).toEqual({ sourceId: existing.source.id, reason: "fuzzy" });
  });
});

describe("groups (R62)", () => {
  it("a group refused because the rules changed mid-run: each item's deny is audited exactly once", async () => {
    const p = await project();
    const src = join(tmp, "group");
    await mkdir(src);
    for (const n of fx.generated.slice(1, 5)) await copyFile(n, join(src, n.split(/[\\/]/).pop()!));
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    h.pause();
    await new Promise((r) => setTimeout(r, 200));
    const govPath = join(lib.root, p.folder, "governance.yaml");
    await writeFile(govPath, (await readFile(govPath, "utf8")).replace("captureMethods: [manual_upload, refman_import, downloader]", "captureMethods: [refman_import]"));
    h.resume();
    const r = await h.done;
    expect(r.counts.failed).toBeGreaterThanOrEqual(1);
    const denies = (await auditEvents(p)).filter((e) => e.decision?.result === "deny" && e.details?.op === "source.create");
    expect(denies).toHaveLength(r.counts.failed);
  });
});

describe("location rule (R83)", () => {
  const gov = (atRest: string) => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: ${atRest}
sharing:
  locationMetadata: coarsen
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
  let et: ExifTool;
  const closers: Array<() => Promise<void> | void> = [];
  beforeAll(() => {
    et = new ExifTool({ maxProcs: 1 });
  });
  afterAll(async () => {
    await et.end();
  });
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  async function photos(): Promise<string> {
    const src = join(tmp, "photos");
    await mkdir(src);
    await buildCameraTiff(join(src, "IMG_0001.tif"));
    await copyFile(fx.generated[3]!, join(src, "paper.pdf"));
    return src;
  }

  it("a photo with GPS in a coarsen project is stored encrypted with its GPS and gets a coarsened proxy (re-read); the batch goes on", async () => {
    const w = await stubWorker(proxyStub(et), { closers, pollsUntilDone: 1 });
    const proxies = new ProxyQueue({ repo, worker: new WorkerClient({ repo, worker: w, pollMs: 5 }) });
    const withProxies = createBulkImport({ repo, http, index: handle, proxies });
    const p = await project(gov("required"), true);
    const h = await withProxies.startBatch(p.id, folderAdapter(await photos()));
    const result = await h.done;
    await proxies.idle();
    expect(result.counts.failed).toBe(0);
    expect(result.counts.created + result.counts.needsReview).toBe(2);
    const photo = (await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)))).find((s) => s.assets.some((a) => a.kind === "image"))!;
    const original = photo.assets.find((a) => a.role === "original")!;
    expect(original.encrypted).toBe(true);
    const k = projectDataKey(repo, p.id)!;
    const plain = async (rel: string) => {
      const out = join(tmp, `plain-${Math.random().toString(36).slice(2)}.${rel.replace(/\.enc$/u, "").split(".").pop()}`);
      await writeFile(out, await decryptBytes((id) => (id === k.keyId ? k.key : undefined), await readFile(join(lib.root, ...rel.split("/")))));
      return out;
    };
    expect(await gpsOf(et, await plain(original.path))).toEqual({ lat: 40.6892, lon: -74.0445 });
    const proxy = photo.assets.find((a) => a.role === "derived")!;
    expect(proxy).toMatchObject({ kind: "proxy", derivation: { operation: "image.proxy", parents: [original.id], params: { location: "coarsen" } } });
    expect(await gpsOf(et, await plain(proxy.path))).toEqual({ lat: 40.7, lon: -74 });
    const report = await withProxies.batchReport(p.id, h.batchId);
    expect(report.failures).toEqual([]);
    expect(report.notes).not.toContain(LOCATION_REASON);
  });

  it("no media worker: the photo is stored and flagged proxy pending (LOCATION_REASON in the report)", async () => {
    const p = await project(gov("required"), true);
    const h = await bulk.startBatch(p.id, folderAdapter(await photos()));
    const result = await h.done;
    expect(result.counts.failed).toBe(0);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(LOCATION_REASON);
    expect(report.fileNotes).toContainEqual({ item: "IMG_0001.tif", note: LOCATION_REASON });
    const photo = (await Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)))).find((s) => s.assets.some((a) => a.kind === "image"))!;
    expect(photo.pendingProxies?.map((j) => [j.type, j.location])).toEqual([["image.proxy", "coarsen"]]);
  });

  it("encryption off + coarsen: the store is denied with the engine's reason; the batch goes on", async () => {
    const p = await project(gov("off"), false);
    const h = await bulk.startBatch(p.id, folderAdapter(await photos()));
    const result = await h.done;
    expect(result.counts.failed).toBe(1);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures).toEqual([{ item: "IMG_0001.tif", reason: "Location data requires encryption or locationMetadata: keep" }]);
  });
});

describe("undo and the review queue (Task 67 fix round 1, M1; coordinator's ruling 3)", () => {
  it("each source's removal resolves its pending entries in the same change: a crash between two removals leaves no pending entry of a source that is gone", async () => {
    const { SimulatedCrash, seams } = await import("../../repo/testing.js");
    const { projectReviewEntries } = await import("../../repo/repo.js");
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const items = await bulk.listReview(p.id, h.batchId);
    expect(items.length).toBeGreaterThanOrEqual(2);
    // One batch-created source is also flagged by a consent withdrawal (an entry outside the batch).
    const part = await repo.createParticipant(p.id, {});
    const c = await repo.createConsent(p.id, { participantId: part.id, scope: "audio", date: "2026-03-14" });
    for (const it of items) await repo.linkSourceToFieldwork(p.id, it.sourceId!, { participantIds: [part.id] });
    await repo.withdrawConsent(p.id, c.id, {});
    // Crash right after the first removal commits (before its marker is deleted).
    seams.crashAt = "before-marker-delete";
    await expect(bulk.undoBatch(p.id, h.batchId)).rejects.toBeInstanceOf(SimulatedCrash);
    seams.crashAt = undefined;
    handle.close();
    await lib.close();
    lib = await openLibrary(join(tmp, "Lib"), deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    const present = new Set(repo.listSourceIds(p.id));
    const gone = items.map((i) => i.sourceId!).filter((sid) => !present.has(sid));
    expect(gone.length).toBe(1);
    const entries = await projectReviewEntries(repo, p.id);
    const ofGone = entries.filter((e) => gone.includes(e.sourceId!));
    expect(ofGone.length).toBeGreaterThanOrEqual(2); // its batch item and its withdrawal flag
    expect(ofGone.map((e) => [e.status, e.decision])).toEqual(ofGone.map(() => ["resolved", "undone"]));
  });
});

describe("work folders", () => {
  it("leftover batch-* folders are swept when the repository is opened", async () => {
    const stale = join(lib.root, ".tmp", "batch-019a0000-0000-7000-8000-00000000abcd");
    await mkdir(join(stale, "zip-1"), { recursive: true });
    await writeFile(join(stale, "zip-1", "x.pdf"), "x");
    handle.close();
    await lib.close();
    lib = await openLibrary(join(tmp, "Lib"), deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    expect(existsSync(stale)).toBe(false);
  });
});


const crossrefPersist = () =>
  agent.get("https://api.crossref.org").intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, readFileSync(join(LOOKUP_FIX, "crossref-work.json"), "utf8"), JSON_HEADERS).persist();
const WORK_TITLE = "Rivers and Memory in Upland Villages";
/** A PDF of the fixture work (its title, its DOI in the text), different bytes per `tag`. */
const workPdf = (tag: string) => buildPdf({ title: WORK_TITLE, lines: [WORK_TITLE, `https://doi.org/${FIXTURE_DOI}`, `copy ${tag}`], extra: tag });
const folderWith = async (name: string, files: Record<string, Buffer>) => {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  for (const [n, b] of Object.entries(files)) await writeFile(join(dir, n), b);
  return dir;
};

describe("screens integration (R118 d): what the batch created", () => {
  it("the report and the batch list name the collections and tags the batch created (and only those)", async () => {
    const p = await project();
    const already = await repo.createCollection(p.id, "Fieldwork");
    const { handle: h } = await run(p, folderAdapter(folder));
    const { collections } = await projectCollectionsAndTags(repo, p.id);
    const made = collections.filter((c) => c.id !== already.id).map((c) => c.id).sort();
    expect(made.length).toBeGreaterThan(0);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect([...report.created.collectionIds].sort()).toEqual(made);
    expect(report.created.collectionIds).not.toContain(already.id);
    expect(report.created.tagIds).toEqual([]);
    const listed = (await bulk.listBatches(p.id))[0]!;
    expect([...listed.created.collectionIds].sort()).toEqual(made);

    const p2 = await project();
    const { handle: h2 } = await run(p2, folderAdapter(folder), { structure: "tags" });
    const tags = (await projectCollectionsAndTags(repo, p2.id)).tags.map((t) => t.id).sort();
    const r2 = await bulk.batchReport(p2.id, h2.batchId);
    expect([...r2.created.tagIds].sort()).toEqual(tags);
    expect(r2.created.collectionIds).toEqual([]);
  });
});

describe("screens integration (R118 f): review items carry their title", () => {
  it("listReview gives each item the current title of its source", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const review = await bulk.listReview(p.id, h.batchId);
    expect(review.length).toBeGreaterThan(0);
    for (const e of review) {
      const sf = await repo.getSource(p.id, e.sourceId!);
      expect(e.title).toBe(primary(sf.source.title));
    }
    // A later edit shows: the title is read when listed, not stored with the entry.
    const first = review[0]!;
    await repo.updateSource(p.id, first.sourceId!, { title: { variants: [{ lang: "en", kind: "original", value: "Corrected Title" }] } });
    expect((await bulk.listReview(p.id, h.batchId)).find((e) => e.id === first.id)!.title).toBe("Corrected Title");
  });
});

describe("review round 1: undo (R61)", () => {
  it("keeps a batch tag and a batch collection that the user put to use, and says so", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder), { structure: "tags" });
    const { tags } = await projectCollectionsAndTags(repo, p.id);
    const theory = tags.find((t) => t.name === "Theory")!;
    const own = await repo.createSource(p.id, plainDraft("My own notes"), [], { provenance: plainProvenance() });
    await repo.setMembership(p.id, own.source.id, { tagIds: [theory.id] });

    const p2 = await project();
    const { handle: h2 } = await run(p2, folderAdapter(folder));
    const cols = (await projectCollectionsAndTags(repo, p2.id)).collections;
    const fieldwork = cols.find((c) => c.name === "Fieldwork")!;
    const mine = await repo.createCollection(p2.id, "My subfolder", fieldwork.id);

    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.kept).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tag", id: theory.id })]));
    expect((await projectCollectionsAndTags(repo, p.id)).tags.map((t) => t.id)).toEqual([theory.id]);
    expect((await repo.getSource(p.id, own.source.id)).source.tagIds).toEqual([theory.id]);

    const u2 = await bulk.undoBatch(p2.id, h2.batchId);
    expect(u2.kept).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "collection", id: fieldwork.id })]));
    const left = (await projectCollectionsAndTags(repo, p2.id)).collections.map((c) => c.id).sort();
    expect(left).toEqual([fieldwork.id, mine.id].sort());
  }, 30_000); // two whole-folder imports (PDF text extraction, exiftool) and two undos: ~3-4 s alone, more under a loaded full run

  it("merge undo reverts only what the merge added: a user rename and a user edit of a filled field are kept", async () => {
    const p = await project(CROSSREF_GOV);
    crossrefPersist();
    const existing = await repo.createSource(p.id, plainDraft(WORK_TITLE, { type: "other", identifiers: { doi: FIXTURE_DOI } }), [], { provenance: plainProvenance() });
    const { handle: h, result } = await run(p, folderAdapter(await folderWith("m1", { "a.pdf": await workPdf("a") })));
    expect(result.counts.merged).toBe(1);
    const merged = await repo.getSource(p.id, existing.source.id);
    expect(merged.source.issued).toBeDefined();
    expect(merged.source.creators.length).toBeGreaterThan(0);
    // The user renames the source and corrects the date the merge filled in.
    await repo.updateSource(p.id, existing.source.id, { title: { variants: [{ lang: "en", kind: "original", value: "Renamed by me" }] }, issued: "1999" });

    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.revertedMerges).toBe(1);
    const after = await repo.getSource(p.id, existing.source.id);
    expect(after.source.title.variants[0]!.value).toBe("Renamed by me");
    expect(after.source.issued).toBe("1999");
    expect(after.source.creators).toEqual([]); // filled by the merge, untouched since: cleared
    expect(after.assets).toEqual([]);
    expect(u.kept).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "field", id: "/issued", sourceId: existing.source.id })]));
  });

  it("two batches merge into the same source; undoing the first keeps the second's files", async () => {
    const p = await project(CROSSREF_GOV);
    crossrefPersist();
    const s = await repo.createSource(p.id, plainDraft(WORK_TITLE, { identifiers: { doi: FIXTURE_DOI } }), [], { provenance: plainProvenance() });
    const a = await run(p, folderAdapter(await folderWith("ma", { "a.pdf": await workPdf("a") })));
    const b = await run(p, folderAdapter(await folderWith("mb", { "b.pdf": await workPdf("b") })));
    expect([a.result.counts.merged, b.result.counts.merged]).toEqual([1, 1]);
    const both = await repo.getSource(p.id, s.source.id);
    expect(both.assets).toHaveLength(2);
    const bAsset = both.assets[1]!;

    await bulk.undoBatch(p.id, a.handle.batchId);
    const after = await repo.getSource(p.id, s.source.id);
    expect(after.assets.map((x) => x.id)).toEqual([bAsset.id]);
    expect(existsSync(join(lib.root, ...bAsset.path.split("/")))).toBe(true);
  });

  it("undo after a review merge removes the files the decision copied in", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const [x, y] = await bulk.listReview(p.id, h.batchId);
    await bulk.decideReview(p.id, y!.id, { action: "merge", sourceId: x!.sourceId! });
    expect((await repo.getSource(p.id, x!.sourceId!)).assets).toHaveLength(2);
    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.revertedMerges).toBe(1);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("an encrypted project: a merge snapshot is sealed and the merge is undone", async () => {
    const gov = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
captureMethods: [manual_upload]
processing:
  metadata_lookup: [crossref]
`;
    const p = await project(gov, true);
    crossrefPersist();
    const existing = await repo.createSource(p.id, plainDraft(WORK_TITLE, { identifiers: { doi: FIXTURE_DOI } }), [], { provenance: plainProvenance() });
    const { handle: h, result } = await run(p, folderAdapter(await folderWith("me", { "a.pdf": await workPdf("a") })));
    expect(result.counts.merged).toBe(1);
    const snaps = await readdir(join(lib.root, p.folder, "imports", "batch-0001", "snapshots"));
    expect(snaps.length).toBe(1);
    expect(snaps[0]).toMatch(/\.enc$/);
    expect(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "snapshots", snaps[0]!), "latin1")).not.toContain(WORK_TITLE);
    await bulk.undoBatch(p.id, h.batchId);
    expect((await repo.getSource(p.id, existing.source.id)).assets).toEqual([]);
  });
});

describe("review round 1: review queue and report (R61)", () => {
  it("decisions are journaled: the counts stay consistent with the review queue; viewing the report writes nothing", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const items = await bulk.listReview(p.id, h.batchId);
    await bulk.decideReview(p.id, items[0]!.id, { action: "keep-both" });
    await bulk.decideReview(p.id, items[1]!.id, { action: "skip" });
    const auditBefore = (await auditEvents(p)).length;
    const filesBefore = await tree(join(lib.root, p.folder, "imports"));
    const r = await bulk.batchReport(p.id, h.batchId);
    expect(r.counts.needsReview).toBe(r.pendingReview.length);
    expect(r.counts.needsReview).toBe(items.length - 2);
    expect((await auditEvents(p)).length).toBe(auditBefore);
    expect(await tree(join(lib.root, p.folder, "imports"))).toEqual(filesBefore);
    expect(repo.listSourceIds(p.id)).toContain(items[0]!.sourceId);
  });

  it("accept-candidate takes the candidate's fields", async () => {
    const p = await project();
    const sf = await repo.createSource(p.id, plainDraft("scan0001"), [], { provenance: plainProvenance() });
    const entry = await importChange(repo, p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, (ops) =>
      ops.appendReview({
        sourceId: sf.source.id,
        kind: "import",
        fields: {},
        reasons: ["low confidence"],
        candidates: [{ provider: "openalex", title: "The Candidate Title", creators: [{ role: "author", family: "Mensah" }], issued: "2018", type: "book", identifiers: { doi: "10.5555/cand" } }],
      }),
      { op: "test" },
    );
    await bulk.decideReview(p.id, entry.id, { action: "accept-candidate", index: 0 });
    const after = await repo.getSource(p.id, sf.source.id);
    expect(after.source.title.variants[0]!.value).toBe("The Candidate Title");
    expect(after.source.type).toBe("book");
    expect(after.source.identifiers.doi).toBe("10.5555/cand");
    await expect(bulk.decideReview(p.id, entry.id, { action: "skip" })).rejects.toThrow(/already been reviewed/);
  });

  it("decideReview refuses entries that are not import items", async () => {
    const p = await project();
    const sf = await repo.createSource(p.id, plainDraft("x"), [], { provenance: plainProvenance() });
    const entry = await importChange(repo, p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, (ops) =>
      ops.appendReview({ sourceId: sf.source.id, kind: "verification", fields: {}, reasons: ["r"] }),
      { op: "test" },
    );
    await expect(bulk.decideReview(p.id, entry.id, { action: "accept" })).rejects.toThrow(/not an import item/);
  });

  it("an encrypted project: a fuzzy match is found through the in-memory keys and goes to review", async () => {
    const p = await project(ENC_GOV, true);
    const existing = await repo.createSource(p.id, plainDraft("Feeding the Feed", { creators: [{ role: "author", family: "Okafor" }], issued: "2019" }), [], { provenance: plainProvenance() });
    const src = await folderWith("encfuzzy", { "Okafor - 2019 - Feeding the Feed.pdf": await readFile(fx.generated[1]!) });
    const { handle: h, result } = await run(p, folderAdapter(src));
    expect(result.counts.needsReview).toBe(1);
    expect((await bulk.listReview(p.id, h.batchId))[0]!.duplicateOf).toEqual({ sourceId: existing.source.id, reason: "fuzzy" });
  });
});

describe("review round 1: concurrency and resume (R61)", () => {
  it("two startBatch calls at once get distinct batch numbers", async () => {
    const p = await project();
    const [a, b] = await Promise.all([bulk.startBatch(p.id, folderAdapter(folder)), bulk.startBatch(p.id, folderAdapter(folder))]);
    await Promise.all([a.done, b.done]);
    const nums = (await bulk.listBatches(p.id)).map((x) => x.number).sort();
    expect(nums).toEqual([1, 2]);
  });

  it("two resumeBatch calls at once: the second is refused and no extra sources appear", async () => {
    const whole = await project();
    await run(whole, folderAdapter(folder));
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    for await (const e of h.progress) if (e.done >= 5) { h.cancel(); break; }
    await h.done;
    const results = await Promise.allSettled([bulk.resumeBatch(p.id, h.batchId), bulk.resumeBatch(p.id, h.batchId)]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const ok = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<BulkImport["resumeBatch"]>>>;
    await ok.value.done;
    expect(repo.listSourceIds(p.id)).toHaveLength(repo.listSourceIds(whole.id).length);
  });

  it("resume counts a source already carrying the batch id and item key as done (no second copy)", async () => {
    const p = await project();
    const adapter: ImportSourceAdapter = {
      kind: "csl-json",
      location: "synthetic",
      async *scan(): AsyncGenerator<ScanItem> {
        yield { key: "only", files: [], referenceMetadata: { type: "book", title: { variants: [{ lang: "en", kind: "original", value: "No identifiers at all" }] } } };
      },
    };
    const h = await bulk.startBatch(p.id, adapter);
    await h.done;
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    // Lose the journal line (as if the record of it never reached the disk).
    await writeFile(join(lib.root, p.folder, "imports", "batch-0001", "journal.jsonl"), "");
    const recPath = join(lib.root, p.folder, "imports", "batch-0001", "batch.json");
    await writeFile(recPath, JSON.stringify({ ...(JSON.parse(await readFile(recPath, "utf8")) as object), state: "running" }));
    await (await bulk.resumeBatch(p.id, h.batchId, adapter)).done;
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("a file dropped into the project during a paused batch is a duplicate when the batch goes on", async () => {
    const p = await project();
    const pdf = join(tmp, "drop.pdf");
    await copyFile(fx.generated[5]!, pdf);
    const src = await folderWith("during", { "a.pdf": await readFile(fx.generated[6]!), "b.pdf": await readFile(fx.generated[5]!) });
    const h = await bulk.startBatch(p.id, folderAdapter(src));
    h.pause();
    await new Promise((r) => setTimeout(r, 200));
    const { createAttach } = await import("../attach.js");
    const [dropped] = await createAttach({ repo, http }).attachFiles(p.id, [pdf]);
    expect(dropped!.sourceId).toBeDefined();
    h.resume();
    const r = await h.done;
    expect(r.counts.duplicates).toBe(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  });
});

describe("review round 1: ZIP and link preflight (R61)", () => {
  it("duplicate and case-colliding names in an archive fail only those items", async () => {
    const p = await project();
    const one = await buildPdf({ title: "One", lines: ["One"], extra: "1" });
    const two = await buildPdf({ title: "Two", lines: ["Two"], extra: "2" });
    const three = await buildPdf({ title: "Three", lines: ["Three"], extra: "3" });
    const src = await folderWith("dupzip", { "names.zip": buildZip([{ name: "a.pdf", data: one }, { name: "A.PDF", data: two }, { name: "b.pdf", data: three }]) });
    const { handle: h, result } = await run(p, folderAdapter(src));
    expect(result.counts.failed).toBe(1);
    expect(result.counts.created + result.counts.needsReview).toBe(2);
    expect((await bulk.batchReport(p.id, h.batchId)).failures).toEqual([{ item: "names.zip!/A.PDF", reason: "duplicate name in archive" }]);
  });

  it("an archive whose entry inflates past its declared size fails with the size reason", async () => {
    const { extractArchive } = await import("../../extract/zip.js");
    const zip = join(tmp, "bomb.zip");
    await writeFile(zip, buildZip([{ name: "x.bin", data: Buffer.alloc(200_000), declaredSize: 10 }]));
    await expect(extractArchive(zip, join(tmp, "out"), { maxEntries: 10, maxEntryBytes: 100_000, maxTotalBytes: 1_000_000 })).rejects.toThrow(/larger than|too large/);
  });

  it("link mode in a project without governance.yaml uses the default policy (no refusal unless it requires encryption)", async () => {
    const p = await project();
    await rm(join(lib.root, p.folder, "governance.yaml"));
    const { preflightLink } = await import("./run.js");
    const { DEFAULT_GOVERNANCE } = await import("@ao/core");
    const expectRefused = DEFAULT_GOVERNANCE.encryption.atRest === "required";
    await expect(preflightLink(repo, p.id)).resolves.toBe(expectRefused);
    await writeFile(join(lib.root, p.folder, "governance.yaml"), "encryption: [unparseable");
    await expect(preflightLink(repo, p.id)).resolves.toBe(true);
  });
});

describe("review round 2 (R63)", () => {
  it("I1: no path from the import root reaches source.json, the change log or anywhere outside the batch folder", async () => {
    const p = await project();
    const src = join(tmp, "Private");
    await mkdir(join(src, "Interviews", "Jane Doe"), { recursive: true });
    await writeFile(join(src, "Interviews", "Jane Doe", "Jane Doe consent.pdf"), await buildPdf({ title: "Consent form", author: "Research Office", lines: ["Consent form"] }));
    const { result } = await run(p, folderAdapter(src), { structure: "none" });
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
    expect(sf.source.provenance.externalKeys?.["import-item"]).toMatch(/^[0-9a-f]{64}$/);
    const hits: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.name.includes("Jane Doe")) hits.push(relative(lib.root, full));
        if (e.isDirectory()) {
          if (full === join(lib.root, p.folder, "imports")) continue; // the batch folder holds the journal (the record of the import)
          await walk(full);
        } else if ((await readFile(full)).includes("Jane Doe")) hits.push(relative(lib.root, full));
      }
    };
    await walk(lib.root);
    expect(hits).toEqual([]);
  });

  it("I2: undo and resume of the same batch at once: one is refused, the state is consistent", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    for await (const e of h.progress) if (e.done >= 5) { h.cancel(); break; }
    await h.done;
    const [u, r] = await Promise.allSettled([bulk.undoBatch(p.id, h.batchId), bulk.resumeBatch(p.id, h.batchId)]);
    expect([u.status, r.status].filter((x) => x === "rejected")).toHaveLength(1);
    if (r.status === "fulfilled") {
      await r.value.done;
      expect((await bulk.listBatches(p.id))[0]!.state).toBe("finished");
    } else {
      expect(repo.listSourceIds(p.id)).toEqual([]);
      expect((await bulk.listBatches(p.id))[0]!.state).toBe("undone");
    }
  });

  it("I2: two undos at once: one is refused", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const results = await Promise.allSettled([bulk.undoBatch(p.id, h.batchId), bulk.undoBatch(p.id, h.batchId)]);
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a parent kept because its batch-made child is in use says so", async () => {
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(folder));
    const cols = (await projectCollectionsAndTags(repo, p.id)).collections;
    const bundle = cols.find((c) => c.name === "Bundle")!;
    const sub = cols.find((c) => c.name === "Sub" && c.parentId === bundle.id)!;
    const own = await repo.createSource(p.id, plainDraft("Mine"), [], { provenance: plainProvenance() });
    await repo.setMembership(p.id, own.source.id, { collectionIds: [sub.id] });
    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "collection", id: sub.id }),
      { kind: "collection", id: bundle.id, reason: "contains a collection that is still in use; kept" },
    ]));
  });

  it("dedupe: a dead in-batch DOI placeholder falls back to the index", async () => {
    const p = await project();
    const real = await repo.createSource(p.id, plainDraft("With a DOI", { identifiers: { doi: "10.5555/dead.placeholder" } }), [], { provenance: plainProvenance() });
    const { BatchDedupe } = await import("./dedupe.js");
    const { hasSource } = await import("../../repo/repo.js");
    const d = new BatchDedupe(handle.db, p.id, (id) => hasSource(repo, p.id, id));
    d.addPending("pending:1", { sha256s: [], doi: "10.5555/dead.placeholder", isbns: ["9780262033848"] });
    d.dropPending(["pending:1"]);
    expect(d.candidates({ sha256s: [], doi: "10.5555/dead.placeholder" }).map((c) => c.sourceId)).toEqual([real.source.id]);
  });

  it("revertedMerges counts only merges where undo reverted something", async () => {
    const p = await project();
    const existing = await repo.createSource(p.id, plainDraft("Same work", { identifiers: { doi: "10.5555/full" } }), [], { provenance: plainProvenance() });
    const adapter: ImportSourceAdapter = {
      kind: "csl-json",
      location: "synthetic",
      async *scan(): AsyncGenerator<ScanItem> {
        yield { key: "one", files: [], referenceMetadata: { type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "Same work" }] }, identifiers: { doi: "10.5555/full" } } };
      },
    };
    const { handle: h, result } = await run(p, adapter);
    expect(result.counts.merged).toBe(1);
    const u = await bulk.undoBatch(p.id, h.batchId);
    expect(u.revertedMerges).toBe(0);
    expect((await repo.getSource(p.id, existing.source.id)).source.identifiers.doi).toBe("10.5555/full");
  });

  it("a review decision taken while the run is paused: one decision line, and the batch record's counts match the report", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    let decided = false;
    for await (const e of h.progress) {
      if (!decided && e.done >= 8) {
        h.pause();
        await new Promise((r) => setTimeout(r, 300));
        const [first] = await bulk.listReview(p.id, h.batchId);
        await bulk.decideReview(p.id, first!.id, { action: "skip" });
        decided = true;
        h.resume();
      }
    }
    await h.done;
    const lines = (await readFile(join(lib.root, p.folder, "imports", "batch-0001", "journal.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { key: string; decision?: string });
    expect(lines.filter((l) => l.decision)).toHaveLength(1);
    const rec = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8")) as { counts: { needsReview: number; skipped: number } };
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(rec.counts.needsReview).toBe(report.counts.needsReview);
    expect(rec.counts.skipped).toBe(report.counts.duplicates);
    expect(report.counts.needsReview).toBe(report.pendingReview.length);
  });
});

describe("review round 2 (R82): stores from attach and Bulk Import share the project's queue", () => {
  it("a batch holding a.pdf while attachFiles stores the same file: one source, one duplicate", async () => {
    const p = await project();
    const dir = join(tmp, "Race");
    await mkdir(dir, { recursive: true });
    const pdf = await buildPdf({ title: "Racing the Queue", author: "Ada Lovelace", extra: "race" });
    await writeFile(join(dir, "a.pdf"), pdf);
    await writeFile(join(dir, "dropped.pdf"), pdf);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let yielded!: () => void;
    const firstOut = new Promise<void>((r) => (yielded = r));
    const adapter: ImportSourceAdapter = {
      kind: "folder",
      location: dir,
      async *scan() {
        yield { key: "a.pdf", files: [{ path: join(dir, "a.pdf"), mime: "application/pdf", bytes: pdf.length }] };
        yielded();
        await held; // a.pdf is checked and queued in the batch's group, not stored yet
      },
    };
    const h = await bulk.startBatch(p.id, adapter);
    await firstOut;
    await new Promise((r) => setTimeout(r, 200));
    const [dropped] = await createAttach({ repo, http }).attachFiles(p.id, [join(dir, "dropped.pdf")]);
    expect(dropped!.outcome).toMatch(/created|needs-review/u);
    release();
    const r = await h.done;
    expect(r.counts).toMatchObject({ duplicates: 1, created: 0, needsReview: 0 });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  }, 30_000);
});

describe("Task 72 (R190): an import decision that puts a field newly in conflict queues it; the batch's undo takes it back", () => {
  const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

  /**
   * A batch with one item; its source carries a page's date (2014); the item's import entry offers a
   * candidate dated 2018. Accepting the candidate puts the date newly in conflict.
   */
  async function decidedIntoConflict(fields: Record<string, string> = {}) {
    const { projectReviewEntries } = await import("../../repo/repo.js");
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(await folderWith("r190", { "a.pdf": await workPdf("r190") })));
    const [sid] = repo.listSourceIds(p.id);
    const at = new Date().toISOString();
    await importChange(repo, p.id, STORE, async (ops) => {
      const cur = await ops.readSource(sid!);
      await ops.writeSource(cur, { ...cur, fieldEvidence: [...cur.fieldEvidence, { field: "/issued", value: "2014", source: { kind: "page-dom" }, at }] });
    }, { op: "test" });
    const entry = await importChange(repo, p.id, STORE, (ops) =>
      ops.appendReview({
        sourceId: sid!,
        kind: "import",
        batchId: h.batchId,
        fields,
        reasons: ["low confidence"],
        candidates: [{ provider: "openalex", title: WORK_TITLE, creators: [], issued: "2018", type: "article-journal", identifiers: {} }],
      }),
      { op: "test" },
    );
    await bulk.decideReview(p.id, entry.id, { action: "accept-candidate", index: 0 });
    expect((await repo.getSource(p.id, sid!)).verification["/issued"]?.status).toBe("conflict");
    const queued = (await projectReviewEntries(repo, p.id)).filter((e) => e.sourceId === sid && e.status === "pending" && e.kind === "verification");
    return { p, sid: sid!, batchId: h.batchId, queued, entries: async () => (await projectReviewEntries(repo, p.id)).filter((e) => e.sourceId === sid) };
  }

  it("the decision's own change queues the date, its cause a later check, and its audit event says so", async () => {
    const { p, queued } = await decidedIntoConflict();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ fields: { "/issued": "conflict" }, cause: { kind: "capture-conflict", foundBy: "later-check" } });
    const decide = (await auditEvents(p)).filter((e) => (e.details as { op?: string } | undefined)?.op === "review.decide");
    expect(decide).toHaveLength(1);
    expect(decide[0]!.details).toMatchObject({ reviewQueued: [{ entry: queued[0]!.id, fields: ["/issued"] }] });
  });

  it("R193 a (I1): the item's own import entry lists the field, as reviewFor writes it: the decision still queues the conflict", async () => {
    const { queued } = await decidedIntoConflict({ "/issued": "unverified" });
    expect(queued).toEqual([expect.objectContaining({ fields: { "/issued": "conflict" }, cause: { kind: "capture-conflict", foundBy: "later-check" } })]);
  });

  it("undoing the batch takes the entry back in the change that removes the source", async () => {
    const { p, batchId, queued, entries } = await decidedIntoConflict();
    expect(queued).toHaveLength(1);
    await bulk.undoBatch(p.id, batchId);
    expect(await entries()).toEqual(expect.arrayContaining([expect.objectContaining({ id: queued[0]!.id, status: "resolved", decision: "undone" })]));
    expect((await entries()).filter((e) => e.status === "pending")).toEqual([]);
  });

  it("an entry the researcher already settled is neither resurrected nor rewritten by the undo", async () => {
    const { confirmField } = await import("../../source-actions.js");
    const { p, sid, batchId, queued, entries } = await decidedIntoConflict();
    expect(queued).toHaveLength(1);
    await confirmField(repo, p.id, sid, "/issued", "2018");
    expect((await entries()).find((e) => e.id === queued[0]!.id)).toMatchObject({ status: "resolved", decision: "confirmed" });
    const linesBefore = (await readProjectFile(p, "review/pending.jsonl")).split("\n").filter((l) => l.includes(queued[0]!.id)).length;
    await bulk.undoBatch(p.id, batchId);
    expect((await entries()).find((e) => e.id === queued[0]!.id)).toMatchObject({ status: "resolved", decision: "confirmed" });
    expect((await readProjectFile(p, "review/pending.jsonl")).split("\n").filter((l) => l.includes(queued[0]!.id))).toHaveLength(linesBefore);
  });
});

describe("Task 72 fix round 2 (R194): every import decision that leaves the source in place keeps its conflicts listed", () => {
  /**
   * A batch, and an item of it as a run leaves one: its stored report has /issued in conflict (the
   * file says 2014, the platform 2018), listed only by its pending import entry (reviewFor's shape).
   * `conflict: false`: the same item with no conflict.
   */
  async function importedItem(o: { conflict?: boolean } = {}) {
    const { recheckSourceFile } = await import("@ao/core");
    const { projectReviewEntries } = await import("../../repo/repo.js");
    const p = await project();
    const { handle: h } = await run(p, folderAdapter(await folderWith("r194", { "a.pdf": await workPdf("r194") })));
    const at = new Date().toISOString();
    const evidence = [
      { field: "/issued", value: "2014", source: { kind: "page-dom" as const }, at },
      ...(o.conflict === false ? [] : [{ field: "/issued", value: "2018", source: { kind: "platform-json" as const }, at }]),
    ];
    const draft = plainDraft("An imported item", { issued: "2014" });
    const sf0 = { source: { ...draft, id: "x", provenance: plainProvenance() }, fieldEvidence: evidence, verification: {}, assets: [], annotations: [] };
    const verification = recheckSourceFile(sf0 as unknown as Parameters<typeof recheckSourceFile>[0], {}).verification;
    expect(verification["/issued"]?.status === "conflict").toBe(o.conflict !== false);
    const fields = Object.fromEntries(Object.entries(verification).filter(([, v]) => v.status === "conflict" || v.status === "unverified").map(([k, v]) => [k, v.status]));
    const sf = await repo.createSource(p.id, draft, [], {
      provenance: { ...plainProvenance(), importBatchId: h.batchId },
      fieldEvidence: evidence,
      verification,
      reviewItem: { kind: "import", batchId: h.batchId, fields, reasons: ["The file and the platform disagree."] },
    });
    const sid = sf.source.id;
    const entries = async () => (await projectReviewEntries(repo, p.id)).filter((e) => e.sourceId === sid);
    const importEntry = (await entries()).find((e) => e.kind === "import")!;
    return { p, sid, batchId: h.batchId, importEntry, entries, pending: async () => (await entries()).filter((e) => e.status === "pending") };
  }

  /** The source's pending entries are exactly one capture-conflict entry listing /issued as in conflict (the row needs review). */
  const expectListed = (pending: Array<{ kind: string; fields: Record<string, string>; cause?: unknown }>) =>
    expect(pending).toEqual([expect.objectContaining({ kind: "verification", fields: expect.objectContaining({ "/issued": "conflict" }), cause: { kind: "capture-conflict", foundBy: "later-check" } })]);

  it("a plain accept (no draft): the conflict gets its capture entry in the decision's change", async () => {
    const { p, sid, importEntry, pending } = await importedItem();
    await bulk.decideReview(p.id, importEntry.id, { action: "accept" });
    expect((await repo.getSource(p.id, sid)).verification["/issued"]?.status).toBe("conflict");
    expectListed(await pending());
    const decide = (await auditEvents(p)).filter((e) => (e.details as { op?: string } | undefined)?.op === "review.decide");
    expect(decide.at(-1)!.details).toMatchObject({ reviewQueued: [{ fields: ["/issued"] }] });
  });

  it("an accept whose draft leaves the report as it was: the same", async () => {
    const { p, sid, importEntry, pending } = await importedItem();
    // A draft that sets nothing (the reviewer's probe; the service passes the draft it is given).
    await bulk.decideReview(p.id, importEntry.id, { action: "accept", draft: {} as SourceDraft });
    expect((await repo.getSource(p.id, sid)).verification["/issued"]?.status).toBe("conflict");
    expectListed(await pending());
  });

  it("a merge whose target keeps a conflict with no entry: the target's conflict is listed", async () => {
    const { projectReviewEntries } = await import("../../repo/repo.js");
    const { recheckSourceFile } = await import("@ao/core");
    const { p, importEntry } = await importedItem({ conflict: false });
    const at = new Date().toISOString();
    const evidence = [
      { field: "/issued", value: "2010", source: { kind: "page-dom" as const }, at },
      { field: "/issued", value: "2016", source: { kind: "platform-json" as const }, at },
    ];
    const tdraft = plainDraft("The target", { issued: "2010" });
    const verification = recheckSourceFile({ source: { ...tdraft, id: "t", provenance: plainProvenance() }, fieldEvidence: evidence, verification: {}, assets: [], annotations: [] } as unknown as Parameters<typeof recheckSourceFile>[0], {}).verification;
    expect(verification["/issued"]?.status).toBe("conflict");
    // A target as D19 left it: the conflict stored, no entry.
    const target = await repo.createSource(p.id, tdraft, [], { provenance: plainProvenance(), fieldEvidence: evidence, verification });
    await bulk.decideReview(p.id, importEntry.id, { action: "merge", sourceId: target.source.id });
    expect((await repo.getSource(p.id, target.source.id)).verification["/issued"]?.status).toBe("conflict");
    expectListed((await projectReviewEntries(repo, p.id)).filter((e) => e.sourceId === target.source.id && e.status === "pending"));
  });

  it("a plain accept of an item with no conflict writes no entry and audits no reviewQueued", async () => {
    const { p, importEntry, pending } = await importedItem({ conflict: false });
    await bulk.decideReview(p.id, importEntry.id, { action: "accept" });
    expect(await pending()).toEqual([]);
    const decide = (await auditEvents(p)).filter((e) => (e.details as { op?: string } | undefined)?.op === "review.decide");
    expect(decide.at(-1)!.details).not.toHaveProperty("reviewQueued");
  });

  it("the batch's undo takes back the entry a plain accept wrote, crash-safe", async () => {
    const { SimulatedCrash, seams } = await import("../../repo/testing.js");
    const { p, sid, batchId, importEntry, entries, pending } = await importedItem();
    await bulk.decideReview(p.id, importEntry.id, { action: "accept" });
    const [capture] = await pending();
    expect(capture).toBeDefined();
    // A crash before the removal's commit point: the source and its entry are both still there.
    seams.crashAt = "before-audit";
    await expect(bulk.undoBatch(p.id, batchId)).rejects.toBeInstanceOf(SimulatedCrash);
    seams.crashAt = undefined;
    handle.close();
    await lib.close();
    lib = await openLibrary(join(tmp, "Lib"), deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    bulk = createBulkImport({ repo, http, index: handle });
    expect(repo.listSourceIds(p.id)).toContain(sid);
    expect((await pending()).map((e) => e.id)).toEqual([capture!.id]);
    await bulk.undoBatch(p.id, batchId);
    expect(repo.listSourceIds(p.id)).not.toContain(sid);
    expect((await entries()).find((e) => e.id === capture!.id)).toMatchObject({ status: "resolved", decision: "undone" });
  });
});

describe("context hooks and gone items (Z2)", () => {
  /** An incremental adapter that knows nothing of `skip`, `knownIds` or `gone`; it records the context it was given. */
  const plain = (items: ScanItem[], seen: Array<Record<string, unknown>> = []): ImportSourceAdapter => ({
    kind: "bibtex",
    location: "plain.bib",
    incremental: true,
    scan: async function* (_signal, ctx) {
      seen.push({ skip: typeof ctx?.skip, knownIds: ctx?.knownIds ? [...ctx.knownIds()] : undefined });
      yield* items;
    },
  });
  const ref = (key: string, title: string, version = "v1"): ScanItem => ({
    key,
    files: [],
    referenceMetadata: referenceMetadata({ type: "book", title }),
    version: { id: `lib/${key}`, version },
  });

  it("an adapter that knows nothing of skip and knownIds runs unchanged", async () => {
    const p = await project();
    const seen: Array<Record<string, unknown>> = [];
    const first = await run(p, plain([ref("A", "Alpha"), ref("B", "Beta")], seen));
    expect(first.result.state).toBe("finished");
    expect(first.result.counts.created + first.result.counts.needsReview).toBe(2);
    const again = await run(p, plain([ref("A", "Alpha"), ref("B", "Beta")], seen));
    expect(again.result.counts).toMatchObject({ unchanged: 2, created: 0, failed: 0 });
    // The engine offers the hooks; ignoring them changes nothing.
    expect(seen[0]).toEqual({ skip: "function", knownIds: [] });
    expect(seen[1]).toEqual({ skip: "function", knownIds: ["lib/A", "lib/B"] });
    // A non-incremental adapter is offered no knownIds.
    const nonInc: Array<Record<string, unknown>> = [];
    await run(p, { ...plain([], nonInc), incremental: false });
    expect(nonInc[0]).toEqual({ skip: "function", knownIds: undefined });
  });

  it("a gone item changes nothing here and is not journaled (Z5 marks it); a dry run does not count it", async () => {
    const p = await project();
    await run(p, plain([ref("A", "Alpha")]));
    const [id] = repo.listSourceIds(p.id);
    const folderOf = async () => join(lib.root, (await repo.getSource(p.id, id!)).source.folder);
    const before = await tree(await folderOf());
    expect(before.size).toBeGreaterThan(0);
    const { result, handle: h } = await run(p, plain([{ key: "A", files: [], gone: "deleted", version: { id: "lib/A", version: "deleted" } }]));
    expect(result.state).toBe("finished");
    expect(result.counts.items).toBe(0);
    expect(await tree(await folderOf())).toEqual(before);
    expect(existsSync(join(lib.root, p.folder, "imports", "batch-0002", "journal.jsonl"))).toBe(false);
    expect(h.batchId).toBeTruthy();
    const dry = await bulk.dryRun(p.id, plain([{ key: "B", files: [], gone: "bin", version: { id: "lib/B", version: "bin:3" } }]));
    expect(dry.items).toBe(0);
  });

  it("skip: an item already in a resumed batch's journal is passed by before the adapter fetches it", async () => {
    const p = await project();
    const asked: string[] = [];
    const items = [ref("A", "Alpha"), ref("B", "Beta"), ref("C", "Gamma")];
    const adapter: ImportSourceAdapter = {
      kind: "bibtex",
      location: "skip.bib",
      incremental: true,
      scan: async function* (_signal, ctx) {
        for (const i of items) {
          if (ctx?.skip?.(i.key)) continue;
          asked.push(i.key);
          yield i;
        }
      },
    };
    const h = await bulk.startBatch(p.id, adapter);
    for await (const e of h.progress) {
      if (e.done >= 1) {
        h.cancel();
        break;
      }
    }
    const stopped = await h.done;
    const done = stopped.counts.items;
    expect(done).toBeGreaterThanOrEqual(1);
    asked.length = 0;
    const r = await (await bulk.resumeBatch(p.id, h.batchId, adapter)).done;
    expect(r.state).toBe("finished");
    expect(asked).toHaveLength(3 - done);
    expect(repo.listSourceIds(p.id)).toHaveLength(3);
  });
});

describe("Zotero Web batches resumed (Z2)", () => {
  const ZGOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;
  const U = "user:42";
  let z: FakeZotero;
  let secrets: ReturnType<typeof useMemorySecrets>;
  let restoreDispatcher: () => void;
  // Guard (this part only: other tests here talk to a loopback media worker through the global dispatcher).
  let unguard: () => void;
  beforeAll(() => {
    unguard = guardNetwork();
  });
  afterAll(() => unguard());
  beforeEach(async () => {
    z = new FakeZotero();
    secrets = useMemorySecrets();
    await setSecret("zotero-api-key", z.key);
    // resumeZoteroWebImport takes no dispatcher (as in the service): the stand-in is the global one here.
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(z.agent);
    restoreDispatcher = () => setGlobalDispatcher(previous);
  });
  afterEach(async () => {
    // One way only: nothing but GET reached the stand-in.
    expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
    restoreDispatcher();
    secrets.restore();
    await z.agent.close();
  });

  const deps = () => ({ repo, http, index: handle });
  const web = (): ZoteroWebOptions => ({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
  const addWithFile = async (title: string) => {
    const p = z.addItem(U, { itemType: "journalArticle", title });
    const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: p, file: { bytes: await buildPdf({ extra: title }) } });
    return { p, att };
  };
  const listings = () => z.requests.filter((r) => r.path.startsWith("/users/42/items?")).map((r) => new URL(r.path, "https://x.invalid").searchParams);
  const fileRequests = () => z.requests.filter((r) => r.path.endsWith("/file")).map((r) => r.path);

  /** A first full run, then an incremental batch cancelled after its first item. */
  async function cancelledIncremental(after = 1): Promise<{ p: Project; batchId: string; v1: number; journaled: number }> {
    const p = await project(ZGOV);
    for (const t of ["One", "Two", "Three"]) await addWithFile(t);
    await (await startZoteroWebImport(deps(), p.id, web())).done;
    const v1 = z.libraryVersion(U);
    expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
    for (const t of ["Four", "Five", "Six", "Seven"]) await addWithFile(t);
    const h = await startZoteroWebImport(deps(), p.id, web());
    for await (const e of h.progress) {
      if (e.done >= after) {
        h.cancel();
        break;
      }
    }
    const stopped = await h.done;
    expect(stopped.state).toBe("cancelled");
    expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
    return { p, batchId: h.batchId, v1, journaled: stopped.counts.items };
  }

  const batchJson = (p: Project, n: number) => join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`, "batch.json");

  it("a resumed Web batch asks since its recorded version and records the new one", async () => {
    const { p, batchId, v1, journaled } = await cancelledIncremental();
    const rec = JSON.parse(await readFile(batchJson(p, 2), "utf8"));
    // The first part's read version is in the record as soon as that part's lines are (A5).
    expect(rec.adapterOptions).toEqual({ zoteroSince: v1, zoteroFiles: true, zoteroReadVersions: [z.libraryVersion(U)] });
    z.requests.length = 0;
    const r = await (await resumeZoteroWebImport(deps(), p.id, batchId)).done;
    expect(r.state).toBe("finished");
    expect(listings().length).toBeGreaterThan(0);
    expect(listings().every((q) => q.get("since") === String(v1))).toBe(true);
    // Items already journaled are passed by: their files are not fetched again.
    expect(fileRequests()).toHaveLength(4 - journaled);
    expect(repo.listSourceIds(p.id)).toHaveLength(7);
    const now = z.libraryVersion(U);
    expect(zoteroWebSince(repo, p.id, U)).toBe(now);
    expect(JSON.parse(await readFile(batchJson(p, 2), "utf8")).recordedLibraryVersion).toBe(now);
    const events = (await auditEvents(p)).map((e) => e.details?.op);
    expect(events).toContain("project.import-settings.zotero-web");
  });

  it("a batch record without the new fields resumes as before (a full scan) and records no version", async () => {
    const { p, batchId, v1 } = await cancelledIncremental();
    const path = batchJson(p, 2);
    const { adapterOptions: _gone, ...old } = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify(old, null, 2));
    z.requests.length = 0;
    const r = await (await resumeZoteroWebImport(deps(), p.id, batchId)).done;
    expect(r.state).toBe("finished");
    expect(listings().length).toBeGreaterThan(0);
    expect(listings().every((q) => !q.has("since"))).toBe(true);
    expect(repo.listSourceIds(p.id)).toHaveLength(7);
    const titles = await Promise.all(repo.listSourceIds(p.id).map(async (id) => (await repo.getSource(p.id, id)).source.title.variants[0]!.value));
    expect(new Set(titles).size).toBe(7);
    // The version the first part read at is not known: nothing is recorded, the next run repeats (A5).
    expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
  });

  it("a resumed batch records the LOWEST version any part read at; what changed in between comes in next run (C1)", async () => {
    const { p, batchId, journaled } = await cancelledIncremental(2);
    expect(journaled).toBeGreaterThanOrEqual(2);
    const read1 = JSON.parse(await readFile(batchJson(p, 2), "utf8")).adapterOptions.zoteroReadVersions;
    expect(read1).toEqual([z.libraryVersion(U)]);
    // Between the stop and the resume, in Zotero: one item the first part brought in is edited, another is binned.
    const journal = (await readFile(join(lib.root, p.folder, "imports", "batch-0002", "journal.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { key: string; sourceId?: string });
    const [edited, binned] = journal.filter((e) => e.sourceId).map((e) => e.key.replace(/^zotero:/u, ""));
    z.editItem(U, edited!, { title: "Edited in Zotero between the parts" });
    z.trash(U, binned!);
    const r = await (await resumeZoteroWebImport(deps(), p.id, batchId)).done;
    expect(r.state).toBe("finished");
    const rec = JSON.parse(await readFile(batchJson(p, 2), "utf8"));
    expect(rec.adapterOptions.zoteroReadVersions).toEqual([read1[0], z.libraryVersion(U)]);
    // Recorded: the first part's version, not the resumed part's.
    expect(zoteroWebSince(repo, p.id, U)).toBe(read1[0]);
    expect(rec.recordedLibraryVersion).toBe(read1[0]);
    expect(repo.listSourceIds(p.id)).toHaveLength(7);
    // The next incremental run asks since that version: the edit comes in, the binned item is yielded as gone.
    z.requests.length = 0;
    const next = await (await startZoteroWebImport(deps(), p.id, web())).done;
    expect(listings().every((q) => q.get("since") === String(read1[0]))).toBe(true);
    expect(next.counts).toMatchObject({ updated: 1, created: 0, failed: 0 });
    const titles = await Promise.all(repo.listSourceIds(p.id).map(async (id) => (await repo.getSource(p.id, id)).source.title.variants[0]!.value));
    expect(titles).toContain("Edited in Zotero between the parts");
    expect(new Set(titles).size).toBe(7);
    const a = zoteroWebAdapter({ libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {}, since: read1[0] });
    const work = join(tmp, "w-gone");
    await mkdir(work, { recursive: true });
    const gone: ScanItem[] = [];
    for await (const i of a.scan(new AbortController().signal, { workDir: async () => work, knownIds: () => new Set(journal.map((e) => `${U}/${e.key.replace(/^zotero:/u, "")}`)) })) if (i.gone) gone.push(i);
    expect(gone.map((i) => [i.key, i.gone])).toEqual([[`zotero:${binned}`, "bin"]]);
  });

  it("a batch record without the read versions records nothing", async () => {
    const { p, batchId, v1 } = await cancelledIncremental();
    const path = batchJson(p, 2);
    const rec = JSON.parse(await readFile(path, "utf8"));
    delete rec.adapterOptions.zoteroReadVersions;
    await writeFile(path, JSON.stringify(rec, null, 2));
    const r = await (await resumeZoteroWebImport(deps(), p.id, batchId)).done;
    expect(r.state).toBe("finished");
    expect(repo.listSourceIds(p.id)).toHaveLength(7);
    expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.adapterOptions.zoteroReadVersions).toBeUndefined();
    expect(after.recordedLibraryVersion).toBeUndefined();
  });

  it("a download that failed before the resume holds since back at the end of the resumed run", async () => {
    const p = await project(ZGOV);
    for (const t of ["One", "Two"]) await addWithFile(t);
    await (await startZoteroWebImport(deps(), p.id, web())).done;
    const v1 = z.libraryVersion(U);
    const { att } = await addWithFile("Fails first");
    z.failFile(U, att, { api: 500 });
    for (const t of ["Four", "Five"]) await addWithFile(t);
    const h = await startZoteroWebImport(deps(), p.id, { ...web(), maxRetries: 0 });
    // Hold the batch until the failing file's item is journaled, then stop it.
    for await (const e of h.progress) {
      if (e.done >= 3) {
        h.cancel();
        break;
      }
    }
    await h.done;
    z.failFile(U, att, null);
    const r = await (await resumeZoteroWebImport(deps(), p.id, h.batchId)).done;
    expect(r.state).toBe("finished");
    const journal = (await readFile(join(lib.root, p.folder, "imports", "batch-0002", "journal.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    // The failing item (third, newest first) was journaled before the stop; the resumed part had no failure of its own.
    expect(journal.some((e: { notes?: string[] }) => e.notes?.includes(ZOTERO_WEB_FILE_NOTES.failed))).toBe(true);
    expect(fileRequests().filter((f) => f.includes(att))).toHaveLength(1);
    expect(zoteroWebSince(repo, p.id, U)).toBe(v1);
  });

  it("the service-free resume of another kind is resumeBatch's", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    for await (const e of h.progress) {
      if (e.done >= 2) {
        h.cancel();
        break;
      }
    }
    await h.done;
    const r = await (await resumeZoteroWebImport(deps(), p.id, h.batchId)).done;
    expect(r.state).toBe("finished");
    expect(sum(r.counts)).toBe(fx.items);
  });
});
