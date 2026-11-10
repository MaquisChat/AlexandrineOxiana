/**
 * Applies the appearance settings to the document (spec 8A): `data-theme` (light | dark | light-hc |
 * dark-hc), the five font stacks, text scale, line spacing, density and motion, on <html>. With theme
 * or reduced motion set to "system" it follows `prefers-color-scheme` / `prefers-reduced-motion`,
 * live. Settings are loaded from and saved to the service (GET/PUT /settings/appearance) when a
 * client is given.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import { DEFAULT_APPEARANCE, FONT_SLOTS, applyPatch, checkAccent, type AppearancePatch, type AppearanceSettings, type FontSlot } from "./appearance";
import { fontStack, type FontChoice } from "./fonts";
import { THEMES, resolveTheme, type ThemeName } from "./themes";

export interface AppearanceContextValue {
  settings: AppearanceSettings;
  /** The theme in effect (after following the system and applying high contrast). */
  theme: ThemeName;
  /** Whether motion is reduced (setting, or the system's preference when set to "system"). */
  reducedMotion: boolean;
  /** Whether the custom accent (if any) passes contrast in the current theme and is in use. */
  accentApplied: boolean;
  /** Applies a change at once and saves it; resolves when saved (or the save failed). */
  update(patch: AppearancePatch): Promise<void>;
  /** Plain-language message when loading or saving failed. */
  saveError?: string;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function useAppearance(): AppearanceContextValue {
  const v = useContext(AppearanceContext);
  if (!v) throw new Error("useAppearance must be used inside <AppearanceProvider>");
  return v;
}

function useMedia(query: string): boolean {
  const mql = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null);
  const [matches, setMatches] = useState(() => mql()?.matches ?? false);
  useEffect(() => {
    const m = mql();
    if (!m) return;
    setMatches(m.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return matches;
}

const ACCENT_PROPS = ["--accent", "--accent-ink", "--on-accent"] as const;

export interface AppearanceProviderProps {
  /** The library service client; without one the settings live only in memory. */
  client?: Pick<ApiClient, "appearance">;
  /** Settings to start with (before the service answers). */
  initial?: AppearanceSettings;
  children?: ReactNode;
}

export function AppearanceProvider({ client, initial, children }: AppearanceProviderProps) {
  const [settings, setSettings] = useState<AppearanceSettings>(initial ?? DEFAULT_APPEARANCE);
  const [saveError, setSaveError] = useState<string | undefined>();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const systemReduce = useMedia("(prefers-reduced-motion: reduce)");
  // Set once the user changes something, so a slow initial load never overwrites that change.
  const changed = useRef(false);
  // Only the answer to the latest save is applied (an earlier, slower answer would undo a later change).
  const saveSeq = useRef(0);

  useEffect(() => {
    if (initial) setSettings(initial);
  }, [initial]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.appearance.get().then(
      (s) => {
        if (live && !changed.current) setSettings(s);
      },
      (err: unknown) => {
        if (live) setSaveError(`Couldn't load your appearance settings: ${messageOf(err)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const theme = resolveTheme(settings.theme, settings.highContrast, systemDark);
  const reducedMotion = settings.reducedMotion === "system" ? systemReduce : settings.reducedMotion === "on";
  const accent = settings.accent ? checkAccent(settings.accent, THEMES[theme], settings.highContrast) : null;
  const accentApplied = !!accent?.ok;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = settings.density;
    root.dataset.motion = reducedMotion ? "reduce" : "full";
    for (const slot of FONT_SLOTS) root.style.setProperty(`--font-${slot}`, safeStack(settings.fonts[slot], slot));
    root.style.setProperty("--text-scale", String(settings.textScale));
    root.style.setProperty("--line-spacing", String(settings.lineSpacing));
    if (settings.accent && accent?.ok && accent.onAccent) {
      root.style.setProperty("--accent", settings.accent.toUpperCase());
      root.style.setProperty("--accent-ink", settings.accent.toUpperCase());
      root.style.setProperty("--on-accent", accent.onAccent);
    } else {
      for (const p of ACCENT_PROPS) root.style.removeProperty(p);
    }
  }, [theme, reducedMotion, settings, accent?.ok, accent?.onAccent]);

  const update = useCallback(
    async (patch: AppearancePatch) => {
      changed.current = true;
      setSettings((cur) => applyPatch(cur, patch));
      if (!client) return;
      const seq = ++saveSeq.current;
      try {
        const saved = await client.appearance.put(patch);
        if (seq === saveSeq.current) {
          setSettings(saved);
          setSaveError(undefined);
        }
      } catch (err) {
        if (seq === saveSeq.current) setSaveError(`Couldn't save your appearance settings: ${messageOf(err)}`);
      }
    },
    [client],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({ settings, theme, reducedMotion, accentApplied, update, ...(saveError ? { saveError } : {}) }),
    [settings, theme, reducedMotion, accentApplied, update, saveError],
  );
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/** The stack for a stored choice; a family name that cannot be used falls back to the default. */
function safeStack(choice: FontChoice, slot: FontSlot): string {
  try {
    return fontStack(choice);
  } catch {
    return fontStack(DEFAULT_APPEARANCE.fonts[slot]);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "something went wrong.";
}
