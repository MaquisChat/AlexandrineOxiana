/**
 * FR-765: a caller's stop (`GetOptions.signal`: a Find run stopped by "Stop", a project's lock, a library move or a
 * close) ends its lookup at once — a Retry-After wait, a back-off, a request in the air — and nothing more is handed to
 * the network for it: no retry, no redirect hop, no request. Other calls on the same client are not touched; what a
 * service told the client (a host's hold) stays; an aborted call caches nothing.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Dispatcher, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { HttpClient } from "./http.js";

const NOW = Date.parse("2026-11-25T10:00:00.000Z");
let tmp: string;
let agent: MockAgent;
let net: Counting;

/** Every request handed to the network (the dispatcher), whether its signal was already aborted then; some held. */
class Counting extends Dispatcher {
  readonly sent: Array<{ path: string; aborted: boolean }> = [];
  private readonly holds = new Map<string, Promise<void>>();
  constructor(private readonly inner: Dispatcher) {
    super();
  }
  /** Holds the requests for `path` (an answer in the air) until the returned function is called. */
  hold(path: string): () => void {
    let release!: () => void;
    this.holds.set(path, new Promise<void>((r) => (release = r)));
    return () => {
      this.holds.delete(path);
      release();
    };
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const signal = (opts as { signal?: AbortSignal }).signal;
    this.sent.push({ path: String(opts.path), aborted: !!signal?.aborted });
    const gate = this.holds.get(String(opts.path));
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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-http-caller-stop-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  net = new Counting(agent);
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

const client = (extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
  new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: net, clock: () => NOW, env: {}, ...extra });

/** A sleep the test ends: every wait is released by `releaseAll` (the test's end releases what is left). */
function heldSleeps(): { sleep: (ms: number) => Promise<void>; waits: number[]; releaseAll: () => void } {
  const waits: number[] = [];
  const pending: Array<() => void> = [];
  const releaseAll = () => {
    for (const r of pending.splice(0)) r();
  };
  onTestFinished(releaseAll);
  return {
    waits,
    releaseAll,
    sleep: (ms) =>
      new Promise<void>((r) => {
        waits.push(ms);
        pending.push(r);
      }),
  };
}

const OA = "https://api.openalex.org";
const json = (body: unknown) => ({ statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } });
/** Whether `p` has settled once every queued microtask has run (one macrotask turn): a wait cut at once has. */
async function settledNow(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setImmediate(r));
  return done;
}

