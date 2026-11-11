-- Index schema v1. Everything here is a cache derived from the library's files and can be rebuilt
-- (review_items from review/pending.jsonl, jobs from jobs/journal.jsonl; import_batches was never
-- written and is dropped by 0002 - see docs/adr/0007-index.md).
--
-- Encrypted projects (R30): only manifest-level fields (id, type, issued_year, folder, project id,
-- locked flag) are stored here. Titles, creators, extracted text, dedupe keys, collection/tag names and
-- consent records of an encrypted project live only in the connection's in-memory TEMP schema (see
-- db.ts) while the project is unlocked.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  creators_text TEXT NOT NULL DEFAULT '',
  issued_year TEXT,
  folder TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  platform TEXT,
  platform_post_id TEXT,
  doi TEXT,
  isbn13 TEXT,
  sha256s_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX sources_project ON sources (project_id);
CREATE INDEX sources_platform_post ON sources (platform, platform_post_id);
CREATE INDEX sources_doi ON sources (doi);
CREATE INDEX sources_isbn13 ON sources (isbn13);

-- Every project a source belongs to (ids only; not identifying).
CREATE TABLE source_projects (
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (source_id, project_id)
);
CREATE INDEX source_projects_project ON source_projects (project_id);

-- All valid ISBNs of a source, normalised to ISBN-13.
CREATE TABLE source_isbns (
  source_id TEXT NOT NULL,
  isbn13 TEXT NOT NULL,
  PRIMARY KEY (source_id, isbn13)
);
CREATE INDEX source_isbns_isbn ON source_isbns (isbn13);

CREATE TABLE source_hashes (
  source_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (source_id, sha256)
);
CREATE INDEX source_hashes_sha256 ON source_hashes (sha256);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  encrypted INTEGER NOT NULL
);
CREATE INDEX assets_source ON assets (source_id);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT
);

CREATE TABLE source_collections (
  source_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  PRIMARY KEY (source_id, collection_id)
);
CREATE INDEX source_collections_collection ON source_collections (collection_id);

CREATE TABLE source_tags (
  source_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (source_id, tag_id)
);
CREATE INDEX source_tags_tag ON source_tags (tag_id);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  code TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  date TEXT NOT NULL
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  date TEXT NOT NULL,
  expires TEXT,
  withdrawn_at TEXT
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  batch_id TEXT,
  source_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'verification')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX review_items_status ON review_items (project_id, status);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Full-text index. rowid = sources.fts_rowid (stable; sources.rowid itself can change on VACUUM). cjk_bigrams holds character bigrams of
-- Han/Kana/Hangul runs (unicode61 does not segment them).
CREATE VIRTUAL TABLE source_text USING fts5(
  source_id UNINDEXED,
  project_id UNINDEXED,
  title_all,
  creators,
  container,
  extracted_text,
  cjk_bigrams,
  tokenize = 'unicode61 remove_diacritics 2'
);
