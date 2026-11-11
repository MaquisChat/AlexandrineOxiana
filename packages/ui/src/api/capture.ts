/**
 * Typed methods for the capture screen (Task 34b, R113), built on the client's `request()`, and the
 * pure pieces the screen and its queue use. Routes (apps/library-service/src/routes/):
 *
 *   POST /projects/:id/capture           { urls, options? } → { queueId }  (capture.ts)
 *   POST /projects/:id/capture-profile   { url, options? }  → { queueId }  (capture.ts)
 *   POST /projects/:id/acknowledge       { kind: "cookies" } → { acknowledgements } (projects.ts)
 *   GET  /tools/versions                 → { versions: { <tool>: version | null } }
 *   POST /tools/update                   → { ytDlp: { old, new, managed }, galleryDl: { version, pinned } }
 *   GET  /projects                       → { projects: [{ id, name, unlocked, acknowledgements? … }] }
 *   GET  /projects/:id/governance        → { yaml, … } (read for the legal-basis rule, R41)
 *
 * Progress comes as `capture.progress` events on GET /events: per link
 * `{ queueId, projectId, done, total, outcome, finished }`; a profile run ends with
 * `{ queueId, projectId, finished: true, report }`; any queue may end with `{ …, finished: true,
 * error }` (the error's name and message, which are never shown).
 *
 * Two things here mirror the library rather than import it (the UI never bundles @ao/library):
 * the browser-session acknowledgement's exact wording and the link classifier used for the preview
 * (a hint only; the service decides). capture.parity.test.ts compares both with the library's own
 * until Task 63 gives them one shared definition (R146).
 */
// Only the governance modules: the rest of @ao/core (citation styles, ...) stays out of the bundle.
import { effectivePolicy } from "@ao/core/src/governance/merge";
import { parseGovernance } from "@ao/core/src/governance/schema";
import type { ApiClient, ServiceEvent } from "./client";
import { isValidId, seg } from "./import";

// ---------------------------------------------------------------------------------------------
// The acknowledgement (packages/library/src/capture/errors.ts, spec 5.1)

/** The one-time explanation shown before the downloader may use the researcher's browser session. */
export const COOKIES_ACKNOWLEDGEMENT =
  "Using your browser's signed-in session lets the downloader see what you can see. Platforms may restrict or suspend accounts they detect using automated tools. This choice is recorded in the project's audit log.";

// ---------------------------------------------------------------------------------------------
// Shapes

export type BrowserName = "chrome" | "firefox" | "safari" | "edge" | "brave";
export const BROWSERS: ReadonlyArray<{ value: BrowserName; label: string }> = [
  { value: "chrome", label: "Chrome" },
  { value: "firefox", label: "Firefox" },
  { value: "safari", label: "Safari" },
  { value: "edge", label: "Edge" },
  { value: "brave", label: "Brave" },
];

/** The transcription models the service accepts (routes/capture.ts MODELS). */
export const MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "large-v3", label: "Large (most accurate, slowest)" },
  { value: "medium", label: "Medium" },
  { value: "small", label: "Small (fastest)" },
];

export type ProfileContentType = "posts" | "reels" | "videos" | "shorts" | "highlights";
export const CONTENT_TYPES: ReadonlyArray<{ value: ProfileContentType; label: string }> = [
  { value: "posts", label: "Posts" },
  { value: "reels", label: "Reels" },
  { value: "videos", label: "Videos" },
  { value: "shorts", label: "Shorts" },
  { value: "highlights", label: "Story highlights" },
];

/** CaptureOptions as the service reads them (routes/capture.ts captureOptions). */
export interface CaptureOptions {
  cookiesFromBrowser?: BrowserName;
  /** Left out: the project's own setting. */
  transcribe?: boolean;
  transcribeModel?: string;
  refreshIfExists?: boolean;
  legalBasis?: string;
}

export interface ProfileCaptureOptions extends CaptureOptions {
  since?: string;
  until?: string;
  maxItems?: number;
  contentTypes?: ProfileContentType[];
  metadataOnly?: boolean;
  includeComments?: boolean;
}

export type CaptureStatus = "created" | "duplicate" | "refreshed" | "incomplete" | "failed" | "needs-review";

