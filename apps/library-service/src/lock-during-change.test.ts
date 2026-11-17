/**
 * R379 (FR-A13): POST /projects/:id/lock while a change of the encrypted project is being saved. The lock waits
 * for that change (it never lands inside it) and answers after it; the change's change-log lines open with the
 * project's real key, never with an all-zero one.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("answers after the change; the change's lines open with the real key", async () => {
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

    const order: string[] = [];
    const lock = call({ method: "POST", url: `/projects/${pid}/lock` }).then((r) => {
      order.push("lock answered");
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    expect(repo.isUnlocked(pid)).toBe(true);
    release();
    await change.then(() => order.push("change committed"));
    expect((await lock).status).toBe(200);
    expect(order).toEqual(["change committed", "lock answered"]);
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
