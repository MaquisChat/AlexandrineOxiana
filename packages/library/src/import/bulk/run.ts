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
 * only the items concerned, with the policy's reason, and the batch goes on. Media whose store
 * carries a location condition are stored as the decision allows and get viewing proxies with the
 * location coarsened or removed (R83, ../proxies.ts); without a media worker those stay pending
 * (LOCATION_REASON in the item's notes and the report). Journal lines of items that stored nothing
 * (duplicates, failures) are written with the next store or at the next checkpoint; after a crash
 * such an item is simply processed again, with the same result.
 *
 * Linking (`fileHandling: 'link'`) stores the file's absolute path and its path relative to the
 * library (LinkedRelativePath, R24) and copies nothing; it is refused in projects whose governance
 * requires encryption at rest or that are encrypted. Files unpacked from archives are always copied.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { libraryVersion } from "../../resources.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileTypeFromFile } from "file-type";
import {
  Asset,
  ImportOptions,
  LinkedRelativePath,
  evaluate,
  findDuplicate,
  newId,
  vetFileNamePattern,
  type DupMatch,
  type ImportBatch,
  type ImportOptionsInput,
  type PolicyDecision,
  type Provenance,
  type Annotation,
  type PendingProxy,
  type SourceDraft,
  type SourceFile,
} from "@ao/core";
import { UnsafeFileError } from "../../extract/errors.js";
import { extractMetadata } from "../../extract/index.js";
import type { IndexDb } from "../../index/db.js";
import { lookupContextFor, type HttpClient, type LookupContext } from "../../lookup/index.js";
import { NotFoundError, PolicyDeniedError, ProjectLockedError } from "../../repo/errors.js";
import type { CreateSourceOptions, SourceInputFile } from "../../repo/sources.js";
import { storeRequest } from "../../repo/sources.js";
import {
  appendLibraryEvent,
  authorizeProcessing,
  createSourceRefusing,
  createSourcesRefusing,
  importChange,
  projectCollectionsAndTags,
  projectEncrypted,
  hasSource,
  deletedHere,
  deletedRecordsTrouble,
  projectPolicyOrDefault,
  repoLibrary,
  type Repo,
  projectDateZone,
  repoClock,
} from "../../repo/repo.js";
import { activeTemp } from "../../tmp-registry.js";
import { acceptedType } from "../attach.js";
import { LOCATION_REASON, MANUAL_UPLOAD_CATEGORY, candidateKey, itemProvenance, locationRule, reviewFor, sha256File, storeInputs, type LocationMode } from "../common.js";
import { pendingFor, planProxies, proxyQueueFor, type ProxyPlan, type ProxyQueue } from "../proxies.js";
import { resolveItem, type Resolution } from "../resolve.js";
import { approvedFolders, rememberApprovedFolders } from "../approved-folders.js";
import { serialStore, storeTurn } from "../project-queue.js";
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
  fileCounts,
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
import { OUTSIDE_NOTE, OUTSIDE_REASON, OutsidePolicy, approvalHashes } from "./outside.js";
import { reportLabel, writeBatchReport } from "./report.js";
import { PATTERN_BUDGET_MS, PatternWatchdog } from "./patterns.js";
import { adapterFor, type ImportSourceAdapter, type ScanItem } from "./scan.js";
import { capAnnotations, planAnnotations, planUpdate, toAnnotation, uniqueKey, type AnnotationPlan } from "./update.js";

const VERSION: string = libraryVersion();
const TOOL = { name: "bulk-import", version: VERSION };

/** File notes the engine adds when it leaves out one of an item's files (R68 I2; never a path). */
export const ENGINE_FILE_NOTES = {
  unsupported: "attached file type not supported",
  vanished: "attached file no longer present",
  sameFile: "same file as another item in this batch",
  changed: "attached file changed during import",
  /** A file the source links in place (a Zotero linked attachment) was copied: the project keeps files encrypted (R24, R72). */
  linkedCopied: "linked file copied into the library, because this project keeps its files encrypted",
} as const;

export const REASONS = {
  missing: "The file could not be found or read.",
  unsupported: "This kind of file cannot be imported. Import PDFs, EPUB or Kindle books, Word documents, images, audio or video.",
  unreadable: "The file could not be read; it may be damaged or protected with a password.",
  unsafe: "This file could not be opened safely, so it was not imported.",
  changed: "The file changed during the import, so it was not imported.",
  failed: "The item could not be imported.",
  duplicateFile: "The same file is already in the project.",
  duplicateId: "A source with the same DOI or ISBN is already in the project.",
  deletedHere: "You deleted this item's source here after an earlier import, so it was not imported again.",
  deletedRecordsUnreadable:
    "This project's record of sources deleted here could not be read, so a Zotero import could bring back sources you deleted. Import again with \u201creset deleted records\u201d to start a new record (sources deleted before then may come back).",
  linkEncrypted:
    "Files cannot be linked in place in this project: its files must be encrypted at rest, and a linked file stays outside the library. Choose to copy the files instead.",
} as const;

/**
 * Why a batch was refused, for callers that map it (R106): `denied` the project's rules; `running`
 * the batch is running (or being paused or undone) now; `finished` it has already finished or been
 * undone; `locked` the project is locked (R108); `invalid` the options, the source or the record.
 */
export type BatchRefusalKind = "denied" | "running" | "finished" | "locked" | "invalid";

/** A batch could not start (or resume): the options or the project's rules do not allow it. */
export class BatchRefusedError extends Error {
  override name = "BatchRefusedError";
  readonly kind: BatchRefusalKind;
  constructor(
    readonly reason: string,
    /** The project's rules (governance) refused it, as opposed to options, the source or the record. */
    readonly denied: boolean = false,
    kind?: BatchRefusalKind,
  ) {
    super(reason);
    this.kind = kind ?? (denied ? "denied" : "invalid");
  }
}

export interface BulkImportDeps {
  repo: Repo;
  /** The lookup client (one per library). */
  http: HttpClient;
  /** The library index (dedupe keys; TEMP schema for unlocked encrypted projects). */
  index: { db: IndexDb };
  /**
   * Queues OCR for sources whose PDFs have no text layer (Task 15's worker), when `options.ocr`:
   * called once per stored group with all of its sources (one governed change, R106).
   */
  queueOcr?: (projectId: string, sourceIds: string[]) => void | Promise<void>;
  /** Viewing proxies of photos and videos (R83); default: the library's queue (proxyQueueFor, R85). */
  proxies?: ProxyQueue;
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
  /** Incremental re-import (R72): items imported before that changed, and those that did not. */
  updated: number;
  unchanged: number;
  /** Items whose source was deleted here after an earlier import, not re-imported (R73, R74 M7). */
  deletedHere: number;
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
  /**
   * Stops the run at the next safe point (between items, everything so far stored and journaled)
   * and leaves it `paused` on disk, resumable later with resumeBatch; nothing more is written by
   * this run. Used when the app closes or the library moves (R99 I4/I5). Settles like `done`
   * (state `paused`, or the state it ended in if it finished first).
   */
  suspend(): Promise<BatchResult>;
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
  /** Scan notes (e.g. how many empty records an export had). */
  notes: string[];
  /**
   * Files outside the source's folders and the library's approved folders (R67), for the wizard to
   * ask about: the item's label, the folder the file is in and the file's own real path (symbolic
   * links followed: what an approval of that one file must name, R118). Never written anywhere.
   */
  outsideFiles: Array<{ item: string; folder: string; file: string }>;
  /**
   * Files the source itself links in place (Zotero linked attachments), approved or not: the wizard
   * offers to keep them as links only when there are some (R136).
   */
  linkedFiles: number;
}

export interface BatchSummary {
  batchId: string;
  number: number;
  kind: ImportBatch["source"]["kind"];
  state: ShownState;
  startedAt: string;
  finishedAt?: string;
  counts: ImportBatch["counts"];
  /** The collections and tags this batch created, by id (R118; see ImportReport.created). */
  created: { collectionIds: string[]; tagIds: string[] };
}

const CAPTURE_METHOD: Record<ImportBatch["source"]["kind"], Provenance["captureMethod"]> = {
  folder: "manual_upload",
  zip: "manual_upload",
  attach: "manual_upload",
  "zotero-local": "zotero_import",
  "zotero-web": "zotero_import",
  "zotero-rdf": "zotero_import", // the provenance says the data came from Zotero (R66)
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

/**
 * Incremental imports (R74 I2): the record of sources deleted here must be readable and its warning
 * clear, or the batch refuses — unless it runs with resetDeletedRecords, which sets the record
 * aside, starts a new one and clears the warning (one governed, audited change).
 */
async function preflightDeleted(repo: Repo, projectId: string, adapter: { incremental?: boolean }, options: ImportOptions): Promise<void> {
  if (!adapter.incremental || !(await deletedRecordsTrouble(repo, projectId))) return;
  if (!options.resetDeletedRecords) throw new BatchRefusedError(REASONS.deletedRecordsUnreadable);
  await importChange(repo, projectId, BOOKKEEPING, (ops) => ops.resetDeletions(), { op: "import.reset-deleted-records" });
  await appendLibraryEvent(repo, projectId, "import.reset-deleted-records", {});
}

/** Policy and option checks a batch must pass before it starts (or resumes). */
async function preflight(repo: Repo, projectId: string, kind: ImportBatch["source"]["kind"], options: ImportOptions): Promise<GovernanceNote[]> {
  repo.getProject(projectId); // NotFoundError for an unknown project
  if (options.fileHandling === "link" && (await preflightLink(repo, projectId))) throw new BatchRefusedError(REASONS.linkEncrypted, true);
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
    if (err instanceof PolicyDeniedError) throw new BatchRefusedError(err.reason, true);
    if (err instanceof ProjectLockedError) throw new BatchRefusedError("The project is locked. Unlock it, then try again.", false, "locked");
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

/** An item's checked files (prepareFiles). */
interface Prepared {
  inputs: SourceInputFile[];
  shas: string[];
  kept: ScanItem["files"];
  /** The primary file's path as found (its name, and its sidecars, are where the item was found). */
  names: string[];
  mime: string;
  dropped: Array<{ note: string; reason: string }>;
  /** Linked files copied because the project refuses links (R24). */
  copiedLinks: number;
  /** Adapter path → checked real path, and real path → sha256 (for anchoring annotations). */
  realOf: Map<string, string>;
  shaOf: Map<string, string>;
  /** Which files may carry a location and which get viewing proxies (R83); set by importItem. */
  plan: ProxyPlan;
}

interface Queued {
  item: ScanItem;
  r: Resolution;
  prep: Prepared;
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
  private suspending = false;
  private gate: (() => void) | null = null;
  private readonly abort = new AbortController();
  /** Journal lines of items that stored nothing, written with the next change. */
  private pending: JournalEntry[] = [];
  private readonly latest: Map<string, JournalEntry>;
  private readonly createdIds: Set<string>;
  private readonly denies = new Map<string, number>();
  private workDir: string | null = null;
  /** File notes per item key (ScanItem.fileNotes), added to the item's journal line. */
  private fileNotes = new Map<string, string[]>();
  /** Files outside the adapter's roots need approval (R67); undefined when the adapter declares no roots. */
  private outside: OutsidePolicy | undefined;
  /** Real path of each file attached in this run → the item it went to (a second item gets a note). */
  private fileOwners = new Map<string, string>();
  private readonly workName: string;
  /** Incremental import (R72): identity → the source and version token the newest journal line recorded. */
  private known = new Map<string, { sourceId: string; version: string }>();
  /** Whether a Zotero item's source was deleted here (R73); re-read for each group and whenever a known source is gone (R74 M4). */
  private deletedHere: (zoteroKey: string) => boolean = () => false;
  private async refreshDeleted(): Promise<void> {
    const f = await deletedHere(this.repo, this.projectId);
    // Unreadable (R74 I2): the batch stops rather than bring back sources deleted here.
    if (!f) throw new BatchRefusedError(REASONS.deletedRecordsUnreadable);
    this.deletedHere = f;
  }
  /** Item key → Zotero item key of items imported again although deleted here (includeDeleted): their records are cleared. */
  private restored = new Map<string, string>();
  /** Item key → annotations left out over the per-source caps (journaled with its outcome). */
  private annotationsDropped = new Map<string, number>();
  /** Item key → its identity and version token (journaled with its outcome). */
  private versions = new Map<string, { id: string; version: string }>();
  private structureCache = new Map<string, { collectionIds: string[]; tagIds: string[] }>();
  private projectTags: { collections: Array<{ id: string; name: string; parentId?: string }>; tags: Array<{ id: string; name: string }> } | null = null;
  private snapshots = 0;
  private group: Queued[] = [];
  private placeholders = 0;
  private inputsCache: { at: number; method: string; value: { identifiable: boolean; legalBasis?: string } } | null = null;
  private dedupe: BatchDedupe | null = null;
  private lookup: LookupContext | null = null;
  /**
   * The project's location rule, for viewing proxies of files whose store carried no location
   * condition (adapters with `viewingProxies`): read at the start of the run; unreadable → strip.
   */
  private policyMode: LocationMode = "strip";
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
        // Also withdraws a suspend that has not taken effect yet (the run carries on).
        this.suspending = false;
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
      suspend: () => {
        this.suspending = true;
        this.paused = true;
        this.gate?.();
        this.gate = null;
        return this.done;
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
    this.rec.counts = { created: c.created, merged: c.merged + c.updated, skipped: c.duplicates + c.unchanged + c.deletedHere, failed: c.failed, needsReview: c.needsReview };
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
      if (this.adapter.viewingProxies) this.policyMode = (await projectPolicyOrDefault(this.repo, this.projectId))?.sharing.locationMetadata ?? "strip";
      this.outside = await OutsidePolicy.create(
        this.adapter.roots,
        [join(repoLibrary(this.repo).root, ".tmp", this.workName), ...(await approvedFolders(repoLibrary(this.repo)))],
        this.rec.secret,
        this.rec.outsideApprovals ?? [],
      );
      if (this.adapter.incremental) {
        this.known = await knownVersions(this.repo, this.projectId, this.rec.source.kind);
        await this.refreshDeleted();
      }
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
      const scan = this.adapter.scan(this.abort.signal, { workDir: () => this.ensureWorkDir(), note: (t) => this.note(t) });
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
          if (!this.suspending) {
            await new Promise<void>((r) => {
              this.gate = r;
              if (!this.paused || this.cancelled || this.suspending) r();
            });
          }
          if (this.suspending) {
            // Left paused on disk (just checkpointed); this run writes nothing more.
            state = "paused";
            break;
          }
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
      if (state !== "paused") {
        await this.flush();
        await this.clearRestored();
        if (this.cancelled) state = "cancelled";
      }
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
    if (state === "paused" && this.suspending) {
      runListeners.delete(this.rec.id);
      active.delete(this.rec.id);
      this.feed.end();
      this.settle({ batchId: this.rec.id, state, counts: this.counts() });
      return;
    }
    const deleted = [...this.latest.values()].filter((e) => e.outcome === "deleted-here").length;
    this.rec.notes = this.rec.notes.filter((n) => !DELETED_NOTE.test(n));
    if (deleted) this.note(deletedNote(deleted));
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
      if (item.fileNotes?.length) this.fileNotes.set(item.key, item.fileNotes.slice(0, 50).map((n) => n.slice(0, 200)));
      if (item.unreadable) return this.queue({ key: item.key, outcome: "failed", reason: item.unreadable });
      if (this.adapter.incremental && item.version) {
        this.versions.set(item.key, item.version);
        const k = this.known.get(item.version.id);
        if (k && !hasSource(this.repo, this.projectId, k.sourceId)) await this.refreshDeleted(); // deleted meanwhile?
        if (k && hasSource(this.repo, this.projectId, k.sourceId)) {
          if (k.version === item.version.version) return this.queue({ key: item.key, outcome: "unchanged", sourceId: k.sourceId });
          await this.flush(); // the source may be in the current group
          return await this.update(item, k.sourceId);
        }
        // Deleted here after an earlier import: stays deleted unless the options say otherwise (R73).
        const zk = item.externalKeys?.zoteroKey;
        if (zk && this.deletedHere(zk)) {
          if (!this.rec.options.includeDeleted) return this.queue({ key: item.key, outcome: "deleted-here", reason: REASONS.deletedHere });
          this.restored.set(item.key, zk);
        }
      }
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
    const line = this.withNotes(e);
    this.pending.push(line);
    return line;
  }

  /** The journal line with the item's file notes, if it has any (R66). */
  private withNotes(e: JournalEntry): JournalEntry {
    const notes = this.fileNotes.get(e.key);
    const v = WITH_VERSION.has(e.outcome) && e.sourceId ? this.versions.get(e.key) : undefined;
    if (v) this.known.set(v.id, { sourceId: e.sourceId!, version: v.version });
    const dropped = e.outcome === "created" || e.outcome === "needs-review" ? this.annotationsDropped.get(e.key) : undefined;
    return { ...e, ...(notes?.length ? { notes } : {}), ...(v ? { ext: { id: v.id, version: v.version } } : {}), ...(dropped ? { annotationsDropped: dropped } : {}) };
  }

  /** Clears the deletion records of items imported again with includeDeleted (one bookkeeping change). */
  private async clearRestored(): Promise<void> {
    const keys = [...this.restored].filter(([k]) => WITH_VERSION.has(String(this.latest.get(k)?.outcome))).map(([, zk]) => zk);
    if (!keys.length) return;
    await importChange(
      this.repo,
      this.projectId,
      BOOKKEEPING,
      async (ops) => {
        const cleared = await ops.clearDeletions(keys);
        // Recorded with the batch, so undo puts them back (R74 I3).
        this.rec.clearedDeletions = [...new Set([...(this.rec.clearedDeletions ?? []), ...cleared])];
        await writeBatchRecord(ops.tx, this.projectRel, this.rec);
      },
      { op: "import.clear-deleted" },
    );
    this.restored.clear();
  }

  /**
   * Checks an item's files (R66, R67, R68 I2, R70 I-2): each that vanished, is not supported, is
   * outside the expected folders without approval, or went to another item of this run is left out
   * with a note; the rest become store inputs at their checked real paths. A file the source links
   * in place (ScanFile.link) is linked too, unless the options say copy or the project keeps files
   * encrypted (R24: then it is copied, with the note linkedCopied).
   */
  private async prepareFiles(item: ScanItem): Promise<Prepared> {
    const opts = this.rec.options;
    const fromArchive = item.key.includes("!/");
    const out: Prepared = { inputs: [], shas: [], kept: [], names: [], mime: "", dropped: [], copiedLinks: 0, realOf: new Map(), shaOf: new Map(), plan: { located: false, proxies: [] } };
    for (const f of item.files) {
      const st = await fsp.stat(f.path).catch(() => null);
      if (!st?.isFile()) {
        out.dropped.push({ note: ENGINE_FILE_NOTES.vanished, reason: REASONS.missing });
        continue;
      }
      // From here on the file is read through its checked real path (R70 I-2).
      const checked = this.outside ? await this.outside.check(f.path) : { real: await fsp.realpath(f.path).catch(() => resolve(f.path)), ok: true };
      const real = checked.real;
      if (!checked.ok) {
        out.dropped.push({ note: OUTSIDE_NOTE, reason: OUTSIDE_REASON });
        continue;
      }
      const owner = this.fileOwners.get(real);
      if (owner !== undefined && owner !== item.key) {
        out.dropped.push({ note: ENGINE_FILE_NOTES.sameFile, reason: REASONS.duplicateFile });
        continue;
      }
      const type = await fileTypeFromFile(real).catch(() => undefined);
      const stored = type ? acceptedType(type) : undefined;
      if (!type || !stored) {
        out.dropped.push({ note: ENGINE_FILE_NOTES.unsupported, reason: REASONS.unsupported });
        continue;
      }
      this.fileOwners.set(real, item.key);
      out.kept.push({ ...f, path: real });
      out.realOf.set(f.path, real);
      if (!out.names.length) out.names.push(f.path);
      if (!out.mime) out.mime = type.mime;
      const sha = await sha256File(real);
      out.shas.push(sha);
      out.shaOf.set(real, sha);
      const sourceLinks = f.link === true && opts.linkedFiles === "link";
      const wantsLink = !fromArchive && (opts.fileHandling === "link" || sourceLinks);
      if (wantsLink && sourceLinks && opts.fileHandling !== "link" && (await this.linkRefused())) out.copiedLinks++;
      const handling = wantsLink && !(await this.linkRefused()) ? "link" : "copy";
      out.inputs.push({ path: real, noFollow: true, role: "original", handling, ext: stored.ext, mime: stored.mime, kind: stored.kind, ...(f.metadata ? { metadata: f.metadata } : {}) });
    }
    return out;
  }

  /** Whether this project refuses linking in place (R24), asked once per run. */
  private linkRefusedCache: Promise<boolean> | null = null;
  private linkRefused(): Promise<boolean> {
    this.linkRefusedCache ??= preflightLink(this.repo, this.projectId);
    return this.linkRefusedCache;
  }

  private async importItem(item: ScanItem, dedupe: BatchDedupe, watchdog: PatternWatchdog): Promise<JournalEntry | null> {
    const opts = this.rec.options;
    const method = CAPTURE_METHOD[this.rec.source.kind];
    const prep = await this.prepareFiles(item);
    const { inputs, shas, kept, names, mime, dropped } = prep;
    // Every file is checked for a location, not only the one resolution reads (R74 I1, R83).
    prep.plan = await planProxies(inputs, { all: this.adapter.viewingProxies === true });
    // Same file → duplicate (whatever the duplicate policy).
    if (shas[0]) {
      let same = dedupe.bySha(shas[0]);
      if (isPlaceholder(same)) {
        await this.flush();
        same = dedupe.bySha(shas[0]);
      }
      if (same) return this.queue({ key: item.key, outcome: "duplicate", sourceId: same, reason: REASONS.duplicateFile });
    }
    if (dropped.length) {
      if (!item.referenceMetadata && !kept.length) return this.queue({ key: item.key, outcome: "failed", reason: dropped[0]!.reason });
    }
    this.addFileNotes(item, prep);
    const primaryFile = kept[0];
    const name = names[0] ? basename(names[0]) : undefined;
    let userParsedName;
    if (name && watchdog.active) userParsedName = (await watchdog.match(name)).parsed;
    const r = await resolveItem(
      {
        ...(primaryFile ? { path: primaryFile.path, mime, sidecarPaths: await findSidecars(names[0]!), fileName: name } : {}),
        ...(item.referenceMetadata ? { referenceMetadata: item.referenceMetadata } : {}),
        ...(item.referenceSource ? { referenceSource: item.referenceSource } : {}),
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
        return this.merge(item, dup.sourceId, r, prep, method, dedupe);
      }
    }
    const reviewItem = reviewFor(r, dup?.certainty === "likely" ? dup : null, opts.autoAcceptThreshold);
    return this.create(item, r, prep, method, reviewItem, dedupe);
  }

  /** The item's dropped files and copied links as file notes (journaled with its outcome, R66). */
  private addFileNotes(item: ScanItem, prep: Prepared): void {
    const notes = [...prep.dropped.map((d) => d.note), ...Array<string>(prep.copiedLinks).fill(ENGINE_FILE_NOTES.linkedCopied)];
    if (notes.length) this.fileNotes.set(item.key, [...(this.fileNotes.get(item.key) ?? []), ...notes]);
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
      out = { collectionIds: [], tagIds: await this.namedTags(folderPath) };
    }
    this.structureCache.set(k, out);
    return out;
  }

  /** Ids of the project's tags with these names (case-insensitive), creating the missing ones as the batch's. */
  private async namedTags(names: string[] | undefined, colors?: Record<string, string>): Promise<string[]> {
    if (!names?.length) return [];
    this.projectTags ??= await projectCollectionsAndTags(this.repo, this.projectId);
    const known = this.projectTags;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      let t = known.tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t) {
        const color = colors && Object.hasOwn(colors, name) ? colors[name] : undefined;
        t = await this.repo.createTag(this.projectId, name, color);
        known.tags.push(t);
        this.rec.createdTagIds.push(t.id);
        await this.checkpoint("running"); // recorded at once, so undo finds it after a crash
      }
      ids.push(t.id);
    }
    return ids;
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
      tool: this.adapter.tool ?? TOOL,
      identifiable,
      importBatchId: this.rec.id,
      ...(legalBasis ? { legalBasis } : {}),
      externalKeys: { ...(item.externalKeys ?? {}), [ITEM_KEY]: itemKeyHash(this.rec.secret!, item.key) },
    });
  }

  private async create(
    item: ScanItem,
    r: Resolution,
    prep: Prepared,
    method: Provenance["captureMethod"],
    reviewItem: ReturnType<typeof reviewFor>,
    dedupe: BatchDedupe,
  ): Promise<JournalEntry | null> {
    const { inputs, shas } = prep;
    const collectionIds: string[] = [];
    const structTags: string[] = [];
    for (const fp of [item.folderPath ?? [], ...(item.moreFolderPaths ?? [])]) {
      const struct = await this.structure(fp);
      collectionIds.push(...struct.collectionIds);
      structTags.push(...struct.tagIds);
    }
    const own = await this.namedTags(item.tags, item.tagColors);
    const link = this.rec.fieldwork;
    const draft: SourceDraft = {
      ...r.draft,
      collectionIds: [...new Set([...r.draft.collectionIds, ...collectionIds])],
      tagIds: [...new Set([...r.draft.tagIds, ...structTags, ...own])],
      // Device import (R83): every new source is linked to the session and participants, in its own governed change.
      ...(link?.participantIds?.length ? { participantIds: [...new Set([...r.draft.participantIds, ...link.participantIds])] } : {}),
      ...(link?.sessionId ? { sessionId: link.sessionId } : {}),
    };
    if (this.adapter.uniqueCitationKeys) {
      const keys = await this.citationKeys();
      if (draft.citationKey) {
        // An explicit key (Better BibTeX, Extra) is never changed; one already in use is reported.
        if (keys.has(draft.citationKey)) this.note(`The citation key "${draft.citationKey}" from Zotero is also used by another source in this project.`);
        keys.add(draft.citationKey);
      }
    }
    if (item.annotations?.length) {
      // At most MAX_SOURCE_ANNOTATIONS per source, and so much text (R74 I4); the rest is counted.
      const capped = capAnnotations([], item.annotations);
      if (capped.dropped) {
        this.annotationsDropped.set(item.key, capped.dropped);
        item = { ...item, annotations: capped.kept };
      }
    }
    const provenance = await this.provenanceFor(r, method, item);
    // Unpacked files are removed once the scan moves past their archive, and located media are
    // decided on their own (their store may carry a location condition): those are stored at once, one by one.
    if (!r.hasLocation && !prep.plan.located && !item.key.includes("!/")) {
      const placeholder = `${PLACEHOLDER}${++this.placeholders}`;
      dedupe.addPending(placeholder, candidateKey(r, shas));
      this.group.push({ item, r, prep, inputs, draft, provenance, reviewItem, placeholder });
      if (this.group.length >= GROUP) await this.flush();
      return null;
    }
    await this.flush();
    return this.createOne({ item, r, prep, inputs, draft, provenance, reviewItem, placeholder: "" }, dedupe);
  }

  /** Stores the queued group in one governed change; if that change is refused or fails, each item on its own. */
  /**
   * Re-checks an item's files right before they are stored (R70 I-2): each must still be a regular
   * file at its checked real path (no link anywhere on the way now) and still allowed (R67); others
   * are left out with a note. `fail`: nothing is left of a plain file item (no reference metadata).
   * The copy itself opens the path with O_NOFOLLOW, so a last-moment swap of the file fails it.
   */
  private async revalidate(item: ScanItem, inputs: SourceInputFile[]): Promise<{ inputs: SourceInputFile[]; fail: boolean }> {
    const kept: SourceInputFile[] = [];
    let changed = 0;
    for (const f of inputs) {
      const r = await fsp.realpath(f.path).catch(() => null);
      const st = r === f.path ? await fsp.lstat(f.path).catch(() => null) : null;
      if (st?.isFile() && (!this.outside || (await this.outside.check(f.path)).ok)) kept.push(f);
      else changed++;
    }
    if (!changed) return { inputs, fail: false };
    if (!item.referenceMetadata && !kept.length) return { inputs: kept, fail: true };
    this.fileNotes.set(item.key, [...(this.fileNotes.get(item.key) ?? []), ...Array<string>(changed).fill(ENGINE_FILE_NOTES.changed)]);
    return { inputs: kept, fail: false };
  }

  /** Stores go through the project's queue (R81 I4). */
  private flush(): Promise<void> {
    return serialStore(this.repo, this.projectId, () => this.flushInner());
  }

  /** The project queue turn of this run's last store. */
  private lastOwnTurn = -1;

  /**
   * Inside a store turn: whether anyone else (attach, a watched folder, another batch) stored in
   * this project since this run's previous turn, so items checked before then must be checked again
   * against the live index (R82).
   */
  private othersStored(): boolean {
    const t = storeTurn(this.repo, this.projectId);
    if (t === this.lastOwnTurn) return false; // the same (re-entered) turn
    const other = t !== this.lastOwnTurn + 1;
    this.lastOwnTurn = t;
    return other;
  }

  /**
   * An item checked before another store ran, checked again in this turn against the live index:
   * its file (or a certain DOI/ISBN match) is now in the project → its outcome as in `importItem`,
   * else null (store it as planned).
   */
  private async recheck(q: Queued, dedupe: BatchDedupe): Promise<JournalEntry | null> {
    const sha = q.prep.shas[0];
    const same = sha ? dedupe.storedBySha(sha) : undefined;
    if (same) return this.queue({ key: q.item.key, outcome: "duplicate", sourceId: same, reason: REASONS.duplicateFile });
    const key = candidateKey(q.r, q.prep.shas);
    const dup = findDuplicate(key, dedupe.candidates(key).filter((e) => !isPlaceholder(e.sourceId)));
    if (dup?.certainty !== "certain") return null;
    if (dup.reason === "same-file") return this.queue({ key: q.item.key, outcome: "duplicate", sourceId: dup.sourceId, reason: REASONS.duplicateFile });
    const how = this.rec.options.duplicates;
    if (how === "skip") return this.queue({ key: q.item.key, outcome: "duplicate", sourceId: dup.sourceId, reason: REASONS.duplicateId });
    if (how === "merge") return this.merge(q.item, dup.sourceId, q.r, q.prep, CAPTURE_METHOD[this.rec.source.kind], dedupe);
    return null;
  }

  private async flushInner(): Promise<void> {
    let queued = this.group;
    if (!queued.length) return;
    if (this.adapter.incremental) await this.refreshDeleted();
    this.group = [];
    const dedupe = this.dedupe!;
    if (this.othersStored()) {
      const still: Queued[] = [];
      for (const q of queued) {
        dedupe.dropPending([q.placeholder]); // its own placeholder must not match itself
        const e = await this.recheck(q, dedupe);
        if (e) this.latest.set(q.item.key, e);
        else {
          dedupe.addPending(q.placeholder, candidateKey(q.r, q.prep.shas));
          still.push(q);
        }
      }
      queued = still;
    }
    const group: Queued[] = [];
    for (const q of queued) {
      const v = await this.revalidate(q.item, q.inputs);
      if (v.fail) {
        dedupe.dropPending([q.placeholder]);
        this.latest.set(q.item.key, this.queue({ key: q.item.key, outcome: "failed", reason: REASONS.changed }));
        continue;
      }
      q.inputs = v.inputs;
      group.push(q);
    }
    if (!group.length) return;
    const flushLines = this.pending.length;
    const entries: JournalEntry[] = [];
    const rule = locationRule();
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
            ...this.extraCreateOpts(q.item, q.prep, q.inputs, rule.mode),
          },
          inTx: async (tx, sf) => {
            this.notePending(q.item.key, sf, rule.mode());
            const files = fileCounts(q.inputs.map((f) => f.handling === "link"));
            const entry: JournalEntry = this.withNotes({ key: q.item.key, outcome: q.reviewItem ? "needs-review" : "created", sourceId: sf.source.id, ...(files ? { files } : {}) });
            entries[i] = entry;
            await appendJournal(tx, this.projectRel, this.rec.dir, i === 0 ? [...this.pending.slice(0, flushLines), entry] : [entry]);
          },
        })),
        rule.hook,
      );
      this.pending = this.pending.slice(flushLines);
      dedupe.dropPending(group.map((q) => q.placeholder));
      const needOcr: string[] = [];
      for (const [i, sf] of stored.entries()) {
        this.latest.set(entries[i]!.key, entries[i]!);
        this.createdIds.add(sf.source.id);
        dedupe.add(sf);
        this.startProxies(sf);
        const q = group[i]!;
        if (this.rec.options.ocr && q.r.needsOcr && q.inputs.length) needOcr.push(sf.source.id);
      }
      if (needOcr.length) await this.ocr(needOcr);
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
  private createOne(q: Queued, dedupe: BatchDedupe): Promise<JournalEntry> {
    return serialStore(this.repo, this.projectId, () => this.createOneInner(q, dedupe));
  }

  private async createOneInner(q: Queued, dedupe: BatchDedupe): Promise<JournalEntry> {
    if (this.othersStored()) {
      const e = await this.recheck(q, dedupe);
      if (e) return e;
    }
    const v = await this.revalidate(q.item, q.inputs);
    if (v.fail) return this.queue({ key: q.item.key, outcome: "failed", reason: REASONS.changed });
    const { item, r, draft, provenance, reviewItem } = q;
    const inputs = v.inputs;
    const outcome = reviewItem ? "needs-review" : "created";
    const flush = this.pending.length;
    let entry: JournalEntry | undefined;
    const rule = locationRule();
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
        ...(r.hasLocation || q.prep.plan.located ? { hasLocation: true } : {}),
        ...(reviewItem ? { reviewItem: { ...reviewItem, batchId: this.rec.id } } : {}),
        ...this.extraCreateOpts(item, q.prep, inputs, rule.mode),
      },
      rule.hook,
      async (tx, created) => {
        this.notePending(item.key, created, rule.mode());
        const files = fileCounts(inputs.map((f) => f.handling === "link"));
        entry = this.withNotes({ key: item.key, outcome, sourceId: created.source.id, ...(files ? { files } : {}) });
        await appendJournal(tx, this.projectRel, this.rec.dir, [...this.pending.slice(0, flush), entry]);
      },
    );
    this.pending = this.pending.slice(flush);
    this.createdIds.add(sf.source.id);
    dedupe.add(sf);
    this.startProxies(sf);
    if (this.rec.options.ocr && r.needsOcr && inputs.length) await this.ocr([sf.source.id]);
    return entry!;
  }

  /**
   * Inside the change that stores a source (its decision known): a located file's viewing proxy
   * that must wait for a media worker is noted on the item and in the report (R83, LOCATION_REASON).
   */
  private notePending(key: string, sf: SourceFile, mode: LocationMode | undefined): void {
    if (!mode || !sf.pendingProxies?.some((j) => !j.failed) || this.proxies.available) return;
    const notes = this.fileNotes.get(key) ?? [];
    if (!notes.includes(LOCATION_REASON)) this.fileNotes.set(key, [...notes, LOCATION_REASON]);
    this.note(LOCATION_REASON);
  }

  /** Starts the stored source's viewing-proxy jobs (they stay pending in its source.json without a worker). */
  private startProxies(sf: SourceFile): void {
    if (sf.pendingProxies?.length) this.proxies.enqueue(this.projectId, sf.source.id);
  }

  /** The proxy queue: the one given, else the library's (R85 I2). */
  private get proxies(): ProxyQueue {
    return this.deps.proxies ?? proxyQueueFor(this.repo);
  }

  /** The item's proxy plan against the files actually stored (some may have been left out since it was made). */
  private planFor(prep: Prepared, inputs: SourceInputFile[]): ProxyPlan {
    const proxies: ProxyPlan["proxies"] = [];
    for (const p of prep.plan.proxies) {
      const path = prep.inputs[p.index]?.path;
      const i = inputs.findIndex((f) => f.path === path);
      if (i >= 0) proxies.push({ index: i, type: p.type });
    }
    return { located: prep.plan.located, proxies };
  }

  /** Pending proxies for files a merge or update added (matched by hash to the assets it stored). */
  private pendingForAdded(plan: ProxyPlan, files: SourceInputFile[], shaOf: Map<string, string>, added: Asset[], mode: LocationMode | undefined): PendingProxy[] {
    const assets: Asset[] = [];
    const sub: ProxyPlan = { located: plan.located, proxies: [] };
    for (const p of plan.proxies) {
      const sha = shaOf.get(files[p.index]?.path ?? "");
      const a = sha ? added.find((x) => x.sha256 === sha) : undefined;
      if (!a) continue;
      sub.proxies.push({ index: assets.length, type: p.type });
      assets.push(a);
    }
    const all = this.adapter.viewingProxies === true;
    return pendingFor(sub, assets, mode ?? (all ? this.policyMode : undefined), all);
  }

  /** The item's annotations and the citation-key rule, as createSource options. */
  private extraCreateOpts(
    item: ScanItem,
    prep: Prepared,
    inputs: SourceInputFile[],
    mode: () => LocationMode | undefined,
  ): Pick<CreateSourceOptions, "annotations" | "uniqueCitationKey" | "pairedFiles" | "pendingProxies"> {
    const keys = this.adapter.uniqueCitationKeys ? this.citationKeySet : null;
    const plan = this.planFor(prep, inputs);
    const all = this.adapter.viewingProxies === true;
    // Paired files (a Live Photo's still and video), as indexes of the files stored.
    const indexOf = (n: number) => {
      const real = prep.realOf.get(item.files[n]?.path ?? "");
      return real ? inputs.findIndex((f) => f.path === real) : -1;
    };
    const pairs = (item.pairs ?? []).map(([a, b]) => [indexOf(a), indexOf(b)] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0 && a !== b);
    return {
      ...(plan.proxies.length ? { pendingProxies: (assets: Asset[]) => pendingFor(plan, assets, mode() ?? (all ? this.policyMode : undefined), all) } : {}),
      ...(pairs.length ? { pairedFiles: pairs } : {}),
      ...(item.annotations?.length
        ? {
            annotations: (sourceId: string, assets: Asset[], actor: string) =>
              item.annotations!.map((a) =>
                toAnnotation(a, sourceId, actor, (file) => {
                  const real = prep.realOf.get(file);
                  const i = real ? inputs.findIndex((f) => f.path === real) : -1;
                  return i >= 0 ? assets[i] : undefined;
                }),
              ),
          }
        : {}),
      ...(keys ? { uniqueCitationKey: (k: string) => uniqueKey(keys, k) } : {}),
    };
  }

  /** Citation keys in use in the project (read once per run, on first need), kept current by the run. */
  private citationKeySet: Set<string> | null = null;
  private async citationKeys(): Promise<Set<string>> {
    if (this.citationKeySet) return this.citationKeySet;
    const keys = new Set<string>();
    for (const id of this.repo.listSourceIds(this.projectId)) {
      try {
        keys.add((await this.repo.getSource(this.projectId, id)).source.citationKey);
      } catch {
        // unreadable: its key is not known
      }
    }
    this.citationKeySet = keys;
    return keys;
  }

  private async ocr(sourceIds: string[]): Promise<void> {
    if (!this.deps.queueOcr) {
      this.note("Some PDFs have no text layer; OCR was requested but no OCR worker is available, so they were not queued.");
      return;
    }
    try {
      await this.deps.queueOcr(this.projectId, sourceIds);
      this.rec.ocrQueued = (this.rec.ocrQueued ?? 0) + sourceIds.length;
    } catch {
      this.note("Some PDFs could not be queued for OCR.");
    }
  }

  /** Adds the item's files and the fields the existing source lacks (snapshot kept as a record; the journal records what was added, for undo). */
  private merge(item: ScanItem, targetId: string, r: Resolution, prep: Prepared, method: Provenance["captureMethod"], dedupe: BatchDedupe): Promise<JournalEntry> {
    return serialStore(this.repo, this.projectId, () => this.mergeInner(item, targetId, r, prep, method, dedupe));
  }

  private async mergeInner(item: ScanItem, targetId: string, r: Resolution, prep: Prepared, method: Provenance["captureMethod"], dedupe: BatchDedupe): Promise<JournalEntry> {
    const v = await this.revalidate(item, prep.inputs);
    if (v.fail) return this.queue({ key: item.key, outcome: "failed", reason: REASONS.changed });
    const target = await this.repo.getSource(this.projectId, targetId);
    // Tags are found or created first (each its own change, recorded as the batch's for undo).
    const tagIds = await this.namedTags(item.tags, item.tagColors);
    const haveSha = new Set(target.assets.map((a) => a.sha256));
    // Every new file is checked for a location, not only the one resolution read (R74 I1, R83).
    const newInputs = v.inputs.filter((f) => !haveSha.has(prep.shaOf.get(f.path) ?? ""));
    const plan = await planProxies(newInputs, { all: this.adapter.viewingProxies === true });
    const located = r.hasLocation || plan.located;
    const rule = locationRule();
    const zk = item.externalKeys?.zoteroKey;
    let dropped = 0;
    let deletedHere = 0;
    const out = await this.changeSource(item, targetId, [{ action: "capture", capture: { method } }, storeRequest(target.source.provenance, located)], "import.merge", async (ops, cur) => {
      const added = await this.addFiles(ops, cur, v.inputs);
      // The Zotero item merged in is remembered on the target (R74 M5).
      const merged = applyMerge(cur, added, missingFields(cur, r.draft), r.fieldEvidence, ops.tx.at, ops.tx.actor, tagIds, zk ? [zk] : []);
      const ann = this.annotationPlan(item, merged.next, prep, ops.tx.actor);
      dropped = ann.dropped;
      deletedHere = ann.deletedHere;
      const next = this.withPendingProxies(item.key, ann.added.length ? { ...merged.next, annotations: [...merged.next.annotations, ...ann.added] } : merged.next, this.pendingForAdded(plan, newInputs, prep.shaOf, added, rule.mode()), rule.mode());
      return { next, record: ann.added.length ? { ...merged.record, addedAnnotationIds: ann.added.map((a) => a.id) } : merged.record, outcome: "merged" };
    }, () => ({ ...(dropped ? { annotationsDropped: dropped } : {}), ...(deletedHere ? { annotationsDeletedHere: deletedHere } : {}) }), rule.hook);
    dedupe.add(out.sf);
    this.startProxies(out.sf);
    return out.entry;
  }

  /**
   * Incremental re-import (R72): the item was imported before (as `sourceId`) and changed at its
   * source. Fields still holding the previous import's values are updated, the others kept and
   * reported; new files, tags and annotations are added; provenance is never touched. Governed and
   * audited like a merge, and recorded like one (MergeRecord), so undo reverts it the same way (R61).
   * Nothing to change: `unchanged` (the new version is still recorded).
   */
  private update(item: ScanItem, sourceId: string): Promise<JournalEntry> {
    return serialStore(this.repo, this.projectId, () => this.updateInner(item, sourceId));
  }

  private async updateInner(item: ScanItem, sourceId: string): Promise<JournalEntry> {
    const method = CAPTURE_METHOD[this.rec.source.kind];
    const prep = await this.prepareFiles(item);
    this.addFileNotes(item, prep);
    const v = await this.revalidate(item, prep.inputs);
    const inputs = v.inputs;
    const target = await this.repo.getSource(this.projectId, sourceId);
    const evSource = item.referenceSource ?? { kind: "refman" as const, ref: "reference" };
    const ref = item.referenceMetadata ?? {};
    const haveSha = new Set(target.assets.map((a) => a.sha256));
    const newInputs = inputs.filter((f) => !haveSha.has(prep.shaOf.get(f.path) ?? ""));
    const pre = planUpdate(target, ref, evSource, new Date().toISOString());
    const preAnn = this.annotationPlan(item, target, prep, "");
    this.projectTags ??= await projectCollectionsAndTags(this.repo, this.projectId);
    const known = this.projectTags.tags;
    const newTags = (item.tags ?? []).some((n) => {
      const t = known.find((x) => x.name.toLowerCase() === n.toLowerCase());
      return !t || !target.source.tagIds.includes(t.id);
    });
    const kept = [...pre.kept, ...preAnn.kept.map((k) => `annotation ${k}`)];
    const anything = pre.filled.length || pre.evidence.length || newInputs.length || preAnn.added.length || preAnn.updated.length || newTags;
    if (!anything && !preAnn.backfilled.length) {
      return this.queue({ key: item.key, outcome: "unchanged", sourceId, ...(kept.length ? { merge: emptyRecord(kept) } : {}), ...(preAnn.dropped ? { annotationsDropped: preAnn.dropped } : {}), ...(preAnn.deletedHere ? { annotationsDeletedHere: preAnn.deletedHere } : {}) });
    }
    const tagIds = await this.namedTags(item.tags, item.tagColors);
    // New files may carry a location: location governance applies to them (R57; R74 I1; R83).
    const proxyPlan = await planProxies(newInputs, { all: this.adapter.viewingProxies === true });
    const located = proxyPlan.located;
    const rule = locationRule();
    let dropped = 0;
    let deletedHere = 0;
    const out = await this.changeSource(
      item,
      sourceId,
      [{ action: "capture", capture: { method } }, storeRequest(target.source.provenance, located)],
      "import.update",
      async (ops, cur) => {
        const plan = planUpdate(cur, ref, evSource, ops.tx.at);
        const added = await this.addFiles(ops, cur, inputs);
        const merged = applyMerge(cur, added, plan.filled, plan.evidence, ops.tx.at, ops.tx.actor, tagIds);
        // Evidence of values that were already current is recorded too (not reverted by undo: it is true either way).
        const extraEvidence = plan.evidence.filter((e) => !plan.filled.some((f) => f.path === e.field));
        const ann = this.annotationPlan(item, merged.next, prep, ops.tx.actor);
        dropped = ann.dropped;
        deletedHere = ann.deletedHere;
        const keptAll = [...plan.kept, ...ann.kept.map((k) => `annotation ${k}`)];
        const record: MergeRecord = {
          ...merged.record,
          ...(ann.added.length ? { addedAnnotationIds: ann.added.map((a) => a.id) } : {}),
          ...(ann.updated.length || ann.backfilled.length ? { updatedAnnotations: [...ann.updated, ...ann.backfilled] } : {}),
          ...(keptAll.length ? { kept: keptAll } : {}),
        };
        const changed = plan.filled.length > 0 || added.length > 0 || ann.added.length > 0 || ann.updated.length > 0 || (record.addedTagIds?.length ?? 0) > 0 || extraEvidence.length > 0;
        // Only a back-filled sort index (R195): written and recorded for undo, but reported as unchanged.
        if (!changed && !ann.backfilled.length) return { next: null, record, outcome: "unchanged" };
        const replaced = new Map([...ann.updated, ...ann.backfilled].map((u) => [u.after.id, u.after]));
        const next: SourceFile = this.withPendingProxies(
          item.key,
          {
            ...merged.next,
            annotations: [...merged.next.annotations.map((a) => replaced.get(a.id) ?? a), ...ann.added],
            fieldEvidence: [...merged.next.fieldEvidence, ...extraEvidence],
          },
          this.pendingForAdded(proxyPlan, newInputs, prep.shaOf, added, rule.mode()),
          rule.mode(),
        );
        return { next, record, outcome: changed ? "updated" : "unchanged" };
      },
      () => ({ ...(dropped ? { annotationsDropped: dropped } : {}), ...(deletedHere ? { annotationsDeletedHere: deletedHere } : {}) }),
      rule.hook,
    );
    this.startProxies(out.sf);
    return out.entry;
  }

  /** `next` with more pending viewing proxies (inside the change; the item noted when they must wait for a worker). */
  private withPendingProxies(key: string, next: SourceFile, more: PendingProxy[], mode: LocationMode | undefined): SourceFile {
    if (!more.length) return next;
    const sf = { ...next, pendingProxies: [...(next.pendingProxies ?? []), ...more] };
    this.notePending(key, sf, mode);
    return sf;
  }

  /**
   * One governed change to an existing source (merge or update): snapshot of its source.json in the
   * batch folder (a record), the new source file, and the item's journal line in the same change.
   * `fn` returning `next: null` writes only the journal line (outcome as returned).
   */
  private async changeSource(
    item: ScanItem,
    targetId: string,
    reqs: Parameters<typeof importChange>[2],
    op: string,
    fn: (ops: Parameters<Parameters<typeof importChange>[3]>[0], cur: SourceFile) => Promise<{ next: SourceFile | null; record: MergeRecord; outcome: "merged" | "updated" | "unchanged" }>,
    /** More fields for the journal line, known once `fn` ran. */
    extra: () => Partial<JournalEntry> = () => ({}),
    /** Watches the decision (the location rule, R83); never refuses. */
    refuse?: (d: PolicyDecision, req: Parameters<typeof evaluate>[1]) => string | undefined,
  ): Promise<{ sf: SourceFile; entry: JournalEntry }> {
    const flush = this.pending.length;
    const n = ++this.snapshots;
    const snapshotRel = `${this.rec.dir}/snapshots/${targetId}-${Date.now()}-${n}.json`;
    const projectRel = this.projectRel;
    let entry: JournalEntry | undefined;
    const sf = await importChange(
      this.repo,
      this.projectId,
      reqs,
      async (ops) => {
        const { tx } = ops;
        const cur = await ops.readSource(targetId);
        const r = await fn(ops, cur);
        if (r.next) {
          await tx.mkdir(`${projectRel}/${this.rec.dir}/snapshots`);
          const snapName = `${projectRel}/${snapshotRel.slice(0, snapshotRel.lastIndexOf("/"))}/${fileName(basename(snapshotRel), tx.encrypted)}`;
          await tx.writeFile(snapName, JSON.stringify(cur), { encrypt: tx.encrypted, ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }) });
          await ops.writeSource(cur, r.next);
          const added = new Set(r.record.addedAssetIds);
          const files = fileCounts(r.next.assets.filter((a) => added.has(a.id)).map((a) => a.linked !== undefined));
          entry = this.withNotes({ key: item.key, outcome: r.outcome, sourceId: targetId, mergedInto: targetId, snapshot: snapshotRel, merge: r.record, ...(files ? { files } : {}), ...extra() });
        } else {
          entry = this.withNotes({ key: item.key, outcome: r.outcome, sourceId: targetId, ...(r.record.kept?.length ? { merge: r.record } : {}), ...extra() });
        }
        await appendJournal(tx, projectRel, this.rec.dir, [...this.pending.slice(0, flush), entry]);
        return r.next ?? cur;
      },
      { op, entity: { type: "source", id: targetId }, ...(refuse ? { refuse } : {}) },
    );
    this.pending = this.pending.slice(flush);
    return { sf, entry: entry! };
  }

  /** Copies (or links) the files the source does not have yet (by hash) as further originals. */
  private async addFiles(ops: Parameters<Parameters<typeof importChange>[3]>[0], cur: SourceFile, inputs: SourceInputFile[]): Promise<Asset[]> {
    const have = new Set(cur.assets.map((a) => a.sha256));
    const added: Asset[] = [];
    const label = `${ops.tx.at.slice(0, 16).replace("T", " ").replace(":", "")}`;
    for (const f of inputs) {
      const sha = await sha256File(f.path);
      if (have.has(sha)) continue;
      have.add(sha);
      if (f.handling === "link") added.push(await linkedAsset(repoLibrary(this.repo).root, f, cur.source.id, sha));
      else added.push(await ops.copyOriginal(cur, { fromPath: f.path, kind: f.kind!, ext: f.ext!, ...(f.mime ? { mime: f.mime } : {}), label: `${f.kind} added ${label}`, ...(f.noFollow ? { noFollow: true } : {}) }));
    }
    return added;
  }

  /** The item's annotations against the source (new, changed at the source, kept), anchored in its assets by file hash. */
  private annotationPlan(item: ScanItem, sf: SourceFile, prep: Prepared, actor: string): AnnotationPlan {
    return planAnnotations(sf, item.annotations ?? [], (a) =>
      toAnnotation(a, sf.source.id, actor, (file) => {
        const real = prep.realOf.get(file);
        const sha = real ? prep.shaOf.get(real) : undefined;
        return sha ? sf.assets.find((x) => x.sha256 === sha) : undefined;
      }),
    );
  }
}

