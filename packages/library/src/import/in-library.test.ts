/**
 * R362 c (defect D27; R310 h): nothing inside the open library's own folder is attached or imported. The attach (the
 * service's attach route, drag and drop) and the folder import (dry run, start, resume; the service's routes and the
 * command line go through these) refuse, by real path, a file inside the library and a folder inside it or holding it,
 * before anything is read or written. A found file waiting in `find/held/` comes in only through "Use this file".
 */
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { newId, type Project } from "@ao/core";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import { appendFindEntries } from "../find/queue-store.js";
import type { FindEntry } from "../find/types.js";
import { IndexHandle } from "../index/db.js";
import { HttpClient } from "../lookup/index.js";
import { holdMismatchedFile, readReviewEntries, type HeldFileFacts } from "../repo/review.js";
import type { RepoCore } from "../repo/state.js";
import { insideFolder } from "../fs/inside-library.js";
import { createAttach } from "./attach.js";
import { BatchRefusedError, createBulkImport, folderAdapter, type BulkImport } from "./bulk/index.js";

const GOV = `${OPEN_GOV}processing:
  metadata_lookup: []
`;
const NOW = "2026-11-10T09:30:00.000Z";

let kit: Kit;
let agent: MockAgent;
let http: HttpClient;
let handle: IndexHandle;
let bulk: BulkImport;

