/**
 * Find and acquire, slice 1: the service's routes, the event `find.progress` and the runner's life in the service
 * (Task F5; R225, R226, R237; plan Amendments A2, A3). The search services are made-up answers served as the global
 * dispatcher with `disableNetConnect` (the service's lookup client takes none of its own): nothing reaches the
 * network, and there is no test-only route or switch. A request can be held open ("a lookup held open") to cross a
 * lock, a close, a move or an index rebuild with it. Every log line, error answer and event of this file is kept and
 * searched for the typed words.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its lookup client uses) sets the global dispatcher.
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FindRunnerClosedError, deviceDeps, rebuildIndexIfNeeded, type Deps, type FindEntry } from "@ao/library";
import { FIND_REASON_CODES, FIND_REASON_TEXT, FIND_ROUTE_TEXT, FIND_STOPPED_TEXT, findAlreadyAddedRefusal, findWorkIdRefusal, type FindEntryView, type FindQueueResponse } from "@ao/shared";
import { serialStore } from "../../../packages/library/src/import/project-queue.js";
import { runnerSeams } from "../../../packages/library/src/find/runner.js";
import { appendFindEntriesIn, holdMismatchedFileIn } from "../../../packages/library/src/repo/repo.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { newId } from "@ao/core";
import { existsSync } from "node:fs";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";
import type { ServiceEvent } from "./events.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: [crossref, openalex]
`;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

// Made-up works (10.5555 is a test prefix; the people are invented). The typed words below are looked for in
// every log line, error and event.
const SECRET_WORDS = ["Zorblatt", "Quillfeather", "Vexmoor"];
const LINE = "Quillfeather, Zorblatt Grammar of Habitus, 1999";
const AMBIGUOUS = "Vexmoor Theory of Fields";
const NOTHING = "Quillfeather Nothing Anywhere Zorblatt";
type Work = { doi: string; title: string; family: string; year: number };
const ZORBLATT: Work = { doi: "10.5555/ao.f5.zorblatt", title: "Zorblatt Grammar of Habitus", family: "Quillfeather", year: 1999 };
const VEX_A: Work = { doi: "10.5555/ao.f5.vex.a", title: "Vexmoor Theory of Fields", family: "Mirabel", year: 2001 };
const VEX_B: Work = { doi: "10.5555/ao.f5.vex.b", title: "Vexmoor Theory of Fields", family: "Mirabel", year: 2004 };
const crItem = (w: Work) => ({ DOI: w.doi, type: "journal-article", title: [w.title], author: [{ given: "Ottoline", family: w.family }], issued: { "date-parts": [[w.year]] }, "container-title": ["Journal of Invented Studies"] });
const cr = (...ws: Work[]) => ({ status: "ok", "message-type": "work-list", message: { "total-results": ws.length, items: ws.map(crItem) } });
const OA_EMPTY = { meta: { count: 0, page: 1, per_page: 5 }, results: [] };

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService | undefined;
let events: ServiceEvent[];
let agent: MockAgent;
let gated: Gated;
let previous: Dispatcher;
/** Crossref's answer per typed text (cleaned as the library cleans it; our lines need no cleaning). */
let answers: Map<string, unknown>;
/** Every error answer of this file. */
const errorBodies: string[] = [];
/** Task F8: OpenAlex's people per typed text, a person's works (newest first) per id, single works per id. */
let peopleAnswers = new Map<string, unknown>();
let personWorks = new Map<string, unknown[]>();
let singles = new Map<string, unknown>();

function textOf(path: string): string {
  const q = new URL(`https://x${path}`).searchParams;
  return q.get("query.bibliographic") ?? q.get("search") ?? "";
}

/** The made-up services, with requests that can be held open until released. */
class Gated extends Dispatcher {
  private readonly holds = new Map<string, Promise<void>>();
  private all: { gate: Promise<void>; release: () => void } | undefined;
  /** FR-531: requests held by where they go (any service), until released. */
  private readonly where: Array<{ match: (origin: string, path: string) => boolean; gate: Promise<void>; release: () => void }> = [];
  readonly sent: Array<{ service: string; text: string; origin: string; path: string }> = [];
  constructor(private readonly inner: MockAgent) {
    super();
  }
  /** Holds Crossref's answer for `text` until the returned function is called. */
  hold(text: string): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.holds.set(text, gate);
    return () => {
      this.holds.delete(text);
      release();
    };
  }
  /** Holds every answer until `releaseAll`. */
  holdAll(): void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.all = { gate, release };
  }
  /** Holds every request `match` picks (by its origin and path) until the returned function is called. */
  holdWhere(match: (origin: string, path: string) => boolean): () => void {
    let release!: () => void;
    const h = { match, gate: new Promise<void>((r) => (release = r)), release: () => release() };
    this.where.push(h);
    return () => {
      const i = this.where.indexOf(h);
      if (i >= 0) this.where.splice(i, 1);
      h.release();
    };
  }
  releaseAll(): void {
    this.all?.release();
    this.all = undefined;
    for (const k of [...this.holds.keys()]) this.holds.delete(k);
    for (const h of this.where.splice(0)) h.release();
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const service = String(opts.origin).includes("crossref") ? "crossref" : "openalex";
    const text = textOf(String(opts.path));
    this.sent.push({ service, text, origin: String(opts.origin), path: String(opts.path) });
    const gate =
      (service === "crossref" ? this.holds.get(text) : undefined) ?? this.where.find((h) => h.match(String(opts.origin), String(opts.path)))?.gate ?? this.all?.gate;
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

function mockServices(): void {
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://api.crossref.org")
    .intercept({ path: (p: string) => p.startsWith("/works?"), method: "GET" })
    .reply((o) => ({ statusCode: 200, data: JSON.stringify(answers.get(textOf(String(o.path))) ?? cr()), responseOptions: { headers: { "content-type": "application/json" } } }))
    .persist();
  const json = (body: unknown) => ({ statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } });
  // Task F8: OpenAlex's people, a person's works and single works (made-up answers; nobody and nothing by default).
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/authors?"), method: "GET" })
    .reply((o) => json(peopleAnswers.get(textOf(String(o.path))) ?? { meta: { count: 0 }, results: [] }))
    .persist();
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works?") && p.includes("filter="), method: "GET" })
    .reply((o) => {
      const q = new URL(`https://x${String(o.path)}`).searchParams;
      const all = personWorks.get(/author\.id:(A\d+)/u.exec(q.get("filter") ?? "")?.[1] ?? "") ?? [];
      const n = Number(q.get("page"));
      return json({ meta: { count: all.length }, results: all.slice((n - 1) * 100, n * 100) });
    })
    .persist();
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => /^\/works\/W\d+$/u.test(p), method: "GET" })
    .reply((o) => {
      const w = singles.get(String(o.path).slice("/works/".length));
      return w ? json(w) : { statusCode: 404, data: "{}" };
    })
    .persist();
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works?") && !p.includes("filter="), method: "GET" })
    .reply(() => ({ statusCode: 200, data: JSON.stringify(OA_EMPTY), responseOptions: { headers: { "content-type": "application/json" } } }))
    .persist();
  // Task F11: a record made goes on to look for a free copy; in this made-up world no service has one.
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works/doi:"), method: "GET" })
    .reply(() => ({ statusCode: 404, data: "{}" }))
    .persist();
  for (const origin of ["https://export.arxiv.org", "https://www.ebi.ac.uk", "https://api.semanticscholar.org", "https://directory.doabooks.org", "https://archive.org"]) {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply(() => ({ statusCode: 404, data: "{}" }))
      .persist();
  }
  gated = new Gated(agent);
  previous = getGlobalDispatcher();
  setGlobalDispatcher(gated);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-routes-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  answers = new Map([
    [LINE, cr(ZORBLATT)],
    [AMBIGUOUS, cr(VEX_A, VEX_B)],
  ]);
  events = [];
  peopleAnswers = new Map();
  personWorks = new Map();
  singles = new Map();
  mockServices();
});
afterEach(async () => {
  gated.releaseAll();
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  // Whatever a test did, no typed word reached a log line, an error answer or an event.
  const seen = [logs, ...errorBodies, ...events.map((e) => JSON.stringify(e))].join("\n");
  for (const w of SECRET_WORDS) expect(seen.includes(w), `"${w}" was logged or sent`).toBe(false);
  errorBodies.length = 0;
  runnerSeams.inAct = undefined;
  runnerSeams.inCreate = undefined;
  await rm(tmp, { recursive: true, force: true });
  // Nothing comes back afterwards (R247 c: a late lookup answer never recreates a library folder).
  await sleep(100);
  expect(existsSync(tmp)).toBe(false);
});

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null, ...over });
  svc.state.events.subscribe((e) => events.push(e));
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string>; raw?: string };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined || r.raw !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.raw !== undefined ? { payload: r.raw } : r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  if (res.statusCode >= 400) errorBodies.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function openNewLibrary(name = "Lib"): Promise<string> {
  const path = join(tmp, name);
  const r = await call({ method: "POST", url: "/libraries", body: { path, name } });
  expect(r.status, r.body).toBe(200);
  return path;
}

async function newProject(encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

async function folderOf(pid: string): Promise<string> {
  const p = (await call({ url: "/projects" })).json.projects.find((x: { id: string }) => x.id === pid);
  return p.folder as string;
}

const queue = async (pid: string): Promise<FindQueueResponse> => {
  const r = await call({ url: `/projects/${pid}/find` });
  expect(r.status, r.body).toBe(200);
  return r.json as FindQueueResponse;
};
const entry = async (pid: string, eid: string): Promise<FindEntryView | undefined> => (await queue(pid)).entries.find((e) => e.id === eid);

async function add(pid: string, lines: string[]): Promise<FindEntryView[]> {
  const r = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines } });
  expect(r.status, r.body).toBe(200);
  return r.json.added as FindEntryView[];
}

