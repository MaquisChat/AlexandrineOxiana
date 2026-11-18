/**
 * Task Z2: the resume route resumes a Zotero Web batch through resumeZoteroWebImport, so the resumed
 * batch asks Zotero only for what changed since the version it started from, and records the new
 * library version when it is done. Every other kind resumes as before (server.test.ts, R99 I3).
 *
 * Zotero is the in-memory stand-in (packages/library/tests/zotero/fake-zotero.ts), served as the
 * global dispatcher: the service's Web import takes none of its own. Nothing reaches the network.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its Web import uses) sets the global dispatcher.
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { useMemorySecrets } from "../../../packages/library/src/secrets-testing.js";
import { setSecret } from "../../../packages/library/src/secrets.js";
import { FakeZotero, guardNetwork } from "../../../packages/library/tests/zotero/fake-zotero.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const U = "user:42";

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let z: FakeZotero;
let secrets: ReturnType<typeof useMemorySecrets>;
let previous: Dispatcher;
let unguard: () => void;

beforeAll(() => {
  unguard = guardNetwork();
});
afterAll(() => unguard());

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-zresume-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  z = new FakeZotero();
  secrets = useMemorySecrets();
  await setSecret("zotero-api-key", z.key);
  previous = getGlobalDispatcher();
  setGlobalDispatcher(z.agent);
  await start();
});
afterEach(async () => {
  await svc?.close();
  // One way only: nothing but GET ever reached the stand-in.
  expect(z.requests.filter((r) => r.method !== "GET")).toEqual([]);
  setGlobalDispatcher(previous);
  secrets.restore();
  await z.agent.close();
  await rm(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  const logStream = new Writable({ write: (_c, _e, cb) => cb() });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null });
}

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
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

function nextEvent(pred: (e: { type: string; data: any }) => boolean): Promise<{ type: string; data: any }> {
  return new Promise((resolve) => {
    const off = svc.state.events.subscribe((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });
}

/** Pauses the batch inside its first `running` progress event with at least `n` items done (the run then waits between items). */
function holdBatch(n: number): Promise<unknown> {
  return nextEvent((e) => {
    if (e.type !== "import.progress" || e.data.state !== "running" || !(e.data.done >= n)) return false;
    const h = svc.state.session?.batches.get(e.data.batchId)?.handle;
    h?.pause();
    return h !== undefined;
  });
}

/** Every file named `name` under `dir`. */
async function findFiles(dir: string, name: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(`/${name}`) || f === name).map((f) => join(dir, f));
}

const addWithFile = async (title: string) => {
  const p = z.addItem(U, { itemType: "journalArticle", title });
  z.addItem(U, { itemType: "attachment", contentType: "application/pdf", filename: "f.pdf" }, { parent: p, file: { bytes: await buildPdf({ extra: title }) } });
};
const listings = () => z.requests.filter((r) => r.path.startsWith("/users/42/items?")).map((r) => new URL(r.path, "https://x.invalid").searchParams);
const ADAPTER = { kind: "zotero-web", libraryType: "user", libraryId: "42" };

describe("resuming a Zotero Web batch (Z2)", () => {
  it("the resume route asks since the batch's version and records the new one", async () => {
    const libPath = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path: libPath, name: "Lib" } })).status).toBe(200);
    const pr = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } });
    expect(pr.status, pr.body).toBe(200);
    const pid = pr.json.project.id as string;
    for (const t of ["One", "Two"]) await addWithFile(t);

    // A first, full run records the library version.
    expect((await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } })).status).toBe(200);
    await svc.state.idle();
    const v1 = z.libraryVersion(U);

    // A second run is held after its first item, and the app closes: the batch is left paused.
    for (const t of ["Three", "Four", "Five"]) await addWithFile(t);
    const held = holdBatch(1);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } })).json;
    await held;
    await svc.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    const state = async () => ((await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>).find((b) => b.batchId === batchId)?.state;
    expect(await state()).toBe("paused");

    z.requests.length = 0;
    const r = await call({ method: "POST", url: `/imports/${batchId}/resume` });
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    expect(await state()).toBe("finished");
    expect(listings().length).toBeGreaterThan(0);
    expect(listings().every((q) => q.get("since") === String(v1))).toBe(true);
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(5);

    // The version is recorded, in the project and in the batch record.
    const now = z.libraryVersion(U);
    const projects = await Promise.all((await findFiles(libPath, "project.json")).map(async (f) => JSON.parse(await readFile(f, "utf8"))));
    expect(projects.some((p) => p.project?.importSettings?.zoteroWeb?.[U]?.lastLibraryVersion === now)).toBe(true);
    const recs = await Promise.all((await findFiles(libPath, "batch.json")).map(async (f) => JSON.parse(await readFile(f, "utf8"))));
    const rec = recs.find((x) => x.id === batchId);
    expect(rec).toMatchObject({ adapterOptions: { zoteroSince: v1, zoteroFiles: true }, recordedLibraryVersion: now });
    // The key is in none of them.
    expect(JSON.stringify([projects, recs])).not.toContain(z.key);
  });

  it("the resume after a library move (resumeBatches) finishes a Zotero Web batch the same way (M2)", async () => {
    const libPath = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path: libPath, name: "Lib" } })).status).toBe(200);
    const pid = (await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } })).json.project.id as string;
    for (const t of ["One", "Two"]) await addWithFile(t);
    await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } });
    await svc.state.idle();
    for (const t of ["Three", "Four", "Five"]) await addWithFile(t);
    const held = holdBatch(1);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: ADAPTER } })).json;
    await held;
    await svc.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: libPath } })).status).toBe(200);
    // The path a move takes to put its paused batches back to work.
    svc.state.resumeBatches([{ projectId: pid, batchId }]);
    await svc.state.idle();
    const now = z.libraryVersion(U);
    const projects = await Promise.all((await findFiles(libPath, "project.json")).map(async (f) => JSON.parse(await readFile(f, "utf8"))));
    expect(projects.some((p) => p.project?.importSettings?.zoteroWeb?.[U]?.lastLibraryVersion === now)).toBe(true);
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(5);
  });
});
