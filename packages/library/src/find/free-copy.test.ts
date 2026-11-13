/**
 * Task F10: where a free copy is. Nothing here reaches the network: the lookup client is given an undici MockAgent
 * (disableNetConnect) composed with a recorder of every request. Every answer is made up, in the shape of the
 * service's documentation as far as it is known (see the task report: shapes from memory are marked UNVERIFIED);
 * the people and the e-mail address are made up (`test-only@example.invalid`).
 */
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { MockAgent, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LookupContext } from "../lookup/context.js";
import { HttpClient, LookupHttpError, USER_AGENT } from "../lookup/http.js";
import type { WorkCandidate } from "./candidates.js";
import {
  FREE_COPY_FILE_HOSTS,
  FREE_COPY_OFFERS_MAX,
  fileHostAllowed,
  findFreeCopies,
  parseFreeCopyAddress,
  type FreeCopySource,
} from "./free-copy.js";

const EMAIL = "test-only@example.invalid";
const DOI = "10.5555/rivers.2019";
const ALL: FreeCopySource[] = ["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"];

const ARTICLE: WorkCandidate = {
  id: "w-article",
  title: "Rivers and Memory in Upland Villages",
  creators: [{ given: "Ada", family: "Quill", role: "author" }],
  issued: "2019",
  type: "article-journal",
  identifiers: { doi: DOI },
  providers: ["crossref"],
};
const BOOK: WorkCandidate = {
  id: "w-book",
  title: "The Lantern Keepers of Ostrava",
  creators: [{ given: "Mira", family: "Halloway", role: "author" }],
  issued: "1931",
  type: "book",
  identifiers: {},
  providers: ["openalex"],
};

let tmp: string;
let agent: MockAgent;
let dispatcher: Dispatcher;
let now: number;
let notes: string[];
let requests: Array<{ origin: string; path: string; headers: Record<string, string>; at: number }>;

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

const recorder: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  requests.push({ origin: new URL(String(opts.origin)).origin, path: opts.path, headers: headersOf(opts.headers), at: now });
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

function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}

function ctx(http: HttpClient = client(), providers: string[] = ["crossref", "openalex"]): LookupContext {
  return { http, policy: policy(providers), projectId: "P1", actor: "tester", clock: () => new Date(now), debug: (n) => notes.push(n), sensitive: false };
}

const JSON_H = { headers: { "content-type": "application/json" } };
const json = (origin: string, path: string | ((p: string) => boolean), body: unknown, status = 200) =>
  agent.get(origin).intercept({ path, method: "GET" }).reply(status, typeof body === "string" ? body : JSON.stringify(body), JSON_H);
const queryParam = (name: string, want: string) => (p: string) => new URL(p, "https://x.invalid").searchParams.get(name) === want;

const openalex = (body: unknown, doi = DOI) => json("https://api.openalex.org", `/works/doi:${doi}`, body);
const unpaywall = (body: unknown, doi = DOI) =>
  agent.get("https://api.unpaywall.org").intercept({ path: `/v2/${doi}`, query: { email: EMAIL }, method: "GET" }).reply(200, JSON.stringify(body), JSON_H);
const s2 = (body: unknown, doi = DOI) => json("https://api.semanticscholar.org", `/graph/v1/paper/DOI:${doi}?fields=openAccessPdf`, body);
const epmc = (body: unknown, doi = DOI) => json("https://www.ebi.ac.uk", (p) => p.startsWith("/europepmc/webservices/rest/search?") && queryParam("query", `DOI:"${doi}"`)(p), body);
const arxiv = (query: string, xml: string) =>
  agent.get("https://export.arxiv.org").intercept({ path: (p) => p.startsWith("/api/query?") && queryParam("search_query", query)(p), method: "GET" }).reply(200, xml, { headers: { "content-type": "application/atom+xml" } });
const doab = (title: string, body: unknown) =>
  json("https://directory.doabooks.org", (p) => p.startsWith("/rest/search?") && queryParam("query", `dc.title:"${title}"`)(p), body);
const iaSearch = (q: string, ids: unknown[]) => json("https://archive.org", (p) => p.startsWith("/advancedsearch.php?") && queryParam("q", q)(p), { responseHeader: { status: 0 }, response: { numFound: ids.length, start: 0, docs: ids.map((identifier) => ({ identifier })) } });
const iaMeta = (id: string, body: unknown) => json("https://archive.org", `/metadata/${id}`, body);

