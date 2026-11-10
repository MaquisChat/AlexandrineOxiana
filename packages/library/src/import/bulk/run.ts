/**
 * The Bulk Import engine (spec 5.4 steps 2–7, 3.8; R59): dry run, batches with pause/resume/cancel
 * and a journal, the review queue, the report and undo.
 *
 * Per item, in the source's order (streamed, never all in memory):
 *   1. an item already in the batch's journal is skipped (resume);
 *   2. its file is sniffed (`file-type`; the types drag-and-drop attach accepts), hashed, and a
 *      file already in the project (index dedupe keys plus the batch's own, R59) is a `duplicate`;
 *   3. user file-name patterns run under the watchdog (R49d); `resolveItem` identifies the item
 *      with the rules of R55–R58 unchanged (lookups only through `lookupContextFor`);
 *   4. duplicates by the draft's (confirmed) DOI/ISBN follow `options.duplicates`: `skip` →
 *      `duplicate`, `merge` → the existing source gets the item's files and missing fields (after a
 *      snapshot of its source.json in the batch folder), `keep-both` → a new source; a fuzzy match
 *      → created and queued for review;
 *   5. otherwise a new source, `created` at or above `options.autoAcceptThreshold`, else created and
 *      queued for review (`review/pending.jsonl` with the batch id, R31). Folders become nested
 *      collections or tags (`options.structure`).
 * Every store is governed (R26: txn marker, change log, audit): each item's `capture` and `store`
 * are evaluated again right before writing (R42) and audited as events about its own source, and
 * its journal line is written in the same change. New sources are stored in groups of up to 32 per
 * change (shared fixed costs); a group the policy refuses is stored item by item, so a deny fails
 * only the items concerned, with the policy's reason, and the batch goes on. Location-
 * conditioned media are refused (R56, LOCATION_REASON). Journal lines of items that stored nothing
 * (duplicates, failures) are written with the next store or at the next checkpoint; after a crash
 * such an item is simply processed again, with the same result.
 *
 * Linking (`fileHandling: 'link'`) stores the file's absolute path and its path relative to the
 * library (LinkedRelativePath, R24) and copies nothing; it is refused in projects whose governance
 * requires encryption at rest or that are encrypted. Files unpacked from archives are always copied.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileTypeFromFile } from "file-type";
import {
  Asset,
  ImportOptions,
  LinkedRelativePath,
  findDuplicate,
  newId,
  vetFileNamePattern,
  type DupMatch,
  type ImportBatch,
  type ImportOptionsInput,
  type PolicyDecision,
  type Provenance,
  type SourceDraft,
  type SourceFile,
} from "@ao/core";
import { UnsafeFileError } from "../../extract/errors.js";
import { extractMetadata } from "../../extract/index.js";
import type { IndexDb } from "../../index/db.js";
import { lookupContextFor, type HttpClient, type LookupContext } from "../../lookup/index.js";
import { NotFoundError, PolicyDeniedError, ProjectLockedError } from "../../repo/errors.js";
import type { SourceInputFile } from "../../repo/sources.js";
import { storeRequest } from "../../repo/sources.js";
import {
  authorizeProcessing,
  createSourceRefusing,
  createSourcesRefusing,
  importChange,
  projectCollectionsAndTags,
  projectEncrypted,
  hasSource,
  projectPolicyOrDefault,
  repoLibrary,
  type Repo,
} from "../../repo/repo.js";
import { activeTemp } from "../../tmp-registry.js";
import { acceptedType } from "../attach.js";
import { MANUAL_UPLOAD_CATEGORY, candidateKey, itemProvenance, refuseLocation, reviewFor, sha256File, storeInputs } from "../common.js";
import { resolveItem, type Resolution } from "../resolve.js";
import { findSidecars } from "../sidecar.js";
import {
  BOOKKEEPING,
  PRIVATE_MODE,
  activeBatches,
  appendJournal,
  itemKeyHash,
  runListeners,
  batchDirs,
  countOutcomes,
  fileName,
  findBatch,
  latestByKey,
  readBatchAt,
  readJournal,
  writeBatchRecord,
  type BatchRecord,
  type BatchState,
  type GovernanceNote,
  type JournalEntry,
  type ShownState,
} from "./batch.js";
import { BatchDedupe } from "./dedupe.js";
import { applyMerge, missingFields, type MergeRecord } from "./merge.js";
import { writeBatchReport } from "./report.js";
import { PATTERN_BUDGET_MS, PatternWatchdog } from "./patterns.js";
import { adapterFor, type ImportSourceAdapter, type ScanItem } from "./scan.js";

const VERSION: string = (createRequire(import.meta.url)("../../../package.json") as { version: string }).version;
const TOOL = { name: "bulk-import", version: VERSION };

export const REASONS = {
  missing: "The file could not be found or read.",
  unsupported: "This kind of file cannot be imported. Import PDFs, EPUB or Kindle books, Word documents, images, audio or video.",
  unreadable: "The file could not be read; it may be damaged or protected with a password.",
  unsafe: "This file could not be opened safely, so it was not imported.",
  failed: "The item could not be imported.",
  duplicateFile: "The same file is already in the project.",
  duplicateId: "A source with the same DOI or ISBN is already in the project.",
  linkEncrypted:
    "Files cannot be linked in place in this project: its files must be encrypted at rest, and a linked file stays outside the library. Choose to copy the files instead.",
} as const;

/** A batch could not start (or resume): the options or the project's rules do not allow it. */
export class BatchRefusedError extends Error {
  override name = "BatchRefusedError";
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface BulkImportDeps {
  repo: Repo;
  /** The lookup client (one per library). */
  http: HttpClient;
  /** The library index (dedupe keys; TEMP schema for unlocked encrypted projects). */
  index: { db: IndexDb };
  /** Queues OCR for a source whose PDF has no text layer (Task 15's worker), when `options.ocr`. */
  queueOcr?: (projectId: string, sourceId: string) => void | Promise<void>;
  debug?: (note: string) => void;
  /** Test seam: the watchdog budget per pattern per name (default 50 ms). */
  patternBudgetMs?: number;
}

export interface BatchProgress {
  done: number;
  /** Items the source said it holds (or found so far, when it cannot count). */
  total: number;
  /** The item being worked on (its key: a path relative to the import's root). */
  current?: string;
}

export interface BatchCounts {
  items: number;
  created: number;
  needsReview: number;
  duplicates: number;
  merged: number;
  failed: number;
}

export interface BatchResult {
  batchId: string;
  state: BatchState;
  counts: BatchCounts;
}

export interface BatchHandle {
  batchId: string;
  pause(): void;
  resume(): void;
  cancel(): void;
  progress: AsyncIterable<BatchProgress>;
  /** Settles when the run stops (finished, cancelled or failed). */
  done: Promise<BatchResult>;
}

export interface ScanSummary {
  items: number;
  byType: Record<string, number>;
  totalBytes: number;
  /** Items that are likely duplicates of another item in the scan or of a source in the project. */
  likelyDuplicates: number;
  /** Items whose file is already in the project. */
  alreadyImported: number;
  unreadable: Array<{ path: string; reason: string }>;
}

export interface BatchSummary {
  batchId: string;
  number: number;
  kind: ImportBatch["source"]["kind"];
  state: ShownState;
  startedAt: string;
  finishedAt?: string;
  counts: ImportBatch["counts"];
}

const CAPTURE_METHOD: Record<ImportBatch["source"]["kind"], Provenance["captureMethod"]> = {
  folder: "manual_upload",
  zip: "manual_upload",
  attach: "manual_upload",
  "zotero-local": "zotero_import",
  "zotero-web": "zotero_import",
  "zotero-rdf": "zotero_import",
  bibtex: "refman_import",
  ris: "refman_import",
  "csl-json": "refman_import",
  calibre: "calibre_import",
  device: "device_import",
  "profile-capture": "downloader",
};
const legalCategory = (m: Provenance["captureMethod"]) => (m === "manual_upload" ? MANUAL_UPLOAD_CATEGORY : m.replace(/_/gu, "-"));

const active = activeBatches;

export const isBatchActive = (batchId: string) => active.has(batchId);

/** Latest-value progress, readable by any number of consumers. */
class ProgressFeed {
  private last: BatchProgress = { done: 0, total: 0 };
  private seq = 0;
  private ended = false;
  private wake = new Set<() => void>();
  emit(p: BatchProgress): void {
    this.last = p;
    this.seq++;
    for (const w of this.wake) w();
    this.wake.clear();
  }
  end(): void {
    this.ended = true;
    for (const w of this.wake) w();
    this.wake.clear();
  }
  iterable(): AsyncIterable<BatchProgress> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        let seen = 0;
        return {
          async next(): Promise<IteratorResult<BatchProgress>> {
            for (;;) {
              if (self.seq > seen) {
                seen = self.seq;
                return { value: { ...self.last }, done: false };
              }
              if (self.ended) return { value: undefined, done: true };
              await new Promise<void>((r) => self.wake.add(r));
            }
          },
        };
      },
    };
  }
}

