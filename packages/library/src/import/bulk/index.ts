/** Bulk Import (spec 5.4, 3.8; Task 23): the engine's public surface. */
import type { ImportOptionsInput } from "@ao/core";
import type { ReviewEntry } from "../../repo/review.js";
import { batchReport, type ImportReport } from "./report.js";
import { bulkEditReview, decideReview, listReview, type ListedReviewEntry, type ReviewDecision, type ReviewPatch } from "./review.js";
import {
  dryRun,
  listBatches,
  resumeBatch,
  startBatch,
  type BatchHandle,
  type BatchSummary,
  type BulkImportDeps,
  type ScanSummary,
} from "./run.js";
import type { ImportSourceAdapter } from "./scan.js";
import { undoBatch, type UndoResult } from "./undo.js";
import { importDeviceFolder, type DeviceImportOptions } from "../device.js";

export interface BulkImport {
  /** Wizard step 2: what a batch would find; nothing is written. */
  dryRun(projectId: string, adapter: ImportSourceAdapter, opts?: { approveOutside?: { folders?: string[]; files?: string[] } }): Promise<ScanSummary>;
  startBatch(projectId: string, adapter: ImportSourceAdapter, options?: ImportOptionsInput): Promise<BatchHandle>;
  /** Folder, ZIP, reference-manager export and Calibre batches find their source from the record; other kinds need the adapter. */
  resumeBatch(projectId: string, batchId: string, adapter?: ImportSourceAdapter): Promise<BatchHandle>;
  listBatches(projectId: string): Promise<BatchSummary[]>;
  listReview(projectId: string, batchId: string): Promise<ListedReviewEntry[]>;
  decideReview(projectId: string, itemId: string, decision: ReviewDecision): Promise<void>;
  bulkEditReview(projectId: string, itemIds: string[], patch: ReviewPatch): Promise<void>;
  batchReport(projectId: string, batchId: string): Promise<ImportReport>;
  undoBatch(projectId: string, batchId: string): Promise<UndoResult>;
  /** iPhone and camera media (spec 5.3): a device folder as a batch, every new source linked to the session and participants given. */
  importDeviceFolder(projectId: string, dir: string, opts?: DeviceImportOptions): Promise<BatchHandle>;
}

export function createBulkImport(deps: BulkImportDeps): BulkImport {
  const { repo } = deps;
  return {
    dryRun: (p, a, o) => dryRun(deps, p, a, o),
    startBatch: (p, a, o) => startBatch(deps, p, a, o),
    resumeBatch: (p, b, a) => resumeBatch(deps, p, b, a),
    listBatches: (p) => listBatches(repo, p),
    listReview: (p, b) => listReview(repo, p, b),
    decideReview: (p, i, d) => decideReview(repo, p, i, d),
    bulkEditReview: (p, i, x) => bulkEditReview(repo, p, i, x),
    batchReport: (p, b) => batchReport(repo, p, b),
    undoBatch: (p, b) => undoBatch(repo, p, b),
    importDeviceFolder: (p, d, o) => importDeviceFolder(deps, p, d, o),
  };
}

export { BatchRefusedError, REASONS as BULK_REASONS } from "./run.js";
export type { BatchHandle, BatchProgress, BatchRefusalKind, BatchResult, BatchSummary, BulkImportDeps, ScanSummary, BatchCounts } from "./run.js";
export type { ImportReport } from "./report.js";
export type { ReviewDecision, ReviewPatch } from "./review.js";
export type { UndoKept, UndoResult } from "./undo.js";
export { adapterFor, folderAdapter, zipAdapter } from "./scan.js";
export type { ImportSourceAdapter, ScanContext, ScanFile, ScanItem } from "./scan.js";
export { PATTERN_BUDGET_MS } from "./patterns.js";
