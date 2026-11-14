/**
 * The file check (Find and acquire, Task F11; Ruling R277 a, rebuilt by R282 a–c): is a downloaded file the work of
 * the record it was found for? The app attaches a file by itself ("match") only on strong, positive evidence that the
 * file IS the record's work; everything else is a mismatch with its reason, and the runner holds the file for the
 * researcher's check. **The DOI alone never matches; an embedded title alone never matches; a file without readable
 * text never matches.** The cost is accepted: some right files go to the researcher.
 *
 * The file's text and metadata are read through the library's own extraction (`extract/pdf.ts`, `extract/epub.ts`,
 * under their limits: the first 3 pages or sections, at most 20,000 characters, the R50 zip limits; nothing embedded
 * is run or fetched). Only the first FILE_CHECK_TEXT_CHARS (2,000) characters of that text are looked at for the
 * title and the DOIs. Words are F2's tokens (`segmentsOf`); a title's *content words* leave out F2's small joining
 * words (`STOP_WORDS`). A word hyphenated across a line end (the next line starting in lower case) is one word.
 *
 * A file can match only if ALL of 1–4 hold, and then ONE of 5a / 5b:
 *  1. **Readable text:** at least MIN_TEXT_CHARS (200) characters of text, spaces left out. Otherwise "no-text"
 *     (also when the extraction fails, or the file is encrypted or damaged).
 *  2. **No sign of another kind of document** in the *title zone*: the embedded title, and the text from the top of
 *     the first page to three lines after the title block (5b) — when no block is found, the first 1,000 characters.
 *     A sign is one of OTHER_KIND_PHRASES as whole words, in any case, anywhere in the zone; or one of ABOUT_LABELS
 *     ("review of", "reply to", "notes on", …) followed directly by the record's title (its first six words) or its
 *     first author's family name ("the", colons, quotes and line breaks may stand between: R284 a); or a line that is
 *     only one of OTHER_KIND_LINES (a section label, "Editorial" among them). A label the record's own title holds is
 *     not a sign; a journal's name ("Review of Economic Studies", "Editorial Board") is not one. Otherwise "other-kind".
 *  3. **No other version** (R284 a): in the embedded title, a volume, part, book or edition number the record's title
 *     lacks; in the text, a short line of its own (at most eight words) that begins with volume, vol., part or book and
 *     a number, or with an edition form ("Second edition", "2nd ed.", "Revised edition") — or is the record's title
 *     followed by one — whose phrase the record's title lacks, and that is not a journal's citation line ("no.", "pp.",
 *     "issue" or a page range). Such a line counts within three lines before or after the title block; without a
 *     block, on the lines of the title's in-order occurrence and the three after (5a), or in the whole title zone (an
 *     embedded title with its words in the text, 5b). Otherwise "other-version".
 *  4. **No other DOI presented as the document's own:** when the record has a DOI, a *labelled* DOI (`doi:`, `DOI`,
 *     `https://doi.org/…`, `dx.doi.org/…`) in the file's metadata or the first 2,000 characters that is not the
 *     record's means "other-doi" — unless the record's DOI is also labelled there and comes first (the metadata's
 *     DOIs come before the text's). DOIs are compared case-insensitively, after removing trailing full stops,
 *     commas, semicolons, brackets and quotes, and after joining a DOI broken across a line end (the next line
 *     starts in lower case or with a digit, or the DOI ends with a hyphen, slash or underscore); a DOI that is only
 *     a prefix of another is a different DOI.
 *  5a. **With the record's DOI** labelled (as in 4): at least 90% of the title's content words (all of them under
 *     three) in order within the first 2,000 characters, BEGINNING on a line that starts within the first 800
 *     characters (a paper that only cites the record does so lower down: R284 b) — in a stretch of at most 2n + 4 content words, so the
 *     title is not put together from words scattered over the page — AND the first author's family name within the
 *     first 2,000 characters or in the file's author metadata. `by: "doi"`.
 *  5b. **Without it:** the record's title as a *title block* in the first 2,000 characters — one to four
 *     consecutive lines whose content words are EXACTLY the title's, nothing before or after on those lines; not a
 *     block when the line before ends with a colon or dash (the record's title is another title's subtitle), the
 *     block's last line ends with one (a subtitle the record lacks follows), or the next line starts in lower case
 *     (the title goes on) — OR the embedded title is the record's title by F10's `sameTitle` AND all the title's
 *     content words occur in order (as in 5a) within the first 2,000 characters; AND, either way, the first
 *     author's family name within the 600 characters after the title (after the block's last line; after the
 *     occurrence's last word: the rest of its line, then 600 characters) or in the file's author metadata. `by: "title"`.
 * Whatever the evidence, an embedded title of three or more content words that is not the record's title — nor the
 * record's title with a subtitle, nor its main title when the record's title holds a subtitle — is another document's:
 * "title-absent" (R284 b). An embedded title that names a file ("Microsoft Word - …", "….pdf", "untitled") is ignored.
 * Anything else is "title-absent". When several reasons apply, the first of: no-text, other-doi, other-kind,
 * other-version, title-absent.
 *
 * What the check found is returned for the review queue (R277 d), bounded and cleaned (invisible and control
 * characters removed): the first labelled DOI that is not the record's, the embedded title and the start of the
 * text (each at most FILE_CHECK_EVIDENCE_CHARS characters), the kind and the size. It is outside text: shown only
 * through UserText, never logged or audited.
 */
