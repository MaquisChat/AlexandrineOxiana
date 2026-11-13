import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { Agent, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONCURRENCY, HttpClient, USER_AGENT } from "../lookup/http.js";
import type { LookupContext } from "../lookup/context.js";
import type { WorkCandidate } from "./candidates.js";
import { parseReference, type Reference } from "./reference.js";
import {
  FIND_MAX_CANDIDATES,
  decideMatch,
  openAlexSearchPausedUntil,
  scoreCandidate,
  searchWorks,
  type SearchNote,
} from "./search.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/find");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const SELECT = "DOI,title,subtitle,author,editor,issued,type,container-title,publisher,ISBN";

const crPath = (text: string) => `/works?query.bibliographic=${encodeURIComponent(text)}&rows=5&select=${SELECT}`;
const oaPath = (text: string) => `/works?search=${encodeURIComponent(text)}&per-page=5`;

let tmp: string;
let agent: MockAgent;
let now: number;
let sleeps: number[];
let notes: string[];
let seen: Array<{ origin: string; path: string; headers: Record<string, string> }>;

const sleep = async (ms: number) => {
  sleeps.push(ms);
  now += ms;
};

function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, clock: () => now, sleep, env: {}, ...extra });
}

function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}

function ctx(http: HttpClient, providers: string[] | null = ["crossref", "openalex"]): LookupContext {
  return {
    http,
    policy: providers ? policy(providers) : null,
    projectId: "P1",
    actor: "tester",
    clock: () => new Date(now),
    debug: (n) => notes.push(n),
    sensitive: false,
  };
}

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

/** Answers `path` on `origin` with `body` and records what was sent. */
function answer(origin: string, path: string, body: string, status = 200, headers: Record<string, string> = {}) {
  agent
    .get(origin)
    .intercept({ path, method: "GET" })
    .reply((opts) => {
      seen.push({ origin, path: opts.path, headers: headersOf(opts.headers) });
      return { statusCode: status, data: body, responseOptions: { headers: { "content-type": "application/json", ...headers } } };
    });
}
const crossref = (text: string, file: string) => answer("https://api.crossref.org", crPath(text), fixture(file));
const openalex = (text: string, file: string) => answer("https://api.openalex.org", oaPath(text), fixture(file));

function ref(line: string): Reference {
  const r = parseReference(line);
  if (!r) throw new Error(`not a reference: ${line}`);
  return r;
}

async function search(line: string, c: LookupContext, sources: ("crossref" | "openalex")[] = ["crossref", "openalex"]) {
  return searchWorks(ref(line), c, { sources });
}

function cand(over: Partial<WorkCandidate> & { title: string }): WorkCandidate {
  return {
    id: over.id ?? `w-${over.title}`,
    creators: [{ given: "Pierre", family: "Bourdieu", role: "author" }],
    issued: "1984",
    type: "book",
    identifiers: {},
    providers: ["crossref"],
    ...over,
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-search-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  now = Date.parse("2026-11-13T10:00:00Z");
  sleeps = [];
  notes = [];
  seen = [];
});

afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("searchWorks and decideMatch (the confidence rule)", () => {
  it("Bourdieu, Distinction is sure when one book matches", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const r = ref("Bourdieu, Distinction");
    const { candidates, notes: n } = await searchWorks(r, ctx(client()), { sources: ["crossref", "openalex"] });
    expect(n).toEqual([]);
    agent.assertNoPendingInterceptors();
    // The book came from both services (one in upper case): one candidate, both providers, first.
    const book = candidates[0]!;
    expect(book.title).toBe("Distinction: A Social Critique of the Judgement of Taste");
    expect(book.identifiers).toEqual({ doi: "10.5555/ao.find.distinction.1984", isbn: ["9780000000002"] });
    expect(book.providers).toEqual(["crossref", "openalex"]);
    expect(book.type).toBe("book");
    expect(book.issued).toBe("1984");
    expect(book.creators).toEqual([{ given: "Pierre", family: "Bourdieu", role: "author" }]);
    expect(candidates.filter((c) => c.identifiers.doi === "10.5555/ao.find.distinction.1984")).toHaveLength(1);
    expect(candidates).toHaveLength(4);
    expect(decideMatch(r, candidates)).toEqual({ kind: "sure", id: book.id });
    expect(scoreCandidate(r, book)).toEqual({ score: 1, titleCover: 1, creator: true, year: true });
  });

  it("two editions of Distinction with different ISBNs are never sure: the entry is Choose", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction-editions.json");
    openalex("Bourdieu, Distinction", "openalex-empty.json");
    const r = ref("Bourdieu, Distinction");
    const { candidates } = await search("Bourdieu, Distinction", ctx(client()));
    expect(candidates).toHaveLength(2);
    const d = decideMatch(r, candidates);
    expect(d.kind).toBe("choose");
    expect(d.kind === "choose" && [...d.ids].sort()).toEqual(candidates.map((c) => c.id).sort());
    // With a year typed that fits only one edition, the other is still offered: never sure.
    expect(decideMatch(ref("Bourdieu, Distinction 1984"), candidates).kind).toBe("choose");
  });

  it("a book and its translation (same title, different ISBNs, no DOI) are never sure", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction-translation.json");
    openalex("Bourdieu, Distinction", "openalex-empty.json");
    const { candidates } = await search("Bourdieu, Distinction", ctx(client()));
    expect(candidates).toHaveLength(2);
    expect(decideMatch(ref("Bourdieu, Distinction"), candidates).kind).toBe("choose");
    // The original and the translation under different titles: the typed words decide only when
    // they name one title; typing the French title with "la" leaves both close, so it asks.
    const fr = cand({ id: "fr", title: "La Distinction: critique sociale du jugement", identifiers: { isbn: ["9780000000033"] }, issued: "1979" });
    const en = cand({ id: "en", title: "Distinction: A Social Critique of the Judgement of Taste", identifiers: { isbn: ["9780000000002"] } });
    expect(decideMatch(ref("Bourdieu, La Distinction"), [fr, en])).toEqual({ kind: "choose", ids: ["fr", "en"] });
  });

  it("a preprint and its article with different DOIs are offered both", async () => {
    crossref("Okafor, Rivers and Memory in Upland Villages", "crossref-preprint-article.json");
    openalex("Okafor, Rivers and Memory in Upland Villages", "openalex-empty.json");
    const r = ref("Okafor, Rivers and Memory in Upland Villages");
    const { candidates } = await search("Okafor, Rivers and Memory in Upland Villages", ctx(client()));
    expect(candidates.map((c) => c.identifiers.doi)).toEqual(["10.5555/ao.find.rivers.2021", "10.5555/ao.find.rivers.preprint.2020"]);
    const d = decideMatch(r, candidates);
    expect(d).toEqual({ kind: "choose", ids: candidates.map((c) => c.id) });
    // Even with the article's year typed, the preprint (one year off) keeps it a choice.
    expect(decideMatch(ref("Okafor 2021 Rivers and Memory in Upland Villages"), candidates).kind).toBe("choose");
  });

  it("a same-titled work by a different author keeps it a choice", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction-other-author.json");
    openalex("Bourdieu, Distinction", "openalex-empty.json");
    const r = ref("Bourdieu, Distinction");
    const { candidates } = await search("Bourdieu, Distinction", ctx(client()));
    expect(candidates).toHaveLength(2);
    const d = decideMatch(r, candidates);
    expect(d.kind).toBe("choose");
    // Bourdieu's first, the other author's after.
    expect(d.kind === "choose" && d.ids[0]).toBe(candidates.find((c) => c.creators[0]?.family === "Bourdieu")!.id);
    expect(scoreCandidate(r, candidates.find((c) => c.creators[0]?.family === "Lindqvist")!)).toEqual({ score: 0.7, titleCover: 1, creator: false, year: true });
  });

  it("a one-word title with no author typed is never sure", async () => {
    crossref("Distinction", "crossref-distinction.json");
    openalex("Distinction", "openalex-empty.json");
    const { candidates } = await search("Distinction", ctx(client()));
    expect(decideMatch(ref("Distinction"), candidates).kind).toBe("choose");
  });

  it("two unexplained words make it Choose", () => {
    const book = cand({ id: "b", title: "Distinction", identifiers: { doi: "10.5555/x" } });
    expect(decideMatch(ref("Bourdieu, Distinction, Minuit"), [book])).toEqual({ kind: "sure", id: "b" }); // one is allowed
    expect(decideMatch(ref("Bourdieu, Distinction, Paris Minuit"), [book])).toEqual({ kind: "choose", ids: ["b"] });
    // The listed small words, a year and the creators' given names are explained.
    expect(decideMatch(ref("Pierre Bourdieu, and the Distinction by et al 1984"), [book]).kind).toBe("sure");
  });

  it("a typed year two years off is not sure; one year off is", () => {
    const book = cand({ id: "b", title: "Distinction", issued: "1984" });
    expect(decideMatch(ref("Bourdieu, Distinction 1986"), [book])).toEqual({ kind: "choose", ids: ["b"] });
    expect(decideMatch(ref("Bourdieu, Distinction 1982"), [book]).kind).toBe("choose");
    expect(decideMatch(ref("Bourdieu, Distinction 1985"), [book]).kind).toBe("sure");
    expect(decideMatch(ref("Bourdieu, Distinction 1983"), [book]).kind).toBe("sure");
    // A typed year and a candidate without a year: not matched.
    expect(decideMatch(ref("Bourdieu, Distinction 1984"), [cand({ id: "n", title: "Distinction", issued: undefined })]).kind).toBe("choose");
    expect(scoreCandidate(ref("Bourdieu, Distinction 1986"), book)).toEqual({ score: 0.9, titleCover: 1, creator: true, year: false });
  });

  it("the next best candidate must score at least 0.2 lower", () => {
    const a = cand({ id: "a", title: "Distinction", identifiers: { doi: "10.5555/a" } });
    // Shares no title word with a, so rule 5 does not apply; its score decides.
    const b = cand({ id: "b", title: "Distinction Taste Field Habitus Capital", identifiers: { doi: "10.5555/b" } });
    // b covers 1/5 of its title: 0.12 + 0.3 + 0.1 = 0.52; a scores 1.
    expect(decideMatch(ref("Bourdieu, Distinction"), [b, a])).toEqual({ kind: "sure", id: "a" });
    const c = cand({ id: "c", title: "Taste Distinction", identifiers: { doi: "10.5555/c" } });
    // c covers 1/2: 0.3 + 0.3 + 0.1 = 0.7 (0.3 lower): still sure; d covers 4/5 → 0.88: not.
    expect(decideMatch(ref("Bourdieu, Distinction"), [c, a]).kind).toBe("sure");
    const d = cand({ id: "d", title: "Distinction and Social Theory Today", identifiers: { doi: "10.5555/d" } });
    expect(decideMatch(ref("Bourdieu, Distinction social theory today"), [a, d]).kind).toBe("choose");
  });

  it("not found when no candidate scores 0.4", () => {
    const other = cand({ id: "o", title: "Rivers of Memory", creators: [{ given: "Joan", family: "Rivers", role: "author" }], issued: "1999" });
    expect(decideMatch(ref("Bourdieu, Distinction 1984"), [other])).toEqual({ kind: "none" });
    expect(decideMatch(ref("Bourdieu, Distinction"), [])).toEqual({ kind: "none" });
  });

  it("a family name that is also a title word is not counted twice", () => {
    // A work titled with the typed name, by someone of that name: the one word cannot be both.
    const w = cand({ id: "g", title: "Granovetter", creators: [{ given: "Ann", family: "Granovetter", role: "author" }], issued: "2001" });
    expect(scoreCandidate(ref("Granovetter"), w).creator).toBe(false);
    expect(decideMatch(ref("Granovetter"), [w]).kind).toBe("choose");
    // Typed twice (title and author) it can be both.
    expect(decideMatch(ref("Granovetter, Granovetter"), [w]).kind).toBe("sure");
    // A study about Bourdieu by someone else is not Bourdieu's.
    const about = cand({ id: "a", title: "Bourdieu", creators: [{ given: "Ann", family: "Fixture", role: "author" }] });
    expect(decideMatch(ref("Bourdieu"), [about]).kind).toBe("choose");
  });

  it("an empty or whitespace title never covers anything", () => {
    const blank = cand({ id: "e", title: "   " });
    const punct = cand({ id: "p", title: "?!—" });
    expect(scoreCandidate(ref("Bourdieu"), blank).titleCover).toBe(0);
    expect(scoreCandidate(ref("Bourdieu"), punct).titleCover).toBe(0);
    expect(decideMatch(ref("Bourdieu"), [blank, punct]).kind).not.toBe("sure");
  });

  it("an Elicit candidate alone is never sure; with another provider it can be", () => {
    const e = cand({ id: "e", title: "Distinction", providers: ["elicit"], identifiers: { doi: "10.5555/e" } });
    expect(decideMatch(ref("Bourdieu, Distinction"), [e])).toEqual({ kind: "choose", ids: ["e"] });
    expect(decideMatch(ref("Bourdieu, Distinction"), [{ ...e, providers: ["elicit", "crossref"] }])).toEqual({ kind: "sure", id: "e" });
  });

  it("diacritics and ligatures: Muller finds Müller, and field finds ﬁeld", async () => {
    crossref("Muller, Feldforschung im Gebirge", "crossref-diacritics.json");
    crossref("Okafor, Notes from the field", "crossref-diacritics.json");
    const c = ctx(client());
    const a = await search("Muller, Feldforschung im Gebirge", c, ["crossref"]);
    expect(decideMatch(ref("Muller, Feldforschung im Gebirge"), a.candidates)).toEqual({ kind: "sure", id: a.candidates.find((x) => x.creators[0]?.family === "Müller")!.id });
    const b = await search("Okafor, Notes from the field", c, ["crossref"]);
    const fieldNotes = b.candidates.find((x) => x.identifiers.doi === "10.5555/ao.find.fieldnotes.2004")!;
    expect(fieldNotes.title).toBe("Notes from the ﬁeld"); // kept as given: only the comparison folds it
    expect(decideMatch(ref("Okafor, Notes from the field"), b.candidates)).toEqual({ kind: "sure", id: fieldNotes.id });
  });

  it("a Japanese reference with or without spaces between the words", async () => {
    crossref("丸山眞男 日本の思想", "crossref-japanese.json");
    crossref("日本の思想丸山眞男", "crossref-japanese.json");
    const c = ctx(client());
    for (const line of ["丸山眞男 日本の思想", "日本の思想丸山眞男"]) {
      const { candidates } = await search(line, c, ["crossref"]);
      const nihon = candidates.find((x) => x.identifiers.doi === "10.5555/ao.find.nihon.1961")!;
      expect(decideMatch(ref(line), candidates)).toEqual({ kind: "sure", id: nihon.id });
    }
    // The author alone, or another title's words, are not enough.
    const { candidates } = await search("丸山眞男 日本の思想", c, ["crossref"]);
    expect(decideMatch(ref("丸山眞男"), candidates).kind).not.toBe("sure");
    expect(decideMatch(ref("丸山眞男 日本の政治思想史研究"), candidates).kind).not.toBe("sure");
  });
});

