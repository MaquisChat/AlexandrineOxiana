/**
 * SQLite index (`library.sqlite`): schema, migrations, indexing and lookups. The files are the
 * record; this is a rebuildable cache.
 *
 * R30: for an encrypted project only manifest-level fields reach the persistent database. All other
 * content (titles, creators, extracted text, CJK bigrams, DOI/ISBN/platform/sha256 keys, collection
 * and tag names, consents ...) is written to the connection's in-memory TEMP schema (`t_*` tables,
 * `PRAGMA temp_store = MEMORY`) while the project is unlocked, and dropped on lock. TEMP views
 * (`v_*`) present both stores as one to `search` and `findSourceBy`.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { primary, type ConsentRecord, type Collection, type Participant, type Project, type Session, type SourceFile, type SourceType, type Tag } from "@ao/core";
import type { ReviewItemRow } from "../repo/review.js";
import { migrationsUrl } from "../resources.js";
import { cjkBigrams } from "./text.js";

export type IndexDb = Database.Database;

export const INDEX_FILE = "library.sqlite";

export interface SourceRow {
  id: string;
  projectId: string;
  type: SourceType;
  /** Primary title variant ("" while the source's project is locked). */
  title: string;
  creatorsText: string;
  issuedYear?: string;
  folder: string;
  needsReview: boolean;
  /** True while only manifest-level data is available (encrypted project, locked). */
  locked: boolean;
}

/** Owns the live connection so a rebuild can swap it; everything that writes must go through it. */
export class IndexHandle {
  private conn: IndexDb;
  constructor(readonly root: string) {
    this.conn = openIndex(root);
  }
  get db(): IndexDb {
    return this.conn;
  }
  get isOpen(): boolean {
    return this.conn.open;
  }
  close(): void {
    if (this.conn.open) this.conn.close();
  }
  /** Closes the current connection (if open) and opens `<root>/library.sqlite` again. */
  reopen(): IndexDb {
    this.close();
    this.conn = openIndex(this.root);
    return this.conn;
  }
}

/** Opens (creating and migrating if needed) `<root>/library.sqlite`. */
export function openIndex(root: string): IndexDb {
  return openIndexAt(join(root, INDEX_FILE));
}

/** Opens the index at an explicit path (rebuild uses a temporary file). */
export function openIndexAt(path: string): IndexDb {
  const db = new Database(path, { timeout: 1000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("secure_delete = ON");
    db.pragma("temp_store = MEMORY");
    migrate(db);
    db.exec(TEMP_SQL);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Throws unless a `wal_checkpoint(TRUNCATE)` fully succeeded. */
export function checkpointTruncate(db: IndexDb): void {
  const r = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  if (r[0] && r[0].busy !== 0) throw new Error("index checkpoint failed: the database is busy");
}

function migrationFiles(): Array<{ version: number; file: string }> {
  return readdirSync(migrationsUrl())
    .filter((f) => /^\d{4}\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), file: f }));
}

/** Applies pending migrations in order; each runs in a transaction and records `schemaVersion` in meta. */
function migrate(db: IndexDb): void {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get() !== undefined;
  const current = hasMeta ? Number(getMeta(db, "schemaVersion") ?? 0) : 0;
  for (const m of migrationFiles()) {
    if (m.version <= current) continue;
    const sql = readFileSync(new URL(m.file, migrationsUrl()), "utf8");
    db.transaction(() => {
      db.exec(sql);
      setMeta(db, "schemaVersion", String(m.version));
    })();
  }
}

