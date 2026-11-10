/**
 * Calibre library for Bulk Import (spec 5.4; Task 24, R65). Provenance `calibre_import`.
 *
 * Calibre's `metadata.db` is never opened in place (Calibre may be running): it is copied into a
 * private (0700) folder inside the batch's work folder (`<Library>/.tmp/batch-<id>/`, swept on
 * startup as a `batch-*` leftover), opened read-only, read in full, closed, and deleted before the
 * first item is yielded; a failed copy or query deletes it too. The join: `books`, `authors`
 * (through `books_authors_link`), `identifiers`, `tags` (through `books_tags_link`) and `data`,
 * whose rows name the format files at `<library>/<books.path>/<data.name>.<format in lower case>`.
 *
 * `books.path` and `data.name` come from a file anyone could edit, so each format file must
 * resolve inside the Calibre library folder, lexically and after following symbolic links: an
 * absolute path, a ".." escape or a link pointing out skips that format file with a file note
 * (CALIBRE_FILE_NOTE; nothing outside the library is read) and the book's metadata still imports
 * (R66). A missing format file, or one that is not a regular file, is skipped with a note too
 * (refman.ts `checkFiles`); a book left with no files is a metadata-only item. Only a library whose
 * metadata.db cannot be read is an unreadable item.
 *
 * Item keys are `<library folder name>@<hash of its absolute path>#book-<id>` (stable; R63 HMAC in
 * provenance); `externalKeys` keeps the Calibre book id and uuid.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type { Creator } from "@ao/core";
import { parseName } from "../extract/names.js";
import type { ImportSourceAdapter, ScanContext, ScanItem } from "./bulk/scan.js";
import { exportIdentity, isbnsOf, recordItem, skippedNote, tagList, text, doiOf, issnOf, type RecordFields } from "./refman.js";

export const CALIBRE_REASONS = {
  unreadable: "The Calibre library could not be read (its metadata.db is missing or damaged), so nothing was imported from it.",
  tooLarge: "The Calibre library is too large to import (its metadata.db is over 1 GB or lists too many books), so nothing was imported from it.",
} as const;

/** The largest metadata.db copied (R68 I1). */
export const MAX_CALIBRE_DB_BYTES = 1024 * 1024 * 1024;
const MAX_BOOKS = 200_000;
const MAX_LINK_ROWS = 2_000_000;
const REQUIRED_TABLES = ["books", "authors", "books_authors_link", "identifiers", "tags", "books_tags_link", "data"];

class CalibreUnreadable extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** File note for a format file whose recorded location points outside the library (never the path). */
export const CALIBRE_FILE_NOTE = "attached file is outside the Calibre library";

/** Calibre's "no date" (UNDEFINED_DATE) and anything before year 1000 are not dates. */
const isRealDate = (d: string) => /^\d{4}/u.test(d) && Number(d.slice(0, 4)) >= 1000;

export interface CalibreCopy {
  path: string;
  remove(): Promise<void>;
}

/** Copies `<libraryDir>/metadata.db` (and its -wal, if any) into a new 0700 folder inside `workDir`. */
export async function copyCalibreDb(libraryDir: string, workDir: string): Promise<CalibreCopy> {
  const dir = join(workDir, `calibre-${randomBytes(6).toString("hex")}`);
  await fsp.mkdir(dir, { mode: 0o700 });
  const remove = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    if (process.platform !== "win32") await fsp.chmod(dir, 0o700);
    const src = join(libraryDir, "metadata.db");
    const st = await fsp.stat(src);
    if (!st.isFile()) throw new Error("metadata.db is not a file");
    const wal = await fsp.stat(`${src}-wal`).catch(() => null);
    if (st.size + (wal?.isFile() ? wal.size : 0) > MAX_CALIBRE_DB_BYTES) throw new CalibreUnreadable(CALIBRE_REASONS.tooLarge);
    const dest = join(dir, "metadata.db");
    await fsp.copyFile(src, dest);
    if (wal?.isFile()) await fsp.copyFile(`${src}-wal`, `${dest}-wal`);
    if ((await fsp.stat(dest)).size > MAX_CALIBRE_DB_BYTES) throw new CalibreUnreadable(CALIBRE_REASONS.tooLarge); // grew while copied
    return { path: dest, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

interface BookRow {
  id: number;
  title: string | null;
  path: string | null;
  pubdate: string | null;
  uuid: string | null;
}

interface CalibreBook {
  id: number;
  fields: RecordFields;
  uuid?: string;
  /** Relative format file locations (null: the row points outside the library). */
  files: Array<string | null>;
}

/** The names sqlite_master lists as real tables (views, triggers and the like are not). */
const realTables = (db: Database.Database) =>
  new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));

