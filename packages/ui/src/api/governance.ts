/**
 * Typed service calls for Task 36 (R113: this task's own module, built on the shared client's
 * `request()` and `ndjson()`): governance rules, protocol documents, retention, the audit log,
 * fieldwork records, moving the library and relinking missing files.
 *
 * Governance edits always name the version they were made from (`baseSha256`, the sha256 GET
 * returned; R99): the service answers 409 CONFLICT when the file changed elsewhere meanwhile.
 */
import type { AttentionMarksResponse, AuditReasonView, LibraryAuditCheck, LibraryAuditPage, SetAsideResponse } from "@ao/shared";
import { ApiClientError, type ApiClient } from "./client";

/**
 * The client's error for a stream that ended unexpectedly: cut off in the middle of a line, or the
 * connection lost while reading (status 0). The work may still be running on the service. Before
 * the stream `started` (no line read yet), an unreachable service means the work never started
 * (R119), so that is not a cut-off.
 */
export function isStreamCutOff(err: unknown, started: boolean): boolean {
  if (!(err instanceof ApiClientError) || err.status !== 0) return false;
  if (err.code === "INTERNAL") return true;
  return err.code === "UNAVAILABLE" && started;
}

/**
 * A folder path compared the way the service resolves it (path.resolve semantics): separators
 * unified, "." and ".." resolved, trailing separators dropped; Windows paths (drive letter, UNC or
 * backslashes) compared without regard to case.
 */
export function normaliseRoot(p: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.includes("\\");
  const s = p.trim().replace(/\\/g, "/");
  const prefix = /^[A-Za-z]:\//.test(s) ? s.slice(0, 3) : s.startsWith("//") ? "//" : s.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const seg of s.slice(prefix.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const out = prefix + parts.join("/");
  return windows ? out.toLowerCase() : out;
}

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

export interface ProtocolDocumentResult {
  file: string;
  outcome: "added" | "failed";
  document?: ProtocolDocument;
  reason?: string;
}

export interface RetentionDue {
  destroyAfter: string | null;
  /** The project's time zone the date is read in (R93); null or absent: UTC. */
  timeZone?: string | null;
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
  /** The reason the researcher typed, as the service reads it (R362 b): sealed reasons of an encrypted project included. */
  reasonShown?: AuditReasonView;
}

export type { AttentionMarkView, AttentionMarksResponse, LibraryAuditCheck, LibraryAuditPage, SetAsideResponse } from "@ao/shared";

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
  detachedAssetIds?: string[];
  scope: string;
  date: string;
  expires?: string;
  withdrawn?: { at: string; reason?: string };
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

/**
 * GET /libraries/move/status (R379): whether a move runs now; the last finished move (its token);
 * the last move that stopped with an error, under the `attempt` id its screen sent.
 */
export interface MoveStatus {
  pending: PendingMove | null;
  running?: boolean;
  failed?: { newRoot: string; attempt: string | null; error: { code: string; message: string; reason?: string } } | null;
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
  encrypted?: boolean;
  /** An encrypted project that is not unlocked cannot be changed (PROJECT_LOCKED). */
  unlocked?: boolean;
}

