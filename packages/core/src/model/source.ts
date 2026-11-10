import { z } from "zod";
import { Annotation } from "./annotation.js";
import { Asset } from "./asset.js";
import { EdtfLite, Id, LibraryRelativePath, MultiText, Timestamp } from "./text.js";

export const SourceType = z.enum([
  "book", "chapter", "article-journal", "preprint", "report", "thesis", "webpage",
  "social-post", "video", "audio", "image", "dataset", "field-photo", "field-video",
  "field-recording", "interview", "manuscript", "presentation", "other",
]);
export type SourceType = z.infer<typeof SourceType>;

export const Creator = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
  role: z.enum([
    "author", "editor", "translator", "uploader", "channel", "photographer",
    "interviewer", "interviewee", "contributor",
  ]),
  handle: z.string().optional(),
});
export type Creator = z.infer<typeof Creator>;

/** Immutable after creation (enforced in the repository layer). */
export const Provenance = z.object({
  captureMethod: z.enum([
    "official_api", "browser_capture", "downloader", "manual_upload",
    "zotero_import", "device_import", "refman_import", "calibre_import",
  ]),
  capturedAt: Timestamp,
  originalUrl: z.string().optional(),
  tool: z.object({ name: z.string(), version: z.string() }),
  fileHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  platformSnapshot: z.unknown().optional(),
  identification: z.object({ method: z.string(), confidence: z.number() }).optional(),
  importBatchId: Id.optional(),
  externalKeys: z.record(z.string(), z.string()).optional(),
  legal: z.object({
    status: z.enum(["public", "consented", "restricted", "unknown"]),
    basis: z.string().optional(),
  }),
  identifiable: z.boolean(),
  /** How the item was reached: through the researcher's signed-in browser session, or without one. Never the session itself. */
  access: z.enum(["signed-in-session", "public"]).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Availability = z.object({
  status: z.enum(["available", "incomplete", "unavailable-on-platform"]),
  reason: z.string().optional(),
  firstNoticedAt: Timestamp.optional(),
});
export type Availability = z.infer<typeof Availability>;

export const FieldEvidenceSource = z.object({
  kind: z.enum([
    "embedded", "lookup", "platform-json", "page-dom", "filename", "ai",
    "zotero", "refman", "ocr", "user",
  ]),
  provider: z.string().optional(),
  ref: z.string().optional(),
});

export const FieldEvidence = z.object({
  field: z.string(), // JSON pointer
  value: z.unknown(),
  source: FieldEvidenceSource,
  quote: z.string().optional(),
  at: Timestamp,
});
export type FieldEvidence = z.infer<typeof FieldEvidence>;

export const FieldVerification = z.object({
  status: z.enum(["verified", "single-source", "unverified", "conflict", "user-confirmed"]),
  checks: z.array(z.string()),
  reason: z.string().optional(),
  values: z.array(z.object({ value: z.unknown(), source: FieldEvidenceSource })).optional(),
  /** The record's own value at check time (evidence values go in `values`). */
  current: z.unknown().optional(),
});
export type FieldVerification = z.infer<typeof FieldVerification>;

export const Identifiers = z.object({
  doi: z.string().optional(),
  isbn: z.array(z.string()).optional(),
  issn: z.string().optional(),
  url: z.string().optional(),
  platformPostId: z.string().optional(),
  platform: z.enum(["youtube", "instagram", "tiktok", "other"]).optional(),
  arxiv: z.string().optional(),
});

/**
 * Optional bibliographic detail (R87), stored as text like the other descriptive fields: volume,
 * issue, page range ("115–134"), edition, number of pages, place of publication, series title and
 * number, overrides of the genre and medium the citation type map gives (e.g. "Video" for a
 * reel, "Photograph"), and the work's own number (a report's number, R88). All optional, so sources written before them read unchanged.
 */
export const BIBLIO_FIELDS = [
  "volume", "issue", "page", "edition", "numberOfPages", "publisherPlace", "collectionTitle", "collectionNumber", "genre", "medium", "number",
] as const;
export type BiblioField = (typeof BIBLIO_FIELDS)[number];
export const BIBLIO_MAX = 1000;
const BiblioText = z.string().min(1).max(BIBLIO_MAX).optional();
export const BiblioShape = {
  volume: BiblioText,
  issue: BiblioText,
  page: BiblioText,
  edition: BiblioText,
  numberOfPages: BiblioText,
  publisherPlace: BiblioText,
  collectionTitle: BiblioText,
  collectionNumber: BiblioText,
  genre: BiblioText,
  medium: BiblioText,
  number: BiblioText,
} satisfies Record<BiblioField, z.ZodTypeAny>;
export type Biblio = Partial<Record<BiblioField, string>>;

/** The bibliographic fields of `o` that hold text (trimmed, at most BIBLIO_MAX characters; empty ones dropped). */
export function biblioOf(o: Partial<Record<BiblioField, unknown>> | undefined): Biblio {
  const out: Biblio = {};
  if (!o) return out;
  for (const k of BIBLIO_FIELDS) {
    const v = o[k];
    const t = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    if (t) out[k] = t.slice(0, BIBLIO_MAX);
  }
  return out;
}

export const Source = z.object({
  id: Id,
  projectIds: z.array(Id),
  type: SourceType,
  title: MultiText,
  creators: z.array(Creator),
  container: MultiText.optional(),
  publisher: z.string().optional(),
  ...BiblioShape,
  issued: EdtfLite.optional(),
  accessed: Timestamp.optional(),
  identifiers: Identifiers,
  citationKey: z.string(),
  caseAttributes: z.record(z.string(), z.string()),
  provenance: Provenance,
  availability: Availability.default({ status: "available" }),
  collectionIds: z.array(Id),
  tagIds: z.array(Id),
  participantIds: z.array(Id),
  sessionId: Id.optional(),
  createdAt: Timestamp,
  createdBy: z.string(),
  modifiedAt: Timestamp,
  modifiedBy: z.string(),
  folder: LibraryRelativePath,
});
export type Source = z.infer<typeof Source>;

/** What importers produce before the repository assigns ids, folder, and provenance. */
export const SourceDraft = Source.omit({
  id: true,
  folder: true,
  createdAt: true,
  createdBy: true,
  modifiedAt: true,
  modifiedBy: true,
  provenance: true,
  citationKey: true,
}).extend({ citationKey: z.string().optional() });
export type SourceDraft = z.infer<typeof SourceDraft>;

/**
 * A viewing proxy (spec 5.3) waiting to be made for one of the source's originals (R83): an
 * image.proxy / video.proxy job of the media worker, with the location rule it must apply. Kept in
 * source.json (sealed in encrypted projects) from the change that stored the original until the
 * change that records the proxy, so a job queued while no worker was available (the source is
 * "proxy pending"), or interrupted, is run again later (R31). `failed`: the job ran and failed
 * (e.g. the proxy's GPS did not match the rule); it is not retried on its own.
 */
export const PendingProxy = z.object({
  id: Id,
  type: z.enum(["image.proxy", "video.proxy"]),
  assetId: Id,
  location: z.enum(["keep", "coarsen", "strip"]),
  queuedAt: Timestamp,
  failed: z.object({ code: z.string().max(64), at: Timestamp }).optional(),
});
export type PendingProxy = z.infer<typeof PendingProxy>;

/** The source.json shape. */
export const SourceFile = z.object({
  formatVersion: z.literal(1),
  source: Source,
  assets: z.array(Asset),
  /**
   * In memory: all the source's annotations. On disk (R74 I4) they live in the source folder's
   * annotations.json (annotations.json.enc, sealed, in encrypted projects); source.json keeps `[]`
   * plus annotationCount and annotationsSha256 (of the file's JSON). A source.json from before
   * that still holds them inline is read as is and moved on its next write.
   */
  annotations: z.array(Annotation),
  annotationCount: z.number().int().min(0).optional(),
  annotationsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * Keys of items at other sources that were merged into this source (R76), by kind, e.g.
   * { zotero: ["ABCD2345"] }: deleting the source records them as deleted here too. Not provenance
   * (which never changes after creation); written by merges, reverted by undo.
   */
  mergedExternalKeys: z.record(z.string(), z.array(z.string().max(256)).max(10_000)).optional(),
  fieldEvidence: z.array(FieldEvidence).default([]),
  verification: z.record(z.string(), FieldVerification).default({}),
  /** Viewing proxies still to be made (R83); absent or empty when none are pending. */
  pendingProxies: z.array(PendingProxy).max(10_000).optional(),
});
export type SourceFile = z.infer<typeof SourceFile>;
