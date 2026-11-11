/**
 * R125: a backup is evaluated by the policy engine and audited; its commit point; refusals and the
 * `backup-failed` warning; pruning audited by file name.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project } from "@ao/core";
import type { LocationEnv } from "../location.js";
import { PolicyDeniedError } from "../repo/errors.js";
import { projectWarnings } from "../repo/repo.js";
import { SimulatedCrash, seams } from "../repo/testing.js";
import {
  BACKUPS_MANIFEST,
  BACKUPS_STATE,
  BackupNotRecordedError,
  PruneNotRecordedError,
  backupFailure,
  backupIfDue,
  backupProject,
  backupSeams,
  listBackups,
  pruneBackups,
  restoreBackup,
  type BackupCrashPoint,
} from "./backup.js";
import { OPEN_GOV, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-gov-");
});
afterEach(async () => {
  backupSeams.crashAt = undefined;
  backupSeams.afterSnapshot = undefined;
  backupSeams.beforePruneAudit = undefined;
  seams.failAuditAppendFor = undefined;
  await kit.close();
});

const backupsDir = () => join(kit.lib.root, "Backups");
/** Backup files and their temp files in Backups/ (not the manifest, state or anything else). */
const backupFiles = async () => (await readdir(backupsDir()).catch(() => [] as string[])).filter((n) => n.includes(" - backup - modified "));
const events = async (p: Project, action?: string) => (await auditEvents(kit, p)).filter((e) => action === undefined || e.action === action);
/** Where the library is, as the location classifier would see it. */
const onNetwork = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: kit.lib.root, removable: false, network: true }] });
const unknownPlace = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [], mountsKnown: false });

async function tighten(p: Project, yaml: string): Promise<void> {
  const g = await kit.repo.getGovernance(p.id);
  await kit.repo.setGovernance(p.id, yaml, { baseSha256: g.sha256 });
}

describe("R125: every backup is evaluated first and audited", () => {
  it("an allowed backup: the decision (with its conditions) is audited before the result, linked by a backup id; the result names the file, never a path", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Sealed Study");
    await addSource(kit, p, { title: "x" });
    const r = await backupProject(kit.repo, p.id);
    const all = await events(p);
    const decision = all.filter((e) => e.action === "backup");
    const result = all.filter((e) => e.action === "backup.create");
    expect(decision).toHaveLength(1);
    expect(result).toHaveLength(1);
    expect(decision[0]!.decision).toEqual({ result: "allow_with_conditions", conditions: [{ type: "encrypt" }] });
    expect(decision[0]!.seq).toBeLessThan(result[0]!.seq);
    const backupId = (decision[0]!.details as { backupId?: string }).backupId;
    expect(backupId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result[0]!.details).toMatchObject({ backupId, file: "Sealed Study - backup - modified 2026-11-10 0930.zip.enc", sha256: r.sha256, bytes: r.bytes, encrypted: true });
    expect(JSON.stringify([decision[0], result[0]])).not.toContain(kit.lib.root);
  });

  it("an unencrypted project whose rules allow it: decision `allow`", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Open");
    await backupProject(kit.repo, p.id);
    expect((await events(p, "backup"))[0]!.decision).toEqual({ result: "allow" });
  });
});

