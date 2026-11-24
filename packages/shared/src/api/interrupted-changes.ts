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
 * The state of an incomplete roll-back, as the researcher must know it. R528: the state speaks of the WORST thing true of
 * the change: a file that cannot be put back (lost, or not confirmed) before a file in the way, before a file the app
 * could not read, before a step that failed.
 * - `try-again`: a step failed for no cause the undo could name; trying again may succeed (nothing was lost);
 * - `could-not-read` (R528 M4): the app could not read a file the undo had to judge; once it can, trying again may
 *   succeed (nothing was lost);
 * - `in-the-way`: a file changed or put there outside the app stands where the undo must remove or put back a file:
 *   the researcher moves it away, then the roll-back completes (nothing was lost);
 * - `lost`: the copy the app kept of a file the change removed is gone and nothing is at its place: that file can never
 *   be put back, and the change can be closed as it is (R509);
 * - `unconfirmed` (R527): the copy is gone, and at every such place something stands (`somethingThere` on each cause)
 *   that the app cannot confirm is the file the change removed (an older build half undid the change, the library was
 *   copied, a file system keeps no time of birth): never said to be lost; closable as `lost` is;
 * - `lost-and-blocked` (R528 I1, M2): a copy is gone (lost or not confirmed) AND something the researcher can deal with
 *   also stops the undo (a file in the way, a file that could not be read, a step that failed): that first; then the
 *   list says whether the change can be closed (R530: in one rare combination it cannot, `lost-copy-stuck`); not
 *   closable yet;
 * - `lost-copy-stuck` (R528 M2): a copy is gone, nothing else the researcher can deal with stops the undo, and the app
 *   still keeps a copy of another file of the change that it cannot put back (probe P5: a file inside a folder whose own
 *   copy is gone): closing would let that copy go, so no close is offered; a backup made before the change is the way.
 */
export type IncompleteRollback = "try-again" | "could-not-read" | "in-the-way" | "lost" | "unconfirmed" | "lost-and-blocked" | "lost-copy-stuck";

/**
 * The state of an incomplete roll-back from its causes; `stepFailed`: a step failed for no cause the undo could name;
 * `copyKept`: the app still keeps a copy of something of the change that is not back in its place (the library's
 * `keptCopiesLeft`), which only matters where a copy is gone and nothing else stops the undo. A cause of a kind this
 * build does not know counts as one that may pass (never closable).
 */
export function incompleteRollbackOf(causes: ReadonlyArray<{ kind: string; somethingThere?: boolean }>, stepFailed: boolean, copyKept = false): IncompleteRollback {
  const gone = causes.filter((c) => c.kind === "kept-copy-gone");
  const inTheWay = causes.some((c) => c.kind === "hand-changed-file" || c.kind === "path-occupied");
  const unread = causes.some((c) => c.kind === "could-not-look");
  const unknown = causes.some((c) => !(ROLLBACK_CAUSE_KINDS as readonly string[]).includes(c.kind));
  if (gone.length > 0) {
    if (inTheWay || unread || unknown || stepFailed) return "lost-and-blocked";
    if (copyKept) return "lost-copy-stuck";
    // Lost where nothing is at one place at least (a file of the change is lost there); else nothing is confirmed lost.
    return gone.some((c) => c.somethingThere !== true) ? "lost" : "unconfirmed";
  }
  if (inTheWay) return "in-the-way";
  if (unread) return "could-not-read";
  return "try-again";
}

/** The states in which the change can be closed as it is (R509): a copy is gone and nothing else is left to do. */
export const CLOSABLE_ROLLBACK: ReadonlySet<IncompleteRollback> = new Set(["lost", "unconfirmed"]);