const DELETED_NOTE = /^\d+ items? you deleted here (?:was|were) not re-imported/u;
const deletedNote = (n: number) =>
  `${n} ${n === 1 ? "item you deleted here was" : "items you deleted here were"} not re-imported (choose "include deleted items" to import ${n === 1 ? "it" : "them"} again).`;

/** A merge record that changes nothing and only lists fields kept (R72). */
const emptyRecord = (kept: string[]): MergeRecord => ({ addedAssetIds: [], filled: [], addedEvidence: [], kept });

/** Outcomes whose journal line records the item's version (R72). */
const WITH_VERSION = new Set(["created", "needs-review", "merged", "updated", "unchanged"]);

/**
 * Incremental import (R72): for each item identity, the source and version token recorded by the
 * newest journal line of the project's batches of this kind that were not undone.
 */
async function knownVersions(repo: Repo, projectId: string, kind: ImportBatch["source"]["kind"]): Promise<Map<string, { sourceId: string; version: string }>> {
  const out = new Map<string, { sourceId: string; version: string }>();
  for (const d of await batchDirs(repo, projectId)) {
    let rec: BatchRecord | undefined;
    try {
      rec = await readBatchAt(repo, projectId, d.name);
    } catch {
      continue;
    }
    if (!rec || rec.source.kind !== kind || rec.state === "undone") continue;
    for (const e of await readJournal(repo, projectId, rec.dir)) if (e.ext && e.sourceId) out.set(e.ext.id, { sourceId: e.sourceId, version: e.ext.version });
  }
  return out;
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
export async function startBatch(
  deps: BulkImportDeps,
  projectId: string,
  adapter: ImportSourceAdapter,
  input: ImportOptionsInput = {},
  /** Package-internal (device import, R83): the session and participants every new source is linked to (checked by the caller). */
  internal: { fieldwork?: { sessionId?: string; participantIds?: string[] } } = {},
): Promise<BatchHandle> {
  // The id is in the running set before anything is awaited (R61).
  const id = newId();
  active.add(id);
  try {
    const { approveOutside, ...options } = acceptOptions(input);
    const governance = await preflight(deps.repo, projectId, adapter.kind, options);
    await preflightDeleted(deps.repo, projectId, adapter, options);
    const number = await allocateBatchNumber(deps.repo, projectId);
    const secret = randomBytes(32).toString("hex");
    // Approvals are kept as HMACs only (R67); remembered folders join the library's approved folders.
    const remember = approveOutside?.rememberFolders ?? [];
    const outsideApprovals = await approvalHashes(secret, { folders: [...(approveOutside?.folders ?? []), ...remember], files: approveOutside?.files ?? [] });
    if (remember.length) {
      const added = await rememberApprovedFolders(repoLibrary(deps.repo), remember);
      if (added) await appendLibraryEvent(deps.repo, projectId, "import.approve-folders", { batchId: id, added });
    }
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
      secret,
      ...(outsideApprovals.length ? { outsideApprovals } : {}),
      ...(internal.fieldwork && (internal.fieldwork.sessionId || internal.fieldwork.participantIds?.length) ? { fieldwork: internal.fieldwork } : {}),
      ...(adapter.resumeOptions && Object.keys(adapter.resumeOptions).length ? { adapterOptions: { ...adapter.resumeOptions } } : {}),
    };
    // Written before anything is created, so an interrupted batch still has its record.
    await saveRecord(deps.repo, projectId, rec);
    if (rec.fieldwork) {
      // The links themselves are part of each source's governed, audited creation; the request is audited here once.
      await appendLibraryEvent(deps.repo, projectId, "import.fieldwork-link", {
        batchId: id,
        ...(rec.fieldwork.sessionId ? { sessionId: rec.fieldwork.sessionId } : {}),
        participants: rec.fieldwork.participantIds?.length ?? 0,
      });
    }
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
  if (active.has(batchId)) throw new BatchRefusedError("This import is already running.", false, "running");
  active.add(batchId);
  try {
    const rec = await findBatch(deps.repo, projectId, batchId);
    if (!rec) throw new NotFoundError("Import batch", batchId);
    if (rec.state === "finished" || rec.state === "undone") throw new BatchRefusedError("This import has already finished.", false, "finished");
    if (rec.source.kind === "profile-capture") throw new BatchRefusedError("Profile captures are resumed by capturing the profile again.");
    const source = adapter ?? adapterFor(rec.source.kind, rec.source.location, rec.adapterOptions);
    if (!source) throw new BatchRefusedError("The source of this import is needed to resume it.");
    const governance = await preflight(deps.repo, projectId, rec.source.kind, rec.options);
    await preflightDeleted(deps.repo, projectId, source, rec.options);
    if (rec.fieldwork) {
      // The session and participants new sources are linked to must still exist (R117 I2).
      const fw = await deps.repo.getFieldwork(projectId);
      const sid = rec.fieldwork.sessionId;
      if (sid && !fw.sessions.some((x) => x.id === sid)) {
        throw new BatchRefusedError("The fieldwork session this import links its sources to no longer exists, so it cannot be resumed. Start a new import and choose the session again.");
      }
      if ((rec.fieldwork.participantIds ?? []).some((id) => !fw.participants.some((x) => x.id === id))) {
        throw new BatchRefusedError("A participant this import links its sources to no longer exists, so it cannot be resumed. Start a new import and choose the participants again.");
      }
    }
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
        created: { collectionIds: [...r.createdCollectionIds], tagIds: [...r.createdTagIds] },
      });
    } catch {
      // unreadable record: not listed
    }
  }
  return out;
}

