/**
 * Task 50b, defect D15 (R174 c): a backups manifest that is merely absent is never read as "no
 * backups". Beside existing backup files it is rebuilt like a damaged one (R92) before any decision
 * that depends on it: a destruction's list, a retry pass, a prune, a restore's choice of backup. A
 * backup that cannot be read then is listed as needing a look, and the warning is raised. Also: a
 * backup that takes the name of one removed outside the app replaces its manifest entry.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project, SourceFile } from "@ao/core";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shredSeams } from "../fs/shred.js";
import { openLibrary } from "../library.js";
import { ReadOnlyLibraryError } from "../repo/errors.js";
import { projectWarnings } from "../repo/repo.js";
import { SimulatedCrash, openTestRepo } from "../repo/testing.js";
import { destroyRaw, readDestruction, resumeDestruction } from "../retention.js";
import {
  BACKUPS_MANIFEST,
  BACKUPS_STATE,
  backupProject,
  backupSeams,
  forgetMissingBackups,
  listBackups,
  pruneBackups,
  restoreBackup,
  withProjectMaintenance,
  type BackupResult,
} from "./backup.js";
import { OPEN_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-backup-d15-");
});
afterEach(async () => {
  shredSeams.failFor = undefined;
  backupSeams.crashAt = undefined;
  backupSeams.failBackup = false;
  await kit.close();
});

const WARNING = "destruction-backups-pending";
const HOUR = 3_600_000;
const backupsDir = () => join(kit.lib.root, "Backups");
const manifestPath = () => join(backupsDir(), BACKUPS_MANIFEST);
const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;
const at = (iso: string) => {
  kit.clock.now = new Date(iso);
};
/** The manifest as it is on disk now (it must exist). */
const manifestNow = async () => JSON.parse(await readFile(manifestPath(), "utf8")) as { backups: Array<{ file: string; projectId: string; sha256: string }>; unresolved?: string[] };

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

async function rawSource(p: Project, bytes = "RAW interview audio bytes"): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", bytes);
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

type Details = Record<string, unknown> & { op?: string; backupsToRemove?: string[]; backupsUnreadable?: string[]; removed?: string[]; files?: string[] };
const detailsOf = (e: AuditEvent) => (e.details ?? {}) as Details;
const commitOf = async (p: Project) => detailsOf((await auditEvents(kit, p)).find((e) => e.action === "delete" && detailsOf(e).op === "retention.destroy")!);

interface Held {
  p: Project;
  sf: SourceFile;
  /** The backup that holds the raw file (made 2026-12-02 09:59). */
  x: BackupResult;
}

/** A project with one raw file and one backup that holds it; the clock is then at the destruction's time. */
async function held(name = "Study"): Promise<Held> {
  const p = await makeProject(kit, RETAIN, false, name);
  const sf = await rawSource(p);
  at("2026-12-02T09:59:00.000Z");
  const x = await backupProject(kit.repo, p.id);
  at("2026-12-02T10:00:00.000Z");
  return { p, sf, x };
}