export function getMeta(db: IndexDb, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: IndexDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------------------------------------------------------------------------------------------
// TEMP schema (in memory, per connection): content of unlocked encrypted projects.

const FTS_COLUMNS = `source_id UNINDEXED, project_id UNINDEXED, title_all, creators, container, extracted_text, cjk_bigrams,
  tokenize = 'unicode61 remove_diacritics 2'`;

const TEMP_SQL = `
CREATE TEMP TABLE IF NOT EXISTS t_sources (
  id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', creators_text TEXT NOT NULL DEFAULT '', issued_year TEXT, folder TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, platform TEXT, platform_post_id TEXT,
  doi TEXT, isbn13 TEXT, sha256s_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS temp.t_sources_project ON t_sources (project_id);
CREATE INDEX IF NOT EXISTS temp.t_sources_platform_post ON t_sources (platform, platform_post_id);
CREATE INDEX IF NOT EXISTS temp.t_sources_doi ON t_sources (doi);
CREATE TEMP TABLE IF NOT EXISTS t_source_hashes (source_id TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (source_id, sha256));
CREATE INDEX IF NOT EXISTS temp.t_source_hashes_sha ON t_source_hashes (sha256);
CREATE TEMP TABLE IF NOT EXISTS t_source_isbns (source_id TEXT NOT NULL, isbn13 TEXT NOT NULL, PRIMARY KEY (source_id, isbn13));
CREATE INDEX IF NOT EXISTS temp.t_source_isbns_isbn ON t_source_isbns (isbn13);
CREATE TEMP TABLE IF NOT EXISTS t_assets (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL, encrypted INTEGER NOT NULL
);
CREATE TEMP TABLE IF NOT EXISTS t_source_collections (source_id TEXT NOT NULL, collection_id TEXT NOT NULL, PRIMARY KEY (source_id, collection_id));
CREATE TEMP TABLE IF NOT EXISTS t_source_tags (source_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (source_id, tag_id));
CREATE TEMP TABLE IF NOT EXISTS t_collections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS t_tags (id TEXT NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL, color TEXT, project_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (id, project_id));
CREATE TEMP TABLE IF NOT EXISTS t_participants (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, code TEXT NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS t_sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, date TEXT NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS t_consents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, participant_id TEXT NOT NULL, scope TEXT NOT NULL, date TEXT NOT NULL,
  expires TEXT, withdrawn_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS temp.t_source_text USING fts5(${FTS_COLUMNS});

CREATE TEMP VIEW IF NOT EXISTS v_sources AS
  SELECT s.id, s.project_id, s.type,
         COALESCE(t.title, s.title) AS title, COALESCE(t.creators_text, s.creators_text) AS creators_text,
         s.issued_year, s.folder, COALESCE(t.needs_review, s.needs_review) AS needs_review,
         CASE WHEN s.locked = 1 AND t.id IS NULL THEN 1 ELSE 0 END AS locked
  FROM main.sources s LEFT JOIN temp.t_sources t ON t.id = s.id;
-- A tag id listed by several unlocked encrypted projects is one tag.
CREATE TEMP VIEW IF NOT EXISTS v_tags AS
  SELECT id, scope, name, color FROM main.tags
  UNION ALL SELECT id, MIN(scope), MIN(name), MIN(color) FROM temp.t_tags GROUP BY id;
CREATE TEMP VIEW IF NOT EXISTS v_hashes AS
  SELECT source_id, sha256 FROM main.source_hashes UNION ALL SELECT source_id, sha256 FROM temp.t_source_hashes;
CREATE TEMP VIEW IF NOT EXISTS v_isbns AS
  SELECT source_id, isbn13 FROM main.source_isbns UNION ALL SELECT source_id, isbn13 FROM temp.t_source_isbns;
CREATE TEMP VIEW IF NOT EXISTS v_source_collections AS
  SELECT source_id, collection_id FROM main.source_collections UNION ALL SELECT source_id, collection_id FROM temp.t_source_collections;
CREATE TEMP VIEW IF NOT EXISTS v_source_tags AS
  SELECT source_id, tag_id FROM main.source_tags UNION ALL SELECT source_id, tag_id FROM temp.t_source_tags;
`;

interface Store {
  sources: string;
  hashes: string;
  isbns: string;
  fts: string;
  assets: string;
  colls: string;
  tags: string;
  /** Pseudo-`main.`/`temp.` prefix for project-level tables. */
  collections: string;
  tagTable: string;
  participants: string;
  sessions: string;
  consents: string;
}
const MAIN: Store = {
  sources: "main.sources", hashes: "main.source_hashes", isbns: "main.source_isbns", fts: "main.source_text",
  assets: "main.assets", colls: "main.source_collections", tags: "main.source_tags", collections: "main.collections",
  tagTable: "main.tags", participants: "main.participants", sessions: "main.sessions", consents: "main.consents",
};
const TEMP: Store = {
  sources: "temp.t_sources", hashes: "temp.t_source_hashes", isbns: "temp.t_source_isbns", fts: "temp.t_source_text",
  assets: "temp.t_assets", colls: "temp.t_source_collections", tags: "temp.t_source_tags", collections: "temp.t_collections",
  tagTable: "temp.t_tags", participants: "temp.t_participants", sessions: "temp.t_sessions", consents: "temp.t_consents",
};

// ---------------------------------------------------------------------------------------------
// Normalisation of identifiers (used both when indexing and when looking up).

export function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();
}

