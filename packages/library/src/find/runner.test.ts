import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE, findDuplicate, newId, type Project, type SourceDraft } from "@ao/core";
import { Dispatcher, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { IndexHandle, createIndexSink } from "../index/index.js";
import { findSourceBy } from "../index/db.js";
import { HttpClient } from "../lookup/http.js";
import { serialStore } from "../import/project-queue.js";
import { InvalidInputError, ReadOnlyLibraryError } from "../repo/errors.js";
import type { Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { SimulatedCrash, openTestRepo, seams } from "../repo/testing.js";
import { parseReference } from "./reference.js";
import { decideMatch, searchWorks } from "./search.js";
import { FindQueueFullError, appendFindEntries, readFindQueue } from "./queue-store.js";
import {
  FIND_CONCURRENCY,
  FIND_ENTRY_KEY,
  FIND_RETRY_DELAYS_MS,
  FIND_TOOL,
  FindEntryStateError,
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
let everything: boolean;
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
  constructor(private readonly inner: MockAgent) {
    super();
  }
  hold(text: string): () => void {
    let release!: () => void;
    this.holds.set(
      text,
      new Promise<void>((r) => (release = r)),
    );
    return () => {
      release();
      this.holds.delete(text);
    };
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const gate = this.holds.get(textOf(String(opts.path)) ?? "");
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
  openTestRepo(l, ring, { tz: "UTC", actor: "tester", scryptN: 2 ** 10, index: createIndexSink(handle, { root: l.root, keyRing: ring }) });
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
    clock: () => httpNow,
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
  repo = await repoFor();
  timers = new FakeTimers();
  runners = [];
  notes = [];
  changes = [];
  asked = [];
  answers = new Map();
  settings = DEFAULT_SEARCH_SETTINGS;
  everything = false;
  mockServices();
});
afterEach(async () => {
  for (const r of runners) await r.stopAll();
  seams.crashAt = undefined;
  runnerSeams.beforeCreate = undefined;
  runnerSeams.afterCreate = undefined;
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
    settings: async () => settings,
    checkEverything: () => everything,
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
async function importLikeAttach(p: Project, w: Work): Promise<void> {
  await serialStore(repo, p.id, async () => {
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
    const err = await r.add(p.id, ["SECRETWORDqz", "y"]).catch((e: unknown) => e as Error);
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
    await until(() => asked.length > 0 || notes.length > 0, "the lookup to start");
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

  it("an entry and a drag-and-drop import of the same DOI at the same moment: one source, and the entry tells the truth", async () => {
    for (let round = 0; round < 3; round++) {
      know(LINE, cr(ZORBLATT));
      const p = await project();
      const r = runner();
      const [{ added }] = await Promise.all([r.add(p.id, [LINE]), importLikeAttach(p, ZORBLATT)]);
      await settled(p, added[0]!.id);
      const sources = await sourcesOf(p);
      expect(sources).toHaveLength(1);
      const e = (await entryOf(p, added[0]!.id))!;
      if (e.state === "already") expect(e.duplicateOf).toBe(sources[0]!.source.id);
      else {
        expect(e.state).toBe("record-complete");
        expect(e.sourceId).toBe(sources[0]!.source.id);
      }
    }
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
    const release = gated.hold(parseReference(LINE)!.text);
    const r = runner();
    const first = await r.add(p.id, [LINE]);
    await until(() => true);
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
    lib = await openLibrary(lib.root, mkDeps());
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
      const askedBefore = asked.length;
      runner().resume(p.id);
      await settled(p, added[0]!.id);
      expect(asked.length).toBe(askedBefore);
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
      const askedBefore = asked.length;
      runner().resume(p.id);
      await new Promise((res) => setTimeout(res, 100));
      expect(asked.length).toBe(askedBefore);
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
    const { sha256 } = await repo.getGovernance(p.id);
    await repo.setGovernance(p.id, GOV("acquireMethods: [free_copy]"), { baseSha256: sha256 });
    release();
    await settled(p, added[0]!.id);
    expect((await entryOf(p, added[0]!.id))!).toMatchObject({ state: "failed", reason: { code: "not-allowed", by: "rules" } });
    expect(await sourcesOf(p)).toEqual([]);
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
    await until(async () => (await entryOf(p, id))?.attempts === 1, "the first failure");
    let e = (await entryOf(p, id))!;
    expect(e.state).toBe("looking-up");
    expect(e.nextTryAt).toBe(new Date(timers.now + FIND_RETRY_DELAYS_MS[0]!).toISOString());
    for (let i = 0; i < FIND_RETRY_DELAYS_MS.length; i++) {
      const before = asked.length;
      timers.advance(FIND_RETRY_DELAYS_MS[i]! - 1);
      await new Promise((res) => setTimeout(res, 30));
      expect(asked.length).toBe(before);
      timers.advance(1);
      await until(async () => (await entryOf(p, id))!.attempts === i + 2, `attempt ${i + 2}`);
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

  it("one service failing does not fail an entry that still got candidates", async () => {
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
    await until(() => asked.filter((x) => x.service === "crossref").length >= 0, "start");
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
    const queueBytes = await readFile(join(lib.root, p.folder, "find", "queue.jsonl"));
    r.stop(p.id);
    release();
    await until(() => asked.length >= 1, "the late answer");
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
    await until(async () => (await entryOf(p, added[0]!.id))?.attempts === 1, "a retry timer");
    expect(timers.pending.size).toBe(1);
    const release = gated.hold(parseReference(LINE_2)!.text);
    await r.add(p.id, [LINE_2]);
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
