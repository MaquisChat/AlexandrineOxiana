/**
 * An import batch's files (spec 3.8, R31): `<Project>/imports/batch-<NNNN>/`
 *
 *   batch.json      the ImportBatch record plus state, created ids, notes and governance decisions
 *   journal.jsonl   one line per finished item `{ key, outcome, sourceId?, reason?, mergedInto?, snapshot?, merge? }`; a review decision adds a later line for the item
 *   snapshots/      pre-merge copies of merged sources' source.json (a record; undo uses the journal's merge records)
 *   report.md/.json the import report
 *
 * In encrypted projects every file is encrypted (`.enc`) and every journal line is sealed with the
 * project key, the way profile capture writes them (Task 18), so nothing about the items sits in
 * plaintext. Unencrypted files are owner-only (0600). The index holds no batch data: these files
 * are the record.
 */
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { ImportBatch, encName, type PolicyDecision } from "@ao/core";
import type { MergeRecord } from "./merge.js";
import { decryptBytes, namesIn, openLine, readMaybe, sealLine } from "../../repo/io.js";
import type { MutateRequest, Tx } from "../../repo/mutate.js";
import { projectDataKey, repoLibrary, type Repo } from "../../repo/repo.js";

/** Batches running (or being undone) in this process (a `running` batch.json not listed here was interrupted, R45). */
export const activeBatches = new Set<string>();

/** Runs in progress that want to hear about review decisions on their items (keeps their counts current). */
export const runListeners = new Map<string, (line: JournalEntry) => void>();

/** The key a batch's sources carry for an item (R63): HMAC-SHA256 of the item key, never the key itself. */
export function itemKeyHash(secret: string, key: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(key, "utf8").digest("hex");
}

export const JOURNAL_PURPOSE = "ao-import-journal";
/** Batch bookkeeping is organizing data (like collections): no identifiable data of its own. */
export const BOOKKEEPING: MutateRequest = { action: "store", store: { identifiable: false, hasLocation: false } };
export const PRIVATE_MODE = 0o600;

export type BatchState = "running" | "paused" | "cancelled" | "finished" | "failed" | "undone";
/** As shown: a `running` batch no process is running is `interrupted` (R45). */
export type ShownState = BatchState | "interrupted";

/** `updated` / `unchanged`: incremental re-import of an item imported before (R72). */
export type ItemOutcome = "created" | "needs-review" | "duplicate" | "merged" | "updated" | "unchanged" | "deleted-here" | "failed" | "incomplete";

export interface JournalEntry {
  key: string;
  outcome: ItemOutcome | string;
  sourceId?: string;
  reason?: string;
  /** Merges: the existing source the item was merged into, and the pre-merge snapshot (project-relative). */
  mergedInto?: string;
  snapshot?: string;
  reviewId?: string;
  /** A review decision taken later (decideReview): this line then supersedes the item's outcome. */
  decision?: string;
  /** Merges: what the merge added (reverted exactly by undo, R61). */
  merge?: MergeRecord;
  /** The item's file notes (ScanItem.fileNotes; never a path), for the report. */
  notes?: string[];
  /**
   * Incremental import (R72): the item's identity at its source and the version token this line
   * brought the source to (created, merged, updated or unchanged). The newest such line of a batch
   * that was not undone is what a re-import compares with.
   */
  ext?: { id: string; version: string };
  /** Zotero item keys this line's deletion recorded as deleted here (review skip/merge); undo takes them back (R74 I3). */
  tombstoned?: string[];
  /** Annotations of the item left out over the per-source limit (R74 I4). */
  annotationsDropped?: number;
  /** The files this line stored: copied into the library, or left as links (R136; for the report). */
  files?: { copied: number; linked: number };
}

/** A journal line's `files`, from whether each stored file is a link; undefined when none was stored. */
export function fileCounts(isLink: boolean[]): JournalEntry["files"] {
  if (!isLink.length) return undefined;
  const linked = isLink.filter(Boolean).length;
  return { copied: isLink.length - linked, linked };
}