/** ISBN-13 digits from a valid ISBN-10 or ISBN-13 (hyphens/spaces allowed); undefined when invalid. */
export function normalizeIsbn13(isbn: string): string | undefined {
  const s = isbn.replace(/[\s-]/g, "").toUpperCase();
  const check13 = (d: string) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
  };
  if (/^\d{13}$/.test(s)) return check13(s) === Number(s[12]) ? s : undefined;
  if (!/^\d{9}[\dX]$/.test(s)) return undefined;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  sum += s[9] === "X" ? 10 : Number(s[9]);
  if (sum % 11 !== 0) return undefined;
  const core = `978${s.slice(0, 9)}`;
  return `${core}${check13(core)}`;
}

function creatorName(c: { family?: string; given?: string; literal?: string; handle?: string }): string {
  if (c.family && c.given) return `${c.family}, ${c.given}`;
  return c.family || c.literal || c.handle || c.given || "";
}

function needsReview(sf: SourceFile): boolean {
  return Object.values(sf.verification).some((v) => v.status === "conflict" || v.status === "unverified");
}

// ---------------------------------------------------------------------------------------------
// Indexing

interface Detail {
  id: string;
  projectId: string;
  type: string;
  title: string;
  creatorsText: string;
  issuedYear: string | null;
  folder: string;
  needsReview: boolean;
  locked: boolean;
  platform: string | null;
  platformPostId: string | null;
  doi: string | null;
  isbns: string[];
  sha256s: string[];
}

