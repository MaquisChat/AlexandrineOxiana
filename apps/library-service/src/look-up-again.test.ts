/**
 * Decision 31 (c), "Look up again" (R566 3, 4, 5, 8; R577 4): the service's automatic pass and the researcher's route.
 *  - The pass runs once after an opening, at an unlock and on a quiet timer; it takes the due entries one after another
 *    (never in parallel), at most LOOK_UP_AGAIN_PASS_MAX per pass, leaves a service alone once it asks to wait again,
 *    never takes a lookup that failed outright, and sends and writes nothing once the library begins to close.
 *  - `POST /review/:itemId/look-up-again` asks at once when it may, says "not yet" (sending nothing) before the service's
 *    named time, and is refused as the other review routes refuse.
 *  - The queue's entry carries `lookUp` (state, tries, whether the act may send now, its time) with no title and no
 *    identifier in it.
 * Every request is answered by a MockAgent that refuses the network; the service's clock is the test's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LIBRARY_CLOSED_TEXT, LOOKUP_WAITING_TEXT, LOOK_UP_AGAIN_TEXT } from "@ao/shared";
import { HttpClient, LOOK_SEND_OP, LOOK_UP_AGAIN_OP, deviceDeps, lookUpAgain as engineLookUpAgain, type Deps } from "@ao/library";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
// Package-internal: an entry's lookup written as an earlier build would have (a lookup that failed outright).
import { importChange, projectReviewEntries } from "../../../packages/library/src/repo/repo.js";
import { storeRequest } from "../../../packages/library/src/repo/sources.js";
import type { ReviewEntry } from "../../../packages/library/src/repo/review.js";
import { FIXTURE_DOI, buildDoiPdf, buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";
import { LOOK_UP_AGAIN_PASS_MAX } from "./state.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PASS = "correct horse battery staple";
/** Lookups allowed: the file's title is searched at OpenAlex. */
const LOOKUP_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
`;
const NO_LOOKUP_GOV = `${LOOKUP_GOV}processing:
  metadata_lookup: []
