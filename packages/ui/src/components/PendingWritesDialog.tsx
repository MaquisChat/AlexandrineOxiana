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
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KEPT_COPY_GONE_UNCONFIRMED_TEXT, ROLLBACK_CAUSE_KINDS, ROLLBACK_CAUSE_TEXT, type RollbackCauseKind } from "@ao/shared";
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

/**
 * FR-736 (R503 d): what keeps the undo from completing, cause by cause, with the file's library-relative path — shown
 * here only, through `UserText`, because the researcher has to find the file.
 */
function causeSentence(kind: string, path: string, somethingThere = false): ReactNode {
  if (!(ROLLBACK_CAUSE_KINDS as readonly string[]).includes(kind)) return null;
  const mark = "\u0000";
  // R527: the copy is gone but something stands at the place: the app cannot confirm it is the file, never "lost".
  return (kind === "kept-copy-gone" && somethingThere ? KEPT_COPY_GONE_UNCONFIRMED_TEXT : ROLLBACK_CAUSE_TEXT[kind as RollbackCauseKind])(mark)
    .split(mark)
    .flatMap((part, i) => (i === 0 ? [part] : [<UserText key={i}>{path}</UserText>, part]));
}

/** R509: the act beside "Roll it back" for a change whose undo can never complete, and its confirmation. */
const CLOSE_BUTTON = "Close this change as it is";
const CLOSE_HINT = "You can close this change as it is.";
const NOW_THERE: Record<NonNullable<PendingWrite["lost"]>[number]["now"], string> = {
  nothing: "Nothing is at that place now.",
  "a file": "A file is at that place now; it stays as it is.",
  "something else": "Something else is at that place now; it stays as it is.",
};
const CLOSE_ENDS = "Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it.";
const CLOSED = "The change was closed as it is. Nothing was deleted, and the project takes changes again.";

/** The close confirmation's question: what cannot be put back (path and source as text), what is there now, and that nothing is deleted. */
function closeQuestion(pw: PendingWrite): ReactNode {
  return (
    <>
      Close this change as it is?
      {(pw.lost ?? []).map((l) => (
        <span key={l.path}>
          {" "}
          What it removed from <UserText>{l.path}</UserText> cannot be put back.
          {l.source !== undefined && (
            <>
              {" "}
              It belonged to the source <UserText>{l.source}</UserText>.
            </>
          )}{" "}
          {NOW_THERE[l.now] ?? ""}
        </span>
      ))}{" "}
      {CLOSE_ENDS}
    </>
  );
}

const unsure = (pw: PendingWrite) => pw.status === "unverifiable" || pw.status === "invalid";
const allowed = (pw: PendingWrite, c: PendingWriteChoice) => (c === "keep" ? pw.canKeep : pw.canRollBack);

