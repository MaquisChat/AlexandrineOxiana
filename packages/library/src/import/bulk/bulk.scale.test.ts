/**
 * Bulk Import at scale: 10,000 metadata items (with DOIs and DOI duplicates) plus PDF files (with
 * exact copies) in under 120 s with RSS under 500 MB. Not part of `pnpm test`: run with
 * `pnpm test:scale` (its own Vitest config, its own process; CI runs it after the main suite).
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { KeyRing } from "../../crypto/keys.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import { openTestRepo } from "../../repo/testing.js";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { createBulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [refman_import, manual_upload]
processing:
  metadata_lookup: []
`;

afterAll(async () => {
  await shutdownExtractors();
});

describe("scale", () => {
  it("10,000 metadata items plus files finish in under 120 s with RSS under 500 MB", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ao-bulk-scale-"));
    const ring = new KeyRing();
    const lib = await createLibrary(join(tmp, "Lib"), "Lib", {
      clock: () => new Date(),
      deviceId: "dev-A",
      hostname: "host-A",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "config"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    const handle = new IndexHandle(lib.root);
    const repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    const agent = new MockAgent();
    agent.disableNetConnect();
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
    const bulk = createBulkImport({ repo, http, index: handle });
    const { project: p } = await repo.createProject({ name: "Scale", governanceYaml: GOV, encryption: { enabled: false } });
    const N = Number(process.env.AO_BULK_N ?? 10_000);
    // 50 PDF files plus 10 exact copies (hash duplicates); every 10th metadata item has a DOI and
    // every 100th repeats an earlier item's DOI (a certain duplicate: merged), so the indexed
    // sha/DOI lookups run alongside the 10,000 creates.
    const files = join(tmp, "files");
    await mkdir(files);
    const pdfs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const path = join(files, `Scale - 2001 - File number ${i}.pdf`);
      await writeFile(path, await buildPdf({ title: `File number ${i}`, author: `Filer${i}`, lines: [`File number ${i}`], extra: String(i) }));
      pdfs.push(path);
    }
    for (let i = 0; i < 10; i++) {
      const path = join(files, `copy ${i}.pdf`);
      await copyFile(pdfs[i]!, path);
      pdfs.push(path);
    }
    const total = N + pdfs.length;
    const doiOf = (i: number) => (i >= 100 && i % 100 === 0 ? `10.5555/scale.${i - 50}` : i % 10 === 0 ? `10.5555/scale.${i}` : undefined);
    const adapter: ImportSourceAdapter = {
      kind: "csl-json",
      location: "synthetic",
      count: async () => total,
      async *scan(): AsyncGenerator<ScanItem> {
        for (let i = 0; i < N; i++) {
          const doi = doiOf(i);
          yield {
            key: `item-${i}`,
            files: [],
            referenceMetadata: {
              type: "article-journal",
              title: { variants: [{ lang: "en", kind: "original", value: `Synthetic study number ${i}` }] },
              creators: [{ role: "author", family: `Author${i}`, given: "A." }],
              issued: String(1900 + (i % 120)),
              ...(doi ? { identifiers: { doi } } : {}),
            },
          };
          if (i % 200 === 0 && pdfs.length) {
            const path = pdfs.shift()!;
            yield { key: `file-${path}`, files: [{ path, mime: "application/pdf", bytes: 0 }] };
          }
        }
        for (const path of pdfs) yield { key: `file-${path}`, files: [{ path, mime: "application/pdf", bytes: 0 }] };
      },
    };
    let peak = process.memoryUsage().rss;
    if (process.env.AO_SCALE_DEBUG) console.log(`rss at start ${Math.round(peak / 1024 / 1024)} MB`);
    let ticks = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.rss);
      if (process.env.AO_SCALE_DEBUG && ++ticks % 50 === 0) console.log(`rss ${Math.round(m.rss / 1048576)} heap ${Math.round(m.heapUsed / 1048576)} ab ${Math.round(m.arrayBuffers / 1048576)}`);
    }, 100);
    const started = Date.now();
    try {
      const h = await bulk.startBatch(p.id, adapter);
      const result = await h.done;
      const ms = Date.now() - started;
      peak = Math.max(peak, process.memoryUsage().rss);
      const m = process.memoryUsage();
      console.log(`bulk import 10k: ${ms} ms, peak RSS ${Math.round(peak / 1024 / 1024)} MB (heap ${Math.round(m.heapUsed / 1024 / 1024)} MB, external ${Math.round(m.external / 1024 / 1024)} MB)`);
      expect(result.counts.items).toBe(total);
      expect(result.counts.merged).toBe(Math.floor((N - 1) / 100));
      expect(result.counts.duplicates).toBe(10);
      expect(result.counts.failed).toBe(0);
      expect(result.counts.created + result.counts.needsReview + result.counts.merged + result.counts.duplicates).toBe(total);
      expect(ms).toBeLessThan(120_000);
      expect(peak).toBeLessThan(500 * 1024 * 1024);
    } finally {
      clearInterval(timer);
      await agent.close();
      handle.close();
      await lib.close();
      ring.clear();
      await rm(tmp, { recursive: true, force: true });
    }
  }, 300_000);
});
