/**
 * Watched folders end to end (Task W10 of the cloud-drive watched folders plan; R207, R233, R234, R235, A9): the real
 * library service and its engine, the real "Watched folders" screen and the source's origin, in Chromium and WebKit.
 *
 * The folder is approved exactly as in the product (R47: no test-only door): the page runs as if inside the desktop
 * app (`test.use({ shellStub: true })`), whose folder chooser is a stand-in (fixtures.ts ShellChooser); when the page
 * opens it, the harness writes the shell's grant line on the service's open standard input (`app.grantFolder`) and
 * the page gets only the grant id and the folder's name. A test without the option sees a plain browser.
 *
 * Linux's stand-in for a file that is not downloaded to this Mac is a sparse file (a size with no blocks; W1): made
 * as the engine's tests make it (an empty file truncated up to its size), checked with `stat` to have no blocks, and
 * "downloaded" by writing its real bytes into it. That nothing opened it is read from its access time: the test sets
 * it far in the past (the file system is mounted relatime, so any read moves it to now).
 *
 * Never a fixed sleep: every wait is for something the screen shows — a state word, a count line, a row of the
 * library, a sentence on the source — with a generous limit. What makes the engine look again is always an act the
 * product knows: a file written or renamed (a watcher event, then two seconds of stability), "Pause"/"Resume" (a
 * full listing), a relaunch (the start-up scan).
 *
 * Every request the page makes is recorded (the `context` fixture below) and checked at the end of each test: none
 * holds the watched folder's path or a key naming a folder (Accept 6).
 *
 * Every sentence asserted is copied from the screen's code (WatchedFolders.tsx, WatchOrigin.tsx) or from the engine
 * and the service, whose sentences the screen shows as they are.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import type { Request } from "@playwright/test";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, DEFECT_TIMEOUT, expect, expectDefect, libraryWithProject, test as base, type AppHarness, type Defect, type Page } from "./fixtures.js";

/**
 * Found by this spec (Task W10), not fixed here (nothing outside e2e/): a registered file whose content changed and
 * which then left this Mac (its blocks gone, its size and exact time kept, as a cloud drive evicts a file) is still
 * reported `local: true` in the source's origin, so the source never says R235's sentence. The engine does not
 * judge a registered file whose size and time are as last known (watch.ts `settleStep` → `registeredUnchanged`,
 * which records it as in the library), and the service's `local` (routes/watched-folders.ts, watch-origin) looks
 * only at the engine's list of files not downloaded, which never holds a registered file.
 */
const D_NOT_LOCAL: Defect = { id: "W10-D1", title: "A changed file that has left this Mac is reported as on this Mac: the source never says R235's sentence" };

// ---------- what every request of the page is checked for (Accept 6) ----------

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Keys a request body must never hold: a folder is named only by a grant id. */
const PATH_KEYS = new Set(["dir", "path", "folder", "directory", "root"]);

function keysIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysIn(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysIn(x, out);
    }
  }
  return out;
}

/** What is wrong with the page's requests: any that holds a watched folder's path (in any spelling) or a path-like key. */
function pathProblems(seen: Seen[], folders: string[]): string[] {
  const spellings = new Set<string>();
  for (const f of folders) {
    for (const p of [f, realpathOr(f)]) {
      spellings.add(p);
      spellings.add(encodeURIComponent(p));
      spellings.add(encodeURI(p));
      spellings.add(JSON.stringify(p).slice(1, -1));
    }
  }
  const problems: string[] = [];
  for (const r of seen) {
    const text = [r.url, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), r.body ?? ""].join("\n");
    for (const s of spellings) if (text.includes(s)) problems.push(`${r.method} ${r.url} holds the folder's path`);
    if (r.body) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        parsed = undefined;
      }
      for (const k of keysIn(parsed)) if (PATH_KEYS.has(k.toLowerCase())) problems.push(`${r.method} ${r.url} sends the key "${k}"`);
    }
  }
  return problems;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The spec's own fixtures: every request of the page recorded from the first one (on the context, before the page
 * exists) and checked when the test ends; the watched folders a test makes are named in `folders`.
 */
