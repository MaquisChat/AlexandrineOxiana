-- Index schema v2 (Task 58, R74): the text of a source's annotations (quoted text and comment, e.g.
-- imported from Zotero) is searchable. FTS5 tables cannot gain columns, so source_text is made
-- again with two more and its rows copied over (rowids kept). `annotations` holds the text,
-- `annotation_bigrams` its CJK bigrams (kept apart from `cjk_bigrams` so a search can tell whether
-- a source matched through its annotations). For encrypted projects nothing changes here: their
-- rows are only in the in-memory TEMP schema (R30).
--
-- Rows written before this version have no annotation text, so the recorded per-project stamps are
-- dropped: the index then counts as out of date and is rebuilt from the files when the library is
-- next opened (and the rebuild fills the new columns).
CREATE VIRTUAL TABLE source_text_v2 USING fts5(
  source_id UNINDEXED,
  project_id UNINDEXED,
  title_all,
  creators,
  container,
  extracted_text,
  cjk_bigrams,
  annotations,
  annotation_bigrams,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO source_text_v2 (rowid, source_id, project_id, title_all, creators, container, extracted_text, cjk_bigrams, annotations, annotation_bigrams)
  SELECT rowid, source_id, project_id, title_all, creators, container, extracted_text, cjk_bigrams, '', '' FROM source_text;
DROP TABLE source_text;
ALTER TABLE source_text_v2 RENAME TO source_text;
DELETE FROM meta WHERE key = 'projectStamps';
