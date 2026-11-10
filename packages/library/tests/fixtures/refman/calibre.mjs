#!/usr/bin/env node
// Builds a tiny Calibre library (the subset of metadata.db the importer reads: books, authors,
// books_authors_link, identifiers, tags, books_tags_link, data) with the book files it names.
// Nothing binary is committed: tests call `buildCalibreLibrary(dir)` into a temp folder, and
// `node packages/library/tests/fixtures/refman/calibre.mjs <dir>` writes one for inspection.
//
// Books:
//   1  "Feeding the City"   Ngozi Okafor, Jan Müller   PDF + EPUB present, ISBN + DOI, two tags
//   2  "Markets and Memory" Tunde Adebayo              no formats (metadata only)
//   3  "Outside the Library"                           path "../outside" (traversal)
//   4  "Absolute Path"                                 path is absolute
//   5  "Sneaky Name"                                   data.name "../../escape"
//   6  "Lost Format"                                   PDF row, file missing
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireLib = createRequire(join(here, "..", "..", "..", "package.json"));

const SCHEMA = `
CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT 'Unknown', sort TEXT,
  timestamp TIMESTAMP, pubdate TIMESTAMP, series_index REAL NOT NULL DEFAULT 1.0, author_sort TEXT, isbn TEXT DEFAULT '',
  lccn TEXT DEFAULT '', path TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 1, uuid TEXT, has_cover BOOL DEFAULT 0,
  last_modified TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:00+00:00');
CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, link TEXT NOT NULL DEFAULT '', UNIQUE(name));
CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE, val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT '', UNIQUE (name));
CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE, uncompressed_size INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(book, format));
`;

const UNDEFINED_DATE = "0101-01-01T00:00:00+00:00";

/**
 * Writes `<dir>/metadata.db` and the book files. `pdf` is the bytes written for each PDF format file
 * (a real PDF, so the import engine accepts it); `epub` likewise.
 * @param {string} dir
 * @param {{ pdf: Buffer, epub?: Buffer }} files
 * @returns {{ dir: string, db: string, okaforPdf: string, okaforEpub: string }}
 */
export function buildCalibreLibrary(dir, files) {
  const Database = requireLib("better-sqlite3");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "metadata.db"));
  try {
    db.exec(SCHEMA);
    const book = db.prepare("INSERT INTO books (id, title, sort, timestamp, pubdate, author_sort, path, uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const author = db.prepare("INSERT INTO authors (id, name, sort) VALUES (?, ?, ?)");
    const bal = db.prepare("INSERT INTO books_authors_link (book, author) VALUES (?, ?)");
    const ident = db.prepare("INSERT INTO identifiers (book, type, val) VALUES (?, ?, ?)");
    const tag = db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)");
    const btl = db.prepare("INSERT INTO books_tags_link (book, tag) VALUES (?, ?)");
    const data = db.prepare("INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)");
    const ts = "2024-05-01T10:00:00+00:00";
    db.transaction(() => {
      author.run(1, "Ngozi Okafor", "Okafor, Ngozi");
      author.run(2, "Jan Müller", "Müller, Jan");
      author.run(3, "Tunde Adebayo", "Adebayo, Tunde");
      tag.run(1, "food systems");
      tag.run(2, "Lagos");

      book.run(1, "Feeding the City", "Feeding the City", ts, "2024-03-01T00:00:00+00:00", "Okafor, Ngozi", "Ngozi Okafor/Feeding the City (1)", "11111111-1111-4111-8111-111111111111");
      bal.run(1, 1);
      bal.run(1, 2);
      ident.run(1, "isbn", "9780262033848");
      ident.run(1, "doi", "10.5555/ao.urban.2024.017");
      btl.run(1, 1);
      btl.run(1, 2);
      data.run(1, "PDF", files.pdf.length, "Feeding the City - Ngozi Okafor");
      data.run(1, "EPUB", (files.epub ?? files.pdf).length, "Feeding the City - Ngozi Okafor");

      book.run(2, "Markets and Memory", "Markets and Memory", ts, "2019-01-01T00:00:00+00:00", "Adebayo, Tunde", "Tunde Adebayo/Markets and Memory (2)", "22222222-2222-4222-8222-222222222222");
      bal.run(2, 3);

      book.run(3, "Outside the Library", "Outside the Library", ts, UNDEFINED_DATE, "", "../outside", "33333333-3333-4333-8333-333333333333");
      data.run(3, "PDF", files.pdf.length, "secret");

      book.run(4, "Absolute Path", "Absolute Path", ts, UNDEFINED_DATE, "", resolve(dir, "..", "abs"), "44444444-4444-4444-8444-444444444444");
      data.run(4, "PDF", files.pdf.length, "secret");

      book.run(5, "Sneaky Name", "Sneaky Name", ts, UNDEFINED_DATE, "", "Sneaky/Sneaky Name (5)", "55555555-5555-4555-8555-555555555555");
      data.run(5, "PDF", files.pdf.length, "../../../escape");

      book.run(6, "Lost Format", "Lost Format", ts, UNDEFINED_DATE, "", "Lost/Lost Format (6)", "66666666-6666-4666-8666-666666666666");
      data.run(6, "PDF", files.pdf.length, "Lost Format");
    })();
  } finally {
    db.close();
  }
  const bookDir = join(dir, "Ngozi Okafor", "Feeding the City (1)");
  mkdirSync(bookDir, { recursive: true });
  const okaforPdf = join(bookDir, "Feeding the City - Ngozi Okafor.pdf");
  const okaforEpub = join(bookDir, "Feeding the City - Ngozi Okafor.epub");
  writeFileSync(okaforPdf, files.pdf);
  writeFileSync(okaforEpub, files.epub ?? files.pdf);
  // Targets of the traversal rows exist, so a refusal is the containment check, not a missing file.
  mkdirSync(resolve(dir, "..", "outside"), { recursive: true });
  writeFileSync(join(resolve(dir, "..", "outside"), "secret.pdf"), files.pdf);
  mkdirSync(resolve(dir, "..", "abs"), { recursive: true });
  writeFileSync(join(resolve(dir, "..", "abs"), "secret.pdf"), files.pdf);
  writeFileSync(resolve(dir, "..", "escape.pdf"), files.pdf);
  return { dir, db: join(dir, "metadata.db"), okaforPdf, okaforEpub };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(here, "generated", "Calibre Library"));
  const { pdf } = { pdf: Buffer.from("%PDF-1.4\n%fixture\n") };
  console.log(buildCalibreLibrary(out, { pdf }).db);
}
