/**
 * Where a stored rectangle lies on a drawn page (Task R8).
 *
 * Every annotation's place is stored as rectangles in PDF user space: points, origin at the bottom
 * left, y up, the page unrotated, `{x, y, w, h}` with (x, y) the lower-left corner — Zotero's
 * rectangles as imported (Task R2) and the reader's own alike (packages/shared PdfRectDto). The one
 * way such a rectangle reaches the screen is `pdfRectToBox`, through the page's own pdf.js viewport,
 * so that zoom, the view's rotation, the page's /Rotate, its crop box (which need not start at the
 * origin) and its UserUnit are all applied exactly as pdf.js draws the page itself.
 *
 * pdf.js 6.4.299's PageViewport no longer has `convertToViewportRectangle` (the plan names it); it
 * was the two corners through `convertToViewportPoint`, ordered, which is what this does.
 */
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfSortIndex } from "@ao/core/annotations/sortIndex";
import type { PdfRectDto } from "../api/reader";

/** A box on the drawn page, in CSS pixels from the page's top-left corner. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A PDF rectangle (user space) as a box on the page drawn at `viewport`. */
export function pdfRectToBox(rect: PdfRectDto, viewport: PageViewport): Box {
  const [ax, ay] = viewport.convertToViewportPoint(rect.x, rect.y) as [number, number];
  const [bx, by] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h) as [number, number];
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

/**
 * Which side of a box is the foot of the words in it (the rectangle's lower edge in PDF space), for
 * the view's total rotation (the page's /Rotate and the view's own): bottom, left, top or right.
 */
