/**
 * Profile capture (spec 5.5): a whole YouTube channel or playlist, Instagram profile or TikTok
 * profile, re-run incrementally.
 *
 *   1. the cookie acknowledgement and the options are checked; then, before anything is
 *      downloaded, ONE audited `capture` decision for the run and the `store` checks (legal basis;
 *      with `includeComments` also `store` with `identifiable: true`, since comments are
 *      third-party personal data);
 *   2. the profile is enumerated (`flatList`, metadata only); a rate-limited enumeration waits
 *      60, 120 and 240 s (injectable `sleep`), then the run pauses (`paused-rate-limited`);
 *   3. the profile Source (type `social-post`, case attribute `genre: profile`, title = display
 *      name or handle), the collection `Profile: <handle or P-code>`, and the dated profile
 *      snapshot (a derived asset of the profile source and `snapshots/…json`) are stored;
 *   4. every post not yet in the project is captured through the link-capture per-item path, with
 *      the run's import batch id (an ImportBatch of kind `profile-capture`,
 *      `imports/batch-<NNNN>/{batch.json, journal.jsonl}`) and the collection; after each stored
 *      post the journal, `profile.json` (`knownPostIds`) and `archive.txt` are updated in one change,
 *      so a re-run (after a pause or crash) resumes where it stopped. A rate-limited post waits
 *      60/120/240 s like the enumeration, then the run pauses;
 *   5. posts already known: an edited caption adds a new dated platform-metadata snapshot (an
 *      original; the first snapshot is never modified) and a title variant, rechecked; a post that
 *      is listed again after being missing has its `unavailable-on-platform` flag cleared;
 *   6. removed detection — only when the enumeration was complete (not cut short, not filtered by
 *      date, type or maximum, and the run not paused): known posts missing from the list get
 *      `availability: unavailable-on-platform` with `firstNoticedAt` (set once);
 *   7. the report `reports/capture - modified <YYYY-MM-DD HHmm>.md` (plain language, no links, no
 *      paths) and the finished batch record are written, and the run is audited (`capture.profile`).
 *
 * Files under `profiles/<platform>-<handle>/` and `imports/` are encrypted (`.enc`) in encrypted
 * projects; when the project's rules pseudonymize names, the folder and collection use the
 * profile's participant code (`tiktok-P-001`) and the handle is only inside the encrypted files.
 * `archive.txt` uses the download-archive format (`<extractor> <id>`, one stored post per line);
 * the library writes it after each stored post, so it never lists a post that was not saved.
 *
 * Immediately before each store the `capture` decision is evaluated again (no allow audited): if
 * the rules changed during the run, it stops with `POLICY_CHANGED` and one audited deny.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  ImportBatch,
  ImportOptions,
  applyVerification,
  datedFileName,
  encName,
  newId,
  recheckSourceFile,
  sanitizeSegment,
  verifyDraft,
  withCollisionSuffix,
  type FieldEvidence,
  type MultiText,
  type Provenance,
  type SourceDraft,
} from "@ao/core";
import { PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import { decryptBytes, foldName, namesIn, readMaybe, sealLine } from "../repo/io.js";
import type { MutateRequest } from "../repo/mutate.js";
import {
  appendLibraryEvent,
  authorizeProcessing,
  createSourcePreAuthorized,
  projectDataKey,
  projectPolicy,
  pseudonymCodeFor,
  repoLibrary,
  repoTz,
  updateSourceRechecked,
} from "../repo/repo.js";
import { WorkerJobError, WorkerUnavailableError } from "../worker-client.js";
import { AcknowledgementRequiredError, plainReason } from "./errors.js";
import type { CaptureCore, CaptureOptions, CaptureOutcome, ItemContext } from "./link-capture.js";
import { classifyUrl, type ClassifiedUrl, type Platform } from "./platforms.js";
import { captionOf, profileSnapshot, readEnumeration, type ProfileEntry, type ProfileMeta } from "./profile-snapshot.js";
import { firstLine, stripSnapshot, type CaptureTool } from "./snapshot.js";

export type ProfileContentType = "posts" | "reels" | "videos" | "shorts" | "highlights";

export interface ProfileCaptureOptions extends CaptureOptions {
  /** Only posts from this day on (YYYY-MM-DD). */
  since?: string;
  /** Only posts up to this day (YYYY-MM-DD, inclusive). */
  until?: string;
  /** Which parts of the profile to list (default: the profile's main list). */
  contentTypes?: ProfileContentType[];
  maxItems?: number;
  /** The posts' data without their media. */
  metadataOnly?: boolean;
  /** Also save each new post's comments (third-party personal data; default false). */
  includeComments?: boolean;
}

export type ProfileRunStatus = "completed" | "paused-rate-limited" | "failed";

