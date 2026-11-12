import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlreadyALibraryError,
  CorruptLibraryError,
  FolderNotEmptyError,
  LibraryNotWritableError,
  NotALibraryError,
  createLibrary,
  forgetLastOpenLibrary,
  forgetLibrary,
  lastOpenLibrary,
  listLibraries,
  rememberLastOpenLibrary,
  openLibrary,
  recordLocation,
  registerLibrary,
  type Deps,
} from "./index.js";
import { acquireLock } from "./lock.js";

vi.mock("./fs/atomic.js", async (orig) => {
  const actual = await orig<typeof import("./fs/atomic.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});
import * as atomic from "./fs/atomic.js";
const realWrite = (await vi.importActual<typeof import("./fs/atomic.js")>("./fs/atomic.js")).writeFileAtomic;
/** Makes writeFileAtomic fail with `code` for paths ending in `suffix`. */
function failWrites(suffix: string, code: string) {
  vi.mocked(atomic.writeFileAtomic).mockImplementation(async (p, d) => {
    if (String(p).endsWith(suffix)) throw Object.assign(new Error(code), { code });
    return realWrite(p, d);
  });
}
const tick = (i: number) => (timers[i]!.fn as unknown as () => Promise<void>)();

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
  vi.mocked(atomic.writeFileAtomic).mockImplementation(realWrite);
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
    await tick(0);
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

  it("D5: remembers the last open library by id only, in the app settings folder; forgets it on request", async () => {
    const deps = mkDeps();
    expect(await lastOpenLibrary(deps)).toBeUndefined();
    await rememberLastOpenLibrary("L1", deps);
    expect(await lastOpenLibrary(deps)).toBe("L1");
    await rememberLastOpenLibrary("L2", deps);
    expect(await lastOpenLibrary(deps)).toBe("L2");
    // Only the id: where the library is comes from the registry, nothing about it from the library.
    const raw = await readFile(join(deps.appConfigDir, "last-library.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ libraryId: "L2" });
    await forgetLastOpenLibrary(deps);
    expect(await lastOpenLibrary(deps)).toBeUndefined();
    await forgetLastOpenLibrary(deps); // nothing to forget: no error
    // A damaged file means nothing to reopen, never an error.
    await writeFile(join(deps.appConfigDir, "last-library.json"), "{ torn");
    expect(await lastOpenLibrary(deps)).toBeUndefined();
    await writeFile(join(deps.appConfigDir, "last-library.json"), JSON.stringify({ libraryId: 7 }));
    expect(await lastOpenLibrary(deps)).toBeUndefined();
  });

  it("create/open record the library in the registry", async () => {
    const deps = mkDeps();
    const lib = await createLibrary(root, "Mine", deps);
    await lib.close();
    const [e] = await listLibraries(deps);
    expect(e).toMatchObject({ libraryId: lib.id, name: "Mine", lastKnownPaths: [root] });
  });
});

describe("fix round 1", () => {
  it("heartbeat demotes the handle when another device took the lock, without clobbering", async () => {
    const lost: unknown[] = [];
    const a = await createLibrary(root, "Mine", mkDeps(), { onLockLost: (h) => lost.push(h) });
    now += 121_000; // A stopped heartbeating (e.g. laptop asleep)
    await openLibrary(root, depsB());
    now += 30_000;
    await tick(0);
    expect(a.mode).toBe("read-only");
    expect(a.readOnlyReason).toBe("locked-by-other-device");
    expect(lost).toHaveLength(1);
    expect((lost[0] as { deviceId: string }).deviceId).toBe("dev-B");
    expect(timers[0]!.cleared).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".lock"), "utf8")).deviceId).toBe("dev-B");
    await a.close();
    expect(JSON.parse(await readFile(join(root, ".lock"), "utf8")).deviceId).toBe("dev-B");
  });

  it("heartbeat that cannot write for more than 120 s demotes with holder null", async () => {
    const lost: unknown[] = [];
    const a = await createLibrary(root, "Mine", mkDeps(), { onLockLost: (h) => lost.push(h) });
    failWrites(".lock", "EIO");
    for (let i = 0; i < 5; i++) {
      now += 30_000;
      await tick(0);
    }
    expect(lost).toEqual([null]);
    expect(a.mode).toBe("read-only");
    expect(a.readOnlyReason).toBe("locked-by-other-device");
  });

  it("releases the lock and stops the heartbeat when open fails after acquiring it", async () => {
    await (await createLibrary(root, "Mine", mkDeps())).close();
    const before = timers.length;
    failWrites("library.json", "EIO");
    await expect(openLibrary(root, mkDeps({ hostname: "host-Z" }))).rejects.toThrow();
    await expect(stat(join(root, ".lock"))).rejects.toThrow();
    expect(timers.length).toBe(before + 1);
    expect(timers[before]!.cleared).toBe(true);
    vi.mocked(atomic.writeFileAtomic).mockImplementation(realWrite);
    expect((await openLibrary(root, mkDeps())).mode).toBe("read-write");
  });

  it("opens read-only with not-writable when the lock cannot be written; writes nothing", async () => {
    await (await createLibrary(root, "Mine", mkDeps())).close();
    const before = await snapshot(root);
    failWrites(".lock", "EROFS");
    const lib = await openLibrary(root, mkDeps());
    expect(lib.mode).toBe("read-only");
    expect(lib.readOnlyReason).toBe("not-writable");
    expect(await snapshot(root)).toEqual(before);
  });

  it("createLibrary throws LibraryNotWritableError on a non-writable root", async () => {
    failWrites("library.json", "EACCES");
    await expect(createLibrary(root, "X", mkDeps())).rejects.toBeInstanceOf(LibraryNotWritableError);
  });

  it("a second open of the same root in this process is read-only", async () => {
    const a = await createLibrary(root, "Mine", mkDeps());
    const b = await openLibrary(root, mkDeps());
    expect(b.mode).toBe("read-only");
    expect(b.readOnlyReason).toBe("locked-by-other-device");
    await b.close();
    await a.close();
    expect((await openLibrary(root, mkDeps())).mode).toBe("read-write");
  });

  it("retries once when the lock vanishes during the settle window", async () => {
    await createLibrary(root, "Mine", mkDeps());
    now += 121_000;
    const p = acquireLock(root, { ...depsB(), settleMs: 100 });
    for (let i = 0; i < 200; i++) {
      const l = JSON.parse(await readFile(join(root, ".lock"), "utf8"));
      if (l.deviceId === "dev-B") break;
      await new Promise((r) => setTimeout(r, 1));
    }
    await rm(join(root, ".lock"));
    expect((await p).acquired).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".lock"), "utf8")).deviceId).toBe("dev-B");
  });

  it("registry: unparseable file is kept as .corrupt-<stamp> and replaced", async () => {
    const deps = mkDeps();
    await mkdir(deps.appConfigDir, { recursive: true });
    await writeFile(join(deps.appConfigDir, "libraries.json"), "{broken");
    expect(await listLibraries(deps)).toEqual([]);
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a" }, deps);
    const names = await readdir(deps.appConfigDir);
    expect(names).toContain("libraries.json.corrupt-20261109-100000");
    expect(await readFile(join(deps.appConfigDir, "libraries.json.corrupt-20261109-100000"), "utf8")).toBe("{broken");
    expect((await listLibraries(deps)).map((l) => l.libraryId)).toEqual(["L1"]);
  });

  it("registry: malformed entries are dropped, valid ones kept, never throws", async () => {
    const deps = mkDeps();
    await mkdir(deps.appConfigDir, { recursive: true });
    const good = { libraryId: "G", name: "Good", lastKnownPaths: ["/g"], lastOpenedAt: "2026-01-01T00:00:00.000Z" };
    await writeFile(join(deps.appConfigDir, "libraries.json"), JSON.stringify([good, { libraryId: 3 }, null]));
    expect(await listLibraries(deps)).toEqual([good]);
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a" }, deps);
    expect((await readdir(deps.appConfigDir)).some((n) => n.includes(".corrupt-"))).toBe(true);
    expect((await listLibraries(deps)).map((l) => l.libraryId).sort()).toEqual(["G", "L1"]);
    await writeFile(join(deps.appConfigDir, "libraries.json"), '{"not":"array"}');
    expect(await listLibraries(deps)).toEqual([]);
  });

  it("listLibraries returns the most recently opened first", async () => {
    const deps = mkDeps();
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a" }, deps);
    now += 1000;
    await registerLibrary({ libraryId: "L2", name: "Two", path: "/b" }, deps);
    expect((await listLibraries(deps)).map((l) => l.libraryId)).toEqual(["L2", "L1"]);
    now += 1000;
    await recordLocation("L1", "/c", deps);
    expect((await listLibraries(deps)).map((l) => l.libraryId)).toEqual(["L1", "L2"]);
  });
});

