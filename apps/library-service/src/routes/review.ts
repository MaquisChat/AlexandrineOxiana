/**
 * The review queue (spec 5.4, R172): the project's whole queue (every pending entry of every kind,
 * Task 67); decide one import entry, with or without a batch, or edit several at once; record that
 * a source flagged by a consent withdrawal was reviewed (R176 2).
 */
import type { FastifyInstance } from "fastify";
import { isId, type SourceDraft } from "@ao/core";
import {
  FindProjectStoppedError,
  FindRunnerClosedError,
  HeldFileSourceGoneError,
  NotFoundError,
  ReviewEntryDecidedError,
  lookUpStateOf,
  reviewCauseOf,
  type ListedReviewEntry,
  type LookUpAgainRefusal,
  type LookUpAgainResult,
  type LookUpState,
  type ReviewDecision,
  type ReviewPatch,
} from "@ao/library";
import {
  FIND_ROUTE_TEXT,
  HELD_FILE_DECISIONS,
  LIBRARY_CLOSED_TEXT,
  PROJECT_REVIEW_PAGE_MAX,
  REVIEW_DECISION_ACTIONS,
  WITHDRAWAL_REASON_MAX,
  reviewGroup,
  type ProjectReviewEntry,
  type ProjectReviewPage,
  type ReviewBulkEditRequest,
  type ReviewBulkEditResponse,
  type ReviewDecideRequest,
  type ReviewDecideResponse,
  type ReviewDecisionAction,
  type ReviewDraft,
  type ReviewEntryDecision,
  type ReviewEntryPatch,
  type ReviewLookUp,
  type ReviewLookUpAgainRequest,
  type ReviewLookUpAgainResponse,
  type ReviewLookUpOutcome,
  type ReviewLookUpState,
  type HeldFileDecision,
  type HeldFileDecisionRequest,
  type HeldFileDecisionResponse,
  type HeldFileRefusalReason,
  type ReviewHeldFile,
  type WithdrawalReviewedRequest,
  type WithdrawalReviewedResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyAs, intParam, optObj, paramsOf, projectParam, queryOf, str, strArray, type BodyOf, type Ctx, type Same } from "./util.js";

/**
 * Decision 31 (c) (R566 8, R577 iii): what the page needs to offer "Look up again", from the entry's left-out lookups —
 * the state (the library's `lookUpStateOf`), the tries, whether the researcher's act may send now and, when not yet, the
 * earliest time it may. A lookup may be asked by hand while it has no final answer ("found", "nothing") and its service's
 * named time has passed (the rule of the library's act, `askableByHand`, which is not exported). Never a title or an
 * identifier. Absent when nothing was left out.
 */
function lookUpOut(e: ListedReviewEntry, now: number): ReviewLookUp | undefined {
  const v = lookUpStateOf(e);
  if (!v) return undefined;
  const open = (e.leftOut ?? []).filter((l) => l.outcome !== "found" && l.outcome !== "nothing");
  const at = (l: { notBefore?: string }) => (l.notBefore ? Date.parse(l.notBefore) : Number.NaN);
  const canLookUpNow = open.some((l) => !(at(l) > now));
  const later = canLookUpNow ? [] : open.map((l) => l.notBefore!).sort();
  return { state: v.state, tries: v.tries, canLookUpNow, ...(later.length ? { notBefore: later[0]! } : {}) };
}