`;
const SEARCH = readFileSync(join(import.meta.dirname, "../../../packages/library/tests/fixtures/lookup/openalex-search.json"), "utf8");
const MIN = 60_000;

type Answer = { statusCode: number; data?: string; headers?: Record<string, string> };
const WAIT_60: Answer = { statusCode: 429, data: "slow down", headers: { "retry-after": "60" } };
/**
 * Asked to wait again, for an hour. The lookup client keeps its own (real) clock, while the service's clock here runs
 * minutes ahead of it: an hour's wait is still ahead of the service's "now".
 */
const WAIT_HOUR: Answer = { statusCode: 429, data: "slow down", headers: { "retry-after": "3600" } };
const NO_RESULTS: Answer = { statusCode: 200, data: JSON.stringify({ results: [] }) };
const FOUND: Answer = { statusCode: 200, data: SEARCH };

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let agent: MockAgent;
let previous: Dispatcher;
/** The service's clock (the entries' times and the pass's "now"); the lookup client keeps its own (real) clock. */
let clock: number;
/** Every request sent, as `host search-or-path`, in order. */
let sent: string[];
/** What every host answers now. */
let answer: (host: string, path: string) => Answer;

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent", now: () => new Date(clock), ...over });
  return svc;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-look-again-svc-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  clock = Date.now();
  sent = [];
  answer = () => WAIT_60;
  agent = new MockAgent();
  agent.disableNetConnect();
  for (const origin of ["https://api.openalex.org", "https://api.crossref.org", "https://openlibrary.org"]) {
    const host = new URL(origin).hostname;
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((req) => {
        const search = new URLSearchParams(req.path.split("?")[1] ?? "").get("search");
        sent.push(`${host} ${search ?? req.path}`);
        const a = answer(host, req.path);
        return { statusCode: a.statusCode, data: a.data ?? "", responseOptions: { headers: { "content-type": "application/json", ...(a.headers ?? {}) } } };
      })
      .persist();
  }
  previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

type Inject = { method?: "GET" | "POST" | "PUT"; url: string; body?: unknown; headers?: Record<string, string> };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.headers ?? auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

const titleOf = (i: number) => `Harbour ledger number ${String(i).padStart(2, "0")}`;

async function pdf(name: string, data: Buffer | Promise<Buffer>): Promise<string> {
  const p = join(tmp, "Desktop", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await data);
  return p;
}

interface Lib {
  path: string;
  pid: string;
  folder: string;
  /** The waiting entries' sources, oldest first. */
  sources: string[];
}

/**
 * A library whose project holds `n` files attached while OpenAlex asked to wait (decision 31 b): each a review entry
 * reading "Waiting for lookup service response.". One request is sent (the first; the client then holds the service).
 * Each attach a second apart on the service's clock, so their order is known.
 */
async function libraryWithWaiting(n: number, o: { gov?: string; encrypted?: boolean; files?: Array<() => Promise<Buffer>> } = {}): Promise<Lib> {
  const path = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: o.gov ?? LOOKUP_GOV, encryption: o.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(p.status, p.body).toBe(200);
  const pid = p.json.project.id as string;
  answer = () => WAIT_60;
  const sources: string[] = [];
  const files = o.files ?? Array.from({ length: n }, (_, i) => () => buildPdf({ title: titleOf(i + 1), author: "Ana Souza", lines: [`${titleOf(i + 1)}.`] }));
  for (const [i, f] of files.entries()) {
    clock += 1000;
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf(`f${i}.pdf`, f())] } });
    expect(att.status, att.body).toBe(200);
    expect(att.json.items[0]).toMatchObject({ outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    sources.push(att.json.items[0].sourceId as string);
  }
  await svc!.state.idle();
  sent = [];
  return { path, pid, folder: p.json.project.folder as string, sources };
}

/** Closes and opens the library again (a fresh lookup client: nothing held in memory), the clock moved on by `ms`. */
async function reopen(lib: Lib, ms: number) {
  expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
  clock += ms;
  const r = await call({ method: "POST", url: "/libraries/open", body: { path: lib.path } });
  expect(r.status, r.body).toBe(200);
  return r;
}

async function queue(pid: string): Promise<any[]> {
  const q = await call({ url: `/projects/${pid}/review` });
  expect(q.status, q.body).toBe(200);
  return q.json.items as any[];
}
const bySource = (items: any[], sid: string) => items.find((e) => e.sourceId === sid);

async function storedEntries(pid: string): Promise<ReviewEntry[]> {
  return projectReviewEntries(svc!.state.session!.repo, pid);
}

/** Rewrites an entry as an earlier change would have written it (a governed change of the test's own). */
async function patchEntry(pid: string, sourceId: string, f: (e: ReviewEntry) => Partial<ReviewEntry>): Promise<void> {
  const repo = svc!.state.session!.repo;
  const e = (await storedEntries(pid)).find((x) => x.sourceId === sourceId && x.status === "pending")!;
  const sf = await repo.getSource(pid, sourceId);
  await importChange(repo, pid, storeRequest(sf.source.provenance), async (ops) => ops.updateReview({ ...e, ...f(e) }), { op: "test.patch" });
}

/**
 * The look-up ops of the project's audit log, in order, with the entry each names. Consecutive lines of the same op for
 * the same entry are one step: the send may be audited as one line per service asked (R585 M8).
 */
async function lookUpAudit(pid: string): Promise<Array<{ op: string; entry: string; by: string }>> {
  const { events } = await svc!.state.session!.repo.readAudit(pid);
  const steps = [...events]
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => e.details?.op === LOOK_SEND_OP || e.details?.op === LOOK_UP_AGAIN_OP)
    .map((e) => ({ op: e.details!.op as string, entry: e.details!.reviewEntry as string, by: e.details!.by as string }));
  return steps.filter((x, i) => i === 0 || x.op !== steps[i - 1]!.op || x.entry !== steps[i - 1]!.entry);
}

/** Every file under `root` with its bytes' digest: equal snapshots mean nothing was written in between. */
async function snapshot(root: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(`${rel}/`, ...(await snapshot(root, rel)));
    else out.push(`${rel} ${createHash("sha256").update(await readFile(join(root, rel))).digest("hex")}`);
  }
  return out.sort();
}
const reviewFile = (lib: Lib) => readFile(join(lib.path, lib.folder, "review", "pending.jsonl"));

const lookUpAgain = (pid: string, itemId: string, headers?: Record<string, string>) =>
  call({ method: "POST", url: `/review/${itemId}/look-up-again`, body: { projectId: pid }, ...(headers ? { headers } : {}) });

// ---- the automatic pass ----------------------------------------------------------------

describe("the automatic pass (R566 3, R577 i)", () => {
  it("runs once after an opening, without delaying its answer: the due entries are looked up oldest first, one after another", async () => {
    await start();
    const lib = await libraryWithWaiting(3);
    answer = () => NO_RESULTS;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    // One request per entry, in the order the files came in.
    expect(sent).toEqual([1, 2, 3].map((i) => `api.openalex.org ${titleOf(i)} Souza`));
    // Strictly one after another: each entry's send is audited, then its result written, before the next is sent.
    const entries = await storedEntries(lib.pid);
    const ids = lib.sources.map((sid) => entries.find((e) => e.sourceId === sid)!.id);
    expect(await lookUpAudit(lib.pid)).toEqual(ids.flatMap((id) => [{ op: LOOK_SEND_OP, entry: id, by: "automatic" }, { op: LOOK_UP_AGAIN_OP, entry: id, by: "automatic" }]));
    // Nothing of the record changed: what was found is only the entry's (here nothing, said in its reasons).
    for (const sid of lib.sources) {
      const e = bySource(await queue(lib.pid), sid);
      expect(e.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.nothing);
      expect(e.lookUp).toEqual({ state: "nothing", tries: 1, canLookUpNow: false });
    }
  });

  it("idle() waits for the pass", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    answer = () => NO_RESULTS;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    const orig = HttpClient.prototype.getJson;
    HttpClient.prototype.getJson = async function (this: HttpClient, ...a: Parameters<HttpClient["getJson"]>) {
      reached();
      await gate;
      return orig.apply(this, a);
    } as HttpClient["getJson"];
    try {
      await reopen(lib, 16 * MIN);
      await atGate;
      let idle = false;
      const waiting = svc!.state.idle().then(() => (idle = true));
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(idle).toBe(false);
      expect(svc!.state.workKinds()).toContain("lookup-again");
      release();
      await waiting;
      expect(sent).toHaveLength(1);
      expect(svc!.state.workKinds()).not.toContain("lookup-again");
    } finally {
      HttpClient.prototype.getJson = orig;
      release();
    }
  });

  it(`takes at most ${LOOK_UP_AGAIN_PASS_MAX} entries in one pass; the next pass takes the rest`, async () => {
    expect(LOOK_UP_AGAIN_PASS_MAX).toBe(20);
    await start();
    const lib = await libraryWithWaiting(LOOK_UP_AGAIN_PASS_MAX + 2);
    answer = () => NO_RESULTS;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual(Array.from({ length: LOOK_UP_AGAIN_PASS_MAX }, (_, i) => `api.openalex.org ${titleOf(i + 1)} Souza`));
    await svc!.state.runLookUpAgain();
    expect(sent.slice(LOOK_UP_AGAIN_PASS_MAX)).toEqual([`api.openalex.org ${titleOf(LOOK_UP_AGAIN_PASS_MAX + 1)} Souza`, `api.openalex.org ${titleOf(LOOK_UP_AGAIN_PASS_MAX + 2)} Souza`]);
  });

  it("a service that asks to wait again is left alone for the rest of the pass (R566 5, R411)", async () => {
    await start();
    const lib = await libraryWithWaiting(3);
    answer = () => WAIT_HOUR;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    const items = await queue(lib.pid);
    // The first was tried (one try, still waiting); the others were not asked and are as they were.
    expect(bySource(items, lib.sources[0]!).lookUp).toMatchObject({ state: "waiting", tries: 1, canLookUpNow: false, notBefore: expect.any(String) });
    for (const sid of lib.sources.slice(1)) expect(bySource(items, sid).lookUp).toMatchObject({ state: "waiting", tries: 0 });
    expect((await lookUpAudit(lib.pid)).filter((a) => a.op === LOOK_SEND_OP)).toHaveLength(1);
  });

  it("a lookup that failed outright is not taken by the pass (R577 iv)", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    await patchEntry(lib.pid, lib.sources[0]!, (e) => ({ leftOut: e.leftOut!.map(({ notBefore: _n, ...l }) => ({ ...l, why: "failed" as const })) }));
    answer = () => FOUND;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    await svc!.state.runLookUpAgain();
    expect(sent).toEqual([]);
    expect(bySource(await queue(lib.pid), lib.sources[0]!).lookUp).toEqual({ state: "failed", tries: 0, canLookUpNow: true });
  });

  it("runs when a locked project is unlocked; nothing is asked while it is locked (R566 4)", async () => {
    await start();
    const lib = await libraryWithWaiting(2, { encrypted: true });
    answer = () => NO_RESULTS;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual([]);
    const u = await call({ method: "POST", url: `/projects/${lib.pid}/unlock`, body: { secret: PASS } });
    expect(u.status, u.body).toBe(200);
    await svc!.state.idle();
    expect(sent).toEqual([1, 2].map((i) => `api.openalex.org ${titleOf(i)} Souza`));
  });

  it("a read-only library: nothing is asked", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(lib.path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now }));
    clock += 16 * MIN;
    answer = () => FOUND;
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path: lib.path } });
    expect(opened.json.mode).toBe("read-only");
    await svc!.state.idle();
    await svc!.state.runLookUpAgain();
    expect(sent).toEqual([]);
    expect(svc!.state.workKinds()).not.toContain("lookup-again");
  });

  it("a project whose rules now allow no lookup: nothing is asked; the entry says so", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const g = await call({ url: `/projects/${lib.pid}/governance` });
    const put = await call({ method: "PUT", url: `/projects/${lib.pid}/governance`, body: { yaml: NO_LOOKUP_GOV, baseSha256: g.json.sha256 } });
    expect(put.status, put.body).toBe(200);
    answer = () => FOUND;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual([]);
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    expect(e.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.notAllowed);
    expect(e.lookUp).toMatchObject({ state: "not-allowed", canLookUpNow: true });
  });

  it("on a quiet timer every ten minutes while the library is open; stopped when it closes", async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    answer = () => NO_RESULTS;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      // Opened a minute later: nothing is due yet (the first wait is fifteen minutes).
      await reopen(lib, MIN);
      await svc!.state.idle();
      expect(sent).toEqual([]);
      clock += 16 * MIN;
      vi.advanceTimersByTime(10 * MIN - 1);
      await svc!.state.idle();
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      await svc!.state.idle();
      expect(sent).toEqual([1, 2].map((i) => `api.openalex.org ${titleOf(i)} Souza`));
      // Closed: the timer is gone.
      expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await svc?.close();
      svc = undefined;
      vi.useRealTimers();
    }
  });

  it("the timer's interval is the service's option (lookUpAgainCheckMs)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await start({ lookUpAgainCheckMs: 5 * MIN });
      const lib = await libraryWithWaiting(1);
      answer = () => NO_RESULTS;
      // A fresh client (nothing held), a minute on: nothing due at the opening.
      await reopen(lib, MIN);
      await svc!.state.idle();
      expect(sent).toEqual([]);
      clock += 16 * MIN;
      vi.advanceTimersByTime(5 * MIN - 1);
      await svc!.state.idle();
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      await svc!.state.idle();
      expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    } finally {
      await svc?.close();
      svc = undefined;
      vi.useRealTimers();
    }
  });

  it("a move holds it back: nothing is asked while the move holds work, and a quiesce stops the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await start();
      const lib = await libraryWithWaiting(1);
      answer = () => NO_RESULTS;
      clock += 16 * MIN;
      svc!.state.moving = true;
      await svc!.state.runLookUpAgain();
      expect(sent).toEqual([]);
      svc!.state.moving = false;
      await svc!.state.quiesce(svc!.state.session!);
      vi.advanceTimersByTime(60 * MIN);
      await svc!.state.idle();
      expect(sent).toEqual([]);
      void lib;
    } finally {
      await svc?.close();
      svc = undefined;
      vi.useRealTimers();
    }
  });
});

describe("the pass and a close (R546, R247 c)", () => {
  it("once beginClosing has run, nothing is sent or written: 0 requests, the folder byte-identical after close() resolved", async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    answer = () => FOUND;
    // Opened a minute later (nothing due at the opening), then due.
    await reopen(lib, MIN);
    await svc!.state.idle();
    clock += 16 * MIN;
    const s = svc!.state.session!;
    await svc!.state.beginClosing(s);
    const before = await snapshot(lib.path);
    await svc!.state.runLookUpAgain();
    const r = await lookUpAgain(lib.pid, (await storedEntries(lib.pid))[0]!.id);
    expect([r.status, r.json.error]).toEqual([409, { code: "LIBRARY_CLOSED", message: LIBRARY_CLOSED_TEXT }]);
    expect(sent).toEqual([]);
    expect(await snapshot(lib.path)).toEqual(before);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const afterClose = await snapshot(lib.path);
    await svc!.state.idle();
    expect(await snapshot(lib.path)).toEqual(afterClose);
    expect(sent).toEqual([]);
  });

  it("a pass under way when the library closes ends without an error and without a half-written entry", async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    const reviewBefore = await reviewFile(lib);
    // The first request stays in the air (its answer is ten minutes away); the close cuts it.
    let arrived!: () => void;
    const asked = new Promise<void>((r) => (arrived = r));
    let n = 0;
    await agent.close();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://api.openalex.org")
      .intercept({ path: () => true, method: "GET" })
      .reply(() => {
        n++;
        arrived();
        return { statusCode: 200, data: SEARCH, responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .delay(600_000)
      .persist();
    const warned: string[] = [];
    const log = svc!.app.log;
    const origWarn = log.warn.bind(log);
    (log as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => {
      warned.push(String(a[1] ?? a[0]));
      origWarn(...(a as [object]));
    };
    await reopen(lib, 16 * MIN);
    await asked;
    const closed = await call({ method: "POST", url: "/libraries/close" });
    expect(closed.status, closed.body).toBe(200);
    const afterClose = await snapshot(lib.path);
    await svc!.state.idle();
    expect(await snapshot(lib.path)).toEqual(afterClose);
    expect(n).toBe(1);
    // The entries are as they were: nothing of the look-up was written (its send's audit line stands alone).
    expect(await reviewFile(lib)).toEqual(reviewBefore);
    expect(warned.filter((w) => /lookup-again/.test(w))).toEqual([]);
  });
});

// ---- the route ----------------------------------------------------------------------------

describe("POST /review/:itemId/look-up-again (R577 iii)", () => {
  it("asks at once when the service's time has passed: the new matches are appended and the entry is answered", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    // A fresh client, two minutes on: the service's time has passed; the automatic pass's first wait has not.
    await reopen(lib, 2 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual([]);
    const id = bySource(await queue(lib.pid), lib.sources[0]!).id as string;
    answer = () => FOUND;
    const r = await lookUpAgain(lib.pid, id);
    expect(r.status, r.body).toBe(200);
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    expect(r.json.outcome).toEqual({ kind: "found", found: 2 });
    expect(r.json.entry).toMatchObject({ id, sourceId: lib.sources[0], kind: "import", group: "attach" });
    expect(r.json.entry.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.found);
    expect(r.json.entry.candidates.map((c: { title: string }) => c.title)).toEqual(["Rivers and Memory in Upland Villages", expect.any(String)]);
    // R585 M3 (R592): a researcher's press is never counted as a try.
    expect(r.json.entry.lookUp).toEqual({ state: "found", tries: 0, canLookUpNow: false });
    // The queue lists the same entry, the matches in the same order (accepted by position).
    expect(bySource(await queue(lib.pid), lib.sources[0]!)).toEqual(r.json.entry);
    expect(await lookUpAudit(lib.pid)).toEqual([
      { op: LOOK_SEND_OP, entry: id, by: "researcher" },
      { op: LOOK_UP_AGAIN_OP, entry: id, by: "researcher" },
    ]);
  });

  it('before the service\'s named time: "not yet" with that time, 200, and nothing is sent', async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    expect(e.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: expect.any(String) });
    const r = await lookUpAgain(lib.pid, e.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json.outcome).toEqual({ kind: "not-yet", notBefore: expect.any(String) });
    expect(Date.parse(r.json.outcome.notBefore)).toBeGreaterThan(clock);
    expect(r.json.entry.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: r.json.outcome.notBefore });
    expect(r.json.entry.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    expect(sent).toEqual([]);
    expect(await lookUpAudit(lib.pid)).toEqual([]);
  });

  it("nothing found; asked to wait again; not allowed: each said, with the entry", async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    await reopen(lib, 2 * MIN);
    const items = await queue(lib.pid);
    const [a, b] = lib.sources.map((sid) => bySource(items, sid).id as string);
    answer = () => NO_RESULTS;
    const nothing = await lookUpAgain(lib.pid, a!);
    expect([nothing.status, nothing.json.outcome]).toEqual([200, { kind: "nothing" }]);
    expect(nothing.json.entry.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.nothing);
    answer = () => WAIT_HOUR;
    const wait = await lookUpAgain(lib.pid, b!);
    expect([wait.status, wait.json.outcome]).toEqual([200, { kind: "asked-to-wait", notBefore: expect.any(String) }]);
    // R585 M3 (R592): a researcher's press is never counted as a try.
    expect(wait.json.entry.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: wait.json.outcome.notBefore });
    expect(sent).toHaveLength(2);
    // A third press at once: the service's time has not come, nothing is sent.
    const again = await lookUpAgain(lib.pid, b!);
    expect([again.status, again.json.outcome.kind]).toEqual([200, "not-yet"]);
    expect(sent).toHaveLength(2);
    // Every lookup of the first has its answer.
    const done = await lookUpAgain(lib.pid, a!);
    expect([done.status, done.json.outcome]).toEqual([200, { kind: "nothing-to-look-up" }]);
    expect(sent).toHaveLength(2);
  });

  it("the rules no longer allow it: not allowed, nothing sent", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const g = await call({ url: `/projects/${lib.pid}/governance` });
    expect((await call({ method: "PUT", url: `/projects/${lib.pid}/governance`, body: { yaml: NO_LOOKUP_GOV, baseSha256: g.json.sha256 } })).status).toBe(200);
    await reopen(lib, 2 * MIN);
    const id = bySource(await queue(lib.pid), lib.sources[0]!).id as string;
    const r = await lookUpAgain(lib.pid, id);
    expect([r.status, r.json.outcome]).toEqual([200, { kind: "not-allowed" }]);
    expect(r.json.entry.reasons[0]).toBe(LOOK_UP_AGAIN_TEXT.notAllowed);
    expect(sent).toEqual([]);
  });

  it("a press on a lookup that failed outright asks at once (R577 iv)", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    await patchEntry(lib.pid, lib.sources[0]!, (e) => ({ leftOut: e.leftOut!.map(({ notBefore: _n, ...l }) => ({ ...l, why: "failed" as const })) }));
    // A fresh client at the same moment: nothing held; the failed lookup has no time to wait for.
    await reopen(lib, 0);
    await svc!.state.idle();
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    expect(e.lookUp).toEqual({ state: "failed", tries: 0, canLookUpNow: true });
    answer = () => FOUND;
    const r = await lookUpAgain(lib.pid, e.id);
    expect([r.status, r.json.outcome]).toEqual([200, { kind: "found", found: 2 }]);
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
  });

  it('R585 (3), R592: the library\'s "under-way" (a look-up of this entry is already under way) answers the entry as it stands, not an error', async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    // The library's own refusal (R585 3), by its name; the route's switch over it is exhaustive.
    svc!.state.lookUpAgainByHand = async () => ({ done: false, why: "under-way" }) as Awaited<ReturnType<LibraryService["state"]["lookUpAgainByHand"]>>;
    const r = await lookUpAgain(lib.pid, e.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ outcome: { kind: "under-way" }, entry: e });
    expect(sent).toEqual([]);
  });

  it("refused as the other review routes refuse: missing, decided, locked, read-only; the extension's token", async () => {
    await start();
    const code = await svc!.app.inject({ method: "POST", url: "/extension/pair", headers: auth });
    const confirmed = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json().code }) });
    const extToken = confirmed.json().token as string;
    const lib = await libraryWithWaiting(2, { encrypted: true });
    await reopen(lib, 2 * MIN);
    // Locked (after the reopen): 423, before anything is read.
    const anyId = "019a7000-0000-7000-8000-0000000000aa";
    const locked = await lookUpAgain(lib.pid, anyId);
    expect([locked.status, locked.json.error.code]).toEqual([423, "PROJECT_LOCKED"]);
    expect((await call({ method: "POST", url: `/projects/${lib.pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc!.state.idle();
    const items = await queue(lib.pid);
    const [a, b] = lib.sources.map((sid) => bySource(items, sid).id as string);
    // The extension's token: refused by the service's own check.
    const ext = await lookUpAgain(lib.pid, a!, { authorization: `Bearer ${extToken}`, origin: EXT });
    expect([ext.status, ext.json]).toEqual([403, { error: { code: "FORBIDDEN", message: "The browser extension cannot use this." } }]);
    // Not in the queue: the decide route's own not-found.
    const missing = await lookUpAgain(lib.pid, anyId);
    expect([missing.status, missing.json.error.code]).toEqual([404, "NOT_FOUND"]);
    // Decided: the decide route's own conflict.
    expect((await call({ method: "POST", url: `/review/${b}/decide`, body: { projectId: lib.pid, decision: { action: "skip" } } })).status).toBe(200);
    const decided = await lookUpAgain(lib.pid, b!);
    expect([decided.status, decided.json.error]).toEqual([409, { code: "CONFLICT", message: "This item has already been reviewed." }]);
    // A project not in the library: as the other review routes.
    const other = await call({ method: "POST", url: `/review/${a}/look-up-again`, body: { projectId: anyId } });
    expect(other.status).toBe(400);
    expect(sent).toEqual([]);
    // Read-only: the library's read-only answer.
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(lib.path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: lib.path } })).json.mode).toBe("read-only");
    const ro = await lookUpAgain(lib.pid, a!);
    expect([ro.status, ro.json.error.code]).toEqual([409, "READ_ONLY"]);
    expect(sent).toEqual([]);
  });
});

