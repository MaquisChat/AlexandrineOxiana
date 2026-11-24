/**
 * Decision 31 (b), R556 (2) i, ii: a caller that asks the client to leave a service out when it asks to wait
 * (`askedToWait: "leave-out"`: the interactive attach and a watched folder's bringing-in) is not made to wait. A 429, or a
 * 503 with a wait asked, ends the call at once with LookupLeftOutError; the client keeps "not before T" for that host in
 * memory, and until T every such call to that host is left out without anything being sent. A caller without the option
 * waits as before, and never asks that host before T either (R411). A 503 without a wait asked is today's failure path.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GOVERNANCE } from "@ao/core";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient, LookupHttpError, LookupLeftOutError } from "./http.js";
import { lookupDoi, searchTitle, type LookupContext } from "./index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const DOI = "10.5555/ao.fixture.2021.001";
const CR = "https://api.crossref.org";
const OA = "https://api.openalex.org";
const CR_URL = `${CR}/works/${DOI}`;

let tmp: string;
let agent: MockAgent;
let now: number;
let sleeps: number[];
/** When (on the client's clock) each request reached the stand-in. */
let sent: Array<{ host: string; at: number }>;

const sleep = async (ms: number) => {
  sleeps.push(ms);
  now += ms;
};
const client = () => new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, clock: () => now, sleep });

/** Every request to `origin` answers what `answer(n)` says for its n-th request (1-based). */
function answering(origin: string, answer: (n: number) => { statusCode: number; data?: string; headers?: Record<string, string> }): void {
  let n = 0;
  agent
    .get(origin)
    .intercept({ path: () => true, method: "GET" })
    .reply(() => {
      sent.push({ host: new URL(origin).hostname, at: now });
      const a = answer(++n);
      return { statusCode: a.statusCode, data: a.data ?? "", responseOptions: { headers: a.headers ?? {} } };
    })
    .persist();
}
const count = (host: string) => sent.filter((s) => s.host === host).length;
const LEAVE = { cacheKey: "k", sensitive: true, askedToWait: "leave-out" as const };

