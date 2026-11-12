/**
 * The device-level notice (Task 68, R154, R178): each set-aside of `device.json` or
 * `pending-old-copies.json` raises exactly one notice, kept in the settings folder's `notices.json`
 * through the strict helper; a notice file that cannot be read or written never stops the
 * operation that raised it.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps } from "./app-settings.js";
import { deviceNoticesIdle, dismissDeviceNotice, raiseDeviceNotice, readDeviceNotices } from "./device-notices.js";
import { addPendingOldCopy, markPendingComplete } from "./old-copies.js";

let dir: string;
const at = new Date("2026-11-12T10:15:30.000Z");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-notices-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const cfg = (n: string) => join(dir, n);
const deps = () => ({ appConfigDir: dir, clock: () => at });
const rec = (n: number) => ({ oldRoot: `/old/${n}`, newRoot: `/new/${n}`, libraryId: `lib${n}`, split: false, movedFolders: [], movedProjectIds: [], moveId: `m${n}` });
const hashes = { files: {}, dirs: [] };

describe("raising, reading and dismissing", () => {
  it("no notice when nothing was set aside", async () => {
    deviceDeps(dir);
    await addPendingOldCopy(deps(), rec(1), hashes);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });

  it("a kind is kept once, however often it is raised; dismissing removes only that kind", async () => {
    await Promise.all([raiseDeviceNotice(dir, "device-identity-renewed", at), raiseDeviceNotice(dir, "device-identity-renewed", at), raiseDeviceNotice(dir, "old-copies-list-set-aside", at)]);
    expect((await readDeviceNotices(dir)).map((n) => n.kind).sort()).toEqual(["device-identity-renewed", "old-copies-list-set-aside"]);
    expect(await dismissDeviceNotice(dir, "device-identity-renewed")).toEqual([{ kind: "old-copies-list-set-aside", at: at.toISOString() }]);
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "old-copies-list-set-aside", at: at.toISOString() }]);
  });

  it("a notice holds a kind and a time only (no path, no id, no contents)", async () => {
    await raiseDeviceNotice(dir, "old-copies-list-set-aside", at);
    const file = JSON.parse(await readFile(cfg("notices.json"), "utf8")) as { notices: Array<Record<string, unknown>> };
    expect(file.notices).toEqual([{ kind: "old-copies-list-set-aside", at: at.toISOString() }]);
  });
});

describe("raised from the two set-asides, and only from them", () => {
  it("a damaged device.json set aside raises one notice", async () => {
    await writeFile(cfg("device.json"), "garbage{");
    deviceDeps(dir, { now: () => at });
    deviceDeps(dir, { now: () => at });
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "device-identity-renewed", at: at.toISOString() }]);
  });

  it("a damaged old-copies list set aside raises one notice, however many changes hit it", async () => {
    await writeFile(cfg("pending-old-copies.json"), "garbage{");
    const [a, b] = await Promise.all([addPendingOldCopy(deps(), rec(1), hashes), addPendingOldCopy(deps(), rec(2), hashes)]);
    await markPendingComplete(deps(), a.id);
    await markPendingComplete(deps(), b.id);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "old-copies-list-set-aside", at: at.toISOString() }]);
  });

  it("a list that merely cannot be read (refused) raises nothing", async () => {
    await mkdir(cfg("pending-old-copies.json"));
    await expect(addPendingOldCopy(deps(), rec(1), hashes)).rejects.toThrow();
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });
});

describe("the notices file itself cannot be read or written", () => {
  it("the set-aside still completes, nothing is thrown, and a plain line without a path is logged", async () => {
    await mkdir(cfg("notices.json"));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeFile(cfg("pending-old-copies.json"), "garbage{");
    const r = await addPendingOldCopy(deps(), rec(1), hashes);
    expect(r.id).toMatch(/\S/);
    await writeFile(cfg("device.json"), "garbage{");
    expect(deviceDeps(dir, { now: () => at }).deviceId).toMatch(/\S/);
    await deviceNoticesIdle();
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => /notice/i.test(l))).toHaveLength(2);
    for (const l of lines) expect(l).not.toContain(dir);
    expect(lines.join("")).toMatch(/old library copies/);
    expect(lines.join("")).toMatch(/identity/);
  });

  it("reading an unreadable notices file refuses (it is never taken for empty and written over)", async () => {
    await writeFile(cfg("notices.json"), "garbage{");
    await expect(readDeviceNotices(dir)).rejects.toThrow();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await raiseDeviceNotice(dir, "device-identity-renewed", at);
    expect(await readFile(cfg("notices.json"), "utf8")).toBe("garbage{");
  });
});
