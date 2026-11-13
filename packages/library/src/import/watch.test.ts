import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { Attach } from "./attach.js";
import { POINTER_REASON, contentState, ignoredName as ignoredNameLocal } from "./watch-local.js";
import {
  WATCH_FS_TIMEOUT_MS,
  WATCH_PROBLEMS_MAX,
  WATCH_RECHECK_MS,
  WATCH_REASONS,
  WATCH_RESCAN_MS,
  WATCH_STABILITY_MS,
  WATCH_STATUS_INTERVAL_MS,
  addWatchedFolder,
  ignoredName,
  listWatchedFolders,
  removeWatchedFolder,
  setWatchFolder,
  watchFolder,
  withProvider,
  type FolderWatch,
  type WatchDeps,
  type WatchEvent,
  type WatchStatus,
} from "./watch.js";

// Every change the test itself makes in a watched folder goes through these, which note the time of the
// last one: after each test, nothing in any watched folder may have changed after it (W2 Accept 8: the
// engine never writes, renames, deletes or touches anything there — any such change moves a ctime).
let lastWrite = 0;
const tracked =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } finally {
      lastWrite = Date.now();
    }
  };
const writeFile = tracked(fsp.writeFile);
const appendFile = tracked(fsp.appendFile);
const mkdir = tracked(fsp.mkdir);
const rename = tracked(fsp.rename);
const rm = tracked(fsp.rm);
const symlink = tracked(fsp.symlink);
const truncate = tracked(fsp.truncate);
const chmod = tracked(fsp.chmod);
/** The real `fsp.open`, captured before any spy. */
const realFspOpen = fsp.open;
const watchedDirs = new Set<string>();

// Review M8: besides the ctimes, every call that can change a file is spied on for the whole test. The test's own
// changes go through the functions above, captured before any spy, so every spied call comes from the code under
// test; none may name a path in a watched folder.
const MUTATING_P = ["writeFile", "appendFile", "rename", "rm", "rmdir", "unlink", "mkdir", "symlink", "link", "truncate", "chmod", "chown", "lchown", "utimes", "lutimes", "copyFile", "cp", "open"] as const;
const MUTATING_S = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "rename", "renameSync", "rm", "rmSync", "unlink", "unlinkSync", "mkdir", "mkdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "chmod", "chmodSync", "utimes", "utimesSync", "copyFile", "copyFileSync", "open", "openSync", "createWriteStream"] as const;
let mutating: Array<{ mock: { calls: unknown[][] }; name: string }> = [];
function spyMutations() {
  mutating = [
    ...MUTATING_P.map((n) => ({ mock: vi.spyOn(fsp, n as "open").mock as { calls: unknown[][] }, name: n })),
    ...MUTATING_S.map((n) => ({ mock: vi.spyOn(fs, n as "open").mock as { calls: unknown[][] }, name: n })),
  ];
  syncBuiltinESMExports();
}
/** Calls of the code under test that could change something in a watched folder. */
function mutationsIn(dirs: string[]): string[] {
  const inside = (v: unknown) => typeof v === "string" && dirs.some((d) => v === d || v.startsWith(`${d}/`));
  const writes = (flags: unknown) =>
    typeof flags === "string" ? /[wa+]/u.test(flags) : typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
  const out: string[] = [];
  for (const s of mutating)
    for (const a of s.mock.calls) {
      if ((s.name === "open" || s.name === "openSync") && !writes(a[1])) continue;
      if (inside(a[0]) || ((s.name.startsWith("rename") || s.name.startsWith("copyFile") || s.name.startsWith("symlink") || s.name === "link" || s.name === "cp") && inside(a[1]))) out.push(`${s.name} ${String(a[0])}`);
    }
  return out;
}

/** Every entry under `dir` (dot entries included) with its change time; null when `dir` is gone. */
async function ctimes(dir: string): Promise<Array<[string, number]> | null> {
  const st = await fsp.lstat(dir).catch(() => null);
  if (!st) return null;
  const out: Array<[string, number]> = [[dir, st.ctimeMs]];
  if (!st.isDirectory()) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...((await ctimes(p)) ?? []));
    else out.push([p, (await fsp.lstat(p)).ctimeMs]);
  }
  return out;
}

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
  spyMutations();
});

afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
  const dirs = await Promise.all([...watchedDirs].map((d) => realpath(d).catch(() => d)));
  expect(mutationsIn([...dirs, ...watchedDirs])).toEqual([]);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  // Nothing in a watched folder changed after the test's own last change (W2 Accept 8).
  for (const d of watchedDirs) {
    const changed = ((await ctimes(d)) ?? []).filter(([, c]) => c > lastWrite + 1).map(([p]) => p);
    expect(changed).toEqual([]);
  }
  watchedDirs.clear();
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

