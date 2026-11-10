/**
 * The Zotero mapping shared by the local data-folder import (zotero-local.ts, R72) and the Web API
 * import (zotero-web.ts, R78): item types, creators and their roles, the fields read into reference
 * metadata, dates, citation keys in Extra, and reader annotations (anchors in PDFs and EPUBs). Both
 * adapters read Zotero's own field names (the Web API's `data` uses the same names as zotero.sqlite).
 */
import type { Creator, SourceType } from "@ao/core";
import type { ScanAnnotation, ScanRect } from "./bulk/scan.js";
import { arxivOf, doiOf, isbnsOf, issnOf, tagList, text, type RecordFields } from "./refman.js";

const MAX_RECTS = 1000;
const MAX_INK_POINTS = 100_000;
const MAX_PAGE_INDEX = 100_000;
const MAX_COORD = 1e6;

/** Zotero item type → SourceType (Zotero 7's item types; anything else is "other"). */
export const ITEM_TYPES: Readonly<Record<string, SourceType>> = {
  journalArticle: "article-journal", magazineArticle: "article-journal", newspaperArticle: "article-journal",
  conferencePaper: "article-journal", book: "book", bookSection: "chapter", encyclopediaArticle: "chapter",
  dictionaryEntry: "chapter", thesis: "thesis", report: "report", standard: "report", webpage: "webpage", blogPost: "webpage",
  forumPost: "social-post", preprint: "preprint", manuscript: "manuscript", letter: "manuscript", presentation: "presentation",
  dataset: "dataset", interview: "interview", videoRecording: "video", film: "video", tvBroadcast: "video",
  audioRecording: "audio", podcast: "audio", radioBroadcast: "audio", artwork: "image", map: "image",
  document: "other", email: "other", instantMessage: "other", computerProgram: "other", case: "other", statute: "other",
  bill: "other", hearing: "other", patent: "other", attachment: "other",
};

/** Zotero creator type → role (each type's primary creator is the author; the rest contributors). */
export const CREATOR_ROLES: Readonly<Record<string, Creator["role"]>> = {
  author: "author", director: "author", podcaster: "author", presenter: "author", artist: "author", programmer: "author",
  performer: "author", inventor: "author", sponsor: "author", cartographer: "author",
  editor: "editor", seriesEditor: "editor", translator: "translator", interviewer: "interviewer", interviewee: "interviewee",
};

const CONTAINER_FIELDS = ["publicationTitle", "bookTitle", "proceedingsTitle", "websiteTitle", "blogTitle", "forumTitle", "encyclopediaTitle", "dictionaryTitle", "programTitle"];
const PUBLISHER_FIELDS = ["publisher", "university", "institution", "label", "company", "studio", "network", "distributor", "repository"];
const TITLE_FIELDS = ["title", "caseName", "nameOfAct", "subject"];

/** Zotero annotation types (itemAnnotations.type). */
export const ANNOTATION_KINDS: Readonly<Record<number, ScanAnnotation["kind"]>> = { 1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "note" };

