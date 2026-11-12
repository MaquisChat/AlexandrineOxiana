/**
 * Background jobs (R96 carry-overs): viewing proxies and OCR that failed after their retries,
 * running imports, and retrying the failed ones.
 */
import type { FastifyInstance } from "fastify";
import { ocrQueueFor, proxyQueueFor } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optStr, queryOf, str, type Ctx } from "./util.js";

/**
 * The optional tool a failed viewing copy or OCR job is waiting for (Task 48a, R126): a video proxy
 * needs ffmpeg, OCR needs `ocr`. Such media stays "proxy pending" (R83, R90 c) and is retried when
 * the tool is installed.
 */
export function failureTool(type: string, code: string): string | undefined {
  if (code !== "TOOL_NOT_INSTALLED") return undefined;
  if (type === "video.proxy") return "ffmpeg";
  if (type === "ocr") return "ocr";
  return undefined;
}

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
      for (const f of await proxyQueueFor(s.repo).failures(id)) {
        const tool = failureTool(f.type, f.code);
        proxyFailures.push(tool ? { ...f, tool } : f);
      }
      for (const f of await ocrQueueFor(s.repo).failures(id)) {
        const tool = failureTool("ocr", f.code);
        ocrFailures.push(tool ? { ...f, tool } : f);
      }
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
    state.startWork("retry", async () => {
      await proxyQueueFor(s.repo).retryFailed(projectId, sourceId);
      await ocrQueueFor(s.repo).retryFailed(projectId, sourceId);
    });
    return { retrying: true };
  });
}
