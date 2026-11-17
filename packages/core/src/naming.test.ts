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
    // The participant-name rule (R378 a): "x" is a word of its own, so the handle after it is replaced.
    expect(pseudonymize("x@maria.cocina", map)).toBe("xP-014");
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

  it("folds accents: a handle written with a combining mark is the same handle (R378 a)", () => {
    expect(pseudonymize("@jose\u0301", new Map([["@jose", "P-001"]]))).toBe("P-001");
    expect(pseudonymize("@jose\u0301s", new Map([["@jose", "P-001"]]))).toBe("@jos\u00e9s");
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

describe("datedFileName", () => {
  it("names a dated file '<stem> - modified <YYYY-MM-DD HHmm>.<ext>' in the given time zone", async () => {
    const { datedFileName } = await import("./naming.js");
    const at = new Date("2026-11-10T09:05:00.000Z");
    expect(datedFileName("profile-snapshot", at, "json", "UTC")).toBe("profile-snapshot - modified 2026-11-10 0905.json");
    expect(datedFileName("capture", at, "md", "Asia/Tokyo")).toBe("capture - modified 2026-11-10 1805.md");
    expect(datedFileName("a/b:c", at, ".JSON", "UTC")).toBe("a-b-c - modified 2026-11-10 0905.json");
  });
});

describe("pseudonymize: the participant-name rule shared with citations (R378 a, FR-A10)", () => {
  // The map as sources.ts builds it for a creator: each name form → the creator's code.
  const lucia = new Map([
    ["Lucía", "P-002"],
    ["Fernández", "P-002"],
    ["Lucía Fernández", "P-002"],
    ["lucia.cocina", "P-002"],
  ]);

  it("C1: a name in a script written without spaces is replaced inside the run it is joined to", () => {
    const map = new Map([["王小明", "P-001"]]);
    expect(pseudonymize("王小明访谈录", map)).toBe("P-001访谈录");
    expect(pseudonymize("Interview 王小明", map)).toBe("Interview P-001");
    expect(pseudonymize("山田太郎さんへのインタビュー", new Map([["山田太郎", "P-005"]]))).toBe("P-005さんへのインタビュー");
    expect(pseudonymize("บทสัมภาษณ์สมชายใจดี", new Map([["สมชาย ใจดี", "P-006"]]))).not.toContain("สมชาย");
  });

  it("C1: a one-character name of such a script is replaced only as a whole run, never inside a longer one", () => {
    const map = new Map([["明", "P-007"]]);
    expect(pseudonymize("王小明访谈录", map)).toBe("王小明访谈录");
    expect(pseudonymize("Interview 明 2024", map)).toBe("Interview P-007 2024");
  });

  it("I1: accents, case and full-width forms are folded as in citations", () => {
    expect(pseudonymize("Entrevista a Lucia Fernandez", lucia)).toBe("Entrevista a P-002");
    expect(pseudonymize("ＬＵＣÍＡ talks", lucia)).toBe("P-002 talks");
    expect(pseudonymize("lucia_cocina video", lucia)).toBe("P-002 video");
    expect(pseudonymize("LUCÍA FERNÁNDEZ", lucia)).toBe("P-002");
  });

  it("whole words in Latin script: a name is not replaced inside a longer word", () => {
    expect(pseudonymize("Annual report", new Map([["Ann", "P-010"]]))).toBe("Annual report");
    expect(pseudonymize("Marianne at home", new Map([["Maria", "P-011"]]))).toBe("Marianne at home");
    expect(pseudonymize("Rosemary and Primrose", new Map([["Rose", "P-012"]]))).toBe("Rosemary and Primrose");
    expect(pseudonymize("Ann's annual report", new Map([["Ann", "P-010"]]))).toBe("P-010's annual report");
  });
});

describe("pseudonymize: word order (R378 a, FR-A10 I2)", () => {
  it("a name of two or more words is replaced reversed and as 'Family, Given'", () => {
    const map = new Map([["Maria Lopez", "P-003"]]);
    expect(pseudonymize("Lopez, Maria: her life; and LÓPEZ MARIA", map)).toBe("P-003: her life; and P-003");
    expect(pseudonymize("Fernández Ruiz, Lucía", new Map([["Lucía Fernández Ruiz", "P-014"]]))).toBe("P-014");
  });
});

describe("pseudonymize: linear in the text (FR-A10)", () => {
  it("a 100,000-character title with a map of 500 names is handled in well under a second", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 500; i++) {
      const code = `P-${String(i).padStart(3, "0")}`;
      map.set(i % 5 === 0 ? `王${String.fromCodePoint(0x4e00 + i)}明` : `Given${i} Family${i}`, code);
    }
    const chunk = "Lopez maria and Given7 the 王小明访谈录 FAMILY12, given12 annual ";
    const title = chunk.repeat(Math.ceil(100_000 / chunk.length)).slice(0, 100_000);
    const t = performance.now();
    const out = pseudonymize(title, map);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(out).toContain("P-012");
    expect(out).not.toMatch(/family12/iu);
  });
});

