/**
 * Scenarios 3 and 4 (Task 37's list; PLAN Task 45): the Bulk Import wizard against the real service
 * and worker, its first meeting with them on these paths.
 *
 *  3. Bulk import of a Zotero data folder (the library's own fixture builder): collections
 *     recreated, one item reviewed, the report, undo, and importing again.
 *  4. Device import of an iPhone Live Photo (HEIC + MOV with one content identifier and exact GPS)
 *     into a project that coarsens locations: one source, its proxies, and the coarsening checked on
 *     what the service stored and on the proxies' own metadata (decrypted with the library's code).
 *
 * Elements are found by role and accessible name, as a keyboard or screen-reader user finds them.
 * Steps the product cannot do yet are `blockedBy(<defect>)` (fixtures.ts): skipped, named, and
 * described in the Task 45 report.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { buildZoteroFixture } from "../packages/library/tests/fixtures/zotero/build-fixture.mjs";
import { APP_ORIGIN, blockedBy, decryptStoredFile, expect, libraryWithProject, test, type Page } from "./fixtures.js";
import { LIBRARY_DIR, REPO_ROOT } from "./paths.js";

// ---------- shared ----------

interface StoredAsset {
  id: string;
  role: "original" | "derived";
  kind: string;
  path: string;
  encrypted?: boolean;
  linked?: { absolutePath: string; libraryRelativePath: string };
  mime?: string;
  metadata?: Record<string, unknown>;
  derivation?: { parents: string[]; operation: string; params?: Record<string, unknown> };
}
interface StoredSource {
  source: { id: string; type: string; title: { variants: Array<{ value: string }> }; collectionIds: string[]; folder: string };
  assets: StoredAsset[];
}
interface SourceList {
  total: number;
  items: Array<{ id: string; title: string; type: string; needsReview: boolean; folder: string }>;
}
interface Batch {
  batchId: string;
  number: number;
  state: string;
  counts: { created: number; needsReview: number; failed: number };
}

/** Every file under `dir`, relative to it ("/"-separated). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Opens the wizard from the library screen (its "Import" link) with a source kind chosen and its path typed. */
async function openWizard(page: Page, kind: string, pathLabel: string, path: string): Promise<void> {
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bulk import" })).toBeVisible();
  await page.getByRole("group", { name: "Import from" }).getByRole("radio", { name: kind, exact: true }).check();
  await page.getByRole("textbox", { name: pathLabel }).fill(path);
}

/** Scan → (Review) → (Options) → Start import, waiting for the report. */
async function scanAndRun(page: Page, onScan?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Scan" }).click();
  // The scan runs in the service (and starts the worker on a cold library): a generous, explicit wait.
  await expect(page.getByRole("heading", { level: 2, name: "Scan results" })).toBeVisible({ timeout: 60_000 });
  await onScan?.();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Options" })).toBeVisible();
  await page.getByRole("button", { name: "Start import" }).click();
  // Imports run in the background; proxies (scenario 4) are made by the real worker on a busy machine.
  await expect(page.getByRole("heading", { level: 2, name: "Report and undo" })).toBeVisible({ timeout: 90_000 });
}

/** The report's row for an outcome ("Created", "Waiting for review" …). */
const reportRow = (page: Page, label: string) => page.getByRole("table", { name: "Items by outcome" }).getByRole("row", { name: new RegExp(`^${label} `) });

// ---------- scenario 3 ----------

const ZOTERO_TITLES = ["Feeding the City: Informal Markets in Lagos", "Markets and Memory", "Street Food and the State", "Street Vendors in Accra", "Water Access in Peri-Urban Areas"];
const REVIEWED = "Street Vendors in Accra";
const REVIEWED_AS = "Street Vendors in Accra, 2018–2020";

