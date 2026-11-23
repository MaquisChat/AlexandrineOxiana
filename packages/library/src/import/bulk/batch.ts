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
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { ImportBatch, encName, type PolicyDecision } from "@ao/core";
import type { MergeRecord } from "./merge.js";
import { decryptBytes, namesIn, openLine, readMaybe, sealLine } from "../../repo/io.js";
import type { MutateRequest, Tx } from "../../repo/mutate.js";
import { projectDataKey, repoLibrary, type Repo } from "../../repo/repo.js";
import { KeyNotAvailableError } from "../../crypto/format.js";
import { isLockedRefusal } from "../../repo/errors.js";

/** Batches running (or being undone) in this process (a `running` batch.json not listed here was interrupted, R45). */
export const activeBatches = new Set<string>();

/**
 * R413 b, c: the stopping note of a batch whose record could not be saved when it stopped (the disk still full, or a
 * project that refuses every write), by batch id. In memory only: the report shows it until the record is saved again.
 */
export const unsavedStops = new Map<string, string>();

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

/**
 * `updated` / `unchanged`: incremental re-import of an item imported before (R72). Zotero (Task Z5):
 * `zotero-gone` an item deleted in Zotero or in its bin whose source here was marked (or already was, the same
 * way: counted only); `zotero-gone-unmarked` one that has no source of its own here to mark (deleted here, or
 * only merged into another source); `zotero-back` a marked item seen again, its earlier availability restored.
 * Task Z6: `zotero-conflict` an item whose only change was to put fields in conflict (changed in Zotero AND here):
 * Zotero's value recorded as evidence beside the researcher's, the field marked, the review queue told; nothing of
 * the researcher's replaced. (An item that also took in other changes is `updated`, with `conflictsQueued`.)
 */
export type ItemOutcome =
  | "created"
  | "needs-review"
  | "duplicate"
  | "merged"
  | "updated"
  | "unchanged"
  | "deleted-here"
  | "failed"
  | "incomplete"
  | "zotero-gone"
  | "zotero-gone-unmarked"
  | "zotero-back"
  | "zotero-conflict";

