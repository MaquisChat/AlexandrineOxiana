// FR-726 (R482 c): the Zotero import wizard's summary (the dry run) asks one thing of the batches made before: whether
// an item it finds came in from Zotero before (then it says that what was taken away in Zotero stays here, FR-132). It
// used to read every batch journal of its kind for that, which after months of automatic syncs is hundreds of files.
// It now reads them newest first and stops at the first item it finds there; what the summary says does not change.
// The journals read are counted here (by their file reads); the time is not asserted.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { buildZoteroFixture } from "../../tests/fixtures/zotero/build-fixture.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { createBulkImport } from "./bulk/index.js";
import { ZOTERO_NOTES, zoteroLocalAdapter } from "./zotero-local.js";

const journalReads = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...a: Parameters<typeof actual.readFile>) => {
    if (String(a[0]).endsWith("journal.jsonl")) journalReads.n++;
    return actual.readFile(...a);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const FAST = 2 ** 10;
const GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    zotero-import: "legitimate interest; Zotero library"
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;
/** The batches made before the dry run: one real import, then copies of it, as months of automatic syncs leave. */
const BATCHES = 500;

let tmp: string;
let dataDir: string;
let linkedDir: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let agent: MockAgent;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zotero-journals-"));
  dataDir = join(tmp, "Zotero");
  linkedDir = join(tmp, "Elsewhere");
  buildZoteroFixture(dataDir, {
    pdf: await buildPdf({ extra: "okafor zotero" }),
    linkedPdf: await buildPdf({ extra: "adebayo linked" }),
    trashedPdf: await buildPdf({ extra: "trashed" }),
    linkedDir,
  });
  const deps: Deps = {
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
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Library"), "Lib", deps);
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  agent = new MockAgent();
  agent.disableNetConnect();
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

const bulkImport = () => createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
const said = (notes: string[]) => notes.includes(ZOTERO_NOTES.removalsKept("zotero-local"));
const batchDir = (p: Project, n: number) => join(lib.root, p.folder, "imports", `batch-${String(n).padStart(4, "0")}`);

/** A project with one real Zotero import, its batch copied as batches 2..BATCHES (`journal`: what each copy's journal holds). */
async function importedOften(journal: "same" | "empty" = "same"): Promise<Project> {
  const p = (await repo.createProject({ name: "Field study", governanceYaml: GOV, encryption: { enabled: false } })).project;
  const bulk = bulkImport();
  await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), { approveOutside: { folders: [linkedDir] } })).done;
  for (let n = 2; n <= BATCHES; n++) {
    await cp(batchDir(p, 1), batchDir(p, n), { recursive: true });
    if (journal === "empty") await writeFile(join(batchDir(p, n), "journal.jsonl"), "");
  }
  return p;
}

describe("FR-726: a Zotero dry run after many batches", () => {
  it(`reads the journals newest first and stops at the first item it finds there: one journal of ${BATCHES}, the same summary`, async () => {
    const p = await importedOften();
    journalReads.n = 0;
    const dry = await bulkImport().dryRun(p.id, zoteroLocalAdapter(dataDir));
    expect(said(dry.notes)).toBe(true);
    expect(journalReads.n).toBe(1);
  });

  it("an item known only to the oldest batch: every journal is read, and the summary still says it", async () => {
    const p = await importedOften("empty");
    journalReads.n = 0;
    const dry = await bulkImport().dryRun(p.id, zoteroLocalAdapter(dataDir));
    expect(said(dry.notes)).toBe(true);
    expect(journalReads.n).toBe(BATCHES);
  });

  it("an undone batch counts for nothing, as before: no note, and its journal is not read", async () => {
    const p = (await repo.createProject({ name: "Field study", governanceYaml: GOV, encryption: { enabled: false } })).project;
    const bulk = bulkImport();
    await (await bulk.startBatch(p.id, zoteroLocalAdapter(dataDir), { approveOutside: { folders: [linkedDir] } })).done;
    const record = join(batchDir(p, 1), "batch.json");
    await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record, "utf8")), state: "undone" }));
    journalReads.n = 0;
    expect(said((await bulk.dryRun(p.id, zoteroLocalAdapter(dataDir))).notes)).toBe(false);
    expect(journalReads.n).toBe(0);
  });

  it("before any batch: no journal is read and no note is said", async () => {
    const p = (await repo.createProject({ name: "Field study", governanceYaml: GOV, encryption: { enabled: false } })).project;
    await mkdir(join(lib.root, p.folder, "imports"), { recursive: true });
    journalReads.n = 0;
    expect(said((await bulkImport().dryRun(p.id, zoteroLocalAdapter(dataDir))).notes)).toBe(false);
    expect(journalReads.n).toBe(0);
  });
});
