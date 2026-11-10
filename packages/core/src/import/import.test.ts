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
    expect(findIdentifiers("ISBN 0-306-40615-2").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("isbn: 0306406152").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN-10 0306406152").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("978-0-306-40615-7").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN-13: 978-0-306-40615-7").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 978 0 306 40615 7").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 0306406152 and 9780306406157").isbns).toEqual(["9780306406157"]);
  });
  it("allows X check digit in ISBN-10", () => {
    expect(findIdentifiers("ISBN 0-8044-2957-X").isbns).toEqual(["9780804429573"]);
  });
  it("ignores unlabelled ISBN-10, phone-like numbers, ISMN and wrong labels", () => {
    expect(findIdentifiers("0-306-40615-2").isbns).toEqual([]);
    expect(findIdentifiers("Tel 555-123-4002").isbns).toEqual([]);
    expect(findIdentifiers("ISMN 9790000000018").isbns).toEqual([]);
    expect(findIdentifiers("9791000000015").isbns).toEqual(["9791000000015"]);
    expect(findIdentifiers("ISBN\n\n0306406152").isbns).toEqual([]);
    expect(findIdentifiers("ISBN " + " ".repeat(30) + "0306406152").isbns).toEqual([]);
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
  it("finds arXiv ids in URLs and prefixes", () => {
    expect(findIdentifiers("https://arxiv.org/abs/2401.12345v2").arxiv).toEqual(["2401.12345v2"]);
    expect(findIdentifiers("https://arxiv.org/pdf/2401.12345.pdf").arxiv).toEqual(["2401.12345"]);
    expect(findIdentifiers("arXiv:1406.1234").arxiv).toEqual(["1406.1234"]);
    expect(findIdentifiers("10.48550/arXiv.2401.12345").arxiv).toEqual(["2401.12345"]);
    expect(findIdentifiers("https://arxiv.org/abs/hep-th/9901001").arxiv).toEqual(["hep-th/9901001"]);
    expect(findIdentifiers("arXiv:math.GT/0309136").arxiv).toEqual(["math.GT/0309136"]);
  });
  it("keeps full old-style subject classes and versions", () => {
    expect(findIdentifiers("cond-mat.str-el/0101001").arxiv).toEqual(["cond-mat.str-el/0101001"]);
    expect(findIdentifiers("arXiv:physics.optics/0101001").arxiv).toEqual(["physics.optics/0101001"]);
    expect(findIdentifiers("cond-mat.stat-mech/0101001v2").arxiv).toEqual(["cond-mat.stat-mech/0101001v2"]);
    expect(findIdentifiers("math/0703001").arxiv).toEqual(["math/0703001"]);
    expect(findIdentifiers("math/0712001").arxiv).toEqual([]);
  });
  it("accepts space-separated ISBN-10/13 labels and nearest-label reach", () => {
    expect(findIdentifiers("ISBN 13 9780306406157").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 10 0306406152").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 0-306-40615-2 Tel 555-123-4002").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 0306406152 (pbk.), 9780306406157 (ebk.)").isbns).toEqual(["9780306406157"]);
    expect(findIdentifiers("ISBN 0306406152 (pbk.), 0-8044-2957-X (ebk.)").isbns).toEqual(["9780306406157", "9780804429573"]);
  });
  it("validates arXiv YYMM and suffix length", () => {
    for (const bad of ["2024.12345", "2413.12345", "1999.9999", "3141.59265", "1501.1234", "1412.12345", "2401.1234"])
      expect(findIdentifiers(bad).arxiv).toEqual([]);
    expect(findIdentifiers("1412.1234 and 1501.12345").arxiv).toEqual(["1412.1234", "1501.12345"]);
  });
  it("keeps balanced parentheses in DOIs", () => {
    expect(findIdentifiers("10.1000/abc(1)").dois).toEqual(["10.1000/abc(1)"]);
    expect(findIdentifiers("(see 10.1000/abc(1)).").dois).toEqual(["10.1000/abc(1)"]);
    expect(findIdentifiers("[10.1000/abc]").dois).toEqual(["10.1000/abc"]);
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
  it("caps the name given to user patterns at 255 characters (this is NOT ReDoS protection)", () => {
    const long = "x".repeat(300);
    const r = parseFileName(long + ".pdf", [{ id: "all", regex: "^(?<title>.*)$" }]);
    expect(r?.title).toHaveLength(255);
  });
  it("allows hyphens in the creator and trims leading separators from titles", () => {
    expect(parseFileName("Smith-Jones - 2024 - Title.pdf")).toEqual({ creator: "Smith-Jones", year: "2024", title: "Title" });
    expect(parseFileName("Okafor 2024 - Title.pdf")).toEqual({ creator: "Okafor", year: "2024", title: "Title" });
    expect(parseFileName("Okafor 2024 _–Title.pdf")?.title).toBe("Title");
    expect(parseFileName("Okafor 2024 —Title.pdf")?.title).toBe("Title");
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
  it("clamps similarity", () => {
    expect(scoreConfidence({ method: "filename+lookup", titleSimilarity: 5 })).toBe(0.8);
    expect(scoreConfidence({ method: "filename+lookup", titleSimilarity: -1 })).toBe(0.5);
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
  it("canonicalises ISBNs and DOIs and lowercases hashes", () => {
    expect(findDuplicate({ sha256s: ["ABC"] }, [{ sourceId: "h", sha256s: ["abc"] }])?.reason).toBe("same-file");
    expect(findDuplicate({ sha256s: [""] }, [{ sourceId: "e", sha256s: [""] }])).toBeNull();
    expect(findDuplicate({ sha256s: [], isbns: ["0-306-40615-2"] }, [{ sourceId: "i", sha256s: [], isbns: ["978-0-306-40615-7"] }])?.reason).toBe("same-isbn");
    expect(findDuplicate({ sha256s: [], doi: "https://doi.org/10.1/ABC" }, [{ sourceId: "d", sha256s: [], doi: "doi:10.1/abc" }])?.reason).toBe("same-doi");
    expect(findDuplicate({ sha256s: [], doi: "http://dx.doi.org/10.1/abc" }, [{ sourceId: "d", sha256s: [], doi: "10.1/abc" }])?.reason).toBe("same-doi");
  });
  it("canonicalises more DOI URL forms", () => {
    for (const d of ["https://www.doi.org/10.1/ABC", "doi.org/10.1/abc", "dx.doi.org/10.1/abc", "DOI 10.1/abc", "DOI: 10.1/abc"])
      expect(findDuplicate({ sha256s: [], doi: d }, [{ sourceId: "d", sha256s: [], doi: "10.1/abc" }])?.reason).toBe("same-doi");
  });
  it("vetoes fuzzy matches on conflicting DOIs or ISBNs; year uses first four digits", () => {
    const t = { title: "Feeding the Feed", firstCreatorFamily: "Okafor" };
    expect(findDuplicate({ sha256s: [], ...t, year: "2024-03", doi: "10.1/a" }, [{ sourceId: "x", sha256s: [], ...t, year: "2024", doi: "10.1/b" }])).toBeNull();
    expect(findDuplicate({ sha256s: [], ...t, year: "2024", isbns: ["9780306406157"] }, [{ sourceId: "x", sha256s: [], ...t, year: "2024", isbns: ["9780804429573"] }])).toBeNull();
    expect(findDuplicate({ sha256s: [], ...t, year: "2024-03" }, [{ sourceId: "x", sha256s: [], ...t, year: "2024", doi: "10.1/b" }])?.reason).toBe("fuzzy");
  });
});
