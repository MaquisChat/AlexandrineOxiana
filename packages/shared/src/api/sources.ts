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
 * A linked file of a source record as the service sends it: its library-relative path only (R132). R480 e: in the
 * answer of `GET /projects/:id/sources/:sid` (the one source the reader reads; never a list route), `missing: true`
 * when the file cannot be found now by the Missing files rule (R503 f, R510: nothing at its path, any symbolic link at
 * its path — whether or not it leads to a file — or a folder there; a file the app cannot read through). Absent: there, or not judged (other
 * routes, an older service). The reader opens the first PDF that is not missing.
 */
export interface LinkedFileView {
  libraryRelativePath: string;
  missing?: true;
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

// ---- verification and background work of a source (Task 47) ----
//
// - `PATCH /projects/:id/sources/:sid/fields` FieldConfirmRequest → the source record (+ SourceRecordExtras)
// - `POST /projects/:id/sources/:sid/recheck` (no body)           → the source record (+ SourceRecordExtras)
// - `POST /projects/:id/recheck` (no body)                        → ProjectRecheckResponse; then
//   `job.progress` events of kind "recheck" (RecheckProgressEvent, R99)
// - `GET /projects/:id/recheck`                                  → ProjectRecheckState (FR-717)
// - `POST /jobs/retry` JobsRetryRequest                           → JobsRetryResponse (R84)

/** `POST /projects/:id/recheck`: the job runs in the background. */
export interface ProjectRecheckResponse {
  jobId: string;
  /** Sources to recheck. */
  total: number;
}

/**
 * `GET /projects/:id/recheck` (FR-717): the project's recheck running now, with its progress as of its last event, or
 * null. A screen that comes back to the library asks it, so a running recheck is shown (and not started twice) before
 * its next event.
 */
export interface ProjectRecheckState {
  running: { jobId: string; done: number; total: number } | null;
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

/**
 * R362 c (defect D27): a file or folder inside the open library's own folder (by real path, links followed) is never
 * attached or imported, as watched folders already refuse such a folder (R310 h). The file's sentence is the attach
 * route's outcome for that file (and an import's note for a file of an item that leads into the library); the folder's
 * is the folder import's refusal (dry run, start and resume). A found file waiting for the researcher's check lives
 * there too, so it comes in only through "Use this file" in the review queue. The import file's sentence (R368 a) is the
 * refusal of an import whose OWN file (a ZIP, a BibTeX, RIS, CSL-JSON or Zotero RDF export) lies inside the library —
 * a backup above all, which holds the held files too (a backup is brought back by the restore, not by an import).
 */
/**
 * FR-749 (R546 2; R551 M5, word for word): an attach (or a watched folder's bringing-in) that a close of the library,
 * the opening of another library or the library going offline cancelled before anything of the file was written — it
 * was still looking the file's record up. The attach route answers the file with outcome `cancelled` and this
 * sentence; the page says it with the file's name shown as the researcher's own text.
 */
export const ATTACH_CLOSED_TEXT = {
  before: "The library was closed or went offline before ",
  after: " was attached, so nothing was changed. Attach it again when the library is open.",
} as const;

/**
 * R551 M5 (word for word): a watched folder's act ("Bring in the new version…", "Keep the library's copy as it is")
 * cut by a close, another library's opening or the library going offline; nothing was changed.
 */
export const WATCH_ACT_CLOSED_TEXT = "The library was closed or went offline before this could be done, so nothing was changed. Try again when the library is open.";

/**
 * Decision 31 (b), R556 (2) iii — the owner's words: the reason of a file an attach or a watched folder brought in at once,
 * as "needs review", because a metadata service it would have asked had asked to wait (it was left out, not waited for).
 * The attach route's outcome reason ("Stored; it needs review: …") and the first reason of its entry in the review queue.
 */
export const LOOKUP_WAITING_TEXT = "Waiting for lookup service response.";

/**
 * Decision 31 (c), "Look up again" — R577 (4), word for word. `found`, `fromFile`, `nothing`, `notAllowed` and the given-up
 * sentence (`lookUpGaveUpText`) take the place of LOOKUP_WAITING_TEXT in an entry's reasons once its state changes;
 * `notLookedUpYet` and `notLookedUpFailed` are said under the entry's matches; `looking` only on the screen while a look-up
 * runs; `act` is the button, `lookUpAgainAfter` the button before the service's named time. A lookup that failed
 * outright keeps the entry's own reason (today's sentence).
 */
export const LOOK_UP_AGAIN_TEXT = {
  notLookedUpYet: "Not looked up yet: the lookup service asked to wait.",
  looking: "Looking this up again…",
  found: "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one.",
  fromFile: "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first.",
  nothing: "The lookup service has now answered, but it found no match for this item.",
  notAllowed: "This project's rules no longer allow this lookup, so it was not looked up again.",
  gaveUp: "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again.",
  act: "Look up again",
  after: "Look up again (after {time})",
  notLookedUpFailed: "Not looked up: a lookup service could not be reached. You can use Look up again.",
} as const;

/** R577 (4): the given-up sentence with its number of tries. */
export function lookUpGaveUpText(n: number): string {
  return LOOK_UP_AGAIN_TEXT.gaveUp.replace("{n}", String(n));
}

/** R577 (4): the button before the service's named time, with that time as the screen writes it. */
export function lookUpAgainAfter(time: string): string {
  return LOOK_UP_AGAIN_TEXT.after.replace("{time}", time);
}

/** The one sentence for a file whose attach the library's closing cancelled (ATTACH_CLOSED_TEXT around its name). */
export function attachClosedSentence(fileName: string): string {
  return `${ATTACH_CLOSED_TEXT.before}${fileName}${ATTACH_CLOSED_TEXT.after}`;
}

export const IN_LIBRARY_TEXT = {
  file: "That file is inside this library's own folder. Files already in the library cannot be attached again.",
  folder: "That folder is inside this library's own folder, or holds it. Choose a folder outside the library.",
  importFile: "That file is inside this library's own folder. Choose a file outside the library.",
  /** R379 (FR-A14): a reference export's destination (BibTeX, RIS, CSL-JSON) is never written inside the library. */
  exportFile: "That place is inside this library's own folder. Choose a place outside the library.",
} as const;
