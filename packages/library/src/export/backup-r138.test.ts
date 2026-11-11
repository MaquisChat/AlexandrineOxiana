/**
 * R138 (Task 49 review round 1): one maintenance operation per project at a time; names never
 * reused and files never overwritten; the decision evaluated again at the commit point; no backup
 * kept that holds raw data destroyed since its snapshot; destruction reaches every backup even when
 * no new backup can be made.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import type { LocationEnv } from "../location.js";
import { PolicyDeniedError } from "../repo/errors.js";
import { projectWarnings } from "../repo/repo.js";
import { SimulatedCrash } from "../repo/testing.js";
import { destroyRaw, destroyRawHeld, resumeDestruction } from "../retention.js";
import { shredSeams } from "../fs/shred.js";
import {
  BackupDiscardedError,
  backupFailure,
  backupIfDue,
  backupProject,
  backupSeams,
  holdingNotRemoved,
  listBackups,
  pruneBackups,
  restoreBackup,
} from "./backup.js";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-r138-");
});
afterEach(async () => {
  backupSeams.crashAt = undefined;
  backupSeams.afterSnapshot = undefined;
  backupSeams.beforeCommit = undefined;
  backupSeams.failBackup = false;
  await kit.close();
});

const backupsDir = () => join(kit.lib.root, "Backups");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** The library on this computer's own disk, certainly. */
const onDisk = (): LocationEnv => ({ homeDir: kit.tmp, platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });

const RETAIN = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;

async function rawSource(p: Project): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", "RAW interview audio bytes");
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

async function tighten(p: Project, yaml: string): Promise<void> {
  const g = await kit.repo.getGovernance(p.id);
  await kit.repo.setGovernance(p.id, yaml, { baseSha256: g.sha256 });
}

/** Every listed backup is the file on disk (sha256), its backup.create event says the same, and it restores. */
async function allConsistent(p: Project): Promise<number> {
  const list = await listBackups(kit.repo, p.id);
  const created = (await auditEvents(kit, p)).filter((e) => e.action === "backup.create").map((e) => e.details as { file: string; sha256: string });
  for (const b of list) {
    const onDiskSha = sha(await readFile(join(backupsDir(), b.file)));
    expect(onDiskSha).toBe(b.sha256);
    expect(created.filter((c) => c.file === b.file).map((c) => c.sha256)).toEqual([b.sha256]);
    const r = await restoreBackup(kit.repo, join(backupsDir(), b.file));
    expect(r.projectId).toBeDefined();
  }
  return list.length;
}

describe("C1: one backup of a project at a time; never an overwritten archive", () => {
  it("two backups at once in the same minute: two distinct files, each recorded with its own hash, each restores", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Twin");
    await addSource(kit, p, { title: "x" });
    const [a, b] = await Promise.allSettled([backupProject(kit.repo, p.id), backupProject(kit.repo, p.id)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const pa = (a as PromiseFulfilledResult<{ path: string }>).value.path;
    const pb = (b as PromiseFulfilledResult<{ path: string }>).value.path;
    expect(pa).not.toBe(pb);
    expect(await allConsistent(p)).toBe(2);
  });

  it("a scheduled run and a manual backup at once: never two archives under one name, everything listed restores", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Sched And Hand");
    // The manual request comes first; the scheduler's pass starts while it is running.
    await Promise.allSettled([backupProject(kit.repo, p.id), backupIfDue(kit.repo, p.id, kit.clock.now)]);
    const n = await allConsistent(p);
    expect(n).toBeGreaterThanOrEqual(1);
    // The scheduled run checks whether a backup is due while it holds the project: after the manual one, none is.
    expect(n).toBe(1);
  });

  it("a file already carrying the chosen name is never written over", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Squat");
    const { writeFile } = await import("node:fs/promises");
    backupSeams.beforeCommit = async () => {
      // Something else takes every name a backup of this minute could have.
      await writeFile(join(backupsDir(), "Squat - backup - modified 2026-11-10 0930.zip"), "not a backup");
    };
    const r = await backupProject(kit.repo, p.id).catch((e: unknown) => e);
    backupSeams.beforeCommit = undefined;
    expect(await readFile(join(backupsDir(), "Squat - backup - modified 2026-11-10 0930.zip"), "utf8")).toBe("not a backup");
    if (r instanceof Error) {
      expect(await listBackups(kit.repo, p.id)).toEqual([]);
    } else {
      expect(await allConsistent(p)).toBe(1);
    }
  });

  it("an archive changed after it was written is not recorded as a backup (hash checked before the commit)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Changed");
    const { appendFile } = await import("node:fs/promises");
    backupSeams.beforeCommit = async () => {
      const tmp = (await readdir(backupsDir())).find((n) => n.includes(".tmp-"))!;
      await appendFile(join(backupsDir(), tmp), "garbage");
    };
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(BackupDiscardedError);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect((await auditEvents(kit, p)).filter((e) => e.action === "backup.create")).toEqual([]);
    expect((await readdir(backupsDir())).filter((n) => n.includes(" - backup - "))).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
  });
});