describe("what is sent, and to whom", () => {
  it("each service receives exactly the typed words, percent-encoded, and nothing else", async () => {
    const line = `"weak ties" Granovetter & co / 1973?#`;
    crossref(line, "crossref-weak-ties.json");
    openalex(line, "openalex-empty.json");
    await search(line, ctx(client()));
    expect(seen.map((s) => `${s.origin}${s.path}`)).toEqual([
      `https://api.crossref.org/works?query.bibliographic=%22weak%20ties%22%20Granovetter%20%26%20co%20%2F%201973%3F%23&rows=5&select=${SELECT}`,
      "https://api.openalex.org/works?search=%22weak%20ties%22%20Granovetter%20%26%20co%20%2F%201973%3F%23&per-page=5",
    ]);
    for (const s of seen) {
      expect(s.headers["user-agent"]).toBe(USER_AGENT);
      expect(s.headers["user-agent"]).not.toMatch(/mailto/u);
      expect(Object.keys(s.headers).sort()).toEqual(["accept", "user-agent"]);
    }
  });

  it("characters the URL parser would otherwise leave or change are percent-encoded too", async () => {
    const line = "Bourdieu's (Distinction)! *";
    answer("https://api.crossref.org", crPath(line), fixture("crossref-empty.json"));
    await search(line, ctx(client()), ["crossref"]);
    expect(seen[0]!.path).toBe(`/works?query.bibliographic=Bourdieu%27s%20%28Distinction%29%21%20%2A&rows=5&select=${SELECT}`);
  });

  it("a denied provider is not asked", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    const r = await search("Bourdieu, Distinction", ctx(client(), ["crossref"]));
    expect(seen.map((s) => s.origin)).toEqual(["https://api.crossref.org"]);
    expect(r.notes).toEqual([]);
    expect(r.candidates.every((c) => c.providers.join() === "crossref")).toBe(true);
    expect(notes.some((n) => n.includes("openalex skipped"))).toBe(true);

    // Every provider denied, or a policy that cannot be read: nothing is asked, no error.
    const none = await search("Bourdieu, Distinction", ctx(client(), []));
    const unreadable = await search("Bourdieu, Distinction", ctx(client(), null));
    expect(none).toEqual({ candidates: [], notes: [] });
    expect(unreadable).toEqual({ candidates: [], notes: [] });
    expect(seen).toHaveLength(1);
  });

  it("only the sources asked for are asked, each once", async () => {
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const r = await searchWorks(ref("Bourdieu, Distinction"), ctx(client()), { sources: ["openalex", "openalex"] });
    expect(seen.map((s) => s.origin)).toEqual(["https://api.openalex.org"]);
    expect(r.candidates[0]!.providers).toEqual(["openalex"]);
  });

  it("a line with no words to search sends nothing", async () => {
    const r = await search("?!", ctx(client()));
    expect(r).toEqual({ candidates: [], notes: [] });
    expect(seen).toEqual([]);
  });
});

