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
 * such an item is simply processed again, with the same result. A pause or suspend takes effect
 * between items, after the item in hand and before the adapter is asked for the next one. So a suspend
 * that arrives while the adapter fetches an item waits until that item is stored too (the service bounds
 * the wait, then cancels; the batch stays resumable), and a pause asked for during the last item holds the
 * finished run paused until it is resumed.
 *
 * Incremental adapters (R72) are told what the journals of the batches of their kind that were not
 * undone know: `knownIds`, and (Z4) `fileKnown`, from the parts of each item's newest line (attachment
 * version and stored file hash), while the source still holds an asset entry with that hash (I1). A
 * journal line records a part only when its source holds an asset entry with the file's hash (partsFor). A
 * known file whose entries the researcher destroyed here (retention) is never brought back and is noted
 * (`removedHere`); a file whose entry is simply gone (an undo) is downloaded again.
 *
 * Gone at the source (Zotero, Task Z5): an item the adapter yields as `gone` ("deleted" in Zotero, or in its
 * "bin") MARKS the source it came from — the known source whose own provenance names this Zotero item of this
 * library — `availability: { status: "unavailable-on-platform", zotero, firstNoticedAt }`, in one governed change
 * (`import.zotero-mark`, audited `{ marked }` only) recorded like a merge (MergeRecord.availability), so undo puts
 * the earlier availability back while it is still the one written. Nothing else of the source changes, and nothing
 * is ever deleted because Zotero says so. Already marked the same way: counted only. A source that only merged the
 * key, one deleted here (R73), or none: `zotero-gone-unmarked`, counted apart. The mark's journal line records the
 * version Zotero gave and the known file parts, so the item seen again as content goes through the update path,
 * which first gives the source back the availability it had before the mark (`zotero-back`), then updates it as
 * any re-import does (the researcher's edits survive, R192, R195–R198).
 *
 * Linking (`fileHandling: 'link'`) stores the file's absolute path and its path relative to the
 * library (LinkedRelativePath, R24) and copies nothing; it is refused in projects whose governance
 * requires encryption at rest or that are encrypted. Files unpacked from archives are always copied.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { libraryVersion } from "../../resources.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileTypeFromFile } from "file-type";
import {
  Asset,
  ImportOptions,
  LinkedRelativePath,
  type Availability,
  evaluate,
  findDuplicate,
  newId,
  recheckSourceFile,
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
import { NotFoundError, PolicyDeniedError, ProjectLockedError, RecoveryPendingError } from "../../repo/errors.js";
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
import { BIB_DOUBTS } from "../bib-blocks.js";
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
  unsavedStops,
  batchDirs,
  countOutcomes,
  fileCounts,
  fileName,
  findBatch,
  latestByKey,
  readBatchAt,
  readJournal,
  readParts,
  readCols,
  readColKeys,
  collectionHash,
  writeBatchRecord,
  type BatchRecord,
  type BatchState,
  type GovernanceNote,
  type JournalEntry,
  type ShownState,
} from "./batch.js";
import { BatchDedupe } from "./dedupe.js";
import { applyMerge, missingFields, type MarkRecord, type MergeRecord } from "./merge.js";
import { OUTSIDE_NOTE, OUTSIDE_REASON, OutsidePolicy, approvalHashes } from "./outside.js";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { folderId, importOverlapsLibrary, insideFolder, insideLibrary, libraryRealRoot, onFolderPath, realOrNearest } from "../../fs/inside-library.js";
import { reportLabel, writeBatchReport } from "./report.js";
import { PATTERN_BUDGET_MS, PatternWatchdog } from "./patterns.js";
import { adapterFor, type ImportSourceAdapter, type ScanItem } from "./scan.js";
import { DISK_FULL_NOTE, NoRoomError, RECOVERY_NOTE, cheapEstimate, fileMargin, fitSentence, freeRoom, isDiskFull, rememberScan, rememberedScan, spaceMargin, zoteroCopyBytes, zoteroDataDir } from "./space.js";
import { capAnnotations, conflictVerification, planAnnotations, planBackfill, planUpdate, toAnnotation, uniqueKey, type AnnotationPlan } from "./update.js";

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
  /**
   * Z4: a file an earlier import stored (the journal says so) whose asset the researcher destroyed here
   * (retention; the asset entry says so): it is not downloaded and not brought back.
   */
  removedHere: "an attached file you removed here was not brought in again",
  /** R362 c: a file whose real path is inside this library's own folder (outside this batch's work folder). */
  inLibrary: "attached file is inside this library's own folder and was not imported",
} as const;

/**
 * Kinds whose source is a folder the researcher chose (R362 c; Zotero's data folder, R368 a): never the library's own
 * folder, inside it or holding it.
 */
const FOLDER_KINDS: ReadonlySet<string> = new Set(["folder", "device", "calibre", "zotero-local"]);
/** Kinds that read a FILE of their own (R368 a): never one inside the library (its backups above all, which hold the held files). */
const FILE_KINDS: ReadonlySet<string> = new Set(["zip", "bibtex", "ris", "csl-json", "zotero-rdf"]);
/** A Zotero data folder's location may name another of its libraries (zotero-local.ts): the folder is what comes before. */
const ZOTERO_LIBRARY_SUFFIX = /#library=\d{1,9}$/u;

/**
 * R362 c, R368 a: an import whose own source lies inside the library (by real path) is refused whole — a folder inside
 * it or holding it, a file inside it — at the dry run, the start and the resume, before anything is read. Zotero Web
 * and the attach kinds have no file or folder of their own here.
 */
async function refuseLibrarySource(repo: Repo, adapter: ImportSourceAdapter): Promise<void> {
  if (FOLDER_KINDS.has(adapter.kind)) {
    const dir = adapter.kind === "zotero-local" ? adapter.location.replace(ZOTERO_LIBRARY_SUFFIX, "") : adapter.location;
    if (await importOverlapsLibrary(await realOrNearest(dir), repoLibrary(repo))) throw new BatchRefusedError(IN_LIBRARY_TEXT.folder);
  } else if (FILE_KINDS.has(adapter.kind)) {
    if (await insideLibrary(adapter.location, repoLibrary(repo))) throw new BatchRefusedError(IN_LIBRARY_TEXT.importFile);
  }
}

/**
 * Kinds whose run itself writes the files it imports into the batch's work folder (R368 a): a ZIP's entries (a folder's
 * ZIPs too) are unpacked there and Zotero Web's files downloaded there. No other kind's files are ever there.
 */
const WORK_KINDS: ReadonlySet<string> = new Set(["zip", "folder", "zotero-web"]);

/** R362 c, R368 a: whether a file (as the adapter gave it, and its real path) is one of the library's own. */
type LibraryFileTest = (file: { path: string; link?: boolean }, real: string) => Promise<boolean>;

/**
 * R362 c: a test of a file's real path — inside the library's own folder. The batch's own work folder `work` is exempt
 * only for what the run wrote there itself (R368 a): a kind that writes there, a file the adapter gave by a path in that
 * folder (not a link to it from elsewhere) and not a file a source links in place (a path named by the source's data).
 * So no caller can name it: an export's file field, a Zotero linked file or a link in a folder pointing into the work
 * folder is the library's like any other.
 */
async function libraryFileTest(repo: Repo, work: string, kind: string): Promise<LibraryFileTest> {
  const [root, rootId, own] = await Promise.all([libraryRealRoot(repoLibrary(repo).root), folderId(repoLibrary(repo).root), realOrNearest(work)]);
  const ownAsWritten = resolve(work);
  const written = (f: { path: string; link?: boolean }, real: string) =>
    WORK_KINDS.has(kind) && f.link !== true && (insideFolder(ownAsWritten, resolve(f.path)) || insideFolder(own, resolve(f.path))) && insideFolder(own, real);
  // By name, or by device and inode (a folder on the real path is the library's folder; R368 d).
  return async (f, real) => !written(f, real) && (insideFolder(root, real) || (await onFolderPath(real, rootId)));
}

/** The run's note on files removed here and not brought back (Z4), counted over the batch's lines. */
const removedNote = (n: number) => (n === 1 ? "An attached file you removed here was not brought in again." : `${n} attached files you removed here were not brought in again.`);
const REMOVED_NOTE = /^(?:An attached file you removed here was|\d+ attached files you removed here were) not brought in again\.$/u;

/** A stored file's parts as journaled (Z4). */
type Parts = Record<string, { v: number; sha256?: string }>;
/** What the newest journal line of an item says (R72; Z4 parts; Z6 the collections Zotero had it in, as name hashes). */
type Known = { sourceId: string; version: string; parts?: Parts; cols?: string[][]; colKeys?: string[][] };
/** A verification report with these fields' entries set (or removed, when `after` is absent). */
function withEntries(v: SourceFile["verification"], entries: Array<{ path: string; after?: SourceFile["verification"][string] }>): SourceFile["verification"] {
  const out = { ...v };
  for (const e of entries) {
    if (e.after) out[e.path] = e.after;
    else delete out[e.path];
  }
  return out;
}

