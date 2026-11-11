/**
 * Reads fields through selectors.json. The rules that keep extraction honest (R110):
 *  - a selector must match exactly one element; none or several → that alternative yields nothing;
 *  - values are checked for their kind (counts are plain whole numbers, dates are ISO 8601, links
 *    are http(s)); anything else is left out, never reinterpreted ("12.4K" is not 12,400).
 */
import type { Alternative, FieldName, PageSelectors } from "../selectors-schema.js";

const MAX_TEXT = 20_000;
const MAX_MEDIA = 50;

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
  const m = new RegExp(pattern).exec(v);
  return m?.[1] || undefined;
}

/** All values of one alternative (several elements allowed: lists such as media or post links). */
export function readAll(doc: ParentNode, alt: Alternative): string[] {
  const out: string[] = [];
  for (const el of Array.from(doc.querySelectorAll(alt.css))) {
    const raw = rawValue(el, alt.read);
    const v = raw === undefined ? undefined : applyPattern(raw, alt.pattern);
    if (v) out.push(v);
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
  const media = new Set<string>();
  for (const alt of f.mediaUrls ?? []) {
    for (const v of readAll(doc, alt)) {
      const u = absoluteUrl(v, url);
      if (u && media.size < MAX_MEDIA) media.add(u.href);
    }
    if (media.size) break; // the first alternative that finds media is the answer
  }
  out.mediaUrls = [...media];
  return out;
}

/** The page's canonical link when it stays on one of `hosts`; else undefined. */
export function canonicalOn(doc: Document, url: string, page: PageSelectors | undefined, hosts: readonly string[] | undefined): string | undefined {
  const u = absoluteUrl(readOne(doc, page?.fields.canonicalUrl), url);
  if (!u) return undefined;
  if (hosts && !hosts.includes(u.hostname)) return undefined;
  return u.href;
}
