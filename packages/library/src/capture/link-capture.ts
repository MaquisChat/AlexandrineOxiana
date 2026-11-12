/**
 * Link capture with the downloader (spec 5.1, 5.2, 5.8, 6.1): paste a YouTube, Instagram or TikTok
 * link, get a governed, provenance-rich, verified (and optionally transcribed) source.
 *
 *   1. classify the link (profiles and playlists go to `captureProfile`);
 *   2. policy: one `capture` decision (method `downloader`, the platform, the researcher's tz and
 *      now), plus a `store` pre-check, both before anything is downloaded; a deny is audited and
 *      thrown as PolicyDeniedError. The worker client does not evaluate `capture.download` again,
 *      and only the stored result is audited as allowed (by `createSource`), so a capture leaves
 *      exactly one audited capture decision;
 *   3. using the browser session needs the project's one-time acknowledgement
 *      (AcknowledgementRequiredError until `repo.acknowledge(projectId, "cookies")`);
 *   4. duplicates by (platform, post id): `duplicate`, or with `refreshIfExists` a new dated
 *      platform-metadata snapshot (`refreshed`);
 *   5. `capture.download` (yt-dlp; gallery-dl for Instagram posts and highlights and TikTok photo
 *      posts) into `<Library>/.tmp/capture-<id>/`, removed afterwards;
 *   6. draft + evidence from the platform JSON, `verifyDraft` against the snapshot, `createSource`
 *      with media, thumbnail and the stripped snapshot as originals; a source that needs review is
 *      queued in `review/pending.jsonl` in the same change;
 *   7. platform captions → derived `platform-captions`; transcription (when asked, or when the
 *      project's automation says so) → derived `transcript` (.vtt and segments.json).
 *
 * Immediately before anything is stored, the `capture` decision is evaluated again without
 * auditing an allow (R42): governance edited, or a protocol that expired, during the download
 * stops the capture with `POLICY_CHANGED` (one deny audited) and nothing is saved.
 *
 * Profile, channel and playlist links go to `captureProfile` (profile-capture.ts), which shares
 * the per-platform queue and the per-item path (`captureItem`).
 *
 * Reasons in outcomes are fixed plain-language sentences (errors.ts): never cookies, tokens, URLs
 * or file paths. Captures against one platform never run in parallel, across every queue of the
 * library (the lanes are shared per library, R116).
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { applyVerification, verifyDraft, type Asset, type Provenance, type SourceFile } from "@ao/core";
import type { IndexDb } from "../index/db.js";
import { findSourceBy, getMeta } from "../index/db.js";
import { activeTemp } from "../tmp-registry.js";
import { decryptBytes, encryptBytes } from "../repo/io.js";
import { authorizeProcessing, createSourcePreAuthorized, projectDataKey, projectPolicy, projectStampNow, repoLibrary, type Repo } from "../repo/repo.js";
import { PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import type { SourceInputFile } from "../repo/sources.js";
import { DEFAULT_SPEECH_MODEL } from "@ao/shared";
import { WorkerJobError, WorkerToolError, WorkerUnavailableError, type JobResult, type WorkerClient } from "../worker-client.js";
import { AcknowledgementRequiredError, CaptureCancelledError, incompleteReason, plainReason, toolMissingReason, transcriptToolMissingNote } from "./errors.js";
import { storeTranscript } from "../transcript-store.js";
import { classifyUrl, isCollectionLink, type ClassifiedUrl, type Platform } from "./platforms.js";
import { createProfileCapture, type ProfileCaptureOptions, type ProfileCaptureReport } from "./profile-capture.js";
import { buildDraft, stripSnapshot, verificationSnapshot, type CaptureTool } from "./snapshot.js";

export type BrowserName = "chrome" | "firefox" | "safari" | "edge" | "brave";

export interface CaptureOptions {
  /** Use the researcher's signed-in browser session (needs the project's acknowledgement). */
  cookiesFromBrowser?: BrowserName;
  /** `project-default`: the project's automation setting (off unless enabled). */
  transcribe: boolean | "project-default";
  /** faster-whisper model (the worker's default when omitted). */
  transcribeModel?: string;
  quality?: "best" | "1080p" | "720p";
  /** For a post already in the project: add a new dated platform-metadata snapshot. */
  refreshIfExists?: boolean;
  /** Legal basis for this capture; default: the project's `consent.defaultLegalBasis['social-media']`. */
  legalBasis?: string;
}