describe("the maintenance lock", () => {
  it("does not hold up ordinary writes while an archive is being made; a prune of the same project waits for the backup", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Busy");
    await backupProject(kit.repo, p.id);
    let pruneDone = false;
    let wroteDuring = false;
    let prunedWhileArchiving = true;
    backupSeams.afterSnapshot = async () => {
      if (wroteDuring) return;
      // An ordinary write completes while the archive is being made.
      await addSource(kit, p, { title: "written during the backup" });
      wroteDuring = true;
      await new Promise((r) => setTimeout(r, 20));
      prunedWhileArchiving = pruneDone;
    };
    kit.clock.now = new Date("2026-11-10T09:40:00.000Z");
    const backup = backupProject(kit.repo, p.id, { prune: false });
    const prune = pruneBackups(kit.repo, p.id, 1).then(() => {
      pruneDone = true;
    });
    await backup;
    await prune;
    backupSeams.afterSnapshot = undefined;
    expect(wroteDuring).toBe(true);
    expect(prunedWhileArchiving).toBe(false);
    expect(pruneDone).toBe(true);
    expect(await listBackups(kit.repo, p.id)).toHaveLength(1);
  });

  it("a waiting backup proceeds after the first one throws, or crashes (and after a reopen)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Waits");
    backupSeams.crashAt = "after-zip";
    const first = backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-11-10T09:31:00.000Z");
    const second = backupProject(kit.repo, p.id);
    await expect(first).rejects.toBeInstanceOf(SimulatedCrash);
    await expect(second).resolves.toMatchObject({ sha256: expect.any(String) });
    backupSeams.failBackup = true;
    const failing = backupProject(kit.repo, p.id);
    const after = (async () => {
      await failing.catch(() => {});
      backupSeams.failBackup = false;
      kit.clock.now = new Date("2026-11-10T09:32:00.000Z");
      return backupProject(kit.repo, p.id);
    })();
    await expect(failing).rejects.toThrow();
    await expect(after).resolves.toBeDefined();
    backupSeams.crashAt = "before-commit";
    kit.clock.now = new Date("2026-11-10T09:33:00.000Z");
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
    const again = await kit.reopen();
    kit.clock.now = new Date("2026-11-10T09:34:00.000Z");
    await expect(backupProject(again, p.id)).resolves.toBeDefined();
  });
});

describe("I1: the decision is evaluated again at the commit point", () => {
  it("rules tightened while the archive is made: discarded, nothing recorded as a backup, the refusal audited, backup-failed with the reason", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Tightened");
    backupSeams.afterSnapshot = async () => {
      await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
    };
    const err = await backupProject(kit.repo, p.id, { locationEnv: onDisk() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).reason).toMatch(/this project's rules do not allow its data there/u);
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect((await readdir(backupsDir())).filter((n) => n.includes(" - backup - "))).toEqual([]);
    const ev = await auditEvents(kit, p);
    expect(ev.filter((e) => e.action === "backup.create")).toEqual([]);
    expect(ev.filter((e) => e.action === "backup").map((e) => e.decision?.result)).toEqual(["allow", "deny"]);
    expect(await backupFailure(kit.repo, p.id)).toMatchObject({ refused: true, reason: (err as PolicyDeniedError).reason });
  });

  it("the same for a scheduled run", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Tightened Daily");
    backupSeams.beforeCommit = async () => {
      await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
    };
    await expect(backupIfDue(kit.repo, p.id, kit.clock.now, { locationEnv: onDisk() })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
  });
});

