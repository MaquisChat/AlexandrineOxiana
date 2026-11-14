/**
 * Task F8 (R267): an author alone — the people of that name, then a person's works. Made-up answers through undici's
 * MockAgent with `disableNetConnect`: nothing reaches the network. The people and works are invented (the shapes are
 * OpenAlex's as documented; see the report for which were taken from memory).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient } from "../lookup/http.js";
import type { LookupContext } from "../lookup/context.js";
import { InvalidInputError } from "../repo/errors.js";
import { mapOpenAlex } from "../lookup/openalex.js";
import type { WorkCandidate } from "./candidates.js";
import {
  FIND_PEOPLE_MAX,
  FIND_PERSON_TITLE_MAX,
  FIND_PERSON_VENUE_MAX,
  FIND_PERSON_WORKS_MAX,
  FindPeopleError,
  childTyped,
  decidePerson,
  fetchWork,
  fitAuthorEntry,
  fitPeople,
  hasInitial,
  titleCovered,
  peopleSearchUrl,
  peopleSearchWanted,
  sameWork,
  personWorksUrl,
  searchPeople,
  workUrl,
  worksOf,
} from "./people.js";
import { sanitizeEntry } from "./queue-store.js";
import { parseReference, type Reference } from "./reference.js";
import { decideMatch, openAlexSearchPausedUntil, scoreCandidate } from "./search.js";
import { FIND_LINE_MAX_BYTES, type FindEntry, type PersonCandidate } from "./types.js";

const OA = "https://api.openalex.org";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

let tmp: string;
let agent: MockAgent;
let now: number;
let notes: string[];
let seen: string[];

function client(): HttpClient {
  return new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, clock: () => now, sleep: async (ms) => void (now += ms), env: {}, maxRetries: 0 });
}
function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}
function ctx(http: HttpClient = client(), providers: string[] = ["crossref", "openalex"]): LookupContext {
  return { http, policy: policy(providers), projectId: "P1", actor: "tester", clock: () => new Date(now), debug: (n) => notes.push(n), sensitive: false };
}
const ref = (line: string): Reference => {
  const r = parseReference(line);
  if (!r) throw new Error("not a reference");
  return r;
};
/** Answers one exact path on OpenAlex, once, and records it. */
function answer(path: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
  agent
    .get(OA)
    .intercept({ path, method: "GET" })
    .reply((o) => {
      seen.push(String(o.path));
      return { statusCode: status, data: typeof body === "string" ? body : JSON.stringify(body), responseOptions: { headers: { ...JSON_HEADERS.headers, ...headers } } };
    });
}
const pathOf = (url: string) => url.slice(OA.length);

// Made-up people and works (10.5555 is a test prefix).
type P = { n: number; name: string; aff?: string; count?: number };
const person = (p: P) => ({
  id: `https://openalex.org/A${5000 + p.n}`,
  display_name: p.name,
  works_count: p.count ?? 12,
  ...(p.aff ? { last_known_institutions: [{ id: "https://openalex.org/I1", display_name: p.aff }] } : {}),
});
const people = (list: unknown[], count = list.length) => ({ meta: { count, page: 1, per_page: 20 }, results: list });
type W = { n: number; title: string; date: string; type?: string; venue?: string; doi?: string; author?: string };
const oaWork = (w: W) => ({
  id: `https://openalex.org/W${100 + w.n}`,
  title: w.title,
  display_name: w.title,
  publication_year: Number(w.date.slice(0, 4)),
  publication_date: w.date,
  type: w.type ?? "article",
  ...(w.doi ? { doi: `https://doi.org/${w.doi}` } : {}),
  primary_location: { source: { display_name: w.venue ?? "Journal of Invented Studies" } },
  authorships: [{ author: { display_name: w.author ?? "Arlie Hochschild" } }],
});
const page = (list: unknown[], count: number, n = 1) => ({ meta: { count, page: n, per_page: 100 }, results: list });
const cand = (title: string, family = "Hochschild"): WorkCandidate => ({
  id: `w-${title}`,
  title,
  creators: [{ family, given: "Arlie", role: "author" }],
  issued: "1983",
  type: "book",
  identifiers: {},
  providers: ["crossref"],
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-people-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  now = Date.parse("2026-11-13T10:00:00Z");
  notes = [];
  seen = [];
});
afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("when the people search is asked (R267 d, as changed by R279 a)", () => {
  it("a line the works rule is sure of makes no people request", () => {
    const sure = [cand("Zorblatt Grammar of Habitus", "Quillfeather")];
    const line = ref("Quillfeather, Zorblatt Grammar of Habitus");
    // A guard: the works rule is sure of it.
    expect(decideMatch(line, sure).kind).toBe("sure");
    expect(peopleSearchWanted(line, sure)).toBe(false);
  });
  it("R279 a: a work whose title is covered by what was typed no longer stops it when the works rule is not sure", () => {
    // A short title typed without its author.
    const short = [cand("Lanterns of the Estuary", "Brackwater")];
    expect(scoreCandidate(ref("Lanterns of the Estuary"), short[0]!).titleCover).toBeGreaterThanOrEqual(0.6);
    expect(peopleSearchWanted(ref("Lanterns of the Estuary"), short)).toBe(true);
    // A name that a reference work holds an entry TITLED with.
    expect(peopleSearchWanted(ref("Ottoline Brackwater"), [cand("Ottoline Brackwater", "Editors")])).toBe(true);
  });
  it("a digit (a year, a DOI, an ISBN) or more than 6 words: no people request", () => {
    expect(peopleSearchWanted(ref("Arlie Hochschild 1983"), [])).toBe(false);
    expect(peopleSearchWanted(ref("10.5555/ao.f8"), [])).toBe(false);
    expect(peopleSearchWanted(ref("978-0-00-000000-0"), [])).toBe(false);
    expect(peopleSearchWanted(ref("one two three four five six seven"), [])).toBe(false);
  });
  it("an author's name with no title near it: the people search is wanted", () => {
    expect(peopleSearchWanted(ref("Arlie Hochschild"), [])).toBe(true);
    expect(peopleSearchWanted(ref("Arlie Russell Hochschild"), [cand("The Second Shift")])).toBe(true);
    expect(peopleSearchWanted(ref("one two three four five six"), [])).toBe(true);
  });
});

