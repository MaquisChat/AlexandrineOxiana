#!/usr/bin/env node
// Builds a tiny Zotero data folder: `zotero.sqlite` with the subset of the Zotero 7 schema the
// importer reads (libraries, items, itemTypes, fields, itemData, itemDataValues, creators,
// itemCreators, creatorTypes, collections, collectionItems, tags, itemTags, itemNotes,
// itemAttachments, itemAnnotations, deletedItems, itemRelations, relationPredicates, plus
// syncedSettings for tag colours), `storage/<KEY>/<file>`, and optionally `better-bibtex.sqlite`
// with `citationkey(itemID, itemKey, libraryID, citationKey, pinned)`. Column names and types
// follow Zotero 7's schema (system.sql / userdata.sql); type and field ids are this fixture's own
// (the importer joins on names). Nothing binary is committed: tests call `buildZoteroFixture(dir)`
// into a temp folder; `node packages/library/tests/fixtures/zotero/build-fixture.mjs <dir>` writes
// one for inspection.
//
// User library (1):
//   1 AAAA1111 journalArticle "Feeding the City: Informal Markets in Lagos"  Okafor, Müller; 2024-03
//       collections Urban > Food; tags "food systems" (coloured), "Lagos"; BBT key; related to BBBB2222
//       7  ATTPDF01 stored PDF  storage/ATTPDF01/okafor.pdf
//            9  ANNO0001 highlight, page index 0     10 ANNO0002 note, page index 2
//       8  NOTE0001 child note (HTML with a script, a link, an image)
//       11 ATTTRSH1 stored PDF in the trash (skipped)
//   2 BBBB2222 book "Markets and Memory"  Adebayo; 2019; ISBN; "Citation Key:" line in Extra
//       collection Urban; 12 LINKPDF1 linked PDF outside the data folder
//   3 CCCC3333 report "Water Access in Peri-Urban Areas"  World Health Organization (single field)
//   4 DDDD4444 bookSection "Street Food and the State"  Doe (author), Roe (editor); 2020
//   5 EEEE5555 journalArticle "Street Vendors in Accra"  Doe; 2020 (same generated key as 4)
//   6 FFFF6666 journalArticle "Deleted Article" — in the trash; 13 NOTEDEL1 its child note
// Group library (2):
//   14 GGGG7777 "Group Item" (not imported with the default library)
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireLib = createRequire(join(here, "..", "..", "..", "package.json"));

export const SCHEMA = `
CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT NOT NULL, editable INT NOT NULL, filesEditable INT NOT NULL,
  version INT NOT NULL DEFAULT 0, storageVersion INT NOT NULL DEFAULT 0, lastSync INT NOT NULL DEFAULT 0, archived INT NOT NULL DEFAULT 0);
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT, templateItemTypeID INT, display INT DEFAULT 1);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT, fieldFormatID INT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT NOT NULL, dateAdded TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, clientDateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  libraryID INT NOT NULL, key TEXT NOT NULL, version INT NOT NULL DEFAULT 0, synced INT NOT NULL DEFAULT 0, UNIQUE (libraryID, key));
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value UNIQUE);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID, PRIMARY KEY (itemID, fieldID));
CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE INDEX itemNotes_parentItemID ON itemNotes(parentItemID);
CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, charsetID INT, path TEXT,
  syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT, lastProcessedModificationTime INT);
CREATE INDEX itemAttachments_parentItemID ON itemAttachments(parentItemID);
CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT NOT NULL, type INTEGER NOT NULL, authorName TEXT, text TEXT,
  comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT NOT NULL, position TEXT NOT NULL, isExternal INT NOT NULL);
CREATE INDEX itemAnnotations_parentItemID ON itemAnnotations(parentItemID);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE itemTags (itemID INT NOT NULL, tagID INT NOT NULL, type INT NOT NULL, PRIMARY KEY (itemID, tagID));
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT, UNIQUE (lastName, firstName, fieldMode));
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators (itemID INT NOT NULL, creatorID INT NOT NULL, creatorTypeID INT NOT NULL DEFAULT 1, orderIndex INT NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex), UNIQUE (itemID, orderIndex));
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT NOT NULL, parentCollectionID INT DEFAULT NULL,
  clientDateModified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, libraryID INT NOT NULL, key TEXT NOT NULL, version INT NOT NULL DEFAULT 0,
  synced INT NOT NULL DEFAULT 0, UNIQUE (libraryID, key));
CREATE TABLE collectionItems (collectionID INT NOT NULL, itemID INT NOT NULL, orderIndex INT NOT NULL DEFAULT 0, PRIMARY KEY (collectionID, itemID));
CREATE INDEX collectionItems_itemID ON collectionItems(itemID);
CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY, dateDeleted DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE relationPredicates (predicateID INTEGER PRIMARY KEY, predicate TEXT UNIQUE);
CREATE TABLE itemRelations (itemID INT NOT NULL, predicateID INT NOT NULL, object TEXT NOT NULL, PRIMARY KEY (itemID, predicateID, object));
CREATE TABLE syncedSettings (setting TEXT NOT NULL, libraryID INT NOT NULL, value NOT NULL, version INT NOT NULL DEFAULT 0,
  synced INT NOT NULL DEFAULT 0, PRIMARY KEY (setting, libraryID));
CREATE TABLE settings (setting TEXT, key TEXT, value, PRIMARY KEY (setting, key));
`;

