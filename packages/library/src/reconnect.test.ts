import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AuditEvent, Provenance, SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { IndexHandle } from "./index/db.js";
import { rebuildIndex } from "./index/rebuild.js";
import { LibraryMovedError, WrongLibraryError, createLibrary, openLibrary, type Library } from "./library.js";
import { acquireLock, readLock } from "./lock.js";
import { MOVED_MARKER, MOVE_JOURNAL } from "./move.js";
import { addPendingOldCopy } from "./old-copies.js";
import {
  checkIntegrity,
  defaultSearchRoots,
  findLibrary,
  hydrate,
  isPlaceholder,
  pickSample,
  reconnect,
  relinkMissing,
  relinkSeams,
  watchAvailability,
  type FoundLibrary,
} from "./reconnect.js";
import { listLibraries } from "./registry.js";
import { ReadOnlyLibraryError, type Repo } from "./repo/index.js";
import { openTestRepo } from "./repo/testing.js";

const FAST = 2 ** 10;
const NOW = "2026-11-09T14:30:00.000Z";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const IDENT_PLAIN_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
captureMethods: [manual_upload, downloader]
`;
const HIPAA_GOV = `profiles: [hipaa]
`;
const PASS = "correct horse battery";

let tmp: string;
let now: Date;
let ring: KeyRing;
let open: Library[];
let timers: Array<{ fn: () => unknown; ms: number; cleared: boolean }>;
let lostCalls: unknown[];

function mkDeps(over: Partial<Deps> = {}): Deps {
  return {
    clock: () => now,
    deviceId: "dev-A",
    hostname: "host-A",
    pid: 100,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
    ...over,
  };
}
const depsB = () => mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 200 });

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
function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    captureMethod: "manual_upload",
    capturedAt: NOW,
    tool: { name: "ao", version: "0.0.0" },
    fileHashes: {},
    legal: { status: "public" },
    identifiable: false,
    ...over,
  };
}
const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");

async function input(name: string, content: string): Promise<string> {
  const p = join(tmp, "inputs", name);
  await mkdir(join(tmp, "inputs"), { recursive: true });
  await writeFile(p, content);
  return p;
}

async function auditOf(root: string, folder: string): Promise<AuditEvent[]> {
  const dir = join(root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function collect(it: AsyncIterable<FoundLibrary>): Promise<FoundLibrary[]> {
  const out: FoundLibrary[] = [];
  for await (const x of it) out.push(x);
  return out;
}

interface Fx {
  lib: Library;
  repo: Repo;
  pid: string;
  folder: string;
  /** Library-relative asset paths of project P's three sources, in creation order. */
  assets: Array<{ id: string; path: string; sourceId: string }>;
}

/** A library at `<tmp>/Libs/Research` with project P (open governance) holding three sources. */
async function fixture(deps = mkDeps()): Promise<Fx> {
  const lib = await createLibrary(join(tmp, "Libs", "Research"), "Research", deps, { onLockLost: (h) => lostCalls.push(h) });
  open.push(lib);
  const repo = await openTestRepo(lib, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST });
  const p = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project;
  const assets: Fx["assets"] = [];
  for (const t of ["One", "Two", "Three"]) {
    const sf = await repo.createSource(p.id, draft(t), [{ path: await input(`${t}.pdf`, `%PDF-1.7 ${t} body\n`), role: "original", handling: "copy" }], {
      provenance: provenance(),
    });
    assets.push({ id: sf.assets[0]!.id, path: sf.assets[0]!.path, sourceId: sf.source.id });
  }
  return { lib, repo, pid: p.id, folder: p.folder, assets };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-reconnect-"));
  now = new Date(NOW);
  ring = new KeyRing();
  open = [];
  timers = [];
  lostCalls = [];
});
afterEach(async () => {
  vi.useRealTimers();
  relinkSeams.beforeCopy = undefined;
  for (const l of open) await l.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
describe("findLibrary", () => {
  it("finds a library renamed and moved on disk under a search root", async () => {
    const { lib } = await fixture();
    await lib.close();
    await mkdir(join(tmp, "Search", "Drive", "Old stuff"), { recursive: true });
    await rename(lib.root, join(tmp, "Search", "Drive", "Old stuff", "Renamed Library"));
    const found = await collect(findLibrary(lib.id, [join(tmp, "Search")], { maxDepth: 4 }));
    expect(found).toEqual([{ path: join(tmp, "Search", "Drive", "Old stuff", "Renamed Library") }]);
  });

  it("yields live copies before moved-away old copies (flagged, with the marker's hint)", async () => {
    const { lib } = await fixture();
    await lib.close();
    const s = join(tmp, "S");
    // The old copy sorts first, so a depth-first walk meets it first.
    await cp(lib.root, join(s, "A-old"), { recursive: true });
    await writeFile(join(s, "A-old", MOVED_MARKER), JSON.stringify({ libraryId: lib.id, movedAt: NOW, toHint: "host-A:B-new" }));
    await cp(lib.root, join(s, "B-new"), { recursive: true });
    const other = await createLibrary(join(s, "C-other"), "Other", mkDeps());
    await other.close();
    const found = await collect(findLibrary(lib.id, [s], { maxDepth: 4 }));
    expect(found).toEqual([{ path: join(s, "B-new") }, { path: join(s, "A-old"), moved: true, movedToHint: "host-A:B-new" }]);
  });

  it("skips .tmp, node_modules, hidden folders and symbolic links, and stops at maxDepth", async () => {
    const { lib } = await fixture();
    await lib.close();
    const s = join(tmp, "S");
    const copyTo = (rel: string) => cp(lib.root, join(s, rel), { recursive: true });
    await copyTo("x/.tmp/L1");
    await copyTo("x/node_modules/L2");
    await copyTo("x/.hidden/L3");
    await copyTo("1/2/3/4/L4"); // depth 5: too deep
    await copyTo("1/2/3/L5"); // depth 4: found
    await cp(lib.root, join(tmp, "Outside", "L6"), { recursive: true });
    await symlink(join(tmp, "Outside"), join(s, "link"));
    const found = await collect(findLibrary(lib.id, [s], { maxDepth: 4 }));
    expect(found.map((f) => f.path)).toEqual([join(s, "1/2/3/L5")]);
    // A hidden folder given as a root is checked itself.
    expect((await collect(findLibrary(lib.id, [join(s, "x/.hidden/L3")], { maxDepth: 4 }))).map((f) => f.path)).toEqual([join(s, "x/.hidden/L3")]);
    // A root reached twice (overlapping roots) is reported once.
    expect(await collect(findLibrary(lib.id, [s, join(s, "1/2/3/L5"), s], { maxDepth: 4 }))).toHaveLength(1);
    // A root that is itself a link was named explicitly and is followed.
    expect((await collect(findLibrary(lib.id, [join(s, "link")], { maxDepth: 4 }))).map((f) => f.path)).toEqual([join(s, "link", "L6")]);
  });

  it("honours an abort signal", async () => {
    const { lib } = await fixture();
    const ac = new AbortController();
    ac.abort();
    await expect(collect(findLibrary(lib.id, [tmp], { maxDepth: 4, signal: ac.signal }))).rejects.toThrow(/abort/i);
  });
});

describe("defaultSearchRoots", () => {
  it("lists mounted volumes, cloud folders and home: deduplicated, existing only", async () => {
    const home = join(tmp, "home");
    const mk = (rel: string) => mkdir(join(home, rel), { recursive: true });
    await mk("Library/CloudStorage/Dropbox-Personal");
    await mk("Library/CloudStorage/OneDrive-Contoso");
    await mk("Library/Mobile Documents/com~apple~CloudDocs");
    await mk("OneDrive - Uni");
    await mk("Google Drive");
    await mkdir(join(tmp, "Volumes", "USB"), { recursive: true });
    await mkdir(join(tmp, "Volumes", "NAS"), { recursive: true });
    const roots = await defaultSearchRoots({
      homeDir: home,
      platform: "darwin",
      mounts: [
        { path: "/", removable: false, network: false },
        { path: join(tmp, "Volumes", "USB"), removable: true, network: false },
        { path: join(tmp, "Volumes", "NAS"), removable: false, network: true },
        { path: join(tmp, "Volumes", "Gone"), removable: true, network: false },
        { path: join(tmp, "Volumes", "USB"), removable: true, network: false },
      ],
      vars: { OneDrive: join(home, "OneDrive - Uni") },
    });
    expect(roots).toEqual([
      join(tmp, "Volumes", "USB"),
      join(tmp, "Volumes", "NAS"),
      join(home, "Library/CloudStorage/Dropbox-Personal"),
      join(home, "Library/CloudStorage/OneDrive-Contoso"),
      join(home, "Library/Mobile Documents/com~apple~CloudDocs"),
      join(home, "Google Drive"),
      join(home, "OneDrive - Uni"),
      home,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("reconnect", () => {
  it("refuses a different library (WrongLibraryError) without touching it", async () => {
    const { lib } = await fixture();
    await lib.close();
    const other = await createLibrary(join(tmp, "Other"), "Other", mkDeps());
    await other.close();
    const err = await reconnect(other.root, lib.id, mkDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WrongLibraryError);
    expect(err).toMatchObject({ expectedId: lib.id, foundId: other.id });
    expect(await readLock(other.root)).toBeNull();
  });

  it("rebuilds a deleted library.sqlite, records the location and audits library.reconnect", async () => {
    const { lib, folder } = await fixture();
    await new IndexHandle(lib.root).close();
    await lib.close();
    const moved = join(tmp, "Elsewhere", "Research (renamed)");
    await mkdir(join(tmp, "Elsewhere"));
    await rename(lib.root, moved);
    await unlink(join(moved, "library.sqlite"));

    const r = await reconnect(moved, lib.id, mkDeps(), { keyRing: ring });
    open.push(r.library);
    expect(r.rebuilt).toBe(true);
    expect(r.library.mode).toBe("read-write");
    expect(r.integrity).toMatchObject({ checked: 3, missing: [], mismatched: [], placeholders: [], presenceOnly: 0 });
    expect((await stat(join(moved, "library.sqlite"))).isFile()).toBe(true);
    const reg = (await listLibraries(mkDeps())).find((e) => e.libraryId === lib.id)!;
    expect(reg.lastKnownPaths[0]).toBe(moved);
    const ev = (await auditOf(moved, folder)).filter((e) => e.action === "library.reconnect");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ hint: "host-A:Research (renamed)", rebuilt: true, integrity: { checked: 3, missing: 0 } });
    expect(JSON.stringify(ev[0]!.details)).not.toContain(tmp);
  });

  it("accepts the path of library.json itself and skips the rebuild when the index is current", async () => {
    const { lib } = await fixture();
    const h = new IndexHandle(lib.root);
    await rebuildIndex(h, ring, lib);
    h.close();
    await lib.close();
    const r = await reconnect(join(lib.root, "library.json"), lib.id, mkDeps(), { keyRing: ring });
    open.push(r.library);
    expect(r.library.root).toBe(lib.root);
    expect(r.rebuilt).toBe(false);
    expect(r.rebuildSkipped).toBeUndefined();
  });

  it("reports rebuilt:false with a reason when the library opens read-only (locked by another device)", async () => {
    const { lib, folder } = await fixture();
    await lib.close();
    await rm(join(lib.root, "library.sqlite"), { force: true });
    await acquireLock(lib.root, depsB());
    const before = (await auditOf(lib.root, folder)).length;
    const r = await reconnect(lib.root, lib.id, mkDeps(), { keyRing: ring });
    expect(r.library.readOnlyReason).toBe("locked-by-other-device");
    expect(r.rebuilt).toBe(false);
    expect(r.rebuildSkipped).toMatch(/read-only/);
    expect(r.integrity.checked).toBe(3);
    expect((await auditOf(lib.root, folder)).length).toBe(before);
    expect(r.warnings.join(" ")).toMatch(/audit/);
  });

  it("refuses a moved-away old copy with LibraryMovedError carrying where it went", async () => {
    const { lib } = await fixture();
    await lib.close();
    await writeFile(join(lib.root, MOVED_MARKER), JSON.stringify({ libraryId: lib.id, movedAt: NOW, toHint: "host-A:New" }));
    let err = await reconnect(lib.root, lib.id, mkDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryMovedError);
    expect(err).toMatchObject({ toHint: "host-A:New", movedTo: undefined });
    await addPendingOldCopy(
      mkDeps(),
      { oldRoot: lib.root, newRoot: join(tmp, "New"), libraryId: lib.id, split: false, movedFolders: [], movedProjectIds: [], moveId: "m1" },
      { files: {}, dirs: [] },
    );
    err = await reconnect(lib.root, lib.id, mkDeps()).catch((e: unknown) => e);
    expect(err).toMatchObject({ movedTo: { newRoot: join(tmp, "New"), unfinished: true } });
    expect(await readLock(lib.root)).toBeNull();
  });

  it("surfaces an unfinished move (journal) as move-incomplete with the completeMove path", async () => {
    const { lib } = await fixture();
    await lib.close();
    await writeFile(join(lib.root, MOVE_JOURNAL), JSON.stringify({ phase: "switching" }));
    const r = await reconnect(lib.root, lib.id, mkDeps(), { keyRing: ring });
    expect(r.library.readOnlyReason).toBe("move-incomplete");
    expect(r.moveIncomplete).toEqual({ completeWith: "completeMove", destRoot: lib.root });
    expect(r.rebuilt).toBe(false);
  });

  it("opens a newer-format library read-only and skips the integrity check", async () => {
    const { lib } = await fixture();
    await lib.close();
    const meta = JSON.parse(await readFile(join(lib.root, "library.json"), "utf8"));
    await writeFile(join(lib.root, "library.json"), JSON.stringify({ ...meta, formatVersion: 99 }));
    const r = await reconnect(lib.root, lib.id, mkDeps());
    expect(r.library.readOnlyReason).toBe("newer-format");
    expect(r.integrity).toMatchObject({ checked: 0, skipped: "newer-format" });
    expect(r.rebuilt).toBe(false);
  });

  it("reports a removed asset as missing", async () => {
    const { lib, assets } = await fixture();
    await lib.close();
    await unlink(join(lib.root, assets[1]!.path));
    const r = await reconnect(lib.root, lib.id, mkDeps(), { keyRing: ring, sample: "full" });
    open.push(r.library);
    expect(r.integrity.missing).toEqual([{ assetId: assets[1]!.id, path: assets[1]!.path }]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("checkIntegrity", () => {
  it("checks presence and size of every asset, hashes a deterministic sample seeded by the library id", async () => {
    const { lib, repo, pid } = await fixture();
    for (let i = 0; i < 17; i++) {
      await repo.createSource(pid, draft(`Extra ${i}`), [{ path: await input(`e${i}.pdf`, `extra ${i}`), role: "original", handling: "copy" }], {
        provenance: provenance(),
      });
    }
    const a = await checkIntegrity(lib, 0.05);
    const b = await checkIntegrity(lib, 0.05);
    expect(a.checked).toBe(20);
    expect(a.hashed).toBe(1);
    expect(a.hashedAssetIds).toEqual(b.hashedAssetIds);
    const full = await checkIntegrity(lib, "full");
    expect(full.hashed).toBe(20);

    const ids = Array.from({ length: 40 }, (_, i) => `asset-${i}`);
    expect(pickSample(ids, "lib-1", 0.25)).toEqual(pickSample([...ids].reverse(), "lib-1", 0.25));
    expect(pickSample(ids, "lib-1", 0.25)).toHaveLength(10);
    expect(pickSample(ids, "lib-1", 0.25)).not.toEqual(pickSample(ids, "lib-2", 0.25));
  });

  it("finds same-size content changes when hashing, and size changes always", async () => {
    const { lib, assets } = await fixture();
    const p0 = join(lib.root, assets[0]!.path);
    const orig = await readFile(p0, "utf8");
    await writeFile(p0, orig.replace("One", "Uno"));
    await writeFile(join(lib.root, assets[2]!.path), "short");
    const r = await checkIntegrity(lib, "full");
    expect(r.mismatched.map((m) => m.assetId).sort()).toEqual([assets[0]!.id, assets[2]!.id].sort());
    const sampled = await checkIntegrity(lib, 0);
    expect(sampled.mismatched.map((m) => m.assetId)).toEqual([assets[2]!.id]);
  });

  it("reports placeholders without reading them (stubbed stat), not as missing", async () => {
    const { lib, assets } = await fixture();
    const ph = join(lib.root, assets[1]!.path);
    const realStat = (await import("node:fs/promises")).lstat;
    const statFn = vi.fn(async (p: string) => {
      const s = await realStat(p);
      if (p === ph) return Object.assign(Object.create(Object.getPrototypeOf(s) as object) as Stats, s, { blocks: 0 });
      return s;
    });
    const openRead = vi.fn((p: string) => createReadStream(p));
    const r = await checkIntegrity(lib, "full", { stat: statFn, openRead });
    expect(r.placeholders).toEqual([{ assetId: assets[1]!.id, path: assets[1]!.path }]);
    expect(r.missing).toEqual([]);
    expect(r.hashed).toBe(2);
    expect(openRead).toHaveBeenCalledTimes(2);
    expect(openRead.mock.calls.map((c) => c[0])).not.toContain(ph);
  });

  it("checks a locked encrypted project from manifest.json for presence only", async () => {
    const { lib, repo } = await fixture();
    const b = (await repo.createProject({ name: "B", governanceYaml: HIPAA_GOV, encryption: { enabled: true, passphrase: PASS } })).project;
    const sf = await repo.createSource(b.id, draft("Secret"), [{ path: await input("s.pdf", "secret body"), role: "original", handling: "copy" }], {
      provenance: provenance(),
    });
    const sf2 = await repo.createSource(b.id, draft("Secret2"), [{ path: await input("s2.pdf", "secret body 2"), role: "original", handling: "copy" }], {
      provenance: provenance(),
    });
    // Unlocked: decrypted and hashed like any other asset.
    const unlocked = await checkIntegrity(lib, "full", { keyRing: ring });
    expect(unlocked).toMatchObject({ checked: 5, hashed: 5, presenceOnly: 0, mismatched: [] });

    repo.lockProject(b.id);
    await unlink(join(lib.root, sf2.assets[0]!.path));
    const openRead = vi.fn((p: string) => createReadStream(p));
    const locked = await checkIntegrity(lib, "full", { keyRing: ring, openRead });
    expect(locked.presenceOnly).toBe(1);
    expect(locked.checked).toBe(5);
    expect(locked.hashed).toBe(3);
    expect(locked.missing).toEqual([{ assetId: null, path: sf2.assets[0]!.path }]);
    expect(openRead.mock.calls.map((c) => c[0])).not.toContain(join(lib.root, sf.assets[0]!.path));
  });
});

// ---------------------------------------------------------------------------------------------
describe("relinkMissing", () => {
  it("restores a removed asset from a renamed copy with the same hash", async () => {
    const { lib, assets } = await fixture();
    const target = join(lib.root, assets[1]!.path);
    const content = await readFile(target);
    await unlink(target);
    const found = join(tmp, "Found", "deep", "renamed-copy.bin");
    await mkdir(join(tmp, "Found", "deep"), { recursive: true });
    await writeFile(found, content);
    await writeFile(join(tmp, "Found", "decoy.pdf"), "x".repeat(content.length)); // same size, other content

    const r = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring });
    expect(r).toMatchObject({ relinked: 1, stillMissing: 0, relinkedPaths: [assets[1]!.path], relinkedUnverified: [] });
    expect((await readFile(target)).equals(content)).toBe(true);
    expect((await checkIntegrity(lib, "full")).missing).toEqual([]);
  });

  it("never relinks a same-name, same-size file with other content, and never overwrites an existing file", async () => {
    const { lib, assets } = await fixture();
    const missing = join(lib.root, assets[0]!.path);
    const size = (await stat(missing)).size;
    await unlink(missing);
    const present = join(lib.root, assets[2]!.path);
    await writeFile(present, "changed"); // present, mismatched: not missing, not touched
    await mkdir(join(tmp, "Found"));
    await writeFile(join(tmp, "Found", basename(assets[0]!.path)), "y".repeat(size));
    await cp(join(tmp, "inputs", "Three.pdf"), join(tmp, "Found", "three.pdf"));

    const r = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring });
    expect(r).toMatchObject({ relinked: 0, stillMissing: 1 });
    await expect(stat(missing)).rejects.toThrow();
    expect(await readFile(present, "utf8")).toBe("changed");
    expect((await readdir(join(missing, ".."))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("verifies the copy (a candidate changed after matching is not relinked) and never replaces a file that appeared meanwhile", async () => {
    const { lib, assets } = await fixture();
    const target = join(lib.root, assets[0]!.path);
    const content = await readFile(target);
    await unlink(target);
    await mkdir(join(tmp, "Found"));
    const cand = join(tmp, "Found", "copy.pdf");
    await writeFile(cand, content);

    relinkSeams.beforeCopy = async (src) => writeFile(src, Buffer.alloc(content.length, 0x41)); // same size, other bytes
    const r1 = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring });
    expect(r1).toMatchObject({ relinked: 0, stillMissing: 1, skipped: [{ path: assets[0]!.path, reason: "verify-failed" }] });
    await expect(stat(target)).rejects.toThrow();

    await writeFile(cand, content);
    relinkSeams.beforeCopy = async (_src, t) => writeFile(t, "written by someone else");
    const r2 = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring });
    expect(r2).toMatchObject({ relinked: 0, stillMissing: 1, skipped: [{ path: assets[0]!.path, reason: "target-exists" }] });
    expect(await readFile(target, "utf8")).toBe("written by someone else");
    expect((await readdir(join(target, ".."))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("restores 0600 for an identifiable source's file", async () => {
    const { lib, repo } = await fixture();
    const p = (await repo.createProject({ name: "I", governanceYaml: IDENT_PLAIN_GOV, encryption: { enabled: false } })).project;
    const src = await input("ident.pdf", "identifiable body");
    const sf = await repo.createSource(p.id, draft("Ident"), [{ path: src, role: "original", handling: "copy" }], {
      provenance: provenance({ identifiable: true, legal: { status: "consented", basis: "consent" } }),
    });
    const target = join(lib.root, sf.assets[0]!.path);
    await unlink(target);
    await mkdir(join(tmp, "Found"));
    await cp(src, join(tmp, "Found", "x.pdf"));
    await chmod(join(tmp, "Found", "x.pdf"), 0o644);
    expect((await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring })).relinked).toBe(1);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("updates a linked asset's stored paths through the repo (audited) instead of copying", async () => {
    const { lib, repo, pid, folder } = await fixture();
    await mkdir(join(lib.root, "Exports", "linked"), { recursive: true });
    const linkedFile = join(lib.root, "Exports", "linked", "scan.pdf");
    await writeFile(linkedFile, "linked body");
    const sf = await repo.createSource(pid, draft("Linked"), [{ path: linkedFile, role: "original", handling: "link" }], { provenance: provenance() });
    expect(sf.assets[0]!.linked).toBeDefined();
    await mkdir(join(lib.root, "Exports", "moved"));
    await rename(linkedFile, join(lib.root, "Exports", "moved", "scan renamed.pdf"));
    // A copy outside the library cannot be linked (linked files live inside the library).
    await mkdir(join(tmp, "Outside"));
    await writeFile(join(tmp, "Outside", "scan.pdf"), "linked body");
    const outside = await relinkMissing(lib, join(tmp, "Outside"), { keyRing: ring, repo });
    expect(outside).toMatchObject({ relinked: 0, stillMissing: 1 });
    expect(outside.skipped).toEqual([{ path: "Exports/linked/scan.pdf", reason: "outside-library" }]);

    const r = await relinkMissing(lib, join(lib.root, "Exports", "moved"), { keyRing: ring, repo });
    expect(r).toMatchObject({ relinked: 1, stillMissing: 0, relinkedPaths: ["Exports/moved/scan renamed.pdf"] });
    const after = await repo.getSource(pid, sf.source.id);
    expect(after.assets[0]!.path).toBe("Exports/moved/scan renamed.pdf");
    expect(after.assets[0]!.linked!.libraryRelativePath).toBe("Exports/moved/scan renamed.pdf");
    await expect(stat(linkedFile)).rejects.toThrow(); // nothing copied back
    const ev = (await auditOf(lib.root, folder)).filter((e) => e.details?.op === "asset.relink");
    expect(ev).toHaveLength(1);
  });

  it("relinks encrypted files: verified by decrypting when unlocked, unverified by name and size when locked", async () => {
    const { lib, repo } = await fixture();
    const b = (await repo.createProject({ name: "B", governanceYaml: HIPAA_GOV, encryption: { enabled: true, passphrase: PASS } })).project;
    const sf = await repo.createSource(b.id, draft("Secret"), [{ path: await input("s.pdf", "secret body"), role: "original", handling: "copy" }], {
      provenance: provenance(),
    });
    const target = join(lib.root, sf.assets[0]!.path);
    const enc = await readFile(target);
    await unlink(target);
    await mkdir(join(tmp, "Found"));
    await writeFile(join(tmp, "Found", "renamed.enc"), enc);
    const unlocked = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring, repo });
    expect(unlocked).toMatchObject({ relinked: 1, relinkedPaths: [sf.assets[0]!.path], relinkedUnverified: [] });
    expect((await readFile(target)).equals(enc)).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    repo.lockProject(b.id);
    await unlink(target);
    await rm(join(tmp, "Found"), { recursive: true });
    await mkdir(join(tmp, "Found", "sub"), { recursive: true });
    await writeFile(join(tmp, "Found", "renamed.enc"), enc); // other name: no match when locked
    await writeFile(join(tmp, "Found", "sub", basename(target)), enc);
    const locked = await relinkMissing(lib, join(tmp, "Found"), { keyRing: ring, repo });
    expect(locked).toMatchObject({ relinked: 1, relinkedPaths: [sf.assets[0]!.path], relinkedUnverified: [sf.assets[0]!.path] });
    expect(await sha(target)).toBe(createHash("sha256").update(enc).digest("hex"));
  });

  it("refuses a read-only library", async () => {
    const { lib } = await fixture();
    await lib.close();
    await acquireLock(lib.root, depsB());
    const ro = await openLibrary(lib.root, mkDeps());
    await expect(relinkMissing(ro, tmp)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
  });
});

// ---------------------------------------------------------------------------------------------
describe("isPlaceholder and hydrate", () => {
  const fake = (size: number, blocks: number) => async () => ({ size, blocks }) as Stats;
  it("uses size > 0 && blocks === 0 on POSIX, false on Windows (Phase 1)", async () => {
    expect(await isPlaceholder("/x", { stat: fake(10, 0), platform: "darwin" })).toBe(true);
    expect(await isPlaceholder("/x", { stat: fake(10, 0), platform: "linux" })).toBe(true);
    expect(await isPlaceholder("/x", { stat: fake(0, 0), platform: "linux" })).toBe(false);
    expect(await isPlaceholder("/x", { stat: fake(10, 8), platform: "linux" })).toBe(false);
    expect(await isPlaceholder("C:\\x", { stat: fake(10, 0), platform: "win32" })).toBe(false);
    const real = await input("real.txt", "hello");
    expect(await isPlaceholder(real)).toBe(false);
    expect(await isPlaceholder(join(tmp, "nope"))).toBe(false);
  });
  it("hydrate reads the whole file and reports progress", async () => {
    const p = await input("big.bin", "z".repeat(200_000));
    const progress: Array<[number, number]> = [];
    expect(await hydrate(p, (done, total) => progress.push([done, total]))).toBe(200_000);
    expect(progress.at(-1)).toEqual([200_000, 200_000]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("watchAvailability", () => {
  const timerDeps = () =>
    mkDeps({
      setInterval: (fn, ms) => {
        const t = { fn: fn as () => unknown, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    });
  const watchTimers = () => timers.filter((t) => t.ms === 5000);
  const tickWatch = () => watchTimers().at(-1)!.fn() as Promise<void>;
  const wopts = () => ({ setInterval: timerDeps().setInterval!, clearInterval: timerDeps().clearInterval! });

  it("goes offline when the root disappears (writes refused) and back online when restored", async () => {
    const { lib, repo } = await fixture(timerDeps());
    const states: string[] = [];
    const stop = watchAvailability(lib, (s) => states.push(s), wopts());
    await tickWatch();
    expect(states).toEqual([]);
    await rename(lib.root, `${lib.root}-unplugged`);
    await tickWatch();
    expect(states).toEqual(["offline"]);
    expect(lib.mode).toBe("read-only");
    expect(lib.readOnlyReason).toBe("offline");
    await expect(repo.createProject({ name: "Q", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await tickWatch();
    expect(states).toEqual(["offline"]);
    await rename(`${lib.root}-unplugged`, lib.root);
    await tickWatch();
    expect(states).toEqual(["offline", "online"]);
    expect(lib.mode).toBe("read-write");
    expect(lib.readOnlyReason).toBeUndefined();
    expect(await readLock(lib.root)).toMatchObject({ deviceId: "dev-A" });
    await repo.createProject({ name: "Q", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    stop();
    expect(watchTimers().at(-1)!.cleared).toBe(true);
  });

  it("stays read-only (locked-by-other-device) if another device took the lock while offline", async () => {
    const { lib } = await fixture(timerDeps());
    const states: string[] = [];
    watchAvailability(lib, (s) => states.push(s), wopts());
    await rename(lib.root, `${lib.root}-unplugged`);
    await tickWatch();
    await unlink(join(`${lib.root}-unplugged`, ".lock"));
    await rename(`${lib.root}-unplugged`, lib.root);
    expect((await acquireLock(lib.root, depsB())).acquired).toBe(true);
    await tickWatch();
    expect(states).toEqual(["offline", "online"]);
    expect(lib.mode).toBe("read-only");
    expect(lib.readOnlyReason).toBe("locked-by-other-device");
    expect(lostCalls).toHaveLength(1);
    expect(await readLock(lib.root)).toMatchObject({ deviceId: "dev-B" });
  });

  it("restores a read-only handle's previous reason", async () => {
    const { lib } = await fixture();
    await lib.close();
    await acquireLock(lib.root, depsB());
    const ro = await openLibrary(lib.root, mkDeps());
    expect(ro.readOnlyReason).toBe("locked-by-other-device");
    watchAvailability(ro, () => {}, wopts());
    await rename(lib.root, `${lib.root}-x`);
    await tickWatch();
    expect(ro.readOnlyReason).toBe("offline");
    await rename(`${lib.root}-x`, lib.root);
    await tickWatch();
    expect(ro.readOnlyReason).toBe("locked-by-other-device");
  });

  it("polls every 5 s by default (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { lib } = await fixture();
    let resolveChange!: (s: string) => void;
    const changed = new Promise<string>((r) => (resolveChange = r));
    const stop = watchAvailability(lib, (s) => resolveChange(s));
    await rename(lib.root, `${lib.root}-gone`);
    vi.advanceTimersByTime(4999);
    await new Promise((r) => setTimeout(r, 50));
    expect(lib.readOnlyReason).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(await changed).toBe("offline");
    expect(lib.readOnlyReason).toBe("offline");
    stop();
    await rename(`${lib.root}-gone`, lib.root);
  });
});
