/**
 * Task 50b, fix round 1 (I1): a restore never changes any project's lock state.
 *
 * The passphrase given to a restore is used to read the backup and for nothing else. Whether the
 * restore is allowed, refused or fails, every project of the library is exactly as locked or
 * unlocked afterwards as it was before, no key derived for the restore stays in the session, and
 * nothing is readable afterwards that was not readable before. A copy restored that way is locked
 * until it is unlocked itself, which is audited as every unlock is.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealEvent, type AuditEvent, type Project, type SourceFile } from "@ao/core";
import { shredSeams } from "../fs/shred.js";
import type { LocationEnv } from "../location.js";
import { PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import { restoreSeams } from "../repo/restore.js";
import { destroyRaw } from "../retention.js";
import { RestoreError, backupProject, restoreBackup, type BackupResult, type RestoreOptions } from "./backup.js";
import { PASS, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-restore-lock-");
});
afterEach(async () => {
  shredSeams.failFor = undefined;
  restoreSeams.beforeAdopt = undefined;
  restoreSeams.failBeforeRename = false;
  restoreSeams.crashAfterRename = false;
  await kit.close();
});

const restore = (path: string, opts: RestoreOptions = {}) => restoreBackup(kit.repo, path, opts);
const onDisk = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });
const onNetwork = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: kit.lib.root, removable: false, network: true }] });
const eventsOf = (projectId: string) => auditEvents(kit, kit.repo.getProject(projectId));
const unlocksIn = async (projectId: string) => (await eventsOf(projectId)).filter((e) => e.action === "key.unlock").length;
const detailsOf = (e: AuditEvent) => (e.details ?? {}) as Record<string, unknown>;
const titleOf = (sf: SourceFile) => sf.source.title.variants[0]!.value;

/** Identifiable raw data under a retention rule, encryption required. */
const RETAIN_SEALED = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: required
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;

interface Locked {
  p: Project;
  sf: SourceFile;
  b: BackupResult;
}

/** An encrypted project with one source and a sealed backup in the library's Backups folder; then locked. */
async function lockedOriginal(name = "Sealed Origin", gov = PSEUDO_GOV): Promise<Locked> {
  const p = await makeProject(kit, gov, true, name);
  const sf = await addSource(kit, p, { title: "inside" });
  const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
  expect(b.path.endsWith(".enc")).toBe(true);
  kit.repo.lockProject(p.id);
  expect(kit.ring.size).toBe(0);
  return { p, sf, b };
}

/** As locked as before: not unlocked, no key held in the session, its source not readable, and no unlock on record. */
async function expectStillLocked(o: Locked): Promise<void> {
  expect(kit.repo.isUnlocked(o.p.id)).toBe(false);
  expect(kit.ring.size).toBe(0);
  await expect(kit.repo.getSource(o.p.id, o.sf.source.id)).rejects.toBeInstanceOf(ProjectLockedError);
  expect(await unlocksIn(o.p.id)).toBe(0);
}

