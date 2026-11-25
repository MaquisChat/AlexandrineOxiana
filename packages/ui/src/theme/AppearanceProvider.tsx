/**
 * Applies the appearance settings to the document (spec 8A): `data-theme` (light | dark | light-hc |
 * dark-hc), the five font stacks, text scale, line spacing, density and motion, on <html>. With theme
 * or reduced motion set to "system" it follows `prefers-color-scheme` / `prefers-reduced-motion`,
 * live. Settings are loaded from and saved to the service (GET/PUT /settings/appearance) when a
 * client is given.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isUsableFontFamily, isUserFontId } from "@ao/shared";
import { ApiClientError, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, readWithin } from "../api/firstRead";
import { canLoadFaces, fontsApi, loadUserFace, type FontsApi, type FontsClient } from "../api/fonts";
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
  /**
   * Plain-language message when saving failed. A change that failed to save stays on
   * screen, and the message stays, until retrySave() saves it (R109).
   */
  saveError?: string;
  /**
   * The service's `reason` for the last failure, when it gave one: "appearance" means the settings
   * file cannot be read, and the screen offers its reset (Task 68).
   */
  saveErrorReason?: string;
  /** Sends the changes that failed to save again. */
  retrySave(): Promise<void>;
  /** Plain-language message when loading the saved settings failed (kept apart from saving, FR-155). */
  loadError?: string;
  /** Asks the service for the saved settings again after a failed load. */
  retryLoad(): void;
  /** The researcher's own font files (R100), when the service is connected. */
  fonts?: FontsApi;
  /** Plain-language message when a chosen font file could not be loaded (its fallbacks are used). */
  fontError?: string;
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
  /**
   * The library service client; without one the settings live only in memory. With `request` and
   * `bytes` too, fonts from the researcher's own files are loaded from the service (R100).
   */
  client?: Pick<ApiClient, "appearance"> & Partial<Pick<ApiClient, "request" | "bytes">>;
  /** Settings to start with (before the service answers). */
  initial?: AppearanceSettings;
  /**
   * FR-756: how long the read of the saved settings is waited for (smaller in tests). Given up, it is a failed load:
   * the same alert and "Try loading again", with "The library service did not answer in time.".
   */
  firstReadMs?: number;
  children?: ReactNode;
}

