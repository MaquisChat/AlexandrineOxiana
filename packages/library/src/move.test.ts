import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  deleteOldCopy,
  executeMove,
  planMove,
} from "./move.js";
import { listLibraries } from "./registry.js";
import type { Repo } from "./repo/index.js";
import { openTestRepo, seams } from "./repo/testing.js";

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
  env = { homeDir: join(tmp, "home"), platform: "linux", mounts: [] };
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello research\n%%EOF\n");
});
afterEach(async () => {
  seams.failUndo = undefined;
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
    });
  });
  it("recognises OneDrive, Dropbox and Google Drive under ~/Library/CloudStorage", () => {
    expect(classifyLocation("/Users/ana/Library/CloudStorage/OneDrive-Contoso/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso" });
    expect(classifyLocation("/Users/ana/Library/CloudStorage/Dropbox-Personal/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox" });
    expect(classifyLocation("/Users/ana/Library/CloudStorage/GoogleDrive-ana@uni.edu/My Drive/Lib", mac())).toEqual({
      kind: "cloud_folder",
      cloudFolderId: "googledrive:ana@uni.edu",
    });
  });
  it("recognises ~/Dropbox on any platform", () => {
    expect(classifyLocation("/Users/ana/Dropbox/Lib", mac())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox" });
    expect(classifyLocation("/home/ana/Dropbox", { homeDir: "/home/ana", platform: "linux", mounts: [] })).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox" });
    expect(classifyLocation("C:\\Users\\ana\\Dropbox\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "dropbox" });
  });
  it("recognises Windows OneDrive folders (case-insensitively) and Google Drive's G:\\My Drive", () => {
    expect(classifyLocation("C:\\Users\\ana\\OneDrive - Contoso\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso" });
    expect(classifyLocation("c:\\users\\ANA\\OneDrive\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Personal" });
    expect(classifyLocation("G:\\My Drive\\Lib", win())).toEqual({ kind: "cloud_folder", cloudFolderId: "googledrive" });
  });
  it("does not mistake a sibling folder for a cloud folder", () => {
    expect(classifyLocation("/Users/ana/DropboxOld/Lib", mac())).toEqual({ kind: "device" });
    expect(classifyLocation("/Users/bob/Dropbox/Lib", mac())).toEqual({ kind: "device" });
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
    expect(classifyLocation("/media/ana/USB/Lib", linux)).toEqual({ kind: "removable" });
    expect(classifyLocation("/mnt/nas/share/Lib", linux)).toEqual({ kind: "network" });
    expect(classifyLocation("/mnt/nasty/Lib", linux)).toEqual({ kind: "device" });
    expect(classifyLocation("/home/ana/Lib", linux)).toEqual({ kind: "device" });
  });
  it("matches Windows drive letters from the mount list", () => {
    const w = win([
      { path: "E:\\", removable: true, network: false },
      { path: "Z:\\", removable: false, network: true },
    ]);
    expect(classifyLocation("e:\\Lib", w)).toEqual({ kind: "removable" });
    expect(classifyLocation("Z:\\lab\\Lib", w)).toEqual({ kind: "network" });
    expect(classifyLocation("C:\\Research\\Lib", w)).toEqual({ kind: "device" });
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
    expect(plan.destination).toEqual({ kind: "cloud_folder", cloudFolderId: "onedrive:Contoso" });
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
    seams.failUndo = "created";
    await expect(repo.createSource(a.id, draft("X"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() })).rejects.toThrow();
    seams.failUndo = undefined;
    // Remove the marker so only the in-memory recoveryPending flag remains.
    for (const n of await readdir(join(lib.root, ".tmp"))) await rm(join(lib.root, ".tmp", n), { recursive: true });
    await expect(planMove(lib, join(tmp, "Dest"), env)).resolves.toBeDefined();
    await expect(planMove(lib, join(tmp, "Dest"), env, { repo })).rejects.toMatchObject({ code: "pending-writes" });
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
    // Old copy untouched, lock released.
    expect(await hashes(lib.root)).toEqual(before);
    expect(lib.mode).toBe("read-write");
    await expect(stat(join(lib.root, ".lock"))).rejects.toThrow();
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
    const other = await openLibrary(lib.root, { ...mkDeps(), deviceId: "dev-B", hostname: "host-B", pid: process.pid + 1 });
    open.push(other);
    expect(other.mode).toBe("read-write");
    await expect(deleteOldCopy(lib.root, res.confirmToken)).rejects.toMatchObject({ code: "old-copy-in-use" });
    await other.close();
    // Opening it there recorded a new location in library.json, so that file changed and is kept.
    await expect(deleteOldCopy(lib.root, res.confirmToken)).resolves.toMatchObject({ kept: ["library.json"], rootRemoved: false });
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

