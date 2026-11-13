/**
 * Task Z7: the sync runner, `syncZoteroLibrary`. Against the stand-in Zotero (Z1), through the real engine and the
 * real Web import (Z2–Z6). What is pinned: every way a run can end leaves one honest record (a failure never reads
 * as "up to date"); a quiet library costs one 304 request and writes nothing to the library; the remembered version
 * never moves ahead of what is safely written; one run at a time per Zotero library and project; back-off obeyed with
 * an injected clock; the key in no file, record, error or log line; pauses; the counts mapping; resume, not restart.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, markOffline, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { useMemorySecrets, useNoSecretStore } from "../secrets-testing.js";
import { setSecret } from "../secrets.js";
import { FakeZotero, guardNetwork, type FakeRequest, type FakeResponse } from "../../tests/zotero/fake-zotero.js";
import { findBatch, batchDirs } from "./bulk/batch.js";
import type { BatchCounts, BatchHandle } from "./bulk/run.js";
import { startZoteroWebImport, zoteroWebSince } from "./zotero-web.js";
import {
  ZOTERO_SYNC_MAX_BACKOFF_MS,
  ZOTERO_SYNC_MIN_BACKOFF_MS,
  syncZoteroLibrary,
  zoteroImportRunning,
  zoteroSyncCounts,
  zoteroSyncRunCounts,
  zoteroSyncRunning,
  type ZoteroSyncDeps,
} from "./zotero-sync.js";
import {
  ZOTERO_SYNC_FILE,
  ZOTERO_SYNC_HISTORY_FILE,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  runningZoteroSyncRuns,
  writeZoteroSyncSettings,
  type ZoteroSyncLink,
  type ZoteroSyncRun,
} from "./zotero-sync-settings.js";

const FAST = 2 ** 10;
const U = "user:42";
const G = "group:9";
/** A recognisable key: searched for in every file written and every line logged. */
const KEY = "Zk3yRecognisableAbCdEf12";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [zotero_import]
processing:
  metadata_lookup: []
