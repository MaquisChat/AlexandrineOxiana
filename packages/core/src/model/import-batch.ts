import { z } from "zod";
import { Id, Timestamp } from "./text.js";

export const ImportOptions = z.object({
  fileHandling: z.enum(["copy", "link"]).default("copy"),
  structure: z.enum(["collections", "tags", "none"]).default("collections"),
  duplicates: z.enum(["merge", "skip", "keep-both"]).default("merge"),
  ocr: z.boolean().default(true),
  transcribe: z.boolean().default(false),
  autoAcceptThreshold: z.number().min(0).max(1).default(0.8),
});
export type ImportOptions = z.infer<typeof ImportOptions>;

const count = z.number().int().min(0);

export const ImportBatch = z.object({
  id: Id,
  projectId: Id,
  number: z.number().int().min(1),
  source: z.object({
    kind: z.enum([
      "folder", "zip", "zotero-local", "zotero-web", "zotero-rdf", "bibtex", "ris",
      "csl-json", "calibre", "device", "attach", "profile-capture",
    ]),
    location: z.string(),
  }),
  options: ImportOptions,
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
  counts: z.object({
    created: count, merged: count, skipped: count, failed: count, needsReview: count,
  }),
});
export type ImportBatch = z.infer<typeof ImportBatch>;
