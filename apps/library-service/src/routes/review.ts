/**
 * The review queue (spec 5.4, R172): the project's whole queue (every pending entry of every kind,
 * Task 67); decide one import entry, with or without a batch, or edit several at once; record that
 * a source flagged by a consent withdrawal was reviewed (R176 2).
 */
import type { FastifyInstance } from "fastify";
import { isId } from "@ao/core";
import { reviewCauseOf, type ListedReviewEntry, type ReviewDecision, type ReviewPatch } from "@ao/library";
import {
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
  type WithdrawalReviewedRequest,
  type WithdrawalReviewedResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyOf, intParam, optObj, paramsOf, projectParam, queryOf, str, strArray, type Ctx, type Same } from "./util.js";

/** What the queue sends of an entry (only pending entries are listed). */
function entryOut(e: ListedReviewEntry): ProjectReviewEntry {
  // The cause as the library reads it (recorded, or inferred for an older entry: reviewCauseOf, R176 3).
  const cause = reviewCauseOf(e);
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
  };
}

// The library's decisions are exactly the shared list (a change to either fails here).
true satisfies Same<ReviewDecision["action"], ReviewDecisionAction>;
const ACTIONS: ReadonlySet<string> = new Set(REVIEW_DECISION_ACTIONS);

/** The project of a review item: named in the body (review ids are per project). */
function projectOf(ctx: Ctx, b: Record<string, unknown>): string {
  const s = ctx.state.requireWritable();
  const projectId = str(b, "projectId" satisfies keyof (ReviewDecideRequest | ReviewBulkEditRequest | WithdrawalReviewedRequest), 64);
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
    return { items: r.items.map(entryOut), total: r.total, offset, limit };
  });

  app.post("/review/:itemId/decide", async (req): Promise<ReviewDecideResponse> => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = projectOf(ctx, b);
    const decision = optObj(b, "decision" satisfies keyof ReviewDecideRequest);
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
    const b = bodyOf(req);
    const projectId = projectOf(ctx, b);
    if (typeof b.reason !== "string") throw badRequest('"reason" is required: say, in your own words, what you decided after the withdrawal.');
    if (b.reason.length > WITHDRAWAL_REASON_MAX) throw badRequest(`"reason" is too long (at most ${WITHDRAWAL_REASON_MAX} characters).`);
    const e = await s.repo.reviewedAfterWithdrawal(projectId, paramsOf(req).itemId ?? "", b.reason);
    state.publishState();
    return { entry: { id: e.id, sourceId: e.sourceId!, status: "resolved", decision: "reviewed-after-withdrawal", resolvedAt: e.resolvedAt!, reason: e.reason! } };
  });

  app.post("/review/bulk-edit", async (req): Promise<ReviewBulkEditResponse> => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = projectOf(ctx, b);
    const itemIds = strArray(b, "itemIds" satisfies keyof ReviewBulkEditRequest, { max: 10_000, itemMax: 64 });
    const patch = optObj(b, "patch" satisfies keyof ReviewBulkEditRequest);

    if (!patch) throw badRequest('"patch" is required.');
    await s.bulk.bulkEditReview(projectId, itemIds, patch as ReviewPatch);
    return { edited: itemIds.length };
  });
}
