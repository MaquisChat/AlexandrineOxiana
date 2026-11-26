/**
 * A switch that is saved the moment it is changed (whole channels, Task 9): the project's "Transcribe captured audio and
 * video automatically" on the Governance screen and "Keep this Mac awake while downloads or transcriptions run" on the
 * Optional tools screen.
 *
 * - The saved value is read once (`read`; a new `read` reads again and drops anything still on its way), with the
 *   screens' first-read time limit (`firstReadMs`, FR-756 `readWithin`). A read that fails or is given up says "This
 *   setting could not be read." with "Try again" (the screens' TryAgain): pressed, it reads again and focus goes to
 *   `focusTo` (the section's heading). The box is never left off for good with no way on (R684).
 * - One request per change: a synchronous guard, then the box is disabled while it is saved. Focus that was on the box
 *   comes back to it afterwards.
 * - A failed save puts the box back to the saved value and says why in plain words (the service's sentence, through
 *   UserText). Answers that arrive after the screen was left or after a new read are dropped.
 * - `whyId`: the element saying why nothing may be changed now (a locked project, a read-only library): the box is then
 *   off and described by it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FIRST_READ_TIMEOUT_MS, readWithin } from "../api/firstRead";
import { errorText } from "../api/library";
import { TryAgain } from "./TryAgain";
import { UserText } from "./UserText";

export interface SavedSwitchProps {
  label: string;
  hint: string;
  read: (signal: AbortSignal) => Promise<boolean>;
  save: (on: boolean) => Promise<boolean>;
  whyId?: string | undefined;
  /** Where focus goes after "Try again" is pressed (the section's heading, `tabIndex={-1}`). */
  focusTo: RefObject<HTMLElement | null>;
  /** How long the first read is waited for before it is given up (the screen's own limit; smaller in tests). */
  firstReadMs?: number | undefined;
}

/** Said when the saved value could not be read (it failed, or got no answer in time), with "Try again". */
export const SWITCH_READ_FAILED = "This setting could not be read.";
/** Said when a save failed and the service gave no sentence of its own (the app's usual words). */
const SAVE_FAILED = "That could not be done. Try again.";

export function SavedSwitch({ label, hint, read, save, whyId, focusTo, firstReadMs = FIRST_READ_TIMEOUT_MS }: SavedSwitchProps) {
  const id = useId();
  const [saved, setSaved] = useState<boolean | undefined>();
  const [wanted, setWanted] = useState<boolean | undefined>();
  const [error, setError] = useState<string | null>(null);
  /** The last read failed or was given up: "Try again" is offered. */
  const [readFailed, setReadFailed] = useState(false);
  /** Moves on with each "Try again": the read is made again. */
  const [attempt, setAttempt] = useState(0);
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
    setReadFailed(false);
    readWithin(read, firstReadMs, ac.signal).then(
      (v) => {
        if (generation.current === my) setSaved(v);
      },
      () => {
        if (generation.current === my) setReadFailed(true);
      },
    );
    return () => {
      generation.current++;
      ac.abort();
    };
  }, [read, firstReadMs, attempt]);

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
  // A layout effect (R689): it runs in the same commit that enables the box, before paint and before any other effect,
  // so there is no moment in which the box is enabled and focus is elsewhere.
  useLayoutEffect(() => {
    if (saving || !refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body || document.activeElement === null) box.current?.focus();
  }, [saving]);
  const describedBy = [`${id}-hint`, error || readFailed ? `${id}-error` : "", whyId ?? ""].filter(Boolean).join(" ");
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
      {readFailed ? (
        <div role="alert" id={`${id}-error`} className="ao-warning">
          <p>{SWITCH_READ_FAILED}</p>
          <TryAgain focusTo={focusTo} onPress={() => setAttempt((n) => n + 1)} />
        </div>
      ) : null}
    </div>
  );
}
