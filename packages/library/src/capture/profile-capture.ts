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
  type Availability,
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
import { WorkerJobError, WorkerToolError, WorkerUnavailableError } from "../worker-client.js";
import { AcknowledgementRequiredError, CaptureCancelledError, plainReason, toolMissingReason } from "./errors.js";
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
  /** The optional tool that was missing (with `TOOL_NOT_INSTALLED`, Task 48a). */
  tool?: string;
}

/** A known post: the listing (tab) it was found in, and what to restore if it disappears and returns. */
export interface KnownPost {
  /** videos, shorts, posts, reels, highlights or playlist. */
  listing: string;
  /** The availability before the post was marked unavailable on the platform. */
  previousAvailability?: Availability;
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
  /** Per known post (older records have only knownPostIds: the main listing is assumed). */
  knownPosts?: Record<string, KnownPost>;
}

/** One listing (tab) of a profile: its link, its name, and whether it is the profile's main list. */
interface Listing {
  url: string;
  listing: string;
  main: boolean;
}
interface ListingResult {
  listing: Listing;
  docs: unknown[];
  partialCode?: string;
}
type ListedEntry = ProfileEntry & { listing: string };

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

/**
 * The listings to enumerate. YouTube channels are listed through their tabs (`/videos`, and
 * `/shorts` when chosen): the bare channel lists its tabs, not posts.
 */
