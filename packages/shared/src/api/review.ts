/**
 * The project's review queue (R172, Task 67): `GET /projects/:id/review` lists every pending entry
 * of the project, of every kind. Each entry is decided by the library's own decision for its kind:
 * an import entry (with or without a batch) by `POST /review/:itemId/decide` (the project in the
 * body); a verification conflict's field by `PATCH /projects/:id/sources/:sid/fields` (R149).
 */

/**
 * Where an entry came from, so a person can tell entries apart:
 * - `import`: an item of an import batch (`batchId` names it);
 * - `attach`: a file added by hand (drag and drop), an import entry with no batch;
 * - `capture`: a capture saved with fields that need review (a verification entry with fields);
 * - `withdrawal`: a source flagged because a participant's consent was withdrawn (a verification
 *   entry with no fields).
 */
export type ReviewGroup = "import" | "attach" | "capture" | "withdrawal";

/** The group of an entry, from what the library records with it (kind, batch, fields). */
export function reviewGroup(e: { kind: string; batchId?: string | undefined; fields?: Record<string, unknown> | undefined }): ReviewGroup {
  if (e.kind === "import") return e.batchId ? "import" : "attach";
  return e.fields && Object.keys(e.fields).length > 0 ? "capture" : "withdrawal";
}

/** One pending entry of the project's queue. Reasons, candidates, hints and the title are source or user text. */
export interface ProjectReviewEntry {
  id: string;
  projectId: string;
  sourceId: string;
  kind: "import" | "verification";
  group: ReviewGroup;
  status: "pending";
  /** When it was queued (ISO 8601). */
  createdAt: string;
  /** JSON pointer → the field's verification status when it was queued. */
  fields: Record<string, string>;
  /** Why it waits, in plain words. */
  reasons: string[];
  /** The source's current title. */
  title?: string;
  batchId?: string;
  confidence?: number;
  method?: string;
  candidates?: unknown[];
  duplicateOf?: { sourceId: string; reason: string };
  hints?: string[];
}

/** `GET /projects/:id/review?offset&limit&source`: one page of the queue, oldest first; `total` counts every entry the query matches. */
export interface ProjectReviewPage {
  items: ProjectReviewEntry[];
  total: number;
  offset: number;
  limit: number;
}

/** The most entries one page may hold; `limit=0` answers only the total. */
export const PROJECT_REVIEW_PAGE_MAX = 1000;
