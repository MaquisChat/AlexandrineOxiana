/**
 * "Choose" (Task F6; R145): the works a search offered for one queue entry, the likeliest first, as a radio group
 * with "None of these" last. "Use this one" is disabled until one is chosen; "Cancel" and Escape close it. Each
 * candidate names its authors, year, kind, where it was published and its identifier — all outside text, shown
 * through UserText (dir="auto"), as is what was typed.
 *
 * Focus (R145): DialogShell moves focus in (the first candidate), makes the background inert and gives focus back
 * to the control that opened it. Tab and Shift+Tab are kept inside here with a radio group's own rule: the group is
 * ONE stop (the chosen radio, else the first), then the buttons that can be pressed, wrapping at either end.
 *
 * The parent sends the request and owns `busy` and `error`: while busy, "Use this one" shows it is working and a
 * press does nothing; a refusal (the entry no longer waits for a choice, the index is not ready) is the service's
 * sentence, said here, and nothing is changed.
 *
 * R279 d: when the typed words may also name an author (the entry's author offer; the parent passes `onShowAuthor`),
 * below the candidates: "“<typed>” may also be an author." and the button "Show this author's works", which sends the
 * act (the parent closes the dialog on its answer).
 */
import type { FindEntryView, FindWorkCandidate } from "@ao/shared";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { creatorsText, identifierText, kindWords, usableCandidates, wherePublished, yearOf } from "../api/find";
import { shortTyped } from "./FindEntryRow";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";

export interface ChooseWorkDialogProps {
  entry: FindEntryView;
  onChoose(id: string | null): void;
  onClose(): void;
  /** The choice is being sent: shown on "Use this one", and a press does nothing. */
  busy?: boolean;
  /** The service's sentence for a refusal. */
  error?: string;
  /** R279 d: the entry may also name an author — "Show this author's works" is offered. */
  onShowAuthor?: () => void;
  /** That act is being sent. */
  busyAuthor?: boolean;
}

/** The details of a candidate after its title, each part outside text. */
function Details({ c, id }: { c: FindWorkCandidate; id: string }) {
  const people = creatorsText(c.creators);
  const year = yearOf(c.issued);
  const kind = kindWords(c.type);
  const where = wherePublished(c);
  const ident = identifierText(c);
  const parts: Array<{ key: string; node: ReactNode }> = [];
  if (people) parts.push({ key: "p", node: <UserText>{people}</UserText> });
  if (year) parts.push({ key: "y", node: <UserText>{year}</UserText> });
  if (kind) parts.push({ key: "k", node: kind });
  if (where) parts.push({ key: "w", node: <UserText>{where}</UserText> });
  if (ident) {
    const [label, ...rest] = ident.split(" ");
    parts.push({
      key: "i",
      node: (
        <>
          {label} <UserText>{rest.join(" ")}</UserText>
        </>
      ),
    });
  }
  return (
    <span id={id} className="ao-find__candidate-details">
      {parts.map((p, i) => (
        <span key={p.key}>
          {i > 0 && " · "}
          {p.node}
        </span>
      ))}
    </span>
  );
}

export function ChooseWorkDialog({ entry, onChoose, onClose, busy = false, error, onShowAuthor, busyAuthor = false }: ChooseWorkDialogProps) {
  const id = useId();
  // A malformed candidate is left out (R262 N6).
  const candidates = usableCandidates(entry);
  /** undefined: nothing chosen yet; null: "None of these". */
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const name = `${id}-pick`;

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
    const next = stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]!;
    next.focus();
  };

  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={close} busy={busy} className="ao-find__dialog">
      <div onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`}>
          Choose the work for “<UserText>{entry.typed}</UserText>”
        </h2>
        <p id={`${id}-d`}>The likeliest is first. Choose one and press “Use this one”, or choose “None of these”.</p>
        <div role="radiogroup" aria-labelledby={`${id}-t`}>
          <ul className="ao-find__candidates">
            {candidates.map((c, i) => (
              <li key={c.id} className="ao-find__candidate">
                <label className="ao-find__option">
                  <input type="radio" name={name} value={c.id} checked={chosen === c.id} onChange={() => setChosen(c.id)} aria-describedby={`${id}-c${i}`} />
                  <span>
                    <UserText className="ao-find__candidate-title">{c.title}</UserText>
                    <Details c={c} id={`${id}-c${i}`} />
                  </span>
                </label>
              </li>
            ))}
            <li className="ao-find__candidate">
              <label className="ao-find__option">
                <input type="radio" name={name} value="" checked={chosen === null} onChange={() => setChosen(null)} />
                <span>None of these</span>
              </label>
            </li>
          </ul>
        </div>
        {onShowAuthor && (
          <div className="ao-find__author-offer">
            <p>
              “<UserText>{entry.typed}</UserText>” may also be an author.
            </p>
            <p>
              <button
                type="button"
                aria-label={`Show this author's works: “${shortTyped(entry.typed)}”`}
                aria-disabled={busy || undefined}
                aria-busy={busyAuthor || undefined}
                onClick={() => {
                  if (busy) return;
                  onShowAuthor();
                }}
              >
                Show this author's works
              </button>
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="ao-error">
            <UserText>{error}</UserText>
          </p>
        )}
        <div className="ao-actions">
          <button
            type="button"
            disabled={chosen === undefined}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (busy || chosen === undefined) return;
              onChoose(chosen);
            }}
          >
            {busy && !busyAuthor ? "Using…" : "Use this one"}
          </button>
          <button type="button" aria-disabled={busy || undefined} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
