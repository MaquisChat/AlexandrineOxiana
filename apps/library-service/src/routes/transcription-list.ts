/**
 * The transcription list, "Transcribe everything without a transcript", the project's automatic transcription switch
 * and the background settings (whole channels, Task 7; shapes in @ao/shared api/background.ts):
 *
 *   GET  /projects/:id/transcription-list                     → TranscriptionListResponse
 *   POST /projects/:id/transcription-list/{pause|continue|stop} → TranscriptionListResponse
 *   GET  /projects/:id/untranscribed                          → UntranscribedResponse
 *   POST /projects/:id/transcription-list                     TranscribeAllRequest → TranscribeAllResponse
 *   GET | PUT /projects/:id/automation                        ProjectAutomation
 *   GET | PUT /settings/background                            BackgroundSettings (app setting file background.json)
 *
 * The desktop app only (none is an extension route, server.ts). The list's routes, `untranscribed` and the automation
 * GET answer a locked project 423 before anything else (R684, R692); the ones that change the list are `requireWritable` and publish
 * `background.progress { transcriptions }` before they answer (R679).
 */
import type { FastifyInstance } from "fastify";
import { AppSettingUnreadableError, addToTranscriptionList, readAppSettingStrict, setProjectAutomation, untranscribedSources, updateAppSettingStrict } from "@ao/library";
import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  speechToolId,
  type BackgroundSettings,
  type ProjectAutomation,
  type TranscribeAllRequest,
  type TranscribeAllResponse,
  type TranscriptionListResponse,
  type UntranscribedResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { Session } from "../state.js";
import { requireUnlocked } from "./capture.js";
import { bodyAs, bodyOf, optStr, projectParam, type Ctx } from "./util.js";

export const BACKGROUND_FILE = "background.json";
export const DEFAULT_BACKGROUND: BackgroundSettings = { keepAwake: true };
const MODELS: readonly string[] = SPEECH_MODELS;

export const isBackgroundFile = (v: unknown): v is BackgroundSettings =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { keepAwake?: unknown }).keepAwake === "boolean";

/** The background settings as stored; the defaults when the file is missing or cannot be read. */
export async function readBackgroundSettings(dir: string): Promise<BackgroundSettings> {
  try {
    const v = await readAppSettingStrict(dir, BACKGROUND_FILE, isBackgroundFile);
    return v ? { keepAwake: v.keepAwake } : DEFAULT_BACKGROUND;
  } catch (err) {
    if (err instanceof AppSettingUnreadableError) return DEFAULT_BACKGROUND;
    throw err;
  }
}

export function registerTranscriptionList(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  /** The session and the project, refused with 423 while it is locked, before anything else. */
  const unlocked = (req: Parameters<typeof projectParam>[1]): { s: Session; projectId: string } => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    return { s, projectId };
  };
  /** As `unlocked`, then a read-only library refuses (R684). */
  const writable = (req: Parameters<typeof projectParam>[1]): { s: Session; projectId: string } => {
    const { projectId } = unlocked(req);
    return { s: state.requireWritable(), projectId };
  };

  /** The speech model is installed, as far as the optional tools list knows (409 TOOL_NOT_INSTALLED when it says not). */
  async function requireModel(model: string): Promise<void> {
    const tools = (await state.ensureWorker().catch(() => undefined))?.tools;
    if (!tools) return; // not known: the job says so itself if it is missing
    const cat = await tools.catalogue<{ tools?: Array<{ id?: unknown; installed?: unknown }> }>().catch(() => undefined);
    const id = speechToolId(model as (typeof SPEECH_MODELS)[number]);
    const t = cat?.tools?.find((x) => x.id === id);
    if (t && t.installed === false) {
      throw new ApiError(409, "TOOL_NOT_INSTALLED", "A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.", id);
    }
  }

  app.get("/projects/:id/transcription-list", async (req): Promise<TranscriptionListResponse> => {
    const { s, projectId } = unlocked(req);
    return { list: await state.transcriptionList.summary(s, projectId) };
  });

  for (const what of ["pause", "continue", "stop"] as const) {
    app.post(`/projects/:id/transcription-list/${what}`, async (req): Promise<TranscriptionListResponse> => {
      const { s, projectId } = writable(req);
      return { list: await state.transcriptionList[what](s, projectId) };
    });
  }

  app.get("/projects/:id/untranscribed", async (req): Promise<UntranscribedResponse> => {
    const { s, projectId } = unlocked(req);
    const sources = await untranscribedSources(s.repo, projectId);
    return {
      count: sources.length,
      soundSeconds: sources.reduce((a, x) => a + (x.soundSec ?? 0), 0),
      unknownLengths: sources.filter((x) => x.soundSec === undefined).length,
    };
  });

  app.post("/projects/:id/transcription-list", async (req): Promise<TranscribeAllResponse> => {
    const { s, projectId } = writable(req);
    const model = optStr(bodyAs<TranscribeAllRequest>(req), "model", 16) ?? DEFAULT_SPEECH_MODEL;
    if (!MODELS.includes(model)) throw badRequest(`"${model}" is not a transcription model.`);
    await requireModel(model);
    const sources = await untranscribedSources(s.repo, projectId);
    // The project's rules are asked once (403 POLICY_DENIED with their reason, audited), even with nothing to add.
    const { added } = await addToTranscriptionList(s.repo, projectId, sources.map((x) => ({ sourceId: x.sourceId, model })));
    state.transcriptionList.kick(s, projectId);
    return { added, list: await state.transcriptionList.answer(s, projectId) };
  });

  app.get("/projects/:id/automation", async (req): Promise<ProjectAutomation> => {
    const { s, projectId } = unlocked(req); // 423 first, like the PUT (R692 I2)
    return { transcribeNewMedia: s.repo.getProject(projectId).automation?.transcribeNewMedia === true };
  });

  app.put("/projects/:id/automation", async (req): Promise<ProjectAutomation> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const v = bodyOf(req).transcribeNewMedia;
    if (typeof v !== "boolean") throw badRequest('"transcribeNewMedia" must be true or false.');
    const p = await setProjectAutomation(s.repo, projectId, { transcribeNewMedia: v });
    return { transcribeNewMedia: p.automation?.transcribeNewMedia === true };
  });

  const dir = state.deps.appConfigDir;

  app.get("/settings/background", async (): Promise<BackgroundSettings> => readBackgroundSettings(dir));

  app.put("/settings/background", async (req): Promise<BackgroundSettings> => {
    const v = bodyOf(req).keepAwake;
    if (typeof v !== "boolean") throw badRequest('"keepAwake" must be true or false.');
    // Only over what was read: a file that cannot be read refuses the change (Task 68).
    const next = await updateAppSettingStrict<BackgroundSettings>(dir, BACKGROUND_FILE, isBackgroundFile, (cur) => ({ ...(cur ?? DEFAULT_BACKGROUND), keepAwake: v }));
    state.setKeepAwakeSetting(next.keepAwake);
    return { keepAwake: next.keepAwake };
  });
}
