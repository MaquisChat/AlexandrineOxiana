/**
 * The optional tools (Task 48a, R126): the catalogue the first-use dialogue shows, and installing,
 * updating and removing a tool as a job with progress that can be cancelled and read again after
 * the interface reloads. Desktop app only: the UI token, from the shell's origin (or no origin).
 *
 * Downloads are done by the media worker into the app's tools and models folders, never into a
 * library, so none of this needs a library open, and none of it is library work (a move or a close
 * does not wait for it). After ffmpeg or OCR is installed, the open library's failed viewing copies
 * or OCR jobs are retried (they stayed "proxy pending", R83 / R90 c).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkerJobError, WorkerUnavailableError, ocrQueueFor, proxyQueueFor, scrubPaths, type WorkerToolsClient } from "@ao/library";
import { TOOL_ACTIONS, isToolId, type ToolAction, type ToolId, type ToolInfo, type ToolJob, type ToolJobResponse, type ToolsResponse } from "@ao/shared";
import { SHELL_ORIGINS } from "../auth.js";
import { ApiError, notFound } from "../errors.js";
import { paramsOf, type Ctx } from "./util.js";

/** Finished tool jobs kept for a reloaded interface (this run of the service only). */
const KEEP_FINISHED = 50;

/** Plain words for a failed tool job, by the worker's code. */
const MESSAGES: Record<string, string> = {
  TOOL_DOWNLOAD_FAILED: "The download did not finish. Check the internet connection, then try again.",
  TOOL_CHECKSUM_MISMATCH: "The downloaded file did not match its published checksum, so it was not installed. Try again later.",
  TOOL_ARCHIVE_UNSAFE: "The downloaded archive was not safe to unpack, so nothing was installed.",
  TOOL_WRITE_FAILED: "The tool could not be saved on this computer. Check that there is enough free disk space, then try again.",
  TOOL_UNUSABLE: "The tool was downloaded and checked, but it does not run on this computer, so it was not installed.",
  TOOL_NOT_MANAGED: "This tool was not installed by the app (it belongs to this computer), so it was left alone.",
  TOOL_UPDATE_FAILED: "The tool could not be updated. Try again later.",
  WORKER_UNAVAILABLE: "The media helper stopped before the job finished. Nothing was left half-installed; try again.",
};
const FALLBACK = "The tool job did not finish. Nothing was left half-installed; try again.";

interface Entry {
  job: ToolJob;
  ac: AbortController;
}

/** UI token only, and from the desktop shell when the request carries an origin (a page never). */
function requireShell(req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (req.caller !== "ui" || (origin !== undefined && !SHELL_ORIGINS.has(origin))) {
    throw new ApiError(403, "FORBIDDEN", "The tools are managed from the desktop app.");
  }
}

function errorOf(err: unknown, roots: Iterable<string>): NonNullable<ToolJob["error"]> {
  if (err instanceof WorkerUnavailableError) return { code: "WORKER_UNAVAILABLE", message: MESSAGES.WORKER_UNAVAILABLE! };
  if (err instanceof WorkerJobError) {
    // TOOL_UNAVAILABLE's message is the pinned reason (a fixed sentence from the worker's catalogue).
    const message = err.code === "TOOL_UNAVAILABLE" ? scrubPaths(err.message, roots) : (MESSAGES[err.code] ?? FALLBACK);
    return { code: err.code, message };
  }
  return { code: "FAILED", message: FALLBACK };
}

