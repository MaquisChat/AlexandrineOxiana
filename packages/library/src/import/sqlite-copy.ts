/**
 * Reading another program's SQLite database safely (Calibre, R65/R68/R70; Zotero, R72;
 * package-internal). The database is never opened in place — the other program may be running and
 * must never be changed — but copied into a private (0700) folder inside the batch's work folder,
 * opened read-only, read, closed and deleted.
 *
 * Copy consistency: the main file is copied together with its `-wal` (and `-shm`) or its rollback
 * `-journal`, whichever exist, and the copy is accepted only if none of the main file, `-wal` and
 * `-journal` changed size or modification time while they were copied (up to three tries; then
 * CopyUnstable, "busy saving"). In WAL mode SQLite writes the main file only when it checkpoints
 * and appends to (or resets) the `-wal` on every commit, so an unchanged pair is a snapshot SQLite
 * itself could have read (a frame without its commit record is ignored). The `-shm` is only an
 * index of the `-wal`; it is copied first, so it never points past the copied `-wal`, and SQLite
 * rebuilds it if it does not match. In rollback-journal mode (Zotero's default, with exclusive
 * locking) a large uncommitted transaction can already have written pages into the main file — a
 * torn file — while the original pages sit in the hot `-journal` (R75 I1). So the copied
 * `-journal` is copied too, and the private copy is opened read-write once, which makes SQLite roll
 * the hot journal back into the copy, before it is opened read-only: the copy then holds exactly
 * the committed data.
 *
 * The copy checks free space first (CopyNoSpace) and stops when the signal aborts.
 *
 * What is read is a file anyone could edit, so: `trusted_schema` is off (schema objects cannot call
 * functions with side effects) and `query_only` on; every table read must be a plain table (a view,
 * a virtual table or a table with generated columns could run any computation on read); rows are
 * read with iterate() under caps; text columns are read with substr() so a huge value is never
 * built in full.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
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

/** The copy's rollback journal is not one this importer settles (R77 C1): refused, the copy unread. */
export class CopyUnusual extends Error {
  override name = "CopyUnusual";
}

/** Shown for CopyUnusual, by Zotero and Calibre alike. */
export const UNUSUAL_STATE_REASON = "This library's database is in an unusual state; open it in Zotero (or Calibre) once and try again.";

/** Not enough free disk space for the copy. */
export class CopyNoSpace extends Error {
  override name = "CopyNoSpace";
}

/** Space kept free beyond the copy itself. */
const SPACE_MARGIN = 64 * 1024 * 1024;

/** A database file's companions, copied with it. */
const COMPANIONS = ["-shm", "-wal", "-journal"] as const;

export interface CopyOptions {
  signal?: AbortSignal;
  /** Test seam: free bytes where the copy goes (default: statfs). */
  freeSpace?: (dir: string) => Promise<number>;
  /** Room to leave free beyond the copy (default 64 MB; a Zotero import gives its own, R413 d). */
  reserve?: number;
}

/** Free bytes in `dir` (statfs); Infinity when it cannot tell. */
export async function statfsFree(dir: string): Promise<number> {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY; // cannot tell: the copy itself fails if the disk fills
  }
}

async function copyOne(src: string, dest: string, signal: AbortSignal | undefined): Promise<void> {
  await pipeline(createReadStream(src), createWriteStream(dest, { mode: 0o600, flags: "wx" }), ...(signal ? [{ signal }] : []));
}

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const pow2 = (n: number, lo: number, hi: number) => n >= lo && n <= hi && (n & (n - 1)) === 0;

/**
 * Whether a copied rollback journal may be rolled back (R77 C1). A journal SQLite would not treat
 * as hot (empty, or starting with a zero byte) needs nothing: false. One it would roll back must
 * have a valid header — the journal magic, a sector size and a page size that are powers of two
 * in SQLite's ranges — and no super-journal record (the journal magic in its last 8 bytes, after a
 * name length): during rollback SQLite opens, and may delete, the super-journal the record names
 * by absolute path, i.e. any file. Anything else throws CopyUnusual.
 */
