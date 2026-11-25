/**
 * FR-755 (R573, R577 (2), R578): what the service and the move dialog say when a move fails after it has closed the old
 * copy. The library is then closed in the service, and opening it at its new place finishes the move (the service does
 * that at the opening). The service's own answer carries no path (it is recorded as the last failed move); the dialog,
 * which knows the folder it asked for, names it (shown through UserText).
 */

/** The error answer's `reason` for this case. */
export const MOVE_NOT_FINISHED_REASON = "move-not-finished";

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
