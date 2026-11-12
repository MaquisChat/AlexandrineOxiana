/**
 * The review queue (spec 5.4, R172): the project's whole queue (every pending entry of every kind,
 * Task 67); decide one import entry, with or without a batch, or edit several at once.
 */
import type { FastifyInstance } from "fastify";
import type { ListedReviewEntry, ReviewDecision, ReviewPatch } from "@ao/library";
import { PROJECT_REVIEW_PAGE_MAX, reviewGroup, type ProjectReviewEntry, type ProjectReviewPage } from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyOf, intParam, optObj, paramsOf, projectParam, queryOf, str, strArray, type Ctx } from "./util.js";

/** What the queue sends of an entry (only pending entries are listed). */
function entryOut(e: ListedReviewEntry): ProjectReviewEntry {
  return {
    id: e.id,
    projectId: e.projectId,
    sourceId: e.sourceId!,
    kind: e.kind,
    group: reviewGroup(e),
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

const ACTIONS = new Set(["accept", "accept-candidate", "merge", "skip", "keep-both"]);

/** The project of a review item: named in the body (review ids are per project). */
function projectOf(ctx: Ctx, b: Record<string, unknown>): string {
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
    const source = q.source ? q.source.slice(0, 64) : undefined;
    if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    const r = await s.bulk.listProjectReview(projectId, { offset, limit, ...(source ? { sourceId: source } : {}) });
    return { items: r.items.map(entryOut), total: r.total, offset, limit };
  });

  app.post("/review/:itemId/decide", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = projectOf(ctx, b);
    const decision = optObj(b, "decision");
    if (!decision || typeof decision.action !== "string" || !ACTIONS.has(decision.action)) {
      throw badRequest(`"decision.action" must be one of: ${[...ACTIONS].join(", ")}.`);
    }
    await s.bulk.decideReview(projectId, paramsOf(req).itemId ?? "", decision as unknown as ReviewDecision);
    state.publishState();
    return { decided: true };
  });

  app.post("/review/bulk-edit", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = projectOf(ctx, b);
    const itemIds = strArray(b, "itemIds", { max: 10_000, itemMax: 64 });
    const patch = optObj(b, "patch");
    if (!patch) throw badRequest('"patch" is required.');
    await s.bulk.bulkEditReview(projectId, itemIds, patch as ReviewPatch);
    return { edited: itemIds.length };
  });
}
