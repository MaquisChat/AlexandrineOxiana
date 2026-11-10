import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
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

const project = async (): Promise<Project> =>
  (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;

function start(p: Project, opts: { stabilityMs?: number; pollMs?: number } = {}): { w: FolderWatch; events: WatchEvent[] } {
  const events: WatchEvent[] = [];
  const w = watchFolder({ repo, http, lib, onEvent: (e) => events.push(e), ...opts }, p.id, inbox);
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

    await removeWatchedFolder({ repo, lib }, p.id, wf.id);
    expect(JSON.parse(await readFile(join(lib.root, p.folder, "project.json"), "utf8")).project.watchedFolders).toEqual([]);
    expect(await readFile(join(tmp, "config", "watched-folders.json"), "utf8")).not.toContain(wf.id);
    await expect(addWatchedFolder({ repo, lib }, p.id, "relative/dir", {})).rejects.toThrow(/absolute/u);
  });
});
