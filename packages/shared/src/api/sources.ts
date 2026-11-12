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