/** Options as given → parsed options, or BatchRefusedError with a plain reason (patterns vetted, R49d). */
export function acceptOptions(input: ImportOptionsInput): ImportOptions {
  const parsed = ImportOptions.safeParse(input);
  if (!parsed.success) throw new BatchRefusedError("The import options are not valid.");
  const ids = new Set<string>();
  for (const p of parsed.data.fileNamePatterns) {
    if (ids.has(p.id)) throw new BatchRefusedError(`Two file-name patterns are both called "${p.id}".`);
    ids.add(p.id);
    const v = vetFileNamePattern(p.regex);
    if (!v.ok) throw new BatchRefusedError(`File-name pattern "${p.id}": ${v.reason}`);
  }
  return parsed.data;
}

const decisionNote = (action: string, d: PolicyDecision): GovernanceNote => ({
  action,
  result: d.result,
  ...(d.result === "deny" ? { reason: d.reason } : {}),
  ...(d.result === "allow_with_conditions" ? { conditions: d.conditions } : {}),
});

/**
 * Whether linking in place is refused (R24): the project is encrypted, or its effective policy
 * requires encryption at rest. No governance.yaml means the default policy; a governance file that
 * cannot be read or parsed refuses (fail closed).
 */
export async function preflightLink(repo: Repo, projectId: string): Promise<boolean> {
  if (projectEncrypted(repo, projectId)) return true;
  const policy = await projectPolicyOrDefault(repo, projectId);
  return !policy || policy.encryption.atRest === "required";
}

/** Policy and option checks a batch must pass before it starts (or resumes). */
async function preflight(repo: Repo, projectId: string, kind: ImportBatch["source"]["kind"], options: ImportOptions): Promise<GovernanceNote[]> {
  repo.getProject(projectId); // NotFoundError for an unknown project
  if (options.fileHandling === "link" && (await preflightLink(repo, projectId))) throw new BatchRefusedError(REASONS.linkEncrypted);
  const method = CAPTURE_METHOD[kind];
  const { identifiable, legalBasis } = await storeInputs(repo, projectId, legalCategory(method));
  const notes: GovernanceNote[] = [];
  try {
    notes.push(decisionNote("capture", await authorizeProcessing(repo, projectId, { action: "capture", capture: { method } }, { op: "import.batch" })));
    notes.push(
      decisionNote(
        "store",
        await authorizeProcessing(repo, projectId, { action: "store", store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } }, { op: "import.batch" }),
      ),
    );
  } catch (err) {
    if (err instanceof PolicyDeniedError) throw new BatchRefusedError(err.reason);
    if (err instanceof ProjectLockedError) throw new BatchRefusedError("The project is locked. Unlock it, then try again.");
    throw err;
  }
  return notes;
}