type AtomEntry = { id: string; title: string; authors: string[]; doi?: string };
const atom = (entries: AtomEntry[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title type="html">ArXiv Query</title>
  <id>http://arxiv.org/api/made-up</id>
  <opensearch:totalResults>${entries.length}</opensearch:totalResults>
${entries
  .map(
    (e) => `  <entry>
    <id>http://arxiv.org/abs/${e.id}</id>
    <title>${e.title}</title>
${e.authors.map((a) => `    <author><name>${a}</name></author>`).join("\n")}
${e.doi ? `    <arxiv:doi>${e.doi}</arxiv:doi>` : ""}
    <link href="http://arxiv.org/abs/${e.id}" rel="alternate" type="text/html"/>
    <link title="pdf" href="https://evil.example/${e.id}.pdf" rel="related" type="application/pdf"/>
  </entry>`,
  )
  .join("\n")}
</feed>`;
const ARTICLE_TITLE_Q = `ti:"rivers and memory in upland villages" AND au:quill`;
const BOOK_TITLE = "the lantern keepers of ostrava";

const openIaItem = (id: string, over: Record<string, unknown> = {}, files: unknown[] = [{ name: `${id}.pdf`, format: "Text PDF" }]) => ({
  metadata: { identifier: id, title: "The Lantern Keepers of Ostrava", creator: "Halloway, Mira", mediatype: "texts", licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/", ...over },
  files,
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      out.push(await readFile(join(dir, n), "utf8"));
    } catch {
      // a folder
    }
  }
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-free-copy-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  dispatcher = agent.compose(recorder);
  now = Date.parse("2026-11-13T10:00:00Z");
  notes = [];
  requests = [];
});

afterEach(async () => {
  await agent.close();
  // Every request of every test: our User-Agent without mailto, no cookie, no key; the e-mail only to Unpaywall.
  for (const r of requests) {
    expect(r.headers["user-agent"]).toBe(USER_AGENT);
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers.cookie).toBeUndefined();
    if (r.origin !== "https://api.unpaywall.org") expect(JSON.stringify(r)).not.toMatch(/test-only|example\.invalid/u);
  }
  for (const n of notes) expect(n).not.toMatch(/test-only|example\.invalid|https?:/u);
  for (const f of await filesUnder(join(tmp, "Lib"))) expect(f).not.toMatch(/test-only|example\.invalid/u);
  await rm(tmp, { recursive: true, force: true });
});

describe("fileHostAllowed: one rule, on the parsed address", () => {
  const rows: Array<[string, boolean]> = [
    ["https://arxiv.org/pdf/2101.00001", true],
    ["https://export.arxiv.org/pdf/2101.00001", true],
    ["https://europepmc.org/articles/PMC1?pdf=render", true],
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/", true],
    ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/pdf/", true],
    ["https://library.oapen.org/bitstream/x.pdf", true],
    ["https://directory.doabooks.org/rest/bitstreams/x/retrieve", true],
    ["https://archive.org/download/x/x.pdf", true],
    ["https://ia800000.us.archive.org/1/items/x/x.pdf", true],
    ["https://ia123.us.archive.org/x", true],
    ["https://ARXIV.ORG/", true], // the parser lower-cases
    ["https://arxiv.org/a@b.pdf", true], // the @ is in the path
    ["https://arxiv.org:443/x", true], // the parser drops the default port
    ["https://arxiv.org\\@evil.example/", true], // parsed as https://arxiv.org/@evil.example/: that is what is fetched
    ["https://arxiv.org@evil.example/x.pdf", false],
    ["https://user:pw@arxiv.org/x.pdf", false],
    ["https://:pw@arxiv.org/x.pdf", false],
    ["https://arxiv.org:8443/", false],
    ["http://arxiv.org/", false],
    ["ftp://arxiv.org/", false],
    ["https://arxiv.org./x", false],
    ["https://evil.arxiv.org/x", false],
    ["https://arxiv.org.evil.example/x", false],
    ["https://аrxiv.org/x", false], // Cyrillic a
    ["https://[::1]/", false],
    ["https://127.0.0.1/", false],
    ["https://2130706433/", false],
    ["https://localhost/", false],
    ["https://ia800000.us.archive.org.evil.example/", false],
    ["https://ia12.us.archive.org/", false],
    ["https://ia1234567.us.archive.org/", false],
    ["https://xia800.us.archive.org/", false],
    ["https://web.archive.org/web/x", false],
  ];
  it.each(rows)("%s → %s", (raw, allowed) => {
    const u = parseFreeCopyAddress(raw);
    expect(u).not.toBeNull();
    expect(fileHostAllowed(u!)).toBe(allowed);
  });

  it("an address that does not parse, or is longer than 2,000 characters, is dropped", () => {
    expect(parseFreeCopyAddress("not a url")).toBeNull();
    expect(parseFreeCopyAddress(`https://arxiv.org/${"a".repeat(1990)}`)).toBeNull();
    expect(parseFreeCopyAddress(42)).toBeNull();
    expect(parseFreeCopyAddress("/relative", new URL("https://arxiv.org/x"))!.href).toBe("https://arxiv.org/relative");
  });

  it("the listed hosts are exactly the plan's", () => {
    expect([...FREE_COPY_FILE_HOSTS]).toEqual(["arxiv.org", "export.arxiv.org", "europepmc.org", "pmc.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "library.oapen.org", "directory.doabooks.org", "archive.org"]);
    expect(Object.isFrozen(FREE_COPY_FILE_HOSTS)).toBe(true);
  });
});

