/**
 * "Your library" and "Where to get it" (Find and acquire Task F15; Ruling R324 d, e). Pure functions: nothing here
 * makes a request, reads a file or keeps anything. The service never fetches from the researcher's library: the
 * address worked out here is handed to the sign-in window (Task F16), which the researcher opens by their own press.
 *
 * Working out the library's address from ONE pasted link (`deriveLibraryAccess`). The forms, in this order:
 *   1. a path `/login` with a `url=` or `qurl=` parameter (EZproxy's starting point) → `https://<host>/login?url=`;
 *   2. a host whose first label holds hyphens and reads as a host with dots, as `www-jstor-org.ezproxy.lib.edu`
 *      (EZproxy "HttpsHyphens"; `--` stands for a hyphen of the original host) → `https://<the rest>/login?url=`;
 *   3. `go.openathens.net/redirector/<domain>?url=` (UNVERIFIED against a real institution) → that redirector;
 *   4. a query with `url_ver=Z39.88-2004`, `ctx_ver=`, `rft_id=` or an `rft.` key (an OpenURL resolver) → its origin
 *      and path (a `;jsessionid=…` in the path is cut).
 * A link is refused, with a code the service says in words (`YOUR_LIBRARY_DERIVE_TEXT`), when it is over
 * LIBRARY_LINK_MAX characters, holds a control character or a space (outside the spaces and line ends around it, which
 * a paste brings), cannot be read as an address, is not https, holds a user name or password, or names its host by a
 * number (IPv4, IPv6), a single label or a name ending in a dot. Anything else is "not a library link".
 * The link itself is NEVER kept, returned, logged or put in an error: only the `base` built here, which holds nothing
 * of the link's query but the name of its target parameter (`url=`), and nothing of its path but `/login` (forms 1, 2),
 * the redirector's domain (form 3) or the resolver's path (form 4). Only https addresses are ever produced.
 *
 * The address for a work (`libraryAddressFor`): the target is `https://doi.org/<doi>` for a DOI of the shape the app
 * accepts (`canonDoi`, the search's own check), percent-encoded so that the target is ONE address before it is
 * appended — no `#`, `&`, `?`, `%` or space of a DOI can cut or extend the library's address. EZproxy: the target after
 * `url=`; OpenAthens: the target `encodeURIComponent`-ed; OpenURL: `?url_ver=Z39.88-2004&rft_id=info:doi/<doi encoded>`
 * and `&rft.isbn=<isbn-13>` for a work with an ISBN. An ISBN alone gives an address only through an OpenURL resolver
 * (EZproxy and OpenAthens need a target address, and an ISBN has none: null). Null without a DOI or ISBN, for an access
 * that this module could not have produced, and for a result over LIBRARY_LINK_MAX or off the library's origin.
 *
 * "Where to get it" (`whereToGetIt`): ONE list — the copy services' existing links first ("A free copy may be at",
 * Task F10), then the publisher's page (`https://doi.org/<doi>`), the library's catalogue (its search address with
 * `{query}` = the title and the first creator's family name, cut at CATALOGUE_QUERY_MAX characters, encoded), and for a
 * book Open Library and WorldCat (by ISBN, else by title and author; WorldCat's search address is UNVERIFIED). Every
 * link is https with no user name or password, at most WHERE_URL_MAX characters, given once (compared as parsed), its
 * host parsed from the address itself — never taken from a service's answer or a setting — and at most
 * WHERE_TO_GET_IT_MAX links in all.
 */
import { normalizeIsbn13 } from "../index/db.js";
import type { WorkCandidate } from "./candidates.js";
import { canonDoi } from "./search.js";
import type { OfferLink } from "./types.js";

/** How the researcher's library builds its links. `base` is always an https address this module built. */
export type LibraryAccess = { kind: "ezproxy-login"; base: string } | { kind: "openathens"; base: string } | { kind: "openurl"; base: string };
/** Why a pasted link gives no address. */
export type DeriveRefusal = "not-https" | "userinfo" | "too-long" | "unreadable" | "bad-host" | "not-library";