export interface ProfileCaptureReport {
  status: ProfileRunStatus;
  /** Undefined only when the run failed before the profile was recorded. */
  profileSourceId?: string;
  /** The run's import batch (every source the run created carries it). */
  batchId?: string;
  /** The enumeration listed the whole profile (removed-post detection ran). */
  listComplete: boolean;
  created: number;
  duplicates: number;
  incomplete: number;
  failed: number;
  newlyUnavailable: number;
  /** Posts listed again after being marked unavailable. */
  reappeared: number;
  edited: number;
  items: CaptureOutcome[];
  errorCode?: string;
  reason?: string;
}

/** `profiles/<platform>-<handle or P-code>/profile.json` (encrypted in encrypted projects). */
export interface ProfileRecord {
  platform: Platform;
  handle: string;
  profileSourceId: string;
  collectionId: string;
  firstCapturedAt: string;
  lastCapturedAt: string;
  knownPostIds: string[];
}

const BACKOFF_MS = [60_000, 120_000, 240_000];
const LEGAL_CATEGORY = "social-media";
const CONTENT_TYPES = new Set<ProfileContentType>(["posts", "reels", "videos", "shorts", "highlights"]);
const JOURNAL_PURPOSE = "ao-import-journal";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

function validDay(s: string | undefined): boolean {
  if (s === undefined) return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s;
}

function invalidOptions(o: ProfileCaptureOptions): boolean {
  if (!validDay(o.since) || !validDay(o.until) || (o.since && o.until && o.since > o.until)) return true;
  if (o.maxItems !== undefined && (!Number.isInteger(o.maxItems) || o.maxItems < 1)) return true;
  if (o.contentTypes !== undefined && (!Array.isArray(o.contentTypes) || o.contentTypes.some((t) => !CONTENT_TYPES.has(t)))) return true;
  return false;
}

/** The part of a profile link that names it when no handle is in the link (channel id, playlist id). */
function linkKey(c: ClassifiedUrl): string {
  if (c.handle) return c.handle;
  const u = new URL(c.canonicalUrl);
  return u.searchParams.get("list") ?? u.pathname.split("/").filter(Boolean).at(-1) ?? "profile";
}

/** The links to enumerate for the chosen content types. */
function enumerationUrls(c: ClassifiedUrl, types: ProfileContentType[] | undefined): string[] {
  if (!types?.length || c.kind === "playlist") return [c.canonicalUrl];
  const base = c.canonicalUrl.replace(/\/+$/, "");
  const out = new Set<string>();
  for (const t of types) {
    if (c.platform === "youtube") out.add(t === "shorts" ? `${base}/shorts` : `${base}/videos`);
    else if (c.platform === "instagram") out.add(t === "reels" ? `${base}/reels/` : t === "highlights" ? `${base}/highlights/` : `${base}/`);
    else out.add(base);
  }
  return [...out];
}

const ymd = (s: string) => s.replaceAll("-", "");

/** The extractor name of the download-archive format. */
const archiveLine = (platform: Platform, id: string) => `${platform} ${id}`;

