/**
 * The file check (Find and acquire, Task F11; Ruling R277 a, rebuilt by R282 a–c, stated in closed form by R292): is
 * a downloaded file the work of the record it was found for? The app attaches a file by itself ("match") only on
 * strong, positive evidence that the file IS the record's work: ONE structure that the file's first page must show,
 * the same for every file, with or without a DOI. Everything else is a mismatch with its reason, and the runner holds
 * the file for the researcher's check. The cost is accepted (R292): more right files go to the researcher.
 *
 * The file's text and metadata are read through the library's own extraction (`extract/pdf.ts`, `extract/epub.ts`,
 * under their limits: the first 3 pages or sections, at most 20,000 characters, the R50 zip limits; nothing embedded
 * is run or fetched). A *line* is a line of that text that is not empty (a PDF's text line; an EPUB's paragraph or
 * heading), trimmed. Words are F2's tokens (`segmentsOf`: case, accents, ligatures and invisible characters folded);
 * a title's *content words* leave out F2's small joining words (`STOP_WORDS`).
 *
 * A file matches only if ALL of these hold (R292, clauses 1–8):
 *  1. **Readable text:** at least MIN_TEXT_CHARS (200) characters of text, spaces left out. Otherwise "no-text"
 *     (also when the extraction fails, or the file is encrypted or damaged).
 *  2. **The title block:** one to BLOCK_LINES_MAX (4) consecutive lines, the first beginning within the first
 *     FILE_CHECK_TEXT_CHARS (2,000) characters of the text, whose content words taken together are EXACTLY the
 *     record's title's content words in the same sequence (the first TITLE_WORDS_MAX of them) — no missing word, no
 *     extra word; joining words and punctuation do not count. A word hyphenated across a line end (the next line
 *     starting in lower case) is tried both joined and as two words.
 *  3. **The author line directly below:** the next line after the block (a line with no letter and no digit — a
 *     rule, asterisks — counts as empty: R293 d) is a line of names holding the first author's family name
 *     (`firstFamily`: the first creator with the role author, else the first creator). Commas, semicolons and full
 *     stops are left out, and so are affiliation marks glued to a name (NAME_MARKS: digits, *, †, ‡, §, ¶,
 *     superscripts) and a number of one or two digits standing by itself ("1", "1,2": R293 c); then every token must
 *     be a name of a creator of the record, a capitalised word, an initial, or one of NAME_JOINING_WORDS. A number of
 *     three or more digits (a year among them), a price, "pp.", a web or e-mail address, or one of NOT_NAME_WORDS
 *     (volume, vol, part, book, edition, chapter, section, issue: R293 c) makes it not a line of names; so do more
 *     than NAME_LINE_TOKENS_MAX (30) tokens.
 *  4. **Nothing unexplained directly above:** the line directly above the block (a line with no letter and no digit
 *     counts as empty: R293 d) is none (the block opens the text); a
 *     line holding a digit, a web address or an e-mail address; a line holding the record's container title (when
 *     the record has one); a line of RUNNING_TEXT_WORDS (8) or more words; or one of ORDINARY_LABELS as the whole
 *     line, in any case. Anything else ("Supporting Information", "Symposium", a journal's name the record does not
 *     give, a line of punctuation alone) is "other-kind": the rule fails closed on a label it does not know.
 *  5. **No sign of another kind of document in the title zone:** the lines from the top of the text to
 *     ZONE_LINES_AFTER (3) lines after the block, and the embedded title (R282 a, R284 a as built). A sign is one of
 *     OTHER_KIND_PHRASES as whole words anywhere in the zone; one of ABOUT_LABELS ("review of", "reply to", …)
 *     followed directly by the record's title (its first six words) or its first author's family name ("the",
 *     colons, quotes and line breaks may stand between); a line that is only one of OTHER_KIND_LINES; or a line that
 *     begins with one of ADDED_KIND_LABELS of two or more words, or is a single-word one as the whole line (any
 *     case, punctuation aside: R293 b). A label the record's own title holds is not a sign. Otherwise "other-kind".
 *  6. **No sign of another version or of a part:** from VERSION_LINES_ABOVE (3) lines above the block to
 *     VERSION_LINES_BELOW (12) lines below it, a short line of its own (at most eight words) that begins with volume,
 *     vol., part or book and a number, or with an edition form ("Second edition", "2nd ed.", "Revised edition") — or
 *     is the record's title followed by one (R286) — whose phrase the record's title lacks, and that is not a
 *     journal's citation line ("no.", "pp.", "issue" or a page range) (R284 a as built); or a line that begins with a
 *     heading of PART_HEADINGS (chapter, part, section) numbered two or more, with no heading of the same word
 *     numbered one on a line before it (R292, I6); or, in the embedded title, a volume, part, book or edition number
 *     the record's title lacks (as built). Otherwise "other-version".
 *  7. **No other DOI presented as the document's own** (R282 a as built): when the record has a DOI, a *labelled*
 *     DOI (`doi:`, `DOI`, `https://doi.org/…`, `dx.doi.org/…`) in the file's metadata or the first 2,000 characters
 *     that is not the record's means "other-doi" — unless the record's DOI is also labelled there and comes first
 *     (the metadata's DOIs come before the text's). DOIs are compared case-insensitively, after removing trailing
 *     full stops, commas, semicolons, brackets and quotes, and after joining a DOI broken across a line end (the next
 *     line starts in lower case or with a digit, or the DOI ends with a hyphen, slash or underscore); a DOI that is
 *     only a prefix of another is a different DOI. **A DOI is never evidence**, in the text or in the metadata.
 *  8. **The embedded title is never evidence:** an embedded title of two or more content words that is not the
 *     record's title (by F10's `sameTitle`) — nor the record's title with a subtitle, nor its main title when the
 *     record's title holds a subtitle — is another document's: "title-absent". An embedded title that names a file
 *     (FILE_NAME_TITLE: "Microsoft Word - …", "….pdf", "untitled") is ignored.
 * Where several places satisfy 2 and 3 (a cover sheet and the first page; a running head), the file matches if ANY
 * one of them also satisfies 4–6, judged around THAT place; 1, 7 and 8 hold for the file as a whole. Otherwise the
 * reason is the first of no-text, other-doi, other-kind, other-version, title-absent among those that apply (to any
 * place). A match says `by: "title"` always: the asset's provenance records it (`AcquiredFrom.check.by`).
 * **The reason when no place satisfies 2 and 3 (R293 e):** "other-kind" or "other-version" if a sign of clause 5 or
 * 6 (the embedded title's included) stands on a line beginning within REASON_ZONE_CHARS (1,000) characters,
 * otherwise "title-absent". It is worked out only after "no match" is decided, and never changes it.
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

/** Clauses 2 and 7: the title block begins, and labelled DOIs are read, within this many characters of the text. */
export const FILE_CHECK_TEXT_CHARS = 2000;
/** The longest embedded title and start of text kept as evidence for the researcher. */
export const FILE_CHECK_EVIDENCE_CHARS = 300;
/** Clause 1: a file with fewer characters of text than this (spaces left out) has no readable text: "no-text". */
const MIN_TEXT_CHARS = 200;
/** Clause 2: a title block is at most this many lines. */
const BLOCK_LINES_MAX = 4;
/** Clause 2: the longest title compared (in content words); a longer title is compared on its first words. */
const TITLE_WORDS_MAX = 100;
/** Clause 3: a line of names has at most this many tokens. */
const NAME_LINE_TOKENS_MAX = 30;
/** Clause 4: a line above the block of at least this many words is running text (a cover sheet's sentence). */
const RUNNING_TEXT_WORDS = 8;
/** Clause 5: the title zone runs from the top of the text to this many lines after the block. */
const ZONE_LINES_AFTER = 3;
/** Clause 6: a sign of another version or part counts from this many lines above the block … */
const VERSION_LINES_ABOVE = 3;
/** Clause 6: … to this many lines below it (M10). */
const VERSION_LINES_BELOW = 12;
/** R293 e: with no place, a sign on a line beginning within this many characters gives the reason. */
const REASON_ZONE_CHARS = 1000;

