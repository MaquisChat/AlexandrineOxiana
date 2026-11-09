import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlreadyALibraryError,
  CorruptLibraryError,
  FolderNotEmptyError,
  NotALibraryError,
  createLibrary,
  forgetLibrary,
  listLibraries,
  openLibrary,
  recordLocation,
  registerLibrary,
  type Deps,
} from "./index.js";
import { acquireLock } from "./lock.js";

let tmp: string;
let root: string;
let now: number;
let alive: Set<number>;
let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;

function mkDeps(over: Partial<Deps> = {}): Deps {
  return {
    clock: () => new Date(now),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: 100,
    isPidAlive: (pid) => alive.has(pid),
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    ...over,
  };
}
const depsB = () => mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 200 });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lib-"));
  root = join(tmp, "MyLib");
  now = Date.parse("2026-11-09T10:00:00Z");
  alive = new Set([100, 200]);
  timers = [];
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name);
    out.push(`${p}:${(await stat(p)).mtimeMs}`);
  }
  return out.sort();
}

describe("createLibrary / openLibrary", () => {
  it("creates folders and library.json, then reopens with the same id", async () => {
    const lib = await createLibrary(root, "Mine", mkDeps());
    expect(lib.mode).toBe("read-write");
    for (const d of ["Projects", "Exports", "Backups", ".cache", ".tmp"]) {
      expect((await stat(join(root, d))).isDirectory()).toBe(true);
    }
    await lib.close();
    const again = await openLibrary(root, mkDeps());
    expect(again.id).toBe(lib.id);
    expect(again.name).toBe("Mine");
    expect(again.mode).toBe("read-write");
    await again.close();
  });

  it("stores formatVersion 1 and never the full path", async () => {
    const lib = await createLibrary(root, "Mine", mkDeps());
    await lib.close();
    const raw = await readFile(join(root, "library.json"), "utf8");
    expect(raw).not.toContain(root);
    expect(raw).not.toContain(tmp);
    const json = JSON.parse(raw);
    expect(json.formatVersion).toBe(1);
    expect(json.locationHistory[0].hint).toBe("host-A:MyLib");
    expect(Object.keys(json.locationHistory[0]).sort()).toEqual(["at", "hint"]);
  });

  it("refuses a non-empty folder and an existing library", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "stuff.txt"), "x");
    await expect(createLibrary(root, "X", mkDeps())).rejects.toBeInstanceOf(FolderNotEmptyError);
    const root2 = join(tmp, "Lib2");
    await (await createLibrary(root2, "X", mkDeps())).close();
    await expect(createLibrary(root2, "Y", mkDeps())).rejects.toBeInstanceOf(AlreadyALibraryError);
  });

  it("NotALibraryError without library.json", async () => {
    await mkdir(root, { recursive: true });
    await expect(openLibrary(root, mkDeps())).rejects.toBeInstanceOf(NotALibraryError);
    await expect(openLibrary(join(tmp, "nope"), mkDeps())).rejects.toBeInstanceOf(NotALibraryError);
  });

  it("CorruptLibraryError for bad JSON or bad formatVersion, without writing", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "library.json"), "{nope");
    const before = await snapshot(root);
    await expect(openLibrary(root, mkDeps())).rejects.toBeInstanceOf(CorruptLibraryError);
    expect(await snapshot(root)).toEqual(before);
    for (const fv of [0, undefined]) {
      await writeFile(
        join(root, "library.json"),
        JSON.stringify({ libraryId: "x", name: "n", formatVersion: fv, createdAt: "t", locationHistory: [] }),
      );
      await expect(openLibrary(root, mkDeps())).rejects.toBeInstanceOf(CorruptLibraryError);
    }
  });

  it("opens read-only with newer-format and writes nothing", async () => {
    await (await createLibrary(root, "Mine", mkDeps())).close();
    const p = join(root, "library.json");
    const j = JSON.parse(await readFile(p, "utf8"));
    await writeFile(p, JSON.stringify({ ...j, formatVersion: 2 }));
    const before = await snapshot(root);
    const lib = await openLibrary(root, mkDeps());
    expect(lib.mode).toBe("read-only");
    expect(lib.readOnlyReason).toBe("newer-format");
    await lib.close();
    expect(await snapshot(root)).toEqual(before);
  });

  it("appends locationHistory on open from another place, only hostname:basename", async () => {
    await (await createLibrary(root, "Mine", mkDeps())).close();
    now += 1000;
    const lib = await openLibrary(root, mkDeps({ hostname: "host-Z" }));
    await lib.close();
    const j = JSON.parse(await readFile(join(root, "library.json"), "utf8"));
    expect(j.locationHistory.map((h: { hint: string }) => h.hint)).toEqual(["host-A:MyLib", "host-Z:MyLib"]);
  });
});

