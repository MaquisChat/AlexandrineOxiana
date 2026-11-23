/**
 * R470 a (FR-504, FR-527): a record whose only original is a LINKED file that cannot be found now. The copy part no
 * longer takes it for "in your library": the entry rests "record-complete" with its own reason and asks nothing; only
 * the researcher's "Get a copy for this source" (`getCopy`) lets the copy part look for a copy for it, and the pick is
 * remembered across a restart. A found copy waits for the researcher's check as every found file does (R301, R303);
 * "Use this file" ADDS it beside the linked original, which stays as it is.
 *
 * Kept in a file of its own, apart from runner.test.ts; every wait here is for the entry's true resting state (its
 * line written, its event sent, its download folder gone).
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { newId, type Project, type SourceDraft } from "@ao/core";
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIND_REASON_TEXT } from "@ao/shared";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { IndexHandle, createIndexSink } from "../index/index.js";
import { HttpClient } from "../lookup/http.js";
import { activeTemp } from "../tmp-registry.js";
import { checkIntegrity } from "../reconnect.js";
import { readReviewEntries } from "../repo/review.js";
import type { Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { openTestRepo } from "../repo/testing.js";
import { appendFindEntries, readFindQueue } from "./queue-store.js";
import { FindEntryStateError, createFindRunner, type FindRunner } from "./runner.js";
import { DEFAULT_SEARCH_SETTINGS, type FindEntry, type FindState, type SearchSettings } from "./types.js";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
processing:
  metadata_lookup: [crossref, openalex]
`;
const DOI = "10.5555/ao.re7b.linked";
const TITLE = "Zorblatt Grammar of Habitus";
const COPY_URL = "https://arxiv.org/pdf/2101.00001";
const PAGE = [
  "The study reads how people speak of their habits over many years, drawing on letters and",
  "interviews kept in family hands, and argues that the words they choose shape what they",
  "are able to remember of the places they have lived in and of the work they have done there.",
];
const goodPdf = () =>
  buildPdf({ title: TITLE, author: "Mirabel Quillfeather", lines: ["Journal of Invented Studies 4 (1999)", TITLE, "Mirabel Quillfeather", `doi:${DOI}`, "Abstract. A grammar of habitus, invented for these tests, with enough words.", ...PAGE] });

let tmp: string;
let lib: Library;
let ring: KeyRing;
let handle: IndexHandle;
let repo: Repo;
let agent: MockAgent;
let fileAgent: MockAgent;
let saved: Dispatcher;
let http: HttpClient;
let runners: FindRunner[];
let changes: Array<{ projectId: string; entryId: string; state: FindState }>;
/** Every free-copy lookup asked of OpenAlex, and every file address asked for. */
let copyRequests: string[];
let fileRequests: string[];
let settingsFn: () => Promise<SearchSettings>;

const COPY_ONLY_OPENALEX = (): SearchSettings => ({ ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: c.id === "openalex" })) });
const coreOf = (r: Repo = repo) => (r as unknown as { core: RepoCore }).core;

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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-linked-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { tz: "UTC", actor: "tester", scryptN: 2 ** 10, clock: () => new Date(NOW), index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  runners = [];
  changes = [];
  copyRequests = [];
  fileRequests = [];
  settingsFn = async () => COPY_ONLY_OPENALEX();
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works/doi:"), method: "GET" })
    .reply((o) => {
      copyRequests.push(String(o.path));
      return { statusCode: 200, data: JSON.stringify({ id: "https://openalex.org/W1", best_oa_location: { is_oa: true, pdf_url: COPY_URL }, locations: [] }), responseOptions: { headers: { "content-type": "application/json" } } };
    })
    .persist();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, clock: () => NOW, sleep: async () => {}, env: {}, maxRetries: 0 });
  const pdf = await goodPdf();
  fileAgent = new MockAgent();
  fileAgent.disableNetConnect();
  fileAgent
    .get("https://arxiv.org")
    .intercept({ path: () => true, method: "GET" })
    .reply((o) => {
      fileRequests.push(`https://arxiv.org${String(o.path)}`);
      return { statusCode: 200, data: pdf };
    })
    .persist();
  saved = getGlobalDispatcher();
  setGlobalDispatcher(fileAgent);
});
afterEach(async () => {
  for (const r of runners) await r.stopAll();
  setGlobalDispatcher(saved);
  await fileAgent.close();
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

function runner(): FindRunner {
  const r = createFindRunner({ repo, index: handle.db, http, settings: () => settingsFn(), checkEverything: () => false, now: () => new Date(NOW), onChange: (e) => changes.push(e) });
  runners.push(r);
  return r;
}

const draft = (): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: TITLE }] },
  creators: [{ role: "author", family: "Quillfeather", given: "Mirabel" }],
  issued: "1999",
  identifiers: { doi: DOI },
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});

