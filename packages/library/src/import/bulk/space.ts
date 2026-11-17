/**
 * Room on the library's disk for a Bulk Import (R413). A full disk is the BATCH's condition, not an item's:
 *
 *  - (a) before a batch that copies files starts, the size of the files to be copied, plus a margin (10% of that
 *    size, at least MIN_MARGIN), plus for a Zotero local import the copy of its database, is compared with the
 *    free room on the disk that holds the library; too little refuses the start (`fitSentence`). The size is what
 *    the dry run of the same source found (`rememberScan`, kept in memory only), else the source's own cheap total
 *    (`cheapEstimate`): a folder, a device folder and a Calibre library by the sizes of their files (a ZIP archive
 *    in them by the sizes its entries declare), a ZIP archive by the sizes its entries declare, a Zotero data folder
 *    by the sizes of the files under its `storage` folder. Reference-manager exports and Zotero Web have no cheap
 *    total: their check is skipped (the per-file check in the run still protects);
 *  - (b) during the run, before an item's files are copied, the free room must be at least their size plus
 *    FILE_MARGIN (`fileMargin`), or the batch stops (run.ts).
 *
 * The free room is read with statfs (`statfsFree`, as the Zotero copy and Zotero Web's downloads do); a disk that
 * cannot tell skips the checks.
 */
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { extname, join } from "node:path";
import yauzl from "yauzl";
import { statfsFree } from "../sqlite-copy.js";
import type { ImportSourceAdapter } from "./scan.js";

/** The least room kept free beyond what a batch copies (R413 a; also the Zotero database copy's margin, R413 d). */
export const MIN_MARGIN = 500e6;
/** The room kept free beyond each item's files during the run (R413 b). */
export const FILE_MARGIN = 200e6;

/**
 * Test seams, honoured only when NODE_ENV is "test" (R47): the free room, and smaller margins (so a tiny temporary
 * file system can stand for a full disk).
 */
export const bulkSpaceSeams: { freeSpace?: (dir: string) => Promise<number>; minMargin?: number; fileMargin?: number } = {};
const seamsOn = () => process.env.NODE_ENV === "test";

/** The margin kept free beyond `bytes` copied: 10% of them, at least MIN_MARGIN (R413 a). */
export function spaceMargin(bytes: number): number {
  const min = seamsOn() && bulkSpaceSeams.minMargin !== undefined ? bulkSpaceSeams.minMargin : MIN_MARGIN;
  return Math.max(min, Math.ceil(Math.max(0, bytes) / 10));
}

/** The room kept free beyond each item's files during the run (R413 b). */
export function fileMargin(): number {
  return seamsOn() && bulkSpaceSeams.fileMargin !== undefined ? bulkSpaceSeams.fileMargin : FILE_MARGIN;
}

/** Free bytes on the disk that holds `dir`; Infinity when it cannot tell. */
export function freeRoom(dir: string): Promise<number> {
  return seamsOn() && bulkSpaceSeams.freeSpace ? bulkSpaceSeams.freeSpace(dir) : statfsFree(dir);
}

/** A size in the interface's style (watch.ts `sizeText`, packages/ui `formatSize`): "300 bytes", "4 kB", "12 MB", "3.2 GB". */
export function sizeWords(bytes: number): string {
  const b = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace(/\.0$/u, "")} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return b === 0 ? "nothing" : `${b} bytes`;
}

/** R413 a: why a batch that copies `copyBytes` does not fit in `freeBytes`; `canLink`: the files could be left where they are. */
export function fitSentence(copyBytes: number, freeBytes: number, canLink: boolean): string {
  const start = `This import would copy about ${sizeWords(copyBytes)} of files into the library, but its disk has only ${sizeWords(freeBytes)} free.`;
  return canLink ? `${start} Free some space, or choose to leave the files where they are, and start again.` : `${start} Free some space and start again.`;
}

/** R413 b: the note of a batch stopped by a full disk (or a quota). */
export const DISK_FULL_NOTE = "The import stopped because the disk is full. Free some space, then resume the import.";
/** R413 c: the note of a batch stopped because the project refuses every write (an earlier change could not be undone). */
export const RECOVERY_NOTE = "The import stopped because an earlier change in this project could not be undone. Open the project's notices, settle it, then resume the import.";