/** The longest link read, and the longest address produced. */
export const LIBRARY_LINK_MAX = 4096;
/** The longest `base` kept. */
export const LIBRARY_BASE_MAX = 2048;
/** "Where to get it": at most this many links, each address at most this long. */
export const WHERE_TO_GET_IT_MAX = 12;
export const WHERE_URL_MAX = 2048;
/** The catalogue's query (title and family name) is cut at this many characters before it is encoded. */
export const CATALOGUE_QUERY_MAX = 300;
/** The longest catalogue search address kept. */
export const CATALOGUE_TEMPLATE_MAX = 2048;

const OPENATHENS_HOST = "go.openathens.net";
const QUERY = "{query}";
/** A control character, or any kind of space or line end (WHATWG URL would silently drop tabs and line ends). */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** Top-level names a hyphenated EZproxy label may end in: any two-letter country, or these. */
const TLDS: ReadonlySet<string> = new Set(["com", "org", "net", "edu", "gov", "int", "mil", "info", "biz", "museum", "aero", "coop", "pro", "name", "io", "ai", "app", "dev", "eu", "asia"]);

const DOI_TARGET = "https://doi.org/";

/** A host name the app accepts (already lower-cased and punycoded by URL): at least two labels, no number, no trailing dot. */
function hostOk(hostname: string): boolean {
  if (!hostname || hostname.length > 253 || hostname.endsWith(".") || hostname.startsWith("[")) return false;
  const labels = hostname.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  // An IPv4 address (or anything whose last label is all digits) is not a host name.
  return !/^\d+$/u.test(labels[labels.length - 1]!);
}

/** `https://<host>` as URL keeps it: lower case, punycode, a port only when not 443. */
const authorityOf = (u: URL): string => u.host;

/** The labels of an EZproxy hyphenated first label, or null when it does not read as a host with dots. */
function hyphenHost(label: string): string[] | null {
  if (!label.includes("-") || label.startsWith("xn--")) return null;
  const parts = label.replace(/--/gu, "\u0001").split("-").map((p) => p.replace(/\u0001/gu, "-"));
  if (parts.length < 2 || !parts.every((p) => LABEL.test(p))) return null;
  const tld = parts[parts.length - 1]!;
  return /^[a-z]{2}$/u.test(tld) || TLDS.has(tld) ? parts : null;
}

/** The link parsed, or why it cannot be read. Never throws; never keeps the link. */
function parseLink(link: unknown): URL | DeriveRefusal {
  if (typeof link !== "string") return "unreadable";
  const t = link.replace(/^[\s\u0000-\u001f]+|[\s\u0000-\u001f]+$/gu, "");
  if (t.length > LIBRARY_LINK_MAX) return "too-long";
  if (t === "" || CONTROL_OR_SPACE.test(t)) return "unreadable";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return "unreadable";
  }
  if (u.protocol !== "https:") return "not-https";
  if (u.username !== "" || u.password !== "") return "userinfo";
  if (!hostOk(u.hostname)) return "bad-host";
  return u;
}

