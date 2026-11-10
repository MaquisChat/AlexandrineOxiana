import type { Creator, FieldEvidence } from "../model/index.js";
import { primary } from "../model/text.js";
import type { MultiText } from "../model/text.js";

/** What an external lookup (Crossref, OpenLibrary, ...) returned for an identifier. */
export type LookupEvidence = {
  provider: string;
  matchedIdentifier?: string;
  title?: string;
  creators?: Creator[];
  issued?: string;
};

/** Only this many characters of the document text are searched. */
export const DOC_TEXT_LIMIT = 20_000;

/** Source kinds that, on their own, justify "single-source" (filename and ai never do). */
export const TRUSTED_KINDS: ReadonlySet<string> = new Set([
  "embedded", "lookup", "zotero", "refman", "platform-json", "page-dom", "ocr",
]);

const KEEP_MARKS = /([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3099\u309A\uFF9E\uFF9F]+)/u;

/**
 * NFKD, strip combining marks, lowercase, drop punctuation and symbols, collapse whitespace.
 * Kana and Hangul runs use NFKC instead, so voicing marks survive (バ stays distinct from ハ).
 */
export function normalizeTitle(s: string): string {
  return s
    .split(KEEP_MARKS)
    .map((part, i) => (i % 2 === 1 ? part.normalize("NFKC") : part.normalize("NFKD").replace(/\p{M}+/gu, "")))
    .join("")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function tokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalized.split(" ")) {
    if (!word) continue;
    if (NO_SPACE_SCRIPT.test(word)) {
      const chars = Array.from(word);
      if (chars.length === 1) out.add(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
    } else out.add(word);
  }
  return out;
}

/**
 * Token-set similarity in [0,1]: Dice coefficient 2*|A ∩ B| / (|A| + |B|) over the sets of
 * normalized tokens. Tokens are whitespace-separated words, except words containing
 * Han/kana/Thai/etc. (scripts written without spaces), which are replaced by their character
 * bigrams (a single character stays as itself). Either side empty gives 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const A = tokens(normalizeTitle(a));
  const B = tokens(normalizeTitle(b));
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return (2 * common) / (A.size + B.size);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read an RFC 6901 pointer from a value; undefined when absent. */
export function getByPointer(root: unknown, pointer: string): unknown {
  let cur: unknown = root;
  if (pointer === "") return cur;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isRecord(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

/** Plain text of a value that may be a string, number or MultiText; undefined otherwise. */
export function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (isRecord(v) && Array.isArray(v.variants)) {
    const ok = v.variants.every((x) => isRecord(x) && typeof x.value === "string");
    return ok ? primary(v as unknown as MultiText) : undefined;
  }
  return undefined;
}

/** Every text variant of a value (all MultiText variants, or the single string). */
export function textVariants(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (isRecord(v) && Array.isArray(v.variants)) {
    return v.variants.flatMap((x) => (isRecord(x) && typeof x.value === "string" ? [x.value] : []));
  }
  return [];
}

/** Handles are compared case-insensitively, ignoring a leading "@". */
export function handleKey(s: string): string {
  return s.trim().replace(/^@/, "").toLowerCase();
}

/** Independence key: the kind, or "lookup:<provider>" for lookups. */
export function sourceKey(e: Pick<FieldEvidence, "source">): string {
  return e.source.kind === "lookup" ? `lookup:${e.source.provider ?? ""}` : e.source.kind;
}

export type Edtf = { y: number; m?: number; d?: number };

export function parseEdtf(s: unknown): Edtf | undefined {
  if (typeof s !== "string") return undefined;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?[?~]?$/.exec(s.trim());
  if (!m) return undefined;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 60))) return undefined;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : undefined;
  const d = m[3] ? Number(m[3]) : undefined;
  if (mo !== undefined && (mo < 1 || mo > 12)) return undefined;
  if (d !== undefined && mo !== undefined) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const max = mo === 2 ? (leap ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
    if (d < 1 || d > max) return undefined;
  }
  return { y, m: mo, d };
}

