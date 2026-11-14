/**
 * A key field (Find and acquire Task F13; R78, R290 a, R302 e): the Zotero key field generalised, used for the Zotero,
 * Elicit and OpenAlex keys. A key is kept only by the service, in this computer's password store; this field hands it
 * to `store` once, empties itself as soon as it is sent (whatever the answer: it is typed again to retry), and shows
 * afterwards only whether a key is saved — the service never sends one back. The key is held only in the field's own
 * value while it is typed: never in a URL, an element's text or attribute after it is sent, storage, or a console call.
 * One request at a time; answers after unmount are dropped. A service sentence (a 503 with no password store) is shown
 * as the service gives it.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiClientError } from "../api/client";
import { errorText } from "../screens/import/shared";
import "../screens/import/import.css";
import { UserText } from "./UserText";

/** The field's own words (the Zotero field's, unless a caller gives its own). */
export interface KeyFieldWords {
  /** Said while a key is saved. */
  storedYes: string;
  /** Said while none is. */
  storedNo: string;
  /** Said once after a key was saved. */
  storedNow: string;
  /** Said once after the key was removed. */
  removedNow: string;
  /** The buttons' names. */
  store: string;
  replace: string;
  remove: string;
}

export const ZOTERO_KEY_WORDS: KeyFieldWords = {
  storedYes: "A Zotero key is stored on this computer.",
  storedNo: "No Zotero key is stored on this computer.",
  storedNow: "The key is stored in this computer's password store.",
  removedNow: "The key was removed from this computer's password store.",
  store: "Store key",
  replace: "Replace key",
  remove: "Remove key",
};

export interface KeyFieldProps {
  label: string;
  help: ReactNode;
  stored(): Promise<boolean>;
  store(v: string): Promise<void>;
  remove(): Promise<void>;
  /** The refusal of a value that is not of a key's shape (null: accepted). Checked before anything is sent. */
  shape?: (v: string) => string | null;
  /** The field's words; the Zotero field's by default. */
  words?: Partial<KeyFieldWords>;
  /** After a key was stored or removed (never with the key). */
  onChanged?(): void;
}

/** The service's words for a missing password store (503) stand alone; other errors as usual. */
function keyError(err: unknown): string {
  return err instanceof ApiClientError && err.status === 503 ? err.message : errorText(err);
}

export function KeyField({ label, help, stored: readStored, store: storeKey, remove: removeKey, shape, words, onChanged }: KeyFieldProps) {
  const w = { ...ZOTERO_KEY_WORDS, ...words };
  const id = useId();
  const [stored, setStored] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const live = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    live.current = true;
    readStored().then(
      (s) => live.current && setStored(s),
      (e: unknown) => live.current && setError(keyError(e)),
    );
    return () => {
      live.current = false;
    };
  }, [readStored]);

  const run = async (what: () => Promise<unknown>, after: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      await what();
      if (live.current) after();
    } catch (e) {
      if (live.current) setError(keyError(e));
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };

  const store = (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    const key = value.trim();
    const refused = shape?.(key) ?? null;
    if (refused !== null) {
      setError(refused);
      return;
    }
    // Once sent, the key leaves the page whatever the answer: it is typed again to retry.
    setValue("");
    void run(
      () => storeKey(key),
      () => {
        setStored(true);
        setStatus(w.storedNow);
        onChanged?.();
      },
    );
  };
  const remove = () =>
    void run(
      () => removeKey(),
      () => {
        setStored(false);
        setStatus(w.removedNow);
        onChanged?.();
      },
    );

  return (
    <div className="ao-import__key">
      {stored !== null && <p className="ao-import__hint">{stored ? w.storedYes : w.storedNo}</p>}
      <form className="ao-import__key-form" onSubmit={store}>
        <label className="ao-import__field">
          <span>{label}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={value} aria-describedby={`${id}-key-hint`} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {stored ? w.replace : w.store}
        </button>
        {stored && (
          <button type="button" disabled={busy} onClick={remove}>
            {w.remove}
          </button>
        )}
      </form>
      <p id={`${id}-key-hint`} className="ao-import__hint">
        {help}
      </p>
      <p role="status" className="ao-import__hint">
        {status}
      </p>
      {error && (
        <p className="ao-import__error" role="alert">
          <UserText>{error}</UserText>
        </p>
      )}
    </div>
  );
}
