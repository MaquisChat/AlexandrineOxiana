/**
 * Source → CSL-JSON item (spec 8.1, Task 28, R86), and citation locators from anchors.
 *
 * Titles: `script: 'romanized'` uses the source's romanized title variant when there is one (else
 * the original). With `translatedTitles: 'append'`, when the original title's language differs
 * from the citation language and a translated variant in the citation language exists, the title
 * becomes "<original> [<translated>]" (ADR 0012). Languages are compared by their primary subtag
 * (`en-GB` matches `en`). The item's `language` is the original's, so citeproc-js leaves the case
 * of non-English titles alone.
 *
 * Bibliographic detail (R87): volume, issue, page, edition, number-of-pages, publisher-place,
 * collection-title and collection-number are copied from the source; its `genre` and `medium`
 * override the type map's. Platforms follow the styles' CSL convention: a video's platform is its
 * `publisher` (APA "[Video]. YouTube."), a social post's its `container-title`, and a social post
 * that is a video (a reel, a TikTok) gets genre "Video" unless the source overrides it.
 *
 * Participants (spec 4.4): with the project's pseudonym map (`pseudonyms`, handle or name →
 * participant code), any creator matching it under any of their name forms (handle with or without
 * "@", literal, family, given, "given family", "family, given") becomes `{ literal: <code> }`, and
 * those name forms in the title and container are replaced by the code too (core `pseudonymize`).
 * A URL containing one of them is left out (it would name the participant). The participant's
 * `details` are never an input here. `requireParticipantCodes` (projects that pseudonymize names)
 * makes an uncoded creator other than the interviewer an error instead (fail closed).
 */
import type { Anchor } from "../model/anchor.js";
import type { BiblioField, Creator, SourceFile, SourceType } from "../model/source.js";
import type { MultiText } from "../model/text.js";
import { pseudonymize } from "../naming.js";

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}
export interface CslDate {
  "date-parts": number[][];
}

/** The CSL-JSON fields this mapping produces. */
export interface CslItem {
  id: string;
  type: string;
  title?: string;
  "container-title"?: string;
  author?: CslName[];
  editor?: CslName[];
  translator?: CslName[];
  interviewer?: CslName[];
  contributor?: CslName[];
  publisher?: string;
  "publisher-place"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  edition?: string;
  "number-of-pages"?: string;
  "collection-title"?: string;
  "collection-number"?: string;
  issued?: CslDate;
  accessed?: CslDate;
  URL?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  genre?: string;
  medium?: string;
  language?: string;
  "citation-key"?: string;
}

export interface ToCslOptions {
  /** BCP-47 language the citation is written in, e.g. 'en'. */
  citationLanguage: string;
  translatedTitles: "append" | "off";
  script: "original" | "romanized";
  /** The project's pseudonym map: handle or name → participant code. */
  pseudonyms?: ReadonlyMap<string, string>;
  /** Every creator except the interviewer must have a participant code (pseudonymizing projects). */
  requireParticipantCodes?: boolean;
}

export class ParticipantCodeMissingError extends Error {
  constructor() {
    super("A creator of this source has no participant code, so it cannot be cited in this project");
    this.name = "ParticipantCodeMissingError";
  }
}

const TYPE_MAP: Readonly<Record<SourceType, { type: string; genre?: string; medium?: string }>> = {
  book: { type: "book" },
  chapter: { type: "chapter" },
  "article-journal": { type: "article-journal" },
  preprint: { type: "article", genre: "Preprint" },
  report: { type: "report" },
  thesis: { type: "thesis" },
  webpage: { type: "webpage" },
  "social-post": { type: "post" },
  video: { type: "motion_picture", medium: "Video" },
  audio: { type: "song", medium: "Audio" },
  image: { type: "graphic" },
  dataset: { type: "dataset" },
  "field-photo": { type: "graphic", genre: "Field photograph" },
  "field-video": { type: "motion_picture", genre: "Field video" },
  "field-recording": { type: "document", genre: "Field recording" }, // interview when it has an interviewee
  interview: { type: "interview" },
  manuscript: { type: "manuscript" },
  presentation: { type: "speech" },
  other: { type: "document" },
};

