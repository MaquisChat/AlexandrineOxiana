import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GOVERNANCE, type GovernanceConfig } from "@ao/core";
import { Agent, MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary } from "../library.js";
import { openTestRepo } from "../repo/testing.js";
import { datePartsToEdtf, mapCrossref } from "./crossref.js";
import { mapLocMods } from "./loc.js";
import { DEFAULT_ATTEMPT_TIMEOUT_MS, HttpClient, LookupHttpError, USER_AGENT } from "./http.js";
import { lookupContextFor, lookupDoi, lookupIsbn, searchTitle, type LookupContext } from "./index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

const DOI = "10.5555/ao.fixture.2021.001";
const ISBN = "9780262033848";
const UA = "AlexandrineOxiana/0.0.0 (+https://github.com/maquiscatta-sys/AlexandrineOxiana)";
// Not a real address: example.org is reserved for documentation (RFC 2606).
const EMAIL = "researcher@example.org";

let tmp: string;
let agent: MockAgent;
let now: number;
let sleeps: number[];
let notes: string[];

const sleep = async (ms: number) => {
  sleeps.push(ms);
  now += ms;
};

function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, clock: () => now, sleep, ...extra });
}

function policy(providers: string[]): GovernanceConfig {
  return { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: providers } };
}

function ctx(http: HttpClient, providers: string[] | null = ["crossref", "openalex", "openlibrary", "loc"], extra: Partial<LookupContext> = {}): LookupContext {
  return {
    http,
    policy: providers ? policy(providers) : null,
    projectId: "P1",
    actor: "tester",
    clock: () => new Date("2026-11-10T12:00:00Z"),
    debug: (n) => notes.push(n),
    sensitive: false,
    ...extra,
  };
}

const crossref = () => agent.get("https://api.crossref.org");
const openalex = () => agent.get("https://api.openalex.org");
const openlibrary = () => agent.get("https://openlibrary.org");
const loc = () => agent.get("http://lx2.loc.gov:210");
const CR_PATH = `/works/${DOI}`;
const OA_PATH = `/works/doi:${DOI}`;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-lookup-"));
  agent = new MockAgent();
  agent.disableNetConnect();
  now = 1_000_000;
  sleeps = [];
  notes = [];
});

