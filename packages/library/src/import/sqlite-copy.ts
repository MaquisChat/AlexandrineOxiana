/**
 * Reading another program's SQLite database safely (Calibre, R65/R68/R70; Zotero, R72;
 * package-internal). The database is never opened in place — the other program may be running and
 * must never be changed — but copied into a private (0700) folder inside the batch's work folder,
 * opened read-only, read, closed and deleted.
 *
 * Copy consistency: the main file and its `-wal` (and `-shm`, if present) are copied together, and
 * the copy is accepted only if neither the main file nor the `-wal` changed size or modification
 * time while they were copied (up to three tries). SQLite writes the main file only when it
 * checkpoints, and appends to (or resets) the `-wal` on every commit, so an unchanged pair is a
 * snapshot SQLite itself could have read: the copy holds every committed transaction up to that
 * moment and nothing half-written (a frame without its commit record is ignored when the copy is
 * opened). The `-shm` is only an index of the `-wal`; it is copied first, so it never points past
 * the copied `-wal`, and SQLite rebuilds it if it does not match. With Zotero's default exclusive
 * locking there is no `-shm` at all.
 *
 * What is read is a file anyone could edit, so: `trusted_schema` is off (schema objects cannot call
 * functions with side effects) and `query_only` on; every table read must be a plain table (a view,
 * a virtual table or a table with generated columns could run any computation on read); rows are
 * read with iterate() under caps; text columns are read with substr() so a huge value is never
 * built in full.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface DbCopy {
  /** The copied database files, by the source's base name (e.g. "zotero.sqlite" → its copy). */
  paths: Map<string, string>;
  dir: string;
  remove(): Promise<void>;
}

/** The copied files would be over the size cap. */
export class CopyTooLarge extends Error {
  override name = "CopyTooLarge";
}

/** The files kept changing while they were copied (the other program is busy writing). */
export class CopyUnstable extends Error {
  override name = "CopyUnstable";
}

const COPY_TRIES = 3;

type Stamp = { size: number; mtimeMs: number } | null;
const stampOf = async (p: string): Promise<Stamp> => {
  const st = await fsp.stat(p).catch(() => null);
  return st?.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
};
const same = (a: Stamp, b: Stamp) => (a === null ? b === null : b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/**
 * Copies databases (each with its `-wal`/`-shm` when present) into a new 0700 folder `<prefix>-<random>`
 * inside `workDir`. `required` databases must exist (ENOENT otherwise); `optional` ones are copied
 * when present. Over `maxBytes` in all (before or after copying) → CopyTooLarge; still changing
 * after three tries → CopyUnstable. Any failure removes the folder.
 */
export async function copyDatabases(
  srcDir: string,
  names: { required: string[]; optional?: string[] },
  workDir: string,
  prefix: string,
  maxBytes: number,
): Promise<DbCopy> {
  const dir = join(workDir, `${prefix}-${randomBytes(6).toString("hex")}`);
  await fsp.mkdir(dir, { mode: 0o700 });
  const remove = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    if (process.platform !== "win32") await fsp.chmod(dir, 0o700);
    const present: string[] = [];
    for (const n of names.required) {
      const st = await fsp.stat(join(srcDir, n));
      if (!st.isFile()) throw Object.assign(new Error(`${n} is not a file`), { code: "ENOENT" });
      present.push(n);
    }
    for (const n of names.optional ?? []) if ((await stampOf(join(srcDir, n))) !== null) present.push(n);

    for (let attempt = 1; ; attempt++) {
      const watched = present.flatMap((n) => [join(srcDir, n), join(srcDir, `${n}-wal`)]);
      const before = await Promise.all(watched.map(stampOf));
      let total = 0;
      for (const n of present) for (const s of ["", "-wal", "-shm"]) total += (await stampOf(join(srcDir, n + s)))?.size ?? 0;
      if (total > maxBytes) throw new CopyTooLarge();
      const paths = new Map<string, string>();
      for (const n of present) {
        const src = join(srcDir, n);
        const dest = join(dir, n);
        // -shm first (it must not point past the -wal copied after it), then -wal, then the database.
        for (const s of ["-shm", "-wal"]) {
          await fsp.rm(dest + s, { force: true });
          if ((await stampOf(src + s)) !== null) await fsp.copyFile(src + s, dest + s).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e; // a -shm/-wal removed meanwhile is caught by the check below
          });
        }
        await fsp.copyFile(src, dest);
        paths.set(n, dest);
      }
      const after = await Promise.all(watched.map(stampOf));
      let copied = 0;
      for (const n of present) for (const s of ["", "-wal", "-shm"]) copied += (await stampOf(join(dir, n + s)))?.size ?? 0;
      if (copied > maxBytes) throw new CopyTooLarge();
      if (before.every((b, i) => same(b, after[i]!))) return { paths, dir, remove };
      if (attempt >= COPY_TRIES) throw new CopyUnstable();
    }
  } catch (err) {
    await remove();
    throw err;
  }
}

/** Opens a copied database read-only, with `trusted_schema` off and `query_only` on. */
export function openCopy(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.pragma("query_only = ON");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Which of `names` are plain tables: sqlite_master lists them as type 'table', they are not
 * virtual tables (CREATE VIRTUAL TABLE, run by a module) and none of their columns is generated
 * (computed on read, e.g. a printf() building a gigabyte string; PRAGMA table_xinfo hidden 2 or 3).
 */
export function plainTables(db: Database.Database, names: Iterable<string>): Set<string> {
  const rows = db.prepare("SELECT name, substr(sql, 1, 64) AS head FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; head: string | null }>;
  const tables = new Set<string>();
  for (const r of rows) if (!/^\s*create\s+virtual\b/iu.test(r.head ?? "")) tables.add(r.name);
  const out = new Set<string>();
  for (const t of names) {
    if (!tables.has(t)) continue;
    const cols = db.prepare("SELECT hidden FROM pragma_table_xinfo(?)").all(t) as Array<{ hidden: number }>;
    if (!cols.some((c) => c.hidden === 2 || c.hidden === 3)) out.add(t);
  }
  return out;
}

/** The column names of a (plain) table. */
export function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((c) => c.name));
}

/** A text column read at most `max` characters long (SQL side, so a huge value is never built). */
export const tN = (col: string, as: string, max = 65536) => `substr(${col}, 1, ${max}) AS ${as}`;
export const t64 = (col: string, as: string) => tN(col, as, 65536);

/** Rows of a query, read with iterate(); more than `max` → `over()` is thrown. */
export function cappedRows<T>(db: Database.Database, sql: string, max: number, over: () => Error, ...params: unknown[]): T[] {
  const out: T[] = [];
  for (const r of db.prepare(sql).iterate(...params) as IterableIterator<T>) {
    if (out.length >= max) throw over();
    out.push(r);
  }
  return out;
}