/**
 * Reads every book from a (copied) metadata.db. Every name read must be a real table (a view named
 * `books` could run any query, e.g. an endless recursive CTE); `trusted_schema` is off so schema
 * objects cannot call functions with side effects; rows are read with iterate() under caps (books
 * ≤ 200,000; each link/data table ≤ 2,000,000), past which the library is refused (R68 I1).
 */
function readBooks(dbPath: string): CalibreBook[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.pragma("query_only = ON");
    const tables = realTables(db);
    for (const t of REQUIRED_TABLES) if (!tables.has(t)) throw new CalibreUnreadable(CALIBRE_REASONS.unreadable);
    const rows = <T>(sql: string, max: number): T[] => {
      const out: T[] = [];
      for (const r of db.prepare(sql).iterate() as IterableIterator<T>) {
        if (out.length >= max) throw new CalibreUnreadable(CALIBRE_REASONS.tooLarge);
        out.push(r);
      }
      return out;
    };
    const books = rows<BookRow>("SELECT id, title, path, pubdate, uuid FROM books ORDER BY id", MAX_BOOKS);
    const group = <T>(list: Array<{ book: number } & T>) => {
      const m = new Map<number, T[]>();
      for (const r of list) {
        const l = m.get(r.book) ?? [];
        l.push(r);
        m.set(r.book, l);
      }
      return m;
    };
    const authors = group(rows<{ book: number; name: string }>("SELECT l.book AS book, a.name AS name FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.book, l.id", MAX_LINK_ROWS));
    const ids = group(rows<{ book: number; type: string; val: string }>("SELECT book, type, val FROM identifiers ORDER BY book, id", MAX_LINK_ROWS));
    const tags = group(rows<{ book: number; name: string }>("SELECT l.book AS book, t.name AS name FROM books_tags_link l JOIN tags t ON t.id = l.tag ORDER BY l.book, l.id", MAX_LINK_ROWS));
    const data = group(rows<{ book: number; format: string; name: string }>("SELECT book, format, name FROM data ORDER BY book, id", MAX_LINK_ROWS));
    const publishers =
      tables.has("books_publishers_link") && tables.has("publishers")
        ? group(rows<{ book: number; name: string }>("SELECT l.book AS book, p.name AS name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher ORDER BY l.book, l.id", MAX_LINK_ROWS))
        : new Map<number, Array<{ name: string }>>();

    return books.map((b): CalibreBook => {
      const f: RecordFields = { type: "book" };
      const title = text(b.title);
      if (title) f.title = title;
      const creators = (authors.get(b.id) ?? []).map((a) => parseName(text(a.name))).filter((c): c is Creator => !!c);
      if (creators.length) f.creators = creators;
      const pub = text(b.pubdate);
      if (pub && isRealDate(pub)) f.issued = pub.slice(0, 10);
      const publisher = text(publishers.get(b.id)?.[0]?.name);
      if (publisher) f.publisher = publisher;
      for (const i of ids.get(b.id) ?? []) {
        const type = text(i.type).toLowerCase();
        if (type === "isbn") f.isbn = isbnsOf([...(f.isbn ?? []), i.val]);
        else if (type === "doi") f.doi ??= doiOf(i.val);
        else if (type === "issn") f.issn ??= issnOf(i.val);
        else if (type === "url" && !f.url) f.url = text(i.val);
      }
      if (!f.isbn?.length) delete f.isbn;
      const t = tagList((tags.get(b.id) ?? []).map((x) => x.name));
      if (t.length) f.tags = t;
      const files = formatFiles(b.path, data.get(b.id) ?? []);
      return { id: b.id, fields: f, files, ...(b.uuid ? { uuid: text(b.uuid) } : {}) };
    });
  } finally {
    db.close();
  }
}

