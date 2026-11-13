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
import { buildMultiPagePdf, buildPdf, buildRotatedCropPdf, buildScanPdf } from "../tests/fixtures/generate.mjs";
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

test("an imported Zotero highlight sits on its words at two zooms", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const dataDir = join(app.root, "sources", "Zotero");
  const linkedDir = join(app.root, "sources", "linked");
  buildZoteroFixture(dataDir, { pdf: await okaforPdf(), linkedPdf: await buildPdf({ extra: "adebayo linked" }), linkedDir });
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Market studies" });

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
  const highlight = listed.body.annotations.find((a) => a.kind === "highlight")!;
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

  const notices = page.getByRole("region", { name: "Highlights to check" });
  await expect(notices.getByRole("listitem")).toHaveText([`Page 1, “Words this page never held”: ${CHANGED}`, "Page 7, “A page this file lacks”: This highlight is on page 7, which this file does not have."]);
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
  await expect(page.getByRole("region", { name: "Highlights to check" })).toHaveCount(0);
  await expect(page.getByText(CHANGED)).toHaveCount(0);
  expect(errors).toEqual([]);
});
