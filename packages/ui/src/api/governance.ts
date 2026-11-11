/**
 * Typed service calls for Task 36 (R113: this task's own module, built on the shared client's
 * `request()` and `ndjson()`): governance rules, protocol documents, retention, the audit log,
 * fieldwork records, moving the library and relinking missing files.
 *
 * Governance edits always name the version they were made from (`baseSha256`, the sha256 GET
 * returned; R99): the service answers 409 CONFLICT when the file changed elsewhere meanwhile.
 */
import type { ApiClient } from "./client";

export type Profile = "irb" | "gdpr" | "hipaa" | "dmp";

export interface Violation {
  control: string;
  required: unknown;
  actual: unknown;
  profile: Profile;
}

export interface GovernanceFile {
  yaml: string;
  sha256: string;
  violations: Violation[];
}

export interface GovernanceSaved {
  violations: Violation[];
  loosened: string[];
  sha256: string;
}

export interface ProtocolDocument {
  name: string;
  bytes: number;
  encrypted: boolean;
}

export interface RetentionDue {
  destroyAfter: string | null;
  due: Array<{ sourceId: string; title: string; assetIds: string[] }>;
}

export interface DestructionCertificate {
  kind: "destruction-certificate";
  at: string;
  actor: string;
  assets: Array<{ assetId: string; sourceId: string; path: string; sha256: string; bytes: number }>;
  backups: { status: string; containing: string[]; deleted: string[] };
  notice: string;
  [k: string]: unknown;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  device: string;
  action: string;
  entity?: { type: string; id: string };
  decision?: { result: "allow" | "deny" | "allow_with_conditions"; reason?: string };
  details?: Record<string, unknown>;
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
}

export interface AuditCheck {
  ok: boolean;
  events: number;
  anchored: boolean;
  alteredAt: string[];
  problem?: { kind: string; detail: string };
}

export interface Participant {
  id: string;
  code: string;
  details?: Record<string, string>;
  consentIds: string[];
}

export interface Session {
  id: string;
  date: string;
  place?: string;
  participantIds: string[];
  notes?: string;
}

export interface ConsentRecord {
  id: string;
  participantId: string;
  documentAssetId?: string;
  scope: string;
  date: string;
  expires?: string;
  withdrawn?: { at: string };
}

export interface PolicyDecision {
  result: "allow" | "deny" | "allow_with_conditions";
  reason?: string;
  warnings?: string[];
}

export interface MovePlan {
  destination: { kind: string; [k: string]: unknown };
  perProject: Array<{ projectId: string; name: string; folder: string; decision: PolicyDecision }>;
  projectsMovedAway: string[];
  totalBytes: number;
  fileCount: number;
}

export interface MoveProgress {
  phase: "plan" | "copy" | "verify" | "switch";
  filesDone: number;
  fileCount: number;
  bytesDone: number;
  totalBytes: number;
}

export interface MoveResult {
  newRoot: string;
  confirmToken: string;
  expiresAt: string;
  fileCount: number;
  totalBytes: number;
  filesCopied: number;
  warnings: string[];
}

/** One line of the move's NDJSON stream. */
export type MoveLine = { progress: MoveProgress } | { done: true; result: MoveResult } | { error: { code: string; message: string; reason?: string } };

export interface PendingMove {
  oldRoot: string;
  newRoot: string;
  confirmToken: string;
  expiresAt: string;
}

export interface RelinkResult {
  relinked: number;
  stillMissing: number;
  relinkedPaths: string[];
  skipped: Array<{ path: string; reason: string }>;
  placeholderCandidates: string[];
  warnings: string[];
}

export interface IntegrityEntry {
  assetId: string | null;
  path: string;
}

export interface IntegrityAnswer {
  report: { checked: number; missing: IntegrityEntry[]; mismatched: IntegrityEntry[]; placeholders: IntegrityEntry[] };
  integrityWarnings: unknown[];
  projectWarnings: unknown;
}

export interface ProjectSummary {
  id: string;
  name: string;
}

