/** Multilingual full-text search over the index. */
import type { SourceType } from "@ao/core";
import { SOURCE_COLUMNS, toRow, type IndexDb, type SourceRow } from "./db.js";
import { buildMatchQuery } from "./text.js";

export interface SearchQuery {
  text?: string;
  projectId?: string;
  types?: SourceType[];
  collectionId?: string;
  /** Sources carrying ALL of these tags. */
  tagIds?: string[];
  limit?: number;
  offset?: number;
}

export function search(db: IndexDb, q: SearchQuery): { total: number; items: SourceRow[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const match = q.text ? buildMatchQuery(q.text) : undefined;
  let from = "sources s";
  if (match) {
    from = "source_text JOIN sources s ON s.fts_rowid = source_text.rowid";
    where.push("source_text MATCH ?");
    params.push(match);
  }
  if (q.projectId) {
    where.push("s.project_id = ?");
    params.push(q.projectId);
  }
  if (q.types && q.types.length > 0) {
    where.push(`s.type IN (${q.types.map(() => "?").join(",")})`);
    params.push(...q.types);
  }
  if (q.collectionId) {
    where.push("EXISTS (SELECT 1 FROM source_collections c WHERE c.source_id = s.id AND c.collection_id = ?)");
    params.push(q.collectionId);
  }
  const tags = [...new Set(q.tagIds ?? [])];
  for (const t of tags) {
    where.push("EXISTS (SELECT 1 FROM source_tags g WHERE g.source_id = s.id AND g.tag_id = ?)");
    params.push(t);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${w}`).get(...params) as { n: number }).n;
  const order = match ? "ORDER BY bm25(source_text), s.id" : "ORDER BY s.title COLLATE NOCASE, s.id";
  const limit = Math.max(0, Math.floor(q.limit ?? 50));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const rows = db
    .prepare(`SELECT ${SOURCE_COLUMNS} FROM ${from} ${w} ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Parameters<typeof toRow>[0][];
  return { total, items: rows.map(toRow) };
}
