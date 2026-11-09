/** SQLite index (`library.sqlite`): schema, migrations, indexing and lookups. The files are the record; this is rebuildable. */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { primary, type Project, type SourceFile, type SourceType } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import type { IndexSink } from "../repo/state.js";
import { computeStamps, newestChangeId } from "./changes.js";
import { cjkBigrams } from "./text.js";

export type IndexDb = Database.Database;

export const INDEX_FILE = "library.sqlite";
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

export interface SourceRow {
  id: string;
  projectId: string;
  type: SourceType;
  /** Primary title variant ("" for sources of a locked project). */
  title: string;
  creatorsText: string;
  issuedYear?: string;
  folder: string;
  needsReview: boolean;
  locked: boolean;
}

/** Opens (creating and migrating if needed) `<root>/library.sqlite`. */
export function openIndex(root: string): IndexDb {
  return openIndexAt(join(root, INDEX_FILE));
}

/** Opens the index at an explicit path (rebuild uses a temporary file). */
export function openIndexAt(path: string): IndexDb {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function migrationFiles(): Array<{ version: number; file: string }> {
  return readdirSync(MIGRATIONS_DIR)
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
    const sql = readFileSync(new URL(m.file, MIGRATIONS_DIR), "utf8");
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
// Normalisation of identifiers (used both when indexing and when looking up).

export function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();
}

/** ISBN-13 digits from an ISBN-10 or ISBN-13 (hyphens/spaces allowed); undefined when not a valid-shaped ISBN. */
export function normalizeIsbn13(isbn: string): string | undefined {
  const s = isbn.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (!/^\d{9}[\dX]$/.test(s)) return undefined;
  const core = `978${s.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return `${core}${(10 - (sum % 10)) % 10}`;
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

interface FtsFields {
  titleAll: string;
  creators: string;
  container: string;
}

function writeSource(
  db: IndexDb,
  row: {
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
    isbn13: string | null;
    sha256s: string[];
  },
  fts: FtsFields | null,
  extractedText: string | undefined,
): void {
  const existing = db.prepare("SELECT fts_rowid FROM sources WHERE id = ?").get(row.id) as { fts_rowid: number } | undefined;
  const ftsRowid =
    existing?.fts_rowid ?? (db.prepare("SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS n FROM sources").get() as { n: number }).n;
  db.prepare(
    `INSERT INTO sources (id, fts_rowid, project_id, type, title, creators_text, issued_year, folder, needs_review, locked,
        platform, platform_post_id, doi, isbn13, sha256s_json)
     VALUES (@id, @ftsRowid, @projectId, @type, @title, @creatorsText, @issuedYear, @folder, @needsReview, @locked,
        @platform, @platformPostId, @doi, @isbn13, @sha)
     ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, type=excluded.type, title=excluded.title,
        creators_text=excluded.creators_text, issued_year=excluded.issued_year, folder=excluded.folder,
        needs_review=excluded.needs_review, locked=excluded.locked, platform=excluded.platform,
        platform_post_id=excluded.platform_post_id, doi=excluded.doi, isbn13=excluded.isbn13,
        sha256s_json=excluded.sha256s_json`,
  ).run({
    ...row,
    ftsRowid,
    needsReview: row.needsReview ? 1 : 0,
    locked: row.locked ? 1 : 0,
    sha: JSON.stringify(row.sha256s),
  });
  db.prepare("DELETE FROM source_hashes WHERE source_id = ?").run(row.id);
  const addHash = db.prepare("INSERT OR IGNORE INTO source_hashes (source_id, sha256) VALUES (?, ?)");
  for (const h of row.sha256s) addHash.run(row.id, h);

  // Text of a locked project is never indexed: its sources have no FTS row at all.
  const old = db.prepare("SELECT extracted_text FROM source_text WHERE rowid = ?").get(ftsRowid) as
    | { extracted_text: string }
    | undefined;
  db.prepare("DELETE FROM source_text WHERE rowid = ?").run(ftsRowid);
  if (!fts) return;
  const extracted = extractedText ?? old?.extracted_text ?? "";
  const bigrams = cjkBigrams([fts.titleAll, fts.creators, fts.container, extracted].join("\n"));
  db.prepare(
    `INSERT INTO source_text (rowid, source_id, project_id, title_all, creators, container, extracted_text, cjk_bigrams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ftsRowid, row.id, row.projectId, fts.titleAll, fts.creators, fts.container, extracted, bigrams);
}

/** Indexes (or re-indexes) one source. `extractedText` undefined keeps any text indexed earlier. */
export function indexSource(db: IndexDb, sf: SourceFile, extractedText?: string): void {
  const s = sf.source;
  const projectId = s.projectIds[0] ?? "";
  const sha256s = [...new Set([...Object.values(s.provenance.fileHashes), ...sf.assets.map((a) => a.sha256)])];
  const isbn = (s.identifiers.isbn ?? []).map(normalizeIsbn13).find((x) => x !== undefined) ?? null;
  const titleAll = s.title.variants.map((v) => v.value).join(" • ");
  const creatorsText = s.creators.map(creatorName).filter(Boolean).join("; ");
  const container = s.container ? s.container.variants.map((v) => v.value).join(" • ") : "";
  db.transaction(() => {
    writeSource(
      db,
      {
        id: s.id,
        projectId,
        type: s.type,
        title: primary(s.title),
        creatorsText,
        issuedYear: s.issued ? s.issued.slice(0, 4) : null,
        folder: s.folder,
        needsReview: needsReview(sf),
        locked: false,
        platform: s.identifiers.platform ?? null,
        platformPostId: s.identifiers.platformPostId ?? null,
        doi: s.identifiers.doi ? normalizeDoi(s.identifiers.doi) : null,
        isbn13: isbn,
        sha256s,
      },
      { titleAll, creators: creatorsText, container },
      extractedText,
    );
    db.prepare("DELETE FROM assets WHERE source_id = ?").run(s.id);
    const addAsset = db.prepare(
      "INSERT OR REPLACE INTO assets (id, source_id, role, kind, path, sha256, bytes, mime, encrypted) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    for (const a of sf.assets) addAsset.run(a.id, s.id, a.role, a.kind, a.path, a.sha256, a.bytes, a.mime, a.encrypted ? 1 : 0);
    db.prepare("DELETE FROM source_collections WHERE source_id = ?").run(s.id);
    for (const c of s.collectionIds) db.prepare("INSERT OR IGNORE INTO source_collections VALUES (?, ?)").run(s.id, c);
    db.prepare("DELETE FROM source_tags WHERE source_id = ?").run(s.id);
    for (const t of s.tagIds) db.prepare("INSERT OR IGNORE INTO source_tags VALUES (?, ?)").run(s.id, t);
  })();
}

/** Indexes a source of a locked project from its manifest entry only: type and year, no titles, no text. */
export function indexLockedSource(
  db: IndexDb,
  e: { id: string; projectId: string; type: string; issuedYear?: string; folder: string },
): void {
  db.transaction(() => {
    writeSource(
      db,
      {
        id: e.id,
        projectId: e.projectId,
        type: e.type,
        title: "",
        creatorsText: "",
        issuedYear: e.issuedYear ?? null,
        folder: e.folder,
        needsReview: false,
        locked: true,
        platform: null,
        platformPostId: null,
        doi: null,
        isbn13: null,
        sha256s: [],
      },
      null,
      undefined,
    );
  })();
}

export function removeSource(db: IndexDb, id: string): void {
  db.transaction(() => {
    const r = db.prepare("SELECT fts_rowid FROM sources WHERE id = ?").get(id) as { fts_rowid: number } | undefined;
    if (r) db.prepare("DELETE FROM source_text WHERE rowid = ?").run(r.fts_rowid);
    for (const t of ["sources", "source_hashes", "assets", "source_collections", "source_tags"]) {
      db.prepare(`DELETE FROM ${t} WHERE ${t === "sources" ? "id" : "source_id"} = ?`).run(id);
    }
  })();
}

export function indexProject(db: IndexDb, p: Project, locked = false): void {
  db.prepare(
    `INSERT INTO projects (id, name, folder, encrypted, locked, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, folder=excluded.folder, encrypted=excluded.encrypted,
       locked=excluded.locked, created_at=excluded.created_at`,
  ).run(p.id, p.name, p.folder, p.encryption.enabled ? 1 : 0, locked ? 1 : 0, p.createdAt);
}

/**
 * An {@link IndexSink} over the index. Pass `ctx` (the library root and key ring) to also keep
 * `meta.lastChangeId` and the per-project stamps current after every operation, so `isIndexStale`
 * stays false while the repository is the only writer.
 */
export function createIndexSink(db: IndexDb, ctx?: { root: string; keyRing: KeyRing }): IndexSink {
  const stamp = async () => {
    if (!ctx) return;
    await recordStamps(db, ctx.root, ctx.keyRing);
  };
  return {
    async indexSource(sf, extractedText) {
      indexSource(db, sf, extractedText);
      await stamp();
    },
    async removeSource(id) {
      removeSource(db, id);
      await stamp();
    },
    async indexProject(p) {
      indexProject(db, p);
      await stamp();
    },
  };
}

/** Records the newest change id (`lastChangeId`) and per-project stamps into meta. */
export async function recordStamps(db: IndexDb, root: string, keyRing: KeyRing): Promise<void> {
  const stamps = await computeStamps(root, keyRing);
  setMeta(db, "projectStamps", JSON.stringify(stamps));
  setMeta(db, "lastChangeId", newestChangeId(stamps) ?? "");
}

// ---------------------------------------------------------------------------------------------
// Lookups

export type SourceQuery = { platform: string; postId: string } | { doi: string } | { isbn: string } | { sha256: string };

export const SOURCE_COLUMNS =
  "s.id, s.project_id, s.type, s.title, s.creators_text, s.issued_year, s.folder, s.needs_review, s.locked";

interface RawRow {
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
  let sql: string;
  let params: unknown[];
  if ("platform" in q) {
    sql = `SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.platform = ? AND s.platform_post_id = ?`;
    params = [q.platform, q.postId];
  } else if ("doi" in q) {
    sql = `SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.doi = ?`;
    params = [normalizeDoi(q.doi)];
  } else if ("isbn" in q) {
    const isbn = normalizeIsbn13(q.isbn);
    if (!isbn) return [];
    sql = `SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.isbn13 = ?`;
    params = [isbn];
  } else {
    sql = `SELECT DISTINCT ${SOURCE_COLUMNS} FROM sources s JOIN source_hashes h ON h.source_id = s.id WHERE h.sha256 = ?`;
    params = [q.sha256.toLowerCase()];
  }
  return (db.prepare(`${sql} ORDER BY s.id`).all(...params) as RawRow[]).map(toRow);
}