/** What the queue sends of an entry (only pending entries are listed). */
function entryOut(e: ListedReviewEntry, now: number): ProjectReviewEntry {
  const lookUp = lookUpOut(e, now);
  // The cause as the library reads it (recorded, or inferred for an older entry: reviewCauseOf, R176 3).
  const read = reviewCauseOf(e);
  // A held file's cause is sent without the file's place in the project (F11): the screen needs only the entry.
  const cause: ProjectReviewEntry["cause"] = read?.kind === "acquired-file-mismatch" ? { kind: read.kind, findEntryId: read.findEntryId } : read;
  return {
    id: e.id,
    projectId: e.projectId,
    sourceId: e.sourceId!,
    kind: e.kind,
    group: reviewGroup({ kind: e.kind, batchId: e.batchId, cause }),
    ...(cause ? { cause } : {}),
    status: "pending",
    createdAt: e.createdAt,
    fields: e.fields ?? {},
    reasons: e.reasons ?? [],
    ...(e.title ? { title: e.title } : {}),
    ...(e.batchId ? { batchId: e.batchId } : {}),
    ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
    ...(e.method ? { method: e.method } : {}),
    ...(e.candidates?.length ? { candidates: e.candidates } : {}),
    ...(e.duplicateOf ? { duplicateOf: e.duplicateOf } : {}),
    ...(e.hints?.length ? { hints: e.hints } : {}),
    ...(e.heldFile ? { heldFile: heldFileOut(e.heldFile) } : {}),
    ...(lookUp ? { lookUp } : {}),
  };
}

/** What the check found about a held file (F11, R277 d): the evidence only, never how it was got (its address). */
function heldFileOut(h: NonNullable<ListedReviewEntry["heldFile"]>): ReviewHeldFile {
  return {
    why: h.why,
    kind: h.kind,
    bytes: h.bytes,
    ...(h.fileDoi ? { fileDoi: h.fileDoi } : {}),
    ...(h.embeddedTitle ? { embeddedTitle: h.embeddedTitle } : {}),
    ...(h.textStart ? { textStart: h.textStart } : {}),
  };
}

// The library's decisions are exactly the shared list (a change to either fails here).
true satisfies Same<ReviewDecision["action"], ReviewDecisionAction>;
// Every decision but `accept` is the same on both sides; `accept`'s draft and the patch's `type` are
// narrower in the library (SourceDraft, SourceType), which validates them (F4): the rest is tied here.
true satisfies Same<Exclude<ReviewDecision, { action: "accept" }>, Exclude<ReviewEntryDecision, { action: "accept" }>>;
true satisfies Same<Omit<ReviewPatch, "type">, Omit<ReviewEntryPatch, "type">>;
true satisfies Same<keyof ReviewPatch, keyof ReviewEntryPatch>;
// Decision 31 (c): the look-up states the page is told are the library's.
true satisfies Same<LookUpState, ReviewLookUpState>;
// Every key of the accept decision's draft is one the library's SourceDraft reads: the library skips
// a key it does not know, so a renamed key would drop the researcher's correction silently (I2).
true satisfies ([keyof ReviewDraft] extends [keyof SourceDraft] ? true : false);
const ACTIONS: ReadonlySet<string> = new Set(REVIEW_DECISION_ACTIONS);

/** The project of a review item: named in the body (review ids are per project). */
function projectOf(ctx: Ctx, b: BodyOf<ReviewDecideRequest | ReviewBulkEditRequest | WithdrawalReviewedRequest | HeldFileDecisionRequest | ReviewLookUpAgainRequest>): string {
  const s = ctx.state.requireWritable();
  const projectId = str(b, "projectId", 64);
  if (!s.repo.listProjects().some((p) => p.id === projectId)) throw badRequest("That project is not in this library.");
  return projectId;
}