beforeEach(async () => {
  kit = await makeKit("ao-in-library-");
  agent = new MockAgent();
  agent.disableNetConnect();
  http = new HttpClient({ libraryRoot: kit.lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  handle = new IndexHandle(kit.lib.root);
  bulk = createBulkImport({ repo: kit.repo, http, index: handle });
});
afterEach(async () => {
  handle.close();
  await agent.close();
  await kit.close();
});

const coreOf = () => (kit.repo as unknown as { core: RepoCore }).core;
const attach = () => createAttach({ repo: kit.repo, http });
const facts = (): HeldFileFacts => ({
  why: "other-doi",
  kind: "pdf",
  bytes: 1234,
  fileDoi: "10.5555/ao.d27.other",
  embeddedTitle: "A Different Paper Entirely",
  textStart: "A Different Paper Entirely. Abstract.",
  acquired: { method: "free_copy", via: "service", service: "arxiv", address: "https://arxiv.org/pdf/2101.00001", at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "public" },
});

interface World {
  p: Project;
  sourceId: string;
  /** The held file's absolute path (under the project's `find/held/`). */
  held: string;
  reviewId: string;
}

/** A project with a source whose found file waits in `find/held/` for the researcher's check. */
async function world(): Promise<World> {
  const p = await makeProject(kit, GOV);
  const sf = await addSource(kit, p, { title: "Rivers and Memory in Upland Villages" });
  const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Okafor, Rivers", state: "fetching", createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id };
  await appendFindEntries(coreOf(), p.id, [entry], "add");
  const pdf = await scratchFile(kit, "found.pdf", await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
  const r = await holdMismatchedFile(coreOf(), p.id, { entry: { ...entry, state: "needs-check", reason: { code: "file-other-doi" } }, sourceId: sf.source.id, fromPath: pdf, facts: facts() });
  return { p, sourceId: sf.source.id, held: join(kit.lib.root, kit.repo.getProject(p.id).folder, r.held), reviewId: r.reviewId };
}

/** Everything a refusal must leave as it was: the source, the held file, the review entry and the audit log. */
async function snapshot(w: World) {
  const sf = await kit.repo.getSource(w.p.id, w.sourceId);
  const pending = (await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending").map((e) => e.id);
  return { source: JSON.stringify(sf.source), assets: JSON.stringify(sf.assets), held: (await readFile(w.held)).toString("base64"), pending, audit: (await auditEvents(kit, w.p)).length };
}

const outsidePdf = async (name = "mine.pdf") => scratchFile(kit, name, await buildPdf({ title: `Outside ${name}`, lines: [`Outside ${name}`] }));

describe("attach refuses a file inside the library's own folder (R362 c)", () => {
  it("a found file waiting in find/held/ dropped on its source: refused, nothing changed", async () => {
    const w = await world();
    const before = await snapshot(w);
    const out = await attach().attachFiles(w.p.id, [w.held], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: w.held, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
    expect(await snapshot(w)).toEqual(before);
    expect(before.pending).toEqual([w.reviewId]);
  });

  it("dropped on the library (a new source): refused, no source made", async () => {
    const w = await world();
    const ids = kit.repo.listSourceIds(w.p.id);
    const out = await attach().attachFiles(w.p.id, [w.held]);
    expect(out).toEqual([{ path: w.held, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
    expect(kit.repo.listSourceIds(w.p.id)).toEqual(ids);
  });

  it("a file of another source of the same library", async () => {
    const w = await world();
    const other = await addSource(kit, w.p, { title: "Another", files: [{ path: await outsidePdf("other.pdf"), role: "original", handling: "copy" }] });
    const stored = join(kit.lib.root, other.assets.find((a) => a.role === "original")!.path);
    const before = await snapshot(w);
    const out = await attach().attachFiles(w.p.id, [stored], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: stored, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
    expect(await snapshot(w)).toEqual(before);
  });

  it("a symbolic link outside the library that points inside it", async () => {
    const w = await world();
    const link = join(kit.tmp, "elsewhere", "looks-mine.pdf");
    await mkdir(join(kit.tmp, "elsewhere"), { recursive: true });
    await symlink(w.held, link);
    const before = await snapshot(w);
    const out = await attach().attachFiles(w.p.id, [link], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: link, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
    expect(await snapshot(w)).toEqual(before);
  });

  it("a symbolic link to a folder on the way (the folder outside, its target the library)", async () => {
    const w = await world();
    await symlink(kit.lib.root, join(kit.tmp, "lib-link"));
    const via = join(kit.tmp, "lib-link", relative(kit.lib.root, w.held));
    const out = await attach().attachFiles(w.p.id, [via], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: via, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
  });

  it("a path into the library written with ..", async () => {
    const w = await world();
    await mkdir(join(kit.tmp, "in"), { recursive: true });
    const dotted = `${kit.tmp}/in/../Lib/${relative(kit.lib.root, w.held)}`;
    const out = await attach().attachFiles(w.p.id, [dotted], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: dotted, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
  });

  it("a path inside the library that does not exist: refused by its nearest existing parent", async () => {
    const w = await world();
    const ghost = join(kit.lib.root, "Exports", "not-yet", "x.pdf");
    const out = await attach().attachFiles(w.p.id, [ghost], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: ghost, outcome: "failed", reason: IN_LIBRARY_TEXT.file }]);
  });

  it("several dropped files, one inside: that one refused and named, the others attached as before", async () => {
    const w = await world();
    const a = await outsidePdf("a.pdf");
    const out = await attach().attachFiles(w.p.id, [a, w.held], { toSourceId: w.sourceId });
    expect(out).toEqual([
      { path: a, outcome: "attached", sourceId: w.sourceId },
      { path: w.held, outcome: "failed", reason: IN_LIBRARY_TEXT.file },
    ]);
    expect((await kit.repo.getSource(w.p.id, w.sourceId)).assets.filter((x) => x.role === "original")).toHaveLength(1);
    expect((await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending").map((e) => e.id)).toEqual([w.reviewId]);
  });

  it("an ordinary file outside the library still attaches; a file whose name only starts with the library's name too", async () => {
    const w = await world();
    const sibling = join(kit.tmp, "Lib-notes", "paper.pdf");
    await mkdir(join(kit.tmp, "Lib-notes"), { recursive: true });
    await copyFile(await outsidePdf("p.pdf"), sibling);
    const out = await attach().attachFiles(w.p.id, [sibling], { toSourceId: w.sourceId });
    expect(out).toEqual([{ path: sibling, outcome: "attached", sourceId: w.sourceId }]);
  });
});

describe("inside a folder, by name (the rule both checks use)", () => {
  it("a different letter case is inside on a case-insensitive system (macOS, Windows), not on Linux", () => {
    expect(insideFolder("/Users/a/Library Folder", "/users/a/library folder/Projects/x.pdf", "darwin")).toBe(true);
    expect(insideFolder("C:\\Users\\a\\Lib", "c:\\users\\a\\LIB\\x.pdf", "win32")).toBe(true);
    expect(insideFolder("/home/a/Lib", "/home/a/lib/x.pdf", "linux")).toBe(false);
    expect(insideFolder("/home/a/Lib", "/home/a/Lib/x.pdf", "linux")).toBe(true);
    expect(insideFolder("/home/a/Lib", "/home/a/Lib", "linux")).toBe(true);
    expect(insideFolder("/home/a/Lib", "/home/a/Lib-2/x.pdf", "linux")).toBe(false);
    expect(insideFolder("/home/a/Lib", "/home/a/Lib/..inner/x.pdf", "linux")).toBe(true);
  });
});

describe("the folder import refuses a folder inside the library or holding it (R362 c)", () => {
  const refused = async (p: Project, dir: string) => {
    const before = await readdir(join(kit.lib.root, kit.repo.getProject(p.id).folder));
    await expect(bulk.dryRun(p.id, folderAdapter(dir))).rejects.toThrow(new BatchRefusedError(IN_LIBRARY_TEXT.folder));
    await expect(bulk.startBatch(p.id, folderAdapter(dir))).rejects.toThrow(new BatchRefusedError(IN_LIBRARY_TEXT.folder));
    await expect(bulk.startBatch(p.id, folderAdapter(dir))).rejects.toMatchObject({ kind: "invalid", denied: false });
    expect(await bulk.listBatches(p.id)).toEqual([]);
    expect(await readdir(join(kit.lib.root, kit.repo.getProject(p.id).folder))).toEqual(before);
  };

  it("the library's own folder", async () => {
    const w = await world();
    await refused(w.p, kit.lib.root);
  });

  it("a project's folder, and its find/held/ folder", async () => {
    const w = await world();
    await refused(w.p, join(kit.lib.root, kit.repo.getProject(w.p.id).folder));
    await refused(w.p, join(kit.lib.root, kit.repo.getProject(w.p.id).folder, "find", "held"));
  });

  it("a folder that holds the library", async () => {
    const w = await world();
    await refused(w.p, kit.tmp);
  });

  it("a link outside the library to the library's folder", async () => {
    const w = await world();
    await symlink(kit.lib.root, join(kit.tmp, "lib-link"));
    await refused(w.p, join(kit.tmp, "lib-link"));
  });

  it("a resumed batch whose folder is now the library's (a link swapped in) is refused too", async () => {
    const w = await world();
    const dir = join(kit.tmp, "papers");
    await mkdir(dir, { recursive: true });
    for (const n of ["one", "two", "three"]) await copyFile(await outsidePdf(`${n}.pdf`), join(dir, `${n}.pdf`));
    const h = await bulk.startBatch(w.p.id, folderAdapter(dir));
    expect((await h.suspend()).state).toBe("paused");
    const rec = (await bulk.listBatches(w.p.id))[0]!;
    const before = await snapshot(w);
    await expect(bulk.resumeBatch(w.p.id, rec.batchId, folderAdapter(kit.lib.root))).rejects.toThrow(new BatchRefusedError(IN_LIBRARY_TEXT.folder));
    await expect(bulk.resumeBatch(w.p.id, rec.batchId, folderAdapter(join(kit.lib.root, "Projects")))).rejects.toThrow(new BatchRefusedError(IN_LIBRARY_TEXT.folder));
    expect(await snapshot(w)).toEqual(before);
  });

  it("a file in an ordinary folder that is a link into the library is not imported, even with the library's folder approved", async () => {
    const w = await world();
    const dir = join(kit.tmp, "papers");
    await mkdir(dir, { recursive: true });
    await copyFile(await outsidePdf("one.pdf"), join(dir, "one.pdf"));
    await symlink(w.held, join(dir, "found.pdf"));
    const summary = await bulk.dryRun(w.p.id, folderAdapter(dir), { approveOutside: { folders: [kit.lib.root] } });
    expect(summary.unreadable).toEqual([{ path: "found.pdf", reason: IN_LIBRARY_TEXT.file }]);
    expect(summary.outsideFiles).toEqual([]);
    const before = await snapshot(w);
    const h = await bulk.startBatch(w.p.id, folderAdapter(dir), { approveOutside: { folders: [kit.lib.root] } });
    const result = await h.done;
    expect(result.counts).toMatchObject({ items: 2, failed: 1 });
    expect(result.counts.created + result.counts.needsReview).toBe(1);
    const report = await bulk.batchReport(w.p.id, h.batchId);
    expect(report.failures).toEqual([{ item: "found.pdf", reason: IN_LIBRARY_TEXT.file }]);
    // The held file, its source and its review entry as they were (the other file's own entries aside).
    const after = await snapshot(w);
    expect([after.source, after.assets, after.held]).toEqual([before.source, before.assets, before.held]);
    expect(after.pending).toContain(w.reviewId);
  });

  it("an ordinary folder outside the library still imports", async () => {
    const w = await world();
    const dir = join(kit.tmp, "Lib-papers");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "one.pdf"), await readFile(await outsidePdf("one.pdf")));
    const h = await bulk.startBatch(w.p.id, folderAdapter(dir));
    const c = (await h.done).counts;
    expect(c).toMatchObject({ items: 1, failed: 0 });
    expect(c.created + c.needsReview).toBe(1);
  });
});
