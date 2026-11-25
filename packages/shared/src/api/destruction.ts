/**
 * A destruction under the retention rule and the old copies of the library a move left behind
 * (R379, FR-A16; R409 d). An old copy this computer still lists that holds files destroyed in a
 * project is named in the destruction certificate as not destroyed, and the project carries this
 * warning until every such copy is gone. The sentences are the ones the researcher reads for it,
 * wherever the project's warnings are shown: the one that fits what can be done (oldCopiesPendingText).
 */
export const DESTRUCTION_OLD_COPIES_PENDING_WARNING = "destruction-old-copies-pending";

/** The app can still delete every such old copy (its offer has not expired and the service holds its token). */
export const OLD_COPIES_DELETE_IN_APP_TEXT =
  "Old copies of this library, left by a move, still hold data that was destroyed here. Delete them on the Move library screen to complete the destruction.";

/** The usual case: the app can no longer delete it; its place is named below the sentence. */
export const OLD_COPIES_DELETE_BY_HAND_TEXT =
  "Old copies of this library, left by a move, still hold data that was destroyed here. Delete the folder named below by hand to complete the destruction; the app will notice when it is gone.";

/** This computer's list of old copies could not be read (at the destruction, or now). */
export const OLD_COPIES_UNCHECKED_TEXT =
  "This computer's list of old copies of this library left by a move could not be read, so whether such a copy still holds the destroyed data could not be checked. Any that does was not destroyed.";

/** This computer has no record of where the old copy is (`dates`: the dates of the moves, YYYY-MM-DD; empty when not known). */
export function oldCopiesNoRecordText(dates: readonly string[]): string {
  const when = dates.length ? `the move of ${[...new Set(dates)].join(", ")}` : "a move (date unknown)";
  return `An old copy of this library, left by ${when}, may still hold data that was destroyed here. This computer has no record of where it is: open the library on the computer that moved it.`;
}

/** What stands behind the warning for one destruction (no path: each old copy by the time of the move that left it). */
export interface DestructionOldCopiesPending {
  /** Library-relative path of the destruction certificate. */
  certificateFile: string;
  /** The old copies still holding the destroyed files, by the time of the move that left each (ISO 8601). */
  oldCopies: Array<{ movedAt: string }>;
  /** The list of old copies could not be read, so whether one holds the files could not be checked yet. */
  unchecked?: true;
}

/** One old copy behind the warning, as the researcher's own screen is told of it (R409 d). */
export interface DestructionOldCopy {
  /** The date of the move that left it (YYYY-MM-DD, in the project's zone); absent when not known. */
  movedOn?: string;
  /**
   * Where it is, from this computer's list of old copies: for the researcher's own screen only (never
   * stored in the library, a certificate, an audit entry or an export). Absent when this computer has
   * no record of it.
   */
  place?: string;
  /** The app can still delete it: its offer has not expired and the service still holds its token. */
  canDelete: boolean;
}

/** `destructionOldCopiesPending[projectId]` in the library's state. */
export interface DestructionOldCopiesState {
  /** The sentence that fits (oldCopiesPendingText). */
  message: string;
  destructions: DestructionOldCopiesPending[];
  oldCopies: DestructionOldCopy[];
  /** This computer's list could not be checked (at a destruction, or now). */
  unchecked?: true;
}

/**
 * Every sentence that applies (R409 d, R429 f), in this order: the list could not be checked; else
 * (only when it could) this computer has no record of an old copy; and, for the old copies whose
 * place is known, what to do with the folders named below: delete them on the Move library screen
 * when the app can still delete every one, else by hand. With no copy known at all (and the list
 * checked), the by-hand sentence.
 */
export function oldCopiesPendingText(s: Pick<DestructionOldCopiesState, "oldCopies" | "unchecked">): string {
  const out: string[] = [];
  if (s.unchecked) out.push(OLD_COPIES_UNCHECKED_TEXT);
  const unknown = s.oldCopies.filter((c) => c.place === undefined);
  // A list that could not be read does not say "no record": its own sentence covers those copies.
  if (!s.unchecked && unknown.length) out.push(oldCopiesNoRecordText(unknown.flatMap((c) => (c.movedOn ? [c.movedOn] : []))));
  const known = s.oldCopies.filter((c) => c.place !== undefined);
  if (known.length) out.push(known.every((c) => c.canDelete) ? OLD_COPIES_DELETE_IN_APP_TEXT : OLD_COPIES_DELETE_BY_HAND_TEXT);
  return out.length ? out.join(" ") : OLD_COPIES_DELETE_BY_HAND_TEXT;
}

/**
 * FR-751 (R641 B4): the sentence for a destruction's backups step, by its status, from each status's definition in the
 * library (`BackupsStepStatus`, retention.ts): what the app can prove, never the raw code. A status this build does not
 * know is said as such.
 */
const BACKUPS_STATUS_TEXT: Readonly<Record<string, string>> = {
  none: "Backups holding them: none held these files.",
  pending: "Backups holding them: at least one listed backup is still to be removed; the app will try again.",
  "unknown-pending": "Backups holding them: a backup that could not be read, and may hold them, is still there.",
  deleted: "Backups holding them: every listed backup was removed by the app.",
  "no-longer-present": "Backups holding them: none is left. At least one listed backup is no longer there, and the app has no record of removing it.",
};

export function backupsStatusText(status: string): string {
  return Object.hasOwn(BACKUPS_STATUS_TEXT, status) ? BACKUPS_STATUS_TEXT[status]! : "Backups holding them: the app cannot tell how they stand.";
}
