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
 *   - for the encrypted case, what stays in memory for the source (its TEMP rows) under 8 MB:
 *     2 MB of text plus its CJK bigrams (each character twice, plus separators) is at most about
 *     6 MB in UTF-8.
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
const TEMP_LIMIT_BYTES = 8 * 1024 * 1024;

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

describe("R161 (b): annotation indexing at the R74 cap has a bounded cost", () => {
  for (const cjk of [true, false]) {
    for (const prot of [false, true]) {
      const label = `${cjk ? "CJK" : "Latin"}, ${prot ? "encrypted (in memory)" : "plain"}`;
      it(`${label}: memory and time per write stay within the limits`, async () => {
        const id = newId();
        const anns = capSet(id, cjk);
        const sf = sourceFile(anns, id);
        const first = await measure(() => indexSource(db, sf, undefined, { protected: prot }));
        const same = await measure(() => indexSource(db, sf, undefined, { protected: prot }));
        const changed = sourceFile([{ ...anns[0]!, quote: cjk ? "変更された注釈" : "changed annotation" }, ...anns.slice(1)], id);
        const edit = await measure(() => indexSource(db, changed, undefined, { protected: prot }));
        console.log(`Task 58 cap (${label}): first ${Math.round(first.ms)} ms / +${first.peakMb.toFixed(1)} MB; unchanged ${Math.round(same.ms)} ms / +${same.peakMb.toFixed(1)} MB; one changed ${Math.round(edit.ms)} ms / +${edit.peakMb.toFixed(1)} MB`);
        for (const m of [first, same, edit]) {
          expect(m.peakMb).toBeLessThan(MEMORY_LIMIT_MB);
          expect(m.ms).toBeLessThan(TIME_LIMIT_MS);
        }
        const store = prot ? "temp.t_annotation" : "main.annotation";
        const held = db
          .prepare(`SELECT COALESCE(SUM(LENGTH(CAST(a.annotations AS BLOB)) + LENGTH(CAST(a.annotation_bigrams AS BLOB))), 0) AS n, COALESCE(SUM(LENGTH(CAST(a.annotations AS BLOB))), 0) AS text
                    FROM ${store}_chunks c JOIN ${store}_text a ON a.rowid = c.fts_rowid WHERE c.source_id = ?`)
          .get(id) as { n: number; text: number };
        expect(held.text).toBeLessThanOrEqual(ANNOTATION_INDEX_BYTES);
        if (prot) expect(held.n).toBeLessThan(TEMP_LIMIT_BYTES);
        const hit = search(db, { text: cjk ? "変更" : "changed" });
        expect(hit.items).toContainEqual(expect.objectContaining({ id, matchedIn: "annotation", annotationsPartial: true }));
      }, 120_000);
    }
  }
});
