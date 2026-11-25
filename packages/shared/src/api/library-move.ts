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
 * R583 I1: the sentence for a split, in three parts. The moved projects' folders in the old library are marked (or are
 * marked when the move is finished), so that library opens again with the projects that stayed only.
 */
export function moveNotFinishedSplitParts(newRoot?: string): [string, string, string] {
  const after = ", and the move will be finished then. The library they came from can be opened again for the projects that stayed; nothing is lost.";
  return newRoot
    ? ["The move of the projects did not finish, so the library has been closed. Open the new library at its new place, ", newRoot, after]
    : [`The move of the projects did not finish, so the library has been closed. Open the new library at its new place${after}`, "", ""];
}

export function moveNotFinishedSplitText(newRoot?: string): string {
  return moveNotFinishedSplitParts(newRoot).join("");
}