/** Task Z6: an item's collection paths (names), and the same as name hashes, as journaled. */
const itemPaths = (item: ScanItem): string[][] => [item.folderPath ?? [], ...(item.moreFolderPaths ?? [])].filter((p) => p.length > 0);
const hashPath = (p: string[]): string[] => p.map(collectionHash);
const pathKey = (h: string[]) => h.join("/");

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
 * R393: what an UNEXPECTED error was, said in plain words. Each kind (the system's error code) has what happened,
 * for an item and for the batch, and what the researcher can do about it where there is something. SQLite codes can
 * come from Zotero's database (read while the source is scanned) or from the library's own index (dedupe keys), so
 * the sentence names both.
 */
interface CauseText {
  item: string;
  batch: string;
  itemAction?: string;
  batchAction?: string;
}
const NO_FILES: CauseText = {
  item: "the computer would not open more files at once",
  batch: "the computer would not open more files at once",
  itemAction: "Close other programs and import again.",
  batchAction: "close other programs and resume the batch to continue",
};
const UNREADABLE: CauseText = {
  item: "a file of the item could not be read",
  batch: "a file could not be read",
  itemAction: "Check that the app may read the folder the file is in, then import again.",
  batchAction: "check that the app may read the folder the import comes from, then resume the batch to continue",
};
const DB_BUSY: CauseText = {
  item: "a database was busy (Zotero's, or the library's own index)",
  batch: "a database was busy (Zotero's, or the library's own index)",
  itemAction: "Close Zotero and import again.",
  batchAction: "close Zotero and resume the batch to continue",
};
const DB_UNREADABLE: CauseText = {
  item: "a database could not be read (Zotero's, or the library's own index)",
  batch: "a database could not be read (Zotero's, or the library's own index)",
};
const CAUSE_TEXTS: Readonly<Record<string, CauseText>> = {
  ENOSPC: { item: "the disk is full", batch: "the disk is full", itemAction: "Free some space and import again.", batchAction: "free some space and resume the batch to continue" },
  EDQUOT: { item: "the disk is full", batch: "the disk is full", itemAction: "Free some space and import again.", batchAction: "free some space and resume the batch to continue" },
  EMFILE: NO_FILES,
  ENFILE: NO_FILES,
  ENOENT: { item: "a file of the item was not found", batch: "a file was not found" },
  EACCES: UNREADABLE,
  EPERM: UNREADABLE,
  EIO: { item: "the disk reported an error", batch: "the disk reported an error", itemAction: "Check the disk and import again.", batchAction: "check the disk and resume the batch to continue" },
  ENAMETOOLONG: { item: "a file's name is too long", batch: "a file's name is too long" },
  SQLITE_BUSY: DB_BUSY,
  SQLITE_LOCKED: DB_BUSY,
};

/** A system code (`EMFILE`), a SQLite code (`SQLITE_BUSY_SNAPSHOT`) or a Node code (`ERR_…`): never free text. */
const CODE_FORM = /^(?:E[A-Z0-9]{2,15}|SQLITE_[A-Z_]{2,40}|ERR_[A-Z0-9_]{2,60})$/u;
/** An error class's name (`TypeError`, `SqliteError`): an identifier, never free text. */
const CLASS_FORM = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

/**
 * R393 a: the kind of an unexpected error — its system code where it (or an error it wraps as `cause`) has one, else
 * its class name; "unknown" for something thrown that is not an error. Never the message, never a path.
 */
export function causeOf(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CODE_FORM.test(code)) return code;
  }
  if (!(err instanceof Error)) return "unknown";
  return CLASS_FORM.test(err.name) ? err.name : "Error";
}

const causeText = (kind: string): CauseText | undefined => CAUSE_TEXTS[kind] ?? (kind.startsWith("SQLITE_BUSY") || kind.startsWith("SQLITE_LOCKED") ? DB_BUSY : kind.startsWith("SQLITE_") ? DB_UNREADABLE : undefined);

/** R393 a: an item's failure of the given kind, as the report says it. */
export function failedReason(kind: string): string {
  const t = causeText(kind);
  if (!t) return `The item could not be imported: an unexpected error (${kind}).`;
  return `The item could not be imported: ${t.item}.${t.itemAction ? ` ${t.itemAction}` : ""}`;
}

/** R393 a: the note of a batch stopped by an error of the given kind (R413 b: a full disk has its own sentence). */
export function stoppedNote(kind: string): string {
  if (kind === "ENOSPC" || kind === "EDQUOT") return DISK_FULL_NOTE;
  if (kind === "RecoveryPendingError") return RECOVERY_NOTE;
  const t = causeText(kind);
  if (!t) return `The import stopped because of an unexpected error (${kind}); resume the batch to continue.`;
  return `The import stopped because ${t.batch}; ${t.batchAction ?? "resume the batch to continue"}.`;
}

/** Every note `stoppedNote` writes (and the one written before R393): a resumed run drops them. */
const STOPPED_NOTE = /^The import stopped because .*(?:; .*resume the batch to continue|, then resume the import)\.$/u;

/**
 * R393 b: an unexpected error for the log — its kind, code, syscall and errno, and the program's stack frames (the
 * lines that start with "at"); never its message, which may hold a path, a title or a name.
 */
export function errorForLog(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; syscall?: unknown; errno?: unknown; name?: unknown; stack?: unknown };
  const parts = [`kind=${causeOf(err)}`];
  if (err instanceof Error) parts.push(`class=${CLASS_FORM.test(err.name) ? err.name : "Error"}`);
  if (typeof e.code === "string" && CODE_FORM.test(e.code)) parts.push(`code=${e.code}`);
  if (typeof e.syscall === "string" && /^[a-z_]{1,32}$/u.test(e.syscall)) parts.push(`syscall=${e.syscall}`);
  if (typeof e.errno === "number") parts.push(`errno=${e.errno}`);
  const frames = typeof e.stack === "string" ? e.stack.split("\n").filter((l) => /^\s+at /u.test(l)).slice(0, 20) : [];
  return [parts.join(" "), ...frames].join("\n");
}

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
  /**
   * Task Z5 (R224): sources this batch marked gone from Zotero (deleted there, or in its bin), and of them those in
   * the bin; sources already marked the same way by an earlier batch (counted only, `goneAlready`); sources seen
   * again whose mark was taken away (`backInZotero`), and of them those whose content was also updated
   * (`backInZoteroUpdated`, which are counted in `updated` too); and items Zotero said are gone that have no source
   * of their own here (deleted here, merged only), counted apart. None of these is in `items`, except back.
   */
  goneInZotero: number;
  goneInZoteroBin: number;
  goneAlready: number;
  backInZotero: number;
  backInZoteroUpdated: number;
  goneNotMarked: number;
  /**
   * Task Z6 (Zotero Web): ITEMS with a field changed in Zotero AND here, to different values, now waiting for the
   * researcher in the review queue ("Changed in Zotero and here — waiting for you: N"). An item that also took in
   * other changes is counted in `updated` as well; one whose only change was the conflict is in `items` and here only.
   */
  conflicts: number;
  /** Task Z6: collections renamed in Zotero (the same collection KEY under another name) that arrived under the new name (the old one kept), each once. */
  collectionsRenamed: number;
  /** R236 a: ITEMS with a field Zotero cleared that keeps its value here (noted once; neither emptied nor asked). */
  clearedInZoteroKept: number;
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
  /**
   * R413 a: the bytes a batch with the default options (copy; files the source links in place kept as links, where
   * the project allows) would copy into the library, and the free room on the library's disk (absent when it cannot
   * tell); `spaceWarning`, the sentence a start would be refused with, when they do not fit.
   */
  copyBytes?: number;
  freeBytes?: number;
  spaceWarning?: string;
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
  /** R248: "zotero-sync" when the Zotero account sync started it (from the batch's own record). */
  origin?: "zotero-sync";
  /** R248: for a Zotero Web batch, its Zotero library (`user:<n>` / `group:<n>`, the record's source location). */
  ref?: string;
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

/** Kinds whose files can never be left where they are (R413 a): a ZIP's are unpacked from it, Zotero Web's downloaded. */
const COPY_ONLY_KINDS: ReadonlySet<string> = new Set(["zip", "zotero-web"]);

/**
 * R413 a: before a batch that copies files starts, whether they fit. The bytes to be copied are what the dry run of
 * the same source found (else the source's own cheap total, space.ts; neither: no check, the run's per-file check
 * still protects), less the files the source links in place when they stay links; with the margin (10%, at least
 * 500 MB) and, for a Zotero local import, its database copy, they must fit in the free room on the library's disk, or
 * the start is refused (BatchRefusedError, nothing written). Returns the room the scan's own temporary copies must
 * leave free beyond themselves (ScanContext.reserveBytes): the files and the margin.
 */