/** Clause 3: the small words that join or begin names (any case). */
const NAME_JOINING_WORDS: ReadonlySet<string> = new Set(["and", "&", "by", "with", "et", "al", "de", "del", "della", "der", "den", "di", "da", "dos", "du", "la", "le", "van", "von", "bin", "ibn", "al", "el", "y", "e", "i", "jr", "sr"]);
/** Clause 3 (R293 c): a line holding one of these words (whole word, any case) is not a line of names. */
const NOT_NAME_WORDS: ReadonlySet<string> = new Set(["volume", "vol", "part", "book", "edition", "chapter", "section", "issue"]);
/** Clause 3 (R293 c): a number of one or two digits standing by itself is an affiliation mark ("1", "1,2", "¹"). */
const AFFILIATION_NUMBER = /^[\d\u00B2\u00B3\u00B9\u2070-\u2079]{1,2}$/u;
/** Clause 3: affiliation marks glued to the start or end of a name (digits, *, †, ‡, §, ¶, superscript characters). */
const NAME_MARKS = /^[\p{Nd}*†‡§¶²³¹⁰-₟ᴬ-ᵪ]+|[\p{Nd}*†‡§¶²³¹⁰-₟ᴬ-ᵪ]+$/gu;
/** Clause 4: the ordinary article labels, allowed as the whole line directly above the block (any case). */
const ORDINARY_LABELS: readonly string[] = [
  "article",
  "research article",
  "original article",
  "original paper",
  "original research",
  "research paper",
  "full paper",
  "full length article",
  "review article",
  "brief report",
  "short communication",
  "brief communication",
  "rapid communication",
  "letter",
  "open access",
  "preprint",
  "pre-print",
  "working paper",
  "discussion paper",
  "accepted manuscript",
  "author accepted manuscript",
  "author's accepted manuscript",
  "postprint",
  "post-print",
  "manuscript",
  "article in press",
  "version of record",
  "published version",
];
/** Clause 5 (R292, R293 b): the added labels of another kind — of two or more words, as a line's beginning; of one word, only as the whole line. */
const ADDED_KIND_LABELS: readonly string[] = [
  "supporting information",
  "supplementary information",
  "supplementary material",
  "supplementary materials",
  "supplementary data",
  "online appendix",
  "online supplement",
  "appendix",
  "si appendix",
  "data supplement",
  "contents",
  "table of contents",
  "abstracts",
  "conference abstracts",
  "book of abstracts",
  "book notes",
  "books received",
  "publisher's note",
  "editor's note",
  "expression of concern",
  "in memoriam",
  "index",
  "front matter",
  "back matter",
];
/** Clause 5 (R282 a, R284 a as built): labels that say the file is another kind of document (whole words, any case). */
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
 * Clause 5 (R284 a as built): labels of a document ABOUT a work — a sign only when the record's title (its first six
 * words) or its first author's family name follows directly; a colon, quotation marks, "the" and a line break may
 * stand between.
 */