describe("searchPeople", () => {
  it("asks exactly one address, with the typed words only", async () => {
    expect(peopleSearchUrl("Arlie Hochschild")).toBe(`${OA}/authors?search=Arlie%20Hochschild&per-page=20`);
    answer(pathOf(peopleSearchUrl("Arlie Hochschild")), people([person({ n: 1, name: "Arlie Hochschild", aff: "University of Invented Studies" })]));
    const r = await searchPeople(ref("Arlie Hochschild"), ctx());
    expect(seen).toEqual([pathOf(peopleSearchUrl("Arlie Hochschild"))]);
    expect(r).toEqual({ people: [{ id: "A5001", name: "Arlie Hochschild", affiliation: "University of Invented Studies", worksCount: 12, subjects: [] }], more: false });
  });

  it("forty people named Smith: Choose the person lists 20, says more exist, and nothing is added", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => person({ n: i, name: `${String.fromCharCode(65 + (i % 26))}. Smith` }));
    // OpenAlex sends 20 (per-page=20) and says there are 40; an answer that sends more is read only to 20.
    answer(pathOf(peopleSearchUrl("Smith")), people(forty.slice(0, 25), 40));
    const r = await searchPeople(ref("Smith"), ctx());
    expect(r.people).toHaveLength(FIND_PEOPLE_MAX);
    expect(r.more).toBe(true);
    const d = decidePerson(ref("Smith"), r.people, []);
    expect(d.kind).toBe("several");
    if (d.kind === "several") expect(d.people).toHaveLength(20);
  });

  it("the answer is untrusted: ids checked, names and affiliations cut to 200, control characters gone, bad items skipped", async () => {
    answer(
      pathOf(peopleSearchUrl("Smith")),
      people([
        { id: "https://openalex.org/W1", display_name: "Not A Person Smith", works_count: 1 },
        { id: "https://openalex.org/A123456789012345", display_name: "Too Long Id Smith", works_count: 1 },
        { id: 12, display_name: "No Id Smith" },
        { id: "https://openalex.org/A7", display_name: "" },
        { id: "https://openalex.org/A8", display_name: `Ann\u0000‮ Smith${"x".repeat(5000)}`, works_count: "lots", last_known_institutions: [{ display_name: `Inst‮itute\u0007 ${"y".repeat(5000)}` }] },
        "not an object",
        { id: "https://openalex.org/A9", display_name: "Bea Smith", works_count: -3, affiliations: [{ institution: { display_name: "College of Made-up Things" } }] },
      ]),
    );
    const r = await searchPeople(ref("Smith"), ctx());
    expect(r.people.map((p) => p.id)).toEqual(["A8", "A9"]);
    const [a, b] = r.people as [PersonCandidate, PersonCandidate];
    expect(a.name.length).toBe(200);
    expect(a.name.startsWith("Ann Smith")).toBe(true);
    expect(a.affiliation!.length).toBe(200);
    expect(a.affiliation!.startsWith("Institute")).toBe(true);
    expect(a.worksCount).toBe(0);
    expect(b).toEqual({ id: "A9", name: "Bea Smith", affiliation: "College of Made-up Things", worksCount: 0, subjects: [] });
  });

  it("the daily allowance spent: the search is paused for every OpenAlex search, and nothing is guessed", async () => {
    const http = client();
    answer(pathOf(peopleSearchUrl("Arlie Hochschild")), { error: "Rate limit exceeded", message: "You have exceeded your daily budget." }, 429);
    await expect(searchPeople(ref("Arlie Hochschild"), ctx(http))).rejects.toMatchObject({ name: "FindPeopleError", code: "budget" });
    expect(openAlexSearchPausedUntil(http)).toBe(Date.parse("2026-11-14T00:00:00Z"));
    // Paused: neither the people search nor a person's works are asked.
    await expect(searchPeople(ref("Arlie Hochschild"), ctx(http))).rejects.toMatchObject({ code: "budget" });
    await expect(worksOf("A5001", ctx(http))).rejects.toMatchObject({ code: "budget" });
    expect(seen).toHaveLength(1);
  });

  it("a failure or an answer of another shape is a FindPeopleError, never an empty list", async () => {
    answer(pathOf(peopleSearchUrl("Arlie Hochschild")), "unavailable", 503);
    await expect(searchPeople(ref("Arlie Hochschild"), ctx())).rejects.toBeInstanceOf(FindPeopleError);
    answer(pathOf(peopleSearchUrl("Arlie Hochschild")), { results: "nope" });
    await expect(searchPeople(ref("Arlie Hochschild"), ctx(client()))).rejects.toMatchObject({ code: "failed" });
  });

  it("OpenAlex refused by the project's rules: nothing is asked", async () => {
    const r = await searchPeople(ref("Arlie Hochschild"), ctx(client(), ["crossref"]));
    expect(r).toEqual({ people: [], more: false });
    expect(seen).toEqual([]);
  });
});

