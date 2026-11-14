/**
 * Task Z7: the sync runner, `syncZoteroLibrary`. Against the stand-in Zotero (Z1), through the real engine and the
 * real Web import (Z2–Z6). What is pinned: every way a run can end leaves one honest record (a failure never reads
 * as "up to date"); a quiet library costs one 304 request and writes nothing to the library; the remembered version
 * never moves ahead of what is safely written; one run at a time per Zotero library and project; back-off obeyed with
 * an injected clock; the key in no file, record, error or log line; pauses; the counts mapping; resume, not restart.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { deviceNoticesIdle, readDeviceNotices } from "../device-notices.js";
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
import { createBulkImport } from "./bulk/index.js";
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
  putZoteroSyncRun,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  runningZoteroSyncRuns,
  setZoteroSyncUnfinished,
  updateZoteroSyncSettings,
  writeZoteroSyncSettings,
  type ZoteroSyncLink,
  type ZoteroSyncRun,
} from "./zotero-sync-settings.js";

/** M9: how many batch records are read through readBatchAt (the runner's own reads; the engine's findBatch reads inside its module). */
const batchReads = vi.hoisted(() => ({ n: 0, after: undefined as undefined | (() => void) }));
vi.mock("./bulk/batch.js", async (orig) => {
  const m = await orig<typeof import("./bulk/batch.js")>();
  return {
    ...m,
    readBatchAt: async (...a: Parameters<typeof m.readBatchAt>) => {
      batchReads.n++;
      const r = await m.readBatchAt(...a);
      batchReads.after?.();
      return r;
    },
  };
});

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

  it("R252: a run whose library is taken by its caller is refused with its record, and no request is made", async () => {
    const p = await project();
    await articles(1);
    let asked = 0;
    const r = await sync(await linked(linkOf(p)), {}, { taken: () => (asked++, true) });
    expect(r).toMatchObject({ outcome: "failed", reason: "import-running" });
    expect(r.finishedAt).toBeDefined();
    expect(asked).toBe(1);
    expect(z.requests).toEqual([]);
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "failed", reason: "import-running" });
    expect(sourceCount(p)).toBe(0);
    // Not taken: the run goes ahead.
    expect((await sync(await stored(), {}, { taken: () => false })).outcome).toBe("finished");
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
    // The record is returned in the form it is saved in (M2): no counts for an encrypted project.
    expect(r.counts).toBeUndefined();
    const text = await readFile(join(config, ZOTERO_SYNC_HISTORY_FILE), "utf8");
    expect(text).not.toMatch(/counts/u);
    expect((await history())[0]).toEqual(r);
    // How a caller gets them: from the batch, while the project is unlocked.
    expect(await zoteroSyncRunCounts(repo, p.id, r.batchId!)).toMatchObject({ new: 2 });
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

  it("R248: an abort because the library was closed or moved says so (library-closed), and the record is kept", async () => {
    const p = await project();
    await articles(24);
    const ctl = new AbortController();
    const onBatch = (_p: string, h: BatchHandle) => {
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 2) return ctl.abort("library-closed");
      })();
    };
    const r = await sync(await linked(linkOf(p)), { signal: ctl.signal }, { onBatch });
    expect(r).toMatchObject({ outcome: "stopped", reason: "library-closed" });
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "stopped", reason: "library-closed" });
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

  it("a throw from something it calls (the project's rules refuse the import) is failed / rules-denied (R295 b), never up to date", async () => {
    const p = await project({ gov: GOV.replace("captureMethods: [zotero_import]", "captureMethods: [manual_upload]") });
    await articles(1);
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "failed", reason: "rules-denied" });
    expect((await history())[0]).toMatchObject({ id: r.id, outcome: "failed", reason: "rules-denied", finishedAt: expect.any(String) });
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

  it("R242: a batch without the origin is never adopted, even when this link's history names it", async () => {
    const p = await project();
    await articles(5);
    const manual = await startZoteroWebImport(bulkDeps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    await manual.suspend();
    const l = await linked(linkOf(p));
    await putZoteroSyncRun(config, lib.id, { id: "old-run", ref: U, projectId: p.id, trigger: "manual", startedAt: new Date(T0).toISOString(), outcome: "stopped", reason: "app-closed", batchId: manual.batchId });
    const r = await sync(l);
    expect(r.batchId).not.toBe(manual.batchId);
    expect((await findBatch(repo, p.id, manual.batchId))!.state).toBe("paused");
  });
});

