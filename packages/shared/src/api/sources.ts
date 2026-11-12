/** Source records as the service sends them to the UI (Task 34a d). */

export type VerificationStatus = "verified" | "single-source" | "unverified" | "conflict" | "user-confirmed";

/** Where a piece of evidence came from, in words the UI can show as is. */
export interface EvidenceOrigin {
  /** embedded, lookup, platform-json, page-dom, filename, ai, zotero, refman, ocr, user. */
  kind: string;
  /** Plain words, e.g. "an online lookup (crossref)", "the web page", "the researcher". */
  label: string;
  provider?: string;
}

export interface FieldEvidenceEntry {
  value: unknown;
  from: EvidenceOrigin;
  /** The passage the value was read from, when one was recorded (AI evidence). */
  quote?: string;
  /** When it was recorded (ISO time). */
  at: string;
}

/** One field's verification and the evidence behind it. */
export interface FieldReview {
  /** JSON pointer into the source, e.g. "/title", "/issued". */
  field: string;
  /** "none": evidence exists but the field has not been checked. */
  status: VerificationStatus | "none";
  /** Names of the checks that ran. */
  checks: string[];
  /** Why it has this status, in plain words. */
  reason?: string;
  /** The record's value when it was checked. */
  current?: unknown;
  /** The differing values, for a conflict. */
  values?: Array<{ value: unknown; from: EvidenceOrigin }>;
  evidence: FieldEvidenceEntry[];
}

/**
 * `PATCH /projects/:id/sources/:sid/fields`: the researcher's value for one field, recorded as their
 * own evidence (the field becomes "user-confirmed" when it agrees). `field` is a top-level field
 * ("/title", "/issued" …) or one identifier under the verification report's own key
 * ("/identifiers/doi", R149), so a FieldReview's `field` can be posted back unchanged. Anything else
 * is refused (400 VALIDATION). An ISBN may be one string or a list.
 */
export interface FieldConfirmRequest {
  field: string;
  value: unknown;
}

/** The identifiers that can be confirmed one at a time (`/identifiers/<key>`, R149); the library's CONFIRMABLE_IDENTIFIERS. */
export const CONFIRMABLE_IDENTIFIER_KEYS: readonly string[] = ["doi", "isbn", "issn", "url", "platformPostId", "arxiv"];

/**
 * Added to every source record the service sends (`GET`/`PATCH /projects/:id/sources/:sid`,
 * `PATCH …/fields`, `POST …/recheck`), next to the stored record's own keys. In those records a
 * linked file's absolute path is left out (R132): `assets[].linked` keeps only `libraryRelativePath`.
 */
export interface SourceRecordExtras {
  /** Every field that has a verification or evidence, sorted by field. */
  fields: FieldReview[];
}

// ---- verification and background work of a source (Task 47) ----
//
// - `PATCH /projects/:id/sources/:sid/fields` FieldConfirmRequest → the source record (+ SourceRecordExtras)
// - `POST /projects/:id/sources/:sid/recheck` (no body)           → the source record (+ SourceRecordExtras)
// - `POST /projects/:id/recheck` (no body)                        → ProjectRecheckResponse; then
//   `job.progress` events of kind "recheck" (RecheckProgressEvent, R99)
// - `POST /jobs/retry` JobsRetryRequest                           → JobsRetryResponse (R84)

/** `POST /projects/:id/recheck`: the job runs in the background. */
export interface ProjectRecheckResponse {
  jobId: string;
  /** Sources to recheck. */
  total: number;
}

/** A `job.progress` event of a project recheck: after each source, and once more when finished (with the tallies). */
export interface RecheckProgressEvent {
  kind: "recheck";
  jobId: string;
  projectId: string;
  done: number;
  total: number;
  finished: boolean;
  /** On the last event: sources whose record changed, and those that could not be rechecked. */
  changed?: number;
  failed?: number;
}

/** `POST /jobs/retry`: run a project's failed viewing-copy and OCR jobs again (R84), of one source when named. */
export interface JobsRetryRequest {
  projectId: string;
  sourceId?: string;
}

export interface JobsRetryResponse {
  retrying: true;
}

// Refusals confirming a field and rechecking a source name: the project's rules (403 POLICY_DENIED),
// a locked project (423).
