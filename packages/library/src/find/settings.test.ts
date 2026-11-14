/**
 * Task F12 (R290 b, d, e, g): the "Search sources" settings file, the e-mails by service, and "Test".
 *
 * The file is one for the app, in its settings folder: `search-sources.json`, 0600, written atomically. Missing means
 * the defaults; damaged means the defaults AND says so (a read never rewrites it); written by a newer version means
 * the defaults, said so, and a write is refused. Nothing here reaches the network: the lookup client is given an undici
 * MockAgent (disableNetConnect) composed with a recorder of every request. The e-mail addresses and keys are made up.
 */
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LookupContext } from "../lookup/context.js";
import { HttpClient } from "../lookup/http.js";
import { findFreeCopies } from "./free-copy.js";
import { parseReference } from "./reference.js";
import { searchWorks } from "./search.js";
import {
  FIND_SOURCE_TEST_DOI,
  FIND_SOURCE_TEST_WORDS,
  SEARCH_SOURCES_FILE,
  SearchSettingsNewerError,
  readSearchSettings,
  searchContactEmail,
  searchKeyWanted,
  testSearchSource,
  writeSearchSettings,
} from "./settings.js";
import { _resetElicitForTests } from "./elicit.js";
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from "./types.js";

const CROSSREF_EMAIL = "crossref-only@example.invalid";
const UNPAYWALL_EMAIL = "test-only@example.invalid";
const OA_KEY = "oakey-RECOGNISABLE-7f3a9c";
const ELICIT_KEY = "elk-RECOGNISABLE-55e1b0";
const JSON_H = { headers: { "content-type": "application/json" } };

let tmp: string;
let dir: string;
let agent: MockAgent;
let dispatcher: Dispatcher;
let requests: Array<{ origin: string; path: string; method: string; headers: Record<string, string>; body?: string }>;

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}
const recorder: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  requests.push({ origin: new URL(String(opts.origin)).origin, path: opts.path, method: String(opts.method), headers: headersOf(opts.headers), ...(typeof opts.body === "string" ? { body: opts.body } : {}) });
  return dispatch(opts, handler);
};

function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher, maxRetries: 0, env: {}, sleep: async () => {}, ...extra });
}
function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}
const ctx = (http: HttpClient): LookupContext => ({ http, policy: policy(["crossref", "openalex"]), projectId: "P1", actor: "tester", sensitive: false });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-search-settings-"));
  dir = join(tmp, "config");
  agent = new MockAgent();
  agent.disableNetConnect();
  dispatcher = agent.compose(recorder);
  requests = [];
  _resetElicitForTests();
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

const file = () => join(dir, SEARCH_SOURCES_FILE);
const ids = (s: SearchSettings) => s.record.map((x) => `${x.id}:${x.on}`);