import * as fsp from "node:fs/promises";
import type { Creator } from "@ao/core";
import { extractEpub } from "../extract/epub.js";
import { extractPdf } from "../extract/pdf.js";
import type { RawExtract } from "../extract/types.js";
import { sameTitle } from "./free-copy.js";
import { cleanText, segmentTokens, segmentsOf, type Segment } from "./reference.js";
import { STOP_WORDS, numberValue } from "./search.js";

/** How much of the file's text is looked at for the title and the DOIs. */
export const FILE_CHECK_TEXT_CHARS = 2000;
/** The longest embedded title and start of text kept as evidence for the researcher. */
export const FILE_CHECK_EVIDENCE_CHARS = 300;
/** A file with fewer characters of text than this (spaces left out) has no readable text: "no-text". */
const MIN_TEXT_CHARS = 200;
/** The title zone when no title block is found. */
const ZONE_CHARS = 1000;
/** The first author's family name must stand within this many characters after the title. */
const AUTHOR_AFTER_CHARS = 600;
/** A title block is at most this many lines. */
const BLOCK_LINES_MAX = 4;
/** With the record's DOI, the title's words must begin within this many characters of the text (R284 b). */
const DOI_TITLE_START_CHARS = 800;
/** An embedded title that names a file, not a work: ignored when telling another document (R284 b). */
const FILE_NAME_TITLE = /^(?:untitled|microsoft word\s*-.*|.*\.(?:pdf|docx?|tex|indd|rtf|odt|txt|epub))$/iu;
/** A title's main title: what comes before its first subtitle mark. */
const mainTitle = (s: string): string => s.split(/\s*[:;\u2013\u2014]\s*|\s+-\s+|\.\s+/u)[0] ?? s;
/** The lines after (and before) the title looked at for a sign or a version. */
const LINES_AROUND = 3;
/** The longest title compared (in content words); a longer title is compared on its first words. */
const TITLE_WORDS_MAX = 100;

export type FileCheckRecord = { title: string; creators: Creator[]; doi?: string };
export type FileMismatchWhy = "other-doi" | "title-absent" | "no-text" | "other-version" | "other-kind";
/** What the check found (outside text, bounded): for the researcher's own judgement in the review queue. */
export type FileEvidence = {
  kind: "pdf" | "epub";
  bytes: number;
  /** The first labelled DOI of the file (metadata, then the first 2,000 characters) that is not the record's. */
  fileDoi?: string;
  embeddedTitle?: string;
  textStart?: string;
};
export type FileCheckResult = ({ match: true; by: "doi" | "title" } | { match: false; why: FileMismatchWhy }) & { evidence: FileEvidence };

