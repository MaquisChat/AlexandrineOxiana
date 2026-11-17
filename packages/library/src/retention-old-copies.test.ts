/**
 * FR-A16 (R379, WB2 I2): a destruction under the retention rule is true about the old copies of the
 * library that "Move library" leaves behind and this computer still lists. Such a copy that still
 * holds the destroyed files is named in the certificate as NOT destroyed (by the date of the move,
 * never by its path), and the project carries `destruction-old-copies-pending` until it is gone —
 * built as the pending backups' mechanism is (R147).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project, SourceFile } from "@ao/core";
import { DESTRUCTION_OLD_COPIES_PENDING_WARNING } from "@ao/shared";
import type { Deps } from "./deps.js";
import { backupProject, restoreBackup } from "./export/backup.js";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { openLibrary, type Library } from "./library.js";
import type { LocationEnv } from "./location.js";
import { deleteOldCopy, executeMove } from "./move.js";
import { addPendingOldCopy, markPendingComplete } from "./old-copies.js";
import { projectWarnings, type Repo } from "./repo/index.js";
import { openTestRepo } from "./repo/testing.js";
import { DESTRUCTION_NOTICE, destroyRaw, oldCopiesAwaitingDeletion, oldCopiesBehindWarning, readDestruction, resumeDestruction } from "./retention.js";

const WARNING = "destruction-old-copies-pending";
const MOVED_AT = "2026-11-10T09:30:00.000Z";
const DUE = new Date("2026-12-02T10:00:00.000Z");

const GOV = `identifiability:
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

let kit: Kit;
let opened: Library[];
beforeEach(async () => {
  kit = await makeKit("ao-oldcopies-");
  opened = [];
});
afterEach(async () => {
  for (const l of opened) await l.close().catch(() => {});
  await kit.close();
});

/** This computer's deps; `computer: "B"` is another computer (its own device id and configuration folder). */
function deps(computer: "A" | "B" = "A"): Deps {
  return {
    clock: () => kit.clock.now,
    deviceId: `dev-${computer}`,
    hostname: `host-${computer}`,
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: computer === "A" ? kit.lib.appConfigDir : join(kit.tmp, "config-B"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}
const env = (): LocationEnv => ({ homeDir: join(kit.tmp, "home"), platform: "linux", mounts: [{ path: "/", removable: false, network: false }] });

async function rawSource(p: Project, content = "RAW interview audio bytes"): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", content);
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

async function openAt(root: string, computer: "A" | "B" = "A"): Promise<Repo> {
  const lib = await openLibrary(root, deps(computer));
  opened.push(lib);
  return openTestRepo(lib, kit.ring, { clock: () => kit.clock.now, tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
}

/** A project with one raw original; the library is then moved (the old copy stays listed), and opened at its new place. */
async function movedLibrary(opts: { split?: boolean } = {}) {
  const p = await makeProject(kit, GOV, false, "Interviews");
  const sf = await rawSource(p);
  const other = opts.split ? await makeProject(kit, GOV, false, "Stays") : undefined;
  const dest = join(kit.tmp, "Moved");
  const res = await executeMove(kit.lib, dest, { deps: deps(), env: env(), sourceRepo: kit.repo, ...(other ? { excludeProjectIds: [other.id] } : {}) });
  const repo = await openAt(dest);
  return { p, sf, dest, res, repo, asset: sf.assets[0]! };
}

async function events(repo: Repo, root: string, p: Project): Promise<AuditEvent[]> {
  const dir = join(root, repo.getProject(p.id).folder, "audit");
  const { readdir } = await import("node:fs/promises");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  return out;
}

describe("FR-A16: old copies of the library left by a move, at a destruction", () => {
  it("names a listed old copy that still holds the files as not destroyed, without any path, and raises the warning; the old copy is not touched", async () => {
    const { p, dest, repo, asset } = await movedLibrary();
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toEqual({
      status: "pending",
      notDestroyed: [{ movedAt: MOVED_AT, moveId: expect.any(String) }],
      note: expect.stringContaining("2026-11-10"),
    });
    expect(r.original.notice).toBe(DESTRUCTION_NOTICE);
    const text = await readFile(r.certificatePath, "utf8");
    expect(text).not.toContain(kit.lib.root);
    expect(text).not.toContain(dest);
    expect(text).not.toContain(kit.tmp);
    // The machine-readable record (the destruction's audit event) names it the same way, without a path.
    const ev = (await events(repo, dest, p)).find((e) => e.details?.op === "retention.destroy")!;
    expect(ev.details).toMatchObject({ oldCopiesNotDestroyed: [{ movedAt: MOVED_AT }] });
    expect(JSON.stringify(ev)).not.toContain(kit.tmp);
    // The warning, with its note.
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect(DESTRUCTION_OLD_COPIES_PENDING_WARNING).toBe(WARNING);
    // The sentence that fits is R409 d's (see the "R409 (d)" tests).
    expect(await oldCopiesAwaitingDeletion(repo, p.id)).toEqual([{ certificateFile: expect.stringMatching(/retention\/destruction-/u), oldCopies: [{ movedAt: MOVED_AT }] }]);
    // The destruction did not reach into the old copy (it is the researcher's to delete).
    expect(await readFile(join(kit.lib.root, ...asset.path.split("/")), "utf8")).toBe("RAW interview audio bytes");
    expect(existsSync(join(dest, ...asset.path.split("/")))).toBe(false);
  });

  it("the old copy deleted through the app: the warning ends, the certificate is amended and the audit log records it", async () => {
    kit.clock.now = DUE;
    const { p, dest, res, repo, asset } = await movedLibrary();
    kit.clock.now = new Date(DUE.getTime() + 3600_000);
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending" });
    const written = await readFile(r.certificatePath);
    await deleteOldCopy(kit.lib.root, res.confirmToken, { deps: deps(), destRepo: repo });
    expect(existsSync(join(kit.lib.root, ...asset.path.split("/")))).toBe(false);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(repo, p.id)).toEqual([]);
    const rec = await readDestruction(repo, p.id, r.certificatePath);
    expect((await readFile(r.certificatePath)).equals(written)).toBe(true);
    expect(rec.amendments).toHaveLength(1);
    expect(rec.amendments[0]!.content).toMatchObject({ oldCopies: { removed: [{ movedAt: DUE.toISOString() }], status: "deleted" } });
    expect(rec.certificate!.oldCopies).toMatchObject({ status: "deleted", removed: [{ movedAt: DUE.toISOString() }] });
    expect(rec.problem).toBeUndefined();
    const evs = await events(repo, dest, p);
    expect(evs.find((e) => e.details?.op === "retention.backups" && Array.isArray(e.details?.oldCopiesRemoved))).toBeDefined();
    expect(evs.find((e) => e.action === "retention.old-copies")).toMatchObject({ details: { status: "deleted" } });
    expect(JSON.stringify(evs)).not.toContain(kit.tmp);
  });

  it("an old copy whose offer expired (older than 24 hours) still counts; removed by hand, the next pass records it as no longer holding the data", async () => {
    const { p, repo, asset } = await movedLibrary();
    kit.clock.now = DUE; // three weeks after the move
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending", notDestroyed: [{ movedAt: MOVED_AT }] });
    // A pass while it is still there changes nothing.
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).amendments).toHaveLength(0);
    // The researcher deletes the old copy by hand.
    await rm(kit.lib.root, { recursive: true, force: true });
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
    const rec = await readDestruction(repo, p.id, r.certificatePath);
    expect(rec.certificate!.oldCopies).toMatchObject({ status: "no-longer-present", noLongerHolding: [{ movedAt: MOVED_AT }] });
  });

  it("an old copy that is not reachable (its disk unplugged) counts as still holding the files", async () => {
    const { p, repo, asset } = await movedLibrary();
    const listFile = join(kit.lib.appConfigDir, "pending-old-copies.json");
    const list = JSON.parse(await readFile(listFile, "utf8")) as { records: Array<{ oldRoot: string }> };
    list.records[0]!.oldRoot = join(kit.tmp, "Volumes", "Unplugged", "Lib");
    await writeFile(listFile, JSON.stringify(list));
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending" });
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
  });

  it("an old copy that no longer holds the project's files does not count", async () => {
    const { p, repo, asset } = await movedLibrary();
    await rm(join(kit.lib.root, ...repo.getProject(p.id).folder.split("/")), { recursive: true, force: true });
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toEqual({ status: "none", notDestroyed: [], note: "Old copies of the library left by a move: none known to this computer." }); // the line every certificate has (R409 b)
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
  });

  it("an old copy of another library does not count", async () => {
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    // A folder that holds the same paths, listed for another library.
    const copy = join(kit.tmp, "OtherCopy");
    await mkdir(join(copy, ...sf.assets[0]!.path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(copy, ...sf.assets[0]!.path.split("/")), "same bytes");
    const rec = await addPendingOldCopy(deps(), { oldRoot: copy, newRoot: join(kit.tmp, "Elsewhere"), libraryId: "another-library", split: false, movedFolders: [], movedProjectIds: [p.id], moveId: "m1" }, { files: {}, dirs: [] });
    await markPendingComplete(deps(), rec.id);
    kit.clock.now = DUE;
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.oldCopies).toEqual({ status: "none", notDestroyed: [], note: "Old copies of the library left by a move: none known to this computer." }); // the line every certificate has (R409 b)
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });

  it("a list of old copies that cannot be read: the certificate says they could not be checked and the warning is raised; once readable, a pass checks", async () => {
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    const listFile = join(kit.lib.appConfigDir, "pending-old-copies.json");
    await mkdir(listFile, { recursive: true }); // reading it fails (not "missing")
    kit.clock.now = DUE;
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.oldCopies).toEqual({ status: "unknown-pending", notDestroyed: [], note: expect.stringContaining("could not be checked") });
    expect(r.original.notice).toBe(DESTRUCTION_NOTICE);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(kit.repo, p.id)).toEqual([{ certificateFile: expect.any(String), oldCopies: [], unchecked: true }]);
    // Still unreadable: the pass keeps the warning.
    await resumeDestruction(kit.repo, p.id);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);
    // Readable again (and no old copy holds the files): checked, recorded, and the warning ends.
    await rm(listFile, { recursive: true });
    await resumeDestruction(kit.repo, p.id);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    const rec = await readDestruction(kit.repo, p.id, r.certificatePath);
    expect(rec.certificate!.oldCopies).toMatchObject({ status: "none", checkedAt: DUE.toISOString() });
  });

  it("a split move: the moved project's folder left in the old root counts for that project", async () => {
    const { p, dest, repo, asset } = await movedLibrary({ split: true });
    expect(existsSync(join(kit.lib.root, ...asset.path.split("/")))).toBe(true);
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending", notDestroyed: [{ movedAt: MOVED_AT }] });
    expect(await readFile(r.certificatePath, "utf8")).not.toContain(dest);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
  });

  it("a copy restored from a backup made after the destruction inherits the warning, and settles it as the original does (R175)", async () => {
    const { p, repo, asset } = await movedLibrary();
    kit.clock.now = DUE;
    await destroyRaw(repo, p.id, [asset.id], "tester");
    const made = await backupProject(repo, p.id);
    const restored = await restoreBackup(repo, made.path);
    expect(restored.warnings).toContain(WARNING);
    expect(await projectWarnings(repo, restored.projectId)).toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(repo, restored.projectId)).toEqual([{ certificateFile: expect.stringContaining(`${restored.folder}/retention/`), oldCopies: [{ movedAt: MOVED_AT }] }]);
    // The old copy deleted by hand: each project's own pass records it, and both warnings end.
    await rm(kit.lib.root, { recursive: true, force: true });
    await resumeDestruction(repo, restored.projectId);
    expect(await projectWarnings(repo, restored.projectId)).not.toContain(WARNING);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
  });

  it("a library never moved: the certificate, its audit event and the warnings are as before", async () => {
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    kit.clock.now = DUE;
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(Object.keys(r.original)).toEqual(["formatVersion", "kind", "projectId", "at", "actor", "rule", "method", "includeDerived", "assets", "trashedCopies", "backups", "oldCopies", "notice"]); // plus the one line of R409 b
    expect(r.original.oldCopies).toEqual({ status: "none", notDestroyed: [], note: "Old copies of the library left by a move: none known to this computer." });
    const ev = (await events(kit.repo, kit.lib.root, p)).find((e) => e.details?.op === "retention.destroy")!;
    expect(Object.keys(ev.details!).filter((k) => k.startsWith("oldCopies"))).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(kit.repo, p.id)).toEqual([]);
  });
});