export function registerReview(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  // The project's whole queue, oldest first, a page at a time (R172). A locked project is refused
  // before its queue is read, and the refusal says nothing about it (R96).
  app.get("/projects/:id/review", async (req): Promise<ProjectReviewPage> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const q = queryOf(req);
    const offset = intParam(q.offset, "offset", 0, 10_000_000, 0);
    const limit = intParam(q.limit, "limit", 0, PROJECT_REVIEW_PAGE_MAX, 500);
    const source = q.source || undefined;
    if (source !== undefined && !isId(source)) throw badRequest('"source" must be a source id.');
    if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    const r = await s.bulk.listProjectReview(projectId, { offset, limit, ...(source ? { sourceId: source } : {}) });
    const now = state.now().getTime();
    return { items: r.items.map((e) => entryOut(e, now)), total: r.total, offset, limit };
  });

  app.post("/review/:itemId/decide", async (req): Promise<ReviewDecideResponse> => {
    const s = state.requireWritable();
    const b = bodyAs<ReviewDecideRequest>(req);
    const projectId = projectOf(ctx, b);
    const decision = optObj(b, "decision") as BodyOf<ReviewEntryDecision> | undefined;
    if (!decision || typeof decision.action !== "string" || !ACTIONS.has(decision.action)) {
      throw badRequest(`"decision.action" must be one of: ${[...ACTIONS].join(", ")}.`);
    }
    await s.bulk.decideReview(projectId, paramsOf(req).itemId ?? "", decision as unknown as ReviewDecision);
    state.publishState();
    return { decided: true };
  });

  // "Reviewed after the withdrawal" (R176 2): the library's own decision, its own policy operation
  // (a blank reason is refused by the engine and audited). A locked project is refused before
  // anything is read; a second decision on the same entry is a conflict.
  app.post("/review/:itemId/reviewed-after-withdrawal", async (req): Promise<WithdrawalReviewedResponse> => {
    const s = state.requireWritable();
    const b = bodyAs<WithdrawalReviewedRequest>(req);
    const projectId = projectOf(ctx, b);
    if (typeof b.reason !== "string") throw badRequest('"reason" is required: say, in your own words, what you decided after the withdrawal.');
    if (b.reason.length > WITHDRAWAL_REASON_MAX) throw badRequest(`"reason" is too long (at most ${WITHDRAWAL_REASON_MAX} characters).`);
    const e = await s.repo.reviewedAfterWithdrawal(projectId, paramsOf(req).itemId ?? "", b.reason);
    state.publishState();
    return { entry: { id: e.id, sourceId: e.sourceId!, status: "resolved", decision: "reviewed-after-withdrawal", resolvedAt: e.resolvedAt!, reason: e.reason! } };
  });

  // F11 (R277): "Use this file" / "Not this file" on a file Find and acquire held for its record. The runner's own act
  // (one governed change, refused after its stop or close); a locked project is refused before anything is read.
  app.post("/review/:itemId/held-file", async (req): Promise<HeldFileDecisionResponse> => {
    const s = state.requireWritable();
    const b = bodyAs<HeldFileDecisionRequest>(req);
    const projectId = projectOf(ctx, b);
    const decision = b.decision;
    if (typeof decision !== "string" || !(HELD_FILE_DECISIONS as readonly string[]).includes(decision)) throw badRequest('"decision" must be "attach" or "discard".');
    if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    const runner = s.find;
    if (!runner) throw new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed);
    try {
      await runner.resolveHeld(projectId, paramsOf(req).itemId ?? "", decision as HeldFileDecision);
    } catch (err) {
      if (err instanceof FindRunnerClosedError) throw new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed);
      // R282 d: every 409 says why in its reason; only "already-decided" means the entry is no longer waiting.
      const conflict = (message: string, reason: HeldFileRefusalReason) => new ApiError(409, "CONFLICT", message, reason);
      if (err instanceof FindProjectStoppedError) throw conflict(FIND_ROUTE_TEXT.projectStopped, "paused");
      if (err instanceof ReviewEntryDecidedError) throw conflict(err.message, "already-decided");
      if (err instanceof HeldFileSourceGoneError) throw conflict(err.message, "source-gone");
      throw err;
    }
    // R296 d, R305 b: the runner's `resolveHeld` itself wakes the project's entries waiting for a place (and only
    // those: nothing in flight is restarted), so no project-wide resume here.
    state.publishState();
    return { decided: true };
  });

  // Decision 31 (c), "Look up again" (R566, R577): the researcher's act, its OWN route (not a decision act: the older
  // build must not meet a new act in the list it knows). Only the entry's left-out lookups are asked, of only the services
  // left out; what is found is appended to the entry's candidates; nothing of the record changes. Before the service's
  // named time nothing is sent and the answer says "not yet" (200: the act was understood and the entry is answered as
  // it stands, like the other answers that are not refusals). A locked project is refused before anything is read.
  app.post("/review/:itemId/look-up-again", async (req): Promise<ReviewLookUpAgainResponse> => {
    const s = state.requireWritable();
    const b = bodyAs<ReviewLookUpAgainRequest>(req);
    const projectId = projectOf(ctx, b);
    const itemId = paramsOf(req).itemId ?? "";
    if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    const r = await state.lookUpAgainByHand(s, projectId, itemId);
    const outcome = lookUpOutcome(r, itemId);
    // The entry as the queue lists it now (decided or its source removed meanwhile: it is no longer waiting).
    const listed = (await s.bulk.listProjectReview(projectId, r.done ? { sourceId: r.sourceId } : {})).items.find((e) => e.id === itemId);
    if (!listed) throw new ApiError(409, "CONFLICT", ALREADY_REVIEWED);
    const entry = entryOut(listed, state.now().getTime());
    // Not yet: the time is the one the act met (the service's, or the lookup client's own hold of it).
    if (outcome.kind === "not-yet") entry.lookUp = { ...(entry.lookUp ?? { state: "waiting", tries: 0 }), canLookUpNow: false, notBefore: outcome.notBefore };
    state.publishState();
    return { outcome, entry };
  });

  app.post("/review/bulk-edit", async (req): Promise<ReviewBulkEditResponse> => {
    const s = state.requireWritable();
    const b = bodyAs<ReviewBulkEditRequest>(req);
    const projectId = projectOf(ctx, b);
    const itemIds = strArray(b, "itemIds", { max: 10_000, itemMax: 64 });
    const patch = optObj(b, "patch");
    if (!patch) throw badRequest('"patch" is required.');
    await s.bulk.bulkEditReview(projectId, itemIds, patch as ReviewPatch);
    return { edited: itemIds.length };
  });
}

