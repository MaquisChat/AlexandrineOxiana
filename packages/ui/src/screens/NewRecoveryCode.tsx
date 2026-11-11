/**
 * "New recovery code…" (Task 61, R134 c): a modal dialog on the library screen for an unlocked
 * encrypted project. It says what will happen (the current recovery code stops working, the
 * passphrase keeps working, backups made before now still need the old code or the passphrase), asks
 * for the passphrase, and sends it once to POST /projects/:id/recovery-code; the passphrase is not
 * kept. The new code is then shown exactly as at creation, by RecoveryCodeStep: once, through
 * UserText, with a copy button, the "I have saved the recovery code" confirmation, and leave guards
 * until it is confirmed (a library closed underneath waits for it too).
 *
 * An answer lost after sending (the service unreachable, a 5xx, an unreadable answer) is the same
 * hazard as at creation: the service may have issued a code that could not be shown. The dialog says
 * so plainly, and that the old code then no longer works, and asks the researcher to ask again:
 * issuing another is safe, and only the newest code works. It never resends by itself.
 *
 * A library closed while the request is in flight waits for its answer as it waits for a code on
 * screen: a code that comes back is shown (with a notice), and the library is left afterwards.
 *
 * Keyboard: focus starts in the passphrase; Tab stays inside; Enter sends; Escape cancels (not while
 * sending, and not at the code). The page behind is inert. Focus returns to `returnFocusTo` (the
 * button that opened the dialog) when it closes.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ApiClientError } from "../api/client";
import { errorText, type LibraryApi, type ProjectSummary } from "../api/library";
import { RecoveryCodeStep } from "../components/RecoveryCodeStep";
import { UserText } from "../components/UserText";
import "../components/library.css";
import "./NewProject.css";

/** The service's limit on a passphrase (routes/projects.ts, UTF-16 units like maxLength). */
const PASSPHRASE_MAX = 1024;

const FOCUSABLE = "input:not(:disabled), button:not(:disabled), [tabindex='-1']";

/** Only a 4xx refusal says for certain that no code was issued. */
const outcomeUnknown = (err: unknown) => !(err instanceof ApiClientError) || err.status < 400 || err.status >= 500;

export const LOST_ANSWER =
  "The library service's answer was lost, so the new recovery code could not be shown. A new code may already have been issued: if it was, the old recovery code no longer works, and the code that replaced it was never shown. Ask again for a new recovery code. Issuing another is safe, and only the newest code works; the passphrase keeps working throughout.";

export interface NewRecoveryCodeProps {
  api: Pick<LibraryApi, "projects">;
  project: ProjectSummary;
  /** The dialog is finished: cancelled, or the new code was confirmed saved. */
  onClose: () => void;
  /** The service says the project is locked. */
  onLocked?: () => void;
  /** Where focus goes when the dialog closes (the button that opened it), worked out at closing time. */
  returnFocusTo?: () => HTMLElement | null | undefined;
  /** Whether a recovery code is on screen and not yet confirmed (R134): see RecoveryCodeStep. */
  onRecoveryPending?: (pending: boolean) => void;
  /** The library was closed while the recovery code was on screen. */
  libraryClosed?: boolean;
}

