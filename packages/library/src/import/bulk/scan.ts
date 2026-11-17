/**
 * Bulk Import sources (spec 5.4 "Import sources"): the `ImportSourceAdapter` interface, implemented
 * here for a folder (recursive, ZIP archives included) and a single ZIP archive, in ../refman.ts,
 * ../zotero-rdf.ts and ../calibre.ts for reference-manager exports and Calibre (Task 24), and by
 * Tasks 25–26 for Zotero.
 *
 * A folder scan never follows symbolic links to folders (a link to a file is an item, attached only
 * if it really points inside the folder or is approved, R67), skips hidden files and the sidecar metadata files
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
import type { Asset, FieldEvidence, ImportBatch, SourceDraft } from "@ao/core";
import { UnsafeFileError } from "../../extract/errors.js";
import { extractArchive } from "../../extract/zip.js";
import { calibreAdapter } from "../calibre.js";
import { deviceAdapter } from "../device.js";
import { bibtexAdapter, cslJsonAdapter, risAdapter } from "../refman.js";
import { SIDECAR_EXTS } from "../sidecar.js";
import { zoteroLocalAdapter } from "../zotero-local.js";
import { zoteroRdfAdapter } from "../zotero-rdf.js";
import { zoteroWebAdapterFor } from "../zotero-web.js";

export interface ScanFile {
  path: string;
  mime: string;
  bytes: number;
  /**
   * The source links this file in place (a Zotero linked attachment): it is linked in place too,
   * unless the options say `linkedFiles: 'copy'` or the project keeps files encrypted (R24), where it
   * is copied with the note ENGINE_FILE_NOTES.linkedCopied.
   */
  link?: boolean;
  /** Capture details stored on the file's asset (device import: capture time, device, lens). */
  metadata?: Asset["metadata"];
}

/** A rectangle on a PDF page, in PDF points from the page's origin. */
export interface ScanRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An annotation or note that comes with an item (Zotero reader annotations and notes, R72). It is
 * stored with the source (source.json, sealed in encrypted projects) as an Annotation; its anchor
 * points into the asset stored from `file`. On a re-import, one whose `key` the source already has
 * is not added again.
 */
