/**
 * FR-749 (R546 1, 2): an attach and the library's closing. Here a lookup waits on a request in the air: since
 * decision 31 (b) an attach no longer waits on a "too many requests" answer. A file whose lookup waits when the library
 * begins to close is cancelled at once (the wait is cut short). Nothing of it is written — no source,
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
import { ExifTool } from "exiftool-vendored";
import { buildCameraTiff, buildPdf } from "../../../../tests/fixtures/generate.mjs";
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
import { ProxyQueue } from "./proxies.js";
import { proxyStub } from "./proxy-testing.js";
import { WorkerClient } from "../worker-client.js";
import { stubWorker } from "../worker-testing.js";

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

/**
 * Every OpenAlex request stays in the air: its answer is ten minutes away and is dropped when the request is abandoned.
 * Since decision 31 (b) an attach no longer waits on a "too many requests" answer; a slow service is what it still waits
 * for. `asked` is resolved by the stand-in's own reply handler when the first request arrives.
 */
function openAlexSaysWait(): { asked: Promise<void>; count: () => number } {
  let n = 0;
  let arrived!: () => void;
  const asked = new Promise<void>((r) => (arrived = r));
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (x) => x.startsWith("/works"), method: "GET" })
    .reply(() => {
      n++;
      arrived();
      return { statusCode: 404, data: "" };
    })
    .delay(600_000)
    .persist();
  return { asked, count: () => n };
}

describe("an attach and the library's closing (FR-749, R546)", () => {
  it("a file waiting on its lookup when the library begins to close is cancelled at once; nothing is written", async () => {
    const p = await project();
    const path = await put("tide-line-notes.pdf", "Notes from the tide-line interviews");
    const original = await readFile(path);
    const before = await snapshot(lib.root);
    const wait = openAlexSaysWait();
    const closing = new AbortController();
    // The request stays in the air (the client's own limit is a real 60 seconds); only the closing ends it.
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent });
    const attach = createAttach({ repo, http, closing: closing.signal });
    const outcome = attach.attachFiles(p.id, [path]);
    await wait.asked;
    closing.abort();
    expect(await outcome).toEqual([{ path, outcome: "cancelled", reason: attachClosedSentence("tide-line-notes.pdf") }]);
    expect(attachClosedSentence("tide-line-notes.pdf")).toBe("The library was closed or went offline before tide-line-notes.pdf was attached, so nothing was changed. Attach it again when the library is open.");
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
    const change = whileOpen(lib, closing.signal, () =>
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

describe("background work an attach starts runs outside its closing scope (FR-749, R551 M3)", () => {
  it("a viewing proxy the attach queued is made and recorded although the attach's session began to close after it", async () => {
    const et = new ExifTool({ maxProcs: 1 });
    const closers: Array<() => Promise<void> | void> = [];
    onTestFinished(async () => {
      for (const c of closers.splice(0)) await c();
      await et.end();
    });
    // The worker holds the proxy job until the session has begun to close.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let submitted!: () => void;
    const inWorker = new Promise<void>((r) => (submitted = r));
    const stub = proxyStub(et);
    const w = await stubWorker(async (job) => {
      submitted();
      await gate;
      return stub(job);
    }, { closers, pollsUntilDone: 1 });
    const proxies = new ProxyQueue({ repo, worker: new WorkerClient({ repo, worker: w, pollMs: 5 }) });
    // Files with a location are stored only in an encrypted project (their proxy follows the project's rule).
    const gov = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: required\nsharing:\n  locationMetadata: coarsen\ncaptureMethods: [manual_upload]\nprocessing:\n  metadata_lookup: []\n";
    const { project: p } = await repo.createProject({ name: "Photos", governanceYaml: gov, encryption: { enabled: true, passphrase: "pw" } });
    const tif = join(tmp, "Desktop", "IMG_0001.tif");
    await mkdir(dirname(tif), { recursive: true });
    await buildCameraTiff(tif);
    const closing = new AbortController();
    const attach = createAttach({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent }), proxies, closing: closing.signal });
    const [r] = await attach.attachFiles(p.id, [tif]);
    expect(["created", "needs-review"], r!.reason).toContain(r!.outcome);
    await inWorker;
    closing.abort(); // the session begins to close; the library itself is still open
    release();
    await proxies.idle();
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.pendingProxies ?? []).toEqual([]);
    expect(sf.assets.filter((a) => a.role === "derived")).toHaveLength(1);
  }, 60_000);
});
