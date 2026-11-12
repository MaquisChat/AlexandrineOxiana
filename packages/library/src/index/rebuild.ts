/** Rebuild `library.sqlite` from the library's files, and detect when it is out of date. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import { renameWithRetry } from "../fs/atomic.js";
import type { Library } from "../library.js";
import { ReadOnlyLibraryError } from "../repo/errors.js";
import { readMaybe } from "../repo/io.js";
import { REVIEW_FILE, parseReviewFile, reviewRow, type ReviewItemRow } from "../repo/review.js";
import type { Manifest } from "../repo/state.js";
import { computeStamps, listProjectEntries, newestChangeId, projectKey, type Stamps } from "./changes.js";
import {
  INDEX_FILE, IndexHandle, checkpointTruncate, deleteMeta, getMeta, indexLockedSource, indexProject, indexProjectEntities, indexSource, openIndexAt, setMeta, upsertReviewItem,
  type IndexDb,
} from "./db.js";
import { readExtractedText, readSource } from "./load.js";
import { indexUnlockedProject } from "./sink.js";

export interface RebuildResult {
  indexed: number;
  /** Ids of encrypted projects whose key was not available (indexed from manifest.json only). */
  lockedProjects: string[];
  errors: Array<{ folder: string; message: string }>;
}

export interface RebuildOptions {
  /** Test seam: runs after the new index is complete and closed, right before it replaces the old one. */
  beforeRename?: () => void | Promise<void>;
  /** Test seam: runs after the live connection is closed, before the rename (throw to simulate a rename failure). */
  afterClose?: () => void | Promise<void>;
  /** Test seam: replaces the per-project in-memory reload. */
  reloadProject?: typeof indexUnlockedProject;
  /** Stops the rebuild between sources (e.g. the library is closing); the old database stays in place. */
  signal?: AbortSignal;
  /** Test seam (a crash point): runs once the new index is built, just before its mark is cleared. */
  beforeComplete?: () => void | Promise<void>;
}

/**
 * Tables that later tasks fill from files of their own (review items, import batches, jobs). Until
 * those files exist the index is their only home, so a rebuild copies their rows over (ADR 0007).
 * Review items now also live in `review/pending.jsonl` (R31): rows read from those files replace
 * carried ones; rows of locked encrypted projects are carried as they were.
 */
const CARRIED_TABLES = ["review_items", "import_batches", "jobs"] as const;

const REBUILD_PREFIX = `${INDEX_FILE}.rebuild-`;

/**
 * The lasting "rebuild needed" mark (meta key, R161 a). Its value says why:
 * - "annotations": migration 0002 left an older index without annotation text;
 * - "missing" / "unreadable": library.sqlite was missing or could not be opened, and a new, empty
 *   one was started; until a rebuild completes it holds only what was written since (half-built);
 * - "stale" / "forced": a rebuild was started on an index that did not match the files, or was asked for;
 * - "rebuilding": only in a new index while it is being built.
 * Only a completed rebuild clears it; while it is set the index counts as stale.
 */
const NEEDS_REBUILD = "needsRebuild";

/** Marks that mean the index holds only part of the library (it was missing or unreadable): never shown as its content. */
const PARTIAL_MARKS = new Set(["missing", "unreadable", "rebuilding"]);

/** True when the index holds only part of the library: it was started empty and no rebuild has completed since (C1). */
export function indexIsPartial(db: IndexDb): boolean {
  const mark = getMeta(db, NEEDS_REBUILD);
  return mark !== undefined && PARTIAL_MARKS.has(mark);
}

async function rmIndexFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await fsp.rm(path + suffix, { force: true });
}

/**
 * Builds a fresh index in `library.sqlite.rebuild-<id>`, then closes the handle's live connection,
 * removes its WAL/SHM, atomically renames the new file over `library.sqlite`, reopens and swaps the
 * handle's connection, and reloads unlocked encrypted projects into memory. The old database stays
 * usable until the rename; a failure or crash before it leaves it untouched (a failed checkpoint
 * aborts the rebuild). A read-only library cannot rebuild.
 */
