/**
 * WCAG 2.x contrast (spec 8A.1: every theme is checked for text contrast, 4.5:1 minimum; the
 * high-contrast themes aim for 7:1). Colours are `#rgb` or `#rrggbb`.
 */
export type Rgb = [number, number, number];

/** Minimum contrast for body text: WCAG AA (4.5:1), and AAA (7:1) in the high-contrast themes. */
export const TEXT_MIN = 4.5;
export const TEXT_MIN_HC = 7;
/** Minimum for borders and other non-text indicators (WCAG 1.4.11). */
export const NON_TEXT_MIN = 3;

/** `#rgb` / `#rrggbb` → [r, g, b] in 0–255. Throws on anything else. */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`"${hex}" is not a colour written #rrggbb.`);
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] (0–255, rounded and clamped) → `#RRGGBB`. */
export function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** sRGB channel (0–1) → linear light (WCAG 2.x uses the 0.04045 threshold). */
export function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => toLinear(v / 255)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21; the order of the two colours does not matter. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