describe("R242: the sync's own batches carry their origin", () => {
  it("a sync batch's record says origin zotero-sync from its creation, and keeps it across a resume", async () => {
    const p = await project();
    await articles(24);
    const ctl = new AbortController();
    let atStart: string | undefined;
    const onBatch = (_p: string, h: BatchHandle) => {
      void findBatch(repo, p.id, h.batchId).then((rec) => (atStart = rec?.origin));
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 2) return ctl.abort();
      })();
    };
    const stopped = await sync(await linked(linkOf(p)), { signal: ctl.signal }, { onBatch });
    await vi.waitFor(() => expect(atStart).toBe("zotero-sync"));
    expect((await findBatch(repo, p.id, stopped.batchId!))!.origin).toBe("zotero-sync");
    const resumed = await sync(await stored());
    expect(resumed.batchId).toBe(stopped.batchId);
    expect((await findBatch(repo, p.id, stopped.batchId!))).toMatchObject({ state: "finished", origin: "zotero-sync" });
  });

  it("a manual import's batch has no origin", async () => {
    const p = await project();
    await articles(1);
    const manual = await startZoteroWebImport(bulkDeps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    await manual.done;
    expect((await findBatch(repo, p.id, manual.batchId))!.origin).toBeUndefined();
  });

  it("R248: the batch list says which batch is the sync's, and of which Zotero library, from the batch's own record", async () => {
    const p = await project();
    await articles(1);
    const manual = await startZoteroWebImport(bulkDeps(), p.id, { libraryType: "user", libraryId: "42", dispatcher: z.agent, sleep: async () => {} });
    await manual.done;
    await articles(1);
    const run = await sync(await linked(linkOf(p)));
    expect(run.outcome).toBe("finished");
    // The history plays no part: set aside, the list still says it.
    await writeFile(join(config, ZOTERO_SYNC_HISTORY_FILE), "{ damaged");
    const list = await createBulkImport(bulkDeps()).listBatches(p.id);
    expect(list.find((b) => b.batchId === run.batchId)).toMatchObject({ kind: "zotero-web", origin: "zotero-sync", ref: U });
    const m = list.find((b) => b.batchId === manual.batchId)!;
    expect(m).toMatchObject({ kind: "zotero-web", ref: U });
    expect(m).not.toHaveProperty("origin");
  });

  it("a history file set aside does not make the runner lose or duplicate its batch", async () => {
    const p = await project();
    await articles(24);
    const ctl = new AbortController();
    const onBatch = (_p: string, h: BatchHandle) => {
      void (async () => {
        for await (const pr of h.progress) if (pr.done >= 2) return ctl.abort();
      })();
    };
    const stopped = await sync(await linked(linkOf(p)), { signal: ctl.signal }, { onBatch });
    expect(stopped.outcome).toBe("stopped");
    await writeFile(join(config, ZOTERO_SYNC_HISTORY_FILE), "{ damaged");
    const dirs = (await batchDirs(repo, p.id)).length;
    const resumed = await sync(await stored());
    expect(resumed).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
    expect((await batchDirs(repo, p.id)).length).toBe(dirs);
    expect(sourceCount(p)).toBe(24);
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
    // R242: a debug note only, no device notice.
    expect(logged.some((l) => l.includes(`${ZOTERO_SYNC_HISTORY_FILE} was set aside`))).toBe(true);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(config)).toEqual([]);
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

// ------------------------------------------------------------------------------------------
// Fix round 1 (R244).

/** Aborts the run once the batch has done `n` items. */
const stopAt = (ctl: AbortController, n: number) => (_p: string, h: BatchHandle) => {
  void (async () => {
    for await (const pr of h.progress) if (pr.done >= n) return ctl.abort();
  })();
};

/** A first sync of `n` items stopped after 2: its batch is paused, the link's own. */
async function stoppedFirstSync(p: Project, n = 24): Promise<ZoteroSyncRun> {
  await articles(n);
  const ctl = new AbortController();
  const r = await sync(await linked(linkOf(p)), { signal: ctl.signal }, { onBatch: stopAt(ctl, 2) });
  expect(r).toMatchObject({ outcome: "stopped", batchId: expect.any(String) });
  return r;
}

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function setGov(p: Project, yaml: string): Promise<void> {
  const cur = await repo.getGovernanceText(p.id);
  await repo.setGovernance(p.id, yaml, { baseSha256: sha(cur), reason: "test: the rules put back" });
}

describe("R244 (a) I1: a run that could not confirm the whole picture", () => {
  it("P2: a full run whose key list is not whole is finished-with-problems / deletions-unconfirmed; fullDone stays false, since as it was", async () => {
    const p = await project();
    const keys = await articles(3);
    await sync(await linked(linkOf(p)));
    const since = zoteroWebSince(repo, p.id, U);
    z.remove(U, keys[0]!);
    await updateZoteroSyncSettings(config, lib.id, (c) => ({ ...c, links: c.links.map((l) => ({ ...l, fullDone: false })) }));
    const orig = z.serve.bind(z);
    z.serve = (req, host) => (req.path.includes("format=versions") ? { status: 500, headers: {}, body: "x" } : orig(req, host));
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "finished-with-problems", reason: "deletions-unconfirmed" });
    expect((await findBatch(repo, p.id, r.batchId!))!.recordedLibraryVersion).toBeUndefined();
    expect((await stored()).fullDone).toBe(false);
    expect(zoteroWebSince(repo, p.id, U)).toBe(since);
  });

  it("R246 probe A: an incremental page short of its total is finished-with-problems / changes-incomplete; fullDone and since stay; the next run is incremental from the same version and loses nothing", async () => {
    const p = await project();
    const [a] = await articles(2);
    await sync(await linked(linkOf(p)));
    const since = zoteroWebSince(repo, p.id, U)!;
    z.editItem(U, a!, { title: "changed" });
    z.addItem(U, { itemType: "journalArticle", title: "Added", creators: [{ creatorType: "author", firstName: "Ada", lastName: "New" }], date: "2021", publicationTitle: "Journal" });
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      const res = orig(req, host);
      if (/^\/users\/42\/items\?/u.test(req.path) && req.path.includes("since=") && res.headers["total-results"]) res.headers["total-results"] = String(Number(res.headers["total-results"]) + 5);
      return res;
    };
    const r = await sync(await stored());
    z.serve = orig;
    expect(r).toMatchObject({ outcome: "finished-with-problems", reason: "changes-incomplete" });
    expect(zoteroWebSince(repo, p.id, U)).toBe(since);
    expect((await stored()).fullDone).toBe(true);
    const n = z.requests.length;
    const next = await sync(await stored());
    expect(next.outcome).toBe("finished");
    expect(z.requests.slice(n).some((q) => q.path.includes(`since=${since}`))).toBe(true);
    expect(z.requests.slice(n).some((q) => q.path.includes("format=versions"))).toBe(false); // no full read, no key list
    expect(sourceCount(p)).toBe(3); // nothing lost, nothing twice
    expect(zoteroWebSince(repo, p.id, U)).toBe(z.libraryVersion(U));
  });
});

