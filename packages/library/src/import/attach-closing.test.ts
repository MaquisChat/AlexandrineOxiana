/**
 * FR-749 (R546 1, 2): an attach and the library's closing. A file whose lookup waits on a "too many requests" answer
 * when the library begins to close is cancelled at once (the wait is cut short): nothing of it is written — no source,
 * no stored file, no review entry, no audit entry, no marker — the original is untouched, and the outcome is the one
 * sentence `attachClosedSentence`. A file still waiting for its project's store turn is cancelled too. A closed library
 * refuses the attach's change by itself (the same outcome), whatever the caller passes.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { attachClosedSentence } from "@ao/shared";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { walk } from "../export/test-kit.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/http.js";
import { importChange, type Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { pendingMarkers } from "../repo/txn.js";
import { createAttach } from "./attach.js";
import { serialStore } from "./project-queue.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const NO_LOOKUP_GOV = `${GOV}processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
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
  tmp = await mkdtemp(join(tmpdir(), "ao-attach-closing-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
  agent = new MockAgent();
  agent.disableNetConnect();
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

async function project(gov = GOV) {
  return (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: { enabled: false } })).project;
}

async function put(name: string, title: string): Promise<string> {
  const p = join(tmp, "Desktop", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  return p;
}

/** Every file under the library with its bytes' digest: equal snapshots mean nothing was written. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${rel} ${digest}`);
  }
  return out;
}

/** Every OpenAlex request answers 429 with Retry-After 60; `asked` resolves at the first. */
function openAlexSaysWait(): { asked: Promise<void>; count: () => number } {
  let n = 0;
  let asked!: () => void;
  const p = new Promise<void>((r) => (asked = r));
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (x) => x.startsWith("/works"), method: "GET" })
    .reply(() => {
      n++;
      asked();
      return { statusCode: 429, data: "slow down", responseOptions: { headers: { "retry-after": "60" } } };
    })
    .persist();
  return { asked: p, count: () => n };
}

describe("an attach and the library's closing (FR-749, R546)", () => {
  it("a file waiting on a Retry-After when the library begins to close is cancelled at once; nothing is written", async () => {
    const p = await project();
    const path = await put("tide-line-notes.pdf", "Notes from the tide-line interviews");
    const original = await readFile(path);
    const before = await snapshot(lib.root);
    const wait = openAlexSaysWait();
    const closing = new AbortController();
    // The client's own wait is a real 60-second one (capped Retry-After); only the closing ends it.
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent });
    const attach = createAttach({ repo, http, closing: closing.signal });
    const outcome = attach.attachFiles(p.id, [path]);
    await wait.asked;
    closing.abort();
    expect(await outcome).toEqual([{ path, outcome: "cancelled", reason: attachClosedSentence("tide-line-notes.pdf") }]);
    expect(attachClosedSentence("tide-line-notes.pdf")).toBe("The library was closed before tide-line-notes.pdf was attached, so nothing was changed; attach it again after opening the library.");
    expect(wait.count()).toBe(1); // cutting the wait is not asking again
    expect(await snapshot(lib.root)).toEqual(before);
    expect(await pendingMarkers(lib.root)).toBe(0);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(await readFile(path)).toEqual(original);
  });

  it("a file still waiting for its project's store turn is cancelled at once, and writes nothing when its turn comes", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("second.pdf", "A second file");
    const before = await snapshot(lib.root);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // Another file's store turn in the same project, held.
    const held = serialStore(repo, p.id, async () => {
      entered();
      await gate;
    });
    await inside;
    const closing = new AbortController();
    const attach = createAttach({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent }), closing: closing.signal });
    const outcome = attach.attachFiles(p.id, [path]);
    await new Promise((r) => setImmediate(r));
    closing.abort();
    expect(await outcome).toEqual([{ path, outcome: "cancelled", reason: attachClosedSentence("second.pdf") }]);
    release();
    await held;
    // Its turn has come and gone: nothing of it was written.
    await serialStore(repo, p.id, async () => undefined);
    expect(await snapshot(lib.root)).toEqual(before);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a change already in its store turn when the closing begins finishes and is recorded", async () => {
    const p = await project(NO_LOOKUP_GOV);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const closing = new AbortController();
    const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
    const { whileOpen } = await import("../library.js");
    const change = whileOpen(closing.signal, () =>
      importChange(repo, p.id, STORE, async (ops) => {
        entered();
        await gate;
        ops.tx.record("project", p.id, { note: "" }, { note: "finished" });
      }, { op: "test.in-turn" }),
    );
    await inside;
    closing.abort();
    release();
    await expect(change).resolves.toBeUndefined();
  });

  it("a closed library refuses the attach's change by itself: the same outcome, nothing written", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("late.pdf", "A late file");
    const attach = createAttach({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent }) });
    await lib.close();
    const before = await snapshot(lib.root);
    expect(await attach.attachFiles(p.id, [path])).toEqual([{ path, outcome: "cancelled", reason: attachClosedSentence("late.pdf") }]);
    expect(await snapshot(lib.root)).toEqual(before);
    expect(await pendingMarkers(lib.root)).toBe(0);
  });
});
