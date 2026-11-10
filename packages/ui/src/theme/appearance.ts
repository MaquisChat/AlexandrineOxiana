/**
 * Appearance settings (spec 8A), as stored by the library service in `appearance.json` and served at
 * GET/PUT /settings/appearance (apps/library-service/src/routes/appearance.ts; the shapes match).
 */
import { TEXT_MIN, TEXT_MIN_HC, contrastRatio } from "./contrast";
import { GOUDY_STACK, MONO_STACK, type FontChoice } from "./fonts";
import type { Tokens } from "./tokenFile";

export type { FontChoice } from "./fonts";

export type FontSlot = "interface" | "reading" | "transcript" | "notes" | "mono";
export const FONT_SLOTS: readonly FontSlot[] = ["interface", "reading", "transcript", "notes", "mono"];

export interface AppearanceSettings {
  theme: "system" | "light" | "dark";
  highContrast: boolean;
  accent?: string;
  fonts: Record<FontSlot, FontChoice>;
  textScale: 0.875 | 1 | 1.125 | 1.25 | 1.5;
  lineSpacing: 1.3 | 1.5 | 1.8;
  density: "comfortable" | "compact";
  reducedMotion: "system" | "on" | "off";
}

/** A PUT body: any subset of the settings; `accent: null` goes back to the theme's accent. */
export type AppearancePatch = Partial<Omit<AppearanceSettings, "accent" | "fonts">> & {
  accent?: string | null;
  fonts?: Partial<Record<FontSlot, FontChoice>>;
};

export const TEXT_SCALES: readonly AppearanceSettings["textScale"][] = [0.875, 1, 1.125, 1.25, 1.5];
export const LINE_SPACINGS: readonly AppearanceSettings["lineSpacing"][] = [1.3, 1.5, 1.8];

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  highContrast: false,
  fonts: {
    interface: { family: GOUDY_STACK, source: "bundled" },
    reading: { family: GOUDY_STACK, source: "bundled" },
    transcript: { family: GOUDY_STACK, source: "bundled" },
    notes: { family: GOUDY_STACK, source: "bundled" },
    mono: { family: MONO_STACK, source: "system" },
  },
  textScale: 1,
  lineSpacing: 1.5,
  density: "comfortable",
  reducedMotion: "system",
};

export const ACCENT_TOO_LOW = "This accent color is too low-contrast for text";

export interface AccentCheck {
  ok: boolean;
  /** The text colour drawn on the accent (the theme's on-accent, or its ink/background if better). */
  onAccent?: string;
}

/**
 * Whether a custom accent may be used with a theme: as text it must reach 4.5:1 (7:1 in a
 * high-contrast theme) on --bg, --surface and the soft accent backgrounds, and some theme text colour must reach the same on
 * it (for labels on accent buttons).
 */
export function checkAccent(accent: string, theme: Tokens, highContrast: boolean): AccentCheck {
  const min = highContrast ? TEXT_MIN_HC : TEXT_MIN;
  let asText: number;
  try {
    // As --accent-ink it is also drawn on the theme's soft accent backgrounds.
    const bgs = ["bg", "surface", "accent-soft", "accent-soft2"].map((k) => theme[k]).filter((c): c is string => !!c);
    asText = Math.min(...bgs.map((bg) => contrastRatio(accent, bg)));
  } catch {
    return { ok: false };
  }
  if (asText < min) return { ok: false };
  const candidates = [theme["on-accent"]!, theme.bg!, theme.ink!];
  const best = candidates.reduce((a, b) => (contrastRatio(b, accent) > contrastRatio(a, accent) ? b : a));
  return contrastRatio(best, accent) >= min ? { ok: true, onAccent: best } : { ok: false };
}

/** Merges a patch into settings, as the service does. */
export function applyPatch(cur: AppearanceSettings, patch: AppearancePatch): AppearanceSettings {
  const next: AppearanceSettings = { ...cur, fonts: { ...cur.fonts } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "fonts") Object.assign(next.fonts, v);
    else if (k === "accent") {
      if (v === null) delete next.accent;
      else next.accent = v as string;
    } else (next as unknown as Record<string, unknown>)[k] = v;
  }
  return next;
}
