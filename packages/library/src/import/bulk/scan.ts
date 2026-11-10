/**
 * Bulk Import sources (spec 5.4 "Import sources"): the `ImportSourceAdapter` interface, implemented
 * here for a folder (recursive, ZIP archives included) and a single ZIP archive, in ../refman.ts,
 * ../zotero-rdf.ts and ../calibre.ts for reference-manager exports and Calibre (Task 24), and by
 * Tasks 25–26 for Zotero.
 *
 * A folder scan never follows symbolic links, skips hidden files and the sidecar metadata files
 * that resolution reads next to an item (`.bib`, `.ris`, `.json`, `.opf`), and yields one item per
 * file, keyed by its path relative to the folder ("/"-separated): stable across runs, so a resumed
 * or repeated batch recognises its items. ZIP archives are unpacked with the archive limits
 * (extractArchive: ≤ 50 MB per entry, ≤ 2 GB in all, ≤ 100,000 entries; traversal, absolute and
 * symlink entries refuse the archive) into the batch's private work folder; their items are keyed
 * `<archive key>!/<entry name>`. A refused or unreadable archive is one item with `unreadable` set.
 */
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import yauzl from "yauzl";
import { fileTypeFromFile } from "file-type";
import type { Annotation, ImportBatch, SourceDraft } from "@ao/core";
import { UnsafeFileError } from "../../extract/errors.js";
import { extractArchive } from "../../extract/zip.js";
import { calibreAdapter } from "../calibre.js";
import { bibtexAdapter, cslJsonAdapter, risAdapter } from "../refman.js";
import { SIDECAR_EXTS } from "../sidecar.js";
import { zoteroRdfAdapter } from "../zotero-rdf.js";

export interface ScanFile {
  path: string;
  mime: string;
  bytes: number;
}

export interface ScanItem {
  /** Stable per item: used for resume and incremental import. */
  key: string;
  files: ScanFile[];
  referenceMetadata?: Partial<SourceDraft>;
  /** Folder names from the import's root to the item, for structure mapping. */
  folderPath?: string[];
  /**
   * Tag names the source carries (reference-manager keywords, Zotero subjects, Calibre tags): found
   * or created (as the batch's) whatever the structure option. A new source gets them all; a merge
   * adds those the existing source lacks, recorded in the merge record so undo takes them off (R66).
   */
  tags?: string[];
  /** e.g. Zotero annotations (Task 24; not stored by the folder/zip import). */
  annotations?: Annotation[];
  notes?: string[];
  /** Recorded in the source's provenance (e.g. a Zotero item key). */
  externalKeys?: Record<string, string>;
  /**
   * Linked files that were left out (missing, not a regular file, outside a Calibre library): one
   * plain note each, never a path. The item still imports with the files it has (metadata-only if
   * none); the notes are journaled with its outcome and listed in the batch report (R66).
   */
  fileNotes?: string[];
  /** The item could not be read at all (e.g. a refused archive): it fails with this plain reason. */
  unreadable?: string;
}

/** What the engine gives a scan: a private (0700) work folder for unpacked archives, created on first use. */
export interface ScanContext {
  workDir(): Promise<string>;
  /** A plain note for the batch report or preview (e.g. how many empty records were skipped). */
  note?(text: string): void;
}

export interface ImportSourceAdapter {
  kind: ImportBatch["source"]["kind"];
  /** Where the items come from (recorded, sealed in encrypted projects, in batch.json; never in reports). */
  location: string;
  /**
   * Folders the source's files are expected in (R67): the export file's folder, the Calibre
   * library, the scanned folder. A file whose real path (links followed) lies outside every root
   * (and outside the batch's own work folder) needs the user's approval before it is attached.
   */
  roots?: string[];
  scan(signal: AbortSignal, ctx?: ScanContext): AsyncIterable<ScanItem>;
  /** How many items the scan will yield (for progress), when it can tell cheaply. */
  count?(signal: AbortSignal): Promise<number>;
}

const SIDECARS: ReadonlySet<string> = new Set(SIDECAR_EXTS);
const SKIP_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const MAX_DEPTH = 64;
const ARCHIVE_UNREADABLE = "The archive could not be read, so its files were not imported.";

const skipName = (n: string) => n.startsWith(".") || SKIP_NAMES.has(n.toLowerCase());
const isZip = (n: string) => extname(n).toLowerCase() === ".zip";
const isSidecar = (n: string) => SIDECARS.has(extname(n).toLowerCase());

async function sniff(path: string): Promise<ScanFile | null> {
  const st = await fsp.lstat(path).catch(() => null);
  if (!st?.isFile()) return null;
  const t = await fileTypeFromFile(path).catch(() => undefined);
  return { path, mime: t?.mime ?? "application/octet-stream", bytes: st.size };
}

