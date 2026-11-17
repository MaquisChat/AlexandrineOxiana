/** The library's own audit log and projects' attention marks (Task 50, R154). */

/** One audit event as the service returns it (the library's log or a project's). */
export interface AuditEventView {
  seq: number;
  at: string;
  actor: string;
  device: string;
  action: string;
  projectId?: string;
  entity?: { type: string; id: string };
  decision?: { result: "allow" | "deny" | "allow_with_conditions"; reason?: string; conditions?: unknown[] };
  details?: Record<string, unknown>;
  /**
   * The reason the researcher typed, for the operations that take one (R362 b): as typed in a project that is not
   * encrypted; in an encrypted project the audit entry holds only that a reason was given and its SHA-256, and the
   * text is read from where it is kept sealed: shown while the project is unlocked and the text matches the entry's
   * SHA-256, otherwise one of the sentences below.
   */
  reasonShown?: AuditReasonView;
}

/** What the audit screen shows for a reason (R362 b, R177 b). */
export type AuditReasonView = { state: "text"; text: string } | { state: "locked" | "missing" | "mismatch"; message: string };

/** An encrypted project's reason while it is locked (R362 b). */
export const REASON_SEALED_LOCKED = "A reason was given. It can be read when the project is unlocked.";
/** Unlocked, but the sealed text is not there (removed or damaged outside the app). */
export const REASON_SEALED_MISSING = "A reason was given, but its text is no longer in this project.";
/** Unlocked, but the sealed text does not match the SHA-256 the audit entry recorded: never shown as the reason. */
export const REASON_SEALED_MISMATCH = "A reason was given, but the text kept for it does not match what the audit log recorded, so it is not shown.";

/** `GET /libraries/audit`: a page of the library's audit log, newest first. */
export interface LibraryAuditPage {
  events: AuditEventView[];
  total: number;
}

/** `GET /libraries/audit/verify`. */
export interface LibraryAuditCheck {
  ok: boolean;
  events: number;
  /** A head was recorded on this computer to compare with. */
  anchored: boolean;
  /** When earlier opens found the log altered. */
  alteredAt: string[];
  problem?: { kind: string; detail: string };
}

/** One mark in `GET /projects/:id/attention`. */
export interface AttentionMarkView {
  id: string;
  /**
   * `waiting`: kept on this computer until it holds the library's lock; not set aside here.
   * `unrecognised`: anything in the attention folder that is not a well-formed mark (N2).
   */
  kind: "audit-unrecorded" | "permissions-not-set" | "unrecognised" | "waiting";
  /** For an unrecognised item: its name in the attention folder (user text). */
  name?: string;
  action?: string;
  occurredAt?: string;
  actor?: string;
  reason?: string;
  interrupted?: boolean;
  refusal?: boolean;
  canSetAside: boolean;
}

export interface AttentionMarksResponse {
  marks: AttentionMarkView[];
}

/** `POST /projects/:id/attention/:markId/set-aside` with `{ reason }`. */
export interface SetAsideResponse {
  recordedIn: "project" | "library";
}