const p = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export function governanceApi(client: ApiClient) {
  const r = client.request;
  return {
    projects: () => r<{ projects: ProjectSummary[] }>("GET", "/projects"),

    getGovernance: (projectId: string) => r<GovernanceFile>("GET", `${p(projectId)}/governance`),
    /** Always sends the version the edit was made from (R99). */
    putGovernance: (projectId: string, yaml: string, baseSha256: string, reason?: string) =>
      r<GovernanceSaved>("PUT", `${p(projectId)}/governance`, { body: { yaml, baseSha256, ...(reason ? { reason } : {}) } }),

    protocolDocuments: (projectId: string) => r<{ documents: ProtocolDocument[] }>("GET", `${p(projectId)}/protocol/documents`),
    addProtocolDocuments: (projectId: string, paths: string[]) => r<{ documents: ProtocolDocument[] }>("POST", `${p(projectId)}/protocol/documents`, { body: { paths } }),

    retention: (projectId: string) => r<RetentionDue>("GET", `${p(projectId)}/retention`),
    destroyRaw: (projectId: string, assetIds: string[]) =>
      r<{ certificate: DestructionCertificate; certificateFile: string }>("POST", `${p(projectId)}/retention/destroy`, { body: { assetIds, confirm: true } }),

    audit: (projectId: string, opts: { limit?: number; before?: number } = {}) =>
      r<AuditPage>("GET", `${p(projectId)}/audit`, { query: { limit: opts.limit, before: opts.before } }),
    verifyAudit: (projectId: string) => r<AuditCheck>("GET", `${p(projectId)}/audit/verify`),

    participants: (projectId: string) => r<{ participants: Participant[]; complete: boolean }>("GET", `${p(projectId)}/participants`),
    sessions: (projectId: string) => r<{ sessions: Session[]; complete: boolean }>("GET", `${p(projectId)}/sessions`),
    consents: (projectId: string) => r<{ consents: ConsentRecord[]; complete: boolean }>("GET", `${p(projectId)}/consents`),
    /** Without a code the service gives the next `P-NNN`. */
    createParticipant: (projectId: string, body: { code?: string; details?: Record<string, string>; legalBasis?: string }) =>
      r<Participant>("POST", `${p(projectId)}/participants`, { body }),
    updateParticipant: (projectId: string, id: string, body: { code?: string; details?: Record<string, string> | null; legalBasis?: string }) =>
      r<Participant>("PATCH", `${p(projectId)}/participants/${encodeURIComponent(id)}`, { body }),
    deleteParticipant: (projectId: string, id: string) => r<{ deleted: true }>("DELETE", `${p(projectId)}/participants/${encodeURIComponent(id)}`),
    createSession: (projectId: string, body: { date: string; place?: string; participantIds?: string[]; notes?: string; legalBasis?: string }) =>
      r<Session>("POST", `${p(projectId)}/sessions`, { body }),
    updateSession: (projectId: string, id: string, body: { date?: string; place?: string | null; participantIds?: string[]; notes?: string | null; legalBasis?: string }) =>
      r<Session>("PATCH", `${p(projectId)}/sessions/${encodeURIComponent(id)}`, { body }),
    deleteSession: (projectId: string, id: string) => r<{ deleted: true }>("DELETE", `${p(projectId)}/sessions/${encodeURIComponent(id)}`),
    createConsent: (projectId: string, body: { participantId: string; scope: string; date: string; expires?: string }) =>
      r<ConsentRecord>("POST", `${p(projectId)}/consents`, { body }),
    updateConsent: (projectId: string, id: string, body: { scope?: string; date?: string; expires?: string | null }) =>
      r<ConsentRecord>("PATCH", `${p(projectId)}/consents/${encodeURIComponent(id)}`, { body }),
    withdrawConsent: (projectId: string, id: string, reason?: string) =>
      r<{ consent: ConsentRecord; flaggedSourceIds: string[] }>("POST", `${p(projectId)}/consents/${encodeURIComponent(id)}/withdraw`, { body: reason ? { reason } : {} }),
    attachConsentDocument: (projectId: string, id: string, path: string) =>
      r<{ consent: ConsentRecord; sourceId: string; assetId: string }>("POST", `${p(projectId)}/consents/${encodeURIComponent(id)}/document`, { body: { path } }),

    movePlan: (dest: string) => r<MovePlan>("POST", "/libraries/move/plan", { body: { dest } }),
    /** Streams the move's progress; ends with `done` (verified and switched) or `error`. */
    move: (dest: string, excludeProjectIds: string[], signal?: AbortSignal) =>
      client.ndjson<MoveLine>("POST", "/libraries/move", { body: { dest, excludeProjectIds }, ...(signal ? { signal } : {}) }),
    moveStatus: () => r<{ pending: PendingMove | null }>("GET", "/libraries/move/status"),
    deleteOldCopy: (token: string) => r<{ warnings: string[]; [k: string]: unknown }>("POST", "/libraries/move/delete-old", { body: { token } }),

    integrity: () => r<IntegrityAnswer>("GET", "/libraries/integrity"),
    relink: (searchDir: string) => r<RelinkResult>("POST", "/libraries/relink", { body: { searchDir } }),
  };
}

export type GovernanceApi = ReturnType<typeof governanceApi>;
