// @vitest-environment node
/**
 * pdfRectToBox (Task R8): a rectangle stored in PDF user space (points, origin at the bottom left,
 * y up, the page unrotated — as Zotero stores it and as the reader will store its own) placed on a
 * drawn page through the page's own viewport, at any zoom, view rotation, /Rotate and crop box.
 *
 * The page is a real one: the rotated, offset-crop fixture of tests/fixtures/generate.mjs
 * (`buildRotatedCropPdf`: a 700 × 900 page, crop box from (50, 60) 595 wide and 820 high, /Rotate
 * 90, three lines of 12-point Helvetica from x 100, baselines y 800, 780, 760), opened with pdf.js
 * itself. The expected places are worked out by hand from the crop box and the rotation, not by the
 * viewport, so that the test does not merely repeat the code.
 */
import { getDocument, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRotatedCropPdf } from "../../../../tests/fixtures/generate.mjs";
import { pdfRectToBox, type Box } from "./geometry";

let task: ReturnType<typeof getDocument>;
let page: PDFPageProxy;
/** The first line's text item, as pdf.js reads it from the page. */
let line: { str: string; transform: number[]; width: number; height: number };

beforeAll(async () => {
  task = getDocument({ data: new Uint8Array(await buildRotatedCropPdf()), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  page = await (await task.promise).getPage(1);
  const text = await page.getTextContent();
  line = text.items.find((i) => "str" in i && i.str.startsWith("The ferry")) as typeof line;
});
afterAll(async () => {
  await task?.destroy();
});

/** Crop box of the fixture: x 50–645, y 60–880. */
const CROP = { x0: 50, y0: 60, x1: 645, y1: 880 };

/** Where a user-space point lands, worked out by hand for each total rotation (clockwise, as /Rotate). */
function byHand(x: number, y: number, rotation: number, s: number): [number, number] {
  switch (rotation) {
    case 0:
      return [(x - CROP.x0) * s, (CROP.y1 - y) * s];
    case 90: // the page's top edge is now on the right, its left edge on top
      return [(y - CROP.y0) * s, (x - CROP.x0) * s];
    case 180:
      return [(CROP.x1 - x) * s, (y - CROP.y0) * s];
    default: // 270
      return [(CROP.y1 - y) * s, (CROP.x1 - x) * s];
  }
}

function boxByHand(r: { x: number; y: number; w: number; h: number }, rotation: number, s: number): Box {
  const [ax, ay] = byHand(r.x, r.y, rotation, s);
  const [bx, by] = byHand(r.x + r.w, r.y + r.h, rotation, s);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

const close = (a: Box, b: Box, eps = 1e-6) => {
  for (const k of ["left", "top", "width", "height"] as const) expect(Math.abs(a[k] - b[k]), `${k}: ${a[k]} vs ${b[k]}`).toBeLessThan(eps);
};

describe("pdfRectToBox", () => {
  it("an imported rect on a rotated page with an offset crop box lands on its text", () => {
    // The fixture is what it claims to be: an offset crop box and /Rotate 90.
    expect(page.view).toEqual([50, 60, 645, 880]);
    expect(page.rotate).toBe(90);
    expect(line.transform).toEqual([12, 0, 0, 12, 100, 800]);
    // The rectangle Zotero stores for a highlight of the whole first line: its glyphs' box (Helvetica
    // ascent 0.718, descent 0.207 of the size), x from the line's start for its width.
    const size = line.transform[3]!;
    const rect = { x: 100, y: 800 - 0.207 * size, w: line.width, h: 0.925 * size };
    for (const view of [0, 90, 180, 270]) {
      for (const scale of [1, 4 / 3, 2, 8 / 3]) {
        const rotation = (page.rotate + view) % 360;
        const viewport = page.getViewport({ scale, rotation });
        const box = pdfRectToBox(rect, viewport);
        close(box, boxByHand(rect, rotation, scale));
        // It lies on the page, and the line's first glyph's origin is on its edge (start of the line, baseline).
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(viewport.width + 1e-6);
        expect(box.top + box.height).toBeLessThanOrEqual(viewport.height + 1e-6);
        const [ox, oy] = byHand(100, 800, rotation, scale);
        expect(ox).toBeGreaterThanOrEqual(box.left - 1e-6);
        expect(ox).toBeLessThanOrEqual(box.left + box.width + 1e-6);
        expect(oy).toBeGreaterThanOrEqual(box.top - 1e-6);
        expect(oy).toBeLessThanOrEqual(box.top + box.height + 1e-6);
        // Along the line it is as long as the line, across it as high as the glyphs, in either orientation.
        const along = rotation % 180 === 0 ? box.width : box.height;
        const across = rotation % 180 === 0 ? box.height : box.width;
        expect(along).toBeCloseTo(line.width * scale, 6);
        expect(across).toBeCloseTo(0.925 * size * scale, 6);
      }
    }
  });

  it("pdfRectToBox is stable across zoom", () => {
    const rect = { x: 100.5, y: 200, w: 199.5, h: 15.25 };
    for (const view of [0, 90, 180, 270]) {
      const rotation = (page.rotate + view) % 360;
      const one = pdfRectToBox(rect, page.getViewport({ scale: 1, rotation }));
      for (const scale of [0.5, 0.75, 1.25, 2, 3, 4]) {
        const box = pdfRectToBox(rect, page.getViewport({ scale, rotation }));
        close(box, { left: one.left * scale, top: one.top * scale, width: one.width * scale, height: one.height * scale }, 1e-6);
      }
    }
  });

  it("an empty rect is an empty box where it stands, never a negative one", () => {
    const viewport = page.getViewport({ scale: 2, rotation: 90 });
    const box = pdfRectToBox({ x: 300, y: 400, w: 0, h: 0 }, viewport);
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
    const [x, y] = byHand(300, 400, 90, 2);
    close(box, { left: x, top: y, width: 0, height: 0 });
  });
});
