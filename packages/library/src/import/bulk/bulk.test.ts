import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project, SourceDraft } from "@ao/core";
import { FIXTURE_DOI, buildCameraTiff, buildImportFolder, buildPdf, buildZip, type ImportFolderFixture } from "../../../../../tests/fixtures/generate.mjs";
import { LOCATION_REASON } from "../attach.js";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import { decryptBytes } from "../../repo/io.js";
import type { Repo } from "../../repo/repo.js";
import { projectDataKey } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { BatchRefusedError, createBulkImport, folderAdapter, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";

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
    expect(await repo.getSource(p.id, existing.source.id)).toEqual(before);
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
      await tx.mkdir(`${p.folder}/${profileDir}`);
      await tx.writeFile(
        `${p.folder}/${profileDir}/profile.json`,
        JSON.stringify({ platform: "instagram", handle: "someone", knownPostIds: ["P0", "PA", "PB"], knownPosts: { P0: { listing: "posts" }, PA: { listing: "posts" }, PB: { listing: "posts" } } }),
      );
      await tx.writeFile(`${p.folder}/${profileDir}/archive.txt`, "instagram P0\ninstagram PA\ninstagram PB\n");
    });
    const u = await bulk.undoBatch(p.id, batchId);
    expect(u.removedSources).toBe(2);
    expect(repo.listSourceIds(p.id)).toEqual([keep.source.id]);
    const profile = JSON.parse(await readProjectFile(p, `${profileDir}/profile.json`)) as { knownPostIds: string[]; knownPosts: Record<string, unknown> };
    expect(profile.knownPostIds).toEqual(["P0"]);
    expect(Object.keys(profile.knownPosts)).toEqual(["P0"]);
    expect(await readProjectFile(p, `${profileDir}/archive.txt`)).toBe("instagram P0\n");
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

describe("location rule (R56)", () => {
  it("a photo with GPS in a project that must coarsen location fails with LOCATION_REASON; the batch goes on", async () => {
    const gov = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
sharing:
  locationMetadata: coarsen
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
    const p = await project(gov, true);
    const src = join(tmp, "photos");
    await mkdir(src);
    await buildCameraTiff(join(src, "IMG_0001.tif"));
    await copyFile(fx.generated[3]!, join(src, "paper.pdf"));
    const { handle: h, result } = await run(p, folderAdapter(src));
    expect(result.counts.failed).toBe(1);
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures).toEqual([{ item: "IMG_0001.tif", reason: LOCATION_REASON }]);
    expect(report.governance.some((g) => g.result === "deny" && g.reason === LOCATION_REASON && g.items === 1)).toBe(true);
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

