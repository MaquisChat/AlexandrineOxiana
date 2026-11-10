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
 * duplicates (R55): they go on the review entry as `hints`. Media with GPS are stored with
 * `hasLocation: true`, so location governance applies (R54a); while a location condition (coarsen or
 * strip) cannot be carried out for dropped files, such a store is refused as an audited deny with
 * LOCATION_REASON and nothing is stored (R56; Task 27 adds the coarsening).
 *
 * Each stored file is one governed mutation (`createSource` / an original added to a source): the
 * `capture` and `store` decisions are evaluated again inside it, right before anything is written
 * (R42), so governance edited during the lookups stops the store (deny audited, nothing saved).
 *
 * Reasons are fixed plain-language sentences or the policy's own reason: never a path or an error
 * message. Not wired here: purging the lookup client's sensitive memory cache when a project is
 * locked (`HttpClient.purgeSensitive`); the Repo has no lock hook or event yet (carried to Task 30).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { fileTypeFromFile } from "file-type";
import { findDuplicate, primary, type DupKey, type FileNamePattern, type PolicyDecision, type PolicyRequest, type Provenance, type SourceFile } from "@ao/core";
import { UnsafeFileError, extractMetadata } from "../extract/index.js";
import { lookupContextFor, type HttpClient, type LookupContext } from "../lookup/index.js";
import { NotFoundError, PolicyDeniedError, ProjectLockedError } from "../repo/errors.js";
import { kindFor } from "../repo/io.js";
import { storeRequest } from "../repo/sources.js";
import { addCapturedOriginal, authorizeProcessing, createSourceRefusing, projectPolicy, type Repo } from "../repo/repo.js";
import { AUTO_ACCEPT_THRESHOLD, resolveItem, type Resolution } from "./resolve.js";
import { findSidecars } from "./sidecar.js";

const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export type AttachStatus = "created" | "attached" | "duplicate" | "needs-review" | "failed";

export interface AttachOutcome {
  /** The path as given. */
  path: string;
  outcome: AttachStatus;
  sourceId?: string;
  reason?: string;
}

export interface AttachDeps {
  repo: Repo;
  /** The lookup client (one per library; its cache lives in `<Library>/.cache/lookups`). */
  http: HttpClient;
  /** User file-name patterns, vetted by the caller (see parseFileName). */
  patterns?: FileNamePattern[];
  /** Receives short notes (lookup providers skipped or failed). */
  debug?: (note: string) => void;
}

export interface Attach {
  attachFiles(projectId: string, paths: string[], opts?: { toSourceId?: string }): Promise<AttachOutcome[]>;
}

export const FOLDER_REASON = "Use Bulk Import for folders";
const REASONS = {
  missing: "The file could not be found or read.",
  notAFile: "Only files can be attached.",
  unsupported: "This kind of file cannot be attached. Attach PDFs, EPUB or Kindle books, Word documents, images, audio or video.",
  unsafe: "This file could not be opened safely, so it was not attached.",
  locked: "The project is locked. Unlock it, then try again.",
  noSource: "The source to attach to could not be found.",
  failed: "The file could not be attached.",
  review: "Some details could not be confirmed, so the source is in the review queue.",
  likelyDuplicate: "This may be a duplicate of a source already in the project, so it is in the review queue.",
  lowConfidence: "The item could not be identified with enough confidence.",
};

/** R56: until GPS coarsening/stripping exists (Task 27), media whose store needs it are refused. */
export const LOCATION_REASON =
  "This file contains location data that this project requires to be coarsened or removed; that step is not available for dropped files yet.";
const refuseLocation = (d: PolicyDecision, req: PolicyRequest): string | undefined =>
  req.action === "store" && d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "location") ? LOCATION_REASON : undefined;

/** The `consent.defaultLegalBasis` category manual uploads use (docs/governance/README.md). */
const LEGAL_CATEGORY = "manual-upload";