type Seams = Partial<Omit<WatchDeps, "repo" | "http" | "lib" | "onEvent" | "onStatus">>;
function start(p: Project, opts: Seams & { dir?: string; recursive?: boolean } = {}): { w: FolderWatch; events: WatchEvent[]; statuses: Array<WatchStatus & { at: number }> } {
  const events: WatchEvent[] = [];
  const statuses: Array<WatchStatus & { at: number }> = [];
  const { dir, recursive, ...seams } = opts;
  // (A folder holding the library, or inside it, is refused; the library itself changes, so it is not checked.)
  const d = dir ?? inbox;
  if (!lib.root.startsWith(d) && !d.startsWith(lib.root)) watchedDirs.add(d);
  const w = watchFolder(
    { repo, http, lib, onEvent: (e) => events.push(e), onStatus: (s) => statuses.push({ ...structuredClone(s), at: Date.now() }), ...seams },
    p.id,
    dir ?? inbox,
    recursive ? { recursive: true } : {},
  );
  watches.push(w);
  return { w, events, statuses };
}

/** Spies on every call that opens or reads a file's bytes (through each module's own binding); returns the calls for one path. */
function readSpies(): (path: string) => unknown[][] {
  const spies = [
    vi.spyOn(fsp, "open"),
    vi.spyOn(fsp, "readFile"),
    vi.spyOn(fsp, "copyFile"),
    vi.spyOn(fsp, "cp"),
    vi.spyOn(fs, "createReadStream"),
    vi.spyOn(fs, "open"),
    vi.spyOn(fs, "readFile"),
    vi.spyOn(fs, "openSync"),
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fs, "copyFile"),
    vi.spyOn(fs, "copyFileSync"),
  ];
  syncBuiltinESMExports();
  return (path) => spies.flatMap((s) => s.mock.calls as unknown[][]).filter((args) => String(args[0]) === path);
}

/** A file whose size is `size` bytes and which has no blocks: Linux's stand-in for a file that is not downloaded (W1). */
async function sparse(path: string, size: number): Promise<void> {
  await writeFile(path, "");
  await truncate(path, size);
}

/** An attach that stores nothing and reads nothing: every file "comes in" at once (tests of the engine alone). */
const quickAttach = (): Attach & { paths: string[] } => {
  const paths: string[] = [];
  return {
    paths,
    attachFiles: async (_p, ps) => ps.map((path) => (paths.push(path), { path, outcome: "created" as const, sourceId: `s${paths.length}` })),
  };
};

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
    // W2 Accept 5: "Cannot be reached" with the `missing` sentence, replacing "the watched folder was removed".
    const missing = withProvider(WATCH_REASONS.missing, null);
    expect(missing).toBe("The folder cannot be found. If the system is signed out or still starting, watching resumes when the folder is back.");
    expect(events.find((e) => e.kind === "stopped")).toMatchObject({ reason: missing });
    expect(w.status()).toMatchObject({ state: "unreachable", reason: missing });
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
    const aside = (await readdir(join(tmp, "config"))).filter((n) => n.startsWith("watched-folders.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(tmp, "config", aside[0]!), "utf8")).toBe("{ not json");
    expect(await readFile(join(tmp, "config", "watched-folders.json"), "utf8")).toContain(wf.id);
  });
});