/** A file outside the library (a drive of the researcher's), as a link points to it. */
const outside = () => join(tmp, "Drive", "Papers", "zorblatt.pdf");

type World = { p: Project; sid: string; eid: string };

/**
 * A project with a record and its entry, resting "record-complete" as the record part leaves it. `file`: the record's
 * original — linked from outside the library (then removed when `missing`), stored (copied in), or none.
 */
async function world(file: "linked" | "linked-missing" | "stored"): Promise<World> {
  const p = (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;
  await mkdir(join(tmp, "Drive", "Papers"), { recursive: true });
  await writeFile(outside(), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
  const sf = await repo.createSource(p.id, draft(), [{ path: outside(), role: "original", handling: file === "stored" ? "copy" : "link" }], {
    provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "drag-and-drop", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
  });
  if (file === "linked-missing") await rm(outside());
  const at = new Date(NOW).toISOString();
  const eid = newId();
  const e: FindEntry = { id: eid, projectId: p.id, typed: "Quillfeather, Zorblatt Grammar of Habitus, 1999", state: "record-complete", sourceId: sf.source.id, createdAt: at, updatedAt: at, attempts: 0 };
  await appendFindEntries(coreOf(), p.id, [e], "add");
  return { p, sid: sf.source.id, eid };
}

const entryOf = async (w: World, r: Repo = repo) => (await readFindQueue(coreOf(r), w.p.id)).get(w.eid);
/** Real waiting for real file work. */
async function until(what: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!(await what())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/**
 * The entry's true resting state: its line says `state` (and `reason` when given), the event for that state was sent,
 * and no download folder of it is left.
 */
async function restsAt(w: World, state: FindState, reason?: string): Promise<FindEntry> {
  await until(async () => {
    const e = await entryOf(w);
    return e?.state === state && (reason === undefined || e.reason?.code === reason);
  }, `the entry to rest "${state}"`);
  await until(() => changes.some((c) => c.entryId === w.eid && c.state === state), "its event");
  await until(async () => !activeTemp.has(`find-${w.eid}`) && !(await readdir(join(lib.root, ".tmp", `find-${w.eid}`)).then(() => true, () => false)), "its folder to go");
  return (await entryOf(w))!;
}
const pendingReviews = async (w: World) => (await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending");

describe("R470 a: the copy part tells a linked original it cannot reach", () => {
  it("a record whose only original is a linked file that cannot be found rests with its own reason, and nothing is asked or fetched", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    const e = await restsAt(w, "record-complete", "linked-file-missing");
    expect(e.reason).toEqual({ code: "linked-file-missing" });
    expect(FIND_REASON_TEXT["linked-file-missing"]).toBe("Its linked file cannot be found at the moment; the drive it is on may not be connected.");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
    expect(await pendingReviews(w)).toEqual([]);
    const sf = await repo.getSource(w.p.id, w.sid);
    expect(sf.assets).toHaveLength(1);
    expect(sf.assets[0]!.linked).toBeDefined();
  });

  it("a linked original that can be reached rests in the library, as before", async () => {
    const w = await world("linked");
    runner().resume(w.p.id);
    const e = await restsAt(w, "in-library");
    expect(e.reason).toBeUndefined();
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("a stored original rests in the library, as before (even were its file gone, that is the Missing files screen's)", async () => {
    const w = await world("stored");
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("when the linked file is back, the next opening finds it and the entry rests in the library", async () => {
    const w = await world("linked-missing");
    runner().resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    for (const r of runners) await r.stopAll();
    await writeFile(outside(), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    expect((await entryOf(w))!.reason).toBeUndefined();
    expect(copyRequests).toEqual([]);
  });
});
