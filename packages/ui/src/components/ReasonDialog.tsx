/**
 * Modal dialogs for the governance screens: "Record a reason" (loosening a rule needs a written
 * justification and the approver's name, spec 6.2), a typed-confirmation dialog for actions that
 * cannot be undone, and a plain confirmation. Keyboard: focus starts in the first field, Escape
 * cancels (not while the action runs), Tab stays inside and skips disabled controls. The dialog is
 * rendered on <body> and everything else is made inert while it is open (R117).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "textarea:not([disabled]), input:not([disabled]), select:not([disabled]), button:not([disabled])";

/**
 * `initialFocus` (R371 a): an element of the dialog to focus on open instead of its first field —
 * its heading (tabIndex -1) for a dialog whose first control would decide on Enter. Shift+Tab from
 * that element goes to the dialog's last control; Tab goes on to the first in the page's order.
 */
export function useTrap(onCancel: () => void, busy = false, initialFocus?: RefObject<HTMLElement | null>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (initialFocus?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && initialFocus?.current && document.activeElement === initialFocus.current) {
      e.preventDefault();
      last.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return { ref, onKeyDown };
}

/** Renders on <body>; every other child of <body> is inert while the dialog is open. */
export function DialogShell({ labelledBy, describedBy, onCancel, busy, className, initialFocus, children }: { labelledBy: string; describedBy?: string; onCancel: () => void; busy?: boolean; className?: string; initialFocus?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const { ref, onKeyDown } = useTrap(onCancel, busy, initialFocus);
  const [host] = useState(() => document.createElement("div"));
  // A layout effect: the host must be in the document before useTrap's effect moves focus into the dialog.
  useLayoutEffect(() => {
    document.body.appendChild(host);
    const others = [...document.body.children].filter((el) => el !== host && !el.hasAttribute("inert"));
    for (const el of others) el.setAttribute("inert", "");
    return () => {
      for (const el of others) el.removeAttribute("inert");
      host.remove();
    };
  }, [host]);
  return createPortal(
    <div className="ao-dialog-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy || undefined} className={className ? `ao-dialog ${className}` : "ao-dialog"} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>,
    host,
  );
}

export function ReasonDialog({ message, fieldNote, onConfirm, onCancel }: { message: ReactNode; /** Said under the message and tied to both fields (R369 a). */ fieldNote?: string; onConfirm: (reason: string, by: string) => void; onCancel: () => void }) {
  const id = useId();
  const noteId = fieldNote ? `${id}-n` : undefined;
  const [reason, setReason] = useState("");
  const [by, setBy] = useState("");
  const ok = reason.trim() !== "" && by.trim() !== "";
  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={onCancel}>
      <h2 id={`${id}-t`}>Record a reason</h2>
      <p id={`${id}-d`}>{message}</p>
      {fieldNote ? (
        <p id={noteId} className="ao-hint">
          {fieldNote}
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm(reason.trim(), by.trim());
        }}
      >
        <label className="ao-stack">
          Reason
          <textarea required rows={3} aria-describedby={noteId} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="ao-stack">
          Approved by
          <input type="text" required aria-describedby={noteId} value={by} onChange={(e) => setBy(e.target.value)} />
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
    </DialogShell>
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
  const ok = typed.trim().toLowerCase() === word.toLowerCase() && !busy;
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onCancel} busy={!!busy}>
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
          <input type="text" autoComplete="off" value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="ao-actions">
          <button type="submit" className="ao-danger" disabled={!ok}>
            {action}
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** A yes/no confirmation (deleting a record that can be deleted). */
export function ChoiceDialog({ title, children, action, onConfirm, onCancel, busy }: { title: string; children: ReactNode; action: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  const id = useId();
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onCancel} busy={!!busy}>
      <h2 id={`${id}-t`}>{title}</h2>
      <div>{children}</div>
      <div className="ao-actions">
        <button type="button" className="ao-danger" onClick={onConfirm} disabled={busy}>
          {action}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}

/** A dialog body with an optional reason, for withdrawals and similar (uses the same shell). */
export function ReasonOptionalDialog({ title, children, label, action, onConfirm, onCancel }: { title: string; children: ReactNode; label: string; action: string; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onCancel}>
      <h2 id={`${id}-t`}>{title}</h2>
      <div>{children}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
        }}
      >
        <label className="ao-stack">
          {label}
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="ao-actions">
          <button type="submit" className="ao-danger">
            {action}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
