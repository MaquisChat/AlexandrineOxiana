/** The project's audit log: a page of events (newest first) and the integrity check (spec 3.10, R12). */
import type { FastifyInstance } from "fastify";
import { intParam, projectParam, queryOf, type Ctx } from "./util.js";

export function registerAudit(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/projects/:id/audit", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const q = queryOf(req);
    const limit = intParam(q.limit, "limit", 1, 1000, 100);
    const before = q.before === undefined ? undefined : intParam(q.before, "before", 0, Number.MAX_SAFE_INTEGER, 0);
    return s.repo.readAudit(projectId, { limit, ...(before !== undefined ? { beforeSeq: before } : {}) });
  });

  app.get("/projects/:id/audit/verify", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    return s.repo.verifyAudit(projectId);
  });
}
