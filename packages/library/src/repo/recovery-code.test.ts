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
import { KeyRing, WrongPassphraseError, normalizeRecoveryCode, wrapKey } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { backupProject, restoreBackup } from "../export/backup.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { InvalidInputError, KeyFileChangedError, PolicyDeniedError, ProjectLockedError, RECOVERY_CODE_UNSHOWN_WARNING, ReadOnlyLibraryError, RecoveryPendingError, projectWarnings, type Repo } from "./index.js";
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
  seams.failRecoveryCleanup = undefined;
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
async function opens(pid: string, secret: string, r: Repo = repo): Promise<boolean> {
  r.lockProject(pid);
  try {
    await r.unlockProject(pid, secret);
    r.lockProject(pid);
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
    const before = await keyFileBytes(pid);
    seams.crashAt = "before-audit";
    seams.failUndo = "created";
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
    // The next open cannot roll it back (undo fails): the project waits for the researcher (R27).
    repo = await reopen();
    seams.failUndo = undefined;
    await repo.unlockProject(pid, PASS).catch(() => {});
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(RecoveryPendingError);
    // The active key file was never replaced (R141).
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
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

const stagingPath = (pid: string) => join(lib.root, repo.getProject(pid).folder, "keys", "project-key.next.json");
const exists = (p: string) => stat(p).then(() => true, () => false);

/** A second device opening the same library while the first (crashed) one still holds it: read-only. */
async function readOnlyRepo(): Promise<{ ro: Repo; close: () => Promise<void>; ring: KeyRing }> {
  const roRing = new KeyRing();
  const roLib = await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 }));
  const ro = await openTestRepo(roLib, roRing, { clock: () => new Date(NOW), tz: "UTC", scryptN: 2 ** 10 });
  return { ro, ring: roRing, close: async () => { await roLib.close(); roRing.clear(); } };
}

describe("issueRecoveryCode: staged, then activated after the commit point (R26, R141)", () => {
  // Before the audit event the active key file is untouched: every open, read-only included, takes
  // the old code. After the commit the staged wrapping is activated; if a crash stops that, the next
  // writable open completes it and warns that a code may not have been shown.
  type Case = { point: CrashPoint; ro: "old" | "new"; rw: "old" | "new"; warn: boolean };
  const cases: Case[] = [
    { point: "recovery-before-stage", ro: "old", rw: "old", warn: false },
    { point: "before-changes", ro: "old", rw: "old", warn: false },
    { point: "before-audit", ro: "old", rw: "old", warn: false },
    { point: "torn-audit", ro: "old", rw: "old", warn: false },
    { point: "before-marker-delete", ro: "old", rw: "new", warn: true },
    { point: "recovery-before-activate", ro: "old", rw: "new", warn: true },
    { point: "recovery-mid-activate", ro: "new", rw: "new", warn: true },
    { point: "recovery-after-activate", ro: "new", rw: "new", warn: false },
  ];
  for (const c of cases) {
    it(`${c.point}: a read-only open takes the ${c.ro} code, a writable open the ${c.rw} code${c.warn ? ", with a warning" : ""}`, async () => {
      const { pid, code } = await encrypted();
      const before = await keyFileBytes(pid);
      // The code is returned only after activation, so a crash means the caller never sees it; the
      // test seam hands over the code that would have been shown.
      let shown: string | undefined;
      seams.onRecoveryCode = (x) => (shown = x);
      seams.crashAt = c.point;
      await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
      seams.onRecoveryCode = undefined;
      expect(shown).toBeDefined();
      if (c.ro === "old") expect((await keyFileBytes(pid)).equals(before)).toBe(true);

      // Staging (if any) holds only wrapped keys: never the code or the passphrase.
      if (await exists(stagingPath(pid))) {
        const text = await readFile(stagingPath(pid), "utf8");
        for (const secret of [shown!, normalizeRecoveryCode(shown!), code, normalizeRecoveryCode(code), PASS]) expect(text).not.toContain(secret);
        expect(Object.keys(JSON.parse(text)).sort()).toEqual(["formatVersion", "issueId", "keyFile"]);
        expect(Object.keys(JSON.parse(text).keyFile).sort()).toEqual(["keyId", "passphrase", "recovery"]);
      }

      // 1. Another device opens the library read-only (no recovery, no activation).
      const r = await readOnlyRepo();
      expect(await opens(pid, code, r.ro)).toBe(c.ro === "old");
      expect(await opens(pid, shown!, r.ro)).toBe(c.ro === "new");
      expect(await opens(pid, PASS, r.ro)).toBe(true);
      expect(await projectWarnings(r.ro, pid)).not.toContain(RECOVERY_CODE_UNSHOWN_WARNING);
      await r.close();

      // 2. A writable open.
      repo = await reopen();
      expect(await opens(pid, code)).toBe(c.rw === "old");
      expect(await opens(pid, shown!)).toBe(c.rw === "new");
      expect(await opens(pid, PASS)).toBe(true);
      expect(await exists(stagingPath(pid))).toBe(false);
      expect(await readdir(join(lib.root, ".tmp")).catch(() => [])).not.toContainEqual(expect.stringMatching(/^txn-.*\.json$/));
      expect((await projectWarnings(repo, pid)).includes(RECOVERY_CODE_UNSHOWN_WARNING)).toBe(c.warn);
      expect(await issued(pid)).toHaveLength(c.rw === "old" ? 0 : 1);
      if (c.rw === "old") expect((await keyFileBytes(pid)).equals(before)).toBe(true);
      expect((await audit(pid)).some((e) => e.action === "key.recovery-activated")).toBe(c.warn);
      expect((await repo.verifyAudit(pid)).ok).toBe(true);

      // 3. Opening again changes nothing more; issuing another code clears the warning.
      repo = await reopen();
      expect(await opens(pid, c.rw === "old" ? code : shown!)).toBe(true);
      await repo.unlockProject(pid, PASS);
      const again = (await repo.issueRecoveryCode(pid, PASS)).recoveryCode;
      expect(await projectWarnings(repo, pid)).not.toContain(RECOVERY_CODE_UNSHOWN_WARNING);
      expect(await opens(pid, again)).toBe(true);
      expect(await opens(pid, shown!)).toBe(false);
    });
  }

  it("the reviewer's probe: a crash before the audit event, then a read-only open: the old code works, the unseen one does not", async () => {
    const { pid, code } = await encrypted();
    let shown: string | undefined;
    seams.onRecoveryCode = (x) => (shown = x);
    seams.crashAt = "before-audit";
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
    const r = await readOnlyRepo();
    expect(r.ro.integrityWarnings.map((w) => w.kind)).toContain("incomplete-write-pending");
    await expect(r.ro.unlockProject(pid, shown!)).rejects.toBeInstanceOf(WrongPassphraseError);
    await r.ro.unlockProject(pid, code);
    expect(r.ro.isUnlocked(pid)).toBe(true);
    await r.close();
  });

  it("two issues at once: one wins, the other is a KeyFileChangedError, and the winner's code works", async () => {
    const { pid } = await encrypted();
    const results = await Promise.allSettled([repo.issueRecoveryCode(pid, PASS), repo.issueRecoveryCode(pid, PASS)]);
    const ok = results.filter((x): x is PromiseFulfilledResult<{ recoveryCode: string }> => x.status === "fulfilled");
    const failed = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(KeyFileChangedError);
    expect(await opens(pid, ok[0]!.value.recoveryCode)).toBe(true);
    expect(await issued(pid)).toHaveLength(1);
  });
});

