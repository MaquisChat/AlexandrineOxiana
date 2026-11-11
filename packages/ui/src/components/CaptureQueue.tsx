/**
 * The capture queue (Task 34b): each queue the screen started, each link with its status in words
 * (never by colour alone), the reason a link failed in plain language, and the queue's progress. A
 * profile run lists its posts as they arrive and ends with a summary of the run's report. Links are
 * user text: shown with UserText (dir="auto"), never as live links.
 */
import { useId } from "react";
import { outcomeText, type CaptureQueueState, type ItemState, type ProfileReport, type QueueItem } from "../api/capture";
import { UserText } from "./UserText";
import "./CaptureQueue.css";

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting",
  capturing: "Capturing now",
  "not-captured": "Not captured",
  created: "Saved",
  duplicate: "Already in the project",
  refreshed: "Saved again with a new dated snapshot",
  incomplete: "Saved in part",
  failed: "Failed",
  "needs-review": "Saved; needs review",
};

/** The status in words; one this version does not know is "Finished" (the service's word is not shown). */
export const stateLabel = (s: ItemState): string => (Object.hasOwn(STATE_LABEL, s) ? STATE_LABEL[s]! : "Finished");

const TONE: Record<string, string> = { created: "ok", refreshed: "ok", duplicate: "info", "needs-review": "warn", incomplete: "warn", failed: "bad", "not-captured": "bad" };

const NUMBER = new Intl.NumberFormat("en");
const n = (x: number) => NUMBER.format(x);
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** The sentence under a link: why it failed or was saved only in part. */
function itemReason(it: QueueItem): string | undefined {
  if (it.state === "failed" || it.state === "incomplete") return outcomeText(it.errorCode, it.reason);
  if (it.state === "not-captured") return "This link was not tried. Capture it again.";
  if (it.state === "duplicate") return "This post is already in the project; nothing new was saved. Choose “Refresh existing” to save a new dated snapshot.";
  if (it.state === "needs-review") return "Some details could not be confirmed, so the source is in the review queue.";
  return undefined;
}

function reportSummary(r: ProfileReport): string {
  const parts = [
    `${plural(r.created, "new post")} saved`,
    `${n(r.duplicates)} already in the project`,
    `${n(r.incomplete)} saved in part`,
    `${n(r.failed)} not saved`,
  ];
  if (r.newlyUnavailable) parts.push(`${plural(r.newlyUnavailable, "post")} no longer on the platform`);
  if (r.reappeared) parts.push(`${plural(r.reappeared, "post")} back on the platform`);
  if (r.edited) parts.push(`${plural(r.edited, "post")} edited since the last capture`);
  const lead = r.status === "completed" ? "Finished:" : r.status === "paused-rate-limited" ? "Paused:" : "Stopped:";
  return `${lead} ${parts.join(", ")}.`;
}

function QueueView({ q }: { q: CaptureQueueState }) {
  const id = useId();
  const unit = q.kind === "profile" ? "post" : "link";
  const failed = q.items.filter((i) => i.state === "failed").length;
  const status = q.finished
    ? q.kind === "profile"
      ? q.report?.status === "paused-rate-limited"
        ? "Paused: the platform is limiting requests. Run the capture again later; it continues where it stopped."
        : q.error
          ? "The profile capture stopped."
          : "The profile capture finished."
      : `Finished: ${n(q.done)} of ${plural(q.total ?? q.items.length, unit)} done${failed ? `, ${n(failed)} failed` : ""}.`
    : q.total !== undefined
      ? `${n(q.done)} of ${plural(q.total, unit)} done${failed ? `, ${n(failed)} failed` : ""}.`
      : q.kind === "profile"
        ? "Listing the profile…"
        : "Starting…";
  return (
    <section className="ao-capture-queue__queue" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>
        {q.kind === "profile" ? (
          <>
            Profile capture: <UserText>{q.url}</UserText>
          </>
        ) : (
          `${plural(q.total ?? q.items.length, "link")}`
        )}
      </h3>
      <label className="ao-capture-queue__progress">
        <span>{q.kind === "profile" ? "Posts captured" : "Links captured"}</span>
        <progress value={q.done} {...(q.total !== undefined ? { max: Math.max(q.total, 1) } : {})} />
      </label>
      <p role="status">{status}</p>
      {q.error && (
        <p className="ao-capture-queue__error" role="alert">
          {q.error}
        </p>
      )}
      {q.report && q.report.status !== "failed" && (
        <>
          <p>{reportSummary(q.report)}</p>
          {!q.report.listComplete && (
            <p className="ao-capture-queue__note">
              Removed posts were not looked for in this run: the list was limited (by dates or a maximum number of items) or did not come back whole.
            </p>
          )}
        </>
      )}
      {q.items.length > 0 && (
        <ol className="ao-capture-queue__items">
          {q.items.map((it, i) => {
            const why = itemReason(it);
            return (
              <li key={i} className={`ao-capture-queue__item ao-capture-queue__item--${TONE[it.state] ?? "plain"}`}>
                <UserText className="ao-capture-queue__url">{it.url}</UserText>
                <span className="ao-capture-queue__state">{stateLabel(it.state)}</span>
                {why && <p className="ao-capture-queue__why">{why}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function CaptureQueue({ queues }: { queues: CaptureQueueState[] }) {
  const id = useId();
  if (!queues.length) return null;
  return (
    <section className="ao-capture-queue" aria-labelledby={id}>
      <h2 id={id}>Capture queue</h2>
      {[...queues].reverse().map((q) => (
        <QueueView key={q.queueId} q={q} />
      ))}
    </section>
  );
}