describe("R244 (b) M4: an own batch that can never be resumed", () => {
  it("is ended for good (what came in stays), the run is failed / batch-ended with the engine's sentence, and the next run is a fresh full run", async () => {
    const p = await project();
    const stopped = await stoppedFirstSync(p);
    const came = sourceCount(p);
    // The batch now links its sources to a fieldwork session that does not exist: the engine refuses every resume.
    const rec = (await findBatch(repo, p.id, stopped.batchId!))!;
    const file = join(lib.root, repo.getProject(p.id).folder, rec.dir, "batch.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), fieldwork: { sessionId: "gone-session" } }));
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "batch-ended", batchId: stopped.batchId });
    expect(r.note).toMatch(/fieldwork session/u);
    expect((await findBatch(repo, p.id, stopped.batchId!))!.state).toBe("finished");
    expect(sourceCount(p)).toBe(came); // nothing undone
    expect((await stored()).fullDone).toBe(false);
    const next = await sync(await stored());
    expect(next.outcome).toBe("finished");
    expect(next.batchId).not.toBe(stopped.batchId);
    expect(sourceCount(p)).toBe(24);
  });

  it("R246 probe B: a lock while the batch is being resumed is a passing failure: the batch stays, and the next run resumes it (no full read)", async () => {
    const p = await project({ encrypted: true });
    const stopped = await stoppedFirstSync(p);
    const hint = (await stored()).unfinished;
    // The runner reads its batch through the hint; the project is locked right after, as the engine reads it again.
    batchReads.after = () => {
      batchReads.after = undefined;
      repo.lockProject(p.id);
    };
    let r: ZoteroSyncRun;
    try {
      r = await sync(await stored());
    } finally {
      batchReads.after = undefined;
    }
    expect(r.outcome).not.toBe("finished");
    expect(r.reason).toBe("project-locked");
    expect(r.note).toBeUndefined();
    await repo.unlockProject(p.id, "pw");
    expect((await findBatch(repo, p.id, stopped.batchId!))!.state).toBe("paused");
    expect((await stored()).unfinished).toBe(hint);
    expect((await stored()).fullDone).toBe(false); // as it was: the first full run has not finished yet
    const dirs = (await batchDirs(repo, p.id)).length;
    const resumed = await sync(await stored());
    expect(resumed).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
    expect((await batchDirs(repo, p.id)).length).toBe(dirs);
    expect(sourceCount(p)).toBe(24);
  });

  it("a passing failure (the project's rules refuse for now) leaves the batch to be resumed", async () => {
    const p = await project();
    const stopped = await stoppedFirstSync(p);
    await setGov(p, GOV.replace("captureMethods: [zotero_import]", "captureMethods: [manual_upload]"));
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "rules-denied" });
    expect((await findBatch(repo, p.id, stopped.batchId!))!.state).toBe("paused");
    await setGov(p, GOV);
    const resumed = await sync(await stored());
    expect(resumed).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
  });
});

