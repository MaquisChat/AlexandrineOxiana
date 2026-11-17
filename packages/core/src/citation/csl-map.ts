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
 * Participants (spec 4.4, R88, R89): names are compared folded (ł ø đ ß æ œ þ ı transliterated,
 * NFKD, no combining marks, lowercase, words only, so "@Lucía.Cocina" = "lucia cocina" and
 * "Wałęsa" = "walesa"; a name written as one word, "marialopez", matches too). With the project's pseudonym map
 * (`pseudonyms`, handle or name → participant code), a creator matching it under any of their
 * name forms (handle, literal, "given family", "family given", family, given) becomes
 * `{ literal: <code> }`. Every map entry and every coded creator's name forms are replaced by the
 * code in the title, container, publisher and the other text fields (see scrubText for the rule on
 * short bare names; a name of two or more words also in reversed order and as "Family, Given"; a
 * name in a script written without spaces also inside the run it is joined to — the rule shared
 * with folder names, participant-names.ts, R378 a). A URL carrying any of them with any separator
 * (space, %20, +, -, ., _, none) in either order is left out, and
 * no citation key is copied when participants are involved. The participant's `details` are never
 * an input here. A source linked to participants with no pseudonym map is an error outright. A
 * source linked to participants (`participantIds`), or any source when
 * `requireParticipantCodes` is set, fails closed: a creator other than the interviewer without a
 * code is an error (ParticipantCodeMissingError), never a printed name.
 */
import type { Anchor } from "../model/anchor.js";
import type { BiblioField, Creator, SourceFile, SourceType } from "../model/source.js";
import type { MultiText } from "../model/text.js";
import { mapCode, mapKeys, nameForms, normName, scrubNames, urlNamesAny, type NameForm, type NameSet } from "../participant-names.js";

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
  number?: string;
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
  ["number", "number"],
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

// ------------------------------------------------------------------------------------------
// Participant names (R88 I1)

// The shared rule for recognising a participant's name (folding, words, no-space scripts): see
// participant-names.ts (R378 a). Folder names use the same rule (naming.ts pseudonymize).
export { normName };

/**
 * The names a creator is looked up by in the pseudonym map (handle, literal, "given family",
 * "family given", family, given). The forms replaced in text are `nameForms` (participant-names.ts).
 */
function creatorForms(c: Creator): Array<{ text: string; bare: boolean }> {
  const out: Array<{ text: string; bare: boolean }> = [];
  const add = (t: string | undefined, bare = false) => {
    if (t?.trim()) out.push({ text: t, bare });
  };
  add(c.handle);
  add(c.literal);
  if (c.given && c.family) {
    add(`${c.given} ${c.family}`);
    add(`${c.family} ${c.given}`);
  }
  add(c.family, true);
  add(c.given, true);
  return out;
}

/**
 * A creator's code: for each of its forms in turn, the map entry whose name is exactly that form by
 * the strict key, else the first whose folded name is (R416: "Ana Pena" is not "Ana Peña"'s code
 * when both are participants).
 */