function putSource(db: IndexDb, S: Store, d: Detail, fts: { titleAll: string; creators: string; container: string } | null, extractedText: string | undefined): void {
  const existing = db.prepare(`SELECT fts_rowid FROM ${S.sources} WHERE id = ?`).get(d.id) as { fts_rowid: number } | undefined;
  const ftsRowid =
    existing?.fts_rowid ?? (db.prepare(`SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS n FROM ${S.sources}`).get() as { n: number }).n;
  db.prepare(
    `INSERT INTO ${S.sources} (id, fts_rowid, project_id, type, title, creators_text, issued_year, folder, needs_review, locked,
        platform, platform_post_id, doi, isbn13, sha256s_json)
     VALUES (@id, @ftsRowid, @projectId, @type, @title, @creatorsText, @issuedYear, @folder, @needsReview, @locked,
        @platform, @platformPostId, @doi, @isbn13, @sha)
     ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, type=excluded.type, title=excluded.title,
        creators_text=excluded.creators_text, issued_year=excluded.issued_year, folder=excluded.folder,
        needs_review=excluded.needs_review, locked=excluded.locked, platform=excluded.platform,
        platform_post_id=excluded.platform_post_id, doi=excluded.doi, isbn13=excluded.isbn13,
        sha256s_json=excluded.sha256s_json`,
  ).run({
    ...d,
    ftsRowid,
    needsReview: d.needsReview ? 1 : 0,
    locked: d.locked ? 1 : 0,
    isbn13: d.isbns[0] ?? null,
    sha: JSON.stringify(d.sha256s),
  });
  db.prepare(`DELETE FROM ${S.hashes} WHERE source_id = ?`).run(d.id);
  for (const h of d.sha256s) db.prepare(`INSERT OR IGNORE INTO ${S.hashes} (source_id, sha256) VALUES (?, ?)`).run(d.id, h);
  db.prepare(`DELETE FROM ${S.isbns} WHERE source_id = ?`).run(d.id);
  for (const i of d.isbns) db.prepare(`INSERT OR IGNORE INTO ${S.isbns} (source_id, isbn13) VALUES (?, ?)`).run(d.id, i);

  const old = db.prepare(`SELECT extracted_text FROM ${S.fts} WHERE rowid = ?`).get(ftsRowid) as { extracted_text: string } | undefined;
  db.prepare(`DELETE FROM ${S.fts} WHERE rowid = ?`).run(ftsRowid);
  if (!fts) return;
  const extracted = extractedText ?? old?.extracted_text ?? "";
  const bigrams = cjkBigrams([fts.titleAll, fts.creators, fts.container, extracted].join("\n"));
  db.prepare(
    `INSERT INTO ${S.fts} (rowid, source_id, project_id, title_all, creators, container, extracted_text, cjk_bigrams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ftsRowid, d.id, d.projectId, fts.titleAll, fts.creators, fts.container, extracted, bigrams);
}

export interface IndexSourceOptions {
  /** The source belongs to an encrypted project (R30): only manifest-level fields go to the persistent DB. */
  protected?: boolean;
  /** With `protected`: also write the content to the in-memory TEMP schema (the project is unlocked). Default true. */
  withTemp?: boolean;
}

/** Indexes (or re-indexes) one source. `extractedText` undefined keeps any text indexed earlier. */
export function indexSource(db: IndexDb, sf: SourceFile, extractedText?: string, opts: IndexSourceOptions = {}): void {
  const s = sf.source;
  const projectId = s.projectIds[0] ?? "";
  // Destroyed files (retention, R92) are no longer duplicate keys: a re-import is not "already here".
  const destroyed = new Set(sf.assets.filter((a) => a.status === "destroyed").map((a) => a.id));
  const sha256s = [
    ...new Set(
      [...Object.entries(s.provenance.fileHashes).filter(([k]) => !destroyed.has(k)).map(([, h]) => h), ...sf.assets.filter((a) => !destroyed.has(a.id)).map((a) => a.sha256)].map((h) =>
        h.toLowerCase(),
      ),
    ),
  ];
  const isbns = [...new Set((s.identifiers.isbn ?? []).map(normalizeIsbn13).filter((x): x is string => x !== undefined))];
  const detail: Detail = {
    id: s.id,
    projectId,
    type: s.type,
    title: primary(s.title),
    creatorsText: s.creators.map(creatorName).filter(Boolean).join("; "),
    issuedYear: s.issued ? s.issued.slice(0, 4) : null,
    folder: s.folder,
    needsReview: needsReview(sf),
    locked: false,
    platform: s.identifiers.platform ?? null,
    platformPostId: s.identifiers.platformPostId ?? null,
    doi: s.identifiers.doi ? normalizeDoi(s.identifiers.doi) : null,
    isbns,
    sha256s,
  };
  const fts = {
    titleAll: s.title.variants.map((v) => v.value).join(" • "),
    creators: detail.creatorsText,
    container: s.container ? s.container.variants.map((v) => v.value).join(" • ") : "",
  };
  const prot = opts.protected === true;
  db.transaction(() => {
    const S = prot ? TEMP : MAIN;
    if (prot) {
      putSource(db, MAIN, manifestDetail(detail), null, undefined);
      if (opts.withTemp === false) {
        replaceMembership(db, s.id, s.projectIds, null);
        return;
      }
    }
    putSource(db, S, detail, fts, extractedText);
    db.prepare(`DELETE FROM ${S.assets} WHERE source_id = ?`).run(s.id);
    for (const a of sf.assets) {
      db.prepare(`INSERT OR REPLACE INTO ${S.assets} (id, source_id, role, kind, path, sha256, bytes, mime, encrypted) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        a.id, s.id, a.role, a.kind, a.path, a.sha256, a.bytes, a.mime, a.encrypted ? 1 : 0,
      );
    }
    replaceMembership(db, s.id, s.projectIds, { collectionIds: s.collectionIds, tagIds: s.tagIds, S });
  })();
}

function manifestDetail(d: Detail): Detail {
  return {
    ...d, title: "", creatorsText: "", needsReview: false, locked: true, platform: null, platformPostId: null, doi: null, isbns: [], sha256s: [],
  };
}

