/**
 * Task Z6: changed on both sides, and new collections. A field Zotero changed that the researcher ALSO changed here,
 * to a different value, keeps the researcher's value; Zotero's value is recorded beside it as `zotero` evidence, the
 * field is marked in conflict, and one capture-conflict review entry asks the researcher (R190, R193 b, R194), settled
 * through the existing confirm (R191). The same Zotero value never asks twice; a later, different one asks again.
 * A collection an item newly belongs to in Zotero is added here; nothing is removed. Against the stand-in Zotero (Z1),
 * through the real engine.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { primary, type AuditEvent, type MultiText, type Project, type SourceFile } from "@ao/core";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import { projectCollectionsAndTags, projectReviewEntries, type Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { useMemorySecrets } from "../../secrets-testing.js";
import { setSecret } from "../../secrets.js";
import { confirmField } from "../../source-actions.js";
import { startZoteroWebImport, type ZoteroWebOptions } from "../zotero-web.js";
import { FakeZotero, guardNetwork } from "../../../tests/zotero/fake-zotero.js";
import { createBulkImport, type BatchResult } from "./index.js";

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
const REASON = "Zotero now has a different value; you changed it here.";

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
  tmp = await mkdtemp(join(tmpdir(), "ao-zconf-"));
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

async function run(p: Project, o: Partial<ZoteroWebOptions> = {}): Promise<{ r: BatchResult; batchId: string }> {
  const h = await startZoteroWebImport(bulkDeps(), p.id, { ...zweb, ...o });
  return { r: await h.done, batchId: h.batchId };
}

const mt = (value: string): MultiText => ({ variants: [{ lang: "en", kind: "original", value }] });
const titleOf = (sf: SourceFile) => primary(sf.source.title);
const sources = async (p: Project): Promise<SourceFile[]> => Promise.all(repo.listSourceIds(p.id).map((id) => repo.getSource(p.id, id)));
const sourceOf = async (p: Project, key: string) => (await sources(p)).find((s) => s.source.provenance.externalKeys?.zoteroKey === key)!;
/** Pending verification entries (the import's own "needs review" entries of new sources are another kind). */
const pending = async (p: Project, sourceId?: string) => (await projectReviewEntries(repo, p.id)).filter((e) => e.status === "pending" && e.kind === "verification" && (!sourceId || e.sourceId === sourceId));

async function auditEvents(p: Project): Promise<AuditEvent[]> {
  const dir = join(lib.root, p.folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim().startsWith("{")) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}
const opOf = (e: AuditEvent) => (e.details as { op?: string } | undefined)?.op;
const journal = async (p: Project, n: number) =>
  (await readFile(join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`, "journal.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
const reportMd = (p: Project, n: number) => readFile(join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`, "report.md"), "utf8");

/** source.json without the parts a conflict may change: the verification, the evidence and the modification time. */
async function allButConflict(p: Project, id: string) {
  const sf = await repo.getSource(p.id, id);
  const { verification: _v, fieldEvidence: _e, ...rest } = sf;
  const { modifiedAt: _m, ...source } = rest.source;
  return { ...rest, source };
}

/** R194: every field of the source in conflict is listed as in conflict in a pending capture entry, and every pending capture entry's conflict field is in conflict on the source. */
async function queueAgrees(p: Project, id: string): Promise<void> {
  const sf = await repo.getSource(p.id, id);
  const inConflict = Object.keys(sf.verification).filter((f) => sf.verification[f]!.status === "conflict").sort();
  const listed = (await pending(p, id))
    .flatMap((e) => Object.entries(e.fields).filter(([, s]) => s === "conflict").map(([f]) => f))
    .sort();
  expect(listed).toEqual(inConflict);
}

/** An article in Zotero, imported once; returns its key and source id. */
async function imported(p: Project, data: Record<string, unknown> = {}): Promise<{ key: string; id: string }> {
  const key = z.addItem(U, { itemType: "journalArticle", title: "Informal markets in Lagos", ...data });
  await run(p);
  return { key, id: (await sourceOf(p, key)).source.id };
}

