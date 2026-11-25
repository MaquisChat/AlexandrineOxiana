/**
 * The researcher's display name on this device (R84/R117): the photographer of device imports and
 * the person named on certificates of destroyed raw data. Stored in this device's app settings by
 * the service (GET/PUT /settings/researcher); empty means "use this computer's user name".
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, readWithin } from "../api/firstRead";
import { TryAgain } from "../components/TryAgain";
import "../components/library.css";

/** `firstReadMs` (FR-756, R579): how long the stored name is waited for before the read is given up (smaller in tests). */
export function ResearcherNameSetting({ client, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; firstReadMs?: number }) {
  const id = useId();
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** FR-756: the name's read was given up or failed: "Try again" reads it again (`readTry` moves on with it). */
  const [readFailed, setReadFailed] = useState(false);
  const [readTry, setReadTry] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    // FR-756: a read that never settles is given up after `firstReadMs` (its request cancelled).
    readWithin((signal) => client.request<{ name: string | null }>("GET", "/settings/researcher", { signal }), firstReadMs, ac.signal).then(
      (r) => {
        if (!live) return;
        setName(r.name ?? "");
        setLoaded(true);
      },
      // Not read: the form stays off, or saving would clear a name that was never shown (41b2 M9).
      (err: unknown) => {
        if (!live) return;
        setReadFailed(true);
        setError(isNoAnswerInTime(err) ? (err as Error).message : "Your name as researcher could not be read, so it cannot be changed here now. Nothing was changed.");
      },
    );
    return () => {
      live = false;
      ac.abort();
    };
  }, [client, firstReadMs, readTry]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const r = await client.request<{ name: string | null }>("PUT", "/settings/researcher", { body: { name: name.trim() ? name.trim() : null } });
      setName(r.name ?? "");
      setSaved(r.name ? "Saved." : "Saved: this computer's user name is used.");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The name could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-h`} className="ao-page">
      <h2 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
        Researcher name
      </h2>
      <form onSubmit={(e) => void save(e)} className="ao-inline-form">
        <label htmlFor={`${id}-name`}>Your name as researcher</label>
        <input id={`${id}-name`} type="text" dir="auto" maxLength={200} disabled={!loaded} value={name} aria-describedby={`${id}-hint`} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!loaded || saving}>
          Save name
        </button>
      </form>
      <p id={`${id}-hint`} className="ao-muted">
        Used on this computer as the photographer of device imports and as the person named on certificates of destroyed raw data. Leave it empty to use this computer&apos;s user name.
      </p>
      {saved && <p role="status">{saved}</p>}
      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
      {error && readFailed && !loaded && (
        <TryAgain
          focusTo={headingRef}
          onPress={() => {
            setError(null);
            setReadFailed(false);
            setReadTry((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}
