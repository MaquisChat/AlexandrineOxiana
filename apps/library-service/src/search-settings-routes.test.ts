/**
 * "Search sources" in the service (Find and acquire Task F12; Ruling R290): the settings routes, the Elicit and
 * OpenAlex keys, "Test", and the reach of the keys and the e-mails through everything the service asks.
 *
 * The services are made-up answers served as the global dispatcher (a MockAgent with `disableNetConnect`, composed with
 * a recorder of every request): nothing reaches the network. The password store is the library's in-memory stand-in.
 * The keys and e-mail addresses are made up and recognisable; every log line, error answer, event and settings file of
 * this file is searched for them.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_STORE_UNAVAILABLE, deviceDeps, lookupContextFor, lookupDoi, type Deps } from "@ao/library";
import { SEARCH_SETTINGS_TEXT, SEARCH_SOURCE_TEST_TIMEOUT_MS as FIND_SOURCE_TEST_TIMEOUT_MS, SEARCH_TEST_TEXT, searchEmailRefusal, type SearchSourcesResponse } from "@ao/shared";
import { useMemorySecrets, useNoSecretStore } from "../../../packages/library/src/secrets-testing.js";
import { _resetElicitForTests } from "../../../packages/library/src/find/elicit.js";
import { _setSecretBackend } from "../../../packages/library/src/secrets.js";
import { createService, type LibraryService } from "./server.js";
import { SEARCH_KEY_WAIT_MS } from "./state.js";
import type { ServiceEvent } from "./events.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OA_KEY = "oakey-RECOGNISABLE-7f3a9c";
const ELICIT_KEY = "elk-RECOGNISABLE-55e1b0";
const CROSSREF_EMAIL = "crossref-only@example.invalid";
const UNPAYWALL_EMAIL = "test-only@example.invalid";
const GOV = (list = "[crossref, openalex]", extra = "") => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: ${list}
${extra}`;
const ELICIT_GOV = GOV("[crossref, openalex, elicit]", "vendors:\n  - id: elicit\n");
const LINE = "Quillfeather, Zorblatt Grammar of Habitus, 1999";
const ZORBLATT = { DOI: "10.5555/ao.f12.zorblatt", type: "journal-article", title: ["Zorblatt Grammar of Habitus"], author: [{ given: "Ottoline", family: "Quillfeather" }], issued: { "date-parts": [[1999]] } };

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService | undefined;
let events: ServiceEvent[];
let agent: MockAgent;
let previous: Dispatcher;
let secrets: ReturnType<typeof useMemorySecrets>;
let requests: Array<{ origin: string; path: string; method: string; headers: Record<string, string>; body?: string }>;
const errorBodies: string[] = [];
/** Delay (ms) of Crossref's answers (a test held open). */
let crossrefDelay = 0;
/** The status of Elicit's answers (200: nothing found). */
let elicitStatus = 200;

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}
const recorder: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  requests.push({ origin: new URL(String(opts.origin)).origin, path: String(opts.path), method: String(opts.method), headers: headersOf(opts.headers), ...(typeof opts.body === "string" ? { body: opts.body } : {}) });
  return dispatch(opts, handler);
};

function mockServices(): void {
  agent = new MockAgent();
  agent.disableNetConnect();
  const json = (body: unknown) => ({ statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } });
  agent
    .get("https://api.crossref.org")
    .intercept({ path: (p: string) => p.startsWith("/works?"), method: "GET" })
    .reply(async (o) => {
      if (crossrefDelay) await new Promise((r) => setTimeout(r, crossrefDelay));
      return json({ status: "ok", message: { items: String(o.path).includes("Zorblatt") ? [ZORBLATT] : [] } });
    })
    .persist();
  // Task F11 (as in find-routes.test.ts): a record made goes on to look for a free copy; in this made-up world no
  // service has one — a 404 for a work by its DOI and from the other free-copy services.
  agent.get("https://api.openalex.org").intercept({ path: (p: string) => p.startsWith("/works/doi:"), method: "GET" }).reply(() => ({ statusCode: 404, data: "{}" })).persist();
  agent.get("https://api.openalex.org").intercept({ path: () => true, method: "GET" }).reply(() => json({ meta: { count: 0 }, results: [] })).persist();
  agent.get("https://elicit.com").intercept({ path: "/api/v2/search/papers", method: "POST" }).reply(() => (elicitStatus === 200 ? json({ papers: [] }) : { statusCode: elicitStatus, data: "no" })).persist();
  agent.get("https://api.unpaywall.org").intercept({ path: () => true, method: "GET" }).reply(() => json({ is_oa: false })).persist();
  for (const o of ["https://export.arxiv.org", "https://www.ebi.ac.uk", "https://api.semanticscholar.org", "https://directory.doabooks.org", "https://archive.org"]) agent.get(o).intercept({ path: () => true, method: "GET" }).reply(() => ({ statusCode: 404, data: "{}" })).persist();
  previous = getGlobalDispatcher();
  setGlobalDispatcher(agent.compose(recorder));
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-search-sources-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  events = [];
  requests = [];
  crossrefDelay = 0;
  elicitStatus = 200;
  secrets = useMemorySecrets();
  _resetElicitForTests();
  mockServices();
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  secrets.restore();
  // No key and no e-mail in any log line, error answer or event; no key in any settings file.
  const seen = [logs, ...errorBodies, ...events.map((e) => JSON.stringify(e))].join("\n");
  for (const w of [OA_KEY, ELICIT_KEY, CROSSREF_EMAIL, UNPAYWALL_EMAIL]) expect(seen.includes(w), `"${w}" was logged or sent`).toBe(false);
  for (const f of await readdir(deps.appConfigDir).catch(() => [] as string[])) {
    const p = join(deps.appConfigDir, f);
    if ((await stat(p)).isFile()) {
      const text = await readFile(p, "utf8");
      expect(text, f).not.toContain(OA_KEY);
      expect(text, f).not.toContain(ELICIT_KEY);
    }
  }
  errorBodies.length = 0;
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null });
  svc.state.events.subscribe((e) => events.push(e));
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.noAuth ? {} : auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  if (res.statusCode >= 400) errorBodies.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function extensionToken(): Promise<string> {
  const code = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
  return c.json().token as string;
}

