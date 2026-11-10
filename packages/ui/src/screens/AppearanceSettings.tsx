/**
 * The Appearance settings page (spec 8A): theme, high contrast, accent colour, the five typefaces,
 * text size, line spacing, density and motion. Every change is applied at once and saved through
 * PUT /settings/appearance (by AppearanceProvider).
 *
 * Fonts from a user's file (`source: "user-file"`) are shown here when set, but picking a file is
 * done through the desktop shell (Tasks 33, 37): the UI never reads files itself.
 */
import { useId, useState, type ChangeEvent } from "react";
import { UserText } from "../components/UserText";
import { ACCENT_TOO_LOW, FONT_SLOTS, LINE_SPACINGS, TEXT_SCALES, checkAccent, type AppearancePatch, type AppearanceSettings, type FontSlot } from "../theme/appearance";
import { useAppearance } from "../theme/AppearanceProvider";
import { FONT_PRESETS, type FontChoice } from "../theme/fonts";
import { THEMES } from "../theme/themes";
import "./AppearanceSettings.css";

const SLOT_LABELS: Record<FontSlot, string> = {
  interface: "Interface",
  reading: "Reading view",
  transcript: "Transcripts and translations",
  notes: "Notes and memos",
  mono: "Monospace",
};

const SAMPLE: Record<FontSlot, string> = {
  interface: "Library · Sources · Collections — Ελληνικά, Кириллица",
  reading: "The quick brown fox jumps over the lazy dog. العربية — עברית",
  transcript: "00:01:12 — «Bonjour à tous» · 你好，世界 · नमस्ते",
  notes: "Memo: coding pass two, revisit theme 3. 한국어 · 日本語",
  mono: "smith2024-goudy  sha256:9f86d081  [a1b2]",
};

const CUSTOM = "__custom";

function FontPicker({ slot, choice, onChoose }: { slot: FontSlot; choice: FontChoice; onChoose: (c: FontChoice) => void }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const label = SLOT_LABELS[slot];
  const preset = FONT_PRESETS.find((p) => p.family === choice.family && p.source === choice.source);
  const customLabel = choice.source === "user-file" ? `From file: ${choice.family}${choice.file ? ` (${choice.file.split(/[\\/]/).pop()})` : ""}` : `Installed: ${choice.family}`;

  return (
    <div className="ao-font-row">
      <label htmlFor={`${id}-select`}>{label} typeface</label>
      <select
        id={`${id}-select`}
        value={preset ? preset.family : CUSTOM}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => {
          const p = FONT_PRESETS.find((x) => x.family === e.target.value);
          if (p) onChoose({ family: p.family, source: p.source });
        }}
      >
        {FONT_PRESETS.map((p) => (
          <option key={p.family} value={p.family}>
            {p.label}
          </option>
        ))}
        {!preset && <option value={CUSTOM}>{customLabel}</option>}
      </select>
      <form
        className="ao-font-typed"
        onSubmit={(e) => {
          e.preventDefault();
          const family = typed.trim();
          if (family && !/[;{}<>\\]/.test(family)) {
            onChoose({ family, source: "system" });
            setTyped("");
          }
        }}
      >
        <input type="text" aria-label={`Installed font for ${label}`} placeholder="Another installed font" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button type="submit" aria-label={`Use installed font for ${label}`}>
          Use
        </button>
      </form>
      <UserText as="p" className={`ao-font-sample ao-font-sample--${slot}`} data-testid="font-sample">
        {SAMPLE[slot]}
      </UserText>
    </div>
  );
}

function RadioGroup<T extends string>({ legend, name, value, options, onChange }: { legend: string; name: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <fieldset className="ao-fieldset">
      <legend>{legend}</legend>
      {options.map(([v, text]) => (
        <span key={v} className="ao-choice">
          <input type="radio" id={`${id}-${v}`} name={`${name}-${id}`} value={v} checked={value === v} onChange={() => onChange(v)} />
          <label htmlFor={`${id}-${v}`}>{text}</label>
        </span>
      ))}
    </fieldset>
  );
}

