import { describe, expect, it } from "vitest";
import type { Annotation } from "../model/annotation.js";
import type { PdfAnchor } from "../model/anchor.js";
import {
  HIGHLIGHT_COLOURS,
  HIGHLIGHT_COLOUR_LABELS,
  ZOTERO_REFERENCE_COLOURS,
  ciede2000,
  highlightColourOf,
  nearestHighlightColour,
} from "./highlightColours.js";
import { SORT_INDEX_PATTERN, pdfSortIndex, sortAnnotations } from "./sortIndex.js";
import { matchAnnotations } from "./match.js";
import { cjkRuns, latinWords } from "./words.js";

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

  it("is CIEDE2000 (Sharma, Wu and Dalal's reference pairs)", () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
    expect(ciede2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 3);
  });

  it("a near-neutral value is grey and a clearly tinted one is not", () => {
    expect(nearestHighlightColour("#9a9090")).toBe("grey");
    expect(nearestHighlightColour("#a05050")).not.toBe("grey");
    expect(nearestHighlightColour("#f00f")).toBe("red"); // #rgba
  });

  it("a colorName that is not a known name is ignored", () => {
    expect(highlightColourOf({ colorName: "teal" as never, color: "#ff6666" })).toBe("red");
  });
});

describe("sort index", () => {
  it("formats and clamps to its digits", () => {
    expect(pdfSortIndex(0, 0, 0)).toBe("00000|000000|00000");
    expect(pdfSortIndex(2, 15, 123.9)).toBe("00002|000015|00123");
    expect(pdfSortIndex(100_000, 9_999_999, -5)).toBe("99999|999999|00000");
    expect(pdfSortIndex(-1, Number.NaN, 1e9)).toBe("00000|000000|99999");
    for (const s of [pdfSortIndex(100_000, 1e12, -1e9), pdfSortIndex(-4, -4, Infinity)]) {
      expect(s).toMatch(SORT_INDEX_PATTERN);
    }
  });
});

describe("sortAnnotations", () => {
  const at = (id: string, page: number, y: number, x = 10, extra: Partial<PdfAnchor> = {}, over: Partial<Annotation> = {}) =>
    ann({ id, anchors: [pdf({ page, rects: [{ x, y, w: 40, h: 10 }], ...extra })], ...over });
  const ids = (l: Annotation[]) => sortAnnotations(l).map((a) => a.id);

  it("orders by page, then by stored sort index when every annotation of the page has one", () => {
    const l = [
      at("c", 2, 100, 10, { sortIndex: "00001|000900|00700" }),
      at("a", 2, 100, 10, { sortIndex: "00001|000010|00050" }),
      at("p1", 1, 10),
      at("b", 2, 700, 10, { sortIndex: "00001|000500|00100" }),
    ];
    expect(ids(l)).toEqual(["p1", "a", "b", "c"]);
  });

  it("a page where any annotation lacks a stored index is ordered geometrically, never mixed", () => {
    const l = [
      at("imported-bottom", 3, 100, 10, { sortIndex: "00002|003500|00700" }),
      at("new-bottom", 3, 150),
      at("imported-top", 3, 700, 10, { sortIndex: "00002|000010|00050" }),
      at("new-top", 3, 600),
    ];
    expect(ids(l)).toEqual(["imported-top", "new-top", "new-bottom", "imported-bottom"]);
  });

  it("geometric order is top to bottom, then left to right, then createdAt, then id", () => {
    const l = [
      at("right", 1, 500, 300),
      at("left", 1, 500, 20),
      at("high", 1, 600, 400),
      at("t2", 1, 100, 20, {}, { createdAt: "2026-01-01T00:00:00.500Z" }),
      at("t1", 1, 100, 20, {}, { createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(ids(l)).toEqual(["high", "left", "right", "t1", "t2"]);
    expect(ids([at("b", 1, 5), at("a", 1, 5)])).toEqual(["a", "b"]);
  });

  it("uses the anchor on the earliest page, and puts annotations with no pdf anchor last", () => {
    const two = ann({ id: "two", anchors: [pdf({ id: "x", page: 9 }), pdf({ id: "y", page: 2 })] });
    const note = ann({ id: "aaa", anchors: [] });
    expect(ids([note, at("p5", 5, 10), two, at("p3", 3, 10)])).toEqual(["two", "p3", "p5", "aaa"]);
  });

  it("does not change its input and survives a huge rectangle list", () => {
    const l = [at("b", 1, 5), at("a", 1, 50)];
    sortAnnotations(l);
    expect(l.map((a) => a.id)).toEqual(["b", "a"]);
    const rects = Array.from({ length: 400_000 }, (_, i) => ({ x: 0, y: i % 700, w: 1, h: 1 }));
    expect(ids([ann({ id: "big", anchors: [pdf({ rects })] }), at("a", 1, 5)])).toHaveLength(2);
  });
});

describe("search words (shared with the index)", () => {
  it("splits CJK runs from words and drops punctuation", () => {
    expect(cjkRuns("사회자본 and 料理の")).toEqual(["사회자본", "料理の"]);
    expect(latinWords("Bourdieu's post-colonial U.S. \"capital\" 料理")).toEqual(["Bourdieu", "s", "post", "colonial", "U", "S", "capital"]);
  });
});

describe("matchAnnotations", () => {
  const one = (quote: string, query: string) => matchAnnotations([{ id: "x", quote }], query).length === 1;
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
    expect(matchAnnotations(list, "...")).toEqual([]);
    expect(matchAnnotations([{ id: "x", quote: "a ﬁnding" }], "finding")).toEqual(["x"]);
  });

  it("punctuation separates words, as in the index", () => {
    expect(one("Bourdieu's theory of capital", "Bourdieu's")).toBe(true);
    expect(one("a post-colonial reading", "post-colonial")).toBe(true);
    expect(one("made in the U.S. in 1990", "U.S.")).toBe(true);
    expect(one("economic capital, social capital", "capital,")).toBe(true);
    expect(one("the idea of social capital is old", '"social capital"')).toBe(true);
    expect(one("the idea of social capital is old", '"capital social"')).toBe(true); // words ANDed, as the index does
    expect(one("the idea of capital", "social capital")).toBe(false);
  });

  it("a query word matches the beginning of a word, as the index does", () => {
    expect(one("economic development", "develop")).toBe(true);
    expect(one("economic development", "ment")).toBe(false);
  });

  it("matches Korean and Japanese as the index does", () => {
    expect(one("사회자본이론은 중요하다", "사회자본")).toBe(true);
    expect(one("사회자본이론은 중요하다", "자본이론")).toBe(true);
    expect(one("사회자본이론은 중요하다", "자본학")).toBe(false);
    expect(one("ガスの料理", "が")).toBe(false);
    expect(one("ガスの料理", "カス")).toBe(false);
    expect(one("ガスの料理", "ガス")).toBe(true);
    expect(one("かな", "が")).toBe(false);
  });

  it("folds case fully, ignores invisible characters and joins a hyphenated line break", () => {
    expect(one("Die Straße", "STRASSE")).toBe(true);
    expect(one("develop\u00adment", "development")).toBe(true);
    expect(one("develop\u200bment", "development")).toBe(true);
    expect(one("they develop-\nment here", "development")).toBe(true);
    expect(one("\u200fcapital", "capital")).toBe(true);
  });
});