async function preflightSpace(repo: Repo, projectId: string, adapter: ImportSourceAdapter, options: ImportOptions): Promise<number> {
  if (options.fileHandling === "link") return spaceMargin(0);
  const est = rememberedScan(projectId, adapter) ?? (await cheapEstimate(adapter).catch(() => undefined));
  if (!est) return spaceMargin(0);
  const linkRefused = await preflightLink(repo, projectId);
  const copy = Math.max(0, est.totalBytes - (options.linkedFiles === "link" && !linkRefused ? est.linkedBytes : 0));
  const reserve = copy + spaceMargin(copy);
  if (!copy) return reserve;
  const db = adapter.kind === "zotero-local" ? await zoteroCopyBytes(zoteroDataDir(adapter.location)) : 0;
  const free = await freeRoom(repoLibrary(repo).root);
  if (Number.isFinite(free) && reserve + db > free) throw new BatchRefusedError(fitSentence(copy, free, !linkRefused && !COPY_ONLY_KINDS.has(adapter.kind)));
  return reserve;
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
  /** R413 b: the bytes of the files that are to be copied into the library (not linked in place). */
  copyBytes: number;
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
/** The BibTeX doubts (R362 g, R366): a record carrying one is never merged into an existing source (R366 b). */
const BIB_DOUBT_SET: ReadonlySet<string> = new Set(Object.values(BIB_DOUBTS));

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
  /** R362 c: whether a real path is inside the library's own folder (and not in this run's work folder). */
  private inLibrary: LibraryFileTest = async () => false;
  /** Real path of each file attached in this run → the item it went to (a second item gets a note). */
  private fileOwners = new Map<string, string>();
  private readonly workName: string;
  /** Incremental import (R72): identity → the source and version token the newest journal line recorded. */
  private known = new Map<string, Known>();
  /** Task Z6 (Zotero Web): item key → the collections Zotero has it in now, as name hashes (journaled with its outcome). */
  private cols = new Map<string, string[][]>();
  /** R236 f: item key → the Zotero collection keys along those paths (journaled beside them). */
  private colKeys = new Map<string, string[][]>();
  /**
   * Task Z6: conflicts (a field changed in Zotero and here) and memberships added on update are the account sync's
   * alone (the plan: Zotero Web). Every other adapter, the local Zotero import included, behaves as before.
   */
  private get zoteroWeb(): boolean {
    return this.rec.source.kind === "zotero-web";
  }
  /** Task Z5: source id → the availability changes its "gone from Zotero" marks made, oldest first (batches not undone, and this run). */
  private marks: Marks = new Map();
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
  private versions = new Map<string, NonNullable<ScanItem["version"]>>();
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
    /** R413 d: the room the scan's own temporary copies (the Zotero database) must leave free (preflightSpace). */
    private readonly reserve: number = spaceMargin(0),
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
    // The record's counts agree with the report's (R224 a): `merged` is the report's merged + updated (a back that
    // also updated the item is in `updated`); marks, bare backs and gone items are counted only in countsDetail.
    this.rec.counts = {
      created: c.created,
      merged: c.merged + c.updated,
      skipped: c.duplicates + c.unchanged + c.deletedHere,
      failed: c.failed,
      needsReview: c.needsReview,
    };
    // Z5: the Zotero detail, counted apart in the record (absent when there is none, as in every other kind of batch).
    if (c.goneInZotero || c.goneAlready || c.backInZotero || c.goneNotMarked) {
      this.rec.countsDetail = {
        ...(this.rec.countsDetail ?? {}),
        goneInZotero: c.goneInZotero,
        goneInZoteroBin: c.goneInZoteroBin,
        goneAlready: c.goneAlready,
        backInZotero: c.backInZotero,
        backInZoteroUpdated: c.backInZoteroUpdated,
        goneNotMarked: c.goneNotMarked,
      };
    }
    // Z6: items waiting for the researcher's decision, and renamed collections, counted apart in the record too (only
    // when there are any; the report's `conflicts` and `collectionsRenamed` are the same numbers).
    if (c.conflicts || c.collectionsRenamed || c.clearedInZoteroKept) {
      this.rec.countsDetail = { ...(this.rec.countsDetail ?? {}), conflicts: c.conflicts, collectionsRenamed: c.collectionsRenamed, clearedInZoteroKept: c.clearedInZoteroKept };
    }
    this.rec.createdSourceIds = [...this.createdIds];
    this.rec.governance = [
      ...this.rec.governance.filter((g) => g.items === undefined),
      ...[...this.denies].map(([reason, items]) => ({ action: "store", result: "deny" as const, reason, items })),
    ];
  }

  private async checkpoint(state: BatchState, finished = false): Promise<void> {
    await this.flush();
    this.syncRecord(state);
    // The adapter's resume options as they stand now (Zotero Web adds the version each part read at, A5),
    // saved in the same change as the journal lines that part brought in.
    const ro = this.adapter.resumeOptions;
    if (ro && Object.keys(ro).length) this.rec.adapterOptions = JSON.parse(JSON.stringify(ro)) as BatchRecord["adapterOptions"];
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
    // R393: a stop of an earlier run of this batch is no longer the news; this run says its own.
    this.rec.notes = this.rec.notes.filter((n) => !STOPPED_NOTE.test(n));
    delete this.rec.stopCause;
    unsavedStops.delete(this.rec.id);
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
      this.inLibrary = await libraryFileTest(this.repo, join(repoLibrary(this.repo).root, ".tmp", this.workName), this.rec.source.kind);
      if (this.adapter.incremental) {
        this.known = await knownVersions(this.repo, this.projectId, this.rec.source.kind, this.marks);
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
      let knownIds: ReadonlySet<string> | undefined;
      const scan = this.adapter.scan(this.abort.signal, {
        workDir: () => this.ensureWorkDir(),
        reserveBytes: this.reserve,
        note: (t) => this.note(t),
        // An item already in this batch's journal is passed by below: the adapter need not fetch it (Z2).
        skip: (key) => this.latest.has(key),
        ...(this.adapter.incremental ? { knownIds: () => (knownIds ??= new Set(this.known.keys())), fileKnown: (id, att, v) => this.fileKnown(id, att, v) } : {}),
      });
      for await (const item of scan) {
        if (seenKeys.has(item.key)) continue;
        seenKeys.add(item.key);
        // Gone at its source (Zotero): marked in `item` (Z5); like any item, passed by when this batch has its line.
        if (!item.gone && !this.latest.has(item.key) && this.recovered.size) {
          // Resume guard: a source of this batch for this item exists although its line was lost.
          const sid = this.recovered.get(itemKeyHash(this.rec.secret!, item.key));
          if (sid) this.latest.set(item.key, this.queue({ key: item.key, outcome: "created", sourceId: sid }));
        }
        if (this.latest.has(item.key)) {
          done++;
          total = Math.max(total, done);
          continue;
        }
        if (this.cancelled) break;
        this.feed.emit({ done, total: Math.max(total, done + 1), current: item.key });
        const entry = await this.item(item, dedupe, watchdog);
        if (entry) this.latest.set(entry.key, entry); // queued items are recorded when their group is stored
        done++;
        total = Math.max(total, done);
        this.feed.emit({ done, total });
        if (this.pending.length >= 200) await this.checkpoint("running");
        // A pause or suspend takes effect here, after the item in hand and BEFORE the next is asked of the
        // adapter: an item the adapter already fetched (a Zotero file downloaded for it, Z4) is never dropped
        // and fetched again by the resumed run.
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
          if (this.cancelled) break;
          await this.checkpoint("running");
        }
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
              : stoppedNote(causeOf(err)),
        );
        // R393 a, b: the stopping error's kind is kept with the batch and logged with the program's stack.
        if (!(err instanceof ProjectLockedError || err instanceof BatchRefusedError || err instanceof PolicyDeniedError)) this.rec.stopCause = causeOf(err);
        this.deps.debug?.(`bulk import stopped: ${errorForLog(err)}`);
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
    // Z5: the note on deletions in Zotero counts what this batch actually marked as deleted there (the scan's own
    // note, which counts what Zotero listed, is replaced; items not marked are counted apart, not in it).
    const goneMarked = [...this.latest.values()].filter((e) => e.outcome === "zotero-gone" && e.gone === "deleted" && e.merge?.availability).length;
    this.rec.notes = this.rec.notes.filter((n) => !ZOTERO_DELETED_NOTE.test(n));
    if (goneMarked) this.note(zoteroDeletedNote(goneMarked));
    // Z4: files removed here that a later run did not bring back, over every line of the batch (a resume too).
    const removed = [...this.latest.values()].reduce((n, e) => n + (e.notes?.filter((x) => x === ENGINE_FILE_NOTES.removedHere).length ?? 0), 0);
    this.rec.notes = this.rec.notes.filter((n) => !REMOVED_NOTE.test(n));
    if (removed) this.note(removedNote(removed));
    for (const id of watchdog.disabled) {
      this.note(`The file-name pattern "${id}" took too long on a file name and was switched off for the rest of this import.`);
    }
    try {
      await this.flush().catch(() => {});
      await this.checkpoint(state, true);
      await writeBatchReport(this.repo, this.projectId, this.rec.id);
    } catch (err) {
      this.deps.debug?.(`bulk import: the batch record could not be saved: ${errorForLog(err)}`);
      // R413 b, c: the report still says why the batch stopped (kept in memory until the record is saved again).
      const stop = this.rec.notes.find((n) => STOPPED_NOTE.test(n));
      if (stop) unsavedStops.set(this.rec.id, stop);
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
      if (item.gone) return await this.gone(item);
      if (item.fileNotes?.length) this.fileNotes.set(item.key, item.fileNotes.slice(0, 50).map((n) => n.slice(0, 300)));
      if (item.unreadable) return this.queue({ key: item.key, outcome: "failed", reason: item.unreadable });
      if (this.adapter.incremental && item.version) {
        this.versions.set(item.key, item.version);
        if (this.zoteroWeb) {
          const paths = itemPaths(item);
          this.cols.set(item.key, paths.map(hashPath));
          // The keys only when they match the paths name for name (an adapter's mistake leaves them out, never misread).
          const keys = item.folderKeys;
          if (keys && keys.length === paths.length && keys.every((k, i) => Array.isArray(k) && k.length === paths[i]!.length)) this.colKeys.set(item.key, keys);
          else this.colKeys.delete(item.key);
        }
        const k = this.known.get(item.version.id);
        if (k && !hasSource(this.repo, this.projectId, k.sourceId)) await this.refreshDeleted(); // deleted meanwhile?
        if (k && hasSource(this.repo, this.projectId, k.sourceId)) {
          // Z6: an item Zotero did not change but whose collections did (a rename does not change the item's version)
          // goes through the update when it has a membership that is new; the check is in memory (no read).
          if (k.version === item.version.version && !this.newMemberships(item, k).length) {
            // Z4: with stored files, the source's assets decide which parts are journaled and whether a known
            // file was removed here (one read; an item without files costs none, as before).
            const target = item.version.parts && Object.keys(item.version.parts).length ? await this.repo.getSource(this.projectId, k.sourceId) : undefined;
            if (target) this.noteRemoved(item, k.sourceId, target.assets);
            return (await this.backfillOnly(item, k.sourceId, target)) ?? this.queue({ key: item.key, outcome: "unchanged", sourceId: k.sourceId }, target?.assets);
          }
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
    // R413 b: a full disk (or quota) is the batch's condition, not the item's: the batch stops here and the item in
    // hand gets no line, so a resume takes it up again (its change, if one had begun, rolled itself back, R26).
    // R413 c: so is a project that refuses every write (an earlier change could not be undone): stopped at the first
    // refusal, instead of failing every item after it.
    if (isDiskFull(err) || err instanceof RecoveryPendingError) throw err;
    if ((err as Error)?.name === "AbortError") throw err;
    // Anything else is unexpected (R393 a, b): the line keeps its kind and the report says it; the log gets the
    // kind and the program's stack, never the error's message (it may hold a path, a title or a name).
    const cause = causeOf(err);
    this.deps.debug?.(`bulk import item failed: ${errorForLog(err)}`);
    return this.queue({ key: item.key, outcome: "failed", reason: failedReason(cause), cause });
  }

  /**
   * Task Z5: an item Zotero says was deleted, or is in its bin (`ScanItem.gone`, yielded only by an incremental
   * adapter for an identity known here). Marked: the known source whose OWN provenance names this Zotero item of
   * this library (`externalKeys.zoteroKey` and `libraryId`, from the version id `<ref>/<key>`). Its availability
   * becomes `{ status: "unavailable-on-platform", zotero, firstNoticedAt }` in one governed change through
   * changeSource (snapshot, source, journal line; R26), audited as `import.zotero-mark` with `{ marked }` only
   * (R177); nothing else of the source is touched (not even its modification time). Already marked the same way:
   * counted only, the date kept. Bin then deleted (or the other way): the mark and its date are updated. A source
   * that only merged the key, one deleted here and remembered (R73), or no source at all: `zotero-gone-unmarked`,
   * nothing written but the line. A non-incremental adapter's gone item is passed by (null: no line).
   */
  private async gone(item: ScanItem): Promise<JournalEntry | null> {
    const v = item.version;
    const g = item.gone!;
    if (!this.adapter.incremental || !v) return null;
    const cut = v.id.lastIndexOf("/");
    const ref = v.id.slice(0, cut);
    const zoteroKey = v.id.slice(cut + 1);
    const k = this.known.get(v.id);
    const unmarked = () => this.queue({ key: item.key, outcome: "zotero-gone-unmarked", gone: g });
    if (cut <= 0 || !zoteroKey || !k || !hasSource(this.repo, this.projectId, k.sourceId)) return unmarked();
    const target = await this.repo.getSource(this.projectId, k.sourceId);
    const keys = target.source.provenance.externalKeys;
    if (keys?.zoteroKey !== zoteroKey || keys.libraryId !== ref) return unmarked();
    // The line records the version Zotero gave ("bin:<v>" or "deleted") with the parts known for its files: the
    // item seen again as content is then never "unchanged" (its mark is taken away, below in updateInner) and its
    // files are not downloaded again (Z4).
    this.versions.set(item.key, { id: v.id, version: v.version, ...(k.parts ? { parts: k.parts } : {}) });
    // Z6: the collections the item was last seen in are carried over too (a gone item has none of its own).
    if (k.cols) this.cols.set(item.key, k.cols);
    if (k.colKeys) this.colKeys.set(item.key, k.colKeys);
    const same = (a: Availability) => a.status === "unavailable-on-platform" && a.zotero === g;
    if (same(target.source.availability)) return this.queue({ key: item.key, outcome: "zotero-gone", sourceId: k.sourceId, gone: g }, target.assets);
    await this.flush();
    const out = await serialStore(this.repo, this.projectId, () =>
      this.changeSource(
        item,
        k.sourceId,
        [storeRequest(target.source.provenance, false)],
        "import.zotero-mark",
        async (ops, cur) => {
          const before = cur.source.availability;
          const record: MergeRecord = { addedAssetIds: [], filled: [], addedEvidence: [] };
          if (same(before)) return { next: null, record, outcome: "zotero-gone" };
          const after: Availability = { status: "unavailable-on-platform", zotero: g, firstNoticedAt: ops.tx.at };
          // R224 b: the record carries the marks under `before` and the availability before all of them, so its undo
          // (and a later back) never depends on another batch's journal, nor puts back a mark whose batch is undone.
          const under = before.zotero !== undefined ? this.markChain(cur.source.id, before) : { marks: [], preMark: before };
          const availability: MarkRecord = { before, after, ...(under.preMark ? { preMark: under.preMark } : {}), marks: under.marks };
          return { next: { ...cur, source: { ...cur.source, availability: after } }, record: { ...record, availability }, outcome: "zotero-gone" };
        },
        () => ({ gone: g }),
        undefined,
        { marked: g },
      ),
    );
    const a = out.entry.merge?.availability;
    if (a) this.marks.set(k.sourceId, [...(this.marks.get(k.sourceId) ?? []), { ...a, batchId: this.rec.id }]);
    return out.entry;
  }

  /**
   * Task Z5 (R224 b): the "gone from Zotero" marks under a marked availability, oldest first, each with the batch that
   * made it, and the availability before all of them (`preMark`). The marks known are those of batches not undone and
   * of this run. `preMark` comes from the newest mark that matches (each mark records it), so a mark whose earlier
   * mark's batch was undone still knows it; for a mark recorded before R224 (no `preMark`), the chain is followed back
   * through each mark's `before`. Undefined only when neither works (see restoreFor).
   */
  private markChain(sourceId: string, now: Availability): { marks: Array<{ batchId: string; after: Availability }>; preMark?: Availability } {
    const list = this.marks.get(sourceId) ?? [];
    const marks: Array<{ batchId: string; after: Availability }> = [];
    let preMark: Availability | undefined;
    let a = now;
    for (let i = 0; i <= list.length && a.zotero !== undefined; i++) {
      const m = [...list].reverse().find((x) => isDeepStrictEqual(x.after, a));
      if (!m) break;
      marks.unshift({ batchId: m.batchId, after: m.after });
      preMark ??= m.preMark;
      a = m.before;
    }
    if (a.zotero === undefined) preMark ??= a;
    return { marks, ...(preMark ? { preMark } : {}) };
  }

  /**
   * Task Z5: the availability a marked source had before its "gone from Zotero" marks (markChain), given back
   * exactly, whatever it was. The fallback "available" (as profile capture restores a post that returns) is reached
   * only when no mark that is known matches the availability it has now and none records it: a mark batch whose
   * journal cannot be read, or an availability carrying `zotero` that no mark of this kind wrote (set by hand).
   */
  private restoreFor(sourceId: string, now: Availability): { to: Availability; marks: Array<{ batchId: string; after: Availability }> } {
    const c = this.markChain(sourceId, now);
    return { to: c.preMark ?? { status: "available" }, marks: c.marks };
  }

  private queue(e: JournalEntry, assets?: Asset[]): JournalEntry {
    const line = this.withNotes(e, assets);
    this.pending.push(line);
    return line;
  }

  /**
   * The journal line with the item's file notes, if it has any (R66), and its version (R72) with the parts of
   * its stored files (Z4; `assets`: the line's source as it stands after the change, see partsFor).
   */
  private withNotes(e: JournalEntry, assets?: Asset[]): JournalEntry {
    const notes = this.fileNotes.get(e.key);
    const v = WITH_VERSION.has(e.outcome) && e.sourceId ? this.versions.get(e.key) : undefined;
    const parts = v ? this.partsFor(v, e.sourceId!, assets) : undefined;
    const cols = v ? this.cols.get(e.key) : undefined;
    const colKeys = cols ? this.colKeys.get(e.key) : undefined;
    const ext = v ? { id: v.id, version: v.version, ...(parts ? { parts } : {}), ...(cols ? { cols } : {}), ...(colKeys ? { colKeys } : {}) } : undefined;
    if (ext) this.known.set(ext.id, { sourceId: e.sourceId!, version: ext.version, ...(parts ? { parts } : {}), ...(cols ? { cols } : {}), ...(colKeys ? { colKeys } : {}) });
    const dropped = e.outcome === "created" || e.outcome === "needs-review" ? this.annotationsDropped.get(e.key) : undefined;
    return { ...e, ...(notes?.length ? { notes } : {}), ...(ext ? { ext } : {}), ...(dropped ? { annotationsDropped: dropped } : {}) };
  }

  /**
   * Z4: the parts a journal line keeps (`ext.parts`). A part is kept only when the source holds an asset
   * entry with its hash: a file downloaded and stored, or dropped by its hash as already there, or a known file
   * not downloaded again; a file the researcher destroyed here (retention) keeps its entry, so its part is
   * carried and it is never brought back. A download the engine did not store (an unsupported file, the same
   * file as another item), a part whose asset entry is gone (the batch that added it was undone, I1) and a known
   * part under another source are left out: the next run downloads that file. Without `assets` (no caller
   * today), only parts carried unchanged for the same source are kept.
   */
  private partsFor(v: NonNullable<ScanItem["version"]>, sourceId: string, assets: Asset[] | undefined): Parts | undefined {
    if (!v.parts) return undefined;
    const prev = this.known.get(v.id);
    const carried = prev && prev.sourceId === sourceId ? prev.parts : undefined;
    const out: Parts = {};
    let any = false;
    for (const [att, p] of Object.entries(v.parts)) {
      if (!p || !Number.isInteger(p.v) || typeof p.sha256 !== "string") continue;
      const was = carried && Object.hasOwn(carried, att) ? carried[att] : undefined;
      const keep = assets ? assets.some((a) => a.sha256 === p.sha256) : was !== undefined && was.v === p.v && was.sha256 === p.sha256;
      if (!keep) continue;
      out[att] = { v: p.v, sha256: p.sha256 };
      any = true;
    }
    return any ? out : undefined;
  }

  /**
   * Z4 (ScanContext.fileKnown): the stored file's hash when (1) the newest journal line of this kind (batches
   * not undone) says the attachment was stored at this version, (2) the line's source is still here, and (3)
   * that source still holds an asset entry with that hash (the index's assets table: every asset entry, a file
   * destroyed here included; I1). A line of an undone batch is never read; a part that a later line carried
   * after the batch that added the file was undone names an entry that is gone, so the file is downloaded as
   * any missing file is. A source deleted here is not known, unless the item is to stay deleted (R73, no
   * `includeDeleted`): then its file is not needed either. Anything the index cannot confirm downloads.
   */
  private fileKnown(versionId: string, attKey: string, attVersion: number): { sha256: string } | undefined {
    const k = this.known.get(versionId);
    const p = k?.parts && Object.hasOwn(k.parts, attKey) ? k.parts[attKey] : undefined;
    if (!k || !p || p.v !== attVersion || typeof p.sha256 !== "string") return undefined;
    if (!hasSource(this.repo, this.projectId, k.sourceId)) {
      // M1: an item deleted here that this run will report as deleted-here needs no file (its Zotero key is the
      // last segment of its version id, `<ref>/<key>`, as the adapter makes it).
      const zk = versionId.slice(versionId.lastIndexOf("/") + 1);
      return zk && !this.rec.options.includeDeleted && this.deletedHere(zk) ? { sha256: p.sha256 } : undefined;
    }
    return this.hasAssetEntry(k.sourceId, p.sha256) ? { sha256: p.sha256 } : undefined;
  }

  /** Whether the index holds an asset entry (any status) of this source with this hash (Z4, I1); false when it cannot say. */
  private hasAssetEntry(sourceId: string, sha256: string): boolean {
    try {
      this.assetEntry ??= this.deps.index.db.prepare(
        "SELECT 1 FROM main.assets WHERE source_id = ? AND sha256 = ? UNION ALL SELECT 1 FROM temp.t_assets WHERE source_id = ? AND sha256 = ? LIMIT 1",
      );
      return this.assetEntry.get(sourceId, sha256, sourceId, sha256) !== undefined;
    } catch {
      return false;
    }
  }
  private assetEntry: { get(...params: unknown[]): unknown } | undefined;

  /**
   * Z4: a known file (its part carried from the previous line, not downloaded in this run) whose asset entries
   * in the source are all destroyed (retention): the researcher took it away here (I1: the source's own record
   * says so). It was not downloaded and is not brought back; the item says so (a file note) and the run counts
   * it. A part whose entry is simply absent is not a removal (only an undo removes an entry): that file is
   * downloaded, and this says nothing.
   */
  private noteRemoved(item: ScanItem, sourceId: string, assets: Asset[]): void {
    const v = item.version;
    const prev = v ? this.known.get(v.id) : undefined;
    if (!v?.parts || !prev?.parts || prev.sourceId !== sourceId) return;
    let n = 0;
    for (const [att, p] of Object.entries(v.parts)) {
      const was = Object.hasOwn(prev.parts, att) ? prev.parts[att] : undefined;
      if (!was || was.v !== p.v || was.sha256 !== p.sha256) continue; // not the known part
      const entries = assets.filter((a) => a.sha256 === p.sha256);
      if (entries.length && entries.every((a) => a.status === "destroyed")) n++;
    }
    if (n) this.fileNotes.set(item.key, [...(this.fileNotes.get(item.key) ?? []), ...Array<string>(n).fill(ENGINE_FILE_NOTES.removedHere)]);
  }

  /**
   * Task Z6 (Zotero Web, Accept 4): the item's collection paths that are NEW in Zotero since the newest journal line
   * of it (`known.cols`): only those are added on update. A membership the researcher removed here was in that line
   * too, so it is not new and never comes back; one Zotero removed is simply not here any more (nothing is removed
   * here). A line without `cols` (written before Z6) knows none: nothing is new (none is added; the run's own line
   * then records them). Nothing either when the batch maps no structure. In memory only.
   */
  private newMemberships(item: ScanItem, k: Known | undefined = item.version ? this.known.get(item.version.id) : undefined): string[][] {
    if (!this.zoteroWeb || this.rec.options.structure === "none" || !k?.cols) return [];
    const had = new Set(k.cols.map(pathKey));
    return itemPaths(item).filter((p) => !had.has(pathKey(hashPath(p))));
  }

  /**
   * Task Z6 (R236 f): the collections renamed in Zotero, as this item shows them: a Zotero collection KEY on one of its
   * paths now that the item's last line knew under another name. Each by the hash of its key (the journal holds no
   * name), counted once over the batch. A move to a new collection beside the old one is a new key: not a rename. Only
   * when this run adds a membership (the new name arrives as a new collection here; the old one is kept), collections
   * mode only, and only when both lines carry keys.
   */
  private renamedBy(item: ScanItem, k: Known | undefined, added: string[][]): string[] {
    const nowKeys = this.colKeys.get(item.key);
    if (this.rec.options.structure !== "collections" || !k?.cols || !k.colKeys || !nowKeys || !added.length) return [];
    const had = new Map<string, string>();
    k.colKeys.forEach((path, i) => path.forEach((key, j) => had.set(key, k.cols![i]![j]!)));
    const out = new Set<string>();
    itemPaths(item).forEach((path, i) =>
      path.forEach((name, j) => {
        const key = nowKeys[i]![j]!;
        const before = had.get(key);
        if (before !== undefined && before !== collectionHash(name)) out.add(collectionHash(`key:${key}`));
      }),
    );
    return [...out];
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
    const out: Prepared = { inputs: [], shas: [], kept: [], names: [], mime: "", dropped: [], copiedLinks: 0, realOf: new Map(), shaOf: new Map(), plan: { located: false, proxies: [] }, copyBytes: 0 };
    for (const f of item.files) {
      const st = await fsp.stat(f.path).catch(() => null);
      if (!st?.isFile()) {
        out.dropped.push({ note: ENGINE_FILE_NOTES.vanished, reason: REASONS.missing });
        continue;
      }
      // From here on the file is read through its checked real path (R70 I-2).
      const checked = this.outside ? await this.outside.check(f.path) : { real: await fsp.realpath(f.path).catch(() => resolve(f.path)), ok: true };
      const real = checked.real;
      // R362 c: never a file of the library's own folder, whatever was approved (before it is read).
      if (await this.inLibrary(f, real)) {
        out.dropped.push({ note: ENGINE_FILE_NOTES.inLibrary, reason: IN_LIBRARY_TEXT.file });
        continue;
      }
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
      if (handling === "copy") out.copyBytes += st.size;
    }
    if (out.copyBytes) await this.roomFor(out.copyBytes);
    return out;
  }

  /**
   * R413 b: before an item's files are copied into the library, the free room on its disk must be at least their size
   * (with the files of the items queued in the current group, not stored yet) plus FILE_MARGIN; otherwise the batch
   * stops (NoRoomError, a full disk) before anything of the item is written. A disk that cannot tell passes.
   */
  private async roomFor(bytes: number): Promise<void> {
    const queued = this.group.reduce((n, q) => n + q.prep.copyBytes, 0);
    if ((await freeRoom(repoLibrary(this.repo).root)) < queued + bytes + fileMargin()) throw new NoRoomError();
  }

  /** Whether this project refuses linking in place (R24), asked once per run. */
  private linkRefusedCache: Promise<boolean> | null = null;
  private linkRefused(): Promise<boolean> {
    this.linkRefusedCache ??= preflightLink(this.repo, this.projectId);
    return this.linkRefusedCache;
  }

  /**
   * R366 b: whether the item's resolution carries a BibTeX doubt (its export's, or a sidecar's). Such a
   * record is never merged into an existing source, whatever the way with duplicates: it is created as
   * its own record, waiting in the review queue with its doubt (and as a likely duplicate).
   */
  private static doubted(r: Resolution): boolean {
    return r.verification.reasons.some((x) => BIB_DOUBT_SET.has(x));
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
        ...(item.doubts?.length ? { doubts: item.doubts } : {}),
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
        if (Run.doubted(r)) return this.create(item, r, prep, method, reviewFor(r, dup, opts.autoAcceptThreshold), dedupe);
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
      if (st?.isFile() && r !== null && !(await this.inLibrary({ path: f.path }, r)) && (!this.outside || (await this.outside.check(f.path)).ok)) kept.push(f);
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
    // A doubted record is stored as planned: its own record, waiting for review (R366 b).
    if (how === "merge" && !Run.doubted(q.r)) return this.merge(q.item, dup.sourceId, q.r, q.prep, CAPTURE_METHOD[this.rec.source.kind], dedupe);
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
            const entry: JournalEntry = this.withNotes({ key: q.item.key, outcome: q.reviewItem ? "needs-review" : "created", sourceId: sf.source.id, ...(files ? { files } : {}) }, sf.assets);
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
      // R413 b: a full disk stops the batch; the group's items keep no line (a resume takes them up again), and are
      // not retried one by one (each would fail the same way).
      if (err instanceof ProjectLockedError || (err as Error)?.name === "AbortError" || isDiskFull(err) || err instanceof RecoveryPendingError) throw err;
      if (!(err instanceof PolicyDeniedError)) this.deps.debug?.(`bulk import group store failed, storing item by item: ${errorForLog(err)}`);
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
        entry = this.withNotes({ key: item.key, outcome, sourceId: created.source.id, ...(files ? { files } : {}) }, created.assets);
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
                toAnnotation(
                  a,
                  sourceId,
                  actor,
                  (file) => {
                    const real = prep.realOf.get(file);
                    const i = real ? inputs.findIndex((f) => f.path === real) : -1;
                    return i >= 0 ? assets[i] : undefined;
                  },
                  (sha) => assets.find((x) => x.sha256 === sha),
                ),
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

  /**
   * R196: an item Zotero did not change still gets the sort index its annotations lack (imported before it was kept).
   * Null when there is nothing to fill (the common case: one read of the source, nothing written) or the write is
   * refused (the item then stays "unchanged"). The source is not marked modified; it is reported as unchanged; the
   * batch's undo restores the earlier anchors.
   */
  private async backfillOnly(item: ScanItem, sourceId: string, read?: SourceFile): Promise<JournalEntry | null> {
    // Cost (R197, accepted for now): every Zotero highlight has a sort index, so this guard cannot tell a source that
    // still needs the back-fill from one that has had it; each unchanged, highlighted item costs one source read per
    // re-import. To be revisited when the automatic Zotero sync is planned. (`read`: the source already read, Z4.)
    if (!item.annotations?.some((a) => a.anchor?.kind === "pdf" && a.anchor.sortIndex)) return null;
    try {
      const target = read ?? (await this.repo.getSource(this.projectId, sourceId));
      if (!planBackfill(target, item.annotations).length) return null;
      await this.flush(); // the source may be in the current group
      const out = await this.changeSource(
        item,
        sourceId,
        [storeRequest(target.source.provenance, false)],
        "import.update",
        async (_ops, cur) => {
          const bf = planBackfill(cur, item.annotations ?? []);
          const record: MergeRecord = { addedAssetIds: [], filled: [], addedEvidence: [], ...(bf.length ? { updatedAnnotations: bf } : {}) };
          if (!bf.length) return { next: null, record, outcome: "unchanged" };
          const replaced = new Map(bf.map((u) => [u.after.id, u.after]));
          return { next: { ...cur, annotations: cur.annotations.map((a) => replaced.get(a.id) ?? a) }, record, outcome: "unchanged" };
        },
      );
      return out.entry;
    } catch (err) {
      if (err instanceof PolicyDeniedError) return null;
      throw err;
    }
  }

  private async updateInner(item: ScanItem, sourceId: string): Promise<JournalEntry> {
    const method = CAPTURE_METHOD[this.rec.source.kind];
    const prep = await this.prepareFiles(item);
    this.addFileNotes(item, prep);
    const v = await this.revalidate(item, prep.inputs);
    const inputs = v.inputs;
    const target = await this.repo.getSource(this.projectId, sourceId);
    this.noteRemoved(item, sourceId, target.assets);
    const evSource = item.referenceSource ?? { kind: "refman" as const, ref: "reference" };
    const ref = item.referenceMetadata ?? {};
    const haveSha = new Set(target.assets.map((a) => a.sha256));
    const newInputs = inputs.filter((f) => !haveSha.has(prep.shaOf.get(f.path) ?? ""));
    // Z6 (Zotero Web): a field changed in Zotero and here becomes a conflict for the researcher, not a kept field.
    const conflicts = this.zoteroWeb;
    // R236 a (fix round 2): a field Zotero cleared is kept here (noted once, counted) by BOTH Zotero importers; the
    // conflicts above are the account sync's alone, as the plan says.
    const keepCleared = this.zoteroWeb || this.rec.source.kind === "zotero-local";
    const pre = planUpdate(target, ref, evSource, new Date().toISOString(), { conflicts, keepCleared });
    const preAnn = this.annotationPlan(item, target, prep, "");
    this.projectTags ??= await projectCollectionsAndTags(this.repo, this.projectId);
    const known = this.projectTags.tags;
    const newTags = (item.tags ?? []).some((n) => {
      const t = known.find((x) => x.name.toLowerCase() === n.toLowerCase());
      return !t || !target.source.tagIds.includes(t.id);
    });
    // Z6 (Accept 4): memberships new in Zotero since the last run, through the same structure machinery as creation
    // (collections found or made by name under their parents, or tags); nothing is removed.
    const prevKnown = item.version ? this.known.get(item.version.id) : undefined;
    const newPaths = this.newMemberships(item, prevKnown);
    const structCols: string[] = [];
    const structTags: string[] = [];
    for (const fp of newPaths) {
      const s = await this.structure(fp);
      structCols.push(...s.collectionIds);
      structTags.push(...s.tagIds);
    }
    const renamed = this.renamedBy(item, prevKnown, newPaths);
    const newStructure = structCols.some((c) => !target.source.collectionIds.includes(c)) || structTags.some((t) => !target.source.tagIds.includes(t));
    const kept = [...pre.kept, ...keptLabels(target, preAnn.kept)];
    const anything = pre.filled.length || pre.evidence.length || newInputs.length || preAnn.added.length || preAnn.updated.length || newTags || newStructure;
    // Z5: marked gone from Zotero and seen again as content: the mark goes (the availability before it comes back)
    // in this same change, before the rest of the update; with nothing else to update, the change is the mark's alone.
    const marked = target.source.availability.zotero !== undefined;
    const markOnly = marked && !anything && !preAnn.backfilled.length;
    if (!anything && !preAnn.backfilled.length && !marked) {
      return this.queue({ key: item.key, outcome: "unchanged", sourceId, ...(kept.length ? { merge: emptyRecord(kept) } : {}), ...(preAnn.dropped ? { annotationsDropped: preAnn.dropped } : {}), ...(preAnn.deletedHere ? { annotationsDeletedHere: preAnn.deletedHere } : {}) }, target.assets);
    }
    const tagIds = [...(await this.namedTags(item.tags, item.tagColors)), ...structTags];
    // New files may carry a location: location governance applies to them (R57; R74 I1; R83).
    const proxyPlan = await planProxies(newInputs, { all: this.adapter.viewingProxies === true });
    const located = proxyPlan.located;
    const rule = locationRule();
    let dropped = 0;
    let deletedHere = 0;
    /** R224 a: a back whose change also updated the item's content (counted as back and as updated). */
    let contentUpdated = false;
    /** Z6: fields this change put in conflict (journaled as `conflictsQueued`). */
    let conflicted = 0;
    /** R236 a: fields Zotero cleared, kept here (journaled as `clearedKept`). */
    let cleared = 0;
    const out = await this.changeSource(
      item,
      sourceId,
      // The mark's removal alone captures nothing: it is a store change to the source, as the mark was.
      markOnly ? [storeRequest(target.source.provenance, located)] : [{ action: "capture", capture: { method } }, storeRequest(target.source.provenance, located)],
      markOnly ? "import.zotero-mark" : "import.update",
      async (ops, cur) => {
        const back = cur.source.availability.zotero !== undefined ? this.restoreFor(cur.source.id, cur.source.availability) : undefined;
        const backTo = back?.to;
        const plan = planUpdate(cur, ref, evSource, ops.tx.at, { conflicts, keepCleared });
        const added = await this.addFiles(ops, cur, inputs);
        const merged = applyMerge(cur, added, plan.filled, plan.evidence, ops.tx.at, ops.tx.actor, tagIds);
        // Z6: the conflicts' own evidence (Zotero's value) is recorded with them, and taken off with them by undo.
        const inConflict = new Set(plan.conflicts.map((c) => c.path));
        const inCleared = new Set(plan.cleared);
        // Evidence of values that were already current is recorded too (not reverted by undo: it is true either way).
        const extraEvidence = plan.evidence.filter((e) => !plan.filled.some((f) => f.path === e.field) && !inConflict.has(e.field) && !inCleared.has(e.field));
        // R236 a: a field Zotero cleared stays here; the clearing is noted (its own evidence, taken off by undo) and counted.
        const clearedKept = plan.cleared.map((path) => ({ path, evidence: plan.evidence.filter((e) => e.field === path) }));
        const conflictRecords = plan.conflicts.map((c) => ({
          path: c.path,
          ...(cur.verification[c.path] ? { before: cur.verification[c.path] } : {}),
          after: conflictVerification(cur, c, evSource),
          evidence: plan.evidence.filter((e) => e.field === c.path),
        }));
        // Z6: memberships new in Zotero that the source is not in (re-read inside the change).
        const addedCollectionIds = [...new Set(structCols)].filter((c) => !cur.source.collectionIds.includes(c));
        const ann = this.annotationPlan(item, merged.next, prep, ops.tx.actor);
        dropped = ann.dropped;
        deletedHere = ann.deletedHere;
        const keptAll = [...plan.kept, ...keptLabels(merged.next, ann.kept)];
        const record: MergeRecord = {
          ...merged.record,
          ...(ann.added.length ? { addedAnnotationIds: ann.added.map((a) => a.id) } : {}),
          ...(ann.updated.length || ann.backfilled.length ? { updatedAnnotations: [...ann.updated, ...ann.backfilled] } : {}),
          ...(keptAll.length ? { kept: keptAll } : {}),
          // R224 b: the marks this back takes away, with their batches, and the availability before them all (its own
          // after), so that its undo never puts back a mark whose batch is undone.
          ...(back ? { availability: { before: cur.source.availability, after: back.to, preMark: back.to, marks: back.marks } } : {}),
          ...(conflictRecords.length ? { conflicts: conflictRecords } : {}),
          ...(addedCollectionIds.length ? { addedCollectionIds } : {}),
          ...(clearedKept.length ? { clearedKept } : {}),
        };
        const changed =
          plan.filled.length > 0 || added.length > 0 || ann.added.length > 0 || ann.updated.length > 0 || (record.addedTagIds?.length ?? 0) > 0 || extraEvidence.length > 0 || addedCollectionIds.length > 0;
        conflicted = conflictRecords.length;
        cleared = clearedKept.length;
        // Only a back-filled sort index (R195): written and recorded for undo, but reported as unchanged.
        if (!changed && !ann.backfilled.length && !backTo && !conflicted && !cleared) return { next: null, record, outcome: "unchanged" };
        const replaced = new Map([...ann.updated, ...ann.backfilled].map((u) => [u.after.id, u.after]));
        // A back-fill alone, or a conflict alone, leaves the source as it is (not marked modified, R196; Z6: the value
        // here is untouched, only Zotero's is recorded beside it).
        const base = changed ? merged.next : cur;
        const updated: SourceFile = this.withPendingProxies(
          item.key,
          {
            ...base,
            ...(addedCollectionIds.length ? { source: { ...base.source, collectionIds: [...base.source.collectionIds, ...addedCollectionIds] } } : {}),
            annotations: [...merged.next.annotations.map((a) => replaced.get(a.id) ?? a), ...ann.added],
            fieldEvidence: [...merged.next.fieldEvidence, ...extraEvidence, ...conflictRecords.flatMap((c) => c.evidence), ...clearedKept.flatMap((c) => c.evidence)],
            // Z6: each field in conflict is marked; writeSource then lists it in a pending capture-conflict entry in this
            // same change (R190, R193 b, R194) and the audit says which entry and field (`reviewQueued`), never a value.
            ...(conflicted ? { verification: { ...cur.verification, ...Object.fromEntries(conflictRecords.map((c) => [c.path, c.after])) } } : {}),
          },
          this.pendingForAdded(proxyPlan, newInputs, prep.shaOf, added, rule.mode()),
          rule.mode(),
        );
        // R236 d (R38): a filled field whose entry said "confirmed by you" for a value the researcher's own evidence no
        // longer matches gets its fresh status from the evidence (Zotero's newest value alone counts, R236 c); recorded so
        // that undo gives back the confirmed entry with the value.
        const reverified = this.reverify(cur, updated, plan.filled.map((f) => f.path));
        if (reverified.length) record.reverified = reverified;
        const verified: SourceFile = reverified.length ? { ...updated, verification: withEntries(updated.verification, reverified) } : updated;
        // Z5: the availability before the mark, and nothing more of its own (not a modification of the source).
        const next: SourceFile = backTo ? { ...verified, source: { ...verified.source, availability: backTo } } : verified;
        contentUpdated = !!backTo && changed;
        return { next, record, outcome: backTo ? "zotero-back" : changed ? "updated" : conflicted ? "zotero-conflict" : "unchanged" };
      },
      () => ({
        ...(dropped ? { annotationsDropped: dropped } : {}),
        ...(deletedHere ? { annotationsDeletedHere: deletedHere } : {}),
        ...(contentUpdated ? { contentUpdated: true as const } : {}),
        ...(conflicted ? { conflictsQueued: conflicted } : {}),
        ...(cleared ? { clearedKept: cleared } : {}),
        ...(renamed.length ? { renamedCollections: renamed } : {}),
      }),
      rule.hook,
      marked ? { marked: "back" } : undefined,
    );
    this.startProxies(out.sf);
    return out.entry;
  }

  /**
   * R236 d (R38): of the fields an update filled, those whose stored entry is `user-confirmed` while the fresh check of
   * the updated source does not reach user-confirmed (the researcher's own evidence names another value): each with its
   * entry before and the fresh one after (absent when the fresh check has none). Any adapter: "confirmed" is never left
   * on a value the researcher did not confirm.
   */
  private reverify(cur: SourceFile, next: SourceFile, filled: string[]): NonNullable<MergeRecord["reverified"]> {
    const stale = filled.filter((p) => cur.verification[p]?.status === "user-confirmed");
    if (!stale.length) return [];
    const fresh = recheckSourceFile(next, {}).verification;
    const out: NonNullable<MergeRecord["reverified"]> = [];
    for (const path of stale) {
      if (fresh[path]?.status === "user-confirmed") continue;
      out.push({ path, before: cur.verification[path]!, ...(fresh[path] ? { after: fresh[path] } : {}) });
    }
    return out;
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
    fn: (ops: Parameters<Parameters<typeof importChange>[3]>[0], cur: SourceFile) => Promise<{ next: SourceFile | null; record: MergeRecord; outcome: "merged" | "updated" | "unchanged" | "zotero-gone" | "zotero-back" | "zotero-conflict" }>,
    /** More fields for the journal line, known once `fn` ran. */
    extra: () => Partial<JournalEntry> = () => ({}),
    /** Watches the decision (the location rule, R83); never refuses. */
    refuse?: (d: PolicyDecision, req: Parameters<typeof evaluate>[1]) => string | undefined,
    /** More details for the change's audit event (kinds and counts only, R177; Z5's `marked`). */
    audit?: Record<string, unknown>,
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
          entry = this.withNotes({ key: item.key, outcome: r.outcome, sourceId: targetId, mergedInto: targetId, snapshot: snapshotRel, merge: r.record, ...(files ? { files } : {}), ...extra() }, r.next.assets);
        } else {
          entry = this.withNotes({ key: item.key, outcome: r.outcome, sourceId: targetId, ...(r.record.kept?.length ? { merge: r.record } : {}), ...extra() }, cur.assets);
        }
        await appendJournal(tx, projectRel, this.rec.dir, [...this.pending.slice(0, flush), entry]);
        return r.next ?? cur;
      },
      { op, entity: { type: "source", id: targetId }, ...(refuse ? { refuse } : {}), ...(audit ? { auditDetails: audit } : {}) },
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
      toAnnotation(
        a,
        sf.source.id,
        actor,
        (file) => {
          const real = prep.realOf.get(file);
          const sha = real ? prep.shaOf.get(real) : undefined;
          return sha ? sf.assets.find((x) => x.sha256 === sha) : undefined;
        },
        // Z4: a file not downloaded again is found by its stored hash, exactly as a downloaded copy's hash finds it.
        (sha) => sf.assets.find((x) => x.sha256 === sha),
      ),
    );
  }
}

