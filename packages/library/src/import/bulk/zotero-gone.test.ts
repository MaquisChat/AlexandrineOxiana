/**
 * Task Z5: gone from Zotero, and back. An item deleted in Zotero, or moved to its bin, is MARKED on the source
 * it came from ("unavailable-on-platform" with `zotero`), and nothing else about the source changes: its files,
 * annotations (the researcher's highlights, notes, recolourings and deletions, R192, R195–R198), collections,
 * tags and fields stay byte for byte. Seen again as content, the source gets back the availability it had before
 * the mark. Undo puts the earlier availability back while it is still the one written, and resets the library's
 * remembered version (R206 4). Against the stand-in Zotero (Z1), through the real engine.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project, SourceFile } from "@ao/core";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { useMemorySecrets } from "../../secrets-testing.js";
import { setSecret } from "../../secrets.js";
import { startZoteroWebImport, zoteroWebSince, type ZoteroWebOptions } from "../zotero-web.js";
import { FakeZotero, guardNetwork } from "../../../tests/zotero/fake-zotero.js";
import { createBulkImport, type BatchResult } from "./index.js";
import type { ImportOptionsInput } from "@ao/core";

const FAST = 2 ** 10;
const U = "user:42";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let z: FakeZotero;
let zweb: ZoteroWebOptions;
let secrets: ReturnType<typeof useMemorySecrets>;

const deps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

let unguard: () => void;
beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(async () => {
  unguard();
  await shutdownExtractors();
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zgone-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Library"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  z = new FakeZotero();
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", z.key);
  zweb = { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} };
});
afterEach(async () => {
  // One way only: nothing but GET ever reached the stand-in.
  expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
  handle.close();
  await lib.close();
  ring.clear();
  await z.agent.close();
  secrets.restore();
  await rm(tmp, { recursive: true, force: true });
});

const bulkDeps = () => ({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: z.agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
const bulk = () => createBulkImport(bulkDeps());

async function project(o: { encrypted?: boolean } = {}): Promise<Project> {
  const name = `P${Math.random().toString(36).slice(2, 7)}`;
  return (await repo.createProject({ name, governanceYaml: GOV, encryption: o.encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } })).project;
}

async function run(p: Project, o: Partial<ZoteroWebOptions> = {}, options: ImportOptionsInput = {}): Promise<{ r: BatchResult; batchId: string }> {
  const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, ...o }, options);
  return { r: await h.done, batchId: h.batchId };
}

const pos = (page: number) => JSON.stringify({ pageIndex: page - 1, rects: [[10, 20, 110, 40]] });

/** An article with a stored PDF and two highlights on it. */
async function highlighted(title: string, ref = U, extra: Record<string, unknown> = {}) {
  const p = z.addItem(ref, { itemType: "journalArticle", title, tags: [{ tag: "markets" }], ...extra });
  const att = z.addItem(ref, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: p, file: { bytes: await buildPdf({ extra: title }) } });
  const h1 = z.addItem(ref, { itemType: "annotation", annotationType: "highlight", annotationText: "informal markets", annotationColor: "#ffd400", annotationPosition: pos(1) }, { parent: att });
  const h2 = z.addItem(ref, { itemType: "annotation", annotationType: "highlight", annotationText: "street traders", annotationColor: "#ff6666", annotationPosition: pos(1) }, { parent: att });
  return { p, att, h1, h2 };
}

const sources = async (p: Project): Promise<SourceFile[]> => Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
const sourceOf = async (p: Project, key: string) => (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === key)!;

/** Every file under a source's folder, by relative path, as bytes (hex). */
async function folderBytes(rel: string): Promise<Map<string, string>> {
  const dir = join(lib.root, rel);
  const out = new Map<string, string>();
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const b = await readFile(join(dir, name)).catch(() => null);
    if (b) out.set(name, b.toString("hex"));
  }
  return out;
}

