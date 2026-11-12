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
import { IndexHandle, KeyRing, createIndexSink, deviceDeps, getMeta, openLibrary, openRepo, rememberLastOpenLibrary, setMeta, type Deps } from "@ao/library";
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
    expect(opened.json.index).toMatchObject({ state: "rebuilding" });
    // Until it finishes, the source list says so instead of passing an empty index off as the truth.
    const during = await call({ url: `/projects/${pid}/sources` });
    if (during.json.total === 0) expect(during.json.index).toMatchObject({ state: "rebuilding" });
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

    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    // Until the rebuild has completed, a search answer says the index is rebuilding or incomplete.
    const during = await call({ url: `/projects/${pid}/sources?text=pangolinannotation` });
    if (during.json.total === 0) expect(during.json.index?.state === "rebuilding" || during.json.incomplete === true).toBe(true);
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
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json).toMatchObject({ mode: "read-only", index: { state: "unavailable", reason: "locked-by-other-device" } });
    const list = await call({ url: `/projects/${pid}/sources` });
    expect(list.json.total).toBe(2);
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
    const { path, pid } = await libraryWithSources();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await deleteIndex(path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc!.state.idle();
    const r = await call({ method: "POST", url: "/libraries/rebuild-index" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ indexed: 2, lockedProjects: 0, errors: 0 });
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(2);
    expect(svc!.state.libraryState().index).toBeUndefined();
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
