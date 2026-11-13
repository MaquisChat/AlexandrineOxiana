import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createBulkImport } from "../import/bulk/index.js";
import { bibtexAdapter } from "../import/refman.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE, findDuplicate, newId, type Project, type SourceDraft } from "@ao/core";
import { Dispatcher, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { IndexHandle, createIndexSink } from "../index/index.js";
import { findSourceBy } from "../index/db.js";
import { HttpClient } from "../lookup/http.js";
import { serialStore } from "../import/project-queue.js";
import { InvalidInputError, ReadOnlyLibraryError } from "../repo/errors.js";
import { recoveryPendingProjects, type Repo } from "../repo/repo.js";
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
  FindEntryStateError,
  FindIndexNotReadyError,
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
    this.sent.push({ service, text });
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
  for (const service of ["crossref", "openalex"] as const) {
    agent
      .get(service === "crossref" ? "https://api.crossref.org" : "https://api.openalex.org")
      .intercept({ path: (p: string) => p.startsWith("/works?"), method: "GET" })
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
  settings = DEFAULT_SEARCH_SETTINGS;
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
type Work = { doi?: string; title: string; family: string; given?: string; year: number; type?: string };
const crItem = (w: Work) => ({
  ...(w.doi ? { DOI: w.doi } : {}),
  type: w.type ?? "journal-article",
  title: [w.title],
  author: [{ given: w.given ?? "Mirabel", family: w.family }],
  issued: { "date-parts": [[w.year]] },
  "container-title": ["Journal of Invented Studies"],
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
    const r = runner();
    const { choose } = await twoEntries(r, p);
    let release!: () => void;
    let entered = false;
    runnerSeams.inAct = async () => {
      entered = true;
      await new Promise<void>((res) => (release = res));
    };
    const order: string[] = [];
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
    expect(order.sort()).toEqual(["act done", "stopAll settled"]);
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