const TYPES = ["annotation", "attachment", "note", "journalArticle", "book", "bookSection", "report"];
const FIELDS = ["title", "date", "publicationTitle", "bookTitle", "publisher", "DOI", "ISBN", "ISSN", "url", "extra", "abstractNote"];
const CREATOR_TYPES = ["author", "editor", "contributor", "bookAuthor"];

export const NOTE_HTML =
  '<div data-schema-version="9"><h1>Reading notes</h1><p onclick="alert(1)">Markets are <strong>central</strong>.</p>' +
  '<script>alert("x")</script><p>See <a href="https://example.org/lagos">the dataset</a> and ' +
  '<a href="javascript:alert(1)">this</a>.</p><p><img src="data:image/png;base64,AAAA" data-attachment-key="IMGKEY01"></p>' +
  '<iframe src="https://evil.example"></iframe><style>p{color:red}</style><ul><li>one</li><li>two</li></ul></div>';

/**
 * Writes `<dir>/zotero.sqlite`, `<dir>/storage/…` and (unless `bbt` is false) `<dir>/better-bibtex.sqlite`;
 * the linked PDF goes to `linkedDir` (outside the data folder).
 * @param {string} dir
 * @param {{ pdf: Buffer, linkedPdf: Buffer, linkedDir: string, trashedPdf?: Buffer, bbt?: boolean }} o
 */