/** Equal at the precision of the less precise value. */
export function datesEqual(a: Edtf, b: Edtf): boolean {
  if (a.y !== b.y) return false;
  if (a.m === undefined || b.m === undefined) return true;
  if (a.m !== b.m) return false;
  if (a.d === undefined || b.d === undefined) return true;
  return a.d === b.d;
}

/** Dates a platform snapshot offers: UTC date of `timestamp` (epoch seconds), and `upload_date` (YYYYMMDD). */
export function snapshotDates(snap: Record<string, unknown> | undefined): Edtf[] {
  const out: Edtf[] = [];
  if (!snap) return out;
  const ts = typeof snap.timestamp === "number" ? snap.timestamp : typeof snap.timestamp === "string" ? Number(snap.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    const d = new Date(ts * 1000);
    if (!Number.isNaN(d.getTime())) out.push(parseEdtf(d.toISOString().slice(0, 10))!);
  }
  const u = typeof snap.upload_date === "string" ? /^(\d{4})(\d{2})(\d{2})$/.exec(snap.upload_date) : null;
  if (u) out.push({ y: Number(u[1]), m: Number(u[2]), d: Number(u[3]) });
  return out;
}

/** At most 80 characters of a value, for use inside a reason sentence. */
export function clip(v: unknown): string {
  const s = textOf(v) ?? (typeof v === "object" ? JSON.stringify(v) ?? "" : String(v));
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const isLatinWordChar = (ch: string | undefined) => !!ch && WORD_CHAR.test(ch) && !NO_SPACE_SCRIPT.test(ch);

/**
 * Does normalized `hay` contain normalized `needle`, with word boundaries wherever the needle starts
 * or ends in a spaced-script (Latin etc.) character? Works for mixed Latin+CJK needles.
 */
export function hasTokens(hay: string, needle: string): boolean {
  if (!needle) return false;
  const first = needle[0], last = needle[needle.length - 1];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (isLatinWordChar(first) && isLatinWordChar(hay[i - 1])) continue;
    if (isLatinWordChar(last) && isLatinWordChar(hay[i + needle.length])) continue;
    return true;
  }
  return false;
}

/**
 * Is a normalized title/name long enough to be grounded by text alone, and does the text contain it?
 * Titles: at least 2 tokens or 8 characters (CJK: 2 characters). Names: at least 3 characters (CJK: 2).
 */
/** Long enough to be trusted as a match on its own? Titles: 2 tokens or 8 chars; names: 3 chars; CJK: 2 chars. */
export function longEnough(needle: string, kind: "title" | "name"): boolean {
  if (NO_SPACE_SCRIPT.test(needle)) return Array.from(needle).length >= 2;
  if (kind === "title") return needle.split(" ").length >= 2 || needle.length >= 8;
  return needle.length >= 3;
}

export function groundedIn(hay: string, needle: string, kind: "title" | "name"): boolean {
  return longEnough(needle, kind) && hasTokens(hay, needle);
}

/** Number of date components given (1 year, 2 month, 3 day). */
export const datePrecision = (e: Edtf): number => (e.d !== undefined ? 3 : e.m !== undefined ? 2 : 1);

// ---------------------------------------------------------------- dates written in running text

const MONTH_NAMES: string[][] = [
  ["january", "jan", "enero", "ene", "janeiro", "janvier", "janv", "januar", "janner"],
  ["february", "feb", "febrero", "fevereiro", "fev", "fevrier", "fevr", "februar"],
  ["march", "mar", "marzo", "marco", "mars", "marz"],
  ["april", "apr", "abril", "abr", "avril", "avr"],
  ["may", "mayo", "maio", "mai"],
  ["june", "jun", "junio", "junho", "juin", "juni"],
  ["july", "jul", "julio", "julho", "juillet", "juil", "juli"],
  ["august", "aug", "agosto", "ago", "aout"],
  ["september", "sep", "sept", "septiembre", "setiembre", "setembro", "septembre"],
  ["october", "oct", "octubre", "outubro", "octobre", "oktober", "okt"],
  ["november", "nov", "noviembre", "novembro", "novembre"],
  ["december", "dec", "diciembre", "dic", "dezembro", "dez", "decembre", "dezember"],
];
/**
 * Month names and common abbreviations (English, Spanish, Portuguese, French, German), accents removed.
 * Portuguese "set" and "out" are left out: they are everyday English words ("3 out of 2020 items").
 */
