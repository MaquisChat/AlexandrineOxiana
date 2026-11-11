/**
 * The lookup-fixtures switch (R47, R130): AO_LOOKUP_FIXTURES names a folder of recorded answers that
 * the HTTP client replays instead of asking the metadata services, honoured only under
 * NODE_ENV=test, and failing closed: a lookup with no recorded answer is an error, never a request.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GOVERNANCE } from "@ao/core";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, LookupHttpError } from "./http.js";
import { lookupDoi } from "./index.js";
import { LOOKUP_FIXTURES_ENV, recordedLookupsFromEnv } from "./recorded.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const DOI = "10.5555/ao.fixture.2021.001";
const CR_URL = `https://api.crossref.org/works/${DOI}`;

let tmp: string;
let agent: MockAgent;
/** Requests that reached the (mock) network. */
let reached: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-recorded-"));
  reached = [];
  agent = new MockAgent();
  agent.disableNetConnect();
  // Anything that reaches the dispatcher is recorded and answered, so a leak is visible, not an error.
  for (const origin of ["https://api.crossref.org", "https://api.openalex.org"]) {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((opts) => {
        reached.push(`${origin}${opts.path}`);
        return { statusCode: 200, data: JSON.stringify({ message: { DOI, title: ["From the network"] } }), responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .persist();
  }
});

afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

const client = (env: NodeJS.ProcessEnv) => new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, env, sleep: async () => {} });
const opts = { cacheKey: "k", sensitive: true } as const;

describe("lookup fixtures switch", () => {
  it("is ignored outside test mode", async () => {
    expect(recordedLookupsFromEnv({ [LOOKUP_FIXTURES_ENV]: FIX })).toBeUndefined();
    expect(recordedLookupsFromEnv({ NODE_ENV: "production", [LOOKUP_FIXTURES_ENV]: FIX })).toBeUndefined();
    expect(recordedLookupsFromEnv({ NODE_ENV: "development", VITEST: "true", [LOOKUP_FIXTURES_ENV]: FIX })).toBeUndefined();
    const body = await client({ NODE_ENV: "production", [LOOKUP_FIXTURES_ENV]: FIX }).getJson<{ message: { title: string[] } }>(CR_URL, opts);
    expect(body?.message.title).toEqual(["From the network"]);
    expect(reached).toEqual([CR_URL]);
  });

  it("is off in test mode when the variable is not set", () => {
    expect(recordedLookupsFromEnv({ NODE_ENV: "test" })).toBeUndefined();
  });

  it("replays a recorded answer in test mode without reaching the network", async () => {
    const body = await client({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: FIX }).getJson<{ message: { title: string[] } }>(CR_URL, opts);
    expect(body?.message.title).toEqual(["Rivers and Memory in Upland Villages"]);
    expect(reached).toEqual([]);
  });

  it("a lookup with no recorded answer is an error and never reaches the network", async () => {
    const http = client({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: FIX });
    await expect(http.getJson("https://api.crossref.org/works/10.5555/not-recorded", opts)).rejects.toThrow(LookupHttpError);
    await expect(http.getJson("https://api.crossref.org/works/10.5555/not-recorded", opts)).rejects.toThrow(/no recorded answer/i);
    expect(reached).toEqual([]);
  });

  it("a recorded not-found answer reads as not found", async () => {
    await writeFile(join(tmp, "answers.json"), JSON.stringify({ v: 1, answers: { [CR_URL]: { status: 404 } } }));
    expect(await client({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp }).getJson(CR_URL, opts)).toBeNull();
    expect(reached).toEqual([]);
  });

  it("a folder without a readable answers file fails closed at start", async () => {
    expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })).toThrow(/answers\.json/);
    await writeFile(join(tmp, "answers.json"), "{ not json");
    expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })).toThrow(/answers\.json/);
    expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: "relative/dir" })).toThrow(/absolute/);
  });

  it("an answer file outside the folder is refused", async () => {
    await writeFile(join(tmp, "answers.json"), JSON.stringify({ v: 1, answers: { [CR_URL]: { status: 200, file: "../secret.json" } } }));
    expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })).toThrow(/file name/);
  });

  it("a recorded answer whose file is missing fails at start, not as a raw file error later", async () => {
    await writeFile(join(tmp, "answers.json"), JSON.stringify({ v: 1, answers: { [CR_URL]: { status: 200, file: "missing.json" } } }));
    expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })).toThrow(/missing\.json/);
  });

  it("reads process.env by default: honoured under NODE_ENV=test, ignored otherwise", async () => {
    vi.stubEnv(LOOKUP_FIXTURES_ENV, FIX);
    try {
      vi.stubEnv("NODE_ENV", "production");
      const prod = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, sleep: async () => {} });
      expect((await prod.getJson<{ message: { title: string[] } }>(CR_URL, opts))?.message.title).toEqual(["From the network"]);
      expect(reached).toEqual([CR_URL]);
      vi.stubEnv("NODE_ENV", "test");
      const t = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, sleep: async () => {} });
      expect((await t.getJson<{ message: { title: string[] } }>(CR_URL, opts))?.message.title).toEqual(["Rivers and Memory in Upland Villages"]);
      expect(reached).toEqual([CR_URL]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("drives a real DOI lookup: the title comes from the recorded Crossref answer", async () => {
    const http = client({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: FIX });
    const r = await lookupDoi(DOI, {
      http,
      policy: { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: ["crossref", "openalex"] } },
      projectId: "P1",
      actor: "tester",
      clock: () => new Date("2026-11-10T12:00:00Z"),
      debug: () => {},
      sensitive: false,
    });
    expect(r?.title).toBe("Rivers and Memory in Upland Villages");
    expect(reached).toEqual([]);
  });
});
