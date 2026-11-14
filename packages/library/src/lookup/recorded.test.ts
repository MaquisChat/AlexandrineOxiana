/**
 * The lookup-fixtures switch (R47, R130): AO_LOOKUP_FIXTURES names a folder of recorded answers that
 * the HTTP client replays instead of asking the metadata services, honoured only under
 * NODE_ENV=test, and failing closed: a lookup with no recorded answer is an error, never a request.
 */
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GOVERNANCE } from "@ao/core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MockAgent, request } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, LookupHttpError } from "./http.js";
import { lookupDoi } from "./index.js";
import { LOOKUP_FIXTURES_ENV, RecordedFiles, recordedFileAgent, recordedLookupsFromEnv } from "./recorded.js";

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

  it("the files map (Task F14, R317): a file answer or a redirect is accepted; anything else fails closed at start", async () => {
    const at = (files: unknown) => writeFile(join(tmp, "answers.json"), JSON.stringify({ v: 1, answers: {}, files }));
    await writeFile(join(tmp, "f-handbuilt.pdf"), "%PDF-1.4\n");
    await at({ "https://arxiv.org/pdf/1": { status: 200, file: "f-handbuilt.pdf", headers: { "content-type": "application/pdf" } }, "https://arxiv.org/r": { status: 302, location: "/pdf/1" } });
    const ok = recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp });
    expect(ok?.files).toBeDefined();
    // A file answer is no lookup answer: the lookup at that address still has none.
    expect(() => ok!.answer("https://arxiv.org/pdf/1")).toThrow(LookupHttpError);
    const bad: Array<[unknown, RegExp]> = [
      [[], /files/],
      [{ "https://arxiv.org/pdf/1": { status: 200, file: "../f-handbuilt.pdf" } }, /file name/],
      [{ "https://arxiv.org/pdf/1": { status: 200, file: "missing.pdf" } }, /missing\.pdf/],
      [{ "https://arxiv.org/pdf/1": { status: 302 } }, /location/],
      [{ "https://arxiv.org/pdf/1": { status: 302, location: 7 } }, /location/],
      [{ "https://arxiv.org/pdf/1": { status: 404 } }, /status/],
      [{ "https://arxiv.org/pdf/1": { status: 200, file: "f-handbuilt.pdf", headers: { "content-type": 1 } } }, /headers/],
      [{ "https://arxiv.org/pdf/1": { status: 200, file: "f-handbuilt.pdf", headers: { "bad name": "x" } } }, /headers/],
      [{ "not an address": { status: 200, file: "f-handbuilt.pdf" } }, /address/],
    ];
    for (const [files, re] of bad) {
      await at(files);
      expect(() => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })).toThrow(re);
    }
  });

  it("an answers file without a files map still loads, and records no file", async () => {
    await writeFile(join(tmp, "answers.json"), JSON.stringify({ v: 1, answers: { [CR_URL]: { status: 404 } } }));
    expect(recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: tmp })?.files).toBeDefined();
  });

  // Task F14, R332 a (the review's M1, M2, M3): what an answer may name, and who may make the recorded file answers.
  describe("an answer names only a plain regular file of the folder, never through a link (R332 a)", () => {
    const fixtures = () => join(tmp, "fx");
    const load = () => recordedLookupsFromEnv({ NODE_ENV: "test", [LOOKUP_FIXTURES_ENV]: fixtures() });
    const lookupNaming = (file: string) => writeFile(join(fixtures(), "answers.json"), JSON.stringify({ v: 1, answers: { [CR_URL]: { status: 200, file } } }));
    const downloadNaming = (file: string) => writeFile(join(fixtures(), "answers.json"), JSON.stringify({ v: 1, answers: {}, files: { "https://arxiv.org/pdf/1": { status: 200, file } } }));
    beforeEach(async () => {
      await mkdir(fixtures());
      await writeFile(join(tmp, "outside-secret.json"), JSON.stringify({ message: { DOI, title: ["Outside the folder"] } }));
      await symlink(join(tmp, "outside-secret.json"), join(fixtures(), "link-handbuilt.json"));
      await mkdir(join(fixtures(), "sub-handbuilt"));
      await writeFile(join(fixtures(), "plain-handbuilt.json"), JSON.stringify({ message: { DOI, title: ["In the folder"] } }));
    });

    it("an empty name is refused at load, for a lookup's answer and for a file answer", async () => {
      await lookupNaming("");
      expect(load).toThrow(/file name/);
      await downloadNaming("");
      expect(load).toThrow(/file name/);
    });

    it("a folder's name is refused at load, for a lookup's answer and for a file answer", async () => {
      await lookupNaming("sub-handbuilt");
      expect(load).toThrow(/not a plain file/);
      await downloadNaming("sub-handbuilt");
      expect(load).toThrow(/not a plain file/);
    });

    it("a symbolic link is refused at load, for a lookup's answer and for a file answer", async () => {
      await lookupNaming("link-handbuilt.json");
      expect(load).toThrow(/not a plain file/);
      await downloadNaming("link-handbuilt.json");
      expect(load).toThrow(/not a plain file/);
    });

    it("a plain file that becomes a link after the load is not followed when the answer is read", async () => {
      await lookupNaming("plain-handbuilt.json");
      const rec = load()!;
      expect(rec.answer(CR_URL).body).toContain("In the folder");
      await unlink(join(fixtures(), "plain-handbuilt.json"));
      await symlink(join(tmp, "outside-secret.json"), join(fixtures(), "plain-handbuilt.json"));
      expect(() => rec.answer(CR_URL)).toThrow();
      let body: string | null | undefined;
      try {
        body = rec.answer(CR_URL).body;
      } catch {
        body = undefined;
      }
      expect(body).toBeUndefined();
    });

    it("the recorded file answers are made only by the loader: other code cannot construct them with its own folder and map", () => {
      const make = RecordedFiles as unknown as new (...args: unknown[]) => RecordedFiles;
      expect(() => new make(tmp, { "https://arxiv.org/pdf/1": { status: 200, file: "outside-secret.json" } })).toThrow(TypeError);
      expect(() => new make(Symbol("made"), tmp, { "https://arxiv.org/pdf/1": { status: 200, file: "outside-secret.json" } })).toThrow(TypeError);
    });
  });

  // Task F14, R332 b (the review's M4): "no request leaves" rests on two safeguards of the recorded file answers'
  // dispatcher — its catch-all answer for any address without one, and its refusal of outside connections. Each is
  // pinned alone, the other taken away through `recordedFileAgent`'s seam: a local server stands for the network and
  // counts every connection made to it (127.0.0.1 only; nothing leaves the machine).
  describe("the recorded file answers' dispatcher lets no request leave, by each of its two safeguards alone (R332 b)", () => {
    let server: Server;
    let connections: number;
    let base: string;
    beforeEach(async () => {
      connections = 0;
      server = createServer((_req, res) => res.end("from the network"));
      server.on("connection", () => void connections++);
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    });
    const ask = async (safeguards: Parameters<typeof recordedFileAgent>[2]) => {
      const agent = recordedFileAgent(tmp, {}, safeguards);
      try {
        const r = await request(`${base}/not-recorded.pdf`, { dispatcher: agent });
        await r.body.dump();
        return r.statusCode;
      } catch (e) {
        return e instanceof Error ? e.name : "error";
      } finally {
        await agent.close();
      }
    };

    it("with both (as made): an address without an answer is a 404 and nothing is connected", async () => {
      expect(await ask(undefined)).toBe(404);
      expect(connections).toBe(0);
    });

    it("the catch-all alone (outside connections allowed): still a 404, nothing connected", async () => {
      expect(await ask({ catchAll: true, refuseConnections: false })).toBe(404);
      expect(connections).toBe(0);
    });

    it("the refusal alone (no catch-all answer): the request fails, nothing connected", async () => {
      const got = await ask({ catchAll: false, refuseConnections: true });
      expect(got).not.toBe(200);
      expect(typeof got).toBe("string");
      expect(connections).toBe(0);
    });

    it("with neither, the request reaches the network (so this test sees a leak)", async () => {
      expect(await ask({ catchAll: false, refuseConnections: false })).toBe(200);
      expect(connections).toBe(1);
    });
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
