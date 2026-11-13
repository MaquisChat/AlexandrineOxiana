/**
 * From a search hit to the annotation, end to end (Task R12), in Chromium and in WebKit: the built
 * app against the real service. A search in the library that finds its words in an annotation
 * ("Found in an annotation") gets the button "Show in the reader: <title>"; pressing it hands the
 * words to the reader in memory (never in the address, history state or a storage), the reader opens
 * the source's file that holds the first matching annotation, filters its annotation list to the
 * matches ("Annotations matching your search (N)", "Show all"), goes to the first and focuses its
 * entry; and says so plainly when nothing matches exactly. `readerHref(..., { annotationId })` opens
 * at an annotation directly, or says it is gone. Waits are for states, never for fixed times.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildZoteroFixture } from "../packages/library/tests/fixtures/zotero/build-fixture.mjs";
import { buildMultiPagePdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";

const NO_EXACT = "None of this source's annotations contains all of these words exactly; the search may have matched another form of a word.";
const GONE = "That highlight or note is no longer there.";

function sourceFile(app: AppHarness, name: string, bytes: Uint8Array): string {
  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

async function attach(app: AppHarness, projectId: string, file: string, toSourceId?: string): Promise<string> {
  const r = await app.api<{ items: Array<{ outcome: string; sourceId?: string }> }>("POST", `/projects/${projectId}/attach`, { paths: [file], ...(toSourceId ? { toSourceId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const sid = r.body.items[0]?.sourceId;
  expect(sid, JSON.stringify(r.body)).toBeTruthy();
  return sid!;
}

async function pdfAssets(app: AppHarness, projectId: string, sid: string): Promise<Array<{ id: string; path: string }>> {
  const sf = await app.api<{ assets: Array<{ id: string; mime: string; role: string; path: string }> }>("GET", `/projects/${projectId}/sources/${sid}`);
  return sf.body.assets.filter((a) => a.role === "original" && a.mime === "application/pdf");
}

async function titleOf(app: AppHarness, projectId: string, sid: string): Promise<string> {
  const stored = await app.api<{ source: { title: { variants: Array<{ value: string }> } } }>("GET", `/projects/${projectId}/sources/${sid}`);
  return stored.body.source.title.variants[0]!.value;
}

async function annotate(app: AppHarness, projectId: string, sid: string, assetId: string, o: { page: number; quote?: string; body?: string; kind?: string }): Promise<string> {
  const r = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, {
    kind: o.kind ?? "highlight",
    assetId,
    anchors: [{ page: o.page, rects: [{ x: 50, y: 700, w: 100, h: 12 }] }],
    ...(o.quote !== undefined ? { quote: o.quote } : {}),
    ...(o.body !== undefined ? { body: o.body } : {}),
    colorName: "yellow",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
}

/** Searches the library for `words`, as a person would, and waits for the answer to show `title` as found in an annotation. */
async function searchFor(page: Page, projectId: string, words: string, title: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole("searchbox", { name: "Search sources" }).fill(words);
  const row = page.getByRole("table", { name: "Sources" }).getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await expect(row).toContainText("Found in an annotation");
}

const showInReader = (page: Page, title: string) => page.getByRole("table", { name: "Sources" }).getByRole("button", { name: `Show in the reader: ${title}`, exact: true });
const annotationList = (page: Page, heading: string) => page.getByRole("region", { name: heading });
const entry = (page: Page, id: string) => page.locator(`[data-entry="${id}"]`);
const pageField = (page: Page) => page.getByRole("toolbar", { name: "Reader" }).getByLabel("Page");
const storages = (page: Page) => page.evaluate(() => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]));

