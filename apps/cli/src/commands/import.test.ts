/** FR-A21 (R392): the command line's import progress line says the total only when the source told one. */
import { describe, expect, it } from "vitest";
import { importProgressLine } from "./import.js";

describe("importProgressLine", () => {
  it("with a total: done of total", () => {
    expect(importProgressLine({ done: 97, total: 3412 })).toBe("Imported 97 of 3412");
  });
  it("without a total: done so far, never a guessed total", () => {
    expect(importProgressLine({ done: 97 })).toBe("Imported 97 so far");
    expect(importProgressLine({ done: 97 })).not.toMatch(/of/u);
  });
});
