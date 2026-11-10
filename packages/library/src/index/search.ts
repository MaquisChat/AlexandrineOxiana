/** Multilingual full-text search over the index (persistent store plus the in-memory store of unlocked encrypted projects). */
import type { SourceType } from "@ao/core";
import { SOURCE_COLUMNS, toRow, type IndexDb, type RawRow, type SourceRow } from "./db.js";
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

/** The two FTS tables; names are unqualified so MATCH and bm25() can refer to them. */
const FTS_TABLES = ["source_text", "t_source_text"] as const;

export function search(db: IndexDb, q: SearchQuery): { total: number; items: SourceRow[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.projectId) {
    where.push("EXISTS (SELECT 1 FROM main.source_projects p WHERE p.source_id = s.id AND p.project_id = ?)");
    params.push(q.projectId);
  }
  if (q.types && q.types.length > 0) {
    where.push(`s.type IN (${q.types.map(() => "?").join(",")})`);
    params.push(...q.types);
  }
  if (q.collectionId) {
    where.push("EXISTS (SELECT 1 FROM v_source_collections c WHERE c.source_id = s.id AND c.collection_id = ?)");
    params.push(q.collectionId);
  }
  for (const t of new Set(q.tagIds ?? [])) {
    where.push("EXISTS (SELECT 1 FROM v_source_tags g WHERE g.source_id = s.id AND g.tag_id = ?)");
    params.push(t);
  }
  const limit = Math.max(0, Math.floor(q.limit ?? 50));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const match = q.text ? buildMatchQuery(q.text) : undefined;

  if (!match) {
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM v_sources s ${w}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM v_sources s ${w} ORDER BY s.title COLLATE NOCASE, s.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RawRow[];
    return { total, items: rows.map(toRow) };
  }

  // Text query: ask each store for its best offset+limit matches, then merge by relevance.
  let total = 0;
  const merged: Array<{ rank: number; row: RawRow }> = [];
  for (const fts of FTS_TABLES) {
    const w = ["", ...where.map((c) => `AND ${c}`)].join(" ");
    const from = `${fts} JOIN v_sources s ON s.id = ${fts}.source_id WHERE ${fts} MATCH ? ${w}`;
    total += (db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get(match, ...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT ${SOURCE_COLUMNS}, bm25(${fts}) AS rank FROM ${from} ORDER BY rank, s.id LIMIT ?`)
      .all(match, ...params, offset + limit) as Array<RawRow & { rank: number }>;
    for (const r of rows) merged.push({ rank: r.rank, row: r });
  }
  merged.sort((a, b) => a.rank - b.rank || (a.row.id < b.row.id ? -1 : 1));
  return { total, items: merged.slice(offset, offset + limit).map((m) => toRow(m.row)) };
}
