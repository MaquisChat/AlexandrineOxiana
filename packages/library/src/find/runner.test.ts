import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createBulkImport } from "../import/bulk/index.js";
import { bibtexAdapter } from "../import/refman.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE, findDuplicate, newId, type Project, type SourceDraft } from "@ao/core";
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { activeTemp } from "../tmp-registry.js";
import { FIND_HELD_MAX, holdMismatchedFile, readReviewEntries } from "../repo/review.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { IndexHandle, createIndexSink } from "../index/index.js";
import { findSourceBy } from "../index/db.js";
import { HttpClient } from "../lookup/http.js";
import { serialStore } from "../import/project-queue.js";
import { InvalidInputError, ReadOnlyLibraryError } from "../repo/errors.js";
import { addCapturedOriginal, recoveryPendingProjects, type Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { SimulatedCrash, openTestRepo, seams } from "../repo/testing.js";
import { parseReference } from "./reference.js";
import { decideMatch, scoreCandidate, searchWorks } from "./search.js";
import { FindQueueFullError, appendFindEntries, readFindQueue } from "./queue-store.js";
import {
  FIND_CONCURRENCY,
  FIND_ENTRY_KEY,
  FIND_LOOKUP_TIMEOUT_MS,
  FIND_RETRY_DELAYS_MS,
  FIND_SETTINGS_TIMEOUT_MS,
  FIND_STOP_SETTLE_MS,
  FIND_TOOL,
  FIND_INDEX_WAIT_MS,
  FIND_DOWNLOAD_TIMEOUT_MS,
  FIND_SOURCE_WATCH_MS,
  cleanAcquiredAddress,
  FindAlreadyAddedError,
  FindEntryStateError,
  FindIndexNotReadyError,
  FindUnknownOptionError,
  FindProjectStoppedError,
  FindRunnerClosedError,
  createFindRunner,
  runnerSeams,
  type FindRunner,
  type FindRunnerDeps,
} from "./runner.js";
import { DEFAULT_SEARCH_SETTINGS, FIND_QUEUE_MAX, type FindEntry, type FindState, type SearchSettings } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// The world: a library with an index, made-up search services, a fake clock and fake timers.

const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const GOV = (extra = "") => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
processing:
  metadata_lookup: [crossref, openalex]
${extra}`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let handle: IndexHandle;
let repo: Repo;
let agent: MockAgent;
let gated: Gated;
let http: HttpClient;
let timers: FakeTimers;
let runners: FindRunner[];
let notes: string[];
let changes: Array<{ projectId: string; entryId: string; state: FindState }>;
let settings: SearchSettings;
/** What `deps.settings()` does (default: answers `settings`). */
let settingsFn: () => Promise<SearchSettings>;
let everything: boolean;
/** What `deps.checkEverything()` does (default: answers `everything`). */
let everythingFn: () => boolean;
/** Every search request: the service and the words it was sent. */
let asked: Array<{ service: "crossref" | "openalex"; text: string }>;
/** What each service answers for a text (default: nothing found). */
let answers: Map<string, { crossref?: unknown; openalex?: unknown }>;

class FakeTimers {
  now = NOW;
  private seq = 0;
  readonly pending = new Map<number, { fn: () => void; at: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.now) continue;
      this.pending.delete(id);
      t.fn();
    }
  }
}

/** A dispatcher that holds requests for a text until released (a service that answers late), then asks the mock. */
class Gated extends Dispatcher {
  private readonly holds = new Map<string, Promise<void>>();
  /** Every request as it was sent (before any hold). */
  readonly sent: Array<{ service: "crossref" | "openalex"; text: string }> = [];
  constructor(private readonly inner: MockAgent) {
    super();
  }
  /** Holds the requests for `text` (to one service, or to both) until the returned function is called. */
  hold(text: string, service?: "crossref" | "openalex"): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const keys = service ? [`${service}|${text}`] : [`crossref|${text}`, `openalex|${text}`];
    for (const k of keys) this.holds.set(k, gate);
    return () => {
      release();
      for (const k of keys) this.holds.delete(k);
    };
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const service = String(opts.origin).includes("crossref") ? "crossref" : "openalex";
    const text = textOf(String(opts.path)) ?? "";
    // `sent` is the works searches (F4's tests count them); F8's requests (people, a person's works, one work) are kept apart.
    if (isWorksSearch(String(opts.path))) this.sent.push({ service, text });
    else sentF8.push(String(opts.path));
    const gate = this.holds.get(`${service}|${text}`);
    if (!gate) return this.inner.dispatch(opts, handler);
    void gate.then(() => this.inner.dispatch(opts, handler));
    return true;
  }
  override close(): Promise<void> {
    return this.inner.close();
  }
  override destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

function textOf(path: string): string | undefined {
  const q = new URL(`https://x${path}`).searchParams;
  return q.get("query.bibliographic") ?? q.get("search") ?? undefined;
}
const isWorksSearch = (path: string) => path.startsWith("/works?") && !path.includes("filter=");

// Task F8: OpenAlex's people, a person's works and single works (made-up answers), and every such request.
/** What the people search answers per typed text (default: nobody); "fail" or "budget" as for the works search. */
let peopleAnswers: Map<string, unknown>;
/** A person's works (all of them, newest first; the mock pages them by 100), per person id. */
let personWorks: Map<string, unknown[]>;
/** A page that fails or meets the spent allowance: `${personId}:${page}`. */
let worksTrouble: Map<string, "fail" | "budget">;
/** Single works by id (default: 404); "fail" for a 503. */
let singleWorks: Map<string, unknown>;
let askedPeople: string[];
let askedWorks: Array<{ id: string; page: number }>;
let askedSingle: string[];
/** Every F8 request path as sent (before any hold). */
let sentF8: string[] = [];

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
const repoFor = (l: Library = lib): Promise<Repo> =>
  // The repository's clock (the lookups' clock too: OpenAlex's pause) follows the fake timers.
  openTestRepo(l, ring, { tz: "UTC", actor: "tester", scryptN: 2 ** 10, clock: () => new Date(timers.now), index: createIndexSink(handle, { root: l.root, keyRing: ring }) });
const coreOf = (r: Repo = repo) => (r as unknown as { core: RepoCore }).core;

function mockServices(): void {
  agent = new MockAgent();
  agent.disableNetConnect();
  const json = (body: unknown) => ({ statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } });
  const BUDGET = { statusCode: 429, data: JSON.stringify({ error: "Rate limit exceeded", message: "You have exceeded your daily budget." }) };
  const oa = agent.get("https://api.openalex.org");
  oa.intercept({ path: (p: string) => p.startsWith("/authors?"), method: "GET" })
    .reply((o) => {
      const text = textOf(String(o.path)) ?? "";
      askedPeople.push(text);
      const a = peopleAnswers.get(text);
      if (a === "fail") return { statusCode: 503, data: "unavailable" };
      if (a === "budget") return BUDGET;
      return json(a ?? { meta: { count: 0, page: 1, per_page: 20 }, results: [] });
    })
    .persist();
  oa.intercept({ path: (p: string) => p.startsWith("/works?") && p.includes("filter="), method: "GET" })
    .reply((o) => {
      const q = new URL(`https://x${String(o.path)}`).searchParams;
      const id = /authorships\.author\.id:(A\d+)/u.exec(q.get("filter") ?? "")?.[1] ?? "";
      const n = Number(q.get("page"));
      askedWorks.push({ id, page: n });
      const trouble = worksTrouble.get(`${id}:${n}`);
      if (trouble === "fail") return { statusCode: 503, data: "unavailable" };
      if (trouble === "budget") return BUDGET;
      const all = personWorks.get(id) ?? [];
      return json({ meta: { count: all.length, page: n, per_page: 100 }, results: all.slice((n - 1) * 100, n * 100) });
    })
    .persist();
  oa.intercept({ path: (p: string) => /^\/works\/W\d+$/u.test(p), method: "GET" })
    .reply((o) => {
      const id = String(o.path).slice("/works/".length);
      askedSingle.push(id);
      const w = singleWorks.get(id);
      if (w === "fail") return { statusCode: 503, data: "unavailable" };
      if (w === "budget") return BUDGET;
      return w ? json(w) : { statusCode: 404, data: JSON.stringify({ error: "not found" }) };
    })
    .persist();
  for (const service of ["crossref", "openalex"] as const) {
    agent
      .get(service === "crossref" ? "https://api.crossref.org" : "https://api.openalex.org")
      .intercept({ path: (p: string) => isWorksSearch(p), method: "GET" })
      .reply((o) => {
        const text = textOf(String(o.path)) ?? "";
        asked.push({ service, text });
        const a = answers.get(text)?.[service];
        if (a === "fail") return { statusCode: 503, data: "unavailable" };
        // OpenAlex's free daily allowance is spent (F2 pauses OpenAlex until 00:00 UTC by the client's clock).
        if (a === "budget") return { statusCode: 429, data: JSON.stringify({ error: "Rate limit exceeded", message: "You have exceeded your daily budget." }) };
        const body = a ?? (service === "crossref" ? cr() : OA_EMPTY);
        return { statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .persist();
  }
  gated = new Gated(agent);
  let httpNow = NOW;
  http = new HttpClient({
    libraryRoot: lib.root,
    dispatcher: gated,
    // The client's clock moves with the fake timers too (its own waits add to it).
    clock: () => httpNow + (timers.now - NOW),
    sleep: async (ms) => {
      httpNow += ms;
    },
    env: {},
    maxRetries: 0,
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-runner-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  handle = new IndexHandle(lib.root);
  timers = new FakeTimers();
  repo = await repoFor();
  runners = [];
  notes = [];
  changes = [];
  asked = [];
  answers = new Map();
  peopleAnswers = new Map();
  personWorks = new Map();
  worksTrouble = new Map();
  singleWorks = new Map();
  askedPeople = [];
  askedWorks = [];
  askedSingle = [];
  sentF8 = [];
  // The record part (F4, F8) is tested with every free-copy service off (F11 tests the copy part with its own settings).
  settings = { ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: false })) };
  settingsFn = async () => settings;
  everythingFn = () => everything;
  everything = false;
  mockServices();
});
afterEach(async () => {
  for (const r of runners) await r.stopAll();
  seams.crashAt = undefined;
  seams.failAuditAppendFor = undefined;
  seams.failUndo = undefined;
  runnerSeams.beforeCreate = undefined;
  runnerSeams.afterCreate = undefined;
  runnerSeams.inAct = undefined;
  runnerSeams.inCreate = undefined;
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

function runner(extra: Partial<FindRunnerDeps> = {}): FindRunner {
  const r = createFindRunner({
    repo,
    index: handle.db,
    http,
    settings: () => settingsFn(),
    checkEverything: () => everythingFn(),
    now: () => new Date(timers.now),
    onChange: (e) => changes.push(e),
    timers,
    debug: (n) => notes.push(n),
    ...extra,
  });
  runners.push(r);
  return r;
}

const project = async (o: { encrypted?: boolean; gov?: string; name?: string } = {}): Promise<Project> =>
  (
    await repo.createProject({
      name: o.name ?? `P${Math.random().toString(36).slice(2, 7)}`,
      governanceYaml: o.gov ?? GOV(),
      encryption: o.encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
    })
  ).project;

// Made-up works in the services' shapes (10.5555 is a test prefix; the people are invented).
type Work = { doi?: string; title: string; family: string; given?: string; year: number; type?: string; noContainer?: boolean };
const crItem = (w: Work) => ({
  ...(w.doi ? { DOI: w.doi } : {}),
  type: w.type ?? "journal-article",
  title: [w.title],
  author: [{ given: w.given ?? "Mirabel", family: w.family }],
  issued: { "date-parts": [[w.year]] },
  ...(w.noContainer ? {} : { "container-title": ["Journal of Invented Studies"] }),
});
const cr = (...ws: Work[]) => ({ status: "ok", "message-type": "work-list", message: { "total-results": ws.length, items: ws.map(crItem) } });
const OA_EMPTY = { meta: { count: 0, page: 1, per_page: 5 }, results: [] };

const ZORBLATT: Work = { doi: "10.5555/ao.f4.zorblatt", title: "Zorblatt Grammar of Habitus", family: "Quillfeather", year: 1999 };
const LINE = "Quillfeather, Zorblatt Grammar of Habitus, 1999";
const LINE_2 = "Zorblatt Grammar of Habitus by Quillfeather 1999";
const know = (line: string, crossref: unknown, openalex?: unknown) => answers.set(parseReference(line)!.text, { crossref, ...(openalex !== undefined ? { openalex } : {}) });

const queue = (p: Project, r: Repo = repo) => readFindQueue(coreOf(r), p.id);
async function entryOf(p: Project, id: string, r: Repo = repo): Promise<FindEntry | undefined> {
  return (await queue(p, r)).get(id);
}
/** Real waiting for real file work (never for a delay of the runner: those run on the fake timers). */
async function until(what: () => Promise<boolean> | boolean, label = "condition"): Promise<void> {
  const end = Date.now() + 15_000;
  while (!(await what())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const FINAL: FindState[] = ["choose", "already", "maybe-duplicate", "record-complete", "not-found", "failed"];
const settled = (p: Project, id: string, r: Repo = repo) => until(async () => FINAL.includes((await entryOf(p, id, r))?.state ?? "looking-up"), "the entry to settle");
const sourcesOf = async (p: Project, r: Repo = repo) => Promise.all(r.listSourceIds(p.id).map((id) => r.getSource(p.id, id)));

async function everythingUnder(dir: string): Promise<string> {
  let out = "";
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, d.name);
    out += d.name + "\n";
    if (d.isDirectory()) out += await everythingUnder(full);
    else out += (await readFile(full)).toString("latin1") + "\n";
  }
  return out;
}
const auditText = (p: Project) => everythingUnder(join(lib.root, p.folder, "audit"));
const txnMarkers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));

/** A source made in the project as another way in would make it (a drag-and-drop import: its own duplicate check in its turn). */
async function importLikeAttach(p: Project, w: Work, holdInTurn?: () => Promise<void>): Promise<void> {
  await serialStore(repo, p.id, async () => {
    await holdInTurn?.();
    const keys = [];
    for (const id of repo.listSourceIds(p.id)) {
      const s = await repo.getSourceRecord(p.id, id);
      keys.push({ sourceId: id, sha256s: [], ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}) });
    }
    if (findDuplicate({ sha256s: [], ...(w.doi ? { doi: w.doi } : {}) }, keys)) return;
    await repo.createSource(p.id, draftOf(w), [], {
      provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "drag-and-drop", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
    });
  });
}
const draftOf = (w: Work, title = w.title): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [{ role: "author", family: w.family, given: w.given ?? "Mirabel" }],
  issued: String(w.year),
  identifiers: w.doi ? { doi: w.doi } : {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});

// ---------------------------------------------------------------------------------------------------------------

describe("the made-up services behave as the rule says (a guard for the tests below)", () => {
  it("both typed lines are sure of Zorblatt", async () => {
    know(LINE, cr(ZORBLATT));
    const policy = { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: ["crossref", "openalex"] } };
    const ref = parseReference(LINE)!;
    const { candidates } = await searchWorks(ref, { http, policy, projectId: "x", actor: "t", sensitive: false }, { sources: ["crossref", "openalex"] });
    expect(decideMatch(ref, candidates).kind).toBe("sure");
    expect(decideMatch(parseReference(LINE_2)!, candidates).kind).toBe("sure");
  });
});

