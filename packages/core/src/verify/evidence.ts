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

/** NFKD, strip combining marks, lowercase, drop punctuation and symbols, collapse whitespace. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

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

export function distinctSourceCount(evs: FieldEvidence[]): number {
  return new Set(evs.map(sourceKey)).size;
}

export type Edtf = { y: number; m?: number; d?: number };

export function parseEdtf(s: unknown): Edtf | undefined {
  if (typeof s !== "string") return undefined;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (!m) return undefined;
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : undefined, d: m[3] ? Number(m[3]) : undefined };
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
