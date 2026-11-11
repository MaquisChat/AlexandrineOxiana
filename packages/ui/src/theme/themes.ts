/**
 * The themes as data, read from tokens.css (the single place colours are written), for contrast
 * checks of custom accents and for code colours. The stylesheet itself applies the tokens through
 * `[data-theme]` on <html>.
 */
import tokensCss from "./tokens.css?raw";
import { parseTokens, type ThemeName, type Tokens } from "./tokenFile";

export type { ThemeName } from "./tokenFile";

export const THEMES: Record<ThemeName, Tokens> = parseTokens(tokensCss);

export const CODE_PALETTE_SIZE = 12;

/** The qualitative code colours of a theme (`--code-1` … `--code-12`). */
export function codeColors(theme: ThemeName): string[] {
  return Array.from({ length: CODE_PALETTE_SIZE }, (_, i) => {
    const c = THEMES[theme][`code-${i + 1}`];
    if (!c) throw new Error(`tokens.css: ${theme} has no --code-${i + 1}`);
    return c;
  });
}

/**
 * The current value of a token (without the leading "--"), as the page resolves it now; for canvas
 * drawing, where CSS cannot reach (`ctx.fillStyle = readToken("code-3")`; the colour scan allows
 * only this for canvas paint).
 */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

/** The theme to show for the settings and what the system prefers. */
export function resolveTheme(theme: "system" | "light" | "dark", highContrast: boolean, systemDark: boolean): ThemeName {
  const base = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return highContrast ? `${base}-hc` : base;
}