describe("a typed line becomes a record", () => {
  it("a sure match creates one source with provenance reference_lookup and no file", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added, mergedLines } = await r.add(p.id, [LINE]);
    expect(mergedLines).toBe(0);
    expect(added).toHaveLength(1);
    expect(added[0]!.state).toBe("looking-up");
    await settled(p, added[0]!.id);
    // The event is sent once the change is committed (its audit included).
    await until(() => changes.some((c) => c.entryId === added[0]!.id && c.state === "record-complete"), "the event");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("record-complete");
    const [sf, ...more] = await sourcesOf(p);
    expect(more).toEqual([]);
    expect(e.sourceId).toBe(sf!.source.id);
    expect(e.duplicateOf).toBeUndefined();
    expect(e.elsewhere).toBeUndefined();
    expect(sf!.assets).toEqual([]);
    const prov = sf!.source.provenance;
    expect(prov.captureMethod).toBe("reference_lookup");
    expect(prov.tool.name).toBe(FIND_TOOL);
    expect(prov.identification?.method).toBe("find-match");
    expect(prov.identification!.confidence).toBeGreaterThan(0.9);
    expect(prov.externalKeys?.[FIND_ENTRY_KEY]).toBe(e.id);
    expect(prov.fileHashes).toEqual({});
    expect(sf!.source.identifiers.doi).toBe(ZORBLATT.doi);
    expect(sf!.source.creators[0]?.family).toBe("Quillfeather");
    expect(sf!.source.issued).toBe("1999");
    expect(sf!.fieldEvidence.length).toBeGreaterThan(0);
    expect(sf!.fieldEvidence.every((f) => f.source.kind === "lookup" && f.source.provider === "crossref")).toBe(true);
    // The creation is audited as source.create; the queue changes as project.find.*; nothing typed in either.
    const audit = await auditText(p);
    expect(audit).toContain('"source.create"');
    expect(audit).toContain('"project.find.add"');
    expect(audit).toContain('"project.find.update"');
    expect(audit).not.toMatch(/Zorblatt|Quillfeather|Habitus/u);
    expect(changes.filter((c) => c.entryId === e.id).map((c) => c.state)).toEqual(["looking-up", "record-complete"]);
  });

  it("identical normalised lines in one Add give one entry; a bad line or more than 50 lines are refused with nothing written", async () => {
    const p = await project();
    const r = runner();
    const { added, mergedLines } = await r.add(p.id, ["Quillfeather, Zorblatt", "quillfeather   zorblatt", "", "Other words here"]);
    expect(added).toHaveLength(2);
    expect(mergedLines).toBe(1);
    await expect(r.add(p.id, ["x"])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(r.add(p.id, ["a".repeat(501)])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(r.add(p.id, Array.from({ length: 51 }, (_, i) => `line number ${i} here`))).rejects.toBeInstanceOf(InvalidInputError);
    await expect(r.add(p.id, ["ok line", "y"])).rejects.toBeInstanceOf(InvalidInputError);
    expect((await queue(p)).size).toBe(2);
    // The error never echoes what was typed.
    const err = (await r.add(p.id, ["SECRETWORDqz", "y"]).catch((e: unknown) => e)) as Error;
    expect(String(err.message)).not.toContain("SECRETWORDqz");
  });

  it("a full queue: FindQueueFullError is passed on as it is", async () => {
    const p = await project();
    const r = runner();
    const many: FindEntry[] = Array.from({ length: FIND_QUEUE_MAX }, (_, i) => ({
      id: newId(),
      projectId: p.id,
      typed: `already here ${i}`,
      state: "not-found" as const,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      attempts: 0,
    }));
    await appendFindEntries(coreOf(), p.id, many, "add");
    await expect(r.add(p.id, ["one more line"])).rejects.toBeInstanceOf(FindQueueFullError);
  });

  it("several works fit: Choose; the researcher's choice makes the record (find-chosen); None of these: Not found", async () => {
    const other: Work = { doi: "10.5555/ao.f4.zorblatt.2", title: "Zorblatt Grammar of Habitus Revisited", family: "Quillfeather", year: 2001 };
    know("Quillfeather, Zorblatt Grammar", cr(ZORBLATT, other));
    know("Quillfeather, Zorblatt", cr(ZORBLATT, other));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Quillfeather, Zorblatt Grammar", "Quillfeather, Zorblatt"]);
    for (const a of added) await settled(p, a.id);
    const [e1, e2] = [(await entryOf(p, added[0]!.id))!, (await entryOf(p, added[1]!.id))!];
    expect(e1.state).toBe("choose");
    expect(e1.candidates!.length).toBeGreaterThanOrEqual(2);
    expect(await sourcesOf(p)).toEqual([]);
    const pick = e1.candidates!.find((c) => c.identifiers.doi === other.doi)!;
    const done = await r.choose(p.id, e1.id, pick.id);
    expect(done.state).toBe("record-complete");
    expect(done.chosen).toBe(pick.id);
    const [sf] = await sourcesOf(p);
    expect(sf!.source.identifiers.doi).toBe(other.doi);
    expect(sf!.source.provenance.identification?.method).toBe("find-chosen");
    expect(done.sourceId).toBe(sf!.source.id);
    const none = await r.choose(p.id, e2.id, null);
    expect(none.state).toBe("not-found");
    expect(await sourcesOf(p)).toHaveLength(1);
    await expect(r.choose(p.id, e1.id, "w-not-a-candidate")).rejects.toBeInstanceOf(FindEntryStateError);
  });

  it("nothing scores, every service answered: Not found", async () => {
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Weber, Nothing Anywhere"]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("not-found");
  });

  it("a likely duplicate asks; Not the same makes the record, The same says Already in your library", async () => {
    const p = await project();
    // The project already holds the work without a DOI: the same title, author and year.
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], {
      provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "t", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
    });
    const [existing] = await sourcesOf(p);
    know(LINE, cr(ZORBLATT));
    know(LINE_2, cr(ZORBLATT));
    const r = runner();
    const { added } = await r.add(p.id, [LINE, LINE_2]);
    for (const a of added) await settled(p, a.id);
    for (const a of added) {
      const e = (await entryOf(p, a.id))!;
      expect(e.state).toBe("maybe-duplicate");
      expect(e.duplicateOf).toBe(existing!.source.id);
    }
    const same = await r.confirmDuplicate(p.id, added[0]!.id, true);
    expect(same.state).toBe("already");
    expect(same.duplicateOf).toBe(existing!.source.id);
    const notSame = await r.confirmDuplicate(p.id, added[1]!.id, false);
    expect(notSame.state).toBe("record-complete");
    expect(await sourcesOf(p)).toHaveLength(2);
    await expect(r.confirmDuplicate(p.id, added[1]!.id, false)).rejects.toBeInstanceOf(FindEntryStateError);
  });

  it("a collection that is gone: the record is still made, and the entry no longer names it", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const c = await repo.createCollection(p.id, "Soon gone");
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const { added } = await r.add(p.id, [LINE], c.id);
    expect(added[0]!.collectionId).toBe(c.id);
    await until(() => gated.sent.length > 0, "the lookup to start");
    await repo.deleteCollection(p.id, c.id);
    release();
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("record-complete");
    expect(e.collectionId).toBeUndefined();
    const [sf] = await sourcesOf(p);
    expect(sf!.source.collectionIds).toEqual([]);
  });

  it("a collection that still exists: the record is put into it", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const c = await repo.createCollection(p.id, "Reading list");
    const r = runner();
    const { added } = await r.add(p.id, [LINE], c.id);
    await settled(p, added[0]!.id);
    const [sf] = await sourcesOf(p);
    expect(sf!.source.collectionIds).toEqual([c.id]);
    expect((await entryOf(p, added[0]!.id))!.collectionId).toBe(c.id);
  });

  it("remove keeps the source", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    const [sf] = await sourcesOf(p);
    await r.remove(p.id, added[0]!.id);
    expect((await queue(p)).has(added[0]!.id)).toBe(false);
    expect((await repo.getSource(p.id, sf!.source.id)).source.id).toBe(sf!.source.id);
    expect(await sourcesOf(p)).toHaveLength(1);
  });
});

describe("one work, one source: under every race", () => {
  it("two entries for one DOI, run together, create one source; the other says Already in your library", async () => {
    know(LINE, cr(ZORBLATT));
    know(LINE_2, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE, LINE_2]);
    for (const a of added) await settled(p, a.id);
    const es = await Promise.all(added.map(async (a) => (await entryOf(p, a.id))!));
    const sources = await sourcesOf(p);
    expect(sources).toHaveLength(1);
    const made = es.find((e) => e.state === "record-complete")!;
    const already = es.find((e) => e.state === "already")!;
    expect(made.sourceId).toBe(sources[0]!.source.id);
    expect(already.duplicateOf).toBe(sources[0]!.source.id);
    expect(already.sourceId).toBeUndefined();
    expect(already.elsewhere).toBeUndefined();
  });

  it("the same line added twice in two quick calls: one source, the other entry Already", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const [a, b] = await Promise.all([r.add(p.id, [LINE]), r.add(p.id, [LINE])]);
    await settled(p, a.added[0]!.id);
    await settled(p, b.added[0]!.id);
    expect(await sourcesOf(p)).toHaveLength(1);
    const states = [(await entryOf(p, a.added[0]!.id))!.state, (await entryOf(p, b.added[0]!.id))!.state].sort();
    expect(states).toEqual(["already", "record-complete"]);
  });

  it("an import holding the store turn while the entry's answer comes: the import makes the source, the entry says Already (M6)", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    let releaseImport!: () => void;
    const importHeld = new Promise<void>((res) => (releaseImport = res));
    let inTurn = false;
    // The import takes the turn first and holds it (as an import does while it copies a file).
    const imported = importLikeAttach(p, ZORBLATT, async () => {
      inTurn = true;
      await importHeld;
    });
    await until(() => inTurn, "the import to hold the turn");
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup");
    await new Promise((res) => setTimeout(res, 50)); // the entry's answer is in and its completion waits for the turn
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
    releaseImport();
    await imported;
    await settled(p, added[0]!.id);
    const sources = await sourcesOf(p);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.source.provenance.captureMethod).toBe("manual_upload");
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "already", duplicateOf: sources[0]!.source.id });
  });

  it("an import that starts while the entry is creating its record: the entry makes the source, the import sees it (M6)", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    let creating!: () => void;
    const atCreation = new Promise<void>((res) => (creating = res));
    // Inside the runner's turn, just before the creation, the import of the same DOI starts (from outside that turn:
    // the store's queue is re-entrant for work started inside a turn).
    runnerSeams.beforeCreate = () => creating();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await atCreation;
    const imported = importLikeAttach(p, ZORBLATT);
    await imported;
    await settled(p, added[0]!.id);
    const sources = await sourcesOf(p);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.source.provenance.captureMethod).toBe("reference_lookup");
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "record-complete", sourceId: sources[0]!.source.id });
  });

  it("choose pressed twice: one source", async () => {
    const other: Work = { doi: "10.5555/ao.f4.zorblatt.2", title: "Zorblatt Grammar of Habitus Revisited", family: "Quillfeather", year: 2001 };
    know("Quillfeather, Zorblatt Grammar", cr(ZORBLATT, other));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Quillfeather, Zorblatt Grammar"]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    const pick = e.candidates![0]!.id;
    const [x, y] = await Promise.all([r.choose(p.id, e.id, pick), r.choose(p.id, e.id, pick)]);
    expect(await sourcesOf(p)).toHaveLength(1);
    expect(x.state).toBe("record-complete");
    expect(y).toEqual(x);
  });

  it("choose racing remove: at most one source, and the queue says the truth", async () => {
    const other: Work = { doi: "10.5555/ao.f4.zorblatt.2", title: "Zorblatt Grammar of Habitus Revisited", family: "Quillfeather", year: 2001 };
    know("Quillfeather, Zorblatt Grammar", cr(ZORBLATT, other));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Quillfeather, Zorblatt Grammar"]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    const results = await Promise.allSettled([r.choose(p.id, e.id, e.candidates![0]!.id), r.remove(p.id, e.id)]);
    expect(results[1].status).toBe("fulfilled");
    expect((await queue(p)).has(e.id)).toBe(false);
    const sources = await sourcesOf(p);
    if (results[0].status === "fulfilled") {
      expect(sources).toHaveLength(1);
      expect(results[0].value.sourceId).toBe(sources[0]!.source.id);
    } else expect(sources).toHaveLength(0);
  });

  it("retry racing the runner's own retry timer: one lookup's result, one source", async () => {
    know(LINE, "fail", "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(async () => (await entryOf(p, added[0]!.id))?.attempts === 1, "the first failure");
    know(LINE, cr(ZORBLATT));
    await Promise.all([r.retry(p.id, added[0]!.id), Promise.resolve().then(() => timers.advance(FIND_RETRY_DELAYS_MS[0]!))]);
    await settled(p, added[0]!.id);
    await new Promise((res) => setTimeout(res, 50));
    expect(await sourcesOf(p)).toHaveLength(1);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("add while the runner is mid-entry: each line keeps its own entry, one source per work", async () => {
    know(LINE, cr(ZORBLATT));
    know(LINE_2, cr(ZORBLATT));
    const p = await project();
    // OpenAlex holds the first line's answer (Crossref takes one request at a time, so it is not the one held).
    const release = gated.hold(parseReference(LINE)!.text, "openalex");
    const r = runner();
    const first = await r.add(p.id, [LINE]);
    await until(() => gated.sent.some((x) => x.service === "openalex"), "the first line's lookup");
    const second = await r.add(p.id, [LINE_2]);
    await settled(p, second.added[0]!.id);
    release();
    await settled(p, first.added[0]!.id);
    expect(await sourcesOf(p)).toHaveLength(1);
    const states = [(await entryOf(p, first.added[0]!.id))!.state, (await entryOf(p, second.added[0]!.id))!.state].sort();
    expect(states).toEqual(["already", "record-complete"]);
  });
});

describe("crashes are healed by adoption, never by a second source", () => {
  const reopen = async (p: Project, encrypted: boolean) => {
    for (const r of runners) await r.stopAll();
    runners = [];
    handle.close();
    await lib.close();
    // The lookup cache goes too (a new process has a new client), so that "no lookup" below means no request was made.
    await rm(join(lib.root, ".cache"), { recursive: true, force: true });
    lib = await openLibrary(lib.root, mkDeps());
    await agent.close();
    mockServices();
    handle = new IndexHandle(lib.root);
    repo = await repoFor();
    if (encrypted) await repo.unlockProject(p.id, "pw");
  };

  for (const encrypted of [false, true]) {
    it(`a crash before the creation: no source; resume makes exactly one (${encrypted ? "sealed" : "plain"})`, async () => {
      know(LINE, cr(ZORBLATT));
      const p = await project({ encrypted });
      runnerSeams.beforeCreate = () => {
        seams.crashAt = "before-audit";
      };
      const r = runner();
      const { added } = await r.add(p.id, [LINE]);
      await until(() => notes.some((n) => n.includes("SimulatedCrash")), "the crash");
      runnerSeams.beforeCreate = undefined;
      expect(await txnMarkers()).toHaveLength(1);
      await reopen(p, encrypted);
      expect(await sourcesOf(p)).toEqual([]);
      expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
      runner().resume(p.id);
      await settled(p, added[0]!.id);
      const sources = await sourcesOf(p);
      expect(sources).toHaveLength(1);
      expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "record-complete", sourceId: sources[0]!.source.id });
    });

    it(`a crash between the creation and the entry's line: resume adopts the source, without a lookup and never as Already (${encrypted ? "sealed" : "plain"})`, async () => {
      know(LINE, cr(ZORBLATT));
      const p = await project({ encrypted });
      runnerSeams.afterCreate = () => {
        throw new SimulatedCrash("simulated crash after the creation");
      };
      const r = runner();
      const { added } = await r.add(p.id, [LINE]);
      await until(() => notes.some((n) => n.includes("SimulatedCrash")), "the crash");
      runnerSeams.afterCreate = undefined;
      await reopen(p, encrypted);
      const made = await sourcesOf(p);
      expect(made).toHaveLength(1);
      expect(made[0]!.source.provenance.externalKeys?.[FIND_ENTRY_KEY]).toBe(added[0]!.id);
      expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
      const sentBefore = gated.sent.length;
      runner().resume(p.id);
      await settled(p, added[0]!.id);
      expect(gated.sent.length).toBe(sentBefore);
      expect(await sourcesOf(p)).toHaveLength(1);
      expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "record-complete", sourceId: made[0]!.source.id });
    });

    it(`a crash after the entry's line: the record and the entry stand; resume does nothing (${encrypted ? "sealed" : "plain"})`, async () => {
      know(LINE, cr(ZORBLATT));
      const p = await project({ encrypted });
      runnerSeams.afterCreate = () => {
        seams.crashAt = "before-marker-delete";
      };
      const r = runner();
      const { added } = await r.add(p.id, [LINE]);
      await until(() => notes.some((n) => n.includes("SimulatedCrash")), "the crash");
      runnerSeams.afterCreate = undefined;
      await reopen(p, encrypted);
      const made = await sourcesOf(p);
      expect(made).toHaveLength(1);
      expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "record-complete", sourceId: made[0]!.source.id });
      const sentBefore = gated.sent.length;
      runner().resume(p.id);
      await new Promise((res) => setTimeout(res, 100));
      expect(gated.sent.length).toBe(sentBefore);
      expect(await sourcesOf(p)).toHaveLength(1);
    });
  }

  it("a crash during looking-up resumes it at open", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await reopen(p, false);
    release();
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
    runner().resume(p.id);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
    expect(await sourcesOf(p)).toHaveLength(1);
  });
});

