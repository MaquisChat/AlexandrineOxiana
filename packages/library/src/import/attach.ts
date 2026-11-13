/**
 * Drag-and-drop attach (spec 5.1): files dropped on the library become sources, files dropped on a
 * source become further originals of it. Provenance `manual_upload`; the user's files are copied
 * (never moved or deleted), encrypted at rest in encrypted projects by the repository's asset APIs.
 *
 * Per dropped path:
 *   1. a folder → `failed`, "Use Bulk Import for folders" (Task 23 handles folders);
 *   2. the type is sniffed from the content with `file-type` (the extension is never trusted);
 *      only PDF, EPUB, MOBI/AZW, DOCX, images, audio and video are accepted;
 *   3. policy, once per call and before any lookup: `capture` (manual_upload) and `store` (with the
 *      target source's own legal basis, or the project's `consent.defaultLegalBasis['manual-upload']`
 *      for new sources); a deny is audited and every file gets `failed` with the policy's reason;
 *   4. drop on a source: same SHA-256 as one of its files → `duplicate`; else the file is added as
 *      an original under `original/` in one governed change (capture + store evaluated and audited,
 *      R26 txn); the source's metadata is not touched;
 *   5. drop on the library: same file already in the project → `duplicate` (no lookup); else
 *      `resolveItem` (spec 5.4 step 3, lookups only through `lookupContextFor`), then
 *      `findDuplicate` against the project's sources: a certain duplicate (same DOI or ISBN) →
 *      `duplicate`; a likely one (fuzzy) → created and queued for review with the candidate; an item
 *      below AUTO_ACCEPT_THRESHOLD or whose verification needs review → created and queued
 *      (`review/pending.jsonl`, sealed in encrypted projects, R31); else `created`.
 *
 * Identifiers found in a file but not confirmed by a lookup are never recorded or used to find
 * duplicates (R55): they go on the review entry as `hints`. Media (images, video, audio) with GPS,
 * or whose metadata could not be read, are stored with `hasLocation: true`, so location governance
 * applies (R54a, R57, R58). A store allowed with a location condition (coarsen or strip) stores the
 * original as the decision says (encrypted where required) and queues its viewing proxy with the
 * location coarsened or removed (R83, proxies.ts); with no media worker configured the proxy stays
 * pending and the outcome carries the note LOCATION_REASON. A denied store (e.g. encryption off
 * with coarsen) fails with the policy's own reason.
 *
 * Each stored file is one governed mutation (`createSource` / an original added to a source): the
 * `capture` and `store` decisions are evaluated again inside it, right before anything is written
 * (R42), so governance edited during the lookups stops the store (deny audited, nothing saved).
 *
 * Reasons are fixed plain-language sentences or the policy's own reason: never a path or an error
 * message. Not wired here: purging the lookup client's sensitive memory cache when a project is
 * locked (`HttpClient.purgeSensitive`); the Repo has no lock hook or event yet (carried to Task 30).
 */