describe("getJson's query option (the e-mail's way)", () => {
  it("is sent, but is never part of the cache key, a cached file or an error", async () => {
    const http = client();
    unpaywall({ doi: DOI, is_oa: false });
    expect(await http.getJson(`https://api.unpaywall.org/v2/${DOI}`, { cacheKey: "k:unpaywall", query: { email: EMAIL }, sensitive: false })).toEqual({ doi: DOI, is_oa: false });
    expect(requests[0]!.path).toContain("email=test-only%40example.invalid");
    // The same answer is used whatever the e-mail (another client, the disk cache; nothing is asked).
    const other = client();
    expect(await other.getJson(`https://api.unpaywall.org/v2/${DOI}`, { cacheKey: "k:unpaywall", query: { email: "someone-else@example.invalid" }, sensitive: false })).toEqual({ doi: DOI, is_oa: false });
    expect(requests).toHaveLength(1);
    // An address the mock does not know: undici's own message names the path with its query; ours never does.
    const err = await other.getJson(`https://api.unpaywall.org/v2/10.5555/other`, { cacheKey: "k:other", query: { email: EMAIL }, sensitive: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupHttpError);
    expect(inspect(err, { depth: 10, showHidden: true })).not.toMatch(/test-only|example\.invalid/u);
    agent.get("https://api.unpaywall.org").intercept({ path: "/v2/10.5555/five", query: { email: EMAIL }, method: "GET" }).reply(500, "server says test-only@example.invalid");
    const err5 = await other.getJson(`https://api.unpaywall.org/v2/10.5555/five`, { cacheKey: "k:five", query: { email: EMAIL }, sensitive: false }).catch((e: unknown) => e);
    expect(inspect(err5, { depth: 10, showHidden: true })).not.toMatch(/test-only|example\.invalid/u);
  });
});

describe("findFreeCopies: the services", () => {
  it("OpenAlex: the best location, then the open locations; version and licence bounded", async () => {
    openalex({
      best_oa_location: { is_oa: true, pdf_url: "https://arxiv.org/pdf/2101.00001v1", version: "submittedVersion", license: "cc-by" },
      locations: [
        { is_oa: false, pdf_url: "https://europepmc.org/closed.pdf", version: "publishedVersion" },
        { is_oa: true, pdf_url: "https://europepmc.org/articles/PMC77?pdf=render", version: "publishedVersion", license: "x".repeat(101) },
        { is_oa: true, pdf_url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC77/pdf/a.pdf", version: "acceptedVersion", license: "cc-by-nc" },
        { is_oa: true, pdf_url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC77/pdf/b.pdf", version: "draft-of-sorts" },
      ],
    });
    const got = await findFreeCopies(ARTICLE, ctx(), ["openalex"]);
    expect(got.offers).toEqual([
      { source: "openalex", url: "https://europepmc.org/articles/PMC77?pdf=render", kind: "pdf", version: "published" },
      { source: "openalex", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC77/pdf/a.pdf", kind: "pdf", version: "accepted", licence: "cc-by-nc" },
      { source: "openalex", url: "https://arxiv.org/pdf/2101.00001v1", kind: "pdf", version: "submitted", licence: "cc-by" },
    ]);
    expect(got.elsewhere).toEqual([]);
  });

  it("OpenAlex denied by the project's rules is not asked", async () => {
    const got = await findFreeCopies(ARTICLE, ctx(client(), ["crossref"]), ["openalex"]);
    expect(got).toEqual({ offers: [], elsewhere: [] });
    expect(requests).toEqual([]);
  });

  it("an Unpaywall pdf on an unlisted host becomes a link, not a fetch", async () => {
    unpaywall({
      doi: DOI,
      is_oa: true,
      best_oa_location: { url_for_pdf: "https://repository.example.edu/bitstream/123/rivers.pdf", url: "https://repository.example.edu/handle/123", version: "acceptedVersion", license: "cc-by" },
      oa_locations: [{ url_for_pdf: "https://arxiv.org/pdf/2101.00001", version: "submittedVersion" }],
    });
    const got = await findFreeCopies(ARTICLE, ctx(), ["unpaywall"], EMAIL);
    expect(got.offers).toEqual([{ source: "unpaywall", url: "https://arxiv.org/pdf/2101.00001", kind: "pdf", version: "submitted" }]);
    expect(got.elsewhere).toEqual([{ host: "repository.example.edu", url: "https://repository.example.edu/bitstream/123/rivers.pdf" }]);
    expect(requests.map((r) => r.origin)).toEqual(["https://api.unpaywall.org"]);
  });

  it("Unpaywall is not asked without an e-mail; the e-mail never reaches the cache or a log", async () => {
    expect(await findFreeCopies(ARTICLE, ctx(), ["unpaywall"])).toEqual({ offers: [], elsewhere: [] });
    expect(await findFreeCopies(ARTICLE, ctx(), ["unpaywall"], "not an address")).toEqual({ offers: [], elsewhere: [] });
    expect(requests).toEqual([]);
    unpaywall({ doi: DOI, is_oa: true, best_oa_location: { url_for_pdf: "https://arxiv.org/pdf/2101.00001", version: "publishedVersion" } });
    const http = client();
    const first = await findFreeCopies(ARTICLE, ctx(http), ["unpaywall"], EMAIL);
    expect(first.offers).toHaveLength(1);
    expect(requests.filter((r) => r.origin === "https://api.unpaywall.org")).toHaveLength(1);
    // A failing Unpaywall: a note without the e-mail; the cache files are scanned in afterEach.
    agent.get("https://api.unpaywall.org").intercept({ path: "/v2/10.5555/broken", query: { email: EMAIL }, method: "GET" }).reply(500, `error for ${EMAIL}`);
    await findFreeCopies({ ...ARTICLE, identifiers: { doi: "10.5555/broken" } }, ctx(http), ["unpaywall"], EMAIL);
    expect(notes.some((n) => n.includes("unpaywall"))).toBe(true);
    // The same answer cached for a DOI is used whatever the e-mail.
    const again = await findFreeCopies(ARTICLE, ctx(client()), ["unpaywall"], "other-test-only@example.invalid");
    expect(again).toEqual(first);
    expect(requests.filter((r) => r.origin === "https://api.unpaywall.org")).toHaveLength(2);
  });

  it("arXiv: the address is built from the checked id; an id that is not one is dropped", async () => {
    arxiv(
      `doi:"${DOI}"`,
      atom([
        { id: "2101.00001v2", title: "Rivers and Memory in Upland Villages", authors: ["Ada Quill"], doi: DOI },
        { id: "../../evil", title: "Rivers and Memory in Upland Villages", authors: ["Ada Quill"], doi: DOI },
        { id: "math.GT/0309136", title: "Rivers and Memory in Upland Villages", authors: ["Ada Quill"], doi: DOI },
        { id: "2101.00001v2?x=1", title: "Rivers and Memory in Upland Villages", authors: ["Ada Quill"], doi: DOI },
      ]),
    );
    const got = await findFreeCopies(ARTICLE, ctx(), ["arxiv"]);
    expect(got.offers).toEqual([
      { source: "arxiv", url: "https://arxiv.org/pdf/2101.00001v2", kind: "pdf" },
      { source: "arxiv", url: "https://arxiv.org/pdf/math.GT/0309136", kind: "pdf" },
    ]);
    expect(JSON.stringify(got)).not.toContain("evil");
  });

  it("arXiv by DOI first; an entry without that DOI must agree by title and author; then by title", async () => {
    arxiv(`doi:"${DOI}"`, atom([{ id: "1901.11111", title: "Something Else Entirely", authors: ["Bo Other"] }]));
    arxiv(ARTICLE_TITLE_Q, atom([{ id: "1901.22222", title: "Rivers and memory in upland villages", authors: ["A. Quill"] }]));
    const got = await findFreeCopies(ARTICLE, ctx(), ["arxiv"]);
    expect(got.offers).toEqual([{ source: "arxiv", url: "https://arxiv.org/pdf/1901.22222", kind: "pdf" }]);
    expect(requests.map((r) => new URL(r.path, "https://x.invalid").searchParams.get("search_query"))).toEqual([`doi:"${DOI}"`, ARTICLE_TITLE_Q]);
  });

  it("arXiv is asked no more than once every 3 seconds", async () => {
    const http = client();
    arxiv(`doi:"${DOI}"`, atom([]));
    arxiv(ARTICLE_TITLE_Q, atom([]));
    arxiv(`doi:"10.5555/second"`, atom([]));
    arxiv(`ti:"a second study of rivers" AND au:quill`, atom([]));
    const second = { ...ARTICLE, title: "A Second Study of Rivers", identifiers: { doi: "10.5555/second" } };
    await Promise.all([findFreeCopies(ARTICLE, ctx(http), ["arxiv"]), findFreeCopies(second, ctx(http), ["arxiv"])]);
    const times = requests.filter((r) => r.origin === "https://export.arxiv.org").map((r) => r.at);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(3000);
  });

  it("arXiv is asked one request at a time, also by two callers at once", async () => {
    const http = client();
    let open = 0;
    let most = 0;
    agent
      .get("https://export.arxiv.org")
      .intercept({ path: (p) => p.startsWith("/api/query?"), method: "GET" })
      .reply(() => {
        open++;
        most = Math.max(most, open);
        // The answer takes a while (many turns of the event loop): long enough for a second request to start.
        return (async () => {
          for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
          open--;
          return { statusCode: 200, data: atom([]) };
        })();
      })
      .times(4);
    const second = { ...ARTICLE, title: "A Second Study of Rivers", identifiers: { doi: "10.5555/second" } };
    await Promise.all([findFreeCopies(ARTICLE, ctx(http), ["arxiv"]), findFreeCopies(second, ctx(http), ["arxiv"])]);
    expect(requests.filter((r) => r.origin === "https://export.arxiv.org")).toHaveLength(4);
    expect(most).toBe(1);
  });

  it("Europe PMC: an open article with a checked pmcid; anything else is not offered", async () => {
    epmc({
      hitCount: 4,
      resultList: {
        result: [
          { doi: "10.5555/OTHER", pmcid: "PMC1", isOpenAccess: "Y" },
          { doi: DOI.toUpperCase(), pmcid: "PMC1/../../x", isOpenAccess: "Y" },
          { doi: DOI, pmcid: "PMC2", isOpenAccess: "N" },
          { doi: DOI, pmcid: "PMC7654321", isOpenAccess: "Y" },
        ],
      },
    });
    const got = await findFreeCopies(ARTICLE, ctx(), ["europepmc"]);
    expect(got.offers).toEqual([{ source: "europepmc", url: "https://europepmc.org/articles/PMC7654321?pdf=render", kind: "pdf" }]);
  });

  it("Semantic Scholar: openAccessPdf, through the host rule", async () => {
    s2({ paperId: "abc", openAccessPdf: { url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5/pdf/x.pdf", status: "GREEN", license: "CCBY" } });
    expect((await findFreeCopies(ARTICLE, ctx(), ["semanticscholar"])).offers).toEqual([
      { source: "semanticscholar", url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5/pdf/x.pdf", kind: "pdf", licence: "CCBY" },
    ]);
  });

  it("DOAB (books, by title): a bitstream on a file host is offered, one elsewhere is a link, another work is not", async () => {
    doab(BOOK_TITLE, [
      {
        name: "The Lantern Keepers of Ostrava",
        metadata: [
          { key: "dc.title", value: "The Lantern Keepers of Ostrava" },
          { key: "dc.contributor.author", value: "Halloway, Mira" },
          { key: "oapen.identifier.downloadUrl", value: "https://library.oapen.org/bitstream/20.500/1/lantern.pdf" },
        ],
        bitstreams: [
          { name: "lantern.epub", mimeType: "application/epub+zip", retrieveLink: "/rest/bitstreams/b1/retrieve" },
          { name: "cover.jpg", mimeType: "image/jpeg", retrieveLink: "/rest/bitstreams/b2/retrieve" },
          { name: "lantern-mirror.pdf", mimeType: "application/pdf", retrieveLink: "https://mirror.example.org/lantern.pdf" },
        ],
      },
      {
        name: "The Lantern Keepers of Ostrava",
        metadata: [{ key: "dc.contributor.author", value: "Somebody, Else" }],
        bitstreams: [{ name: "other.pdf", mimeType: "application/pdf", retrieveLink: "/rest/bitstreams/b9/retrieve" }],
      },
    ]);
    const got = await findFreeCopies(BOOK, ctx(), ["doab"]);
    expect(got.offers).toEqual([
      { source: "doab", url: "https://library.oapen.org/bitstream/20.500/1/lantern.pdf", kind: "pdf" },
      { source: "doab", url: "https://directory.doabooks.org/rest/bitstreams/b1/retrieve", kind: "epub" },
    ]);
    expect(got.elsewhere).toEqual([{ host: "mirror.example.org", url: "https://mirror.example.org/lantern.pdf" }]);
    expect(JSON.stringify(got)).not.toContain("b9");
  });

  it("DOAB and the Internet Archive are asked only for books; a title only to arXiv, DOAB and the Internet Archive", async () => {
    await findFreeCopies(ARTICLE, ctx(), ALL, EMAIL);
    const hosts = new Set(requests.map((r) => r.origin));
    expect(hosts.has("https://directory.doabooks.org")).toBe(false);
    expect(hosts.has("https://archive.org")).toBe(false);
    for (const r of requests) if (r.origin !== "https://export.arxiv.org") expect(decodeURIComponent(r.path).toLowerCase()).not.toContain("upland");
    requests = [];
    await findFreeCopies(BOOK, ctx(), ALL, EMAIL); // no DOI: only the title searches
    expect(new Set(requests.map((r) => r.origin))).toEqual(new Set(["https://export.arxiv.org", "https://directory.doabooks.org", "https://archive.org"]));
  });
});

describe("findFreeCopies: the Internet Archive", () => {
  const Q = `title:("${BOOK_TITLE}") AND creator:(halloway) AND mediatype:texts`;

  it("a public-domain item's PDF is offered at an address built from its checked identifier", async () => {
    iaSearch(Q, ["lanternkeepers00hall", "bad/../id", "x".repeat(101)]);
    iaMeta("lanternkeepers00hall", openIaItem("lanternkeepers00hall", {}, [{ name: "lanternkeepers00hall_djvu.txt" }, { name: "Lantern Keepers (1931).pdf" }, { name: "lantern.epub" }]));
    const got = await findFreeCopies(BOOK, ctx(), ["internetarchive"]);
    expect(got.offers).toEqual([
      { source: "internetarchive", url: "https://archive.org/download/lanternkeepers00hall/Lantern%20Keepers%20(1931).pdf", kind: "pdf" },
      { source: "internetarchive", url: "https://archive.org/download/lanternkeepers00hall/lantern.epub", kind: "epub" },
    ]);
    expect(requests.map((r) => r.path).filter((p) => p.startsWith("/metadata/"))).toEqual(["/metadata/lanternkeepers00hall"]);
  });

  it("an Internet Archive lending-library item is not offered", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["restricted", { "access-restricted-item": "true" }],
      ["restrictedbool", { "access-restricted-item": true }],
      ["restrictedodd", { "access-restricted-item": "maybe" }],
      ["lending", { collection: ["inlibrary", "printdisabled"] }],
      ["nolicence", { licenseurl: undefined }],
      ["alllicence", { licenseurl: "https://example.org/all-rights-reserved" }],
      ["ccvlookalike", { licenseurl: "https://creativecommons.org.evil.example/licenses/by/4.0/" }],
      ["copyrighted", { licenseurl: undefined, "possible-copyright-status": "In copyright" }],
    ];
    iaSearch(Q, cases.map(([id]) => id).slice(0, 5));
    for (const [id, over] of cases.slice(0, 5)) iaMeta(id, openIaItem(id, over));
    expect((await findFreeCopies(BOOK, ctx(), ["internetarchive"])).offers).toEqual([]);
    requests = [];
    iaSearch(Q, cases.map(([id]) => id).slice(5));
    for (const [id, over] of cases.slice(5)) iaMeta(id, openIaItem(id, over));
    expect((await findFreeCopies(BOOK, ctx(client({ libraryRoot: join(tmp, "Lib2") })), ["internetarchive"])).offers).toEqual([]);
  });

  it("an item not in copyright, or under a Creative Commons licence, is offered", async () => {
    iaSearch(Q, ["nic", "ccby"]);
    iaMeta("nic", openIaItem("nic", { licenseurl: undefined, "possible-copyright-status": "NOT_IN_COPYRIGHT" }));
    iaMeta("ccby", openIaItem("ccby", { licenseurl: "https://creativecommons.org/licenses/by/4.0/" }));
    expect((await findFreeCopies(BOOK, ctx(), ["internetarchive"])).offers.map((o) => o.url)).toEqual(["https://archive.org/download/nic/nic.pdf", "https://archive.org/download/ccby/ccby.pdf"]);
  });

  it("an Internet Archive file name with a slash is dropped", async () => {
    iaSearch(Q, ["slashy"]);
    iaMeta("slashy", openIaItem("slashy", {}, [{ name: "../other/x.pdf" }, { name: "a\\b.pdf" }, { name: `${"n".repeat(201)}.pdf` }, { name: "x.pdf.exe" }, { name: 7 }]));
    expect(await findFreeCopies(BOOK, ctx(), ["internetarchive"])).toEqual({ offers: [], elsewhere: [] });
  });

  it("a title search's different work is not offered", async () => {
    iaSearch(Q, ["otherwork", "otherauthor"]);
    iaMeta("otherwork", openIaItem("otherwork", { title: "The Lantern Keepers of Ostrava: Volume Two of the Northern Cycle" }));
    iaMeta("otherauthor", openIaItem("otherauthor", { creator: ["Brook, Tamsin"] }));
    arxiv(`ti:"${BOOK_TITLE}" AND au:halloway`, atom([{ id: "2202.00002", title: "Lantern Keepers", authors: ["Mira Halloway"] }]));
    expect(await findFreeCopies(BOOK, ctx(), ["internetarchive", "arxiv"])).toEqual({ offers: [], elsewhere: [] });
  });
});

describe("findFreeCopies: bounds, failures and order", () => {
  it("a source's 30 locations give 3 offers", async () => {
    openalex({ locations: Array.from({ length: 30 }, (_, i) => ({ is_oa: true, pdf_url: `https://arxiv.org/pdf/2101.${String(i).padStart(5, "0")}`, version: "publishedVersion" })) });
    const got = await findFreeCopies(ARTICLE, ctx(), ["openalex"]);
    expect(got.offers).toHaveLength(3);
    expect(got.offers[0]!.url).toBe("https://arxiv.org/pdf/2101.00000");
  });

  it("at most 12 offers in all, in the plan's order of sources; at most 10 links, one per host and path", async () => {
    const many = (host: string) => Array.from({ length: 5 }, (_, i) => ({ is_oa: true, pdf_url: `https://${host}/f${i}.pdf`, url_for_pdf: `https://${host}/f${i}.pdf` }));
    openalex({
      locations: [
        ...many("arxiv.org"),
        ...Array.from({ length: 14 }, (_, i) => ({ is_oa: true, pdf_url: `https://repo${i}.example.org/x.pdf` })),
        { is_oa: true, pdf_url: "https://repo0.example.org/x.pdf#again" },
      ],
    });
    unpaywall({ oa_locations: many("europepmc.org") });
    arxiv(`doi:"${DOI}"`, atom([1, 2, 3, 4].map((n) => ({ id: `2101.0000${n}`, title: "x", authors: ["y"], doi: DOI }))));
    epmc({ resultList: { result: [9, 10, 11, 12].map((n) => ({ doi: DOI, pmcid: `PMC${n}`, isOpenAccess: "Y" })) } });
    s2({ openAccessPdf: { url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9/pdf/s.pdf" } });
    const got = await findFreeCopies(ARTICLE, ctx(), [...ALL].reverse(), EMAIL);
    expect(got.offers).toHaveLength(FREE_COPY_OFFERS_MAX);
    expect(got.offers.map((o) => o.source)).toEqual([...Array(3).fill("openalex"), ...Array(3).fill("unpaywall"), ...Array(3).fill("arxiv"), ...Array(3).fill("europepmc")]);
    expect(got.elsewhere).toHaveLength(10);
    expect(new Set(got.elsewhere.map((l) => l.host)).size).toBe(10);
    expect(got.elsewhere[0]).toEqual({ host: "repo0.example.org", url: "https://repo0.example.org/x.pdf" });
  });

  it("an elsewhere link that is javascript:, http: or holds a user name is dropped", async () => {
    openalex({
      locations: [
        { is_oa: true, pdf_url: "javascript:alert(1)" },
        { is_oa: true, pdf_url: "http://repo.example.org/plain.pdf" },
        { is_oa: true, pdf_url: "https://user:pw@repo.example.org/a.pdf" },
        { is_oa: true, pdf_url: "https://user@repo.example.org/b.pdf" },
        { is_oa: true, pdf_url: "data:application/pdf;base64,AAAA" },
        { is_oa: true, pdf_url: "file:///etc/passwd" },
        { is_oa: true, pdf_url: "https://127.0.0.1/x.pdf" },
        { is_oa: true, pdf_url: "https://localhost/x.pdf" },
        { is_oa: true, pdf_url: `https://repo.example.org/${"l".repeat(2000)}` },
        { is_oa: true, pdf_url: "https://REPO.example.org/ok.pdf" },
      ],
    });
    const got = await findFreeCopies(ARTICLE, ctx(), ["openalex"]);
    expect(got).toEqual({ offers: [], elsewhere: [{ host: "repo.example.org", url: "https://repo.example.org/ok.pdf" }] });
  });

  it("one failing source does not stop the others", async () => {
    agent.get("https://api.openalex.org").intercept({ path: `/works/doi:${DOI}`, method: "GET" }).reply(500, "down");
    json("https://api.semanticscholar.org", `/graph/v1/paper/DOI:${DOI}?fields=openAccessPdf`, "<html>not json</html>");
    epmc({ resultList: { result: "not a list" } });
    agent.get("https://export.arxiv.org").intercept({ path: (p) => p.startsWith("/api/query"), method: "GET" }).replyWithError(new Error("connection reset"));
    unpaywall({ best_oa_location: { url_for_pdf: "https://europepmc.org/articles/PMC3?pdf=render", version: "publishedVersion" } });
    const got = await findFreeCopies(ARTICLE, ctx(), ALL, EMAIL);
    expect(got.offers).toEqual([{ source: "unpaywall", url: "https://europepmc.org/articles/PMC3?pdf=render", kind: "pdf", version: "published" }]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("a 429 from a source leaves it alone for this call (asked once, no retries)", async () => {
    const http = client({ maxRetries: 3 });
    agent.get("https://api.openalex.org").intercept({ path: `/works/doi:${DOI}`, method: "GET" }).reply(429, "slow down", { headers: { "retry-after": "1" } }).persist();
    iaSearch(`title:("${BOOK_TITLE}") AND creator:(halloway) AND mediatype:texts`, ["a1", "a2"]);
    agent.get("https://archive.org").intercept({ path: "/metadata/a1", method: "GET" }).reply(429, "").persist();
    await findFreeCopies(ARTICLE, ctx(http), ["openalex"]);
    await findFreeCopies(BOOK, ctx(http), ["internetarchive"]);
    expect(requests.filter((r) => r.origin === "https://api.openalex.org")).toHaveLength(1);
    expect(requests.filter((r) => r.path.startsWith("/metadata/")).map((r) => r.path)).toEqual(["/metadata/a1"]);
  });

  it("a hostile or broken answer never throws and never grows", async () => {
    openalex({ best_oa_location: "x", locations: [null, 7, "s", [], { is_oa: "true", pdf_url: "https://arxiv.org/pdf/1" }, { is_oa: true, pdf_url: ["https://arxiv.org/pdf/2"] }, { is_oa: true, pdf_url: "https://arxiv.org/pdf/3", version: { a: 1 }, license: 5 }] });
    s2({ openAccessPdf: { url: { href: "https://arxiv.org/pdf/4" } } });
    epmc([1, 2, 3]);
    arxiv(`doi:"${DOI}"`, `<!DOCTYPE feed [<!ENTITY a "aaaaaaaaaa">]><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>&a;</id></entry></feed>`);
    arxiv(ARTICLE_TITLE_Q, "<feed><entry><id>http://arxiv.org/abs/2101.00009</id>"); // not well-formed
    unpaywall({ oa_locations: { length: 1e9 } });
    const got = await findFreeCopies(ARTICLE, ctx(), ALL, EMAIL);
    expect(got).toEqual({ offers: [{ source: "openalex", url: "https://arxiv.org/pdf/3", kind: "pdf" }], elsewhere: [] });
  });

  it("an answer over the client's 5 MB limit is refused and the source skipped", async () => {
    openalex(JSON.stringify({ best_oa_location: { is_oa: true, pdf_url: "https://arxiv.org/pdf/1" }, pad: "x".repeat(10 * 1024 * 1024) }));
    s2({ openAccessPdf: { url: "https://arxiv.org/pdf/2101.00002" } });
    const got = await findFreeCopies(ARTICLE, ctx(), ["openalex", "semanticscholar"]);
    expect(got.offers.map((o) => o.source)).toEqual(["semanticscholar"]);
  });

  it("the same file from two services is offered once, by the first in the plan's order", async () => {
    openalex({ best_oa_location: { is_oa: true, pdf_url: "https://arxiv.org/pdf/2101.00001" } });
    s2({ openAccessPdf: { url: "https://arxiv.org/pdf/2101.00001" } });
    expect((await findFreeCopies(ARTICLE, ctx(), ["semanticscholar", "openalex"])).offers).toEqual([{ source: "openalex", url: "https://arxiv.org/pdf/2101.00001", kind: "pdf" }]);
  });

  it("a work without a usable DOI is not asked by DOI; unknown sources are ignored", async () => {
    const odd = { ...ARTICLE, identifiers: { doi: "not-a-doi" } };
    await findFreeCopies(odd, ctx(), ["openalex", "unpaywall", "europepmc", "semanticscholar", "nonsense" as FreeCopySource], EMAIL);
    expect(requests).toEqual([]);
  });

  it("the key goes to OpenAlex only (the client holds none yet: no request of this file carries one)", async () => {
    // F12 gives the client an OpenAlex key; until then no request may carry an Authorization header at all
    // (checked for every request of every test in afterEach, and in fetch-file.test.ts).
    openalex({ best_oa_location: { is_oa: true, pdf_url: "https://arxiv.org/pdf/2101.00001" } });
    await findFreeCopies(ARTICLE, ctx(), ALL, EMAIL);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });
});