/** CaptureOutcome (packages/library/src/capture/link-capture.ts). */
export interface CaptureOutcome {
  url: string;
  status: CaptureStatus | (string & {});
  sourceId?: string;
  reason?: string;
  errorCode?: string;
}

/** ProfileCaptureReport (packages/library/src/capture/profile-capture.ts). */
export interface ProfileReport {
  status: "completed" | "paused-rate-limited" | "failed" | (string & {});
  profileSourceId?: string;
  listComplete: boolean;
  created: number;
  duplicates: number;
  incomplete: number;
  failed: number;
  newlyUnavailable: number;
  reappeared: number;
  edited: number;
  items: CaptureOutcome[];
  errorCode?: string;
  reason?: string;
}

export interface CaptureProgress {
  queueId: string;
  projectId: string;
  done?: number;
  total?: number;
  outcome?: CaptureOutcome;
  finished: boolean;
  report?: ProfileReport;
  error?: string;
}

export interface CaptureProject {
  id: string;
  name: string;
  unlocked?: boolean;
  acknowledgements?: string[];
}

export interface ToolsUpdate {
  ytDlp: { old: string | null; new: string | null; managed: boolean };
  galleryDl: { version: string | null; pinned: boolean };
}

/** What the project's rules mean for a capture (R41). */
export interface CapturePolicy {
  /** The data can identify people and the rules require a legal basis to store it. */
  legalBasisRequired: boolean;
  /** `consent.defaultLegalBasis['social-media']`: used when none is given. */
  defaultLegalBasis: string | undefined;
  /** The rules allow capture with the downloader. */
  downloaderAllowed: boolean;
  /** The rules could be read (unreadable rules are read strictly: the service refuses everything then). */
  readable: boolean;
}

// ---------------------------------------------------------------------------------------------
// The project's rules

/** The `consent.defaultLegalBasis` category link capture uses (link-capture.ts LEGAL_CATEGORY). */
const LEGAL_CATEGORY = "social-media";

