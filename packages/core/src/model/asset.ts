import { z } from "zod";
import { Id, LibraryRelativePath, LinkedRelativePath, Timestamp } from "./text.js";

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
    })
    .optional(),
  })
  .superRefine((a, ctx) => {
    const ok = a.linked ? a.path === a.linked.libraryRelativePath : LibraryRelativePath.safeParse(a.path).success;
    if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: a.linked ? "a linked asset's path must be its libraryRelativePath" : "not a library-relative path" });
  });
export type Asset = z.infer<typeof Asset>;