describe("OpenAlex's daily allowance", () => {
  const budget429 = (headers: Record<string, string> = {}) =>
    answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), fixture("openalex-budget-429.json"), 429, headers);

  it("OpenAlex's daily budget 429 leaves Crossref only and notes it", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    budget429({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" });
    const http = client();
    const r = await search("Bourdieu, Distinction", ctx(http));
    expect(r.notes).toEqual(["openalex-budget"]);
    expect(r.candidates[0]!.providers).toEqual(["crossref"]);
    expect(decideMatch(ref("Bourdieu, Distinction"), r.candidates).kind).toBe("sure");
    // Not retried: one OpenAlex request, no back-off.
    expect(seen.filter((s) => s.origin === "https://api.openalex.org")).toHaveLength(1);
    expect(sleeps.filter((ms) => ms >= 500)).toEqual([]);
    expect(openAlexSearchPausedUntil(http)).toBe(now + 3_600_000);

    // The pause holds across calls for the life of the client: OpenAlex is not asked again.
    // (Crossref's answer now comes from the client's cache.)
    now += 1_800_000;
    const again = await search("Bourdieu, Distinction", ctx(http));
    expect(again.notes).toEqual(["openalex-budget"]);
    expect(seen.filter((s) => s.origin === "https://api.openalex.org")).toHaveLength(1);

    // After the reset it is asked again.
    now += 1_800_001;
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const later = await search("Bourdieu, Distinction", ctx(http));
    expect(later.notes).toEqual([]);
    expect(openAlexSearchPausedUntil(http)).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it("a budget 429 that names no reset pauses until 00:00 UTC; another client is not paused", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    budget429();
    const http = client();
    const r = await search("Bourdieu, Distinction", ctx(http));
    expect(r.notes).toEqual(["openalex-budget"]);
    expect(openAlexSearchPausedUntil(http)).toBe(Date.parse("2026-11-14T00:00:00Z"));
    expect(openAlexSearchPausedUntil(client())).toBeUndefined();
  });

  it("an absurd reset (in the past, or days away) falls back to 00:00 UTC", async () => {
    for (const reset of ["1000000000", "99999999", "not a time", "-5"]) {
      crossref("Bourdieu, Distinction", "crossref-distinction.json");
      answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), "{}", 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
      const http = client();
      await search("Bourdieu, Distinction", ctx(http));
      const until = openAlexSearchPausedUntil(http)!;
      expect(until).toBeGreaterThan(now);
      expect(until).toBeLessThanOrEqual(now + 48 * 3_600_000);
    }
  });

  it("an ordinary 429 is retried as before and pauses nothing", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), `{"error":"slow down"}`, 429, { "retry-after": "1", "x-ratelimit-remaining": "3" });
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const http = client();
    const r = await search("Bourdieu, Distinction", ctx(http));
    expect(r.notes).toEqual([]);
    expect(r.candidates[0]!.providers).toEqual(["crossref", "openalex"]);
    expect(sleeps).toContain(1000);
    expect(openAlexSearchPausedUntil(http)).toBeUndefined();
  });

  it("ordinary 429s that never stop give openalex-failed, not a pause", async () => {
    crossref("Bourdieu, Distinction", "crossref-distinction.json");
    for (let i = 0; i < 4; i++) answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), "{}", 429);
    const http = client();
    const r = await search("Bourdieu, Distinction", ctx(http));
    expect(r.notes).toEqual(["openalex-failed"]);
    expect(openAlexSearchPausedUntil(http)).toBeUndefined();
  });
});

