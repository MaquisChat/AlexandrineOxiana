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
 * Added to every source record the service sends (`GET`/`PATCH /projects/:id/sources/:sid`,
 * `PATCH …/fields`, `POST …/recheck`), next to the stored record's own keys. In those records a
 * linked file's absolute path is left out (R132): `assets[].linked` keeps only `libraryRelativePath`.
 */
export interface SourceRecordExtras {
  /** Every field that has a verification or evidence, sorted by field. */
  fields: FieldReview[];
}
