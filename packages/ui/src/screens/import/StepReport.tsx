/**
 * Step 7: the import report and undo (spec 5.4). Undo removes every source the batch created
 * (including those still waiting for review) and reverts its merges and updates into sources that
 * existed before; it asks first, naming those counts.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ImportApi, ImportReport, UndoResult } from "../../api/import";
import { UserText } from "../../components/UserText";
import { IMPORT_PATHS, inAppLink } from "../../navigation";
import { count, ErrorNote, errorText, fmt, Section } from "./shared";

/** What undo would remove and restore, from the report's counts. */
export function undoCounts(r: ImportReport): { remove: number; restore: number; revert: number } {
  return { remove: r.counts.created + r.counts.needsReview, restore: r.counts.merged, revert: r.counts.updated };
}

/** "Remove 1,284 imported sources, restore 3 merged sources and revert 2 updated sources?" */
export function undoQuestion(r: ImportReport): string {
  const { remove, restore, revert } = undoCounts(r);
  const parts = [`Remove ${count(remove, "imported source")}`];
  if (restore > 0) parts.push(`restore ${count(restore, "merged source")}`);
  if (revert > 0) parts.push(`revert ${count(revert, "updated source")}`);
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(", ")} and ${last}` : last}?`;
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
  /** Focus the heading once shown: the researcher arrived on this report from an address (D1, R145). */
  focusOnArrival?: boolean;
}

export function StepReport({ api, projectId, batchId, error: runError, focusOnArrival = false }: StepReportProps) {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A failed undo: shown inside the dialog while it is open (the page behind it is inert), on the page after. */
  const [undoError, setUndoError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState<UndoResult | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Focus goes back to Undo, or to the report heading when Undo is gone (R115 I6). */
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus) (undoButton.current ?? heading.current)?.focus();
  }, [refocus]);
  const arrival = useRef(focusOnArrival);
  useEffect(() => {
    if (arrival.current) heading.current?.focus();
    arrival.current = false;
  }, []);

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
    setUndoError(null);
    try {
      setUndone(await api.undo(batchId));
      setConfirming(false);
      setRefocus((n) => n + 1);
    } catch (e) {
      setUndoError(errorText(e));
    } finally {
      setUndoing(false);
    }
  };

  const close = () => {
    setConfirming(false);
    setRefocus((n) => n + 1);
  };

  return (
    <Section title="Report and undo" headingRef={heading}>
      {runError && <p className="ao-import__error">{runError}</p>}
      <ErrorNote error={error} />
      {!confirming && <ErrorNote error={undoError} />}
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
              {report.files && (
                <>
                  <tr>
                    <th scope="row">Files copied into the library</th>
                    <td>{fmt(report.files.copied)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Files left as links</th>
                    <td>{fmt(report.files.linked)}</td>
                  </tr>
                </>
              )}
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
                  <li key={`${i}:${f.item}`}>
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
                  <li key={`${i}:${f.item}`}>
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
                  <li key={`${i}:${f.item}`}>
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
                  <li key={`${i}:${g.action}`}>
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
              {report.notes.map((n, i) => (
                <li key={`${i}:${n}`}>{n}</li>
              ))}
            </ul>
          )}

          {undone ? (
            <div role="status">
              <p>
                Removed {count(undone.removedSources, "source")} and restored {count(undone.revertedMerges, "source")} that had been merged or updated.
              </p>
              {undone.kept.length > 0 && (
                <ul>
                  {undone.kept.map((k) => (
                    <li key={`${k.kind}-${k.sourceId ?? ""}-${k.id}`}>Kept: {k.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            report.state !== "undone" && (
              <div className="ao-import__actions">
                <button
                  type="button"
                  ref={undoButton}
                  onClick={() => {
                    setUndoError(null);
                    setConfirming(true);
                  }}
                  disabled={confirming}
                >
                  Undo import
                </button>
              </div>
            )
          )}
          {confirming && report && <ConfirmUndo question={undoQuestion(report)} busy={undoing} error={undoError} onCancel={close} onConfirm={() => void undo()} />}
        </>
      )}
    </Section>
  );
}

/**
 * A modal confirmation: rendered on top of the page (a portal in <body>), everything else inert
 * while it is open, Tab and Shift+Tab kept inside it, Escape cancels (except while the undo runs).
 * While it runs, focus is on a status line in the dialog; a failure is announced in the dialog and
 * focused there (41b1 I2), since the page behind it is inert.
 */
function ConfirmUndo({ question, busy, error, onCancel, onConfirm }: { question: string; busy: boolean; error: string | null; onCancel(): void; onConfirm(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const failure = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (busy) status.current?.focus();
  }, [busy]);
  useEffect(() => {
    if (error) failure.current?.focus();
  }, [error]);
  const [host] = useState(() => document.createElement("div"));

  useEffect(() => {
    document.body.appendChild(host);
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    cancel.current?.focus();
    return () => {
      for (const el of made) el.removeAttribute("inert");
      host.remove();
    };
  }, [host]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
    if (!items.length) {
      e.preventDefault(); // nothing to move to while the undo runs: focus stays on the status line
      return;
    }
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const at = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (e.shiftKey) (at <= 0 ? last : items[at - 1]!).focus();
    else (at === -1 || at === items.length - 1 ? first : items[at + 1]!).focus();
  };

  return createPortal(
    <div className="ao-import__backdrop">
      <div ref={box} className="ao-import__dialog" role="alertdialog" aria-modal="true" aria-labelledby="ao-undo-q" aria-describedby={error ? "ao-undo-d ao-undo-e" : "ao-undo-d"} onKeyDown={onKeyDown}>
        <p id="ao-undo-q" className="ao-import__dialog-question">
          {question}
        </p>
        <p id="ao-undo-d" className="ao-import__hint">
          Collections and tags this import created are removed too, unless something else uses them. Your later edits to merged sources are kept.
        </p>
        {busy && (
          <p ref={status} role="status" tabIndex={-1} className="ao-import__hint">
            Undoing the import…
          </p>
        )}
        {error && !busy && (
          <p ref={failure} id="ao-undo-e" role="alert" tabIndex={-1} className="ao-import__error">
            The import was not undone. {error}
          </p>
        )}
        <div className="ao-import__actions">
          <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="ao-import__danger" onClick={onConfirm} disabled={busy}>
            Undo import
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
