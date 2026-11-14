/**
 * Task F12 (R290 a, c, h): Elicit's paper search as one more source, and the reach of the keys.
 *
 * Elicit is asked only when it is on, a key is stored and the project's rules allow it; it receives the typed words
 * and nothing else; its answer is bounded and untrusted; any failure of it never fails or delays a search beyond its
 * own time limit; a 429 stops it for five minutes in this process; a candidate only Elicit gave is never sure.
 * OpenAlex's key goes to api.openalex.org only (a search, a people lookup, a works lookup, a single work and a
 * free-copy lookup), Elicit's to elicit.com only; the OpenAlex pause is kept per key. Nothing reaches the network: an
 * undici MockAgent (disableNetConnect) composed with a recorder. Elicit's answer shape is the plan's, in a fixture
 * built by hand (`elicit-search-handbuilt.json`): UNVERIFIED against the live service.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LookupContext } from "../lookup/context.js";
import { HttpClient } from "../lookup/http.js";
import { ELICIT_MAX_RESULTS, ELICIT_PAUSE_MS, ELICIT_URL, _resetElicitForTests, elicitPausedUntil, elicitSearch } from "./elicit.js";
import { findFreeCopies } from "./free-copy.js";
import { fetchWork, searchPeople, worksOf } from "./people.js";
import { parseReference, type Reference } from "./reference.js";
import { decideMatch, openAlexSearchPaused, openAlexSearchPausedUntil, searchWorks } from "./search.js";
import { testSearchSource } from "./settings.js";
import { DEFAULT_SEARCH_SETTINGS } from "./types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/find");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const OA_KEY = "oakey-RECOGNISABLE-7f3a9c";
const ELICIT_KEY = "elk-RECOGNISABLE-55e1b0";
const EMAIL = "test-only@example.invalid";
const JSON_H = { headers: { "content-type": "application/json" } };
const LINE = "Bourdieu, Distinction 1984";

let tmp: string;
let agent: MockAgent;
let dispatcher: Dispatcher;
let now: number;
let notes: string[];
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
  return new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher, clock: () => now, sleep: async (ms) => void (now += ms), maxRetries: 0, env: {}, ...extra });
}
function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}
function ctx(http: HttpClient = client(), providers: string[] = ["crossref", "openalex", "elicit"]): LookupContext {
  return { http, policy: policy(providers), projectId: "P-SECRET-PROJECT-ID", actor: "tester", clock: () => new Date(now), debug: (n) => notes.push(n), sensitive: false };
}
const ref = (line: string): Reference => parseReference(line)!;
const elicitReply = (status: number, body: string, times = 1) => agent.get("https://elicit.com").intercept({ path: "/api/v2/search/papers", method: "POST" }).reply(status, body, JSON_H).times(times);
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-elicit-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  dispatcher = agent.compose(recorder);
  now = Date.parse("2026-11-14T10:00:00Z");
  notes = [];
  requests = [];
  _resetElicitForTests();
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

function everythingOf(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let d = 0; cur && d < 5; d++) {
    if (cur instanceof Error) parts.push(cur.message, String(cur.stack ?? ""));
    parts.push(JSON.stringify(cur, Object.getOwnPropertyNames(cur as object)) ?? "", inspect(cur, { showHidden: true, depth: 5 }));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

describe("elicitSearch", () => {
  it("off by default", () => {
    expect(DEFAULT_SEARCH_SETTINGS.record.find((s) => s.id === "elicit")).toEqual({ id: "elicit", on: false });
  });

  it("Elicit receives only the typed words: the body is the typed text and maxResults 10, the key in the header, no e-mail, no project", async () => {
    elicitReply(200, fixture("elicit-search-handbuilt.json"));
    const http = client({ contactEmailFor: () => EMAIL, keyFor: () => OA_KEY });
    const got = await elicitSearch(ref(LINE), ELICIT_KEY, ctx(http));
    expect(got.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(`${r.origin}${r.path}`).toBe(ELICIT_URL);
    expect(r.method).toBe("POST");
    expect(JSON.parse(r.body!)).toEqual({ query: LINE, maxResults: ELICIT_MAX_RESULTS });
    expect(Object.keys(JSON.parse(r.body!))).toEqual(["query", "maxResults"]);
    expect(ELICIT_MAX_RESULTS).toBe(10);
    expect(r.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
    const all = JSON.stringify(r);
    for (const no of [EMAIL, OA_KEY, "P-SECRET-PROJECT-ID", "tester"]) expect(all).not.toContain(no);
  });

  it("maps title, authors, year, DOI and venue to candidates with the provider elicit; the full-text address is not kept", async () => {
    elicitReply(200, fixture("elicit-search-handbuilt.json"));
    const got = await elicitSearch(ref(LINE), ELICIT_KEY, ctx());
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({
      title: "Distinction: A Social Critique of the Judgement of Taste",
      creators: [{ given: "Pierre", family: "Bourdieu", role: "author" }],
      issued: "1984",
      container: "Fixture University Press",
      identifiers: { doi: "10.5555/ao.find.distinction.1984" },
      providers: ["elicit"],
    });
    expect(got[2]).toMatchObject({ creators: [{ given: "Ottoline", family: "Mirabel", role: "author" }], issued: "2019", identifiers: {} });
    expect(JSON.stringify(got)).not.toMatch(/elicit-fulltext|abstract/u);
  });

  it("a hostile or malformed answer gives no candidates and a debug note; strings are cut and at most 10 papers read", async () => {
    for (const bad of ["not json", JSON.stringify({ papers: "x" }), JSON.stringify([1, 2]), JSON.stringify({ nothing: [] })]) {
      notes = [];
      elicitReply(200, bad);
      expect(await elicitSearch(ref(LINE), ELICIT_KEY, ctx()), bad).toEqual([]);
      expect(notes.join(" "), bad).toMatch(/elicit/u);
      expect(notes.join(" ")).not.toContain(ELICIT_KEY);
    }
    const many = { papers: Array.from({ length: 20 }, (_, i) => ({ title: `${"Long ".repeat(500)}${i}`, authors: Array.from({ length: 120 }, () => "A".repeat(1500)), year: 2000, doi: `10.5555/x.${i}` })) };
    elicitReply(200, JSON.stringify(many));
    const got = await elicitSearch(ref(LINE), ELICIT_KEY, ctx());
    expect(got.length).toBeLessThanOrEqual(10);
    for (const c of got) {
      expect(c.title.length).toBeLessThanOrEqual(1000);
      expect(c.creators.length).toBeLessThanOrEqual(100);
      for (const p of c.creators) expect((p.family ?? p.literal ?? "").length).toBeLessThanOrEqual(200);
    }
  });

  it("a 401, a 400 (the plan's cap), a 5xx, a timeout: no candidates, never an exception, and no note carries the key", async () => {
    for (const [status, body] of [
      [401, "unauthorised"],
      [400, JSON.stringify({ error: "maxResults exceeds the limit of your plan" })],
      [500, "oops"],
    ] as const) {
      elicitReply(status, body);
      await expect(elicitSearch(ref(LINE), ELICIT_KEY, ctx())).resolves.toEqual([]);
    }
    elicitReply(200, "{}").delay(2_000);
    const t0 = Date.now();
    await expect(elicitSearch(ref(LINE), ELICIT_KEY, ctx(), { timeoutMs: 100 })).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(notes.join("\n")).not.toContain(ELICIT_KEY);
  });

  it("a 429 stops Elicit for 5 minutes", async () => {
    elicitReply(429, "slow down");
    expect(await elicitSearch(ref(LINE), ELICIT_KEY, ctx())).toEqual([]);
    expect(elicitPausedUntil(now)).toBe(now + ELICIT_PAUSE_MS);
    expect(ELICIT_PAUSE_MS).toBe(300_000);
    requests = [];
    now += ELICIT_PAUSE_MS - 1_000;
    expect(await elicitSearch(ref(LINE), ELICIT_KEY, ctx())).toEqual([]);
    expect(requests).toHaveLength(0);
    now += 2_000;
    elicitReply(200, JSON.stringify({ papers: [] }));
    await elicitSearch(ref(LINE), ELICIT_KEY, ctx());
    expect(requests).toHaveLength(1);
  });

  it("nothing is asked when the project's rules do not name Elicit", async () => {
    expect(await elicitSearch(ref(LINE), ELICIT_KEY, ctx(client(), ["crossref", "openalex"]))).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/elicit/u);
  });

  it("is never disk-cached", async () => {
    elicitReply(200, fixture("elicit-search-handbuilt.json"), 2);
    await elicitSearch(ref(LINE), ELICIT_KEY, ctx());
    await elicitSearch(ref(LINE), ELICIT_KEY, ctx());
    expect(requests).toHaveLength(2);
    expect(await readdir(join(tmp, "Lib", ".cache", "lookups")).catch(() => [])).toEqual([]);
  });
});

describe("Elicit in the search", () => {
  const crPath = (text: string) => `/works?query.bibliographic=${enc(text)}&rows=5&select=DOI,title,subtitle,author,editor,issued,type,container-title,publisher,ISBN`;

  it("its candidates join the others through the merge; a candidate only Elicit gave is offered, never sure (decideMatch unchanged)", async () => {
    agent.get("https://api.crossref.org").intercept({ path: crPath(LINE), method: "GET" }).reply(200, fixture("crossref-empty.json"), JSON_H);
    elicitReply(200, fixture("elicit-search-handbuilt.json"));
    const r = await searchWorks(ref(LINE), ctx(), { sources: ["crossref", "elicit"], elicitKey: ELICIT_KEY });
    expect(r.notes).toEqual([]);
    expect(r.candidates.length).toBe(3);
    expect(r.candidates.every((c) => c.providers.join() === "elicit")).toBe(true);
    // The Elicit candidate fits the typed line perfectly; still only offered.
    const d = decideMatch(ref(LINE), r.candidates);
    expect(d.kind).toBe("choose");
  });

  it("the same work from Crossref and Elicit is one candidate with both providers; Crossref's values win", async () => {
    agent.get("https://api.crossref.org").intercept({ path: crPath(LINE), method: "GET" }).reply(200, fixture("crossref-distinction.json"), JSON_H);
    elicitReply(200, fixture("elicit-search-handbuilt.json"));
    const r = await searchWorks(ref(LINE), ctx(), { sources: ["crossref", "elicit"], elicitKey: ELICIT_KEY });
    const d = r.candidates.find((c) => c.identifiers.doi === "10.5555/ao.find.distinction.1984")!;
    expect(d.providers).toEqual(["crossref", "elicit"]);
    expect(d.type).toBe("book");
  });

  // R298 a (the review's I1): Elicit never supplies or replaces a field of a candidate that Crossref or OpenAlex gave;
  // it only adds its name to the candidate's providers, whatever the order of the sources.
  const TYPED = "Okafor, Upland Taste and Standing 2019";
  const crossrefSays = (items: unknown[]) => agent.get("https://api.crossref.org").intercept({ path: () => true, method: "GET" }).reply(200, JSON.stringify({ status: "ok", message: { items } }), JSON_H).persist();
  const openAlexSays = (results: unknown[]) => agent.get("https://api.openalex.org").intercept({ path: () => true, method: "GET" }).reply(200, JSON.stringify({ meta: { count: results.length }, results }), JSON_H).persist();
  const elicitSays = (papers: unknown[]) => agent.get("https://elicit.com").intercept({ path: "/api/v2/search/papers", method: "POST" }).reply(200, JSON.stringify({ papers }), JSON_H).persist();
  /** The candidates and the decision without Elicit, then with it (each through a fresh client: nothing cached). */
  async function withAndWithout(sources: Array<"crossref" | "openalex" | "elicit">) {
    const without = await searchWorks(ref(TYPED), ctx(client()), { sources: sources.filter((s) => s !== "elicit") });
    const withE = await searchWorks(ref(TYPED), ctx(client()), { sources, elicitKey: ELICIT_KEY });
    return { without, withE, dWithout: decideMatch(ref(TYPED), without.candidates), dWith: decideMatch(ref(TYPED), withE.candidates) };
  }

  it("R298 a, the review's probe 1: Crossref lacks the author and Elicit gives one: the decision is what it is without Elicit, and the author stays absent", async () => {
    crossrefSays([{ DOI: "10.5555/x.2", type: "journal-article", title: ["Upland Taste and Standing"], issued: { "date-parts": [[2019]] } }]);
    elicitSays([{ title: "Taste in the Uplands", authors: ["Amara Okafor"], year: 2019, doi: "10.5555/x.2", venue: "Invented Review" }]);
    const { withE, dWithout, dWith } = await withAndWithout(["crossref", "elicit"]);
    expect(dWithout.kind).toBe("choose");
    expect(dWith.kind).toBe(dWithout.kind);
    const c = withE.candidates.find((x) => x.identifiers.doi === "10.5555/x.2")!;
    expect(c.providers).toEqual(["crossref", "elicit"]);
    expect(c.creators).toEqual([]);
    expect(c.title).toBe("Upland Taste and Standing");
    expect(c.container).toBeUndefined();
  });

  it("R298 a, the review's probe 2: Elicit stored first, the same DOI with another title and type: Crossref's fields, the decision as without Elicit", async () => {
    crossrefSays([{ DOI: "10.5555/x.1", type: "book", title: ["A Completely Different Book on Pottery"], author: [{ given: "Amara", family: "Okafor" }], issued: { "date-parts": [[2019]] } }]);
    elicitSays([{ title: "Upland Taste and Standing", authors: ["Amara Okafor"], year: 2019, doi: "10.5555/x.1", venue: "Invented Review" }]);
    const { without, withE, dWithout, dWith } = await withAndWithout(["elicit", "crossref"]);
    expect(dWith.kind).toBe(dWithout.kind);
    expect(dWith.kind).not.toBe("sure");
    expect(withE.candidates).toHaveLength(1);
    const c = withE.candidates[0]!;
    const { providers, ...fields } = c;
    const { providers: p0, ...fields0 } = without.candidates[0]!;
    expect(p0).toEqual(["crossref"]);
    expect(providers).toEqual(["crossref", "elicit"]);
    expect(fields).toEqual(fields0);
    expect(c.title).toBe("A Completely Different Book on Pottery");
    expect(c.type).toBe("book");
  });

  it("R298 a: a field Crossref or OpenAlex did not give stays absent: creators, date, type, container, publisher, DOI (in either order)", async () => {
    // Crossref: a title and a DOI only (no type: "other"). OpenAlex: the same title, first family and year, no DOI.
    crossrefSays([{ DOI: "10.5555/x.3", title: ["Upland Taste and Standing"] }]);
    openAlexSays([{ id: "https://openalex.org/W77", display_name: "Upland Taste and Standing", publication_year: 2019, type: "article", authorships: [{ author: { display_name: "Amara Okafor" } }] }]);
    for (const order of [["elicit", "crossref", "openalex"], ["crossref", "openalex", "elicit"], ["openalex", "elicit", "crossref"]] as const) {
      agent.get("https://elicit.com").intercept({ path: "/api/v2/search/papers", method: "POST" }).reply(200, JSON.stringify({
        papers: [
          { title: "Upland Taste and Standing", authors: ["Zed Nobody"], year: 1901, doi: "10.5555/x.3", venue: "Invented Review" },
          { title: "Upland Taste and Standing", authors: ["Amara Okafor"], year: 2019, doi: "10.5555/elicit.only", venue: "Elicit Venue" },
        ],
      }), JSON_H);
      _resetElicitForTests();
      const without = await searchWorks(ref(TYPED), ctx(client()), { sources: order.filter((s) => s !== "elicit") });
      const withE = await searchWorks(ref(TYPED), ctx(client()), { sources: [...order], elicitKey: ELICIT_KEY });
      const cr = withE.candidates.find((x) => x.identifiers.doi === "10.5555/x.3")!;
      const cr0 = without.candidates.find((x) => x.identifiers.doi === "10.5555/x.3")!;
      expect(cr.providers, order.join()).toEqual([...cr0.providers, "elicit"]);
      expect({ ...cr, providers: [] }, order.join()).toEqual({ ...cr0, providers: [] });
      expect(cr.creators).toEqual([]);
      expect(cr.issued).toBeUndefined();
      expect(cr.type).toBe("other");
      expect(cr.container).toBeUndefined();
      expect(cr.publisher).toBeUndefined();
      // OpenAlex's candidate (no DOI) met Elicit's by title, first family and year: it does not take Elicit's DOI.
      const oa = withE.candidates.find((x) => x.providers.includes("openalex"))!;
      const oa0 = without.candidates.find((x) => x.providers.includes("openalex"))!;
      expect(oa.identifiers, order.join()).toEqual(oa0.identifiers);
      expect(oa.identifiers.doi).toBeUndefined();
      expect(oa.providers).toEqual([...oa0.providers, "elicit"]);
      expect({ ...oa, providers: [] }).toEqual({ ...oa0, providers: [] });
      // No decision is moved by Elicit.
      expect(decideMatch(ref(TYPED), withE.candidates).kind, order.join()).toBe(decideMatch(ref(TYPED), without.candidates).kind);
    }
  });

  it("R298 a: an Elicit-only candidate beside the others' is still offered with Elicit's fields, and never sure", async () => {
    crossrefSays([{ DOI: "10.5555/x.4", type: "book", title: ["Something Else Entirely"], author: [{ family: "Brackwater" }], issued: { "date-parts": [[1950]] } }]);
    elicitSays([{ title: "Upland Taste and Standing", authors: ["Amara Okafor"], year: 2019, doi: "10.5555/x.5", venue: "Invented Review" }]);
    const r = await searchWorks(ref(TYPED), ctx(), { sources: ["elicit", "crossref"], elicitKey: ELICIT_KEY });
    const e = r.candidates.find((x) => x.identifiers.doi === "10.5555/x.5")!;
    expect(e.providers).toEqual(["elicit"]);
    expect(e.title).toBe("Upland Taste and Standing");
    expect(e.creators.map((x) => x.family)).toEqual(["Okafor"]);
    expect(e.container).toBe("Invented Review");
    expect(decideMatch(ref(TYPED), r.candidates).kind).toBe("choose");
  });

  it("Elicit is never asked without a key, and the order of the sources is the settings' order", async () => {
    agent.get("https://api.crossref.org").intercept({ path: crPath(LINE), method: "GET" }).reply(200, fixture("crossref-empty.json"), JSON_H);
    const r = await searchWorks(ref(LINE), ctx(), { sources: ["elicit", "crossref"] });
    expect(r.candidates).toEqual([]);
    expect(requests.map((x) => x.origin)).toEqual(["https://api.crossref.org"]);
  });

  it("Elicit failing never fails or delays the search beyond its own time limit: the others' answers stand, with no failure note", async () => {
    agent.get("https://api.crossref.org").intercept({ path: crPath(LINE), method: "GET" }).reply(200, fixture("crossref-distinction.json"), JSON_H);
    elicitReply(200, "{}").delay(3_000);
    const t0 = Date.now();
    const r = await searchWorks(ref(LINE), ctx(), { sources: ["crossref", "elicit"], elicitKey: ELICIT_KEY, elicitTimeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.notes).toEqual(["elicit-failed"]);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(decideMatch(ref(LINE), r.candidates).kind).toBe("sure");
    for (const status of [401, 400, 429, 503]) {
      _resetElicitForTests();
      agent.get("https://api.crossref.org").intercept({ path: crPath(LINE), method: "GET" }).reply(200, fixture("crossref-distinction.json"), JSON_H);
      elicitReply(status, "no");
      const again = await searchWorks(ref(LINE), ctx(client()), { sources: ["crossref", "elicit"], elicitKey: ELICIT_KEY });
      expect(again.candidates.map((c) => c.id), String(status)).toEqual(r.candidates.map((c) => c.id));
      expect(again.notes).toEqual(["elicit-failed"]);
    }
  });
});