describe("a field changed in Zotero and here (Z6)", () => {
  it("a title changed in Zotero and here becomes one review entry and keeps the researcher's title", async () => {
    const p = await project();
    const { key, id } = await imported(p);
    await repo.updateSource(p.id, id, { title: mt("Lagos markets, my reading") });
    const before = await allButConflict(p, id);
    z.editItem(U, key, { title: "Informal markets in Lagos, revised" });
    const { r, batchId } = await run(p);
    expect(r.state).toBe("finished");
    expect(r.counts).toMatchObject({ conflicts: 1, updated: 0, unchanged: 0, failed: 0, items: 1 });

    const sf = await repo.getSource(p.id, id);
    expect(titleOf(sf)).toBe("Lagos markets, my reading"); // the researcher's value stays
    expect(await allButConflict(p, id)).toEqual(before); // nothing else of the source changed
    expect(sf.verification["/title"]).toMatchObject({
      status: "conflict",
      reason: REASON,
      values: [{ value: "Informal markets in Lagos, revised", source: { kind: "zotero" } }],
      current: mt("Lagos markets, my reading"),
    });
    expect(sf.fieldEvidence.filter((e) => e.field === "/title" && e.source.kind === "zotero").map((e) => e.value)).toEqual(["Informal markets in Lagos", "Informal markets in Lagos, revised"]);

    // One review entry, of the capture-conflict kind, naming the field.
    const entries = await pending(p, id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "verification", fields: { "/title": "conflict" }, reasons: [REASON], cause: { kind: "capture-conflict", foundBy: "later-check" } });
    await queueAgrees(p, id);

    // The journal and the report count it; the audit names the entry and the field.
    const lines = (await journal(p, 2)).filter((e) => e.key === `zotero:${key}`);
    expect(lines.at(-1)).toMatchObject({ outcome: "zotero-conflict", conflictsQueued: 1, sourceId: id });
    const report = await bulk().batchReport(p.id, batchId);
    expect(report.counts).toMatchObject({ conflicts: 1, updated: 0 });
    expect(await reportMd(p, 2)).toContain("- Changed in Zotero and here — waiting for you: 1");
    const upd = (await auditEvents(p)).filter((e) => opOf(e) === "import.update");
    // One governed change (one txn), whose policy events (capture and store) each say what it queued.
    expect(new Set(upd.map((e) => (e.details as { txn: string }).txn)).size).toBe(1);
    expect(upd.map((e) => e.action).sort()).toEqual(["capture", "store"]);
    for (const e of upd) expect((e.details as Record<string, unknown>).reviewQueued).toEqual([{ entry: entries[0]!.id, fields: ["/title"] }]);
    // The batch record agrees with the report.
    const rec = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0002", "batch.json"), "utf8")) as { countsDetail?: Record<string, number> };
    expect(rec.countsDetail).toMatchObject({ conflicts: 1 });
  });

  it("an item with a conflict that also took in another field counts as updated as well", async () => {
    const p = await project();
    const { key, id } = await imported(p, { volume: "3" });
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    z.editItem(U, key, { title: "Zotero's title", volume: "4" });
    const { r, batchId } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 1, updated: 1 });
    const sf = await repo.getSource(p.id, id);
    expect(titleOf(sf)).toBe("My own title");
    expect(sf.source.volume).toBe("4"); // changed in Zotero only: it flows in
    expect((await journal(p, 2)).at(-1)).toMatchObject({ outcome: "updated", conflictsQueued: 1 });
    const md = await reportMd(p, 2);
    expect(md).toContain("- Updated from a newer version: 1");
    expect(md).toContain("- Changed in Zotero and here — waiting for you: 1");
    expect((await bulk().batchReport(p.id, batchId)).keptFields).toEqual([]);
  });

  it("no line about conflicts when there is none", async () => {
    const p = await project();
    const { key } = await imported(p);
    z.editItem(U, key, { title: "Changed in Zotero only" });
    await run(p);
    expect(await reportMd(p, 2)).not.toContain("waiting for you");
  });

  describe("the three cases, for each kind of field", () => {
    const zoteroCreators = (family: string) => [{ creatorType: "author", firstName: "Ada", lastName: family }];
    const kinds: Array<{
      label: string;
      path: string;
      zotero: Record<string, unknown>;
      zoteroNew: Record<string, unknown>;
      here: (sf: SourceFile) => Record<string, unknown>;
      read: (sf: SourceFile) => unknown;
    }> = [
      { label: "a title (text in several scripts)", path: "/title", zotero: { title: "First title" }, zoteroNew: { title: "Zotero's new title" }, here: () => ({ title: mt("My own title") }), read: (sf) => titleOf(sf) },
      { label: "a plain string (volume)", path: "/volume", zotero: { volume: "3" }, zoteroNew: { volume: "4" }, here: () => ({ volume: "12" }), read: (sf) => sf.source.volume },
      { label: "a date", path: "/issued", zotero: { date: "2019" }, zoteroNew: { date: "2020" }, here: () => ({ issued: "2001" }), read: (sf) => sf.source.issued },
      {
        label: "a list (creators)",
        path: "/creators",
        zotero: { creators: zoteroCreators("Okafor") },
        zoteroNew: { creators: zoteroCreators("Okafor-Bello") },
        here: (sf) => ({ creators: sf.source.creators.map((c) => ({ ...c, family: "Mine" })) }),
        read: (sf) => JSON.stringify(sf.source.creators),
      },
    ];
    for (const k of kinds) {
      it(`${k.label}: changed in Zotero only flows in; changed here only is kept and nothing is recorded; changed on both sides asks`, async () => {
        const p = await project();
        // (i) Zotero only.
        const a = await imported(p, { ...k.zotero, title: (k.zotero.title as string) ?? "Item A" });
        const aBefore = k.read(await repo.getSource(p.id, a.id));
        z.editItem(U, a.key, k.zoteroNew);
        await run(p);
        const aAfter = await repo.getSource(p.id, a.id);
        expect(k.read(aAfter)).not.toEqual(aBefore);
        expect(aAfter.verification[k.path]?.status).not.toBe("conflict");
        expect(await pending(p, a.id)).toEqual([]);

        // (ii) here only: kept, nothing recorded, nothing asked.
        const p2 = await project();
        const b = await imported(p2, { ...k.zotero, title: (k.zotero.title as string) ?? "Item B" });
        await repo.updateSource(p2.id, b.id, k.here(await repo.getSource(p2.id, b.id)) as never);
        const bMine = await repo.getSource(p2.id, b.id);
        z.editItem(U, b.key, { extra: "touched" }); // another change in Zotero, so the item is read again
        await run(p2);
        const bAfter = await repo.getSource(p2.id, b.id);
        expect(k.read(bAfter)).toEqual(k.read(bMine));
        expect(bAfter.fieldEvidence.filter((e) => e.field === k.path)).toEqual(bMine.fieldEvidence.filter((e) => e.field === k.path));
        expect(bAfter.verification[k.path]).toEqual(bMine.verification[k.path]);
        expect(await pending(p2, b.id)).toEqual([]);

        // (iii) both, to different values: kept here, Zotero's value recorded, one entry.
        const p3 = await project();
        const c = await imported(p3, { ...k.zotero, title: (k.zotero.title as string) ?? "Item C" });
        await repo.updateSource(p3.id, c.id, k.here(await repo.getSource(p3.id, c.id)) as never);
        const cMine = await repo.getSource(p3.id, c.id);
        z.editItem(U, c.key, k.zoteroNew);
        const { r } = await run(p3);
        expect(r.counts).toMatchObject({ conflicts: 1 });
        const cAfter = await repo.getSource(p3.id, c.id);
        expect(k.read(cAfter)).toEqual(k.read(cMine));
        expect(cAfter.verification[k.path]).toMatchObject({ status: "conflict", reason: REASON, values: [{ source: { kind: "zotero" } }] });
        expect(Object.keys((await pending(p3, c.id))[0]!.fields)).toEqual([k.path]);
        await queueAgrees(p3, c.id);
      });
    }

    it("changed on both sides to the SAME value is no conflict: Zotero's value is recorded as evidence and nothing is asked", async () => {
      const p = await project();
      const { key, id } = await imported(p, { volume: "3" });
      await repo.updateSource(p.id, id, { volume: "5" });
      z.editItem(U, key, { volume: "5" });
      const { r } = await run(p);
      expect(r.counts).toMatchObject({ conflicts: 0 });
      const sf = await repo.getSource(p.id, id);
      expect(sf.source.volume).toBe("5");
      expect(sf.verification["/volume"]?.status).not.toBe("conflict");
      expect(sf.fieldEvidence.filter((e) => e.field === "/volume" && e.source.kind === "zotero").map((e) => e.value)).toEqual(["3", "5"]);
      expect(await pending(p, id)).toEqual([]);
      // And from then on the field follows Zotero again.
      z.editItem(U, key, { volume: "6" });
      await run(p);
      expect((await repo.getSource(p.id, id)).source.volume).toBe("6");
    });

    it("a field the researcher cleared here that Zotero changed is kept empty and reported, not asked (an empty value cannot be confirmed)", async () => {
      const p = await project();
      const { key, id } = await imported(p, { volume: "3" });
      await repo.updateSource(p.id, id, { volume: undefined } as never);
      expect((await repo.getSource(p.id, id)).source.volume).toBeUndefined();
      z.editItem(U, key, { volume: "4" });
      const { r, batchId } = await run(p);
      expect(r.counts).toMatchObject({ conflicts: 0 });
      expect((await repo.getSource(p.id, id)).source.volume).toBeUndefined();
      expect(await pending(p, id)).toEqual([]);
      expect((await bulk().batchReport(p.id, batchId)).keptFields).toEqual([{ item: `zotero:${key}`, fields: ["/volume"] }]);
    });

    it("a field Zotero cleared that the researcher changed here is kept and reported, not asked", async () => {
      const p = await project();
      const { key, id } = await imported(p, { volume: "3" });
      await repo.updateSource(p.id, id, { volume: "12" });
      z.editItem(U, key, { volume: undefined });
      const { r, batchId } = await run(p);
      expect(r.counts).toMatchObject({ conflicts: 0 });
      expect((await repo.getSource(p.id, id)).source.volume).toBe("12");
      expect(await pending(p, id)).toEqual([]);
      expect((await bulk().batchReport(p.id, batchId)).keptFields).toEqual([{ item: `zotero:${key}`, fields: ["/volume"] }]);
    });
  });

  it("the same Zotero value does not queue again", async () => {
    const p = await project();
    const { key, id } = await imported(p, { volume: "3" });
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    z.editItem(U, key, { title: "Zotero's title" });
    await run(p);
    const [entry] = await pending(p, id);
    expect(entry).toBeDefined();
    const sf1 = await repo.getSource(p.id, id);
    const audits = (await auditEvents(p)).length;

    // A full run reads the item again at the same version: nothing is written at all, not even an audit event of the source.
    await run(p, { full: true });
    expect(await repo.getSource(p.id, id)).toEqual(sf1);
    const after = await auditEvents(p);
    expect(after.slice(audits).filter((e) => e.entity?.type === "source")).toEqual([]);
    expect((await journal(p, 3)).filter((e) => e.key === `zotero:${key}`).map((e) => e.outcome)).toEqual(["unchanged"]);

    // Zotero changes another field and keeps its title: the other field flows in, the title asks nothing more.
    z.editItem(U, key, { volume: "4" });
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 0, updated: 1 });
    const sf = await repo.getSource(p.id, id);
    expect(sf.source.volume).toBe("4");
    expect(sf.verification["/title"]).toEqual(sf1.verification["/title"]);
    expect((await pending(p, id)).map((e) => e.id)).toEqual([entry!.id]);
    expect((await projectReviewEntries(repo, p.id)).filter((e) => e.id === entry!.id)[0]!.fields).toEqual({ "/title": "conflict" });
    const upd = (await auditEvents(p)).filter((e) => opOf(e) === "import.update");
    expect((upd.at(-1)!.details as Record<string, unknown>).reviewQueued).toBeUndefined();
  });

  it("choosing Zotero's value lets the next change through", async () => {
    const p = await project();
    const { key, id } = await imported(p);
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    z.editItem(U, key, { title: "Zotero's title" });
    await run(p);
    const [entry] = await pending(p, id);
    await confirmField(repo, p.id, id, "/title", mt("Zotero's title"));
    const decided = (await projectReviewEntries(repo, p.id)).find((e) => e.id === entry!.id)!;
    expect(decided).toMatchObject({ status: "resolved", decision: "confirmed" });
    expect((await repo.getSource(p.id, id)).verification["/title"]?.status).toBe("user-confirmed");
    // Zotero changes it again: it flows in (the value here is the one Zotero gave last), and nothing is asked.
    z.editItem(U, key, { title: "Zotero's title, second edition" });
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 0, updated: 1 });
    expect(titleOf(await repo.getSource(p.id, id))).toBe("Zotero's title, second edition");
    expect(await pending(p, id)).toEqual([]);
  });

  it("a later different Zotero value asks again after a confirm", async () => {
    const p = await project();
    const { key, id } = await imported(p);
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    z.editItem(U, key, { title: "Zotero's title" });
    await run(p);
    const [first] = await pending(p, id);
    // The researcher keeps their own value: confirmed.
    await confirmField(repo, p.id, id, "/title", mt("My own title"));
    expect(await pending(p, id)).toEqual([]);
    expect((await repo.getSource(p.id, id)).verification["/title"]?.status).toBe("user-confirmed");
    // The same Zotero value again (another field changed): nothing asked.
    z.editItem(U, key, { volume: "9" });
    await run(p);
    expect(await pending(p, id)).toEqual([]);
    // A later, different value: asked again, even on a confirmed field; the researcher's value stays.
    z.editItem(U, key, { title: "Zotero's title, third try" });
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 1 });
    const sf = await repo.getSource(p.id, id);
    expect(titleOf(sf)).toBe("My own title");
    expect(sf.verification["/title"]).toMatchObject({ status: "conflict", values: [{ value: "Zotero's title, third try" }] });
    const again = await pending(p, id);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(first!.id);
    await queueAgrees(p, id);
  });

  it("the audit names fields, not values", async () => {
    const p = await project();
    const { key, id } = await imported(p, { title: "Kinship registers of Ibadan" });
    await repo.updateSource(p.id, id, { title: mt("Registers, my reading of Ibadan") });
    z.editItem(U, key, { title: "Zotero says Oyo kinship registers" });
    await run(p);
    const events = await auditEvents(p);
    const upd = events.filter((e) => opOf(e) === "import.update");
    expect(upd).toHaveLength(2); // one change: its capture and store events
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/Oyo|Ibadan|Registers, my reading/u);
    expect(JSON.stringify(upd)).not.toContain(REASON);
    expect(Object.keys(upd[0]!.details as object).sort()).toEqual(expect.arrayContaining(["op", "reviewQueued", "txn"]));
  });

  it("an encrypted project: Zotero's value and the review entry are sealed; the audit holds ids and field names only", async () => {
    const p = await project({ encrypted: true });
    const { key, id } = await imported(p, { title: "Sealed fieldwork diary" });
    await repo.updateSource(p.id, id, { title: mt("Diary, my own words") });
    z.editItem(U, key, { title: "Zotero value QUOKKA-unseen" });
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 1 });
    expect((await repo.getSource(p.id, id)).verification["/title"]?.status).toBe("conflict");
    expect(await pending(p, id)).toHaveLength(1);
    const hits: string[] = [];
    for (const name of await readdir(lib.root, { recursive: true })) {
      const b = await readFile(join(lib.root, name)).catch(() => null);
      if (!b) continue;
      if (b.includes("QUOKKA") || b.includes(REASON) || b.includes(`"status":"conflict"`)) hits.push(name);
    }
    expect(hits).toEqual([]);
    const upd = (await auditEvents(p)).filter((e) => opOf(e) === "import.update");
    expect((upd[0]!.details as { reviewQueued: unknown }).reviewQueued).toEqual([{ entry: expect.any(String), fields: ["/title"] }]);
  });

  it("the unchanged fast path reads nothing more (no source is read for an unchanged item without files)", async () => {
    const p = await project();
    const c = z.addCollection(U, "Fieldwork");
    for (const t of ["One", "Two", "Three"]) z.addItem(U, { itemType: "journalArticle", title: t, collections: [c] });
    await run(p);
    const real = repo.getSource.bind(repo);
    let reads = 0;
    (repo as { getSource: Repo["getSource"] }).getSource = (...a: Parameters<Repo["getSource"]>) => {
      reads++;
      return real(...a);
    };
    try {
      const { r } = await run(p, { full: true });
      expect(r.counts).toMatchObject({ unchanged: 3, updated: 0, conflicts: 0 });
    } finally {
      (repo as { getSource: Repo["getSource"] }).getSource = real;
    }
    expect(reads).toBe(0);
  });
});

