/**
 * Reads fields through selectors.json. The rules that keep extraction honest (R110):
 *  - a selector must match exactly one element; none or several → that alternative yields nothing;
 *  - values are checked for their kind (counts are plain whole numbers, dates are ISO 8601, links
 *    are http(s)); anything else is left out, never reinterpreted ("12.4K" is not 12,400).
 */
import type { Alternative, FieldName, PageSelectors } from "../selectors-schema.js";

const MAX_TEXT = 20_000;
/** Patterns see at most this much of a value (R112). */
export const MAX_PATTERN_INPUT = 20_000;
export const MAX_MEDIA = 50;
export const MAX_URL_CHARS = 2048;

/** Visible-ish text of an element: <br> becomes a line break, runs of spaces collapse. */
export function textOf(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += n.nodeValue ?? "";
    else if (n.nodeType === 1) {
      const tag = (n as Element).tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "template" || tag === "noscript") return;
      if (tag === "br") {
        out += "\n";
        return;
      }
      for (const c of Array.from(n.childNodes)) walk(c);
    }
  };
  walk(el);
  return out
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rawValue(el: Element, read: string | undefined): string | undefined {
  if (!read || read === "text") return textOf(el);
  const v = el.getAttribute(read.slice(5));
  return v === null ? undefined : v.trim();
}

function applyPattern(v: string, pattern: string | undefined): string | undefined {
  if (!pattern) return v;
  const m = new RegExp(pattern).exec(v.slice(0, MAX_PATTERN_INPUT));
  return m?.[1] || undefined;
}

/**
 * Values of one alternative (several elements allowed: lists such as media or post links). With
 * `limit`, reading stops once that many values were accepted by `accept`.
 */
export function readAll(doc: ParentNode, alt: Alternative, opts: { limit?: number; accept?: (v: string) => string | undefined } = {}): string[] {
  const out: string[] = [];
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const el of doc.querySelectorAll(alt.css)) {
    if (out.length >= limit) break;
    const raw = rawValue(el, alt.read);
    const v = raw === undefined ? undefined : applyPattern(raw, alt.pattern);
    const accepted = v && (opts.accept ? opts.accept(v) : v);
    if (accepted) out.push(accepted);
  }
  return out;
}

/** The value of a single-valued field: the first alternative whose selector matches exactly one element and yields a value. */
export function readOne(doc: ParentNode, alts: Alternative[] | undefined): string | undefined {
  for (const alt of alts ?? []) {
    const els = doc.querySelectorAll(alt.css);
    if (els.length !== 1) continue;
    const raw = rawValue(els[0]!, alt.read);
    const v = raw === undefined ? undefined : applyPattern(raw, alt.pattern);
    if (v) return v.slice(0, MAX_TEXT);
  }
  return undefined;
}

/** "1,204" / "1204" / "1 204" → 1204; anything abbreviated or approximate → undefined. */
export function parseCount(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!/^(\d{1,3}([,.   ]\d{3})+|\d{1,15})$/.test(t)) return undefined;
  const n = Number(t.replace(/[^\d]/g, ""));
  return Number.isSafeInteger(n) ? n : undefined;
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO 8601 date/time as the page states it; anything else → undefined. */
export function parseIsoDate(v: string | undefined): string | undefined {
  if (!v || !ISO.test(v) || Number.isNaN(Date.parse(v))) return undefined;
  return v;
}

/** An absolute http(s) URL resolved against the page, without its fragment. */
export function absoluteUrl(v: string | undefined, base: string): URL | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.hash = "";
    return u;
  } catch {
    return undefined;
  }
}

export interface CommonFields {
  handle?: string;
  displayName?: string;
  caption?: string;
  postedAt?: string;
  counts?: { likes?: number; comments?: number; views?: number; shares?: number };
  mediaUrls: string[];
}

/** The fields every page kind shares, read through its selectors. */
export function readCommon(doc: Document, url: string, page: PageSelectors | undefined): CommonFields {
  const f = page?.fields ?? {};
  const one = (name: FieldName) => readOne(doc, f[name]);
  const out: CommonFields = { mediaUrls: [] };
  const handle = one("handle")?.replace(/^@/, "");
  if (handle) out.handle = handle;
  const displayName = one("displayName");
  if (displayName) out.displayName = displayName;
  const caption = one("caption");
  if (caption) out.caption = caption;
  const postedAt = parseIsoDate(one("postedAt"));
  if (postedAt) out.postedAt = postedAt;
  const counts: NonNullable<CommonFields["counts"]> = {};
  for (const k of ["likes", "comments", "views", "shares"] as const) {
    const n = parseCount(one(k));
    if (n !== undefined) counts[k] = n;
  }
  if (Object.keys(counts).length) out.counts = counts;
  for (const alt of f.mediaUrls ?? []) {
    const media = new Set<string>();
    // At most 50 links of at most 2,048 characters; reading stops at 50 (R112).
    readAll(doc, alt, {
      limit: MAX_MEDIA,
      accept: (v) => {
        if (v.length > MAX_URL_CHARS) return undefined;
        const href = absoluteUrl(v, url)?.href;
        if (!href || href.length > MAX_URL_CHARS || media.has(href)) return undefined;
        media.add(href);
        return href;
      },
    });
    if (media.size) {
      out.mediaUrls = [...media]; // the first alternative that finds media is the answer
      break;
    }
  }
  return out;
}

/** The page's canonical link when it stays on one of `hosts`; else undefined. */
export function canonicalOn(doc: Document, url: string, page: PageSelectors | undefined, hosts: readonly string[] | undefined): string | undefined {
  const u = absoluteUrl(readOne(doc, page?.fields.canonicalUrl), url);
  if (!u) return undefined;
  if (hosts && !hosts.includes(u.hostname)) return undefined;
  return u.href;
}
