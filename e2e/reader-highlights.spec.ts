/**
 * Highlights in the PDF reader end to end (Task R8 onwards), in Chromium and in WebKit: the built
 * app's reader screen, reached by clicking as a person would (library -> the source -> "Read the
 * PDF"), against the real service.
 *
 * R8: every annotation of the file is drawn on its page from its PDF rectangles, imported and new
 * alike. "Sits on its words" is measured, not looked at: the highlight's box on screen against the
 * box of pdf.js's text-layer span holding the quoted words (each span is laid over its words by
 * pdf.js, scaled to the words' own width), within a stated tolerance:
 *   - along the line, each end within ALONG_TOLERANCE_PX CSS pixels at 100% (twice that at 200%):
 *     the span's ends are where pdf.js says the words start and end;
 *   - across the line, the highlight's middle within the span, and its height within
 *     ACROSS_TOLERANCE of the span's: the span's height is the font size as the browser's face
 *     measures it, which differs a little from the PDF face's ascent and descent the rectangle
 *     was taken from.
 * The Zotero fixture of the import tests (packages/library/tests/fixtures/zotero/build-fixture.mjs,
 * line 166: "informal markets" on page index 0, rects [[100.5, 200, 300, 215.25]]) is imported
 * through the service with a PDF that has those words exactly in that rectangle; the rotated,
 * offset-crop fixture (tests/fixtures/generate.mjs `buildRotatedCropPdf`: /Rotate 90, a crop box
 * from (50, 60)) gets a highlight made through the service's annotation route, drawn by the same
 * code; and a highlight whose quote no longer matches the words under it says so.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildZoteroFixture } from "../packages/library/tests/fixtures/zotero/build-fixture.mjs";
import { buildMultiPagePdf, buildPdf, buildRotatedCropPdf, buildScanPdf, buildTwoColumnPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR } from "./paths.js";

/** Along the line: each end of the highlight within this many CSS pixels of its words' span, at 100%. */
const ALONG_TOLERANCE_PX = 2;
/** Across the line: the highlight's height within this share of the span's height. */
const ACROSS_TOLERANCE = 0.3;
const CHANGED = "The text here has changed since this highlight was made.";