// ---- the queue's field ----------------------------------------------------------------------

describe("the queue's entry carries `lookUp` (R566 8)", () => {
  it("state, tries, whether the act may send now and its time — no title and no identifier in it; absent with nothing left out", async () => {
    await start();
    const lib = await libraryWithWaiting(1, { files: [() => buildDoiPdf() as Promise<Buffer>] });
    const items = await queue(lib.pid);
    const e = bySource(items, lib.sources[0]!);
    expect(e.reasons[0]).toBe(LOOKUP_WAITING_TEXT);
    // The identifier is the entry's hint (shown as before), never in the look-up field.
    expect(e.hints).toContain(`doi:${FIXTURE_DOI}`);
    expect(Object.keys(e.lookUp).sort()).toEqual(["canLookUpNow", "notBefore", "state", "tries"]);
    const bytes = JSON.stringify(e.lookUp);
    expect(bytes).not.toContain(FIXTURE_DOI);
    expect(bytes.toLowerCase()).not.toContain("doi");
    expect(bytes).not.toContain(e.title);
    expect(bytes).not.toMatch(/upland|rivers|memory/i);
    // An entry with nothing left out has no field (a file attached while lookups were not allowed).
    const p = await call({ method: "POST", url: "/projects", body: { name: "Plain", governanceYaml: NO_LOOKUP_GOV, encryption: { enabled: false } } });
    const pid = p.json.project.id as string;
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf("plain.pdf", buildPdf({ title: "Salt marsh survey", author: "Ana Souza", lines: ["Salt marsh survey."] }))] } });
    expect(att.status, att.body).toBe(200);
    for (const x of await queue(pid)) expect(x).not.toHaveProperty("lookUp");
  });
});

