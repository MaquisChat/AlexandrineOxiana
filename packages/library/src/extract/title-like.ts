/**
 * R394 (a, b): a file's embedded title is evidence only when it looks like a title, and an embedded author only when
 * it is not a program's or a computer's stock name. Every extractor that reads an embedded title or author (PDF Info
 * and XMP, DOCX core properties, EPUB OPF, MOBI EXTH and PalmDB name, HTML meta and <title>) passes it through here;
 * what fails is dropped at extraction, so it is not the item's title, not evidence and not a conflict.
 *
 * The stock texts are mostly English, with "untitled" in a few other languages (R410 c: "Sans titre", "Unbenannt",
 * "無題"); other languages' stock texts ("Документ") are not covered.
 */
import type { Creator } from "@ao/core";

/** Scripts written without spaces: a word of two characters counts (as in core's title similarity). */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Texts programs leave in the title field, matched as the whole title (lower case), alone or followed by a number
 * ("Untitled 3", "Document1", "Slide 1").
 */
export const STOCK_TITLES: readonly string[] = [
  "untitled",
  "untitled document",
  "document",
  "new document",
  "presentation",
  "powerpoint presentation",
  "slide",
  "title",
  "layout",
  "blank",
  "scan",
  "scanned document",
  "print",
  "full text",
  "front matter",
  "back matter",
  "cover",
  "table of contents",
  "index",
  // R410 c: section and template words, sites and services, and "untitled" in other languages. Not "book review",
  // "erratum", "corrigendum", "contents", "supplementary material", "appendix": true signs of a wrong file.
  "original article",
  "research article",
  "review article",
  "article",
  "manuscript",
  "author manuscript",
  "accepted manuscript",
  "abstract",
  "introduction",
  "chapter",
  "page",
  "template",
  "paper title",
  "paper title (use style: paper title)",
  "insert title here",
  "your title here",
  "title of the paper",
  "document title",
  "proof",
  "preview",
  "word",
  "blank page",
  "front cover",
  "cover page",
  "title page",
  "frontmatter",
  "no title",
  "unknown",
  "unknown title",
  "ebook",
  "calibre",
  "jstor",
  "ieee xplore",
  "sciencedirect",
  "springerlink",
  "proquest",
  "acs paragon plus environment",
  "sans titre",
  "sin título",
  "senza titolo",
  "unbenannt",
  "ohne titel",
  "titel",
  "sem título",
  "без названия",
  "無題",
  "无标题",
  "제목 없음",
];
/** Accents folded (Hangul and other composed letters recomposed), so "Sin titulo" is "Sin título". */
const bare = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFC");
/**
 * Titles programs write as a prefix followed by the file's own name ("Microsoft Word - draft3", also in parentheses),
 * and the prefixes of a running head or a download notice (R410 c).
 */