/** Saves the batch record (and any journal lines given) in one governed change. */
async function saveRecord(repo: Repo, projectId: string, rec: BatchRecord, journal: JournalEntry[] = []): Promise<void> {
  const projectRel = repo.getProject(projectId).folder;
  await repo.mutate(
    projectId,
    BOOKKEEPING,
    async (tx) => {
      if (journal.length) await appendJournal(tx, projectRel, rec.dir, journal);
      await writeBatchRecord(tx, projectRel, rec);
    },
    { op: "import.batch.save" },
  );
}

const sleepTurn = () => new Promise<void>((r) => setImmediate(r));

/**
 * New sources are stored in groups of up to this many per governed change: every source's capture
 * and store are still evaluated and audited about it, but the change's fixed costs (write-ahead
 * marker, change log, anchor) are shared. Items unpacked from archives and media that may carry a
 * location are stored one by one.
 */
const GROUP = 32;
const PLACEHOLDER = "pending:";
const isPlaceholder = (id: string | undefined) => !!id && id.startsWith(PLACEHOLDER);

interface Queued {
  item: ScanItem;
  r: Resolution;
  inputs: SourceInputFile[];
  draft: SourceDraft;
  provenance: Provenance;
  reviewItem: ReturnType<typeof reviewFor>;
  placeholder: string;
}

/** One running (or resumed) batch. */
class Run {
  readonly feed = new ProgressFeed();
  private paused = false;
  private cancelled = false;
  private gate: (() => void) | null = null;
  private readonly abort = new AbortController();
  /** Journal lines of items that stored nothing, written with the next change. */
  private pending: JournalEntry[] = [];
  private readonly latest: Map<string, JournalEntry>;
  private readonly createdIds: Set<string>;
  private readonly denies = new Map<string, number>();
  private workDir: string | null = null;
  private readonly workName: string;
  private structureCache = new Map<string, { collectionIds: string[]; tagIds: string[] }>();
  private projectTags: { collections: Array<{ id: string; name: string; parentId?: string }>; tags: Array<{ id: string; name: string }> } | null = null;
  private snapshots = 0;
  private group: Queued[] = [];
  private placeholders = 0;
  private inputsCache: { at: number; method: string; value: { identifiable: boolean; legalBasis?: string } } | null = null;
  private dedupe: BatchDedupe | null = null;
  private lookup: LookupContext | null = null;
  readonly done: Promise<BatchResult>;
  private settle!: (r: BatchResult) => void;
  private fail!: (e: unknown) => void;

  constructor(
    private readonly deps: BulkImportDeps,
    private readonly projectId: string,
    private readonly rec: BatchRecord,
    private readonly adapter: ImportSourceAdapter,
    journal: JournalEntry[],
    /** Resume guard: item-key hash → source of this batch found without a journal line. */
    private readonly recovered: Map<string, string> = new Map(),
  ) {
    this.latest = latestByKey(journal);
    this.createdIds = new Set(rec.createdSourceIds);
    for (const e of this.latest.values()) if (e.sourceId && (e.outcome === "created" || e.outcome === "needs-review")) this.createdIds.add(e.sourceId);
    this.workName = `batch-${rec.id}`;
    this.done = new Promise((res, rej) => {
      this.settle = res;
      this.fail = rej;
    });
    this.done.catch(() => {});
  }

  /** Starts the run; whatever happens, `done` settles. */
  start(): void {
    this.run().catch((err: unknown) => {
      runListeners.delete(this.rec.id);
      active.delete(this.rec.id);
      this.feed.end();
      this.fail(err);
    });
  }

  handle(): BatchHandle {
    return {
      batchId: this.rec.id,
      pause: () => {
        this.paused = true;
      },
      resume: () => {
        this.paused = false;
        this.gate?.();
        this.gate = null;
      },
      cancel: () => {
        this.cancelled = true;
        this.abort.abort();
        this.gate?.();
        this.gate = null;
      },
      progress: this.feed.iterable(),
      done: this.done,
    };
  }

  private get repo() {
    return this.deps.repo;
  }
  private get projectRel() {
    return this.repo.getProject(this.projectId).folder;
  }

  private async ensureWorkDir(): Promise<string> {
    if (this.workDir) return this.workDir;
    const dir = join(repoLibrary(this.repo).root, ".tmp", this.workName);
    activeTemp.add(this.workName);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(dir, 0o700);
    this.workDir = dir;
    return dir;
  }

  private async cleanup(): Promise<void> {
    if (this.workDir) await fsp.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(this.workName);
  }

  private counts(): BatchCounts {
    return countOutcomes(this.latest.values());
  }

  private syncRecord(state: BatchState): void {
    const c = this.counts();
    this.rec.state = state;
    this.rec.counts = { created: c.created, merged: c.merged, skipped: c.duplicates, failed: c.failed, needsReview: c.needsReview };
    this.rec.createdSourceIds = [...this.createdIds];
    this.rec.governance = [
      ...this.rec.governance.filter((g) => g.items === undefined),
      ...[...this.denies].map(([reason, items]) => ({ action: "store", result: "deny" as const, reason, items })),
    ];
  }

  private async checkpoint(state: BatchState, finished = false): Promise<void> {
    await this.flush();
    this.syncRecord(state);
    if (finished) this.rec.finishedAt = new Date().toISOString();
    const lines = this.pending;
    await saveRecord(this.repo, this.projectId, this.rec, lines);
    this.pending = this.pending.slice(lines.length);
  }

