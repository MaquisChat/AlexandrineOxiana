/**
 * Task 49 round 5 (I1, R147 point 5, R175): a restored project and the destructions it inherits.
 * A destruction certificate and its amendments are evidence: a restore copies them byte for byte,
 * so they keep verifying against the audit events the copy inherited. The duty to see the listed
 * backups removed follows the data: the restored project keeps the inherited list and settles it as
 * the original would, never touching a file that only carries a listed backup's name.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain, type AuditEvent, type Project, type SourceFile } from "@ao/core";
import { shredSeams } from "../fs/shred.js";
import { projectWarnings } from "../repo/repo.js";
import { destroyRaw, listDestructions, readDestruction, resumeDestruction, type DestroyResult } from "../retention.js";
import { backupProject, backupSeams, holdingNotRemoved, listBackups, restoreBackup, withProjectMaintenance, type BackupResult } from "./backup.js";
import { PASS, addSource, auditEvents, makeKit, makeProject, plainOf, scratchFile, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-retention-restore-");
});
afterEach(async () => {
  shredSeams.failFor = undefined;
  backupSeams.crashAt = undefined;
  backupSeams.failBackup = false;
  await kit.close();
});

const HOUR = 3_600_000;
const WARNING = "destruction-backups-pending";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;
const abs = (libraryRelative: string) => join(kit.lib.root, ...libraryRelative.split("/"));
const later = (ms: number) => {
  kit.clock.now = new Date(kit.clock.now.getTime() + ms);
};

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

type Details = Record<string, unknown> & { op?: string; certificateSha256?: string; removed?: string[]; noLongerPresent?: string[]; problem?: string };
const detailsOf = (e: AuditEvent) => (e.details ?? {}) as Details;
const eventsOf = (projectId: string) => auditEvents(kit, kit.repo.getProject(projectId));
/** How many times the project's audit log records a backup as removed by the app, and as no longer present. */
async function recordedAs(projectId: string, file: string): Promise<{ removed: number; gone: number }> {
  const ev = (await eventsOf(projectId)).filter((e) => e.action === "delete" && detailsOf(e).op === "retention.backups");
  return { removed: ev.filter((e) => detailsOf(e).removed?.includes(file)).length, gone: ev.filter((e) => detailsOf(e).noLongerPresent?.includes(file)).length };
}
/** Nothing in the project's audit log gives a reason why the app would not act: no claim of a changed or missing file. */
const problemsSaid = async (projectId: string) => (await eventsOf(projectId)).map((e) => detailsOf(e).problem).filter((x) => x !== undefined);

interface Destroyed {
  p: Project;
  /** The backup that held the raw file (made 2026-12-02 09:59). */
  x: BackupResult;
  r: DestroyResult;
  /** The backup the destruction made itself: its audit log has the destruction, with X still on its list. */
  fresh: string;
  certificateName: string;
}

/** A project whose one raw file was destroyed on 2026-12-02 at 10:00; with `stuck`, the backup holding it could not be removed. */
async function destroyed(opts: { stuck: boolean; encrypted?: boolean; name?: string }): Promise<Destroyed> {
  const p = await makeProject(kit, opts.encrypted ? RETAIN.replace("atRest: optional", "atRest: required") : RETAIN, opts.encrypted === true, opts.name ?? "Origin");
  const sf = await rawSource(p);
  kit.clock.now = new Date("2026-12-02T09:59:00.000Z");
  const x = await backupProject(kit.repo, p.id);
  kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
  if (opts.stuck) shredSeams.failFor = (path) => path.endsWith(nameOf(x));
  const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
  shredSeams.failFor = undefined;
  const fresh = (r.certificate.backups as { freshBackup?: string }).freshBackup;
  expect(fresh).toBeDefined();
  expect(existsSync(x.path)).toBe(opts.stuck);
  return { p, x, r, fresh: abs(fresh!), certificateName: basename(r.certificatePath) };
}

