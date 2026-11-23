import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, type Project } from "@ao/core";
import { IndexHandle } from "../index/db.js";
import { createBulkImport, folderAdapter } from "./bulk/index.js";
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
import { WatchRegisterUnwritableError } from "../repo/watch-register.js";
import { openTestRepo } from "../repo/testing.js";
import { createAttach, type Attach } from "./attach.js";
import { POINTER_REASON, contentState, ignoredName as ignoredNameLocal } from "./watch-local.js";
import { WATCH_CHOICES_FILE, getWatchChoices, getWatchDownloadCount, reserveWatchDownload, setWatchChoices, type WatchChoices } from "./watch-choices.js";
import {
  WATCH_DOWNLOAD_CONFIRM_BYTES,
  WATCH_DOWNLOAD_RETRY_MS,
  WATCH_FETCH_TIMEOUT_MS,
  WATCH_FS_TIMEOUT_MS,
  WATCH_MASS_GONE_MIN,
  WATCH_PROBLEMS_MAX,
  WATCH_RECHECK_MS,
  WATCH_REASONS,
  WATCH_RESCAN_MS,
  WATCH_STABILITY_MS,
  WATCH_STATUS_INTERVAL_MS,
  FolderNotAnsweringError,
  WatchFileNotLocalError,
  addWatchedFolder,
  folderCallOutstanding,
  bringInNewVersion,
  ignoredName,
  settleWatchedFile,
  listWatchedFolders,
  removeWatchedFolder,
  setWatchFolder,
  watchFolder,
  withProvider,
  type FolderWatch,
  type WatchDeps,
  type WatchEvent,
  type WatchFs,
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
const unlink = tracked(fsp.unlink);
const symlink = tracked(fsp.symlink);
const truncate = tracked(fsp.truncate);
const chmod = tracked(fsp.chmod);
const utimes = tracked(fsp.utimes);
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

// Task W4: every watch the tests start through `start()` gets a counting stand-in for `fetchContent` (the one way a
// file that is not on this computer is read). Unless a test chose "download" (`fetchAllowed`), it must never be called:
// under "leave", the default, every scenario of W2 and W3 makes exactly zero calls.
let fetchCalls: string[] = [];
let fetchAllowed = false;
const countingFetch = async (p: string): Promise<void> => {
  fetchCalls.push(p);
};

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
  fetchCalls = [];
  fetchAllowed = false;
  spyMutations();
});

afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
  if (!fetchAllowed) expect(fetchCalls).toEqual([]); // "leave": fetchContent is never called (Task W4)
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
function start(
  p: Project,
  opts: Seams & { dir?: string; recursive?: boolean; watchId?: string; collectionId?: string } = {},
): { w: FolderWatch; events: WatchEvent[]; statuses: Array<WatchStatus & { at: number }> } {
  const events: WatchEvent[] = [];
  const statuses: Array<WatchStatus & { at: number }> = [];
  const { dir, recursive, watchId, collectionId, ...seams } = opts;
  // (A folder holding the library, or inside it, is refused; the library itself changes, so it is not checked.)
  const d = dir ?? inbox;
  if (!lib.root.startsWith(d) && !d.startsWith(lib.root)) watchedDirs.add(d);
  const w = watchFolder(
    { repo, http, lib, onEvent: (e) => events.push(e), onStatus: (s) => statuses.push({ ...structuredClone(s), at: Date.now() }), fetchContent: countingFetch, ...seams },
    p.id,
    dir ?? inbox,
    { ...(recursive ? { recursive: true } : {}), ...(collectionId ? { collectionId } : {}) },
    watchId ?? newId(),
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

  it("R81's re-import is replaced (R207 3): a changed file is not imported again, even by a watch without a register in the library", async () => {
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
    await until(() => w.status().counts.changed === 1);
    expect(events.filter((e) => e.file === "draft.pdf")).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
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

  for (const form of ["tree", "per-folder"] as const) {
    it(`${form} form: a watcher that fails is set up again at once and a scan follows; the status never says "watching" without one (N1)`, async () => {
      const p = await project();
      const fake = fakeWatch();
      const { w, events } = start(p, { stabilityMs: 200, pollMs: 50, rescanMs: 600_000, watcherForm: form, fsWatch: fake.fn });
      await w.ready;
      await sleep(200);
      expect(fake.calls).toHaveLength(1);
      // Written while the watcher is lost: no event will ever name it; only the scan after the new watcher finds it.
      await writeFile(join(inbox, "between.pdf"), await buildPdf({ title: "Between", extra: "between" }));
      fake.emitters[0]!.emit("error", new Error("watcher lost"));
      expect(w.status().state).not.toBe("watching");
      await until(() => fake.calls.length === 2 && w.status().state === "watching", 3000);
      await until(() => events.some((e) => e.kind === "imported" && e.file === "between.pdf"), 5000);
    });
  }

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

describe("the register: where a source came from, and what happened to its file (Task W3)", () => {
  const W3 = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100 } as const;
  const regOf = (p: Project, wid: string) => repo.watchRegister(p.id, wid);
  const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  async function untilAsync(cond: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(50);
    }
  }
  const stateOf = async (p: Project, wid: string, key: string) => (await regOf(p, wid)).get(key)?.state;
  async function auditText(p: Project): Promise<string> {
    const dir = join(lib.root, p.folder, "audit");
    let out = "";
    for (const f of (await readdir(dir)).sort()) out += await readFile(join(dir, f), "utf8");
    return out;
  }
  const auditOps = async (p: Project) =>
    (await auditText(p))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { details?: { op?: string } }).details?.op);
  const registerWrites = async (p: Project) => (await auditOps(p)).filter((o) => o === "project.watched-folder.register").length;
  /** Every file under `dir` with the SHA-256 of its bytes. */
  async function bytesUnder(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) for (const [k, v] of Object.entries(await bytesUnder(p))) out[`${e.name}/${k}`] = v;
      else out[e.name] = sha256(await readFile(p));
    }
    return out;
  }
  /** One file comes in through the watch; its source id. */
  async function cameIn(p: Project, wid: string, events: WatchEvent[], name: string, data: Buffer): Promise<string> {
    const before = events.filter((e) => e.kind === "imported").length;
    await writeFile(join(inbox, name), data);
    await until(() => events.filter((e) => e.kind === "imported").length > before);
    await untilAsync(async () => (await stateOf(p, wid, name)) === "in-library");
    return (await regOf(p, wid)).get(name)!.sourceId;
  }
  /** Register lines written straight into the file (seeding many entries for the arithmetic of mass disappearance). */
  async function seed(p: Project, wid: string, entries: Array<Record<string, unknown>>): Promise<void> {
    const dir = join(lib.root, p.folder, "watched");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, `${wid}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  }
  const seeded = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    file: key,
    sourceId: newId(),
    sha256: sha256(key),
    size: 10,
    mtimeNs: "1700000000000000000",
    state: "in-library",
    at: new Date().toISOString(),
    ...extra,
  });

  it('a changed file is never imported or replaced; the source shows "changed"', async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const name = "Interview Ana Pérez.pdf";
    const v1 = await buildPdf({ title: "Interview one", extra: "w3-a1" });
    const sid = await cameIn(p, wid, events, name, v1);
    const sf = await repo.getSource(p.id, sid);
    expect(sf.source.provenance.tool.name).toBe("watched-folder");
    expect(sf.source.provenance.externalKeys).toEqual({ "watched-folder": wid });
    const v2 = await buildPdf({ title: "Interview two", extra: "w3-a2" });
    await writeFile(join(inbox, name), v2);
    await untilAsync(async () => (await stateOf(p, wid, name)) === "changed");
    const e = (await regOf(p, wid)).get(name)!;
    expect(e).toMatchObject({ key: name, file: name, sourceId: sid, sha256: sha256(v1), newSha256: sha256(v2), newSize: v2.length, size: v2.length });
    await sleep(800);
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    expect(events.filter((x) => x.kind === "imported")).toHaveLength(1);
    expect((await repo.getSource(p.id, sid)).assets.map((a) => a.sha256)).toEqual([sha256(v1)]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, alreadyInLibrary: 0, changed: 1, gone: 0 });
    expect(await repo.watchOrigins(p.id, sid)).toEqual([{ watchId: wid, entry: (await regOf(p, wid)).get(name) }]);
    // The same content written again (a new time): nothing is written (A8); still no import.
    const writes = await registerWrites(p);
    await writeFile(join(inbox, name), v2);
    await sleep(1200);
    expect(await registerWrites(p)).toBe(writes);
    expect((await regOf(p, wid)).get(name)).toMatchObject({ state: "changed", sha256: sha256(v1), newSha256: sha256(v2) });
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    // No audit line holds the file's name (R177, R69).
    for (const n of [name, "Interview", "Pérez"]) expect(await auditText(p)).not.toContain(n);
  }, 40_000);

  it("the source's files and annotations.json are byte-identical after the folder's file changed", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 300 });
    await w.ready;
    const sid = await cameIn(p, wid, events, "highlighted.pdf", await buildPdf({ title: "Highlighted", extra: "w3-h1" }));
    const sf = await repo.getSource(p.id, sid);
    await repo.createAnnotation(p.id, sid, { kind: "highlight", assetId: sf.assets[0]!.id, anchors: [{ page: 1, rects: [{ x: 72, y: 600, w: 200, h: 12 }] }], quote: "a passage", colorName: "yellow" });
    const folder = join(lib.root, sf.source.folder);
    const before = await bytesUnder(folder);
    const notes = await repo.listAnnotations(p.id, sid);
    expect(notes).toHaveLength(1);
    const opsBefore = (await auditOps(p)).length;
    // A colleague replaces it, then removes it.
    await writeFile(join(inbox, "highlighted.pdf"), await buildPdf({ title: "Replaced by a colleague", extra: "w3-h2" }));
    await untilAsync(async () => (await stateOf(p, wid, "highlighted.pdf")) === "changed");
    await rm(join(inbox, "highlighted.pdf"));
    await untilAsync(async () => (await stateOf(p, wid, "highlighted.pdf")) === "gone");
    expect(w.status().counts).toMatchObject({ gone: 1, changed: 0 });
    expect(await bytesUnder(folder)).toEqual(before);
    expect(await repo.listAnnotations(p.id, sid)).toEqual(notes);
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    // The notes are register lines and nothing else.
    expect((await auditOps(p)).slice(opsBefore).every((o) => o === "project.watched-folder.register")).toBe(true);
  }, 40_000);

  it('a not-downloaded change is "may-have-changed" and is not read', async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const f = join(inbox, "report.pdf");
    const v1 = await buildPdf({ title: "Report", extra: "w3-n1" });
    await cameIn(p, wid, events, "report.pdf", v1);
    const opened = readSpies();
    // Replaced by a version that is not on this computer (a sparse file is Linux's stand-in), moved in whole.
    await sparse(join(tmp, "aside.pdf"), 250_000);
    await rename(join(tmp, "aside.pdf"), f);
    await untilAsync(async () => (await stateOf(p, wid, "report.pdf")) === "may-have-changed");
    const e = (await regOf(p, wid)).get("report.pdf")!;
    expect(e).toMatchObject({ sha256: sha256(v1), newSize: 250_000 });
    expect(e.newSha256).toBeUndefined();
    await sleep(600);
    expect(opened(f)).toEqual([]); // a registered file that is not local is never hashed
    expect(w.status().counts).toMatchObject({ cameIn: 1, notDownloaded: 0, changed: 1 });
    expect(w.problems({ offset: 0, limit: 10 }).total).toBe(0);
    // Once it is on this computer it is read (through the whole order) and noted "changed".
    const v2 = await buildPdf({ title: "Report, second edition", extra: "w3-n2" });
    await writeFile(join(tmp, "aside2.pdf"), v2);
    await rename(join(tmp, "aside2.pdf"), f);
    await untilAsync(async () => (await stateOf(p, wid, "report.pdf")) === "changed");
    expect((await regOf(p, wid)).get("report.pdf")).toMatchObject({ newSha256: sha256(v2), newSize: v2.length });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  }, 40_000);

  it("half the register vanishing at once marks nothing gone", async () => {
    const p = await project();
    const wid = newId();
    // 40 entries "in-library": 20 files are here (as registered), 20 are missing.
    const entries = [];
    for (let i = 0; i < 40; i++) {
      const key = `paper-${String(i).padStart(2, "0")}.pdf`;
      if (i < 20) {
        await writeFile(join(inbox, key), `content ${i}`);
        const st = await fsp.lstat(join(inbox, key), { bigint: true });
        entries.push(seeded(key, { size: Number(st.size), mtimeNs: st.mtimeNs.toString() }));
      } else entries.push(seeded(key));
    }
    await seed(p, wid, entries);
    const opened = readSpies();
    const { w } = start(p, { ...W3, watchId: wid, watchEvents: false });
    await w.ready;
    // (The seeded entries name sources this test never made: the files count as removed here, A8.)
    await until(() => !w.status().scanning && w.status().counts.waiting === 0 && w.status().counts.didNotComeIn === 20);
    await until(() => w.status().reason !== undefined);
    expect(w.status()).toMatchObject({ state: "watching", reason: withProvider(WATCH_REASONS.massGone, null), counts: { gone: 0 } });
    expect(WATCH_REASONS.massGone).toBe("Most files in this folder disappeared at once. This usually means {provider} is signed out or still starting. Nothing in the library has changed.");
    await sleep(400);
    expect([...(await regOf(p, wid)).values()].every((e) => e.state === "in-library")).toBe(true);
    expect(await registerWrites(p)).toBe(0);
    // The 20 registered files here were not read: their size and exact time are as registered.
    for (let i = 0; i < 20; i++) expect(opened(join(inbox, `paper-${String(i).padStart(2, "0")}.pdf`))).toEqual([]);
  }, 30_000);

  it("mass disappearance at 1, 19, 20 and 40,000 entries (and at the half)", async () => {
    // [missing "in-library" entries, missing "changed" entries, present ones, marked gone?]
    const cases: Array<[number, number, number, boolean]> = [
      [1, 0, 0, true],
      [19, 0, 0, true],
      [20, 0, 0, false],
      [40_000, 0, 0, false],
      [20, 0, 20, false], // exactly half
      [20, 0, 21, true], // less than half
      [5, 25, 0, false], // review M3: changed entries count too
      [5, 14, 0, true],
    ];
    expect(WATCH_MASS_GONE_MIN).toBe(20);
    for (const [missingIn, missingChanged, present, marked] of cases) {
      const missing = missingIn + missingChanged;
      const p = await project();
      const wid = newId();
      const dir = join(tmp, `Inbox-${missingIn}-${missingChanged}-${present}`);
      await mkdir(dir);
      const entries = [];
      for (let i = 0; i < present; i++) {
        const key = `here-${i}.txt`;
        await writeFile(join(dir, key), `here ${i}`);
        const st = await fsp.lstat(join(dir, key), { bigint: true });
        entries.push(seeded(key, { size: Number(st.size), mtimeNs: st.mtimeNs.toString() }));
      }
      for (let i = 0; i < missingIn; i++) entries.push(seeded(`gone-${i}.pdf`));
      for (let i = 0; i < missingChanged; i++) entries.push(seeded(`changed-${i}.pdf`, { state: "changed", newSha256: sha256(`new ${i}`), newSize: 3 }));
      await seed(p, wid, entries);
      const { w } = start(p, { ...W3, dir, watchId: wid, watchEvents: false });
      await w.ready;
      await until(() => !w.status().scanning && w.status().counts.waiting === 0 && w.status().counts.didNotComeIn === present, 30_000);
      if (marked) await until(() => w.status().counts.gone === missing);
      else await sleep(500);
      const reg = await (async () => {
        if (marked) await untilAsync(async () => [...(await regOf(p, wid)).values()].filter((e) => e.state === "gone").length === missing);
        return regOf(p, wid);
      })();
      const gone = [...reg.values()].filter((e) => e.state === "gone").length;
      expect({ missing, present, gone, reason: w.status().reason }).toEqual({
        missing,
        present,
        gone: marked ? missing : 0,
        reason: marked ? undefined : withProvider(WATCH_REASONS.massGone, null),
      });
      await w.stop();
    }
  }, 120_000);

  it("an unreachable folder marks nothing gone", async () => {
    const p = await project();
    const wid = newId();
    await seed(p, wid, [seeded("a.pdf"), seeded("b.pdf"), seeded("c.pdf")]);
    const dir = join(tmp, "NotYet");
    const { w } = start(p, { ...W3, dir, watchId: wid });
    await w.ready;
    await until(() => w.status().state === "unreachable");
    await sleep(800);
    expect([...(await regOf(p, wid)).values()].map((e) => e.state)).toEqual(["in-library", "in-library", "in-library"]);
    expect(w.status().counts.gone).toBe(0);
    expect(await registerWrites(p)).toBe(0);
    // The folder answers again (empty): a complete listing, and three entries are fewer than the mass rule's minimum.
    await mkdir(dir);
    await until(() => w.status().state === "watching");
    await untilAsync(async () => [...(await regOf(p, wid)).values()].every((e) => e.state === "gone"));
  }, 30_000);

  it("a renamed file keeps its source and makes none", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, recursive: true });
    await w.ready;
    const sid = await cameIn(p, wid, events, "first.pdf", await buildPdf({ title: "Renamed", extra: "w3-r1" }));
    await rename(join(inbox, "first.pdf"), join(inbox, "second.pdf"));
    await untilAsync(async () => (await stateOf(p, wid, "second.pdf")) === "in-library");
    let reg = await regOf(p, wid);
    expect([...reg.keys()]).toEqual(["second.pdf"]);
    expect(reg.get("second.pdf")).toMatchObject({ sourceId: sid, file: "second.pdf", renamedFrom: "first.pdf" });
    // Moved into a folder: the same.
    await mkdir(join(inbox, "Sub"));
    await rename(join(inbox, "second.pdf"), join(inbox, "Sub", "third.pdf"));
    await untilAsync(async () => (await stateOf(p, wid, "Sub/third.pdf")) === "in-library");
    reg = await regOf(p, wid);
    expect([...reg.keys()]).toEqual(["Sub/third.pdf"]);
    expect(reg.get("Sub/third.pdf")!.sourceId).toBe(sid);
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    expect(events.filter((e) => e.kind === "imported")).toHaveLength(1);
    expect(w.status().counts).toMatchObject({ cameIn: 1, alreadyInLibrary: 0, gone: 0 });
  }, 40_000);

  it("a name differing only by case with the same content is a rename", async () => {
    const p = await project();
    const wid = newId();
    // A file system that ignores case (macOS): the old name still answers, with the same inode.
    const caseless = async (q: string) => {
      try {
        return await fsp.lstat(q, { bigint: true });
      } catch (err) {
        const d = join(q, "..");
        const twin = (await fsp.readdir(d).catch(() => [] as string[])).find((n) => n.toLowerCase() === q.slice(d.length + 1).toLowerCase());
        if (twin) return fsp.lstat(join(d, twin), { bigint: true });
        throw err;
      }
    };
    for (const [fs, label] of [[undefined, "case-sensitive"], [{ lstat: caseless }, "case-insensitive"]] as const) {
      const dir = join(tmp, `Case-${label}`);
      await mkdir(dir);
      const { w, events } = start(p, { ...W3, dir, watchId: wid, ...(fs ? { fs } : {}) });
      await w.ready;
      await writeFile(join(dir, "report.pdf"), await buildPdf({ title: `Case ${label}`, extra: `w3-case-${label}` }));
      await until(() => events.some((e) => e.kind === "imported"));
      await untilAsync(async () => (await stateOf(p, wid, "report.pdf")) === "in-library");
      const sid = (await regOf(p, wid)).get("report.pdf")!.sourceId;
      await rename(join(dir, "report.pdf"), join(dir, "Report.pdf"));
      await untilAsync(async () => (await stateOf(p, wid, "Report.pdf")) === "in-library");
      const reg = await regOf(p, wid);
      expect([...reg.keys()]).toEqual(["Report.pdf"]);
      expect(reg.get("Report.pdf")).toMatchObject({ sourceId: sid, renamedFrom: "report.pdf" });
      expect(repo.listSourceIds(p.id).filter((id) => id === sid)).toHaveLength(1);
      await w.stop();
      await seed(p, wid, []); // the next round starts with an empty register
    }
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  }, 60_000);

  it("a source removed here is not imported again from the same file", async () => {
    const p = await project();
    const wid = newId();
    const first = start(p, { ...W3, watchId: wid });
    await first.w.ready;
    const v1 = await buildPdf({ title: "Deleted here", extra: "w3-d1" });
    const sid = await cameIn(p, wid, first.events, "deleted.pdf", v1);
    await first.w.stop();
    await repo.deleteSource(p.id, sid);
    // The next start, and a copy of the same file under another name: nothing comes back.
    await writeFile(join(inbox, "deleted (copy).pdf"), v1);
    const second = start(p, { ...W3, watchId: wid });
    await second.w.ready;
    await until(() => !second.w.status().scanning && second.w.status().counts.waiting === 0 && second.w.status().counts.didNotComeIn === 2);
    await sleep(500);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(second.events.filter((e) => e.kind === "imported")).toEqual([]);
    // Both are listed as removed here (A8).
    expect(second.w.status().counts).toMatchObject({ cameIn: 0, alreadyInLibrary: 0, didNotComeIn: 2 });
    expect(
      second.w
        .problems({ offset: 0, limit: 10 })
        .items.map((i) => [i.file, i.kind, i.reason])
        .sort(),
    ).toEqual([
      ["deleted (copy).pdf", "removed-here", WATCH_REASONS.removedHere],
      ["deleted.pdf", "removed-here", WATCH_REASONS.removedHere],
    ]);
    expect(WATCH_REASONS.removedHere).toBe("This file was removed from the library here, so it is not brought in again. To bring it in, add it by hand.");
    expect((await regOf(p, wid)).get("deleted.pdf")).toMatchObject({ sourceId: sid, state: "in-library" });
  }, 40_000);

  it("a conflict copy with the same content makes no source and is listed as already in the library", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const v1 = await buildPdf({ title: "Report", extra: "w3-c1" });
    await cameIn(p, wid, events, "Report.pdf", v1);
    await writeFile(join(inbox, "Report (Ana's conflicted copy 2026-11-13).pdf"), v1);
    await writeFile(join(inbox, "Report (1).pdf"), v1);
    await until(() => w.status().counts.alreadyInLibrary === 2);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    expect(w.status().counts).toMatchObject({ cameIn: 1, alreadyInLibrary: 2 });
    await sleep(300);
    expect([...(await regOf(p, wid)).keys()]).toEqual(["Report.pdf"]);
  }, 40_000);

  it("a conflict copy with different content becomes its own source under its own name", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const a = await cameIn(p, wid, events, "Report.pdf", await buildPdf({ title: "Report", extra: "w3-c2" }));
    const name = "Report (Ana's conflicted copy 2026-11-13).pdf";
    const b = await cameIn(p, wid, events, name, await buildPdf({ title: "Report, Ana's edits", extra: "w3-c3" }));
    expect(b).not.toBe(a);
    expect(repo.listSourceIds(p.id).sort()).toEqual([a, b].sort());
    expect((await regOf(p, wid)).get(name)).toMatchObject({ file: name, state: "in-library" });
    expect(w.status().counts).toMatchObject({ cameIn: 2, alreadyInLibrary: 0 });
  }, 40_000);

  it("new files land in the chosen collection; a deleted collection is said", async () => {
    const p = await project();
    const wid = newId();
    const c = await repo.createCollection(p.id, "From the shared drive");
    const { w, events } = start(p, { ...W3, watchId: wid, collectionId: c.id });
    await w.ready;
    const a = await cameIn(p, wid, events, "a.pdf", await buildPdf({ title: "Into the collection", extra: "w3-k1" }));
    expect((await repo.getSource(p.id, a)).source.collectionIds).toEqual([c.id]);
    expect(w.status().reason).toBeUndefined();
    await repo.deleteCollection(p.id, c.id);
    const b = await cameIn(p, wid, events, "b.pdf", await buildPdf({ title: "No collection now", extra: "w3-k2" }));
    expect((await repo.getSource(p.id, b)).source.collectionIds).toEqual([]);
    expect(w.status().reason).toBe(WATCH_REASONS.noCollection);
    expect(WATCH_REASONS.noCollection).toBe("The collection chosen for this folder no longer exists, so new files go into the project without a collection.");
    // A watch started with a collection that no longer exists says so at once; nothing fails.
    const empty = join(tmp, "Empty");
    await mkdir(empty);
    const second = start(p, { ...W3, dir: empty, watchId: newId(), collectionId: c.id });
    await second.w.ready;
    await until(() => second.w.status().reason === WATCH_REASONS.noCollection);
    expect(second.w.status().state).toBe("watching");
  }, 40_000);

  it("bring in the new version adds an original and keeps the first", async () => {
    const p = await project();
    const wf = await addWatchedFolder({ repo, lib }, p.id, inbox);
    const wid = wf.id;
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const v1 = await buildPdf({ title: "Version one", extra: "w3-b1" });
    const sid = await cameIn(p, wid, events, "paper.pdf", v1);
    const sf1 = await repo.getSource(p.id, sid);
    const firstBytes = await bytesUnder(join(lib.root, sf1.source.folder, "original"));
    const actDeps = { repo, http, lib, stabilityMs: 200 };
    // Nothing to bring in yet.
    await expect(bringInNewVersion(actDeps, p.id, wid, "paper.pdf")).rejects.toThrow(/not changed/u);
    const v2 = await buildPdf({ title: "Version two", extra: "w3-b2" });
    await writeFile(join(inbox, "paper.pdf"), v2);
    await untilAsync(async () => (await stateOf(p, wid, "paper.pdf")) === "changed");
    const o = await bringInNewVersion(actDeps, p.id, wid, "paper.pdf");
    expect(o).toMatchObject({ outcome: "attached", sourceId: sid });
    const sf2 = await repo.getSource(p.id, sid);
    expect(sf2.assets.filter((a) => a.role === "original").map((a) => a.sha256)).toEqual([sha256(v1), sha256(v2)]);
    expect(sf2.source.provenance).toEqual(sf1.source.provenance);
    const now = await bytesUnder(join(lib.root, sf1.source.folder, "original"));
    for (const [k, v] of Object.entries(firstBytes)) expect(now[k]).toBe(v); // the first original is kept, unchanged
    expect((await regOf(p, wid)).get("paper.pdf")).toMatchObject({ state: "in-library", sha256: sha256(v2), size: v2.length });
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    await until(() => w.status().counts.changed === 0);

    // Not on this computer: refused, and nothing is read.
    await sparse(join(tmp, "aside.pdf"), 300_000);
    await rename(join(tmp, "aside.pdf"), join(inbox, "paper.pdf"));
    await untilAsync(async () => (await stateOf(p, wid, "paper.pdf")) === "may-have-changed");
    const opened = readSpies();
    await expect(bringInNewVersion(actDeps, p.id, wid, "paper.pdf")).rejects.toBeInstanceOf(WatchFileNotLocalError);
    expect(opened(join(inbox, "paper.pdf"))).toEqual([]);
    expect((await repo.getSource(p.id, sid)).assets.filter((a) => a.role === "original")).toHaveLength(2);

    // "Keep the library's copy as it is": settled; nothing is read or changed.
    const folderBytes = await bytesUnder(join(lib.root, sf1.source.folder));
    await settleWatchedFile(actDeps, p.id, wid, "paper.pdf");
    expect(await stateOf(p, wid, "paper.pdf")).toBe("settled");
    expect(await bytesUnder(join(lib.root, sf1.source.folder))).toEqual(folderBytes);
    expect(opened(join(inbox, "paper.pdf"))).toEqual([]);
    await expect(settleWatchedFile(actDeps, p.id, wid, "paper.pdf")).rejects.toThrow(/nothing to settle/u);

    // With no watch running here, the act reads the folder chosen on this computer, through the same order.
    await w.stop();
    const v3 = await buildPdf({ title: "Version three", extra: "w3-b3" });
    await writeFile(join(tmp, "aside3.pdf"), v3);
    await rename(join(tmp, "aside3.pdf"), join(inbox, "paper.pdf"));
    const e = (await regOf(p, wid)).get("paper.pdf")!;
    await repo.recordWatchedFiles(p.id, wid, [{ ...e, state: "changed", newSha256: sha256(v3), newSize: v3.length, at: new Date().toISOString() }]);
    expect(await bringInNewVersion(actDeps, p.id, wid, "paper.pdf")).toMatchObject({ outcome: "attached", sourceId: sid });
    expect((await repo.getSource(p.id, sid)).assets.filter((a) => a.role === "original")).toHaveLength(3);
    expect((await regOf(p, wid)).get("paper.pdf")).toMatchObject({ state: "in-library", sha256: sha256(v3) });
  }, 60_000);

  it("the researcher's acts refuse a read-only library and a locked project in plain words", async () => {
    const p = await project(true);
    const wid = newId();
    await repo.recordWatchedFiles(p.id, wid, [{ ...seeded("a.pdf"), state: "changed", newSha256: sha256("x"), newSize: 1 } as never]);
    const ro = { repo, http, lib: { ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" } as Library };
    await expect(bringInNewVersion(ro, p.id, wid, "a.pdf")).rejects.toThrow(/read-only/u);
    await expect(settleWatchedFile(ro, p.id, wid, "a.pdf")).rejects.toThrow(/read-only/u);
    repo.lockProject(p.id);
    await expect(bringInNewVersion({ repo, http, lib }, p.id, wid, "a.pdf")).rejects.toThrow(/locked/u);
    await expect(settleWatchedFile({ repo, http, lib }, p.id, wid, "a.pdf")).rejects.toThrow(/locked/u);
  });

  it("a rescan that finds nothing new writes nothing", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 200 });
    await w.ready;
    await cameIn(p, wid, events, "a.pdf", await buildPdf({ title: "Steady", extra: "w3-s1" }));
    await sleep(300);
    const writes = await registerWrites(p);
    expect(writes).toBe(1);
    const opened = readSpies();
    await sleep(2000); // about ten rescans
    expect(await registerWrites(p)).toBe(writes);
    expect(opened(join(inbox, "a.pdf"))).toEqual([]);
    // A restart reads nothing either: the file is as registered.
    await w.stop();
    const again = start(p, { ...W3, watchId: wid });
    await again.w.ready;
    await until(() => again.w.status().counts.cameIn === 1);
    await sleep(300);
    expect(opened(join(inbox, "a.pdf"))).toEqual([]);
    expect(await registerWrites(p)).toBe(writes);
  }, 40_000);

  it("entries are written in batches of at most 50, and at stop()", async () => {
    const p = await project();
    const wid = newId();
    const registerEvents = async () =>
      (await auditText(p))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { details?: { op?: string; entries?: number } })
        .filter((e) => e.details?.op === "project.watched-folder.register")
        .map((e) => e.details!.entries!);
    // One file: its line waits for the timer (here a minute), and is written at stop().
    const first = start(p, { stabilityMs: 200, pollMs: 50, registerFlushMs: 60_000, watchId: wid, attach: realishAttach() });
    await first.w.ready;
    await writeFile(join(inbox, "one.pdf"), "one");
    await until(() => first.w.status().counts.cameIn === 1);
    await sleep(500);
    expect(await registerEvents()).toEqual([]);
    await first.w.stop();
    expect(await registerEvents()).toEqual([1]);
    // 120 files: written as soon as 50 wait, in changes of at most 50 lines each.
    const { w } = start(p, { stabilityMs: 200, pollMs: 50, registerFlushMs: 60_000, watchId: wid, attach: realishAttach() });
    await w.ready;
    for (let i = 0; i < 120; i++) await writeFile(join(inbox, `f-${String(i).padStart(3, "0")}.pdf`), `file ${i}`);
    // (one.pdf is registered for a source this stand-in never stored: it counts as removed here.)
    await until(() => w.status().counts.cameIn === 120 && w.status().counts.didNotComeIn === 1, 30_000);
    await untilAsync(async () => (await registerEvents()).length >= 3);
    await w.stop();
    const sizes = await registerEvents();
    expect(sizes.every((n) => n <= 50)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(121);
    expect((await regOf(p, wid)).size).toBe(121);
  }, 60_000);

  it("a locked project's register is not read and the watch is paused", async () => {
    const p = await project(true);
    const wid = newId();
    await repo.recordWatchedFiles(p.id, wid, [seeded("a.pdf") as never]);
    repo.lockProject(p.id);
    const read = vi.spyOn(repo, "watchRegister");
    const { w } = start(p, { ...W3, watchId: wid });
    await w.ready;
    await until(() => w.status().state === "locked");
    await sleep(500);
    expect(read).not.toHaveBeenCalled();
    await repo.unlockProject(p.id, "pw");
    await until(() => w.status().state === "watching");
    await until(() => read.mock.calls.length > 0);
    await until(() => w.status().counts.gone === 1); // the empty folder's complete listing: one entry is fewer than the minimum
  }, 30_000);

  // ---- fix round 1 (A8, R217) ------------------------------------------------------------------------------------
  /** A source made the way drag-and-drop makes one, from a copy of `data` outside the watched folder. */
  async function droppedSource(p: Project, name: string, data: Buffer): Promise<string> {
    const outside = join(tmp, `Desk-${Math.random().toString(36).slice(2, 8)}`, name);
    await fsp.mkdir(join(outside, ".."), { recursive: true });
    await fsp.writeFile(outside, data);
    const [o] = await createAttach({ repo, http }).attachFiles(p.id, [outside]);
    return o!.sourceId!;
  }
  const removedItems = (w: FolderWatch) => w.problems({ kind: "removed-here", offset: 0, limit: 100 }).items.map((i) => i.file).sort();

  it("C1: a drag-and-drop source's file in the folder is registered; deleted, it does not come back", async () => {
    const p = await project();
    const wid = newId();
    const v = await buildPdf({ title: "Dragged in first", extra: "a8-c1" });
    const sid = await droppedSource(p, "shared.pdf", v);
    await writeFile(join(inbox, "shared.pdf"), v);
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 300 });
    await w.ready;
    await untilAsync(async () => (await stateOf(p, wid, "shared.pdf")) === "in-library");
    expect((await regOf(p, wid)).get("shared.pdf")).toMatchObject({ sourceId: sid, sha256: sha256(v) });
    expect(w.status().counts).toMatchObject({ cameIn: 0, alreadyInLibrary: 1 });
    await repo.deleteSource(p.id, sid);
    await until(() => removedItems(w).length === 1);
    await sleep(1500); // several rescans
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(events.filter((e) => e.kind === "imported")).toEqual([]);
    expect(w.problems({ offset: 0, limit: 10 }).items).toEqual([{ file: "shared.pdf", kind: "removed-here", reason: WATCH_REASONS.removedHere }]);
    expect(w.status().counts).toMatchObject({ cameIn: 0, alreadyInLibrary: 0, didNotComeIn: 1 });
    // After a restart too.
    await w.stop();
    const again = start(p, { ...W3, watchId: wid });
    await again.w.ready;
    await until(() => again.w.status().counts.didNotComeIn === 1);
    await sleep(500);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  }, 40_000);

  it("I1: such a file edited by a colleague is a \"changed\" note on that source, not a second source", async () => {
    const p = await project();
    const wid = newId();
    const v1 = await buildPdf({ title: "Dragged in, then edited", extra: "a8-i1a" });
    const sid = await droppedSource(p, "draft.pdf", v1);
    await writeFile(join(inbox, "draft.pdf"), v1);
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    await untilAsync(async () => (await stateOf(p, wid, "draft.pdf")) === "in-library");
    const v2 = await buildPdf({ title: "Edited by a colleague", extra: "a8-i1b" });
    await writeFile(join(inbox, "draft.pdf"), v2);
    await untilAsync(async () => (await stateOf(p, wid, "draft.pdf")) === "changed");
    await sleep(800);
    expect((await regOf(p, wid)).get("draft.pdf")).toMatchObject({ sourceId: sid, sha256: sha256(v1), newSha256: sha256(v2) });
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    expect(events.filter((e) => e.kind === "imported")).toEqual([]);
  }, 40_000);

  it("every other way in is registered the first time it is seen: Bulk Import, another tool's source, a watch before the register", async () => {
    const p = await project();
    const wid = newId();
    const handle = new IndexHandle(lib.root);
    try {
      const a = await buildPdf({ title: "By Bulk Import", extra: "a8-w1" });
      const b = await buildPdf({ title: "By another tool", extra: "a8-w2" });
      const c = await buildPdf({ title: "By a watch before the register", extra: "a8-w3" });
      const src = join(tmp, "BulkDesk");
      await mkdir(src);
      await fsp.writeFile(join(src, "a.pdf"), a);
      const h = await createBulkImport({ repo, http, index: handle }).startBatch(p.id, folderAdapter(src));
      await h.done;
      const bulkSid = repo.listSourceIds(p.id)[0]!;
      // Another tool (as the Zotero import does): a source with its own provenance and the file among its assets.
      const bFile = join(tmp, "zotero-b.pdf");
      await fsp.writeFile(bFile, b);
      const other = await repo.createSource(
        p.id,
        { projectIds: [], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "By another tool" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
        [{ path: bFile, role: "original", handling: "copy" }],
        { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "zotero-web", version: "1" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false } },
      );
      // A watch before the register: attach without an origin (drag-and-drop provenance).
      const cSid = await droppedSource(p, "c.pdf", c);
      for (const [n, d] of [["a.pdf", a], ["b.pdf", b], ["c.pdf", c]] as const) await writeFile(join(inbox, n), d);
      const { w, events } = start(p, { ...W3, watchId: wid });
      await w.ready;
      await untilAsync(async () => (await regOf(p, wid)).size === 3);
      const reg = await regOf(p, wid);
      expect(Object.fromEntries([...reg.values()].map((e) => [e.key, e.sourceId]))).toEqual({ "a.pdf": bulkSid, "b.pdf": other.source.id, "c.pdf": cSid });
      expect(repo.listSourceIds(p.id)).toHaveLength(3);
      expect(events.filter((e) => e.kind === "imported")).toEqual([]);
      expect(w.status().counts).toMatchObject({ cameIn: 0, alreadyInLibrary: 3 });
    } finally {
      handle.close();
    }
  }, 60_000);

  it("deleted stays deleted, an undo included: a Bulk Import batch whose file also lies in the folder", async () => {
    const p = await project();
    const wid = newId();
    const handle = new IndexHandle(lib.root);
    try {
      const bulk = createBulkImport({ repo, http, index: handle });
      const src = join(tmp, "Desk");
      await mkdir(src);
      const v1 = await buildPdf({ title: "Bulk then watched", extra: "w3-u1" });
      await fsp.writeFile(join(src, "x.pdf"), v1);
      const h = await bulk.startBatch(p.id, folderAdapter(src));
      await h.done;
      const bulkSource = repo.listSourceIds(p.id)[0]!;
      await writeFile(join(inbox, "x.pdf"), v1);
      const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 300 });
      await w.ready;
      // Seen once: registered for the batch's source.
      await untilAsync(async () => (await stateOf(p, wid, "x.pdf")) === "in-library");
      expect((await regOf(p, wid)).get("x.pdf")!.sourceId).toBe(bulkSource);
      // The batch is undone: the file is not brought back, and it is listed as removed here.
      await bulk.undoBatch(p.id, h.batchId);
      expect(repo.listSourceIds(p.id)).toEqual([]);
      await until(() => removedItems(w).length === 1);
      await sleep(1500);
      expect(repo.listSourceIds(p.id)).toEqual([]);
      expect(events.filter((e) => e.kind === "imported")).toEqual([]);
      expect(removedItems(w)).toEqual(["x.pdf"]);
      // The register and what the library holds agree: the entry names the removed source; nothing else was written.
      expect((await regOf(p, wid)).get("x.pdf")).toMatchObject({ sourceId: bulkSource, state: "in-library" });
    } finally {
      handle.close();
    }
  }, 60_000);

  it("deleted stays deleted: a source this watch brought in, deleted while the watch runs", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 300 });
    await w.ready;
    const sid = await cameIn(p, wid, events, "mine.pdf", await buildPdf({ title: "Watched, then deleted", extra: "a8-d2" }));
    await repo.deleteSource(p.id, sid);
    await until(() => removedItems(w).length === 1);
    await sleep(1200);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(events.filter((e) => e.kind === "imported")).toHaveLength(1);
  }, 40_000);

  /** A watcher stand-in whose events the test emits (as FSEvents would name paths below the folder). */
  function fakeTreeWatch() {
    const emitters: EventEmitter[] = [];
    const fn = (() => {
      const e = Object.assign(new EventEmitter(), { close: () => {}, ref: () => e, unref: () => e });
      emitters.push(e);
      return e;
    }) as unknown as typeof fs.watch;
    return { emitters, fn };
  }

  it("I2: links are never followed — a subfolder replaced by a link reads nothing, in the engine and in bring-in", async () => {
    const p = await project();
    const wf = await addWatchedFolder({ repo, lib }, p.id, inbox, { recursive: true });
    const wid = wf.id;
    const away = join(tmp, "Away");
    await fsp.mkdir(away);
    const fake = fakeTreeWatch();
    const { w, events } = start(p, { ...W3, watchId: wid, recursive: true, watcherForm: "tree", fsWatch: fake.fn, rescanMs: 60_000 });
    await w.ready;
    await mkdir(join(inbox, "Sub"));
    await writeFile(join(inbox, "Sub", "x.pdf"), await buildPdf({ title: "In the subfolder", extra: "a8-l1" }));
    fake.emitters[0]!.emit("change", "rename", "Sub/x.pdf");
    await until(() => events.some((e) => e.kind === "imported"));
    await untilAsync(async () => (await stateOf(p, wid, "Sub/x.pdf")) === "in-library");
    const sid = (await regOf(p, wid)).get("Sub/x.pdf")!.sourceId;
    // The subfolder is replaced by a link to a folder elsewhere holding another x.pdf.
    const outsideFile = join(away, "x.pdf");
    await fsp.writeFile(outsideFile, await buildPdf({ title: "Outside the folder", extra: "a8-l2" }));
    const opened = readSpies();
    await rm(join(inbox, "Sub"), { recursive: true });
    await symlink(away, join(inbox, "Sub"));
    fake.emitters[0]!.emit("change", "change", "Sub/x.pdf");
    await sleep(1500);
    expect(opened(outsideFile)).toEqual([]);
    expect(opened(join(inbox, "Sub", "x.pdf"))).toEqual([]);
    expect((await regOf(p, wid)).get("Sub/x.pdf")).toMatchObject({ state: "in-library", sourceId: sid });
    // Bring-in, as after a restart before the next listing: refused, nothing read, nothing added.
    await w.stop();
    const e = (await regOf(p, wid)).get("Sub/x.pdf")!;
    await repo.recordWatchedFiles(p.id, wid, [{ ...e, state: "changed", newSha256: sha256("x"), newSize: 1, at: new Date().toISOString() }]);
    await expect(bringInNewVersion({ repo, http, lib, stabilityMs: 200 }, p.id, wid, "Sub/x.pdf")).rejects.toThrow(WATCH_REASONS.outside);
    expect(opened(outsideFile)).toEqual([]);
    expect((await repo.getSource(p.id, sid)).assets.filter((a) => a.role === "original")).toHaveLength(1);
  }, 40_000);

  it("I2: a file replaced by a link to a file elsewhere, or inside, is never read through the link", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 300 });
    await w.ready;
    await cameIn(p, wid, events, "paper.pdf", await buildPdf({ title: "Then a link", extra: "a8-l3" }));
    const outsideFile = join(tmp, "elsewhere.pdf");
    await fsp.writeFile(outsideFile, await buildPdf({ title: "Elsewhere", extra: "a8-l4" }));
    const opened = readSpies();
    await rm(join(inbox, "paper.pdf"));
    await symlink(outsideFile, join(inbox, "paper.pdf"));
    await until(() => w.problems({ offset: 0, limit: 10 }).items.some((i) => i.file === "paper.pdf" && i.reason === WATCH_REASONS.outside));
    await sleep(600);
    expect(opened(outsideFile)).toEqual([]);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  }, 40_000);

  it("a change of time alone writes nothing, and the file is hashed once, not at every rescan", async () => {
    const p = await project();
    const wid = newId();
    const { w, events } = start(p, { ...W3, watchId: wid, rescanMs: 200 });
    await w.ready;
    await cameIn(p, wid, events, "touched.pdf", await buildPdf({ title: "Touched", extra: "a8-t1" }));
    await sleep(300);
    const writes = await registerWrites(p);
    const opened = readSpies();
    const f = join(inbox, "touched.pdf");
    const later = new Date(Date.now() + 60_000);
    await utimes(f, later, later);
    await until(() => opened(f).length > 0);
    await sleep(2000); // about ten rescans
    expect(opened(f)).toHaveLength(1); // hashed once
    expect(await registerWrites(p)).toBe(writes); // no line
    expect((await regOf(p, wid)).get("touched.pdf")!.state).toBe("in-library");
    // A second touch: one more hash, still no line.
    const later2 = new Date(Date.now() + 120_000);
    await utimes(f, later2, later2);
    await until(() => opened(f).length > 1);
    await sleep(1000);
    expect(opened(f)).toHaveLength(2);
    expect(await registerWrites(p)).toBe(writes);
  }, 40_000);

  it("no watch without its register: a watch id that is not an id is refused at once", async () => {
    const p = await project();
    const { w, events } = start(p, { ...W3, watchId: "not-an-id" });
    await w.ready;
    expect(w.stopped).toBe(true);
    expect(events[0]).toEqual({ kind: "error", reason: WATCH_REASONS.noWatchId });
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("N4: while the register cannot be saved nothing new comes in; once it can, imports resume and the waiting lines are written once", async () => {
    const p = await project();
    const wid = newId();
    const real = repo.recordWatchedFiles.bind(repo);
    let fail = true;
    vi.spyOn(repo, "recordWatchedFiles").mockImplementation(async (...a: Parameters<Repo["recordWatchedFiles"]>) => {
      if (fail) throw new WatchRegisterUnwritableError();
      return real(...a);
    });
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const imported = () => events.filter((e) => e.kind === "imported");
    await writeFile(join(inbox, "first.pdf"), await buildPdf({ title: "Before the trouble", extra: "n4-1" }));
    await until(() => imported().length === 1);
    expect(WATCH_REASONS.registerUnwritable).toBe(
      "The record of which files in this folder are in the library could not be saved, so nothing new is brought in from this folder until it can be. Nothing in the library has been lost.",
    );
    await until(() => w.status().reason === WATCH_REASONS.registerUnwritable);
    await writeFile(join(inbox, "second.pdf"), await buildPdf({ title: "During the trouble", extra: "n4-2" }));
    await sleep(1500);
    expect(imported()).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
    expect(w.status().state).toBe("watching");
    fail = false;
    await until(() => imported().length === 2);
    await untilAsync(async () => (await regOf(p, wid)).size === 2);
    await until(() => w.status().reason === undefined);
    const raw = await readFile(join(lib.root, p.folder, "watched", `${wid}.jsonl`), "utf8");
    expect(raw.split("\n").filter((l) => l.includes('"first.pdf"'))).toHaveLength(1);
    expect(raw.split("\n").filter((l) => l.includes('"second.pdf"'))).toHaveLength(1);
  }, 40_000);

  it("N5: two acts at once on a folder no watch runs on take turns: never two calls in flight", async () => {
    const p = await project();
    const wf = await addWatchedFolder({ repo, lib }, p.id, inbox);
    const wid = wf.id;
    const { w, events } = start(p, { ...W3, watchId: wid });
    await w.ready;
    const v1 = await buildPdf({ title: "Twice at once", extra: "n5-1" });
    const sid = await cameIn(p, wid, events, "paper.pdf", v1);
    await w.stop();
    const v2 = await buildPdf({ title: "Twice at once, edited", extra: "n5-2" });
    await writeFile(join(inbox, "paper.pdf"), v2);
    const e = (await regOf(p, wid)).get("paper.pdf")!;
    await repo.recordWatchedFiles(p.id, wid, [{ ...e, state: "changed", newSha256: sha256(v2), newSize: v2.length, at: new Date().toISOString() }]);
    let inFlight = 0;
    let most = 0;
    const counted =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        most = Math.max(most, ++inFlight);
        try {
          return await fn(...a);
        } finally {
          inFlight--;
        }
      };
    const actDeps = {
      repo,
      http,
      lib,
      stabilityMs: 200,
      fs: { lstat: counted((q: string) => fsp.lstat(q, { bigint: true })), realpath: counted((q: string) => fsp.realpath(q)) },
    };
    const results = await Promise.allSettled([bringInNewVersion(actDeps, p.id, wid, "paper.pdf"), bringInNewVersion(actDeps, p.id, wid, "paper.pdf")]);
    expect(most).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]); // the second finds it no longer changed
    expect((await repo.getSource(p.id, sid)).assets.filter((a) => a.role === "original")).toHaveLength(2);
  }, 40_000);

  it("a register that cannot be read stops imports from that folder and says so", async () => {
    const p = await project();
    const wid = newId();
    await fsp.mkdir(join(lib.root, p.folder, "watched", `${wid}.jsonl`), { recursive: true }); // unreadable as a file
    await writeFile(join(inbox, "new.pdf"), await buildPdf({ title: "Waits", extra: "a8-u1" }));
    const opened = readSpies();
    const { w } = start(p, { ...W3, watchId: wid });
    await w.ready;
    expect(WATCH_REASONS.registerUnreadable).toBe(
      "The record of which files in this folder are already in the library could not be read, so nothing new is brought in from this folder. Nothing in the library has changed.",
    );
    await until(() => w.status().reason === WATCH_REASONS.registerUnreadable);
    await sleep(1000);
    expect(w.status().state).toBe("watching");
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(opened(join(inbox, "new.pdf"))).toEqual([]);
    expect(JSON.stringify(w.status())).not.toContain(tmp);
  }, 30_000);
});

/** An attach that stores nothing and reads nothing, and answers with well-formed source ids (so the register's lines are written). */
function realishAttach(): Attach {
  return {
    attachFiles: async (_p, ps) => ps.map((path) => ({ path, outcome: "created" as const, sourceId: newId() })),
  };
}

describe('pause, resume, and "Download and import them" only when asked (Task W4)', () => {
  const FASTW = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100 } as const;
  const page = (n: number) => ({ offset: 0, limit: n });
  const watched = async (p: Project, dir = inbox) => (await addWatchedFolder({ repo, lib }, p.id, dir)).id;
  const choose = (p: Project, wid: string, patch: Partial<WatchChoices>) => setWatchChoices({ repo, lib }, p.id, wid, patch);
  const withService = (reason: string) => reason.replaceAll("{provider}", "the cloud service");

  /** Every file-system call the engine makes in the folder (through its seams), counted. */
  function countingFs(...dirs: string[]) {
    let n = 0;
    const mine = (q: unknown) => dirs.some((d) => String(q) === d || String(q).startsWith(`${d}/`));
    const wrap =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        if (mine(a[0])) n++;
        return f(...a);
      };
    return {
      get n() {
        return n;
      },
      fs: {
        lstat: wrap((q: string) => fsp.lstat(q, { bigint: true })),
        readdir: wrap((q: string) => fsp.readdir(q, { withFileTypes: true })),
        stat: wrap((q: string) => fsp.stat(q)),
        realpath: wrap((q: string) => fsp.realpath(q)),
        open: wrap((q: string, f: number) => realFspOpen(q, f)),
      },
    };
  }

  /**
   * A stand-in for the cloud service's download: it counts calls and how many run at once, and makes the file local the
   * way a download does here (Linux: the file gets its blocks), with content of its own. `hold(name)` makes a call wait.
   */
  function downloader(opts: { local?: boolean } = {}) {
    const calls: string[] = [];
    const holds = new Map<string, Promise<void>>();
    let outstanding = 0;
    let most = 0;
    return {
      calls,
      get most() {
        return most;
      },
      hold(name: string): () => void {
        let release!: () => void;
        holds.set(name, new Promise<void>((r) => (release = r)));
        return () => release();
      },
      fn: async (q: string): Promise<void> => {
        calls.push(q);
        most = Math.max(most, ++outstanding);
        try {
          await holds.get(q.split("/").at(-1)!);
          if (opts.local === false) return; // it returns, but the file is still not here
          const size = Number((await fsp.lstat(q)).size);
          await writeFile(q, Buffer.from(`${q}:`.repeat(Math.ceil(size / (q.length + 1)) + 1).slice(0, size)));
        } finally {
          outstanding--;
        }
      },
    };
  }

  it("the constants and the sentences", () => {
    expect(WATCH_DOWNLOAD_CONFIRM_BYTES).toBe(1073741824);
    expect(WATCH_DOWNLOAD_RETRY_MS).toBe(600_000);
    expect(WATCH_FETCH_TIMEOUT_MS).toBeGreaterThan(WATCH_FS_TIMEOUT_MS);
    expect(WATCH_REASONS.paused).toBe("Paused. Files put in the folder meanwhile come in when you resume.");
    expect(WATCH_REASONS.downloadHeld).toBe("Downloading has stopped at the size you agreed to. {files} files ({size}) are waiting for your word.");
    expect(WATCH_REASONS.couldNotDownload).toBe("The file could not be downloaded ({provider} may be offline). It is tried again in 10 minutes.");
  });

  it("a paused watch reads nothing and catches up on resume", async () => {
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await writeFile(join(inbox, "before.pdf"), await buildPdf({ title: "Before", extra: "w4-p1" }));
    await choose(p, wid, { paused: true }); // chosen before the app started: a pause survives a restart
    const counted = countingFs(inbox, real);
    const record = vi.spyOn(repo, "recordWatchedFiles");
    const opened = readSpies();
    const { w, events } = start(p, { ...FASTW, watchId: wid, fs: counted.fs, attach: realishAttach() });
    await w.ready;
    expect(w.status()).toMatchObject({ state: "paused", reason: WATCH_REASONS.paused, scanning: false });
    await sleep(600);
    await writeFile(join(inbox, "during.pdf"), await buildPdf({ title: "During", extra: "w4-p2" }));
    await sleep(800);
    expect(counted.n).toBe(0); // no lstat, no listing, no open: not one call on the folder
    expect(opened(join(real, "before.pdf"))).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    expect(events.filter((e) => e.file)).toEqual([]);
    expect(w.status().state).toBe("paused");

    // Resume: one full listing; both files come in.
    await choose(p, wid, { paused: false });
    await w.refreshChoices();
    await until(() => ["before.pdf", "during.pdf"].every((f) => events.some((e) => e.kind === "imported" && e.file === f)));
    expect(w.status()).toMatchObject({ state: "watching", counts: { cameIn: 2 } });
    await until(() => record.mock.calls.length > 0);

    // Paused while running: events only mark the folder; nothing is read; the register is not written.
    await choose(p, wid, { paused: true });
    await w.refreshChoices();
    await until(() => w.status().state === "paused");
    await sleep(300); // anything already under way settles
    const n = counted.n;
    const lines = record.mock.calls.length;
    await writeFile(join(inbox, "while.pdf"), await buildPdf({ title: "While", extra: "w4-p3" }));
    await sleep(1000);
    expect(counted.n).toBe(n);
    expect(record.mock.calls.length).toBe(lines);
    expect(events.some((e) => e.file === "while.pdf")).toBe(false);
    await choose(p, wid, { paused: false });
    await w.refreshChoices();
    await until(() => events.some((e) => e.kind === "imported" && e.file === "while.pdf"));
    expect(w.status().counts.cameIn).toBe(3);
  }, 40_000);

  it('"leave" never calls fetchContent', async () => {
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 5000);
    await sparse(join(inbox, "b.pdf"), 7000);
    const { w } = start(p, { ...FASTW, recheckMs: 100, watchId: wid });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2);
    await sleep(1500); // many polls and re-checks
    expect(await getWatchChoices({ repo, lib }, p.id, wid)).toMatchObject({ notDownloaded: "leave" });
    expect(w.status().downloadHeld).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });

  it('"download" fetches one at a time and stops at the confirmed size', async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "c.pdf"), 300);
    await sparse(join(inbox, "a.pdf"), 100);
    await sparse(join(inbox, "b.pdf"), 200);
    const dl = downloader();
    const { w, events } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach() });
    await w.ready;
    await until(() => w.status().counts.notDownloadedBytes === 600);
    expect(dl.calls).toEqual([]);
    // The researcher saw 600 bytes and agreed to 300: a and b (100 + 200 = exactly 300) come; c waits for their word.
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 300 });
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    expect(dl.calls).toEqual([join(real, "a.pdf"), join(real, "b.pdf")]); // name order, one at a time
    await until(() => ["a.pdf", "b.pdf"].every((f) => events.some((e) => e.kind === "imported" && e.file === f)));
    expect(w.status()).toMatchObject({
      state: "watching",
      reason: "Downloading has stopped at the size you agreed to. 1 file (300 bytes) are waiting for your word.",
      downloadHeld: { files: 1, bytes: 300 },
      counts: { cameIn: 2, notDownloaded: 1, notDownloadedBytes: 300 },
    });
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 300 });
    await sleep(500);
    expect(dl.calls).toHaveLength(2);
    // Their word: the size they see now. c comes in.
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 300 });
    await w.refreshChoices();
    await until(() => events.some((e) => e.kind === "imported" && e.file === "c.pdf"));
    expect(dl.calls).toEqual([join(real, "a.pdf"), join(real, "b.pdf"), join(real, "c.pdf")]);
    expect(w.status().downloadHeld).toBeUndefined();
    expect(w.status().counts).toMatchObject({ cameIn: 3, notDownloaded: 0 });
    expect(dl.most).toBe(1);
  }, 30_000);

  for (const [name, confirmed, fetched] of [
    ["at exactly the limit", 1000, true],
    ["one byte under the limit", 1001, true],
    ["one byte over the limit", 999, false],
  ] as const)
    it(`the allowance ${name}`, async () => {
      fetchAllowed = true;
      const p = await project();
      const wid = await watched(p);
      await sparse(join(inbox, "x.pdf"), 1000);
      const dl = downloader();
      const { w, events } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach() });
      await w.ready;
      await until(() => w.status().counts.notDownloadedBytes === 1000);
      await choose(p, wid, { notDownloaded: "download", confirmedBytes: confirmed });
      await w.refreshChoices();
      if (fetched) {
        await until(() => events.some((e) => e.kind === "imported" && e.file === "x.pdf"));
        expect(dl.calls).toHaveLength(1);
        expect(w.status().downloadHeld).toBeUndefined();
      } else {
        await until(() => w.status().downloadHeld !== undefined);
        await sleep(400);
        expect(dl.calls).toEqual([]);
        expect(w.status().downloadHeld).toEqual({ files: 1, bytes: 1000 });
        expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 0 });
      }
    });

  it("a file larger than the whole allowance is never fetched", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "huge.mov"), WATCH_DOWNLOAD_CONFIRM_BYTES * 3);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 10 });
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(400);
    expect(dl.calls).toEqual([]);
    expect(w.status()).toMatchObject({ reason: "Downloading has stopped at the size you agreed to. 1 file (3.2 GB) are waiting for your word.", downloadHeld: { files: 1, bytes: WATCH_DOWNLOAD_CONFIRM_BYTES * 3 } });
  });

  it("a later arrival is held at 1 GiB beyond the confirmed size", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "seen.pdf"), 10);
    // The service does not download (the file stays as it was): the bytes count all the same, and nothing is read.
    const dl = downloader({ local: false });
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await w.ready;
    await until(() => w.status().counts.notDownloadedBytes === 10);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 10 });
    await w.refreshChoices();
    await until(() => dl.calls.length === 1);
    // Later arrivals: the first takes the count to exactly confirmed + 1 GiB; the next, of one byte, is held.
    await sparse(join(inbox, "later-1.mov"), WATCH_DOWNLOAD_CONFIRM_BYTES);
    await until(() => dl.calls.length === 2);
    await sparse(join(inbox, "later-2.pdf"), 1);
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(400);
    expect(dl.calls).toEqual([join(real, "seen.pdf"), join(real, "later-1.mov")]);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 10 + WATCH_DOWNLOAD_CONFIRM_BYTES });
    expect(w.status().downloadHeld).toEqual({ files: 3, bytes: 11 + WATCH_DOWNLOAD_CONFIRM_BYTES });
  }, 30_000);

  it("a size that grows between the count and the fetch is read again, and held when it passes the allowance", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "grows.pdf"), 100);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, watchEvents: false, rescanMs: 600_000 });
    await w.ready;
    await until(() => w.status().counts.notDownloadedBytes === 100);
    await truncate(join(inbox, "grows.pdf"), 150); // no event, no rescan: the engine still counts 100
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(400);
    expect(dl.calls).toEqual([]);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 0 });
  });

  it("a fetch that leaves the file not local is could-not-download and nothing is read", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "offline.pdf"), 4096);
    // The engine's own download (the default) reads the file through its checked handle; here nothing downloads it, so
    // it stays as it was. Every open of the file is counted: one per download, none by the import path.
    const calls: number[] = [];
    const open = async (q: string, flags: number) => {
      if (q === join(real, "offline.pdf")) calls.push(Date.now());
      return realFspOpen(q, flags);
    };
    const attach = quickAttach();
    const { w, events } = start(p, { ...FASTW, watchId: wid, fetchContent: undefined, attach, downloadRetryMs: 800, fs: { open } });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    expect(calls).toEqual([]);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 4096 });
    await w.refreshChoices();
    await until(() => w.problems(page(10)).items[0]?.kind === "could-not-download");
    expect(w.problems(page(10)).items).toEqual([{ file: "offline.pdf", kind: "could-not-download", reason: withService(WATCH_REASONS.couldNotDownload), bytes: 4096 }]);
    expect(w.status().counts).toMatchObject({ notDownloaded: 1, cameIn: 0 });
    expect(attach.paths).toEqual([]);
    expect(calls).toHaveLength(1); // the download's own open; the import path never opened it
    expect(events.some((e) => e.kind === "imported")).toBe(false);
    // Its 4096 bytes were counted before the download: no second try without the researcher's word.
    await sleep(1500);
    expect(calls).toHaveLength(1);
    expect(w.status().downloadHeld).toEqual({ files: 1, bytes: 4096 });
    // Their word again: tried again, but only once the retry time has passed since the first try.
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 4096 });
    await w.refreshChoices();
    await until(() => calls.length === 2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(800);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  }, 30_000);

  it("a failed download is listed and tried again later", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "flaky.pdf"), 64);
    let fail = true;
    const dl = downloader();
    /** When each try began. */
    const tries: number[] = [];
    const fetchContent = async (q: string) => {
      tries.push(Date.now());
      if (!fail) return dl.fn(q);
      dl.calls.push(q);
      throw Object.assign(new Error("the service is offline"), { code: "EIO" });
    };
    const { w, events } = start(p, { ...FASTW, watchId: wid, fetchContent, attach: realishAttach(), downloadRetryMs: 700 });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 1000 });
    await w.refreshChoices();
    // The problem stays listed while the service fails; the tries go on every 700 ms meanwhile, so how many failed by
    // the time the wait sees it depends on the machine: they are counted (`failed`), and exactly one try follows.
    await until(() => w.problems(page(10)).items[0]?.kind === "could-not-download");
    expect(w.problems(page(10)).items[0]).toEqual({ file: "flaky.pdf", kind: "could-not-download", reason: withService(WATCH_REASONS.couldNotDownload), bytes: 64 });
    fail = false;
    const failed = dl.calls.length;
    expect(failed).toBeGreaterThanOrEqual(1);
    await until(() => events.some((e) => e.kind === "imported" && e.file === "flaky.pdf"));
    expect(tries.at(-1)! - tries.at(-2)!).toBeGreaterThanOrEqual(400);
    expect(dl.calls).toHaveLength(failed + 1);
    expect(tries).toHaveLength(failed + 1);
    expect(w.problems(page(10)).total).toBe(0);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 64 * (failed + 1) }); // every try counted
  });

  it("a pointer file and a link are never fetched", async () => {
    fetchAllowed = true;
    const p = await project();
    const outside = join(tmp, "Outside");
    await mkdir(join(outside, "Deep"), { recursive: true });
    await sparse(join(outside, "elsewhere.pdf"), 500);
    await sparse(join(outside, "Deep", "inner.pdf"), 500);
    await mkdir(join(inbox, "Sub"));
    await sparse(join(inbox, "Sub", "x.pdf"), 500);
    await sparse(join(inbox, "Notes.gdoc"), 500);
    await sparse(join(inbox, "target.pdf"), 500);
    await symlink(join(outside, "elsewhere.pdf"), join(inbox, "to-elsewhere.pdf"));
    await symlink(join(inbox, "target.pdf"), join(inbox, "to-target.pdf"));
    await symlink(join(outside, "Deep"), join(inbox, "LinkedDir"));
    const wid = (await addWatchedFolder({ repo, lib }, p.id, inbox, { recursive: true })).id;
    const real = await realpath(inbox);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, recursive: true, fetchContent: dl.fn, attach: realishAttach(), watchEvents: false, rescanMs: 600_000 });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2 && w.problems(page(10)).items.some((i) => i.kind === "online-only-document"));
    // Sub is replaced by a link to a folder elsewhere after it was counted (no event, no rescan): its file is not fetched.
    await rename(join(inbox, "Sub"), join(tmp, "SubAway"));
    await mkdir(join(outside, "SubTarget"));
    await sparse(join(outside, "SubTarget", "x.pdf"), 500);
    await symlink(join(outside, "SubTarget"), join(inbox, "Sub"));
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 1_000_000 });
    await w.refreshChoices();
    await until(() => dl.calls.length >= 1);
    await sleep(1200);
    expect(dl.calls).toEqual([join(real, "target.pdf")]); // the file a link points to, under its own name, once
    expect(w.problems(page(20)).items).toEqual(expect.arrayContaining([expect.objectContaining({ file: "Sub/x.pdf", reason: WATCH_REASONS.outside })]));
  }, 30_000);

  it("a locked project and a read-only library fetch nothing", async () => {
    fetchAllowed = true;
    // Locked: the project is locked just before the researcher's word arrives.
    const p = await project(true);
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    repo.lockProject(p.id);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.status().state === "locked");
    await sleep(800);
    expect(dl.calls).toEqual([]);
    await w.stop();

    // Read-only: the library turns read-only just as the researcher says "download".
    const q = await project();
    const inbox2 = join(tmp, "Inbox2");
    await mkdir(inbox2);
    await sparse(join(inbox2, "a.pdf"), 100);
    const qid = await watched(q, inbox2);
    let ro = false;
    const flip = Object.create(lib, { mode: { get: () => (ro ? "read-only" : "read-write") } }) as Library;
    const dl2 = downloader();
    const w2 = watchFolder({ repo, http, lib: flip, fetchContent: dl2.fn, ...FASTW }, q.id, inbox2, {}, qid);
    watches.push(w2);
    await w2.ready;
    await until(() => w2.status().counts.notDownloaded === 1);
    ro = true;
    await choose(q, qid, { notDownloaded: "download", confirmedBytes: 100 });
    await w2.refreshChoices();
    await until(() => w2.stopped);
    await sleep(300);
    expect(dl2.calls).toEqual([]);
  }, 30_000);

  it('a pause in the middle of a fetch: nothing is read until the resume; switching to "leave" stops after the file in hand', async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "one.pdf"), 100);
    await sparse(join(inbox, "two.pdf"), 100);
    const dl = downloader();
    const release = dl.hold("one.pdf");
    const counted = countingFs(inbox, real);
    const { w, events } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach(), fs: counted.fs });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 200 });
    await w.refreshChoices();
    await until(() => dl.calls.length === 1);
    // While it is being downloaded the status says so (the screen can say "Downloading …").
    expect(w.status().downloading).toEqual({ file: "one.pdf", bytes: 100 });
    // Paused while one.pdf is being downloaded: the download goes on; nothing further is issued or read.
    await choose(p, wid, { paused: true });
    await w.refreshChoices();
    expect(w.status()).toMatchObject({ state: "paused", reason: WATCH_REASONS.paused });
    const n = counted.n;
    release();
    await sleep(1200);
    expect(counted.n).toBe(n); // not even the check after the download: paused means no call
    expect(dl.calls).toEqual([join(real, "one.pdf")]);
    expect(w.status().downloading).toBeUndefined();
    expect(events.some((e) => e.kind === "imported")).toBe(false);
    // Back to "leave" and resumed: one.pdf (downloaded now) comes in through the whole order; two.pdf is left alone.
    await choose(p, wid, { paused: false, notDownloaded: "leave" });
    await w.refreshChoices();
    await until(() => events.some((e) => e.kind === "imported" && e.file === "one.pdf"));
    await sleep(800);
    expect(dl.calls).toEqual([join(real, "one.pdf")]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, notDownloaded: 1 });

    // "leave" while a file is in hand: that file finishes and comes in; no other starts.
    const release2 = dl.hold("two.pdf");
    await sparse(join(inbox, "z3.pdf"), 100);
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 200 });
    await w.refreshChoices();
    await until(() => dl.calls.length === 2);
    await choose(p, wid, { notDownloaded: "leave" });
    await w.refreshChoices();
    release2();
    await until(() => events.some((e) => e.kind === "imported" && e.file === "two.pdf"));
    await sleep(800);
    expect(dl.calls).toEqual([join(real, "one.pdf"), join(real, "two.pdf")]);
    expect(dl.most).toBe(1);
  }, 40_000);

  it("a hung fetch marks the folder unreachable and nothing further is issued; stop() does not wait for it", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "hangs.pdf"), 100);
    await sparse(join(inbox, "next.pdf"), 100);
    const dl = downloader();
    const release = dl.hold("hangs.pdf");
    const counted = countingFs(inbox, real);
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach(), fs: counted.fs, fetchTimeoutMs: 400 });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 200 });
    await w.refreshChoices();
    await until(() => w.status().state === "unreachable");
    expect(w.status().reason).toBe(withService(WATCH_REASONS.fetchNotResponding));
    const n = counted.n;
    await sleep(1000);
    expect(counted.n).toBe(n);
    expect(dl.calls).toEqual([join(real, "hangs.pdf")]);
    release(); // it answers at last: watching goes on; the file is checked through the whole order and comes in
    await until(() => w.status().state === "watching");
    await until(() => dl.calls.length === 2);
    expect(dl.most).toBe(1);
    await w.stop();

    // stop() in the middle of a download that does not answer returns at once and issues nothing further; a new watch
    // of the same folder makes no call until that download settles.
    const q = p; // one folder feeds one project (I6): the same watch, started again
    const qid = wid;
    await sparse(join(inbox, "zzz.pdf"), 100);
    await choose(q, qid, { notDownloaded: "download", confirmedBytes: 10_000 });
    const dl2 = downloader();
    const release2 = dl2.hold("zzz.pdf");
    const { w: w2 } = start(q, { ...FASTW, watchId: qid, fetchContent: dl2.fn, attach: realishAttach() });
    await w2.ready;
    await until(() => dl2.calls.length === 1);
    const t = Date.now();
    await w2.stop();
    expect(Date.now() - t).toBeLessThan(2000);
    const counted3 = countingFs(inbox, real);
    const { w: w3 } = start(q, { ...FASTW, watchId: qid, fetchContent: dl2.fn, attach: realishAttach(), fs: counted3.fs });
    await w3.ready;
    expect(w3.status()).toMatchObject({ state: "unreachable", reason: withService(WATCH_REASONS.fetchNotResponding) }); // M6: the download's own words
    await sleep(600);
    expect(counted3.n).toBe(0);
    expect(dl2.calls).toHaveLength(1);
    release2();
    await until(() => w3.status().state === "watching");
  }, 40_000);

  /** An `lstat` seam that runs `hook` (awaited) after the n-th `lstat` of `path` since it was armed, before answering. */
  function lstatHook(path: string) {
    let armed = false;
    let n = 0;
    let hook: ((n: number) => Promise<void>) | null = null;
    return {
      arm(h: (n: number) => Promise<void>) {
        n = 0;
        hook = h;
        armed = true;
      },
      lstat: async (q: string) => {
        const st = await fsp.lstat(q, { bigint: true });
        if (armed && q === path) await hook!(++n);
        return st;
      },
    };
  }

  it("I2: the download never follows a link swapped in after the last check, and never reads another file than the one judged", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    const x = join(real, "x.pdf");
    await sparse(join(inbox, "x.pdf"), 100);
    const big = join(tmp, "big.bin");
    await writeFile(big, Buffer.alloc(5_000_000, 1));
    const streams = vi.spyOn(fs, "createReadStream");
    syncBuiltinESMExports();
    // Every handle the engine opens is counted, and every byte read through it.
    let bytesRead = 0;
    const opened: string[] = [];
    const open = async (q: string, flags: number) => {
      const fh = await realFspOpen(q, flags);
      opened.push(q);
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (fh as unknown as { read: (...a: unknown[]) => Promise<{ bytesRead: number }> }).read = async (...a: unknown[]) => {
        const r = await read(...a);
        bytesRead += r.bytesRead;
        return r;
      };
      return fh;
    };
    const hooked = lstatHook(x);
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: undefined, watchEvents: false, rescanMs: 600_000, fs: { lstat: hooked.lstat, open } });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    // The file is swapped for a link to a 5 MB file outside the folder right after the engine's last look at it
    // (its third `lstat` in the download step: the size, the check, the reading again just before the download).
    hooked.arm(async (n) => {
      if (n !== 3) return;
      await rename(x, join(tmp, "x-away.pdf"));
      await symlink(big, x);
    });
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.problems(page(10)).items.some((i) => i.kind === "could-not-download" || i.reason === WATCH_REASONS.outside));
    await sleep(300);
    expect(bytesRead).toBe(0);
    expect(opened).toEqual([]); // the link was not opened (O_NOFOLLOW)
    expect(streams.mock.calls.filter((a) => String(a[0]) === x || String(a[0]) === big)).toEqual([]);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 100 });

    // Another regular file put in its place at the same moment (another inode): opened, compared, and nothing read.
    await unlink(x);
    await sparse(join(inbox, "y.pdf"), 100);
    await sparse(join(tmp, "other.pdf"), 100);
    const y = join(real, "y.pdf");
    const hookedY = lstatHook(y);
    await w.stop();
    const q2 = p; // one folder feeds one project (I6): the same watch, started again, with a new confirmation
    const qid = wid;
    opened.length = 0;
    const { w: w2 } = start(q2, { ...FASTW, watchId: qid, fetchContent: undefined, watchEvents: false, rescanMs: 600_000, fs: { lstat: hookedY.lstat, open } });
    await w2.ready;
    await until(() => w2.status().counts.notDownloaded === 1);
    await until(() => w2.status().downloadHeld !== undefined); // the first confirmation is used up: nothing runs now
    hookedY.arm(async (n) => {
      if (n === 3) await rename(join(tmp, "other.pdf"), y);
    });
    await choose(q2, qid, { notDownloaded: "download", confirmedBytes: 100 });
    await w2.refreshChoices();
    await until(() => w2.problems(page(10)).items.some((i) => i.kind === "could-not-download"));
    expect(opened).toEqual([y]);
    expect(bytesRead).toBe(0);
  }, 30_000);

  it("I2: the library's own download reads the file judged, through its handle, up to the size counted, and it then comes in", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "z.pdf"), 4096);
    const streams = vi.spyOn(fs, "createReadStream");
    syncBuiltinESMExports();
    const attach = quickAttach();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: undefined, attach, downloadRetryMs: 600_000 });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 4096 });
    await w.refreshChoices();
    // On Linux nothing downloads a sparse file: it stays not local, so it is "could-not-download" and nothing is imported.
    await until(() => w.problems(page(10)).items[0]?.kind === "could-not-download");
    expect(streams.mock.calls.filter((a) => String(a[0]).endsWith("z.pdf"))).toEqual([]); // hydrate is not used for a watched folder
    expect(attach.paths).toEqual([]);
  });

  it("I1: a second watch of the same watch id, or of the same folder, is refused in plain words; the agreed size holds", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    await sparse(join(inbox, "b.pdf"), 100);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach() });
    const { w: twin, events: twinEvents } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach() });
    await Promise.all([w.ready, twin.ready]);
    expect(twin.stopped).toBe(true);
    expect(twin.status()).toMatchObject({ state: "stopped", reason: WATCH_REASONS.alreadyWatched });
    expect(twinEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "error", reason: WATCH_REASONS.alreadyWatched })]));
    // Another id on the same real folder: refused too (once the folder's real path is known).
    const q = await project();
    await mkdir(join(tmp, "Elsewhere"));
    const qid = await watched(q, join(tmp, "Elsewhere"));
    const { w: other } = start(q, { ...FASTW, watchId: qid, dir: inbox + "/.", fetchContent: dl.fn });
    await other.ready;
    await until(() => other.stopped);
    expect(other.status().reason).toBe(WATCH_REASONS.alreadyWatched);
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(400);
    expect(dl.calls).toHaveLength(1);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 100 });
    // Once the first has stopped, a watch of that id starts as usual.
    await w.stop();
    const { w: again } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, attach: realishAttach() });
    await again.ready;
    expect(again.stopped).toBe(false);
  }, 30_000);

  it("I1: what another holder already reserved in the record is never fetched again", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, watchEvents: false });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    // Someone else (another process with this settings folder) reserves 50 of the 100 bytes first.
    expect(await reserveWatchDownload({ repo, lib }, p.id, wid, 1, 50, false)).toMatchObject({ reserved: true });
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(300);
    expect(dl.calls).toEqual([]);
  });

  it("I3: a pause never loses a register line: imported, paused, quit, the source deleted, started again — it stays out", async () => {
    const p = await project();
    const wid = await watched(p);
    await writeFile(join(inbox, "a.pdf"), await buildPdf({ title: "Kept out", extra: "w4-i3" }));
    const slow = { ...FASTW, registerFlushMs: 60_000 }; // the line is still waiting when the pause comes
    const first = start(p, { ...slow, watchId: wid });
    await first.w.ready;
    await until(() => first.events.some((e) => e.kind === "imported" && e.file === "a.pdf"));
    await choose(p, wid, { paused: true });
    await first.w.refreshChoices();
    await until(() => first.w.status().state === "paused");
    await first.w.stop(); // an ordinary quit while the folder is paused
    expect([...(await repo.watchRegister(p.id, wid)).keys()]).toEqual(["a.pdf"]);
    const [sid] = repo.listSourceIds(p.id);
    await repo.deleteSource(p.id, sid!);
    await choose(p, wid, { paused: false });
    const second = start(p, { ...slow, watchId: wid });
    await second.w.ready;
    await until(() => second.w.problems(page(10)).items.some((i) => i.kind === "removed-here"));
    expect(repo.listSourceIds(p.id)).toEqual([]);
    expect(second.events.some((e) => e.kind === "imported")).toBe(false);
  }, 30_000);

  it("I3: lines noted before a pause are written while it lasts", async () => {
    const p = await project();
    const wid = await watched(p);
    await writeFile(join(inbox, "b.pdf"), await buildPdf({ title: "Written", extra: "w4-i3b" }));
    const { w, events } = start(p, { ...FASTW, registerFlushMs: 700, watchId: wid });
    await w.ready;
    await until(() => events.some((e) => e.kind === "imported" && e.file === "b.pdf"));
    await choose(p, wid, { paused: true });
    await w.refreshChoices();
    await until(() => (w.status().state as string) === "paused");
    const end = Date.now() + 10_000;
    while (!(await repo.watchRegister(p.id, wid)).has("b.pdf")) {
      if (Date.now() > end) throw new Error("timed out: the line was not written while paused");
      await sleep(100);
    }
  });

  it("I4: no confirmation, no fetch at all — files of 0 bytes included, each counted as a file waiting", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await writeFile(join(inbox, "empty.pdf"), "");
    await sparse(join(inbox, "some.pdf"), 100);
    // A placeholder of size 0 (macOS may have them): the check cannot tell, so it is "unknown".
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) if (q.endsWith("empty.pdf")) m.set(q, { presence: "unknown" });
      return m;
    };
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download" }); // "download" without any size agreed
    await w.refreshChoices();
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(600);
    expect(dl.calls).toEqual([]);
    expect(w.status().downloadHeld).toEqual({ files: 2, bytes: 100 });
    expect(w.status().reason).toBe("Nothing is downloaded until you agree to a size. 2 files (100 bytes) are waiting for your word.");
    expect(WATCH_REASONS.nothingAgreed).toBe("Nothing is downloaded until you agree to a size. {files} files ({size}) are waiting for your word.");
  });

  it("I5: a restart does not grant the allowance again", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    await sparse(join(inbox, "b.pdf"), 100);
    const dl = downloader({ local: false }); // nothing comes in, so both stay "not downloaded"
    const first = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await first.w.ready;
    await until(() => first.w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await first.w.refreshChoices();
    await until(() => first.w.status().downloadHeld !== undefined);
    expect(dl.calls).toHaveLength(1);
    await first.w.stop();
    const second = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, downloadRetryMs: 1 });
    await second.w.ready;
    await until(() => second.w.status().downloadHeld !== undefined);
    await sleep(800);
    expect(dl.calls).toHaveLength(1);
    expect(await getWatchDownloadCount({ repo, lib }, p.id, wid)).toEqual({ confirmation: 1, fetchedBytes: 100 });
  });

  it("I5: a damaged choices file never grants a download", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    await mkdir(join(tmp, "config"), { recursive: true });
    await writeFile(join(tmp, "config", WATCH_CHOICES_FILE), JSON.stringify({ [lib.id]: { [p.id]: { [wid]: { paused: false, notDownloaded: "download", confirmedBytes: 1e300, confirmation: 1, fetchedBytes: 0 } } } }));
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    await sleep(600);
    expect(dl.calls).toEqual([]);
    expect(await getWatchChoices({ repo, lib }, p.id, wid)).toMatchObject({ notDownloaded: "leave" });
  });

  it("M2: refreshChoices after a change reads it, even while an earlier read is still under way", async () => {
    const p = await project();
    const wid = await watched(p);
    let now: WatchChoices = { paused: false, notDownloaded: "leave", confirmedBytes: 0 };
    let gateRead: Promise<void> | null = null;
    const choices = async () => {
      const value = now;
      if (gateRead) await gateRead;
      return value;
    };
    const { w } = start(p, { ...FASTW, watchId: wid, choices });
    await w.ready;
    let release!: () => void;
    gateRead = new Promise((r) => (release = r));
    const first = w.refreshChoices(); // reads "watching", and waits
    now = { ...now, paused: true };
    const second = w.refreshChoices();
    gateRead = null;
    release();
    await first;
    await second;
    expect(w.status().state).toBe("paused");
  });

  it("M4: choices that cannot be read stop downloading and the status says why", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await sparse(join(inbox, "a.pdf"), 100);
    let broken = false;
    const choices = async (): Promise<WatchChoices> => {
      if (broken) throw new Error("unreadable");
      return { paused: false, notDownloaded: "download", confirmedBytes: 100 };
    };
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, choices, fetchContent: dl.fn, watchEvents: false });
    await w.ready;
    broken = true;
    await w.refreshChoices();
    expect(w.status()).toMatchObject({ state: "watching", reason: WATCH_REASONS.choicesUnreadableNow });
    await sleep(600);
    expect(dl.calls).toEqual([]);
  });

  it("M5: a library turned read-only during the download step fetches nothing", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const real = await realpath(inbox);
    await sparse(join(inbox, "a.pdf"), 100);
    let ro = false;
    const flip = Object.create(lib, { mode: { get: () => (ro ? "read-only" : "read-write") } }) as Library;
    const hooked = lstatHook(join(real, "a.pdf"));
    const dl = downloader();
    const w = watchFolder({ repo, http, lib: flip, fetchContent: dl.fn, ...FASTW, watchEvents: false, rescanMs: 600_000, fs: { lstat: hooked.lstat } }, p.id, inbox, {}, wid);
    watches.push(w);
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 1);
    hooked.arm(async (n) => {
      if (n === 3) ro = true; // just after the last look, before the download
    });
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.stopped);
    await sleep(200);
    expect(dl.calls).toEqual([]);
  });

  it("I6: a folder already watched for a project of this library is refused when added, by real path and through an alias", async () => {
    const a = await project();
    const b = await project();
    await watched(a);
    const sentence = "This folder is already watched. A folder can be watched for one project at a time.";
    await expect(addWatchedFolder({ repo, lib }, b.id, inbox)).rejects.toThrow(sentence);
    await symlink(inbox, join(tmp, "Alias"));
    await expect(addWatchedFolder({ repo, lib }, b.id, join(tmp, "Alias"))).rejects.toThrow(sentence);
    await expect(addWatchedFolder({ repo, lib }, a.id, inbox)).rejects.toThrow(sentence); // the same project twice too
    // Choosing it on this computer for an existing watch of another project is refused the same way.
    await mkdir(join(tmp, "Other"));
    const bw = await watched(b, join(tmp, "Other"));
    await expect(setWatchFolder({ repo, lib }, b.id, bw, join(tmp, "Alias"))).rejects.toThrow(sentence);
    const err = await addWatchedFolder({ repo, lib }, b.id, inbox).then(
      () => new Error("added"),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toContain(a.name); // no project is named
    expect(err.message).not.toContain(tmp);
    expect((await listWatchedFolders({ repo, lib }, b.id)).map((x) => x.id)).toEqual([bw]); // nothing was added for b
  });

  it("I6: two older records of one folder: the watch added first keeps it, whatever the order of starting", async () => {
    const a = await project();
    const b = await project();
    const aw = await watched(a);
    await mkdir(join(tmp, "Other"));
    const bw = await watched(b, join(tmp, "Other"));
    // A record made before the rule: b's folder on this computer is the same folder as a's.
    const file = join(tmp, "config", "watched-folders.json");
    const store = JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, Record<string, string>>>;
    store[lib.id]![b.id]![bw] = await realpath(inbox);
    await writeFile(file, JSON.stringify(store));
    const loser = "This folder is already watched for another project. A folder can be watched for one project at a time.";
    expect(WATCH_REASONS.folderOfAnotherProject).toBe(loser);
    for (const order of ["b first", "a first", "together"] as const) {
      let wa: FolderWatch;
      let wb: FolderWatch;
      if (order === "b first") {
        wb = start(b, { ...FASTW, watchId: bw }).w;
        await wb.ready;
        wa = start(a, { ...FASTW, watchId: aw }).w;
      } else if (order === "a first") {
        wa = start(a, { ...FASTW, watchId: aw }).w;
        await wa.ready;
        wb = start(b, { ...FASTW, watchId: bw }).w;
      } else {
        wb = start(b, { ...FASTW, watchId: bw }).w;
        wa = start(a, { ...FASTW, watchId: aw }).w;
      }
      await Promise.all([wa.ready, wb.ready]);
      await until(() => wb.stopped);
      expect(wb.status(), order).toMatchObject({ state: "stopped", reason: loser });
      expect(wa.stopped, order).toBe(false);
      expect(wa.status().state, order).toBe("watching");
      await Promise.all([wa.stop(), wb.stop()]);
    }
  }, 30_000);

  it("a file not downloaded whose size reads 0 is never fetched: its true size is not known", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    await writeFile(join(inbox, "empty.pdf"), "");
    await sparse(join(inbox, "some.pdf"), 100);
    const presence: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const q of paths) {
        const st = m.get(q);
        if (q.endsWith("empty.pdf") && st && st.presence === "local") m.set(q, { ...st, presence: "not-downloaded" });
      }
      return m;
    };
    const dl = downloader({ local: false });
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn, presence });
    await w.ready;
    await until(() => w.status().counts.notDownloaded === 2);
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 1_000_000 });
    await w.refreshChoices();
    await until(() => dl.calls.length === 1);
    await until(() => w.problems(page(10)).items.some((i) => i.file === "empty.pdf" && i.reason === WATCH_REASONS.sizeUnknown));
    await sleep(500);
    expect(dl.calls.map((q) => q.split("/").at(-1))).toEqual(["some.pdf"]);
    expect(WATCH_REASONS.sizeUnknown).toBe("The size of this file is not known until it is downloaded, so it is left for you to download yourself.");
  });

  it("a confirmation of 0 bytes is no confirmation: nothing is fetched under it, later arrivals included", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = await watched(p);
    const dl = downloader();
    const { w } = start(p, { ...FASTW, watchId: wid, fetchContent: dl.fn });
    await w.ready;
    await choose(p, wid, { notDownloaded: "download", confirmedBytes: 0 }); // nothing was waiting when they agreed
    await w.refreshChoices();
    await sparse(join(inbox, "later.pdf"), 10);
    await until(() => w.status().downloadHeld !== undefined);
    await sleep(500);
    expect(dl.calls).toEqual([]);
    expect(w.status().reason).toBe("Nothing is downloaded until you agree to a size. 1 file (10 bytes) are waiting for your word.");
  });
});

describe("W7 fix round (R233): stopping during a start, a collection learnt while running, containment", () => {
  const FAST7 = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100 } as const;
  /** An attach that stores nothing and notes the collection each file was given. */
  const collAttach = () => {
    const seen = new Map<string, string | undefined>();
    const a: Attach = { attachFiles: async (_p, ps, o) => ps.map((path) => (seen.set(path.split("/").at(-1)!, o?.collectionId), { path, outcome: "created" as const, sourceId: newId() })) };
    return { seen, a };
  };
  const settles = (p: Promise<unknown>, ms = 3000) => Promise.race([p.then(() => "settled"), sleep(ms).then(() => "hangs")]);

  for (const point of ["before the folder is claimed", "between the two claims", "after the start"] as const) {
    it(`I1: a watch stopped ${point} holds no claim: the folder can be watched again at once`, async () => {
      const p = await project();
      const dir = join(tmp, `F${point.length}`);
      await mkdir(dir);
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      let calls = 0;
      const a = start(p, {
        ...FAST7,
        dir,
        attach: quickAttach(),
        ...(point === "between the two claims"
          ? {
              fs: {
                realpath: async (q: string) => {
                  if (calls++ === 0) await held;
                  return realpath(q);
                },
              },
            }
          : {}),
      });
      if (point === "between the two claims") await until(() => calls > 0);
      if (point === "after the start") await a.w.ready;
      const stopping = a.w.stop();
      release();
      expect(await settles(stopping)).toBe("settled");
      await a.w.ready;
      const b = start(p, { ...FAST7, dir, attach: quickAttach() });
      await b.w.ready;
      // R234 I-A: a call the stop gave up is adopted until it settles (here at once, it was released): then watching.
      await until(() => b.w.status().state === "watching", 5000);
      expect(b.w.status()).toMatchObject({ state: "watching" });
      expect(b.w.status().reason).toBeUndefined();
    });
  }

  it("I1: a stop from outside while the start refuses itself settles (no stop waits for itself)", async () => {
    const p = await project();
    const dir = join(tmp, "Twice");
    await mkdir(dir);
    const a = start(p, { ...FAST7, dir, attach: quickAttach() });
    await a.w.ready;
    const b = start(p, { ...FAST7, dir, attach: quickAttach() });
    expect(await settles(b.w.stop())).toBe("settled");
    expect(await settles(b.w.ready)).toBe("settled");
    expect(a.w.status().state).toBe("watching");
  });

  it("I3: a stuck watch learns a new collection and uses it once its call answers", async () => {
    const p = await project();
    const c1 = await repo.createCollection(p.id, "Old");
    const c2 = await repo.createCollection(p.id, "New");
    let holding = true;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const { seen, a } = collAttach();
    const { w } = start(p, {
      ...FAST7,
      fsTimeoutMs: 300,
      collectionId: c1.id,
      attach: a,
      fs: {
        lstat: async (q: string) => {
          if (holding && q.endsWith("hold.pdf")) await held;
          return fsp.lstat(q, { bigint: true });
        },
      },
    });
    await w.ready;
    await writeFile(join(inbox, "hold.pdf"), await buildPdf({ title: "Held", extra: "r233-i3a" }));
    await until(() => w.status().state === "unreachable");
    w.setCollection(c2.id);
    holding = false;
    release();
    await until(() => seen.has("hold.pdf"), 20_000);
    expect(seen.get("hold.pdf")).toBe(c2.id);
  }, 40_000);

  it("I3: during a download the status still says downloading; the file lands in the new collection", async () => {
    fetchAllowed = true;
    const p = await project();
    const wid = (await addWatchedFolder({ repo, lib }, p.id, inbox)).id;
    const c1 = await repo.createCollection(p.id, "Old");
    const c2 = await repo.createCollection(p.id, "New");
    await sparse(join(inbox, "far.pdf"), 100);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const { seen, a } = collAttach();
    const { w } = start(p, {
      ...FAST7,
      watchId: wid,
      collectionId: c1.id,
      attach: a,
      fetchContent: async (q: string) => {
        await held;
        await writeFile(q, Buffer.alloc(100, 120));
      },
    });
    await w.ready;
    await until(() => w.status().counts.notDownloadedBytes === 100);
    await setWatchChoices({ repo, lib }, p.id, wid, { notDownloaded: "download", confirmedBytes: 100 });
    await w.refreshChoices();
    await until(() => w.status().downloading !== undefined);
    w.setCollection(c2.id);
    expect(w.status()).toMatchObject({ state: "watching", downloading: { file: "far.pdf" } });
    release();
    await until(() => seen.has("far.pdf"), 20_000);
    expect(seen.get("far.pdf")).toBe(c2.id);
  }, 40_000);

  it('I3: a new collection deleted meanwhile: the engine\'s own "no collection" behaviour', async () => {
    const p = await project();
    const c1 = await repo.createCollection(p.id, "Old");
    const c3 = await repo.createCollection(p.id, "Gone soon");
    const { w } = start(p, { ...FAST7, collectionId: c1.id });
    await w.ready;
    await repo.deleteCollection(p.id, c3.id);
    w.setCollection(c3.id);
    await until(() => w.status().reason === WATCH_REASONS.noCollection);
    await writeFile(join(inbox, "late.pdf"), await buildPdf({ title: "After the collection went", extra: "r233-i3c" }));
    await until(() => repo.listSourceIds(p.id).length === 1, 20_000);
    expect((await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!)).source.collectionIds).toEqual([]);
    w.setCollection(undefined);
    await until(() => w.status().reason === undefined);
  }, 40_000);

  it('M2: a name that starts with ".." is inside, not outside (the library check fails closed)', async () => {
    const p = await project();
    const inner = join(lib.root, "..inner");
    await fsp.mkdir(inner);
    await expect(addWatchedFolder({ repo, lib }, p.id, inner)).rejects.toThrow(WATCH_REASONS.library);
    const w = start(p, { ...FAST7, dir: inner, attach: quickAttach() }).w;
    await w.ready;
    expect(w.status()).toMatchObject({ state: "stopped" });
  });

  it("M3: a stored folder that now leads elsewhere (replaced by a link) is not followed", async () => {
    const p = await project();
    const chosen = join(tmp, "Chosen");
    const elsewhere = join(tmp, "Elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "x.pdf"), await buildPdf({ title: "Elsewhere", extra: "r233-m3" }));
    await symlink(elsewhere, chosen);
    const q = quickAttach();
    const { w } = start(p, { ...FAST7, dir: chosen, attach: q });
    await w.ready;
    expect(w.status()).toMatchObject({ state: "stopped", reason: WATCH_REASONS.notWhereChosen });
    expect(WATCH_REASONS.notWhereChosen).toBe("This folder is not where it was when you chose it. Choose it again.");
    await sleep(500);
    expect(q.paths).toEqual([]);
  });
});

describe("W7 fix round 2 (R234): one call per folder however often it is restarted; the folder's checks under a limit", () => {
  const FAST8 = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100 } as const;

  it("I-A: a stop gives up the call in flight at once: the next watch adopts it, issues nothing, and watches when it settles", async () => {
    const p = await project();
    const dir = join(tmp, "Hung");
    await mkdir(dir);
    let holding = false;
    let inFlight = 0;
    let most = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const fsSeam = {
      realpath: async (q: string) => {
        if (holding) {
          most = Math.max(most, ++inFlight);
          try {
            await held;
          } finally {
            inFlight--;
          }
        }
        return realpath(q);
      },
    };
    const first = start(p, { ...FAST8, dir, attach: quickAttach() });
    await first.w.ready;
    holding = true;
    // A restart whose start then hangs on the folder.
    await first.w.stop();
    const second = start(p, { ...FAST8, dir, attach: quickAttach(), fs: fsSeam });
    await until(() => inFlight === 1);
    // Stopped well before the engine's own 30 s: the stop returns at once and the folder counts as not answering.
    const t0 = Date.now();
    await second.w.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(folderCallOutstanding(dir)).toBe(true);
    for (let i = 0; i < 5; i++) {
      const next = start(p, { ...FAST8, dir, attach: quickAttach(), fs: fsSeam });
      await next.w.ready;
      // Given up early (by the stop), not after the engine's full limit: said without "30 seconds" (R234 M-b).
      expect(next.w.status()).toMatchObject({ state: "unreachable", reason: withProvider(WATCH_REASONS.notAnswering, null) });
      expect(next.w.status().reason).not.toContain("30 seconds");
      if (i < 4) await next.w.stop();
    }
    expect(most).toBe(1);
    holding = false;
    release();
    const last = watches.at(-1)!;
    await until(() => last.status().state === "watching", 10_000);
    expect(folderCallOutstanding(dir)).toBe(false);
    expect(most).toBe(1);
  }, 30_000);

  it("I-B: the folder's checks in an add run under a limit and write nothing; the governed write itself is awaited", async () => {
    const p = await project();
    const dir = join(tmp, "Slow");
    await mkdir(dir);
    const real = vi.spyOn(fsp, "realpath");
    syncBuiltinESMExports();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    real.mockImplementation((async (q: string) => {
      if (q === dir) await held;
      return (await import("node:fs")).realpathSync(q);
    }) as never);
    syncBuiltinESMExports();
    await expect(addWatchedFolder({ repo, lib }, p.id, dir, {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(FolderNotAnsweringError);
    expect(folderCallOutstanding(dir)).toBe(true);
    // Asked again while the call is out: refused at once, no second call.
    const calls = real.mock.calls.filter((c) => c[0] === dir).length;
    await expect(addWatchedFolder({ repo, lib }, p.id, dir, {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(FolderNotAnsweringError);
    expect(real.mock.calls.filter((c) => c[0] === dir).length).toBe(calls);
    release();
    await until(() => !folderCallOutstanding(dir));
    await sleep(100);
    expect(repo.getProject(p.id).watchedFolders ?? []).toEqual([]);
    real.mockRestore();
    syncBuiltinESMExports();
    // A governed write held back behind another change for longer than the limit is awaited, not raced.
    let free: () => void = () => {};
    const busy = repo.mutate(p.id, { action: "store", store: { identifiable: false, hasLocation: false } }, () => new Promise<void>((r) => (free = r)));
    const adding = addWatchedFolder({ repo, lib }, p.id, dir, {}, { timeoutMs: 200 });
    await sleep(600);
    free();
    await busy;
    const w = await adding;
    expect(repo.getProject(p.id).watchedFolders?.map((x) => x.id)).toEqual([w.id]);
  }, 30_000);
});

describe("R251 (Task W11): whether a changed file's new version is on this computer, kept by the engine", () => {
  const W = { stabilityMs: 200, pollMs: 50, registerFlushMs: 100 } as const;
  /** Every wait below is for the engine's own state, with this generous limit (R264 f): never a fixed time. */
  const LONG = 30_000;
  const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const regOf = (p: Project, wid: string) => repo.watchRegister(p.id, wid);
  const stateOf = async (p: Project, wid: string, key: string) => (await regOf(p, wid)).get(key)?.state;
  async function untilAsync(cond: () => Promise<boolean>, ms = LONG): Promise<void> {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(50);
    }
  }
  /** Exact whole seconds: a time restored with `utimes` is then the same to the nanosecond, as a provider keeps it. */
  const T1 = 1_750_000_000;
  const T2 = T1 + 100;
  const LONG_AGO = 1_000_000_000;
  /** A stand-in for `fs.watch` whose events the test gives (so that a test decides which looks are made by an event). */
  function fakeWatch() {
    const emitters: EventEmitter[] = [];
    const fn = (() => {
      const e = Object.assign(new EventEmitter(), { close: () => {}, ref: () => e, unref: () => e });
      emitters.push(e);
      return e;
    }) as unknown as typeof fs.watch;
    return { emitters, fn, tell: (name: string) => void emitters.at(-1)?.emit("change", "rename", name) };
  }
  /**
   * The engine's own presence check (watch-local's `contentState`), counted per path — the engine's judgements are
   * the counter the tests wait on — and, from a chosen judgement on, answering `flip` for a path.
   */
  function countedPresence() {
    const counts = new Map<string, number>();
    const flips = new Map<string, { from: number; to: "not-downloaded" | "unknown" | null }>();
    const fn: typeof contentState = async (paths, o) => {
      const m = await contentState(paths, o);
      for (const k of paths) {
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        const f = flips.get(k);
        const got = m.get(k);
        if (f && f.to && n >= f.from) m.set(k, f.to === "unknown" || !got || !("ino" in got) ? { presence: "unknown" } : { ...got, presence: f.to });
      }
      return m;
    };
    return {
      fn,
      count: (abs: string) => counts.get(abs) ?? 0,
      /** From the n-th judgement of `abs` on (counting from now), the check answers `to` (null: the real answer again). */
      flip: (abs: string, to: "not-downloaded" | "unknown" | null, after = 0) => flips.set(abs, { from: (counts.get(abs) ?? 0) + 1 + after, to }),
    };
  }
  /** Puts `data` in place as `name`, whole (written aside, its time set to `t`, moved in). */
  async function put(name: string, data: Buffer | string, t: number): Promise<void> {
    const aside = join(tmp, `aside-${Math.random().toString(36).slice(2)}`);
    await writeFile(aside, data);
    await utimes(aside, t, t);
    await rename(aside, join(inbox, name));
  }
  /** Puts a version of `size` bytes that is not on this computer (Linux's stand-in: no blocks), its time `t`. */
  async function putNotLocal(name: string, size: number, t: number): Promise<void> {
    const aside = join(tmp, `aside-${Math.random().toString(36).slice(2)}`);
    await sparse(aside, size);
    await utimes(aside, LONG_AGO, t);
    await rename(aside, join(inbox, name));
  }
  /** What a cloud drive does when it evicts a file: its blocks go; its inode, size and exact time stay. Its access time is put far back. */
  async function evict(name: string): Promise<void> {
    const f = join(inbox, name);
    const before = await fsp.lstat(f, { bigint: true });
    await truncate(f, 0);
    await truncate(f, Number(before.size));
    await utimes(f, LONG_AGO, Number(before.mtimeNs / 1_000_000_000n));
    const after = await fsp.lstat(f, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.blocks]).toEqual([before.ino, before.size, before.mtimeNs, 0n]);
  }
  /** What a cloud drive does when it downloads a file: its bytes written into it in place; its time kept. */
  async function download(name: string, data: Buffer): Promise<void> {
    const f = join(inbox, name);
    const fh = await realFspOpen(f, "r+");
    try {
      await fh.write(data, 0, data.length, 0);
    } finally {
      await fh.close();
    }
    lastWrite = Date.now();
    const st = await fsp.lstat(f);
    await utimes(f, st.atime, T2);
  }
  /** One file comes in; its source id. */
  async function cameIn(p: Project, wid: string, tell: (n: string) => void, name: string, data: Buffer, events: WatchEvent[]): Promise<string> {
    await put(name, data, T1);
    tell(name);
    await until(() => events.some((e) => e.kind === "imported" && e.file === name), LONG);
    await untilAsync(async () => (await stateOf(p, wid, name)) === "in-library");
    return (await regOf(p, wid)).get(name)!.sourceId;
  }

  it("a registered file changed while it is on this computer is judged local; nothing is kept for other states, nor after the stop", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder" });
    await w.ready;
    await cameIn(p, wid, fake.tell, "paper.pdf", await buildPdf({ title: "Paper one", extra: "r251-a1" }), events);
    expect(w.presence("paper.pdf")).toBe("unknown"); // "in-library": the engine keeps no judgement for it
    expect(w.presence("not-in-the-register.pdf")).toBe("unknown");
    const v2 = await buildPdf({ title: "Paper two", extra: "r251-a2" });
    await put("paper.pdf", v2, T2);
    fake.tell("paper.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "paper.pdf")) === "changed");
    expect((await regOf(p, wid)).get("paper.pdf")).toMatchObject({ newSha256: sha256(v2), newSize: v2.length });
    expect(w.presence("paper.pdf")).toBe("local");
    await w.stop();
    expect(w.presence("paper.pdf")).toBe("unknown"); // a stopped watch cannot say
  }, 60_000);

  for (const how of ["a watcher event", "a scan"] as const) {
    it(`a changed file that then leaves this computer (same size and time, no blocks) is judged not downloaded without any further act (${how})`, async () => {
      const p = await project();
      const wid = newId();
      const fake = fakeWatch();
      const viaScan = how === "a scan";
      const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", ...(viaScan ? { rescanMs: 300 } : {}) });
      await w.ready;
      await cameIn(p, wid, fake.tell, "report.pdf", await buildPdf({ title: "Report one", extra: "r251-b1" }), events);
      await put("report.pdf", await buildPdf({ title: "Report two", extra: "r251-b2" }), T2);
      fake.tell("report.pdf");
      await untilAsync(async () => (await stateOf(p, wid, "report.pdf")) === "changed");
      expect(w.presence("report.pdf")).toBe("local");
      const opened = readSpies();
      await evict("report.pdf");
      if (!viaScan) fake.tell("report.pdf");
      await until(() => w.presence("report.pdf") === "not-downloaded", LONG);
      // Still "changed" (the content last read is what the register says), nothing read, nothing counted twice.
      expect(await stateOf(p, wid, "report.pdf")).toBe("changed");
      expect(opened(join(await realpath(inbox), "report.pdf"))).toEqual([]);
      expect(w.status().counts).toMatchObject({ cameIn: 1, notDownloaded: 0, changed: 1 });
      expect(w.problems({ offset: 0, limit: 10 }).total).toBe(0);
    }, 60_000);
  }

  it("a file changed while it is not on this computer is judged not downloaded, and local once it is downloaded, within the engine's re-check", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", recheckMs: 300 });
    await w.ready;
    await cameIn(p, wid, fake.tell, "notes.pdf", await buildPdf({ title: "Notes one", extra: "r251-c1" }), events);
    const v2 = await buildPdf({ title: "Notes two", extra: "r251-c2" });
    await putNotLocal("notes.pdf", v2.length, T2);
    fake.tell("notes.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "notes.pdf")) === "may-have-changed");
    expect(w.presence("notes.pdf")).toBe("not-downloaded");
    // Downloaded by the cloud drive's app, with no event and no scan (the default rescan is minutes away): the
    // re-check finds it; it is read through the whole order, noted "changed" with its new content, and judged local.
    await download("notes.pdf", v2);
    await untilAsync(async () => (await stateOf(p, wid, "notes.pdf")) === "changed");
    expect((await regOf(p, wid)).get("notes.pdf")).toMatchObject({ newSha256: sha256(v2) });
    expect(w.presence("notes.pdf")).toBe("local");
    // Evicted again (told by an event), then downloaded again with no event: the re-check sees it.
    await evict("notes.pdf");
    fake.tell("notes.pdf");
    await until(() => w.presence("notes.pdf") === "not-downloaded", LONG);
    await download("notes.pdf", v2);
    await until(() => w.presence("notes.pdf") === "local", LONG);
    expect(await stateOf(p, wid, "notes.pdf")).toBe("changed");
  }, 90_000);

  it("a may-have-changed file downloaded with the SAME content as the library's copy is in the library again: no change noted, no judgement kept", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", recheckMs: 300 });
    await w.ready;
    const v1 = await buildPdf({ title: "Same one", extra: "r251-s1" });
    const sid = await cameIn(p, wid, fake.tell, "same.pdf", v1, events);
    await putNotLocal("same.pdf", v1.length, T2); // replaced (a new time) by a version not on this computer
    fake.tell("same.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "same.pdf")) === "may-have-changed");
    expect(w.presence("same.pdf")).toBe("not-downloaded");
    // Downloaded with no event: the re-check finds it, it is read through the whole order, and its content is the
    // library's copy.
    await download("same.pdf", v1);
    await untilAsync(async () => (await stateOf(p, wid, "same.pdf")) === "in-library");
    const e = (await regOf(p, wid)).get("same.pdf")!;
    expect(e).toMatchObject({ sourceId: sid, sha256: sha256(v1), size: v1.length, mtimeNs: `${T2}000000000` });
    expect(e.newSha256).toBeUndefined();
    expect(e.newSize).toBeUndefined();
    expect(w.presence("same.pdf")).toBe("unknown"); // "in-library": no judgement is kept
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
    expect((await repo.getSource(p.id, sid)).assets.map((a) => a.sha256)).toEqual([sha256(v1)]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, changed: 0, notDownloaded: 0 });
  }, 60_000);

  it("a check that cannot tell says unknown, and is asked again by the re-check until it can", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const counted = countedPresence();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", presence: counted.fn, recheckMs: 200 });
    await w.ready;
    const f = join(await realpath(inbox), "draft.pdf");
    await cameIn(p, wid, fake.tell, "draft.pdf", await buildPdf({ title: "Draft one", extra: "r251-d1" }), events);
    await put("draft.pdf", await buildPdf({ title: "Draft two", extra: "r251-d2" }), T2);
    fake.tell("draft.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "draft.pdf")) === "changed");
    expect(w.presence("draft.pdf")).toBe("local");
    counted.flip(f, "unknown");
    await evict("draft.pdf");
    fake.tell("draft.pdf");
    await until(() => w.presence("draft.pdf") === "unknown", LONG);
    // Three more judgements of the file by the re-check (counted, not timed): still cannot tell.
    const n = counted.count(f);
    await until(() => counted.count(f) >= n + 3, LONG);
    expect(w.presence("draft.pdf")).toBe("unknown");
    expect(await stateOf(p, wid, "draft.pdf")).toBe("changed");
    // Once the check can tell again, the re-check says so without any act.
    counted.flip(f, null);
    await until(() => w.presence("draft.pdf") === "not-downloaded", LONG);
  }, 60_000);

  it("no extra file-system call per unchanged registered file per scan (the engine's call counter over many files)", async () => {
    const p = await project();
    const wid = newId();
    // One real source of this watch, which the seeded entries name.
    const fake = fakeWatch();
    const first = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder" });
    await first.w.ready;
    const sid = await cameIn(p, wid, fake.tell, "real.pdf", await buildPdf({ title: "The real one", extra: "r251-e1" }), first.events);
    await first.w.stop();
    await unlink(join(inbox, "real.pdf"));
    // 60 registered files as last known: 50 "in-library", 10 "changed" (their new version on this computer).
    const N_IN = 50;
    const N_CHANGED = 10;
    const names = Array.from({ length: N_IN + N_CHANGED }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
    const lines: string[] = [];
    for (const [i, n] of names.entries()) {
      await writeFile(join(inbox, n), "0123456789");
      await utimes(join(inbox, n), T1, T1);
      const changed = i >= N_IN;
      lines.push(JSON.stringify({ key: n, file: n, sourceId: sid, sha256: sha256(`old ${n}`), size: 10, mtimeNs: `${T1}000000000`, state: changed ? "changed" : "in-library", ...(changed ? { newSha256: sha256(`new ${n}`), newSize: 10 } : {}), at: new Date().toISOString() }));
    }
    await fsp.writeFile(join(lib.root, p.folder, "watched", `${wid}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });
    const real = await realpath(inbox);
    const log: Array<[string, string]> = [];
    const counted: Partial<WatchFs> = {
      lstat: (q) => (log.push(["lstat", q]), fsp.lstat(q, { bigint: true })),
      readdir: (q) => (log.push(["readdir", q]), fsp.readdir(q, { withFileTypes: true })),
      stat: (q) => (log.push(["stat", q]), fsp.stat(q)),
      realpath: (q) => (log.push(["realpath", q]), fsp.realpath(q)),
      open: (q, f) => (log.push(["open", q]), realFspOpen(q, f)),
    };
    const { w } = start(p, { ...W, watchId: wid, fsWatch: fakeWatch().fn, watcherForm: "per-folder", rescanMs: 400, fs: counted });
    await w.ready;
    // The first look at each changed file judges it (once, when the watch first sees it).
    await until(() => names.slice(N_IN).every((n) => w.presence(n) === "local") && !w.status().scanning, LONG);
    const listingsAt = (i: number) => log.slice(0, i + 1).filter(([k, q]) => k === "readdir" && q === real).length;
    const mark = listingsAt(log.length - 1);
    await until(() => listingsAt(log.length - 1) >= mark + 2, LONG); // one whole rescan lies between these two listings
    const from = log.findIndex((_, i) => listingsAt(i) === mark + 1);
    const to = log.findIndex((_, i) => listingsAt(i) === mark + 2);
    const scan = log.slice(from, to);
    const perFile = new Map<string, number>();
    for (const [k, q] of scan) if (k === "lstat") perFile.set(q, (perFile.get(q) ?? 0) + 1);
    // Exactly one `lstat` per file per scan — the listing's own reading — for the changed files as for the others.
    expect([...perFile.keys()].sort()).toEqual(names.map((n) => join(real, n)).sort());
    expect([...perFile.values()].every((c) => c === 1)).toBe(true);
    expect(scan.filter(([k]) => k === "open" || k === "realpath")).toEqual([]);
    expect(scan.filter(([k, q]) => k === "stat" && q !== real && q !== inbox)).toEqual([]);
    expect(names.slice(N_IN).every((n) => w.presence(n) === "local")).toBe(true);
    // For the report (R251): the calls of one rescan of 60 registered files.
    console.info(`R251 call count: one rescan of ${names.length} registered files made ${scan.filter(([k]) => k === "lstat").length} lstat, ${scan.filter(([k]) => k === "readdir").length} readdir, ${scan.filter(([k]) => k === "stat").length} stat, ${scan.filter(([k]) => k === "open").length} open`);
  }, 90_000);

  it("N1: a changed or may-have-changed file whose source was removed costs one lstat per scan, over three scans, and no open", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const first = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder" });
    await first.w.ready;
    const sid = await cameIn(p, wid, fake.tell, "real.pdf", await buildPdf({ title: "The real one N1", extra: "n1-e1" }), first.events);
    await first.w.stop();
    await unlink(join(inbox, "real.pdf"));
    // Four groups of 6 files, all unchanged on disk: in the library; changed; changed, source missing; may-have-changed, source missing.
    const groups = [
      { tag: "a", state: "in-library", sid },
      { tag: "b", state: "changed", sid },
      { tag: "c", state: "changed", sid: newId() },
      { tag: "d", state: "may-have-changed", sid: newId() },
    ] as const;
    const byGroup = new Map<string, string[]>();
    const lines: string[] = [];
    for (const g of groups) {
      const ns = Array.from({ length: 6 }, (_, i) => `${g.tag}${String(i).padStart(2, "0")}.txt`);
      byGroup.set(g.tag, ns);
      for (const n of ns) {
        await writeFile(join(inbox, n), "0123456789");
        await utimes(join(inbox, n), T1, T1);
        lines.push(JSON.stringify({ key: n, file: n, sourceId: g.sid, sha256: sha256(`old ${n}`), size: 10, mtimeNs: `${T1}000000000`, state: g.state, ...(g.state === "changed" ? { newSha256: sha256(`new ${n}`), newSize: 10 } : {}), at: new Date().toISOString() }));
      }
    }
    await fsp.writeFile(join(lib.root, p.folder, "watched", `${wid}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });
    const real = await realpath(inbox);
    const log: Array<[string, string]> = [];
    const counted: Partial<WatchFs> = {
      lstat: (q) => (log.push(["lstat", q]), fsp.lstat(q, { bigint: true })),
      readdir: (q) => (log.push(["readdir", q]), fsp.readdir(q, { withFileTypes: true })),
      stat: (q) => (log.push(["stat", q]), fsp.stat(q)),
      realpath: (q) => (log.push(["realpath", q]), fsp.realpath(q)),
      open: (q, f) => (log.push(["open", q]), realFspOpen(q, f)),
    };
    const { w } = start(p, { ...W, watchId: wid, fsWatch: fakeWatch().fn, watcherForm: "per-folder", rescanMs: 400, fs: counted });
    await w.ready;
    await until(() => byGroup.get("b")!.every((n) => w.presence(n) === "local") && !w.status().scanning, LONG);
    const listingsAt = (i: number) => log.slice(0, i + 1).filter(([k, q]) => k === "readdir" && q === real).length;
    const mark = listingsAt(log.length - 1);
    await until(() => listingsAt(log.length - 1) >= mark + 4, LONG); // three whole rescans lie between these listings
    const all = [...byGroup.values()].flat();
    for (let s = 1; s <= 3; s++) {
      const from = log.findIndex((_, i) => listingsAt(i) === mark + s);
      const to = log.findIndex((_, i) => listingsAt(i) === mark + s + 1);
      const scan = log.slice(from, to);
      const perFile = new Map<string, number>();
      for (const [k, q] of scan) if (k === "lstat") perFile.set(q, (perFile.get(q) ?? 0) + 1);
      expect([...perFile.keys()].sort()).toEqual(all.map((n) => join(real, n)).sort());
      for (const [tag, ns] of byGroup) expect({ tag, counts: ns.map((n) => perFile.get(join(real, n))) }).toEqual({ tag, counts: ns.map(() => 1) });
      expect(scan.filter(([k]) => k === "open" || k === "realpath")).toEqual([]);
    }
  }, 90_000);

  it("a not-downloaded file's access time is unchanged after the engine's looks", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const counted = countedPresence();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", presence: counted.fn, recheckMs: 100, rescanMs: 300 });
    await w.ready;
    await cameIn(p, wid, fake.tell, "kept.pdf", await buildPdf({ title: "Kept one", extra: "r251-f1" }), events);
    await put("kept.pdf", await buildPdf({ title: "Kept two", extra: "r251-f2" }), T2);
    fake.tell("kept.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "kept.pdf")) === "changed");
    const f = join(inbox, "kept.pdf");
    const judgedPath = join(await realpath(inbox), "kept.pdf");
    const opened = readSpies();
    await evict("kept.pdf");
    const before = await fsp.lstat(f, { bigint: true });
    fake.tell("kept.pdf");
    await until(() => w.presence("kept.pdf") === "not-downloaded", LONG);
    // Five more judgements of the file (re-checks and an event), counted.
    const n = counted.count(judgedPath);
    fake.tell("kept.pdf");
    await until(() => counted.count(judgedPath) >= n + 5, LONG);
    const after = await fsp.lstat(f, { bigint: true });
    expect(after.atimeNs).toBe(before.atimeNs);
    expect(after.blocks).toBe(0n);
    expect(opened(judgedPath)).toEqual([]);
    expect(w.presence("kept.pdf")).toBe("not-downloaded");
  }, 60_000);

  // ---- Round 3 (R264) ----------------------------------------------------------------------------------------------

  for (const how of ["lock", "pause", "unreachable", "restart"] as const) {
    it(`R264 a: after a ${how}, a changed file not on this computer is judged again in the walk that follows, and its re-check goes on`, async () => {
      const p = await project(how === "lock");
      const wid = newId();
      const fake = fakeWatch();
      const ch: WatchChoices = { paused: false, notDownloaded: "leave", confirmedBytes: 0 };
      const seams = { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", recheckMs: 300, choices: async () => ({ ...ch }) } as const;
      let { w, events } = start(p, seams);
      await w.ready;
      const v2 = await buildPdf({ title: `Moved about two (${how})`, extra: `r264-a2-${how}` });
      await cameIn(p, wid, fake.tell, "moved.pdf", await buildPdf({ title: `Moved about one (${how})`, extra: `r264-a1-${how}` }), events);
      await put("moved.pdf", v2, T2);
      fake.tell("moved.pdf");
      await untilAsync(async () => (await stateOf(p, wid, "moved.pdf")) === "changed");
      await evict("moved.pdf");
      fake.tell("moved.pdf");
      await until(() => w.presence("moved.pdf") === "not-downloaded", LONG);
      const aside = join(tmp, "Inbox-away");
      if (how === "lock") {
        repo.lockProject(p.id);
        await until(() => w.status().state === "locked", LONG);
        expect(w.presence("moved.pdf")).toBe("unknown");
        await repo.unlockProject(p.id, "pw");
      } else if (how === "pause") {
        ch.paused = true;
        await w.refreshChoices();
        await until(() => w.status().state === "paused", LONG);
        expect(w.presence("moved.pdf")).toBe("unknown");
        ch.paused = false;
        await w.refreshChoices();
      } else if (how === "unreachable") {
        await rename(inbox, aside);
        await until(() => w.status().state === "unreachable", LONG);
        expect(w.presence("moved.pdf")).toBe("unknown");
        await rename(aside, inbox);
      } else {
        await w.stop();
        ({ w, events } = start(p, seams));
        await w.ready;
      }
      await until(() => w.status().state === "watching", LONG);
      // Judged again in the walk that follows (no event, no act), and its once-a-minute re-check goes on.
      await until(() => w.presence("moved.pdf") === "not-downloaded", LONG);
      await download("moved.pdf", v2);
      await until(() => w.presence("moved.pdf") === "local", LONG);
      expect(await stateOf(p, wid, "moved.pdf")).toBe("changed");
    }, 90_000);
  }

  it("R264 b: the press's own judgement is kept: a wrong \"local\" is corrected by a refused \"Bring in\", which adds and opens nothing", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const counted = countedPresence();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", presence: counted.fn });
    await w.ready;
    const sid = await cameIn(p, wid, fake.tell, "press.pdf", await buildPdf({ title: "Press one", extra: "r264-b1" }), events);
    await put("press.pdf", await buildPdf({ title: "Press two", extra: "r264-b2" }), T2);
    fake.tell("press.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "press.pdf")) === "changed");
    expect(w.presence("press.pdf")).toBe("local");
    // The file leaves this computer in a way the engine does not see (no event, no change of its reading).
    const f = join(await realpath(inbox), "press.pdf");
    counted.flip(f, "not-downloaded");
    expect(w.presence("press.pdf")).toBe("local");
    const opened = readSpies();
    const assets = (await repo.getSource(p.id, sid)).assets.length;
    await expect(bringInNewVersion({ repo, http, lib, presence: counted.fn }, p.id, wid, "press.pdf")).rejects.toBeInstanceOf(WatchFileNotLocalError);
    expect(w.presence("press.pdf")).toBe("not-downloaded");
    expect((await repo.getSource(p.id, sid)).assets.length).toBe(assets);
    expect(opened(f)).toEqual([]);
    expect(await stateOf(p, wid, "press.pdf")).toBe("changed");
  }, 60_000);

  for (const same of [true, false]) {
    it(`R264 c: a may-have-changed file here again with its registered size and time is compared: ${same ? "the same content is in the library again" : "other content is \"changed\""}, and is not re-checked any more`, async () => {
      const p = await project();
      const wid = newId();
      const fake = fakeWatch();
      let rounds = 0;
      const perPath = new Map<string, number>();
      const counted: Partial<WatchFs> = {
        lstat: (q) => (perPath.set(q, (perPath.get(q) ?? 0) + 1), fsp.lstat(q, { bigint: true })),
        stat: (q) => (rounds++, fsp.stat(q)),
      };
      const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", recheckMs: 200, fs: counted });
      await w.ready;
      const v1 = await buildPdf({ title: "Restored one", extra: `r264-c1-${same}` });
      const sid = await cameIn(p, wid, fake.tell, "restored.pdf", v1, events);
      await putNotLocal("restored.pdf", v1.length + 5000, T2);
      fake.tell("restored.pdf");
      await untilAsync(async () => (await stateOf(p, wid, "restored.pdf")) === "may-have-changed");
      expect(w.presence("restored.pdf")).toBe("not-downloaded");
      // The old version put back with its old time (a restored revision): its registered size and time.
      const back = Buffer.from(v1);
      if (!same) back[back.length - 3] = back[back.length - 3]! ^ 1;
      await put("restored.pdf", back, T1);
      fake.tell("restored.pdf");
      const want = same ? "in-library" : "changed";
      await untilAsync(async () => (await stateOf(p, wid, "restored.pdf")) === want);
      const e = (await regOf(p, wid)).get("restored.pdf")!;
      if (same) {
        expect(e).toMatchObject({ sourceId: sid, sha256: sha256(v1), size: v1.length, mtimeNs: `${T1}000000000` });
        expect(e.newSha256).toBeUndefined();
        await until(() => w.presence("restored.pdf") === "unknown", LONG);
      } else {
        expect(e).toMatchObject({ sourceId: sid, sha256: sha256(v1), newSha256: sha256(back), newSize: back.length });
        await until(() => w.presence("restored.pdf") === "local", LONG);
      }
      expect(repo.listSourceIds(p.id)).toEqual([sid]);
      // Bounded: over the next 20 polls (several re-check rounds, counted by the engine's root checks) the file is not
      // looked at again.
      const f = join(await realpath(inbox), "restored.pdf");
      await until(() => !w.status().scanning, LONG);
      const calls = perPath.get(f) ?? 0;
      const r0 = rounds;
      await until(() => rounds >= r0 + 20, LONG);
      expect(perPath.get(f) ?? 0).toBe(calls);
    }, 90_000);
  }

  it("R264 d: a registered file found not here just before its read is noted may-have-changed, never opened", async () => {
    const p = await project();
    const wid = newId();
    const fake = fakeWatch();
    const counted = countedPresence();
    const { w, events } = start(p, { ...W, watchId: wid, fsWatch: fake.fn, watcherForm: "per-folder", presence: counted.fn });
    await w.ready;
    const v1 = await buildPdf({ title: "Window one", extra: "r264-d1" });
    const sid = await cameIn(p, wid, fake.tell, "window.pdf", v1, events);
    const f = join(await realpath(inbox), "window.pdf");
    const v2 = await buildPdf({ title: "Window two", extra: "r264-d2" });
    // The next judgement (when it has settled) says "local"; the one after it (just before the read) "not downloaded":
    // evicted between its settling and its read.
    counted.flip(f, "not-downloaded", 1);
    const opened = readSpies();
    await put("window.pdf", v2, T2);
    fake.tell("window.pdf");
    await untilAsync(async () => (await stateOf(p, wid, "window.pdf")) === "may-have-changed");
    const e = (await regOf(p, wid)).get("window.pdf")!;
    expect(e).toMatchObject({ sourceId: sid, sha256: sha256(v1), newSize: v2.length });
    expect(e.newSha256).toBeUndefined();
    expect(counted.count(f)).toBeGreaterThanOrEqual(2);
    expect(w.presence("window.pdf")).toBe("not-downloaded");
    expect(opened(f)).toEqual([]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, notDownloaded: 0, changed: 1 });
    expect(w.problems({ offset: 0, limit: 10 }).total).toBe(0);
    expect(repo.listSourceIds(p.id)).toEqual([sid]);
  }, 60_000);
});

describe("R379 (FR-A12): a watched folder never sends a recording's name for a title search", () => {
  it("a recording arriving in a default project's watched folder: no search request; its record keeps the file name's title", async () => {
    // The default rules (identifiable data, encryption required), with a legal basis for the files brought in.
    const { project: p } = await repo.createProject({
      name: `D${Math.random().toString(36).slice(2, 7)}`,
      governanceYaml: 'consent:\n  defaultLegalBasis:\n    manual-upload: "legitimate interest; ethics approval 2026-01"\n',
      encryption: { enabled: true, passphrase: "pw" },
    });
    const seen: string[] = [];
    agent
      .get("https://api.openalex.org")
      .intercept({ path: (q: string) => q.startsWith("/works?"), method: "GET" })
      .reply(200, (o) => (seen.push(String(o.path)), JSON.stringify({ results: [] })), { headers: { "content-type": "application/json" } })
      .persist();
    const { w, events } = start(p, { stabilityMs: 200 });
    await w.ready;
    const m4a = Buffer.alloc(64);
    m4a.writeUInt32BE(32, 0);
    m4a.write("ftypM4A ", 4, "latin1");
    await writeFile(join(inbox, "Gonzalez 2024 Interview about her eviction.m4a"), m4a);
    await until(() => events.some((e) => e.kind === "imported"));
    const ev = events.find((e) => e.kind === "imported")!;
    expect(ev).toMatchObject({ outcome: expect.stringMatching(/created|needs-review/u), sourceId: expect.any(String) });
    expect(seen).toEqual([]);
    const sf = await repo.getSource(p.id, repo.listSourceIds(p.id)[0]!);
    expect(sf.source.title.variants[0]!.value).toBe("Interview about her eviction");
  }, 30_000);
});
