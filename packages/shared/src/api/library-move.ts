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

/** The sentence, in three parts: before the new place, the new place (the researcher's own text), after it. */
export function moveStoppedBeforeSwitchParts(newRoot?: string): [string, string, string] {
  const before = "The move stopped before the library was switched. Nothing of the library was deleted, and it stays where it was. The copy made at ";
  const after = " is not used and can be deleted. To move the library, choose another, empty folder.";
  return newRoot ? [before, newRoot, after] : [`${before}the new place${after}`, "", ""];
}

/** The sentence whole: with the new place when it is given (never in anything recorded), without it otherwise. */
export function moveStoppedBeforeSwitchText(newRoot?: string): string {
  return moveStoppedBeforeSwitchParts(newRoot).join("");
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
