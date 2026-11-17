/**
 * Where a free copy of a work is (Find and acquire, Task F10; plan Global Constraints "No shadow libraries", "Hosts",
 * "Rates", "What is sent", and Amendment A1 point 4: fixed file hosts, everything else a link).
 *
 * `findFreeCopies` asks the open-access services the caller names, in the plan's order, for a work whose record is
 * complete, and gives:
 *  - `offers`: files on the fixed list of file hosts (`FREE_COPY_FILE_HOSTS`, decided by `fileHostAllowed` on a
 *    parsed address), at most 3 per service and 12 in all, a published version before an accepted before a
 *    submitted one (then none stated) within a service; the same address is offered once, by the first service;
 *  - `elsewhere`: other open-access addresses, which the app itself never fetches (a link for the researcher's
 *    browser or the app's own window, A1 point 4): `https:` only, no user name or password, no IP literal or
 *    single-label host, ≤ 2,000 characters, parsed and re-serialised; at most 10, one per host and path.
 *
 * What is asked (every address built here from the record; nothing a service wrote decides a host to ask):
 *  - OpenAlex (when the project's rules allow it as a metadata provider), by DOI: `best_oa_location.pdf_url`, then
 *    `locations[].pdf_url` where `is_oa` is true (at most 20 read).
 *  - Unpaywall, by DOI, only with a well-formed e-mail, sent as `email=` through the client's `query` option (never
 *    in the cache key, a cached file, a log line or an error): `best_oa_location.url_for_pdf`, then
 *    `oa_locations[].url_for_pdf` (at most 20 read).
 *  - arXiv: by the first author's family name and the title only (R256 a: arXiv has no DOI search field), spelled as
 *    its manual spells it: `au:<family>+AND+ti:%22<title words>%22`. An entry whose `arxiv:doi` is the record's DOI
 *    needs no title check; one naming another DOI is not offered (R261). The Atom answer is checked by `prescanXml` (no declarations, well-formed) and parsed with
 *    @xmldom/xmldom; at most 5 entries are read. The offer's address is built from the entry's id, checked
 *    (`ARXIV_ID_NEW`/`ARXIV_ID_OLD`).
 *  - Europe PMC, by DOI: a result with the same DOI, `isOpenAccess` "Y" and a `pmcid` matching `^PMC\d{1,9}$`
 *    gives `https://europepmc.org/articles/<pmcid>?pdf=render` (UNVERIFIED address form: the owner's first run).
 *  - Semantic Scholar, by DOI: `openAccessPdf.url`.
 *  - DOAB (books only), by title: bitstreams (`retrieveLink`, resolved against the DOAB host) and
 *    `oapen.identifier.downloadUrl` values of a PDF or EPUB.
 *  - The Internet Archive (books only), by title and family name: identifiers checked (`^[A-Za-z0-9._-]{1,100}$`),
 *    each item's metadata read, and only an item that is not access-restricted (lending), not in a lending
 *    collection, and under a public-domain or Creative Commons licence address or a copyright status saying it is
 *    not in copyright gives its file (name ≤ 200 characters, no `/` or `\`) at
 *    `https://archive.org/download/<id>/<encoded name>`: chosen by `format` where the list gives one ("Text PDF" or
 *    "PDF", "EPUB"), else the first plain `.pdf`/`.epub`; never one whose name or format says encrypted (R256 d).
 *    Identifiers start with a letter or digit (R257 d). Anything unknown or malformed means "no".
 *  - A copy found by title (an arXiv entry without the record's DOI; DOAB; the Internet Archive) is taken only when
 *    its title is the record's title (R257 a): the two titles' content words — F2's tokens (`segmentsOf`/`segmentTokens`, reference.ts)
 *    without the plan's small joining words (F2's `STOP_WORDS` in search.ts: and, et, al, by, the, of, in) — are the
 *    same sequence (same words, same order), nothing extra on either side (R261); AND one of its creators' names holds a family name of the record. A
 *    near match is neither offered nor linked. A copy found by DOI needs no such check.
 *  - Every address loses its fragment when it is parsed (R257 e); only offers that are kept count as already offered.
 *
 * Every request carries the client's User-Agent (no `mailto`), no cookie and no key. A service that fails, answers
 * nonsense or answers 429 (not retried: `final429`) is skipped for this call and the others still answer; a broken
 * answer is never cached. `findFreeCopies` never rejects (it takes no signal; the caller bounds it in time).
 * Rates live in the shared lookup client: `DEFAULT_RATE_LIMITS` (arXiv one request every 3 s, OpenAlex 5/s, every
 * other host here 1/s, the client's default) and `DEFAULT_CONCURRENCY` (arXiv one at a time, R254 a). Every request
 * here is asked once per call: a 429 or a 5xx is not retried (`final429`, `final5xx`).
 */
