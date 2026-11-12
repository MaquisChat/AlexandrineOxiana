/**
 * The project's review queue (R172, Task 67): `GET /projects/:id/review` lists every pending entry
 * of the project, of every kind. Each entry is resolved by the library's own way for its kind (R176):
 * - an import entry (with or without a batch) by `POST /review/:itemId/decide` (the project in the body);
 * - a capture's conflict entry by confirming its fields (`PATCH /projects/:id/sources/:sid/fields`,
 *   R149): the confirm that leaves none of its fields in conflict or unconfirmed resolves it, in the
 *   same change; so does a recheck;
 * - a consent withdrawal's entry by `POST /review/:itemId/reviewed-after-withdrawal`, with a reason.
 * A source that is removed takes its pending entries with it (resolved in the removal's change).
 */

/** What queued a verification entry (R176 3). */
export type ReviewCause = { kind: "capture-conflict" } | { kind: "consent-withdrawal"; consentIds: string[] };

/**
 * Where an entry came from, so a person can tell entries apart:
 * - `import`: an item of an import batch (`batchId` names it);
 * - `attach`: a file added by hand (drag and drop), an import entry with no batch;
 * - `capture`: a capture saved with fields that need review;
 * - `withdrawal`: a source flagged because a participant's consent was withdrawn.
 */
export type ReviewGroup = "import" | "attach" | "capture" | "withdrawal";

/**
 * The group of an entry, from its kind, batch and cause. The cause of a verification entry is the
 * library's (`reviewCauseOf`: recorded on the entry, or inferred there for entries queued before
 * causes were recorded); this function never guesses it.
 */
export function reviewGroup(e: { kind: string; batchId?: string | undefined; cause?: ReviewCause | undefined }): ReviewGroup {
  if (e.kind === "import") return e.batchId ? "import" : "attach";
  return e.cause?.kind === "consent-withdrawal" ? "withdrawal" : "capture";
}

/** One pending entry of the project's queue. Reasons, candidates, hints and the title are source or user text. */
export interface ProjectReviewEntry {
  id: string;
  projectId: string;
  sourceId: string;
  kind: "import" | "verification";
  group: ReviewGroup;
  /** Verification entries: what queued it (recorded, or as the library reads an older entry). */
  cause?: ReviewCause;
  status: "pending";
  /** When it was queued (ISO 8601). */
  createdAt: string;
  /** JSON pointer → the field's verification status when it was queued. */
  fields: Record<string, string>;
  /** Why it waits, in plain words. */
  reasons: string[];
  /** The source's current title. */
  title?: string;
  batchId?: string;
  confidence?: number;
  method?: string;
  candidates?: unknown[];
  duplicateOf?: { sourceId: string; reason: string };
  hints?: string[];
}

/** `GET /projects/:id/review?offset&limit&source`: one page of the queue, oldest first; `total` counts every entry the query matches. */
export interface ProjectReviewPage {
  items: ProjectReviewEntry[];
  total: number;
  offset: number;
  limit: number;
}

/** The most entries one page may hold; `limit=0` answers only the total. */
export const PROJECT_REVIEW_PAGE_MAX = 1000;

/**
 * `POST /review/:itemId/reviewed-after-withdrawal` (R176 2): the researcher's decision on an entry a
 * consent withdrawal queued. `reason` is required (the policy engine refuses a blank one: 403
 * POLICY_DENIED with the engine's reason) and stored as typed, at most `WITHDRAWAL_REASON_MAX`
 * characters. It changes nothing else about the source.
 */
export interface WithdrawalReviewedRequest {
  projectId: string;
  reason: string;
}

/** The answer: the entry as resolved. A second decision on the same entry is 409 CONFLICT. */
export interface WithdrawalReviewedResponse {
  entry: { id: string; sourceId: string; status: "resolved"; decision: "reviewed-after-withdrawal"; resolvedAt: string; reason: string };
}

export const WITHDRAWAL_REASON_MAX = 2000;

// ---- deciding import entries (Task 47) ----
//
// - `POST /review/:itemId/decide`  ReviewDecideRequest   → ReviewDecideResponse
// - `POST /review/bulk-edit`       ReviewBulkEditRequest → ReviewBulkEditResponse
// Both name the project in the body (R97); a project not in the library is 400 VALIDATION.

/** The decisions an import entry takes; any other `decision.action` is 400 VALIDATION. */
export const REVIEW_DECISION_ACTIONS = ["accept", "accept-candidate", "merge", "skip", "keep-both"] as const;
export type ReviewDecisionAction = (typeof REVIEW_DECISION_ACTIONS)[number];

/** A text in one or more languages and forms (core's MultiText), as the review form edits a title. */
export interface MultiTextValue {
  variants: Array<{ lang: string; kind: "original" | "romanized" | "translated"; value: string }>;
}

/**
 * What the researcher corrected before accepting an entry: the part of the library's source draft
 * (SourceDraft) the review form edits. The route accepts more than this declares: it passes the
 * whole `draft` to the library, which validates it (review M3).
 */
export interface ReviewDraft {
  type?: string;
  title?: MultiTextValue;
}

export type ReviewEntryDecision =
  | { action: "accept"; draft?: ReviewDraft }
  /** `index` into the entry's `candidates`. */
  | { action: "accept-candidate"; index: number }
  /** Merge into this existing source. */
  | { action: "merge"; sourceId: string }
  | { action: "skip" }
  | { action: "keep-both" };

export interface ReviewDecideRequest {
  projectId: string;
  decision: ReviewEntryDecision;
}

export interface ReviewDecideResponse {
  decided: true;
}

/** What a bulk edit sets on every entry's source. */
export interface ReviewEntryPatch {
  type?: string;
  tagIds?: string[];
  collectionId?: string;
}

/** At most 10 000 entries at once. */
export interface ReviewBulkEditRequest {
  projectId: string;
  itemIds: string[];
  patch: ReviewEntryPatch;
}

export interface ReviewBulkEditResponse {
  /** How many entries were named (every one was edited, or the request failed as a whole). */
  edited: number;
}

// Refusals the review routes name: a library open read-only (409 READ_ONLY, the queue too), a locked
// project (423); deciding: the project's rules (403 POLICY_DENIED), an entry already decided (409 CONFLICT).