describe("lock holder's device name (R118 c)", () => {
  it("a read-only handle names the device holding the lock; a writable one names none", async () => {
    const a = await createLibrary(root, "Mine", mkDeps());
    expect(a.lockedBy).toBeUndefined();
    const b = await openLibrary(root, depsB());
    expect(b.readOnlyReason).toBe("locked-by-other-device");
    expect(b.lockedBy).toBe("host-A");
    await b.close();
    await a.close();
  });

  it("a handle demoted by another device taking the lock names that device; holder unknown → none", async () => {
    const a = await createLibrary(root, "Mine", mkDeps());
    now += 121_000;
    await openLibrary(root, depsB());
    now += 30_000;
    await tick(0);
    expect(a.lockedBy).toBe("host-B");
    await a.close();
    const c = await createLibrary(join(root, "..", `other-${now}`), "Other", mkDeps());
    failWrites(".lock", "EIO");
    for (let i = 0; i < 5; i++) {
      now += 30_000;
      for (let t = 0; t < timers.length; t++) if (!timers[t]!.cleared) await tick(t);
    }
    expect(c.readOnlyReason).toBe("locked-by-other-device");
    expect(c.lockedBy).toBeUndefined();
  });

  it("a hostname with control characters or of absurd length is not passed on", async () => {
    const a = await createLibrary(root, "Mine", mkDeps({ hostname: "evil\u0007host" }));
    expect((await openLibrary(root, depsB())).lockedBy).toBeUndefined();
    await a.close();
    const z = await createLibrary(join(root, "..", `long-${now}`), "Long", mkDeps({ hostname: "h".repeat(300) }));
    expect((await openLibrary(z.root, depsB())).lockedBy).toBeUndefined();
    await z.close();
    // 41a M6: a lone surrogate is not a usable name either.
    const s = await createLibrary(join(root, "..", `surrogate-${now}`), "Surrogate", mkDeps({ hostname: "host\ud800" }));
    expect((await openLibrary(s.root, depsB())).lockedBy).toBeUndefined();
    await s.close();
  });
});
