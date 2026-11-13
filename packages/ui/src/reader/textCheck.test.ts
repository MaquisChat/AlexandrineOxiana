// @vitest-environment node
/**
 * Does a highlight's quote still match the text under its rectangles (Task R8, Accept 5)? The text
 * under the rectangles is read from the page's own text (pdf.js's text content, in PDF user space),
 * and compared with the quote after folding what differs between two readings of the same words:
 * spacing, a word broken with a hyphen at a line's end, ligatures, letter case.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRotatedCropPdf } from "../../../../tests/fixtures/generate.mjs";
import { quoteStillMatches, textUnderRects, type TextContent } from "./textCheck";

describe("quoteStillMatches", () => {
  it("quoteStillMatches tolerates hyphenation and spacing but not different words", () => {
    // The same words read twice.
    expect(quoteStillMatches("informal markets", "informal markets")).toBe(true);
    expect(quoteStillMatches("informal markets", "informal  markets")).toBe(true);
    expect(quoteStillMatches("informal markets", "informal\nmarkets")).toBe(true);
    expect(quoteStillMatches("informal markets", "informalmarkets")).toBe(true);
    expect(quoteStillMatches("the self-evident truth", "the self- evident truth")).toBe(true);
    expect(quoteStillMatches("the self-evident truth", "the self-\nevident truth")).toBe(true);
    expect(quoteStillMatches("the selfevident truth", "the self-\nevident truth")).toBe(true);
    expect(quoteStillMatches("a soft hy­phen", "a soft hyphen")).toBe(true);
    expect(quoteStillMatches("the ﬁrst ﬂoor", "the first floor")).toBe(true);
    expect(quoteStillMatches("Informal Markets", "informal markets")).toBe(true);
    // A rectangle that takes in a letter of the next word, or loses one at its edge, is the same quote.
    expect(quoteStillMatches("the ledger of crossings survives", "the ledger of crossings survives i")).toBe(true);
    expect(quoteStillMatches("the ledger of crossings survives", "he ledger of crossings survives")).toBe(true);
    // Different words are not.
    expect(quoteStillMatches("informal markets", "formal economies")).toBe(false);
    expect(quoteStillMatches("the informal markets of Lagos", "the formal markets of Lagos")).toBe(false);
    expect(quoteStillMatches("the ledger of crossings survives", "the ledger of crossings vanished")).toBe(false);
    // A letter lost in the middle is another word, not a rectangle's edge.
    expect(quoteStillMatches("the ledger of crossings survives", "the ledger of crossing survives")).toBe(false);
    expect(quoteStillMatches("informal markets in Lagos", "informal markets in Accra")).toBe(false);
    // Punctuation at an edge or between words is not a different word.
    expect(quoteStillMatches("in Lagos", "in Lagos,")).toBe(true);
    expect(quoteStillMatches("“informal” markets", "\"informal\" markets")).toBe(true);
    // A short quote must match exactly.
    expect(quoteStillMatches("the", "toe")).toBe(false);
    expect(quoteStillMatches("the", "the")).toBe(true);
    // Text gone from under the rectangles is not the quote; a quote of nothing has nothing to check.
    expect(quoteStillMatches("informal markets", "")).toBe(false);
    expect(quoteStillMatches("", "anything")).toBe(true);
    // The rectangles over a whole paragraph are not a two-word quote.
    expect(quoteStillMatches("informal markets", "the informal markets of Lagos were the subject of the study")).toBe(false);
  });
});

/** One horizontal text item: `str` at baseline (x, y), `size` points, `width` points long. */
const item = (str: string, x: number, y: number, size: number, width: number, hasEOL = false) => ({ str, dir: "ltr", transform: [size, 0, 0, size, x, y], width, height: size, fontName: "f1", hasEOL });
const content = (...items: ReturnType<typeof item>[]): TextContent => ({ items, styles: { f1: { fontFamily: "sans-serif", ascent: 0.718, descent: -0.207, vertical: false } }, lang: null }) as unknown as TextContent;

describe("textUnderRects", () => {
  it("reads the words whose glyphs lie under the rectangles, line by line", () => {
    // Two lines of 10-point Helvetica (each item as long as Helvetica makes it): "bbbb" at x 125.02–147.26
    // on the first, "dddd" at x 100–122.24 on the second, each rectangle a little wider than its word.
    const text = content(item("aaaa bbbb cccc", 100, 700, 10, 70.04, true), item("dddd eeee gggg", 100, 686, 10, 72.28));
    const rects = [
      { x: 124.5, y: 698, w: 23.5, h: 10 },
      { x: 99.5, y: 684, w: 23.5, h: 10 },
    ];
    expect(textUnderRects(text, rects).replace(/\s+/g, " ").trim()).toBe("bbbb dddd");
  });

  it("is empty where no text lies under the rectangles", () => {
    expect(textUnderRects(content(item("words", 100, 700, 10, 50)), [{ x: 400, y: 100, w: 50, h: 10 }])).toBe("");
    expect(textUnderRects(content(), [{ x: 0, y: 0, w: 1000, h: 1000 }])).toBe("");
  });

  describe("on a real page (the rotated, offset-crop fixture)", () => {
    let task: ReturnType<typeof getDocument>;
    let text: TextContent;
    beforeAll(async () => {
      task = getDocument({ data: new Uint8Array(await buildRotatedCropPdf()), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
      text = await (await (await task.promise).getPage(1)).getTextContent();
    });
    afterAll(async () => {
      await task?.destroy();
    });

    it("finds the quoted words of a line and of two lines", () => {
      // "Passengers argued about it on the quay." at x 100, baseline 780, 12 pt: "argued about" spans
      // from after "Passengers " to before " it" (Helvetica widths, as Zotero would have stored them).
      const helvetica = (s: string) => [...s].reduce((a, c) => a + (WIDTHS[c] ?? 556), 0) * 0.012;
      const start = 100 + helvetica("Passengers ");
      const rect = { x: start, y: 780 - 0.207 * 12, w: helvetica("argued about"), h: 0.925 * 12 };
      const under = textUnderRects(text, [rect]);
      expect(quoteStillMatches("argued about", under)).toBe(true);
      expect(quoteStillMatches("argued about it", under)).toBe(false);
      // The whole of the first line and the start of the second.
      const two = [
        { x: 100, y: 800 - 2.5, w: helvetica("The ferry timetable was rewritten every spring."), h: 11.1 },
        { x: 100, y: 780 - 2.5, w: helvetica("Passengers"), h: 11.1 },
      ];
      expect(quoteStillMatches("The ferry timetable was rewritten every spring. Passengers", textUnderRects(text, two))).toBe(true);
    });
  });
});

/** Helvetica advance widths (thousandths of an em) of the letters used above. */
const WIDTHS: Record<string, number> = { " ": 278, P: 667, a: 556, s: 500, e: 556, n: 556, g: 556, r: 333, u: 556, d: 556, b: 556, o: 556, t: 278, T: 611, h: 556, f: 278, y: 500, i: 222, m: 833, l: 222, w: 722, v: 500, p: 556, ".": 278 };
