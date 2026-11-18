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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { buildPdf } from "../tests/fixtures/generate.mjs";
import { buildZoteroFixture } from "../packages/library/tests/fixtures/zotero/build-fixture.mjs";
import { APP_ORIGIN, decryptStoredFile, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR, REPO_ROOT } from "./paths.js";
import { pressByMouse } from "./press.js";

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


/** A library and project, the Zotero fixture data folder, and readers of what the service holds. */
async function zoteroSetUp(app: AppHarness, page: Page) {
  const dataDir = join(app.root, "sources", "Zotero");
  const linkedDir = join(app.root, "sources", "linked");
  // Five items in the user library (two in collections Urban > Food), one linked PDF outside the data folder.
  const fx = buildZoteroFixture(dataDir, { pdf: await buildPdf({ extra: "okafor zotero" }), linkedPdf: await buildPdf({ extra: "adebayo linked" }), linkedDir });
  const { projectId, libraryPath, projectFolder } = await libraryWithProject(app, page, { library: "Urban food library", project: "Market studies" });
  const listed = async (query = "") => (await app.api<SourceList>("GET", `/projects/${projectId}/sources?limit=500${query}`)).body;
  return {
    dataDir,
    linkedDir,
    linkedPdfPath: fx.linkedPdf,
    projectId,
    libraryPath,
    projectFolder,
    listed,
    sourcesOnDisk: () => readdirSync(join(libraryPath, projectFolder, "Sources")).filter((n) => !n.startsWith(".")),
    collections: async () => (await app.api<{ collections: Array<{ id: string; name: string; parentId?: string }> }>("GET", `/projects/${projectId}/collections`)).body.collections,
    batches: async () => (await app.api<{ batches: Batch[] }>("GET", `/projects/${projectId}/imports`)).body.batches,
    /** The PDF of "Markets and Memory": in Zotero a linked file outside the data folder. */
    linkedPdfAsset: async () => {
      const book = (await listed()).items.find((i) => i.title === "Markets and Memory")!;
      const stored = (await app.api<StoredSource>("GET", `/projects/${projectId}/sources/${book.id}`)).body;
      return stored.assets.find((a) => a.role === "original" && a.mime === "application/pdf");
    },
  };
}

/** The wizard's Zotero import with its defaults ("Copy into the library"), the outside folder approved. */
async function importZotero(page: Page, dataDir: string): Promise<void> {
  await openWizard(page, "Zotero library", "Zotero data folder", dataDir);
  await scanAndRun(page, () => page.getByRole("checkbox", { name: "Approve this folder and its subfolders" }).check());
}

/** From the report: the review queue, and a plain Accept of its one item. */
async function acceptTheReviewItem(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Open the review queue (1 item)" }).click();
  await expect(page.getByRole("list", { name: "Items waiting for review (1)" })).toBeVisible();
  // R362 d: the panel takes a mouse press only where the pointer really moved over the control.
  await pressByMouse(page, page.getByRole("group", { name: "Decide this item" }).getByRole("button", { name: "Accept" }));
  await expect(page.getByText("Nothing is waiting for review in this import.")).toBeVisible();
}

