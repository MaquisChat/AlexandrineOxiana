/**
 * The design tokens file (src/theme/tokens.css) as data: parsing it, the text/background pairs
 * every theme must pass, and the derivation of the high-contrast themes from light and dark.
 *
 * tokens.css is the only place colours are written (stylelint `color-no-hex` everywhere else). Its
 * light and dark blocks are the approved mockup's `.ao-light` / `.ao-dark` values plus the code
 * palette; the light-hc and dark-hc blocks are generated from them by `pnpm --filter @ao/ui
 * gen:tokens` and a test fails if they drift.
 *
 * Pure (no DOM, no Vite imports) so the generator script can use it under Node.
 */
import { NON_TEXT_MIN, TEXT_MIN_HC, contrastRatio, parseHex, toHex } from "./contrast";

export type ThemeName = "light" | "dark" | "light-hc" | "dark-hc";
export const THEME_NAMES: readonly ThemeName[] = ["light", "dark", "light-hc", "dark-hc"];
export type Tokens = Record<string, string>;

/** The tokens the brief requires in every theme (names without the leading `--`). */
export const BRIEF_TOKENS = [
  "bg", "surface", "surface-2", "ink", "ink-2", "ink-3", "muted", "line", "line-soft", "line-strong", "chip",
  "accent", "accent-ink", "on-accent", "accent-soft", "ok", "ok-soft", "ok-ink", "warn-soft", "warn-ink", "amber-ink",
  "deny", "violet-soft", "violet-ink",
] as const;

/**
 * Each text token and the backgrounds it is drawn on: always --bg and --surface, plus its own soft
 * background(s). --on-accent is only ever drawn on --accent.
 */
export const TEXT_PAIRS: readonly { fg: string; on: readonly string[] }[] = [
  { fg: "ink", on: ["bg", "surface", "surface-2", "chip"] },
  { fg: "ink-2", on: ["bg", "surface", "surface-2", "chip"] },
  { fg: "ink-3", on: ["bg", "surface", "surface-2", "chip"] },
  { fg: "muted", on: ["bg", "surface", "surface-2", "chip"] },
  { fg: "accent-ink", on: ["bg", "surface", "accent-soft", "accent-soft2"] },
  { fg: "accent-soft-ink", on: ["bg", "surface", "accent-soft", "accent-soft2"] },
  { fg: "ok-ink", on: ["bg", "surface", "ok-soft", "ok-soft2"] },
  { fg: "warn-ink", on: ["bg", "surface", "warn-soft"] },
  { fg: "warn-ink2", on: ["bg", "surface", "warn-soft"] },
  { fg: "amber-ink", on: ["bg", "surface", "warn-soft"] },
  { fg: "deny", on: ["bg", "surface", "warn-soft"] },
  { fg: "violet-ink", on: ["bg", "surface", "violet-soft", "violet-soft2"] },
  { fg: "on-accent", on: ["accent"] },
];

/** Borders that must stay visible in the high-contrast themes (WCAG 1.4.11, 3:1). */
const HC_BORDERS = ["line", "line-strong"] as const;

export const GENERATED_BEGIN = "/* BEGIN GENERATED: high-contrast themes, derived from light and dark by `pnpm --filter @ao/ui gen:tokens`. Do not edit by hand. */";
export const GENERATED_END = "/* END GENERATED */";

/** Every `[data-theme="…"]` block of tokens.css: its custom properties, in file order. */
export function parseTokens(css: string, required: readonly ThemeName[] = THEME_NAMES): Record<ThemeName, Tokens> {
  const out: Partial<Record<ThemeName, Tokens>> = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const theme = /\[data-theme="([a-z-]+)"\]/.exec(m[1]!)?.[1] as ThemeName | undefined;
    if (!theme || !THEME_NAMES.includes(theme)) continue;
    const tokens: Tokens = {};
    for (const d of m[2]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[d[1]!] = d[2]!.trim();
    out[theme] = tokens;
  }
  for (const t of required) if (!out[t]) throw new Error(`tokens.css has no [data-theme="${t}"] block`);
  return out as Record<ThemeName, Tokens>;
}

/** `hex` moved a fraction `t` of the way to black (light themes) or white (dark themes). */
function push(hex: string, mode: "light" | "dark", t: number): string {
  const target = mode === "light" ? 0 : 255;
  return toHex(parseHex(hex).map((c) => c + (target - c) * t));
}

/** The smallest push (in 1% steps) after which `ok(candidate)` holds. */
function pushUntil(hex: string, mode: "light" | "dark", ok: (c: string) => boolean): string {
  for (let i = 0; i <= 100; i++) {
    const c = push(hex, mode, i / 100);
    if (ok(c)) return c;
  }
  throw new Error(`cannot reach the required contrast for ${hex}`);
}

/**
 * High-contrast variant of a theme: each text token is moved towards black (light) or white
 * (dark), keeping its hue, just far enough to reach 7:1 on every background it is drawn on;
 * --accent is moved the same way until --on-accent reaches 7:1 on it; borders reach 3:1. Tokens
 * that already pass, and every background, are left as they are.
 */
export function deriveHighContrast(base: Tokens, mode: "light" | "dark"): Tokens {
  const out: Tokens = { ...base };
  const minOn = (fg: string, bgs: readonly string[]) => Math.min(...bgs.map((b) => contrastRatio(fg, out[b]!)));
  for (const { fg, on } of TEXT_PAIRS) {
    if (fg === "on-accent") continue;
    out[fg] = pushUntil(out[fg]!, mode, (c) => minOn(c, on) >= TEXT_MIN_HC);
  }
  out.accent = pushUntil(out.accent!, mode, (c) => contrastRatio(out["on-accent"]!, c) >= TEXT_MIN_HC);
  for (const b of HC_BORDERS) out[b] = pushUntil(out[b]!, mode, (c) => minOn(c, ["bg", "surface"]) >= NON_TEXT_MIN);
  return out;
}

function block(name: ThemeName, tokens: Tokens): string {
  const scheme = name.startsWith("dark") ? "dark" : "light";
  const lines = Object.entries(tokens).map(([k, v]) => `  --${k}: ${v};`);
  return `[data-theme="${name}"] {\n  color-scheme: ${scheme};\n${lines.join("\n")}\n}`;
}

/** The generated section of tokens.css for the given light and dark tokens. */
export function renderGenerated(light: Tokens, dark: Tokens): string {
  return [GENERATED_BEGIN, block("light-hc", deriveHighContrast(light, "light")), "", block("dark-hc", deriveHighContrast(dark, "dark")), GENERATED_END].join("\n");
}

/** tokens.css with its generated section rebuilt from its light and dark blocks. */
export function replaceGenerated(css: string): string {
  const start = css.indexOf(GENERATED_BEGIN);
  const end = css.indexOf(GENERATED_END);
  if (start < 0 || end < start) throw new Error("tokens.css has no generated section markers");
  const parsed = parseTokens(css, ["light", "dark"]);
  return css.slice(0, start) + renderGenerated(parsed.light, parsed.dark) + css.slice(end + GENERATED_END.length);
}
