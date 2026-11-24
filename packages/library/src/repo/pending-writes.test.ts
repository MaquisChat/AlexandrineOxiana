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
  seams.failAuditAppendFor = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** A change interrupted before its audit event, left unresolved on reopen because an earlier audit event was altered. */
async function unverifiableOnReopen(crash: "before-audit" | "torn-audit" = "before-audit") {
  let repo = await repoFor();
  const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  await add(repo, pid, "Kept");
  seams.crashAt = crash;
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

/**
 * A plainly uncommitted change (interrupted before its audit event) whose automatic rollback on
 * reopen failed part-way: the marker stays, the project is blocked, and the researcher may roll it back.
 */
async function uncommittedOnReopen() {
  let repo = await repoFor();
  const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  await add(repo, pid, "Kept");
  seams.crashAt = "before-audit";
  await expect(add(repo, pid, "Half written")).rejects.toBeInstanceOf(SimulatedCrash);
  seams.failUndo = "append";
  repo = await reopen();
  seams.failUndo = undefined;
  expect(repo.integrityWarnings.map((w) => w.kind)).toContain("rolled-back-incomplete-write");
  return { repo, pid };
}

const titlesOf = async (repo: Repo, pid: string) =>
  (await Promise.all(repo.listSourceIds(pid).map((id) => repo.getSource(pid, id)))).map((s) => s.source.title.variants[0]!.value).sort();

/** Every file of the project's audit log and change logs, byte for byte. */
async function logBytes(repo: Repo, pid: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const folder = join(lib.root, repo.getProject(pid).folder);
  for (const sub of ["audit", "changes"]) {
    for (const f of (await readdir(join(folder, sub)).catch(() => [] as string[])).sort()) out[`${sub}/${f}`] = (await readFile(join(folder, sub, f))).toString("base64");
  }
  return out;
}

const anchorsFile = () => join(tmp, "config", "audit-anchors.json");
const anchorOf = async (pid: string) => (JSON.parse(await readFile(anchorsFile(), "utf8")) as { anchors: Record<string, { seq: number; hash: string }> }).anchors[`${lib.id}/${pid}`];

describe("pending writes (R27)", () => {
  it("lists an interrupted change recovery could not settle, with the choices it allows", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    const list = await repo.pendingWrites();
    expect(list).toEqual([expect.objectContaining({ projectId: pid, status: "uncommitted", canRollBack: true, canKeep: false })]);
    expect(list[0]!.txn).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("roll back: undoes the half-written change, removes the marker, audits the choice and lifts the block", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    await expect(add(repo, pid, "Blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
    const [pw] = await repo.pendingWrites();
    await expect(repo.resolvePendingWrite(pw!.txn, "keep")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    const r = await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(r).toMatchObject({ txn: pw!.txn, choice: "roll-back" });
    expect(await markers()).toEqual([]);
    expect(await repo.pendingWrites()).toEqual([]);
    expect(await titlesOf(repo, pid)).toEqual(["Kept"]);
    const resolved = (await audit(repo, pid)).filter((e) => e.action === "txn.resolve");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toMatchObject({ txn: pw!.txn, choice: "roll-back", status: "uncommitted" });
    expect(repo.integrityWarnings.some((w) => w.detail.includes(pw!.txn))).toBe(false);
    // The project takes changes again.
    await add(repo, pid, "After");
  });

  it("a rollback step that fails keeps the marker and records nothing", async () => {
    const { repo, pid } = await uncommittedOnReopen();
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

describe("pending writes: an unverifiable change is never acted on (R131 a, b)", () => {
  it("P3: chain before the change does not verify (torn audit line): no choice is offered, roll-back is refused and nothing changes", async () => {
    const { repo, pid } = await unverifiableOnReopen("torn-audit");
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("txn-recovery-skipped-audit-unverifiable");
    // R529: the command line's detail says what the banner says: never a retry (it is refused every time); a backup is the way.
    const w = repo.integrityWarnings.find((x) => x.kind === "txn-recovery-skipped-audit-unverifiable")!;
    expect(w.detail.startsWith(
      "an interrupted change was not rolled back because the audit log cannot be trusted to show it was uncommitted; the marker is kept, and restoring the project from a backup made before the change is the way to undo it (transaction ",
    )).toBe(true);
    expect(w.detail).not.toMatch(/retried|tried again/u);
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ projectId: pid, status: "unverifiable", canKeep: false, canRollBack: false });
    expect(pw!.detail).toMatch(/audit/);
    expect(pw!.detail).not.toContain(lib.root);
    const before = await logBytes(repo, pid);
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    await expect(repo.resolvePendingWrite(pw!.txn, "keep")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    expect(await logBytes(repo, pid)).toEqual(before);
    expect(await markers()).toHaveLength(1);
    await expect(add(repo, pid, "Still blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
  });

  it("P1: the anchor is past the change's start (a later change committed): no choice, roll-back refused, the later change's log and the anchor untouched", async () => {
    const repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    seams.crashAt = "before-audit";
    await expect(add(repo, pid, "T1 half written")).rejects.toBeInstanceOf(SimulatedCrash);
    // The marker outlives its session: a later change in the same project commits.
    await add(repo, pid, "T2");
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ status: "unverifiable", canKeep: false, canRollBack: false });
    const anchor = await anchorOf(pid);
    const before = await logBytes(repo, pid);
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteChoiceError);
    expect(await logBytes(repo, pid)).toEqual(before);
    expect(await anchorOf(pid)).toEqual(anchor);
    expect(await markers()).toHaveLength(1);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toEqual([]);
  });

  it("an append offset that does not land on a line boundary: recovery on open does not roll back, and no choice is offered (R131 b, e)", async () => {
    let repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    await add(repo, pid, "Kept");
    seams.crashAt = "before-audit";
    await expect(add(repo, pid, "Half written")).rejects.toBeInstanceOf(SimulatedCrash);
    const [name] = await markers();
    const path = join(lib.root, ".tmp", name!);
    const m = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ kind: string; path?: string; prevSize?: number }> };
    const log = m.entries.find((e) => e.kind === "append" && e.path!.includes("/changes/"))!;
    log.prevSize = log.prevSize! - 1; // mid-line: truncating there would cut a committed line
    await writeFile(path, JSON.stringify(m));
    const before = await logBytes(repo, pid);
    repo = await reopen();
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("txn-recovery-skipped-audit-unverifiable");
    expect(await markers()).toHaveLength(1);
    const after = await logBytes(repo, pid);
    for (const k of Object.keys(before).filter((k) => k.startsWith("changes/"))) expect(after[k], k).toBe(before[k]);
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ status: "unverifiable", canKeep: false, canRollBack: false });
    expect(pw!.detail).toMatch(/line/);
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(PendingWriteChoiceError);
  });
});

describe("pending writes: the resolve is durable before it acts (R131 c, d)", () => {
  afterEach(() => {
    seams.failAuditAppendFor = undefined;
  });

  /** After reopening: the choice was carried out and audited exactly once, and the project takes changes. */
  async function finishedAfterReopen(txn: string, pid: string) {
    const repo = await reopen();
    expect(await markers()).toEqual([]);
    const resolved = (await audit(repo, pid)).filter((e) => e.action === "txn.resolve");
    expect(resolved.map((e) => e.details)).toEqual([expect.objectContaining({ txn, choice: "roll-back", status: "uncommitted" })]);
    expect(await titlesOf(repo, pid)).toEqual(["Kept"]);
    const kinds = repo.integrityWarnings.map((w) => w.kind);
    for (const k of ["chain-broken", "head-mismatch", "truncated", "anchor-missing", "incomplete-audit-line-pending", "audit-append-failed-at-open"] as const) expect(kinds).not.toContain(k);
    await add(repo, pid, "After");
    return repo;
  }

  it("P2: the audit append fails after the rollback: the marker keeps the recorded choice, nothing is silent, and the next open completes and audits it", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    const [pw] = await repo.pendingWrites();
    seams.failAuditAppendFor = pid;
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toThrow(/simulated audit append failure/);
    seams.failAuditAppendFor = undefined;
    expect(await markers()).toHaveLength(1);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toEqual([]);
    await expect(add(repo, pid, "Still blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
    // Offered again with the recorded choice only.
    expect(await repo.pendingWrites()).toEqual([expect.objectContaining({ txn: pw!.txn, canRollBack: true, canKeep: false })]);
    await finishedAfterReopen(pw!.txn, pid);
  });

  it("P2 (same session): resolving again after a failed audit append finishes it, audited once", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    const [pw] = await repo.pendingWrites();
    seams.failAuditAppendFor = pid;
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(await markers()).toEqual([]);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toHaveLength(1);
    await add(repo, pid, "After");
  });

  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as const) {
    it(`a crash ${point === "before-changes" ? "before the action" : point === "before-audit" ? "between the action and the audit event" : "after the audit event, before the marker is removed"}: the next open finishes it, audited exactly once`, async () => {
      const { repo, pid } = await uncommittedOnReopen();
      const [pw] = await repo.pendingWrites();
      seams.crashAt = point;
      await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await markers()).toHaveLength(1);
      await finishedAfterReopen(pw!.txn, pid);
    });
  }

  it("N1: a crash while the txn.resolve line is being written (roll back): the next open trims the torn line, completes and audits once", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    const [pw] = await repo.pendingWrites();
    seams.crashAt = "torn-audit";
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await markers()).toHaveLength(1);
    await finishedAfterReopen(pw!.txn, pid);
  });

  it("N1: a torn txn.resolve line, then resolving again in the same session, finishes it, audited once", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    const [pw] = await repo.pendingWrites();
    seams.crashAt = "torn-audit";
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(SimulatedCrash);
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(await markers()).toEqual([]);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toHaveLength(1);
    await add(repo, pid, "After");
  });

  it("N1: a crash while the txn.resolve line is being written (keep): the next open trims the torn line, completes and audits once", async () => {
    let repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    seams.crashAt = "before-marker-delete";
    await expect(add(repo, pid, "Committed")).rejects.toBeInstanceOf(SimulatedCrash);
    const [pw] = await repo.pendingWrites();
    seams.crashAt = "torn-audit";
    await expect(repo.resolvePendingWrite(pw!.txn, "keep")).rejects.toBeInstanceOf(SimulatedCrash);
    repo = await reopen();
    expect(await markers()).toEqual([]);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve").map((e) => e.details)).toEqual([expect.objectContaining({ txn: pw!.txn, choice: "keep" })]);
    expect(repo.integrityWarnings.map((w) => w.kind)).not.toContain("incomplete-audit-line-pending");
    await add(repo, pid, "After");
  });

  it("keep: a crash after the audit event leaves a marker the next open removes, with no second record", async () => {
    let repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    seams.crashAt = "before-marker-delete";
    await expect(add(repo, pid, "Committed")).rejects.toBeInstanceOf(SimulatedCrash);
    const [pw] = await repo.pendingWrites();
    seams.crashAt = "before-marker-delete";
    await expect(repo.resolvePendingWrite(pw!.txn, "keep")).rejects.toBeInstanceOf(SimulatedCrash);
    repo = await reopen();
    expect(await markers()).toEqual([]);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve").map((e) => e.details)).toEqual([expect.objectContaining({ txn: pw!.txn, choice: "keep", status: "committed" })]);
    expect(repo.listSourceIds(pid)).toHaveLength(1);
  });

  it("a recorded choice whose step fails on open stays recorded and blocks the project; the open after that completes it", async () => {
    let repo = (await uncommittedOnReopen()).repo;
    const pid = repo.listProjects()[0]!.id;
    const [pw] = await repo.pendingWrites();
    seams.crashAt = "before-changes";
    await expect(repo.resolvePendingWrite(pw!.txn, "roll-back")).rejects.toBeInstanceOf(SimulatedCrash);
    seams.failUndo = "append";
    repo = await reopen();
    seams.failUndo = undefined;
    expect(await markers()).toHaveLength(1);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toEqual([]);
    await expect(add(repo, pid, "Blocked")).rejects.toBeInstanceOf(RecoveryPendingError);
    await finishedAfterReopen(pw!.txn, pid);
  });

  it("(d) a resolve never moves the anchor past a mismatch: recorded on the next open instead", async () => {
    const { repo, pid } = await uncommittedOnReopen();
    // The anchor names the change's start but with a different event there.
    const raw = JSON.parse(await readFile(anchorsFile(), "utf8")) as { anchors: Record<string, { seq: number; hash: string }> };
    raw.anchors[`${lib.id}/${pid}`]!.hash = "0".repeat(64);
    await writeFile(anchorsFile(), JSON.stringify(raw));
    const anchor = await anchorOf(pid);
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ status: "uncommitted", canRollBack: true });
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(await anchorOf(pid)).toEqual(anchor);
    expect((await audit(repo, pid)).filter((e) => e.action === "txn.resolve")).toHaveLength(1);
    // Writes would move the anchor: they wait for the next open, which records the mismatch first.
    const err = await add(repo, pid, "Not yet").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecoveryPendingError);
    // R528 M3: held for another reason than an interrupted change: reopening the library is the way, and is said.
    expect((err as RecoveryPendingError).reason).toBe("reopen");
    const again = await reopen();
    expect((await audit(again, pid)).map((e) => e.action)).toContain("audit.anchor-mismatch");
    await add(again, pid, "After");
  });

  it("M1: after a rollback that removed a torn audit line, the project is not kept blocked by the stale warning", async () => {
    let repo = await repoFor();
    const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    await add(repo, pid, "Kept");
    seams.crashAt = "torn-audit";
    await expect(add(repo, pid, "Half written")).rejects.toBeInstanceOf(SimulatedCrash);
    seams.failUndo = "append";
    repo = await reopen();
    seams.failUndo = undefined;
    const [pw] = await repo.pendingWrites();
    expect(pw).toMatchObject({ status: "uncommitted", canRollBack: true });
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(repo.integrityWarnings.map((w) => w.kind)).not.toContain("incomplete-audit-line-pending");
    await add(repo, pid, "After");
  });

  it("M3: a read-only library lists markers but offers no choice", async () => {
    const { pid } = await uncommittedOnReopen();
    const ro = await openTestRepo(await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 })), ring, { clock: () => new Date(NOW), tz: "UTC" });
    const [pw] = await ro.pendingWrites();
    expect(pw).toMatchObject({ projectId: pid, canKeep: false, canRollBack: false });
    expect(pw!.detail).toMatch(/read-only/);
  });
});