  private note(text: string): void {
    if (!this.rec.notes.includes(text)) this.rec.notes.push(text);
  }

  async run(): Promise<void> {
    active.add(this.rec.id);
    // A review decision on one of this run's items supersedes the outcome it recorded.
    runListeners.set(this.rec.id, (line) => this.latest.set(line.key, line));
    const watchdog = new PatternWatchdog(this.rec.options.fileNamePatterns, this.deps.patternBudgetMs ?? PATTERN_BUDGET_MS);
    let state: BatchState = "finished";
    try {
      const dedupe = new BatchDedupe(this.deps.index.db, this.projectId, (id) => hasSource(this.repo, this.projectId, id));
      this.dedupe = dedupe;
      this.lookup = await lookupContextFor(this.repo, this.projectId, this.deps.http, this.deps.debug ? { debug: this.deps.debug } : {});
      let total = 0;
      try {
        total = (await this.adapter.count?.(this.abort.signal)) ?? 0;
      } catch {
        total = 0;
      }
      if (total) this.rec.total = total;
      let done = 0;
      const seenKeys = new Set<string>();
      this.feed.emit({ done, total });
      const scan = this.adapter.scan(this.abort.signal, { workDir: () => this.ensureWorkDir() });
      for await (const item of scan) {
        if (seenKeys.has(item.key)) continue;
        seenKeys.add(item.key);
        if (!this.latest.has(item.key) && this.recovered.size) {
          // Resume guard: a source of this batch for this item exists although its line was lost.
          const sid = this.recovered.get(itemKeyHash(this.rec.secret!, item.key));
          if (sid) this.latest.set(item.key, this.queue({ key: item.key, outcome: "created", sourceId: sid }));
        }
        if (this.latest.has(item.key)) {
          done++;
          total = Math.max(total, done);
          continue;
        }
        if (this.paused) {
          await this.checkpoint("paused");
          await new Promise<void>((r) => {
            this.gate = r;
            if (!this.paused || this.cancelled) r();
          });
          if (!this.cancelled) await this.checkpoint("running");
        }
        if (this.cancelled) break;
        this.feed.emit({ done, total: Math.max(total, done + 1), current: item.key });
        const entry = await this.item(item, dedupe, watchdog);
        if (entry) this.latest.set(entry.key, entry); // queued items are recorded when their group is stored
        done++;
        total = Math.max(total, done);
        this.feed.emit({ done, total });
        if (this.pending.length >= 200) await this.checkpoint("running");
        await sleepTurn();
      }
      await this.flush();
      if (this.cancelled) state = "cancelled";
    } catch (err) {
      if (this.cancelled && (err as Error)?.name === "AbortError") state = "cancelled";
      else {
        state = "failed";
        this.note(
          err instanceof ProjectLockedError
            ? "The project was locked during the import; unlock it and resume the batch."
            : err instanceof BatchRefusedError || err instanceof PolicyDeniedError
              ? err.reason
              : "The import stopped because of an unexpected error; resume the batch to continue.",
        );
        this.deps.debug?.(`bulk import stopped: ${err instanceof Error ? err.name : "error"}`);
      }
    } finally {
      await watchdog.close();
      await this.cleanup();
    }
    for (const id of watchdog.disabled) {
      this.note(`The file-name pattern "${id}" took too long on a file name and was switched off for the rest of this import.`);
    }
    try {
      await this.flush().catch(() => {});
      await this.checkpoint(state, true);
      await writeBatchReport(this.repo, this.projectId, this.rec.id);
    } catch (err) {
      this.deps.debug?.(`bulk import: the batch record could not be saved (${err instanceof Error ? err.name : "error"})`);
    } finally {
      runListeners.delete(this.rec.id);
      active.delete(this.rec.id);
      this.feed.end();
    }
    this.settle({ batchId: this.rec.id, state, counts: this.counts() });
  }

  /** Processes one item (null: queued in the current group); never throws for item-level problems (they become `failed`). */
  private async item(item: ScanItem, dedupe: BatchDedupe, watchdog: PatternWatchdog): Promise<JournalEntry | null> {
    try {
      if (item.unreadable) return this.queue({ key: item.key, outcome: "failed", reason: item.unreadable });
      return await this.importItem(item, dedupe, watchdog);
    } catch (err) {
      return this.itemError(item, err);
    }
  }

  /** An item's error as its `failed` journal line; errors that stop the batch are rethrown. */
  private itemError(item: ScanItem, err: unknown): JournalEntry {
    const failed = (reason: string): JournalEntry => this.queue({ key: item.key, outcome: "failed", reason });
    if (err instanceof PolicyDeniedError) {
      this.denies.set(err.reason, (this.denies.get(err.reason) ?? 0) + 1);
      return failed(err.reason);
    }
    if (err instanceof UnsafeFileError) return failed(REASONS.unsafe);
    if (err instanceof ProjectLockedError) throw err;
    if ((err as Error)?.name === "AbortError") throw err;
    if (err instanceof NotFoundError) return failed(REASONS.failed);
    this.deps.debug?.(`bulk import item failed: ${err instanceof Error ? err.name : "error"}`);
    return failed(REASONS.failed);
  }

  private queue(e: JournalEntry): JournalEntry {
    this.pending.push(e);
    return e;
  }