afterEach(async () => {
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("lookupDoi", () => {
  it("maps a recorded Crossref response", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    const r = await lookupDoi(DOI, ctx(client()));
    expect(r).toEqual({
      title: "Rivers and Memory in Upland Villages",
      creators: [
        { given: "Amara", family: "Okafor", role: "author" },
        { given: "Henrik", family: "Lindqvist", role: "author" },
      ],
      issued: "2021-03-04",
      container: "Journal of Upland Studies",
      publisher: "Example University Press",
      volume: "12",
      issue: "3",
      page: "201-219",
      edition: "2",
      type: "article-journal",
      identifiers: { doi: DOI, issn: "1234-5679" },
      provider: "crossref",
    });
    agent.assertNoPendingInterceptors();
  });

  it("serves the second call from the on-disk cache (one request), file named sha256(cacheKey), 0600 in a 0700 dir", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const http = client({ contactEmail: EMAIL });
    const first = await lookupDoi(DOI, ctx(http));
    const second = await lookupDoi(DOI, ctx(http));
    expect(second).toEqual(first);
    // A fresh client (no memory cache) reads the disk cache: still no second request.
    const third = await lookupDoi(DOI, ctx(client()));
    expect(third).toEqual(first);
    agent.assertNoPendingInterceptors();

    const dir = join(tmp, "Lib", ".cache", "lookups");
    const files = await readdir(dir);
    expect(files).toEqual([`${createHash("sha256").update(`crossref:doi:${DOI}`).digest("hex")}.json`]);
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, files[0]!))).mode & 0o777).toBe(0o600);
    }
    const raw = await readFile(join(dir, files[0]!), "utf8");
    expect(raw).not.toContain(EMAIL);
    expect(raw.toLowerCase()).not.toContain("user-agent");
    expect(raw).not.toContain("AlexandrineOxiana/");
  });

  it("an expired cache entry (older than 30 days) is fetched again", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(2);
    await lookupDoi(DOI, ctx(client()));
    now += 31 * 86_400_000;
    await lookupDoi(DOI, ctx(client()));
    agent.assertNoPendingInterceptors();
  });

  it("sensitive lookups (encrypted project) are cached in memory only", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const http = client();
    const c = ctx(http, undefined, { sensitive: true });
    const a = await lookupDoi(DOI, c);
    const b = await lookupDoi(DOI, c);
    expect(b).toEqual(a);
    agent.assertNoPendingInterceptors();
    expect(existsSync(join(tmp, "Lib", ".cache", "lookups")) ? await readdir(join(tmp, "Lib", ".cache", "lookups")) : []).toEqual([]);
  });

  it("purgeSensitive() forgets sensitive responses (project locked)", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(2);
    const http = client();
    const c = ctx(http, undefined, { sensitive: true });
    await lookupDoi(DOI, c);
    http.purgeSensitive();
    await lookupDoi(DOI, c); // asked again: the memory entry is gone
    agent.assertNoPendingInterceptors();
  });

  it("retries after 429 (honouring Retry-After) and succeeds", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(429, "slow down", { headers: { "retry-after": "2" } });
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    const r = await lookupDoi(DOI, ctx(client()));
    expect(r?.provider).toBe("crossref");
    expect(sleeps).toContain(2000);
    agent.assertNoPendingInterceptors();
  });

  it("caps Retry-After and backs off exponentially on 5xx", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(503, "", { headers: { "retry-after": "86400" } });
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(502, "");
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(500, "");
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    const r = await lookupDoi(DOI, ctx(client({ maxRetryAfterMs: 30_000 })));
    expect(r?.provider).toBe("crossref");
    expect(sleeps).toEqual([30_000, 1_000, 2_000]);
  });

  it("after 3 failed retries the provider is given up and the next one is tried", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(500, "").times(4);
    openalex().intercept({ path: OA_PATH, method: "GET" }).reply(200, fixture("openalex-work.json"), JSON_HEADERS);
    const r = await lookupDoi(DOI, ctx(client()));
    expect(r?.provider).toBe("openalex");
    agent.assertNoPendingInterceptors();
  });

  it("throws when every allowed provider fails", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(500, "").times(4);
    openalex().intercept({ path: OA_PATH, method: "GET" }).reply(400, "bad");
    await expect(lookupDoi(DOI, ctx(client()))).rejects.toBeInstanceOf(LookupHttpError);
  });

  it("denied crossref → falls back to OpenAlex, silently (debug note only)", async () => {
    openalex().intercept({ path: OA_PATH, method: "GET" }).reply(200, fixture("openalex-work.json"), JSON_HEADERS);
    const r = await lookupDoi(DOI, ctx(client(), ["openalex"]));
    expect(r).toEqual({
      title: "Rivers and Memory in Upland Villages",
      creators: [
        { given: "Amara", family: "Okafor", role: "author" },
        { given: "Henrik", family: "Lindqvist", role: "author" },
      ],
      issued: "2021-03-04",
      container: "Journal of Upland Studies",
      publisher: "Example University Press",
      volume: "12",
      issue: "3",
      page: "201–219",
      type: "article-journal",
      identifiers: { doi: DOI },
      provider: "openalex",
    });
    expect(notes.some((n) => n.includes("crossref") && n.includes("not permitted"))).toBe(true);
    agent.assertNoPendingInterceptors();
  });

  it("a 404 from Crossref falls through to OpenAlex; 404 everywhere → null", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(404, "Resource not found.");
    openalex().intercept({ path: OA_PATH, method: "GET" }).reply(404, "");
    expect(await lookupDoi(DOI, ctx(client()))).toBeNull();
  });

  it("every provider denied, or no readable policy → null without any request", async () => {
    expect(await lookupDoi(DOI, ctx(client(), []))).toBeNull();
    expect(await lookupDoi(DOI, ctx(client(), null))).toBeNull();
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  it("sends exactly the brief's User-Agent; the contact email is appended only when set", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET", headers: { "user-agent": UA } }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    expect(USER_AGENT).toBe(UA);
    await lookupDoi(DOI, ctx(client()));
    crossref()
      .intercept({ path: "/works/10.5555/other", method: "GET", headers: { "user-agent": `AlexandrineOxiana/0.0.0 (+https://github.com/maquiscatta-sys/AlexandrineOxiana; mailto:${EMAIL})` } })
      .reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    await lookupDoi("10.5555/other", ctx(client({ contactEmail: EMAIL })));
    agent.assertNoPendingInterceptors();
  });

  it("ignores a contact email that could inject header text", () => {
    expect(client({ contactEmail: "a@b.example\r\nX-Evil: 1" }).userAgent).toBe(UA);
  });
});

