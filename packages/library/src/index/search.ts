/** Multilingual full-text search over the index (persistent store plus the in-memory store of unlocked encrypted projects). */
import type { SourceType } from "@ao/core";
import { SOURCE_COLUMNS, getMeta, toRow, type IndexDb, type RawRow, type SourceRow } from "./db.js";
import { InvalidInputError } from "../repo/errors.js";
import { buildMatchQuery, matchTerms } from "./text.js";

export interface SearchQuery {
  text?: string;
  projectId?: string;
  types?: SourceType[];
  collectionId?: string;
  /** Sources carrying ALL of these tags. */
  tagIds?: string[];
  limit?: number;
  offset?: number;
  /** The bound on each term's matches in a search of several terms (default MAX_TERM_MATCHES). */
  maxTermMatches?: number;
}

/**
 * A page of sources. `incomplete`: the index is awaiting a rebuild (R161 a), so some content
 * (annotation text) is not searchable yet; the interface says so.
 */
export interface SearchResult {
  total: number;
  items: SourceRow[];
  incomplete?: true;
}

// The FTS tables are named unqualified (source_text, t_source_text, annotation_text,
// t_annotation_text) so MATCH and bm25() can refer to them.
export function search(db: IndexDb, q: SearchQuery): SearchResult {
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
    return { total, items: rows.map(toRow), ...incomplete(db) };
  }

  // Text query over both stores, matched term by term (N1). A source matches when every term is
  // in its record or in its annotations, wherever each one is: one term in the title and another
  // in a highlight, or two terms in two annotations, whatever chunk each was stored in. A CJK run
  // is one phrase term, found within one field or one annotation (a split annotation's parts
  // overlap, so a phrase across the split is found too). Only source ids and ranks are handled.
  //   tier 0: the record alone holds every term (ranked by bm25 with column weights: title, then
  //           creators and container, then body text and bigrams);
  //   tier 1: the record and the annotations together ("found in an annotation"), after them,
  //           ranked by the best rank of the rarest term.
  // Speed (N5): every per-term look-up is limited to the searched project inside the query; the
  // candidates are the intersection of the terms' id sets (rarest first, ids only, no ranks), and
  // ranks are computed for the candidates alone, once, with the count in the same query.
  const recTerms = [...new Set(matchTerms(q.text!))];
  const annTerms = [...new Set(matchTerms(q.text!, "annotation_bigrams"))];
  if (recTerms.length > MAX_QUERY_TERMS) throw new InvalidInputError(`Use at most ${MAX_QUERY_TERMS} words in a search.`);
  // A matching row's source is found through its rowid (sources.fts_rowid, annotation_chunks), never
  // by reading the FTS row's own columns, which would read its text.
  const scope = q.projectId ? " AND x.id IN (SELECT source_id FROM main.source_projects WHERE project_id = ?)" : "";
  const scopeArgs = q.projectId ? [q.projectId] : [];
  const FROM = {
    rec: `source_text JOIN (SELECT id, fts_rowid FROM main.sources) x ON x.fts_rowid = source_text.rowid WHERE source_text MATCH ?`,
    tRec: `t_source_text JOIN (SELECT id, fts_rowid FROM temp.t_sources) x ON x.fts_rowid = t_source_text.rowid WHERE t_source_text MATCH ?`,
    ann: `annotation_text JOIN (SELECT source_id AS id, fts_rowid FROM main.annotation_chunks) x ON x.fts_rowid = annotation_text.rowid WHERE annotation_text MATCH ?`,
    tAnn: `t_annotation_text JOIN (SELECT source_id AS id, fts_rowid FROM temp.t_annotation_chunks) x ON x.fts_rowid = t_annotation_text.rowid WHERE t_annotation_text MATCH ?`,
  };
  /** Ids of the sources a term matches in the record or the annotations (both stores), in scope. */
  const idSet = `SELECT x.id FROM ${FROM.rec}${scope}
      UNION SELECT x.id FROM ${FROM.tRec}${scope}
      UNION SELECT x.id FROM ${FROM.ann}${scope}
      UNION SELECT x.id FROM ${FROM.tAnn}${scope}`;
  const idSetArgs = (i: number) => [recTerms[i]!, ...scopeArgs, recTerms[i]!, ...scopeArgs, annTerms[i]!, ...scopeArgs, annTerms[i]!, ...scopeArgs];
  let order = recTerms.map((_, i) => i);
  if (recTerms.length > 1) {
    // The bound counts the searched project's matches only (N6); it also orders the terms, rarest first.
    const cap = q.maxTermMatches ?? MAX_TERM_MATCHES;
    const counts = recTerms.map((t, i) => termMatches(db, [[FROM.rec, t], [FROM.tRec, t], [FROM.ann, annTerms[i]!], [FROM.tAnn, annTerms[i]!]], cap, scope, scopeArgs));
    if (counts.some((n) => n === 0)) return { total: 0, items: [], ...incomplete(db) }; // a term found nowhere: nothing to combine
    if (counts.some((n) => n > cap)) {
      throw new InvalidInputError("This search matches too many sources to combine its words. Use a more specific word, or fewer words.");
    }
    order = order.sort((a, b) => counts[a]! - counts[b]!);
  }
  const rarest = order[0]!;
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    WITH cand AS MATERIALIZED (
      ${order.map(() => `SELECT id AS source_id FROM (${idSet})`).join("\n      INTERSECT ")}
    ), rec AS (
      SELECT source_id, MIN(rank) AS rank FROM (
        SELECT x.id AS source_id, bm25(source_text, ${RECORD_WEIGHTS}) AS rank FROM ${FROM.rec} AND x.id IN cand
        UNION ALL SELECT x.id, bm25(t_source_text, ${RECORD_WEIGHTS}) FROM ${FROM.tRec} AND x.id IN cand
      ) GROUP BY source_id
    ), ann AS (
      SELECT source_id, MIN(rank) AS rank FROM (
        SELECT x.id AS source_id, bm25(annotation_text) AS rank FROM ${FROM.ann} AND x.id IN cand
        UNION ALL SELECT x.id, bm25(t_annotation_text) FROM ${FROM.tAnn} AND x.id IN cand
      ) GROUP BY source_id
    ), hits AS (
      SELECT source_id, 0 AS tier, rank FROM rec
      UNION ALL SELECT c.source_id, 1 AS tier, COALESCE(a.rank, 0) FROM cand c LEFT JOIN ann a ON a.source_id = c.source_id
        WHERE c.source_id NOT IN (SELECT source_id FROM rec)
    )
    SELECT ${SOURCE_COLUMNS}, h.tier, COUNT(*) OVER () AS total
    FROM hits h JOIN v_sources s ON s.id = h.source_id ${w}
    ORDER BY h.tier, h.rank, s.id LIMIT ? OFFSET ?`;
  const args = [...order.flatMap(idSetArgs), match, match, annTerms[rarest]!, annTerms[rarest]!, ...params];
  const rows = db.prepare(sql).all(...args, limit, offset) as Array<RawRow & { tier: number; total: number }>;
  let total = rows[0]?.total;
  if (total === undefined) {
    // A page past the end: count without a page.
    total = offset === 0 ? 0 : (db.prepare(sql.replace(/ORDER BY h\.tier[^]*$/u, "LIMIT 1")).get(...args) as { total: number } | undefined)?.total ?? 0;
  }
  return { total, items: rows.map((r) => (r.tier === 1 ? { ...toRow(r), matchedIn: "annotation" as const } : toRow(r))), ...incomplete(db) };
}

/** At most this many terms in one text search (each one is a set of matches to intersect). */
export const MAX_QUERY_TERMS = 16;
/** In a search of several terms, a term may match at most this many rows (records and annotation chunks). */
export const MAX_TERM_MATCHES = 50_000;

/** How many rows a term matches in the four tables (`[from, expression]`), in scope, counting at most `cap` + 1. */
function termMatches(db: IndexDb, tables: Array<[string, string]>, cap: number, scope: string, scopeArgs: string[]): number {
  let n = 0;
  for (const [from, expr] of tables) {
    n += (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${from}${scope} LIMIT ?)`).get(expr, ...scopeArgs, cap + 1 - n) as { n: number }).n;
    if (n > cap) break;
  }
  return n;
}

/** Weights of source_text's columns for bm25: source_id, project_id, title_all, creators, container, extracted_text, cjk_bigrams. */
const RECORD_WEIGHTS = "0, 0, 10, 4, 4, 1, 1";

/** R161 (a): while the index awaits a rebuild (an older index was migrated) every answer says so. */
function incomplete(db: IndexDb): { incomplete?: true } {
  return getMeta(db, "needsRebuild") !== undefined ? { incomplete: true } : {};
}