describe("R244 (d) M1, M2, M3", () => {
  it("M1: a stale caller copy that says paused does not override the stored un-pause", async () => {
    const p = await project();
    await articles(1);
    await linked(linkOf(p));
    expect((await sync(linkOf(p, U, { paused: "key-refused" }))).outcome).toBe("finished");
  });

  it("M2: a link that cannot make a valid record is refused before any request, and says its record was not saved", async () => {
    const p = await project();
    for (const bad of [linkOf({ id: "a b" } as Project), linkOf(p, "user:042")]) {
      const r = await sync(bad);
      expect(r).toMatchObject({ outcome: "failed", reason: "error", recordSaved: false });
    }
    expect(z.requests).toEqual([]);
    expect(await history()).toEqual([]);
  });

  it("M3: a final history write that fails: the record says so, and the started record reads stopped / app-closed", async () => {
    const p = await project();
    await articles(3);
    const file = join(config, ZOTERO_SYNC_HISTORY_FILE);
    const onBatch = () => {
      void (async () => {
        await rename(file, `${file}.kept`);
        await mkdir(file); // the final write (and its second try) cannot replace a folder
      })();
    };
    const r = await sync(await linked(linkOf(p)), {}, { onBatch });
    expect(r).toMatchObject({ outcome: "finished", recordSaved: false });
    expect(logged.some((l) => l.includes("the run's record could not be saved"))).toBe(true);
    await rm(file, { recursive: true });
    await rename(`${file}.kept`, file);
    const [h] = await history();
    expect(h).toMatchObject({ id: r.id, outcome: "stopped", reason: "app-closed" });
    expect(h!.finishedAt).toBeUndefined();
  });
});

