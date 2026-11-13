/**
 * Zotero Web at scale (Task Z4; plan Review Focus 1): a first sync of 12,000 items, each with a stored file
 * (tiny PDFs), suspended at 5,000 (the app closed) and resumed: no file is fetched twice, the library version
 * recorded at the end is the LOWEST any part read at (A5), and memory stays bounded (R64). Not part of
 * `pnpm test`: run with `pnpm test:scale` (its own Vitest config and process, old space capped).
 * `AO_ZOTERO_SCALE_N` changes the size for a quick local check (the suspend point stays at 5/12 of it).
 */
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import { openTestRepo } from "../repo/testing.js";
import { setSecret } from "../secrets.js";
import { useMemorySecrets } from "../secrets-testing.js";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { FakeZotero, guardNetwork } from "../../tests/zotero/fake-zotero.js";
import { resumeZoteroWebImport, startZoteroWebImport, zoteroWebSince } from "./zotero-web.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;
const U = "user:42";
const MB = 1024 * 1024;

/**
 * Progress lines, written at once to the file `AO_SCALE_LOG` names (none: nothing). Synchronous on purpose: the
 * stand-in answers synchronously and can hold the worker's event loop for seconds, and a run stopped from outside
 * would lose console output still queued for the test runner.
 */
const progress = (line: string): void => {
  const to = process.env.AO_SCALE_LOG;
  if (to) appendFileSync(to, `${new Date().toISOString()} ${line}\n`);
};

afterAll(async () => {
  await shutdownExtractors();
});

