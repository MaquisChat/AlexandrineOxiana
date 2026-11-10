/** Rebuild `library.sqlite` from the library's files, and detect when it is out of date. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import { renameWithRetry } from "../fs/atomic.js";
import type { Library } from "../library.js";
import { ReadOnlyLibraryError } from "../repo/errors.js";
import { readMaybe } from "../repo/io.js";
import type { Manifest } from "../repo/state.js";
import { computeStamps, listProjectEntries, newestChangeId, projectKey, type Stamps } from "./changes.js";
import {
  INDEX_FILE, checkpointTruncate, getMeta, indexLockedSource, indexProject, indexProjectEntities, indexSource, openIndexAt, setMeta,
  type IndexDb, type IndexHandle,
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
}

/**
 * Tables that later tasks fill from files of their own (review items, import batches, jobs). Until
 * those files exist the index is their only home, so a rebuild copies their rows over (ADR 0007).
 */
const CARRIED_TABLES = ["review_items", "import_batches", "jobs"] as const;

const REBUILD_PREFIX = `${INDEX_FILE}.rebuild-`;

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
    const result = await populate(nextDb, root, keyRing, carried, onProgress);
    checkpointTruncate(nextDb);
    nextDb.pragma("journal_mode = DELETE"); // one self-contained file
    nextDb.close();
    nextDb = undefined;
    await opts.beforeRename?.();
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
): Promise<RebuildResult> {
  const result: RebuildResult = { indexed: 0, lockedProjects: [], errors: [] };
  // Stamps first: a change made while we walk then shows up as stale rather than being missed.
  const stamps: Stamps = await computeStamps(root, keyRing);

  const jobs: Array<() => Promise<void>> = [];
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
          const sf = await readSource(join(root, folder), k);
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
    await job();
    onProgress?.(++done, total);
  }
  for (const [table, rows] of Object.entries(carried)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c]));
    }
  }
  setMeta(db, "projectStamps", JSON.stringify(stamps));
  setMeta(db, "lastChangeId", newestChangeId(stamps) ?? "");
  return result;
}

/**
 * True when the index no longer matches the files: its recorded change state differs from the
 * library's. Per project, readable change logs (unencrypted, or key in the ring — sealed lines are
 * opened) are compared by newest change id; locked projects by manifest mtime.
 */
export async function isIndexStale(root: string, db: IndexDb, keyRing: KeyRing): Promise<boolean> {
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