const ABOUT_LABELS: readonly string[] = ["review of", "comment on", "comments on", "commentary on", "reply to", "response to", "correction to", "notes on", "summary of", "introduction to"];
/** Clause 5 (R282 a as built): a line that is only one of these words is a section label: another kind of document. */
const OTHER_KIND_LINES: ReadonlySet<string> = new Set(["review", "reviews", "comment", "comments", "reply", "correction", "corrections", "erratum", "editorial", "supplement"]);
/** Clause 6 (R292, I6): the headings of a part of a work; one numbered two or more with none numbered one before it is a part. */
const PART_HEADINGS: ReadonlySet<string> = new Set(["chapter", "part", "section"]);
/** Clause 8: an embedded title that names a file, not a work: ignored. */
const FILE_NAME_TITLE = /^(?:untitled|microsoft word\s*-.*|.*\.(?:pdf|docx?|tex|indd|rtf|odt|txt|epub))$/iu;
/** Clause 8: a title's main title — what comes before its first subtitle mark. */
const mainTitle = (s: string): string => s.split(/\s*[:;–—]\s*|\s+-\s+|\.\s+/u)[0] ?? s;

export type FileCheckRecord = {
  title: string;
  creators: Creator[];
  doi?: string;
  /** Clause 4: the journal's or the book's name, when the record has one (a line holding it may stand above the block). */
  container?: string;
};
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
/** `by` is always "title" (R292: a DOI is never evidence); it is kept because the asset's provenance records it. */
export type FileCheckResult = ({ match: true; by: "title" } | { match: false; why: FileMismatchWhy }) & { evidence: FileEvidence };

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
const startsWithRun = (hay: readonly string[], run: readonly string[]): boolean => run.length > 0 && run.every((w, i) => hay[i] === w);
const sameWords = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

