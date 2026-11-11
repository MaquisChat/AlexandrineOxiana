/**
 * Step 7: the import report and undo (spec 5.4). Undo removes every source the batch created
 * (including those still waiting for review) and reverts its merges and updates into sources that
 * existed before; it asks first, naming those counts.
 */
import { useEffect, useRef, useState } from "react";
import type { ImportApi, ImportReport, UndoResult } from "../../api/import";
import { UserText } from "../../components/UserText";
import { IMPORT_PATHS, inAppLink } from "../../routes/paths";
import { count, ErrorNote, errorText, fmt, Section } from "./shared";

/** What undo would remove and restore, from the report's counts. */
export function undoCounts(r: ImportReport): { remove: number; restore: number } {
  return { remove: r.counts.created + r.counts.needsReview, restore: r.counts.merged + r.counts.updated };
}

export function undoQuestion(r: ImportReport): string {
  const { remove, restore } = undoCounts(r);
  const first = `Remove ${count(remove, "imported source")}`;
  return restore > 0 ? `${first} and restore ${count(restore, "merged source")}?` : `${first}?`;
}

const ROWS: Array<[keyof ImportReport["counts"], string]> = [
  ["created", "Created"],
  ["needsReview", "Waiting for review"],
  ["merged", "Merged into existing sources"],
  ["updated", "Updated"],
  ["duplicates", "Skipped as duplicates"],
  ["unchanged", "Unchanged"],
  ["deletedHere", "Deleted here before, not imported again"],
  ["failed", "Failed"],
];

const STATE_TEXT: Record<string, string> = {
  finished: "The import finished.",
  cancelled: "The import was cancelled. What was imported so far is kept; you can undo it.",
  failed: "The import stopped with an error. What was imported so far is kept; you can undo it.",
  undone: "This import was undone.",
  interrupted: "The import was interrupted.",
};

export interface StepReportProps {
  api: ImportApi;
  projectId: string;
  batchId: string;
  error?: string;
}

export function StepReport({ api, projectId, batchId, error: runError }: StepReportProps) {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<UndoResult | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    api
      .report(batchId)
      .then((r) => live && setReport(r))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [api, batchId]);

  const undo = async () => {
    setUndoing(true);
    setError(null);
    try {
      setUndone(await api.undo(batchId));
      setConfirming(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUndoing(false);
    }
  };

  const close = () => {
    setConfirming(false);
    undoButton.current?.focus();
  };

  return (
    <Section title="Report and undo">
      {runError && <p className="ao-import__error">{runError}</p>}
      <ErrorNote error={error} />
      {!report && !error && <p role="status">Loading the report…</p>}
      {report && (
        <>
          <p>
            Import {fmt(report.number)}. {STATE_TEXT[undone ? "undone" : report.state] ?? ""}
          </p>
          <table className="ao-import__table">
            <caption className="ao-visually-hidden">Items by outcome</caption>
            <tbody>
              {ROWS.filter(([k]) => k === "created" || report.counts[k] > 0).map(([k, label]) => (
                <tr key={k}>
                  <th scope="row">{label}</th>
                  <td>{fmt(report.counts[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.pendingReview.length > 0 && !undone && (
            <p>
              <a href={`${IMPORT_PATHS.review}?project=${encodeURIComponent(projectId)}&batch=${encodeURIComponent(batchId)}`} onClick={inAppLink}>
                Open the review queue ({count(report.pendingReview.length, "item")})
              </a>
            </p>
          )}

          {report.failures.length > 0 && (
            <details className="ao-import__details" open>
              <summary>Failures ({fmt(report.failures.length)})</summary>
              <ul>
                {report.failures.map((f, i) => (
                  <li key={i}>
                    <UserText>{f.item}</UserText>: {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.fileNotes.length > 0 && (
            <details className="ao-import__details">
              <summary>Notes about files ({fmt(report.fileNotes.length)})</summary>
              <ul>
                {report.fileNotes.map((f, i) => (
                  <li key={i}>
                    <UserText>{f.item}</UserText>: {f.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.keptFields.length > 0 && (
            <details className="ao-import__details">
              <summary>Your edits that were kept ({fmt(report.keptFields.length)})</summary>
              <ul>
                {report.keptFields.map((f, i) => (
                  <li key={i}>
                    <UserText>{f.item}</UserText>: {f.fields.join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.governance.length > 0 && (
            <Section title="Project rules applied" level={3}>
              <ul>
                {report.governance.map((g, i) => (
                  <li key={i}>
                    {g.action}: {g.result}
                    {g.reason ? ` (${g.reason})` : ""}
                    {g.items !== undefined ? `, ${count(g.items, "item")}` : ""}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {report.notes.length > 0 && (
            <ul className="ao-import__notes">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          {undone ? (
            <div role="status">
              <p>
                Removed {count(undone.removedSources, "source")} and restored {count(undone.revertedMerges, "merged source")}.
              </p>
              {undone.kept.length > 0 && (
                <ul>
                  {undone.kept.map((k) => (
                    <li key={`${k.kind}-${k.id}`}>Kept: {k.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            report.state !== "undone" && (
              <div className="ao-import__actions">
                <button type="button" ref={undoButton} onClick={() => setConfirming(true)} disabled={confirming}>
                  Undo import
                </button>
              </div>
            )
          )}
          {confirming && report && <ConfirmUndo question={undoQuestion(report)} busy={undoing} onCancel={close} onConfirm={() => void undo()} />}
        </>
      )}
    </Section>
  );
}

function ConfirmUndo({ question, busy, onCancel, onConfirm }: { question: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      className="ao-import__dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ao-undo-q"
      aria-describedby="ao-undo-d"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <p id="ao-undo-q" className="ao-import__dialog-question">
        {question}
      </p>
      <p id="ao-undo-d" className="ao-import__hint">
        Collections and tags this import created are removed too, unless something else uses them. Your later edits to merged sources are kept.
      </p>
      <div className="ao-import__actions">
        <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="ao-import__danger" onClick={onConfirm} disabled={busy}>
          Undo import
        </button>
      </div>
    </div>
  );
}
