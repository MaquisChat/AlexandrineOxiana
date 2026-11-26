/**
 * Step 6: the import runs in the library service (Identify happens here, item by item). Progress
 * comes from the service's `import.progress` events (GET /events, read with `client.events()`);
 * Pause and Resume call the batch routes. A batch that ends (finished, cancelled, failed) hands
 * over to the report.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { STREAM_OPEN_TIMEOUT_MS, STREAM_QUIET_TIMEOUT_MS, type ApiClient, type ApiClientError } from "../../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, isUnreachable, readWithin } from "../../api/firstRead";
import { isProgressFor, type BatchState, type ImportApi } from "../../api/import";
import { ErrorNote, errorText, fmt, Section } from "./shared";
import { useLeaveSignal } from "../../components/leaveSignals";

const ENDED: ReadonlySet<BatchState> = new Set(["finished", "cancelled", "failed", "undone"]);

export interface StepRunProps {
  client: ApiClient;
  api: ImportApi;
  projectId: string;
  batchId: string;
  onEnded(state: BatchState, error?: string): void;
  /** Focus the heading once shown: the researcher arrived on this run from an address (D1, R145). */
  focusOnArrival?: boolean;
  /** FR-756: how long each read of the batch's state is waited for (a read given up is one that failed: silent). */
  firstReadMs?: number;
  /** FR-756 (R597): how long the event stream is waited for to open before it is closed and tried afresh. */
  streamOpenMs?: number;
  /** R641 D2: how long an open event stream may deliver nothing (not even the service's keep-alive) before it is closed and tried afresh. */
  streamQuietMs?: number;
}

/** Reconnects after the event stream ends before the batch does (then a message and a manual check). */
const RECONNECTS = 2;
const RECONNECT_DELAY_MS = 300;

export function StepRun({ client, api, projectId, batchId, onEnded, focusOnArrival = false, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS, streamQuietMs = STREAM_QUIET_TIMEOUT_MS }: StepRunProps) {
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
  /** R605 M3: the checks are cancelled when the step is left. */
  const leaving = useLeaveSignal();
  const recheck = useCallback(async (): Promise<boolean> => {
    try {
      // FR-756: given up after `firstReadMs` (the check on arrival comes before listening: one that never settled kept
      // the step from ever following the run).
      const b = (await readWithin((signal) => api.batches(projectId, { signal }), firstReadMs, leaving())).find((x) => x.batchId === batchId);
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
  }, [api, projectId, batchId, end, firstReadMs, leaving]);

  useEffect(() => {
    const ctl = new AbortController();
    let stop = false;
    (async () => {
      // On arrival: the batch may already be paused or over (R115 minor).
      if (await recheck()) return;
      // R658, R659: the tries in a row that did not prove themselves. A connection proves itself by delivering a progress
      // event of this batch, or by staying open and silent to its quiet limit. Any other event (the service's opening
      // `library.state`, another batch's) proves nothing; nor does a stream that closes at once, or never opens.
      let tries = 0;
      while (!stop && !over.current) {
        let failure: unknown;
        let opened = false;
        let proved = false;
        try {
          // A batch that ended before the stream opened would never send its last event: check once open. FR-756 (R597):
          // a stream not opened within `streamOpenMs` is closed and tried afresh below.
          const onOpen = () => {
            opened = true;
            void recheck();
          };
          for await (const e of client.events({ signal: ctl.signal, onOpen, openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })) {
            if (!isProgressFor(batchId, e)) continue;
            proved = true;
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
          // Once open, the client's "did not answer in time" is only its quiet limit: the stream was open and silent to it.
          if (opened && isNoAnswerInTime(err)) proved = true;
        }
        if (stop || ctl.signal.aborted || over.current) return;
        // The stream ended while the batch had not: check, then follow it again.
        if (await recheck()) return;
        if (proved) tries = 0;
        else if (tries++ >= RECONNECTS) {
          setLost(true);
          // A stream that got no answer says only its own sentence ("did not answer in time" or "could not be reached").
          if (failure) setError(isUnreachable(failure) ? (failure as ApiClientError).message : errorText(failure));
          return;
        }
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    })();
    return () => {
      stop = true;
      ctl.abort();
    };
  }, [client, batchId, recheck, end, attempt, streamOpenMs, streamQuietMs]);

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