function listingsFor(c: ClassifiedUrl, types: ProfileContentType[] | undefined): Listing[] {
  if (c.kind === "playlist") return [{ url: c.canonicalUrl, listing: "playlist", main: true }];
  const base = c.canonicalUrl.replace(/\/+$/, "");
  const wanted = types?.length ? types : [c.platform === "instagram" ? "posts" : "videos"];
  const out = new Map<string, Listing>();
  for (const t of wanted) {
    if (c.platform === "youtube") {
      const l = t === "shorts" ? "shorts" : "videos";
      out.set(l, { url: `${base}/${l}`, listing: l, main: l === "videos" });
    } else if (c.platform === "instagram") {
      const l = t === "reels" ? "reels" : t === "highlights" ? "highlights" : "posts";
      out.set(l, { url: l === "posts" ? `${base}/` : `${base}/${l}/`, listing: l, main: l === "posts" });
    } else out.set("videos", { url: base, listing: "videos", main: true });
  }
  return [...out.values()];
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
    control?: { cancelled?: () => boolean },
  ): Promise<ProfileCaptureReport> {
    if (opts.cookiesFromBrowser && !core.acknowledged(projectId)) throw new AcknowledgementRequiredError(projectId);
    const c = classifyUrl(profileUrl);
    if ((c.kind !== "profile" && c.kind !== "playlist") || c.platform === "other") return failedReport("UNSUPPORTED_URL");
    if (invalidOptions(opts)) return failedReport("INVALID_OPTIONS");
    return core.inLane(c.platform, () => run(projectId, c, opts, onProgress, control?.cancelled));
  }

  async function run(
    projectId: string,
    c: ClassifiedUrl,
    opts: ProfileCaptureOptions,
    onProgress?: (done: number, total: number, outcome: CaptureOutcome) => void,
    isCancelled: () => boolean = () => false,
  ): Promise<ProfileCaptureReport> {
    /** Ended from outside (Task 63 I3): nothing more is stored, the run ends here (its batch stays as an interrupted one). */
    const check = () => {
      if (isCancelled()) throw new CaptureCancelledError();
    };
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
    // Comments are third-party personal data: they always need a legal basis, and identifiable
    // storage must be allowed, before any download.
    if (includeComments && !legalBasis) return failedReport("LEGAL_BASIS_REQUIRED");
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
    const policyChanged = () => Object.assign(report, { status: "failed" as const, errorCode: "POLICY_CHANGED", reason: plainReason("POLICY_CHANGED_RUN") });

    // 2. Enumerate each listing (tab).
    let results: ListingResult[] = [];
    let toolVersion = "unknown";
    for (;;) {
      const r = await enumerate(projectId, c, opts, tool);
      // Rate limited, even part-way through a list: wait and list again, or pause.
      if (r.error === "RATE_LIMITED" || r.results.some((x) => x.partialCode === "RATE_LIMITED")) {
        if (await backOff()) continue;
        pause();
        return audited(projectId, platform, report);
      }
      if (r.error) {
        // A missing tool is named, with how to get it (R126).
        const missing = r.error === "TOOL_NOT_INSTALLED" && r.tool ? { tool: r.tool } : undefined;
        return audited(projectId, platform, missing ? { ...failedReport(r.error), ...missing, reason: toolMissingReason(missing.tool) } : failedReport(r.error));
      }
      ({ results, toolVersion } = r);
      break;
    }
    let profile: ProfileMeta | undefined;
    const listed: ListedEntry[] = [];
    const listedIds = new Set<string>();
    /** Listings that did not come back whole: cut short, nested, or shorter than the platform's own count. */
    const incompleteListings = new Set<string>();
    for (const res of results) {
      const en = readEnumeration(res.docs, c, tool);
      if (!profile || (!profile.handle && en.profile.handle)) profile = en.profile;
      const unique = en.entries.filter((e) => !listedIds.has(e.id));
      if (res.partialCode || en.nested || (res.listing.main && en.reportedCount !== undefined && en.reportedCount > en.entries.length)) {
        incompleteListings.add(res.listing.listing);
      }
      for (const e of unique) {
        listedIds.add(e.id);
        listed.push({ ...e, listing: res.listing.listing });
      }
    }
    profile ??= { links: [] };
    const sinceTs = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) / 1000 : undefined;
    const untilTs = opts.until ? Date.parse(`${opts.until}T00:00:00Z`) / 1000 + 86400 : undefined;
    let entries = listed.filter((e) => e.timestamp === undefined || ((sinceTs === undefined || e.timestamp >= sinceTs) && (untilTs === undefined || e.timestamp < untilTs)));
    if (opts.maxItems !== undefined) entries = entries.slice(0, opts.maxItems);
    // Any date or number limit (gallery-dl's range counts files, not posts): never a whole list.
    const filtered = !!(opts.since || opts.until || opts.maxItems !== undefined);

    // 3. Batch record first, then the profile: record, source, collection, snapshot.
    check();
    if (!(await core.stillAllowed(projectId, platform))) return audited(projectId, platform, policyChanged());
    const handle = c.handle ?? profile.handle;
    const label = handle ?? linkKey(c);
    const names = [label, label.replace(/^@+/, ""), `@${label.replace(/^@+/, "")}`, ...(profile.handle ? [profile.handle] : [])];
    const projectRel = repo.getProject(projectId).folder;
    const fold = platform === "youtube" || platform === "tiktok";
    const folderOf = (name: string, isCode: boolean) => {
      const bare = name.replace(/^@+/, "");
      return `${platform}-${sanitizeSegment(fold && !isCode ? bare.toLowerCase() : bare, 100)}`;
    };
    let code = pseudonymize ? await pseudonymCodeFor(repo, projectId, names) : undefined;
    let folderName = pseudonymize ? (code ? folderOf(code, true) : undefined) : folderOf(label, false);
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
    const batchFile = (state: "running" | "finished" | "paused" | "failed", finishedAt?: string) => ({
      rel: `${batchRel}/batch.json`,
      data: JSON.stringify(
        {
          ...ImportBatch.parse({
            id: batchId,
            projectId,
            number,
            // The folder is known once the profile is (a new pseudonymized profile gets its code first).
            source: { kind: "profile-capture", location: `profiles/${folderName ?? `${platform}-(new profile)`}` },
            options: ImportOptions.parse({ transcribe: opts.transcribe === true, ocr: false }),
            startedAt: at,
            ...(finishedAt ? { finishedAt } : {}),
            // A post saved only in part is a created source (counted again in countsDetail), not a failure.
            counts: { created: report.created + report.incomplete, merged: 0, skipped: report.duplicates, failed: report.failed, needsReview },
          }),
          state,
          countsDetail: { createdIncomplete: report.incomplete },
          createdSourceIds,
          createdCollectionIds,
        },
        null,
        2,
      ),
    });
    // Written before anything is created, so an interrupted run still has its batch record.
    await save([batchFile("running")]);

    let profileSourceId = record && repo.listSourceIds(projectId).includes(record.profileSourceId) ? record.profileSourceId : undefined;
    // No record (first run, or interrupted before it was written): the profile source may exist already.
    profileSourceId ??= await findProfileSource(projectId, c);
    const snapshot = profileSnapshot(platform, profile, at, [root]);
    if (!profileSourceId) {
      profileSourceId = await createProfileSource(projectId, c, profile, snapshot, { tool, toolVersion, batchId, identifiable, legalBasis, cookies, at });
      createdSourceIds.push(profileSourceId);
      await save([batchFile("running")]);
    }
    report.profileSourceId = profileSourceId;
    if (pseudonymize) {
      code ??= await pseudonymCodeFor(repo, projectId, names);
      // Fail closed: never fall back to the handle in a name.
      if (!code) throw new Error("the profile has no participant code, so its folder cannot be named");
      folderName = folderOf(code, true);
      if (!record) {
        const text = await readProjectFile(projectId, `${projectRel}/profiles/${folderName}/profile.json`);
        if (text) record = JSON.parse(text) as ProfileRecord;
      }
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
    // Known posts and the listing each was found in (older records: knownPostIds, the main listing).
    const fallbackListing = c.kind === "playlist" ? "playlist" : platform === "instagram" ? "posts" : "videos";
    const knownPosts: Record<string, KnownPost> = {};
    for (const id of record?.knownPostIds ?? []) knownPosts[id] = { listing: fallbackListing };
    for (const [id, k] of Object.entries(record?.knownPosts ?? {})) if (isRecord(k) && typeof k.listing === "string") knownPosts[id] = structuredClone(k);
    const knownBefore = structuredClone(knownPosts);
    const isKnown = (id: string) => Object.hasOwn(knownPosts, id);
    const archive = new Set((await readProjectFile(projectId, `${dirRel}/archive.txt`))?.split("\n").filter(Boolean) ?? []);
    const rec = {
      platform,
      handle: handle ?? label,
      profileSourceId,
      collectionId,
      firstCapturedAt: record?.firstCapturedAt ?? at,
      lastCapturedAt: at,
    };
    const recordFiles = () => [
      { rel: `${dirRel}/profile.json`, data: JSON.stringify({ ...rec, knownPostIds: Object.keys(knownPosts), knownPosts } satisfies ProfileRecord, null, 2) },
      { rel: `${dirRel}/archive.txt`, data: [...archive].map((l) => `${l}\n`).join("") },
    ];
    const remember = (e: ListedEntry) => {
      knownPosts[e.id] ??= { listing: e.listing };
      archive.add(archiveLine(platform, e.id));
    };

    const snapName = datedFileName("profile-snapshot", new Date(at), "json", repoTz(repo));
    await save([batchFile("running"), ...recordFiles(), { rel: `${dirRel}/snapshots/${snapName}`, data: JSON.stringify(snapshot, null, 2), dated: true }]);
    await addSnapshotAsset(projectId, profileSourceId, snapshot, platform, tool, at);

    // 4. New posts, one at a time.
    const item: ItemContext = {
      identifiable: anyIdentifiable,
      ...(legalBasis ? { legalBasis } : {}),
      importBatchId: batchId,
      collectionIds: [collectionId],
      includeComments,
      metadataOnly: opts.metadataOnly === true,
      cancelled: isCancelled,
    };
    const fresh = entries.filter((e) => !isKnown(e.id));
    const freshIds = new Set(fresh.map((e) => e.id));
    let done = 0;
    let stopped = false;
    for (const e of fresh) {
      check();
      const existing = await core.findExisting(projectId, platform, e.id);
      let out: CaptureOutcome;
      if (existing) {
        // Already in the project (captured on its own before, or stored just before an interruption).
        remember(e);
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
          remember(e);
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

    // 5–6. Known posts: edits, reappearance; removed detection only for whole lists.
    const wholeListings = new Set(results.map((r) => r.listing.listing).filter((l) => !incompleteListings.has(l)));
    const checked = Object.entries(knownBefore).filter(([, k]) => wholeListings.has(k.listing)).map(([id]) => id);
    const overlap = checked.filter((id) => listedIds.has(id)).length;
    // Sanity guard: a list that shares less than half of the known posts is more likely the wrong
    // list (or a login wall) than half the profile deleted.
    const plausible = checked.length === 0 || overlap * 2 >= checked.length;
    report.listComplete = !filtered && incompleteListings.size === 0 && plausible && !(entries.length === 0 && checked.length > 0);
    if (!stopped && (await core.stillAllowed(projectId, platform))) {
      for (const e of entries) {
        check();
        if (!isKnown(e.id) || freshIds.has(e.id)) continue;
        const sid = await core.findExisting(projectId, platform, e.id);
        if (!sid) continue;
        const sf = await repo.getSource(projectId, sid);
        if (sf.source.availability.status === "unavailable-on-platform") {
          const k = knownPosts[e.id]!;
          const restore = k.previousAvailability ?? { status: "available" as const };
          delete k.previousAvailability;
          await repo.updateSource(projectId, sid, { availability: restore });
          await save(recordFiles());
          report.reappeared++;
        }
        const edit = await recordEdit(projectId, sid, e, platform, tool, opts, check);
        if (edit === "policy-changed") {
          policyChanged();
          break;
        }
        if (edit === "edited") report.edited++;
      }
      if (!filtered && plausible && report.status === "completed") {
        for (const id of checked) {
          check();
          if (listedIds.has(id)) continue;
          const sid = await core.findExisting(projectId, platform, id);
          if (!sid) continue;
          const sf = await repo.getSource(projectId, sid);
          if (sf.source.availability.status === "unavailable-on-platform") continue; // noticed once
          // The earlier availability (e.g. incomplete) is kept, to be restored if the post returns.
          knownPosts[id] = { ...knownPosts[id]!, previousAvailability: sf.source.availability };
          await save(recordFiles());
          await repo.updateSource(projectId, sid, { availability: { status: "unavailable-on-platform", firstNoticedAt: new Date().toISOString() } });
          report.newlyUnavailable++;
        }
      }
    } else if (!stopped) {
      policyChanged();
    }

    // 7. Report, batch record, audit (written after a stop too: they record what happened).
    check();
    const finishedAt = new Date().toISOString();
    rec.lastCapturedAt = finishedAt;
    const reportName = datedFileName("capture", new Date(finishedAt), "md", repoTz(repo));
    const state = report.status === "completed" ? "finished" : report.status === "paused-rate-limited" ? "paused" : "failed";
    await save([
      ...recordFiles(),
      batchFile(state, finishedAt),
      { rel: `${dirRel}/reports/${reportName}`, data: reportText(platform, collectionLabel, report, at, finishedAt), dated: true },
    ]);
    return audited(projectId, platform, report);
  }

  /** A profile source of this link already in the project (an earlier run interrupted before its record). */
  async function findProfileSource(projectId: string, c: ClassifiedUrl): Promise<string | undefined> {
    for (const id of repo.listSourceIds(projectId)) {
      try {
        const sf = await repo.getSource(projectId, id);
        const s = sf.source;
        if (s.caseAttributes.genre === "profile" && s.identifiers.platform === c.platform && s.identifiers.url === c.canonicalUrl) return id;
      } catch {
        // unreadable source: not a match
      }
    }
    return undefined;
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
      // Ended while the post downloaded: nothing of it was stored, and nothing more is.
      if (out.status === "failed" && out.errorCode === "CANCELLED") throw new CaptureCancelledError();
      if (out.status === "failed" && out.errorCode === "RATE_LIMITED" && (await backOff())) continue;
      return out;
    }
  }

  async function enumerate(
    projectId: string,
    c: ClassifiedUrl,
    opts: ProfileCaptureOptions,
    tool: CaptureTool,
  ): Promise<{ results: ListingResult[]; error?: string; tool?: string; toolVersion: string }> {
    const results: ListingResult[] = [];
    let toolVersion = "unknown";
    for (const listing of listingsFor(c, opts.contentTypes)) {
      const { work, done } = await core.makeWork();
      try {
        let r;
        try {
          r = await worker.submit(projectId, {
            type: "capture.download",
            input: listing.url,
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
          if (err instanceof WorkerJobError) return { results, error: err.code, ...(err instanceof WorkerToolError ? { tool: err.tool } : {}), toolVersion };
          if (err instanceof WorkerUnavailableError) return { results, error: "WORKER_UNAVAILABLE", toolVersion };
          throw err;
        }
        const meta = r.meta;
        if (typeof meta.toolVersion === "string" && meta.toolVersion) toolVersion = meta.toolVersion;
        const partialCode = meta.partial === true ? (typeof meta.errorCode === "string" ? meta.errorCode : "EXTRACTOR_ERROR") : undefined;
        const docs: unknown[] = [];
        const infos = (Array.isArray(meta.infoJson) ? meta.infoJson : []).filter((f): f is string => typeof f === "string").sort();
        for (const f of infos) {
          const d = await core.readJson(f, r.encrypted, projectId);
          if (d !== undefined) docs.push(d);
        }
        results.push({ listing, docs, ...(partialCode ? { partialCode } : {}) });
      } finally {
        await done();
      }
    }
    return { results, toolVersion };
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
    if (profile.url === c.canonicalUrl) ev("/identifiers/url", c.canonicalUrl, "/webpage_url");
    // The snapshot used for verification and kept in provenance, with the identity keys the checks read.
    const vsnap: Record<string, unknown> = {
      ...snapshot,
      ...(profile.displayName ? { title: profile.displayName, channel: profile.displayName } : {}),
      ...(handle ? { uploader_id: handle, owner_username: handle.replace(/^@+/, "") } : {}),
      ...(profile.url ? { webpage_url: profile.url } : {}),
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
   * A known post whose listed caption (YouTube: title only, since listings truncate descriptions)
   * differs from its latest stored snapshot is fetched in full (metadata only). Only when the full
   * metadata differs too is it stored, as a new dated platform-metadata original, plus a title
   * variant when the title changes (rechecked).
   */
  async function recordEdit(
    projectId: string,
    sourceId: string,
    e: ProfileEntry,
    platform: Platform,
    tool: CaptureTool,
    opts: ProfileCaptureOptions,
    check: () => void = () => {},
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
    const differs = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && norm(a) !== norm(b);
    const flat = stripSnapshot(e.raw, { localPrefixes: [root] });
    const suspect = platform === "youtube" ? differs(stored.title, flat.title) : differs(captionOf(stored), captionOf(flat));
    if (!suspect) return "unchanged";
    const now = await core.fetchMetadata(projectId, classifyUrl(e.url), {
      transcribe: false,
      ...(opts.cookiesFromBrowser ? { cookiesFromBrowser: opts.cookiesFromBrowser } : {}),
    });
    if (!now) return "unchanged";
    const newCap = captionOf(now);
    const newYtTitle = platform === "youtube" && typeof now.title === "string" ? now.title : undefined;
    if (!differs(captionOf(stored), newCap) && !(platform === "youtube" && differs(stored.title, newYtTitle))) return "unchanged";
    // Immediately before storing (R42).
    if (!(await core.stillAllowed(projectId, platform))) return "policy-changed";
    check();

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
      check();
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