/** The library's address from a pasted link, or why there is none (a code only: nothing of the link). */
export function deriveLibraryAccessWhy(link: unknown): { access: LibraryAccess } | { refused: DeriveRefusal } {
  const u = parseLink(link);
  if (typeof u === "string") return { refused: u };
  const q = u.searchParams;
  const keys = [...q.keys()];
  // 1. EZproxy's starting point.
  if (u.pathname.toLowerCase() === "/login" && (q.has("url") || q.has("qurl"))) return { access: { kind: "ezproxy-login", base: `https://${authorityOf(u)}/login?url=` } };
  // 2. EZproxy's hyphenated host: the rest must itself be a host of at least two labels.
  const [first, ...rest] = u.hostname.split(".");
  if (first && rest.length >= 2 && hyphenHost(first) && hostOk(rest.join("."))) {
    return { access: { kind: "ezproxy-login", base: `https://${rest.join(".")}${u.port ? `:${u.port}` : ""}/login?url=` } };
  }
  // 3. OpenAthens' redirector (UNVERIFIED form).
  const redirector = /^\/redirector\/([^/]+)$/u.exec(u.pathname);
  if (u.hostname === OPENATHENS_HOST && u.port === "" && redirector && q.has("url")) {
    const domain = redirector[1]!.toLowerCase();
    if (hostOk(domain)) return { access: { kind: "openathens", base: `https://${OPENATHENS_HOST}/redirector/${domain}?url=` } };
    return { refused: "not-library" };
  }
  // 4. An OpenURL resolver.
  if (q.get("url_ver") === "Z39.88-2004" || q.has("ctx_ver") || keys.some((k) => k === "rft_id" || k.startsWith("rft."))) {
    const path = u.pathname.split(";")[0] || "/";
    const base = `https://${authorityOf(u)}${path}`;
    if (base.length <= LIBRARY_BASE_MAX && isLibraryAccess({ kind: "openurl", base })) return { access: { kind: "openurl", base } };
    return { refused: "not-library" };
  }
  return { refused: "not-library" };
}

/** The plan's interface: the address, or null. */
export function deriveLibraryAccess(link: unknown): LibraryAccess | null {
  const r = deriveLibraryAccessWhy(link);
  return "access" in r ? r.access : null;
}

/**
 * Whether `v` is an access exactly as `deriveLibraryAccessWhy` could have produced it: the kind's own form, https, no
 * user name or password, a host name the app accepts, nothing else in it (the PUT never trusts the page to have
 * called "derive").
 */
