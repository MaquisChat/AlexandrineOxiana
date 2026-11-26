/**
 * FR-768 with FR-753 (2) (R641 A2): the client's pacing per host. A queued turn whose caller has stopped, or a call left
 * out at the last check before sending, gives its slot back: it does not sleep and does not move the host's next slot,
 * so the caller behind it waits no extra gap. Pacing itself is never skipped: two live callers still see the full gap.
 *
 * The clock is the test's own: a sleep moves it on by what was asked. Nothing reaches the network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { HttpClient, LookupLeftOutError } from "./http.js";

const HOST = "slow.example";
const ORIGIN = `https://${HOST}`;
/** One request every 3 s at this host. */
const GAP = 3000;
const T0 = Date.parse("2026-11-25T10:00:00.000Z");

let tmp: string;
let agent: MockAgent;
let now: number;
/** Each request as it leaves (`onSend`, just before it is handed to the network): its name and the clock then. */
let sent: Array<{ path: string; at: number }>;
/** Each request that reached the dispatcher (the network). */
let dispatched: string[];

/** Records what reaches the dispatcher. */
class Counting extends Dispatcher {
  constructor(private readonly inner: Dispatcher) {
    super();
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    dispatched.push(String(opts.path));
    return this.inner.dispatch(opts, handler);
  }
  override close(): Promise<void> {
    return this.inner.close();
  }
  override destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-http-pacing-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(ORIGIN)
    .intercept({ path: (p: string) => p.startsWith("/w/"), method: "GET" })
    .reply(200, "{}", { headers: { "content-type": "application/json" } })
    .persist();
  now = T0;
  sent = [];
  dispatched = [];
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

/** A sleep that moves the test clock on at once; `onSleep` sees each wait first. */
const instantSleep = (waits: number[], onSleep?: (ms: number) => void) => async (ms: number) => {
  waits.push(ms);
  onSleep?.(ms);
  now += ms;
};

/**
 * A sleep held until the test releases it (the clock moves on then); once released, every later sleep moves the clock
 * on at once. Released at the test's end whatever its end.
 */
function heldSleep(waits: number[]): { sleep: (ms: number) => Promise<void>; started: Promise<void>; release: () => void } {
  const pending: Array<() => void> = [];
  let released = false;
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const release = () => {
    released = true;
    for (const r of pending.splice(0)) r();
  };
  onTestFinished(release);
  return {
    started,
    release,
    sleep: (ms) =>
      new Promise<void>((r) => {
        waits.push(ms);
        const go = () => {
          now += ms;
          r();
        };
        if (released) go();
        else pending.push(go);
        began();
      }),
  };
}

const client = (sleep: (ms: number) => Promise<void>) =>
  new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: new Counting(agent), clock: () => now, sleep, rateLimits: { [HOST]: 1000 / GAP }, env: {} });

const get = (http: HttpClient, name: string, extra: { signal?: AbortSignal; askedToWait?: "leave-out" } = {}) =>
  http.getJson(`${ORIGIN}/w/${name}`, { cacheKey: name, sensitive: true, onSend: () => sent.push({ path: `/w/${name}`, at: now }), ...extra });

describe("FR-768, FR-753 (2): a slot not used is given back; pacing is never skipped", () => {
  it("two live callers: the second is sent a full gap after the first (pacing holds)", async () => {
    const waits: number[] = [];
    const http = client(instantSleep(waits));
    await Promise.all([get(http, "a"), get(http, "c")]);
    expect(sent.map((x) => x.path)).toEqual(["/w/a", "/w/c"]);
    expect(sent[1]!.at).toBe(T0 + GAP);
    expect(dispatched).toEqual(["/w/a", "/w/c"]);
    expect(waits).toEqual([GAP]);
  });

  it("a queued caller that stopped before its turn neither sleeps nor moves the slot: the next waits one gap, not two", async () => {
    const waits: number[] = [];
    const http = client(instantSleep(waits));
    await get(http, "a"); // sent now; the next slot is one gap away
    const stop = new AbortController();
    const b = get(http, "b", { signal: stop.signal });
    b.catch(() => {});
    stop.abort(new Error("the run was stopped"));
    const c = get(http, "c");
    await expect(b).rejects.toThrow("the run was stopped");
    await c;
    expect(sent).toEqual([
      { path: "/w/a", at: T0 },
      { path: "/w/c", at: T0 + GAP },
    ]);
    expect(dispatched).toEqual(["/w/a", "/w/c"]);
    expect(waits).toEqual([GAP]);
  });

  it("a caller that stops while its turn waits for the slot gives the slot back: the next is sent at that slot", async () => {
    const waits: number[] = [];
    const s = heldSleep(waits);
    const http = client(s.sleep);
    await get(http, "a");
    const stop = new AbortController();
    const b = get(http, "b", { signal: stop.signal });
    b.catch(() => {});
    await s.started; // b's turn waits for the slot one gap away
    const c = get(http, "c");
    stop.abort(new Error("locked"));
    await expect(b).rejects.toThrow("locked");
    s.release(); // b's wait ends: the clock is at the slot
    await c;
    expect(sent).toEqual([
      { path: "/w/a", at: T0 },
      { path: "/w/c", at: T0 + GAP },
    ]);
    expect(dispatched).toEqual(["/w/a", "/w/c"]);
    expect(waits).toEqual([GAP]);
  });

  it("a call left out at the last check before sending gives its slot back: the next is sent at that slot", async () => {
    const waits: number[] = [];
    let http!: HttpClient;
    // While the left-out caller waits for its slot, another call learns the host asked to wait (its hold is set).
    http = client(instantSleep(waits, () => http.holdUntil(HOST, now + 60_000)));
    await get(http, "a");
    const left = get(http, "l", { askedToWait: "leave-out" });
    left.catch(() => {});
    const c = get(http, "c"); // a caller that waits neither looks at nor waits for a hold (R563 I2)
    await expect(left).rejects.toBeInstanceOf(LookupLeftOutError);
    await c;
    expect(sent).toEqual([
      { path: "/w/a", at: T0 },
      { path: "/w/c", at: T0 + GAP },
    ]);
    expect(dispatched).toEqual(["/w/a", "/w/c"]);
    expect(waits).toEqual([GAP]);
  });
});