describe("hostile and broken answers", () => {
  it("a response that is not JSON gives no candidates from it and a note, never an error", async () => {
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), "<html>maintenance</html>");
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(r.notes).toEqual(["crossref-failed"]);
    expect(r.candidates.every((c) => c.providers.join() === "openalex")).toBe(true);
    expect(notes.some((n) => n.startsWith("work search via crossref"))).toBe(true);
  });

  it("JSON of another shape gives no candidates and a note", async () => {
    for (const body of [`{"message":"x"}`, `[1,2,3]`, `null`, `{"message":{"items":{"0":{}}}}`, `{"message":{"items":[1,"x",null,[],{"title":7}]}}`]) {
      answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), body);
      answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), body);
      const r = await search("Bourdieu, Distinction", ctx(client()));
      expect(r.candidates).toEqual([]);
    }
  });

  it("a body over 5 MB is refused, and the other service still answers", async () => {
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), `{"message":{"items":[],"pad":"${"x".repeat(5 * 1024 * 1024)}"}}`);
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(r.notes).toEqual(["crossref-failed"]);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("10,000 results: at most 5 read per service and 10 kept, quickly", async () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({ DOI: `10.5555/ao.find.many.${i}`, type: "book", title: [`Distinction volume ${i}`], author: [{ family: "Bourdieu" }], issued: { "date-parts": [[1984]] } }));
    const results = Array.from({ length: 10_000 }, (_, i) => ({ doi: `https://doi.org/10.5555/ao.find.oa.${i}`, title: `Distinction part ${i}`, publication_year: 1984, type: "book", authorships: [{ author: { display_name: "Pierre Bourdieu" } }] }));
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items } }));
    answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), JSON.stringify({ results }));
    const t0 = performance.now();
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(r.candidates).toHaveLength(FIND_MAX_CANDIDATES);
    expect(FIND_MAX_CANDIDATES).toBe(10);
    expect(r.candidates.filter((c) => c.providers.includes("crossref"))).toHaveLength(5);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("a title of 5,000 characters is cut to 1,000", async () => {
    const long = "Distinction ".repeat(417).slice(0, 5000);
    const item = { DOI: "10.5555/ao.find.long", type: "book", title: [long], author: [{ given: "Pierre", family: "Bourdieu" }] };
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items: [item] } }));
    const r = await search("Bourdieu, Distinction", ctx(client()), ["crossref"]);
    expect(r.candidates[0]!.title.length).toBeLessThanOrEqual(1000);
    expect(r.candidates[0]!.title.length).toBeGreaterThan(900);
  });

  it("strings of 100,000 characters are bounded: title, names, container and publisher", async () => {
    const huge = "Ä".repeat(100_000);
    const item = {
      DOI: `10.5555/${"x".repeat(100_000)}`,
      type: huge,
      title: [huge],
      subtitle: [huge],
      author: [{ given: huge, family: huge }, { name: huge }],
      "container-title": [huge],
      publisher: huge,
      ISBN: [huge, ...Array.from({ length: 1000 }, () => "9780000000002")],
    };
    const oa = { results: [{ doi: huge, title: huge, publication_date: huge, type: huge, authorships: [{ author: { display_name: huge }, raw_author_name: huge }], primary_location: { source: { display_name: huge, host_organization_name: huge } } }] };
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items: [item] } }));
    answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), JSON.stringify(oa));
    const t0 = performance.now();
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.title.length).toBeLessThanOrEqual(1000);
      expect(c.creators.length).toBeLessThanOrEqual(100);
      for (const p of c.creators) for (const v of [p.given, p.family, p.literal]) expect((v ?? "").length).toBeLessThanOrEqual(200);
      expect((c.container ?? "").length).toBeLessThanOrEqual(1000);
      expect((c.publisher ?? "").length).toBeLessThanOrEqual(200);
      expect(c.identifiers.doi).toBeUndefined(); // neither is a DOI
      expect((c.identifiers.isbn ?? []).length).toBeLessThanOrEqual(20);
      expect(c.type).toBe("other");
    }
  });

  it("control characters and bidi marks in a title are removed; the match still works", async () => {
    const item = { DOI: "10.5555/ao.find.bidi", type: "book", title: ["Dis‮tinc\u0007tion⁦⁩​\u0085"], author: [{ given: "Pierre", family: "Bour‭dieu" }], issued: { "date-parts": [[1984]] } };
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items: [item] } }));
    const r = await search("Bourdieu, Distinction", ctx(client()), ["crossref"]);
    const c = r.candidates[0]!;
    expect(c.title).toBe("Distinc tion");
    expect(c.creators[0]!.family).toBe("Bourdieu");
    expect(JSON.stringify(r.candidates)).not.toMatch(/[\u0000-\u001f\u007f-\u009f​‪-‮⁦-⁩]/u);
  });

  it("a DOI that is not a DOI is dropped; the candidate stays", async () => {
    const items = [
      { DOI: "not-a-doi", type: "book", title: ["Distinction"], author: [{ family: "Bourdieu" }] },
      { DOI: "10.5555/has space", type: "book", title: ["The Forms of Capital"], author: [{ family: "Bourdieu" }] },
      { DOI: 42, type: "book", title: ["Homo Academicus"], author: [{ family: "Bourdieu" }] },
    ];
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items } }));
    const r = await search("Bourdieu, Distinction", ctx(client()), ["crossref"]);
    expect(r.candidates).toHaveLength(3);
    for (const c of r.candidates) expect(c.identifiers.doi).toBeUndefined();
  });

  it("the same DOI in two cases, from both services or twice from one, is one candidate", async () => {
    const items = [
      { DOI: "10.5555/AO.Find.Same", type: "book", title: ["Distinction"], author: [{ family: "Bourdieu" }] },
      { DOI: "10.5555/ao.find.same", type: "book", title: ["Distinction (reprint)"], author: [{ family: "Bourdieu" }] },
    ];
    const oa = { results: [{ doi: "https://doi.org/10.5555/ao.FIND.same", title: "Distinction", publication_year: 1984, type: "book", authorships: [{ author: { display_name: "Pierre Bourdieu" } }] }] };
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items } }));
    answer("https://api.openalex.org", oaPath("Bourdieu, Distinction"), JSON.stringify(oa));
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.identifiers.doi).toBe("10.5555/ao.find.same");
    expect(r.candidates[0]!.providers).toEqual(["crossref", "openalex"]);
    expect(r.candidates[0]!.issued).toBe("1984"); // filled from OpenAlex
  });

  it("an empty or whitespace title in a candidate drops that candidate", async () => {
    const items = [
      { DOI: "10.5555/ao.find.blank", type: "book", title: ["   "], author: [{ family: "Bourdieu" }] },
      { DOI: "10.5555/ao.find.ctrl", type: "book", title: ["\u0000‮​"], author: [{ family: "Bourdieu" }] },
      { DOI: "10.5555/ao.find.none", type: "book", author: [{ family: "Bourdieu" }] },
    ];
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items } }));
    const r = await search("Bourdieu, Distinction", ctx(client()), ["crossref"]);
    expect(r).toEqual({ candidates: [], notes: [] });
  });

  it("a candidate with 500 creators keeps 100", async () => {
    const author = Array.from({ length: 500 }, (_, i) => ({ given: "Ann", family: `Fixture${i}` }));
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), JSON.stringify({ message: { items: [{ DOI: "10.5555/ao.find.crowd", type: "journal-article", title: ["Distinction"], author }] } }));
    const r = await search("Bourdieu, Distinction", ctx(client()), ["crossref"]);
    expect(r.candidates[0]!.creators).toHaveLength(100);
    // The 101st author and later are not considered.
    expect(scoreCandidate(ref("Fixture300 Distinction"), r.candidates[0]!).creator).toBe(false);
    expect(scoreCandidate(ref("Fixture99 Distinction"), r.candidates[0]!).creator).toBe(true);
  });

  it("a network failure of one service is a note; of both, two notes", async () => {
    answer("https://api.crossref.org", crPath("Bourdieu, Distinction"), "", 400);
    openalex("Bourdieu, Distinction", "openalex-distinction.json");
    const r = await search("Bourdieu, Distinction", ctx(client()));
    expect(r.notes).toEqual(["crossref-failed"]);
    // Nothing intercepted: the mock refuses to connect.
    const both = await search("Somebody, Something else", ctx(client()));
    expect(both).toEqual({ candidates: [], notes: ["crossref-failed", "openalex-failed"] });
  });
});

