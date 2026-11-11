import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { newAttentionId, reasonOf, writeAttention, type UnrecordedAudit } from "./attention.js";
import { projectWarnings, recordOrMark, type Repo } from "./repo.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";

const NOW = "2026-11-09T14:30:00.000Z";
const OPEN = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;
let folder: string;

function deps(): Deps {
  return {
    clock: () => new Date(NOW),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}
const open = (l: Library) => openTestRepo(l, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(NOW), tz: "UTC" });
async function reopen(): Promise<Repo> {
  await lib.close();
  lib = await openLibrary(join(tmp, "Lib"), deps());
  repo = await open(lib);
  return repo;
}
async function events(): Promise<AuditEvent[]> {
  const dir = join(lib.root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}
const records = () => readdir(join(lib.root, folder, "attention")).catch(() => [] as string[]);
const unrecorded = (over: Partial<UnrecordedAudit> = {}): UnrecordedAudit => ({
  formatVersion: 1,
  id: newAttentionId(),
  kind: "audit-unrecorded",
  occurredAt: "2026-11-08T10:00:00.000Z",
  actor: "someone",
  device: "dev-B",
  action: "library.reconnect",
  details: { hint: "host-B:Lib" },
  state: "ready",
  reason: "EIO",
  ...over,
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-attention-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await open(lib);
  const p = (await repo.createProject({ name: "P", governanceYaml: OPEN, encryption: { enabled: false } })).project;
  pid = p.id;
  folder = p.folder;
});
afterEach(async () => {
  seams.failAuditAppendFor = undefined;
  seams.crashAt = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("Task 50: attention records", () => {
  it("reasonOf keeps an error code or name, never the message (which can hold paths)", () => {
    expect(reasonOf(Object.assign(new Error(`EACCES: permission denied, open '${tmp}/x'`), { code: "EACCES" }))).toBe("EACCES");
    expect(reasonOf(new TypeError(`bad ${tmp}`))).toBe("TypeError");
    expect(reasonOf("plain string")).toBe("Error");
  });

  it("recordOrMark records now when it can, and leaves no record", async () => {
    expect(await recordOrMark(repo, pid, "library.reconnect", { hint: "h" })).toBeUndefined();
    expect((await events()).at(-1)).toMatchObject({ action: "library.reconnect", decision: { result: "allow" } });
    expect(await records()).toEqual([]);
  });

  it("a recorded event is settled on open with the original actor, device and time, once", async () => {
    const rec = unrecorded();
    await writeAttention(lib.root, folder, rec);
    expect(await projectWarnings(repo, pid)).toEqual(["audit-unrecorded"]);
    const r = await reopen();
    const ev = (await events()).filter((e) => e.action === "library.reconnect");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      actor: "someone",
      device: "dev-B",
      at: NOW,
      decision: { result: "allow" },
      details: { hint: "host-B:Lib", attentionId: rec.id, recordedLate: { occurredAt: "2026-11-08T10:00:00.000Z", reason: "EIO" } },
    });
    expect(await projectWarnings(r, pid)).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("a record whose event is already in the log (crash before its removal) is removed without a second event", async () => {
    const rec = unrecorded();
    await writeAttention(lib.root, folder, rec);
    expect(await recordOrMark(repo, pid, "library.reconnect", { ...rec.details, attentionId: rec.id })).toBeUndefined();
    await reopen();
    expect((await events()).filter((e) => e.action === "library.reconnect")).toHaveLength(1);
    expect(await records()).toEqual([]);
  });

  it("a record that cannot be read is never removed and keeps the warning", async () => {
    await mkdir(join(lib.root, folder, "attention"), { recursive: true });
    await writeFile(join(lib.root, folder, "attention", `${newAttentionId()}.json`), "{ not json");
    const r = await reopen();
    expect(await projectWarnings(r, pid)).toEqual(["audit-unrecorded"]);
    expect(await records()).toHaveLength(1);
  });

  it("an append that fails on open keeps the record and blocks the project until reopened (R28 precedent)", async () => {
    await writeAttention(lib.root, folder, unrecorded());
    seams.failAuditAppendFor = pid;
    const r = await reopen();
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: pid, kind: "audit-append-failed-at-open" }));
    expect(await projectWarnings(r, pid)).toEqual(["audit-unrecorded"]);
    seams.failAuditAppendFor = undefined;
    const r2 = await reopen();
    expect(await projectWarnings(r2, pid)).toEqual([]);
  });

  it("recordOrMark: a failed append marks the project; a crash before the mark leaves nothing marked (the caller's journal covers it)", async () => {
    seams.failAuditAppendFor = pid;
    const w = await recordOrMark(repo, pid, "library.reconnect", { hint: "h" });
    expect(w).toMatch(/needing attention/);
    expect(await records()).toHaveLength(1);
    seams.crashAt = "before-attention-mark";
    await expect(recordOrMark(repo, pid, "library.relink", { files: 1 })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await records()).toHaveLength(1);
  });
});
