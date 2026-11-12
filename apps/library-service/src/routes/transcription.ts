/**
 * Transcription of a source as a job (Task 62, R99, R142; spec 5.2): registered from capture.ts,
 * where the transcribe route was.
 *
 *   POST /projects/:id/sources/:sid/transcribe       202 { job } at once (TranscriptionJobResponse)
 *   GET  /projects/:id/sources/:sid/transcription    { job | null }: the newest transcription of the source
 *   POST /projects/:id/transcriptions/:jobId/cancel  { job }
 *
 * Progress and every change of status arrive as `job.progress` events of kind `transcription`
 * (transcriptions.ts). A second transcription of a source while one is queued or running, or
 * still pending in the journal, is 409 CONFLICT with reason TRANSCRIPTION_RUNNING. A speech model
 * the optional tools list shows as not installed is 409 TOOL_NOT_INSTALLED with the tool's id, as
 * before; a job the worker refuses for a missing tool fails with the same code and id.
 */
import type { FastifyInstance } from "fastify";
import { DEFAULT_SPEECH_MODEL, SPEECH_MODELS, speechToolId, type TranscriptionJobResponse } from "@ao/shared";
import { ProjectLockedError, cancelPendingJob, transcriptionRecords } from "@ao/library";
import { ApiError, badRequest, notFound } from "../errors.js";
import { busyError, fromRecord } from "../transcriptions.js";
import type { Session } from "../state.js";
import { bodyOf, optStr, paramsOf, projectParam, type Ctx } from "./util.js";

const MODELS: readonly string[] = SPEECH_MODELS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function registerTranscription(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  /** The source's newest transcription: the one this run holds, else the journal's newest record. */
  async function newest(s: Session, projectId: string, sourceId: string): Promise<TranscriptionJobResponse["job"]> {
    const live = state.transcriptions.current(projectId, sourceId, s.lib);
    if (live) return live;
    const rec = (await transcriptionRecords(s.repo, projectId, sourceId)).at(-1);
    return rec ? fromRecord(rec) : null;
  }

  /** The speech model is installed, as far as the optional tools list knows (409 TOOL_NOT_INSTALLED when it says not). */
  async function requireModel(model: string): Promise<void> {
    const tools = (await state.ensureWorker()).tools;
    if (!tools) return;
    const cat = await tools.catalogue<{ tools?: Array<{ id?: unknown; installed?: unknown }> }>().catch(() => undefined);
    const id = speechToolId(model as (typeof SPEECH_MODELS)[number]);
    const t = cat?.tools?.find((x) => x.id === id);
    if (t && t.installed === false) {
      throw new ApiError(409, "TOOL_NOT_INSTALLED", "A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.", id);
    }
  }

  app.post("/projects/:id/sources/:sid/transcribe", async (req, reply) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
    const b = bodyOf(req);
    const model = optStr(b, "model", 16);
    if (model !== undefined && !MODELS.includes(model)) throw badRequest(`"${model}" is not a transcription model.`);
    const language = optStr(b, "language", 16);
    if (language !== undefined && language !== "auto" && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) throw badRequest(`"${language}" is not a language code.`);
    // One step with the registration: the source is taken before anything is awaited.
    const { token, release } = state.transcriptions.reserve(projectId, sid);
    try {
      // A transcription still pending in the journal runs again by itself (at the next open, at an unlock).
      const pending = (await transcriptionRecords(s.repo, projectId, sid)).some((r) => r.status === "queued" || r.status === "running" || (r.status === "cancelled" && r.error === "PROJECT_LOCKED"));
      if (pending) throw busyError();
      const client = await state.workerClient(); // 503 when the media helper cannot run
      await requireModel(model ?? DEFAULT_SPEECH_MODEL);
      const job = await state.transcriptions.start(state.requireWritable(), client, projectId, sid, { ...(model ? { model } : {}), ...(language ? { language } : {}) }, token);
      release(); // the job holds the source now
      return reply.status(202).send({ job } satisfies TranscriptionJobResponse);
    } catch (err) {
      release();
      throw err;
    }
  });

  app.get("/projects/:id/sources/:sid/transcription", async (req): Promise<TranscriptionJobResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
    if (!s.repo.isUnlocked(projectId)) throw new ProjectLockedError(projectId); // nothing of a locked project is shown
    return { job: await newest(s, projectId, sid) };
  });

  app.post("/projects/:id/transcriptions/:jobId/cancel", async (req): Promise<TranscriptionJobResponse> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const jobId = paramsOf(req).jobId ?? "";
    if (!UUID.test(jobId)) throw notFound("That transcription");
    if (!s.repo.isUnlocked(projectId)) throw new ProjectLockedError(projectId);
    const held = state.transcriptions.byId(jobId, s.lib);
    if (held && held.projectId === projectId) {
      const cancelled = state.transcriptions.cancel(jobId, s.lib);
      if (cancelled) return { job: cancelled };
      // Held but not running (e.g. waiting for the unlock, R1-3): the journal's pending record is
      // cancelled below, and its state read from there.
      state.transcriptions.forgetJob(jobId);
    }
    // Pending in the journal and run by no one now (before a restart's rerun, or cancelled by a lock).
    const find = async () => (await transcriptionRecords(s.repo, projectId)).find((r) => r.id === jobId);
    if (!(await find())) throw notFound("That transcription");
    await cancelPendingJob(s.repo, projectId, jobId, s.index);
    // A rerun may have taken it meanwhile: then it is held here and is asked to stop.
    const now = state.transcriptions.cancel(jobId, s.lib);
    if (now) return { job: now };
    const rec = await find();
    return { job: rec ? fromRecord(rec) : null };
  });
}