export interface ScanAnnotation {
  /** Stable key at the source, e.g. "zotero:ABCD2345" (kept as Annotation.externalKey). */
  key: string;
  kind: "highlight" | "underline" | "note" | "image" | "ink";
  body?: string;
  quote?: string;
  color?: string;
  pageLabel?: string;
  author?: string;
  /** ISO timestamp (default: when it is stored). */
  createdAt?: string;
  /** The item file (ScanFile.path) the anchor is in. */
  file?: string;
  /** A pdf anchor carries Zotero's sort index ("PPPPP|OOOOOO|TTTTT") when it has a well-formed one. */
  anchor?: { kind: "pdf"; page: number; rects: ScanRect[]; sortIndex?: string } | { kind: "epub-cfi"; cfi: string };
  /**
   * Instead of `file` (Zotero Web, Task Z4): the anchor is in the source's asset with this SHA-256, a file
   * stored by an earlier import and not downloaded again (ScanContext.fileKnown). An asset is never
   * guessed: when the source has none with this hash, a new annotation is stored without an anchor (its
   * page kept as the label), and one already stored keeps the anchor it has.
   */
  assetSha256?: string;
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
  /** Further collection paths the item is in (a Zotero item can be in several collections). */
  moreFolderPaths?: string[][];
  /**
   * Zotero Web (Task Z6, R236 f): the source's own collection keys along each path, in the order of
   * `[folderPath, ...moreFolderPaths]` (each list as long as its path). Journaled, so that a collection renamed at the
   * source (the same key under another name) is told from a new one. Optional: other adapters give none.
   */
  folderKeys?: string[][];
  /** Colours of the item's tags, by tag name (used when the tag is created). */
  tagColors?: Record<string, string>;
  /** Annotations and notes (Zotero, R72). */
  annotations?: ScanAnnotation[];
  /** The evidence kind of the reference metadata (default: refman). Zotero items: kind 'zotero'. */
  referenceSource?: FieldEvidence["source"];
  /**
   * Incremental import (adapters with `incremental`): the item's identity at its source and a token
   * that changes whenever the item (or anything under it) changes. Re-running skips an item whose
   * token is unchanged and updates one whose token changed (R72).
   */
  version?: {
    id: string;
    version: string;
    /**
     * Zotero Web (Task Z4): the item's stored files by attachment key: the attachment's version and the
     * SHA-256 of the file (downloaded in this run, or known from the journal through ScanContext.fileKnown).
     * The engine journals (`ext.parts`) only the parts whose file the source holds and the known ones it
     * carries forward; a download that failed has no part. Not part of the version token.
     */
    parts?: Record<string, { v: number; sha256?: string }>;
  };
  /** Recorded in the source's provenance (e.g. a Zotero item key). */
  externalKeys?: Record<string, string>;
  /**
   * Linked files that were left out (missing, not a regular file, outside a Calibre library): one
   * plain note each, never a path. The item still imports with the files it has (metadata-only if
   * none); the notes are journaled with its outcome and listed in the batch report (R66).
   */
  fileNotes?: string[];
  /**
   * Doubts about the record as the source gave it (e.g. a BibTeX entry that was not closed, R362 g):
   * plain sentences. The item still imports, and waits in the review queue with them as its reasons.
   */
  doubts?: string[];
  /** The item could not be read at all (e.g. a refused archive): it fails with this plain reason. */
  unreadable?: string;
  /**
   * Pairs of `files` indexes stored as one Live Photo (device import): each stored asset's
   * `metadata.pairedAssetId` names the other.
   */
  pairs?: Array<[number, number]>;
  /**
   * The item is gone at its source (Zotero Web, Task Z2): `"deleted"` (deleted for good) or `"bin"`
   * (in Zotero's bin). Such an item carries `version.id` and no files or content; it is never imported.
   * What it does to the source here is a later task's (Z5); until then the engine passes it by.
   */
  gone?: "deleted" | "bin";
}