/** What a researcher reads for an imported annotation that was kept as changed here: its kind and page, never a Zotero key. */
function keptLabels(sf: SourceFile, keys: string[]): string[] {
  return keys.map((k) => {
    const a = sf.annotations.find((x) => x.externalKey === k);
    if (!a) return "an annotation (changed here, kept)";
    const page = a.pageLabel ?? a.anchors.find((x) => x.kind === "pdf")?.page;
    const word = a.kind === "ink" ? "drawing" : a.kind === "image" ? "marked area" : a.kind;
    return `${word}${page !== undefined ? ` on page ${page}` : ""} (changed here, kept)`;
  });
}

const DELETED_NOTE = /^\d+ items? you deleted here (?:was|were) not re-imported/u;

/** Task Z5: the note on items deleted in Zotero (the scan's, and this one, which counts what was marked). */
const ZOTERO_DELETED_NOTE = /^(?:1 item you have here was|\d+ items you have here were) deleted in Zotero since the last sync; /u;
export const zoteroDeletedNote = (n: number) =>
  n === 1
    ? "1 item you have here was deleted in Zotero since the last sync; it was kept here and marked."
    : `${n} items you have here were deleted in Zotero since the last sync; they were kept here and marked.`;

/** Task Z5: per source, the availability changes its "gone from Zotero" marks made, oldest first. */
type Marks = Map<string, Array<MarkRecord & { batchId: string }>>;
const deletedNote = (n: number) =>
  `${n} ${n === 1 ? "item you deleted here was" : "items you deleted here were"} not re-imported (choose "include deleted items" to import ${n === 1 ? "it" : "them"} again).`;