describe("the keys' reach (R290 a): over every request a search, a people lookup, a works lookup, a free-copy lookup and a Test make", () => {
  it("OpenAlex's key only on requests to api.openalex.org, only in the Authorization header; Elicit's only to elicit.com; never in an address", async () => {
    const json = (origin: string, body: unknown) => agent.get(origin).intercept({ path: () => true, method: () => true }).reply(200, JSON.stringify(body), JSON_H).persist();
    json("https://api.crossref.org", { message: { items: [] } });
    json("https://api.openalex.org", { meta: { count: 0 }, results: [] });
    json("https://elicit.com", { papers: [] });
    json("https://api.unpaywall.org", { is_oa: false });
    json("https://www.ebi.ac.uk", { resultList: { result: [] } });
    json("https://api.semanticscholar.org", { openAccessPdf: null });
    json("https://directory.doabooks.org", []);
    json("https://archive.org", { response: { docs: [] } });
    agent.get("https://export.arxiv.org").intercept({ path: () => true, method: "GET" }).reply(200, "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>").persist();
    const http = client({ keyFor: (h) => (h === "api.openalex.org" ? OA_KEY : undefined), contactEmailFor: (h) => (h === "api.crossref.org" ? "crossref-only@example.invalid" : undefined) });
    const c = ctx(http);
    await searchWorks(ref(LINE), c, { sources: ["crossref", "openalex", "elicit"], elicitKey: ELICIT_KEY });
    await searchPeople(ref("Arlie Hochschild"), c).catch(() => undefined);
    await worksOf("A123456", c).catch(() => undefined);
    await fetchWork("W123456", c).catch(() => undefined);
    const work = { id: "w1", title: "A Made-up Book", creators: [{ family: "Quill", role: "author" as const }], type: "book" as const, identifiers: { doi: "10.5555/made.up" }, providers: ["crossref"] };
    await findFreeCopies(work, c, ["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"], EMAIL);
    for (const [group, id] of [["record", "crossref"], ["record", "openalex"], ["record", "elicit"], ["copies", "openalex"], ["copies", "unpaywall"], ["copies", "arxiv"]] as const) {
      await testSearchSource(group, id, { http, key: id === "elicit" ? ELICIT_KEY : undefined, email: EMAIL });
    }
    const origins = new Set(requests.map((r) => r.origin));
    for (const o of ["https://api.crossref.org", "https://api.openalex.org", "https://elicit.com", "https://api.unpaywall.org", "https://export.arxiv.org", "https://www.ebi.ac.uk", "https://api.semanticscholar.org", "https://directory.doabooks.org", "https://archive.org"]) expect(origins, o).toContain(o);
    for (const r of requests) {
      expect(r.path, r.path).not.toContain(OA_KEY);
      expect(r.path).not.toContain(ELICIT_KEY);
      const others = JSON.stringify({ ...r, headers: { ...r.headers, authorization: undefined } });
      expect(others).not.toContain(OA_KEY);
      expect(others).not.toContain(ELICIT_KEY);
      if (r.origin === "https://api.openalex.org") expect(r.headers.authorization, r.path).toBe(`Bearer ${OA_KEY}`);
      else if (r.origin === "https://elicit.com") expect(r.headers.authorization).toBe(`Bearer ${ELICIT_KEY}`);
      else expect(r.headers.authorization, r.origin).toBeUndefined();
    }
    // And nothing cached holds either key.
    const dir = join(tmp, "Lib", ".cache", "lookups");
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const text = await readFile(join(dir, f), "utf8");
      expect(text).not.toContain(OA_KEY);
      expect(text).not.toContain(ELICIT_KEY);
    }
    expect(notes.join("\n")).not.toContain(OA_KEY);
    expect(notes.join("\n")).not.toContain(ELICIT_KEY);
  });

  it("a pause for 'no key' is lifted by a key; a pause that belongs to a key stays with that key", async () => {
    let key: string | undefined;
    const http = client({ keyFor: (h) => (h === "api.openalex.org" ? key : undefined) });
    const oaPath = (t: string) => `/works?search=${enc(t)}&per-page=5`;
    agent.get("https://api.openalex.org").intercept({ path: oaPath(LINE), method: "GET" }).reply(429, fixture("openalex-budget-429.json"), { headers: { "x-ratelimit-remaining": "0" } });
    const r1 = await searchWorks(ref(LINE), ctx(http), { sources: ["openalex"] });
    expect(r1.notes).toEqual(["openalex-budget"]);
    expect(openAlexSearchPaused(ctx(http))).toBe(true);
    expect(openAlexSearchPausedUntil(http)).toBeDefined();
    // A key is added: the pause that belonged to "no key" does not hold for it.
    key = OA_KEY;
    expect(openAlexSearchPaused(ctx(http))).toBe(false);
    expect(openAlexSearchPausedUntil(http)).toBeUndefined();
    agent.get("https://api.openalex.org").intercept({ path: oaPath(LINE), method: "GET" }).reply(429, fixture("openalex-budget-429.json"), { headers: { "x-ratelimit-remaining": "0" } });
    const r2 = await searchWorks(ref(LINE), ctx(http), { sources: ["openalex"] });
    expect(r2.notes).toEqual(["openalex-budget"]);
    // Changed again: lifted; back to the first key: still paused.
    key = "second-key-1234";
    expect(openAlexSearchPaused(ctx(http))).toBe(false);
    key = OA_KEY;
    expect(openAlexSearchPaused(ctx(http))).toBe(true);
    expect(everythingOf(openAlexSearchPausedUntil(http))).not.toContain(OA_KEY);
  });
});
