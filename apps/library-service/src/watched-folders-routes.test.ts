/**
 * The watched-folder routes (cloud-drive watched folders, Task W7; R207, R208, R217, R219, R221; Amendments A3,
 * A5, A6, A8). Folders are approved only by a grant, which the tests put into the service's own FolderGrants store
 * (as the shell's grant line would; R47: no test-only route). Every answer and every log line of this file is kept
 * and checked for absolute paths (only `place.display` may hold one, R96).
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_REASONS, createLibrary, deviceDeps, type Deps, type FolderWatch, type LocationEnv, type WatchStatus } from "@ao/library";
import type { WatchedFolderSummary } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { FolderGrants } from "./folder-grants.js";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";
import { WatchStatusCoalescer, fileItemOf, placeOf } from "./routes/watched-folders.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

const S = {
  dir: "Choose the folder with “Add a folder…” in the app.",
  expired: "That folder choice has expired. Choose the folder again.",
  notFound: "That folder could not be found. Choose the folder again.",
  wholeDrive: "Choose the folder inside your cloud drive that you want watched, not a folder that holds the whole drive.",
  windows: "Watching a cloud-drive folder is not available on Windows yet.",
  sizeChanged: "The number of files not downloaded has changed. Look at the new size and choose again.",
  nothing: "There is nothing to download in this folder at the moment.",
};

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService | undefined;
let grants: FolderGrants;
/** Every answer of this file's requests, for the path check at the end of each test. */
const answers: string[] = [];

function testDeps(dir: string): Deps {
  return { ...deviceDeps(join(dir, "config")), settleMs: 0 };
}

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  grants = new FolderGrants();
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null, watchStabilityMs: 50, folderGrants: grants, ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string> };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  answers.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function openNewLibrary(name = "Lib"): Promise<string> {
  const path = join(tmp, name);
  const r = await call({ method: "POST", url: "/libraries", body: { path, name } });
  expect(r.status, r.body).toBe(200);
  return path;
}

async function newProject(encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: OPEN_GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

/** A grant for `dir`, as the shell's grant line would make it. */
function grant(dir: string): string {
  const id = randomBytes(16).toString("hex");
  grants.add(id, dir);
  return id;
}

async function folder(name: string): Promise<string> {
  const d = join(tmp, "drive", name);
  await mkdir(d, { recursive: true });
  return d;
}

async function add(pid: string, dir: string, extra: Record<string, unknown> = {}) {
  return call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: grant(dir), ...extra } });
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000, what = "the condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function summary(pid: string, wid: string): Promise<WatchedFolderSummary> {
  const r = await call({ url: `/projects/${pid}/watched-folders` });
  expect(r.status, r.body).toBe(200);
  return (r.json.folders as WatchedFolderSummary[]).find((f) => f.id === wid)!;
}

async function pdf(path: string, title: string): Promise<void> {
  await writeFile(path, await buildPdf({ title, author: "Ana Souza", lines: [`${title}: a line of text.`] }));
}

/** The sources of a project (ids). */
async function sourceIds(pid: string): Promise<string[]> {
  return svc!.state.session!.repo.listSourceIds(pid);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-wf-routes-"));
  deps = testDeps(tmp);
  answers.length = 0;
});

afterEach(async () => {
  await svc?.close();
  svc = undefined;
  // No answer and no log line holds an absolute path of this test, except `place.display` (R96).
  const real = await realpath(tmp).catch(() => tmp);
  for (const body of answers) {
    let text = body;
    try {
      const o = JSON.parse(body) as any;
      const strip = (f: any) => {
        if (f?.place) f.place.display = "<display>";
      };
      if (Array.isArray(o?.folders)) o.folders.forEach(strip);
      strip(o);
      if (o?.folder) strip(o.folder);
      text = JSON.stringify(o);
    } catch {
      // not JSON
    }
    expect(text.includes(tmp) || text.includes(real), text).toBe(false);
  }
  expect(logs.includes(tmp) || logs.includes(real), "a log line holds a path").toBe(false);
  await rm(tmp, { recursive: true, force: true });
});