async function until<T>(fn: () => Promise<T | undefined | false>, what = "the condition", ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const FINAL = ["choose", "already", "maybe-duplicate", "record-complete", "not-found", "failed", "no-open-copy", "in-library", "needs-check"];
/**
 * F11: a record the queue made goes on by itself to look for a free copy ("record-complete" → "looking-for-copy" →
 * …); this service's made-up services offer none, so such an entry ends "no-open-copy". Each of these says the record is made.
 */
const MADE = ["record-complete", "looking-for-copy", "fetching", "no-open-copy"];
const settled = (pid: string, eid: string) => until(async () => ((e) => (e && FINAL.includes(e.state) ? e : undefined))(await entry(pid, eid)), "the entry to settle");
const asked = (text: string) => gated.sent.filter((s) => s.service === "crossref" && s.text === text).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every file of the library (its lookup cache included) with its content, for "nothing changed". */
async function snapshot(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) Object.assign(out, await snapshot(dir, r));
    else out[r] = (await readFile(join(dir, r))).toString("base64");
  }
  return out;
}

async function pairExtension(): Promise<string> {
  const p = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
  return c.json().token as string;
}

// ---------------------------------------------------------------------------------------------------------------

describe("who may call", () => {
  it("the extension token is refused on every find route, reads included", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [AMBIGUOUS]);
    await settled(pid, e!.id);
    const token = await pairExtension();
    const before = (await queue(pid)).entries;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/projects/${pid}/find`],
      ["POST", `/projects/${pid}/find`, { lines: ["Extension Typed Line"] }],
      ["POST", `/projects/${pid}/find/${e!.id}/choose`, { candidateId: null }],
      ["POST", `/projects/${pid}/find/${e!.id}/duplicate`, { same: true }],
      ["POST", `/projects/${pid}/find/${e!.id}/add-here`],
      ["POST", `/projects/${pid}/find/${e!.id}/retry`],
      ["DELETE", `/projects/${pid}/find/${e!.id}`],
      ["GET", `/projects/${pid}/find/${e!.id}/elsewhere`],
      ["GET", `/find/screen`],
      ["PUT", `/find/screen`, { checkEverything: true }],
    ];
    for (const [method, url, body] of routes) {
      const res = await svc!.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}`, origin: EXT, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
      errorBodies.push(res.body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // Nothing changed.
    expect((await queue(pid)).entries).toEqual(before);
    expect((await call({ url: "/find/screen" })).json.checkEverything).toBe(false);
    // A wrong Origin is refused as everywhere.
    expect((await call({ url: `/projects/${pid}/find`, headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("an unknown project is 404, a malformed id 400, and an entry of another project is 404 and is never acted on", async () => {
    await start();
    await openNewLibrary();
    const a = await newProject(false, "Alpha");
    const b = await newProject(false, "Beta");
    const [e] = await add(a, [AMBIGUOUS]);
    const chosen = await settled(a, e!.id);
    expect(chosen.state).toBe("choose");
    expect((await call({ url: `/projects/01900000-0000-7000-8000-000000000000/find` })).status).toBe(404);
    expect((await call({ url: `/projects/not-an-id/find` })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${a}/find/not-an-id/retry` })).status).toBe(400);
    const cid = chosen.candidates![0]!.id;
    const tries: Array<[string, string, unknown?]> = [
      ["POST", `/projects/${b}/find/${e!.id}/choose`, { candidateId: cid }],
      ["POST", `/projects/${b}/find/${e!.id}/duplicate`, { same: true }],
      ["POST", `/projects/${b}/find/${e!.id}/add-here`],
      ["POST", `/projects/${b}/find/${e!.id}/retry`],
      ["DELETE", `/projects/${b}/find/${e!.id}`],
      ["GET", `/projects/${b}/find/${e!.id}/elsewhere`],
    ];
    for (const [method, url, body] of tries) {
      const r = await call({ method: method as "GET", url, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${url}`).toBe(404);
      expect(r.json.error.message).toBe(FIND_ROUTE_TEXT.entryNotFound);
    }
    expect(await entry(a, e!.id)).toEqual(chosen);
  });
});

describe("adding lines", () => {
  it("a line of 501 characters refuses the whole add and names its number, not its text", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const long = `Zorblatt ${"q".repeat(492)}`;
    expect(long.trim().length).toBe(501);
    const r = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE, long, "Third line here"] } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("Line 2");
    expect(r.json.error.reason).toBe("line");
    expect((await queue(pid)).entries).toEqual([]);
    // A line of one character, after trimming, the same.
    const one = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE, "   Z   "] } });
    expect(one.status).toBe(400);
    expect(one.json.error.message).toContain("Line 2");
    // A line the library's parser refuses (nothing that can be shown): named by its number and its true cause (R247 M2).
    const unseen = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE, "\u0000\u0007\u202e"] } });
    expect(unseen.status).toBe(400);
    expect(unseen.json.error).toMatchObject({ reason: "line" });
    expect(unseen.json.error.message).toMatch(/^Line 2 .*cannot be shown/);
    // 51 lines; no lines; not a list; a collection that is not an id.
    expect((await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: Array.from({ length: 51 }, (_, i) => `Reference number ${i}`) } })).json.error.message).toBe(FIND_ROUTE_TEXT.tooManyLines);
    expect((await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [] } })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: "Zorblatt" } })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE], collectionId: "Zorblatt" } })).status).toBe(400);
    // A body over 64 KiB.
    const big = await call({ method: "POST", url: `/projects/${pid}/find`, raw: JSON.stringify({ lines: [LINE], pad: "Zorblatt".repeat(9000) }) });
    expect(big.status).toBe(413);
    expect((await queue(pid)).entries).toEqual([]);
  });

  it("a sure line becomes a record; find.progress carries projectId, entryId and state only", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const r = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE, `  ${LINE}  `] } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.mergedLines).toBe(1);
    const [e] = r.json.added as FindEntryView[];
    expect(e!.typed).toBe(LINE);
    const done = await settled(pid, e!.id);
    expect(MADE).toContain(done.state);
    expect(done.sourceId).toBeTruthy();
    const progress = () => events.filter((x) => x.type === "find.progress");
    await until(async () => progress().some((x) => x.data.state === "record-complete"), "the event");
    for (const p of progress()) expect(Object.keys(p.data).sort()).toEqual(["entryId", "projectId", "state"]);
    expect(progress().map((x) => x.data)).toContainEqual({ projectId: pid, entryId: e!.id, state: "record-complete" });
    const q = await queue(pid);
    expect(q).toMatchObject({ checkEverything: false, lockedProjectsNotChecked: 0, readOnly: false, unreadableLines: 0 });
    expect(q.stopped).toBeUndefined();
    // The view leaves out people and works, and the service never caches a queue.
    expect(Object.keys(q.entries[0]!)).not.toContain("people");
    const res = await svc!.app.inject({ method: "GET", url: `/projects/${pid}/find`, headers: auth });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the full queue is a 409 with the plan's sentence", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    gated.holdAll(); // nothing is looked up meanwhile
    for (let k = 0; k < 10; k++) await add(pid, Array.from({ length: 50 }, (_, i) => `Reference ${k} number ${i}`));
    const r = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: ["One more reference"] } });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe(FIND_REASON_TEXT["queue-full"]);
    expect(r.json.error.reason).toBe("queue-full");
  }, 60_000);
});