describe("Already in your library, in another project", () => {
  const SECRET_TITLE = "Hidden Fieldnotes Qxvbn";
  const SECRET_NAME = "Secretproj Pzzk";

  for (const here of [false, true]) {
    it(`a match in another unlocked project stores only elsewhere: true; the queue file and audit hold no id or title from it (this project ${here ? "encrypted" : "plain"})`, async () => {
      const other = await project({ encrypted: true, name: SECRET_NAME });
      await repo.createSource(other.id, draftOf(ZORBLATT, SECRET_TITLE), [], {
        provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "t", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
      });
      const [theirs] = await sourcesOf(other);
      const p = await project({ encrypted: here });
      know(LINE, cr(ZORBLATT));
      everything = true;
      const r = runner();
      const { added } = await r.add(p.id, [LINE]);
      await settled(p, added[0]!.id);
      const e = (await entryOf(p, added[0]!.id))!;
      expect(e.state).toBe("already");
      expect(e.elsewhere).toBe(true);
      expect(e.duplicateOf).toBeUndefined();
      expect(e.sourceId).toBeUndefined();
      expect(await sourcesOf(p)).toEqual([]);
      const raw = await everythingUnder(join(lib.root, p.folder));
      for (const s of [theirs!.source.id, other.id, SECRET_TITLE, "Qxvbn", SECRET_NAME, "Pzzk", other.folder]) expect(raw).not.toContain(s);
      expect(JSON.stringify(e)).not.toContain(theirs!.source.id);
      expect(notes.join("\n")).not.toContain(theirs!.source.id);
      // Where it is is worked out again at request time, ids only.
      expect(await r.elsewhere(p.id, e.id)).toEqual({ projectId: other.id, sourceId: theirs!.source.id });
      expect(r.lockedNotChecked()).toBe(0);
      // "Add it to this project as well": this project's own record, from the candidate the entry holds.
      const here2 = await r.addHereAsWell(p.id, e.id);
      expect(here2.state).toBe("record-complete");
      const [mine] = await sourcesOf(p);
      expect(here2.sourceId).toBe(mine!.source.id);
      expect(mine!.source.title.variants[0]!.value).toBe(ZORBLATT.title);
      const raw2 = await everythingUnder(join(lib.root, p.folder));
      for (const s of [theirs!.source.id, other.id, SECRET_TITLE, SECRET_NAME]) expect(raw2).not.toContain(s);
      expect(await sourcesOf(other)).toHaveLength(1);
    });
  }

  it("off: only the entry's own project counts", async () => {
    const other = await project();
    await repo.createSource(other.id, draftOf(ZORBLATT), [], {
      provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "t", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
    });
    const p = await project();
    know(LINE, cr(ZORBLATT));
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("a locked project is not looked into and is counted", async () => {
    const other = await project({ encrypted: true, name: SECRET_NAME });
    await repo.createSource(other.id, draftOf(ZORBLATT, SECRET_TITLE), [], {
      provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "t", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
    });
    expect(findSourceBy(handle.db, { doi: ZORBLATT.doi! }).map((s) => s.projectId)).toEqual([other.id]);
    repo.lockProject(other.id);
    // Locked: its record is not in the index (only manifest-level rows, R30).
    expect(findSourceBy(handle.db, { doi: ZORBLATT.doi! })).toEqual([]);
    const p = await project();
    know(LINE, cr(ZORBLATT));
    everything = true;
    const r = runner();
    expect(r.lockedNotChecked()).toBe(1);
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("record-complete");
    expect(e.elsewhere).toBeUndefined();
    expect(r.lockedNotChecked()).toBe(1);
    expect(await r.elsewhere(p.id, e.id)).toBeNull();
  });
});

describe("the rules decide, and fail closed; settings only narrow", () => {
  it("rules without reference_lookup: failed, by rules, nothing created", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project({ gov: GOV("acquireMethods: [free_copy]") });
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "not-allowed", by: "rules" } });
    expect(await sourcesOf(p)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("rules that no longer allow it when the record is made: failed, by rules, the refusal audited, nothing created", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup to be sent");
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, GOV("acquireMethods: [free_copy]"), { baseSha256: sha256 });
    release();
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "not-allowed", by: "rules" } });
    expect(await sourcesOf(p)).toEqual([]);
    // The creation's own governed check refused it, and the refusal is audited (as the capture it would have been).
    const audit = await auditText(p);
    expect(audit).toMatch(/"action":"capture"[^\n]*"result":"deny"/u);
    expect(audit).not.toMatch(/Zorblatt|Quillfeather/u);
  });

  it("rules that cannot be read refuse: nothing is asked and nothing created", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const id = newId();
    await appendFindEntries(coreOf(), p.id, [{ id, projectId: p.id, typed: LINE, state: "looking-up", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 }], "add");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(lib.root, p.folder, "governance.yaml"), "acquireMethods: [downloader]\n: : not yaml\n");
    const r = runner();
    r.resume(p.id);
    await until(() => r.stoppedFor(p.id) !== null, "the refusal");
    await new Promise((res) => setTimeout(res, 50));
    expect(gated.sent).toEqual([]);
    expect(await sourcesOf(p)).toEqual([]);
    expect((await entryOf(p, id))!.state).toBe("looking-up");
  });

  it("a lookup service the rules refuse is not asked", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project({ gov: GOV().replace("[crossref, openalex]", "[openalex]") });
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect(asked.map((a) => a.service)).toEqual(["openalex"]);
  });

  it("no lookup service allowed by the rules: failed, by rules, nothing asked", async () => {
    const p = await project({ gov: GOV().replace("[crossref, openalex]", "[]") });
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "not-allowed", by: "rules" } });
    expect(asked).toEqual([]);
  });

  it("settings that switch every source off: failed, by settings", async () => {
    settings = { record: DEFAULT_SEARCH_SETTINGS.record.map((s) => ({ ...s, on: false })) };
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "switched-off", by: "settings" } });
    expect(asked).toEqual([]);
  });

  it("a source switched off in the settings is not asked", async () => {
    settings = { record: DEFAULT_SEARCH_SETTINGS.record.map((s) => (s.id === "openalex" ? { ...s, on: false } : s)) };
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect(asked.map((a) => a.service)).toEqual(["crossref"]);
  });
});

