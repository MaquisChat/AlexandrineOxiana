/**
 * "Choose the person" (Task F9; R145, R267, R270, R271): the people an author's name may mean, as a radio group — each
 * person's name, where they work when OpenAlex says, "Works on: …" (up to three subjects, R270 e) and how many works
 * — all outside text, shown through UserText (dir="auto"), as is what was typed. "This is the person" is disabled
 * until one is chosen; "Cancel" and Escape close it without a request. Below the list: "More people have this name; …"
 * when the entry says so, and always that another person can be chosen only by removing the entry and typing the
 * name again (R271 M8: once a person is chosen the others are not kept).
 *
 * The list is the parent's: read from the entry's `options` when the dialog opens (R267 b) and never kept after it
 * closes. While it is read the dialog says so; a read that failed is the service's sentence (`loadError`).
 *
 * Focus (R145): DialogShell moves focus in, makes the background inert and gives focus back to the control that
 * opened it. On open the first control is focused (Cancel while the list is read; the first person once it has come —
 * focus moves there unless the researcher has moved it). Tab and Shift+Tab are kept inside with a radio group's own
 * rule, as in "Choose": the group is ONE stop (the chosen person, else the first), then the buttons that can be
 * pressed, wrapping at either end; the arrow keys move within the group (the browser's own).
 *
 * The parent sends the request and owns `busy` and `error`: while busy, "This is the person" shows it and a press does
 * nothing; a refusal is the service's sentence, said here, and nothing is changed.
 */
import { FIND_MORE_PEOPLE_TEXT, type FindEntryView, type FindPersonCandidate } from "@ao/shared";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";

export const CHOOSE_PERSON_TEXT = {
  loading: "Reading the people of this name…",
  describe: "Choose one and press “This is the person”. Their works are then listed for you to choose from.",
  /** R271 M8. */
  another: "To choose another person later, remove this entry and type the name again.",
  /** The plan's words (FIND_MORE_PEOPLE_TEXT), as a sentence. */
  more: `${FIND_MORE_PEOPLE_TEXT}.`,
  none: "No people are listed for this name.",
} as const;

export interface ChoosePersonDialogProps {
  entry: FindEntryView;
  /** The people, from `options`; absent while they are read. */
  people?: FindPersonCandidate[];
  /** The list could not be read: the service's sentence. */
  loadError?: string;
  onChoose(personId: string): void;
  onClose(): void;
  /** The choice is being sent: shown on "This is the person", and a press does nothing. */
  busy?: boolean;
  /** The service's sentence for a refusal of the choice. */
  error?: string;
}

const worksText = (n: number) => (n === 1 ? "1 work" : `${n} works`);

/** A person this build can show: an id, a name, a count, and a list of subjects (a malformed one is left out). */
export function wellFormedPerson(p: unknown): p is FindPersonCandidate {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    x.name.trim() !== "" &&
    (x.affiliation === undefined || typeof x.affiliation === "string") &&
    typeof x.worksCount === "number" &&
    Number.isFinite(x.worksCount) &&
    Array.isArray(x.subjects)
  );
}

function Details({ p, id }: { p: FindPersonCandidate; id: string }) {
  const subjects = p.subjects.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return (
    <span id={id} className="ao-find__candidate-details">
      {p.affiliation && (
        <span className="ao-find__line">
          <UserText>{p.affiliation}</UserText>
        </span>
      )}
      {subjects.length > 0 && (
        <span className="ao-find__line">
          Works on: <UserText>{subjects.join(", ")}</UserText>
        </span>
      )}
      <span className="ao-find__line">{worksText(Math.max(0, Math.floor(p.worksCount)))}</span>
    </span>
  );
}

export function ChoosePersonDialog({ entry, people, loadError, onChoose, onClose, busy = false, error }: ChoosePersonDialogProps) {
  const id = useId();
  const list = people?.filter(wellFormedPerson);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const name = `${id}-pick`;
  const rootRef = useRef<HTMLDivElement>(null);
  /** What held focus when the dialog opened (Cancel, while the list was read). */
  const firstFocus = useRef<Element | null>(null);
  useEffect(() => {
    firstFocus.current = document.activeElement;
  }, []);
  // The list has come: focus to the first person, unless the researcher has moved it meanwhile.
  const hasList = !!list?.length;
  useEffect(() => {
    if (!hasList) return;
    const now = document.activeElement;
    if (now === firstFocus.current || !now || now === document.body || !rootRef.current?.contains(now)) {
      rootRef.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
    }
  }, [hasList]);

  const close = () => {
    if (!busy) onClose();
  };

  /** Tab and Shift+Tab: the radio group is one stop, then the buttons that can be pressed; wrapping at the ends. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = e.currentTarget;
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const group = radios.find((r) => r.checked) ?? radios[0];
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const stops: HTMLElement[] = [...(group ? [group] : []), ...buttons];
    if (stops.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const active = document.activeElement;
    let i = active instanceof HTMLInputElement && active.type === "radio" ? 0 : stops.indexOf(active as HTMLElement);
    if (i < 0) i = e.shiftKey ? 0 : stops.length - 1;
    stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]!.focus();
  };

  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={close} busy={busy} className="ao-find__dialog">
      <div ref={rootRef} onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`}>
          Choose the person for “<UserText>{entry.typed}</UserText>”
        </h2>
        <p id={`${id}-d`}>{CHOOSE_PERSON_TEXT.describe}</p>
        {!list && !loadError && <p className="ao-find__loading">{CHOOSE_PERSON_TEXT.loading}</p>}
        {loadError && (
          <p role="alert" className="ao-error">
            <UserText>{loadError}</UserText>
          </p>
        )}
        {list && list.length === 0 && <p>{CHOOSE_PERSON_TEXT.none}</p>}
        {list && list.length > 0 && (
          <div role="radiogroup" aria-labelledby={`${id}-t`}>
            <ul className="ao-find__candidates">
              {list.map((p, i) => (
                <li key={p.id} className="ao-find__candidate">
                  <label className="ao-find__option">
                    <input type="radio" name={name} value={p.id} checked={chosen === p.id} onChange={() => setChosen(p.id)} aria-labelledby={`${id}-n${i}`} aria-describedby={`${id}-c${i}`} />
                    <span>
                      <span id={`${id}-n${i}`} className="ao-find__candidate-title">
                        <UserText>{p.name}</UserText>
                      </span>
                      <Details p={p} id={`${id}-c${i}`} />
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {entry.morePeople === true && <p>{CHOOSE_PERSON_TEXT.more}</p>}
        <p className="ao-find__note">{CHOOSE_PERSON_TEXT.another}</p>
        {error && (
          <p role="alert" className="ao-error">
            <UserText>{error}</UserText>
          </p>
        )}
        <div className="ao-actions">
          <button
            type="button"
            disabled={chosen === undefined || !list?.some((p) => p.id === chosen)}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (busy || chosen === undefined) return;
              onChoose(chosen);
            }}
          >
            {busy ? "Choosing…" : "This is the person"}
          </button>
          <button type="button" aria-disabled={busy || undefined} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