/** Labels that say the file is another kind of document than the work (whole words, any case). */
const OTHER_KIND_PHRASES: readonly string[] = [
  "book review",
  "book reviews",
  "review essay",
  "reviewed work",
  "reviewed works",
  "reviewed by",
  "erratum",
  "errata",
  "corrigendum",
  "corrigenda",
  "retraction",
  "retracted",
  "rejoinder",
  "addendum",
  "supplement to",
  "supplementary material for",
  "supplementary materials for",
  "supporting information for",
  "obituary",
  "letter to the editor",
];
/**
 * Labels of a document ABOUT a work (R284 a): a sign only when the record's title (its first six words) or its first
 * author's family name follows directly — a colon, quotation marks, "the" and a line break may stand between.
 */
const ABOUT_LABELS: readonly string[] = ["review of", "comment on", "comments on", "commentary on", "reply to", "response to", "correction to", "notes on", "summary of", "introduction to"];
/** A line that is only one of these words is a section label: another kind of document. */
const OTHER_KIND_LINES: ReadonlySet<string> = new Set(["review", "reviews", "comment", "comments", "reply", "correction", "corrections", "erratum", "editorial", "supplement"]);

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

const plainWords = (s: string): string[] => segmentsOf(s.slice(0, 4000)).flatMap((x: Segment) => segmentTokens(x));
/** A title's content words in order (F10's `contentWords`: F2's tokens without F2's small joining words). */
const contentWords = (s: string): string[] => plainWords(s).filter((w) => !STOP_WORDS.has(w));
const containsRun = (hay: readonly string[], run: readonly string[]): boolean => run.length > 0 && ` ${hay.join(" ")} `.includes(` ${run.join(" ")} `);
const sameWords = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

/** A non-empty line of the text, with where it ends (in the text). */
type Line = { text: string; start: number; end: number };
/** A word with the line it ends on. */
type Word = { w: string; line: number };

/** A line ends with a word hyphenated to the next line, which starts in lower case. */
const HYPHEN_END = /\p{L}[-­‐]$/u;
const LOWER_START = /^\p{Ll}/u;

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (t) out.push({ text: t, start: at, end: at + raw.length });
    at += raw.length + 1;
  }
  return out;
}

/** The lines' words in order; a word hyphenated across a line end is one word (on the later line). */
function wordsOf(lines: readonly Line[]): Word[] {
  const out: Word[] = [];
  lines.forEach((l, i) => {
    const ws = plainWords(l.text);
    const prev = lines[i - 1];
    if (prev && HYPHEN_END.test(prev.text) && LOWER_START.test(l.text) && out.length && out[out.length - 1]!.line === i - 1 && ws.length) {
      const last = out.pop()!;
      out.push({ w: last.w + ws.shift()!, line: i });
    }
    for (const w of ws) out.push({ w, line: i });
  });
  return out;
}

/** The content words of lines i..j joined (hyphenated words joined), and with the hyphen as a word break. */
function blockWords(lines: readonly Line[], i: number, j: number): string[][] {
  const part = lines.slice(i, j + 1);
  const joined = part.reduce((acc, l, k) => (k === 0 ? l.text : HYPHEN_END.test(part[k - 1]!.text) && LOWER_START.test(l.text) ? acc.slice(0, -1) + l.text : `${acc} ${l.text}`), "");
  return [contentWords(joined), contentWords(part.map((l) => l.text).join(" "))];
}

const CONTINUES = /[:–—-]$/u;