describe("failures are told truthfully and retried politely", () => {
  it("retries follow the delays with a fake clock and then fail as unreachable; Try again starts again", async () => {
    know(LINE, "fail", "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    const id = added[0]!.id;
    // The entry's line is visible a moment before its retry timer is set: wait for both.
    await until(async () => (await entryOf(p, id))?.attempts === 1 && timers.pending.size === 1, "the first failure");
    let e = (await entryOf(p, id))!;
    expect(e.state).toBe("looking-up");
    expect(e.nextTryAt).toBe(new Date(timers.now + FIND_RETRY_DELAYS_MS[0]!).toISOString());
    for (let i = 0; i < FIND_RETRY_DELAYS_MS.length; i++) {
      const before = asked.length;
      timers.advance(FIND_RETRY_DELAYS_MS[i]! - 1);
      await new Promise((res) => setTimeout(res, 30));
      expect(asked.length).toBe(before);
      timers.advance(1);
      const last = i === FIND_RETRY_DELAYS_MS.length - 1;
      await until(async () => (await entryOf(p, id))!.attempts === i + 2 && timers.pending.size === (last ? 0 : 1), `attempt ${i + 2}`);
    }
    e = (await entryOf(p, id))!;
    expect(e).toMatchObject({ state: "failed", reason: { code: "unreachable" } });
    expect(e.nextTryAt).toBeUndefined();
    expect(timers.pending.size).toBe(0);
    know(LINE, cr(ZORBLATT));
    const again = await r.retry(p.id, id);
    expect(again).toMatchObject({ state: "looking-up", attempts: 0 });
    expect(again.reason).toBeUndefined();
    await settled(p, id);
    expect((await entryOf(p, id))!.state).toBe("record-complete");
  });

  it("one service failing does not fail an entry that still got candidates, but a partial answer never completes a record by itself: Choose (M4)", async () => {
    know(LINE, cr(ZORBLATT), "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("choose");
    expect(e.candidates!.map((c) => c.identifiers.doi)).toEqual([ZORBLATT.doi]);
    expect(e.reason).toBeUndefined();
    expect(await sourcesOf(p)).toEqual([]);
  });

  it("the only source the rules leave answered: the list is complete, and a sure match completes the record (M4)", async () => {
    know(LINE, cr(ZORBLATT), "fail");
    const p = await project({ gov: GOV().replace("[crossref, openalex]", "[crossref]") });
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("the only source the settings leave answered: the list is complete (M4)", async () => {
    settings = { record: DEFAULT_SEARCH_SETTINGS.record.map((s) => (s.id === "openalex" ? { ...s, on: false } : s)) };
    know(LINE, cr(ZORBLATT), "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("one service failing and the other finding nothing is not Not found: it is tried again", async () => {
    know(LINE, cr(), "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(async () => (await entryOf(p, added[0]!.id))?.attempts === 1, "the first failure");
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
  });

  it(`at most ${FIND_CONCURRENCY} entries at once; one project's fifty lines do not starve another's one`, async () => {
    const a = await project();
    const b = await project();
    const lines = Array.from({ length: 50 }, (_, i) => `Villages of the upland number ${i} study`);
    const releases = lines.map((l) => gated.hold(parseReference(l)!.text));
    const r = runner();
    await r.add(a.id, lines);
    // The cap (M5): with fifty lines waiting, exactly two lines are being looked up.
    await until(() => new Set(gated.sent.filter((x) => x.service === "openalex").map((x) => x.text)).size >= 2, "two lookups");
    await new Promise((res) => setTimeout(res, 100));
    expect(new Set(gated.sent.map((x) => x.text)).size).toBe(FIND_CONCURRENCY);
    know("Lindqvist, Rivers of Memory", cr());
    await r.add(b.id, ["Lindqvist, Rivers of Memory"]);
    // B's line is asked as soon as a place frees, before A's third line.
    releases[0]!();
    releases[1]!();
    await until(() => asked.some((x) => x.text === "Lindqvist, Rivers of Memory"), "B's line to be asked");
    const crossrefTexts = asked.filter((x) => x.service === "crossref").map((x) => x.text);
    expect(crossrefTexts.indexOf("Lindqvist, Rivers of Memory")).toBeLessThanOrEqual(FIND_CONCURRENCY);
    for (const rel of releases) rel();
  });
});

describe("stopping is immediate and clean", () => {
  it("lock stops the runner; nothing is written while locked", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project({ encrypted: true });
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup to be sent");
    const queueBytes = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    const auditBefore = await auditText(p);
    r.stop(p.id);
    repo.lockProject(p.id);
    release();
    await new Promise((res) => setTimeout(res, 100));
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(queueBytes);
    expect(await auditText(p)).toBe(auditBefore);
    r.resume(p.id); // still locked: starts nothing
    await new Promise((res) => setTimeout(res, 50));
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(queueBytes);
    await repo.unlockProject(p.id, "pw");
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
    r.resume(p.id);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("a lookup that answers after the stop writes nothing", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup to be sent");
    const queueBytes = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    r.stop(p.id);
    release();
    await until(() => asked.length >= 2, "the late answer");
    await new Promise((res) => setTimeout(res, 100));
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(queueBytes);
    expect(await sourcesOf(p)).toEqual([]);
  });

  it("stopAll settles at once with a lookup in flight, and leaves no timer behind", async () => {
    know(LINE, "fail", "fail");
    know(LINE_2, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(async () => (await entryOf(p, added[0]!.id))?.attempts === 1 && timers.pending.size === 1, "a retry timer");
    const release = gated.hold(parseReference(LINE_2)!.text);
    await r.add(p.id, [LINE_2]);
    await until(() => gated.sent.some((x) => x.text === parseReference(LINE_2)!.text), "the second lookup to be sent");
    const t0 = Date.now();
    await r.stopAll();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(timers.pending.size).toBe(0);
    release();
    await new Promise((res) => setTimeout(res, 50));
    expect(await sourcesOf(p)).toEqual([]);
  });

  it("a read-only library starts nothing", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    await appendFindEntries(coreOf(), p.id, [
      { id: newId(), projectId: p.id, typed: LINE, state: "looking-up", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 },
    ], "add");
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    const r = runner({ repo: ro });
    r.resume(p.id);
    await new Promise((res) => setTimeout(res, 100));
    expect(asked).toEqual([]);
    await expect(r.add(p.id, [LINE_2])).rejects.toBeInstanceOf(ReadOnlyLibraryError);
  });

  it("an unreadable queue stops the runner for that project with nothing written", async () => {
    const p = await project();
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(lib.root, p.folder, "find"), { recursive: true });
    await writeFile(join(lib.root, p.folder, "find", "queue.jsonl"), "not json at all\n");
    const r = runner();
    r.resume(p.id);
    await new Promise((res) => setTimeout(res, 50));
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"), "utf8")).toBe("not json at all\n");
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 1 (R237)

const GDPR = (basis: boolean) => `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: true
  defaultLegalBasis:
${basis ? "    refman-import: art6-1-e\n    reference-lookup: art6-1-e\n" : "    other-category: art6-1-a\n"}processing:
  metadata_lookup: [crossref, openalex]
`;
const BIB = `@article{quill1999,
  title = {Zorblatt Grammar of Habitus},
  author = {Quillfeather, Mirabel},
  year = {1999},
  journal = {Journal of Invented Studies}
}
`;

async function bibtexImport(p: Project): Promise<{ refused: boolean; sources: Awaited<ReturnType<typeof sourcesOf>> }> {
  const bib = join(tmp, `record-${p.id}.bib`);
  await writeFile(bib, BIB);
  const bulk = createBulkImport({ repo, http, index: handle });
  let refused = false;
  try {
    const h = await bulk.startBatch(p.id, bibtexAdapter(bib));
    const r = await h.done;
    refused = r.counts.failed > 0 || r.counts.created + r.counts.needsReview === 0;
  } catch {
    refused = true;
  }
  return { refused, sources: await sourcesOf(p) };
}
const plainProvenance = (captureMethod: "manual_upload" | "browser_capture" = "manual_upload") => ({
  captureMethod,
  capturedAt: new Date(NOW).toISOString(),
  tool: { name: "t", version: "0" },
  fileHashes: {},
  legal: { status: "unknown" as const },
  identifiable: false,
});

describe("R237 (a): a record made by Find and acquire is stored under the project's own rules, like every other import", () => {
  it("a GDPR-style project with identifiable data: the find record gets what a record-only BibTeX import of the same work gets", async () => {
    know(LINE, cr(ZORBLATT));
    const viaBib = await project({ gov: GDPR(true) });
    const viaFind = await project({ gov: GDPR(true) });
    const bib = await bibtexImport(viaBib);
    expect(bib.refused).toBe(false);
    const r = runner();
    const { added } = await r.add(viaFind.id, [LINE]);
    await settled(viaFind, added[0]!.id);
    expect((await entryOf(viaFind, added[0]!.id))!.state).toBe("record-complete");
    const [a] = bib.sources;
    const [b] = await sourcesOf(viaFind);
    expect(b!.source.provenance.identifiable).toBe(a!.source.provenance.identifiable);
    expect(b!.source.provenance.identifiable).toBe(true);
    expect(b!.source.provenance.legal).toEqual(a!.source.provenance.legal);
    expect(b!.source.provenance.legal).toEqual({ status: "unknown", basis: "art6-1-e" });
  });

  it("where such an import is refused (identifiable data, no legal basis), the entry is failed by the rules and nothing is created", async () => {
    know(LINE, cr(ZORBLATT));
    const viaBib = await project({ gov: GDPR(false) });
    const viaFind = await project({ gov: GDPR(false) });
    const bib = await bibtexImport(viaBib);
    expect(bib.refused).toBe(true);
    expect(bib.sources).toEqual([]);
    const r = runner();
    const { added } = await r.add(viaFind.id, [LINE]);
    await settled(viaFind, added[0]!.id);
    // N1: said as what it is, a missing legal basis (not the general refusal).
    expect((await entryOf(viaFind, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "no-legal-basis", by: "rules" } });
    expect(await sourcesOf(viaFind)).toEqual([]);
  });
});

describe("R237 (b): nothing the runner waits on can hold it for ever", () => {
  it("settings that never answer free their place after the time limit; the other place keeps working; stop and stopAll settle; the library can close", async () => {
    const lines = ["Okafor, Never answered one", "Okafor, Never answered two", "Okafor, Third line goes on"];
    let calls = 0;
    settingsFn = () => (++calls <= 2 ? new Promise<SearchSettings>(() => {}) : Promise.resolve(settings));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, lines);
    await until(() => calls === 2, "both places to wait on the settings");
    await new Promise((res) => setTimeout(res, 50));
    expect(gated.sent).toEqual([]);
    expect((await entryOf(p, added[2]!.id))!.state).toBe("looking-up");
    timers.advance(FIND_SETTINGS_TIMEOUT_MS);
    // The third entry gets a place and goes on; the two that waited are tried again later.
    await settled(p, added[2]!.id);
    expect((await entryOf(p, added[2]!.id))!.state).toBe("not-found");
    for (const a of added.slice(0, 2)) {
      await until(async () => (await entryOf(p, a.id))!.attempts === 1, "the retry");
      const e = (await entryOf(p, a.id))!;
      expect(e.state).toBe("looking-up");
      expect(e.nextTryAt).toBeDefined();
    }
    // Settings that never answer again: stop and stopAll still settle at once.
    settingsFn = () => {
      calls++;
      return new Promise<SearchSettings>(() => {});
    };
    timers.advance(FIND_RETRY_DELAYS_MS[0]!);
    await until(() => calls >= 5, "the retries to wait on the settings");
    r.stop(p.id);
    const t0 = Date.now();
    await r.stopAll();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(timers.pending.size).toBe(0);
    handle.close();
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    handle = new IndexHandle(lib.root);
  });

  it("a lookup that never answers frees its place after the time limit; the entry is retried; stopAll settles", async () => {
    know(LINE, cr(ZORBLATT));
    know("Lindqvist, Rivers of Memory", cr());
    const p = await project();
    gated.hold(parseReference(LINE)!.text, "openalex"); // never released
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.some((x) => x.service === "openalex"), "the lookup");
    timers.advance(FIND_LOOKUP_TIMEOUT_MS);
    await until(async () => (await entryOf(p, added[0]!.id))!.attempts === 1, "the retry");
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "looking-up" });
    expect(await sourcesOf(p)).toEqual([]);
    // The place is free: another line is looked up and settles.
    const other = await r.add(p.id, ["Lindqvist, Rivers of Memory"]);
    await settled(p, other.added[0]!.id);
    // Retried and never answered again: stopAll settles at once.
    const sentBefore = gated.sent.length;
    timers.advance(FIND_RETRY_DELAYS_MS[0]!);
    await until(() => gated.sent.length > sentBefore, "the retry's lookup");
    const t0 = Date.now();
    await r.stopAll();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it(`stopAll settles within its bound (${FIND_STOP_SETTLE_MS} ms), even with the store's turn held by an import`, async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    let releaseImport!: () => void;
    const held = new Promise<void>((res) => (releaseImport = res));
    let inTurn = false;
    const imported = importLikeAttach(p, { ...ZORBLATT, doi: "10.5555/ao.f4.other" }, async () => {
      inTurn = true;
      await held;
    });
    await until(() => inTurn, "the import to hold the turn");
    const r = runner();
    await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup");
    await new Promise((res) => setTimeout(res, 50));
    const t0 = Date.now();
    await r.stopAll();
    expect(Date.now() - t0).toBeLessThan(FIND_STOP_SETTLE_MS);
    releaseImport();
    await imported;
    await new Promise((res) => setTimeout(res, 50));
    expect((await sourcesOf(p)).map((s) => s.source.provenance.captureMethod)).toEqual(["manual_upload"]);
  });
});

describe("R237 (c): no entry is left saying Looking it up after the runner gave up on it", () => {
  it("settings() that reject: failed, unexpected; the error's text stays out of the entry; Try again starts afresh", async () => {
    settingsFn = () => Promise.reject(new Error("SECRET-DETAIL-xq7 broke"));
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e).toMatchObject({ state: "failed", reason: { code: "unexpected" } });
    expect(JSON.stringify(e)).not.toContain("SECRET-DETAIL");
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"), "utf8")).not.toContain("SECRET-DETAIL");
    expect(notes.join("\n")).toContain("unexpected");
    settingsFn = async () => settings;
    await r.retry(p.id, e.id);
    await settled(p, e.id);
    expect((await entryOf(p, e.id))!.state).toBe("record-complete");
  });

  it("a check that throws in the store turn (checkEverything): failed, unexpected, nothing created", async () => {
    everythingFn = () => {
      throw new Error("boom");
    };
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "unexpected" } });
    expect(await sourcesOf(p)).toEqual([]);
  });
});

describe("R237 (d): when nothing can be written for a project, the runner says so itself", () => {
  it("rules that cannot be read: stoppedFor says rules-unreadable; nothing asked; resume after the rules are mended clears it", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const id = newId();
    await appendFindEntries(coreOf(), p.id, [{ id, projectId: p.id, typed: LINE, state: "looking-up", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 }], "add");
    const gov = await readFile(join(lib.root, p.folder, "governance.yaml"), "utf8");
    await writeFile(join(lib.root, p.folder, "governance.yaml"), ": : not yaml\n");
    const r = runner();
    expect(r.stoppedFor(p.id)).toBeNull();
    r.resume(p.id);
    await until(() => r.stoppedFor(p.id) !== null, "the runner to say so");
    expect(r.stoppedFor(p.id)).toEqual({ code: "rules-unreadable" });
    expect(gated.sent).toEqual([]);
    expect((await entryOf(p, id))!.state).toBe("looking-up");
    await writeFile(join(lib.root, p.folder, "governance.yaml"), gov);
    r.resume(p.id);
    expect(r.stoppedFor(p.id)).toBeNull();
    await settled(p, id);
    expect((await entryOf(p, id))!.state).toBe("record-complete");
  });

  it("a queue that cannot be read: queue-unreadable; a read-only library: read-only", async () => {
    const p = await project();
    await mkdir(join(lib.root, p.folder, "find"), { recursive: true });
    await writeFile(join(lib.root, p.folder, "find", "queue.jsonl"), "not json at all\n");
    const r = runner();
    r.resume(p.id);
    await until(() => r.stoppedFor(p.id) !== null, "the runner to say so");
    expect(r.stoppedFor(p.id)).toEqual({ code: "queue-unreadable" });
    const q = await project();
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    const r2 = runner({ repo: ro });
    r2.resume(q.id);
    expect(r2.stoppedFor(q.id)).toEqual({ code: "read-only" });
  });
});

describe("R237 (g): minors", () => {
  it("M1 (as changed by R245): after stop, an add is refused and writes nothing; after resume it writes and runs", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    r.stop(p.id);
    await expect(r.add(p.id, [LINE])).rejects.toBeInstanceOf(FindProjectStoppedError);
    await new Promise((res) => setTimeout(res, 100));
    expect(gated.sent).toEqual([]);
    expect((await queue(p)).size).toBe(0);
    r.resume(p.id);
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("M2: a DOI of 250 characters is kept through Choose and on the record", async () => {
    const long = `10.5555/${"x".repeat(242)}`;
    const a: Work = { doi: long, title: "Zorblatt Grammar of Habitus", family: "Quillfeather", year: 1999 };
    const b: Work = { doi: `${long.slice(0, -1)}y`, title: "Zorblatt Grammar of Habitus Revisited", family: "Quillfeather", year: 2001 };
    know("Quillfeather, Zorblatt Grammar", cr(a, b));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Quillfeather, Zorblatt Grammar"]);
    await settled(p, added[0]!.id);
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("choose");
    const pick = e.candidates!.find((c) => c.identifiers.doi === long)!;
    expect(pick).toBeDefined();
    await r.choose(p.id, e.id, pick.id);
    const [sf] = await sourcesOf(p);
    expect(sf!.source.identifiers.doi).toBe(long);
  });

  it("M3: a sure match keeps find-match and its score when the researcher only answered a duplicate question or added it here as well", async () => {
    const p = await project();
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], { provenance: plainProvenance() });
    know(LINE, cr(ZORBLATT));
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("maybe-duplicate");
    const asked1 = (await entryOf(p, added[0]!.id))!;
    expect(asked1.match?.method).toBe("find-match");
    const done = await r.confirmDuplicate(p.id, added[0]!.id, false);
    const made = await repo.getSource(p.id, done.sourceId!);
    // The score is the rule's own (it can be exactly 1 for a full title, an author and a year), kept as it was.
    expect(made.source.provenance.identification).toEqual({ method: "find-match", confidence: asked1.match!.confidence });
    expect(made.source.provenance.identification!.confidence).toBe(scoreCandidate(parseReference(LINE)!, asked1.candidates![0]!).score);

    // Elsewhere, then "add it here as well".
    const other = await project();
    const q = await project();
    know(LINE_2, cr(ZORBLATT));
    await repo.createSource(other.id, draftOf(ZORBLATT), [], { provenance: plainProvenance() });
    everything = true;
    const second = await r.add(q.id, [LINE_2]);
    await settled(q, second.added[0]!.id);
    expect((await entryOf(q, second.added[0]!.id))!.elsewhere).toBe(true);
    const here = await r.addHereAsWell(q.id, second.added[0]!.id);
    const mine = await repo.getSource(q.id, here.sourceId!);
    expect(mine.source.provenance.identification!.method).toBe("find-match");
    expect(mine.source.provenance.identification!.confidence).toBe(scoreCandidate(parseReference(LINE_2)!, here.candidates![0]!).score);
  });

  it("M7: a likely duplicate made outside the store's turn (as a browser capture does) is seen by the next entry", async () => {
    know(LINE, cr(ZORBLATT));
    know("Okafor, Rivers of Memory", cr());
    const p = await project();
    const r = runner();
    const first = await r.add(p.id, ["Okafor, Rivers of Memory"]);
    await settled(p, first.added[0]!.id);
    // Made directly, not in a store turn (as a browser capture is): no DOI, the same title, author and year.
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], { provenance: plainProvenance() });
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("maybe-duplicate");
  });

  it("M7: an edit that makes a source the same work is seen", async () => {
    know(LINE, cr(ZORBLATT));
    know("Okafor, Rivers of Memory", cr());
    const p = await project();
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }, "Something else entirely"), [], { provenance: plainProvenance() });
    const r = runner();
    const first = await r.add(p.id, ["Okafor, Rivers of Memory"]);
    await settled(p, first.added[0]!.id);
    const [s] = await sourcesOf(p);
    await repo.updateSource(p.id, s!.source.id, { title: { variants: [{ lang: "en", kind: "original", value: ZORBLATT.title }] } });
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "maybe-duplicate", duplicateOf: s!.source.id });
  });

  it("M9: the defaults are frozen; lockedNotChecked is 0 while Check everything I have is off", async () => {
    expect(Object.isFrozen(DEFAULT_SEARCH_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SEARCH_SETTINGS.record)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SEARCH_SETTINGS.record[0])).toBe(true);
    const other = await project({ encrypted: true });
    repo.lockProject(other.id);
    const r = runner();
    everything = false;
    expect(r.lockedNotChecked()).toBe(0);
    everything = true;
    expect(r.lockedNotChecked()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The last round (after the second review: N1–N4, Q8)

describe("last round", () => {
  it("N1: a refusal for another rule stays not-allowed, even in a project that also lacks the legal basis (the engine refused the capture)", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project({ gov: GDPR(false) });
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.length >= 2, "the lookup");
    // The way of acquiring is switched off after the lookup: the creation's capture is refused before its store.
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, `${GDPR(false)}acquireMethods: [free_copy]\n`, { baseSha256: sha256 });
    release();
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "not-allowed", by: "rules" } });
    expect(await sourcesOf(p)).toEqual([]);
  });

  it("N2: a project whose writes wait for the library to be reopened: stoppedFor says recovery-pending", async () => {
    const p = await project();
    const id = newId();
    await appendFindEntries(coreOf(), p.id, [{ id, projectId: p.id, typed: LINE, state: "looking-up", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 }], "add");
    // A change that fails and cannot be undone leaves the project refusing changes until the library is reopened.
    seams.failAuditAppendFor = p.id;
    seams.failUndo = "append";
    await expect(repo.createCollection(p.id, "Broken")).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    seams.failUndo = undefined;
    expect(recoveryPendingProjects(repo)).toContain(p.id);
    const r = runner();
    r.resume(p.id);
    await until(() => r.stoppedFor(p.id) !== null, "the runner to say so");
    expect(r.stoppedFor(p.id)).toEqual({ code: "recovery-pending" });
    expect(gated.sent).toEqual([]);
  });

  it("N2: an unforeseen error while resuming: stoppedFor says unexpected; resume tries again", async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const id = newId();
    await appendFindEntries(coreOf(), p.id, [{ id, projectId: p.id, typed: LINE, state: "looking-up", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0 }], "add");
    // The project's list of sources fails once in a way nothing names (an I/O fault, say).
    const list = vi.spyOn(repo, "listSourceIds").mockImplementationOnce(() => {
      throw new Error("/secret/path EIO");
    });
    const r = runner();
    r.resume(p.id);
    await until(() => r.stoppedFor(p.id) !== null, "the runner to say so");
    expect(r.stoppedFor(p.id)).toEqual({ code: "unexpected" });
    expect(notes.join("\n")).not.toContain("/secret/path");
    expect(gated.sent).toEqual([]);
    list.mockRestore();
    r.resume(p.id);
    expect(r.stoppedFor(p.id)).toBeNull();
    await settled(p, id);
    expect((await entryOf(p, id))!.state).toBe("record-complete");
  });

  it("N3: OpenAlex paused for the day and Crossref finding nothing: not Not found; looking-up until the pause ends, reason budget; then asked again", async () => {
    know(LINE, cr(), "budget");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    const id = added[0]!.id;
    await until(async () => (await entryOf(p, id))?.reason?.code === "budget" && timers.pending.size === 1, "the pause");
    const e = (await entryOf(p, id))!;
    expect(e.state).toBe("looking-up");
    expect(e.attempts).toBe(0);
    // The pause ends at the next 00:00 UTC (the fake clock is at 10:00).
    expect(e.nextTryAt).toBe("2026-11-14T00:00:00.000Z");
    // OpenAlex has its allowance back after midnight: it is asked again, and only now, with every source answered,
    // may the entry say Not found (both find nothing).
    know(LINE, cr(), OA_EMPTY);
    const openAlexAsked = () => gated.sent.filter((x) => x.service === "openalex").length;
    const before = openAlexAsked();
    timers.advance(Date.parse("2026-11-14T00:00:00.000Z") - timers.now - 1);
    await new Promise((res) => setTimeout(res, 30));
    expect(openAlexAsked()).toBe(before);
    timers.advance(1);
    await settled(p, id);
    expect(openAlexAsked()).toBe(before + 1);
    expect((await entryOf(p, id))!.state).toBe("not-found");
    expect((await entryOf(p, id))!.reason).toBeUndefined();
  });

  it("N3: a source that failed and the rest finding nothing follows the ordinary retries", async () => {
    know(LINE, cr(), "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(async () => (await entryOf(p, added[0]!.id))?.attempts === 1 && timers.pending.size === 1, "the retry");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.state).toBe("looking-up");
    expect(e.nextTryAt).toBe(new Date(timers.now + FIND_RETRY_DELAYS_MS[0]!).toISOString());
  });

  it("N4: while the index cannot be trusted nothing starts and nothing is created; it goes on by itself once ready", async () => {
    know(LINE, cr(ZORBLATT));
    let ready = false;
    const p = await project();
    const r = runner({ indexReady: () => ready });
    const { added } = await r.add(p.id, [LINE]);
    await new Promise((res) => setTimeout(res, 100));
    expect(gated.sent).toEqual([]);
    expect(r.stoppedFor(p.id)).toEqual({ code: "index-not-ready" });
    ready = true;
    timers.advance(FIND_INDEX_WAIT_MS);
    await settled(p, added[0]!.id);
    expect(r.stoppedFor(p.id)).toBeNull();
    expect(await sourcesOf(p)).toHaveLength(1);
  });

  it("N4: a creation held back while the index is not ready, then made once", async () => {
    know(LINE, cr(ZORBLATT));
    let ready = true;
    const p = await project();
    const release = gated.hold(parseReference(LINE)!.text, "openalex");
    const r = runner({ indexReady: () => ready });
    const { added } = await r.add(p.id, [LINE]);
    await until(() => gated.sent.some((x) => x.service === "openalex"), "the lookup");
    ready = false;
    release();
    await new Promise((res) => setTimeout(res, 100));
    expect(await sourcesOf(p)).toEqual([]);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
    await expect(r.choose(p.id, added[0]!.id, "w-anything")).rejects.toBeInstanceOf(FindIndexNotReadyError);
    ready = true;
    timers.advance(FIND_INDEX_WAIT_MS);
    await settled(p, added[0]!.id);
    await new Promise((res) => setTimeout(res, 50));
    expect(await sourcesOf(p)).toHaveLength(1);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
  });

  it("Q8: at resume only source records made after the oldest waiting entry are read", async () => {
    const p = await project();
    // An older source (made now) and an entry made an hour later: the source cannot have been made for the entry.
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], { provenance: plainProvenance() });
    const [older] = await sourcesOf(p);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await appendFindEntries(coreOf(), p.id, [{ id: newId(), projectId: p.id, typed: LINE, state: "looking-up", createdAt: later, updatedAt: later, attempts: 0 }], "add");
    const read = vi.spyOn(repo, "getSourceRecord");
    settings = { record: DEFAULT_SEARCH_SETTINGS.record.map((s) => ({ ...s, on: false })) };
    const r = runner();
    r.resume(p.id);
    await until(async () => [...(await queue(p)).values()][0]!.state === "failed", "the entry to be worked on");
    expect(read.mock.calls.map((c) => c[1])).not.toContain(older!.source.id);
    read.mockRestore();
  });
});

describe("last round (m1): the healing scan at resume reads only what it must", () => {
  it("old Not found, Failed and Already (not elsewhere) entries do not make resume read older source records", async () => {
    const p = await project();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const stale = (state: FindState, extra: Partial<FindEntry> = {}): FindEntry => ({ id: newId(), projectId: p.id, typed: LINE, state, createdAt: hoursAgo(5), updatedAt: hoursAgo(4), attempts: 0, ...extra });
    await appendFindEntries(coreOf(), p.id, [stale("not-found"), stale("failed", { reason: { code: "unreachable" } }), stale("already", { duplicateOf: newId() })], "add");
    // A source made now, before the one waiting entry (made an hour from now): it cannot have been made for it.
    await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], { provenance: plainProvenance() });
    const [older] = await sourcesOf(p);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await appendFindEntries(coreOf(), p.id, [{ id: newId(), projectId: p.id, typed: LINE, state: "looking-up", createdAt: later, updatedAt: later, attempts: 0 }], "add");
    const read = vi.spyOn(repo, "getSourceRecord");
    settings = { record: DEFAULT_SEARCH_SETTINGS.record.map((x) => ({ ...x, on: false })) };
    const r = runner();
    r.resume(p.id);
    await until(async () => [...(await queue(p)).values()].some((e) => e.state === "failed" && e.createdAt === later), "the waiting entry to be worked on");
    expect(read.mock.calls.map((c) => c[1])).not.toContain(older!.source.id);
    read.mockRestore();
  });
});

