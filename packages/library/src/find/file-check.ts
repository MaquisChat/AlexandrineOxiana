/**
 * The file check (Find and acquire, Task F11; Ruling R277 a): is a downloaded file the work of the record it was
 * found for? Strict, because a wrong file attached to a record is worse than no file: a file that does not clearly
 * match is never attached by the app — the runner holds it for the researcher's check.
 *
 * The file's text and metadata are read through the library's own extraction (`extract/pdf.ts`, `extract/epub.ts`,
 * under their limits: the first 3 pages or sections, at most 20,000 characters, the R50 zip limits; nothing
 * embedded is run or fetched). Only the first FILE_CHECK_TEXT_CHARS (6,000) characters of that text are looked at.
 * A file the extraction cannot read, or a PDF with (almost) no text (a scan), is "no-text".
 *
 * A file MATCHES only when one of these holds:
 *  1. **By DOI.** The record's DOI is the file's own DOI. *The file's own DOI* is the DOI its metadata names (PDF
 *     `prism:doi`, an EPUB's `dc:identifier`); when its metadata names none, it is the FIRST DOI in its first 6,000
 *     characters of text. A DOI further on (a reference, a "see also") is never the file's own. So when the
 *     metadata names another DOI, or the text presents another DOI before the record's, the file is "other-doi",
 *     whatever its title says; when the file presents no DOI at all, the title decides (2, 3).
 *  2. **By the embedded title.** The file's embedded title IS the record's title — the same content words in the
 *     same order (the comparison F10 uses for a copy found by title, R257 a / R261 a: F2's tokens without F2's small
 *     joining words; never a similarity score) — AND the first author's family name is in the file's author
 *     metadata or in its first 6,000 characters.
 *  3. **By the text.** At least 90% — and at least 3 — of the record title's content words occur in order within
 *     the first 6,000 characters, in a stretch of at most 2n + 4 words (n = the title's content words, so the
 *     title cannot be put together from words scattered over the page), AND the first author's family name occurs
 *     there (or in the author metadata).
 * In 2 and 3 the file does NOT match ("other-version") when, beside the title, it holds a volume, part, book or
 * edition number, or one of the words review, erratum, corrigendum, supplement, retraction (and their plurals),
 * that the record's title does not hold. *Beside the title* is: the embedded title itself, and in the text the
 * line(s) the title stands on and the line after them. Numbers are read with F2's `numberValue` (digits, digit
 * ordinals, roman numerals after a volume word); an edition may also be an ordinal word ("Second edition").
 * An embedded title that is the record's title plus such a mark is "other-version" too.
 *
 * Everything else is a mismatch with its reason: "other-doi", "title-absent", "no-text" or "other-version".
 * A record with fewer than 3 content words in its title ("Capital") can therefore match only by its DOI or by an
 * exact embedded title with its author, never by loose text.
 *
 * What the check found is returned for the review queue (R277 d), bounded and cleaned (invisible and control
 * characters removed): the file's own DOI when it is not the record's, its embedded title and the start of its text
 * (each at most FILE_CHECK_EVIDENCE_CHARS characters), its kind and size. It is outside text: shown only through
 * UserText, never logged or audited.
 */
import * as fsp from "node:fs/promises";
import { findIdentifiers, type Creator } from "@ao/core";
import { extractEpub } from "../extract/epub.js";
import { extractPdf } from "../extract/pdf.js";
import type { RawExtract } from "../extract/types.js";
import { cleanText, segmentTokens, segmentsOf, type Segment } from "./reference.js";
import { STOP_WORDS, canonDoi, numberValue } from "./search.js";

/** How much of the file's text is looked at. */
export const FILE_CHECK_TEXT_CHARS = 6000;
/** The longest embedded title and start of text kept as evidence for the researcher. */
export const FILE_CHECK_EVIDENCE_CHARS = 300;
/** A PDF with fewer characters of text than this (spaces left out) is a scan: "no-text". */
const MIN_TEXT_CHARS = 50;
/** The longest title compared (in content words); a longer title is compared on its first words. */
const TITLE_WORDS_MAX = 100;

export type FileCheckRecord = { title: string; creators: Creator[]; doi?: string };
export type FileMismatchWhy = "other-doi" | "title-absent" | "no-text" | "other-version";
/** What the check found (outside text, bounded): for the researcher's own judgement in the review queue. */
export type FileEvidence = {
  kind: "pdf" | "epub";
  bytes: number;
  /** The file's own DOI (see the top of this file), when it is not the record's. */
  fileDoi?: string;
  embeddedTitle?: string;
  textStart?: string;
};
export type FileCheckResult = ({ match: true; by: "doi" | "title" } | { match: false; why: FileMismatchWhy }) & { evidence: FileEvidence };