export interface GovernanceNote {
  action: string;
  result: PolicyDecision["result"];
  reason?: string;
  conditions?: unknown[];
  /** Items this applied to (per-item denies). */
  items?: number;
}

export interface BatchRecord extends ImportBatch {
  state: BatchState;
  /** Batch folder, relative to the project folder (`imports/batch-0001`). */
  dir: string;
  createdSourceIds: string[];
  createdCollectionIds: string[];
  createdTagIds: string[];
  governance: GovernanceNote[];
  /** Plain-language notes for the report (pattern timeouts, OCR not available, ...). */
  notes: string[];
  /** Total items, when the source could count them. */
  total?: number;
  ocrQueued?: number;
  /**
   * 32 random bytes (hex) for this batch: new sources carry HMAC-SHA256(secret, item key) as their
   * item key, so paths from the import's root never enter source.json or the change log (R63).
   * Sealed with batch.json in encrypted projects.
   */
  secret?: string;
  /** Files approved outside the source's folders (R67): HMACs of their real paths, never the paths. */
  outsideApprovals?: string[];
  /** Zotero item keys whose deletion records this batch cleared (includeDeleted); undo puts them back (R74 I3). */
  clearedDeletions?: string[];
  /** Profile capture (Task 18): counts detail. */
  countsDetail?: Record<string, number>;
  /** Device import (R83): the session and participants every new source is linked to. */
  fieldwork?: { sessionId?: string; participantIds?: string[] };
  /** The adapter's resume options (ImportSourceAdapter.resumeOptions), e.g. device import's researcher name. */
  adapterOptions?: { researcherName?: string };
}

/** `<project folder>/imports`. */
export const importsRel = (projectRel: string) => `${projectRel}/imports`;

export function fileName(name: string, encrypted: boolean): string {
  return encrypted ? encName(name) : name;
}

/** Reads a project-relative file (decrypting it in encrypted projects); undefined when absent. */
export async function readProjectText(repo: Repo, projectId: string, rel: string): Promise<string | undefined> {
  const key = projectDataKey(repo, projectId);
  const root = repoLibrary(repo).root;
  const raw = await readMaybe(join(root, ...(key ? encName(rel) : rel).split("/")));
  if (!raw) return undefined;
  if (!key) return raw.toString("utf8");
  return (await decryptBytes((id) => (id === key.keyId ? key.key : undefined), raw)).toString("utf8");
}

/** The batch folders of a project, `batch-NNNN` names with their numbers, ascending. */
export async function batchDirs(repo: Repo, projectId: string): Promise<Array<{ name: string; number: number }>> {
  const projectRel = repo.getProject(projectId).folder;
  const abs = join(repoLibrary(repo).root, ...importsRel(projectRel).split("/"));
  return [...(await namesIn(abs))]
    .map((n) => ({ name: n, m: /^batch-(\d+)$/.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, number: Number(x.m![1]) }))
    .sort((a, b) => a.number - b.number);
}

/** Reads one batch.json (any batch kind; profile-capture records have no `dir`). */
export async function readBatchAt(repo: Repo, projectId: string, dirName: string): Promise<BatchRecord | undefined> {
  const projectRel = repo.getProject(projectId).folder;
  const text = await readProjectText(repo, projectId, `${importsRel(projectRel)}/${dirName}/batch.json`);
  if (!text) return undefined;
  const raw = JSON.parse(text) as Partial<BatchRecord>;
  return {
    ...(raw as BatchRecord),
    dir: `imports/${dirName}`,
    createdSourceIds: raw.createdSourceIds ?? [],
    createdCollectionIds: raw.createdCollectionIds ?? [],
    createdTagIds: raw.createdTagIds ?? [],
    governance: raw.governance ?? [],
    notes: raw.notes ?? [],
    state: (raw.state ?? "finished") as BatchState,
  };
}

