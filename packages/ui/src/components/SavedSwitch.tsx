/**
 * A switch that is saved the moment it is changed (whole channels, Task 9): the project's "Transcribe captured audio and
 * video automatically" on the Governance screen and "Keep this Mac awake while downloads or transcriptions run" on the
 * Optional tools screen.
 *
 * - The saved value is read once (`read`; a new `read` reads again and drops anything still on its way).
 * - One request per change: a synchronous guard, then the box is disabled while it is saved. Focus that was on the box
 *   comes back to it afterwards.
 * - A failed save puts the box back to the saved value and says why in plain words (the service's sentence, through
 *   UserText). Answers that arrive after the screen was left or after a new read are dropped.
 * - `whyId`: the element saying why nothing may be changed now (a locked project, a read-only library): the box is then
 *   off and described by it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../api/library";
import { UserText } from "./UserText";

export interface SavedSwitchProps {
  label: string;
  hint: string;
  read: (signal: AbortSignal) => Promise<boolean>;
  save: (on: boolean) => Promise<boolean>;
  whyId?: string | undefined;
}

/** Said when the saved value could not be read and the service gave no sentence of its own. */
export const SWITCH_READ_FAILED = "This setting could not be read.";
/** Said when a save failed and the service gave no sentence of its own (the app's usual words). */
const SAVE_FAILED = "That could not be done. Try again.";

export function SavedSwitch({ label, hint, read, save, whyId }: SavedSwitchProps) {
  const id = useId();
  const [saved, setSaved] = useState<boolean | undefined>();
  const [wanted, setWanted] = useState<boolean | undefined>();
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  /** A save in flight (a ref: a double click fires before the box re-renders, R113). */
  const sending = useRef(false);
  /** Moves on with each read and at unmount: an answer of an older one is dropped. */
  const generation = useRef(0);
  /** Focus was on the box when a save began. */
  const refocus = useRef(false);

  useEffect(() => {
    const my = ++generation.current;
    const ac = new AbortController();
    sending.current = false;
    setSaved(undefined);
    setWanted(undefined);
    setError(null);
    read(ac.signal).then(
      (v) => {
        if (generation.current === my) setSaved(v);
      },
      (err: unknown) => {
        if (generation.current === my) setError(errorText(err, SWITCH_READ_FAILED));
      },
    );
    return () => {
      generation.current++;
      ac.abort();
    };
  }, [read]);

  const change = async (on: boolean) => {
    if (sending.current || whyId || saved === undefined) return;
    sending.current = true;
    const my = generation.current;
    const hadFocus = document.activeElement === box.current;
    setWanted(on);
    setError(null);
    try {
      const v = await save(on);
      if (generation.current !== my) return;
      setSaved(v);
    } catch (err) {
      if (generation.current !== my) return;
      setError(errorText(err, SAVE_FAILED));
    } finally {
      if (generation.current === my) {
        sending.current = false;
        refocus.current = hadFocus;
        setWanted(undefined);
      }
    }
  };

  const saving = wanted !== undefined;
  // The box was disabled while it was saved: focus that was on it comes back to it once it is enabled again.
  useEffect(() => {
    if (saving || !refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body || document.activeElement === null) box.current?.focus();
  }, [saving]);
  const describedBy = [`${id}-hint`, error ? `${id}-error` : "", whyId ?? ""].filter(Boolean).join(" ");
  return (
    <div className="ao-field">
      <label className="ao-choice">
        <input
          ref={box}
          type="checkbox"
          checked={saving ? wanted : (saved ?? false)}
          disabled={saving || saved === undefined || !!whyId}
          aria-describedby={describedBy}
          onChange={(e) => void change(e.target.checked)}
        />
        {label}
      </label>
      <p id={`${id}-hint`} className="ao-hint">
        {hint}
      </p>
      {error ? (
        <p role="alert" id={`${id}-error`} className="ao-warning">
          <UserText>{error}</UserText>
        </p>
      ) : null}
    </div>
  );
}
