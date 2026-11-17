/**
 * Step 6: the import runs in the library service (Identify happens here, item by item). Progress
 * comes from the service's `import.progress` events (GET /events, read with `client.events()`);
 * Pause and Resume call the batch routes. A batch that ends (finished, cancelled, failed) hands
 * over to the report.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Focus the heading once shown: the researcher arrived on this run from an address (D1, R145). */
  focusOnArrival?: boolean;
}

/** Reconnects after the event stream ends before the batch does (then a message and a manual check). */
const RECONNECTS = 2;
const RECONNECT_DELAY_MS = 300;

export function StepRun({ client, api, projectId, batchId, onEnded, focusOnArrival = false }: StepRunProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  /** Focus the heading once, when the researcher arrived on this run from an address (D1, R145). */
  const arrival = useRef(focusOnArrival);
  useEffect(() => {
    if (arrival.current) heading.current?.focus();
    arrival.current = false;
  }, []);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const over = useRef(false);

  const end = useCallback((state: BatchState, err?: string) => {
    if (over.current) return;
    over.current = true;
    ended.current(state, err);
  }, []);

  /** The batch's state as the service records it; ends the run screen if the batch has ended. */
  const recheck = useCallback(async (): Promise<boolean> => {
    try {
      const b = (await api.batches(projectId)).find((x) => x.batchId === batchId);
      if (!b) return false;
      if (ENDED.has(b.state)) {
        end(b.state);
        return true;
      }
      setPaused(b.state === "paused" || b.state === "interrupted");
    } catch {
      // the stream or the next check will tell
    }
    return false;
  }, [api, projectId, batchId, end]);

  useEffect(() => {
    const ctl = new AbortController();
    let stop = false;
    (async () => {
      // On arrival: the batch may already be paused or over (R115 minor).
      if (await recheck()) return;
      for (let tries = 0; !stop && !over.current; tries++) {
        let failure: unknown;
        try {
          // A batch that ended before the stream opened would never send its last event: check once open.
          for await (const e of client.events({ signal: ctl.signal, onOpen: () => void recheck() })) {
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
          failure = err;
        }
        if (stop || ctl.signal.aborted || over.current) return;
        // The stream ended while the batch had not: check, then follow it again.
        if (await recheck()) return;
        if (tries >= RECONNECTS) {
          setLost(true);
          if (failure) setError(errorText(failure));
          return;
        }
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    })();
    return () => {
      stop = true;
      ctl.abort();
    };
  }, [client, batchId, recheck, end, attempt]);

  const checkAgain = async () => {
    setError(null);
    if (await recheck()) return;
    setLost(false);
    setAttempt((n) => n + 1);
  };

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
    <Section title="Run" headingRef={heading}>
      <p>
        The import runs in the background and survives restarts; items are identified as they are imported. You can keep working.
      </p>
      <label className="ao-import__progress">
        <span>Import progress</span>
        {/* R392: with a total, a bar of that maximum; without one, an open-ended bar (no value, no maximum). */}
        <progress {...(total !== undefined ? { value: done, max: total } : {})} />
      </label>
      <p role="status">
        {paused ? "Paused. " : ""}
        {total !== undefined ? `${fmt(done)} of ${fmt(total)} items` : done > 0 ? `${fmt(done)} ${done === 1 ? "item" : "items"} so far` : "Starting…"}
      </p>
      {lost && (
        <div className="ao-import__warning" role="alert">
          <p>Progress updates are not available right now. The import keeps running in the library service; check again to see where it is.</p>
          <button type="button" onClick={() => void checkAgain()}>
            Check again
          </button>
        </div>
      )}
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
