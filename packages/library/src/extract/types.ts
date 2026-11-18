import type { Creator, FoundIdentifiers } from "@ao/core";

/** Text kept from a file: its first 3 pages / sections, at most this many characters. */
export const MAX_TEXT_CHARS = 20_000;
/** A PDF whose first page has fewer characters of text than this needs OCR. */
export const OCR_THRESHOLD_CHARS = 50;

export interface MediaMetadata {
  /** ISO 8601 local time as recorded, with its offset when the file gives one. */
  capturedAt?: string;
  /**
   * Which tag `capturedAt` came from: 'original' (DateTimeOriginal), 'created' (CreateDate /
   * QuickTime CreationDate / MediaCreateDate) or 'modified' (ModifyDate: a last resort that is
   * only a capture time for files straight from the camera; treat as unverified).
   */
  capturedAtSource?: "original" | "created" | "modified";
  /** From OffsetTimeOriginal (or an explicit zone on the QuickTime creation date), e.g. "+02:00". */
  tzOffset?: string;
  device?: string;
  /** The camera model alone (EXIF/QuickTime Model), e.g. "iPhone 15 Pro". */
  model?: string;
  lens?: string;
  /** A place named without coordinates (IPTC/XMP City, Sub-location, State, Country, LocationCreated/Shown ...): still a location (R85). */
  locationText?: boolean;
  /** Raw coordinates as stored; coarsening/stripping is governed elsewhere (spec 5.3). */
  gps?: { lat: number; lon: number; alt?: number };
  durationSec?: number;
  width?: number;
  height?: number;
  /** exiftool could not read the file: nothing is known, in particular not whether it has GPS. */
  readFailed?: boolean;
  /** Apple Live Photo pairing id (MakerNotes / QuickTime com.apple.quicktime.content.identifier). */
  contentIdentifier?: string;
}

export interface Extracted {
  title?: string;
  creators?: Creator[];
  /** Publication date (dc:date, prism:publicationDate/coverDate, citation_* or OPF dc:date) only. */
  issued?: string;
  /** The file's own creation date (PDF Info CreationDate, xmp:CreateDate, DOCX dcterms:created): never a publication date. */
  fileCreated?: string;
  language?: string;
  identifiers: FoundIdentifiers;
  text?: string;
  needsOcr?: boolean;
  media?: MediaMetadata;
  /** A document (PDF) that could not be parsed at all: damaged, truncated or password-protected. */
  readFailed?: boolean;
}

/** What one format extractor returns: identifiers from metadata fields go in `ids` (raw); the
 * dispatcher canonicalises them and adds those found in `text`. */
export interface RawExtract extends Omit<Extracted, "identifiers"> {
  ids?: { dois?: string[]; isbns?: string[]; arxiv?: string[] };
  /**
   * Every embedded title the file carries, as found, in the order the extractor reads them (PDF: XMP, Info; MOBI: EXTH
   * 503, the record-0 full name, the PalmDB name; HTML: the meta title, `<title>`), before the R394 filter that gives
   * `title`; only when one was found. Read by Find and acquire's file check alone, for its signs of another kind or
   * version of document ("Front Matter" behind an XMP "untitled", R410 b, R425 a); the dispatcher drops it, so the
   * import never sees it.
   */
  rawTitles?: string[];
}