describe("choosing and the other presses", () => {
  it("choose: an unknown candidate is 400; choose twice: the second is a 409 in words; after a remove 404 (R245)", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [AMBIGUOUS]);
    const c = await settled(pid, e!.id);
    expect(c.state).toBe("choose");
    expect(c.candidates!.length).toBe(2);
    const unknown = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/choose`, body: { candidateId: "no-such-candidate" } });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.message).toBe(FIND_ROUTE_TEXT.unknownCandidate);
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/choose`, body: { candidateId: 7 } })).status).toBe(400);
    const first = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/choose`, body: { candidateId: c.candidates![1]!.id } });
    expect(first.status, first.body).toBe(200);
    expect(first.json.state).toBe("record-complete");
    expect(first.json.match).toEqual({ method: "find-chosen", confidence: 1 });
    const second = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/choose`, body: { candidateId: c.candidates![1]!.id } });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.entryState, reason: "entry-state" });
    // One record only.
    expect((await call({ url: `/projects/${pid}/sources?limit=10` })).json.total).toBe(1);
    // The other presses on an entry that is not waiting for them.
    for (const [path, body] of [["duplicate", { same: true }], ["add-here", undefined], ["retry", undefined]] as const) {
      const r = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/${path}`, ...(body ? { body } : {}) });
      expect(r.status, path).toBe(409);
      expect(r.json.error.message).toBe(FIND_ROUTE_TEXT.entryState);
    }
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/duplicate`, body: { same: "yes" } })).status).toBe(400);
    // Remove keeps the record; afterwards the entry is not in the queue: 404, whoever removed it (R245).
    const rm1 = await call({ method: "DELETE", url: `/projects/${pid}/find/${e!.id}` });
    expect(rm1.status).toBe(200);
    expect(rm1.json).toEqual({ removed: true });
    expect((await call({ url: `/projects/${pid}/sources?limit=10` })).json.total).toBe(1);
    for (const [path, body] of [["choose", { candidateId: null }], ["duplicate", { same: true }], ["add-here", undefined], ["retry", undefined]] as const) {
      const after = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/${path}`, ...(body ? { body } : {}) });
      expect(after.status, path).toBe(404);
      expect(after.json.error).toMatchObject({ code: "NOT_FOUND", message: "That entry is no longer in the queue." });
    }
    expect((await call({ method: "DELETE", url: `/projects/${pid}/find/${e!.id}` })).status).toBe(404);
  });

  it("None of these, and Try again", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [AMBIGUOUS]);
    await settled(pid, e!.id);
    const none = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/choose`, body: { candidateId: null } });
    expect(none.json.state).toBe("not-found");
    const again = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/retry` });
    expect(again.status, again.body).toBe(200);
    expect(again.json.state).toBe("looking-up");
    expect((await settled(pid, e!.id)).state).toBe("choose");
    const [n] = await add(pid, [NOTHING]);
    expect((await settled(pid, n!.id)).state).toBe("not-found");
  });
});

describe("refusals", () => {
  it("locked: 423 with the plain sentence", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject(true);
    const [e] = await add(pid, [AMBIGUOUS]);
    await settled(pid, e!.id);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    for (const [method, url, body] of [
      ["GET", `/projects/${pid}/find`],
      ["POST", `/projects/${pid}/find`, { lines: [LINE] }],
      ["POST", `/projects/${pid}/find/${e!.id}/choose`, { candidateId: null }],
      ["POST", `/projects/${pid}/find/${e!.id}/retry`],
      ["DELETE", `/projects/${pid}/find/${e!.id}`],
      ["GET", `/projects/${pid}/find/${e!.id}/elsewhere`],
    ] as Array<[string, string, unknown?]>) {
      const r = await call({ method: method as "GET", url, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${url}`).toBe(423);
      expect(r.json.error).toMatchObject({ code: "PROJECT_LOCKED", message: FIND_ROUTE_TEXT.locked });
    }
  });

  it("a read-only library: the queue answers readOnly with its sentence; every change is 409 in words", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [AMBIGUOUS]);
    await settled(pid, e!.id);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    const q = await queue(pid);
    expect(q.readOnly).toBe(true);
    expect(q.entries.map((x) => x.state)).toEqual(["choose"]);
    expect(q.stopped).toEqual({ code: "read-only", text: FIND_STOPPED_TEXT["read-only"] });
    for (const [method, url, body] of [
      ["POST", `/projects/${pid}/find`, { lines: [LINE] }],
      ["POST", `/projects/${pid}/find/${e!.id}/choose`, { candidateId: null }],
      ["POST", `/projects/${pid}/find/${e!.id}/duplicate`, { same: true }],
      ["POST", `/projects/${pid}/find/${e!.id}/add-here`],
      ["POST", `/projects/${pid}/find/${e!.id}/retry`],
      ["DELETE", `/projects/${pid}/find/${e!.id}`],
    ] as Array<[string, string, unknown?]>) {
      const r = await call({ method: method as "GET", url, ...(body !== undefined ? { body } : {}) });
      expect(r.status, `${method} ${url}`).toBe(409);
      expect(r.json.error).toMatchObject({ code: "READ_ONLY", message: FIND_ROUTE_TEXT.readOnly });
    }
  });

  it("the queue's answer carries unreadableLines and stopped with its sentence; a queue none of whose lines can be read is 409 with the store's sentence", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [AMBIGUOUS]);
    await settled(pid, e!.id);
    const file = join(path, await folderOf(pid), "find", "queue.jsonl");
    await appendFile(file, "this is not a queue line\n");
    expect((await queue(pid)).unreadableLines).toBe(1);
    // Rules that cannot be read: the runner says so at the next open.
    const gov = join(path, await folderOf(pid), "governance.yaml");
    const goodRules = await readFile(gov);
    await writeFile(gov, "identifiability: [unclosed");
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const q = await until(async () => ((x) => (x.stopped ? x : undefined))(await queue(pid)), "stopped");
    expect(q.stopped).toEqual({ code: "rules-unreadable", text: FIND_STOPPED_TEXT["rules-unreadable"] });
    // An add refused meanwhile says that nothing was added (R247 M3).
    const refusedAdd = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE] } });
    expect(refusedAdd.status).toBe(409);
    expect(refusedAdd.json.error).toMatchObject({ reason: "stopped", message: `${FIND_STOPPED_TEXT["rules-unreadable"]} Nothing was added.` });
    await writeFile(gov, goodRules);
    // A queue none of whose lines can be read.
    await writeFile(file, "garbage\nmore garbage\n");
    const r = await call({ url: `/projects/${pid}/find` });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ message: FIND_STOPPED_TEXT["queue-unreadable"], reason: "queue-unreadable" });
  });

  it("F11: the queue's answer carries what the copy states need: the 'elsewhere' links of no-open-copy, the reason of needs-check, each with its sentence", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const repo = svc!.state.session!.repo;
    const at = new Date().toISOString();
    const base = { projectId: pid, typed: "Quillfeather, Zorblatt", createdAt: at, updatedAt: at, attempts: 0 };
    const none = { ...base, id: newId(), state: "no-open-copy" as const, offers: [{ label: "A free copy may be at" as const, url: "https://repository.example.edu/z.pdf", host: "repository.example.edu" }] };
    const check = { ...base, id: newId(), state: "needs-check" as const, reason: { code: "file-other-doi" as const } };
    const rules = { ...base, id: newId(), state: "record-complete" as const, reason: { code: "copy-not-allowed" as const, by: "rules" as const } };
    await appendFindEntriesIn(repo, pid, [none, check, rules], "add");
    const q = await queue(pid);
    expect(q.entries.find((e) => e.id === none.id)).toMatchObject({ state: "no-open-copy", offers: none.offers });
    expect(q.entries.find((e) => e.id === check.id)).toMatchObject({ state: "needs-check", reason: { code: "file-other-doi" } });
    expect(q.entries.find((e) => e.id === rules.id)).toMatchObject({ state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    for (const c of ["copy-not-allowed", "held-full", "not-this-file", "file-other-doi", "file-title-absent", "file-no-text", "file-other-version"] as const) expect(FIND_REASON_TEXT[c]).toBeTruthy();
    expect(FIND_REASON_TEXT["copy-not-allowed"]).not.toContain("free_copy");
  });

  it("R282 f: rules that forbid free copies stop the entry; saving rules that allow them wakes it, without a restart", async () => {
    await start();
    await openNewLibrary();
    const made = await call({ method: "POST", url: "/projects", body: { name: "Rules", governanceYaml: `${GOV}acquireMethods: [reference_lookup]\n`, encryption: { enabled: false } } });
    expect(made.status, made.body).toBe(200);
    const pid = made.json.project.id as string;
    const [e] = await add(pid, [LINE]);
    await until(async () => ((x) => x?.reason?.code === "copy-not-allowed")(await entry(pid, e!.id)), "the rules' refusal");
    const doiAsked = () => gated.sent.filter((x) => x.service === "openalex").length;
    const before = doiAsked();
    const g = await call({ url: `/projects/${pid}/governance` });
    const put = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: `${GOV}acquireMethods: [reference_lookup, free_copy]\n`, reason: "free copies allowed" }, headers: { "if-match": String(g.headers.etag) } });
    expect(put.status, put.body).toBe(200);
    expect((await until(async () => ((x) => (x?.state === "no-open-copy" ? x : undefined))(await entry(pid, e!.id)), "the entry to go on")).state).toBe("no-open-copy");
    expect(doiAsked()).toBeGreaterThan(before);
  });

  it("R296 d: a decision on a waiting file, through the review route, wakes the project's entries waiting for the limit", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [a] = await add(pid, [LINE]);
    const sid = (await until(async () => ((x) => (x?.state === "no-open-copy" && x.sourceId ? x : undefined))(await entry(pid, a!.id)), "the record")).sourceId!;
    const repo = svc!.state.session!.repo;
    const at = new Date().toISOString();
    // A file waits for the researcher's check (held as the runner holds one) …
    const heldFor: FindEntry = { id: newId(), projectId: pid, typed: "x y", state: "fetching", createdAt: at, updatedAt: at, attempts: 0, sourceId: sid };
    // … and an entry waits because the limit was reached when it was looked at (as an earlier run left it).
    const waiting: FindEntry = { id: newId(), projectId: pid, typed: "y z", state: "record-complete", reason: { code: "held-full" }, createdAt: at, updatedAt: at, attempts: 0, sourceId: sid };
    await appendFindEntriesIn(repo, pid, [heldFor, waiting], "add");
    const pdf = join(tmp, "held.pdf");
    await writeFile(pdf, await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
    await holdMismatchedFileIn(repo, pid, {
      entry: { ...heldFor, state: "needs-check", reason: { code: "file-title-absent" } },
      sourceId: sid,
      fromPath: pdf,
      facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "free_copy", via: "service", address: "https://arxiv.org/pdf/1", at, tool: { name: "find-and-acquire", version: "0" }, access: "public" } },
    });
    await sleep(100);
    expect(await entry(pid, waiting.id)).toMatchObject({ state: "record-complete", reason: { code: "held-full" } });
    const items = (await call({ url: `/projects/${pid}/review` })).json.items as Array<{ id: string; group: string }>;
    const item = items.find((i) => i.group === "found-file")!;
    const r = await call({ method: "POST", url: `/review/${item.id}/held-file`, body: { projectId: pid, decision: "discard" } });
    expect(r.status, r.body).toBe(200);
    expect(await entry(pid, heldFor.id)).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
    // Woken without a restart: it looked for a copy again (this world has none; the answer may come from the cache).
    expect((await until(async () => ((x) => (x?.state === "no-open-copy" ? x : undefined))(await entry(pid, waiting.id)), "the waiting entry to go on")).state).toBe("no-open-copy");
    expect(events.some((e) => e.type === "find.progress" && (e.data as { entryId?: string }).entryId === waiting.id && (e.data as { state?: string }).state === "looking-for-copy")).toBe(true);
  });

  it("R305 b: fifty decisions in a row through the review route wake the waiting entry and touch nothing in flight (a lookup held open is asked once)", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [a] = await add(pid, [LINE]);
    const sid = (await until(async () => ((x) => (x?.state === "no-open-copy" && x.sourceId ? x : undefined))(await entry(pid, a!.id)), "the record")).sourceId!;
    const repo = svc!.state.session!.repo;
    const at = new Date().toISOString();
    const pdf = join(tmp, "held.pdf");
    await writeFile(pdf, await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
    const holds: FindEntry[] = Array.from({ length: 50 }, (_, i) => ({ id: newId(), projectId: pid, typed: `x y ${i}`, state: "fetching", createdAt: at, updatedAt: at, attempts: 0, sourceId: sid }));
    const waiting: FindEntry = { id: newId(), projectId: pid, typed: "y z", state: "record-complete", reason: { code: "held-full" }, createdAt: at, updatedAt: at, attempts: 0, sourceId: sid };
    await appendFindEntriesIn(repo, pid, [...holds, waiting], "add");
    for (const h of holds) {
      await holdMismatchedFileIn(repo, pid, {
        entry: { ...h, state: "needs-check", reason: { code: "file-title-absent" } },
        sourceId: sid,
        fromPath: pdf,
        facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "free_copy", via: "service", address: "https://arxiv.org/pdf/1", at, tool: { name: "find-and-acquire", version: "0" }, access: "public" } },
      });
    }
    // An entry at work: its lookup held open.
    const release = gated.hold(NOTHING);
    const [busy] = await add(pid, [NOTHING]);
    await until(async () => asked(NOTHING) === 1, "the lookup to be asked");
    const items = ((await call({ url: `/projects/${pid}/review?limit=500` })).json.items as Array<{ id: string; group: string }>).filter((i) => i.group === "found-file");
    expect(items).toHaveLength(50);
    for (const item of items) {
      const r = await call({ method: "POST", url: `/review/${item.id}/held-file`, body: { projectId: pid, decision: "discard" } });
      expect(r.status, r.body).toBe(200);
    }
    expect((await until(async () => ((x) => (x?.state === "no-open-copy" ? x : undefined))(await entry(pid, waiting.id)), "the waiting entry to go on")).state).toBe("no-open-copy");
    await sleep(100);
    expect(asked(NOTHING)).toBe(1);
    expect((await entry(pid, busy!.id))!.state).toBe("looking-up");
    release();
    await settled(pid, busy!.id);
    expect(asked(NOTHING)).toBe(1);
  });

  it("R310 a: deleting a record whose file was waiting, through the sources route, wakes the project's entries waiting for the limit", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [a] = await add(pid, [LINE]);
    const sid = (await until(async () => ((x) => (x?.state === "no-open-copy" && x.sourceId ? x : undefined))(await entry(pid, a!.id)), "the record")).sourceId!;
    const repo = svc!.state.session!.repo;
    const at = new Date().toISOString();
    // Another record, with a file waiting for the researcher's check (held as the runner holds one) …
    const gone = await repo.createSource(
      pid,
      { projectIds: [pid], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "A Record To Be Deleted" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: at, tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    const heldFor: FindEntry = { id: newId(), projectId: pid, typed: "x y", state: "fetching", createdAt: at, updatedAt: at, attempts: 0, sourceId: gone.source.id };
    // … and an entry waiting because the limit was reached when it was looked at.
    const waiting: FindEntry = { id: newId(), projectId: pid, typed: "y z", state: "record-complete", reason: { code: "held-full" }, createdAt: at, updatedAt: at, attempts: 0, sourceId: sid };
    await appendFindEntriesIn(repo, pid, [heldFor, waiting], "add");
    const pdf = join(tmp, "held.pdf");
    await writeFile(pdf, await buildPdf({ title: "A Different Paper Entirely", lines: ["A Different Paper Entirely"] }));
    await holdMismatchedFileIn(repo, pid, {
      entry: { ...heldFor, state: "needs-check", reason: { code: "file-title-absent" } },
      sourceId: gone.source.id,
      fromPath: pdf,
      facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "free_copy", via: "service", address: "https://arxiv.org/pdf/1", at, tool: { name: "find-and-acquire", version: "0" }, access: "public" } },
    });
    await sleep(100);
    expect(await entry(pid, waiting.id)).toMatchObject({ state: "record-complete", reason: { code: "held-full" } });
    const d = await call({ method: "DELETE", url: `/projects/${pid}/sources/${gone.source.id}` });
    expect(d.status, d.body).toBe(200);
    // The deletion's own change resolved the waiting file and said so on its entry (R282 g).
    expect(await entry(pid, heldFor.id)).toMatchObject({ state: "no-open-copy", reason: { code: "record-removed" } });
    // Woken without a restart: it looked for a copy again (this world has none).
    expect((await until(async () => ((x) => (x?.state === "no-open-copy" ? x : undefined))(await entry(pid, waiting.id)), "the waiting entry to go on")).state).toBe("no-open-copy");
    expect(events.some((e) => e.type === "find.progress" && (e.data as { entryId?: string }).entryId === waiting.id && (e.data as { state?: string }).state === "looking-for-copy")).toBe(true);
  });

  it("a typed line never appears in the log", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject(true);
    const [e] = await add(pid, [LINE]);
    await settled(pid, e!.id);
    await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [`Zorblatt ${"q".repeat(600)}`] } });
    await call({ method: "POST", url: `/projects/${pid}/find`, raw: '{"lines":["Quillfeather' });
    await call({ method: "POST", url: `/projects/${pid}/lock` });
    await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE] } });
    expect(logs.length).toBeGreaterThan(0);
    for (const w of SECRET_WORDS) expect(logs.includes(w), w).toBe(false);
  });

  it("every reason code has its sentence", () => {
    for (const c of FIND_REASON_CODES) expect(FIND_REASON_TEXT[c].length).toBeGreaterThan(10);
  });
});

