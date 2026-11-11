/**
 * Pairing the browser extension (R96, R98; Task 46c): the desktop app issues a one-time code and can
 * read what became of it. The code itself is a secret: it is in `POST /extension/pair`'s answer only,
 * never in a status. A code is known by its `codeId`, which is not a secret.
 *
 * Routes (UI token only; the status routes also only from the desktop app's own origin):
 *  - `POST /extension/pair`                     → PairingCodeIssued (any earlier code stops working)
 *  - `GET /extension/pair/status`               → PairingCodeStatus of the code most recently issued
 *  - `GET /extension/pair/status/:codeId`       → PairingCodeStatus of that code
 * The status routes are the only UI-token routes that need an Origin header: the desktop app's page
 * always sends one, and a caller without one (a command-line tool) is refused (Task 46c, review M5).
 */

/** The form of a code's id: 16 lowercase hexadecimal characters. */
export const PAIRING_CODE_ID = /^[0-9a-f]{16}$/;

/** `POST /extension/pair` (no body). */
export interface PairingCodeIssued {
  /** Six digits; single use. */
  code: string;
  /** Not a secret: names this code in the status route. */
  codeId: string;
  /** When the service stops accepting the code (the service's clock). */
  expiresAt: string;
  /** How long the code is valid from this answer on, in milliseconds (needs no clock but the reader's). */
  validForMs: number;
}

/** The browser a code paired: as `GET /extension/pairings` lists it. */
export interface PairingCodeBrowser {
  /** The pairing's id. */
  id: string;
  /** The extension's origin, e.g. `chrome-extension://<id>`. */
  origin: string;
}

/** `GET /extension/pair/status[/:codeId]`. */
export type PairingCodeStatus =
  /** No code issued since the service started, or not a code it knows. */
  | { state: "none" }
  /** Valid now. `validForMs` is never more than the code's lifetime. */
  | { state: "active"; codeId: string; expiresAt: string; validForMs: number }
  /**
   * The right code was given and the pairing is being saved: the code is spent, but not yet `used`.
   * It ends as `used` once the pairing is saved, or as `invalidated` (`not-saved`) if saving failed.
   */
  | { state: "confirming"; codeId: string }
  /** A browser was paired with it. */
  | { state: "used"; codeId: string; usedAt: string; browser: PairingCodeBrowser }
  /** Its time ran out. */
  | { state: "expired"; codeId: string; expiredAt: string }
  /**
   * Stopped working without pairing anything: after too many wrong tries (R96: 5), or because the
   * right code's pairing could not be saved (the extension was told it failed).
   */
  | { state: "invalidated"; codeId: string; invalidatedAt: string; reason: PairingCodeInvalidReason }
  /** A newer code was issued while this one was still valid. */
  | { state: "replaced"; codeId: string; replacedAt: string };

export type PairingCodeInvalidReason = "wrong-tries" | "not-saved";

export type PairingCodeState = PairingCodeStatus["state"];
