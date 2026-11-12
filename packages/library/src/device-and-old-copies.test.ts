/**
 * Two settings files that follow the registry's rule, not "refuse and reset" (Task 68, rulings 1
 * and 2): `device.json` (this device's identity: which device holds a library's lock) and
 * `pending-old-copies.json` (old library copies awaiting deletion). A read error other than
 * "missing" refuses and writes nothing; damaged content is kept aside as `<name>.corrupt-<stamp>`
 * and a fresh start is made; a missing file is "nothing yet".
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A passing I/O error at the seam: the next read of a file whose name ends with `failRead` fails with EIO. */
const io = vi.hoisted(() => ({ failRead: undefined as string | undefined }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (io.failRead && String(p).endsWith(io.failRead)) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
  };
});
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (io.failRead && String(p).endsWith(io.failRead)) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return (real.readFile as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

import { DeviceIdUnreadableError, deviceDeps } from "./app-settings.js";
import { deviceNoticesIdle } from "./device-notices.js";
import { OldCopiesUnreadableError, addPendingOldCopy, listPendingOldCopies, markPendingComplete, removePendingOldCopy } from "./old-copies.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-device-oldcopies-"));
  io.failRead = undefined;
});
afterEach(async () => {
  io.failRead = undefined;
  // A notice raised by a set-aside is written before the folder goes (no race with the removal).
  await deviceNoticesIdle();
  await rm(dir, { recursive: true, force: true });
});

const at = new Date("2026-11-12T10:15:30.000Z");
const cfg = (n: string) => join(dir, n);

/** Each way a file can be there and not be read at all (the content is never seen): refuse. */
const unreadable = (n: string): Array<[string, () => Promise<void>]> => [
  ["a directory in its place", () => mkdir(cfg(n))],
  ["a link that cannot be followed (stands in for no permission when the tests run as root)", () => symlink(cfg(n), cfg(n))],
  [
    "a passing I/O error",
    async () => {
      await writeFile(cfg(n), "{}");
      io.failRead = n;
    },
  ],
];
/** Each way the content can be damaged: kept aside, fresh start. */
const damaged = (good: string): Array<[string, string]> => [
  ["invalid JSON", "garbage{"],
  ["a truncated file", good.slice(0, Math.floor(good.length / 2))],
  ["the wrong shape", JSON.stringify({ something: "else" })],
];

/** What is in the settings folder (read past the simulated I/O error: the test's own look, not the app's). */
async function snapshot(): Promise<Record<string, string>> {
  const failing = io.failRead;
  io.failRead = undefined;
  const out: Record<string, string> = {};
  for (const n of (await readdir(dir)).sort()) out[n] = await readFile(cfg(n), "utf8").catch(() => "<not a file>");
  io.failRead = failing;
  return out;
}

// ---------------------------------------------------------------------------------------------

