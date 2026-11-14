/**
 * The Zotero Web API key field (R78), moved unchanged out of the import wizard's Source step (Task Z9) so that the
 * wizard and the Zotero screen use the one field. It stores the key through the service in this computer's password
 * store (PUT /secrets/zotero-api-key); the field is emptied as soon as the key is sent, and the service never sends it
 * back, so all it shows afterwards is whether one is stored. `onChanged` is called after a key was stored or removed
 * (never with the key).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isZoteroApiKeyShape } from "@ao/shared";
import { ApiClientError } from "../api/client";
import type { ImportApi } from "../api/import";
import { ErrorNote, errorText } from "../screens/import/shared";
import "../screens/import/import.css";

export interface ZoteroKeyFieldProps {
  api: Pick<ImportApi, "zoteroKeyStored" | "storeZoteroKey" | "removeZoteroKey">;
  /** After a key was stored or removed. */
  onChanged?(): void;
}

const KEY_RULE = "That does not look like a Zotero API key: it is 24 letters and digits. Create one at zotero.org, Settings, Security.";

/** The service's words for a missing password store (503) stand alone; other errors as usual. */
function keyError(err: unknown): string {
  return err instanceof ApiClientError && err.status === 503 ? err.message : errorText(err);
}

/**
 * The Zotero Web API key (R78): stored through the service in this computer's password store. It is
 * write-only: the field is emptied once the key is stored, and the service never sends it back, so
 * all this shows is whether one is stored. One request at a time; answers after unmount are dropped.
 */
export function ZoteroKeyField({ api, onChanged }: ZoteroKeyFieldProps) {
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
    api.zoteroKeyStored().then(
      (s) => live.current && setStored(s),
      (e: unknown) => live.current && setError(keyError(e)),
    );
    return () => {
      live.current = false;
    };
  }, [api]);

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
    const key = value.trim();
    if (!isZoteroApiKeyShape(key)) {
      setError(KEY_RULE);
      return;
    }
    // Once sent, the key leaves the page whatever the answer: it is typed again to retry.
    setValue("");
    void run(
      () => api.storeZoteroKey(key),
      () => {
        setStored(true);
        setStatus("The key is stored in this computer's password store.");
        onChanged?.();
      },
    );
  };
  const remove = () =>
    void run(
      () => api.removeZoteroKey(),
      () => {
        setStored(false);
        setStatus("The key was removed from this computer's password store.");
        onChanged?.();
      },
    );

  return (
    <div className="ao-import__key">
      {stored !== null && <p className="ao-import__hint">{stored ? "A Zotero key is stored on this computer." : "No Zotero key is stored on this computer."}</p>}
      <form className="ao-import__key-form" onSubmit={store}>
        <label className="ao-import__field">
          <span>Zotero API key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={value} aria-describedby={`${id}-key-hint`} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {stored ? "Replace key" : "Store key"}
        </button>
        {stored && (
          <button type="button" disabled={busy} onClick={remove}>
            Remove key
          </button>
        )}
      </form>
      <p id={`${id}-key-hint`} className="ao-import__hint">
        Kept only in this computer's password store (the system keychain or credential manager), never in the library or a file, and never shown again. Public group libraries need no key.
      </p>
      <p role="status" className="ao-import__hint">
        {status}
      </p>
      <ErrorNote error={error} />
    </div>
  );
}
