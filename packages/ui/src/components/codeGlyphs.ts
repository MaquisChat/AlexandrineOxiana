/**
 * One shape per code colour (R103: codes are never identified by colour alone). SVG path data on a
 * 16×16 grid, filled with the code's colour; `--code-n` pairs with `CODE_GLYPHS[n - 1]`. The shapes
 * differ in outline, and none is a rotated or mirrored copy of another (R105), so they stay distinct
 * at 12px and in any orientation.
 */
export interface CodeGlyph {
  /** Plain name, read out to screen readers next to the code name. */
  name: string;
  /** SVG path data, viewBox "0 0 16 16"; draw with fill-rule="evenodd". */
  d: string;
}

export const CODE_GLYPHS: readonly CodeGlyph[] = [
  { name: "circle", d: "M8 2A6 6 0 1 1 8 14A6 6 0 1 1 8 2Z" },
  { name: "square", d: "M3 3H13V13H3Z" },
  { name: "triangle", d: "M8 2L14 13H2Z" },
  { name: "hourglass", d: "M3 2H13L9 8L13 14H3L7 8Z" },
  { name: "chevron", d: "M2 3L8 8L2 13H7L13 8L7 3Z" },
  { name: "star", d: "M8 1.5L9.76 6.07L14.66 6.34L10.85 9.43L12.11 14.16L8 11.5L3.89 14.16L5.15 9.43L1.34 6.34L6.24 6.07Z" },
  { name: "plus", d: "M6 2H10V6H14V10H10V14H6V10H2V6H6Z" },
  { name: "crescent", d: "M10 1.5A6.5 6.5 0 1 0 14.5 11A5 5 0 1 1 10 1.5Z" },
  { name: "hexagon", d: "M14.5 8L11.25 13.63L4.75 13.63L1.5 8L4.75 2.37L11.25 2.37Z" },
  { name: "pentagon", d: "M8 1.8L14.47 6.5L12 14.1L4 14.1L1.53 6.5Z" },
  { name: "ring", d: "M8 1.5A6.5 6.5 0 1 1 8 14.5A6.5 6.5 0 1 1 8 1.5ZM8 5A3 3 0 1 0 8 11A3 3 0 1 0 8 5Z" },
  { name: "half circle", d: "M2 11A6 6 0 0 1 14 11Z" },
];
