/**
 * "Resolve…" for an interrupted change (R27): a modal dialog listing every change the library could
 * not settle when it opened, each with the choices the service allows — keep it (only when it was
 * finished and recorded) or roll it back (only when it was not finished and its record can be read
 * safely). Each choice asks for a confirmation and is recorded in the project's audit log by the
 * service. A read-only library lists them but cannot resolve them. Escape or Close returns focus to
 * the button that opened the dialog; Tab stays inside it.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { errorText, type LibraryApi, type PendingWrite, type PendingWriteChoice } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

export interface PendingWritesDialogProps {
  api: LibraryApi;
  readOnly: boolean;
  onClose: () => void;
  /** After a change was resolved (the library's state is refreshed by the service's event). */
  onResolved?: () => void;
}

const STATUS_TEXT: Record<PendingWrite["status"], string> = {
  invalid: "Its record could not be read safely, so it cannot be undone or kept here. Nothing it names was changed. Check the library's verification report.",
  unverifiable:
    "It was not finished. The audit log could not confirm that on its own, so it was left for you to decide. Rolling it back removes what it half-wrote; your choice is recorded.",
  uncommitted: "It was not finished. Rolling it back removes what it half-wrote; your choice is recorded.",
  committed: "It was finished and recorded. Keeping it completes the tidying-up; your choice is recorded.",
};

const CONFIRM: Record<PendingWriteChoice, { ask: string; yes: string }> = {
  "roll-back": { ask: "Roll this change back? What it half-wrote is removed; this cannot be redone.", yes: "Yes, roll it back" },
  keep: { ask: "Keep this change? It was finished; keeping it completes it.", yes: "Yes, keep it" },
};

function Item({ pw, readOnly, onChoose }: { pw: PendingWrite; readOnly: boolean; onChoose: (choice: PendingWriteChoice) => Promise<void> }) {
  const [confirm, setConfirm] = useState<PendingWriteChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) yes.current?.focus();
  }, [confirm]);
  const resolvable = pw.canKeep || pw.canRollBack;
  return (
    <li>
      <div role="group" aria-label={`Interrupted change in ${pw.project}`} className="ao-pending">
        <p className="ao-pending__title">
          Interrupted change in <UserText>{pw.project}</UserText>
        </p>
        <p>{STATUS_TEXT[pw.status]}</p>
        {resolvable && !confirm && (
          <div className="ao-row">
            {pw.canRollBack && (
              <button type="button" disabled={readOnly || busy} onClick={() => setConfirm("roll-back")}>
                Roll it back
              </button>
            )}
            <button type="button" disabled={readOnly || busy || !pw.canKeep} onClick={() => setConfirm("keep")}>
              Keep it
            </button>
          </div>
        )}
        {confirm && (
          <div className="ao-inline-form">
            <span>{CONFIRM[confirm].ask}</span>
            <button
              ref={yes}
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onChoose(confirm).finally(() => {
                  setBusy(false);
                  setConfirm(null);
                });
              }}
            >
              {CONFIRM[confirm].yes}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function PendingWritesDialog({ api, readOnly, onClose, onResolved }: PendingWritesDialogProps) {
  const [list, setList] = useState<PendingWrite[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    api.pendingWrites.list().then(setList, (err: unknown) => setError(errorText(err, "The interrupted changes could not be listed.")));
  }, [api]);
  useEffect(() => {
    load();
    heading.current?.focus();
  }, [load]);

  const choose = async (pw: PendingWrite, choice: PendingWriteChoice) => {
    setError(undefined);
    try {
      await api.pendingWrites.resolve(pw.txn, choice);
      onResolved?.();
      load();
      // The item's buttons are gone: focus stays in the dialog.
      heading.current?.focus();
    } catch (err) {
      setError(errorText(err, "The change could not be resolved."));
    }
  };

  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='-1']") ?? []);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="ao-backdrop">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="ao-pending-title" className="ao-dialog" onKeyDown={onKeyDown}>
        <h2 id="ao-pending-title" ref={heading} tabIndex={-1}>
          Interrupted changes
        </h2>
        <p>
          A change was interrupted (for example by a crash) and could not be settled when the library opened. Its project takes no changes until it is resolved. A change is never kept half-written.
        </p>
        {readOnly && <p className="ao-muted">This library is open read-only here, so these can be looked at but not resolved. Open it with write access to resolve them.</p>}
        {error && (
          <p role="alert" className="ao-error">
            {error}
          </p>
        )}
        {list === null && !error && <p aria-live="polite">Looking for interrupted changes…</p>}
        {list && list.length === 0 && <p>Nothing is waiting: every interrupted change is resolved.</p>}
        {list && list.length > 0 && (
          <ul className="ao-plain-list">
            {list.map((pw) => (
              <Item key={pw.txn} pw={pw} readOnly={readOnly} onChoose={(c) => choose(pw, c)} />
            ))}
          </ul>
        )}
        <div className="ao-row">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