describe("I3: no backup kept that holds raw data destroyed since its snapshot", () => {
  it("destruction landing between the archive and the commit: the archive is discarded and the reason given", async () => {
    const p = await makeProject(kit, RETAIN, false, "Raced");
    const sf = await rawSource(p);
    let cert: { backups: { status: string; containing: string[] } } | undefined;
    backupSeams.beforeCommit = async (hold) => {
      backupSeams.beforeCommit = undefined;
      // Runs with the backup's own hold on the project: as if the lock were bypassed.
      cert = (await destroyRawHeld(kit.repo, hold, p.id, [sf.assets[0]!.id], "tester")).certificate as never;
    };
    const err = await backupProject(kit.repo, p.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupDiscardedError);
    expect((err as Error).message).toBe("Raw data was destroyed under the retention rule while this backup was being made; the backup was not kept.");
    // N4: the discard is in the audit log, linked to the attempt's allow by its backup id.
    const ev = await auditEvents(kit, p);
    const allow = ev.find((e) => e.action === "backup" && e.decision?.result === "allow")!;
    const discard = ev.find((e) => e.action === "backup.discarded")!;
    expect(discard.decision).toEqual({ result: "deny", reason: (err as Error).message });
    expect((discard.details as { backupId?: string }).backupId).toBe((allow.details as { backupId: string }).backupId);
    expect(cert!.backups.status).toBe("none");
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect((await readdir(backupsDir())).filter((n) => n.includes(" - backup - "))).toEqual([]);
    expect((await backupFailure(kit.repo, p.id))?.reason).toBe((err as Error).message);
  });

  it("a destruction asked for during a backup waits for it, then finds and removes that backup", async () => {
    const p = await makeProject(kit, RETAIN, false, "Waits For Backup");
    const sf = await rawSource(p);
    const b = backupProject(kit.repo, p.id);
    const d = destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const made = await b;
    const name = made.path.slice(backupsDir().length + 1);
    const { certificate } = await d;
    const bk = certificate.backups as { status: string; containing: string[]; deleted: string[]; freshBackup?: string };
    expect(bk.containing).toEqual([`Backups/${name}`]);
    expect(bk.deleted).toEqual([`Backups/${name}`]);
    expect(bk.status).toBe("deleted");
    expect(existsSync(made.path)).toBe(false);
    expect(bk.freshBackup).toBeDefined();
  });
});

describe("I2: destruction reaches every backup even when no new backup can be made", () => {
  it("a refused fresh backup: the holding backups are removed anyway; the project has no backup; backup-failed; the certificate says so plainly", async () => {
    const p = await makeProject(kit, RETAIN, false, "No Fresh");
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    await tighten(p, `${RETAIN}residency:\n  allowed: [removable]\n`);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const bk = r.certificate.backups as { status: string; deleted: string[]; freshBackup?: string; freshBackupFailed?: string; note?: string; lastError?: string };
    const oldName = old.path.slice(backupsDir().length + 1);
    expect(existsSync(old.path)).toBe(false);
    expect(bk.status).toBe("deleted");
    expect(bk.deleted).toEqual([`Backups/${oldName}`]);
    expect(bk.freshBackup).toBeUndefined();
    expect(bk.freshBackupFailed).toMatch(/this project's rules do not allow its data there/u);
    expect(bk.note).toBe(
      `The earlier backups that held the destroyed files were removed. No new backup could be made afterwards: ${bk.freshBackupFailed}. This project has no backup until one succeeds.`,
    );
    expect(bk.lastError).toBeUndefined();
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).toContain("backup-failed");
    // Nothing is left for a resume to do.
    expect(await resumeDestruction(kit.repo, p.id)).toEqual([]);
  });

  it("a fresh backup that fails for another reason: the same, and the certificate names what failed", async () => {
    const p = await makeProject(kit, RETAIN, false, "Fresh Fails");
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    backupSeams.failBackup = true;
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    backupSeams.failBackup = false;
    const bk = r.certificate.backups as { status: string; freshBackupFailed?: string };
    expect(existsSync(old.path)).toBe(false);
    expect(bk.status).toBe("deleted");
    expect(bk.freshBackupFailed).toBe("The backup could not be made (simulated backup failure).");
  });
});