describe("pseudonymize: Korean particles and honorifics (R380)", () => {
  const map = new Map([["김민수", "P-001"]]);

  it("a Hangul name of two or more syllables is replaced at the start of a run; the particle stays", () => {
    expect(pseudonymize("김민수의 인터뷰", map)).toBe("P-001의 인터뷰");
    expect(pseudonymize("김민수씨와의 대화", map)).toBe("P-001씨와의 대화");
    expect(pseudonymize("김민수 인터뷰", map)).toBe("P-001 인터뷰");
  });

  it("never in the middle or at the end of a longer run; a one-syllable name only as a run of its own", () => {
    expect(pseudonymize("박김민수 인터뷰", map)).toBe("박김민수 인터뷰");
    expect(pseudonymize("대화박김민수의", map)).toBe("대화박김민수의");
    const one = new Map([["민", "P-002"]]);
    expect(pseudonymize("민수의 인터뷰", one)).toBe("민수의 인터뷰");
    expect(pseudonymize("민 인터뷰", one)).toBe("P-002 인터뷰");
    // A name ending inside a syllable is not a prefix: "김미" is not at the start of "김민".
    expect(pseudonymize("김민의 이야기", new Map([["김미", "P-003"]]))).toBe("김민의 이야기");
  });

  it("family and given written apart: the allowance holds on the last word only", () => {
    const apart = new Map([["김 민수", "P-004"]]);
    expect(pseudonymize("김 민수의 인터뷰", apart)).toBe("P-004의 인터뷰");
    expect(pseudonymize("김씨 민수", apart)).toBe("김씨 민수");
  });

  it("a Latin-script name is still never matched at the start of a longer word", () => {
    expect(pseudonymize("Marianne and Marias", new Map([["Maria", "P-005"]]))).toBe("Marianne and Marias");
  });
});

describe("pseudonymize: linear with Hangul names (R380)", () => {
  it("100,000 characters of Hangul (one run, and short runs) with 500 Hangul names in well under a second", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 500; i++) map.set(`김${String.fromCodePoint(0xac00 + i * 3)}${String.fromCodePoint(0xb000 + i)}`, `P-${String(i).padStart(3, "0")}`);
    map.set("김민수", "P-999");
    const run = "김민수의대화".repeat(Math.ceil(50_000 / 6)).slice(0, 50_000);
    const words = "김민수씨와의 대화 ".repeat(Math.ceil(50_000 / 10)).slice(0, 50_000);
    const t = performance.now();
    const out = pseudonymize(run + " " + words, map);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(out.startsWith("P-999의대화김민수의대화")).toBe(true);
    expect(out).toContain(" P-999씨와의 대화");
  });
});