describe("the researcher's value is never replaced (point 2)", () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? "an encrypted" : "a plain"} project: a first conflict, a resumed batch, a repeated one and an undo leave every source as it was, apart from its verification, evidence and modified time`, async () => {
      const p = await project({ encrypted });
      const keys = ["One", "Two", "Three"].map((t) => z.addItem(U, { itemType: "journalArticle", title: `Zotero ${t}`, volume: "1" }));
      await run(p);
      const ids = await Promise.all(keys.map(async (k) => (await sourceOf(p, k)).source.id));
      for (const [i, id] of ids.entries()) await repo.updateSource(p.id, id, { title: mt(`Mine ${i}`), volume: `${i + 10}` });
      const baseline = await Promise.all(ids.map((id) => allButConflict(p, id)));
      const same = async () => expect(await Promise.all(ids.map((id) => allButConflict(p, id)))).toEqual(baseline);
      for (const k of keys) z.editItem(U, k, { title: `Zotero changed ${k}`, volume: "2" });
      // A batch stopped after its first item, then resumed (as the service resumes a Web batch).
      const { getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(z.agent);
      try {
        const h = await startZoteroWebImport(bulkDeps(), p.id, zweb);
        for await (const e of h.progress) {
          if (e.done >= 1) {
            h.cancel();
            break;
          }
        }
        await h.done;
        await same();
        const { resumeZoteroWebImport } = await import("../zotero-web.js");
        const r = await (await resumeZoteroWebImport(bulkDeps(), p.id, h.batchId)).done;
        expect(r.state).toBe("finished");
        expect(r.counts).toMatchObject({ conflicts: 3, updated: 0 });
      } finally {
        setGlobalDispatcher(previous);
      }
      await same();
      for (const id of ids) await queueAgrees(p, id);
      expect(await pending(p)).toHaveLength(3);
      // A repeated conflict: Zotero changes again, to other values.
      for (const k of keys) z.editItem(U, k, { title: `Zotero again ${k}`, volume: "3" });
      const again = await run(p);
      expect(again.r.counts).toMatchObject({ conflicts: 3 });
      await same();
      for (const id of ids) await queueAgrees(p, id);
      // Undone: the conflict marks come off, the researcher's values stay.
      await bulk().undoBatch(p.id, again.batchId);
      await same();
      for (const id of ids) await queueAgrees(p, id);
    });
  }
});

describe("undo of a batch that queued a conflict (R177 c)", () => {
  it("undo resolves the entry as undone and keeps the researcher's value; the next sync asks again", async () => {
    const p = await project();
    const { key, id } = await imported(p);
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    const mine = await repo.getSource(p.id, id);
    z.editItem(U, key, { title: "Zotero's title" });
    const { batchId } = await run(p);
    const [entry] = await pending(p, id);
    const res = await bulk().undoBatch(p.id, batchId);
    expect(res.kept).toEqual([]);
    expect(res.reverted).toMatchObject({ merged: 0, updated: 0, conflicts: 1 });
    const sf = await repo.getSource(p.id, id);
    expect(titleOf(sf)).toBe("My own title");
    expect(sf.verification).toEqual(mine.verification); // the conflict mark is off
    expect(sf.fieldEvidence).toEqual(mine.fieldEvidence); // and Zotero's value with it
    expect(sf.source).toEqual(mine.source);
    expect((await projectReviewEntries(repo, p.id)).find((e) => e.id === entry!.id)).toMatchObject({ status: "resolved", decision: "undone" });
    await queueAgrees(p, id);
    // The undo reset the remembered version: the next sync (full) asks again.
    const { r } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 1 });
    expect(await pending(p, id)).toHaveLength(1);
    await queueAgrees(p, id);
  });

  it("undo after the researcher decided keeps the decision and says so", async () => {
    const p = await project();
    const { key, id } = await imported(p);
    await repo.updateSource(p.id, id, { title: mt("My own title") });
    z.editItem(U, key, { title: "Zotero's title" });
    const { batchId } = await run(p);
    const [entry] = await pending(p, id);
    await confirmField(repo, p.id, id, "/title", mt("Zotero's title"));
    const decided = await repo.getSource(p.id, id);
    const res = await bulk().undoBatch(p.id, batchId);
    expect(res.kept).toEqual([{ kind: "field", id: "/title", sourceId: id, reason: "you decided on Zotero's value after this import; your decision was kept" }]);
    expect(res.reverted.conflicts ?? 0).toBe(0);
    const sf = await repo.getSource(p.id, id);
    expect(titleOf(sf)).toBe("Zotero's title");
    expect(sf.verification["/title"]).toEqual(decided.verification["/title"]);
    expect(sf.fieldEvidence).toEqual(decided.fieldEvidence);
    expect((await projectReviewEntries(repo, p.id)).find((e) => e.id === entry!.id)).toMatchObject({ status: "resolved", decision: "confirmed" });
    await queueAgrees(p, id);
  });
});

describe("a crash between the source's change and the queue's entry (R194)", () => {
  // The crash is armed from inside the conflict's own governed change (when it makes its snapshot folder). Before the
  // commit point every later audit append fails too, so the run cannot carry on in-process after it; at
  // before-marker-delete the change's audit events are already written (it is committed) and the marker is left
  // behind, as when the process dies there.
  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as const) {
    it(`a crash inside the conflict's change (${point}): the source, the entry, the journal and the audit agree; the next run or the next open lists it`, async () => {
      const { seams } = await import("../../repo/testing.js");
      const commits = point === "before-marker-delete";
      const p = await project();
      const { key, id } = await imported(p);
      await repo.updateSource(p.id, id, { title: mt("My own title") });
      z.editItem(U, key, { title: "Zotero's title" });
      let fired = false;
      seams.beforeMkdir = async (abs) => {
        if (fired || !abs.endsWith("snapshots")) return;
        fired = true;
        seams.crashAt = point;
        if (!commits) seams.failAuditAppendFor = p.id;
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
      // The next open: all of it or none of it.
      const sf = await repo.getSource(p.id, id);
      const conflicted = sf.verification["/title"]?.status === "conflict";
      await queueAgrees(p, id);
      const lines = (await journal(p, 2).catch(() => [])).filter((e) => e.conflictsQueued);
      expect(lines).toHaveLength(conflicted ? 1 : 0);
      expect((await auditEvents(p)).filter((e) => opOf(e) === "import.update")).toHaveLength(conflicted ? 2 : 0); // capture and store, one txn
      expect(conflicted).toBe(commits); // before the commit point: rolled back; after it: kept whole
      expect(titleOf(sf)).toBe("My own title");
      // The next run lists it (raised again when it was rolled back; nothing more when it was committed).
      await run(p);
      const after = await repo.getSource(p.id, id);
      expect(after.verification["/title"]?.status).toBe("conflict");
      expect(titleOf(after)).toBe("My own title");
      expect(await pending(p, id)).toHaveLength(1);
      await queueAgrees(p, id);
    });
  }
});

