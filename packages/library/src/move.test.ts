import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Provenance, SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { IndexHandle } from "./index/db.js";
import { createLibrary, openLibrary, type Library } from "./library.js";
import { classifyLocation, defaultLocationEnv, parseMacMount, parseProcMounts, parseWindowsDrives, type LocationEnv } from "./location.js";
import {
  InvalidConfirmTokenError,
  MoveNotAllowedError,
  MoveVerificationError,
  SimulatedMoveCrash,
  acceptMovePlan,
  completeMove,
  deleteOldCopy,
  executeMove,
  finishMoveAt,
  listPendingOldCopies,
  oldCopyMarkedFor,
  listUnfinishedMoves,
  moveSeams,
  planMove,
} from "./move.js";
import { acquireLock, releaseLock } from "./lock.js";
import { OldCopiesUnreadableError, addPendingOldCopy, markPendingComplete } from "./old-copies.js";
import { listLibraries } from "./registry.js";
import { projectWarnings, type Repo } from "./repo/index.js";
import { SimulatedCrash, openTestRepo, seams } from "./repo/testing.js";

const FAST = 2 ** 10;
const NOW = "2026-11-09T14:30:00.000Z";

/** Non-identifying, unencrypted, may live in a cloud-synced folder. */
const CLOUD_OK_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
residency:
  allowed: [device, removable, cloud_folder]
`;
const HIPAA_GOV = `profiles: [hipaa]
`;
/** Encryption at rest required: an unencrypted project is refused (recorded in the library's own audit log). */
const NEEDS_ENCRYPTION = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
`;

let tmp: string;
let now: Date;
let ring: KeyRing;
let pdf: string;
let env: LocationEnv;
let open: Library[];

function mkDeps(): Deps {
  return {
    clock: () => now,
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

function draft(title: string): SourceDraft {
  return {
    projectIds: [],
    type: "article-journal",
    title: { variants: [{ lang: "en", kind: "original", value: title }] },
    creators: [{ family: "Smith", given: "Jane", role: "author" }],
    issued: "2025",
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
  };
}
function provenance(): Provenance {
  return {
    captureMethod: "manual_upload",
    capturedAt: NOW,
    tool: { name: "ao", version: "0.0.0" },
    fileHashes: {},
    legal: { status: "public" },
    identifiable: false,
  };
}

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}
const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");
async function hashes(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await walkFiles(root)) if (!skip(rel)) out[rel] = await sha(join(root, rel));
  return out;
}
const notLock = (rel: string) => rel === ".lock";