function replaceMembership(
  db: IndexDb,
  id: string,
  projectIds: string[],
  m: { collectionIds: string[]; tagIds: string[]; S: Store } | null,
): void {
  db.prepare("DELETE FROM main.source_projects WHERE source_id = ?").run(id);
  for (const p of projectIds) db.prepare("INSERT OR IGNORE INTO main.source_projects VALUES (?, ?)").run(id, p);
  if (!m) return;
  db.prepare(`DELETE FROM ${m.S.colls} WHERE source_id = ?`).run(id);
  for (const c of m.collectionIds) db.prepare(`INSERT OR IGNORE INTO ${m.S.colls} VALUES (?, ?)`).run(id, c);
  db.prepare(`DELETE FROM ${m.S.tags} WHERE source_id = ?`).run(id);
  for (const t of m.tagIds) db.prepare(`INSERT OR IGNORE INTO ${m.S.tags} VALUES (?, ?)`).run(id, t);
}

/** Indexes a source of a locked project from its manifest entry only: type and year, no titles, no text. */
export function indexLockedSource(
  db: IndexDb,
  e: { id: string; projectId: string; type: string; issuedYear?: string; folder: string },
): void {
  db.transaction(() => {
    putSource(
      db,
      MAIN,
      {
        id: e.id, projectId: e.projectId, type: e.type, title: "", creatorsText: "", issuedYear: e.issuedYear ?? null,
        folder: e.folder, needsReview: false, locked: true, platform: null, platformPostId: null, doi: null, isbns: [], sha256s: [],
      },
      null,
      undefined,
    );
    replaceMembership(db, e.id, [e.projectId], null);
  })();
}

function deleteSourceFrom(db: IndexDb, S: Store, id: string): void {
  const r = db.prepare(`SELECT fts_rowid FROM ${S.sources} WHERE id = ?`).get(id) as { fts_rowid: number } | undefined;
  if (r) db.prepare(`DELETE FROM ${S.fts} WHERE rowid = ?`).run(r.fts_rowid);
  for (const t of [S.sources, S.hashes, S.isbns, S.assets, S.colls, S.tags]) {
    db.prepare(`DELETE FROM ${t} WHERE ${t === S.sources ? "id" : "source_id"} = ?`).run(id);
  }
}

export function removeSource(db: IndexDb, id: string): void {
  db.transaction(() => {
    deleteSourceFrom(db, MAIN, id);
    deleteSourceFrom(db, TEMP, id);
    db.prepare("DELETE FROM main.source_projects WHERE source_id = ?").run(id);
  })();
}

