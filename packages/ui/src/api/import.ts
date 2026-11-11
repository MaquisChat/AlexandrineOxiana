/**
 * Typed methods for Bulk Import and the review queue (Task 35, R113), built on the client's
 * `request()`. Shapes mirror apps/library-service/src/routes/{import,review,projects,governance,
 * fieldwork,sources}.ts and the library types they return (ScanSummary, ImportReport, ReviewEntry,
 * UndoResult).
 *
 * The service has no secrets route (yet): the Zotero Web API key cannot be stored from the UI. It is
 * set with `ao secrets set zotero-api-key` (Task 26 CLI) and read by the service from the OS keyring.
 */
// Only the governance modules: the rest of @ao/core (citation styles, ...) stays out of the bundle.
import { effectivePolicy } from "@ao/core/src/governance/merge";
import { parseGovernance } from "@ao/core/src/governance/schema";
import type { ApiClient } from "./client";

// ---------------------------------------------------------------------------------------------
// Shapes

export type PathAdapterKind = "folder" | "zip" | "bibtex" | "ris" | "csl-json" | "zotero-rdf" | "calibre";

/** `adapter` of dry-run and start (routes/import.ts adapterSpec). */
export type ImportAdapter =
  | { kind: PathAdapterKind; path: string }
  | { kind: "zotero-local"; dataDir: string }
  | { kind: "zotero-web"; libraryType: "user" | "group"; libraryId: string; full?: boolean };

export interface ApproveOutside {
  folders?: string[];
  files?: string[];
  rememberFolders?: string[];
}

/** ImportOptionsInput (@ao/core import-batch.ts): what the wizard sets. */
export interface ImportOptions {
  fileHandling: "copy" | "link";
  structure: "collections" | "tags" | "none";
  duplicates: "merge" | "skip" | "keep-both";
  ocr: boolean;
  transcribe: boolean;
  approveOutside?: ApproveOutside;
}

/** ScanSummary (packages/library/src/import/bulk/run.ts). */
export interface ScanSummary {
  items: number;
  byType: Record<string, number>;
  totalBytes: number;
  likelyDuplicates: number;
  alreadyImported: number;
  unreadable: Array<{ path: string; reason: string }>;
  notes: string[];
  /**
   * Files outside the source's own folders and the library's approved folders (R67): the item's
   * label and the folder the file is in. `file` (the file's own path) is used for per-file approval
   * when the service sends it; today's service sends only item and folder.
   */
  outsideFiles: Array<{ item: string; folder: string; file?: string }>;
}

export type BatchState = "running" | "paused" | "cancelled" | "finished" | "failed" | "undone" | "interrupted";

export interface BatchCounts {
  items: number;
  created: number;
  needsReview: number;
  duplicates: number;
  merged: number;
  updated: number;
  unchanged: number;
  deletedHere: number;
  failed: number;
}

export interface GovernanceNote {
  action: string;
  result: string;
  reason?: string;
  items?: number;
}

/** ImportReport (packages/library/src/import/bulk/report.ts). */
export interface ImportReport {
  batchId: string;
  number: number;
  kind: string;
  state: BatchState;
  startedAt: string;
  finishedAt?: string;
  counts: BatchCounts;
  failures: Array<{ item: string; reason: string }>;
  fileNotes: Array<{ item: string; note: string }>;
  pendingReview: Array<{ reviewId: string; sourceId?: string; reasons: string[] }>;
  keptFields: Array<{ item: string; fields: string[] }>;
  governance: GovernanceNote[];
  notes: string[];
}

export interface BatchSummary {
  batchId: string;
  number: number;
  kind: string;
  state: BatchState;
  startedAt: string;
  finishedAt?: string;
  counts: { created: number; merged: number; skipped: number; failed: number; needsReview: number };
}

export interface UndoResult {
  removedSources: number;
  revertedMerges: number;
  kept: Array<{ kind: string; id: string; sourceId?: string; reason: string }>;
}

/** A lookup candidate (LookupResult, packages/library/src/lookup/context.ts). */
export interface Candidate {
  title: string;
  creators: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  type: string;
  identifiers?: { doi?: string; isbn?: string[]; issn?: string };
  provider: string;
}

/** ReviewEntry (packages/library/src/repo/review.ts), import items. */
export interface ReviewItem {
  id: string;
  projectId: string;
  sourceId?: string;
  kind: "verification" | "import";
  status: "pending" | "resolved";
  createdAt: string;
  fields: Record<string, string>;
  reasons: string[];
  confidence?: number;
  method?: string;
  candidates?: Candidate[];
  duplicateOf?: { sourceId: string; reason: string };
  hints?: string[];
  batchId?: string;
}

export type ReviewDecision =
  | { action: "accept"; draft?: { type?: string; title?: MultiText } }
  | { action: "accept-candidate"; index: number }
  | { action: "merge"; sourceId: string }
  | { action: "skip" }
  | { action: "keep-both" };

export interface ReviewPatch {
  type?: string;
  tagIds?: string[];
  collectionId?: string;
}

export interface Creator {
  family?: string;
  given?: string;
  literal?: string;
  role?: string;
}

export interface MultiText {
  variants: Array<{ lang: string; kind: "original" | "romanized" | "translated"; value: string }>;
}

/** The parts of source.json (GET /projects/:id/sources/:sid) the review preview shows. */
export interface SourceFile {
  source: {
    id: string;
    type: string;
    title: MultiText;
    creators: Creator[];
    issued?: string;
    publisher?: string;
    identifiers?: Record<string, unknown>;
    collectionIds: string[];
    tagIds: string[];
    provenance?: { identification?: { method: string; confidence: number }; importBatchId?: string };
  };
  assets: Array<{ id: string; fileName?: string; mediaType?: string; role?: string; linked?: unknown }>;
  fieldEvidence: Array<{ field: string; value?: unknown; source: { kind: string } }>;
}