/** A merge record that changes nothing and only lists fields kept (R72). */
const emptyRecord = (kept: string[]): MergeRecord => ({ addedAssetIds: [], filled: [], addedEvidence: [], kept });

/** Outcomes whose journal line records the item's version (R72). */
const WITH_VERSION = new Set(["created", "needs-review", "merged", "updated", "unchanged", "zotero-gone", "zotero-back", "zotero-conflict"]);

/**
 * Incremental import (R72): for each item identity, the source and version token recorded by the
 * newest journal line of the project's batches of this kind that were not undone. With `marks` (Z5), also each
 * source's "gone from Zotero" marks, oldest first, from the same lines.
 */
async function knownVersions(repo: Repo, projectId: string, kind: ImportBatch["source"]["kind"], marks?: Marks): Promise<Map<string, Known>> {
  const out = new Map<string, Known>();
  for (const d of await batchDirs(repo, projectId)) {
    let rec: BatchRecord | undefined;
    try {
      rec = await readBatchAt(repo, projectId, d.name);
    } catch {
      continue;
    }
    if (!rec || rec.source.kind !== kind || rec.state === "undone") continue;
    for (const e of await readJournal(repo, projectId, rec.dir)) {
      if (marks && e.outcome === "zotero-gone" && e.sourceId && e.merge?.availability) {
        const list = marks.get(e.sourceId) ?? [];
        list.push({ ...e.merge.availability, batchId: rec.id });
        marks.set(e.sourceId, list);
      }
      if (!e.ext || !e.sourceId) continue;
      // The newest line decides, its parts too (Z4): a line without parts (written before Z4) knows no file.
      const parts = readParts(e.ext.parts);
      // Z6: and the collections Zotero had it in (a line written before Z6, or of another kind, has none: unknown).
      const cols = readCols(e.ext.cols);
      const colKeys = readColKeys(e.ext.colKeys, cols);
      out.set(e.ext.id, { sourceId: e.sourceId, version: e.ext.version, ...(parts ? { parts } : {}), ...(cols ? { cols } : {}), ...(colKeys ? { colKeys } : {}) });
    }
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
  /**
   * Package-internal. Device import (R83): the session and participants every new source is linked to (checked by
   * the caller). The Zotero sync runner (Task Z7, R242): `origin`, written into the record at its creation (and so
   * kept by every resume, which reads the record), by which the runner knows its own unfinished batches.
   */
  internal: { fieldwork?: { sessionId?: string; participantIds?: string[] }; origin?: "zotero-sync" } = {},
): Promise<BatchHandle> {
  // The id is in the running set before anything is awaited (R61).
  const id = newId();
  active.add(id);
  try {
    await refuseLibrarySource(deps.repo, adapter);
    const { approveOutside, ...options } = acceptOptions(input);
    deps.repo.getProject(projectId); // NotFoundError for an unknown project, before its disk is asked
    // R413 a: before anything is evaluated or written (a refusal leaves nothing, not even an audited decision).
    const reserve = await preflightSpace(deps.repo, projectId, adapter, options);
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
      ...(internal.origin === "zotero-sync" ? { origin: "zotero-sync" as const } : {}),
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
    const run = new Run(deps, projectId, rec, adapter, [], new Map(), reserve);
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
    await refuseLibrarySource(deps.repo, source);
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
        ...(r.origin === "zotero-sync" ? { origin: r.origin } : {}),
        ...(r.source.kind === "zotero-web" && typeof r.source.location === "string" ? { ref: r.source.location } : {}),
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
 * R413 a: what the dry run says of the room: the bytes a batch with the default options would copy, the free room on
 * the library's disk and, when they do not fit (with the margin and a Zotero local import's database copy), the
 * sentence the start would be refused with. The scan's numbers are remembered for a start from the same source.
 */
async function spaceOfScan(repo: Repo, projectId: string, adapter: ImportSourceAdapter, summary: ScanSummary, linkedBytes: number): Promise<void> {
  rememberScan(projectId, adapter, { totalBytes: summary.totalBytes, linkedBytes });
  const linkRefused = await preflightLink(repo, projectId);
  const copy = Math.max(0, summary.totalBytes - (linkRefused ? 0 : linkedBytes));
  summary.copyBytes = copy;
  const free = await freeRoom(repoLibrary(repo).root);
  if (!Number.isFinite(free)) return;
  summary.freeBytes = free;
  const db = adapter.kind === "zotero-local" ? await zoteroCopyBytes(zoteroDataDir(adapter.location)) : 0;
  if (copy && copy + spaceMargin(copy) + db > free) summary.spaceWarning = fitSentence(copy, free, !linkRefused && !COPY_ONLY_KINDS.has(adapter.kind));
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
  await refuseLibrarySource(repo, adapter);
  await dryRunPolicy(repo, projectId, adapter.kind);
  const dedupe = new BatchDedupe(deps.index.db, projectId, (id) => hasSource(repo, projectId, id));
  const summary: ScanSummary = { items: 0, byType: {}, totalBytes: 0, likelyDuplicates: 0, alreadyImported: 0, unreadable: [], notes: [], outsideFiles: [], linkedFiles: 0 };
  const name = `batch-dry-${newId()}`;
  const dir = join(repoLibrary(repo).root, ".tmp", name);
  let made = false;
  const seenSha = new Set<string>();
  const seenIds = new Set<string>();
  let linkedBytes = 0;
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
      reserveBytes: spaceMargin(0),
    });
    // The approvals the batch would be given count here too (kept in memory only, under a throwaway secret).
    const secret = randomBytes(32).toString("hex");
    const policy = await OutsidePolicy.create(adapter.roots, [dir, ...(await approvedFolders(repoLibrary(repo)))], secret, await approvalHashes(secret, opts.approveOutside));
    const inLibrary = await libraryFileTest(repo, dir, adapter.kind);
    for await (const scanned of scan) {
      let item = scanned;
      if (item.gone) continue; // gone at its source: nothing to import
      summary.items++;
      if (item.unreadable) {
        summary.unreadable.push({ path: item.key, reason: item.unreadable });
        continue;
      }
      // R362 c: a file inside the library's own folder is left out whatever is approved, as the batch will (not read).
      if (item.files.length) {
        const kept: ScanItem["files"] = [];
        for (const x of item.files) if (!(await inLibrary(x, await realOrNearest(x.path)))) kept.push(x);
        if (kept.length < item.files.length) {
          if (!item.referenceMetadata && !kept.length) {
            summary.unreadable.push({ path: item.key, reason: IN_LIBRARY_TEXT.file });
            continue;
          }
          if (!summary.notes.includes(IN_LIBRARY_TEXT.file)) summary.notes.push(IN_LIBRARY_TEXT.file);
          item = { ...item, files: kept };
        }
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
      for (const x of item.files) {
        const b = (await fsp.stat(x.path).catch(() => null))?.size ?? x.bytes;
        bytes += b;
        if (x.link === true) linkedBytes += b;
      }
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
    await spaceOfScan(repo, projectId, adapter, summary, linkedBytes);
  } finally {
    if (made) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
  return summary;
}
