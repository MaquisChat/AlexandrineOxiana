// Fits the qualitative code palette (--code-1 … --code-12) to the rules in src/theme/codePalette.ts
// (R103, R105), for the light and dark themes, by simulated annealing in CIELAB LCh:
//
//   - each code inside its family's per-theme L*/C*/hue band (moves are clamped to the band);
//   - inside the sRGB gamut;
//   - ≥ 3:1 against the theme's CODE_BACKGROUNDS (--bg, --surface, and --chip in dark);
//   - CIEDE2000 ≥ 15 between every pair with normal vision and ≥ 12 under simulated deuteranopia,
//     protanopia and tritanopia (Machado et al. 2009).
//
// Usage: pnpm --filter @ao/ui fit:palette [--theme light|dark] [--seeds 1,2,3] [--restarts 8]
//        [--iterations 60000] [--write]
// Prints the best palette per theme and its minimum ΔE values; --write puts passing palettes into
// tokens.css (and regenerates the high-contrast blocks). Deterministic for given seeds.
import { readFileSync, writeFileSync } from "node:fs";
import { CODE_BACKGROUNDS, CODE_FAMILIES, CODE_MIN_CONTRAST, CODE_MIN_DELTA_E, CODE_MIN_DELTA_E_CVD, bandProblem, type Band, type CodeFamily } from "../src/theme/codePalette";
import { CVD_KINDS, deltaE2000, labAs, labToHex, minPairwiseDeltaE, type Lab } from "../src/theme/colorVision";
import { contrastRatio } from "../src/theme/contrast";
import { parseTokens, replaceGenerated } from "../src/theme/tokenFile";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const themes = (arg("theme", "light,dark").split(",") as ("light" | "dark")[]);
const seeds = arg("seeds", "1,2,3,4").split(",").map(Number);
const RESTARTS = Number(arg("restarts", "8"));
const ITERATIONS = Number(arg("iterations", "60000"));
const WRITE = process.argv.includes("--write");
// Experiments: --families <file.json> replaces CODE_FAMILIES; --backgrounds bg,surface narrows the
// contrast backgrounds; --exempt drops the contrast rule for named families. None of these is used for the committed palette unless the rules change too.
const FAMILIES: readonly CodeFamily[] = process.argv.includes("--families") ? JSON.parse(readFileSync(arg("families", ""), "utf8")) : CODE_FAMILIES;
const bgOverride = process.argv.includes("--backgrounds") ? arg("backgrounds", "").split(",") : null;
const backgroundsOf = (theme: "light" | "dark"): readonly string[] => bgOverride ?? CODE_BACKGROUNDS[theme];
// --exempt gold,olive: families whose fill need not reach the contrast minimum (experiments only).
const EXEMPT = new Set(arg("exempt", "").split(",").filter(Boolean));

const tokensFile = new URL("../src/theme/tokens.css", import.meta.url);
const tokens = parseTokens(readFileSync(tokensFile, "utf8"), ["light", "dark"]);

// The margins aimed for, a little above the limits, so rounding to 8-bit hex never drops below them.
const AIM_N = CODE_MIN_DELTA_E + 0.4;
const AIM_C = CODE_MIN_DELTA_E_CVD + 0.3;

interface P {
  L: number;
  C: number;
  h: number;
}

const toHex = (p: P) => labToHex([p.L, p.C * Math.cos((p.h * Math.PI) / 180), p.C * Math.sin((p.h * Math.PI) / 180)]);
const hueSpan = ([a, b]: [number, number]) => (b - a + 360) % 360;
const clampBand = (p: P, band: Band): P => {
  const span = hueSpan(band.hue);
  let off = (p.h - band.hue[0] + 360) % 360;
  if (off > span) off = off - span < 360 - off ? span : 0;
  return {
    L: Math.min(band.L[1], Math.max(band.L[0], p.L)),
    C: Math.min(band.C[1], Math.max(band.C[0], p.C)),
    h: (band.hue[0] + off) % 360,
  };
};

function energy(ps: P[], bgs: string[]): { e: number; hexes: string[] } {
  let e = 0;
  const hexes: string[] = [];
  ps.forEach((p, i) => {
    const { hex, outOfGamut } = toHex(p);
    hexes.push(hex);
    e += outOfGamut * 4000;
    if (EXEMPT.has(FAMILIES[i]!.name)) return;
    for (const bg of bgs) e += Math.max(0, CODE_MIN_CONTRAST + 0.03 - contrastRatio(hex, bg)) * 200;
  });
  for (const kind of [null, ...CVD_KINDS]) {
    const aim = kind ? AIM_C : AIM_N;
    const labs: Lab[] = hexes.map((h) => labAs(h, kind));
    for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) e += Math.max(0, aim - deltaE2000(labs[i]!, labs[j]!)) ** 2;
  }
  return { e, hexes };
}