function ctx(http: HttpClient, extra: Partial<LookupContext> = {}): LookupContext {
  return {
    http,
    policy: { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: ["crossref", "openalex"] } },
    projectId: "P1",
    actor: "tester",
    clock: () => new Date("2026-11-24T12:00:00Z"),
    sensitive: false,
    ...extra,
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-leave-out-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  now = 1_000_000;
  sleeps = [];
  sent = [];
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the client: a service that asks to wait is left out (decision 31 b, R556 2)", () => {
  it("a 429 with Retry-After 60 settles at once as left out: one request, no wait, not before now + 60 s", async () => {
    answering(CR, () => ({ statusCode: 429, data: "slow down", headers: { "retry-after": "60" } }));
    const http = client();
    const err = await http.getJson(CR_URL, LEAVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupLeftOutError);
    expect(err).not.toBeInstanceOf(LookupHttpError); // distinct from "failed"
    expect((err as LookupLeftOutError).host).toBe("api.crossref.org");
    expect((err as LookupLeftOutError).notBefore).toBe(now + 60_000);
    expect(sleeps).toEqual([]);
    expect(count("api.crossref.org")).toBe(1);
  });

  it("before that time the host is left out at once and NOTHING is sent; after it, the host is asked again", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 429, headers: { "retry-after": "60" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const http = client();
    await expect(http.getJson(CR_URL, LEAVE)).rejects.toBeInstanceOf(LookupLeftOutError);
    now += 59_999;
    const again = await http.getJson(`${CR}/works/10.5555/another`, LEAVE).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(LookupLeftOutError);
    expect((again as LookupLeftOutError).notBefore).toBe(1_000_000 + 60_000);
    expect(count("api.crossref.org")).toBe(1);
    now += 1;
    await expect(http.getJson(CR_URL, LEAVE)).resolves.toMatchObject({ message: { DOI } });
    expect(count("api.crossref.org")).toBe(2);
    expect(sleeps).toEqual([]);
  });

  it("a 429 that names no time counts as asking for one minute", async () => {
    answering(CR, () => ({ statusCode: 429 }));
    const err = (await client().getJson(CR_URL, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err).toBeInstanceOf(LookupLeftOutError);
    expect(err.notBefore).toBe(now + 60_000);
    expect(count("api.crossref.org")).toBe(1);
  });

  it("a 503 with a wait asked is left out the same way (seconds or a date)", async () => {
    answering(CR, () => ({ statusCode: 503, headers: { "retry-after": "120" } }));
    answering(OA, () => ({ statusCode: 503, headers: { "retry-after": new Date(now + 300_000).toUTCString() } }));
    const http = client();
    const a = (await http.getJson(CR_URL, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(a).toBeInstanceOf(LookupLeftOutError);
    expect(a.notBefore).toBe(now + 120_000);
    const b = (await http.getJson(`${OA}/works/doi:${DOI}`, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(b).toBeInstanceOf(LookupLeftOutError);
    expect(Math.abs(b.notBefore - (now + 300_000))).toBeLessThan(1000); // an HTTP date has whole seconds
    expect(sent.length).toBe(2);
    expect(sleeps).toEqual([]);
  });

  it("a wait longer than an hour is honoured up to the hour (R411 b)", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "86400" } }));
    const err = (await client().getJson(CR_URL, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err.notBefore).toBe(now + 3_600_000);
  });

  it("a 503 WITHOUT a wait asked is today's failure path: retried with back-off, then a LookupHttpError", async () => {
    answering(CR, () => ({ statusCode: 503 }));
    const http = client();
    const err = await http.getJson(CR_URL, LEAVE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupHttpError);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(count("api.crossref.org")).toBe(4);
    // Nothing is held: the next call asks at once.
    answering(OA, () => ({ statusCode: 404 }));
    await expect(http.getJson(`${OA}/works/doi:${DOI}`, LEAVE)).resolves.toBeNull();
  });

  it("WITHOUT the option a 429 is waited out as today (Retry-After honoured, capped at 60 s) and nothing is left out", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 429, headers: { "retry-after": "2" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const http = client();
    await expect(http.getJson(CR_URL, { cacheKey: "k" })).resolves.toMatchObject({ message: { DOI } });
    expect(sleeps).toEqual([2000]);
    expect(count("api.crossref.org")).toBe(2);
  });

  it("a caller without the option that meets a host's 'not before' waits until then before asking (R411): never sooner", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 429, headers: { "retry-after": "45" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const http = client();
    await expect(http.getJson(CR_URL, LEAVE)).rejects.toBeInstanceOf(LookupLeftOutError);
    const t = now + 45_000;
    now += 5_000;
    await expect(http.getJson(`${CR}/works/10.5555/other`, { cacheKey: "k2" })).resolves.toMatchObject({ message: { DOI } });
    expect(sleeps).toEqual([40_000]);
    expect(sent.map((s) => s.at)).toEqual([1_000_000, t]);
  });

  it("a cut of the client (stop) ends a non-option caller's wait for the hold: nothing is sent", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "60" } }));
    let release!: () => void;
    const http = new HttpClient({
      libraryRoot: join(tmp, "Lib"),
      dispatcher: agent,
      clock: () => now,
      sleep: () => new Promise<void>((r) => (release = r)),
    });
    await expect(http.getJson(CR_URL, LEAVE)).rejects.toBeInstanceOf(LookupLeftOutError);
    const waiting = http.getJson(`${CR}/works/10.5555/other`, { cacheKey: "k2" });
    await new Promise((r) => setImmediate(r));
    http.stop();
    await expect(waiting).rejects.toMatchObject({ name: "LookupCancelledError" });
    release?.();
    expect(count("api.crossref.org")).toBe(1);
  });
});

describe("the providers carry 'left out' (decision 31 b)", () => {
  const LEAVE_CTX = { askedToWait: "leave-out" as const };

  it("Crossref asks to wait, OpenAlex answers: the DOI's record comes from OpenAlex and nothing is left out", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "60" } }));
    answering(OA, () => ({ statusCode: 200, data: fixture("openalex-work.json") }));
    const r = await lookupDoi(DOI, ctx(client(), LEAVE_CTX));
    expect(r?.provider).toBe("openalex");
    expect(sleeps).toEqual([]);
  });

  it("Crossref asks to wait, OpenAlex does not know the DOI: left out, naming Crossref", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "60" } }));
    answering(OA, () => ({ statusCode: 404 }));
    const err = (await lookupDoi(DOI, ctx(client(), LEAVE_CTX)).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err).toBeInstanceOf(LookupLeftOutError);
    expect(err.services).toEqual(["crossref"]);
  });

  it("both ask to wait: left out, naming both, with the later of their times", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "60" } }));
    answering(OA, () => ({ statusCode: 429, headers: { "retry-after": "90" } }));
    const err = (await lookupDoi(DOI, ctx(client(), LEAVE_CTX)).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err.services).toEqual(["crossref", "openalex"]);
    expect(err.notBefore).toBe(now + 90_000);
    expect(sleeps).toEqual([]);
  });

  it("a title search whose service asks to wait is left out, naming OpenAlex", async () => {
    answering(OA, () => ({ statusCode: 429 }));
    const err = (await searchTitle("Notes from the tide-line interviews", undefined, ctx(client(), LEAVE_CTX)).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err).toBeInstanceOf(LookupLeftOutError);
    expect(err.services).toEqual(["openalex"]);
  });

  it("without the option the providers wait as today", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 429, headers: { "retry-after": "3" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const r = await lookupDoi(DOI, ctx(client()));
    expect(r?.provider).toBe("crossref");
    expect(sleeps).toEqual([3000]);
  });
});

