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

/** An earlier write could not be fully undone; reopen the library so recovery can finish it. */
export class RecoveryPendingError extends Error {
  override name = "RecoveryPendingError";
  constructor(readonly projectId: string) {
    super(`An earlier change to project ${projectId} could not be fully undone; reopen the library to recover before making changes`);
  }
}

/** A path resolves (through a symbolic link) outside the folder it must stay in. */
export class PathEscapeError extends Error {
  override name = "PathEscapeError";
  constructor(readonly path: string) {
    super(`Refusing to write ${path}: it resolves outside its project folder (symbolic link)`);
  }
}

/** A file to append to does not end with a newline (a torn line from a crash). */
export class TornFileError extends Error {
  override name = "TornFileError";
  constructor(readonly path: string) {
    super(`Refusing to append to ${path}: its last line is incomplete (interrupted write); reopen the library to recover`);
  }
}

/** A project, source, collection, tag, participant or session id does not exist. */
export class NotFoundError extends Error {
  override name = "NotFoundError";
  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
  }
}
