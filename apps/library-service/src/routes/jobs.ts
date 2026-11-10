/**
 * Background jobs (R96 carry-overs): viewing proxies and OCR that failed after their retries,
 * running imports, and retrying the failed ones.
 */
import type { FastifyInstance } from "fastify";
import { ocrQueueFor, proxyQueueFor } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optStr, queryOf, str, type Ctx } from "./util.js";

export function registerJobs(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/jobs", async (req) => {
    const s = state.requireSession();
    const want = queryOf(req).projectId;
    const ids = s.repo.listProjects().map((p) => p.id).filter((id) => !want || id === want);
    if (want && !ids.length) throw badRequest("That project is not in this library.");
    const proxyFailures = [];
    const ocrFailures = [];
    for (const id of ids) {
      if (!s.repo.isUnlocked(id)) continue;
      proxyFailures.push(...(await proxyQueueFor(s.repo).failures(id)));
      ocrFailures.push(...(await ocrQueueFor(s.repo).failures(id)));
    }
    return {
      workerReady: !!s.workerClient,
      imports: [...s.batches.entries()].filter(([, b]) => !want || b.projectId === want).map(([batchId, b]) => ({ batchId, projectId: b.projectId })),
      proxyFailures,
      ocrFailures,
    };
  });

  app.post("/jobs/retry", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = str(b, "projectId", 64);
    if (!s.repo.listProjects().some((p) => p.id === projectId)) throw badRequest("That project is not in this library.");
    const sourceId = optStr(b, "sourceId", 64);
    state.track(proxyQueueFor(s.repo).retryFailed(projectId, sourceId), "retrying viewing proxies");
    state.track(ocrQueueFor(s.repo).retryFailed(projectId, sourceId), "retrying OCR");
    return { retrying: true };
  });
}
