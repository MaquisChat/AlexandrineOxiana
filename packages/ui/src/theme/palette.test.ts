import { describe, expect, it } from "vitest";
import { CVD_KINDS, MACHADO_2009, deltaE2000, hexToLab, minPairwiseDeltaE, simulate } from "./colorVision";
import { contrastRatio } from "./contrast";
import { CODE_FAMILIES, CODE_MIN_CHROMA, CODE_MIN_LIGHTNESS, inHueRange, lch } from "./codePalette";
import { CODE_PALETTE_SIZE, THEMES, codeColors } from "./themes";
import { THEME_NAMES } from "./tokenFile";

describe("ΔE2000 (CIEDE2000)", () => {
  // Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula: Implementation Notes",
  // Table 1 test pairs (L*, a*, b*) -> ΔE00.
  const SHARMA: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  it("reproduces the Sharma et al. reference values", () => {
    for (const [a, b, want] of SHARMA) {
      expect(deltaE2000(a as [number, number, number], b as [number, number, number])).toBeCloseTo(want, 4);
      expect(deltaE2000(b as [number, number, number], a as [number, number, number])).toBeCloseTo(want, 4);
    }
  });

  it("converts sRGB to CIELAB (D65)", () => {
    const [L, a, b] = hexToLab("#FFFFFF");
    expect(L).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
    const red = hexToLab("#FF0000");
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);
  });
});

describe("colour-vision simulation (Machado, Oliveira & Fernandes 2009, severity 1.0)", () => {
  it("uses the published matrices (each row sums to 1, so greys stay grey)", () => {
    for (const kind of CVD_KINDS) {
      const m = MACHADO_2009[kind];
      for (let r = 0; r < 3; r++) expect(m[r * 3]! + m[r * 3 + 1]! + m[r * 3 + 2]!).toBeCloseTo(1, 3);
      expect(simulate("#808080", kind)).toBe("#808080");
    }
    expect(MACHADO_2009.deuteranopia.slice(0, 3)).toEqual([0.367322, 0.860646, -0.227968]);
  });

  it("collapses red/green for protanopia and deuteranopia but not for tritanopia", () => {
    const red = "#D03030";
    const green = "#3A9A3A";
    const normal = deltaE2000(hexToLab(red), hexToLab(green));
    for (const kind of ["protanopia", "deuteranopia"] as const) expect(deltaE2000(hexToLab(simulate(red, kind)), hexToLab(simulate(green, kind)))).toBeLessThan(normal / 2);
    expect(deltaE2000(hexToLab(simulate(red, "tritanopia")), hexToLab(simulate(green, "tritanopia")))).toBeGreaterThan(normal / 2);
  });
});

describe("qualitative code palette (R103)", () => {
  it("names the twelve hue families in a fixed order", () => {
    expect(CODE_FAMILIES.map((f) => f.name)).toEqual(["red", "orange", "gold", "olive", "green", "teal", "cyan", "blue", "indigo", "purple", "magenta", "brown"]);
    expect(CODE_PALETTE_SIZE).toBe(12);
  });

  for (const theme of THEME_NAMES) {
    describe(theme, () => {
      const colors = codeColors(theme);

      it(`has ${CODE_PALETTE_SIZE} distinct colours`, () => {
        expect(colors).toHaveLength(12);
        expect(new Set(colors).size).toBe(12);
      });

      it("--code-n stays in its hue family, reads as a colour (minimum chroma) and is not near-black", () => {
        const bad: string[] = [];
        colors.forEach((c, i) => {
          const f = CODE_FAMILIES[i]!;
          const { L, C, h } = lch(c);
          if (!inHueRange(h, f.hue)) bad.push(`--code-${i + 1} ${c} (${f.name}): hue ${h.toFixed(0)} outside ${f.hue.join("–")}`);
          if (C < f.minChroma) bad.push(`--code-${i + 1} ${c} (${f.name}): chroma ${C.toFixed(0)} < ${f.minChroma}`);
          if (f.maxChroma !== undefined && C > f.maxChroma) bad.push(`--code-${i + 1} ${c} (${f.name}): chroma ${C.toFixed(0)} > ${f.maxChroma}`);
          if (f.maxLightness !== undefined && L > f.maxLightness) bad.push(`--code-${i + 1} ${c} (${f.name}): L* ${L.toFixed(0)} > ${f.maxLightness}`);
          if (L < CODE_MIN_LIGHTNESS) bad.push(`--code-${i + 1} ${c} (${f.name}): L* ${L.toFixed(0)} is near-black`);
          if (C < CODE_MIN_CHROMA) bad.push(`--code-${i + 1} ${c}: chroma below the palette minimum`);
        });
        expect(bad).toEqual([]);
      });

      it("every pair differs by ΔE2000 ≥ 15 with normal vision and ≥ 12 under deuteranopia, protanopia and tritanopia", () => {
        expect(minPairwiseDeltaE(colors, null)).toBeGreaterThanOrEqual(15);
        for (const kind of CVD_KINDS) expect(minPairwiseDeltaE(colors, kind), kind).toBeGreaterThanOrEqual(12);
      });

      it("every colour stands out from --bg and --surface (≥ 3:1, WCAG non-text contrast)", () => {
        for (const c of colors) for (const bg of ["bg", "surface"]) expect(contrastRatio(c, THEMES[theme][bg]!), `${c} on --${bg}`).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("light and dark have their own variants of the same families", () => {
    expect(codeColors("light")).not.toEqual(codeColors("dark"));
    expect(codeColors("light-hc")).toEqual(codeColors("light"));
    expect(codeColors("dark-hc")).toEqual(codeColors("dark"));
  });
});