import { normalizeTitle, type Creator } from "@ao/core";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { prescanXml } from "../import/zotero-rdf.js";
import { isSensitive, providerAllowed, type LookupContext } from "../lookup/context.js";
import { encodeDoi } from "../lookup/crossref.js";
import { EMAIL_RE, LookupHttpError, type GetOptions } from "../lookup/http.js";
import type { WorkCandidate } from "./candidates.js";
import { FIND_DOI_MAX } from "./types.js";
import { segmentTokens, segmentsOf } from "./reference.js";
import { STOP_WORDS } from "./search.js";

/** The largest free copy the app downloads (100 MiB). */
export const FREE_COPY_MAX_BYTES = 104_857_600;
/** The longest address read from a service or a `Location` header; a longer one is dropped. */
export const FREE_COPY_ADDRESS_MAX = 2000;
export const FREE_COPY_OFFERS_PER_SOURCE = 3;
export const FREE_COPY_OFFERS_MAX = 12;
export const FREE_COPY_ELSEWHERE_MAX = 10;
/** Locations read from one answer (OpenAlex, Unpaywall). */
const LOCATIONS_READ = 20;
/** Search results read from one answer (arXiv entries, Europe PMC results, DOAB items, Internet Archive items). */
const RESULTS_READ = 5;
const DOAB_METADATA_READ = 200;
const DOAB_BITSTREAMS_READ = 20;
const IA_FILES_READ = 500;
const LICENCE_MAX = 100;
const TITLE_QUERY_MAX = 300;
const TTL_DAYS = 7;

/** The only hosts a free copy is downloaded from (with `ia<digits>.us.archive.org`, see `fileHostAllowed`). */
export const FREE_COPY_FILE_HOSTS: readonly string[] = Object.freeze([
  "arxiv.org",
  "export.arxiv.org",
  "europepmc.org",
  "pmc.ncbi.nlm.nih.gov",
  "www.ncbi.nlm.nih.gov",
  "library.oapen.org",
  "directory.doabooks.org",
  "archive.org",
]);
const IA_NODE = /^ia\d{3,6}\.us\.archive\.org$/u;

export type FreeCopySource = "openalex" | "unpaywall" | "arxiv" | "europepmc" | "semanticscholar" | "doab" | "internetarchive";
/** The plan's order of the services: offers keep it whatever order the caller names them in. */
export const FREE_COPY_SOURCES: readonly FreeCopySource[] = Object.freeze(["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"]);

export type CopyOffer = { source: FreeCopySource; url: string; kind: "pdf" | "epub"; version?: "published" | "accepted" | "submitted"; licence?: string };
export type ElsewhereLink = { host: string; url: string };

// ---------------------------------------------------------------------------------------------------------------
// Addresses

/**
 * An address parsed ONCE (resolved against `base` when given, as a `Location` is against the address that
 * answered), without its fragment; null when it is not a string, is longer than 2,000 characters, or does not parse.
 * The URL returned is what is checked and what is fetched or shown (`href`): the original string is never used again.
 */
export function parseFreeCopyAddress(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > FREE_COPY_ADDRESS_MAX) return null;
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    u.hash = ""; // the fragment is dropped before anything else (R257 e)
    return u.href.length <= FREE_COPY_ADDRESS_MAX ? u : null;
  } catch {
    return null;
  }
}

/**
 * The one rule for a file host, on a parsed address: scheme `https:` exactly; no user name or password; no explicit
 * port (an explicit `:443` is dropped by the parser and so passes); the hostname, as the parser gives it (lower-cased,
 * IDN as `xn--…`), equal to a listed host or matching `^ia\d{3,6}\.us\.archive\.org$`. So a trailing dot, an IP
 * literal, `localhost`, a sub-domain or a look-alike of a listed host never matches.
 */