describe("the runner's life in the service", () => {
  it("lock in the middle of a lookup and of a choose: stop before the key is dropped, nothing written afterwards, the request answers 423", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject(true);
    const s = svc!.state.session!;
    const [c] = await add(pid, [AMBIGUOUS]);
    const waiting = await settled(pid, c!.id);
    // A lookup held open.
    const release = gated.hold(LINE);
    const [e] = await add(pid, [LINE]);
    await until(async () => asked(LINE) > 0, "the lookup to be sent");
    // A choose waiting for the project's turn.
    let free!: () => void;
    const turn = serialStore(s.repo, pid, () => new Promise<void>((r) => (free = r)));
    const choosing = call({ method: "POST", url: `/projects/${pid}/find/${c!.id}/choose`, body: { candidateId: waiting.candidates![0]!.id } });
    await sleep(50);
    // The order at the lock.
    const order: string[] = [];
    const runner = s.find!;
    const stop = runner.stop;
    runner.stop = (p: string) => {
      order.push(`stop:${s.repo.isUnlocked(p)}`);
      stop(p);
    };
    const lockProject = s.repo.lockProject.bind(s.repo);
    s.repo.lockProject = (id: string) => {
      order.push("lock");
      lockProject(id);
    };
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(order).toEqual(["stop:true", "lock"]);
    const file = join(path, await folderOf(pid), "find", "queue.jsonl");
    const bytes = await readFile(file);
    release();
    free();
    await turn;
    const chose = await choosing;
    expect(chose.status).toBe(423);
    expect(chose.json.error.message).toBe(FIND_ROUTE_TEXT.locked);
    await sleep(300);
    expect((await readFile(file)).equals(bytes)).toBe(true);
    // Unlocked: nothing was half-done, and the held line is looked up again and completes once.
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await entry(pid, c!.id))!.state).toBe("choose");
    expect(MADE).toContain((await settled(pid, e!.id)).state);
    expect((await call({ url: `/projects/${pid}/sources?limit=10` })).json.total).toBe(1);
  });

  it("resume waits for the index", async () => {
    let gate: Promise<void> | undefined;
    let open!: () => void;
    await start({
      rebuildIndexIfNeeded: (async (...a: Parameters<typeof rebuildIndexIfNeeded>) => {
        await gate;
        return rebuildIndexIfNeeded(...a);
      }) as typeof rebuildIndexIfNeeded,
    });
    const path = await openNewLibrary();
    const pid = await newProject();
    // An entry left waiting: its lookup was held when the library closed.
    const release = gated.hold(LINE);
    const [e] = await add(pid, [LINE]);
    await until(async () => asked(LINE) > 0, "the lookup to be sent");
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    release();
    const sentBefore = asked(LINE);
    gate = new Promise<void>((r) => (open = r));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await sleep(400);
    expect(asked(LINE)).toBe(sentBefore);
    const q = await queue(pid);
    expect(q.entries[0]!.state).toBe("looking-up");
    expect(q.stopped).toEqual({ code: "index-not-ready", text: FIND_STOPPED_TEXT["index-not-ready"] });
    open();
    // (The released answer was kept in the lookup cache, so the resumed run may not ask again.)
    expect(MADE).toContain((await settled(pid, e!.id)).state);
  });

  it("close during a held choose: the press answers 503 in words, and the library's files are unchanged after the lock is released (R245)", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const s = svc!.state.session!;
    const [c] = await add(pid, [AMBIGUOUS]);
    const waiting = await settled(pid, c!.id);
    // The choose waits for the project's turn, held by another way in (an import, say).
    let free!: () => void;
    const turn = serialStore(s.repo, pid, () => new Promise<void>((r) => (free = r)));
    const choosing = call({ method: "POST", url: `/projects/${pid}/find/${c!.id}/choose`, body: { candidateId: waiting.candidates![0]!.id } });
    await sleep(50);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    // The lock is released: what the library's files hold now must not change.
    const before = await snapshot(path);
    free();
    await turn;
    const chose = await choosing;
    expect(chose.status).toBe(503);
    expect(chose.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.closed, reason: "closed" });
    await sleep(200);
    expect(await snapshot(path)).toEqual(before);
    // Reopened: nothing was half-done.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    expect((await entry(pid, c!.id))!.state).toBe("choose");
    expect((await call({ url: `/projects/${pid}/sources?limit=10` })).json.total).toBe(0);
  });

  it("close awaits stopAll before the library's lock is released", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const s = svc!.state.session!;
    const release = gated.hold(LINE);
    await add(pid, [LINE]);
    await until(async () => asked(LINE) > 0, "the lookup to be sent");
    const order: string[] = [];
    const runner = s.find!;
    const stopAll = runner.stopAll;
    runner.stopAll = async () => {
      order.push("stopAll");
      await stopAll();
      order.push("stopAll settled");
    };
    const close = s.lib.close.bind(s.lib);
    s.lib.close = async () => {
      order.push("lib.close");
      return close();
    };
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(order).toEqual(["stopAll", "stopAll settled", "lib.close"]);
    await expect(runner.add(pid, ["After the close"])).rejects.toBeInstanceOf(FindRunnerClosedError);
    release();
  });

  it("a move quiesces the runner: nothing is written to the old copy, and the queue goes on in the new one", async () => {
    let oldBytes: Buffer | undefined;
    let oldFile = "";
    let oldRunnerClosed = false;
    await start({
      beforeExecuteMove: async () => {
        const old = oldRunner!;
        oldRunnerClosed = await old.add(pid, ["Something else entirely"]).then(
          () => false,
          (err: unknown) => err instanceof FindRunnerClosedError,
        );
        oldBytes = await readFile(oldFile);
      },
    });
    const path = await openNewLibrary();
    const pid = await newProject();
    const oldRunner = svc!.state.session!.find;
    oldFile = join(path, await folderOf(pid), "find", "queue.jsonl");
    const release = gated.hold(LINE);
    const [e] = await add(pid, [LINE]);
    await until(async () => asked(LINE) > 0, "the lookup to be sent");
    const dest = join(tmp, "Moved");
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    expect(moved.status).toBe(200);
    expect(moved.body.trim().split("\n").at(-1)).toContain('"done":true');
    expect(oldRunnerClosed).toBe(true);
    expect(svc!.state.session!.find).not.toBe(oldRunner);
    release();
    expect(MADE).toContain((await settled(pid, e!.id)).state);
    await sleep(200);
    expect((await readFile(oldFile)).equals(oldBytes!)).toBe(true);
  }, 60_000);
});