export function createProfileCapture(core: CaptureCore) {
  const { repo, worker } = core;

  function failedReport(code: string, extra: Partial<ProfileCaptureReport> = {}): ProfileCaptureReport {
    return {
      status: "failed",
      listComplete: false,
      created: 0,
      duplicates: 0,
      incomplete: 0,
      failed: 0,
      newlyUnavailable: 0,
      reappeared: 0,
      edited: 0,
      items: [],
      ...extra,
      errorCode: code,
      reason: plainReason(code),
    };
  }

  async function readProjectFile(projectId: string, rel: string): Promise<string | undefined> {
    const root = repoLibrary(repo).root;
    const key = projectDataKey(repo, projectId);
    const raw = await readMaybe(join(root, ...(key ? encName(rel) : rel).split("/")));
    if (!raw) return undefined;
    if (!key) return raw.toString("utf8");
    return (await decryptBytes((id) => (id === key.keyId ? key.key : undefined), raw)).toString("utf8");
  }

  async function captureProfile(
    projectId: string,
    profileUrl: string,
    opts: ProfileCaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
  ): Promise<ProfileCaptureReport> {
    if (opts.cookiesFromBrowser && !core.acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);
    const c = classifyUrl(profileUrl);
    if ((c.kind !== "profile" && c.kind !== "playlist") || c.platform === "other") return failedReport("UNSUPPORTED_URL");
    if (invalidOptions(opts)) return failedReport("INVALID_OPTIONS");
    return core.inLane(c.platform, () => run(projectId, c, opts, onProgress));
  }

  async function run(
    projectId: string,
    c: ClassifiedUrl,
    opts: ProfileCaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
  ): Promise<ProfileCaptureReport> {
    const platform = c.platform;
    const cookies = !!opts.cookiesFromBrowser;
    const includeComments = opts.includeComments === true;
    const tool: CaptureTool = platform === "instagram" ? "gallery-dl" : "yt-dlp";
    const root = repoLibrary(repo).root;

    // 1. Policy, before anything is downloaded: one audited capture decision for the whole run.
    await authorizeProcessing(
      repo,
      projectId,
      { action: "capture", capture: { method: "downloader", platform } },
      { op: "capture.profile", auditAllow: { details: { platform, cookies, comments: includeComments } } },
    );
    const policy = await projectPolicy(repo, projectId);
    const identifiable = policy?.identifiability.containsIdentifiable ?? true;
    const legalBasis = opts.legalBasis?.trim() || policy?.consent.defaultLegalBasis?.[LEGAL_CATEGORY]?.trim() || undefined;
    const storeCheck = async (ident: boolean, op: string): Promise<boolean> => {
      try {
        await authorizeProcessing(repo, projectId, { action: "store", store: { identifiable: ident, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } }, { op });
        return true;
      } catch (err) {
        if (err instanceof PolicyDeniedError && ident && policy?.consent.requireLegalBasis && !legalBasis) return false;
        throw err;
      }
    };
    if (!(await storeCheck(identifiable, "capture.profile"))) return failedReport("LEGAL_BASIS_REQUIRED");
    // Comments are third-party personal data: identifiable storage must be allowed before any download.
    if (includeComments && !(await storeCheck(true, "capture.profile.comments"))) return failedReport("LEGAL_BASIS_REQUIRED");
    const pseudonymize = !!policy?.identifiability.pseudonymizeFileNames && identifiable;
    const storeReq: MutateRequest = { action: "store", store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } };
    const anyIdentifiable = identifiable || includeComments;

    const report: ProfileCaptureReport = {
      status: "completed",
      listComplete: false,
      created: 0,
      duplicates: 0,
      incomplete: 0,
      failed: 0,
      newlyUnavailable: 0,
      reappeared: 0,
      edited: 0,
      items: [],
    };
    let waits = 0;
    /** Waits before the next attempt; false when the waits are used up (the run pauses). */
    const backOff = async (): Promise<boolean> => {
      if (waits >= BACKOFF_MS.length) return false;
      await core.sleep(BACKOFF_MS[waits++]!);
      return true;
    };
    const pause = () => Object.assign(report, { status: "paused-rate-limited" as const, reason: plainReason("RATE_LIMITED_PAUSED") });
    const policyChanged = () => Object.assign(report, { status: "failed" as const, errorCode: "POLICY_CHANGED", reason: plainReason("POLICY_CHANGED") });

    // 2. Enumerate.
    let docs: unknown[] = [];
    let partial = false;
    let toolVersion = "unknown";
    for (;;) {
      const r = await enumerate(projectId, c, opts, tool);
      // Rate limited, even part-way through the list: wait and list again, or pause.
      if (r.error === "RATE_LIMITED" || r.partialCode === "RATE_LIMITED") {
        if (await backOff()) continue;
        pause();
        return audited(projectId, platform, report);
      }
      if (r.error) return audited(projectId, platform, failedReport(r.error));
      ({ docs, toolVersion } = r);
      partial = !!r.partialCode;
      break;
    }
    const { profile, entries: listed } = readEnumeration(docs, c, tool);
    const sinceTs = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) / 1000 : undefined;
    const untilTs = opts.until ? Date.parse(`${opts.until}T00:00:00Z`) / 1000 + 86400 : undefined;
    let entries = listed.filter((e) => e.timestamp === undefined || ((sinceTs === undefined || e.timestamp >= sinceTs) && (untilTs === undefined || e.timestamp < untilTs)));
    if (opts.maxItems !== undefined) entries = entries.slice(0, opts.maxItems);
    const filtered = !!(opts.since || opts.until || opts.contentTypes?.length || (opts.maxItems !== undefined && listed.length >= opts.maxItems));

    // 3. The profile: record, source, collection, snapshot.
    if (!(await core.stillAllowed(projectId, platform))) return audited(projectId, platform, policyChanged());
    const handle = c.handle ?? profile.handle;
    const label = handle ?? linkKey(c);
    const names = [label, label.replace(/^@+/, ""), `@${label.replace(/^@+/, "")}`, ...(profile.handle ? [profile.handle] : [])];
    const projectRel = repo.getProject(projectId).folder;
    const folderOf = (name: string) => `${platform}-${sanitizeSegment(name.replace(/^@+/, ""), 100)}`;
    let code = pseudonymize ? await pseudonymCodeFor(repo, projectId, names) : undefined;
    let folderName = pseudonymize ? (code ? folderOf(code) : undefined) : folderOf(label);
    let record: ProfileRecord | undefined;
    if (folderName) {
      const text = await readProjectFile(projectId, `${projectRel}/profiles/${folderName}/profile.json`);
      if (text) record = JSON.parse(text) as ProfileRecord;
    }
    const at = new Date().toISOString();
    const batchId = newId();
    report.batchId = batchId;
    const createdSourceIds: string[] = [];
    const createdCollectionIds: string[] = [];
    let profileSourceId = record && repo.listSourceIds(projectId).includes(record.profileSourceId) ? record.profileSourceId : undefined;
    const snapshot = profileSnapshot(platform, profile, at, [root]);
    if (!profileSourceId) {
      profileSourceId = await createProfileSource(projectId, c, profile, snapshot, { tool, toolVersion, batchId, identifiable, legalBasis, cookies, at });
      createdSourceIds.push(profileSourceId);
    }
    report.profileSourceId = profileSourceId;
    if (pseudonymize) {
      code ??= await pseudonymCodeFor(repo, projectId, names);
      // Fail closed: never fall back to the handle in a name.
      if (!code) throw new Error("the profile has no participant code, so its folder cannot be named");
      folderName = folderOf(code);
    }
    const dirRel = `${projectRel}/profiles/${folderName!}`;
    const collectionLabel = code ?? label;
    let profileSf = await repo.getSource(projectId, profileSourceId);
    let collectionId = record?.collectionId && profileSf.source.collectionIds.includes(record.collectionId) ? record.collectionId : undefined;
    if (!collectionId) {
      collectionId = (await repo.createCollection(projectId, `Profile: ${collectionLabel}`)).id;
      createdCollectionIds.push(collectionId);
      await repo.setMembership(projectId, profileSourceId, { collectionIds: [...profileSf.source.collectionIds, collectionId] });
      profileSf = await repo.getSource(projectId, profileSourceId);
    }
    const known = new Set(record?.knownPostIds ?? []);
    const archive = new Set((await readProjectFile(projectId, `${dirRel}/archive.txt`))?.split("\n").filter(Boolean) ?? []);
    const rec: ProfileRecord = {
      platform,
      handle: handle ?? label,
      profileSourceId,
      collectionId,
      firstCapturedAt: record?.firstCapturedAt ?? at,
      lastCapturedAt: at,
      knownPostIds: [...known],
    };
    const mode = anyIdentifiable ? 0o600 : undefined;
    let needsReview = 0;
    const importsAbs = join(root, ...projectRel.split("/"), "imports");
    const numbers = [...(await namesIn(importsAbs))].map((n) => /^batch-(\d+)$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number);
    const number = Math.max(0, ...numbers) + 1;
    const batchRel = `${projectRel}/imports/batch-${String(number).padStart(4, "0")}`;

    /** Writes files under the project in one governed change; returns the names used. */
    const save = (files: Array<{ rel: string; data: string; dated?: boolean }>, journal?: Record<string, unknown>) =>
      repo.mutate(
        projectId,
        storeReq,
        async (tx) => {
          const out: string[] = [];
          for (const f of files) {
            const slash = f.rel.lastIndexOf("/");
            const dir = f.rel.slice(0, slash);
            let name = f.rel.slice(slash + 1);
            if (tx.encrypted) name = encName(name);
            await tx.mkdir(dir);
            if (f.dated) {
              const taken = await namesIn(join(root, ...dir.split("/")));
              name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
            }
            await tx.writeFile(`${dir}/${name}`, f.data, { encrypt: tx.encrypted, ...(mode ? { mode } : {}) });
            out.push(`${dir}/${name}`);
          }
          if (journal) {
            const json = JSON.stringify(journal);
            const line = tx.encrypted ? sealLine(tx.key().key, tx.key().keyId, projectId, json, JOURNAL_PURPOSE) : json;
            await tx.appendLine(`${batchRel}/journal.jsonl`, line, mode ? { mode } : {});
          }
          return out;
        },
        { op: "capture.profile.files" },
      );
    const recordFiles = () => [
      { rel: `${dirRel}/profile.json`, data: JSON.stringify({ ...rec, knownPostIds: [...known] }, null, 2) },
      { rel: `${dirRel}/archive.txt`, data: [...archive].map((l) => `${l}\n`).join("") },
    ];

    // The batch record (kind profile-capture), written before any post is captured.
    const batchJson = (finishedAt?: string) =>
      JSON.stringify(
        {
          ...ImportBatch.parse({
            id: batchId,
            projectId,
            number,
            source: { kind: "profile-capture", location: `profiles/${folderName!}` },
            options: ImportOptions.parse({ transcribe: opts.transcribe === true, ocr: false }),
            startedAt: at,
            ...(finishedAt ? { finishedAt } : {}),
            counts: { created: report.created, merged: 0, skipped: report.duplicates, failed: report.failed + report.incomplete, needsReview: needsReview },
          }),
          createdSourceIds,
          createdCollectionIds,
        },
        null,
        2,
      );
    const snapName = datedFileName("profile-snapshot", new Date(at), "json", repoTz(repo));
    await save([{ rel: `${batchRel}/batch.json`, data: batchJson() }, ...recordFiles(), { rel: `${dirRel}/snapshots/${snapName}`, data: JSON.stringify(snapshot, null, 2), dated: true }]);
    await addSnapshotAsset(projectId, profileSourceId, snapshot, platform, tool, at);

    // 4. New posts, one at a time.
    const item: ItemContext = {
      identifiable: anyIdentifiable,
      ...(legalBasis ? { legalBasis } : {}),
      importBatchId: batchId,
      collectionIds: [collectionId],
      includeComments,
      metadataOnly: opts.metadataOnly === true,
    };
    const fresh = entries.filter((e) => !known.has(e.id));
    let done = 0;
    let stopped = false;
    for (const e of fresh) {
      const existing = await core.findExisting(projectId, platform, e.id);
      let out: CaptureOutcome;
      if (existing) {
        // Already in the project (captured before, or stored just before an interruption).
        known.add(e.id);
        archive.add(archiveLine(platform, e.id));
        out = { url: e.url, status: "duplicate", sourceId: existing };
        report.duplicates++;
        await save(recordFiles(), { key: e.id, outcome: "duplicate", sourceId: existing });
      } else {
        out = await captureWithBackoff(projectId, e, opts, item, backOff);
        if (out.status === "failed" && out.errorCode === "RATE_LIMITED") {
          pause();
          stopped = true;
          break;
        }
        if (out.status === "failed" && out.errorCode === "POLICY_CHANGED") {
          policyChanged();
          stopped = true;
          break;
        }
        if (out.status === "failed") report.failed++;
        else if (out.status === "incomplete") report.incomplete++;
        else if (out.status === "duplicate") report.duplicates++;
        else {
          report.created++;
          if (out.status === "needs-review") needsReview++;
        }
        if (out.sourceId) {
          known.add(e.id);
          archive.add(archiveLine(platform, e.id));
          if (out.status !== "duplicate") createdSourceIds.push(out.sourceId);
        }
        await save(out.sourceId ? recordFiles() : [], { key: e.id, outcome: out.status, ...(out.sourceId ? { sourceId: out.sourceId } : {}), ...(out.errorCode ? { errorCode: out.errorCode } : {}) });
        waits = 0;
      }
      report.items.push(out);
      done++;
      try {
        onProgress?.(done, fresh.length, out);
      } catch {
        // a progress callback must not stop the run
      }
    }

    // 5–6. Known posts: edits, reappearance; removed detection only for a complete list.
    report.listComplete = !partial && !filtered && !(entries.length === 0 && known.size > 0);
    if (!stopped && (await core.stillAllowed(projectId, platform))) {
      const listedIds = new Set(entries.map((e) => e.id));
      const freshIds = new Set(fresh.map((e) => e.id));
      for (const e of entries) {
        if (!known.has(e.id) || freshIds.has(e.id)) continue;
        const sid = await core.findExisting(projectId, platform, e.id);
        if (!sid) continue;
        const sf = await repo.getSource(projectId, sid);
        if (sf.source.availability.status === "unavailable-on-platform") {
          await repo.updateSource(projectId, sid, { availability: { status: "available" } });
          report.reappeared++;
        }
        const edit = await recordEdit(projectId, sid, e, platform, tool);
        if (edit === "policy-changed") {
          policyChanged();
          break;
        }
        if (edit === "edited") report.edited++;
      }
      if (report.listComplete && report.status === "completed") {
        for (const id of known) {
          if (listedIds.has(id)) continue;
          const sid = await core.findExisting(projectId, platform, id);
          if (!sid) continue;
          const sf = await repo.getSource(projectId, sid);
          if (sf.source.availability.status === "unavailable-on-platform") continue; // noticed once
          await repo.updateSource(projectId, sid, { availability: { status: "unavailable-on-platform", firstNoticedAt: new Date().toISOString() } });
          report.newlyUnavailable++;
        }
      }
    } else if (!stopped) {
      policyChanged();
    }

    // 7. Report, batch record, audit.
    const finishedAt = new Date().toISOString();
    rec.lastCapturedAt = finishedAt;
    const reportName = datedFileName("capture", new Date(finishedAt), "md", repoTz(repo));
    await save([
      ...recordFiles(),
      { rel: `${batchRel}/batch.json`, data: batchJson(finishedAt) },
      { rel: `${dirRel}/reports/${reportName}`, data: reportText(platform, collectionLabel, report, at, finishedAt), dated: true },
    ]);
    return audited(projectId, platform, report);
  }

  /** Records the run in the audit log (counts only: no handle, link or path) and returns the report. */
  async function audited(projectId: string, platform: Platform, r: ProfileCaptureReport): Promise<ProfileCaptureReport> {
    await appendLibraryEvent(repo, projectId, "capture.profile", {
      ...(r.batchId ? { batchId: r.batchId } : {}),
      ...(r.profileSourceId ? { profileSourceId: r.profileSourceId } : {}),
      platform,
      status: r.status,
      listComplete: r.listComplete,
      created: r.created,
      duplicates: r.duplicates,
      incomplete: r.incomplete,
      failed: r.failed,
      newlyUnavailable: r.newlyUnavailable,
      reappeared: r.reappeared,
      edited: r.edited,
      ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    });
    return r;
  }

  /** One post through the per-item path; a rate-limited attempt waits and retries while waits remain. */
  async function captureWithBackoff(
    projectId: string,
    e: ProfileEntry,
    opts: ProfileCaptureOptions,
    item: ItemContext,
    backOff: () => Promise<boolean>,
  ): Promise<CaptureOutcome> {
    const perItem: CaptureOptions = {
      transcribe: opts.transcribe,
      ...(opts.transcribeModel ? { transcribeModel: opts.transcribeModel } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.cookiesFromBrowser ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
    };
    for (;;) {
      let out: CaptureOutcome;
      try {
        out = await core.captureItem(projectId, e.url, classifyUrl(e.url), perItem, item);
      } catch (err) {
        if (err instanceof PolicyDeniedError) out = { url: e.url, status: "failed", errorCode: "POLICY_DENIED", reason: err.reason };
        else if (err instanceof ProjectLockedError) throw err;
        else out = { url: e.url, status: "failed", errorCode: "CAPTURE_FAILED", reason: plainReason("CAPTURE_FAILED") };
      }
      if (out.status === "failed" && out.errorCode === "RATE_LIMITED" && (await backOff())) continue;
      return out;
    }
  }

  async function enumerate(
    projectId: string,
    c: ClassifiedUrl,
    opts: ProfileCaptureOptions,
    tool: CaptureTool,
  ): Promise<{ docs: unknown[]; partialCode?: string; error?: string; toolVersion: string }> {
    const docs: unknown[] = [];
    let partialCode: string | undefined;
    let toolVersion = "unknown";
    for (const input of enumerationUrls(c, opts.contentTypes)) {
      const { work, done } = await core.makeWork();
      try {
        let r;
        try {
          r = await worker.submit(projectId, {
            type: "capture.download",
            input,
            output: work,
            params: {
              tool,
              ...(tool === "yt-dlp" ? { flatList: true } : {}),
              metadataOnly: true,
              ...(opts.maxItems ? { maxItems: opts.maxItems } : {}),
              ...(opts.since ? { dateAfter: ymd(opts.since) } : {}),
              ...(opts.until ? { dateBefore: ymd(opts.until) } : {}),
              ...(opts.cookiesFromBrowser ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
            },
          });
        } catch (err) {
          if (err instanceof WorkerJobError) return { docs, error: err.code, toolVersion };
          if (err instanceof WorkerUnavailableError) return { docs, error: "WORKER_UNAVAILABLE", toolVersion };
          throw err;
        }
        const meta = r.meta;
        if (typeof meta.toolVersion === "string" && meta.toolVersion) toolVersion = meta.toolVersion;
        if (meta.partial === true) partialCode ??= typeof meta.errorCode === "string" ? meta.errorCode : "EXTRACTOR_ERROR";
        const infos = (Array.isArray(meta.infoJson) ? meta.infoJson : []).filter((f): f is string => typeof f === "string").sort();
        for (const f of infos) {
          const d = await core.readJson(f, r.encrypted, projectId);
          if (d !== undefined) docs.push(d);
        }
      } finally {
        await done();
      }
    }
    return { docs, ...(partialCode ? { partialCode } : {}), toolVersion };
  }

  async function createProfileSource(
    projectId: string,
    c: ClassifiedUrl,
    profile: ProfileMeta,
    snapshot: Record<string, unknown>,
    o: { tool: CaptureTool; toolVersion: string; batchId: string; identifiable: boolean; legalBasis?: string; cookies: boolean; at: string },
  ): Promise<string> {
    const platform = c.platform;
    const handle = c.handle ?? profile.handle;
    const name = profile.displayName ?? handle ?? linkKey(c);
    const evidence: FieldEvidence[] = [];
    const ev = (field: string, value: unknown, ref: string) => evidence.push({ field, value, source: { kind: "platform-json", provider: o.tool, ref }, at: o.at });
    if (profile.displayName || handle) ev("/title", name, profile.displayName ? "/displayName" : "/handle");
    const creators: SourceDraft["creators"] = [
      { ...(profile.displayName ? { literal: profile.displayName } : {}), role: platform === "youtube" ? "channel" : "uploader", ...(handle ? { handle } : {}) },
    ];
    if (profile.displayName || handle) ev("/creators", creators, handle ? "/handle" : "/displayName");
    // The snapshot used for verification and kept in provenance, with the identity keys the checks read.
    const vsnap: Record<string, unknown> = {
      ...snapshot,
      ...(profile.displayName ? { title: profile.displayName, channel: profile.displayName } : {}),
      ...(handle ? { uploader_id: handle, owner_username: handle.replace(/^@+/, "") } : {}),
    };
    const draft: SourceDraft = {
      projectIds: [],
      type: "social-post",
      title: { variants: [{ lang: "und", kind: "original", value: name }] },
      creators,
      accessed: o.at,
      identifiers: { platform: platform === "other" ? "other" : platform, url: c.canonicalUrl },
      caseAttributes: { genre: "profile" },
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    const report = verifyDraft(draft, evidence, { platformSnapshot: vsnap });
    const provenance: Provenance = {
      captureMethod: "downloader",
      capturedAt: o.at,
      originalUrl: c.canonicalUrl,
      tool: { name: o.tool, version: o.toolVersion },
      fileHashes: {},
      platformSnapshot: vsnap,
      identification: { method: "platform-json", confidence: applyVerification(1, report) },
      importBatchId: o.batchId,
      legal: { status: "unknown", ...(o.legalBasis ? { basis: o.legalBasis } : {}) },
      identifiable: o.identifiable,
      access: o.cookies ? "signed-in-session" : "public",
    };
    // A profile has no post id or posting date: those required fields are expected to be missing,
    // so only a real disagreement (conflict) sends the profile record to review.
    const conflicts = Object.entries(report.fields).filter(([, v]) => v.status === "conflict");
    const sf = await createSourcePreAuthorized(repo, projectId, draft, [], {
      provenance,
      fieldEvidence: evidence,
      verification: report.fields,
      ...(conflicts.length ? { reviewItem: { fields: Object.fromEntries(conflicts.map(([k, v]) => [k, v.status])), reasons: report.reasons } } : {}),
    });
    return sf.source.id;
  }

  /** The dated profile snapshot as a derived asset of the profile source. */
  async function addSnapshotAsset(projectId: string, sourceId: string, snapshot: Record<string, unknown>, platform: Platform, tool: CaptureTool, at: string) {
    const { work, done } = await core.makeWork();
    try {
      const key = projectDataKey(repo, projectId);
      const path = await core.writeJson(work, "profile-snapshot.json", snapshot, projectId, !!key);
      await repo.addDerivedAsset(projectId, sourceId, {
        fromPath: path,
        kind: "profile-snapshot",
        tool: "platform",
        ext: "json",
        ...(key ? { fromEncrypted: true } : {}),
        metadata: { capturedAt: at },
        derivation: { parents: [], operation: "profile-snapshot", provider: "platform", ranAt: platform, params: { tool }, at, triggeredBy: "capture" },
      });
    } finally {
      await done();
    }
  }

  /**
   * A known post whose listed caption (or YouTube title) differs from its latest stored snapshot:
   * a new dated platform-metadata original and, when the title changes, a title variant (rechecked).
   */
  async function recordEdit(
    projectId: string,
    sourceId: string,
    e: ProfileEntry,
    platform: Platform,
    tool: CaptureTool,
  ): Promise<"edited" | "unchanged" | "policy-changed"> {
    const root = repoLibrary(repo).root;
    const sf = await repo.getSource(projectId, sourceId);
    const metas = sf.assets
      .filter((a) => a.role === "original" && a.kind === "platform-metadata")
      .sort((a, b) => (a.metadata?.capturedAt ?? "").localeCompare(b.metadata?.capturedAt ?? ""));
    const latest = metas.at(-1);
    if (!latest) return "unchanged";
    const stored = await core.readJson(join(root, ...latest.path.split("/")), latest.encrypted, projectId);
    if (!isRecord(stored)) return "unchanged";
    const now = stripSnapshot(e.raw, { localPrefixes: [root] });
    const oldCap = captionOf(stored);
    const newCap = captionOf(now);
    const capChanged = typeof oldCap === "string" && typeof newCap === "string" && norm(oldCap) !== norm(newCap);
    const newYtTitle = platform === "youtube" && typeof now.title === "string" ? now.title : undefined;
    const titleChanged = typeof stored.title === "string" && newYtTitle !== undefined && norm(stored.title) !== norm(newYtTitle);
    if (!capChanged && !titleChanged) return "unchanged";
    // Immediately before storing (R42).
    if (!(await core.stillAllowed(projectId, platform))) return "policy-changed";

    const at = new Date().toISOString();
    const { work, done } = await core.makeWork();
    try {
      const key = projectDataKey(repo, projectId);
      const path = await core.writeJson(work, "edit.platform-metadata.json", now, projectId, !!key);
      const stamp = at.slice(0, 16).replace("T", " ").replace(":", "");
      await repo.addOriginalAsset(projectId, sourceId, {
        fromPath: path,
        kind: "platform-metadata",
        ext: "json",
        label: `platform-metadata ${stamp}`,
        ...(key ? { fromEncrypted: true } : {}),
        metadata: { capturedAt: at },
      });
    } finally {
      await done();
    }

    const newTitle = platform === "youtube" ? newYtTitle : firstLine(newCap);
    const variants = sf.source.title.variants;
    if (newTitle && !variants.some((v) => norm(v.value) === norm(newTitle))) {
      const lang = (variants.find((v) => v.kind === "original") ?? variants[0])?.lang ?? "und";
      const title: MultiText = { variants: [...variants, { lang, kind: "original", value: newTitle, producedBy: { by: "machine", tool: "platform-edit", at } }] };
      const ref = platform === "youtube" ? "/title" : `/${["description", "desc", "caption"].find((k) => typeof now[k] === "string") ?? "description"}`;
      const evidence: FieldEvidence = { field: "/title", value: title, source: { kind: "platform-json", provider: tool, ref }, at };
      // Recheck against the first snapshot (provenance) plus the edited text from the new one.
      const ctx = groundingSnapshot(sf.source.provenance.platformSnapshot, platform === "youtube" ? newTitle : (newCap ?? newTitle));
      await updateSourceRechecked(repo, projectId, sourceId, { title }, {
        fieldEvidence: (cur) => [...cur.fieldEvidence, evidence],
        verification: (next) => recheckSourceFile(next, { platformSnapshot: ctx }).verification,
      });
    }
    return "edited";
  }

  /** A captureUrl outcome for a profile link (the profile source stands for the run). */
  function outcomeOf(url: string, r: ProfileCaptureReport): CaptureOutcome {
    if (r.status === "failed" || !r.profileSourceId) {
      return { url, status: "failed", errorCode: r.errorCode ?? "CAPTURE_FAILED", reason: r.reason ?? plainReason(r.errorCode ?? "CAPTURE_FAILED") };
    }
    const summary = `${r.created} new post(s) saved, ${r.failed + r.incomplete} not saved completely.`;
    if (r.status === "paused-rate-limited") return { url, status: "incomplete", sourceId: r.profileSourceId, errorCode: "RATE_LIMITED", reason: `${r.reason} ${summary}` };
    return { url, status: "created", sourceId: r.profileSourceId, reason: summary };
  }

  return { captureProfile, outcomeOf };
}

/** The provenance snapshot plus an edited text under a free text key, for grounding both versions. */
function groundingSnapshot(prov: unknown, edited: string | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(prov) ? { ...prov } : {};
  if (!edited) return base;
  const key = ["caption", "text", "fulltitle", "title", "description"].find((k) => typeof base[k] !== "string") ?? "text";
  base[key] = edited;
  return base;
}

const PLATFORM_NAMES: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", other: "Other" };

/** The plain-language capture report (no links, no paths). */
function reportText(platform: Platform, label: string, r: ProfileCaptureReport, startedAt: string, finishedAt: string): string {
  const status =
    r.status === "completed"
      ? "Finished."
      : r.status === "paused-rate-limited"
        ? "Paused because the platform is limiting requests. Run the capture again later; it continues where it stopped."
        : `Stopped. ${r.reason ?? ""}`.trim();
  const lines = [
    `# Profile capture report`,
    "",
    `- Platform: ${PLATFORM_NAMES[platform]}`,
    `- Profile: ${label}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Result: ${status}`,
    "",
    "## Counts",
    "",
    `- New posts saved: ${r.created}`,
    `- Already in the project: ${r.duplicates}`,
    `- Saved only in part: ${r.incomplete}`,
    `- Could not be saved: ${r.failed}`,
    `- No longer available on the platform (newly noticed): ${r.newlyUnavailable}`,
    `- Available again: ${r.reappeared}`,
    `- Captions edited since the last capture: ${r.edited}`,
    "",
    r.listComplete
      ? "The whole profile was listed, so posts missing from it were checked."
      : "The profile was not listed completely (cut short, or limited by date, type or number), so no post was marked as no longer available.",
  ];
  const problems = r.items.filter((o) => o.status === "failed" || o.status === "incomplete");
  if (problems.length) {
    lines.push("", "## Posts not saved completely", "");
    for (const o of problems) {
      const id = classifyUrl(o.url).postId ?? "unknown post";
      lines.push(`- Post ${id}: ${o.reason ?? plainReason(o.errorCode ?? "CAPTURE_FAILED")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