export function fileHostAllowed(u: URL): boolean {
  if (!(u instanceof URL)) return false;
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return false;
  return FREE_COPY_FILE_HOSTS.includes(u.hostname) || IA_NODE.test(u.hostname);
}

/** Names that belong to a private network, never to a public repository (R257 f). */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".corp", ".home.arpa"];

/**
 * An "elsewhere" link may be opened in a browser: https only, no credentials, a named public host — not an IP
 * address, not a single label, no trailing dot, not `localhost` and not under a private-network suffix (R257 f).
 */
function elsewhereAllowed(u: URL): boolean {
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  const h = u.hostname;
  if (!h.includes(".") || h.endsWith(".") || h.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/u.test(h)) return false;
  return h !== "localhost" && !PRIVATE_SUFFIXES.some((x) => h.endsWith(x) || h === x.slice(1));
}

// ---------------------------------------------------------------------------------------------------------------
// Checking what a service wrote

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const text = (v: unknown, max = 4000): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

const VERSIONS: Readonly<Record<string, CopyOffer["version"]>> = { publishedVersion: "published", acceptedVersion: "accepted", submittedVersion: "submitted" };
const versionOf = (v: unknown): CopyOffer["version"] | undefined => (typeof v === "string" && Object.hasOwn(VERSIONS, v) ? VERSIONS[v] : undefined);
/** A licence code: format and control characters stripped first (R257 g), then at most 100 characters. */
const licenceOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" || v.length > 4000) return undefined;
  const t = v.replace(/[\p{Cf}\p{Cc}]/gu, "").trim();
  return t && t.length <= LICENCE_MAX ? t : undefined;
};

const DOI_RE = /^10\.\d{4,9}\/\S+$/u;
const doiOf = (w: WorkCandidate): string | undefined => {
  const d = w.identifiers?.doi;
  return typeof d === "string" && d.length <= FIND_DOI_MAX && DOI_RE.test(d) ? d.toLowerCase() : undefined;
};
const sameDoi = (v: unknown, doi: string) => typeof v === "string" && v.length <= FIND_DOI_MAX && v.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "") === doi;

export const ARXIV_ID_NEW = /^\d{4}\.\d{4,5}(v\d{1,3})?$/u;
export const ARXIV_ID_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d{1,3})?$/u;
const PMCID = /^PMC\d{1,9}$/u;
const IA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Percent-encodes every character outside the URL-unreserved set. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The record's title as plain words for a search (no quotes, brackets or operators), at most 300 characters. */
function titleWords(w: WorkCandidate): string | undefined {
  const t = typeof w.title === "string" ? normalizeTitle(w.title) : "";
  if (!t) return undefined;
  if (t.length <= TITLE_QUERY_MAX) return t;
  const cut = t.slice(0, TITLE_QUERY_MAX);
  return cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : TITLE_QUERY_MAX);
}

const familyOf = (c: Creator | undefined) => (c && typeof c.family === "string" ? normalizeTitle(c.family) : "");
/** The first author's family name as words (the first creator with a family name, an author before others). */
function firstFamily(w: WorkCandidate): string | undefined {
  const cs = Array.isArray(w.creators) ? w.creators.slice(0, 100) : [];
  const f = familyOf(cs.find((c) => c?.role === "author" && familyOf(c))) || familyOf(cs.find((c) => familyOf(c)));
  return f ? f.slice(0, 200) : undefined;
}

/** A title's content words in order: F2's joining words (`STOP_WORDS`) left out; case, accents and punctuation are ignored as F2's `tokensOf` does, but repeats are kept. */
const contentWords = (t: string): string[] => segmentsOf(t.slice(0, 4000)).flatMap(segmentTokens).filter((x) => !STOP_WORDS.has(x));

/** True when two titles have the same content words in the same order, nothing extra on either side (R257 a, R261). */
export function sameTitle(a: string, b: string): boolean {
  const A = contentWords(a);
  const B = contentWords(b);
  return A.length > 0 && A.length === B.length && A.every((x, i) => x === B[i]);
}

