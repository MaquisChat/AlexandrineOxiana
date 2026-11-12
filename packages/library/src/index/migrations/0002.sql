-- Index schema v2 (Task 58, R74, R161): the text of a source's annotations (quoted text and
-- comment, e.g. imported from Zotero) is searchable.
--
-- Annotations have their own full-text table, apart from the source's record: a heavily annotated
-- source does not lose rank for its title (bm25 normalises by row length), and a change to the
-- record never rewrites its annotations. At most 2 MB (UTF-8) of a source's annotation text is
-- indexed, in document order, in rows ("chunks") of at most 64 KB; `annotation_chunks` keeps each
-- chunk's rowid and hash so a write rewrites only the chunks that changed (R161 b).
-- `sources.annotations_partial` = 1 when only part of the source's annotations is indexed.
-- For encrypted projects these rows live only in the in-memory TEMP schema (R30; see db.ts).
CREATE VIRTUAL TABLE annotation_text USING fts5(
  source_id UNINDEXED,
  project_id UNINDEXED,
  annotations,
  annotation_bigrams,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE annotation_chunks (
  source_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  fts_rowid INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (source_id, seq)
);
CREATE INDEX annotation_chunks_rowid ON annotation_chunks (fts_rowid);
ALTER TABLE sources ADD COLUMN annotations_partial INTEGER NOT NULL DEFAULT 0;

-- An index that already holds sources was built without their annotations: it is marked as needing
-- a rebuild (R161 a). Only a completed rebuild clears the mark (a rebuild writes a new file, made
-- by these migrations while it is empty); ordinary writes never do. While it is set the index
-- counts as stale and search answers say the index is incomplete.
INSERT INTO meta (key, value) SELECT 'needsRebuild', 'annotations' WHERE EXISTS (SELECT 1 FROM sources);
