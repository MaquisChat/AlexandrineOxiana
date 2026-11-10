import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { ExifTool } from "exiftool-vendored";
import { buildCameraTiff, buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { WorkerClient } from "../worker-client.js";
import { stubWorker } from "../worker-testing.js";
import { proxyQueueFor } from "./proxies.js";
import { proxyStub } from "./proxy-testing.js";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import {
  WATCH_REASONS,
  WATCH_STABILITY_MS,
  addWatchedFolder,
  ignoredName,
  listWatchedFolders,
  removeWatchedFolder,
  setWatchFolder,
  watchFolder,
  type FolderWatch,
  type WatchEvent,
} from "./watch.js";

const FAST = 2 ** 10;
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
let agent: MockAgent;
let http: HttpClient;
let inbox: string;
const watches: FolderWatch[] = [];

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
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
  agent = new MockAgent();
  agent.disableNetConnect();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  inbox = join(tmp, "Inbox");
  await mkdir(inbox);
});

afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
  await agent.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

const project = async (encrypted = false): Promise<Project> =>
  (
    await repo.createProject({
      name: `P${Math.random().toString(36).slice(2, 7)}`,
      governanceYaml: GOV,
      encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
    })
  ).project;

function start(p: Project, opts: { stabilityMs?: number; pollMs?: number; dir?: string; recursive?: boolean } = {}): { w: FolderWatch; events: WatchEvent[] } {
  const events: WatchEvent[] = [];
  const { dir, recursive, ...seams } = opts;
  const w = watchFolder({ repo, http, lib, onEvent: (e) => events.push(e), ...seams }, p.id, dir ?? inbox, recursive ? { recursive: true } : {});
  watches.push(w);
  return { w, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(50);
  }
}

describe("ignoredName", () => {
  it("ignores partial downloads, temp files, Office lock files, .DS_Store and dotfiles", () => {
    for (const n of ["a.pdf.part", "b.CRDOWNLOAD", "c.tmp", "~$report.docx", ".DS_Store", ".hidden.pdf", "x.pdf.download"]) expect(ignoredName(n)).toBe(true);
    for (const n of ["paper.pdf", "photo.jpg", "notes~.docx"]) expect(ignoredName(n)).toBe(false);
  });
});