describe("R244 (d) M5: the back-off time carried in the record (the clock at real time)", () => {
  it("a 3-hour Backoff on the cheap check is carried as such", async () => {
    clock = Date.now();
    const p = await project();
    await articles(1);
    await sync(await linked(linkOf(p)));
    z.backoffOnce(3 * 3600);
    const r = await sync(await stored());
    expect(r.outcome).toBe("up-to-date");
    expect(Math.abs(Date.parse(r.backoffUntil!) - (Date.now() + 3 * 3_600_000))).toBeLessThan(60_000);
  });

  it("a 3-hour Backoff on the key check before a batch is backing-off, with its time (no batch is started)", async () => {
    clock = Date.now();
    const p = await project();
    await articles(1);
    z.backoffOnce(3 * 3600);
    const r = await sync(await linked(linkOf(p)));
    expect(r).toMatchObject({ outcome: "failed", reason: "backing-off" });
    expect(r.batchId).toBeUndefined();
    expect(Math.abs(Date.parse(r.backoffUntil!) - (Date.now() + 3 * 3_600_000))).toBeLessThan(60_000);
  });

  it("a 3-hour Backoff during the batch's scan (waited out) is carried in the finished run's record", async () => {
    clock = Date.now();
    const p = await project();
    await articles(1);
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      const res = orig(req, host);
      if (req.path.startsWith("/users/42/items")) res.headers["backoff"] = String(3 * 3600);
      return res;
    };
    const r = await sync(await linked(linkOf(p)));
    expect(r.outcome).toBe("finished");
    expect(Math.abs(Date.parse(r.backoffUntil!) - (Date.now() + 3 * 3_600_000))).toBeLessThan(60_000);
  });

  it("a Retry-After of a year on the cheap check is backing-off for a day", async () => {
    clock = Date.now();
    const p = await project();
    await articles(1);
    await sync(await linked(linkOf(p)));
    z.failNext(20, 429, 365 * 86_400);
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "backing-off" });
    expect(Math.abs(Date.parse(r.backoffUntil!) - (Date.now() + ZOTERO_SYNC_MAX_BACKOFF_MS))).toBeLessThan(60_000);
  });
});

describe("R244 (d) M8: endings that had no test", () => {
  it("a batch cancelled by someone else is stopped / stopped-by-you", async () => {
    const p = await project();
    await articles(60);
    const r = await sync(await linked(linkOf(p)), {}, { onBatch: (_p, h) => h.cancel() });
    expect(r).toMatchObject({ outcome: "stopped", reason: "stopped-by-you" });
  });

  it("a batch that fails for a reason that is neither close nor lock is failed / error", async () => {
    const p = await project();
    await articles(3);
    // The engine's index cannot be reached when the run begins: the batch itself ends `failed` (not an item failure).
    const index = {
      get db(): never {
        throw new Error("index broken");
      },
    };
    const r = await sync(await linked(linkOf(p)), {}, { index });
    expect(r).toMatchObject({ outcome: "failed", reason: "error", batchId: expect.any(String) });
  });

  it("a settings file that cannot be read during a run: the caller's link stands, nothing is written to it", async () => {
    const p = await project();
    await articles(1);
    await linked(linkOf(p));
    await rm(join(config, ZOTERO_SYNC_FILE));
    await mkdir(join(config, ZOTERO_SYNC_FILE));
    const r = await sync(linkOf(p));
    expect(r.outcome).toBe("finished");
    expect((await readdir(join(config, ZOTERO_SYNC_FILE))).length).toBe(0);
  });

  it("startBatch refused because the project was locked meanwhile is failed / project-locked, with no batch", async () => {
    const p = await project({ encrypted: true });
    await articles(1);
    await linked(linkOf(p));
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      if (req.path.startsWith("/keys/current")) repo.lockProject(p.id);
      return orig(req, host);
    };
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "project-locked" });
    await repo.unlockProject(p.id, "pw");
    expect(await batchDirs(repo, p.id)).toEqual([]);
  });

  it("an abort while startBatch runs (before the listener) still suspends the batch: stopped", async () => {
    const p = await project();
    await articles(30);
    await linked(linkOf(p));
    const ctl = new AbortController();
    let armed = false;
    const orig = z.serve.bind(z);
    z.serve = (req, host) => {
      if (req.path.startsWith("/keys/current")) armed = true;
      return orig(req, host);
    };
    const getProject = repo.getProject.bind(repo);
    repo.getProject = ((id: string) => {
      if (armed) ctl.abort();
      return getProject(id);
    }) as typeof repo.getProject;
    try {
      const r = await sync(await stored(), { signal: ctl.signal });
      expect(r).toMatchObject({ outcome: "stopped", reason: "stopped-by-you", batchId: expect.any(String) });
      expect((await findBatch(repo, p.id, r.batchId!))!.state).toBe("paused");
    } finally {
      repo.getProject = getProject;
    }
  });
});