describe("cache and transport hardening", () => {
  const cacheFile = (key: string) => join(tmp, "Lib", ".cache", "lookups", `${createHash("sha256").update(key).digest("hex")}.json`);

  it("an entry stored in the future is treated as expired", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(2);
    await lookupDoi(DOI, ctx(client()));
    const f = cacheFile(`crossref:doi:${DOI}`);
    const e = JSON.parse(await readFile(f, "utf8")) as { storedAt: number };
    e.storedAt = now + 10 * 86_400_000;
    await writeFile(f, JSON.stringify(e));
    await lookupDoi(DOI, ctx(client()));
    agent.assertNoPendingInterceptors();
  });

  it("not-found answers are cached for one day only", async () => {
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(404, "").times(2);
    openalex().intercept({ path: OA_PATH, method: "GET" }).reply(404, "").times(2);
    expect(await lookupDoi(DOI, ctx(client()))).toBeNull();
    now += 12 * 3_600_000;
    expect(await lookupDoi(DOI, ctx(client()))).toBeNull(); // still cached
    expect(agent.pendingInterceptors().map((i) => i.origin).sort()).toEqual(["https://api.crossref.org", "https://api.openalex.org"]);
    now += 13 * 3_600_000;
    expect(await lookupDoi(DOI, ctx(client()))).toBeNull();
    agent.assertNoPendingInterceptors();
  });

  it("a 200 that is not JSON is never cached", async () => {
    const http = client();
    crossref().intercept({ path: "/j", method: "GET" }).reply(200, "<html>oops</html>");
    await expect(http.getJson("https://api.crossref.org/j", { cacheKey: "t:j" })).rejects.toBeInstanceOf(LookupHttpError);
    crossref().intercept({ path: "/j", method: "GET" }).reply(200, '{"ok":true}', JSON_HEADERS);
    expect(await http.getJson("https://api.crossref.org/j", { cacheKey: "t:j" })).toEqual({ ok: true });
    agent.assertNoPendingInterceptors();
  });

  it("never reads the cache through a symlinked .cache directory", async () => {
    if (process.platform === "win32") return;
    const planted = join(tmp, "planted");
    await mkdir(join(planted, "lookups"), { recursive: true });
    const entry = { v: 1, storedAt: now, status: 200, body: JSON.stringify({ message: { title: ["Planted"], type: "book" } }) };
    await writeFile(join(planted, "lookups", `${createHash("sha256").update(`crossref:doi:${DOI}`).digest("hex")}.json`), JSON.stringify(entry));
    await mkdir(join(tmp, "Lib"), { recursive: true });
    await symlink(planted, join(tmp, "Lib", ".cache"));
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    expect((await lookupDoi(DOI, ctx(client())))?.title).toBe("Rivers and Memory in Upland Villages");
    agent.assertNoPendingInterceptors();
  });

  it("a LoC 200 that is not an SRU response is never cached", async () => {
    loc().intercept({ path: (p: string) => p.startsWith("/LCDB?"), method: "GET" }).reply(200, "<html><title>No Connections Available</title></html>").times(2);
    // An outage page is "LoC unavailable" (the only permitted provider failed), and is asked again next time.
    await expect(lookupIsbn(ISBN, ctx(client(), ["loc"]))).rejects.toBeInstanceOf(LookupHttpError);
    await expect(lookupIsbn(ISBN, ctx(client(), ["loc"]))).rejects.toBeInstanceOf(LookupHttpError);
    agent.assertNoPendingInterceptors();
  });

  it("time spent queued for the rate limit does not count against the attempt deadline", async () => {
    openlibrary().intercept({ path: (p: string) => p.startsWith("/q"), method: "GET" }).reply(200, "{}", JSON_HEADERS).times(4);
    const http = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: agent, rateLimits: { "openlibrary.org": 10 }, attemptTimeoutMs: 150, maxRetries: 0 });
    const rs = await Promise.all(["1", "2", "3", "4"].map((k) => http.getJson(`https://openlibrary.org/q${k}`, { cacheKey: `t:q${k}`, sensitive: false })));
    expect(rs).toEqual([{}, {}, {}, {}]);
  });

  it("R247 (c): once told to stop writing to disk, a late answer writes nothing; told again, it writes", async () => {
    await mkdir(join(tmp, "Lib"));
    const http = client();
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(2);
    http.setDiskCache(false);
    expect((await lookupDoi(DOI, ctx(http)))?.provider).toBe("crossref");
    expect(existsSync(join(tmp, "Lib", ".cache"))).toBe(false);
    http.setDiskCache(true);
    expect((await lookupDoi(DOI, ctx(client())))?.provider).toBe("crossref");
    expect(existsSync(join(tmp, "Lib", ".cache", "lookups"))).toBe(true);
  });

  it("R247 (c): a library folder removed after the client was made is never created again by a cache write", async () => {
    await mkdir(join(tmp, "Lib"));
    const http = client();
    await rm(join(tmp, "Lib"), { recursive: true });
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    expect((await lookupDoi(DOI, ctx(http)))?.provider).toBe("crossref");
    expect(existsSync(join(tmp, "Lib"))).toBe(false);
  });

  it("refuses to write through a symlinked cache directory", async () => {
    if (process.platform === "win32") return;
    const elsewhere = join(tmp, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(tmp, "Lib", ".cache"), { recursive: true });
    await symlink(elsewhere, join(tmp, "Lib", ".cache", "lookups"));
    crossref().intercept({ path: CR_PATH, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS);
    expect((await lookupDoi(DOI, ctx(client())))?.provider).toBe("crossref");
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await stat(elsewhere)).mode & 0o777).not.toBe(0o700);
  });

  it("each attempt has an overall deadline (a server that trickles forever)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const real = new Agent();
    try {
      const http = new HttpClient({ libraryRoot: join(tmp, "Lib"), dispatcher: real, sleep, attemptTimeoutMs: 300, maxRetries: 0 });
      const t0 = performance.now();
      await expect(http.getJson(`http://127.0.0.1:${port}/slow`, { cacheKey: "t:slow" })).rejects.toBeInstanceOf(LookupHttpError);
      expect(performance.now() - t0).toBeLessThan(3000);
    } finally {
      await real.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("the default attempt deadline is 60 s", () => {
    expect(DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(60_000);
  });

  it("LoC MODS parsing is linear on unclosed tags", () => {
    const t0 = performance.now();
    expect(mapLocMods("<mods>" + "<name type=\"personal\"><namePart>".repeat(100_000), ISBN)).toBeNull();
    expect(mapLocMods("<zs:x>" + "<mods>".repeat(200_000), ISBN)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("Crossref date-parts stop at the first null", () => {
    expect(datePartsToEdtf([[2020, null, 5]])).toBe("2020");
    expect(datePartsToEdtf([[2020, 7, null]])).toBe("2020-07");
    expect(datePartsToEdtf([[null]])).toBeUndefined();
  });

  it("Crossref title and subtitle: a title ending in a colon, a question mark or an exclamation mark is joined with a space (R272)", () => {
    const titleOf = (title: string, subtitle: string) => mapCrossref({ title: [title], subtitle: [subtitle] }, "10.1/x")?.title;
    expect(titleOf("Deep Play:", "Notes on the Balinese Cockfight")).toBe("Deep Play: Notes on the Balinese Cockfight");
    expect(titleOf("What Is History?", "A Reply")).toBe("What Is History? A Reply");
    expect(titleOf("Stop!", "A Warning")).toBe("Stop! A Warning");
    expect(titleOf("Deep Play", "Notes on the Balinese Cockfight")).toBe("Deep Play: Notes on the Balinese Cockfight");
  });
});

describe("rate limits", () => {
  it("spaces requests to one host (Open Library: 1 req/s)", async () => {
    const http = client();
    openlibrary().intercept({ path: "/a.json", method: "GET" }).reply(200, "{}", JSON_HEADERS);
    openlibrary().intercept({ path: "/b.json", method: "GET" }).reply(200, "{}", JSON_HEADERS);
    crossref().intercept({ path: "/c", method: "GET" }).reply(200, "{}", JSON_HEADERS);
    await http.getJson("https://openlibrary.org/a.json", { cacheKey: "t:a" });
    await http.getJson("https://openlibrary.org/b.json", { cacheKey: "t:b" });
    await http.getJson("https://api.crossref.org/c", { cacheKey: "t:c" });
    expect(sleeps).toEqual([1000]); // crossref is a different host: no wait
  });

  it("Crossref and OpenAlex allow 5 req/s", async () => {
    const http = client();
    openalex().intercept({ path: (p: string) => p.startsWith("/x"), method: "GET" }).reply(200, "{}", JSON_HEADERS).times(3);
    for (const k of ["1", "2", "3"]) await http.getJson(`https://api.openalex.org/x${k}`, { cacheKey: `t:${k}` });
    expect(sleeps).toEqual([200, 200]);
  });
});

describe("lookupIsbn", () => {
  it("Open Library edition (following its redirect) plus author records", async () => {
    openlibrary().intercept({ path: `/isbn/${ISBN}.json`, method: "GET" }).reply(302, "", { headers: { location: "/books/OL1000001M.json" } });
    openlibrary().intercept({ path: "/books/OL1000001M.json", method: "GET" }).reply(200, fixture("openlibrary-edition.json"), JSON_HEADERS);
    openlibrary().intercept({ path: "/authors/OL2000001A.json", method: "GET" }).reply(200, fixture("openlibrary-author-1.json"), JSON_HEADERS);
    openlibrary().intercept({ path: "/authors/OL2000002A.json", method: "GET" }).reply(200, fixture("openlibrary-author-2.json"), JSON_HEADERS);
    const r = await lookupIsbn("0-262-03384-4", ctx(client()));
    expect(r).toEqual({
      title: "The Weaver's Almanac: A Year at the Loom",
      creators: [
        { given: "Ngozi", family: "Adebayo", role: "author" },
        { given: "Tomás", family: "Herrera", role: "author" },
      ],
      issued: "2009-05-01",
      publisher: "Harbour Books",
      publisherPlace: "Lagos",
      edition: "2nd ed.",
      numberOfPages: "312",
      collectionTitle: "Craft Histories",
      type: "book",
      identifiers: { isbn: [ISBN] },
      provider: "openlibrary",
    });
    agent.assertNoPendingInterceptors();
  });

  it("a redirect to another host is not followed", async () => {
    openlibrary().intercept({ path: `/isbn/${ISBN}.json`, method: "GET" }).reply(302, "", { headers: { location: "https://evil.example/x.json" } });
    agent.get("https://evil.example").intercept({ path: "/x.json", method: "GET" }).reply(200, fixture("openlibrary-edition.json"), JSON_HEADERS);
    loc().intercept({ path: (p: string) => p.startsWith("/LCDB?"), method: "GET" }).reply(200, fixture("loc-sru-empty.xml"));
    await expect(lookupIsbn(ISBN, ctx(client()))).resolves.toBeNull();
    const pending = agent.pendingInterceptors();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.origin).toBe("https://evil.example");
  });

  it("sensitive lookups never use the Library of Congress (plain HTTP)", async () => {
    openlibrary().intercept({ path: `/isbn/${ISBN}.json`, method: "GET" }).reply(404, "");
    loc().intercept({ path: (p: string) => p.startsWith("/LCDB?"), method: "GET" }).reply(200, fixture("loc-sru-mods.xml"));
    expect(await lookupIsbn(ISBN, ctx(client(), undefined, { sensitive: true }))).toBeNull();
    expect(agent.pendingInterceptors().map((i) => i.origin)).toEqual(["http://lx2.loc.gov:210"]);
    expect(notes.some((n) => n.includes("loc") && /encrypted|sensitive/u.test(n))).toBe(true);
  });

  it("a context built by hand without `sensitive` is treated as sensitive (fail closed)", async () => {
    openlibrary().intercept({ path: `/isbn/${ISBN}.json`, method: "GET" }).reply(404, "");
    loc().intercept({ path: (p: string) => p.startsWith("/LCDB?"), method: "GET" }).reply(200, fixture("loc-sru-mods.xml"));
    const c = ctx(client());
    delete (c as { sensitive?: boolean }).sensitive;
    expect(await lookupIsbn(ISBN, c)).toBeNull();
    expect(agent.pendingInterceptors()).toHaveLength(1); // LoC not asked
    expect(existsSync(join(tmp, "Lib", ".cache"))).toBe(false); // nothing cached on disk
  });

  it("denied Open Library → Library of Congress SRU (MODS)", async () => {
    let seen = "";
    loc()
      .intercept({
        path: (p: string) => {
          seen = p;
          return p.startsWith("/LCDB?");
        },
        method: "GET",
      })
      .reply(200, fixture("loc-sru-mods.xml"), { headers: { "content-type": "text/xml" } });
    const r = await lookupIsbn(ISBN, ctx(client(), ["loc"]));
    expect(seen).toBe(`/LCDB?version=1.1&operation=searchRetrieve&query=bath.isbn%3D${ISBN}&maximumRecords=1&recordSchema=mods`);
    expect(r).toEqual({
      title: "The weaver's almanac: a year at the loom",
      creators: [
        { family: "Adebayo", given: "Ngozi", role: "author" },
        { family: "Herrera", given: "Tomás", role: "translator" },
      ],
      issued: "2009",
      publisher: "Harbour Books",
      type: "book",
      identifiers: { isbn: [ISBN] },
      provider: "loc",
    });
  });

  it("an invalid ISBN is not looked up", async () => {
    expect(await lookupIsbn("978-0-00-000000-1", ctx(client()))).toBeNull();
  });
});

describe("searchTitle", () => {
  it("returns OpenAlex candidates", async () => {
    let seen = "";
    openalex()
      .intercept({
        path: (p: string) => {
          seen = p;
          return p.startsWith("/works?");
        },
        method: "GET",
      })
      .reply(200, fixture("openalex-search.json"), JSON_HEADERS);
    const rs = await searchTitle("Rivers and Memory", "Okafor", ctx(client()));
    expect(new URL(seen, "https://x").searchParams.get("search")).toBe("Rivers and Memory Okafor");
    expect(rs.map((r) => [r.title, r.type, r.identifiers.doi, r.issued])).toEqual([
      ["Rivers and Memory in Upland Villages", "article-journal", DOI, "2021-03-04"],
      ["Rivers of Memory", "book", undefined, "1999-01-01"],
    ]);
    expect(rs[1]!.creators).toEqual([{ given: "Joan", family: "Rivers", role: "author" }]);
  });

  it("OpenAlex denied → no candidates, no request", async () => {
    expect(await searchTitle("Anything", undefined, ctx(client(), ["crossref"]))).toEqual([]);
  });
});

describe("lookupContextFor", () => {
  it("takes the project's policy, and marks encrypted projects sensitive", async () => {
    const deps: Deps = {
      clock: () => new Date(),
      deviceId: "d",
      hostname: "h",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "config"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const lib = await createLibrary(join(tmp, "Lib2"), "Lib2", deps);
    const repo = await openTestRepo(lib, new KeyRing(), { scryptN: 2 ** 10, actor: "tester" });
    const gov = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\nprocessing:\n  metadata_lookup: [openalex]\n";
    const plain = await repo.createProject({ name: "Plain", governanceYaml: gov, encryption: { enabled: false } });
    const enc = await repo.createProject({ name: "Enc", governanceYaml: gov, encryption: { enabled: true, passphrase: "pw" } });
    const http = client();
    const a = await lookupContextFor(repo, plain.project.id, http);
    const b = await lookupContextFor(repo, enc.project.id, http);
    expect(a).toMatchObject({ projectId: plain.project.id, actor: "tester", sensitive: false });
    expect(a.policy?.processing.metadata_lookup).toEqual(["openalex"]);
    expect(b.sensitive).toBe(true);
  });
});