async function readDirSorted(dir: string): Promise<Dirent[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

let zipCounter = 0;

/** Items of one archive (unpacked into the work folder), or one unreadable item. */
async function* zipItems(zipPath: string, key: string, folderPath: string[], signal: AbortSignal, ctx: ScanContext | undefined): AsyncGenerator<ScanItem> {
  if (!ctx) {
    yield { key, files: [], unreadable: ARCHIVE_UNREADABLE };
    return;
  }
  const dest = join(await ctx.workDir(), `zip-${++zipCounter}`);
  let entries;
  try {
    entries = await extractArchive(zipPath, dest, undefined, signal);
  } catch (err) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    if ((err as Error)?.name === "AbortError") throw err;
    yield { key, files: [], unreadable: err instanceof UnsafeFileError ? `${err.message}, so it was not imported.` : ARCHIVE_UNREADABLE };
    return;
  }
  const stem = basename(zipPath, extname(zipPath));
  try {
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      signal.throwIfAborted();
      const segs = e.name.split("/");
      const name = segs[segs.length - 1]!;
      if (segs.some(skipName) || isSidecar(name) || isZip(name)) continue; // no archives inside archives
      if (e.refused) {
        yield { key: `${key}!/${e.name}`, files: [], unreadable: e.refused };
        continue;
      }
      const f = await sniff(e.path);
      if (!f) continue;
      yield { key: `${key}!/${e.name}`, files: [f], folderPath: [...folderPath, stem, ...segs.slice(0, -1)] };
    }
  } finally {
    // The unpacked copies are needed only while their items are processed.
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
  }
}

async function* walk(root: string, rel: string[], signal: AbortSignal, ctx: ScanContext | undefined): AsyncGenerator<ScanItem> {
  if (rel.length > MAX_DEPTH) return;
  const dir = join(root, ...rel);
  let entries: Dirent[];
  try {
    entries = await readDirSorted(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    signal.throwIfAborted();
    if (skipName(e.name)) continue;
    const segs = [...rel, e.name];
    const key = segs.join("/");
    if (e.isDirectory()) {
      yield* walk(root, segs, signal, ctx);
    } else if (e.isFile()) {
      if (isSidecar(e.name)) continue;
      const path = join(dir, e.name);
      if (isZip(e.name)) {
        yield* zipItems(path, key, rel, signal, ctx);
        continue;
      }
      const f = await sniff(path);
      if (f) yield { key, files: [f], folderPath: rel };
    }
    // symbolic links and special files are never followed or imported
  }
}

/** Number of entries a ZIP archive lists (no extraction), or 1 when it cannot be read. */
function zipEntryCount(path: string): Promise<number> {
  return new Promise((resolve) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err || !zf) return resolve(1);
      let n = 0;
      zf.on("entry", (e: yauzl.Entry) => {
        const name = e.fileName.split("/").pop() ?? "";
        if (!e.fileName.endsWith("/") && !e.fileName.split("/").some(skipName) && !isSidecar(name) && !isZip(name)) n++;
        zf.readEntry();
      });
      zf.on("end", () => {
        zf.close();
        resolve(Math.max(1, n));
      });
      zf.on("error", () => {
        zf.close();
        resolve(1);
      });
      zf.readEntry();
    });
  });
}

async function countFolder(root: string, rel: string[], signal: AbortSignal): Promise<number> {
  if (rel.length > MAX_DEPTH) return 0;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(join(root, ...rel), { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    signal.throwIfAborted();
    if (skipName(e.name)) continue;
    if (e.isDirectory()) n += await countFolder(root, [...rel, e.name], signal);
    else if (e.isFile() && !isSidecar(e.name)) n += isZip(e.name) ? await zipEntryCount(join(root, ...rel, e.name)) : 1;
  }
  return n;
}

/** A folder and its subfolders (ZIP archives included). */
export function folderAdapter(root: string): ImportSourceAdapter {
  return {
    kind: "folder",
    location: root,
    roots: [resolve(root)],
    scan: (signal, ctx) => walk(root, [], signal, ctx),
    count: (signal) => countFolder(root, [], signal),
  };
}

/** One ZIP archive. */
export function zipAdapter(zipPath: string): ImportSourceAdapter {
  return {
    kind: "zip",
    location: zipPath,
    roots: [], // its files are unpacked into the batch work folder, which is always allowed
    scan: (signal, ctx) => zipItems(zipPath, basename(zipPath), [], signal, ctx),
    count: () => zipEntryCount(zipPath),
  };
}

/** The adapter a batch's recorded source names (for resuming without one), or undefined. */
export function adapterFor(kind: ImportBatch["source"]["kind"], location: string): ImportSourceAdapter | undefined {
  if (kind === "folder") return folderAdapter(location);
  if (kind === "zip") return zipAdapter(location);
  if (kind === "bibtex") return bibtexAdapter(location);
  if (kind === "ris") return risAdapter(location);
  if (kind === "csl-json") return cslJsonAdapter(location);
  if (kind === "zotero-rdf") return zoteroRdfAdapter(location);
  if (kind === "calibre") return calibreAdapter(location);
  return undefined;
}