export async function rebuildIndex(
  handle: IndexHandle,
  keyRing: KeyRing,
  library: Pick<Library, "mode" | "readOnlyReason">,
  onProgress?: (done: number, total: number) => void,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  if (library.mode !== "read-write") throw new ReadOnlyLibraryError(library.readOnlyReason);
  const root = handle.root;
  // Leftovers of an earlier crashed rebuild (the library lock makes us the only writer).
  for (const f of await fsp.readdir(root)) {
    if (f.startsWith(REBUILD_PREFIX)) await rmIndexFiles(join(root, f.replace(/-(wal|shm|journal)$/, "")));
  }

  const dest = join(root, INDEX_FILE);
  const tmp = join(root, `${REBUILD_PREFIX}${newId()}`);
  let nextDb: IndexDb | undefined;
  try {
    const carried = readCarried(handle.isOpen ? handle.db : undefined);
    nextDb = openIndexAt(tmp);
    // The new index is marked from its first write (R161 a, Task 46a C1); clearing the mark is the
    // last change made to it, so only a completed build can ever be taken for the library's content.
    setMeta(nextDb, NEEDS_REBUILD, "rebuilding");
    const result = await populate(nextDb, root, keyRing, carried, onProgress, opts.signal);
    opts.signal?.throwIfAborted();
    await opts.beforeComplete?.();
    opts.signal?.throwIfAborted();
    deleteMeta(nextDb, NEEDS_REBUILD);
    checkpointTruncate(nextDb);
    nextDb.pragma("journal_mode = DELETE"); // one self-contained file
    nextDb.close();
    nextDb = undefined;
    await opts.beforeRename?.();
    opts.signal?.throwIfAborted();
    if (handle.isOpen) checkpointTruncate(handle.db); // failure here aborts with the old DB intact
    handle.close();
    await opts.afterClose?.();
    await fsp.rm(`${dest}-wal`, { force: true });
    await fsp.rm(`${dest}-shm`, { force: true });
    await renameWithRetry(tmp, dest);
    handle.reopen();
    result.errors.push(...(await reloadUnlocked(handle, root, keyRing, opts.reloadProject)));
    return result;
  } catch (err) {
    try {
      nextDb?.close();
    } catch {
      // already closed
    }
    await rmIndexFiles(tmp);
    if (!handle.isOpen) {
      try {
        handle.reopen(); // whichever database is at library.sqlite is intact
      } catch {
        // the original error is the useful one
      }
      if (handle.isOpen) {
        // the new connection has no in-memory content; errors ride along on the thrown error
        const reloadErrors = await reloadUnlocked(handle, root, keyRing, opts.reloadProject);
        if (err !== null && typeof err === "object") (err as { reloadErrors?: unknown }).reloadErrors = reloadErrors;
      }
    }
    throw err;
  }
}

/**
 * Loads every unlocked encrypted project into the handle's in-memory schema. A failure in one
 * project is collected (never thrown) so the others are still loaded.
 */
