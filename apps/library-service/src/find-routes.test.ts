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
import { FindRunnerClosedError, deviceDeps, rebuildIndexIfNeeded, type Deps } from "@ao/library";
import { FIND_REASON_CODES, FIND_REASON_TEXT, FIND_ROUTE_TEXT, FIND_STOPPED_TEXT, type FindEntryView, type FindQueueResponse } from "@ao/shared";
import { serialStore } from "../../../packages/library/src/import/project-queue.js";
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

function textOf(path: string): string {
  const q = new URL(`https://x${path}`).searchParams;
  return q.get("query.bibliographic") ?? q.get("search") ?? "";
}

/** The made-up services, with requests that can be held open until released. */
class Gated extends Dispatcher {
  private readonly holds = new Map<string, Promise<void>>();
  private all: { gate: Promise<void>; release: () => void } | undefined;
  readonly sent: Array<{ service: string; text: string }> = [];
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
  releaseAll(): void {
    this.all?.release();
    this.all = undefined;
    for (const k of [...this.holds.keys()]) this.holds.delete(k);
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const service = String(opts.origin).includes("crossref") ? "crossref" : "openalex";
    const text = textOf(String(opts.path));
    this.sent.push({ service, text });
    const gate = (service === "crossref" ? this.holds.get(text) : undefined) ?? this.all?.gate;
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
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works?"), method: "GET" })
    .reply(() => ({ statusCode: 200, data: JSON.stringify(OA_EMPTY), responseOptions: { headers: { "content-type": "application/json" } } }))
    .persist();
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
  // A lookup released after its library closed may still be writing its answer into the lookup cache.
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
const FINAL = ["choose", "already", "maybe-duplicate", "record-complete", "not-found", "failed"];
const settled = (pid: string, eid: string) => until(async () => ((e) => (e && FINAL.includes(e.state) ? e : undefined))(await entry(pid, eid)), "the entry to settle");
const asked = (text: string) => gated.sent.filter((s) => s.service === "crossref" && s.text === text).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every file of the library (but its lookup cache) with its content, for "nothing changed". */
async function snapshot(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (r === ".cache") continue;
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
    expect(done.state).toBe("record-complete");
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
    await writeFile(gov, goodRules);
    // A queue none of whose lines can be read.
    await writeFile(file, "garbage\nmore garbage\n");
    const r = await call({ url: `/projects/${pid}/find` });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ message: FIND_STOPPED_TEXT["queue-unreadable"], reason: "queue-unreadable" });
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
    expect((await settled(pid, e!.id)).state).toBe("record-complete");
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
    expect((await settled(pid, e!.id)).state).toBe("record-complete");
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
    expect((await settled(pid, e!.id)).state).toBe("record-complete");
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
    expect(madeA.state).toBe("record-complete");
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