async function auditOf(root: string, folder: string): Promise<AuditEvent[]> {
  const dir = join(root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

interface Fixture {
  lib: Library;
  repo: Repo;
  a: { id: string; folder: string };
  b: { id: string; folder: string };
}

/** A library with two projects (A: cloud-ok with 3 sources, B: `govB`), plus an Exports file kept 0600. */
async function fixture(govB = CLOUD_OK_GOV, encryptB = false): Promise<Fixture> {
  const lib = await createLibrary(join(tmp, "Src"), "Lib", mkDeps());
  open.push(lib);
  const repo = await openTestRepo(lib, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST });
  const pa = (await repo.createProject({ name: "A", governanceYaml: CLOUD_OK_GOV, encryption: { enabled: false } })).project;
  const pb = (
    await repo.createProject({
      name: "B",
      governanceYaml: govB,
      encryption: encryptB ? { enabled: true, passphrase: "correct horse battery" } : { enabled: false },
    })
  ).project;
  for (const t of ["One", "Two", "Three"]) {
    await repo.createSource(pa.id, draft(t), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  }
  if (!encryptB) await repo.createSource(pb.id, draft("Bee"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  await writeFile(join(lib.root, "Exports", "private.txt"), "owner only", { mode: 0o600 });
  await chmod(join(lib.root, "Exports", "private.txt"), 0o600);
  return { lib, repo, a: { id: pa.id, folder: pa.folder }, b: { id: pb.id, folder: pb.folder } };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-move-"));
  now = new Date(NOW);
  ring = new KeyRing();
  open = [];
  env = { homeDir: join(tmp, "home"), platform: "linux", mounts: [{ path: "/", removable: false, network: false }] };
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello research\n%%EOF\n");
});
afterEach(async () => {
  seams.failUndo = undefined;
  seams.failAuditAppendFor = undefined;
  seams.crashAt = undefined;
  moveSeams.crashAfter = undefined;
  moveSeams.unreadableDir = undefined;
  moveSeams.fail = undefined;
  for (const l of open) await l.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("classifyLocation", () => {
  const mac = (home = "/Users/ana"): LocationEnv => ({ homeDir: home, platform: "darwin", mounts: [] });
  const win = (mounts: LocationEnv["mounts"] = []): LocationEnv => ({ homeDir: "C:\\Users\\ana", platform: "win32", mounts });

  it("recognises iCloud Drive on macOS", () => {
    expect(classifyLocation("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Research", mac())).toEqual({
      kind: "cloud_folder",
      cloudFolderId: "icloud",
      certain: true,
    });
  });
  it("recognises OneDrive, Dropbox and Google Drive under ~/Library/CloudStorage", () => {
    expect(classifyLocation("/Users/ana/Library/CloudStorage/OneDrive-Contoso/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso", certain: true });
    expect(classifyLocation("/Users/ana/Library/CloudStorage/Dropbox-Personal/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox", certain: true });
    expect(classifyLocation("/Users/ana/Library/CloudStorage/GoogleDrive-ana@uni.edu/My Drive/Lib", mac())).toEqual({
      kind: "cloud_folder",
      cloudFolderId: "googledrive:ana@uni.edu",
      certain: true,
    });
  });
  it("recognises ~/Dropbox on any platform", () => {
    expect(classifyLocation("/Users/ana/Dropbox/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox", certain: true });
    expect(classifyLocation("/home/ana/Dropbox", { homeDir: "/home/ana", platform: "linux", mounts: [] })).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox", certain: true });
    expect(classifyLocation("C:\\Users\\ana\\Dropbox\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox", certain: true });
  });
  it("recognises Windows OneDrive folders (case-insensitively) and Google Drive's G:\\My Drive", () => {
    expect(classifyLocation("C:\\Users\\ana\\OneDrive - Contoso\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso", certain: true });
    expect(classifyLocation("c:\\users\\ANA\\OneDrive\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Personal", certain: true });
    expect(classifyLocation("G:\\My Drive\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "googledrive", certain: true });
  });
  it("does not mistake a sibling folder for a cloud folder", () => {
    expect(classifyLocation("/Users/ana/DropboxOld/Lib", mac())).toMatchObject({ kind: "device" });
    expect(classifyLocation("/Users/bob/Dropbox/Lib", mac())).toMatchObject({ kind: "device" });
  });
  it("uses the longest matching mount: removable, network, else device", () => {
    const linux: LocationEnv = {
      homeDir: "/home/ana",
      platform: "linux",
      mounts: [
        { path: "/", removable: false, network: false },
        { path: "/media/ana/USB", removable: true, network: false },
        { path: "/mnt/nas", removable: false, network: true },
      ],
    };
    expect(classifyLocation("/media/ana/USB/Lib", linux)).toEqual({ kind: "removable", certain: true });
    expect(classifyLocation("/mnt/nas/share/Lib", linux)).toEqual({ kind: "network", certain: true });
    expect(classifyLocation("/home/ana/Lib", linux)).toEqual({ kind: "device", certain: true });
  });
  it("matches Windows drive letters from the mount list", () => {
    const w = win([
      { path: "E:\\", removable: true, network: false },
      { path: "Z:\\", removable: false, network: true },
    ]);
    expect(classifyLocation("e:\\Lib", w)).toEqual({ kind: "removable", certain: true });
    expect(classifyLocation("Z:\\lab\\Lib", w)).toEqual({ kind: "network", certain: true });
    // C: is not in this mount list: a guess.
    expect(classifyLocation("C:\\Research\\Lib", w)).toEqual({ kind: "device", certain: false });
  });
  it("treats any ~/Library/CloudStorage folder as a cloud folder", () => {
    expect(classifyLocation("/Users/ana/Library/CloudStorage/Box-Box/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "box-box", certain: true });
  });
  it("treats Windows UNC paths as network shares", () => {
    expect(classifyLocation("\\\\nas\\lab\\Lib", win())).toEqual({ kind: "network", certain: true });
  });
  it("recognises OneDrive folders named by environment variables", () => {
    const w: LocationEnv = { ...win(), vars: { OneDriveCommercial: "D:\\Sync\\OneDrive - Uni", OneDriveConsumer: "D:\\Home Sync" } };
    expect(classifyLocation("D:\\Sync\\OneDrive - Uni\\Lib", w)).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Uni", certain: true });
    expect(classifyLocation("d:\\home sync\\Lib", w)).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Personal", certain: true });
  });
  it("treats Linux /media, /run/media and /mnt/* as removable", () => {
    const linux: LocationEnv = { homeDir: "/home/ana", platform: "linux", mounts: [{ path: "/", removable: false, network: false }] };
    expect(classifyLocation("/media/ana/Stick/Lib", linux)).toEqual({ kind: "removable", certain: true });
    expect(classifyLocation("/run/media/ana/Stick/Lib", linux)).toEqual({ kind: "removable", certain: true });
    expect(classifyLocation("/mnt/disk/Lib", linux)).toEqual({ kind: "removable", certain: true });
  });
  it("is uncertain when the mount list is unknown or does not cover the path", () => {
    expect(classifyLocation("/home/ana/Lib", { homeDir: "/home/ana", platform: "linux", mounts: [] })).toEqual({ kind: "device", certain: false });
    expect(
      classifyLocation("/home/ana/Lib", { homeDir: "/home/ana", platform: "linux", mounts: [{ path: "/", removable: false, network: false }], mountsKnown: false }),
    ).toEqual({ kind: "device", certain: false });
  });
});

describe("mount list parsing (defaultLocationEnv)", () => {
  it("parses /proc/mounts", () => {
    const text = [
      "/dev/nvme0n1p2 / ext4 rw 0 0",
      "//nas/share /mnt/nas cifs rw 0 0",
      "server:/export /mnt/nfs nfs4 rw 0 0",
      "/dev/sdb1 /media/ana/My\\040USB vfat rw 0 0",
      "proc /proc proc rw 0 0",
    ].join("\n");
    expect(parseProcMounts(text, (dev) => dev === "/dev/sdb1")).toEqual([
      { path: "/", removable: false, network: false },
      { path: "/mnt/nas", removable: false, network: true },
      { path: "/mnt/nfs", removable: false, network: true },
      { path: "/media/ana/My USB", removable: true, network: false },
    ]);
  });
  it("parses macOS mount output", () => {
    const text = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "/dev/disk4s1 on /Volumes/USB STICK (msdos, local, nodev, nosuid, noowners)",
      "//ana@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by ana)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    ].join("\n");
    expect(parseMacMount(text)).toEqual([
      { path: "/", removable: false, network: false },
      { path: "/Volumes/USB STICK", removable: true, network: false },
      { path: "/Volumes/share", removable: false, network: true },
      { path: "/System/Volumes/Data", removable: false, network: false },
    ]);
  });
  it("parses Windows drive types (2 removable, 4 network)", () => {
    expect(parseWindowsDrives("DeviceID  DriveType\r\nC:        3\r\nE:        2\r\nZ:        4\r\n")).toEqual([
      { path: "C:\\", removable: false, network: false },
      { path: "E:\\", removable: true, network: false },
      { path: "Z:\\", removable: false, network: true },
    ]);
  });
  it("defaultLocationEnv never throws and reports this machine", async () => {
    const e = await defaultLocationEnv();
    expect(e.platform).toBe(process.platform);
    expect(typeof e.homeDir).toBe("string");
    expect(Array.isArray(e.mounts)).toBe(true);
  });
});

describe("planMove", () => {
  it("reports each project's decision and the size of the move", async () => {
    const { lib, a, b } = await fixture(HIPAA_GOV, true);
    const dest = join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
    const plan = await planMove(lib, dest, { ...env, platform: "darwin" });
    expect(plan.destination).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso", certain: true });
    const byId = Object.fromEntries(plan.perProject.map((p) => [p.projectId, p]));
    expect(byId[a.id]!.decision.result).toBe("allow");
    expect(byId[b.id]!.decision.result).toBe("deny");
    expect(byId[b.id]!.name).toBe("B");
    const files = (await walkFiles(lib.root)).filter((r) => r !== ".lock" && !r.startsWith(".tmp/"));
    expect(plan.fileCount).toBe(files.length);
    let bytes = 0;
    for (const r of files) bytes += (await stat(join(lib.root, r))).size;
    expect(plan.totalBytes).toBe(bytes);
  });

  it("refuses a read-only library", async () => {
    const { lib } = await fixture();
    const ro = await openLibrary(lib.root, mkDeps());
    expect(ro.mode).toBe("read-only");
    await expect(planMove(ro, join(tmp, "Dest"), env)).rejects.toMatchObject({ name: "MoveNotAllowedError", code: "read-only" });
  });

  it("refuses while a write-ahead marker is pending", async () => {
    const { lib } = await fixture();
    await writeFile(join(lib.root, ".tmp", "txn-01JX0000000000000000000000.json"), "{}");
    const err = await planMove(lib, join(tmp, "Dest"), env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveNotAllowedError);
    expect((err as MoveNotAllowedError).code).toBe("pending-writes");
    expect((err as Error).message).toMatch(/finish or resolve pending writes first/);
  });

  it("refuses while a project is recoveryPending in the open repo", async () => {
    const { lib, repo, a } = await fixture();
    const dir = join(lib.root, a.folder);
    const month = (await readdir(join(dir, "changes")))[0]!;
    await rm(join(dir, "changes", month));
    await mkdir(join(dir, "changes", month));
    seams.failUndo = "dir"; // the new source folder's undo step (its files have none of their own)
    await expect(repo.createSource(a.id, draft("X"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() })).rejects.toThrow();
    seams.failUndo = undefined;
    // Remove the marker so only the in-memory recoveryPending flag remains.
    for (const n of await readdir(join(lib.root, ".tmp"))) await rm(join(lib.root, ".tmp", n), { recursive: true });
    await expect(planMove(lib, join(tmp, "Dest"), env)).resolves.toBeDefined();
    await expect(planMove(lib, join(tmp, "Dest"), env, { sourceRepo: repo })).rejects.toMatchObject({ code: "pending-writes" });
  });

  it("refuses a destination inside the source, or a source inside the destination", async () => {
    const { lib } = await fixture();
    await expect(planMove(lib, join(lib.root, "Exports", "Moved"), env)).rejects.toMatchObject({ code: "overlap" });
    await expect(planMove(lib, lib.root, env)).rejects.toMatchObject({ code: "overlap" });
    await expect(planMove(lib, tmp, env)).rejects.toMatchObject({ code: "overlap" });
  });

  it("refuses a non-empty destination unless it holds this library's move journal", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await mkdir(dest);
    await writeFile(join(dest, "notes.txt"), "mine");
    await expect(planMove(lib, dest, env)).rejects.toMatchObject({ code: "destination-not-empty" });
    await rm(join(dest, "notes.txt"));
    await writeFile(join(dest, ".move-journal.json"), JSON.stringify({ libraryId: "someone-else", fromHint: "x", startedAt: NOW, filesDone: [] }));
    await expect(planMove(lib, dest, env)).rejects.toMatchObject({ code: "destination-not-empty" });
    await writeFile(join(dest, ".move-journal.json"), JSON.stringify({ libraryId: lib.id, fromHint: "x", startedAt: NOW, filesDone: [] }));
    await expect(planMove(lib, dest, env)).resolves.toBeDefined();
  });

  it("FR-047: a destination holding only the Finder's .DS_Store / .localized counts as empty; a link of that name does not", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await mkdir(dest);
    await writeFile(join(dest, ".DS_Store"), "finder");
    await writeFile(join(dest, ".localized"), "");
    await expect(planMove(lib, dest, env)).resolves.toBeDefined();
    await rm(join(dest, ".DS_Store"));
    await symlink(join(dest, ".localized"), join(dest, ".DS_Store"));
    await expect(planMove(lib, dest, env)).rejects.toMatchObject({ code: "destination-not-empty" });
    await rm(join(dest, ".DS_Store"));
    await writeFile(join(dest, ".DS_Store"), "finder");
    await writeFile(join(dest, ".hidden"), "mine");
    await expect(planMove(lib, dest, env)).rejects.toMatchObject({ code: "destination-not-empty" });
  });

  it("aborts on a symbolic link inside the library, naming it", async () => {
    const { lib, a } = await fixture();
    await symlink(pdf, join(lib.root, a.folder, "link.pdf"));
    const err = await planMove(lib, join(tmp, "Dest"), env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveVerificationError);
    expect((err as MoveVerificationError).paths).toEqual([`${a.folder}/link.pdf`]);
    const err2 = await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(MoveVerificationError);
  });
});

describe("executeMove", () => {
  it("FR-047: moves into a folder that holds only the Finder's .DS_Store, and leaves that file", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Finder", "Lib");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, ".DS_Store"), "finder");
    const res = await executeMove(lib, dest, { deps: mkDeps(), env });
    expect(res.verified).toBe(true);
    expect(await readFile(join(dest, ".DS_Store"), "utf8")).toBe("finder");
    const moved = await openLibrary(dest, mkDeps());
    expect(moved.mode).toBe("read-write");
    await moved.close();
  });

  it("copies, verifies and switches a library with two projects", async () => {
    const { lib, a, b } = await fixture();
    const before = await hashes(lib.root, notLock);
    const dest = join(tmp, "Moved", "Lib");
    const phases: string[] = [];
    const res = await executeMove(lib, dest, {
      deps: mkDeps(),
      env,
      onProgress: (p) => {
        if (phases.at(-1) !== p.phase) phases.push(p.phase);
      },
    });
    expect(res.verified).toBe(true);
    expect(res.newRoot).toBe(dest);
    expect(typeof res.confirmToken).toBe("string");
    expect(phases).toEqual(["plan", "copy", "verify", "switch"]);

    // Every copied file matches the source (library.json and the audit logs changed only by the switch).
    const after = await hashes(dest);
    for (const [rel, h] of Object.entries(before)) {
      if (rel === "library.json" || rel.includes("/audit/") || rel.startsWith(".tmp/")) continue;
      expect(after[rel], rel).toBe(h);
    }
    expect(Object.keys(after).filter((r) => !(r in before))).toEqual([]);
    expect(after[".move-journal.json"]).toBeUndefined();
    // Old copy untouched except for its MOVED.json marker; lock released; it now opens read-only.
    expect(await hashes(lib.root, (r) => r === "MOVED.json")).toEqual(before);
    const marker = JSON.parse(await readFile(join(lib.root, "MOVED.json"), "utf8"));
    // FR-068 (R607 a): the mark carries the move's id (the one the move's audit event records).
    expect(marker).toEqual({ libraryId: lib.id, movedAt: NOW, toHint: "host-A:Lib", moveId: (await auditOf(dest, a.folder)).at(-1)!.details!.moveId });
    expect(marker.moveId).toEqual(expect.any(String));
    await expect(stat(join(lib.root, ".lock"))).rejects.toThrow();
    const old = await openLibrary(lib.root, mkDeps());
    expect([old.mode, old.readOnlyReason]).toEqual(["read-only", "moved"]);
    // Modes preserved.
    expect((await stat(join(dest, "Exports", "private.txt"))).mode & 0o777).toBe(0o600);
    // Same library id, new location hint, registry points at the new root.
    const meta = JSON.parse(await readFile(join(dest, "library.json"), "utf8"));
    expect(meta.libraryId).toBe(lib.id);
    expect(meta.locationHistory.at(-1).hint).toBe("host-A:Lib");
    const reg = await listLibraries(mkDeps());
    expect(reg.find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
    // Audit: library.move in every moved project, through the destination, no absolute paths.
    for (const p of [a, b]) {
      const ev = (await auditOf(dest, p.folder)).at(-1)!;
      expect(ev.action).toBe("library.move");
      expect(ev.details).toMatchObject({
        fromHint: "host-A:Src",
        toHint: "host-A:Lib",
        destinationKind: "device",
        projectsMoved: [a.id, b.id].sort(),
        projectsExcluded: [],
        verified: true,
      });
      expect(JSON.stringify(ev)).not.toContain(tmp);
    }
    // The moved library opens read-write with a verified audit chain.
    const moved = await openLibrary(dest, mkDeps());
    open.push(moved);
    const r = await openTestRepo(moved, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect(r.integrityWarnings).toEqual([]);
  });

  it("checkpoints the index when its handle is passed and never copies -wal/-shm", async () => {
    const { lib } = await fixture();
    const index = new IndexHandle(lib.root);
    index.db.exec("CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES (1)");
    expect((await readdir(lib.root)).some((n) => n.endsWith("-wal"))).toBe(true);
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, { deps: mkDeps(), env, index });
    index.close();
    const names = await readdir(dest);
    expect(names).toContain("library.sqlite");
    expect(names.filter((n) => n.endsWith("-wal") || n.endsWith("-shm"))).toEqual([]);
  });

  it("throws MoveVerificationError on a corrupted destination file and changes nothing", async () => {
    const { lib, a } = await fixture();
    const regBefore = await listLibraries(mkDeps());
    const before = await hashes(lib.root, notLock);
    const dest = join(tmp, "Dest");
    const victim = `${a.folder}/project.json`;
    let corrupted = false;
    const err = await executeMove(lib, dest, {
      deps: mkDeps(),
      env,
      onProgress: async (p) => {
        if (p.phase === "verify" && !corrupted) {
          corrupted = true;
          await writeFile(join(dest, victim), "tampered");
        }
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveVerificationError);
    expect((err as MoveVerificationError).paths).toEqual([victim]);
    expect(await listLibraries(mkDeps())).toEqual(regBefore);
    expect(await hashes(lib.root, notLock)).toEqual(before);
    expect(lib.mode).toBe("read-write");
    // Destination kept for inspection, with its journal.
    expect(await readdir(dest)).toContain(".move-journal.json");
  });

  it("resumes an interrupted move and copies only the remaining files", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    let doneAtStop = 0;
    const err = await executeMove(lib, dest, {
      deps: mkDeps(),
      env,
      onProgress: (p) => {
        if (p.phase === "copy" && p.filesDone >= p.fileCount / 2) {
          doneAtStop = p.filesDone;
          throw new Error("interrupted");
        }
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("interrupted");
    const journal = JSON.parse(await readFile(join(dest, ".move-journal.json"), "utf8"));
    expect(journal.libraryId).toBe(lib.id);
    expect(journal.filesDone).toHaveLength(doneAtStop);
    expect(JSON.stringify(journal)).not.toContain(tmp);

    let fileCount = 0;
    const res = await executeMove(lib, dest, { deps: mkDeps(), env, onProgress: (p) => void (fileCount = p.fileCount) });
    expect(res.verified).toBe(true);
    expect(res.filesCopied).toBe(fileCount - doneAtStop);
    expect(doneAtStop).toBeGreaterThan(0);
  });

  it("fails verification when a file appears in the source during the copy", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    let added = false;
    const err = await executeMove(lib, dest, {
      deps: mkDeps(),
      env,
      onProgress: async (p) => {
        if (p.phase === "copy" && !added) {
          added = true;
          await writeFile(join(lib.root, "Exports", "late.txt"), "written during the copy");
        }
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveVerificationError);
    expect((err as MoveVerificationError).paths).toEqual(["Exports/late.txt"]);
    expect(JSON.parse(await readFile(join(lib.root, "library.json"), "utf8")).libraryId).toBe(lib.id);
  });

  it("recopies a journaled file whose destination copy is corrupt", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, {
      deps: mkDeps(),
      env,
      onProgress: (p) => {
        if (p.phase === "copy" && p.filesDone === 3) throw new Error("stop");
      },
    }).catch(() => {});
    const journal = JSON.parse(await readFile(join(dest, ".move-journal.json"), "utf8")) as { filesDone: string[] };
    const victim = journal.filesDone[1]!;
    const full = await readFile(join(dest, victim));
    await writeFile(join(dest, victim), full.subarray(0, Math.floor(full.length / 2)));
    await writeFile(join(dest, `${victim}.tmp-0123abcd`), "stray temp from a crash");
    let fileCount = 0;
    const res = await executeMove(lib, dest, { deps: mkDeps(), env, onProgress: (p) => void (fileCount = p.fileCount) });
    expect(res.filesCopied).toBe(fileCount - 2);
    expect(await sha(join(dest, victim))).toBe(await sha(join(lib.root, victim)));
    expect(await walkFiles(dest)).not.toContain(`${victim}.tmp-0123abcd`);
  });

  it("denies a HIPAA project into OneDrive; excluding it splits the library", async () => {
    const { lib, a, b } = await fixture(HIPAA_GOV, true);
    const macEnv: LocationEnv = { ...env, platform: "darwin" };
    const dest = join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
    await expect(executeMove(lib, dest, { deps: mkDeps(), env: macEnv })).rejects.toMatchObject({ code: "policy-denied" });
    await expect(stat(dest)).rejects.toThrow();

    const res = await executeMove(lib, dest, { deps: mkDeps(), env: macEnv, excludeProjectIds: [b.id] });
    expect(res.verified).toBe(true);
    const destFiles = await walkFiles(dest);
    expect(destFiles.some((r) => r.startsWith(`${b.folder}/`))).toBe(false);
    expect(destFiles.some((r) => r.startsWith(`${a.folder}/`))).toBe(true);
    // Library-level derived data may hold the excluded project's data: not copied.
    expect(destFiles).not.toContain("library.sqlite");
    expect(destFiles.some((r) => r.startsWith("Exports/"))).toBe(false);
    // The destination is the original library; the old folder is a new one.
    const destMeta = JSON.parse(await readFile(join(dest, "library.json"), "utf8"));
    expect(destMeta.libraryId).toBe(lib.id);
    const oldMeta = JSON.parse(await readFile(join(lib.root, "library.json"), "utf8"));
    expect(oldMeta.libraryId).not.toBe(lib.id);
    expect(oldMeta.name).toBe("Lib (remaining projects)");
    expect(await walkFiles(join(lib.root, b.folder))).not.toEqual([]);
    const reg = await listLibraries(mkDeps());
    expect(reg.find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
    expect(reg.find((e) => e.libraryId === oldMeta.libraryId)).toMatchObject({ name: "Lib (remaining projects)", lastKnownPaths: [lib.root] });
    const ev = (await auditOf(dest, a.folder)).at(-1)!;
    expect(ev.details).toMatchObject({ destinationKind: "cloud_folder", projectsMoved: [a.id], projectsExcluded: [b.id] });
  });
});

/**
 * R503 l (FR-733): the move's own plan, accepted (or refused) by its caller BEFORE the caller stops work that still
 * writes in the library (a running transcription): the same code as executeMove's first steps, writing nothing at the
 * destination; executeMove then takes its plan again.
 */
describe("acceptMovePlan (R503 l, FR-733)", () => {
  it("refuses as executeMove refuses at its plan, and writes nothing at the destination", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await mkdir(dest);
    await writeFile(join(dest, "notes.txt"), "mine");
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env })).rejects.toMatchObject({ name: "MoveNotAllowedError", code: "destination-not-empty" });
    await expect(acceptMovePlan(lib, lib.root, { deps: mkDeps(), env })).rejects.toMatchObject({ code: "overlap" });
    await expect(acceptMovePlan(lib, join(tmp, "Fresh"), { deps: mkDeps(), env, excludeProjectIds: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"] })).rejects.toMatchObject({ code: "unknown-project" });
    expect(await walkFiles(dest)).toEqual(["notes.txt"]);
    await expect(stat(join(tmp, "Fresh"))).rejects.toThrow();
  });

  it("a project whose rules deny the destination: refused and audited in that project once, exactly as executeMove refuses it", async () => {
    const { lib, repo, b } = await fixture(HIPAA_GOV, true);
    const macEnv: LocationEnv = { ...env, platform: "darwin" };
    const dest = join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
    const before = (await auditOf(lib.root, b.folder)).length;
    const err = await acceptMovePlan(lib, dest, { deps: mkDeps(), env: macEnv, sourceRepo: repo }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "MoveNotAllowedError", code: "policy-denied" });
    const added = (await auditOf(lib.root, b.folder)).slice(before);
    expect(added.map((e) => e.action)).toEqual(["move"]);
    expect(added[0]!.decision?.result).toBe("deny");
    // executeMove's own refusal of the same move: the same error, audited the same way.
    const err2 = await executeMove(lib, dest, { deps: mkDeps(), env: macEnv, sourceRepo: repo }).catch((e: unknown) => e);
    expect((err2 as Error).message).toBe((err as Error).message);
    const added2 = (await auditOf(lib.root, b.folder)).slice(before + 1);
    expect(added2.map((e) => [e.action, e.decision?.result])).toEqual([["move", "deny"]]);
    await expect(stat(dest)).rejects.toThrow();
  });

  it("accepts a plan executeMove goes on with, and writes nothing: no destination folder, no journal, no audit entry", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    const auditA = (await auditOf(lib.root, a.folder)).length;
    const auditB = (await auditOf(lib.root, b.folder)).length;
    const src = await hashes(lib.root, notLock);
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env })).resolves.toBeUndefined();
    await expect(stat(dest)).rejects.toThrow();
    expect(await hashes(lib.root, notLock)).toEqual(src);
    expect((await auditOf(lib.root, a.folder)).length).toBe(auditA);
    expect((await auditOf(lib.root, b.folder)).length).toBe(auditB);
  });

  it("does not refuse what it cannot judge while work still writes: an in-progress change's marker is left to executeMove (taken after the stop)", async () => {
    const { lib } = await fixture();
    await writeFile(join(lib.root, ".tmp", "txn-01JX0000000000000000000000.json"), "{}");
    await expect(acceptMovePlan(lib, join(tmp, "Dest"), { deps: mkDeps(), env })).resolves.toBeUndefined();
    // executeMove still refuses it, as before.
    await expect(executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env })).rejects.toMatchObject({ code: "pending-writes" });
  });

  // R513 M2: the old order of refusals — interrupted changes ("pending writes", nothing audited) before any project's rules.
  it("R513 M2 (the reviewer's probe): an interrupted change's marker AND a project whose rules forbid the place: nothing judged and nothing audited here; executeMove answers 'pending writes', unaudited, as before", async () => {
    const { lib, repo, a, b } = await fixture(HIPAA_GOV, true);
    const macEnv: LocationEnv = { ...env, platform: "darwin" };
    const dest = join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
    await writeFile(join(lib.root, ".tmp", "txn-01JX0000000000000000000000.json"), "{}");
    const before = [(await auditOf(lib.root, a.folder)).length, (await auditOf(lib.root, b.folder)).length];
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env: macEnv, sourceRepo: repo })).resolves.toBeUndefined();
    expect([(await auditOf(lib.root, a.folder)).length, (await auditOf(lib.root, b.folder)).length]).toEqual(before);
    await expect(executeMove(lib, dest, { deps: mkDeps(), env: macEnv, sourceRepo: repo })).rejects.toMatchObject({ code: "pending-writes" });
    expect([(await auditOf(lib.root, a.folder)).length, (await auditOf(lib.root, b.folder)).length]).toEqual(before);
  });

  it("R513 M2: a project left refusing changes by an interrupted change (in the open repo) AND a project whose rules forbid the place: 'pending writes' at once, nothing audited", async () => {
    const { lib, repo, a, b } = await fixture(HIPAA_GOV, true);
    const dir = join(lib.root, a.folder);
    const month = (await readdir(join(dir, "changes")))[0]!;
    await rm(join(dir, "changes", month));
    await mkdir(join(dir, "changes", month));
    seams.failUndo = "dir";
    await expect(repo.createSource(a.id, draft("X"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() })).rejects.toThrow();
    seams.failUndo = undefined;
    for (const n of await readdir(join(lib.root, ".tmp"))) await rm(join(lib.root, ".tmp", n), { recursive: true });
    const macEnv: LocationEnv = { ...env, platform: "darwin" };
    const dest = join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
    const before = (await auditOf(lib.root, b.folder)).length;
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env: macEnv, sourceRepo: repo })).rejects.toMatchObject({ name: "MoveNotAllowedError", code: "pending-writes" });
    expect((await auditOf(lib.root, b.folder)).length).toBe(before);
  });

  it("a switch already decided (a crash during it) is accepted without a plan, as executeMove finishes it", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "register";
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    moveSeams.crashAfter = undefined;
    // planMove would call the destination not empty; the move itself finishes the switch.
    await expect(planMove(lib, dest, env)).rejects.toMatchObject({ code: "destination-not-empty" });
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env })).resolves.toBeUndefined();
  });
});

