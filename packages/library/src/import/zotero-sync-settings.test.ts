/**
 * Task Z7: the two device files of the Zotero sync — settings (`zotero-sync.json`) and history
 * (`zotero-sync-history.json`). Strict reads, set-aside of damaged content, 0600, atomic, nothing of a library's
 * content, the newest 200 runs per library, and the pauses with what clears each.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { deviceNoticesIdle, dismissDeviceNotice, readDeviceNotices } from "../device-notices.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZOTERO_SYNC_FILE,
  ZOTERO_SYNC_HISTORY_FILE,
  ZoteroSyncFileNewerError,
  ZoteroSyncFileUnreadableError,
  markZoteroSyncFullDone,
  pauseAllZoteroSyncLinks,
  pauseLink,
  putZoteroSyncRun,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  runningZoteroSyncRuns,
  setZoteroSyncUnfinished,
  updateZoteroSyncSettings,
  writeZoteroSyncSettings,
  type ZoteroSyncLink,
  type ZoteroSyncRun,
  type ZoteroSyncSettings,
} from "./zotero-sync-settings.js";

const asRoot = process.getuid?.() === 0;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-zsync-settings-"));
});
afterEach(async () => {
  runningZoteroSyncRuns.clear();
  await rm(dir, { recursive: true, force: true });
});

const LIB = "lib-1";
const link = (ref: string, projectId = "p1", extra: Partial<ZoteroSyncLink> = {}): ZoteroSyncLink => ({
  ref,
  projectId,
  fullDone: false,
  options: { structure: "collections", duplicates: "merge" },
  ...extra,
});
const settings = (links: ZoteroSyncLink[], extra: Partial<ZoteroSyncSettings> = {}): ZoteroSyncSettings => ({ automatic: true, everyMinutes: 60, links, ...extra });
const runRec = (n: number, extra: Partial<ZoteroSyncRun> = {}): ZoteroSyncRun => ({
  id: `run-${String(n).padStart(4, "0")}`,
  ref: "user:42",
  projectId: "p1",
  trigger: "automatic",
  startedAt: new Date(Date.UTC(2027, 2, 12, 14, 32) + n * 60_000).toISOString(),
  finishedAt: new Date(Date.UTC(2027, 2, 12, 14, 33) + n * 60_000).toISOString(),
  outcome: "up-to-date",
  ...extra,
});

describe("settings file", () => {
  it("defaults: automatic off, every hour, nothing linked", async () => {
    expect(await readZoteroSyncSettings(dir, LIB)).toEqual({ automatic: false, everyMinutes: 60, links: [] });
  });

  it("writes one library's settings, keeps another's, 0600 and atomically, and reads them back", async () => {
    await writeZoteroSyncSettings(dir, "other", settings([link("user:7", "q")]));
    const s = settings([link("user:42"), link("group:9", "p2", { options: { structure: "tags", duplicates: "skip" } })], { everyMinutes: 240 });
    await writeZoteroSyncSettings(dir, LIB, s);
    expect(await readZoteroSyncSettings(dir, LIB)).toEqual(s);
    expect((await readZoteroSyncSettings(dir, "other")).links[0]!.ref).toBe("user:7");
    expect((await stat(join(dir, ZOTERO_SYNC_FILE))).mode & 0o777).toBe(0o600);
    // No temporary file is left beside it.
    expect((await readdir(dir)).filter((n) => n.startsWith(ZOTERO_SYNC_FILE))).toEqual([ZOTERO_SYNC_FILE]);
    expect(JSON.parse(await readFile(join(dir, ZOTERO_SYNC_FILE), "utf8"))).toEqual({ v: 1, libraries: { other: expect.any(Object), [LIB]: s } });
  });

  it("refuses a 15-minute interval, more than 20 links, two links with one ref and a bad ref, writing nothing", async () => {
    await expect(writeZoteroSyncSettings(dir, LIB, settings([], { everyMinutes: 15 as 30 }))).rejects.toThrow(/everyMinutes/);
    const many = Array.from({ length: 21 }, (_, i) => link(`group:${i + 1}`));
    await expect(writeZoteroSyncSettings(dir, LIB, settings(many))).rejects.toThrow(/at most 20/);
    await expect(writeZoteroSyncSettings(dir, LIB, settings([link("user:1"), link("user:1", "p2")]))).rejects.toThrow(/one project only/);
    await expect(writeZoteroSyncSettings(dir, LIB, settings([link("users/1")]))).rejects.toThrow(/links/);
    await expect(writeZoteroSyncSettings(dir, LIB, settings([{ ...link("user:1"), title: "x" } as ZoteroSyncLink]))).rejects.toThrow(/links/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("a damaged settings file is set aside and sync stays off", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await writeFile(join(dir, ZOTERO_SYNC_FILE), '{"v":1,"libraries":{"lib-1":{"automatic":true,"everyMinutes":60,"links":[{"ref":"user:42"'); // cut short
    const told: Array<[string, string]> = [];
    const s = await readZoteroSyncSettings(dir, LIB, { onSetAside: (f, k) => told.push([f, k]) });
    // Automatic sync is off, for every library, until the researcher sets it up again.
    expect(s).toEqual({ automatic: false, everyMinutes: 60, links: [] });
    expect(await readZoteroSyncSettings(dir, "other")).toEqual({ automatic: false, everyMinutes: 60, links: [] });
    expect(told).toHaveLength(1);
    expect(told[0]![0]).toBe(ZOTERO_SYNC_FILE);
    const names = await readdir(dir);
    expect(names).toContain(told[0]![1]);
    expect(told[0]![1]).toMatch(/^zotero-sync\.json\.unreadable-\d{8}-\d{6}$/);
    expect(names).not.toContain(ZOTERO_SYNC_FILE); // kept aside, never deleted; the next write starts afresh
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    expect((await readZoteroSyncSettings(dir, LIB)).automatic).toBe(true);
  });

  it("R242: a damaged settings file raises the device notice, once; a damaged history file raises none", async () => {
    await writeFile(join(dir, ZOTERO_SYNC_FILE), "not json");
    await readZoteroSyncSettings(dir, LIB);
    await writeFile(join(dir, ZOTERO_SYNC_FILE), "[]");
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([{ kind: "zotero-sync-settings-set-aside", at: expect.any(String) }]);
    await dismissDeviceNotice(dir, "zotero-sync-settings-set-aside");
    await writeFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), "not json");
    expect(await readZoteroSyncHistory(dir, LIB)).toEqual([]);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });

  it("R242: a settings file that merely cannot be read raises no notice", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await rm(join(dir, ZOTERO_SYNC_FILE));
    await mkdir(join(dir, ZOTERO_SYNC_FILE)); // a folder in its place: not readable, not damaged content
    await expect(readZoteroSyncSettings(dir, LIB)).rejects.toBeInstanceOf(ZoteroSyncFileUnreadableError);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });

  it("content of the wrong shape (an unknown field, a bad pause) is damaged too", async () => {
    for (const bad of [
      { v: 1, libraries: { [LIB]: { ...settings([link("user:42")]), title: "My library" } } },
      { v: 1, libraries: { [LIB]: settings([{ ...link("user:42"), paused: "sleeping" } as unknown as ZoteroSyncLink]) } },
      // (`{ v: 2 }` is a newer version's file since R244 M7: left as it is, see below.)
      [],
    ]) {
      await writeFile(join(dir, ZOTERO_SYNC_FILE), JSON.stringify(bad));
      expect(await readZoteroSyncSettings(dir, LIB)).toEqual({ automatic: false, everyMinutes: 60, links: [] });
      expect(await readdir(dir)).not.toContain(ZOTERO_SYNC_FILE);
    }
  });

  it.skipIf(asRoot)("a file there but unreadable is refused and not set aside", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await chmod(join(dir, ZOTERO_SYNC_FILE), 0o000);
    await expect(readZoteroSyncSettings(dir, LIB)).rejects.toBeInstanceOf(ZoteroSyncFileUnreadableError);
    await expect(writeZoteroSyncSettings(dir, LIB, settings([]))).rejects.toBeInstanceOf(ZoteroSyncFileUnreadableError);
    expect(await readdir(dir)).toEqual([ZOTERO_SYNC_FILE]);
    await chmod(join(dir, ZOTERO_SYNC_FILE), 0o600);
  });
});

describe("pauses, and what clears each", () => {
  it("key-refused pauses every link of the library; a settings write without `paused` clears it", async () => {
    await writeZoteroSyncSettings(dir, "other", settings([link("user:7", "q")]));
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42"), link("group:9", "p2")]));
    await pauseAllZoteroSyncLinks(dir, LIB);
    expect((await readZoteroSyncSettings(dir, LIB)).links.map((l) => l.paused)).toEqual(["key-refused", "key-refused"]);
    expect((await readZoteroSyncSettings(dir, "other")).links[0]!.paused).toBeUndefined();
    // Cleared only by writing the settings again with the link un-paused (Z8, after the key check).
    const s = await readZoteroSyncSettings(dir, LIB);
    await writeZoteroSyncSettings(dir, LIB, { ...s, links: s.links.map(({ paused: _p, ...l }) => l) });
    expect((await readZoteroSyncSettings(dir, LIB)).links.map((l) => l.paused)).toEqual([undefined, undefined]);
  });

  it("library-gone and undone pause only their link; fullDone is kept by a pause", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42", "p1", { fullDone: true }), link("group:9", "p2")]));
    await pauseLink(dir, LIB, "group:9", "library-gone");
    let s = await readZoteroSyncSettings(dir, LIB);
    expect(s.links.map((l) => l.paused)).toEqual([undefined, "library-gone"]);
    await pauseLink(dir, LIB, "user:42", "undone");
    s = await readZoteroSyncSettings(dir, LIB);
    expect(s.links[0]).toEqual({ ...link("user:42", "p1", { fullDone: true }), paused: "undone" });
    await writeZoteroSyncSettings(dir, LIB, { ...s, links: [link("user:42", "p1", { fullDone: true }), s.links[1]!] });
    s = await readZoteroSyncSettings(dir, LIB);
    expect(s.links.map((l) => l.paused)).toEqual([undefined, "library-gone"]);
  });

  it("markZoteroSyncFullDone sets it only for the link of that ref and project", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42"), link("group:9", "p2")]));
    await markZoteroSyncFullDone(dir, LIB, "user:42", "other-project");
    expect((await readZoteroSyncSettings(dir, LIB)).links.map((l) => l.fullDone)).toEqual([false, false]);
    await markZoteroSyncFullDone(dir, LIB, "user:42", "p1");
    expect((await readZoteroSyncSettings(dir, LIB)).links.map((l) => l.fullDone)).toEqual([true, false]);
  });

  it("a pause of a library with no settings writes nothing of its own", async () => {
    await pauseLink(dir, LIB, "user:42", "undone");
    expect(await readZoteroSyncSettings(dir, LIB)).toEqual({ automatic: false, everyMinutes: 60, links: [] });
  });
});

describe("history file", () => {
  it("history keeps the newest 200", async () => {
    for (let n = 1; n <= 205; n++) await putZoteroSyncRun(dir, LIB, runRec(n));
    const h = await readZoteroSyncHistory(dir, LIB);
    expect(h).toHaveLength(200);
    expect(h[0]!.id).toBe("run-0205"); // newest first
    expect(h.at(-1)!.id).toBe("run-0006");
    expect((await stat(join(dir, ZOTERO_SYNC_HISTORY_FILE))).mode & 0o777).toBe(0o600);
  });

  it("a record is replaced in place by its id; libraries are kept apart", async () => {
    await putZoteroSyncRun(dir, LIB, runRec(1));
    await putZoteroSyncRun(dir, LIB, runRec(2, { finishedAt: undefined, outcome: "stopped", reason: "app-closed" }));
    await putZoteroSyncRun(dir, LIB, runRec(3));
    await putZoteroSyncRun(dir, LIB, runRec(2, { outcome: "finished", batchId: "b2", counts: { new: 1, changed: 0, unchanged: 0, waiting: 0, conflicts: 0, goneMarked: 0, failed: 0, back: 0, clearedKept: 0 } }));
    await putZoteroSyncRun(dir, "other", runRec(9));
    expect((await readZoteroSyncHistory(dir, LIB)).map((r) => [r.id, r.outcome])).toEqual([
      ["run-0003", "up-to-date"],
      ["run-0002", "finished"],
      ["run-0001", "up-to-date"],
    ]);
    expect((await readZoteroSyncHistory(dir, "other")).map((r) => r.id)).toEqual(["run-0009"]);
  });

  it("a started record without an end becomes stopped/app-closed when next read (unless it runs in this process)", async () => {
    const started = runRec(1, { finishedAt: undefined, outcome: "finished" });
    await putZoteroSyncRun(dir, LIB, started);
    runningZoteroSyncRuns.add(started.id);
    expect((await readZoteroSyncHistory(dir, LIB))[0]).toEqual(started);
    runningZoteroSyncRuns.delete(started.id);
    const [r] = await readZoteroSyncHistory(dir, LIB);
    expect(r).toMatchObject({ id: started.id, outcome: "stopped", reason: "app-closed" });
    expect(r!.finishedAt).toBeUndefined();
    // And the next write makes it so on disk.
    await putZoteroSyncRun(dir, LIB, runRec(2));
    const onDisk = JSON.parse(await readFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), "utf8")) as { libraries: Record<string, ZoteroSyncRun[]> };
    expect(onDisk.libraries[LIB]!.find((x) => x.id === started.id)).toMatchObject({ outcome: "stopped", reason: "app-closed" });
  });

  it("a damaged history file is set aside and history starts empty", async () => {
    await putZoteroSyncRun(dir, LIB, runRec(1));
    await writeFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), JSON.stringify({ v: 1, libraries: { [LIB]: [{ ...runRec(1), title: "Informal markets" }] } }));
    const told: string[] = [];
    expect(await readZoteroSyncHistory(dir, LIB, { onSetAside: (f) => told.push(f) })).toEqual([]);
    expect(told).toEqual([ZOTERO_SYNC_HISTORY_FILE]);
    await putZoteroSyncRun(dir, LIB, runRec(2));
    expect((await readZoteroSyncHistory(dir, LIB)).map((r) => r.id)).toEqual(["run-0002"]);
    // A damaged file met by a write is set aside first too.
    await writeFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), "not json");
    await putZoteroSyncRun(dir, LIB, runRec(3));
    expect((await readZoteroSyncHistory(dir, LIB)).map((r) => r.id)).toEqual(["run-0003"]);
    expect((await readdir(dir)).filter((n) => n.startsWith(`${ZOTERO_SYNC_HISTORY_FILE}.unreadable-`))).toHaveLength(2);
  });

  it("refuses a record that could carry content: a path in a refused host, more than 5 hosts, a title field", async () => {
    await expect(putZoteroSyncRun(dir, LIB, runRec(1, { refusedHosts: ["evil.example/zoterofilestorage/abc?sig=1"] }))).rejects.toThrow(TypeError);
    await expect(putZoteroSyncRun(dir, LIB, runRec(1, { refusedHosts: ["a.x", "b.x", "c.x", "d.x", "e.x", "f.x"] }))).rejects.toThrow(TypeError);
    await expect(putZoteroSyncRun(dir, LIB, { ...runRec(1), title: "x" } as ZoteroSyncRun)).rejects.toThrow(TypeError);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("fix round 1 (R244)", () => {
  it("M7: a settings file from a newer version is left exactly as it is: not read, not set aside, writes refused, a notice", async () => {
    const newer = JSON.stringify({ v: 2, libraries: { [LIB]: { automatic: true, everyMinutes: 60, links: [], somethingNew: 1 } } });
    await writeFile(join(dir, ZOTERO_SYNC_FILE), newer);
    const told: string[] = [];
    expect(await readZoteroSyncSettings(dir, LIB, { onSetAside: (f) => told.push(f) })).toEqual({ automatic: false, everyMinutes: 60, links: [] });
    await expect(writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]))).rejects.toThrow(
      "These sync settings were written by a newer version of the app. Update the app to change them.",
    );
    await expect(pauseLink(dir, LIB, "user:42", "undone")).rejects.toBeInstanceOf(ZoteroSyncFileNewerError);
    expect(await readFile(join(dir, ZOTERO_SYNC_FILE), "utf8")).toBe(newer);
    expect(told).toEqual([]);
    expect((await readdir(dir)).filter((n) => n.includes(".unreadable-"))).toEqual([]);
    await deviceNoticesIdle();
    expect((await readDeviceNotices(dir)).map((n) => n.kind)).toEqual(["zotero-sync-settings-newer"]);
  });

  it("M7: a history file from a newer version is left as it is: read as empty, writes refused, no notice", async () => {
    const newer = JSON.stringify({ v: 3, libraries: {} });
    await writeFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), newer);
    expect(await readZoteroSyncHistory(dir, LIB)).toEqual([]);
    await expect(putZoteroSyncRun(dir, LIB, runRec(1))).rejects.toBeInstanceOf(ZoteroSyncFileNewerError);
    expect(await readFile(join(dir, ZOTERO_SYNC_HISTORY_FILE), "utf8")).toBe(newer);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(dir)).toEqual([]);
  });

  it("M7: only a file truly damaged is set aside (v 1 of the wrong shape, v 0, v not a number)", async () => {
    for (const bad of [{ v: 1, libraries: [] }, { v: 0, libraries: {} }, { v: "2", libraries: {} }]) {
      await writeFile(join(dir, ZOTERO_SYNC_FILE), JSON.stringify(bad));
      await readZoteroSyncSettings(dir, LIB);
      expect(await readdir(dir)).not.toContain(ZOTERO_SYNC_FILE);
    }
  });

  it("M6: a settings update and the runner's changes made at once lose nothing", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await Promise.all([
      updateZoteroSyncSettings(dir, LIB, (cur) => ({ ...cur, everyMinutes: 240, links: [...cur.links, link("group:9", "p2")] })),
      pauseLink(dir, LIB, "user:42", "library-gone"),
      markZoteroSyncFullDone(dir, LIB, "user:42", "p1"),
      updateZoteroSyncSettings(dir, LIB, (cur) => ({ ...cur, automatic: false })),
    ]);
    const s = await readZoteroSyncSettings(dir, LIB);
    expect(s.everyMinutes).toBe(240);
    expect(s.automatic).toBe(false);
    expect(s.links.map((l) => [l.ref, l.paused, l.fullDone])).toEqual([
      ["user:42", "library-gone", true],
      ["group:9", undefined, false],
    ]);
  });

  it("M6: history writes made at once are all kept", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => putZoteroSyncRun(dir, LIB, runRec(i + 1))));
    expect(await readZoteroSyncHistory(dir, LIB)).toHaveLength(25);
  });

  it("M9: the runner's hint of its unfinished batch is kept by a settings write, and cannot be set by one", async () => {
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42")]));
    await setZoteroSyncUnfinished(dir, LIB, "user:42", "p1", "batch-0003/b-3");
    expect((await readZoteroSyncSettings(dir, LIB)).links[0]!.unfinished).toBe("batch-0003/b-3");
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42", "p1", { unfinished: "batch-0009/forged" })], { everyMinutes: 30 }));
    expect((await readZoteroSyncSettings(dir, LIB)).links[0]!.unfinished).toBe("batch-0003/b-3");
    // A link given to another project starts without one.
    await writeZoteroSyncSettings(dir, LIB, settings([link("user:42", "p2")]));
    expect((await readZoteroSyncSettings(dir, LIB)).links[0]!.unfinished).toBeUndefined();
    await setZoteroSyncUnfinished(dir, LIB, "user:42", "p2", "unknown");
    expect((await readZoteroSyncSettings(dir, LIB)).links[0]!.unfinished).toBe("unknown");
    await setZoteroSyncUnfinished(dir, LIB, "user:42", "p2", undefined);
    expect((await readZoteroSyncSettings(dir, LIB)).links[0]!.unfinished).toBeUndefined();
  });
});