describe("other projects and the screen's settings", () => {
  it("elsewhere names the project only at request time, and is null once the other project is locked", async () => {
    await start();
    const path = await openNewLibrary();
    const a = await newProject(true, "Alpha Fieldwork");
    const b = await newProject(false, "Beta");
    expect((await call({ method: "PUT", url: "/find/screen", body: { checkEverything: true, projectId: b } })).status).toBe(200);
    const [ea] = await add(a, [LINE]);
    const madeA = await settled(a, ea!.id);
    expect(MADE).toContain(madeA.state);
    const [eb] = await add(b, [LINE]);
    const there = await settled(b, eb!.id);
    expect(there).toMatchObject({ state: "already", elsewhere: true });
    const w = await call({ url: `/projects/${b}/find/${eb!.id}/elsewhere` });
    expect(w.status).toBe(200);
    expect(w.headers["cache-control"]).toBe("no-store");
    expect(w.json).toEqual({ projectId: a, projectName: "Alpha Fieldwork", sourceId: madeA.sourceId });
    // Nothing about the other project is in this project's queue file.
    const raw = await readFile(join(path, await folderOf(b), "find", "queue.jsonl"), "utf8");
    for (const x of [a, "Alpha Fieldwork", madeA.sourceId!]) expect(raw.includes(x)).toBe(false);
    expect((await queue(b)).lockedProjectsNotChecked).toBe(0);
    expect((await call({ method: "POST", url: `/projects/${a}/lock` })).status).toBe(200);
    const gone = await call({ url: `/projects/${b}/find/${eb!.id}/elsewhere` });
    expect(gone.status).toBe(200);
    expect(gone.json).toBeNull();
    expect((await queue(b)).lockedProjectsNotChecked).toBe(1);
    // With the switch off, no locked project is counted.
    expect((await call({ method: "PUT", url: "/find/screen", body: { checkEverything: false } })).status).toBe(200);
    expect((await queue(b)).lockedProjectsNotChecked).toBe(0);
    // Add it here as well: the record is made in this project.
    const here = await call({ method: "POST", url: `/projects/${b}/find/${eb!.id}/add-here` });
    expect(here.status, here.body).toBe(200);
    expect(here.json.state).toBe("record-complete");
  });

  it("the screen's settings: kept in a 0600 file; a file that cannot be read gives the defaults and is not rewritten by a read", async () => {
    await start();
    expect((await call({ url: "/find/screen" })).json).toEqual({ checkEverything: false });
    const pid = "01900000-0000-7000-8000-000000000000";
    const put = await call({ method: "PUT", url: "/find/screen", body: { checkEverything: true, projectId: pid } });
    expect(put.status, put.body).toBe(200);
    expect(put.json).toEqual({ checkEverything: true, projectId: pid });
    expect((await call({ url: "/find/screen" })).json).toEqual({ checkEverything: true, projectId: pid });
    const file = join(deps.appConfigDir, "find-screen.json");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await call({ method: "PUT", url: "/find/screen", body: { checkEverything: "yes" } })).status).toBe(400);
    expect((await call({ method: "PUT", url: "/find/screen", body: { checkEverything: true, projectId: "Zorblatt" } })).status).toBe(400);
    await writeFile(file, "{ not json");
    expect((await call({ url: "/find/screen" })).json).toEqual({ checkEverything: false });
    expect(await readFile(file, "utf8")).toBe("{ not json");
    // R245: the researcher's next change sets the damaged file aside and writes the new settings.
    const replaced = await call({ method: "PUT", url: "/find/screen", body: { checkEverything: true } });
    expect(replaced.status, replaced.body).toBe(200);
    expect(replaced.json).toEqual({ checkEverything: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ checkEverything: true });
    const aside = (await readdir(deps.appConfigDir)).filter((n) => n.startsWith("find-screen.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(deps.appConfigDir, aside[0]!), "utf8")).toBe("{ not json");
    expect((await call({ url: "/find/screen" })).json).toEqual({ checkEverything: true });
  });
});

describe("R247: the index, the cache, and work under way at a close or a move", () => {
  it("(a, b) unlock always resumes; adds wait while the index is rebuilt; an index that needs a rebuild says so and names the control; the queue goes on by itself after a rebuild", async () => {
    let gate: Promise<void> | undefined;
    let open!: () => void;
    await start({
      rebuildIndexIfNeeded: (async (...a: Parameters<typeof rebuildIndexIfNeeded>) => {
        await gate;
        return rebuildIndexIfNeeded(...a);
      }) as typeof rebuildIndexIfNeeded,
    });
    await openNewLibrary();
    const pid = await newProject(true);
    const [c] = await add(pid, [AMBIGUOUS]);
    const waiting = await settled(pid, c!.id);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    // A rebuild running: unlock resumes anyway; an add is accepted and waits; choose is a 409 in words.
    gate = new Promise<void>((r) => (open = r));
    const rebuilding = call({ method: "POST", url: "/libraries/rebuild-index" });
    await until(async () => !!svc!.state.session!.indexRebuild, "the rebuild to start");
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    const r1 = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [LINE] } });
    expect(r1.status, r1.body).toBe(200);
    const e1 = r1.json.added[0].id as string;
    const q1 = await queue(pid);
    expect(q1.stopped).toEqual({ code: "index-not-ready", text: FIND_STOPPED_TEXT["index-not-ready"] });
    const chose = await call({ method: "POST", url: `/projects/${pid}/find/${c!.id}/choose`, body: { candidateId: waiting.candidates![0]!.id } });
    expect(chose.status).toBe(409);
    expect(chose.json.error).toMatchObject({ reason: "index-not-ready", message: FIND_ROUTE_TEXT.indexNotReady });
    await sleep(300);
    expect((await entry(pid, e1))!.state).toBe("looking-up");
    open();
    expect((await rebuilding).status).toBe(200);
    // The runner goes on by itself.
    expect(MADE).toContain((await settled(pid, e1)).state);
    // An index error and no rebuild: "needs a rebuild", naming the control.
    (svc!.state.session!.repo.indexErrors as Array<{ op: string; error: unknown }>).push({ op: "source.create", error: new Error("index write failed") });
    const r2 = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [NOTHING] } });
    expect(r2.status, r2.body).toBe(200);
    const q2 = await queue(pid);
    expect(q2.stopped).toEqual({ code: "index-needs-rebuild", text: FIND_STOPPED_TEXT["index-needs-rebuild"] });
    expect(q2.stopped!.text).toContain("“Rebuild library from folder”");
    await sleep(300);
    expect((await entry(pid, r2.json.added[0].id))!.state).toBe("looking-up");
    // The researcher rebuilds: the queue goes on by itself.
    gate = undefined;
    expect((await call({ method: "POST", url: "/libraries/rebuild-index" })).status).toBe(200);
    expect((await settled(pid, r2.json.added[0].id)).state).toBe("not-found");
    expect((await queue(pid)).stopped).toBeUndefined();
  }, 60_000);

  it("(c) P8: a lookup held across a library switch writes nothing into the old library, and never recreates its folder", async () => {
    await start();
    // A: the library is switched while a lookup is held; its answer comes afterwards.
    const pathA = await openNewLibrary("A");
    const a = await newProject();
    const releaseA = gated.hold(LINE);
    await add(a, [LINE]);
    await until(async () => asked(LINE) > 0, "A's lookup to be sent");
    const pathB = await openNewLibrary("B");
    const cacheA = join(pathA, ".cache", "lookups");
    const before = existsSync(cacheA) ? (await readdir(cacheA)).sort() : [];
    releaseA();
    await sleep(300);
    expect(existsSync(cacheA) ? (await readdir(cacheA)).sort() : []).toEqual(before);
    // B: switched away from, then its folder deleted, before the held answer comes: never created again.
    const b = await newProject();
    const releaseB = gated.hold(AMBIGUOUS);
    await add(b, [AMBIGUOUS]);
    await until(async () => asked(AMBIGUOUS) > 0, "B's lookup to be sent");
    await openNewLibrary("C");
    await rm(pathB, { recursive: true, force: true });
    releaseB();
    await sleep(300);
    expect(existsSync(pathB)).toBe(false);
  });

  it("(c, R320 c) FR-531: a free-copy lookup in flight at the close is not waited for; its late answer writes nothing into the library, and nothing of it is left open", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    // The free-copy services' first question (OpenAlex, by the record's DOI) is held open.
    const freeCopy = (origin: string, p: string) => origin.includes("api.openalex.org") && p.startsWith("/works/doi:");
    const release = gated.holdWhere(freeCopy);
    const [e] = await add(pid, [LINE]);
    await until(async () => gated.sent.some((s) => freeCopy(s.origin, s.path)), "the free-copy lookup to be sent");
    expect((await entry(pid, e!.id))!.state).toBe("looking-for-copy");
    const cache = join(path, ".cache", "lookups");
    const cached = async () => (existsSync(cache) ? (await readdir(cache)).sort() : []);
    // The close does not wait for the answer (the runner lets it go; the lookup ends by its own time limit).
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(svc!.state.session).toBeUndefined();
    const before = await snapshot(path);
    const cachedBefore = await cached();
    // The answer comes after the library's lock is released: nothing of it is written, the lookup cache included.
    release();
    await sleep(300);
    expect(await cached()).toEqual(cachedBefore);
    expect(await snapshot(path)).toEqual(before);
    // Nothing of it is left open: no work folder of the entry, and the library opens again; the entry, left looking for a
    // copy, is taken up again and ends as this made-up world says (no open copy).
    expect((await readdir(join(path, ".tmp")).catch(() => [] as string[])).filter((n) => n.startsWith("find-"))).toEqual([]);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    expect((await settled(pid, e!.id)).state).toBe("no-open-copy");
  });

  it("(d) a creation held inside its turn while the library closes: the close waits; the record and the entry's line are both there; nothing is written after the release", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    let release!: () => void;
    let entered = false;
    runnerSeams.inCreate = async () => {
      entered = true;
      await new Promise<void>((r) => (release = r));
    };
    const [e] = await add(pid, [LINE]);
    await until(async () => entered, "the creation to be under way");
    let closedAt = 0;
    const closing = call({ method: "POST", url: "/libraries/close" }).then((r) => {
      closedAt = Date.now();
      return r;
    });
    await sleep(5_500);
    expect(closedAt).toBe(0);
    release();
    expect((await closing).status).toBe(200);
    runnerSeams.inCreate = undefined;
    const after = await snapshot(path);
    await sleep(300);
    expect(await snapshot(path)).toEqual(after);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const done = (await entry(pid, e!.id))!;
    expect(MADE).toContain(done.state);
    const sources = (await call({ url: `/projects/${pid}/sources?limit=10` })).json;
    expect(sources.total).toBe(1);
  }, 30_000);

  it("(M5) a retry and a remove held before their turn across a close: 503 in words, and no file of the library changes", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const s = svc!.state.session!;
    const [n] = await add(pid, [NOTHING]);
    await settled(pid, n!.id);
    const [m] = await add(pid, [AMBIGUOUS]);
    await settled(pid, m!.id);
    let free!: () => void;
    const turn = serialStore(s.repo, pid, () => new Promise<void>((r) => (free = r)));
    const retrying = call({ method: "POST", url: `/projects/${pid}/find/${n!.id}/retry` });
    const removing = call({ method: "DELETE", url: `/projects/${pid}/find/${m!.id}` });
    await sleep(50);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const before = await snapshot(path);
    free();
    await turn;
    for (const r of [await retrying, await removing]) {
      expect(r.status).toBe(503);
      expect(r.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.closed, reason: "closed" });
    }
    await sleep(200);
    expect(await snapshot(path)).toEqual(before);
  });

  it("(M5) a move waits for a creation under way: the old copy holds the record and its line before the copy starts", async () => {
    let release!: () => void;
    let entered = false;
    let atCopy: { state?: string; sources?: number } = {};
    let pid = "";
    let path = "";
    await start({
      beforeExecuteMove: async () => {
        const raw = await readFile(join(path, await folderOfAt(path, pid), "find", "queue.jsonl"), "utf8");
        const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { state: string });
        atCopy = { state: lines.at(-1)!.state };
      },
    });
    path = await openNewLibrary();
    pid = await newProject();
    runnerSeams.inCreate = async () => {
      entered = true;
      await new Promise<void>((r) => (release = r));
    };
    const [e] = await add(pid, [LINE]);
    await until(async () => entered, "the creation to be under way");
    const moving = call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    await sleep(300);
    release();
    expect((await moving).status).toBe(200);
    expect(MADE).toContain(atCopy.state);
    expect(MADE).toContain((await entry(pid, e!.id))!.state);
  }, 30_000);

  it("(M6) a quiesce that is rolled back resumes the queue", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const release = gated.hold(LINE);
    const [e] = await add(pid, [LINE]);
    await until(async () => asked(LINE) > 0, "the lookup to be sent");
    const stopWatches = svc!.state.stopWatches.bind(svc!.state);
    svc!.state.stopWatches = async () => {
      throw new Error("watches could not be stopped");
    };
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    svc!.state.stopWatches = stopWatches;
    expect(moved.status).not.toBe(200);
    release();
    expect(MADE).toContain((await settled(pid, e!.id)).state);
  });
});