/**
 * The capture and store a batch of this kind would ask for, evaluated without writing anything
 * (a dry run writes no audit event): a deny is BatchRefusedError with `denied`.
 */
async function dryRunPolicy(repo: Repo, projectId: string, kind: ImportBatch["source"]["kind"]): Promise<void> {
  const policy = await projectPolicyOrDefault(repo, projectId);
  if (!policy) throw new BatchRefusedError("This project's governance settings could not be read, so nothing may be imported.", true);
  const method = CAPTURE_METHOD[kind];
  const { identifiable, legalBasis } = await storeInputs(repo, projectId, legalCategory(method));
  // The zone and clock the real run's governed writes use (R160 as amended: they always agree).
  const base = { projectId, actor: "dry-run", now: repoClock(repo)().toISOString().replace(/\.\d{3}Z$/u, "Z"), tz: projectDateZone(repo, projectId, "protocol") };
  for (const req of [
    { ...base, action: "capture" as const, capture: { method } },
    { ...base, action: "store" as const, store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } },
  ]) {
    const d = evaluate(policy, req);
    if (d.result === "deny") throw new BatchRefusedError(d.reason, true);
  }
}

/**
 * Dry run (wizard step 2): what a batch from `adapter` would find. Nothing is written to the
 * library: archives are unpacked into a private work folder that is removed before this returns;
 * nothing is looked up online and no audit event is written.
 */
