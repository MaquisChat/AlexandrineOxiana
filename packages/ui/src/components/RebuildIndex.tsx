/**
 * "Rebuild library from folder" (spec 4.3, D8): makes the library's search index again from its
 * files (POST /libraries/rebuild-index). The files are the record and are not changed; the action is
 * safe to repeat. A double click sends one request; a refusal or failure is said in plain words.
 */
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../api/library";

export interface RebuildIndexApi {
  rebuildIndex(): Promise<{ indexed: number; lockedProjects: number; errors: number }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function RebuildIndex({ api }: { api: RebuildIndexApi }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ indexed: number; lockedProjects: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const live = useRef(true);
  // Set again at mount: under strict mode (mount, clean-up, mount) the result would never be shown (FR-762).
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const rebuild = async () => {
    if (running.current) return; // a double click sends one request
    running.current = true;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api.rebuildIndex();
      if (live.current) setDone(r);
    } catch (err) {
      if (live.current) setError(errorText(err, "The index could not be rebuilt. Your sources are safe in the library folder; try again."));
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };

  return (
    <section className="ao-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Search index</h2>
      <p>
        The library's files are its record; the search index is made from them. If sources seem to be missing from the list or from search, rebuild the index from the library folder.
        Nothing in the library's files is changed.
      </p>
      <div className="ao-actions">
        <button type="button" disabled={busy} onClick={() => void rebuild()}>
          Rebuild library from folder
        </button>
      </div>
      {busy ? <p role="status">Rebuilding the index from the library folder…</p> : null}
      {done ? (
        <p role="status">
          The index was rebuilt from the library folder: {plural(done.indexed, "source")} indexed.
          {done.lockedProjects > 0 ? ` ${plural(done.lockedProjects, "locked project")} ${done.lockedProjects === 1 ? "is" : "are"} indexed without titles or text; ${done.lockedProjects === 1 ? "it is completed when it is unlocked" : "each is completed when it is unlocked"}.` : ""}
          {done.errors > 0 ? ` ${plural(done.errors, "folder")} could not be read and ${done.errors === 1 ? "was" : "were"} left out; check the verification report.` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}
    </section>
  );
}
