/**
 * iPhone and camera media import (spec 5.3, Task 27, R83): any folder of device media (a camera
 * or SD card `DCIM/`, an iPhone seen as a device folder or through Image Capture / Windows Photos,
 * an AirDrop or iCloud Photos export) through the Bulk Import engine (batch kind `device`).
 *
 * Recognized files (spec 5.3 formats): HEIC/HEIF, JPEG, PNG, Apple ProRAW/DNG and camera RAW
 * (CR2/CR3, NEF, ARW, RAF, ORF); HEVC/H.264/ProRes in MOV/MP4/M4V; audio M4A, WAV, MP3. Hidden
 * files are skipped and links to folders never followed; a link to a file is an item whose real
 * path the engine checks (R67: the scanned folder is the adapter's root).
 *
 * Items:
 *   - a Live Photo, the still (HEIC/JPEG) and the video (MOV/MP4) with the same Apple content
 *     identifier, is one source with two originals, each asset's `metadata.pairedAssetId` naming
 *     the other;
 *   - a RAW file and a JPEG with the same base name in the same folder, captured within 2 s of each
 *     other, are one source with two originals;
 *   - every other file is a source of its own.
 * Exact duplicates (same bytes, found by file hash) are listed after everything else, so the engine
 * finds the copy already imported and skips them as duplicates by hash.
 *
 * Each source: type `field-photo` / `field-video` / `field-recording`; title
 * "<capture date> <device model> - <original file name stem>"; creator the researcher
 * (`{ literal: <display name>, role: 'photographer' }`) when a display name is known, else none and
 * the batch notes it; provenance `device_import` (legal-basis category `device-import`); capture
 * time, offset, device and lens on each original. Every photo and video gets a viewing proxy under
 * the project's location rule (R83, proxies.ts); originals are never modified.
 *
 * `importDeviceFolder` starts such a batch and links every new source to a fieldwork session and
 * participants (checked first; each link is part of the source's governed, audited creation).
 */
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { libraryVersion } from "../resources.js";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileTypeFromFile } from "file-type";
import type { Asset, Creator, ImportOptionsInput, SourceType } from "@ao/core";
import { extractExif } from "../extract/exif.js";
import type { MediaMetadata } from "../extract/types.js";
import { NotFoundError } from "../repo/errors.js";
import { startBatch, type BatchHandle, type BulkImportDeps } from "./bulk/run.js";
import type { ImportSourceAdapter, ScanContext, ScanFile, ScanItem } from "./bulk/scan.js";
import { sha256File } from "./common.js";

const VERSION: string = libraryVersion();

const RAW_EXTS = new Set(["dng", "cr2", "cr3", "nef", "arw", "raf", "orf"]);
/** Stills a Live Photo or a RAW+JPEG pair can have. */
const LIVE_STILL_EXTS = new Set(["heic", "heif", "jpg", "jpeg"]);
const JPEG_EXTS = new Set(["jpg", "jpeg"]);
const PHOTO_EXTS = new Set(["heic", "heif", "jpg", "jpeg", "png", ...RAW_EXTS]);
const VIDEO_EXTS = new Set(["mov", "mp4", "m4v"]);
const AUDIO_EXTS = new Set(["m4a", "wav", "mp3"]);