/** Every way in that must be refused, for one route. */
async function expectGuarded(r: Inject): Promise<void> {
  expect((await call({ ...r, noAuth: true })).status, "no token").toBe(401);
  expect((await call({ ...r, headers: { ...r.headers, origin: "https://evil.example" } })).status, "foreign origin").toBe(403);
  expect((await call({ ...r, headers: { ...r.headers, host: "evil.example" } })).status, "wrong Host").toBe(403);
  const ext = await extensionToken();
  expect((await call({ ...r, noAuth: true, headers: { ...r.headers, authorization: `Bearer ${ext}`, origin: EXT } })).status, "extension token").toBe(403);
}

async function openLibraryWithProject(gov = GOV()): Promise<string> {
  const r = await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } });
  expect(r.status, r.body).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: gov, encryption: { enabled: false } } });
  expect(p.status, p.body).toBe(200);
  return p.json.project.id as string;
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
const FINAL = ["choose", "already", "maybe-duplicate", "record-complete", "not-found", "failed", "no-open-copy", "in-library", "needs-check"];
/**
 * F11 (as in find-routes.test.ts): a record the queue made goes on by itself to look for a free copy ("record-complete" →
 * "looking-for-copy" → …); this file's made-up services offer none, so such an entry ends "no-open-copy". Each of these
 * says the record is made; an entry is settled once its free copy's part has ended too (nothing of it left running).
 */
const MADE = ["record-complete", "looking-for-copy", "fetching", "no-open-copy"];
async function addAndSettle(pid: string, line: string): Promise<{ state: string; reason?: unknown }> {
  const r = await call({ method: "POST", url: `/projects/${pid}/find`, body: { lines: [line] } });
  expect(r.status, r.body).toBe(200);
  const id = r.json.added[0].id as string;
  return until(async () => {
    const q = await call({ url: `/projects/${pid}/find` });
    const e = q.json.entries.find((x: { id: string }) => x.id === id);
    // F11: "record-complete" with no reason is the moment between the record and the free copy's part: not settled.
    return e && FINAL.includes(e.state) && !(e.state === "record-complete" && !e.reason) ? e : undefined;
  }, "the entry to settle");
}

const ALL_ON = {
  record: [
    { id: "crossref", on: true },
    { id: "openalex", on: true },
    { id: "elicit", on: false },
  ],
  copies: ["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"].map((id) => ({ id, on: id !== "unpaywall" })),
};

