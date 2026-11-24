/**
 * FR-736 (R503 d, R509, R519): what is said while the undo of an interrupted change is incomplete, declared once for the
 * library, the service and the screens. Each state has one sentence per place; a project's name and a file's
 * library-relative path are given by the caller (the screens put each through `UserText`). A path is shown ONLY in the
 * list of interrupted changes (R503 d): the researcher has to find the file there.
 */

/** Why a roll-back left a path as it found it (the library's `UndoCauseKind`, R519). */
export const ROLLBACK_CAUSE_KINDS = ["hand-changed-file", "path-occupied", "kept-copy-gone", "could-not-look"] as const;
export type RollbackCauseKind = (typeof ROLLBACK_CAUSE_KINDS)[number];

/**
 * The state of an incomplete roll-back, as the researcher must know it:
 * - `try-again`: a step failed or a file could not be read; trying again may succeed (nothing was lost);
 * - `in-the-way`: a file changed or put there outside the app stands where the undo must remove or put back a file:
 *   the researcher moves it away, then the roll-back completes (nothing was lost);
 * - `lost`: the copy the app kept of a file the change removed is gone: that file can never be put back, and the
 *   change can be closed as it is (R509).
 */
export type IncompleteRollback = "try-again" | "in-the-way" | "lost";

/** The state of an incomplete roll-back from its causes; `stepFailed`: a step failed for no cause the undo could name. */
export function incompleteRollbackOf(causes: ReadonlyArray<{ kind: string }>, stepFailed: boolean): IncompleteRollback {
  if (causes.some((c) => c.kind === "hand-changed-file" || c.kind === "path-occupied")) return "in-the-way";
  if (stepFailed || causes.length === 0 || causes.some((c) => c.kind !== "kept-copy-gone")) return "try-again";
  return "lost";
}

/** The banner of an interrupted change whose undo is incomplete, by state; `p` is the project's name. */
export const INCOMPLETE_ROLLBACK_BANNER: Record<IncompleteRollback, (p: string) => string> = {
  "try-again": (p) =>
    `An interrupted change in ${p} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to ${p} are off until it is undone. Choose “Resolve…” to try again.`,
  "in-the-way": (p) =>
    `An interrupted change in ${p} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to ${p} are off until it is undone. Choose “Resolve…” to see which file to move.`,
  lost: (p) =>
    `An interrupted change in ${p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to ${p} are off until you close the change. Choose “Resolve…” to see what was lost.`,
};

/** In the list of interrupted changes: what is in the way, by cause; `f` is the file's library-relative path. */
export const ROLLBACK_CAUSE_TEXT: Record<RollbackCauseKind, (f: string) => string> = {
  "hand-changed-file": (f) =>
    `${f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (your version is kept there), then choose “Roll it back”.`,
  "path-occupied": (f) =>
    `A file this change removed cannot be put back at ${f}, because another file is there now. Move that file somewhere outside the library, then choose “Roll it back” to put the removed file back.`,
  "kept-copy-gone": (f) => `The file this change removed from ${f} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
  "could-not-look": (f) => `The app could not read ${f}, so it left it as it is. Make sure the file can be read, then choose “Roll it back”.`,
};

/** "Roll it back" answered, when the undo is still incomplete, by state. */
export const ROLLBACK_INCOMPLETE_ANSWER: Record<IncompleteRollback, string> = {
  "try-again": "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library.",
  "in-the-way": "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again.",
  lost: "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back.",
};

/**
 * A change to a project refused while an earlier problem found at the library's opening holds it (an interrupted change
 * not undone completely, or an audit log that could not be repaired): the service's answer and Find and acquire's.
 */
export const RECOVERY_PENDING_TEXT =
  "This project takes no changes until a problem found when the library was opened is resolved. The warning at the top of the library says what to do.";