describe("deleteOldCopy", () => {
  async function moved() {
    const f = await fixture();
    const dest = join(tmp, "Dest");
    const res = await executeMove(f.lib, dest, { deps: mkDeps(), env });
    return { ...f, dest, res };
  }

  it("deletes the old copy once, records it in the destination, and refuses the token again", async () => {
    const { lib, a, dest, res } = await moved();
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(out.kept).toEqual([]);
    expect(out.rootRemoved).toBe(true);
    await expect(stat(lib.root)).rejects.toThrow();
    const ev = (await auditOf(dest, a.folder)).at(-1)!;
    expect(ev.action).toBe("library.old-copy-deleted");
    expect(JSON.stringify(ev)).not.toContain(tmp);
    await expect(deleteOldCopy(lib.root, res.confirmToken)).rejects.toBeInstanceOf(InvalidConfirmTokenError);
  });

  it("refuses an unknown token, a different root, and an expired token", async () => {
    const { lib, res } = await moved();
    await expect(deleteOldCopy(lib.root, "nope")).rejects.toBeInstanceOf(InvalidConfirmTokenError);
    await expect(deleteOldCopy(join(tmp, "Other"), res.confirmToken)).rejects.toBeInstanceOf(InvalidConfirmTokenError);
    now = new Date(now.getTime() + 24 * 3600_000 + 1);
    await expect(deleteOldCopy(lib.root, res.confirmToken)).rejects.toMatchObject({ reason: "expired" });
    expect((await walkFiles(lib.root)).length).toBeGreaterThan(0);
  });

  it("refuses while the old copy is open on another device, without using up the token", async () => {
    const { lib, res } = await moved();
    const depsB = { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: process.pid + 1 };
    // The old copy only opens read-only now; a device holding its lock (e.g. an older app) still blocks deletion.
    expect((await acquireLock(lib.root, depsB)).acquired).toBe(true);
    await expect(deleteOldCopy(lib.root, res.confirmToken)).rejects.toMatchObject({ code: "old-copy-in-use" });
    await releaseLock(lib.root, depsB);
    await expect(deleteOldCopy(lib.root, res.confirmToken)).resolves.toMatchObject({ kept: [], rootRemoved: true });
  });

  it("never deletes outside the old root and keeps files changed since the move", async () => {
    const { lib, a, res } = await moved();
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "keep me");
    const files = await walkFiles(join(lib.root, a.folder, "Sources"));
    const linked = `${a.folder}/Sources/${files[0]!}`;
    await rm(join(lib.root, linked));
    await symlink(outside, join(lib.root, linked));
    const changed = `${a.folder}/project.json`;
    await writeFile(join(lib.root, changed), "edited after the move");
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(await readFile(outside, "utf8")).toBe("keep me");
    expect(out.kept.sort()).toEqual([changed, linked].sort());
    expect(out.rootRemoved).toBe(false);
    expect(await readFile(join(lib.root, changed), "utf8")).toBe("edited after the move");
    // Kept files keep the old copy's identity: it still opens, read-only.
    expect((await walkFiles(lib.root)).sort()).toEqual(["MOVED.json", changed, "library.json", linked].sort());
    expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
  });

  it("split library: deletes only moved projects, keeps the remaining library usable", async () => {
    const f = await fixture(HIPAA_GOV, true);
    const dest = join(tmp, "Dest");
    const res = await executeMove(f.lib, dest, { deps: mkDeps(), env, excludeProjectIds: [f.b.id] });
    const keepB = await hashes(join(f.lib.root, f.b.folder));
    const out = await deleteOldCopy(f.lib.root, res.confirmToken);
    expect(out.rootRemoved).toBe(false);
    expect(await walkFiles(join(f.lib.root, f.a.folder))).toEqual([]);
    expect(await hashes(join(f.lib.root, f.b.folder))).toEqual(keepB);
    const rest = await openLibrary(f.lib.root, mkDeps());
    open.push(rest);
    expect(rest.mode).toBe("read-write");
    expect(rest.name).toBe("Lib (remaining projects)");
    const r = await openTestRepo(rest, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect(r.listProjects().map((p) => p.id)).toEqual([f.b.id]);
  });
});