/** The folder's files without source.json, and source.json parsed without its availability. */
async function allButAvailability(rel: string) {
  const files = await folderBytes(rel);
  const sj = JSON.parse(Buffer.from(files.get("source.json")!, "hex").toString("utf8")) as { source: Record<string, unknown> };
  files.delete("source.json");
  const { availability, ...rest } = sj.source;
  return { files, source: { ...sj, source: rest }, availability };
}

async function auditEvents(p: Project): Promise<AuditEvent[]> {
  const dir = join(lib.root, p.folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim().startsWith("{")) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}
const marks = async (p: Project) => (await auditEvents(p)).filter((e) => (e.details as { op?: string } | undefined)?.op === "import.zotero-mark");

const fileRequests = (att: string) => z.requests.filter((q) => q.path.endsWith(`/items/${att}/file`)).length;
const journal = async (p: Project, n: number) =>
  (await readFile(join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`, "journal.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

/** The researcher's own work on an imported source: a recolour, a note, a deletion, a highlight of their own, a collection and a tag. */
async function researcherWorks(p: Project, sf: SourceFile): Promise<void> {
  const [a1, a2] = [...sf.annotations].sort((x, y) => (x.quote ?? "").localeCompare(y.quote ?? ""));
  await repo.updateAnnotation(p.id, sf.source.id, a1!.id, { colorName: "blue", body: "my own note on it" });
  await repo.deleteAnnotation(p.id, sf.source.id, a2!.id);
  await repo.createAnnotation(p.id, sf.source.id, { kind: "highlight", assetId: sf.assets[0]!.id, anchors: [{ page: 1, rects: [{ x: 1, y: 2, w: 30, h: 4 }] }], quote: "mine", colorName: "green" });
  const c = await repo.createCollection(p.id, "Chapter 2");
  const t = await repo.createTag(p.id, "to reread");
  await repo.setMembership(p.id, sf.source.id, { collectionIds: [...sf.source.collectionIds, c.id], tagIds: [...sf.source.tagIds, t.id] });
}

describe("gone from Zotero, and back (Z5)", () => {
  it("a Zotero deletion marks a highlighted source and changes nothing else", async () => {
    const p = await project();
    const other = await project(); // the same library in another project: never touched by p's run
    const { p: key, att } = await highlighted("Informal markets in Lagos");
    await run(p);
    await run(other);
    await researcherWorks(p, await sourceOf(p, key));
    const sf = await sourceOf(p, key);
    const before = await allButAvailability(sf.source.folder);
    expect(before.availability).toEqual({ status: "available" });
    const otherSf = await sourceOf(other, key);
    const otherBefore = await folderBytes(otherSf.source.folder);

    z.remove(U, key);
    z.requests.length = 0;
    const t0 = Date.now();
    const { r, batchId } = await run(p);
    expect(r.state).toBe("finished");
    expect(r.counts).toMatchObject({ goneInZotero: 1, backInZotero: 0, failed: 0, items: 0 });
    expect(fileRequests(att)).toBe(0);

    const after = await allButAvailability(sf.source.folder);
    expect(after.files).toEqual(before.files); // annotations.json and the PDF, byte for byte
    expect(after.source).toEqual(before.source); // every field but the availability (modifiedAt included)
    expect(after.availability).toEqual({ status: "unavailable-on-platform", zotero: "deleted", firstNoticedAt: expect.any(String) });
    const noticed = Date.parse((after.availability as { firstNoticedAt: string }).firstNoticedAt);
    expect(noticed).toBeGreaterThanOrEqual(t0 - 1000);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    expect(await folderBytes(otherSf.source.folder)).toEqual(otherBefore);

    // One governed, audited change, whose audit entry says only what was marked.
    const [m] = await marks(p);
    expect(m).toBeDefined();
    expect(m!.details).toMatchObject({ op: "import.zotero-mark", marked: "deleted", txn: expect.any(String) });
    expect(JSON.stringify(m)).not.toMatch(/Informal markets|Lagos/u);
    expect(JSON.stringify(m)).not.toContain(key);

    const report = await bulk().batchReport(p.id, batchId);
    expect(report.counts).toMatchObject({ goneInZotero: 1, goneInZoteroBin: 0, backInZotero: 0 });
    expect(report.notes).toContain("1 item you have here was deleted in Zotero since the last sync; it was kept here and marked.");
    expect(report.notes.some((n) => /nothing was deleted here/u.test(n))).toBe(false);
    const md = await readFile(join(lib.root, p.folder, "imports", "batch-0002", "report.md"), "utf8");
    expect(md).toContain("- Marked as no longer in Zotero: 1");
    expect(md).not.toContain("- In the Zotero bin:");
  });

  it("restored from the Zotero bin, the mark goes and the earlier availability returns", async () => {
    const p = await project();
    const { p: key, att } = await highlighted("Street trading");
    await run(p);
    await researcherWorks(p, await sourceOf(p, key));
    const sf = await sourceOf(p, key);
    const original = await folderBytes(sf.source.folder);

    z.trash(U, key);
    const binned = await run(p);
    expect(binned.r.counts).toMatchObject({ goneInZotero: 1 });
    const inBin = await allButAvailability(sf.source.folder);
    expect(inBin.availability).toEqual({ status: "unavailable-on-platform", zotero: "bin", firstNoticedAt: expect.any(String) });
    const binReport = await readFile(join(lib.root, p.folder, "imports", "batch-0002", "report.md"), "utf8");
    expect(binReport).toContain("- In the Zotero bin: 1");
    expect(binReport).not.toContain("- Marked as no longer in Zotero:");

    z.restore(U, key);
    z.requests.length = 0;
    const back = await run(p);
    expect(back.r.counts).toMatchObject({ backInZotero: 1, goneInZotero: 0, failed: 0 });
    expect(fileRequests(att)).toBe(0); // the stored PDF is known: not downloaded again
    expect(await folderBytes(sf.source.folder)).toEqual(original); // byte for byte as before the mark
    expect((await marks(p)).map((e) => (e.details as { marked: string }).marked)).toEqual(["bin", "back"]);
    expect(await readFile(join(lib.root, p.folder, "imports", "batch-0003", "report.md"), "utf8")).toContain("- Back in Zotero: 1");
    // A quiet run afterwards changes nothing.
    await run(p);
    expect(await folderBytes(sf.source.folder)).toEqual(original);
  });

  it("back restores the availability it had before, whatever it was; the rest of its update follows the normal path", async () => {
    const p = await project();
    const { p: key, h1 } = await highlighted("Restored and revised");
    await run(p);
    await researcherWorks(p, await sourceOf(p, key));
    const id = (await sourceOf(p, key)).source.id;
    const earlier = { status: "incomplete" as const, reason: "Only part of it was saved." };
    await repo.updateSource(p.id, id, { availability: earlier });
    z.trash(U, key);
    await run(p);
    expect((await repo.getSource(p.id, id)).source.availability).toMatchObject({ zotero: "bin" });
    // Back, with its title changed in Zotero and a highlight the researcher recoloured here changed there too.
    z.restore(U, key);
    z.editItem(U, key, { title: "Restored and revised, second edition" });
    z.editItem(U, h1, { annotationText: "informal markets (Zotero's change)" });
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ backInZotero: 1, failed: 0 });
    const sf = await repo.getSource(p.id, id);
    expect(sf.source.availability).toEqual(earlier);
    expect(sf.source.title.variants[0]!.value).toBe("Restored and revised, second edition");
    // The researcher's work survives: the recolour and note, the deletion, their own highlight.
    const quotes = sf.annotations.map((a) => [a.quote, a.colorName ?? null, a.body ?? null]).sort();
    expect(quotes).toEqual([
      ["informal markets", "blue", "my own note on it"],
      ["mine", "green", null],
    ]);
  });

  it("a source that only merged the key is not marked", async () => {
    const p = await project();
    const a = z.addItem(U, { itemType: "journalArticle", title: "The first", DOI: "10.5555/ao.z5.merged" });
    const b = z.addItem(U, { itemType: "journalArticle", title: "Its twin", DOI: "10.5555/ao.z5.merged" });
    await run(p, {}, { duplicates: "merge" });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    const sf = (await sources(p))[0]!;
    const own = sf.source.provenance.externalKeys?.zoteroKey;
    const twin = own === a ? b : a;
    expect(sf.mergedExternalKeys?.zotero ?? []).toEqual([twin]);
    const before = await folderBytes(sf.source.folder);
    z.remove(U, twin);
    const { r, batchId } = await run(p, {}, { duplicates: "merge" });
    expect(r.counts).toMatchObject({ goneInZotero: 0, goneNotMarked: 1, failed: 0 });
    expect(await folderBytes(sf.source.folder)).toEqual(before);
    expect(await marks(p)).toEqual([]);
    const report = await bulk().batchReport(p.id, batchId);
    expect(report.notes.filter((n) => /deleted in Zotero/u.test(n))).toEqual([]);
  });

  it("a source from another library with the same key is not marked", async () => {
    const p = await project();
    z.addGroup(777, "Reading group");
    const G = "group:777";
    // The same item key in two libraries (Zotero keys are per library), with the same DOI: merged into one source.
    const fake = z as unknown as { nextKey: () => string };
    const real = fake.nextKey.bind(z);
    fake.nextKey = () => "SAMEKEY2";
    const g = z.addItem(G, { itemType: "journalArticle", title: "Shared reading", DOI: "10.5555/ao.z5.shared" });
    const u = z.addItem(U, { itemType: "journalArticle", title: "Shared reading", DOI: "10.5555/ao.z5.shared" });
    fake.nextKey = real;
    expect(g).toBe(u);
    await run(p, { libraryType: "group", libraryId: "777" });
    await run(p, {}, { duplicates: "merge" });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    const sf = (await sources(p))[0]!;
    expect(sf.source.provenance.externalKeys).toMatchObject({ zoteroKey: "SAMEKEY2", libraryId: G });
    const before = await folderBytes(sf.source.folder);
    z.remove(U, u);
    const { r } = await run(p, {}, { duplicates: "merge" });
    expect(r.counts).toMatchObject({ goneInZotero: 0, goneNotMarked: 1 });
    expect(await folderBytes(sf.source.folder)).toEqual(before);
    expect(await marks(p)).toEqual([]);
  });

  it("a source deleted here and remembered is not marked; it stays deleted", async () => {
    const p = await project();
    const { p: key } = await highlighted("Deleted here first");
    await run(p);
    await repo.deleteSource(p.id, (await sourceOf(p, key)).source.id);
    z.trash(U, key);
    const binned = await run(p);
    expect(binned.r.counts).toMatchObject({ goneInZotero: 0, goneNotMarked: 1, created: 0 });
    z.remove(U, key);
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ goneInZotero: 0, goneNotMarked: 1, created: 0 });
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(await marks(p)).toEqual([]);
  });

  it("already marked: no second change and the date kept", async () => {
    const p = await project();
    const { p: key } = await highlighted("Still in the bin");
    await run(p);
    z.trash(U, key);
    await run(p);
    const sf = await sourceOf(p, key);
    const marked = await folderBytes(sf.source.folder);
    const noticed = sf.source.availability.firstNoticedAt;
    // A full run sees it in the bin again.
    const { r } = await run(p, { full: true });
    expect(r.counts).toMatchObject({ goneInZotero: 1, failed: 0 });
    expect(await folderBytes(sf.source.folder)).toEqual(marked);
    expect((await sourceOf(p, key)).source.availability.firstNoticedAt).toBe(noticed);
    expect((await marks(p)).length).toBe(1);
    const line = (await journal(p, 3)).find((e) => e.key === `zotero:${key}`)!;
    expect(line).toMatchObject({ outcome: "zotero-gone", gone: "bin" });
    expect(line.merge).toBeUndefined();
  });

  it("bin then deleted updates the mark; undo of each puts back the one before", async () => {
    const p = await project();
    const { p: key } = await highlighted("Binned, then emptied");
    await run(p);
    const sf = await sourceOf(p, key);
    const original = await folderBytes(sf.source.folder);
    z.trash(U, key);
    const b2 = await run(p);
    const binMark = (await sourceOf(p, key)).source.availability;
    const binBytes = await folderBytes(sf.source.folder);
    await new Promise((r) => setTimeout(r, 15));
    z.remove(U, key);
    const b3 = await run(p);
    expect(b3.r.counts).toMatchObject({ goneInZotero: 1 });
    const deletedMark = (await sourceOf(p, key)).source.availability;
    expect(deletedMark).toEqual({ status: "unavailable-on-platform", zotero: "deleted", firstNoticedAt: expect.any(String) });
    expect(deletedMark.firstNoticedAt).not.toBe(binMark.firstNoticedAt);
    expect((await marks(p)).map((e) => (e.details as { marked: string }).marked)).toEqual(["bin", "deleted"]);
    await bulk().undoBatch(p.id, b3.batchId);
    expect(await folderBytes(sf.source.folder)).toEqual(binBytes);
    await bulk().undoBatch(p.id, b2.batchId);
    expect(await folderBytes(sf.source.folder)).toEqual(original);
  });

  it("undo of the batch removes the mark and resets since", async () => {
    const p = await project();
    const { p: key } = await highlighted("Undone mark");
    await run(p);
    await researcherWorks(p, await sourceOf(p, key));
    const sf = await sourceOf(p, key);
    const before = await folderBytes(sf.source.folder);
    z.remove(U, key);
    const { batchId } = await run(p);
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    expect((await sourceOf(p, key)).source.availability.zotero).toBe("deleted");
    const undone = await bulk().undoBatch(p.id, batchId);
    expect(undone.kept).toEqual([]);
    expect(await folderBytes(sf.source.folder)).toEqual(before);
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
    expect((await auditEvents(p)).some((e) => (e.details as { op?: string } | undefined)?.op === "project.import-settings.zotero-web.reset")).toBe(true);
    // The next run is a full one, and marks it again.
    z.requests.length = 0;
    await run(p);
    expect(z.requests.some((q) => q.path.startsWith("/users/42/items?") && new URL(q.path, "https://x").searchParams.has("since"))).toBe(false);
    expect((await sourceOf(p, key)).source.availability.zotero).toBe("deleted");
  });

  it("undo of the batch that brought it back puts the mark back, byte for byte", async () => {
    const p = await project();
    const { p: key } = await highlighted("Back, then undone");
    await run(p);
    const sf = await sourceOf(p, key);
    z.trash(U, key);
    await run(p);
    const marked = await folderBytes(sf.source.folder);
    z.restore(U, key);
    const back = await run(p);
    expect((await sourceOf(p, key)).source.availability).toEqual({ status: "available" });
    const res = await bulk().undoBatch(p.id, back.batchId);
    expect(res).toMatchObject({ kept: [], libraryVersionReset: true });
    expect(await folderBytes(sf.source.folder)).toEqual(marked);
  });

  it("undo after a later change leaves the later value and says so", async () => {
    const p = await project();
    const { p: key } = await highlighted("Back before the undo");
    await run(p);
    const id = (await sourceOf(p, key)).source.id;
    z.trash(U, key);
    const marked = await run(p);
    z.restore(U, key);
    await run(p); // back: the availability is the earlier one again
    expect((await repo.getSource(p.id, id)).source.availability).toEqual({ status: "available" });
    const res = await bulk().undoBatch(p.id, marked.batchId);
    expect(res.kept).toEqual([{ kind: "availability", id: "/availability", sourceId: id, reason: "its availability changed after the import; kept" }]);
    expect((await repo.getSource(p.id, id)).source.availability).toEqual({ status: "available" });
    // The researcher's own change after a mark is kept too.
    z.trash(U, key);
    const again = await run(p);
    const mine = { status: "incomplete" as const };
    await repo.updateSource(p.id, id, { availability: mine });
    const res2 = await bulk().undoBatch(p.id, again.batchId);
    expect(res2.kept.map((k) => k.kind)).toEqual(["availability"]);
    expect((await repo.getSource(p.id, id)).source.availability).toEqual(mine);
  });

  // The crash is armed from inside the mark's own governed change (when it makes its snapshot folder, the first new
  // folder of that change), and every later audit append fails, so the run cannot carry on in-process after it.
  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as const) {
    it(`a crash inside the mark's change rolls it back (${point}: source, journal and audit agree; the next run marks it)`, async () => {
      const { seams } = await import("../../repo/testing.js");
      const p = await project();
      const { p: key } = await highlighted("Crash while marking");
      await run(p);
      const sf = await sourceOf(p, key);
      const before = await folderBytes(sf.source.folder);
      z.remove(U, key);
      let fired = false;
      seams.beforeMkdir = async (abs) => {
        if (fired || !abs.endsWith("snapshots")) return;
        fired = true;
        seams.crashAt = point;
        seams.failAuditAppendFor = p.id;
      };
      try {
        await (await startZoteroWebImport(bulkDeps(), p.id, zweb)).done;
      } catch {
        // the process "died" at the crash point
      } finally {
        seams.beforeMkdir = undefined;
        seams.crashAt = undefined;
        seams.failAuditAppendFor = undefined;
      }
      expect(fired).toBe(true);
      handle.close();
      await lib.close();
      lib = await openLibrary(join(tmp, "Library"), deps());
      handle = new IndexHandle(lib.root);
      repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
      const now = (await repo.getSource(p.id, sf.source.id)).source.availability;
      const marked = now.zotero === "deleted";
      const lines = (await journal(p, 2).catch(() => [])).filter((e) => e.outcome === "zotero-gone" && e.merge?.availability);
      // All of it or none of it: the source, its journal line and its audit event.
      expect(lines).toHaveLength(marked ? 1 : 0);
      expect(await marks(p)).toHaveLength(marked ? 1 : 0);
      if (point !== "before-marker-delete") {
        expect(marked).toBe(false); // before the commit point: rolled back, byte for byte
        expect(await folderBytes(sf.source.folder)).toEqual(before);
      }
      // The next run (the version was not recorded by the run that died) marks it.
      await run(p);
      expect((await repo.getSource(p.id, sf.source.id)).source.availability.zotero).toBe("deleted");
      expect(await marks(p)).toHaveLength(1);
    });
  }

  it("an encrypted project's audit line holds no title, and nothing of the mark is in the clear", async () => {
    const p = await project({ encrypted: true });
    const { p: key } = await highlighted("Confidential fieldwork notes");
    await run(p);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    z.remove(U, key);
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ goneInZotero: 1, failed: 0 });
    expect((await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!)).source.availability.zotero).toBe("deleted");
    const [m] = await marks(p);
    expect(m!.details).toMatchObject({ marked: "deleted" });
    // No plain word of the mark anywhere in the project's files, and no byte of the title in what the mark wrote:
    // the audit log, the batch's journal, record and snapshot. (Folder names carry a short title in this project
    // by its own settings, as before this task: no file name is looked at here.)
    const hits: string[] = [];
    for (const name of await readdir(join(lib.root, p.folder), { recursive: true })) {
      const b = await readFile(join(lib.root, p.folder, name)).catch(() => null);
      if (!b) continue;
      if (b.includes("unavailable-on-platform") || b.includes(`"zotero":"deleted"`)) hits.push(name);
      if ((name.startsWith("audit") || name.startsWith("imports")) && (b.includes("Confidential fieldwork") || b.includes(key))) hits.push(name);
    }
    expect(hits).toEqual([]);
  });
});
