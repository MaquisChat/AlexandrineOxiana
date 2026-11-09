import { z } from "zod";
import { Id, LibraryRelativePath, Timestamp } from "./text.js";

export const Asset = z.object({
  id: Id,
  sourceId: Id,
  role: z.enum(["original", "derived"]),
  kind: z.string().min(1), // 'pdf','video','image','ocr-text','proxy', ...
  path: LibraryRelativePath,
  encrypted: z.boolean(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  mime: z.string(),
  linked: z.object({ absolutePath: z.string(), libraryRelativePath: LibraryRelativePath }).optional(),
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
    })
    .optional(),
});
export type Asset = z.infer<typeof Asset>;
