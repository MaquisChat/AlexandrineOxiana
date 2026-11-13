// @vitest-environment node
/**
 * Does a highlight's quote still match the text under its rectangles (Task R8, Accept 5 as changed
 * by A11, Ruling R209)? The text of the whole text items the rectangles touch, in pdf.js's order, must
 * contain the quote once both are normalised (spacing, a word broken with a hyphen at a line's end,
 * ligatures, letter case, punctuation). No verdict for a quote under four letters or rectangles on
 * vertical text. Items are in pdf.js's own shape; two real pages are read with pdf.js itself.
 */
import { createRequire } from "node:module";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRotatedCropPdf } from "../../../../tests/fixtures/generate.mjs";
import { canJudge, quoteStillMatches, quoteStillUnder, textUnderRects, touchesVerticalText, type TextContent } from "./textCheck";

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
    expect(quoteStillMatches("in Lagos", "in Lagos,")).toBe(true);
    expect(quoteStillMatches("“informal” markets", "\"informal\" markets")).toBe(true);
    // The quote among more words (the whole lines its rectangles touch).
    expect(quoteStillMatches("informal markets", "the informal markets of Lagos were the subject of the study")).toBe(true);
    // A quote the importer cut short with an ellipsis.
    expect(quoteStillMatches("the informal markets of La…", "the informal markets of Lagos")).toBe(true);
    expect(quoteStillMatches("the informal markets of La...", "the informal markets of Lagos")).toBe(true);
    // Different words are not.
    expect(quoteStillMatches("informal markets", "formal economies")).toBe(false);
    expect(quoteStillMatches("the informal markets of Lagos", "the formal markets of Lagos")).toBe(false);
    expect(quoteStillMatches("the ledger of crossings survives", "the ledger of crossings vanished")).toBe(false);
    expect(quoteStillMatches("the ledger of crossings survives", "the ledger of crossing survives")).toBe(false);
    expect(quoteStillMatches("informal markets in Lagos", "informal markets in Accra")).toBe(false);
    // Text gone from under the rectangles is not the quote.
    expect(quoteStillMatches("informal markets", "")).toBe(false);
  });

  it("a quote of fewer than four letters gets no verdict", () => {
    for (const q of ["", "the", "a b", "of.", "Mr", "1 2 3"]) {
      expect(canJudge(q), q).toBe(false);
      expect(quoteStillMatches(q, "something else entirely"), q).toBe(true);
    }
    expect(canJudge("Mr W")).toBe(false);
    expect(canJudge("Mr Wo")).toBe(true);
    expect(canJudge("שלום")).toBe(true);
  });
});

/** A text item as pdf.js gives it: `str` at (x, y), `size` points, `width` long (`height` long for a vertical run). */
const item = (str: string, x: number, y: number, size: number, width: number, o: { dir?: string; fontName?: string; height?: number; hasEOL?: boolean } = {}) => ({
  str,
  dir: o.dir ?? "ltr",
  transform: [size, 0, 0, size, x, y],
  width,
  height: o.height ?? size,
  fontName: o.fontName ?? "f1",
  hasEOL: o.hasEOL ?? false,
});
const content = (...items: ReturnType<typeof item>[]): TextContent =>
  ({
    items,
    styles: { f1: { fontFamily: "sans-serif", ascent: 0.718, descent: -0.207, vertical: false }, v1: { fontFamily: "serif", ascent: 0.88, descent: -0.12, vertical: true } },
    lang: null,
  }) as unknown as TextContent;