  private async importItem(item: ScanItem, dedupe: BatchDedupe, watchdog: PatternWatchdog): Promise<JournalEntry | null> {
    const opts = this.rec.options;
    const method = CAPTURE_METHOD[this.rec.source.kind];
    const fromArchive = item.key.includes("!/");
    const inputs: SourceInputFile[] = [];
    const shas: string[] = [];
    let mime = "";
    for (const f of item.files) {
      const st = await fsp.stat(f.path).catch(() => null);
      if (!st?.isFile()) return this.queue({ key: item.key, outcome: "failed", reason: REASONS.missing });
      const type = await fileTypeFromFile(f.path).catch(() => undefined);
      const stored = type ? acceptedType(type) : undefined;
      if (!type || !stored) return this.queue({ key: item.key, outcome: "failed", reason: REASONS.unsupported });
      if (!mime) mime = type.mime;
      const sha = await sha256File(f.path);
      shas.push(sha);
      inputs.push({ path: f.path, role: "original", handling: opts.fileHandling === "link" && !fromArchive ? "link" : "copy", ext: stored.ext, mime: stored.mime, kind: stored.kind });
    }
    // Same file → duplicate (whatever the duplicate policy).
    if (shas[0]) {
      let same = dedupe.bySha(shas[0]);
      if (isPlaceholder(same)) {
        await this.flush();
        same = dedupe.bySha(shas[0]);
      }
      if (same) return this.queue({ key: item.key, outcome: "duplicate", sourceId: same, reason: REASONS.duplicateFile });
    }
    const primaryFile = item.files[0];
    const name = primaryFile ? basename(primaryFile.path) : undefined;
    let userParsedName;
    if (name && watchdog.active) userParsedName = (await watchdog.match(name)).parsed;
    const r = await resolveItem(
      {
        ...(primaryFile ? { path: primaryFile.path, mime, sidecarPaths: await findSidecars(primaryFile.path), fileName: name } : {}),
        ...(item.referenceMetadata ? { referenceMetadata: item.referenceMetadata } : {}),
        ...(userParsedName ? { userParsedName } : {}),
      },
      { projectId: this.projectId, patterns: [], lookup: this.lookup },
    );
    if (r.unreadable) return this.queue({ key: item.key, outcome: "failed", reason: REASONS.unreadable });

    const key = candidateKey(r, shas);
    let dup: DupMatch | null = findDuplicate(key, dedupe.candidates(key));
    if (dup && isPlaceholder(dup.sourceId)) {
      // A match with a source queued in this group: store the group, then look again.
      await this.flush();
      dup = findDuplicate(key, dedupe.candidates(key));
    }
    if (dup?.certainty === "certain") {
      if (dup.reason === "same-file") return this.queue({ key: item.key, outcome: "duplicate", sourceId: dup.sourceId, reason: REASONS.duplicateFile });
      if (opts.duplicates === "skip") return this.queue({ key: item.key, outcome: "duplicate", sourceId: dup.sourceId, reason: REASONS.duplicateId });
      if (opts.duplicates === "merge") {
        await this.flush();
        return this.merge(item, dup.sourceId, r, inputs, method, dedupe);
      }
    }
    const reviewItem = reviewFor(r, dup?.certainty === "likely" ? dup : null, opts.autoAcceptThreshold);
    return this.create(item, r, inputs, shas, method, reviewItem, dedupe);
  }

  private async structure(folderPath: string[]): Promise<{ collectionIds: string[]; tagIds: string[] }> {
    const mode = this.rec.options.structure;
    if (mode === "none" || folderPath.length === 0) return { collectionIds: [], tagIds: [] };
    const k = folderPath.join("/");
    const cached = this.structureCache.get(k);
    if (cached) return cached;
    this.projectTags ??= await projectCollectionsAndTags(this.repo, this.projectId);
    const known = this.projectTags;
    let out: { collectionIds: string[]; tagIds: string[] };
    if (mode === "collections") {
      let parent: string | undefined;
      for (const seg of folderPath) {
        let c = known.collections.find((x) => x.name === seg && x.parentId === parent);
        if (!c) {
          c = await this.repo.createCollection(this.projectId, seg, parent);
          known.collections.push(c);
          this.rec.createdCollectionIds.push(c.id);
          await this.checkpoint("running"); // recorded at once, so undo finds it after a crash
        }
        parent = c.id;
      }
      out = { collectionIds: [parent!], tagIds: [] };
    } else {
      const ids: string[] = [];
      for (const seg of new Set(folderPath)) {
        let t = known.tags.find((x) => x.name.toLowerCase() === seg.toLowerCase());
        if (!t) {
          t = await this.repo.createTag(this.projectId, seg);
          known.tags.push(t);
          this.rec.createdTagIds.push(t.id);
          await this.checkpoint("running");
        }
        ids.push(t.id);
      }
      out = { collectionIds: [], tagIds: ids };
    }
    this.structureCache.set(k, out);
    return out;
  }

  private async provenanceFor(r: Resolution, method: Provenance["captureMethod"], item: ScanItem): Promise<Provenance> {
    // The project's identifiability and legal basis, re-read every few seconds (each store is
    // evaluated against the policy as it is then, R42; this only fills in the provenance).
    if (!this.inputsCache || this.inputsCache.method !== method || Date.now() - this.inputsCache.at > 2000) {
      this.inputsCache = { at: Date.now(), method, value: await storeInputs(this.repo, this.projectId, legalCategory(method), this.deps.debug) };
    }
    const { identifiable, legalBasis } = this.inputsCache.value;
    return itemProvenance(r, {
      captureMethod: method,
      tool: TOOL,
      identifiable,
      importBatchId: this.rec.id,
      ...(legalBasis ? { legalBasis } : {}),
      externalKeys: { ...(item.externalKeys ?? {}), [ITEM_KEY]: itemKeyHash(this.rec.secret!, item.key) },
    });
  }

