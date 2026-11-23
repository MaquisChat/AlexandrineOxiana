/**
 * The capture queue (Task 34b): each queue the screen started, each link with its status in words
 * (never by colour alone), the reason a link failed in plain language, and the queue's progress. A
 * profile run lists its posts as they arrive and ends with a summary of the run's report. Links are
 * user text: shown with UserText (dir="auto"), never as live links.
 *
 * Only what the screen saw is claimed (R146): an item whose outcome was missed is "Not known", the
 * counts add up to the total (done + failed + not known + not tried + still to come), a queue whose
 * progress may have been missed says so, and the library's own sentence for a stopped or paused run
 * is shown as it is, with the counts of what was saved. A queue read again from the service (Task 63)
 * says when the browser extension sent it; a missed outcome stays "Not known" only until the queue
 * can be read again.
 */
import { useId } from "react";
import { editsNotCheckedText } from "@ao/shared";
import { itemExplanation, queueCounts, type CaptureQueueState, type ItemState, type ProfileReport } from "../api/capture";
import { MissingToolNotice } from "./MissingToolNotice";
import { UserText } from "./UserText";
import "./CaptureQueue.css";

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting",
  capturing: "Capturing now",
  "not-captured": "Not captured",
  unknown: "Not known",
  created: "Saved",
  duplicate: "Already in the project",
  refreshed: "Saved again with a new dated snapshot",
  incomplete: "Saved in part",
  failed: "Failed",
  "needs-review": "Saved; needs review",
};

/** The status in words; one this version does not know is "Finished" (the service's word is not shown). */
export const stateLabel = (s: ItemState): string => (Object.hasOwn(STATE_LABEL, s) ? STATE_LABEL[s]! : "Finished");

const TONE: Record<string, string> = { created: "ok", refreshed: "ok", duplicate: "info", "needs-review": "warn", incomplete: "warn", unknown: "warn", failed: "bad", "not-captured": "bad" };

const NUMBER = new Intl.NumberFormat("en");
const n = (x: number) => NUMBER.format(x);
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

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
  // Known posts whose caption looks edited but whose own data could not be fetched (FR-106).
  const lead = r.status === "completed" ? "Finished:" : r.status === "paused-rate-limited" ? "Paused:" : "Stopped:";
  // Said as the command line and the report file say it (R473 M6).
  return `${lead} ${parts.join(", ")}.${r.editsNotChecked ? ` ${editsNotCheckedText(r.editsNotChecked)}` : ""}`;
}

const hasCounts = (r: ProfileReport) => r.created + r.duplicates + r.incomplete + r.failed + r.newlyUnavailable + r.reappeared + r.edited + (r.editsNotChecked ?? 0) > 0;

/** "Of 3 links: 1 done, 1 failed, 1 not known." — only what was seen. */
function countsLine(q: CaptureQueueState, unit: string): string {
  const c = queueCounts(q);
  const parts = [
    c.done && `${n(c.done)} done`,
    c.failed && `${n(c.failed)} failed`,
    c.unknown && `${n(c.unknown)} not known`,
    c.notTried && `${n(c.notTried)} not tried`,
    c.pending && `${n(c.pending)} still to come`,
  ].filter(Boolean);
  return `${q.finished ? "Finished. " : ""}Of ${plural(c.total, unit)}: ${parts.join(", ")}.`;
}

function statusLine(q: CaptureQueueState): string {
  if (q.kind === "links") return countsLine(q, "link");
  if (q.finished) {
    if (q.report?.status === "completed") return "The profile capture finished.";
    if (q.report?.status === "paused-rate-limited") return "The profile capture is paused.";
    return "The profile capture stopped.";
  }
  if (q.total !== undefined) return countsLine(q, "post");
  return q.gap ? "How far this profile capture has got is not known: the connection was lost." : "Listing the profile…";
}

function QueueView({ q }: { q: CaptureQueueState }) {
  const id = useId();
  const status = statusLine(q);
  const r = q.report;
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
      {q.startedBy === "extension" && <p>Sent from the browser extension.</p>}
      <label className="ao-capture-queue__progress">
        <span>{q.kind === "profile" ? "Posts captured" : "Links captured"}</span>
        <progress value={q.done} {...(q.total !== undefined ? { max: Math.max(q.total, 1) } : {})} />
      </label>
      {/* Announced when the queue ends, not on every link (a long list would announce hundreds of times). */}
      {q.finished ? <p role="status">{status}</p> : <p>{status}</p>}
      {(q.stopReason || q.error) && (
        <div className="ao-capture-queue__error" role="alert">
          {q.stopReason && <UserText as="p">{q.stopReason}</UserText>}
          {q.error && <p>{q.error}</p>}
        </div>
      )}
      <MissingToolNotice from={q} as="p" />
      {q.gap && !q.forgotten && (
        <p className="ao-capture-queue__note">
          Progress was missed while the connection to the library service was down. Items marked “Not known” are updated as soon as the library service can be reached again; until then, look in the
          library for the captured sources.
        </p>
      )}
      {q.gap && q.forgotten && (
        <p className="ao-capture-queue__note">
          Progress was missed while the connection to the library service was down, and this capture can no longer be read from the library service (it was restarted, or the capture ended long ago).
          Items marked “Not known” may have been captured: look in the library for the captured sources.
        </p>
      )}
      {r && (r.status !== "failed" || hasCounts(r) || q.items.length > 0) && (
        <>
          <p>{reportSummary(r)}</p>
          {!r.listComplete && (
            <p className="ao-capture-queue__note">
              Removed posts were not looked for in this run: the list was limited (by dates or a maximum number of items) or did not come back whole.
            </p>
          )}
        </>
      )}
      {q.itemsOmitted ? (
        <p className="ao-capture-queue__note">{`The library service kept only the first ${n(q.items.length)} posts of this run; ${plural(q.itemsOmitted, "later post")} ${q.itemsOmitted === 1 ? "is" : "are"} counted above but not listed.`}</p>
      ) : null}
      {q.items.length > 0 && (
        <ol className="ao-capture-queue__items">
          {q.items.map((it, i) => {
            const why = itemExplanation(it);
            return (
              <li key={i} className={`ao-capture-queue__item ao-capture-queue__item--${TONE[it.state] ?? "plain"}`}>
                {it.url ? <UserText className="ao-capture-queue__url">{it.url}</UserText> : <span>A post whose link was not received</span>}
                <span className="ao-capture-queue__state">{stateLabel(it.state)}</span>
                {why.ui && <p className="ao-capture-queue__why">{why.ui}</p>}
                {why.service && (
                  <UserText as="p" className="ao-capture-queue__why">
                    {why.service}
                  </UserText>
                )}
                <MissingToolNotice from={it} as="p" />
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
