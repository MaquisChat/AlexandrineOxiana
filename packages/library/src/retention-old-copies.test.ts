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
import { DESTRUCTION_OLD_COPIES_PENDING_TEXT, DESTRUCTION_OLD_COPIES_PENDING_WARNING } from "@ao/shared";
import type { Deps } from "./deps.js";
import { backupProject, restoreBackup } from "./export/backup.js";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { openLibrary, type Library } from "./library.js";
import type { LocationEnv } from "./location.js";
import { deleteOldCopy, executeMove } from "./move.js";
import { addPendingOldCopy, markPendingComplete } from "./old-copies.js";
import { projectWarnings, type Repo } from "./repo/index.js";
import { openTestRepo } from "./repo/testing.js";
import { DESTRUCTION_NOTICE, destroyRaw, oldCopiesAwaitingDeletion, readDestruction, resumeDestruction } from "./retention.js";

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

function deps(): Deps {
  return {
    clock: () => kit.clock.now,
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: kit.lib.appConfigDir,
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

async function openAt(root: string): Promise<Repo> {
  const lib = await openLibrary(root, deps());
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
    expect(DESTRUCTION_OLD_COPIES_PENDING_TEXT).toBe(
      "Old copies of this library, left by a move, still hold data that was destroyed here. Delete them from the Move library screen (or by hand) to complete the destruction.",
    );
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
    expect(r.original).not.toHaveProperty("oldCopies");
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
    expect(r.original).not.toHaveProperty("oldCopies");
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
    expect(Object.keys(r.original)).toEqual(["formatVersion", "kind", "projectId", "at", "actor", "rule", "method", "includeDerived", "assets", "trashedCopies", "backups", "notice"]);
    const ev = (await events(kit.repo, kit.lib.root, p)).find((e) => e.details?.op === "retention.destroy")!;
    expect(Object.keys(ev.details!).filter((k) => k.startsWith("oldCopies"))).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
    expect(await oldCopiesAwaitingDeletion(kit.repo, p.id)).toEqual([]);
  });
});
