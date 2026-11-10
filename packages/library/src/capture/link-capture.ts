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
 * Reasons in outcomes are fixed plain-language sentences (errors.ts): never cookies, tokens, URLs
 * or file paths. Captures against one platform never run in parallel.
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { applyVerification, verifyDraft, type Asset, type Provenance, type SourceFile } from "@ao/core";
import type { IndexDb } from "../index/db.js";
import { findSourceBy } from "../index/db.js";
import { decryptBytes, encryptBytes } from "../repo/io.js";
import { authorizeProcessing, projectDataKey, projectPolicy, repoLibrary, type Repo } from "../repo/repo.js";
import { PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import type { SourceInputFile } from "../repo/sources.js";
import { WorkerJobError, WorkerUnavailableError, type JobResult, type WorkerClient } from "../worker-client.js";
import { AcknowledgementRequiredError, incompleteReason, plainReason } from "./errors.js";
import { classifyUrl, type ClassifiedUrl, type Platform } from "./platforms.js";
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
}

export type CaptureStatus = "created" | "duplicate" | "refreshed" | "incomplete" | "failed" | "needs-review";

export interface CaptureOutcome {
  url: string;
  status: CaptureStatus;
  sourceId?: string;
  reason?: string;
  errorCode?: string;
}

export interface LinkCaptureDeps {
  repo: Repo;
  worker: WorkerClient;
  /** The library index (an IndexHandle or `{ db }`), for duplicate lookups; without it the project's sources are read. */
  index?: { readonly db: IndexDb };
  /** Profile and playlist capture (Task 18). Without it such links fail with a plain reason. */
  captureProfile?: (projectId: string, url: string, opts: CaptureOptions) => Promise<CaptureOutcome>;
}