/**
 * R563 I1: a call that carries the choice looks at the hold immediately before every send and every retry, and a hold
 * is set by ANY caller's 429 (or 503 with a wait asked). A request already in the air when the service first asks to
 * wait cannot be called back: Crossref takes one request at a time (DEFAULT_CONCURRENCY), so here exactly one request
 * is in the air and every later one waits for its place behind it.
 */
describe("the hold is looked at just before every send and every retry (decision 31 b, R563 I1)", () => {
  it("five calls with the choice started together: after the first 429 nothing more is sent", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "60" } }));
    const http = client();
    const calls = [1, 2, 3, 4, 5].map((i) => http.getJson(`${CR}/works/10.5555/n${i}`, { ...LEAVE, cacheKey: `k${i}` }).catch((e: unknown) => e));
    const errs = await Promise.all(calls);
    for (const e of errs) expect(e).toBeInstanceOf(LookupLeftOutError);
    expect(count("api.crossref.org")).toBe(1);
  });

  it("a call with the choice whose first try got a 500 sends no retry once another call has set a hold", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 500 } : { statusCode: 429, headers: { "retry-after": "60" } }));
    let backoffStarted!: () => void;
    const inBackoff = new Promise<void>((r) => (backoffStarted = r));
    let endBackoff!: () => void;
    const backoffGate = new Promise<void>((r) => (endBackoff = r));
    const http = new HttpClient({
      libraryRoot: join(tmp, "Lib"),
      dispatcher: agent,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === 500) {
          backoffStarted();
          await backoffGate; // the first call's back-off ends only when the test says so
        }
        now += ms;
      },
    });
    const a = http.getJson(`${CR}/works/10.5555/a`, { ...LEAVE, cacheKey: "ka" }).catch((e: unknown) => e);
    await inBackoff;
    const b = await http.getJson(`${CR}/works/10.5555/b`, { ...LEAVE, cacheKey: "kb" }).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(LookupLeftOutError); // the hold: until +60 s
    endBackoff();
    expect(await a).toBeInstanceOf(LookupLeftOutError);
    expect(count("api.crossref.org")).toBe(2); // a's first try and b's: a's retry was not sent
  });

  it("a 429 received by a caller WITHOUT the choice sets the hold: a call with the choice then sends nothing", async () => {
    answering(CR, (n) => (n === 1 ? { statusCode: 429, headers: { "retry-after": "60" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    let waitStarted!: () => void;
    const waiting = new Promise<void>((r) => (waitStarted = r));
    let endWait!: () => void;
    const waitGate = new Promise<void>((r) => (endWait = r));
    const http = new HttpClient({
      libraryRoot: join(tmp, "Lib"),
      dispatcher: agent,
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === 60_000) {
          waitStarted();
          await waitGate; // Bulk sits out its minute until the test says so
        }
        now += ms;
      },
    });
    const bulk = http.getJson(CR_URL, { cacheKey: "bulk" });
    await waiting;
    const attach = await http.getJson(`${CR}/works/10.5555/other`, LEAVE).catch((e: unknown) => e);
    expect(attach).toBeInstanceOf(LookupLeftOutError);
    expect((attach as LookupLeftOutError).notBefore).toBe(1_000_000 + 60_000);
    expect(count("api.crossref.org")).toBe(1);
    endWait();
    await expect(bulk).resolves.toMatchObject({ message: { DOI } }); // Bulk itself is as before: it waited, then asked
    expect(count("api.crossref.org")).toBe(2);
  });
});