  private async create(
    item: ScanItem,
    r: Resolution,
    inputs: SourceInputFile[],
    shas: string[],
    method: Provenance["captureMethod"],
    reviewItem: ReturnType<typeof reviewFor>,
    dedupe: BatchDedupe,
  ): Promise<JournalEntry | null> {
    const struct = await this.structure(item.folderPath ?? []);
    const draft: SourceDraft = {
      ...r.draft,
      collectionIds: [...new Set([...r.draft.collectionIds, ...struct.collectionIds])],
      tagIds: [...new Set([...r.draft.tagIds, ...struct.tagIds])],
    };
    const provenance = await this.provenanceFor(r, method, item);
    // Unpacked files are removed once the scan moves past their archive, and located media may be
    // refused on their own: those are stored at once, one by one.
    if (!r.hasLocation && !item.key.includes("!/")) {
      const placeholder = `${PLACEHOLDER}${++this.placeholders}`;
      dedupe.addPending(placeholder, candidateKey(r, shas));
      this.group.push({ item, r, inputs, draft, provenance, reviewItem, placeholder });
      if (this.group.length >= GROUP) await this.flush();
      return null;
    }
    await this.flush();
    return this.createOne({ item, r, inputs, draft, provenance, reviewItem, placeholder: "" }, dedupe);
  }

  /** Stores the queued group in one governed change; if that change is refused or fails, each item on its own. */
  private async flush(): Promise<void> {
    const group = this.group;
    if (!group.length) return;
    this.group = [];
    const dedupe = this.dedupe!;
    const flushLines = this.pending.length;
    const entries: JournalEntry[] = [];
    try {
      const stored = await createSourcesRefusing(
        this.repo,
        this.projectId,
        group.map((q, i) => ({
          draft: q.draft,
          files: q.inputs,
          opts: {
            provenance: q.provenance,
            fieldEvidence: q.r.fieldEvidence,
            verification: q.r.verification.fields,
            ...(q.reviewItem ? { reviewItem: { ...q.reviewItem, batchId: this.rec.id } } : {}),
          },
          inTx: async (tx, sf) => {
            const entry: JournalEntry = { key: q.item.key, outcome: q.reviewItem ? "needs-review" : "created", sourceId: sf.source.id };
            entries[i] = entry;
            await appendJournal(tx, this.projectRel, this.rec.dir, i === 0 ? [...this.pending.slice(0, flushLines), entry] : [entry]);
          },
        })),
        refuseLocation,
      );
      this.pending = this.pending.slice(flushLines);
      dedupe.dropPending(group.map((q) => q.placeholder));
      for (const [i, sf] of stored.entries()) {
        this.latest.set(entries[i]!.key, entries[i]!);
        this.createdIds.add(sf.source.id);
        dedupe.add(sf);
        const q = group[i]!;
        if (this.rec.options.ocr && q.r.needsOcr && q.inputs.length) await this.ocr(sf.source.id);
      }
    } catch (err) {
      if (err instanceof ProjectLockedError || (err as Error)?.name === "AbortError") throw err;
      // The group as a whole was refused (e.g. the rules changed during the run) or failed: each
      // item on its own, so only the items concerned fail, each with its own audited decision.
      dedupe.dropPending(group.map((q) => q.placeholder));
      for (const q of group) {
        let entry: JournalEntry;
        try {
          entry = await this.createOne(q, dedupe);
        } catch (e) {
          entry = this.itemError(q.item, e);
        }
        this.latest.set(entry.key, entry);
      }
    }
  }

  /** Stores one new source in its own governed change. */
  private async createOne(q: Queued, dedupe: BatchDedupe): Promise<JournalEntry> {
    const { item, r, inputs, draft, provenance, reviewItem } = q;
    const outcome = reviewItem ? "needs-review" : "created";
    const flush = this.pending.length;
    let entry: JournalEntry | undefined;
    // createSource evaluates capture and store again right before writing (R42); the journal line
    // is part of the same change.
    const sf = await createSourceRefusing(
      this.repo,
      this.projectId,
      draft,
      inputs,
      {
        provenance,
        fieldEvidence: r.fieldEvidence,
        verification: r.verification.fields,
        ...(r.hasLocation ? { hasLocation: true } : {}),
        ...(reviewItem ? { reviewItem: { ...reviewItem, batchId: this.rec.id } } : {}),
      },
      refuseLocation,
      async (tx, created) => {
        entry = { key: item.key, outcome, sourceId: created.source.id };
        await appendJournal(tx, this.projectRel, this.rec.dir, [...this.pending.slice(0, flush), entry]);
      },
    );
    this.pending = this.pending.slice(flush);
    this.createdIds.add(sf.source.id);
    dedupe.add(sf);
    if (this.rec.options.ocr && r.needsOcr && inputs.length) await this.ocr(sf.source.id);
    return entry!;
  }

  private async ocr(sourceId: string): Promise<void> {
    if (!this.deps.queueOcr) {
      this.note("Some PDFs have no text layer; OCR was requested but no OCR worker is available, so they were not queued.");
      return;
    }
    try {
      await this.deps.queueOcr(this.projectId, sourceId);
      this.rec.ocrQueued = (this.rec.ocrQueued ?? 0) + 1;
    } catch {
      this.note("Some PDFs could not be queued for OCR.");
    }
  }