describe("R387 (a): a name with an invisible character inside it (C1 of the FR-A10 review)", () => {
  // The map as sources.ts builds it for the creator Lucía Fernández.
  const lucia = new Map([
    ["Lucía", "P-002"],
    ["Fernández", "P-002"],
    ["Lucía Fernández", "P-002"],
  ]);
  const folder = (title: string, map: ReadonlyMap<string, string>) =>
    sourceFolderName({ dateOrYear: "2026", primaryCreator: "P-002", shortTitle: pseudonymize(title, map), shortId: "ab12" });

  it("bidi embeddings and isolates inside the name: the folder holds the code and no part of the name", () => {
    const t = "Entrevista a Lu‪cía Fer⁦nández";
    expect(pseudonymize(t, lucia)).toBe("Entrevista a P-002");
    const f = folder(t, lucia);
    expect(f).toBe("2026 P-002 - Entrevista a P-002 [ab12]");
    expect(f).not.toContain("Luc");
    expect(f).not.toContain("Fern");
  });

  it("a left-to-right mark and a soft hyphen inside the name", () => {
    for (const t of ["Entrevista a Luc‎ía Fernández", "Entrevista a Luc­ía Fernández"]) {
      expect(pseudonymize(t, lucia), JSON.stringify(t)).toBe("Entrevista a P-002");
      const f = folder(t, lucia);
      expect(f).not.toContain("Luc");
      expect(f).not.toContain("Fern");
    }
  });

  it("a zero-width space, joiner, word joiner or mark inside 'Maria'; an RLO-reversed 'airaM'", () => {
    const map = new Map([["Maria", "P-001"]]);
    for (const m of ["Ma­ria", "Ma​ria", "Ma‍ria", "Ma⁠ria", "Mar‎ia", "Ma﻿ria", "Ma᠎ria"]) {
      expect(pseudonymize(`Interview with ${m} today`, map), JSON.stringify(m)).toBe("Interview with P-001 today");
      expect(folder(`Interview with ${m}`, map)).not.toMatch(/ria/u);
    }
    const reversed = pseudonymize("Interview with ‮airaM‬ today", map);
    expect(reversed).not.toMatch(/aira/iu);
    expect(folder("Interview with ‮airaM‬", map)).not.toMatch(/aira/iu);
  });

  it("a Devanagari conjunct with a ZWJ, a Persian name with a ZWNJ, a bidi-wrapped handle", () => {
    expect(pseudonymize("क्‍षमा का साक्षात्कार", new Map([["क्षमा", "P-003"]]))).toBe("P-003 का साक्षात्कार");
    expect(pseudonymize("گفتگو با علی‌رضا", new Map([["علیرضا", "P-004"]]))).toBe("گفتگو با P-004");
    expect(pseudonymize("گفتگو با علیرضا", new Map([["علی‌رضا", "P-004"]]))).toBe("گفتگو با P-004");
    // The isolates at the edges of the handle stay around the code (R403 a); the folder sanitiser strips them.
    expect(pseudonymize("Video by ⁨@maria.cocina⁩", new Map([["@maria.cocina", "P-005"]]))).toBe("Video by ⁨P-005⁩");
  });

  it("the Hangul filler and the halfwidth filler inside a Hangul name fold away too", () => {
    const map = new Map([["김민수", "P-006"]]);
    expect(pseudonymize("김ㅤ민수의 인터뷰", map)).toBe("P-006의 인터뷰");
    expect(pseudonymize("김ﾠ민수 인터뷰", map)).toBe("P-006 인터뷰");
  });
});

describe("R387 (b): one function makes a name's forms, for folder names and citations alike (I1 of the FR-A10 review)", () => {
  it("a map entry written apart in a no-space script matches in either order, written together or apart", () => {
    expect(pseudonymize("太郎山田さん", new Map([["山田 太郎", "P-001"]]))).toBe("P-001さん");
    expect(pseudonymize("山田太郎さん", new Map([["山田 太郎", "P-001"]]))).toBe("P-001さん");
    expect(pseudonymize("小明王的故事", new Map([["王 小明", "P-002"]]))).toBe("P-002的故事");
    expect(pseudonymize("山田太郎さん", new Map([["太郎 山田", "P-003"]]))).toBe("P-003さん");
  });
});

describe("R387 (c): the folder replaces a lone given or family name of any length (as before FR-A10)", () => {
  // The map as sources.ts builds it for a creator: the pseudonym map, then each name form → code.
  const creatorMap = (key: string, code: string, given: string, family: string) =>
    new Map([[key, code], [family, code], [given, code], [`${given} ${family}`, code]]);

  it("a Han or kana given name alone is replaced; a one-character family name is not taken inside a run", () => {
    const wang = creatorMap("王小明", "P-001", "小明", "王");
    expect(pseudonymize("小明的故事", wang)).toBe("P-001的故事");
    expect(pseudonymize("王老师和小明", wang)).toBe("王老师和P-001");
    expect(pseudonymize("太郎の話", creatorMap("山田太郎", "P-002", "太郎", "山田"))).toBe("P-002の話");
  });

  it("a short Latin name alone is replaced in the folder (the citation keeps it: R88's floor)", () => {
    expect(pseudonymize("Li family history", creatorMap("Rose Li", "P-003", "Rose", "Li"))).toBe("P-003 family history");
  });
});