/** Holds the lookup client's FIRST request until released (released at the test's end whatever its end). */
function holdFirstRequest() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const orig = HttpClient.prototype.getJson;
  let n = 0;
  HttpClient.prototype.getJson = async function (this: HttpClient, ...a: Parameters<HttpClient["getJson"]>) {
    if (++n === 1) {
      reached();
      await gate;
    }
    return orig.apply(this, a);
  } as HttpClient["getJson"];
  onTestFinished(() => {
    HttpClient.prototype.getJson = orig;
    release();
  });
  return { atGate, release: () => release() };
}

describe("joined to the fixed engine (R592)", () => {
  it("point 2 (R585 point 5): a kept time only a wrong clock could have written (years ahead) is offered NOW, and the press sends", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const far = new Date(clock + 10 * 365 * 24 * 60 * MIN).toISOString();
    await patchEntry(lib.pid, lib.sources[0]!, (e) => ({ leftOut: e.leftOut!.map((l) => ({ ...l, notBefore: far })) }));
    // A fresh client at the same moment: nothing held in memory; the automatic pass's first wait has not passed.
    await reopen(lib, 0);
    await svc!.state.idle();
    expect(sent).toEqual([]);
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    // The engine's `lookUpNow`: the wrong-clock time counts as passed, and is never passed on as the button's time.
    expect(e.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: true });
    expect(JSON.stringify(e)).not.toContain(far);
    answer = () => FOUND;
    const r = await lookUpAgain(lib.pid, e.id);
    expect([r.status, r.json.outcome]).toEqual([200, { kind: "found", found: 2 }]);
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
  });

  it('point 3: a lookup the rules denied at send time, with another service answering nothing, is answered "not allowed" (the entry\'s state), not "nothing"', async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    const e = bySource(await queue(lib.pid), lib.sources[0]!);
    // The engine's answer for it (R592 ruled 3): one lookup asked (a service said nothing), the other service denied at send.
    svc!.state.lookUpAgainByHand = async () =>
      ({ done: true, entryId: e.id, sourceId: lib.sources[0]!, asked: 1, services: ["crossref"], sent: 1, notAllowed: 1, found: 0, state: { state: "not-allowed", tries: 0, fromFile: false } }) as Awaited<
        ReturnType<LibraryService["state"]["lookUpAgainByHand"]>
      >;
    const r = await lookUpAgain(lib.pid, e.id);
    expect([r.status, r.json.outcome]).toEqual([200, { kind: "not-allowed" }]);
    // `sent` is not passed on: the page has no use for the number.
    expect(JSON.stringify(r.json)).not.toContain('"sent"');
  });

  it("point 4 (R585 M3): every true state reaches the page — one lookup answered with matches and another still waiting: `also`, and both sentences in the reasons", async () => {
    await start();
    const lib = await libraryWithWaiting(1);
    // Two lookups of the entry, both waiting (as an attach that left out two lookups writes them); two searches, so
    // the lookup client's cache cannot answer the second from the first.
    await patchEntry(lib.pid, lib.sources[0]!, (e) => ({ leftOut: [e.leftOut![0]!, { ...e.leftOut![0]!, title: "Second harbour ledger" }] }));
    await reopen(lib, 2 * MIN);
    await svc!.state.idle();
    const id = bySource(await queue(lib.pid), lib.sources[0]!).id as string;
    answer = (_h, path) => (path.includes("Second") ? WAIT_HOUR : FOUND);
    const r = await lookUpAgain(lib.pid, id);
    expect(r.status, r.body).toBe(200);
    expect(sent).toHaveLength(2);
    expect(r.json.entry.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: expect.any(String), also: ["found"] });
    expect(r.json.entry.reasons.slice(0, 2)).toEqual([LOOK_UP_AGAIN_TEXT.found, LOOKUP_WAITING_TEXT]);
    expect(bySource(await queue(lib.pid), lib.sources[0]!)).toEqual(r.json.entry);
  });

  it("point 4: a mix with \"gave up\" carries the given-up lookups' own tries (`gaveUpTries`); one \"gave up\" and one \"not allowed\" carries both states", async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    const [a, b] = lib.sources;
    await patchEntry(lib.pid, a!, (e) => ({ leftOut: [e.leftOut![0]!, { ...e.leftOut![0]!, tries: 5, outcome: "gave-up" as const }] }));
    await patchEntry(lib.pid, b!, (e) => ({ leftOut: [{ ...e.leftOut![0]!, tries: 5, outcome: "gave-up" as const }, { ...e.leftOut![0]!, outcome: "not-allowed" as const }] }));
    const items = await queue(lib.pid);
    expect(bySource(items, a!).lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: expect.any(String), also: ["gave-up"], gaveUpTries: 5 });
    expect(bySource(items, b!).lookUp).toEqual({ state: "gave-up", tries: 5, canLookUpNow: false, notBefore: expect.any(String), also: ["not-allowed"] });
  });

  it("point 5: a press during the automatic pass's request for the same entry answers \"under way\" at once and sends nothing more", { timeout: 20_000 }, async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    answer = () => NO_RESULTS;
    const held = holdFirstRequest();
    // Opened past the first wait: the pass takes the first entry, and its request is held.
    await reopen(lib, 16 * MIN);
    await held.atGate;
    const first = bySource(await queue(lib.pid), lib.sources[0]!);
    const r = await lookUpAgain(lib.pid, first.id);
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ outcome: { kind: "under-way" }, entry: first });
    expect(sent).toEqual([]);
    held.release();
    await svc!.state.idle();
    // Only the pass's own requests: one per entry; nothing of the researcher's press was sent or audited.
    expect(sent).toEqual([1, 2].map((i) => `api.openalex.org ${titleOf(i)} Souza`));
    expect((await lookUpAudit(lib.pid)).filter((a) => a.by === "researcher")).toEqual([]);
  });

  it("point 5: the pass skips an entry whose look-up is under way without counting it, and goes on to the next", { timeout: 20_000 }, async () => {
    await start();
    const lib = await libraryWithWaiting(2);
    answer = () => NO_RESULTS;
    // Opened before the first wait has passed (the opening's pass takes nothing), then the time comes.
    await reopen(lib, MIN);
    await svc!.state.idle();
    clock += 16 * MIN;
    const s = svc!.state.session!;
    const [a] = (await storedEntries(lib.pid)).filter((e) => e.sourceId === lib.sources[0]);
    const held = holdFirstRequest();
    // A look-up of the first entry under way on the same library handle (its request held).
    const other = engineLookUpAgain(s.repo, s.http, lib.pid, a!.id, { by: "automatic", closing: s.closing.signal, now: new Date(clock) });
    await held.atGate;
    expect(await svc!.state.runLookUpAgain()).toBe(1);
    expect(sent).toEqual([`api.openalex.org ${titleOf(2)} Souza`]);
    held.release();
    expect(await other).toMatchObject({ done: true, sent: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe("fix round (R600)", () => {
  it("I1 (probe A1): a service's hold is carried over a reopening — 0 requests; the queue lists the held entry as not ready, with the hold's time; a press says \"not yet\" and sends nothing", async () => {
    await start();
    const lib = await libraryWithWaiting(3);
    answer = () => WAIT_HOUR;
    await reopen(lib, 16 * MIN);
    await svc!.state.idle();
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    // A minute later, a fresh client: the time OpenAlex named (an hour) is kept on entry 1 only.
    await reopen(lib, MIN);
    await svc!.state.idle();
    expect(sent).toHaveLength(1);
    const items = await queue(lib.pid);
    const held = bySource(items, lib.sources[0]!).lookUp.notBefore as string;
    expect(Date.parse(held)).toBeGreaterThan(clock);
    const third = bySource(items, lib.sources[2]!);
    expect(third.lookUp).toEqual({ state: "waiting", tries: 0, canLookUpNow: false, notBefore: held });
    const r = await lookUpAgain(lib.pid, third.id);
    expect([r.status, r.json.outcome]).toEqual([200, { kind: "not-yet", notBefore: held }]);
    expect(sent).toHaveLength(1);
    // An attach of a new file now leaves OpenAlex out (decision 31 b): nothing is sent.
    const att = await call({ method: "POST", url: `/projects/${lib.pid}/attach`, body: { paths: [await pdf("new.pdf", buildPdf({ title: "Salt marsh survey", author: "Ana Souza", lines: ["Salt marsh survey."] }))] } });
    expect(att.status, att.body).toBe(200);
    expect(att.json.items[0]).toMatchObject({ outcome: "needs-review", reason: LOOKUP_WAITING_TEXT });
    expect(sent).toHaveLength(1);
  });

  it("I1: the same across a lock and an unlock of an encrypted project — the unlock carries the hold before its pass", async () => {
    await start();
    const lib = await libraryWithWaiting(3, { encrypted: true });
    answer = () => WAIT_HOUR;
    await reopen(lib, 16 * MIN);
    expect((await call({ method: "POST", url: `/projects/${lib.pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc!.state.idle();
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    // Reopened a minute later: the project is locked (nothing of it is read), then unlocked.
    await reopen(lib, MIN);
    await svc!.state.idle();
    expect((await call({ method: "POST", url: `/projects/${lib.pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc!.state.idle();
    expect(sent).toHaveLength(1);
    const third = bySource(await queue(lib.pid), lib.sources[2]!);
    expect(third.lookUp).toMatchObject({ canLookUpNow: false, notBefore: expect.any(String) });
  });

  it("I2 (probe A3): a project locked while its look-up's request is in the air keeps no sensitive answer in memory", { timeout: 30_000 }, async () => {
    await start();
    const lib = await libraryWithWaiting(2, { encrypted: true });
    answer = () => NO_RESULTS;
    await reopen(lib, 16 * MIN);
    const held = holdFirstRequest();
    expect((await call({ method: "POST", url: `/projects/${lib.pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await held.atGate;
    expect((await call({ method: "POST", url: `/projects/${lib.pid}/lock` })).status).toBe(200);
    held.release();
    await svc!.state.idle();
    expect(sent).toEqual([`api.openalex.org ${titleOf(1)} Souza`]);
    const memory = (svc!.state.session!.http as unknown as { memory: Map<string, { sensitive: boolean }> }).memory;
    expect([...memory.values()].filter((e) => e.sensitive)).toHaveLength(0);
  });
});
