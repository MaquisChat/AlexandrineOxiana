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

import { FIND_REASON_TEXT } from "./find.js";

/**
 * What queued a verification entry (R176 3). A capture-conflict entry written when a later check
 * added data to an existing source records `foundBy: "later-check"` (R190).
 */
export type ReviewCause =
  | { kind: "capture-conflict"; foundBy?: "later-check" }
  | { kind: "consent-withdrawal"; consentIds: string[] }
  /**
   * Find and acquire (F11, R277; R296 a): a file found for the source's record, held for the researcher — every found
   * file, whether the check matched it ("looks-right") or not (the kind's name is the one stored since F11).
   */
  | { kind: "acquired-file-mismatch"; findEntryId: string };

/**
 * Where an entry came from, so a person can tell entries apart:
 * - `import`: an item of an import batch (`batchId` names it);
 * - `attach`: a file added by hand (drag and drop), an import entry with no batch;
 * - `capture`: a capture saved with fields that need review;
 * - `withdrawal`: a source flagged because a participant's consent was withdrawn;
 * - `found-file`: a file Find and acquire found for the record, waiting for the researcher's check (F11; R296 a).
 */
export type ReviewGroup = "import" | "attach" | "capture" | "withdrawal" | "found-file";

/**
 * The group of an entry, from its kind, batch and cause. The cause of a verification entry is the
 * library's (`reviewCauseOf`: recorded on the entry, or inferred there for entries queued before
 * causes were recorded); this function never guesses it.
 */
export function reviewGroup(e: { kind: string; batchId?: string | undefined; cause?: ReviewCause | undefined }): ReviewGroup {
  if (e.kind === "import") return e.batchId ? "import" : "attach";
  if (e.cause?.kind === "acquired-file-mismatch") return "found-file";
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
  /** Cause "acquired-file-mismatch" (F11): what the check found about the held file, for the researcher to judge by. */
  heldFile?: ReviewHeldFile;
  /**
   * Decision 31 (c), "Look up again" (R566, R577): an import entry with lookups left out (a service asked to wait, or the
   * lookup failed outright). Absent for an entry with nothing left out. Holds no title and no identifier: the entry's
   * `reasons` already carry the state's sentence (the library writes it there).
   */
  lookUp?: ReviewLookUp;
}

/** The look-up state of an entry (the library's `lookUpStateOf`): see `ReviewLookUp`. */
export type ReviewLookUpState = "waiting" | "found" | "nothing" | "not-allowed" | "gave-up" | "failed";

/**
 * What the page needs to offer "Look up again" (R577): the state; the tries made so far (the most of any lookup); whether
 * the researcher's act may send now; and, when it may not yet, the earliest time it may (the service's named time, R411,
 * R577 iii). `canLookUpNow` false with no `notBefore`: nothing is left to look up (every lookup has its answer).
 */
export interface ReviewLookUp {
  state: ReviewLookUpState;
  /** The app's own automatic tries (R585 M3: the researcher's presses are not counted); never "times asked". */
  tries: number;
  canLookUpNow: boolean;
  notBefore?: string;
  /**
   * R585 M3, R592: every OTHER state true of the entry besides `state` (never "failed"), in the order of the entry's
   * sentences (found, waiting, nothing, not-allowed, gave-up). Present only in a mix.
   */
  also?: Array<Exclude<ReviewLookUpState, "failed">>;
  /** With "gave-up" in `also`: the tries of the lookups the app gave up on (the given-up sentence's {n}). */
  gaveUpTries?: number;
  /**
   * R600 I3: a lookup that failed outright is still unanswered, whatever `state` says: the page says R577's "Not looked
   * up: a lookup service could not be reached. You can use Look up again." Absent otherwise.
   */
  failed?: true;
}

/**
 * What the file check said of a held file: why it did not clearly match its record, or (R296 b) "looks-right" — the
 * check matched it; advice only, every found file waits for the researcher.
 */
export type HeldFileWhy = "other-doi" | "title-absent" | "no-text" | "other-version" | "other-kind" | "looks-right";

/**
 * What the check found about a held file (R277 d). Every string is outside text (from the file), bounded by the
 * library (at most 300 characters each) and shown only through UserText. Nothing of the file's address is sent.
 */
export interface ReviewHeldFile {
  why: HeldFileWhy;
  kind: "pdf" | "epub";
  /** The file's size in bytes. */
  bytes: number;
  /** The DOI the file presents as its own, when it is not the record's. */
  fileDoi?: string;
  /** The title embedded in the file. */
  embeddedTitle?: string;
  /** The first characters of the file's text (at most 300). */
  textStart?: string;
}