/** A genuine issue stopped after the commit point, before its staged file was activated. */
async function committedNotActivated(pid: string): Promise<string> {
  let shown: string | undefined;
  seams.onRecoveryCode = (x) => (shown = x);
  seams.crashAt = "recovery-before-activate";
  await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
  seams.onRecoveryCode = undefined;
  return shown!;
}
const warningKinds = () => repo.integrityWarnings.map((w) => w.kind);

describe("a staged file is activated only when it is the committed one (R148)", () => {
  it("PLANT: an earlier, already activated issue id with damaged wrappings is never activated: the passphrase and the current code still open; the file is removed and reported", async () => {
    const { pid } = await encrypted();
    const a = (await repo.issueRecoveryCode(pid, PASS)).recoveryCode;
    const issueA = (await issued(pid))[0]!.details as { issueId: string };
    const active = JSON.parse((await keyFileBytes(pid)).toString("utf8"));
    const before = await keyFileBytes(pid);
    const junk = { keyId: active.keyId, kdf: active.passphrase.kdf, nonce: "AAAAAAAAAAAAAAAA", wrapped: Buffer.alloc(48).toString("base64") };
    await writeFile(stagingPath(pid), JSON.stringify({ formatVersion: 1, issueId: issueA.issueId, keyFile: { keyId: active.keyId, passphrase: junk, recovery: junk } }, null, 2));
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect(await opens(pid, PASS)).toBe(true);
    expect(await opens(pid, a)).toBe(true);
    expect(await exists(stagingPath(pid))).toBe(false);
    expect(warningKinds()).toContain("recovery-staging-discarded");
    expect(await projectWarnings(repo, pid)).not.toContain(RECOVERY_CODE_UNSHOWN_WARNING);
    expect((await audit(pid)).some((e) => e.action === "key.recovery-activated")).toBe(false);
  });

  it("PLANT2: issue A's genuine staged file put back after issue B was activated is not activated: B's code works, the revoked codes do not", async () => {
    const { pid, code } = await encrypted();
    // A stops halfway through activation; its staged file is copied, then the next open completes it.
    let a: string | undefined;
    seams.onRecoveryCode = (x) => (a = x);
    seams.crashAt = "recovery-mid-activate";
    await expect(repo.issueRecoveryCode(pid, PASS)).rejects.toBeInstanceOf(SimulatedCrash);
    seams.onRecoveryCode = undefined;
    const stagedA = await readFile(stagingPath(pid));
    repo = await reopen();
    await repo.unlockProject(pid, PASS);
    const b = (await repo.issueRecoveryCode(pid, PASS)).recoveryCode;
    await writeFile(stagingPath(pid), stagedA); // a sync client restores the deleted file
    const before = await keyFileBytes(pid);
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect(await opens(pid, b)).toBe(true);
    expect(await opens(pid, a!)).toBe(false);
    expect(await opens(pid, code)).toBe(false);
    expect(await exists(stagingPath(pid))).toBe(false);
    expect(warningKinds()).toContain("recovery-staging-discarded");
  });

  it("the committed issue's file put back after it was activated on open is not activated again", async () => {
    const { pid } = await encrypted();
    const shown = await committedNotActivated(pid);
    const staged = await readFile(stagingPath(pid));
    repo = await reopen(); // activates, audits key.recovery-activated
    await writeFile(stagingPath(pid), staged);
    const before = await keyFileBytes(pid);
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect((await audit(pid)).filter((e) => e.action === "key.recovery-activated")).toHaveLength(1);
    expect(warningKinds()).toContain("recovery-staging-discarded");
    expect(await opens(pid, shown)).toBe(true);
  });

  it("a staged file whose bytes differ from the sha256 recorded with the issue is not activated", async () => {
    const { pid, code } = await encrypted();
    const shown = await committedNotActivated(pid);
    const before = await keyFileBytes(pid);
    // Same content, other bytes: compact JSON instead of the indented form that was recorded.
    await writeFile(stagingPath(pid), JSON.stringify(JSON.parse(await readFile(stagingPath(pid), "utf8"))));
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect(await opens(pid, code)).toBe(true);
    expect(await opens(pid, shown)).toBe(false);
    expect(await exists(stagingPath(pid))).toBe(false);
    expect(warningKinds()).toContain("recovery-staging-discarded");
    expect(await projectWarnings(repo, pid)).not.toContain(RECOVERY_CODE_UNSHOWN_WARNING);
  });

  it("a staged file whose passphrase wrapping differs from the active file's is not activated", async () => {
    const { pid, code } = await encrypted();
    const shown = await committedNotActivated(pid);
    // The active file's passphrase wrapping changed meanwhile (same passphrase, fresh salt).
    const active = JSON.parse((await keyFileBytes(pid)).toString("utf8"));
    const key = ring.get(active.keyId)!;
    active.passphrase = await wrapKey(key, PASS, active.keyId, { N: 2 ** 10 });
    await writeFile(keyFilePath(pid), JSON.stringify(active, null, 2));
    const before = await keyFileBytes(pid);
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect(await opens(pid, PASS)).toBe(true);
    expect(await opens(pid, code)).toBe(true);
    expect(await opens(pid, shown)).toBe(false);
    expect(await exists(stagingPath(pid))).toBe(false);
    expect(warningKinds()).toContain("recovery-staging-discarded");
  });

  it("an audit chain that does not verify: nothing is activated, the staged file is left in place and reported", async () => {
    const { pid, code } = await encrypted();
    const shown = await committedNotActivated(pid);
    const before = await keyFileBytes(pid);
    const staged = await readFile(stagingPath(pid));
    const seg = join(lib.root, repo.getProject(pid).folder, "audit", "0001.jsonl");
    const lines = (await readFile(seg, "utf8")).split("\n");
    const ev = JSON.parse(lines[0]!);
    ev.actor = "mallory";
    lines[0] = JSON.stringify(ev);
    await writeFile(seg, lines.join("\n"));
    repo = await reopen();
    expect((await keyFileBytes(pid)).equals(before)).toBe(true);
    expect((await readFile(stagingPath(pid))).equals(staged)).toBe(true);
    expect(warningKinds()).toContain("recovery-staging-unverifiable");
    expect(await opens(pid, code)).toBe(true);
    expect(await opens(pid, shown)).toBe(false);
  });

  it("M-b: a failure after the new file is in place is reported as activated but not shown", async () => {
    const { pid, code } = await encrypted();
    let shown: string | undefined;
    seams.onRecoveryCode = (x) => (shown = x);
    seams.failRecoveryCleanup = true;
    const err = await repo.issueRecoveryCode(pid, PASS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/put in place/i);
    expect((err as Error).message).toMatch(/could not be shown/i);
    expect((err as Error).message).not.toMatch(/still works/i);
    expect(await opens(pid, code)).toBe(false);
    expect(await opens(pid, shown!)).toBe(true);
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
