/**
 * Task 50 (R154 b): the library's own audit log and projects' attention marks are reachable from the
 * desktop UI (its token and origin only), with no absolute paths, and the interface is told when a
 * mark or refusal appears.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const NEEDS_ENCRYPTION = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;

type Inject = { method?: "GET" | "POST"; url: string; body?: unknown; headers?: Record<string, string> };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
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

async function pairToken(): Promise<string> {
  const p = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
  return c.json().token as string;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-svc-libaudit-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  const logStream = new Writable({ write: (_c, _e, cb) => cb() });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null, pairing: { confirmPerMinute: 100 } });
  const r = await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } });
  expect(r.status, r.body).toBe(200);
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("GET /libraries/audit and /libraries/audit/verify", () => {
  it("a refused creation is readable and verifiable; repeats are counted; no absolute path in the answer", async () => {
    let published = 0;
    const off = svc.state.events.subscribe((e: { type: string }) => {
      if (e.type === "library.state") published++;
    });
    for (let i = 0; i < 3; i++) {
      const r = await call({ method: "POST", url: "/projects", body: { name: "Secret study", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } } });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    // The interface is told: a state update after a refused creation.
    await new Promise((res) => setTimeout(res, 50));
    expect(published).toBeGreaterThanOrEqual(1);
    off();
    const page = await call({ url: "/libraries/audit?limit=10" });
    expect(page.status, page.body).toBe(200);
    expect(page.json.total).toBe(1);
    expect(page.json.events[0]).toMatchObject({ action: "store", decision: { result: "deny" }, details: { op: "project.create", name: "Secret study" } });
    expect(page.json.repeats).toMatchObject({ seq: 1, count: 2 });
    expect(page.body).not.toContain(tmp);
    const v = await call({ url: "/libraries/audit/verify" });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ ok: true, events: 1, anchored: true });
    expect((await call({ url: "/libraries/audit?limit=0" })).status).toBe(400);
  });

  it("refused for the extension token, a foreign origin, and with no token", async () => {
    const token = await pairToken();
    for (const url of ["/libraries/audit", "/libraries/audit/verify"]) {
      expect((await svc.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, origin: EXT } })).statusCode).toBe(403);
      expect((await call({ url, headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await svc.app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("with no library open: 409-class refusal in the standard error shape", async () => {
    await call({ method: "POST", url: "/libraries/close" });
    const r = await call({ url: "/libraries/audit" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys(r.json)).toEqual(["error"]);
  });
});

describe("GET /projects/:id/attention and POST …/set-aside", () => {
  async function projectWithMark(): Promise<{ pid: string; name: string }> {
    const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
    const pid = r.json.project.id as string;
    const dir = join(tmp, "Lib", "Projects", "Study", "attention");
    await mkdir(dir, { recursive: true });
    const name = "0123456789abcdef0123456789abcdef.json";
    await writeFile(join(dir, name), "{ damaged");
    return { pid, name };
  }

  it("lists marks, sets one aside with a reason (audited), and tells the interface", async () => {
    const { pid, name } = await projectWithMark();
    const list = await call({ url: `/projects/${pid}/attention` });
    expect(list.status).toBe(200);
    expect(list.json.marks).toEqual([{ id: name, kind: "unreadable", canSetAside: true }]);
    expect(list.body).not.toContain(tmp);
    expect((await call({ method: "POST", url: `/projects/${pid}/attention/${name}/set-aside`, body: {} })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${pid}/attention/nope.json/set-aside`, body: { reason: "x" } })).status).toBe(404);
    let published = 0;
    const off = svc.state.events.subscribe((e: { type: string }) => {
      if (e.type === "library.state") published++;
    });
    const r = await call({ method: "POST", url: `/projects/${pid}/attention/${name}/set-aside`, body: { reason: "Damaged by the disk" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ recordedIn: "project" });
    await new Promise((res) => setTimeout(res, 50));
    expect(published).toBeGreaterThanOrEqual(1);
    off();
    expect((await call({ url: `/projects/${pid}/attention` })).json.marks).toEqual([]);
    const audit = await call({ url: `/projects/${pid}/audit?limit=1` });
    expect(audit.json.events[0]).toMatchObject({ action: "delete", details: { op: "attention.set-aside", reason: "Damaged by the disk" } });
  });

  it("refused for the extension token and a foreign origin", async () => {
    const { pid, name } = await projectWithMark();
    const token = await pairToken();
    const ext = { authorization: `Bearer ${token}`, origin: EXT, "content-type": "application/json" };
    expect((await svc.app.inject({ method: "GET", url: `/projects/${pid}/attention`, headers: ext })).statusCode).toBe(403);
    expect((await svc.app.inject({ method: "POST", url: `/projects/${pid}/attention/${name}/set-aside`, headers: ext, payload: JSON.stringify({ reason: "x" }) })).statusCode).toBe(403);
    expect((await call({ method: "POST", url: `/projects/${pid}/attention/${name}/set-aside`, body: { reason: "x" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
});

describe("the interface is told when a mark may appear", () => {
  it("POST /libraries/relink publishes the library state", async () => {
    await mkdir(join(tmp, "search"), { recursive: true });
    let published = 0;
    const off = svc.state.events.subscribe((e: { type: string }) => {
      if (e.type === "library.state") published++;
    });
    const r = await call({ method: "POST", url: "/libraries/relink", body: { searchDir: join(tmp, "search") } });
    expect(r.status, r.body).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(published).toBeGreaterThanOrEqual(1);
    off();
  });
});