/**
 * The sniffed (`file-type`) extensions attach accepts: documents and books, images (incl. camera
 * raw), audio and video. Each has its MIME type and asset kind in repo/io.ts.
 */
export const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "epub", "mobi", "azw", "azw3", "docx",
  "jpg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "cr2", "cr3", "dng", "nef", "arw", "orf", "rw2", "raf",
  "mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp", "mpg",
  "mp3", "m4a", "wav", "ogg", "flac", "aac", "opus",
]);

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) h.update(chunk);
  return h.digest("hex");
}

function dupKey(sf: SourceFile): DupKey & { sourceId: string } {
  const s = sf.source;
  const c = s.creators[0];
  const family = c?.family ?? c?.literal;
  return {
    sourceId: s.id,
    sha256s: sf.assets.filter((a) => a.role === "original").map((a) => a.sha256),
    ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}),
    ...(s.identifiers.isbn?.length ? { isbns: s.identifiers.isbn } : {}),
    ...(primary(s.title) ? { title: primary(s.title) } : {}),
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(s.issued ? { year: s.issued.slice(0, 4) } : {}),
  };
}

function candidateKey(r: Resolution, sha256: string): DupKey {
  const d = r.draft;
  const c = d.creators[0];
  const family = c?.family ?? c?.literal;
  return {
    sha256s: [sha256],
    ...(d.identifiers.doi ? { doi: d.identifiers.doi } : {}),
    ...(d.identifiers.isbn?.length ? { isbns: d.identifiers.isbn } : {}),
    title: primary(d.title),
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(d.issued ? { year: d.issued.slice(0, 4) } : {}),
  };
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
      keys: () =>
        (keys ??= (async () => {
          const out: Array<DupKey & { sourceId: string }> = [];
          for (const id of repo.listSourceIds(projectId)) {
            try {
              out.push(dupKey(await repo.getSource(projectId, id)));
            } catch {
              // an unreadable source cannot be compared
            }
          }
          return out;
        })()),
    };
    return self;
  }
  type Session = ReturnType<typeof session>;

  async function storeInputs(projectId: string): Promise<{ identifiable: boolean; legalBasis?: string }> {
    const policy = await projectPolicy(repo, projectId);
    const identifiable = policy?.identifiability.containsIdentifiable ?? true;
    const legalBasis = policy?.consent.defaultLegalBasis?.[LEGAL_CATEGORY]?.trim() || undefined;
    return { identifiable, ...(legalBasis ? { legalBasis } : {}) };
  }

  async function ontoSource(projectId: string, path: string, sf: SourceFile, mime: string, ext: string, sha256: string): Promise<AttachOutcome> {
    const sourceId = sf.source.id;
    // Files added in this call count too.
    const current = await repo.getSource(projectId, sourceId);
    if (current.assets.some((a) => a.sha256 === sha256)) return { path, outcome: "duplicate", sourceId };
    // Media with GPS: location governance applies to the store (R54a).
    const hasLocation = /^(?:image|video)\//u.test(mime) && !!(await extractMetadata(path, mime).catch(() => undefined))?.media?.gps;
    const kind = kindFor(ext);
    await addCapturedOriginal(repo, projectId, sourceId, { fromPath: path, kind, ext, label: addedLabel(kind, new Date()) }, "manual_upload", {
      hasLocation,
      refuse: refuseLocation,
    });
    return { path, outcome: "attached", sourceId };
  }

  async function ontoLibrary(projectId: string, path: string, mime: string, ext: string, sha256: string, s: Session): Promise<AttachOutcome> {
    const keys = await s.keys();
    const same = keys.find((k) => k.sha256s.includes(sha256));
    if (same) return { path, outcome: "duplicate", sourceId: same.sourceId };

    const r = await resolveItem({ path, mime, sidecarPaths: await findSidecars(path) }, { projectId, patterns, lookup: await s.lookup() });
    const dup = findDuplicate(candidateKey(r, sha256), keys);
    if (dup?.certainty === "certain") return { path, outcome: "duplicate", sourceId: dup.sourceId };
    const needsReview = !!dup || r.confidence < AUTO_ACCEPT_THRESHOLD || r.verification.overall === "needs-review";

    const { identifiable, legalBasis } = await storeInputs(projectId);
    const provenance: Provenance = {
      captureMethod: "manual_upload",
      capturedAt: new Date().toISOString(),
      tool: { name: "drag-and-drop", version: VERSION },
      fileHashes: {},
      identification: { method: r.evidence.method, confidence: r.confidence },
      legal: { status: "unknown", ...(legalBasis ? { basis: legalBasis } : {}) },
      identifiable,
    };
    const flagged = Object.fromEntries(
      Object.entries(r.verification.fields).filter(([, v]) => v.status === "conflict" || v.status === "unverified").map(([k, v]) => [k, v.status]),
    );
    const reasons = [
      ...(dup ? [REASONS.likelyDuplicate] : []),
      ...r.verification.reasons,
      ...(r.confidence < AUTO_ACCEPT_THRESHOLD && r.verification.reasons.length === 0 ? [REASONS.lowConfidence] : []),
    ];
    // createSource evaluates capture and store again, right before writing (R42).
    // A location condition (coarsen/strip) cannot be honoured yet: an audited deny, nothing stored (R56).
    const sf = await createSourceRefusing(repo, projectId, r.draft, [{ path, role: "original", handling: "copy", ext }], {
      provenance,
      fieldEvidence: r.fieldEvidence,
      verification: r.verification.fields,
      ...(r.hasLocation ? { hasLocation: true } : {}),
      ...(needsReview
        ? {
            reviewItem: {
              kind: "import" as const,
              fields: flagged,
              reasons,
              confidence: r.confidence,
              method: r.evidence.method,
              candidates: r.candidates,
              ...(dup ? { duplicateOf: { sourceId: dup.sourceId, reason: dup.reason } } : {}),
              ...(r.identifierHints.length ? { hints: r.identifierHints } : {}),
            },
          }
        : {}),
    }, refuseLocation);
    keys.push(dupKey(sf));
    if (!needsReview) return { path, outcome: "created", sourceId: sf.source.id };
    return { path, outcome: "needs-review", sourceId: sf.source.id, reason: dup ? REASONS.likelyDuplicate : REASONS.review };
  }

  async function attachOne(projectId: string, path: string, toSourceId: string | undefined, s: Session): Promise<AttachOutcome> {
    const st = await fsp.stat(path).catch(() => null);
    if (!st) return failed(path, REASONS.missing);
    if (st.isDirectory()) return failed(path, FOLDER_REASON);
    if (!st.isFile()) return failed(path, REASONS.notAFile);
    let type: { ext: string; mime: string } | undefined;
    try {
      type = await fileTypeFromFile(path);
    } catch {
      return failed(path, REASONS.missing);
    }
    if (!type || !ACCEPTED_EXTENSIONS.has(type.ext)) return failed(path, REASONS.unsupported);
    const target = toSourceId ? await s.target() : null;
    if (toSourceId && !target) return failed(path, REASONS.noSource);
    const denied = await s.policy();
    if (denied) return failed(path, denied);
    const sha256 = await sha256File(path);
    if (target) return ontoSource(projectId, path, target, type.mime, type.ext, sha256);
    return ontoLibrary(projectId, path, type.mime, type.ext, sha256, s);
  }

  async function attachFiles(projectId: string, paths: string[], opts: { toSourceId?: string } = {}): Promise<AttachOutcome[]> {
    repo.getProject(projectId); // NotFoundError for an unknown project
    const s = session(projectId, opts.toSourceId);
    const out: AttachOutcome[] = [];
    for (const path of paths) {
      try {
        out.push(await attachOne(projectId, path, opts.toSourceId, s));
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
