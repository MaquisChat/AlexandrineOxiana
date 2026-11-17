/**
 * A destruction under the retention rule and the old copies of the library a move left behind
 * (R379, FR-A16). An old copy this computer still lists that holds files destroyed in a project is
 * named in the destruction certificate as not destroyed, and the project carries this warning until
 * every such copy is gone. The sentence is the one the researcher reads for it, wherever the
 * project's warnings are shown.
 */
export const DESTRUCTION_OLD_COPIES_PENDING_WARNING = "destruction-old-copies-pending";

export const DESTRUCTION_OLD_COPIES_PENDING_TEXT =
  "Old copies of this library, left by a move, still hold data that was destroyed here. Delete them from the Move library screen (or by hand) to complete the destruction.";

/** What stands behind the warning for one destruction (no path: each old copy by the time of the move that left it). */
export interface DestructionOldCopiesPending {
  /** Library-relative path of the destruction certificate. */
  certificateFile: string;
  /** The old copies still holding the destroyed files, by the time of the move that left each (ISO 8601). */
  oldCopies: Array<{ movedAt: string }>;
  /** The list of old copies could not be read, so whether one holds the files could not be checked yet. */
  unchecked?: true;
}
