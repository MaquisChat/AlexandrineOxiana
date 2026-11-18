import { describe, expect, it } from "vitest";
import { isReadablePdfAsset } from "./documents.js";

describe("isReadablePdfAsset: the one rule for a PDF the reader can open (R222)", () => {
  it("an original, not destroyed, recorded as a PDF", () => {
    expect(isReadablePdfAsset({ role: "original", mime: "application/pdf" })).toBe(true);
    expect(isReadablePdfAsset({ role: "original", mime: "application/pdf", status: "present" })).toBe(true);
  });
  it("not a derived file, a destroyed one, another type, or one with no recorded type", () => {
    expect(isReadablePdfAsset({ role: "derived", mime: "application/pdf" })).toBe(false);
    expect(isReadablePdfAsset({ role: "original", mime: "application/pdf", status: "destroyed" })).toBe(false);
    expect(isReadablePdfAsset({ role: "original", mime: "image/png" })).toBe(false);
    expect(isReadablePdfAsset({ role: "original" })).toBe(false);
  });
});