describe("R245: nothing of the runner writes after the library's lock is released", () => {
  const fileOf = (p: Project) => join(lib.root, p.folder, "find", "queue.jsonl");
  const bytesOf = (p: Project) => readFile(fileOf(p)).catch(() => Buffer.alloc(0));
  /** Holds the project's store turn (as an import would) until the returned function is called. */
  async function holdTurn(p: Project): Promise<{ free: () => void; done: Promise<void> }> {
    let free!: () => void;
    let inTurn = false;
    const done = serialStore(repo, p.id, async () => {
      inTurn = true;
      await new Promise<void>((res) => (free = res));
    });
    await until(() => inTurn, "the turn to be held");
    return { free, done };
  }
  /** An entry in "not-found" and one in "choose". */
  async function twoEntries(r: FindRunner, p: Project): Promise<{ none: FindEntry; choose: FindEntry }> {
    know("Zorblatt Variants of Habitus", cr({ ...ZORBLATT, doi: "10.5555/ao.f4.v1" }, { ...ZORBLATT, doi: "10.5555/ao.f4.v2", year: 2003 }));
    const { added } = await r.add(p.id, ["Nothing Matches Vorpalwick", "Zorblatt Variants of Habitus"]);
    await settled(p, added[0]!.id);
    await settled(p, added[1]!.id);
    const none = (await entryOf(p, added[0]!.id))!;
    const choose = (await entryOf(p, added[1]!.id))!;
    expect([none.state, choose.state]).toEqual(["not-found", "choose"]);
    return { none, choose };
  }

  it("acts held before their turn, stopAll called, released: nothing is written and every act is refused", async () => {
    const p = await project();
    const r = runner();
    const { none, choose } = await twoEntries(r, p);
    const before = await bytesOf(p);
    const turn = await holdTurn(p);
    const acts = [
      r.choose(p.id, choose.id, choose.candidates![0]!.id),
      r.retry(p.id, none.id),
      r.remove(p.id, none.id),
    ].map((a) => a.then(() => "done", (err: unknown) => err));
    await new Promise((res) => setTimeout(res, 30));
    const stopping = r.stopAll();
    turn.free();
    await turn.done;
    await stopping;
    for (const a of await Promise.all(acts)) expect(a).toBeInstanceOf(FindRunnerClosedError);
    // (R247 M4: an add takes no turn; after stopAll it is refused at once.)
    await expect(r.add(p.id, ["Another Line Entirely"])).rejects.toBeInstanceOf(FindRunnerClosedError);
    await new Promise((res) => setTimeout(res, 50));
    expect((await bytesOf(p)).equals(before)).toBe(true);
    expect(await sourcesOf(p)).toEqual([]);
  });

  it("acts held before their turn, stop(projectId) called, released: nothing is written and every act is refused", async () => {
    const p = await project();
    const r = runner();
    const { none, choose } = await twoEntries(r, p);
    const before = await bytesOf(p);
    const turn = await holdTurn(p);
    const acts = [
      r.choose(p.id, choose.id, null),
      r.confirmDuplicate(p.id, choose.id, true),
      r.addHereAsWell(p.id, choose.id),
      r.retry(p.id, none.id),
      r.remove(p.id, none.id),
    ].map((a) => a.then(() => "done", (err: unknown) => err));
    await new Promise((res) => setTimeout(res, 30));
    r.stop(p.id);
    turn.free();
    await turn.done;
    for (const a of await Promise.all(acts)) expect(a).toBeInstanceOf(FindProjectStoppedError);
    await expect(r.add(p.id, ["Another Line Entirely"])).rejects.toBeInstanceOf(FindProjectStoppedError);
    expect((await bytesOf(p)).equals(before)).toBe(true);
    // After resume the researcher can act again.
    r.resume(p.id);
    await r.retry(p.id, none.id);
  });

  it("an act inside its turn when stopAll is called: stopAll settles after it, within its bound", async () => {
    const p = await project();
    const order: string[] = [];
    let watched = "";
    // The act's own line, written inside its turn, is told by onChange (m3: the order is asserted).
    const r = runner({
      onChange: (e) => {
        changes.push(e);
        if (e.entryId === watched && e.state === "record-complete") order.push("act's line written");
      },
    });
    const { choose } = await twoEntries(r, p);
    watched = choose.id;
    let release!: () => void;
    let entered = false;
    runnerSeams.inAct = async () => {
      entered = true;
      await new Promise<void>((res) => (release = res));
    };
    const act = r.choose(p.id, choose.id, choose.candidates![0]!.id).then(
      () => order.push("act done"),
      () => order.push("act refused"),
    );
    await until(() => entered, "the act to be inside its turn");
    const t0 = Date.now();
    const stopping = r.stopAll().then(() => order.push("stopAll settled"));
    await new Promise((res) => setTimeout(res, 50));
    expect(order).toEqual([]);
    release();
    await Promise.all([act, stopping]);
    expect(Date.now() - t0).toBeLessThan(FIND_STOP_SETTLE_MS);
    // The act finished (its line written) before stopAll settled.
    expect(order.indexOf("act's line written")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("act's line written")).toBeLessThan(order.indexOf("stopAll settled"));
    expect(order).toContain("act done");
    // Whatever the act did, it did before stopAll settled: nothing changes afterwards.
    const after = await bytesOf(p);
    await new Promise((res) => setTimeout(res, 50));
    expect((await bytesOf(p)).equals(after)).toBe(true);
  });
});