const STOCK_PREFIX = /^(?:\(?microsoft word - |microsoft powerpoint - |adobe photoshop\b|running head:|downloaded from\s)/iu;
const STOCK_TITLE = new RegExp(
  `^(?:${STOCK_TITLES.map((s) => bare(s).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s")).join("|")})(?:\\s*[-_#]?\\s*\\d+)?$`,
  "iu",
);
/** A web address alone ("www.…", "http(s)://…", no space), or an e-mail address alone (R410 c). */
const WEB_OR_MAIL = /^(?:(?:www\.|https?:\/\/)\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/iu;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** A date alone: "15 January 2020", "January 2020", "Jan. 15, 2020", "2020-01-15", "01/15/2020" (R410 c). */
const DATE_ONLY = new RegExp(`^(?:(?:\\d{1,2}\\s+)?${MONTH}(?:\\s+\\d{1,2},?)?\\s+\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4})$`, "iu");

/** Extensions of files whose names end up in title fields. */
const FILE_EXTENSION =
  /\.(?:pdf|docx?|dotx?|odt|ott|rtf|txt|md|tex|dvi|ps|eps|indd|indt|qxd|qxp|pages|key|numbers|pptx?|xlsx?|odp|ods|epub|mobi|azw3?|html?|xhtml|xml|jpe?g|png|gif|tiff?|bmp|heic|psd|ai|svg|mp3|m4a|wav|aiff?|flac|ogg|mp4|m4v|mov|avi|mkv|webm|zip)$/iu;

/** A path: a backslash, a leading slash, "~/", "./", "../" or a drive letter, or two or more slashes and no space. */
const looksLikePath = (s: string) => s.includes("\\") || /^(?:\/|~\/|\.\.?\/|[a-z]:[\\/])/iu.test(s) || (!/\s/u.test(s) && (s.match(/\//gu)?.length ?? 0) >= 2);

const DOI = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/iu;
const ARXIV = /^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)$/iu;
const ISSN = /^(?:e?-?issn:?\s*)?\d{4}-?\d{3}[\dx]$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEX_RUN = /^[0-9a-f]{16,}$/iu;
/** A publisher's item code (a PII such as "S0003598X20000800"): a letter, then fifteen or more letters and digits, some digits. */
const ITEM_CODE = /^[a-z](?=[a-z0-9]*\d)[a-z0-9]{15,}$/iu;
/** Twelve or more Latin letters and digits mixed (with dots, dashes or underscores), no space. */
const MIXED_RUN = /^(?=[^\s]*\d)(?=[^\s]*[a-z])[a-z0-9._-]{12,}$/iu;

function isIsbn(s: string): boolean {
  const bare = s.replace(/^isbn(?:-1[03])?:?\s*/iu, "").replace(/[\s-]/gu, "");
  return /^(?:\d{9}[\dx]|\d{13})$/iu.test(bare) && /^(?:isbn|[\d])/iu.test(s);
}

function isIdentifier(s: string): boolean {
  return DOI.test(s) || isIsbn(s) || ISSN.test(s) || ARXIV.test(s) || ITEM_CODE.test(s) || UUID.test(s) || HEX_RUN.test(s) || MIXED_RUN.test(s);
}

/** A word made only of letters: three or more, or two or more in a script written without spaces. */
function hasWord(s: string): boolean {
  for (const token of s.split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!token || !/^[\p{L}\p{M}]+$/u.test(token)) continue;
    const n = Array.from(token.replace(/\p{M}+/gu, "")).length;
    if (n >= 3 || (n >= 2 && NO_SPACE_SCRIPT.test(token))) return true;
  }
  return false;
}

/** More than half of the characters other than spaces are digits, punctuation or symbols. */
function mostlyDigitsAndPunctuation(s: string): boolean {
  const chars = Array.from(s.replace(/\s+/gu, ""));
  const other = chars.filter((c) => /[\p{N}\p{P}\p{S}]/u.test(c)).length;
  return other * 2 > chars.length;
}

const fold = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Only this many characters are examined (a hostile file's 2 MB "title" costs no more than a long real one). */
const EXAMINED_CHARS = 1000;
/** Identifiers are short: a longer text is never only an identifier. */
const MAX_IDENTIFIER_CHARS = 200;

/**
 * Whether an embedded title looks like a title (R394 a). `fileName`: the file's own name, compared (without its
 * extension and without regard to case) with the title. A title of digits only ("1984") is dropped too: as an
 * embedded title it cannot be told from a code, and the reference manager or the file name will name such a work.
 */
export function looksLikeTitle(raw: string, fileName?: string): boolean {
  const s = fold(raw.slice(0, EXAMINED_CHARS * 4));
  if (!s) return false;
  const head = s.slice(0, EXAMINED_CHARS);
  if (!hasWord(head)) return false;
  if (s.length <= MAX_IDENTIFIER_CHARS && isIdentifier(s)) return false;
  if (FILE_EXTENSION.test(s.slice(-12)) || looksLikePath(head)) return false;
  if (fileName) {
    const base = fileName.replace(/^.*[\\/]/u, "");
    const stem = fold(base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base);
    if (stem && stem.toLowerCase() === s.toLowerCase()) return false;
  }
  if (STOCK_TITLE.test(bare(s)) || STOCK_PREFIX.test(s) || WEB_OR_MAIL.test(s) || DATE_ONLY.test(s)) return false;
  if (mostlyDigitsAndPunctuation(head)) return false;
  return true;
}

/** The embedded title when it looks like a title, else undefined (R394 a). */
export function embeddedTitle(raw: string | undefined, fileName?: string): string | undefined {
  return raw && looksLikeTitle(raw, fileName) ? fold(raw) : undefined;
}

/**
 * Names programs and computers put in the author field (R394 b), compared as the whole name without regard to case:
 * a real person's name is never one of these exact words.
 */
export const STOCK_AUTHORS: readonly string[] = [
  "administrator",
  "admin",
  "user",
  "owner",
  "author",
  "unknown",
  "anonymous",
  "default",
  "guest",
  "windows user",
  "microsoft office user",
  "microsoft word",
  "microsoft office",
  "adobe indesign",
  "adobe acrobat",
  "adobe photoshop",
  "acrobat pdfmaker",
  "camscanner",
  "scanner",
  "tex",
  "latex",
  "pdftex",
  "pdflatex",
  "xetex",
  "luatex",
  "latex with hyperref",
  "latex with hyperref package",
  "quarkxpress",
  "libreoffice",
  "openoffice",
];
const STOCK_AUTHOR_SET = new Set(STOCK_AUTHORS);
/** A single word ending in "PC" or "Laptop": a computer's name ("DELL-PC", "JohnsLaptop"). */
const MACHINE_NAME = /^\S*(?:PC|-pc|_pc|laptop)$/u;

export function isStockAuthor(raw: string): boolean {
  const s = fold(raw);
  if (!s) return true;
  return STOCK_AUTHOR_SET.has(s.toLowerCase()) || (!/\s/u.test(s) && (MACHINE_NAME.test(s) || /laptop$/iu.test(s)));
}

/** The creators without the stock names (R394 b); a parsed name is checked as written ("Given Family") and as a literal. */
export function keepCreators(cs: Creator[]): Creator[] {
  return cs.filter((c) => {
    const names = [c.literal, [c.given, c.family].filter(Boolean).join(" ")].filter((n): n is string => !!n);
    return !names.some((n) => isStockAuthor(n));
  });
}
