/**
 * Task 61 (R134 c): issuing a new recovery code for an unlocked encrypted project. The project key
 * does not change; only its recovery wrapping in keys/project-key.json is replaced, through the
 * governed, audited, crash-safe write path (R26). At every instant the old code or the new one
 * opens the project, never neither.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing, WrongPassphraseError, normalizeRecoveryCode } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { backupProject, restoreBackup } from "../export/backup.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { InvalidInputError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError, RecoveryPendingError, type Repo } from "./index.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "./testing.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
`;
const NOW = "2026-11-11T10:00:00.000Z";
const PASS = "correct horse battery staple";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

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

async function reopen(): Promise<Repo> {
  await lib.close();
  ring.clear(); // the process "died": nothing stays unlocked
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
  return repo;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-recovery-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await repoFor();
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failUndo = undefined;
  seams.failAuditAppendFor = undefined;
  seams.onRecoveryCode = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function encrypted(): Promise<{ pid: string; code: string }> {
  const r = await repo.createProject({ name: "P", governanceYaml: GOV, encryption: { enabled: true, passphrase: PASS } });
  return { pid: r.project.id, code: r.recoveryCode! };
}
const keyFilePath = (pid: string) => join(lib.root, repo.getProject(pid).folder, "keys", "project-key.json");
const keyFileBytes = async (pid: string) => readFile(keyFilePath(pid));

async function audit(pid: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, repo.getProject(pid).folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l) as AuditEvent);
  return out;
}
const issued = async (pid: string) => (await audit(pid)).filter((e) => (e.details as { op?: string } | undefined)?.op === "project.recovery-code");

/** True when `secret` unlocks the project (locks it first, and leaves it locked). */
async function opens(pid: string, secret: string): Promise<boolean> {
  repo.lockProject(pid);
  try {
    await repo.unlockProject(pid, secret);
    repo.lockProject(pid);
    return true;
  } catch (err) {
    if (err instanceof WrongPassphraseError) return false;
    throw err;
  }
}

