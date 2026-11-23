/**
 * "Resolve…" for an interrupted change (R27, R131): a modal dialog listing every change the library
 * could not settle when it opened, each with exactly the choices the service lists for it (`canKeep`,
 * `canRollBack`) — never more, never fewer. Each choice asks for a confirmation and is recorded in the
 * project's audit log by the service. A change whose record cannot be trusted (unverifiable or invalid)
 * gets no choices from the service: the dialog says the app cannot confirm whether it was finished and
 * that the way forward is restoring the project from a backup. Should a service still offer roll-back
 * for an unverifiable change, the confirmation warns that it may undo a finished change and needs an
 * explicit acknowledgement. A refused choice reloads the list. A read-only library lists them but
 * cannot resolve them. The page behind is inert; Tab stays inside; Escape or Close returns focus to
 * the button that opened the dialog.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ApiClientError } from "../api/client";
import { errorText, type LibraryApi, type PendingWrite, type PendingWriteChoice } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

export interface PendingWritesDialogProps {
  api: LibraryApi;
  readOnly: boolean;
  onClose: () => void;
  /** After a change was resolved (the library's state is refreshed by the service's event). */
  onResolved?: () => void;
  /** Changes whenever the library's state changes (a library.state event): the list is read again. */
  changed?: number;
}

/** What is known about the change, by its status, when the service offers a choice for it. */
const STATUS_TEXT: Record<PendingWrite["status"], string> = {
  invalid: "Its record could not be read safely, so the app cannot confirm whether this change was finished.",
  unverifiable:
    "The app cannot confirm whether this change was finished: the audit log has no record that it was, but the log itself could not be checked in full, so a finished change can look unfinished.",
  uncommitted: "It was not finished. Rolling it back removes what it half-wrote; your choice is recorded.",
  committed: "It was finished and recorded. Keeping it completes the tidying-up; your choice is recorded.",
};

/** For a change the service offers no choice for (R131). */
const NO_CHOICE_TEXT: Record<PendingWrite["status"], string> = {
  invalid: "Its record could not be read safely, so the app cannot confirm whether this change was finished. It will not change anything itself.",
  unverifiable:
    "The app cannot confirm whether this change was finished: the audit log has no record that it was, but the log itself could not be checked in full. So it will not change anything itself.",
  uncommitted: "The app cannot settle this change itself, so it will not change anything.",
  committed: "The app cannot settle this change itself, so it will not change anything.",
};

const CONFIRM: Record<PendingWriteChoice, { ask: string; yes: string }> = {
  "roll-back": { ask: "Roll this change back? What it half-wrote is removed; this cannot be redone.", yes: "Yes, roll it back" },
  keep: { ask: "Keep this change? It was finished; keeping it completes it.", yes: "Yes, keep it" },
};

/** The confirmation for a change whose outcome cannot be confirmed (41b2 I3). */
const UNSURE_CONFIRM: Record<PendingWriteChoice, string> = {
  "roll-back": "Roll this change back? It cannot be confirmed whether it was finished. If it was, rolling it back may undo a change that was finished and recorded. This cannot be redone.",
  keep: "Keep this change? It cannot be confirmed whether it was finished. If it was not, keeping it may keep a half-written change.",
};

const unsure = (pw: PendingWrite) => pw.status === "unverifiable" || pw.status === "invalid";
const allowed = (pw: PendingWrite, c: PendingWriteChoice) => (c === "keep" ? pw.canKeep : pw.canRollBack);