/** A relative location that stays inside its base: no absolute path, drive, NUL or ".." segment. */
function safeRelative(p: string): boolean {
  if (!p || p.includes("\u0000") || isAbsolute(p) || /^[A-Za-z]:/u.test(p) || p.startsWith("\\")) return false;
  return !p.split(/[\\/]/u).some((s) => s === "..");
}

/** `<path>/<name>.<format>` for each data row (relative to the library); null for a row that escapes it. */
function formatFiles(path: string | null, rows: Array<{ format: string; name: string }>): Array<string | null> {
  const dir = path ?? "";
  const dirOk = safeRelative(dir);
  return rows.map((r) => {
    const name = r.name ?? "";
    const format = (r.format ?? "").toLowerCase();
    if (!dirOk || !safeRelative(name) || name.includes("/") || name.includes("\\") || !/^[a-z0-9_]{1,16}$/u.test(format)) return null;
    return `${dir}/${name}.${format}`;
  });
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** Absolute paths of a book's files inside the library, and how many resolve (lexically or through links) outside it. */
async function locate(root: string, realRoot: string, rels: Array<string | null>): Promise<{ paths: string[]; outside: number }> {
  const paths: string[] = [];
  let outside = 0;
  for (const rel of rels) {
    const p = rel === null ? null : resolve(root, ...rel.split(/[\\/]/u));
    // A file that does not exist is not refused here: checkFiles notes it as not found.
    const real = p && inside(root, p) ? await fsp.realpath(p).catch(() => undefined) : null;
    if (!p || real === null || (real !== undefined && !inside(realRoot, real))) {
      outside++;
      continue;
    }
    paths.push(p);
  }
  return { paths, outside };
}

async function* scanCalibre(libraryDir: string, signal: AbortSignal, ctx: ScanContext | undefined): AsyncGenerator<ScanItem> {
  const root = resolve(libraryDir);
  const prefix = exportIdentity(root);
  const fail = (): ScanItem => ({ key: `${prefix}#`, files: [], unreadable: CALIBRE_REASONS.unreadable });
  if (!ctx) {
    yield fail();
    return;
  }
  let books: CalibreBook[];
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
    const copy = await copyCalibreDb(root, await ctx.workDir());
    try {
      books = readBooks(copy.path);
    } finally {
      await copy.remove();
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    yield err instanceof CalibreUnreadable ? { ...fail(), unreadable: err.reason } : fail();
    return;
  }
  let skipped = 0;
  for (const b of books) {
    signal.throwIfAborted();
    const key = `${prefix}#book-${b.id}`;
    const externalKeys = { "calibre-book": String(b.id), ...(b.uuid ? { "calibre-uuid": b.uuid } : {}) };
    const { paths, outside } = await locate(root, realRoot, b.files);
    const item = await recordItem(key, b.fields, paths.map((p) => ({ paths: [p] })), { externalKeys, notes: Array<string>(outside).fill(CALIBRE_FILE_NOTE) });
    if (item) yield item;
    else skipped++;
  }
  if (skipped) ctx.note?.(skippedNote(skipped));
}

/** A Calibre library folder (the one holding `metadata.db`). */
export function calibreAdapter(libraryDir: string): ImportSourceAdapter {
  return {
    kind: "calibre",
    location: libraryDir,
    roots: [resolve(libraryDir)],
    scan: (signal, ctx) => scanCalibre(libraryDir, signal, ctx),
  };
}