describe("FR-765: a caller's stop ends its lookup, and nothing more is sent for it", () => {
  it("a Retry-After wait ends at once, no retry is sent, the host's hold stays, and the stop's reason is what the call rejects with", async () => {
    agent.get(OA).intercept({ path: "/works?search=tide", method: "GET" }).reply(429, "slow down", { headers: { "retry-after": "60" } }).times(1);
    agent.get(OA).intercept({ path: "/works?search=tide", method: "GET" }).reply(() => json({ results: [] })).persist();
    const s = heldSleeps();
    const http = client({ sleep: s.sleep });
    const ac = new AbortController();
    const call = http.getJson(`${OA}/works?search=tide`, { cacheKey: "tide", signal: ac.signal });
    call.catch(() => {});
    while (!s.waits.length) await new Promise((r) => setImmediate(r));
    expect(s.waits).toEqual([60_000]);
    const reason = new Error("the run was stopped");
    ac.abort(reason);
    expect(await settledNow(call)).toBe(true);
    await expect(call).rejects.toBe(reason);
    s.releaseAll();
    await new Promise((r) => setImmediate(r));
    expect(net.sent.map((x) => x.path)).toEqual(["/works?search=tide"]);
    // What the service said is kept: the host is held for the minute it asked.
    expect(http.heldUntil("api.openalex.org")).toBe(NOW + 60_000);
  });

  it("a back-off wait after a server error ends at once and no retry is sent", async () => {
    agent.get(OA).intercept({ path: "/works?search=ebb", method: "GET" }).reply(503, "unavailable").times(1);
    agent.get(OA).intercept({ path: "/works?search=ebb", method: "GET" }).reply(() => json({ results: [] })).persist();
    const s = heldSleeps();
    const http = client({ sleep: s.sleep });
    const ac = new AbortController();
    const call = http.getJson(`${OA}/works?search=ebb`, { cacheKey: "ebb", signal: ac.signal });
    call.catch(() => {});
    while (!s.waits.length) await new Promise((r) => setImmediate(r));
    ac.abort(new Error("locked"));
    expect(await settledNow(call)).toBe(true);
    s.releaseAll();
    await expect(call).rejects.toThrow("locked");
    expect(net.sent).toHaveLength(1);
  });

  it("a request in the air is abandoned and not sent again", async () => {
    let arrived!: () => void;
    const inAir = new Promise<void>((r) => (arrived = r));
    let requests = 0;
    const server: Server = createServer(() => {
      requests++;
      arrived(); // never answered
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const real = new Agent();
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await real.close();
    });
    const { port } = server.address() as AddressInfo;
    // Were the stop not heard, the attempt's own limit would end it after 2 s and the retry would reach the server.
    const http = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: real, env: {}, sleep: async () => {}, maxRetries: 1, attemptTimeoutMs: 2_000, timeoutMs: 2_000 });
    const ac = new AbortController();
    const call = http.getJson(`http://127.0.0.1:${port}/works?search=tide`, { cacheKey: "air", signal: ac.signal });
    call.catch(() => {});
    await inAir;
    const reason = new Error("the project was locked");
    ac.abort(reason);
    await expect(call).rejects.toBe(reason);
    expect(requests).toBe(1);
  });

  it("a redirect hop is not followed once the caller has stopped (stopped while the hop waits for its slot)", async () => {
    agent.get(OA).intercept({ path: "/works?search=moved", method: "GET" }).reply(302, "", { headers: { location: "/works?search=moved-on" } }).persist();
    agent.get(OA).intercept({ path: "/works?search=moved-on", method: "GET" }).reply(() => json({ results: [] })).persist();
    const ac = new AbortController();
    // OpenAlex takes five requests a second: the hop waits 200 ms for its slot, and the run is stopped in that wait.
    const http = client({
      sleep: async () => {
        ac.abort(new Error("stopped"));
      },
    });
    await expect(http.getJson(`${OA}/works?search=moved`, { cacheKey: "moved", signal: ac.signal })).rejects.toThrow("stopped");
    expect(net.sent.map((x) => x.path)).toEqual(["/works?search=moved"]);
  });

  it("a call whose stop came first asks nothing", async () => {
    agent.get(OA).intercept({ path: "/works?search=late", method: "GET" }).reply(() => json({ results: [] })).persist();
    const http = client({ sleep: async () => {} });
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    await expect(http.getJson(`${OA}/works?search=late`, { cacheKey: "late", signal: ac.signal })).rejects.toThrow("stopped");
    expect(net.sent).toEqual([]);
  });

  it("an answer that lands after the stop is not cached: the next call asks again", async () => {
    agent.get(OA).intercept({ path: "/works?search=kept", method: "GET" }).reply(() => json({ results: [{ id: "W1" }] })).persist();
    const http = client({ sleep: async () => {} });
    const release = net.hold("/works?search=kept");
    const ac = new AbortController();
    const call = http.getJson(`${OA}/works?search=kept`, { cacheKey: "kept", sensitive: false, signal: ac.signal });
    call.catch(() => {});
    while (!net.sent.length) await new Promise((r) => setImmediate(r));
    ac.abort(new Error("stopped"));
    release();
    await expect(call).rejects.toThrow("stopped");
    expect(await http.getJson(`${OA}/works?search=kept`, { cacheKey: "kept", sensitive: false })).toEqual({ results: [{ id: "W1" }] });
    expect(net.sent.map((x) => x.path)).toEqual(["/works?search=kept", "/works?search=kept"]);
  });

  it("another caller's lookup on the same client, in the air at the same time, completes untouched", async () => {
    agent.get(OA).intercept({ path: "/works?search=mine", method: "GET" }).reply(503, "unavailable").persist();
    agent.get("https://api.crossref.org").intercept({ path: "/works?query=theirs", method: "GET" }).reply(() => json({ message: { items: [] } })).persist();
    const s = heldSleeps();
    const http = client({ sleep: s.sleep });
    const release = net.hold("/works?query=theirs");
    const theirs = http.getJson("https://api.crossref.org/works?query=theirs", { cacheKey: "theirs", signal: new AbortController().signal });
    const ac = new AbortController();
    const mine = http.getJson(`${OA}/works?search=mine`, { cacheKey: "mine", signal: ac.signal });
    mine.catch(() => {});
    while (!s.waits.length || net.sent.length < 2) await new Promise((r) => setImmediate(r));
    ac.abort(new Error("stopped"));
    await expect(mine).rejects.toThrow("stopped");
    release();
    expect(await theirs).toEqual({ message: { items: [] } });
    expect(net.sent.map((x) => x.path).sort()).toEqual(["/works?query=theirs", "/works?search=mine"]);
  });
});

