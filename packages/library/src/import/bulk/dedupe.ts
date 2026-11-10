/**
 * Duplicate detection for a batch against the index's dedupe keys (R59, R30) plus an in-batch key
 * set, never by reading every source per item:
 *
 *   - same file (SHA-256), same DOI, same ISBN: indexed lookups (`findSourceBy`; the TEMP schema
 *     holds an unlocked encrypted project's keys) restricted to the project's live sources;
 *   - fuzzy (title + first creator + year): the project's title/creator/year keys are read from the
 *     index once per batch into buckets by (first creator, year), so each item compares only with
 *     its bucket and the neighbouring years;
 *   - every source the batch creates or merges into is added to the in-batch keys at once, so two
 *     identical files in one batch give one created source and one duplicate even before the index
 *     catches up.
 */
import { normalizeTitle, primary, toIsbn13, type DupKey, type SourceFile } from "@ao/core";
import { findSourceBy, normalizeDoi, type IndexDb } from "../../index/db.js";

type Existing = DupKey & { sourceId: string };

const familyOf = (creatorsText: string) => creatorsText.split(";")[0]!.split(",")[0]!.trim();
const bucketKey = (family: string, year: number) => `${normalizeTitle(family)}|${year}`;
const yearOf = (y: string | undefined) => {
  const m = y?.match(/\d{4}/);
  return m ? Number(m[0]) : null;
};

export class BatchDedupe {
  private readonly sha = new Map<string, string>();
  private readonly doi = new Map<string, string>();
  private readonly isbn = new Map<string, string>();
  private buckets: Map<string, Existing[]> | null = null;
  /** Fuzzy keys of sources added before the buckets were loaded. */
  private readonly early: Existing[] = [];

  /** Placeholders of sources queued but not stored yet. */
  private readonly live = new Set<string>();

  constructor(
    private readonly db: IndexDb,
    private readonly projectId: string,
    /** Whether the project has the source now: sources added during the batch (e.g. dropped files) count too. */
    private readonly exists: (id: string) => boolean,
  ) {}

  private alive(id: string): boolean {
    return id.startsWith("pending:") ? this.live.has(id) : this.exists(id);
  }

  /** Exact keys come from the index on every lookup, so they include sources added meanwhile by anyone. */
  private indexed(q: Parameters<typeof findSourceBy>[1]): string | undefined {
    for (const row of findSourceBy(this.db, q)) if (this.alive(row.id)) return row.id;
    return undefined;
  }

  /** The source holding a file with this SHA-256, if any. */
  bySha(sha256: string): string | undefined {
    const h = sha256.toLowerCase();
    const inBatch = this.sha.get(h);
    if (inBatch && this.alive(inBatch)) return inBatch;
    return this.indexed({ sha256: h });
  }

  private loadBuckets(): Map<string, Existing[]> {
    if (this.buckets) return this.buckets;
    const rows = this.db
      .prepare(
        `SELECT id, title, creators_text, issued_year, doi, isbn13 FROM main.sources WHERE project_id = ? AND locked = 0
         UNION ALL SELECT id, title, creators_text, issued_year, doi, isbn13 FROM temp.t_sources WHERE project_id = ?`,
      )
      .all(this.projectId, this.projectId) as Array<{ id: string; title: string; creators_text: string; issued_year: string | null; doi: string | null; isbn13: string | null }>;
    this.buckets = new Map();
    const loaded = new Set<string>();
    for (const r of rows) {
      loaded.add(r.id);
      if (!this.alive(r.id)) continue;
      this.put({
        sourceId: r.id,
        sha256s: [],
        ...(r.title ? { title: r.title } : {}),
        ...(familyOf(r.creators_text) ? { firstCreatorFamily: familyOf(r.creators_text) } : {}),
        ...(r.issued_year ? { year: r.issued_year } : {}),
        ...(r.doi ? { doi: r.doi } : {}),
        ...(r.isbn13 ? { isbns: [r.isbn13] } : {}),
      });
    }
    for (const e of this.early) if (!loaded.has(e.sourceId) && this.alive(e.sourceId)) this.put(e);
    this.early.length = 0;
    return this.buckets;
  }

