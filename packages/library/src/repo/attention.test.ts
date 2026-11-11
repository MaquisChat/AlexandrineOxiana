import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { newAttentionId, readOutbox, reasonOf, writeAttention, writeOutbox, type UnrecordedAudit } from "./attention.js";
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
      details: { hint: "host-B:Lib", attentionId: rec.id, recordedLate: { occurredAt: "2026-11-08T10:00:00.000Z", reason: "EIO", by: "dev-A" } },
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
    expect(await projectWarnings(r, pid)).toEqual(["attention-unreadable"]);
    expect(await records()).toHaveLength(1);
  });

  it("an append that fails on open keeps the record and blocks the project until reopened (R28 precedent)", async () => {
    await writeAttention(lib.root, folder, unrecorded());
    seams.failAuditAppendFor = pid;
    const r = await reopen();
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: pid, kind: "audit-append-failed-at-open" }));
    expect(await projectWarnings(r, pid)).toEqual(["audit-unrecorded-blocked"]);
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

describe("R154 c: a repair takes no instruction from a record on disk", () => {
  const planted = async (body: Record<string, unknown>) => {
    const id = newAttentionId();
    await mkdir(join(lib.root, folder, "attention"), { recursive: true });
    await writeFile(join(lib.root, folder, "attention", `${id}.json`), JSON.stringify({ formatVersion: 1, id, occurredAt: NOW, actor: "x", device: "dev-B", ...body }));
    return id;
  };

  it("L3: a planted permissions record naming project.json with mode 0o777 changes nothing and is never audited as restricted", async () => {
    const pj = join(lib.root, folder, "project.json");
    await chmod(pj, 0o644);
    await planted({ kind: "permissions-not-set", files: [`${folder}/project.json`], mode: 0o777, action: "library.relink" });
    const r = await reopen();
    expect((await stat(pj)).mode & 0o777).toBe(0o644);
    expect((await events()).some((e) => e.action === "library.permissions-restricted")).toBe(false);
    // Not a valid record: kept, shown, and can only be set aside.
    expect(await projectWarnings(r, pid)).toEqual(["attention-unreadable"]);
  });

  it("a permissions record names sources only; the repair applies the code's own mode, never widens, verifies and audits what it did", async () => {
    await writeFile(join(tmp, "in.pdf"), "%PDF body");
    const draft = {
      projectIds: [],
      type: "article-journal" as const,
      title: { variants: [{ lang: "en", kind: "original" as const, value: "T" }] },
      creators: [],
      issued: "2025",
      identifiers: {},
      caseAttributes: {},
      availability: { status: "available" as const },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    const prov = { captureMethod: "manual_upload" as const, capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" as const }, identifiable: false };
    const src = await repo.createSource(pid, draft, [{ path: join(tmp, "in.pdf"), role: "original", handling: "copy" }], { provenance: prov });
    const file = join(lib.root, src.assets[0]!.path);
    await chmod(file, 0o644);
    await planted({ kind: "permissions-not-set", sourceIds: [src.source.id], action: "library.relink" });
    const r = await reopen();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const ev = (await events()).filter((e) => e.action === "library.permissions-restricted");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ sources: 1, mode: "600", after: "library.relink" });
    expect((ev[0]!.details as { files: number }).files).toBeGreaterThanOrEqual(1);
    expect(await projectWarnings(r, pid)).toEqual([]);
  });

  it("a permissions record that carries a mode or file list is not acted on", async () => {
    await planted({ kind: "permissions-not-set", sourceIds: [], files: ["x"], mode: 0o600, action: "library.relink" });
    const r = await reopen();
    expect(await projectWarnings(r, pid)).toEqual(["attention-unreadable"]);
  });

  it("M3: an unrecorded-audit record may only name the actions this task records, and no transaction", async () => {
    await planted({ kind: "audit-unrecorded", action: "key.recovery-activated", details: { op: "x" }, state: "ready" });
    await planted({ kind: "audit-unrecorded", action: "library.reconnect", details: { txn: "deadbeef" }, state: "ready" });
    await planted({ kind: "audit-unrecorded", action: "library.reconnect", decision: { result: "deny", reason: "r" }, details: {}, state: "ready" });
    const r = await reopen();
    expect((await events()).some((e) => e.action === "key.recovery-activated" || e.details?.txn === "deadbeef" || e.action === "library.reconnect")).toBe(false);
    expect(await projectWarnings(r, pid)).toEqual(["attention-unreadable"]);
    expect(await records()).toHaveLength(3);
  });
});

describe("R154 e: the device-local outbox", () => {
  it("a crash after delivering (event appended, outbox file not yet removed) never records it twice", async () => {
    const rec = unrecorded();
    await writeOutbox(join(tmp, "config"), lib.id, pid, rec);
    expect(await projectWarnings(repo, pid)).toEqual(["audit-waiting"]);
    // The event is already in the log with this id: as if the process died right after the append.
    expect(await recordOrMark(repo, pid, "library.reconnect", { ...rec.details, attentionId: rec.id })).toBeUndefined();
    const r = await reopen();
    expect((await events()).filter((e) => e.action === "library.reconnect")).toHaveLength(1);
    expect(await readOutbox(join(tmp, "config"), lib.id)).toEqual([]);
    expect(await projectWarnings(r, pid)).toEqual([]);
  });

  it("an entry for a project that cannot take its event now moves into the project, never lost", async () => {
    await writeOutbox(join(tmp, "config"), lib.id, pid, unrecorded());
    const seg = join(lib.root, folder, "audit", "0001.jsonl");
    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"actor":"tester"', '"actor":"forged"');
    await writeFile(seg, lines.join("\n"));
    const r = await reopen();
    expect(await readOutbox(join(tmp, "config"), lib.id)).toEqual([]);
    expect(await records()).toHaveLength(1);
    expect(await projectWarnings(r, pid)).toEqual(["audit-unrecorded-blocked"]);
  });

  it("an entry whose record is not valid is never delivered", async () => {
    await writeOutbox(join(tmp, "config"), lib.id, pid, { ...unrecorded(), action: "key.unlock" });
    await reopen();
    expect((await events()).some((e) => e.action === "key.unlock" && e.device === "dev-B")).toBe(false);
  });
});
