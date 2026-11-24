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
 * - `lost`: the copy the app kept of a file the change removed is gone and nothing is at its place: that file can never
 *   be put back, and the change can be closed as it is (R509);
 * - `unconfirmed` (R527): the copy is gone, and at every such place something stands (`somethingThere` on each cause)
 *   that the app cannot confirm is the file the change removed (an older build half undid the change, the library was
 *   copied, a file system keeps no time of birth): never said to be lost; closable as `lost` is.
 */
export type IncompleteRollback = "try-again" | "in-the-way" | "lost" | "unconfirmed";

/** The state of an incomplete roll-back from its causes; `stepFailed`: a step failed for no cause the undo could name. */
export function incompleteRollbackOf(causes: ReadonlyArray<{ kind: string; somethingThere?: boolean }>, stepFailed: boolean): IncompleteRollback {
  if (causes.some((c) => c.kind === "hand-changed-file" || c.kind === "path-occupied")) return "in-the-way";
  if (stepFailed || causes.length === 0 || causes.some((c) => c.kind !== "kept-copy-gone")) return "try-again";
  // Lost where nothing is at one place at least (a file of the change is lost there); else nothing is confirmed lost.
  return causes.some((c) => c.somethingThere !== true) ? "lost" : "unconfirmed";
}

/** The banner of an interrupted change whose undo is incomplete, by state; `p` is the project's name. */
export const INCOMPLETE_ROLLBACK_BANNER: Record<IncompleteRollback, (p: string) => string> = {
  "try-again": (p) =>
    `An interrupted change in ${p} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to ${p} are off until it is undone. Choose “Resolve…” to try again.`,
  "in-the-way": (p) =>
    `An interrupted change in ${p} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to ${p} are off until it is undone. Choose “Resolve…” to see which file to move.`,
  lost: (p) =>
    `An interrupted change in ${p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to ${p} are off until you close the change. Choose “Resolve…” to see what was lost.`,
  unconfirmed: (p) =>
    `An interrupted change in ${p} cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to ${p} are off until you close the change. Choose “Resolve…” to see what is there.`,
};

/** In the list of interrupted changes: what is in the way, by cause; `f` is the file's library-relative path. */
export const ROLLBACK_CAUSE_TEXT: Record<RollbackCauseKind, (f: string) => string> = {
  "hand-changed-file": (f) =>
    `${f} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”.`,
  "path-occupied": (f) =>
    `A file this change removed cannot be put back at ${f}, because another file is there now. Move that file somewhere outside the library, then choose “Roll it back” to put the removed file back.`,
  "kept-copy-gone": (f) => `The file this change removed from ${f} cannot be put back: the copy the app kept of it is gone, so it is lost.`,
  "could-not-look": (f) => `The app could not read ${f}, so it left it as it is. Make sure the file can be read, then choose “Roll it back”.`,
};

/**
 * R527: in the list, a `kept-copy-gone` cause where something stands at the place (`somethingThere`): the app cannot
 * confirm that it is the file the change removed, so it never says that file is lost.
 */
export const KEPT_COPY_GONE_UNCONFIRMED_TEXT = (f: string): string =>
  `The file this change removed from ${f} cannot be put back: the copy the app kept of it is gone. Something is at that place now, which may be that file, but the app cannot confirm it, so it left it as it is.`;

const LOST_ANSWER = "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back.";

/** "Roll it back" answered, when the undo is still incomplete, by state. */
export const ROLLBACK_INCOMPLETE_ANSWER: Record<IncompleteRollback, string> = {
  "try-again": "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library.",
  "in-the-way": "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again.",
  lost: LOST_ANSWER,
  // R527: true whether or not something stands at the place (it says nothing of what is there).
  unconfirmed: LOST_ANSWER,
};

/**
 * A change to a project refused while an earlier problem found at the library's opening holds it (an interrupted change
 * not undone completely, or an audit log that could not be repaired): the service's answer and Find and acquire's.
 */
export const RECOVERY_PENDING_TEXT =
  "This project takes no changes until a problem found when the library was opened is resolved. The warning at the top of the library says what to do.";
