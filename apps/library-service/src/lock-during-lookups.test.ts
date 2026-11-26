/**
 * FR-767 (as FR-759 and R600 I2; R30, R50): an encrypted project locked while a lookup made for it is in the air. The
 * lock route purges the lookup client's sensitive answers at once; the late answer lands after that purge. Once the
 * work that asked has ended and the project is no longer unlocked, nothing looked up for it stays in memory — on every
 * path that hands the session's lookup client to background work for a project: Bulk Import, a watched folder's
 * bring-in, the Zotero Web import and its resume, and the Zotero sync.
 *
 * Zotero is the in-memory stand-in (packages/library/tests/zotero/fake-zotero.ts); the metadata services are made up on
 * the same agent. Nothing reaches the network.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its lookups use) sets the global dispatcher.
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { buildDoiPdf, buildPdf } from "../../../tests/fixtures/generate.mjs";
import { useMemorySecrets } from "../../../packages/library/src/secrets-testing.js";
import { setSecret } from "../../../packages/library/src/secrets.js";
import { FakeZotero, guardNetwork } from "../../../packages/library/tests/zotero/fake-zotero.js";
import { FolderGrants } from "./folder-grants.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const PASS = "correct horse battery staple";
/** Lookups allowed (a file's title is searched at OpenAlex; a DOI is looked up at Crossref, then OpenAlex). */
const LOOKUP_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
`;
const U = "user:42";
const CROSSREF = "https://api.crossref.org";
const OPENALEX = "https://api.openalex.org";

/** Holds every request to `origin` while armed, until released; the answer then comes from the agent below. */
class Held extends Dispatcher {
  origin = "";
  private gate!: Promise<void>;
  release!: () => void;
  private arrived!: () => void;
  atGate!: Promise<void>;
  /** FR-769: the origin of every request handed to this dispatcher (held or not), in order. */
  readonly sent: string[] = [];
  constructor(private readonly inner: Dispatcher) {
    super();
  }
  arm(origin: string): void {
    this.origin = origin;
    this.gate = new Promise<void>((r) => (this.release = r));
    this.atGate = new Promise<void>((r) => (this.arrived = r));
  }
  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.sent.push(String(opts.origin));
    if (!this.origin || !String(opts.origin).startsWith(this.origin)) return this.inner.dispatch(opts, handler);
    this.arrived();
    void this.gate.then(() => this.inner.dispatch(opts, handler));
    return true;
  }
  override close(): Promise<void> {
    return this.inner.close();
  }
  override destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;
let z: FakeZotero;
let held: Held;
let grants: FolderGrants;
let secrets: { restore(): void };
let previous: Dispatcher;
let unguard: () => void;

beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-lock-lookups-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  z = new FakeZotero();
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", z.key);
  // The made-up metadata services: nothing is found (a DOI is not known; a title search finds no work).
  z.agent
    .get(CROSSREF)
    .intercept({ path: (p: string) => p.startsWith("/works"), method: "GET" })
    .reply(404, "")
    .persist();
  z.agent
    .get(OPENALEX)
    .intercept({ path: (p: string) => p.startsWith("/works"), method: "GET" })
    .reply((o: { path: string }) =>
      o.path.startsWith("/works?") ? { statusCode: 200, data: JSON.stringify({ meta: { count: 0 }, results: [] }), responseOptions: { headers: { "content-type": "application/json" } } } : { statusCode: 404, data: "" },
    )
    .persist();
  held = new Held(z.agent);
  previous = getGlobalDispatcher();
  setGlobalDispatcher(held);
  await start();
});
afterEach(async () => {
  held.release?.();
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  secrets.restore();
  await z.agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  grants = new FolderGrants();
  const logStream = new Writable({ write: (_c, _e, cb) => cb() });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null, watchStabilityMs: 50, folderGrants: grants });
}

async function call(r: { method?: "GET" | "POST" | "PUT"; url: string; body?: unknown }) {
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

/** A new library with one encrypted (unlocked) project that may look things up. */
async function sealedProject(): Promise<{ libPath: string; pid: string }> {
  const libPath = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path: libPath, name: "Lib" } })).status).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Sealed", governanceYaml: LOOKUP_GOV, encryption: { enabled: true, passphrase: PASS } } });
  expect(p.status, p.body).toBe(200);
  return { libPath, pid: p.json.project.id as string };
}

async function pdfIn(dir: string, name: string, title: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  return p;
}

/** The sensitive answers left in the session's lookup client's memory. */
function sensitiveInMemory(): number {
  const memory = (svc!.state.session!.http as unknown as { memory: Map<string, { sensitive: boolean }> }).memory;
  return [...memory.values()].filter((e) => e.sensitive).length;
}

/** The lookup is in the air: the project is locked (the route purges), then the late answer lands. */
async function lockThenAnswer(pid: string): Promise<void> {
  await held.atGate;
  expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
  expect(sensitiveInMemory()).toBe(0);
  held.release();
}

function nextEvent(pred: (e: { type: string; data: any }) => boolean): Promise<{ type: string; data: any }> {
  return new Promise((resolve) => {
    const off = svc!.state.events.subscribe((e) => {
      if (pred(e as { type: string; data: any })) {
        off();
        resolve(e as { type: string; data: any });
      }
    });
  });
}

/** A Zotero item with a DOI and no title: its DOI is looked up (Crossref, then OpenAlex), as a titled item's is not. */
const addWithDoi = async (doi: string) => {
  const p = z.addItem(U, { itemType: "journalArticle", DOI: doi });
  z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: p, file: { bytes: await buildPdf({ extra: doi }) } });
};
const ZOTERO = { kind: "zotero-web", libraryType: "user", libraryId: "42" };

describe("FR-767: a lock while a lookup of background work is in the air", () => {
  it("Bulk Import: the late answer is not kept in memory once the batch has ended", async () => {
    const { pid } = await sealedProject();
    const dir = join(tmp, "Desktop", "Harbour");
    await pdfIn(dir, "sealed-notes.pdf", "Notes from the sealed harbour interviews");
    held.arm(OPENALEX);
    onTestFinished(() => held.release());
    const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } });
    expect(r.status, r.body).toBe(200);
    await lockThenAnswer(pid);
    await svc!.state.idle();
    expect(sensitiveInMemory()).toBe(0);
  });

  it("a watched folder's bring-in: the late answer is not kept in memory once the bring-in has ended", async () => {
    const { pid } = await sealedProject();
    const dir = join(tmp, "drive", "Field");
    await mkdir(dir, { recursive: true });
    const id = randomBytes(16).toString("hex");
    grants.add(id, dir);
    const added = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: id } });
    expect(added.status, added.body).toBe(201);
    held.arm(OPENALEX);
    onTestFinished(() => held.release());
    // The watch pauses for the lock once the bring-in has ended (its attach refused at the store by the lock).
    const paused = new Promise<void>((resolve) => {
      const before = svc!.state.onWatchStatus;
      svc!.state.onWatchStatus = (s, projectId, st) => {
        before?.(s, projectId, st);
        if (projectId === pid && st.state === "locked") resolve();
      };
    });
    await pdfIn(dir, "sealed-notes.pdf", "Notes from the sealed harbour interviews");
    await lockThenAnswer(pid);
    await paused;
    expect(sensitiveInMemory()).toBe(0);
  });

  it("the Zotero Web import: the late answer is not kept in memory once the batch has ended", async () => {
    const { pid } = await sealedProject();
    await addWithDoi("10.5555/sealed.1");
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ZOTERO } });
    expect(r.status, r.body).toBe(200);
    await lockThenAnswer(pid);
    await svc!.state.idle();
    expect(sensitiveInMemory()).toBe(0);
  });

  it("the Zotero Web import's resume: the late answer is not kept in memory once the resumed batch has ended", async () => {
    const { libPath, pid } = await sealedProject();
    await addWithDoi("10.5555/sealed.1");
    await addWithDoi("10.5555/sealed.2");
    // A first run is paused after its first item, and the app closes: the batch is left paused.
    const pausedRun = nextEvent((e) => {
      if (e.type !== "import.progress" || e.data.state !== "running" || !(e.data.done >= 1)) return false;
      const h = svc!.state.session?.batches.get(e.data.batchId)?.handle;
      h?.pause();
      return h !== undefined;
    });
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ZOTERO } })).json;
    await pausedRun;
    await svc!.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    const r = await call({ method: "POST", url: `/imports/${batchId}/resume` });
    expect(r.status, r.body).toBe(200);
    await lockThenAnswer(pid);
    await svc!.state.idle();
    expect(sensitiveInMemory()).toBe(0);
  });

  it("the Zotero sync: the late answer is not kept in memory once the sync's run has ended", async () => {
    const { pid } = await sealedProject();
    await addWithDoi("10.5555/sealed.1");
    const saved = await call({ method: "PUT", url: "/zotero/sync/settings", body: { automatic: false, everyMinutes: 60, links: [{ ref: U, projectId: pid, structure: "collections", duplicates: "merge" }] } });
    expect(saved.status, saved.body).toBe(200);
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    const r = await call({ method: "POST", url: "/zotero/sync/run", body: {} });
    expect(r.status, r.body).toBe(202);
    await lockThenAnswer(pid);
    await svc!.state.zoteroSync.idle();
    await svc!.state.idle();
    expect(sensitiveInMemory()).toBe(0);
  });
});

/** The requests to the metadata services among `sent` (Zotero's own requests are not lookups). */
const lookupsIn = (sent: string[]) => sent.filter((o) => o.startsWith(CROSSREF) || o.startsWith(OPENALEX));

/** The batch's last word: its first `import.progress` event that is not "running". */
const batchEnd = (batchId: () => string | undefined) => nextEvent((e) => e.type === "import.progress" && e.data.batchId === batchId() && e.data.state !== "running");

describe("FR-769: at a project's lock, its running imports and attaches ask nothing more for it", () => {
  it("the Zotero Web import: after the lock no further lookup is sent; the batch ends as at a lock, no item failed", async () => {
    const { pid } = await sealedProject();
    await addWithDoi("10.5555/sealed.1");
    await addWithDoi("10.5555/sealed.2");
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    let batchId: string | undefined;
    const ended = batchEnd(() => batchId);
    const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ZOTERO } });
    expect(r.status, r.body).toBe(200);
    batchId = r.json.batchId as string;
    await held.atGate;
    const before = held.sent.length;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    held.release();
    const end = await ended;
    await svc!.state.idle();
    // Before FR-769 the run asked OpenAlex for the same item after Crossref's late answer.
    expect(lookupsIn(held.sent.slice(before))).toEqual([]);
    expect(end.data.state).toBe("failed");
    expect(end.data.counts?.failed ?? 0).toBe(0);
    expect(sensitiveInMemory()).toBe(0);
    // It stays resumable, and asks again after the unlock (a fresh stop: the old one ended with the lock).
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    const afterUnlock = held.sent.length;
    const resumedEnd = batchEnd(() => batchId);
    const resumed = await call({ method: "POST", url: `/imports/${batchId}/resume` });
    expect(resumed.status, resumed.body).toBe(200);
    expect((await resumedEnd).data.state).toBe("finished");
    expect(lookupsIn(held.sent.slice(afterUnlock))).toContain(CROSSREF);
  });

  it("an attach: after the lock no further lookup is sent for its file, which ends as locked", async () => {
    const { pid } = await sealedProject();
    const dir = join(tmp, "Desktop");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "article.pdf");
    await writeFile(file, await buildDoiPdf());
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    const attached = call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [file] } });
    await held.atGate;
    const before = held.sent.length;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    held.release();
    const r = await attached;
    expect(r.status, r.body).toBe(200);
    expect(lookupsIn(held.sent.slice(before))).toEqual([]);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].outcome).toBe("failed");
    expect(r.json.items[0].reason).toMatch(/locked/i);
    expect(sensitiveInMemory()).toBe(0);
  });

  it("another project's attach on the same lookup client goes on untouched by the lock", async () => {
    const { pid } = await sealedProject();
    const other = await call({ method: "POST", url: "/projects", body: { name: "Open", governanceYaml: LOOKUP_GOV, encryption: { enabled: true, passphrase: PASS } } });
    expect(other.status, other.body).toBe(200);
    const oid = other.json.project.id as string;
    const dir = join(tmp, "Desktop");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "article.pdf");
    await writeFile(file, await buildDoiPdf());
    held.arm(CROSSREF);
    onTestFinished(() => held.release());
    const attached = call({ method: "POST", url: `/projects/${oid}/attach`, body: { paths: [file] } });
    await held.atGate;
    const before = held.sent.length;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    held.release();
    const r = await attached;
    expect(r.status, r.body).toBe(200);
    // Crossref knew nothing: OpenAlex is asked next, for the project that was not locked.
    expect(lookupsIn(held.sent.slice(before)).some((o) => o.startsWith(OPENALEX))).toBe(true);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].outcome).not.toBe("failed");
  });
});
