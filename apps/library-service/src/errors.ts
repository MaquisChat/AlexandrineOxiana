/**
 * Error responses of the service: always exactly `{ error: { code, message, reason? } }` (R96), with
 * absolute paths scrubbed from `message` and `reason`. Library errors are mapped to codes here, in
 * one place.
 */
import { GovernanceParseError } from "@ao/core";
import {
  AcknowledgementRequiredError,
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
  if (err instanceof BatchRefusedError) return err.denied ? new ApiError(403, "POLICY_DENIED", "This project's rules do not allow that.", err.reason) : new ApiError(400, "VALIDATION", err.reason);
  if (err instanceof ReadOnlyLibraryError) return new ApiError(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.");
  if (err instanceof WrongPassphraseError) return new ApiError(401, "WRONG_PASSPHRASE", "That passphrase is not correct.");
  if (err instanceof InvalidRecoveryCodeError) return new ApiError(401, "WRONG_PASSPHRASE", "That recovery code is not valid.");
  if (err instanceof ProjectLockedError) return new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
  if (err instanceof NotFoundError) return new ApiError(404, "NOT_FOUND", err.message);
  if (err instanceof NotALibraryError) return new ApiError(404, "NOT_FOUND", "That folder is not a library.");
  if (err instanceof GovernanceLooseningError) return new ApiError(400, "VALIDATION", err.message);
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
  if (err instanceof MoveNotAllowedError) return new ApiError(403, "POLICY_DENIED", "The library cannot be moved there.", err.message);
  if (err instanceof InvalidConfirmTokenError) return new ApiError(400, "VALIDATION", "That confirmation is not valid (it is single use and expires).");
  if (err instanceof WorkerUnavailableError) return new ApiError(503, "WORKER_UNAVAILABLE", "The media helper is not running.", err.message);
  if (err instanceof WorkerJobError) return new ApiError(502, "INTERNAL", "The media helper could not finish the job.", err.code);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new ApiError(404, "NOT_FOUND", "That file or folder could not be found.");
  if (code === "EACCES" || code === "EPERM") return new ApiError(409, "READ_ONLY", "That file or folder cannot be written to.");
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  if (typeof code === "string" && code.startsWith("FST_ERR_CTP")) return new ApiError(400, "VALIDATION", "The request body is not valid JSON.");
  if (code === "FST_ERR_VALIDATION") return new ApiError(400, "VALIDATION", (err as Error).message);
  if (err instanceof TypeError || err instanceof RangeError) return new ApiError(400, "VALIDATION", err.message);
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