/** Zotero's "YYYY-MM-DD HH:MM:SS" (UTC) → ISO 8601, or undefined. */
export function zoteroTimestamp(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/u.test(v)) return undefined;
  const d = new Date(`${v.slice(0, 10)}T${v.slice(11, 19)}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Zotero's multipart date ("2024-03-00 March 2024") → "2024-03"; one Zotero could not parse
 * ("0000-00-00 Spring 2020") → the text after the first space; a free-text date → its text.
 */
export function zoteroDate(v: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/u.exec(v);
  if (!m) return v || undefined;
  if (m[1] === "0000") return v.slice(11).trim() || undefined;
  if (m[2] === "00") return m[1];
  if (m[3] === "00") return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The "Citation Key: …" line of Extra (Better BibTeX's convention, also Zotero 7's), else a legacy "bibtex: …" line. */
export function extraCitationKey(extra: string): string | undefined {
  let legacy: string | undefined;
  for (const line of extra.split("\n")) {
    const t = line.trim();
    const lower = t.toLowerCase();
    const k = lower.startsWith("citation key:") ? text(t.slice(13)) : lower.startsWith("bibtex:") ? text(t.slice(7)) : "";
    if (!k || k.length > 200 || /\s/u.test(k)) continue;
    if (lower.startsWith("citation key:")) return k;
    legacy ??= k;
  }
  return legacy;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

function rectOf(r: unknown): ScanRect | undefined {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(finite)) return undefined;
  const [x1, y1, x2, y2] = r as number[];
  return { x: Math.min(x1!, x2!), y: Math.min(y1!, y2!), w: Math.abs(x2! - x1!), h: Math.abs(y2! - y1!) };
}

/** Bounding box of ink paths ([x1, y1, x2, y2, …] each), or undefined. */
function inkBox(paths: unknown): ScanRect | undefined {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_RECTS) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, points = 0;
  for (const p of paths) {
    if (!Array.isArray(p) || p.length < 2 || p.length % 2 !== 0) return undefined;
    points += p.length / 2;
    if (points > MAX_INK_POINTS) return undefined;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (!finite(x) || !finite(y)) return undefined;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The anchor a position JSON describes (PDF page + rectangles, or an EPUB CFI), or undefined. Never throws. */
function anchorOf(position: string | null | undefined): ScanAnnotation["anchor"] {
  if (!position || position.length >= 65536) return undefined; // read with substr(…, 65536): a full-length value was cut
  let p: unknown;
  try {
    p = JSON.parse(position);
  } catch {
    return undefined;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const o = p as Record<string, unknown>;
  if (o.type === "FragmentSelector" && typeof o.value === "string" && o.value.startsWith("epubcfi(") && o.value.length <= 4096) {
    return { kind: "epub-cfi", cfi: o.value };
  }
  const pi = o.pageIndex;
  if (typeof pi !== "number" || !Number.isInteger(pi) || pi < 0 || pi > MAX_PAGE_INDEX) return undefined;
  let rects: ScanRect[] = [];
  if (Array.isArray(o.rects)) {
    if (!o.rects.length || o.rects.length > MAX_RECTS) return undefined;
    for (const r of o.rects) {
      const rect = rectOf(r);
      if (!rect) return undefined;
      rects.push(rect);
    }
  } else {
    const box = inkBox(o.paths);
    if (!box) return undefined;
    rects = [box];
  }
  return { kind: "pdf", page: pi + 1, rects };
}

export interface ZoteroAnnotationRow {
  key: string;
  type: number;
  authorName?: string | null;
  text?: string | null;
  comment?: string | null;
  color?: string | null;
  pageLabel?: string | null;
  position?: string | null;
  dateAdded?: string | null;
}

/** One `itemAnnotations` row → ScanAnnotation anchored in `file` (undefined for an unknown type). */
export function zoteroAnnotation(row: ZoteroAnnotationRow, file: string | undefined): ScanAnnotation | undefined {
  const kind = ANNOTATION_KINDS[row.type];
  if (!kind) return undefined;
  const quote = text(row.text);
  const comment = text(row.comment);
  // A "text" annotation (type 6) is text the reader typed on the page: its body.
  const body = row.type === 6 ? quote || comment : comment;
  const color = text(row.color);
  const pageLabel = text(row.pageLabel).slice(0, 64);
  const author = text(row.authorName).slice(0, 200);
  const createdAt = zoteroTimestamp(row.dateAdded);
  const anchor = anchorOf(row.position);
  return {
    key: `zotero:${row.key}`,
    kind,
    ...(body ? { body } : {}),
    ...(quote && row.type !== 6 ? { quote } : {}),
    ...(/^#[0-9a-f]{3,8}$/iu.test(color) ? { color } : {}),
    ...(pageLabel ? { pageLabel } : {}),
    ...(author ? { author } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(anchor ? { anchor, ...(file ? { file } : {}) } : {}),
  };
}

/** The item's fields as RecordFields (+ the Extra text). */
export function recordFields(type: string, f: Map<string, string>, creators: Creator[], tags: string[]): { fields: RecordFields; extra: string } {
  const first = (names: string[]) => {
    for (const n of names) {
      const v = text(f.get(n));
      if (v) return v;
    }
    return "";
  };
  const extra = f.get("extra") ?? "";
  const out: RecordFields = { type: ITEM_TYPES[type] ?? "other" };
  const title = first(TITLE_FIELDS);
  if (title) out.title = title;
  if (creators.length) out.creators = creators;
  const date = zoteroDate(text(f.get("date")));
  if (date) out.issued = date;
  const container = first(CONTAINER_FIELDS);
  if (container) out.container = container;
  const publisher = first(PUBLISHER_FIELDS);
  if (publisher) out.publisher = publisher;
  let doi = doiOf(f.get("DOI"));
  if (!doi) {
    // Item types without a DOI field keep it in Extra ("DOI: 10…").
    const line = extra.split("\n").find((l) => /^\s*doi:/iu.test(l));
    if (line) doi = doiOf(line.slice(line.indexOf(":") + 1));
  }
  if (doi) out.doi = doi;
  const isbn = f.get("ISBN") ? isbnsOf([f.get("ISBN")!]) : [];
  if (isbn.length) out.isbn = isbn;
  const issn = issnOf(f.get("ISSN"));
  if (issn) out.issn = issn;
  const url = text(f.get("url"));
  if (url) out.url = url;
  const archive = text(f.get("archiveID"));
  if (archive.toLowerCase().startsWith("arxiv:")) {
    const a = arxivOf(archive.slice(6));
    if (a) out.arxiv = a;
  }
  const t = tagList(tags);
  if (t.length) out.tags = t;
  return { fields: out, extra };
}


/** A Zotero creator → Creator (role from CREATOR_ROLES): a single-field name is a literal; a name without a first name is a family name. */
export function zoteroCreator(first: unknown, last: unknown, singleField: boolean, type: unknown): Creator | undefined {
  const role = CREATOR_ROLES[String(type)] ?? "contributor";
  const l = text(typeof last === "string" ? last : "");
  const f = text(typeof first === "string" ? first : "");
  if (singleField || !f) {
    if (!l) return undefined;
    return singleField ? { literal: l, role } : { family: l, role };
  }
  return l ? { family: l, given: f, role } : { literal: f, role };
}