export function buildZoteroFixture(dir, o) {
  const Database = requireLib("better-sqlite3");
  mkdirSync(dir, { recursive: true });
  const storagePdf = join(dir, "storage", "ATTPDF01", "okafor.pdf");
  mkdirSync(dirname(storagePdf), { recursive: true });
  writeFileSync(storagePdf, o.pdf);
  mkdirSync(join(dir, "storage", "ATTTRSH1"), { recursive: true });
  writeFileSync(join(dir, "storage", "ATTTRSH1", "trashed.pdf"), o.trashedPdf ?? o.linkedPdf);
  mkdirSync(o.linkedDir, { recursive: true });
  const linkedPdf = join(resolve(o.linkedDir), "adebayo.pdf");
  writeFileSync(linkedPdf, o.linkedPdf);

  const dbPath = join(dir, "zotero.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA);
    const typeId = (n) => TYPES.indexOf(n) + 1;
    const fieldId = (n) => FIELDS.indexOf(n) + 1;
    db.transaction(() => {
      db.prepare("INSERT INTO libraries (libraryID, type, editable, filesEditable) VALUES (1, 'user', 1, 1), (2, 'group', 1, 1)").run();
      TYPES.forEach((t, i) => db.prepare("INSERT INTO itemTypes (itemTypeID, typeName) VALUES (?, ?)").run(i + 1, t));
      FIELDS.forEach((f, i) => db.prepare("INSERT INTO fields (fieldID, fieldName) VALUES (?, ?)").run(i + 1, f));
      CREATOR_TYPES.forEach((t, i) => db.prepare("INSERT INTO creatorTypes (creatorTypeID, creatorType) VALUES (?, ?)").run(i + 1, t));
      const item = db.prepare(
        "INSERT INTO items (itemID, itemTypeID, dateAdded, dateModified, clientDateModified, libraryID, key, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const add = (id, type, key, { lib = 1, version = 1, added = "2024-05-01 10:00:00", modified = "2024-05-02 11:00:00" } = {}) =>
        item.run(id, typeId(type), added, modified, modified, lib, key, version);
      let valueId = 0;
      const values = new Map();
      const setField = (itemId, field, value) => {
        let v = values.get(value);
        if (!v) {
          v = ++valueId;
          values.set(value, v);
          db.prepare("INSERT INTO itemDataValues (valueID, value) VALUES (?, ?)").run(v, value);
        }
        db.prepare("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)").run(itemId, fieldId(field), v);
      };
      let creatorId = 0;
      const creatorIds = new Map();
      const creator = (itemId, order, type, last, first, fieldMode = 0) => {
        const k = `${last}\u0000${first}\u0000${fieldMode}`;
        let id = creatorIds.get(k);
        if (!id) {
          id = ++creatorId;
          creatorIds.set(k, id);
          db.prepare("INSERT INTO creators (creatorID, firstName, lastName, fieldMode) VALUES (?, ?, ?, ?)").run(id, first, last, fieldMode);
        }
        db.prepare("INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, ?, ?)").run(
          itemId,
          id,
          CREATOR_TYPES.indexOf(type) + 1,
          order,
        );
      };

      // 1: journal article with a stored PDF, two annotations, a note, a trashed attachment.
      add(1, "journalArticle", "AAAA1111", { version: 5 });
      setField(1, "title", "Feeding the City: Informal Markets in Lagos");
      setField(1, "date", "2024-03-00 March 2024");
      setField(1, "publicationTitle", "Journal of Urban Studies");
      setField(1, "DOI", "10.5555/ao.urban.2024.017");
      creator(1, 0, "author", "Okafor", "Ngozi");
      creator(1, 1, "author", "Müller", "Jan");
      add(7, "attachment", "ATTPDF01");
      db.prepare("INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (7, 1, 0, 'application/pdf', 'storage:okafor.pdf')").run();
      add(9, "annotation", "ANNO0001", { added: "2024-05-03 09:00:00" });
      db.prepare(
        "INSERT INTO itemAnnotations (itemID, parentItemID, type, authorName, text, comment, color, pageLabel, sortIndex, position, isExternal) VALUES (9, 7, 1, '', ?, ?, '#ffd400', '1', '00000|000100|00200', ?, 0)",
      ).run("informal markets", "key claim", JSON.stringify({ pageIndex: 0, rects: [[100.5, 200, 300, 215.25]] }));
      add(10, "annotation", "ANNO0002", { added: "2024-05-03 09:05:00" });
      db.prepare(
        "INSERT INTO itemAnnotations (itemID, parentItemID, type, authorName, text, comment, color, pageLabel, sortIndex, position, isExternal) VALUES (10, 7, 2, '', '', ?, '#5fb236', '3', '00002|000050|00060', ?, 0)",
      ).run("check the numbers", JSON.stringify({ pageIndex: 2, rects: [[50, 60, 72, 82]] }));
      add(8, "note", "NOTE0001");
      db.prepare("INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (8, 1, ?, 'Reading notes')").run(NOTE_HTML);
      add(11, "attachment", "ATTTRSH1");
      db.prepare("INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (11, 1, 0, 'application/pdf', 'storage:trashed.pdf')").run();
      db.prepare("INSERT INTO deletedItems (itemID) VALUES (11)").run();

      // 2: book, citation key in Extra, linked PDF outside the data folder.
      add(2, "book", "BBBB2222", { version: 3 });
      setField(2, "title", "Markets and Memory");
      setField(2, "date", "2019");
      setField(2, "ISBN", "978-0-262-03384-8");
      setField(2, "publisher", "MIT Press");
      setField(2, "extra", "Citation Key: adebayo2019markets\ntex.howpublished: print");
      creator(2, 0, "author", "Adebayo", "Tunde");
      add(12, "attachment", "LINKPDF1");
      db.prepare("INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (12, 2, 2, 'application/pdf', ?)").run(linkedPdf);

      // 3: report by an organisation (single-field name), no files.
      add(3, "report", "CCCC3333");
      setField(3, "title", "Water Access in Peri-Urban Areas");
      setField(3, "date", "2021-06-15 2021-06-15");
      creator(3, 0, "author", "World Health Organization", "", 1);

      // 4 and 5: the same generated citation key.
      add(4, "bookSection", "DDDD4444");
      setField(4, "title", "Street Food and the State");
      setField(4, "date", "2020");
      setField(4, "bookTitle", "Urban Informality");
      creator(4, 0, "author", "Doe", "Jane");
      creator(4, 1, "editor", "Roe", "Rita");
      add(5, "journalArticle", "EEEE5555");
      setField(5, "title", "Street Vendors in Accra");
      setField(5, "date", "2020");
      creator(5, 0, "author", "Doe", "Jane");

      // 6: in the trash, with a child note.
      add(6, "journalArticle", "FFFF6666");
      setField(6, "title", "Deleted Article");
      db.prepare("INSERT INTO deletedItems (itemID) VALUES (6)").run();
      add(13, "note", "NOTEDEL1");
      db.prepare("INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (13, 6, '<p>gone</p>', 'gone')").run();

      // Group library.
      add(14, "journalArticle", "GGGG7777", { lib: 2 });
      setField(14, "title", "Group Item");

      // Collections: Urban > Food.
      db.prepare("INSERT INTO collections (collectionID, collectionName, parentCollectionID, libraryID, key) VALUES (1, 'Urban', NULL, 1, 'COLURBAN'), (2, 'Food', 1, 1, 'COLFOOD1')").run();
      db.prepare("INSERT INTO collectionItems (collectionID, itemID, orderIndex) VALUES (2, 1, 0), (1, 2, 0)").run();

      // Tags (one coloured), relations.
      db.prepare("INSERT INTO tags (tagID, name) VALUES (1, 'food systems'), (2, 'Lagos')").run();
      db.prepare("INSERT INTO itemTags (itemID, tagID, type) VALUES (1, 1, 0), (1, 2, 1)").run();
      db.prepare("INSERT INTO syncedSettings (setting, libraryID, value) VALUES ('tagColors', 1, ?)").run(JSON.stringify([{ name: "food systems", color: "#FF6666" }]));
      db.prepare("INSERT INTO relationPredicates (predicateID, predicate) VALUES (1, 'dc:relation')").run();
      db.prepare("INSERT INTO itemRelations (itemID, predicateID, object) VALUES (1, 1, 'http://zotero.org/users/local/abcd1234/items/BBBB2222')").run();
    })();
  } finally {
    db.close();
  }

  let bbtDb;
  if (o.bbt !== false) {
    bbtDb = join(dir, "better-bibtex.sqlite");
    const b = new Database(bbtDb);
    try {
      b.exec("CREATE TABLE citationkey (itemID INTEGER PRIMARY KEY, itemKey TEXT NOT NULL, libraryID INTEGER NOT NULL, citationKey TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)");
      b.prepare("INSERT INTO citationkey (itemID, itemKey, libraryID, citationKey, pinned) VALUES (1, 'AAAA1111', 1, 'okaforFeedingCity2024', 1)").run();
    } finally {
      b.close();
    }
  }
  return { dir, db: dbPath, bbtDb, storagePdf, linkedPdf };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? "zotero-fixture";
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  console.log(buildZoteroFixture(out, { pdf, linkedPdf: pdf, linkedDir: join(out, "..", "linked") }));
}
