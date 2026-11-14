/**
 * Task F12 (R290 a, e; plan A2, A5): the shared lookup client's keys and e-mails by host.
 *
 * A key travels in the `Authorization: Bearer` header only, only to its own host (OpenAlex's to `api.openalex.org`,
 * Elicit's to `elicit.com`), never in an address; a request that carries one is never redirected; its answer is
 * cached under a key that holds no header and is served whatever the key; the key is in no error (message, JSON,
 * properties, cause) and no cache file. A contact e-mail goes only into the User-Agent of its own host's requests;
 * the default User-Agent carries none. Nothing here reaches the network (an undici MockAgent with disableNetConnect,
 * composed with a recorder of every request). The key and the e-mail are made up and recognisable.
 */
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient, KEYED_HOSTS, LookupHttpError, USER_AGENT } from "./http.js";

const OA_KEY = "oakey-RECOGNISABLE-7f3a9c";
const ELICIT_KEY = "elk-RECOGNISABLE-55e1b0";
const EMAIL = "test-only@example.invalid";

let tmp: string;
let agent: MockAgent;
let dispatcher: Dispatcher;
let now: number;
let requests: Array<{ origin: string; path: string; method: string; headers: Record<string, string>; body?: string }>;

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

const recorder: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  requests.push({
    origin: new URL(String(opts.origin)).origin,
    path: opts.path,
    method: String(opts.method),
    headers: headersOf(opts.headers),
    ...(typeof opts.body === "string" ? { body: opts.body } : {}),
  });
  return dispatch(opts, handler);
};

function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({
    libraryRoot: join(tmp, "Lib"),
    dispatcher,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    maxRetries: 0,
    env: {},
    ...extra,
  });
}

/** Every key the client could be given, by host (a wrong function would give a key to every host). */
const keyEverywhere = () => OA_KEY;
const keys = (host: string) => (host === "api.openalex.org" ? OA_KEY : undefined);
const JSON_H = { headers: { "content-type": "application/json" } };

/** Every place an error could carry text: its message, its JSON, its properties (own and inherited) and its cause. */
function everythingOf(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) parts.push(cur.message, String(cur.stack ?? ""));
    parts.push(JSON.stringify(cur, Object.getOwnPropertyNames(cur as object)) ?? "", JSON.stringify(cur) ?? "", inspect(cur, { showHidden: true, depth: 5 }));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-http-keys-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  dispatcher = agent.compose(recorder);
  now = 1_000_000;
  requests = [];
});

afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function cacheText(): Promise<string> {
  const dir = join(tmp, "Lib", ".cache", "lookups");
  const files = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
}

