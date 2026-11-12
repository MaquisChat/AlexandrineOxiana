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

import { deviceNoticesIdle, readDeviceNotices } from "./device-notices.js";
import { listLibraries, registerLibrary } from "./registry.js";

let dir: string;
const at = new Date("2026-11-12T10:15:30.000Z");
const deps = () => ({ appConfigDir: dir, clock: () => at });

beforeEach(async () => {
  io.failRename = false;
  dir = await mkdtemp(join(tmpdir(), "ao-registry-notice-"));
});
afterEach(async () => {
  io.failRename = false;
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

  it("a list that is fine, or missing: no notice", async () => {
    await registerLibrary({ libraryId: "L1", name: "One", path: "/a/One" }, deps());
    await registerLibrary({ libraryId: "L2", name: "Two", path: "/a/Two" }, deps());
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });
});
