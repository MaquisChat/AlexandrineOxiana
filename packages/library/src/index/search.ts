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
  //           ranked by the sum of each term's best rank.
  const recTerms = [...new Set(matchTerms(q.text!))];
  const annTerms = [...new Set(matchTerms(q.text!, "annotation_bigrams"))];
  if (recTerms.length > MAX_QUERY_TERMS) throw new InvalidInputError(`Use at most ${MAX_QUERY_TERMS} words in a search.`);
  if (recTerms.length > 1) {
    const cap = q.maxTermMatches ?? MAX_TERM_MATCHES;
    recTerms.forEach((t, i) => {
      if (termMatches(db, t, annTerms[i]!, cap) > cap) {
        throw new InvalidInputError("This search matches too many sources to combine its words. Use a more specific word, or fewer words.");
      }
    });
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const perTerm = recTerms
    .map(
      (_, i) => `SELECT ${i} AS t, source_id, bm25(source_text, ${RECORD_WEIGHTS}) AS r FROM source_text WHERE source_text MATCH ?
        UNION ALL SELECT ${i}, source_id, bm25(t_source_text, ${RECORD_WEIGHTS}) FROM t_source_text WHERE t_source_text MATCH ?
        UNION ALL SELECT ${i}, source_id, bm25(annotation_text) FROM annotation_text WHERE annotation_text MATCH ?
        UNION ALL SELECT ${i}, source_id, bm25(t_annotation_text) FROM t_annotation_text WHERE t_annotation_text MATCH ?`,
    )
    .join("\n        UNION ALL ");
  const hits = `
    WITH rec AS (
      SELECT source_id, MIN(rank) AS rank FROM (
        SELECT source_id, bm25(source_text, ${RECORD_WEIGHTS}) AS rank FROM source_text WHERE source_text MATCH ?
        UNION ALL SELECT source_id, bm25(t_source_text, ${RECORD_WEIGHTS}) AS rank FROM t_source_text WHERE t_source_text MATCH ?
      ) GROUP BY source_id
    ), th AS (
        ${perTerm}
    ), best AS (
      SELECT t, source_id, MIN(r) AS r FROM th GROUP BY t, source_id
    ), spread AS (
      SELECT source_id, SUM(r) AS rank FROM best GROUP BY source_id HAVING COUNT(*) = ${recTerms.length}
    ), hits AS (
      SELECT source_id, 0 AS tier, rank FROM rec
      UNION ALL SELECT source_id, 1 AS tier, rank FROM spread WHERE source_id NOT IN (SELECT source_id FROM rec)
    )`;
  const from = `hits h JOIN v_sources s ON s.id = h.source_id ${w}`;
  const args = [match, match, ...recTerms.flatMap((t, i) => [t, t, annTerms[i]!, annTerms[i]!]), ...params];
  const total = (db.prepare(`${hits} SELECT COUNT(*) AS n FROM ${from}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(`${hits} SELECT ${SOURCE_COLUMNS}, h.tier FROM ${from} ORDER BY h.tier, h.rank, s.id LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as Array<RawRow & { tier: number }>;
  return { total, items: rows.map((r) => (r.tier === 1 ? { ...toRow(r), matchedIn: "annotation" as const } : toRow(r))), ...incomplete(db) };
}

/** At most this many terms in one text search (each one is a set of matches to intersect). */
export const MAX_QUERY_TERMS = 16;
/** In a search of several terms, a term may match at most this many rows (records and annotation chunks). */
export const MAX_TERM_MATCHES = 50_000;

/** How many rows `t` matches in the record tables and `a` in the annotation tables, counting at most `cap` + 1. */
function termMatches(db: IndexDb, t: string, a: string, cap: number): number {
  let n = 0;
  for (const [table, expr] of [["source_text", t], ["t_source_text", t], ["annotation_text", a], ["t_annotation_text", a]] as const) {
    n += (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT ?)`).get(expr, cap + 1 - n) as { n: number }).n;
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