describe("R409 (a): a copy leaves the warning only when its place was looked at and holds none of the destroyed data", () => {
  const listFile = () => join(kit.lib.appConfigDir, "pending-old-copies.json");
  const closeAll = async () => {
    for (const l of opened.splice(0)) await l.close();
  };

  it("P1: the library opened on another computer, whose list has no record of the old copy: the warning stays and nothing is recorded; back on the first computer, the place emptied, the amendment is written", async () => {
    const { p, dest, repo, asset } = await movedLibrary();
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    await closeAll();
    const onB = await openAt(dest, "B");
    await resumeDestruction(onB, p.id);
    expect(await projectWarnings(onB, p.id)).toContain(WARNING);
    expect((await readDestruction(onB, p.id, r.certificatePath)).amendments).toHaveLength(0);
    expect((await readDestruction(onB, p.id, r.certificatePath)).certificate!.oldCopies).toMatchObject({ status: "pending" });
    await closeAll();
    // On the computer that moved it, once the old copy is really gone.
    await rm(kit.lib.root, { recursive: true, force: true });
    const onA = await openAt(dest);
    await resumeDestruction(onA, p.id);
    expect(await projectWarnings(onA, p.id)).not.toContain(WARNING);
    expect((await readDestruction(onA, p.id, r.certificatePath)).certificate!.oldCopies).toMatchObject({ status: "no-longer-present" });
  });

  it("P3: a list damaged after the destruction is 'cannot tell': the warning stays and nothing is recorded; the list readable again and the place emptied, the amendment is written", async () => {
    const { p, repo, asset } = await movedLibrary();
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    const good = await readFile(listFile(), "utf8");
    await writeFile(listFile(), "{ damaged");
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).amendments).toHaveLength(0);
    // A list whose record of this copy has no usable place is damaged too.
    const bad = JSON.parse(good) as { records: Array<Record<string, unknown>> };
    delete bad.records[0]!.oldRoot;
    await writeFile(listFile(), JSON.stringify(bad));
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).amendments).toHaveLength(0);
    await writeFile(listFile(), good);
    await rm(kit.lib.root, { recursive: true, force: true });
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).certificate!.oldCopies).toMatchObject({ status: "no-longer-present" });
  });

  it("P4: the app's deletion keeps a destroyed file: the record stays, marked deleted with remains, the warning stays at later passes; once the file is gone, the amendment is written and the record dropped", async () => {
    kit.clock.now = DUE;
    const { p, res, repo, asset } = await movedLibrary();
    kit.clock.now = new Date(DUE.getTime() + 3600_000);
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    const keptFile = join(kit.lib.root, ...asset.path.split("/"));
    await writeFile(keptFile, "RAW interview audio bytes, changed since the move");
    const out = await deleteOldCopy(kit.lib.root, res.confirmToken, { deps: deps(), destRepo: repo });
    expect(out.kept).toEqual([asset.path]);
    expect(existsSync(keptFile)).toBe(true);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    const list = JSON.parse(await readFile(listFile(), "utf8")) as { records: Array<{ deleted?: { at: string; remains: boolean } }> };
    expect(list.records).toHaveLength(1);
    expect(list.records[0]!.deleted).toEqual({ at: kit.clock.now.toISOString(), remains: true });
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).amendments).toHaveLength(0);
    // The researcher removes what was left by hand.
    await rm(kit.lib.root, { recursive: true, force: true });
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
    const rec = await readDestruction(repo, p.id, r.certificatePath);
    expect(rec.certificate!.oldCopies).toMatchObject({ status: "no-longer-present" });
    expect((JSON.parse(await readFile(listFile(), "utf8")) as { records: unknown[] }).records).toEqual([]);
  });
});

