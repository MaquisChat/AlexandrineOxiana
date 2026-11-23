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
import type { Creator } from "@ao/core";
import type { ImportSourceAdapter, ScanAnnotation, ScanContext, ScanFile, ScanItem } from "./bulk/scan.js";
import { MAX_NOTE_CHARS, noteToMarkdown } from "./note-html.js";
import { checkFiles, referenceMetadata, text } from "./refman.js";
import { extraCitationKey, recordFields, zoteroAnnotation, zoteroCreator, zoteroTimestamp, type ZoteroAnnotationRow } from "./zotero-common.js";

export { ITEM_TYPES, zoteroAnnotation, zoteroTimestamp, type ZoteroAnnotationRow } from "./zotero-common.js";
import { isDiskFull, spaceMargin } from "./bulk/space.js";
import { CopyNoSpace, CopyTooLarge, CopyUnstable, CopyUnusual, UNUSUAL_STATE_REASON, cappedRows, columnsOf, copyDatabases, openCopy, plainTables, t64, tN } from "./sqlite-copy.js";

export const ZOTERO_REASONS = {
  unreadable: "The Zotero library could not be read (its zotero.sqlite is missing or damaged), so nothing was imported from it.",
  tooLarge: "The Zotero library is too large to import (its databases are over 4 GB, or it holds too many items or annotations), so nothing was imported from it.",
  busy: "Zotero is busy saving — try again in a moment or close Zotero.",
  locked: "Zotero is keeping its database locked; close Zotero and try again.",
  noSpace: "There is not enough free disk space to read the Zotero library; free some space and try again.",
  unusual: UNUSUAL_STATE_REASON,
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
  /**
   * FR-132: an update adds what is new in Zotero and takes nothing away (run.ts `updateInner`); the local import adds
   * no new collection either (the account sync does, Z6). Said in the dry run (bulk `dryRun`), and in a run that saw items again.
   */
  removalsKept: (kind: "zotero-local" | "zotero-web"): string =>
    "When an item comes in from Zotero again, what was taken away there is not taken away here: a tag taken off, an annotation deleted or a collection the item was taken out of stays as it is here." +
    (kind === "zotero-local" ? " An item put into another collection in Zotero is not put into it here." : ""),
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

const REQUIRED_TABLES = [
  "libraries", "items", "itemTypes", "fields", "itemData", "itemDataValues", "creators", "itemCreators", "creatorTypes",
  "collections", "collectionItems", "tags", "itemTags", "itemNotes", "itemAttachments", "itemAnnotations", "deletedItems",
  "itemRelations", "relationPredicates",
];
const OPTIONAL_TABLES = ["syncedSettings", "deletedCollections"];

class ZoteroUnreadable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Why the databases could not be copied, in plain words (a lock held by Zotero on Windows: close Zotero). */
export function zoteroCopyReason(err: unknown): string {
  if (err instanceof CopyTooLarge) return ZOTERO_REASONS.tooLarge;
  if (err instanceof CopyUnstable) return ZOTERO_REASONS.busy;
  if (err instanceof CopyNoSpace) return ZOTERO_REASONS.noSpace;
  if (err instanceof CopyUnusual) return ZOTERO_REASONS.unusual;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EBUSY" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"))) return ZOTERO_REASONS.locked;
  return ZOTERO_REASONS.unreadable;
}