describe("watchFolder", () => {
  it(`a file written in 3 chunks is imported once, ${WATCH_STABILITY_MS} ms after its last write`, async () => {
    expect(WATCH_STABILITY_MS).toBe(2000);
    const p = await project();
    const { w, events } = start(p);
    await w.ready;
    const pdf = await buildPdf({ title: "Chunked", lines: ["chunked upload"], extra: "chunks" });
    const file = join(inbox, "chunked.pdf");
    const third = Math.ceil(pdf.length / 3);
    await writeFile(file, pdf.subarray(0, third));
    await sleep(600);
    await appendFile(file, pdf.subarray(third, 2 * third));
    await sleep(600);
    await appendFile(file, pdf.subarray(2 * third));
    const lastWrite = Date.now();
    await until(() => events.some((e) => e.kind === "imported"));
    const at = Date.now();
    await sleep(2500); // nothing more arrives for the same file
    const forFile = events.filter((e) => e.file === "chunked.pdf");
    expect(forFile).toHaveLength(1);
    expect(forFile[0]).toMatchObject({ kind: "imported", outcome: expect.stringMatching(/created|needs-review/u), sourceId: expect.any(String) });
    expect(at - lastWrite).toBeGreaterThanOrEqual(1900);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
    expect(sf.source.provenance.captureMethod).toBe("manual_upload");
    expect(JSON.stringify(events)).not.toContain(tmp);
  }, 30_000);

  it("temp and partial names are ignored; stop() is clean and idempotent", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200 });
    await w.ready;
    const pdf = await buildPdf({ extra: "ignored" });
    for (const n of ["a.pdf.part", "b.pdf.crdownload", "c.tmp", "~$doc.pdf", ".DS_Store", ".hidden.pdf"]) await writeFile(join(inbox, n), pdf);
    await sleep(1500);
    expect(events).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    await w.stop();
    await w.stop();
    expect(w.stopped).toBe(true);
    await writeFile(join(inbox, "after-stop.pdf"), await buildPdf({ extra: "after stop" }));
    await sleep(1000);
    expect(events.filter((e) => e.kind !== "stopped")).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a link to a file outside the watched folder is refused (the folder is the R67 root); errors never show paths", async () => {
    const p = await project();
    const outside = join(tmp, "Elsewhere");
    await mkdir(outside);
    await writeFile(join(outside, "secret.pdf"), await buildPdf({ extra: "outside" }));
    const { w, events } = start(p, { stabilityMs: 200 });
    await w.ready;
    await symlink(join(outside, "secret.pdf"), join(inbox, "link.pdf"));
    await writeFile(join(inbox, "notes.txt"), "plain text is not a source");
    await until(() => events.length >= 2);
    expect(events.find((e) => e.file === "link.pdf")).toMatchObject({ kind: "failed", reason: WATCH_REASONS.outside });
    expect(events.find((e) => e.file === "notes.txt")).toMatchObject({ kind: "failed", reason: expect.stringMatching(/cannot be attached/u) });
    expect(JSON.stringify(events)).not.toContain(tmp);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("stops by itself when the library is closed (lock released or lost)", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await lib.close();
    await until(() => w.stopped);
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: WATCH_REASONS.libraryClosed });
  });

  it("an error while importing is reported, never thrown, and the watch goes on", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200 });
    await w.ready;
    await writeFile(join(inbox, "broken.pdf"), "%PDF-1.7\nnot really a pdf");
    await writeFile(join(inbox, "good.pdf"), await buildPdf({ title: "Good one", extra: "good" }));
    await until(() => events.filter((e) => e.file === "broken.pdf" || e.file === "good.pdf").length >= 2);
    expect(events.find((e) => e.file === "good.pdf")!.kind).toBe("imported");
    expect(w.stopped).toBe(false);
  });
});