/** Runs `fn` after `n` turns of the microtask queue (to land a stop at every point of a call's waits in turn). */
async function afterTurns(n: number, fn: () => void): Promise<void> {
  for (let i = 0; i < n; i++) await null;
  fn();
}

// FR-764: the stop is looked at right before the request itself. undici hands a request whose signal is already aborted
// to the dispatcher all the same (and the dispatcher then opens a connection to the host), so a stop that lands in the
// last turns before the request — after the waits were looked at — must still keep it from the network. Each case lands
// the stop at every turn from the call's start, one call each, and no request may reach the dispatcher once stopped.
describe("FR-764: a stop that lands just before the request keeps it from the network", () => {
  const TURNS = 80;

  it("a GET: the client's stop (a close)", async () => {
    agent.get(OA).intercept({ path: (p) => p.startsWith("/works"), method: "GET" }).reply(() => json({ results: [] })).persist();
    for (let n = 0; n < TURNS; n++) {
      const http = client({ sleep: async () => {} });
      const call = http.getJson(`${OA}/works?search=t${n}`, { cacheKey: `t${n}` }).catch(() => undefined);
      await afterTurns(n, () => http.stop());
      await call;
    }
    expect(net.sent.filter((x) => x.aborted)).toEqual([]);
  });

  it("a GET: the caller's stop", async () => {
    agent.get(OA).intercept({ path: (p) => p.startsWith("/works"), method: "GET" }).reply(() => json({ results: [] })).persist();
    for (let n = 0; n < TURNS; n++) {
      const http = client({ sleep: async () => {} });
      const ac = new AbortController();
      const call = http.getJson(`${OA}/works?search=c${n}`, { cacheKey: `c${n}`, signal: ac.signal }).catch(() => undefined);
      await afterTurns(n, () => ac.abort(new Error("stopped")));
      await call;
    }
    expect(net.sent.filter((x) => x.aborted)).toEqual([]);
  });

  for (const how of ["the client's stop", "the caller's stop"] as const) {
    it(`a POST (Find's search through Elicit): ${how}`, async () => {
      agent.get("https://elicit.com").intercept({ path: "/api/v1/search", method: "POST" }).reply(() => json({ papers: [] })).persist();
      for (let n = 0; n < TURNS; n++) {
        const http = client({ sleep: async () => {} });
        const ac = new AbortController();
        const call = http.postJson("https://elicit.com/api/v1/search", { q: "tide" }, { signal: ac.signal }).catch(() => undefined);
        await afterTurns(n, () => (how === "the client's stop" ? http.stop() : ac.abort(new Error("stopped"))));
        await call;
      }
      expect(net.sent.filter((x) => x.aborted)).toEqual([]);
    });
  }
});