  /** Adds the item's files and the fields the existing source lacks (snapshot kept as a record; the journal records what was added, for undo). */
  private async merge(
    item: ScanItem,
    targetId: string,
    r: Resolution,
    inputs: SourceInputFile[],
    method: Provenance["captureMethod"],
    dedupe: BatchDedupe,
  ): Promise<JournalEntry> {
    const target = await this.repo.getSource(this.projectId, targetId);
    const flush = this.pending.length;
    const n = ++this.snapshots;
    const snapshotRel = `${this.rec.dir}/snapshots/${targetId}-${Date.now()}-${n}.json`;
    const projectRel = this.projectRel;
    let record: MergeRecord | undefined;
    const sf = await importChange(
      this.repo,
      this.projectId,
      [{ action: "capture", capture: { method } }, storeRequest(target.source.provenance, r.hasLocation)],
      async (ops) => {
        const { tx } = ops;
        const cur = await ops.readSource(targetId);
        await tx.mkdir(`${projectRel}/${this.rec.dir}/snapshots`);
        const snapName = `${projectRel}/${snapshotRel.slice(0, snapshotRel.lastIndexOf("/"))}/${fileName(basename(snapshotRel), tx.encrypted)}`;
        await tx.writeFile(snapName, JSON.stringify(cur), { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }) });
        const have = new Set(cur.assets.map((a) => a.sha256));
        const added = [];
        const label = `${tx.at.slice(0, 16).replace("T", " ").replace(":", "")}`;
        for (const f of inputs) {
          const sha = await sha256File(f.path);
          if (have.has(sha)) continue;
          have.add(sha);
          if (f.handling === "link") added.push(await linkedAsset(repoLibrary(this.repo).root, f, targetId, sha));
          else added.push(await ops.copyOriginal(cur, { fromPath: f.path, kind: f.kind!, ext: f.ext!, ...(f.mime ? { mime: f.mime } : {}), label: `${f.kind} added ${label}` }));
        }
        const merged = applyMerge(cur, added, missingFields(cur, r.draft), r.fieldEvidence, tx.at, tx.actor);
        record = merged.record;
        const next = merged.next;
        await ops.writeSource(cur, next);
        await appendJournal(tx, projectRel, this.rec.dir, [
          ...this.pending.slice(0, flush),
          { key: item.key, outcome: "merged", sourceId: targetId, mergedInto: targetId, snapshot: snapshotRel, merge: record },
        ]);
        return next;
      },
      { op: "import.merge", entity: { type: "source", id: targetId }, refuse: refuseLocation },
    );
    this.pending = this.pending.slice(flush);
    dedupe.add(sf);
    return { key: item.key, outcome: "merged", sourceId: targetId, mergedInto: targetId, snapshot: snapshotRel, ...(record ? { merge: record } : {}) };
  }
}

/** A linked original (merge with `fileHandling: 'link'`): nothing is copied (R24). */
async function linkedAsset(root: string, f: SourceInputFile, sourceId: string, sha256: string): Promise<Asset> {
  const abs = resolve(f.path);
  const r = relative(resolve(root), abs);
  const rel = r.split(sep).join("/");
  if (isAbsolute(r) || !LinkedRelativePath.safeParse(rel).success) throw new Error("cannot link");
  const st = await fsp.stat(abs);
  return Asset.parse({
    id: newId(),
    sourceId,
    role: "original",
    kind: f.kind ?? "file",
    path: rel,
    encrypted: false,
    sha256,
    bytes: st.size,
    mime: f.mime ?? "application/octet-stream",
    linked: { absolutePath: abs, libraryRelativePath: rel },
  });
}


/** Starts a batch: options vetted and the project's rules checked first (BatchRefusedError), then batch.json, then the run. */
/** In-process lock for batch numbers (with an exclusive mkdir of the folder for other writers). */
let numbering: Promise<unknown> = Promise.resolve();

/** Allocates the next `imports/batch-NNNN` folder: serialised in process, exclusive on disk (EEXIST → next number). */
function allocateBatchNumber(repo: Repo, projectId: string): Promise<number> {
  const next = numbering.then(async () => {
    const imports = join(repoLibrary(repo).root, ...repo.getProject(projectId).folder.split("/"), "imports");
    await fsp.mkdir(imports, { recursive: true });
    let n = Math.max(0, ...(await batchDirs(repo, projectId)).map((d) => d.number)) + 1;
    for (;;) {
      try {
        await fsp.mkdir(join(imports, `batch-${String(n).padStart(4, "0")}`));
        return n;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        n++;
      }
    }
  });
  numbering = next.catch(() => {});
  return next;
}

/** Item key recorded in each new source's provenance (resume guard, R61). */
export const ITEM_KEY = "import-item";

/** Starts a batch: options vetted and the project's rules checked first (BatchRefusedError), then batch.json, then the run. */
export async function startBatch(deps: BulkImportDeps, projectId: string, adapter: ImportSourceAdapter, input: ImportOptionsInput = {}): Promise<BatchHandle> {
  // The id is in the running set before anything is awaited (R61).
  const id = newId();
  active.add(id);
  try {
    const options = acceptOptions(input);
    const governance = await preflight(deps.repo, projectId, adapter.kind, options);
    const number = await allocateBatchNumber(deps.repo, projectId);
    const rec: BatchRecord = {
      id,
      projectId,
      number,
      source: { kind: adapter.kind, location: adapter.location },
      options,
      startedAt: new Date().toISOString(),
      counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 },
      state: "running",
      dir: `imports/batch-${String(number).padStart(4, "0")}`,
      createdSourceIds: [],
      createdCollectionIds: [],
      createdTagIds: [],
      governance,
      notes: [],
      secret: randomBytes(32).toString("hex"),
    };
    // Written before anything is created, so an interrupted batch still has its record.
    await saveRecord(deps.repo, projectId, rec);
    const run = new Run(deps, projectId, rec, adapter, []);
    run.start();
    return run.handle();
  } catch (err) {
    active.delete(id);
    throw err;
  }
}

/**
 * Resumes a batch that was paused, cancelled or interrupted: items already in its journal are
 * skipped, and so are items whose source (same batch id and item key) exists although its journal
 * line was lost. Folder and ZIP batches find their source again from the record; others need `adapter`.
 */