describe("watchFolder (review round 1, R81)", () => {
  it("the watched folder removed → 'stopped' with a reason; it resumes when the folder comes back", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await rm(inbox, { recursive: true });
    await until(() => events.some((e) => e.kind === "stopped"));
    expect(events.find((e) => e.kind === "stopped")).toMatchObject({ reason: WATCH_REASONS.removed });
    expect(WATCH_REASONS.removed).toMatch(/the watched folder was removed/iu);
    expect(w.stopped).toBe(false); // waiting for it, not finished
    await mkdir(inbox);
    await until(() => events.some((e) => e.kind === "resumed"));
    await sleep(300);
    await writeFile(join(inbox, "back.pdf"), await buildPdf({ title: "Back again", extra: "back" }));
    await until(() => events.some((e) => e.kind === "imported" && e.file === "back.pdf"));
  });

  it("review round 2 (R82): on resume the folder is checked again (a link swapped in pointing into the library stops the watch)", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await rm(inbox, { recursive: true });
    await until(() => events.some((e) => e.kind === "stopped"));
    await symlink(join(lib.root, "Projects"), inbox);
    await until(() => w.stopped);
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: WATCH_REASONS.library });
    expect(events.some((e) => e.kind === "resumed")).toBe(false);
    await rm(inbox);
    await writeFile(inbox, "now a file");
  });

  it("review round 2: a rescan does not report a failed file again until it changes", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await writeFile(join(inbox, "notes.txt"), "plain text");
    await until(() => events.some((e) => e.file === "notes.txt"));
    // The folder goes away and comes back with the same file: resumed and rescanned, no second report.
    await rename(inbox, `${inbox}-away`);
    await until(() => events.some((e) => e.kind === "stopped"));
    await rename(`${inbox}-away`, inbox);
    await until(() => events.some((e) => e.kind === "resumed"));
    await sleep(800);
    expect(events.filter((e) => e.file === "notes.txt")).toHaveLength(1);
    await writeFile(join(inbox, "notes.txt"), "changed text, still not a source");
    await until(() => events.filter((e) => e.file === "notes.txt").length === 2);
  });

  it("one per-project queue: the same PDF arriving in two watched folders gives one source and one duplicate", async () => {
    const p = await project();
    const other = join(tmp, "Inbox2");
    await mkdir(other);
    const a = start(p, { stabilityMs: 200 });
    const b = start(p, { stabilityMs: 200, dir: other });
    await Promise.all([a.w.ready, b.w.ready]);
    const pdf = await buildPdf({ title: "Same twice", extra: "same" });
    await Promise.all([writeFile(join(inbox, "same.pdf"), pdf), writeFile(join(other, "same.pdf"), pdf)]);
    await until(() => a.events.length + b.events.length >= 2);
    const outcomes = [...a.events, ...b.events].map((e) => e.outcome);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "created" || o === "needs-review")).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("refuses a folder inside the library or one that contains it", async () => {
    const p = await project();
    for (const dir of [join(lib.root, "Projects"), tmp]) {
      const { w, events } = start(p, { dir });
      await w.ready;
      expect(events).toEqual([expect.objectContaining({ kind: "error", reason: WATCH_REASONS.library }), expect.objectContaining({ kind: "stopped" })]);
      expect(w.stopped).toBe(true);
      await expect(addWatchedFolder({ repo, lib }, p.id, dir)).rejects.toThrow(WATCH_REASONS.library);
    }
  });

  it("files already there when the watch starts are imported; files imported before are skipped silently", async () => {
    const p = await project();
    await writeFile(join(inbox, "early.pdf"), await buildPdf({ title: "Early bird", extra: "early" }));
    const first = start(p, { stabilityMs: 200 });
    await first.w.ready;
    await until(() => first.events.some((e) => e.file === "early.pdf"));
    expect(first.events.find((e) => e.file === "early.pdf")!.kind).toBe("imported");
    await first.w.stop();
    const second = start(p, { stabilityMs: 200 });
    await second.w.ready;
    await sleep(1200);
    expect(second.events.filter((e) => e.file === "early.pdf")).toEqual([]);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("an encrypted project that is locked pauses the watch; on unlock, files that arrived meanwhile are imported", async () => {
    const p = await project(true);
    repo.lockProject(p.id);
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await writeFile(join(inbox, "while-locked.pdf"), await buildPdf({ title: "While locked", extra: "locked" }));
    await until(() => events.some((e) => e.kind === "paused"));
    await sleep(500);
    expect(events.some((e) => e.kind === "imported")).toBe(false);
    await repo.unlockProject(p.id, "pw");
    await until(() => events.some((e) => e.kind === "imported" && e.file === "while-locked.pdf"));
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("a changed file is imported again when its content changed (same content: nothing)", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200 });
    await w.ready;
    const f = join(inbox, "draft.pdf");
    const v1 = await buildPdf({ title: "Draft one", extra: "v1" });
    await writeFile(f, v1);
    await until(() => events.filter((e) => e.kind === "imported").length === 1);
    await writeFile(f, v1); // rewritten, same bytes
    await sleep(1000);
    expect(events.filter((e) => e.file === "draft.pdf")).toHaveLength(1);
    await writeFile(f, await buildPdf({ title: "Draft two", extra: "v2" }));
    await until(() => events.filter((e) => e.kind === "imported").length === 2);
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  });

  it("a link to a folder in a recursive watch gets its own plain reason", async () => {
    const p = await project();
    const target = join(inbox, "Real");
    await mkdir(target);
    const { w, events } = start(p, { stabilityMs: 200, recursive: true });
    await w.ready;
    await symlink(target, join(inbox, "LinkToFolder"));
    await until(() => events.some((e) => e.file === "LinkToFolder"));
    expect(events.find((e) => e.file === "LinkToFolder")).toMatchObject({ kind: "failed", reason: WATCH_REASONS.folderLink });
  });
});

