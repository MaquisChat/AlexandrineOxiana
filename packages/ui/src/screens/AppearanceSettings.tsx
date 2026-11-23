/**
 * The Appearance settings page (spec 8A): theme, high contrast, accent colour, the five typefaces,
 * text size, line spacing, density and motion. Every change is applied at once and saved through
 * PUT /settings/appearance (by AppearanceProvider).
 *
 * Fonts from the researcher's own files (`source: "user-file"`, R100): added by path in "Your own
 * font files", checked and kept by the service, offered in every typeface picker, and loaded from the
 * service's bytes by AppearanceProvider. The UI never reads a file itself.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import type { FontsApi, UserFont } from "../api/fonts";
import { errorText } from "../api/library";
import { ChoiceDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import { isAbsolutePath, PATH_HINT } from "./import/shared";
import { ACCENT_TOO_LOW, FONT_SLOTS, LINE_SPACINGS, TEXT_SCALES, checkAccent, type AppearancePatch, type AppearanceSettings, type FontSlot } from "../theme/appearance";
import { useAppearance } from "../theme/AppearanceProvider";
import { FONT_PRESETS, genericOf, isUsableFamily, type FontChoice } from "../theme/fonts";
import { THEMES } from "../theme/themes";
import { PathField } from "../components/PathField";
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

/** The accent picker saves this long after the last change (a drag fires many changes; R105 I1). */
export const ACCENT_DEBOUNCE_MS = 300;

const FILE_PREFIX = "file:";

function FontPicker({ slot, choice, userFonts, onChoose }: { slot: FontSlot; choice: FontChoice; userFonts: UserFont[]; onChoose: (c: FontChoice) => void }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);
  const label = SLOT_LABELS[slot];
  const preset = FONT_PRESETS.find((p) => p.family === choice.family && p.source === choice.source);
  const ownFile = choice.source === "user-file" ? userFonts.find((f) => f.id === choice.file && f.name === choice.family) : undefined;
  const customLabel = choice.source === "user-file" ? `From file: ${choice.family}` : `Installed: ${choice.family}`;

  return (
    <div className="ao-font-row">
      <label htmlFor={`${id}-select`}>{label} typeface</label>
      <select
        id={`${id}-select`}
        value={preset ? preset.family : ownFile ? `${FILE_PREFIX}${ownFile.id}` : CUSTOM}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => {
          const v = e.target.value;
          if (v.startsWith(FILE_PREFIX)) {
            const f = userFonts.find((x) => `${FILE_PREFIX}${x.id}` === v);
            // A face from a file has no known kind: monospace in the monospace slot, else serif.
            if (f) onChoose({ family: f.name, source: "user-file", file: f.id, generic: slot === "mono" ? "monospace" : "serif" });
            return;
          }
          const p = FONT_PRESETS.find((x) => x.family === v);
          if (p) onChoose({ family: p.family, source: p.source, generic: p.generic });
        }}
      >
        {FONT_PRESETS.map((p) => (
          <option key={p.family} value={p.family}>
            {p.label}
          </option>
        ))}
        {userFonts.map((f) => (
          <option key={f.id} value={`${FILE_PREFIX}${f.id}`}>
            {`From file: ${f.name}`}
          </option>
        ))}
        {!preset && !ownFile && <option value={CUSTOM}>{customLabel}</option>}
      </select>
      <form
        className="ao-font-typed"
        onSubmit={(e) => {
          e.preventDefault();
          const family = typed.trim();
          if (!family) return;
          if (!isUsableFamily(family)) {
            setRejected(family);
            return;
          }
          setRejected(null);
          const generic = slot === "mono" ? "monospace" : genericOf({ family, source: "system" });
          onChoose({ family, source: "system", generic });
          setTyped("");
        }}
      >
        <input type="text" aria-label={`Installed font for ${label}`} placeholder="Another installed font" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button type="submit" aria-label={`Use installed font for ${label}`}>
          Use
        </button>
      </form>
      {rejected !== null && (
        <p role="alert" className="ao-warning ao-font-typed-warning">
          “<UserText>{rejected}</UserText>” can't be used as a font name (it contains characters such as ; {"{"} {"}"} &lt; &gt; \ or a line break).
        </p>
      )}
      <UserText as="p" className={`ao-font-sample ao-font-sample--${slot}`} data-testid="font-sample">
        {SAMPLE[slot]}
      </UserText>
    </div>
  );
}