describe("R387 (e): partial names (I4 of the FR-A10 review)", () => {
  it("a run of two or more words of a name of three or more words, in order, is the name too", () => {
    const map = new Map([["Lucía Fernández Ruiz", "P-001"]]);
    expect(pseudonymize("Entrevista a Lucía Fernández", map)).toBe("Entrevista a P-001");
    expect(pseudonymize("Fernández Ruiz habla", map)).toBe("P-001 habla");
    expect(pseudonymize("Fernández, Lucía: memorias", map)).toBe("P-001: memorias");
    expect(pseudonymize("luciafernandez video", map)).toBe("P-001 video");
  });

  it("a run made only of short particles is not a name ('de la' of 'Juan de la Cruz')", () => {
    const map = new Map([["Juan de la Cruz", "P-002"]]);
    expect(pseudonymize("Historia de la ciudad", map)).toBe("Historia de la ciudad");
    expect(pseudonymize("Juan de la ciudad", map)).toBe("P-002 ciudad");
    expect(pseudonymize("la Cruz del sur", map)).toBe("P-002 del sur");
  });

  it("stated limit: words dropped from the middle ('Siti Ahmad' of 'Siti binti Ahmad') are not matched", () => {
    expect(pseudonymize("Siti Ahmad bercerita", new Map([["Siti binti Ahmad", "P-003"]]))).toBe("Siti Ahmad bercerita");
  });
});

describe("R387 (f): minor points of the FR-A10 review", () => {
  it("M1: a name's own exact form wins over another name's rotation or joined form, whatever the map's order", () => {
    for (const map of [
      new Map([["Maria Lopez", "P-001"], ["Lopez Maria", "P-002"]]),
      new Map([["Lopez Maria", "P-002"], ["Maria Lopez", "P-001"]]),
    ]) {
      expect(pseudonymize("Maria Lopez; Lopez Maria", map)).toBe("P-001; P-002");
    }
    for (const map of [
      new Map([["Ann Marie", "P-001"], ["Annmarie", "P-002"]]),
      new Map([["Annmarie", "P-002"], ["Ann Marie", "P-001"]]),
    ]) {
      expect(pseudonymize("Annmarie and Ann Marie", map)).toBe("P-002 and P-001");
    }
  });

  it("M2: the forms of a map are built once: 20 folder names with a map of 5,000 names", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 5_000; i++) map.set(`Given${i} Middle${i} Family${i}`, `P-${i}`);
    pseudonymize("warm up", map);
    const t = performance.now();
    for (let i = 0; i < 20; i++) expect(pseudonymize(`Interview ${i} with Middle${i} Family${i}`, map)).toBe(`Interview ${i} with P-${i}`);
    expect(performance.now() - t).toBeLessThan(1000);
    // The time limit covers the one build of the map's forms (the warm-up), timed apart from the calls.
  }, 120_000);

  it("M2: a map changed after use is read afresh (the cache is never stale)", () => {
    const map = new Map([["Maria Lopez", "P-001"]]);
    expect(pseudonymize("Rosa Diaz", map)).toBe("Rosa Diaz");
    map.set("Rosa Diaz", "P-002");
    expect(pseudonymize("Rosa Diaz", map)).toBe("P-002");
    map.set("Rosa Diaz", "P-003");
    expect(pseudonymize("Rosa Diaz", map)).toBe("P-003");
    map.delete("Rosa Diaz");
    expect(pseudonymize("Rosa Diaz", map)).toBe("Rosa Diaz");
  });

  it("M3: a name of several Hangul words is not taken where its last word ends inside a syllable ('김 미' in '김 민의')", () => {
    expect(pseudonymize("김 민의 이야기", new Map([["김 미", "P-001"]]))).toBe("김 민의 이야기");
  });

  it("M3: a final sigma is the same letter as sigma (ΝΙΚΟΣ = Νίκος)", () => {
    expect(pseudonymize("ΝΙΚΟΣ talks", new Map([["Νίκος", "P-001"]]))).toBe("P-001 talks");
    expect(pseudonymize("Νίκος talks", new Map([["ΝΙΚΟΣ", "P-001"]]))).toBe("P-001 talks");
  });

  it("M5: Arabic tatweel folds away; hiragana and katakana are one script", () => {
    expect(pseudonymize("مقابلة مـحـمـد", new Map([["محمد", "P-001"]]))).toBe("مقابلة P-001");
    expect(pseudonymize("ヤマダタロウの話", new Map([["やまだ たろう", "P-002"]]))).toBe("P-002の話");
    expect(pseudonymize("やまだたろうの話", new Map([["ヤマダ タロウ", "P-002"]]))).toBe("P-002の話");
  });

  it("M6: a Hangul name written apart equals the same name written together", () => {
    expect(pseudonymize("김 민수의 인터뷰", new Map([["김민수", "P-001"]]))).toBe("P-001의 인터뷰");
    expect(pseudonymize("김민수의 인터뷰", new Map([["김 민수", "P-001"]]))).toBe("P-001의 인터뷰");
  });
});

