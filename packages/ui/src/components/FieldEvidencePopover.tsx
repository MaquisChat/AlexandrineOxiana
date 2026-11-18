/**
 * The evidence behind one field (Task 34d): its status and why, each piece of evidence (where it
 * came from, the value it gives, the passage quoted, when it was recorded), all source text through
 * UserText. A conflict's competing values and their sources are always shown (R149): as choices
 * where the field can be confirmed, otherwise as a list. The researcher may choose one or type
 * another; **Confirm this value** records it through the service's field route under the field key
 * the verification report gives, posted back unchanged ("/issued", "/identifiers/doi"), as the
 * researcher's own evidence, which the service marks "confirmed by you" when it agrees with the
 * record (R37–R40).
 *
 * It is a modal dialog on the shared dialog shell (R113, R145, R149): the rest of the page is inert
 * while it is open, focus moves in, Tab and Shift+Tab stay inside, Escape closes (not while saving)
 * and focus returns to the badge. A failed save leaves it open with the choice and the typed text,
 * and says why.
 *
 * The key that opened it never confirms in it (R371 a; R313 b's held key): focus starts on its
 * heading, not on the first value (Enter on a value submits the form); inside it a repeated keydown
 * of Enter or Space never acts, and a key that was already down when it opened (`heldAtOpen`, from
 * the badge) does not count until it has been released. So a held Enter, or Enter pressed twice on
 * the badge, reads nothing as a choice; Tab, then Space or the arrow keys, then Confirm, decides.
 */
import { CONFIRMABLE_IDENTIFIER_KEYS, type FieldReview } from "@ao/shared";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";
import { statusWords } from "./VerificationBadge";

/**
 * Top-level fields the service's field route accepts (packages/library/src/source-actions.ts
 * CONFIRMABLE_FIELDS); identifiers are accepted only one at a time, as "/identifiers/<key>" (R149).
 */
const CONFIRMABLE = new Set([
  "title", "creators", "issued", "container", "publisher", "type", "volume", "issue", "page", "edition",
  "numberOfPages", "publisherPlace", "collectionTitle", "collectionNumber", "genre", "medium", "number",
]);
const IDENTIFIERS = new Set(CONFIRMABLE_IDENTIFIER_KEYS);
/** Fields whose value is text, so a researcher may type one. */
const TYPABLE = new Set([
  "/title", "/container", "/issued", "/publisher", "/volume", "/issue", "/page", "/edition", "/numberOfPages", "/publisherPlace", "/collectionTitle", "/collectionNumber", "/genre", "/medium", "/number",
  ...CONFIRMABLE_IDENTIFIER_KEYS.map((k) => `/identifiers/${k}`),
  // Names, separated by semicolons (a missing creator can be typed, Task 67 fix round 1).
  "/creators",
]);
const MULTI_TEXT = new Set(["/title", "/container"]);

/** Whether the service can confirm this field (the report's pointer, posted back unchanged). */
export function isConfirmable(pointer: string): boolean {
  const top = /^\/([A-Za-z]+)$/.exec(pointer);
  if (top) return CONFIRMABLE.has(top[1]!);
  const ident = /^\/identifiers\/([A-Za-z]+)$/.exec(pointer);
  return !!ident && IDENTIFIERS.has(ident[1]!);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function personName(c: Record<string, unknown>): string | undefined {
  if (typeof c.literal === "string" && c.literal) return c.literal;
  const parts = [c.family, c.given].filter((x): x is string => typeof x === "string" && x !== "");
  if (parts.length) return parts.join(", ");
  return typeof c.handle === "string" && c.handle ? c.handle : undefined;
}

export const UNSHOWABLE = "(a value that cannot be shown as text)";

/** A field's value as text, never raw JSON: titles by their versions, creators by name, lists joined. */
export function valueText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "(empty)";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : isObj(x) ? personName(x) : undefined));
    return parts.length && parts.every((p) => p !== undefined) ? parts.join(parts.some((p) => p!.includes(",")) ? "; " : ", ") : UNSHOWABLE;
  }
  if (isObj(v)) {
    if (Array.isArray(v.variants)) {
      const texts = v.variants.map((x) => (isObj(x) && typeof x.value === "string" ? x.value : undefined));
      return texts.length && texts.every((t) => t !== undefined) ? texts.join(" / ") : UNSHOWABLE;
    }
    const name = personName(v);
    if (name) return name;
  }
  return UNSHOWABLE;
}