describe("watched-folder settings (R69)", () => {
  it("project.json keeps only the id and options; the folder is a device setting", async () => {
    const p = await project();
    const wf = await addWatchedFolder({ repo, lib }, p.id, inbox, { label: "Downloads inbox" });
    const pj = await readFile(join(lib.root, p.folder, "project.json"), "utf8");
    expect(JSON.parse(pj).project.watchedFolders).toEqual([{ id: wf.id, options: { label: "Downloads inbox", recursive: false }, createdAt: expect.any(String) }]);
    expect(pj).not.toContain(inbox);
    expect(pj).not.toContain(tmp);
    const device = await readFile(join(tmp, "config", "watched-folders.json"), "utf8");
    expect(device).toContain(wf.id);
    expect(await listWatchedFolders({ repo, lib }, p.id)).toEqual([expect.objectContaining({ id: wf.id, dir: expect.stringContaining("Inbox") })]);

    // Another computer (other app settings): the watch exists, without a folder.
    const other = { repo, lib: { ...lib, id: lib.id, appConfigDir: join(tmp, "other-config") } as Library };
    expect((await listWatchedFolders(other, p.id))[0]!.dir).toBeUndefined();

    // setWatchFolder: choose the folder for an existing watch on this (other) computer.
    const otherInbox = join(tmp, "OtherInbox");
    await mkdir(otherInbox);
    await setWatchFolder(other, p.id, wf.id, otherInbox);
    expect((await listWatchedFolders(other, p.id))[0]!.dir).toContain("OtherInbox");
    expect((await stat(join(tmp, "other-config"))).mode & 0o777).toBe(0o700);
    await expect(setWatchFolder(other, p.id, "no-such-watch", otherInbox)).rejects.toThrow();

    await removeWatchedFolder({ repo, lib }, p.id, wf.id);
    expect(JSON.parse(await readFile(join(lib.root, p.folder, "project.json"), "utf8")).project.watchedFolders).toEqual([]);
    expect(await readFile(join(tmp, "config", "watched-folders.json"), "utf8")).not.toContain(wf.id);
    await expect(addWatchedFolder({ repo, lib }, p.id, "relative/dir", {})).rejects.toThrow(/absolute/u);
  });

  it("an unreadable settings file is moved aside with a warning, never silently emptied", async () => {
    const p = await project();
    await mkdir(join(tmp, "config"), { recursive: true });
    await writeFile(join(tmp, "config", "watched-folders.json"), "{ not json");
    const warnings: string[] = [];
    const wf = await addWatchedFolder({ repo, lib, onWarning: (w) => warnings.push(w) }, p.id, inbox);
    expect(warnings).toEqual([WATCH_REASONS.settingsUnreadable]);
    const aside = (await readdir(join(tmp, "config"))).filter((n) => n.startsWith("watched-folders.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(tmp, "config", aside[0]!), "utf8")).toBe("{ not json");
    expect(await readFile(join(tmp, "config", "watched-folders.json"), "utf8")).toContain(wf.id);
  });
});

describe("watched folders and viewing proxies (R85)", () => {
  it("a located photo in a watched folder goes through the library's proxy queue (proxyQueueFor)", async () => {
    const et = new ExifTool({ maxProcs: 1 });
    const closers: Array<() => Promise<void> | void> = [];
    const queue = proxyQueueFor(repo);
    try {
      const w = await stubWorker(proxyStub(et), { closers, pollsUntilDone: 1 });
      queue.setWorker(new WorkerClient({ repo, worker: w, pollMs: 5 }));
      const { project: p } = await repo.createProject({
        name: `P${Math.random().toString(36).slice(2, 7)}`,
        governanceYaml: GOV.replace("atRest: optional", "atRest: required") + "sharing:\n  locationMetadata: coarsen\n",
        encryption: { enabled: true, passphrase: "pw" },
      });
      const { w: watch, events } = start(p, { stabilityMs: 200 });
      await watch.ready;
      // Built elsewhere (the fixture is written in two steps), then moved in whole.
      await buildCameraTiff(join(tmp, "IMG_0001.tif"));
      await rename(join(tmp, "IMG_0001.tif"), join(inbox, "IMG_0001.tif"));
      await until(() => events.some((e) => e.kind === "imported"));
      await queue.idle();
      const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
      expect(sf.assets.filter((a) => a.kind === "proxy")).toHaveLength(1);
      expect(sf.pendingProxies ?? []).toEqual([]);
    } finally {
      queue.setWorker(null);
      for (const c of closers) await c();
      await et.end();
    }
  });
});
