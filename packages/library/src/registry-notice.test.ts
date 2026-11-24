/**
 * A damaged libraries list set aside is never silent (Task 68 fix round 2, RI1; R181 a): the fifth
 * device-level notice kind is raised once the rename has succeeded, and never when it failed.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const rename = (async (from: unknown, to: unknown) => {
    if (io.failRename && String(from).endsWith("libraries.json")) throw Object.assign(new Error("EBUSY: resource busy, rename"), { code: "EBUSY" });
    return real.rename(from as string, to as string);
  }) as typeof real.rename;
  return { ...real, default: { ...real, rename }, rename };
});

/** Runs inside a writer's turn, between its setting a damaged list aside and its save (R473 M3). */
const window = vi.hoisted(() => ({ during: undefined as undefined | (() => Promise<void> | void) }));
vi.mock("./device-notices.js", async (orig) => {
  const real = await orig<typeof import("./device-notices.js")>();
  return {
    ...real,
    raiseDeviceNotice: async (...a: Parameters<typeof real.raiseDeviceNotice>) => {
      await window.during?.();
      return real.raiseDeviceNotice(...a);
    },
  };
});

import { deviceNoticesIdle, readDeviceNotices } from "./device-notices.js";
import { listLibraries, registerLibrary, settleDamagedRegistry } from "./registry.js";

let dir: string;
const at = new Date("2026-11-12T10:15:30.000Z");
const deps = () => ({ appConfigDir: dir, clock: () => at });

beforeEach(async () => {
  io.failRename = false;
  dir = await mkdtemp(join(tmpdir(), "ao-registry-notice-"));
});
afterEach(async () => {
  io.failRename = false;
  window.during = undefined;
  await deviceNoticesIdle();
  await rm(dir, { recursive: true, force: true });
});

describe("libraries.json set aside (R181 a)", () => {
  it("a damaged list is kept aside and the notice is there once, however many writes follow", async () => {
    await writeFile(join(dir, "libraries.json"), "{broken");
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps());
    await registerLibrary({ libraryId: "L2", name: "Two", path: "/a/Two" }, deps());
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "libraries-list-set-aside", at: at.toISOString() }]);
    expect((await readdir(dir)).filter((n) => n.startsWith("libraries.json.corrupt-"))).toHaveLength(1);
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["L1", "L2"]);
  });

  it("a failed rename: no notice, and nothing written over the damaged list", async () => {
    await writeFile(join(dir, "libraries.json"), "{broken");
    io.failRename = true;
    await expect(registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps())).rejects.toThrow();
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
    expect(await readFile(join(dir, "libraries.json"), "utf8")).toBe("{broken");
  });

  it("FR-411: the chooser setting a damaged list aside while a library is opened or created: both succeed, one copy set aside", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([{ libraryId: "L0", name: "Zero", lastKnownPaths: ["/a/Zero"], lastOpenedAt: "2026-01-01T00:00:00Z" }, 7]));
    await Promise.all([
      settleDamagedRegistry(deps()),
      registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps()),
      settleDamagedRegistry(deps()),
      registerLibrary({ libraryId: "L2", name: "Two", path: "/a/Two" }, deps()),
    ]);
    await deviceNoticesIdle();
    expect((await readdir(dir)).filter((n) => n.startsWith("libraries.json.corrupt-"))).toHaveLength(1);
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "libraries-list-set-aside", at: at.toISOString() }]);
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["L0", "L1", "L2"]);
  });

  it("R473 M3: a read made while a writer has set the damaged list aside waits for that writer's turn and sees what it saved", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([{ libraryId: "L0", name: "Zero", lastKnownPaths: ["/a/Zero"], lastOpenedAt: "2026-01-01T00:00:00Z" }, 7]));
    const order: string[] = [];
    let read: Promise<string[]> | undefined;
    window.during = () => {
      window.during = undefined;
      read = listLibraries(deps()).then((list) => {
        order.push("read");
        return list.map((e) => e.libraryId).sort();
      });
    };
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps()).then(() => order.push("saved"));
    expect(await read).toEqual(["L0", "L1"]);
    expect(order).toEqual(["saved", "read"]);
  });

  it("R473 M3: a change saved by another writer (another process) while this one set the damaged list aside is not lost", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([{ libraryId: "L0", name: "Zero", lastKnownPaths: ["/a/Zero"], lastOpenedAt: "2026-01-01T00:00:00Z" }, 7]));
    window.during = async () => {
      window.during = undefined;
      // What the command line, a second process, saves in the meantime (not through this process's turn).
      await writeFile(join(dir, "libraries.json"), JSON.stringify([{ libraryId: "L9", name: "Nine", lastKnownPaths: ["/a/Nine"], lastOpenedAt: "2026-02-01T00:00:00Z" }]));
    };
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps());
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["L0", "L1", "L9"]);
  });

  it("R484 l: a second damaged list set aside in the same second (another process wrote it meanwhile) does not overwrite the first", async () => {
    const firstDamaged = JSON.stringify([{ libraryId: "L0", name: "Zero", lastKnownPaths: ["/a/Zero"], lastOpenedAt: "2026-01-01T00:00:00Z" }, 7]);
    await writeFile(join(dir, "libraries.json"), firstDamaged);
    window.during = async () => {
      window.during = undefined;
      await writeFile(join(dir, "libraries.json"), "{damaged by another process");
    };
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps());
    const setAside = (await readdir(dir)).filter((n) => n.startsWith("libraries.json.corrupt-")).sort();
    expect(setAside).toHaveLength(2);
    expect((await Promise.all(setAside.map((n) => readFile(join(dir, n), "utf8")))).sort()).toEqual([firstDamaged, "{damaged by another process"].sort());
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["L0", "L1"]);
  });

  it("a list that is fine, or missing: no notice", async () => {
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps());
    await registerLibrary({ libraryId: "L2", name: "Two", path: "/a/Two" }, deps());
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });
});
