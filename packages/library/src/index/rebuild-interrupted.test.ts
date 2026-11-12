/**
 * Task 46a fix round 1, C1: a rebuild that stops half-way is never taken as complete. From its first
 * write to its last the index carries R161's lasting "rebuild needed" mark, cleared only by the final
 * step of a completed rebuild; any open that finds the mark rebuilds again; the files are the record.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Provenance, SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import type { Repo } from "../repo/index.js";
import { openTestRepo } from "../repo/testing.js";
import { appendJobRecords, readJobJournal } from "../job-journal.js";
import { listProjectEntries } from "./changes.js";
import { INDEX_FILE, IndexHandle, createIndexSink, getMeta, indexIsPartial, setMeta, isIndexStale, openIndexChecked, rebuildIndex, rebuildIndexIfNeeded, search } from "./index.js";

const NOW = "2026-11-12T10:00:00.000Z";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let pdf: string;
let pid: string;
const handles: IndexHandle[] = [];

function deps(): Deps {
  return {
    clock: () => new Date(NOW),
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

const draft = (title: string): SourceDraft => ({
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
});
const prov = (): Provenance => ({ captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false });
const files = () => [{ path: pdf, role: "original" as const, handling: "copy" as const }];

/** A repo whose writes go to `h` through the sink (as the service's), or to no index. */
const repoOver = (h?: IndexHandle, hold?: () => boolean): Promise<Repo> =>
  openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10, ...(h ? { index: createIndexSink(h, { root: lib.root, keyRing: ring }, hold ? { holdStamps: hold } : {}) } : {}) });