/** An integer column as itself, NULL when it holds anything else (a text "0" is not trusted). */
const int = (col: string, as: string) => `CASE WHEN typeof(${col}) = 'integer' THEN ${col} END AS ${as}`;

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
  /** Test seam: free bytes in the work folder. */
  freeSpace?: (dir: string) => Promise<number>;
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
    `SELECT a.itemID AS id, ${int("a.parentItemID", "parent")}, ${t64("i.key", "key")}, ${t64("i.dateAdded", "added")}, ${t64("i.clientDateModified", "modified")}
       FROM itemAnnotations a JOIN items i ON i.itemID = a.itemID WHERE i.libraryID = ? ORDER BY a.parentItemID, a.itemID`,
    MAX_ANNOTATIONS,
    tooLarge,
    libraryId,
  );
  const annotationIds = new Set(annotationRows.map((r) => r.id));
  const items = cappedRows<ItemRow>(
    db,
    `SELECT i.itemID AS id, ${t64("t.typeName", "type")}, ${t64("i.key", "key")}, ${int("i.version", "version")}, ${t64("i.dateAdded", "added")},
            ${t64("i.dateModified", "modified")}, ${t64("i.clientDateModified", "clientModified")}
       FROM items i JOIN itemTypes t ON t.itemTypeID = i.itemTypeID
      WHERE i.libraryID = ? AND i.itemID NOT IN (SELECT itemID FROM itemAnnotations) ORDER BY i.itemID`,
    MAX_ITEMS,
    tooLarge,
    libraryId,
  ).filter((r) => typeof r.key === "string" && KEY.test(r.key));
  const byId = new Map(items.map((r) => [r.id, r]));
  const deleted = new Set(cappedRows<{ id: number }>(db, `SELECT ${int("itemID", "id")} FROM deletedItems`, MAX_LINK_ROWS, tooLarge).map((r) => r.id));

  const attachments = new Map<number, AttachmentRow>();
  const childAttachments = new Map<number, AttachmentRow[]>();
  for (const a of cappedRows<AttachmentRow>(db, `SELECT itemID AS id, ${int("parentItemID", "parent")}, ${int("linkMode", "linkMode")}, ${tN("path", "path", 8192)} FROM itemAttachments ORDER BY itemID`, MAX_ITEMS, tooLarge)) {
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
    `SELECT itemID AS id, ${int("parentItemID", "parent")}, (note IS NOT NULL AND note != '') AS has FROM itemNotes ORDER BY itemID`,
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
    `SELECT collectionID AS id, ${tN("collectionName", "name", 200)}, ${int("parentCollectionID", "parent")} FROM collections WHERE libraryID = ?`,
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
  for (const ci of cappedRows<{ coll: number; item: number }>(db, `SELECT ${int("collectionID", "coll")}, ${int("itemID", "item")} FROM collectionItems ORDER BY itemID, collectionID`, MAX_LINK_ROWS, tooLarge)) {
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
    `SELECT ${t64("c.firstName", "first")}, ${t64("c.lastName", "last")}, ${int("c.fieldMode", "mode")}, ${t64("ct.creatorType", "type")}
       FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
      WHERE ic.itemID = ? ORDER BY ic.orderIndex LIMIT ${MAX_CREATORS}`,
  );
  const tags = db.prepare(`SELECT ${t64("t.name", "name")} FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ? LIMIT ${MAX_TAGS}`);
  const related = db.prepare(
    `SELECT ${tN("r.object", "object", 1024)} FROM itemRelations r JOIN relationPredicates p ON p.predicateID = r.predicateID
      WHERE r.itemID = ? AND p.predicate = 'dc:relation' LIMIT ${MAX_RELATED}`,
  );
  // One character more than a note may hold, so a longer note is known to be cut (and says so).
  const note = db.prepare(`SELECT ${tN("note", "note", MAX_NOTE_CHARS + 1)} FROM itemNotes WHERE itemID = ?`);
  const annotation = db.prepare(
    `SELECT ${int("type", "type")}, ${t64("authorName", "authorName")}, ${t64("text", "text")}, ${t64("comment", "comment")}, ${t64("color", "color")},
            ${t64("pageLabel", "pageLabel")}, ${t64("sortIndex", "sortIndex")}, ${t64("position", "position")} FROM itemAnnotations WHERE itemID = ?`,
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
        const c = zoteroCreator(r.first, r.last, r.mode === 1, r.type);
        if (c) out.push(c);
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
    copy = await copyDatabases(root, { required: ["zotero.sqlite"], optional: ["better-bibtex.sqlite"] }, await ctx.workDir(), "zotero", o.maxCopyBytes ?? MAX_ZOTERO_COPY_BYTES, {
      signal,
      // R413 d: the copy leaves free what the import will copy and its margin, not 64 MB.
      reserve: ctx.reserveBytes ?? spaceMargin(0),
      ...(o.freeSpace ? { freeSpace: o.freeSpace } : {}),
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || signal.aborted) throw signal.reason ?? err;
    // R436 a: a full disk (or a quota) during the copy, after its own check of the room passed, ends the scan: the run
    // stops the batch, resumable (copyDatabases has removed its folder). Never "missing or damaged".
    if (isDiskFull(err)) throw err;
    yield fail(zoteroCopyReason(err));
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

    /** Whether the scan below yields this row as an item of its own (its own filters, in its own order). */
    const ownItem = (it: ItemRow): boolean => {
      if (snap.deleted.has(it.id) || snap.annotationIds.has(it.id) || snap.notes.has(it.id)) return false; // child notes come with their item
      const att = snap.attachments.get(it.id);
      if (att && att.parent !== null && att.parent !== undefined) return false; // child attachments come with their item
      return it.type !== "note";
    };
    // R392: the total, counted over the same rows of the copy with the same filters, told before the first item;
    // an empty standalone attachment (known only once its file is looked for) lowers it when it is passed by.
    let told = 0;
    for (const it of snap.items) if (ownItem(it)) told++;
    ctx.total?.(told);

    let standaloneNotes = 0;
    for (const it of snap.items) {
      signal.throwIfAborted();
      if (!ownItem(it)) {
        if (!snap.deleted.has(it.id) && !snap.annotationIds.has(it.id) && snap.notes.has(it.id) && !snap.childNoteIds.has(it.id)) standaloneNotes++;
        continue;
      }
      const att = snap.attachments.get(it.id);

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
      // BBT's database, then Zotero's own citationKey field, then Extra, else generated later.
      const native = text(fieldMap.get("citationKey"));
      const citekey = snap.bbt.get(it.key) ?? (native && native.length <= 200 && !/\s/u.test(native) ? native : undefined) ?? extraCitationKey(extra);
      stamp.push(`citekey:${citekey ?? ""}`);
      if (citekey) fields.citekey = citekey;
      const related = q.related(it.id);
      const paths = snap.collectionPaths.get(it.id) ?? [];

      const checked = await checkFiles(links.map((l) => ("note" in l ? l : { paths: [l.path] })));
      const linked = new Set(links.filter((l): l is { path: string; link: boolean } => "path" in l && l.link).map((l) => l.path));
      const files: ScanFile[] = checked.files.map((f) => (linked.has(f.path) ? { ...f, link: true } : f));
      // An annotation keeps its anchor only if its file is attached.
      const attached = new Set(files.map((f) => f.path));
      const annotations = anns.map((a) => (a.file && !attached.has(a.file) ? (({ file: _f, anchor: _a, ...rest }) => rest)(a) : a));
      if (!fields.title && !files.length && !annotations.length) {
        ctx.total?.(--told); // an empty standalone attachment: not an item after all
        continue;
      }

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