const p = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export function governanceApi(client: ApiClient) {
  const r = client.request;
  return {
    projects: () => r<{ projects: ProjectSummary[] }>("GET", "/projects"),
    /** Whether the open library may be changed here (its mode), for screens that say so before a change is refused. */
    libraryMode: async () => (await r<{ current?: { mode?: string } }>("GET", "/libraries")).current?.mode,

    getGovernance: (projectId: string) => r<GovernanceFile>("GET", `${p(projectId)}/governance`),
    /** Always sends the version the edit was made from (R99). */
    putGovernance: (projectId: string, yaml: string, baseSha256: string, reason?: string) =>
      r<GovernanceSaved>("PUT", `${p(projectId)}/governance`, { body: { yaml, baseSha256, ...(reason ? { reason } : {}) } }),

    protocolDocuments: (projectId: string) => r<{ documents: ProtocolDocument[] }>("GET", `${p(projectId)}/protocol/documents`),
    /** One result per file (R117 I6) and the documents now held. */
    addProtocolDocuments: (projectId: string, paths: string[]) =>
      r<{ results: ProtocolDocumentResult[]; documents: ProtocolDocument[] }>("POST", `${p(projectId)}/protocol/documents`, { body: { paths } }),

    retention: (projectId: string) => r<RetentionDue>("GET", `${p(projectId)}/retention`),
    /** Sets (an IANA zone name) or clears (null: UTC) the time zone the project's dates are read in (R93). */
    setTimeZone: (projectId: string, timeZone: string | null) => r<{ timeZone: string | null }>("PUT", `${p(projectId)}/time-zone`, { body: { timeZone } }),
    destroyRaw: (projectId: string, assetIds: string[]) =>
      r<{ certificate: DestructionCertificate; certificateFile: string }>("POST", `${p(projectId)}/retention/destroy`, { body: { assetIds, confirm: true } }),

    audit: (projectId: string, opts: { limit?: number; before?: number } = {}) =>
      r<AuditPage>("GET", `${p(projectId)}/audit`, { query: { limit: opts.limit, before: opts.before } }),
    verifyAudit: (projectId: string) => r<AuditCheck>("GET", `${p(projectId)}/audit/verify`),

    /** The project's attention marks (Task 50, R154 b). */
    attention: (projectId: string) => r<AttentionMarksResponse>("GET", `${p(projectId)}/attention`),
    /** Sets a mark aside with a reason (decided and audited, R154 d). */
    setAsideMark: (projectId: string, markId: string, reason: string) =>
      r<SetAsideResponse>("POST", `${p(projectId)}/attention/${encodeURIComponent(markId)}/set-aside`, { body: { reason } }),
    /** The library's own audit log (refused project creations, set-asides; R154 a, b). */
    libraryAudit: (opts: { limit?: number; before?: number } = {}) => r<LibraryAuditPage>("GET", "/libraries/audit", { query: { limit: opts.limit, before: opts.before } }),
    verifyLibraryAudit: () => r<LibraryAuditCheck>("GET", "/libraries/audit/verify"),

    participants: (projectId: string) => r<{ participants: Participant[]; complete: boolean }>("GET", `${p(projectId)}/participants`),
    sessions: (projectId: string) => r<{ sessions: Session[]; complete: boolean }>("GET", `${p(projectId)}/sessions`),
    consents: (projectId: string) => r<{ consents: ConsentRecord[]; complete: boolean }>("GET", `${p(projectId)}/consents`),
    /** Without a code the service gives the next `P-NNN`. */
    createParticipant: (projectId: string, body: { code?: string; details?: Record<string, string>; legalBasis?: string }) =>
      r<Participant>("POST", `${p(projectId)}/participants`, { body }),
    /** Details only: participant codes never change (R117 C1). */
    updateParticipant: (projectId: string, id: string, body: { details?: Record<string, string> | null; legalBasis?: string }) =>
      r<Participant>("PATCH", `${p(projectId)}/participants/${encodeURIComponent(id)}`, { body }),
    deleteParticipant: (projectId: string, id: string) => r<{ deleted: true }>("DELETE", `${p(projectId)}/participants/${encodeURIComponent(id)}`),
    createSession: (projectId: string, body: { date: string; place?: string; participantIds?: string[]; notes?: string; legalBasis?: string }) =>
      r<Session>("POST", `${p(projectId)}/sessions`, { body }),
    updateSession: (projectId: string, id: string, body: { date?: string; place?: string | null; participantIds?: string[]; notes?: string | null; legalBasis?: string }) =>
      r<Session>("PATCH", `${p(projectId)}/sessions/${encodeURIComponent(id)}`, { body }),
    deleteSession: (projectId: string, id: string) => r<{ deleted: true }>("DELETE", `${p(projectId)}/sessions/${encodeURIComponent(id)}`),
    createConsent: (projectId: string, body: { participantId: string; scope: string; date: string; expires?: string }) =>
      r<ConsentRecord>("POST", `${p(projectId)}/consents`, { body }),
    /** The document is set only by attachConsentDocument; detaching needs a reason (R117 I3). */
    updateConsent: (projectId: string, id: string, body: { scope?: string; date?: string; expires?: string | null; documentAssetId?: null; detachReason?: string }) =>
      r<ConsentRecord>("PATCH", `${p(projectId)}/consents/${encodeURIComponent(id)}`, { body }),
    withdrawConsent: (projectId: string, id: string, reason?: string) =>
      r<{ consent: ConsentRecord; flaggedSourceIds: string[] }>("POST", `${p(projectId)}/consents/${encodeURIComponent(id)}/withdraw`, { body: reason ? { reason } : {} }),
    /** `reattach`: link a form that was detached from this record before (explicit, audited; R119). */
    attachConsentDocument: (projectId: string, id: string, path: string, reattach?: boolean) =>
      r<{ consent: ConsentRecord; sourceId: string; assetId: string; note?: string }>("POST", `${p(projectId)}/consents/${encodeURIComponent(id)}/document`, { body: { path, ...(reattach ? { reattach: true } : {}) } }),

    movePlan: (dest: string) => r<MovePlan>("POST", "/libraries/move/plan", { body: { dest } }),
    /** Streams the move's progress; ends with `done` (verified and switched) or `error`. */
    /** `onOpen`: the service accepted the move (its answer's headers arrived); from then on a broken stream is not "not started". */
    /** `attempt`: the screen's own id for this request; a failure is kept under it in move/status (R379). */
    move: (dest: string, excludeProjectIds: string[], signal?: AbortSignal, onOpen?: () => void, attempt?: string) =>
      client.ndjson<MoveLine>("POST", "/libraries/move", { body: { dest, excludeProjectIds, ...(attempt ? { attempt } : {}) }, ...(signal ? { signal } : {}), ...(onOpen ? { onOpen } : {}) }),
    moveStatus: () => r<MoveStatus>("GET", "/libraries/move/status"),
    deleteOldCopy: (token: string) => r<{ warnings: string[]; [k: string]: unknown }>("POST", "/libraries/move/delete-old", { body: { token } }),

    integrity: () => r<IntegrityAnswer>("GET", "/libraries/integrity"),
    relink: (searchDir: string) => r<RelinkResult>("POST", "/libraries/relink", { body: { searchDir } }),
    /** "Rebuild library from folder" (spec 4.3, D8). */
    rebuildIndex: () => r<{ indexed: number; lockedProjects: number; errors: number }>("POST", "/libraries/rebuild-index"),
  };
}

export type GovernanceApi = ReturnType<typeof governanceApi>;