describe("a key by the request's host (R290 a)", () => {
  it("only the keyed hosts are ever offered a key: api.openalex.org and elicit.com", () => {
    expect([...KEYED_HOSTS].sort()).toEqual(["api.openalex.org", "elicit.com"]);
  });

  it("OpenAlex's key goes to api.openalex.org in the Authorization header only, never in the address; Crossref gets none even from a function that gives it to every host", async () => {
    agent.get("https://api.openalex.org").intercept({ path: "/works/W1", method: "GET" }).reply(200, JSON.stringify({ id: "W1" }), JSON_H);
    agent.get("https://api.crossref.org").intercept({ path: "/works/10.5555/x", method: "GET" }).reply(200, JSON.stringify({ message: {} }), JSON_H);
    agent.get("https://api.unpaywall.org").intercept({ path: "/v2/10.5555/x", query: { email: EMAIL }, method: "GET" }).reply(200, JSON.stringify({}), JSON_H);
    const http = client({ keyFor: keyEverywhere });
    await http.getJson("https://api.openalex.org/works/W1", { cacheKey: "k:oa", sensitive: false });
    await http.getJson("https://api.crossref.org/works/10.5555/x", { cacheKey: "k:cr", sensitive: false });
    await http.getJson("https://api.unpaywall.org/v2/10.5555/x", { cacheKey: "k:up", sensitive: false, query: { email: EMAIL } });
    expect(requests).toHaveLength(3);
    const oa = requests.find((r) => r.origin === "https://api.openalex.org")!;
    expect(oa.headers.authorization).toBe(`Bearer ${OA_KEY}`);
    for (const r of requests) {
      expect(r.path).not.toContain(OA_KEY);
      if (r.origin !== "https://api.openalex.org") expect(JSON.stringify(r)).not.toContain(OA_KEY);
    }
  });

  it("a host that only looks like OpenAlex's, http, or another port never gets the key", async () => {
    for (const origin of ["https://api.openalex.org.evil.example", "https://openalex.org", "https://xapi.openalex.org"]) {
      agent.get(origin).intercept({ path: "/works/W1", method: "GET" }).reply(200, "{}", JSON_H);
      await client({ keyFor: keyEverywhere }).getJson(`${origin}/works/W1`, { cacheKey: `k:${origin}`, sensitive: false });
    }
    agent.get("http://api.openalex.org").intercept({ path: "/works/W2", method: "GET" }).reply(200, "{}", JSON_H);
    await client({ keyFor: keyEverywhere }).getJson("http://api.openalex.org/works/W2", { cacheKey: "k:http", sensitive: false });
    agent.get("https://api.openalex.org:8443").intercept({ path: "/works/W3", method: "GET" }).reply(200, "{}", JSON_H);
    await client({ keyFor: keyEverywhere }).getJson("https://api.openalex.org:8443/works/W3", { cacheKey: "k:port", sensitive: false });
    expect(requests).toHaveLength(5);
    for (const r of requests) expect(JSON.stringify(r)).not.toContain(OA_KEY);
  });

  it("a keyed request is never redirected: a 302 (the same site included) is refused with the client's error, and the key is not sent again", async () => {
    agent.get("https://api.openalex.org").intercept({ path: "/works/W9", method: "GET" }).reply(302, "", { headers: { location: "https://api.openalex.org/works/W10" } });
    agent.get("https://api.openalex.org").intercept({ path: "/works/W10", method: "GET" }).reply(200, "{}", JSON_H);
    const err = await client({ keyFor: keys }).getJson("https://api.openalex.org/works/W9", { cacheKey: "k:redir", sensitive: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupHttpError);
    expect((err as LookupHttpError).status).toBe(302);
    expect(requests.map((r) => r.path)).toEqual(["/works/W9"]);
    expect(everythingOf(err)).not.toContain(OA_KEY);
    // The same request without a key follows a same-site redirect as before.
    requests = [];
    agent.get("https://api.openalex.org").intercept({ path: "/works/W9", method: "GET" }).reply(302, "", { headers: { location: "https://api.openalex.org/works/W10" } });
    expect(await client().getJson("https://api.openalex.org/works/W9", { cacheKey: "k:redir2", sensitive: false })).toEqual({});
    expect(requests.map((r) => r.path)).toEqual(["/works/W9", "/works/W10"]);
  });

  it("the answer is cached under a key that holds no header, and served from the cache whatever the key; no cache file holds the key", async () => {
    agent.get("https://api.openalex.org").intercept({ path: "/works/W5", method: "GET" }).reply(200, JSON.stringify({ id: "W5" }), JSON_H).times(1);
    expect(await client({ keyFor: keys }).getJson("https://api.openalex.org/works/W5", { cacheKey: "k:w5", sensitive: false })).toEqual({ id: "W5" });
    // Another key, and no key: served from the disk cache, nothing asked.
    expect(await client({ keyFor: () => "another-key-000" }).getJson("https://api.openalex.org/works/W5", { cacheKey: "k:w5", sensitive: false })).toEqual({ id: "W5" });
    expect(await client().getJson("https://api.openalex.org/works/W5", { cacheKey: "k:w5", sensitive: false })).toEqual({ id: "W5" });
    expect(requests).toHaveLength(1);
    const text = await cacheText();
    expect(text).toContain("W5");
    expect(text).not.toContain(OA_KEY);
    expect(text.toLowerCase()).not.toContain("authorization");
  });

  it("an answer that echoes the key is returned but never cached", async () => {
    agent.get("https://api.openalex.org").intercept({ path: "/works/W6", method: "GET" }).reply(200, JSON.stringify({ id: "W6", note: `your key ${OA_KEY}` }), JSON_H).times(2);
    const http = client({ keyFor: keys });
    await http.getJson("https://api.openalex.org/works/W6", { cacheKey: "k:w6", sensitive: false });
    await http.getJson("https://api.openalex.org/works/W6", { cacheKey: "k:w6", sensitive: false });
    expect(requests).toHaveLength(2);
    expect(await cacheText()).not.toContain(OA_KEY);
  });

  it("no thrown error carries the key: a 401, a 429, a 5xx, a refused body and an unreachable host", async () => {
    const oa = agent.get("https://api.openalex.org");
    oa.intercept({ path: "/works/A", method: "GET" }).reply(401, `bad key ${OA_KEY}`);
    oa.intercept({ path: "/works/B", method: "GET" }).reply(429, `slow down ${OA_KEY}`, { headers: { "x-ratelimit-remaining": "0" } });
    oa.intercept({ path: "/works/C", method: "GET" }).reply(503, `down ${OA_KEY}`);
    oa.intercept({ path: "/works/D", method: "GET" }).reply(200, `not json ${OA_KEY}`);
    oa.intercept({ path: "/works/E", method: "GET" }).replyWithError(new Error(`socket said ${OA_KEY}`));
    const http = client({ keyFor: keys });
    for (const p of ["A", "B", "C", "D", "E"]) {
      const err = await http.getJson(`https://api.openalex.org/works/${p}`, { cacheKey: `k:${p}`, sensitive: false, final429: () => true }).catch((e: unknown) => e);
      expect(err, p).toBeInstanceOf(LookupHttpError);
      expect(everythingOf(err), p).not.toContain(OA_KEY);
    }
    expect(await cacheText()).not.toContain(OA_KEY);
  });

  it("a key with a space, a control character or a line break is never sent (it could change the header)", async () => {
    for (const bad of ["two words", "line\r\nX-Evil: 1", "tab\there", ""]) {
      agent.get("https://api.openalex.org").intercept({ path: "/works/W7", method: "GET" }).reply(200, "{}", JSON_H);
      await client({ keyFor: () => bad }).getJson("https://api.openalex.org/works/W7", { cacheKey: `k:${bad}`, sensitive: true });
    }
    for (const r of requests) expect(r.headers.authorization).toBeUndefined();
  });

  it("a key added or changed is used by the next request, without a new client", async () => {
    let current: string | undefined;
    agent.get("https://api.openalex.org").intercept({ path: (p) => p.startsWith("/works/K"), method: "GET" }).reply(200, "{}", JSON_H).persist();
    const http = client({ keyFor: (h) => (h === "api.openalex.org" ? current : undefined) });
    await http.getJson("https://api.openalex.org/works/K1", { cacheKey: "k1", sensitive: true });
    current = OA_KEY;
    await http.getJson("https://api.openalex.org/works/K2", { cacheKey: "k2", sensitive: true });
    current = "second-key-1234";
    await http.getJson("https://api.openalex.org/works/K3", { cacheKey: "k3", sensitive: true });
    expect(requests.map((r) => r.headers.authorization)).toEqual([undefined, `Bearer ${OA_KEY}`, "Bearer second-key-1234"]);
  });

  it("the key's tag is a digest (never the key), empty without a key, and changes with the key", () => {
    let current: string | undefined;
    const http = client({ keyFor: (h) => (h === "api.openalex.org" ? current : undefined) });
    expect(http.keyTag("api.openalex.org")).toBe("");
    current = OA_KEY;
    const a = http.keyTag("api.openalex.org");
    expect(a).toMatch(/^[0-9a-f]{16,64}$/u);
    expect(a).not.toContain(OA_KEY);
    current = "second-key-1234";
    expect(http.keyTag("api.openalex.org")).not.toBe(a);
    expect(http.keyTag("api.crossref.org")).toBe("");
  });
});

describe("postJson (Elicit's search, R290 c)", () => {
  const ELICIT = "https://elicit.com";
  const PATH = "/api/v2/search/papers";

  it("posts the JSON body with the request's own key, bound to its host, and caches nothing", async () => {
    agent.get(ELICIT).intercept({ path: PATH, method: "POST" }).reply(200, JSON.stringify({ papers: [] }), JSON_H).times(2);
    const http = client({ keyFor: keyEverywhere });
    const a = await http.postJson(`${ELICIT}${PATH}`, { query: "Distinction Bourdieu", maxResults: 10 }, { key: { host: "elicit.com", value: ELICIT_KEY } });
    expect(a).toEqual({ status: 200, json: { papers: [] } });
    await http.postJson(`${ELICIT}${PATH}`, { query: "Distinction Bourdieu", maxResults: 10 }, { key: { host: "elicit.com", value: ELICIT_KEY } });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
    expect(requests[0]!.headers["content-type"]).toMatch(/^application\/json/u);
    expect(requests[0]!.body).toBe(JSON.stringify({ query: "Distinction Bourdieu", maxResults: 10 }));
    // The function that would give OpenAlex's key everywhere gave it nowhere here.
    expect(JSON.stringify(requests)).not.toContain(OA_KEY);
    expect(await cacheText()).toBe("");
  });

  it("a key bound to another host is never sent", async () => {
    agent.get(ELICIT).intercept({ path: PATH, method: "POST" }).reply(200, "{}", JSON_H);
    agent.get("https://api.crossref.org").intercept({ path: "/x", method: "POST" }).reply(200, "{}", JSON_H);
    await client().postJson(`${ELICIT}${PATH}`, {}, { key: { host: "api.openalex.org", value: ELICIT_KEY } });
    await client().postJson("https://api.crossref.org/x", {}, { key: { host: "api.crossref.org", value: ELICIT_KEY } });
    for (const r of requests) expect(r.headers.authorization).toBeUndefined();
  });

  it("any redirect is refused and not followed; a refusal answer is a LookupHttpError with its status, never the key", async () => {
    agent.get(ELICIT).intercept({ path: PATH, method: "POST" }).reply(307, "", { headers: { location: `${ELICIT}/elsewhere` } });
    const r = await client().postJson(`${ELICIT}${PATH}`, {}, { key: { host: "elicit.com", value: ELICIT_KEY } }).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(LookupHttpError);
    expect(requests).toHaveLength(1);
    for (const status of [400, 401, 429, 500]) {
      agent.get(ELICIT).intercept({ path: PATH, method: "POST" }).reply(status, `echo ${ELICIT_KEY}`);
      const seen: string[] = [];
      const e = await client().postJson(`${ELICIT}${PATH}`, {}, { key: { host: "elicit.com", value: ELICIT_KEY }, onRefusal: (_s, start) => seen.push(start) }).catch((x: unknown) => x);
      expect(e, String(status)).toBeInstanceOf(LookupHttpError);
      expect((e as LookupHttpError).status).toBe(status);
      expect(everythingOf(e)).not.toContain(ELICIT_KEY);
      expect(seen).toHaveLength(1);
    }
    // A POST is not retried (one request per call).
    expect(requests).toHaveLength(5);
  });

  it("a time limit ends the call, its wait included", async () => {
    agent.get(ELICIT).intercept({ path: PATH, method: "POST" }).reply(200, "{}", JSON_H).delay(2_000);
    const t0 = Date.now();
    const e = await client().postJson(`${ELICIT}${PATH}`, {}, { timeoutMs: 100 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LookupHttpError);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
});

describe("a contact e-mail by host (R290 e)", () => {
  it("the default User-Agent carries no e-mail; Crossref's e-mail goes only into the User-Agent of requests to api.crossref.org", async () => {
    agent.get("https://api.crossref.org").intercept({ path: "/works/10.5555/y", method: "GET" }).reply(200, JSON.stringify({ message: {} }), JSON_H);
    agent.get("https://api.openalex.org").intercept({ path: "/works/W1", method: "GET" }).reply(200, "{}", JSON_H);
    agent.get("https://export.arxiv.org").intercept({ path: "/api/query?x=1", method: "GET" }).reply(200, "<feed/>");
    const http = client({ contactEmailFor: (h) => (h === "api.crossref.org" ? EMAIL : undefined) });
    expect(http.userAgent).toBe(USER_AGENT);
    expect(USER_AGENT).not.toMatch(/mailto|@/u);
    await http.getJson("https://api.crossref.org/works/10.5555/y", { cacheKey: "k:cr", sensitive: false });
    await http.getJson("https://api.openalex.org/works/W1", { cacheKey: "k:oa", sensitive: false });
    await http.getText("https://export.arxiv.org/api/query?x=1", { cacheKey: "k:ax", sensitive: false });
    const cr = requests.find((r) => r.origin === "https://api.crossref.org")!;
    expect(cr.headers["user-agent"]).toBe(`${USER_AGENT.slice(0, -1)}; mailto:${EMAIL})`);
    for (const r of requests) if (r.origin !== "https://api.crossref.org") expect(JSON.stringify(r)).not.toContain(EMAIL);
    expect(await cacheText()).not.toContain(EMAIL);
  });

  it("an e-mail that could inject header text is never sent", async () => {
    agent.get("https://api.crossref.org").intercept({ path: "/works/10.5555/z", method: "GET" }).reply(200, "{}", JSON_H);
    await client({ contactEmailFor: () => "a@b.example\r\nX-Evil: 1" }).getJson("https://api.crossref.org/works/10.5555/z", { cacheKey: "k:z", sensitive: true });
    expect(requests[0]!.headers["user-agent"]).toBe(USER_AGENT);
  });
});