describe("device.json (ruling 2): never a new id over a file that merely could not be read", () => {
  it("missing on a fresh settings folder: a new id, remembered", async () => {
    const id = deviceDeps(dir).deviceId;
    expect(id).toMatch(/\S/);
    expect(JSON.parse(await readFile(cfg("device.json"), "utf8"))).toEqual({ deviceId: id });
    expect(deviceDeps(dir).deviceId).toBe(id);
  });

  for (const [what, make] of unreadable("device.json")) {
    it(`${what}: refused in plain words (no path); nothing is written, the id is not replaced`, async () => {
      await make();
      const before = await snapshot();
      let err: unknown;
      try {
        deviceDeps(dir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DeviceIdUnreadableError);
      expect((err as Error).message).toMatch(/this computer's identity/i);
      expect((err as Error).message).not.toContain(dir);
      io.failRead = undefined;
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const [what, content] of damaged(JSON.stringify({ deviceId: "01HZXDEVICEIDFORTESTS0000" }))) {
    it(`${what}: the damaged file is kept aside as device.json.corrupt-<stamp>, and a new id is made`, async () => {
      await writeFile(cfg("device.json"), content);
      const id = deviceDeps(dir, { now: () => at }).deviceId;
      expect(id).toMatch(/\S/);
      expect(await readFile(cfg("device.json.corrupt-20261112-101530"), "utf8")).toBe(content);
      expect(JSON.parse(await readFile(cfg("device.json"), "utf8"))).toEqual({ deviceId: id });
    });
  }

  it("two starts at once over a damaged file: one sets it aside, both end with the same new id", async () => {
    await writeFile(cfg("device.json"), "garbage{");
    const a = deviceDeps(dir, { now: () => at }).deviceId;
    const b = deviceDeps(dir, { now: () => at }).deviceId;
    expect(b).toBe(a);
    expect((await readdir(dir)).filter((n) => n.startsWith("device.json.corrupt-"))).toHaveLength(1);
  });

  it("a second damaged file in the same second does not overwrite the one kept before", async () => {
    await writeFile(cfg("device.json"), "first{");
    deviceDeps(dir, { now: () => at });
    await writeFile(cfg("device.json"), "second{");
    deviceDeps(dir, { now: () => at });
    const kept = (await readdir(dir)).filter((n) => n.startsWith("device.json.corrupt-")).sort();
    expect(kept).toHaveLength(2);
    expect(await Promise.all(kept.map((n) => readFile(cfg(n), "utf8")))).toEqual(expect.arrayContaining(["first{", "second{"]));
  });
});

// ---------------------------------------------------------------------------------------------

const deps = () => ({ appConfigDir: dir, clock: () => at });
const rec = (n: number) => ({ oldRoot: `/old/${n}`, newRoot: `/new/${n}`, libraryId: `lib${n}`, split: false, movedFolders: [], movedProjectIds: [], moveId: `m${n}` });
const hashes = { files: {}, dirs: [] };

describe("pending-old-copies.json (ruling 1): the registry's rule", () => {
  it("missing on a fresh settings folder: nothing yet, and an add works", async () => {
    expect(await listPendingOldCopies(deps())).toEqual([]);
    const r = await addPendingOldCopy(deps(), rec(1), hashes);
    await markPendingComplete(deps(), r.id);
    expect((await listPendingOldCopies(deps())).map((x) => x.id)).toEqual([r.id]);
  });

  for (const [what, make] of unreadable("pending-old-copies.json")) {
    it(`${what}: add, mark-complete and remove are refused in plain words (no path); nothing is written`, async () => {
      const r = await addPendingOldCopy(deps(), rec(1), hashes);
      if (what.startsWith("a passing")) await writeFile(cfg("pending-old-copies.json"), await readFile(cfg("pending-old-copies.json"), "utf8"));
      else await rm(cfg("pending-old-copies.json"));
      await make();
      const before = await snapshot();
      const beforeHashes = await readdir(cfg("old-copies"));
      for (const op of [() => addPendingOldCopy(deps(), rec(2), hashes), () => markPendingComplete(deps(), r.id), () => removePendingOldCopy(deps(), r.id)]) {
        const err = await op().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OldCopiesUnreadableError);
        expect((err as Error).message).toMatch(/old library copies/i);
        expect((err as Error).message).not.toContain(dir);
      }
      // Reading it is refused the same way: it is never taken for an empty list.
      await expect(listPendingOldCopies(deps())).rejects.toBeInstanceOf(OldCopiesUnreadableError);
      io.failRead = undefined;
      expect(await snapshot()).toEqual(before);
      // An add that was refused leaves no hash list behind either.
      expect(await readdir(cfg("old-copies"))).toEqual(beforeHashes);
    });
  }

  for (const [what, content] of damaged(JSON.stringify({ formatVersion: 1, records: [{ id: "x", oldRoot: "/o" }] }))) {
    it(`${what}: a change keeps the damaged list aside as pending-old-copies.json.corrupt-<stamp> and starts a fresh one`, async () => {
      await writeFile(cfg("pending-old-copies.json"), content);
      // Reading does not move anything: a damaged list reads as empty.
      expect(await listPendingOldCopies(deps())).toEqual([]);
      expect(await readFile(cfg("pending-old-copies.json"), "utf8")).toBe(content);
      const r = await addPendingOldCopy(deps(), rec(1), hashes);
      expect(await readFile(cfg("pending-old-copies.json.corrupt-20261112-101530"), "utf8")).toBe(content);
      const now = JSON.parse(await readFile(cfg("pending-old-copies.json"), "utf8")) as { records: Array<{ id: string }> };
      expect(now.records.map((x) => x.id)).toEqual([r.id]);
    });
  }

  it("a list with some unusable records: the whole list is kept aside before the usable ones are written back (nothing lost)", async () => {
    const r = await addPendingOldCopy(deps(), rec(1), hashes);
    const raw = JSON.parse(await readFile(cfg("pending-old-copies.json"), "utf8")) as { records: unknown[] };
    const content = JSON.stringify({ ...raw, records: [...raw.records, { id: 5 }] });
    await writeFile(cfg("pending-old-copies.json"), content);
    await markPendingComplete(deps(), r.id);
    expect(await readFile(cfg("pending-old-copies.json.corrupt-20261112-101530"), "utf8")).toBe(content);
    expect((await listPendingOldCopies(deps())).map((x) => x.id)).toEqual([r.id]);
  });

  it("two changes at once both land", async () => {
    const [a, b, c] = await Promise.all([addPendingOldCopy(deps(), rec(1), hashes), addPendingOldCopy(deps(), rec(2), hashes), addPendingOldCopy(deps(), rec(3), hashes)]);
    await Promise.all([markPendingComplete(deps(), a.id), markPendingComplete(deps(), b.id), markPendingComplete(deps(), c.id)]);
    expect((await listPendingOldCopies(deps())).map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});