/** R413 b: no room for an item's files (FILE_MARGIN kept): the batch stops as for a full disk, before anything of the item is written. */
export class NoRoomError extends Error {
  override name = "NoRoomError";
  readonly code = "ENOSPC";
  constructor() {
    super("not enough free space on the library's disk for the next item's files");
  }
}

/** What is known of a source's files before a batch starts: their total size, and of it the files the source links in place. */
export interface SpaceEstimate {
  totalBytes: number;
  linkedBytes: number;
}

/** The latest dry run of each source, by project, kind and location (in memory only, never written). */
const lastScans = new Map<string, SpaceEstimate>();
const MAX_REMEMBERED = 64;
const scanKey = (projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">) => `${projectId}\u0000${a.kind}\u0000${a.location}`;

/** Remembers what a dry run found (R413 a): a batch from the same source then starts by this number. */
export function rememberScan(projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">, est: SpaceEstimate): void {
  const k = scanKey(projectId, a);
  lastScans.delete(k);
  lastScans.set(k, est);
  while (lastScans.size > MAX_REMEMBERED) lastScans.delete(lastScans.keys().next().value!);
}

export function rememberedScan(projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">): SpaceEstimate | undefined {
  return lastScans.get(scanKey(projectId, a));
}

/** Entries walked at most for a cheap total; a folder with more has no cheap total. */
const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 64;

/** The uncompressed sizes a ZIP archive's entries declare (no extraction); 0 when it cannot be read. */
function zipDeclaredBytes(path: string): Promise<number> {
  return new Promise((done) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err || !zf) return done(0);
      let n = 0;
      zf.on("entry", (e: yauzl.Entry) => {
        if (!e.fileName.endsWith("/")) n += e.uncompressedSize;
        zf.readEntry();
      });
      zf.on("end", () => {
        zf.close();
        done(n);
      });
      zf.on("error", () => {
        zf.close();
        done(0);
      });
      zf.readEntry();
    });
  });
}

/** The sizes of a folder's files (hidden ones and links to folders left out, as a folder scan does); undefined past MAX_ENTRIES. */
async function folderBytes(root: string, signal?: AbortSignal): Promise<number | undefined> {
  let entries = 0;
  const walk = async (dir: string, depth: number): Promise<number> => {
    if (depth > MAX_DEPTH) return 0;
    let list: Dirent[];
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let n = 0;
    for (const e of list) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES) throw new RangeError("too many entries");
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) n += await walk(p, depth + 1);
      else if (e.isFile() || e.isSymbolicLink()) {
        const st = await fsp.stat(p).catch(() => null);
        if (!st?.isFile()) continue;
        n += extname(e.name).toLowerCase() === ".zip" ? await zipDeclaredBytes(p) : st.size;
      }
    }
    return n;
  };
  try {
    return await walk(root, 0);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    return undefined;
  }
}

/** A Zotero data folder's location may name another of its libraries (zotero-local.ts): the folder is what comes before. */
export const zoteroDataDir = (location: string) => location.replace(/#library=\d{1,9}$/u, "");

/** R413 a: the source's own cheap total, by kind (see the header); undefined when it has none. */
export async function cheapEstimate(a: Pick<ImportSourceAdapter, "kind" | "location">, signal?: AbortSignal): Promise<SpaceEstimate | undefined> {
  let total: number | undefined;
  if (a.kind === "folder" || a.kind === "device" || a.kind === "calibre") total = await folderBytes(a.location, signal);
  else if (a.kind === "zip") total = await zipDeclaredBytes(a.location);
  else if (a.kind === "zotero-local") total = await folderBytes(join(zoteroDataDir(a.location), "storage"), signal);
  return total === undefined ? undefined : { totalBytes: total, linkedBytes: 0 };
}

/** R413 a, d: the size of a Zotero local import's database copy (the files copyDatabases copies, with their companions). */
export async function zoteroCopyBytes(dataDir: string): Promise<number> {
  let n = 0;
  for (const name of ["zotero.sqlite", "better-bibtex.sqlite"]) {
    for (const s of ["", "-shm", "-wal", "-journal"]) {
      const st = await fsp.stat(join(dataDir, name + s)).catch(() => null);
      if (st?.isFile()) n += st.size;
    }
  }
  return n;
}

/** R413 b, c: whether an error is a full disk (or quota), by its code or one it wraps (as causeOf finds codes). */
export function isDiskFull(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === "ENOSPC" || code === "EDQUOT") return true;
  }
  return false;
}
