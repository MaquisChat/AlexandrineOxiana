/**
 * R27: resolving an interrupted change by hand. The researcher sees each unresolved write-ahead
 * marker (R26) and chooses to roll it back or keep it; the choice is audited. Keep only when the
 * marker shows the change committed; roll back only an uncommitted change whose marker is valid.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type AuditEvent, type Provenance, type SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { NotFoundError, PendingWriteChoiceError, ReadOnlyLibraryError, RecoveryPendingError, type Repo } from "./index.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let pdf: string;

const mkDeps = (over: Partial<Deps> = {}): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
  ...over,
});
const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
const draft = (title: string): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
const provenance = (): Provenance => ({ captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false });
const add = (repo: Repo, pid: string, title: string) => repo.createSource(pid, draft(title), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });

async function audit(repo: Repo, pid: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, repo.getProject(pid).folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l) as AuditEvent);
  return out;
}
const markers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/.test(n));

async function reopen(): Promise<Repo> {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  return repoFor();
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-pending-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  pdf = join(tmp, "in.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello\n%%EOF\n");
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failUndo = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** A change interrupted before its audit event, left unresolved on reopen because an earlier audit event was altered. */
async function unverifiableOnReopen() {
  let repo = await repoFor();
  const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  await add(repo, pid, "Kept");
  seams.crashAt = "before-audit";
  await expect(add(repo, pid, "Half written")).rejects.toBeInstanceOf(SimulatedCrash);
  // Alter an early audit event: the chain before the interrupted change no longer verifies.
  const seg = join(lib.root, repo.getProject(pid).folder, "audit", "0001.jsonl");
  const lines = (await readFile(seg, "utf8")).split("\n");
  const ev = JSON.parse(lines[0]!);
  ev.actor = "mallory";
  lines[0] = JSON.stringify(ev);
  await writeFile(seg, lines.join("\n"));
  repo = await reopen();
  return { repo, pid };
}

describe("pending writes (R27)", () => {
  it("lists an interrupted change recovery could not settle, with the choices it allows", async () => {
    const { repo, pid } = await unverifiableOnReopen();
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("txn-recovery-skipped-audit-unverifiable");
    const list = await repo.pendingWrites();
    expect(list).toEqual([expect.objectContaining({ projectId: pid, status: "unverifiable", canRollBack: true, canKeep: false })]);
    expect(list[0]!.txn).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("roll back: undoes the half-written change, removes the marker, audits the choice and lifts the block", async () => {
    const { repo, pid } = await unverifiableOnReopen();
    await expect(add(repo, pid, "Blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
    const [pw] = await repo.pendingWrites();
    await expect(repo.resolvePendingWrite(pw!.txn, "keep")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    const r = await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(r).toMatchObject({ txn: pw!.txn, choice: "roll-back" });
    expect(await markers()).toEqual([]);
    expect(await repo.pendingWrites()).toEqual([]);
    const titles = (await Promise.all(repo.listSourceIds(pid).map((id) => repo.getSource(pid, id)))).map((s) => s.source.title.variants[0]!.value);
    expect(titles).toEqual(["Kept"]);
    const resolved = (await audit(repo, pid)).filter((e) => e.action === "txn.resolve");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toMatchObject({ txn: pw!.txn, choice: "roll-back", status: "unverifiable" });
    expect(repo.integrityWarnings.some((w) => w.detail.includes(pw!.txn))).toBe(false);
    // The project takes changes again.
    await add(repo, pid, "After");
  });

  it("a rollback step that fails keeps the marker and records nothing", async () => {
    const { repo, pid } = await unverifiableOnReopen();
    const [pw] = await repo.pendingWrites();
    const before = (await audit(repo, pid)).length;
    seams.failUndo = "append";
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toThrow(/could not be undone/);
    seams.failUndo = undefined;
    expect(await markers()).toHaveLength(1);
    expect((await audit(repo, pid)).length).toBe(before);
    await expect(add(repo, pid, "Still blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
  });

  it("keep: allowed only when the marker shows the change committed; finishes it and audits the choice", async () => {
    const repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    seams.crashAt = "before-marker-delete";
    await expect(add(repo, pid, "Committed")).rejects.toBeInstanceOf(SimulatedCrash);
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ status: "committed", canKeep: true, canRollBack: false });
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    await repo.resolvePendingWrite(pw!.txn, "keep");
    expect(await markers()).toEqual([]);
    expect(repo.listSourceIds(pid)).toHaveLength(1);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve").map((e) => e.details)).toEqual([expect.objectContaining({ txn: pw!.txn, choice: "keep", status: "committed" })]);
  });

  it("an invalid marker offers neither choice: nothing it names is touched", async () => {
    let repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    const txn = newId();
    await mkdir(join(lib.root, ".tmp"), { recursive: true });
    await writeFile(join(lib.root, ".tmp", `txn-${txn}.json`), "{ not json");
    repo = await reopen();
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("invalid-txn-marker");
    const list = await repo.pendingWrites();
    expect(list).toEqual([expect.objectContaining({ txn, projectId: "*", status: "invalid", canKeep: false, canRollBack: false })]);
    await expect(repo.resolvePendingWrite(txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    await expect(repo.resolvePendingWrite(txn, "keep")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    expect(await markers()).toHaveLength(1);
    expect(pid).toBeTruthy();
  });

  it("an unknown transaction is not found; a read-only library lists but does not resolve", async () => {
    const { repo, pid } = await unverifiableOnReopen();
    await expect(repo.resolvePendingWrite(newId(), "roll-back")).rejects.toBeInstanceOf(NotFoundError);
    const [pw] = await repo.pendingWrites();
    const ro = await openTestRepo(await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 })), ring, { clock: () => new Date(NOW), tz: "UTC" });
    expect((await ro.pendingWrites()).map((p) => p.txn)).toEqual([pw!.txn]);
    await expect(ro.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(pid).toBeTruthy();
  });
});
