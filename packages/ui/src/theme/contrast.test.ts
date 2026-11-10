// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast";
import { THEMES } from "./themes";
import { BRIEF_TOKENS, TEXT_PAIRS, THEME_NAMES, deriveHighContrast, parseTokens, replaceGenerated } from "./tokenFile";

const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("contrastRatio (WCAG 2.x relative luminance)", () => {
  it("black on white is 21:1, a colour on itself 1:1, and the order does not matter", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 6);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#1F5E63", "#1F5E63")).toBeCloseTo(1, 6);
    expect(contrastRatio("#abc", "#AABBCC")).toBeCloseTo(1, 6);
  });

  it("matches published reference values", () => {
    // #777 on white is the classic just-below-AA grey (4.48:1); #767676 is the lightest grey that passes.
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.478, 2);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    // Luminance uses the 0.04045 sRGB threshold and the 0.2126/0.7152/0.0722 weights.
    expect(relativeLuminance("#FF0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00FF00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000FF")).toBeCloseTo(0.0722, 4);
    expect(relativeLuminance("#0A0A0A")).toBeCloseTo(10 / 255 / 12.92, 6);
  });

  it("refuses something that is not a colour", () => {
    expect(() => contrastRatio("tomato", "#FFFFFF")).toThrow(/colour/);
    expect(() => contrastRatio("#12345", "#FFFFFF")).toThrow(/colour/);
  });
});

describe("theme tokens", () => {
  it("defines light, dark, light-hc and dark-hc, each with every token in the brief", () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_NAMES].sort());
    for (const name of THEME_NAMES) for (const t of BRIEF_TOKENS) expect(THEMES[name][t], `${name} --${t}`).toMatch(/^#[0-9A-F]{6}$/);
  });

  for (const name of THEME_NAMES) {
    const min = name.endsWith("-hc") ? 7 : 4.5;
    it(`${name}: every text token on --bg, --surface and its own soft background is ≥ ${min}:1`, () => {
      const t = THEMES[name];
      const failures: string[] = [];
      for (const { fg, on } of TEXT_PAIRS) {
        for (const bg of on) {
          const r = contrastRatio(t[fg]!, t[bg]!);
          if (r < min) failures.push(`--${fg} on --${bg}: ${r.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("checks every text token the brief names (--ink*, --muted, --accent-ink, --ok-ink, --warn-ink, --amber-ink, --deny, --on-accent on --accent)", () => {
    const fgs = new Set(TEXT_PAIRS.map((p) => p.fg));
    for (const t of ["ink", "ink-2", "ink-3", "muted", "accent-ink", "ok-ink", "warn-ink", "amber-ink", "deny", "on-accent"]) expect(fgs.has(t), t).toBe(true);
    expect(TEXT_PAIRS.find((p) => p.fg === "on-accent")?.on).toEqual(["accent"]);
    for (const p of TEXT_PAIRS) if (p.fg !== "on-accent") expect(p.on).toEqual(expect.arrayContaining(["bg", "surface"]));
    expect(TEXT_PAIRS.find((p) => p.fg === "accent-ink")?.on).toContain("accent-soft");
    expect(TEXT_PAIRS.find((p) => p.fg === "ok-ink")?.on).toContain("ok-soft");
    expect(TEXT_PAIRS.find((p) => p.fg === "warn-ink")?.on).toContain("warn-soft");
    expect(TEXT_PAIRS.find((p) => p.fg === "violet-ink")?.on).toContain("violet-soft");
  });

  it("high-contrast themes: body text (--ink, --ink-2, --ink-3, --muted) is ≥ 7:1 on every background it is used on", () => {
    for (const name of ["light-hc", "dark-hc"] as const) {
      const t = THEMES[name];
      for (const fg of ["ink", "ink-2", "ink-3", "muted"]) {
        for (const bg of ["bg", "surface", "surface-2", "chip"]) expect(contrastRatio(t[fg]!, t[bg]!), `${name} --${fg} on --${bg}`).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("high-contrast themes keep borders visible (--line, --line-strong ≥ 3:1 on --bg and --surface)", () => {
    for (const name of ["light-hc", "dark-hc"] as const) {
      const t = THEMES[name];
      for (const fg of ["line", "line-strong"]) for (const bg of ["bg", "surface"]) expect(contrastRatio(t[fg]!, t[bg]!), `${name} --${fg} on --${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("high-contrast tokens are derived from light/dark (the generated block in tokens.css is up to date)", () => {
    const parsed = parseTokens(tokensCss);
    expect(parsed["light-hc"]).toEqual(deriveHighContrast(parsed.light, "light"));
    expect(parsed["dark-hc"]).toEqual(deriveHighContrast(parsed.dark, "dark"));
    expect(replaceGenerated(tokensCss)).toBe(tokensCss);
  });

  it("derivation only moves text towards black (light) or white (dark), and leaves passing tokens alone", () => {
    const light = parseTokens(tokensCss).light;
    const hc = deriveHighContrast(light, "light");
    expect(relativeLuminance(hc.muted!)).toBeLessThan(relativeLuminance(light.muted!));
    expect(hc.ink).toBe(light.ink); // already far above 7:1
    expect(hc.bg).toBe(light.bg);
  });
});
