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
 * reads the open library also 503 LIBRARY_OFFLINE; and a request other than GET, HEAD or OPTIONS
 * also 503 MOVE_IN_PROGRESS while the library is being moved.
 */

/** Every code the service answers with. */
export const SERVICE_ERROR_CODES = [
  "POLICY_DENIED",
  "READ_ONLY",
  "LIBRARY_OFFLINE",
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
