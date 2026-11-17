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

/**
 * What undo would remove and restore, from the report's counts. Zotero (Z5, R224): the sources this import marked
 * gone from Zotero lose the mark (`unmark`); those it brought back without updating them get the mark again
 * (`remark`; a back that also updated the item is an updated source, in `revert`). Sources already marked earlier
 * and gone items with no source of their own here are not changed by the undo. Z6 (R236 e): the sources whose field
 * changed in Zotero and here have Zotero's waiting value taken off (`unconflict`; the researcher's value stays).
 */
export function undoCounts(r: ImportReport): { remove: number; restore: number; revert: number; unmark: number; remark: number; unconflict: number } {
  const c = r.counts;
  return {
    remove: c.created + c.needsReview,
    restore: c.merged,
    revert: c.updated,
    unmark: c.goneInZotero ?? 0,
    remark: Math.max(0, (c.backInZotero ?? 0) - (c.backInZoteroUpdated ?? 0)),
    unconflict: c.conflicts ?? 0,
  };
}

/** R393: a group of failures with more items than this is collapsed under its reason. */
const GROUP_OPEN_MAX = 10;

/** R393: failures by reason, in the order each reason first occurs, with their items in order. */
export function failureGroups(failures: ImportReport["failures"]): Array<{ reason: string; items: string[] }> {
  const groups = new Map<string, string[]>();
  for (const f of failures) {
    const items = groups.get(f.reason);
    if (items) items.push(f.item);
    else groups.set(f.reason, [f.item]);
  }
  return [...groups].map(([reason, items]) => ({ reason, items }));
}