/** The restored copy's certificate file (same name, in the copy's own retention folder). */
const copyOf = (projectId: string, d: Destroyed) => join(kit.lib.root, kit.repo.getProject(projectId).folder, "retention", d.certificateName);

/** The certificate of `d` in the project is the file written at the destruction, and the audit log there vouches for it and for every amendment. */
async function expectVerifies(projectId: string, d: Destroyed, written: Buffer): Promise<void> {
  const file = projectId === d.p.id ? d.r.certificatePath : copyOf(projectId, d);
  expect((await readFile(file)).equals(written)).toBe(true);
  const recorded = detailsOf((await eventsOf(projectId)).find((e) => e.action === "retention.destroyed")!).certificateSha256;
  const rec = await readDestruction(kit.repo, projectId, d.certificateName);
  expect(rec.verified).toBe(true);
  expect(rec.certificateSha256).toBe(recorded);
  expect(rec.problem).toBeUndefined();
  for (const am of rec.amendments) expect(am.verified).toBe(true);
  expect(verifyChain(await eventsOf(projectId)).ok).toBe(true);
}

describe("a restore copies destruction certificates and their amendments byte for byte", () => {
  it("restore after a destruction that was complete: the copy's certificate is the file as written, it verifies against the inherited audit events, and nothing false is said or recorded about it", async () => {
    const d = await destroyed({ stuck: false });
    const written = await readFile(d.r.certificatePath);
    expect(sha(written)).toBe(detailsOf((await eventsOf(d.p.id)).find((e) => e.action === "retention.destroyed")!).certificateSha256);

    // The backup the destruction made: its log has the destruction, and X still on its list.
    const first = await restoreBackup(kit.repo, d.fresh);
    await expectVerifies(first.projectId, d, written);
    let [rec] = await listDestructions(kit.repo, first.projectId);
    expect(rec).toMatchObject({ status: "pending", outstanding: [rel(d.x)], verified: true, amendments: [] });
    expect(rec!.original).toEqual(JSON.parse(written.toString("utf8")));
    // The reader says whose destruction it is: the certificate goes on naming that project's ids and folder.
    expect(rec!.inheritedFrom).toBe(d.p.id);
    expect((rec!.original as { projectId: string }).projectId).toBe(d.p.id);
    expect((await readDestruction(kit.repo, d.p.id, d.certificateName)).inheritedFrom).toBeUndefined();

    // Its first pass: X is not there (the original removed it), which is what it records.
    later(HOUR);
    await resumeDestruction(kit.repo, first.projectId);
    [rec] = await listDestructions(kit.repo, first.projectId);
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [], verified: true });
    expect(await recordedAs(first.projectId, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    expect(await problemsSaid(first.projectId)).toEqual([]);
    expect(await projectWarnings(kit.repo, first.projectId)).not.toContain(WARNING);
    await expectVerifies(first.projectId, d, written);
    // Nothing is left for a later pass.
    const count = (await eventsOf(first.projectId)).length;
    later(HOUR);
    expect(await resumeDestruction(kit.repo, first.projectId)).toEqual([]);
    expect((await eventsOf(first.projectId)).length).toBe(count);

    // A backup made once the step was recorded: certificate and amendment are both copied as they are.
    later(24 * HOUR);
    const afterwards = await backupProject(kit.repo, d.p.id, { prune: false });
    const second = await restoreBackup(kit.repo, afterwards.path);
    await expectVerifies(second.projectId, d, written);
    const mine = await readDestruction(kit.repo, d.p.id, d.certificateName);
    const copy = await readDestruction(kit.repo, second.projectId, d.certificateName);
    expect(copy).toMatchObject({ status: "deleted", outstanding: [], verified: true });
    expect(copy.amendments).toHaveLength(1);
    expect((await readFile(abs(copy.amendments[0]!.file))).equals(await readFile(abs(mine.amendments[0]!.file)))).toBe(true);
    expect(copy.amendments[0]!.sha256).toBe(mine.amendments[0]!.sha256);
    const before = (await eventsOf(second.projectId)).length;
    expect(await resumeDestruction(kit.repo, second.projectId)).toEqual([]);
    expect((await eventsOf(second.projectId)).length).toBe(before);
    expect(await problemsSaid(second.projectId)).toEqual([]);
    // The original is as it was.
    await expectVerifies(d.p.id, d, written);
  });

  it("an encrypted project: the sealed certificate is copied as it is and verifies in the copy", async () => {
    const d = await destroyed({ stuck: false, encrypted: true, name: "Sealed" });
    expect(d.certificateName.endsWith(".json.enc")).toBe(true);
    const sealed = await readFile(d.r.certificatePath);
    const restored = await restoreBackup(kit.repo, d.fresh, { passphrase: PASS });
    expect((await readFile(copyOf(restored.projectId, d))).equals(sealed)).toBe(true);
    const copy = kit.repo.getProject(restored.projectId);
    const recorded = detailsOf((await eventsOf(restored.projectId)).find((e) => e.action === "retention.destroyed")!).certificateSha256;
    expect(sha(await plainOf(kit, copy, `${copy.folder}/retention/${d.certificateName}`))).toBe(recorded);
    const [rec] = await listDestructions(kit.repo, restored.projectId);
    expect(rec).toMatchObject({ verified: true, status: "pending", outstanding: [rel(d.x)] });
    expect(rec!.problem).toBeUndefined();
  });
});