  private put(e: Existing): void {
    const y = yearOf(e.year);
    if (!this.buckets || !e.title || !e.firstCreatorFamily || y === null) return;
    const k = bucketKey(e.firstCreatorFamily, y);
    const list = this.buckets.get(k) ?? [];
    list.push(e);
    this.buckets.set(k, list);
  }

  /** The existing sources a candidate could duplicate (to pass to `findDuplicate`). */
  candidates(c: DupKey): Existing[] {
    const out: Existing[] = [];
    const seen = new Set<string>();
    const add = (id: string | undefined, e: Omit<Existing, "sourceId">) => {
      if (!id || !this.alive(id) || seen.has(`${id}|${e.doi ?? ""}|${e.isbns?.[0] ?? ""}|${e.title ?? ""}`)) return;
      seen.add(`${id}|${e.doi ?? ""}|${e.isbns?.[0] ?? ""}|${e.title ?? ""}`);
      out.push({ sourceId: id, ...e });
    };
    for (const h of c.sha256s) add(this.bySha(h), { sha256s: [h] });
    if (c.doi) {
      const d = normalizeDoi(c.doi);
      const inBatch = this.doi.get(d);
      add(inBatch && this.alive(inBatch) ? inBatch : this.indexed({ doi: d }), { sha256s: [], doi: d });
    }
    for (const i of c.isbns ?? []) {
      const v = toIsbn13(i);
      if (!v) continue;
      const inBatch = this.isbn.get(v);
      add(inBatch && this.alive(inBatch) ? inBatch : this.indexed({ isbn: v }), { sha256s: [], isbns: [v] });
    }
    const y = yearOf(c.year);
    if (c.title && c.firstCreatorFamily && y !== null) {
      const buckets = this.loadBuckets();
      for (const yy of [y - 1, y, y + 1]) for (const e of buckets.get(bucketKey(c.firstCreatorFamily, yy)) ?? []) if (this.alive(e.sourceId)) out.push(e);
    }
    return out;
  }

  /**
   * A source queued to be created (not stored yet): found as `placeholder` until `dropPending`.
   * The caller stores the queue before trusting a match against a placeholder.
   */
  addPending(placeholder: string, k: DupKey): void {
    this.live.add(placeholder);
    for (const h of k.sha256s) this.sha.set(h.toLowerCase(), placeholder);
    if (k.doi) this.doi.set(normalizeDoi(k.doi), placeholder);
    for (const i of k.isbns ?? []) {
      const v = toIsbn13(i);
      if (v) this.isbn.set(v, placeholder);
    }
    const e: Existing = { sourceId: placeholder, ...k, sha256s: [] };
    if (this.buckets) this.put(e);
    else this.early.push(e);
  }

  /** Placeholders stop matching (their sources were stored, or not). */
  dropPending(placeholders: Iterable<string>): void {
    for (const p of placeholders) this.live.delete(p);
  }

  /** Adds a source the batch created or merged into. */
  add(sf: SourceFile): void {
    const s = sf.source;
    for (const a of sf.assets) if (a.role === "original") this.sha.set(a.sha256.toLowerCase(), s.id);
    if (s.identifiers.doi) this.doi.set(normalizeDoi(s.identifiers.doi), s.id);
    for (const i of s.identifiers.isbn ?? []) {
      const v = toIsbn13(i);
      if (v) this.isbn.set(v, s.id);
    }
    const c = s.creators[0];
    const family = c?.family ?? c?.literal;
    const e: Existing = {
      sourceId: s.id,
      sha256s: [],
      title: primary(s.title),
      ...(family ? { firstCreatorFamily: family } : {}),
      ...(s.issued ? { year: s.issued.slice(0, 4) } : {}),
      ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}),
      ...(s.identifiers.isbn?.length ? { isbns: s.identifiers.isbn } : {}),
    };
    if (this.buckets) this.put(e);
    else this.early.push(e);
  }
}
