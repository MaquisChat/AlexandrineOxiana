/**
 * The evidence behind one field (Task 34d): its status and why, each piece of evidence (where it
 * came from, the value it gives, the passage quoted, when it was recorded), all source text through
 * UserText. For a conflict the competing values are offered with their sources, and the researcher
 * may choose one or type another; **Confirm this value** records it through the service's field
 * route as the researcher's own evidence, which the service's recheck marks "confirmed by you" when
 * it agrees with the record (R37–R40).
 *
 * Focus is managed like the project's dialogs (ReasonDialog's useTrap): it moves inside on open,
 * Tab stays inside, Escape closes (not while saving) and focus returns to the badge. A failed save
 * leaves the popover open with the choice and the typed text, and says why.
 */
import type { FieldReview } from "@ao/shared";
import { useId, useState, type FormEvent } from "react";
import { useTrap } from "./ReasonDialog";
import { UserText } from "./UserText";
import { statusWords } from "./VerificationBadge";

/**
 * Fields the service's field route accepts (packages/library/src/source-actions.ts
 * CONFIRMABLE_FIELDS): top-level keys only, so an identifier inside `identifiers` cannot be
 * confirmed on its own there.
 */
const CONFIRMABLE = new Set([
  "title", "creators", "issued", "identifiers", "container", "publisher", "type", "volume", "issue", "page", "edition",
  "numberOfPages", "publisherPlace", "collectionTitle", "collectionNumber", "genre", "medium", "number",
]);
/** Fields whose value is text, so a researcher may type one. */
const TYPABLE = new Set(["title", "container", "issued", "publisher", "volume", "issue", "page", "edition", "numberOfPages", "publisherPlace", "collectionTitle", "collectionNumber", "genre", "medium", "number"]);
const MULTI_TEXT = new Set(["title", "container"]);

/** The record key a field pointer names when the service can confirm it ("/issued" → "issued"). */
export function confirmableKey(pointer: string): string | undefined {
  const m = /^\/([A-Za-z]+)$/.exec(pointer);
  return m && CONFIRMABLE.has(m[1]!) ? m[1] : undefined;
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
 * The value to record for `key`: a title or container chosen as plain text keeps the record's
 * versions (languages and kinds) and changes only the first version's text.
 */
export function recordValue(key: string, chosen: unknown, current: unknown): unknown {
  if (!MULTI_TEXT.has(key) || typeof chosen !== "string") return chosen;
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
  onConfirm: (field: string, value: unknown) => Promise<void>;
  onClose: () => void;
}

type Choice = { key: string; text: string; from: string; value: unknown } | { key: "type"; text: string; from: ""; value: undefined };

export function FieldEvidencePopover({ review, label, value, readOnly, onConfirm, onClose }: FieldEvidencePopoverProps) {
  const id = useId();
  const key = confirmableKey(review.field);
  const typable = !!key && TYPABLE.has(key);
  const conflict = review.status === "conflict";

  const choices: Choice[] = [];
  if (!isEmpty(value)) choices.push({ key: "recorded", text: valueText(value), from: "the value recorded here", value });
  if (conflict) {
    for (const [i, v] of (review.values ?? []).entries()) {
      const text = valueText(v.value);
      if (choices.some((c) => c.text === text)) continue;
      choices.push({ key: `v${i}`, text, from: v.from.label, value: v.value });
    }
  }
  if (typable && (conflict || isEmpty(value))) choices.push({ key: "type", text: "Type another value", from: "", value: undefined });

  const [picked, setPicked] = useState<string>(choices[0]?.key ?? "type");
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { ref, onKeyDown } = useTrap(onClose, saving);

  const choice = choices.find((c) => c.key === picked);
  const chosen = picked === "type" ? typed.trim() : choice?.value;
  const canConfirm = !!key && !readOnly && !saving && !!choice && !isEmpty(chosen);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canConfirm || !key) return;
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(key, recordValue(key, chosen, value));
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The library service did not answer.");
      setSaving(false);
    }
  };

  return (
    <div ref={ref} role="dialog" aria-labelledby={`${id}-t`} aria-busy={saving || undefined} className="ao-evidence" onKeyDown={onKeyDown}>
      <h4 id={`${id}-t`} className="ao-evidence__title">
        {label}: evidence
      </h4>
      <p>
        <strong>{statusWords(review.status)}.</strong>{" "}
        {review.reason ? <UserText>{review.reason}</UserText> : null}
      </p>
      {review.evidence.length === 0 ? (
        <p className="ao-muted">No evidence is recorded for this field.</p>
      ) : (
        <ul className="ao-plain-list ao-evidence__list" aria-label={`Evidence for ${label}`}>
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
      <form onSubmit={(e) => void submit(e)}>
        {key && choices.length > 1 && (
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
        {key && picked === "type" && (
          <div className="ao-cite__field">
            <label htmlFor={`${id}-typed`}>Your value</label>
            <input id={`${id}-typed`} dir="auto" value={typed} disabled={saving} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        {!key && <p className="ao-muted">This field cannot be confirmed here on its own. Change it with Edit details if it is wrong.</p>}
        {key && readOnly && <p className="ao-muted">This library is read-only, so nothing can be confirmed now.</p>}
        {error && (
          <p role="alert" className="ao-error">
            The confirmation was not saved. {error}
          </p>
        )}
        <div className="ao-row">
          {key && (
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
  );
}
