/**
 * Opening a library (Task 46a): a missing or stale index is rebuilt in the background when the
 * library is opened (D8), and the library open when the service last ran is reopened at start, or
 * named as not found (D5).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexHandle, KeyRing, createIndexSink, deviceDeps, getMeta, openLibrary, openRepo, rebuildIndexIfNeeded, type Library, rememberLastOpenLibrary, setMeta, type Deps } from "@ao/library";
// Package-internal: the governed change an import makes (here, to give a source an annotation).
import { importChange } from "../../../packages/library/src/repo/repo.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const INDEX_FILES = ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"];

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent", ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST"; url: string; body?: unknown };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function pdf(name: string, title: string): Promise<string> {
  const p = join(tmp, "in", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  return p;
}

/** A library with a plain project holding two sources (through the service). */
async function libraryWithSources(): Promise<{ path: string; pid: string }> {
  const path = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
  expect(p.status, p.body).toBe(200);
  const pid = p.json.project.id as string;
  const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf("a.pdf", "Harbour ledger of 1932"), await pdf("b.pdf", "Salt marsh survey")] } });
  expect(att.status, att.body).toBe(200);
  return { path, pid };
}

const deleteIndex = async (path: string) => {
  for (const f of INDEX_FILES) await rm(join(path, f), { force: true });
};

/** Every event published until `until` is true for one (inclusive). */
function collect(until: (e: { type: string; data: any }) => boolean): Promise<Array<{ type: string; data: any }>> {
  const seen: Array<{ type: string; data: any }> = [];
  return new Promise((resolve) => {
    const off = svc!.state.events.subscribe((e) => {
      seen.push(e);
      if (until(e)) {
        off();
        resolve(seen);
      }
    });
  });
}

/**
 * A rebuild held at its start until released (the real one then runs), so a test can act while the
 * index is being rebuilt. Only the first `holdCalls` calls are held; a held call that is stopped
 * (the library closes or moves) rejects as the real one would.
 */