function Item({ pw, readOnly, onChoose, onCloseAsIs }: { pw: PendingWrite; readOnly: boolean; onChoose: (choice: PendingWriteChoice) => Promise<void>; onCloseAsIs: () => Promise<void> }) {
  const [confirm, setConfirm] = useState<PendingWriteChoice | null>(null);
  /** R509: the close confirmation is open; `busy` while its request runs. */
  const [closing, setClosing] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeQuestionRef = useRef<HTMLSpanElement>(null);
  /** Set when the close confirmation is taken back (Escape, Cancel): the focus goes back to the button that opened it. */
  const backToClose = useRef(false);
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
  // R509: the close question takes the focus when it opens (never "Yes"); taken back, the button that opened it has it.
  useEffect(() => {
    if (closing) closeQuestionRef.current?.focus();
    else if (backToClose.current) {
      backToClose.current = false;
      closeButton.current?.focus();
    }
  }, [closing]);
  // A reloaded list that no longer offers the close drops its question.
  useEffect(() => {
    if (closing && !pw.canClose) setClosing(false);
  }, [pw, closing]);
  const cancelClose = () => {
    backToClose.current = true;
    setClosing(false);
  };
  // A reloaded list may no longer allow the choice being confirmed: drop the confirmation.
  useEffect(() => {
    if (confirm && !allowed(pw, confirm)) setConfirm(null);
  }, [pw, confirm]);
  const open = (c: PendingWriteChoice) => {
    setAcknowledged(false);
    setConfirm(c);
  };
  const resolvable = pw.canKeep || pw.canRollBack || pw.canClose === true;
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
        {(pw.causes ?? []).map((c) => {
          const said = causeSentence(c.kind, c.path, c.somethingThere === true);
          return said ? <p key={`${c.kind}:${c.path}`}>{said}</p> : null;
        })}
        {pw.canClose === true && <p>{CLOSE_HINT}</p>}
        {!resolvable && <p>The way forward is to restore the project from a backup made before this change.</p>}
        {resolvable && !confirm && !closing && (
          <div className="ao-row">
            {pw.canRollBack && (
              <button type="button" disabled={readOnly || busy} onClick={() => open("roll-back")}>
                Roll it back
              </button>
            )}
            {pw.canClose === true && (
              <button ref={closeButton} type="button" disabled={readOnly || busy} onClick={() => setClosing(true)}>
                {CLOSE_BUTTON}
              </button>
            )}
            {pw.canKeep && (
              <button type="button" disabled={readOnly || busy} onClick={() => open("keep")}>
                Keep it
              </button>
            )}
          </div>
        )}
        {closing && (
          <div
            className="ao-inline-form"
            onKeyDown={(e) => {
              // Escape takes back this question only, not the whole list (R509).
              if (e.key === "Escape" && !busy) {
                e.stopPropagation();
                cancelClose();
              }
            }}
          >
            <span ref={closeQuestionRef} tabIndex={-1}>
              {closeQuestion(pw)}
            </span>
            <button
              type="button"
              disabled={busy || readOnly}
              onClick={() => {
                setBusy(true);
                void onCloseAsIs().finally(() => {
                  setBusy(false);
                  setClosing(false);
                });
              }}
            >
              Yes, close it as it is
            </button>
            <button type="button" disabled={busy} onClick={cancelClose}>
              Cancel
            </button>
            {busy && <span aria-live="polite">Closing the change…</span>}
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
  // FR-736: an undo still incomplete is said in the library's sentence of its state (the list shows what is in the way).
  if (err instanceof ApiClientError && err.code === "CONFLICT" && err.reason === "rollback-incomplete") {
    return relisted ? err.message : `${err.message} ${NOT_RELISTED}`;
  }
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
  /** R509: said once a change was closed as it is. */
  const [done, setDone] = useState<string | undefined>();
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
    setDone(undefined);
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

  /** R509: closes the change as it is; refused, the reason as an alert and the list read again. */
  const closeAsIs = async (pw: PendingWrite) => {
    setError(undefined);
    setDone(undefined);
    try {
      await api.pendingWrites.close(pw.txn, pw.projectId);
      if (!live.current) return;
      setDone(CLOSED);
      onResolved?.();
      void load();
      heading.current?.focus();
    } catch (err) {
      if (!live.current) return;
      setError(refusalText(err));
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
    // The controls Tab stops at. From the heading or the message (focusable by script only), Shift+Tab
    // wraps to the last control: nothing before them in the dialog takes the focus (R145).
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? []);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !active || !items.includes(active))) {
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
          A change was interrupted (for example by a crash) and could not be settled when the library opened. Its project takes no changes until it is resolved. A change is never kept
          half-written, unless it can never be undone completely and you close it as it is.
        </p>
        {readOnly && <p className="ao-muted">This library is open read-only here, so these can be looked at but not resolved. Open it with write access to resolve them.</p>}
        {error && (
          <p ref={alert} role="alert" tabIndex={-1} className="ao-error">
            {error}
          </p>
        )}
        {done && <p role="status">{done}</p>}
        {list === null && !error && <p aria-live="polite">Looking for interrupted changes…</p>}
        {list && list.length === 0 && <p>Nothing is waiting: every interrupted change is resolved.</p>}
        {list && list.length > 0 && (
          <ul className="ao-plain-list">
            {list.map((pw) => (
              <Item key={pw.txn} pw={pw} readOnly={readOnly} onChoose={(c) => choose(pw, c)} onCloseAsIs={() => closeAsIs(pw)} />
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