test("scenario 3: bulk import of a Zotero data folder — collections, review, report, undo, import again", async ({ page, app }) => {
  // Three imports and two undos against the real service: three times the usual time on a slow machine.
  test.slow();
  let z!: Awaited<ReturnType<typeof zoteroSetUp>>;
  let projectId = "";
  const listed = (query = "") => z.listed(query);
  const collections = () => z.collections();
  const batches = () => z.batches();
  const sourcesOnDisk = () => z.sourcesOnDisk();

  await test.step("set-up: the Zotero fixture data folder, a library and a project (through the service)", async () => {
    z = await zoteroSetUp(app, page);
    projectId = z.projectId;
  });
  const { dataDir, linkedDir } = z;

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
    // The approved linked PDF is part of its source (how it is stored: D4).
    expect(await z.linkedPdfAsset()).toBeDefined();
    // R392 (FR-A21): the run's total was the data folder's real five items, never "done + 1". Five items run too fast
    // to watch the run screen's "x of 5 items" reliably; the batch record keeps the total its progress events carried.
    const rec = JSON.parse(readFileSync(join(z.libraryPath, z.projectFolder, "imports", "batch-0001", "batch.json"), "utf8")) as { total?: number };
    expect(rec.total).toBe(5);
  });

  await test.step("with “Copy into the library”, the approved Zotero linked file is copied in; the report gives the files copied and the files left as links (R136)", async () => {
    const report = page.getByRole("region", { name: "Report and undo" });
    await expect(reportRow(page, "Files copied into the library")).toHaveAccessibleName(/^Files copied into the library \d+$/);
    await expect(reportRow(page, "Files left as links")).toHaveAccessibleName("Files left as links 0");
    await expect(report).toBeVisible();
    const pdf = (await z.linkedPdfAsset())!;
    expect(pdf.linked, JSON.stringify(pdf)).toBeUndefined();
    const stored = join(z.libraryPath, ...pdf.path.split("/"));
    expect(resolve(stored).startsWith(resolve(z.libraryPath) + sep), `${pdf.path} is inside the library`).toBe(true);
    expect(readFileSync(stored).equals(readFileSync(z.linkedPdfPath))).toBe(true);
  });

  await test.step("collections are recreated: Urban, and Food inside it, each holding its items", async () => {
    const cs = await collections();
    const urban = cs.find((c) => c.name === "Urban");
    const food = cs.find((c) => c.name === "Food");
    expect(urban, JSON.stringify(cs)).toBeDefined();
    expect(food).toMatchObject({ parentId: urban!.id });
    expect(cs).toHaveLength(2);
    // Membership as in Zotero: "Markets and Memory" in Urban, "Feeding the City" in Food.
    expect((await listed(`&collection=${urban!.id}`)).items.map((i) => i.title)).toContain("Markets and Memory");
    expect((await listed(`&collection=${food!.id}`)).items.map((i) => i.title)).toEqual(["Feeding the City: Informal Markets in Lagos"]);
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
    await pressByMouse(page, form.getByRole("button", { name: "Save and accept" }));
    await expect(page.getByRole("status").filter({ hasText: `Saved and accepted: ${REVIEWED}` })).toBeVisible();
    await expect(page.getByText("Nothing is waiting for review in this import.")).toBeVisible();
    // What the service persisted: the queue is empty and the source carries the edited title.
    const [b] = await batches();
    expect((await app.api<{ items: unknown[] }>("GET", `/imports/${b!.batchId}/review`)).body.items).toEqual([]);
    expect((await listed()).items.map((i) => i.title)).toContain(REVIEWED_AS);
  });

  await test.step("back from the review queue to the import's report and its Undo (D1): by the queue's link and by the browser's Back", async () => {
    await page.getByRole("link", { name: "Back to the import's report and undo" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Report and undo" })).toBeVisible();
    await expect(page.getByText("Import 1. The import finished.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo import" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
    await page.goBack(); // the wizard's own entry names the import once it starts
    await expect(page.getByRole("heading", { level: 2, name: "Report and undo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo import" })).toBeVisible();
  });

  await test.step("the library shows the imported sources and the recreated collections", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
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

  await test.step("the accepted source no longer carries “Needs review”, the others neither (D2, R137: only an item waiting in the queue)", async () => {
    const table = page.getByRole("table", { name: "Sources" });
    const row = table.getByRole("row").filter({ has: page.getByRole("button", { name: REVIEWED_AS, exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Needs review")).toHaveCount(0);
    await expect(table.getByText("Needs review")).toHaveCount(0);
    expect((await listed()).items.filter((i) => i.needsReview)).toEqual([]);
  });

  await test.step("undo the first import from its report, reached again from the import screen's recent imports (D1)", async () => {
    await page.getByRole("link", { name: "Import", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Bulk import" })).toBeVisible();
    await page.getByRole("region", { name: "Recent imports" }).getByRole("link", { name: /^Import 1 — .*\(finished\)$/ }).click();
    await expect(page.getByText("Import 1. The import finished.")).toBeVisible();
    await page.getByRole("button", { name: "Undo import" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove 5 imported sources?" });
    await dialog.getByRole("button", { name: "Undo import" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Removed 5 imported sources." })).toBeVisible();
    const [b] = await batches();
    expect(b).toMatchObject({ number: 1, state: "undone" });
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
    await expect(page.getByRole("status").filter({ hasText: "Removed 5 imported sources." })).toBeVisible();
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

// D2 (fixed in Task 46b), with a plain Accept rather than the scenario's edit, and back to the library without a reload.
test("a plain Accept in the review queue clears the library row's “Needs review” (R137), seen without reloading the page", async ({ page, app }) => {
  const z = await zoteroSetUp(app, page);
  await importZotero(page, z.dataDir);
  await acceptTheReviewItem(page);
  await page.getByRole("link", { name: "Back to library" }).click();
  const row = page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ has: page.getByRole("button", { name: REVIEWED, exact: true }) });
  await expect(row).toHaveCount(1);
  // R137: the badge means "an item waits in the review queue"; nothing is asserted about field-level verification.
  await expect(row.getByText("Needs review")).toHaveCount(0);
});

// ---------- an import that merges, and its undo (FR-214) ----------

/** The first export: two articles, each with its DOI, title, author, year and journal, and nothing more. */
const FIRST_BIB = [
  "@article{okafor2024feeding, title={Feeding the City: Informal Markets in Lagos}, author={Okafor, Ngozi}, year={2024}, journal={Urban Studies}, doi={10.5555/ao.urban.2024.017}}",
  "@article{mensah2019street, title={Street Vendors and the State}, author={Mensah, Kofi}, year={2019}, journal={African Affairs}, doi={10.5555/ao.street.2019.042}}",
].join("\n");
/**
 * A later export from elsewhere: the same two articles (the same DOIs) carrying details the library's
 * sources lack — volume, issue, pages, publisher, a keyword — and one article that is new.
 */
const SECOND_BIB = [
  "@article{okafor2024city, title={Feeding the City: Informal Markets in Lagos}, author={Okafor, Ngozi}, year={2024}, journal={Urban Studies}, volume={61}, number={4}, pages={812--830}, publisher={Sage}, keywords={food systems}, doi={10.5555/ao.urban.2024.017}}",
  "@article{mensah2019vendors, title={Street Vendors and the State}, author={Mensah, Kofi}, year={2019}, journal={African Affairs}, volume={118}, pages={1--22}, doi={10.5555/ao.street.2019.042}}",
  "@article{asante2021water, title={Water Access in Peri-Urban Accra}, author={Asante, Ama}, year={2021}, journal={Habitat International}, volume={9}, doi={10.5555/ao.water.2021.003}}",
].join("\n");

/** A source as the service stores it, without the stamp of its last change (an undo is itself a change). */
interface StoredForCompare {
  source: Record<string, unknown> & { tagIds: string[] };
  assets: unknown[];
}
const unstamped = (s: StoredForCompare) => {
  const { modifiedAt: _a, modifiedBy: _b, ...rest } = s.source;
  return { source: rest, assets: s.assets };
};

test("an import that merges into existing sources, undone: the merged sources are restored as they were before it (FR-214)", async ({ page, app }) => {
  test.slow();
  const dir = join(app.root, "sources", "references");
  mkdirSync(dir, { recursive: true });
  const first = join(dir, "first.bib");
  const second = join(dir, "second.bib");
  writeFileSync(first, FIRST_BIB);
  writeFileSync(second, SECOND_BIB);
  const { projectId } = await libraryWithProject(app, page, { library: "Merge library", project: "Street markets" });
  const listed = async () => (await app.api<SourceList>("GET", `/projects/${projectId}/sources?limit=500`)).body;
  const stored = async (id: string) => (await app.api<StoredForCompare>("GET", `/projects/${projectId}/sources/${id}`)).body;
  const tags = async () => (await app.api<{ tags: Array<{ id: string; name: string }> }>("GET", `/projects/${projectId}/tags`)).body;
  const batches = async () => (await app.api<{ batches: Array<Batch & { counts: Batch["counts"] & { merged: number } }> }>("GET", `/projects/${projectId}/imports`)).body.batches;
  const importBib = async (path: string) => {
    await openWizard(page, "Reference file", "File path", path);
    await expect(page.getByRole("combobox", { name: "Format" })).toHaveValue("bibtex");
    await scanAndRun(page);
  };

  const before = new Map<string, ReturnType<typeof unstamped>>();
  await test.step("the first import makes two sources; what the service holds of them is kept for comparison", async () => {
    await importBib(first);
    await expect(page.getByText("Import 1. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 2");
    const list = await listed();
    expect(list.items.map((i) => i.title).sort()).toEqual(["Feeding the City: Informal Markets in Lagos", "Street Vendors and the State"]);
    for (const i of list.items) before.set(i.id, unstamped(await stored(i.id)));
    // What the second import will fill in is absent now.
    for (const s of before.values()) {
      expect(s.source.volume).toBeUndefined();
      expect(s.source.page).toBeUndefined();
      expect(s.source.tagIds).toEqual([]);
    }
  });

  await test.step("the second import, with its default “Merge into the existing source”: one created, two merged", async () => {
    await page.goto(`${APP_ORIGIN}/?project=${projectId}`);
    await importBib(second);
    await expect(page.getByText("Import 2. The import finished.")).toBeVisible();
    await expect(reportRow(page, "Created")).toHaveAccessibleName("Created 1");
    await expect(reportRow(page, "Merged into existing sources")).toHaveAccessibleName("Merged into existing sources 2");
    expect((await batches())[0]).toMatchObject({ number: 2, state: "finished", counts: { created: 1, merged: 2 } });
    const list = await listed();
    expect(list.total).toBe(3);
    // The merge filled in what the sources lacked.
    const okafor = list.items.find((i) => i.title === "Feeding the City: Informal Markets in Lagos")!;
    const mensah = list.items.find((i) => i.title === "Street Vendors and the State")!;
    const o = (await stored(okafor.id)).source;
    expect(o).toMatchObject({ volume: "61", issue: "4", page: "812–830", publisher: "Sage" });
    expect(o.tagIds).toHaveLength(1);
    expect((await stored(mensah.id)).source).toMatchObject({ volume: "118", page: "1–22" });
    expect((await tags()).tags.map((t) => t.name)).toContain("food systems");
  });

  await test.step("undo the second import: the new source goes, and the two merged sources are restored exactly as before it", async () => {
    await page.getByRole("button", { name: "Undo import" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove 1 imported source and restore 2 merged sources?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Undo import" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Removed 1 imported source and restored 2 merged sources." })).toBeVisible();
    await expect(page.getByText("Import 2. This import was undone.")).toBeVisible();
    expect((await batches()).map((b) => [b.number, b.state])).toEqual([
      [2, "undone"],
      [1, "finished"],
    ]);
    const list = await listed();
    expect(list.items.map((i) => i.id).sort()).toEqual([...before.keys()].sort());
    for (const [id, was] of before) expect(unstamped(await stored(id)), id).toEqual(was);
    expect((await tags()).tags.map((t) => t.name)).not.toContain("food systems");
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

/** Every property name anywhere in a JSON value. */
function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keysOf);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]);
  return [];
}

test("scenario 4: device import of a Live Photo — one source, its proxy, the location coarsened", async ({ page, app, browserName }) => {
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

  await test.step("the source screen shows the viewing copy as a picture (formerly defect D3), read by authenticated fetch as a blob", async () => {
    const detail = page.getByRole("region", { name: "Source details" });
    // The JPEG viewing copy only: the HEIC original is not a picture a browser shows, and the videos are not pictures.
    await expect(detail.getByRole("img")).toHaveCount(1);
    await expect(detail.getByRole("img")).toHaveAttribute("src", /^blob:/);
    // Decoded, not a broken image: it has a size of its own. Not checked in WebKit: there, under this
    // harness (the app's origin answered by Playwright's route), no blob: picture decodes at all, not
    // even a known-good JPEG made in the page itself, while Chromium decodes the same bytes (Task 34d report).
    if (browserName !== "webkit") await expect.poll(() => detail.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    else test.info().annotations.push({ type: "note", description: "blob: pictures do not decode in WebKit under the route-served app origin; decoding checked in Chromium only" });
  });

  await test.step("what the service stored carries no exact location: the record has none, and every stored file is encrypted", async () => {
    const record = JSON.stringify(stored);
    for (const exact of [String(LAT), String(LON), "40.7128", "74.006"]) expect(record).not.toContain(exact);
    // The record holds no location field at all (so the check above is not vacuous by accident of
    // naming): the coarsened location lives only in the proxies' own metadata, checked next.
    // (A proxy's derivation.params.location names the mode, "coarsen", not a place: derivations are left out.)
    const placeFree = { ...stored!, assets: stored!.assets.map(({ derivation: _mode, ...a }) => a) };
    expect(keysOf(placeFree).filter((k) => /gps|locat|latitude|longitude|^lat$|^lon$|coordinates/iu.test(k))).toEqual([]);
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
