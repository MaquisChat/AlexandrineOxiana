/**
 * The qualitative code palette's rules (spec 8A.1, R103, R105). The colours themselves are
 * --code-1 … --code-12 in tokens.css (fitted by `pnpm --filter @ao/ui fit:palette`); this file says
 * what each one must be, and src/theme/palette.test.ts checks it.
 *
 * Each --code-n keeps the same hue family in every theme (a code is "the teal one" in light and dark
 * alike), within a per-theme band of CIELAB lightness, chroma and hue so that e.g. orange reads as
 * orange and brown stays distinct from orange and gold. The set stays distinguishable: CIEDE2000 ≥ 15
 * between any pair with normal vision and ≥ 12 under simulated deuteranopia, protanopia and
 * tritanopia; and each colour reaches 3:1 against --bg and --surface (and --chip in dark; see
 * CODE_BACKGROUNDS). Codes are never shown
 * by colour alone: CodeSwatch pairs each colour with a shape (components/codeGlyphs.ts) and the
 * code's name.
 */
import { hexToLab } from "./colorVision";

/** A CIELAB region: L* and C* ranges, hue angle range in degrees (wraps through 0 when from > to). */
export interface Band {
  L: [number, number];
  C: [number, number];
  hue: [number, number];
}

export interface CodeFamily {
  name: string;
  light: Band;
  dark: Band;
}

export const CODE_FAMILIES: readonly CodeFamily[] = [
  { name: "red", light: { L: [30, 52], C: [50, 120], hue: [24, 42] }, dark: { L: [50, 64], C: [55, 120], hue: [24, 42] } },
  { name: "orange", light: { L: [40, 58], C: [55, 120], hue: [48, 66] }, dark: { L: [60, 74], C: [60, 120], hue: [48, 66] } },
  { name: "gold", light: { L: [50, 62], C: [45, 120], hue: [72, 90] }, dark: { L: [72, 86], C: [55, 120], hue: [72, 90] } },
  { name: "olive", light: { L: [36, 60], C: [25, 60], hue: [94, 128] }, dark: { L: [55, 72], C: [30, 60], hue: [96, 122] } },
  { name: "green", light: { L: [30, 58], C: [35, 120], hue: [126, 164] }, dark: { L: [58, 86], C: [40, 120], hue: [128, 156] } },
  { name: "teal", light: { L: [30, 56], C: [22, 120], hue: [166, 206] }, dark: { L: [58, 82], C: [25, 120], hue: [168, 202] } },
  { name: "cyan", light: { L: [38, 60], C: [22, 120], hue: [208, 248] }, dark: { L: [58, 82], C: [25, 120], hue: [205, 242] } },
  { name: "blue", light: { L: [30, 55], C: [35, 140], hue: [248, 286] }, dark: { L: [52, 72], C: [35, 140], hue: [248, 286] } },
  { name: "indigo", light: { L: [25, 48], C: [35, 140], hue: [286, 306] }, dark: { L: [48, 66], C: [40, 140], hue: [282, 302] } },
  { name: "purple", light: { L: [25, 50], C: [45, 140], hue: [312, 332] }, dark: { L: [55, 70], C: [50, 140], hue: [302, 322] } },
  { name: "magenta", light: { L: [36, 58], C: [45, 140], hue: [332, 16] }, dark: { L: [50, 68], C: [55, 140], hue: [332, 16] } },
  { name: "brown", light: { L: [25, 42], C: [15, 40], hue: [30, 70] }, dark: { L: [50, 64], C: [18, 40], hue: [30, 70] } },
];

export const CODE_MIN_DELTA_E = 15;
export const CODE_MIN_DELTA_E_CVD = 12;
export const CODE_MIN_CONTRAST = 3;
/**
 * Backgrounds every code colour must reach CODE_MIN_CONTRAST on. In the light theme --chip is left
 * out (R105 allows relaxing 3:1-on-chip before hue identity): with the family bands above, no light
 * palette reaching 3:1 on --chip also kept ΔE ≥ 12 under every CVD simulation. Light code colours
 * still reach LIGHT_CHIP_MIN on --chip, and a CodeSwatch glyph is outlined in --line-control.
 */
export const CODE_BACKGROUNDS = { light: ["bg", "surface"], dark: ["bg", "surface", "chip"] } as const;
export const LIGHT_CHIP_MIN = 2.8;

/** CIELAB lightness, chroma and hue angle (degrees) of a colour. */
export function lch(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = hexToLab(hex);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function inHueRange(h: number, [from, to]: [number, number]): boolean {
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}

/** Why `hex` is outside `band`, or null when it is inside. */
export function bandProblem(hex: string, band: Band): string | null {
  const { L, C, h } = lch(hex);
  if (!inHueRange(h, band.hue)) return `hue ${h.toFixed(0)} outside ${band.hue.join("–")}`;
  if (L < band.L[0] || L > band.L[1]) return `L* ${L.toFixed(1)} outside ${band.L.join("–")}`;
  if (C < band.C[0] || C > band.C[1]) return `C* ${C.toFixed(1)} outside ${band.C.join("–")}`;
  return null;
}