describe("R247: a creation under way finishes before the lock goes; a half-made record is healed; adds never wait behind an import", () => {
  const held = () => {
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((res) => (release = res));
    return {
      seam: async () => {
        entered = true;
        await gate;
      },
      entered: () => entered,
      release: () => release(),
    };
  };

  it(`(d) a creation held inside its turn when stopAll is called: stopAll waits past its bound (${FIND_STOP_SETTLE_MS} ms); the record and the entry's line are both there`, async () => {
    know(LINE, cr(ZORBLATT));
    const p = await project();
    const r = runner();
    const h = held();
    runnerSeams.inCreate = h.seam;
    const { added } = await r.add(p.id, [LINE]);
    await until(h.entered, "the creation to be under way");
    let settledAt = 0;
    const t0 = Date.now();
    const stopping = r.stopAll().then(() => (settledAt = Date.now()));
    await new Promise((res) => setTimeout(res, FIND_STOP_SETTLE_MS + 300));
    expect(settledAt).toBe(0);
    h.release();
    await stopping;
    expect(settledAt - t0).toBeGreaterThan(FIND_STOP_SETTLE_MS);
    const e = (await entryOf(p, added[0]!.id))!;
    const sources = await sourcesOf(p);
    expect(sources).toHaveLength(1);
    expect(e).toMatchObject({ state: "record-complete", sourceId: sources[0]!.source.id });
  }, 20_000);

  it("(d) an act held inside its turn when stopAll is called: stopAll waits past its bound; the act finishes", async () => {
    const p = await project();
    const r = runner();
    know("Zorblatt Variants of Habitus", cr({ ...ZORBLATT, doi: "10.5555/ao.f4.v1" }, { ...ZORBLATT, doi: "10.5555/ao.f4.v2", year: 2003 }));
    const { added } = await r.add(p.id, ["Zorblatt Variants of Habitus"]);
    await settled(p, added[0]!.id);
    const c = (await entryOf(p, added[0]!.id))!;
    expect(c.state).toBe("choose");
    const h = held();
    runnerSeams.inAct = h.seam;
    const act = r.choose(p.id, c.id, c.candidates![0]!.id);
    await until(h.entered, "the act to be inside its turn");
    let settledAt = 0;
    const stopping = r.stopAll().then(() => (settledAt = Date.now()));
    await new Promise((res) => setTimeout(res, FIND_STOP_SETTLE_MS + 300));
    expect(settledAt).toBe(0);
    h.release();
    expect((await act).state).toBe("record-complete");
    await stopping;
    expect(await sourcesOf(p)).toHaveLength(1);
  }, 20_000);

  for (const how of ["choose", "a duplicate answer"] as const) {
    it(`(e) M1: a lock between the record's creation and the entry's line, after ${how}, is healed at resume by a new runner`, async () => {
      const p = await project({ encrypted: true });
      let r = runner();
      let e: FindEntry;
      if (how === "choose") {
        know("Zorblatt Variants of Habitus", cr({ ...ZORBLATT, doi: "10.5555/ao.f4.v1" }, { ...ZORBLATT, doi: "10.5555/ao.f4.v2", year: 2003 }));
        const { added } = await r.add(p.id, ["Zorblatt Variants of Habitus"]);
        await settled(p, added[0]!.id);
        e = (await entryOf(p, added[0]!.id))!;
        expect(e.state).toBe("choose");
      } else {
        await repo.createSource(p.id, draftOf({ ...ZORBLATT, doi: undefined }), [], { provenance: plainProvenance() });
        know(LINE, cr(ZORBLATT));
        const { added } = await r.add(p.id, [LINE]);
        await settled(p, added[0]!.id);
        e = (await entryOf(p, added[0]!.id))!;
        expect(e.state).toBe("maybe-duplicate");
      }
      runnerSeams.afterCreate = () => {
        r.stop(p.id);
        repo.lockProject(p.id);
      };
      const press = how === "choose" ? r.choose(p.id, e.id, e.candidates![0]!.id) : r.confirmDuplicate(p.id, e.id, false);
      await expect(press).rejects.toBeTruthy();
      runnerSeams.afterCreate = undefined;
      await r.stopAll();
      await repo.unlockProject(p.id, "pw");
      const before = await sourcesOf(p);
      const made = before.filter((x) => x.source.provenance.captureMethod === "reference_lookup");
      expect(made).toHaveLength(1);
      expect((await entryOf(p, e.id))!.state).toBe(e.state);
      // A new runner (as after a close and reopen) heals it at resume.
      r = runner();
      r.resume(p.id);
      await until(async () => (await entryOf(p, e.id))!.state === "record-complete", "the entry to be healed");
      expect((await entryOf(p, e.id))!.sourceId).toBe(made[0]!.source.id);
      expect(await sourcesOf(p)).toHaveLength(before.length);
    });
  }

  it("(e) M2: a line the parser refuses is named by its number and its true cause, never by its text", async () => {
    const p = await project();
    const r = runner();
    const err = await r.add(p.id, ["Zorblatt Grammar of Habitus", "\u0000\u0007\u202e"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message).toContain("Line 2");
    expect((err as Error).message).toMatch(/cannot be shown/);
    expect((err as Error).message).not.toContain("Zorblatt");
    expect((await queue(p)).size).toBe(0);
  });

  it("(e) M4: an add while an import holds the project's store turn is written at once; stopAll waits for an add already writing", async () => {
    const p = await project();
    let releaseImport!: () => void;
    const importHeld = new Promise<void>((res) => (releaseImport = res));
    let inTurn = false;
    const imported = importLikeAttach(p, { ...ZORBLATT, doi: "10.5555/ao.f4.other" }, async () => {
      inTurn = true;
      await importHeld;
    });
    await until(() => inTurn, "the import to hold the turn");
    const r = runner();
    gated.hold(parseReference(LINE)!.text);
    const { added } = await r.add(p.id, [LINE]);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("looking-up");
    releaseImport();
    await imported;
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task F8 (R267): an author alone — the person, then their works. Made-up people and works.

describe("F8: an author alone — the person, then their works", () => {
  const NAME = "Ottoline Brackwater";
  const AFFIL = "University of Invented Studies";
  const oaPerson = (n: number, name: string, aff?: string) => ({ id: `https://openalex.org/A${n}`, display_name: name, works_count: 30, ...(aff ? { last_known_institutions: [{ display_name: aff }] } : {}) });
  const peopleOf = (list: unknown[], count = list.length) => ({ meta: { count, page: 1, per_page: 20 }, results: list });
  const oaWork = (n: number, title: string, date: string, doi?: string) => ({
    id: `https://openalex.org/W${n}`,
    title,
    display_name: title,
    publication_year: Number(date.slice(0, 4)),
    publication_date: date,
    type: "article",
    ...(doi ? { doi: `https://doi.org/${doi}` } : {}),
    primary_location: { source: { display_name: "Journal of Invented Studies" } },
    authorships: [{ author: { display_name: NAME } }],
  });
  /** A person's works, newest first: W1000 is the newest. */
  const worksFor = (n: number, title = (i: number) => `Tidal Ledger Number ${i}`) =>
    Array.from({ length: n }, (_, i) => oaWork(1000 + i, title(i), `${2025 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}-01`, `10.5555/ao.f8.w${1000 + i}`));
  /** One person fits the name (the other does not cover "brackwater"), with `n` works. */
  function onePerson(n = 150): void {
    know(NAME, cr({ title: "Lanterns of the Estuary", family: "Brackwater", year: 2001, doi: "10.5555/ao.f8.lantern" }), OA_EMPTY);
    peopleAnswers.set(NAME, peopleOf([oaPerson(5001, NAME, AFFIL), oaPerson(5002, "Ottoline Brackwell")]));
    personWorks.set("A5001", worksFor(n));
  }
  /** Two people fit the name. */
  function twoPeople(): void {
    know(NAME, cr(), OA_EMPTY);
    peopleAnswers.set(NAME, peopleOf([oaPerson(5001, NAME, AFFIL), oaPerson(5003, "Ottoline M. Brackwater", "College of Made-up Things")]));
    personWorks.set("A5001", worksFor(20));
    personWorks.set("A5003", worksFor(5, (i) => `Harbour Accounts ${i}`));
  }
  /** The entry is in state `s`, and that change is committed (its event was sent: a read can show a line not yet committed, A2). */
  /** The works counted as added from an author's entry: those of the live entries made from it (R271 M5). */
  const addedFrom = async (p: Project, parentId: string) => [...(await queue(p)).values()].filter((e) => e.parentId === parentId).map((e) => e.work!);
  const stateIs = (p: Project, id: string, s: FindState) =>
    until(async () => changes.some((c) => c.entryId === id && c.state === s) && (await entryOf(p, id))?.state === s, `the entry to be ${s}`);
  /** The single-work answers for the works the mock knows: the list's title, and a second author only this answer carries (R273). */
  function singlesFor(id: string): void {
    for (const w of personWorks.get(id) ?? []) {
      const o = w as ReturnType<typeof oaWork>;
      singleWorks.set(o.id.slice("https://openalex.org/".length), { ...o, authorships: [...o.authorships, { author: { display_name: "Quentin Marsh" } }] });
    }
  }

  it("a line with a clear title makes no people request (with or without a year)", async () => {
    const p = await project();
    const CLEAR = "Quillfeather, Zorblatt Grammar of Habitus";
    know(CLEAR, cr(ZORBLATT), OA_EMPTY);
    know(LINE, cr(ZORBLATT), OA_EMPTY);
    const r = runner();
    const { added } = await r.add(p.id, [CLEAR]);
    await settled(p, added[0]!.id);
    const { added: a2 } = await r.add(p.id, [LINE]);
    await settled(p, a2[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("record-complete");
    expect(askedPeople).toEqual([]);
    expect(sentF8).toEqual([]);
  });

  it("an author's name makes ONE people request; two fit: choose-person, nothing added", async () => {
    twoPeople();
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-person");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(askedPeople).toEqual([NAME]);
    expect(askedWorks).toEqual([]);
    expect(e.people!.map((x) => x.id)).toEqual(["A5001", "A5003"]);
    expect(e.people![0]).toEqual({ id: "A5001", name: NAME, affiliation: AFFIL, worksCount: 30, subjects: [] });
    expect(e.morePeople).toBeUndefined();
    expect(e.candidates).toBeUndefined();
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect((await queue(p)).size).toBe(1);
  });

  it("one person fits: straight to choose-works, newest first (one people request, two works pages)", async () => {
    onePerson(150);
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(askedPeople).toHaveLength(1);
    expect(askedWorks).toEqual([
      { id: "A5001", page: 1 },
      { id: "A5001", page: 2 },
    ]);
    expect(askedSingle).toEqual([]);
    expect(e.chosen).toBe("A5001");
    expect(e.people!.map((x) => x.id)).toEqual(["A5001"]);
    expect(e.works).toHaveLength(150);
    expect(e.works![0]!.id).toBe("W1000");
    const dates = e.works!.map((w) => w.issued!);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(e.moreWorks).toBeUndefined();
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("forty people: 20 listed, morePeople said, nothing added and no works asked", async () => {
    know("Smith", cr(), OA_EMPTY);
    peopleAnswers.set("Smith", peopleOf(Array.from({ length: 20 }, (_, i) => oaPerson(6000 + i, `${String.fromCharCode(65 + i)}. Smith`)), 40));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Smith"]);
    await stateIs(p, added[0]!.id, "choose-person");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.people).toHaveLength(20);
    expect(e.morePeople).toBe(true);
    expect(askedWorks).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect((await queue(p)).size).toBe(1);
  });

  it("200 works with 1,000-character titles make a line the store accepts (fewer kept, moreWorks said)", async () => {
    know(NAME, cr(), OA_EMPTY);
    peopleAnswers.set(NAME, peopleOf([oaPerson(5001, NAME, "長".repeat(1000))]));
    personWorks.set("A5001", worksFor(230, (i) => `${i} ${"長".repeat(1000)}`));
    const p = await project({ encrypted: true });
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.works!.length).toBeGreaterThan(0);
    expect(e.works!.length).toBeLessThan(200);
    expect(e.moreWorks).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ...e, added: e.works!.map((w) => w.id) }), "utf8")).toBeLessThanOrEqual(65_536);
  });

  it("choosePerson: only one of the entry's own people; the works are fetched and the entry is choose-works; a second press is refused in words", async () => {
    twoPeople();
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const id = added[0]!.id;
    await stateIs(p, id, "choose-person");
    const before = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    // A person id not among the entry's people (no request can make the app fetch an arbitrary author), or not an id.
    await expect(r.choosePerson(p.id, id, "A9999")).rejects.toBeInstanceOf(FindUnknownOptionError);
    await expect(r.choosePerson(p.id, id, "https://openalex.org/A5003")).rejects.toBeInstanceOf(InvalidInputError);
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(before);
    expect(askedWorks).toEqual([]);
    const pressed = await r.choosePerson(p.id, id, "A5003");
    expect(pressed).toMatchObject({ state: "looking-up", chosen: "A5003" });
    await expect(r.choosePerson(p.id, id, "A5003")).rejects.toBeInstanceOf(FindEntryStateError);
    await stateIs(p, id, "choose-works");
    const e = (await entryOf(p, id))!;
    expect(e.works!.map((w) => w.title)).toEqual(["Harbour Accounts 0", "Harbour Accounts 1", "Harbour Accounts 2", "Harbour Accounts 3", "Harbour Accounts 4"]);
    expect(e.people!.map((x) => x.id)).toEqual(["A5003"]);
    expect(askedPeople).toHaveLength(1);
    expect(askedWorks).toEqual([{ id: "A5003", page: 1 }]);
    // A press on an entry in another state is refused, and changes nothing.
    await expect(r.choosePerson(p.id, id, "A5003")).rejects.toBeInstanceOf(FindEntryStateError);
    expect(changes.filter((c) => c.entryId === id).map((c) => c.state)).toEqual(["looking-up", "choose-person", "looking-up", "choose-works"]);
  });

  it("ticking 3 works makes 3 entries, each checked for duplicates; each record comes from a fresh single-work request; the parent stays choose-works", async () => {
    onePerson(20);
    singlesFor("A5001");
    const p = await project();
    // One of the three is already in the project.
    await importLikeAttach(p, { doi: "10.5555/ao.f8.w1001", title: "Tidal Ledger Number 1", family: "Brackwater", year: 2025 });
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const pid = added[0]!.id;
    await stateIs(p, pid, "choose-works");
    const auditBefore = await auditText(p);
    const { added: kids, parent } = await r.chooseWorks(p.id, pid, ["W1000", "W1001", "W1002"]);
    expect(kids).toHaveLength(3);
    expect(parent).toMatchObject({ state: "choose-works" });
    expect(await addedFrom(p, pid)).toEqual(["W1000", "W1001", "W1002"]);
    for (const [i, k] of kids.entries()) {
      expect(k).toMatchObject({ parentId: pid, state: "looking-up", work: `W${1000 + i}`, typed: `Tidal Ledger Number ${i}, Brackwater`, candidates: [{ id: `W${1000 + i}`, title: `Tidal Ledger Number ${i}` }] });
    }
    // ONE governed write for the three entries and the parent's line.
    const newAudit = (await auditText(p)).slice(auditBefore.length).split("\n").filter((l) => l.includes("project.find."));
    expect(newAudit).toHaveLength(1);
    expect(newAudit[0]).toContain("project.find.add");
    for (const k of kids) await settled(p, k.id);
    const states = await Promise.all(kids.map(async (k) => (await entryOf(p, k.id))!.state));
    expect(states).toEqual(["record-complete", "already", "record-complete"]);
    expect(askedSingle.sort()).toEqual(["W1000", "W1001", "W1002"]);
    // No text search was made for them.
    expect(asked.filter((a) => a.text.includes("Tidal"))).toEqual([]);
    const made = await sourcesOf(p);
    expect(made).toHaveLength(3);
    const rec = made.find((s) => s.source.identifiers.doi === "10.5555/ao.f8.w1000")!.source;
    // The record comes from the fresh single-work answer (R267 c): it holds the second author only that answer carries.
    expect(rec.title.variants[0]!.value).toBe("Tidal Ledger Number 0");
    expect(rec.creators.map((c) => c.family)).toEqual(["Brackwater", "Marsh"]);
    expect(rec.provenance).toMatchObject({ captureMethod: "reference_lookup", identification: { method: "find-chosen", confidence: 1 } });
    expect((await entryOf(p, pid))!.state).toBe("choose-works");
  });

  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as const) {
    it(`ticking 3 works makes 3 entries with the parent's line in one write: a crash at ${point} leaves all or none`, async () => {
      onePerson(10);
      const p = await project();
      const r = runner();
      const { added } = await r.add(p.id, [NAME]);
      const pid = added[0]!.id;
      await stateIs(p, pid, "choose-works");
      seams.crashAt = point;
      await expect(r.chooseWorks(p.id, pid, ["W1000", "W1001", "W1002"])).rejects.toBeInstanceOf(SimulatedCrash);
      for (const x of runners) await x.stopAll();
      runners = [];
      handle.close();
      await lib.close();
      lib = await openLibrary(lib.root, mkDeps());
      handle = new IndexHandle(lib.root);
      repo = await repoFor();
      const q = await queue(p);
      const kids = [...q.values()].filter((e) => e.parentId === pid);
      if (point === "before-marker-delete") {
        expect(kids).toHaveLength(3);
        expect(kids.map((k) => k.work)).toEqual(["W1000", "W1001", "W1002"]);
      } else {
        expect(kids).toHaveLength(0);
      }
    });
  }

  it("the parent stays choose-works and a second tick adds more; an id already added is refused by its position; a duplicate in one call counts once", async () => {
    onePerson(20);
    singlesFor("A5001");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const pid = added[0]!.id;
    await stateIs(p, pid, "choose-works");
    await r.chooseWorks(p.id, pid, ["W1000", "W1001"]);
    const err = await r.chooseWorks(p.id, pid, ["W1005", "W1001"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(FindAlreadyAddedError);
    expect((err as Error).message).toBe("Work 2 was already added from this entry. Nothing was added.");
    expect([...(await queue(p)).values()].filter((e) => e.parentId === pid)).toHaveLength(2);
    const second = await r.chooseWorks(p.id, pid, ["W1005", "W1006", "W1005"]);
    expect(second.added.map((k) => k.work)).toEqual(["W1005", "W1006"]);
    expect(second.parent).toMatchObject({ state: "choose-works" });
    expect(await addedFrom(p, pid)).toEqual(["W1000", "W1001", "W1005", "W1006"]);
  });

  it("51 ids are refused; so is none, an id that is not W-digits, and a works id not among the entry's works; and a press on another state", async () => {
    onePerson(60);
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const pid = added[0]!.id;
    await stateIs(p, pid, "choose-works");
    const before = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    const ids = Array.from({ length: 51 }, (_, i) => `W${1000 + i}`);
    await expect(r.chooseWorks(p.id, pid, ids)).rejects.toThrow("At most 50 works can be added at once. Nothing was added.");
    await expect(r.chooseWorks(p.id, pid, [])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(r.chooseWorks(p.id, pid, ["W1000", "A5001"])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(r.chooseWorks(p.id, pid, ["W1000", "W99999"])).rejects.toBeInstanceOf(FindUnknownOptionError);
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(before);
    // Exactly 50 is fine.
    const { added: kids } = await r.chooseWorks(p.id, pid, ids.slice(0, 50));
    expect(kids).toHaveLength(50);
    // An entry in another state (an added work's own entry) takes no tick.
    await expect(r.chooseWorks(p.id, kids[0]!.id, ["W1000"])).rejects.toBeInstanceOf(FindEntryStateError);
    await expect(r.choosePerson(p.id, pid, "A5001")).rejects.toBeInstanceOf(FindEntryStateError);
  });

  it("the queue full: a tick is refused whole with the plan's sentence, and nothing is written", async () => {
    onePerson(10);
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const pid = added[0]!.id;
    await stateIs(p, pid, "choose-works");
    const at = new Date(NOW).toISOString();
    const filler = Array.from({ length: FIND_QUEUE_MAX - 2 }, () => ({ id: newId(), projectId: p.id, typed: "filler line", state: "not-found" as const, createdAt: at, updatedAt: at, attempts: 0 }));
    await appendFindEntries(coreOf(), p.id, filler, "add");
    const before = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    const err = await r.chooseWorks(p.id, pid, ["W1000", "W1001"]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(FindQueueFullError);
    expect((err as Error).message).toBe("The queue holds 500 entries. Remove some finished ones first.");
    expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(before);
    expect((await r.chooseWorks(p.id, pid, ["W1000"])).added).toHaveLength(1);
  });

  it("the daily allowance used up in the middle (the second works page): the entry waits with budget, nothing half-stored, and resumes", async () => {
    onePerson(150);
    worksTrouble.set("A5001:2", "budget");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const id = added[0]!.id;
    await until(async () => (await entryOf(p, id))?.reason?.code === "budget", "the entry to wait for the allowance");
    const e = (await entryOf(p, id))!;
    expect(e).toMatchObject({ state: "looking-up", chosen: "A5001", nextTryAt: "2026-11-14T00:00:00.000Z", attempts: 0 });
    expect(e.works).toBeUndefined();
    expect(e.people!.map((x) => x.id)).toEqual(["A5001"]);
    // Paused: nothing more is asked of OpenAlex's searches meanwhile.
    timers.advance(60 * 60_000);
    await new Promise((res) => setTimeout(res, 50));
    expect(askedWorks).toHaveLength(2);
    // After midnight UTC the allowance is back: the works are asked again (not the people; page 1 is in the lookup
    // cache), and the entry is choose-works.
    worksTrouble.clear();
    timers.advance(Date.parse("2026-11-14T00:00:00.000Z") - timers.now + 1);
    await stateIs(p, id, "choose-works");
    expect(askedPeople).toHaveLength(1);
    expect(askedWorks.map((w) => w.page)).toEqual([1, 2, 2]);
    expect((await entryOf(p, id))!.works).toHaveLength(150);
  });

  it("the people search meeting the spent allowance: the entry waits with budget (never a guess among the works found)", async () => {
    know(NAME, cr({ title: "Lanterns of the Estuary", family: "Brackwater", year: 2001, doi: "10.5555/ao.f8.lantern" }), OA_EMPTY);
    peopleAnswers.set(NAME, "budget");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await until(async () => (await entryOf(p, added[0]!.id))?.reason?.code === "budget", "the entry to wait");
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "looking-up", nextTryAt: "2026-11-14T00:00:00.000Z" });
    expect((await entryOf(p, added[0]!.id))!.candidates).toBeUndefined();
  });

  it("a people search or a works page that fails goes the ordinary retry way", async () => {
    onePerson(150);
    worksTrouble.set("A5001:2", "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const id = added[0]!.id;
    await until(async () => (await entryOf(p, id))?.attempts === 1, "the first retry to be planned");
    expect((await entryOf(p, id))!).toMatchObject({ state: "looking-up", chosen: "A5001", nextTryAt: new Date(NOW + FIND_RETRY_DELAYS_MS[0]!).toISOString() });
    expect((await entryOf(p, id))!.works).toBeUndefined();
    worksTrouble.clear();
    await until(() => timers.pending.size > 0, "the retry's timer");
    timers.advance(FIND_RETRY_DELAYS_MS[0]!);
    await stateIs(p, id, "choose-works");
    expect(askedPeople).toHaveLength(1);
  });

  it("a child whose single-work request fails is retried by its id; Try again asks the same work again, never a text search", async () => {
    onePerson(5);
    singleWorks.set("W1000", "fail");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
    const kid = kids[0]!.id;
    for (let i = 0; i < FIND_RETRY_DELAYS_MS.length; i++) {
      await until(async () => (await entryOf(p, kid))!.attempts === i + 1, "the retry");
      await until(() => timers.pending.size > 0, "the retry's timer");
      timers.advance(FIND_RETRY_DELAYS_MS[i]!);
    }
    await settled(p, kid);
    expect(askedSingle).toEqual(["W1000", "W1000", "W1000", "W1000"]);
    expect((await entryOf(p, kid))!).toMatchObject({ state: "failed", reason: { code: "unreachable" }, work: "W1000" });
    singlesFor("A5001");
    const again = await r.retry(p.id, kid);
    expect(again).toMatchObject({ state: "looking-up", work: "W1000", parentId: added[0]!.id });
    await settled(p, kid);
    expect((await entryOf(p, kid))!.state).toBe("record-complete");
    expect(asked.filter((a) => a.text.includes("Tidal"))).toEqual([]);
  });

  it("no name, title, affiliation or OpenAlex id in any audit entry, note or event", async () => {
    twoPeople();
    singlesFor("A5003");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const id = added[0]!.id;
    await stateIs(p, id, "choose-person");
    await r.choosePerson(p.id, id, "A5003");
    await stateIs(p, id, "choose-works");
    const { added: kids } = await r.chooseWorks(p.id, id, ["W1000", "W1001"]);
    for (const k of kids) await settled(p, k.id);
    const audit = await auditText(p);
    const said = [audit, notes.join("\n"), JSON.stringify(changes)].join("\n");
    for (const w of ["Ottoline", "Brackwater", AFFIL, "Made-up Things", "Harbour Accounts", "A5003", "A5001", "W1000", "W1001", "Invented Studies"]) {
      expect(said.includes(w), `"${w}" was audited, noted or sent`).toBe(false);
    }
    for (const c of changes) expect(Object.keys(c).sort()).toEqual(["entryId", "projectId", "state"]);
    expect(audit).toContain("project.find.add");
  });

  it("OpenAlex refused by the rules or switched off: no people request, the works search decides as before", async () => {
    know(NAME, cr(), OA_EMPTY);
    peopleAnswers.set(NAME, peopleOf([oaPerson(5001, NAME)]));
    const p = await project({ gov: GOV().replace("[crossref, openalex]", "[crossref]") });
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!.state).toBe("not-found");
    settings = { record: [{ id: "crossref", on: true }, { id: "openalex", on: false }] };
    const q = await project();
    const { added: a2 } = await r.add(q.id, [NAME]);
    await settled(q, a2[0]!.id);
    expect(askedPeople).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Round 2 (R270 d, e; R271)

  it("I1: one person fits but OpenAlex reports more than twenty: choose-person with that one, morePeople, no works asked", async () => {
    know(NAME, cr(), OA_EMPTY);
    const others = Array.from({ length: 19 }, (_, i) => oaPerson(7000 + i, `${String.fromCharCode(65 + i)}. Quillon`));
    peopleAnswers.set(NAME, peopleOf([oaPerson(5001, NAME, AFFIL), ...others], 40));
    personWorks.set("A5001", worksFor(5));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-person");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.people!.map((x) => x.id)).toEqual(["A5001"]);
    expect(e.morePeople).toBe(true);
    expect(askedWorks).toEqual([]);
  });

  it("R270 d: J. Smith against John Smith and Jane Smith: choose-person", async () => {
    know("J. Smith", cr(), OA_EMPTY);
    peopleAnswers.set("J. Smith", peopleOf([oaPerson(5101, "John Smith"), oaPerson(5102, "Jane Smith"), oaPerson(5103, "Adam Smith")]));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["J. Smith"]);
    await stateIs(p, added[0]!.id, "choose-person");
    expect((await entryOf(p, added[0]!.id))!.people!.map((x) => x.id)).toEqual(["A5101", "A5102"]);
  });

  it("R270 d: P. Bourdieu with one Pierre Bourdieu: choose-person (not straight to works); Pierre Bourdieu: choose-works as before", async () => {
    for (const line of ["P. Bourdieu", "Pierre Bourdieu"]) {
      know(line, cr(), OA_EMPTY);
      peopleAnswers.set(line, peopleOf([oaPerson(5201, "Pierre Bourdieu"), oaPerson(5202, "Marie-Claire Bourdieu")]));
    }
    personWorks.set("A5201", worksFor(3));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["P. Bourdieu"]);
    await stateIs(p, added[0]!.id, "choose-person");
    expect((await entryOf(p, added[0]!.id))!.people!.map((x) => x.id)).toEqual(["A5201"]);
    expect(askedWorks).toEqual([]);
    const { added: a2 } = await r.add(p.id, ["Pierre Bourdieu"]);
    await stateIs(p, a2[0]!.id, "choose-works");
    expect(askedWorks).toEqual([{ id: "A5201", page: 1 }]);
  });

  it("R270 e: each person carries up to three subject names from the same answer, never another request", async () => {
    twoPeople();
    peopleAnswers.set(NAME, peopleOf([{ ...oaPerson(5001, NAME, AFFIL), topics: [{ display_name: "Coastal Ledgers" }, { display_name: "Tidal Accounts" }] }, oaPerson(5003, "Ottoline M. Brackwater")]));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-person");
    const e = (await entryOf(p, added[0]!.id))!;
    expect(e.people!.map((x) => x.subjects)).toEqual([["Coastal Ledgers", "Tidal Accounts"], []]);
    expect(askedPeople).toHaveLength(1);
  });

  it("M3: a single-work answer for another id ends that entry not found at once (no retries); the allowance spent there is the budget wait", async () => {
    onePerson(5);
    singlesFor("A5001");
    const w1 = singleWorks.get("W1001") as Record<string, unknown>;
    singleWorks.set("W1000", { ...w1 });
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
    await settled(p, kids[0]!.id);
    expect((await entryOf(p, kids[0]!.id))!).toMatchObject({ state: "not-found", attempts: 0 });
    expect(askedSingle).toEqual(["W1000"]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    // A 429 that shows the allowance spent, on a single work.
    singleWorks.set("W1002", "budget");
    const { added: k2 } = await r.chooseWorks(p.id, added[0]!.id, ["W1002"]);
    await until(async () => (await entryOf(p, k2[0]!.id))?.reason?.code === "budget", "the child to wait for the allowance");
    expect((await entryOf(p, k2[0]!.id))!).toMatchObject({ state: "looking-up", attempts: 0, nextTryAt: "2026-11-14T00:00:00.000Z" });
  });

  for (const [what, change] of [
    ["another DOI", { doi: "https://doi.org/10.5555/something.else" }],
    ["another title", { title: "Something Else Entirely", display_name: "Something Else Entirely" }],
  ] as const) {
    it(`M4: the fresh record of a ticked work with the same id but ${what}: choose with that one fresh candidate, nothing created`, async () => {
      onePerson(5);
      singlesFor("A5001");
      singleWorks.set("W1000", { ...(singleWorks.get("W1000") as object), ...change });
      const p = await project();
      const r = runner();
      const { added } = await r.add(p.id, [NAME]);
      await stateIs(p, added[0]!.id, "choose-works");
      const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
      await settled(p, kids[0]!.id);
      const e = (await entryOf(p, kids[0]!.id))!;
      expect(e.state).toBe("choose");
      expect(e.candidates).toHaveLength(1);
      expect(e.candidates![0]!.id).toBe("W1000");
      if (what === "another DOI") expect(e.candidates![0]!.identifiers.doi).toBe("10.5555/something.else");
      else expect(e.candidates![0]!.title).toBe("Something Else Entirely");
      expect(repo.listSourceIds(p.id)).toEqual([]);
      // The researcher may take it: the record is made from that fresh candidate.
      const done = await r.choose(p.id, kids[0]!.id, "W1000");
      expect(done.state).toBe("record-complete");
    });
  }

  it("R273 I2: a ticked work with no DOI whose fresh title only begins with the kept one: choose, nothing created", async () => {
    onePerson(5);
    personWorks.set("A5001", [{ ...oaWork(1000, "The State", "2025-12-01"), doi: undefined }]);
    singleWorks.set("W1000", { ...oaWork(1000, "The Statesman's Yearbook", "2025-12-01"), doi: undefined });
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
    await settled(p, kids[0]!.id);
    const e = (await entryOf(p, kids[0]!.id))!;
    expect(e.state).toBe("choose");
    expect(e.candidates![0]!.title).toBe("The Statesman's Yearbook");
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("M4: same id, same DOI and title: record complete as now", async () => {
    onePerson(5);
    singlesFor("A5001");
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    await stateIs(p, added[0]!.id, "choose-works");
    const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
    await settled(p, kids[0]!.id);
    expect((await entryOf(p, kids[0]!.id))!.state).toBe("record-complete");
    const made = await sourcesOf(p);
    // The record comes from the fresh single-work answer: it holds the second author only that answer carries.
    expect(made[0]!.source.creators.map((c) => c.family)).toEqual(["Brackwater", "Marsh"]);
  });

  for (const [what, fresh, state] of [
    ["the same full title is the same work: record complete", (full: string) => full, "record-complete"],
    ["a full title differing in an early word is not: choose, no source", (full: string) => full.replace("Long", "Wide"), "choose"],
  ] as const) {
    it(`R273 I2: a list title longer than the limit is kept cut; ${what}`, async () => {
      const full = `Tidal Ledger Long${" commercialization of human feeling".repeat(20)}`;
      onePerson(5);
      personWorks.set("A5001", [oaWork(1000, full, "2025-12-01", "10.5555/ao.f8.w1000")]);
      singleWorks.set("W1000", oaWork(1000, fresh(full), "2025-12-01", "10.5555/ao.f8.w1000"));
      const p = await project();
      const r = runner();
      const { added } = await r.add(p.id, [NAME]);
      await stateIs(p, added[0]!.id, "choose-works");
      const { added: kids } = await r.chooseWorks(p.id, added[0]!.id, ["W1000"]);
      await settled(p, kids[0]!.id);
      expect((await entryOf(p, kids[0]!.id))!.state).toBe(state);
      expect(repo.listSourceIds(p.id)).toHaveLength(state === "choose" ? 0 : 1);
    });
  }

  it("M5: tick, remove the added entry, tick again: added again; two calls at once with the same id add it once", async () => {
    onePerson(10);
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [NAME]);
    const pid = added[0]!.id;
    await stateIs(p, pid, "choose-works");
    const { added: k1 } = await r.chooseWorks(p.id, pid, ["W1005"]);
    await expect(r.chooseWorks(p.id, pid, ["W1005"])).rejects.toBeInstanceOf(FindAlreadyAddedError);
    await r.remove(p.id, k1[0]!.id);
    expect(await addedFrom(p, pid)).toEqual([]);
    const { added: k2 } = await r.chooseWorks(p.id, pid, ["W1005"]);
    expect(k2[0]!.work).toBe("W1005");
    expect(await addedFrom(p, pid)).toEqual(["W1005"]);
    const both = await Promise.allSettled([r.chooseWorks(p.id, pid, ["W1006"]), r.chooseWorks(p.id, pid, ["W1006"])]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((both.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(FindAlreadyAddedError);
    expect(await addedFrom(p, pid)).toEqual(["W1005", "W1006"]);
  });

  it("M6: morePeople is dropped once a person is chosen", async () => {
    know("Smith", cr(), OA_EMPTY);
    peopleAnswers.set("Smith", peopleOf(Array.from({ length: 20 }, (_, i) => oaPerson(6000 + i, `${String.fromCharCode(65 + i)}. Smith`)), 40));
    personWorks.set("A6003", worksFor(4));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, ["Smith"]);
    await stateIs(p, added[0]!.id, "choose-person");
    expect((await entryOf(p, added[0]!.id))!.morePeople).toBe(true);
    const pressed = await r.choosePerson(p.id, added[0]!.id, "A6003");
    expect(pressed.morePeople).toBeUndefined();
    await stateIs(p, added[0]!.id, "choose-works");
    expect((await entryOf(p, added[0]!.id))!.morePeople).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task F11: the free copy — looked for, downloaded, checked against its record, attached or held for the researcher.

describe("F11: the free copy of a record the queue completed", () => {
  /** The free-copy answers of OpenAlex (`works/doi:<doi>`): the addresses of its locations, in order. */
  let oaCopies: Map<string, string[]>;
  /** What each file address answers: a PDF's bytes; absent: 404. */
  let files: Map<string, Buffer>;
  /** File addresses held until released (a download in flight). */
  let holdFiles: Set<string>;
  type Held = { key: string; aborted: boolean; respond(status: number, body: Buffer | null): void };
  let heldFiles: Held[];
  let fileRequests: string[];
  let copyRequests: string[];
  let fileAgent: MockAgent;
  let saved: Dispatcher;
  /** R282 e: OpenAlex's free-copy answers fail (503). */
  let oaDown: boolean;

  const COPY_ONLY_OPENALEX = (): SearchSettings => ({ ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: c.id === "openalex" })) });
  /** Ordinary text of a first page, so that a made-up file has readable text (the file check asks for 200 characters, R282). */
  const PAGE = ["The study reads how people speak of their habits over many years, drawing on letters and", "interviews kept in family hands, and argues that the words they choose shape what they", "are able to remember of the places they have lived in and of the work they have done there."];
  const GOOD_LINES = ["Journal of Invented Studies 4 (1999)", ZORBLATT.title, "Mirabel Quillfeather", `doi:${ZORBLATT.doi}`, "Abstract. A grammar of habitus, invented for these tests, with enough words.", ...PAGE];
  const good = () => buildPdf({ title: ZORBLATT.title, author: "Mirabel Quillfeather", lines: GOOD_LINES });
  const other = (n: number) => buildPdf({ title: `Another Paper ${n}`, lines: [`doi:10.5555/ao.f11.other${n}`, `Another Paper ${n}`, "Someone Else", "Abstract. Nothing to do with the record at all, but long enough.", ...PAGE] });

  const interceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
    const key = `${new URL(String(opts.origin)).origin}${opts.path}`;
    fileRequests.push(key);
    if (!holdFiles.has(key)) return dispatch(opts, handler);
    const h: Held = { key, aborted: false, respond: () => {} };
    const controller = {
      paused: false,
      aborted: false,
      reason: null,
      rawHeaders: null,
      rawTrailers: null,
      pause() {},
      resume() {},
      abort(reason: Error) {
        if (h.aborted) return;
        h.aborted = true;
        handler.onResponseError?.(controller as never, reason);
      },
    };
    handler.onRequestStart?.(controller as never, {});
    h.respond = (status, body) => {
      if (h.aborted) return;
      handler.onResponseStart?.(controller as never, status, {}, "OK");
      if (body) handler.onResponseData?.(controller as never, body);
      handler.onResponseEnd?.(controller as never, {});
    };
    heldFiles.push(h);
    return true;
  };

  function mockCopies(): void {
    agent
      .get("https://api.openalex.org")
      .intercept({ path: (p: string) => p.startsWith("/works/doi:"), method: "GET" })
      .reply((o) => {
        const doi = decodeURIComponent(String(o.path).slice("/works/doi:".length));
        copyRequests.push(String(o.path));
        if (oaDown) return { statusCode: 503, data: "unavailable" };
        const urls = oaCopies.get(doi) ?? [];
        const [best, ...rest] = urls;
        return {
          statusCode: 200,
          data: JSON.stringify({ id: "https://openalex.org/W1", ...(best ? { best_oa_location: { is_oa: true, pdf_url: best } } : {}), locations: rest.map((u) => ({ is_oa: true, pdf_url: u })) }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    fileAgent = new MockAgent();
    fileAgent.disableNetConnect();
    for (const origin of ["https://arxiv.org", "https://europepmc.org", "https://library.oapen.org"]) {
      fileAgent
        .get(origin)
        .intercept({ path: () => true, method: "GET" })
        .reply((o) => {
          const body = files.get(`${origin}${String(o.path)}`);
          return body ? { statusCode: 200, data: body } : { statusCode: 404, data: "" };
        })
        .persist();
    }
    saved = getGlobalDispatcher();
    setGlobalDispatcher(fileAgent.compose(interceptor));
  }

  beforeEach(() => {
    oaCopies = new Map();
    files = new Map();
    holdFiles = new Set();
    heldFiles = [];
    fileRequests = [];
    copyRequests = [];
    oaDown = false;
    settings = COPY_ONLY_OPENALEX();
    mockCopies();
  });
  afterEach(async () => {
    for (const h of heldFiles) h.respond(500, null);
    setGlobalDispatcher(saved);
    await fileAgent.close();
  });

  const DONE: FindState[] = ["in-library", "no-open-copy", "needs-check", "failed"];
  /** The copy part is over: its last state written and said, its folder removed and given up. */
  const copyDone = async (p: Project, id: string, r: Repo = repo) => {
    await until(async () => DONE.includes((await entryOf(p, id, r))?.state ?? "looking-up"), "the free copy to be done");
    const state = (await entryOf(p, id, r))!.state;
    await until(() => changes.some((c) => c.entryId === id && c.state === state), "its event");
    await until(async () => !activeTemp.has(`find-${id}`) && !(await exists(folderOf(id))), "its folder to go");
  };
  /** A typed line made into a record (copies off), then the copy part started with `copies` on. */
  async function recordMade(o: { encrypted?: boolean; gov?: string } = {}): Promise<{ p: Project; r: FindRunner; eid: string; sid: string }> {
    know(LINE, cr(ZORBLATT));
    const p = await project(o);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await until(async () => !!(await entryOf(p, added[0]!.id))?.sourceId, "the record");
    return { p, r, eid: added[0]!.id, sid: (await entryOf(p, added[0]!.id))!.sourceId! };
  }
  const pendingReviews = async (p: Project) => (await readReviewEntries(coreOf(), coreOf().state(p.id))).filter((e) => e.status === "pending");
  const heldDirOf = (p: Project) => join(lib.root, p.folder, "find", "held");
  const folderOf = (eid: string) => join(lib.root, ".tmp", `find-${eid}`);
  const exists = (path: string) => readdir(path).then(
    () => true,
    () => false,
  );

  it("cleanAcquiredAddress removes the user name, password, query and fragment", () => {
    expect(cleanAcquiredAddress("https://user:secret@europepmc.org/articles/PMC1?pdf=render&token=abc#page=2")).toBe("https://europepmc.org/articles/PMC1");
    expect(cleanAcquiredAddress("https://arxiv.org/pdf/2101.00001")).toBe("https://arxiv.org/pdf/2101.00001");
    expect(cleanAcquiredAddress("not an address")).toBe("");
  });

  it("nothing is asked and nothing downloaded when the rules do not allow free_copy, and the entry says so in words", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    const { p, eid } = await recordMade({ gov: GOV("acquireMethods: [reference_lookup]") });
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-not-allowed", "the refusal");
    const e = (await entryOf(p, eid))!;
    expect(e).toMatchObject({ state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
    // Not tried again by itself: only the next open or unlock looks again.
    await new Promise((res) => setTimeout(res, 50));
    expect(copyRequests).toEqual([]);
  });

  it("an entry already in the library is never fetched for", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    know(LINE, cr(ZORBLATT));
    const p = await project();
    await importLikeAttach(p, ZORBLATT);
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    await settled(p, added[0]!.id);
    await new Promise((res) => setTimeout(res, 50));
    expect((await entryOf(p, added[0]!.id))!.state).toBe("already");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("the first passing offer is attached and nothing is held; the provenance of the file says free_copy, the service and a clean address", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001", "https://europepmc.org/articles/PMC77?pdf=render", "https://arxiv.org/pdf/2101.00003"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    files.set("https://europepmc.org/articles/PMC77?pdf=render", await good());
    files.set("https://arxiv.org/pdf/2101.00003", await good());
    const { p, eid, sid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
    const sf = await repo.getSource(p.id, sid);
    expect(sf.assets).toHaveLength(1);
    expect(sf.assets[0]).toMatchObject({
      role: "original",
      kind: "pdf",
      mime: "application/pdf",
      acquired: { method: "free_copy", via: "service", service: "openalex", address: "https://europepmc.org/articles/PMC77", access: "public", tool: { name: FIND_TOOL }, check: { result: "match", by: "title" } },
    });
    // R292: a match is always by "title" (a DOI is never evidence). The third offer was never asked for; nothing is held; the folder is gone.
    expect(fileRequests.filter((k) => k.includes("2101.00003"))).toEqual([]);
    expect(await pendingReviews(p)).toEqual([]);
    expect(await exists(heldDirOf(p))).toBe(false);
    expect(await exists(folderOf(eid))).toBe(false);
    expect(activeTemp.has(`find-${eid}`)).toBe(false);
    expect(changes.filter((c) => c.entryId === eid).map((c) => c.state)).toEqual(["looking-up", "record-complete", "looking-for-copy", "fetching", "in-library"]);
  });

  // R293 a: the record's container title reaches the check (clause 4: a line holding it may stand directly above the title).
  const journalAbove = () => buildPdf({ title: ZORBLATT.title, author: "Mirabel Quillfeather", lines: ["Journal of Invented Studies", ZORBLATT.title, "Mirabel Quillfeather", `doi:${ZORBLATT.doi}`, ...PAGE] });
  it("R293 a: a file whose journal's name stands alone above the title is attached when the record names that journal", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await journalAbove());
    const { p, eid, sid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
    expect((await repo.getSource(p.id, sid)).assets).toHaveLength(1);
  });
  it("R293 a: the same file is held when the record names no journal", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await journalAbove());
    know(LINE, cr({ ...ZORBLATT, noContainer: true }));
    const p = await project();
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    const eid = added[0]!.id;
    await until(async () => !!(await entryOf(p, eid))?.sourceId, "the record");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "needs-check", reason: { code: "file-other-kind" } });
  });

  it("no offer passes: the first failing file is held, one per entry, and the entry needs a check", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001", "https://arxiv.org/pdf/2101.00002"]);
    const first = await other(1);
    files.set("https://arxiv.org/pdf/2101.00001", first);
    files.set("https://arxiv.org/pdf/2101.00002", await other(2));
    const { p, eid, sid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "needs-check", reason: { code: "file-other-doi" } });
    expect((await repo.getSource(p.id, sid)).assets).toEqual([]);
    expect(await readdir(heldDirOf(p))).toEqual([`${eid}.pdf`]);
    expect((await readFile(join(heldDirOf(p), `${eid}.pdf`))).equals(first)).toBe(true);
    const [rev, ...more] = await pendingReviews(p);
    expect(more).toEqual([]);
    expect(rev).toMatchObject({ sourceId: sid, cause: { kind: "acquired-file-mismatch", findEntryId: eid }, heldFile: { why: "other-doi", kind: "pdf", fileDoi: "10.5555/ao.f11.other1", acquired: { service: "openalex", address: "https://arxiv.org/pdf/2101.00001" } } });
    expect(await exists(folderOf(eid))).toBe(false);
  });

  it("Use this file attaches the held file and the entry is in the library; Not this file destroys the held copy", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    know(LINE_2, cr(ZORBLATT));
    const { p, r, eid, sid } = await recordMade();
    await copyDone(p, eid);
    const [rev] = await pendingReviews(p);
    const done = await r.resolveHeld(p.id, rev!.id, "attach");
    expect(done?.state).toBe("in-library");
    expect((await repo.getSource(p.id, sid)).assets[0]!.acquired).toMatchObject({ method: "free_copy", service: "openalex", check: { result: "accepted-after-mismatch", why: "other-doi" } });
    expect(await readdir(heldDirOf(p))).toEqual([]);
    expect(changes.at(-1)).toEqual({ projectId: p.id, entryId: eid, state: "in-library" });
  });

  it("Not this file: the held copy is destroyed and the entry has no open copy, saying why", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    const { p, r, eid } = await recordMade();
    await copyDone(p, eid);
    const [rev] = await pendingReviews(p);
    const done = await r.resolveHeld(p.id, rev!.id, "discard");
    expect(done).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
    expect(await readdir(heldDirOf(p))).toEqual([]);
    expect(await pendingReviews(p)).toEqual([]);
  });

  it("removing the entry discards its held file and closes its review entry", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    const { p, r, eid } = await recordMade();
    await copyDone(p, eid);
    await r.remove(p.id, eid);
    expect(await readdir(heldDirOf(p))).toEqual([]);
    expect(await pendingReviews(p)).toEqual([]);
    expect(await entryOf(p, eid)).toBeUndefined();
  });

  it(`${FIND_HELD_MAX} held: the next mismatched file is not kept and the entry says so, with Try again`, async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    know(LINE, cr(ZORBLATT));
    const p = await project();
    // Twenty files already wait in this project.
    const scratch = join(tmp, "x.pdf");
    await writeFile(scratch, await other(9));
    await importLikeAttach(p, { ...ZORBLATT, doi: "10.5555/ao.f11.someother", title: "Some Other Work Entirely" });
    const otherSid = repo.listSourceIds(p.id)[0]!;
    const waiting: FindEntry[] = Array.from({ length: FIND_HELD_MAX }, () => ({ id: newId(), projectId: p.id, typed: "x y", state: "fetching", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 0, sourceId: otherSid }));
    await appendFindEntries(coreOf(), p.id, waiting, "add");
    for (const w of waiting) {
      await holdMismatchedFile(coreOf(), p.id, {
        entry: { ...w, state: "needs-check" },
        sourceId: otherSid,
        fromPath: scratch,
        facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "free_copy", via: "service", address: "https://arxiv.org/pdf/1", at: new Date(NOW).toISOString(), tool: { name: FIND_TOOL, version: "0" }, access: "public" } },
      });
    }
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    const eid = added[0]!.id;
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "failed", reason: { code: "held-full" } });
    expect(await readdir(heldDirOf(p))).toHaveLength(FIND_HELD_MAX);
    expect((await readdir(heldDirOf(p))).some((n) => n.startsWith(eid))).toBe(false);
    expect(await exists(folderOf(eid))).toBe(false);
    // Try again looks for a copy again (never for the record).
    const again = await r.retry(p.id, eid);
    expect(again.state).toBe("looking-for-copy");
    await copyDone(p, eid);
    expect((await sourcesOf(p)).length).toBe(2);
  });

  it("no offer: no open copy, with the 'elsewhere' links for Where to get it", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://repository.example.edu/bitstream/zorblatt.pdf"]);
    const { p, eid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", offers: [{ label: "A free copy may be at", host: "repository.example.edu", url: "https://repository.example.edu/bitstream/zorblatt.pdf" }] });
    expect(fileRequests).toEqual([]);
  });

  it("the folder is held in use from before the first download until the file is stored, and removed when the entry is done", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, eid, sid } = await recordMade();
    await until(() => heldFiles.length === 1, "the download to start");
    expect(activeTemp.has(`find-${eid}`)).toBe(true);
    heldFiles[0]!.respond(200, await good());
    // Still held while the file is checked and stored; given up and removed once it is.
    await until(async () => (await repo.getSource(p.id, sid)).assets.length === 1 || !activeTemp.has(`find-${eid}`), "the file to be stored");
    expect((await repo.getSource(p.id, sid)).assets).toHaveLength(1);
    await copyDone(p, eid);
    expect(activeTemp.has(`find-${eid}`)).toBe(false);
    expect(await exists(folderOf(eid))).toBe(false);
  });

  for (const how of ["lock", "close"] as const) {
    it(`a ${how} during a download: aborted, nothing left, nothing written after it`, async () => {
      oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
      holdFiles.add("https://arxiv.org/pdf/2101.00001");
      const { p, r, eid } = await recordMade({ encrypted: true });
      await until(() => heldFiles.length === 1, "the download to start");
      const queueBytes = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
      const auditBefore = await auditText(p);
      if (how === "lock") {
        r.stop(p.id);
        repo.lockProject(p.id);
      } else await r.stopAll();
      await until(() => heldFiles[0]!.aborted, "the download to be aborted");
      await until(async () => !(await exists(folderOf(eid))), "the folder to go");
      expect(activeTemp.has(`find-${eid}`)).toBe(false);
      await new Promise((res) => setTimeout(res, 50));
      expect(await readFile(join(lib.root, p.folder, "find", "queue.jsonl"))).toEqual(queueBytes);
      expect(await auditText(p)).toBe(auditBefore);
      if (how === "lock") {
        // Unlocked, it resumes as looking for a copy, and goes on.
        await repo.unlockProject(p.id, "pw");
        holdFiles.clear();
        files.set("https://arxiv.org/pdf/2101.00001", await good());
        r.resume(p.id);
        await copyDone(p, eid);
        expect(changes.filter((c) => c.entryId === eid).map((c) => c.state).slice(-3)).toEqual(["looking-for-copy", "fetching", "in-library"]);
      }
    });
  }

  it("a crash during fetching resumes as looking for a copy; nothing is half-attached", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    know(LINE, cr(ZORBLATT));
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const p = await project();
    // The crash comes in the change that attaches the file: the marker is left, as if the process died there.
    const r = runner();
    const { added } = await r.add(p.id, [LINE]);
    const eid = added[0]!.id;
    await until(() => heldFiles.length === 1, "the download to start");
    seams.crashAt = "before-audit";
    heldFiles[0]!.respond(200, await good());
    await until(() => notes.some((n) => n.includes("SimulatedCrash")), "the crash");
    expect((await entryOf(p, eid))!.state).toBe("fetching");
    // A new process: the marker rolls the half change back; the entry resumes as looking for a copy.
    for (const x of runners) await x.stopAll();
    runners = [];
    handle.close();
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    handle = new IndexHandle(lib.root);
    repo = await repoFor();
    const sid = (await entryOf(p, eid))!.sourceId!;
    expect((await repo.getSource(p.id, sid)).assets).toEqual([]);
    holdFiles.clear();
    changes = [];
    runner().resume(p.id);
    await copyDone(p, eid);
    expect(changes.filter((c) => c.entryId === eid).map((c) => c.state)).toEqual(["looking-for-copy", "fetching", "in-library"]);
    expect((await repo.getSource(p.id, sid)).assets).toHaveLength(1);
  });

  it("a crash after the file is attached and before the entry's line: resumed, the entry is in the library, the file attached once", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    const { p, eid, sid } = await recordMade();
    await until(async () => (await repo.getSource(p.id, sid)).assets.length === 1, "the file");
    await copyDone(p, eid);
    // As if the line had not been written: the entry back at "fetching" beside a source with its file.
    const cur = (await entryOf(p, eid))!;
    await appendFindEntries(coreOf(), p.id, [{ ...cur, state: "fetching", updatedAt: new Date(NOW + 1).toISOString() }], "update");
    const n = fileRequests.length;
    runner().resume(p.id);
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
    expect((await repo.getSource(p.id, sid)).assets).toHaveLength(1);
    expect(fileRequests.length).toBe(n);
  });

  it("no title, address or file name in any audit entry, log line or event", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001", "https://arxiv.org/pdf/2101.00002"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    files.set("https://arxiv.org/pdf/2101.00002", await other(2));
    const { p, r, eid } = await recordMade();
    await copyDone(p, eid);
    const [rev] = await pendingReviews(p);
    await r.resolveHeld(p.id, rev!.id, "attach");
    const audit = await auditText(p);
    const logs = notes.join("\n");
    for (const s of ["Zorblatt", "Habitus", "Quillfeather", "arxiv.org", "2101.0000", "Another Paper", "10.5555/ao.f11", ".pdf", "find/held"]) {
      expect(audit, s).not.toContain(s);
      expect(logs, s).not.toContain(s);
    }
    for (const c of changes) expect(Object.keys(c).sort()).toEqual(["entryId", "projectId", "state"]);
  });

  it("Unpaywall is not asked without an e-mail", async () => {
    settings = { ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: c.id === "unpaywall" || c.id === "openalex" })) };
    const unpaywall: string[] = [];
    agent
      .get("https://api.unpaywall.org")
      .intercept({ path: () => true, method: "GET" })
      .reply((o) => {
        unpaywall.push(String(o.path));
        return { statusCode: 200, data: "{}" };
      })
      .persist();
    const { p, eid } = await recordMade();
    await copyDone(p, eid);
    expect(unpaywall).toEqual([]);
    expect(copyRequests.length).toBe(1);
  });

  it("a download is bounded as a whole: past FIND_DOWNLOAD_TIMEOUT_MS (its wait for a place included) it is aborted and leaves nothing", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, eid } = await recordMade();
    await until(() => heldFiles.length === 1, "the download to start");
    expect(FIND_DOWNLOAD_TIMEOUT_MS).toBe(240_000);
    timers.advance(FIND_DOWNLOAD_TIMEOUT_MS);
    await until(() => heldFiles[0]!.aborted, "the download to be aborted");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", offers: [{ host: "arxiv.org" }] });
    expect(await exists(folderOf(eid))).toBe(false);
  });

  // ------------------------------------------------------------------------------------------------------------
  // Round 2 (R282 d–g)

  it("R282 e: every free-copy service asked failing is not 'no open copy': the entry waits and is tried again like an unreachable lookup, then failed with Try again", async () => {
    oaDown = true;
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    const { p, r, eid } = await recordMade();
    await until(async () => !!(await entryOf(p, eid))?.nextTryAt, "the wait");
    expect((await entryOf(p, eid))!).toMatchObject({ state: "looking-for-copy", attempts: 1 });
    for (const [i, d] of FIND_RETRY_DELAYS_MS.entries()) {
      const before = copyRequests.length;
      await until(() => timers.pending.size > 0, "the retry's timer");
      timers.advance(d);
      await until(() => copyRequests.length > before, `try ${i + 2}`);
      await until(async () => (await entryOf(p, eid))!.attempts === i + 2, `attempt ${i + 2} written`);
    }
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "failed", reason: { code: "unreachable" } });
    // The services are back: Try again looks for a copy again.
    oaDown = false;
    expect((await r.retry(p.id, eid)).state).toBe("looking-for-copy");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
  });

  it("R282 e: some services failing and no offer: no open copy saying so, and Try again is accepted", async () => {
    // Semantic Scholar has no answer in this world (the request fails); OpenAlex answers that it knows no copy.
    settings = { ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: c.id === "openalex" || c.id === "semanticscholar" })) };
    const { p, r, eid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", reason: { code: "copy-some-unreachable" } });
    // Semantic Scholar answers now, with a copy.
    agent
      .get("https://api.semanticscholar.org")
      .intercept({ path: (q: string) => q.startsWith("/graph/v1/paper/DOI:"), method: "GET" })
      .reply(200, JSON.stringify({ openAccessPdf: { url: "https://arxiv.org/pdf/2101.00001" } }), { headers: { "content-type": "application/json" } });
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    expect((await r.retry(p.id, eid)).state).toBe("looking-for-copy");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
  });

  it("R282 e: a plain no open copy (every service answered) is not retried", async () => {
    const { p, r, eid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("no-open-copy");
    expect((await entryOf(p, eid))!.reason).toBeUndefined();
    await expect(r.retry(p.id, eid)).rejects.toBeInstanceOf(FindEntryStateError);
  });

  it("R282 f: Try again on an entry the rules stopped evaluates the rules again: still refused, it says so; allowed, it goes on", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    const { p, r, eid } = await recordMade({ gov: GOV("acquireMethods: [reference_lookup]") });
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-not-allowed", "the refusal");
    // Still refused: said again, nothing asked.
    await r.retry(p.id, eid);
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-not-allowed", "the refusal again");
    expect(copyRequests).toEqual([]);
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, GOV("acquireMethods: [reference_lookup, free_copy]"), { baseSha256: sha256, reason: "free copies allowed" });
    expect((await r.retry(p.id, eid)).state).toBe("looking-for-copy");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
  });

  it("R282 f: the rules saved to allow free copies, resume goes on with the entry they had stopped (no restart)", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await good());
    const { p, r, eid } = await recordMade({ gov: GOV("acquireMethods: [reference_lookup]") });
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-not-allowed", "the refusal");
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, GOV("acquireMethods: [reference_lookup, free_copy]"), { baseSha256: sha256, reason: "free copies allowed" });
    r.resume(p.id);
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
  });

  it("R282 g (M1): the source deleted while its file is held: the held file and its review entry go, and the entry says the record was removed, in the deletion's change; only its removal is offered", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    files.set("https://arxiv.org/pdf/2101.00001", await other(1));
    const { p, r, eid, sid } = await recordMade();
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("needs-check");
    await repo.deleteSource(p.id, sid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", reason: { code: "record-removed" } });
    expect(await readdir(heldDirOf(p))).toEqual([]);
    expect(await pendingReviews(p)).toEqual([]);
    await expect(r.retry(p.id, eid)).rejects.toBeInstanceOf(FindEntryStateError);
    await r.remove(p.id, eid);
    expect(await entryOf(p, eid)).toBeUndefined();
  });

  it("R282 g (M1): the source deleted during a download: the download is aborted and dropped, the entry says the record was removed, nothing is left", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, eid, sid } = await recordMade();
    await until(() => heldFiles.length === 1, "the download to start");
    await repo.deleteSource(p.id, sid);
    timers.advance(FIND_SOURCE_WATCH_MS);
    await until(() => heldFiles[0]!.aborted, "the download to be aborted");
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", reason: { code: "record-removed" } });
    expect((await entryOf(p, eid))!.offers).toBeUndefined();
    expect(await exists(folderOf(eid))).toBe(false);
    expect(await exists(heldDirOf(p))).toBe(false);
  });

  for (const file of ["matching", "mismatched"] as const) {
    it(`R282 g (M1): the source deleted before a ${file} file is stored (the watch not yet run): nothing is attached or held; the record was removed`, async () => {
      oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
      holdFiles.add("https://arxiv.org/pdf/2101.00001");
      const { p, eid, sid } = await recordMade();
      await until(() => heldFiles.length === 1, "the download to start");
      await repo.deleteSource(p.id, sid);
      heldFiles[0]!.respond(200, file === "matching" ? await good() : await other(1));
      await copyDone(p, eid);
      expect((await entryOf(p, eid))!).toMatchObject({ state: "no-open-copy", reason: { code: "record-removed" } });
      expect(await exists(heldDirOf(p))).toBe(false);
      expect(await pendingReviews(p)).toEqual([]);
    });
  }

  it("R282 g (M2): removing an entry aborts its download; nothing is left", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, r, eid } = await recordMade();
    await until(() => heldFiles.length === 1, "the download to start");
    await r.remove(p.id, eid);
    await until(() => heldFiles[0]!.aborted, "the download to be aborted");
    await until(async () => !activeTemp.has(`find-${eid}`) && !(await exists(folderOf(eid))), "its folder to go");
    expect(await entryOf(p, eid)).toBeUndefined();
  });

  it("R282 g (M5): a source that gained a readable file meanwhile is not given a second one by the runner; the entry is in the library", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, eid, sid } = await recordMade();
    await until(() => heldFiles.length === 1, "the download to start");
    // The researcher attaches a file by hand meanwhile.
    const mine = join(tmp, "mine.pdf");
    await writeFile(mine, await good());
    await addCapturedOriginal(repo, p.id, sid, { fromPath: mine, kind: "pdf", ext: "pdf", mime: "application/pdf", label: "mine" }, "manual_upload");
    heldFiles[0]!.respond(200, await good());
    await copyDone(p, eid);
    expect((await entryOf(p, eid))!.state).toBe("in-library");
    const assets = (await repo.getSource(p.id, sid)).assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]!.acquired).toBeUndefined();
  });

  const IDENT = (basis: boolean) => `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: ${basis}
processing:
  metadata_lookup: [crossref, openalex]
`;

  it("R282 g (M8): the rules' store part refusing the file at attach is said as such (a missing legal basis), not as the free-copy rule", async () => {
    oaCopies.set(ZORBLATT.doi!, ["https://arxiv.org/pdf/2101.00001"]);
    holdFiles.add("https://arxiv.org/pdf/2101.00001");
    const { p, eid, sid } = await recordMade({ gov: IDENT(false) });
    expect((await repo.getSourceRecord(p.id, sid)).provenance.identifiable).toBe(true);
    await until(() => heldFiles.length === 1, "the download to start");
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, IDENT(true), { baseSha256: sha256 });
    heldFiles[0]!.respond(200, await good());
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-no-legal-basis", "the store refusal");
    expect((await entryOf(p, eid))!).toMatchObject({ state: "record-complete", reason: { code: "copy-no-legal-basis", by: "rules" } });
    expect((await repo.getSource(p.id, sid)).assets).toEqual([]);
    await until(async () => !(await exists(folderOf(eid))), "the folder to go");
  });

  it("R282 g (M8): rules whose store part refuses: nothing is asked; the entry says why", async () => {
    settings = { ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: false })) };
    const { p, r, eid } = await recordMade({ gov: IDENT(false) });
    await until(() => changes.some((c) => c.entryId === eid && c.state === "record-complete"), "the record");
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, IDENT(true), { baseSha256: sha256 });
    settings = COPY_ONLY_OPENALEX();
    r.resume(p.id);
    await until(async () => (await entryOf(p, eid))?.reason?.code === "copy-no-legal-basis", "the store refusal");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });
});