describe("textUnderRects", () => {
  it("gives the whole items the rectangles touch, rectangle by rectangle", () => {
    const text = content(item("aaaa bbbb cccc", 100, 700, 10, 70.04, { hasEOL: true }), item("dddd eeee gggg", 100, 686, 10, 72.28), item("hhhh", 100, 600, 10, 22));
    const rects = [
      { x: 124.5, y: 698, w: 23.5, h: 10 },
      { x: 99.5, y: 684, w: 23.5, h: 10 },
    ];
    expect(textUnderRects(text, rects)).toBe("aaaa bbbb cccc dddd eeee gggg");
  });

  it("is empty where no text lies under the rectangles", () => {
    expect(textUnderRects(content(item("words", 100, 700, 10, 50)), [{ x: 400, y: 100, w: 50, h: 10 }])).toBe("");
    expect(textUnderRects(content(), [{ x: 0, y: 0, w: 1000, h: 1000 }])).toBe("");
  });

  it("a Hebrew line highlighted in part is not changed", () => {
    // pdf.js gives a right-to-left item in logical order, its transform at the item's visual left.
    const line = item("שלום עולם ומלואו", 100, 700, 12, 96, { dir: "rtl" });
    // The visual right third holds the logical first word "שלום".
    const under = textUnderRects(content(line), [{ x: 164, y: 697.5, w: 32, h: 11.1 }]);
    expect(quoteStillMatches("שלום", under)).toBe(true);
    // And the visual left part, the last word.
    expect(quoteStillMatches("ומלואו", textUnderRects(content(line), [{ x: 100, y: 697.5, w: 34, h: 11.1 }]))).toBe(true);
    // Other words in their place are still "changed".
    expect(quoteStillMatches("בוקר טוב", under)).toBe(false);
  });

  it("two columns listed row by row: a quote across the column break is not changed (A12, N1)", () => {
    // Times, 11 pt; pdf.js lists the left line i, then the right line i (as some generators and OCR layers write them).
    const L = 72;
    const R = 320;
    const rows = [
      ["Informal markets in Lagos grew", "austerity, as traders filled"],
      ["quickly during the years", "the gaps left by the state"],
      ["of structural adjustment and", "and its retreating agencies."],
    ];
    const items: ReturnType<typeof item>[] = [];
    rows.forEach(([l, r], i) => {
      items.push(item(l!, L, 700 - i * 14, 11, l!.length * 5.2), item(" ", L + l!.length * 5.2, 700 - i * 14, 11, 3), item(r!, R, 700 - i * 14, 11, r!.length * 5.2));
    });
    const text = content(...items);
    // Column one's foot ("structural adjustment and"), then column two's head ("austerity, as traders"): the rectangles in reading order.
    const rects = [
      { x: L + 3 * 5.2, y: 700 - 28 - 2.3, w: 25 * 5.2, h: 10.2 },
      { x: R, y: 700 - 2.3, w: 21 * 5.2, h: 10.2 },
    ];
    expect(textUnderRects(text, rects).replace(/\s+/g, " ")).toBe("of structural adjustment and austerity, as traders filled");
    expect(quoteStillUnder("structural adjustment and austerity, as traders", text, rects)).toBe(true);
    // Different words, and the same words moved to other lines: still changed.
    expect(quoteStillUnder("structural reform and austerity, as traders", text, rects)).toBe(false);
    expect(quoteStillUnder("quickly during the years", text, rects)).toBe(false);
  });

  it("a footnote mark drawn after its paragraph is not changed (A12, N3)", () => {
    // The paragraph's lines, then the superscript "12" drawn last, after "of" on line 1.
    const text = content(item("the informal markets of", 72, 700, 11, 120), item("Lagos grew quickly", 72, 686, 11, 95), item("12", 192.5, 704, 6, 6.7));
    const rects = [
      { x: 72, y: 697.7, w: 127.5, h: 12 },
      { x: 72, y: 683.7, w: 95, h: 10.2 },
    ];
    // In reading order the mark follows "of"; in pdf.js's order it comes last: either is not changed.
    expect(quoteStillUnder("the informal markets of12 Lagos grew", text, rects)).toBe(true);
    expect(quoteStillUnder("the informal markets of Lagos grew", text, rects)).toBe(true);
    expect(quoteStillUnder("the formal markets of Lagos grew", text, rects)).toBe(false);
  });

  it("an item's box is at least its font size high: a face with no ascent and descent, or a rectangle a little off, is not changed (A12, N2)", () => {
    const flat = {
      items: [item("informal markets of Lagos", 72, 700, 12, 140, { fontName: "z" })],
      styles: { z: { fontFamily: "serif", ascent: 0, descent: 0, vertical: false } },
      lang: null,
    } as unknown as TextContent;
    const glyphs = { x: 72, y: 700 - 0.207 * 12, w: 80, h: 0.925 * 12 };
    expect(quoteStillUnder("informal markets", flat, [glyphs])).toBe(true);
    // A rectangle 0.1 pt above the face's own box (Helvetica metrics).
    const helv = content(item("informal markets of Lagos", 72, 700, 12, 140));
    expect(quoteStillUnder("informal markets", helv, [{ x: 72, y: 700 + 0.718 * 12 + 0.1, w: 80, h: 3 }])).toBe(true);
  });

  it("rectangles on blank paper of a page with text: changed (A12)", () => {
    const text = content(item("informal markets of Lagos", 72, 700, 12, 140));
    expect(textUnderRects(text, [{ x: 300, y: 200, w: 80, h: 12 }])).toBe("");
    expect(quoteStillUnder("informal markets", text, [{ x: 300, y: 200, w: 80, h: 12 }])).toBe(false);
  });

  it("vertical text gets no verdict", () => {
    const vertical = content(item("非正規市場研究", 300, 700, 12, 12, { fontName: "v1", height: 84 }), item("horizontal words", 50, 500, 12, 90));
    // A rectangle over 市場, part way down the run.
    const on = [{ x: 294, y: 650, w: 12, h: 24 }];
    expect(touchesVerticalText(vertical, on)).toBe(true);
    expect(touchesVerticalText(vertical, [{ x: 50, y: 497, w: 40, h: 11 }])).toBe(false);
  });
});