const track = (h: IndexHandle) => (handles.push(h), h);
const deleteIndex = async () => {
  for (const s of ["", "-wal", "-shm"]) await rm(join(lib.root, INDEX_FILE + s), { force: true });
};
/** As the service opens a library: the checked index, then a rebuild when it is needed. */
async function openAndRebuild(): Promise<IndexHandle> {
  const c = await openIndexChecked(lib.root);
  track(c.handle);
  await rebuildIndexIfNeeded(c.handle, ring, lib, { force: c.needsRebuild !== undefined });
  return c.handle;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-rebuild-int-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, Buffer.from("%PDF-1.7\nhello\n%%EOF\n"));
  // Three sources on disk, indexed.
  const h = track(new IndexHandle(lib.root));
  const repo = await repoOver(h);
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  for (const t of ["Harbour ledger", "Salt marsh survey", "Tide tables"]) await repo.createSource(pid, draft(t), files(), { provenance: prov() });
  h.close();
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try {
      h.close();
    } catch {
      // closed
    }
  }
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("C1: a missing index carries the mark until a completed rebuild", () => {
  it("openIndexChecked marks a missing index; a write made meanwhile does not make it look complete; the next open rebuilds every source", async () => {
    await deleteIndex();
    const c = await openIndexChecked(lib.root);
    track(c.handle);
    expect(c.needsRebuild).toBe("missing");
    expect(getMeta(c.handle.db, "needsRebuild")).toBe("missing");
    expect(indexIsPartial(c.handle.db)).toBe(true);
    // A governed write lands in the empty index before any rebuild (e.g. an attach), then the app stops.
    await (await repoOver(c.handle)).createSource(pid, draft("Written meanwhile"), files(), { provenance: prov() });
    expect(await isIndexStale(lib.root, c.handle.db, ring)).toBe(true);
    c.handle.close();
    // Next open: the mark is still there, so the index is rebuilt and lists all four sources.
    const again = await openIndexChecked(lib.root);
    track(again.handle);
    expect(again.needsRebuild).toBe("marked");
    expect(again.partial).toBe(true);
    await rebuildIndexIfNeeded(again.handle, ring, lib, { force: true });
    expect(search(again.handle.db, { projectId: pid }).total).toBe(4);
    expect(getMeta(again.handle.db, "needsRebuild")).toBeUndefined();
    expect(indexIsPartial(again.handle.db)).toBe(false);
  });

  it("a new library's empty index is its whole content: not marked", async () => {
    await deleteIndex();
    const c = await openIndexChecked(lib.root, undefined, { newLibrary: true });
    track(c.handle);
    expect(c.needsRebuild).toBeUndefined();
    expect(getMeta(c.handle.db, "needsRebuild")).toBeUndefined();
  });

  const crashPoints: Array<[string, (stop: () => never) => Parameters<typeof rebuildIndexIfNeeded>[3]]> = [
    ["after the first source is written", (stop) => ({ onProgress: (d) => (d === 1 ? stop() : undefined) })],
    ["mid-way", (stop) => ({ onProgress: (d, t) => (t > 0 && d === Math.ceil(t / 2) ? stop() : undefined) })],
    ["just before the mark is cleared", (stop) => ({ rebuild: { beforeComplete: () => stop() } })],
    ["just before the new index is put in place", (stop) => ({ rebuild: { beforeRename: () => stop() } })],
  ];
  for (const [when, at] of crashPoints) {
    it(`a crash ${when}, with a write in between: the next open rebuilds and lists every source on disk`, async () => {
      await deleteIndex();
      const c = await openIndexChecked(lib.root);
      track(c.handle);
      const stop = (): never => {
        throw new Error("power cut");
      };
      await expect(rebuildIndexIfNeeded(c.handle, ring, lib, { force: true, ...at(stop) })).rejects.toThrow("power cut");
      expect(getMeta(c.handle.db, "needsRebuild")).toBe("missing");
      await (await repoOver(c.handle)).createSource(pid, draft("Written meanwhile"), files(), { provenance: prov() });
      c.handle.close();
      // A hard kill can leave the half-built new index behind; it is never used.
      await writeFile(join(lib.root, `${INDEX_FILE}.rebuild-dead`), "half-built");
      const h = await openAndRebuild();
      expect(search(h.db, { projectId: pid }).total).toBe(4);
      expect(getMeta(h.db, "needsRebuild")).toBeUndefined();
      expect((await readdir(lib.root)).filter((f) => f.includes(".rebuild-"))).toEqual([]);
    });
  }

  it("a rebuild interrupted twice in a row: the mark stays through both, and the third open completes it", async () => {
    await deleteIndex();
    for (let i = 0; i < 2; i++) {
      const c = await openIndexChecked(lib.root);
      track(c.handle);
      expect(c.needsRebuild).toBe(i === 0 ? "missing" : "marked");
      const ac = new AbortController();
      await expect(rebuildIndexIfNeeded(c.handle, ring, lib, { force: true, signal: ac.signal, onProgress: (d) => (d === 1 ? ac.abort() : undefined) })).rejects.toThrow();
      await (await repoOver(c.handle)).createSource(pid, draft(`Written meanwhile ${i}`), files(), { provenance: prov() });
      expect(indexIsPartial(c.handle.db)).toBe(true);
      c.handle.close();
    }
    const h = await openAndRebuild();
    expect(search(h.db, { projectId: pid }).total).toBe(5);
    expect(indexIsPartial(h.db)).toBe(false);
  });

  it("the new index carries the mark while it is built, and the completed one does not", async () => {
    const h = track(new IndexHandle(lib.root));
    const seen: Array<string | undefined> = [];
    await rebuildIndex(h, ring, lib, undefined, {
      beforeComplete: async () => {
        const tmpName = (await readdir(lib.root)).find((f) => f.startsWith(`${INDEX_FILE}.rebuild-`) && !/-(wal|shm|journal)$/.test(f))!;
        const peek = new Database(join(lib.root, tmpName), { readonly: true });
        try {
          seen.push((peek.prepare("SELECT value FROM meta WHERE key = 'needsRebuild'").get() as { value: string } | undefined)?.value);
        } finally {
          peek.close();
        }
      },
    });
    expect(seen).toEqual(["rebuilding"]);
    expect(getMeta(h.db, "needsRebuild")).toBeUndefined();
  });
});

