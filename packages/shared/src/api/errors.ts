/**
 * The service's error answers (R96): always exactly `{ error: { code, message, reason? } }`, with a
 * plain-language message and no file-system path. Declared once (Task 47): the service's own
 * `ErrorCode` (apps/library-service/src/errors.ts) is checked to be exactly this list, and the
 * interface's client reads its codes from here.
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

/**
 * A set of codes a route can answer. Written through this alias so that a code that is not one of
 * the service's (a misspelling) fails to compile instead of silently matching nothing.
 */
export type ErrorCodes<C extends ServiceErrorCode> = C;

/**
 * Codes any route can answer: a refused token, host or origin (401, 403), a body that is not JSON or
 * fails a check (400), a body over the route's limit (413), and an unexpected failure (500).
 */
export type AnyRouteErrorCode = ErrorCodes<"UNAUTHORIZED" | "FORBIDDEN" | "VALIDATION" | "PAYLOAD_TOO_LARGE" | "INTERNAL">;

/** A route that reads the open library: also no library open or its folder unreachable (503), and an unknown project or item (404). */
export type LibraryReadErrorCode = ErrorCodes<AnyRouteErrorCode | "LIBRARY_OFFLINE" | "NOT_FOUND">;

/**
 * A route that changes the library (or is not a GET): also a read-only library (409 READ_ONLY) and a
 * library move running (503 MOVE_IN_PROGRESS).
 */
export type LibraryWriteErrorCode = ErrorCodes<LibraryReadErrorCode | "READ_ONLY" | "MOVE_IN_PROGRESS">;