export interface JournalEntry {
  key: string;
  outcome: ItemOutcome | string;
  sourceId?: string;
  reason?: string;
  /**
   * R393 a: a `failed` line of an unexpected error: what kind it was — the system's code (`EMFILE`, `SQLITE_BUSY`) or
   * the error's class (`TypeError`); never its message or a path.
   */
  cause?: string;
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
  ext?: {
    id: string;
    version: string;
    /**
     * Zotero Web (Task Z4): the attachments whose file this line's source holds, by key: the attachment's
     * version and the SHA-256 of the asset it became (ScanItem.version.parts, kept only for files actually
     * stored, or known and carried forward). Absent in lines written before Z4: their files are downloaded
     * once more and dropped by their hash, after which the line has parts.
     */
    parts?: Record<string, { v: number; sha256?: string }>;
    /**
     * Zotero Web (Task Z6): the collections Zotero had the item in when this line was written, each as the list of
     * its path's names, every name as a short hash (`collectionHash`; never the name). The next run adds only the
     * memberships that are not here: those new in Zotero since. Absent in lines written before Z6 and in lines of
     * other kinds: no membership is then new (none is added; the line written records them for the next run).
     */
    cols?: string[][];
    /**
     * Zotero Web (R236 f): beside `cols`, the Zotero collection key of every name along each path (opaque Zotero ids,
     * like `externalKeys.zoteroKey`; sealed with the line in an encrypted project). A key seen again under another
     * name is a collection renamed in Zotero. Absent when the adapter gave none.
     */
    colKeys?: string[][];
  };
  /** Zotero item keys this line's deletion recorded as deleted here (review skip/merge); undo takes them back (R74 I3). */
  tombstoned?: string[];
  /** Annotations of the item left out over the per-source limit (R74 I4). */
  annotationsDropped?: number;
  /** Annotations of the item the researcher deleted here that the source still has: not imported again. */
  annotationsDeletedHere?: number;
  /** The files this line stored: copied into the library, or left as links (R136; for the report). */
  files?: { copied: number; linked: number };
  /** Task Z5: what Zotero said of the item (`zotero-gone`, `zotero-gone-unmarked`): deleted, or in its bin. */
  gone?: "deleted" | "bin";
  /**
   * Task Z5 (R224 a): a `zotero-back` line whose change also updated the item's content from Zotero (fields, files,
   * tags or annotations), not only its availability: it is counted as back AND as updated.
   */
  contentUpdated?: true;
  /**
   * Task Z6: fields this line's change put in conflict (changed in Zotero and here, to different values), each listed
   * in a pending capture-conflict review entry in the same change (R190, R193 b). Counted per item in `conflicts`.
   */
  conflictsQueued?: number;
  /** R236 a: fields Zotero cleared that this line's change kept here (noted once). Counted per item in `clearedInZoteroKept`. */
  clearedKept?: number;
  /**
   * Task Z6: collections renamed in Zotero, as far as this item shows it (one of its paths lost a name and gained
   * another at the same place), that this batch made under the new name; the old one is kept. Each as the hashes of
   * the new path (no name). Counted once per collection over the batch (`collectionsRenamed`).
   */
  renamedCollections?: string[];
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
  /** R393 a: the kind of the unexpected error that stopped the batch's last run (as JournalEntry.cause); absent otherwise. */
  stopCause?: string;
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
  /** The adapter's resume options (ImportSourceAdapter.resumeOptions), e.g. device import's researcher name, a Zotero Web batch's `since` and files mode. */
  adapterOptions?: { researcherName?: string; zoteroSince?: number; zoteroFiles?: boolean; zoteroReadVersions?: number[] };
  /** Zotero Web (Z2): the library version this batch recorded in the project when it finished (undo resets it, Z5). */
  recordedLibraryVersion?: number;
  /** Task Z5 (for Z7): a batch started by the Zotero sync runner, which resumes its own unfinished batches. */
  origin?: "zotero-sync";
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
    } catch (err) {
      if (isLockedRefusal(err)) throw err; // locked, not "not found" (R404)
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
    } catch (err) {
      if (err instanceof KeyNotAvailableError) throw err; // a wiped key: locked, not a foreign line (R386 a)
      // torn or foreign line
    }
  }
  return out;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * A journal line's `ext.parts` as it may be trusted (Task Z4): an own-keyed record of attachment keys, each
 * with a non-negative integer version and a lower-case SHA-256. Anything else in it is left out; undefined
 * when nothing is left (the file is then downloaded, as for a line written before Z4).
 */
export function readParts(raw: unknown): Record<string, { v: number; sha256: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { v: number; sha256: string }> = Object.create(null) as Record<string, { v: number; sha256: string }>;
  let any = false;
  for (const [k, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9]{1,32}$/u.test(k) || !p || typeof p !== "object") continue;
    const { v, sha256 } = p as { v?: unknown; sha256?: unknown };
    if (!Number.isInteger(v) || (v as number) < 0 || typeof sha256 !== "string" || !SHA256.test(sha256)) continue;
    out[k] = { v: v as number, sha256 };
    any = true;
  }
  return any ? out : undefined;
}

const COL_HASH = /^[0-9a-f]{12}$/u;

/** Task Z6: a collection name as a journal line keeps it: the first 12 hex of its SHA-256 (no name in the journal). */
export function collectionHash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
}

/** Task Z6: a journal line's `ext.cols` as it may be trusted (bounded lists of name hashes); undefined otherwise. */
export function readCols(raw: unknown): string[][] | undefined {
  if (!Array.isArray(raw) || raw.length > 256) return undefined;
  const out: string[][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length === 0 || p.length > 64 || !p.every((x) => typeof x === "string" && COL_HASH.test(x))) return undefined;
    out.push([...(p as string[])]);
  }
  return out;
}

const COL_KEY = /^[A-Za-z0-9]{1,32}$/u;

