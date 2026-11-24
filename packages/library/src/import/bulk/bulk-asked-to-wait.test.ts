/**
 * Decision 31 (b), R556 (2) v: Bulk Import is NOT changed. Its lookups never ask the client to leave a service out
 * (no `askedToWait`), so a "too many requests" answer is waited out as before (the Retry-After honoured), and nothing of
 * the attach's "left out" reaches its items: no LOOKUP_WAITING_TEXT, no `leftOut` on a review entry.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOKUP_WAITING_TEXT } from "@ao/shared";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, type Library } from "../../library.js";
import { HttpClient, type GetOptions } from "../../lookup/index.js";
import { REVIEW_FILE, parseReviewFile } from "../../repo/review.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { createBulkImport, folderAdapter } from "./index.js";

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
let agent: MockAgent;

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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-bulk-wait-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  agent = new MockAgent();
  agent.disableNetConnect();
});
afterEach(async () => {
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(async () => {
  await shutdownExtractors();
});

describe("Bulk Import waits as before (decision 31 b, R556 2 v)", () => {
  it("a 429 with Retry-After 30 is waited out; no lookup asks to leave a service out; nothing says 'waiting'", async () => {
    const { project: p } = await repo.createProject({ name: "Study", governanceYaml: GOV, encryption: { enabled: false } });
    const dir = join(tmp, "Papers");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alpha.pdf"), await buildPdf({ title: "Harbour ledgers of the northern coast", author: "Ana Souza", lines: ["Harbour ledgers of the northern coast."] }));
    let n = 0;
    agent
      .get("https://api.openalex.org")
      .intercept({ path: () => true, method: "GET" })
      .reply(() => (++n === 1 ? { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "30" } } } : { statusCode: 200, data: JSON.stringify({ results: [] }) }))
      .persist();
    const sleeps: number[] = [];
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async (ms) => void sleeps.push(ms) });
    const asked: GetOptions[] = [];
    const getJson = http.getJson.bind(http);
    http.getJson = ((url: string, opts: GetOptions) => {
      asked.push(opts);
      return getJson(url, opts);
    }) as typeof http.getJson;
    const h = await createBulkImport({ repo, http, index: handle }).startBatch(p.id, folderAdapter(dir));
    const r = await h.done;
    expect(r.state).toBe("finished");
    expect(sleeps).toContain(30_000); // the service's wait, honoured as before
    expect(n).toBe(2); // asked again after the wait
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((o) => o.askedToWait === undefined)).toBe(true);
    const text = await readFile(join(lib.root, (await repo.getProject(p.id)).folder, ...REVIEW_FILE.split("/")), "utf8").catch(() => "");
    const entries = parseReviewFile(text, p.id, null).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.reasons).not.toContain(LOOKUP_WAITING_TEXT);
    expect(entries[0]!.leftOut).toBeUndefined();
  }, 60_000);
});
