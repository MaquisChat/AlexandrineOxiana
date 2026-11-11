/**
 * An encrypted project that is locked: its passphrase (or recovery code) unlocks it for this
 * session. A wrong one changes nothing, and says so. The field is cleared after every attempt; the
 * secret is sent once in the request body and never kept.
 */
import { useId, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { errorText, type LibraryApi, type ProjectSummary } from "../api/library";
import { UserText } from "../components/UserText";
import "../components/library.css";

export const WRONG_PASSPHRASE_MESSAGE = "That passphrase didn't unlock this project. Nothing was changed.";

export interface UnlockProjectProps {
  api: Pick<LibraryApi, "projects">;
  project: Pick<ProjectSummary, "id" | "name">;
  onUnlocked: () => void;
}

export function UnlockProject({ api, project, onUnlocked }: UnlockProjectProps) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!secret || busy) return;
    setBusy(true);
    setError(undefined);
    const attempt = secret;
    setSecret("");
    try {
      await api.projects.unlock(project.id, attempt);
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "WRONG_PASSPHRASE") setError(WRONG_PASSPHRASE_MESSAGE);
      else setError(errorText(err, "The project could not be unlocked."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-h`} className="ao-card">
      <h2 id={`${id}-h`}>
        <UserText>{project.name}</UserText> is locked
      </h2>
      <p>This project is encrypted. Enter its passphrase, or the recovery code you saved when it was created, to open it on this computer.</p>
      <form onSubmit={(e) => void submit(e)} className="ao-inline-form">
        <label htmlFor={id}>Passphrase or recovery code</label>
        <input id={id} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} aria-describedby={error ? `${id}-err` : undefined} />
        <button type="submit" disabled={busy}>
          Unlock
        </button>
      </form>
      {error && (
        <p id={`${id}-err`} role="alert" className="ao-error">
          {error}
        </p>
      )}
    </section>
  );
}