describe("R125: a refused backup", () => {
  it("rules that require encryption on an unencrypted project (governance.yaml changed outside the app): nothing is created, the plain reason is given, the denial is audited", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Needs Seal");
    await addSource(kit, p, { title: "x" });
    // The app refuses this edit (GovernanceViolationError); a file edited by hand can still say it.
    await writeFile(join(kit.lib.root, p.folder, "governance.yaml"), OPEN_GOV.replace("atRest: optional", "atRest: required"));
    const err = await backupProject(kit.repo, p.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).reason).toBe("Governance requires encryption at rest, but this project is not encrypted");
    expect(await backupFiles()).toEqual([]);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    const denied = await events(p, "backup");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toEqual({ result: "deny", reason: "Governance requires encryption at rest, but this project is not encrypted" });
    expect(await events(p, "backup.create")).toEqual([]);
  });

  it("a library on storage the project's rules exclude (a network drive): refused with the engine's reason", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Net");
    await expect(backupProject(kit.repo, p.id, { locationEnv: onNetwork() })).rejects.toMatchObject({
      reason: "Backups are kept in the library's folder, which is on a network drive; this project's rules do not allow its data there",
    });
    expect(await backupFiles()).toEqual([]);
    expect((await events(p, "backup"))[0]!.decision).toMatchObject({ result: "deny" });
  });

  it("where the library is cannot be determined: refused when it may be storage the rules exclude (fail closed)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Unknown");
    await expect(backupProject(kit.repo, p.id, { locationEnv: unknownPlace() })).rejects.toMatchObject({
      reason: "Where the library's folder is stored could not be determined (it may be a network drive), and this project's rules do not allow its data there. To make backups, move the library to storage the rules allow, or allow that kind of storage in the project's rules.",
    });
    expect(await backupFiles()).toEqual([]);
  });

  it("the device's own disk excluded by the rules: refused", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Removable Only");
    await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
    const env: LocationEnv = { homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] };
    await expect(backupProject(kit.repo, p.id, { locationEnv: env })).rejects.toMatchObject({
      reason: "Backups are kept in the library's folder, which is on this computer's disk; this project's rules do not allow its data there",
    });
  });

  it("a governance file that cannot be read: refused (fail closed)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Broken Rules");
    await writeFile(join(kit.lib.root, p.folder, "governance.yaml"), "encryption: [not, a, mapping");
    await expect(backupProject(kit.repo, p.id)).rejects.toMatchObject({ reason: expect.stringMatching(/^Policy could not be evaluated/u) });
    expect(await backupFiles()).toEqual([]);
  });

  it("a refused SCHEDULED backup raises `backup-failed` with the reason; it is not retried (nor re-audited) within the day; a later backup clears it", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Daily Refused");
    await expect(backupIfDue(kit.repo, p.id, kit.clock.now, { locationEnv: onNetwork() })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
    expect(await backupFailure(kit.repo, p.id)).toMatchObject({
      refused: true,
      reason: "Backups are kept in the library's folder, which is on a network drive; this project's rules do not allow its data there",
    });
    // The hourly scheduler does not ask again the same day: one denial in the log, the warning stays.
    kit.clock.now = new Date("2026-11-10T15:00:00.000Z");
    expect(await backupIfDue(kit.repo, p.id, kit.clock.now, { locationEnv: onNetwork() })).toBeNull();
    expect(await events(p, "backup")).toHaveLength(1);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
    // Survives a reopen.
    const again = await kit.reopen();
    expect(await projectWarnings(again, p.id)).toContain("backup-failed");
    // A day later, with the library where the rules allow it: made, and the warning clears.
    kit.clock.now = new Date("2026-11-11T09:31:00.000Z");
    expect((await backupIfDue(again, p.id, kit.clock.now))?.path).toBeDefined();
    expect(await projectWarnings(again, p.id)).not.toContain("backup-failed");
    expect(await backupFailure(again, p.id)).toBeUndefined();
  });

  it("a refused MANUAL backup does not wait a day: the next one is evaluated again at once", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Manual Again");
    await expect(backupProject(kit.repo, p.id, { locationEnv: onNetwork() })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect((await backupProject(kit.repo, p.id)).path).toBeDefined();
    expect(await projectWarnings(kit.repo, p.id)).not.toContain("backup-failed");
  });
});

describe("R125: the commit point is the `backup.create` audit event", () => {
  const points: Array<[BackupCrashPoint, boolean]> = [
    ["after-decision", false],
    ["after-zip", false],
    ["before-commit", false],
    ["after-commit", true],
    ["before-manifest", true],
  ];
  it.each(points)("a crash %s, then a reopen: committed=%s", async (point, committed) => {
    const p = await makeProject(kit, OPEN_GOV, false, "Crash");
    await addSource(kit, p, { title: "x" });
    backupSeams.crashAt = point;
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
    // Before anything else looks: no backup is presented as made.
    if (!committed) expect((await backupFiles()).filter((n) => !n.includes(".tmp-"))).toEqual([]);
    const again = await kit.reopen();
    const created = await events(p, "backup.create");
    if (committed) {
      expect(created).toHaveLength(1);
      const list = await listBackups(again, p.id);
      expect(list).toHaveLength(1);
      expect(list[0]!.sha256).toBe((created[0]!.details as { sha256: string }).sha256);
      expect(list[0]!.file).toBe((created[0]!.details as { file: string }).file);
      expect(await backupFiles()).toEqual([list[0]!.file]);
      const bytes = await readFile(join(backupsDir(), list[0]!.file));
      expect(bytes.length).toBe((created[0]!.details as { bytes: number }).bytes);
      expect(await projectWarnings(again, p.id)).not.toContain("backup-failed");
      // A real backup: it restores.
      const restored = await restoreBackup(again, join(backupsDir(), list[0]!.file));
      expect(again.listSourceIds(restored.projectId)).toHaveLength(1);
    } else {
      expect(created).toEqual([]);
      // The decision is in the log; the interrupted backup left nothing, and the project says so.
      expect(await events(p, "backup")).toHaveLength(1);
      expect(await backupFiles()).toEqual([]);
      expect(await listBackups(again, p.id)).toEqual([]);
      expect(await projectWarnings(again, p.id)).toContain("backup-failed");
      expect((await backupFailure(again, p.id))?.reason).toBe("The backup was interrupted before it was finished; nothing of it was kept.");
    }
    // The state file keeps nothing pending.
    const state = JSON.parse(await readFile(join(backupsDir(), BACKUPS_STATE), "utf8")) as { pending?: Record<string, unknown> };
    expect(Object.keys(state.pending ?? {})).toEqual([]);
    // The next backup works.
    kit.clock.now = new Date("2026-11-10T10:30:00.000Z");
    await backupProject(again, p.id);
    expect(await listBackups(again, p.id)).toHaveLength(committed ? 2 : 1);
  });

  it("an interrupted backup is settled by the next backup operation too (no reopen)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "No Reopen");
    backupSeams.crashAt = "after-commit";
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await listBackups(kit.repo, p.id)).toHaveLength(1);
  });

  it("the commit event cannot be written: the backup is not kept, the error says so, and `backup-failed` is raised (R28, R82)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "No Audit");
    // The decision is recorded; then the audit log stops taking events.
    backupSeams.afterSnapshot = async () => {
      seams.failAuditAppendFor = p.id;
    };
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(BackupNotRecordedError);
    seams.failAuditAppendFor = undefined;
    expect(await backupFiles()).toEqual([]);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect(await events(p, "backup.create")).toEqual([]);
    expect((await backupFailure(kit.repo, p.id))?.reason).toBe("The backup could not be recorded in the audit log, so it was not kept.");
  });

  it("the decision cannot be audited: nothing is made, and `backup-failed` is raised", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "No Decision");
    seams.failAuditAppendFor = p.id;
    await expect(backupProject(kit.repo, p.id)).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    expect(await backupFiles()).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
  });
});

