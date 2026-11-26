/**
 * Download runs and the estimate (whole channels, R668, R669; shapes in @ao/shared api/background.ts):
 *
 *   POST /projects/:id/capture-estimate               CaptureEstimateRequest → CaptureEstimate
 *   GET  /projects/:id/downloads                      → DownloadRunListResponse
 *   GET  /projects/:id/downloads/:runId/problems      → DownloadProblemsResponse
 *   POST /projects/:id/downloads/:runId/pause         → DownloadRunResponse (not running: 409 CONFLICT)
 *   POST /projects/:id/downloads/:runId/stop          → DownloadRunResponse
 *   POST /projects/:id/downloads/:runId/resume        → DownloadRunResponse (held: 409 RUN_ALREADY_RUNNING; refused: 403)
 *   POST /projects/:id/downloads/:runId/discard       → DownloadRunDiscarded (held: 409 RUN_ALREADY_RUNNING)
 *
 * The desktop app only (none is an extension route, server.ts). A locked project answers 423 before
 * anything else: nothing of its runs is told while its key is gone (R30, R50). The runs themselves are
 * held by the service's DownloadRunner (downloads.ts); `capture-profile` (capture.ts) starts them.
 */
import type { FastifyInstance } from "fastify";
import { MAX_ADDRESS_LENGTH, classifyUrl } from "@ao/core";
import { WorkerJobError, checkCaptureAllowed } from "@ao/library";
import {
  estimateRateLimitedText,
  type CaptureEstimate,
  type CaptureEstimateRequest,
  type DownloadProblemsResponse,
  type DownloadRunDiscarded,
  type DownloadRunListResponse,
  type DownloadRunResponse,
  type ProfileCaptureRequestOptions,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { Session } from "../state.js";
import { profileRunOptions, requireAcknowledged, requireUnlocked } from "./capture.js";
import { bodyAs, optObj, paramsOf, projectParam, str, type BodyOf, type Ctx } from "./util.js";

/** A run id as the runner makes them (a UUID). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function registerDownloads(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  /** The session and the project, refused with 423 while it is locked, before anything else. */
  const unlocked = (req: Parameters<typeof projectParam>[1]): { s: Session; projectId: string } => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    return { s, projectId };
  };
  const runParam = (req: Parameters<typeof projectParam>[1]): string => {
    const runId = paramsOf(req).runId ?? "";
    if (!RUN_ID.test(runId)) throw new ApiError(404, "NOT_FOUND", "That download run was not found.");
    return runId;
  };

  app.post("/projects/:id/capture-estimate", async (req): Promise<CaptureEstimate> => {
    const { s, projectId } = unlocked(req);
    const b = bodyAs<CaptureEstimateRequest>(req);
    const url = str(b, "url", MAX_ADDRESS_LENGTH);
    const c = classifyUrl(url);
    if (c.platform === "other" || (c.kind !== "profile" && c.kind !== "playlist")) throw badRequest("That is not the link of a profile, channel or playlist on YouTube, Instagram or TikTok.");
    const opts = profileRunOptions(s, projectId, (optObj(b, "options") ?? {}) as BodyOf<ProfileCaptureRequestOptions>);
    // The project's rules first: a refusal is 403 with their reason (audited), and nothing is listed.
    await checkCaptureAllowed(s.repo, projectId, [url]);
    requireAcknowledged(s, projectId, opts);
    try {
      return await state.downloads.estimate(s, projectId, url, opts);
    } catch (err) {
      // The listing's own refusal by the rules is 403 and a missing tool 409 TOOL_NOT_INSTALLED with its id
      // (errors.ts); a slowed-down listing is said in plain words, naming the platform.
      if (err instanceof WorkerJobError && err.code === "RATE_LIMITED") throw new ApiError(429, "RATE_LIMITED", estimateRateLimitedText(c.platform), "RATE_LIMITED");
      throw err;
    }
  });

  app.get("/projects/:id/downloads", async (req): Promise<DownloadRunListResponse> => {
    const { s, projectId } = unlocked(req);
    return { runs: await state.downloads.list(s, projectId) };
  });

  app.get("/projects/:id/downloads/:runId/problems", async (req): Promise<DownloadProblemsResponse> => {
    const { s, projectId } = unlocked(req);
    return state.downloads.problems(s, projectId, runParam(req));
  });

  for (const what of ["pause", "stop"] as const) {
    app.post(`/projects/:id/downloads/:runId/${what}`, async (req): Promise<DownloadRunResponse> => {
      const { s, projectId } = unlocked(req);
      return { run: await state.downloads.request(s, projectId, runParam(req), what) };
    });
  }

  app.post("/projects/:id/downloads/:runId/resume", async (req): Promise<DownloadRunResponse> => {
    const { projectId } = unlocked(req);
    const s = state.requireWritable();
    return { run: await state.downloads.resume(s, projectId, runParam(req)) };
  });

  app.post("/projects/:id/downloads/:runId/discard", async (req): Promise<DownloadRunDiscarded> => {
    const { projectId } = unlocked(req);
    const s = state.requireWritable();
    await state.downloads.discard(s, projectId, runParam(req));
    return { discarded: true };
  });
}
