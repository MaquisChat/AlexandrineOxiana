/**
 * The watched-folder routes (cloud-drive watched folders, Task W7; R207, R208, R217, R219, R221; Amendments A3,
 * A5, A6, A8). Folders are approved only by a grant, which the tests put into the service's own FolderGrants store
 * (as the shell's grant line would; R47: no test-only route). Every answer and every log line of this file is kept
 * and checked for absolute paths (only `place.display` may hold one, R96).
 */
import { randomBytes } from "node:crypto";

// R233 I2: `realpath` can be made never to answer for one folder (from its n-th call on), until released.
const holdFs = vi.hoisted(() => ({ path: "", from: 1, calls: 0, held: null as Promise<void> | null, inFlight: 0, most: 0 }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const realpath = (async (p: unknown, ...rest: unknown[]) => {
    if (holdFs.path && String(p) === holdFs.path && ++holdFs.calls >= holdFs.from && holdFs.held) {
      holdFs.most = Math.max(holdFs.most, ++holdFs.inFlight);
      try {
        await holdFs.held;
      } finally {
        holdFs.inFlight--;
      }
    }
    return (real.realpath as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.realpath;
  return { ...real, default: { ...real, realpath }, realpath };
});
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_REASONS, createLibrary, deviceDeps, type Deps, type FolderWatch, type LocationEnv, type WatchRegisterEntry, type WatchStatus } from "@ao/library";
import type { WatchedFolderSummary } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { FolderGrants } from "./folder-grants.js";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";
import { WatchStatusCoalescer, bringInDone, coalescerOf, fileItemOf, originsInRegisterOrder, placeOf } from "./routes/watched-folders.js";
import type { Session } from "./state.js";

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
  Object.assign(holdFs, { path: "", from: 1, calls: 0, held: null, inFlight: 0, most: 0 });
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

  it("label and collection are changed in project.json; null clears; a collection not in the project is refused; bad values change nothing", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const c = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Interviews" } });
    const cid = (c.json.id ?? c.json.collection?.id) as string;
    const wid = (await add(pid, await folder("Opts"), { label: "First" })).json.id as string;
    const r = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: "Second", collectionId: cid } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ label: "Second", collectionId: cid, collectionName: "Interviews" });
    const audit = (await call({ url: `/projects/${pid}/audit?limit=1000` })).json;
    const ev = (audit.events ?? audit.items ?? []).filter((e: any) => e.details?.op === "project.watched-folder.options");
    expect(ev.map((e: any) => e.details.fields)).toEqual([["label", "collectionId"]]);
    const cleared = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: null, collectionId: null } });
    expect(cleared.status, cleared.body).toBe(200);
    expect(cleared.json.label).toBeUndefined();
    expect(cleared.json.collectionId).toBeUndefined();
    const bad = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { collectionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", paused: true } });
    expect([bad.status, bad.json.error.message]).toEqual([400, "That collection is not in this project."]);
    for (const body of [{ paused: "yes" }, { notDownloaded: "all" }, { confirmBytes: -1, notDownloaded: "download" }, { extra: 1 }, { label: "" }, { label: 5, paused: true }]) {
      expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(await summary(pid, wid)).toMatchObject({ choices: { paused: false } });
    expect((await summary(pid, wid)).label).toBeUndefined();
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d`, body: { paused: true } })).status).toBe(404);
  });

  it("a request that mixes a governed change and a choice does both; when the choice cannot be written the answer says what was changed", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Mixed"), { label: "First" })).json.id as string;
    const both = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: "Second", paused: true } });
    expect(both.status, both.body).toBe(200);
    expect(both.json).toMatchObject({ label: "Second", choices: { paused: true }, state: "paused" });
    // This computer's choices cannot be read: the governed change is made, the choice is not, and the answer says so.
    const file = join(deps.appConfigDir, "watched-folder-choices.json");
    await rm(file, { force: true });
    await mkdir(file);
    const half = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: "Third", paused: false } });
    expect(half.status, half.body).toBe(503);
    expect(half.json.error.message).toBe("The folder's name or collection was changed. Its pause or download choice was not saved, because this computer's settings for watched folders could not be read. Try again.");
    await rm(file, { recursive: true, force: true });
    expect((await summary(pid, wid)).label).toBe("Third");
  });

  it("a new collection reaches the running watch without a restart, and new files land in it (R233 I3)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const c = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Arrivals" } });
    const cid = (c.json.id ?? c.json.collection?.id) as string;
    const dir = await folder("Coll");
    const wid = (await add(pid, dir)).json.id as string;
    const other = (await add(pid, await folder("Other"))).json.id as string;
    const watches = () => svc!.state.session!.watches.get(pid)!;
    const old = watches().find((w) => w.status().watchId === wid)!;
    const keep = watches().find((w) => w.status().watchId === other)!;
    const label = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: "Only a name" } });
    expect(label.status).toBe(200);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { collectionId: cid } })).status).toBe(200);
    expect(old.stopped).toBe(false);
    expect(keep.stopped).toBe(false);
    expect(watches().filter((w) => w.status().watchId === wid)).toEqual([old]);
    await pdf(join(dir, "arrival.pdf"), "A File For The New Collection");
    const sid = await until(async () => (await sourceIds(pid))[0], 30_000, "the source");
    expect((await svc!.state.session!.repo.getSource(pid, sid)).source.collectionIds).toEqual([cid]);
  }, 60_000);
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
    const stuck: FolderWatch = { ready: Promise.resolve(), stopped: false, stop, status: () => stuckStatus, problems: () => ({ total: 0, items: [] }), refreshChoices: async () => {}, setCollection: () => {}, presence: () => "unknown", origins: () => undefined };
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
    expect(origin.json.origins).toEqual([{ watchId: wid, folderLabel: "Team drive", folderRemoved: false, file: "kept.pdf", state: "in-library", presence: "unknown" }]);
    const watch = svc!.state.session!.watches.get(pid)!.find((w) => w.status().watchId === wid)!;
    const r = await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` });
    expect([r.status, r.json]).toEqual([200, { removed: true }]);
    expect(watch.stopped).toBe(true);
    expect(await sourceIds(pid)).toEqual([sid]);
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
    const gone = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect(gone.json.origins).toEqual([{ watchId: wid, folderLabel: "", folderRemoved: true, file: "kept.pdf", state: "in-library", presence: "unknown" }]);
    const choices = JSON.parse(await readFile(join(deps.appConfigDir, "watched-folder-choices.json"), "utf8"));
    expect(JSON.stringify(choices)).not.toContain(wid);
    expect(await readFile(join(deps.appConfigDir, "watched-folders.json"), "utf8")).not.toContain(wid);
    expect((await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` })).status).toBe(404);
    // The coalescer keeps nothing for a removed folder.
    expect(coalescerOf(svc!.state)!.has(`${pid}\u0000${wid}`)).toBe(false);
    // R221's refusal no longer applies: the folder is free for this project or another.
    const again = await add(other, dir);
    expect(again.status, again.body).toBe(201);
  }, 60_000);
});

describe("whether a changed file's new version is on this computer (R251, Task W11)", () => {
  beforeEach(() => start());
  /** Whole seconds: a time put back with `utimes` is the same to the nanosecond, as a provider keeps it. */
  const T = 1_750_000_000;
  const LONG_AGO = 1_000_000_000;
  /** Writes a PDF aside, sets its time, and moves it into place whole (a colleague's new version arriving). */
  async function replace(file: string, title: string): Promise<Buffer> {
    const data = await buildPdf({ title, author: "Ana Souza", lines: [`${title}: a line of text.`] });
    const aside = join(tmp, `aside-${randomBytes(4).toString("hex")}`);
    await writeFile(aside, data);
    await utimes(aside, T, T);
    await rename(aside, file);
    return data;
  }
  /** A cloud drive evicting the file: its blocks go; inode, size and exact time stay. */
  async function evict(file: string): Promise<void> {
    const before = await lstat(file, { bigint: true });
    await truncate(file, 0);
    await truncate(file, Number(before.size));
    await utimes(file, LONG_AGO, T);
    const after = await lstat(file, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.blocks]).toEqual([before.ino, before.size, before.mtimeNs, 0n]);
  }
  /** A cloud drive downloading it again: its bytes written in place, its time kept. */
  async function download(file: string, data: Buffer): Promise<void> {
    const fh = await open(file, "r+");
    try {
      await fh.write(data, 0, data.length, 0);
    } finally {
      await fh.close();
    }
    await utimes(file, LONG_AGO, T);
  }
  async function originOf(pid: string, sid: string) {
    const r = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect(r.status, r.body).toBe(200);
    return r.json.origins[0] as { state: string; presence: string } & Record<string, unknown>;
  }
  async function cameIn(name: string, title: string, encrypted = false) {
    await openNewLibrary();
    const pid = await newProject(encrypted);
    const dir = await folder(name);
    const file = join(dir, "paper.pdf");
    await pdf(file, title);
    const wid = (await add(pid, dir)).json.id as string;
    const repo = svc!.state.session!.repo;
    await until(async () => (await repo.watchRegister(pid, wid)).get("paper.pdf")?.state === "in-library", 40_000, "the file registered");
    const sid = (await repo.watchRegister(pid, wid)).get("paper.pdf")!.sourceId;
    return { pid, wid, dir, file, sid, repo };
  }

  it("presence is the engine's judgement: local, then not downloaded once evicted (and Bring in still refused), then local once downloaded", async () => {
    const { pid, wid, file, sid, repo } = await cameIn("Judged", "A Paper That Will Change");
    expect(await originOf(pid, sid)).toEqual({ watchId: wid, folderLabel: "Judged", folderRemoved: false, file: "paper.pdf", state: "in-library", presence: "unknown" });
    const v2 = await replace(file, "The Paper As A Colleague Rewrote It");
    const changed = await until(async () => {
      const o = await originOf(pid, sid);
      return o.state === "changed" ? o : undefined;
    }, 30_000, "changed");
    expect(changed).toEqual({ watchId: wid, folderLabel: "Judged", folderRemoved: false, file: "paper.pdf", state: "changed", newBytes: v2.length, presence: "local" });
    await evict(file);
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 20_000, "not downloaded");
    expect((await originOf(pid, sid)).state).toBe("changed");
    // The guard at the press decides, as before: nothing is added.
    const assets = (await repo.getSource(pid, sid)).assets.length;
    const bring = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/watch-origin/action`, body: { watchId: wid, action: "bring-in-new-version" } });
    expect([bring.status, bring.json.error.code]).toEqual([409, "CONFLICT"]);
    expect((await repo.getSource(pid, sid)).assets.length).toBe(assets);
    expect((await originOf(pid, sid)).presence).toBe("not-downloaded"); // the press's own judgement is kept (R264 b)
    expect((await lstat(file, { bigint: true })).atimeNs).toBe(BigInt(LONG_AGO) * 1_000_000_000n); // never opened
    await download(file, v2);
    await until(async () => (await originOf(pid, sid)).presence === "local", 20_000, "local again");
    // Settled by the researcher: no judgement is kept for it any more.
    const keep = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/watch-origin/action`, body: { watchId: wid, action: "keep-as-it-is" } });
    expect(keep.status, keep.body).toBe(200);
    expect(await originOf(pid, sid)).toMatchObject({ state: "settled", presence: "unknown" });
  }, 120_000);

  it("a paused or stopped watch and a folder not set up answer unknown", async () => {
    const { pid, wid, file, sid } = await cameIn("Unsure", "A Paper Whose Folder Goes Quiet");
    await replace(file, "Its Second Version");
    await until(async () => (await originOf(pid, sid)).presence === "local", 30_000, "changed and local");
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } })).status).toBe(200);
    expect(await originOf(pid, sid)).toMatchObject({ state: "changed", presence: "unknown" });
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: false } })).status).toBe(200);
    await until(async () => (await originOf(pid, sid)).presence === "local", 20_000, "local after the resume");
    // Stopped.
    const watch = svc!.state.session!.watches.get(pid)!.find((w) => w.status().watchId === wid && !w.stopped)!;
    await watch.stop();
    expect(await originOf(pid, sid)).toMatchObject({ state: "changed", presence: "unknown" });
    // Not set up on this computer (as if added on another one).
    const store = join(deps.appConfigDir, "watched-folders.json");
    const saved = JSON.parse(await readFile(store, "utf8"));
    for (const p of Object.values(saved) as any[]) for (const w of Object.values(p) as any[]) delete w[wid];
    await writeFile(store, JSON.stringify(saved));
    expect(await summary(pid, wid)).toMatchObject({ state: "not-set-up" });
    expect(await originOf(pid, sid)).toMatchObject({ state: "changed", presence: "unknown", folderRemoved: false });
  }, 120_000);

  it("R264 e: while the folder cannot be reached the answer is unknown; when it is back, the engine's judgement again", async () => {
    const { pid, wid, dir, file, sid } = await cameIn("Away", "A Paper In A Folder That Goes Away");
    await replace(file, "Its Second Version, Then Away");
    await until(async () => (await originOf(pid, sid)).presence === "local", 30_000, "changed and local");
    await evict(file);
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 30_000, "not downloaded");
    const aside = join(tmp, "away-aside");
    await rename(dir, aside);
    await until(async () => (await summary(pid, wid)).state === "unreachable", 30_000, "unreachable");
    expect(await originOf(pid, sid)).toMatchObject({ state: "changed", presence: "unknown" });
    await rename(aside, dir);
    await until(async () => (await summary(pid, wid)).state === "watching", 30_000, "watching again");
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 30_000, "judged again");
  }, 120_000);

  it("R264 e: a locked project tells nothing (423); once unlocked, the file is judged again in the walk that follows", async () => {
    const { pid, file, sid } = await cameIn("Sealed folder", "A Sealed Paper", true);
    await replace(file, "The Sealed Paper Rewritten");
    await until(async () => (await originOf(pid, sid)).presence === "local", 30_000, "changed and local");
    await evict(file);
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 30_000, "not downloaded");
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const locked = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    expect([locked.status, locked.json.error.code]).toEqual([423, "PROJECT_LOCKED"]);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 30_000, "judged again after the unlock");
  }, 120_000);

  it("a file of another state: may-have-changed gives the engine's judgement; gone is unknown", async () => {
    const { pid, wid, file, sid } = await cameIn("Others", "A Paper Of Many States");
    // Replaced by a version that is not on this computer: its content cannot be read, so "may-have-changed".
    const aside = join(tmp, "aside-sparse.pdf");
    await writeFile(aside, "");
    await truncate(aside, 90_000);
    await utimes(aside, LONG_AGO, T);
    await rename(aside, file);
    const mhc = await until(async () => {
      const o = await originOf(pid, sid);
      return o.state === "may-have-changed" ? o : undefined;
    }, 30_000, "may-have-changed");
    expect(mhc).toMatchObject({ newBytes: 90_000, presence: "not-downloaded" });
    // Paused: the engine cannot say.
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } })).status).toBe(200);
    expect(await originOf(pid, sid)).toMatchObject({ state: "may-have-changed", presence: "unknown" });
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: false } })).status).toBe(200);
    await until(async () => (await originOf(pid, sid)).presence === "not-downloaded", 30_000, "not downloaded after the resume");
    // Gone: there is no file to judge.
    await rm(file);
    // The engine forgets a file that is no longer there at once; the register says "gone" only after a complete listing.
    await until(async () => (await originOf(pid, sid)).presence === "unknown", 30_000, "forgotten");
    expect((await originOf(pid, sid)).state).toBe("may-have-changed");
    // A file is noted gone after a complete listing: the restart of the watch makes one at once.
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` })).status).toBe(200);
    await until(async () => (await originOf(pid, sid)).state === "gone", 30_000, "gone");
    expect((await originOf(pid, sid)).presence).toBe("unknown");
  }, 120_000);
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

  it("FR-475: a source with no register line yet is answered from the running watch's memory; a line on disk is the answer otherwise", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Early");
    await pdf(join(dir, "early.pdf"), "A File Opened Soon After It Came In");
    const wid = (await add(pid, dir, { label: "Team drive" })).json.id as string;
    const wid2 = (await add(pid, await folder("Second"), { label: "Second drive" })).json.id as string;
    const sid = await until(async () => (await sourceIds(pid))[0], 30_000, "the source");
    const s = svc!.state.session!;
    const entry = await until(async () => [...(await s.repo.watchRegister(pid, wid)).values()][0], 20_000, "the register");
    for (const w of s.watches.get(pid)!) await w.stop();
    // The second folder's watch holds a line for the source that its register on disk does not have yet; the first
    // folder's (here noted changed in memory) has its line on disk, which is the answer.
    const st = (id: string): WatchStatus => ({ watchId: id, state: "watching", provider: null, scanning: false, counts: { cameIn: 1, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 } });
    let memory: WatchRegisterEntry[] | undefined = [{ ...entry, file: "early copy.pdf" }];
    const stub = (id: string, origins: FolderWatch["origins"]): FolderWatch => ({ ready: Promise.resolve(), stopped: false, stop: async () => {}, status: () => st(id), problems: () => ({ total: 0, items: [] }), refreshChoices: async () => {}, setCollection: () => {}, presence: () => "unknown", origins });
    s.watches.set(pid, [stub(wid, (id) => (id === sid ? [{ ...entry, state: "changed" }] : [])), stub(wid2, (id) => (id === sid ? memory : []))]);
    const told = await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` });
    const first = { watchId: wid, folderLabel: "Team drive", folderRemoved: false, file: "early.pdf", state: "in-library", presence: "unknown" };
    const second = { watchId: wid2, folderLabel: "Second drive", folderRemoved: false, file: "early copy.pdf", state: "in-library", presence: "unknown" };
    expect(told.json.origins).toEqual([first, second].sort((a, b) => (a.watchId < b.watchId ? -1 : 1)));
    // A watch that cannot say (its register not read): only the register on disk answers.
    memory = undefined;
    expect((await call({ url: `/projects/${pid}/sources/${sid}/watch-origin` })).json.origins).toEqual([first]);
  }, 60_000);

  it("R474 M9: the origins keep the register's order (its files' names, as the library reads them), each folder's lines in their own order", () => {
    // "ab-c.jsonl" comes before "ab.jsonl" ("-" before "."), although "ab" comes before "ab-c".
    const byWatch = new Map([
      ["ab", ["x", "y"]],
      ["ab-c", ["z"]],
    ]);
    expect(originsInRegisterOrder(byWatch)).toEqual([
      { watchId: "ab-c", entry: "z" },
      { watchId: "ab", entry: "x" },
      { watchId: "ab", entry: "y" },
    ]);
  });

  it("bring in the new version says \"already-there\" when the library already held that content, and \"attached\" when a file was added (R239 d)", () => {
    expect([bringInDone("duplicate"), bringInDone("attached")]).toEqual(["already-there", "attached"]);
  });

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
    expect(o1.json.origins).toEqual([{ watchId: wid, folderLabel: "Changes", folderRemoved: false, file: "one.pdf", state: "changed", newBytes: expect.any(Number), presence: "local" }]);
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
    // Closing the library leaves nothing in the coalescer.
    expect(coalescerOf(svc!.state)!.size).toBeGreaterThan(0);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(coalescerOf(svc!.state)!.size).toBe(0);
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

describe("fix round 1 (R233)", () => {
  const states = async (pid: string) => ((await call({ url: `/projects/${pid}/watched-folders` })).json.folders as WatchedFolderSummary[]).map((f) => [f.state, f.reason]);
  const answersWithin = async (p: Promise<{ status: number }>, ms: number) => Promise.race([p.then((r) => r.status), new Promise((r) => setTimeout(() => r("no answer"), ms))]);

  it("I1: retry, remove-then-add elsewhere, set-folder and a collection change IMMEDIATELY after an add: the next watch runs; a close then answers", async () => {
    await start();
    await openNewLibrary();
    const a = await newProject(false, "A");
    const b = await newProject(false, "B");
    const c = await call({ method: "POST", url: `/projects/${a}/collections`, body: { name: "C" } });
    const cid = (c.json.id ?? c.json.collection?.id) as string;
    // Retry at once.
    const d1 = await folder("Retry");
    const w1 = (await add(a, d1)).json.id as string;
    expect((await call({ method: "POST", url: `/projects/${a}/watched-folders/${w1}/retry` })).status).toBe(200);
    // Remove at once, then add the same folder to another project.
    const d2 = await folder("Moved");
    const w2 = (await add(a, d2)).json.id as string;
    expect((await call({ method: "DELETE", url: `/projects/${a}/watched-folders/${w2}` })).status).toBe(200);
    const w2b = (await add(b, d2)).json.id as string;
    // Set-folder at once.
    const d3 = await folder("Set");
    const w3 = (await add(a, d3)).json.id as string;
    expect((await call({ method: "PUT", url: `/projects/${a}/watched-folders/${w3}/folder`, body: { grantId: grant(d3) } })).status).toBe(200);
    // A collection change at once.
    const d4 = await folder("Coll");
    const w4 = (await add(a, d4)).json.id as string;
    expect((await call({ method: "PATCH", url: `/projects/${a}/watched-folders/${w4}`, body: { collectionId: cid } })).status).toBe(200);
    await until(async () => {
      const all = [...(await states(a)), ...(await states(b))];
      return all.length === 4 && all.every(([st]) => st === "watching");
    }, 10_000, "every folder watching");
    for (const [pid, wid] of [[a, w1], [b, w2b], [a, w3], [a, w4]] as const) expect((await summary(pid, wid)).reason).toBeUndefined();
    const t0 = Date.now();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 60_000);

  it("I2: an add whose folder never answers is refused after the limit; other projects' changes and reads answer meanwhile; nothing happens twice", async () => {
    await start({ watchFsTimeoutMs: 400 });
    await openNewLibrary();
    const a = await newProject(false, "A");
    const b = await newProject(false, "B");
    const wa = (await add(a, await folder("Fine"))).json.id as string;
    const wa2 = (await add(a, await folder("Fine2"))).json.id as string;
    const stuck = await folder("Stuck");
    let release: () => void = () => {};
    Object.assign(holdFs, { path: stuck, from: 1, calls: 0, held: new Promise<void>((r) => (release = r)) });
    const pending = add(b, stuck);
    await until(async () => holdFs.calls > 0, 5000, "the stuck call");
    expect(await answersWithin(call({ method: "POST", url: `/projects/${a}/watched-folders/${wa2}/retry` }), 1000)).toBe(200);
    expect(await answersWithin(call({ method: "DELETE", url: `/projects/${a}/watched-folders/${wa}` }), 1000)).toBe(200);
    expect(await answersWithin(call({ url: `/projects/${b}/watched-folders` }), 1000)).toBe(200);
    const r = await pending;
    expect([r.status, r.json.error.message]).toEqual([400, "That folder did not answer. Choose it again when it can be reached."]);
    release();
    await new Promise((res) => setTimeout(res, 500));
    expect((await call({ url: `/projects/${b}/watched-folders` })).json.folders).toEqual([]);
    expect(grants.size).toBe(0);
  }, 30_000);

  it("I2: the library's own check of the folder under the same limit: nothing is stored when it answers late", async () => {
    await start({ watchFsTimeoutMs: 400 });
    await openNewLibrary();
    const b = await newProject();
    const stuck = await folder("Late");
    let release: () => void = () => {};
    // The route's own realpath answers; the library's check (the next call) does not.
    Object.assign(holdFs, { path: stuck, from: 2, calls: 0, held: new Promise<void>((r) => (release = r)) });
    const r = await add(b, stuck);
    expect([r.status, r.json.error.message]).toEqual([400, "That folder did not answer. Choose it again when it can be reached."]);
    holdFs.path = "";
    release();
    await new Promise((res) => setTimeout(res, 500));
    expect((await call({ url: `/projects/${b}/watched-folders` })).json.folders).toEqual([]);
    expect(await readFile(join(deps.appConfigDir, "watched-folders.json"), "utf8").catch(() => "")).not.toContain(b);
    // The queue moved on: the folder can be added now.
    expect((await add(b, stuck)).status).toBe(201);
  }, 30_000);

  it("I2: a stop that never settles is not waited for: the remove answers and the folder is gone", async () => {
    await start({ watchFsTimeoutMs: 400 });
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Hang"))).json.id as string;
    const s = svc!.state.session!;
    await s.watches.get(pid)![0]!.stop();
    const st: WatchStatus = { watchId: wid, state: "watching", provider: null, scanning: false, counts: { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 } };
    const hung: FolderWatch = { ready: Promise.resolve(), stopped: false, stop: () => new Promise(() => {}), status: () => st, problems: () => ({ total: 0, items: [] }), refreshChoices: async () => {}, setCollection: () => {}, presence: () => "unknown", origins: () => undefined };
    s.watches.set(pid, [hung]);
    expect(await answersWithin(call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` }), 2000)).toBe(200);
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
  });

  it("M1: a grant named in a request is spent whatever else is wrong with it", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Spent");
    await add(pid, dir);
    const cases: Array<[string, (g: string) => Promise<{ status: number }>]> = [
      ["a path key", (g) => call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: g, dir } })],
      ["an unknown key", (g) => call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: g, colour: "red" } })],
      ["a collection not in the project", (g) => call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: g, collectionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" } })],
      ["a bad label", (g) => call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: g, label: "" } })],
      ["an unknown watch", (g) => call({ method: "PUT", url: `/projects/${pid}/watched-folders/0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d/folder`, body: { grantId: g } })],
    ];
    for (const [what, req] of cases) {
      const g = grant(await folder(`S${what.length}`));
      expect((await req(g)).status, what).toBeGreaterThanOrEqual(400);
      expect(grants.size, what).toBe(0);
    }
    // A read-only library spends it too.
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    grant(dir); // never named by a request: kept
    const g2 = grant(dir);
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { grantId: g2 } })).status).toBe(409);
    expect(grants.size).toBe(1); // the first, never named, is still held; the named one is spent
  });

  it("M2: a folder whose name starts with \"..\" is inside, and a parent of a library named \"..Lib\" holds it", async () => {
    await start();
    const lib = await openNewLibrary("..Lib");
    const pid = await newProject();
    await mkdir(join(lib, "..inner"));
    for (const dir of [join(lib, "..inner"), tmp]) {
      const r = await add(pid, dir);
      expect([r.status, r.json.error.message], dir).toEqual([400, WATCH_REASONS.library]);
    }
  });

  it("M4/M5: a late status from a closed library leaves the open library's coalescer alone; a removed folder leaves nothing", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Keep"))).json.id as string;
    const co = coalescerOf(svc!.state)!;
    await until(async () => co.size > 0, 5000, "a status");
    const before = co.size;
    const st: WatchStatus = { watchId: "x", state: "stopped", provider: null, scanning: false, counts: { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 } };
    svc!.state.onWatchStatus!({} as Session, pid, st);
    expect(co.size).toBe(before);
    expect((await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` })).status).toBe(200);
    expect(co.size).toBe(0);
  });

  it("M8: a remove whose device list cannot be read leaves the folder watched; a remove whose choices cannot be cleaned up says removed", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Half"))).json.id as string;
    const watch = svc!.state.session!.watches.get(pid)!.find((w) => w.status().watchId === wid)!;
    const list = join(deps.appConfigDir, "watched-folders.json");
    const saved = await readFile(list, "utf8");
    await rm(list);
    await mkdir(list);
    const r = await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` });
    expect(r.status).toBe(503);
    expect(watch.stopped).toBe(false);
    await rm(list, { recursive: true });
    await writeFile(list, saved);
    expect((await summary(pid, wid)).state).toBe("watching");
    const choices = join(deps.appConfigDir, "watched-folder-choices.json");
    await rm(choices, { force: true });
    await mkdir(choices);
    const ok = await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${wid}` });
    expect([ok.status, ok.json]).toEqual([200, { removed: true }]);
    expect((await call({ url: `/projects/${pid}/watched-folders` })).json.folders).toEqual([]);
    await rm(choices, { recursive: true });
  });

  it("M11 and the reviewer's sentences", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const wid = (await add(pid, await folder("Words"))).json.id as string;
    expect((await call({ url: `/projects/${pid}/watched-folders/${wid}/files?offset=-1` })).json.error.message).toBe('"offset" must be a whole number, 0 or more.');
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { label: "" } })).json.error.message).toBe("The name must be 1 to 200 characters.");
    expect((await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { confirmBytes: 1 } })).json.error.message).toBe("A size can be given only with “Download and import them”.");
  });
});

describe("fix round 2 (R234)", () => {
  // M-b: a call given up early, or merely still outstanding, is said without "30 seconds".
  const notResponding = WATCH_REASONS.notAnswering.replace("{provider}", "the system");

  it("I-A: retries and set-folder on a folder whose call is out: at most one call on it throughout; each answers quickly and truthfully; it is watched again when the call settles", async () => {
    await start({ watchFsTimeoutMs: 400 });
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Hung");
    const wid = (await add(pid, dir)).json.id as string;
    await until(async () => (await summary(pid, wid)).state === "watching", 10_000, "watching");
    let release: () => void = () => {};
    Object.assign(holdFs, { path: await realpath(dir), from: 1, calls: 0, held: new Promise<void>((r) => (release = r)) });
    // The first press restarts the watch, whose start then waits on the folder (nothing is known yet).
    const first = await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` });
    expect(first.status).toBe(200);
    await until(async () => holdFs.inFlight === 1, 5000, "the call on the folder");
    for (const n of [2, 5]) {
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        const r = await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` });
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(r.json).toMatchObject({ state: "unreachable", reason: notResponding });
      }
    }
    const t1 = Date.now();
    const put = await call({ method: "PUT", url: `/projects/${pid}/watched-folders/${wid}/folder`, body: { grantId: grant(dir) } });
    expect(Date.now() - t1).toBeLessThan(500);
    expect([put.status, put.json.error.message]).toEqual([409, notResponding]);
    expect(notResponding).toBe("This folder is not answering (the system may be offline or signed out). Watching goes on when it does.");
    expect(holdFs.most).toBe(1);
    holdFs.path = "";
    release();
    await until(async () => (await summary(pid, wid)).state === "watching", 10_000, "watching again, with no press");
    expect(svc!.state.session!.watches.get(pid)!.filter((w) => !w.stopped && w.status().watchId === wid)).toHaveLength(1);
    expect(holdFs.most).toBe(1);
  }, 60_000);

  it("I-B: an add whose governed write waits behind another change longer than the limit is awaited: 201 and watched; a second add of the folder meanwhile is refused after it", async () => {
    await start({ watchFsTimeoutMs: 300 });
    await openNewLibrary();
    const pid = await newProject();
    const other = await newProject(false, "Other");
    const dir = await folder("Queued");
    let free: () => void = () => {};
    const busy = svc!.state.session!.repo.mutate(other, { action: "store", store: { identifiable: false, hasLocation: false } }, () => new Promise<void>((r) => (free = r)));
    const first = add(pid, dir);
    const second = add(other, dir);
    await new Promise((r) => setTimeout(r, 1000));
    free();
    await busy;
    const [a, b] = await Promise.all([first, second]);
    expect(a.status, a.body).toBe(201);
    expect([b.status, b.json.error.message]).toEqual([400, WATCH_REASONS.folderAlreadyWatched]);
    await until(async () => (await summary(pid, a.json.id)).state === "watching", 10_000, "watching");
    expect((await call({ url: `/projects/${other}/watched-folders` })).json.folders).toEqual([]);
  }, 30_000);

  it("(c) a stored folder that is no longer where it was chosen is not set up; PUT …/folder sets it up again", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Was");
    const wid = (await add(pid, dir)).json.id as string;
    const moved = join(tmp, "drive", "Now");
    const { rename } = await import("node:fs/promises");
    await rename(dir, moved);
    await symlink(moved, dir);
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` })).status).toBe(200);
    const s = await summary(pid, wid);
    expect(s).toMatchObject({ state: "not-set-up", place: null, reason: WATCH_REASONS.notWhereChosen });
    const put = await call({ method: "PUT", url: `/projects/${pid}/watched-folders/${wid}/folder`, body: { grantId: grant(moved) } });
    expect(put.status, put.body).toBe(200);
    await until(async () => (await summary(pid, wid)).state === "watching", 10_000, "watching");
    expect((await summary(pid, wid)).place?.display).toBe(await realpath(moved));
  });
});

