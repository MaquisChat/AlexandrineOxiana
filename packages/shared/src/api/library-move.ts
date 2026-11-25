/**
 * FR-755 (R573, R577 (2), R578): what the service and the move dialog say when a move fails after it has closed the old
 * copy. The library is then closed in the service, and opening it at its new place finishes the move (the service does
 * that at the opening). The service's own answer carries no path (it is recorded as the last failed move); the dialog,
 * which knows the folder it asked for, names it (shown through UserText).
 */

/** The error answer's `reason` for this case. */
export const MOVE_NOT_FINISHED_REASON = "move-not-finished";
/** R583 I1: the same for a move that leaves some projects behind (a split). */
export const MOVE_NOT_FINISHED_SPLIT_REASON = "move-not-finished-split";

/** The sentence, in three parts: before the new place, the new place (the researcher's own text), after it. */
export function moveNotFinishedParts(newRoot?: string): [string, string, string] {
  return newRoot
    ? ["The move did not finish, so the library has been closed. Open it at its new place, ", newRoot, ", and the move will be finished then; nothing is lost."]
    : ["The move did not finish, so the library has been closed. Open it at its new place, and the move will be finished then; nothing is lost.", "", ""];
}

/** The sentence whole: with the new place when it is given (never in anything recorded), without it otherwise. */
export function moveNotFinishedText(newRoot?: string): string {
  return moveNotFinishedParts(newRoot).join("");
}

/**
 * R583 I1, R590 N1: the sentence for a split, in three parts. The new library is to be opened FIRST: until the move is
 * finished there, the library the projects came from opens read-only (this computer's record of the unfinished split);
 * once it is finished, that library opens again, with the projects that stayed only.
 */
export function moveNotFinishedSplitParts(newRoot?: string): [string, string, string] {
  const before = "The move of the projects did not finish, so the library has been closed. Open the new library first, at its new place";
  const after = ": the move will be finished then. Until then the library they came from opens only read-only; after that it opens again for the projects that stayed. Nothing is lost.";
  return newRoot ? [`${before}, `, newRoot, after] : [`${before}${after}`, "", ""];
}

export function moveNotFinishedSplitText(newRoot?: string): string {
  return moveNotFinishedSplitParts(newRoot).join("");
}

/**
 * FR-068 (R607 d): a move that stopped after its switch began and before the old copy was marked by it. The library was
 * not switched and stays where it was; the copy at the new place is not used. A move into that folder is refused from
 * then on, so the way on is another, empty folder. The answer's `reason` for this case:
 */
export const MOVE_STOPPED_BEFORE_SWITCH_REASON = "move-stopped-before-switch";

/**
 * R612 m-A: the move stopped there because the mark could not be written to the library's OLD folder, for want of space
 * (ENOSPC, EDQUOT: "disk-full"), of permission (EACCES, EPERM: "permission") or because that disk is read-only (EROFS:
 * "read-only-disk"). Another empty folder would only meet the same failure, so the sentence names the cause and asks for
 * it to be put right first. The answer's reason is then `move-stopped-before-switch-<cause>`.
 */
export type OldFolderNotWritable = "disk-full" | "permission" | "read-only-disk";
const OLD_FOLDER_CAUSE: Record<OldFolderNotWritable, string> = {
  "disk-full": "the disk is full",
  permission: "permission was refused",
  "read-only-disk": "the disk can only be read",
};

/** The answer's reason for this case, with its cause when it has one. */
export function moveStoppedBeforeSwitchReason(cause?: OldFolderNotWritable): string {
  return cause ? `${MOVE_STOPPED_BEFORE_SWITCH_REASON}-${cause}` : MOVE_STOPPED_BEFORE_SWITCH_REASON;
}

/** Whether `reason` is this case's (`{}` without a cause), and its cause; undefined for any other reason. */
export function moveStoppedBeforeSwitchOf(reason?: string): { cause?: OldFolderNotWritable } | undefined {
  if (reason === MOVE_STOPPED_BEFORE_SWITCH_REASON) return {};
  const cause = (Object.keys(OLD_FOLDER_CAUSE) as OldFolderNotWritable[]).find((c) => reason === `${MOVE_STOPPED_BEFORE_SWITCH_REASON}-${c}`);
  return cause ? { cause } : undefined;
}

/** The sentence, in three parts: before the new place, the new place (the researcher's own text), after it. */
export function moveStoppedBeforeSwitchParts(newRoot?: string, cause?: OldFolderNotWritable): [string, string, string] {
  const before = cause
    ? `The move stopped before the library was switched, because the library's old folder could not be written to (${OLD_FOLDER_CAUSE[cause]}). Nothing of the library was deleted, and it stays where it was. The copy made at `
    : "The move stopped before the library was switched. Nothing of the library was deleted, and it stays where it was. The copy made at ";
  const after = cause
    ? " is not used and can be deleted. Free space or restore access at the library's folder before moving the library again."
    : " is not used and can be deleted. To move the library, choose another, empty folder.";
  return newRoot ? [before, newRoot, after] : [`${before}the new place${after}`, "", ""];
}

/** The sentence whole: with the new place when it is given (never in anything recorded), without it otherwise. */
export function moveStoppedBeforeSwitchText(newRoot?: string, cause?: OldFolderNotWritable): string {
  return moveStoppedBeforeSwitchParts(newRoot, cause).join("");
}

/**
 * FR-068 (R607 a, R612 I-A): the refusal of a move into a folder that holds an earlier move's switch which this move may
 * not resume (the engine's own reason; the service answers it as the reason of "The library cannot be moved there.").
 * Which one is said is decided by the engine's one judgement of that folder:
 * - STALE: only where the folder is provably a stale copy: the earlier move's old place is seen to be the living,
 *   unmarked library of the same id, or marked by a mark naming another library or carrying another move's id;
 * - UNFINISHED: in every other case (that move's mark recorded or seen, a mark without a move's id, the old place out of
 *   reach, this computer's record of the move missing): the folder may hold the library itself, so it never advises
 *   deleting it.
 */
export const MOVE_FOLDER_STALE_COPY_TEXT =
  "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first.";
export const MOVE_FOLDER_UNFINISHED_TEXT =
  "That folder holds a library whose move there has not finished. Choose another, empty folder. To finish that move, open the library at that folder.";