export type CaptureStatus = "created" | "duplicate" | "refreshed" | "incomplete" | "failed" | "needs-review";

export interface CaptureOutcome {
  url: string;
  status: CaptureStatus;
  sourceId?: string;
  reason?: string;
  errorCode?: string;
  /** The optional tool that was missing (Task 48a catalogue id), with `TOOL_NOT_INSTALLED` or a transcript note. */
  tool?: string;
}

export interface LinkCaptureDeps {
  repo: Repo;
  worker: WorkerClient;
  /** The library index (an IndexHandle or `{ db }`), for duplicate lookups; without it the project's sources are read. */
  index?: { readonly db: IndexDb };
  /** Replaces the built-in profile capture for profile and playlist links handed to `captureUrl`. */
  captureProfile?: (projectId: string, url: string, opts: CaptureOptions) => Promise<CaptureOutcome>;
  /** Waits between rate-limited attempts of a profile run (default: a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** How one post of a profile run is captured (the run already holds the audited capture decision). */
export interface ItemContext {
  /** The store decision's inputs the run already checked. */
  identifiable: boolean;
  legalBasis?: string;
  importBatchId: string;
  collectionIds: string[];
  /** Also download the post's comments (stored as a separate `platform-comments` original). */
  includeComments: boolean;
  metadataOnly: boolean;
  /** The run was ended from outside (Task 63 I3): a download that comes back then is discarded. */
  cancelled?: () => boolean;
  /** Aborted when the run is ended: the worker job in flight is asked to stop (N5). */
  signal?: AbortSignal;
}

/** How a queue or a run is ended from outside (Task 63 I3): asked between links and before every store. */
export interface CaptureControl {
  /** Stopped between links (a library move, R106): the rest is for the caller to run again. */
  shouldStop?: () => boolean;
  /** Ended for good (a lock, a close): a download that comes back is discarded, nothing more is stored. */
  cancelled?: () => boolean;
  /**
   * Aborted when the capture is ended: the worker job in flight is asked to stop (the worker client
   * sends the worker's cancel), so an ended capture frees the worker promptly (N5).
   */
  signal?: AbortSignal;
}

/** The shared machinery of link and profile capture (package-internal). */
export interface CaptureCore {
  repo: Repo;
  worker: WorkerClient;
  sleep: (ms: number) => Promise<void>;
  inLane<T>(p: Platform, fn: () => Promise<T>): Promise<T>;
  acknowledged(projectId: string): boolean;
  findExisting(projectId: string, platform: Platform, postId: string): Promise<string | undefined>;
  /** Re-evaluates `capture` (no allow audited); false after an audited deny. */
  stillAllowed(projectId: string, platform: Platform): Promise<boolean>;
  readJson(path: string, encrypted: boolean, projectId: string): Promise<unknown>;
  writeJson(work: string, name: string, data: unknown, projectId: string, encrypted: boolean): Promise<string>;
  makeWork(): Promise<{ work: string; done: () => Promise<void> }>;
  /** One post's full platform metadata (metadata-only download), stripped; undefined when it cannot be read. */
  fetchMetadata(projectId: string, c: ClassifiedUrl, opts: CaptureOptions, signal?: AbortSignal): Promise<Record<string, unknown> | undefined>;
  captureItem(projectId: string, url: string, c: ClassifiedUrl, opts: CaptureOptions, item: ItemContext): Promise<CaptureOutcome>;
}

export interface TranscribeSourceResult {
  sourceId: string;
  /** Library-relative folder of the source. */
  folder: string;
  /** Library-relative paths of the stored transcript files. */
  files: string[];
  flaggedSegments: number;
}

/** The source has no video or audio original to transcribe. */
export class NoMediaError extends Error {
  override name = "NoMediaError";
  constructor(readonly sourceId: string) {
    super("This source has no video or audio file to transcribe.");
  }
}

export interface LinkCapture {
  /** Transcribes a video or audio source already in the project and stores the transcript with it. */
  transcribeSource(projectId: string, sourceId: string, opts?: { model?: string; language?: string }): Promise<TranscribeSourceResult>;
  captureUrl(projectId: string, url: string, opts: CaptureOptions): Promise<CaptureOutcome>;
  /** A whole profile, channel or playlist (profile-capture.ts). */
  captureProfile(
    projectId: string,
    profileUrl: string,
    opts: ProfileCaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
    /** Ended from outside: CaptureCancelledError at the next check, nothing more stored. */
    control?: Pick<CaptureControl, "cancelled" | "signal">,
  ): Promise<ProfileCaptureReport>;
  /** One link at a time, in order; `onProgress(done, total, outcome)` after each. */
  captureUrls(
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
    /**
     * `shouldStop` and `cancelled` are asked before each link; when true the queue stops there (the
     * outcomes so far are returned). `cancelled` is also asked when a download comes back and before
     * anything is stored: the link is then CANCELLED and nothing of it is stored.
     */
    control?: CaptureControl,
  ): Promise<CaptureOutcome[]>;
}

const VIDEO_EXT = new Set(["mp4", "webm", "mkv", "mov", "m4v", "flv", "avi", "3gp"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "opus", "ogg", "oga", "wav", "flac", "aac"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "avif"]);
const CAPTION_EXT = new Set(["vtt", "srt", "ttml", "ass", "lrc", "srv1", "srv2", "srv3", "json3"]);

const extOf = (p: string) => extname(p).slice(1).toLowerCase();
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function toolFor(c: ClassifiedUrl): CaptureTool {
  if (c.platform === "instagram" && (c.kind === "post" || c.kind === "story-highlight")) return "gallery-dl";
  if (c.platform === "tiktok" && c.kind === "carousel") return "gallery-dl";
  return "yt-dlp";
}

/** A BCP-47-looking language segment of a caption file name (`<id>.<lang>.vtt`). */
function captionLang(file: string): string {
  const parts = basename(file).split(".");
  const lang = parts.length >= 3 ? parts[parts.length - 2]! : "";
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : "und";
}

/** The `consent.defaultLegalBasis` category link capture uses. */
const LEGAL_CATEGORY = "social-media";
const REVIEW_NOTE = "Some details could not be confirmed, so the source is in the review queue.";
const COMMENTS_UNSUPPORTED_NOTE = "Comments cannot be saved for this kind of post, so none were saved.";

function failed(url: string, code: string, reason = plainReason(code)): CaptureOutcome {
  return { url, status: "failed", errorCode: code, reason };
}

/** A worker failure as an outcome; a missing tool is named, with how to get it (R126). */
function workerFailed(url: string, err: WorkerJobError): CaptureOutcome {
  if (err instanceof WorkerToolError && err.code === "TOOL_NOT_INSTALLED") return { ...failed(url, err.code, toolMissingReason(err.tool)), tool: err.tool };
  return failed(url, err.code);
}

/** One set of per-platform lanes per open library (repo), whichever queue or capture uses it (R116). */
const libraryLanes = new WeakMap<Repo, Map<Platform, Promise<unknown>>>();
function lanesFor(repo: Repo): Map<Platform, Promise<unknown>> {
  let lanes = libraryLanes.get(repo);
  if (!lanes) libraryLanes.set(repo, (lanes = new Map()));
  return lanes;
}

export function createLinkCapture(deps: LinkCaptureDeps): LinkCapture {
  const { repo, worker } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Per-platform queue, shared by every capture of this library: captures against one platform never overlap (R116). */
  const lanes = lanesFor(repo);
  const inLane = <T>(p: Platform, fn: () => Promise<T>): Promise<T> => {
    const prev = lanes.get(p) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    lanes.set(p, next.catch(() => {}));
    return next;
  };

  const acknowledged = (projectId: string) => !!repo.getProject(projectId).captureAcknowledgements?.cookies;

  async function findExisting(projectId: string, platform: Platform, postId: string): Promise<string | undefined> {
    const ids = new Set(repo.listSourceIds(projectId));
    if (deps.index) {
      try {
        const db = deps.index.db;
        const hit = findSourceBy(db, { platform, postId }).find((r) => r.projectId === projectId && ids.has(r.id));
        if (hit) return hit.id;
        // A miss is final only when the index is current for this project: its recorded change stamp
        // is the project's stamp now, and every source has its content (not only manifest rows) indexed.
        if (await indexCurrent(db, projectId, ids)) return undefined;
      } catch {
        // index unusable: fall back to the files
      }
    }
    // No index: read the project's sources (an encrypted project is unlocked here, since the policy
    // check above already required its key).
    for (const id of ids) {
      try {
        const sf = await repo.getSource(projectId, id);
        if (sf.source.identifiers.platform === platform && sf.source.identifiers.platformPostId === postId) return id;
      } catch {
        // unreadable source: not a match
      }
    }
    return undefined;
  }

  async function indexCurrent(db: IndexDb, projectId: string, ids: Set<string>): Promise<boolean> {
    const recorded = getMeta(db, "projectStamps");
    if (!recorded) return false;
    const stamp = (JSON.parse(recorded) as Record<string, unknown>)[projectId];
    if (JSON.stringify(stamp) !== JSON.stringify(await projectStampNow(repo, projectId))) return false;
    const indexed = new Set(
      (db.prepare("SELECT id FROM v_sources WHERE project_id = ? AND locked = 0").all(projectId) as Array<{ id: string }>).map((r) => r.id),
    );
    for (const id of ids) if (!indexed.has(id)) return false;
    return true;
  }

  async function readAny(path: string, encrypted: boolean, projectId: string): Promise<unknown> {
    try {
      let raw: Buffer = await fsp.readFile(path);
      if (encrypted) {
        const k = projectDataKey(repo, projectId)!;
        raw = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
      }
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  async function readJson(path: string, encrypted: boolean, projectId: string): Promise<Record<string, unknown> | undefined> {
    const v = await readAny(path, encrypted, projectId);
    return isRecord(v) ? v : undefined;
  }

  async function stillAllowed(projectId: string, platform: Platform): Promise<boolean> {
    try {
      await authorizeProcessing(repo, projectId, { action: "capture", capture: { method: "downloader", platform } }, { op: "capture.recheck" });
      return true;
    } catch (err) {
      if (err instanceof PolicyDeniedError) return false;
      throw err;
    }
  }

  /** A private work folder `<Library>/.tmp/capture-<id>/` (0700), swept if the process dies. */
  async function makeWork(): Promise<{ work: string; done: () => Promise<void> }> {
    const root = repoLibrary(repo).root;
    const name = `capture-${randomUUID()}`;
    const work = join(root, ".tmp", name);
    activeTemp.add(name);
    try {
      await fsp.mkdir(join(root, ".tmp"), { recursive: true });
      await fsp.mkdir(work, { mode: 0o700 });
      if (process.platform !== "win32") await fsp.chmod(work, 0o700);
    } catch (err) {
      activeTemp.delete(name);
      throw err;
    }
    return {
      work,
      done: async () => {
        await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
        activeTemp.delete(name);
      },
    };
  }

  /** Writes the stripped snapshot next to the downloads (encrypted like them) for storing as an original. */
  async function writeSnapshot(work: string, name: string, data: unknown, projectId: string, encrypted: boolean): Promise<string> {
    const path = join(work, name);
    const json = JSON.stringify(data, null, 2);
    if (encrypted) {
      const k = projectDataKey(repo, projectId)!;
      await fsp.writeFile(path, await encryptBytes(k.key, k.keyId, json), { mode: 0o600 });
    } else {
      await fsp.writeFile(path, json, { mode: 0o600 });
    }
    return path;
  }

  async function download(projectId: string, c: ClassifiedUrl, opts: CaptureOptions, work: string, metadataOnly: boolean, comments = false, signal?: AbortSignal): Promise<JobResult> {
    const tool = toolFor(c);
    return worker.submit(projectId, {
      type: "capture.download",
      input: c.canonicalUrl,
      output: work,
      ...(signal ? { signal } : {}),
      params: {
        tool,
        ...(opts.cookiesFromBrowser ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
        ...(opts.quality && tool === "yt-dlp" ? { quality: opts.quality } : {}),
        ...(metadataOnly ? { metadataOnly: true } : {}),
        ...(comments ? { includeComments: true } : {}),
      },
    });
  }

  /** `info` is already stripped. */
  async function refresh(projectId: string, sourceId: string, info: Record<string, unknown>, work: string, encrypted: boolean): Promise<void> {
    const at = new Date();
    const stamp = at.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const path = await writeSnapshot(work, "refresh.platform-metadata.json", info, projectId, encrypted);
    await repo.addOriginalAsset(projectId, sourceId, {
      fromPath: path,
      kind: "platform-metadata",
      ext: "json",
      label: `platform-metadata ${stamp}`,
      ...(encrypted ? { fromEncrypted: true } : {}),
      metadata: { capturedAt: at.toISOString() },
    });
  }

  /**
   * Runs the transcription of one media original and stores the transcript (.vtt and segments.json)
   * as derived assets. Throws what the worker client throws (PolicyDeniedError, WorkerJobError ...).
   */
  async function runTranscription(
    projectId: string,
    sf: SourceFile,
    media: Asset,
    params: { model?: string | undefined; language?: string | undefined },
    work: string,
    triggeredBy: string,
  ): Promise<{ files: string[]; flaggedSegments: number }> {
    const root = repoLibrary(repo).root;
    const r = await worker.submit(projectId, {
      type: "audio.transcribe",
      input: join(root, ...media.path.split("/")),
      inputEncrypted: media.encrypted,
      output: join(work, "transcript"),
      // The shared default (R158) when none is named, never the worker's own.
      params: { model: params.model ?? DEFAULT_SPEECH_MODEL, ...(params.language && params.language !== "auto" ? { language: params.language } : {}) },
      entity: { type: "asset", id: media.id },
    });
    return storeTranscript(repo, projectId, sf.source.id, media, r, params, triggeredBy);
  }

  async function transcribe(projectId: string, sf: SourceFile, media: Asset, opts: CaptureOptions, work: string): Promise<{ note: string; tool?: string } | undefined> {
    try {
      await runTranscription(projectId, sf, media, { model: opts.transcribeModel }, work, "capture");
    } catch (err) {
      if (err instanceof PolicyDeniedError) return { note: "The source was saved, but this project does not allow transcription." };
      if (err instanceof WorkerUnavailableError) return { note: "The source was saved, but the transcript could not be made because the media helper is not running." };
      // The speech model is missing (R126): named, with how to get it.
      if (err instanceof WorkerToolError && err.code === "TOOL_NOT_INSTALLED") return { note: transcriptToolMissingNote(err.tool), tool: err.tool };
      if (err instanceof WorkerJobError) return { note: "The source was saved, but the transcript could not be made." };
      return { note: "The source was saved, but the transcript could not be stored." };
    }
    return undefined;
  }

  /** The transcript of a source already in the project (spec 5.2): work folder private (0700) and removed afterwards. */
  async function transcribeSource(
    projectId: string,
    sourceId: string,
    opts: { model?: string; language?: string } = {},
  ): Promise<TranscribeSourceResult> {
    const sf = await repo.getSource(projectId, sourceId);
    const media = sf.assets.find((a) => a.role === "original" && (a.kind === "video" || a.kind === "audio"));
    if (!media) throw new NoMediaError(sourceId);
    const { work, done } = await makeWork();
    try {
      const r = await runTranscription(projectId, sf, media, opts, work, "cli");
      return { sourceId, folder: sf.source.folder, ...r };
    } finally {
      await done();
    }
  }

  async function captureOne(projectId: string, url: string, c: ClassifiedUrl, opts: CaptureOptions, item?: ItemContext, control?: CaptureControl): Promise<CaptureOutcome> {
    const platform = c.platform;
    /** Ended from outside (a lock, a close): checked when the download comes back and before each store. */
    const cancelled = () => !!(control?.cancelled?.() || item?.cancelled?.());
    const cookies = !!opts.cookiesFromBrowser;
    let identifiable: boolean;
    let legalBasis: string | undefined;
    if (item) {
      // A profile run: its one audited capture decision and the store checks are already made.
      ({ identifiable, legalBasis } = item);
    } else {
      // 2. Policy before anything is downloaded. The capture decision is audited here, once, whatever
      //    happens next (a deny is thrown); storing the result does not evaluate `capture` again.
      await authorizeProcessing(
        repo,
        projectId,
        { action: "capture", capture: { method: "downloader", platform } },
        { op: "capture.link", auditAllow: { details: { platform, cookies } } },
      );
      const policy = await projectPolicy(repo, projectId);
      identifiable = policy?.identifiability.containsIdentifiable ?? true;
      legalBasis = opts.legalBasis?.trim() || policy?.consent.defaultLegalBasis?.[LEGAL_CATEGORY]?.trim() || undefined;
      try {
        await authorizeProcessing(
          repo,
          projectId,
          { action: "store", store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } },
          { op: "capture.link" },
        );
      } catch (err) {
        if (err instanceof PolicyDeniedError && identifiable && policy?.consent.requireLegalBasis && !legalBasis) {
          return failed(url, "LEGAL_BASIS_REQUIRED");
        }
        throw err;
      }
    }

    // 4. Known post id: duplicates are found before downloading.
    let existing = c.postId ? await findExisting(projectId, platform, c.postId) : undefined;
    if (existing && !opts.refreshIfExists) return { url, status: "duplicate", sourceId: existing };

    const root = repoLibrary(repo).root;
    const { work, done } = await makeWork();
    try {
      // 5. Download. The raw tool output (info JSON with request headers) stays in this folder.
      let result: JobResult;
      try {
        result = await download(projectId, c, opts, work, !!existing || !!item?.metadataOnly, !existing && !!item?.includeComments, control?.signal ?? item?.signal);
      } catch (err) {
        if (err instanceof WorkerJobError) return workerFailed(url, err);
        if (err instanceof WorkerUnavailableError) return failed(url, "WORKER_UNAVAILABLE");
        throw err;
      }
      // Ended while it downloaded: the result is discarded (the work folder goes in `done`).
      if (cancelled()) return failed(url, "CANCELLED");
      const meta = result.meta;
      const files = (Array.isArray(meta.files) ? meta.files : []).filter((f): f is string => typeof f === "string");
      const infoFiles = (Array.isArray(meta.infoJson) ? meta.infoJson : []).filter((f): f is string => typeof f === "string").sort();
      const partialCode = meta.partial === true ? (typeof meta.errorCode === "string" ? meta.errorCode : "EXTRACTOR_ERROR") : undefined;
      const toolName = typeof meta.tool === "string" ? meta.tool : toolFor(c);
      const toolVersion = typeof meta.toolVersion === "string" && meta.toolVersion ? meta.toolVersion : "unknown";
      const tool = (toolName === "gallery-dl" ? "gallery-dl" : "yt-dlp") as CaptureTool;
      const raw = infoFiles.length ? await readJson(infoFiles[0]!, result.encrypted, projectId) : undefined;
      // Only the stripped form ever leaves the work folder.
      const stored = stripSnapshot(raw ?? {}, { localPrefixes: [root] });
      const snap = verificationSnapshot(stored, c, tool);

      // Post id known only now (short links): the duplicate check again.
      const postId = c.postId ?? (typeof snap.id === "string" || typeof snap.id === "number" ? String(snap.id) : undefined);
      if (!existing && postId) existing = await findExisting(projectId, platform, postId);
      if (existing) {
        if (!opts.refreshIfExists) return { url, status: "duplicate", sourceId: existing };
        if (!raw) return failed(url, partialCode ?? "NOTHING_SAVED");
        if (!(await stillAllowed(projectId, platform))) return failed(url, "POLICY_CHANGED");
        if (cancelled()) return failed(url, "CANCELLED");
        await refresh(projectId, existing, stored, work, result.encrypted);
        return { url, status: "refreshed", sourceId: existing };
      }
      if (!raw && files.length === 0) return failed(url, partialCode ?? "NOTHING_SAVED");

      // 6. Draft, evidence, verification.
      const at = new Date().toISOString();
      const { draft, evidence } = buildDraft(snap, stored, c, tool, at);
      const report = verifyDraft(draft, evidence, { platformSnapshot: snap });

      const media: string[] = [];
      const thumbs: string[] = [];
      const captions: string[] = [];
      const hasAV = files.some((f) => VIDEO_EXT.has(extOf(f)) || AUDIO_EXT.has(extOf(f)));
      for (const f of files) {
        const ext = extOf(f);
        if (CAPTION_EXT.has(ext)) captions.push(f);
        else if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) media.push(f);
        else if (IMAGE_EXT.has(ext)) (tool === "yt-dlp" && hasAV ? thumbs : media).push(f);
      }
      const enc = result.encrypted ? { encrypted: true } : {};
      const inputs: SourceInputFile[] = [
        ...media.map((path) => ({ path, role: "original" as const, handling: "copy" as const, ...enc })),
        ...thumbs.map((path) => ({ path, role: "original" as const, handling: "copy" as const, kind: "thumbnail", ...enc })),
      ];
      if (raw) {
        const path = await writeSnapshot(work, "snapshot.platform-metadata.json", stored, projectId, result.encrypted);
        inputs.push({ path, role: "original", handling: "copy", kind: "platform-metadata", metadata: { capturedAt: at }, ...enc });
      }
      // Comments (third-party personal data): stripped like the snapshot, a separate original.
      const commentFiles = (Array.isArray(meta.comments) ? meta.comments : []).filter((f): f is string => typeof f === "string").sort();
      for (const [i, f] of commentFiles.entries()) {
        const list = await readAny(f, result.encrypted, projectId);
        if (!Array.isArray(list)) continue;
        const path = await writeSnapshot(work, `comments-${i}.platform-comments.json`, stripSnapshot(list, { localPrefixes: [root] }), projectId, result.encrypted);
        inputs.push({ path, role: "original", handling: "copy", kind: "platform-comments", metadata: { capturedAt: at }, ...enc });
      }
      const provenance: Provenance = {
        captureMethod: "downloader",
        capturedAt: at,
        originalUrl: c.canonicalUrl,
        tool: { name: toolName, version: toolVersion },
        fileHashes: {},
        ...(item ? { importBatchId: item.importBatchId } : {}),
        platformSnapshot: snap,
        identification: { method: "platform-json", confidence: applyVerification(1, report) },
        // Public only when the platform itself says so and no signed-in session was used.
        legal: { status: !cookies && raw?.availability === "public" ? "public" : "unknown", ...(legalBasis ? { basis: legalBasis } : {}) },
        identifiable,
        access: cookies ? "signed-in-session" : "public",
      };
      const needsReview = report.overall === "needs-review";
      // Something was saved but the tool stopped with an error, or no media file came back: an
      // incomplete source, labeled with why.
      const incomplete = partialCode ?? (media.length === 0 && !item?.metadataOnly ? "NO_MEDIA" : undefined);
      if (item) draft.collectionIds = [...item.collectionIds];
      // Immediately before storing: the rules may have changed during the download (R42).
      if (!(await stillAllowed(projectId, platform))) return failed(url, "POLICY_CHANGED");
      if (cancelled()) return failed(url, "CANCELLED");
      const sf = await createSourcePreAuthorized(repo, projectId, draft, inputs, {
        provenance,
        fieldEvidence: evidence,
        verification: report.fields,
        ...(incomplete ? { availability: { status: "incomplete", reason: incompleteReason(incomplete), firstNoticedAt: at } } : {}),
        ...(needsReview
          ? {
              reviewItem: {
                fields: Object.fromEntries(
                  Object.entries(report.fields).filter(([, v]) => v.status === "conflict" || v.status === "unverified").map(([k, v]) => [k, v.status]),
                ),
                reasons: report.reasons,
                cause: { kind: "capture-conflict" as const },
              },
            }
          : {}),
      });

      // 7. Captions and transcript. The source exists now: a failure here is reported, never as "nothing saved".
      const notes: string[] = [];
      if (item?.includeComments && meta.commentsUnsupported === true) notes.push(COMMENTS_UNSUPPORTED_NOTE);
      const firstMedia = sf.assets.find((a) => a.role === "original" && (a.kind === "video" || a.kind === "audio"));
      const parent = firstMedia ?? sf.assets.find((a) => a.role === "original" && a.kind !== "platform-metadata");
      let captionsFailed = false;
      for (const f of captions) {
        try {
          await repo.addDerivedAsset(projectId, sf.source.id, {
            fromPath: f,
            kind: "platform-captions",
            lang: captionLang(f),
            tool: "platform",
            ext: extOf(f),
            ...(result.encrypted ? { fromEncrypted: true } : {}),
            derivation: {
              parents: parent ? [parent.id] : [],
              operation: "platform-captions",
              provider: "platform",
              ranAt: platform,
              params: { tool: toolName },
              at,
              triggeredBy: "capture",
            },
          });
        } catch {
          captionsFailed = true;
        }
      }
      if (captionsFailed) notes.push("The source was saved, but some captions could not be stored.");
      let missingTool: string | undefined;
      const wantTranscript = opts.transcribe === "project-default" ? repo.getProject(projectId).automation?.transcribeNewMedia === true : opts.transcribe;
      // Ended after the source was stored (before the end): no transcript is made for it now.
      if (wantTranscript && firstMedia && !cancelled()) {
        const t = await transcribe(projectId, sf, firstMedia, opts, work);
        if (t) notes.push(t.note);
        if (t?.tool) missingTool = t.tool;
      }

      const base = { url, sourceId: sf.source.id, ...(missingTool ? { tool: missingTool } : {}) };
      if (incomplete) return { ...base, status: "incomplete", errorCode: incomplete, reason: [incompleteReason(incomplete), ...notes].join(" ") };
      if (needsReview) return { ...base, status: "needs-review", reason: [REVIEW_NOTE, ...notes].join(" ") };
      return { ...base, status: "created", ...(notes.length ? { reason: notes.join(" ") } : {}) };
    } finally {
      await done();
    }
  }

  async function fetchMetadata(projectId: string, c: ClassifiedUrl, opts: CaptureOptions, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const { work, done } = await makeWork();
    try {
      let r: JobResult;
      try {
        r = await download(projectId, c, opts, work, true, false, signal);
      } catch (err) {
        if (err instanceof WorkerJobError || err instanceof WorkerUnavailableError) return undefined;
        throw err;
      }
      const infos = (Array.isArray(r.meta.infoJson) ? r.meta.infoJson : []).filter((f): f is string => typeof f === "string").sort();
      const raw = infos.length ? await readJson(infos[0]!, r.encrypted, projectId) : undefined;
      return raw ? stripSnapshot(raw, { localPrefixes: [repoLibrary(repo).root] }) : undefined;
    } finally {
      await done();
    }
  }

  const core: CaptureCore = {
    repo,
    worker,
    sleep,
    inLane,
    acknowledged,
    findExisting,
    stillAllowed,
    readJson: readAny,
    writeJson: writeSnapshot,
    makeWork,
    fetchMetadata,
    captureItem: captureOne,
  };
  const profiles = createProfileCapture(core);

  async function captureUrl(projectId: string, url: string, opts: CaptureOptions, control?: CaptureControl): Promise<CaptureOutcome> {
    // The browser session needs the one-time acknowledgement, whatever the link is.
    if (opts.cookiesFromBrowser && !acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);
    const c = classifyUrl(url);
    if (isCollectionLink(c)) {
      if (deps.captureProfile) return deps.captureProfile(projectId, url, opts);
      try {
        return profiles.outcomeOf(url, await profiles.captureProfile(projectId, url, opts, undefined, control));
      } catch (err) {
        if (err instanceof CaptureCancelledError) return failed(url, "CANCELLED");
        throw err;
      }
    }
    if (c.platform === "other") return failed(url, "UNSUPPORTED_URL");
    return inLane(c.platform, () => captureOne(projectId, url, c, opts, undefined, control));
  }

  async function captureUrls(
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
    control: CaptureControl = {},
  ): Promise<CaptureOutcome[]> {
    // Ask once, before the queue starts.
    if (opts.cookiesFromBrowser && !acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);
    const out: CaptureOutcome[] = [];
    for (const url of urls) {
      // Stopped between links (a library move, R106): the rest is for the caller to run again.
      if (control.shouldStop?.() || control.cancelled?.()) break;
      let o: CaptureOutcome;
      try {
        o = await captureUrl(projectId, url, opts, control);
      } catch (err) {
        if (err instanceof AcknowledgementRequiredError) throw err;
        if (err instanceof PolicyDeniedError) o = failed(url, "POLICY_DENIED", err.reason);
        else if (err instanceof ProjectLockedError) o = failed(url, "PROJECT_LOCKED", "The project is locked. Unlock it, then try again.");
        else o = failed(url, "CAPTURE_FAILED");
      }
      out.push(o);
      try {
        onProgress?.(out.length, urls.length, o);
      } catch {
        // a progress callback must not stop the queue
      }
    }
    return out;
  }

  return { captureUrl: (projectId, url, opts) => captureUrl(projectId, url, opts), captureUrls, captureProfile: profiles.captureProfile, transcribeSource };
}
