import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { deviceNoticesIdle, readDeviceNotices } from "../device-notices.js";
import { createLibrary, type Library } from "../library.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { WatchedFoldersUnreadableError, addWatchedFolder, type WatchSettingsDeps } from "./watch.js";
import {
  DEFAULT_WATCH_CHOICES,
  WATCH_CHOICES_FILE,
  CHOICES_SET_ASIDE_WARNING,
  reserveWatchDownload,
  getWatchChoices,
  getWatchDownloadCount,
  removeWatchChoices,
  setWatchChoices,
} from "./watch-choices.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let config: string;
let projectId: string;
let watchId: string;
let d: WatchSettingsDeps;

const deps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-choices-"));
  config = join(tmp, "config");
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
  const p = (await repo.createProject({ name: "P", governanceYaml: GOV, encryption: { enabled: false } })).project;
  projectId = p.id;
  await mkdir(join(tmp, "Inbox"));
  d = { repo, lib };
  watchId = (await addWatchedFolder(d, projectId, join(tmp, "Inbox"))).id;
});

afterEach(async () => {
  await deviceNoticesIdle();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("this computer's choices for a watched folder (Task W4)", () => {
  it("missing file gives the defaults", async () => {
    expect(DEFAULT_WATCH_CHOICES).toEqual({ paused: false, notDownloaded: "leave", confirmedBytes: 0 });
    await expect(stat(join(config, WATCH_CHOICES_FILE))).rejects.toThrow();
    expect(await getWatchChoices(d, projectId, watchId)).toEqual({ paused: false, notDownloaded: "leave", confirmedBytes: 0 });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 0, fetchedBytes: 0 });
    // Reading never writes.
    await expect(stat(join(config, WATCH_CHOICES_FILE))).rejects.toThrow();
  });

  it("set and get: kept per library, project and watch; ids and numbers only; 0600 in a 0700 folder", async () => {
    const after = await setWatchChoices(d, projectId, watchId, { paused: true });
    expect(after).toEqual({ paused: true, notDownloaded: "leave", confirmedBytes: 0 });
    expect(await getWatchChoices(d, projectId, watchId)).toEqual(after);
    expect(await setWatchChoices(d, projectId, watchId, { notDownloaded: "download", confirmedBytes: 5000 })).toEqual({ paused: true, notDownloaded: "download", confirmedBytes: 5000 });
    const text = await readFile(join(config, WATCH_CHOICES_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ [lib.id]: { [projectId]: { [watchId]: { paused: true, notDownloaded: "download", confirmedBytes: 5000, confirmation: 1, fetchedBytes: 0 } } } });
    expect(text).not.toContain(tmp);
    expect(text).not.toContain("Inbox");
    expect((await stat(join(config, WATCH_CHOICES_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(config)).mode & 0o777).toBe(0o700);
    // Another computer (other settings folder) has its own choices: the defaults.
    const other = { repo, lib: { ...lib, id: lib.id, appConfigDir: join(tmp, "other") } as Library };
    expect(await getWatchChoices(other, projectId, watchId)).toEqual(DEFAULT_WATCH_CHOICES);
    // Removal forgets them.
    await removeWatchChoices(d, projectId, watchId);
    expect(await getWatchChoices(d, projectId, watchId)).toEqual(DEFAULT_WATCH_CHOICES);
    expect(await readFile(join(config, WATCH_CHOICES_FILE), "utf8")).not.toContain(watchId);
  });

  it("a new confirmation starts the count again; bytes reserved for an older confirmation are not added to it", async () => {
    await setWatchChoices(d, projectId, watchId, { notDownloaded: "download", confirmedBytes: 1000 });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 1, fetchedBytes: 0 });
    expect(await reserveWatchDownload(d, projectId, watchId, 1, 400, false)).toEqual({ reserved: true, fetchedBytes: 400 });
    expect(await reserveWatchDownload(d, projectId, watchId, 1, 100, false)).toEqual({ reserved: true, fetchedBytes: 500 });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 1, fetchedBytes: 500 });
    // The researcher confirms again with the very same number: it is a new confirmation all the same.
    await setWatchChoices(d, projectId, watchId, { confirmedBytes: 1000 });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 2, fetchedBytes: 0 });
    expect(await reserveWatchDownload(d, projectId, watchId, 1, 300, false)).toEqual({ reserved: false, reason: "stale" }); // for the old one: not added
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 2, fetchedBytes: 0 });
    // A pause or "leave" is not a confirmation: the count stays.
    await reserveWatchDownload(d, projectId, watchId, 2, 7, false);
    await setWatchChoices(d, projectId, watchId, { paused: true, notDownloaded: "leave" });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 2, fetchedBytes: 7 });
  });

  it("the record is the one authority on the agreed size: a reservation past it is refused, however many ask at once (I1)", async () => {
    await setWatchChoices(d, projectId, watchId, { notDownloaded: "download", confirmedBytes: 100 });
    // Two watches of one id asking at the same moment: one gets the 100 bytes, the other is held.
    const both = await Promise.all([reserveWatchDownload(d, projectId, watchId, 1, 100, false), reserveWatchDownload(d, projectId, watchId, 1, 100, false)]);
    expect(both).toEqual([{ reserved: true, fetchedBytes: 100 }, { reserved: false, reason: "held" }]);
    // Exactly at the limit is allowed; one byte past it is not.
    await setWatchChoices(d, projectId, watchId, { confirmedBytes: 100 });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 99, false)).toEqual({ reserved: true, fetchedBytes: 99 });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 2, false)).toEqual({ reserved: false, reason: "held" });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 1, false)).toEqual({ reserved: true, fetchedBytes: 100 });
    // A later arrival may go 1 GiB beyond what was agreed, and not one byte more.
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 1073741824, true)).toEqual({ reserved: true, fetchedBytes: 100 + 1073741824 });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 0, true)).toEqual({ reserved: true, fetchedBytes: 100 + 1073741824 });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 1, true)).toEqual({ reserved: false, reason: "held" });
  });

  it("no confirmation, no download: a file of 0 bytes is not free (I4)", async () => {
    // Never confirmed (no record), and "download" chosen without a size: nothing is reserved, 0 bytes included.
    expect(await reserveWatchDownload(d, projectId, watchId, 0, 0, false)).toEqual({ reserved: false, reason: "held" });
    await setWatchChoices(d, projectId, watchId, { notDownloaded: "download" });
    expect(await getWatchDownloadCount(d, projectId, watchId)).toEqual({ confirmation: 0, fetchedBytes: 0 });
    expect(await reserveWatchDownload(d, projectId, watchId, 0, 0, false)).toEqual({ reserved: false, reason: "held" });
    expect(await reserveWatchDownload(d, projectId, watchId, 0, 0, true)).toEqual({ reserved: false, reason: "held" });
    // A confirmation of 0 bytes is no confirmation: nothing, later arrivals included (fix round 2).
    await setWatchChoices(d, projectId, watchId, { confirmedBytes: 0 });
    expect(await reserveWatchDownload(d, projectId, watchId, 1, 0, false)).toEqual({ reserved: false, reason: "held" });
    expect(await reserveWatchDownload(d, projectId, watchId, 1, 10, true)).toEqual({ reserved: false, reason: "held" });
    // A size agreed: a file of 0 bytes is reserved under it like any other.
    await setWatchChoices(d, projectId, watchId, { confirmedBytes: 5 });
    expect(await reserveWatchDownload(d, projectId, watchId, 2, 0, false)).toEqual({ reserved: true, fetchedBytes: 0 });
  });

  it("an unknown watch, an unknown project and a malformed choice are refused, writing nothing", async () => {
    await expect(setWatchChoices(d, projectId, "no-such-watch", { paused: true })).rejects.toThrow(/no such watched folder/u);
    await expect(setWatchChoices(d, "no-such-project", watchId, { paused: true })).rejects.toThrow();
    for (const bad of [{ paused: "yes" }, { notDownloaded: "everything" }, { confirmedBytes: -1 }, { confirmedBytes: 1.5 }, { confirmedBytes: Number.MAX_SAFE_INTEGER + 2 }, { path: "/Users/a" }])
      await expect(setWatchChoices(d, projectId, watchId, bad as never)).rejects.toThrow();
    await expect(stat(join(config, WATCH_CHOICES_FILE))).rejects.toThrow();
  });

  it("a read error refuses and writes nothing", async () => {
    // A folder in the file's place cannot be read as a file (EISDIR): not "missing", not "damaged".
    await mkdir(join(config, WATCH_CHOICES_FILE), { recursive: true });
    const before = (await readdir(config)).sort();
    await expect(getWatchChoices(d, projectId, watchId)).rejects.toBeInstanceOf(WatchedFoldersUnreadableError);
    await expect(getWatchDownloadCount(d, projectId, watchId)).rejects.toBeInstanceOf(WatchedFoldersUnreadableError);
    await expect(setWatchChoices(d, projectId, watchId, { paused: true })).rejects.toBeInstanceOf(WatchedFoldersUnreadableError);
    await expect(reserveWatchDownload(d, projectId, watchId, 1, 10, false)).rejects.toBeInstanceOf(WatchedFoldersUnreadableError);
    await expect(removeWatchChoices(d, projectId, watchId)).rejects.toBeInstanceOf(WatchedFoldersUnreadableError);
    expect((await readdir(config)).sort()).toEqual(before);
    expect(await readdir(join(config, WATCH_CHOICES_FILE))).toEqual([]);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(config)).toEqual([]);
    // The message names no path.
    const err = (await getWatchChoices(d, projectId, watchId).then(
      () => new Error("read"),
      (e: unknown) => e as Error,
    ));
    expect(err).toBeInstanceOf(WatchedFoldersUnreadableError);
    expect(err.message).not.toContain(tmp);
  });

  it("a set-aside keeps the usable choices of other folders, and says only what happened (M3)", async () => {
    expect(CHOICES_SET_ASIDE_WARNING).toBe(
      "This computer's choices for its watched folders were damaged and were set aside. Folders whose choices could not be kept went back to the defaults.",
    );
    await mkdir(join(tmp, "Inbox2"));
    const other = (await addWatchedFolder(d, projectId, join(tmp, "Inbox2"))).id; // one folder feeds one project (I6)
    await setWatchChoices(d, projectId, other, { paused: true });
    const text = JSON.parse(await readFile(join(config, WATCH_CHOICES_FILE), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    text[lib.id]![projectId]![watchId] = { paused: "no" };
    await writeFile(join(config, WATCH_CHOICES_FILE), JSON.stringify(text));
    expect(await getWatchChoices(d, projectId, watchId)).toEqual(DEFAULT_WATCH_CHOICES);
    expect(await getWatchChoices(d, projectId, other)).toEqual({ ...DEFAULT_WATCH_CHOICES, paused: true });
  });

  it("damaged content is set aside with the notice", async () => {
    const damaged = [
      "{ not json",
      "[]",
      JSON.stringify({ [lib.id]: { [projectId]: { [watchId]: { paused: "no", notDownloaded: "leave", confirmedBytes: 0, confirmation: 0, fetchedBytes: 0 } } } }),
      JSON.stringify({ [lib.id]: { [projectId]: { [watchId]: { paused: false, notDownloaded: "leave", confirmedBytes: 0, confirmation: 0, fetchedBytes: 0, dir: "/Users/a/Drive" } } } }),
      JSON.stringify({ [lib.id]: { [projectId]: "x" } }),
    ];
    for (const [i, text] of damaged.entries()) {
      await mkdir(config, { recursive: true });
      for (const n of await readdir(config)) await rm(join(config, n), { recursive: true, force: true });
      await writeFile(join(config, WATCH_CHOICES_FILE), text);
      const warnings: string[] = [];
      expect(await getWatchChoices({ ...d, onWarning: (w) => warnings.push(w) }, projectId, watchId), `case ${i}`).toEqual(DEFAULT_WATCH_CHOICES);
      const aside = (await readdir(config)).filter((n) => n.startsWith(`${WATCH_CHOICES_FILE}.corrupt-`));
      expect(aside, `case ${i}`).toHaveLength(1);
      expect(await readFile(join(config, aside[0]!), "utf8")).toBe(text);
      expect(warnings).toEqual([CHOICES_SET_ASIDE_WARNING]);
      await deviceNoticesIdle();
      expect((await readDeviceNotices(config)).map((n) => n.kind)).toEqual(["watched-folder-choices-set-aside"]);
      // A write after the setting aside starts afresh; the damaged file is kept.
      await setWatchChoices(d, projectId, watchId, { paused: true });
      expect(await getWatchChoices(d, projectId, watchId)).toEqual({ ...DEFAULT_WATCH_CHOICES, paused: true });
      expect((await readdir(config)).filter((n) => n.startsWith(`${WATCH_CHOICES_FILE}.corrupt-`))).toHaveLength(1);
    }
  });
});
