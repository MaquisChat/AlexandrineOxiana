/**
 * The one-time display of a recovery code (R134), shared by the new-project dialog (Task 60) and the
 * new-recovery-code dialog (Task 61). It renders inside the caller's modal dialog: a heading (focused
 * when shown; its id is the dialog's label), what the code is for (the caller's words), the code
 * through UserText, a copy button, the "I have saved the recovery code" confirmation and Done, which
 * stays off until it is ticked.
 *
 * The code is never logged, put in the address or stored. While this step is on screen nothing in the
 * app takes it away: unloading asks first, in-app links and navigate() are refused, and Back and
 * Forward land on a copy of this same address (pushed now, without state) and are refused too, each
 * time with a plain message (LEAVE_REFUSED). All of that ends when Done is chosen or the step goes.
 * `onPendingChange(true)` is called when the guard starts and `(false)` when it ends, so the screen
 * behind can keep the dialog if the library is closed underneath.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { blockNavigation } from "../navigation";
import { UserText } from "./UserText";
import "./RecoveryCodeStep.css";

export const LEAVE_REFUSED = "Save the recovery code first. It is shown only here, and leaving now would lose it for good. Tick “I have saved the recovery code”, then choose Done.";

export interface RecoveryCodeStepProps {
  /** The heading's id: the dialog is labelled by it. */
  titleId: string;
  /** The code, as the service returned it (shown once). */
  code: string;
  /** A notice above the explanation, such as "the library was closed underneath". */
  notice?: ReactNode;
  /** What the code is for, in plain words. */
  children: ReactNode;
  /** Whether an unconfirmed code is on screen (true when the guard starts, false when it ends). */
  onPendingChange?: (pending: boolean) => void;
  /** The researcher confirmed the code is saved and chose Done (the guard has ended). */
  onDone: () => void;
}

export function RecoveryCodeStep({ titleId, code, notice, children, onPendingChange, onDone }: RecoveryCodeStepProps) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** An attempt to leave the recovery code was refused. */
  const [leaveRefused, setLeaveRefused] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;
  /** Ends the guards at once (Done: whatever the caller does next, such as leaving a closed library, may navigate). */
  const releaseGuard = useRef<(() => void) | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    pendingRef.current?.(true);
    const refuse = () => setLeaveRefused(true);
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // older engines ask only when this is set
    };
    window.addEventListener("beforeunload", onUnload);
    const unblock = blockNavigation(refuse);
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.pushState(null, "", here);
    let restoring = false;
    const onPop = () => {
      if (restoring) return;
      refuse();
      restoring = true;
      window.history.pushState(null, "", here);
      // Screens that already followed the address follow it back (in the same task, before React renders).
      window.dispatchEvent(new PopStateEvent("popstate"));
      restoring = false;
    };
    window.addEventListener("popstate", onPop);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("popstate", onPop);
      unblock();
      pendingRef.current?.(false);
    };
    releaseGuard.current = release;
    return release;
  }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(code);
      setCopied("Copied.");
    } catch {
      setCopied("Copying did not work here. Select the code and copy it, or write it down.");
    }
  };

  const done = () => {
    if (!saved) return;
    releaseGuard.current?.();
    onDone();
  };

  return (
    <>
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        Save the recovery code
      </h2>
      {leaveRefused && (
        <p role="alert" className="ao-error">
          {LEAVE_REFUSED}
        </p>
      )}
      {notice}
      {children}
      <UserText as="p" className="ao-recovery-code__code">
        {code}
      </UserText>
      <div className="ao-row">
        <button type="button" onClick={() => void copy()}>
          Copy recovery code
        </button>
        {copied && (
          <span role="status" className="ao-muted">
            {copied}
          </span>
        )}
      </div>
      <p className="ao-muted">Keep it somewhere safe and separate from this computer, such as a password manager or a printed copy in a locked drawer.</p>
      <label className="ao-recovery-code__choice">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have saved the recovery code
      </label>
      <div className="ao-row ao-recovery-code__actions">
        <button type="button" disabled={!saved} onClick={done}>
          Done
        </button>
      </div>
    </>
  );
}
