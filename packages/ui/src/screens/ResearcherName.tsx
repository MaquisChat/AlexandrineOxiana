/**
 * The researcher's display name on this device (R84/R117): the photographer of device imports and
 * the person named on certificates of destroyed raw data. Stored in this device's app settings by
 * the service (GET/PUT /settings/researcher); empty means "use this computer's user name".
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import "../components/library.css";

export function ResearcherNameSetting({ client }: { client: ApiClient }) {
  const id = useId();
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.request<{ name: string | null }>("GET", "/settings/researcher").then(
      (r) => {
        if (!live) return;
        setName(r.name ?? "");
        setLoaded(true);
      },
      () => live && setLoaded(true),
    );
    return () => {
      live = false;
    };
  }, [client]);

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
      <h2 id={`${id}-h`}>Researcher name</h2>
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
    </section>
  );
}