export function registerTools(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const jobs = new Map<string, Entry>();

  app.addHook("onClose", async () => {
    for (const e of jobs.values()) e.ac.abort();
  });

  async function toolsClient(): Promise<WorkerToolsClient> {
    const w = await state.ensureWorker(); // 503 WORKER_UNAVAILABLE when the media helper cannot run
    if (!w.tools) throw new ApiError(503, "WORKER_UNAVAILABLE", "This media helper cannot install tools.");
    return w.tools;
  }

  const publish = (job: ToolJob) => state.events.publish("job.progress", { kind: "tool", job: { ...job } });

  function prune(): void {
    const finished = [...jobs.values()].filter((e) => e.job.status !== "running");
    for (const e of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(e.job.jobId);
  }

  function running(toolId: ToolId): Entry | undefined {
    return [...jobs.values()].find((e) => e.job.toolId === toolId && e.job.status === "running");
  }

  /** After ffmpeg or OCR arrives: retry the open library's failed viewing copies / OCR (they stayed pending). */
  function retryWaitingWork(toolId: ToolId): void {
    const s = state.session;
    if (!s || s.lib.mode !== "read-write" || state.moving || !s.workerClient) return;
    if (toolId !== "ffmpeg" && toolId !== "ocr") return;
    void state.startWork("retry", async () => {
      for (const p of s.repo.listProjects()) {
        if (!s.repo.isUnlocked(p.id)) continue;
        if (toolId === "ffmpeg") await proxyQueueFor(s.repo).retryFailed(p.id);
        else await ocrQueueFor(s.repo).retryFailed(p.id);
      }
    });
  }

  function start(tools: WorkerToolsClient, toolId: ToolId, action: ToolAction): ToolJob {
    const job: ToolJob = { jobId: randomUUID(), toolId, action, status: "running", progress: 0, startedAt: new Date().toISOString() };
    const entry: Entry = { job, ac: new AbortController() };
    jobs.set(job.jobId, entry);
    prune();
    publish(job);
    void tools
      .run(action, toolId, {
        signal: entry.ac.signal,
        onProgress: (p) => {
          if (job.status !== "running" || p <= job.progress) return;
          job.progress = Math.min(1, p);
          publish(job);
        },
      })
      .then(
        (result) => {
          job.status = "done";
          job.progress = 1;
          job.result = pick(result);
          if (action !== "remove") retryWaitingWork(toolId);
        },
        (err: unknown) => {
          if ((err instanceof WorkerJobError && err.code === "CANCELLED") || entry.ac.signal.aborted) {
            job.status = "cancelled";
            return;
          }
          job.status = "failed";
          job.error = errorOf(err, state.roots);
        },
      )
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        publish(job);
      });
    return job;
  }

  app.get("/tools", async (req): Promise<ToolsResponse> => {
    requireShell(req);
    const tools = await toolsClient();
    const cat = await tools.catalogue<{ platform: string | null; tools: ToolInfo[] }>();
    const list = [...jobs.values()].map((e) => ({ ...e.job }));
    const latest = new Map<string, ToolJob>();
    for (const j of list) latest.set(j.toolId, j); // in start order: the last one wins
    return {
      platform: cat.platform ?? null,
      tools: (cat.tools ?? []).map((t) => (latest.has(t.id) ? { ...t, job: latest.get(t.id)! } : t)),
      jobs: list,
    };
  });

  app.post("/tools/:toolId/:action", async (req, reply): Promise<ToolJobResponse> => {
    requireShell(req);
    const { toolId = "", action = "" } = paramsOf(req);
    if (!isToolId(toolId)) throw notFound("That tool");
    if (!(TOOL_ACTIONS as readonly string[]).includes(action)) throw new ApiError(404, "NOT_FOUND", "There is no such route.");
    const busy = running(toolId);
    if (busy) {
      // A second click, or another window: the same job, not a second download.
      if (busy.job.action === action) return reply.status(202).send({ job: { ...busy.job } });
      throw new ApiError(409, "CONFLICT", "This tool is being changed already. Wait until that has finished.");
    }
    const tools = await toolsClient();
    const again = running(toolId); // another request may have started it while the helper started
    if (again) {
      if (again.job.action === action) return reply.status(202).send({ job: { ...again.job } });
      throw new ApiError(409, "CONFLICT", "This tool is being changed already. Wait until that has finished.");
    }
    return reply.status(202).send({ job: { ...start(tools, toolId, action as ToolAction) } });
  });

  app.get("/tools/jobs/:jobId", async (req): Promise<ToolJobResponse> => {
    requireShell(req);
    const e = jobs.get(paramsOf(req).jobId ?? "");
    if (!e) throw notFound("That tool job");
    return { job: { ...e.job } };
  });

  app.post("/tools/jobs/:jobId/cancel", async (req): Promise<ToolJobResponse> => {
    requireShell(req);
    const e = jobs.get(paramsOf(req).jobId ?? "");
    if (!e) throw notFound("That tool job");
    if (e.job.status === "running") e.ac.abort();
    return { job: { ...e.job } };
  });
}

function pick(r: Record<string, unknown>): ToolJob["result"] {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const out: NonNullable<ToolJob["result"]> = {};
  const installed = strings(r.installed);
  const removed = strings(r.removed);
  const skipped = strings(r.skipped);
  if (installed) out.installed = installed;
  if (removed) out.removed = removed;
  if (skipped) out.skipped = skipped;
  if (Array.isArray(r.updated)) {
    out.updated = r.updated
      .filter((u): u is Record<string, unknown> => !!u && typeof u === "object")
      .map((u) => ({ component: String(u.component ?? ""), old: typeof u.old === "string" ? u.old : null, new: typeof u.new === "string" ? u.new : null }));
  }
  return out;
}
