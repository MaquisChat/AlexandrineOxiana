/**
 * Move library (spec 4.5): choose a destination → the per-project plan (each project's rules decide
 * whether it may go there, with the reason when not) → move the others only, or cancel → progress
 * (copy, then every file verified, then switch; streamed as NDJSON) → the verification result →
 * "Delete old copy", which stays disabled until the move was verified, and asks for a typed
 * confirmation. The service keeps the move's single-use token for 15 minutes: if the stream is cut
 * off (the client's cut-off error, or a stream that ends without an answer), the token is fetched
 * again from GET /libraries/move/status — only for the move this screen started (same destination,
 * R117 I8). Once the service has answered the move request (its headers arrived), any broken
 * stream is treated so, even before a first line: the move may be running there, so it is never
 * reported as "nothing was copied". A move request that failed without the service's answer (the
 * network, before its headers) is not "not started" either until move/status says so (R379): no
 * move running and none made under this screen's attempt id. A move started elsewhere (MOVE_IN_PROGRESS) is reported, never taken over. Closing the
 * screen stops reading the stream (the move itself carries on in the service).
 */
import { useEffect, useId, useRef, useState } from "react";
import { MOVE_NOT_FINISHED_REASON, MOVE_NOT_FINISHED_SPLIT_REASON, moveNotFinishedParts, moveNotFinishedSplitParts, moveStoppedBeforeSwitchOf, moveStoppedBeforeSwitchParts, type OldFolderNotWritable } from "@ao/shared";
import { ApiClientError } from "../api/client";
import { isStreamCutOff, normaliseRoot, type GovernanceApi, type MovePlan, type MoveProgress, type MoveStatus } from "../api/governance";
import { ConfirmDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import { PathField } from "../components/PathField";
import { desktopShell } from "../desktopShell";
import "./GovernanceScreens.css";

type Stage = "pick" | "plan" | "moving" | "verified" | "failed" | "deleted";

const PHASE: Record<MoveProgress["phase"], string> = { plan: "Planning", copy: "Copying", verify: "Verifying", switch: "Switching to the new place" };

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const isMoveInProgress = (err: unknown) =>
  err instanceof ApiClientError && (err.code === "MOVE_IN_PROGRESS" || (err.status === 409 && /already running/i.test(err.message)));

const sameRoot = (a: string, b: string) => normaliseRoot(a) === normaliseRoot(b);

/** Said while the service does not answer after a move request failed before its answer (R379): nothing about the files. */
const LOST = "The connection to the app's service was lost. The move may still be running. This screen will show what happened as soon as the service answers.";

export function MoveLibrary({ api, pollMs = 2000, maxPolls = 900 }: { api: GovernanceApi; pollMs?: number; maxPolls?: number }) {
  const ids = useId();
  const [dest, setDest] = useState("");
  const [stage, setStage] = useState<Stage>("pick");
  /** After the old copy is deleted its button is gone: focus goes to the Progress heading, under which the result is said (R467 I2). */
  const progressHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (stage === "deleted") progressHeading.current?.focus();
  }, [stage]);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [progress, setProgress] = useState<MoveProgress | null>(null);
  const [verified, setVerified] = useState<{ token: string; newRoot: string; message: string; warnings: string[] } | null>(null);
  const [error, setErrorText] = useState<string | null>(null);
  /**
   * FR-755 (R578): the move failed once it had closed the old copy; the library is closed and opening it at this new
   * place finishes the move. Its sentence names the place (the researcher's own text, through UserText).
   */
  const [notFinished, setNotFinished] = useState<{ newRoot: string; split: boolean } | null>(null);
  /**
   * FR-068 (R607 d): the move stopped before the library was switched; the copy made at this new place is not used. Its
   * sentence names the place (through UserText), in place of the generic words.
   */
  const [stoppedAt, setStoppedAt] = useState<{ newRoot: string; cause?: OldFolderNotWritable } | null>(null);
  /**
   * R610 (2), R612: the reason of a refusal (the service's POLICY_DENIED: why the library cannot be moved there, e.g. a
   * folder that is not empty, or one holding an earlier move), shown after the message in the same alert, as text.
   */
  const [refusalReason, setRefusalReason] = useState<string | null>(null);
  const setError = (e: string | null) => {
    setErrorText(e);
    setRefusalReason(null);
    setNotFinished(null);
    setStoppedAt(null);
  };
  /** A refusal of the move to that place: its message, and its reason after it. */
  const setRefusal = (e: { message: string; reason: string }) => {
    setError(e.message);
    setRefusalReason(e.reason);
  };
  const isRefusal = (e: { code?: string; reason?: string }): e is { code: string; message: string; reason: string } => e.code === "POLICY_DENIED" && typeof e.reason === "string" && e.reason !== "";
  /** A failed move's answer: the sentence of a move that did not finish, a refusal with its reason, or the error with today's ending. */
  const failedWith = (e: { code?: string; message: string; reason?: string }, newRoot: string) => {
    if (e.reason === MOVE_NOT_FINISHED_REASON || e.reason === MOVE_NOT_FINISHED_SPLIT_REASON) {
      setErrorText(null);
      setNotFinished({ newRoot, split: e.reason === MOVE_NOT_FINISHED_SPLIT_REASON });
    } else if (moveStoppedBeforeSwitchOf(e.reason)) {
      // R612 m-A: with the cause when the library's old folder could not be written to.
      setError(null);
      setStoppedAt({ newRoot, ...moveStoppedBeforeSwitchOf(e.reason) });
    } else if (isRefusal(e)) setRefusal(e);
    else setError(`${e.message} The move stopped; nothing was deleted, and the library stays where it was.`);
    setStage("failed");
  };
  const [waiting, setWaiting] = useState(false);
  /** From the failure of a move request until the first status answer (R399 d). */
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletedNote, setDeletedNote] = useState<string | null>(null);
  const alive = useRef(true);
  const stream = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stream.current?.abort();
    };
  }, []);

  /**
   * Asks the service what became of the move this screen started (to `target`, under `attempt`),
   * repeatedly, until it is known (the move runs to its end on the service): finished → its token
   * (another move's is never taken); stopped with an error → that error. `notStarted` is given when
   * the move request failed before the service answered (R379): then, and only then, no move running
   * and none made means it was not started; until the service answers at all, nothing is claimed
   * about the files. In that mode (R399): the first question waits one interval (the service marks
   * the move as asked for at the start of its request); "not started" needs TWO successive answers
   * that agree; and once any answer said a move is running it is never concluded (the service keeps
   * the move's state in memory only, so an empty answer after it may be a restart): the asking then
   * ends as the cut-off path ends.
   */
  const follow = async (target: string, attempt: string, note: string, notStarted?: string) => {
    if (notStarted === undefined) setWaiting(true);
    else {
      setChecking(true);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    let seenRunning = false;
    let empty = 0;
    for (let i = 0; i < maxPolls && alive.current; i++) {
      let st: MoveStatus | undefined;
      try {
        st = await api.moveStatus();
      } catch {
        // the service may be restarting with the new library: keep asking
        if (alive.current && notStarted !== undefined) setError(LOST);
      }
      if (!alive.current) return;
      if (st) {
        // The service answered: the lost-connection sentence goes; what this answer says is shown below.
        setChecking(false);
        setError(null);
        const { pending, failed } = st;
        if (pending && sameRoot(pending.newRoot, target)) {
          setError(null);
          setWaiting(false);
          setVerified({ token: pending.confirmToken, newRoot: pending.newRoot, message: note, warnings: pending.warnings ?? [] });
          setStage("verified");
          return;
        }
        if (failed && failed.attempt === attempt && sameRoot(failed.newRoot, target)) {
          setWaiting(false);
          failedWith(failed.error, target);
          return;
        }
        if (notStarted !== undefined) {
          if (st.running) {
            seenRunning = true;
            setError(null);
            setWaiting(true);
          } else if (!seenRunning && ++empty >= 2) {
            setWaiting(false);
            setError(`The move could not be started: ${notStarted} Nothing was copied or changed.`);
            setStage(plan ? "plan" : "pick");
            return;
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (alive.current) {
      setWaiting(false);
      setChecking(false);
      setError("No finished move was found. Open the library to check where it is before trying again.");
      setStage("failed");
    }
  };

  /** Another move (started elsewhere) is running: report it; its old copy is that window's to delete. */
  const inProgress = () => {
    setError("This library is already being moved from another window. Its result, and deleting its old copy, are offered there.");
    setStage("pick");
  };

  const check = async () => {
    setError(null);
    setPlan(null);
    try {
      setPlan(await api.movePlan(dest.trim()));
      setStage("plan");
    } catch (err) {
      if (isMoveInProgress(err)) return inProgress();
      if (err instanceof ApiClientError && isRefusal(err)) return setRefusal({ message: err.message, reason: err.reason });
      setError(err instanceof Error ? err.message : "The destination could not be checked.");
    }
  };

  const move = async (exclude: string[]) => {
    setError(null);
    setProgress(null);
    setChecking(false);
    setStage("moving");
    const target = dest.trim();
    const ac = new AbortController();
    stream.current = ac;
    const attempt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const cutOff = "The move finished and was verified (the connection to it was interrupted).";
    let started = false;
    /** The service answered: the move may be running there even if no line arrives. */
    let reached = false;
    try {
      for await (const line of api.move(target, exclude, ac.signal, () => (reached = true), attempt)) {
        started = true;
        if ("progress" in line) setProgress(line.progress);
        else if ("error" in line) {
          failedWith(line.error, target);
          return;
        } else if ("done" in line) {
          const r = line.result;
          setVerified({ token: r.confirmToken, newRoot: r.newRoot, message: `All ${r.fileCount.toLocaleString("en-US")} files were copied and verified.`, warnings: r.warnings ?? [] });
          setStage("verified");
          return;
        }
      }
      if (ac.signal.aborted || !alive.current) return; // the screen was closed
      // Ended without an answer: the move carries on in the service; ask it.
      await follow(target, attempt, cutOff);
    } catch (err) {
      if (!alive.current) return;
      if (isMoveInProgress(err)) return inProgress();
      if (reached || isStreamCutOff(err, started)) {
        await follow(target, attempt, cutOff);
        return;
      }
      const why = err instanceof Error ? err.message : "the library service did not answer";
      // No answer from the service (status 0: the network, a time-out): the move may be running
      // there, so the service is asked before anything is said (R379). A refusal is shown as it is.
      if (!(err instanceof ApiClientError) || err.status === 0) {
        await follow(target, attempt, cutOff, why);
        return;
      }
      setError(`The move could not be started: ${why} Nothing was copied or changed.`);
      setStage(plan ? "plan" : "pick");
    }
  };

  const deleteOld = async () => {
    if (!verified) return;
    setDeleting(true);
    try {
      const r = await api.deleteOldCopy(verified.token);
      setConfirming(false);
      setDeletedNote(["The old copy was deleted.", ...r.warnings].join(" "));
      setStage("deleted");
    } catch (err) {
      setConfirming(false);
      setError(err instanceof Error ? err.message : "The old copy could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  const denied = plan?.perProject.filter((p) => p.decision.result === "deny") ?? [];
  const allowed = plan?.perProject.filter((p) => p.decision.result !== "deny") ?? [];
  const cancel = () => {
    setPlan(null);
    setStage("pick");
  };

  return (
    <main className="ao-screen">
      <h1>Move library</h1>
      <p className="ao-hint">The library is copied, every file is checked at the new place, and the app switches to it. The old copy is deleted only when you confirm, after the check succeeded.</p>
      <form
        className="ao-field"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <PathField
          id={`${ids}-dest`}
          label="Destination folder"
          pick="folder"
          pickerTitle="Choose an empty folder for the library"
          value={dest}
          disabled={stage === "moving" || stage === "verified"}
          onChange={setDest}
          placeholder="/Volumes/Drive/Library"
          describedBy={`${ids}-dest-hint`}
        />
        <p id={`${ids}-dest-hint`} className="ao-hint">
          {/* The dialog exists only in the desktop app (FR-391). */}
          {desktopShell() ? "The folder must be new or empty. In the dialog you can make one with New Folder." : "The folder must be new or empty."}
        </p>
        <button type="submit" disabled={!dest.trim() || stage === "moving" || stage === "verified"}>
          Check destination
        </button>
      </form>

      {error ? (
        <p role="alert" className="ao-warning">
          {error}
          {refusalReason ? (
            <>
              {" "}
              <UserText>{refusalReason}</UserText>
            </>
          ) : null}
        </p>
      ) : null}
      {notFinished !== null
        ? (() => {
            const [before, place, after] = notFinished.split ? moveNotFinishedSplitParts(notFinished.newRoot) : moveNotFinishedParts(notFinished.newRoot);
            return (
              <p role="alert" className="ao-warning">
                {before}
                <UserText>{place}</UserText>
                {after}
              </p>
            );
          })()
        : null}
      {stoppedAt !== null
        ? (() => {
            const [before, place, after] = moveStoppedBeforeSwitchParts(stoppedAt.newRoot, stoppedAt.cause);
            return (
              <p role="alert" className="ao-warning">
                {before}
                <UserText>{place}</UserText>
                {after}
              </p>
            );
          })()
        : null}

      {plan && stage === "plan" ? (
        <section className="ao-card" aria-labelledby={`${ids}-plan`}>
          <h2 id={`${ids}-plan`}>Move plan</h2>
          <p>
            {plan.fileCount.toLocaleString("en-US")} files, {mb(plan.totalBytes)}, to a destination of kind “{plan.destination.kind}”.
          </p>
          <table className="ao-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">May it move there?</th>
              </tr>
            </thead>
            <tbody>
              {plan.perProject.map((p) => (
                <tr key={p.projectId}>
                  <td>
                    <UserText>{p.name}</UserText>
                  </td>
                  <td className={p.decision.result === "deny" ? "ao-deny" : undefined}>
                    {p.decision.result === "deny" ? <>Not allowed: <UserText>{p.decision.reason ?? ""}</UserText></> : "Allowed"}
                    {/* The project's own decision warnings, beside it (R379, I2). */}
                    {p.decision.warnings?.length ? (
                      <ul className="ao-warning">
                        {p.decision.warnings.map((w, i) => (
                          <li key={i}>
                            <UserText>{w}</UserText>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {denied.length ? <p>{denied.length === 1 ? "One project may not be moved there." : `${denied.length} projects may not be moved there.`} You can move the others only (the excluded projects stay where they are), or cancel and choose another destination.</p> : null}
          <div className="ao-actions">
            {denied.length === 0 ? (
              <button type="button" onClick={() => void move([])}>
                Move library
              </button>
            ) : allowed.length ? (
              <button type="button" onClick={() => void move(denied.map((p) => p.projectId))}>
                Move the other projects only
              </button>
            ) : null}
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {stage === "moving" || stage === "verified" || stage === "failed" || stage === "deleted" ? (
        <section className="ao-card" aria-labelledby={`${ids}-prog`}>
          <h2 id={`${ids}-prog`} ref={progressHeading} tabIndex={-1}>
            Progress
          </h2>
          {progress && stage === "moving" ? (
            <>
              <progress aria-label="Move progress" max={progress.fileCount || 1} value={progress.filesDone} />
              <p>
                {PHASE[progress.phase]}: {progress.filesDone.toLocaleString("en-US")} of {progress.fileCount.toLocaleString("en-US")} files
              </p>
            </>
          ) : null}
          {checking ? (
            <p role="status" className="ao-hint">
              Checking what became of the move…
            </p>
          ) : null}
          {waiting ? <p className="ao-hint">Waiting for the move to finish…</p> : null}
          {verified ? (
            <p role="status" aria-label="Verification" className="ao-ok">
              {verified.message} The library now opens from <UserText>{verified.newRoot}</UserText>.
            </p>
          ) : null}
          {/* The move's own warnings (an audit event not recorded among them), never dropped (R379, I2). */}
          {verified?.warnings.length ? (
            <div className="ao-warning">
              <p id={`${ids}-warn`}>The move finished, with these warnings:</p>
              <ul aria-labelledby={`${ids}-warn`}>
                {verified.warnings.map((w, i) => (
                  <li key={i}>
                    <UserText>{w}</UserText>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {deletedNote ? <p role="status">{deletedNote}</p> : null}
          {stage !== "deleted" ? (
            <div className="ao-actions">
              <button type="button" className="ao-danger" disabled={!verified || stage !== "verified"} onClick={() => setConfirming(true)}>
                Delete old copy
              </button>
              {!verified ? <span className="ao-hint">Available once every file was verified at the new place.</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {confirming ? (
        <ConfirmDialog title="Delete old copy" word="delete" action="Delete the old copy" busy={deleting} onConfirm={() => void deleteOld()} onCancel={() => setConfirming(false)}>
          <p>The library at its old place will be deleted. The verified copy at the new place stays. This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}
