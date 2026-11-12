/**
 * R161 (b): indexing a source's annotations at the R74 cap (10,000 annotations, 16 MB of text)
 * has a bounded cost. At most ANNOTATION_INDEX_BYTES (2 MB, UTF-8) is indexed, in chunks of at
 * most ANNOTATION_CHUNK_BYTES, so neither one allocation nor one statement grows with the set.
 *
 * Limits asserted per write, for a CJK and a Latin set, plain (persistent store) and encrypted
 * (in-memory TEMP store):
 *   - peak additional memory (process RSS, sampled from a worker thread while the write blocks
 *     the main thread) under MEMORY_LIMIT_MB = 64: a quarter of what is left of the service's
 *     512 MB ceiling (R64) once the app itself is running, and 25 times the 2 MB indexed.
 *   - time under TIME_LIMIT_MS = 1,000 (the dispatch's bound for a write).
 *   - what the store holds for the source under HELD_LIMIT_BYTES = 12 MB, counted from the FTS
 *     shadow tables (content, index blocks, term index, sizes) and the chunk table (N4): in memory
 *     for an encrypted project, on disk otherwise. At the CJK cap that is 2 MB of text, about
 *     4 MB of bigrams (each character twice, with separators) and about 3 MB of index blocks.
 * A write whose annotations did not change rewrites no chunk.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { newId, type Annotation, type SourceFile } from "@ao/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexSource, openIndexAt, type IndexDb } from "./db.js";
import { search } from "./search.js";
import { ANNOTATION_INDEX_BYTES } from "./text.js";

const MEMORY_LIMIT_MB = 64;
const TIME_LIMIT_MS = 1_000;
const HELD_LIMIT_BYTES = 12 * 1024 * 1024;
/** A search of several terms over 2,000 annotated sources: well under a second's wait (N1). */
const SEARCH_LIMIT_MS = 1_000;

/**
 * Bytes a store holds for its annotation text: the FTS table's content (text and bigrams), its
 * index blocks (`_data`), term index (`_idx`) and sizes (`_docsize`), and the chunk table.
 */
function storedBytes(store: string): number {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
  return (
    one(`SELECT SUM(LENGTH(block)) AS n FROM ${store}_text_data`) +
    one(`SELECT SUM(LENGTH(CAST(c0 AS BLOB)) + LENGTH(CAST(c1 AS BLOB)) + LENGTH(CAST(c2 AS BLOB)) + LENGTH(CAST(c3 AS BLOB)) + 8) AS n FROM ${store}_text_content`) +
    one(`SELECT SUM(LENGTH(CAST(term AS BLOB)) + 16) AS n FROM ${store}_text_idx`) +
    one(`SELECT SUM(LENGTH(sz) + 8) AS n FROM ${store}_text_docsize`) +
    one(`SELECT SUM(LENGTH(source_id) + LENGTH(sha256) + 24) AS n FROM ${store}_chunks`)
  );
}

let dir: string;
let db: IndexDb;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-anncap-"));
  db = openIndexAt(join(dir, "library.sqlite"));
});
afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const NOW = "2026-11-12T10:00:00.000Z";