function codeFor(c: Creator, map: ReadonlyMap<string, string>): string | undefined {
  for (const f of creatorForms(c)) {
    const hit = mapCode(map, f.text);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Replaces every participant name form in `text` by its code, by the shared rule
 * (participant-names.ts: folded case, accents and width; whole words, or inside a run of a script
 * written without spaces; longer forms first). A bare given or family name of fewer than 4 letters
 * is replaced only together with the other part of the name ("Li" alone is kept, "Rose Li" and
 * "Li, Rose" are not): replacing every short name everywhere would blank common words. In a script
 * written without spaces the floor is 2 characters, in Hangul 2 syllables (R387 c). Longer bare
 * names are always replaced, even where the word means something else ("Rose gardens"):
 * over-scrubbing a title is the fail-safe side (R88).
 */
function scrubText(text: string, names: NameSet): string {
  return scrubNames(text, names, { bareMinLength: 4 });
}

/**
 * Whether a URL carries any participant name form, by the shared rule (participant-names.ts): decoded
 * safely, any separator (space, %20, +, -, ., _, none), either word order, no length floor.
 */
function urlNamesParticipant(url: string, names: NameSet): boolean {
  return urlNamesAny(url, names);
}

/**
 * R420 a, corrected by R427 b: a creator who is not a participant, whose name holds a participant's
 * WHOLE name (a map entry, a name or a handle; a coded creator's handle, literal, "given family",
 * "family given") or a RUN of two or more words of one that is a form by R403 c ("Lucía Fernández"
 * of "Lucía Fernández Ruiz"; in a creator written as given and family names only a run that takes
 * words from both fields, R437 a): the text that cslName would print (the literal, else the handle; for a
 * given/family creator the joined "given family", else "family given"), with each such name replaced
 * by its code (by the shared rule, R416's choice included). Single names (a lone given or family
 * name, one word of a compound name) are not looked for: an author who shares a first name with a
 * participant is not rewritten (the stated limit FR-699). Undefined when nothing was replaced.
 */
function creatorWithWholeNames(c: Creator, whole: NameSet): string | undefined {
  const tryText = (t: string | undefined, runSpan?: (start: number, end: number) => boolean): string | undefined => {
    const v = t?.trim();
    if (!v) return undefined;
    const out = scrubNames(v, whole, runSpan ? { runSpan } : {});
    return out !== v ? out : undefined;
  };
  const given = c.given?.trim();
  const family = c.family?.trim();
  if (given || family) {
    // R437 a: in a creator written as given and family names, a run of a participant's name counts
    // only when its span takes words from BOTH fields ("Lucía Fernández"); one lying wholly inside
    // the given name ("Juan Carlos" of Juan Carlos Onetti) or the family name ("Fernández Ruiz" of
    // Pedro Fernández Ruiz) is another person's name. A creator of one field takes no run. A whole
    // name counts anywhere (R420 a).
    const across = (first: string) => (start: number, end: number) => start < first.length && end > first.length + 1;
    if (!given || !family) return tryText(given ?? family, () => false);
    return tryText(`${given} ${family}`, across(given)) ?? tryText(`${family} ${given}`, across(family));
  }
  return tryText(c.literal) ?? (c.literal?.trim() ? undefined : tryText(c.handle));
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

  // Creators, coded where the pseudonym map knows them (names compared folded, R88 I1).
  // The map's comparison keys and forms are built once per map (participant-names.ts, R387 M2).
  const map = opts.pseudonyms ?? new Map<string, string>();
  const keys = mapKeys(map);
  const forms: NameForm[] = [];
  // Sources linked to participants fail closed: every creator but the interviewer needs a code (R88 I2).
  const requireCodes = opts.requireParticipantCodes === true || s.participantIds.length > 0;
  // Participants but no pseudonym map to code them with: nothing about them can be cited safely (R89).
  if (s.participantIds.length > 0 && keys.size === 0) throw new ParticipantCodeMissingError();
  let anyCoded = false;
  // Every creator's code first, so that a creator who is not a participant can be read against the
  // whole names of every coded creator, wherever it stands in the list (R420 a).
  const codes = s.creators.map((c) => codeFor(c, map));
  for (const [i, c] of s.creators.entries()) {
    const code = codes[i];
    if (code) forms.push(...nameForms(c, code));
    else if (requireCodes && c.role !== "interviewer" && creatorForms(c).length > 0) throw new ParticipantCodeMissingError();
  }
  const whole: NameSet = { map, forms, noSingleNames: true };
  const lookForWhole = keys.size > 0 || forms.length > 0;
  for (const [i, c] of s.creators.entries()) {
    const code = codes[i];
    let name: CslName | undefined;
    if (code) {
      anyCoded = true;
      name = { literal: code };
    } else {
      name = cslName(c);
      const scrubbed = lookForWhole ? creatorWithWholeNames(c, whole) : undefined;
      if (scrubbed !== undefined) {
        anyCoded = true;
        name = { literal: scrubbed };
      }
    }
    if (!name) continue;
    const role = ROLE_MAP[c.role];
    (item[role] ??= []).push(name);
  }
  const names: NameSet = { map, forms };
  const scrub = (text: string) => (keys.size || forms.length ? scrubText(text, names) : text);

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
  if (url && !urlNamesParticipant(url, names)) item.URL = url;
  if (s.identifiers.doi) item.DOI = s.identifiers.doi;
  const isbn = s.identifiers.isbn?.[0];
  if (isbn) item.ISBN = isbn;
  if (s.identifiers.issn) item.ISSN = s.identifiers.issn;
  // A citation key is usually made from a creator's name: none when participants are involved.
  if (s.citationKey && !anyCoded && s.participantIds.length === 0) item["citation-key"] = s.citationKey;
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
