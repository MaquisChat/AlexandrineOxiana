/**
 * Decision 31 (b), R556 (2) i, ii: a caller that asks the client to leave a service out when it asks to wait
 * (`askedToWait: "leave-out"`: the interactive attach and a watched folder's bringing-in) is not made to wait. A 429, or a
 * 503 with a wait asked, ends the call at once with LookupLeftOutError; the client keeps "not before T" for that host in
 * memory, and until T every such call to that host is left out without anything being sent. A caller without the option
 * is as before: it neither looks at nor waits for a hold (R563 I2). A 503 without a wait asked is today's failure path.
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

/**
 * R563 I2: callers WITHOUT the choice (Bulk Import, Zotero's batches, Find and acquire) are truly unchanged: they neither
 * look at nor wait for a hold, and on their own 429 they do exactly what the client did at db8623b. The reference, measured
 * by driving the db8623b client (`git show db8623b:packages/library/src/lookup/http.ts`) through the same answers on
 * the same injected clock: ONE lookup (one getJson, the first try and 3 retries) sends 4 requests, at 0, 60, 120 and
 * 180 s after it starts, sleeping 60 s three times (180 s in all); with 429/Retry-After 60 three times then 200 it
 * returns the 200's answer; with 429 for ever it fails with "The metadata service answered HTTP 429".
 */