const test = base.extend<{ seen: Seen[]; folders: string[] }>({
  seen: async ({}, use) => use([]),
  folders: async ({}, use) => use([]),
  context: async ({ context, seen, folders }, use) => {
    const pending: Array<Promise<void>> = [];
    const record = (req: Request) =>
      void pending.push(
        req.allHeaders().then(
          (headers) => void seen.push({ url: req.url(), method: req.method(), headers, body: req.postData() }),
          () => void seen.push({ url: req.url(), method: req.method(), headers: req.headers(), body: req.postData() }),
        ),
      );
    context.on("request", record);
    await use(context);
    await Promise.all(pending);
    expect(pathProblems(seen, folders), "no request of the page carries a folder's path or a key naming one").toEqual([]);
  },
});

// ---------- the folder, its files, and what the test itself made of them ----------

const LIBRARY = "Shared drive library";
const PROJECT = "Coastal fieldwork";
const COLLECTION = "From the drive";

/** One entry of a folder's tree as the test reads it: name, kind, size and exact modification time. */
type TreeEntry = [name: string, kind: "file" | "dir", size: string, mtimeNs: string];

/** The folder's tree (names, sizes, modification times), sorted: compared before and after the app's work. */
function tree(dir: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p, { bigint: true });
      out.push([relative(dir, p), st.isDirectory() ? "dir" : "file", st.size.toString(), st.mtimeNs.toString()]);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** An empty file truncated up to `size`: Linux's stand-in for a file not downloaded (W1), as the engine's tests make it. Its access time is put far in the past. */
function sparse(path: string, size: number): void {
  writeFileSync(path, "");
  truncateSync(path, size);
  utimesSync(path, LONG_AGO, statSync(path).mtime);
  const st = statSync(path);
  expect(st.size, "the stand-in has its size").toBe(size);
  expect(st.blocks, "the stand-in keeps no blocks on this file system (it keeps holes)").toBe(0);
}

/** An access time no read can leave in place (relatime moves an access time older than a day to now). */
const LONG_AGO = new Date("2001-02-03T04:05:06Z");