export function capturePolicyFromYaml(yaml: string): CapturePolicy {
  try {
    const p = effectivePolicy(parseGovernance(yaml)).policy;
    const fallback = p.consent.defaultLegalBasis?.[LEGAL_CATEGORY]?.trim();
    return {
      legalBasisRequired: p.identifiability.containsIdentifiable && p.consent.requireLegalBasis,
      defaultLegalBasis: fallback || undefined,
      downloaderAllowed: p.captureMethods.includes("downloader"),
      readable: true,
    };
  } catch {
    return { legalBasisRequired: true, defaultLegalBasis: undefined, downloaderAllowed: false, readable: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Links

/** Links queued at once (routes/capture.ts MAX_QUEUED_LINKS). */
export const MAX_LINKS = 500;

/** One link per line, trimmed; blank lines left out. */
export function parseLinks(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** What the service accepts (routes/capture.ts isWebAddress): http or https, a host, at most 2048 characters. */
export function isWebAddress(u: string): boolean {
  if (u.length > 2048 || !/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") && p.hostname.length > 0;
  } catch {
    return false;
  }
}

export type Platform = "youtube" | "instagram" | "tiktok" | "other";
export type LinkKind = "video" | "short" | "post" | "reel" | "carousel" | "story-highlight" | "playlist" | "profile" | "unknown";

export interface LinkPreview {
  platform: Platform;
  kind: LinkKind;
  /** "YouTube — video", in words. */
  label: string;
  /** The service will refuse it or cannot capture it as a link. */
  problem?: "not-a-web-address" | "unsupported";
  /** A whole profile, channel or playlist. */
  collection: boolean;
}

const PLATFORM_NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", other: "Other site" };
const KIND_NAMES: Record<LinkKind, string> = {
  video: "video",
  short: "short video",
  post: "post",
  reel: "reel",
  carousel: "photo post",
  "story-highlight": "story highlight",
  playlist: "whole playlist",
  profile: "whole profile",
  unknown: "kind found when it is downloaded",
};

// ---- A PREVIEW HINT ONLY -------------------------------------------------------------------------
// A copy of packages/library/src/capture/platforms.ts `classifyUrl` (platform and kind only), so the
// UI can preview a pasted line without a round trip. The library service decides what an address is;
// the UI never refuses an address because of this copy (R146). capture.parity.test.ts runs one table
// of addresses through both. Task 63 replaces this copy with one shared definition both sides import.
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer", "legal", "web", "api"]);
const YT_ID = /^[\w-]{6,}$/;

function classify(raw: string): { platform: Platform; kind: LinkKind } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { platform: "other", kind: "unknown" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { platform: "other", kind: "unknown" };
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, "");
  const seg = u.pathname.split("/").filter(Boolean);
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    const yt = (kind: LinkKind) => ({ platform: "youtube" as const, kind });
    if (host === "youtu.be") return yt(seg[0] && YT_ID.test(seg[0]) ? "video" : "unknown");
    if (seg[0] === "watch") return yt(YT_ID.test(u.searchParams.get("v") ?? "") ? "video" : "unknown");
    if ((seg[0] === "shorts" || seg[0] === "live" || seg[0] === "embed") && seg[1] && YT_ID.test(seg[1])) return yt(seg[0] === "shorts" ? "short" : "video");
    if (seg[0] === "playlist" && u.searchParams.get("list")) return yt("playlist");
    if (seg[0]?.startsWith("@") && seg[0].length > 1) return yt("profile");
    if ((seg[0] === "channel" || seg[0] === "c" || seg[0] === "user") && seg[1]) return yt("profile");
    return yt("unknown");
  }
  if (host === "instagram.com") {
    const ig = (kind: LinkKind) => ({ platform: "instagram" as const, kind });
    const i = seg[1] === "p" || seg[1] === "reel" || seg[1] === "reels" ? 1 : 0;
    const [a, b] = [seg[i], seg[i + 1]];
    if ((a === "p" || a === "tv") && b) return ig(a === "tv" ? "video" : "post");
    if ((a === "reel" || a === "reels") && b) return ig("reel");
    if (seg[0] === "stories" && seg[1] === "highlights" && seg[2]) return ig("story-highlight");
    if (seg.length === 1 && !IG_RESERVED.has(seg[0]!.toLowerCase()) && /^[\w.]+$/.test(seg[0]!)) return ig("profile");
    return ig("unknown");
  }
  if (host === "tiktok.com" || host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    const tt = (kind: LinkKind) => ({ platform: "tiktok" as const, kind });
    if (host !== "tiktok.com") return tt("unknown");
    if (!seg[0]?.startsWith("@") || seg[0].length < 2) return tt("unknown");
    if ((seg[1] === "video" || seg[1] === "photo") && seg[2] && /^\d+$/.test(seg[2])) return tt(seg[1] === "video" ? "video" : "carousel");
    if (seg.length === 1) return tt("profile");
    return tt("unknown");
  }
  return { platform: "other", kind: "unknown" };
}

/**
 * The per-line preview: platform and kind in words. A hint only (R146): the service decides, and
 * nothing is refused on the strength of this guess — only an address that is not a web address at
 * all, which the service refuses for the whole list.
 */
export function previewLink(url: string): LinkPreview {
  const { platform, kind } = classify(url);
  const collection = kind === "profile" || kind === "playlist";
  if (!isWebAddress(url.trim())) return { platform, kind, collection, problem: "not-a-web-address", label: "This is not a web address (it must start with https:// or http://)." };
  if (platform === "other") return { platform, kind, collection, problem: "unsupported", label: "Not recognised here as a YouTube, Instagram or TikTok link — the app will check it." };
  if (kind === "unknown") return { platform, kind, collection, label: `${PLATFORM_NAMES[platform]} — kind not recognised here; the app will check it` };
  return { platform, kind, collection, label: `${PLATFORM_NAMES[platform]} — ${KIND_NAMES[kind]}` };
}

// ---------------------------------------------------------------------------------------------
// Outcomes in plain words

/**
 * Every reason code the service can send for a capture item or a profile run: the library's own
 * (capture/errors.ts and link-capture.ts) and the media helper's job codes (services/media-worker).
 */
const OUTCOME_TEXT: Record<string, string> = {
  LOGIN_REQUIRED: "This post needs a signed-in session. Try again with “Use my browser session”.",
  PRIVATE: "This post is private. It can only be saved through a signed-in session that is allowed to see it.",
  RATE_LIMITED: "The platform is limiting requests right now. Wait a while, then try again.",
  NOT_FOUND_OR_REMOVED: "This post could not be found. It may have been removed, or the link may be wrong.",
  GEO_BLOCKED: "This post is not available in your country or region.",
  EXTRACTOR_ERROR: "The downloader could not read this page. The platform may have changed; updating the capture tools may help.",
  WORKER_UNAVAILABLE: "The media helper is not running, so nothing was downloaded. Restart the app and try again.",
  UNSUPPORTED_URL: "This link is not a YouTube, Instagram or TikTok post, so the downloader cannot capture it.",
  PROFILE_CAPTURE_UNAVAILABLE: "Whole profiles, channels and playlists are captured with the profile archive, which is not available here.",
  NOTHING_SAVED: "The downloader finished but saved no media or platform data for this link.",
  CANCELLED: "The capture was cancelled. Nothing was saved.",
  NO_MEDIA: "The post's details were saved, but no media file came back from the platform.",
  LEGAL_BASIS_REQUIRED:
    "This project's rules need a legal basis for social-media data that can identify people, and none was given. Enter the legal basis for this capture, or ask whoever manages the project's rules to set a default for social media, then capture again.",
  INTERRUPTED: "The capture was interrupted before it finished. Capture the link again.",
  POLICY_CHANGED: "This project's rules changed during the download, so nothing was saved.",
  // A profile run's own meanings (a run keeps what it saved before it stopped).
  POLICY_CHANGED_RUN: "This project's rules changed during the capture. Posts saved before the change are kept; nothing else was saved.",
  RATE_LIMITED_PAUSED: "The platform is limiting requests, so the profile capture was paused. Run it again later; it continues where it stopped.",
  INVALID_OPTIONS: "Some profile capture options are not valid. Check the dates (YYYY-MM-DD) and the maximum number of items.",
  POLICY_DENIED: "This project's rules do not allow this capture.",
  PROJECT_LOCKED: "The project is locked. Unlock it, then try again.",
  CAPTURE_FAILED: "Something went wrong while saving this link. Nothing was saved.",
  // The media helper's own job codes.
  TOOL_DOWNLOAD_FAILED: "The downloader tool is missing and could not be downloaded. Check the internet connection, then try again.",
  TOOL_CHECKSUM_MISMATCH: "The downloader tool that was fetched did not match its published checksum, so it was not installed. Try again later.",
  TOOL_UPDATE_FAILED: "The downloader tool could not be updated. Try again later.",
  TOOL_MISSING: "A tool this capture needs is not installed on this computer.",
  MISSING_DEPENDENCY: "A tool this capture needs is not installed on this computer.",
  MODEL_UNAVAILABLE: "The transcription model could not be loaded or downloaded. Check the internet connection, or choose another model.",
  FFMPEG_FAILED: "The video could not be converted. The file may be damaged.",
  UNSUPPORTED_INPUT: "The downloaded file is not a recording the app can read.",
  INPUT_NOT_FOUND: "The downloaded file disappeared before it could be processed. Capture the link again.",
  ENCRYPTION_REQUIRED: "This project's rules require encryption, but the project is not encrypted, so nothing was saved.",
  INPUT_NOT_DECRYPTABLE: "An encrypted file could not be read for this capture.",
  INVALID_PARAMS: "The media helper could not use these settings on this computer.",
  INTERNAL: "The media helper ran into a problem. Nothing was saved.",
  FAILED: "The media helper could not finish. Nothing was saved.",
};

/** Codes the UI explains in its own words. */
export const KNOWN_OUTCOME_CODES: readonly string[] = Object.keys(OUTCOME_TEXT);

/** For a code this version of the app does not know, and no sentence from the service. */
export const UNKNOWN_OUTCOME_TEXT = "This link could not be captured, for a reason this version of the app does not recognise. Nothing was saved.";

/**
 * The plain sentence for an outcome's code. A policy refusal carries the rule's reason; a code the UI
 * does not know shows the service's own sentence (the library only sends fixed sentences) or a
 * safe fallback, never the code.
 */
export function outcomeText(code: string | undefined, reason?: string): string {
  const known = code !== undefined && Object.hasOwn(OUTCOME_TEXT, code) ? OUTCOME_TEXT[code] : undefined;
  if (known) return code === "POLICY_DENIED" && reason ? `${known} ${reason}` : known;
  return reason?.trim() ? reason.trim() : UNKNOWN_OUTCOME_TEXT;
}

/**
 * A queue that stopped as a whole: the service sends the error's name and message (state.describe),
 * which are never shown. Only the kind of error chooses the sentence.
 */
export function queueErrorText(error: string, kind: "links" | "profile" = "links"): string {
  const name = /^(\w+)/.exec(error)?.[1] ?? "";
  if (name === "WorkerUnavailableError") return "The media helper is not running, so the capture stopped. Restart the app and try again.";
  if (name === "ProjectLockedError" || name === "KeyNotAvailableError") return OUTCOME_TEXT.PROJECT_LOCKED!;
  if (name === "PolicyDeniedError") return OUTCOME_TEXT.POLICY_DENIED!;
  if (name === "AcknowledgementRequiredError") return "Using your browser session has not been acknowledged for this project, so nothing was downloaded. Acknowledge it, then capture again.";
  if (kind === "profile") return "The profile capture stopped before it finished. Posts shown here as saved are kept. Run it again later.";
  return "The capture stopped before it finished.";
}

/**
 * What to say under one queue item: the UI's sentence (`ui`) and/or the service's own sentence
 * (`service`, shown as user text). The library's sentence for a partial save or a note on a saved
 * item is shown, never replaced (R146); for a failed link the UI's sentence for a known code is used
 * (the same meaning in the UI's words), except where the code means something else for a whole run.
 */
export function itemExplanation(it: QueueItem): { ui?: string; service?: string } {
  const reason = it.reason?.trim() || undefined;
  switch (it.state) {
    case "failed": {
      const code = it.errorCode;
      if (code === "POLICY_DENIED") return { ui: OUTCOME_TEXT.POLICY_DENIED!, ...(reason ? { service: reason } : {}) };
      // A whole list sent as a link (or a code the UI does not know): the library's own sentence.
      if (reason && (code === undefined || code === "POLICY_CHANGED" || code === "RATE_LIMITED" || !Object.hasOwn(OUTCOME_TEXT, code))) return { service: reason };
      return { ui: outcomeText(code) };
    }
    case "incomplete":
      return reason ? { service: reason } : { ui: `Only part of this post was saved. ${outcomeText(it.errorCode)}` };
    case "created":
    case "refreshed":
      return reason ? { service: reason } : {};
    case "needs-review":
      return reason ? { service: reason } : { ui: "Some details could not be confirmed, so the source is in the review queue." };
    case "duplicate":
      return { ui: "This post is already in the project; nothing new was saved. Choose “Refresh existing” to save a new dated snapshot." };
    case "unknown":
      return { ui: "Not known: progress was missed while the connection to the library service was down. It may have been captured; look for its sources in the library." };
    case "not-captured":
      return { ui: "This link was not tried. Capture it again." };
    default:
      return reason ? { service: reason } : {};
  }
}

// ---------------------------------------------------------------------------------------------
// Progress events and the queue they fill

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optNum = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);

function isOutcome(v: unknown): v is CaptureOutcome {
  return isObj(v) && typeof v.url === "string" && typeof v.status === "string" && (v.errorCode === undefined || typeof v.errorCode === "string") && (v.reason === undefined || typeof v.reason === "string");
}

/** A well-formed `capture.progress` event of a queue in `projectId`; anything else is undefined (dropped). */
export function captureProgress(e: ServiceEvent, projectId: string): CaptureProgress | undefined {
  if (e.type !== "capture.progress" || !isObj(e.data)) return undefined;
  const d = e.data;
  if (typeof d.queueId !== "string" || d.projectId !== projectId || typeof d.finished !== "boolean") return undefined;
  if (!optNum(d.done) || !optNum(d.total)) return undefined;
  if (d.outcome !== undefined && !isOutcome(d.outcome)) return undefined;
  if (d.error !== undefined && typeof d.error !== "string") return undefined;
  if (d.report !== undefined && !(isObj(d.report) && typeof d.report.status === "string")) return undefined;
  return d as unknown as CaptureProgress;
}

/**
 * "unknown": the item was (or may have been) tried but the screen did not see its outcome (R146).
 * "not-captured": the queue stopped before reaching it, and no progress was missed.
 */
export type ItemState = "waiting" | "capturing" | "not-captured" | "unknown" | CaptureStatus | (string & {});

export interface QueueItem {
  url: string;
  state: ItemState;
  errorCode?: string;
  reason?: string;
  sourceId?: string;
}

export interface CaptureQueueState {
  queueId: string;
  kind: "links" | "profile";
  /** The profile's link (profile queues). */
  url?: string;
  items: QueueItem[];
  done: number;
  total: number | undefined;
  finished: boolean;
  /** Why the queue (or the profile run) stopped, in the UI's plain words (added to `stopReason`). */
  error?: string;
  /** The library's own sentence for a stopped or paused run, shown as it is (R146). */
  stopReason?: string;
  errorCode?: string;
  report?: ProfileReport;
  /** Progress may have been missed: the event stream was down while this queue ran (R146). */
  gap?: boolean;
}

export function linkQueue(queueId: string, urls: string[]): CaptureQueueState {
  return { queueId, kind: "links", items: urls.map((url, i) => ({ url, state: i === 0 ? "capturing" : "waiting" })), done: 0, total: urls.length, finished: false };
}

export function profileQueue(queueId: string, url: string): CaptureQueueState {
  return { queueId, kind: "profile", url, items: [], done: 0, total: undefined, finished: false };
}

const PENDING = (s: ItemState) => s === "waiting" || s === "capturing";

/**
 * The queue after the event stream was lost (an unfinished queue only): progress may be missed from
 * now on, possibly the last event too, so nothing still pending is claimed to be waiting or being
 * captured any more — it is not known (R146, review N1). A later event still resolves what it reports.
 */
export function markGap(q: CaptureQueueState): CaptureQueueState {
  if (q.finished) return q;
  if (q.gap && !q.items.some((i) => PENDING(i.state))) return q;
  return { ...q, gap: true, items: q.items.map((i) => (PENDING(i.state) ? { ...i, state: "unknown" } : i)) };
}

/** What the screen saw of a queue: done (an outcome other than failed) + failed + unknown + not tried + pending = total. */
export function queueCounts(q: CaptureQueueState): { total: number; done: number; failed: number; unknown: number; notTried: number; pending: number } {
  const c = { total: 0, done: 0, failed: 0, unknown: 0, notTried: 0, pending: 0 };
  const total = Math.max(q.total ?? 0, q.items.length);
  for (let i = 0; i < total; i++) {
    const s = q.items[i]?.state ?? (q.gap ? "unknown" : q.finished ? "not-captured" : "waiting");
    if (PENDING(s)) c.pending++;
    else if (s === "unknown") c.unknown++;
    else if (s === "not-captured") c.notTried++;
    else if (s === "failed") c.failed++;
    else c.done++;
  }
  c.total = total;
  return c;
}

/** What the UI adds to a run's own sentence (never contradicting it), or uses when there is none. */
function reportText(r: ProfileReport): { error?: string; stopReason?: string } {
  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : undefined;
  const code = r.errorCode;
  if (reason) return { stopReason: reason, ...(code === "LEGAL_BASIS_REQUIRED" ? { error: OUTCOME_TEXT.LEGAL_BASIS_REQUIRED! } : {}) };
  if (r.status === "paused-rate-limited") return { error: OUTCOME_TEXT.RATE_LIMITED_PAUSED! };
  if (code === "POLICY_CHANGED") return { error: OUTCOME_TEXT.POLICY_CHANGED_RUN! };
  if (code === "RATE_LIMITED") return { error: OUTCOME_TEXT.RATE_LIMITED_PAUSED! };
  // Sentences that are true of a whole run as well as of one link.
  if (code !== undefined && RUN_SAFE_CODES.has(code)) return { error: outcomeText(code) };
  return { error: STOPPED_RUN_TEXT };
}

/** Codes whose sentence also fits a whole profile run. */
const RUN_SAFE_CODES: ReadonlySet<string> = new Set(["LEGAL_BASIS_REQUIRED", "INVALID_OPTIONS", "POLICY_DENIED", "PROJECT_LOCKED", "WORKER_UNAVAILABLE", "PROFILE_CAPTURE_UNAVAILABLE"]);

/** A stopped run with no sentence of its own (review N2). */
const STOPPED_RUN_TEXT = "The profile capture stopped before it finished, for a reason the app could not name. Posts shown here as saved are kept. Run it again later.";

/** The queue after one event; the same object when the event is another queue's. */
export function applyProgress(q: CaptureQueueState, e: CaptureProgress): CaptureQueueState {
  if (e.queueId !== q.queueId) return q;
  const items = [...q.items];
  let done = q.done;
  if (e.outcome && typeof e.done === "number" && e.done >= 1) {
    const i = e.done - 1;
    const { url, status, errorCode, reason, sourceId } = e.outcome;
    const item: QueueItem = { url: q.kind === "links" && items[i] ? items[i].url : url, state: status, ...(errorCode ? { errorCode } : {}), ...(reason ? { reason } : {}), ...(sourceId ? { sourceId } : {}) };
    while (items.length < i) items.push({ url: "", state: "unknown" });
    items[i] = item;
    done = Math.max(done, e.done);
  } else if (typeof e.done === "number") done = Math.max(done, e.done);
  // Before `done`, every item was tried: one whose outcome was not seen is not known, never pending.
  for (let i = 0; i < Math.min(done, items.length); i++) if (PENDING(items[i]!.state)) items[i] = { ...items[i]!, state: "unknown" };
  if (q.kind === "links" && !e.finished && items[done] && PENDING(items[done]!.state)) items[done] = { ...items[done]!, state: "capturing" };
  const next: CaptureQueueState = { ...q, items, done, total: e.total ?? q.total };
  if (e.finished) {
    next.finished = true;
    // Not reached when the queue stopped: not tried, unless progress may have been missed.
    for (const [i, it] of items.entries()) if (PENDING(it.state)) items[i] = { ...it, state: q.gap ? "unknown" : "not-captured" };
    if (e.error !== undefined) next.error = queueErrorText(e.error, q.kind);
    if (e.report) {
      next.report = e.report;
      if (e.report.status !== "completed") {
        const t = reportText(e.report);
        if (t.stopReason) next.stopReason = t.stopReason;
        if (t.error) next.error = t.error;
        if (e.report.errorCode) next.errorCode = e.report.errorCode;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Methods

const pid = (s: string): string => {
  if (!isValidId(s)) throw new Error(`"${String(s)}" is not a valid project id.`);
  return seg(s);
};

export function captureApi(client: ApiClient) {
  const r = client.request;
  return {
    projects: async () => (await r<{ projects: CaptureProject[] }>("GET", "/projects")).projects,
    policy: async (projectId: string): Promise<CapturePolicy> => capturePolicyFromYaml((await r<{ yaml: string }>("GET", `/projects/${pid(projectId)}/governance`)).yaml),
    /** Queues links for the downloader; outcomes arrive as `capture.progress` events. */
    capture: (projectId: string, urls: string[], options: CaptureOptions) => r<{ queueId: string }>("POST", `/projects/${pid(projectId)}/capture`, { body: { urls, options } }),
    /** A whole profile, channel or playlist with its options. */
    captureProfile: (projectId: string, url: string, options: ProfileCaptureOptions) =>
      r<{ queueId: string }>("POST", `/projects/${pid(projectId)}/capture-profile`, { body: { url, options } }),
    /** Records the one-time browser-session acknowledgement (audited by the service). */
    acknowledge: async (projectId: string) => (await r<{ acknowledgements: string[] }>("POST", `/projects/${pid(projectId)}/acknowledge`, { body: { kind: "cookies" } })).acknowledgements,
    toolVersions: async () => (await r<{ versions: Record<string, string | null> }>("GET", "/tools/versions")).versions,
    updateTools: () => r<ToolsUpdate>("POST", "/tools/update"),
  };
}

export type CaptureApi = ReturnType<typeof captureApi>;
