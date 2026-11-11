/**
 * Capture (spec 5.1, 5.5): links queued for the downloader (per-item outcomes as `capture.progress`
 * events), whole profiles, transcription of a source, the capture tools' versions and update, and
 * browser capture from the paired extension (its pairing too, and its link lists: R111; R116: both
 * capture methods authorised, links deduplicated, single posts and videos only, one running and one
 * waiting list per extension).
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
  classifyUrl,
  createLinkCapture,
  isCollectionLink,
  isPostLink,
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

/** Links queued at once (R111: also the extension's link lists). */
export const MAX_QUEUED_LINKS = 500;

/** A list of web addresses (http or https only, at most 2048 characters each). */
function urlList(b: Obj, key: string, max: number): string[] {
  const urls = strArray(b, key, { max, itemMax: 2048 });
  for (const u of urls) if (!isWebAddress(u)) throw badRequest(`"${key}" must be web addresses.`);
  return urls;
}

function isWebAddress(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") && p.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The extension's link lists hold single posts and videos only (R116): a whole profile or channel is
 * captured deliberately from the desktop app. 400 with a plain message otherwise.
 */
function postLinksOnly(urls: string[]): void {
  for (const u of urls) {
    const c = classifyUrl(u);
    if (isCollectionLink(c)) throw badRequest("A link list can hold single posts and videos only. Whole profiles, channels and playlists are captured from the desktop app (Capture profile).");
    if (!isPostLink(c)) throw badRequest("A link list can hold single posts and videos from YouTube, Instagram or TikTok only.");
  }
}

/** Links queues one extension may have at once (R116): one running and one waiting. */
export const LINK_QUEUES_PER_EXTENSION = 2;

export function registerCapture(app: FastifyInstance, ctx: Ctx): void {
  const { state, pairing } = ctx;

  /** Queues `urls` for the downloader after the project's capture decision (403 POLICY_DENIED with the reason). */
  async function queueLinks(
    s: Session,
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    extra: { methods?: Parameters<typeof checkCaptureAllowed>[3]; after?: Promise<unknown>; onQueued?: (queueId: string, done: Promise<void>) => void } = {},
  ): Promise<{ queueId: string }> {
    await checkCaptureAllowed(s.repo, projectId, urls, extra.methods); // 403 with the reason when denied
    requireAcknowledged(s, projectId, opts);
    await state.workerClient(); // 503 when the media helper cannot run
    const queueId = randomUUID();
    // In the work registry: a library move stops it between links and it continues afterwards (R106).
    // The legal basis is checked per link as it is stored, as for every capture.
    const done = state.startCaptureQueue(queueId, projectId, urls, opts, extra.after ? { after: extra.after } : {});
    extra.onQueued?.(queueId, done);
    return { queueId };
  }

  /**
   * Each paired extension's links queues (R116): a slot is taken synchronously before anything async,
   * so parallel requests cannot all pass the limit; it stays taken while its queue is unfinished,
   * and only while the library it was taken in stays open (41a I3: closing the library, or shutting
   * the service down, releases it even when the queue never got to finish).
   */
  type Slot = { lib: object; queueId?: string; done?: Promise<void> };
  const linkSlots = new Map<string, Slot[]>();
  function activeSlots(callerId: string, lib: object): Slot[] {
    const live = (linkSlots.get(callerId) ?? []).filter((x) => x.lib === lib && (x.queueId === undefined || state.captureQueue(x.queueId)?.finished === false));
    linkSlots.set(callerId, live);
    return live;
  }

  app.post("/projects/:id/capture", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const urls = urlList(b, "urls", MAX_QUEUED_LINKS);
    const opts = captureOptions(optObj(b, "options"));
    return queueLinks(s, projectId, urls, opts);
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
    // A profile run cannot stop part-way here: a move waits for it to finish (drained, R106).
    state.startWork("profile-capture", async () => {
      try {
        const report = await capture.captureProfile(projectId, url, opts, (done, total, outcome) => state.events.publish("capture.progress", { queueId, projectId, done, total, outcome, finished: false }));
        state.events.publish("capture.progress", { queueId, projectId, finished: true, report });
      } catch (err) {
        state.events.publish("capture.progress", { queueId, projectId, finished: true, error: state.describe(err) });
      }
    });
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
    if (pairing.rateLimited(req.headers.origin ?? "")) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Wait a minute, then try again.");
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

  // The extension's "profile as I scroll" list (R111): the same decision, queue and capture.progress
  // events as /projects/:id/capture, reached with the extension token only (the desktop app uses that
  // route). No browser-session (cookies) option from here; a legal basis may be given.
  app.post("/capture/browser/links", async (req) => {
    if (req.caller !== "extension") throw new ApiError(403, "FORBIDDEN", "This is the browser extension's route; the desktop app queues links with /projects/:id/capture.");
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = str(b, "projectId", 64);
    if (!s.repo.listProjects().some((p) => p.id === projectId)) throw notFound("That project");
    // The same link listed again is queued once (R116).
    const urls = [...new Set(urlList(b, "urls", MAX_QUEUED_LINKS))];
    if (!urls.length) throw badRequest('"urls" must list at least one web address.');
    postLinksOnly(urls);
    const legalBasis = optStr(b, "legalBasis", 2000);
    // One running and one waiting links queue per paired extension; more is 429 (R116).
    const callerId = req.extensionId ?? "";
    const live = activeSlots(callerId, s.lib);
    if (live.length >= LINK_QUEUES_PER_EXTENSION) throw new ApiError(429, "RATE_LIMITED", "Links from this browser are already being captured. Wait until they have finished, then send more.");
    const slot: Slot = { lib: s.lib };
    live.push(slot);
    // A second list waits for the first; downloads from any queue share one lane per platform.
    const after = live.find((x) => x !== slot)?.done;
    try {
      return await queueLinks(s, projectId, urls, { transcribe: "project-default", ...(legalBasis ? { legalBasis } : {}) }, {
        // A link list is both browser capture and the downloader: the project must allow both (R116).
        methods: ["browser_capture", "downloader"],
        ...(after ? { after } : {}),
        onQueued: (queueId, done) => {
          slot.queueId = queueId;
          slot.done = done;
        },
      });
    } catch (err) {
      linkSlots.set(callerId, (linkSlots.get(callerId) ?? []).filter((x) => x !== slot));
      throw err;
    }
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