/** A non-empty line of the text, trimmed, with where it starts and ends (in the text). */
type Line = { text: string; start: number; end: number };

/** A line ends with a word hyphenated to the next line, which starts in lower case. */
const HYPHEN_END = /\p{L}[-­‐]$/u;
const LOWER_START = /^\p{Ll}/u;

/** R293 d: a line with no letter and no digit (a rule, asterisks) counts as empty in clauses 3 and 4. */
const blankish = (l: Line | undefined): boolean => !!l && !/[\p{L}\p{N}]/u.test(l.text);

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

/** Clause 2: the content words of lines i..j taken together — with a hyphenated line end joined, and as two words. */
function blockWords(lines: readonly Line[], i: number, j: number): string[][] {
  const part = lines.slice(i, j + 1);
  const joined = part.reduce((acc, l, k) => (k === 0 ? l.text : HYPHEN_END.test(part[k - 1]!.text) && LOWER_START.test(l.text) ? acc.slice(0, -1) + l.text : `${acc} ${l.text}`), "");
  return [contentWords(joined), contentWords(part.map((l) => l.text).join(" "))];
}

/** A place of the title block: its first and last line. */
type Place = { first: number; last: number };

/** Clause 2: every title block — one to four consecutive lines, the first beginning within 2,000 characters. */
function titleBlocks(lines: readonly Line[], rec: readonly string[]): Place[] {
  const out: Place[] = [];
  if (!rec.length) return out;
  for (let i = 0; i < lines.length && lines[i]!.start < FILE_CHECK_TEXT_CHARS; i++) {
    for (let j = i; j < Math.min(lines.length, i + BLOCK_LINES_MAX); j++) {
      if (blockWords(lines, i, j).some((ws) => sameWords(ws, rec))) out.push({ first: i, last: j });
    }
  }
  return out;
}

/** A web address (a scheme, "www.", or a host name with a top-level name) or an e-mail address in a token or line. */
const WEB_ADDRESS = /(?:https?:\/\/|www\.)\S|[\p{L}\p{N}-]+\.\p{L}{2,}(?:\/\S*)?[.,;:)]*$/iu;
const EMAIL_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const PRICE = /[$£€¥¢]/u;
const hasAddress = (s: string): boolean => s.split(/\s+/u).some((t) => WEB_ADDRESS.test(t) || EMAIL_ADDRESS.test(t));

