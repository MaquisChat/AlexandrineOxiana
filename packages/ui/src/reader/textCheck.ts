/**
 * Does a highlight's quote still match the text under its rectangles (Task R8, Accept 5)?
 *
 * A highlight stores its rectangles and the words it was made on. If the file was changed since
 * (a linked file edited elsewhere, another edition put in its place), the rectangles may now lie
 * over other words; the reader then says so rather than silently marking the wrong words.
 *
 * `textUnderRects` reads, from a page's text as pdf.js gives it (in PDF user space, the same space
 * as the rectangles), the characters whose glyph centre lies inside one of the rectangles. pdf.js
 * gives a text item's position and total advance, not each glyph's, so each character's share of
 * the item's width is estimated from Helvetica's advance widths (any proportional face is closer to
 * it than to equal shares), scaled to the item's real width: at an item's start and end the estimate
 * is exact, in between it may be off by part of a character.
 *
 * `quoteStillMatches` compares the two after folding what differs between two readings of the same
 * words: NFKC (ligatures such as "ﬁ"), letter case, and everything that is not a letter or a digit
 * (spaces, line breaks, a hyphen at a line's end, a soft hyphen, punctuation and its typographic
 * forms). What is left must be equal, except that a rectangle's edge may take in, or leave out, a
 * few characters at either end: none for a quote of fewer than 4 letters, then one for every 8
 * letters, at most 3. A letter changed, added or lost anywhere else is a different text.
 *
 * Pure: nothing here reads a document; the reader hands in a page's text it already has (read
 * through the guarded path of PdfPages, raced against the handle's failure, A7).
 */
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfRectDto } from "../api/reader";

/** A page's text as pdf.js gives it. */
export type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** Helvetica advance widths, thousandths of an em, for printable ASCII (32–126); 556 for anything else. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
  722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const advance = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c >= 32 && c <= 126 ? HELVETICA[c - 32]! : 556;
};

interface Item {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

const inside = (x: number, y: number, r: PdfRectDto) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The text whose glyphs lie under `rects` (PDF user space), in the page's text order; pieces of separate items are joined by a space. */
export function textUnderRects(textContent: TextContent, rects: PdfRectDto[]): string {
  const live = rects.filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite));
  if (live.length === 0) return "";
  const styles = (textContent.styles ?? {}) as Record<string, { ascent?: number; descent?: number } | undefined>;
  const parts: string[] = [];
  for (const raw of textContent.items) {
    if (!("str" in raw)) continue;
    const item = raw as unknown as Item;
    if (!item.str || !Array.isArray(item.transform) || item.transform.length < 6) continue;
    const [a, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
    const run = Math.hypot(a, b);
    const rise = Math.hypot(c, d);
    if (!(run > 0) || !(rise > 0) || !(item.width > 0)) continue;
    // Along the baseline, and up from it, as unit vectors in user space.
    const [dx, dy] = [a / run, b / run];
    const [ux, uy] = [c / rise, d / rise];
    // The glyphs' middle height above the baseline: half way between the face's descent and ascent.
    const st = item.fontName ? styles[item.fontName] : undefined;
    const ascent = typeof st?.ascent === "number" ? st.ascent : 0.8;
    const descent = typeof st?.descent === "number" ? st.descent : -0.2;
    const mid = ((ascent + descent) / 2) * rise;
    const chars = [...item.str];
    const total = chars.reduce((s, ch) => s + advance(ch), 0);
    let at = 0;
    let piece = "";
    for (const ch of chars) {
      const w = (advance(ch) / total) * item.width;
      const along = at + w / 2;
      at += w;
      const x = e + dx * along + ux * mid;
      const y = f + dy * along + uy * mid;
      if (live.some((r) => inside(x, y, r))) piece += ch;
      else if (piece) {
        parts.push(piece);
        piece = "";
      }
    }
    if (piece) parts.push(piece);
  }
  return parts.join(" ");
}

/** What is compared: NFKC, lower case, letters and digits only. */
function fold(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether the words of `quote` are the words of `textUnderRects` (see the module's comment for the rule). */
export function quoteStillMatches(quote: string, textUnderRects: string): boolean {
  const q = fold(quote);
  if (q === "") return true;
  const t = fold(textUnderRects);
  if (t === "") return false;
  if (q === t) return true;
  const edge = q.length < 4 ? 0 : Math.max(1, Math.min(3, Math.floor(q.length / 8)));
  if (Math.abs(t.length - q.length) > edge * 2) return false;
  // Up to `edge` characters left out of the quote at its ends, up to `edge` taken in at either end of the text.
  for (let a = 0; a <= edge; a++) {
    for (let b = 0; a + b <= edge; b++) {
      const core = q.slice(a, q.length - b);
      if (core.length === 0) continue;
      const i = t.indexOf(core);
      if (i >= 0 && i <= edge && t.length - (i + core.length) <= edge && i + (t.length - i - core.length) <= edge) return true;
    }
  }
  return false;
}