/**
 * The researcher's own font files (R100): added by their path (the desktop shell's file picker
 * gives a path, as for imports), checked and kept by the service, then offered in every typeface
 * picker above. One request at a time; answers after the screen closes are dropped.
 */
/** The service refused because a settings file cannot be read (Task 68): `reason` names which. */
const unreadableBecause = (e: unknown, reason: "fonts" | "appearance") => e instanceof ApiClientError && e.code === "UNAVAILABLE" && e.reason === reason;

function UserFontFiles({ fonts, list, onList, unreadable, onUnreadable, onReset }: { fonts: FontsApi; list: UserFont[]; onList: (l: UserFont[]) => void; unreadable: boolean; onUnreadable: () => void; onReset: () => Promise<void> }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const resetNow = useRef(false);
  // After a reset, focus goes to the section's heading once the dialog has closed (and restored its own).
  const [focusHeading, setFocusHeading] = useState(0);
  useEffect(() => {
    if (focusHeading > 0) heading.current?.focus();
  }, [focusHeading]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const live = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = async (what: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      await what();
    } catch (e) {
      if (live.current) setError(e instanceof Error && e.message ? e.message : "Something went wrong.");
      if (live.current && unreadableBecause(e, "fonts")) onUnreadable();
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!isAbsolutePath(p)) {
      setError(PATH_HINT);
      return;
    }
    void run(async () => {
      const f = await fonts.add(p, name.trim() || undefined);
      if (!live.current) return;
      onList([...list.filter((x) => x.id !== f.id), f]);
      setPath("");
      setName("");
      setStatus(`Added “${f.name}”. Choose it for a typeface above.`);
    });
  };

  const remove = (f: UserFont) =>
    void run(async () => {
      await fonts.remove(f.id);
      if (!live.current) return;
      onList(list.filter((x) => x.id !== f.id));
      setStatus(`Removed “${f.name}”.`);
    });

  /** The reset, once confirmed (Task 68): one request; then the list is read again. */
  const reset = async () => {
    if (resetNow.current) return;
    resetNow.current = true;
    setResetBusy(true);
    setResetError(null);
    try {
      await onReset();
      if (!live.current) return;
      setResetOpen(false);
      setError(null);
      setStatus("The list of added fonts was reset. Add your font files again to use them.");
      setFocusHeading((n) => n + 1);
    } catch (e) {
      if (live.current) setResetError(errorText(e, "The list could not be reset."));
    } finally {
      resetNow.current = false;
      if (live.current) setResetBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-own`}>
      <h2 id={`${id}-own`} ref={heading} tabIndex={-1}>
        Your own font files
      </h2>
      {unreadable && (
        <div role="alert" className="ao-warning">
          <p>The list of added fonts could not be read, so no font file can be added or removed. If this does not go away, reset the list.</p>
          <button type="button" onClick={() => { setResetError(null); setResetOpen(true); }}>
            Reset the list of added fonts…
          </button>
        </div>
      )}
      {resetOpen && (
        <ChoiceDialog title="Reset the list of added fonts?" action="Reset the list" busy={resetBusy} onConfirm={() => void reset()} onCancel={() => setResetOpen(false)}>
          <p>This app's list of font files you added on this computer cannot be read. Resetting it empties the list. The app's copies of those files stay in its settings folder: add a font file again to use it, and its copy is used again. Until then, typefaces set to one of them use their fallbacks.</p>
          <p>The unreadable list is not deleted: it is kept, renamed, in the app's settings folder.</p>
          {resetError && (
            <p role="alert" className="ao-warning">
              {resetError}
            </p>
          )}
        </ChoiceDialog>
      )}
      <p className="ao-hint">TrueType, OpenType, WOFF or WOFF2, up to 32 MB. The app keeps its own copy on this computer; the file is not changed.</p>
      {list.length > 0 && (
        <ul className="ao-font-files">
          {list.map((f) => (
            <li key={f.id}>
              <UserText>{f.name}</UserText> <span className="ao-hint">({f.format.toUpperCase()})</span>{" "}
              <button type="button" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => remove(f)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="ao-font-file-form" onSubmit={add}>
        <PathField id={`${id}-path`} className="ao-field" label="Font file path" pick="file" pickerTitle="Choose a font file" placeholder="/Users/me/Fonts/Junicode.woff2" value={path} onChange={setPath} />
        <div className="ao-field">
          <label htmlFor={`${id}-name`}>Name to use (optional)</label>
          <input id={`${id}-name`} type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>
          Add font file
        </button>
      </form>
      <p role="status" className="ao-hint">
        {status && <UserText>{status}</UserText>}
      </p>
      {error && (
        <p role="alert" className="ao-warning">
          <UserText>{error}</UserText>
        </p>
      )}
    </section>
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
  const { settings, theme, accentApplied, update, retrySave, retryLoad, loadError, saveError, saveErrorReason, fonts, fontError } = useAppearance();
  const id = useId();
  const [userFonts, setUserFonts] = useState<UserFont[]>([]);
  /** The list of added fonts cannot be read (Task 68): its reset is offered. */
  const [fontsUnreadable, setFontsUnreadable] = useState(false);
  const [listRead, setListRead] = useState(0);
  useEffect(() => {
    if (!fonts) return;
    let live = true;
    fonts.list().then(
      (l) => {
        if (!live) return;
        setUserFonts(l);
        setFontsUnreadable(false);
      },
      (e: unknown) => {
        // An unreadable list is said in the section below with its way out; other failures are said
        // there when it is used. The pickers simply offer no files.
        if (live && unreadableBecause(e, "fonts")) setFontsUnreadable(true);
      },
    );
    return () => {
      live = false;
    };
  }, [fonts, listRead]);
  const resetFonts = async () => {
    await fonts!.resetSettingsFile("fonts");
    setFontsUnreadable(false);
    setUserFonts([]);
    setListRead((n) => n + 1);
  };
  // The appearance settings cannot be read (Task 68): the reset is offered beside the refusal.
  const heading = useRef<HTMLHeadingElement>(null);
  const [appearanceResetOpen, setAppearanceResetOpen] = useState(false);
  const [appearanceResetBusy, setAppearanceResetBusy] = useState(false);
  const [appearanceResetError, setAppearanceResetError] = useState<string | null>(null);
  const appearanceResetNow = useRef(false);
  const [focusTitle, setFocusTitle] = useState(0);
  useEffect(() => {
    if (focusTitle > 0) heading.current?.focus();
  }, [focusTitle]);
  const resetAppearance = async () => {
    if (appearanceResetNow.current || !fonts) return;
    appearanceResetNow.current = true;
    setAppearanceResetBusy(true);
    setAppearanceResetError(null);
    try {
      await fonts.resetSettingsFile("appearance");
      setAppearanceResetOpen(false);
      setFocusTitle((n) => n + 1);
      // The change that was refused is saved now, over the defaults.
      await retrySave();
    } catch (e) {
      setAppearanceResetError(errorText(e, "The appearance settings could not be reset."));
    } finally {
      appearanceResetNow.current = false;
      setAppearanceResetBusy(false);
    }
  };
  const [rejectedAccent, setRejectedAccent] = useState<string | null>(null);
  // The colour shown in the picker while the user is still choosing (saved ACCENT_DEBOUNCE_MS after).
  const [draftAccent, setDraftAccent] = useState<string | null>(null);
  const accentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The accent waiting for the debounce; saved at once if the screen closes first (R109).
  const pendingAccent = useRef<string | null>(null);
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(
    () => () => {
      clearTimeout(accentTimer.current);
      const v = pendingAccent.current;
      pendingAccent.current = null;
      if (v) void updateRef.current({ accent: v });
    },
    [],
  );
  const showAccentWarning = rejectedAccent !== null || (!!settings.accent && !accentApplied);

  const set = (patch: AppearancePatch) => void update(patch);

  const onAccent = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(value)) return;
    clearTimeout(accentTimer.current);
    pendingAccent.current = null;
    setDraftAccent(value);
    if (!checkAccent(value, THEMES[theme], settings.highContrast).ok) {
      setRejectedAccent(value);
      return;
    }
    setRejectedAccent(null);
    pendingAccent.current = value;
    accentTimer.current = setTimeout(() => {
      pendingAccent.current = null;
      setDraftAccent(null);
      void update({ accent: value });
    }, ACCENT_DEBOUNCE_MS);
  };

  return (
    <main className="ao-appearance" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} ref={heading} tabIndex={-1}>
        Appearance
      </h1>

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
          <input type="color" id={`${id}-accent`} value={(draftAccent ?? settings.accent ?? THEMES[theme].accent!).toLowerCase()} onChange={onAccent} aria-describedby={showAccentWarning ? `${id}-accent-warning` : undefined} />
          <button
            type="button"
            onClick={() => {
              clearTimeout(accentTimer.current);
              pendingAccent.current = null;
              setDraftAccent(null);
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
        {fontError && (
          <p role="alert" className="ao-warning">
            <UserText>{fontError}</UserText>
          </p>
        )}
        {FONT_SLOTS.map((slot) => (
          <FontPicker key={slot} slot={slot} choice={settings.fonts[slot]} userFonts={userFonts} onChoose={(c) => set({ fonts: { [slot]: c } })} />
        ))}
      </section>

      {fonts && <UserFontFiles fonts={fonts} list={userFonts} onList={setUserFonts} unreadable={fontsUnreadable} onUnreadable={() => setFontsUnreadable(true)} onReset={resetFonts} />}

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

      {loadError && (
        <div role="alert" className="ao-warning">
          <p>{loadError}</p>
          <button type="button" onClick={retryLoad}>
            Try loading again
          </button>
        </div>
      )}
      {saveError && (
        <div role="alert" className="ao-warning">
          <p>{saveError}</p>
          <button type="button" onClick={() => void retrySave()}>
            Try saving again
          </button>
          {saveErrorReason === "appearance" && fonts && (
            <>
              <p>The appearance settings on this computer could not be read, so no change can be saved. If this does not go away, reset them.</p>
              <button type="button" onClick={() => { setAppearanceResetError(null); setAppearanceResetOpen(true); }}>
                Reset appearance settings…
              </button>
            </>
          )}
        </div>
      )}
      {appearanceResetOpen && (
        <ChoiceDialog title="Reset appearance settings?" action="Reset appearance" busy={appearanceResetBusy} onConfirm={() => void resetAppearance()} onCancel={() => setAppearanceResetOpen(false)}>
          <p>This app's appearance settings on this computer cannot be read. Resetting them puts your appearance choices (theme, contrast, accent colour, typefaces, text size, spacing, density and motion) back to the defaults; the change you just made is then saved again.</p>
          <p>The unreadable settings are not deleted: they are kept, renamed, in the app's settings folder.</p>
          {appearanceResetError && (
            <p role="alert" className="ao-warning">
              {appearanceResetError}
            </p>
          )}
        </ChoiceDialog>
      )}
    </main>
  );
}