describe("adding a folder by grant (A5)", () => {
  beforeEach(() => start());

  it("add with a grant starts watching and lists the folder; what comes in is registered (A8)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Field");
    const r = await add(pid, dir, { label: "Fieldwork", recursive: true });
    expect(r.status, r.body).toBe(201);
    const s = r.json as WatchedFolderSummary;
    expect(s).toMatchObject({ label: "Fieldwork", recursive: true, place: { provider: null, providerName: null, display: await realpath(dir) }, choices: { paused: false, notDownloaded: "leave" } });
    expect(["watching", "stopped", "unreachable"]).toContain(s.state);
    expect(Object.keys(s.counts).sort()).toEqual(["alreadyInLibrary", "cameIn", "changed", "didNotComeIn", "gone", "notDownloaded", "notDownloadedBytes", "waiting"]);
    const listed = await summary(pid, s.id);
    expect(listed.state).toBe("watching");
    await pdf(join(dir, "registered.pdf"), "Registered Through The Route");
    const repo = svc!.state.session!.repo;
    const entry = await until(async () => (await repo.watchRegister(pid, s.id)).get("registered.pdf"), 30_000, "the register entry");
    expect(entry.state).toBe("in-library");
    expect((await repo.getSource(pid, entry.sourceId)).source.provenance.externalKeys).toEqual({ "watched-folder": s.id });
    await until(async () => (await summary(pid, s.id)).counts.cameIn === 1, 20_000, "the count");
  }, 60_000);

  it("a dir in the body is refused, whatever else it holds", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Field");
    for (const body of [{ dir }, { dir, grantId: grant(dir) }, { grantId: grant(dir), path: dir }, { grantId: grant(dir), folder: dir }]) {
      const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body });
      expect(r.status, r.body).toBe(400);
      expect(r.json.error).toEqual({ code: "VALIDATION", message: S.dir });
    }
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
  });

  it("an expired, unknown or malformed grant is refused; a grant is used once", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Field");
    for (const grantId of ["0".repeat(32), "not-a-grant", 7, ""]) {
      const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId } });
      expect(r.status, r.body).toBe(400);
      expect(r.json.error.message).toBe(S.expired);
    }
    const id = grant(dir);
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: id } })).status).toBe(201);
    const again = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: id } });
    expect([again.status, again.json.error.message]).toEqual([400, S.expired]);
  });

  it("a grant is spent even when its folder is refused", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const file = join(await folder("Field"), "not-a-folder.txt");
    await writeFile(file, "x");
    const id = grant(file);
    const first = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: id } });
    expect(first.status).toBe(400);
    expect(first.json.error.message).toBe("That is not a folder. Choose a folder.");
    const missing = grant(join(tmp, "drive", "gone"));
    const m = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: missing } });
    expect([m.status, m.json.error.message]).toEqual([400, S.notFound]);
    for (const used of [id, missing]) {
      const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: used } });
      expect([r.status, r.json.error.message]).toEqual([400, S.expired]);
    }
    expect(grants.size).toBe(0);
  });

  it("the library's folder, a folder inside it and a folder containing it are refused, with no path in the answer", async () => {
    const lib = await openNewLibrary();
    const pid = await newProject();
    await mkdir(join(lib, "inside-sub"), { recursive: true });
    for (const dir of [lib, join(lib, "inside-sub"), tmp]) {
      const r = await add(pid, dir);
      expect(r.status, r.body).toBe(400);
      expect(r.json.error.message).toBe(WATCH_REASONS.library);
    }
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
  });

  it("a grant whose path leads through .. or a link is judged by its real path", async () => {
    const lib = await openNewLibrary();
    const pid = await newProject();
    const field = await folder("Field");
    // Through "..": the library itself.
    const viaDots = join(field, "..", "..", "Lib");
    expect((await add(pid, viaDots)).json.error.message).toBe(WATCH_REASONS.library);
    // A link to the library.
    await symlink(lib, join(tmp, "drive", "link-to-lib"));
    expect((await add(pid, join(tmp, "drive", "link-to-lib"))).json.error.message).toBe(WATCH_REASONS.library);
    // A link to an ordinary folder: approved as the folder it leads to.
    await symlink(field, join(tmp, "drive", "link-to-field"));
    const ok = await add(pid, join(tmp, "drive", "link-to-field", "..", "Field"));
    expect(ok.status, ok.body).toBe(201);
    expect(ok.json.place.display).toBe(await realpath(field));
    const viaLink = await add(pid, join(tmp, "drive", "link-to-field"));
    expect([viaLink.status, viaLink.json.error.message]).toEqual([400, WATCH_REASONS.folderAlreadyWatched]);
  });

  it("a collection that is not in the project is refused; one that is gives its name", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const c = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Interviews" } });
    expect(c.status, c.body).toBe(200);
    const cid = (c.json.id ?? c.json.collection?.id) as string;
    const bad = await add(pid, await folder("A"), { collectionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect([bad.status, bad.json.error.message]).toEqual([400, "That collection is not in this project."]);
    const good = await add(pid, await folder("B"), { collectionId: cid });
    expect(good.status, good.body).toBe(201);
    expect(good.json).toMatchObject({ collectionId: cid, collectionName: "Interviews" });
  });

  it("two adds of one folder at once: one succeeds, one is refused (R221)", async () => {
    await openNewLibrary();
    const a = await newProject(false, "A");
    const b = await newProject(false, "B");
    const dir = await folder("Shared");
    const [r1, r2] = await Promise.all([add(a, dir), add(b, dir)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    const refused = r1.status === 400 ? r1 : r2;
    expect(refused.json.error.message).toBe(WATCH_REASONS.folderAlreadyWatched);
    const total = (await call({ url: `/projects/${a}/watched-folders` })).json.folders.length + (await call({ url: `/projects/${b}/watched-folders` })).json.folders.length;
    expect(total).toBe(1);
  });
});

describe("cloud-storage areas and places (A3, R96)", () => {
  let home: string;
  const env = (platform: NodeJS.Platform): LocationEnv => ({ homeDir: home, platform, mounts: [], mountsKnown: false });

  it("place.display: a known provider by its name, another CloudStorage folder and a plain folder by their path", () => {
    home = "/Users/ana";
    const mac = env("darwin");
    expect(placeOf("/Users/ana/Library/CloudStorage/GoogleDrive-ana@example.org/My Drive/Fieldwork", mac)).toEqual({ provider: "google-drive", providerName: "Google Drive", display: "Google Drive/My Drive/Fieldwork" });
    expect(placeOf("/Users/ana/Library/CloudStorage/OneDrive-Personal/Papers", mac)).toEqual({ provider: "onedrive", providerName: "OneDrive", display: "OneDrive/Papers" });
    expect(placeOf("/Users/ana/Library/CloudStorage/Dropbox/Team/Scans", mac)).toEqual({ provider: "dropbox", providerName: "Dropbox", display: "Dropbox/Team/Scans" });
    expect(placeOf("/Users/ana/Dropbox/Old", mac)).toEqual({ provider: "dropbox", providerName: "Dropbox", display: "Dropbox/Old" });
    expect(placeOf("/Users/ana/Library/CloudStorage/OneDrive-Personal", mac)).toEqual({ provider: "onedrive", providerName: "OneDrive", display: "OneDrive" });
    // Below CloudStorage but none of the three: the absolute path (the "Review:" line's case).
    expect(placeOf("/Users/ana/Library/CloudStorage/Box-Box/Lab", mac)).toEqual({ provider: "other-cloud", providerName: "the cloud drive", display: "/Users/ana/Library/CloudStorage/Box-Box/Lab" });
    expect(placeOf("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Notes", mac)).toEqual({ provider: "icloud-drive", providerName: "iCloud Drive", display: "/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Notes" });
    expect(placeOf("/Users/ana/Documents/Field", mac)).toEqual({ provider: null, providerName: null, display: "/Users/ana/Documents/Field" });
  });

  it("the whole cloud-storage area and the home folder are refused; a folder inside a drive is not", async () => {
    home = join(tmp, "home");
    const cs = join(home, "Library", "CloudStorage");
    const drive = join(cs, "GoogleDrive-ana@example.org", "My Drive", "Field");
    await mkdir(drive, { recursive: true });
    await mkdir(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
    await start({ watchLocationEnv: env("darwin") });
    await openNewLibrary();
    const pid = await newProject();
    for (const dir of [home, join(home, "Library"), cs, join(home, "Library", "Mobile Documents"), tmp.endsWith("/") ? tmp : join(tmp)]) {
      const r = await add(pid, dir);
      expect(r.status, `${dir}: ${r.body}`).toBe(400);
      expect([S.wholeDrive, WATCH_REASONS.library]).toContain(r.json.error.message);
    }
    for (const dir of [home, cs]) expect((await add(pid, dir)).json.error.message).toBe(S.wholeDrive);
    const ok = await add(pid, drive);
    expect(ok.status, ok.body).toBe(201);
    expect(ok.json.place).toEqual({ provider: "google-drive", providerName: "Google Drive", display: "Google Drive/My Drive/Field" });
  });

  it("a cloud folder is refused on Windows (Accept 2); a plain one is not", async () => {
    home = join(tmp, "home");
    const dropbox = join(home, "Dropbox", "Team");
    await mkdir(dropbox, { recursive: true });
    await start({ watchLocationEnv: env("win32") });
    await openNewLibrary();
    const pid = await newProject();
    const r = await add(pid, dropbox);
    expect([r.status, r.json.error.message]).toEqual([400, S.windows]);
    expect((await add(pid, await folder("Plain"))).status).toBe(201);
  });
});

describe("choices: pause and download (W4, R219, R221)", () => {
  beforeEach(() => start());

  /** A file "not downloaded" on Linux: a size and no blocks (W1's stand-in). */
  async function sparse(path: string, size: number) {
    await writeFile(path, "");
    await truncate(path, size);
  }

  it("download needs the size the researcher saw; a stale size is a 409 and changes nothing", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Drive");
    await sparse(join(dir, "a.pdf"), 300_000);
    await sparse(join(dir, "b.pdf"), 200_000);
    const wid = (await add(pid, dir)).json.id as string;
    await until(async () => (await summary(pid, wid)).counts.notDownloadedBytes === 500_000, 20_000, "the not-downloaded count");
    const stale = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { notDownloaded: "download", confirmBytes: 300_000 } });
    expect([stale.status, stale.json.error.code, stale.json.error.message]).toEqual([409, "CONFLICT", S.sizeChanged]);
    expect((await summary(pid, wid)).choices).toEqual({ paused: false, notDownloaded: "leave" });
    const noNumber = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { notDownloaded: "download" } });
    expect([noNumber.status, noNumber.json.error.message]).toEqual([409, S.sizeChanged]);
    const lone = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { confirmBytes: 500_000 } });
    expect(lone.status).toBe(400);
    expect((await summary(pid, wid)).choices.notDownloaded).toBe("leave");
    // Pause first, so that nothing is fetched by the test; the confirmation is recorded with the size seen.
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } })).status).toBe(200);
    const ok = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { notDownloaded: "download", confirmBytes: 500_000 } });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.choices).toEqual({ paused: true, notDownloaded: "download" });
    const stored = JSON.parse(await readFile(join(deps.appConfigDir, "watched-folder-choices.json"), "utf8"));
    const rec = Object.values(Object.values(stored)[0] as Record<string, any>)[0][wid];
    expect(rec).toMatchObject({ notDownloaded: "download", confirmedBytes: 500_000 });
    const leave = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { notDownloaded: "leave" } });
    expect(leave.json.choices.notDownloaded).toBe("leave");
  }, 60_000);

  it("download with nothing waiting is refused (a confirmation of 0 bytes is none, R221 b)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Empty"))).json.id as string;
    const r = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { notDownloaded: "download", confirmBytes: 0 } });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "CONFLICT", S.nothing]);
    expect((await summary(pid, wid)).choices.notDownloaded).toBe("leave");
  });

  it("pause holds at once: a file put in the folder after the answer does not come in", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Pause");
    const wid = (await add(pid, dir)).json.id as string;
    await until(async () => (await summary(pid, wid)).state === "watching", 10_000, "watching");
    const r = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ state: "paused", choices: { paused: true } });
    await pdf(join(dir, "later.pdf"), "Put In While Paused");
    await new Promise((res) => setTimeout(res, 1500));
    expect(await sourceIds(pid)).toEqual([]);
    expect((await summary(pid, wid)).state).toBe("paused");
    const resumed = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: false } });
    expect(resumed.json.choices.paused).toBe(false);
    await until(async () => (await sourceIds(pid)).length === 1, 30_000, "the file after resume");
  }, 60_000);

  it("label and collection cannot be changed here yet; a request that mixes them with a choice changes nothing", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Opts"), { label: "First" })).json.id as string;
    for (const body of [{ label: "Second" }, { collectionId: null }, { label: null, paused: true }]) {
      const r = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body });
      expect(r.status, r.body).toBe(400);
    }
    expect(await summary(pid, wid)).toMatchObject({ label: "First", choices: { paused: false } });
    for (const body of [{ paused: "yes" }, { notDownloaded: "all" }, { confirmBytes: -1, notDownloaded: "download" }, { extra: 1 }]) {
      expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body })).status).toBe(400);
    }
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d`, body: { paused: true } })).status).toBe(404);
  });
});

describe("set again, retry, remove", () => {
  beforeEach(() => start());

  it("a watch with no folder on this computer is not set up; PUT …/folder chooses it by grant", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Old"))).json.id as string;
    // As if the watch had been added on another computer: this computer's folder is forgotten.
    const file = join(deps.appConfigDir, "watched-folders.json");
    const store = JSON.parse(await readFile(file, "utf8"));
    for (const p of Object.values(store) as any[]) for (const w of Object.values(p) as any[]) delete w[wid];
    await writeFile(file, JSON.stringify(store));
    expect(await summary(pid, wid)).toMatchObject({ state: "not-set-up", place: null });
    const other = await folder("New");
    expect((await call({ method: "PUT", url: `/projects/${pid}/watched-folders/${wid}/folder`, body: { dir: other } })).json.error.message).toBe(S.dir);
    const r = await call({ method: "PUT", url: `/projects/${pid}/watched-folders/${wid}/folder`, body: { grantId: grant(other) } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.place.display).toBe(await realpath(other));
    await until(async () => (await summary(pid, wid)).state === "watching", 10_000, "watching");
    expect(svc!.state.session!.watches.get(pid)!.filter((w) => w.status().watchId === wid && !w.stopped)).toHaveLength(1);
    const unknown = await call({ method: "PUT", url: `/projects/${pid}/watched-folders/0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d/folder`, body: { grantId: grant(other) } });
    expect(unknown.status).toBe(404);
  });

  it("retry restarts that one watch and leaves the project's others running", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const a = (await add(pid, await folder("A"))).json.id as string;
    const b = (await add(pid, await folder("B"))).json.id as string;
    const before = svc!.state.session!.watches.get(pid)!;
    const keepB = before.find((w) => w.status().watchId === b)!;
    const oldA = before.find((w) => w.status().watchId === a)!;
    const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders/${a}/retry` });
    expect(r.status, r.body).toBe(200);
    expect(r.json.id).toBe(a);
    const after = svc!.state.session!.watches.get(pid)!;
    expect(oldA.stopped).toBe(true);
    expect(keepB.stopped).toBe(false);
    expect(after.filter((w) => !w.stopped).map((w) => w.status().watchId).sort()).toEqual([a, b].sort());
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders/0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d/retry` })).status).toBe(404);
  });

  it("retry on a stuck folder starts no second watch and says the engine's reason (A6)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Stuck"))).json.id as string;
    const s = svc!.state.session!;
    const real = s.watches.get(pid)!.find((w) => w.status().watchId === wid)!;
    await real.stop();
    // The engine's own words for a folder whose call has not answered (its status, as the engine gives it).
    const reason = WATCH_REASONS.notResponding.replace("{provider}", "the system");
    const stuckStatus: WatchStatus = { watchId: wid, state: "unreachable", reason, provider: null, scanning: false, counts: { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 } };
    const stop = vi.fn(async () => {});
    const stuck: FolderWatch = { ready: Promise.resolve(), stopped: false, stop, status: () => stuckStatus, problems: () => ({ total: 0, items: [] }), refreshChoices: async () => {} };
    s.watches.set(pid, [stuck]);
    const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ id: wid, state: "unreachable", reason });
    expect(stop).not.toHaveBeenCalled();
    expect(s.watches.get(pid)).toEqual([stuck]);
  });

  it("remove keeps the sources and says the folder is no longer watched; the folder can then be added again", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const other = await newProject(false, "Other");
    const dir = await folder("Keep");
    await pdf(join(dir, "kept.pdf"), "Kept After The Folder Goes");
    const wid = (await add(pid, dir, { label: "Team drive" })).json.id as string;
    const sid = await until(async () => (await sourceIds(pid))[0], 30_000, "the source");
    await until(async () => (await svc!.state.session!.repo.watchRegister(pid, wid)).size === 1, 20_000, "the register");
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } })).status).toBe(200);
    const origin = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect(origin.json.origins).toEqual([{ watchId: wid, folderLabel: "Team drive", folderRemoved: false, file: "kept.pdf", state: "in-library", local: true }]);
    const watch = svc!.state.session!.watches.get(pid)!.find((w) => w.status().watchId === wid)!;
    const r = await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` });
    expect([r.status, r.json]).toEqual([200, { removed: true }]);
    expect(watch.stopped).toBe(true);
    expect(await sourceIds(pid)).toEqual([sid]);
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
    const gone = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect(gone.json.origins).toEqual([{ watchId: wid, folderLabel: "", folderRemoved: true, file: "kept.pdf", state: "in-library", local: false }]);
    const choices = JSON.parse(await readFile(join(deps.appConfigDir, "watched-folder-choices.json"), "utf8"));
    expect(JSON.stringify(choices)).not.toContain(wid);
    expect(await readFile(join(deps.appConfigDir, "watched-folders.json"), "utf8")).not.toContain(wid);
    expect((await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` })).status).toBe(404);
    // R221's refusal no longer applies: the folder is free for this project or another.
    const again = await add(other, dir);
    expect(again.status, again.body).toBe(201);
  }, 60_000);
});

describe("files and origins", () => {
  beforeEach(() => start());

  it("files lists not-downloaded files with their sizes, 200 at a time; limit 201 is refused; pages do not overlap", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Many");
    for (let i = 0; i < 250; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, "0")}.pdf`), "");
      await truncate(join(dir, `f${String(i).padStart(3, "0")}.pdf`), 1000 + i);
    }
    const wid = (await add(pid, dir)).json.id as string;
    await until(async () => (await summary(pid, wid)).counts.notDownloaded === 250, 30_000, "250 files counted");
    const base = `/projects/${pid}/watched-folders/${wid}/files`;
    for (const q of ["?limit=201", "?limit=0", "?offset=-1", "?kind=everything", "?limit=abc"]) expect((await call({ url: base + q })).status, q).toBe(400);
    const p1 = await call({ url: `${base}?limit=200` });
    const p2 = await call({ url: `${base}?limit=200&offset=200` });
    expect([p1.status, p1.json.total, p1.json.items.length, p2.json.items.length]).toEqual([200, 250, 200, 50]);
    const names = [...p1.json.items, ...p2.json.items].map((i: any) => i.file);
    expect(new Set(names).size).toBe(250);
    expect(names).toEqual([...names].sort());
    expect(p1.json.items[0]).toEqual({ file: "f000.pdf", kind: "not-downloaded", reason: WATCH_REASONS.notDownloaded, bytes: 1000 });
    const filtered = await call({ url: `${base}?kind=not-downloaded&limit=10&offset=245` });
    expect([filtered.json.total, filtered.json.items.length]).toEqual([250, 5]);
    expect((await call({ url: `${base}?kind=changed` })).json).toEqual({ total: 0, items: [] });
  }, 60_000);

  it("a size-unknown file is listed with its sentence and no size", () => {
    expect(fileItemOf({ file: "x.pdf", kind: "not-downloaded", reason: WATCH_REASONS.sizeUnknown, bytes: 0 }, [])).toEqual({ file: "x.pdf", kind: "not-downloaded", reason: WATCH_REASONS.sizeUnknown });
    expect(fileItemOf({ file: "y.pdf", kind: "could-not-import", reason: "Failed at /Users/ana/Secret/y.pdf" }, [])).toEqual({ file: "y.pdf", kind: "could-not-import", reason: "Failed at <path>" });
  });

  it("a removed-here file and a changed file are listed; keep-as-it-is settles a changed file; bring in the new version adds an original", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Changes");
    await pdf(join(dir, "one.pdf"), "The First File Of The Folder");
    await pdf(join(dir, "two.pdf"), "The Second File Of The Folder");
    await pdf(join(dir, "three.pdf"), "The Third File Of The Folder");
    const wid = (await add(pid, dir)).json.id as string;
    const repo = svc!.state.session!.repo;
    const reg = await until(async () => {
      const m = await repo.watchRegister(pid, wid);
      return m.size === 3 ? m : undefined;
    }, 40_000, "three registered files");
    const sid = (k: string) => reg.get(k)!.sourceId;
    // Removed here: the source is deleted; a restart of the watch lists the file as such.
    expect((await call({ method: "DELETE", url: `/projects/${pid}/sources/${sid("three.pdf")}` })).status).toBe(200);
    // Changed in the folder.
    await pdf(join(dir, "one.pdf"), "The First File Rewritten By A Colleague");
    await pdf(join(dir, "two.pdf"), "The Second File Rewritten By A Colleague");
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` })).status).toBe(200);
    const base = `/projects/${pid}/watched-folders/${wid}/files`;
    const removed = await until(async () => {
      const r = await call({ url: `${base}?kind=removed-here` });
      return r.json.total === 1 ? r.json : undefined;
    }, 40_000, "removed-here");
    expect(removed.items).toEqual([{ file: "three.pdf", kind: "removed-here", reason: WATCH_REASONS.removedHere }]);
    const changed = await until(async () => {
      const r = await call({ url: `${base}?kind=changed` });
      return r.json.total === 2 ? r.json : undefined;
    }, 40_000, "two changed files");
    expect(changed.items.map((i: any) => [i.file, i.kind, i.sourceId])).toEqual([
      ["one.pdf", "changed", sid("one.pdf")],
      ["two.pdf", "changed", sid("two.pdf")],
    ]);
    expect(changed.items[0].bytes).toEqual(expect.any(Number));
    const all = await call({ url: base });
    expect(all.json.items.map((i: any) => i.kind)).toEqual(["removed-here", "changed", "changed"]);

    // The source's origin, and the two acts.
    const o1 = await call({ url: `/projects/${pid}/sources/${sid("one.pdf")}/watch-origin` });
    expect(o1.json.origins).toEqual([{ watchId: wid, folderLabel: "Changes", folderRemoved: false, file: "one.pdf", state: "changed", newBytes: expect.any(Number), local: true }]);
    const keep = await call({ method: "POST", url: `/projects/${pid}/sources/${sid("one.pdf")}/watch-origin/action`, body: { watchId: wid, action: "keep-as-it-is" } });
    expect([keep.status, keep.json]).toEqual([200, { done: "settled", sourceId: sid("one.pdf") }]);
    expect((await call({ url: `/projects/${pid}/sources/${sid("one.pdf")}/watch-origin` })).json.origins[0].state).toBe("settled");
    const before = (await repo.getSource(pid, sid("two.pdf"))).assets.length;
    const bring = await call({ method: "POST", url: `/projects/${pid}/sources/${sid("two.pdf")}/watch-origin/action`, body: { watchId: wid, action: "bring-in-new-version" } });
    expect([bring.status, bring.json], bring.body).toEqual([200, { done: "attached", sourceId: sid("two.pdf") }]);
    expect((await repo.getSource(pid, sid("two.pdf"))).assets.length).toBeGreaterThan(before);
    expect((await call({ url: `/projects/${pid}/sources/${sid("two.pdf")}/watch-origin` })).json.origins[0].state).toBe("in-library");
    // Nothing to settle any more: the engine's sentence, as a 400.
    const twice = await call({ method: "POST", url: `/projects/${pid}/sources/${sid("one.pdf")}/watch-origin/action`, body: { watchId: wid, action: "keep-as-it-is" } });
    expect(twice.status).toBe(400);
  }, 120_000);

  it("the two origin routes and an existing source route each answer their own", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await (async () => {
      const p = join(tmp, "in", "plain.pdf");
      await mkdir(join(tmp, "in"), { recursive: true });
      await pdf(p, "A Source From No Folder");
      return p;
    })()] } });
    expect(att.status, att.body).toBe(200);
    answers.pop(); // the attach route's own answer names the path it was given (not a route of this file)
    const sid = (await sourceIds(pid))[0]!;
    const src = await call({ url: `/projects/${pid}/sources/${sid}` });
    expect([src.status, src.json.source.id]).toEqual([200, sid]);
    const origin = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect([origin.status, origin.json]).toEqual([200, { origins: [] }]);
    const act = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/watch-origin/action`, body: { watchId: "0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d", action: "keep-as-it-is" } });
    expect([act.status, act.json.error.code]).toEqual([404, "NOT_FOUND"]);
    expect((await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/watch-origin/action`, body: { watchId: "x", action: "delete-it" } })).status).toBe(400);
    expect((await call({ url: `/projects/${pid}/sources/01ZZZZZZZZZZZZZZZZZZZZZZZZ/watch-origin` })).status).toBe(404);
    const rec = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/recheck` });
    expect(rec.status).not.toBe(404);
  });
});