/** Sets a file's modification time to `mtimeNs` exactly, and its access time to LONG_AGO (`touch`, to the nanosecond). */
function setTimes(path: string, mtimeNs: bigint): void {
  const ns = (v: bigint) => `@${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, "0")}`;
  for (const [flag, at] of [["-m", ns(mtimeNs)], ["-a", ns(BigInt(LONG_AGO.getTime()) * 1_000_000n)]] as const) {
    const r = spawnSync("touch", [flag, "-d", at, "--", path], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
}

/** "Downloading" a sparse file: its real bytes written into it, in place (the same file, as a cloud drive's app does). */
function download(path: string, bytes: Buffer): void {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Setup {
  projectId: string;
  libraryPath: string;
  projectFolder: string;
  collectionId: string;
  /** The folder to watch, under the test's temporary folder (removed afterwards). */
  dir: string;
}

/** A library and a project with one collection, the page on the library; and an empty folder to watch. */
async function setUp(app: AppHarness, page: Page, folders: string[], folderName = "Fieldwork papers"): Promise<Setup> {
  const { projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: LIBRARY, project: PROJECT });
  const c = await app.api<{ id: string }>("POST", `/projects/${projectId}/collections`, { name: COLLECTION });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const dir = join(app.root, "drive", folderName);
  mkdirSync(dir, { recursive: true });
  folders.push(dir);
  return { projectId, libraryPath, projectFolder, collectionId: c.body.id, dir };
}

const watchedHref = (projectId: string) => `${APP_ORIGIN}/settings/watched-folders?project=${encodeURIComponent(projectId)}`;

async function openWatched(page: Page, projectId: string): Promise<void> {
  await page.goto(watchedHref(projectId));
  await expect(page.getByRole("heading", { level: 1, name: "Watched folders" })).toBeVisible();
}

/** The folder's region on the screen (named by its label). */
const folderRegion = (page: Page, label: string) => page.getByRole("region", { name: label, exact: true });

/** Waits until the folder says "Watching" with its first look through the folder finished. */
async function watching(page: Page, label: string): Promise<void> {
  await expect(folderRegion(page, label).locator(".ao-watch__state")).toHaveText("Watching", { timeout: 30_000 });
}

/** A count line of the folder (its list of counts, not the list of files), exactly as the screen words it. */
const countLine = (page: Page, label: string, text: string | RegExp) => folderRegion(page, label).locator("ul.ao-watch__counts > li").filter({ hasText: text });

/** "Add a folder…" with the mouse: the chooser (stand-in) picks `dir`; the dialog names it, takes a label and the collection. */
async function addFolder(page: Page, app: AppHarness, dir: string, label: string, collection?: string): Promise<void> {
  app.chooser!.willPick(dir);
  await page.getByRole("button", { name: "Add a folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a watched folder" });
  await expect(dialog.getByText(`Folder: ${basename(dir)}`, { exact: true })).toBeVisible();
  if (collection) await dialog.getByRole("combobox", { name: "Collection" }).selectOption({ label: collection });
  await dialog.getByRole("textbox", { name: "Name shown here (optional)" }).fill(label);
  await dialog.getByRole("button", { name: "Start watching" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await watching(page, label);
}

/** The library screen for the project, its sources table showing `n` sources. */
async function libraryShows(page: Page, projectId: string, titles: string[]): Promise<void> {
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
  const table = page.getByRole("table", { name: "Sources" });
  for (const t of titles) await expect(table.getByRole("button", { name: t, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(titles.length === 1 ? "1 source" : `${titles.length} sources`, { exact: true })).toBeVisible();
}

interface SourceListAnswer {
  total: number;
  items: Array<{ id: string; title: string }>;
}
interface SourceAnswer {
  source: { id: string; collectionIds: string[] };
  assets: Array<{ id: string; role: string; bytes?: number; sha256?: string; path: string }>;
}

async function sources(app: AppHarness, projectId: string): Promise<SourceListAnswer> {
  const r = await app.api<SourceListAnswer>("GET", `/projects/${projectId}/sources?limit=100`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** Opens a source from the library's table and waits for its details. */
async function openSource(page: Page, title: string) {
  await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: title, exact: true }).click();
  const details = page.getByRole("region", { name: "Source details" });
  await expect(details.getByRole("heading", { level: 2, name: title })).toBeVisible();
  return details;
}

/**
 * Opens a source and returns its "Watched folder" region. The origin is read once when the source is shown, from the
 * register as written, and the engine writes register lines in batches (at most WATCH_REGISTER_FLUSH_MS = 5 s after
 * the first): so the source is closed and opened again until the region is on the screen.
 */
async function originOf(page: Page, title: string) {
  const details = page.getByRole("region", { name: "Source details" });
  const origin = details.getByRole("region", { name: "Watched folder" });
  await expect(async () => {
    const close = details.getByRole("button", { name: "Close", exact: true });
    if (await close.isVisible()) await close.click();
    await openSource(page, title);
    await expect(origin).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  return { details, origin };
}

// The words of the screens and the service (copied, never adapted).
const NEEDS_APP = "Adding a folder needs the desktop app.";
const NOT_DOWNLOADED = "Not downloaded to this Mac. It comes in once it is downloaded.";
const POINTER = "This is a Google Docs, Sheets or Slides file. It lives only online, so there is nothing here to bring in.";
const CHANGED = "The file in the folder has changed since it was brought in. The library's copy is unchanged.";
const BRING = "Bring in the new version as a new file of this source";
const ADDED = "The new version was added to this source.";
const NOT_LOCAL_409 = "The file in the folder is not downloaded to this Mac, or it is still changing, so it was not read. Download it in Finder, then try again.";
/** R235 (A9): the new version of a changed file is not downloaded; the size follows in brackets. */
const notLocalR235 = (bytes: number) => `The new version is not downloaded to this Mac (${sizeText(bytes)}). Download it with your cloud drive's app, then bring it in here.`;
/** The count line for one file not downloaded, with its size as the screen writes it. */
const notDownloadedLine = (bytes: number) => `1 file here is not downloaded to this Mac (${sizeText(bytes)})`;

// ---------- in a plain browser ----------

test("without the option the screen says the desktop app is needed", async ({ page, app }) => {
  const { projectId } = await libraryWithProject(app, page, { library: LIBRARY, project: PROJECT });
  await openWatched(page, projectId);
  await expect(page.getByText(NEEDS_APP, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a folder…" })).toHaveCount(0);
  await expect(page.getByText("No folder is watched in this project yet.", { exact: true })).toBeVisible();
  // A plain browser: nothing of the shell's stand-in reached this page.
  expect(await page.evaluate(() => ["isTauri", "__TAURI_INTERNALS__", "__aoShellStubPick"].filter((k) => k in window))).toEqual([]);
  expect(app.chooser).toBeUndefined();
});

// ---------- inside the desktop app (its folder chooser is the stand-in) ----------

test.describe("in the desktop app", () => {
  test.use({ shellStub: true });

  test("add a folder by keyboard and a dropped PDF comes in", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const made = tree(s.dir);
    const pdf = await buildPdf({ title: "Tidal Commons and the Village Ledger", extra: "w10-keyboard" });

    await test.step("the folder is added with the keyboard only: Tab, Enter, the arrow keys, typing", async () => {
      await openWatched(page, s.projectId);
      app.chooser!.willPick(s.dir);
      const add = page.getByRole("button", { name: "Add a folder…" });
      await tabTo(page, add);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Add a watched folder" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(`Folder: ${basename(s.dir)}`, { exact: true })).toBeVisible();
      expect(app.chooser!.titles).toEqual(["Choose a folder to watch"]);
      const select = dialog.getByRole("combobox", { name: "Collection" });
      await tabTo(page, select);
      await expect(select).toHaveValue("");
      await page.keyboard.press("ArrowDown");
      await expect(select).toHaveValue(s.collectionId);
      await tabTo(page, dialog.getByRole("textbox", { name: "Name shown here (optional)" }));
      await page.keyboard.type("Ana's drive");
      await tabTo(page, dialog.getByRole("button", { name: "Start watching" }));
      await page.keyboard.press("Space");
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await watching(page, "Ana's drive");
      await expect(folderRegion(page, "Ana's drive").getByText(`Collection: ${COLLECTION}`, { exact: true })).toBeVisible();
      expect(tree(s.dir), "adding the folder wrote nothing in it").toEqual(made);
    });

    await test.step("a PDF dropped into the folder comes in, in the chosen collection, within 10 s", async () => {
      writeFileSync(join(s.dir, "Village ledger.pdf"), pdf);
      const made2 = tree(s.dir);
      const t0 = Date.now();
      await expect(countLine(page, "Ana's drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
      const ms = Date.now() - t0;
      test.info().annotations.push({ type: "came in after", description: `${ms} ms` });
      expect(ms, "the file came in within 10 s of being written").toBeLessThan(10_000);
      await libraryShows(page, s.projectId, ["Tidal Commons and the Village Ledger"]);
      // The chosen collection, on the screen (by keyboard) and in the stored source.
      const item = page.getByRole("tree", { name: "Collections" }).getByRole("treeitem", { name: COLLECTION });
      await item.focus();
      await page.keyboard.press("Enter");
      await expect(item).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("1 source", { exact: true })).toBeVisible();
      await expect(page.getByRole("table", { name: "Sources" }).getByRole("button", { name: "Tidal Commons and the Village Ledger", exact: true })).toBeVisible();
      const listed = await sources(app, s.projectId);
      const src = await app.api<SourceAnswer>("GET", `/projects/${s.projectId}/sources/${listed.items[0]!.id}`);
      expect(src.body.source.collectionIds).toEqual([s.collectionId]);
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made2);
    });
  });

  test("a not-downloaded file is counted and not imported until it is downloaded", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const pdf = await buildPdf({ title: "Harbour Rents in the Long Nineteenth Century", extra: "w10-online" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Harbour drive");
    const file = join(s.dir, "Harbour rents.pdf");

    await test.step("a file not downloaded to this Mac is counted with its size and listed with its sentence", async () => {
      sparse(file, pdf.length);
      const made = tree(s.dir);
      await expect(countLine(page, "Harbour drive", notDownloadedLine(pdf.length))).toHaveText(notDownloadedLine(pdf.length), { timeout: 30_000 });
      await page.getByRole("button", { name: "Show files that did not come in for “Harbour drive”" }).click();
      const list = page.getByRole("list", { name: "Files of “Harbour drive”" });
      await expect(list.getByRole("listitem")).toHaveCount(1);
      await expect(list.getByRole("listitem")).toHaveText(`Harbour rents.pdf: ${NOT_DOWNLOADED} (${sizeText(pdf.length)})`);
      // Never in the library, and never opened.
      expect((await sources(app, s.projectId)).total).toBe(0);
      expect(statSync(file).atime.getTime(), "nothing opened the file that is not downloaded").toBe(LONG_AGO.getTime());
      expect(statSync(file).blocks, "nothing downloaded it").toBe(0);
      expect(tree(s.dir)).toEqual(made);
    });

    await test.step("writing its real bytes (downloading it) makes it come in", async () => {
      download(file, pdf);
      const made = tree(s.dir);
      await expect(countLine(page, "Harbour drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
      await expect(countLine(page, "Harbour drive", "not downloaded")).toHaveCount(0);
      await libraryShows(page, s.projectId, ["Harbour Rents in the Long Nineteenth Century"]);
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
    });
  });

  test("a file not downloaded is never opened", async ({ page, app, folders }) => {
    test.setTimeout(240_000);
    const s = await setUp(app, page, folders);
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Archive drive");
    const file = join(s.dir, "Minutes 1952.pdf");
    sparse(file, 180_000);
    const made = tree(s.dir);
    const untouched = () => {
      expect(statSync(file).atime.getTime(), "nothing opened the file").toBe(LONG_AGO.getTime());
      expect(statSync(file).blocks, "nothing downloaded it").toBe(0);
    };

    await test.step("counted when it appears", async () => {
      await expect(countLine(page, "Archive drive", notDownloadedLine(180_000))).toHaveText(notDownloadedLine(180_000), { timeout: 30_000 });
      untouched();
    });

    await test.step("Pause and Resume (a full listing of the folder) leave it unopened", async () => {
      const region = folderRegion(page, "Archive drive");
      await region.getByRole("button", { name: "Pause watching “Archive drive”" }).click();
      await expect(region.locator(".ao-watch__state")).toHaveText("Paused");
      await region.getByRole("button", { name: "Resume watching “Archive drive”" }).click();
      await watching(page, "Archive drive");
      await expect(countLine(page, "Archive drive", notDownloadedLine(180_000))).toHaveText(notDownloadedLine(180_000));
      untouched();
    });

    await test.step("a relaunch of the app (the start-up scan) leaves it unopened", async () => {
      await app.restart();
      await openWatched(page, s.projectId);
      await watching(page, "Archive drive");
      await expect(countLine(page, "Archive drive", notDownloadedLine(180_000))).toHaveText(notDownloadedLine(180_000), { timeout: 30_000 });
      untouched();
      expect((await sources(app, s.projectId)).total, "it never reached the library").toBe(0);
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
    });
  });

  test("a pointer file and a conflict copy are named, not imported", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const report = await buildPdf({ title: "Report on the Estuary Survey", extra: "w10-report" });
    const otherReport = await buildPdf({ title: "Report on the Estuary Survey, Second Draft", extra: "w10-report-2" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Survey drive");

    await test.step("the report comes in", async () => {
      writeFileSync(join(s.dir, "Report.pdf"), report);
      await expect(countLine(page, "Survey drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
    });

    await test.step("a Google Docs pointer file is listed with its sentence; a same-content conflict copy makes no source; a different-content one is its own", async () => {
      writeFileSync(join(s.dir, "Report (Ana's conflicted copy 2026-11-13).pdf"), report);
      writeFileSync(join(s.dir, "Field notes.gdoc"), JSON.stringify({ doc_id: "w10-pointer", email: "someone@example.org" }));
      writeFileSync(join(s.dir, "Report (1).pdf"), otherReport);
      const made = tree(s.dir);
      await expect(countLine(page, "Survey drive", "2 files came in")).toHaveText("2 files came in", { timeout: 30_000 });
      await expect(countLine(page, "Survey drive", "1 file did not come in")).toHaveText("1 file did not come in", { timeout: 30_000 });
      await page.getByRole("button", { name: "Show files that did not come in for “Survey drive”" }).click();
      const list = page.getByRole("list", { name: "Files of “Survey drive”" });
      await expect(list.getByRole("listitem")).toHaveText([`Field notes.gdoc: ${POINTER}`]);
      // The same-content conflict copy: already in the library, no second source.
      const folder = (await app.api<{ folders: Array<{ label?: string; counts: { alreadyInLibrary: number } }> }>("GET", `/projects/${s.projectId}/watched-folders`)).body.folders;
      expect(folder.map((f) => [f.label, f.counts.alreadyInLibrary])).toEqual([["Survey drive", 1]]);
      const listed = await sources(app, s.projectId);
      expect(listed.items.map((i) => i.title).sort()).toEqual(["Report on the Estuary Survey", "Report on the Estuary Survey, Second Draft"]);
      await libraryShows(page, s.projectId, ["Report on the Estuary Survey", "Report on the Estuary Survey, Second Draft"]);
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
    });
  });

  test("a changed file is shown on the source and a new version can be brought in", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const first = await buildPdf({ title: "Salt Marsh Tenancies", extra: "w10-first" });
    const second = await buildPdf({ title: "Salt Marsh Tenancies (revised)", lines: ["A colleague's revision."], extra: "w10-second" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Marsh drive");
    const file = join(s.dir, "Tenancies.pdf");
    writeFileSync(file, first);
    await expect(countLine(page, "Marsh drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });

    let made: TreeEntry[] = [];
    await test.step("a colleague replaces the PDF with another, complete on disk: the folder says a file in the library changed", async () => {
      const aside = join(app.root, "aside.pdf");
      writeFileSync(aside, second);
      renameSync(aside, file);
      made = tree(s.dir);
      await expect(countLine(page, "Marsh drive", "1 file in the library has changed in the folder")).toHaveText("1 file in the library has changed in the folder", { timeout: 30_000 });
      expect((await sources(app, s.projectId)).total, "a changed file is never imported by itself").toBe(1);
      expect(tree(s.dir)).toEqual(made);
    });

    await test.step("the source says so, and “Bring in the new version…” adds a second original, keeping the first", async () => {
      await libraryShows(page, s.projectId, ["Salt Marsh Tenancies"]);
      const { details, origin } = await originOf(page, "Salt Marsh Tenancies");
      await expect(origin.getByText("Came from the watched folder “Marsh drive” as “Tenancies.pdf”.", { exact: true })).toBeVisible();
      await expect(origin.getByText(CHANGED, { exact: true })).toBeVisible();
      await expect(origin.getByText(/^The new version is not downloaded/)).toHaveCount(0);
      const sid = (await sources(app, s.projectId)).items[0]!.id;
      const before = await app.api<SourceAnswer>("GET", `/projects/${s.projectId}/sources/${sid}`);
      const originals = (a: SourceAnswer) => a.assets.filter((x) => x.role === "original");
      expect(originals(before.body)).toHaveLength(1);
      await origin.getByRole("button", { name: `${BRING}: “Tenancies.pdf”` }).click();
      await expect(origin.getByRole("status")).toHaveText(ADDED, { timeout: 30_000 });
      await expect(origin.getByText(CHANGED, { exact: true })).toHaveCount(0);
      const after = await app.api<SourceAnswer>("GET", `/projects/${s.projectId}/sources/${sid}`);
      expect(originals(after.body)).toHaveLength(2);
      // The first original is unchanged: the same record, and the same bytes on disk.
      expect(originals(after.body)[0]).toEqual(originals(before.body)[0]);
      const stored = join(s.libraryPath, s.projectFolder, "Sources");
      const storedFiles = filesUnder(stored).filter((f) => f.endsWith(".pdf"));
      const hashes = storedFiles.map((f) => sha256(readFileSync(join(stored, f))));
      expect(hashes.sort()).toEqual([sha256(first), sha256(second)].sort());
      // On the screen: the Files list holds two originals.
      await expect(details.locator("h3:text-is('Files') + ul > li")).toHaveCount(2);
      expect(tree(s.dir), "bringing the new version in wrote nothing into the folder").toEqual(made);
    });
  });

  test("a changed file that is not on this Mac says so and adds nothing", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const first = await buildPdf({ title: "Dredging Petitions", extra: "w10-np-first" });
    const second = await buildPdf({ title: "Dredging Petitions (annotated)", lines: ["Annotated by a colleague."], extra: "w10-np-second" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Petitions drive");
    const file = join(s.dir, "Petitions.pdf");
    writeFileSync(file, first);
    await expect(countLine(page, "Petitions drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
    const aside = join(app.root, "aside.pdf");
    writeFileSync(aside, second);
    renameSync(aside, file);
    await expect(countLine(page, "Petitions drive", "1 file in the library has changed in the folder")).toHaveText("1 file in the library has changed in the folder", { timeout: 30_000 });

    await test.step("the cloud drive takes the new version off this Mac (its blocks go; size and time stay)", async () => {
      // Its exact time (nanoseconds) is kept, as a provider keeps it: `touch` sets it to the nanosecond.
      const before = statSync(file, { bigint: true });
      truncateSync(file, 0);
      truncateSync(file, Number(before.size));
      setTimes(file, before.mtimeNs);
      const after = statSync(file, { bigint: true });
      expect([after.size, after.mtimeNs, after.ino, after.blocks]).toEqual([before.size, before.mtimeNs, before.ino, 0n]);
    });
    const made = tree(s.dir);

    await test.step("“Bring in the new version…” adds nothing and says why, in the service's words", async () => {
      await libraryShows(page, s.projectId, ["Dredging Petitions"]);
      const { origin } = await originOf(page, "Dredging Petitions");
      await expect(origin.getByText(CHANGED, { exact: true })).toBeVisible();
      const sid = (await sources(app, s.projectId)).items[0]!.id;
      const before = await app.api<SourceAnswer>("GET", `/projects/${s.projectId}/sources/${sid}`);
      await origin.getByRole("button", { name: `${BRING}: “Petitions.pdf”` }).click();
      await expect(origin.getByRole("alert")).toHaveText(NOT_LOCAL_409, { timeout: 30_000 });
      const after = await app.api<SourceAnswer>("GET", `/projects/${s.projectId}/sources/${sid}`);
      expect(after.body.assets).toEqual(before.body.assets);
      expect((await sources(app, s.projectId)).total).toBe(1);
      expect(statSync(file).atime.getTime(), "the file that is not on this Mac was not opened").toBe(LONG_AGO.getTime());
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
    });

    await test.step("the source says the new version is not downloaded to this Mac (R235)", async () => {
      await page.reload();
      const { origin } = await originOf(page, "Dredging Petitions");
      await expect(origin.getByText(CHANGED, { exact: true })).toBeVisible();
      // What the service answers for the origin, kept with the result (the evidence for W10-D1).
      const sid = (await sources(app, s.projectId)).items[0]!.id;
      const answer = await app.api<{ origins: Array<{ state: string; local: boolean }> }>("GET", `/projects/${s.projectId}/sources/${sid}/watch-origin`);
      test.info().annotations.push({ type: "origin answer", description: JSON.stringify(answer.body.origins.map((o) => ({ state: o.state, local: o.local }))) });
      expectDefect(D_NOT_LOCAL);
      await expect(origin.getByText(notLocalR235(second.length), { exact: true })).toBeVisible({ timeout: DEFECT_TIMEOUT });
    });
  });

  test("removing the folder keeps what came from it", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    const pdf = await buildPdf({ title: "Ferry Tolls and Parish Rates", extra: "w10-remove" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Ferry drive");
    writeFileSync(join(s.dir, "Ferry tolls.pdf"), pdf);
    await expect(countLine(page, "Ferry drive", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
    const made = tree(s.dir);

    await test.step("“Remove…” says nothing is removed from the library, and stops watching", async () => {
      await page.getByRole("button", { name: "Remove “Ferry drive”…" }).click();
      const dialog = page.getByRole("dialog", { name: "Stop watching “Ferry drive”?" });
      await expect(dialog.getByText("Nothing already in the library is removed, and nothing in the folder is touched.", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Stop watching" }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(folderRegion(page, "Ferry drive")).toHaveCount(0);
      await expect(page.getByText("No folder is watched in this project yet.", { exact: true })).toBeVisible();
    });

    await test.step("the source stays, with its origin line", async () => {
      await libraryShows(page, s.projectId, ["Ferry Tolls and Parish Rates"]);
      const { origin } = await originOf(page, "Ferry Tolls and Parish Rates");
      await expect(origin.getByText("Came from a folder that is no longer watched, as “Ferry tolls.pdf”.", { exact: true })).toBeVisible();
      expect((await sources(app, s.projectId)).total).toBe(1);
      expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
    });
  });

  test("no request carries a folder path", async ({ page, app, folders, seen }) => {
    const s = await setUp(app, page, folders, "Private · Ana/Interviews");
    const pdf = await buildPdf({ title: "Oral Histories of the Lock Keepers", extra: "w10-paths" });
    await openWatched(page, s.projectId);
    await addFolder(page, app, s.dir, "Interviews", COLLECTION);
    writeFileSync(join(s.dir, "Lock keepers.pdf"), pdf);
    sparse(join(s.dir, "Not here.pdf"), 50_000);
    const made = tree(s.dir);
    await expect(countLine(page, "Interviews", "1 file came in")).toHaveText("1 file came in", { timeout: 30_000 });
    await expect(countLine(page, "Interviews", notDownloadedLine(50_000))).toHaveText(notDownloadedLine(50_000), { timeout: 30_000 });
    const region = folderRegion(page, "Interviews");
    await region.getByRole("button", { name: "Pause watching “Interviews”" }).click();
    await expect(region.locator(".ao-watch__state")).toHaveText("Paused");
    await region.getByRole("button", { name: "Resume watching “Interviews”" }).click();
    await watching(page, "Interviews");
    await region.getByRole("button", { name: "Show files that did not come in for “Interviews”" }).click();
    await expect(page.getByRole("list", { name: "Files of “Interviews”" }).getByRole("listitem")).toHaveCount(1);
    await libraryShows(page, s.projectId, ["Oral Histories of the Lock Keepers"]);
    await originOf(page, "Oral Histories of the Lock Keepers");
    await openWatched(page, s.projectId);
    await page.getByRole("button", { name: "Remove “Interviews”…" }).click();
    await page.getByRole("dialog", { name: "Stop watching “Interviews”?" }).getByRole("button", { name: "Stop watching" }).click();
    await expect(page.getByText("No folder is watched in this project yet.", { exact: true })).toBeVisible({ timeout: 30_000 });

    // The page named the folder only by the grant it was given, and nothing else of its requests named a folder.
    const adds = seen.filter((r) => r.method === "POST" && /\/watched-folders$/.test(new URL(r.url).pathname));
    expect(adds.map((r) => JSON.parse(r.body ?? "null"))).toEqual([{ grantId: app.chooser!.grants[0], recursive: false, label: "Interviews", collectionId: s.collectionId }]);
    expect(seen.filter((r) => new URL(r.url).host === new URL(app.baseUrl).host).length, "the page's requests were recorded").toBeGreaterThan(10);
    expect(pathProblems(seen, folders)).toEqual([]);
    expect(tree(s.dir), "the app wrote nothing into the folder").toEqual(made);
  });

  test("the app wrote nothing into the folder", async ({ page, app, folders }) => {
    const s = await setUp(app, page, folders);
    // Laid out before the folder is added: the first look through it meets every kind of file.
    mkdirSync(join(s.dir, "Inside"), { recursive: true });
    writeFileSync(join(s.dir, "Estuary maps.pdf"), await buildPdf({ title: "Estuary Maps, 1820-1900", extra: "w10-nothing-1" }));
    writeFileSync(join(s.dir, "Inside", "Weir accounts.pdf"), await buildPdf({ title: "Weir Accounts", extra: "w10-nothing-2" }));
    writeFileSync(join(s.dir, "Budget.gsheet"), JSON.stringify({ doc_id: "w10-sheet" }));
    writeFileSync(join(s.dir, ".hidden-sync-state"), "provider bookkeeping");
    writeFileSync(join(s.dir, "Draft.pdf.partial"), "half a file");
    sparse(join(s.dir, "Online only.pdf"), 120_000);
    const contents = () => tree(s.dir).filter(([n, k]) => k === "file" && n !== "Online only.pdf").map(([n]) => [n, sha256(readFileSync(join(s.dir, n)))]);
    const made = tree(s.dir);
    const madeContents = contents();

    await openWatched(page, s.projectId);
    app.chooser!.willPick(s.dir);
    await page.getByRole("button", { name: "Add a folder…" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a watched folder" });
    await dialog.getByRole("checkbox", { name: "Also watch the folders inside it" }).check();
    await dialog.getByRole("textbox", { name: "Name shown here (optional)" }).fill("Estuary drive");
    await dialog.getByRole("button", { name: "Start watching" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await watching(page, "Estuary drive");
    await expect(countLine(page, "Estuary drive", "2 files came in")).toHaveText("2 files came in", { timeout: 30_000 });
    await expect(countLine(page, "Estuary drive", notDownloadedLine(120_000))).toHaveText(notDownloadedLine(120_000), { timeout: 30_000 });
    await expect(countLine(page, "Estuary drive", "1 file did not come in")).toHaveText("1 file did not come in", { timeout: 30_000 });
    await libraryShows(page, s.projectId, ["Estuary Maps, 1820-1900", "Weir Accounts"]);

    expect(tree(s.dir), "names, sizes and modification times are as the test made them").toEqual(made);
    expect(contents(), "and so are the contents").toEqual(madeContents);
    expect(statSync(join(s.dir, "Online only.pdf")).atime.getTime(), "the file not downloaded was not opened").toBe(LONG_AGO.getTime());
  });
});

// ---------- helpers ----------

/** Presses Tab until `target` has focus (at most 60 presses): keyboard only, no click. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the control.");
}

/** A size as the screen writes it (packages/ui/src/api/tools.ts `formatSize`, copied). */
function sizeText(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace(/\.0$/, "")} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return b === 0 ? "nothing" : `${b} bytes`;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}
