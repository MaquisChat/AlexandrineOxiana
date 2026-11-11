/**
 * Colour difference and colour-vision-deficiency simulation, for checking that the qualitative
 * code palette stays distinguishable (spec 8A.1).
 *
 *  - CIELAB from sRGB (IEC 61966-2-1, D65 white).
 *  - CIEDE2000 (ΔE00), following Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference
 *    Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations".
 *  - Dichromacy simulation with the Machado, Oliveira & Fernandes (2009) matrices at severity 1.0
 *    ("A Physiologically-based Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6)),
 *    applied to linear RGB and clamped to the gamut.
 */
import { parseHex, toHex, toLinear } from "./contrast";

export type Lab = [number, number, number];
export type CvdKind = "protanopia" | "deuteranopia" | "tritanopia";
export const CVD_KINDS: readonly CvdKind[] = ["deuteranopia", "protanopia", "tritanopia"];

/** Row-major 3×3 matrices on linear RGB (Machado et al. 2009, Table 1, severity 1.0). */
export const MACHADO_2009: Record<CvdKind, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function linearRgb(hex: string): [number, number, number] {
  return parseHex(hex).map((v) => toLinear(v / 255)) as [number, number, number];
}

function linearToLab([r, g, b]: [number, number, number]): Lab {
  // sRGB (D65) → XYZ, normalised by the D65 white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB → linear sRGB (unclamped: channels outside 0–1 are out of gamut). */
export function labToLinear([L, a, b]: Lab): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}

/** CIELAB → `#RRGGBB` (clamped), and how far outside the sRGB gamut it was (0 when inside). */
export function labToHex(lab: Lab): { hex: string; outOfGamut: number } {
  const lin = labToLinear(lab);
  const outOfGamut = lin.reduce((s, v) => s + Math.max(0, v - 1, -v), 0);
  return { hex: toHex(lin.map((c) => toGamma(clamp01(c)) * 255)), outOfGamut };
}

export function hexToLab(hex: string): Lab {
  return linearToLab(linearRgb(hex));
}

function simulateLinear(hex: string, kind: CvdKind): [number, number, number] {
  const [r, g, b] = linearRgb(hex);
  const m = MACHADO_2009[kind];
  return [
    clamp01(m[0]! * r + m[1]! * g + m[2]! * b),
    clamp01(m[3]! * r + m[4]! * g + m[5]! * b),
    clamp01(m[6]! * r + m[7]! * g + m[8]! * b),
  ];
}

/** How `hex` appears with the given dichromacy, as `#RRGGBB`. */
export function simulate(hex: string, kind: CvdKind): string {
  return toHex(simulateLinear(hex, kind).map((c) => toGamma(c) * 255));
}

/** CIELAB of `hex` as seen with `kind` (null: normal vision), without rounding to 8 bits. */
export function labAs(hex: string, kind: CvdKind | null): Lab {
  return kind ? linearToLab(simulateLinear(hex, kind)) : hexToLab(hex);
}

const RAD = Math.PI / 180;

/** CIEDE2000 colour difference (kL = kC = kH = 1). */
export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / RAD;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * RAD) + 0.24 * Math.cos(2 * hbp * RAD) + 0.32 * Math.cos((3 * hbp + 6) * RAD) - 0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * RAD) * RC;
  const l = dLp / SL;
  const c = dCp / SC;
  const h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

/** Smallest ΔE00 between any two of `colors`, as seen with `kind` (null: normal vision). */
export function minPairwiseDeltaE(colors: readonly string[], kind: CvdKind | null): number {
  const labs = colors.map((c) => labAs(c, kind));
  let min = Infinity;
  for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) min = Math.min(min, deltaE2000(labs[i]!, labs[j]!));
  return min;
}