// ------------------------------------------------------------------------------------------------
describe("the Elicit and OpenAlex keys (R290 a)", () => {
  it("keys are write-only; the value is never returned or logged", async () => {
    await start();
    for (const [name, key] of [
      ["elicit-api-key", ELICIT_KEY],
      ["openalex-api-key", OA_KEY],
    ] as const) {
      const url = `/secrets/${name}`;
      expect((await call({ url })).json).toEqual({ stored: false });
      const put = await call({ method: "PUT", url, body: { apiKey: key } });
      expect(put.status, put.body).toBe(200);
      expect(put.json).toEqual({ stored: true });
      expect(put.body).not.toContain(key);
      expect(secrets.values.get(name)).toBe(key);
      const got = await call({ url });
      expect(got.json).toEqual({ stored: true });
      expect(got.body).not.toContain(key);
      // Refusals never echo what was sent.
      for (const bad of ["short", "has spaces in it here", `${key}\n`, "x".repeat(300), 42]) {
        const r = await call({ method: "PUT", url, body: { apiKey: bad } });
        expect(r.status).toBe(400);
        expect(r.json.error.message).toBe(SEARCH_SETTINGS_TEXT.keyShape);
        if (typeof bad === "string") expect(r.body).not.toContain(bad.trim());
      }
      expect((await call({ method: "PUT", url, body: { apiKey: key, extra: 1 } })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.keyFields);
      // A key in the address is refused before anything else (R96).
      const q = await call({ method: "PUT", url: `${url}?apiKey=${key}`, body: { apiKey: key } });
      expect(q.status).toBe(401);
      expect(q.body).not.toContain(key);
      expect((await call({ method: "DELETE", url })).json).toEqual({ removed: true });
      expect(secrets.values.has(name)).toBe(false);
      expect((await call({ method: "DELETE", url })).json).toEqual({ removed: false });
    }
    expect(logs).not.toContain(OA_KEY);
    expect(logs).not.toContain(ELICIT_KEY);
  });

  it("only the desktop app reaches them", async () => {
    await start();
    for (const name of ["elicit-api-key", "openalex-api-key"]) {
      await expectGuarded({ url: `/secrets/${name}` });
      await expectGuarded({ method: "PUT", url: `/secrets/${name}`, body: { apiKey: OA_KEY } });
      await expectGuarded({ method: "DELETE", url: `/secrets/${name}` });
    }
    expect(secrets.values.size).toBe(0);
  });

  it("without a password store: the same refusals as the Zotero key's, and nothing stored anywhere else", async () => {
    secrets.restore();
    const none = useNoSecretStore();
    try {
      await start();
      const put = await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } });
      expect(put.status).toBe(503);
      expect(put.json.error.message).toBe(SECRET_STORE_UNAVAILABLE);
      expect(SEARCH_SETTINGS_TEXT.keyNotSaved).toBe(SECRET_STORE_UNAVAILABLE);
      const get = await call({ url: "/secrets/openalex-api-key" });
      expect(get.status).toBe(503);
      expect(get.json.error.message).toBe(SEARCH_SETTINGS_TEXT.noStoreForStatus);
      expect((await call({ method: "DELETE", url: "/secrets/openalex-api-key" })).status).toBe(503);
    } finally {
      none.restore();
      secrets = useMemorySecrets();
    }
  });

  it("a PUT of the key takes effect without a restart, a DELETE too; the key goes to api.openalex.org only, in the header", async () => {
    await start();
    const pid = await openLibraryWithProject();
    await addAndSettle(pid, LINE);
    const oa = () => requests.filter((r) => r.origin === "https://api.openalex.org");
    expect(oa().length).toBeGreaterThan(0);
    for (const r of oa()) expect(r.headers.authorization).toBeUndefined();
    expect((await call({ method: "PUT", url: "/secrets/openalex-api-key", body: { apiKey: OA_KEY } })).status).toBe(200);
    requests = [];
    await addAndSettle(pid, "Zorblatt Grammar of Habitus by Quillfeather 1999");
    expect(oa().length).toBeGreaterThan(0);
    for (const r of requests) {
      if (r.origin === "https://api.openalex.org") expect(r.headers.authorization).toBe(`Bearer ${OA_KEY}`);
      else expect(JSON.stringify(r)).not.toContain(OA_KEY);
      expect(r.path).not.toContain(OA_KEY);
    }
    expect((await call({ method: "DELETE", url: "/secrets/openalex-api-key" })).status).toBe(200);
    requests = [];
    await addAndSettle(pid, "Quillfeather 1999 Zorblatt Grammar of Habitus");
    for (const r of requests) expect(JSON.stringify(r)).not.toContain(OA_KEY);
    // Nothing of the library's cache holds the key.
    const cache = join(tmp, "Lib", ".cache", "lookups");
    for (const f of await readdir(cache).catch(() => [] as string[])) expect(await readFile(join(cache, f), "utf8")).not.toContain(OA_KEY);
  });

  it("no key is read for a source that is off: OpenAlex off in both groups, its key never read and never sent", async () => {
    await start();
    secrets.values.set("openalex-api-key", OA_KEY);
    let reads = 0;
    const { _setSecretBackend } = await import("../../../packages/library/src/secrets.js");
    _setSecretBackend({
      get: async (n) => {
        if (n === "openalex-api-key") reads++;
        return secrets.values.get(n) ?? null;
      },
      set: async (n, v) => void secrets.values.set(n, v),
      delete: async (n) => secrets.values.delete(n),
    });
    const off = { ...ALL_ON, record: ALL_ON.record.map((x) => (x.id === "openalex" ? { ...x, on: false } : x)), copies: ALL_ON.copies.map((x) => (x.id === "openalex" ? { ...x, on: false } : x)) };
    expect((await call({ method: "PUT", url: "/settings/search-sources", body: off })).status).toBe(200);
    const pid = await openLibraryWithProject();
    await addAndSettle(pid, LINE);
    expect(reads).toBe(0);
    expect(requests.filter((r) => r.origin === "https://api.openalex.org")).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("R297 b, R298 g: the OpenAlex key belongs to OpenAlex, is read lazily and never holds an entry", () => {
  /** A password store whose OpenAlex read is counted, and answers after `delay` ms (never, for Infinity), or fails. */
  function countingStore(o: { delay?: number; fail?: boolean } = {}) {
    const seen = { reads: 0 };
    _setSecretBackend({
      get: async (n) => {
        if (n !== "openalex-api-key") return secrets.values.get(n) ?? null;
        seen.reads++;
        if (o.fail) throw new Error("the store is locked");
        if (o.delay === Infinity) return new Promise<never>(() => undefined);
        if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
        return secrets.values.get(n) ?? null;
      },
      set: async (n, v) => void secrets.values.set(n, v),
      delete: async (n) => secrets.values.delete(n),
    });
    return seen;
  }
  const OFF = { ...ALL_ON, record: ALL_ON.record.map((x) => (x.id === "openalex" ? { ...x, on: false } : x)), copies: ALL_ON.copies.map((x) => (x.id === "openalex" ? { ...x, on: false } : x)) };

  it("with OpenAlex off in both groups, an import's OpenAlex request carries the saved key (read when that request is about to be made)", async () => {
    await start();
    secrets.values.set("openalex-api-key", OA_KEY);
    const store = countingStore();
    expect((await call({ method: "PUT", url: "/settings/search-sources", body: OFF })).status).toBe(200);
    const pid = await openLibraryWithProject();
    expect(store.reads).toBe(0);
    // An import's DOI lookup: Crossref does not know it, so OpenAlex is asked (through the library's own client).
    agent.get("https://api.crossref.org").intercept({ path: (p: string) => p.startsWith("/works/10.5555"), method: "GET" }).reply(404, "");
    const s = svc!.state.requireSession();
    await lookupDoi("10.5555/ao.f12.import", await lookupContextFor(s.repo, pid, s.http));
    const oa = requests.filter((r) => r.origin === "https://api.openalex.org");
    expect(oa.length).toBe(1);
    expect(oa[0]!.headers.authorization).toBe(`Bearer ${OA_KEY}`);
    expect(oa[0]!.path).not.toContain(OA_KEY);
    expect(store.reads).toBe(1);
    for (const r of requests.filter((x) => x.origin !== "https://api.openalex.org")) expect(JSON.stringify(r)).not.toContain(OA_KEY);
  });

  it(`a password store that never answers: the entry's search goes on without the key within the bound (${SEARCH_KEY_WAIT_MS} ms) and is not "unexpected"`, async () => {
    expect(SEARCH_KEY_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(SEARCH_KEY_WAIT_MS).toBeLessThanOrEqual(2_000);
    await start();
    secrets.values.set("openalex-api-key", OA_KEY);
    const store = countingStore({ delay: Infinity });
    const pid = await openLibraryWithProject();
    const t0 = Date.now();
    const e = await addAndSettle(pid, LINE);
    expect(MADE).toContain(e.state);
    expect(e.reason).toBeUndefined();
    const oa = requests.filter((r) => r.origin === "https://api.openalex.org");
    expect(oa.length).toBeGreaterThan(0);
    for (const r of oa) expect(r.headers.authorization).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(SEARCH_KEY_WAIT_MS + 4_000);
    // The next entry does not wait again on the read still in flight; the store was asked once.
    const t1 = Date.now();
    const second = await addAndSettle(pid, "Zorblatt Grammar of Habitus by Quillfeather 1999");
    expect(second.state).toBe("already");
    expect(second.reason).toBeUndefined();
    expect(Date.now() - t1).toBeLessThan(SEARCH_KEY_WAIT_MS);
    expect(store.reads).toBe(1);
  });

  it("a hundred requests at once make one read, and each request then carries the key", async () => {
    await start();
    secrets.values.set("openalex-api-key", OA_KEY);
    const store = countingStore({ delay: 50 });
    await openLibraryWithProject();
    const s = svc!.state.requireSession();
    await Promise.all(Array.from({ length: 100 }, () => svc!.state.searchKeyReady("api.openalex.org")));
    expect(store.reads).toBe(1);
    await Promise.all([1, 2, 3].map((i) => s.http.getJson(`https://api.openalex.org/works/W${i}`, { cacheKey: `t:${i}`, sensitive: true })));
    expect(store.reads).toBe(1);
    const oa = requests.filter((r) => r.origin === "https://api.openalex.org");
    expect(oa.map((r) => r.headers.authorization)).toEqual([1, 2, 3].map(() => `Bearer ${OA_KEY}`));
    // Never asked for another host.
    await svc!.state.searchKeyReady("elicit.com");
    await svc!.state.searchKeyReady("api.crossref.org");
    expect(svc!.state.searchKeyForHost("elicit.com")).toBeUndefined();
    expect(svc!.state.searchKeyForHost("api.crossref.org")).toBeUndefined();
  });

  it("a store that fails is asked once a minute at most; the requests go without the key meanwhile", async () => {
    await start();
    secrets.values.set("openalex-api-key", OA_KEY);
    const store = countingStore({ fail: true });
    await openLibraryWithProject();
    const s = svc!.state.requireSession();
    for (let i = 0; i < 5; i++) await s.http.getJson(`https://api.openalex.org/works/F${i}`, { cacheKey: `f:${i}`, sensitive: true });
    expect(store.reads).toBe(1);
    for (const r of requests) expect(r.headers.authorization).toBeUndefined();
    const real = Date.now;
    try {
      Date.now = () => real() + 61_000;
      await svc!.state.searchKeyReady("api.openalex.org");
      expect(store.reads).toBe(2);
    } finally {
      Date.now = real;
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe("R304: no read of a key waits for the password store beyond the bound (a Test, Elicit's key, a key saved during a read)", () => {
  type Name = "elicit-api-key" | "openalex-api-key";
  /** A password store whose reads of `name` are counted and answer after `delay` ms (Infinity: never) with what is saved then, or `answer`. */
  function slowStore(name: Name, delay: number, answer?: string | null) {
    const seen = { reads: 0 };
    _setSecretBackend({
      get: async (n) => {
        if (n !== name) return secrets.values.get(n) ?? null;
        seen.reads++;
        if (delay === Infinity) return new Promise<never>(() => undefined);
        await new Promise((r) => setTimeout(r, delay));
        return answer !== undefined ? answer : (secrets.values.get(n) ?? null);
      },
      set: async (n, v) => void secrets.values.set(n, v),
      delete: async (n) => secrets.values.delete(n),
    });
    return seen;
  }
  const UNREADABLE = { ok: false, sentence: SEARCH_SETTINGS_TEXT.noStoreForStatus };
  const test = (g: string, id: string) => call({ method: "POST", url: `/settings/search-sources/${g}/${id}/test` });

  it("a store that never answers: a Test of Elicit or of OpenAlex ends within the bound, says the key could not be read, asks nothing, and a second press is accepted", async () => {
    for (const [name, g, id, origin] of [
      ["elicit-api-key", "record", "elicit", "https://elicit.com"],
      ["openalex-api-key", "copies", "openalex", "https://api.openalex.org"],
    ] as const) {
      await start();
      secrets.values.set(name, name === "elicit-api-key" ? ELICIT_KEY : OA_KEY);
      const store = slowStore(name, Infinity);
      requests = [];
      const t0 = Date.now();
      expect((await test(g, id)).json, id).toEqual(UNREADABLE);
      expect(Date.now() - t0).toBeLessThan(SEARCH_KEY_WAIT_MS + 1_000);
      const again = await test(g, id);
      expect(again.status, id).toBe(200);
      expect(again.json).toEqual(UNREADABLE);
      expect(requests.filter((r) => r.origin === origin)).toEqual([]);
      expect(store.reads).toBe(1);
      await svc!.close();
      svc = undefined;
      secrets = useMemorySecrets();
    }
  });

  it("a store that answers after the bound: the Test says so; once the key has come, the next press asks with it", async () => {
    await start();
    secrets.values.set("elicit-api-key", ELICIT_KEY);
    slowStore("elicit-api-key", SEARCH_KEY_WAIT_MS + 500);
    expect((await test("record", "elicit")).json).toEqual(UNREADABLE);
    expect(requests).toEqual([]);
    await new Promise((r) => setTimeout(r, 800));
    expect((await test("record", "elicit")).json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    expect(requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${ELICIT_KEY}`]);
  });

  it("a key saved while a Test waits on the store: the next press asks with the saved key", async () => {
    await start();
    slowStore("elicit-api-key", Infinity);
    const first = test("record", "elicit");
    await new Promise((r) => setTimeout(r, 100));
    expect((await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } })).status).toBe(200);
    expect((await first).status).toBe(200);
    const second = await test("record", "elicit");
    expect(second.json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    const toElicit = requests.filter((r) => r.origin === "https://elicit.com");
    expect(toElicit.at(-1)!.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
  });

  it("a Test whose request hangs ends at its 30-second limit and gives its place up: a second press is accepted", async () => {
    await start();
    crossrefDelay = 45_000;
    const t0 = Date.now();
    const r = await test("record", "crossref");
    expect(r.json).toEqual({ ok: false, sentence: SEARCH_TEST_TEXT.unreachable });
    expect(Date.now() - t0).toBeLessThan(FIND_SOURCE_TEST_TIMEOUT_MS + 3_000);
    crossrefDelay = 0;
    expect((await test("record", "crossref")).status).toBe(200);
  }, 60_000);

  it("Elicit's key is read once for every entry, bounded from the read's start: with a store that hangs, the first entry waits at most the bound, the next two do not wait; a PUT then reaches the next entry", async () => {
    await start();
    secrets.values.set("elicit-api-key", ELICIT_KEY);
    const store = slowStore("elicit-api-key", Infinity);
    expect((await call({ method: "PUT", url: "/settings/search-sources", body: { ...ALL_ON, record: ALL_ON.record.map((x) => ({ ...x, on: true })) } })).status).toBe(200);
    const pid = await openLibraryWithProject(ELICIT_GOV);
    const times: number[] = [];
    for (const line of [LINE, "Zorblatt Grammar of Habitus by Quillfeather 1999", "Quillfeather 1999 Zorblatt Grammar of Habitus"]) {
      const t = Date.now();
      const e = await addAndSettle(pid, line);
      times.push(Date.now() - t);
      expect(e.reason).toBeUndefined();
    }
    expect(times[0]!).toBeLessThan(SEARCH_KEY_WAIT_MS + 3_000);
    expect(times[1]!, "the second entry waited").toBeLessThan(SEARCH_KEY_WAIT_MS);
    expect(times[2]!, "the third entry waited").toBeLessThan(SEARCH_KEY_WAIT_MS);
    expect(store.reads).toBe(1);
    expect(requests.filter((r) => r.origin === "https://elicit.com")).toEqual([]);
    expect((await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } })).status).toBe(200);
    await addAndSettle(pid, "Grammar of Habitus, Quillfeather");
    const toElicit = requests.filter((r) => r.origin === "https://elicit.com");
    expect(toElicit).toHaveLength(1);
    expect(toElicit[0]!.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
  });

  it("R304 c: a key saved (PUT) or removed (DELETE) while a read is in flight wins over the read's late answer, for both keys", async () => {
    for (const name of ["openalex-api-key", "elicit-api-key"] as const) {
      await start();
      // The store answers an old key 500 ms after it is asked.
      slowStore(name, 500, "old-key-RECOGNISABLE-0000");
      const late = svc!.state.searchKey(name);
      expect((await call({ method: "PUT", url: `/secrets/${name}`, body: { apiKey: OA_KEY } })).status).toBe(200);
      await late;
      expect(await svc!.state.searchKey(name), `${name} after PUT`).toBe(OA_KEY);
      if (name === "openalex-api-key") expect(svc!.state.searchKeyForHost("api.openalex.org")).toBe(OA_KEY);
      await svc!.close();
      await start();
      slowStore(name, 500, "old-key-RECOGNISABLE-0000");
      const late2 = svc!.state.searchKey(name);
      expect((await call({ method: "DELETE", url: `/secrets/${name}` })).status).toBe(200);
      await late2;
      expect(await svc!.state.searchKey(name), `${name} after DELETE`).toBeUndefined();
      await svc!.close();
      svc = undefined;
      secrets = useMemorySecrets();
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe("GET and PUT /settings/search-sources (R290 b, d, e)", () => {
  it("the defaults: Crossref, OpenAlex and Elicit (off) — never Open Library or the Library of Congress, which Find and acquire does not ask", async () => {
    await start();
    const r = await call({ url: "/settings/search-sources" });
    expect(r.status, r.body).toBe(200);
    const s = r.json as SearchSourcesResponse;
    expect(s.record).toEqual([
      { id: "crossref", on: true },
      { id: "openalex", on: true },
      { id: "elicit", on: false },
    ]);
    expect(s.copies.map((x) => `${x.id}:${x.on}`)).toEqual(["openalex:true", "unpaywall:false", "arxiv:true", "europepmc:true", "semanticscholar:true", "doab:true", "internetarchive:true"]);
    expect(s.problem).toBeUndefined();
    expect(s.record.some((x) => x.allowedByRules !== undefined)).toBe(false);
  });

  it("a save is stored in the app's settings folder, 0600; the order and the e-mails come back; Open Library and LoC keep their place in the file", async () => {
    await start();
    const body = { ...ALL_ON, record: [ALL_ON.record[2]!, ALL_ON.record[0]!, ALL_ON.record[1]!], copies: ALL_ON.copies.map((x) => (x.id === "unpaywall" ? { ...x, on: true } : x)), crossrefEmail: CROSSREF_EMAIL, unpaywallEmail: UNPAYWALL_EMAIL };
    const r = await call({ method: "PUT", url: "/settings/search-sources", body });
    expect(r.status, r.body).toBe(200);
    // R298 a: Elicit, sent first, is accepted and stored last (it cannot be moved).
    expect(r.json.record.map((x: { id: string }) => x.id)).toEqual(["crossref", "openalex", "elicit"]);
    expect(r.json.crossrefEmail).toBe(CROSSREF_EMAIL);
    expect(r.json.unpaywallEmail).toBe(UNPAYWALL_EMAIL);
    const file = join(deps.appConfigDir, "search-sources.json");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.record.map((x: { id: string }) => x.id)).toEqual(["crossref", "openalex", "openlibrary", "loc", "elicit"]);
    expect((await call({ url: "/settings/search-sources" })).json).toEqual(r.json);
  });

  it("refusals, each a sentence that repeats nothing sent: a bad e-mail names its field; Unpaywall on without its e-mail; a source missing, repeated or unknown; another field", async () => {
    await start();
    const put = (body: unknown) => call({ method: "PUT", url: "/settings/search-sources", body });
    expect((await put({ ...ALL_ON, crossrefEmail: "not an address" })).json.error.message).toBe(searchEmailRefusal("crossrefEmail"));
    expect((await put({ ...ALL_ON, unpaywallEmail: "a@b.example\r\nX-Evil: 1" })).json.error.message).toBe(searchEmailRefusal("unpaywallEmail"));
    expect((await put({ ...ALL_ON, copies: ALL_ON.copies.map((x) => ({ ...x, on: true })) })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.unpaywallNeedsEmail);
    expect((await put({ ...ALL_ON, record: ALL_ON.record.slice(1) })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.sources);
    expect((await put({ ...ALL_ON, record: [...ALL_ON.record.slice(1), ALL_ON.record[1]] })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.sources);
    expect((await put({ ...ALL_ON, record: [{ id: "scihub", on: true }, ...ALL_ON.record.slice(1)] })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.sources);
    expect((await put({ ...ALL_ON, record: [{ id: "openlibrary", on: true }, ...ALL_ON.record.slice(1)] })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.sources);
    expect((await put({ ...ALL_ON, elicitKey: ELICIT_KEY })).json.error.message).toBe(SEARCH_SETTINGS_TEXT.fields);
    for (const b of errorBodies) expect(b).not.toMatch(/not an address|X-Evil|scihub/u);
    await expect(stat(join(deps.appConfigDir, "search-sources.json"))).rejects.toThrow();
  });

  it("an unreadable file: the defaults, said so; the next save replaces it (the old one kept). A newer file: read-only, said so, a save refused", async () => {
    await start();
    await mkdir(deps.appConfigDir, { recursive: true });
    const file = join(deps.appConfigDir, "search-sources.json");
    await writeFile(file, "not json {");
    let r = await call({ url: "/settings/search-sources" });
    expect(r.json.problem).toEqual({ code: "unreadable", text: SEARCH_SETTINGS_TEXT.unreadable });
    expect(await readFile(file, "utf8")).toBe("not json {");
    expect((await call({ method: "PUT", url: "/settings/search-sources", body: ALL_ON })).status).toBe(200);
    expect((await readdir(deps.appConfigDir)).some((n) => n.startsWith("search-sources.json.unreadable-"))).toBe(true);
    expect((await call({ url: "/settings/search-sources" })).json.problem).toBeUndefined();
    const newer = JSON.stringify({ v: 2, record: [], copies: [] });
    await writeFile(file, newer);
    r = await call({ url: "/settings/search-sources" });
    expect(r.json.problem).toEqual({ code: "newer", text: SEARCH_SETTINGS_TEXT.newer });
    const put = await call({ method: "PUT", url: "/settings/search-sources", body: ALL_ON });
    expect(put.status).toBe(409);
    expect(put.json.error.message).toBe(SEARCH_SETTINGS_TEXT.newer);
    expect(await readFile(file, "utf8")).toBe(newer);
  });

  it("R298 a: Elicit is always the last record source: GET returns it last whatever the file holds; a PUT naming it first or between is stored with it last", async () => {
    await start();
    await mkdir(deps.appConfigDir, { recursive: true });
    const file = join(deps.appConfigDir, "search-sources.json");
    await writeFile(file, JSON.stringify({ v: 1, record: [{ id: "elicit", on: true }, { id: "openalex", on: true }, { id: "crossref", on: false }], copies: [] }));
    const got = await call({ url: "/settings/search-sources" });
    expect(got.json.problem).toBeUndefined();
    expect(got.json.record.map((x: { id: string; on: boolean }) => `${x.id}:${x.on}`)).toEqual(["openalex:true", "crossref:false", "elicit:true"]);
    for (const record of [
      [ALL_ON.record[2]!, ALL_ON.record[1]!, ALL_ON.record[0]!],
      [ALL_ON.record[1]!, ALL_ON.record[2]!, ALL_ON.record[0]!],
    ]) {
      const put = await call({ method: "PUT", url: "/settings/search-sources", body: { ...ALL_ON, record } });
      expect(put.status, put.body).toBe(200);
      expect(put.json.record.map((x: { id: string }) => x.id)).toEqual(["openalex", "crossref", "elicit"]);
      expect(JSON.parse(await readFile(file, "utf8")).record.map((x: { id: string }) => x.id).at(-1)).toBe("elicit");
      expect((await call({ url: "/settings/search-sources" })).json.record.map((x: { id: string }) => x.id)).toEqual(["openalex", "crossref", "elicit"]);
    }
  });

  it("R298 d: a body that is not a JSON object is refused in this module's own sentences (settings: fields; a key: key fields; a Test: no body)", async () => {
    await start();
    const raw = async (method: "PUT" | "POST", url: string, payload: string, type = "application/json") => {
      const res = await svc!.app.inject({ method, url, headers: { ...auth, "content-type": type }, payload });
      if (res.statusCode >= 400) errorBodies.push(res.body);
      return { status: res.statusCode, message: (res.json() as { error: { message: string } }).error.message };
    };
    for (const [payload, type] of [["[]", "application/json"], ['"a string"', "application/json"], ["42", "application/json"], ["just text", "text/plain"]] as const) {
      expect(await raw("PUT", "/settings/search-sources", payload, type), payload).toEqual({ status: 400, message: SEARCH_SETTINGS_TEXT.fields });
      for (const name of ["elicit-api-key", "openalex-api-key"]) expect(await raw("PUT", `/secrets/${name}`, payload, type), `${name} ${payload}`).toEqual({ status: 400, message: SEARCH_SETTINGS_TEXT.keyFields });
      expect(await raw("POST", "/settings/search-sources/record/crossref/test", payload, type), payload).toEqual({ status: 400, message: SEARCH_SETTINGS_TEXT.noBody });
    }
    expect(requests).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });

  it("?project= adds whether that project's rules allow each source; a source the rules forbid says so whatever its setting", async () => {
    await start();
    const pid = await openLibraryWithProject();
    const r = await call({ url: `/settings/search-sources?project=${pid}` });
    expect(r.status, r.body).toBe(200);
    expect(r.json.record.map((x: { id: string; allowedByRules: boolean }) => `${x.id}:${x.allowedByRules}`)).toEqual(["crossref:true", "openalex:true", "elicit:false"]);
    expect(r.json.copies.every((x: { allowedByRules: boolean }) => x.allowedByRules === true)).toBe(true);
    expect((await call({ url: "/settings/search-sources?project=nope" })).status).toBe(400);
    expect((await call({ url: "/settings/search-sources?project=01900000-0000-7000-8000-000000000000" })).status).toBe(404);
  });

  it("only the desktop app reaches them", async () => {
    await start();
    await expectGuarded({ url: "/settings/search-sources" });
    await expectGuarded({ method: "PUT", url: "/settings/search-sources", body: ALL_ON });
    await expectGuarded({ method: "POST", url: "/settings/search-sources/record/crossref/test" });
    expect(requests).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("Test (R290 g)", () => {
  it("asks the fixed question, never typed words, and answers a fixed sentence; the address names the group", async () => {
    await start();
    const pid = await openLibraryWithProject();
    await addAndSettle(pid, LINE);
    requests = [];
    const r = await call({ method: "POST", url: "/settings/search-sources/record/crossref/test" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0]!.path)).toContain("Distinction Bourdieu");
    expect(JSON.stringify(requests)).not.toMatch(/Zorblatt|Quillfeather/u);
    expect((await call({ method: "POST", url: "/settings/search-sources/copies/openalex/test" })).json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    expect(decodeURIComponent(requests[1]!.path)).toContain("10.1038/171737a0");
    for (const bad of ["record/openlibrary", "record/loc", "copies/crossref", "nothing/crossref", "record/unpaywall"]) expect((await call({ method: "POST", url: `/settings/search-sources/${bad}/test` })).status, bad).toBe(404);
  });

  it("a test without the key asks nothing; Unpaywall without its e-mail asks nothing; a test of a source that is off is allowed", async () => {
    await start();
    expect((await call({ method: "POST", url: "/settings/search-sources/record/elicit/test" })).json).toEqual({ ok: false, sentence: SEARCH_TEST_TEXT.needsElicitKey });
    expect((await call({ method: "POST", url: "/settings/search-sources/copies/unpaywall/test" })).json).toEqual({ ok: false, sentence: SEARCH_TEST_TEXT.needsUnpaywallEmail });
    expect(requests).toEqual([]);
    // Elicit is off (the default) and its key stored: the researcher may try it.
    await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } });
    expect((await call({ method: "POST", url: "/settings/search-sources/record/elicit/test" })).json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ query: "Distinction Bourdieu", maxResults: 10 });
  });

  it("R298 c: a Test of Elicit during its five-minute pause asks nothing and answers the pause's own sentence (the row's note)", async () => {
    await start();
    await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } });
    elicitStatus = 429;
    expect((await call({ method: "POST", url: "/settings/search-sources/record/elicit/test" })).json).toEqual({ ok: false, sentence: SEARCH_TEST_TEXT.unreachable });
    requests = [];
    elicitStatus = 200;
    expect((await call({ method: "POST", url: "/settings/search-sources/record/elicit/test" })).json).toEqual({ ok: false, sentence: SEARCH_SETTINGS_TEXT.elicitPaused });
    expect(requests).toEqual([]);
    expect((await call({ url: "/settings/search-sources" })).json.record.find((x: { id: string }) => x.id === "elicit").note).toBe(SEARCH_SETTINGS_TEXT.elicitPaused);
  });

  it("a second test of one source is refused while the first runs; another source may be tested meanwhile", async () => {
    await start();
    crossrefDelay = 400;
    const first = call({ method: "POST", url: "/settings/search-sources/record/crossref/test" });
    await until(async () => requests.length > 0, "the first test's request");
    const second = await call({ method: "POST", url: "/settings/search-sources/record/crossref/test" });
    expect(second.status).toBe(409);
    expect(second.json.error.message).toBe(SEARCH_SETTINGS_TEXT.testRunning);
    expect((await call({ method: "POST", url: "/settings/search-sources/record/openalex/test" })).status).toBe(200);
    expect((await first).json).toEqual({ ok: true, sentence: SEARCH_TEST_TEXT.answered });
    expect((await call({ method: "POST", url: "/settings/search-sources/record/crossref/test" })).status).toBe(200);
  });

  it("a test takes no body", async () => {
    await start();
    const r = await call({ method: "POST", url: "/settings/search-sources/record/crossref/test", body: { query: "Something Typed" } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe(SEARCH_SETTINGS_TEXT.noBody);
    expect(requests).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("each e-mail only on its own service's requests, and Elicit in the service (R290 c, e)", () => {
  it("with both e-mails set: Crossref's only in Crossref's User-Agent, Unpaywall's only to Unpaywall, over an entry's search and Tests", async () => {
    await start();
    const body = { ...ALL_ON, copies: ALL_ON.copies.map((x) => (x.id === "unpaywall" ? { ...x, on: true } : x)), crossrefEmail: CROSSREF_EMAIL, unpaywallEmail: UNPAYWALL_EMAIL };
    expect((await call({ method: "PUT", url: "/settings/search-sources", body })).status).toBe(200);
    const pid = await openLibraryWithProject();
    await addAndSettle(pid, LINE);
    for (const [g, id] of [["copies", "unpaywall"], ["copies", "openalex"], ["copies", "arxiv"], ["record", "crossref"]]) await call({ method: "POST", url: `/settings/search-sources/${g}/${id}/test` });
    const origins = new Set(requests.map((r) => r.origin));
    for (const o of ["https://api.crossref.org", "https://api.openalex.org", "https://api.unpaywall.org", "https://export.arxiv.org"]) expect(origins).toContain(o);
    for (const r of requests) {
      const all = JSON.stringify(r);
      if (r.origin === "https://api.crossref.org") expect(r.headers["user-agent"]).toContain(`mailto:${CROSSREF_EMAIL}`);
      else expect(all).not.toContain(CROSSREF_EMAIL);
      if (r.origin !== "https://api.unpaywall.org") expect(all).not.toContain(encodeURIComponent(UNPAYWALL_EMAIL));
      expect(all).not.toContain(UNPAYWALL_EMAIL);
    }
  });

  it("Elicit on, its key stored, the rules naming it: an entry asks it with the typed words only; the key only to elicit.com", async () => {
    await start();
    await call({ method: "PUT", url: "/secrets/elicit-api-key", body: { apiKey: ELICIT_KEY } });
    await call({ method: "PUT", url: "/secrets/openalex-api-key", body: { apiKey: OA_KEY } });
    expect((await call({ method: "PUT", url: "/settings/search-sources", body: { ...ALL_ON, record: ALL_ON.record.map((x) => ({ ...x, on: true })) } })).status).toBe(200);
    const pid = await openLibraryWithProject(ELICIT_GOV);
    expect((await call({ url: `/settings/search-sources?project=${pid}` })).json.record.find((x: { id: string }) => x.id === "elicit").allowedByRules).toBe(true);
    const e = await addAndSettle(pid, LINE);
    expect(MADE).toContain(e.state);
    const toElicit = requests.filter((r) => r.origin === "https://elicit.com");
    expect(toElicit).toHaveLength(1);
    expect(JSON.parse(toElicit[0]!.body!)).toEqual({ query: LINE, maxResults: 10 });
    expect(toElicit[0]!.body).not.toContain(pid);
    for (const r of requests) {
      const others = JSON.stringify({ ...r, headers: { ...r.headers, authorization: undefined } });
      expect(others).not.toContain(ELICIT_KEY);
      expect(others).not.toContain(OA_KEY);
      if (r.origin === "https://elicit.com") expect(r.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
      else if (r.origin === "https://api.openalex.org") expect(r.headers.authorization).toBe(`Bearer ${OA_KEY}`);
      else expect(r.headers.authorization).toBeUndefined();
    }
  });
});