describe("Zotero Web files at scale (Z4)", () => {
  it("a 12,000-item first sync suspended at 5,000 resumes without fetching any file twice and records the version", async () => {
    const N = Number(process.env.AO_ZOTERO_SCALE_N ?? 12_000);
    const SUSPEND_AT = Math.round((N * 5) / 12);
    const unguard = guardNetwork();
    const secrets = useMemorySecrets();
    const tmp = await mkdtemp(join(tmpdir(), "ao-zweb-scale-"));
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
    const z = new FakeZotero();
    await setSecret("zotero-api-key", z.key);
    const deps = () => ({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: z.agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
    const { project: p } = await repo.createProject({ name: "Scale", governanceYaml: GOV, encryption: { enabled: false } });

    // N articles, each with a stored PDF of its own (one tiny PDF, a distinct trailing comment each).
    const template = await buildPdf({ lines: ["A tiny file"] });
    const parents: string[] = [];
    const attachments: string[] = [];
    for (let i = 0; i < N; i++) {
      const parent = z.addItem(U, { itemType: "journalArticle", title: `Scale study number ${i}`, creators: [{ creatorType: "author", firstName: "A.", lastName: `Author${i}` }], date: String(1900 + (i % 120)) });
      const bytes = Buffer.concat([template, Buffer.from(`%ao-scale ${i}\n`, "latin1")]);
      attachments.push(z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: `f${i}.pdf` }, { parent, file: { bytes } }));
      parents.push(parent);
    }

    progress(`stand-in holds ${2 * N} items (${N} files); the first sync starts`);
    let peakRss = process.memoryUsage().rss;
    let peakHeap = process.memoryUsage().heapUsed;
    let lastShown = Date.now();
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peakRss = Math.max(peakRss, m.rss);
      peakHeap = Math.max(peakHeap, m.heapUsed);
      if (Date.now() - lastShown >= 30_000) {
        lastShown = Date.now();
        progress(`after ${Math.round((lastShown - started) / 1000)} s: ${z.requests.length} requests to the stand-in, heap ${Math.round(m.heapUsed / MB)} MB, RSS ${Math.round(m.rss / MB)} MB`);
      }
    }, 100);
    const started = Date.now();
    try {
      // Part one: the app closes after SUSPEND_AT items.
      const h = await startZoteroWebImport(deps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
      let shown = 0;
      for await (const e of h.progress) {
        if (e.done >= shown + 250) {
          shown = e.done;
          progress(`part one: ${e.done} items after ${Math.round((Date.now() - started) / 1000)} s, ${z.requests.length} requests, heap ${Math.round(process.memoryUsage().heapUsed / MB)} MB`);
        }
        if (e.done >= SUSPEND_AT) {
          await h.suspend();
          break;
        }
      }
      const first = await h.done;
      expect(first.state).toBe("paused");
      const firstMs = Date.now() - started;
      const v1 = z.libraryVersion(U);
      // Meanwhile the researcher edits, in Zotero, an item the first part brought in (its journal says which).
      const journal = (await readFile(join(lib.root, p.folder, "imports", "batch-0001", "journal.jsonl"), "utf8")).split("\n").filter(Boolean);
      expect(journal.length).toBeGreaterThanOrEqual(SUSPEND_AT);
      expect(journal.length).toBeLessThan(N);
      const edited = (JSON.parse(journal[0]!) as { key: string }).key.replace(/^zotero:/u, "");
      expect(parents).toContain(edited);
      z.editItem(U, edited, { tags: [{ tag: "tagged in Zotero between the two parts" }] });
      const v2 = z.libraryVersion(U);
      expect(v2).toBeGreaterThan(v1);

      // Part two: the app opens again and the batch is resumed (it rebuilds its adapter from the batch record).
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(z.agent);
      let second;
      try {
        second = await (await resumeZoteroWebImport(deps(), p.id, h.batchId)).done;
      } finally {
        setGlobalDispatcher(previous);
      }
      const ms = Date.now() - started;
      expect(second.state).toBe("finished");
      expect(second.counts.failed).toBe(0);
      expect(second.counts.created + second.counts.needsReview).toBe(N);
      expect(repo.listSourceIds(p.id)).toHaveLength(N);

      // No file fetched twice: one `/file` request and one storage request per attachment.
      const perFile = new Map<string, number>();
      let storage = 0;
      for (const r of z.requests) {
        const m = /\/items\/([A-Za-z0-9]+)\/file$/u.exec(r.path);
        if (m) perFile.set(m[1]!, (perFile.get(m[1]!) ?? 0) + 1);
        else if (r.path.startsWith("/zoterofilestorage/")) storage++;
      }
      expect(perFile.size).toBe(N);
      expect([...perFile.values()].filter((n) => n !== 1)).toEqual([]);
      expect(attachments.every((a) => perFile.get(a) === 1)).toBe(true);
      expect(storage).toBe(N);
      // The version recorded is the lowest any part read at (A5): the edit between the parts is asked for next time.
      expect(zoteroWebSince(repo, p.id, U)).toBe(v1);

      // The next run asks since v1: the edited item is updated and its file (stored at this version) is not fetched.
      const before = z.requests.length;
      const third = await (await startZoteroWebImport(deps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} })).done;
      expect(third.counts).toMatchObject({ updated: 1, failed: 0 });
      expect(z.requests.slice(before).filter((r) => r.path.endsWith("/file") || r.path.startsWith("/zoterofilestorage/"))).toEqual([]);
      expect(zoteroWebSince(repo, p.id, U)).toBe(v2);

      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      const requests = z.requests.length;
      console.log(
        `zotero web ${N} items with files: part one ${firstMs} ms (${first.counts.created + first.counts.needsReview} items), in all ${ms} ms; ${requests} requests (${perFile.size} file, ${storage} storage); peak heap ${Math.round(peakHeap / MB)} MB, peak RSS ${Math.round(peakRss / MB)} MB`,
      );
      // R64 / the task's bound: heap under 300 MB (the process runs with its old space capped, vitest.scale.config.ts).
      expect(peakHeap).toBeLessThan(300 * MB);
      expect(peakRss).toBeLessThan(500 * MB);
    } finally {
      clearInterval(timer);
      await z.agent.close();
      handle.close();
      await lib.close();
      ring.clear();
      secrets.restore();
      unguard();
      await rm(tmp, { recursive: true, force: true });
    }
  }, 1_800_000);
});
