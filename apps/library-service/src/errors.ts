/**
 * Error responses of the service: always exactly `{ error: { code, message, reason? } }` (R96), with
 * absolute paths scrubbed from `message` and `reason`. Library errors are mapped to codes here, in
 * one place.
 */
import { CslBundleMissingError, CustomStyleSandboxError, GovernanceParseError, ParticipantCodeMissingError, UnknownStyleError } from "@ao/core";
import {
  AcknowledgementRequiredError,
  PendingWriteChoiceError,
  PendingWriteIncompleteError,
  AnchorsUnreadableError,
  AuditChainInvalidError,
  BackupNotRecordedError,
  DecryptionError,
  DestroyedParentError,
  EncryptionFormatError,
  ExportDestinationError,
  ExportFailedError,
  FieldworkInUseError,
  GovernanceConflictError,
  InvalidInputError,
  KeyNotAvailableError,
  LinkedContentChangedError,
  LockNotWritableError,
  MissingParentError,
  MoveVerificationError,
  PathEscapeError,
  ProxyRecordRefusedError,
  RestoreError,
  SandboxError,
  SecretStoreUnavailableError,
  TornFileError,
  UnsafeFileError,
  AlreadyALibraryError,
  BatchRefusedError,
  CorruptLibraryError,
  CustomStyleError,
  FolderNotEmptyError,
  GovernanceLooseningError,
  GovernanceViolationError,
  ImmutableProvenanceError,
  InvalidConfirmTokenError,
  InvalidRecoveryCodeError,
  LibraryMovedError,
  LibraryNotWritableError,
  MoveNotAllowedError,
  NoMediaError,
  NotALibraryError,
  NotFoundError,
  PolicyDeniedError,
  ProjectLockedError,
  ReadOnlyLibraryError,
  RecoveryPendingError,
  WorkerJobError,
  WorkerUnavailableError,
  WrongLibraryError,
  WrongPassphraseError,
  scrubPaths,
} from "@ao/library";

export type ErrorCode =
  | "POLICY_DENIED"
  | "READ_ONLY"
  | "LIBRARY_OFFLINE"
  | "WRONG_PASSPHRASE"
  | "NOT_FOUND"
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "PROJECT_LOCKED"
  | "CONFLICT"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "WORKER_UNAVAILABLE"
  | "UNAVAILABLE"
  | "MOVE_IN_PROGRESS"
  | "INTERNAL";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string): ApiError => new ApiError(400, "VALIDATION", message);
export const notFound = (what = "That item"): ApiError => new ApiError(404, "NOT_FOUND", `${what} was not found.`);

export interface ErrorBody {
  error: { code: ErrorCode; message: string; reason?: string };
}