async function folderOfAt(_path: string, pid: string): Promise<string> {
  return svc!.state.session!.repo.getProject(pid).folder;
}

// ---------------------------------------------------------------------------------------------------------------
// Task F8 (R267): an author alone — the person, then their works. Made-up people and works; "Vexmoor" is one of the
// words looked for in every log line, error and event.

describe("F8: an author alone", () => {
  const NAME = "Ottoline Vexmoor";
  const person = (n: number, name: string, aff: string) => ({ id: `https://openalex.org/A${n}`, display_name: name, works_count: 12, last_known_institutions: [{ display_name: aff }] });
  const work = (n: number, title: string, date: string) => ({
    id: `https://openalex.org/W${n}`,
    title,
    display_name: title,
    publication_year: Number(date.slice(0, 4)),
    publication_date: date,
    type: "article",
    doi: `https://doi.org/10.5555/ao.f8.r${n}`,
    primary_location: { source: { display_name: "Vexmoor Review of Invented Studies" } },
    authorships: [{ author: { display_name: NAME } }],
  });
  /** Two people of that name: A5001 with 60 works, A5002 with 3. */
  function twoPeople(): void {
    answers.set(NAME, cr());
    peopleAnswers.set(NAME, { meta: { count: 2 }, results: [{ ...person(5001, NAME, "Vexmoor Institute of Made-up Things"), topics: [{ display_name: "Vexmoor Coastal Ledgers" }] }, person(5002, "Ottoline R. Vexmoor", "College of Vexmoor Studies")] });
    personWorks.set("A5001", Array.from({ length: 60 }, (_, i) => work(1000 + i, `Vexmoor Ledger ${i}`, `${2024 - i}-01-01`)));
    personWorks.set("A5002", Array.from({ length: 3 }, (_, i) => work(2000 + i, `Vexmoor Harbour ${i}`, `${2010 - i}-01-01`)));
    for (const ws of personWorks.values()) for (const w of ws as Array<ReturnType<typeof work>>) singles.set(w.id.slice("https://openalex.org/".length), w);
  }
  const waitState = (pid: string, eid: string, s: string) => until(async () => ((e) => (e?.state === s ? e : undefined))(await entry(pid, eid)), `the entry to be ${s}`);

  /** An entry in "choose-person" (two people). */
  async function choosingPerson(): Promise<{ pid: string; eid: string }> {
    twoPeople();
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [NAME]);
    await waitState(pid, e!.id, "choose-person");
    return { pid, eid: e!.id };
  }

  it("the extension's token is refused on the three routes, the read included", async () => {
    const { pid, eid } = await choosingPerson();
    const token = await pairExtension();
    const before = await entry(pid, eid);
    for (const [method, url, body] of [
      ["GET", `/projects/${pid}/find/${eid}/options`],
      ["POST", `/projects/${pid}/find/${eid}/person`, { personId: "A5001" }],
      ["POST", `/projects/${pid}/find/${eid}/works`, { workIds: ["W1000"] }],
    ] as Array<[string, string, unknown?]>) {
      const res = await svc!.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}`, origin: EXT, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
      errorBodies.push(res.body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await entry(pid, eid)).toEqual(before);
  });

  it("the queue's answer carries counts, not lists; options lists people or works, with added marked", async () => {
    const { pid, eid } = await choosingPerson();
    const q = await call({ url: `/projects/${pid}/find` });
    const e = (q.json as FindQueueResponse).entries.find((x) => x.id === eid)!;
    expect(e).toMatchObject({ state: "choose-person", peopleCount: 2 });
    for (const k of ["people", "works", "added", "worksCount", "addedCount"]) expect(e).not.toHaveProperty(k);
    expect(q.body).not.toContain("Made-up Things");
    const o1 = await call({ url: `/projects/${pid}/find/${eid}/options` });
    expect(o1.status).toBe(200);
    expect(o1.headers["cache-control"]).toBe("no-store");
    expect(o1.json).toEqual({ people: [
      { id: "A5001", name: NAME, affiliation: "Vexmoor Institute of Made-up Things", worksCount: 12, subjects: ["Vexmoor Coastal Ledgers"] },
      { id: "A5002", name: "Ottoline R. Vexmoor", affiliation: "College of Vexmoor Studies", worksCount: 12, subjects: [] },
    ] });
    const pressed = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A5001" } });
    expect(pressed.status, pressed.body).toBe(200);
    expect(pressed.json).toMatchObject({ state: "looking-up", chosen: "A5001", peopleCount: 1 });
    const cw = await waitState(pid, eid, "choose-works");
    expect(cw).toMatchObject({ worksCount: 60, peopleCount: 1 });
    expect(cw).not.toHaveProperty("works");
    expect(cw.addedCount).toBeUndefined();
    const t = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1000", "W1002"] } });
    expect(t.status, t.body).toBe(200);
    expect(t.json.added).toHaveLength(2);
    expect(t.json.added[0]).toMatchObject({ parentId: eid, work: "W1000", typed: "Vexmoor Ledger 0, Vexmoor" });
    expect(t.json.entry).toMatchObject({ id: eid, state: "choose-works", worksCount: 60, addedCount: 2 });
    expect(t.json.entry).not.toHaveProperty("added");
    const o2 = await call({ url: `/projects/${pid}/find/${eid}/options` });
    expect(o2.json.people).toBeUndefined();
    // R271 M6: the person whose works these are is named.
    expect(o2.json.person).toEqual({ name: NAME, affiliation: "Vexmoor Institute of Made-up Things", subjects: ["Vexmoor Coastal Ledgers"] });
    expect(o2.json.works).toHaveLength(60);
    expect(o2.json.works.filter((w: { added?: true }) => w.added).map((w: { id: string }) => w.id)).toEqual(["W1000", "W1002"]);
    expect(o2.json.works[0]).toMatchObject({ id: "W1000", title: "Vexmoor Ledger 0", issued: "2024-01-01", type: "article-journal", container: "Vexmoor Review of Invented Studies", identifiers: { doi: "10.5555/ao.f8.r1000" } });
    // Each work ticked goes on to a record of its own.
    for (const k of t.json.added as FindEntryView[]) expect(MADE).toContain((await settled(pid, k.id)).state);
    // Nothing typed, no name, title or OpenAlex id in a log line (the events are checked after every test).
    for (const w of ["A5001", "W1000", "Ledger", "Made-up"]) expect(logs.includes(w), w).toBe(false);
    for (const ev of events) if (ev.type === "find.progress") expect(Object.keys(ev.data as object).sort()).toEqual(["entryId", "projectId", "state"]);
  });

  it("R271 M5: what was added follows the queue's live entries: remove an added entry, and the count, the mark and the tick follow", async () => {
    const { pid, eid } = await choosingPerson();
    await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A5001" } });
    await waitState(pid, eid, "choose-works");
    const t = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1003", "W1004"] } });
    expect(t.json.entry.addedCount).toBe(2);
    const kid = (t.json.added as FindEntryView[])[0]!;
    expect((await call({ method: "DELETE", url: `/projects/${pid}/find/${kid.id}` })).status).toBe(200);
    expect((await entry(pid, eid))!.addedCount).toBe(1);
    const o = await call({ url: `/projects/${pid}/find/${eid}/options` });
    expect(o.json.works.filter((w: { added?: true }) => w.added).map((w: { id: string }) => w.id)).toEqual(["W1004"]);
    const again = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1003"] } });
    expect(again.status, again.body).toBe(200);
    expect(again.json.entry.addedCount).toBe(2);
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1003"] } })).json.error.reason).toBe("already-added");
  });

  it("a person id not among the entry's people is refused; so is a works id not among its works; choosePerson twice: the second is refused in words", async () => {
    const { pid, eid } = await choosingPerson();
    const bad = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A9999" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.unknownPerson, reason: "unknown-person" });
    for (const personId of ["https://openalex.org/A5001", "A", 5001, null, "A5001 "]) {
      const r = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId } });
      expect(r.status, String(personId)).toBe(400);
      expect(r.json.error.reason, String(personId)).toBe("person-id");
    }
    // Works on an entry that is not choosing works: 409 in words.
    const early = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1000"] } });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.entryState, reason: "entry-state" });
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A5002" } })).status).toBe(200);
    const again = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A5002" } });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.entryState, reason: "entry-state" });
    await waitState(pid, eid, "choose-works");
    const notHis = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W2000", "W1000"] } });
    expect(notHis.status).toBe(400);
    expect(notHis.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.unknownWork, reason: "unknown-work" });
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W2000", "x"] } })).json.error).toMatchObject({ message: findWorkIdRefusal(2), reason: "work-ids" });
    // An entry of another project, or none: 404.
    const other = await newProject(false, "Other");
    expect((await call({ method: "POST", url: `/projects/${other}/find/${eid}/works`, body: { workIds: ["W2000"] } })).status).toBe(404);
    expect((await call({ url: `/projects/${other}/find/${eid}/options` })).status).toBe(404);
  });

  it("51 ids are refused; an id already added is refused by its position; the queue full is refused whole", async () => {
    const { pid, eid } = await choosingPerson();
    await call({ method: "POST", url: `/projects/${pid}/find/${eid}/person`, body: { personId: "A5001" } });
    await waitState(pid, eid, "choose-works");
    const ids = Array.from({ length: 51 }, (_, i) => `W${1000 + i}`);
    const many = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ids } });
    expect(many.status).toBe(400);
    expect(many.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.tooManyWorks, reason: "work-ids" });
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: [] } })).json.error).toMatchObject({ message: FIND_ROUTE_TEXT.noWorks, reason: "work-ids" });
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: "W1000" } })).json.error.reason).toBe("work-ids");
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1003"] } })).status).toBe(200);
    const twice = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1004", "W1003"] } });
    expect(twice.status).toBe(409);
    expect(twice.json.error).toMatchObject({ message: findAlreadyAddedRefusal(2), reason: "already-added" });
    // The queue full (500 entries not removed): refused whole with the plan's sentence.
    const lines = Array.from({ length: 50 }, (_, i) => `Filler line number ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} entry`);
    for (let k = 0; k < 9; k++) await add(pid, lines.map((l) => `${l} ${String.fromCharCode(97 + k)}`));
    await add(pid, lines.slice(0, 48).map((l) => `${l} z`));
    expect((await queue(pid)).entries.length).toBe(500);
    const full = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/works`, body: { workIds: ["W1005"] } });
    expect(full.status).toBe(409);
    expect(full.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.queueFull, reason: "queue-full" });
    expect((await queue(pid)).entries.length).toBe(500);
  });
});