import * as fsp from "node:fs/promises";
import { libraryVersion } from "../resources.js";
import { fileTypeFromFile } from "file-type";
import { findDuplicate, type DupKey, type FileNamePattern, type SourceFile } from "@ao/core";
import { UnsafeFileError, extractMetadata } from "../extract/index.js";
import { lookupContextFor, type HttpClient, type LookupContext } from "../lookup/index.js";
import { NotFoundError, PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import { kindFor, mimeFor } from "../repo/io.js";
import { storeRequest } from "../repo/sources.js";
import { addCapturedOriginal, authorizeProcessing, createSourceRefusing, type Repo } from "../repo/repo.js";
import { ITEM_REASONS, LOCATION_REASON, candidateKey, dupKey, itemProvenance, locationRule, reviewFor, sha256File, storeInputs as sharedStoreInputs } from "./common.js";
import { pendingFor, proxyQueueFor, proxyTypeFor, type ProxyPlan, type ProxyQueue } from "./proxies.js";
import { serialStore, storeTurn } from "./project-queue.js";
import { LOCATED_MEDIA, mayHaveLocation, resolveItem } from "./resolve.js";
import { findSidecars } from "./sidecar.js";

export { LOCATION_REASON };

const VERSION: string = libraryVersion();

export type AttachStatus = "created" | "attached" | "duplicate" | "needs-review" | "failed";

export interface AttachOutcome {
  /** The path as given. */
  path: string;
  outcome: AttachStatus;
  sourceId?: string;
  reason?: string;
  /** Stored, but something is still to come: e.g. LOCATION_REASON (its location-safe viewing copy waits for the media worker, R83). */
  note?: string;
}

export interface AttachDeps {
  repo: Repo;
  /** The lookup client (one per library; its cache lives in `<Library>/.cache/lookups`). */
  http: HttpClient;
  /** User file-name patterns, vetted by the caller (see parseFileName). */
  patterns?: FileNamePattern[];
  /** Receives short notes (lookup providers skipped or failed). */
  debug?: (note: string) => void;
  /** Viewing proxies of located photos and videos (R83); default: the library's queue (proxyQueueFor, R85). */
  proxies?: ProxyQueue;
  /**
   * A watched folder (Task W2): asked for each file (the item, then each sidecar beside it) before a byte of
   * it is read; false means its content is not on this computer, and reading it would download it. The item
   * then fails with NOT_DOWNLOADED_REASON before its type is sniffed, and a sidecar is left out. Absent (drag
   * and drop, Bulk Import): every file is read as before.
   */
  readable?: (path: string) => Promise<boolean>;
}

export interface Attach {
  attachFiles(projectId: string, paths: string[], opts?: { toSourceId?: string }): Promise<AttachOutcome[]>;
}

export const FOLDER_REASON = "Use Bulk Import for folders";
/** A file `readable` refused: its content is not on this computer (a cloud drive's online-only file). */
export const NOT_DOWNLOADED_REASON = "Not downloaded to this Mac. It comes in once it is downloaded.";
/** The plain reasons attach gives (callers tell them apart, e.g. the watched folder's file kinds). */
export const ATTACH_REASONS = {
  missing: "The file could not be found or read.",
  notAFile: "Only files can be attached.",
  unsupported: "This kind of file cannot be attached. Attach PDFs, EPUB or Kindle books, Word documents, images, audio or video.",
  unsafe: "This file could not be opened safely, so it was not attached.",
  locked: "The project is locked. Unlock it, then try again.",
  noSource: "The source to attach to could not be found.",
  failed: "The file could not be attached.",
  ...ITEM_REASONS,
};
const REASONS = ATTACH_REASONS;

/**
 * The sniffed (`file-type`) extensions attach accepts: documents and books, images (incl. camera
 * raw), audio and video, each with its MIME type and asset kind in repo/io.ts. Anything else that
 * file-type reports as image/*, audio/* or video/* is accepted too (kind from the prefix, MIME
 * from file-type), except SVG (a document with scripts and links, not a picture to store).
 */
export const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "epub", "mobi", "azw", "azw3", "docx",
  "jpg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "cr2", "cr3", "dng", "nef", "arw", "orf", "rw2", "raf",
  "mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp", "mpg",
  "mp3", "m4a", "wav", "ogg", "flac", "aac", "opus",
]);

/** What attach stores for a sniffed type (`file-type`'s ext and MIME), or undefined when it is not accepted. */
export function acceptedType(type: { ext: string; mime: string }): { ext: string; mime: string; kind: string } | undefined {
  const mime = type.mime.split(";")[0]!.trim();
  if (mime.toLowerCase() === "image/svg+xml") return undefined;
  const media = /^(image|audio|video)\//u.exec(mime)?.[1];
  if (!ACCEPTED_EXTENSIONS.has(type.ext) && !media) return undefined;
  // The MIME table's type and kind where it knows the extension, else file-type's MIME and the prefix.
  const known = mimeFor(type.ext) !== "application/octet-stream";
  return { ext: type.ext, mime: known ? mimeFor(type.ext) : mime, kind: known ? kindFor(type.ext) : media! };
}

const failed = (path: string, reason: string): AttachOutcome => ({ path, outcome: "failed", reason });

/** A short label for an added original's file name: its kind and when it was added (no user file name). */
function addedLabel(kind: string, at: Date): string {
  return `${kind} added ${at.toISOString().slice(0, 16).replace("T", " ").replace(":", "")}`;
}