/** Finds a batch by id among the project's batch folders. */
export async function findBatch(repo: Repo, projectId: string, batchId: string): Promise<BatchRecord | undefined> {
  for (const d of (await batchDirs(repo, projectId)).reverse()) {
    try {
      const r = await readBatchAt(repo, projectId, d.name);
      if (r?.id === batchId) return r;
    } catch {
      // an unreadable batch record is not this one
    }
  }
  return undefined;
}

/** Writes batch.json inside a running change. */
export async function writeBatchRecord(tx: Tx, projectRel: string, rec: BatchRecord): Promise<void> {
  const dir = `${projectRel}/${rec.dir}`;
  await tx.mkdir(dir);
  const { dir: _d, ...body } = rec;
  ImportBatch.parse(body); // fail loud on a malformed record
  await tx.writeFile(`${dir}/${fileName("batch.json", tx.encrypted)}`, JSON.stringify(body, null, 2), {
    encrypt: tx.encrypted,
    ...(tx.encrypted ? {} : { mode: PRIVATE_MODE }),
  });
}

/** Appends journal lines inside a running change (sealed in encrypted projects). */
export async function appendJournal(tx: Tx, projectRel: string, dir: string, entries: JournalEntry[]): Promise<void> {
  for (const e of entries) {
    const json = JSON.stringify(e);
    const line = tx.encrypted ? sealLine(tx.key().key, tx.key().keyId, tx.projectId, json, JOURNAL_PURPOSE) : json;
    await tx.appendLine(`${projectRel}/${dir}/journal.jsonl`, line, tx.encrypted ? {} : { mode: PRIVATE_MODE });
  }
}

/** Every journal line of a batch, in order (unreadable lines skipped). */
export async function readJournal(repo: Repo, projectId: string, dir: string): Promise<JournalEntry[]> {
  const projectRel = repo.getProject(projectId).folder;
  const raw = await readMaybe(join(repoLibrary(repo).root, ...`${projectRel}/${dir}/journal.jsonl`.split("/")));
  if (!raw) return [];
  const key = projectDataKey(repo, projectId);
  const out: JournalEntry[] = [];
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const json = key ? openLine(key.key, projectId, line, JOURNAL_PURPOSE) : line;
      const e = JSON.parse(json) as JournalEntry;
      if (typeof e?.key === "string") out.push(e);
    } catch {
      // torn or foreign line
    }
  }
  return out;
}

/** The newest journal line per key (a later review decision supersedes the run's outcome). */
export function latestByKey(entries: JournalEntry[]): Map<string, JournalEntry> {
  const m = new Map<string, JournalEntry>();
  for (const e of entries) m.set(e.key, e);
  return m;
}

/** Counts by outcome over the newest line per key (a review decision's line supersedes the run's). */
export function countOutcomes(latest: Iterable<JournalEntry>): {
  created: number;
  needsReview: number;
  duplicates: number;
  merged: number;
  updated: number;
  unchanged: number;
  deletedHere: number;
  failed: number;
  items: number;
} {
  const c = { created: 0, needsReview: 0, duplicates: 0, merged: 0, updated: 0, unchanged: 0, deletedHere: 0, failed: 0, items: 0 };
  for (const e of latest) {
    c.items++;
    if (e.outcome === "created" || e.outcome === "incomplete") c.created++;
    else if (e.outcome === "needs-review") c.needsReview++;
    else if (e.outcome === "duplicate" || e.outcome === "skipped") c.duplicates++;
    else if (e.outcome === "merged") c.merged++;
    else if (e.outcome === "updated") c.updated++;
    else if (e.outcome === "unchanged") c.unchanged++;
    else if (e.outcome === "deleted-here") c.deletedHere++;
    else if (e.outcome === "failed") c.failed++;
  }
  return c;
}