export function footEdge(viewport: PageViewport): "bottom" | "left" | "top" | "right" {
  const r = (((viewport.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  return r === 90 ? "left" : r === 180 ? "top" : r === 270 ? "right" : "bottom";
}

// ---- Task R10: from a selection back to PDF rectangles ------------------------------------------------

/** A rectangle on the screen (a DOMRect, or anything with its four numbers), in CSS pixels. */
export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Two rectangles of a selection are one line when they stand on it together: their heights within
 * LINE_HEIGHT_RATIO of each other, overlapping across the line by LINE_OVERLAP of the lower one,
 * and no further apart along it than LINE_GAP_EM of its height (a word space, or the gap between two
 * of pdf.js's pieces of one line — never a column's gutter, which is several times the type size).
 */
const LINE_OVERLAP = 0.7;
const LINE_HEIGHT_RATIO = 1.3;
const LINE_GAP_EM = 1.5;
/** A piece taller than this many times its width runs down the page in PDF space: never merged (it could join two lines). */
const UPRIGHT = 6;

/**
 * The selected rectangles of one page, as PDF rectangles (user space, `{x, y, w, h}`, (x, y) the
 * lower left corner) — the exact inverse of `pdfRectToBox` through the same viewport, whatever the
 * zoom, the view's rotation, the page's /Rotate and its crop box.
 *
 * `clientRects` are where the selected text lies on the screen (Range.getClientRects of each piece
 * of selected text, in reading order); `pageBox` is where the page's drawing starts and how large it
 * is on the screen (the box the viewport's (0, 0) is the corner of). Each rectangle is first cut to
 * the page (text past the page's edge is not on it) and dropped if nothing is left; then rectangles
 * on one text line next to each other are merged into one, in the order selected. Nothing is
 * widened: a merged rectangle spans only its pieces and the space between them on that line, and
 * two lines on one baseline with a column's gutter between them stay two rectangles.
 */
export function selectionToPdfRects(clientRects: DOMRectLike[], pageBox: DOMRectLike, viewport: PageViewport): PdfRectDto[] {
  const pieces: PdfRectDto[] = [];
  for (const c of clientRects) {
    if (![c.left, c.top, c.width, c.height].every(Number.isFinite)) continue;
    // Cut to the page, in the page's own pixels.
    const left = Math.max(c.left - pageBox.left, 0);
    const top = Math.max(c.top - pageBox.top, 0);
    const right = Math.min(c.left + c.width - pageBox.left, pageBox.width);
    const bottom = Math.min(c.top + c.height - pageBox.top, pageBox.height);
    if (!(right > left) || !(bottom > top)) continue;
    const [ax, ay] = viewport.convertToPdfPoint(left, top) as [number, number];
    const [bx, by] = viewport.convertToPdfPoint(right, bottom) as [number, number];
    pieces.push({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
  }
  const lines: PdfRectDto[] = [];
  for (const p of pieces) {
    const last = lines[lines.length - 1];
    if (last && sameLine(last, p)) {
      const x0 = Math.min(last.x, p.x);
      const y0 = Math.min(last.y, p.y);
      const x1 = Math.max(last.x + last.w, p.x + p.w);
      const y1 = Math.max(last.y + last.h, p.y + p.h);
      lines[lines.length - 1] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else lines.push(p);
  }
  return lines;
}

/** Whether `b` continues the line `a` (see LINE_OVERLAP and the constants beside it). */
function sameLine(a: PdfRectDto, b: PdfRectDto): boolean {
  if (a.h > UPRIGHT * a.w || b.h > UPRIGHT * b.w) return false;
  const low = Math.min(a.h, b.h);
  const high = Math.max(a.h, b.h);
  if (low <= 0 || high > LINE_HEIGHT_RATIO * low) return false;
  const across = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (across < LINE_OVERLAP * low) return false;
  const gap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  return gap <= LINE_GAP_EM * low;
}

/**
 * A character of Chinese or Japanese text: Han, kana, Bopomofo, and their punctuation and full-width
 * forms (FR-454, R474 M6). Such text is written without spaces, so a line break between two of them is
 * no space; nor is one between such a character and a digit ("第" / "3章"). Korean is written with
 * spaces and is not among them (nor are the half-width Hangul forms, U+FFA0–FFDC).
 */
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Bopomofo}\\u3000-\\u303F\\u30A0-\\u30FF\\uFF00-\\uFF9F\\uFFE0-\\uFFEF";
/** R474 M6: direction marks and zero-width characters, which do not block the join (they are kept). */
const MARKS = "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069";
/** A side of a break: Chinese or Japanese, or a digit (which joins only with Chinese or Japanese on the other side). */
const CJK_OR_DIGIT = `${CJK}\\p{Nd}`;
/**
 * The white space of a line break between Chinese or Japanese text and Chinese, Japanese or a digit. A
 * full-width space after the break (a paragraph's first-line indent) is not part of it: it is kept.
 */
const CJK_LINE_BREAK = new RegExp(
  `(?<=[${CJK}][${MARKS}]*)[^\\S\\n]*\\n[^\\S\\u3000]*(?=[${MARKS}]*[${CJK_OR_DIGIT}])|(?<=[${CJK_OR_DIGIT}][${MARKS}]*)[^\\S\\n]*\\n[^\\S\\u3000]*(?=[${MARKS}]*[${CJK}])`,
  "gu",
);

/**
 * A quote as stored: the selection's text with a word hyphenated at a line's end joined again
 * ("self-" and "evident" on the next line → "selfevident"), a line break between two characters of
 * Chinese or Japanese text dropped (FR-454), control characters dropped, and every other run of
 * white space (line breaks included) made one space, trimmed; a full-width space alone is kept
 * as it is (R474 M6: a paragraph's indent).
 */
export function normaliseQuote(text: string): string {
  return text
    .replace(/(\p{L})[-­‐]\s*\n\s*(?=\p{L})/gu, "$1")
    .replace(CJK_LINE_BREAK, "")
    .replace(/­/gu, "")
    .replace(/\p{Cc}/gu, (c) => (/\s/u.test(c) ? c : " "))
    .replace(/\s+/gu, (w) => (/^\u3000+$/u.test(w) ? w : " "))
    .trim();
}

/**
 * The quotes of a selection's pages as one quote, joined as its lines are: with nothing between
 * Chinese or Japanese text and Chinese, Japanese or a digit on both sides of a page break, with a
 * space otherwise (FR-454).
 */
export function joinQuotes(quotes: readonly string[]): string {
  let out = "";
  for (const q of quotes) {
    if (out !== "") {
      CJK_LINE_BREAK.lastIndex = 0;
      if (!CJK_LINE_BREAK.test(`${out.slice(-64)}\n${q.slice(0, 64)}`)) out += " ";
    }
    out += q;
  }
  return out;
}

/** One drawn page as the selection sees it. */
export interface PageGeometry {
  /** 1-based, as anchors store it. */
  page: number;
  /** The page's box (`[data-page-number]`); its inner corner is the viewport's (0, 0). */
  element: Element;
  /** pdf.js's text layer of the page (its spans hold the page's text items, in pdf.js's order). */
  textLayer: Element;
  /** The viewport the page is drawn at now. */
  viewport: PageViewport;
}

/** What one page of a selection gives: the page, its rectangles, its sort index and the text selected on it. */
export interface SelectionAnchor {
  page: number;
  rects: PdfRectDto[];
  sortIndex: string;
  quote: string;
}

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const START_TO_START = 0;
const END_TO_END = 2;

/**
 * The anchors of a selection: one for each page of `pages` whose text the range takes some of, in
 * page order. Only text of the pages' text layers counts: a range that starts or ends outside them
 * (the toolbar, the list, the gap between pages, a page without text) is cut to the part inside, and
 * gives nothing if nothing is left. On each page:
 *  - `rects`: the selected pieces of text, each from its own sub-range (never an element's whole
 *    box), through `selectionToPdfRects`;
 *  - `quote`: the selected text (a line break where pdf.js ends a line), normalised (`normaliseQuote`);
 *  - `sortIndex`: R1's `pdfSortIndex(page index, the offset of the selection's start in the page's
 *    text, the first rectangle's distance from the top of the page)`, Zotero's form (A1).
 */
export function selectionToAnchors(range: Range, pages: PageGeometry[]): SelectionAnchor[] {
  const out: SelectionAnchor[] = [];
  for (const g of [...pages].sort((a, b) => a.page - b.page)) {
    const one = sliceOf(range, g.textLayer);
    if (!one) continue;
    const doc = g.textLayer.ownerDocument;
    const walker = doc.createTreeWalker(g.textLayer, SHOW_ELEMENT | SHOW_TEXT);
    const client: DOMRectLike[] = [];
    let text = "";
    let offset = 0;
    let startAt: number | undefined;
    const box = pageBoxOf(g);
    /** The last piece's place on the page (PDF space), to tell a new line where pdf.js marked none. */
    let lastLine: PdfRectDto | undefined;
    let pendingBreak = false;
    for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType !== 3) {
        if ((n as Element).tagName === "BR" && one.intersectsNode(n) && startAt !== undefined) pendingBreak = true;
        continue;
      }
      const data = (n as Text).data;
      const from = n === one.startContainer ? one.startOffset : 0;
      const to = n === one.endContainer ? one.endOffset : data.length;
      const inside = one.intersectsNode(n) && to > from;
      if (!inside) {
        if (startAt === undefined) offset += data.length;
        continue;
      }
      if (startAt === undefined) startAt = offset + from;
      const piece = data.slice(from, to);
      const sub = doc.createRange();
      sub.setStart(n, from);
      sub.setEnd(n, to);
      const rects = rectsOf(sub);
      // WebKit measures a piece of a span scaled by pdf.js (`scaleX`) with its last character at its
      // unscaled width: the piece is cut where the next character starts, so it is never widened.
      if (to < data.length && rects.length > 0) {
        const after = doc.createRange();
        after.setStart(n, to);
        after.setEnd(n, to + 1);
        const next = rectsOf(after)[0];
        if (next) rects[rects.length - 1] = cutAt(rects[rects.length - 1]!, next);
      }
      const placed = selectionToPdfRects(rects, box, g.viewport);
      // A piece on another line than the last with no line break between them: a line break in the quote.
      if (!pendingBreak && lastLine && placed[0] && !acrossOverlap(lastLine, placed[0]) && text !== "" && !/\s$/u.test(text)) text += "\n";
      if (pendingBreak && text !== "") text += "\n";
      pendingBreak = false;
      text += piece;
      if (piece.trim() === "") continue;
      client.push(...rects);
      if (placed.length > 0) lastLine = placed[placed.length - 1];
    }
    const rects = selectionToPdfRects(client, box, g.viewport);
    const quote = normaliseQuote(text);
    if (rects.length === 0 || quote === "") continue;
    const first = rects[0]!;
    const pageTop = Array.isArray(g.viewport.viewBox) ? Math.max(g.viewport.viewBox[1]!, g.viewport.viewBox[3]!) : first.y + first.h;
    out.push({ page: g.page, rects, sortIndex: pdfSortIndex(g.page - 1, startAt ?? 0, pageTop - (first.y + first.h)), quote });
  }
  return out;
}

/** The part of `range` inside `layer`, or nothing. */
function sliceOf(range: Range, layer: Element): Range | undefined {
  if (!range.intersectsNode(layer)) return undefined;
  const r = layer.ownerDocument.createRange();
  r.selectNodeContents(layer);
  if (range.compareBoundaryPoints(START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
  return r.collapsed ? undefined : r;
}

/** The rectangles of a range, those with an area only (none where the browser offers no measure). */
function rectsOf(r: Range): DOMRectLike[] {
  if (typeof r.getClientRects !== "function") return [];
  return [...(r.getClientRects() as unknown as Iterable<DOMRectLike>)].filter((b) => b.width > 0 && b.height > 0).map((b) => ({ left: b.left, top: b.top, width: b.width, height: b.height }));
}

/**
 * `r` cut, along its line, where the next character `next` starts (only ever shortened): the line's
 * direction on the screen is the way from `r` to `next`, whichever way the page is turned.
 */
function cutAt(r: DOMRectLike, next: DOMRectLike): DOMRectLike {
  const dx = next.left + next.width / 2 - (r.left + r.width / 2);
  const dy = next.top + next.height / 2 - (r.top + r.height / 2);
  const right = r.left + r.width;
  const bottom = r.top + r.height;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // The same line: they overlap across it.
    if (Math.min(bottom, next.top + next.height) - Math.max(r.top, next.top) <= 0.5 * Math.min(r.height, next.height)) return r;
    if (dx > 0) return { ...r, width: Math.max(0, Math.min(right, Math.max(r.left, next.left)) - r.left) };
    const left = Math.max(r.left, Math.min(right, next.left + next.width));
    return { ...r, left, width: right - left };
  }
  if (Math.min(right, next.left + next.width) - Math.max(r.left, next.left) <= 0.5 * Math.min(r.width, next.width)) return r;
  if (dy > 0) return { ...r, height: Math.max(0, Math.min(bottom, Math.max(r.top, next.top)) - r.top) };
  const top = Math.max(r.top, Math.min(bottom, next.top + next.height));
  return { ...r, top, height: bottom - top };
}

/** Whether two PDF rectangles share a line (they overlap across it by half the lower one). */
function acrossOverlap(a: PdfRectDto, b: PdfRectDto): boolean {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5 * Math.min(a.h, b.h);
}

/** Where page `g`'s drawing lies on the screen: its box's inner corner, at the viewport's size. */
function pageBoxOf(g: PageGeometry): DOMRectLike {
  const b = g.element.getBoundingClientRect();
  const el = g.element as Partial<HTMLElement>;
  return { left: b.left + (el.clientLeft ?? 0), top: b.top + (el.clientTop ?? 0), width: g.viewport.width, height: g.viewport.height };
}
