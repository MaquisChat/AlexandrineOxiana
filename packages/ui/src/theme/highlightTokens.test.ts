// @vitest-environment node
/**
 * The highlight colours (Task R8, Accept 4): one token a named colour, `--hl-<name>`, written
 * #RRGGBBAA in tokens.css. The page under a highlight is paper (white) in every theme, so the tokens
 * are the same in all four themes, and each, laid at its own alpha over white, keeps the page's black
 * text at 4.5:1 or more. Everything is computed from the token values in tokens.css as written.
 */
import { readFileSync } from "node:fs";
import { HIGHLIGHT_COLOURS } from "@ao/core";
import { describe, expect, it } from "vitest";
import { contrastRatio, TEXT_MIN, toHex } from "./contrast";
import { parseTokens, THEME_NAMES } from "./tokenFile";

const tokens = parseTokens(readFileSync(new URL("./tokens.css", import.meta.url), "utf8"));

/** `#RRGGBBAA` → the colour and its alpha (0–1). */
function rgba(value: string): { rgb: [number, number, number]; alpha: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!m) throw new Error(`"${value}" is not written #RRGGBBAA`);
  const [r, g, b, a] = m.slice(1).map((h) => parseInt(h, 16)) as [number, number, number, number];
  return { rgb: [r, g, b], alpha: a / 255 };
}

/** The colour seen where `value` is laid over `under` (source-over; multiply over white is the same). */
function over(value: string, under: [number, number, number]): string {
  const { rgb, alpha } = rgba(value);
  return toHex(rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)));
}

describe("highlight tokens", () => {
  it("every highlight colour keeps black text at 4.5:1 on white", () => {
    const failures: string[] = [];
    for (const name of HIGHLIGHT_COLOURS) {
      const value = tokens.light[`hl-${name}`];
      expect(value, `--hl-${name}`).toBeDefined();
      const { alpha } = rgba(value!);
      // Seen at all: not transparent, and not a solid block that hides the words.
      expect(alpha, `--hl-${name} alpha`).toBeGreaterThan(0.15);
      expect(alpha, `--hl-${name} alpha`).toBeLessThan(1);
      const blend = over(value!, [255, 255, 255]);
      const ratio = contrastRatio("#000000", blend);
      if (ratio < TEXT_MIN) failures.push(`--hl-${name} ${value} over white is ${blend}: black on it ${ratio.toFixed(2)}:1`);
      // Under the multiply blend the reader uses, black text stays black: black × anything = black.
    }
    expect(failures).toEqual([]);
  });

  it("highlight tokens exist in all four themes", () => {
    for (const name of HIGHLIGHT_COLOURS) {
      const values = THEME_NAMES.map((t) => tokens[t][`hl-${name}`]);
      expect(values.every((v) => v !== undefined), `--hl-${name} in ${THEME_NAMES.join(", ")}`).toBe(true);
      // The page is paper whatever the theme: the same value everywhere.
      expect(new Set(values).size, `--hl-${name}: ${values.join(" / ")}`).toBe(1);
    }
  });

  it("the eight colours stay apart from one another on the page", () => {
    // Each pair, as seen over white, differs: no two names draw the same colour.
    const seen = HIGHLIGHT_COLOURS.map((n) => over(tokens.light[`hl-${n}`]!, [255, 255, 255]));
    expect(new Set(seen).size).toBe(HIGHLIGHT_COLOURS.length);
  });

  it("the line the overlay draws round a chosen or changed highlight is the same in all four themes and stands out on white", () => {
    const values = THEME_NAMES.map((t) => tokens[t]["hl-edge"]);
    expect(new Set(values).size).toBe(1);
    expect(contrastRatio(values[0]!, "#FFFFFF")).toBeGreaterThanOrEqual(3);
  });
});
