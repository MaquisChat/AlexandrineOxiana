/**
 * FR-749 (R551 I1; R546 2, 3): a Bulk Import running when its library begins to close. A lookup the closing cut short
 * (the client's stop: `LookupCancelledError`) and a write the closed library refused (`LibraryClosedError`) are
 * conditions of the BATCH, never failures of an item: nothing is journaled for the item in hand, the batch is left
 * paused exactly as a suspend leaves it, and once the library is in use again it resumes and completes with no item
 * failed and none imported twice.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, openLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { batchDirs, readJournal } from "./batch.js";
import { createBulkImport, folderAdapter } from "./index.js";

/** The default lookups (OpenAlex's title search among them): each PDF's title is looked up. */
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
const agents: MockAgent[] = [];

const deps = (): Deps => ({
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

/** An agent that reaches no host; every request is answered by `reply`. */
function agentAnswering(reply: () => { statusCode: number; data: string; responseOptions?: { headers: Record<string, string> } }): { agent: MockAgent; asked: Promise<void>; count: () => number } {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  let n = 0;
  let first!: () => void;
  const asked = new Promise<void>((r) => (first = r));
  agent
    .get(/.*/)
    .intercept({ path: () => true, method: () => true })
    .reply(() => {
      n++;
      first();
      return reply();
    })
    .persist();
  return { agent, asked, count: () => n };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-bulk-closing-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
});
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(async () => {
  await shutdownExtractors();
});

async function threePdfs(): Promise<string> {
  const dir = join(tmp, "Papers");
  await mkdir(dir, { recursive: true });
  for (const [name, title] of [
    ["alpha.pdf", "Harbour ledgers of the northern coast"],
    ["beta.pdf", "Salt works and their keepers"],
    ["gamma.pdf", "Nets, boats and the tide-line"],
  ] as const) {
    await writeFile(join(dir, name), await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  }
  return dir;
}

describe("a Bulk Import cut by the library's closing (FR-749, R551 I1)", () => {
  it("a lookup cut by the client's stop leaves the batch paused, nothing failed or journaled; a new client resumes it and imports each item once", async () => {
    const { project: p } = await repo.createProject({ name: "Study", governanceYaml: GOV, encryption: { enabled: false } });
    const folder = await threePdfs();
    // Every lookup is asked to wait an hour: the run is held in its first item's lookup.
    const slow = agentAnswering(() => ({ statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "3600" } } }));
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: slow.agent });
    const bulk = createBulkImport({ repo, http, index: handle });
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    await slow.asked;
    http.stop();
    const r = await h.done;
    expect(r.state).toBe("paused");
    expect(r.counts.failed).toBe(0);
    expect(slow.count()).toBe(1); // the wait was cut, nothing was asked again
    const [dir] = await batchDirs(repo, p.id);
    expect(await readJournal(repo, p.id, `imports/${dir!.name}`)).toEqual([]);
    expect((await bulk.listBatches(p.id))[0]).toMatchObject({ batchId: h.batchId, state: "paused" });
    expect(repo.listSourceIds(p.id)).toEqual([]);

    // The library in use again: a new lookup client (each lookup answered "not found") and a resume.
    const fine = agentAnswering(() => ({ statusCode: 404, data: "" }));
    const bulk2 = createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: fine.agent }), index: handle });
    const resumed = await (await bulk2.resumeBatch(p.id, h.batchId)).done;
    expect(resumed.state).toBe("finished");
    expect(resumed.counts.failed).toBe(0);
    expect(resumed.counts.created + resumed.counts.needsReview).toBe(3);
    expect(repo.listSourceIds(p.id)).toHaveLength(3);
    const lines = await readJournal(repo, p.id, `imports/${dir!.name}`);
    expect(lines.map((l) => l.key).sort()).toEqual(["alpha.pdf", "beta.pdf", "gamma.pdf"]);
    expect(lines.every((l) => l.outcome !== "failed")).toBe(true);
  }, 60_000);

  it("a write the closed library refused (the library closed while an item was looked up): nothing failed; after reopening, the batch resumes and imports each item once", async () => {
    const { project: p } = await repo.createProject({ name: "Study", governanceYaml: GOV, encryption: { enabled: false } });
    const folder = await threePdfs();
    // The first lookup is asked to wait 30 s; that wait is held until the library is closed, then the lookup is
    // answered "not found" and the item goes on to be stored: the closed library refuses it.
    let n = 0;
    const answers = agentAnswering(() => (++n === 1 ? { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "30" } } } : { statusCode: 404, data: "" }));
    let waiting!: () => void;
    const inWait = new Promise<void>((r) => (waiting = r));
    let endWait!: () => void;
    const gate = new Promise<void>((r) => (endWait = r));
    onTestFinished(() => endWait());
    const sleep = (ms: number) => {
      if (ms < 10_000) return Promise.resolve();
      waiting();
      return gate;
    };
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: answers.agent, sleep });
    const bulk = createBulkImport({ repo, http, index: handle });
    const h = await bulk.startBatch(p.id, folderAdapter(folder));
    await inWait;
    const root = lib.root;
    await lib.close();
    endWait();
    const r = await h.done;
    expect(r.state).toBe("paused");
    expect(r.counts.failed).toBe(0);
    handle.close();

    // Opened again: the batch is resumable (its end was not saved: "interrupted"), and it completes.
    lib = await openLibrary(root, deps());
    handle = new IndexHandle(lib.root);
    repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
    const [listed] = await createBulkImport({ repo, http, index: handle }).listBatches(p.id);
    expect(listed).toMatchObject({ batchId: h.batchId, state: "interrupted" });
    const [dir] = await batchDirs(repo, p.id);
    expect((await readJournal(repo, p.id, `imports/${dir!.name}`)).filter((l) => l.outcome === "failed")).toEqual([]);
    const fine = agentAnswering(() => ({ statusCode: 404, data: "" }));
    const bulk2 = createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: fine.agent }), index: handle });
    const resumed = await (await bulk2.resumeBatch(p.id, h.batchId)).done;
    expect(resumed.state).toBe("finished");
    expect(resumed.counts.failed).toBe(0);
    expect(repo.listSourceIds(p.id)).toHaveLength(3);
    const lines = await readJournal(repo, p.id, `imports/${dir!.name}`);
    expect(lines.map((l) => l.key).sort()).toEqual(["alpha.pdf", "beta.pdf", "gamma.pdf"]);
    expect(lines.every((l) => l.outcome !== "failed")).toBe(true);
  }, 60_000);
});
