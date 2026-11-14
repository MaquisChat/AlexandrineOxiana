/**
 * Task F15 (R324 d, e): the library's address worked out from a pasted link, the address for a work through it, and
 * "Where to get it". Pure functions: nothing here reaches any network (no request is made by anything tested).
 */
import { describe, expect, it } from "vitest";
import type { WorkCandidate } from "./candidates.js";
import {
  CATALOGUE_QUERY_MAX,
  LIBRARY_LINK_MAX,
  WHERE_TO_GET_IT_MAX,
  WHERE_URL_MAX,
  catalogueTemplateOk,
  deriveLibraryAccess,
  deriveLibraryAccessWhy,
  isLibraryAccess,
  libraryAccessHost,
  libraryAddressFor,
  whereToGetIt,
  type LibraryAccess,
} from "./where.js";
import type { OfferLink } from "./types.js";

const work = (o: Partial<WorkCandidate> & { doi?: string; isbn?: string[] } = {}): WorkCandidate => ({
  id: "w1",
  title: o.title ?? "Zorblatt Grammar of Habitus",
  creators: o.creators ?? [{ role: "author", family: "Quillfeather", given: "Mirabel" }],
  type: o.type ?? "article-journal",
  identifiers: { ...(o.doi ? { doi: o.doi } : {}), ...(o.isbn ? { isbn: o.isbn } : {}) },
  providers: [],
});