describe("fix round 2", () => {
  afterEach(() => {
    shredSeams.failFor = undefined;
  });
  const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
  type Bk = {
    status: string;
    deleted: string[];
    removedAt?: Record<string, string>;
    notRemoved?: Array<{ file: string; reason: string }>;
    note?: string;
    lastError?: string;
    freshBackupFailed?: string;
  };
  const lastSettle = async (p: Project) => (await auditEvents(kit, p)).filter((e) => e.action === "retention.backups").at(-1)!.details as Record<string, unknown>;

  it("N1: a backup that could not be removed is named as NOT removed with its reason; a warning stands; a later retry removes it and the record shows when; the audit matches the certificate", async () => {
    const p = await makeProject(kit, RETAIN, false, "Stuck");
    const sf = await rawSource(p);
    const a = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-11-10T09:31:00.000Z");
    const b = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(b));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const bk = r.certificate.backups as Bk;
    expect(bk.status).toBe("pending");
    expect(bk.deleted).toEqual([`Backups/${nameOf(a)}`]);
    expect(bk.removedAt).toEqual({ [`Backups/${nameOf(a)}`]: "2026-12-02T10:15:00.000Z" });
    const notRemovedEntry = { file: `Backups/${nameOf(b)}`, reason: "It could not be overwritten and removed (simulated overwrite failure).", at: "2026-12-02T10:15:00.000Z" };
    expect(bk.notRemoved).toEqual([notRemovedEntry]);
    expect(bk.lastError).toBe("A backup holding the destroyed files could not be removed (simulated overwrite failure); the step will be tried again");
    expect(bk.note).toBeUndefined();
    expect(existsSync(b.path)).toBe(true);
    expect(await projectWarnings(kit.repo, p.id)).toContain("destruction-backups-pending");
    expect(await lastSettle(p)).toMatchObject({ status: "pending", removed: [`Backups/${nameOf(a)}`], notRemoved: [`Backups/${nameOf(b)}`] });

    kit.clock.now = new Date("2026-12-03T08:00:00.000Z");
    const [path] = await resumeDestruction(kit.repo, p.id);
    const cert = JSON.parse(await readFile(path!, "utf8")) as { backups: Bk };
    expect(cert.backups.status).toBe("deleted");
    expect(cert.backups.deleted.sort()).toEqual([`Backups/${nameOf(a)}`, `Backups/${nameOf(b)}`].sort());
    expect(cert.backups.removedAt).toEqual({ [`Backups/${nameOf(a)}`]: "2026-12-02T10:15:00.000Z", [`Backups/${nameOf(b)}`]: "2026-12-03T08:00:00.000Z" });
    // Point 3 (round 3): amended, not rewritten: the original "not removed" entry stays, and the
    // later removal is appended with its time.
    expect(cert.backups.notRemoved).toEqual([notRemovedEntry]);
    expect((cert.backups as Bk & { amendments?: unknown }).amendments).toEqual([{ at: "2026-12-03T08:00:00.000Z", removed: [`Backups/${nameOf(b)}`] }]);
    expect((cert.backups as Bk & { outstanding?: unknown }).outstanding).toBeUndefined();
    expect(cert.backups.lastError).toBeUndefined();
    expect(existsSync(b.path)).toBe(false);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain("destruction-backups-pending");
    expect(await lastSettle(p)).toMatchObject({ status: "deleted", removed: [`Backups/${nameOf(b)}`], notRemoved: [] });
  });

  it("N1: with no fresh backup AND a removal failure, the note never says the backups were removed", async () => {
    const p = await makeProject(kit, RETAIN, false, "Stuck No Fresh");
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id, { locationEnv: onDisk() });
    await tighten(p, `${RETAIN}residency:\n  allowed: [removable]\n`);
    kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(old));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const bk = r.certificate.backups as Bk;
    expect(bk.deleted).toEqual([]);
    expect(bk.note).toBe(
      `No new backup could be made after the destruction: ${bk.freshBackupFailed}. A backup that holds the destroyed files could not be removed yet (see notRemoved); removing it is tried again.`,
    );
    expect(bk.note).not.toMatch(/were removed/u);
    expect(await lastSettle(p)).toMatchObject({ status: "pending", removed: [], notRemoved: [`Backups/${nameOf(old)}`] });
  });

  it("N2: three collisions in a row still give a well-formed, unique backup name", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Sq");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(backupsDir(), { recursive: true });
    await writeFile(join(backupsDir(), "Sq - backup - modified 2026-11-10 0930.zip"), "foreign 1");
    backupSeams.beforeCommit = async () => {
      // The reserved name, and the next one, are taken from outside before the archive is named.
      await writeFile(join(backupsDir(), "Sq - backup - modified 2026-11-10 0930 (2).zip"), "foreign 2");
      await writeFile(join(backupsDir(), "Sq - backup - modified 2026-11-10 0930 (3).zip"), "foreign 3");
    };
    const r = await backupProject(kit.repo, p.id);
    expect(nameOf(r)).toBe("Sq - backup - modified 2026-11-10 0930 (4).zip");
    expect(await allConsistent(p)).toBe(1);
    for (const [n, body] of [["", "foreign 1"], [" (2)", "foreign 2"], [" (3)", "foreign 3"]] as const) {
      expect(await readFile(join(backupsDir(), `Sq - backup - modified 2026-11-10 0930${n}.zip`), "utf8")).toBe(body);
    }
  });

  it("N3: work scheduled from inside a locked section does not run as holding the lock, and does not deadlock", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Timers");
    await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-11-10T09:40:00.000Z");
    let backupDone = false;
    let pruneRanDuringBackup: boolean | undefined;
    let scheduled: Promise<void> | undefined;
    backupSeams.afterSnapshot = async () => {
      if (scheduled) return;
      scheduled = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          pruneBackups(kit.repo, p.id, 1).then(() => {
            pruneRanDuringBackup = !backupDone;
            resolve();
          }, reject);
        }, 0);
      });
      await new Promise((r) => setTimeout(r, 30));
    };
    await backupProject(kit.repo, p.id, { prune: false });
    backupDone = true;
    await scheduled;
    expect(pruneRanDuringBackup).toBe(false);
    expect(await listBackups(kit.repo, p.id)).toHaveLength(1);
  });

  it("N4: a refusal at the commit point carries the attempt's backup id and reserved name", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Linked");
    backupSeams.beforeCommit = async () => {
      await tighten(p, `${OPEN_GOV}residency:\n  allowed: [removable]\n`);
    };
    await expect(backupProject(kit.repo, p.id, { locationEnv: onDisk() })).rejects.toBeInstanceOf(PolicyDeniedError);
    const ev = (await auditEvents(kit, p)).filter((e) => e.action === "backup");
    expect(ev.map((e) => e.decision?.result)).toEqual(["allow", "deny"]);
    const id = (ev[0]!.details as { backupId: string }).backupId;
    expect(ev[1]!.details).toMatchObject({ op: "backup.create", backupId: id, file: "Linked - backup - modified 2026-11-10 0930.zip", at: "commit" });
  });
});

