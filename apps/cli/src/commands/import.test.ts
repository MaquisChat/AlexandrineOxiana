/** FR-A21 (R392): the command line's import progress line says the total only when the source told one. */
import { describe, expect, it } from "vitest";
import { importProgressLine, importProgressWrite } from "./import.js";

describe("importProgressLine", () => {
  it("with a total: done of total", () => {
    expect(importProgressLine({ done: 97, total: 3412 })).toBe("Imported 97 of 3412");
  });
  it("without a total: done so far, never a guessed total", () => {
    expect(importProgressLine({ done: 97 })).toBe("Imported 97 so far");
    expect(importProgressLine({ done: 97 })).not.toMatch(/of/u);
  });
});

/** What one terminal line shows after these writes: `\r` returns to its start, `\x1b[K` clears to its end. */
function screen(writes: string[]): string {
  let row: string[] = [];
  let col = 0;
  for (const w of writes) {
    for (let i = 0; i < w.length; i++) {
      if (w[i] === "\r") col = 0;
      else if (w.startsWith("\x1b[K", i)) {
        row = row.slice(0, col);
        i += 2;
      } else row[col++] = w[i]!;
    }
  }
  return row.join("");
}

describe("importProgressWrite (R426 b)", () => {
  it("a shorter line written over a longer one leaves none of the longer one's tail", () => {
    const seen: string[] = [];
    const writes: string[] = [];
    for (const p of [{ done: 0 }, { done: 0, total: 5 }, { done: 1, total: 5 }, { done: 5, total: 5 }]) {
      writes.push(importProgressWrite(importProgressLine(p)));
      seen.push(screen(writes));
    }
    expect(seen).toEqual(["Imported 0 so far", "Imported 0 of 5", "Imported 1 of 5", "Imported 5 of 5"]);
  });
});