export function isLibraryAccess(v: unknown): v is LibraryAccess {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "kind" && k !== "base")) return false;
  const base = o.base;
  if (typeof base !== "string" || base.length > LIBRARY_BASE_MAX || CONTROL_OR_SPACE.test(base)) return false;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || !hostOk(u.hostname) || u.href !== base) return false;
  switch (o.kind) {
    case "ezproxy-login":
      return base === `https://${authorityOf(u)}/login?url=`;
    case "openathens": {
      const m = /^https:\/\/go\.openathens\.net\/redirector\/([^/?#]+)\?url=$/u.exec(base);
      return !!m && hostOk(m[1]!);
    }
    case "openurl":
      return u.search === "" && u.hash === "" && !base.includes("?") && !base.includes("#") && !u.pathname.includes(";") && base === `https://${authorityOf(u)}${u.pathname}`;
    default:
      return false;
  }
}

/** The host (and port, when not 443) of the library's address, as the derive sentence names it. */
export function libraryAccessHost(a: LibraryAccess): string {
  try {
    return new URL(a.base).host;
  } catch {
    return "";
  }
}

/** Every character but the unreserved ones percent-encoded (stricter than encodeURIComponent: also ! ' ( ) *). */
const strictEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** A DOI as one path of doi.org: every character encoded but its slashes. */
const doiPath = (doi: string): string => strictEncode(doi).replace(/%2F/gu, "/");

/** The work's DOI of the accepted shape, and its first ISBN that is one (as ISBN-13). */
function idsOf(w: WorkCandidate): { doi?: string; isbn?: string } {
  const doi = canonDoi(w.identifiers?.doi);
  let isbn: string | undefined;
  for (const i of w.identifiers?.isbn ?? []) {
    isbn = typeof i === "string" && i.length <= 40 ? normalizeIsbn13(i) : undefined;
    if (isbn) break;
  }
  return { ...(doi ? { doi } : {}), ...(isbn ? { isbn } : {}) };
}

/** The address of the work through the library, or null (see the top of this file). */
export function libraryAddressFor(a: LibraryAccess, work: WorkCandidate): string | null {
  if (!isLibraryAccess(a)) return null;
  const { doi, isbn } = idsOf(work);
  const target = doi ? `${DOI_TARGET}${doiPath(doi)}` : undefined;
  let out: string;
  switch (a.kind) {
    case "ezproxy-login":
      if (!target) return null;
      out = `${a.base}${target}`;
      break;
    case "openathens":
      if (!target) return null;
      out = `${a.base}${encodeURIComponent(target)}`;
      break;
    case "openurl":
      if (!doi && !isbn) return null;
      out = `${a.base}?url_ver=Z39.88-2004${doi ? `&rft_id=info:doi/${strictEncode(doi)}` : ""}${isbn ? `&rft.isbn=${isbn}` : ""}`;
      break;
  }
  if (out.length > LIBRARY_LINK_MAX || CONTROL_OR_SPACE.test(out)) return null;
  try {
    const u = new URL(out);
    if (u.protocol !== "https:" || u.origin !== new URL(a.base).origin || u.hash !== "" || u.username !== "" || u.password !== "") return null;
  } catch {
    return null;
  }
  return out;
}

/** A catalogue search address the settings accept: https, `{query}` exactly once and only after the host (in the path or the query), no user name or password. */
export function catalogueTemplateOk(v: unknown): v is string {
  if (typeof v !== "string" || v.length > CATALOGUE_TEMPLATE_MAX || CONTROL_OR_SPACE.test(v)) return false;
  if (!v.toLowerCase().startsWith("https://") || v.includes("#")) return false;
  const at = v.indexOf(QUERY);
  if (at < 0 || v.indexOf(QUERY, at + 1) >= 0) return false;
  // The authority ends at the first "/", "?" or "#" after the scheme; {query} must come after it.
  const rest = v.slice("https://".length);
  const end = rest.search(/[/?]/u);
  if (end < 0 || at < "https://".length + end) return false;
  let u: URL;
  try {
    u = new URL(v.replace(QUERY, "q"));
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && hostOk(u.hostname);
}

/** A link as "Where to get it" gives it, or null: https, no user name or password, at most WHERE_URL_MAX, its host parsed from it. */
function linkOf(label: OfferLink["label"], url: unknown): OfferLink | null {
  if (typeof url !== "string" || url.length > WHERE_URL_MAX || CONTROL_OR_SPACE.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || !u.hostname || u.href.length > WHERE_URL_MAX) return null;
  return { label, url: u.href, host: u.hostname };
}

/** The first `n` characters (whole characters, never half of a pair). */
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/**
 * "Where to get it" for a work: the copy services' links (`offers`) first, then the plan's links, as ONE list (see the
 * top of this file). `settings` is "Your library" (its catalogue search address, checked again here); null: not set.
 */
export function whereToGetIt(work: WorkCandidate, settings: { catalogueSearch?: string } | null, offers: readonly OfferLink[] = []): OfferLink[] {
  const out: OfferLink[] = [];
  const seen = new Set<string>();
  const add = (label: OfferLink["label"], url: unknown) => {
    if (out.length >= WHERE_TO_GET_IT_MAX) return;
    const l = linkOf(label, url);
    if (!l || seen.has(l.url)) return;
    seen.add(l.url);
    out.push(l);
  };
  for (const o of offers) if (o && o.label === "A free copy may be at") add(o.label, o.url);
  const { doi, isbn } = idsOf(work);
  if (doi) add("Publisher's page", `${DOI_TARGET}${doiPath(doi)}`);
  const family = work.creators?.find((c) => c.family)?.family ?? work.creators?.[0]?.literal ?? "";
  const words = cut([work.title ?? "", family].filter((x) => x.trim() !== "").join(" ").replace(/\s+/gu, " ").trim(), CATALOGUE_QUERY_MAX);
  const catalogue = settings?.catalogueSearch;
  if (words && catalogueTemplateOk(catalogue)) add("Your library's catalogue", catalogue.replace(QUERY, () => encodeURIComponent(words)));
  if (work.type === "book" || isbn) {
    if (isbn) add("Open Library", `https://openlibrary.org/isbn/${isbn}`);
    else if (words) add("Open Library", `https://openlibrary.org/search?q=${encodeURIComponent(words)}`);
    const q = isbn ?? words;
    if (q) add("WorldCat", `https://search.worldcat.org/search?q=${encodeURIComponent(q)}`);
  }
  return out;
}