const EZ: LibraryAccess = { kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu/login?url=" };
const OA: LibraryAccess = { kind: "openathens", base: "https://go.openathens.net/redirector/example.edu?url=" };
const OU: LibraryAccess = { kind: "openurl", base: "https://resolver.example.edu/openurl/44EX" };

describe("deriveLibraryAccess: the four forms, in the plan's order", () => {
  it("an EZproxy link with url= gives its login base", () => {
    expect(deriveLibraryAccess("https://ezproxy.lib.example.edu/login?url=https://www.jstor.org/stable/123")).toEqual(EZ);
    expect(deriveLibraryAccess("https://ezproxy.lib.example.edu/login?qurl=https%3A%2F%2Fwww.jstor.org%2Fstable%2F123")).toEqual(EZ);
    // A port is allowed and kept.
    expect(deriveLibraryAccess("https://proxy.example.edu:2443/login?url=https://x.example.org/")).toEqual({ kind: "ezproxy-login", base: "https://proxy.example.edu:2443/login?url=" });
    // The session's ticket in the query is never kept: only the name of the target parameter.
    const a = deriveLibraryAccess("https://ezproxy.lib.example.edu/login?ticket=SESSION-SECRET-42&url=https://www.jstor.org/stable/1#frag")!;
    expect(JSON.stringify(a)).not.toContain("SESSION-SECRET-42");
    expect(JSON.stringify(a)).not.toContain("jstor");
    expect(a).toEqual(EZ);
  });

  it("a hyphenated proxy host gives its login base", () => {
    expect(deriveLibraryAccess("https://www-jstor-org.ezproxy.lib.example.edu/stable/123?seq=1")).toEqual(EZ);
    // EZproxy's double hyphen stands for a hyphen of the original host.
    expect(deriveLibraryAccess("https://onlinelibrary-wiley-com.ezproxy.lib.example.edu/doi/10.1/x")).toEqual(EZ);
    expect(deriveLibraryAccess("https://www-my--site-co-uk.proxy.example.ac.uk/a")).toEqual({ kind: "ezproxy-login", base: "https://proxy.example.ac.uk/login?url=" });
    // With a port, the port goes with the proxy's host.
    expect(deriveLibraryAccess("https://www-jstor-org.ezproxy.lib.example.edu:8443/stable/1")).toEqual({ kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu:8443/login?url=" });
  });

  it("a hyphenated first label that does not read as a host is not a proxy", () => {
    expect(deriveLibraryAccess("https://my-library.edu/catalogue?q=x")).toBeNull();
    expect(deriveLibraryAccess("https://my-library.example.edu/catalogue?q=x")).toBeNull();
    expect(deriveLibraryAccess("https://www-jstor-org.edu/stable/1")).toBeNull(); // nothing left but a top-level name
    expect(deriveLibraryAccessWhy("https://my-library.edu/catalogue?q=x")).toEqual({ refused: "not-library" });
  });

  it("an OpenAthens redirector link gives its redirector (UNVERIFIED form)", () => {
    expect(deriveLibraryAccess("https://go.openathens.net/redirector/example.edu?url=https%3A%2F%2Fwww.jstor.org%2Fstable%2F1")).toEqual(OA);
    expect(deriveLibraryAccess("https://go.openathens.net/redirector/not_a_host?url=x")).toBeNull();
  });

  it("an OpenURL link gives its resolver", () => {
    expect(deriveLibraryAccess("https://resolver.example.edu/openurl/44EX?url_ver=Z39.88-2004&rft_id=info:doi/10.1/x&sid=SESSION-SECRET")).toEqual(OU);
    expect(deriveLibraryAccess("https://resolver.example.edu/openurl/44EX?ctx_ver=Z39.88-2004&rft.atitle=x")).toEqual(OU);
    expect(deriveLibraryAccess("https://resolver.example.edu/openurl/44EX?rft.issn=1234-5678")).toEqual(OU);
    // A session in the path (";jsessionid=…") is not kept.
    expect(deriveLibraryAccess("https://resolver.example.edu/openurl/44EX;jsessionid=SESSION-SECRET?rft_id=info:doi/10.1/x")).toEqual(OU);
  });

  it("a plain publisher link is not a library address", () => {
    expect(deriveLibraryAccessWhy("https://www.jstor.org/stable/123")).toEqual({ refused: "not-library" });
    expect(deriveLibraryAccess("https://doi.org/10.1038/171737a0")).toBeNull();
  });

  it("the order: a /login?url= link on a hyphenated host is taken as its own login", () => {
    expect(deriveLibraryAccess("https://www-jstor-org.ezproxy.lib.example.edu/login?url=https://x.example.org/")).toEqual({ kind: "ezproxy-login", base: "https://www-jstor-org.ezproxy.lib.example.edu/login?url=" });
  });
});

describe("deriveLibraryAccess: hostile links (R324 e)", () => {
  const cases: Array<[string, string, ReturnType<typeof deriveLibraryAccessWhy>]> = [
    ["javascript:", "javascript:alert(1)//login?url=", { refused: "not-https" }],
    ["data:", "data:text/html,<a/href='https://x/login?url='>", { refused: "not-https" }],
    ["file:", "file:///etc/login?url=x", { refused: "not-https" }],
    ["http:", "http://ezproxy.lib.example.edu/login?url=https://x.example.org/", { refused: "not-https" }],
    ["user and password", "https://user:pw@ezproxy.lib.example.edu/login?url=x", { refused: "userinfo" }],
    ["a host behind a user name", "https://lib.example.edu@evil.example/login?url=x", { refused: "userinfo" }],
    ["a trailing dot", "https://ezproxy.lib.example.edu./login?url=x", { refused: "bad-host" }],
    ["an IPv6 literal", "https://[::1]/login?url=x", { refused: "bad-host" }],
    ["an IPv4 address", "https://127.0.0.1/login?url=x", { refused: "bad-host" }],
    ["a single-label host", "https://localhost/login?url=x", { refused: "bad-host" }],
    ["login?url= only inside another parameter's value", "https://www.jstor.org/action?next=%2Flogin%3Furl%3Dx", { refused: "not-library" }],
    ["login?url= inside the path's text", "https://www.jstor.org/search/login%3Furl%3D", { refused: "not-library" }],
    ["a fragment holding the form", "https://www.jstor.org/x#/login?url=https://y.example.org/", { refused: "not-library" }],
    ["a control character", "https://ezproxy.lib.example.edu/log\u0000in?url=x", { refused: "unreadable" }],
    ["a tab inside the scheme", "java\tscript:alert(1)", { refused: "unreadable" }],
    ["a newline inside the host", "https://ezproxy.lib\n.example.edu/login?url=x", { refused: "unreadable" }],
    ["a space inside", "https://ezproxy.lib.example.edu/login ?url=x", { refused: "unreadable" }],
    ["not a link", "ezproxy login", { refused: "unreadable" }],
    ["4,097 characters", `https://ezproxy.lib.example.edu/login?url=https://x.example.org/${"a".repeat(LIBRARY_LINK_MAX)}`.slice(0, LIBRARY_LINK_MAX + 1), { refused: "too-long" }],
  ];
  for (const [what, link, want] of cases) {
    it(`${what}: ${JSON.stringify(want)}`, () => {
      expect(deriveLibraryAccessWhy(link)).toEqual(want);
      expect(deriveLibraryAccess(link)).toBeNull();
    });
  }

  it("upper case is folded and an international host is kept in its ASCII form", () => {
    expect(deriveLibraryAccess("HTTPS://EZPROXY.LIB.EXAMPLE.EDU/login?url=x")).toEqual(EZ);
    expect(deriveLibraryAccess("https://bücherei.example.de/login?url=x")).toEqual({ kind: "ezproxy-login", base: "https://xn--bcherei-n2a.example.de/login?url=" });
    expect(deriveLibraryAccess("https://xn--bcherei-n2a.example.de/login?url=x")).toEqual({ kind: "ezproxy-login", base: "https://xn--bcherei-n2a.example.de/login?url=" });
  });

  it("spaces and line ends around a pasted link are let go; exactly 4,096 characters are read", () => {
    expect(deriveLibraryAccess("  https://ezproxy.lib.example.edu/login?url=x\n")).toEqual(EZ);
    const at = `https://ezproxy.lib.example.edu/login?url=https://x.example.org/`;
    expect(deriveLibraryAccess(at + "a".repeat(LIBRARY_LINK_MAX - at.length))).toEqual(EZ);
  });

  it("two url= parameters, or one whose value is itself a proxy link: the OUTER proxy, nothing of either value", () => {
    expect(deriveLibraryAccess("https://ezproxy.lib.example.edu/login?url=https://a.example.org/&url=https://evil.example/")).toEqual(EZ);
    const nested = deriveLibraryAccess("https://ezproxy.lib.example.edu/login?url=https://other-proxy.example.com/login?url=https://evil.example/");
    expect(nested).toEqual(EZ);
    expect(JSON.stringify(nested)).not.toContain("evil");
  });

  it("anything but a string is unreadable; nothing of the link is in a refusal (it holds a code only)", () => {
    for (const v of [undefined, null, 42, {}, ["https://x/login?url="]]) expect(deriveLibraryAccessWhy(v)).toEqual({ refused: "unreadable" });
    const r = deriveLibraryAccessWhy("https://user:SECRET@ezproxy.lib.example.edu/login?url=x");
    expect(Object.keys(r)).toEqual(["refused"]);
  });

  it("only https addresses are ever produced, whatever was pasted", () => {
    const links = [
      "https://ezproxy.lib.example.edu/login?url=x",
      "https://www-jstor-org.ezproxy.lib.example.edu/stable/1",
      "https://go.openathens.net/redirector/example.edu?url=x",
      "https://resolver.example.edu/openurl?url_ver=Z39.88-2004",
      "HtTpS://Resolver.Example.Edu:444/o?rft.atitle=x",
    ];
    for (const l of links) {
      const a = deriveLibraryAccess(l)!;
      expect(a).not.toBeNull();
      expect(new URL(a.base).protocol).toBe("https:");
      expect(isLibraryAccess(a)).toBe(true);
    }
  });

  it("the host of an address, for the sentence", () => {
    expect(libraryAccessHost(EZ)).toBe("ezproxy.lib.example.edu");
    expect(libraryAccessHost({ kind: "ezproxy-login", base: "https://proxy.example.edu:2443/login?url=" })).toBe("proxy.example.edu:2443");
    expect(libraryAccessHost(OA)).toBe("go.openathens.net");
    expect(libraryAccessHost(OU)).toBe("resolver.example.edu");
  });
});

describe("isLibraryAccess: only what deriveLibraryAccess could give (a PUT never trusts the page)", () => {
  it("accepts the three forms", () => {
    for (const a of [EZ, OA, OU, { kind: "ezproxy-login", base: "https://proxy.example.edu:2443/login?url=" }]) expect(isLibraryAccess(a)).toBe(true);
  });
  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      "https://ezproxy.lib.example.edu/login?url=",
      { kind: "ezproxy-login", base: "http://ezproxy.lib.example.edu/login?url=" },
      { kind: "ezproxy-login", base: "https://u:p@ezproxy.lib.example.edu/login?url=" },
      { kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu/login?url=https://evil.example/" },
      { kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu/login?ticket=x&url=" },
      { kind: "ezproxy-login", base: "https://ezproxy.lib.example.edu/other?url=" },
      { kind: "ezproxy-login", base: "https://127.0.0.1/login?url=" },
      { kind: "ezproxy-login", base: "javascript:alert(1)//https://x/login?url=" },
      { kind: "openathens", base: "https://go.openathens.net/redirector/example.edu?url=x" },
      { kind: "openathens", base: "https://evil.example/redirector/example.edu?url=" },
      { kind: "openurl", base: "https://resolver.example.edu/openurl?sid=x" },
      { kind: "openurl", base: "https://resolver.example.edu/openurl#x" },
      { kind: "openurl", base: "https://resolver.example.edu/openurl;jsessionid=x" },
      { kind: "openurl", base: "https://Resolver.example.edu/openurl" },
      { kind: "other", base: "https://resolver.example.edu/openurl" },
      { ...EZ, extra: 1 },
      { kind: "openurl", base: `https://resolver.example.edu/${"a".repeat(3000)}` },
    ];
    for (const b of bad) expect(isLibraryAccess(b), JSON.stringify(b)).toBe(false);
  });
});

describe("libraryAddressFor: one valid https address on the library's origin", () => {
  const HOSTILE_DOIS = [
    "10.5555/ao.f15#frag",
    "10.5555/ao.f15?x=1",
    "10.5555/ao.f15&url=https://evil.example/",
    "10.5555/ao.f15%2fencoded", // (the app keeps DOIs in lower case)
    "10.5555/ao<f15>",
    "10.5555/ao;f15",
    "10.5555/(ao)f15",
    "10.1002/(sici)1097-4571(199806)49:8<284::aid-asi3>3.0.co;2-0",
  ];
  /** The DOI read back from an address. */
  const doiBack = (a: LibraryAccess, addr: string): string => {
    const u = new URL(addr);
    if (a.kind === "ezproxy-login") return decodeURIComponent(new URL(addr.slice(a.base.length)).pathname.slice(1));
    if (a.kind === "openathens") return decodeURIComponent(new URL(u.searchParams.get("url")!).pathname.slice(1));
    return u.searchParams.get("rft_id")!.replace(/^info:doi\//u, "");
  };
  for (const a of [EZ, OA, OU]) {
    for (const doi of HOSTILE_DOIS) {
      it(`${a.kind}: ${doi}`, () => {
        const addr = libraryAddressFor(a, work({ doi }))!;
        expect(addr).not.toBeNull();
        const u = new URL(addr);
        expect(u.protocol).toBe("https:");
        expect(u.origin).toBe(new URL(a.base).origin);
        expect(u.hash).toBe("");
        expect(addr.startsWith(a.kind === "openurl" ? `${a.base}?` : a.base)).toBe(true);
        expect(doiBack(a, addr)).toBe(doi);
        if (a.kind === "ezproxy-login") {
          // The target is one address appended after url=: nothing of the DOI makes a second parameter.
          expect([...u.searchParams.keys()]).toEqual(["url"]);
          expect(new URL(addr.slice(a.base.length)).origin).toBe("https://doi.org");
        }
        if (a.kind === "openathens") expect([...u.searchParams.keys()]).toEqual(["url"]);
        if (a.kind === "openurl") expect([...u.searchParams.keys()]).toEqual(["url_ver", "rft_id"]);
      });
    }
  }

  it("the three forms, exactly", () => {
    const w = work({ doi: "10.1038/171737a0" });
    expect(libraryAddressFor(EZ, w)).toBe("https://ezproxy.lib.example.edu/login?url=https://doi.org/10.1038/171737a0");
    expect(libraryAddressFor(OA, w)).toBe("https://go.openathens.net/redirector/example.edu?url=https%3A%2F%2Fdoi.org%2F10.1038%2F171737a0");
    expect(libraryAddressFor(OU, w)).toBe("https://resolver.example.edu/openurl/44EX?url_ver=Z39.88-2004&rft_id=info:doi/10.1038%2F171737a0");
  });

  it("an ISBN goes to the resolver as rft.isbn; EZproxy and OpenAthens have no target for an ISBN alone (null)", () => {
    const book = work({ type: "book", isbn: ["978-0-674-21277-0"] });
    expect(libraryAddressFor(OU, book)).toBe("https://resolver.example.edu/openurl/44EX?url_ver=Z39.88-2004&rft.isbn=9780674212770");
    expect(libraryAddressFor(EZ, book)).toBeNull();
    expect(libraryAddressFor(OA, book)).toBeNull();
    expect(libraryAddressFor(OU, work({ doi: "10.1038/171737a0", isbn: ["9780674212770"] }))).toBe("https://resolver.example.edu/openurl/44EX?url_ver=Z39.88-2004&rft_id=info:doi/10.1038%2F171737a0&rft.isbn=9780674212770");
  });

  it("null without a DOI or ISBN of the accepted shape, and for an address it did not work out", () => {
    expect(libraryAddressFor(EZ, work())).toBeNull();
    expect(libraryAddressFor(OU, work())).toBeNull();
    expect(libraryAddressFor(EZ, work({ doi: "not a doi" }))).toBeNull();
    expect(libraryAddressFor(EZ, work({ doi: "10.5555/has space" }))).toBeNull(); // the app's DOI shape has no space
    expect(libraryAddressFor(OU, work({ isbn: ["123"] }))).toBeNull();
    expect(libraryAddressFor({ kind: "ezproxy-login", base: "http://x.example.edu/login?url=" }, work({ doi: "10.1038/171737a0" }))).toBeNull();
  });

  it("never longer than 4,096 characters", () => {
    const long = `10.5555/${"<".repeat(290)}`; // within the DOI bound, three times longer once encoded
    const base = { kind: "ezproxy-login" as const, base: `https://ezproxy.lib.example.edu/login?url=` };
    expect((libraryAddressFor(base, work({ doi: long })) ?? "").length).toBeLessThanOrEqual(4096);
    const deep: LibraryAccess = { kind: "openurl", base: `https://resolver.example.edu/${"a".repeat(2000)}` };
    const r = libraryAddressFor(deep, work({ doi: `10.5555/${"%".repeat(290)}` }));
    expect(r === null || r.length <= 4096).toBe(true);
  });
});

describe("catalogueTemplateOk", () => {
  it("https, {query} exactly once after the host, no user name or password", () => {
    expect(catalogueTemplateOk("https://catalogue.example.edu/search?q={query}")).toBe(true);
    expect(catalogueTemplateOk("https://catalogue.example.edu/search/{query}/all")).toBe(true);
    expect(catalogueTemplateOk("https://catalogue.example.edu:8443/s?lookfor={query}&type=all")).toBe(true);
  });
  it("refuses everything else", () => {
    for (const t of [
      "http://catalogue.example.edu/search?q={query}",
      "https://catalogue.example.edu/search?q=",
      "https://catalogue.example.edu/search?q={query}&r={query}",
      "https://{query}.example.edu/search",
      "https://catalogue.{query}/search",
      "https://u:p@catalogue.example.edu/search?q={query}",
      "https://{query}@catalogue.example.edu/search",
      "https://catalogue.example.edu/search#{query}",
      "javascript:{query}",
      "https://127.0.0.1/search?q={query}",
      "https://catalogue.example.edu/search?q={query}\n",
      `https://catalogue.example.edu/search?q={query}&x=${"a".repeat(2048)}`,
      42,
    ]) {
      expect(catalogueTemplateOk(t), String(t)).toBe(false);
    }
  });
});

describe("whereToGetIt: one list, https only, bounded (R324 d)", () => {
  const free: OfferLink[] = [{ label: "A free copy may be at", url: "https://repository.example.edu/z.pdf", host: "repository.example.edu" }];

  it("an article: the free copies first, then the publisher's page and the catalogue", () => {
    const links = whereToGetIt(work({ doi: "10.5555/ao.f15" }), { catalogueSearch: "https://catalogue.example.edu/search?q={query}" }, free);
    expect(links).toEqual([
      free[0],
      { label: "Publisher's page", url: "https://doi.org/10.5555/ao.f15", host: "doi.org" },
      { label: "Your library's catalogue", url: "https://catalogue.example.edu/search?q=Zorblatt%20Grammar%20of%20Habitus%20Quillfeather", host: "catalogue.example.edu" },
    ]);
  });

  it("a book: Open Library and WorldCat besides, by ISBN when there is one, else by title and author", () => {
    const byIsbn = whereToGetIt(work({ type: "book", isbn: ["978-0-674-21277-0"] }), null);
    expect(byIsbn).toEqual([
      { label: "Open Library", url: "https://openlibrary.org/isbn/9780674212770", host: "openlibrary.org" },
      { label: "WorldCat", url: "https://search.worldcat.org/search?q=9780674212770", host: "search.worldcat.org" },
    ]);
    const byTitle = whereToGetIt(work({ type: "book", title: "Distinction & Taste?" }), null);
    expect(byTitle.map((l) => l.url)).toEqual(["https://openlibrary.org/search?q=Distinction%20%26%20Taste%3F%20Quillfeather", "https://search.worldcat.org/search?q=Distinction%20%26%20Taste%3F%20Quillfeather"]);
  });

  it("the catalogue's query is the title and the first creator's family name, encoded, cut at 300 characters", () => {
    const t = "Ä".repeat(400);
    const [l] = whereToGetIt(work({ title: t }), { catalogueSearch: "https://catalogue.example.edu/s/{query}" });
    const q = decodeURIComponent(l!.url.slice("https://catalogue.example.edu/s/".length));
    expect(Array.from(q)).toHaveLength(CATALOGUE_QUERY_MAX);
    // A hostile title cannot add a parameter or change the host.
    const [h] = whereToGetIt(work({ title: "x&y=1#z /../@evil.example" }), { catalogueSearch: "https://catalogue.example.edu/s?q={query}" });
    expect(new URL(h!.url).host).toBe("catalogue.example.edu");
    expect([...new URL(h!.url).searchParams.keys()]).toEqual(["q"]);
  });

  it("the host is parsed from the address, never taken from what an offer says", () => {
    const lying: OfferLink[] = [{ label: "A free copy may be at", url: "https://evil.example/x.pdf", host: "arxiv.org" }];
    expect(whereToGetIt(work(), null, lying)).toEqual([{ label: "A free copy may be at", url: "https://evil.example/x.pdf", host: "evil.example" }]);
  });

  it("drops what is not https, holds a user name or password, does not parse, or is too long; no address twice", () => {
    const offers: OfferLink[] = [
      { label: "A free copy may be at", url: "http://repository.example.edu/a.pdf", host: "x" },
      { label: "A free copy may be at", url: "javascript:alert(1)", host: "x" },
      { label: "A free copy may be at", url: "https://u:p@repository.example.edu/a.pdf", host: "x" },
      { label: "A free copy may be at", url: "not an address", host: "x" },
      { label: "A free copy may be at", url: `https://repository.example.edu/${"a".repeat(WHERE_URL_MAX)}`, host: "x" },
      { label: "A free copy may be at", url: "https://REPOSITORY.example.edu:443/b.pdf", host: "x" },
      { label: "A free copy may be at", url: "https://repository.example.edu/b.pdf", host: "x" },
      { label: "A free copy may be at", url: "https://doi.org/10.5555/ao.f15", host: "x" },
    ];
    const links = whereToGetIt(work({ doi: "10.5555/ao.f15" }), null, offers);
    expect(links).toEqual([
      { label: "A free copy may be at", url: "https://repository.example.edu/b.pdf", host: "repository.example.edu" },
      { label: "A free copy may be at", url: "https://doi.org/10.5555/ao.f15", host: "doi.org" },
    ]);
  });

  it("at most 12 links", () => {
    const many: OfferLink[] = Array.from({ length: 20 }, (_, i) => ({ label: "A free copy may be at", url: `https://r${i}.example.edu/a.pdf`, host: "x" }));
    expect(whereToGetIt(work({ doi: "10.5555/ao.f15" }), null, many)).toHaveLength(WHERE_TO_GET_IT_MAX);
  });

  it("a catalogue template that is not acceptable gives no catalogue link (the settings never trusted)", () => {
    expect(whereToGetIt(work(), { catalogueSearch: "http://catalogue.example.edu/?q={query}" })).toEqual([]);
    expect(whereToGetIt(work(), { catalogueSearch: "https://{query}.example.edu/" })).toEqual([]);
  });

  it("a hostile DOI is one encoded address on doi.org", () => {
    const [l] = whereToGetIt(work({ doi: "10.5555/x#y?z&w" }), null);
    expect(new URL(l!.url).host).toBe("doi.org");
    expect(decodeURIComponent(new URL(l!.url).pathname.slice(1))).toBe("10.5555/x#y?z&w");
  });
});
