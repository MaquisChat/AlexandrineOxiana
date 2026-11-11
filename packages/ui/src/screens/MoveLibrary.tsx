/**
 * Move library (spec 4.5): choose a destination → the per-project plan (each project's rules decide
 * whether it may go there, with the reason when not) → move the others only, or cancel → progress
 * (copy, then every file verified, then switch; streamed as NDJSON) → the verification result →
 * "Delete old copy", which stays disabled until the move was verified, and asks for a typed
 * confirmation. The service keeps the move's single-use token for 15 minutes: if the stream is cut
 * off (or another window started the move: MOVE_IN_PROGRESS), the token is fetched again from
 * GET /libraries/move/status.
 */
import { useEffect, useId, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import type { GovernanceApi, MovePlan, MoveProgress } from "../api/governance";
import { ConfirmDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "./GovernanceScreens.css";

type Stage = "pick" | "plan" | "moving" | "verified" | "failed" | "deleted";

const PHASE: Record<MoveProgress["phase"], string> = { plan: "Planning", copy: "Copying", verify: "Verifying", switch: "Switching to the new place" };

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const isMoveInProgress = (err: unknown) =>
  err instanceof ApiClientError && (err.code === "MOVE_IN_PROGRESS" || (err.status === 409 && /already running/i.test(err.message)));

export function MoveLibrary({ api, pollMs = 2000 }: { api: GovernanceApi; pollMs?: number }) {
  const ids = useId();
  const [dest, setDest] = useState("");
  const [stage, setStage] = useState<Stage>("pick");
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [progress, setProgress] = useState<MoveProgress | null>(null);
  const [verified, setVerified] = useState<{ token: string; newRoot: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletedNote, setDeletedNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Asks the service for the finished move's token, repeatedly until there is one (the move runs to its end on the service). */
  const pickUp = async (note: string) => {
    setWaiting(true);
    for (let i = 0; i < 900 && alive.current; i++) {
      try {
        const { pending } = await api.moveStatus();
        if (pending) {
          if (!alive.current) return;
          setWaiting(false);
          setVerified({ token: pending.confirmToken, newRoot: pending.newRoot, message: note });
          setStage("verified");
          return;
        }
      } catch {
        // the service may be restarting with the new library: keep asking
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (alive.current) {
      setWaiting(false);
      setError("No finished move was found. Open the library to check where it is before trying again.");
      setStage("failed");
    }
  };

  const inProgress = () => {
    setError("This library is already being moved. This page shows the result as soon as the move is done.");
    setStage("moving");
    void pickUp("The move finished and was verified.");
  };

  const check = async () => {
    setError(null);
    setPlan(null);
    try {
      setPlan(await api.movePlan(dest.trim()));
      setStage("plan");
    } catch (err) {
      if (isMoveInProgress(err)) return inProgress();
      setError(err instanceof Error ? err.message : "The destination could not be checked.");
    }
  };

  const move = async (exclude: string[]) => {
    setError(null);
    setProgress(null);
    setStage("moving");
    try {
      for await (const line of api.move(dest.trim(), exclude)) {
        if ("progress" in line) setProgress(line.progress);
        else if ("error" in line) {
          setError(`${line.error.message} The move stopped; nothing was deleted, and the library stays where it was.`);
          setStage("failed");
          return;
        } else if ("done" in line) {
          const r = line.result;
          setVerified({ token: r.confirmToken, newRoot: r.newRoot, message: `All ${r.fileCount.toLocaleString("en-US")} files were copied and verified.` });
          setStage("verified");
          return;
        }
      }
      // Cut off without an answer: the move carries on in the service; ask it.
      await pickUp("The move finished and was verified (the connection to it was interrupted).");
    } catch (err) {
      if (isMoveInProgress(err)) return inProgress();
      setError(err instanceof Error ? err.message : "The move could not be started.");
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
        <label htmlFor={`${ids}-dest`}>Destination folder</label>
        <input id={`${ids}-dest`} type="text" value={dest} disabled={stage === "moving" || stage === "verified"} onChange={(e) => setDest(e.target.value)} placeholder="/Volumes/Drive/Library" />
        <button type="submit" disabled={!dest.trim() || stage === "moving" || stage === "verified"}>
          Check destination
        </button>
      </form>

      {error ? (
        <p role="alert" className="ao-warning">
          {error}
        </p>
      ) : null}

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
                  <td className={p.decision.result === "deny" ? "ao-deny" : undefined}>{p.decision.result === "deny" ? `Not allowed: ${p.decision.reason ?? ""}` : "Allowed"}</td>
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
          <h2 id={`${ids}-prog`}>Progress</h2>
          {progress && stage === "moving" ? (
            <>
              <progress aria-label="Move progress" max={progress.fileCount || 1} value={progress.filesDone} />
              <p>
                {PHASE[progress.phase]}: {progress.filesDone.toLocaleString("en-US")} of {progress.fileCount.toLocaleString("en-US")} files
              </p>
            </>
          ) : null}
          {waiting ? <p className="ao-hint">Waiting for the move to finish…</p> : null}
          {verified ? (
            <p role="status" aria-label="Verification" className="ao-ok">
              {verified.message} The library now opens from <UserText>{verified.newRoot}</UserText>.
            </p>
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
