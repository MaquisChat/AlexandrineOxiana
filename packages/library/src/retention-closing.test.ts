/**
 * FR-749, R554: a retention destruction's backups step cut by the library's close. R138 e speaks of a fresh backup that
 * COULD NOT be made; a backup cut by the library's closing is not that. When the library closes during the step — at
 * the fresh backup, between two removals, after the removals — the step stops now: no further backup is removed (a
 * removal already under way finishes), nothing is recorded (no amendment, no failure, no "no new backup could be
 * made"), the destruction's retry record stays as it was, and the close waits for the step, so nothing under the
 * library changes after `close()` resolved. At the next opening the destruction's pass does the step again: the fresh
 * backup, the removals still owed (a listed backup already removed before the cut is found gone and recorded as no
 * longer present, as after a crash: the app's own record of that removal was never committed), the amendment.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import type { AuditEvent, Project, SourceFile } from "@ao/core";
import { KeyRing } from "./crypto/keys.js";
import { shredSeams } from "./fs/shred.js";
import { openLibrary, type Library } from "./library.js";
import { openTestRepo } from "./repo/testing.js";
import type { Repo } from "./repo/repo.js";
import { backupFailure, backupProject, backupSeams, restoreBackup, type BackupResult } from "./export/backup.js";
import { addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "./export/test-kit.js";
import { destroyRaw, listDestructions, readDestruction, resumeDestruction } from "./retention.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-retention-closing-");
});
afterEach(async () => {
  backupSeams.afterSnapshot = undefined;
  shredSeams.failFor = undefined;
  await kit.close().catch(() => {});
});

const HOUR = 3_600_000;
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
processing:
  metadata_lookup: []
`;

const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;

/** Every file under the library with its bytes' digest (folders by name). */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, r))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${r} ${digest}`);
  }
  return out;
}

/** The backups state file as written, or an empty one when there is none. */
async function stateFile(): Promise<{ failures: Record<string, unknown>; retries: Record<string, unknown> }> {
  try {
    const s = JSON.parse(await readFile(join(kit.lib.root, "Backups", "backups-state.json"), "utf8"));
    return { failures: s.failures ?? {}, retries: s.retries ?? {} };
  } catch {
    return { failures: {}, retries: {} };
  }
}

/** The project's audit events, read from its folder (no repository needed). */
async function events(p: Project): Promise<AuditEvent[]> {
  const dir = join(kit.lib.root, p.folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}
const stepEvents = async (p: Project) => (await events(p)).filter((e) => e.action === "retention.backups" || (e.details as { op?: string } | undefined)?.op === "retention.backups");
const retentionFiles = async (p: Project) => (await readdir(join(kit.lib.root, p.folder, "retention"))).sort();
const zips = async () => (await readdir(join(kit.lib.root, "Backups"))).filter((n) => n.endsWith(".zip")).sort();

/** A hold for a seam: `inside` resolves when the seam is reached; `release` lets it go (also when the test ends). */
function hold(): { seam: () => Promise<void>; inside: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  let first = true;
  const seam = async () => {
    if (!first) return;
    first = false;
    entered();
    await gate;
  };
  return { seam, inside, release };
}

async function rawSource(p: Project): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", "RAW interview audio bytes");
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

/** A project with a raw original due for destruction and `n` backups that hold it. */
async function withBackups(n: number): Promise<{ p: Project; sf: SourceFile; backups: BackupResult[] }> {
  const p = await makeProject(kit, RETAIN, false, "Harbour interviews");
  const sf = await rawSource(p);
  const backups: BackupResult[] = [];
  for (let i = 0; i < n; i++) {
    kit.clock.now = new Date(Date.parse("2026-11-10T09:30:00.000Z") + i * 60_000);
    backups.push(await backupProject(kit.repo, p.id));
  }
  kit.clock.now = new Date("2026-12-02T10:15:00.000Z");
  return { p, sf, backups };
}

/** A second Library object on the same folder, as at the next opening; closed when the test ends. */
async function openAgain(): Promise<{ lib: Library; repo: Repo }> {
  const lib = await openLibrary(kit.lib.root, {
    clock: () => kit.clock.now,
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(kit.tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
  onTestFinished(() => lib.close());
  expect(lib.mode).toBe("read-write");
  const repo = await openTestRepo(lib, new KeyRing(), { clock: () => kit.clock.now, tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
  return { lib, repo };
}

/**
 * Runs `start`; `closing()` gives the close once the test began it. After `close()` resolved the folder is
 * snapshotted, then again once everything settled: the two must be identical.
 */
async function settle<T>(start: Promise<T>, closing: () => Promise<void> | undefined, began: Promise<void>) {
  const outcome = start.then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err }),
  );
  await began;
  await closing();
  const afterClose = await snapshot(kit.lib.root);
  const result = await outcome;
  await new Promise((r) => setTimeout(r, 50));
  expect(await snapshot(kit.lib.root)).toEqual(afterClose);
  return result;
}

/** Closes the library when the first of `names` begins to be overwritten (that removal is under way and finishes). */
function closeAtRemovalOf(names: string[]): { closing: () => Promise<void> | undefined; began: Promise<void>; first: () => string | undefined } {
  let closing: Promise<void> | undefined;
  let first: string | undefined;
  let began!: () => void;
  const b = new Promise<void>((r) => (began = r));
  shredSeams.failFor = (path) => {
    const n = names.find((x) => path.endsWith(`/${x}`));
    if (n && !closing) {
      first = n;
      closing = kit.lib.close();
      began();
    }
    return false;
  };
  return { closing: () => closing, began: b, first: () => first };
}

describe("a destruction's backups step cut by the library's close (FR-749, R554)", () => {
  it("the close comes while the step's fresh backup is held: it stops; nothing changes after close(); nothing recorded; the next opening completes it", async () => {
    const { p, sf, backups } = await withBackups(2);
    const [a, b] = backups as [BackupResult, BackupResult];
    const stateBefore = await stateFile();
    const h = hold();
    backupSeams.afterSnapshot = h.seam;
    let closing: Promise<void> | undefined;
    const began = h.inside.then(() => {
      closing = kit.lib.close();
      h.release();
    });
    const result = await settle(destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester"), () => closing, began);

    // The raw data was destroyed and its certificate written before the step: that stands, and is returned.
    expect(result).toHaveProperty("ok");
    const r = (result as { ok: Awaited<ReturnType<typeof destroyRaw>> }).ok;
    expect(r.amendments).toEqual([]);
    expect(r.status).toBe("pending");
    const said = r.certificate.backups as { containing: string[]; outstanding: string[] };
    expect({ ...said, containing: [...said.containing].sort(), outstanding: [...said.outstanding].sort() }).toEqual({ status: "pending", containing: [rel(a), rel(b)].sort(), deleted: [], outstanding: [rel(a), rel(b)].sort() });
    // Every listed backup is still there; no fresh backup; nothing recorded.
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(await zips()).toEqual([nameOf(a), nameOf(b)].sort());
    expect(await stateFile()).toEqual(stateBefore);
    expect((await retentionFiles(p)).filter((n) => n.includes("amendment"))).toEqual([]);
    expect(await stepEvents(p)).toEqual([]);

    // The next opening: the destruction's pass does the step again and completes it.
    kit.clock.now = new Date(kit.clock.now.getTime() + 60_000);
    const again = await openAgain();
    const listed = await listDestructions(again.repo, p.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: "pending", amendments: [] });
    expect([...listed[0]!.outstanding].sort()).toEqual([rel(a), rel(b)].sort());
    expect(await backupFailure(again.repo, p.id)).toBeUndefined();
    expect(await resumeDestruction(again.repo, p.id)).toEqual([r.certificatePath]);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    const rec = await readDestruction(again.repo, p.id, r.certificatePath);
    expect(rec.status).toBe("deleted");
    expect(rec.amendments).toHaveLength(1);
    const bk = rec.certificate!.backups as { deleted: string[]; freshBackup?: string; freshBackupFailed?: string; noLongerPresent?: unknown };
    expect([...bk.deleted].sort()).toEqual([rel(a), rel(b)].sort());
    expect(bk.freshBackup).toEqual(expect.stringMatching(/^Backups\//u));
    expect(bk.freshBackupFailed).toBeUndefined();
    expect(bk.noLongerPresent).toBeUndefined();
    expect(existsSync(join(kit.lib.root, ...bk.freshBackup!.split("/")))).toBe(true);
    expect((await stepEvents(p)).filter((e) => e.action === "delete")).toHaveLength(1);
    expect(await backupFailure(again.repo, p.id)).toBeUndefined();
    // A later pass adds nothing.
    kit.clock.now = new Date(kit.clock.now.getTime() + HOUR);
    const count = (await events(p)).length;
    expect(await resumeDestruction(again.repo, p.id)).toEqual([]);
    expect((await events(p)).length).toBe(count);
  });

  it("the close comes between two removals: the one under way finishes, the next is not made; nothing recorded; the next opening removes it and records both truly", async () => {
    const { p, sf, backups } = await withBackups(2);
    const [a, b] = backups as [BackupResult, BackupResult];
    const stateBefore = await stateFile();
    const c = closeAtRemovalOf([nameOf(a), nameOf(b)]);
    const result = await settle(destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester"), c.closing, c.began);
    expect(result).toHaveProperty("ok");
    const r = (result as { ok: Awaited<ReturnType<typeof destroyRaw>> }).ok;
    expect(r.amendments).toEqual([]);
    const first = c.first()!;
    const [done, owed] = first === nameOf(a) ? [a, b] : [b, a];
    expect(existsSync(done.path)).toBe(false);
    expect(existsSync(owed.path)).toBe(true);
    expect(await stateFile()).toEqual(stateBefore);
    expect((await retentionFiles(p)).filter((n) => n.includes("amendment"))).toEqual([]);
    expect(await stepEvents(p)).toEqual([]);
    // The fresh backup was made (and recorded as a backup) before the cut; the step's record of it was not.
    const fresh = (await zips()).filter((n) => n !== nameOf(owed));
    expect(fresh).toHaveLength(1);

    shredSeams.failFor = undefined;
    kit.clock.now = new Date(kit.clock.now.getTime() + 60_000);
    const again = await openAgain();
    const listed = (await listDestructions(again.repo, p.id))[0]!;
    expect(listed.status).toBe("pending");
    expect([...listed.outstanding].sort()).toEqual([rel(a), rel(b)].sort());
    expect(await resumeDestruction(again.repo, p.id)).toEqual([r.certificatePath]);
    expect(existsSync(owed.path)).toBe(false);
    expect(existsSync(join(kit.lib.root, "Backups", fresh[0]!))).toBe(true); // not listed: untouched
    const steps = (await stepEvents(p)).filter((e) => e.action === "delete");
    expect(steps).toHaveLength(1);
    // Removed by the app: the one this pass removed. The one removed before the cut was never recorded as removed,
    // so it is recorded as found no longer present, at the time this pass noticed it (as after a crash).
    expect(steps[0]!.details).toMatchObject({ removed: [rel(owed)], noLongerPresent: [rel(done)], status: "no-longer-present" });
    const rec = await readDestruction(again.repo, p.id, r.certificatePath);
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [] });
    const bk = rec.certificate!.backups as { deleted: string[]; noLongerPresent: Array<{ file: string; at: string }>; freshBackup?: string };
    expect(bk.deleted).toEqual([rel(owed)]);
    expect(bk.noLongerPresent).toEqual([{ file: rel(done), at: kit.clock.now.toISOString() }]);
    expect(bk.freshBackup).toEqual(expect.stringMatching(/^Backups\//u));
  });

  it("the close comes during the last removal, before the amendment's record: nothing recorded; the next pass records it as no longer present and removes nothing", async () => {
    const { p, sf, backups } = await withBackups(1);
    const [a] = backups as [BackupResult];
    const stateBefore = await stateFile();
    const c = closeAtRemovalOf([nameOf(a)]);
    const result = await settle(destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester"), c.closing, c.began);
    expect(result).toHaveProperty("ok");
    const r = (result as { ok: Awaited<ReturnType<typeof destroyRaw>> }).ok;
    expect(r.amendments).toEqual([]);
    expect(existsSync(a.path)).toBe(false);
    expect(await stateFile()).toEqual(stateBefore);
    expect(await stepEvents(p)).toEqual([]);
    const fresh = await zips();
    expect(fresh).toHaveLength(1);

    shredSeams.failFor = undefined;
    kit.clock.now = new Date(kit.clock.now.getTime() + 60_000);
    const again = await openAgain();
    expect(await resumeDestruction(again.repo, p.id)).toEqual([r.certificatePath]);
    const steps = (await stepEvents(p)).filter((e) => e.action === "delete");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.details).toMatchObject({ removed: [], noLongerPresent: [rel(a)], status: "no-longer-present" });
    expect(await zips()).toEqual(fresh); // nothing else removed, no second fresh backup (nothing was left to remove)
    expect(await readDestruction(again.repo, p.id, r.certificatePath)).toMatchObject({ status: "no-longer-present", outstanding: [] });
  });

  it("a retry pass cut by the close leaves the destruction's retry record exactly as it was; the next opening settles it", async () => {
    const { p, sf, backups } = await withBackups(1);
    const [x] = backups as [BackupResult];
    // The destruction could not remove X: recorded, with a retry record.
    shredSeams.failFor = (path) => path.endsWith(`/${nameOf(x)}`);
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    expect(r.status).toBe("pending");
    const stateBefore = await stateFile();
    expect(Object.keys(stateBefore.retries)).toHaveLength(1);
    const eventsBefore = (await events(p)).length;

    kit.clock.now = new Date(kit.clock.now.getTime() + HOUR);
    const c = closeAtRemovalOf([nameOf(x)]);
    const result = await settle(resumeDestruction(kit.repo, p.id), c.closing, c.began);
    expect(result).toHaveProperty("ok");
    expect(existsSync(x.path)).toBe(false);
    expect(await stateFile()).toEqual(stateBefore);
    expect((await events(p)).length).toBe(eventsBefore);

    shredSeams.failFor = undefined;
    kit.clock.now = new Date(kit.clock.now.getTime() + 60_000);
    const again = await openAgain();
    expect(await resumeDestruction(again.repo, p.id)).toEqual([r.certificatePath]);
    expect(await readDestruction(again.repo, p.id, r.certificatePath)).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect(Object.keys((await stateFile()).retries)).toEqual([]);
  });

  it("an inherited list (R138 a, R175): a restored copy's pass cut by the close while it removes the original's backup records nothing; the next opening records it truly", async () => {
    const { p, sf, backups } = await withBackups(1);
    const [x] = backups as [BackupResult];
    // The destruction could not remove X; its fresh backup is restored as a copy that inherits the list.
    shredSeams.failFor = (path) => path.endsWith(`/${nameOf(x)}`);
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const fresh = (r.certificate.backups as { freshBackup?: string }).freshBackup!;
    const copy = (await restoreBackup(kit.repo, join(kit.lib.root, ...fresh.split("/")))).projectId;
    const copyFolder = kit.repo.getProject(copy).folder;
    const stateBefore = await stateFile();
    const zipsBefore = await zips();

    kit.clock.now = new Date(kit.clock.now.getTime() + HOUR);
    const c = closeAtRemovalOf([nameOf(x)]);
    const result = await settle(resumeDestruction(kit.repo, copy), c.closing, c.began);
    expect(result).toHaveProperty("ok");
    expect(existsSync(x.path)).toBe(false);
    // The copy's own fresh backup was made before the removal; nothing of the step was recorded.
    expect((await zips()).filter((n) => !zipsBefore.includes(n))).toHaveLength(1);
    expect(await stateFile()).toEqual(stateBefore);
    expect((await events({ ...p, folder: copyFolder } as Project)).filter((e) => (e.details as { op?: string } | undefined)?.op === "retention.backups")).toEqual([]);

    shredSeams.failFor = undefined;
    kit.clock.now = new Date(kit.clock.now.getTime() + 60_000);
    const again = await openAgain();
    expect(await resumeDestruction(again.repo, copy)).toHaveLength(1);
    const rec = await readDestruction(again.repo, copy, r.certificatePath.slice(r.certificatePath.lastIndexOf("/") + 1));
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect((rec.certificate!.backups as { deleted: string[] }).deleted).toEqual([]);
  });
});