describe("cloud-drive folders: the engine reads nothing it may not (Task W2)", () => {
  const eperm = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const page = (n: number) => ({ offset: 0, limit: n });

  it("ignoredName is the same function from both modules", () => {
    expect(ignoredName).toBe(ignoredNameLocal);
  });

  it("a not-downloaded file is counted, listed and never opened", async () => {
    expect([WATCH_PROBLEMS_MAX, WATCH_STATUS_INTERVAL_MS]).toEqual([5000, 1000]);
    const p = await project();
    const real = await realpath(inbox);
    await sparse(join(inbox, "online.pdf"), 100_000);
    const opened = readSpies();
    const { w, statuses } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    expect(w.status()).toMatchObject({ state: "watching", provider: null, counts: { notDownloaded: 1, notDownloadedBytes: 100_000, cameIn: 0, didNotComeIn: 0 } });
    expect(w.problems(page(10))).toEqual({ total: 1, items: [{ file: "online.pdf", kind: "not-downloaded", reason: WATCH_REASONS.notDownloaded, bytes: 100_000 }] });
    expect(w.problems({ kind: "not-supported", offset: 0, limit: 10 })).toEqual({ total: 0, items: [] });
    await sleep(800); // several polls, each re-checking it
    expect(opened(join(real, "online.pdf"))).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(statuses.at(-1)!.counts.notDownloaded).toBe(1);
    // A file that goes away leaves the list and the counts.
    await rm(join(inbox, "online.pdf"));
    await until(() => w.problems(page(10)).total === 0);
    expect(w.status().counts).toMatchObject({ notDownloaded: 0, notDownloadedBytes: 0 });
  });

  it("a not-downloaded sidecar is not read", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "paper.pdf"), await buildPdf({ lines: ["Some page text without a title that we could use."], extra: "sidecar" }));
    await sparse(join(inbox, "paper.bib"), 4096);
    const opened = readSpies();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await until(() => events.some((e) => e.file === "paper.pdf" && e.kind === "imported"));
    await until(() => w.status().counts.notDownloaded === 1);
    expect(opened(join(real, "paper.pdf")).length).toBeGreaterThan(0); // the spies see the engine's reads
    expect(opened(join(real, "paper.bib"))).toEqual([]);
    expect(w.problems(page(10)).items).toEqual([expect.objectContaining({ file: "paper.bib", kind: "not-downloaded" })]);
  });

  it("a scanned file still being written waits for 2 seconds of no change", async () => {
    const p = await project();
    const pdf = await buildPdf({ title: "Slow copy", extra: "slow" });
    const half = Math.ceil(pdf.length / 2);
    await writeFile(join(inbox, "slow.pdf"), pdf.subarray(0, half));
    const { w, events } = start(p, { watchEvents: false }); // found by the scan alone, never by an event
    await w.ready;
    await sleep(700);
    await appendFile(join(inbox, "slow.pdf"), pdf.subarray(half));
    const last = Date.now();
    await until(() => events.some((e) => e.file === "slow.pdf"));
    expect(Date.now() - last).toBeGreaterThanOrEqual(1900);
    expect(events.filter((e) => e.file === "slow.pdf")).toEqual([expect.objectContaining({ kind: "imported" })]);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  }, 30_000);

  it("a file that becomes downloaded comes in without an event", async () => {
    const p = await project();
    let online = true;
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) {
        const s = m.get(q);
        if (online && q.endsWith("later.pdf") && s?.presence === "local") m.set(q, { ...s, presence: "not-downloaded" });
      }
      return m;
    };
    await writeFile(join(inbox, "later.pdf"), await buildPdf({ title: "Later", extra: "later" }));
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 100, recheckMs: 100, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    expect(events.filter((e) => e.file === "later.pdf")).toEqual([]);
    const before = lastWrite;
    online = false; // downloaded: nothing in the folder changes, so no file-system event comes
    await until(() => events.some((e) => e.kind === "imported" && e.file === "later.pdf"));
    expect(lastWrite).toBe(before);
    expect(w.status().counts).toMatchObject({ notDownloaded: 0, notDownloadedBytes: 0, cameIn: 1 });
    expect(w.problems(page(10)).total).toBe(0); // removed when the file came in
  });

  it("a missed event is caught by the rescan", async () => {
    expect(WATCH_RESCAN_MS).toBe(300_000);
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 100, rescanMs: 600, watchEvents: false });
    await w.ready;
    await sleep(300);
    await writeFile(join(inbox, "missed.pdf"), await buildPdf({ title: "Missed", extra: "missed" }));
    await until(() => events.some((e) => e.kind === "imported" && e.file === "missed.pdf"));
  });

  it('an EPERM on the folder says the privacy sentence, not "cannot be found"', async () => {
    const p = await project();
    const real = await realpath(inbox);
    let denied = true;
    const readdirS = async (d: string) => {
      if (denied && d === real) throw eperm();
      return fsp.readdir(d, { withFileTypes: true });
    };
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, fs: { readdir: readdirS } });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    const sentence = withProvider(WATCH_REASONS.notPermitted, null);
    expect(sentence).toBe("macOS did not allow the app to read files managed by the system, so this folder is not watched. Press “Try again” and choose Allow if macOS asks.");
    expect(w.status().reason).toBe(sentence);
    expect(w.status().reason).not.toMatch(/cannot be found/u);
    await writeFile(join(inbox, "allowed.pdf"), await buildPdf({ title: "Allowed", extra: "allowed" }));
    denied = false; // allowed now: watching resumes by itself
    await until(() => events.some((e) => e.kind === "imported" && e.file === "allowed.pdf"));
    expect(w.status().state).toBe("watching");
  });

  it('EPERM on the root gives state "unreachable" with the privacy reason naming the provider', async () => {
    const p = await project();
    const home = join(tmp, "home");
    const drive = join(home, "Library", "CloudStorage", "GoogleDrive-a@b.c", "My Drive");
    await mkdir(drive, { recursive: true });
    const real = await realpath(drive);
    const { w } = start(p, {
      dir: drive,
      pollMs: 50,
      locationEnv: { homeDir: await realpath(home), platform: "darwin", mounts: [] },
      fs: { readdir: async (d: string) => (d === real ? Promise.reject(eperm()) : fsp.readdir(d, { withFileTypes: true })) },
    });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    expect(w.status()).toMatchObject({
      provider: "google-drive",
      reason: "macOS did not allow the app to read files managed by Google Drive, so this folder is not watched. Press “Try again” and choose Allow if macOS asks.",
    });
  });

  it('a folder operation that never answers marks the folder "Cannot be reached" after 30 s and other requests still answer', async () => {
    expect(WATCH_FS_TIMEOUT_MS).toBe(30_000);
    const p = await project();
    const real = await realpath(inbox);
    const other = join(tmp, "Inbox2");
    await mkdir(other);
    const inStuck = (q: string) => q === real || q.startsWith(`${real}/`);
    let outstanding = 0;
    let most = 0;
    let calls = 0;
    const never = new Promise<never>(() => {});
    const count =
      <A extends [string, ...unknown[]], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        if (!inStuck(a[0])) return fn(...a);
        calls++;
        most = Math.max(most, ++outstanding);
        try {
          return await fn(...a);
        } finally {
          outstanding--;
        }
      };
    const stuckFs = {
      readdir: count(async (d: string) => (inStuck(d) ? never : fsp.readdir(d, { withFileTypes: true }))),
      lstat: count(async (q: string) => (inStuck(q) ? never : fsp.lstat(q, { bigint: true }))),
    };
    const a = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: stuckFs });
    const b = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: stuckFs, dir: other });
    await Promise.all([a.w.ready, b.w.ready]);
    await until(() => a.w.status().state === "unreachable");
    const sentence = withProvider(WATCH_REASONS.notResponding, null);
    expect(sentence).toBe("The folder did not answer for 30 seconds (the system may be starting, signed out or offline). Watching goes on when it answers.");
    expect(a.w.status().reason).toBe(sentence);
    // The other folder is still watched, and an ordinary file call elsewhere still answers.
    await writeFile(join(other, "elsewhere.pdf"), await buildPdf({ title: "Elsewhere", extra: "elsewhere" }));
    await until(() => b.events.some((e) => e.kind === "imported" && e.file === "elsewhere.pdf"));
    expect((await stat(tmp)).isDirectory()).toBe(true);
    // Nothing further is asked of the stuck folder, even when files arrive in it.
    const n = calls;
    await writeFile(join(inbox, "meanwhile.pdf"), "x");
    await sleep(1000);
    expect(calls).toBe(n);
    expect(most).toBe(1);
  });

  it("after a call that never answers, no further call is issued on that folder until it settles", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "stuck.pdf"), await buildPdf({ title: "Stuck", extra: "stuck" }));
    await writeFile(join(inbox, "fine.pdf"), await buildPdf({ title: "Fine", extra: "fine" }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    let calls = 0;
    let outstanding = 0;
    let most = 0;
    const lstatS = async (q: string) => {
      if (q.startsWith(real)) {
        calls++;
        most = Math.max(most, ++outstanding);
      }
      try {
        if (hold && q === join(real, "stuck.pdf")) await held;
        return await fsp.lstat(q, { bigint: true });
      } finally {
        if (q.startsWith(real)) outstanding--;
      }
    };
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: { lstat: lstatS } });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    const n = calls;
    await sleep(1000);
    expect(calls).toBe(n);
    hold = false;
    release(); // the stuck call answers at last: watching goes on, and both files come in
    await until(() => ["stuck.pdf", "fine.pdf"].every((f) => events.some((e) => e.kind === "imported" && e.file === f)));
    expect(w.status().state).toBe("watching");
    expect(most).toBe(1);
  });

  it("status is coalesced to one per second during a burst of 2,000 files", async () => {
    const p = await project();
    const { w, statuses } = start(p, { stabilityMs: 200, pollMs: 100, attach: quickAttach() });
    await w.ready;
    await Promise.all(Array.from({ length: 2000 }, (_, i) => writeFile(join(inbox, `f${String(i).padStart(4, "0")}.txt`), `file ${i}`)));
    await until(() => w.status().counts.cameIn === 2000, 60_000);
    await sleep(WATCH_STATUS_INTERVAL_MS + 300);
    expect(statuses.at(-1)!.counts.cameIn).toBe(2000); // the last change is pushed too
    for (let i = 1; i < statuses.length; i++) {
      if (statuses[i]!.state === statuses[i - 1]!.state) expect(statuses[i]!.at - statuses[i - 1]!.at).toBeGreaterThanOrEqual(WATCH_STATUS_INTERVAL_MS - 5);
    }
  }, 90_000);

  it("the watched folder is unchanged after a run", async () => {
    const p = await project();
    await writeFile(join(inbox, "paper.pdf"), await buildPdf({ title: "Unchanged", extra: "unchanged" }));
    await writeFile(join(inbox, "notes.txt"), "plain text");
    await writeFile(join(inbox, "Notes.gdoc"), '{"url": "https://docs.google.com/document/d/x"}');
    await writeFile(join(inbox, ".hidden"), "dot");
    await sparse(join(inbox, "online.pdf"), 50_000);
    await mkdir(join(inbox, "Sub"));
    await writeFile(join(inbox, "Sub", "inner.pdf"), await buildPdf({ title: "Inner", extra: "inner" }));
    await symlink(join(inbox, "paper.pdf"), join(inbox, "link.pdf"));
    const snapshot = async (d: string, base = d): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const e of await readdir(d, { withFileTypes: true })) {
        const q = join(d, e.name);
        const s = await fsp.lstat(q, { bigint: true });
        out[q.slice(base.length)] = [s.mode, s.size, s.blocks, s.ino, s.nlink, s.mtimeNs, s.ctimeNs].join(" ");
        if (e.isDirectory()) Object.assign(out, await snapshot(q, base));
      }
      return out;
    };
    const before = await snapshot(inbox);
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, rescanMs: 400, recursive: true });
    await w.ready;
    await until(() => events.some((e) => e.kind === "imported" && e.file === "Sub/inner.pdf") && repo.listSourceIds(p.id).length === 2);
    await sleep(1000);
    await w.stop();
    expect(await snapshot(inbox)).toEqual(before);
  });

  it("a folder put into a recursive watch is watched, and a file put in it later comes in", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, recursive: true });
    await w.ready;
    await mkdir(join(inbox, "New folder"));
    await sleep(500);
    await writeFile(join(inbox, "New folder", "later.pdf"), await buildPdf({ title: "In a new folder", extra: "newdir" }));
    await until(() => events.some((e) => e.kind === "imported" && e.file === "New folder/later.pdf"));
  });

  it("a Google pointer file is listed with its sentence", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "Notes.gdoc"), '{"url": "https://docs.google.com/document/d/x"}');
    await writeFile(join(inbox, "Budget.GSHEET"), '{"url": "https://docs.google.com/spreadsheets/d/y"}');
    const opened = readSpies();
    const { w } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await until(() => w.status().counts.didNotComeIn === 2);
    expect(w.problems({ kind: "online-only-document", offset: 0, limit: 10 }).items.map((i) => [i.file, i.reason]).sort()).toEqual([
      ["Budget.GSHEET", POINTER_REASON],
      ["Notes.gdoc", POINTER_REASON],
    ]);
    expect(opened(join(real, "Notes.gdoc"))).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("the state judged by the check is compared with the stability reading before the hash; a file that changed in between is not read", async () => {
    const p = await project();
    const real = await realpath(inbox);
    let judged = 0;
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) {
        const s = m.get(q);
        if (q.endsWith("moved.pdf") && s?.presence === "local") {
          judged++;
          m.set(q, { ...s, mtimeNs: s.mtimeNs + 1n }); // changed between the stability reading and the check
        }
      }
      return m;
    };
    await writeFile(join(inbox, "moved.pdf"), await buildPdf({ title: "Moved", extra: "moved" }));
    await writeFile(join(inbox, "ok.pdf"), await buildPdf({ title: "Ok", extra: "ok" }));
    const opened = readSpies();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, presence });
    await w.ready;
    await until(() => events.some((e) => e.kind === "imported" && e.file === "ok.pdf"));
    await sleep(1500);
    expect(judged).toBeGreaterThan(0);
    expect(opened(join(real, "moved.pdf"))).toEqual([]);
    expect(events.filter((e) => e.file === "moved.pdf")).toEqual([]);
    expect(w.status().counts.waiting).toBe(1);
  });

  it("an unknown file is listed with its own sentence and never opened", async () => {
    const p = await project();
    const real = await realpath(inbox);
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) if (q.endsWith("mystery.pdf")) m.set(q, { presence: "unknown" });
      return m;
    };
    await writeFile(join(inbox, "mystery.pdf"), "%PDF-1.7 twelve");
    const opened = readSpies();
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    expect(WATCH_REASONS.unknownPresence).toBe("The app could not tell whether this file is on this Mac, so it has left it alone.");
    expect(w.status().counts.notDownloadedBytes).toBe(15);
    expect(w.problems(page(10)).items).toEqual([{ file: "mystery.pdf", kind: "not-downloaded", reason: WATCH_REASONS.unknownPresence, bytes: 15 }]);
    await sleep(500);
    expect(opened(join(real, "mystery.pdf"))).toEqual([]);
  });
});