/** Outside text bounded and made safe to show: invisible and control characters gone, spacing collapsed. */
function shown(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = cleanText(s.replace(/\s+/gu, " ")).replace(/\p{Cc}/gu, "");
  if (!t) return undefined;
  const cut = Array.from(t).slice(0, FILE_CHECK_EVIDENCE_CHARS).join("");
  return cut.length > FILE_CHECK_EVIDENCE_CHARS ? cut.slice(0, FILE_CHECK_EVIDENCE_CHARS) : cut;
}

/** The kind by the file's first bytes (the download already checked them: F10). */
async function kindOf(path: string): Promise<"pdf" | "epub"> {
  const fh = await fsp.open(path, "r");
  try {
    const b = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(b, 0, 1024, 0);
    const head = b.subarray(0, bytesRead);
    return head.includes("%PDF-") ? "pdf" : head.subarray(0, 2).toString("latin1") === "PK" ? "epub" : "pdf";
  } finally {
    await fh.close();
  }
}

/** A word with the line it stands on, and the word before it (for numbers after a volume word). */
type Word = { w: string; line: number };

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  text.split("\n").forEach((line, i) => {
    for (const seg of segmentsOf(line)) for (const w of segmentTokens(seg)) out.push({ w, line: i });
  });
  return out;
}
const plainWords = (s: string): string[] => segmentsOf(s.slice(0, 4000)).flatMap((x: Segment) => segmentTokens(x));
/** A title's content words in order (F10's `contentWords`: F2's tokens without F2's small joining words). */
const contentWords = (s: string): string[] => plainWords(s).filter((w) => !STOP_WORDS.has(w));
/** Two titles are the same title: the same content words in the same order, nothing extra on either side (R257 a, R261 a). */
function sameTitle(a: string, b: string): boolean {
  const A = contentWords(a);
  const B = contentWords(b);
  return A.length > 0 && A.length === B.length && A.every((x, i) => x === B[i]);
}

/** The volume words, each with the mark it makes ("vol" and "volume" are one). */
const VOLUME_MARK: Readonly<Record<string, string>> = { volume: "volume", vol: "volume", band: "volume", tome: "volume", tomo: "volume", part: "part", book: "book", edition: "edition", ed: "edition" };
/** Words that say a file is something else than the work itself. */
const OTHER_WORDS: Readonly<Record<string, string>> = {
  review: "review",
  reviews: "review",
  erratum: "erratum",
  errata: "erratum",
  corrigendum: "corrigendum",
  corrigenda: "corrigendum",
  supplement: "supplement",
  supplementary: "supplement",
  supplements: "supplement",
  retraction: "retraction",
  retracted: "retraction",
};
const ORDINAL_WORDS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/** The version marks among words: "volume:2", "edition:2", "review", … (a number of 1,000 or more is a year, not a volume). */
function marksOf(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const prev = k > 0 ? words[k - 1] : undefined;
    const other = OTHER_WORDS[w];
    if (other) out.add(other);
    if (prev !== undefined && VOLUME_MARK[prev]) {
      const v = numberValue(w, prev);
      if (v !== undefined && v < 1000) out.add(`${VOLUME_MARK[prev]}:${v}`);
    }
    if (VOLUME_MARK[w] === "edition" && prev !== undefined) {
      const v = ORDINAL_WORDS[prev] ?? (/^\d{1,3}(?:st|nd|rd|th)$/u.test(prev) ? numberValue(prev, undefined) : undefined);
      if (v !== undefined) out.add(`edition:${v}`);
    }
  }
  return out;
}
const extraMarks = (marks: Set<string>, record: Set<string>): string[] => [...marks].filter((m) => !record.has(m));

/** The first author's family name as words (an organisation: its name), or null. */
function firstFamily(creators: Creator[]): string[] | null {
  const cs = Array.isArray(creators) ? creators.slice(0, 100) : [];
  const name = (c: Creator | undefined) => (c ? (c.family ?? c.literal ?? "") : "");
  const pick = cs.find((c) => c.role === "author" && name(c)) ?? cs.find((c) => name(c));
  const words = pick ? plainWords(name(pick)) : [];
  return words.length && words.join("").length >= 2 ? words : null;
}
const containsRun = (hay: readonly string[], run: readonly string[]): boolean => ` ${hay.join(" ")} `.includes(` ${run.join(" ")} `);

/**
 * Where the title's content words stand in order in the text: at least `need` of them, in a stretch of at most
 * 2n + 4 content words. Returns the first and last matched positions (in `content`), or null.
 */
function titleSpan(rec: readonly string[], content: readonly Word[], need: number): { from: number; to: number } | null {
  const n = rec.length;
  const W = 2 * n + 4;
  const recSet = new Set(rec);
  for (let i = 0; i < content.length; i++) {
    if (!recSet.has(content[i]!.w)) continue;
    const win = content.slice(i, i + W).map((x) => x.w);
    // Longest common subsequence of the title's words and the stretch; the stretch ends at the first place it is reached.
    let prev = new Array<number>(win.length + 1).fill(0);
    for (let a = 1; a <= n; a++) {
      const row = new Array<number>(win.length + 1).fill(0);
      for (let b = 1; b <= win.length; b++) row[b] = rec[a - 1] === win[b - 1] ? prev[b - 1]! + 1 : Math.max(prev[b]!, row[b - 1]!);
      prev = row;
    }
    const best = prev[win.length]!;
    if (best >= need) {
      const end = prev.findIndex((v) => v === best);
      return { from: i, to: i + end - 1 };
    }
  }
  return null;
}