function heldRebuild(holdCalls = 1) {
  const waiting: Array<() => void> = [];
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const seam: typeof rebuildIndexIfNeeded = async (h, ring, lib, opts = {}) => {
    if (calls++ < holdCalls) {
      entered();
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason as Error), { once: true });
      });
    }
    return rebuildIndexIfNeeded(h, ring, lib, opts);
  };
  return { seam, started, release: () => waiting.splice(0).forEach((r) => r()) };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-open-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe("D8: opening a library rebuilds a missing or stale index", () => {
  beforeEach(() => start());

  it("a missing library.sqlite: the open says the index is rebuilding, progress is sent, then search finds the sources", async () => {
    const held = heldRebuild();
    await svc!.close();
    await start({ rebuildIndexIfNeeded: held.seam });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    let seenRebuilding = false;
    const events = collect((e) => e.type === "library.state" && e.data.open === true && e.data.index === undefined && seenRebuilding);
    const off = svc!.state.events.subscribe((e) => {
      if (e.type === "library.state" && (e.data as { index?: { state?: string } }).index?.state === "rebuilding") seenRebuilding = true;
    });
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    expect(opened.json.index).toMatchObject({ state: "rebuilding", partial: true });
    // Until it finishes, the source list says so instead of passing an empty index off as the truth.
    await held.started;
    const during = await call({ url: `/projects/${pid}/sources` });
    expect(during.json.total).toBe(0);
    expect(during.json.index).toMatchObject({ state: "rebuilding", partial: true });
    held.release();
    const seen = await events;
    off();
    await svc!.state.idle();
    expect(seen.some((e) => e.type === "job.progress" && e.data.kind === "index" && e.data.total === 2 && e.data.done === 2)).toBe(true);
    const after = await call({ url: `/projects/${pid}/sources` });
    expect(after.json.total).toBe(2);
    expect(after.json.index).toBeUndefined();
    expect((await call({ url: `/projects/${pid}/sources?text=ledger` })).json.items.map((i: { title: string }) => i.title)).toEqual(["Harbour ledger of 1932"]);
    expect((await call({ url: "/libraries" })).json.current.index).toBeUndefined();
    expect(svc!.state.libraryState().index).toBeUndefined();
  });

  it("a stale index (the files changed outside the app) is rebuilt at open", async () => {
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    // Another copy of the app (no index) adds a source.
    const lib = await openLibrary(path, deps);
    const ring = new KeyRing();
    const repo = await openRepo(lib, ring, { actor: "elsewhere", tz: "UTC" });
    await repo.createSource(
      pid,
      { projectIds: [], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "Tide notes" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    ring.clear();
    await lib.close();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    expect((await call({ url: `/projects/${pid}/sources?text=tide` })).json.total).toBe(1);
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(3);
  });

  it("R161: an index marked as needing a rebuild (an upgraded library) is rebuilt at open; the mark clears and annotation text is found", async () => {
    const { path, pid } = await libraryWithSources();
    const sid = (await call({ url: `/projects/${pid}/sources?text=ledger` })).json.items[0].id as string;
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    // The source gets an annotation, written with the index kept current...
    const lib = await openLibrary(path, deps);
    const ring = new KeyRing();
    const h = new IndexHandle(lib.root);
    const repo = await openRepo(lib, ring, { actor: "elsewhere", tz: "UTC", index: createIndexSink(h, { root: lib.root, keyRing: ring }) });
    await importChange(repo, pid, { action: "store", store: { identifiable: false, hasLocation: false } }, async (ops) => {
      const cur = await ops.readSource(sid);
      await ops.writeSource(cur, { ...cur, annotations: [{ id: sid, sourceId: sid, kind: "note", anchors: [], body: "pangolinannotation", author: "t", createdAt: new Date().toISOString() }] });
    }, { op: "test.annotations" });
    // ...then the index is made as an older one upgraded by migration 0002 leaves it: no annotation
    // rows, and the "rebuild needed" mark. Its change-log stamps are current: only the mark says stale.
    h.db.exec("DELETE FROM annotation_text; DELETE FROM annotation_chunks;");
    setMeta(h.db, "needsRebuild", "annotations");
    h.close();
    ring.clear();
    await lib.close();

    const held = heldRebuild();
    await svc!.close();
    await start({ rebuildIndexIfNeeded: held.seam });
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    // Marked: rebuilt at once. The list is whole (only annotations are missing), so it is not partial.
    expect(opened.json.index).toEqual({ state: "rebuilding", done: 0, total: 0 });
    // Until the rebuild has completed, a search answer says the index is rebuilding and incomplete.
    await held.started;
    const during = await call({ url: `/projects/${pid}/sources?text=pangolinannotation` });
    expect(during.json).toMatchObject({ total: 0, incomplete: true, index: { state: "rebuilding" } });
    held.release();
    await svc!.state.idle();
    const after = await call({ url: `/projects/${pid}/sources?text=pangolinannotation` });
    expect(after.json.items).toEqual([expect.objectContaining({ id: sid, matchedIn: "annotation" })]);
    expect(after.json.incomplete).toBeUndefined();
    expect(after.json.index).toBeUndefined();
    await svc!.close();
    svc = undefined;
    const check = new IndexHandle(path);
    try {
      expect(getMeta(check.db, "needsRebuild")).toBeUndefined();
    } finally {
      check.close();
    }
  });

  it("a current index is not rebuilt at open", async () => {
    const { path } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    let rebuilt = false;
    const off = svc!.state.events.subscribe((e) => {
      if (e.type === "job.progress" && e.data.kind === "index") rebuilt = true;
    });
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json.index).toBeUndefined();
    await svc!.state.idle();
    off();
    expect(rebuilt).toBe(false);
  });

  it("a read-only library cannot write an index: it says so, and lists its sources from the files", async () => {
    const { path, pid } = await libraryWithSources();
    // Task 69 (M3): one source marked gone from its platform, as profile capture marks it.
    const before = (await call({ url: `/projects/${pid}/sources` })).json.items as Array<{ id: string }>;
    const gone = before[0]!.id;
    const noticed = "2026-11-03T09:15:00.000Z";
    await svc!.state.session!.repo.updateSource(pid, gone, { availability: { status: "unavailable-on-platform", firstNoticedAt: noticed } });
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json).toMatchObject({ mode: "read-only", index: { state: "unavailable", reason: "locked-by-other-device" } });
    const list = await call({ url: `/projects/${pid}/sources` });
    expect(list.json.total).toBe(2);
    expect(list.json.limited).toBe(true);
    // Each row read from the files carries its availability (Task 69).
    for (const row of list.json.items as Array<{ id: string; availability: unknown }>) {
      expect(row.availability).toEqual(row.id === gone ? { status: "unavailable-on-platform", firstNoticedAt: noticed } : { status: "available" });
    }
    expect(list.json.index).toEqual({ state: "unavailable", reason: "locked-by-other-device" });
    expect(svc!.state.libraryState().index).toEqual({ state: "unavailable", reason: "locked-by-other-device" });
    // Nothing was written into the library by the open.
    expect(INDEX_FILES.some((f) => existsSync(join(path, f)))).toBe(false);
  });

  it("a locked encrypted project is rebuilt from its manifest, and completed when it is unlocked", async () => {
    const path = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
    const p = await call({ method: "POST", url: "/projects", body: { name: "Secret", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: PASS } } });
    expect(p.status, p.body).toBe(200);
    const pid = p.json.project.id as string;
    expect((await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf("s.pdf", "Confidential harbour interviews")] } })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    expect(svc!.state.libraryState().index).toBeUndefined();
    // Locked: rebuilt as far as its rules allow (from the plaintext manifest: a locked row, no title).
    const locked = await call({ url: `/projects/${pid}/sources` });
    expect(locked.json.total, locked.body).toBe(1);
    expect(locked.json.items[0]).toMatchObject({ locked: true, title: "" });
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/sources?text=confidential` })).json.total).toBe(1);
  });

  it("a rebuild that fails is reported (event and state), never silent; the library stays open", async () => {
    await svc!.close();
    await start({
      rebuildIndexIfNeeded: async () => {
        throw new Error(`disk trouble under ${join(tmp, "Lib")}`);
      },
    });
    const { path } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    const failed = collect((e) => e.type === "job.progress" && e.data.kind === "index" && e.data.ok === false);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const seen = await failed;
    await svc!.state.idle();
    const ev = seen.at(-1)!;
    expect(JSON.stringify(ev)).not.toContain(tmp);
    const st = svc!.state.libraryState();
    expect(st.index).toMatchObject({ state: "failed" });
    expect((st.index as { message: string }).message).toMatch(/could not be rebuilt/);
    expect(JSON.stringify(st)).not.toContain(tmp);
    expect((await call({ url: "/libraries" })).json.current.index).toMatchObject({ state: "failed" });
  });

  it("POST /libraries/rebuild-index (\"Rebuild library from folder\") rebuilds and clears a failed state", async () => {
    // The rebuild at open fails (once); the researcher then asks for one, which runs for real.
    let failOnce = true;
    await svc!.close();
    await start({
      rebuildIndexIfNeeded: async (...a) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("disk trouble");
        }
        return rebuildIndexIfNeeded(...a);
      },
    });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    expect(svc!.state.libraryState().index).toMatchObject({ state: "failed", partial: true });
    const r = await call({ method: "POST", url: "/libraries/rebuild-index" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ indexed: 2, lockedProjects: 0, errors: 0 });
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(2);
    expect(svc!.state.libraryState().index).toBeUndefined();
  });

  it("M3: \"Rebuild library from folder\" pressed while the open's rebuild runs waits for it, then rebuilds (no refusal)", async () => {
    const held = heldRebuild();
    await svc!.close();
    await start({ rebuildIndexIfNeeded: held.seam });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await held.started;
    const manual = call({ method: "POST", url: "/libraries/rebuild-index" });
    await new Promise((r) => setTimeout(r, 100));
    held.release();
    const r = await manual;
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ indexed: 2, lockedProjects: 0, errors: 0 });
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(2);
  });

  it("M4: a manual rebuild stopped by closing the library answers 409 in plain words, not a raw error", async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    await svc!.close();
    await start({
      // Only the researcher's (forced) rebuild is held; it stops when the library closes.
      rebuildIndexIfNeeded: async (h, ring, lib, opts = {}) => {
        if (opts.force) {
          entered();
          await new Promise<void>((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal!.reason as Error), { once: true }));
        }
        return rebuildIndexIfNeeded(h, ring, lib, opts);
      },
    });
    await libraryWithSources();
    await svc!.state.idle();
    const manual = call({ method: "POST", url: "/libraries/rebuild-index" });
    await started;
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const r = await manual;
    expect(r.status, r.body).toBe(409);
    expect(r.json.error.code).toBe("CONFLICT");
    expect(r.json.error.message).toMatch(/stopped because the library was closed or moved/);
    expect(r.body).not.toMatch(/AbortError|aborted/i);
  });

  it("closing the library while its index is rebuilding stops the rebuild and releases the lock", async () => {
    const { path } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const again = await openLibrary(path, deps);
    expect(again.mode).toBe("read-write");
    await again.close();
  });
});

describe("C1: a rebuild stopped half-way is never taken as complete", () => {
  /** Opens the library at `path` in a fresh service with the real rebuild; resolves once it is rebuilt. */
  async function reopenFresh(path: string) {
    await svc?.close();
    await start();
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    // The half-built index left behind is shown as being rebuilt, never as the library's content.
    expect(opened.json.index).toMatchObject({ state: "rebuilding", partial: true });
    await svc!.state.idle();
    expect(svc!.state.libraryState().index).toBeUndefined();
  }
  const attach = async (pid: string, name: string, title: string) => {
    const r = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf(name, title)] } });
    expect(r.status, r.body).toBe(200);
  };

  it("closed during the rebuild, after a write: the next open rebuilds and lists every source on disk", async () => {
    const held = heldRebuild();
    await start({ rebuildIndexIfNeeded: held.seam });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await held.started;
    await attach(pid, "c.pdf", "Written during the rebuild");
    // The list holds only what was written since: it says it is partial (the interface shows "being rebuilt").
    const during = await call({ url: `/projects/${pid}/sources` });
    expect(during.json).toMatchObject({ total: 1, index: { state: "rebuilding", partial: true } });
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await reopenFresh(path);
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(3);
  });

  it("a rebuild that throws, after a write: the state says failed and partial; the next open rebuilds every source", async () => {
    await start({
      rebuildIndexIfNeeded: async (h, ring, lib, opts = {}) =>
        rebuildIndexIfNeeded(h, ring, lib, {
          ...opts,
          onProgress: (d, t) => {
            opts.onProgress?.(d, t);
            if (d === 1) throw new Error("disk trouble");
          },
        }),
    });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    await attach(pid, "c.pdf", "Written after the failure");
    const list = await call({ url: `/projects/${pid}/sources` });
    expect(list.json).toMatchObject({ total: 1, index: { state: "failed", partial: true } });
    await reopenFresh(path);
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(3);
  });

  it("moved during the rebuild, after a write: at its new place it is rebuilt and lists every source", async () => {
    const held = heldRebuild();
    await start({ rebuildIndexIfNeeded: held.seam });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await held.started;
    await attach(pid, "c.pdf", "Written during the rebuild");
    const dest = join(tmp, "Moved", "Lib");
    await mkdir(dirname(dest), { recursive: true });
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    expect(moved.status, moved.body).toBe(200);
    expect(moved.body).toContain('"done":true');
    // The move stopped the rebuild; the library opened at its new place is rebuilt (not held now).
    await svc!.state.idle();
    expect(svc!.state.libraryState().index).toBeUndefined();
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(3);
  });

  it("M6: a write made before the staleness check has run does not hide a change made outside the app", async () => {
    const held = heldRebuild();
    await start({ rebuildIndexIfNeeded: held.seam });
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    // Another copy of the app (no index) adds a source: the index is stale.
    const lib = await openLibrary(path, deps);
    const ring = new KeyRing();
    const repo = await openRepo(lib, ring, { actor: "elsewhere", tz: "UTC" });
    await repo.createSource(
      pid,
      { projectIds: [], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "Tide notes" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    ring.clear();
    await lib.close();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    // Before the check runs, a write in the same project (it would refresh that project's stamp).
    await held.started;
    await attach(pid, "c.pdf", "Written before the check");
    held.release();
    await svc!.state.idle();
    expect((await call({ url: `/projects/${pid}/sources?text=tide` })).json.total).toBe(1);
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(4);
  });
});

describe("I1: the reopen at start is one tracked attempt", () => {
  /** Two known libraries, A (open last, so remembered) and B; the service is stopped. */
  async function twoLibraries(): Promise<{ a: string; b: string }> {
    await start();
    const b = join(tmp, "LibB");
    expect((await call({ method: "POST", url: "/libraries", body: { path: b, name: "LibB" } })).status).toBe(200);
    const a = join(tmp, "LibA");
    expect((await call({ method: "POST", url: "/libraries", body: { path: a, name: "LibA" } })).status).toBe(200);
    await svc!.close();
    svc = undefined;
    return { a, b };
  }
  /** An openLibrary whose opens of `slowRoot` wait until released (or forever). */
  function slowOpen(slowRoot: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seam: typeof openLibrary = async (root, d, o) => {
      if (root === slowRoot) await gate;
      return openLibrary(root, d, o);
    };
    return { seam, release };
  }
  /** A fake clock for the wait at start: records each timer, fired by the test. */
  function fakeTimers() {
    const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
    const setTimer = (fn: () => void, ms: number) => {
      const t = { ms, fire: fn, cleared: false };
      timers.push(t);
      return () => void (t.cleared = true);
    };
    return { timers, setTimer };
  }

  it("a library opened by the researcher meanwhile stays open; the late reopen is closed and its lock released", async () => {
    const { a, b } = await twoLibraries();
    const slow = slowOpen(a);
    await start({ openLibrary: slow.seam });
    const reopening = svc!.state.reopenLast();
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path: b } });
    expect(opened.status, opened.body).toBe(200);
    expect(opened.json.name).toBe("LibB");
    slow.release();
    await reopening;
    const libs = await call({ url: "/libraries" });
    expect(libs.json.current).toMatchObject({ name: "LibB" });
    expect(libs.json.reopening).toBeUndefined();
    // A's lock is free: it opens read-write elsewhere.
    const again: Library = await openLibrary(a, deps);
    try {
      expect(again.mode).toBe("read-write");
    } finally {
      await again.close();
    }
  });

  it("a library created or closed meanwhile also wins over the late reopen", async () => {
    const { a } = await twoLibraries();
    const slow = slowOpen(a);
    await start({ openLibrary: slow.seam });
    const reopening = svc!.state.reopenLast();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    slow.release();
    await reopening;
    expect((await call({ url: "/libraries" })).json.current).toBeUndefined();
  });

  it("a reopen that never settles: GET /libraries waits once, for 30 s on the clock, then every answer is prompt and says the last library is still being opened", async () => {
    const { a } = await twoLibraries();
    const slow = slowOpen(a); // never released
    const clock = fakeTimers();
    await start({ openLibrary: slow.seam, startupTimer: clock.setTimer });
    void svc!.state.reopenLast();
    let firstDone = false;
    const first = call({ url: "/libraries" }).then((r) => ((firstDone = true), r));
    // Waiting, on one 30-second timer.
    await new Promise((r) => setTimeout(r, 200));
    expect(firstDone).toBe(false);
    expect(clock.timers.map((t) => t.ms)).toEqual([30_000]);
    // A second request while the first waits shares the same wait (no new timer).
    const second = call({ url: "/libraries" });
    await new Promise((r) => setTimeout(r, 50));
    expect(clock.timers).toHaveLength(1);
    clock.timers[0]!.fire();
    for (const r of await Promise.all([first, second])) {
      expect(r.status).toBe(200);
      expect(r.json.current).toBeUndefined();
      expect(r.json.reopening).toEqual({ libraryId: expect.any(String), name: "LibA" });
    }
    // From now on, answers are at once (no timer, no wait).
    const t0 = Date.now();
    const third = await call({ url: "/libraries" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(third.json.reopening).toMatchObject({ name: "LibA" });
    expect(clock.timers).toHaveLength(1);
    // The chooser stays usable: opening another library supersedes the attempt.
    expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "LibC"), name: "LibC" } })).status).toBe(200);
    expect((await call({ url: "/libraries" })).json.reopening).toBeUndefined();
  });

  it("a reopen that settles before the deadline: the wait ends then, and its timer is cleared", async () => {
    await twoLibraries();
    const clock = fakeTimers();
    await start({ startupTimer: clock.setTimer });
    const reopening = svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    await reopening;
    expect(libs.json.current).toMatchObject({ name: "LibA" });
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]!.cleared).toBe(true);
  });
});

describe("D5: the library open when the service last ran is reopened at start", () => {
  it("reopens it (read-write), with no absolute path stored inside the library", async () => {
    await start();
    const { path } = await libraryWithSources();
    await svc!.close(); // the app quits with the library open
    svc = undefined;
    await start();
    await svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    expect(libs.json.current).toMatchObject({ name: "Lib", mode: "read-write" });
    expect(libs.json.notFound).toBeUndefined();
    const inside = await readFile(join(path, "library.json"), "utf8");
    expect(inside).not.toContain(tmp);
  });

  it("closing the library (Switch library) means the next start shows the chooser", async () => {
    await start();
    await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await svc!.close();
    svc = undefined;
    await start();
    await svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    expect(libs.json.current).toBeUndefined();
    expect(libs.json.notFound).toBeUndefined();
  });

  it("a library whose folder is gone is named as not found (for the “Library not found” screen), not opened", async () => {
    await start();
    const { path } = await libraryWithSources();
    const libraryId = (await call({ url: "/libraries" })).json.current.libraryId as string;
    await svc!.close();
    svc = undefined;
    await rename(path, `${path} (renamed)`);
    await start();
    await svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    expect(libs.status).toBe(200);
    expect(libs.json.current).toBeUndefined();
    expect(libs.json.notFound).toEqual({ libraryId, name: "Lib" });
    expect(libs.body).not.toContain(`${path} (renamed)`);
    // Once a library is open, nothing is named as not found any more.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: `${path} (renamed)` } })).status).toBe(200);
    expect((await call({ url: "/libraries" })).json.notFound).toBeUndefined();
  });

  it("a different library now at the remembered place is not taken for it", async () => {
    await start();
    const { path } = await libraryWithSources();
    const libraryId = (await call({ url: "/libraries" })).json.current.libraryId as string;
    await svc!.close();
    svc = undefined;
    await rm(path, { recursive: true, force: true });
    await start();
    expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Other" } })).status).toBe(200);
    await svc!.close();
    svc = undefined;
    // The app last had the first library open.
    await rememberLastOpenLibrary(libraryId, deps);
    await start();
    await svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    expect(libs.json.current).toBeUndefined();
    expect(libs.json.notFound).toMatchObject({ libraryId, name: "Lib" });
  });

  it("GET /libraries waits for the reopen at start", async () => {
    await start();
    await libraryWithSources();
    await svc!.close();
    svc = undefined;
    await start();
    const reopening = svc!.state.reopenLast();
    const libs = await call({ url: "/libraries" });
    await reopening;
    expect(libs.json.current).toMatchObject({ name: "Lib" });
  });

  /** Starts the entry point as a launcher does (R98, R155): the token on standard input, kept open. */
  async function runEntry(configDir: string): Promise<{ port: number; stop: () => Promise<void> }> {
    const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
    const env: Record<string, string | undefined> = { ...process.env, AO_SERVICE_PORT: "0", AO_CONFIG_DIR: configDir, AO_NO_WORKER: "1" };
    delete env.AO_LIBRARY;
    delete env.AO_SERVICE_TOKEN;
    const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: fileURLToPath(new URL("../", import.meta.url)), env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.on("error", () => {});
    child.stdin!.write(`${TOKEN}\n`);
    let out = "";
    let err = "";
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    // The end of standard input shuts the service down cleanly (R155).
    const stop = async () => {
      child.stdin!.end();
      await exited;
    };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout!.on("data", (d: Buffer) => {
          out += d.toString();
          const m = /AO_SERVICE_READY port=(\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        void exited.then(() => reject(new Error(`exited early: ${err}`)));
      });
      return { port, stop };
    } catch (e) {
      child.kill("SIGKILL");
      throw e;
    }
  }

  it("the entry point reopens the last library at start, from the settings folder it is given (R159), and only from there", async () => {
    await start();
    const { path } = await libraryWithSources();
    await svc!.close();
    svc = undefined;
    // Started as the shell starts it: the settings folder the shell chose (AO_CONFIG_DIR).
    const a = await runEntry(deps.appConfigDir);
    try {
      const r = await fetch(`http://127.0.0.1:${a.port}/libraries`, { headers: auth });
      expect(((await r.json()) as { current?: { name: string } }).current?.name).toBe("Lib");
    } finally {
      await a.stop();
    }
    // Another settings folder knows of no library: the chooser, nothing reopened.
    const b = await runEntry(join(tmp, "other-settings"));
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/libraries`, { headers: auth });
      const j = (await r.json()) as { current?: unknown; notFound?: unknown; libraries: unknown[] };
      expect(j.current).toBeUndefined();
      expect(j.notFound).toBeUndefined();
      expect(j.libraries).toEqual([]);
    } finally {
      await b.stop();
    }
    // What is remembered is kept in the settings folder, never in the library.
    expect(existsSync(join(deps.appConfigDir, "last-library.json"))).toBe(true);
    expect(existsSync(join(path, "last-library.json"))).toBe(false);
  }, 60_000);
});
