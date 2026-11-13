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
import { JSDOM } from "jsdom";
import { getDocument, type PageViewport, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfSortIndex } from "@ao/core/annotations/sortIndex";
import { buildRotatedCropPdf, buildTwoColumnPdf } from "../../../../tests/fixtures/generate.mjs";
import { normaliseQuote, pdfRectToBox, selectionToAnchors, selectionToPdfRects, type Box, type DOMRectLike, type PageGeometry } from "./geometry";
import { canJudge, quoteStillUnder, type TextContent } from "./textCheck";

let task: ReturnType<typeof getDocument>;
let page: PDFPageProxy;
/** The first line's text item, as pdf.js reads it from the page. */
let line: { str: string; transform: number[]; width: number; height: number };

beforeAll(async () => {
  task = getDocument({ data: new Uint8Array(await buildRotatedCropPdf()), useSystemFonts: false, verbosity: 0 });
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

// ---- Task R10: from a selection on the page back to PDF rectangles ---------------------------------
/*
 * The selection side (Task R10). The pages are real ones again — the two-column article of
 * tests/fixtures/generate.mjs (`buildTwoColumnPdf`: columns at x 50–280 and 315–545, 9-point Times,
 * baselines 740 down to 660 every 16 points, a 35-point gutter; page 2 the same) and the rotated,
 * offset-crop page above — read with pdf.js itself. A page's text layer is built here the way pdf.js
 * builds it (one span per text item, a <br> after an item that ends a line), in a document of its own
 * (jsdom), and a range's rectangles are worked out from each item's place through the page's own
 * viewport: a browser lays the spans over their words the same way, which the end-to-end tests check
 * in Chromium and WebKit.
 */

type Item = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean; fontName: string };
let twoTask: ReturnType<typeof getDocument>;
const two: Array<{ page: PDFPageProxy; text: TextContent; items: Item[] }> = [];
let rotatedText: TextContent;

beforeAll(async () => {
  twoTask = getDocument({ data: new Uint8Array(await buildTwoColumnPdf()), useSystemFonts: false, verbosity: 0 });
  const doc = await twoTask.promise;
  for (const n of [1, 2]) {
    const p = await doc.getPage(n);
    const text = await p.getTextContent();
    two.push({ page: p, text, items: text.items.filter((i) => "str" in i) as unknown as Item[] });
  }
  rotatedText = await page.getTextContent();
});
afterAll(async () => {
  await twoTask?.destroy();
});

/** An item's glyph box in PDF user space, characters `from` to `to` (its font's ascent and descent, as pdf.js gives them). */
function glyphBox(text: TextContent, item: Item, from = 0, to = item.str.length) {
  const st = (text.styles as Record<string, { ascent: number; descent: number }>)[item.fontName]!;
  const size = item.transform[3]!;
  const len = Math.max(1, item.str.length);
  return { x: item.transform[4]! + (item.width * from) / len, y: item.transform[5]! + st.descent * size, w: (item.width * (to - from)) / len, h: (st.ascent - st.descent) * size };
}

/** A client rectangle: a box on the page moved to where the page lies on the screen. */
const toClient = (b: Box, at: DOMRectLike): DOMRectLike => ({ left: at.left + b.left, top: at.top + b.top, width: b.width, height: b.height });

interface Built {
  doc: Document;
  pages: PageGeometry[];
  /** The text node of item `i` of page `n` (1-based page). */
  node(n: number, i: number): Text;
  /** Something outside the pages (the annotation list, say). */
  outside: HTMLElement;
}

/** Text layers for the pages given, each laid out at its viewport and placed on the screen at `at`; a range's rectangles worked out from the items' places. */
function buildLayers(src: Array<{ text: TextContent; items: Item[] }>, viewports: PageViewport[], at: DOMRectLike[]): Built {
  const dom = new JSDOM(`<!doctype html><div id="area"></div><section id="list"><p>A note in the list</p></section>`);
  const doc = dom.window.document;
  const area = doc.getElementById("area")!;
  const owner = new Map<Node, { text: TextContent; item: Item; viewport: PageViewport; at: DOMRectLike }>();
  const nodes: Text[][] = [];
  const pages: PageGeometry[] = src.map((s, k) => {
    const element = doc.createElement("div");
    element.dataset.pageNumber = String(k + 1);
    const textLayer = doc.createElement("div");
    textLayer.className = "ao-reader-text-layer";
    element.append(textLayer);
    area.append(element);
    const mine: Text[] = [];
    for (const item of s.items) {
      const t = doc.createTextNode(item.str);
      if (item.str !== "") {
        const span = doc.createElement("span");
        span.append(t);
        textLayer.append(span);
        owner.set(t, { text: s.text, item, viewport: viewports[k]!, at: at[k]! });
      }
      mine.push(t);
      if (item.hasEOL) textLayer.append(doc.createElement("br"));
    }
    nodes.push(mine);
    const a = at[k]!;
    element.getBoundingClientRect = () => ({ ...a, x: a.left, y: a.top, right: a.left + a.width, bottom: a.top + a.height, toJSON: () => ({}) }) as DOMRect;
    return { page: k + 1, element, textLayer, viewport: viewports[k]! };
  });
  // A range inside one text node: the part of its item's glyph box those characters take.
  dom.window.Range.prototype.getClientRects = function (this: Range) {
    const o = this.startContainer === this.endContainer ? owner.get(this.startContainer) : undefined;
    if (!o || this.collapsed) return [] as unknown as DOMRectList;
    return [toClient(pdfRectToBox(glyphBox(o.text, o.item, this.startOffset, this.endOffset), o.viewport), o.at)] as unknown as DOMRectList;
  };
  return { doc, pages, node: (n, i) => nodes[n - 1]![i]!, outside: doc.querySelector<HTMLElement>("#list p")! };
}

/** A range from [page, item, character] to [page, item, character]. */
function rangeIn(b: Built, start: [number, number, number], end: [number, number, number]): Range {
  const r = b.doc.createRange();
  r.setStart(b.node(start[0], start[1]), start[2]);
  r.setEnd(b.node(end[0], end[1]), end[2]);
  return r;
}

const atFor = (vp: PageViewport, dy = 0): DOMRectLike => ({ left: 40.5, top: 1234.25 + dy, width: vp.width, height: vp.height });
const itemIndex = (n: number, starts: string) => two[n - 1]!.items.findIndex((i) => i.str.startsWith(starts));

describe("selectionToPdfRects (Task R10)", () => {
  it("selectionToPdfRects merges per line and drops the gutter", () => {
    const { page: p, text, items } = two[0]!;
    const vp = p.getViewport({ scale: 1.5, rotation: 0 });
    const at = atFor(vp);
    const foot = items[itemIndex(1, "At the foot")]!;
    const head = items[itemIndex(1, "into the head")]!;
    const rowOne = items[itemIndex(1, "Market days")]!;
    const client = (it: Item, from: number, to: number) => toClient(pdfRectToBox(glyphBox(text, it, from, to), vp), at);
    // The foot of column one in two pieces (as two spans of one line give it), then the head of column two.
    const rects = selectionToPdfRects([client(foot, 0, 20), client(foot, 20, foot.str.length), client(head, 0, 27)], at, vp);
    expect(rects).toHaveLength(2);
    // One rectangle a line, in the order selected.
    expect(rects[0]!.x).toBeCloseTo(50, 6);
    expect(rects[0]!.w).toBeCloseTo(foot.width, 6);
    expect(rects[0]!.y).toBeLessThan(660);
    expect(rects[0]!.y + rects[0]!.h).toBeGreaterThan(660);
    expect(rects[1]!.x).toBeCloseTo(315, 6);
    expect(rects[1]!.w).toBeCloseTo((head.width * 27) / head.str.length, 6);
    expect(rects[1]!.y).toBeLessThan(740);
    expect(rects[1]!.y + rects[1]!.h).toBeGreaterThan(740);
    // Never widened: each is exactly the selected glyphs' box (one line high, no padding).
    expect(rects[0]!.h).toBeCloseTo(0.9 * 9, 6);
    // Two lines on one baseline, one in each column, stay two rectangles: nothing lies over the gutter.
    const row = selectionToPdfRects([client(rowOne, 0, rowOne.str.length), client(head, 0, head.str.length)], at, vp);
    expect(row).toHaveLength(2);
    for (const r of [...rects, ...row]) expect(r.x + r.w <= 280 + 1e-6 || r.x >= 315 - 1e-6, JSON.stringify(r)).toBe(true);
  });

  it("selectionToPdfRects is the exact inverse of pdfRectToBox at every page and view rotation, crop box and zoom", () => {
    // Three lines far apart, so that none is merged with another.
    const rects = [
      { x: 100, y: 800 - 2.484, w: 260.1, h: 11.1 },
      { x: 120.25, y: 700, w: 80, h: 9 },
      { x: 300, y: 300, w: 33.3, h: 14.5 },
    ];
    for (const pg of [page, two[0]!.page]) {
      for (const view of [0, 90, 180, 270]) {
        for (const scale of [0.5, 1, 4 / 3, 1.5 * (4 / 3), 2.75, 4]) {
          const vp = pg.getViewport({ scale, rotation: (pg.rotate + view) % 360 });
          const at = atFor(vp);
          const boxes = rects.map((r) => pdfRectToBox(r, vp));
          const back = selectionToPdfRects(
            boxes.map((b) => toClient(b, at)),
            at,
            vp,
          );
          expect(back).toHaveLength(boxes.length);
          back.forEach((r, i) => close(pdfRectToBox(r, vp), boxes[i]!, 1e-6));
          back.forEach((r, i) => {
            for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(r[k] - rects[i]![k])).toBeLessThan(1e-6);
          });
        }
      }
    }
  });

  it("a highlight made at 150% with the view rotated 90 lies on its words at 100% unrotated", () => {
    const item = rotatedText.items.find((i) => "str" in i && i.str.startsWith("The ferry")) as unknown as Item;
    const words = glyphBox(rotatedText, item, 0, "The ferry timetable".length);
    const made = page.getViewport({ scale: 1.5 * (4 / 3), rotation: (page.rotate + 90) % 360 });
    const at = atFor(made);
    const rects = selectionToPdfRects([toClient(pdfRectToBox(words, made), at)], at, made);
    expect(rects).toHaveLength(1);
    const later = page.getViewport({ scale: 4 / 3, rotation: page.rotate });
    close(pdfRectToBox(rects[0]!, later), pdfRectToBox(words, later), 1e-6);
    expect(quoteStillUnder("The ferry timetable", rotatedText, rects)).toBe(true);
  });

  it("a rectangle reaching past the page is cut at its edge; one wholly off it, or empty, is dropped", () => {
    const vp = two[0]!.page.getViewport({ scale: 1, rotation: 0 });
    const at = atFor(vp);
    const rects = selectionToPdfRects(
      [
        { left: at.left - 30, top: at.top + 100, width: 60, height: 10 },
        { left: at.left + vp.width + 5, top: at.top + 100, width: 20, height: 10 },
        { left: at.left + 10, top: at.top + 200, width: 0, height: 10 },
      ],
      at,
      vp,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBeCloseTo(0, 6);
    expect(rects[0]!.w).toBeCloseTo(30, 6);
  });
});

describe("selectionToAnchors (Task R10)", () => {
  const build = () => {
    const a = two[0]!.page.getViewport({ scale: 4 / 3, rotation: 0 });
    const b = two[1]!.page.getViewport({ scale: 4 / 3, rotation: 0 });
    return buildLayers([two[0]!, two[1]!], [a, b], [atFor(a), atFor(b, a.height + 16)]);
  };

  it("a selection across two columns gives one rectangle a line and the quote in reading order, which R8's check accepts", () => {
    const b = build();
    const foot = itemIndex(1, "At the foot");
    const head = itemIndex(1, "into the head");
    const out = selectionToAnchors(rangeIn(b, [1, foot, 7], [1, head, 27]), b.pages);
    expect(out).toHaveLength(1);
    const a = out[0]!;
    expect(a.page).toBe(1);
    expect(a.rects).toHaveLength(2);
    expect(a.quote).toBe("foot of this column the sentence continues into the head of the second");
    // R8's own check (A11, A12) with pdf.js's own text of the page: never "changed" when made, and
    // the rectangles are in PDF space, so the same holds at any zoom or turn.
    expect(canJudge(a.quote)).toBe(true);
    expect(quoteStillUnder(a.quote, two[0]!.text, a.rects)).toBe(true);
    for (const r of a.rects) expect(r.x + r.w <= 280 + 1e-6 || r.x >= 315 - 1e-6).toBe(true);
  });

  it("a selection's sort index orders it after an earlier one on the page", () => {
    const b = build();
    const first = itemIndex(1, "when traders");
    const later = itemIndex(1, "The elders");
    const x = selectionToAnchors(rangeIn(b, [1, first, 5], [1, first, 12]), b.pages)[0]!;
    const y = selectionToAnchors(rangeIn(b, [1, later, 4], [1, later, 11]), b.pages)[0]!;
    expect(x.sortIndex < y.sortIndex).toBe(true);
    // The form R1 builds: page index, the start's offset in the page's text, its top from the page's top.
    const before = two[0]!.items.slice(0, first).reduce((n, i) => n + i.str.length, 0);
    const top = Math.floor(842 - (x.rects[0]!.y + x.rects[0]!.h));
    expect(x.sortIndex).toBe(pdfSortIndex(0, before + 5, top));
  });

  it("a highlight made in column two sorts after one made at the foot of column one", () => {
    const b = build();
    const foot = itemIndex(1, "At the foot");
    const head = itemIndex(1, "of the bridge");
    const inOne = selectionToAnchors(rangeIn(b, [1, foot, 0], [1, foot, 15]), b.pages)[0]!;
    const inTwo = selectionToAnchors(rangeIn(b, [1, head, 0], [1, head, 13]), b.pages)[0]!;
    // Column two's line stands higher on the page than column one's foot: only the text's order puts it after.
    expect(inTwo.rects[0]!.y).toBeGreaterThan(inOne.rects[0]!.y);
    expect(inOne.sortIndex < inTwo.sortIndex).toBe(true);
  });

  it("a selection across a page break gives one anchor a page, each with its own place and quote", () => {
    const b = build();
    const last = itemIndex(1, "This is the last line");
    const title = itemIndex(2, "Rivers and Markets");
    const out = selectionToAnchors(rangeIn(b, [1, last, 12], [2, title, 18]), b.pages);
    expect(out.map((a) => a.page)).toEqual([1, 2]);
    expect(out[0]!.quote).toBe("last line of the second column.");
    expect(out[1]!.quote).toBe("Rivers and Markets");
    expect(out[0]!.sortIndex.startsWith("00000|")).toBe(true);
    expect(out[1]!.sortIndex.startsWith("00001|000000|")).toBe(true);
    expect(quoteStillUnder(out[0]!.quote, two[0]!.text, out[0]!.rects)).toBe(true);
    expect(quoteStillUnder(out[1]!.quote, two[1]!.text, out[1]!.rects)).toBe(true);
  });

  it("a selection that starts or ends outside the pages is cut to the part inside them; nothing is left of one wholly outside", () => {
    const b = build();
    const foot = itemIndex(1, "At the foot");
    // From the head of the screen (before every page) to a word of page 1.
    const r = b.doc.createRange();
    r.setStart(b.doc.body, 0);
    r.setEnd(b.node(1, foot), 6);
    const out = selectionToAnchors(r, b.pages);
    expect(out).toHaveLength(1);
    expect(out[0]!.quote.startsWith("Rivers and Markets, page 1 Market days")).toBe(true);
    expect(out[0]!.quote.endsWith("At the")).toBe(true);
    // From a word of page 2 into the annotation list.
    const tail = b.doc.createRange();
    tail.setStart(b.node(2, itemIndex(2, "This is the last line")), 12);
    tail.setEnd(b.outside.firstChild!, 6);
    expect(selectionToAnchors(tail, b.pages).map((a) => [a.page, a.quote])).toEqual([[2, "last line of the second column."]]);
    // Wholly in the list: nothing.
    const list = b.doc.createRange();
    list.selectNodeContents(b.outside);
    expect(selectionToAnchors(list, b.pages)).toEqual([]);
    // A page not given (not drawn, or without text) gives nothing either.
    expect(selectionToAnchors(rangeIn(b, [1, foot, 0], [1, foot, 6]), [b.pages[1]!])).toEqual([]);
  });
});

describe("normaliseQuote (Task R10)", () => {
  it("joins words hyphenated at a line's end and collapses white space", () => {
    expect(normaliseQuote("  the self-\nevident\t truths  \n of the  river ")).toBe("the selfevident truths of the river");
    expect(normaliseQuote("a well-known name")).toBe("a well-known name");
    expect(normaliseQuote("ends with a dash -\n then more")).toBe("ends with a dash - then more");
    expect(normaliseQuote("bell\u0007 rang")).toBe("bell rang");
  });
});