describe("lock", () => {
  it("second device is read-only while the lock is fresh, and writes nothing", async () => {
    const a = await createLibrary(root, "Mine", mkDeps());
    const before = await snapshot(root);
    const b = await openLibrary(root, depsB());
    expect(b.mode).toBe("read-only");
    expect(b.readOnlyReason).toBe("locked-by-other-device");
    await b.close();
    expect(await snapshot(root)).toEqual(before);
    // closing the read-only handle must not remove A's lock
    await stat(join(root, ".lock"));
    await a.close();
  });

  it("takes over after 121 s without heartbeat", async () => {
    await createLibrary(root, "Mine", mkDeps());
    now += 121_000;
    const b = await openLibrary(root, depsB());
    expect(b.mode).toBe("read-write");
    expect(JSON.parse(await readFile(join(root, ".lock"), "utf8")).deviceId).toBe("dev-B");
  });

  it("still locked at exactly 120 s", async () => {
    await createLibrary(root, "Mine", mkDeps());
    now += 120_000;
    expect((await openLibrary(root, depsB())).mode).toBe("read-only");
  });

  it("same host with a dead pid is stale immediately", async () => {
    await createLibrary(root, "Mine", mkDeps());
    alive.delete(100);
    const other = mkDeps({ deviceId: "dev-A2", pid: 300 });
    alive.add(300);
    expect((await openLibrary(root, other)).mode).toBe("read-write");
  });

  it("different host with dead-looking pid is not stale", async () => {
    await createLibrary(root, "Mine", mkDeps());
    alive.delete(100);
    expect((await openLibrary(root, depsB())).mode).toBe("read-only");
  });

  it("an unparseable lock is stale", async () => {
    await createLibrary(root, "Mine", mkDeps());
    await writeFile(join(root, ".lock"), "garbage{");
    expect((await openLibrary(root, depsB())).mode).toBe("read-write");
  });

  it("heartbeat every 30 s refreshes heartbeatAt; close stops it and removes lock", async () => {
    const lib = await createLibrary(root, "Mine", mkDeps());
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(30_000);
    now += 30_000;
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 50));
    const lock = JSON.parse(await readFile(join(root, ".lock"), "utf8"));
    expect(lock.heartbeatAt).toBe(new Date(now).toISOString());
    // heartbeat keeps others out beyond 121 s of the original open
    now += 100_000;
    expect((await acquireLock(root, depsB())).acquired).toBe(false);
    await lib.close();
    expect(timers[0]!.cleared).toBe(true);
    await expect(stat(join(root, ".lock"))).rejects.toThrow();
  });

  it("close does not remove a lock that now belongs to another device", async () => {
    const a = await createLibrary(root, "Mine", mkDeps());
    now += 121_000;
    const b = await openLibrary(root, depsB());
    await a.close();
    expect(JSON.parse(await readFile(join(root, ".lock"), "utf8")).deviceId).toBe("dev-B");
    await b.close();
  });

  it("after taking over, re-reads after settleMs and yields if someone else won", async () => {
    await createLibrary(root, "Mine", mkDeps());
    now += 121_000;
    const racing = mkDeps({
      deviceId: "dev-B",
      hostname: "host-B",
      pid: 200,
      settleMs: 100,
    });
    const p = acquireLock(root, racing);
    // another device overwrites the lock during the settle window
    for (let i = 0; i < 200; i++) {
      const l = JSON.parse(await readFile(join(root, ".lock"), "utf8"));
      if (l.deviceId === "dev-B") break;
      await new Promise((r) => setTimeout(r, 1));
    }
    await writeFile(
      join(root, ".lock"),
      JSON.stringify({
        deviceId: "dev-C",
        hostname: "host-C",
        pid: 5,
        openedAt: new Date(now).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
      }),
    );
    const r = await p;
    expect(r.acquired).toBe(false);
  });
});

describe("registry", () => {
  it("creates the config dir, dedupes, keeps max 5 most-recent-first", async () => {
    const deps = mkDeps();
    await registerLibrary({ libraryId: "L1", name: "One", path: "/p/0" }, deps);
    for (let i = 1; i <= 6; i++) {
      now += 1000;
      await recordLocation("L1", `/p/${i}`, deps);
    }
    now += 1000;
    await recordLocation("L1", "/p/4", deps);
    const [e] = await listLibraries(deps);
    expect(e!.lastKnownPaths).toEqual(["/p/4", "/p/6", "/p/5", "/p/3", "/p/2"]);
    expect(e!.lastOpenedAt).toBe(new Date(now).toISOString());
  });

  it("lists, registers idempotently, forgets", async () => {
    const deps = mkDeps();
    expect(await listLibraries(deps)).toEqual([]);
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a" }, deps);
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a" }, deps);
    await registerLibrary({ libraryId: "L2", name: "Two", path: "/b" }, deps);
    expect((await listLibraries(deps)).map((l) => l.libraryId).sort()).toEqual(["L1", "L2"]);
    await forgetLibrary("L1", deps);
    expect((await listLibraries(deps)).map((l) => l.libraryId)).toEqual(["L2"]);
  });

  it("create/open record the library in the registry", async () => {
    const deps = mkDeps();
    const lib = await createLibrary(root, "Mine", deps);
    await lib.close();
    const [e] = await listLibraries(deps);
    expect(e).toMatchObject({ libraryId: lib.id, name: "Mine", lastKnownPaths: [root] });
  });
});