function Item({ pw, readOnly, onChoose }: { pw: PendingWrite; readOnly: boolean; onChoose: (choice: PendingWriteChoice) => Promise<void> }) {
  const [confirm, setConfirm] = useState<PendingWriteChoice | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLSpanElement>(null);
  const id = useId();
  const needsAck = unsure(pw);
  // First focus on the question (R376 c), never on the control that decides: a held or repeated Enter
  // on "Roll it back" / "Keep it" must not answer it. Tab goes on to the acknowledgement or "Yes".
  useEffect(() => {
    if (confirm) question.current?.focus();
  }, [confirm]);
  // A reloaded list may no longer allow the choice being confirmed: drop the confirmation.
  useEffect(() => {
    if (confirm && !allowed(pw, confirm)) setConfirm(null);
  }, [pw, confirm]);
  const open = (c: PendingWriteChoice) => {
    setAcknowledged(false);
    setConfirm(c);
  };
  const resolvable = pw.canKeep || pw.canRollBack;
  return (
    <li>
      <div role="group" aria-label={`Interrupted change in ${pw.project}`} className="ao-pending">
        <p className="ao-pending__title">
          Interrupted change in <UserText>{pw.project}</UserText>
        </p>
        <p>{resolvable ? STATUS_TEXT[pw.status] : NO_CHOICE_TEXT[pw.status]}</p>
        <p className="ao-muted">
          It recorded {pw.steps} {pw.steps === 1 ? "step" : "steps"}.
          {pw.detail && (
            <>
              {" "}
              Details: <UserText>{pw.detail}</UserText>
            </>
          )}
        </p>
        {!resolvable && <p>The way forward is to restore the project from a backup made before this change.</p>}
        {resolvable && !confirm && (
          <div className="ao-row">
            {pw.canRollBack && (
              <button type="button" disabled={readOnly || busy} onClick={() => open("roll-back")}>
                Roll it back
              </button>
            )}
            {pw.canKeep && (
              <button type="button" disabled={readOnly || busy} onClick={() => open("keep")}>
                Keep it
              </button>
            )}
          </div>
        )}
        {confirm && (
          <div className="ao-inline-form">
            <span ref={question} tabIndex={-1} className={needsAck ? "ao-error" : undefined}>{needsAck ? UNSURE_CONFIRM[confirm] : CONFIRM[confirm].ask}</span>
            {needsAck && (
              <label htmlFor={`${id}-ack`}>
                <input id={`${id}-ack`} type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} /> I understand
                that this may undo or keep a change the app cannot confirm
              </label>
            )}
            <button
              ref={yes}
              type="button"
              disabled={busy || readOnly || (needsAck && !acknowledged)}
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

/**
 * A refused choice in plain words; the service's machine text ("allowed: …") is not shown.
 * `relisted` false: the list could not be read again, so no choice is offered (FR-153).
 */
const NOT_RELISTED = "The interrupted changes could not be listed again, so no choice is offered now. Close this and open it again to see what can be done.";

function refusalText(err: unknown, relisted = true): string {
  const conflict = err instanceof ApiClientError && err.code === "CONFLICT";
  const what = conflict
    ? "That choice is no longer possible for this change: something changed in the meantime (it may have been resolved elsewhere)."
    : errorText(err, "The change could not be resolved.");
  if (!relisted) return `${what} ${NOT_RELISTED}`;
  return conflict ? `${what} The list now shows what can be done.` : what;
}

export function PendingWritesDialog({ api, readOnly, onClose, onResolved, changed }: PendingWritesDialogProps) {
  const [list, setList] = useState<PendingWrite[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const live = useRef(true);

  // Rendered in <body>; everything else is inert while the dialog is open.
  useEffect(() => {
    live.current = true;
    document.body.appendChild(host);
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    heading.current?.focus();
    return () => {
      live.current = false;
      for (const el of made) el.removeAttribute("inert");
      host.remove();
    };
  }, [host]);

  /** Whether a list has been read: a later read that fails then takes the old list's choices away (FR-153, R468). */
  const listed = useRef(false);
  const load = useCallback(
    () =>
      api.pendingWrites.list().then(
        (l) => {
          if (!live.current) return;
          listed.current = true;
          setList(l);
        },
        (err: unknown) => {
          if (!live.current) return;
          const why = errorText(err, "The interrupted changes could not be listed.");
          if (!listed.current) return setError(why);
          setList(null);
          setError(`${why} ${NOT_RELISTED}`);
        },
      ),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load, changed]);

  const choose = async (pw: PendingWrite, choice: PendingWriteChoice) => {
    setError(undefined);
    try {
      await api.pendingWrites.resolve(pw.txn, choice);
      onResolved?.();
      void load();
      // The item's buttons are gone: focus stays in the dialog.
      heading.current?.focus();
    } catch (err) {
      setError(refusalText(err));
      // What the service allows may have changed: offer only that (41b2 I2). If it cannot be read
      // again, the old list's choices are taken away rather than left on offer (FR-153).
      void api.pendingWrites.list().then(
        (l) => live.current && setList(l),
        () => {
          if (!live.current) return;
          setList(null);
          setError(refusalText(err, false));
        },
      );
      setTimeout(() => alert.current?.focus());
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
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex='-1']") ?? []);
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

  return createPortal(
    <div className="ao-pending-backdrop">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="ao-pending-title" className="ao-pending-dialog" onKeyDown={onKeyDown}>
        <h2 id="ao-pending-title" ref={heading} tabIndex={-1}>
          Interrupted changes
        </h2>
        <p>
          A change was interrupted (for example by a crash) and could not be settled when the library opened. Its project takes no changes until it is resolved. A change is never kept half-written.
        </p>
        {readOnly && <p className="ao-muted">This library is open read-only here, so these can be looked at but not resolved. Open it with write access to resolve them.</p>}
        {error && (
          <p ref={alert} role="alert" tabIndex={-1} className="ao-error">
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
    </div>,
    host,
  );
}