export interface LinkCapture {
  captureUrl(projectId: string, url: string, opts: CaptureOptions): Promise<CaptureOutcome>;
  /** One link at a time, in order; `onProgress(done, total, outcome)` after each. */
  captureUrls(
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
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

function failed(url: string, code: string, reason = plainReason(code)): CaptureOutcome {
  return { url, status: "failed", errorCode: code, reason };
}

export function createLinkCapture(deps: LinkCaptureDeps): LinkCapture {
  const { repo, worker } = deps;
  /** Per-platform queue: captures against one platform never overlap. */
  const lanes = new Map<Platform, Promise<unknown>>();
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
        const hit = findSourceBy(deps.index.db, { platform, postId }).find((r) => r.projectId === projectId && ids.has(r.id));
        return hit?.id;
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

  async function readJson(path: string, encrypted: boolean, projectId: string): Promise<Record<string, unknown> | undefined> {
    try {
      let raw: Buffer = await fsp.readFile(path);
      if (encrypted) {
        const k = projectDataKey(repo, projectId)!;
        raw = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
      }
      const v = JSON.parse(raw.toString("utf8")) as unknown;
      return isRecord(v) ? v : undefined;
    } catch {
      return undefined;
    }
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

  async function download(projectId: string, c: ClassifiedUrl, opts: CaptureOptions, work: string, metadataOnly: boolean): Promise<JobResult> {
    const tool = toolFor(c);
    return worker.submit(projectId, {
      type: "capture.download",
      input: c.canonicalUrl,
      output: work,
      params: {
        tool,
        ...(opts.cookiesFromBrowser ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
        ...(opts.quality && tool === "yt-dlp" ? { quality: opts.quality } : {}),
        ...(metadataOnly ? { metadataOnly: true } : {}),
      },
    });
  }

  async function refresh(projectId: string, sourceId: string, info: Record<string, unknown>, work: string, encrypted: boolean): Promise<void> {
    const at = new Date();
    const stamp = at.toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const path = await writeSnapshot(work, "refresh.platform-metadata.json", stripSnapshot(info), projectId, encrypted);
    await repo.addOriginalAsset(projectId, sourceId, {
      fromPath: path,
      kind: "platform-metadata",
      ext: "json",
      label: `platform-metadata ${stamp}`,
      ...(encrypted ? { fromEncrypted: true } : {}),
      metadata: { capturedAt: at.toISOString() },
    });
  }

  async function transcribe(projectId: string, sf: SourceFile, media: Asset, opts: CaptureOptions, work: string): Promise<string | undefined> {
    const root = repoLibrary(repo).root;
    let r: JobResult;
    try {
      r = await worker.submit(projectId, {
        type: "audio.transcribe",
        input: join(root, ...media.path.split("/")),
        inputEncrypted: media.encrypted,
        output: join(work, "transcript"),
        params: opts.transcribeModel ? { model: opts.transcribeModel } : {},
        entity: { type: "asset", id: media.id },
      });
    } catch (err) {
      if (err instanceof PolicyDeniedError) return "The source was saved, but this project does not allow transcription.";
      if (err instanceof WorkerUnavailableError) return "The source was saved, but the transcript could not be made because the media helper is not running.";
      return "The source was saved, but the transcript could not be made.";
    }
    const meta = r.meta;
    const model = typeof meta.model === "string" ? meta.model : (opts.transcribeModel ?? "whisper");
    const langs = Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages.filter((l): l is string => typeof l === "string") : [];
    const lang = langs.length === 1 ? langs[0]! : langs.length > 1 ? "mul" : "und";
    const flagged = typeof meta.flaggedCount === "number" ? meta.flaggedCount : undefined;
    const at = new Date().toISOString();
    for (const ext of ["vtt", "json"]) {
      const file = r.files.find((f) => basename(f) === (ext === "vtt" ? "transcript.vtt" : "segments.json"));
      if (!file) continue;
      await repo.addDerivedAsset(projectId, sf.source.id, {
        fromPath: file,
        kind: "transcript",
        lang,
        tool: `whisper-${model}`,
        ext,
        ...(r.encrypted ? { fromEncrypted: true } : {}),
        ...(flagged !== undefined ? { metadata: { flaggedSegments: flagged } } : {}),
        derivation: {
          parents: [media.id],
          operation: "transcribe",
          provider: "faster-whisper",
          model,
          ranAt: "local",
          params: { model, detectedLanguages: langs },
          at,
          triggeredBy: "capture",
        },
      });
    }
    return undefined;
  }

  async function captureOne(projectId: string, url: string, c: ClassifiedUrl, opts: CaptureOptions): Promise<CaptureOutcome> {
    const platform = c.platform;
    // 2. Policy before anything is downloaded (a deny is audited and thrown).
    await authorizeProcessing(repo, projectId, { action: "capture", capture: { method: "downloader", platform } }, { op: "capture.link" });
    const policy = await projectPolicy(repo, projectId);
    const identifiable = policy?.identifiability.containsIdentifiable ?? true;
    await authorizeProcessing(repo, projectId, { action: "store", store: { identifiable, hasLocation: false } }, { op: "capture.link" });
    // 3. The browser session needs the one-time acknowledgement.
    if (opts.cookiesFromBrowser && !acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);

    // 4. Known post id: duplicates are found before downloading.
    let existing = c.postId ? await findExisting(projectId, platform, c.postId) : undefined;
    if (existing && !opts.refreshIfExists) return { url, status: "duplicate", sourceId: existing };

    const root = repoLibrary(repo).root;
    const work = join(root, ".tmp", `capture-${randomUUID()}`);
    try {
      // 5. Download.
      let result: JobResult;
      try {
        result = await download(projectId, c, opts, work, !!existing);
      } catch (err) {
        if (err instanceof WorkerJobError) return failed(url, err.code);
        if (err instanceof WorkerUnavailableError) return failed(url, "WORKER_UNAVAILABLE");
        throw err;
      }
      const meta = result.meta;
      const files = (Array.isArray(meta.files) ? meta.files : []).filter((f): f is string => typeof f === "string");
      const infoFiles = (Array.isArray(meta.infoJson) ? meta.infoJson : []).filter((f): f is string => typeof f === "string").sort();
      const partialCode = meta.partial === true ? (typeof meta.errorCode === "string" ? meta.errorCode : "EXTRACTOR_ERROR") : undefined;
      const toolName = typeof meta.tool === "string" ? meta.tool : toolFor(c);
      const toolVersion = typeof meta.toolVersion === "string" && meta.toolVersion ? meta.toolVersion : "unknown";
      const raw = infoFiles.length ? await readJson(infoFiles[0]!, result.encrypted, projectId) : undefined;

      // Post id known only now (short links): the duplicate check again.
      const postId = c.postId ?? (raw && (typeof raw.id === "string" || typeof raw.id === "number") ? String(raw.id) : undefined);
      if (!existing && postId) existing = await findExisting(projectId, platform, postId);
      if (existing) {
        if (!opts.refreshIfExists) return { url, status: "duplicate", sourceId: existing };
        if (!raw) return failed(url, partialCode ?? "NOTHING_SAVED");
        await refresh(projectId, existing, raw, work, result.encrypted);
        return { url, status: "refreshed", sourceId: existing };
      }
      if (!raw && files.length === 0) return failed(url, partialCode ?? "NOTHING_SAVED");

      // 6. Draft, evidence, verification.
      const at = new Date().toISOString();
      const tool = (toolName === "gallery-dl" ? "gallery-dl" : "yt-dlp") as CaptureTool;
      const stored = stripSnapshot(raw ?? {});
      const snap = verificationSnapshot(stored, c, tool);
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
      const provenance: Provenance = {
        captureMethod: "downloader",
        capturedAt: at,
        originalUrl: c.canonicalUrl,
        tool: { name: toolName, version: toolVersion },
        fileHashes: {},
        platformSnapshot: snap,
        identification: { method: "platform-json", confidence: applyVerification(1, report) },
        // Seen through a signed-in session, the post is not necessarily public.
        legal: { status: opts.cookiesFromBrowser ? "unknown" : "public" },
        identifiable,
      };
      const needsReview = report.overall === "needs-review";
      // Something was saved but the tool stopped with an error: an incomplete source, labeled with why.
      const incomplete = partialCode;
      const sf = await repo.createSource(projectId, draft, inputs, {
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
              },
            }
          : {}),
      });

      // 7. Captions and transcript.
      const firstMedia = sf.assets.find((a) => a.role === "original" && (a.kind === "video" || a.kind === "audio"));
      const parent = firstMedia ?? sf.assets.find((a) => a.role === "original" && a.kind !== "platform-metadata");
      for (const f of captions) {
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
      }
      const wantTranscript = opts.transcribe === "project-default" ? repo.getProject(projectId).automation?.transcribeNewMedia === true : opts.transcribe;
      let note: string | undefined;
      if (wantTranscript && firstMedia) note = await transcribe(projectId, sf, firstMedia, opts, work);

      if (incomplete) return { url, status: "incomplete", sourceId: sf.source.id, errorCode: incomplete, reason: incompleteReason(incomplete) };
      if (needsReview) {
        return { url, status: "needs-review", sourceId: sf.source.id, reason: note ?? "Some details could not be confirmed, so the source is in the review queue." };
      }
      return { url, status: "created", sourceId: sf.source.id, ...(note ? { reason: note } : {}) };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function captureUrl(projectId: string, url: string, opts: CaptureOptions): Promise<CaptureOutcome> {
    const c = classifyUrl(url);
    if (c.kind === "profile" || c.kind === "playlist") {
      return deps.captureProfile ? deps.captureProfile(projectId, url, opts) : failed(url, "PROFILE_CAPTURE_UNAVAILABLE");
    }
    if (c.platform === "other") return failed(url, "UNSUPPORTED_URL");
    return inLane(c.platform, () => captureOne(projectId, url, c, opts));
  }

  async function captureUrls(
    projectId: string,
    urls: string[],
    opts: CaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
  ): Promise<CaptureOutcome[]> {
    // Ask once, before the queue starts.
    if (opts.cookiesFromBrowser && !acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);
    const out: CaptureOutcome[] = [];
    for (const url of urls) {
      let o: CaptureOutcome;
      try {
        o = await captureUrl(projectId, url, opts);
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

  return { captureUrl, captureUrls };
}