export async function dryRun(
  deps: BulkImportDeps,
  projectId: string,
  adapter: ImportSourceAdapter,
  opts: { approveOutside?: { folders?: string[]; files?: string[] } } = {},
): Promise<ScanSummary> {
  const repo = deps.repo;
  repo.getProject(projectId);
  await dryRunPolicy(repo, projectId, adapter.kind);
  const dedupe = new BatchDedupe(deps.index.db, projectId, (id) => hasSource(repo, projectId, id));
  const summary: ScanSummary = { items: 0, byType: {}, totalBytes: 0, likelyDuplicates: 0, alreadyImported: 0, unreadable: [], notes: [], outsideFiles: [], linkedFiles: 0 };
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
      note: (t) => {
        if (!summary.notes.includes(t)) summary.notes.push(t);
      },
      dryRun: true,
    });
    // The approvals the batch would be given count here too (kept in memory only, under a throwaway secret).
    const secret = randomBytes(32).toString("hex");
    const policy = await OutsidePolicy.create(adapter.roots, [dir, ...(await approvedFolders(repoLibrary(repo)))], secret, await approvalHashes(secret, opts.approveOutside));
    for await (const scanned of scan) {
      let item = scanned;
      summary.items++;
      if (item.unreadable) {
        summary.unreadable.push({ path: item.key, reason: item.unreadable });
        continue;
      }
      summary.linkedFiles += item.files.filter((x) => x.link === true).length;
      if (policy && item.files.length) {
        const inside: ScanItem["files"] = [];
        for (const x of item.files) {
          const c = await policy.check(x.path);
          if (c.ok) inside.push(x);
          else summary.outsideFiles.push({ item: reportLabel(item.key, null), folder: dirname(c.real), file: c.real }); // no tag: no batch secret yet
        }
        item = { ...item, files: inside };
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