describe("R409 (b): the certificate always says where it stands on old copies", () => {
  const NONE = "Old copies of the library left by a move: none known to this computer.";
  const listFile = () => join(kit.lib.appConfigDir, "pending-old-copies.json");

  it("P2: a damaged list at the destruction: 'could not be checked' in the certificate, and the warning is raised", async () => {
    const { p, repo, asset } = await movedLibrary();
    await writeFile(listFile(), "{ damaged");
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toEqual({ status: "unknown-pending", notDestroyed: [], note: expect.stringContaining("could not be checked") });
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(repo, p.id)).toEqual([{ certificateFile: expect.any(String), oldCopies: [], unchecked: true }]);
  });

  it("a record without a usable place at the destruction: 'could not be checked', and the warning is raised", async () => {
    const { p, repo, asset } = await movedLibrary();
    const list = JSON.parse(await readFile(listFile(), "utf8")) as { records: Array<Record<string, unknown>> };
    list.records[0]!.oldRoot = 42;
    await writeFile(listFile(), JSON.stringify(list));
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "unknown-pending", note: expect.stringContaining("could not be checked") });
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
  });

  it("a readable list with no record of this library: the line says none is known to this computer (text and record); no warning", async () => {
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    kit.clock.now = DUE;
    const r = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.oldCopies).toEqual({ status: "none", notDestroyed: [], note: NONE });
    expect(await readFile(r.certificatePath, "utf8")).toContain(NONE);
    expect((await readDestruction(kit.repo, p.id, r.certificatePath)).certificate!.oldCopies).toMatchObject({ status: "none", note: NONE });
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });
});

