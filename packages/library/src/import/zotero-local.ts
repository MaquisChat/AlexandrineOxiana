/**
 * Zotero local data folder for Bulk Import (spec 5.1, 5.4 "Zotero specifics"; Task 25, R72).
 * Provenance `zotero_import`; legal-basis category 'zotero-import'.
 *
 * Reading: `zotero.sqlite` (with its -wal/-shm) and, when present, Better BibTeX's
 * `better-bibtex.sqlite` are copied into a private (0700) folder inside the batch's work folder
 * (≤ 4 GB in all; sqlite-copy.ts explains why a copy taken while Zotero runs is consistent),
 * opened read-only with `query_only` and `trusted_schema=OFF`, and deleted when the scan ends. Every
 * table read must be a plain table without generated columns; rows are read with iterate() under
 * caps (items without annotations ≤ 500,000; annotations ≤ 2,000,000; other link tables ≤
 * 2,000,000); text with substr(…, 1, 65536), notes with substr(…, 1, 1 MB). The user's Zotero files
 * are never opened by SQLite and never change.
 *
 * Items: the chosen library's regular items (default: the user library, 1) and standalone file
 * attachments; items in the trash (`deletedItems`), and attachments, notes and annotations whose
 * parent is in the trash, are skipped. Not imported, and counted (never named) in one scan note:
 * standalone notes, attachments' own notes, linked URLs, images embedded in notes, and linked files
 * relative to Zotero's base folder when `baseAttachmentPath` is not given.
 * `ScanItem.key` = "zotero:" + item key (stored only as the R63 HMAC); `externalKeys` keep
 * zoteroKey, zoteroVersion, libraryId, related item keys (`related`, comma-separated, for linking
 * later), zoteroDateAdded and zoteroDateModified, and the citation key (`citekey`) when Zotero had one.
 *
 *   - item types → SourceType with ITEM_TYPES; creators with their roles (CREATOR_ROLES);
 *   - the collection hierarchy → folderPath (the item's first collection; others in moreFolderPaths);
 *     collections in the trash are left out;
 *   - tags → tags, with their colours from `syncedSettings` 'tagColors' (where Zotero 7 keeps them);
 *   - child notes (HTML) → Markdown (note-html.ts) → Annotation{kind:'note'};
 *   - stored attachments → files at `storage/<attachment key>/<name>` (the adapter's root, R67);
 *     linked attachments → files marked `link` (linked in place unless the options or the project
 *     say copy, R24), absolute or relative to `baseAttachmentPath` ("attachments:…"); a linked file
 *     outside the storage folder needs the user's approval (R67, the dry run lists it); linked URLs
 *     and embedded images are not files and are skipped;
 *   - reader annotations (highlight, underline, note, image, ink, text) → annotations anchored in
 *     their PDF (page = position.pageIndex + 1, rectangles) or EPUB (CFI) — zoteroAnnotation();
 *   - citation key: Better BibTeX's database, then a "Citation Key:" line in Extra, else none (the
 *     library generates family + year + first title word, unique within the project).
 *
 * Incremental: each item's `version` token combines Zotero's item version with the modification
 * times of the item and everything under it (Zotero only raises `version` when it syncs, so a
 * library that never syncs keeps version 0); the engine skips unchanged items and updates changed
 * ones (run.ts).
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { Creator, SourceType } from "@ao/core";
import type { ImportSourceAdapter, ScanAnnotation, ScanContext, ScanFile, ScanItem, ScanRect } from "./bulk/scan.js";
import { MAX_NOTE_CHARS, noteToMarkdown } from "./note-html.js";
import { arxivOf, checkFiles, doiOf, isbnsOf, issnOf, referenceMetadata, tagList, text, type RecordFields } from "./refman.js";
import { CopyTooLarge, CopyUnstable, cappedRows, columnsOf, copyDatabases, openCopy, plainTables, t64, tN } from "./sqlite-copy.js";

export const ZOTERO_REASONS = {
  unreadable: "The Zotero library could not be read (its zotero.sqlite is missing or damaged), so nothing was imported from it.",
  tooLarge: "The Zotero library is too large to import (its databases are over 4 GB, or it holds too many items or annotations), so nothing was imported from it.",
  busy: "Zotero kept changing its database while it was being read. Try again in a moment, or close Zotero first.",
} as const;

export const ZOTERO_FILE_NOTES = {
  location: "attached file location is not valid",
} as const;

/** Kinds of Zotero items this import leaves out, counted (never named) in one scan note (R73). */
export interface NotImported {
  standaloneNotes: number;
  attachmentNotes: number;
  linkedUrls: number;
  embeddedImages: number;
  baseRelative: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ZOTERO_NOTES = {
  bbt: "Better BibTeX citation keys could not be read, so citation keys come from Extra or are generated.",
  notImported: (c: NotImported): string | undefined => {
    const parts = [
      c.standaloneNotes && plural(c.standaloneNotes, "standalone note", "standalone notes"),
      c.attachmentNotes && plural(c.attachmentNotes, "attachment note", "attachment notes"),
      c.linkedUrls && plural(c.linkedUrls, "linked URL", "linked URLs"),
      c.embeddedImages && plural(c.embeddedImages, "image embedded in a note", "images embedded in notes"),
      c.baseRelative && plural(c.baseRelative, "linked file relative to Zotero's base folder (not given)", "linked files relative to Zotero's base folder (not given)"),
    ].filter(Boolean);
    return parts.length ? `Not imported from Zotero: ${parts.join(", ")}.` : undefined;
  },
} as const;

/** Largest total size of the copied databases (R72). */
export const MAX_ZOTERO_COPY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ITEMS = 500_000;
const MAX_ANNOTATIONS = 2_000_000;
const MAX_LINK_ROWS = 2_000_000;
const MAX_FIELDS = 500;
const MAX_CREATORS = 1000;
const MAX_TAGS = 1000;
const MAX_RELATED = 100;
const MAX_COLLECTION_DEPTH = 64;
const MAX_FOLDER_PATHS = 20;
const MAX_RECTS = 1000;
const MAX_INK_POINTS = 100_000;
const MAX_PAGE_INDEX = 100_000;
const MAX_COORD = 1e6;

const REQUIRED_TABLES = [
  "libraries", "items", "itemTypes", "fields", "itemData", "itemDataValues", "creators", "itemCreators", "creatorTypes",
  "collections", "collectionItems", "tags", "itemTags", "itemNotes", "itemAttachments", "itemAnnotations", "deletedItems",
  "itemRelations", "relationPredicates",
];
const OPTIONAL_TABLES = ["syncedSettings", "deletedCollections"];

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
const CREATOR_ROLES: Readonly<Record<string, Creator["role"]>> = {
  author: "author", director: "author", podcaster: "author", presenter: "author", artist: "author", programmer: "author",
  performer: "author", inventor: "author", sponsor: "author", cartographer: "author",
  editor: "editor", seriesEditor: "editor", translator: "translator", interviewer: "interviewer", interviewee: "interviewee",
};

const CONTAINER_FIELDS = ["publicationTitle", "bookTitle", "proceedingsTitle", "websiteTitle", "blogTitle", "forumTitle", "encyclopediaTitle", "dictionaryTitle", "programTitle"];
const PUBLISHER_FIELDS = ["publisher", "university", "institution", "label", "company", "studio", "network", "distributor", "repository"];
const TITLE_FIELDS = ["title", "caseName", "nameOfAct", "subject"];

/** Zotero annotation types (itemAnnotations.type). */
const ANNOTATION_KINDS: Readonly<Record<number, ScanAnnotation["kind"]>> = { 1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "note" };

class ZoteroUnreadable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Zotero's "YYYY-MM-DD HH:MM:SS" (UTC) → ISO 8601, or undefined. */
export function zoteroTimestamp(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/u.test(v)) return undefined;
  const d = new Date(`${v.slice(0, 10)}T${v.slice(11, 19)}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Zotero's multipart date ("2024-03-00 March 2024") → "2024-03"; a free-text date → its text. */
function zoteroDate(v: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/u.exec(v);
  if (!m) return v || undefined;
  if (m[1] === "0000") return undefined;
  if (m[2] === "00") return m[1];
  if (m[3] === "00") return `${m[1]}-${m[2]}`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The "Citation Key: …" line of Extra (Better BibTeX's convention, also Zotero 7's). */
function extraCitationKey(extra: string): string | undefined {
  for (const line of extra.split("\n")) {
    const t = line.trim();
    if (t.toLowerCase().startsWith("citation key:")) {
      const k = text(t.slice(13));
      if (k && k.length <= 200 && !/\s/u.test(k)) return k;
    }
  }
  return undefined;
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

interface ItemRow {
  id: number;
  type: string;
  key: string;
  version: number;
  added: string | null;
  modified: string | null;
  clientModified: string | null;
}

interface AttachmentRow {
  id: number;
  parent: number | null;
  linkMode: number | null;
  path: string | null;
}

interface AnnotationRef {
  id: number;
  key: string;
  added: string | null;
  modified: string | null;
}

const KEY = /^[A-Za-z0-9]{1,32}$/u;

/** A stored attachment's file name ("storage:<name>") that stays inside its folder. */
function storedName(path: string | null): string | undefined {
  if (!path?.startsWith("storage:")) return undefined;
  const name = path.slice(8);
  if (!name || name.length > 1024 || name === "." || name === ".." || /[\\/\u0000]/u.test(name)) return undefined;
  return name;
}

export interface ZoteroLocalOptions {
  /** The library to import (default: 1, the user's own library). */
  libraryId?: number;
  /** Zotero's "Linked Attachment Base Directory" (Settings → Files and Folders), for "attachments:" paths. */
  baseAttachmentPath?: string;
  /** Test seam: the size cap of the copied databases (default 4 GB). */
  maxCopyBytes?: number;
}

/** Everything read up front from the copy (small per item; texts are read per item later). */
interface Snapshot {
  items: ItemRow[];
  byId: Map<number, ItemRow>;
  deleted: Set<number>;
  attachments: Map<number, AttachmentRow>;
  childAttachments: Map<number, AttachmentRow[]>;
  childNotes: Map<number, number[]>;
  /** Notes that belong to an item (the others are standalone notes). */
  childNoteIds: Set<number>;
  /** Attachments whose own note field is not empty. */
  attachmentNotes: Set<number>;
  notes: Set<number>;
  annotations: Map<number, AnnotationRef[]>;
  annotationIds: Set<number>;
  collectionPaths: Map<number, string[][]>;
  tagColors: Map<string, string>;
  bbt: Map<string, string>;
}

function readSnapshot(db: Database.Database, libraryId: number, bbtDb: Database.Database | undefined, note: (t: string) => void): Snapshot {
  const tables = plainTables(db, [...REQUIRED_TABLES, ...OPTIONAL_TABLES]);
  for (const t of REQUIRED_TABLES) if (!tables.has(t)) throw new ZoteroUnreadable(ZOTERO_REASONS.unreadable);
  const tooLarge = () => new ZoteroUnreadable(ZOTERO_REASONS.tooLarge);
  const lib = (db.prepare("SELECT libraryID FROM libraries WHERE libraryID = ?").get(libraryId) as { libraryID: number } | undefined)?.libraryID;
  if (lib === undefined) throw new ZoteroUnreadable(ZOTERO_REASONS.unreadable);

  const annotationRows = cappedRows<{ id: number; parent: number; key: string; added: string | null; modified: string | null }>(
    db,
    `SELECT a.itemID AS id, a.parentItemID AS parent, ${t64("i.key", "key")}, ${t64("i.dateAdded", "added")}, ${t64("i.clientDateModified", "modified")}
       FROM itemAnnotations a JOIN items i ON i.itemID = a.itemID WHERE i.libraryID = ? ORDER BY a.parentItemID, a.itemID`,
    MAX_ANNOTATIONS,
    tooLarge,
    libraryId,
  );
  const annotationIds = new Set(annotationRows.map((r) => r.id));
  const items = cappedRows<ItemRow>(
    db,
    `SELECT i.itemID AS id, ${t64("t.typeName", "type")}, ${t64("i.key", "key")}, i.version AS version, ${t64("i.dateAdded", "added")},
            ${t64("i.dateModified", "modified")}, ${t64("i.clientDateModified", "clientModified")}
       FROM items i JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
      WHERE i.libraryID = ? AND i.itemID NOT IN (SELECT itemID FROM itemAnnotations) ORDER BY i.itemID`,
    MAX_ITEMS,
    tooLarge,
    libraryId,
  ).filter((r) => typeof r.key === "string" && KEY.test(r.key));
  const byId = new Map(items.map((r) => [r.id, r]));
  const deleted = new Set(cappedRows<{ id: number }>(db, "SELECT itemID AS id FROM deletedItems", MAX_LINK_ROWS, tooLarge).map((r) => r.id));

  const attachments = new Map<number, AttachmentRow>();
  const childAttachments = new Map<number, AttachmentRow[]>();
  for (const a of cappedRows<AttachmentRow>(db, `SELECT itemID AS id, parentItemID AS parent, linkMode, ${tN("path", "path", 8192)} FROM itemAttachments ORDER BY itemID`, MAX_ITEMS, tooLarge)) {
    if (!byId.has(a.id)) continue;
    attachments.set(a.id, a);
    if (a.parent !== null && a.parent !== undefined) {
      const list = childAttachments.get(a.parent) ?? [];
      list.push(a);
      childAttachments.set(a.parent, list);
    }
  }
  const notes = new Set<number>();
  const childNotes = new Map<number, number[]>();
  const childNoteIds = new Set<number>();
  const attachmentNotes = new Set<number>();
  for (const n of cappedRows<{ id: number; parent: number | null; has: number }>(
    db,
    "SELECT itemID AS id, parentItemID AS parent, (note IS NOT NULL AND note != '') AS has FROM itemNotes ORDER BY itemID",
    MAX_ITEMS,
    tooLarge,
  )) {
    if (!byId.has(n.id)) continue;
    if (attachments.has(n.id)) {
      // An attachment's own note row is not a note item (not imported; counted).
      if (n.has) attachmentNotes.add(n.id);
      continue;
    }
    notes.add(n.id);
    if (n.parent !== null && n.parent !== undefined) {
      childNoteIds.add(n.id);
      const list = childNotes.get(n.parent) ?? [];
      list.push(n.id);
      childNotes.set(n.parent, list);
    }
  }
  const annotations = new Map<number, AnnotationRef[]>();
  for (const a of annotationRows) {
    if (typeof a.key !== "string" || !KEY.test(a.key)) continue;
    const list = annotations.get(a.parent) ?? [];
    list.push({ id: a.id, key: a.key, added: a.added, modified: a.modified });
    annotations.set(a.parent, list);
  }

  // Collections (those in the trash, and their subcollections, left out).
  const colls = cappedRows<{ id: number; name: string; parent: number | null }>(
    db,
    `SELECT collectionID AS id, ${tN("collectionName", "name", 200)}, parentCollectionID AS parent FROM collections WHERE libraryID = ?`,
    MAX_LINK_ROWS,
    tooLarge,
    libraryId,
  );
  const trashedColls = tables.has("deletedCollections")
    ? new Set(cappedRows<{ id: number }>(db, "SELECT collectionID AS id FROM deletedCollections", MAX_LINK_ROWS, tooLarge).map((r) => r.id))
    : new Set<number>();
  const collById = new Map(colls.map((c) => [c.id, c]));
  const pathCache = new Map<number, string[] | null>();
  const collPath = (id: number): string[] | null => {
    if (pathCache.has(id)) return pathCache.get(id)!;
    const chain: string[] = [];
    const seen = new Set<number>();
    let ok = true;
    for (let c = collById.get(id); c; c = c.parent === null || c.parent === undefined ? undefined : collById.get(c.parent)) {
      if (seen.has(c.id) || chain.length >= MAX_COLLECTION_DEPTH) break;
      seen.add(c.id);
      if (trashedColls.has(c.id)) {
        ok = false;
        break;
      }
      chain.push(text(c.name) || "Untitled");
    }
    const out = ok && chain.length ? chain.reverse() : null;
    pathCache.set(id, out);
    return out;
  };
  const collectionPaths = new Map<number, string[][]>();
  for (const ci of cappedRows<{ coll: number; item: number }>(db, "SELECT collectionID AS coll, itemID AS item FROM collectionItems ORDER BY itemID, collectionID", MAX_LINK_ROWS, tooLarge)) {
    if (!byId.has(ci.item) || !collById.has(ci.coll)) continue;
    const p = collPath(ci.coll);
    if (!p) continue;
    const list = collectionPaths.get(ci.item) ?? [];
    if (list.length < MAX_FOLDER_PATHS) list.push(p);
    collectionPaths.set(ci.item, list);
  }

  // Tag colours: syncedSettings 'tagColors' = [{ name, color, position }].
  const tagColors = new Map<string, string>();
  if (tables.has("syncedSettings")) {
    const row = db.prepare(`SELECT ${t64("value", "value")} FROM syncedSettings WHERE setting = 'tagColors' AND libraryID = ?`).get(libraryId) as { value: unknown } | undefined;
    if (typeof row?.value === "string" && row.value.length < 65536) {
      try {
        const list = JSON.parse(row.value) as unknown;
        if (Array.isArray(list)) {
          for (const t of list.slice(0, 1000)) {
            const name = typeof t?.name === "string" ? text(t.name) : "";
            const color = typeof t?.color === "string" ? t.color.trim() : "";
            if (name && /^#[0-9a-f]{3,8}$/iu.test(color)) tagColors.set(name.toLowerCase(), color);
          }
        }
      } catch {
        // no colours
      }
    }
  }

  // Better BibTeX citation keys (by item key; this library's when the table says).
  const bbt = new Map<string, string>();
  if (bbtDb) {
    try {
      if (!plainTables(bbtDb, ["citationkey"]).has("citationkey")) throw new Error("no citationkey table");
      const cols = columnsOf(bbtDb, "citationkey");
      if (!cols.has("itemKey") || !cols.has("citationKey")) throw new Error("unexpected citationkey table");
      const sql = `SELECT ${tN("itemKey", "itemKey", 64)}, ${tN("citationKey", "citationKey", 1024)} FROM citationkey${cols.has("libraryID") ? " WHERE libraryID = ?" : ""}`;
      const rows = cappedRows<{ itemKey: unknown; citationKey: unknown }>(bbtDb, sql, MAX_ITEMS, () => new Error("too many citation keys"), ...(cols.has("libraryID") ? [libraryId] : []));
      for (const r of rows) {
        const k = typeof r.citationKey === "string" ? text(r.citationKey) : "";
        if (typeof r.itemKey === "string" && k && k.length <= 200 && !/\s/u.test(k)) bbt.set(r.itemKey, k);
      }
    } catch {
      bbt.clear();
      note(ZOTERO_NOTES.bbt);
    }
  }
  return { items, byId, deleted, attachments, childAttachments, childNotes, childNoteIds, attachmentNotes, notes, annotations, annotationIds, collectionPaths, tagColors, bbt };
}

/** Per-item reads (prepared once): fields, creators, tags, relations, note text, annotation rows. */
function itemQueries(db: Database.Database) {
  const fields = db.prepare(
    `SELECT ${t64("f.fieldName", "name")}, ${t64("v.value", "value")} FROM itemData d JOIN fields f ON f.fieldID = d.fieldID
       JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ? LIMIT ${MAX_FIELDS}`,
  );
  const creators = db.prepare(
    `SELECT ${t64("c.firstName", "first")}, ${t64("c.lastName", "last")}, c.fieldMode AS mode, ${t64("ct.creatorType", "type")}
       FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
      WHERE ic.itemID = ? ORDER BY ic.orderIndex LIMIT ${MAX_CREATORS}`,
  );
  const tags = db.prepare(`SELECT ${t64("t.name", "name")} FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ? LIMIT ${MAX_TAGS}`);
  const related = db.prepare(
    `SELECT ${tN("r.object", "object", 1024)} FROM itemRelations r JOIN relationPredicates p ON p.predicateID = r.predicateID
      WHERE r.itemID = ? AND p.predicate = 'dc:relation' LIMIT ${MAX_RELATED}`,
  );
  const note = db.prepare(`SELECT ${tN("note", "note", MAX_NOTE_CHARS)} FROM itemNotes WHERE itemID = ?`);
  const annotation = db.prepare(
    `SELECT type, ${t64("authorName", "authorName")}, ${t64("text", "text")}, ${t64("comment", "comment")}, ${t64("color", "color")},
            ${t64("pageLabel", "pageLabel")}, ${t64("position", "position")} FROM itemAnnotations WHERE itemID = ?`,
  );
  return {
    fields: (id: number) => {
      const m = new Map<string, string>();
      for (const r of fields.all(id) as Array<{ name: unknown; value: unknown }>) {
        if (typeof r.name === "string" && (typeof r.value === "string" || typeof r.value === "number")) m.set(r.name, String(r.value));
      }
      return m;
    },
    creators: (id: number): Creator[] => {
      const out: Creator[] = [];
      for (const r of creators.all(id) as Array<{ first: unknown; last: unknown; mode: unknown; type: unknown }>) {
        const role = CREATOR_ROLES[String(r.type)] ?? "contributor";
        const last = text(typeof r.last === "string" ? r.last : "");
        const first = text(typeof r.first === "string" ? r.first : "");
        if (r.mode === 1 || !first) {
          if (last) out.push(r.mode === 1 ? { literal: last, role } : { family: last, role });
        } else if (last) out.push({ family: last, given: first, role });
        else out.push({ literal: first, role });
      }
      return out;
    },
    tags: (id: number) => (tags.all(id) as Array<{ name: unknown }>).map((r) => (typeof r.name === "string" ? r.name : "")),
    related: (id: number) => {
      const keys: string[] = [];
      for (const r of related.all(id) as Array<{ object: unknown }>) {
        const m = typeof r.object === "string" ? /\/items\/([A-Za-z0-9]{1,32})$/u.exec(r.object) : null;
        if (m && !keys.includes(m[1]!)) keys.push(m[1]!);
      }
      return keys;
    },
    note: (id: number) => {
      const r = note.get(id) as { note: unknown } | undefined;
      return typeof r?.note === "string" ? r.note : "";
    },
    annotation: (id: number) => annotation.get(id) as Omit<ZoteroAnnotationRow, "key" | "dateAdded"> | undefined,
  };
}

/** The item's fields as RecordFields (+ the Extra text). */
function recordFields(type: string, f: Map<string, string>, creators: Creator[], tags: string[]): { fields: RecordFields; extra: string } {
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

async function* scanZotero(dataDir: string, o: Required<Pick<ZoteroLocalOptions, "libraryId">> & ZoteroLocalOptions, signal: AbortSignal, ctx: ScanContext | undefined): AsyncGenerator<ScanItem> {
  const fail = (reason: string): ScanItem => ({ key: "zotero:", files: [], unreadable: reason });
  if (!ctx) {
    yield fail(ZOTERO_REASONS.unreadable);
    return;
  }
  const root = resolve(dataDir);
  const storage = join(root, "storage");
  let copy;
  try {
    copy = await copyDatabases(root, { required: ["zotero.sqlite"], optional: ["better-bibtex.sqlite"] }, await ctx.workDir(), "zotero", o.maxCopyBytes ?? MAX_ZOTERO_COPY_BYTES);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    yield fail(err instanceof CopyTooLarge ? ZOTERO_REASONS.tooLarge : err instanceof CopyUnstable ? ZOTERO_REASONS.busy : ZOTERO_REASONS.unreadable);
    return;
  }
  let db: Database.Database | undefined;
  let bbtDb: Database.Database | undefined;
  try {
    let snap: Snapshot;
    let q: ReturnType<typeof itemQueries>;
    try {
      db = openCopy(copy.paths.get("zotero.sqlite")!);
      const bbtPath = copy.paths.get("better-bibtex.sqlite");
      if (bbtPath) {
        try {
          bbtDb = openCopy(bbtPath);
        } catch {
          ctx.note?.(ZOTERO_NOTES.bbt);
        }
      }
      snap = readSnapshot(db, o.libraryId, bbtDb, (t) => ctx.note?.(t));
      bbtDb?.close();
      bbtDb = undefined;
      q = itemQueries(db);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      yield fail(err instanceof ZoteroUnreadable ? err.reason : ZOTERO_REASONS.unreadable);
      return;
    }
    const gone = (id: number | null | undefined) => id !== null && id !== undefined && (snap.deleted.has(id) || !snap.byId.has(id));

    /** An attachment's file (or a note why there is none); undefined for a non-file attachment. */
    const fileOf = (a: AttachmentRow, key: string): { path: string; link: boolean } | { note: string } | undefined => {
      if (a.linkMode === 0 || a.linkMode === 1) {
        const name = storedName(a.path);
        if (!name || !KEY.test(key)) return { note: ZOTERO_FILE_NOTES.location };
        return { path: join(storage, key, name), link: false };
      }
      if (a.linkMode === 2) {
        const p = a.path ?? "";
        if (!p || p.includes("\u0000")) return { note: ZOTERO_FILE_NOTES.location };
        if (p.startsWith("attachments:")) {
          if (!o.baseAttachmentPath) return undefined; // counted in the scan note
          const rel = p.slice(12);
          if (isAbsolute(rel) || rel.split(/[\\/]/u).includes("..")) return { note: ZOTERO_FILE_NOTES.location };
          return { path: resolve(o.baseAttachmentPath, rel), link: true };
        }
        if (!isAbsolute(p)) return { note: ZOTERO_FILE_NOTES.location };
        return { path: resolve(p), link: true };
      }
      return undefined; // linked URL, embedded image
    };

    const annotationsOf = (att: number, file: string | undefined): ScanAnnotation[] => {
      const out: ScanAnnotation[] = [];
      for (const ref of snap.annotations.get(att) ?? []) {
        if (snap.deleted.has(ref.id)) continue;
        const row = q.annotation(ref.id);
        if (!row) continue;
        const a = zoteroAnnotation({ ...row, key: ref.key, dateAdded: ref.added }, file);
        if (a) out.push(a);
      }
      return out;
    };

    let standaloneNotes = 0;
    for (const it of snap.items) {
      signal.throwIfAborted();
      if (snap.deleted.has(it.id) || snap.annotationIds.has(it.id)) continue;
      if (snap.notes.has(it.id)) {
        if (!snap.childNoteIds.has(it.id)) standaloneNotes++;
        continue; // child notes come with their item below
      }
      const att = snap.attachments.get(it.id);
      if (att && att.parent !== null && att.parent !== undefined) continue; // child attachments come with their item
      if (it.type === "note") continue;

      // Version token: Zotero's version (raised on sync only) plus modification times of the item and everything under it.
      const stamp: string[] = [`${it.id}:${it.clientModified ?? ""}`];
      const children = att ? [att] : (snap.childAttachments.get(it.id) ?? []).filter((a) => !gone(a.id));
      const links: Array<{ path: string; link: boolean } | { note: string }> = [];
      const anns: ScanAnnotation[] = [];
      for (const a of children) {
        const row = snap.byId.get(a.id)!;
        if (a !== att) stamp.push(`${a.id}:${row.clientModified ?? ""}`);
        const f = fileOf(a, row.key);
        if (f) links.push(f);
        for (const ref of snap.annotations.get(a.id) ?? []) if (!snap.deleted.has(ref.id)) stamp.push(`${ref.id}:${ref.modified ?? ""}`);
        anns.push(...annotationsOf(a.id, f && "path" in f ? f.path : undefined));
      }
      for (const nid of snap.childNotes.get(it.id) ?? []) {
        if (gone(nid)) continue;
        const nrow = snap.byId.get(nid)!;
        stamp.push(`${nid}:${nrow.clientModified ?? ""}`);
        const html = q.note(nid);
        const body = html.trim() ? noteToMarkdown(html) : "";
        if (!body) continue;
        const createdAt = zoteroTimestamp(nrow.added);
        anns.push({ key: `zotero:${nrow.key}`, kind: "note", body, ...(createdAt ? { createdAt } : {}) });
      }

      const fieldMap = q.fields(it.id);
      const creators = att ? [] : q.creators(it.id);
      const tags = q.tags(it.id);
      const { fields, extra } = recordFields(att ? "attachment" : it.type, fieldMap, creators, tags);
      const citekey = snap.bbt.get(it.key) ?? extraCitationKey(extra);
      if (citekey) fields.citekey = citekey;
      const related = q.related(it.id);
      const paths = snap.collectionPaths.get(it.id) ?? [];

      const checked = await checkFiles(links.map((l) => ("note" in l ? l : { paths: [l.path] })));
      const linked = new Set(links.filter((l): l is { path: string; link: boolean } => "path" in l && l.link).map((l) => l.path));
      const files: ScanFile[] = checked.files.map((f) => (linked.has(f.path) ? { ...f, link: true } : f));
      // An annotation keeps its anchor only if its file is attached.
      const attached = new Set(files.map((f) => f.path));
      const annotations = anns.map((a) => (a.file && !attached.has(a.file) ? (({ file: _f, anchor: _a, ...rest }) => rest)(a) : a));
      if (!fields.title && !files.length && !annotations.length) continue; // an empty standalone attachment

      const tagColors: Record<string, string> = {};
      for (const t of fields.tags ?? []) {
        const c = snap.tagColors.get(t.toLowerCase());
        if (c) tagColors[t] = c;
      }
      const added = zoteroTimestamp(it.added);
      const modified = zoteroTimestamp(it.modified);
      const externalKeys: Record<string, string> = {
        zoteroKey: it.key,
        zoteroVersion: String(it.version ?? 0),
        libraryId: String(o.libraryId),
        ...(related.length ? { related: related.join(",") } : {}),
        ...(added ? { zoteroDateAdded: added } : {}),
        ...(modified ? { zoteroDateModified: modified } : {}),
        ...(citekey ? { citekey } : {}),
      };
      const token = `v${it.version ?? 0}-${createHash("sha256").update(stamp.sort().join("\n")).digest("hex").slice(0, 16)}`;
      const notes = checked.notes;
      yield {
        key: `zotero:${it.key}`,
        files,
        referenceMetadata: referenceMetadata(fields),
        referenceSource: { kind: "zotero", provider: "zotero-local" },
        ...(paths[0] ? { folderPath: paths[0] } : {}),
        ...(paths.length > 1 ? { moreFolderPaths: paths.slice(1) } : {}),
        ...(fields.tags?.length ? { tags: fields.tags } : {}),
        ...(Object.keys(tagColors).length ? { tagColors } : {}),
        ...(annotations.length ? { annotations } : {}),
        externalKeys,
        version: { id: `${o.libraryId}/${it.key}`, version: token },
        ...(notes.length ? { fileNotes: notes } : {}),
      };
    }
    // Kinds left out, counted over the library's items that are not in the trash.
    const counts: NotImported = { standaloneNotes, attachmentNotes: 0, linkedUrls: 0, embeddedImages: 0, baseRelative: 0 };
    for (const a of snap.attachments.values()) {
      if (snap.deleted.has(a.id) || gone(a.parent)) continue;
      if (snap.attachmentNotes.has(a.id)) counts.attachmentNotes++;
      if (a.linkMode === 4) counts.embeddedImages++;
      // A standalone one is an item of its own (imported with its title), so only children count.
      else if (a.parent === null || a.parent === undefined) continue;
      else if (a.linkMode === 3) counts.linkedUrls++;
      else if (a.linkMode === 2 && a.path?.startsWith("attachments:") && !o.baseAttachmentPath) counts.baseRelative++;
    }
    const left = ZOTERO_NOTES.notImported(counts);
    if (left) ctx.note?.(left);
  } finally {
    bbtDb?.close();
    db?.close();
    await copy.remove();
  }
}

/** `location` for a library other than the user's: "<dataDir>#library=<id>" (so a resumed batch reads the same library). */
const LIB_SUFFIX = /#library=(\d{1,9})$/u;

/** A Zotero data folder (the one holding `zotero.sqlite` and `storage/`). */
export function zoteroLocalAdapter(dataDir: string, opts: ZoteroLocalOptions = {}): ImportSourceAdapter {
  const m = LIB_SUFFIX.exec(dataDir);
  const dir = m ? dataDir.slice(0, m.index) : dataDir;
  const libraryId = opts.libraryId ?? (m ? Number(m[1]) : 1);
  return {
    kind: "zotero-local",
    location: libraryId === 1 ? dir : `${dir}#library=${libraryId}`,
    roots: [join(resolve(dir), "storage")],
    incremental: true,
    uniqueCitationKeys: true,
    scan: (signal, ctx) => scanZotero(dir, { ...opts, libraryId }, signal, ctx),
  };
}