test("scenario 3: bulk import of a Zotero data folder — collections, review, report, undo, import again", async ({ page, app }) => {
  const dataDir = join(app.root, "sources", "Zotero");
  const linkedDir = join(app.root, "sources", "linked");
  let projectId = "";
  let libraryPath = "";
  let projectFolder = "";
  const sourcesOnDisk = () => readdirSync(join(libraryPath, projectFolder, "Sources")).filter((n) => !n.startsWith("."));
  const listed = async () => (await app.api<SourceList>("GET", `/projects/${projectId}/sources?limit=500`)).body;
  const collections = async () => (await app.api<{ collections: Array<{ id: string; name: string; parentId?: string }> }>("GET", `/projects/${projectId}/collections`)).body.collections;
  const batches = async () => (await app.api<{ batches: Batch[] }>("GET", `/projects/${projectId}/imports`)).body.batches;
  /** The PDF of "Markets and Memory": in Zotero a linked file outside the data folder. */
  const linkedPdfAsset = async () => {
    const book = (await listed()).items.find((i) => i.title === "Markets and Memory")!;
    const stored = (await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${book.id}`)).body;
    return stored.assets.find((a) => a.role === "original" && a.mime === "application/pdf");
  };

  await test.step("set-up: the Zotero fixture data folder, a library and a project (through the service)", async () => {
    // Five items in the user library (two in collections Urban > Food), one linked PDF outside the data folder.
    buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "okafor zotero" }), linkedPdf: await buildPdf({ extra: "adebayo linked" }), linkedDir });
    ({ projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Urban food library", project: "Market studies" }));
  });

  await test.step("the wizard scans the Zotero data folder and asks about the file outside it", async () => {
    await openWizard(page, "Zotero library", "Zotero data folder", dataDir);
    await scanAndRun(page, async () => {
      const scan = page.getByRole("region", { name: "Scan results" });
      await expect(scan.getByRole("definition").first()).toHaveText("5"); // Items
      await expect(scan.getByText(/Not imported from Zotero: 1 standalone note/)).toBeVisible();
      const outside = scan.getByRole("region", { name: "Files outside the source folder" });
      await expect(outside.getByRole("group", { name: linkedDir })).toBeVisible();
      await outside.getByRole("checkbox", { name: "Approve this folder and its subfolders" }).check();
      // Nothing changed yet.
      expect((await listed()).total).toBe(0);
    });
  });

  await test.step("the report: four created, one waiting for review; the service agrees", async () => {
    await expect(page.getByText("Import 1. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 4");
    await expect(reportRow(page, "Waiting for review")).toHaveAccessibleName("Waiting for review 1");
    await expect(page.getByRole("group").filter({ hasText: "Notes about files" })).toHaveCount(0); // the linked PDF was approved
    const [b] = await batches();
    expect(b).toMatchObject({ number: 1, state: "finished", counts: { created: 4, needsReview: 1, failed: 0 } });
    const list = await listed();
    expect(list.items.map((i) => i.title).sort()).toEqual(ZOTERO_TITLES);
    // On disk: one folder per source in the project's Sources folder.
    expect(sourcesOnDisk()).toHaveLength(5);
    // The approved linked PDF is part of its source (D4: kept as a link, see below).
    expect(await linkedPdfAsset()).toBeDefined();
  });

  await blockedBy("D4", "with “Copy into the library” chosen, the file Zotero links to is copied in (or the report says it stays linked)", async () => {
    const pdf = (await linkedPdfAsset())!;
    expect(pdf.linked, JSON.stringify(pdf)).toBeUndefined();
    expect(existsSync(join(libraryPath, ...pdf.path.split("/")))).toBe(true);
  });

  await test.step("collections are recreated: Urban, and Food inside it", async () => {
    const cs = await collections();
    const urban = cs.find((c) => c.name === "Urban");
    expect(urban, JSON.stringify(cs)).toBeDefined();
    expect(cs.find((c) => c.name === "Food")).toMatchObject({ parentId: urban!.id });
    expect(cs).toHaveLength(2);
  });

  await test.step("review one item: edit its title and accept it", async () => {
    await page.getByRole("link", { name: "Open the review queue (1 item)" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    const list = page.getByRole("list", { name: "Items waiting for review (1)" });
    await expect(list.getByRole("button", { name: `Show ${REVIEWED}` })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Why it needs review" }).getByText("Container (journal or site name) is missing.")).toBeVisible();
    await page.getByRole("group", { name: "Decide this item" }).getByRole("button", { name: "Edit" }).click();
    const form = page.getByRole("form", { name: "Edit before accepting" });
    await form.getByRole("textbox", { name: "Title" }).fill(REVIEWED_AS);
    await form.getByRole("button", { name: "Save and accept" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Saved and accepted: ${REVIEWED}` })).toBeVisible();
    await expect(page.getByText("Nothing is waiting for review in this import.")).toBeVisible();
    // What the service persisted: the queue is empty and the source carries the edited title.
    const [b] = await batches();
    expect((await app.api<{ items: unknown[] }>("GET", `/imports/${b!.batchId}/review`)).body.items).toEqual([]);
    expect((await listed()).items.map((i) => i.title)).toContain(REVIEWED_AS);
  });

  await blockedBy("D1", "back from the review queue to the import's report and its Undo", async () => {
    await page.goBack();
    await expect(page.getByRole("heading", { level: 2, name: "Report and undo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo import" })).toBeVisible();
  });

  await test.step("the library shows the imported sources and the recreated collections", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${projectId}`); // D1: the way back is to the library
    await expect(page.getByRole("heading", { level: 1, name: "Urban food library" })).toBeVisible();
    const tree = page.getByRole("tree", { name: "Collections" });
    await expect(tree.getByRole("treeitem", { name: "Urban" })).toHaveAttribute("aria-level", "1");
    await expect(tree.getByRole("treeitem", { name: "Food" })).toHaveAttribute("aria-level", "2");
    const table = page.getByRole("table", { name: "Sources" });
    await expect(page.getByText("5 sources", { exact: true })).toBeVisible();
    await expect(table.getByRole("button", { name: REVIEWED_AS })).toBeVisible();
    await tree.getByRole("treeitem", { name: "Food" }).click();
    await expect(page.getByText("1 source", { exact: true })).toBeVisible();
    await expect(table.getByRole("button", { name: "Feeding the City: Informal Markets in Lagos" })).toBeVisible();
    await tree.getByRole("treeitem", { name: "All sources" }).click();
    await expect(page.getByText("5 sources", { exact: true })).toBeVisible();
  });

  await blockedBy("D2", "a source accepted in the review queue is no longer marked “Needs review” in the library", async () => {
    const row = page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ has: page.getByRole("button", { name: REVIEWED_AS }) });
    await expect(row.getByText("Needs review")).toHaveCount(0);
    expect((await listed()).items.find((i) => i.title === REVIEWED_AS)?.needsReview).toBe(false);
  });

  await test.step("undo the first import (through the service: D1 leaves no way to its Undo in the UI)", async () => {
    const [b] = await batches();
    const r = await app.api<{ removedSources: number }>("POST", `/imports/${b!.batchId}/undo`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.removedSources).toBe(5);
    expect((await listed()).total).toBe(0);
    expect(await collections()).toEqual([]);
  });

  await test.step("import again: the same items come back, with their collections", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${projectId}`);
    await openWizard(page, "Zotero library", "Zotero data folder", dataDir);
    await scanAndRun(page, async () => {
      // Undone items are not "already imported" and were not deleted by the researcher.
      await expect(page.getByRole("region", { name: "Scan results" }).getByRole("definition").first()).toHaveText("5");
      await page.getByRole("checkbox", { name: "Approve this folder and its subfolders" }).check();
    });
    await expect(page.getByText("Import 2. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 4");
    await expect(reportRow(page, "Waiting for review")).toHaveAccessibleName("Waiting for review 1");
    expect((await listed()).items.map((i) => i.title).sort()).toEqual(ZOTERO_TITLES);
    expect((await collections()).map((c) => c.name).sort()).toEqual(["Food", "Urban"]);
  });

  await test.step("undo from the report: the dialog names what goes, and everything the import made is gone", async () => {
    await page.getByRole("button", { name: "Undo import" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove 5 imported sources?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Undo import" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Removed 5 sources and restored 0 sources that had been merged or updated." })).toBeVisible();
    await expect(page.getByText("Import 2. This import was undone.")).toBeVisible();
    expect((await listed()).total).toBe(0);
    expect(await collections()).toEqual([]);
    expect((await batches()).map((b) => [b.number, b.state])).toEqual([
      [2, "undone"],
      [1, "undone"],
    ]);
    expect(sourcesOnDisk()).toEqual([]);
  });

  await test.step("import once more after the undo: everything is back", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${projectId}`);
    await openWizard(page, "Zotero library", "Zotero data folder", dataDir);
    await scanAndRun(page, () => page.getByRole("checkbox", { name: "Approve this folder and its subfolders" }).check());
    await expect(page.getByText("Import 3. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 4");
    expect((await listed()).total).toBe(5);
    expect(sourcesOnDisk()).toHaveLength(5);
    expect((await collections()).map((c) => c.name).sort()).toEqual(["Food", "Urban"]);
  });
});

// ---------- scenario 4 ----------

const CID = "6F1D2A3B-0000-4C5D-8E9F-123456789ABC";
const LAT = 40.7128;
const LON = -74.006;
const PASSPHRASE = "harbour wall at low tide";
/** Rules as in the device-import tests: locations coarsened. Coarsening needs encryption (R85 M5), so the project is encrypted. */
const COARSEN_RULES = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: required\nsharing:\n  locationMetadata: coarsen\ncaptureMethods: [device_import, manual_upload]\nprocessing:\n  metadata_lookup: []\n";

/** The bits of exiftool-vendored (a dependency of @ao/library) these checks use. */
interface ExifToolLike {
  write(path: string, tags: Record<string, unknown>, opts: { writeArgs: string[] }): Promise<void>;
  readRaw(path: string, opts: { readArgs: string[] }): Promise<Record<string, unknown>>;
  end(): Promise<void>;
}
function exiftool(): ExifToolLike {
  const { ExifTool } = createRequire(join(LIBRARY_DIR, "package.json"))("exiftool-vendored") as { ExifTool: new (o: { taskTimeoutMillis: number }) => ExifToolLike };
  return new ExifTool({ taskTimeoutMillis: 30_000 });
}

/**
 * DCIM/100APPLE/IMG_0001.HEIC + IMG_0001.MOV: an iPhone Live Photo pair (one content identifier,
 * exact GPS), made as packages/library/src/import/device.test.ts makes it: the still by
 * tests/fixtures/device_media.py in the worker's venv, the video by ffmpeg, its QuickTime tags by exiftool.
 */
async function buildLivePhoto(phone: string): Promise<{ heic: string; mov: string }> {
  const dcim = join(phone, "DCIM", "100APPLE");
  mkdirSync(dcim, { recursive: true });
  const heic = join(dcim, "IMG_0001.HEIC");
  const mov = join(dcim, "IMG_0001.MOV");
  const python = join(REPO_ROOT, "services/media-worker/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const spec = { files: [{ path: heic, format: "HEIF", make: "Apple", model: "iPhone 15 Pro", date: "2026:03:14 10:15:30", offset: "-04:00", lat: LAT, lon: LON, contentIdentifier: CID }] };
  execFileSync(python, [join(REPO_ROOT, "tests/fixtures/device_media.py"), JSON.stringify(spec)], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-c:v", "mpeg4", "-q:v", "5", mov], { stdio: "pipe" });
  const et = exiftool();
  try {
    await et.write(
      mov,
      {
        "Keys:ContentIdentifier": CID,
        "Keys:GPSCoordinates": `${LAT}, ${LON}`,
        "UserData:GPSCoordinates": `${LAT}, ${LON}`,
        "Keys:Make": "Apple",
        "Keys:Model": "iPhone 15 Pro",
        "Keys:CreationDate": "2026:03:14 10:15:31-04:00",
      },
      { writeArgs: ["-overwrite_original"] },
    );
  } finally {
    await et.end();
  }
  return { heic, mov };
}

/** Every location tag of a file (exiftool -n), as "Group:Tag" → value. */
async function locationTags(et: ExifToolLike, path: string): Promise<Record<string, unknown>> {
  const t = await et.readRaw(path, { readArgs: ["-G1", "-a", "-n"] });
  return Object.fromEntries(Object.entries(t).filter(([k]) => /GPS|Location|ISO6709/iu.test(k)));
}

const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;

test("scenario 4: device import of a Live Photo — one source, its proxy, the location coarsened", async ({ page, app }) => {
  const phone = join(app.root, "sources", "PHONE");
  const plain = join(app.root, "plain");
  let projectId = "";
  let libraryPath = "";
  let projectFolder = "";
  let sourceId = "";
  let stored: StoredSource | undefined;

  await test.step("set-up: a phone folder with a HEIC + MOV Live Photo, a library and an encrypted project that coarsens locations", async () => {
    await buildLivePhoto(phone);
    ({ projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Field library", project: "Harbour walk", governanceYaml: COARSEN_RULES, passphrase: PASSPHRASE }));
    mkdirSync(plain, { recursive: true });
  });

  await test.step("the wizard imports the camera folder", async () => {
    await openWizard(page, "Camera or phone folder", "Camera or phone folder", phone);
    await scanAndRun(page, async () => {
      await expect(page.getByRole("region", { name: "Scan results" }).getByText(/image: 1, video: 1/)).toBeVisible();
    });
    await expect(page.getByText("Import 1. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 1");
    await expect(reportRow(page, "Failed")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Project rules applied" }).getByText("store: allow_with_conditions")).toBeVisible();
  });

  await test.step("one source holds both files of the pair, and a proxy for each", async () => {
    const list = (await app.api<SourceList>("GET", `/projects/${projectId}/sources`)).body;
    expect(list.total).toBe(1);
    sourceId = list.items[0]!.id;
    expect(list.items[0]!.type).toBe("field-photo");
    // Proxies are made in the background after the import: wait for both (generous: the real worker runs ffmpeg).
    await expect
      .poll(async () => (await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${sourceId}`)).body.assets.filter((a) => a.role === "derived").length, { timeout: 60_000 })
      .toBe(2);
    stored = (await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${sourceId}`)).body;
    const originals = stored.assets.filter((a) => a.role === "original");
    expect(originals.map((a) => a.kind).sort()).toEqual(["image", "video"]);
    const [still, video] = [originals.find((a) => a.kind === "image")!, originals.find((a) => a.kind === "video")!];
    expect(still.metadata?.pairedAssetId).toBe(video.id);
    expect(video.metadata?.pairedAssetId).toBe(still.id);
    const proxies = stored.assets.filter((a) => a.role === "derived");
    expect(proxies.map((p) => [p.kind, p.derivation?.operation, p.derivation?.parents, p.derivation?.params?.location]).sort()).toEqual(
      [
        ["proxy", "image.proxy", [still.id], "coarsen"],
        ["proxy", "video.proxy", [video.id], "coarsen"],
      ].sort(),
    );
  });

  await test.step("the source screen lists the source and its proxies", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    const table = page.getByRole("table", { name: "Sources" });
    await expect(page.getByText("1 source", { exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "Field photo" })).toBeVisible();
    await table.getByRole("button", { name: "2026-03-14 iPhone 15 Pro - IMG_0001" }).click();
    const detail = page.getByRole("region", { name: "Source details" });
    await expect(detail.getByRole("heading", { level: 2, name: "2026-03-14 iPhone 15 Pro - IMG_0001" })).toBeVisible();
    const files = detail.getByRole("list").filter({ hasText: "proxy" });
    await expect(files.getByRole("listitem").filter({ hasText: /proxy · .* · encrypted/ })).toHaveCount(2);
  });

  await blockedBy("D3", "the source screen displays the proxy (the picture, not only its file name)", async () => {
    const detail = page.getByRole("region", { name: "Source details" });
    await expect(detail.getByRole("img")).toHaveCount(1);
  });

  await test.step("what the service stored carries no exact location: the record has none, and every stored file is encrypted", async () => {
    const record = JSON.stringify(stored);
    for (const exact of [String(LAT), String(LON), "40.7128", "74.006"]) expect(record).not.toContain(exact);
    const folder = join(libraryPath, ...stored!.source.folder.split("/"));
    const files = filesUnder(folder);
    expect(files.length).toBeGreaterThanOrEqual(5); // source record, two originals, two proxies
    expect(files.filter((f) => !f.endsWith(".enc")), "files stored in the clear").toEqual([]);
    // The phone's own file names and its folder are not used for the plaintext anywhere in the library either.
    expect(filesUnder(libraryPath).filter((f) => /IMG_0001\.(HEIC|MOV)$/iu.test(f))).toEqual([]);
  });

  await test.step("each proxy's own metadata: location rounded to one decimal; the original keeps the exact one, encrypted", async () => {
    const et = exiftool();
    try {
      const projectRoot = join(libraryPath, projectFolder);
      for (const proxy of stored!.assets.filter((a) => a.role === "derived")) {
        const ext = proxy.mime === "video/mp4" ? "mp4" : "jpg";
        const out = join(plain, `${proxy.id}.${ext}`);
        decryptStoredFile(app, { projectRoot, file: join(libraryPath, ...proxy.path.split("/")), passphrase: PASSPHRASE, output: out });
        const tags = await locationTags(et, out);
        expect(tags["Composite:GPSLatitude"], `${proxy.derivation?.operation}: ${JSON.stringify(tags)}`).toBe(40.7);
        expect(tags["Composite:GPSLongitude"], `${proxy.derivation?.operation}: ${JSON.stringify(tags)}`).toBe(-74);
        for (const [k, v] of Object.entries(tags)) if (typeof v === "number" && /Latitude|Longitude/u.test(k)) expect(decimals(v), `${k} = ${v}`).toBeLessThanOrEqual(1);
        expect(JSON.stringify(tags)).not.toMatch(/40\.71|74\.00[1-9]/u);
      }
      // R85 M5: the original keeps its exact location, and is kept only encrypted.
      const still = stored!.assets.find((a) => a.role === "original" && a.kind === "image")!;
      const out = join(plain, "original.heic");
      decryptStoredFile(app, { projectRoot, file: join(libraryPath, ...still.path.split("/")), passphrase: PASSPHRASE, output: out });
      const tags = await locationTags(et, out);
      expect(tags["Composite:GPSLatitude"]).toBeCloseTo(LAT, 4);
      expect(tags["Composite:GPSLongitude"]).toBeCloseTo(LON, 4);
    } finally {
      await et.end();
    }
    expect(readFileSync(join(libraryPath, ...stored!.assets.find((a) => a.role === "original" && a.kind === "image")!.path.split("/"))).subarray(0, 5).toString("latin1")).toBe("AOENC");
  });
});
