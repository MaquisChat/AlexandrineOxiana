/**
 * R379, R386 b (FR-A13): POST /projects/:id/lock while a change of the encrypted project is being saved. The lock
 * answers at once and the project is locked for every reader; the change in progress keeps the key until it ends
 * (the key is never wiped inside it): its change-log lines open with the project's real key, never with zeros.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { openLine } from "../../../packages/library/src/repo/io.js";
import { importChange, projectDataKey } from "../../../packages/library/src/repo/repo.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

let tmp: string;
let deps: Deps;
let svc: LibraryService;

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  return { status: res.statusCode, body: res.body, json: (() => { try { return res.json(); } catch { return undefined; } })() };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-svc-lock-race-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  const logStream = new Writable({ write: (_c, _e, cb) => cb() });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null });
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /projects/:id/lock while a change is being saved (R379)", () => {
  it("answers at once, locked for every reader; the change's lines open with the real key", async () => {
    const path = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
    const created = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: true, passphrase: PASS } } });
    expect(created.status, created.body).toBe(200);
    const pid = created.json.project.id as string;
    const repo = svc.state.session!.repo;
    const key = Buffer.from(projectDataKey(repo, pid)!.key);

    // A slow change: its function waits on a gate, then records a participant's details.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const change = importChange(repo, pid, STORE, async (ops) => {
      entered();
      await gate;
      ops.tx.record("project", pid, { note: "" }, { note: "Participant Jane Doe, Leeds" });
    }, { op: "test.note" });
    await inside;

    expect((await call({ url: `/projects/${pid}/review` })).status).toBe(200);
    // R386 b: the lock answers at once; the project is locked for every reader (the list says so) while the
    // change in progress still holds the key, which is wiped when that change ends.
    const lock = await call({ method: "POST", url: `/projects/${pid}/lock` });
    expect(lock.status).toBe(200);
    expect(lock.json).toEqual({ unlocked: false });
    const list = await call({ url: "/projects" });
    const shown = (list.json.projects ?? list.json).find((x: { id: string }) => x.id === pid);
    expect(shown.unlocked).toBe(false);
    expect((await call({ url: `/projects/${pid}/review` })).status).toBe(423);
    release();
    await change;
    expect(repo.isUnlocked(pid)).toBe(false);
    const folder = repo.getProject(pid).folder;
    const dir = join(path, folder, "changes");
    const lines: string[] = [];
    for (const f of await readdir(dir)) lines.push(...(await readFile(join(dir, f), "utf8")).split("\n").filter((l) => l.trim()));
    const opened = lines.map((l) => {
      expect(() => openLine(Buffer.alloc(32), pid, l)).toThrow();
      return openLine(key, pid, l);
    });
    expect(opened.join("\n")).toContain("Participant Jane Doe, Leeds");
  });
});

describe("R435 a: POST /projects/:id/unlock overtaken by a lock", () => {
  it("answers that the project is locked and resumes nothing; the lock's clean-up is not undone", async () => {
    const path = join(tmp, "Lib");
    expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
    const a = await call({ method: "POST", url: "/projects", body: { name: "A", governanceYaml: GOV, encryption: { enabled: true, passphrase: PASS } } });
    expect(a.status, a.body).toBe(200);
    const b = await call({ method: "POST", url: "/projects", body: { name: "B", governanceYaml: GOV, encryption: { enabled: true, passphrase: PASS } } });
    expect(b.status, b.body).toBe(200);
    const pid = a.json.project.id as string;
    const other = b.json.project.id as string;
    const repo = svc.state.session!.repo;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    // Another project's change is held: the unlock's audit entry waits behind it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const change = importChange(repo, other, STORE, async () => {
      entered();
      await gate;
    }, { op: "test.held" });
    await inside;
    const state = svc.state;
    const resumed = [vi.spyOn(state, "resumeProject"), vi.spyOn(state, "resumeFind"), vi.spyOn(state, "runScheduledBackups")];
    const startWork = vi.spyOn(state, "startWork");
    const unlock = call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } });
    while (!repo.isUnlocked(pid)) await new Promise((r) => setTimeout(r, 5));
    const lock = await call({ method: "POST", url: `/projects/${pid}/lock` });
    expect(lock.status).toBe(200);
    expect(repo.isUnlocked(pid)).toBe(false);
    expect((await call({ url: `/projects/${pid}/review` })).status).toBe(423);
    const startsBefore = startWork.mock.calls.length;
    release();
    await change;
    const u = await unlock;
    expect(u.status, u.body).toBe(423);
    expect(u.json.error.code).toBe("PROJECT_LOCKED");
    for (const s of resumed) expect(s).not.toHaveBeenCalled();
    expect(startWork.mock.calls.slice(startsBefore).map((c) => c[0])).not.toContain("backup");
    expect(repo.isUnlocked(pid)).toBe(false);
    expect((await call({ url: `/projects/${pid}/review` })).status).toBe(423);
  });
});