/** The review entry's own sentence for a held file the check did not match (R277 d). */
export const HELD_FILE_REVIEW_TEXT = "A file was found for this record, but it did not clearly match.";
/** R296 b: the review entry's own sentence for a held file the check matched (advice: it still waits for the researcher). */
export const HELD_FILE_LOOKS_RIGHT_TEXT = "A file was found for this record. It looks like the right file: its first page shows the record's title with the author directly below.";
/** The review entry's own sentence for a held file, by what the check said of it (the library records it as the entry's reason). */
export const heldFileReviewText = (why: HeldFileWhy): string => (why === "looks-right" ? HELD_FILE_LOOKS_RIGHT_TEXT : HELD_FILE_REVIEW_TEXT);

/** What the check said of a held file, in words: the find queue's sentence for the same code (`file-<why>`), declared once there. */
export const HELD_FILE_WHY_TEXT: Record<HeldFileWhy, string> = {
  "other-doi": "The file names another DOI as its own.",
  "title-absent": "The file does not show this record's title with its author.",
  "no-text": "The file has no text that could be read (a scan, or a damaged file).",
  "other-version": "The file seems to be another volume, part or edition of this work.",
  "other-kind": "The file looks like another kind of document (a review, a reply, a correction or a supplement), not the work itself.",
  "looks-right": FIND_REASON_TEXT["file-looks-right"],
};

/**
 * `POST /review/:itemId/held-file` (F11): the researcher's decision on a held file. "attach" ("Use this file") adds
 * it to the record's source as the file that was found (its record says what the check had said: "match" for a file
 * that looked right, else that the researcher accepted it after the check did not match it); a decision also wakes
 * the project's entries waiting for a place among the waiting files (R296 d);
 * "discard" ("Not this file") destroys the held copy. One governed change each. A second decision is 409 CONFLICT;
 * the record no longer in the library is 409 with the library's sentence; a locked project 423.
 */
export const HELD_FILE_DECISIONS = ["attach", "discard"] as const;
export type HeldFileDecision = (typeof HELD_FILE_DECISIONS)[number];
export interface HeldFileDecisionRequest {
  projectId: string;
  decision: HeldFileDecision;
}
export interface HeldFileDecisionResponse {
  decided: true;
}
/**
 * R282 d: the `reason` of a 409 refusal of a held-file decision. Only "already-decided" means the entry is no longer
 * waiting (the screen takes it away); "paused" (Find and acquire is stopped for the project now) and "source-gone"
 * (the record is no longer in the library) leave it waiting, with the service's sentence.
 */
export const HELD_FILE_REFUSAL_REASONS = ["already-decided", "paused", "source-gone"] as const;
export type HeldFileRefusalReason = (typeof HELD_FILE_REFUSAL_REASONS)[number];

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

// ---- "Look up again" (decision 31 (c); R566, R577) ----

/**
 * `POST /review/:itemId/look-up-again` with the project in the body: the researcher's act. Only the entry's left-out
 * lookups are asked, of only the services left out; what is found is appended to the entry's candidates and nothing of
 * the record changes until a candidate is accepted with the existing decision. Its own route, not a decision act.
 *
 * Answered 200 with what happened and the entry as the queue lists it afterwards — also when nothing could be sent yet
 * ("not-yet": the service's named time has not come; nothing was sent) and when every lookup already has its answer
 * ("nothing-to-look-up"). Refused as the other review routes refuse: a read-only library 409 READ_ONLY, a locked project
 * 423 PROJECT_LOCKED, an entry not in the queue 404 NOT_FOUND, an entry already decided (or its source removed) 409
 * CONFLICT, a library that is closing 409 LIBRARY_CLOSED, the project's rules refusing the send 403 POLICY_DENIED.
 */
export interface ReviewLookUpAgainRequest {
  projectId: string;
  /** R600 m4: the entry's source, so that the answer reads only that source's entries (the whole queue without it). */
  sourceId?: string;
}

export type ReviewLookUpOutcome =
  /** `found` matches were appended to the entry's candidates. */
  | { kind: "found"; found: number }
  /** The services answered, with no new match. */
  | { kind: "nothing" }
  /** The project's rules no longer allow the lookup: nothing was asked. */
  | { kind: "not-allowed" }
  /** A service asked to wait again: it may be asked from `notBefore` on. */
  | { kind: "asked-to-wait"; notBefore?: string }
  /** The services could not be reached. */
  | { kind: "failed" }
  /** Nothing was sent: the service's named time has not come (R411, R577 iii). */
  | { kind: "not-yet"; notBefore: string }
  /** Every lookup of the entry already has its answer: nothing was sent. */
  | { kind: "nothing-to-look-up" }
  /**
   * A look-up of this entry is already under way (R585 3): nothing was sent or written by this request; the entry is
   * answered as it stands. Also the answer to any other "nothing done" the library may give that this build does not know.
   */
  | { kind: "under-way" };

export interface ReviewLookUpAgainResponse {
  outcome: ReviewLookUpOutcome;
  entry: ProjectReviewEntry;
}

// Refusals the review routes name: a library open read-only (409 READ_ONLY, the queue too), a locked
// project (423); deciding: the project's rules (403 POLICY_DENIED), an entry already decided (409 CONFLICT).
