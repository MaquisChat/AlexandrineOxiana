import { z } from "zod";
import { Id, Timestamp } from "./text.js";

/**
 * Items resolved with at least this confidence are accepted without review (R53, R54): the default
 * of `ImportOptions.autoAcceptThreshold` and the threshold drag-and-drop attach uses.
 */
export const AUTO_ACCEPT_THRESHOLD = 0.9;

/**
 * A user file-name pattern: a regular expression with named groups `creator`, `year`, `title`.
 * Vetted with `vetFileNamePattern` when the options are accepted, and run under a watchdog (R49d).
 */
export const FileNamePatternOption = z.object({ id: z.string().min(1).max(100), regex: z.string().min(1).max(500) });

export const ImportOptions = z.object({
  fileHandling: z.enum(["copy", "link"]).default("copy"),
  structure: z.enum(["collections", "tags", "none"]).default("collections"),
  duplicates: z.enum(["merge", "skip", "keep-both"]).default("merge"),
  ocr: z.boolean().default(true),
  transcribe: z.boolean().default(false),
  autoAcceptThreshold: z.number().min(0).max(1).default(AUTO_ACCEPT_THRESHOLD),
  fileNamePatterns: z.array(FileNamePatternOption).max(50).default([]),
});
export type ImportOptions = z.infer<typeof ImportOptions>;
/** What a caller passes (every field optional; defaults filled in by `ImportOptions.parse`). */
export type ImportOptionsInput = z.input<typeof ImportOptions>;

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