/** Clause 3: is `line` a line of names holding `family`? `names` are the words of every creator's names. */
function nameLine(line: string, family: readonly string[], names: ReadonlySet<string>): boolean {
  const clean = cleanText(line).replace(/\p{Cf}/gu, "");
  if (plainWords(clean).some((w) => NOT_NAME_WORDS.has(w))) return false;
  const raw = clean.split(/\s+/u);
  const kept: string[] = [];
  for (const tok of raw) {
    if (!tok) continue;
    if (WEB_ADDRESS.test(tok) || EMAIL_ADDRESS.test(tok) || PRICE.test(tok)) return false;
    // A number standing by itself: one or two digits are affiliation marks, left out (R293 c); more (a year) fail.
    if (!/\p{L}/u.test(tok) && /\p{N}/u.test(tok)) {
      if (tok.split(/[,;.]/u).every((x) => !x || AFFILIATION_NUMBER.test(x))) continue;
      return false;
    }
    const t = tok.replace(/[,;.]/gu, "");
    if (!t) continue;
    kept.push(t);
    if (kept.length > NAME_LINE_TOKENS_MAX) return false;
    if (t === "&") continue;
    const w = t.replace(NAME_MARKS, "");
    if (!w || !/\p{L}/u.test(w)) return false;
    if (/^pp$/iu.test(w)) return false;
    if (NAME_JOINING_WORDS.has(w.toLowerCase())) continue;
    if (/^[\p{Lu}\p{Lt}]/u.test(w)) continue;
    if (/^\p{L}$/u.test(w)) continue;
    const ws = plainWords(w);
    if (ws.length && ws.every((x) => names.has(x))) continue;
    return false;
  }
  return containsRun(plainWords(kept.map((t) => t.replace(NAME_MARKS, "")).join(" ")), family);
}

const NUMBER_WORDS: ReadonlySet<string> = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
const NUMBER_WORD_VALUE: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINAL_WORDS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const EDITION_WORDS: ReadonlySet<string> = new Set(["revised", "new", "expanded", "enlarged", "updated", "abridged", "corrected"]);
/** The volume words, each with the mark it makes ("vol" and "volume" are one). */
const VOLUME_MARK: Readonly<Record<string, string>> = { volume: "volume", vol: "volume", band: "volume", tome: "volume", tomo: "volume", part: "part", book: "book", edition: "edition", ed: "edition" };

/** Clause 6 (as built): the version marks among words: "volume:2", "edition:2", … (1,000 or more is a year). */
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

/**
 * Clause 6 (R284 a as built): a short line of its own — at most eight words — that begins with volume, vol., part or
 * book and a number, or with an edition form ("Second edition", "2nd ed.", "Revised edition", "Edition 2"), whose
 * phrase the record's title does not hold; never a journal's citation line ("no.", "pp.", "issue" or a page range).
 */
function versionLine(ws: readonly string[], line: string, recAll: readonly string[]): boolean {
  if (!ws.length || ws.length > 8 || ws.some((w) => w === "no" || w === "pp" || w === "issue") || /\d\s*[-–—]\s*\d/u.test(line)) return false;
  const [a, b] = ws as [string, string | undefined];
  if (b === undefined) return false;
  const head =
    (["volume", "vol", "part", "book"].includes(a) && (numberValue(b, a) !== undefined || NUMBER_WORDS.has(b))) ||
    ((a === "edition" || a === "ed") && numberValue(b, a) !== undefined) ||
    ((b === "edition" || b === "ed") && (ORDINAL_WORDS[a] !== undefined || /^\d{1,3}(?:st|nd|rd|th)$/u.test(a) || EDITION_WORDS.has(a)));
  return head && !containsRun(recAll, [a, b]);
}

