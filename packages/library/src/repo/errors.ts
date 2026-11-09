import type { PolicyAction } from "@ao/core";

/** The library is open read-only; nothing was evaluated or written. */
export class ReadOnlyLibraryError extends Error {
  override name = "ReadOnlyLibraryError";
  constructor(readonly reason?: string) {
    super(`The library is open read-only${reason ? ` (${reason})` : ""}; changes are not allowed`);
  }
}

/** The governance engine denied the action. The deny decision has been audited. */
export class PolicyDeniedError extends Error {
  override name = "PolicyDeniedError";
  constructor(
    readonly reason: string,
    readonly action: PolicyAction,
  ) {
    super(reason);
  }
}

/** An encrypted project's key is not in the key ring. */
export class ProjectLockedError extends Error {
  override name = "ProjectLockedError";
  constructor(readonly projectId: string) {
    super(`Project ${projectId} is locked; unlock it with its passphrase or recovery code`);
  }
}

/** Provenance is immutable once captured (spec 3.2). */
export class ImmutableProvenanceError extends Error {
  override name = "ImmutableProvenanceError";
  constructor() {
    super("Provenance cannot be changed after capture");
  }
}

/** A project's governance settings cannot be honoured by its configuration (e.g. no encryption). */
export class GovernanceViolationError extends Error {
  override name = "GovernanceViolationError";
}

/**
 * The project refuses writes until an earlier problem is resolved: an interrupted change that
 * could not be undone or whose marker is unresolved, or an audit log that could not be repaired
 * or appended to when the library was opened. The library's integrity warnings say which.
 */
export class RecoveryPendingError extends Error {
  override name = "RecoveryPendingError";
  constructor(readonly projectId: string) {
    super(
      `Project ${projectId} refuses changes: an earlier change could not be fully undone, or its audit log could not be repaired when the library was opened. ` +
        "Check the library's integrity warnings, then reopen the library",
    );
  }
}

/** A path resolves (through a symbolic link) outside the folder it must stay in. */
export class PathEscapeError extends Error {
  override name = "PathEscapeError";
  constructor(readonly path: string) {
    super(`Refusing to write ${path}: it resolves outside its project folder (symbolic link)`);
  }
}

/**
 * A file to append to does not end with a newline (a line cut off by a crash).
 * Such lines are trimmed when the library is opened read-write, except while
 * an interrupted change to the same project is still unresolved.
 */
export class TornFileError extends Error {
  override name = "TornFileError";
  constructor(readonly path: string) {
    super(`Refusing to append to ${path}: its last line is incomplete (interrupted write) and the file was left unchanged. ` +
        "Incomplete lines are trimmed when the library is opened read-write, unless an interrupted change to the project is still unresolved; " +
        "see the library's integrity warnings",
    );
  }
}

/** A project, source, collection, tag, participant or session id does not exist. */
export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
  }
}