/** The decide route's own sentence for an entry no longer waiting (BatchRefusedError "finished"). */
const ALREADY_REVIEWED = "This item has already been reviewed.";

/** What the researcher's look-up did, or the refusal the other review routes give for the same state. */
function lookUpOutcome(r: LookUpAgainResult, itemId: string): ReviewLookUpOutcome {
  if (r.done) {
    if (r.found > 0) return { kind: "found", found: r.found };
    // Nothing was asked: the rules no longer allow any of what was left to ask.
    if (r.asked === 0 && r.notAllowed > 0) return { kind: "not-allowed" };
    switch (r.state?.state) {
      case "waiting":
      case "gave-up":
        return { kind: "asked-to-wait", ...(r.state.notBefore ? { notBefore: r.state.notBefore } : {}) };
      case "failed":
        return { kind: "failed" };
      default:
        return { kind: "nothing" };
    }
  }
  switch (r.why as LookUpAgainRefusal | "not-yet") {
    case "not-yet":
      return { kind: "not-yet", notBefore: (r as { notBefore: string }).notBefore };
    case "nothing-to-look-up":
      return { kind: "nothing-to-look-up" };
    case "not-found":
      throw new NotFoundError("Review item", itemId);
    case "decided":
    case "source-removed":
    case "dropped":
      throw new ApiError(409, "CONFLICT", ALREADY_REVIEWED);
    case "locked":
      throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    case "read-only":
      throw new ApiError(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.");
    case "closing":
    case "cancelled":
      throw new ApiError(409, "LIBRARY_CLOSED", LIBRARY_CLOSED_TEXT);
    case "not-due":
      // Only the automatic pass is answered so; the researcher's act never is.
      return { kind: "nothing-to-look-up" };
    default:
      // R585 (3): "a look-up of this entry is already under way" (nothing sent, nothing written), and any other "nothing
      // done" this build does not know yet: the entry is answered as it stands, never as an error.
      return { kind: "under-way" };
  }
}
