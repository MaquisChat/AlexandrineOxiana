/**
 * Step 6: the import runs in the library service (Identify happens here, item by item). Progress
 * comes from the service's `import.progress` events (GET /events, read with `client.events()`);
 * Pause and Resume call the batch routes. A batch that ends (finished, cancelled, failed) hands
 * over to the report.
 */
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client";
import { isProgressFor, type BatchState, type ImportApi } from "../../api/import";
import { ErrorNote, errorText, fmt, Section } from "./shared";

const ENDED: ReadonlySet<BatchState> = new Set(["finished", "cancelled", "failed", "undone"]);

export interface StepRunProps {
  client: ApiClient;
  api: ImportApi;
  projectId: string;
  batchId: string;
  onEnded(state: BatchState, error?: string): void;
}

export function StepRun({ client, api, projectId, batchId, onEnded }: StepRunProps) {
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    const ctl = new AbortController();
    let over = false;
    const end = (state: BatchState, err?: string) => {
      if (over) return;
      over = true;
      ctl.abort();
      ended.current(state, err);
    };
    (async () => {
      try {
        for await (const e of client.events({ signal: ctl.signal })) {
          if (!isProgressFor(batchId, e)) continue;
          const d = e.data;
          if (typeof d.done === "number") setDone(d.done);
          if (typeof d.total === "number") setTotal(d.total);
          if (d.state === "paused") setPaused(true);
          else if (d.state === "running") setPaused(false);
          if (ENDED.has(d.state)) {
            const err = d.error === undefined ? undefined : typeof d.error === "string" ? d.error : (d.error.message ?? "The import failed.");
            end(d.state, err);
            return;
          }
        }
      } catch (err) {
        if (!ctl.signal.aborted) setError(`Progress updates stopped: ${errorText(err)}`);
      }
    })();
    // A batch that ended before the event stream opened is found in the project's batch list.
    api
      .batches(projectId)
      .then((list) => {
        const b = list.find((x) => x.batchId === batchId);
        if (b && ENDED.has(b.state)) end(b.state);
      })
      .catch(() => {});
    return () => {
      over = true;
      ctl.abort();
    };
  }, [client, api, projectId, batchId]);

  const act = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      await api[action](batchId);
      if (action === "pause") setPaused(true);
      if (action === "resume") setPaused(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Run">
      <p>
        The import runs in the background and survives restarts; items are identified as they are imported. You can keep working.
      </p>
      <label className="ao-import__progress">
        <span>Import progress</span>
        <progress value={done} {...(total !== undefined ? { max: total } : {})} />
      </label>
      <p role="status">
        {paused ? "Paused. " : ""}
        {total !== undefined ? `${fmt(done)} of ${fmt(total)} items` : done > 0 ? `${fmt(done)} items` : "Starting…"}
      </p>
      <ErrorNote error={error} />
      <div className="ao-import__actions">
        {paused ? (
          <button type="button" className="ao-import__primary" disabled={busy} onClick={() => void act("resume")}>
            Resume
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void act("pause")}>
            Pause
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void act("cancel")}>
          Cancel import
        </button>
      </div>
    </Section>
  );
}
