/**
 * Bulk Import at scale (its own file, so the process measured holds only this test): 10,000
 * metadata-only items in under 120 s with RSS under 500 MB.
 */
import { mkdtemp, rm } from "node:fs/promises";
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
import { createBulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [refman_import]
processing:
  metadata_lookup: []
`;

afterAll(async () => {
  await shutdownExtractors();
});

describe("scale", () => {
  it("10,000 metadata-only items finish in under 120 s with RSS under 500 MB", async () => {
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
    const adapter: ImportSourceAdapter = {
      kind: "csl-json",
      location: "synthetic",
      count: async () => N,
      async *scan(): AsyncGenerator<ScanItem> {
        for (let i = 0; i < N; i++) {
          yield {
            key: `item-${i}`,
            files: [],
            referenceMetadata: {
              type: "article-journal",
              title: { variants: [{ lang: "en", kind: "original", value: `Synthetic study number ${i}` }] },
              creators: [{ role: "author", family: `Author${i}`, given: "A." }],
              issued: String(1900 + (i % 120)),
            },
          };
        }
      },
    };
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 100);
    const started = Date.now();
    try {
      const h = await bulk.startBatch(p.id, adapter);
      const result = await h.done;
      const ms = Date.now() - started;
      peak = Math.max(peak, process.memoryUsage().rss);
      const m = process.memoryUsage();
      console.log(`bulk import 10k: ${ms} ms, peak RSS ${Math.round(peak / 1024 / 1024)} MB (heap ${Math.round(m.heapUsed / 1024 / 1024)} MB, external ${Math.round(m.external / 1024 / 1024)} MB)`);
      expect(result.counts.items).toBe(N);
      expect(result.counts.created + result.counts.needsReview).toBe(N);
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