describe("R409 (c): the old place's Backups and trash are looked at", () => {
  it("P5: a split move leaves the moved project's backup in the old root's Backups: the certificate names the old copy; after 'Delete the old copy' the warning stays until that backup is gone", async () => {
    kit.clock.now = DUE;
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    const other = await makeProject(kit, GOV, false, "Stays");
    const made = await backupProject(kit.repo, p.id);
    const dest = join(kit.tmp, "Moved");
    const res = await executeMove(kit.lib, dest, { deps: deps(), env: env(), sourceRepo: kit.repo, excludeProjectIds: [other.id] });
    const repo = await openAt(dest);
    expect(existsSync(made.path)).toBe(true); // still in the old root's Backups
    kit.clock.now = new Date(DUE.getTime() + 3600_000);
    const r = await destroyRaw(repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending", notDestroyed: [{ movedAt: DUE.toISOString() }] });
    await deleteOldCopy(kit.lib.root, res.confirmToken, { deps: deps(), destRepo: repo });
    expect(existsSync(join(kit.lib.root, ...sf.assets[0]!.path.split("/")))).toBe(false);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).amendments).toHaveLength(0);
    await rm(made.path);
    await resumeDestruction(repo, p.id);
    expect(await projectWarnings(repo, p.id)).not.toContain(WARNING);
    expect((await readDestruction(repo, p.id, r.certificatePath)).certificate!.oldCopies).toMatchObject({ status: "no-longer-present" });
  });

  it("an old copy whose project folder was removed by hand but whose Backups still hold the project's backup counts", async () => {
    const p = await makeProject(kit, GOV, false, "Interviews");
    const sf = await rawSource(p);
    await backupProject(kit.repo, p.id);
    const dest = join(kit.tmp, "Moved");
    await executeMove(kit.lib, dest, { deps: deps(), env: env(), sourceRepo: kit.repo });
    const repo = await openAt(dest);
    await rm(join(kit.lib.root, ...repo.getProject(p.id).folder.split("/")), { recursive: true, force: true });
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [sf.assets[0]!.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending" });
  });

  it("an old copy whose project folder was removed by hand but whose trash still holds a destroyed file counts", async () => {
    const { p, repo, asset } = await movedLibrary();
    await rm(join(kit.lib.root, ...repo.getProject(p.id).folder.split("/")), { recursive: true, force: true });
    const trash = join(kit.lib.root, ".tmp", "trash-0b3c1f2e-1111-4222-8333-944455556666-1");
    await mkdir(trash, { recursive: true });
    await writeFile(join(trash, asset.path.split("/").at(-1)!), "RAW interview audio bytes");
    kit.clock.now = DUE;
    const r = await destroyRaw(repo, p.id, [asset.id], "tester");
    expect(r.original.oldCopies).toMatchObject({ status: "pending" });
  });
});