export function AppearanceSettingsScreen() {
  const { settings, theme, accentApplied, update, saveError } = useAppearance();
  const id = useId();
  const [rejectedAccent, setRejectedAccent] = useState<string | null>(null);
  const showAccentWarning = rejectedAccent !== null || (!!settings.accent && !accentApplied);

  const set = (patch: AppearancePatch) => void update(patch);

  const onAccent = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(value)) return;
    if (!checkAccent(value, THEMES[theme], settings.highContrast).ok) {
      setRejectedAccent(value);
      return;
    }
    setRejectedAccent(null);
    void update({ accent: value });
  };

  return (
    <main className="ao-appearance" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Appearance</h1>

      <section aria-labelledby={`${id}-theme`}>
        <h2 id={`${id}-theme`}>Theme</h2>
        <RadioGroup
          legend="Color theme"
          name="theme"
          value={settings.theme}
          options={[
            ["system", "Follow system"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(v) => set({ theme: v })}
        />
        <span className="ao-choice">
          <input type="checkbox" id={`${id}-hc`} checked={settings.highContrast} onChange={(e) => set({ highContrast: e.target.checked })} />
          <label htmlFor={`${id}-hc`}>High contrast</label>
        </span>

        <div className="ao-accent">
          <label htmlFor={`${id}-accent`}>Accent color</label>
          <input type="color" id={`${id}-accent`} value={(rejectedAccent ?? settings.accent ?? THEMES[theme].accent!).toLowerCase()} onChange={onAccent} aria-describedby={showAccentWarning ? `${id}-accent-warning` : undefined} />
          <button
            type="button"
            onClick={() => {
              setRejectedAccent(null);
              void update({ accent: null });
            }}
          >
            Use the theme's accent
          </button>
          {showAccentWarning && (
            <p role="alert" id={`${id}-accent-warning`} className="ao-warning">
              {ACCENT_TOO_LOW}. It has not been applied; the theme's accent is used instead.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby={`${id}-type`}>
        <h2 id={`${id}-type`}>Typefaces</h2>
        <p className="ao-hint">
          Goudy Old Style is used when it is installed on this computer; otherwise the bundled Sorts Mill Goudy. Text in other scripts falls back to Noto and system fonts.
        </p>
        {FONT_SLOTS.map((slot) => (
          <FontPicker key={slot} slot={slot} choice={settings.fonts[slot]} onChoose={(c) => set({ fonts: { [slot]: c } })} />
        ))}
      </section>

      <section aria-labelledby={`${id}-size`}>
        <h2 id={`${id}-size`}>Size and spacing</h2>
        <div className="ao-field">
          <label htmlFor={`${id}-scale`}>Text size</label>
          <select id={`${id}-scale`} value={String(settings.textScale)} onChange={(e) => set({ textScale: Number(e.target.value) as AppearanceSettings["textScale"] })}>
            {TEXT_SCALES.map((s) => (
              <option key={s} value={String(s)}>
                {`${s * 100}%`}
              </option>
            ))}
          </select>
        </div>
        <div className="ao-field">
          <label htmlFor={`${id}-spacing`}>Line spacing</label>
          <select id={`${id}-spacing`} value={String(settings.lineSpacing)} onChange={(e) => set({ lineSpacing: Number(e.target.value) as AppearanceSettings["lineSpacing"] })}>
            {LINE_SPACINGS.map((s) => (
              <option key={s} value={String(s)}>
                {String(s)}
              </option>
            ))}
          </select>
        </div>
        <RadioGroup
          legend="Density"
          name="density"
          value={settings.density}
          options={[
            ["comfortable", "Comfortable"],
            ["compact", "Compact"],
          ]}
          onChange={(v) => set({ density: v })}
        />
        <RadioGroup
          legend="Motion"
          name="motion"
          value={settings.reducedMotion}
          options={[
            ["system", "Use system setting"],
            ["on", "Reduce motion"],
            ["off", "Full motion"],
          ]}
          onChange={(v) => set({ reducedMotion: v })}
        />
      </section>

      {saveError && (
        <p role="alert" className="ao-warning">
          {saveError}
        </p>
      )}
    </main>
  );
}