describe("callers without the choice are as at db8623b (decision 31 b, R563 I2)", () => {
  const REF_TIMES = [0, 60_000, 120_000, 180_000];
  const REF_SLEEPS = [60_000, 60_000, 60_000];
  const RA60 = { statusCode: 429, headers: { "retry-after": "60" } };

  /** An attach (with the choice) leaves a one-hour hold on Crossref; then a second passes, so no throttle slot is near. */
  async function holdLeftByAnAttach(http: HttpClient): Promise<void> {
    await expect(http.getJson(`${CR}/works/10.5555/attach`, { ...LEAVE, cacheKey: "attach" })).rejects.toBeInstanceOf(LookupLeftOutError);
    now += 1_000;
    sent = [];
    sleeps = [];
  }

  for (const held of [false, true]) {
    const label = held ? "with a one-hour hold left by an attach" : "with no hold";
    it(`${label}: 429/Retry-After 60 three times, then 200: requests at 0, 60, 120, 180 s, the answer returned`, async () => {
      answering(CR, (n) => (n === 1 && held ? { ...RA60, headers: { "retry-after": "3600" } } : n <= (held ? 4 : 3) ? RA60 : { statusCode: 200, data: fixture("crossref-work.json") }));
      const http = client();
      if (held) await holdLeftByAnAttach(http);
      const start = now;
      await expect(http.getJson(CR_URL, { cacheKey: "bulk" })).resolves.toMatchObject({ message: { DOI } });
      expect(sent.map((s) => s.at - start)).toEqual(REF_TIMES);
      expect(sleeps).toEqual(REF_SLEEPS);
    });

    it(`${label}: 429 for ever: requests at 0, 60, 120, 180 s, then the same failure`, async () => {
      answering(CR, (n) => (n === 1 && held ? { ...RA60, headers: { "retry-after": "3600" } } : RA60));
      const http = client();
      if (held) await holdLeftByAnAttach(http);
      const start = now;
      const err = await http.getJson(CR_URL, { cacheKey: "bulk" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LookupHttpError);
      expect((err as LookupHttpError).message).toBe("The metadata service answered HTTP 429");
      expect(sent.map((s) => s.at - start)).toEqual(REF_TIMES);
      expect(sleeps).toEqual(REF_SLEEPS);
    });
  }

  it("with a one-hour hold left by an attach, a service answering normally: Bulk asks at once, five times, no wait", async () => {
    answering(CR, (n) => (n === 1 ? { ...RA60, headers: { "retry-after": "3600" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const http = client();
    await holdLeftByAnAttach(http);
    for (let i = 1; i <= 5; i++) await http.getJson(`${CR}/works/10.5555/b${i}`, { cacheKey: `b${i}` });
    expect(sent.length).toBe(5);
    expect(sleeps.every((ms) => ms < 1_000)).toBe(true); // only the throttle's 200 ms gap between requests (5 a second)
  });

  it("a 2xx answer clears the host's hold, whoever received it: a call with the choice is then SENT", async () => {
    answering(CR, (n) => (n === 1 ? { ...RA60, headers: { "retry-after": "3600" } } : { statusCode: 200, data: fixture("crossref-work.json") }));
    const http = client();
    await holdLeftByAnAttach(http);
    await expect(http.getJson(`${CR}/works/10.5555/bulk`, { cacheKey: "bulk" })).resolves.toMatchObject({ message: { DOI } });
    now += 1_000;
    await expect(http.getJson(CR_URL, LEAVE)).resolves.toMatchObject({ message: { DOI } });
    expect(sent.length).toBe(2);
  });
});

/**
 * R563 M1: for the HOLD, on a 429 a Retry-After that is absent, unreadable, zero, negative or a date in the past counts
 * as one minute; a usable positive value is honoured, cut to an hour. A 503 sets a hold only when a wait is asked: a
 * zero, negative, unreadable or past value asks for none, so such a 503 takes today's failure path (retried, then a
 * LookupHttpError), with no hold. The waits of callers without the choice are untouched (retryAfterMs is unchanged).
 */
describe("odd Retry-After values (decision 31 b, R563 M1)", () => {
  const PAST = () => new Date(now - 120_000).toUTCString();
  for (const [label, value] of [
    ["unreadable (x 7)", () => "x 7"],
    ["zero", () => "0"],
    ["negative (-5)", () => "-5"],
    ["a date in the past", PAST],
  ] as const) {
    it(`a 429 whose Retry-After is ${label} holds the host for one minute`, async () => {
      answering(CR, () => ({ statusCode: 429, headers: { "retry-after": value() } }));
      const http = client();
      const err = (await http.getJson(CR_URL, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
      expect(err).toBeInstanceOf(LookupLeftOutError);
      expect(err.notBefore).toBe(now + 60_000);
      now += 59_999;
      await expect(http.getJson(`${CR}/works/10.5555/next`, LEAVE)).rejects.toBeInstanceOf(LookupLeftOutError);
      expect(count("api.crossref.org")).toBe(1);
    });

    it(`a 503 whose Retry-After is ${label} asks for no wait: today's failure path, and no hold`, async () => {
      answering(CR, () => ({ statusCode: 503, headers: { "retry-after": value() } }));
      const http = client();
      const err = await http.getJson(CR_URL, LEAVE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LookupHttpError);
      expect(count("api.crossref.org")).toBe(4); // the first try and 3 retries, as at db8623b
      answering(OA, () => ({ statusCode: 404 }));
      await expect(http.getJson(`${OA}/works/doi:${DOI}`, { ...LEAVE, cacheKey: "oa" })).resolves.toBeNull();
      sent = [];
      await expect(http.getJson(`${CR}/works/10.5555/next`, { ...LEAVE, cacheKey: "next" })).rejects.toBeInstanceOf(LookupHttpError);
      expect(count("api.crossref.org")).toBe(4); // asked: nothing held it
    });
  }

  it("a 429 with a usable Retry-After (30) holds for 30 s", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "30" } }));
    const err = (await client().getJson(CR_URL, LEAVE).catch((e: unknown) => e)) as LookupLeftOutError;
    expect(err.notBefore).toBe(now + 30_000);
  });

  it("a caller without the choice still waits what it waited at db8623b for a 429 with Retry-After 0: no wait", async () => {
    answering(CR, () => ({ statusCode: 429, headers: { "retry-after": "0" } }));
    const err = await client().getJson(CR_URL, { cacheKey: "bulk" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupHttpError);
    expect(sleeps).toEqual([0, 200, 0, 200, 0, 200]); // the db8623b client's, measured: a 0 wait, then the throttle's gap
    expect(sent.map((x) => x.at - 1_000_000)).toEqual([0, 200, 400, 600]);
    expect(count("api.crossref.org")).toBe(4);
  });
});
