/**
 * Does a highlight's quote still match the text under its rectangles (Task R8, Accept 5 as changed
 * by A11, Ruling R209)?
 *
 * A highlight stores its rectangles and the words it was made on. If the file was changed since (a
 * linked file edited elsewhere, another edition put in its place), the rectangles may now lie over
 * other words; the reader then says "The text here has changed since this highlight was made."
 * rather than silently marking the wrong words. A wrong verdict costs the researcher's trust in every
 * such mark, so it is given only on clear evidence:
 *
 *  - `textUnderRects` returns the text of the WHOLE text items (pdf.js's pieces of text, usually a
 *    line or part of one) whose box any rectangle touches, in the order pdf.js gives them. Which
 *    characters of an item lie inside a rectangle is not estimated: pdf.js gives an item's position
 *    and length, not each glyph's, and any estimate is wrong for typewriter faces, justified lines and
 *    right-to-left text (pdf.js gives such an item in logical order, its position at its visual left).
 *  - `quoteStillMatches` says whether the quote, normalised, is CONTAINED in that text, normalised.
 *    Normalising folds what differs between two readings of the same words: NFKC (ligatures such as
 *    "ﬁ"), letter case, and everything that is not a letter or a digit (spaces, line breaks, a hyphen
 *    at a line's end, a soft hyphen, punctuation and its typographic forms; so a trailing ellipsis on
 *    a quote the importer cut short is ignored too).
 *  - No verdict at all (`canJudge` false, or `touchesVerticalText` true): a quote of fewer than
 *    MIN_QUOTE_LETTERS letters and digits once normalised (too short to be evidence), or rectangles
 *    touching a text item pdf.js marks as vertical. The reader adds its own cases (no text on the
 *    page, the page not drawn, the handle dead, anchors on another file).
 *
 * The same words moved to other lines, or other words in their place, are "changed"; extra words
 * around the quote are not.
 *
 * Pure: nothing here reads a document; the reader hands in a page's text it already has (read
 * through the guarded path of PdfPages, raced against the handle's failure, A7).
 */
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfRectDto } from "../api/reader";

/** A page's text as pdf.js gives it. */
export type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** The fewest letters and digits a normalised quote must have for a verdict. */
export const MIN_QUOTE_LETTERS = 4;

interface Item {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

type Styles = Record<string, { ascent?: number; descent?: number; vertical?: boolean } | undefined>;
interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const finite = (r: PdfRectDto) => [r.x, r.y, r.w, r.h].every(Number.isFinite);

/** The text items of a page, each with its box in PDF user space and whether pdf.js marks it vertical. */
function itemsOf(textContent: TextContent): Array<{ str: string; box: Bounds; vertical: boolean }> {
  const styles = (textContent.styles ?? {}) as Styles;
  const out: Array<{ str: string; box: Bounds; vertical: boolean }> = [];
  for (const raw of textContent.items) {
    if (!("str" in raw)) continue;
    const item = raw as unknown as Item;
    if (typeof item.str !== "string" || item.str === "" || !Array.isArray(item.transform) || item.transform.length < 6) continue;
    const [a, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
    if (![a, b, c, d, e, f, item.width, item.height].every(Number.isFinite)) continue;
    const st = item.fontName ? styles[item.fontName] : undefined;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 1;
    if (st?.vertical) {
      // A vertical run goes down the page from its origin for `height`; its box is taken generously (a
      // rectangle touching it only means no verdict).
      const run = Math.max(item.height, size);
      out.push({ str: item.str, box: { x0: e - size, y0: f - run - size, x1: e + size, y1: f + size }, vertical: true });
      continue;
    }
    const run = Math.hypot(a, b) > 0 ? [a / Math.hypot(a, b), b / Math.hypot(a, b)] : [1, 0];
    const up = Math.hypot(c, d) > 0 ? [c / Math.hypot(c, d), d / Math.hypot(c, d)] : [0, 1];
    const ascent = typeof st?.ascent === "number" ? st.ascent : 0.8;
    const descent = typeof st?.descent === "number" ? st.descent : -0.2;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const along of [0, Math.max(0, item.width)]) {
      for (const h of [descent * size, ascent * size]) {
        xs.push(e + run[0]! * along + up[0]! * h);
        ys.push(f + run[1]! * along + up[1]! * h);
      }
    }
    out.push({ str: item.str, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, vertical: false });
  }
  return out;
}

/** Whether a rectangle and a box overlap (sharing an edge only is not touching). */
const touches = (r: PdfRectDto, b: Bounds) => Math.min(r.x + r.w, b.x1) - Math.max(r.x, b.x0) > 0 && Math.min(r.y + r.h, b.y1) - Math.max(r.y, b.y0) > 0;

/** The text of the whole text items any of `rects` (PDF user space) touches, in pdf.js's order, joined by spaces. */
export function textUnderRects(textContent: TextContent, rects: PdfRectDto[]): string {
  const live = rects.filter(finite);
  if (live.length === 0) return "";
  return itemsOf(textContent)
    .filter((i) => live.some((r) => touches(r, i.box)))
    .map((i) => i.str)
    .join(" ");
}

/** Whether any of `rects` touches a text item pdf.js marks as vertical: then no verdict is given. */
export function touchesVerticalText(textContent: TextContent, rects: PdfRectDto[]): boolean {
  const live = rects.filter(finite);
  return itemsOf(textContent).some((i) => i.vertical && live.some((r) => touches(r, i.box)));
}

/** What is compared: NFKC, lower case, letters and digits only. */
function fold(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a quote is long enough to judge (MIN_QUOTE_LETTERS letters and digits once normalised). */
export function canJudge(quote: string): boolean {
  return [...fold(quote)].length >= MIN_QUOTE_LETTERS;
}

/**
 * Whether the quote's words are still in `textUnderRects` (containment after normalisation). A quote
 * that cannot be judged (`canJudge` false: empty or too short) always "matches": no verdict.
 */
export function quoteStillMatches(quote: string, textUnderRects: string): boolean {
  if (!canJudge(quote)) return true;
  return fold(textUnderRects).includes(fold(quote.replace(/(…|\.\.\.)\s*$/u, "")));
}
