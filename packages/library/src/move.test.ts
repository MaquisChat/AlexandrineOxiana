import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
  completeMove,
  deleteOldCopy,
  executeMove,
  listPendingOldCopies,
  listUnfinishedMoves,
  moveSeams,
  planMove,
} from "./move.js";
import { acquireLock, releaseLock } from "./lock.js";
import { addPendingOldCopy, markPendingComplete } from "./old-copies.js";
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
    expect(marker).toEqual({ libraryId: lib.id, movedAt: NOW, toHint: "host-A:Lib" });
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
    expect(db.result === "deny" && db.reason).toMatch(/^Destination type could not be determined/);
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
