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
}

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