async function extract(path: string, kind: "pdf" | "epub"): Promise<RawExtract | null> {
  try {
    const raw = kind === "pdf" ? await extractPdf(path) : await extractEpub(path);
    return raw.readFailed ? null : raw;
  } catch {
    // Beyond the zip limits, not an archive, unreadable: the extraction cannot read it.
    return null;
  }
}

/**
 * Checks the file at `path` (a PDF or an EPUB, as F10's download decided by its bytes) against the record it was
 * found for. See the top of this file for the rule. Never throws for what the file holds; an I/O error on the file
 * itself (it vanished) is thrown.
 */
export async function checkFileAgainstRecord(path: string, record: FileCheckRecord): Promise<FileCheckResult> {
  const kind = await kindOf(path);
  const bytes = (await fsp.stat(path)).size;
  const raw = await extract(path, kind);
  const fullText = raw?.text ?? "";
  const text = fullText.slice(0, FILE_CHECK_TEXT_CHARS);
  const evidence: FileEvidence = { kind, bytes };
  const t = shown(raw?.title);
  if (t) evidence.embeddedTitle = t;
  const ts = shown(text);
  if (ts) evidence.textStart = ts;
  const no = (why: FileMismatchWhy): FileCheckResult => ({ match: false, why, evidence });
  if (!raw) return no("no-text");

  // 1. The file's own DOI.
  const recDoi = canonDoi(record.doi);
  const metaDois = [...new Set((raw.ids?.dois ?? []).map((d) => canonDoi(d)).filter((d): d is string => !!d))];
  const own = metaDois.length ? metaDois : findIdentifiers(text).dois.slice(0, 1).map((d) => canonDoi(d)).filter((d): d is string => !!d);
  const other = own.find((d) => d !== recDoi);
  if (other) evidence.fileDoi = shown(other)!;
  if (recDoi && own.length) {
    if (own.every((d) => d === recDoi)) return { match: true, by: "doi", evidence };
    return no("other-doi");
  }

  // 2 and 3. The title, with the first author.
  const family = firstFamily(record.creators);
  const words = wordsOf(text);
  const content = words.filter((x) => !STOP_WORDS.has(x.w));
  const allWords = words.map((x) => x.w);
  const fileNames = (raw.creators ?? []).slice(0, 100).flatMap((c) => [plainWords([c.given, c.family, c.literal].filter(Boolean).join(" "))]);
  const authorOk = !!family && (containsRun(allWords, family) || fileNames.some((n) => containsRun(n, family)));
  const rec = contentWords(record.title).slice(0, TITLE_WORDS_MAX);
  const recMarks = marksOf(plainWords(record.title));
  const embedded = raw.title ?? "";
  const embeddedExtra = embedded ? extraMarks(marksOf(plainWords(embedded)), recMarks) : [];
  /** The marks beside the title in the text: on the line(s) of the span and the line after. */
  const besideInText = (span: { from: number; to: number } | null): string[] => {
    if (!span) return [];
    const first = content[span.from]!.line;
    const last = content[span.to]!.line + 1;
    return extraMarks(marksOf(words.filter((x) => x.line >= first && x.line <= last).map((x) => x.w)), recMarks);
  };

  if (rec.length > 0 && embedded && sameTitle(embedded, record.title) && authorOk) {
    const span = titleSpan(rec, content, rec.length);
    return besideInText(span).length ? no("other-version") : { match: true, by: "title", evidence };
  }
  // The embedded title is the record's title with a volume, edition, review … mark beside it.
  if (embeddedExtra.length && rec.length > 0) {
    const markWords = new Set([...Object.keys(OTHER_WORDS), ...Object.keys(VOLUME_MARK)]);
    const ew = plainWords(embedded);
    const kept = ew.filter((w, k) => !markWords.has(w) && !(k > 0 && VOLUME_MARK[ew[k - 1]!] && numberValue(w, ew[k - 1]) !== undefined) && !ORDINAL_WORDS[w]);
    const keptContent = kept.filter((w) => !STOP_WORDS.has(w));
    if (keptContent.length === rec.length && keptContent.every((w, i) => w === rec[i])) return no("other-version");
  }
  if (rec.length >= 3 && authorOk) {
    const span = titleSpan(rec, content, Math.max(3, Math.ceil(rec.length * 0.9)));
    if (span) return besideInText(span).length || embeddedExtra.length ? no("other-version") : { match: true, by: "title", evidence };
  }
  if (fullText.replace(/\s+/gu, "").length < MIN_TEXT_CHARS && !(embedded && sameTitle(embedded, record.title))) return no("no-text");
  return no("title-absent");
}
