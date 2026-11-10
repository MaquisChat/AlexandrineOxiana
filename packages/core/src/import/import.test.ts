import { describe, expect, it } from "vitest";
import { findIdentifiers } from "./identifiers.js";
import { parseFileName } from "./filename-patterns.js";
import { scoreConfidence } from "./confidence.js";
import { findDuplicate } from "./dedupe.js";

describe("findIdentifiers", () => {
  it("extracts DOIs, trims trailing punctuation, lowercases", () => {
    expect(findIdentifiers("see https://doi.org/10.1000/XYZ123).").dois).toEqual(["10.1000/xyz123"]);
    expect(findIdentifiers("a 10.1000/abc; b 10.1000/abc, c").dois).toEqual(["10.1000/abc"]);
  });
  it("normalises ISBN-10 and ISBN-13 to ISBN-13", () => {
    expect(findIdentifiers("0-306-40615-2").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN-13: 978-0-306-40615-7").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 978 0 306 40615 7").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 0306406152 and 9780306406157").isbns).toEqual(["9780306406157"]);
  });
  it("allows X check digit in ISBN-10", () => {
    expect(findIdentifiers("ISBN 0-8044-2957-X").isbns).toEqual(["9780804429573"]);
  });
  it("ignores invalid checksums and arbitrary digit runs", () => {
    expect(findIdentifiers("0-306-40615-3").isbns).toEqual([]);
    expect(findIdentifiers("9780306406158").isbns).toEqual([]);
    expect(findIdentifiers("12345678901234567890").isbns).toEqual([]);
  });
  it("finds arXiv ids, new and old style", () => {
    const r = findIdentifiers("arXiv:2401.12345v2 and hep-th/9901001");
    expect(r.arxiv).toEqual(["2401.12345v2", "hep-th/9901001"]);
  });
});

describe("parseFileName", () => {
  it("parses built-in patterns", () => {
    expect(parseFileName("Okafor - 2024 - Feeding the Feed.pdf")).toEqual({ creator: "Okafor", year: "2024", title: "Feeding the Feed" });
    expect(parseFileName("Okafor_2024_Feeding_the_Feed.pdf")).toEqual({ creator: "Okafor", year: "2024", title: "Feeding the Feed" });
    expect(parseFileName("Okafor (2024) Feeding the Feed.pdf")).toEqual({ creator: "Okafor", year: "2024", title: "Feeding the Feed" });
    expect(parseFileName("Okafor 2024 Feeding the Feed.pdf")).toEqual({ creator: "Okafor", year: "2024", title: "Feeding the Feed" });
  });
  it("returns null when nothing matches", () => {
    expect(parseFileName("scan0001.pdf")).toBeNull();
  });
  it("supports user patterns and skips invalid ones", () => {
    const patterns = [
      { id: "bad", regex: "([" },
      { id: "u", regex: "^(?<year>\\d{4})_(?<creator>[^_]+)_(?<title>.+)$" },
    ];
    expect(parseFileName("2024_Okafor_Feeding.pdf", patterns)).toEqual({ creator: "Okafor", year: "2024", title: "Feeding" });
  });
  it("caps user regex input and stays fast on pathological names", () => {
    const evil = "a".repeat(100_000) + "!";
    const t = Date.now();
    parseFileName(evil + ".pdf", [{ id: "x", regex: "^(a+)+$" }]);
    parseFileName(evil + ".pdf");
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("scoreConfidence", () => {
  it("scores each method", () => {
    expect(scoreConfidence({ method: "reference-metadata" })).toBe(0.9);
    expect(scoreConfidence({ method: "identifier+lookup" })).toBe(0.97);
    expect(scoreConfidence({ method: "sidecar" })).toBe(0.85);
    expect(scoreConfidence({ method: "embedded", hasTitle: true, hasCreator: true })).toBe(0.7);
    expect(scoreConfidence({ method: "embedded", hasTitle: true })).toBe(0.55);
    expect(scoreConfidence({ method: "filename" })).toBe(0.5);
    expect(scoreConfidence({ method: "none" })).toBe(0.2);
  });
  it("filename+lookup depends on similarity", () => {
    expect(scoreConfidence({ method: "filename+lookup", titleSimilarity: 0.95 })).toBe(0.785);
    expect(scoreConfidence({ method: "filename+lookup", titleSimilarity: 0.89 })).toBe(0.5);
    expect(scoreConfidence({ method: "filename+lookup" })).toBe(0.5);
  });
});

describe("findDuplicate", () => {
  const base = { sha256s: [] as string[] };
  it("same sha256 is certain same-file", () => {
    expect(findDuplicate({ sha256s: ["a"] }, [{ sourceId: "s1", sha256s: ["b", "a"] }])).toEqual({ sourceId: "s1", reason: "same-file", certainty: "certain" });
  });
  it("same doi (case-insensitive) and same isbn are certain", () => {
    expect(findDuplicate({ ...base, doi: "10.1/ABC" }, [{ sourceId: "s2", sha256s: [], doi: "10.1/abc" }])?.reason).toBe("same-doi");
    expect(findDuplicate({ ...base, isbns: ["9780306406157"] }, [{ sourceId: "s3", sha256s: [], isbns: ["9780306406157"] }])).toEqual({ sourceId: "s3", reason: "same-isbn", certainty: "certain" });
  });
  it("precedence: file > doi > isbn > fuzzy", () => {
    const cand = { sha256s: ["h"], doi: "10.1/x", isbns: ["9780306406157"] };
    const ex = [
      { sourceId: "isbn", sha256s: [], isbns: ["9780306406157"] },
      { sourceId: "doi", sha256s: [], doi: "10.1/x" },
      { sourceId: "file", sha256s: ["h"] },
    ];
    expect(findDuplicate(cand, ex)?.sourceId).toBe("file");
    expect(findDuplicate(cand, ex.slice(0, 2))?.sourceId).toBe("doi");
    expect(findDuplicate(cand, ex.slice(0, 1))?.sourceId).toBe("isbn");
  });
  it("fuzzy match is likely", () => {
    const r = findDuplicate(
      { sha256s: ["x"], title: "Feeding the Feed: Food Media", firstCreatorFamily: "Okafor", year: "2024" },
      [{ sourceId: "f", sha256s: ["y"], title: "Feeding the feed – food media", firstCreatorFamily: "OKAFOR", year: "2025" }],
    );
    expect(r).toEqual({ sourceId: "f", reason: "fuzzy", certainty: "likely" });
  });
  it("fuzzy requires family, year proximity and similarity", () => {
    const c = { sha256s: [], title: "Feeding the Feed", firstCreatorFamily: "Okafor", year: "2024" };
    expect(findDuplicate(c, [{ sourceId: "a", sha256s: [], title: "Feeding the Feed", firstCreatorFamily: "Smith", year: "2024" }])).toBeNull();
    expect(findDuplicate(c, [{ sourceId: "a", sha256s: [], title: "Feeding the Feed", firstCreatorFamily: "Okafor", year: "2020" }])).toBeNull();
    expect(findDuplicate(c, [{ sourceId: "a", sha256s: [], title: "Something else entirely", firstCreatorFamily: "Okafor", year: "2024" }])).toBeNull();
  });
  it("normalises family names with diacritics", () => {
    const r = findDuplicate(
      { sha256s: [], title: "A Title", firstCreatorFamily: "Ökafor", year: "2024" },
      [{ sourceId: "a", sha256s: [], title: "A Title", firstCreatorFamily: "okafor", year: "2024" }],
    );
    expect(r?.reason).toBe("fuzzy");
  });
});