describe("decidePerson (the Global Constraint's rule)", () => {
  const p = (id: string, name: string): PersonCandidate => ({ id, name, worksCount: 3, subjects: [] });
  it("one Arlie Hochschild goes straight to Choose works, newest first", async () => {
    const found = [p("A1", "Arlie Russell Hochschild"), p("A2", "Adam Hochschild"), p("A3", "Arlie Hochstein")];
    const d = decidePerson(ref("Arlie Hochschild"), found, [cand("The Second Shift")]);
    expect(d).toEqual({ kind: "one", person: found[0], byInitial: false });
    // That person's works, newest first, whatever order they arrive in; two pages of 100 at most.
    const first = Array.from({ length: 100 }, (_, i) => oaWork({ n: i, title: `Invented Essay ${i}`, date: `${1980 + (i % 40)}-0${1 + (i % 9)}-15` }));
    const second = Array.from({ length: 30 }, (_, i) => oaWork({ n: 100 + i, title: `Invented Note ${i}`, date: `1979-01-${String(1 + (i % 28)).padStart(2, "0")}` }));
    expect(personWorksUrl("A1", 1)).toBe(`${OA}/works?filter=authorships.author.id:A1&sort=publication_date:desc&per-page=100&page=1`);
    answer(pathOf(personWorksUrl("A1", 1)), page(first, 130));
    answer(pathOf(personWorksUrl("A1", 2)), page(second, 130, 2));
    const r = await worksOf("A1", ctx());
    expect(seen).toEqual([pathOf(personWorksUrl("A1", 1)), pathOf(personWorksUrl("A1", 2))]);
    expect(r.works).toHaveLength(130);
    expect(r.more).toBe(false);
    const dates = r.works.map((w) => w.issued!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("two fit: Choose the person, with those two only", () => {
    const found = [p("A1", "Arlie Hochschild"), p("A2", "Arlie R. Hochschild"), p("A3", "Adam Hochschild")];
    expect(decidePerson(ref("Arlie Hochschild"), found, [])).toEqual({ kind: "several", people: [found[0], found[1]] });
  });
  it("no person's name covers every typed word, or a work's title is plainly meant: none", () => {
    expect(decidePerson(ref("Arlie Hochschild"), [p("A3", "Adam Hochschild")], [])).toEqual({ kind: "none" });
    expect(decidePerson(ref("Hochschild Second Shift"), [p("A1", "Arlie Hochschild")], [cand("The Second Shift")])).toEqual({ kind: "none" });
    expect(decidePerson(ref("Arlie Hochschild"), [], [])).toEqual({ kind: "none" });
  });
  it("R279: the name rule alone (fitPeople) holds whatever the works found; titleCovered says whether a work's title is covered", () => {
    const found = [p("A1", "Ottoline Brackwater"), p("A2", "Ottoline Brackwell")];
    const titled = [cand("Ottoline Brackwater", "Editors")];
    expect(titleCovered(ref("Ottoline Brackwater"), titled)).toBe(true);
    expect(titleCovered(ref("Ottoline Brackwater"), [cand("Lanterns of the Estuary", "Brackwater")])).toBe(false);
    // decidePerson as built: a covered title means none …
    expect(decidePerson(ref("Ottoline Brackwater"), found, titled)).toEqual({ kind: "none" });
    // … the name rule alone still finds the person (the app then asks, and offers both).
    expect(fitPeople(ref("Ottoline Brackwater"), found)).toEqual({ kind: "one", person: found[0], byInitial: false });
    expect(fitPeople(ref("O. Brackwater"), found)).toEqual({ kind: "one", person: found[0], byInitial: true });
    expect(hasInitial(ref("O. Brackwater"))).toBe(true);
    expect(hasInitial(ref("Ottoline Brackwater"))).toBe(false);
  });
});

describe("worksOf and fetchWork", () => {
  it("a person id that is not A-digits is refused, and nothing is asked", async () => {
    for (const bad of ["X123", "A", "A1234567890123", "https://openalex.org/A1", "A1&filter=x", "a12"]) {
      await expect(worksOf(bad, ctx())).rejects.toBeInstanceOf(InvalidInputError);
    }
    for (const bad of ["A1", "W", "W1234567890123", "W1/x"]) await expect(fetchWork(bad, ctx())).rejects.toBeInstanceOf(InvalidInputError);
    expect(seen).toEqual([]);
  });

  it("a person's works are bounded: at most 200 (two pages), ids W-digits, title 300, venue 100, a DOI only when it is one, newest first", async () => {
    const long = (n: number, c = "t") => `${c}\u0001`.repeat(n);
    const one = (i: number) =>
      oaWork({ n: i, title: `Work ${i} ${long(800)}`, date: `2020-01-${String(1 + (i % 28)).padStart(2, "0")}`, venue: long(400, "v"), doi: i % 2 ? `10.5555/ao.f8.${i}` : "not a doi" });
    const first = Array.from({ length: 100 }, (_, i) => one(i));
    // Bad items on page 2: they are skipped, never stored.
    const second: unknown[] = Array.from({ length: 100 }, (_, i) => one(100 + i));
    second[3] = { ...(second[3] as object), id: "https://openalex.org/A9" };
    second[4] = { ...(second[4] as object), title: null, display_name: null };
    answer(pathOf(personWorksUrl("A1", 1)), page(first, 450));
    answer(pathOf(personWorksUrl("A1", 2)), page(second, 450, 2));
    const r = await worksOf("A1", ctx());
    expect(seen).toHaveLength(2); // never a third page
    expect(r.works).toHaveLength(198);
    expect(r.works.length).toBeLessThanOrEqual(FIND_PERSON_WORKS_MAX);
    expect(r.more).toBe(true);
    for (const w of r.works) {
      expect(w.id).toMatch(/^W\d{1,12}$/u);
      expect(w.title.length).toBeLessThanOrEqual(FIND_PERSON_TITLE_MAX);
      expect(w.title).not.toMatch(/\p{Cc}/u);
      expect((w.container ?? "").length).toBeLessThanOrEqual(FIND_PERSON_VENUE_MAX);
      expect(w.providers).toEqual(["openalex"]);
      expect(w.creators.length).toBeLessThanOrEqual(1);
    }
    expect(r.works.filter((w) => w.identifiers.doi).every((w) => /^10\.5555\/ao\.f8\.\d+$/u.test(w.identifiers.doi!))).toBe(true);
    expect(r.works.filter((w) => w.identifiers.doi)).toHaveLength(99);
    const dates = r.works.map((w) => w.issued!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("one page that is not full: one request only", async () => {
    answer(pathOf(personWorksUrl("A1", 1)), page([oaWork({ n: 1, title: "Only Work", date: "2001-02-03", type: "book" })], 1));
    const r = await worksOf("A1", ctx());
    expect(seen).toHaveLength(1);
    expect(r).toMatchObject({ more: false, works: [{ id: "W101", title: "Only Work", type: "book", issued: "2001-02-03", creators: [{ family: "Hochschild", role: "author" }] }] });
  });

  it("a works page that fails: a FindPeopleError, and nothing half-kept", async () => {
    answer(pathOf(personWorksUrl("A1", 1)), page(Array.from({ length: 100 }, (_, i) => oaWork({ n: i, title: `W ${i}`, date: "2001-01-01" })), 150));
    answer(pathOf(personWorksUrl("A1", 2)), "unavailable", 503);
    await expect(worksOf("A1", ctx())).rejects.toMatchObject({ code: "failed" });
  });

  it("fetchWork asks the single work by its id (free of the allowance) and bounds it as a search candidate", async () => {
    expect(workUrl("W101")).toBe(`${OA}/works/W101`);
    answer("/works/W101", { ...oaWork({ n: 1, title: `A Full Title ${"z".repeat(5000)}`, date: "1999-05-01", doi: "10.5555/ao.f8.full" }) });
    const c = await fetchWork("W101", ctx());
    expect(seen).toEqual(["/works/W101"]);
    expect(c).toMatchObject({ id: "W101", issued: "1999-05-01", identifiers: { doi: "10.5555/ao.f8.full" }, providers: ["openalex"], creators: [{ family: "Hochschild", given: "Arlie" }] });
    expect(c!.title.length).toBe(1000);
    // An answer for another work is not taken: nothing found (R271 M3), as for a missing work.
    answer("/works/W102", oaWork({ n: 9, title: "Another", date: "2000-01-01" }));
    expect(await fetchWork("W102", ctx())).toBeNull();
    answer("/works/W103", { error: "not found" }, 404);
    expect(await fetchWork("W103", ctx())).toBeNull();
  });
});

describe("what is stored fits by construction (A2: the store refuses, never cuts)", () => {
  const entry = (works: WorkCandidate[], ppl: PersonCandidate[]): FindEntry => ({
    id: "01a1d5de-c95e-7508-a8a2-ace1aaa9259a",
    projectId: "01a1d5de-c95e-7508-a8a2-ace1aaa92000",
    typed: "長".repeat(500),
    state: "choose-works",
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    attempts: 0,
    people: ppl,
    works,
    chosen: ppl[0]!.id,
  });
  for (const [kind, ch] of [
    ["plain letters", "t"],
    ["a script of three bytes a character", "長"],
    ["quotation marks (escaped in JSON)", '"'],
  ] as const) {
    it(`200 works with 1,000-character titles make a line the store accepts (${kind})`, () => {
      const works: WorkCandidate[] = Array.from({ length: 200 }, (_, i) => ({
        id: `W${100000000000 + i}`,
        title: ch.repeat(1000),
        creators: [{ family: ch.repeat(200), role: "author" }],
        issued: "2020-01-01",
        type: "article-journal",
        container: ch.repeat(1000),
        identifiers: { doi: `10.5555/${ch.repeat(290)}` },
        providers: ["openalex"],
      }));
      const ppl: PersonCandidate[] = Array.from({ length: 20 }, (_, i) => ({
        id: `A${100000000000 + i}`,
        name: ch.repeat(200),
        affiliation: ch.repeat(1000),
        worksCount: 1_000_000,
        subjects: [ch.repeat(1000), ch.repeat(1000), ch.repeat(1000)],
      }));
      const fitted = fitAuthorEntry(entry(works, ppl));
      expect(sanitizeEntry(fitted)).not.toBeNull();
      // With a reason, a time to try again and both flags (what a later line may add), the line still fits.
      const full = { ...fitted, reason: { code: "no-legal-basis" as const, by: "settings" as const }, nextTryAt: "2026-11-14T00:00:00.000Z", morePeople: true as const, moreWorks: true as const };
      expect(Buffer.byteLength(JSON.stringify(sanitizeEntry(full)), "utf8")).toBeLessThanOrEqual(FIND_LINE_MAX_BYTES);
      expect(fitted.works!.length).toBeGreaterThan(0);
      expect(fitted.works!.length).toBeLessThan(200);
      expect(fitted.moreWorks).toBe(true);
      // Once a person is chosen, only that person is kept beside the works (what is stored is for choosing only).
      expect(fitted.people!.map((p) => p.id)).toEqual([ppl[0]!.id]);
      // Newest first is kept: the works kept are the first ones.
      expect(fitted.works!.map((w) => w.id)).toEqual(works.slice(0, fitted.works!.length).map((w) => w.id));
      for (const w of fitted.works!) {
        expect(w.title.length).toBeLessThanOrEqual(FIND_PERSON_TITLE_MAX);
        expect((w.container ?? "").length).toBeLessThanOrEqual(FIND_PERSON_VENUE_MAX);
      }
      for (const p of fitted.people!) {
        expect(p.name.length).toBeLessThanOrEqual(200);
        expect((p.affiliation ?? "").length).toBeLessThanOrEqual(200);
        expect(p.subjects.length).toBeLessThanOrEqual(3);
        for (const t of p.subjects) expect(t.length).toBeLessThanOrEqual(100);
      }
    });
  }
  it("20 people with long affiliations alone fit (Choose the person)", () => {
    const ppl: PersonCandidate[] = Array.from({ length: 20 }, (_, i) => ({ id: `A${i + 1}`, name: "長".repeat(200), affiliation: "長".repeat(200), worksCount: 9, subjects: ["長".repeat(100), "長".repeat(100), "長".repeat(100)] }));
    const e = { ...entry([], ppl), state: "choose-person" as const };
    delete (e as Partial<FindEntry>).works;
    delete (e as Partial<FindEntry>).chosen;
    const fitted = fitAuthorEntry(e);
    expect(Buffer.byteLength(JSON.stringify(sanitizeEntry(fitted)), "utf8")).toBeLessThanOrEqual(FIND_LINE_MAX_BYTES);
    // Whatever had to go, the screen is told that more people exist; never one silent choice.
    expect(fitted.people!.length).toBeGreaterThan(1);
    if (fitted.people!.length < 20) expect(fitted.morePeople).toBe(true);
  });
});

describe("the line typed for a work added from a person", () => {
  it("is the work's title, a comma and the first author's family name, bounded like a typed line", () => {
    const w: WorkCandidate = { id: "W1", title: "The Managed Heart", creators: [{ family: "Hochschild", given: "Arlie", role: "author" }], type: "book", identifiers: {}, providers: ["openalex"] };
    expect(childTyped(w)).toBe("The Managed Heart, Hochschild");
    expect(childTyped({ ...w, creators: [{ literal: "Collective of Invented Authors", role: "author" }] })).toBe("The Managed Heart, Collective of Invented Authors");
    expect(childTyped({ ...w, creators: [] })).toBe("The Managed Heart");
    const long = childTyped({ ...w, title: "x".repeat(1000), creators: [{ family: "y".repeat(200), role: "author" }] });
    expect(parseReference(long)).not.toBeNull();
    expect(Array.from(long).length).toBeLessThanOrEqual(500);
    // A one-character title with no author is still a line the queue keeps.
    expect(parseReference(childTyped({ ...w, title: "X", creators: [] }))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 2 (R270 d, e; R271)

describe("round 2: an initial counts, but always asks (R270 d)", () => {
  const p = (id: string, name: string): PersonCandidate => ({ id, name, worksCount: 3, subjects: [] });
  it("J. Smith against John Smith and Jane Smith: both fit, several", () => {
    const found = [p("A1", "John Smith"), p("A2", "Jane Smith"), p("A3", "Adam Smith")];
    expect(decidePerson(ref("J. Smith"), found, [])).toEqual({ kind: "several", people: [found[0], found[1]] });
    expect(decidePerson(ref("J Smith"), found, [])).toEqual({ kind: "several", people: [found[0], found[1]] });
  });
  it("P. Bourdieu with one Pierre Bourdieu: one, matched by an initial (the runner asks)", () => {
    const found = [p("A1", "Pierre Bourdieu"), p("A2", "Marie-Claire Bourdieu")];
    expect(decidePerson(ref("P. Bourdieu"), found, [])).toEqual({ kind: "one", person: found[0], byInitial: true });
  });
  it("Pierre Bourdieu with one: one, not by an initial (straight to works as before)", () => {
    expect(decidePerson(ref("Pierre Bourdieu"), [p("A1", "Pierre Bourdieu")], [])).toEqual({ kind: "one", person: p("A1", "Pierre Bourdieu"), byInitial: false });
  });
  it("R273 M10: a typed single letter is always an initial, even against a name that holds that bare letter", () => {
    expect(decidePerson(ref("J. Smith"), [p("A1", "J. Smith")], [])).toEqual({ kind: "one", person: p("A1", "J. Smith"), byInitial: true });
    expect(decidePerson(ref("J Smith"), [p("A1", "J Smith")], [])).toEqual({ kind: "one", person: p("A1", "J Smith"), byInitial: true });
    expect(decidePerson(ref("John Smith"), [p("A1", "John Smith")], [])).toEqual({ kind: "one", person: p("A1", "John Smith"), byInitial: false });
  });
  it("a typed word of two letters or more is never an initial", () => {
    expect(decidePerson(ref("Pi Bourdieu"), [p("A1", "Pierre Bourdieu")], [])).toEqual({ kind: "none" });
  });
});

describe("round 2: subjects in place of sample titles (R270 e)", () => {
  it("up to three subject names from the same answer: topics, else x_concepts; cleaned and cut to 100; nothing else asked", async () => {
    answer(
      pathOf(peopleSearchUrl("Smith")),
      people([
        { ...person({ n: 1, name: "Ann Smith" }), topics: [{ display_name: "Emotional Labour" }, { display_name: `Care\u0007 Work ${"x".repeat(300)}` }, { display_name: "Family Time" }, { display_name: "Fourth" }] },
        { ...person({ n: 2, name: "Bea Smith" }), x_concepts: [{ display_name: "Sociology" }, { display_name: 12 }, null, { display_name: "Gender" }] },
        { ...person({ n: 3, name: "Cy Smith" }), topics: [], x_concepts: [{ display_name: "Economics" }] },
        { ...person({ n: 4, name: "Di Smith" }), topics: "not a list", x_concepts: { display_name: "nope" } },
        { ...person({ n: 5, name: "Ed Smith" }), topics: [{ display_name: { nested: true } }, "Plain string"] },
      ]),
    );
    const r = await searchPeople(ref("Smith"), ctx());
    expect(seen).toHaveLength(1);
    const [a, b, c, d, e] = r.people as PersonCandidate[];
    expect(a!.subjects).toHaveLength(3);
    expect(a!.subjects[0]).toBe("Emotional Labour");
    expect(a!.subjects[1]!.startsWith("Care Work")).toBe(true);
    expect(a!.subjects[1]!.length).toBe(100);
    expect(b!.subjects).toEqual(["Sociology", "Gender"]);
    expect(c!.subjects).toEqual(["Economics"]);
    expect(d!.subjects).toEqual([]);
    expect(e!.subjects).toEqual([]);
  });
});

describe("round 2: hostile kinds of work (R271 M1)", () => {
  it("a type such as constructor, __proto__ or toString is kind other, and the page's other works are kept", async () => {
    const list = [
      oaWork({ n: 1, title: "First Work", date: "2003-01-01" }),
      oaWork({ n: 2, title: "Second Work", date: "2002-01-01", type: "constructor" }),
      oaWork({ n: 3, title: "Third Work", date: "2001-01-01", type: "__proto__" }),
      oaWork({ n: 4, title: "Fourth Work", date: "2000-01-01", type: "toString" }),
      { id: "https://openalex.org/W105", title: "Fifth Work", publication_year: 1999, type: { not: "a string" } },
    ];
    answer(pathOf(personWorksUrl("A1", 1)), page(list, 5));
    const r = await worksOf("A1", ctx());
    expect(r.works.map((w) => w.id)).toEqual(["W101", "W102", "W103", "W104", "W105"]);
    expect(r.works.map((w) => w.type)).toEqual(["article-journal", "other", "other", "other", "other"]);
    // The entry that keeps them is one the store takes.
    const e: FindEntry = { id: "01a1d5de-c95e-7508-a8a2-ace1aaa9259a", projectId: "P1", typed: "Arlie Hochschild", state: "choose-works", createdAt: "x", updatedAt: "x", attempts: 0, works: r.works };
    expect(sanitizeEntry(e)).not.toBeNull();
  });
  it("a single work with such a type is kind other (the shared OpenAlex reader too)", async () => {
    answer("/works/W101", oaWork({ n: 1, title: "A Work", date: "2001-01-01", type: "constructor" }));
    expect((await fetchWork("W101", ctx()))!.type).toBe("other");
    for (const t of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(mapOpenAlex({ title: "x", type: t })!.type).toBe("other");
  });
});

describe("round 2: a full page with no count means more (R271 M2)", () => {
  it("20 people with no meta.count: more", async () => {
    answer(pathOf(peopleSearchUrl("Smith")), { results: Array.from({ length: 20 }, (_, i) => person({ n: i, name: `Person${i} Smith` })) });
    expect((await searchPeople(ref("Smith"), ctx())).more).toBe(true);
  });
  it("fewer than 20 people with no meta.count: no more", async () => {
    answer(pathOf(peopleSearchUrl("Smith")), { results: [person({ n: 1, name: "Ann Smith" })] });
    expect((await searchPeople(ref("Smith"), ctx())).more).toBe(false);
  });
  it("100 works with no count: the second page is asked; 200 with no count: more", async () => {
    const all = Array.from({ length: 200 }, (_, i) => oaWork({ n: i, title: `Work ${i}`, date: "2001-01-01" }));
    answer(pathOf(personWorksUrl("A1", 1)), { results: all.slice(0, 100) });
    answer(pathOf(personWorksUrl("A1", 2)), { results: all.slice(100) });
    const r = await worksOf("A1", ctx());
    expect(seen).toHaveLength(2);
    expect(r.works).toHaveLength(200);
    expect(r.more).toBe(true);
  });
  it("100 then 30 with no count: two pages, no more", async () => {
    const all = Array.from({ length: 130 }, (_, i) => oaWork({ n: i, title: `Work ${i}`, date: "2001-01-01" }));
    answer(pathOf(personWorksUrl("A1", 1)), { results: all.slice(0, 100) });
    answer(pathOf(personWorksUrl("A1", 2)), { results: all.slice(100) });
    const r = await worksOf("A1", ctx());
    expect(seen).toHaveLength(2);
    expect(r).toMatchObject({ more: false });
    expect(r.works).toHaveLength(130);
  });
});

describe("round 2: a single work (R271 M3, M4)", () => {
  it("a 429 that shows the allowance spent is the budget, not a failure", async () => {
    answer("/works/W101", { error: "Rate limit exceeded", message: "You have exceeded your daily budget." }, 429);
    await expect(fetchWork("W101", ctx())).rejects.toMatchObject({ name: "FindPeopleError", code: "budget" });
  });
  it("sameWork: the DOI kept must be the fresh one's; the title kept must begin the fresh one's (compared on the kept length)", () => {
    const kept: WorkCandidate = { id: "W1", title: "The Managed Heart", creators: [], type: "book", identifiers: { doi: "10.5555/ao.f8.mh" }, providers: ["openalex"] };
    const fresh: WorkCandidate = { ...kept, title: "The Managed Heart", creators: [{ family: "Hochschild", role: "author" }] };
    expect(sameWork(kept, fresh)).toBe(true);
    expect(sameWork(kept, { ...fresh, identifiers: { doi: "10.5555/other" } })).toBe(false);
    expect(sameWork(kept, { ...fresh, identifiers: {} })).toBe(false);
    expect(sameWork(kept, { ...fresh, title: "Something Else Entirely" })).toBe(false);
    expect(sameWork({ ...kept, identifiers: {} }, { ...fresh, identifiers: { doi: "10.5555/x" } })).toBe(true);
    // A kept title cut at 300 characters (mid-word) is the beginning of the fresh, longer one.
    const long = `The Managed Heart ${"commercialization of human feeling ".repeat(20)}`.trim();
    const cutKept = long.slice(0, 300).trimEnd();
    expect(sameWork({ ...kept, title: cutKept }, { ...fresh, title: long })).toBe(true);
    expect(sameWork({ ...kept, title: cutKept }, { ...fresh, title: `Another Title ${long}` })).toBe(false);
    // Punctuation and case are not a difference.
    expect(sameWork(kept, { ...fresh, title: "the managed heart." })).toBe(true);
  });
  it("sameWork (R273 I2): titles are compared whole; only a title cut at the stored limit is compared on its words", () => {
    const kept: WorkCandidate = { id: "W1", title: "The State", creators: [], type: "book", identifiers: {}, providers: ["openalex"] };
    const fresh: WorkCandidate = { ...kept, creators: [{ family: "Hochschild", role: "author" }] };
    expect(sameWork(kept, { ...fresh, title: "The Statesman's Yearbook" })).toBe(false);
    expect(sameWork({ ...kept, title: "Capital" }, { ...fresh, title: "Capital, Volume 3: The Process of Capitalist Production" })).toBe(false);
    expect(sameWork(kept, { ...fresh, title: "the STATE!" })).toBe(true);
    const long = `The Managed Heart ${"commercialization of human feeling ".repeat(20)}`.trim();
    const cutKept = long.slice(0, FIND_PERSON_TITLE_MAX).trimEnd();
    expect(sameWork({ ...kept, title: cutKept }, { ...fresh, title: long })).toBe(true);
    const other = `The Hidden Heart ${"commercialization of human feeling ".repeat(20)}`.trim();
    expect(sameWork({ ...kept, title: cutKept }, { ...fresh, title: other })).toBe(false);
  });
  it("once a person is chosen, morePeople is dropped (R271 M6)", () => {
    const e: FindEntry = {
      id: "01a1d5de-c95e-7508-a8a2-ace1aaa9259a",
      projectId: "P1",
      typed: "Smith",
      state: "looking-up",
      createdAt: "x",
      updatedAt: "x",
      attempts: 0,
      chosen: "A2",
      morePeople: true,
      people: [
        { id: "A1", name: "Ann Smith", worksCount: 1, subjects: [] },
        { id: "A2", name: "Bea Smith", worksCount: 1, subjects: [] },
      ],
    };
    const f = fitAuthorEntry(e);
    expect(f.people!.map((x) => x.id)).toEqual(["A2"]);
    expect(f.morePeople).toBeUndefined();
    expect(fitAuthorEntry({ ...e, state: "choose-person" }).morePeople).toBe(true);
  });
});
