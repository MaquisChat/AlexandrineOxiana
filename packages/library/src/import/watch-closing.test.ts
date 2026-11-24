/**
 * FR-749 (R546 2): a watched folder's bringing-in that waits on a lookup when the library begins to close is cancelled
 * at once: the file stays in its folder, is not written in the register (neither "seen" nor "failed", so nothing skips
 * it), nothing of it is stored, and it IS brought in at the next start.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@ao/core";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { pendingMarkers } from "../repo/txn.js";
import { watchFolder, type WatchEvent } from "./watch.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const W = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100, watchEvents: false, rescanMs: 200 } as const;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let agent: MockAgent;
let inbox: string;

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
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-closing-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
  agent = new MockAgent();
  agent.disableNetConnect();
  inbox = join(tmp, "Inbox");
  await mkdir(inbox);
});
afterEach(async () => {
  await agent.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(async () => {
  await shutdownExtractors();
});

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a watched folder and the library's closing (FR-749, R546 2)", () => {
  it("a file waiting on its lookup stays in the folder, unregistered, and comes in at the next start", async () => {
    const p = (await repo.createProject({ name: "Study", governanceYaml: GOV, encryption: { enabled: false } })).project;
    const wid = newId();
    let requests = 0;
    const sent = () => requests;
    let arrived!: () => void;
    const lookedUp = new Promise<void>((r) => (arrived = r));
    const openalex = agent.get("https://api.openalex.org");
    // The request stays in the air: its answer is ten minutes away and is dropped when the request is abandoned. Since
    // decision 31 (b) a "too many requests" answer is no longer waited for. The reply handler says when it arrives.
    openalex
      .intercept({ path: (x) => x.startsWith("/works"), method: "GET" })
      .reply(() => {
        requests++;
        arrived();
        return { statusCode: 404, data: "" };
      })
      .delay(600_000)
      .times(1);
    const closing = new AbortController();
    // The request stays in the air (the client's own limit is a real 60 seconds): only the closing ends it.
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent });
    const events: WatchEvent[] = [];
    const w = watchFolder({ repo, http, lib, closing: closing.signal, onEvent: (e) => events.push(e), ...W }, p.id, inbox, {}, wid);
    await w.ready;
    const file = join(inbox, "tide-line-notes.pdf");
    const bytes = await buildPdf({ title: "Notes from the tide-line interviews", author: "Ana Souza", lines: ["Notes from the tide-line interviews."] });
    await writeFile(file, bytes);
    await lookedUp;
    closing.abort();
    await w.stop();
    expect(sent()).toBe(1);
    expect(await readFile(file)).toEqual(bytes);
    expect([...(await repo.watchRegister(p.id, wid)).keys()]).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(events.filter((e) => e.kind === "imported" || e.kind === "failed")).toEqual([]);
    expect(await pendingMarkers(lib.root)).toBe(0);

    // The next start brings it in (the service answers this time).
    openalex
      .intercept({ path: (x) => x.startsWith("/works"), method: "GET" })
      .reply(200, JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })
      .persist();
    const again: WatchEvent[] = [];
    const w2 = watchFolder({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent }), lib, onEvent: (e) => again.push(e), ...W }, p.id, inbox, {}, wid);
    try {
      await w2.ready;
      await until(() => again.some((e) => e.kind === "imported"));
      await until(async () => (await repo.watchRegister(p.id, wid)).get("tide-line-notes.pdf")?.state === "in-library");
      expect(repo.listSourceIds(p.id)).toHaveLength(1);
    } finally {
      await w2.stop();
    }
  }, 60_000);
});
