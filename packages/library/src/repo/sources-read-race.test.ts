/**
 * D21: a read of a source that falls between the two files a write updates (the annotations file,
 * then source.json) never records an integrity warning for the app's own write in progress; a real
 * change made outside the app is still reported, once. Writes are stopped half-way with the
 * NODE_ENV=test seam in writeSourceFile (R47).
 */
import { createHash } from "node:crypto";
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
import { pauseBetweenSourceFilesForTests } from "./sources.js";
import { SimulatedCrash, openTestRepo } from "./testing.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let pdf: string;

const mkDeps = (over: Partial<Deps> = {}): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
  ...over,
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

/** Writes the source's annotations through a governed change. */
const setAnnotations = (repo: Repo, pid: string, id: string, bodies: string[]) =>
  importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(id);
    await ops.writeSource(cur, { ...cur, annotations: bodies.map((b) => note(id, b)) });
  }, { op: "test.annotations" });

/** A gate the paused write waits on; `reached` resolves once the write is between its two files. */
function gate() {
  let release!: () => void;
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const open = new Promise<void>((r) => (release = r));
  return { reached, release, hook: async () => { reach(); await open; } };
}

/** The pair a read returned is consistent: the annotations match the count and hash source.json holds. */
async function consistentOnDisk(sf: SourceFile, folder: string): Promise<void> {
  const stored = JSON.parse(await readFile(join(lib.root, folder, "source.json"), "utf8")) as SourceFile;
  const bodies = sf.annotations.map((a) => a.body);
  if (stored.annotationCount) {
    expect(bodies).toHaveLength(stored.annotationCount);
    const onDisk = await readFile(join(lib.root, folder, "annotations.json"), "utf8");
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(stored.annotationsSha256);
  }
}

let repo: Repo;
let pid: string;
let sid: string;
let folder: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-d21-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  pdf = join(tmp, "in.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello\n%%EOF\n");
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  sid = sf.source.id;
  folder = sf.source.folder;
  await setAnnotations(repo, pid, sid, ["first", "second"]);
});
afterEach(async () => {
  pauseBetweenSourceFilesForTests(undefined);
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const warnings = (kind?: string) => repo.integrityWarnings.filter((w) => !kind || w.kind === kind);

describe("D21: a read between a write's two files", () => {
  it("records no warning and returns a consistent pair when the annotations changed", async () => {
    const g = gate();
    pauseBetweenSourceFilesForTests(g.hook);
    const write = setAnnotations(repo, pid, sid, ["first", "second", "third, new"]);
    await g.reached;
    // The new annotations file is on disk beside the old source.json.
    const read = repo.getSource(pid, sid);
    await new Promise((r) => setTimeout(r, 20));
    g.release();
    await write;
    const sf = await read;
    expect(warnings()).toEqual([]);
    expect([["first", "second"], ["first", "second", "third, new"]]).toContainEqual(sf.annotations.map((a) => a.body));
    await consistentOnDisk(sf, folder);
  });

  it("records no warning when the write removes every annotation (the trash path)", async () => {
    const g = gate();
    pauseBetweenSourceFilesForTests(g.hook);
    const write = setAnnotations(repo, pid, sid, []);
    await g.reached;
    // The annotations file is gone; source.json still counts two.
    const read = repo.getSource(pid, sid);
    await new Promise((r) => setTimeout(r, 20));
    g.release();
    await write;
    const sf = await read;
    expect(warnings()).toEqual([]);
    expect([[], ["first", "second"]]).toContainEqual(sf.annotations.map((a) => a.body));
    expect(sf.annotations).toEqual([]); // confirmed after the write finished
  });

  it("a read with nothing to confirm does not wait for a write in progress (the fast path)", async () => {
    const other = await repo.createSource(pid, draft("Other"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    const g = gate();
    pauseBetweenSourceFilesForTests(g.hook);
    const write = setAnnotations(repo, pid, other.source.id, ["elsewhere"]);
    await g.reached;
    // The write holds the queue; a consistent source reads at once.
    const sf = await repo.getSource(pid, sid);
    expect(sf.annotations.map((a) => a.body)).toEqual(["first", "second"]);
    g.release();
    await write;
    expect(warnings()).toEqual([]);
  });
});

describe("D21: a real mismatch is still reported", () => {
  it("an annotations file changed outside the app is read as it is, with one warning", async () => {
    const file = join(lib.root, folder, "annotations.json");
    const anns = JSON.parse(await readFile(file, "utf8")) as Annotation[];
    anns[0]!.body = "changed outside the app";
    await writeFile(file, JSON.stringify(anns));
    expect((await repo.getSource(pid, sid)).annotations[0]?.body).toBe("changed outside the app");
    expect((await repo.getSource(pid, sid)).annotations[0]?.body).toBe("changed outside the app");
    expect(warnings("annotations-hash-mismatch")).toHaveLength(1);
    expect(warnings("annotations-hash-mismatch")[0]).toMatchObject({ projectId: pid, file: `${folder}/annotations.json`, detail: "The annotations file of a source was changed outside the app; it was read as it is." });
    expect(warnings()).toHaveLength(1);
  });

  it("an annotations file removed outside the app gives one 'unreadable' warning", async () => {
    await rm(join(lib.root, folder, "annotations.json"));
    expect((await repo.getSource(pid, sid)).annotations).toEqual([]);
    expect(warnings("annotations-unreadable")).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
  });

  it("a change outside the app is reported even when found inside a governed change", async () => {
    const file = join(lib.root, folder, "annotations.json");
    await writeFile(file, JSON.stringify([note(sid, "outside")]));
    await importChange(repo, pid, STORE, async (ops) => {
      expect((await ops.readSource(sid)).annotations.map((a) => a.body)).toEqual(["outside"]);
    }, { op: "test.read" });
    expect(warnings("annotations-hash-mismatch")).toHaveLength(1);
  });
});

describe("D21: a write cut off between its two files (the process dies)", () => {
  it("is rolled back at the next open (R26): the pair is the one before the write, no annotation warning", async () => {
    pauseBetweenSourceFilesForTests(async () => {
      throw new SimulatedCrash("simulated crash between the annotations file and source.json");
    });
    await expect(setAnnotations(repo, pid, sid, ["replaced"])).rejects.toBeInstanceOf(SimulatedCrash);
    pauseBetweenSourceFilesForTests(undefined);
    expect((await readdir(join(lib.root, ".tmp"))).some((n) => /^txn-.*\.json$/.test(n))).toBe(true);
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    repo = await repoFor();
    const sf = await repo.getSource(pid, sid);
    expect(sf.annotations.map((a) => a.body)).toEqual(["first", "second"]);
    await consistentOnDisk(sf, folder);
    // Today's R26 recovery, unchanged: the interrupted change is rolled back and that is reported.
    expect(warnings().map((w) => w.kind)).toEqual(["rolled-back-incomplete-write"]);
  });
});