describe("who may call, read-only, locked (Accept 5)", () => {
  it("the extension token is refused on every route, reads included", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Ext"))).json.id as string;
    const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const p = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
    const token = c.json().token as string;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/projects/${pid}/watched-folders`],
      ["POST", `/projects/${pid}/watched-folders`, { grantId: grant(await folder("Ext2")) }],
      ["PUT", `/projects/${pid}/watched-folders/${wid}/folder`, { grantId: "0".repeat(32) }],
      ["PATCH", `/projects/${pid}/watched-folders/${wid}`, { paused: true }],
      ["POST", `/projects/${pid}/watched-folders/${wid}/retry`],
      ["DELETE", `/projects/${pid}/watched-folders/${wid}`],
      ["GET", `/projects/${pid}/watched-folders/${wid}/files`],
      ["GET", `/projects/${pid}/sources/x/watch-origin`],
      ["POST", `/projects/${pid}/sources/x/watch-origin/action`, { watchId: wid, action: "keep-as-it-is" }],
    ];
    for (const [method, url, body] of routes) {
      const res = await svc!.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}`, origin: EXT, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
      answers.push(res.body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(grants.size).toBe(1);
    expect((await summary(pid, wid)).choices.paused).toBe(false);
  });

  it("a read-only library changes nothing, device choices included", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("RO"))).json.id as string;
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    const files = [join(deps.appConfigDir, "watched-folders.json"), join(deps.appConfigDir, "watched-folder-choices.json")];
    const before = await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => null)));
    const g = grant(await folder("RO2"));
    for (const [method, url, body] of [
      ["POST", `/projects/${pid}/watched-folders`, { grantId: g }],
      ["PUT", `/projects/${pid}/watched-folders/${wid}/folder`, { grantId: g }],
      ["PATCH", `/projects/${pid}/watched-folders/${wid}`, { paused: true }],
      ["POST", `/projects/${pid}/watched-folders/${wid}/retry`],
      ["DELETE", `/projects/${pid}/watched-folders/${wid}`],
      ["POST", `/projects/${pid}/sources/x/watch-origin/action`, { watchId: wid, action: "keep-as-it-is" }],
    ] as const) {
      const r = await call({ method, url, ...(body ? { body } : {}) });
      expect([r.status, r.json.error.code], `${method} ${url}`).toEqual([409, "READ_ONLY"]);
    }
    expect(await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => null)))).toEqual(before);
    const listed = await summary(pid, wid);
    expect(listed.state).toBe("stopped");
    expect(svc!.state.session!.watches.get(pid) ?? []).toEqual([]);
  });

  it("a locked project answers 423 and tells nothing; no watch.status is published for it once locked", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject(true);
    const wid = (await add(pid, await folder("Sealed"), { label: "Confidential interviews" })).json.id as string;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const seen: unknown[] = [];
    svc!.state.events.subscribe((e) => {
      if (e.type === "watch.status") seen.push(e.data);
    });
    for (const [method, url, body] of [
      ["GET", `/projects/${pid}/watched-folders`],
      ["GET", `/projects/${pid}/watched-folders/${wid}/files`],
      ["GET", `/projects/${pid}/sources/x/watch-origin`],
      ["POST", `/projects/${pid}/watched-folders`, { grantId: grant(await folder("S2")) }],
      ["PATCH", `/projects/${pid}/watched-folders/${wid}`, { paused: true }],
      ["POST", `/projects/${pid}/watched-folders/${wid}/retry`],
      ["DELETE", `/projects/${pid}/watched-folders/${wid}`],
      ["POST", `/projects/${pid}/sources/x/watch-origin/action`, { watchId: wid, action: "keep-as-it-is" }],
    ] as const) {
      const r = await call({ method, url, ...(body ? { body } : {}) });
      expect([r.status, r.json.error.code], `${method} ${url}`).toEqual([423, "PROJECT_LOCKED"]);
      expect(r.body).not.toContain("Confidential");
    }
    await new Promise((res) => setTimeout(res, 1500));
    expect(seen).toEqual([]);
  });
});