function sourceFile(annotations: Annotation[], id = newId()): SourceFile {
  return {
    formatVersion: 1,
    source: {
      id,
      projectIds: ["0190f0f0-0000-7000-8000-00000000aaaa"],
      type: "book",
      title: { variants: [{ lang: "en", kind: "original", value: "Cap test" }] },
      creators: [],
      identifiers: {},
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
      folder: "Projects/P/Sources/cap",
      provenance: { captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      createdAt: NOW,
      updatedAt: NOW,
    },
    assets: [],
    annotations,
    fieldEvidence: [],
    verification: {},
  } as unknown as SourceFile;
}

/** 10,000 annotations of 1,600 characters: the R74 cap of count and text (16 MB). */
function capSet(sourceId: string, cjk: boolean): Annotation[] {
  const han = "研究資料社会調査記録市場家庭料理記憶歴史文化言語";
  const latin = ["market", "vendor", "street", "policy", "memory", "kitchen", "harvest", "ledger"];
  return Array.from({ length: 10_000 }, (_, i) => {
    let s = cjk ? `注${i}` : `mark${i} `;
    for (let j = 0; s.length < 1_600; j++) s += cjk ? han[(i + j) % han.length]! : `${latin[(i + j) % latin.length]}${j % 97} `;
    return { id: newId(), sourceId, kind: "highlight", anchors: [], quote: s.slice(0, 1_600), author: "t", createdAt: NOW } as Annotation;
  });
}

/** Runs `fn` while a worker thread samples the process's RSS every 2 ms; returns time and peak growth. */
async function measure(fn: () => void): Promise<{ ms: number; peakMb: number }> {
  const shared = new SharedArrayBuffer(16);
  const cells = new Float64Array(shared);
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
     const c = new Float64Array(workerData);
     const tick = () => { const r = process.memoryUsage.rss(); if (r > c[0]) c[0] = r; if (c[1] === 0) setTimeout(tick, 2); };
     tick();`,
    { eval: true, workerData: shared },
  );
  await new Promise((r) => setTimeout(r, 50));
  const base = process.memoryUsage.rss();
  cells[0] = base;
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  await new Promise((r) => setTimeout(r, 20));
  cells[1] = 1;
  await worker.terminate();
  return { ms, peakMb: (cells[0]! - base) / (1024 * 1024) };
}

describe("N1: a search of several terms over many annotated sources", () => {
  it("combines terms across record and annotations within a stated time", () => {
    // 2,000 sources of the same project, each with 30 annotations of about 600 characters (36 MB in
    // all, 18 KB each); the common words are in every source's annotations.
    const words = ["market", "vendor", "street", "policy", "memory", "kitchen", "harvest", "ledger"];
    const ids: string[] = [];
    for (let s = 0; s < 2_000; s++) {
      const id = newId();
      ids.push(id);
      const anns = Array.from({ length: 30 }, (_, i) => {
        let t = `note${s}x${i} `;
        for (let j = 0; t.length < 600; j++) t += `${words[(s + i + j) % words.length]} `;
        return { id: newId(), sourceId: id, kind: "highlight", anchors: [], quote: t, author: "t", createdAt: NOW } as Annotation;
      });
      const sf = sourceFile(anns, id);
      (sf.source as { title: unknown }).title = { variants: [{ lang: "en", kind: "original", value: `Source ${s} on lagos${s % 10}` }] };
      indexSource(db, sf);
    }
    const timed = (text: string) => {
      const t = performance.now();
      const r = search(db, { text, limit: 50 });
      return { ms: performance.now() - t, total: r.total, first: r.items[0] };
    };
    const common = timed("market vendor");
    const rare = timed("lagos3 note1503x7");
    const mixed = timed("lagos3 kitchen harvest");
    console.log(`Task 58 N1 search over 2,000 annotated sources (ms): common pair ${Math.round(common.ms)} (${common.total}), title+annotation ${Math.round(rare.ms)} (${rare.total}), three terms ${Math.round(mixed.ms)} (${mixed.total})`);
    expect(common.total).toBe(2_000);
    expect(rare.total).toBe(1);
    expect(rare.first).toMatchObject({ id: ids[1503], matchedIn: "annotation" });
    expect(mixed.total).toBe(200);
    for (const m of [common, rare, mixed]) expect(m.ms).toBeLessThan(SEARCH_LIMIT_MS);
  }, 120_000);
});

describe("N5: a search of several words in a project of 5,000 annotated sources does not block for long", () => {
  /*
   * Budget (fix round 3): two common words under TWO_WORDS_MS, six under SIX_WORDS_MS, on the
   * service's one thread. Measured on the development machine (a shared multi-core container, load
   * 1–3); a slower runner has the margin between the measured times (see the log line) and these.
   */
  const TWO_WORDS_MS = 300;
  const SIX_WORDS_MS = 600;
  let big: IndexDb;
  let bigDir: string;
  const P = "0190f0f0-0000-7000-8000-00000000bbbb";
  const OTHER = "0190f0f0-0000-7000-8000-00000000cccc";
  const ids: string[] = [];
  beforeAll(async () => {
    bigDir = await mkdtemp(join(tmpdir(), "ao-annspeed-"));
    big = openIndexAt(join(bigDir, "library.sqlite"));
    const words = ["market", "vendor", "street", "policy", "memory", "kitchen", "harvest", "ledger", "rumour", "ration"];
    const add = (project: string, s: number) => {
      const id = newId();
      const anns = Array.from({ length: 30 }, (_, i) => {
        let t = `note${s}x${i} `;
        for (let j = 0; t.length < 1_000; j++) t += `${words[(s + i + j) % words.length]} `;
        return { id: newId(), sourceId: id, kind: "highlight", anchors: [], quote: t, author: "t", createdAt: NOW } as Annotation;
      });
      const sf = sourceFile(anns, id);
      (sf.source as { projectIds: string[] }).projectIds = [project];
      (sf.source as { title: unknown }).title = { variants: [{ lang: "en", kind: "original", value: `Source ${s}` }] };
      indexSource(big, sf);
      return id;
    };
    big.transaction(() => {
      for (let s = 0; s < 5_000; s++) ids.push(add(P, s));
      for (let s = 0; s < 1_000; s++) add(OTHER, s);
    })();
  }, 600_000);
  afterAll(async () => {
    big.close();
    await rm(bigDir, { recursive: true, force: true });
  });

  it("two and six common words stay within the budget, with the right answers", () => {
    const timed = (text: string) => {
      search(big, { text, projectId: P, limit: 50 }); // warm the page cache like a typing user would
      const t = performance.now();
      const r = search(big, { text, projectId: P, limit: 50 });
      return { ms: performance.now() - t, r };
    };
    const two = timed("market vendor");
    const six = timed("market vendor street policy memory kitchen");
    const rare = timed("market note4321x7");
    console.log(`Task 58 N5 search, project of 5,000 annotated sources (ms): two words ${Math.round(two.ms)}, six words ${Math.round(six.ms)}, common+rare ${Math.round(rare.ms)}`);
    expect(two.r.total).toBe(5_000);
    expect(six.r.total).toBe(5_000);
    expect(two.r.items).toHaveLength(50);
    expect(two.r.items.every((i) => i.matchedIn === "annotation" && i.projectId === P)).toBe(true);
    expect(rare.r.total).toBe(1);
    expect(rare.r.items[0]).toMatchObject({ id: ids[4321], matchedIn: "annotation" });
    expect(two.ms).toBeLessThan(TWO_WORDS_MS);
    expect(six.ms).toBeLessThan(SIX_WORDS_MS);
  });
});

describe("R161 (b): annotation indexing at the R74 cap has a bounded cost", () => {
  for (const cjk of [true, false]) {
    for (const prot of [false, true]) {
      const label = `${cjk ? "CJK" : "Latin"}, ${prot ? "encrypted (in memory)" : "plain"}`;
      it(`${label}: memory and time per write stay within the limits`, async () => {
        const id = newId();
        const anns = capSet(id, cjk);
        const sf = sourceFile(anns, id);
        const store = prot ? "temp.t_annotation" : "main.annotation";
        const before = storedBytes(store);
        const first = await measure(() => indexSource(db, sf, undefined, { protected: prot }));
        // Everything the store holds for the source, the full-text index's own blocks included (N4).
        const held = storedBytes(store) - before;
        console.log(`Task 58 cap (${prot ? "encrypted" : "plain"} ${cjk ? "CJK" : "Latin"}): ${(held / 1024 / 1024).toFixed(1)} MB held`);
        expect(held).toBeLessThan(HELD_LIMIT_BYTES);
        const same = await measure(() => indexSource(db, sf, undefined, { protected: prot }));
        const changed = sourceFile([{ ...anns[0]!, quote: cjk ? "変更された注釈" : "changed annotation" }, ...anns.slice(1)], id);
        const edit = await measure(() => indexSource(db, changed, undefined, { protected: prot }));
        console.log(`Task 58 cap (${label}): first ${Math.round(first.ms)} ms / +${first.peakMb.toFixed(1)} MB; unchanged ${Math.round(same.ms)} ms / +${same.peakMb.toFixed(1)} MB; one changed ${Math.round(edit.ms)} ms / +${edit.peakMb.toFixed(1)} MB`);
        for (const m of [first, same, edit]) {
          expect(m.peakMb).toBeLessThan(MEMORY_LIMIT_MB);
          expect(m.ms).toBeLessThan(TIME_LIMIT_MS);
        }
        const text = db
          .prepare(`SELECT COALESCE(SUM(LENGTH(CAST(a.annotations AS BLOB))), 0) AS text FROM ${store}_chunks c JOIN ${store}_text a ON a.rowid = c.fts_rowid WHERE c.source_id = ?`)
          .get(id) as { text: number };
        expect(text.text).toBeLessThanOrEqual(ANNOTATION_INDEX_BYTES);
        const hit = search(db, { text: cjk ? "変更" : "changed" });
        expect(hit.items).toContainEqual(expect.objectContaining({ id, matchedIn: "annotation", annotationsPartial: true }));
      }, 120_000);
    }
  }
});
