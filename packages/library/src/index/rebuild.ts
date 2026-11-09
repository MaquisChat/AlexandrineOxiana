/** Rebuild `library.sqlite` from the library's files, and detect when it is out of date. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { SourceFile, newId } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import { renameWithRetry } from "../fs/atomic.js";
import type { Library } from "../library.js";
import { ReadOnlyLibraryError } from "../repo/errors.js";
import { decryptBytes, readMaybe } from "../repo/io.js";
import type { Manifest } from "../repo/state.js";
import { computeStamps, listProjectEntries, newestChangeId, projectKey, type Stamps } from "./changes.js";
import { INDEX_FILE, getMeta, indexLockedSource, indexProject, indexSource, openIndexAt, setMeta, type IndexDb } from "./db.js";

export interface RebuildResult {
  indexed: number;
  /** Ids of encrypted projects whose key was not available (indexed from manifest.json only). */
  lockedProjects: string[];
  errors: Array<{ folder: string; message: string }>;
}

export interface RebuildOptions {
  /** The open library; a read-only one cannot rebuild. */
  library?: Pick<Library, "mode" | "readOnlyReason">;
  /** Test seam: runs after the new index is complete and closed, right before it replaces the old one. */
  beforeRename?: () => void | Promise<void>;
}

const REBUILD_PREFIX = `${INDEX_FILE}.rebuild-`;

async function rmIndexFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await fsp.rm(path + suffix, { force: true });
}

/**
 * Builds a fresh index in `library.sqlite.rebuild-<id>` and atomically renames it over
 * `library.sqlite`. The old database stays usable until the rename; a failure or crash before it
 * leaves the old database untouched. Callers holding an open handle must reopen after this returns.
 */
export async function rebuildIndex(
  root: string,
  keyRing: KeyRing,
  onProgress?: (done: number, total: number) => void,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  if (opts.library && opts.library.mode !== "read-write") throw new ReadOnlyLibraryError(opts.library.readOnlyReason);
  // Leftovers of an earlier crashed rebuild (the library lock makes us the only writer).
  for (const f of await fsp.readdir(root)) if (f.startsWith(REBUILD_PREFIX)) await rmIndexFiles(join(root, f.replace(/-(wal|shm|journal)$/, "")));

  const dest = join(root, INDEX_FILE);
  const tmp = join(root, `${REBUILD_PREFIX}${newId()}`);
  let db: IndexDb | undefined;
  try {
    db = openIndexAt(tmp);
    const result = await populate(db, root, keyRing, onProgress);
    // Leave a single self-contained file: no WAL to be mistaken for the old database's.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.close();
    db = undefined;
    await opts.beforeRename?.();
    await retireOldWal(dest);
    await renameWithRetry(tmp, dest);
    return result;
  } catch (err) {
    try {
      db?.close();
    } catch {
      // already closed
    }
    await rmIndexFiles(tmp);
    throw err;
  }
}

/** Folds the old database's WAL into it and removes the side files, so none can be replayed onto the new file. */
async function retireOldWal(dest: string): Promise<void> {
  if (!(await fsp.stat(dest).catch(() => null))) {
    await fsp.rm(`${dest}-wal`, { force: true });
    await fsp.rm(`${dest}-shm`, { force: true });
    return;
  }
  try {
    const old = openIndexAt(dest);
    old.pragma("wal_checkpoint(TRUNCATE)");
    old.close();
  } catch {
    // an unreadable old database is about to be replaced anyway
  }
  await fsp.rm(`${dest}-wal`, { force: true });
  await fsp.rm(`${dest}-shm`, { force: true });
}

async function populate(
  db: IndexDb,
  root: string,
  keyRing: KeyRing,
  onProgress?: (done: number, total: number) => void,
): Promise<RebuildResult> {
  const result: RebuildResult = { indexed: 0, lockedProjects: [], errors: [] };
  // Stamps first: a change made while we walk then shows up as stale rather than being missed.
  const stamps: Stamps = await computeStamps(root, keyRing);

  type Job = () => Promise<void>;
  const jobs: Job[] = [];
  let done = 0;
  const entries = await listProjectEntries(root);

  for (const e of entries) {
    if (!e.data) {
      result.errors.push({ folder: e.rel, message: e.error ?? "unreadable project" });
      continue;
    }
    const data = e.data;
    const project = { ...data.project, folder: e.rel };
    const k = projectKey(data, keyRing);
    const locked = k === undefined;
    indexProject(db, project, locked);
    if (locked) {
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
    // Unlocked: project-level entities are indexed too (a locked project's are identifying).
    for (const c of data.collections) db.prepare("INSERT OR REPLACE INTO collections VALUES (?,?,?,?)").run(c.id, c.projectId, c.parentId ?? null, c.name);
    for (const t of data.tags) db.prepare("INSERT OR REPLACE INTO tags VALUES (?,?,?,?)").run(t.id, t.scope, t.name, t.color ?? null);
    for (const p of data.participants) db.prepare("INSERT OR REPLACE INTO participants VALUES (?,?,?)").run(p.id, p.projectId, p.code);
    for (const s of data.sessions) db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,?)").run(s.id, s.projectId, s.date);
    for (const c of data.consents) {
      db.prepare("INSERT OR REPLACE INTO consents VALUES (?,?,?,?,?,?,?)").run(c.id, c.projectId, c.participantId, c.scope, c.date, c.expires ?? null, c.withdrawn?.at ?? null);
    }

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
          indexSource(db, sf);
          result.indexed++;
        } catch (err) {
          result.errors.push({ folder, message: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  }

  const total = jobs.length;
  onProgress?.(0, total);
  for (const job of jobs) {
    await job();
    onProgress?.(++done, total);
  }
  setMeta(db, "projectStamps", JSON.stringify(stamps));
  setMeta(db, "lastChangeId", newestChangeId(stamps) ?? "");
  return result;
}

async function readSource(dir: string, k: { key: Uint8Array; keyId: string } | null | undefined): Promise<SourceFile | null> {
  if (k) {
    const raw = await readMaybe(join(dir, "source.json.enc"));
    if (!raw) return null;
    const text = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
    return SourceFile.parse(JSON.parse(text.toString("utf8")));
  }
  const raw = await readMaybe(join(dir, "source.json"));
  if (!raw) return null;
  return SourceFile.parse(JSON.parse(raw.toString("utf8")));
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