describe("issueRecoveryCode", () => {
  it("returns a new code; the old code stops working, the new one and the passphrase work; the key is unchanged", async () => {
    const { pid, code } = await encrypted();
    const keyIdBefore = JSON.parse((await keyFileBytes(pid)).toString("utf8")).keyId;
    const passphraseWrapBefore = JSON.parse((await keyFileBytes(pid)).toString("utf8")).passphrase;
    const { recoveryCode } = await repo.issueRecoveryCode(pid, PASS);
    expect(recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(normalizeRecoveryCode(recoveryCode)).not.toBe(normalizeRecoveryCode(code));
    const after = JSON.parse((await keyFileBytes(pid)).toString("utf8"));
    expect(after.keyId).toBe(keyIdBefore);
    expect(after.passphrase).toEqual(passphraseWrapBefore);
    if (process.platform !== "win32") expect((await stat(keyFilePath(pid))).mode & 0o777).toBe(0o600);
    expect(await opens(pid, code)).toBe(false);
    expect(await opens(pid, recoveryCode)).toBe(true);
    expect(await opens(pid, PASS)).toBe(true);
    // Data written before is still readable with the same key (nothing re-encrypted).
    expect(repo.getProject(pid).encryption.keyId).toBe(keyIdBefore);
    expect(await readdir(join(lib.root, ".tmp")).catch(() => [])).not.toContainEqual(expect.stringMatching(/^txn-/));
  });

  it("is audited as a governed store of the project (who, when) with no secret in any log", async () => {
    const { pid } = await encrypted();
    const { recoveryCode } = await repo.issueRecoveryCode(pid, PASS);
    const [ev] = await issued(pid);
    expect(ev).toMatchObject({ action: "store", actor: "tester", at: NOW, entity: { type: "project", id: pid }, decision: { result: "allow" } });
    expect((ev!.details as { txn?: string }).txn).toBeTruthy();
    const folder = join(lib.root, repo.getProject(pid).folder);
    for (const sub of ["audit", "changes"]) {
      for (const f of await readdir(join(folder, sub)).catch(() => [] as string[])) {
        const text = (await readFile(join(folder, sub, f))).toString("utf8");
        expect(text).not.toContain(recoveryCode);
        expect(text).not.toContain(normalizeRecoveryCode(recoveryCode));
        expect(text).not.toContain(PASS);
      }
    }
  });

  it("a second issue invalidates the first new code", async () => {
    const { pid } = await encrypted();
    const first = (await repo.issueRecoveryCode(pid, PASS)).recoveryCode;
    const second = (await repo.issueRecoveryCode(pid, PASS)).recoveryCode;
    expect(await opens(pid, first)).toBe(false);
    expect(await opens(pid, second)).toBe(true);
    expect(await issued(pid)).toHaveLength(2);
  });

  it("a wrong passphrase changes nothing: WrongPassphraseError, key file byte-identical, nothing audited", async () => {
    const { pid, code } = await encrypted();
    const before = await keyFileBytes(pid);
    const auditBefore = (await audit(pid)).length;
    await expect(repo.issueRecoveryCode(pid, "not it")).rejects.toBeInstanceOf(WrongPassphraseError);
    // The recovery code is not the passphrase: it does not authorise issuing a new one.
    await expect(repo.issueRecoveryCode(pid, code)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect((await audit(pid)).length).toBe(auditBefore);
    expect(await opens(pid, code)).toBe(true);
  });

  it("an empty or missing passphrase is refused as invalid input", async () => {
    const { pid } = await encrypted();
    await expect(repo.issueRecoveryCode(pid, "")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.issueRecoveryCode(pid, undefined as unknown as string)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a locked project, an unencrypted project and a read-only library, changing nothing", async () => {
    const { pid } = await encrypted();
    const before = await keyFileBytes(pid);
    repo.lockProject(pid);
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(ProjectLockedError);
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    await repo.unlockProject(pid, PASS);

    const plain = (await repo.createProject({ name: "Q", governanceYaml: GOV, encryption: { enabled: false } })).project.id;
    const err = await repo.issueRecoveryCode(plain, PASS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message).toMatch(/not encrypted/i);

    const ro = await openTestRepo(await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 })), ring, { clock: () => new Date(NOW), tz: "UTC" });
    await expect(ro.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
  });

  it("refuses a project with an unresolved interrupted change", async () => {
    const { pid, code } = await encrypted();
    seams.crashAt = "before-audit";
    seams.failUndo = "replaced";
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
    // The next open cannot roll it back (undo fails): the project waits for the researcher (R27).
    repo = await reopen();
    seams.failUndo = undefined;
    await repo.unlockProject(pid, PASS).catch(() => {});
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(RecoveryPendingError);
    // The old wrapping is kept aside by the marker; resolving the interrupted change by rolling it
    // back puts it back, and the old code opens the project again.
    const [pw] = await repo.pendingWrites();
    await repo.resolvePendingWrite(pw!.txn, "roll-back");
    expect(await opens(pid, code)).toBe(true);
  });

  it("a policy denial is audited and changes nothing", async () => {
    const { pid, code } = await encrypted();
    const before = await keyFileBytes(pid);
    // A governance file that cannot be read denies every governed action (fail closed).
    await writeFile(join(lib.root, repo.getProject(pid).folder, "governance.yaml"), "encryption: [not, a, mapping\n");
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(PolicyDeniedError);
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    const [deny] = await issued(pid);
    expect(deny).toMatchObject({ action: "store", decision: { result: "deny" } });
    expect(await opens(pid, code)).toBe(true);
  });

  it("an audit entry that cannot be written undoes the change and fails loudly (R28, R82): the old code still works", async () => {
    const { pid, code } = await encrypted();
    const before = await keyFileBytes(pid);
    seams.failAuditAppendFor = pid;
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect(await issued(pid)).toHaveLength(0);
    expect(await opens(pid, code)).toBe(true);
  });
});

describe("issueRecoveryCode: a crash at each seam, then reopen (R26)", () => {
  // Before the audit event (the commit point) the change rolls back: the old code works.
  // After it, the change is kept: the new code works (and was possibly never shown: ask again).
  const cases: Array<[CrashPoint, "old" | "new"]> = [
    ["before-changes", "old"],
    ["before-audit", "old"],
    ["torn-audit", "old"],
    ["before-marker-delete", "new"],
  ];
  for (const [point, valid] of cases) {
    it(`${point}: exactly the ${valid} code works after reopening, and the audit log agrees`, async () => {
      const { pid, code } = await encrypted();
      const before = await keyFileBytes(pid);
      seams.crashAt = point;
      // The code is returned only after the commit, so a crash means the caller never sees it; the
      // test seam hands over the code that would have been shown.
      let shown: string | undefined;
      seams.onRecoveryCode = (c) => (shown = c);
      await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
      seams.onRecoveryCode = undefined;
      expect(shown).toBeDefined();
      repo = await reopen();
      const kinds = repo.integrityWarnings.map((w) => w.kind);
      if (valid === "old") expect(kinds).toContain("rolled-back-incomplete-write");
      else expect(kinds).not.toContain("rolled-back-incomplete-write");
      expect(await readdir(join(lib.root, ".tmp")).catch(() => [])).not.toContainEqual(expect.stringMatching(/^txn-.*\.json$/));
      const oldWorks = await opens(pid, code);
      const newWorks = await opens(pid, shown!);
      expect([oldWorks, newWorks]).toEqual(valid === "old" ? [true, false] : [false, true]);
      expect(await opens(pid, PASS)).toBe(true);
      expect(await issued(pid)).toHaveLength(valid === "old" ? 0 : 1);
      if (valid === "old") expect((await keyFileBytes(pid)).equals(before)).toBe(true);
      const v = await repo.verifyAudit(pid);
      expect(v.ok).toBe(true);
    });
  }

  it("a crash after the old key file was copied aside but before the new one was renamed in: the old code works", async () => {
    const { pid, code } = await encrypted();
    const before = await keyFileBytes(pid);
    seams.crashAt = "before-changes";
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
    // As if the atomic rename had not happened yet: the old file is still in place.
    await writeFile(keyFilePath(pid), before);
    repo = await reopen();
    expect(await opens(pid, code)).toBe(true);
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
  });
});

describe("issueRecoveryCode and backups (R91, R92)", () => {
  it("a backup made before the change still opens with the OLD recovery code, not the new one", async () => {
    const { pid, code } = await encrypted();
    const b = await backupProject(repo, pid);
    const backupBytes = await readFile(b.path);
    const { recoveryCode } = await repo.issueRecoveryCode(pid, PASS);
    expect((await readFile(b.path)).equals(backupBytes)).toBe(true); // backups are not rewritten
    repo.lockProject(pid);
    await expect(restoreBackup(repo, b.path, { passphrase: recoveryCode })).rejects.toThrow(/does not open/i);
    const restored = await restoreBackup(repo, b.path, { passphrase: code });
    expect(restored.projectId).not.toBe(pid);
    // The restored project carries the key file of its time: the old code opens it, the new one does not.
    expect(await opens(restored.projectId, recoveryCode)).toBe(false);
    expect(await opens(restored.projectId, code)).toBe(true);
    // The live project is unaffected: the new code opens it.
    expect(await opens(pid, recoveryCode)).toBe(true);
  });
});