export async function resumeBatch(deps: BulkImportDeps, projectId: string, batchId: string, adapter?: ImportSourceAdapter): Promise<BatchHandle> {
  // Checked and taken before anything is awaited: a second resume at the same time is refused (R61).
  if (active.has(batchId)) throw new BatchRefusedError("This import is already running.");
  active.add(batchId);
  try {
    const rec = await findBatch(deps.repo, projectId, batchId);
    if (!rec) throw new NotFoundError("Import batch", batchId);
    if (rec.state === "finished" || rec.state === "undone") throw new BatchRefusedError("This import has already finished.");
    if (rec.source.kind === "profile-capture") throw new BatchRefusedError("Profile captures are resumed by capturing the profile again.");
    const source = adapter ?? adapterFor(rec.source.kind, rec.source.location);
    if (!source) throw new BatchRefusedError("The source of this import is needed to resume it.");
    const governance = await preflight(deps.repo, projectId, rec.source.kind, rec.options);
    rec.governance = [...rec.governance.filter((g) => g.items !== undefined), ...governance];
    rec.state = "running";
    delete rec.finishedAt;
    rec.secret ??= randomBytes(32).toString("hex");
    const journal = await readJournal(deps.repo, projectId, rec.dir);
    // Resume guard: sources of this batch (found by its id and their item-key hash) count as done
    // even if their journal line was lost.
    const journaledSources = new Set(journal.map((e) => e.sourceId).filter(Boolean));
    const recovered = new Map<string, string>();
    for (const sid of deps.repo.listSourceIds(projectId)) {
      if (journaledSources.has(sid)) continue;
      try {
        const prov = (await deps.repo.getSource(projectId, sid)).source.provenance;
        const h = prov.externalKeys?.[ITEM_KEY];
        if (prov.importBatchId === batchId && h) recovered.set(h, sid);
      } catch {
        // unreadable source: not provably this batch's
      }
    }
    await saveRecord(deps.repo, projectId, rec);
    const run = new Run(deps, projectId, rec, source, journal, recovered);
    run.start();
    return run.handle();
  } catch (err) {
    active.delete(batchId);
    throw err;
  }
}

/** The project's batches, newest first; a `running` batch not running in this process is shown as `interrupted` (R45). */
export async function listBatches(repo: Repo, projectId: string): Promise<BatchSummary[]> {
  const out: BatchSummary[] = [];
  for (const d of (await batchDirs(repo, projectId)).reverse()) {
    try {
      const r = await readBatchAt(repo, projectId, d.name);
      if (!r) continue;
      out.push({
        batchId: r.id,
        number: r.number,
        kind: r.source.kind,
        state: r.state === "running" && !active.has(r.id) ? "interrupted" : r.state,
        startedAt: r.startedAt,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        counts: r.counts,
      });
    } catch {
      // unreadable record: not listed
    }
  }
  return out;
}

/**
 * Dry run (wizard step 2): what a batch from `adapter` would find. Nothing is written to the
 * library: archives are unpacked into a private work folder that is removed before this returns;
 * nothing is looked up online and no audit event is written.
 */
export async function dryRun(deps: BulkImportDeps, projectId: string, adapter: ImportSourceAdapter): Promise<ScanSummary> {
  const repo = deps.repo;
  repo.getProject(projectId);
  const dedupe = new BatchDedupe(deps.index.db, projectId, (id) => hasSource(repo, projectId, id));
  const summary: ScanSummary = { items: 0, byType: {}, totalBytes: 0, likelyDuplicates: 0, alreadyImported: 0, unreadable: [] };
  const name = `batch-dry-${newId()}`;
  const dir = join(repoLibrary(repo).root, ".tmp", name);
  let made = false;
  const seenSha = new Set<string>();
  const seenIds = new Set<string>();
  const ac = new AbortController();
  try {
    const scan = adapter.scan(ac.signal, {
      workDir: async () => {
        if (!made) {
          activeTemp.add(name);
          await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
          made = true;
        }
        return dir;
      },
    });
    for await (const item of scan) {
      summary.items++;
      if (item.unreadable) {
        summary.unreadable.push({ path: item.key, reason: item.unreadable });
        continue;
      }
      const f = item.files[0];
      if (!f) {
        const t = item.referenceMetadata?.type ?? "metadata";
        summary.byType[t] = (summary.byType[t] ?? 0) + 1;
        const doi = item.referenceMetadata?.identifiers?.doi?.toLowerCase();
        const isbns = item.referenceMetadata?.identifiers?.isbn ?? [];
        const ids = [...(doi ? [`doi:${doi}`] : []), ...isbns.map((i) => `isbn:${i}`)];
        const inScan = ids.some((i) => seenIds.has(i));
        ids.forEach((i) => seenIds.add(i));
        const inProject = dedupe.candidates({ sha256s: [], ...(doi ? { doi } : {}), ...(isbns.length ? { isbns } : {}) }).length > 0;
        if (inScan || inProject) summary.likelyDuplicates++;
        continue;
      }
      let bytes = 0;
      for (const x of item.files) bytes += (await fsp.stat(x.path).catch(() => null))?.size ?? x.bytes;
      summary.totalBytes += bytes;
      const type = await fileTypeFromFile(f.path).catch(() => undefined);
      const stored = type ? acceptedType(type) : undefined;
      if (!type || !stored) {
        summary.unreadable.push({ path: item.key, reason: REASONS.unsupported });
        continue;
      }
      summary.byType[stored.kind] = (summary.byType[stored.kind] ?? 0) + 1;
      if (stored.mime === "application/pdf") {
        if ((await extractMetadata(f.path, stored.mime)).readFailed) summary.unreadable.push({ path: item.key, reason: REASONS.unreadable });
      }
      const sha = await sha256File(f.path);
      if (dedupe.bySha(sha)) summary.alreadyImported++;
      else if (seenSha.has(sha)) summary.likelyDuplicates++;
      seenSha.add(sha);
    }
  } finally {
    if (made) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
  return summary;
}