/** "2026-11-02" from an ISO time; nothing when it is not one (a lookup's evidence may have none). */
function whenText(at: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T/.test(at) && !Number.isNaN(Date.parse(at)) ? at.slice(0, 10) : undefined;
}

/**
 * The value to record for `field`: a title or container chosen as plain text keeps the record's
 * versions (languages and kinds) and changes only the first version's text.
 */
export function recordValue(field: string, chosen: unknown, current: unknown): unknown {
  // Typed creators: names separated by semicolons, each recorded as a name in full.
  if (field === "/creators" && typeof chosen === "string") {
    return chosen
      .split(";")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((literal) => ({ literal, role: "author" }));
  }
  if (!MULTI_TEXT.has(field) || typeof chosen !== "string") return chosen;
  const variants = isObj(current) && Array.isArray(current.variants) ? (current.variants as Array<Record<string, unknown>>) : [];
  const first = variants[0] ?? { kind: "original" };
  return { variants: [{ ...first, value: chosen }, ...variants.slice(1)] };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export interface FieldEvidencePopoverProps {
  review: FieldReview;
  label: string;
  value: unknown;
  readOnly: boolean;
  /** Posts `review.field` unchanged with the chosen value; throws with a plain-language message when not saved. */
  onConfirm: (field: string, value: unknown) => Promise<void>;
  onClose: () => void;
  /** Keys (KeyboardEvent.key) that were down when the dialog opened: none of them counts until released. */
  heldAtOpen?: readonly string[];
}

/** Enter submits from any control; Space presses a button or a value (in a text field it types). */
const acts = (e: KeyboardEvent): boolean => e.key === "Enter" || (e.key === " " && !(e.target instanceof HTMLInputElement && e.target.type !== "radio" && e.target.type !== "checkbox"));

type Choice = { key: string; text: string; from: string; value: unknown };

export function FieldEvidencePopover({ review, label, value, readOnly, onConfirm, onClose, heldAtOpen = [] }: FieldEvidencePopoverProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // Keys down since before the dialog opened, and keys pressed down inside it (R371 a).
  const held = useRef(new Set(heldAtOpen));
  const pressed = useRef(new Set<string>());
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.repeat || held.current.has(e.key) || pressed.current.has(e.key)) {
      if (acts(e)) e.preventDefault();
      return;
    }
    pressed.current.add(e.key);
  };
  const onKeyUpCapture = (e: KeyboardEvent) => {
    // A key whose press this dialog never took (it went down before it opened) is not a press here.
    if (!pressed.current.has(e.key) && acts(e)) e.preventDefault();
    pressed.current.delete(e.key);
    held.current.delete(e.key);
  };
  const field = review.field;
  const confirmable = isConfirmable(field);
  const typable = confirmable && TYPABLE.has(field);
  const conflict = review.status === "conflict";

  // The competing values, each with its source: always shown (R149).
  const competing: Choice[] = [];
  for (const [i, v] of (review.values ?? []).entries()) {
    const text = valueText(v.value);
    if (competing.some((c) => c.text === text && c.from === v.from.label)) continue;
    competing.push({ key: `v${i}`, text, from: v.from.label, value: v.value });
  }
  const choices: Choice[] = [];
  if (!isEmpty(value)) choices.push({ key: "recorded", text: valueText(value), from: "the value recorded here", value });
  if (conflict) for (const c of competing) if (!choices.some((x) => x.text === c.text)) choices.push(c);
  // Creators are typed only where there is no value at all: in a conflict the structured values compete and are chosen as they are (fix round 2, N2).
  const offerTyping = typable && (field === "/creators" ? isEmpty(value) : conflict || isEmpty(value));
  if (offerTyping) choices.push({ key: "type", text: "Type another value", from: "", value: undefined });
  const asChoices = confirmable && choices.length > 1;

  const [picked, setPicked] = useState<string>(choices[0]?.key ?? "type");
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const choice = choices.find((c) => c.key === picked);
  const chosen = picked === "type" ? typed.trim() : choice?.value;
  const canConfirm = confirmable && !readOnly && !saving && !!choice && !isEmpty(chosen) && !isEmpty(recordValue(field, chosen, value));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(field, recordValue(field, chosen, value));
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The library service did not answer.");
      setSaving(false);
    }
  };

  // Values a choice list does not already show (a field that cannot be confirmed here, or no conflict).
  const listed = competing.filter((c) => !(asChoices && choices.includes(c)));

  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onClose} busy={saving} initialFocus={heading}>
      <div className="ao-evidence" onKeyDownCapture={onKeyDownCapture} onKeyUpCapture={onKeyUpCapture}>
        <h2 id={`${id}-t`} ref={heading} tabIndex={-1} className="ao-evidence__title">
          <UserText>{label}</UserText>: evidence
        </h2>
        <p>
          <strong>{statusWords(review.status)}.</strong> {review.reason ? <UserText>{review.reason}</UserText> : null}
        </p>
        {review.evidence.length === 0 ? (
          <p className="ao-muted">No evidence is recorded for this field.</p>
        ) : (
          <ul className="ao-plain-list" aria-label={`Evidence for ${label}`}>
            {review.evidence.map((ev, i) => {
              const when = whenText(ev.at);
              return (
                <li key={i} className="ao-evidence__item">
                  <span className="ao-muted">From </span>
                  <UserText>{ev.from.label}</UserText>
                  {when && <span className="ao-muted">, recorded {when}</span>}
                  <span className="ao-muted">: </span>
                  <UserText>{valueText(ev.value)}</UserText>
                  {typeof ev.quote === "string" && ev.quote !== "" && (
                    <UserText as="blockquote" className="ao-evidence__quote">
                      {ev.quote}
                    </UserText>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {listed.length > 0 && (
          <ul className="ao-plain-list" aria-label={`Values the sources give for ${label}`}>
            {listed.map((c) => (
              <li key={c.key} className="ao-evidence__item">
                <UserText>{c.text}</UserText>
                <span className="ao-muted"> — </span>
                <UserText>{c.from}</UserText>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => void submit(e)}>
          {asChoices && (
            <fieldset className="ao-evidence__choices" role="radiogroup" aria-labelledby={`${id}-q`} disabled={saving}>
              <legend id={`${id}-q`}>Which value is right?</legend>
              {choices.map((c) => (
                <label key={c.key} className="ao-evidence__choice">
                  <input type="radio" name={`${id}-choice`} value={c.key} checked={picked === c.key} onChange={() => setPicked(c.key)} />
                  {c.key === "type" ? (
                    c.text
                  ) : (
                    <>
                      <UserText>{c.text}</UserText>
                      <span className="ao-muted"> — </span>
                      <UserText>{c.from}</UserText>
                    </>
                  )}
                </label>
              ))}
            </fieldset>
          )}
          {confirmable && picked === "type" && (
            <div className="ao-cite__field">
              <label htmlFor={`${id}-typed`}>Your value</label>
              <input id={`${id}-typed`} dir="auto" value={typed} disabled={saving} onChange={(e) => setTyped(e.target.value)} aria-describedby={field === "/creators" ? `${id}-typed-hint` : undefined} />
              {field === "/creators" && (
                <p id={`${id}-typed-hint`} className="ao-muted">
                  Separate names with a semicolon, for example “Harbour Collective; Ana Souza”.
                </p>
              )}
            </div>
          )}
          {!confirmable && <p className="ao-muted">This field cannot be confirmed from this screen.</p>}
          {confirmable && readOnly && <p className="ao-muted">This library is read-only, so nothing can be confirmed now.</p>}
          {error && (
            <p role="alert" className="ao-error">
              The confirmation was not saved. {error}
            </p>
          )}
          <div className="ao-row">
            {confirmable && (
              <button type="submit" disabled={!canConfirm}>
                {saving ? "Saving…" : "Confirm this value"}
              </button>
            )}
            <button type="button" onClick={onClose} disabled={saving}>
              Close
            </button>
          </div>
        </form>
      </div>
    </DialogShell>
  );
}