/** Clause 6 (R292): a line's beginning as a heading of a part — "chapter", "part" or "section" and its number — or null. */
function headingOf(line: string): { word: string; n: number } | null {
  const [a, b] = plainWords(line.slice(0, 200));
  if (!a || !b || !PART_HEADINGS.has(a)) return null;
  const n = numberValue(b, "part") ?? NUMBER_WORD_VALUE[b] ?? ORDINAL_WORDS[b];
  return n === undefined ? null : { word: a, n };
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

const REASON_ORDER: readonly FileMismatchWhy[] = ["no-text", "other-doi", "other-kind", "other-version", "title-absent"];

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
  const evidence: FileEvidence = { kind, bytes };
  const t = shown(raw?.title);
  if (t) evidence.embeddedTitle = t;
  const ts = shown(fullText.slice(0, FILE_CHECK_TEXT_CHARS));
  if (ts) evidence.textStart = ts;
  const no = (why: FileMismatchWhy): FileCheckResult => ({ match: false, why, evidence });

  // 7. The labelled DOIs: the metadata's, then the text's (evidence first: it is shown whatever the reason).
  const recDoi = record.doi ? doiKey(record.doi) || undefined : undefined;
  const dois = [...(raw?.ids?.dois ?? []).map(doiKey).filter(Boolean), ...labelledDois(fullText)];
  const otherDoi = dois.find((d) => d !== recDoi);
  if (otherDoi) evidence.fileDoi = shown(otherDoi)!;

  // 1. Readable text.
  if (!raw || fullText.replace(/\s+/gu, "").length < MIN_TEXT_CHARS) return no("no-text");
  // 7. No other DOI presented as the document's own.
  if (recDoi && otherDoi && dois[0] !== recDoi) return no("other-doi");

  const lines = linesOf(fullText);
  const rec = contentWords(record.title).slice(0, TITLE_WORDS_MAX);
  const recAll = plainWords(record.title);
  const family = firstFamily(record.creators);
  const names = new Set((Array.isArray(record.creators) ? record.creators.slice(0, 100) : []).flatMap((c) => plainWords([c.given, c.family, c.literal].filter(Boolean).join(" "))));
  const container = record.container ? plainWords(record.container) : [];
  const embedded = raw.title ?? "";

  /** The nearest line below (step 1) or above (step -1) line k that is not empty (R293 d). */
  const nearest = (k: number, step: 1 | -1): Line | undefined => {
    let q = k + step;
    while (blankish(lines[q])) q += step;
    return lines[q];
  };
  // 2 and 3. The places: a title block with a line of names holding the first author's family name directly below.
  const places = family
    ? titleBlocks(lines, rec).filter((p) => {
        const below = nearest(p.last, 1);
        return !!below && nameLine(below.text, family, names);
      })
    : [];

  // 4. Nothing unexplained directly above the block.
  const labels = new Set(ORDINARY_LABELS.map((l) => plainWords(l).join(" ")));
  const aboveExplained = (p: Place): boolean => {
    const above = nearest(p.first, -1);
    if (!above) return true;
    const l = above.text;
    if (/\p{Nd}/u.test(l) || hasAddress(l)) return true;
    const lw = plainWords(l);
    if (container.length && containsRun(lw, container)) return true;
    if (l.split(/\s+/u).filter((x) => /[\p{L}\p{N}]/u.test(x)).length >= RUNNING_TEXT_WORDS) return true;
    return labels.has(lw.join(" "));
  };

  // 5. No sign of another kind of document in the title zone (the embedded title is part of every zone).
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
  const addedLabels = ADDED_KIND_LABELS.map((l) => plainWords(l)).filter((lw) => !containsRun(recAll, lw));
  const kindSign = (p: Place): boolean => kindIn(lines.slice(0, p.last + 1 + ZONE_LINES_AFTER).map((l) => l.text));
  /** Clause 5's signs among `zone` (text lines) and the embedded title. */
  const kindIn = (zone: readonly string[]): boolean => {
    const zoneLines = [...zone];
    const textZoneWords = plainWords(zoneLines.join("\n"));
    if (embedded) zoneLines.push(embedded);
    const zoneWords = plainWords(zoneLines.join("\n"));
    return (
      OTHER_KIND_PHRASES.some((ph) => {
        const pw = plainWords(ph);
        return containsRun(zoneWords, pw) && !containsRun(recAll, pw);
      }) ||
      aboutIn(textZoneWords) ||
      (!!embedded && aboutIn(plainWords(embedded))) ||
      zoneLines.some((l) => {
        const lw = plainWords(l);
        return (lw.length === 1 && OTHER_KIND_LINES.has(lw[0]!) && !recAll.includes(lw[0]!)) || addedLabels.some((al) => (al.length === 1 ? sameWords(lw, al) : startsWithRun(lw, al)));
      })
    );
  };

  // 6. No sign of another version or of a part near the block (and none in the embedded title).
  const recMarks = marksOf(recAll);
  const ew = embedded ? plainWords(embedded) : [];
  const ec = ew.filter((w) => !STOP_WORDS.has(w));
  const embeddedVersion =
    [...marksOf(ew)].some((m) => !recMarks.has(m)) ||
    (ec.length > rec.length && rec.length > 0 && rec.every((w, i) => ec[i] === w) && ec.slice(rec.length).some((w) => numberValue(w, undefined) !== undefined && !recAll.includes(w)));
  /** A heading numbered two or more with no heading of the same word numbered one on a line before it. */
  const partHeading = (k: number): boolean => {
    const h = headingOf(lines[k]!.text);
    if (!h || h.n < 2) return false;
    for (let q = 0; q < k; q++) {
      const g = headingOf(lines[q]!.text);
      if (g && g.word === h.word && g.n === 1) return false;
    }
    return true;
  };
  const versionSign = (p: Place): boolean =>
    versionIn([...Array.from({ length: Math.min(VERSION_LINES_ABOVE, p.first) }, (_, k) => p.first - 1 - k), ...Array.from({ length: VERSION_LINES_BELOW }, (_, k) => p.last + 1 + k).filter((k) => k < lines.length)]);
  /** Clause 6's signs on the lines numbered `window`, and in the embedded title. */
  const versionIn = (window: readonly number[]): boolean => {
    if (embeddedVersion) return true;
    return window.some((k) => {
      const l = lines[k]!.text;
      const ws = plainWords(l);
      const rest = recAll.length && recAll.every((w, i) => ws[i] === w) ? ws.slice(recAll.length) : null;
      return versionLine(ws, l, recAll) || (!!rest && versionLine(rest, l, recAll)) || partHeading(k);
    });
  };

  // 8. An embedded title of two or more content words that is not the record's is another document's.
  const et = embedded.trim();
  const otherTitle = !!et && !FILE_NAME_TITLE.test(et) && contentWords(et).length >= 2 && !sameTitle(et, record.title) && !sameTitle(mainTitle(et), record.title) && !sameTitle(et, mainTitle(record.title));

  // R293 e: no place — not a match. Only the reason told is worked out here: a sign of clause 5 or 6 on the lines
  // beginning within the first 1,000 characters (and in the embedded title), else title-absent.
  if (!places.length) {
    const early = lines.flatMap((l, k) => (l.start < REASON_ZONE_CHARS ? [k] : []));
    if (kindIn(early.map((k) => lines[k]!.text))) return no("other-kind");
    if (versionIn(early)) return no("other-version");
    return no("title-absent");
  }

  // Any one place satisfying 4–6 is enough; otherwise the first reason that applies (to any place, or the file).
  const why = new Set<FileMismatchWhy>();
  if (otherTitle) why.add("title-absent");
  let placed = false;
  for (const p of places) {
    const kindFails = !aboveExplained(p) || kindSign(p);
    const versionFails = versionSign(p);
    if (!kindFails && !versionFails) placed = true;
    if (kindFails) why.add("other-kind");
    if (versionFails) why.add("other-version");
  }
  if (placed && !otherTitle) return { match: true, by: "title", evidence };
  if (placed) return no("title-absent");
  return no(REASON_ORDER.find((r) => why.has(r)) ?? "title-absent");
}