describe("cloud-drive folders: fix round 1 (A6, R213)", () => {
  const noTitle = (extra: string) => buildPdf({ lines: ["Some page text without a title that we could use."], extra });
  const RIS = "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nER  - \n";
  const page = (n: number) => ({ offset: 0, limit: n });
  /** A stand-in for `fs.watch` that records its calls and hands back emitters the test can feed. */
  function fakeWatch() {
    const calls: Array<[string, unknown]> = [];
    const emitters: EventEmitter[] = [];
    const fn = ((d: string, o: unknown) => {
      calls.push([d, o]);
      const e = Object.assign(new EventEmitter(), { close: () => {}, ref: () => e, unref: () => e });
      emitters.push(e);
      return e;
    }) as unknown as typeof fs.watch;
    return { calls, emitters, fn };
  }
  /** The real `fs.watch`, counting the handles left open. */
  function countedWatch() {
    const handles = { open: 0, closed: 0 };
    const fn = ((d: string, o: { persistent?: boolean; recursive?: boolean }) => {
      const w = fs.watch(d, o);
      handles.open++;
      const close = w.close.bind(w);
      let done = false;
      w.close = () => {
        if (!done) handles.closed++;
        done = true;
        close();
      };
      return w;
    }) as unknown as typeof fs.watch;
    return { handles, fn };
  }

  it("a sidecar still changing beside a stable file is never read (C1)", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "paper.pdf"), await noTitle("c1"));
    await writeFile(join(inbox, "paper.ris"), RIS);
    const opened = readSpies();
    const timer = setInterval(() => void appendFile(join(inbox, "paper.ris"), "N1  - more\n").catch(() => {}), 50);
    try {
      const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
      await w.ready;
      await until(() => events.some((e) => e.file === "paper.pdf" && e.kind === "imported"));
      expect(opened(join(real, "paper.ris"))).toEqual([]);
    } finally {
      clearInterval(timer);
      await sleep(100);
    }
    const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
    expect(sf.source.title.variants[0]?.value ?? "").not.toBe("Weaving and Kinship in Highland Markets");
  });

  it("a stable sidecar that is on this computer is used", async () => {
    const p = await project();
    await writeFile(join(inbox, "paper.pdf"), await noTitle("c1b"));
    await writeFile(join(inbox, "paper.ris"), RIS);
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await until(() => events.some((e) => e.file === "paper.pdf" && e.kind === "imported"));
    const sf = await repo.getSource(p.id, events.find((e) => e.file === "paper.pdf")!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Weaving and Kinship in Highland Markets");
  });

  it("a file evicted between the type sniff and the copy is never opened again and nothing stays in the library (M1)", async () => {
    const p = await project();
    const real = await realpath(inbox);
    const f = join(real, "evicted.pdf");
    await writeFile(join(inbox, "evicted.pdf"), await buildPdf({ title: "Evicted", extra: "evicted" }));
    let evicted = false;
    let opens = 0;
    const opened = readSpies();
    vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      const r = await realFspOpen(...a);
      if (String(a[0]) === f && ++opens === 2) evicted = true; // 1: the engine's hash, 2: attach's type sniff
      return r;
    }) as typeof fsp.open);
    syncBuiltinESMExports();
    const lstatS = async (q: string) => {
      const s = await fsp.lstat(q, { bigint: true });
      return evicted && q === f ? (Object.assign(Object.create(Object.getPrototypeOf(s) as object), s, { blocks: 0n }) as typeof s) : s;
    };
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, fs: { lstat: lstatS } });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    expect(opens).toBe(2); // the hash and the sniff, through the open stand-in
    expect(opened(f)).toEqual([]); // and no other read of any kind (attach's hash stream, the copy)
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a symbolic link swapped in for the file is not followed (M1)", async () => {
    const p = await project();
    const real = await realpath(inbox);
    const f = join(real, "linked.pdf");
    const away = join(tmp, "away.pdf");
    await writeFile(join(inbox, "linked.pdf"), await buildPdf({ title: "Linked", extra: "linked" }));
    let swapped = false;
    let followed = false;
    const openS = async (q: string, flags?: number) => {
      if (!swapped && q === f) {
        swapped = true;
        await rename(f, away);
        await symlink(away, f);
      }
      const fh = await fsp.open(q, flags);
      if (swapped && q === f) followed = true; // opened through the link
      return fh;
    };
    const opened = readSpies();
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, fs: { open: openS } });
    await w.ready;
    await until(() => w.problems(page(10)).items.some((i) => i.file === "linked.pdf" && i.reason === WATCH_REASONS.outside));
    expect(swapped).toBe(true);
    expect(followed).toBe(false);
    expect(opened(away)).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("linux form: a folder deleted and made again under the same name is watched and listed at once; no handle is left (I1)", async () => {
    const p = await project();
    await mkdir(join(inbox, "Sub"));
    await writeFile(join(inbox, "Sub", "one.pdf"), await buildPdf({ title: "One", extra: "one" }));
    const { handles, fn } = countedWatch();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, recursive: true, watcherForm: "per-folder", fsWatch: fn });
    await w.ready;
    await until(() => events.some((e) => e.kind === "imported" && e.file === "Sub/one.pdf"));
    expect(handles.open - handles.closed).toBe(2);
    await rm(join(inbox, "Sub"), { recursive: true });
    await until(() => handles.open - handles.closed === 1);
    await mkdir(join(inbox, "Sub"));
    await sleep(300);
    await writeFile(join(inbox, "Sub", "two.pdf"), await buildPdf({ title: "Two", extra: "two" }));
    await until(() => events.some((e) => e.kind === "imported" && e.file === "Sub/two.pdf"), 10_000);
    expect(handles.open - handles.closed).toBe(2);
    await w.stop();
    expect(handles.open - handles.closed).toBe(0);
  });

  it("darwin form: ONE recursive watcher for the whole tree, fed with relative paths as FSEvents gives them", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await mkdir(join(inbox, "Sub", "Deeper"), { recursive: true });
    const fake = fakeWatch();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, recursive: true, watcherForm: "tree", fsWatch: fake.fn });
    await w.ready;
    await sleep(300);
    await writeFile(join(inbox, "Sub", "Deeper", "fed.pdf"), await buildPdf({ title: "Fed", extra: "fed" }));
    fake.emitters[0]!.emit("change", "rename", "Sub/Deeper/fed.pdf");
    await until(() => events.some((e) => e.kind === "imported" && e.file === "Sub/Deeper/fed.pdf"));
    expect(fake.calls).toEqual([[real, { recursive: true, persistent: true }]]);
  });

  it("a watcher is set up only after the folder has answered, never while a call on it is stuck", async () => {
    const p = await project();
    const real = await realpath(inbox);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const readdirS = async (d: string) => {
      if (hold && d === real) await held;
      return fsp.readdir(d, { withFileTypes: true });
    };
    const fake = fakeWatch();
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, watcherForm: "tree", fsWatch: fake.fn, fs: { readdir: readdirS } });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    await sleep(300);
    expect(fake.calls).toEqual([]);
    hold = false;
    release();
    await until(() => w.status().state === "watching");
    expect(fake.calls).toHaveLength(1);
  });

  /** File-system stand-ins that count every call outstanding on the folder; the first `read` of a file is held. */
  function heldReadFs() {
    const s = { outstanding: 0, most: 0, closes: 0, release: () => {} };
    const held = new Promise<void>((r) => (s.release = r));
    let holdRead = true;
    const count = async <T>(fn: () => Promise<T>): Promise<T> => {
      s.most = Math.max(s.most, ++s.outstanding);
      try {
        return await fn();
      } finally {
        s.outstanding--;
      }
    };
    const fsS = {
      lstat: (q: string) => count(() => fsp.lstat(q, { bigint: true })),
      readdir: (q: string) => count(() => fsp.readdir(q, { withFileTypes: true })),
      stat: (q: string) => count(() => fsp.stat(q)),
      realpath: (q: string) => count(() => fsp.realpath(q)),
      open: async (q: string, flags?: number) => {
        const fh = await count(() => fsp.open(q, flags));
        return {
          read: (...a: Parameters<typeof fh.read>) =>
            count(async () => {
              if (holdRead) {
                holdRead = false;
                await held;
              }
              return fh.read(...(a as unknown as [Buffer, number, number, null]));
            }),
          close: () => count(() => (s.closes++, fh.close())),
        } as unknown as fsp.FileHandle;
      },
    };
    return { s, fsS };
  }

  it("stop() issues nothing on a folder whose call is stuck; the stuck read's handle is closed once it settles (I2)", async () => {
    const p = await project();
    await writeFile(join(inbox, "big.pdf"), await buildPdf({ title: "Big", extra: "big" }));
    const { s, fsS } = heldReadFs();
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: fsS });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    await w.stop();
    expect(s.closes).toBe(0);
    expect(s.outstanding).toBe(1);
    s.release();
    await until(() => s.closes === 1);
    expect(s.most).toBe(1);
  });

  it("when a stuck read answers at last, its close takes its turn beside the folder's other calls (I2)", async () => {
    const p = await project();
    await writeFile(join(inbox, "big.pdf"), await buildPdf({ title: "Big again", extra: "big2" }));
    const { s, fsS } = heldReadFs();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: fsS });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    s.release();
    await until(() => events.some((e) => e.kind === "imported" && e.file === "big.pdf"));
    expect(s.closes).toBeGreaterThanOrEqual(1);
    expect(s.most).toBe(1);
  });

  it("a folder with a call outstanding stays \"Cannot be reached\" for a new watch, which issues nothing until it settles", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "after.pdf"), await buildPdf({ title: "After", extra: "after" }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    let calls = 0;
    const readdirS = async (d: string) => {
      calls++;
      if (hold && d === real) await held;
      return fsp.readdir(d, { withFileTypes: true });
    };
    const lstatS = async (q: string) => (calls++, fsp.lstat(q, { bigint: true }));
    const a = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: { readdir: readdirS, lstat: lstatS } });
    await a.w.ready;
    await until(() => a.w.status().state === "unreachable");
    await a.w.stop();
    const n = calls;
    const b = start(p, { stabilityMs: 200, pollMs: 50, fsTimeoutMs: 300, fs: { readdir: readdirS, lstat: lstatS } });
    await b.w.ready;
    expect(b.w.status()).toMatchObject({ state: "unreachable", reason: withProvider(WATCH_REASONS.notResponding, null) });
    await sleep(500);
    expect(calls).toBe(n);
    hold = false;
    release();
    await until(() => b.events.some((e) => e.kind === "imported" && e.file === "after.pdf"));
  });

  it("an event naming a not-downloaded file re-checks it at once (M7)", async () => {
    const p = await project();
    let online = true;
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) {
        const s = m.get(q);
        if (online && q.endsWith("later.pdf") && s?.presence === "local") m.set(q, { ...s, presence: "not-downloaded" });
      }
      return m;
    };
    await writeFile(join(inbox, "later.pdf"), await buildPdf({ title: "Later by event", extra: "event" }));
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    online = false;
    await sleep(600);
    expect(events.some((e) => e.file === "later.pdf")).toBe(false); // no round in 60 s
    await chmod(join(inbox, "later.pdf"), 0o600); // an event that changes no size, time or block
    await until(() => events.some((e) => e.kind === "imported" && e.file === "later.pdf"), 5000);
  });

  it("otherwise files not downloaded are re-checked once per WATCH_RECHECK_MS (M7, fake time)", async () => {
    expect(WATCH_RECHECK_MS).toBe(60_000);
    const p = await project();
    await sparse(join(inbox, "online.pdf"), 10_000);
    let asked = 0;
    const presence: typeof contentState = async (paths, o) => {
      if (paths.some((q) => q.endsWith("online.pdf"))) asked++;
      return contentState(paths, o);
    };
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    const k = asked;
    await sleep(600);
    expect(asked).toBe(k);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_001);
      await sleep(600);
      expect(asked).toBe(k + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a file the system refuses to open, and a folder it refuses to list, are \"not-permitted\" and counted (M4, M5)", async () => {
    const p = await project();
    const real = await realpath(inbox);
    await writeFile(join(inbox, "locked.pdf"), await buildPdf({ title: "Locked", extra: "locked" }));
    await mkdir(join(inbox, "Private"));
    const eacces = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
    const openS = async (q: string, flags?: number) => (q === join(real, "locked.pdf") ? Promise.reject(eacces()) : fsp.open(q, flags));
    const readdirS = async (d: string) => (d === join(real, "Private") ? Promise.reject(eacces()) : fsp.readdir(d, { withFileTypes: true }));
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, recursive: true, fs: { open: openS, readdir: readdirS } });
    await w.ready;
    await until(() => w.status().counts.didNotComeIn === 2);
    expect(w.problems({ kind: "not-permitted", offset: 0, limit: 10 }).items.map((i) => [i.file, i.reason]).sort()).toEqual([
      ["Private", WATCH_REASONS.fileNotPermitted],
      ["locked.pdf", WATCH_REASONS.fileNotPermitted],
    ]);
    expect(WATCH_REASONS.fileNotPermitted).toBe("The app was not allowed to read this file.");
  });

  it("a renamed file that already came in is not counted or announced as a duplicate (M3)", async () => {
    const p = await project();
    const { w, events } = start(p, { stabilityMs: 200, pollMs: 50 });
    await w.ready;
    await writeFile(join(inbox, "first.pdf"), await buildPdf({ title: "Renamed", extra: "renamed" }));
    await until(() => events.some((e) => e.kind === "imported" && e.file === "first.pdf"));
    await rename(join(inbox, "first.pdf"), join(inbox, "second.pdf"));
    await sleep(1500);
    expect(events.filter((e) => e.file === "second.pdf")).toEqual([]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, alreadyInLibrary: 0, waiting: 0 });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
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