describe("R244 (d) M9: the runner finds its unfinished batch without reading every batch record", () => {
  it("a quiet run with no unfinished batch reads no batch record at all", async () => {
    const p = await project();
    await articles(2);
    await sync(await linked(linkOf(p)));
    expect((await stored()).unfinished).toBeUndefined();
    batchReads.n = 0;
    expect((await sync(await stored())).outcome).toBe("up-to-date");
    expect(batchReads.n).toBe(0);
  });

  it("the hint names the unfinished batch: one record is read, and it is resumed", async () => {
    const p = await project();
    const stopped = await stoppedFirstSync(p);
    expect((await stored()).unfinished).toMatch(new RegExp(`/${stopped.batchId}$`, "u"));
    batchReads.n = 0;
    let readsBeforeBatch = -1;
    const r = await sync(await stored(), {}, { onBatch: () => void (readsBeforeBatch = batchReads.n) });
    expect(readsBeforeBatch).toBe(1);
    expect(r).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
    expect((await stored()).unfinished).toBeUndefined();
  });

  it("a wrong hint, or none in a settings file set aside, falls back to the scan and still resumes", async () => {
    const p = await project();
    const stopped = await stoppedFirstSync(p);
    await setZoteroSyncUnfinished(config, lib.id, U, p.id, "batch-0099/not-this-one");
    const ctl = new AbortController();
    const again = await sync(await stored(), { signal: ctl.signal }, { onBatch: stopAt(ctl, 4) });
    expect(again.batchId).toBe(stopped.batchId);
    await writeFile(join(config, ZOTERO_SYNC_FILE), "{ damaged");
    const r = await sync(linkOf(p));
    expect(r).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
  });
});

describe("R295 b: a sync the project's rules refuse says so", () => {
  const DENY = GOV.replace("captureMethods: [zotero_import]", "captureMethods: [downloader]");
  const pages = () => z.requests.filter((r) => /\/items(\?|$)/u.test(r.path) && /format=json|include=data/u.test(r.path));

  it("the rules refuse a new batch: failed / rules-denied, nothing changed here, no request after the refusal", async () => {
    const p = await project({ gov: DENY });
    await articles(3);
    await linked(linkOf(p));
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "rules-denied" });
    expect(r.batchId).toBeUndefined();
    expect(r.note).toBeUndefined();
    expect(pages()).toEqual([]);
    expect(sourceCount(p)).toBe(0);
    // The engine's own refusal text is neither in the record nor in the file.
    expect(JSON.stringify(await history())).not.toMatch(/capture|downloader|governance/iu);
    // (The engine audits the denial itself; no batch, no source.)
    expect(await batchDirs(repo, p.id)).toHaveLength(0);
  });

  it("the rules refuse the resumption of the link's own batch: failed / rules-denied, the batch left as it was", async () => {
    const p = await project();
    const stopped = await stoppedFirstSync(p);
    await setGov(p, DENY);
    const n = pages().length;
    const r = await sync(await stored());
    expect(r).toMatchObject({ outcome: "failed", reason: "rules-denied" });
    expect(r.note).toBeUndefined();
    expect(pages().length).toBe(n);
    // Not "ended for good": the rules can be changed back, and the same batch resumes.
    await setGov(p, GOV);
    const again = await sync(await stored());
    expect(again).toMatchObject({ outcome: "finished", batchId: stopped.batchId });
  });

  it("an older record with a reason this build knows reads as before", async () => {
    const p = await project();
    await articles(1);
    await linked(linkOf(p));
    z.failNext(50, 500);
    const r = await sync(await stored());
    expect(r.outcome).toBe("failed");
    expect(r.reason).not.toBe("rules-denied");
    expect((await history())[0]!.reason).toBe(r.reason);
  });
});
