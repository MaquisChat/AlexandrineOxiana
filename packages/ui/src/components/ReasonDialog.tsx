/**
 * Modal dialogs for the governance screens: "Record a reason" (loosening a rule needs a written
 * justification and the approver's name, spec 6.2) and a typed-confirmation dialog for actions that
 * cannot be undone. Keyboard: focus starts in the first field, Escape cancels, Tab stays inside.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

function useTrap(onCancel: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("textarea, input")?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>("textarea, input, button:not([disabled])")];
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
  return { ref, onKeyDown };
}

export function ReasonDialog({ message, onConfirm, onCancel }: { message: ReactNode; onConfirm: (reason: string, by: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [by, setBy] = useState("");
  const { ref, onKeyDown } = useTrap(onCancel);
  const ok = reason.trim() !== "" && by.trim() !== "";
  return (
    <div className="ao-dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="ao-dialog" onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`}>Record a reason</h2>
        <p id={`${id}-d`}>{message}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(reason.trim(), by.trim());
          }}
        >
          <label className="ao-stack">
            Reason
            <textarea required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="ao-stack">
            Approved by
            <input type="text" required value={by} onChange={(e) => setBy(e.target.value)} />
          </label>
          <div className="ao-actions">
            <button type="submit" disabled={!ok}>
              Record reason
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  children,
  word,
  action,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  children: ReactNode;
  /** What the person types to confirm. */
  word: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const { ref, onKeyDown } = useTrap(onCancel);
  const ok = typed.trim().toLowerCase() === word.toLowerCase() && !busy;
  return (
    <div className="ao-dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} className="ao-dialog" onKeyDown={onKeyDown}>
        <h2 id={`${id}-t`}>{title}</h2>
        <div>{children}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm();
          }}
        >
          <label className="ao-stack">
            Type {word} to confirm
            <input type="text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <div className="ao-actions">
            <button type="submit" className="ao-danger" disabled={!ok}>
              {action}
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