describe("fix round 3", () => {
  afterEach(() => {
    shredSeams.failFor = undefined;
  });
  const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
  const HOUR = 3_600_000;

  it("R2-I1: 48 hours of a removal that keeps failing write ONE audit event (a daily summary); the retry backs off to daily; the warning stays; the success is recorded and clears it", async () => {
    const p = await makeProject(kit, RETAIN, false, "Hourly");
    const sf = await rawSource(p);
    const old = await backupProject(kit.repo, p.id);
    const t0 = new Date("2026-12-02T10:00:00.000Z").getTime();
    kit.clock.now = new Date(t0);
    shredSeams.failFor = (path) => path.endsWith(nameOf(old));
    await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    const before = (await auditEvents(kit, p)).length;
    let attempted = 0;
    for (let h = 1; h <= 48; h++) {
      kit.clock.now = new Date(t0 + h * HOUR);
      attempted += (await resumeDestruction(kit.repo, p.id)).length;
      expect(await projectWarnings(kit.repo, p.id)).toContain("destruction-backups-pending");
    }
    const during = (await auditEvents(kit, p)).slice(before);
    // Hourly for the first day (hours 1–23), then daily (hour 47): 24 attempts, one summary event.
    expect(attempted).toBe(24);
    expect(during.map((e) => e.action)).toEqual(["retention.backups"]);
    expect(during[0]!.details).toMatchObject({ summary: true, attempts: 24, status: "pending", notRemoved: [`Backups/${nameOf(old)}`] });
    // The removal now works: the next due retry (a day after the last) records it and clears the warning.
    shredSeams.failFor = undefined;
    kit.clock.now = new Date(t0 + 71 * HOUR);
    const [path] = await resumeDestruction(kit.repo, p.id);
    const cert = JSON.parse(await readFile(path!, "utf8")) as { backups: { status: string; amendments?: unknown } };
    expect(cert.backups.status).toBe("deleted");
    expect(cert.backups.amendments).toEqual([{ at: new Date(t0 + 71 * HOUR).toISOString(), removed: [`Backups/${nameOf(old)}`] }]);
    const last = (await auditEvents(kit, p)).filter((e) => e.action === "retention.backups").at(-1)!;
    expect(last.details).toMatchObject({ status: "deleted", removed: [`Backups/${nameOf(old)}`], notRemoved: [] });
    expect(existsSync(old.path)).toBe(false);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain("destruction-backups-pending");
  });

  it("R2-I2: a later destruction that settles cleanly does not clear the warning for an earlier one's backup still on disk", async () => {
    const p = await makeProject(kit, RETAIN, false, "Two Destructions");
    const first = await rawSource(p);
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    await destroyRaw(kit.repo, p.id, [first.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([`Backups/${nameOf(x)}`]);
    // Destruction B: another file, held only by a backup made after it was added.
    const second = await rawSource(p);
    kit.clock.now = new Date("2026-12-02T10:05:00.000Z");
    await backupProject(kit.repo, p.id, { prune: false });
    kit.clock.now = new Date("2026-12-02T10:10:00.000Z");
    const rb = await destroyRaw(kit.repo, p.id, [second.assets[0]!.id], "tester");
    expect((rb.certificate.backups as { status: string }).status).toBe("deleted");
    expect(await projectWarnings(kit.repo, p.id)).toContain("destruction-backups-pending");
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([`Backups/${nameOf(x)}`]);
    expect(existsSync(x.path)).toBe(true);
    // Removing X clears it.
    kit.clock.now = new Date("2026-12-02T11:10:00.000Z");
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(false);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain("destruction-backups-pending");
  });

  it("point 4: the retry removes only backups holding data an audited destruction really destroyed; a certificate edited to name live data removes nothing", async () => {
    const p = await makeProject(kit, RETAIN, false, "Forged");
    const gone = await rawSource(p);
    const live = await rawSource(p);
    const both = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    // A real destruction whose backups step stays pending (removal fails).
    shredSeams.failFor = (path) => path.endsWith(nameOf(both));
    const r = await destroyRaw(kit.repo, p.id, [gone.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    // A later backup holds only the live file (and the fresh one made by the destruction too).
    kit.clock.now = new Date("2026-12-02T10:30:00.000Z");
    const liveOnly = await backupProject(kit.repo, p.id, { prune: false });
    // Someone edits the certificate on disk to claim the live file was destroyed.
    const { writeFile } = await import("node:fs/promises");
    const cert = JSON.parse(await readFile(r.certificatePath, "utf8")) as { assets: Array<{ assetId: string }> };
    cert.assets = [{ assetId: live.assets[0]!.id }];
    await writeFile(r.certificatePath, JSON.stringify(cert));
    kit.clock.now = new Date("2026-12-02T11:30:00.000Z");
    await resumeDestruction(kit.repo, p.id);
    // Nothing that holds only live data went; the live file is still stored.
    expect(existsSync(liveOnly.path)).toBe(true);
    const stillThere = await kit.repo.getSource(p.id, live.source.id);
    expect(stillThere.assets[0]!.status).not.toBe("destroyed");
    expect(existsSync(join(kit.lib.root, ...stillThere.assets[0]!.path.split("/")))).toBe(true);
  });
});
