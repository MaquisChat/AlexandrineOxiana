/**
 * R484 a (R473 I1 3): when the library is reopened after a change whose roll-back did not finish, the files that
 * change named are judged against the state before its first step and the change's own writes: the app's own
 * writes are never recorded as "changed outside the app"; a real outside edit is recorded once; the state before
 * the change is put back in every case. In-process roll-backs are made to fail with the NODE_ENV=test seam (R47).
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import { importChange } from "./repo.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { undoEntries, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const PDF = "%PDF-1.7\nhello\n%%EOF\n";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;
let sid: string;
let folder: string;
let original: string;

const mkDeps = (): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});
const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
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
const provenance = (): Provenance => ({ captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false });
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const note = (sourceId: string, body: string): Annotation => ({ id: newId(), sourceId, kind: "note", anchors: [], body, author: "tester", createdAt: NOW });
const withNotes = (sf: SourceFile, bodies: string[]): SourceFile => ({ ...sf, annotations: bodies.map((b) => note(sf.source.id, b)) });

const OUTSIDE = new Set(["changed-outside-before-rollback", "annotations-hash-mismatch"]);
const outside = () => repo.integrityWarnings.filter((w) => OUTSIDE.has(w.kind)).map((w) => [w.kind, w.file]);
const markers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};
const sourceJson = () => readFile(join(lib.root, folder, "source.json"), "utf8");

/** The state before the change: the two notes, the stored original, no marker left. */
async function earlierStateBack(sourceBefore: string): Promise<void> {
  expect(await sourceJson()).toBe(sourceBefore);
  expect((await repo.getSource(pid, sid)).annotations.map((a) => a.body)).toEqual(["first", "second"]);
  expect(await readFile(join(lib.root, original), "utf8")).toBe(PDF);
  expect(await markers()).toEqual([]);
}