test("a search for a word of an imported note opens the reader at that note", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The Zotero fixture of the import tests, its article's PDF made three pages long: the imported
  // highlight "informal markets" (page 1, comment "key claim") and the imported note "check the numbers" (page 3).
  const dataDir = join(app.root, "sources", "Zotero");
  const linkedDir = join(app.root, "sources", "linked");
  buildZoteroFixture(dataDir, { pdf: await buildMultiPagePdf(3), linkedPdf: await buildMultiPagePdf(5), linkedDir });
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Market studies" });
  const started = await app.api<{ batchId: string }>("POST", `/projects/${projectId}/import`, {
    adapter: { kind: "zotero-local", dataDir },
    options: { ocr: false, approveOutside: { folders: [linkedDir] } },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await expect
    .poll(async () => (await app.api<{ batches: Array<{ batchId: string; state: string }> }>("GET", `/projects/${projectId}/imports`)).body.batches.find((b) => b.batchId === started.body.batchId)?.state, { timeout: 60_000 })
    .toBe("finished");
  const sources = await app.api<{ items: Array<{ id: string; title: string }> }>("GET", `/projects/${projectId}/sources?limit=500`);
  const title = "Feeding the City: Informal Markets in Lagos";
  const sid = sources.body.items.find((i) => i.title === title)!.id;
  const listed = await app.api<{ annotations: Array<{ id: string; kind: string; body?: string }> }>("GET", `/projects/${projectId}/sources/${sid}/annotations`);
  const note = listed.body.annotations.find((a) => a.body === "check the numbers")!;
  const highlight = listed.body.annotations.find((a) => a.kind === "highlight")!;
  expect(note).toBeTruthy();

  await searchFor(page, projectId, "numbers", title);
  await showInReader(page, title).click();

  await test.step("the reader opens at the note, filtered to the matches, with the address carrying ids only", async () => {
    await expect(page).toHaveURL(new RegExp(`/reader\\?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(sid)}$`));
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(annotationList(page, "Annotations matching your search (1)")).toBeVisible();
    await expect(entry(page, note.id)).toBeFocused();
    await expect(entry(page, highlight.id)).toHaveCount(0);
    await expect(pageField(page)).toHaveValue("3");
    await expect(page.getByRole("region", { name: "Page 3 of 3" })).toBeVisible();
    await expect(page.locator(`.ao-hl[data-annotation="${note.id}"]`)).toHaveClass(/ao-hl--selected/);
    expect(page.url()).not.toContain("numbers");
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("numbers");
    expect(await storages(page)).not.toContain("numbers");
    await expect(page.getByText("numbers", { exact: true })).toHaveCount(0);
  });

  await test.step("Show all returns to the whole list, the focus kept on the same entry", async () => {
    await page.getByRole("button", { name: "Show all" }).click();
    await expect(annotationList(page, "Annotations (2)")).toBeVisible();
    await expect(entry(page, highlight.id)).toHaveCount(1);
    await expect(entry(page, note.id)).toBeFocused();
    await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
  });

  await test.step("the words were taken once: a reload of the reader shows the whole list", async () => {
    await page.reload();
    await expect(annotationList(page, "Annotations (2)")).toBeVisible();
    await expect(page.getByText(NO_EXACT)).toHaveCount(0);
  });
  expect(errors).toEqual([]);
});

test("the reader opens the source's file that holds the first matching annotation, here its second", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Two files" });
  const sid = await attach(app, projectId, sourceFile(app, "first.pdf", await buildMultiPagePdf(3)));
  await attach(app, projectId, sourceFile(app, "second.pdf", await buildMultiPagePdf(4)), sid);
  const files = await pdfAssets(app, projectId, sid);
  expect(files).toHaveLength(2);
  const [one, two] = files as [{ id: string; path: string }, { id: string; path: string }];
  const title = await titleOf(app, projectId, sid);
  await annotate(app, projectId, sid, one.id, { page: 1, quote: "Nothing of interest" });
  const later = await annotate(app, projectId, sid, two.id, { page: 4, quote: "the zeppelin hangar at dawn" });
  const earlier = await annotate(app, projectId, sid, two.id, { page: 2, body: "zeppelin again" });

  await searchFor(page, projectId, "zeppelin", title);
  await showInReader(page, title).click();

  await expect(annotationList(page, "Annotations matching your search (2)")).toBeVisible();
  // The second file is the one open, and the list is its own.
  const second = page.getByRole("group", { name: "File" }).getByRole("radio").nth(1);
  await expect(second).toBeChecked();
  // The first match in reading order: page 2's note, before page 4's highlight.
  await expect(entry(page, earlier)).toBeFocused();
  await expect(entry(page, later)).toHaveCount(1);
  await expect(pageField(page)).toHaveValue("2");
  await expect(page.getByRole("region", { name: "Page 2 of 4" })).toBeVisible();
  expect(page.url()).not.toContain("zeppelin");
  expect(await storages(page)).not.toContain("zeppelin");

  await test.step("choosing the first file by hand drops the filter: its own whole list", async () => {
    await page.getByRole("group", { name: "File" }).getByRole("radio").nth(0).check();
    await expect(page.getByRole("region", { name: "Page 1 of 3" })).toBeVisible();
    await expect(annotationList(page, "Annotations (1)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
  });
  expect(errors).toEqual([]);
});

test("when the search matched another form of a word, the reader says so plainly and shows the whole list", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Hyphens" });
  const sid = await attach(app, projectId, sourceFile(app, "three.pdf", await buildMultiPagePdf(3)));
  const [file] = await pdfAssets(app, projectId, sid);
  const title = await titleOf(app, projectId, sid);
  // The search index splits "self-" and "evident" at the hyphen and finds "evident"; a word cut at a
  // line end is joined by the matcher ("selfevident"), so no annotation contains "evident" exactly (A4).
  const hyphenated = await annotate(app, projectId, sid, file!.id, { page: 2, quote: "a truth held self-\nevident by all" });
  const other = await annotate(app, projectId, sid, file!.id, { page: 3, quote: "something else entirely" });

  await searchFor(page, projectId, "evident", title);
  await showInReader(page, title).click();

  await expect(page.getByText(NO_EXACT)).toBeVisible();
  await expect(annotationList(page, "Annotations (2)")).toBeVisible();
  await expect(entry(page, hyphenated)).toHaveCount(1);
  await expect(entry(page, other)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Show all" })).toHaveCount(0);
  await expect(pageField(page)).toHaveValue("1");
  expect(page.url()).not.toContain("evident");
  expect(errors).toEqual([]);
});

test("an address naming an annotation opens at it; one that is gone opens the file with a plain sentence", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "By address" });
  const sid = await attach(app, projectId, sourceFile(app, "one.pdf", await buildMultiPagePdf(3)));
  await attach(app, projectId, sourceFile(app, "two.pdf", await buildMultiPagePdf(4)), sid);
  const [one, two] = (await pdfAssets(app, projectId, sid)) as unknown as [{ id: string }, { id: string }];
  await annotate(app, projectId, sid, one.id, { page: 1, quote: "on the first file" });
  const target = await annotate(app, projectId, sid, two.id, { page: 3, quote: "the target highlight" });
  await annotate(app, projectId, sid, two.id, { page: 1, quote: "another" });

  await page.goto(`${APP_ORIGIN}/reader?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(sid)}&annotation=${encodeURIComponent(target)}`);
  await expect(page.getByRole("group", { name: "File" }).getByRole("radio").nth(1)).toBeChecked();
  await expect(annotationList(page, "Annotations (2)")).toBeVisible();
  await expect(entry(page, target)).toBeFocused();
  await expect(pageField(page)).toHaveValue("3");
  await expect(page.locator(`.ao-hl[data-annotation="${target}"]`)).toHaveClass(/ao-hl--selected/);
  await expect(page.getByText(GONE)).toHaveCount(0);

  await page.goto(`${APP_ORIGIN}/reader?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(sid)}&annotation=no-such-annotation`);
  await expect(page.getByText(GONE)).toBeVisible();
  await expect(annotationList(page, "Annotations (1)")).toBeVisible();
  await expect(pageField(page)).toHaveValue("1");
  expect(errors).toEqual([]);
});