const MONTH_OF: ReadonlyMap<string, number> = new Map(MONTH_NAMES.flatMap((names, i) => names.map((n) => [n, i + 1] as const)));
/** Little words allowed inside a written date: "17 de mayo de 2020", "the 17th of May". */
const DATE_CONNECTORS: ReadonlySet<string> = new Set(["de", "del", "do", "da", "di", "of", "the", "le", "den", "des", "d"]);

const dayOf = (tok: string | undefined): number | undefined => {
  const m = tok === undefined ? null : /^(\d{1,2})(?:st|nd|rd|th|er|e|o|a)?$/.exec(tok);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 31 ? n : undefined;
};

/**
 * Does the quoted passage state this date, with every component the date gives (year; month; day)
 * together in one recognizable date expression? A year alone only backs a year-only date.
 * Recognized: 2020-05-17, 2020/05, 17.05.2020 or 5/17/2020 (only when day and month cannot be
 * swapped), 05/2020, 2020年5月17日, and month names: "17 May 2020", "May 17, 2020",
 * "17 de mayo de 2020", "le 1er mai 2020", "17. Mai 2020", "March 2020".
 */
export function quoteStatesDate(quote: string, date: Edtf): boolean {
  const text = quote.normalize("NFKC");
  const stated: Edtf[] = [];
  if (new RegExp(`(?<!\\d)${String(date.y).padStart(4, "0")}(?!\\d)`).test(text)) stated.push({ y: date.y });
  const num = (re: RegExp, read: (m: RegExpExecArray) => Edtf | undefined) => {
    for (const m of text.matchAll(re)) {
      const e = read(m as RegExpExecArray);
      if (e && e.m !== undefined && e.m >= 1 && e.m <= 12 && (e.d === undefined || (e.d >= 1 && e.d <= 31))) stated.push(e);
    }
  };
  const n = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  num(/(?<!\d)(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?!\d)/g, (m) => ({ y: Number(m[1]), m: n(m[2]), d: n(m[3]) }));
  num(/(?<!\d)(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월](?:\s*(\d{1,2})\s*[日일])?/g, (m) => ({ y: Number(m[1]), m: n(m[2]), d: n(m[3]) }));
  num(/(?<!\d)(?<!\d[-/.])(\d{1,2})[-/.](\d{4})(?!\d)/g, (m) => ({ y: Number(m[2]), m: n(m[1]) }));
  num(/(?<!\d)(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(?!\d)/g, (m) => {
    const a = Number(m[1]), b = Number(m[3]), y = Number(m[4]);
    if (a === b) return { y, m: a, d: a };
    if (a > 12 && b <= 12) return { y, m: b, d: a };
    if (b > 12 && a <= 12) return { y, m: a, d: b };
    return undefined; // 05/06/2020: day and month could be either way round
  });

  const toks = text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const skip = (i: number, step: 1 | -1) => {
    let hops = 0;
    while (hops < 2 && DATE_CONNECTORS.has(toks[i] ?? "")) { i += step; hops++; }
    return i;
  };
  const yearAt = (i: number) => (/^\d{4}$/.test(toks[i] ?? "") ? Number(toks[i]) : undefined);
  toks.forEach((tok, i) => {
    const mo = MONTH_OF.get(tok);
    if (mo === undefined) return;
    const after = skip(i + 1, 1);
    const y1 = yearAt(after);
    if (y1 !== undefined) stated.push({ y: y1, m: mo, d: dayOf(toks[skip(i - 1, -1)]) }); // 17 [de] May [de] 2020, May 2020
    const y2 = dayOf(toks[after]) !== undefined ? yearAt(skip(after + 1, 1)) : undefined;
    if (y2 !== undefined) stated.push({ y: y2, m: mo, d: dayOf(toks[after]) }); // May 17, 2020
  });

  return stated.some((s) => s.y === date.y && (date.m === undefined || s.m === date.m) && (date.d === undefined || s.d === date.d));
}
