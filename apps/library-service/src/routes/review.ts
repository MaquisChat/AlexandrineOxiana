/** Import review queue (spec 5.4): decide one item, or edit several at once. */
import type { FastifyInstance } from "fastify";
import type { ReviewDecision, ReviewPatch } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optObj, paramsOf, str, strArray, type Ctx } from "./util.js";

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