/** The banner of an interrupted change whose undo is incomplete, by state; `p` is the project's name. */
export const INCOMPLETE_ROLLBACK_BANNER: Record<IncompleteRollback, (p: string) => string> = {
  "try-again": (p) =>
    `An interrupted change in ${p} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to ${p} are off until it is undone. Choose “Resolve…” to try again.`,
  "could-not-read": (p) =>
    `An interrupted change in ${p} could not be undone completely: the app could not read a file. Nothing was lost; the app keeps what it needs to finish. Changes to ${p} are off until it is undone. Choose “Resolve…” to see which file.`,
  "in-the-way": (p) =>
    `An interrupted change in ${p} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to ${p} are off until it is undone. Choose “Resolve…” to see which file to move.`,
  lost: (p) =>
    `An interrupted change in ${p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to ${p} are off until you close the change. Choose “Resolve…” to see what was lost.`,
  unconfirmed: (p) =>
    `An interrupted change in ${p} cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to ${p} are off until you close the change. Choose “Resolve…” to see what is there.`,
  // R528: never "lost" (the place may hold the file, R527) and never "nothing was lost"; what can be done first leads.
  "lost-and-blocked": (p) =>
    `An interrupted change in ${p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. Something else also stops the undo, and you can deal with it first: move the file the list names, or try again. After that, the list says whether the change can be closed as it is. Changes to ${p} are off until then. Choose “Resolve…” to see what to do first.`,
  "lost-copy-stuck": (p) =>
    `An interrupted change in ${p} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go, so it cannot be closed. Changes to ${p} are off. Restoring the project from a backup made before the change is the way to undo it.`,
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

/** R528 M5: the answer for a copy gone names the next step, the close the list then offers. */
const LOST_ANSWER =
  "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back. You can now close the change as it is from the list.";

/** "Roll it back" answered, when the undo is still incomplete, by state. */
export const ROLLBACK_INCOMPLETE_ANSWER: Record<IncompleteRollback, string> = {
  "try-again": "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library.",
  "could-not-read": "The change could not be undone completely: the app could not read a file. The list shows which file; make sure it can be read, then choose “Roll it back” again.",
  "in-the-way": "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again.",
  lost: LOST_ANSWER,
  // R527: true whether or not something stands at the place (it says nothing of what is there).
  unconfirmed: LOST_ANSWER,
  "lost-and-blocked":
    "The change could not be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and something else also stops the undo. The list shows what; deal with it first (move the file it names, or try again), then choose “Roll it back” again. After that, the list says whether the change can be closed as it is.",
  "lost-copy-stuck":
    "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and the app keeps a copy of another file of the change, which it cannot put back either. Restoring the project from a backup made before the change is the way to undo it.",
};

/**
 * R528 M2: in the list, under the causes, the next step of a state whose causes alone do not say it (the close is said
 * by its own hint where it is offered).
 */
export const ROLLBACK_LIST_NEXT: Partial<Record<IncompleteRollback, string>> = {
  "lost-and-blocked": "Deal with what is named above first, then choose “Roll it back” again. After that, this list says whether the change can be closed as it is.",
  "lost-copy-stuck":
    "The app still keeps a copy of another file of this change, which it cannot put back either, and closing would let that copy go, so this change cannot be closed. The way forward is to restore the project from a backup made before this change.",
};

/**
 * R509, R528 M2: the library's refusal to close while the app still keeps a copy of the change that it cannot put back
 * (closing would let that copy go); nothing the researcher can do in the app remains.
 */
export const CLOSE_COPIES_LEFT_TEXT =
  "This change cannot be closed: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Restoring the project from a backup made before the change is the way to undo it.";

/**
 * A change to a project refused while an interrupted change holds it (its undo not complete, at the opening or in the
 * running app): the service's answer and Find and acquire's (R528 M3: true of an undo that failed in the running app,
 * and pointing to the one screen that shows the warning).
 */
export const RECOVERY_PENDING_TEXT =
  "This project takes no changes until an interrupted change is resolved. The warning on the library's main screen says what to do.";

/**
 * R528 M3: the same refusal where what holds the project is lifted only by opening the library again (an audit entry
 * that could not be written at the opening; a change resolved while its audit log does not match this computer's record
 * of it, which the next opening records first).
 */
export const RECOVERY_PENDING_REOPEN_TEXT =
  "This project takes no changes until the library is opened again. The warning on the library's main screen says why.";