describe("D15: a destruction with the backups manifest missing", () => {
  it("the manifest deleted, then a destruction: the backup that holds the destroyed file is found, listed and removed; the record never says none", async () => {
    const { p, sf, x } = await held();
    await rm(manifestPath());
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    // Decided at the destruction, from the manifest rebuilt from the backups themselves.
    expect((r.original.backups as { status: string; containing: string[] })).toMatchObject({ status: "pending", containing: [rel(x)] });
    expect(await commitOf(p)).toMatchObject({ backupsToRemove: [rel(x)], backupsUnreadable: [] });
    expect(existsSync(x.path)).toBe(false);
    expect(r.status).toBe("deleted");
    expect((r.certificate.backups as { deleted: string[] }).deleted).toEqual([rel(x)]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    // The manifest is there again, and lists what is left: the backup the destruction made.
    const fresh = (r.certificate.backups as { freshBackup: string }).freshBackup;
    expect((await manifestNow()).backups.map((b) => `Backups/${b.file}`)).toEqual([fresh]);
  });

  it("the manifest deleted and a backup of the project that cannot be read: it is listed as needing a look, never deleted blindly, and the warning is raised", async () => {
    const { p, sf, x } = await held();
    // Damaged on disk: not a zip any more. It may hold the file, and nothing can tell.
    await writeFile(x.path, "not an archive any more");
    await rm(manifestPath());
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect((r.original.backups as { status: string; containing: string[] })).toMatchObject({ status: "unknown-pending", containing: [rel(x)] });
    expect(await commitOf(p)).toMatchObject({ backupsToRemove: [], backupsUnreadable: [rel(x)] });
    expect(r.status).toBe("unknown-pending");
    expect(existsSync(x.path)).toBe(true);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    expect((await readDestruction(kit.repo, p.id, r.certificatePath)).outstanding).toEqual([rel(x)]);
  });

  it("the same with the app's own note of who owns each backup gone too: the unreadable backup is known by the project's name", async () => {
    const { p, sf, x } = await held();
    await writeFile(x.path, "not an archive any more");
    await rm(manifestPath());
    await rm(join(backupsDir(), BACKUPS_STATE));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.status).toBe("unknown-pending");
    expect(await commitOf(p)).toMatchObject({ backupsUnreadable: [rel(x)] });
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
  });

  it("a backup of another project in the same folder is never listed and never touched, readable or not", async () => {
    const other = await makeProject(kit, RETAIN, false, "Other");
    await rawSource(other);
    const theirs = await backupProject(kit.repo, other.id);
    const theirBytes = await readFile(theirs.path);
    const { p, sf, x } = await held();
    await rm(manifestPath());
    let r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect((r.original.backups as { containing: string[] }).containing).toEqual([rel(x)]);
    expect(existsSync(x.path)).toBe(false);
    expect((await readFile(theirs.path)).equals(theirBytes)).toBe(true);
    expect((await listBackups(kit.repo, other.id)).map((b) => b.file)).toEqual([nameOf(theirs)]);

    // Unreadable this time, and the manifest gone again: it still belongs to the other project.
    await writeFile(theirs.path, "damaged");
    await rm(manifestPath());
    const again = await rawSource(p, "a second raw file");
    at("2026-12-02T11:00:00.000Z");
    r = await destroyRaw(kit.repo, p.id, [again.assets[0]!.id], "tester");
    expect(JSON.stringify(r.original.backups)).not.toContain(nameOf(theirs));
    expect(await readFile(theirs.path, "utf8")).toBe("damaged");
  });

  it("a project with no backups at all still has none, truthfully: alone, and beside another project's backups", async () => {
    const p = await makeProject(kit, RETAIN, false, "Fresh");
    const sf = await rawSource(p);
    at("2026-12-02T10:00:00.000Z");
    backupSeams.failBackup = true; // none before, and none made by the destruction either
    let r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.backups).toMatchObject({ status: "none", containing: [] });
    expect(r.status).toBe("none");
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);

    backupSeams.failBackup = false;
    const other = await makeProject(kit, RETAIN, false, "Other");
    await rawSource(other);
    const theirs = await backupProject(kit.repo, other.id);
    await rm(manifestPath());
    backupSeams.failBackup = true;
    const again = await rawSource(p, "a second raw file");
    at("2026-12-02T11:00:00.000Z");
    r = await destroyRaw(kit.repo, p.id, [again.assets[0]!.id], "tester");
    expect(r.original.backups).toMatchObject({ status: "none", containing: [] });
    expect(existsSync(theirs.path)).toBe(true);
  });
});