describe("R241 (a): one order for summaries, from the service", () => {
  it("every summary, list and watch.status carries seq: it grows across list, act and event and no two draws repeat", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const events: Array<{ type: string; data: any }> = [];
    svc!.state.events.subscribe((e) => events.push(e as { type: string; data: any }));
    const dir = await folder("Ordered");
    const added = await add(pid, dir, { label: "Ordered" });
    expect(added.status, added.body).toBe(201);
    const wid = added.json.id as string;
    expect(Number.isSafeInteger(added.json.seq)).toBe(true);
    const list1 = await call({ url: `/projects/${pid}/watched-folders` });
    expect(Number.isSafeInteger(list1.json.seq)).toBe(true);
    expect(list1.json.seq).toBeGreaterThan(added.json.seq);
    // A list's summaries are read under the list's own number.
    for (const f of list1.json.folders as WatchedFolderSummary[]) expect(f.seq).toBe(list1.json.seq);
    const paused = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } });
    expect(paused.json.seq).toBeGreaterThan(list1.json.seq);
    const resumed = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: false } });
    expect(resumed.json.seq).toBeGreaterThan(paused.json.seq);
    await pdf(join(dir, "ordered.pdf"), "An Ordered File");
    await until(async () => events.some((e) => e.type === "watch.status" && e.data.folder.id === wid && e.data.folder.counts.cameIn === 1), 30_000, "a watch.status with the file");
    const retried = await call({ method: "POST", url: `/projects/${pid}/watched-folders/${wid}/retry` });
    const list2 = await call({ url: `/projects/${pid}/watched-folders` });
    expect(list2.json.seq).toBeGreaterThan(retried.json.seq);
    const evSeqs = events.filter((e) => e.type === "watch.status").map((e) => e.data.folder.seq as number);
    expect(evSeqs.length).toBeGreaterThan(0);
    // Events are published in the order of their numbers, each later than the add.
    expect([...evSeqs].sort((a, b) => a - b)).toEqual(evSeqs);
    for (const n of evSeqs) expect(n).toBeGreaterThan(added.json.seq);
    // The event that told of the file is a later reading than the answers before it.
    const told = events.find((e) => e.type === "watch.status" && e.data.folder.counts.cameIn === 1)!.data.folder.seq as number;
    expect(told).toBeGreaterThan(resumed.json.seq);
    const draws = [added.json.seq, list1.json.seq, paused.json.seq, resumed.json.seq, retried.json.seq, list2.json.seq, ...evSeqs];
    expect(new Set(draws).size).toBe(draws.length);
    for (const e of events.filter((x) => x.type === "watch.status")) answers.push(JSON.stringify(e.data.folder));
  }, 60_000);

  it("N1: the number only grows for the life of the service: a library closed and opened again goes on from it", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    const dir = await folder("Again");
    const added = await add(pid, dir);
    const list1 = await call({ url: `/projects/${pid}/watched-folders` });
    const highest = Math.max(added.json.seq, list1.json.seq);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const list2 = await call({ url: `/projects/${pid}/watched-folders` });
    expect(list2.status, list2.body).toBe(200);
    expect(list2.json.seq).toBeGreaterThan(highest);
    for (const f of list2.json.folders as WatchedFolderSummary[]) expect(f.seq).toBeGreaterThan(highest);
  }, 30_000);

  it("an event is a reading of the folder when it is sent, never of an earlier push: after a pause, every later event says paused", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const events: Array<{ type: string; data: any }> = [];
    svc!.state.events.subscribe((e) => events.push(e as { type: string; data: any }));
    const dir = await folder("Live2");
    const wid = (await add(pid, dir)).json.id as string;
    // A status pushed while watching, held by the coalescer and sent after the pause's answer.
    const watch = (svc!.state.session!.watches.get(pid) ?? []).find((w) => !w.stopped)!;
    await until(async () => watch.status().state === "watching", 10_000, "watching");
    const before = watch.status();
    const paused = await call({ method: "PATCH", url: `/projects/${pid}/watched-folders/${wid}`, body: { paused: true } });
    expect(paused.json.state).toBe("paused");
    // A status read before the pause reaches the coalescer after the answer (the engine's own pushes are throttled, so
    // the one waiting to be sent can be older than the folder is now).
    svc!.state.onWatchStatus!(svc!.state.session!, pid, before);
    svc!.state.onWatchStatus!(svc!.state.session!, pid, before);
    await until(async () => events.some((e) => e.type === "watch.status" && e.data.folder.seq > paused.json.seq), 5_000, "an event after the pause");
    for (const e of events.filter((x) => x.type === "watch.status" && x.data.folder.seq > paused.json.seq)) expect(e.data.folder.state).toBe("paused");
    for (const e of events.filter((x) => x.type === "watch.status")) answers.push(JSON.stringify(e.data.folder));
  }, 30_000);
});