describe("R409 (d): the researcher's screen is told the place and what can be done", () => {
  /** Every file under `dir`, read as text. */
  async function allText(dir: string): Promise<string> {
    const { readdir } = await import("node:fs/promises");
    let out = "";
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      out += e.isDirectory() ? await allText(p) : await readFile(p, "latin1");
    }
    return out;
  }

  it("each old copy behind the warning, by the date of its move, with its place from this computer's list and whether its offer is open; the place is in no file of the library", async () => {
    kit.clock.now = DUE;
    const { p, dest, repo, asset } = await movedLibrary();
    kit.clock.now = new Date(DUE.getTime() + 3600_000);
    await destroyRaw(repo, p.id, [asset.id], "tester");
    await resumeDestruction(repo, p.id);
    expect(await oldCopiesBehindWarning(repo, p.id)).toEqual({
      destructions: [{ certificateFile: expect.any(String), oldCopies: [{ movedAt: DUE.toISOString() }] }],
      unchecked: false,
      oldCopies: [{ movedOn: "2026-12-02", place: kit.lib.root, offerOpen: true }],
    });
    // A day later the offer has expired: the folder is to be deleted by hand.
    kit.clock.now = new Date(DUE.getTime() + 26 * 3600_000);
    expect((await oldCopiesBehindWarning(repo, p.id)).oldCopies).toEqual([{ movedOn: "2026-12-02", place: kit.lib.root, offerOpen: false }]);
    expect(await allText(dest)).not.toContain(kit.lib.root);
  });

  it("on a computer with no record of the old copy: no place, the date only", async () => {
    const { p, dest, repo, asset } = await movedLibrary();
    kit.clock.now = DUE;
    await destroyRaw(repo, p.id, [asset.id], "tester");
    for (const l of opened.splice(0)) await l.close();
    const onB = await openAt(dest, "B");
    expect(await oldCopiesBehindWarning(onB, p.id)).toMatchObject({ unchecked: false, oldCopies: [{ movedOn: "2026-11-10", offerOpen: false }] });
    expect((await oldCopiesBehindWarning(onB, p.id)).oldCopies[0]).not.toHaveProperty("place");
  });
});
