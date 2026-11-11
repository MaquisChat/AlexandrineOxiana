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

/**
 * A viewing proxy was not recorded (R85): its pending entry is gone (already recorded: recording is
 * idempotent), its original no longer exists, or the project's location rule became stricter than
 * the one the proxy was checked against. Nothing was written.
 */
export class ProxyRecordRefusedError extends Error {
  override name = "ProxyRecordRefusedError";
  constructor(readonly code: "ALREADY_RECORDED" | "ORIGINAL_GONE" | "RULE_CHANGED") {
    super(`the viewing proxy was not recorded (${code})`);
  }
}

/** A derived asset names a parent asset the source no longer has (R85 I1). */
export class MissingParentError extends Error {
  override name = "MissingParentError";
  constructor(readonly assetId: string) {
    super(`the parent asset ${assetId} no longer exists`);
  }
}

/** A derived file was asked for an original that was destroyed under the retention rule (R92 I4). */
export class DestroyedParentError extends Error {
  override name = "DestroyedParentError";
  constructor(readonly assetId: string) {
    super(`the parent asset ${assetId} was destroyed under the project's retention rule`);
  }
}

/** A request's value is not acceptable (a plain message for the person; services answer 400 VALIDATION). */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}

/** A participant or session is still linked to (consent records, sessions, sources): nothing was deleted (R97). */
export class FieldworkInUseError extends Error {
  override name = "FieldworkInUseError";
  constructor(
    what: string,
    readonly links: string[],
  ) {
    super(`${what} cannot be deleted because these still refer to it: ${links.join("; ")}. Remove those links first`);
  }
}