describe("C1: a stale index interrupted while rebuilding stays stale", () => {
  it("a write after the interrupted rebuild does not hide the change made outside the app", async () => {
    // A change made outside the app (no index): the index is stale.
    await (await repoOver()).createSource(pid, draft("Made elsewhere"), files(), { provenance: prov() });
    const c = await openIndexChecked(lib.root);
    track(c.handle);
    expect(c.needsRebuild).toBeUndefined();
    await expect(rebuildIndexIfNeeded(c.handle, ring, lib, { onProgress: (d) => (d === 1 ? (() => { throw new Error("boom"); })() : undefined) })).rejects.toThrow("boom");
    expect(getMeta(c.handle.db, "needsRebuild")).toBe("stale");
    expect(indexIsPartial(c.handle.db)).toBe(false); // a stale index is not half-built: its list stays shown
    // A write in the same project refreshes that project's stamp...
    await (await repoOver(c.handle)).createSource(pid, draft("Written here"), files(), { provenance: prov() });
    c.handle.close();
    // ...but the mark keeps the index stale: the next open rebuilds and finds the outside change.
    const h = await openAndRebuild();
    expect(search(h.db, { text: "elsewhere" }).total).toBe(1);
    expect(search(h.db, { projectId: pid }).total).toBe(5);
  });

  it("M6: stamps are held until the staleness check has run, so a write before it cannot hide an outside change", async () => {
    await (await repoOver()).createSource(pid, draft("Made elsewhere"), files(), { provenance: prov() });
    const h = track(new IndexHandle(lib.root));
    let held = true;
    await (await repoOver(h, () => held)).createSource(pid, draft("Written before the check"), files(), { provenance: prov() });
    held = false;
    expect(await isIndexStale(lib.root, h.db, ring)).toBe(true);
    await rebuildIndexIfNeeded(h, ring, lib);
    expect(search(h.db, { text: "elsewhere" }).total).toBe(1);
  });

  it("onChecked is called once the decision is made (and the mark written when stale)", async () => {
    const h = track(new IndexHandle(lib.root));
    const calls: Array<[boolean, string | undefined]> = [];
    await rebuildIndexIfNeeded(h, ring, lib, { onChecked: (stale) => calls.push([stale, getMeta(h.db, "needsRebuild")]) });
    await (await repoOver()).createSource(pid, draft("Made elsewhere"), files(), { provenance: prov() });
    await rebuildIndexIfNeeded(h, ring, lib, { onChecked: (stale) => calls.push([stale, getMeta(h.db, "needsRebuild")]) });
    expect(calls).toEqual([
      [false, undefined],
      [true, "stale"],
    ]);
  });
});

describe("C1 with the job records (Task 51): a stopped rebuild leaves the mark; the job cache is rebuilt at the next open", () => {
  const jobIds = (h: IndexHandle) => (h.db.prepare("SELECT id FROM jobs ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  const projectRel = async () => (await listProjectEntries(lib.root)).find((e) => e.data?.project.id === pid)!.rel;

  it("a rebuild stopped half-way keeps the mark, and the next open rebuilds the jobs table from the journal", async () => {
    await appendJobRecords(lib.root, await projectRel(), null, [{ v: 1, id: "job-1", projectId: pid, kind: "pdf.ocr", status: "done", createdAt: NOW, updatedAt: NOW }]);
    await deleteIndex();
    const c = await openIndexChecked(lib.root);
    track(c.handle);
    await expect(rebuildIndexIfNeeded(c.handle, ring, lib, { force: true, onProgress: (d) => (d === 1 ? (() => { throw new Error("power cut"); })() : undefined) })).rejects.toThrow("power cut");
    expect(getMeta(c.handle.db, "needsRebuild")).toBe("missing");
    expect(jobIds(c.handle)).toEqual([]); // the half-built index never replaced the live one
    c.handle.close();
    const h = await openAndRebuild();
    expect(jobIds(h)).toEqual(["job-1"]);
    expect(getMeta(h.db, "needsRebuild")).toBeUndefined();
  });

  it("the legacy job upgrade, then a stop: the rows are in the journal, the mark stays, and the next open puts them in the cache", async () => {
    const h0 = track(new IndexHandle(lib.root));
    h0.db.prepare("INSERT INTO jobs (id, project_id, kind, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("legacy-1", pid, "pdf.ocr", "done", "{}", NOW);
    setMeta(h0.db, "jobsLegacy", "1");
    // The upgrade runs at the start of the rebuild; the stop comes just before the mark is cleared.
    await expect(rebuildIndexIfNeeded(h0, ring, lib, { force: true, rebuild: { beforeComplete: () => Promise.reject(new Error("power cut")) } })).rejects.toThrow("power cut");
    expect(getMeta(h0.db, "needsRebuild")).toBe("forced");
    expect((await readJobJournal(lib.root, await projectRel(), pid, null)).records.has("legacy-1")).toBe(true);
    h0.close();
    const h = await openAndRebuild();
    expect(jobIds(h)).toEqual(["legacy-1"]);
    expect(getMeta(h.db, "needsRebuild")).toBeUndefined();
    expect(getMeta(h.db, "jobsLegacy")).toBeUndefined();
  });
});

