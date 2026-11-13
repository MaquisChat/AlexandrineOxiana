import { describe, expect, it } from "vitest";
import type { Annotation } from "../model/annotation.js";
import type { Anchor } from "../model/anchor.js";
import {
  HIGHLIGHT_COLOURS,
  HIGHLIGHT_COLOUR_LABELS,
  ZOTERO_REFERENCE_COLOURS,
  highlightColourOf,
  nearestHighlightColour,
} from "./highlightColours.js";
import { annotationSortKey, derivedSortIndex, pdfSortIndex } from "./sortIndex.js";
import { matchAnnotations } from "./match.js";

type PdfAnchor = Extract<Anchor, { kind: "pdf" }>;
const pdf = (over: Partial<PdfAnchor> = {}): PdfAnchor => ({
  id: "a1",
  kind: "pdf",
  assetId: "s1",
  page: 3,
  rects: [{ x: 10, y: 700, w: 50, h: 12 }],
  ...over,
});
const ann = (over: Partial<Annotation> = {}): Annotation => ({
  id: "n1",
  sourceId: "s1",
  kind: "highlight",
  anchors: [pdf()],
  author: "me",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("highlight colours", () => {
  it("every Zotero reference colour maps to its own name", () => {
    expect(HIGHLIGHT_COLOURS).toEqual(["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"]);
    for (const name of HIGHLIGHT_COLOURS) {
      expect(nearestHighlightColour(ZOTERO_REFERENCE_COLOURS[name]), name).toBe(name);
      expect(HIGHLIGHT_COLOUR_LABELS[name]).toBe(name[0]!.toUpperCase() + name.slice(1));
    }
    expect(ZOTERO_REFERENCE_COLOURS.yellow).toBe("#ffd400");
    expect(nearestHighlightColour("#FFD400")).toBe("yellow");
    expect(nearestHighlightColour("#fd0")).toBe("yellow");
    expect(nearestHighlightColour("#ffd400cc")).toBe("yellow");
  });

  it("#ffd500 maps to yellow and #000000 to grey", () => {
    expect(nearestHighlightColour("#ffd500")).toBe("yellow");
    expect(nearestHighlightColour("#000000")).toBe("grey");
    expect(nearestHighlightColour("#ffffff")).toBe("grey");
  });

  it("an invalid colour maps to yellow", () => {
    for (const bad of ["", "red", "#12", "#gggggg", "ffd400", "#ffd4000", "#ff", "rgb(0,0,0)"]) {
      expect(nearestHighlightColour(bad), bad).toBe("yellow");
    }
  });

  it("colorName wins over the imported color", () => {
    expect(highlightColourOf({ colorName: "blue", color: "#ff6666" })).toBe("blue");
    expect(highlightColourOf({ color: "#ff6666" })).toBe("red");
    expect(highlightColourOf({})).toBe("yellow");
    const a = { color: "#5fb236" };
    highlightColourOf(a);
    expect(a).toEqual({ color: "#5fb236" });
  });

  it("is deterministic", () => {
    expect(nearestHighlightColour("#c8a0a0")).toBe(nearestHighlightColour("#c8a0a0"));
  });
});

describe("sort index", () => {
  it("formats and clamps to its digits", () => {
    expect(pdfSortIndex(0, 0, 0)).toBe("00000|000000|00000");
    expect(pdfSortIndex(2, 15, 123.9)).toBe("00002|000015|00123");
    expect(pdfSortIndex(100_000, 9_999_999, -5)).toBe("99999|999999|00000");
    expect(pdfSortIndex(-1, Number.NaN, 1e9)).toBe("00000|000000|99999");
    for (const s of [pdfSortIndex(100_000, 1e12, -1e9), pdfSortIndex(-4, -4, Infinity)]) {
      expect(s).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
    }
  });

  it("derived sort index orders a higher rect first", () => {
    const high = pdf({ rects: [{ x: 0, y: 700, w: 5, h: 10 }, { x: 0, y: 100, w: 5, h: 10 }] });
    const low = pdf({ rects: [{ x: 0, y: 200, w: 5, h: 10 }] });
    expect(derivedSortIndex(high)).toBe(pdfSortIndex(2, 0, 100000 - 710));
    expect(derivedSortIndex(high) < derivedSortIndex(low)).toBe(true);
    const neg = pdf({ rects: [{ x: 0, y: -500000, w: 5, h: 10 }] });
    expect(derivedSortIndex(neg)).toMatch(/^00002\|000000\|\d{5}$/);
    expect(derivedSortIndex(pdf({ page: 100_001 }))).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
  });

  it("stored sort index wins over the derived one", () => {
    const stored = pdf({ sortIndex: "00002|001234|00456" });
    expect(derivedSortIndex(stored)).toBe("00002|001234|00456");
    const a = ann({ anchors: [stored], id: "zz" });
    expect(annotationSortKey(a).startsWith("00002|001234|00456")).toBe(true);
    const b = ann({ anchors: [pdf({ sortIndex: "00002|001234|00456" })], id: "aa", createdAt: "2026-02-01T00:00:00.000Z" });
    expect(annotationSortKey(a) < annotationSortKey(b)).toBe(true); // createdAt before id
    const c = ann({ anchors: [pdf({ sortIndex: "00002|001234|00456" })], id: "aa" });
    expect(annotationSortKey(c) < annotationSortKey(a)).toBe(true); // then id
  });

  it("an annotation with no pdf anchor sorts after the pdf ones", () => {
    const note = ann({ anchors: [] });
    expect(annotationSortKey(note) > annotationSortKey(ann({ anchors: [pdf({ sortIndex: "99999|999999|99999" })] }))).toBe(true);
  });
});

describe("matchAnnotations", () => {
  const list = [
    { id: "1", quote: "The Café Society of Vienna", body: undefined },
    { id: "2", quote: "Another passage", body: "cafe notes on society" },
    { id: "3", quote: "Nothing here", body: undefined },
    { id: "4", quote: "社会资本理论", body: undefined },
  ];
  it("needs every word, folds accents, finds CJK by substring", () => {
    expect(matchAnnotations(list, "cafe society")).toEqual(["1", "2"]);
    expect(matchAnnotations(list, "CAFÉ vienna")).toEqual(["1"]);
    expect(matchAnnotations(list, "cafe missing")).toEqual([]);
    expect(matchAnnotations(list, "资本")).toEqual(["4"]);
    expect(matchAnnotations(list, "")).toEqual([]);
    expect(matchAnnotations(list, "   ")).toEqual([]);
    expect(matchAnnotations([{ id: "x", quote: "a ﬁnding" }], "finding")).toEqual(["x"]);
  });
});