/** Source bibliographic field → CSL variable (genre and medium are overrides, handled apart). */
const BIBLIO_CSL: ReadonlyArray<[BiblioField, keyof CslItem]> = [
  ["volume", "volume"],
  ["issue", "issue"],
  ["page", "page"],
  ["edition", "edition"],
  ["numberOfPages", "number-of-pages"],
  ["publisherPlace", "publisher-place"],
  ["collectionTitle", "collection-title"],
  ["collectionNumber", "collection-number"],
];

const PLATFORM_NAMES: Readonly<Record<string, string>> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

type Role = "author" | "editor" | "translator" | "interviewer" | "contributor";
const ROLE_MAP: Readonly<Record<Creator["role"], Role>> = {
  author: "author",
  editor: "editor",
  translator: "translator",
  uploader: "author",
  channel: "author",
  photographer: "author",
  interviewee: "author",
  interviewer: "interviewer",
  contributor: "contributor",
};

const lang1 = (tag: string) => tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";

/** Every form under which a creator's name may appear. */
function nameForms(c: Creator): string[] {
  const bare = c.handle?.replace(/^@+/, "");
  const full = [c.given, c.family].filter(Boolean).join(" ");
  const inverted = c.family && c.given ? `${c.family}, ${c.given}` : undefined;
  return [c.handle, bare, c.literal, c.family, c.given, full, inverted]
    .map((s) => s?.normalize("NFC").trim())
    .filter((s): s is string => !!s);
}