async function reloadUnlocked(
  handle: IndexHandle,
  root: string,
  keyRing: KeyRing,
  reload: typeof indexUnlockedProject = indexUnlockedProject,
): Promise<Array<{ folder: string; message: string }>> {
  const errors: Array<{ folder: string; message: string }> = [];
  let entries: Awaited<ReturnType<typeof listProjectEntries>> = [];
  try {
    entries = await listProjectEntries(root);
  } catch (err) {
    return [{ folder: "Projects", message: err instanceof Error ? err.message : String(err) }];
  }
  for (const e of entries) {
    const d = e.data;
    if (!d || !d.project.encryption.enabled || !projectKey(d, keyRing)) continue;
    try {
      errors.push(...(await reload(handle.db, root, keyRing, d.project.id)).errors);
    } catch (err) {
      errors.push({ folder: e.rel, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return errors;
}

function readCarried(old: IndexDb | undefined): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const t of CARRIED_TABLES) {
    try {
      out[t] = old ? (old.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>) : [];
    } catch {
      out[t] = []; // unreadable old database: nothing to carry
    }
  }
  return out;
}

async function populate(
  db: IndexDb,
  root: string,
  keyRing: KeyRing,
  carried: Record<string, Array<Record<string, unknown>>>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RebuildResult> {
  const result: RebuildResult = { indexed: 0, lockedProjects: [], errors: [] };
  // Stamps first: a change made while we walk then shows up as stale rather than being missed.
  const stamps: Stamps = await computeStamps(root, keyRing);

  const jobs: Array<() => Promise<void>> = [];
  const reviewRows: ReviewItemRow[] = [];
  for (const e of await listProjectEntries(root)) {
    if (!e.data) {
      result.errors.push({ folder: e.rel, message: e.error ?? "unreadable project" });
      continue;
    }
    const data = e.data;
    const project = { ...data.project, folder: e.rel };
    const k = projectKey(data, keyRing);
    indexProject(db, project, k === undefined);
    if (k === undefined) {
      result.lockedProjects.push(project.id);
      const raw = await readMaybe(join(root, e.rel, "manifest.json")).catch(() => null);
      let manifest: Manifest = { formatVersion: 1, sources: [] };
      if (raw) {
        try {
          manifest = JSON.parse(raw.toString("utf8")) as Manifest;
        } catch (err) {
          result.errors.push({ folder: `${e.rel}/manifest.json`, message: (err as Error).message });
        }
      }
      for (const m of manifest.sources ?? []) {
        jobs.push(async () => {
          indexLockedSource(db, { id: m.id, projectId: project.id, type: m.type, folder: m.folder, ...(m.issuedYear ? { issuedYear: m.issuedYear } : {}) });
          result.indexed++; // in the index, minus its text
        });
      }
      continue;
    }
    // The review queue's file record (R31) is read for every project whose key is available.
    try {
      const raw = await readMaybe(join(root, e.rel, ...REVIEW_FILE.split("/")));
      if (raw) {
        const { entries, skipped } = parseReviewFile(raw.toString("utf8"), project.id, k ? k.key : null);
        for (const r of entries) reviewRows.push(reviewRow(r, k !== null));
        if (skipped) result.errors.push({ folder: `${e.rel}/${REVIEW_FILE}`, message: `${skipped} unreadable line(s) skipped` });
      }
    } catch (err) {
      result.errors.push({ folder: `${e.rel}/${REVIEW_FILE}`, message: err instanceof Error ? err.message : String(err) });
    }
    // Plain projects are indexed fully here. An unlocked encrypted project gets manifest-level rows
    // only; its content is loaded into memory after the new file is in place (R30).
    const prot = k !== null;
    if (!prot) indexProjectEntities(db, data, false);
    let names: string[] = [];
    try {
      names = await fsp.readdir(join(root, e.rel, "Sources"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const folder = `${e.rel}/Sources/${name}`;
      jobs.push(async () => {
        try {
          // An encrypted project's annotations are loaded with its content, into memory, after the swap.
          const sf = await readSource(join(root, folder), k, { annotations: !prot });
          if (!sf) return; // not a source folder
          if (prot) indexSource(db, sf, undefined, { protected: true, withTemp: false });
          else indexSource(db, sf, await readExtractedText(root, sf, null));
          result.indexed++;
        } catch (err) {
          result.errors.push({ folder, message: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  }

  const total = jobs.length;
  onProgress?.(0, total);
  let done = 0;
  for (const job of jobs) {
    signal?.throwIfAborted();
    await job();
    onProgress?.(++done, total);
  }
  for (const [table, rows] of Object.entries(carried)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c]));
    }
  }
  // The files win over carried rows: they are the record (rows of locked projects stay as carried).
  for (const r of reviewRows) upsertReviewItem(db, r);
  setMeta(db, "projectStamps", JSON.stringify(stamps));
  setMeta(db, "lastChangeId", newestChangeId(stamps) ?? "");
  return result;
}

/**
 * True when the index no longer matches the files: its recorded change state differs from the
 * library's. Per project, readable change logs (unencrypted, or key in the ring — sealed lines are
 * opened) are compared by newest change id; locked projects by manifest mtime. Always true while
 * a migration's "rebuild needed" mark is set (R161 a): only a completed rebuild clears it.
 */
export async function isIndexStale(root: string, db: IndexDb, keyRing: KeyRing): Promise<boolean> {
  if (getMeta(db, NEEDS_REBUILD) !== undefined) return true;
  const recorded = getMeta(db, "projectStamps");
  if (recorded === undefined) return true;
  const current = await computeStamps(root, keyRing);
  return !sameStamps(JSON.parse(recorded) as Stamps, current);
}

function sameStamps(a: Stamps, b: Stamps): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Why a library's index must be rebuilt as soon as it is opened: library.sqlite was missing or
 * unreadable (a new one was started), or it carries the "rebuild needed" mark (an earlier rebuild did
 * not complete, or a migration left content out).
 */
export type IndexRebuildNeed = "missing" | "unreadable" | "marked";

export interface CheckedIndex {
  handle: IndexHandle;
  /** Rebuild at once, whatever the staleness check would say; undefined when only that check decides. */
  needsRebuild: IndexRebuildNeed | undefined;
  /** The index holds only part of the library (see indexIsPartial): its list is not the library's content. */
  partial: boolean;
  /** Plain-language notes (never a path). */
  warnings: string[];
}

/**
 * Opens a read-write library's index for use (spec 4.3, 9: the files are the record, the index is
 * rebuildable). A missing library.sqlite is started empty, and an unreadable one is kept aside as
 * `library.sqlite.corrupt-<time>` and started again; either way the new one is marked at once
 * ("missing" / "unreadable"), so that what is written into it before a rebuild completes is never
 * taken for the library's content, even after a crash (C1). Staleness is checked separately
 * (`rebuildIndexIfNeeded`), since it reads every project's change log.
 */
export async function openIndexChecked(
  root: string,
  now: () => Date = () => new Date(),
  /** `newLibrary`: the library was just created, so its new, empty index is its whole content (not marked). */
  opts: { newLibrary?: boolean } = {},
): Promise<CheckedIndex> {
  const dbPath = join(root, INDEX_FILE);
  const warnings: string[] = [];
  let started: "missing" | "unreadable" | undefined;
  try {
    await fsp.access(dbPath);
  } catch {
    started = "missing";
    // A WAL without its database is no use to the new one.
    for (const s of ["-wal", "-shm"]) await fsp.rm(dbPath + s, { force: true });
  }
  let handle: IndexHandle | undefined;
  try {
    handle = new IndexHandle(root);
    // A file that is not a database can open lazily; read from it to be sure.
    handle.db.prepare("SELECT COUNT(*) FROM meta").get();
  } catch {
    try {
      handle?.close();
    } catch {
      // not open
    }
    const stamp = now().toISOString().replace(/[-:.]/g, "");
    await renameWithRetry(dbPath, `${dbPath}.corrupt-${stamp}`);
    for (const s of ["-wal", "-shm"]) await fsp.rm(dbPath + s, { force: true });
    warnings.push("library.sqlite could not be opened; it was kept as library.sqlite.corrupt-<time> and rebuilt");
    handle = new IndexHandle(root);
    started = "unreadable";
  }
  if (started === "unreadable" || (started === "missing" && !opts.newLibrary)) setMeta(handle.db, NEEDS_REBUILD, started);
  if (started === "missing" && opts.newLibrary) started = undefined;
  const needsRebuild: IndexRebuildNeed | undefined = started ?? (getMeta(handle.db, NEEDS_REBUILD) !== undefined ? "marked" : undefined);
  return { handle, needsRebuild, partial: indexIsPartial(handle.db), warnings };
}

export interface RebuildIfNeededOptions {
  /** Rebuild whatever the index says (it was missing, unreadable or marked, or the researcher asked). */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called once the decision is made: `stale` false (current, nothing done) or true (a rebuild
   * follows, and the index has been marked). Until then an index sink should hold its stamps (M6).
   */
  onChecked?: (stale: boolean) => void;
  /** Called once, when a rebuild is about to start (not when the index is current). */
  onStart?: () => void;
  signal?: AbortSignal;
  /** Test seams of each pass. */
  rebuild?: Omit<RebuildOptions, "signal">;
}

/** Passes a rebuild may take when the library keeps changing under it. */
const MAX_PASSES = 3;

/**
 * Rebuilds the index when `force` is set or it no longer matches the files (`isIndexStale`; a check
 * that fails counts as stale). Before the first pass the live index is marked ("stale" or "forced",
 * unless it already carries a mark, which is kept): a rebuild that does not complete (a close, a move,
 * a failure, a crash) leaves the mark, so the next open rebuilds again, and writes made meanwhile
 * cannot make the index look current (C1). A change written while a pass walked the files makes it
 * stale again, so it is checked after each pass and rebuilt again (at most three passes). Returns
 * the last pass's result, or undefined when the index was current. A read-only library cannot
 * rebuild (ReadOnlyLibraryError). Locked encrypted projects are indexed from their manifests only;
 * unlocking one completes it (R30).
 */
export async function rebuildIndexIfNeeded(
  handle: IndexHandle,
  keyRing: KeyRing,
  library: Pick<Library, "mode" | "readOnlyReason">,
  opts: RebuildIfNeededOptions = {},
): Promise<RebuildResult | undefined> {
  if (library.mode !== "read-write") throw new ReadOnlyLibraryError(library.readOnlyReason);
  const stale = async () => isIndexStale(handle.root, handle.db, keyRing).catch(() => true);
  const mark = (why: string) => {
    if (getMeta(handle.db, NEEDS_REBUILD) === undefined) setMeta(handle.db, NEEDS_REBUILD, why);
  };
  if (!opts.force && !(await stale())) {
    opts.onChecked?.(false);
    return undefined;
  }
  mark(opts.force ? "forced" : "stale");
  opts.onChecked?.(true);
  opts.onStart?.();
  let result: RebuildResult | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    opts.signal?.throwIfAborted();
    if (pass > 0) mark("stale"); // changed during the last pass: marked again until this one completes
    result = await rebuildIndex(handle, keyRing, library, opts.onProgress, { ...opts.rebuild, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!(await stale())) break;
  }
  return result;
}