describe("the settings file", () => {
  it("missing: the defaults, no problem said, and nothing written", async () => {
    const r = await readSearchSettings(dir);
    expect(r).toEqual({ settings: { record: DEFAULT_SEARCH_SETTINGS.record, copies: DEFAULT_SEARCH_SETTINGS.copies } });
    expect(r.problem).toBeUndefined();
    await expect(stat(file())).rejects.toThrow();
  });

  it("is written 0600 and atomically (a new file replaces the old one whole), in the app's settings folder", async () => {
    await writeSearchSettings(dir, { ...DEFAULT_SEARCH_SETTINGS, crossrefEmail: CROSSREF_EMAIL } as SearchSettings, new Date());
    const before = await readFile(file(), "utf8");
    // A hard link to the first file keeps its content: the second write did not change that file in place.
    await link(file(), join(tmp, "old-link"));
    // Reversed, Elicit kept last (R298 a: it cannot be moved).
    const next: SearchSettings = { record: [...DEFAULT_SEARCH_SETTINGS.record.filter((x) => x.id !== "elicit")].reverse().concat(DEFAULT_SEARCH_SETTINGS.record.filter((x) => x.id === "elicit")), copies: DEFAULT_SEARCH_SETTINGS.copies!, unpaywallEmail: UNPAYWALL_EMAIL };
    await writeSearchSettings(dir, next, new Date());
    expect(await readFile(join(tmp, "old-link"), "utf8")).toBe(before);
    if (process.platform !== "win32") expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((f) => f.startsWith(SEARCH_SOURCES_FILE))).toEqual([SEARCH_SOURCES_FILE]);
    const back = await readSearchSettings(dir);
    expect(back.problem).toBeUndefined();
    expect(back.settings).toEqual({ record: next.record, copies: next.copies, unpaywallEmail: UNPAYWALL_EMAIL });
    const stored = JSON.parse(await readFile(file(), "utf8"));
    expect(stored.v).toBe(1);
  });

  it("an unreadable settings file falls back to defaults and says so; the read never rewrites it", async () => {
    await mkdir(dir, { recursive: true });
    for (const bad of ["not json {", "[]", JSON.stringify({ v: 1, record: "crossref" }), JSON.stringify({ v: 1, record: [{ id: "crossref", on: "yes" }], copies: [] }), JSON.stringify({ v: 1, record: [], copies: [], extra: 1 }), JSON.stringify({ v: 1, record: [], copies: [], crossrefEmail: "not an address" })]) {
      await writeFile(file(), bad);
      const r = await readSearchSettings(dir);
      expect(r.problem, bad).toBe("unreadable");
      expect(ids(r.settings)).toEqual(ids(DEFAULT_SEARCH_SETTINGS));
      expect(await readFile(file(), "utf8")).toBe(bad);
    }
  });

  it("a damaged file is set aside (kept) by the next save, which then writes", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(file(), "not json {");
    await writeSearchSettings(dir, DEFAULT_SEARCH_SETTINGS as SearchSettings, new Date("2026-11-14T10:00:00Z"));
    const names = await readdir(dir);
    expect(names.some((n) => n.startsWith(`${SEARCH_SOURCES_FILE}.unreadable-`))).toBe(true);
    expect((await readSearchSettings(dir)).problem).toBeUndefined();
  });

  it("a newer file is read-only: the defaults, said so, and a save refused with a sentence; the file is unchanged", async () => {
    await mkdir(dir, { recursive: true });
    const newer = JSON.stringify({ v: 2, record: [{ id: "elicit", on: true }], copies: [], somethingNew: true });
    await writeFile(file(), newer);
    const r = await readSearchSettings(dir);
    expect(r.problem).toBe("newer");
    expect(ids(r.settings)).toEqual(ids(DEFAULT_SEARCH_SETTINGS));
    const err = await writeSearchSettings(dir, DEFAULT_SEARCH_SETTINGS as SearchSettings, new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchSettingsNewerError);
    expect((err as Error).message).toMatch(/^[A-Z].*\.$/u);
    expect(await readFile(file(), "utf8")).toBe(newer);
  });

  it("unknown source names are dropped, a missing source is added at the end with its default, and the order is the file's", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      file(),
      JSON.stringify({
        v: 1,
        record: [{ id: "elicit", on: true }, { id: "someday-service", on: true }, { id: "openalex", on: false }, { id: "elicit", on: false }],
        copies: [{ id: "doab", on: false }, { id: "scihub", on: true }, { id: "arxiv", on: true }],
      }),
    );
    const r = await readSearchSettings(dir);
    expect(r.problem).toBeUndefined();
    // R298 a: Elicit is always the last of the record sources, whatever the file holds.
    expect(ids(r.settings)).toEqual(["openalex:false", "crossref:true", "openlibrary:true", "loc:true", "elicit:true"]);
    expect(r.settings.copies!.map((x) => `${x.id}:${x.on}`)).toEqual(["doab:false", "arxiv:true", "openalex:true", "unpaywall:false", "europepmc:true", "semanticscholar:true", "internetarchive:true"]);
  });

  it("R298 a: Elicit is always the last record source: a file naming it first is read with it last, and a save naming it first stores it last", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(file(), JSON.stringify({ v: 1, record: [{ id: "elicit", on: true }, { id: "crossref", on: true }, { id: "openalex", on: false }, { id: "openlibrary", on: true }, { id: "loc", on: true }], copies: [] }));
    const r = await readSearchSettings(dir);
    expect(r.problem).toBeUndefined();
    expect(ids(r.settings)).toEqual(["crossref:true", "openalex:false", "openlibrary:true", "loc:true", "elicit:true"]);
    const saved = await writeSearchSettings(dir, { record: [{ id: "elicit", on: false }, { id: "openalex", on: true }, { id: "crossref", on: true }], copies: [] }, new Date());
    expect(ids(saved)).toEqual(["openalex:true", "crossref:true", "openlibrary:true", "loc:true", "elicit:false"]);
    expect(JSON.parse(await readFile(file(), "utf8")).record.map((x: { id: string }) => x.id)).toEqual(["openalex", "crossref", "openlibrary", "loc", "elicit"]);
  });

  it("R298 f: the file is read up to 64 KiB; a larger one is unreadable (the defaults, said so), never read whole, and set aside by the next save", async () => {
    await mkdir(dir, { recursive: true });
    const { SEARCH_SOURCES_MAX_BYTES } = await import("./settings.js");
    expect(SEARCH_SOURCES_MAX_BYTES).toBe(64 * 1024);
    // A well-formed file of this shape, padded past the bound with spaces (still valid JSON), and one exactly at it.
    const body = JSON.stringify({ v: 1, record: [{ id: "crossref", on: false }], copies: [] });
    await writeFile(file(), body.padEnd(SEARCH_SOURCES_MAX_BYTES, " "));
    expect((await readSearchSettings(dir)).problem).toBeUndefined();
    expect(ids((await readSearchSettings(dir)).settings)[0]).toBe("crossref:false");
    const big = body.padEnd(SEARCH_SOURCES_MAX_BYTES + 1, " ");
    await writeFile(file(), big);
    const r = await readSearchSettings(dir);
    expect(r.problem).toBe("unreadable");
    expect(ids(r.settings)).toEqual(ids(DEFAULT_SEARCH_SETTINGS));
    expect(await readFile(file(), "utf8")).toBe(big);
    // Never read whole: a file of 50 MB is refused at once (its size, not its parse).
    await writeFile(file(), body.padEnd(50 * 1024 * 1024, " "));
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) expect((await readSearchSettings(dir)).problem).toBe("unreadable");
    expect(Date.now() - t0).toBeLessThan(500);
    // A newer version's file over the bound is unreadable too (not "newer"): the next save sets it aside and writes.
    await writeFile(file(), JSON.stringify({ v: 2, record: [], copies: [] }).padEnd(SEARCH_SOURCES_MAX_BYTES + 10, " "));
    expect((await readSearchSettings(dir)).problem).toBe("unreadable");
    await writeSearchSettings(dir, DEFAULT_SEARCH_SETTINGS as SearchSettings, new Date("2026-11-14T10:00:00Z"));
    expect((await readdir(dir)).some((n) => n.startsWith(`${SEARCH_SOURCES_FILE}.unreadable-`))).toBe(true);
    expect((await readSearchSettings(dir)).problem).toBeUndefined();
  });

  it("holds no key: a key is never a field of the file", async () => {
    await writeSearchSettings(dir, { ...(DEFAULT_SEARCH_SETTINGS as SearchSettings), elicitKey: ELICIT_KEY } as unknown as SearchSettings, new Date());
    expect(await readFile(file(), "utf8")).not.toContain(ELICIT_KEY);
  });

  it("which keys are wanted: OpenAlex's while OpenAlex is on in either group, Elicit's while Elicit is on", () => {
    const off = (s: SearchSettings, id: string) => ({ ...s, record: s.record.map((x) => (x.id === id ? { ...x, on: false } : x)), copies: s.copies?.map((x) => (x.id === id ? { ...x, on: false } : x)) });
    const d = DEFAULT_SEARCH_SETTINGS as SearchSettings;
    expect(searchKeyWanted(d, "openalex")).toBe(true);
    expect(searchKeyWanted(d, "elicit")).toBe(false);
    expect(searchKeyWanted(off(d, "openalex"), "openalex")).toBe(false);
    expect(searchKeyWanted({ ...d, record: d.record.map((x) => (x.id === "openalex" ? { ...x, on: false } : x)) }, "openalex")).toBe(true);
  });
});