describe("highlights changed on both sides (Accept 5)", () => {
  it("a highlight changed on both sides keeps the researcher's and is counted, not queued; one deleted here stays deleted", async () => {
    const p = await project();
    const item = z.addItem(U, { itemType: "journalArticle", title: "Annotated" });
    const att = z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: item, file: { bytes: await buildPdf({ extra: "Annotated" }) } });
    const pos = JSON.stringify({ pageIndex: 0, rects: [[10, 20, 110, 40]] });
    const h1 = z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "informal markets", annotationColor: "#ffd400", annotationPosition: pos }, { parent: att });
    const h2 = z.addItem(U, { itemType: "annotation", annotationType: "highlight", annotationText: "street traders", annotationColor: "#ff6666", annotationPosition: pos }, { parent: att });
    await run(p);
    const sf = await sourceOf(p, item);
    const a1 = sf.annotations.find((a) => a.quote === "informal markets")!;
    const a2 = sf.annotations.find((a) => a.quote === "street traders")!;
    await repo.updateAnnotation(p.id, sf.source.id, a1.id, { colorName: "blue", body: "my note" });
    await repo.deleteAnnotation(p.id, sf.source.id, a2.id);
    z.editItem(U, h1, { annotationText: "informal markets (Zotero's)" });
    z.editItem(U, h2, { annotationText: "street traders (Zotero's)" });
    const { r, batchId } = await run(p);
    expect(r.counts).toMatchObject({ conflicts: 0 });
    const after = await repo.getSource(p.id, sf.source.id);
    expect(after.annotations.map((a) => [a.quote, a.colorName ?? null, a.body ?? null])).toEqual([["informal markets", "blue", "my note"]]);
    expect(await pending(p, sf.source.id)).toEqual([]);
    expect((await bulk().batchReport(p.id, batchId)).keptFields).toEqual([{ item: `zotero:${item}`, fields: ["highlight on page 1 (changed here, kept)"] }]);
  });
});

