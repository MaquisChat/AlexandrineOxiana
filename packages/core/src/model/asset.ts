import { z } from "zod";
import { Id, LibraryRelativePath, LinkedRelativePath, Timestamp } from "./text.js";

/**
 * How a file was got (Find and acquire, plan ruling 6 / R225): set once, when the asset is added, because the
 * source's provenance is immutable and was written when the record came in. `address` is the file's address with
 * user name, password, query and fragment removed (and a proxy host turned back into the publisher's host, F15+).
 * `check` (F11, R277): how the file came to be attached — it matched its record (`by` DOI or title), or the
 * researcher accepted it in the review queue after the check found it did not clearly match (`why`).
 */
export const AcquiredFrom = z.object({
  method: z.enum(["free_copy", "library_access"]),
  via: z.enum(["service", "sign-in-window", "browser-extension"]),
  service: z.enum(["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"]).optional(),
  address: z.string().max(2000),
  at: Timestamp,
  tool: z.object({ name: z.string().max(200), version: z.string().max(100) }),
  access: z.enum(["public", "signed-in-session"]),
  check: z
    .union([
      z.object({ result: z.literal("match"), by: z.enum(["doi", "title"]) }),
      z.object({ result: z.literal("accepted-after-mismatch"), why: z.enum(["other-doi", "title-absent", "no-text", "other-version", "other-kind"]) }),
    ])
    .optional(),
});
export type AcquiredFrom = z.infer<typeof AcquiredFrom>;

export const Asset = z
  .object({
  id: Id,
  sourceId: Id,
  role: z.enum(["original", "derived"]),
  kind: z.string().min(1), // 'pdf','video','image','ocr-text','proxy', ...
  /** Library-relative; a linked asset's path is its `linked.libraryRelativePath` (may start with "..", R24). */
  path: z.string().min(1),
  encrypted: z.boolean(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  mime: z.string(),
  /** A file linked in place (not copied): its absolute path when linked and its path relative to the library root. */
  linked: z.object({ absolutePath: z.string(), libraryRelativePath: LinkedRelativePath }).optional(),
  derivation: z
    .object({
      parents: z.array(Id),
      operation: z.string(),
      provider: z.string(),
      model: z.string().optional(),
      ranAt: z.string(), // 'local' or a vendor id
      params: z.record(z.string(), z.unknown()),
      at: Timestamp,
      triggeredBy: z.string(),
    })
    .optional(),
  /**
   * Absent: the file is stored. `destroyed`: the file was destroyed under the project's retention
   * rule (spec 6.3(5), R90 d) — overwritten and removed; the record (path, sha256) is kept as
   * evidence and the destruction certificate names it.
   */
  status: z.enum(["destroyed"]).optional(),
  /** Find and acquire: how this file was got (set once, when it is added). */
  acquired: AcquiredFrom.optional(),
  /** When the file was destroyed (with `status: "destroyed"`). */
  destroyedAt: Timestamp.optional(),
  metadata: z
    .object({
      capturedAt: Timestamp.optional(),
      tzOffset: z.string().optional(),
      device: z.string().optional(),
      lens: z.string().optional(),
      gps: z
        .object({ lat: z.number(), lon: z.number(), precision: z.enum(["exact", "coarse"]) })
        .optional(),
      pairedAssetId: Id.optional(),
      /** Transcripts: how many segments the hallucination checks flagged for review (spec 5.8). */
      flaggedSegments: z.number().int().min(0).optional(),
      /** Captured recordings: the quality asked of the video downloader (whole channels, R668). */
      requestedQuality: z.enum(["best", "1080p", "720p", "audio", "ready"]).optional(),
    })
    .optional(),
  })
  .superRefine((a, ctx) => {
    const ok = a.linked ? a.path === a.linked.libraryRelativePath : LibraryRelativePath.safeParse(a.path).success;
    if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: a.linked ? "a linked asset's path must be its libraryRelativePath" : "not a library-relative path" });
  });
export type Asset = z.infer<typeof Asset>;