/** The title blocks: one to four consecutive lines whose content words are exactly the title's (see the top). */
function titleBlocks(lines: readonly Line[], rec: readonly string[]): Array<{ first: number; last: number }> {
  const out: Array<{ first: number; last: number }> = [];
  if (!rec.length) return out;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && CONTINUES.test(lines[i - 1]!.text)) continue;
    for (let j = i; j < Math.min(lines.length, i + BLOCK_LINES_MAX); j++) {
      if (!blockWords(lines, i, j).some((ws) => sameWords(ws, rec))) continue;
      const next = lines[j + 1];
      if (CONTINUES.test(lines[j]!.text) || (next && LOWER_START.test(next.text))) break;
      out.push({ first: i, last: j });
      break;
    }
  }
  return out;
}

/**
 * Where the title's content words stand in order: at least `need` of them, in a stretch of at most 2n + 4 content
 * words. Every such place, as the first and last matched positions (in `content`).
 */
function titleSpans(rec: readonly string[], content: readonly Word[], need: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const n = rec.length;
  if (!n) return out;
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
    if (best >= need) out.push({ from: i, to: i + prev.findIndex((v) => v === best) - 1 });
  }
  return out;
}

/** The volume words, each with the mark it makes ("vol" and "volume" are one). */
const VOLUME_MARK: Readonly<Record<string, string>> = { volume: "volume", vol: "volume", band: "volume", tome: "volume", tomo: "volume", part: "part", book: "book", edition: "edition", ed: "edition" };
const ORDINAL_WORDS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/** The version marks among words: "volume:2", "edition:2", … (a number of 1,000 or more is a year, not a volume). */
function marksOf(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const prev = k > 0 ? words[k - 1] : undefined;
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
const NUMBER_WORDS: ReadonlySet<string> = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
const EDITION_WORDS: ReadonlySet<string> = new Set(["revised", "new", "expanded", "enlarged", "updated", "abridged", "corrected"]);
/**
 * A sign of another version (R284 a): a short line of its own — at most eight words — that begins with volume, vol.,
 * part or book and a number, or with an edition form ("Second edition", "2nd ed.", "Revised edition", "Edition 2"),
 * whose phrase the record's title does not hold; never a journal's citation line (it also holds "no.", "pp.", "issue"
 * or a page range).
 */
function versionLine(ws: readonly string[], line: string, recAll: readonly string[]): boolean {
  if (!ws.length || ws.length > 8 || ws.some((w) => w === "no" || w === "pp" || w === "issue") || /\d\s*[-\u2013\u2014]\s*\d/u.test(line)) return false;
  const [a, b] = ws as [string, string | undefined];
  if (b === undefined) return false;
  const head =
    (["volume", "vol", "part", "book"].includes(a) && (numberValue(b, a) !== undefined || NUMBER_WORDS.has(b))) ||
    ((a === "edition" || a === "ed") && numberValue(b, a) !== undefined) ||
    ((b === "edition" || b === "ed") && (ORDINAL_WORDS[a] !== undefined || /^\d{1,3}(?:st|nd|rd|th)$/u.test(a) || EDITION_WORDS.has(a)));
  return head && !containsRun(recAll, [a, b]);
}

/** The first author's family name as words (an organisation: its name), or null. */
function firstFamily(creators: Creator[]): string[] | null {
  const cs = Array.isArray(creators) ? creators.slice(0, 100) : [];
  const name = (c: Creator | undefined) => (c ? (c.family ?? c.literal ?? "") : "");
  const pick = cs.find((c) => c.role === "author" && name(c)) ?? cs.find((c) => name(c));
  const words = pick ? plainWords(name(pick)) : [];
  return words.length && words.join("").length >= 2 ? words : null;
}

/** A DOI as compared: lower case, without a resolver or "doi:", without trailing punctuation. */
function doiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\/|^doi:\s*/iu, "")
    .replace(/[.,;:)\]}>"'”’]+$/u, "")
    .toLowerCase();
}

/** A labelled DOI: `doi:`, `DOI`, `https://doi.org/…`, `dx.doi.org/…`. */
const LABELLED_DOI = /(?<![\p{L}\p{N}])(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/|doi(?:\s*:\s*|\s+))(10\.\d{4,9}\/\S+)/giu;

