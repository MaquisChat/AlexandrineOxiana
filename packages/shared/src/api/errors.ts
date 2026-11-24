/**
 * The service's error answers (R96): always exactly `{ error: { code, message, reason? } }`, with a
 * plain-language message and no file-system path. Declared once (Task 47): the service's own
 * `ErrorCode` and `ErrorBody` (apps/library-service/src/errors.ts) are these, and the interface's
 * client reads its codes from here.
 *
 * Which codes a given route can answer is not declared as a type: the request modules name, in
 * comments, the refusals a handler itself makes. Besides those, any route can answer 401
 * UNAUTHORIZED and 403 FORBIDDEN (token, host, origin), 400 VALIDATION (a malformed body), 413
 * PAYLOAD_TOO_LARGE, 503 UNAVAILABLE while the service shuts down, and 500 INTERNAL; a route that
 * reads the open library also 503 LIBRARY_OFFLINE; a request that changes the library also 409 LIBRARY_CLOSED when
 * the library it began with was closed before its change was made (R551 M5); and a request other than GET, HEAD or
 * OPTIONS also 503 MOVE_IN_PROGRESS while the library is being moved.
 */

/** Every code the service answers with. */
export const SERVICE_ERROR_CODES = [
  "POLICY_DENIED",
  "READ_ONLY",
  "LIBRARY_OFFLINE",
  "LIBRARY_CLOSED",
  "WRONG_PASSPHRASE",
  "NOT_FOUND",
  "VALIDATION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "PROJECT_LOCKED",
  "CONFLICT",
  "ACKNOWLEDGEMENT_REQUIRED",
  "WORKER_UNAVAILABLE",
  "UNAVAILABLE",
  "DISK_FULL",
  "MOVE_IN_PROGRESS",
  "TOOL_NOT_INSTALLED",
  "TOOL_FAILED",
  "INTERNAL",
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/** The body of every error answer. */
export interface ServiceErrorBody {
  error: { code: ServiceErrorCode; message: string; reason?: string };
}

/**
 * R551 M5 (word for word): a change that reached the library after that library was closed (409 LIBRARY_CLOSED).
 * True whether or not another library is open by then. A request that finds no library open at all keeps
 * 503 LIBRARY_OFFLINE "No library is open.".
 */
export const LIBRARY_CLOSED_TEXT = "That library has been closed, so nothing was changed.";

/**
 * R551 M5 (word for word): a backup in flight when its library was closed, another library opened or the library
 * went offline: it was cancelled and nothing of it kept (409 LIBRARY_CLOSED with this sentence). The project's name is
 * the researcher's own text.
 */
export const BACKUP_CLOSED_TEXT = {
  before: "The library was closed or went offline before the backup of ",
  after: " was finished, so no backup was made. Back it up again when the library is open.",
} as const;

/** The one sentence for a backup of `projectName` that a close cancelled (BACKUP_CLOSED_TEXT around the name). */
export function backupClosedSentence(projectName: string): string {
  return `${BACKUP_CLOSED_TEXT.before}${projectName}${BACKUP_CLOSED_TEXT.after}`;
}