/** Writes `bytes` as `name` in a folder of the test's own, outside every library. */
function sourceFile(app: AppHarness, name: string, bytes: Uint8Array): string {
  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

/** Attaches `file` to the project; the source's id and its PDF's asset id. */
async function attachPdf(app: AppHarness, projectId: string, file: string): Promise<{ sid: string; aid: string }> {
  const r = await app.api<{ items: Array<{ outcome: string; sourceId?: string }> }>("POST", `/projects/${projectId}/attach`, { paths: [file] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const sid = r.body.items[0]?.sourceId;
  expect(sid, JSON.stringify(r.body)).toBeTruthy();
  return { sid: sid!, aid: await pdfAsset(app, projectId, sid!) };
}

async function pdfAsset(app: AppHarness, projectId: string, sid: string): Promise<string> {
  const sf = await app.api<{ assets: Array<{ id: string; mime: string; role: string }> }>("GET", `/projects/${projectId}/sources/${sid}`);
  const pdf = sf.body.assets.find((a) => a.role === "original" && a.mime === "application/pdf");
  expect(pdf, JSON.stringify(sf.body.assets)).toBeTruthy();
  return pdf!.id;
}

/** The library with the project selected, then the source opened and "Read the PDF" followed, all by clicking. */
async function readFromLibrary(page: Page, app: AppHarness, projectId: string, sid: string): Promise<void> {
  const stored = await app.api<{ source: { title: { variants: Array<{ value: string }> } } }>("GET", `/projects/${projectId}/sources/${sid}`);
  const title = stored.body.source.title.variants[0]!.value;
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("region", { name: "Source details" }).getByRole("link", { name: "Read the PDF" }).click();
  await expect(page).toHaveURL(new RegExp(`/reader\\?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(sid)}`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Reader" });
const zoomValue = (page: Page) => toolbar(page).getByRole("status", { name: "Zoom" });
/** The annotation list beside the pages (Task R9). */
const annotationList = (page: Page) => page.getByRole("region", { name: /^Annotations \(/ });

/** Presses Tab (at most `max` times) until `target` has the focus: the keyboard's own way there. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

/** Zoom in with the toolbar until the zoom reads `pct`. */
async function zoomTo(page: Page, pct: string): Promise<void> {
  const zoomIn = toolbar(page).getByRole("button", { name: "Zoom in" });
  for (let i = 0; i < 8 && (await zoomValue(page).textContent()) !== pct; i++) await zoomIn.click();
  await expect(zoomValue(page)).toHaveText(pct);
}

interface Placed {
  mark: { left: number; top: number; right: number; bottom: number };
  words: { left: number; top: number; right: number; bottom: number };
  /** Whether the line runs across the screen (else down it, on a page turned a quarter). */
  across: boolean;
}

/** The highlight `id`'s box on page `n` and the box of the text-layer span holding `words`, on screen. */
async function placed(page: Page, n: number, id: string, words: string): Promise<Placed> {
  const loc = page.locator(`[data-page-number="${n}"] .ao-hl[data-annotation="${id}"]`);
  await expect(loc).toHaveCount(1);
  const span = page.locator(`[data-page-number="${n}"] .ao-reader-text-layer span`, { hasText: words }).first();
  await expect(span).toHaveCount(1);
  // Wait for both to have their final place (the layout settles after a zoom).
  let last = "";
  let r: Placed | undefined;
  await expect
    .poll(async () => {
      r = await page.evaluate(
        ({ id, n, words }) => {
          const box = (e: Element) => {
            const b = e.getBoundingClientRect();
            return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
          };
          const mark = document.querySelector(`[data-page-number="${n}"] .ao-hl[data-annotation="${id}"]`)!;
          const span = [...document.querySelectorAll(`[data-page-number="${n}"] .ao-reader-text-layer span`)].find((s) => s.textContent === words)!;
          const w = box(span);
          return { mark: box(mark), words: w, across: w.right - w.left >= w.bottom - w.top };
        },
        { id, n, words },
      );
      const now = JSON.stringify(r);
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return r!;
}

/** The highlight lies on its words' span: along the line within `along` px at each end, across it centred and as high, within ACROSS_TOLERANCE. */
function expectOnItsWords(p: Placed, along: number, where: string): void {
  const [m, w] = [p.mark, p.words];
  const detail = `${where}: highlight ${JSON.stringify(m)} words ${JSON.stringify(w)}`;
  const [mA0, mA1, wA0, wA1] = p.across ? [m.left, m.right, w.left, w.right] : [m.top, m.bottom, w.top, w.bottom];
  const [mX0, mX1, wX0, wX1] = p.across ? [m.top, m.bottom, w.top, w.bottom] : [m.left, m.right, w.left, w.right];
  const measured = `${where}: ends ${Math.abs(mA0 - wA0).toFixed(2)} and ${Math.abs(mA1 - wA1).toFixed(2)} px off (allowed ${along}); height ${(mX1 - mX0).toFixed(1)} px against the span's ${(wX1 - wX0).toFixed(1)}`;
  test.info().annotations.push({ type: "placed", description: measured });
  console.log(`[${test.info().project.name}] ${measured}`);
  expect(Math.abs(mA0 - wA0), detail).toBeLessThanOrEqual(along);
  expect(Math.abs(mA1 - wA1), detail).toBeLessThanOrEqual(along);
  const middle = (mX0 + mX1) / 2;
  expect(middle, detail).toBeGreaterThanOrEqual(wX0);
  expect(middle, detail).toBeLessThanOrEqual(wX1);
  expect(Math.abs(mX1 - mX0 - (wX1 - wX0)), detail).toBeLessThanOrEqual(ACROSS_TOLERANCE * (wX1 - wX0));
}

/**
 * Okafor's article as the Zotero fixture's highlight expects it: on page 1 (A4), the words
 * "informal markets" in 16.5-point Helvetica, stretched (Tz) to fill exactly x 100.5–300, their
 * glyphs from y 200 to 215.25 (Helvetica's ascent 0.718 and descent 0.207 of the size), and a title
 * line above.
 */
async function okaforPdf(): Promise<Buffer> {
  const { PDFDocument, PDFName, StandardFonts } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as {
    PDFDocument: { create(o: object): Promise<PdfDoc> };
    PDFName: { of(n: string): unknown };
    StandardFonts: { Helvetica: string };
  };
  interface PdfDoc {
    context: { flateStream(s: string, d: object): unknown; register(o: unknown): unknown; obj(o: object): unknown };
    embedFont(f: string): Promise<{ ref: unknown }>;
    addPage(s: [number, number]): { drawText(t: string, o: { x: number; y: number; size: number; font: unknown }): void; node: { Resources(): { lookup(k: unknown): { set(k: unknown, v: unknown): void } | undefined; set(k: unknown, v: unknown): void }; addContentStream(r: unknown): void } };
    save(o: object): Promise<Uint8Array>;
  }
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Feeding the City: Informal Markets in Lagos", { x: 72, y: 760, size: 14, font: font as unknown });
  const size = 16.5;
  // Helvetica advances of "informal markets": 7,390 thousandths of an em.
  const scaling = (199.5 / (7.39 * size)) * 100;
  const fonts = page.node.Resources().lookup(PDFName.of("Font"));
  fonts!.set(PDFName.of("FH"), font.ref);
  page.node.addContentStream(doc.context.register(doc.context.flateStream(`BT /FH ${size} Tf ${scaling.toFixed(4)} Tz 100.5 ${(200 + 0.207 * size).toFixed(4)} Td (informal markets) Tj ET`, {})));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

interface Listed {
  annotations: Array<{ id: string; kind: string; quote?: string; imported: boolean; colorName: string; pdfAnchors: Array<{ assetId: string; page: number; rects: Array<{ x: number; y: number; w: number; h: number }> }> }>;
}

/** The Zotero fixture's data folder imported through the service, Okafor's article with its highlight and note. */
async function importOkafor(app: AppHarness, page: Page, project: string): Promise<{ projectId: string; sid: string; aid: string; listed: Listed }> {
  const dataDir = join(app.root, "sources", "Zotero");
  const linkedDir = join(app.root, "sources", "linked");
  buildZoteroFixture(dataDir, { pdf: await okaforPdf(), linkedPdf: await buildPdf({ extra: "adebayo linked" }), linkedDir });
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project });
  await test.step("the Zotero data folder is imported through the service, its highlight with it", async () => {
    const started = await app.api<{ batchId: string }>("POST", `/projects/${projectId}/import`, {
      adapter: { kind: "zotero-local", dataDir },
      options: { ocr: false, approveOutside: { folders: [linkedDir] } },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect
      .poll(async () => (await app.api<{ batches: Array<{ batchId: string; state: string }> }>("GET", `/projects/${projectId}/imports`)).body.batches.find((b) => b.batchId === started.body.batchId)?.state, { timeout: 60_000 })
      .toBe("finished");
  });
  const sources = await app.api<{ items: Array<{ id: string; title: string }> }>("GET", `/projects/${projectId}/sources?limit=500`);
  const sid = sources.body.items.find((i) => i.title === "Feeding the City: Informal Markets in Lagos")!.id;
  const aid = await pdfAsset(app, projectId, sid);
  const listed = await app.api<Listed>("GET", `/projects/${projectId}/sources/${sid}/annotations`);
  return { projectId, sid, aid, listed: listed.body };
}

test("an imported Zotero highlight sits on its words at two zooms", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const { projectId, sid, aid, listed } = await importOkafor(app, page, "Market studies");
  const highlight = listed.annotations.find((a) => a.kind === "highlight")!;
  // As the importer stored it: page index 0 is page 1; [x1, y1, x2, y2] became {x, y, w, h}, y the lower edge.
  expect(highlight).toMatchObject({ quote: "informal markets", imported: true, colorName: "yellow" });
  expect(highlight.pdfAnchors).toEqual([expect.objectContaining({ assetId: aid, page: 1, rects: [{ x: 100.5, y: 200, w: 199.5, h: 15.25 }] })]);

  await readFromLibrary(page, app, projectId, sid);
  const mark = page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${highlight.id}"]`);
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveClass(/ao-hl--fill/);
  await expect(mark).toHaveClass(/ao-hl--yellow/);
  // The overlay says nothing to assistive technology; the words are not said to have changed.
  await expect(page.locator('[data-page-number="1"] .ao-hl-layer')).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText(CHANGED)).toHaveCount(0);

  await test.step("at 100%", async () => {
    await expect(zoomValue(page)).toHaveText("100%");
    expectOnItsWords(await placed(page, 1, highlight.id, "informal markets"), ALONG_TOLERANCE_PX, "100%");
  });
  await test.step("at 200%", async () => {
    await zoomTo(page, "200%");
    expectOnItsWords(await placed(page, 1, highlight.id, "informal markets"), ALONG_TOLERANCE_PX * 2, "200%");
  });
  // Its yellow is under the words on the canvas too: a pixel of the page there is tinted, not paper white.
  await test.step("the highlight is seen: drawn yellow over the words, the words still dark", async () => {
    const tint = await mark.evaluate((m) => getComputedStyle(m).backgroundColor);
    expect(tint).not.toMatch(/^rgba?\(0, 0, 0, 0\)$|transparent/);
    expect(await mark.evaluate((m) => getComputedStyle(m).mixBlendMode)).toBe("multiply");
  });
  expect(errors).toEqual([]);
});

test("a highlight on a rotated page with an offset crop box sits on its words, at 100%, at 200% and turned", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "rotated-crop.pdf", await buildRotatedCropPdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Ferries" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // "The ferry timetable was rewritten every spring.": 12-point Helvetica from x 100 on baseline 800,
  // 246.072 points long (pdf.js's own measure), its glyphs from 0.207 of the size below the baseline to 0.718 above.
  const quote = "The ferry timetable was rewritten every spring.";
  const made = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, {
    kind: "highlight",
    assetId: aid,
    anchors: [{ page: 1, rects: [{ x: 100, y: 800 - 0.207 * 12, w: 246.072, h: 0.925 * 12 }] }],
    quote,
    colorName: "green",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = made.body.id;
  await readFromLibrary(page, app, projectId, sid);
  await expect(page.locator(`.ao-hl[data-annotation="${id}"]`)).toHaveClass(/ao-hl--green/);

  await test.step("at 100%: the page turned by its own /Rotate, the line running down the screen", async () => {
    const p = await placed(page, 1, id, quote);
    expect(p.across).toBe(false);
    expectOnItsWords(p, ALONG_TOLERANCE_PX, "100%, /Rotate 90");
  });
  await test.step("turned a further quarter by the view: the line runs across, upside down", async () => {
    await toolbar(page).getByRole("button", { name: "Rotate view" }).click();
    const p = await placed(page, 1, id, quote);
    expect(p.across).toBe(true);
    expectOnItsWords(p, ALONG_TOLERANCE_PX, "100%, /Rotate 90 + view 90");
  });
  await test.step("at 200%", async () => {
    await zoomTo(page, "200%");
    expectOnItsWords(await placed(page, 1, id, quote), ALONG_TOLERANCE_PX * 2, "200%, /Rotate 90 + view 90");
  });
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a highlight whose text no longer matches says so", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Changed text" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // Page 1 says "This is the text of page 1, …" in 11-point Helvetica from x 50 on baseline 760.
  // "This is the text" is 70.917 points long.
  const line = { x: 50, y: 760 - 0.207 * 11, w: 70.917, h: 0.925 * 11 };
  const create = async (quote: string, pageNo = 1) => {
    const r = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, { kind: "highlight", assetId: aid, anchors: [{ page: pageNo, rects: [line] }], quote, colorName: "blue" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id;
  };
  // As if the file had been replaced since: the words under the rectangle are not the quote.
  const same = await create("This is the text");
  const changed = await create("Words this page never held");
  const far = await create("A page this file lacks", 7);
  await readFromLibrary(page, app, projectId, sid);

  // R9 (A11): each entry of the list says it; the temporary region is gone.
  const list = annotationList(page);
  await expect(list.locator(`[data-entry="${changed}"]`)).toContainText(CHANGED);
  await expect(list.locator(`[data-entry="${far}"]`)).toContainText("This highlight is on page 7, which this file does not have.");
  await expect(list.locator(`[data-entry="${far}"]`).getByRole("button", { name: /^Go to/ })).toBeDisabled();
  await expect(list.locator(`[data-entry="${same}"]`)).not.toContainText(CHANGED);
  await expect(list.getByText(CHANGED)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Highlights to check" })).toHaveCount(0);
  await expect(page.locator(`.ao-hl[data-annotation="${changed}"]`)).toHaveClass(/ao-hl--changed/);
  expect(await page.locator(`.ao-hl[data-annotation="${changed}"]`).evaluate((m) => getComputedStyle(m).outlineStyle)).toBe("dashed");
  await expect(page.locator(`.ao-hl[data-annotation="${same}"]`)).not.toHaveClass(/ao-hl--changed/);
  // The one on a page the file does not have is drawn nowhere.
  await expect(page.locator(`.ao-hl[data-annotation="${far}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a highlight on a scanned page with no text is drawn, and nothing is said of its text", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "scan.pdf", await buildScanPdf(2));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Scans" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // A highlight made where the scan's words were recognised (Zotero, say): the page here has no text.
  const made = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, {
    kind: "highlight",
    assetId: aid,
    anchors: [{ page: 1, rects: [{ x: 100, y: 600, w: 200, h: 14 }] }],
    quote: "Words a scan cannot be asked about",
    colorName: "orange",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await readFromLibrary(page, app, projectId, sid);
  const page1 = page.locator('[data-page-number="1"]');
  await expect(page1).toContainText("This page has no text to select. It is probably a scanned image; you can still add a note to it.");
  const mark = page1.locator(`.ao-hl[data-annotation="${made.body.id}"]`);
  await expect(mark).toHaveClass(/ao-hl--orange/);
  // No verdict: drawn plain, and no notice (the page's text, none, has been handed on by now).
  await page.waitForTimeout(300);
  await expect(mark).not.toHaveClass(/ao-hl--changed/);
  await expect(annotationList(page).locator(`[data-entry="${made.body.id}"]`)).toContainText("Orange");
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an imported highlight is recoloured, noted and kept after a reload, by keyboard", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Okafor's article: the highlight "informal markets" (note "key claim") on page 1, and a note
  // "check the numbers" on page 3, which this one-page file does not have.
  const { projectId, sid, listed } = await importOkafor(app, page, "Annotated by keyboard");
  const highlight = listed.annotations.find((a) => a.kind === "highlight")!;
  const note = listed.annotations.find((a) => a.kind === "note")!;
  expect(note).toBeTruthy();
  await readFromLibrary(page, app, projectId, sid);
  const list = annotationList(page);
  await expect(list.getByRole("heading", { level: 2 })).toHaveText("Annotations (2)");
  const hlEntry = list.locator(`[data-entry="${highlight.id}"]`);
  const noteEntry = list.locator(`[data-entry="${note.id}"]`);
  await expect(hlEntry).toContainText("Imported from Zotero");
  await expect(hlEntry).toContainText("Yellow");
  await expect(noteEntry).toContainText("This note is on page 3, which this file does not have.");
  const live = list.getByRole("status");

  await test.step("recoloured to Green from the colour menu", async () => {
    await tabTo(page, hlEntry);
    await tabTo(page, hlEntry.getByRole("button", { name: /^Colour of yellow highlight on page 1/ }));
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: /^Colour of yellow highlight/ });
    await expect(menu.getByRole("menuitemradio", { name: "Yellow" })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: "Yellow" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "Green" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(live).toHaveText("Highlight recoloured: Green.");
    await expect(menu).toHaveCount(0);
    await expect(hlEntry.getByRole("button", { name: /^Colour of green highlight on page 1/ })).toBeFocused();
    await expect(hlEntry).toContainText("Green");
    await expect(hlEntry).toContainText("Imported from Zotero");
    await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${highlight.id}"]`)).toHaveClass(/ao-hl--green/);
  });

  await test.step("its note edited and saved with Ctrl+Enter", async () => {
    await page.keyboard.press("Shift+Tab");
    await expect(hlEntry.getByRole("button", { name: /^Edit note of green highlight/ })).toBeFocused();
    await page.keyboard.press("Enter");
    const area = hlEntry.getByRole("textbox", { name: "Note" });
    await expect(area).toBeFocused();
    await expect(area).toHaveValue("key claim");
    await page.keyboard.press("End");
    await page.keyboard.type(", checked twice");
    await page.keyboard.press("Control+Enter");
    await expect(live).toHaveText("Note saved.");
    await expect(area).toHaveCount(0);
    await expect(hlEntry).toContainText("key claim, checked twice");
    await expect(hlEntry.getByRole("button", { name: /^Edit note of green highlight/ })).toBeFocused();
  });

  await test.step("the other one deleted, after its question", async () => {
    // The entries in the list's order (the source's other annotations, if any, come in the further groups).
    const ids = await list.locator("[data-entry]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.entry!));
    const at = ids.indexOf(note.id);
    const nextId = ids[at + 1] ?? ids[at - 1]!;
    await page.keyboard.press("ArrowDown");
    await expect(noteEntry).toBeFocused();
    await tabTo(page, noteEntry.getByRole("button", { name: /^Delete / }));
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Delete this note?" });
    await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(live).toHaveText("Note deleted.");
    await expect(noteEntry).toHaveCount(0);
    // The focus goes to the next entry (the one before it when it was the last).
    await expect(list.locator(`[data-entry="${nextId}"]`)).toBeFocused();
    await expect(list.getByRole("heading", { level: 2 })).toHaveText("Annotations (1)");
  });

  await test.step("after a reload, everything is as it was left", async () => {
    await page.reload();
    await expect(list.getByRole("heading", { level: 2 })).toHaveText("Annotations (1)");
    await expect(hlEntry).toContainText("Green");
    await expect(hlEntry).toContainText("key claim, checked twice");
    await expect(hlEntry).toContainText("Imported from Zotero");
    await expect(noteEntry).toHaveCount(0);
    await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${highlight.id}"]`)).toHaveClass(/ao-hl--green/);
    const after = await app.api<{ annotations: Array<{ id: string; colorName: string; body?: string; imported: boolean }> }>("GET", `/projects/${projectId}/sources/${sid}/annotations`);
    expect(after.body.annotations.find((a) => a.id === note.id)).toBeUndefined();
    const kept = after.body.annotations.find((a) => a.id === highlight.id)!;
    expect([kept.colorName, kept.body, kept.imported]).toEqual(["green", "key claim, checked twice", true]);
    expect(after.body.annotations).toHaveLength(listed.annotations.length - 1);
  });
  expect(errors).toEqual([]);
});

test("Go to from the list lands on the page with the highlight outlined", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Going to" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // Page 3 says "This is the text of page 3, …" in 11-point Helvetica from x 50 on baseline 760.
  const made = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, {
    kind: "highlight",
    assetId: aid,
    anchors: [{ page: 3, rects: [{ x: 50, y: 760 - 0.207 * 11, w: 70.917, h: 0.925 * 11 }] }],
    quote: "This is the text",
    colorName: "purple",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await readFromLibrary(page, app, projectId, sid);
  const entry = annotationList(page).locator(`[data-entry="${made.body.id}"]`);
  await expect(entry).toContainText("Page 3");
  await tabTo(page, entry);
  await page.keyboard.press("Enter");
  const page3 = page.locator('[data-page-number="3"]');
  await expect(page3).toBeFocused();
  await expect(page3).toHaveAttribute("aria-label", "Page 3 of 3");
  await expect(toolbar(page).getByRole("spinbutton", { name: "Page" })).toHaveValue("3");
  const mark = page3.locator(`.ao-hl[data-annotation="${made.body.id}"]`);
  await expect(mark).toHaveClass(/ao-hl--selected/);
  await expect(mark).toBeInViewport();
  await expect(entry).toHaveAttribute("aria-current", "true");
  // Its ring is drawn: the chosen one is seen on the page.
  expect(await mark.evaluate((m) => getComputedStyle(m).boxShadow)).not.toBe("none");
  // By the entry's button too.
  await tabTo(page, entry.getByRole("button", { name: /^Go to purple highlight on page 3/ }));
  await page.keyboard.press("Enter");
  await expect(page3).toBeFocused();
  expect(errors).toEqual([]);
});

/** "This is the text" on page 1 of the three-page fixture (11-point Helvetica from x 50 on baseline 760). */
const LINE_ONE = { x: 50, y: 760 - 0.207 * 11, w: 70.917, h: 0.925 * 11 };

test("a note of only spaces is refused by the service, its sentence shown and nothing changed", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Refused" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  const made = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, { kind: "highlight", assetId: aid, anchors: [{ page: 1, rects: [LINE_ONE] }], quote: "This is the text", body: "first note", colorName: "blue" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await readFromLibrary(page, app, projectId, sid);
  const entry = annotationList(page).locator(`[data-entry="${made.body.id}"]`);
  await tabTo(page, entry);
  await tabTo(page, entry.getByRole("button", { name: /^Edit note of/ }));
  await page.keyboard.press("Enter");
  const area = entry.getByRole("textbox", { name: "Note" });
  await expect(area).toBeFocused();
  await area.fill("   ");
  await page.keyboard.press("Control+Enter");
  await expect(entry.getByRole("alert")).toHaveText("A note cannot be only spaces.");
  // Nothing changed: the editor keeps what was typed, the service keeps the note.
  await expect(area).toHaveValue("   ");
  await expect(area).toBeFocused();
  const listed = await app.api<{ annotations: Array<{ id: string; body?: string }> }>("GET", `/projects/${projectId}/sources/${sid}/annotations`);
  expect(listed.body.annotations.find((a) => a.id === made.body.id)?.body).toBe("first note");
  // Abandoning the changed text asks first; once discarded, the note is as it was.
  await page.keyboard.press("Escape");
  const dialog = page.getByRole("dialog", { name: "Discard this note?" });
  await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toContainText("first note");
  await expect(entry.getByRole("button", { name: /^Edit note of/ })).toBeFocused();
  expect(errors).toEqual([]);
});

test("past the five-hundredth entry nothing is cut off: a long note, an entry being edited, larger text", async ({ page, app }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Many highlights" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  const COUNT = 520;
  const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note about the market rules.`).join("\n");
  const ids: string[] = [];
  await test.step(`${COUNT} highlights made through the service, in a known order`, async () => {
    for (let i = 0; i < COUNT; i++) {
      const body = i === 505 ? LONG : i % 2 === 0 ? `A short note, number ${i}.` : undefined;
      const r = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, {
        kind: "highlight",
        assetId: aid,
        anchors: [{ page: 1, rects: [LINE_ONE], sortIndex: `00000|${String(i).padStart(6, "0")}|00100` }],
        quote: "This is the text",
        ...(body !== undefined ? { body } : {}),
        colorName: "green",
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.id);
    }
  });
  await readFromLibrary(page, app, projectId, sid);
  const list = annotationList(page);
  await expect(list.getByRole("heading", { level: 2 })).toHaveText(`Annotations (${COUNT})`);
  // Windowed: far fewer entries in the page than in the list.
  expect(await list.locator("[data-entry]").count()).toBeLessThan(120);

  // By keyboard to the end of the list, then up to entry 508, whose note is opened for editing.
  await tabTo(page, list.locator("[data-entry]").first());
  await page.keyboard.press("End");
  await expect(list.locator(`[data-entry="${ids[COUNT - 1]}"]`)).toBeFocused();
  await expect(list.locator(`[data-entry="${ids[COUNT - 1]}"]`)).toHaveAttribute("aria-posinset", String(COUNT));
  for (let i = COUNT - 1; i > 508; i--) await page.keyboard.press("ArrowUp");
  const editing = list.locator(`[data-entry="${ids[508]}"]`);
  await expect(editing).toBeFocused();
  await tabTo(page, editing.getByRole("button", { name: /^(Add|Edit) note/ }));
  await page.keyboard.press("Enter");
  await expect(editing.getByRole("textbox", { name: "Note" })).toBeFocused();

  /**
   * For those of entries 500 to 515 in the page (`must` among them): every button inside its entry's
   * box and seen at its centre once scrolled into the list's view, no content beyond its entry's box,
   * and no entry over the next.
   */
  const problems = (must: string) =>
    page.evaluate(([check, must]: [string[], string]) => {
      const out: string[] = [];
      if (!document.querySelector(`[data-entry="${must}"]`)) out.push(`${must}: not in the page`);
      const scroller = document.querySelector<HTMLElement>(".ao-ann-scroll")!;
      let lastBottom = -Infinity;
      for (const id of check) {
        const li = [...document.querySelectorAll<HTMLElement>("[data-entry]")].find((e) => e.dataset.entry === id);
        if (!li) continue;
        const top = li.offsetTop;
        if (top < lastBottom - 0.5) out.push(`${id}: starts at ${top}, over the one before (ends ${lastBottom})`);
        lastBottom = top + li.offsetHeight;
        if (li.scrollHeight > li.clientHeight + 1) out.push(`${id}: content ${li.scrollHeight} px in a box of ${li.clientHeight}`);
        if (id !== must) continue;
        for (const b of li.querySelectorAll<HTMLElement>("button")) {
          b.scrollIntoView({ block: "center" });
          const r = b.getBoundingClientRect();
          const box = li.getBoundingClientRect();
          const view = scroller.getBoundingClientRect();
          if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${id}: ${b.textContent} outside its entry`);
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          if (!hit || !(hit === b || b.contains(hit))) out.push(`${id}: ${b.textContent} not seen at its centre (${hit?.className ?? "nothing"}) view ${Math.round(view.top)}-${Math.round(view.bottom)} button ${Math.round(r.top)}-${Math.round(r.bottom)}`);
        }
      }
      return out;
    }, [ids.slice(500, 516), must] as [string[], string]);
  /** Scrolls the list a little at a time, up or down, until entry number `at` (0-based) is in the page. */
  const bringIn = async (at: number) => {
    await expect
      .poll(() =>
        page.evaluate(
          ([id, at]) => {
            if (document.querySelector(`[data-entry="${id}"]`)) return true;
            const shown = [...document.querySelectorAll<HTMLElement>("[data-entry]")].map((e) => Number(e.getAttribute("aria-posinset")) - 1);
            document.querySelector<HTMLElement>(".ao-ann-scroll")!.scrollTop += at < Math.min(...shown) ? -150 : 150;
            return false;
          },
          [ids[at]!, at] as [string, number],
        ),
      )
      .toBe(true);
  };
  /** The checks on entry number `at`, brought into the page first each time. */
  const checked = (at: number) => async () => {
    await bringIn(at);
    return problems(ids[at]!);
  };

  await test.step("at the default text size: the entry being edited, the long note, the one after it", async () => {
    for (const at of [508, 505, 506]) await expect.poll(checked(at), { timeout: 20_000 }).toEqual([]);
  });
  await test.step("at a larger text size", async () => {
    await page.evaluate(() => (document.documentElement.style.fontSize = "150%"));
    for (const at of [505, 508]) await expect.poll(checked(at), { timeout: 20_000 }).toEqual([]);
  });
  await test.step("in the narrowest panel the layout allows (15rem), at the larger text size", async () => {
    // Set through the style object (allowed by the page's policy, unlike a style element).
    await page.evaluate(() => (document.querySelector<HTMLElement>(".ao-reader-body")!.style.gridTemplateColumns = "minmax(0, 1fr) 15rem"));
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector<HTMLElement>(".ao-ann")!.getBoundingClientRect().width / parseFloat(getComputedStyle(document.documentElement).fontSize)))).toBe(15);
    for (const at of [505, 508, 506]) await expect.poll(checked(at), { timeout: 20_000 }).toEqual([]);
  });
  // The long note is there whole.
  await expect(list.locator(`[data-entry="${ids[505]}"]`)).toContainText("Line 60 of a long note about the market rules.");
  // The editor kept its place and focus throughout.
  await expect(editing.getByRole("textbox", { name: "Note" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

// ---- Task R10: making highlights with the mouse --------------------------------------------------------
/*
 * Real mouse selections: the button pressed just before a character and let go just after another,
 * found in pdf.js's text layer as the browser lays it out (a Range over the character), whichever way
 * the page is turned. What is made is read back from the service and checked against the fixture's
 * own text: the lines the rectangles lie on, the gutter, the quote, the anchors a page; and that R8's
 * check never calls a highlight just made "changed", at once and after a reload at another zoom.
 */

interface Point {
  x: number;
  y: number;
}

/** Page `n`'s text-layer span holding exactly `words`, once laid out. */
async function spanOf(page: Page, n: number, words: string) {
  const span = page.locator(`[data-page-number="${n}"] .ao-reader-text-layer span`).filter({ hasText: words }).first();
  await expect(span).toHaveText(words);
  return span;
}

/** Characters `from` to `to` of page `n`'s span `words` (the whole span when not said). */
interface Target {
  n: number;
  words: string;
  from?: number;
  to?: number;
}

/**
 * Brings `targets` (together) to the middle of the pages' view, and the view into the window, so
 * that a drag never starts or ends outside the view or at its edge (where the browser scrolls under
 * the pointer). The pages' view is narrow (the list stands beside it), so a target is a few words of
 * a line, not necessarily the whole line.
 */
async function centreOn(page: Page, ...targets: Target[]): Promise<void> {
  for (const t of targets) await spanOf(page, t.n, t.words);
  const place = () =>
    page.evaluate((targets) => {
      const scroller = document.querySelector<HTMLElement>(".ao-reader-scroll")!;
      scroller.scrollIntoView({ block: "center", inline: "nearest" });
      const rs = targets.map((t) => {
        const span = [...document.querySelectorAll(`[data-page-number="${t.n}"] .ao-reader-text-layer span`)].find((x) => x.textContent === t.words)!;
        const r = document.createRange();
        r.setStart(span.firstChild!, t.from ?? 0);
        r.setEnd(span.firstChild!, t.to ?? t.words.length);
        return r.getBoundingClientRect();
      });
      const [l, top, r, b] = [Math.min(...rs.map((x) => x.left)), Math.min(...rs.map((x) => x.top)), Math.max(...rs.map((x) => x.right)), Math.max(...rs.map((x) => x.bottom))];
      const v = scroller.getBoundingClientRect();
      scroller.scrollTop += (top + b) / 2 - (v.top + v.bottom) / 2;
      scroller.scrollLeft += (l + r) / 2 - (v.left + v.right) / 2;
      return [l, top, r, b].map(Math.round).join(",");
    }, targets);
  // Placed again until it stays where it is (pages drawn meanwhile may move the layout).
  let last = "";
  await expect
    .poll(async () => {
      const now = await place();
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
}

/** The text of the text-layer span under a point (the highlights take no pointer events), or what is there instead. */
async function textAt(page: Page, p: Point): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    return e?.closest(".ao-reader-text-layer") ? (e.textContent ?? "") : `not a page's text: ${e?.tagName ?? "nothing"}.${e?.className ?? ""}`;
  }, p);
}

/**
 * The point just inside character `i` of page `n`'s span `words`, at its leading edge ("before") or its
 * trailing edge ("after"), along the line whichever way the page is turned: where a press puts the
 * caret before or after that character.
 */
async function charPoint(page: Page, n: number, words: string, i: number, edge: "before" | "after"): Promise<Point> {
  return page.evaluate(
    ({ n, words, i, edge }) => {
      const span = [...document.querySelectorAll(`[data-page-number="${n}"] .ao-reader-text-layer span`)].find((s) => s.textContent === words)!;
      const t = span.firstChild as Text;
      const centre = (k: number) => {
        const r = document.createRange();
        r.setStart(t, k);
        r.setEnd(t, k + 1);
        const b = r.getBoundingClientRect();
        return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
      };
      const c = centre(i);
      const last = i + 1 >= t.data.length;
      const o = centre(last ? i - 1 : i + 1);
      // Along the line, towards the end of the text, one character's advance.
      const [dx, dy] = last ? [c.x - o.x, c.y - o.y] : [o.x - c.x, o.y - c.y];
      const k = edge === "before" ? -0.4 : 0.4;
      return { x: c.x + dx * k, y: c.y + dy * k };
    },
    { n, words, i, edge },
  );
}

/**
 * A real mouse selection: the button pressed just before character `a.i` of `a`, dragged, and let go
 * just after character `b.i` of `b`; both points checked first to be on those words (in the view).
 */
async function dragSelect(page: Page, a: { n: number; words: string; i: number }, b: { n: number; words: string; i: number }): Promise<void> {
  const from = await charPoint(page, a.n, a.words, a.i, "before");
  const to = await charPoint(page, b.n, b.words, b.i, "after");
  expect(await textAt(page, from)).toBe(a.words);
  expect(await textAt(page, to)).toBe(b.words);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const colourBar = (page: Page) => page.getByRole("toolbar", { name: "Highlight the selected text" });
const said = (page: Page) => page.locator(".ao-ann-live");

interface Made {
  id: string;
  quote?: string;
  colorName: string;
  pdfAnchors: Array<{ page: number; rects: Array<{ x: number; y: number; w: number; h: number }>; sortIndex: string; sortIndexDerived: boolean }>;
}
async function listed(app: AppHarness, projectId: string, sid: string): Promise<Made[]> {
  const r = await app.api<{ annotations: Made[] }>("GET", `/projects/${projectId}/sources/${sid}/annotations`);
  expect(r.status).toBe(200);
  return r.body.annotations;
}

test("a selection across two columns highlights only the selected lines", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "two-columns.pdf", await buildTwoColumnPdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Two columns" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  // Column one runs x 50–280, column two x 315–545; 9-point lines every 16 points from baseline 740.
  const foot = "At the foot of this column the sentence continues";
  const head = "into the head of the second column, where the story";
  // At 50% both columns' words are in the pages' view together (the head of column two stands 80
  // points above the foot of column one).
  const zoomOut = toolbar(page).getByRole("button", { name: "Zoom out" });
  await zoomOut.click();
  await zoomOut.click();
  await expect(zoomValue(page)).toHaveText("50%");
  await centreOn(page, { n: 1, words: foot }, { n: 1, words: head, to: 27 });
  await dragSelect(page, { n: 1, words: foot, i: 0 }, { n: 1, words: head, i: 26 });
  await expect(colourBar(page)).toBeVisible();
  await colourBar(page).getByRole("button", { name: "Highlight in Green" }).click();
  await expect(said(page)).toHaveText("Highlight added: Green, page 1.");
  await expect(colourBar(page)).toHaveCount(0);

  const [made, ...more] = await listed(app, projectId, sid);
  expect(more).toEqual([]);
  expect(made!.quote).toBe("At the foot of this column the sentence continues into the head of the second");
  expect(made!.colorName).toBe("green");
  expect(made!.pdfAnchors.map((a) => a.page)).toEqual([1]);
  expect(made!.pdfAnchors[0]!.sortIndexDerived).toBe(false);
  const rects = made!.pdfAnchors[0]!.rects;
  // One rectangle a line, in reading order: the foot of column one, then the head of column two; none over the gutter.
  expect(rects, JSON.stringify(rects)).toHaveLength(2);
  const [one, two] = rects as [(typeof rects)[number], (typeof rects)[number]];
  expect(one.y < 660 && one.y + one.h > 660 && one.h < 16, JSON.stringify(one)).toBe(true);
  expect(one.x >= 49 && one.x + one.w <= 281, JSON.stringify(one)).toBe(true);
  expect(two.y < 740 && two.y + two.h > 740 && two.h < 16, JSON.stringify(two)).toBe(true);
  expect(two.x >= 314 && two.x + two.w <= 546, JSON.stringify(two)).toBe(true);

  // On the page and in the list at once, never "changed"; after a reload at another zoom neither.
  const entry = annotationList(page).locator(`[data-entry="${made!.id}"]`);
  await expect(entry).toContainText("Highlight, Green, Page 1");
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${made!.id}"]`)).toHaveCount(2);
  await expect(page.locator(".ao-hl--draft")).toHaveCount(0);
  await expect(entry).not.toContainText(CHANGED);
  await page.reload();
  await zoomTo(page, "200%");
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${made!.id}"]`)).toHaveCount(2);
  await expect(page.locator('[data-page-number="1"] .ao-reader-text-layer span').first()).toBeAttached();
  await expect(annotationList(page).locator(`[data-entry="${made!.id}"]`)).toBeVisible();
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  await expect(page.locator(".ao-hl--changed")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a selection across a page break makes one highlight on two pages", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Tall enough to show the foot of page 1 and the head of page 2 together at 50%.
  await page.setViewportSize({ width: 1280, height: 1100 });
  const file = sourceFile(app, "two-columns.pdf", await buildTwoColumnPdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Page break" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const zoomOut = toolbar(page).getByRole("button", { name: "Zoom out" });
  await zoomOut.click();
  await zoomOut.click();
  await expect(zoomValue(page)).toHaveText("50%");
  const last = "This is the last line of the second column.";
  const title = "Rivers and Markets, page 2";
  await spanOf(page, 1, last);
  // The last line of page 1 near the top of the view, so that page 2's head is in it too.
  await page.evaluate((words) => {
    const scroller = document.querySelector<HTMLElement>(".ao-reader-scroll")!;
    const span = [...document.querySelectorAll('[data-page-number="1"] .ao-reader-text-layer span')].find((s) => s.textContent === words)!;
    scroller.scrollTop += span.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 30;
  }, last);
  const head = page.locator('[data-page-number="2"] .ao-reader-text-layer span').filter({ hasText: title }).first();
  await expect(head).toHaveText(title);
  await expect(head).toBeInViewport();
  await dragSelect(page, { n: 1, words: last, i: 12 }, { n: 2, words: title, i: 17 });
  await expect(colourBar(page)).toBeVisible();
  // "Highlight": the last colour used, Yellow at first.
  await expect(colourBar(page)).toContainText("in Yellow");
  await colourBar(page).getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(said(page)).toHaveText("Highlight added: Yellow, pages 1–2.");

  const all = await listed(app, projectId, sid);
  expect(all).toHaveLength(1);
  const made = all[0]!;
  expect(made.pdfAnchors.map((a) => a.page)).toEqual([1, 2]);
  expect(made.quote).toBe("last line of the second column. Rivers and Markets");
  expect(made.pdfAnchors[0]!.sortIndex.startsWith("00000|")).toBe(true);
  expect(made.pdfAnchors[1]!.sortIndex.startsWith("00001|000000|")).toBe(true);
  const entry = annotationList(page).locator(`[data-entry="${made.id}"]`);
  await expect(entry).toContainText("Pages 1–2");
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${made.id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-page-number="2"] .ao-hl[data-annotation="${made.id}"]`)).toHaveCount(1);
  await expect(entry).not.toContainText(CHANGED);
  expect(errors).toEqual([]);
});

test("two overlapping highlights are both offered where they overlap", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Overlaps" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const line = "This is the text of page 1, written for the reader's tests.";
  await centreOn(page, { n: 1, words: line, to: 26 });
  // "This is the text of" in Yellow, then "text of page 1" in Blue: "text of" lies under both.
  await dragSelect(page, { n: 1, words: line, i: 0 }, { n: 1, words: line, i: 18 });
  // The toolbar by keyboard: the page took the focus with the press; Tab reaches the toolbar, the
  // arrows move in it, Enter chooses, and the focus goes back to the page.
  await expect(page.locator('[data-page-number="1"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(colourBar(page).getByRole("button", { name: "Highlight", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(colourBar(page).getByRole("button", { name: "Highlight in Yellow" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(said(page)).toHaveText("Highlight added: Yellow, page 1.");
  await expect(colourBar(page)).toHaveCount(0);
  await expect(page.locator('[data-page-number="1"]')).toBeFocused();
  await dragSelect(page, { n: 1, words: line, i: 12 }, { n: 1, words: line, i: 25 });
  await colourBar(page).getByRole("button", { name: "Highlight in Blue" }).click();
  await expect(said(page)).toHaveText("Highlight added: Blue, page 1.");
  const all = await listed(app, projectId, sid);
  expect(all.map((a) => [a.colorName, a.quote])).toEqual([
    ["yellow", "This is the text of"],
    ["blue", "text of page 1"],
  ]);
  const [yellow, blue] = all as [Made, Made];

  const pageOne = page.locator('[data-page-number="1"]');
  const onBoth = await charPoint(page, 1, line, 17, "after");
  await test.step("a click where both lie offers both, by colour and opening words; Escape gives the focus back", async () => {
    await page.mouse.click(onBoth.x, onBoth.y);
    const menu = page.getByRole("menu", { name: "2 highlights here" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Blue: text of page 1", "Yellow: This is the text of"]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(pageOne).toBeFocused();
  });
  await test.step("choosing one selects it on the page and in the list", async () => {
    await page.mouse.click(onBoth.x, onBoth.y);
    const menu = page.getByRole("menu", { name: "2 highlights here" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(`.ao-hl[data-annotation="${yellow.id}"]`).first()).toHaveClass(/ao-hl--selected/);
    await expect(annotationList(page).locator(`[data-entry="${yellow.id}"]`)).toHaveAttribute("aria-current", "true");
    await expect(pageOne).toBeFocused();
  });
  await test.step("the other one is reached the same way, and both stay editable from the list", async () => {
    await page.mouse.click(onBoth.x, onBoth.y);
    await page.keyboard.press("Enter");
    await expect(annotationList(page).locator(`[data-entry="${blue.id}"]`)).toHaveAttribute("aria-current", "true");
    for (const a of all) await expect(annotationList(page).locator(`[data-entry="${a.id}"]`).getByRole("button", { name: /^Colour of/ })).toBeEnabled();
  });
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a new highlight survives a reload at another zoom", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "rotated-crop.pdf", await buildRotatedCropPdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Ferries again" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const line = "The ferry timetable was rewritten every spring.";
  // Made at 150% with the view turned a quarter (the page's own /Rotate 90 besides: the line runs across, upside down).
  await zoomTo(page, "150%");
  await toolbar(page).getByRole("button", { name: "Rotate view" }).click();
  await expect(page.locator(".ao-reader-text-layer[data-main-rotation]").first()).toBeAttached();
  await centreOn(page, { n: 1, words: line, to: 19 });
  await dragSelect(page, { n: 1, words: line, i: 0 }, { n: 1, words: line, i: 18 });
  await colourBar(page).getByRole("button", { name: "Highlight in Purple" }).click();
  await expect(said(page)).toHaveText("Highlight added: Purple, page 1.");
  const [made] = await listed(app, projectId, sid);
  expect(made!.quote).toBe("The ferry timetable");

  // Read again at 100%, the view not turned: it lies on its words, and is not "changed".
  await page.reload();
  await expect(zoomValue(page)).toHaveText("100%");
  await centreOn(page, { n: 1, words: line, to: 19 });
  const mark = page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${made!.id}"]`);
  await expect(mark).toHaveCount(1);
  let last = "";
  let placedNow: { mark: DOMRectInit; words: DOMRectInit } | undefined;
  await expect
    .poll(async () => {
      placedNow = await page.evaluate(
        ({ id, line }) => {
          const box = (b: DOMRect) => ({ x: b.left, y: b.top, width: b.width, height: b.height });
          const span = [...document.querySelectorAll('[data-page-number="1"] .ao-reader-text-layer span')].find((s) => s.textContent === line)!;
          const r = document.createRange();
          r.setStart(span.firstChild!, 0);
          r.setEnd(span.firstChild!, "The ferry timetable".length);
          return { mark: box(document.querySelector(`.ao-hl[data-annotation="${id}"]`)!.getBoundingClientRect()), words: box(r.getBoundingClientRect()) };
        },
        { id: made!.id, line },
      );
      const now = JSON.stringify(placedNow);
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  const { mark: m, words: w } = placedNow! as { mark: Required<DOMRectInit>; words: Required<DOMRectInit> };
  const detail = `highlight ${JSON.stringify(m)} words ${JSON.stringify(w)}`;
  console.log(`[${test.info().project.name}] made at 150% turned, read at 100%: ${detail}`);
  // The page's own /Rotate 90: the line runs down the screen. Along it, each end within 2 px of the words'.
  expect(Math.abs(m.y - w.y), detail).toBeLessThanOrEqual(ALONG_TOLERANCE_PX);
  expect(Math.abs(m.y + m.height - (w.y + w.height)), detail).toBeLessThanOrEqual(ALONG_TOLERANCE_PX);
  // Across it: the highlight's middle on the words.
  const middle = m.x + m.width / 2;
  expect(middle >= w.x && middle <= w.x + w.width, detail).toBe(true);
  await expect(annotationList(page).locator(`[data-entry="${made!.id}"]`)).toBeVisible();
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ---- Task R10, fix round 1 (Ruling R223, I1): a drag let go in blank space stores only what was selected ----

/** The screen box of page `n`'s span `words`. */
async function boxOf(page: Page, n: number, words: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
  return page.evaluate(
    ({ n, words }) => {
      const s = [...document.querySelectorAll(`[data-page-number="${n}"] .ao-reader-text-layer span`)].find((x) => x.textContent === words)!;
      const b = s.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    },
    { n, words },
  );
}

/** Presses at `points[0]`, moves through each of the others in turn, and lets go at the last. */
async function dragThrough(page: Page, points: Point[]): Promise<void> {
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("a drag let go in blank space stores only what was selected (R223, I1)", () => {
  // Column one: 9-point lines from x 50, baselines 740, 724, 708, 692, 676, 660; column two from x 315.
  const LINE_TWO = "when traders carry baskets down the river path and";
  const LINE_THREE = "set out their goods beneath the old plane trees.";
  const LINE_FOUR = "The elders remember when the river ran further east,";
  const LINE_FIVE = "and they measure the years by the floods that came.";
  const ROW_THREE_RIGHT = "Children learn the names of the fields from songs,";
  const LAST = "This is the last line of the second column.";

  /** The two-column article at 50% (both columns in the pages' view), the lines `words` centred. */
  async function open(page: Page, app: AppHarness, project: string, ...words: string[]): Promise<{ projectId: string; sid: string }> {
    const file = sourceFile(app, "two-columns.pdf", await buildTwoColumnPdf());
    const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project });
    const { sid } = await attachPdf(app, projectId, file);
    await readFromLibrary(page, app, projectId, sid);
    const zoomOut = toolbar(page).getByRole("button", { name: "Zoom out" });
    await zoomOut.click();
    await zoomOut.click();
    await expect(zoomValue(page)).toHaveText("50%");
    await centreOn(page, ...words.map((w) => ({ n: 1, words: w })));
    return { projectId, sid };
  }

  /** Highlights the selection held now, and reads it back from the service. */
  async function stored(page: Page, app: AppHarness, ids: { projectId: string; sid: string }): Promise<Made> {
    await expect(colourBar(page)).toBeVisible();
    await colourBar(page).getByRole("button", { name: "Highlight in Green" }).click();
    await expect(said(page)).toHaveText("Highlight added: Green, page 1.");
    const all = await listed(app, ids.projectId, ids.sid);
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  /** One rectangle, on the line of `baseline`, within column `x0`–`x1`. */
  function onLine(made: Made, baseline: number, x0: number, x1: number): void {
    const rects = made.pdfAnchors[0]!.rects;
    expect(made.pdfAnchors.map((a) => a.page)).toEqual([1]);
    expect(rects, JSON.stringify(rects)).toHaveLength(1);
    const r = rects[0]!;
    expect(r.y < baseline && r.y + r.h > baseline && r.h < 16, JSON.stringify(r)).toBe(true);
    expect(r.x >= x0 - 1 && r.x + r.w <= x1 + 1, JSON.stringify(r)).toBe(true);
  }

  test("let go 10 px past a line's end, on the same line", async ({ page, app }) => {
    const ids = await open(page, app, "Past the end", LINE_TWO);
    const from = await charPoint(page, 1, LINE_TWO, LINE_TWO.indexOf("carry"), "before");
    const line = await boxOf(page, 1, LINE_TWO);
    const end = await charPoint(page, 1, LINE_TWO, LINE_TWO.length - 1, "after");
    await dragThrough(page, [from, end, { x: line.right + 10, y: (line.top + line.bottom) / 2 }]);
    const made = await stored(page, app, ids);
    expect(made.quote).toBe("carry baskets down the river path and");
    onLine(made, 724, 50, 280);
  });

  test("let go in the gutter between the two columns", async ({ page, app }) => {
    const ids = await open(page, app, "In the gutter", LINE_THREE, ROW_THREE_RIGHT);
    const from = await charPoint(page, 1, LINE_THREE, 0, "before");
    const left = await boxOf(page, 1, LINE_THREE);
    const right = await boxOf(page, 1, ROW_THREE_RIGHT);
    const end = await charPoint(page, 1, LINE_THREE, LINE_THREE.length - 1, "after");
    // The middle of the gutter (x 280–315 points), at the line's own height.
    const gutter = { x: (left.right + right.left) / 2, y: (left.top + left.bottom) / 2 };
    await dragThrough(page, [from, end, gutter]);
    const made = await stored(page, app, ids);
    expect(made.quote).toBe(LINE_THREE);
    onLine(made, 708, 50, 280);
  });

  test("let go between two lines", async ({ page, app }) => {
    const ids = await open(page, app, "Between lines", LINE_FOUR, LINE_FIVE);
    const from = await charPoint(page, 1, LINE_FOUR, 0, "before");
    const to = await charPoint(page, 1, LINE_FOUR, "The elders remember".length - 1, "after");
    const four = await boxOf(page, 1, LINE_FOUR);
    const five = await boxOf(page, 1, LINE_FIVE);
    // Straight down from there into the blank space between the two lines. The release point lies
    // below line four: every character of that line comes before it in reading order, none of line five.
    await dragThrough(page, [from, to, { x: to.x, y: (four.bottom + five.top) / 2 }]);
    const made = await stored(page, app, ids);
    expect(made.quote).toBe(LINE_FOUR);
    onLine(made, 692, 50, 280);
  });

  test("let go below the last line of a page", async ({ page, app }) => {
    const ids = await open(page, app, "Below the last line", LAST);
    const from = await charPoint(page, 1, LAST, 0, "before");
    const to = await charPoint(page, 1, LAST, "This is the last line".length - 1, "after");
    const last = await boxOf(page, 1, LAST);
    // Below the last line: the rest of that line comes before the release point; nothing else does.
    await dragThrough(page, [from, to, { x: to.x, y: last.bottom + 40 }]);
    const made = await stored(page, app, ids);
    expect(made.quote).toBe(LAST);
    onLine(made, 660, 315, 545);
  });
});

test("the toolbar comes only for a selection just made on a page (R223, I2)", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Only when made" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  const made = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, { kind: "highlight", assetId: aid, anchors: [{ page: 1, rects: [LINE_ONE] }], quote: "This is the text", colorName: "blue" });
  expect(made.status).toBe(201);
  await readFromLibrary(page, app, projectId, sid);
  const line = "This is the text of page 1, written for the reader's tests.";
  await centreOn(page, { n: 1, words: line, to: 26 });
  await test.step("Escape, then a click on Zoom in: no toolbar", async () => {
    await dragSelect(page, { n: 1, words: line, i: 12 }, { n: 1, words: line, i: 18 });
    await expect(colourBar(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(colourBar(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    await toolbar(page).getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomValue(page)).toHaveText("125%");
    await expect(colourBar(page)).toHaveCount(0);
  });
  await test.step("select-all with a page focused, then a click on Zoom out or on a list button: no alert and no toolbar", async () => {
    await page.locator('[data-page-number="1"]').focus();
    await page.keyboard.press("ControlOrMeta+a");
    expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).length).toBeGreaterThan(0);
    await toolbar(page).getByRole("button", { name: "Zoom out" }).click();
    await expect(zoomValue(page)).toHaveText("100%");
    await annotationList(page).getByRole("button", { name: /^Go to/ }).click();
    await expect(page.locator('[data-page-number="1"]')).toBeFocused();
    await expect(colourBar(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
  expect(errors).toEqual([]);
});

// ---- Task R10, last round: a drag must end on a page (Ruling R229); a highlight made under a search's filter (R223 f) ----

test("a drag let go outside every page stores nothing and says why (R229)", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Let go on the page" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const zoomOut = toolbar(page).getByRole("button", { name: "Zoom out" });
  await zoomOut.click();
  await zoomOut.click();
  await expect(zoomValue(page)).toHaveText("50%");
  const lineOf = (n: number) => `This is the text of page ${n}, written for the reader's tests.`;
  const SENTENCE = "To highlight, let go of the mouse over the page.";
  const tinted = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
  /** A press before "text" on page `n`'s line, dragged along it, then let go at `end()`; nothing must come of it. */
  const letGoAt = async (where: string, n: number, end: () => Promise<Point>) => {
    await test.step(`let go ${where}`, async () => {
      const line = lineOf(n);
      await centreOn(page, { n, words: line, to: 20 });
      const from = await charPoint(page, n, line, 12, "before");
      const along = await charPoint(page, n, line, 18, "after");
      const to = await end();
      await dragThrough(page, [from, along, to]);
      await expect(said(page)).toHaveText(SENTENCE);
      await expect(colourBar(page)).toHaveCount(0);
      expect(await tinted()).toBe("");
      await expect(page.getByRole("alert")).toHaveCount(0);
      // Let go over the page, the toolbar comes as before.
      await centreOn(page, { n, words: line, to: 20 });
      await dragSelect(page, { n, words: line, i: 12 }, { n, words: line, i: 15 });
      await expect(colourBar(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(colourBar(page)).toHaveCount(0);
    });
  };
  await letGoAt("over the annotation list", 1, async () => {
    const b = (await annotationList(page).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 40) };
  });
  await letGoAt("beyond the left edge of the pages' view", 1, async () => {
    const b = (await page.locator(".ao-reader-scroll").boundingBox())!;
    return { x: Math.max(2, b.x - 15), y: b.y + b.height / 2 };
  });
  await letGoAt("in the gap between two pages (dragged up from page 2's line)", 2, async () => {
    const two = (await page.locator('[data-page-number="2"]').boundingBox())!;
    return { x: two.x + two.width / 3, y: two.y - 8 };
  });
  expect(await listed(app, projectId, sid)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a highlight made while the list is filtered to a search's words shows in it at once (R223 f)", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "three-pages.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Searched" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  const note = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, { kind: "highlight", assetId: aid, anchors: [{ page: 2, rects: [{ x: 50, y: 757.7, w: 70.9, h: 10.2 }] }], quote: "This is the text", body: "the riverbank survey", colorName: "blue" });
  expect(note.status).toBe(201);
  const other = await app.api<{ id: string }>("POST", `/projects/${projectId}/sources/${sid}/annotations`, { kind: "highlight", assetId: aid, anchors: [{ page: 3, rects: [{ x: 50, y: 757.7, w: 70.9, h: 10.2 }] }], quote: "This is the text", colorName: "grey" });
  expect(other.status).toBe(201);
  const stored = await app.api<{ source: { title: { variants: Array<{ value: string }> } } }>("GET", `/projects/${projectId}/sources/${sid}`);
  const title = stored.body.source.title.variants[0]!.value;
  // The library's search finds the word in the annotation; "Show in the reader" opens the reader filtered to it.
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole("searchbox", { name: "Search sources" }).fill("riverbank");
  const sources = page.getByRole("table", { name: "Sources" });
  await expect(sources.getByRole("row", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toContainText("Found in an annotation");
  await sources.getByRole("button", { name: `Show in the reader: ${title}`, exact: true }).click();
  await expect(page.getByRole("region", { name: "Annotations matching your search (1)" })).toBeVisible();
  await expect(page.locator(`[data-entry="${other.body.id}"]`)).toHaveCount(0);
  // A highlight made with the mouse on page 1.
  const line = "This is the text of page 1, written for the reader's tests.";
  await centreOn(page, { n: 1, words: line, to: 26 });
  await dragSelect(page, { n: 1, words: line, i: 20 }, { n: 1, words: line, i: 25 });
  await colourBar(page).getByRole("button", { name: "Highlight in Purple" }).click();
  await expect(said(page)).toHaveText("Highlight added: Purple, page 1.");
  const list = page.getByRole("region", { name: "Annotations matching your search (2)" });
  await expect(list).toBeVisible();
  const made = (await listed(app, projectId, sid)).find((a) => a.quote === "page 1")!;
  expect(made).toBeTruthy();
  await expect(list.locator(`[data-entry="${made.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-entry="${other.body.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();
  expect(errors).toEqual([]);
});

// ---- Task R11: highlights and page notes without a mouse ----

test("a highlight and a page note made by keyboard alone", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "by-keyboard.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "By keyboard" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  await expect(page.locator('[data-page-number="1"] .ao-reader-text-layer > .ao-reader-end-of-content')).toBeAttached();
  const pages = page.locator(".ao-reader-scroll");
  // The reader puts the focus on its pages when it opens.
  await expect(pages).toBeFocused();
  const selection = () => page.evaluate(() => document.getSelection()?.toString() ?? "");

  // S: the first word visible on page 1; Shift+Right twice; said in the live region.
  await page.keyboard.press("s");
  await expect.poll(selection).toBe("Page");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(selection).toBe("Page 1 of");
  await expect(said(page)).toHaveText("Selected: ⁨Page 1 of⁩");
  // The tint is the browser's own selection, inside page 1's text layer.
  expect(await page.evaluate(() => !!document.getSelection()?.getRangeAt(0).startContainer.parentElement?.closest('[data-page-number="1"] .ao-reader-text-layer'))).toBe(true);
  // Enter: R10's toolbar, the focus on "Highlight"; the arrows to Green; Enter.
  await page.keyboard.press("Enter");
  await expect(colourBar(page)).toBeVisible();
  await expect(colourBar(page).getByRole("button", { name: "Highlight", exact: true })).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(colourBar(page).getByRole("button", { name: "Highlight in Green" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(said(page)).toHaveText("Highlight added: Green, page 1.");
  await expect(colourBar(page)).toHaveCount(0);
  await expect(pages).toBeFocused();
  expect(await selection()).toBe("");

  // N: the note field for page 1, placed at the top left of what is shown; Ctrl/Cmd+Enter saves it.
  await page.keyboard.press("n");
  const field = page.getByRole("region", { name: "Note on page 1" });
  await expect(field).toContainText("On page 1, at the top left of what is shown.");
  await expect(field.getByRole("textbox", { name: "Note" })).toBeFocused();
  await page.keyboard.type("Typed without a mouse");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(said(page)).toHaveText("Note added, page 1.");
  await expect(field).toHaveCount(0);
  await expect(pages).toBeFocused();

  const all = (await listed(app, projectId, sid)) as Array<Made & { kind: string; body?: string }>;
  expect(all).toHaveLength(2);
  const hl = all.find((a) => a.kind === "highlight")!;
  const note = all.find((a) => a.kind === "note")!;
  expect(hl.quote).toBe("Page 1 of");
  expect(hl.colorName).toBe("green");
  expect(hl.pdfAnchors.map((a) => a.page)).toEqual([1]);
  expect(hl.pdfAnchors[0]!.sortIndex.startsWith("00000|000000|")).toBe(true);
  expect(note.body).toBe("Typed without a mouse");
  expect(note.pdfAnchors.map((a) => a.page)).toEqual([1]);
  // The view was at the page's top: the note's 22-point square lies at the page's top left, 8 px (6 points) in.
  const r = note.pdfAnchors[0]!.rects[0]!;
  const detail = JSON.stringify(r);
  expect(Math.abs(r.w - 22), detail).toBeLessThan(0.01);
  expect(Math.abs(r.h - 22), detail).toBeLessThan(0.01);
  expect(r.x, detail).toBeLessThan(40);
  expect(r.y + r.h, detail).toBeGreaterThan(842 - 40);
  expect(note.pdfAnchors[0]!.sortIndex.startsWith("00000|000000|")).toBe(true);
  // Both are listed and drawn at once.
  await expect(annotationList(page).locator(`[data-entry="${hl.id}"]`)).toContainText("Page 1 of");
  await expect(annotationList(page).locator(`[data-entry="${note.id}"]`)).toContainText("Typed without a mouse");
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${note.id}"]`)).toHaveCount(1);

  // Read again: both are still there, drawn on page 1 and listed, the highlight not "changed".
  await page.reload();
  await expect(annotationList(page).locator(`[data-entry="${hl.id}"]`)).toContainText("Page 1 of");
  await expect(annotationList(page).locator(`[data-entry="${note.id}"]`)).toContainText("Typed without a mouse");
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${hl.id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-page-number="1"] .ao-hl[data-annotation="${note.id}"]`)).toHaveCount(1);
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a keyboard selection crosses into the next page; a further Shift+arrow closes the toolbar; Escape ends it, nothing stored", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const file = sourceFile(app, "across.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Across by keyboard" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  for (const n of [1, 2]) await expect(page.locator(`[data-page-number="${n}"] .ao-reader-text-layer > .ao-reader-end-of-content`)).toBeAttached();
  const pages = page.locator(".ao-reader-scroll");
  await expect(pages).toBeFocused();
  const selection = () => page.evaluate(() => document.getSelection()?.toString() ?? "");
  /** The page the selection's end is on. */
  const endPage = () => page.evaluate(() => (document.getSelection()?.rangeCount ? Number(document.getSelection()!.getRangeAt(0).endContainer.parentElement?.closest<HTMLElement>("[data-page-number]")?.dataset.pageNumber) : 0));
  await page.keyboard.press("s");
  await expect.poll(selection).toBe("Page");
  // Down by lines until the selection reaches page 2 (its first line, the same place: its first word).
  for (let i = 0; i < 4 && (await endPage()) !== 2; i++) await page.keyboard.press("Shift+ArrowDown");
  expect(await endPage()).toBe(2);
  expect(await selection()).toContain("written for the reader's tests.");
  await expect.poll(selection).toMatch(/Page$/);
  // Enter: the toolbar takes the focus; going back to the pages leaves it open.
  await page.keyboard.press("Enter");
  await expect(colourBar(page).getByRole("button", { name: "Highlight", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+Tab");
  await expect(pages).toBeFocused();
  await expect(colourBar(page)).toBeVisible();
  // A further Shift+arrow: the selection grows, the toolbar closes (it would store less than is tinted).
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(selection).toMatch(/Page 2$/);
  await expect(colourBar(page)).toHaveCount(0);
  // Escape: ended and said, the tint gone, the focus on the pages; nothing was stored.
  await page.keyboard.press("Escape");
  await expect(said(page)).toHaveText("Selection cancelled.");
  expect(await selection()).toBe("");
  await expect(pages).toBeFocused();
  expect(await listed(app, projectId, sid)).toEqual([]);
  expect(errors).toEqual([]);
});

test("with a note open, words selected on the page with the mouse stay selected, to be copied into the note (R11, J1)", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 1000 });
  const file = sourceFile(app, "copy-into-note.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Copy into a note" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  await expect(page.locator('[data-page-number="1"] .ao-reader-text-layer > .ao-reader-end-of-content')).toBeAttached();
  await expect(page.locator(".ao-reader-scroll")).toBeFocused();
  await page.keyboard.press("n");
  const field = page.getByRole("region", { name: "Note on page 1" }).getByRole("textbox", { name: "Note" });
  await expect(field).toBeFocused();
  await page.keyboard.type("about ");
  const before = await said(page).textContent();
  // Select words of page 2 with the mouse (below the note's field, which lies over the top left of the pages).
  const line = "This is the text of page 2, written for the reader's tests.";
  await centreOn(page, { n: 2, words: line, to: 20 });
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".ao-reader-scroll")!;
    const note = document.querySelector<HTMLElement>(".ao-reader-note")!.getBoundingClientRect();
    const v = scroller.getBoundingClientRect();
    scroller.scrollTop -= Math.max(0, note.bottom + 40 - (v.top + v.bottom) / 2);
  });
  await dragSelect(page, { n: 2, words: line, i: 0 }, { n: 2, words: line, i: 10 });
  // No toolbar, nothing said; the selection holds those words and the focus is not in the note.
  await expect(colourBar(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("This is the");
  expect(await field.evaluate((el) => el === document.activeElement)).toBe(false);
  expect(await said(page).textContent()).toBe(before);
  // (The clipboard cannot be read alike in both browsers: Ctrl/Cmd+C copies the document's selection, asserted above.)
  // Then into the note: its text unchanged, and still written in.
  await field.click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("about ");
  await page.keyboard.press("End");
  await page.keyboard.type("these words");
  await expect(field).toHaveValue("about these words");
  expect(await listed(app, projectId, sid)).toEqual([]);
  expect(errors).toEqual([]);
});