describe("R403 (a): an invisible character is both nothing and a boundary (C1 of the FR-A10 second review)", () => {
  const folder = (title: string, map: ReadonlyMap<string, string>) =>
    sourceFolderName({ dateOrYear: "2026", primaryCreator: "P-009", shortTitle: pseudonymize(title, map), shortId: "ab12" });
  const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  // [entry, text, the name's parts that must not stay, the pseudonymised text]
  const table: Array<[string, string, RegExp, string]> = [
    ["Lucía", "Lucía​habla", /luc/u, "P-001​habla"],
    ["Maria Lopez", "Maria​Lopez​habla", /maria|lopez/u, "P-001​habla"],
    ["Ana", "Ana​Luis", /ana/u, "P-001​Luis"],
    ["Maria", "Maria‎שלום", /maria/u, "P-001‎שלום"],
    ["Maria", "#Maria⁠Day", /maria/u, "#P-001⁠Day"],
    ["Maria", "⁨Maria⁩⁨Lopez⁩", /maria/u, "⁨P-001⁩⁨Lopez⁩"],
  ];
  it.each(table)("%s in %j: replaced, and the folder name holds no part of it", (entry, text, parts, expected) => {
    const map = new Map([[entry, "P-001"]]);
    expect(pseudonymize(text, map)).toBe(expected);
    const f = folder(text, map);
    expect(f).toContain("P-001");
    expect(plain(f)).not.toMatch(parts);
  });

  it("the isolates around two names: each isolate is a boundary, so the folder never reads 'MariaLopez'", () => {
    const f = folder("⁨Maria⁩⁨Lopez⁩", new Map([["Maria", "P-001"], ["Lopez", "P-002"]]));
    expect(f).toBe("2026 P-009 - P-001P-002 [ab12]");
  });

  it("a Latin name still never matches inside a longer word without an invisible character", () => {
    expect(pseudonymize("Marianne", new Map([["Maria", "P-001"]]))).toBe("Marianne");
    expect(pseudonymize("Anabel habla", new Map([["Ana", "P-001"]]))).toBe("Anabel habla");
  });

  it("'Ana​bel': with the entry 'Anabel' the longer match wins; with 'Ana' only, 'Ana' is replaced and 'bel' kept", () => {
    expect(pseudonymize("Ana​bel habla", new Map([["Anabel", "P-001"], ["Ana", "P-002"]]))).toBe("P-001 habla");
    expect(pseudonymize("Ana​bel habla", new Map([["Ana", "P-002"], ["Anabel", "P-001"]]))).toBe("P-001 habla");
    // The price of treating the character as a boundary: "Ana" is found at the start of "Ana​bel".
    expect(pseudonymize("Ana​bel habla", new Map([["Ana", "P-002"]]))).toBe("P-002​bel habla");
  });

  it("the span replaced holds the invisible characters inside the name, not those at its edges", () => {
    expect(pseudonymize("x​Lu­cía​habla", new Map([["Lucía", "P-001"]]))).toBe("x​P-001​habla");
  });
});