export function AppearanceProvider({ client, initial, children, firstReadMs = FIRST_READ_TIMEOUT_MS }: AppearanceProviderProps) {
  const [settings, setSettings] = useState<AppearanceSettings>(initial ?? DEFAULT_APPEARANCE);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saveErrorReason, setSaveErrorReason] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  // Bumped by retryLoad() to read the saved settings again.
  const [loadTry, setLoadTry] = useState(0);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const systemReduce = useMedia("(prefers-reduced-motion: reduce)");
  // Set once the user changes something, so a slow initial load never overwrites that change.
  const changed = useRef(false);
  // Saving (R105 I1): at most one PUT in flight. Changes made meanwhile are merged into one pending
  // patch, sent when the PUT in flight answers; each update() resolves when its change was sent.
  // Changes whose save failed are kept in `failed`: still shown, and overlaid on later answers.
  const saving = useRef<SaveQueue>({ busy: false, pending: null, failed: null, waiting: [] });

  // `initial` is applied once, when the provider mounts (a later value does not reset the user's choices).

  useEffect(() => {
    if (!client) return;
    let live = true;
    // FR-756: a read that never settles is given up after `firstReadMs` (its request cancelled; a late answer changes nothing).
    const ac = new AbortController();
    readWithin((signal) => client.appearance.get({ signal }), firstReadMs, ac.signal).then(
      (s) => {
        if (!live) return;
        setLoadError(undefined);
        if (!changed.current) setSettings((cur) => keepLocalGenerics(s, cur));
      },
      (err: unknown) => {
        if (live) setLoadError(`Couldn't load your appearance settings: ${messageOf(err)}`);
      },
    );
    return () => {
      live = false;
      ac.abort();
    };
  }, [client, loadTry, firstReadMs]);
  const retryLoad = useCallback(() => setLoadTry((n) => n + 1), []);

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
    (patch: AppearancePatch): Promise<void> => {
      changed.current = true;
      setSettings((cur) => applyPatch(cur, patch));
      if (!client) return Promise.resolve();
      const q = saving.current;
      q.pending = mergePatch(q.pending, patch);
      const done = new Promise<void>((resolve) => q.waiting.push(resolve));
      if (!q.busy) void drain(client, q);
      return done;
    },
    [client],
  );

  async function drain(c: Pick<ApiClient, "appearance">, q: typeof saving.current) {
    q.busy = true;
    while (q.pending) {
      const patchNow = q.pending;
      const waiting = q.waiting;
      q.pending = null;
      q.waiting = [];
      try {
        const saved = await c.appearance.put(patchNow);
        q.failed = withoutKeysOf(q.failed, patchNow); // a newer value for the same setting was saved
        // Changes made while this PUT was in flight, and changes that failed to save, stay on screen;
        // a font's generic family the service did not keep is kept from the local value.
        setSettings((cur) => {
          let next = keepLocalGenerics(saved, cur);
          if (q.failed) next = applyPatch(next, q.failed);
          if (q.pending) next = applyPatch(next, q.pending);
          return next;
        });
        if (!q.failed) {
          setSaveError(undefined);
          setSaveErrorReason(undefined);
        }
      } catch (err) {
        q.failed = mergePatch(q.failed, patchNow);
        setSaveError(`Couldn't save your appearance settings: ${messageOf(err)}`);
        setSaveErrorReason(err instanceof ApiClientError ? err.reason : undefined);
      }
      for (const w of waiting) w();
    }
    q.busy = false;
  }

  const retrySave = useCallback((): Promise<void> => {
    const q = saving.current;
    const f = q.failed;
    if (!f) return Promise.resolve();
    q.failed = null;
    return update(f);
  }, [update]);

  // ---- fonts from the researcher's own files (R100): loaded from the service's bytes ----
  const fonts = useMemo(() => (client && typeof client.request === "function" && typeof client.bytes === "function" ? fontsApi(client as FontsClient) : undefined), [client]);
  const wantedFaces = userFaceKeys(settings);
  const faces = useRef(new Map<string, { ctl: AbortController; remove?: () => void }>());
  const [faceErrors, setFaceErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!fonts || !canLoadFaces()) return;
    const wanted = new Map(wantedFaces.split("\n").filter(Boolean).map((k) => [k, splitFaceKey(k)] as const));
    const reg = faces.current;
    for (const [k, e] of reg) {
      if (wanted.has(k)) continue;
      e.ctl.abort();
      e.remove?.();
      reg.delete(k);
      setFaceErrors((cur) => (k in cur ? withoutKey(cur, k) : cur));
    }
    for (const [k, { family, id }] of wanted) {
      if (reg.has(k)) continue;
      const entry: { ctl: AbortController; remove?: () => void } = { ctl: new AbortController() };
      reg.set(k, entry);
      loadUserFace(fonts, family, id, entry.ctl.signal).then(
        (remove) => {
          if (reg.get(k) === entry) entry.remove = remove;
          else remove(); // no longer chosen while it loaded
        },
        (err: unknown) => {
          if (reg.get(k) !== entry || entry.ctl.signal.aborted) return;
          // Kept as failed (not retried in a loop); choosing it again tries again.
          // The service's own words; the browser's (a refused face) are replaced by plain ones.
          const why = err instanceof ApiClientError ? err.message : "This browser could not use the file as a font.";
          setFaceErrors((cur) => ({ ...cur, [k]: `The font “${family}” could not be loaded, so the fallback typefaces are used. ${why}` }));
        },
      );
    }
  }, [fonts, wantedFaces]);
  useEffect(
    () => () => {
      for (const e of faces.current.values()) {
        e.ctl.abort();
        e.remove?.();
      }
      faces.current.clear();
    },
    [],
  );
  const fontError = Object.values(faceErrors)[0];

  const value = useMemo<AppearanceContextValue>(
    () => ({ settings, theme, reducedMotion, accentApplied, update, retrySave, retryLoad, ...(loadError ? { loadError } : {}), ...(saveError ? { saveError } : {}), ...(saveError && saveErrorReason ? { saveErrorReason } : {}), ...(fonts ? { fonts } : {}), ...(fontError ? { fontError } : {}) }),
    [settings, theme, reducedMotion, accentApplied, update, retrySave, retryLoad, loadError, saveError, saveErrorReason, fonts, fontError],
  );
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/** The faces from the researcher's own files the settings choose, as one stable string ("id\0family" per line). */
function userFaceKeys(s: AppearanceSettings): string {
  const keys = new Set<string>();
  for (const slot of FONT_SLOTS) {
    const f = s.fonts[slot];
    if (f.source === "user-file" && isUserFontId(f.file) && isUsableFontFamily(f.family) && !/[,'"]/.test(f.family)) keys.add(`${f.file}\u0000${f.family}`);
  }
  return [...keys].sort().join("\n");
}

function splitFaceKey(k: string): { id: string; family: string } {
  const at = k.indexOf("\u0000");
  return { id: k.slice(0, at), family: k.slice(at + 1) };
}

function withoutKey(o: Record<string, string>, k: string): Record<string, string> {
  const { [k]: _gone, ...rest } = o;
  return rest;
}

/** The stack for a stored choice; a family name that cannot be used falls back to the default. */
function safeStack(choice: FontChoice, slot: FontSlot): string {
  try {
    return fontStack(choice);
  } catch {
    return fontStack(DEFAULT_APPEARANCE.fonts[slot]);
  }
}

interface SaveQueue {
  busy: boolean;
  pending: AppearancePatch | null;
  failed: AppearancePatch | null;
  waiting: (() => void)[];
}

/**
 * The service's answer, with each font's `generic` taken from the local value when the answer has
 * none for the same face (the service does not store it yet; R109).
 */
function keepLocalGenerics(answer: AppearanceSettings, local: AppearanceSettings): AppearanceSettings {
  const fonts = { ...answer.fonts };
  for (const slot of FONT_SLOTS) {
    const a = fonts[slot];
    const l = local.fonts[slot];
    if (a && !a.generic && l?.generic && l.family === a.family && l.source === a.source) fonts[slot] = { ...a, generic: l.generic };
  }
  return { ...answer, fonts };
}

/** `failed` without the settings that `saved` covered (null when nothing is left). */
function withoutKeysOf(failed: AppearancePatch | null, saved: AppearancePatch): AppearancePatch | null {
  if (!failed) return null;
  const out: AppearancePatch = { ...failed };
  for (const k of Object.keys(saved) as (keyof AppearancePatch)[]) if (k !== "fonts") delete out[k];
  if (out.fonts && saved.fonts) {
    const fonts = { ...out.fonts };
    for (const slot of Object.keys(saved.fonts) as FontSlot[]) delete fonts[slot];
    if (Object.keys(fonts).length) out.fonts = fonts;
    else delete out.fonts;
  }
  return Object.keys(out).length ? out : null;
}

/** Two patches as one: later values win; font slots merge. */
function mergePatch(a: AppearancePatch | null, b: AppearancePatch): AppearancePatch {
  if (!a) return { ...b, ...(b.fonts ? { fonts: { ...b.fonts } } : {}) };
  const out: AppearancePatch = { ...a, ...b };
  if (a.fonts || b.fonts) out.fonts = { ...a.fonts, ...b.fonts };
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "something went wrong.";
}