/** True when the found item is the record's work: the same title (`sameTitle`) and a creator holding a family name of the record. */
function sameWork(w: WorkCandidate, foundTitle: string | undefined, foundNames: string[]): boolean {
  if (!foundTitle || typeof w.title !== "string" || !sameTitle(foundTitle, w.title)) return false;
  const families = (Array.isArray(w.creators) ? w.creators.slice(0, 100) : []).map(familyOf).filter((f) => f.length >= 2);
  return foundNames.some((name) => {
    const words = ` ${normalizeTitle(name.slice(0, 1000))} `;
    return families.some((f) => words.includes(` ${f} `));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Asking

type Raw = { url: string; base?: URL; kind: "pdf" | "epub"; version?: CopyOffer["version"]; licence?: string; built?: true };

/** An answer that is not of the expected shape: never cached, the service skipped. */
class BadAnswer extends Error {}
/** The service answered 429: left alone for this call; its Retry-After, if any, is kept for the next try (R411 b). */
class Throttled extends Error {
  constructor(readonly retryAfter?: string) {
    super("throttled");
  }
}

const noRetry429 = () => true;

/** The body of an answer checked by `check` (inside the client's validate, so a broken answer is never cached); null on 404. */
async function ask<T>(ctx: LookupContext, url: string, cacheKey: string, check: (body: string) => T, query?: Record<string, string>): Promise<T | null> {
  let got: { v: T } | undefined;
  const validate = (body: string) => {
    try {
      got = { v: check(body) };
    } catch {
      throw new BadAnswer();
    }
  };
  const opts: GetOptions & { validate: (b: string) => void } = { cacheKey, ttlDays: TTL_DAYS, sensitive: isSensitive(ctx), final429: noRetry429, final5xx: true, validate, ...(query ? { query } : {}) };
  let body: string | null;
  try {
    body = await ctx.http.getText(url, opts);
  } catch (e) {
    if (e instanceof LookupHttpError && e.status === 429) throw new Throttled(e.retryAfter);
    throw e;
  }
  if (body === null) return null;
  if (!got) validate(body); // served from the memory cache: checked when it was stored
  return got!.v;
}

const jsonOf = (body: string): unknown => JSON.parse(body);
const recordOf = (body: string): Record<string, unknown> => {
  const j = jsonOf(body);
  if (!isRecord(j)) throw new Error("shape");
  return j;
};

async function fromOpenAlex(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const doi = doiOf(w);
  if (!doi || !providerAllowed(ctx, "openalex")) return [];
  // The same address and cache entry as the record lookup (`lookup/openalex.ts`): a single work by id is free.
  const j = await ask(ctx, `https://api.openalex.org/works/doi:${encodeDoi(doi)}`, `openalex:doi:${doi}`, recordOf);
  if (!j) return [];
  const out: Raw[] = [];
  const take = (loc: unknown, needOa: boolean) => {
    if (!isRecord(loc) || (needOa && loc.is_oa !== true)) return;
    const url = text(loc.pdf_url, FREE_COPY_ADDRESS_MAX);
    if (url) out.push({ url, kind: "pdf", version: versionOf(loc.version), licence: licenceOf(loc.license) });
  };
  if (isRecord(j.best_oa_location) && j.best_oa_location.is_oa !== false) take(j.best_oa_location, false);
  for (const loc of list(j.locations, LOCATIONS_READ)) take(loc, true);
  return out;
}

async function fromUnpaywall(w: WorkCandidate, ctx: LookupContext, email: string | undefined): Promise<Raw[]> {
  const doi = doiOf(w);
  if (!doi) return [];
  const mail = typeof email === "string" ? email.trim() : "";
  if (!mail || mail.length > 254 || !EMAIL_RE.test(mail)) {
    ctx.debug?.("free copy via unpaywall skipped: no e-mail address is set for it");
    return [];
  }
  const j = await ask(ctx, `https://api.unpaywall.org/v2/${encodeDoi(doi)}`, `free-copy:unpaywall:${doi}`, recordOf, { email: mail });
  if (!j) return [];
  const out: Raw[] = [];
  const take = (loc: unknown) => {
    if (!isRecord(loc)) return;
    const url = text(loc.url_for_pdf, FREE_COPY_ADDRESS_MAX);
    if (url) out.push({ url, kind: "pdf", version: versionOf(loc.version), licence: licenceOf(loc.license) });
  };
  take(j.best_oa_location);
  for (const loc of list(j.oa_locations, LOCATIONS_READ)) take(loc);
  return out;
}

const ATOM = "http://www.w3.org/2005/Atom";
const ARXIV_NS = "http://arxiv.org/schemas/atom";
type AtomEntry = { id: string; title?: string; authors: string[]; doi?: string };

/** At most 5 entries of an arXiv Atom answer; throws when it is not well-formed Atom. */
function atomEntries(body: string): AtomEntry[] {
  if (prescanXml(body) !== undefined) throw new Error("not well-formed");
  const doc = new DOMParser({
    onError: (level: string) => {
      if (level !== "warning") throw new Error("not well-formed");
    },
  }).parseFromString(body, "text/xml");
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== ATOM || root.localName !== "feed") throw new Error("not a feed");
  const child = (el: Element, ns: string, name: string) => {
    const found = el.getElementsByTagNameNS(ns, name);
    return found.length ? found[0]! : undefined;
  };
  const out: AtomEntry[] = [];
  const entries = root.getElementsByTagNameNS(ATOM, "entry");
  for (let i = 0; i < entries.length && out.length < RESULTS_READ; i++) {
    const e = entries[i]!;
    const id = child(e, ATOM, "id")?.textContent?.trim() ?? "";
    const names: string[] = [];
    const authors = e.getElementsByTagNameNS(ATOM, "author");
    for (let a = 0; a < authors.length && a < 100; a++) {
      const n = child(authors[a]!, ATOM, "name")?.textContent?.trim();
      if (n) names.push(n.slice(0, 1000));
    }
    out.push({ id: id.slice(0, 300), title: child(e, ATOM, "title")?.textContent?.replace(/\s+/gu, " ").trim().slice(0, 4000), authors: names, doi: child(e, ARXIV_NS, "doi")?.textContent?.trim().slice(0, FIND_DOI_MAX) });
  }
  return out;
}

/** The checked arXiv id of an entry's `<id>` (`http(s)://arxiv.org/abs/<id>`), or undefined. */
function arxivId(entryId: string): string | undefined {
  const m = /^https?:\/\/arxiv\.org\/abs\/(.+)$/u.exec(entryId);
  const id = m?.[1];
  return id && (ARXIV_ID_NEW.test(id) || ARXIV_ID_OLD.test(id)) ? id : undefined;
}

/**
 * A `search_query` value spelled as arXiv's manual spells it (`au:del_maestro+AND+ti:%22quantum+criticality%22`):
 * spaces as `+`, quotes as `%22`, the field colons as they are; every other character percent-encoded.
 */
const arxivSpelling = (q: string) => encodeURIComponent(q).replace(/%20/gu, "+").replace(/%3A/gu, ":");
const arxivQueryUrl = (q: string) => `https://export.arxiv.org/api/query?search_query=${arxivSpelling(q)}&max_results=${RESULTS_READ}`;

async function fromArxiv(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const doi = doiOf(w);
  const title = titleWords(w);
  const family = firstFamily(w);
  if (!title || !family) return [];
  const q = `au:${family.replace(/ /gu, "_")} AND ti:"${title}"`;
  const entries = (await ask(ctx, arxivQueryUrl(q), `free-copy:arxiv:${q}`, atomEntries)) ?? [];
  return entries.flatMap((e) => {
    const id = arxivId(e.id);
    if (!id) return [];
    const byDoi = !!doi && !!e.doi && sameDoi(e.doi, doi); // the entry itself names the record's DOI
    if (doi && e.doi && !byDoi) return []; // it names another DOI: most likely another version of the work (R261)
    if (!byDoi && !sameWork(w, e.title, e.authors)) return [];
    return [{ url: `https://arxiv.org/pdf/${id}`, kind: "pdf" as const, built: true as const }];
  });
}

async function fromEuropePmc(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const doi = doiOf(w);
  if (!doi) return [];
  const q = `DOI:"${doi}"`;
  const j = await ask(ctx, `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(q)}&resultType=core&format=json`, `free-copy:europepmc:${doi}`, recordOf);
  if (!j || !isRecord(j.resultList)) return [];
  const out: Raw[] = [];
  for (const r of list(j.resultList.result, RESULTS_READ)) {
    if (!isRecord(r) || r.isOpenAccess !== "Y" || !sameDoi(r.doi, doi) || typeof r.pmcid !== "string" || !PMCID.test(r.pmcid)) continue;
    out.push({ url: `https://europepmc.org/articles/${r.pmcid}?pdf=render`, kind: "pdf", built: true });
  }
  return out;
}

async function fromSemanticScholar(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const doi = doiOf(w);
  if (!doi) return [];
  const j = await ask(ctx, `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeDoi(doi)}?fields=openAccessPdf`, `free-copy:semanticscholar:${doi}`, recordOf);
  if (!j || !isRecord(j.openAccessPdf)) return [];
  const url = text(j.openAccessPdf.url, FREE_COPY_ADDRESS_MAX);
  return url ? [{ url, kind: "pdf", licence: licenceOf(j.openAccessPdf.license) }] : [];
}

const DOAB_BASE = new URL("https://directory.doabooks.org/");
const kindOf = (mime: unknown, name: unknown): "pdf" | "epub" | undefined => {
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/epub+zip") return "epub";
  if (typeof name === "string" && name.length <= 300) {
    if (/\.pdf$/iu.test(name)) return "pdf";
    if (/\.epub$/iu.test(name)) return "epub";
  }
  return undefined;
};

async function fromDoab(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const title = titleWords(w);
  if (w.type !== "book" || !title || !firstFamily(w)) return [];
  const q = `dc.title:"${title}"`;
  const items = await ask(ctx, `https://directory.doabooks.org/rest/search?query=${enc(q)}&expand=metadata,bitstreams`, `free-copy:doab:${title}`, (b) => {
    const j = jsonOf(b);
    if (!Array.isArray(j)) throw new Error("shape");
    return j.slice(0, RESULTS_READ);
  });
  const out: Raw[] = [];
  for (const item of items ?? []) {
    if (!isRecord(item)) continue;
    const meta = list(item.metadata, DOAB_METADATA_READ).filter(isRecord);
    const values = (key: string) => meta.filter((m) => m.key === key).flatMap((m) => (typeof m.value === "string" ? [m.value.slice(0, 4000)] : []));
    const foundTitle = values("dc.title")[0] ?? text(item.name);
    const names = [...values("dc.contributor.author"), ...values("dc.contributor.editor"), ...values("dc.creator")];
    if (!sameWork(w, foundTitle, names)) continue;
    for (const url of values("oapen.identifier.downloadUrl")) if (url.length <= FREE_COPY_ADDRESS_MAX) out.push({ url, kind: "pdf" });
    for (const b of list(item.bitstreams, DOAB_BITSTREAMS_READ)) {
      if (!isRecord(b)) continue;
      const kind = kindOf(b.mimeType, b.name);
      const url = text(b.retrieveLink, FREE_COPY_ADDRESS_MAX);
      if (kind && url) out.push({ url, base: DOAB_BASE, kind });
    }
  }
  return out;
}

/** A Creative Commons or public-domain licence address (parsed: the host exactly creativecommons.org). */
function openLicence(v: unknown): boolean {
  const u = parseFreeCopyAddress(v);
  return !!u && (u.protocol === "https:" || u.protocol === "http:") && u.hostname === "creativecommons.org" && /^\/(?:licenses|publicdomain)\//u.test(u.pathname);
}
const LENDING_COLLECTIONS = new Set(["inlibrary", "printdisabled", "lendinglibrary"]);

/** The plan's rule for the Internet Archive, failing closed: open only when nothing says lending and a field says public domain or CC. */
function iaItemOpen(meta: Record<string, unknown>): boolean {
  const restricted = meta["access-restricted-item"];
  if (restricted !== undefined && restricted !== false && restricted !== "false") return false;
  const collections = typeof meta.collection === "string" ? [meta.collection] : Array.isArray(meta.collection) ? meta.collection.slice(0, 100) : meta.collection === undefined ? [] : null;
  if (collections === null || collections.some((c) => typeof c !== "string" || LENDING_COLLECTIONS.has(c.toLowerCase()))) return false;
  const status = meta["possible-copyright-status"];
  const notInCopyright = typeof status === "string" && /^\s*(?:not[ _-]in[ _-]copyright|public[ _-]domain)\s*$/iu.test(status);
  return openLicence(meta.licenseurl) || notInCopyright;
}

const names = (v: unknown): string[] => (typeof v === "string" ? [v.slice(0, 1000)] : list(v, 100).flatMap((x) => (typeof x === "string" ? [x.slice(0, 1000)] : [])));
const iaFileName = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 200 && !/[/\\]/u.test(v) && !/[\u0000-\u001f\u007f]/u.test(v) && /\.(?:pdf|epub)$/iu.test(v) && !v.startsWith(".") ? v : undefined;

const ENCRYPTED_NAME = /_(?:encrypted|lcp)\.(?:pdf|epub)$/iu;
const PDF_FORMATS = new Set(["Text PDF", "PDF"]);

/**
 * The item's PDF and EPUB (R256 d): chosen by `format` where a file gives one ("Text PDF" or "PDF" for a `.pdf`,
 * "EPUB" for a `.epub`), else the first plain `.pdf`/`.epub` without a format; never a file whose name ends
 * `_encrypted.pdf`/`_lcp.epub` (and the like) or whose format mentions encryption or LCP.
 */
function iaFiles(files: unknown): { pdf?: string; epub?: string } {
  const byFormat: { pdf?: string; epub?: string } = {};
  const plain: { pdf?: string; epub?: string } = {};
  for (const f of list(files, IA_FILES_READ)) {
    const n = isRecord(f) ? iaFileName(f.name) : undefined;
    if (!n || ENCRYPTED_NAME.test(n)) continue;
    const isPdf = /\.pdf$/iu.test(n);
    const format = isRecord(f) ? f.format : undefined;
    if (format === undefined) {
      if (isPdf) plain.pdf ??= n;
      else plain.epub ??= n;
      continue;
    }
    if (typeof format !== "string" || /encrypt|lcp/iu.test(format)) continue;
    if (isPdf && PDF_FORMATS.has(format)) byFormat.pdf ??= n;
    else if (!isPdf && format === "EPUB") byFormat.epub ??= n;
  }
  const pdf = byFormat.pdf ?? plain.pdf;
  const epub = byFormat.epub ?? plain.epub;
  return { ...(pdf ? { pdf } : {}), ...(epub ? { epub } : {}) };
}

async function fromInternetArchive(w: WorkCandidate, ctx: LookupContext): Promise<Raw[]> {
  const title = titleWords(w);
  const family = firstFamily(w);
  if (w.type !== "book" || !title || !family) return [];
  const q = `title:("${title}") AND creator:(${family}) AND mediatype:texts`;
  const ids = await ask(ctx, `https://archive.org/advancedsearch.php?q=${enc(q)}&fl[]=identifier&rows=${RESULTS_READ}&output=json`, `free-copy:internetarchive:${q}`, (b) => {
    const j = recordOf(b);
    if (!isRecord(j.response) || !Array.isArray(j.response.docs)) throw new Error("shape");
    return j.response.docs.slice(0, RESULTS_READ).flatMap((d) => (isRecord(d) && typeof d.identifier === "string" && IA_ID.test(d.identifier) ? [d.identifier] : []));
  });
  const out: Raw[] = [];
  // M11 (R292): an item whose details could not be had (refused, 5xx, timed out, unreadable; a 404 is not that).
  let itemFailed: unknown;
  for (const id of ids ?? []) {
    if (out.length >= FREE_COPY_OFFERS_PER_SOURCE) break;
    let item: Record<string, unknown> | null;
    try {
      item = await ask(ctx, `https://archive.org/metadata/${id}`, `free-copy:internetarchive:metadata:${id}`, recordOf);
    } catch (e) {
      itemFailed = e;
      // A failed item never throws away what the earlier items found (R256 a); a 429 stops asking for more.
      if (e instanceof Throttled) {
        ctx.debug?.("free copy via internetarchive: it asked the app to slow down; no more items asked");
        break;
      }
      ctx.debug?.("free copy via internetarchive: one item's details could not be read");
      continue;
    }
    if (!item || !isRecord(item.metadata) || !iaItemOpen(item.metadata)) continue;
    if (!sameWork(w, text(item.metadata.title), names(item.metadata.creator))) continue;
    const { pdf, epub } = iaFiles(item.files);
    if (pdf) out.push({ url: `https://archive.org/download/${id}/${encodeURIComponent(pdf)}`, kind: "pdf", built: true });
    if (epub) out.push({ url: `https://archive.org/download/${id}/${encodeURIComponent(epub)}`, kind: "epub", built: true });
  }
  // M11: the search answered but an item failed and no offer came of it: the service counts as failed (R282 e).
  if (itemFailed !== undefined && !out.length) throw itemFailed;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const RANK: Readonly<Record<string, number>> = { published: 0, accepted: 1, submitted: 2 };
const rank = (v: CopyOffer["version"]) => (v ? RANK[v]! : 3);

/**
 * Where free copies of `work` are, from the services in `sources` (asked in parallel; offers in the plan's order).
 * `email` is sent to Unpaywall only, and Unpaywall is not asked without one. Never rejects: a service that fails is
 * skipped (a debug note names the service and an HTTP status, never an address or the e-mail), and named in `failed`
 * (R282 e: its request failed, timed out, was refused or answered something unreadable — never a service that
 * answered "nothing", nor one that was not asked).
 */
export async function findFreeCopies(
  work: WorkCandidate,
  ctx: LookupContext,
  sources: FreeCopySource[],
  email?: string,
): Promise<{ offers: CopyOffer[]; elsewhere: Array<{ host: string; url: string }>; failed: FreeCopySource[]; retryAfter?: string[] }> {
  const wanted = new Set(Array.isArray(sources) ? sources : []);
  const order = FREE_COPY_SOURCES.filter((s) => wanted.has(s));
  const failedSet = new Set<FreeCopySource>();
  /** R411 b: the raw Retry-After of each service that asked the app to wait (a 429, or a 5xx with one); absent when none did. */
  const retryAfter: string[] = [];
  const askOne = async (s: FreeCopySource): Promise<Raw[]> => {
    try {
      switch (s) {
        case "openalex":
          return await fromOpenAlex(work, ctx);
        case "unpaywall":
          return await fromUnpaywall(work, ctx, email);
        case "arxiv":
          return await fromArxiv(work, ctx);
        case "europepmc":
          return await fromEuropePmc(work, ctx);
        case "semanticscholar":
          return await fromSemanticScholar(work, ctx);
        case "doab":
          return await fromDoab(work, ctx);
        case "internetarchive":
          return await fromInternetArchive(work, ctx);
      }
    } catch (e) {
      const why =
        e instanceof Throttled ? "it asked the app to slow down (left alone for now)" : e instanceof BadAnswer ? "its answer was not of the expected shape" : e instanceof LookupHttpError && e.status ? `HTTP ${e.status}` : "it could not be reached";
      ctx.debug?.(`free copy via ${s} skipped: ${why}`);
      failedSet.add(s);
      const wait = e instanceof Throttled ? e.retryAfter : e instanceof LookupHttpError ? e.retryAfter : undefined;
      if (wait !== undefined) retryAfter.push(wait);
      return [];
    }
  };
  let raws: Raw[][];
  try {
    raws = await Promise.all(order.map(askOne));
  } catch {
    raws = [];
  }

  const offers: CopyOffer[] = [];
  const elsewhere: ElsewhereLink[] = [];
  const offered = new Set<string>();
  const linked = new Set<string>();
  order.forEach((source, i) => {
    const mine: CopyOffer[] = [];
    const seen = new Set<string>();
    for (const r of raws[i] ?? []) {
      const u = parseFreeCopyAddress(r.url, r.base);
      if (!u) continue;
      if (fileHostAllowed(u)) {
        if (offered.has(u.href) || seen.has(u.href)) continue;
        seen.add(u.href);
        mine.push({ source, url: u.href, kind: r.kind, ...(r.version ? { version: r.version } : {}), ...(r.licence ? { licence: r.licence } : {}) });
      } else if (!r.built && elsewhereAllowed(u)) {
        const key = `${u.hostname}${u.pathname.replace(/\/+$/u, "")}`; // a trailing slash is not a second link
        if (linked.has(key) || elsewhere.length >= FREE_COPY_ELSEWHERE_MAX) continue;
        linked.add(key);
        elsewhere.push({ host: u.hostname, url: u.href });
      }
    }
    mine.sort((a, b) => rank(a.version) - rank(b.version));
    // Only the offers kept count as already offered (R257 e): one cut by a cap does not hide another service's copy.
    for (const o of mine.slice(0, FREE_COPY_OFFERS_PER_SOURCE)) {
      if (offers.length >= FREE_COPY_OFFERS_MAX) break;
      offers.push(o);
      offered.add(o.url);
    }
  });
  return { offers, elsewhere, failed: order.filter((s) => failedSet.has(s)), ...(retryAfter.length ? { retryAfter } : {}) };
}