export interface ProjectInfo {
  id: string;
  name: string;
  encrypted?: boolean;
  unlocked?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  parentId?: string;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  scope?: string;
}

export interface Participant {
  id: string;
  code: string;
}

export interface FieldSession {
  id: string;
  date: string;
  place?: string;
  participantIds: string[];
}

export interface SourceListItem {
  id: string;
  title: string;
  type: string;
}

/** `import.progress` event data (apps/library-service/src/state.ts followBatch). */
export interface ImportProgressEvent {
  batchId: string;
  projectId: string;
  state: BatchState;
  done?: number;
  total?: number;
  counts?: BatchCounts;
  error?: { code?: string; message?: string } | string;
}

/** What a project's governance means for an import (R24, R64). */
export interface ImportPolicy {
  /** Names are pseudonymised: titles from file names and collections from folder names can carry participant names. */
  pseudonymizeNames: boolean;
  /** Files must be stored encrypted: link in place is refused. */
  encryptionRequired: boolean;
}

// ---------------------------------------------------------------------------------------------
// Methods

const seg = (s: string) => encodeURIComponent(s);

/**
 * The import-relevant reading of a project's governance.yaml. Unreadable rules count as the
 * strictest reading (pseudonymise, encrypt), as the service denies everything then.
 */
export function importPolicyFromYaml(yaml: string): ImportPolicy {
  try {
    const p = effectivePolicy(parseGovernance(yaml)).policy;
    return {
      pseudonymizeNames: p.identifiability.containsIdentifiable && p.identifiability.pseudonymizeFileNames,
      encryptionRequired: p.encryption.atRest === "required",
    };
  } catch {
    return { pseudonymizeNames: true, encryptionRequired: true };
  }
}

export function importApi(client: ApiClient) {
  const r = client.request;
  return {
    projects: async () => (await r<{ projects: ProjectInfo[] }>("GET", "/projects")).projects,
    policy: async (projectId: string): Promise<ImportPolicy> =>
      importPolicyFromYaml((await r<{ yaml: string }>("GET", `/projects/${seg(projectId)}/governance`)).yaml),

    dryRun: (projectId: string, adapter: ImportAdapter, approveOutside?: ApproveOutside) =>
      r<ScanSummary>("POST", `/projects/${seg(projectId)}/import/dry-run`, { body: { adapter, ...(approveOutside ? { approveOutside } : {}) } }),
    start: (projectId: string, adapter: ImportAdapter, options: ImportOptions) =>
      r<{ batchId: string }>("POST", `/projects/${seg(projectId)}/import`, { body: { adapter, options } }),
    deviceImport: (projectId: string, body: { dir: string; sessionId?: string; participantIds?: string[]; options: Omit<ImportOptions, "approveOutside"> }) =>
      r<{ batchId: string }>("POST", `/projects/${seg(projectId)}/device-import`, { body }),
    batches: async (projectId: string) => (await r<{ batches: BatchSummary[] }>("GET", `/projects/${seg(projectId)}/imports`)).batches,

    pause: (batchId: string) => r<{ batchId: string; action: string }>("POST", `/imports/${seg(batchId)}/pause`),
    resume: (batchId: string) => r<{ batchId: string; action: string }>("POST", `/imports/${seg(batchId)}/resume`),
    cancel: (batchId: string) => r<{ batchId: string; action: string }>("POST", `/imports/${seg(batchId)}/cancel`),
    undo: (batchId: string) => r<UndoResult>("POST", `/imports/${seg(batchId)}/undo`),
    report: (batchId: string) => r<ImportReport>("GET", `/imports/${seg(batchId)}/report`),
    review: async (batchId: string) => (await r<{ items: ReviewItem[] }>("GET", `/imports/${seg(batchId)}/review`)).items,

    /** Review routes take the project in the body (R97). */
    decide: (projectId: string, itemId: string, decision: ReviewDecision) =>
      r<{ decided: boolean }>("POST", `/review/${seg(itemId)}/decide`, { body: { projectId, decision } }),
    bulkEdit: (projectId: string, itemIds: string[], patch: ReviewPatch) =>
      r<{ edited: number }>("POST", "/review/bulk-edit", { body: { projectId, itemIds, patch } }),

    source: (projectId: string, sourceId: string) => r<SourceFile>("GET", `/projects/${seg(projectId)}/sources/${seg(sourceId)}`),
    searchSources: async (projectId: string, text: string) =>
      (await r<{ items: SourceListItem[] }>("GET", `/projects/${seg(projectId)}/sources`, { query: { text, limit: 20 } })).items,
    collections: async (projectId: string) => (await r<{ collections: Collection[] }>("GET", `/projects/${seg(projectId)}/collections`)).collections,
    tags: async (projectId: string) => (await r<{ tags: Tag[] }>("GET", `/projects/${seg(projectId)}/tags`)).tags,
    participants: async (projectId: string) => (await r<{ participants: Participant[] }>("GET", `/projects/${seg(projectId)}/participants`)).participants,
    sessions: async (projectId: string) => (await r<{ sessions: FieldSession[] }>("GET", `/projects/${seg(projectId)}/sessions`)).sessions,
  };
}

export type ImportApi = ReturnType<typeof importApi>;

/** True for an `import.progress` event about `batchId`. */
export function isProgressFor(batchId: string, e: { type: string; data: unknown }): e is { type: "import.progress"; data: ImportProgressEvent } {
  return e.type === "import.progress" && typeof e.data === "object" && e.data !== null && (e.data as { batchId?: unknown }).batchId === batchId;
}
