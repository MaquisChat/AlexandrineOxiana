/** Small, pure helpers shared by the extractors and the lookup clients. */
import type { Creator } from "@ao/core";
import { tokens } from "./scan.js";

type Role = Creator["role"];

/**
 * A person's name as written ("Family, Given" or "Given Family") to a Creator. Trailing
 * cataloguing punctuation ("Adebayo, Ngozi,") is dropped; a single word becomes `literal`.
 */
/** Longest name text considered; longer input is cut first (keeps every step linear, R55). */
export const MAX_NAME_CHARS = 2000;
const TRAILING = new Set([" ", ",", ";", ":"]);
const isLetter = (ch: string | undefined) => !!ch && /^\p{L}$/u.test(ch);

export function parseName(raw: string, role: Role = "author"): Creator | undefined {
  let s = clean(raw.slice(0, MAX_NAME_CHARS));
  // Trailing cataloguing punctuation, scanned from the end (no backtracking regex).
  let end = s.length;
  while (end > 0 && TRAILING.has(s[end - 1]!)) end--;
  s = s.slice(0, end);
  // "Tomás." loses its full stop, but the initial in "Smith, J." keeps it (two letters before the dot).
  const chars = Array.from(s);
  if (chars.length >= 3 && chars[chars.length - 1] === "." && isLetter(chars[chars.length - 2]) && isLetter(chars[chars.length - 3])) s = s.slice(0, -1);
  if (!s) return undefined;
  const comma = s.indexOf(",");
  if (comma > 0) {
    const family = s.slice(0, comma).trim();
    const rest = s.slice(comma + 1);
    const next = rest.indexOf(",");
    const given = (next >= 0 ? rest.slice(0, next) : rest).trim();
    return given ? { family, given, role } : { family, role };
  }
  const parts = s.split(/\s+/u);
  if (parts.length === 1) return { literal: s, role };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]!, role };
}

/** Splits a free-text author list ("A; B", "A and B", "A & B") into Creators. */
export function parseNameList(raw: string, role: Role = "author"): Creator[] {
  // Whitespace collapsed first, so the separator pattern never rescans a long run of spaces.
  const t = clean(raw.slice(0, MAX_NAME_CHARS * 10));
  const parts = t.includes(";") ? t.split(";") : t.split(/ (?:and|&) /iu);
  return parts.map((p) => parseName(p, role)).filter((c): c is Creator => c !== undefined);
}

/** Collapses whitespace and strips control characters. */
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");

function ymd(y: number, m?: number, d?: number): string | undefined {
  if (y < 1000 || y > 2999) return undefined;
  if (m === undefined) return String(y);
  if (m < 1 || m > 12) return String(y);
  if (d === undefined || d < 1 || d > 31) return `${y}-${pad(m)}`;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A loosely written date to EDTF-lite (YYYY, YYYY-MM or YYYY-MM-DD), or undefined. Handles ISO
 * dates and timestamps (the calendar date as written, no zone conversion), "2018/06/15",
 * PDF dates ("D:20210304050607Z"), "May 1, 2009", "1 May 2009", "May 2009" and a bare year.
 */
export function normalizeDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = clean(String(raw)).slice(0, 200);
  let m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(s);
  if (m) return ymd(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined);
  m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?=$|[T\s])/.exec(s);
  if (m) return ymd(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined);
  const mon = (w: string) => MONTHS[w.toLowerCase().slice(0, 4)] ?? MONTHS[w.toLowerCase().slice(0, 3)];
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && mon(m[1]!)) return ymd(Number(m[3]), mon(m[1]!), Number(m[2]));
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m && mon(m[2]!)) return ymd(Number(m[3]), mon(m[2]!), Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m && mon(m[1]!)) return ymd(Number(m[2]), mon(m[1]!));
  m = /(?<!\d)(1[5-9]\d{2}|20\d{2})(?!\d)/.exec(s);
  return m ? m[1] : undefined;
}

/** Decodes the common named and numeric XML/HTML character references. */
export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/giu, (whole, ref: string) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return named[ref.toLowerCase()] ?? whole;
  });
}

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "head", "title"]);
/** Start tags that end an unterminated <head> (pages with no </head> and no <body>). */
const BODY_START = new Set(["body", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "article", "main", "section", "table", "ul", "ol"]);
const BREAK_AFTER = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "section", "article", "pre", "dd", "dt"]);

/**
 * Text content of markup: drops script/style/head-only elements and tags, decodes entities, keeps
 * paragraph and line breaks (cleanText). Linear in the input (scan.ts); stops collecting once
 * `maxChars` characters of text have been gathered.
 */
export function markupToText(markup: string, maxChars = Number.POSITIVE_INFINITY): string {
  const parts: string[] = [];
  let length = 0;
  let skipping: string | undefined;
  for (const t of tokens(markup)) {
    if (t.kind === "tag") {
      if (skipping) {
        if (t.end && t.local === skipping) skipping = undefined;
        else if (skipping === "head" && !t.end && BODY_START.has(t.local)) skipping = undefined;
        if (skipping || t.end) continue;
      }
      if (!t.end && !t.self && SKIP.has(t.local)) skipping = t.local;
      else if (t.local === "br" || (t.end && BREAK_AFTER.has(t.local))) parts.push("\n");
      continue;
    }
    if (skipping) continue;
    parts.push(t.text);
    length += t.text.length;
    if (length > maxChars * 2) break;
  }
  return cleanText(decodeEntities(parts.join("")));
}

/**
 * Body text: control characters and runs of spaces/tabs become one space, single line breaks are
 * kept, and at most one blank line separates paragraphs.
 */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
