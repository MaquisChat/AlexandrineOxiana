import { describe, expect, it } from "vitest";
import { parseReference, segmentsOf, tokensOf } from "./reference.js";

describe("parseReference", () => {
  it("quotes, year and punctuation", () => {
    const r = parseReference(`  "weak ties"   Granovetter, 1973.  `);
    expect(r).toEqual({ text: `"weak ties" Granovetter, 1973.`, tokens: ["weak", "ties", "granovetter", "1973"], year: 1973, quoted: "weak ties" });

    const curly = parseReference("“The Strength of Weak Ties” — Granovetter (1973)");
    expect(curly?.quoted).toBe("The Strength of Weak Ties");
    expect(curly?.year).toBe(1973);
    expect(curly?.tokens).toEqual(["the", "strength", "of", "weak", "ties", "granovetter", "1973"]);

    // Commas, colons, semicolons, slashes and dashes separate words even without a space.
    expect(parseReference("Bourdieu,Distinction;taste/judgement-critique")?.tokens).toEqual(["bourdieu", "distinction", "taste", "judgement", "critique"]);
    // Apostrophes (straight or typographic) and full stops join, as normalizeTitle does.
    expect(parseReference("Bourdieu's U.S. reception")?.tokens).toEqual(["bourdieus", "us", "reception"]);
    expect(parseReference("Bourdieu’s U.S. reception")?.tokens).toEqual(["bourdieus", "us", "reception"]);
    // No year typed: none given. A number that is not a year is a plain token.
    const r2 = parseReference("Bourdieu, Distinction");
    expect(r2).toEqual({ text: "Bourdieu, Distinction", tokens: ["bourdieu", "distinction"] });
    expect(parseReference("Capital 3 volumes 867")?.year).toBeUndefined();
    // The first year counts; tokens are not repeated.
    const r3 = parseReference("Distinction distinction 1984 1979");
    expect(r3?.year).toBe(1984);
    expect(r3?.tokens).toEqual(["distinction", "1984", "1979"]);
  });

  it("is null below 2 or above 500 characters (counted after spacing is tidied)", () => {
    expect(parseReference("")).toBeNull();
    expect(parseReference("   x   ")).toBeNull();
    expect(parseReference("xy")).not.toBeNull();
    expect(parseReference("a".repeat(500))).not.toBeNull();
    expect(parseReference("a".repeat(501))).toBeNull();
    // Characters, not UTF-16 units: 500 astral letters is still 500 characters.
    expect(parseReference("𝒜".repeat(500))).not.toBeNull();
    expect(parseReference("𝒜".repeat(501))).toBeNull();
    // A huge line is refused without work on it.
    expect(parseReference("Bourdieu ".repeat(200_000))).toBeNull();
  });

  it("control characters, bidi marks and zero-width characters do not reach the text or the tokens", () => {
    const r = parseReference("Bour‮dieu​, Dis\u0000tinction⁦⁩\u0085");
    expect(r?.text).toBe("Bourdieu, Dis tinction");
    expect(r?.tokens).toEqual(["bourdieu", "dis", "tinction"]);
    expect(r?.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f​‪-‮⁦-⁩]/u);
  });

  it("diacritics and ligatures: Müller and Muller, ﬁeld and field give the same tokens", () => {
    expect(tokensOf("Müller")).toEqual(tokensOf("Muller"));
    expect(tokensOf("Müller")).toEqual(["muller"]);
    expect(tokensOf("Notes from the ﬁeld")).toEqual(["notes", "from", "the", "field"]);
    // A decomposed ü (as macOS may type it) is the same as a composed one.
    expect(tokensOf("Müller")).toEqual(["muller"]);
    // Full-width Latin is folded too.
    expect(tokensOf("Ｂｏｕｒｄｉｅｕ")).toEqual(["bourdieu"]);
    // But ß stays ß, and Mueller is another spelling (not folded).
    expect(tokensOf("Straße")).toEqual(["straße"]);
    expect(tokensOf("Mueller")).not.toEqual(tokensOf("Müller"));
  });

  it("scripts written without spaces give character pairs; the separate runs are kept", () => {
    expect(tokensOf("日本の思想")).toEqual(["日本", "本の", "の思", "思想"]);
    // A single character stays itself.
    expect(tokensOf("王")).toEqual(["王"]);
    // Katakana's long-vowel mark stays inside its run.
    expect(tokensOf("デュルケーム")).toEqual(["デュ", "ュル", "ルケ", "ケー", "ーム"]);
    expect(segmentsOf("丸山眞男 日本の思想 1961")).toEqual([{ chars: ["丸", "山", "眞", "男"] }, { chars: ["日", "本", "の", "思", "想"] }, { word: "1961" }]);
    // Ideographic punctuation separates runs.
    expect(segmentsOf("丸山眞男、日本の思想")).toEqual([{ chars: ["丸", "山", "眞", "男"] }, { chars: ["日", "本", "の", "思", "想"] }]);
    // Mixed Latin and Han in one word are split into their runs.
    expect(segmentsOf("Weber論")).toEqual([{ word: "weber" }, { chars: ["論"] }]);
    const r = parseReference("日本の思想丸山眞男");
    expect(r?.tokens).toContain("丸山");
    expect(r?.tokens).toContain("思想");
  });
});