function fit(theme: "light" | "dark", seed: number) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  // Fit inside slightly shrunk bands, so rounding to 8-bit hex never lands outside the real ones.
  const bands = FAMILIES.map((f): Band => {
    const b = f[theme];
    return { L: [b.L[0] + 0.7, b.L[1] - 0.7], C: [b.C[0] + 1, b.C[1] - 1], hue: [(b.hue[0] + 1.5) % 360, (b.hue[1] + 358.5) % 360] };
  });
  const bgs = backgroundsOf(theme).map((b) => tokens[theme][b]!);
  let best: { e: number; hexes: string[] } | null = null;
  for (let r = 0; r < RESTARTS; r++) {
    let cur: P[] = bands.map((b) => clampBand({ L: b.L[0] + rnd() * (b.L[1] - b.L[0]), C: b.C[0] + rnd() * Math.min(40, b.C[1] - b.C[0]), h: b.hue[0] + rnd() * hueSpan(b.hue) }, b));
    let ce = energy(cur, bgs);
    const T0 = 20;
    const T1 = 0.001;
    for (let it = 0; it < ITERATIONS; it++) {
      const t = T0 * (T1 / T0) ** (it / ITERATIONS);
      const k = Math.floor(rnd() * cur.length);
      const step = 0.1 + Math.min(1, t / 5);
      const p = { ...cur[k]! };
      const w = Math.floor(rnd() * 3);
      if (w === 0) p.L += (rnd() - 0.5) * 8 * step;
      else if (w === 1) p.C += (rnd() - 0.5) * 16 * step;
      else p.h += (rnd() - 0.5) * 12 * step;
      const next = cur.slice();
      next[k] = clampBand(p, bands[k]!);
      const ne = energy(next, bgs);
      if (ne.e <= ce.e || rnd() < Math.exp((ce.e - ne.e) / t)) {
        cur = next;
        ce = ne;
      }
    }
    if (!best || ce.e < best.e) best = ce;
  }
  return best!;
}

function report(theme: "light" | "dark", hexes: string[]) {
  const bgs = backgroundsOf(theme).map((b) => tokens[theme][b]!);
  const de = Object.fromEntries([null, ...CVD_KINDS].map((k) => [k ?? "normal", +minPairwiseDeltaE(hexes, k).toFixed(2)]));
  const minContrast = +Math.min(...hexes.flatMap((h, i) => (EXEMPT.has(FAMILIES[i]!.name) ? [] : bgs.map((b) => contrastRatio(h, b))))).toFixed(2);
  const bandIssues = hexes.map((h, i) => bandProblem(h, FAMILIES[i]![theme])).filter(Boolean);
  const ok = de.normal! >= CODE_MIN_DELTA_E && CVD_KINDS.every((k) => de[k]! >= CODE_MIN_DELTA_E_CVD) && minContrast >= CODE_MIN_CONTRAST && bandIssues.length === 0;
  return { ok, de, minContrast, bandIssues };
}

const chosen: Partial<Record<"light" | "dark", string[]>> = {};
for (const theme of themes) {
  let pick: { hexes: string[]; score: number } | null = null;
  for (const seed of seeds) {
    const { hexes } = fit(theme, seed);
    const r = report(theme, hexes);
    const score = Math.min(r.de.normal! - CODE_MIN_DELTA_E, ...CVD_KINDS.map((k) => r.de[k]! - CODE_MIN_DELTA_E_CVD)) + (r.ok ? 100 : 0);
    console.log(JSON.stringify({ theme, seed, ...r, colors: hexes }));
    if (!pick || score > pick.score) pick = { hexes, score };
  }
  if (pick && pick.score >= 100) chosen[theme] = pick.hexes;
}

if (WRITE) {
  let css = readFileSync(tokensFile, "utf8");
  for (const theme of ["light", "dark"] as const) {
    const hexes = chosen[theme];
    if (!hexes) continue;
    const start = css.indexOf(theme === "light" ? '[data-theme="light"] {' : '[data-theme="dark"] {');
    const end = css.indexOf("}", start);
    let block = css.slice(start, end);
    hexes.forEach((h, i) => (block = block.replace(new RegExp(`--code-${i + 1}: #[0-9A-F]{6};`), `--code-${i + 1}: ${h};`)));
    css = css.slice(0, start) + block + css.slice(end);
  }
  writeFileSync(tokensFile, replaceGenerated(css));
  console.log(`wrote ${Object.keys(chosen).join(", ") || "nothing (no passing palette)"} to tokens.css`);
}