describe("watch.status (Accept 6)", () => {
  it("is published with the list's summary, and job.progress of kind watch is not", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const events: Array<{ type: string; data: any }> = [];
    svc!.state.events.subscribe((e) => events.push(e as { type: string; data: any }));
    const dir = await folder("Live");
    const wid = (await add(pid, dir, { label: "Live" })).json.id as string;
    await pdf(join(dir, "live.pdf"), "A File Seen Live");
    await until(async () => events.some((e) => e.type === "watch.status" && e.data.folder.id === wid && e.data.folder.counts.cameIn === 1), 30_000, "a watch.status with the file");
    const ev = events.filter((e) => e.type === "watch.status").at(-1)!;
    expect(ev.data.projectId).toBe(pid);
    expect(ev.data.folder).toMatchObject({ id: wid, label: "Live", place: { display: await realpath(dir) } });
    expect(events.some((e) => e.type === "job.progress" && e.data.kind === "watch")).toBe(false);
    for (const e of events.filter((x) => x.type === "watch.status")) answers.push(JSON.stringify(e.data.folder));
  }, 60_000);

  it("is coalesced to one per folder per second; the last state of a burst is delivered; nothing after close", () => {
    vi.useFakeTimers();
    try {
      const sent: Array<[string, string]> = [];
      let open = true;
      const c = new WatchStatusCoalescer(1000, (key, v: string) => {
        if (open) sent.push([key, v]);
      });
      c.push("a", "1");
      c.push("a", "2");
      c.push("b", "x");
      c.push("a", "3");
      expect(sent).toEqual([
        ["a", "1"],
        ["b", "x"],
      ]);
      vi.advanceTimersByTime(999);
      expect(sent).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([
        ["a", "1"],
        ["b", "x"],
        ["a", "3"],
      ]);
      for (let i = 4; i < 40; i++) {
        c.push("a", String(i));
        vi.advanceTimersByTime(100);
      }
      vi.advanceTimersByTime(1000);
      const a = sent.filter(([k]) => k === "a");
      expect(a.at(-1)).toEqual(["a", "39"]);
      expect(a.length).toBeLessThanOrEqual(2 + Math.ceil(3600 / 1000) + 1);
      // Closed: the pending state is dropped and nothing more is sent.
      c.push("a", "40");
      c.push("a", "41");
      const n = sent.length;
      c.clear();
      open = false;
      vi.advanceTimersByTime(5000);
      expect(sent.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});