/** R236 f: a line's `ext.colKeys`, trusted only when it has exactly the shape of its `cols`; undefined otherwise. */
export function readColKeys(raw: unknown, cols: string[][] | undefined): string[][] | undefined {
  if (!cols || !Array.isArray(raw) || raw.length !== cols.length) return undefined;
  const out: string[][] = [];
  for (const [i, p] of raw.entries()) {
    if (!Array.isArray(p) || p.length !== cols[i]!.length || !p.every((x) => typeof x === "string" && COL_KEY.test(x))) return undefined;
    out.push([...(p as string[])]);
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
  /**
   * Task Z5 (R224): sources this batch marked gone from Zotero (a change it made: the line records it), of them in
   * Zotero's bin; sources already marked the same way (counted only); sources whose mark it took away, of them those
   * whose content it also updated (also counted in `updated`).
   */
  goneInZotero: number;
  goneInZoteroBin: number;
  goneAlready: number;
  backInZotero: number;
  backInZoteroUpdated: number;
  /** Items Zotero said are gone that have no source of their own here to mark (deleted here, merged only). */
  goneNotMarked: number;
  /**
   * Task Z6: ITEMS with at least one field changed in Zotero and here, now waiting for the researcher ("Changed in
   * Zotero and here — waiting for you: N"). One that also took in other changes is counted in `updated` as well.
   */
  conflicts: number;
  /** Task Z6: collections renamed in Zotero that arrived under their new name (the old one kept), each once. */
  collectionsRenamed: number;
  /** R236 a: ITEMS with a field Zotero cleared that was kept here ("Cleared in Zotero, kept here: N"). */
  clearedInZoteroKept: number;
} {
  const c = { created: 0, needsReview: 0, duplicates: 0, merged: 0, updated: 0, unchanged: 0, deletedHere: 0, failed: 0, items: 0, goneInZotero: 0, goneInZoteroBin: 0, goneAlready: 0, backInZotero: 0, backInZoteroUpdated: 0, goneNotMarked: 0, conflicts: 0, collectionsRenamed: 0, clearedInZoteroKept: 0 };
  const renamed = new Set<string>();
  for (const e of latest) {
    for (const h of e.renamedCollections ?? []) renamed.add(h);
    if (e.conflictsQueued) c.conflicts++;
    if (e.clearedKept) c.clearedInZoteroKept++;
    // Items gone from Zotero brought nothing in: counted apart, not as items.
    if (e.outcome === "zotero-gone") {
      if (e.merge?.availability) {
        c.goneInZotero++;
        if (e.gone === "bin") c.goneInZoteroBin++;
      } else c.goneAlready++;
      continue;
    }
    if (e.outcome === "zotero-gone-unmarked") {
      c.goneNotMarked++;
      continue;
    }
    c.items++;
    if (e.outcome === "zotero-back") {
      c.backInZotero++;
      if (e.contentUpdated) {
        c.backInZoteroUpdated++;
        c.updated++;
      }
    } else if (e.outcome === "created" || e.outcome === "incomplete") c.created++;
    else if (e.outcome === "needs-review") c.needsReview++;
    else if (e.outcome === "duplicate" || e.outcome === "skipped") c.duplicates++;
    else if (e.outcome === "merged") c.merged++;
    else if (e.outcome === "updated") c.updated++;
    else if (e.outcome === "unchanged") c.unchanged++;
    else if (e.outcome === "deleted-here") c.deletedHere++;
    else if (e.outcome === "failed") c.failed++;
    // "zotero-conflict": an item, counted in `conflicts` only (above).
  }
  c.collectionsRenamed = renamed.size;
  return c;
}

/** The ids of the project's batches whose record says undone (an unreadable record is taken as standing). */
export async function undoneBatchIds(repo: Repo, projectId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const d of await batchDirs(repo, projectId)) {
    try {
      const r = await readBatchAt(repo, projectId, d.name);
      if (r?.state === "undone") out.add(r.id);
    } catch {
      // unreadable: not known to be undone
    }
  }
  return out;
}