/** Library error → status, code, plain message. Unknown errors are INTERNAL with a generic message. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof PolicyDeniedError) return new ApiError(403, "POLICY_DENIED", "This project's rules do not allow that.", err.reason);
  if (err instanceof PendingWriteChoiceError) return new ApiError(409, "CONFLICT", err.message, err.allowed.length ? `allowed: ${err.allowed.join(", ")}` : "allowed: none");
  // A recorded choice whose step could not be carried out yet: the plain reason is kept (R131 c).
  if (err instanceof PendingWriteIncompleteError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof BatchRefusedError) {
    if (err.denied) return new ApiError(403, "POLICY_DENIED", "This project's rules do not allow that.", err.reason);
    // Running (being paused or undone) or already finished: a state conflict (R102, by kind — R106).
    if (err.kind === "running" || err.kind === "finished") return new ApiError(409, "CONFLICT", err.reason);
    if (err.kind === "locked") return new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.", err.reason);
    return new ApiError(400, "VALIDATION", err.reason);
  }
  if (err instanceof ReadOnlyLibraryError) return new ApiError(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.");
  if (err instanceof WrongPassphraseError) return new ApiError(401, "WRONG_PASSPHRASE", "That passphrase is not correct.");
  if (err instanceof InvalidRecoveryCodeError) return new ApiError(401, "WRONG_PASSPHRASE", "That recovery code is not valid.");
  if (err instanceof ProjectLockedError) return new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
  if (err instanceof NotFoundError) return new ApiError(404, "NOT_FOUND", err.message);
  if (err instanceof NotALibraryError) return new ApiError(404, "NOT_FOUND", "That folder is not a library.");
  if (err instanceof GovernanceLooseningError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof GovernanceConflictError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof InvalidInputError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof FieldworkInUseError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof UnknownStyleError) return new ApiError(404, "NOT_FOUND", "That citation style is not available.");
  if (err instanceof CslBundleMissingError) return new ApiError(503, "UNAVAILABLE", "The citation styles are not installed.");
  if (err instanceof CustomStyleSandboxError || err instanceof SandboxError) return new ApiError(400, "VALIDATION", "That citation style could not be used (it is too complex or took too long).");
  if (err instanceof ParticipantCodeMissingError) return new ApiError(409, "CONFLICT", "A participant in these sources has no participant code yet, so they cannot be cited.");
  if (err instanceof ExportDestinationError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof ExportFailedError) return new ApiError(500, "INTERNAL", "The export could not be finished; nothing was left half-written.");
  if (err instanceof BackupNotRecordedError) return new ApiError(500, "INTERNAL", err.message);
  if (err instanceof DestroyedParentError || err instanceof MissingParentError) return new ApiError(409, "CONFLICT", "The file this would be made from is no longer there.");
  if (err instanceof KeyNotAvailableError) return new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
  if (err instanceof DecryptionError || err instanceof EncryptionFormatError) return new ApiError(409, "CONFLICT", "An encrypted file could not be read (damaged, or made with another key).");
  if (err instanceof PathEscapeError) return new ApiError(400, "VALIDATION", "That path is not allowed.");
  if (err instanceof RestoreError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof AuditChainInvalidError) return new ApiError(409, "CONFLICT", "The audit log does not verify, so this cannot be done.");
  if (err instanceof AnchorsUnreadableError || err instanceof TornFileError) return new ApiError(409, "CONFLICT", "A library record is damaged; see the library's integrity warnings.");
  if (err instanceof UnsafeFileError) return new ApiError(400, "VALIDATION", "This file could not be opened safely.");
  if (err instanceof LinkedContentChangedError) return new ApiError(409, "CONFLICT", "A linked file changed on disk.");
  if (err instanceof ProxyRecordRefusedError) return new ApiError(409, "CONFLICT", "That viewing copy was not recorded.", err.code);
  if (err instanceof SecretStoreUnavailableError) return new ApiError(503, "UNAVAILABLE", "This computer's keyring is not available.");
  if (err instanceof MoveVerificationError) return new ApiError(409, "CONFLICT", "The copied library did not verify; the old copy is kept and nothing was switched.");
  if (err instanceof LockNotWritableError) return new ApiError(409, "READ_ONLY", "The library's lock file cannot be written.");
  if (err instanceof GovernanceParseError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof GovernanceViolationError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof ImmutableProvenanceError) return new ApiError(400, "VALIDATION", "A source's provenance cannot be changed.");
  if (err instanceof CustomStyleError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof NoMediaError) return new ApiError(400, "VALIDATION", err.message);
  if (err instanceof AcknowledgementRequiredError) return new ApiError(409, "ACKNOWLEDGEMENT_REQUIRED", err.explanation);
  if (err instanceof RecoveryPendingError) return new ApiError(409, "CONFLICT", "This project refuses changes until an interrupted change is resolved; see the library's integrity warnings.");
  if (err instanceof FolderNotEmptyError || err instanceof AlreadyALibraryError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof WrongLibraryError || err instanceof LibraryMovedError || err instanceof CorruptLibraryError) return new ApiError(409, "CONFLICT", err.message);
  if (err instanceof LibraryNotWritableError) return new ApiError(409, "READ_ONLY", err.message);
  if (err instanceof MoveNotAllowedError) {
    // Changes still being written are a passing conflict, not a rule (R106).
    if (err.code === "pending-writes") return new ApiError(409, "CONFLICT", "Some changes are still being written. Try the move again in a moment.");
    return new ApiError(403, "POLICY_DENIED", "The library cannot be moved there.", err.message);
  }
  if (err instanceof InvalidConfirmTokenError) return new ApiError(400, "VALIDATION", "That confirmation is not valid (it is single use and expires).");
  if (err instanceof WorkerUnavailableError) return new ApiError(503, "WORKER_UNAVAILABLE", "The media helper is not running.", err.message);
  if (err instanceof WorkerJobError) return new ApiError(502, "INTERNAL", "The media helper could not finish the job.", err.code);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new ApiError(404, "NOT_FOUND", "That file or folder could not be found.");
  if (code === "EACCES" || code === "EPERM") return new ApiError(409, "READ_ONLY", "That file or folder cannot be written to.");
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP")) return new ApiError(400, "VALIDATION", "The request body is not valid JSON.");
  if (code === "FST_ERR_VALIDATION") return new ApiError(400, "VALIDATION", (err as Error).message);
  // A TypeError is a bug or an unchecked value: never echo its message (it may hold data).
  if ((err as { name?: string } | undefined)?.name === "ZodError") return new ApiError(400, "VALIDATION", "Some values are not valid.");
  return new ApiError(500, "INTERNAL", "Something went wrong. Nothing was changed by this request unless it says otherwise.");
}

/** The response body for an error, scrubbed of absolute paths (library-relative inside `roots`). */
export function errorBody(e: ApiError, roots: Iterable<string>): ErrorBody {
  const rs = [...roots];
  return {
    error: {
      code: e.code,
      message: scrubPaths(e.message, rs),
      ...(e.reason !== undefined ? { reason: scrubPaths(e.reason, rs) } : {}),
    },
  };
}