/** The labelled DOIs whose label starts in the first FILE_CHECK_TEXT_CHARS characters, in order (a DOI broken across a line end joined). */
function labelledDois(fullText: string): string[] {
  const hay = fullText.slice(0, FILE_CHECK_TEXT_CHARS + 300);
  const out: string[] = [];
  for (const m of hay.matchAll(LABELLED_DOI)) {
    if (m.index >= FILE_CHECK_TEXT_CHARS) break;
    let doi = m[1]!;
    const end = m.index + m[0].length;
    const next = /^\n[ \t]*(\S+)/u.exec(hay.slice(end));
    if (next && (/[-/_]$/u.test(doi) || /^[\p{Ll}\p{N}]/u.test(next[1]!))) doi += next[1]!;
    const key = doiKey(doi);
    if (key) out.push(key);
  }
  return out;
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

  // 4. The labelled DOIs: the metadata's, then the text's (evidence first: it is shown whatever the reason).
  const recDoi = record.doi ? doiKey(record.doi) || undefined : undefined;
  const dois = [...(raw?.ids?.dois ?? []).map(doiKey).filter(Boolean), ...labelledDois(fullText)];
  const otherDoi = dois.find((d) => d !== recDoi);
  if (otherDoi) evidence.fileDoi = shown(otherDoi)!;

  // 1. Readable text.
  if (!raw || fullText.replace(/\s+/gu, "").length < MIN_TEXT_CHARS) return no("no-text");
  // 4. No other DOI presented as the document's own.
  if (recDoi && otherDoi && dois[0] !== recDoi) return no("other-doi");
  const withDoi = !!recDoi && dois.includes(recDoi);

  // The title: as a block, or its words in order; and the first author after it.
  const lines = linesOf(text);
  const words = wordsOf(lines);
  const content = words.filter((x) => !STOP_WORDS.has(x.w));
  const rec = contentWords(record.title).slice(0, TITLE_WORDS_MAX);
  const recAll = plainWords(record.title);
  const family = firstFamily(record.creators);
  const fileNames = (raw.creators ?? []).slice(0, 100).map((c) => plainWords([c.given, c.family, c.literal].filter(Boolean).join(" ")));
  const inMeta = !!family && fileNames.some((nm) => containsRun(nm, family));
  const afterLine = (line: number) => !!family && containsRun(plainWords(fullText.slice(lines[line]!.end, lines[line]!.end + AUTHOR_AFTER_CHARS)), family);
  const authorAfter = (line: number) => inMeta || afterLine(line);
  /** After an occurrence's last word: the rest of its line, then 600 characters. */
  const authorAfterWord = (k: number) => {
    const line = content[k]!.line;
    const at = words.indexOf(content[k]!);
    const rest = words.slice(at + 1).filter((x) => x.line === line).map((x) => x.w);
    return authorAfter(line) || (!!family && containsRun(rest, family));
  };

  const blocks = titleBlocks(lines, rec);
  const block = blocks.find((b) => authorAfter(b.last)) ?? blocks[0];
  const embedded = raw.title ?? "";
  const embeddedSame = !!embedded && rec.length > 0 && sameTitle(embedded, record.title);
  const allSpans = titleSpans(rec, content, rec.length);
  const span = allSpans.find((s) => authorAfterWord(s.to)) ?? allSpans[0];
  const doiSpan = titleSpans(rec, content, rec.length < 3 ? rec.length : Math.ceil(rec.length * 0.9)).find((sp) => lines[content[sp.from]!.line]!.start < DOI_TITLE_START_CHARS);

  // 2. No sign of another kind of document in the title zone.
  const zoneLines = block ? lines.slice(0, block.last + 1 + LINES_AROUND).map((l) => l.text) : linesOf(text.slice(0, ZONE_CHARS)).map((l) => l.text);
  const textZoneWords = plainWords(zoneLines.join("\n"));
  if (embedded) zoneLines.push(embedded);
  const zoneWords = plainWords(zoneLines.join("\n"));
  const recHead = (recAll[0] === "the" ? recAll.slice(1) : recAll).slice(0, 6);
  /** A label of a document about a work, followed directly by the record's title or its first author's family name. */
  const aboutIn = (ws: readonly string[]) =>
    ABOUT_LABELS.some((p) => {
      const pw = plainWords(p);
      if (containsRun(recAll, pw)) return false;
      for (let k = 0; k + pw.length <= ws.length; k++) {
        if (!pw.every((w, i) => ws[k + i] === w)) continue;
        let j = k + pw.length;
        while (ws[j] === "the") j++;
        const after = ws.slice(j);
        if (recHead.length && recHead.every((w, i) => after[i] === w)) return true;
        if (family && family.every((w, i) => after[i] === w || (i === family.length - 1 && after[i] === `${w}s`))) return true;
      }
      return false;
    });
  const sign =
    OTHER_KIND_PHRASES.some((p) => {
      const pw = plainWords(p);
      return containsRun(zoneWords, pw) && !containsRun(recAll, pw);
    }) ||
    aboutIn(textZoneWords) ||
    (!!embedded && aboutIn(plainWords(embedded))) ||
    zoneLines.some((l) => {
      const lw = plainWords(l);
      return lw.length === 1 && OTHER_KIND_LINES.has(lw[0]!) && !recAll.includes(lw[0]!);
    });
  if (sign) return no("other-kind");

  // 3. No other version beside the title: in the embedded title, or a short line of its own (R284 a). A line that is
  // the record's title followed by such a phrase ("CAPITAL Volume II") is one too.
  const recMarks = marksOf(recAll);
  const versionIn = (ws: readonly string[]) => [...marksOf(ws)].some((m) => !recMarks.has(m));
  const versionAt = (ls: readonly string[]) =>
    ls.some((l) => {
      const ws = plainWords(l);
      const rest = recAll.length && recAll.every((w, i) => ws[i] === w) ? ws.slice(recAll.length) : null;
      return versionLine(ws, l, recAll) || (!!rest && versionLine(rest, l, recAll));
    });
  const ew = embedded ? plainWords(embedded) : [];
  const ec = ew.filter((w) => !STOP_WORDS.has(w));
  let version = versionIn(ew) || (ec.length > rec.length && rec.length > 0 && rec.every((w, i) => ec[i] === w) && ec.slice(rec.length).some((w) => numberValue(w, undefined) !== undefined && !recAll.includes(w)));
  if (block) {
    const after = lines.slice(block.last + 1, block.last + 1 + LINES_AROUND).map((l) => l.text);
    const before = lines.slice(Math.max(0, block.first - LINES_AROUND), block.first).map((l) => l.text);
    version ||= versionAt(after) || versionAt(before);
  } else if (withDoi && doiSpan) {
    const from = content[doiSpan.from]!.line;
    version ||= versionAt(lines.slice(from, content[doiSpan.to]!.line + 1 + LINES_AROUND).map((l) => l.text));
  } else if (embeddedSame && span) {
    version ||= versionAt(zoneLines);
  }
  if (version) return no("other-version");

  // An embedded title of three or more content words that is not the record's title (nor it with a subtitle, nor its
  // main title) is another document's, whatever the other evidence (R284 b). A file name is not a title.
  const et = embedded.trim();
  if (et && !FILE_NAME_TITLE.test(et) && contentWords(et).length >= 3 && !sameTitle(et, record.title) && !sameTitle(mainTitle(et), record.title) && !sameTitle(et, mainTitle(record.title))) return no("title-absent");

  // 5a. With the record's DOI: the title's words in order and the first author.
  if (withDoi && doiSpan && family && (inMeta || containsRun(words.map((x) => x.w), family))) return { match: true, by: "doi", evidence };
  // 5b. Without it: the title as a block, or the exact embedded title with its words in order; the author after it.
  if (block && authorAfter(block.last)) return { match: true, by: "title", evidence };
  if (embeddedSame && span && authorAfterWord(span.to)) return { match: true, by: "title", evidence };
  return no("title-absent");
}
