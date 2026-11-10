import {
  AcknowledgementRequiredError,
  GovernanceViolationError,
  InvalidRecoveryCodeError,
  PolicyDeniedError,
  ProjectLockedError,
  ReadOnlyLibraryError,
  WorkerUnavailableError,
  WrongPassphraseError,
} from "@ao/library";

/** Process exit codes of `ao`. */
export const EXIT = {
  ok: 0,
  failure: 1,
  /** The project's rules (governance) do not allow it. */
  denied: 2,
  /** The one-time cookie acknowledgement is needed and cannot be asked for here. */
  acknowledgement: 3,
  /** The researcher must supply something (for example a legal basis), then run it again. */
  needsAction: 4,
} as const;

/** An error that ends the run with a plain message and a specific exit code. */
export class ExitError extends Error {
  override name = "ExitError";
  constructor(
    message: string,
    readonly code: number = EXIT.failure,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Turns anything thrown into the message, hint and exit code the researcher sees. */
export function describeError(err: unknown): { message: string; hint?: string; code: number } {
  if (err instanceof ExitError) return { message: err.message, ...(err.hint ? { hint: err.hint } : {}), code: err.code };
  if (err instanceof PolicyDeniedError) return { message: `This project's rules do not allow that: ${err.reason}`, code: EXIT.denied };
  if (err instanceof GovernanceViolationError) return { message: err.message, code: EXIT.denied };
  if (err instanceof AcknowledgementRequiredError) {
    return { message: err.explanation, hint: "Run again with --acknowledge-cookies to confirm, or run it in a terminal to be asked.", code: EXIT.acknowledgement };
  }
  if (err instanceof WrongPassphraseError) return { message: "That passphrase is not correct.", code: EXIT.failure };
  if (err instanceof InvalidRecoveryCodeError) return { message: "That recovery code is not valid.", code: EXIT.failure };
  if (err instanceof ProjectLockedError) return { message: "This project is locked. Its passphrase is needed.", code: EXIT.failure };
  if (err instanceof ReadOnlyLibraryError) return { message: err.message, code: EXIT.failure };
  if (err instanceof WorkerUnavailableError) {
    return { message: "The media helper is not running, so nothing was downloaded.", hint: "Run `pnpm setup:py` once, then try again.", code: EXIT.failure };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message, code: EXIT.failure };
}
