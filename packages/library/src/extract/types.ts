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
  lens?: string;
  /** Raw coordinates as stored; coarsening/stripping is governed elsewhere (spec 5.3). */
  gps?: { lat: number; lon: number; alt?: number };
  durationSec?: number;
  width?: number;
  height?: number;
  /** Apple Live Photo pairing id (MakerNotes / QuickTime com.apple.quicktime.content.identifier). */
  contentIdentifier?: string;
}

export interface Extracted {
  title?: string;
  creators?: Creator[];
  issued?: string;
  language?: string;
  identifiers: FoundIdentifiers;
  text?: string;
  needsOcr?: boolean;
  media?: MediaMetadata;
}

/** What one format extractor returns: identifiers from metadata fields go in `ids` (raw); the
 * dispatcher canonicalises them and adds those found in `text`. */
export interface RawExtract extends Omit<Extracted, "identifiers"> {
  ids?: { dois?: string[]; isbns?: string[]; arxiv?: string[] };
}