/** A hand edit of source.json: the same record, another title. */
async function editSourceByHand(): Promise<void> {
  const sf = JSON.parse(await sourceJson()) as SourceFile;
  sf.source.title.variants[0]!.value = "Retitled by hand";
  await writeFile(join(lib.root, folder, "source.json"), JSON.stringify(sf));
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r484a-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  const pdf = join(tmp, "in.pdf");
  await writeFile(pdf, PDF);
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  sid = sf.source.id;
  folder = sf.source.folder;
  original = sf.assets[0]!.path;
  await importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(sid);
    await ops.writeSource(cur, withNotes(cur, ["first", "second"]));
  }, { op: "test.annotations" });
});
afterEach(async () => {
  seams.failUndo = undefined;
  seams.crashAt = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** P1: one change writes the source twice, then fails; putting a replaced file back fails too. */
async function writtenTwiceThenFailed(): Promise<void> {
  seams.failUndo = "replaced";
  await expect(
    importChange(repo, pid, STORE, async (ops) => {
      const cur = await ops.readSource(sid);
      const once = withNotes(cur, ["once"]);
      await ops.writeSource(cur, once);
      await ops.writeSource(once, withNotes(once, ["twice"]));
      throw new Error("the change failed");
    }, { op: "test.twice" }),
  ).rejects.toThrow("the change failed");
  seams.failUndo = undefined;
  expect(await markers()).toHaveLength(1);
}

/** P2: one change trashes the stored original, then writes the source, then fails; putting source.json back fails. */
async function trashedThenWrittenThenFailed(): Promise<void> {
  seams.failUndo = "replaced";
  await expect(
    importChange(repo, pid, STORE, async (ops) => {
      const cur = await ops.readSource(sid);
      await ops.trashAssetFile(cur.assets[0]!);
      await ops.writeSource(cur, withNotes(cur, ["after the trash"]));
      throw new Error("the change failed");
    }, { op: "test.trash-then-write" }),
  ).rejects.toThrow("the change failed");
  seams.failUndo = undefined;
  expect(await markers()).toHaveLength(1);
}

/** 54b9f25's case: a file is trashed, then written again at the same path by the same change; its undo fails. */
async function trashedThenWrittenAgainThenFailed(rel: string): Promise<void> {
  seams.failUndo = "created";
  await expect(
    repo.mutate(pid, STORE, async (tx) => {
      await tx.trash(rel);
      await tx.writeFile(rel, "written again by the change\n");
      throw new Error("the change failed");
    }),
  ).rejects.toThrow("the change failed");
  seams.failUndo = undefined;
  expect(await markers()).toHaveLength(1);
}

describe("R484 a: the app's own writes are never recorded as changed outside the app", () => {
  it("P1: a source written twice by the failed change; the reopen records no outside change and puts the earlier state back", async () => {
    const before = await sourceJson();
    await writtenTwiceThenFailed();
    await reopen();
    expect(outside()).toEqual([]);
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("rolled-back-incomplete-write");
    await earlierStateBack(before);
  });

  it("P1 with a real edit of source.json meanwhile: recorded exactly once, and the earlier state is put back", async () => {
    const before = await sourceJson();
    await writtenTwiceThenFailed();
    await editSourceByHand();
    await reopen();
    expect(outside()).toEqual([["changed-outside-before-rollback", `${folder}/source.json`]]);
    await earlierStateBack(before);
  });

  it("P2: a trashed original the failed roll-back already put back, then a source write; the reopen records nothing outside", async () => {
    const before = await sourceJson();
    await trashedThenWrittenThenFailed();
    // The in-process roll-back put the original back before it failed at source.json.
    expect(await readFile(join(lib.root, original), "utf8")).toBe(PDF);
    await reopen();
    expect(outside()).toEqual([]);
    await earlierStateBack(before);
  });

  it("P2 with a real edit of source.json meanwhile: recorded exactly once, and the earlier state is put back", async () => {
    const before = await sourceJson();
    await trashedThenWrittenThenFailed();
    await editSourceByHand();
    await reopen();
    expect(outside()).toEqual([["changed-outside-before-rollback", `${folder}/source.json`]]);
    await earlierStateBack(before);
  });

  it("the reverse order: trashed, then written again by the change itself; the reopen records nothing outside", async () => {
    const rel = `${folder}/notes.txt`;
    await writeFile(join(lib.root, rel), "before the change\n");
    const before = await sourceJson();
    await trashedThenWrittenAgainThenFailed(rel);
    expect(await readFile(join(lib.root, rel), "utf8")).toBe("written again by the change\n");
    await reopen();
    expect(outside()).toEqual([]);
    expect(await readFile(join(lib.root, rel), "utf8")).toBe("before the change\n");
    await earlierStateBack(before);
  });

  it("the reverse order with a real edit of the file written again: recorded exactly once, and the earlier state is put back", async () => {
    const rel = `${folder}/notes.txt`;
    await writeFile(join(lib.root, rel), "before the change\n");
    const before = await sourceJson();
    await trashedThenWrittenAgainThenFailed(rel);
    await writeFile(join(lib.root, rel), "edited by hand\n");
    await reopen();
    expect(outside()).toEqual([["changed-outside-before-rollback", rel]]);
    expect(await readFile(join(lib.root, rel), "utf8")).toBe("before the change\n");
    await earlierStateBack(before);
  });

  describe("a crash during the reopen's own roll-back, then a second reopen", () => {
    /** A change that trashes the original and writes the source twice, cut off by a crash before its audit entry. */
    async function crashedChange(): Promise<void> {
      seams.crashAt = "before-audit";
      await expect(
        importChange(repo, pid, STORE, async (ops) => {
          const cur = await ops.readSource(sid);
          await ops.trashAssetFile(cur.assets[0]!);
          const once = withNotes(cur, ["once"]);
          await ops.writeSource(cur, once);
          await ops.writeSource(once, withNotes(once, ["twice"]));
        }, { op: "test.crashed" }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await markers()).toHaveLength(1);
    }
    /** The reopen's roll-back dies after undoing every step from index `from` on (it undoes in reverse); `meanwhile` runs then. */
    async function rollBackCutFrom(pick: (m: TxnMarker) => number, meanwhile: () => Promise<void> = async () => {}): Promise<void> {
      await lib.close();
      const [name] = await markers();
      const m = JSON.parse(await readFile(join(lib.root, ".tmp", name!), "utf8")) as TxnMarker;
      expect(m.entries.filter((e) => e.kind === "replaced").length).toBeGreaterThanOrEqual(4); // two writes of each of the two files
      expect(await undoEntries(lib.root, m.entries.slice(pick(m)))).toBe(true);
      await meanwhile();
      lib = await openLibrary(lib.root, mkDeps());
      repo = await repoFor();
    }
    /** The step after the change's first write of source.json: cut there, the source holds that first write. */
    const afterFirstSourceWrite = (m: TxnMarker) => m.entries.findIndex((e) => e.kind === "replaced" && e.path === `${folder}/source.json`) + 1;

    it("cut while the source still holds the change's first write: the second reopen records nothing outside", async () => {
      const before = await sourceJson();
      await crashedChange();
      await rollBackCutFrom(afterFirstSourceWrite, async () => {
        expect(await sourceJson()).not.toBe(before); // the change's own first write, neither the state before nor its last write
      });
      expect(outside()).toEqual([]);
      await earlierStateBack(before);
    });

    it("cut after the trashed original was put back: the second reopen records nothing outside", async () => {
      const before = await sourceJson();
      await crashedChange();
      await rollBackCutFrom((m) => m.entries.findIndex((e) => e.kind === "trashed"), async () => {
        expect(await readFile(join(lib.root, original), "utf8")).toBe(PDF);
      });
      expect(outside()).toEqual([]);
      await earlierStateBack(before);
    });

    it("cut, then a real edit of source.json before the second reopen: recorded exactly once, and the earlier state is put back", async () => {
      const before = await sourceJson();
      await crashedChange();
      await rollBackCutFrom(afterFirstSourceWrite, editSourceByHand);
      expect(outside()).toEqual([["changed-outside-before-rollback", `${folder}/source.json`]]);
      await earlierStateBack(before);
    });
  });
});
