/**
 * Images and video through exiftool-vendored (spec 5.3): capture time and its offset, device,
 * lens, raw GPS, duration, size and the Apple content identifier (Live Photo pairing).
 *
 * One ExifTool process pool per process, created on first use; `shutdownExif()` ends it (call it
 * on shutdown, and in tests' afterAll) so no exiftool processes outlive their user.
 * GPS stays raw here: coarsening or stripping is a governance decision made when storing and
 * exporting (spec 5.3, Task 15 image proxies).
 */
import { ExifTool, type Tags } from "exiftool-vendored";
import { clean } from "./names.js";
import type { MediaMetadata, RawExtract } from "./types.js";

let instance: ExifTool | undefined;

function exiftool(): ExifTool {
  // geolocation off: no reverse lookups; no time zone is inferred from GPS (tzOffset comes only
  // from what the file states).
  instance ??= new ExifTool({ maxProcs: 2, geolocation: false, taskTimeoutMillis: 30_000 });
  return instance;
}

/** Ends the ExifTool processes (a no-op when none were started). */
export async function shutdownExif(): Promise<void> {
  const et = instance;
  instance = undefined;
  if (et) await et.end();
}

interface DateLike {
  toISOString?: () => string | undefined;
  rawValue?: string;
  hasZone?: boolean;
  inferredZone?: boolean;
  tzoffsetMinutes?: number;
}

const OFFSET_RE = /^[+-]\d{2}:\d{2}$/u;

function offsetOf(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** ISO text of an ExifTool date, plus its zone when the file states one (not inferred). */
function dateOf(v: unknown): { iso: string; zone?: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") {
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/u.exec(v.trim());
    if (!m || m[1] === "0000") return undefined;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}${m[8] ?? ""}`;
    return { iso, ...(m[8] && m[8] !== "Z" ? { zone: m[8] } : {}) };
  }
  if (typeof v === "object") {
    const d = v as DateLike;
    const iso = d.toISOString?.();
    if (!iso) return undefined;
    const stated = d.hasZone && !d.inferredZone && typeof d.tzoffsetMinutes === "number";
    return { iso, ...(stated ? { zone: offsetOf(d.tzoffsetMinutes!) } : {}) };
  }
  return undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && clean(v) ? clean(v) : undefined);

/** Maps ExifTool tags to MediaMetadata (pure; exported for tests). */
export function mediaFromTags(t: Partial<Tags> & Record<string, unknown>): MediaMetadata {
  const m: MediaMetadata = {};
  // Capture time: EXIF original, then creation, then QuickTime creation, then the IFD0 date
  // (on files straight from a camera, such as many DNGs, that is the capture time).
  const candidates: Array<[unknown, NonNullable<MediaMetadata["capturedAtSource"]>]> = [
    [t.SubSecDateTimeOriginal, "original"],
    [t.DateTimeOriginal, "original"],
    [t.SubSecCreateDate, "created"],
    [t.CreateDate, "created"],
    [t.CreationDate, "created"],
    [t.MediaCreateDate, "created"],
    [t.ModifyDate, "modified"],
  ];
  let captured: { iso: string; zone?: string } | undefined;
  for (const [v, source] of candidates) {
    captured = dateOf(v);
    if (captured) {
      m.capturedAtSource = source;
      break;
    }
  }
  if (captured) m.capturedAt = captured.iso;
  const offset = text(t.OffsetTimeOriginal);
  if (offset && OFFSET_RE.test(offset)) m.tzOffset = offset;
  else if (!t.OffsetTimeOriginal) {
    const qt = dateOf(t.CreationDate);
    if (qt?.zone) m.tzOffset = qt.zone;
  }

  const make = text(t.Make);
  const model = text(t.Model);
  const device = make && model ? (model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`) : (model ?? make);
  if (device) m.device = device;
  const lens = text(t.LensModel);
  if (lens) m.lens = lens;

  let lat = num(t.GPSLatitude);
  let lon = num(t.GPSLongitude);
  if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
    if (lat > 0 && /^S/iu.test(String(t.GPSLatitudeRef ?? ""))) lat = -lat;
    if (lon > 0 && /^W/iu.test(String(t.GPSLongitudeRef ?? ""))) lon = -lon;
    const alt = num(t.GPSAltitude);
    m.gps = { lat, lon, ...(alt !== undefined ? { alt } : {}) };
  }

  const duration = num(t.Duration);
  if (duration !== undefined && duration > 0) m.durationSec = duration;
  const width = num(t.ImageWidth);
  const height = num(t.ImageHeight);
  if (width) m.width = width;
  if (height) m.height = height;
  const cid = text(t.ContentIdentifier) ?? text((t as Record<string, unknown>)["com.apple.quicktime.content.identifier"]);
  if (cid) m.contentIdentifier = cid;
  return m;
}

type ExifReader = (path: string) => Promise<unknown>;
let readerOverride: ExifReader | undefined;

/** Test-only (not exported from the package): replaces the exiftool read, e.g. to make it fail. */
export function setExifReaderForTests(reader: ExifReader | undefined): void {
  readerOverride = reader;
}

/**
 * A file exiftool could not read (error, timeout, helper failed to start) is reported as
 * `media: { readFailed: true }`, never as "no GPS": callers treat it as possibly located (R57).
 */
export async function extractExif(path: string): Promise<RawExtract> {
  try {
    const tags = await (readerOverride ?? ((p: string) => exiftool().read(p)))(path);
    return { media: mediaFromTags(tags as Partial<Tags> & Record<string, unknown>) };
  } catch {
    return { media: { readFailed: true } };
  }
}