`;
const T0 = Date.UTC(2027, 2, 12, 14, 32);

let tmp: string;
let config: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let z: FakeZotero;
let secrets: { restore(): void };
let clock: number;
let logged: string[];
let restoreLogs: Array<() => void>;

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

let unguard: () => void;
beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(async () => {
  unguard();
  await shutdownExtractors();
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zsync-"));
  config = join(tmp, "config");
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Library"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  z = new FakeZotero({ key: KEY });
  const s = useMemorySecrets();
  secrets = s;
  await setSecret("zotero-api-key", z.key);
  clock = T0;
  // Every line anything logs during a test, to look for the key in.
  logged = [];
  restoreLogs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    restoreLogs.push(() => spy.mockRestore());
  }
  const w = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array, ...r: unknown[]) => {
    logged.push(String(c));
    return (w as (...x: unknown[]) => boolean)(c, ...r);
  }) as typeof process.stderr.write;
  restoreLogs.push(() => {
    process.stderr.write = w;
  });
});
afterEach(async () => {
  // One way only: nothing but GET ever reached the stand-in, in every test of this file.
  expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
  // The key is in no line logged.
  expect(logged.filter((l) => l.includes(KEY))).toEqual([]);
  for (const r of restoreLogs) r();
  runningZoteroSyncRuns.clear();
  handle.close();
  await lib.close();
  ring.clear();
  await z.agent.close();
  secrets.restore();
  await rm(tmp, { recursive: true, force: true });
});

const bulkDeps = () => ({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: z.agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
const syncDeps = (extra: Partial<ZoteroSyncDeps> = {}): ZoteroSyncDeps => ({
  ...bulkDeps(),
  appConfigDir: config,
  libraryId: lib.id,
  dispatcher: z.agent,
  sleep: async () => {},
  now: () => clock,
  debug: (n) => void logged.push(n),
  ...extra,
});

async function project(o: { encrypted?: boolean; gov?: string } = {}): Promise<Project> {
  const name = `P${Math.random().toString(36).slice(2, 7)}`;
  return (await repo.createProject({ name, governanceYaml: o.gov ?? GOV, encryption: o.encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } })).project;
}

const linkOf = (p: Project, ref = U, extra: Partial<ZoteroSyncLink> = {}): ZoteroSyncLink => ({
  ref,
  projectId: p.id,
  fullDone: false,
  options: { structure: "collections", duplicates: "merge" },
  ...extra,
});

/** Saves the links in this computer's settings (as Z8 does) and returns the first. */
async function linked(...links: ZoteroSyncLink[]): Promise<ZoteroSyncLink> {
  await writeZoteroSyncSettings(config, lib.id, { automatic: true, everyMinutes: 60, links });
  return links[0]!;
}
const stored = async (ref = U) => (await readZoteroSyncSettings(config, lib.id)).links.find((l) => l.ref === ref)!;

function sync(link: ZoteroSyncLink, o: { signal?: AbortSignal; backoffUntil?: number; trigger?: "manual" | "automatic" } = {}, extra: Partial<ZoteroSyncDeps> = {}) {
  return syncZoteroLibrary(syncDeps(extra), link, { trigger: o.trigger ?? "manual", signal: o.signal ?? new AbortController().signal, ...(o.backoffUntil !== undefined ? { backoffUntil: o.backoffUntil } : {}) });
}

const history = () => readZoteroSyncHistory(config, lib.id);

/** Every file under the library folder, by relative path, as bytes (hex). */
async function libraryBytes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(lib.root, { recursive: true })).sort()) {
    const b = await readFile(join(lib.root, name)).catch(() => null);
    if (b) out.set(name, b.toString("hex"));
  }
  return out;
}

const filesRequested = () => z.requests.filter((r) => /\/items\/[A-Z0-9]+\/file/u.test(r.path)).length;
const sourceCount = (p: Project) => repo.listSourceIds(p.id).length;

async function articles(n: number, ref = U, withFile = false): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = z.addItem(ref, { itemType: "journalArticle", title: `Article ${i}`, creators: [{ creatorType: "author", firstName: "Ada", lastName: `Writer${i}` }], date: "2020", publicationTitle: "Journal" });
    if (withFile) z.addItem(ref, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: k, file: { bytes: await buildPdf({ extra: `a${i}` }) } });
    keys.push(k);
  }
  return keys;
}

/** The stand-in stops answering (every connection breaks) once `after` more API item pages have been served. */
function networkDropsAfter(after: number): { restore(): void } {
  const orig = z.serve.bind(z);
  let pages = 0;
  z.serve = (req: FakeRequest, host) => {
    if (pages >= after) return { status: 0, headers: {}, body: "", drop: true } as FakeResponse;
    const res = orig(req, host);
    if (/\/items(\?|$)/u.test(req.path) && /format=json|include=data/u.test(req.path)) pages++;
    return res;
  };
  return { restore: () => void (z.serve = orig) };
}

/** Requests the runner itself makes before any batch: the cheap check and the key check. */
const runnerRequests = () => z.requests.filter((r) => /items\/top\?limit=1&format=keys|\/keys\/current|\/groups\?/u.test(r.path));

// ------------------------------------------------------------------------------------------

describe("the plan's tests", () => {
  it("a quiet library makes one 304 request and writes nothing to the library", async () => {
    const p = await project();
    await articles(3);
    const first = await sync(await linked(linkOf(p)));
    expect(first.outcome).toBe("finished");
    expect((await stored()).fullDone).toBe(true);
    const before = await libraryBytes();
    const batches = (await batchDirs(repo, p.id)).length;
    const n = z.requests.length;
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "up-to-date", ref: U, projectId: p.id, trigger: "manual" });
    expect(r.reason).toBeUndefined();
    expect(r.batchId).toBeUndefined();
    expect(z.requests.slice(n)).toHaveLength(1);
    expect(z.requests[n]!.path).toMatch(/^\/users\/42\/items\/top\?/u);
    expect(z.requests[n]!.headers["if-modified-since-version"]).toBe(String(z.libraryVersion(U)));
    // NOTHING in the library: no batch record, no audit event, no source touched.
    expect((await batchDirs(repo, p.id)).length).toBe(batches);
    expect(await libraryBytes()).toEqual(before);
    // The record of the run is in the device file.
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "up-to-date", finishedAt: expect.any(String) });
  });

  it("the first sync is full, the second incremental", async () => {
    const p = await project();
    const [a] = await articles(2);
    const first = await sync(await linked(linkOf(p)));
    expect(first).toMatchObject({ outcome: "finished", counts: { new: 2, changed: 0 } });
    const firstReqs = z.requests.filter((r) => r.path.includes("/items?") || r.path.includes("/items/top?"));
    expect(firstReqs.some((r) => r.path.includes("since="))).toBe(false);
    expect((await stored()).fullDone).toBe(true);
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    z.editItem(U, a!, { title: "Article 0, revised" });
    const n = z.requests.length;
    const second = await sync(await stored());
    expect(second).toMatchObject({ outcome: "finished", counts: { new: 0, changed: 1 } });
    expect(z.requests.slice(n).some((r) => /\/items\?.*since=/u.test(r.path))).toBe(true);
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    expect(sourceCount(p)).toBe(2);
  });

  it("a run whose network drops mid-page records an honest failure, keeps since, and the next run ends with no duplicate", async () => {
    const p = await project();
    await articles(120);
    await sync(await linked(linkOf(p)));
    const since = zoteroWebSince(repo, p.id, U);
    expect(sourceCount(p)).toBe(120);
    // Zotero changes; the next run's network drops after the first page of the changed items.
    const more = await articles(110);
    z.editItem(U, more[0]!, { title: "changed" });
    const down = networkDropsAfter(1);
    const failed = await sync(await stored());
    down.restore();
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toBe("offline");
    expect(failed.outcome).not.toBe("up-to-date");
    expect(zoteroWebSince(repo, p.id, U)).toBe(since);
    expect((await stored()).fullDone).toBe(true);
    const next = await sync(await stored());
    expect(next.outcome).toBe("finished");
    expect(sourceCount(p)).toBe(230); // no duplicate
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
  });

  it("an unfinished sync batch is resumed, not started again", async () => {
    const p = await project();
    await articles(24, U, true);
    const ctl = new AbortController();
    const onBatch = (_p: string, h: BatchHandle) => {
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 2) return ctl.abort();
      })();
    };
    const stopped = await sync(await linked(linkOf(p)), { signal: ctl.signal }, { onBatch });
    expect(stopped).toMatchObject({ outcome: "stopped", reason: "stopped-by-you", batchId: expect.any(String) });
    expect((await findBatch(repo, p.id, stopped.batchId!))!.state).toBe("paused");
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
    const files = filesRequested();
    const dirs = (await batchDirs(repo, p.id)).length;
    const resumed = await sync(await stored());
    expect(resumed.outcome).toBe("finished");
    expect(resumed.batchId).toBe(stopped.batchId);
    expect((await batchDirs(repo, p.id)).length).toBe(dirs);
    expect(sourceCount(p)).toBe(24);
    // No file twice: the resumed part asked only for the files of the items the first part did not finish.
    expect(filesRequested() - files).toBeLessThanOrEqual(24 - 2);
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
    expect((await stored()).fullDone).toBe(true);
  });

  it("a revoked key ends the run with key-refused and pauses automatic runs for every link", async () => {
    const p = await project();
    const p2 = await project();
    z.addGroup(9, "Group");
    await articles(2);
    await linked(linkOf(p), linkOf(p2, G));
    await sync(await stored());
    const since = zoteroWebSince(repo, p.id, U);
    z.editItem(U, z.addItem(U, { itemType: "book", title: "B" }), { title: "B2" });
    z.revokeKey();
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "key-refused" });
    expect((await readZoteroSyncSettings(config, lib.id)).links.map((l) => l.paused)).toEqual(["key-refused", "key-refused"]);
    expect(zoteroWebSince(repo, p.id, U)).toBe(since);
    // A paused link refuses before any request, with its reason.
    const n = z.requests.length;
    expect(await sync(await stored(G))).toMatchObject({ outcome: "failed", reason: "key-refused" });
    expect(z.requests.length).toBe(n);
  });

  it("a group the key lost is reported and the personal library still syncs", async () => {
    const p = await project();
    const p2 = await project();
    z.addGroup(9, "Group");
    z.addItem(G, { itemType: "book", title: "Group book" });
    await articles(1);
    await linked(linkOf(p), linkOf(p2, G));
    expect((await sync(await stored(G))).outcome).toBe("finished");
    z.addItem(G, { itemType: "book", title: "Another" });
    z.setKeyAccess({ groups: {} });
    const g = await sync(await stored(G));
    expect(g).toMatchObject({ outcome: "failed", reason: "library-gone" });
    expect((await stored(G)).paused).toBe("library-gone");
    expect((await stored(U)).paused).toBeUndefined();
    const u = await sync(await stored(U));
    expect(u).toMatchObject({ outcome: "finished", counts: { new: 1 } });
  });

  it("inside back-off no request is made", async () => {
    const p = await project();
    await articles(1);
    const until = clock + 10 * 60_000;
    const r = await sync(await linked(linkOf(p)), { backoffUntil: until });
    expect(r).toMatchObject({ outcome: "failed", reason: "backing-off", backoffUntil: new Date(until).toISOString() });
    expect(z.requests).toEqual([]);
    expect((await history())[0]).toMatchObject({ id: r.id, reason: "backing-off" });
    // At the moment it ends, the run goes ahead.
    clock = until;
    expect((await sync(await stored(), { backoffUntil: until })).outcome).toBe("finished");
  });

  it("a locked project refuses before any request", async () => {
    const p = await project({ encrypted: true });
    await articles(1);
    repo.lockProject(p.id);
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "failed", reason: "project-locked" });
    expect(z.requests).toEqual([]);
  });

  it("an encrypted project's counts are not in the device file", async () => {
    const p = await project({ encrypted: true });
    await articles(2);
    const r = await sync(await linked(linkOf(p)));
    expect(r.counts).toMatchObject({ new: 2 });
    const text = await readFile(join(config, ZOTERO_SYNC_HISTORY_FILE), "utf8");
    expect(text).not.toMatch(/counts/u);
    expect((await history())[0]!.counts).toBeUndefined();
    // How a caller gets them: from the batch, while the project is unlocked.
    expect(await zoteroSyncRunCounts(repo, p.id, r.batchId!)).toEqual(r.counts);
    repo.lockProject(p.id);
    expect(await zoteroSyncRunCounts(repo, p.id, r.batchId!)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------

describe("every way a run ends leaves one honest record", () => {
  it("refusal: the library is read-only (before any request)", async () => {
    const p = await project();
    const l = await linked(linkOf(p));
    await markOffline(lib);
    const r = await sync(l);
    expect(r).toMatchObject({ outcome: "failed", reason: "library-read-only", finishedAt: expect.any(String) });
    expect(z.requests).toEqual([]);
    expect((await history()).map((x) => x.id)).toEqual([r.id]);
  });

  it("refusal: an unknown project is an error (before any request)", async () => {
    const r = await sync(linkOf({ id: "no-such-project" } as Project));
    expect(r).toMatchObject({ outcome: "failed", reason: "error" });
    expect(z.requests).toEqual([]);
  });

  it("refusal: no key is key-missing; no password store is no-store (before any request)", async () => {
    const p = await project();
    const l = await linked(linkOf(p));
    secrets.restore();
    secrets = useMemorySecrets();
    expect(await sync(l)).toMatchObject({ outcome: "failed", reason: "key-missing" });
    secrets.restore();
    secrets = useNoSecretStore();
    expect(await sync(l)).toMatchObject({ outcome: "failed", reason: "no-store" });
    expect(z.requests).toEqual([]);
    expect((await history()).map((x) => x.reason)).toEqual(["no-store", "key-missing"]);
  });

  it("refusals come in their order: read-only before locked before paused before running before back-off before key", async () => {
    const p = await project({ encrypted: true });
    await linked(linkOf(p, U, { paused: "library-gone" }));
    secrets.restore();
    secrets = useMemorySecrets(); // no key
    const all = { backoffUntil: clock + 60_000 };
    repo.lockProject(p.id);
    await markOffline(lib);
    expect((await sync(await stored(), all)).reason).toBe("library-read-only");
  });

  it("refusal order without read-only: locked, then paused, then back-off, then key", async () => {
    const p = await project({ encrypted: true });
    await linked(linkOf(p, U, { paused: "library-gone" }));
    secrets.restore();
    secrets = useMemorySecrets();
    const b = { backoffUntil: clock + 60_000 };
    repo.lockProject(p.id);
    expect((await sync(await stored(), b)).reason).toBe("project-locked");
    await repo.unlockProject(p.id, "pw");
    expect((await sync(await stored(), b)).reason).toBe("library-gone");
    await linked(linkOf(p));
    expect((await sync(await stored(), b)).reason).toBe("backing-off");
    expect((await sync(await stored())).reason).toBe("key-missing");
    expect(z.requests).toEqual([]);
  });

  it("a scan failure (Zotero answers 500 to the end) is failed / offline, with nothing recorded", async () => {
    const p = await project();
    await articles(1);
    z.failNext(100, 500);
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "failed", reason: "offline" });
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
    expect((await stored()).fullDone).toBe(false);
  });

  it("a failed run leaves since and fullDone as they were", async () => {
    const p = await project();
    const [a] = await articles(2);
    await sync(await linked(linkOf(p)));
    const since = zoteroWebSince(repo, p.id, U);
    z.editItem(U, a!, { title: "x" });
    const settingsBefore = await readFile(join(config, ZOTERO_SYNC_FILE), "utf8");
    const down = networkDropsAfter(0);
    // The cheap check itself fails: offline before any batch.
    const r = await sync(await stored());
    down.restore();
    expect(r).toMatchObject({ outcome: "failed", reason: "offline" });
    expect(r.batchId).toBeUndefined();
    expect(zoteroWebSince(repo, p.id, U)).toBe(since);
    expect(await readFile(join(config, ZOTERO_SYNC_FILE), "utf8")).toBe(settingsBefore);
  });

  it("a batch finishing with problems: a refused redirect host is named, the run is finished-with-problems", async () => {
    const p = await project();
    await articles(1, U, true);
    z.redirectHost = "elsewhere.example.org";
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "finished-with-problems", refusedHosts: ["elsewhere.example.org"] });
    expect(JSON.stringify(r)).not.toMatch(/zoterofilestorage|sig=/u);
  });

  it("a batch finishing with problems: a download that failed for a passing reason holds since back", async () => {
    const p = await project();
    const [k] = await articles(1, U, true);
    const att = z.requests.length; // (no request yet)
    expect(att).toBe(0);
    z.failStorage(500, 100);
    const r = await sync(await linked(linkOf(p)));
    expect(r.outcome).toBe("finished-with-problems");
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
    expect((await stored()).fullDone).toBe(false);
    expect(k).toBeTruthy();
  });

  it("an abort before the run starts is stopped / stopped-by-you, with no request", async () => {
    const p = await project();
    const ctl = new AbortController();
    ctl.abort();
    const r = await sync(await linked(linkOf(p)), { signal: ctl.signal });
    expect(r).toMatchObject({ outcome: "stopped", reason: "stopped-by-you" });
    expect(z.requests).toEqual([]);
  });

  it("an abort during the cheap check is stopped, and nothing is written to the library", async () => {
    const p = await project();
    await articles(1);
    await sync(await linked(linkOf(p)));
    const before = await libraryBytes();
    const ctl = new AbortController();
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      if (req.path.includes("/items/top?limit=1")) ctl.abort("app-closed");
      return orig(req, host);
    };
    const r = await sync(await stored(), { signal: ctl.signal });
    expect(r).toMatchObject({ outcome: "stopped", reason: "app-closed" });
    expect(await libraryBytes()).toEqual(before);
  });

  it("an abort during the key check is stopped, with no batch", async () => {
    const p = await project();
    await articles(1);
    await sync(await linked(linkOf(p)));
    z.addItem(U, { itemType: "book", title: "new" });
    const ctl = new AbortController();
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      if (req.path.startsWith("/keys/current")) ctl.abort();
      return orig(req, host);
    };
    const dirs = (await batchDirs(repo, p.id)).length;
    const r = await sync(await stored(), { signal: ctl.signal });
    expect(r).toMatchObject({ outcome: "stopped", reason: "stopped-by-you" });
    expect((await batchDirs(repo, p.id)).length).toBe(dirs);
  });

  it("the library closing under it (the batch suspended, as on close) is stopped / app-closed", async () => {
    const p = await project();
    // Enough items that the suspend lands before the batch can finish (with a few, "finished" would be the truth).
    await articles(60);
    const onBatch = (_p: string, h: BatchHandle) => void h.suspend();
    const r = await sync(await linked(linkOf(p)), {}, { onBatch });
    expect(r).toMatchObject({ outcome: "stopped", reason: "app-closed", batchId: expect.any(String) });
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
  });

  it("the library handle closed under the run without a suspend: the record says what became of the batch", async () => {
    // Closing a handle only gives up its lock (the service suspends the batches first: the test above). The run's
    // record then follows the batch: finished if it finished, stopped / app-closed if it did not; never up to date.
    const p = await project();
    await articles(40);
    let closing: Promise<void> | undefined;
    const onBatch = (_p: string, h: BatchHandle) => {
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 1) return void (closing = lib.close());
      })();
    };
    const r = await sync(await linked(linkOf(p)), {}, { onBatch });
    await closing;
    const state = (await findBatch(repo, p.id, r.batchId!))!.state;
    if (state === "finished") expect(r.outcome).toBe("finished");
    else expect(r).toMatchObject({ outcome: "stopped", reason: "app-closed" });
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: r.outcome, finishedAt: expect.any(String) });
  });

  it("a group refused in the middle of its scan, with the key still accepted, is library-gone for that link only", async () => {
    const p = await project();
    const p2 = await project();
    z.addGroup(9, "Group");
    z.addItem(G, { itemType: "book", title: "Group book" });
    await linked(linkOf(p), linkOf(p2, G));
    const orig = z.serve.bind(z);
    z.serve = (req, host) => (req.path.startsWith("/groups/9/items") ? { status: 403, headers: {}, body: "Forbidden" } : orig(req, host));
    const r = await sync(await stored(G));
    expect(r).toMatchObject({ outcome: "failed", reason: "library-gone", batchId: expect.any(String) });
    expect((await readZoteroSyncSettings(config, lib.id)).links.map((l) => l.paused)).toEqual([undefined, "library-gone"]);
  });

  it("a lock during the run stops it: stopped / project-locked", async () => {
    const p = await project({ encrypted: true });
    await articles(40);
    const onBatch = (_p: string, h: BatchHandle) => {
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 1) return repo.lockProject(p.id);
      })();
    };
    const r = await sync(await linked(linkOf(p)), {}, { onBatch });
    expect(r.outcome).toBe("stopped");
    expect(r.reason).toBe("project-locked");
    expect(zoteroWebSince(repo, p.id, U)).toBeUndefined();
  });

  it("a throw from something it calls (the project's rules refuse the import) is failed / error, never up to date", async () => {
    const p = await project({ gov: GOV.replace("captureMethods: [zotero_import]", "captureMethods: [manual_upload]") });
    await articles(1);
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "failed", reason: "error" });
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "failed", reason: "error", finishedAt: expect.any(String) });
  });

  it("a started record without an end becomes stopped/app-closed when next read (a crash, a kill)", async () => {
    const p = await project();
    await articles(3);
    let seen: ZoteroSyncRun[] = [];
    const onBatch = () => {
      // As another process would see it after this one died here: the run is not running in that process.
      const ids = [...runningZoteroSyncRuns];
      runningZoteroSyncRuns.clear();
      void history().then((h) => {
        seen = h;
        for (const id of ids) runningZoteroSyncRuns.add(id);
      });
    };
    const r = await sync(await linked(linkOf(p)), {}, { onBatch });
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toMatchObject({ id: r.id, outcome: "stopped", reason: "app-closed" });
    expect(seen[0]!.finishedAt).toBeUndefined();
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "finished" });
  });
});

// ------------------------------------------------------------------------------------------

describe("one run at a time, whoever starts it", () => {
  it("two runs started together: one runs, one is refused", async () => {
    const p = await project();
    await articles(2);
    const l = await linked(linkOf(p));
    const [a, b] = await Promise.all([sync(l), sync(l)]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["failed", "finished"]);
    expect([a, b].find((r) => r.outcome === "failed")!.reason).toBe("import-running");
    expect(sourceCount(p)).toBe(2);
    expect((await batchDirs(repo, p.id)).length).toBe(1);
    expect(await history()).toHaveLength(2);
  });

  it("a manual import of the same library blocks a sync, and a sync blocks it", async () => {
    const p = await project();
    await articles(3);
    const l = await linked(linkOf(p));
    const manual = await startZoteroWebImport(bulkDeps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    const r = await sync(l);
    expect(r).toMatchObject({ outcome: "failed", reason: "import-running" });
    expect(runnerRequests()).toEqual([]);
    await manual.done;
    // And the other way round: while a sync runs, the import screen is told this library is being imported.
    let during: [boolean, boolean] | undefined;
    z.addItem(U, { itemType: "book", title: "new" });
    const onBatch = () => {
      void zoteroImportRunning(repo, p.id, U).then((x) => (during = [x, zoteroSyncRunning(lib.id, U)]));
    };
    await sync(await stored(), {}, { onBatch });
    await vi.waitFor(() => expect(during).toEqual([true, true]));
    expect(zoteroSyncRunning(lib.id, U)).toBe(false);
    expect(await zoteroImportRunning(repo, p.id, U)).toBe(false);
  });

  it("a batch of another origin is never resumed", async () => {
    const p = await project();
    await articles(5);
    const manual = await startZoteroWebImport(bulkDeps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    await manual.suspend();
    expect((await findBatch(repo, p.id, manual.batchId))!.state).toBe("paused");
    const r = await sync(await linked(linkOf(p)));
    expect(r.outcome).toBe("finished");
    expect(r.batchId).not.toBe(manual.batchId);
    expect((await findBatch(repo, p.id, manual.batchId))!.state).toBe("paused");
  });
});

// ------------------------------------------------------------------------------------------

describe("back-off", () => {
  it("a Backoff from Zotero is carried in the record, at least an hour ahead", async () => {
    const p = await project();
    await articles(1);
    await sync(await linked(linkOf(p)));
    z.backoffOnce(30);
    const r = await sync(await stored());
    expect(r.outcome).toBe("up-to-date");
    expect(Date.parse(r.backoffUntil!)).toBeGreaterThanOrEqual(clock + ZOTERO_SYNC_MIN_BACKOFF_MS);
  });

  it("a clock moved backwards neither skips nor prolongs a back-off", async () => {
    const p = await project();
    await articles(1);
    const l = await linked(linkOf(p));
    // Kept by the caller when the clock read T0; the clock is then put back two days.
    const kept = T0 + 2 * ZOTERO_SYNC_MAX_BACKOFF_MS;
    clock = T0 - 2 * 24 * 3_600_000;
    const r = await sync(l, { backoffUntil: kept });
    // Not skipped: refused. Not prolonged: the wait is at most a day from now, and the record says when.
    expect(r).toMatchObject({ outcome: "failed", reason: "backing-off" });
    expect(Date.parse(r.backoffUntil!)).toBe(clock + ZOTERO_SYNC_MAX_BACKOFF_MS);
    expect(z.requests).toEqual([]);
    // The caller keeps the record's time; a day later the run goes ahead.
    clock += ZOTERO_SYNC_MAX_BACKOFF_MS;
    expect((await sync(l, { backoffUntil: Date.parse(r.backoffUntil!) })).outcome).toBe("finished");
  });
});

// ------------------------------------------------------------------------------------------

describe("the key", () => {
  it("the key is in no file, record, error or log line", async () => {
    const p = await project();
    await articles(2, U, true);
    const runs: ZoteroSyncRun[] = [];
    runs.push(await sync(await linked(linkOf(p))));
    runs.push(await sync(await stored()));
    z.addItem(U, { itemType: "book", title: "b" });
    z.failNext(100, 503);
    runs.push(await sync(await stored()));
    z.revokeKey();
    runs.push(await sync(linkOf(p)));
    expect(JSON.stringify(runs)).not.toContain(KEY);
    // Every file written: the device folder and the library.
    for (const root of [config, lib.root]) {
      for (const name of await readdir(root, { recursive: true })) {
        const b = await readFile(join(root, name)).catch(() => null);
        if (b) expect(b.includes(KEY), `${root}/${name}`).toBe(false);
      }
    }
    expect(logged.some((l) => l.includes(KEY))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------

describe("device files", () => {
  it("a damaged history file is set aside and a sync still runs", async () => {
    const p = await project();
    await articles(1);
    const l = await linked(linkOf(p));
    await writeFile(join(config, ZOTERO_SYNC_HISTORY_FILE), "{ damaged");
    const told: string[] = [];
    const r = await sync(l, {}, { onSetAside: (f) => told.push(f) });
    expect(r.outcome).toBe("finished");
    expect(told).toEqual([ZOTERO_SYNC_HISTORY_FILE]);
    expect((await history()).map((x) => x.id)).toEqual([r.id]);
  });

  it("a damaged settings file: the run uses the link it was given, and no pause or fullDone is written", async () => {
    const p = await project();
    await articles(1);
    await linked(linkOf(p));
    await writeFile(join(config, ZOTERO_SYNC_FILE), "[]");
    const r = await sync(linkOf(p));
    expect(r.outcome).toBe("finished");
    expect(await readZoteroSyncSettings(config, lib.id)).toEqual({ automatic: false, everyMinutes: 60, links: [] });
  });

  it("each pause refuses its link with its reason, and a settings write clears it", async () => {
    const p = await project();
    await articles(1);
    for (const [paused, reason] of [
      ["key-refused", "key-refused"],
      ["library-gone", "library-gone"],
      ["undone", "sync-undone"],
    ] as const) {
      const l = await linked(linkOf(p, U, { paused }));
      expect(await sync(l)).toMatchObject({ outcome: "failed", reason });
      // The stored pause holds even when the caller's copy of the link says nothing of it.
      expect(await sync(linkOf(p))).toMatchObject({ outcome: "failed", reason });
    }
    expect(z.requests).toEqual([]);
    await linked(linkOf(p)); // the settings written with the link un-paused
    expect((await sync(await stored())).outcome).toBe("finished");
  });

  it("nothing of the library's content is in either device file", async () => {
    const p = await project();
    z.addItem(U, { itemType: "journalArticle", title: "Informal markets of Lagos" });
    await sync(await linked(linkOf(p)));
    for (const f of [ZOTERO_SYNC_FILE, ZOTERO_SYNC_HISTORY_FILE]) expect(await readFile(join(config, f), "utf8")).not.toMatch(/Informal|Lagos|Lib\b/u);
  });
});

// ------------------------------------------------------------------------------------------

describe("every count is mapped (plan A8, A9)", () => {
  const zero: BatchCounts = {
    items: 0,
    created: 0,
    needsReview: 0,
    duplicates: 0,
    merged: 0,
    updated: 0,
    unchanged: 0,
    deletedHere: 0,
    failed: 0,
    goneInZotero: 0,
    goneInZoteroBin: 0,
    goneAlready: 0,
    backInZotero: 0,
    backInZoteroUpdated: 0,
    goneNotMarked: 0,
    conflicts: 0,
    collectionsRenamed: 0,
    clearedInZoteroKept: 0,
  };
  const only = (k: keyof BatchCounts, n = 3) => zoteroSyncCounts({ ...zero, [k]: n });
  const none = { new: 0, changed: 0, unchanged: 0, waiting: 0, conflicts: 0, goneMarked: 0, failed: 0, back: 0, clearedKept: 0 };

  it("new = created (incomplete items included by the engine)", () => expect(only("created")).toEqual({ ...none, new: 3 }));
  it("changed = updated, a back that also changed counted once (the engine counts it in updated)", () => {
    expect(only("updated")).toEqual({ ...none, changed: 3 });
    expect(zoteroSyncCounts({ ...zero, updated: 2, backInZotero: 1, backInZoteroUpdated: 1 })).toEqual({ ...none, changed: 2, back: 1 });
  });
  it("unchanged = unchanged", () => expect(only("unchanged")).toEqual({ ...none, unchanged: 3 }));
  it("waiting = needsReview (the review queue's other entries)", () => expect(only("needsReview")).toEqual({ ...none, waiting: 3 }));
  it("conflicts = conflicts", () => expect(only("conflicts")).toEqual({ ...none, conflicts: 3 }));
  it("goneMarked = goneInZotero (this run's marks; goneAlready never)", () => {
    expect(only("goneInZotero")).toEqual({ ...none, goneMarked: 3 });
    expect(only("goneAlready")).toEqual(none);
    expect(only("goneInZoteroBin")).toEqual(none); // already within goneInZotero
  });
  it("failed = failed", () => expect(only("failed")).toEqual({ ...none, failed: 3 }));
  it("back = backInZotero", () => expect(only("backInZotero")).toEqual({ ...none, back: 3 }));
  it("clearedKept = clearedInZoteroKept", () => expect(only("clearedInZoteroKept")).toEqual({ ...none, clearedKept: 3 }));
});
