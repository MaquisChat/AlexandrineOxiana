/**
 * Task 50 (R154 b): the library's own audit log and projects' attention marks are reachable from the
 * desktop UI (its token and origin only), with no absolute paths, and the interface is told when a
 * mark or refusal appears.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, deviceDeps, restoreBackup, type Deps } from "@ao/library";
import { toApiError } from "./errors.js";
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
    // Identical refusals that day are dropped, not counted (N6).
    expect(page.json).not.toHaveProperty("repeats");
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
    expect(list.json.marks).toEqual([{ id: expect.stringMatching(/^u-[0-9a-f]{32}$/), kind: "unrecognised", name, canSetAside: true }]);
    expect(list.body).not.toContain(tmp);
    const id = list.json.marks[0].id as string;
    // A blank reason is refused by the policy engine itself, and audited (N7).
    const blank = await call({ method: "POST", url: `/projects/${pid}/attention/${id}/set-aside`, body: { reason: "  " } });
    expect(blank.status).toBe(403);
    expect((await call({ url: `/projects/${pid}/audit?limit=1` })).json.events[0]).toMatchObject({ action: "set-aside", decision: { result: "deny" } });
    expect((await call({ method: "POST", url: `/projects/${pid}/attention/u-${"0".repeat(32)}/set-aside`, body: { reason: "x" } })).status).toBe(404);
    expect((await call({ method: "POST", url: `/projects/${pid}/attention/nope.json/set-aside`, body: { reason: "x" } })).status).toBe(400);
    let published = 0;
    const off = svc.state.events.subscribe((e: { type: string }) => {
      if (e.type === "library.state") published++;
    });
    const r = await call({ method: "POST", url: `/projects/${pid}/attention/${id}/set-aside`, body: { reason: "Damaged by the disk" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ recordedIn: "project" });
    await new Promise((res) => setTimeout(res, 50));
    expect(published).toBeGreaterThanOrEqual(1);
    off();
    expect((await call({ url: `/projects/${pid}/attention` })).json.marks).toEqual([]);
    const audit = await call({ url: `/projects/${pid}/audit?limit=1` });
    expect(audit.json.events[0]).toMatchObject({ action: "set-aside", details: { op: "attention.set-aside", reason: "Damaged by the disk" } });
  });

  it("refused for the extension token and a foreign origin", async () => {
    const { pid } = await projectWithMark();
    const name = ((await call({ url: `/projects/${pid}/attention` })).json.marks[0].id) as string;
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

describe("N1 (R154 e): nothing is written into a library another device holds, on the service's own path", () => {
  it("POST /libraries/move/delete-old with the session's read-only repo keeps the marks on this computer", async () => {
    const created = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
    expect(created.status).toBe(200);
    const dest = join(tmp, "Moved");
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    const done = moved.body.trim().split("\n").map((l: string) => JSON.parse(l)).at(-1);
    expect(done.done, moved.body).toBe(true);
    // Another device takes the new copy; this app opens it read-only.
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    await acquireLock(dest, { ...deps, deviceId: "dev-B", hostname: "host-B", pid: process.pid + 1, isPidAlive: () => true });
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect(opened.status, opened.body).toBe(200);
    expect(svc.state.session!.lib.readOnlyReason).toBe("locked-by-other-device");
    const r = await call({ method: "POST", url: "/libraries/move/delete-old", body: { token: done.result.confirmToken } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.warnings.join(" ")).toMatch(/kept on this computer/);
    expect(r.body).not.toContain(tmp);
    expect(await readdir(join(dest, "Projects", "Study")).then((n) => n.includes("attention"))).toBe(false);
    const outbox = await readdir(join(tmp, "config", "attention-outbox"));
    expect(outbox).toHaveLength(1);
  }, 60_000);
});

describe("a refused restore (Task 50b): recorded where the audit screen reads, and answered in plain words", () => {
  // The service has no restore route: a restore is a library call. What reaches the interface is the
  // library's error through the service's error mapper, and the audit entries the audit routes serve.
  async function projectWithBackup(): Promise<{ pid: string; backup: string }> {
    const created = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
    expect(created.status, created.body).toBe(200);
    const pid = created.json.project.id as string;
    const b = await call({ method: "POST", url: `/projects/${pid}/backups` });
    expect(b.status, b.body).toBe(200);
    return { pid, backup: join(tmp, "Lib", "Backups", b.json.backup.file as string) };
  }

  it("refused by the policy engine: 403 with the reason, and the project's audit log has the refusal, without a path", async () => {
    const { pid, backup } = await projectWithBackup();
    // The project's rules cannot be read any more (the file was damaged outside the app).
    await writeFile(join(tmp, "Lib", "Projects", "Study", "governance.yaml"), "identifiability: [unclosed\n  nope: {");
    const err = await restoreBackup(svc.state.requireSession().repo, backup).catch((e: unknown) => e);
    const api = toApiError(err);
    expect([api.status, api.code]).toEqual([403, "POLICY_DENIED"]);
    expect(api.reason).toMatch(/^Policy could not be evaluated/);
    expect(`${api.message} ${api.reason}`).not.toContain(tmp);
    const page = await call({ url: `/projects/${pid}/audit?limit=5` });
    expect(page.status, page.body).toBe(200);
    const denied = (page.json.events as Array<{ action: string; decision?: { result: string; reason?: string }; details?: Record<string, unknown> }>).filter((e) => e.action === "restore");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ decision: { result: "deny", reason: api.reason }, details: { op: "project.restore" } });
    expect(page.body).not.toContain(tmp);
  });

  it("refused because a project's audit log does not hold together: 400 with the plain message, and the library's audit log has the refusal, without a path", async () => {
    const { backup } = await projectWithBackup();
    const dir = join(tmp, "Lib", "Projects", "Study", "audit");
    const segment = join(dir, (await readdir(dir)).sort()[0]!);
    const lines = (await readFile(segment, "utf8")).split("\n");
    const first = JSON.parse(lines[0]!) as { actor: string };
    lines[0] = JSON.stringify({ ...first, actor: "someone else" });
    await writeFile(segment, lines.join("\n"));
    const err = await restoreBackup(svc.state.requireSession().repo, backup).catch((e: unknown) => e);
    const api = toApiError(err);
    expect([api.status, api.code]).toEqual([400, "VALIDATION"]);
    expect(api.message).toMatch(/audit log of the project "Study" does not hold together/);
    expect(api.message).not.toContain(tmp);
    const page = await call({ url: "/libraries/audit?limit=10" });
    expect(page.status, page.body).toBe(200);
    expect(page.json.events[0]).toMatchObject({ action: "restore", decision: { result: "deny", reason: api.message }, details: { op: "project.restore", name: "Study" } });
    expect(page.body).not.toContain(tmp);
    expect((await call({ url: "/libraries/audit/verify" })).json).toMatchObject({ ok: true });
    // The way out is named (R179).
    expect(api.message).toMatch(/can be restored into another library/);
  });

  it("R179: a file that is not a readable backup: 400 with the plain message, and the library's audit log names the file and its SHA-256, without a path", async () => {
    await projectWithBackup();
    const stray = join(tmp, "holiday photos.zip");
    await writeFile(stray, "these bytes are not an archive");
    const err = await restoreBackup(svc.state.requireSession().repo, stray).catch((e: unknown) => e);
    const api = toApiError(err);
    expect(api.status).toBe(400);
    expect(`${api.message} ${api.reason ?? ""}`).not.toContain(tmp);
    const page = await call({ url: "/libraries/audit?limit=10" });
    expect(page.status, page.body).toBe(200);
    expect(page.json.events[0]).toMatchObject({
      action: "restore",
      decision: { result: "deny" },
      details: { op: "project.restore", notABackup: true, file: "holiday photos.zip", backupSha256: createHash("sha256").update("these bytes are not an archive").digest("hex"), sha256Covers: "the whole file" },
    });
    expect(page.body).not.toContain(tmp);
  });
});
