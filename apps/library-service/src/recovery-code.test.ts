/**
 * Task 61: POST /projects/:id/recovery-code (R134 c, R96). UI token only; the passphrase and the new
 * code never reach the log, an error body or the audit log; wrong passphrases are rate-limited per
 * project, together with unlock.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const WRONG = "a wrong passphrase of mine";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService;
let clock: { now: number };

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null, logLevel: "trace", now: () => new Date(clock.now), pairing: { confirmPerMinute: 100 }, ...over });
  return svc;
}

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
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function openNewLibrary(): Promise<string> {
  const path = join(tmp, "Lib");
  const r = await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } });
  expect(r.status, r.body).toBe(200);
  return path;
}

async function newProject(encrypted = true): Promise<{ pid: string; code?: string }> {
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: encrypted ? GOV : GOV.replace("required", "optional"), encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return { pid: r.json.project.id as string, code: r.json.recoveryCode as string | undefined };
}

const issue = (pid: string, body: unknown) => call({ method: "POST", url: `/projects/${pid}/recovery-code`, body });
const unlock = (pid: string, secret: string) => call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret } });
const lock = (pid: string) => call({ method: "POST", url: `/projects/${pid}/lock` });

async function auditText(libPath: string): Promise<string> {
  let out = "";
  for (const folder of await readdir(join(libPath, "Projects"))) {
    const dir = join(libPath, "Projects", folder, "audit");
    for (const f of await readdir(dir).catch(() => [] as string[])) out += await readFile(join(dir, f), "utf8");
  }
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-svc-recovery-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  clock = { now: Date.parse("2026-11-11T10:00:00Z") };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /projects/:id/recovery-code", () => {
  beforeEach(() => start());

  it("returns { recoveryCode } once; the old code stops opening the project, the new one and the passphrase do", async () => {
    await openNewLibrary();
    const { pid, code } = await newProject();
    const r = await issue(pid, { passphrase: PASS });
    expect(r.status, r.body).toBe(200);
    expect(Object.keys(r.json)).toEqual(["recoveryCode"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(r.json.recoveryCode).not.toBe(code);
    await lock(pid);
    expect((await unlock(pid, code!)).status).toBe(401);
    expect((await unlock(pid, r.json.recoveryCode)).status).toBe(200);
    await lock(pid);
    expect((await unlock(pid, PASS)).status).toBe(200);
  });

  it("status codes: wrong passphrase 401, missing passphrase 400, locked 423, unencrypted 400, unknown project 404", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    const wrong = await issue(pid, { passphrase: WRONG });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe("WRONG_PASSPHRASE");
    expect((await issue(pid, {})).status).toBe(400);
    expect((await issue(pid, { passphrase: 42 })).status).toBe(400);
    await lock(pid);
    const locked = await issue(pid, { passphrase: PASS });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe("PROJECT_LOCKED");
    const plain = (await newProject(false)).pid;
    const p = await issue(plain, { passphrase: PASS });
    expect(p.status).toBe(400);
    expect(p.json.error.message).toMatch(/not encrypted/i);
    expect((await issue("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", { passphrase: PASS })).status).toBe(404);
  });

  it("the extension token cannot use it (403), and no token is 401", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    const p = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
    const token = c.json().token as string;
    const ext = await svc.app.inject({ method: "POST", url: `/projects/${pid}/recovery-code`, headers: { authorization: `Bearer ${token}`, origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ passphrase: PASS }) });
    expect(ext.statusCode).toBe(403);
    expect(ext.json().error.code).toBe("FORBIDDEN");
    const none = await svc.app.inject({ method: "POST", url: `/projects/${pid}/recovery-code`, headers: { "content-type": "application/json" }, payload: JSON.stringify({ passphrase: PASS }) });
    expect(none.statusCode).toBe(401);
  });

  it("a read-only library refuses it with 409 READ_ONLY", async () => {
    const path = join(tmp, "Lib");
    await openNewLibrary();
    const { pid } = await newProject();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const at = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: at, heartbeatAt: at, user: "ana" }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json.mode).toBe("read-only");
    expect((await unlock(pid, PASS)).status).toBe(200);
    const r = await issue(pid, { passphrase: PASS });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("READ_ONLY");
  });

  it("the passphrase and the code never appear in the log, an error body or the audit log", async () => {
    const path = await openNewLibrary();
    const { pid } = await newProject();
    const bodies: string[] = [];
    bodies.push((await issue(pid, { passphrase: WRONG })).body);
    const ok = await issue(pid, { passphrase: PASS });
    const code = ok.json.recoveryCode as string;
    await lock(pid);
    bodies.push((await issue(pid, { passphrase: PASS })).body);
    bodies.push((await unlock(pid, WRONG)).body);
    expect(logs.length).toBeGreaterThan(0);
    const audit = await auditText(path);
    for (const secret of [PASS, WRONG, code, code.replace(/-/g, "")]) {
      expect(logs).not.toContain(secret);
      expect(audit).not.toContain(secret);
      for (const b of bodies) expect(b).not.toContain(secret);
    }
  });
});

describe("wrong passphrases are rate-limited per project, unlock and recovery code together", () => {
  beforeEach(() => start());

  it("after 5 wrong passphrases in a minute: 429 even for the right one, until the minute is over", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    const other = (await newProject()).pid;
    for (let i = 0; i < 3; i++) expect((await issue(pid, { passphrase: WRONG })).status).toBe(401);
    await lock(pid);
    for (let i = 0; i < 2; i++) expect((await unlock(pid, WRONG)).status).toBe(401);
    const limited = await unlock(pid, PASS);
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("RATE_LIMITED");
    // Another project is not affected.
    expect((await issue(other, { passphrase: PASS })).status).toBe(200);
    clock.now += 61_000;
    expect((await unlock(pid, PASS)).status).toBe(200);
    expect((await issue(pid, { passphrase: PASS })).status).toBe(200);
  });

  it("20 wrong passphrases at once: at most 5 are tried, the rest are refused with 429 (counted before verifying, one at a time)", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    const statuses = await Promise.all(Array.from({ length: 20 }, () => issue(pid, { passphrase: WRONG }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    const limited = await issue(pid, { passphrase: PASS });
    expect(limited.status).toBe(429);
    expect(limited.json.error.message).toMatch(/even the right passphrase/i);
  });

  it("concurrent wrong passphrases and wrong recovery codes on unlock are limited the same way", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    await lock(pid);
    const both = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? unlock(pid, WRONG) : call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789" } })).then((r) => r.status)),
    );
    expect(both.filter((s) => s === 401)).toHaveLength(5);
    expect(both.filter((s) => s === 429)).toHaveLength(7);
    expect((await unlock(pid, PASS)).status).toBe(429);
  });

  it("a request refused for another reason (locked) is not counted as a guess", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    await lock(pid);
    for (let i = 0; i < 6; i++) expect((await issue(pid, { passphrase: WRONG })).status).toBe(423);
    expect((await unlock(pid, PASS)).status).toBe(200);
  });

  it("a success clears the count", async () => {
    await openNewLibrary();
    const { pid } = await newProject();
    for (let i = 0; i < 4; i++) expect((await issue(pid, { passphrase: WRONG })).status).toBe(401);
    expect((await issue(pid, { passphrase: PASS })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await issue(pid, { passphrase: WRONG })).status).toBe(401);
    expect((await issue(pid, { passphrase: PASS })).status).toBe(200);
  });
});
