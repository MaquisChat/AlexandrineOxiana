/**
 * Capture (spec 5.1, 5.5): links queued for the downloader (per-item outcomes as `capture.progress`
 * events), whole profiles, transcription of a source, the capture tools' versions and update, and
 * browser capture from the paired extension (its pairing too).
 *
 * The `capture` decision is evaluated before anything is queued, so a capture the project's rules
 * deny answers 403 POLICY_DENIED with the reason at once (the deny is audited).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  COOKIES_ACKNOWLEDGEMENT,
  captureBrowserPage,
  checkCaptureAllowed,
  createLinkCapture,
  type BrowserName,
  type CaptureOptions,
  type ProfileCaptureOptions,
  type ProfileContentType,
} from "@ao/library";
import { ApiError, badRequest, notFound } from "../errors.js";
import type { Session } from "../state.js";
import { bodyOf, optBool, optObj, optStr, paramsOf, projectParam, str, strArray, type Ctx, type Obj } from "./util.js";

/** Browser capture carries a full-page screenshot and the page's HTML (R96: raised only here). */
export const BROWSER_CAPTURE_BODY_LIMIT = 32 * 1024 * 1024;

const BROWSERS: BrowserName[] = ["chrome", "firefox", "safari", "edge", "brave"];
const MODELS = ["large-v3", "medium", "small"];
const TYPES: ProfileContentType[] = ["posts", "reels", "videos", "shorts", "highlights"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function captureOptions(o: Obj | undefined): CaptureOptions {
  const opts = o ?? {};
  const browser = optStr(opts, "cookiesFromBrowser", 16);
  if (browser !== undefined && !BROWSERS.includes(browser as BrowserName)) throw badRequest(`"${browser}" is not a supported browser.`);
  const model = optStr(opts, "transcribeModel", 16);
  if (model !== undefined && !MODELS.includes(model)) throw badRequest(`"${model}" is not a transcription model.`);
  const transcribe = opts.transcribe === undefined ? "project-default" : optBool(opts, "transcribe")!;
  const refresh = optBool(opts, "refreshIfExists");
  const legalBasis = optStr(opts, "legalBasis", 2000);
  return {
    transcribe,
    ...(browser ? { cookiesFromBrowser: browser as BrowserName } : {}),
    ...(model ? { transcribeModel: model } : {}),
    ...(refresh ? { refreshIfExists: true } : {}),
    ...(legalBasis ? { legalBasis } : {}),
  };
}

/** Using the browser session needs the project's one-time acknowledgement (POST /projects/:id/acknowledge). */
function requireAcknowledged(s: Session, projectId: string, opts: CaptureOptions): void {
  if (opts.cookiesFromBrowser && !s.repo.getProject(projectId).captureAcknowledgements?.cookies) {
    throw new ApiError(409, "ACKNOWLEDGEMENT_REQUIRED", COOKIES_ACKNOWLEDGEMENT, "cookies");
  }
}

function urlList(b: Obj, key: string, max: number): string[] {
  const urls = strArray(b, key, { max, itemMax: 2048 });
  for (const u of urls) if (!/^https?:\/\//i.test(u)) throw badRequest(`"${key}" must be web addresses.`);
  return urls;
}

export function registerCapture(app: FastifyInstance, ctx: Ctx): void {
  const { state, pairing } = ctx;

  app.post("/projects/:id/capture", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const urls = urlList(b, "urls", 500);
    const opts = captureOptions(optObj(b, "options"));
    await checkCaptureAllowed(s.repo, projectId, urls); // 403 with the reason when denied
    requireAcknowledged(s, projectId, opts);
    const worker = await state.workerClient(); // 503 when the media helper cannot run
    const queueId = randomUUID();
    const capture = createLinkCapture({ repo: s.repo, worker, index: s.index });
    state.track(
      capture
        .captureUrls(projectId, urls, opts, (done, total, outcome) => {
          state.events.publish("capture.progress", { queueId, projectId, done, total, outcome, finished: done === total });
        })
        .catch((err: unknown) => {
          state.events.publish("capture.progress", { queueId, projectId, finished: true, error: state.describe(err) });
        }),
      "capture",
    );
    return { queueId };
  });

  app.post("/projects/:id/capture-profile", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const url = urlList({ u: [str(b, "url", 2048)] }, "u", 1)[0]!;
    const o = optObj(b, "options") ?? {};
    const base = captureOptions(o);
    const since = optStr(o, "since", 10);
    const until = optStr(o, "until", 10);
    if ((since && !DAY.test(since)) || (until && !DAY.test(until))) throw badRequest("since and until are dates written YYYY-MM-DD.");
    const maxItems = o.maxItems === undefined ? undefined : Number(o.maxItems);
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1)) throw badRequest('"maxItems" must be a whole number of 1 or more.');
    const contentTypes = o.contentTypes === undefined ? undefined : strArray(o, "contentTypes", { max: 5 });
    if (contentTypes?.some((t) => !TYPES.includes(t as ProfileContentType))) throw badRequest(`"contentTypes" are: ${TYPES.join(", ")}.`);
    const opts: ProfileCaptureOptions = {
      ...base,
      transcribe: base.transcribe === true,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(maxItems ? { maxItems } : {}),
      ...(contentTypes ? { contentTypes: contentTypes as ProfileContentType[] } : {}),
      ...(optBool(o, "metadataOnly") ? { metadataOnly: true } : {}),
      ...(optBool(o, "includeComments") ? { includeComments: true } : {}),
    };
    await checkCaptureAllowed(s.repo, projectId, [url]);
    requireAcknowledged(s, projectId, opts);
    const worker = await state.workerClient();
    const queueId = randomUUID();
    const capture = createLinkCapture({ repo: s.repo, worker, index: s.index });
    state.track(
      capture
        .captureProfile(projectId, url, opts, (done, total, outcome) => state.events.publish("capture.progress", { queueId, projectId, done, total, outcome, finished: false }))
        .then((report) => state.events.publish("capture.progress", { queueId, projectId, finished: true, report }))
        .catch((err: unknown) => state.events.publish("capture.progress", { queueId, projectId, finished: true, error: state.describe(err) })),
      "profile capture",
    );
    return { queueId };
  });

  app.post("/projects/:id/sources/:sid/transcribe", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
    const b = bodyOf(req);
    const model = optStr(b, "model", 16);
    if (model !== undefined && !MODELS.includes(model)) throw badRequest(`"${model}" is not a transcription model.`);
    const language = optStr(b, "language", 16);
    if (language !== undefined && language !== "auto" && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) throw badRequest(`"${language}" is not a language code.`);
    const worker = await state.workerClient();
    const r = await createLinkCapture({ repo: s.repo, worker, index: s.index }).transcribeSource(projectId, sid, { ...(model ? { model } : {}), ...(language ? { language } : {}) });
    return r;
  });

  app.get("/tools/versions", async () => {
    const w = await state.ensureWorker();
    return { versions: await w.versions() };
  });

  app.post("/tools/update", async () => {
    const w = await state.ensureWorker();
    return w.updateTools();
  });

  // ---- the browser extension ----
  app.post("/extension/pair", async (req) => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Pairing is started from the desktop app.");
    return pairing.newCode();
  });

  app.post("/extension/pair/confirm", async (req) => {
    if (pairing.rateLimited()) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Wait a minute, then try again.");
    const code = bodyOf(req).code;
    const token = await pairing.confirm(typeof code === "string" ? code : "", req.headers.origin ?? "");
    if (!token) throw new ApiError(401, "UNAUTHORIZED", "That code is not valid. Ask the desktop app for a new one.");
    return { token };
  });

  app.get("/extension/pairings", async () => ({ extensions: pairing.list() }));
  app.delete("/extension/pairings/:pid", async (req) => {
    if (!(await pairing.unpair(paramsOf(req).pid ?? ""))) throw notFound("That pairing");
    return { removed: true };
  });

  app.post("/capture/browser", { bodyLimit: BROWSER_CAPTURE_BODY_LIMIT }, async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = str(b, "projectId", 64);
    if (!s.repo.listProjects().some((p) => p.id === projectId)) throw notFound("That project");
    const url = str(b, "url", 2048);
    const alsoDownload = optBool(b, "alsoDownload") ?? false;
    if (alsoDownload) await checkCaptureAllowed(s.repo, projectId, [url]);
    const linkCapture = alsoDownload ? createLinkCapture({ repo: s.repo, worker: await state.workerClient(), index: s.index }) : undefined;
    const extracted = optObj(b, "extracted");
    const r = await captureBrowserPage(
      s.repo,
      projectId,
      {
        url,
        ...(extracted ? { extracted } : {}),
        ...(typeof b.screenshotPng === "string" ? { screenshotPng: b.screenshotPng } : {}),
        ...(typeof b.html === "string" ? { html: b.html } : {}),
        ...(typeof b.legalBasis === "string" ? { legalBasis: b.legalBasis } : {}),
      },
      linkCapture ? { linkCapture } : {},
    );
    state.events.publish("capture.progress", { kind: "browser", projectId, sourceId: r.sourceId, status: r.status, finished: true });
    return r;
  });
}
