/**
 * The qualitative code palette's rules (spec 8A.1, R103). The colours themselves are --code-1 …
 * --code-12 in tokens.css; this file says what each one must be, and the tests check it.
 *
 * Each --code-n keeps the same hue family in every theme (a code looks like "the teal one" in light
 * and dark alike), reads as a colour (minimum chroma), is never near-black, and the set stays
 * distinguishable: CIEDE2000 ≥ 15 between any pair with normal vision and ≥ 12 under simulated
 * deuteranopia, protanopia and tritanopia; ≥ 3:1 against --bg and --surface. Codes are never shown
 * by colour alone: CodeSwatch pairs each colour with a shape (components/codeGlyphs.ts) and the
 * code's name.
 */
import { hexToLab } from "./colorVision";

export interface CodeFamily {
  name: string;
  /** CIELAB hue angle range in degrees, [from, to]; wraps through 0 when from > to. */
  hue: [number, number];
  minChroma: number;
  maxChroma?: number;
  /** CIELAB L* ceiling (keeps olive from turning into yellow, brown into tan, in dark themes). */
  maxLightness?: number;
}

export const CODE_FAMILIES: readonly CodeFamily[] = [
  { name: "red", hue: [20, 44], minChroma: 40, maxLightness: 80 },
  { name: "orange", hue: [46, 68], minChroma: 40, maxLightness: 85 },
  { name: "gold", hue: [70, 94], minChroma: 35, maxLightness: 85 },
  { name: "olive", hue: [96, 126], minChroma: 25, maxLightness: 72 },
  { name: "green", hue: [128, 160], minChroma: 30 },
  { name: "teal", hue: [165, 202], minChroma: 22 },
  { name: "cyan", hue: [205, 245], minChroma: 22 },
  { name: "blue", hue: [248, 286], minChroma: 28 },
  { name: "indigo", hue: [288, 306], minChroma: 30 },
  { name: "purple", hue: [308, 330], minChroma: 35 },
  { name: "magenta", hue: [332, 18], minChroma: 35 },
  { name: "brown", hue: [30, 75], minChroma: 15, maxChroma: 42, maxLightness: 70 },
];

/** No code colour is greyer than this (CIELAB chroma) … */
export const CODE_MIN_CHROMA = 15;
/** … or darker than this (CIELAB L*): near-black would read as text, not as a colour. */
export const CODE_MIN_LIGHTNESS = 25;

export const CODE_MIN_DELTA_E = 15;
export const CODE_MIN_DELTA_E_CVD = 12;

/** CIELAB lightness, chroma and hue angle (degrees) of a colour. */
export function lch(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = hexToLab(hex);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function inHueRange(h: number, [from, to]: [number, number]): boolean {
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}