/** The file extensions device import recognizes (spec 5.3), lower case. */
export const DEVICE_EXTENSIONS: ReadonlySet<string> = new Set([...PHOTO_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);

/** RAW and JPEG are one item when their capture times are at most this far apart. */
export const RAW_JPEG_WINDOW_MS = 2000;
const MAX_DEPTH = 32;
/** More files than this in one folder tree: the rest are left out, with a note. */
export const MAX_DEVICE_FILES = 200_000;

export const DEVICE_RESEARCHER_NOTE =
  "No researcher name is set for this library or device, so the imported media have no photographer. Add one to each source, or set your name and import again.";
const TOO_MANY_NOTE = `The folder holds more than ${MAX_DEVICE_FILES.toLocaleString("en-US")} media files; only the first ${MAX_DEVICE_FILES.toLocaleString("en-US")} were imported. Import its subfolders one at a time.`;

const extOf = (p: string) => extname(p).slice(1).toLowerCase();
const stemOf = (p: string) => basename(p, extname(p));
const skipName = (n: string) => n.startsWith(".") || /^(?:thumbs\.db|desktop\.ini)$/iu.test(n);

/** One recognized file, with what pairing needs from its metadata. */
export interface DeviceFile {
  path: string;
  /** Path relative to the scanned folder, "/"-separated (the item key). */
  rel: string;
  bytes: number;
  contentIdentifier?: string;
  /** As recorded (local time, offset when stated). */
  capturedAt?: string;
  tzOffset?: string;
  device?: string;
  model?: string;
  lens?: string;
}

export interface DeviceGroup {
  kind: "live-photo" | "raw+jpeg" | "single";
  type: SourceType;
  /** The primary file first (the still of a Live Photo, the JPEG of a RAW+JPEG pair). */
  files: DeviceFile[];
}

function typeOf(path: string): SourceType {
  const e = extOf(path);
  if (VIDEO_EXTS.has(e)) return "field-video";
  if (AUDIO_EXTS.has(e)) return "field-recording";
  return "field-photo";
}

const ZONE = /(?:Z|[+-]\d{2}:\d{2})$/u;

/** The capture instant, when the time zone is known (stated in the time or as the offset). */
function instantOf(f: DeviceFile): number | undefined {
  if (!f.capturedAt) return undefined;
  const zoned = ZONE.test(f.capturedAt) ? f.capturedAt : f.tzOffset ? `${f.capturedAt}${f.tzOffset}` : undefined;
  const t = zoned ? Date.parse(zoned) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The capture time as the camera's clock showed it (any zone dropped), in ms. */
function wallClockOf(f: DeviceFile): number | undefined {
  if (!f.capturedAt) return undefined;
  const t = Date.parse(`${f.capturedAt.replace(ZONE, "")}Z`);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * How far apart two capture times are: the instants when both zones are known, else the wall-clock
 * times (a camera often states the zone in the JPEG but not in the RAW file, R85).
 */
function apartMs(a: DeviceFile, b: DeviceFile): number | undefined {
  const ia = instantOf(a);
  const ib = instantOf(b);
  if (ia !== undefined && ib !== undefined) return Math.abs(ia - ib);
  const wa = wallClockOf(a);
  const wb = wallClockOf(b);
  return wa !== undefined && wb !== undefined ? Math.abs(wa - wb) : undefined;
}

const byPath = (a: DeviceFile, b: DeviceFile) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/**
 * Groups recognized files into items (pure): Live Photos by content identifier (preferring the
 * still with the video's own name and folder), RAW+JPEG by base name, folder and capture time
 * (±2 s), every other file alone. Multi-file items come first, then single files, each in path order.
 */
export function groupDeviceFiles(files: DeviceFile[]): DeviceGroup[] {
  const sorted = [...files].sort(byPath);
  const used = new Set<DeviceFile>();
  const groups: DeviceGroup[] = [];
  // Live Photos.
  const byCid = new Map<string, DeviceFile[]>();
  for (const f of sorted) {
    if (!f.contentIdentifier) continue;
    const list = byCid.get(f.contentIdentifier) ?? [];
    list.push(f);
    byCid.set(f.contentIdentifier, list);
  }
  for (const list of byCid.values()) {
    const video = list.find((f) => VIDEO_EXTS.has(extOf(f.path)));
    const stills = list.filter((f) => LIVE_STILL_EXTS.has(extOf(f.path)));
    if (!video || !stills.length) continue;
    const same = (f: DeviceFile) => dirname(f.path) === dirname(video.path) && stemOf(f.path).toLowerCase() === stemOf(video.path).toLowerCase();
    const still = stills.find(same) ?? stills[0]!;
    used.add(still).add(video);
    groups.push({ kind: "live-photo", type: "field-photo", files: [still, video] });
  }
  // RAW + JPEG.
  for (const raw of sorted) {
    if (used.has(raw) || !RAW_EXTS.has(extOf(raw.path))) continue;
    const jpeg = sorted.find((f) => {
      if (used.has(f) || !JPEG_EXTS.has(extOf(f.path)) || dirname(f.path) !== dirname(raw.path)) return false;
      if (stemOf(f.path).toLowerCase() !== stemOf(raw.path).toLowerCase()) return false;
      const d = apartMs(raw, f);
      return d !== undefined && d <= RAW_JPEG_WINDOW_MS;
    });
    if (!jpeg) continue;
    used.add(raw).add(jpeg);
    groups.push({ kind: "raw+jpeg", type: "field-photo", files: [jpeg, raw] });
  }
  groups.sort((a, b) => byPath(a.files[0]!, b.files[0]!));
  for (const f of sorted) if (!used.has(f)) groups.push({ kind: "single", type: typeOf(f.path), files: [f] });
  return groups;
}

/** Recognized files under `root` (sorted, hidden files skipped, links to folders never followed). */
async function collect(root: string, signal: AbortSignal, note: (t: string) => void): Promise<DeviceFile[]> {
  const out: DeviceFile[] = [];
  let full = false;
  const walk = async (rel: string[]): Promise<void> => {
    if (rel.length > MAX_DEPTH || full) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(join(root, ...rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      signal.throwIfAborted();
      if (skipName(e.name)) continue;
      const segs = [...rel, e.name];
      if (e.isDirectory()) {
        await walk(segs);
        continue;
      }
      if (!DEVICE_EXTENSIONS.has(extOf(e.name))) continue;
      const path = join(root, ...segs);
      // A link to a file is an item like any other (the engine checks where it points, R67).
      const st = await (e.isSymbolicLink() ? fsp.stat(path) : fsp.lstat(path)).catch(() => null);
      if (!st?.isFile()) continue;
      if (out.length >= MAX_DEVICE_FILES) {
        full = true;
        note(TOO_MANY_NOTE);
        return;
      }
      out.push({ path, rel: segs.join("/"), bytes: st.size });
    }
  };
  await walk([]);
  return out;
}

/** Fills in what pairing and titles need from each file's metadata (exiftool). */
async function readMetadata(files: DeviceFile[], signal: AbortSignal): Promise<void> {
  for (const f of files) {
    signal.throwIfAborted();
    const media: MediaMetadata = (await extractExif(f.path)).media ?? {};
    if (media.readFailed) continue;
    if (media.contentIdentifier) f.contentIdentifier = media.contentIdentifier;
    if (media.capturedAt) f.capturedAt = media.capturedAt;
    if (media.tzOffset) f.tzOffset = media.tzOffset;
    if (media.device) f.device = media.device;
    if (media.model) f.model = media.model;
    if (media.lens) f.lens = media.lens;
  }
}

/**
 * Exact duplicates (same size, then same SHA-256): the first by (shortest name, path) is kept where
 * it is; the others are returned, to be listed last so the engine skips them as duplicates by hash.
 */
async function splitDuplicates(files: DeviceFile[], signal: AbortSignal): Promise<{ kept: DeviceFile[]; copies: DeviceFile[] }> {
  const bySize = new Map<number, DeviceFile[]>();
  for (const f of files) bySize.set(f.bytes, [...(bySize.get(f.bytes) ?? []), f]);
  const copies = new Set<DeviceFile>();
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map<string, DeviceFile[]>();
    for (const f of same) {
      signal.throwIfAborted();
      const h = await sha256File(f.path).catch(() => `unreadable:${f.path}`);
      byHash.set(h, [...(byHash.get(h) ?? []), f]);
    }
    for (const list of byHash.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => basename(a.path).length - basename(b.path).length || byPath(a, b));
      for (const f of list.slice(1)) copies.add(f);
    }
  }
  return { kept: files.filter((f) => !copies.has(f)), copies: files.filter((f) => copies.has(f)) };
}

/** An ISO 8601 UTC timestamp for the asset record, when the capture time's zone is known. */
function utcOf(f: DeviceFile): string | undefined {
  if (!f.capturedAt) return undefined;
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/u.test(f.capturedAt) ? f.capturedAt : f.tzOffset ? `${f.capturedAt}${f.tzOffset}` : undefined;
  if (!zoned) return undefined;
  const t = Date.parse(zoned);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function assetMetadata(f: DeviceFile): Asset["metadata"] | undefined {
  const capturedAt = utcOf(f);
  const m: NonNullable<Asset["metadata"]> = {
    ...(capturedAt ? { capturedAt } : {}),
    ...(f.tzOffset ? { tzOffset: f.tzOffset } : {}),
    ...(f.device ? { device: f.device } : {}),
    ...(f.lens ? { lens: f.lens } : {}),
  };
  return Object.keys(m).length ? m : undefined;
}

const mt = (value: string) => ({ variants: [{ lang: "und", kind: "original" as const, value }] });

async function scanFile(f: DeviceFile): Promise<ScanFile> {
  const t = await fileTypeFromFile(f.path).catch(() => undefined);
  const metadata = assetMetadata(f);
  return { path: f.path, mime: t?.mime ?? "application/octet-stream", bytes: f.bytes, ...(metadata ? { metadata } : {}) };
}

async function toItem(g: DeviceGroup, researcher: string | undefined): Promise<ScanItem> {
  const primary = g.files[0]!;
  const date = g.files.map((f) => f.capturedAt?.slice(0, 10)).find((d) => d && /^\d{4}-\d{2}-\d{2}$/u.test(d));
  const model = g.files.map((f) => f.model ?? f.device).find(Boolean);
  const head = [date, model].filter(Boolean).join(" ");
  const title = head ? `${head} - ${stemOf(primary.path)}` : stemOf(primary.path);
  const creators: Creator[] = researcher ? [{ literal: researcher, role: "photographer" }] : [];
  return {
    key: primary.rel,
    files: await Promise.all(g.files.map(scanFile)),
    referenceMetadata: { type: g.type, title: mt(title), creators, ...(date ? { issued: date } : {}) },
    referenceSource: { kind: "embedded", ref: "device" },
    ...(g.kind === "live-photo" ? { pairs: [[0, 1]] as Array<[number, number]> } : {}),
  };
}

export interface DeviceAdapterOptions {
  /**
   * The researcher's display name (the photographer). There is no library or device setting for it
   * yet: the caller passes it when it knows one; without it the creator is left out (and noted).
   */
  researcherName?: string;
}

/** Any folder of device media (spec 5.3); the scanned folder is the adapter's root (R67). */
export function deviceAdapter(dir: string, opts: DeviceAdapterOptions = {}): ImportSourceAdapter {
  const root = resolve(dir);
  const researcher = opts.researcherName?.trim() || undefined;
  return {
    kind: "device",
    location: dir,
    roots: [root],
    tool: { name: "device-import", version: VERSION },
    viewingProxies: true,
    // Kept in batch.json (sealed in encrypted projects), so a resumed batch names the photographer too.
    ...(researcher ? { resumeOptions: { researcherName: researcher } } : {}),
    async *scan(signal: AbortSignal, ctx?: ScanContext): AsyncGenerator<ScanItem> {
      const note = (t: string) => ctx?.note?.(t);
      if (!researcher) note(DEVICE_RESEARCHER_NOTE);
      const all = await collect(root, signal, note);
      const { kept, copies } = await splitDuplicates(all, signal);
      await readMetadata(all, signal);
      for (const g of groupDeviceFiles(kept)) {
        signal.throwIfAborted();
        yield await toItem(g, researcher);
      }
      // Copies last: the engine finds their bytes already imported and skips them.
      for (const f of copies.sort(byPath)) {
        signal.throwIfAborted();
        yield await toItem({ kind: "single", type: typeOf(f.path), files: [f] }, researcher);
      }
    },
  };
}

export interface DeviceImportOptions extends ImportOptionsInput {
  /** The fieldwork session every new source is linked to. */
  sessionId?: string;
  /** The participants every new source is linked to. */
  participantIds?: string[];
  /** The researcher's display name (see DeviceAdapterOptions). */
  researcherName?: string;
}

/**
 * Imports a device folder as a Bulk Import batch (kind `device`) and links every source it creates
 * to the session and participants given. An unknown session or participant refuses the import
 * before anything is stored (NotFoundError).
 */
export async function importDeviceFolder(deps: BulkImportDeps, projectId: string, dir: string, opts: DeviceImportOptions = {}): Promise<BatchHandle> {
  const { sessionId, participantIds, researcherName, ...options } = opts;
  const ids = [...new Set(participantIds ?? [])];
  if (sessionId !== undefined || ids.length) {
    const fw = await deps.repo.getFieldwork(projectId);
    if (sessionId !== undefined && !fw.sessions.some((s) => s.id === sessionId)) throw new NotFoundError("Session", sessionId);
    for (const id of ids) if (!fw.participants.some((p) => p.id === id)) throw new NotFoundError("Participant", id);
  }
  return startBatch(deps, projectId, deviceAdapter(dir, researcherName ? { researcherName } : {}), options, {
    fieldwork: { ...(sessionId !== undefined ? { sessionId } : {}), ...(ids.length ? { participantIds: ids } : {}) },
  });
}
