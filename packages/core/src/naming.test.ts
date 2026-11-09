import { describe, expect, it } from "vitest";
import {
  defaultTemplates,
  derivedFileName,
  encName,
  originalFileName,
  pseudonymize,
  sanitizeSegment,
  sourceFolderName,
  withCollisionSuffix,
} from "./naming.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("sourceFolderName", () => {
  it("formats year, creator, title and short id", () => {
    expect(
      sourceFolderName({
        dateOrYear: "2025",
        primaryCreator: "Smith",
        shortTitle: "Title of Article",
        shortId: "a1b2",
      }),
    ).toBe("2025 Smith - Title of Article [a1b2]");
  });

  it("omits a missing date", () => {
    expect(sourceFolderName({ primaryCreator: "Smith", shortTitle: "T", shortId: "a1b2" })).toBe(
      "Smith - T [a1b2]",
    );
  });

  it("uses Unknown for a missing creator", () => {
    expect(sourceFolderName({ dateOrYear: "2025", shortTitle: "T", shortId: "a1b2" })).toBe(
      "2025 Unknown - T [a1b2]",
    );
  });

  it("sanitizes illegal characters in each part", () => {
    expect(
      sourceFolderName({ dateOrYear: "2025", primaryCreator: "A/B", shortTitle: "What?", shortId: "a1b2" }),
    ).toBe("2025 A-B - What- [a1b2]");
  });

  it("honours a custom template", () => {
    expect(
      sourceFolderName(
        { dateOrYear: "2025", primaryCreator: "Smith", shortTitle: "T", shortId: "a1b2" },
        { ...defaultTemplates, sourceFolder: "[{id}] {title}" },
      ),
    ).toBe("[a1b2] T");
  });
});

describe("originalFileName", () => {
  it("drops the [id] suffix and appends the extension", () => {
    expect(originalFileName("2025 Smith - Title [a1b2]", "pdf")).toBe("2025 Smith - Title.pdf");
  });

  it("leaves names without an id intact", () => {
    expect(originalFileName("Plain name", "pdf")).toBe("Plain name.pdf");
  });
});

