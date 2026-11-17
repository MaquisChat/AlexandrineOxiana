import type { PolicyAction } from "@ao/core";
import { KeyWipedError } from "../crypto/format.js";

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

/**
 * A refusal because the project is locked: `ProjectLockedError`, or `KeyWipedError` from an opening whose key a lock
 * wiped mid-read (R386 a). A reader that tolerates what it cannot read lets these through: a lock is "locked", never
 * "damaged", "not found" or a shorter result (R404). A file sealed under a key id that is not the project's (a
 * KeyNotAvailableError that is not a wiped key) stays damage.
 */
export function isLockedRefusal(err: unknown): boolean {
  return err instanceof ProjectLockedError || err instanceof KeyWipedError;
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

/**
 * An interrupted change cannot be resolved the way asked (R27): it is kept only when its marker
 * shows it committed, rolled back only when it is uncommitted and its marker is valid; an invalid
 * marker cannot be acted on at all. `allowed` lists the choices that are possible.
 */
export class PendingWriteChoiceError extends Error {
  override name = "PendingWriteChoiceError";
  constructor(
    readonly txn: string,
    readonly allowed: Array<"roll-back" | "keep">,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The researcher's choice for an interrupted change was recorded but a step of it could not be
 * carried out yet (a file could not be overwritten or put back). The marker keeps the choice; it is
 * tried again by resolving again or on the next open (R131 c). The message is plain language.
 */
export class PendingWriteIncompleteError extends Error {
  override name = "PendingWriteIncompleteError";
  constructor(
    readonly txn: string,
    message: string,
  ) {
    super(message);
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

/**
 * The project's key file changed between reading it and writing (another new recovery code was issued
 * at the same time): nothing was written by this request (services answer 409 CONFLICT).
 */
export class KeyFileChangedError extends Error {
  override name = "KeyFileChangedError";
  constructor() {
    super("Another new recovery code was issued for this project at the same time, so this request changed nothing. Use the code that was shown, or ask for a new one again");
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

/** A review entry was already decided (two decisions at once: the first one stands, R176). */
export class ReviewEntryDecidedError extends Error {
  override name = "ReviewEntryDecidedError";
  constructor() {
    super("This entry has already been reviewed.");
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
