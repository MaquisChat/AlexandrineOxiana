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

/** Tags (as exiftool-vendored names them, without group) that name a place without coordinates (R85). */
const PLACE_TAG = /^(?:City|Sub-?location|Province-?State|State|Country|Country-PrimaryLocationName|CountryCode|Location|LocationName|LocationCreated\w*|LocationShown\w*)$/u;

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
  if (model) m.model = model;
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

  for (const [k, v] of Object.entries(t)) {
    if (PLACE_TAG.test(k) && ((typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length > 0) || (typeof v === "object" && v !== null && !Array.isArray(v)))) {
      m.locationText = true;
      break;
    }
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
 * exiftool-vendored resolves rather than rejects for a file it cannot parse, with `Error` and
 * `errors` set: that is a failed read too (R58); `warnings` alone are not.
 */
export async function extractExif(path: string, opts: { embedded?: boolean } = {}): Promise<RawExtract> {
  try {
    const read = (p: string) => (opts.embedded ? exiftool().read(p, { readArgs: ["-ee"] }) : exiftool().read(p));
    const tags = (await (readerOverride ?? read)(path)) as Partial<Tags> & Record<string, unknown>;
    const errors = tags.errors;
    if ((tags.Error != null && String(tags.Error).trim() !== "") || (Array.isArray(errors) && errors.length > 0)) return { media: { readFailed: true } };
    return { media: mediaFromTags(tags) };
  } catch {
    return { media: { readFailed: true } };
  }
}

// ---------- location verification of derived copies (R83, R85) ----------

/** Whether a tag name (without its group) holds a location: GPS, ISO 6709, QuickTime and XMP locations, IPTC/XMP place names. */
const isLocationTag = (tag: string) => /GPS|Location|ISO6709|xyz|GeoTag|City|Province|Sub-?location|Country/iu.test(tag) || tag === "State";
/** Tags that only describe the file or ExifTool itself. */
const NOT_METADATA = /^(?:File|System|ExifTool|SourceFile)(?::|$)/u;
/** Tags holding a single latitude or longitude value. */
const COORDINATE_TAG = /(?:Latitude|Longitude)$/u;
/** Tags holding a position string ("40.7 -74.0 0", "+40.7-074.0/", "Lat=40.70000 Lon=-74.00000 Alt=0.00 ..."). */
const POSITION_TAG = /GPSCoordinates|GPSPosition|ISO6709|^Location(?:Information)?$|xyz/iu;
/** Housekeeping the worker writes with a coarsened position. */
const HARMLESS_TAG = /(?:Ref|VersionID)$/u;
/** How far a coarsened value may be from one decimal (DMS rationals written by the worker round-trip within 1e-6°). */
const COARSE_TOLERANCE = 1e-4;

/**
 * Every location tag of a file, by "Group:Tag" (ExifTool -G1 -a -n -ee: embedded documents and
 * timed tracks included), or null when it cannot be read.
 */
export async function readLocationTags(path: string): Promise<Record<string, unknown> | null> {
  let tags: Record<string, unknown>;
  try {
    tags = (await exiftool().readRaw(path, { readArgs: ["-G1", "-a", "-n", "-ee"] })) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const errors = tags.errors;
  if ((tags["ExifTool:Error"] != null && String(tags["ExifTool:Error"]).trim() !== "") || (Array.isArray(errors) && errors.length > 0)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tags)) if (!NOT_METADATA.test(k) && isLocationTag(k.slice(k.indexOf(":") + 1))) out[k] = v;
  return out;
}

const isCoarse = (v: number) => Number.isFinite(v) && Math.abs(v * 10 - Math.round(v * 10)) <= COARSE_TOLERANCE * 10;
const PLAIN_NUMBER = /^\s*[+-]?\d+(?:\.\d+)?\s*$/u;

/** The numbers in a position string, in order. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/[+-]?\d+(?:\.\d+)?/gu)) out.push(Number(m[0]));
  return out;
}

/**
 * Whether a derived copy's location metadata matches the project's rule (R83, R85), re-read from
 * the file itself: `strip` → no location tag at all (GPS, QuickTime/XMP locations, place names);
 * `coarsen` → only what the worker writes: latitude and longitude rounded to one decimal (as
 * numbers or position strings, any third coordinate 0) and their refs/version, nothing else
 * (no altitude, time stamps, speed, track, direction or place names); `keep` → anything. A file
 * whose metadata cannot be read does not match (except under `keep`). The reason names tags, never values.
 */
export async function checkProxyLocation(path: string, mode: "keep" | "coarsen" | "strip"): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (mode === "keep") return { ok: true };
  const tags = await readLocationTags(path);
  if (!tags) return { ok: false, reason: "the copy's metadata could not be read" };
  return locationTagsMatch(tags, mode);
}

/** The rule of `checkProxyLocation` on location tags already read ("Group:Tag" → value, ExifTool -n). Pure. */
export function locationTagsMatch(tags: Record<string, unknown>, mode: "keep" | "coarsen" | "strip"): { ok: true } | { ok: false; reason: string } {
  if (mode === "keep") return { ok: true };
  const located = Object.keys(tags).filter((k) => isLocationTag(k.slice(k.indexOf(":") + 1)));
  if (mode === "strip") return located.length ? { ok: false, reason: `the copy still has location tags (${located.slice(0, 5).join(", ")})` } : { ok: true };
  for (const k of located) {
    const v = tags[k];
    const tag = k.slice(k.indexOf(":") + 1);
    const bad = { ok: false as const, reason: `${k} is not allowed in a coarsened copy` };
    if (HARMLESS_TAG.test(tag)) continue;
    if (COORDINATE_TAG.test(tag)) {
      // One plain decimal number (ExifTool -n); anything else (e.g. "40,42.768N") is not understood: fail closed.
      const n = typeof v === "number" ? v : PLAIN_NUMBER.test(String(v)) ? Number(v) : undefined;
      if (n === undefined || !isCoarse(n)) return bad;
    } else if (/Altitude$/u.test(tag)) {
      // A derived altitude of 0 (from a position's third coordinate) is no location detail.
      const n = typeof v === "number" ? v : PLAIN_NUMBER.test(String(v)) ? Number(v) : undefined;
      if (n !== 0) return bad;
    } else if (POSITION_TAG.test(tag)) {
      const text = String(v);
      let nums: number[];
      if (/Lat=|Lon=/u.test(text)) {
        // QuickTime 'loci' as ExifTool prints it: "... Lat=40.70000 Lon=-74.00000 Alt=0.00 ..."
        const field = (name: "Lat" | "Lon" | "Alt") => {
          const m = new RegExp(`(?:^|\\s)${name}=([+-]?\\d+(?:\\.\\d+)?)`, "u").exec(text);
          return m ? Number(m[1]) : undefined;
        };
        const lat = field("Lat");
        const lon = field("Lon");
        const alt = field("Alt");
        if (lat === undefined || lon === undefined) return bad;
        nums = [lat, lon, ...(alt !== undefined ? [alt] : [])];
      } else nums = numbersIn(text);
      if (nums.length < 2 || !isCoarse(nums[0]!) || !isCoarse(nums[1]!)) return bad;
      if (nums.slice(2).some((x) => x !== 0)) return bad;
    } else {
      // Anything else location-named (time stamps, speed, track, direction, accuracy, place names) is never written by the worker.
      return bad;
    }
  }
  return { ok: true };
}