/** pdf-lib, from the library package (the repository's PDF tool). */
const pdfLib = createRequire(new URL("../../../library/package.json", import.meta.url))("pdf-lib") as {
  PDFDocument: { create(): Promise<{ embedFont(f: string): Promise<unknown>; addPage(s: [number, number]): { drawText(t: string, o: object): void }; save(o: object): Promise<Uint8Array> }> };
  StandardFonts: { Courier: string };
};

describe("on real pages read by pdf.js", () => {
  let tasks: Array<ReturnType<typeof getDocument>> = [];
  const read = async (bytes: Uint8Array) => {
    const task = getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 });
    tasks.push(task);
    return (await (await task.promise).getPage(1)).getTextContent();
  };
  afterAll(async () => {
    for (const t of tasks) await t.destroy();
    tasks = [];
  });

  describe("the rotated, offset-crop fixture", () => {
    let text: TextContent;
    beforeAll(async () => {
      text = await read(new Uint8Array(await buildRotatedCropPdf()));
    });
    /** Helvetica advance widths (thousandths of an em) of the letters used. */
    const W: Record<string, number> = { " ": 278, P: 667, a: 556, s: 500, e: 556, n: 556, g: 556, r: 333, u: 556, d: 556, b: 556, o: 556, t: 278, T: 611, h: 556, f: 278, y: 500, i: 222, m: 833, l: 222, w: 722, v: 500, p: 556, ".": 278 };
    const helvetica = (s: string) => [...s].reduce((a, c) => a + (W[c] ?? 556), 0) * 0.012;

    it("the quoted words of a line and of two lines match", () => {
      const rect = { x: 100 + helvetica("Passengers "), y: 780 - 0.207 * 12, w: helvetica("argued about"), h: 0.925 * 12 };
      expect(quoteStillMatches("argued about", textUnderRects(text, [rect]))).toBe(true);
      const two = [
        { x: 100, y: 800 - 2.5, w: helvetica("The ferry timetable was rewritten every spring."), h: 11.1 },
        { x: 100, y: 780 - 2.5, w: helvetica("Passengers"), h: 11.1 },
      ];
      expect(quoteStillMatches("The ferry timetable was rewritten every spring. Passengers", textUnderRects(text, two))).toBe(true);
    });

    it("the same words moved to other lines are changed", () => {
      // "argued about it" is on the second line; its rectangle now lies over the first.
      const onFirstLine = { x: 100 + helvetica("The ferry "), y: 800 - 0.207 * 12, w: helvetica("timetable was"), h: 0.925 * 12 };
      expect(quoteStillMatches("argued about it", textUnderRects(text, [onFirstLine]))).toBe(false);
      // Different words: changed.
      expect(quoteStillMatches("the ferry ledger was burnt", textUnderRects(text, [onFirstLine]))).toBe(false);
    });
  });

  it("a typewriter-face line highlighted a word, two or three at a time is never changed", async () => {
    const doc = await pdfLib.PDFDocument.create();
    const font = await doc.embedFont(pdfLib.StandardFonts.Courier);
    const page = doc.addPage([595, 842]);
    const lines = ["Within the ledger, Mr W. Mills listed wool, iron and timber.", "Memo: illicit milling at Wimbledon, Mill Lane; W.M. informed."];
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 700 - i * 14, size: 11, font }));
    const text = await read(await doc.save({ useObjectStreams: false }));
    let judged = 0;
    lines.forEach((line, li) => {
      const words = line.split(" ");
      for (let n = 1; n <= 3; n++) {
        for (let w = 0; w + n <= words.length; w++) {
          const quote = words.slice(w, w + n).join(" ");
          const start = words.slice(0, w).join(" ").length + (w > 0 ? 1 : 0);
          // Courier: every glyph 0.6 of the size.
          const rect = { x: 72 + start * 6.6, y: 700 - li * 14 - 0.157 * 11, w: quote.length * 6.6, h: 0.786 * 11 };
          if (canJudge(quote)) judged++;
          expect(quoteStillMatches(quote, textUnderRects(text, [rect])), `"${quote}"`).toBe(true);
        }
      }
    });
    expect(judged).toBeGreaterThan(30);
  });
});