describe("R125: pruning is audited by file name; a plain delete (R91)", () => {
  async function three(p: Project): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      kit.clock.now = new Date(Date.UTC(2026, 10, 10, 9, 30 + i));
      names.push((await backupProject(kit.repo, p.id, { prune: false })).path.slice(backupsDir().length + 1));
    }
    return names;
  }

  it("one `backup.prune` event per run, listing every file removed", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Prune Audit");
    const names = await three(p);
    expect(await pruneBackups(kit.repo, p.id, 1)).toEqual([names[1], names[0]]);
    const ev = await events(p, "backup.prune");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ files: [names[1], names[0]], keep: 1 });
    expect(ev[0]!.decision).toEqual({ result: "allow" });
    // Nothing to remove: no event.
    expect(await pruneBackups(kit.repo, p.id, 1)).toEqual([]);
    expect(await events(p, "backup.prune")).toHaveLength(1);
    // The prune after a new backup is audited the same way.
    kit.clock.now = new Date(Date.UTC(2026, 10, 10, 10, 0));
    const r = await backupProject(kit.repo, p.id, { keep: 1 });
    expect(r.pruned).toEqual([names[2]]);
    expect((await events(p, "backup.prune")).at(-1)!.details).toMatchObject({ files: [names[2]], keep: 1 });
  });

  it("the prune event cannot be written: the files are gone (not undone), the error says so, `backup-audit-pending` stands until it is recorded", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Prune Fail");
    const names = await three(p);
    seams.failAuditAppendFor = p.id;
    await expect(pruneBackups(kit.repo, p.id, 2)).rejects.toBeInstanceOf(PruneNotRecordedError);
    seams.failAuditAppendFor = undefined;
    expect(await backupFiles()).not.toContain(names[0]);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-audit-pending");
    const again = await kit.reopen();
    const ev = await events(p, "backup.prune");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ files: [names[0]], recovered: true });
    expect(await projectWarnings(again, p.id)).not.toContain("backup-audit-pending");
  });

  it("a backup whose own prune cannot be recorded is still a backup; its result says so", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Prune Warn");
    await three(p);
    kit.clock.now = new Date(Date.UTC(2026, 10, 10, 11, 0));
    let n = 0;
    // Let the decision and the commit through; refuse the prune event.
    backupSeams.beforePruneAudit = async () => {
      n++;
      seams.failAuditAppendFor = p.id;
    };
    try {
      const r = await backupProject(kit.repo, p.id, { keep: 2 });
      expect(r.pruned).toHaveLength(2);
      expect(r.warnings).toContain("Old backups were removed, but their removal could not be recorded in the audit log yet; it is recorded at the next backup.");
    } finally {
      backupSeams.beforePruneAudit = undefined;
      seams.failAuditAppendFor = undefined;
    }
    expect(n).toBe(1);
    expect(await events(p, "backup.create")).toHaveLength(4);
  });

  it("a crash before the prune event: the next open records it", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Prune Crash");
    const names = await three(p);
    backupSeams.crashAt = "before-prune-audit";
    await expect(pruneBackups(kit.repo, p.id, 2)).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    expect((await events(p, "backup.prune")).map((e: AuditEvent) => e.details)).toEqual([expect.objectContaining({ files: [names[0]], recovered: true })]);
  });

  it("still touches only manifest-listed files with a backup's name", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Only Mine");
    await writeFile(join(backupsDir(), "Only Mine - backup - modified 2001-01-01 0000.zip"), "not ours");
    await three(p);
    await pruneBackups(kit.repo, p.id, 1);
    expect(await readFile(join(backupsDir(), "Only Mine - backup - modified 2001-01-01 0000.zip"), "utf8")).toBe("not ours");
    const files = ((await events(p, "backup.prune"))[0]!.details as { files: string[] }).files;
    expect(files).not.toContain("Only Mine - backup - modified 2001-01-01 0000.zip");
    expect((await stat(join(backupsDir(), BACKUPS_MANIFEST))).isFile()).toBe(true);
  });
});