describe("a restore given a passphrase leaves every project as locked as it was", () => {
  it("a refused restore: the original is still locked, no key is held, and its sources are not readable", async () => {
    const o = await lockedOriginal();
    const err = await restore(o.b.path, { passphrase: PASS, locationEnv: onNetwork() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    await expectStillLocked(o);
    // The refusal itself is on record in the original's log, which is not sealed.
    expect((await eventsOf(o.p.id)).at(-1)).toMatchObject({ action: "restore", decision: { result: "deny" } });
    expect(kit.repo.listProjects().map((p) => p.id)).toEqual([o.p.id]);
  });

  it("an allowed restore: the original is still locked, and the copy is locked too until it is unlocked itself, which is audited", async () => {
    const o = await lockedOriginal();
    const r = await restore(o.b.path, { passphrase: PASS, locationEnv: onDisk() });
    await expectStillLocked(o);
    const copy = r.projectId;
    expect(copy).not.toBe(o.p.id);
    expect(kit.repo.isUnlocked(copy)).toBe(false);
    // What a locked project shows of itself: its sources by id, nothing of their content.
    const [sid] = kit.repo.listSourceIds(copy);
    expect(sid).toBeDefined();
    await expect(kit.repo.getSource(copy, sid!)).rejects.toBeInstanceOf(ProjectLockedError);
    expect((await eventsOf(copy)).at(-1)).toMatchObject({ action: "project.restored", decision: { result: "allow_with_conditions", conditions: [{ type: "encrypt" }] } });
    expect(await unlocksIn(copy)).toBe(0);
    expect(kit.repo.indexErrors).toEqual([]);

    await kit.repo.unlockProject(copy, PASS);
    expect(titleOf(await kit.repo.getSource(copy, sid!))).toBe("inside");
    expect(await unlocksIn(copy)).toBe(1);
  });

  it("a restore that fails half-way (after unpacking, at its last step, or right after the copy went live): the original is still locked and no key is held", async () => {
    const o = await lockedOriginal();
    restoreSeams.beforeAdopt = async () => {
      throw new Error("simulated failure after unpacking");
    };
    await expect(restore(o.b.path, { passphrase: PASS, locationEnv: onDisk() })).rejects.toThrow(/simulated/u);
    restoreSeams.beforeAdopt = undefined;
    await expectStillLocked(o);

    restoreSeams.failBeforeRename = true;
    await expect(restore(o.b.path, { passphrase: PASS, locationEnv: onDisk() })).rejects.toThrow(/simulated/u);
    restoreSeams.failBeforeRename = false;
    await expectStillLocked(o);
    expect(kit.repo.listProjects().map((p) => p.id)).toEqual([o.p.id]);

    restoreSeams.crashAfterRename = true;
    await expect(restore(o.b.path, { passphrase: PASS, locationEnv: onDisk() })).rejects.toThrow(/simulated/u);
    restoreSeams.crashAfterRename = false;
    await expectStillLocked(o);
  });

  it("a wrong passphrase: refused in plain words, and the original is still locked", async () => {
    const o = await lockedOriginal();
    const err = (await restore(o.b.path, { passphrase: "not the passphrase", locationEnv: onDisk() }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toMatch(/does not open this backup/u);
    await expectStillLocked(o);
    expect(kit.repo.listProjects().map((p) => p.id)).toEqual([o.p.id]);
  });

  it("no passphrase and a locked project: refused as before, and still locked", async () => {
    const o = await lockedOriginal();
    await expect(restore(o.b.path, { locationEnv: onDisk() })).rejects.toThrow(/unlock its project, or give the project's passphrase/u);
    await expectStillLocked(o);
  });

  it("a project that was unlocked before stays unlocked, whether the restore is refused or allowed; nothing is recorded as an unlock", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Open Meanwhile");
    const sf = await addSource(kit, p, { title: "inside" });
    const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    await expect(restore(b.path, { passphrase: PASS, locationEnv: onNetwork() })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    expect(titleOf(await kit.repo.getSource(p.id, sf.source.id))).toBe("inside");
    const r = await restore(b.path, { passphrase: PASS, locationEnv: onDisk() });
    expect(kit.repo.isUnlocked(p.id)).toBe(true);
    expect(kit.ring.size).toBe(1);
    // The copy has the same key: it is open while that key is in the session, as before.
    const [sid] = kit.repo.listSourceIds(r.projectId);
    expect(titleOf(await kit.repo.getSource(r.projectId, sid!))).toBe("inside");
    expect(await unlocksIn(p.id)).toBe(0);
    expect(await unlocksIn(r.projectId)).toBe(0);
  });
});

describe("a locked original at the decision: its rules and its audit log are not sealed, so both are read without unlocking it", () => {
  it("the rules it has now are asked as for an unlocked project: a rule tightened since the backup refuses, and the original stays locked", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Tightened And Locked");
    const sf = await addSource(kit, p, { title: "inside" });
    const b = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    const g = await kit.repo.getGovernance(p.id);
    await kit.repo.setGovernance(p.id, `${PSEUDO_GOV}residency:\n  allowed: [removable]\n`, { baseSha256: g.sha256 });
    kit.repo.lockProject(p.id);
    const err = (await restore(b.path, { passphrase: PASS, locationEnv: onDisk() }).catch((e: unknown) => e)) as PolicyDeniedError;
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.reason).toMatch(/The rule on where data may live that the original project has now does not allow its data there/u);
    expect(err.reason).toMatch(/Restore the backup into another library/u);
    await expectStillLocked({ p, sf, b });
    expect(kit.repo.listProjects().map((x) => x.id)).toEqual([p.id]);
  });

  /** A locked encrypted project whose raw file was destroyed while a backup holding it could not be removed. */
  async function destroyedAndLocked(): Promise<Locked & { raw: SourceFile; x: BackupResult; certificatePath: string }> {
    const p = await makeProject(kit, RETAIN_SEALED, true, "Destroyed And Locked");
    const f = await scratchFile(kit, "interview.mp3", "RAW interview audio bytes");
    const raw = await addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
    const sf = await addSource(kit, p, { title: "inside" });
    kit.clock.now = new Date("2026-12-02T09:59:00.000Z");
    const x = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(basename(x.path));
    const d = await destroyRaw(kit.repo, p.id, [raw.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    expect(existsSync(x.path)).toBe(true);
    kit.repo.lockProject(p.id);
    return { p, sf, b: x, raw, x, certificatePath: d.certificatePath };
  }

  it("what it destroyed is read from its audit log: the destroyed file stays out, the restore says its sealed certificate was not read, and the original stays locked", async () => {
    const o = await destroyedAndLocked();
    const r = await restore(o.x.path, { passphrase: PASS, locationEnv: onDisk() });
    await expectStillLocked(o);
    expect(r.leftOut).toHaveLength(1);
    expect(r.leftOut[0]!.destroyedAt).toBe("2026-12-02T10:00:00.000Z");
    const said = r.notes.join(" ");
    expect(said).toMatch(/1 file was destroyed earlier under a retention rule and was not restored/u);
    // What could not be read, and what the researcher can do.
    expect(said).toMatch(/project "Destroyed And Locked" is locked/u);
    expect(said).toMatch(/destruction certificates? .* sealed/u);
    expect(said).toMatch(/[Uu]nlock that project/u);
    expect(said).not.toContain(kit.tmp);
    const last = (await eventsOf(r.projectId)).at(-1)!;
    expect(detailsOf(last)).toMatchObject({ op: "project.restore", leftOutDestroyed: 1, destructionCertificatesSealed: [o.p.id] });

    await kit.repo.unlockProject(r.projectId, PASS);
    const back = await Promise.all(kit.repo.listSourceIds(r.projectId).map((id) => kit.repo.getSource(r.projectId, id)));
    const interview = back.find((s) => titleOf(s) === "Interview one")!;
    expect(interview.assets[0]).toMatchObject({ status: "destroyed", destroyedAt: "2026-12-02T10:00:00.000Z" });
    expect(existsSync(join(kit.lib.root, ...interview.assets[0]!.path.split("/")))).toBe(false);
  });

  it("an earlier form of its destruction entry, which needs the sealed certificate: refused (fail closed), naming both ways out; the original stays locked", async () => {
    const o = await destroyedAndLocked();
    // The entry as it was written before it named the destroyed files: the chain made whole again, the library opened anew.
    await rewriteWithoutDestroyedAssets(o.p);
    await kit.reopen();
    expect(kit.repo.isUnlocked(o.p.id)).toBe(false);
    const err = (await restore(o.x.path, { passphrase: PASS, locationEnv: onDisk() }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toMatch(/without naming the files that were destroyed/u);
    expect(err.message).toMatch(/is sealed, and its project is locked/u);
    expect(err.message).toMatch(/can be restored into another library/u);
    expect(err.message).toMatch(/[Uu]nlock that project and try again/u);
    expect(err.message).not.toContain(kit.tmp);
    await expectStillLocked(o);
    expect(kit.repo.listProjects().map((x) => x.id)).toEqual([o.p.id]);
  });
});

/** Rewrites the project's audit log on disk without `destroyedAssets` in its destruction entry, the chain made whole again (one segment). */
async function rewriteWithoutDestroyedAssets(p: Project): Promise<void> {
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "audit");
  const names = (await readdir(dir)).sort();
  expect(names).toHaveLength(1);
  const events = (await readFile(join(dir, names[0]!), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as AuditEvent);
  let prev: { seq: number; hash: string } | null = null;
  const lines = events.map((e) => {
    if (e.action === "delete" && detailsOf(e).op === "retention.destroy") delete (e.details as Record<string, unknown>).destroyedAssets;
    const { seq: _s, hash: _h, prevHash: _p, ...rest } = e;
    const sealed = sealEvent(rest, prev);
    prev = { seq: sealed.seq, hash: sealed.hash };
    return JSON.stringify(sealed);
  });
  await writeFile(join(dir, names[0]!), `${lines.join("\n")}\n`);
}