/** What the engine gives a scan: a private (0700) work folder for unpacked archives, created on first use. */
export interface ScanContext {
  workDir(): Promise<string>;
  /** A plain note for the batch report or preview (e.g. how many empty records were skipped). */
  note?(text: string): void;
  /** The scan is for a dry run (nothing is imported): adapters that download files skip the downloads. */
  dryRun?: boolean;
  /**
   * R413 d: the room the scan's own temporary copies (the Zotero database) must leave free on the library's disk beyond
   * themselves: the files the batch will copy and the import's margin (bulk/space.ts). Absent: the margin alone.
   */
  reserveBytes?: number;
  /**
   * True when the engine will pass this item by anyway (e.g. it is already in a resumed batch's
   * journal): an adapter that downloads may then fetch nothing for it and yield nothing. Optional:
   * an adapter that ignores it is still correct (the engine keeps its own journal check). The adapter
   * may need a little to learn an item's key first (the Zotero Web incremental scan fetches a changed
   * child's parent records by key to find the item), but nothing under a skipped item.
   */
  skip?(itemKey: string): boolean;
  /**
   * The `version.id`s of every item imported before by a batch of this kind that was not undone (all
   * libraries of the kind: an adapter keeps to its own). Incremental adapters only.
   */
  knownIds?(): ReadonlySet<string>;
  /**
   * Zotero Web (Task Z4): the stored file's hash when the attachment `attKey` of the item `versionId` was
   * stored at version `attVersion` by an earlier import (the newest journal line of a batch of this kind
   * that was not undone says so, `ext.parts`, with the hash of the asset it became) and the item's source
   * still holds an asset entry with that hash (I1; or the source was deleted here and the item stays deleted,
   * R73); otherwise undefined. A known file is not downloaded (no request at all) and its
   * annotations are anchored by `assetSha256`. Incremental adapters only; one that ignores it downloads.
   */
  fileKnown?(versionId: string, attKey: string, attVersion: number): { sha256: string } | undefined;
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
  /**
   * Items carry `version`: an item already imported (by a batch of the same kind that was not
   * undone) is skipped when unchanged and updated when changed, instead of being imported again.
   */
  incremental?: boolean;
  /** Generated citation keys are made unique within the project (a, b, c … appended). */
  uniqueCitationKeys?: boolean;
  /** The tool recorded in the provenance of the sources it creates (default: the bulk import engine). */
  tool?: { name: string; version: string };
  /** How many items the scan will yield (for progress), when it can tell cheaply. */
  count?(signal: AbortSignal): Promise<number>;
  /**
   * Every photo and video gets a viewing proxy (device import, spec 5.3: HEIC, RAW and MOV are not
   * viewable as they are), under the project's location rule. Otherwise only located media under a
   * location condition get one (R83).
   */
  viewingProxies?: boolean;
  /** Options to keep with the batch record and give `adapterFor` again when the batch is resumed (e.g. device import's researcher name). */
  resumeOptions?: {
    researcherName?: string;
    /** Zotero Web (Z2): the library version the batch asked since (absent: a full scan). */
    zoteroSince?: number;
    /** Zotero Web (Z2): whether files are downloaded (absent: true). */
    zoteroFiles?: boolean;
    /** Zotero Web (A5): the library version each part of the batch read at, as soon as that part knows it. */
    zoteroReadVersions?: number[];
  };
}

const SIDECARS: ReadonlySet<string> = new Set(SIDECAR_EXTS);
const SKIP_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const MAX_DEPTH = 64;
const ARCHIVE_UNREADABLE = "The archive could not be read, so its files were not imported.";

const skipName = (n: string) => n.startsWith(".") || SKIP_NAMES.has(n.toLowerCase());
const isZip = (n: string) => extname(n).toLowerCase() === ".zip";
const isSidecar = (n: string) => SIDECARS.has(extname(n).toLowerCase());

async function sniff(path: string, follow = false): Promise<ScanFile | null> {
  const st = await (follow ? fsp.stat(path) : fsp.lstat(path)).catch(() => null);
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
    } else if (e.isSymbolicLink() && !isSidecar(e.name) && !isZip(e.name)) {
      // A link to a file is an item like any other; the engine checks where it really points (a
      // file outside the folder needs approval, R67). Links to folders are never followed.
      const f = await sniff(join(dir, e.name), true);
      if (f) yield { key, files: [f], folderPath: rel };
    }
    // special files are never imported
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
    else if (e.isSymbolicLink() && !isSidecar(e.name) && !isZip(e.name) && (await fsp.stat(join(root, ...rel, e.name)).catch(() => null))?.isFile()) n++;
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
export function adapterFor(kind: ImportBatch["source"]["kind"], location: string, options: ImportSourceAdapter["resumeOptions"] = {}): ImportSourceAdapter | undefined {
  if (kind === "folder") return folderAdapter(location);
  if (kind === "zip") return zipAdapter(location);
  if (kind === "bibtex") return bibtexAdapter(location);
  if (kind === "ris") return risAdapter(location);
  if (kind === "csl-json") return cslJsonAdapter(location);
  if (kind === "zotero-rdf") return zoteroRdfAdapter(location);
  if (kind === "calibre") return calibreAdapter(location);
  if (kind === "zotero-local") return zoteroLocalAdapter(location);
  if (kind === "zotero-web") return zoteroWebAdapterFor(location, options);
  if (kind === "device") return deviceAdapter(location, options?.researcherName ? { researcherName: options.researcherName } : {});
  return undefined;
}