describe("a restored project settles the list it inherited, as the original would", () => {
  it("restore after a destruction with a stuck backup: the copy's retry removes it and records it once; the original then records it as no longer present; the certificate verifies in both", async () => {
    const d = await destroyed({ stuck: true });
    const written = await readFile(d.r.certificatePath);
    const restored = await restoreBackup(kit.repo, d.fresh);
    const copy = restored.projectId;
    expect(await listDestructions(kit.repo, copy)).toMatchObject([{ status: "pending", outstanding: [rel(d.x)], verified: true }]);

    // The copy's pass: the listed backup is there, it is the one that was listed, and it goes.
    later(HOUR);
    await resumeDestruction(kit.repo, copy);
    expect(existsSync(d.x.path)).toBe(false);
    expect(await recordedAs(copy, rel(d.x))).toEqual({ removed: 1, gone: 0 });
    const mine = await readDestruction(kit.repo, copy, d.certificateName);
    expect(mine).toMatchObject({ status: "deleted", outstanding: [] });
    expect((mine.certificate!.backups as { removedAt: Record<string, string> }).removedAt).toEqual({ [rel(d.x)]: kit.clock.now.toISOString() });
    expect(await holdingNotRemoved(kit.repo, copy)).toEqual([]);
    expect(await projectWarnings(kit.repo, copy)).not.toContain(WARNING);
    expect(await problemsSaid(copy)).toEqual([]);
    // As the original would: a backup of its own was made first.
    expect(await listBackups(kit.repo, copy)).toHaveLength(1);

    // The original's warning stands until its own pass finds the backup gone; it never says it removed it.
    expect(await projectWarnings(kit.repo, d.p.id)).toContain(WARNING);
    later(HOUR);
    await resumeDestruction(kit.repo, d.p.id);
    expect(await recordedAs(d.p.id, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    expect(await readDestruction(kit.repo, d.p.id, d.certificateName)).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect(await projectWarnings(kit.repo, d.p.id)).not.toContain(WARNING);

    // The same certificate bytes in both, vouched for by each project's own audit log; nothing recorded twice.
    await expectVerifies(d.p.id, d, written);
    await expectVerifies(copy, d, written);
    for (const id of [d.p.id, copy]) {
      const count = (await eventsOf(id)).length;
      later(HOUR);
      expect(await resumeDestruction(kit.repo, id)).toEqual([]);
      expect((await eventsOf(id)).length).toBe(count);
    }
  });

  it("the original settles first: it records the removal, and the copy records the backup as no longer present, once", async () => {
    const d = await destroyed({ stuck: true });
    const restored = await restoreBackup(kit.repo, d.fresh);
    later(HOUR);
    await resumeDestruction(kit.repo, d.p.id);
    expect(existsSync(d.x.path)).toBe(false);
    await resumeDestruction(kit.repo, restored.projectId);
    expect(await recordedAs(d.p.id, rel(d.x))).toEqual({ removed: 1, gone: 0 });
    expect(await recordedAs(restored.projectId, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    for (const id of [d.p.id, restored.projectId]) expect(await projectWarnings(kit.repo, id)).not.toContain(WARNING);
  });

  it("the copy removes the original's backup only while holding the original's maintenance lock", async () => {
    const d = await destroyed({ stuck: true });
    const restored = await restoreBackup(kit.repo, d.fresh);
    later(HOUR);
    let pass: Promise<unknown> = Promise.resolve();
    await withProjectMaintenance(kit.repo, d.p.id, async () => {
      // As if the original were being backed up, pruned or restored: the copy's pass waits for it.
      let finished = false;
      pass = resumeDestruction(kit.repo, restored.projectId).then(() => {
        finished = true;
      });
      await new Promise((r) => setTimeout(r, 1500));
      expect(finished).toBe(false);
      expect(existsSync(d.x.path)).toBe(true);
    });
    await pass;
    expect(existsSync(d.x.path)).toBe(false);
    expect(await recordedAs(restored.projectId, rel(d.x))).toEqual({ removed: 1, gone: 0 });
  });

  it("a restore whose listed name is reused: a later backup of the original under that name is never touched; the copy records the listed one as no longer present and its warning ends", async () => {
    const d = await destroyed({ stuck: true });
    const restored = await restoreBackup(kit.repo, d.fresh);
    const copy = restored.projectId;
    // The original removes X at last.
    kit.clock.now = new Date("2026-12-02T11:00:00.000Z");
    await resumeDestruction(kit.repo, d.p.id);
    expect(existsSync(d.x.path)).toBe(false);
    // A later backup of the original gets X's name (the same minute on the clock; the name is free again).
    // It holds only live data, and only the original's audit log knows it was made.
    kit.clock.now = new Date("2026-12-02T09:59:30.000Z");
    const again = await backupProject(kit.repo, d.p.id, { prune: false });
    expect(nameOf(again)).toBe(nameOf(d.x));

    kit.clock.now = new Date("2026-12-02T12:00:00.000Z");
    await resumeDestruction(kit.repo, copy);
    expect(existsSync(again.path)).toBe(true);
    expect(sha(await readFile(again.path))).toBe(again.sha256);
    expect((await listBackups(kit.repo, d.p.id)).map((b) => b.file)).toContain(nameOf(again));
    expect(await recordedAs(copy, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    expect(await readDestruction(kit.repo, copy, d.certificateName)).toMatchObject({ status: "no-longer-present", outstanding: [], verified: true });
    expect(await holdingNotRemoved(kit.repo, copy)).toEqual([]);
    expect(await projectWarnings(kit.repo, copy)).not.toContain(WARNING);
    expect(await problemsSaid(copy)).toEqual([]);
  });

  it("restore twice: one copy removes the stuck backup, the other and the original record it as no longer present; each records it once and every warning ends", async () => {
    const d = await destroyed({ stuck: true });
    const written = await readFile(d.r.certificatePath);
    const one = (await restoreBackup(kit.repo, d.fresh)).projectId;
    const two = (await restoreBackup(kit.repo, d.fresh)).projectId;
    expect(kit.repo.getProject(one).folder).not.toBe(kit.repo.getProject(two).folder);
    later(HOUR);
    for (const id of [one, two, d.p.id]) await resumeDestruction(kit.repo, id);
    expect(existsSync(d.x.path)).toBe(false);
    expect(await recordedAs(one, rel(d.x))).toEqual({ removed: 1, gone: 0 });
    expect(await recordedAs(two, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    expect(await recordedAs(d.p.id, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    for (const id of [one, two, d.p.id]) {
      expect(await projectWarnings(kit.repo, id)).not.toContain(WARNING);
      await expectVerifies(id, d, written);
      const names = await readdir(join(kit.lib.root, kit.repo.getProject(id).folder, "retention"));
      expect(names.filter((n) => n.includes(".amendment-")).length).toBe(id === d.p.id ? 2 : 1);
    }
  });

  it("a listed backup whose making the inherited log does not record (a copy put into Backups by hand): the restored project cannot tell it is the one listed, so it leaves it, says why and keeps its warning", async () => {
    const p = await makeProject(kit, RETAIN, false, "Origin");
    const sf = await rawSource(p);
    kit.clock.now = new Date("2026-12-02T09:59:00.000Z");
    const x = await backupProject(kit.repo, p.id);
    // A second copy of that backup under a backup's name, never made by the app: the manifest, rebuilt, lists it.
    const z = { path: join(kit.lib.root, "Backups", "Origin - backup - modified 2026-01-01 0000.zip") };
    await writeFile(z.path, await readFile(x.path));
    await writeFile(join(kit.lib.root, "Backups", "backups-manifest.json"), "garbage");
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(z));
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const bk = r.certificate.backups as { containing: string[]; freshBackup: string };
    expect(bk.containing.sort()).toEqual([rel(x), rel(z)].sort());
    expect(existsSync(x.path)).toBe(false);
    expect(existsSync(z.path)).toBe(true);

    const copy = (await restoreBackup(kit.repo, abs(bk.freshBackup))).projectId;
    later(HOUR);
    await resumeDestruction(kit.repo, copy);
    // X is gone and recorded so; Z is there, but nothing in the copy's log says which file that name stood for.
    expect(existsSync(z.path)).toBe(true);
    expect(await recordedAs(copy, rel(x))).toEqual({ removed: 0, gone: 1 });
    expect(await recordedAs(copy, rel(z))).toEqual({ removed: 0, gone: 0 });
    let rec = await readDestruction(kit.repo, copy, basename(r.certificatePath));
    expect(rec).toMatchObject({ status: "pending", outstanding: [rel(z)], verified: true });
    const notRemoved = (rec.certificate!.backups as { notRemoved?: Array<{ file: string; reason: string }> }).notRemoved ?? [];
    expect(notRemoved).toEqual([expect.objectContaining({ file: rel(z), reason: expect.stringMatching(/cannot tell/u) })]);
    expect(JSON.stringify(notRemoved)).not.toContain(kit.lib.root);
    expect(await holdingNotRemoved(kit.repo, copy)).toEqual([rel(z)]);
    expect(await projectWarnings(kit.repo, copy)).toContain(WARNING);

    // The original, whose own log knows the file, removes it; the copy then records it as no longer present.
    await resumeDestruction(kit.repo, p.id);
    expect(existsSync(z.path)).toBe(false);
    later(HOUR);
    await resumeDestruction(kit.repo, copy);
    expect(await recordedAs(copy, rel(z))).toEqual({ removed: 0, gone: 1 });
    rec = await readDestruction(kit.repo, copy, basename(r.certificatePath));
    expect(rec).toMatchObject({ status: "no-longer-present", outstanding: [] });
    expect(await projectWarnings(kit.repo, copy)).not.toContain(WARNING);
  });

  it("a listed backup removed by hand before the copy's first pass: recorded as no longer present, never as removed", async () => {
    const d = await destroyed({ stuck: true });
    const restored = await restoreBackup(kit.repo, d.fresh);
    await rm(d.x.path);
    later(HOUR);
    await resumeDestruction(kit.repo, restored.projectId);
    expect(await recordedAs(restored.projectId, rel(d.x))).toEqual({ removed: 0, gone: 1 });
    expect(await projectWarnings(kit.repo, restored.projectId)).not.toContain(WARNING);
  });
});