describe("D15: the manifest missing at a retry pass, at a prune and at a restore", () => {
  it("a retry pass: the listed backup is removed and recorded, and the manifest is rebuilt so the project's other backups are known again", async () => {
    const { p, sf, x } = await held();
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    expect(r.status).toBe("pending");
    const fresh = (r.certificate.backups as { freshBackup: string }).freshBackup;
    await rm(manifestPath());

    at(new Date(kit.clock.now.getTime() + HOUR).toISOString());
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(x.path)).toBe(false);
    expect(await readDestruction(kit.repo, p.id, r.certificatePath)).toMatchObject({ status: "deleted", outstanding: [] });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    expect((await listBackups(kit.repo, p.id)).map((b) => `Backups/${b.file}`)).toEqual([fresh]);
    expect((await manifestNow()).backups.map((b) => `Backups/${b.file}`)).toEqual([fresh]);
  });

  it("a prune: the project's older backups are found and removed, a backup of another project stays", async () => {
    const other = await makeProject(kit, OPEN_GOV, false, "Other");
    const theirs = await backupProject(kit.repo, other.id);
    const p = await makeProject(kit, OPEN_GOV, false, "Pruned");
    const made: BackupResult[] = [];
    for (const minute of ["09:31", "09:32", "09:33"]) {
      at(`2026-11-10T${minute}:00.000Z`);
      made.push(await backupProject(kit.repo, p.id, { prune: false }));
    }
    await rm(manifestPath());
    const removed = await pruneBackups(kit.repo, p.id, 1);
    expect(removed.sort()).toEqual([nameOf(made[0]!), nameOf(made[1]!)].sort());
    expect(existsSync(made[0]!.path)).toBe(false);
    expect(existsSync(made[1]!.path)).toBe(false);
    expect(existsSync(made[2]!.path)).toBe(true);
    expect(existsSync(theirs.path)).toBe(true);
    const pruned = (await auditEvents(kit, p)).filter((e) => e.action === "backup.prune");
    expect(pruned).toHaveLength(1);
    expect((detailsOf(pruned[0]!).files ?? []).sort()).toEqual(removed.sort());
    expect((await listBackups(kit.repo, other.id)).map((b) => b.file)).toEqual([nameOf(theirs)]);
  });

  it("a restore: the backup is known as its project's again, so the restore waits for that project's maintenance lock", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Chosen");
    await addSource(kit, p, { title: "inside" });
    const b = await backupProject(kit.repo, p.id);
    await rm(manifestPath());
    let finished = false;
    let restore: Promise<unknown> = Promise.resolve();
    await withProjectMaintenance(kit.repo, p.id, async () => {
      restore = restoreBackup(kit.repo, b.path).then(() => {
        finished = true;
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(finished).toBe(false);
    });
    await restore;
    expect(finished).toBe(true);
    expect((await manifestNow()).backups.map((e) => [e.file, e.projectId, e.sha256])).toEqual([[nameOf(b), p.id, b.sha256]]);
  });

  it("in a library another computer holds (open read-only here): the list is rebuilt in memory, and nothing is written into the library", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Held Elsewhere");
    await addSource(kit, p, { title: "x" });
    const older = await backupProject(kit.repo, p.id, { prune: false });
    at("2026-11-10T09:31:00.000Z");
    const b = await backupProject(kit.repo, p.id, { prune: false });
    await rm(manifestPath());
    // A second computer opens the same folder while the first holds its lock.
    const other: Deps = {
      clock: () => kit.clock.now,
      deviceId: "dev-B",
      hostname: "host-B",
      pid: process.pid + 1,
      isPidAlive: () => true,
      appConfigDir: join(kit.tmp, "config-b"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const lib = await openLibrary(kit.lib.root, other);
    try {
      expect(lib.mode).toBe("read-only");
      const repo = await openTestRepo(lib, new KeyRing(), { clock: () => kit.clock.now, tz: "UTC", actor: "elsewhere", scryptN: 2 ** 10 });
      const inFolder = async () => (await readdir(backupsDir())).sort();
      const before = await inFolder();
      expect((await listBackups(repo, p.id)).map((e) => [e.file, e.sha256])).toEqual([[nameOf(b), b.sha256], [nameOf(older), older.sha256]]);
      expect(await inFolder()).toEqual(before);
      expect(existsSync(manifestPath())).toBe(false);
      // The same for a damaged one: it is neither moved aside nor replaced from here.
      await writeFile(manifestPath(), "{ damaged");
      expect((await listBackups(repo, p.id)).map((e) => e.file)).toEqual([nameOf(b), nameOf(older)]);
      expect(await readFile(manifestPath(), "utf8")).toBe("{ damaged");
      expect(await inFolder()).toEqual([...before, BACKUPS_MANIFEST].sort());
      // Nor is a backup removed from there: pruning is refused before anything is touched.
      await expect(pruneBackups(repo, p.id, 1)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
      expect(existsSync(b.path)).toBe(true);
      expect(existsSync(older.path)).toBe(true);
      expect(await inFolder()).toEqual([...before, BACKUPS_MANIFEST].sort());
    } finally {
      await lib.close();
    }
  });

  it("an archive that has its name but is not yet recorded as a backup is not listed by a rebuild", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Unfinished");
    // The process dies after the archive got its backup name, before the audit log records it.
    backupSeams.crashAt = "before-commit";
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
    const named = join(backupsDir(), "Unfinished - backup - modified 2026-11-10 0930.zip");
    expect(existsSync(named)).toBe(true);
    expect(existsSync(manifestPath())).toBe(false);
    // Something reads the manifest before the interrupted backup is settled.
    await forgetMissingBackups(kit.repo, ["Nothing - backup - modified 2026-01-01 0000.zip"]);
    expect(existsSync(manifestPath()) ? (await manifestNow()).backups : []).toEqual([]);
    // Settled by what the audit log says: it was never a backup.
    expect(await listBackups(kit.repo, p.id)).toEqual([]);
    expect(existsSync(named)).toBe(false);
    expect(existsSync(manifestPath()) ? (await manifestNow()).backups : []).toEqual([]);
  });
});

describe("a backup that takes the name of one removed outside the app", () => {
  it("replaces the manifest entry of the old one, and restores", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Twice");
    await addSource(kit, p, { title: "first" });
    const one = await backupProject(kit.repo, p.id);
    await rm(one.path); // outside the app
    await addSource(kit, p, { title: "second" });
    // The same minute on the clock: the name is free again, and is given again.
    const two = await backupProject(kit.repo, p.id);
    expect(two.path).toBe(one.path);
    expect(two.sha256).not.toBe(one.sha256);
    const list = await listBackups(kit.repo, p.id);
    expect(list.map((b) => [b.file, b.sha256])).toEqual([[nameOf(two), two.sha256]]);
    expect((await manifestNow()).backups.filter((b) => b.file === nameOf(two))).toHaveLength(1);
    const restored = await restoreBackup(kit.repo, two.path);
    expect(kit.repo.listSourceIds(restored.projectId)).toHaveLength(2);
  });

  it("also when the backup was interrupted after its commit and is listed at the next start", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Twice Crashed");
    await addSource(kit, p, { title: "first" });
    const one = await backupProject(kit.repo, p.id);
    await rm(one.path);
    await addSource(kit, p, { title: "second" });
    backupSeams.crashAt = "before-manifest";
    await expect(backupProject(kit.repo, p.id)).rejects.toBeInstanceOf(SimulatedCrash);
    await kit.reopen();
    const list = await listBackups(kit.repo, p.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.file).toBe(nameOf(one));
    expect(list[0]!.sha256).not.toBe(one.sha256);
    expect((await manifestNow()).backups.filter((b) => b.file === nameOf(one))).toHaveLength(1);
    await restoreBackup(kit.repo, one.path);
  });
});