describe("an e-mail goes only to its own service (R290 e)", () => {
  it("the Unpaywall e-mail is never sent to Crossref; Crossref's only to Crossref (a search and a free-copy lookup)", async () => {
    const s: SearchSettings = { ...(DEFAULT_SEARCH_SETTINGS as SearchSettings), crossrefEmail: CROSSREF_EMAIL, unpaywallEmail: UNPAYWALL_EMAIL };
    expect(searchContactEmail(s, "api.crossref.org")).toBe(CROSSREF_EMAIL);
    for (const h of ["api.openalex.org", "api.unpaywall.org", "export.arxiv.org", "elicit.com", "crossref.org"]) expect(searchContactEmail(s, h), h).toBeUndefined();
    agent.get("https://api.crossref.org").intercept({ path: (p) => p.startsWith("/works?"), method: "GET" }).reply(200, JSON.stringify({ message: { items: [] } }), JSON_H);
    agent.get("https://api.openalex.org").intercept({ path: (p) => p.startsWith("/works"), method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_H).persist();
    agent.get("https://api.unpaywall.org").intercept({ path: (p) => p.startsWith("/v2/"), method: "GET" }).reply(200, JSON.stringify({ is_oa: false }), JSON_H);
    const http = client({ contactEmailFor: (h) => searchContactEmail(s, h) });
    await searchWorks(parseReference("Bourdieu Distinction 1984")!, ctx(http), { sources: ["crossref", "openalex"] });
    await findFreeCopies({ id: "w1", title: "A Made-up Title", creators: [{ family: "Quill", role: "author" as const }], type: "article-journal", identifiers: { doi: "10.5555/made.up" }, providers: ["crossref"] }, ctx(http), ["openalex", "unpaywall"], s.unpaywallEmail);
    expect(requests.map((r) => r.origin).sort()).toEqual(["https://api.crossref.org", "https://api.openalex.org", "https://api.openalex.org", "https://api.unpaywall.org"]);
    for (const r of requests) {
      const all = JSON.stringify(r);
      if (r.origin === "https://api.crossref.org") {
        expect(r.headers["user-agent"]).toContain(`mailto:${CROSSREF_EMAIL}`);
        expect(all).not.toContain(UNPAYWALL_EMAIL);
      } else expect(all).not.toContain(CROSSREF_EMAIL);
      if (r.origin === "https://api.unpaywall.org") expect(r.path).toContain(encodeURIComponent(UNPAYWALL_EMAIL));
      else expect(all).not.toContain(UNPAYWALL_EMAIL);
    }
  });
});

describe("Test (R290 g)", () => {
  it("asks each source a fixed question, never typed words; record sources by the words, copy sources by the DOI or the fixed book", async () => {
    expect(FIND_SOURCE_TEST_WORDS).toBe("Distinction Bourdieu");
    expect(FIND_SOURCE_TEST_DOI).toBe("10.1038/171737a0");
    const ok = (origin: string) => agent.get(origin).intercept({ path: () => true, method: () => true }).reply(200, (o) => (String(o.path).includes("arxiv") || origin.includes("arxiv") ? "<feed/>" : JSON.stringify({ results: [], papers: [], message: { items: [] } })), JSON_H);
    const plan: Array<["record" | "copies", string, string]> = [
      ["record", "crossref", "https://api.crossref.org"],
      ["record", "openalex", "https://api.openalex.org"],
      ["record", "elicit", "https://elicit.com"],
      ["copies", "openalex", "https://api.openalex.org"],
      ["copies", "unpaywall", "https://api.unpaywall.org"],
      ["copies", "arxiv", "https://export.arxiv.org"],
      ["copies", "europepmc", "https://www.ebi.ac.uk"],
      ["copies", "semanticscholar", "https://api.semanticscholar.org"],
      ["copies", "doab", "https://directory.doabooks.org"],
      ["copies", "internetarchive", "https://archive.org"],
    ];
    for (const [group, id, origin] of plan) {
      requests = [];
      ok(origin);
      const r = await testSearchSource(group, id as never, { http: client(), key: id === "elicit" ? ELICIT_KEY : undefined, email: id === "unpaywall" ? UNPAYWALL_EMAIL : undefined });
      expect(r, `${group}/${id}`).toBe("answered");
      expect(requests, `${group}/${id}`).toHaveLength(1);
      const r0 = requests[0]!;
      expect(r0.origin).toBe(origin);
      const sent = decodeURIComponent(`${r0.path} ${r0.body ?? ""}`).replace(/\+/gu, " ");
      if (group === "record") expect(sent, id).toContain(FIND_SOURCE_TEST_WORDS);
      else expect(sent.includes(FIND_SOURCE_TEST_DOI) || /distinction/iu.test(sent), id).toBe(true);
      if (id === "elicit") expect(JSON.parse(r0.body!)).toEqual({ query: FIND_SOURCE_TEST_WORDS, maxResults: 10 });
    }
  });

  it("says when a service could not be reached, and when it did not accept the key", async () => {
    agent.get("https://api.crossref.org").intercept({ path: () => true, method: "GET" }).reply(503, "down");
    expect(await testSearchSource("record", "crossref", { http: client() })).toBe("unreachable");
    agent.get("https://api.crossref.org").intercept({ path: () => true, method: "GET" }).replyWithError(new Error("no route"));
    expect(await testSearchSource("record", "crossref", { http: client() })).toBe("unreachable");
    agent.get("https://api.crossref.org").intercept({ path: () => true, method: "GET" }).reply(200, "<html>a portal</html>");
    expect(await testSearchSource("record", "crossref", { http: client() })).toBe("unreachable");
    agent.get("https://api.openalex.org").intercept({ path: () => true, method: "GET" }).reply(401, "no");
    expect(await testSearchSource("record", "openalex", { http: client({ keyFor: (h) => (h === "api.openalex.org" ? OA_KEY : undefined) }) })).toBe("key-refused");
    // Without a key, a 401 is just a service that could not be had.
    agent.get("https://api.openalex.org").intercept({ path: () => true, method: "GET" }).reply(401, "no");
    expect(await testSearchSource("record", "openalex", { http: client() })).toBe("unreachable");
    agent.get("https://elicit.com").intercept({ path: () => true, method: "POST" }).reply(401, "no");
    expect(await testSearchSource("record", "elicit", { http: client(), key: ELICIT_KEY })).toBe("key-refused");
    agent.get("https://elicit.com").intercept({ path: () => true, method: "POST" }).reply(400, JSON.stringify({ error: "maxResults exceeds your plan's limit" }));
    expect(await testSearchSource("record", "elicit", { http: client(), key: ELICIT_KEY })).toBe("plan-cap");
  });

  it("R298 c: a Test of Elicit during its five-minute pause asks nothing and says the pause", async () => {
    agent.get("https://elicit.com").intercept({ path: () => true, method: "POST" }).reply(429, "slow down");
    expect(await testSearchSource("record", "elicit", { http: client(), key: ELICIT_KEY })).toBe("unreachable");
    requests = [];
    expect(await testSearchSource("record", "elicit", { http: client(), key: ELICIT_KEY })).toBe("paused");
    expect(requests).toEqual([]);
  });

  it("a test without the key or the e-mail it needs asks nothing", async () => {
    expect(await testSearchSource("record", "elicit", { http: client() })).toBe("needs-key");
    expect(await testSearchSource("copies", "unpaywall", { http: client() })).toBe("needs-email");
    expect(requests).toEqual([]);
  });

  it("is bounded in time", async () => {
    agent.get("https://api.crossref.org").intercept({ path: () => true, method: "GET" }).reply(200, "{}", JSON_H).delay(2_000);
    const t0 = Date.now();
    expect(await testSearchSource("record", "crossref", { http: client(), timeoutMs: 100 })).toBe("unreachable");
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
});