describe("review fixes (R33)", () => {
  const DEVICE_ONLY_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
residency:
  allowed: [device]
`;

  it("C1: with the source repo passed, library.move goes to the destination and the source audit is unchanged", async () => {
    const { lib, repo, a, b } = await fixture();
    const srcAudit = await hashes(join(lib.root, a.folder, "audit"));
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, { deps: mkDeps(), env, sourceRepo: repo });
    expect(await hashes(join(lib.root, a.folder, "audit"))).toEqual(srcAudit);
    for (const p of [a, b]) expect((await auditOf(dest, p.folder)).at(-1)!.action).toBe("library.move");
    const meta = JSON.parse(await readFile(join(dest, "library.json"), "utf8"));
    expect(meta.locationHistory.at(-1).hint).toBe("host-A:Dest");
    const moved = await openLibrary(dest, mkDeps());
    open.push(moved);
    expect(moved.mode).toBe("read-write");
    const r = await openTestRepo(moved, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect(r.integrityWarnings).toEqual([]);
  });

  it("C2: a destination reached through a symbolic link is classified by its real path too", async () => {
    const { lib, b } = await fixture(HIPAA_GOV, true);
    const home = await realpath(join(tmp));
    const macEnv: LocationEnv = { homeDir: join(home, "home"), platform: "darwin", mounts: [{ path: "/", removable: false, network: false }] };
    const cloud = join(macEnv.homeDir, "Library/CloudStorage/OneDrive-Contoso");
    await mkdir(cloud, { recursive: true });
    await symlink(cloud, join(tmp, "Innocent"));
    const plan = await planMove(lib, join(tmp, "Innocent", "Lib"), macEnv);
    expect(plan.destinations.map((d) => d.kind)).toEqual(["device", "cloud_folder"]);
    expect(plan.destination).toMatchObject({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso" });
    expect(plan.perProject.find((p) => p.projectId === b.id)!.decision.result).toBe("deny");
    await expect(executeMove(lib, join(tmp, "Innocent", "Lib"), { deps: mkDeps(), env: macEnv })).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("I3: an uncertain destination is evaluated as every plausible kind", async () => {
    const { lib, a, b } = await fixture(DEVICE_ONLY_GOV);
    const unknownEnv: LocationEnv = { ...env, mounts: [], mountsKnown: false };
    const plan = await planMove(lib, join(tmp, "Dest"), unknownEnv);
    expect(plan.destination).toEqual({ kind: "device", certain: false });
    const db = plan.perProject.find((p) => p.projectId === b.id)!.decision;
    expect(db.result).toBe("deny");
    // Said as what it may be, in plain words, with no internal name (R473 M4).
    expect(db.result === "deny" && db.reason).toBe("The library's new place may be a removable drive; this project's rules do not allow its data there.");
    // A project allowing device and removable but not network is denied too.
    expect(plan.perProject.find((p) => p.projectId === a.id)!.decision.result).toBe("deny");
    const certain = await planMove(lib, join(tmp, "Dest"), env);
    expect(certain.perProject.every((p) => p.decision.result === "allow")).toBe(true);
  });

  it("I4: refuses a project folder without a readable project.json, naming it", async () => {
    const { lib } = await fixture();
    await mkdir(join(lib.root, "Projects", "Orphan", "Sources"), { recursive: true });
    await writeFile(join(lib.root, "Projects", "Orphan", "governance.yaml"), HIPAA_GOV);
    const err = await planMove(lib, join(tmp, "Dest"), env).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unreadable-project" });
    expect((err as Error).message).toContain("Projects/Orphan");
    await writeFile(join(lib.root, "Projects", "Orphan", "project.json"), "{ torn");
    await expect(planMove(lib, join(tmp, "Dest"), env)).rejects.toMatchObject({ code: "unreadable-project" });
    // A plain folder under Projects is ordinary content.
    await rm(join(lib.root, "Projects", "Orphan"), { recursive: true });
    await mkdir(join(lib.root, "Projects", "notes"));
    await expect(planMove(lib, join(tmp, "Dest"), env)).resolves.toBeDefined();
  });

  it("I7: refuses names that collide under case folding or Unicode normalization", async () => {
    const { lib } = await fixture();
    await writeFile(join(lib.root, "Exports", "Note.txt"), "a");
    await writeFile(join(lib.root, "Exports", "note.txt"), "b");
    await writeFile(join(lib.root, "Exports", "café.txt"), "c");
    await writeFile(join(lib.root, "Exports", "café.txt"), "d");
    const err = await planMove(lib, join(tmp, "Dest"), env).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "name-collision" });
    expect((err as Error).message).toContain("Exports/Note.txt ↔ Exports/note.txt");
    expect((err as Error).message).toContain("Exports/café.txt ↔ Exports/café.txt");
  });

  it("I5: split move marks moved project folders, which the remaining library no longer loads; library.split is audited", async () => {
    const { lib, a, b } = await fixture(HIPAA_GOV, true);
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, { deps: mkDeps(), env, excludeProjectIds: [b.id] });
    expect(JSON.parse(await readFile(join(lib.root, a.folder, "MOVED.json"), "utf8"))).toMatchObject({ libraryId: lib.id, toHint: "host-A:Dest" });
    const ev = (await auditOf(lib.root, b.folder)).at(-1)!;
    expect(ev.action).toBe("library.split");
    expect(ev.details).toMatchObject({ projectsMoved: [a.id], projectsRemaining: [b.id] });
    expect(JSON.stringify(ev)).not.toContain(tmp);
    const rest = await openLibrary(lib.root, mkDeps());
    open.push(rest);
    expect(rest.mode).toBe("read-write");
    const r = await openTestRepo(rest, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect(r.listProjects().map((p) => p.id)).toEqual([b.id]);
  });

  it("I5: the old copy can be deleted after a restart from the persisted record, within 24 hours", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, { deps: mkDeps(), env });
    const pending = await listPendingOldCopies(mkDeps());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ oldRoot: lib.root, newRoot: dest, libraryId: lib.id, expired: false });
    await expect(deleteOldCopy(lib.root, { confirm: true })).rejects.toBeInstanceOf(InvalidConfirmTokenError); // no deps
    now = new Date(now.getTime() + 24 * 3600_000 + 1);
    await expect(deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).rejects.toThrow(/expired/);
    expect((await listPendingOldCopies(mkDeps()))[0]!.expired).toBe(true);
    now = new Date(NOW);
    const out = await deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() });
    expect(out.rootRemoved).toBe(true);
    expect(await listPendingOldCopies(mkDeps())).toEqual([]);
    await expect(deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).rejects.toBeInstanceOf(InvalidConfirmTokenError);
  });

  async function assertFinished(lib: Library, dest: string, folders: string[]) {
    expect(await readdir(dest)).not.toContain(".move-journal.json");
    for (const f of folders) expect((await auditOf(dest, f)).filter((e) => e.action === "library.move")).toHaveLength(1);
    const reg = await listLibraries(mkDeps());
    expect(reg.find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
    const d = await openLibrary(dest, mkDeps());
    expect(d.mode).toBe("read-write");
    await d.close();
    expect(await listPendingOldCopies(mkDeps())).toHaveLength(1);
  }

  for (const step of ["register", "mark-old", "close-source", "audit-move"] as const) {
    it(`I6: a crash after "${step}" is finished by completeMove`, async () => {
      const { lib, a, b } = await fixture();
      const dest = join(tmp, "Dest");
      moveSeams.crashAfter = step;
      await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
      await lib.close(); // the process died; its lock goes with it
      const half = await openLibrary(dest, mkDeps());
      expect([half.mode, half.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
      const res = await completeMove(dest, mkDeps(), env);
      expect(res.verified).toBe(true);
      await assertFinished(lib, dest, [a.folder, b.folder]);
      const old = await openLibrary(lib.root, mkDeps());
      expect(old.readOnlyReason).toBe("moved");
    });
  }

  it("I6: rerunning executeMove after a crash in a split switch finishes it without duplicate audit events", async () => {
    const { lib, a, b } = await fixture(HIPAA_GOV, true);
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "audit-split";
    await expect(executeMove(lib, dest, { deps: mkDeps(), env, excludeProjectIds: [b.id] })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    // Simulate the interrupted step not having been recorded: drop it from the journal so it runs again.
    const jp = join(dest, ".move-journal.json");
    const j = JSON.parse(await readFile(jp, "utf8"));
    expect(j.phase).toBe("switching");
    expect(JSON.stringify(j)).not.toContain(tmp);
    j.switch.done = j.switch.done.filter((s: string) => s !== "audit-split");
    await writeFile(jp, JSON.stringify(j));
    const rest = await openLibrary(lib.root, mkDeps());
    const res = await executeMove(rest, dest, { deps: mkDeps(), env, excludeProjectIds: [b.id] });
    expect(res.verified).toBe(true);
    await assertFinished(lib, dest, [a.folder]);
    expect((await auditOf(lib.root, b.folder)).filter((e) => e.action === "library.split")).toHaveLength(1);
  });

  it("I6: completeMove refuses when no verified move is waiting", async () => {
    await mkdir(join(tmp, "Empty"));
    await expect(completeMove(join(tmp, "Empty"), mkDeps(), env)).rejects.toMatchObject({ code: "nothing-to-complete" });
  });
});

describe("review fixes round 2", () => {
  it("N1: after a crash right after the first switch step the source is not writable, and completion puts the destination first", async () => {
    for (const step of ["register", "mark-old"] as const) {
      const { lib } = await fixture();
      const dest = join(tmp, `Dest-${step}`);
      moveSeams.crashAfter = step;
      await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
      await lib.close();
      const src = await openLibrary(lib.root, mkDeps());
      expect(src.mode).toBe("read-only");
      expect(["moved", "move-incomplete"]).toContain(src.readOnlyReason);
      await completeMove(dest, mkDeps(), env);
      const reg = await listLibraries(mkDeps());
      expect(reg.find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
      expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
      await rm(lib.root, { recursive: true, force: true });
      await rm(join(tmp, "config"), { recursive: true, force: true });
    }
  });

  async function splitThenRest() {
    const f = await fixture(HIPAA_GOV, true);
    await executeMove(f.lib, join(tmp, "Dest"), { deps: mkDeps(), env, excludeProjectIds: [f.b.id] });
    const rest = await openLibrary(f.lib.root, mkDeps());
    open.push(rest);
    return { ...f, rest };
  }

  it("N2: a valid project marker is reported as moved away in the plan and the result", async () => {
    const { rest, a, b } = await splitThenRest();
    const plan = await planMove(rest, join(tmp, "Dest2"), env);
    expect(plan.projectsMovedAway).toEqual([a.folder]);
    expect(plan.perProject.map((p) => p.projectId)).toEqual([b.id]);
    const res = await executeMove(rest, join(tmp, "Dest2"), { deps: mkDeps(), env });
    expect(res.projectsMovedAway).toEqual([a.folder]);
    expect(await walkFiles(join(tmp, "Dest2", a.folder))).toEqual([]);
  });

  it("N2: a marker from another library, or one older than its project.json, does not hide the project", async () => {
    const { lib, a } = await fixture();
    const markerPath = join(lib.root, a.folder, "MOVED.json");
    await writeFile(markerPath, JSON.stringify({ libraryId: "someone-else", movedAt: NOW, toHint: "x:y" }));
    let plan = await planMove(lib, join(tmp, "Dest"), env);
    expect(plan.projectsMovedAway).toEqual([]);
    expect(plan.perProject.map((p) => p.projectId)).toContain(a.id);
    await writeFile(markerPath, JSON.stringify({ libraryId: lib.id, movedAt: NOW, toHint: "x:y" }));
    const later = new Date(Date.now() + 3600_000);
    await utimes(join(lib.root, a.folder, "project.json"), later, later);
    plan = await planMove(lib, join(tmp, "Dest"), env);
    expect(plan.projectsMovedAway).toEqual([]);
    expect(plan.perProject.map((p) => p.projectId)).toContain(a.id);
    await writeFile(markerPath, "{ torn");
    plan = await planMove(lib, join(tmp, "Dest"), env);
    expect(plan.perProject.map((p) => p.projectId)).toContain(a.id);
  });

  it("N2: deleteOldCopy keeps library.json and MOVED.json over unverified leftovers and lists them", async () => {
    const { lib } = await fixture();
    const res = await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env });
    await writeFile(join(lib.root, "Exports", "added-later.txt"), "not in the move");
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(out.leftovers).toEqual(["Exports/added-later.txt"]);
    expect(out.rootRemoved).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/left/i);
    expect((await walkFiles(lib.root)).sort()).toEqual(["Exports/added-later.txt", "MOVED.json", "library.json"]);
    expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
  });
});

describe("review fixes round 2: minors", () => {
  it("{ confirm: true } uses the most recent non-expired record for that folder", async () => {
    const { lib } = await fixture();
    const old = { ...mkDeps(), clock: () => new Date(Date.parse(NOW) - 25 * 3600_000) };
    const stale = await addPendingOldCopy(old, { oldRoot: lib.root, newRoot: join(tmp, "Gone"), libraryId: lib.id, split: false, movedFolders: [], movedProjectIds: [], moveId: "stale" }, { files: {}, dirs: [] });
    await markPendingComplete(old, stale.id);
    await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env });
    const out = await deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() });
    expect(out.rootRemoved).toBe(true);
  });

  it("keeps the verified-hash folder owner-only", async () => {
    const { lib } = await fixture();
    await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env });
    expect((await stat(join(tmp, "config", "old-copies"))).mode & 0o777).toBe(0o700);
  });

  it("records whether the destination kind was certain", async () => {
    const { lib, a } = await fixture();
    await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env });
    expect((await auditOf(join(tmp, "Dest"), a.folder)).at(-1)!.details).toMatchObject({ destinationKind: "device", destinationCertain: true });
  });

  it("treats unknown FUSE file systems as uncertain", () => {
    const mounts = parseProcMounts("/dev/sda1 / ext4 rw 0 0\nremote: /home/ana/cloud fuse.rclone rw 0 0\n/dev/sdc1 /data fuseblk rw 0 0", () => false);
    expect(mounts).toEqual([
      { path: "/", removable: false, network: false },
      { path: "/home/ana/cloud", removable: false, network: false, uncertain: true },
      { path: "/data", removable: false, network: false },
    ]);
    const e: LocationEnv = { homeDir: "/home/ana", platform: "linux", mounts };
    expect(classifyLocation("/home/ana/cloud/Lib", e)).toEqual({ kind: "device", certain: false });
    expect(classifyLocation("/data/Lib", e)).toEqual({ kind: "device", certain: true });
    expect(parseMacMount("rclone@remote on /Volumes/cloud (macfuse, nodev, nosuid, synchronous, mounted by ana)")).toEqual([
      { path: "/Volumes/cloud", removable: false, network: false, uncertain: true },
    ]);
  });
});

describe("review fixes round 3", () => {
  it("a crash between mark-old and register is recoverable from the registry and the unfinished-move list (whole library)", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "mark-old";
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await lib.close();
    const entry = (await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!;
    expect(entry.lastKnownPaths[0]).toBe(lib.root);
    expect(entry.lastKnownPaths).toContain(dest);
    const src = await openLibrary(entry.lastKnownPaths[0]!, mkDeps());
    expect(src.readOnlyReason).toBe("moved");
    expect(src.movedTo).toEqual({ newRoot: dest, unfinished: true });
    const unfinished = await listUnfinishedMoves(mkDeps());
    expect(unfinished).toEqual([{ libraryId: lib.id, oldRoot: lib.root, newRoot: dest, moveId: expect.any(String), startedAt: NOW }]);
    await completeMove(src.movedTo!.newRoot, mkDeps(), env);
    expect((await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
    const d = await openLibrary(dest, mkDeps());
    expect(d.mode).toBe("read-write");
    await d.close();
    const again = await openLibrary(lib.root, mkDeps());
    expect(again.movedTo).toEqual({ newRoot: dest, unfinished: false });
    expect(await listUnfinishedMoves(mkDeps())).toEqual([]);
  });

  it("a crash between mark-old and register is recoverable (split)", async () => {
    const { lib, b } = await fixture(HIPAA_GOV, true);
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "mark-old";
    await expect(executeMove(lib, dest, { deps: mkDeps(), env, excludeProjectIds: [b.id] })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await lib.close();
    const entry = (await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!;
    expect(entry.lastKnownPaths).toContain(dest);
    const [u] = await listUnfinishedMoves(mkDeps());
    expect(u).toMatchObject({ libraryId: lib.id, newRoot: dest });
    await completeMove(u!.newRoot, mkDeps(), env);
    expect((await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
    const d = await openLibrary(dest, mkDeps());
    expect(d.mode).toBe("read-write");
    await d.close();
  });

  it("deleteOldCopy fails closed when part of the old copy cannot be read", async () => {
    const { lib } = await fixture();
    const res = await executeMove(lib, join(tmp, "Dest"), { deps: mkDeps(), env });
    moveSeams.unreadableDir = "Exports";
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(out.warnings.join(" ")).toMatch(/could not be read/);
    expect(out.leftovers).toContain("Exports/");
    expect(out.rootRemoved).toBe(false);
    expect(await walkFiles(lib.root)).toEqual(expect.arrayContaining(["MOVED.json", "library.json"]));
  });

  it("moving a split remainder whole: its moved-away folders are not leftovers and stay untouched", async () => {
    const f = await fixture(HIPAA_GOV, true);
    await executeMove(f.lib, join(tmp, "Dest"), { deps: mkDeps(), env, excludeProjectIds: [f.b.id] });
    const rest = await openLibrary(f.lib.root, mkDeps());
    const keepA = await hashes(join(f.lib.root, f.a.folder));
    const res = await executeMove(rest, join(tmp, "Dest2"), { deps: mkDeps(), env });
    expect(res.projectsMovedAway).toEqual([f.a.folder]);
    const out = await deleteOldCopy(f.lib.root, res.confirmToken);
    expect(out.leftovers).toEqual([]);
    expect(out.movedAwayKept).toEqual([f.a.folder]);
    expect(await hashes(join(f.lib.root, f.a.folder))).toEqual(keepA);
    expect(await walkFiles(f.lib.root)).not.toContain("library.json");
  });
});

describe("Task 50: no refusal or audit failure is silent", () => {
  const macEnv = (): LocationEnv => ({ ...env, platform: "darwin" });
  const oneDrive = () => join(env.homeDir, "Library/CloudStorage/OneDrive-Contoso/Lib");
  const attentionOf = async (root: string, folder: string) => readdir(join(root, folder, "attention")).catch(() => [] as string[]);

  it("a refused move is audited as a deny in each refused project: who, what, the rule", async () => {
    const { lib, repo, a, b } = await fixture(HIPAA_GOV, true);
    const beforeA = (await auditOf(lib.root, a.folder)).length;
    await expect(executeMove(lib, oneDrive(), { deps: mkDeps(), env: macEnv(), sourceRepo: repo })).rejects.toMatchObject({ code: "policy-denied" });
    const ev = (await auditOf(lib.root, b.folder)).at(-1)!;
    expect(ev.action).toBe("move");
    expect(ev.actor).toBe("tester");
    expect(ev.decision).toMatchObject({ result: "deny" });
    expect(ev.decision!.reason).toMatch(/\S/);
    expect(ev.details).toMatchObject({ op: "library.move", destinationKind: "cloud_folder", cloudFolderId: "onedrive:Contoso" });
    expect(JSON.stringify(ev)).not.toContain(tmp);
    expect((await auditOf(lib.root, a.folder)).length).toBe(beforeA);
    expect(await attentionOf(lib.root, b.folder)).toEqual([]);
  });

  it("a refusal that cannot be audited now marks the project; the next open records it late", async () => {
    const { lib, repo, b } = await fixture(HIPAA_GOV, true);
    // No open repo was passed: nothing can append to the log now.
    await expect(executeMove(lib, oneDrive(), { deps: mkDeps(), env: macEnv() })).rejects.toMatchObject({ code: "policy-denied" });
    expect(await attentionOf(lib.root, b.folder)).toHaveLength(1);
    expect(await projectWarnings(repo, b.id)).toContain("audit-unrecorded");
    const raw = await readFile(join(lib.root, b.folder, "attention", (await attentionOf(lib.root, b.folder))[0]!), "utf8");
    expect(raw).not.toContain(tmp);
    await lib.close();
    const again = await openLibrary(lib.root, mkDeps());
    open.push(again);
    const r = await openTestRepo(again, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    const ev = (await auditOf(lib.root, b.folder)).at(-1)!;
    expect(ev).toMatchObject({ action: "move", decision: { result: "deny" }, details: { op: "library.move", recordedLate: { occurredAt: NOW } } });
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: b.id, kind: "audit-recorded-late" }));
    expect(await projectWarnings(r, b.id)).not.toContain("audit-unrecorded");
    expect(await attentionOf(lib.root, b.folder)).toEqual([]);
  });

  it("a library.move event that cannot be written leaves the move in place, marks the project, and is recorded on the next open", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    seams.failAuditAppendFor = a.id;
    const res = await executeMove(lib, dest, { deps: mkDeps(), env });
    expect(res.verified).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/needing attention/);
    expect(await attentionOf(dest, a.folder)).toHaveLength(1);
    expect((await auditOf(dest, a.folder)).filter((e) => e.action === "library.move")).toHaveLength(0);
    expect((await auditOf(dest, b.folder)).filter((e) => e.action === "library.move")).toHaveLength(1);
    seams.failAuditAppendFor = undefined;
    const d = await openLibrary(dest, mkDeps());
    open.push(d);
    expect(d.mode).toBe("read-write");
    const before = await openTestRepo(d, ring, { clock: () => now, tz: "UTC", scryptN: FAST, noHeal: true });
    expect(await projectWarnings(before, a.id)).toContain("audit-unrecorded");
    const r = await openTestRepo(d, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    const moves = (await auditOf(dest, a.folder)).filter((e) => e.action === "library.move");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.details).toMatchObject({ moveId: expect.any(String), recordedLate: { occurredAt: NOW, reason: "Error" } });
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: a.id, kind: "audit-recorded-late" }));
    expect(await projectWarnings(r, a.id)).toEqual([]);
  });

  it("P2 / R154 e: nothing is written under another device's lock; the mark waits on this device and is delivered once", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    const res = await executeMove(lib, dest, { deps: mkDeps(), env });
    const depsB: Deps = { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: process.pid + 1 };
    await acquireLock(dest, depsB);
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(out.rootRemoved).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/kept on this computer/);
    // Nothing appeared in the library B holds.
    expect(await attentionOf(dest, a.folder)).toEqual([]);
    expect(await attentionOf(dest, b.folder)).toEqual([]);
    const outbox = await readdir(join(tmp, "config", "attention-outbox")).catch(() => [] as string[]);
    expect(outbox).toHaveLength(1);
    // Shown on this device while B holds the lock.
    const ro = await openLibrary(dest, mkDeps());
    expect(ro.readOnlyReason).toBe("locked-by-other-device");
    const roRepo = await openTestRepo(ro, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect(await projectWarnings(roRepo, a.id)).toEqual(["audit-waiting"]);
    await ro.close();
    // Delivered on this device's next writable open, once.
    await releaseLock(dest, depsB);
    for (let i = 0; i < 2; i++) {
      const d = await openLibrary(dest, mkDeps());
      const r = await openTestRepo(d, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
      for (const f of [a.folder, b.folder]) {
        const ev = (await auditOf(dest, f)).filter((e) => e.action === "library.old-copy-deleted");
        expect(ev).toHaveLength(1);
        expect(ev[0]!.details).toMatchObject({ recordedLate: { by: "dev-A" } });
      }
      expect(await projectWarnings(r, a.id)).toEqual([]);
      await d.close();
    }
    const left = await readdir(join(tmp, "config", "attention-outbox", (await readdir(join(tmp, "config", "attention-outbox")))[0]!));
    expect(left).toEqual([]);
  });

  it("P2b / N1: handed a read-only repo of a library another device holds, nothing is written there; the marks wait on this device", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    const res = await executeMove(lib, dest, { deps: mkDeps(), env });
    const depsB: Deps = { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: process.pid + 1 };
    await acquireLock(dest, depsB);
    const ro = await openLibrary(dest, mkDeps());
    open.push(ro);
    expect(ro.readOnlyReason).toBe("locked-by-other-device");
    const roRepo = await openTestRepo(ro, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    const out = await deleteOldCopy(lib.root, res.confirmToken, { destRepo: roRepo });
    expect(out.warnings.join(" ")).toMatch(/kept on this computer/);
    expect(out.warnings.join(" ")).not.toMatch(/marked as needing attention/);
    expect(await attentionOf(dest, a.folder)).toEqual([]);
    expect(await attentionOf(dest, b.folder)).toEqual([]);
    expect(await projectWarnings(roRepo, a.id)).toEqual(["audit-waiting"]);
  });

  it("a library.old-copy-deleted event that cannot be written marks the project in the new copy", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    const res = await executeMove(lib, dest, { deps: mkDeps(), env });
    seams.failAuditAppendFor = b.id;
    const out = await deleteOldCopy(lib.root, res.confirmToken);
    expect(out.rootRemoved).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/needing attention/);
    expect(await attentionOf(dest, b.folder)).toHaveLength(1);
    expect(await attentionOf(dest, a.folder)).toEqual([]);
    seams.failAuditAppendFor = undefined;
    const d = await openLibrary(dest, mkDeps());
    open.push(d);
    await openTestRepo(d, ring, { clock: () => now, tz: "UTC", scryptN: FAST });
    expect((await auditOf(dest, b.folder)).filter((e) => e.action === "library.old-copy-deleted")).toHaveLength(1);
    expect(await attentionOf(dest, b.folder)).toEqual([]);
  });

  it("a crash after the failed append and before the mark leaves the move unfinished, which the next open reports and completeMove records", async () => {
    const { lib, a, b } = await fixture();
    const dest = join(tmp, "Dest");
    seams.failAuditAppendFor = a.id;
    seams.crashAt = "before-attention-mark";
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedCrash);
    await lib.close();
    seams.failAuditAppendFor = undefined;
    const half = await openLibrary(dest, mkDeps());
    expect([half.mode, half.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    await half.close();
    await completeMove(dest, mkDeps(), env);
    for (const f of [a.folder, b.folder]) expect((await auditOf(dest, f)).filter((e) => e.action === "library.move")).toHaveLength(1);
    expect(await attentionOf(dest, a.folder)).toEqual([]);
  });
});

describe("the list of old library copies cannot be read (Task 68, ruling 1)", () => {
  it("the move is stopped before anything is switched, says so in plain words, and writes nothing to the list", async () => {
    const { lib } = await fixture();
    const before = await hashes(lib.root, notLock);
    const cfgDir = join(tmp, "config");
    await mkdir(cfgDir, { recursive: true });
    // A folder where the list should be: it cannot be read (and could not be replaced).
    await mkdir(join(cfgDir, "pending-old-copies.json"));
    const regBefore = await listLibraries(mkDeps());
    const err = (await executeMove(lib, join(tmp, "Moved", "Lib"), { deps: mkDeps(), env }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OldCopiesUnreadableError);
    expect(err.message).toMatch(/stopped before anything was switched/);
    expect(err.message).toMatch(/still where it was/);
    expect(err.message).toMatch(/no old copy is listed for deletion/);
    expect(err.message).not.toContain(tmp);
    // Nothing switched: the library is where it was, unchanged; the registry and the list are as before.
    expect(await hashes(lib.root, notLock)).toEqual(before);
    expect(await listLibraries(mkDeps())).toEqual(regBefore);
    expect((await stat(join(cfgDir, "pending-old-copies.json"))).isDirectory()).toBe(true);
    expect(await readdir(join(cfgDir, "old-copies")).catch(() => [])).toEqual([]);
  });
});

describe("FR-755 (R578): finishMoveAt finishes only this computer's own unfinished move, at its own new place", () => {
  /** A whole-library move whose switch stopped after `step` (the process died there; its lock went with it). */
  async function stoppedAfter(step: "mark-old" | "register" | "close-source" | "audit-move") {
    const f = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = step;
    await expect(executeMove(f.lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await f.lib.close();
    return { ...f, dest };
  }
  const journalOf = async (dest: string) => JSON.parse(await readFile(join(dest, ".move-journal.json"), "utf8"));

  for (const step of ["mark-old", "register", "close-source", "audit-move"] as const) {
    it(`a switch stopped after "${step}" is finished: the new place opens read-write, the old copy is marked, no lock is left`, async () => {
      const { lib, a, b, dest } = await stoppedAfter(step);
      const res = await finishMoveAt(dest, mkDeps());
      expect(res?.verified).toBe(true);
      expect(await readdir(dest)).not.toContain(".move-journal.json");
      expect(await readdir(dest)).not.toContain(".lock");
      expect(await readdir(lib.root)).not.toContain(".lock");
      for (const fo of [a.folder, b.folder]) expect((await auditOf(dest, fo)).filter((e) => e.action === "library.move")).toHaveLength(1);
      expect((await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(dest);
      expect(await listUnfinishedMoves(mkDeps())).toEqual([]);
      const d = await openLibrary(dest, mkDeps());
      expect(d.mode).toBe("read-write");
      await d.close();
      expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
    });
  }

  for (const by of ["real path", "link"] as const) {
    it(`R583 M1: a move to a place reached through a symbolic link is recognised by what the folder is: opened by its ${by}, it finishes`, async () => {
      const f = await fixture();
      await mkdir(join(tmp, "Real"));
      await symlink(join(tmp, "Real"), join(tmp, "Link"));
      const linked = join(tmp, "Link", "Lib");
      moveSeams.crashAfter = "close-source";
      await expect(executeMove(f.lib, linked, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
      await f.lib.close();
      const opened = by === "link" ? linked : join(await realpath(join(tmp, "Real")), "Lib");
      expect((await finishMoveAt(opened, mkDeps()))?.verified).toBe(true);
      expect(await readdir(join(tmp, "Real", "Lib"))).not.toContain(".move-journal.json");
    });
  }

  it("R583 M2: after a failure at the journal's removal (the record already complete) the old copy says its move has not finished, and it cannot be deleted until the move is finished", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.fail = { at: "unlink" };
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toMatchObject({ code: "ENOSPC" });
    await lib.close();
    expect((await openLibrary(lib.root, mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: true });
    const before = await hashes(lib.root);
    await expect(deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).rejects.toMatchObject({
      code: "move-unfinished",
      message: "The move of this library has not finished, so its old copy cannot be deleted yet. Open the library at its new place first; the move is finished then.",
    });
    expect(await hashes(lib.root)).toEqual(before);
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
    expect((await openLibrary(lib.root, mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: false });
    expect((await deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).filesDeleted).toBeGreaterThan(0);
  });

  it("nothing to finish (no journal): undefined, nothing written", async () => {
    const { lib } = await fixture();
    await lib.close();
    const before = await hashes(lib.root);
    expect(await finishMoveAt(lib.root, mkDeps())).toBeUndefined();
    expect(await hashes(lib.root)).toEqual(before);
  });

  it("a copy made by hand of the new place, with its journal, is not finished (not the record's place); completeMove refuses it too", async () => {
    const { lib, dest } = await stoppedAfter("close-source");
    const copy = join(tmp, "Copy");
    await mkdir(copy);
    for (const rel of await walkFiles(dest)) {
      await mkdir(join(copy, rel, ".."), { recursive: true });
      await writeFile(join(copy, rel), await readFile(join(dest, rel)));
    }
    const [copyBefore, destBefore, oldBefore] = [await hashes(copy), await hashes(dest), await hashes(lib.root)];
    const regBefore = await listLibraries(mkDeps());
    expect(await finishMoveAt(copy, mkDeps())).toBeUndefined();
    await expect(completeMove(copy, mkDeps(), env)).rejects.toMatchObject({ code: "nothing-to-complete" });
    expect(await hashes(copy)).toEqual(copyBefore);
    expect(await hashes(dest)).toEqual(destBefore);
    expect(await hashes(lib.root)).toEqual(oldBefore);
    expect(await listLibraries(mkDeps())).toEqual(regBefore);
  });

  it("a move this computer has no record of (brought from another computer) is not finished", async () => {
    const { dest } = await stoppedAfter("close-source");
    const before = await hashes(dest);
    const other = { ...mkDeps(), appConfigDir: join(tmp, "other-config"), deviceId: "dev-B" };
    expect(await finishMoveAt(dest, other)).toBeUndefined();
    expect(await hashes(dest)).toEqual(before);
  });

  it("an old copy not yet marked (the switch stopped before it) is not finished: it is still the library", async () => {
    const { lib, dest } = await stoppedAfter("mark-old");
    const j = await journalOf(dest);
    j.switch.done = [];
    await writeFile(join(dest, ".move-journal.json"), JSON.stringify(j));
    await rm(join(lib.root, "MOVED.json"));
    const [destBefore, oldBefore] = [await hashes(dest), await hashes(lib.root)];
    expect(await finishMoveAt(dest, mkDeps())).toBeUndefined();
    expect(await hashes(dest)).toEqual(destBefore);
    expect(await hashes(lib.root)).toEqual(oldBefore);
  });

  it("an old copy marked but not yet recorded as marked: marked again only under its own lock; held by another computer, nothing is written", async () => {
    const { lib, dest } = await stoppedAfter("mark-old");
    const j = await journalOf(dest);
    j.switch.done = [];
    await writeFile(join(dest, ".move-journal.json"), JSON.stringify(j));
    const other = { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: 4242 };
    expect((await acquireLock(lib.root, other)).acquired).toBe(true);
    const [destBefore, oldBefore] = [await hashes(dest), await hashes(lib.root)];
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "old-copy-in-use" });
    const destAfter = await hashes(dest);
    expect([...new Set([...Object.keys(destAfter), ...Object.keys(destBefore)])].filter((k) => destAfter[k] !== destBefore[k])).toEqual([]);
    expect(await hashes(lib.root)).toEqual(oldBefore);
    await releaseLock(lib.root, other);
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
    expect(await readdir(lib.root)).not.toContain(".lock");
    expect((await openLibrary(dest, mkDeps())).mode).toBe("read-write");
  });

  it("the new place held by another computer: refused, nothing written", async () => {
    const { lib, dest } = await stoppedAfter("close-source");
    const other = { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: 4242 };
    expect((await acquireLock(dest, other)).acquired).toBe(true);
    const [destBefore, oldBefore] = [await hashes(dest), await hashes(lib.root)];
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "in-use" });
    expect(await hashes(dest)).toEqual(destBefore);
    expect(await hashes(lib.root)).toEqual(oldBefore);
  });

  it("a step that fails while finishing (no room) leaves the journal as it was, or advanced only by the steps that completed", async () => {
    const { lib, dest } = await stoppedAfter("close-source");
    const [destBefore, oldBefore] = [await hashes(dest, notLock), await hashes(lib.root)];
    moveSeams.fail = { at: "mark-complete" };
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await hashes(lib.root)).toEqual(oldBefore);
    // audit-move completed and is recorded (the journal, the moved projects' audit logs and the new place's entry in
    // library.json's location history, which every read-write opening there writes, advanced); nothing else changed.
    const j = await journalOf(dest);
    expect(j.switch.done).toEqual(["mark-old", "close-source", "register", "audit-move"]);
    const after = await hashes(dest, notLock);
    const changed = [...new Set([...Object.keys(after), ...Object.keys(destBefore)])].filter((k) => destBefore[k] !== after[k]);
    expect(changed.filter((k) => !(k === ".move-journal.json" || k === "library.json" || /\/audit\//u.test(k)))).toEqual([]);
    expect(await readdir(dest)).not.toContain(".lock");
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
  });
});

describe("FR-755 (R583): split moves, the check before finishing, and what cannot be finished", () => {
  /** A library with projects A and B (moved) and C (kept); `dest` is where A and B go. */
  async function splitFixture() {
    const f = await fixture();
    const c = (await f.repo.createProject({ name: "C", governanceYaml: CLOUD_OK_GOV, encryption: { enabled: false } })).project;
    await f.repo.createSource(c.id, draft("Sea"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    return { ...f, c: { id: c.id, folder: c.folder }, dest: join(tmp, "Dest") };
  }
  const moveSplit = (f: Awaited<ReturnType<typeof splitFixture>>) => executeMove(f.lib, f.dest, { deps: mkDeps(), env, excludeProjectIds: [f.c.id] });
  const marked = async (root: string, folder: string) => (await readdir(join(root, folder))).includes("MOVED.json");

  async function assertSplitFinished(f: Awaited<ReturnType<typeof splitFixture>>) {
    expect(await readdir(f.dest)).not.toContain(".move-journal.json");
    const d = await openLibrary(f.dest, mkDeps());
    expect([d.mode, d.id]).toEqual(["read-write", f.lib.id]);
    await d.close();
    const rest = await openLibrary(f.lib.root, mkDeps());
    expect(rest.mode).toBe("read-write");
    expect(rest.id).not.toBe(f.lib.id);
    await rest.close();
    expect(await marked(f.lib.root, f.a.folder)).toBe(true);
    expect(await marked(f.lib.root, f.b.folder)).toBe(true);
    expect(await marked(f.lib.root, f.c.folder)).toBe(false);
    expect(await readdir(f.lib.root)).not.toContain(".lock");
  }

  for (const n of [1, 2]) {
    it(`I1: a split whose marking stopped after ${n === 1 ? "the first" : "the last"} moved project is recognised and finished at the new place; the kept project is untouched`, async () => {
      const f = await splitFixture();
      moveSeams.fail = { at: "split-mark", afterFolders: n };
      await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
      await f.lib.close();
      expect(await oldCopyMarkedFor(f.dest, f.lib.root, mkDeps())).toBe(true);
      const keptBefore = await hashes(join(f.lib.root, f.c.folder), (rel) => /^audit\//u.test(rel));
      expect((await finishMoveAt(f.dest, mkDeps()))?.verified).toBe(true);
      await assertSplitFinished(f);
      expect(await hashes(join(f.lib.root, f.c.folder), (rel) => /^audit\//u.test(rel))).toEqual(keptBefore);
    });
  }

  it("I1: a split whose journal's write failed after the marking is finished at the new place", async () => {
    const f = await splitFixture();
    moveSeams.fail = { at: "journal", after: "mark-old" };
    await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
    await f.lib.close();
    expect(await oldCopyMarkedFor(f.dest, f.lib.root, mkDeps())).toBe(true);
    expect((await finishMoveAt(f.dest, mkDeps()))?.verified).toBe(true);
    await assertSplitFinished(f);
  });

  it("I1: nothing marked yet: not marked, and not finished", async () => {
    const f = await splitFixture();
    moveSeams.fail = { at: "split-mark", afterFolders: 1 };
    await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
    await f.lib.close();
    await rm(join(f.lib.root, f.a.folder, "MOVED.json"));
    expect(await oldCopyMarkedFor(f.dest, f.lib.root, mkDeps())).toBe(false);
    expect(await finishMoveAt(f.dest, mkDeps())).toBeUndefined();
  });

  it("I1: a split marked part-way whose not-yet-marked project was changed in the library it came from is not finished; nothing is written", async () => {
    const f = await splitFixture();
    moveSeams.fail = { at: "split-mark", afterFolders: 1 };
    await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
    await f.lib.close();
    const late = (await readdir(join(f.lib.root, f.b.folder, "audit")))[0]!;
    await writeFile(join(f.lib.root, f.b.folder, "audit", late), (await readFile(join(f.lib.root, f.b.folder, "audit", late), "utf8")) + "{}\n");
    const [oldAt, destAt] = [await hashes(f.lib.root), await hashes(f.dest)];
    await expect(finishMoveAt(f.dest, mkDeps())).rejects.toMatchObject({ kind: "source-changed" });
    expect(await hashes(f.lib.root)).toEqual(oldAt);
    expect(await hashes(f.dest)).toEqual(destAt);
  });

  async function stopped() {
    const f = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "close-source";
    await expect(executeMove(f.lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await f.lib.close();
    return { ...f, dest };
  }
  const aPdf = async (root: string, folder: string) => (await walkFiles(join(root, folder))).find((r) => r.endsWith(".pdf"))!;

  it("M5: a file removed by hand at the new place: not finished, the count said, the old copy whole; nothing written", async () => {
    const { lib, a, dest } = await stopped();
    await rm(join(dest, a.folder, await aPdf(dest, a.folder)));
    const [oldAt, destAt] = [await hashes(lib.root), await hashes(dest)];
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1, oldRoot: lib.root, oldWhole: true } });
    expect(await hashes(lib.root)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
  });

  it("M5: a file changed at the new place, and one at the old copy too: not finished, the old copy not called whole", async () => {
    const { lib, a, dest } = await stopped();
    const rel = await aPdf(dest, a.folder);
    await writeFile(join(dest, a.folder, rel), "changed");
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1, oldWhole: true } });
    await writeFile(join(lib.root, a.folder, rel), "changed too");
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1, oldWhole: false } });
  });

  it("the old copy's day-long offer of deletion runs from the finishing of a move finished later", async () => {
    const { lib, dest } = await stopped();
    now = new Date(Date.parse(NOW) + 3 * 24 * 3600_000);
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
    const [offer] = await listPendingOldCopies(mkDeps());
    expect([offer!.expired, offer!.expiresAt]).toEqual([false, new Date(now.getTime() + 24 * 3600_000).toISOString()]);
    expect((await deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).filesDeleted).toBeGreaterThan(0);
  });

  it("M4: a damaged journal cannot be finished, and says so", async () => {
    const { dest } = await stopped();
    await writeFile(join(dest, ".move-journal.json"), "{ not json");
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "journal-damaged" });
  });

  it("M4: the old copy cannot be reached when its mark must be looked at: says so; with the mark recorded, the move still finishes without it", async () => {
    const { lib, dest } = await stopped();
    const jp = join(dest, ".move-journal.json");
    const recorded = await readFile(jp, "utf8");
    const j = JSON.parse(recorded);
    j.switch.done = [];
    await writeFile(jp, JSON.stringify(j));
    await rename(lib.root, join(tmp, "Unplugged"));
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "old-copy-unreachable", detail: { oldRoot: lib.root } });
    await writeFile(jp, recorded);
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
  });

  it("M4: a library of a newer format at the new place is refused as such", async () => {
    const { dest } = await stopped();
    const meta = JSON.parse(await readFile(join(dest, "library.json"), "utf8"));
    await writeFile(join(dest, "library.json"), JSON.stringify({ ...meta, formatVersion: 99 }));
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "newer-format" });
  });

  // R590 N1: the old library of an unfinished split opens read-only until the new place has finished the move.
  for (const n of [1, 2]) {
    it(`R590 N1: the old library of a split whose marking stopped after ${n === 1 ? "the first" : "the last"} moved project opens read-only as moved, naming the new place, and nothing in it changes; once the new place has finished the move it opens for changes with the projects that stayed`, async () => {
      const f = await splitFixture();
      moveSeams.fail = { at: "split-mark", afterFolders: n };
      await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
      await f.lib.close();
      const before = await hashes(f.lib.root);
      const old = await openLibrary(f.lib.root, mkDeps());
      expect([old.mode, old.readOnlyReason, old.movedTo]).toEqual(["read-only", "moved", { newRoot: f.dest, unfinished: true }]);
      await old.close();
      expect(await hashes(f.lib.root)).toEqual(before);
      expect((await finishMoveAt(f.dest, mkDeps()))?.verified).toBe(true);
      await assertSplitFinished(f);
    });
  }

  it("R590 N1: the old library of an unfinished split is matched by its real path: opened through a symbolic link, it is read-only too", async () => {
    const f = await splitFixture();
    moveSeams.fail = { at: "split-mark", afterFolders: 1 };
    await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
    await f.lib.close();
    await symlink(f.lib.root, join(tmp, "OldLink"));
    const old = await openLibrary(join(tmp, "OldLink"), mkDeps());
    expect([old.mode, old.readOnlyReason]).toEqual(["read-only", "moved"]);
    await old.close();
  });

  it("R590 N1: a split stopped before any project was marked: the old library is still the library and opens for changes", async () => {
    const f = await splitFixture();
    moveSeams.fail = { at: "split-mark", afterFolders: 1 };
    await expect(moveSplit(f)).rejects.toMatchObject({ code: "ENOSPC" });
    await f.lib.close();
    await rm(join(f.lib.root, f.a.folder, "MOVED.json"));
    const old = await openLibrary(f.lib.root, mkDeps());
    expect(old.mode).toBe("read-write");
    await old.close();
  });

  // R590 N2: each audit log at the new place begins with exactly what the move verified, and has no fault.
  const auditLogOf = async (root: string, folder: string) => join(root, folder, "audit", (await readdir(join(root, folder, "audit"))).filter((n) => n.endsWith(".jsonl")).sort()[0]!);
  for (const [how, cut] of [
    ["cut to nothing", () => ""],
    ["cut to its first line", (t: string) => `${t.split("\n")[0]}\n`],
  ] as const) {
    it(`R590 N2: an audit log at the new place ${how} by hand: not finished, counted among the files that differ; nothing written`, async () => {
      const { lib, a, dest } = await stopped();
      const log = await auditLogOf(dest, a.folder);
      const text = await readFile(log, "utf8");
      expect(text.split("\n").filter(Boolean).length).toBeGreaterThan(1);
      await writeFile(log, cut(text));
      const [oldAt, destAt] = [await hashes(lib.root), await hashes(dest)];
      await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1, oldRoot: lib.root, oldWhole: true } });
      expect(await hashes(lib.root)).toEqual(oldAt);
      expect(await hashes(dest)).toEqual(destAt);
    });
  }

  it("R590 N2: a line that is not the switch's own, appended by hand to an audit log at the new place: not finished, the log counted once", async () => {
    const { a, dest } = await stopped();
    const log = await auditLogOf(dest, a.folder);
    await writeFile(log, `${await readFile(log, "utf8")}${JSON.stringify({ action: "source.delete" })}\n`);
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1 } });
  });

  it("R590 N2: an audit log that begins with what was verified and goes on with the switch's own lines is finished over", async () => {
    const { a, dest } = await stopped();
    moveSeams.fail = { at: "mark-complete" };
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "ENOSPC" });
    expect((await auditOf(dest, a.folder)).filter((e) => e.action === "library.move")).toHaveLength(1);
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
  });

  it("R590 N2: the switch's own line changed by hand after the verified beginning (the chain broken): the finishing's own opening reports it, and the move is not finished", async () => {
    const { a, dest } = await stopped();
    moveSeams.fail = { at: "mark-complete" };
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "ENOSPC" });
    const log = await auditLogOf(dest, a.folder);
    const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    const last = JSON.parse(lines.pop()!);
    last.details = { ...last.details, fileCount: 999 };
    await writeFile(log, `${[...lines, JSON.stringify(last)].join("\n")}\n`);
    const destAt = await hashes(dest);
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1 } });
    expect(await hashes(dest)).toEqual(destAt);
  });

  // R590 N3: every mark the journal records as made must still be there.
  it("R590 N3: a moved project's mark the journal records, removed by hand: not finished, nothing written (C)", async () => {
    const f = await splitFixture();
    moveSeams.crashAfter = "register";
    await expect(moveSplit(f)).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await f.lib.close();
    await rm(join(f.lib.root, f.a.folder, "MOVED.json"));
    const [oldAt, destAt] = [await hashes(f.lib.root), await hashes(f.dest)];
    await expect(finishMoveAt(f.dest, mkDeps())).rejects.toMatchObject({ kind: "mark-missing" });
    expect(await hashes(f.lib.root)).toEqual(oldAt);
    expect(await hashes(f.dest)).toEqual(destAt);
  });

  it("R590 N3: a whole library's top mark the journal records, removed by hand: not finished, nothing written (C2)", async () => {
    const { lib, dest } = await stopped();
    await rm(join(lib.root, "MOVED.json"));
    const [oldAt, destAt] = [await hashes(lib.root), await hashes(dest)];
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "mark-missing" });
    expect(await hashes(lib.root)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
  });

  // R590 N4: where the new place cannot be read, whether the move finished cannot be told: the old copy is kept.
  it("R590 N4: the new place's drive not connected: the old copy cannot be deleted, and the refusal says why", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.fail = { at: "unlink" };
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toMatchObject({ code: "ENOSPC" });
    await lib.close();
    await rename(dest, join(tmp, "Unplugged"));
    const before = await hashes(lib.root);
    await expect(deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).rejects.toMatchObject({
      code: "move-unfinished",
      message: "The old copy cannot be deleted now: the library's new place cannot be reached, so the app cannot tell whether its move has finished. Connect the drive the new place is on and try again.",
    });
    expect(await hashes(lib.root)).toEqual(before);
  });

  // R596 b: the words say only what this computer knows; the deletion stays fail-closed.
  it("R596 b: the old copy of a FINISHED move whose new place cannot be read: not called unfinished, and still not deletable", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await executeMove(lib, dest, { deps: mkDeps(), env });
    await rename(dest, join(tmp, "Unplugged"));
    expect((await openLibrary(lib.root, mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: false });
    await expect(deleteOldCopy(lib.root, { confirm: true }, { deps: mkDeps() })).rejects.toMatchObject({
      code: "move-unfinished",
      message: "The old copy cannot be deleted now: the library's new place cannot be reached, so the app cannot tell whether its move has finished. Connect the drive the new place is on and try again.",
    });
  });

  it("R596 b: the old copy of a move whose record is not complete, its new place unreadable: has not finished", async () => {
    const { lib, dest } = await stopped();
    await rename(dest, join(tmp, "Unplugged"));
    expect((await openLibrary(lib.root, mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: true });
  });

  // R590 N5: the old place's words, and how the old place is found.
  it("R590 N5: the old place of a move whose journal is damaged says so: it does not promise that opening the new place finishes the move", async () => {
    const { lib, dest } = await stopped();
    await writeFile(join(dest, ".move-journal.json"), "{ not json");
    expect((await openLibrary(lib.root, mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: true, journalDamaged: true });
  });

  it("R590 N5: the old place is matched by its real path: opened through a symbolic link, it names the new place", async () => {
    const { lib, dest } = await stopped();
    await symlink(lib.root, join(tmp, "OldLink"));
    expect((await openLibrary(join(tmp, "OldLink"), mkDeps())).movedTo).toEqual({ newRoot: dest, unfinished: true });
  });
});

describe("FR-755 (R599 M-1): on a computer whose audit anchors were lost, an interrupted finishing still finishes", () => {
  /** A whole-library switch stopped with mark-old done but not recorded; this computer's audit anchors then removed. */
  async function markedNotRecordedAnchorsLost() {
    const f = await fixture();
    // A refused project creation: the library's own audit log then holds an entry written by this computer.
    await expect(f.repo.createProject({ name: "Refused", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toThrow();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "mark-old";
    await expect(executeMove(f.lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    await f.lib.close();
    const jp = join(dest, ".move-journal.json");
    const j = JSON.parse(await readFile(jp, "utf8"));
    j.switch.done = [];
    await writeFile(jp, JSON.stringify(j));
    await rm(join(tmp, "config", "audit-anchors.json"));
    return { ...f, dest };
  }

  for (const step of ["mark-old", "register", "close-source", "audit-move", "mark-complete"] as const) {
    it(`the finishing interrupted ${step === "mark-complete" ? "by a failure at mark-complete" : `after "${step}"`}: the next opening finishes it`, async () => {
      const { lib, a, b, dest } = await markedNotRecordedAnchorsLost();
      if (step === "mark-complete") {
        moveSeams.fail = { at: "mark-complete" };
        await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ code: "ENOSPC" });
      } else {
        moveSeams.crashAfter = step;
        await expect(finishMoveAt(dest, mkDeps())).rejects.toBeInstanceOf(SimulatedMoveCrash);
      }
      // The finishing's own writable opening recorded that this computer's anchor was missing.
      expect((await auditOf(dest, a.folder)).some((e) => e.action === "audit.anchor-missing")).toBe(true);
      expect((await auditOf(dest, ".")).some((e) => e.action === "audit.anchor-missing")).toBe(true);
      expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
      expect(await readdir(dest)).not.toContain(".move-journal.json");
      for (const fo of [a.folder, b.folder]) expect((await auditOf(dest, fo)).filter((e) => e.action === "library.move")).toHaveLength(1);
      expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
    });
  }

  it("audit.anchor-mismatch after the verified beginning of a project's log is still refused", async () => {
    const { a, dest } = await markedNotRecordedAnchorsLost();
    const dir = join(dest, a.folder, "audit");
    const log = join(dir, (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort()[0]!);
    await writeFile(log, `${await readFile(log, "utf8")}${JSON.stringify({ action: "audit.anchor-mismatch" })}\n`);
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1 } });
  });

  it("the library's own audit log takes the same rule: a line of another action after its verified beginning is refused", async () => {
    const { dest } = await markedNotRecordedAnchorsLost();
    const dir = join(dest, "audit");
    const log = join(dir, (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort()[0]!);
    const text = await readFile(log, "utf8");
    const last = JSON.parse(text.split("\n").filter(Boolean).pop()!);
    await writeFile(log, `${text}${JSON.stringify({ ...last, seq: last.seq + 1, action: "store" })}\n`);
    const destAt = await hashes(dest);
    await expect(finishMoveAt(dest, mkDeps())).rejects.toMatchObject({ kind: "files-differ", detail: { count: 1 } });
    expect(await hashes(dest)).toEqual(destAt);
  });
});

describe("FR-068 (R607 a): a move into a folder holding a stopped move's switch resumes only that very move, once its old copy is marked; otherwise it is refused and nothing is written", () => {
  const STALE = "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first.";
  const refused = { name: "MoveNotAllowedError", code: "destination-not-empty", message: STALE };
  const journalOf = async (dest: string) => JSON.parse(await readFile(join(dest, ".move-journal.json"), "utf8"));
  const config = () => hashes(join(tmp, "config"));
  const sourcesOf = (r: Repo, pid: string) => r.listSourceIds(pid).length;

  /**
   * A move of `lib` that fails after its copy was verified and its journal entered the switching phase, but before the
   * old copy was marked: a folder stands where the mark must go (the top's, or each moved project's). The obstacle is
   * then removed; the old library is still open here, read-write.
   */
  async function failedBeforeMark(lib: Library, dest: string, exclude: string[] = [], movedFolders: string[] = []) {
    const at = movedFolders.length ? movedFolders.map((f) => join(lib.root, f, "MOVED.json")) : [join(lib.root, "MOVED.json")];
    for (const p of at) await mkdir(p);
    await expect(executeMove(lib, dest, { deps: mkDeps(), env, excludeProjectIds: exclude })).rejects.toThrow();
    for (const p of at) await rm(p, { recursive: true });
    const j = await journalOf(dest);
    expect([j.phase, j.switch.done, lib.mode]).toEqual(["switching", [], "read-write"]);
  }

  /** The move asked again from `lib` into `dest`, by the plan, the early plan and the move itself: each refused, nothing written anywhere. */
  async function refusedEverywhere(lib: Library, dest: string, places: string[], exclude: string[] = []) {
    const before = [await config(), ...(await Promise.all(places.map((p) => hashes(p))))];
    await expect(planMove(lib, dest, env)).rejects.toMatchObject(refused);
    await expect(acceptMovePlan(lib, dest, { deps: mkDeps(), env, excludeProjectIds: exclude })).rejects.toMatchObject(refused);
    await expect(executeMove(lib, dest, { deps: mkDeps(), env, excludeProjectIds: exclude })).rejects.toMatchObject(refused);
    expect([await config(), ...(await Promise.all(places.map((p) => hashes(p))))]).toEqual(before);
  }

  it("the FR-068 sequence: failed before the mark; the old library takes a change; the move asked again to that folder without a plan is refused, nothing is written, and the old library is still the library with its change", async () => {
    const { lib, repo, a } = await fixture();
    const dest = join(tmp, "Dest");
    await failedBeforeMark(lib, dest);
    await repo.createSource(a.id, draft("Four"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await refusedEverywhere(lib, dest, [lib.root, dest]);
    expect(lib.mode).toBe("read-write");
    expect(sourcesOf(repo, a.id)).toBe(4);
    expect((await journalOf(dest)).switch.done).toEqual([]);
  });

  it("C-1: A→B fails before the mark; A→C succeeds and the library at C changes; the move from C to B is refused (plan and move), both folders unchanged; the opening of B does not finish B's switch over A's mark of the move to C", async () => {
    const { lib, a } = await fixture();
    const b = join(tmp, "B");
    const c = join(tmp, "C");
    await failedBeforeMark(lib, b);
    expect((await executeMove(lib, c, { deps: mkDeps(), env })).verified).toBe(true);
    // With nothing changed since, the opening of B must not take A's mark (of the move to C) for the mark of B's move.
    const [aAt, bAt, cAt, cfgAt] = [await hashes(lib.root), await hashes(b), await hashes(c), await config()];
    expect(await finishMoveAt(b, mkDeps())).toBeUndefined();
    expect([await hashes(lib.root), await hashes(b), await hashes(c), await config()]).toEqual([aAt, bAt, cAt, cfgAt]);
    const atC = await openLibrary(c, mkDeps());
    open.push(atC);
    const repoC = await openTestRepo(atC, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST });
    await repoC.createSource(a.id, draft("Four"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await refusedEverywhere(atC, b, [c, b, lib.root]);
    expect(atC.mode).toBe("read-write");
    expect(sourcesOf(repoC, a.id)).toBe(4);
    expect((await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!.lastKnownPaths[0]).toBe(c);
  });

  it("a mark naming another library at the old place does not count: refused", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await failedBeforeMark(lib, dest);
    const { switch: sw } = await journalOf(dest);
    await writeFile(join(lib.root, "MOVED.json"), JSON.stringify({ libraryId: "01ANOTHERLIBRARY0000000000", movedAt: NOW, toHint: "host-A:Dest", moveId: sw.moveId }));
    await refusedEverywhere(lib, dest, [lib.root, dest]);
  });

  it("back and forth (A→B, then B→A, then A→C failing before its mark): a stale mark of an earlier move at A, with its id or without one, does not count: refused", async () => {
    const { lib } = await fixture();
    const there = join(tmp, "There");
    const first = await executeMove(lib, there, { deps: mkDeps(), env });
    const markOfFirst = await readFile(join(lib.root, "MOVED.json"), "utf8");
    expect((await deleteOldCopy(lib.root, first.confirmToken)).rootRemoved).toBe(true);
    const atThere = await openLibrary(there, mkDeps());
    open.push(atThere);
    await executeMove(atThere, lib.root, { deps: mkDeps(), env });
    const markOfSecond = await readFile(join(there, "MOVED.json"), "utf8");
    const back = await openLibrary(lib.root, mkDeps());
    open.push(back);
    expect(back.mode).toBe("read-write");
    const c = join(tmp, "C");
    await failedBeforeMark(back, c);
    const { moveId } = JSON.parse(markOfFirst) as { moveId?: string };
    expect(moveId).toBeDefined();
    expect(moveId).not.toBe((await journalOf(c)).switch.moveId);
    const { moveId: _drop, ...noId } = JSON.parse(markOfFirst) as Record<string, unknown>;
    for (const stale of [markOfFirst, markOfSecond, JSON.stringify(noId)]) {
      await writeFile(join(lib.root, "MOVED.json"), stale);
      await refusedEverywhere(back, c, [lib.root, c]);
    }
  });

  it("a split whose library holds a project marked by an EARLIER split: the later split fails before its first mark; run again it is refused", async () => {
    const f = await fixture();
    const c = (await f.repo.createProject({ name: "C", governanceYaml: CLOUD_OK_GOV, encryption: { enabled: false } })).project;
    // The earlier split: A goes; B and C stay, and the old folder becomes the remaining library, A's folder marked there.
    await executeMove(f.lib, join(tmp, "First"), { deps: mkDeps(), env, excludeProjectIds: [f.b.id, c.id] });
    const rest = await openLibrary(f.lib.root, mkDeps());
    open.push(rest);
    expect([rest.mode, rest.id === f.lib.id]).toEqual(["read-write", false]);
    expect(JSON.parse(await readFile(join(f.lib.root, f.a.folder, "MOVED.json"), "utf8")).moveId).toEqual(expect.any(String));
    const repo = await openTestRepo(rest, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST });
    const dest = join(tmp, "Second");
    await failedBeforeMark(rest, dest, [c.id], [f.b.folder]);
    await repo.createSource(f.b.id, draft("Bee two"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await refusedEverywhere(rest, dest, [f.lib.root, dest], [c.id]);
    expect(sourcesOf(repo, f.b.id)).toBe(2);
  });

  it("the old place cannot be reached: whether it is marked cannot be seen: refused", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await failedBeforeMark(lib, dest);
    await rename(lib.root, join(tmp, "Away"));
    try {
      await refusedEverywhere(lib, dest, [dest]);
    } finally {
      await rename(join(tmp, "Away"), lib.root);
    }
  });

  it("a copy of the library made by hand (the same id) moved to that folder: refused (it is not the move's old place)", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    await failedBeforeMark(lib, dest);
    const hand = join(tmp, "Hand");
    await cp(lib.root, hand, { recursive: true });
    await rm(join(hand, ".lock"));
    const copy = await openLibrary(hand, mkDeps());
    open.push(copy);
    expect([copy.mode, copy.id]).toEqual(["read-write", lib.id]);
    await refusedEverywhere(copy, dest, [hand, dest, lib.root]);
  });

  it("the process killed between the switching journal and the mark; the old library opened again and changed; the move asked again is refused, nothing written", async () => {
    const f = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.crashAfter = "switching-journal";
    await expect(executeMove(f.lib, dest, { deps: mkDeps(), env })).rejects.toBeInstanceOf(SimulatedMoveCrash);
    expect(moveSeams.crashAfter).toBeUndefined();
    await f.lib.close();
    expect((await journalOf(dest)).phase).toBe("switching");
    const lib = await openLibrary(f.lib.root, mkDeps());
    open.push(lib);
    expect(lib.mode).toBe("read-write");
    const repo = await openTestRepo(lib, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST });
    await repo.createSource(f.a.id, draft("Four"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
    await refusedEverywhere(lib, dest, [lib.root, dest]);
    expect(sourcesOf(repo, f.a.id)).toBe(4);
  });

  it("a mark written by an older build (no move id) and not recorded in the journal: the move refuses to resume, and the opening of the new place still finishes the move as before", async () => {
    const { lib } = await fixture();
    const dest = join(tmp, "Dest");
    moveSeams.fail = { at: "journal", after: "mark-old" };
    await expect(executeMove(lib, dest, { deps: mkDeps(), env })).rejects.toMatchObject({ code: "ENOSPC" });
    expect((await journalOf(dest)).switch.done).toEqual([]);
    const mark = JSON.parse(await readFile(join(lib.root, "MOVED.json"), "utf8")) as Record<string, unknown>;
    expect(mark.moveId).toBe((await journalOf(dest)).switch.moveId);
    const { moveId: _drop, ...older } = mark;
    await writeFile(join(lib.root, "MOVED.json"), JSON.stringify(older, null, 2));
    await refusedEverywhere(lib, dest, [lib.root, dest]);
    await lib.close();
    expect((await finishMoveAt(dest, mkDeps()))?.verified).toBe(true);
    expect((await openLibrary(lib.root, mkDeps())).readOnlyReason).toBe("moved");
  });

  // What does not change: the mark of THIS move recorded in the journal, or seen at the old copy: the switch is resumed,
  // with no copy and no verification.
  for (const [what, arm, split] of [
    ["whole library, the mark recorded", () => void (moveSeams.crashAfter = "mark-old"), false],
    ["whole library, the mark seen but not recorded", () => void (moveSeams.fail = { at: "journal", after: "mark-old" }), false],
    ["split, the marks recorded", () => void (moveSeams.crashAfter = "register"), true],
    ["split, one mark seen but not recorded", () => void (moveSeams.fail = { at: "split-mark", afterFolders: 1 }), true],
  ] as const) {
    it(`unchanged: ${what}: run again, the switch is resumed, with no copy and no verification`, async () => {
      const f = await fixture();
      let exclude: string[] = [];
      if (split) exclude = [(await f.repo.createProject({ name: "C", governanceYaml: CLOUD_OK_GOV, encryption: { enabled: false } })).project.id];
      const dest = join(tmp, "Dest");
      arm();
      await expect(executeMove(f.lib, dest, { deps: mkDeps(), env, excludeProjectIds: exclude })).rejects.toThrow();
      const switched = (rel: string) => rel === ".move-journal.json" || /\/audit\//u.test(rel) || rel === "library.json" || rel === ".lock";
      const destAt = await hashes(dest, switched);
      const phases = new Set<string>();
      const res = await executeMove(f.lib, dest, { deps: mkDeps(), env, excludeProjectIds: exclude, onProgress: (p) => void phases.add(p.phase) });
      expect([res.verified, res.filesCopied, phases.has("copy"), phases.has("verify")]).toEqual([true, 0, false, false]);
      expect(await hashes(dest, switched)).toEqual(destAt);
      expect(await readdir(dest)).not.toContain(".move-journal.json");
    });
  }
});