async function journalToSettle(journal: string): Promise<boolean> {
  const fh = await fsp.open(journal, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const head = Buffer.alloc(28);
    const { bytesRead } = await fh.read(head, 0, 28, 0);
    if (head[0] === 0) return false; // not hot: SQLite ignores it
    if (bytesRead < 28 || !head.subarray(0, 8).equals(JOURNAL_MAGIC)) throw new CopyUnusual();
    const sector = head.readUInt32BE(20);
    const page = head.readUInt32BE(24);
    if (!pow2(sector, 32, 65536) || !pow2(page, 512, 65536)) throw new CopyUnusual();
    if (size >= 16) {
      const tail = Buffer.alloc(16);
      await fh.read(tail, 0, 16, size - 16);
      if (tail.subarray(8, 16).equals(JOURNAL_MAGIC)) throw new CopyUnusual(); // a super-journal record, whatever its length
    }
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * Rolls back a hot journal in a private copy: opening it read-write once lets SQLite do that (and
 * nothing else: no statement but a read of the schema table runs). Called only after
 * journalToSettle accepted the journal.
 *
 * What this open can touch (R77 C1, reasoned through): SQLite opens the database file given (in the
 * private copy folder; a plain path, never a "file:" URI, so no URI parameters), and next to it
 * `<db>-journal`, `<db>-wal` and `<db>-shm` — all in the copy folder, which it may also create or
 * delete there. The only file name a database or journal can carry is the rollback journal's
 * super-journal record, which journalToSettle refuses; a WAL file names no other file, and the
 * database header names none. No SQL runs but the schema read (no ATTACH, no triggers, no virtual
 * table modules; trusted_schema off). SQLite's own temporary files go to the system temp folder
 * under names SQLite chooses, never names from the files. So nothing outside the copy folder is
 * opened, changed or deleted.
 */
function settleCopy(path: string): void {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } finally {
    db.close();
  }
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
  opts: CopyOptions = {},
): Promise<DbCopy> {
  opts.signal?.throwIfAborted();
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
      const watched = present.flatMap((n) => [join(srcDir, n), join(srcDir, `${n}-wal`), join(srcDir, `${n}-journal`)]);
      const before = await Promise.all(watched.map(stampOf));
      let total = 0;
      for (const n of present) for (const s of ["", ...COMPANIONS]) total += (await stampOf(join(srcDir, n + s)))?.size ?? 0;
      if (total > maxBytes) throw new CopyTooLarge();
      if (total + (opts.reserve ?? SPACE_MARGIN) > (await (opts.freeSpace ?? statfsFree)(dir))) throw new CopyNoSpace();
      const paths = new Map<string, string>();
      for (const n of present) {
        const src = join(srcDir, n);
        const dest = join(dir, n);
        // -shm first (it must not point past the -wal copied after it), then -wal and -journal, then the database.
        for (const s of COMPANIONS) {
          await fsp.rm(dest + s, { force: true });
          if ((await stampOf(src + s)) !== null) {
            await copyOne(src + s, dest + s, opts.signal).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e; // one removed meanwhile is caught by the check below
            });
          }
        }
        await fsp.rm(dest, { force: true });
        await copyOne(src, dest, opts.signal);
        paths.set(n, dest);
      }
      const after = await Promise.all(watched.map(stampOf));
      let copied = 0;
      for (const n of present) for (const s of ["", ...COMPANIONS]) copied += (await stampOf(join(dir, n + s)))?.size ?? 0;
      if (copied > maxBytes) throw new CopyTooLarge();
      if (before.every((b, i) => same(b, after[i]!))) {
        for (const dest of paths.values()) {
          if ((await stampOf(`${dest}-journal`)) !== null && (await journalToSettle(`${dest}-journal`))) settleCopy(dest);
        }
        return { paths, dir, remove };
      }
      if (attempt >= COPY_TRIES) throw new CopyUnstable();
      opts.signal?.throwIfAborted();
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
 * Which of `names` are plain tables: sqlite_master lists them as type 'table' with a root page (a
 * virtual table, run by a module, has root page 0 — told by the schema's data, never by reading
 * its SQL, R75 I2), pragma_table_list says 'table' too, and none of their columns is generated
 * (computed on read, e.g. a printf() building a gigabyte string; PRAGMA table_xinfo hidden 2 or 3).
 */
export function plainTables(db: Database.Database, names: Iterable<string>): Set<string> {
  const rows = db.prepare("SELECT name, rootpage FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: unknown; rootpage: unknown }>;
  const tables = new Set<string>();
  for (const r of rows) if (typeof r.name === "string" && typeof r.rootpage === "number" && r.rootpage > 0) tables.add(r.name);
  try {
    const kinds = db.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as Array<{ name: unknown; type: unknown }>;
    for (const k of kinds) if (typeof k.name === "string" && k.type !== "table") tables.delete(k.name);
  } catch {
    // pragma_table_list unavailable: the root page check stands
  }
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