function codeFor(c: Creator, map: ReadonlyMap<string, string> | undefined): string | undefined {
  if (!map || map.size === 0) return undefined;
  const lower = new Map<string, string>();
  for (const [k, v] of map) lower.set(k.normalize("NFC").trim().toLowerCase(), v);
  for (const f of nameForms(c)) {
    const hit = lower.get(f.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

function cslName(c: Creator): CslName | undefined {
  if (c.family?.trim() || c.given?.trim()) {
    const n: CslName = {};
    if (c.family?.trim()) n.family = c.family.trim();
    if (c.given?.trim()) n.given = c.given.trim();
    return n;
  }
  if (c.literal?.trim()) return { literal: c.literal.trim() };
  if (c.handle?.trim()) return { literal: c.handle.trim() };
  return undefined;
}

function pickTitle(t: MultiText | undefined, opts: ToCslOptions, appendTranslation: boolean): { value?: string; lang?: string } {
  if (!t || t.variants.length === 0) return {};
  const original = t.variants.find((v) => v.kind === "original") ?? t.variants.find((v) => v.kind !== "translated") ?? t.variants[0]!;
  const romanized = opts.script === "romanized" ? t.variants.find((v) => v.kind === "romanized" && v.value.trim()) : undefined;
  const shown = romanized ?? original;
  let value = shown.value;
  const want = lang1(opts.citationLanguage);
  const origLang = lang1(original.lang);
  if (appendTranslation && opts.translatedTitles === "append" && origLang !== want && origLang !== "und") {
    const tr = t.variants.find((v) => v.kind === "translated" && lang1(v.lang) === want && v.value.trim());
    if (tr) value = `${value} [${tr.value.trim()}]`;
  }
  return { value, ...(origLang && origLang !== "und" ? { lang: origLang } : {}) };
}

/** EDTF-lite (YYYY, YYYY-MM, YYYY-MM-DD) or an ISO timestamp (its UTC date) → CSL date-parts. */
function dateParts(s: string | undefined, timestamp = false): CslDate | undefined {
  if (!s) return undefined;
  if (timestamp) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return undefined;
    return { "date-parts": [[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]] };
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (!m) return undefined;
  return { "date-parts": [[m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number)] };
}

/**
 * A social post that is a video: its original media is a video (an Instagram reel), or its platform
 * only carries videos (TikTok), or its URL is a reel's.
 */
function isVideoPost(sf: SourceFile): boolean {
  const s = sf.source;
  if (sf.assets.some((a) => a.role === "original" && (a.kind === "video" || a.mime.toLowerCase().startsWith("video/")))) return true;
  if (s.identifiers.platform === "tiktok") return true;
  const url = s.identifiers.url ?? "";
  return /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/?#]+\/)?reels?\//iu.test(url);
}

export function toCslItem(sf: SourceFile, opts: ToCslOptions): CslItem {
  const s = sf.source;
  const mapped = TYPE_MAP[s.type] ?? TYPE_MAP.other;
  let type = mapped.type;
  if (s.type === "field-recording" && s.creators.some((c) => c.role === "interviewee")) type = "interview";

  const item: CslItem = { id: s.id, type };
  if (mapped.genre) item.genre = mapped.genre;
  if (mapped.medium) item.medium = mapped.medium;

  // Creators, coded where the pseudonym map knows them.
  const coded = new Map<string, string>(); // name form → code, for titles and URLs
  for (const c of s.creators) {
    const code = codeFor(c, opts.pseudonyms);
    let name: CslName | undefined;
    if (code) {
      name = { literal: code };
      for (const f of nameForms(c)) if (!coded.has(f)) coded.set(f, code);
    } else {
      if (opts.requireParticipantCodes && c.role !== "interviewer" && nameForms(c).length > 0) throw new ParticipantCodeMissingError();
      name = cslName(c);
    }
    if (!name) continue;
    const role = ROLE_MAP[c.role];
    (item[role] ??= []).push(name);
  }
  const scrub = (text: string) => (coded.size ? pseudonymize(text, coded) : text);

  const title = pickTitle(s.title, opts, true);
  if (title.value) item.title = scrub(title.value);
  if (title.lang) item.language = title.lang;

  // Platforms (R87, the CSL convention the styles expect): a video's platform is its publisher
  // (APA: "[Video]. YouTube."); a social post's is its container (MLA/APA: "Instagram").
  const platform = s.identifiers.platform;
  const platformName = platform ? PLATFORM_NAMES[platform] : undefined;
  if (s.type === "social-post" && platformName) {
    item["container-title"] = platformName;
  } else {
    const container = pickTitle(s.container, opts, false);
    if (container.value) item["container-title"] = scrub(container.value);
  }
  if (s.type === "video" && platformName) item.publisher = platformName;
  else if (s.publisher) item.publisher = scrub(s.publisher);
  for (const [field, csl] of BIBLIO_CSL) {
    const v = s[field]?.trim();
    if (v) (item as unknown as Record<string, string>)[csl] = scrub(v);
  }
  if (s.type === "social-post" && !mapped.genre && isVideoPost(sf)) item.genre = "Video";
  if (s.genre?.trim()) item.genre = scrub(s.genre.trim());
  if (s.medium?.trim()) item.medium = scrub(s.medium.trim());

  const issued = dateParts(s.issued);
  if (issued) item.issued = issued;
  const accessed = dateParts(s.accessed, true);
  if (accessed) item.accessed = accessed;

  const url = s.identifiers.url;
  if (url) {
    const lowerUrl = url.toLowerCase();
    const namesParticipant = [...coded.keys()].some((f) => f.length >= 3 && lowerUrl.includes(f.toLowerCase()));
    if (!namesParticipant) item.URL = url;
  }
  if (s.identifiers.doi) item.DOI = s.identifiers.doi;
  const isbn = s.identifiers.isbn?.[0];
  if (isbn) item.ISBN = isbn;
  if (s.identifiers.issn) item.ISSN = s.identifiers.issn;
  if (s.citationKey) item["citation-key"] = s.citationKey;
  return item;
}

// ------------------------------------------------------------------------------------------
// Locators

export type LocatorLabel = "page" | "chapter" | "section" | "paragraph" | "figure" | "timestamp";

function clock(totalSeconds: number, withHours: boolean): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const ss = String(sec).padStart(2, "0");
  return withHours ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * The citation locator an anchor gives: a pdf anchor its (1-based) page; a time range
 * `m:ss–m:ss` (`h:mm:ss–h:mm:ss` when it reaches an hour), labelled `timestamp`. Undefined for
 * other anchors and for invalid values (negative, NaN, infinite, end before start).
 */
export function locatorFromAnchor(a: Anchor): { locator: string; label: LocatorLabel } | undefined {
  if (a.kind === "pdf") {
    return Number.isInteger(a.page) && a.page >= 1 ? { locator: String(a.page), label: "page" } : undefined;
  }
  if (a.kind === "time-range") {
    const { startMs, endMs } = a;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) return undefined;
    const start = Math.floor(startMs / 1000);
    const end = Math.floor(endMs / 1000);
    const hours = end >= 3600;
    if (start === end) return { locator: clock(start, hours), label: "timestamp" };
    return { locator: `${clock(start, hours)}–${clock(end, hours)}`, label: "timestamp" };
  }
  return undefined;
}