export function createAttach(deps: AttachDeps): Attach {
  const { repo, http } = deps;
  const patterns = deps.patterns ?? [];

  /** Per call: the target source, the policy decision, the lookup context and the duplicate keys, each made once. */
  function session(projectId: string, toSourceId: string | undefined) {
    let target: Promise<SourceFile | null> | undefined;
    let allowed: Promise<string | null> | undefined;
    let lookup: Promise<LookupContext> | undefined;
    let keys: Promise<Array<DupKey & { sourceId: string }>> | undefined;
    let keysStale = false;
    /** The queue turn of this call's last store: any other turn since means other stores may have happened. */
    let lastTurn = -1;
    const self = {
      /** The source dropped onto (null when it does not exist). */
      target: () =>
        (target ??= (async () => {
          try {
            return await repo.getSource(projectId, toSourceId!);
          } catch (err) {
            if (err instanceof NotFoundError) return null;
            throw err;
          }
        })()),
      /**
       * null when allowed, else the plain-language reason (the deny is audited once). The store
       * check uses what the transaction will use: the target source's own provenance (its legal
       * basis), or the project's defaults for a new source.
       */
      policy: () =>
        (allowed ??= (async () => {
          try {
            await authorizeProcessing(repo, projectId, { action: "capture", capture: { method: "manual_upload" } }, { op: "attach" });
            const sf = toSourceId ? await self.target() : null;
            const store = sf
              ? storeRequest(sf.source.provenance)
              : await (async () => {
                  const { identifiable, legalBasis } = await storeInputs(projectId);
                  return { action: "store" as const, store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } };
                })();
            await authorizeProcessing(repo, projectId, store, { op: "attach" });
            return null;
          } catch (err) {
            if (err instanceof PolicyDeniedError) return err.reason;
            if (err instanceof ProjectLockedError) return REASONS.locked;
            throw err;
          }
        })()),
      lookup: () => (lookup ??= lookupContextFor(repo, projectId, http, deps.debug ? { debug: deps.debug } : {})),
      /** Inside a queue turn: forget the cached duplicate keys if anyone else stored since this call's last turn. */
      refreshKeys: () => {
        const t = storeTurn(repo, projectId);
        if (t !== lastTurn + 1) keysStale = true;
        lastTurn = t;
      },
      keys: () => {
        if (keysStale) {
          keys = undefined;
          keysStale = false;
        }
        return (keys ??= (async () => {
          const out: Array<DupKey & { sourceId: string }> = [];
          for (const id of repo.listSourceIds(projectId)) {
            try {
              out.push(dupKey(await repo.getSource(projectId, id)));
            } catch {
              // an unreadable source cannot be compared
            }
          }
          return out;
        })());
      },
    };
    return self;
  }
  type Session = ReturnType<typeof session>;

  /** True when `readable` is given and refuses `path` now (each open of the file asks it again). */
  const notReadable = async (path: string) => !!deps.readable && !(await deps.readable(path).catch(() => false));

  const storeInputs = (projectId: string) => sharedStoreInputs(repo, projectId, undefined, deps.debug);

  type Stored = { ext: string; mime: string; kind: string };

  async function ontoSource(projectId: string, path: string, sf: SourceFile, mime: string, stored: Stored, sha256: string): Promise<AttachOutcome> {
    const sourceId = sf.source.id;
    // Files added in this call count too.
    const current = await repo.getSource(projectId, sourceId);
    if (current.assets.some((a) => a.sha256 === sha256)) return { path, outcome: "duplicate", sourceId };
    // Media with GPS: location governance applies to the store (R54a).
    // Unreadable metadata counts as located (fail closed, R57); a thrown error is not swallowed.
    let hasLocation = false;
    if (LOCATED_MEDIA.test(mime)) {
      if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON); // before the metadata read
      hasLocation = mayHaveLocation(mime, await extractMetadata(path, mime));
    }
    const plan = locatedPlan(hasLocation, mime);
    const rule = locationRule();
    const { ext, kind } = stored;
    if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON); // before the copy
    await addCapturedOriginal(repo, projectId, sourceId, { fromPath: path, kind, ext, mime: stored.mime, label: addedLabel(kind, new Date()) }, "manual_upload", {
      hasLocation,
      refuse: rule.hook,
      pendingProxies: (asset) => pendingFor(plan, [asset], rule.mode()),
    });
    return { path, outcome: "attached", sourceId, ...proxyNote(projectId, sourceId, plan, rule.mode()) };
  }

  /** A single dropped file's proxy plan: located photos and videos get one under a location rule. */
  function locatedPlan(hasLocation: boolean, mime: string): ProxyPlan {
    const type = proxyTypeFor(mime);
    return { located: hasLocation, proxies: hasLocation && type ? [{ index: 0, type }] : [] };
  }

  /** Starts the stored file's proxy jobs; the note when they must wait for a media worker (R83). */
  function proxyNote(projectId: string, sourceId: string, plan: ProxyPlan, mode: string | undefined): { note?: string } {
    if (!mode || !plan.proxies.length) return {};
    const proxies = deps.proxies ?? proxyQueueFor(repo);
    if (proxies.available) {
      proxies.enqueue(projectId, sourceId);
      return {};
    }
    return { note: LOCATION_REASON };
  }

  async function ontoLibrary(projectId: string, path: string, mime: string, stored: Stored, sha256: string, s: Session): Promise<AttachOutcome> {
    const keys = await s.keys();
    const same = keys.find((k) => k.sha256s.includes(sha256));
    if (same) return { path, outcome: "duplicate", sourceId: same.sourceId };

    const sidecarPaths = await findSidecars(path, deps.readable);
    if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON); // before the metadata read (resolveItem's first step)
    const r = await resolveItem(
      { path, mime, sidecarPaths, ...(deps.readable ? { sidecarReadable: deps.readable } : {}) },
      { projectId, patterns, lookup: await s.lookup() },
    );
    const dup = findDuplicate(candidateKey(r, [sha256]), keys);
    if (dup?.certainty === "certain") return { path, outcome: "duplicate", sourceId: dup.sourceId };
    const reviewItem = reviewFor(r, dup);
    const needsReview = !!reviewItem;

    const { identifiable, legalBasis } = await storeInputs(projectId);
    const provenance = itemProvenance(r, {
      captureMethod: "manual_upload",
      tool: { name: "drag-and-drop", version: VERSION },
      identifiable,
      ...(legalBasis ? { legalBasis } : {}),
    });
    // createSource evaluates capture and store again, right before writing (R42). Under a location
    // condition (coarsen/strip) the viewing proxy is queued in the same change (R83).
    const plan = locatedPlan(r.hasLocation, mime);
    const rule = locationRule();
    if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON); // before the copy, perhaps long after the lookups
    const sf = await createSourceRefusing(repo, projectId, r.draft, [{ path, role: "original", handling: "copy", ext: stored.ext, mime: stored.mime, kind: stored.kind }], {
      provenance,
      fieldEvidence: r.fieldEvidence,
      verification: r.verification.fields,
      ...(r.hasLocation ? { hasLocation: true } : {}),
      ...(reviewItem ? { reviewItem } : {}),
      pendingProxies: (assets) => pendingFor(plan, assets, rule.mode()),
    }, rule.hook);
    keys.push(dupKey(sf));
    const note = proxyNote(projectId, sf.source.id, plan, rule.mode());
    if (!needsReview) return { path, outcome: "created", sourceId: sf.source.id, ...note };
    return { path, outcome: "needs-review", sourceId: sf.source.id, reason: dup ? REASONS.likelyDuplicate : REASONS.review, ...note };
  }

  async function attachOne(projectId: string, path: string, toSourceId: string | undefined, s: Session, freshKeys = false): Promise<AttachOutcome> {
    if (freshKeys) s.refreshKeys();
    const st = await fsp.stat(path).catch(() => null);
    if (!st) return failed(path, REASONS.missing);
    if (st.isDirectory()) return failed(path, FOLDER_REASON);
    if (!st.isFile()) return failed(path, REASONS.notAFile);
    // Before the first byte is read (the type sniff below), and again before EACH later open (the hash, the
    // metadata, the copy): a file that is not on this computer, or no longer as it was checked, is not read (A6).
    if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON);
    let type: { ext: string; mime: string } | undefined;
    try {
      type = await fileTypeFromFile(path);
    } catch {
      return failed(path, REASONS.missing);
    }
    const stored = type ? acceptedType(type) : undefined;
    if (!type || !stored) return failed(path, REASONS.unsupported);
    const target = toSourceId ? await s.target() : null;
    if (toSourceId && !target) return failed(path, REASONS.noSource);
    const denied = await s.policy();
    if (denied) return failed(path, denied);
    if (await notReadable(path)) return failed(path, NOT_DOWNLOADED_REASON); // before the hash
    const sha256 = await sha256File(path);
    if (target) return ontoSource(projectId, path, target, type.mime, stored, sha256);
    return ontoLibrary(projectId, path, type.mime, stored, sha256, s);
  }

  async function attachFiles(projectId: string, paths: string[], opts: { toSourceId?: string } = {}): Promise<AttachOutcome[]> {
    repo.getProject(projectId); // NotFoundError for an unknown project
    const s = session(projectId, opts.toSourceId);
    const out: AttachOutcome[] = [];
    for (const path of paths) {
      try {
        // One file at a time per project, across attach, watched folders and Bulk Import (R81 I4);
        // the duplicate keys are read afresh inside the turn.
        out.push(await serialStore(repo, projectId, () => attachOne(projectId, path, opts.toSourceId, s, true)));
      } catch (err) {
        if (err instanceof PolicyDeniedError) out.push(failed(path, err.reason));
        else if (err instanceof ProjectLockedError) out.push(failed(path, REASONS.locked));
        else if (err instanceof UnsafeFileError) out.push(failed(path, REASONS.unsafe));
        else {
          deps.debug?.(`attach failed unexpectedly: ${err instanceof Error ? err.name : "error"}`);
          out.push(failed(path, REASONS.failed));
        }
      }
    }
    return out;
  }

  return { attachFiles };
}