// Task F8b (R279): an author's name that is also a title — the entry asks among the works and carries an author offer;
// `POST …/:eid/author` turns it into the author's flow. Made-up people; "Vexmoor" is looked for in every log line,
// error and event.

describe("F8b: a name that is also a title", () => {
  const NAME = "Ottoline Vexmoor";
  /** A reference work's entry TITLED with the person's name. */
  const ENTRY: Work = { doi: "10.5555/ao.f8b.entry", title: NAME, family: "Editors", year: 2004 };
  const person = (n: number, name: string, aff: string) => ({ id: `https://openalex.org/A${n}`, display_name: name, works_count: 12, last_known_institutions: [{ display_name: aff }] });
  const work = (n: number, title: string, date: string) => ({
    id: `https://openalex.org/W${n}`,
    title,
    display_name: title,
    publication_year: Number(date.slice(0, 4)),
    publication_date: date,
    type: "article",
    doi: `https://doi.org/10.5555/ao.f8b.r${n}`,
    primary_location: { source: { display_name: "Journal of Invented Studies" } },
    authorships: [{ author: { display_name: NAME } }],
  });
  const waitState = (pid: string, eid: string, s: string) => until(async () => ((e) => (e?.state === s ? e : undefined))(await entry(pid, eid)), `the entry to be ${s}`);
  const author = (pid: string, eid: string, body?: unknown) => call({ method: "POST", url: `/projects/${pid}/find/${eid}/author`, ...(body !== undefined ? { body } : {}) });

  /** An entry in "choose" with an author offer: two people (or one) fit the name, and a work is titled with it. */
  async function offered(o: { one?: boolean; encrypted?: boolean; lib?: string } = {}): Promise<{ pid: string; eid: string; path: string }> {
    answers.set(NAME, cr(ENTRY, VEX_A));
    peopleAnswers.set(NAME, { meta: { count: 2 }, results: [person(5001, NAME, "Vexmoor Institute of Made-up Things"), o.one ? person(5002, "Ottoline Vexmoorson", "Elsewhere College") : person(5003, "Ottoline R. Vexmoor", "College of Vexmoor Studies")] });
    personWorks.set("A5001", Array.from({ length: 4 }, (_, i) => work(3000 + i, `Vexmoor Tide Table ${i}`, `${2020 - i}-01-01`)));
    await start();
    const path = await openNewLibrary(o.lib);
    const pid = await newProject(o.encrypted === true);
    const [e] = await add(pid, [NAME]);
    await waitState(pid, e!.id, "choose");
    return { pid, eid: e!.id, path };
  }

  it("the author offer carries counts only; the queue's answer holds no name; options answers the candidates only", async () => {
    const { pid, eid } = await offered();
    const q = await call({ url: `/projects/${pid}/find` });
    const e = (q.json as FindQueueResponse).entries.find((x) => x.id === eid)!;
    expect(e.state).toBe("choose");
    expect(e.authorOffer).toEqual({ peopleCount: 2 });
    for (const k of ["people", "peopleCount", "morePeople", "works", "worksCount"]) expect(e).not.toHaveProperty(k);
    expect(e.candidates!.map((c) => c.identifiers.doi)).toContain(ENTRY.doi);
    // No person's name, affiliation or OpenAlex id in the queue's answer.
    for (const w of ["Ottoline R. Vexmoor", "Made-up Things", "College of Vexmoor", "A5001", "A5003"]) expect(q.body.includes(w), w).toBe(false);
    const o = await call({ url: `/projects/${pid}/find/${eid}/options` });
    expect(o.status).toBe(200);
    expect(Object.keys(o.json)).toEqual(["candidates"]);
  });

  it("author: more than one person → choose-person, the people listed then; a second press is 409 in words, nothing changed", async () => {
    const { pid, eid } = await offered();
    const sentBefore = gated.sent.filter((s) => s.service === "openalex").length;
    const r = await author(pid, eid);
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ id: eid, state: "choose-person", peopleCount: 2 });
    expect(r.json).not.toHaveProperty("candidates");
    expect(r.json).not.toHaveProperty("authorOffer");
    // No new people search: the people stored are listed.
    expect(gated.sent.filter((s) => s.service === "openalex").length).toBe(sentBefore);
    const o = await call({ url: `/projects/${pid}/find/${eid}/options` });
    expect(o.json.people.map((x: { id: string }) => x.id)).toEqual(["A5001", "A5003"]);
    const before = await entry(pid, eid);
    const again = await author(pid, eid);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "CONFLICT", message: FIND_ROUTE_TEXT.noAuthor, reason: "no-author" });
    expect(await entry(pid, eid)).toEqual(before);
    for (const w of ["A5001", "Made-up"]) expect(logs.includes(w), w).toBe(false);
    for (const ev of events) if (ev.type === "find.progress") expect(Object.keys(ev.data as object).sort()).toEqual(["entryId", "projectId", "state"]);
  });

  it("author: exactly one person → looking-up with that person, then choose-works", async () => {
    const { pid, eid } = await offered({ one: true });
    expect((await entry(pid, eid))!.authorOffer).toEqual({ peopleCount: 1 });
    const r = await author(pid, eid);
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ state: "looking-up", chosen: "A5001", peopleCount: 1 });
    const cw = await waitState(pid, eid, "choose-works");
    expect(cw).toMatchObject({ worksCount: 4, peopleCount: 1 });
    expect(cw).not.toHaveProperty("candidates");
  });

  it("the route: the extension's token, a malformed id, another project's entry, a body field, an entry without the offer", async () => {
    const { pid, eid } = await offered();
    const before = await entry(pid, eid);
    const token = await pairExtension();
    const ext = await svc!.app.inject({ method: "POST", url: `/projects/${pid}/find/${eid}/author`, headers: { authorization: `Bearer ${token}`, origin: EXT } });
    errorBodies.push(ext.body);
    expect(ext.statusCode).toBe(403);
    expect((await author(pid, "not-an-id")).status).toBe(400);
    const other = await newProject(false, "Other");
    const elsewhere = await author(other, eid);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.json.error.message).toBe(FIND_ROUTE_TEXT.entryNotFound);
    const withBody = await author(pid, eid, { personId: "A5001" });
    expect(withBody.status).toBe(400);
    expect(withBody.json.error.code).toBe("VALIDATION");
    // R285 b: the sentence is the shared one.
    expect(withBody.json.error.message).toBe(FIND_ROUTE_TEXT.noBody);
    expect(withBody.body.includes("A5001")).toBe(false);
    expect(await entry(pid, eid)).toEqual(before);
    // An entry asking among works with no author offer.
    const [plain] = await add(pid, [AMBIGUOUS]);
    await settled(pid, plain!.id);
    const no = await author(pid, plain!.id);
    expect(no.status).toBe(409);
    expect(no.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.noAuthor, reason: "no-author" });
  });

  it("R285 b: two presses at once end as one change and one refusal in words", async () => {
    const { pid, eid } = await offered();
    // The first press is held inside its turn; the second passes the route's own check meanwhile and is refused by
    // the runner once its turn comes.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    runnerSeams.inAct = async () => {
      if (n++ === 0) await gate;
    };
    const first = author(pid, eid);
    await sleep(50);
    const second = author(pid, eid);
    await sleep(50);
    release();
    const answers2 = await Promise.all([first, second]);
    expect(answers2.map((a) => a.status).sort()).toEqual([200, 409]);
    const refused = answers2.find((a) => a.status === 409)!;
    expect(refused.json.error).toMatchObject({ code: "CONFLICT", message: FIND_ROUTE_TEXT.noAuthor, reason: "no-author" });
    expect((await entry(pid, eid))!.state).toBe("choose-person");
    expect(events.filter((e) => e.type === "find.progress" && (e.data as { entryId: string }).entryId === eid && (e.data as { state: string }).state === "choose-person")).toHaveLength(1);
  });

  it("R283 a: a people search that fails does not hold back an entry with work candidates: choose with people-unavailable; Try again is accepted and looks again", async () => {
    answers.set(NAME, cr(ENTRY, VEX_A));
    // An answer of another shape: the people search fails.
    peopleAnswers.set(NAME, { results: "not a list" });
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const [e] = await add(pid, [NAME]);
    const chosen = await waitState(pid, e!.id, "choose");
    expect(chosen.reason).toEqual({ code: "people-unavailable" });
    expect(chosen).not.toHaveProperty("authorOffer");
    expect(FIND_REASON_TEXT["people-unavailable"]).toBe("People of this name could not be looked up just now. “Try again” looks again.");
    peopleAnswers.set(NAME, { meta: { count: 2 }, results: [person(5001, NAME, "Vexmoor Institute of Made-up Things"), person(5003, "Ottoline R. Vexmoor", "College of Vexmoor Studies")] });
    const again = await call({ method: "POST", url: `/projects/${pid}/find/${e!.id}/retry` });
    expect(again.status, again.body).toBe(200);
    expect(again.json).toMatchObject({ state: "looking-up" });
    const offeredNow = await until(async () => ((x) => (x?.state === "choose" && x.authorOffer ? x : undefined))(await entry(pid, e!.id)), "the author offer");
    expect(offeredNow.authorOffer).toEqual({ peopleCount: 2 });
    expect(offeredNow.reason).toBeUndefined();
  });

  it("the route: locked is 423, read-only 409, closed 503 — each changing nothing", async () => {
    // Locked.
    const { pid, eid } = await offered({ encrypted: true });
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const locked = await author(pid, eid);
    expect(locked.status).toBe(423);
    expect(locked.json.error).toMatchObject({ code: "PROJECT_LOCKED", message: FIND_ROUTE_TEXT.locked });
    await svc!.close();
    svc = undefined;
    // Closed: the press waits for the project's turn (held by another way in), and the library closes meanwhile.
    const { pid: p2, eid: e2, path } = await offered({ lib: "Lib2" });
    const s = svc!.state.session!;
    let free!: () => void;
    const turn = serialStore(s.repo, p2, () => new Promise<void>((r) => (free = r)));
    const pressing = author(p2, e2);
    await sleep(50);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const files = await snapshot(path);
    free();
    await turn;
    const closed = await pressing;
    expect(closed.status).toBe(503);
    expect(closed.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.closed, reason: "closed" });
    await sleep(100);
    expect(await snapshot(path)).toEqual(files);
    // Read-only: another device holds the library.
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    const ro = await author(p2, e2);
    expect(ro.status).toBe(409);
    expect(ro.json.error).toMatchObject({ code: "READ_ONLY", message: FIND_ROUTE_TEXT.readOnly });
    expect((await entry(p2, e2))!).toMatchObject({ state: "choose", authorOffer: { peopleCount: 2 } });
  });
});
