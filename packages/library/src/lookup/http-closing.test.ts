/**
 * FR-749 (R546 2): a lookup made for a library session that begins to close is let go at once — the wait for a
 * Retry-After, the back-off wait and a request in the air are cut short (LookupCancelledError) — and nothing is asked
 * again because of it (R411: never sooner than the service allows). A lookup outside such a session is untouched.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { whileOpen, type Library } from "../library.js";
import { HttpClient, LookupCancelledError } from "./http.js";

let tmp: string;
let agent: MockAgent;
/** A sleep that never ends by itself: only the closing can end the wait. */
const forever = () => new Promise<void>(() => {});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-http-closing-"));
  agent = new MockAgent();
  agent.disableNetConnect();
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

/** The library the client serves, as the closing scope knows it (by its folder; R551 M3). */
const libAt = () => ({ root: join(tmp, "Lib") }) as unknown as Library;
const client = (extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) => new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, sleep: forever, ...extra });

/** Intercepts one GET at OpenAlex answering `status`; resolves `asked` when the request arrives. */
function answerOnce(status: number, headers: Record<string, string> = {}): Promise<void> {
  let asked!: () => void;
  const p = new Promise<void>((r) => (asked = r));
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p) => p.startsWith("/works"), method: "GET" })
    .reply(() => {
      asked();
      return { statusCode: status, data: "slow down", responseOptions: { headers } };
    })
    .times(1);
  return p;
}

describe("a lookup of a library session that begins to close (FR-749, R546 2)", () => {
  it("the wait for a Retry-After is cut short, and nothing is asked again", async () => {
    const asked = answerOnce(429, { "retry-after": "60" });
    const closing = new AbortController();
    const http = client();
    const call = whileOpen(libAt(), closing.signal, () => http.getJson("https://api.openalex.org/works?search=tide", { cacheKey: "k1" }));
    const outcome = call.then(
      () => "answered",
      (err: unknown) => err,
    );
    await asked;
    closing.abort();
    expect(await outcome).toBeInstanceOf(LookupCancelledError);
    // The interceptor was used once; a second request would have found none (and the network is shut).
    agent.assertNoPendingInterceptors();
  });

  it("the back-off wait after a server error is cut short", async () => {
    const asked = answerOnce(503);
    const closing = new AbortController();
    const http = client();
    const outcome = whileOpen(libAt(), closing.signal, () => http.getJson("https://api.openalex.org/works?search=tide", { cacheKey: "k2" })).then(
      () => "answered",
      (err: unknown) => err,
    );
    await asked;
    closing.abort();
    expect(await outcome).toBeInstanceOf(LookupCancelledError);
  });

  it("a request in the air is abandoned, not sent again", async () => {
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
    const closing = new AbortController();
    const http = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: real, sleep: forever, attemptTimeoutMs: 600_000, timeoutMs: 600_000 });
    const outcome = whileOpen(libAt(), closing.signal, () => http.getJson(`http://127.0.0.1:${port}/works?search=tide`, { cacheKey: "k3" })).then(
      () => "answered",
      (err: unknown) => err,
    );
    await inAir;
    closing.abort();
    expect(await outcome).toBeInstanceOf(LookupCancelledError);
    expect(requests).toBe(1);
  });

  it("once the session is closing, a new lookup asks nothing", async () => {
    answerOnce(200);
    const closing = new AbortController();
    closing.abort();
    const http = client();
    await expect(whileOpen(libAt(), closing.signal, () => http.getJson("https://api.openalex.org/works?search=tide", { cacheKey: "k4" }))).rejects.toBeInstanceOf(LookupCancelledError);
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it("stop(): requests queued behind the throttle and one in a retry wait all settle at once, and nothing more is sent", async () => {
    let dispatched = 0;
    let firstAsked!: () => void;
    const asked = new Promise<void>((r) => (firstAsked = r));
    agent
      .get("https://api.openalex.org")
      .intercept({ path: (p) => p.startsWith("/works"), method: "GET" })
      .reply(() => {
        dispatched++;
        firstAsked();
        return { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "60" } } };
      })
      .persist();
    // One request a second at OpenAlex; the throttle's wait and the retry wait are sleeps that end only by the stop.
    const http = client({ rateLimits: { "api.openalex.org": 1 } });
    const settle = (q: string) =>
      http.getJson(`https://api.openalex.org/works?search=${q}`, { cacheKey: q }).then(
        () => "answered",
        (err: unknown) => err,
      );
    const inRetryWait = settle("one");
    await asked; // the first is answered 429 and waits to ask again
    const queued = [settle("two"), settle("three"), settle("four")]; // behind the throttle's next slot
    await new Promise((r) => setImmediate(r));
    http.stop();
    for (const outcome of [await inRetryWait, ...(await Promise.all(queued))]) expect(outcome).toBeInstanceOf(LookupCancelledError);
    // A call made after the stop asks nothing either.
    expect(await settle("five")).toBeInstanceOf(LookupCancelledError);
    expect(dispatched).toBe(1);
  });

  it("stop(): a POST (Find's search) asks nothing once the client is stopped", async () => {
    const http = client();
    http.stop();
    await expect(http.postJson("https://elicit.com/api/v1/search", { q: "tide" })).rejects.toBeInstanceOf(LookupCancelledError);
  });

  it("a lookup outside a closing session waits and asks again as before", async () => {
    agent
      .get("https://api.openalex.org")
      .intercept({ path: (p) => p.startsWith("/works"), method: "GET" })
      .reply(429, "slow down", { headers: { "retry-after": "60" } })
      .times(1);
    agent
      .get("https://api.openalex.org")
      .intercept({ path: (p) => p.startsWith("/works"), method: "GET" })
      .reply(200, JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })
      .times(1);
    const sleeps: number[] = [];
    const http = client({ sleep: async (ms) => void sleeps.push(ms) });
    const other = new AbortController();
    other.abort(); // another session's closing has nothing to do with this lookup
    expect(await http.getJson("https://api.openalex.org/works?search=tide", { cacheKey: "k5" })).toEqual({ results: [] });
    expect(sleeps).toContain(60_000);
  });
});