describe("the lookup client's per-host concurrency", () => {
  it("Crossref is asked one request at a time by default", () => {
    expect(DEFAULT_CONCURRENCY).toEqual({ "api.crossref.org": 1 });
  });

  it("a host limited to 1 never has two requests open; an unlimited host may", async () => {
    let open = 0;
    let most = 0;
    const server = createServer((_req, res) => {
      open++;
      most = Math.max(most, open);
      setTimeout(() => {
        open--;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 40);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const real = new Agent();
    try {
      const run = async (concurrency: Record<string, number>) => {
        most = 0;
        const http = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: real, env: {}, rateLimits: { "127.0.0.1": 1000 }, concurrency, maxRetries: 0 });
        await Promise.all([1, 2, 3, 4].map((k) => http.getJson(`http://127.0.0.1:${port}/c${k}?${Math.random()}`, { cacheKey: `c:${k}:${Math.random()}` })));
        return most;
      };
      expect(await run({ "127.0.0.1": 1 })).toBe(1);
      expect(await run({})).toBeGreaterThan(1);
    } finally {
      await real.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a failed request gives its turn back", async () => {
    agent.get("https://api.crossref.org").intercept({ path: "/a", method: "GET" }).replyWithError(new Error("reset"));
    agent.get("https://api.crossref.org").intercept({ path: "/b", method: "GET" }).reply(200, "{}", JSON_HEADERS);
    const http = client({ maxRetries: 0 });
    await expect(http.getJson("https://api.crossref.org/a", { cacheKey: "t:a" })).rejects.toThrow();
    await expect(http.getJson("https://api.crossref.org/b", { cacheKey: "t:b" })).resolves.toEqual({});
  });
});

describe("decideMatch is pure and bounded", () => {
  it("returns ids only of the candidates given, likeliest first", () => {
    const list = [cand({ id: "x", title: "Taste" }), cand({ id: "y", title: "Distinction" }), cand({ id: "z", title: "Distinction", identifiers: { isbn: ["9780000000019"] } })];
    const d = decideMatch(ref("Bourdieu Distinction"), list);
    expect(d.kind).toBe("choose");
    expect(d.kind === "choose" && d.ids).toEqual(["y", "z", "x"]);
  });

  it("notes are of the declared kinds only", () => {
    const kinds: SearchNote[] = ["openalex-budget", "crossref-failed", "openalex-failed"];
    expect(kinds).toHaveLength(3);
  });
});
