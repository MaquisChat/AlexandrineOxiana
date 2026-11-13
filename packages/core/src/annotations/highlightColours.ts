/**
 * The reader's named highlight colours (R192 / PDF reader plan, Task R1). A highlight is stored with
 * a name (`Annotation.colorName`); the interface draws it from a theme token (`--hl-<name>`), so no
 * raw colour value lives in packages/ui. Zotero's imported `color` values are mapped to the nearest
 * name; the reference values below are Zotero's own palette and are used only for that mapping.
 */
export const HIGHLIGHT_COLOURS = ["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"] as const;
export type HighlightColourName = (typeof HIGHLIGHT_COLOURS)[number];

export const HIGHLIGHT_COLOUR_LABELS: Record<HighlightColourName, string> = {
  yellow: "Yellow",
  red: "Red",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
  orange: "Orange",
  grey: "Grey",
};

/** Zotero's reader palette: what an imported annotation's `color` is compared with. */
export const ZOTERO_REFERENCE_COLOURS: Record<HighlightColourName, string> = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  grey: "#aaaaaa",
};

export type Lab = [number, number, number];

function parseHex(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toLab([r8, g8, b8]: [number, number, number]): Lab {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r8), g = lin(g8), b = lin(b8);
  // sRGB (D65) to XYZ, normalised by the D65 white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu and Dalal's reference formulation). */
/** CIEDE2000 colour difference between two Lab colours (exported for its test). */
export function ciede2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T =
    1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) -
    0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

const NEUTRAL_CHROMA = 8;

const REFERENCE_LABS: [HighlightColourName, Lab][] = HIGHLIGHT_COLOURS.map((n) => [n, toLab(parseHex(ZOTERO_REFERENCE_COLOURS[n])!)]);

/**
 * The named colour nearest (CIEDE2000) to an imported `#rgb`, `#rrggbb` or `#rrggbbaa` value (alpha
 * is ignored); a near-neutral value is "grey"; "yellow" for anything else. A tie goes to the earlier name in HIGHLIGHT_COLOURS.
 */
export function nearestHighlightColour(hex: string): HighlightColourName {
  const rgb = typeof hex === "string" ? parseHex(hex) : undefined;
  if (!rgb) return "yellow";
  const lab = toLab(rgb);
  // Black, white and the greys have no hue, and CIEDE2000 alone would send black to purple: a
  // near-neutral value (Lab chroma under 8) is grey, the one neutral name.
  if (Math.hypot(lab[1], lab[2]) < NEUTRAL_CHROMA) return "grey";
  let best: HighlightColourName = "yellow";
  let bestD = Infinity;
  for (const [name, ref] of REFERENCE_LABS) {
    const d = ciede2000(lab, ref);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** The colour to show: the researcher's `colorName`, else the imported `color` mapped, else yellow. Never changes the record. */
export function highlightColourOf(a: { colorName?: HighlightColourName | undefined; color?: string | undefined }): HighlightColourName {
  if (a.colorName && (HIGHLIGHT_COLOURS as readonly string[]).includes(a.colorName)) return a.colorName;
  if (a.color) return nearestHighlightColour(a.color);
  return "yellow";
}