/** Drops everything held in memory for an encrypted project (called when it is locked). */
export function purgeProject(db: IndexDb, projectId: string): void {
  db.transaction(() => {
    const ids = (db.prepare("SELECT id FROM temp.t_sources WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) deleteSourceFrom(db, TEMP, id);
    for (const t of ["t_collections", "t_participants", "t_sessions", "t_consents"]) {
      db.prepare(`DELETE FROM temp.${t} WHERE project_id = ?`).run(projectId);
    }
    // tags listed in the project's project.json go with it whatever their scope ('workspace' included)
    db.prepare("DELETE FROM temp.t_tags WHERE project_id = ?").run(projectId);
    // safety net: anything else still keyed by the project
    db.prepare("DELETE FROM temp.t_source_text WHERE project_id = ?").run(projectId);
  })();
}

export function indexProject(db: IndexDb, p: Project, locked = false): void {
  db.prepare(
    `INSERT INTO main.projects (id, name, folder, encrypted, locked, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, folder=excluded.folder, encrypted=excluded.encrypted,
       locked=excluded.locked, created_at=excluded.created_at`,
  ).run(p.id, p.name, p.folder, p.encryption.enabled ? 1 : 0, locked ? 1 : 0, p.createdAt);
}

/** Collections, tags and fieldwork records of a project: persistent when plain, TEMP when encrypted (R30). */
export function indexProjectEntities(
  db: IndexDb,
  data: { project: { id: string }; collections: Collection[]; tags: Tag[]; participants: Participant[]; sessions: Session[]; consents: ConsentRecord[] },
  prot: boolean,
): void {
  const S = prot ? TEMP : MAIN;
  db.transaction(() => {
    for (const c of data.collections) db.prepare(`INSERT OR REPLACE INTO ${S.collections} VALUES (?,?,?,?)`).run(c.id, c.projectId, c.parentId ?? null, c.name);
    for (const t of data.tags) {
      if (prot) db.prepare("INSERT OR REPLACE INTO temp.t_tags VALUES (?,?,?,?,?)").run(t.id, t.scope, t.name, t.color ?? null, data.project.id);
      else db.prepare(`INSERT OR REPLACE INTO ${S.tagTable} VALUES (?,?,?,?)`).run(t.id, t.scope, t.name, t.color ?? null);
    }
    for (const p of data.participants) db.prepare(`INSERT OR REPLACE INTO ${S.participants} VALUES (?,?,?)`).run(p.id, p.projectId, p.code);
    for (const s of data.sessions) db.prepare(`INSERT OR REPLACE INTO ${S.sessions} VALUES (?,?,?)`).run(s.id, s.projectId, s.date);
    for (const c of data.consents) {
      db.prepare(`INSERT OR REPLACE INTO ${S.consents} VALUES (?,?,?,?,?,?,?)`).run(c.id, c.projectId, c.participantId, c.scope, c.date, c.expires ?? null, c.withdrawn?.at ?? null);
    }
  })();
}

/** Inserts or replaces a review-queue row (a cache of `review/pending.jsonl`, R31). */
export function upsertReviewItem(db: IndexDb, row: ReviewItemRow): void {
  db.prepare("INSERT OR REPLACE INTO review_items (id, project_id, batch_id, source_id, kind, status, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
    row.id, row.projectId, row.batchId ?? null, row.sourceId ?? null, row.kind, row.status, JSON.stringify(row.payload), row.createdAt,
  );
}

// ---------------------------------------------------------------------------------------------
// Lookups

export type SourceQuery = { platform: string; postId: string } | { doi: string } | { isbn: string } | { sha256: string };

export const SOURCE_COLUMNS =
  "s.id, s.project_id, s.type, s.title, s.creators_text, s.issued_year, s.folder, s.needs_review, s.locked";

export interface RawRow {
  id: string;
  project_id: string;
  type: SourceType;
  title: string;
  creators_text: string;
  issued_year: string | null;
  folder: string;
  needs_review: number;
  locked: number;
}

export function toRow(r: RawRow): SourceRow {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    title: r.title,
    creatorsText: r.creators_text,
    ...(r.issued_year ? { issuedYear: r.issued_year } : {}),
    folder: r.folder,
    needsReview: r.needs_review === 1,
    locked: r.locked === 1,
  };
}

/** Finds sources by a stable external identifier (duplicate detection at import). */
export function findSourceBy(db: IndexDb, q: SourceQuery): SourceRow[] {
  let ids: string;
  let params: unknown[];
  if ("platform" in q) {
    ids = "SELECT id FROM main.sources WHERE platform = ? AND platform_post_id = ? UNION SELECT id FROM temp.t_sources WHERE platform = ? AND platform_post_id = ?";
    params = [q.platform, q.postId, q.platform, q.postId];
  } else if ("doi" in q) {
    const doi = normalizeDoi(q.doi);
    ids = "SELECT id FROM main.sources WHERE doi = ? UNION SELECT id FROM temp.t_sources WHERE doi = ?";
    params = [doi, doi];
  } else if ("isbn" in q) {
    const isbn = normalizeIsbn13(q.isbn);
    if (!isbn) return [];
    ids = "SELECT source_id FROM v_isbns WHERE isbn13 = ?";
    params = [isbn];
  } else {
    ids = "SELECT source_id FROM v_hashes WHERE sha256 = ?";
    params = [q.sha256.toLowerCase()];
  }
  const sql = `SELECT DISTINCT ${SOURCE_COLUMNS} FROM v_sources s WHERE s.id IN (${ids}) ORDER BY s.id`;
  return (db.prepare(sql).all(...params) as RawRow[]).map(toRow);
}

