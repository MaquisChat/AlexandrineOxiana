import { describe, expect, it } from "vitest";
import { blank, nonBlank } from "./blank.js";
import * as core from "./index.js";

describe("blank(): one test for a required text that holds nothing a reader would see (R391 c; review M3)", () => {
  const BLANK = [
    undefined, null, "", " ", "\t\n", " ", "​", "‌‍", "﻿", "­", "⁠", "‎‏", "　",
    "⠀", "ㅤ", "ᅟ", "ᅠ", "ﾠ", "́", "́̈", "͏", "  ​\t⠀́",
  ];
  it.each(BLANK)("%j is blank", (v) => expect(blank(v as string)).toBe(true));
  it.each(["a", "consent", "P-1", " é ", "一", "0", "Art. 6(1)(e)"])("%j is not", (v) => expect(blank(v)).toBe(false));
  it("nonBlank trims a real value and gives undefined for a blank one", () => {
    expect(nonBlank("  consent ")).toBe("consent");
    expect(nonBlank("​")).toBeUndefined();
  });
  it("is exported from core", () => {
    expect(core.blank).toBe(blank);
    expect(core.nonBlank).toBe(nonBlank);
  });
});