describe("derivedFileName", () => {
  const base = {
    sourceName: "2026-03-14 P-014 - Reel - Receta",
    kind: "transcript",
    lang: "es",
    tool: "whisper-large-v3",
    modified: new Date("2026-11-09T20:02:00Z"),
    ext: "vtt",
    tz: "UTC",
  };

  it("formats all parts with the modified date", () => {
    expect(derivedFileName(base)).toBe(
      "2026-03-14 P-014 - Reel - Receta - transcript - es - whisper-large-v3 - modified 2026-11-09 2002.vtt",
    );
  });

  it("formats the date in the given time zone", () => {
    expect(derivedFileName({ ...base, tz: "Asia/Tokyo" })).toContain("modified 2026-11-10 0502.vtt");
  });

  it("formats midnight as 0000", () => {
    expect(derivedFileName({ ...base, modified: new Date("2026-11-09T00:05:00Z") })).toContain(
      "modified 2026-11-09 0005.vtt",
    );
  });

  it("omits language when absent", () => {
    expect(derivedFileName({ ...base, lang: undefined })).toBe(
      "2026-03-14 P-014 - Reel - Receta - transcript - whisper-large-v3 - modified 2026-11-09 2002.vtt",
    );
  });

  it("accepts a language pair", () => {
    expect(derivedFileName({ ...base, lang: "es-to-en" })).toContain(" - es-to-en - ");
  });

  it("sanitizes the tool", () => {
    expect(derivedFileName({ ...base, tool: "a/b:c" })).toContain(" - a-b-c - ");
  });

  it("matches the spec example for ocr", () => {
    expect(
      derivedFileName({ ...base, sourceName: "Base", kind: "ocr", lang: "en", tool: "tesseract-5", ext: "txt" }),
    ).toBe("Base - ocr - en - tesseract-5 - modified 2026-11-09 2002.txt");
  });

  it("keeps the whole name within 255 bytes", () => {
    const name = derivedFileName({ ...base, sourceName: "x".repeat(400) });
    expect(bytes(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith("modified 2026-11-09 2002.vtt")).toBe(true);
  });
});

describe("sanitizeSegment", () => {
  it("preserves Arabic unchanged", () => {
    expect(sanitizeSegment("الطبخ في البيت")).toBe("الطبخ في البيت");
  });

  it("preserves Japanese unchanged", () => {
    expect(sanitizeSegment("家庭料理の記憶")).toBe("家庭料理の記憶");
  });

  it("normalizes NFD to NFC", () => {
    expect(sanitizeSegment("Café")).toBe("Café");
  });

  it("prefixes Windows reserved names", () => {
    expect(sanitizeSegment("CON")).toBe("_CON");
    expect(sanitizeSegment("com1")).toBe("_com1");
    expect(sanitizeSegment("NUL.txt")).toBe("_NUL.txt");
    expect(sanitizeSegment("CONSOLE")).toBe("CONSOLE");
  });

  it("replaces illegal characters", () => {
    expect(sanitizeSegment("a:b?c")).toBe("a-b-c");
    expect(sanitizeSegment('<>:"/\\|?*')).toBe("---------");
  });

  it("replaces control characters", () => {
    expect(sanitizeSegment("a\u0000b\u0085c\u007fd")).toBe("a-b-c-d");
  });

  it("collapses whitespace", () => {
    expect(sanitizeSegment("a   b\t\nc")).toBe("a b c");
  });

  it("strips trailing dots and spaces", () => {
    expect(sanitizeSegment("title. ")).toBe("title");
    expect(sanitizeSegment("title...")).toBe("title");
  });

  it("truncates long titles to 150 bytes with an ellipsis, on a grapheme boundary", () => {
    const out = sanitizeSegment("👩‍🔬".repeat(300));
    expect(bytes(out)).toBeLessThanOrEqual(150);
    expect(out.endsWith("…")).toBe(true);
    const body = out.slice(0, -1);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toBe("👩‍🔬".repeat(body.length / "👩‍🔬".length));
  });

  it("truncates a 300-character ASCII title", () => {
    const out = sanitizeSegment("a".repeat(300));
    expect(bytes(out)).toBeLessThanOrEqual(150);
    expect(out.endsWith("…")).toBe(true);
  });

  it("respects a custom maxBytes including the ellipsis", () => {
    const out = sanitizeSegment("日本語のタイトルです", 13);
    expect(bytes(out)).toBeLessThanOrEqual(13);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not truncate text that fits", () => {
    expect(sanitizeSegment("a".repeat(150))).toBe("a".repeat(150));
  });
});

describe("withCollisionSuffix", () => {
  it("appends (2) before the extension", () => {
    expect(withCollisionSuffix("x.vtt", (n) => n === "x.vtt")).toBe("x (2).vtt");
  });

  it("counts up past existing suffixes", () => {
    const taken = new Set(["x.vtt", "x (2).vtt"]);
    expect(withCollisionSuffix("x.vtt", (n) => taken.has(n))).toBe("x (3).vtt");
  });

  it("returns the name unchanged when free", () => {
    expect(withCollisionSuffix("x.vtt", () => false)).toBe("x.vtt");
  });

  it("handles names without an extension", () => {
    expect(withCollisionSuffix("x", (n) => n === "x")).toBe("x (2)");
  });

  it("puts the suffix before the extension of .enc names", () => {
    expect(withCollisionSuffix("x.vtt.enc", (n) => n === "x.vtt.enc")).toBe("x (2).vtt.enc");
  });
});

describe("pseudonymize", () => {
  it("replaces a handle token", () => {
    expect(pseudonymize("2026-03-14 @maria.cocina - Reel", new Map([["@maria.cocina", "P-014"]]))).toBe(
      "2026-03-14 P-014 - Reel",
    );
  });

  it("does not match inside a longer handle", () => {
    const map = new Map([["@maria.cocina", "P-014"]]);
    expect(pseudonymize("@maria.cocinas - Reel", map)).toBe("@maria.cocinas - Reel");
    expect(pseudonymize("x@maria.cocina", map)).toBe("x@maria.cocina");
  });

  it("is case-insensitive for handles", () => {
    expect(pseudonymize("@Maria.Cocina", new Map([["@maria.cocina", "P-014"]]))).toBe("P-014");
  });

  it("replaces every occurrence and several handles", () => {
    const map = new Map([
      ["@a", "P-001"],
      ["@ab", "P-002"],
    ]);
    expect(pseudonymize("@a and @ab and @a.", map)).toBe("P-001 and P-002 and P-001.");
  });

  it("returns text unchanged for an empty map", () => {
    expect(pseudonymize("@a", new Map())).toBe("@a");
  });
});

describe("encName", () => {
  it("appends .enc", () => {
    expect(encName("x.vtt")).toBe("x.vtt.enc");
  });
});

describe("255-byte limit on final on-disk names", () => {
  const long = {
    sourceName: "字".repeat(300),
    kind: "caption",
    lang: "es-to-en",
    tool: "whisper-large-v3",
    modified: new Date("2026-11-09T20:02:00Z"),
    ext: "vtt",
    tz: "UTC",
  };

  it("survives .enc and collision suffixes", () => {
    const name = derivedFileName(long);
    const enc = encName(name);
    expect(bytes(name)).toBeLessThanOrEqual(246);
    expect(bytes(enc)).toBeLessThanOrEqual(255);
    for (const taken of [new Set([enc]), new Set([enc, withCollisionSuffix(enc, (n) => n === enc)])]) {
      const out = withCollisionSuffix(enc, (n) => taken.has(n));
      expect(bytes(out)).toBeLessThanOrEqual(255);
      expect(out.endsWith(".vtt.enc")).toBe(true);
    }
    const many = new Set([enc]);
    for (let i = 2; i < 10; i++) many.add(withCollisionSuffix(enc, (n) => many.has(n)));
    const ten = withCollisionSuffix(enc, (n) => many.has(n));
    expect(ten).toContain(" (10).vtt.enc");
    expect(bytes(ten)).toBeLessThanOrEqual(255);
  });

  it("encName and withCollisionSuffix re-shrink arbitrary over-long names", () => {
    const raw = `${"x".repeat(251)}.vtt`;
    expect(bytes(encName(raw))).toBeLessThanOrEqual(255);
    expect(encName(raw).endsWith(".vtt.enc")).toBe(true);
    expect(bytes(withCollisionSuffix(raw, (n) => n === raw))).toBeLessThanOrEqual(255);
  });

  it("keeps original file names within the reserved budget", () => {
    expect(bytes(originalFileName(`${"字".repeat(300)} [a1b2]`, "pdf"))).toBeLessThanOrEqual(246);
  });
});

describe("withCollisionSuffix extensions", () => {
  it("treats .tar.gz as one extension", () => {
    expect(withCollisionSuffix("a.tar.gz", (n) => n === "a.tar.gz")).toBe("a (2).tar.gz");
    expect(withCollisionSuffix("a.tar.xz.enc", (n) => n === "a.tar.xz.enc")).toBe("a (2).tar.xz.enc");
  });

  it("does not split folder names when isFile is false", () => {
    expect(withCollisionSuffix("Report v2.0", (n) => n === "Report v2.0", { isFile: false })).toBe(
      "Report v2.0 (2)",
    );
  });

  it("treats up to 10 alphanumerics as an extension, more is not", () => {
    expect(withCollisionSuffix("a.markdown", (n) => n === "a.markdown")).toBe("a (2).markdown");
    expect(withCollisionSuffix("x.webarchive.enc", (n) => n === "x.webarchive.enc")).toBe(
      "x (2).webarchive.enc",
    );
    expect(withCollisionSuffix("a.tenletters", (n) => n === "a.tenletters")).toBe("a (2).tenletters");
    expect(withCollisionSuffix("a.elevenchars", (n) => n === "a.elevenchars")).toBe("a.elevenchars (2)");
  });
});

describe("template substitution", () => {
  it("does not rewrite placeholders inside substituted values", () => {
    expect(sourceFolderName({ shortTitle: "About {id} and {creator}", shortId: "a1b2" })).toBe(
      "Unknown - About {id} and {creator} [a1b2]",
    );
  });
});

describe("pseudonymize fails closed", () => {
  it("matches NFD text against NFC keys", () => {
    expect(pseudonymize("x @jose\u0301 y", new Map([["@jos\u00e9", "P-001"]]))).toBe("x P-001 y");
    expect(pseudonymize("x @jos\u00e9 y", new Map([["@jose\u0301", "P-001"]]))).toBe("x P-001 y");
  });

  it("does not match a handle followed by a combining mark", () => {
    expect(pseudonymize("@jose\u0301", new Map([["@jose", "P-001"]]))).toBe("@jos\u00e9");
  });

  it("ignores empty keys", () => {
    expect(pseudonymize("abc @a", new Map([["", "X"], ["@a", "P-1"]]))).toBe("abc P-1");
    expect(pseudonymize("abc", new Map([["", "X"]]))).toBe("abc");
  });

  it("replaces handles that only match through regex case folding", () => {
    // U+017F (long s) folds to "s" under /iu but toLowerCase() leaves it unchanged.
    expect(pseudonymize("@maſ", new Map([["@mas", "P-9"]]))).toBe("P-9");
  });
});

describe("sanitizeSegment bidi controls", () => {
  it("strips overrides and isolates but keeps LRM/RLM", () => {
    expect(sanitizeSegment("a‮b⁦c⁩d‪e")).toBe("abcde");
    expect(sanitizeSegment("a‎b‏c")).toBe("a‎b‏c");
  });
});

describe("originalFileName hardening", () => {
  it("prefixes reserved stems", () => {
    expect(originalFileName("CON [a1b2]", "pdf")).toBe("_CON.pdf");
  });

  it("sanitizes the extension", () => {
    expect(originalFileName("A [a1b2]", ".p/df")).toBe("A.p-df");
  });
});
