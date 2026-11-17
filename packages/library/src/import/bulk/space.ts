/**
 * Room on the library's disk for a Bulk Import (R413). A full disk is the BATCH's condition, not an item's:
 *
 *  - (a) before a batch that copies files starts, the size of the files to be copied, plus a margin (10% of that
 *    size, at least MIN_MARGIN), plus for a Zotero local import the copy of its database, is compared with the
 *    free room on the disk that holds the library; too little refuses the start (`fitSentence`). The size is what
 *    a dry run of the same source found within the last 30 minutes (`rememberScan`, kept in memory only): only what
 *    the run would copy (R436 b). With no such dry run the start is not refused: the per-file check protects;
 *  - (b) during the run, before an item's files are copied, the free room must be at least their size plus
 *    FILE_MARGIN (`fileMargin`), or the batch stops (run.ts).
 *
 * The free room is read with statfs (`statfsFree`, as the Zotero copy and Zotero Web's downloads do); a disk that
 * cannot tell skips the checks.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
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

/** What a dry run found of a source's files: their total size to be copied, and of it the files the source links in place. */
export interface SpaceEstimate {
  totalBytes: number;
  linkedBytes: number;
}

/** R436 b: how long a dry run is used for the start's check. */
export const SCAN_FRESH_MS = 30 * 60_000;

/** The files and folders approved outside the source (they change what a scan counts), in one canonical form. */
export interface ScanApprovals {
  folders?: string[];
  files?: string[];
  rememberFolders?: string[];
}
const approvalsKey = (ap: ScanApprovals | undefined) =>
  JSON.stringify([[...new Set([...(ap?.folders ?? []), ...(ap?.rememberFolders ?? [])])].sort(), [...new Set(ap?.files ?? [])].sort()]);

/** The latest dry run of each source, by project, kind, location and approvals, with when it was made (in memory only, never written). */
const lastScans = new Map<string, SpaceEstimate & { at: number }>();
const MAX_REMEMBERED = 64;
const scanKey = (projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">, ap: ScanApprovals | undefined) =>
  `${projectId}\u0000${a.kind}\u0000${a.location}\u0000${approvalsKey(ap)}`;

/** Remembers what a dry run found at `at` (ms, the repo's clock; R413 a, R436 b): a start from the same source then goes by it. */
export function rememberScan(projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">, ap: ScanApprovals | undefined, est: SpaceEstimate, at: number): void {
  const k = scanKey(projectId, a, ap);
  lastScans.delete(k);
  lastScans.set(k, { ...est, at });
  while (lastScans.size > MAX_REMEMBERED) lastScans.delete(lastScans.keys().next().value!);
}

/** R436 b: the dry run of the same source and approvals made within SCAN_FRESH_MS before `now`; undefined otherwise (no check). */
export function rememberedScan(projectId: string, a: Pick<ImportSourceAdapter, "kind" | "location">, ap: ScanApprovals | undefined, now: number): SpaceEstimate | undefined {
  const s = lastScans.get(scanKey(projectId, a, ap));
  if (!s || now - s.at > SCAN_FRESH_MS || now < s.at) return undefined;
  return { totalBytes: s.totalBytes, linkedBytes: s.linkedBytes };
}

/** A Zotero data folder's location may name another of its libraries (zotero-local.ts): the folder is what comes before. */
export const zoteroDataDir = (location: string) => location.replace(/#library=\d{1,9}$/u, "");

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