/** Parts joined as a sentence: "a, b and c", its first letter a capital. */
function sentence(parts: string[]): string {
  const last = parts[parts.length - 1]!;
  const s = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${last}` : last;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Remove 1,284 imported sources, restore 3 merged sources and revert 2 updated sources?" — a part whose number is 0 is left out. */
export function undoQuestion(r: ImportReport): string {
  const { remove, restore, revert, unmark, remark, unconflict } = undoCounts(r);
  // A run that added or changed no source can still have written something small (for instance the order of
  // highlights); undo stays available and puts that back, but the question does not call it a change to sources.
  if (remove === 0 && restore === 0 && revert === 0 && unmark === 0 && remark === 0 && unconflict === 0) return "This import added and changed no sources. Undo it anyway?";
  const parts: string[] = [];
  if (remove > 0) parts.push(`remove ${count(remove, "imported source")}`);
  if (restore > 0) parts.push(`restore ${count(restore, "merged source")}`);
  if (revert > 0) parts.push(`revert ${count(revert, "updated source")}`);
  if (unmark > 0) parts.push(`take the Zotero mark off ${count(unmark, "source")}`);
  if (remark > 0) parts.push(`mark ${count(remark, "source")} as gone from Zotero again`);
  if (unconflict > 0) parts.push(`take the Zotero values waiting for your decision off ${count(unconflict, "source")} (your values stay as they are)`);
  return `${sentence(parts)}?`;
}

/** What the undo did, in the question's terms (zeros left out); an older service's answer keeps the earlier sentence. */
export function undoneText(u: UndoResult): string {
  const r = u.reverted;
  if (!r) return `Removed ${count(u.removedSources, "source")} and restored ${count(u.revertedMerges, "source")} that had been merged or updated.`;
  const parts: string[] = [];
  if (u.removedSources > 0) parts.push(`removed ${count(u.removedSources, "imported source")}`);
  if (r.merged > 0) parts.push(`restored ${count(r.merged, "merged source")}`);
  if (r.updated > 0) parts.push(`reverted ${count(r.updated, "updated source")}`);
  if (r.unmarked > 0) parts.push(`took the Zotero mark off ${count(r.unmarked, "source")}`);
  if (r.remarked > 0) parts.push(`marked ${count(r.remarked, "source")} as gone from Zotero again`);
  if ((r.conflicts ?? 0) > 0) parts.push(`took the waiting Zotero values off ${count(r.conflicts!, "source")}`);
  return parts.length ? `${sentence(parts)}.` : "No source needed to be changed.";
}

type CountKey = "created" | "needsReview" | "merged" | "updated" | "duplicates" | "unchanged" | "deletedHere" | "failed";

const ROWS: Array<[CountKey, string]> = [
  ["created", "Created"],
  ["needsReview", "Waiting for review"],
  ["merged", "Merged into existing sources"],
  ["updated", "Updated"],
  ["duplicates", "Skipped as duplicates"],
  ["unchanged", "Unchanged"],
  ["deletedHere", "Deleted here before, not imported again"],
  ["failed", "Failed"],
];

/** Z5 (R224 a): the Zotero rows of the report table, each only when not zero (absent from an older report). */
function zoteroRows(r: ImportReport): Array<[string, number]> {
  const c = r.counts;
  const bin = c.goneInZoteroBin ?? 0;
  const rows: Array<[string, number]> = [
    ["Marked as no longer in Zotero", Math.max(0, (c.goneInZotero ?? 0) - bin)],
    ["In the Zotero bin", bin],
    ["Back in Zotero", c.backInZotero ?? 0],
    ["Still gone from Zotero (marked earlier)", c.goneAlready ?? 0],
    // Z6 (R236 e): the account sync's own rows.
    ["Changed in Zotero and here — waiting for you", c.conflicts ?? 0],
    ["Cleared in Zotero, kept here", c.clearedInZoteroKept ?? 0],
  ];
  return rows.filter(([, n]) => n > 0);
}

/** R224 f: the sources whose availability the undo left as it was, said once, with their number. */
function keptAvailability(kept: UndoResult["kept"]): string | undefined {
  const n = new Set(kept.filter((k) => k.kind === "availability").map((k) => k.sourceId ?? k.id)).size;
  if (!n) return undefined;
  return `${fmt(n)} ${n === 1 ? "source's" : "sources'"} availability was changed after this import, so it was left as it is.`;
}

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
              {zoteroRows(report).map(([label, n]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{fmt(n)}</td>
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

          {/* R393: the notes (where a stopped batch says why) right under the summary, so that they cannot be missed. */}
          {report.notes.length > 0 && (
            <ul className="ao-import__notes">
              {report.notes.map((n, i) => (
                <li key={`${i}:${n}`}>
                  <UserText>{n}</UserText>
                </li>
              ))}
            </ul>
          )}

          {(report.annotationsDeletedHere ?? 0) > 0 && (
            <p>
              {report.annotationsDeletedHere === 1
                ? "1 highlight you deleted here was not added again."
                : `${fmt(report.annotationsDeletedHere!)} highlights you deleted here were not added again.`}
            </p>
          )}

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
                {failureGroups(report.failures).map((g) => {
                  const label = `${g.reason} (${count(g.items.length, "item")})`;
                  const items = (
                    <ul>
                      {g.items.map((item, i) => (
                        <li key={`${i}:${item}`}>
                          <UserText>{item}</UserText>
                        </li>
                      ))}
                    </ul>
                  );
                  return (
                    <li key={g.reason}>
                      {g.items.length > GROUP_OPEN_MAX ? (
                        <details className="ao-import__details">
                          <summary>
                            <UserText>{label}</UserText>
                          </summary>
                          {items}
                        </details>
                      ) : (
                        <>
                          <UserText>{label}</UserText>
                          {items}
                        </>
                      )}
                    </li>
                  );
                })}
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
                    <UserText>{f.item}</UserText>: <UserText>{f.fields.join(", ")}</UserText>
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

          {undone ? (
            <div role="status">
              <p>
                {undoneText(undone)}
              </p>
              {undone.zoteroSync && <UserText as="p">{undone.zoteroSync.message}</UserText>}
              {undone.kept.length > 0 && (
                <ul>
                  {undone.kept
                    .filter((k) => k.kind !== "availability")
                    .map((k) => (
                      <li key={`${k.kind}-${k.sourceId ?? ""}-${k.id}`}>Kept: {k.reason}</li>
                    ))}
                  {keptAvailability(undone.kept) && <li>{keptAvailability(undone.kept)}</li>}
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