describe("collections (Accept 4)", () => {
  const rename = (ref: string, key: string, name: string) => {
    const l = (z as unknown as { lib(r: string): { version: number; collections: Map<string, { version: number; data: Record<string, unknown> }> } }).lib(ref);
    const c = l.collections.get(key)!;
    const v = ++l.version;
    c.version = v;
    c.data = { ...c.data, name, version: v };
  };
  const names = async (p: Project, sf: SourceFile) => {
    const { collections } = await projectCollectionsAndTags(repo, p.id);
    const path = (id: string): string => {
      const c = collections.find((x) => x.id === id)!;
      return c.parentId ? `${path(c.parentId)}/${c.name}` : c.name;
    };
    return sf.source.collectionIds.map(path).sort();
  };

  it("a membership the researcher removed is not put back", async () => {
    const p = await project();
    const a = z.addCollection(U, "Fieldwork");
    const key = z.addItem(U, { itemType: "journalArticle", title: "Kept out", collections: [a] });
    await run(p);
    const sf = await sourceOf(p, key);
    expect(await names(p, sf)).toEqual(["Fieldwork"]);
    await repo.setMembership(p.id, sf.source.id, { collectionIds: [] });
    const b = z.addCollection(U, "Theory");
    z.editItem(U, key, { collections: [a, b] });
    await run(p);
    expect(await names(p, await repo.getSource(p.id, sf.source.id))).toEqual(["Theory"]);
  });

  it("a renamed collection arrives as new and is counted; the old one is kept", async () => {
    const p = await project();
    const a = z.addCollection(U, "Fieldwork");
    const k1 = z.addItem(U, { itemType: "journalArticle", title: "First", collections: [a] });
    const k2 = z.addItem(U, { itemType: "journalArticle", title: "Second", collections: [a] });
    await run(p);
    rename(U, a, "Fieldwork 2024");
    // Renaming a collection does not change its items' versions: a full run reads them again.
    const { r, batchId } = await run(p, { full: true });
    expect(r.counts).toMatchObject({ collectionsRenamed: 1, updated: 2 });
    for (const k of [k1, k2]) expect(await names(p, await sourceOf(p, k))).toEqual(["Fieldwork", "Fieldwork 2024"]);
    const { collections } = await projectCollectionsAndTags(repo, p.id);
    expect(collections.map((c) => c.name).sort()).toEqual(["Fieldwork", "Fieldwork 2024"]);
    expect((await bulk().batchReport(p.id, batchId)).counts).toMatchObject({ collectionsRenamed: 1 });
    expect(await reportMd(p, 2)).toContain("- Collections renamed in Zotero arrive under their new name; the old one is kept here: 1");
    // The audit holds no collection name.
    expect(JSON.stringify(await auditEvents(p))).not.toContain("Fieldwork");
    // A quiet full run afterwards changes nothing.
    const quiet = await run(p, { full: true });
    expect(quiet.r.counts).toMatchObject({ unchanged: 2, updated: 0, collectionsRenamed: 0 });
  });

  it("a new sub-collection under a parent the researcher renamed here arrives under a new parent of Zotero's name; the renamed one is kept", async () => {
    const p = await project();
    const a = z.addCollection(U, "Fieldwork");
    const key = z.addItem(U, { itemType: "journalArticle", title: "Nested", collections: [a] });
    await run(p);
    const { collections } = await projectCollectionsAndTags(repo, p.id);
    await repo.updateCollection(p.id, collections[0]!.id, { name: "Field notes" });
    const sub = z.addCollection(U, "Interviews", a);
    z.editItem(U, key, { collections: [a, sub] });
    await run(p);
    expect(await names(p, await sourceOf(p, key))).toEqual(["Field notes", "Fieldwork/Interviews"]);
  });
});