export function NewRecoveryCode({ api, project, onClose, onLocked, returnFocusTo, onRecoveryPending, libraryClosed }: NewRecoveryCodeProps) {
  const id = useId();
  const [pass, setPass] = useState("");
  const [error, setError] = useState<{ text: string; field: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The new code, until confirmed. */
  const [code, setCode] = useState<string | null>(null);
  const inFlight = useRef(false);

  const box = useRef<HTMLDivElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const returnTo = useRef(returnFocusTo);
  returnTo.current = returnFocusTo;

  // Rendered on <body>; everything else is inert while it is open. On close the page is made usable
  // again first, then focus goes back to the opener.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(host);
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    passRef.current?.focus();
    return () => {
      for (const el of made) el.removeAttribute("inert");
      host.remove();
      (returnTo.current?.() ?? before)?.focus?.();
    };
  }, [host]);

  const show = (text: string, field: boolean) => {
    setError({ text, field });
    setTimeout(() => (field ? passRef : alertRef).current?.focus());
  };

  const send = async () => {
    if (inFlight.current) return;
    if (!pass) return show("Enter the project's passphrase.", true);
    if (pass.length > PASSPHRASE_MAX) return show(`The passphrase is too long: it has at most ${PASSPHRASE_MAX} characters.`, true);
    inFlight.current = true;
    const secret = pass;
    // The passphrase is sent once and not kept (as when unlocking).
    setPass("");
    setError(null);
    setBusy(true);
    // A code may come back: a library closed meanwhile must wait for it (R134), as once it is on screen.
    onRecoveryPending?.(true);
    let issued = false;
    try {
      const r = await api.projects.newRecoveryCode(project.id, { passphrase: secret });
      issued = true;
      setCode(r.recoveryCode);
    } catch (err) {
      if (outcomeUnknown(err)) show(LOST_ANSWER, false);
      else if (err instanceof ApiClientError && err.code === "WRONG_PASSPHRASE") {
        show("That passphrase is not correct, so no new recovery code was issued. The current recovery code still works.", true);
      } else {
        if (err instanceof ApiClientError && err.code === "PROJECT_LOCKED") onLocked?.();
        show(errorText(err, "No new recovery code was issued. Nothing was changed."), false);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      // With a code, RecoveryCodeStep keeps the hold until it is confirmed.
      if (!issued) onRecoveryPending?.(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  const cancel = () => {
    if (busy || code) return;
    onClose();
  };

  const finish = () => {
    setCode(null); // the code is not kept once confirmed
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Never at the recovery code: it is shown once and must be saved first.
      cancel();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!active || !items.includes(active)) {
      // From a heading or a message (focusable by script only): the next control in that direction.
      e.preventDefault();
      const follows = (el: HTMLElement) => !!active && !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      (e.shiftKey ? items.filter((el) => !follows(el)).at(-1) ?? last : items.find(follows) ?? first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const titleId = `${id}-t`;
  const errId = `${id}-err`;
  const backups = "Backups made before now still open with the old recovery code or the passphrase, not with the new code; they are not changed.";

  return createPortal(
    <div className="ao-newproject-backdrop">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} className="ao-newproject" onKeyDown={onKeyDown}>
        {code ? (
          <RecoveryCodeStep
            titleId={titleId}
            code={code}
            onPendingChange={onRecoveryPending}
            onDone={finish}
            notice={
              libraryClosed && (
                <p role="status" className="ao-newproject__warning">
                  The library was closed while this was open. The new recovery code was issued; once you have saved it, you return to choosing a library.
                </p>
              )
            }
          >
            <p>
              This is the new recovery code for <UserText>{project.name}</UserText>. The old recovery code no longer works. This is the only time this code is shown: the app does not keep a copy.
            </p>
            <p className="ao-newproject__warning">{backups}</p>
          </RecoveryCodeStep>
        ) : (
          <>
            <h2 id={titleId}>New recovery code</h2>
            <form onSubmit={submit} noValidate>
              <p>
                A new recovery code for <UserText>{project.name}</UserText> replaces the current one. The current recovery code stops working for this project; the passphrase keeps working.
              </p>
              <p className="ao-newproject__warning">{backups} Keep the old code if you keep those backups.</p>
              <p className="ao-muted">The new code is shown once, and you confirm that you have saved it.</p>
              <div className="ao-newproject__field">
                <label htmlFor={`${id}-pass`}>Passphrase</label>
                <input
                  id={`${id}-pass`}
                  ref={passRef}
                  type="password"
                  autoComplete="current-password"
                  maxLength={PASSPHRASE_MAX}
                  readOnly={busy}
                  value={pass}
                  onChange={(e) => {
                    setError((er) => (er?.field ? null : er));
                    setPass(e.target.value);
                  }}
                  {...(error?.field ? { "aria-invalid": true as const, "aria-describedby": errId } : {})}
                />
              </div>
              {error && (
                <p id={errId} ref={alertRef} role="alert" tabIndex={-1} className="ao-error">
                  {error.text}
                </p>
              )}
              {busy && (
                <p role="status" className="ao-muted">
                  Issuing a new recovery code… This cannot be cancelled once sent.
                </p>
              )}
              <div className="ao-row ao-newproject__actions">
                <button type="submit" disabled={busy}>
                  Issue new recovery code
                </button>
                <button type="button" disabled={busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    host,
  );
}
