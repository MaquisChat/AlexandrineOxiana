/**
 * The reader's annotation routes (PDF reader plan, Task R4): highlights and page notes of one source.
 *
 *   GET    /projects/:id/sources/:sid/annotations         → AnnotationListResponse
 *   POST   /projects/:id/sources/:sid/annotations         → 201 AnnotationRecord   (body: AnnotationCreateRequest)
 *   PATCH  /projects/:id/sources/:sid/annotations/:anid   → AnnotationRecord       (body: AnnotationUpdateRequest)
 *   DELETE /projects/:id/sources/:sid/annotations/:anid   → AnnotationDeleteResponse
 *
 * The desktop app's token only (the extension's gets 403). Refusals a handler itself makes: 409
 * READ_ONLY (library open read-only), 423 PROJECT_LOCKED, 403 POLICY_DENIED (with its reason), 409
 * CONFLICT (10,000 annotations already), 413 PAYLOAD_TOO_LARGE (16 MB of text, or a body over 1 MB),
 * 400 VALIDATION (a bad shape, naming the field; a quote, note or page label with control characters
 * other than a line break or a tab), 404 NOT_FOUND (project, source, file or annotation).
 */

/** The named highlight colours (equal to the model's `HIGHLIGHT_COLOURS`; a test in the library package keeps them equal). */
export const HIGHLIGHT_COLOUR_NAMES = ["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"] as const;
export type HighlightColourName = (typeof HIGHLIGHT_COLOUR_NAMES)[number];

/** Longest note, in characters. */
export const ANNOTATION_NOTE_MAX_CHARS = 65_536;
/** Longest quote, in characters. */
export const ANNOTATION_QUOTE_MAX_CHARS = 65_536;
/** Most anchors (pages) one annotation may have. */
export const ANNOTATION_ANCHORS_MAX = 50;
/** Most rectangles one anchor may have. */
export const ANNOTATION_RECTS_MAX = 1000;
/** Most annotations one source holds. */
export const SOURCE_ANNOTATIONS_MAX = 10_000;
/** Most characters of quote and note text one source's annotations hold (16 MB). */
export const SOURCE_ANNOTATION_TEXT_MAX = 16_777_216;

/** A rectangle in PDF user space, in points: origin bottom-left, y up, the page unrotated (x, y the bottom-left corner). */
export interface PdfRectDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One page's part of an annotation. `sortIndex` is the stored one, or (`sortIndexDerived`) worked out from the rectangles. */
export interface PdfAnchorRecord {
  id: string;
  assetId: string;
  page: number;
  rects: PdfRectDto[];
  sortIndex: string;
  sortIndexDerived: boolean;
}

export type AnnotationKind = "highlight" | "underline" | "note" | "image" | "ink" | "coded-segment" | "clip" | "screenshot";

/** An annotation as the interface sees it. */
export interface AnnotationRecord {
  id: string;
  sourceId: string;
  kind: AnnotationKind;
  pdfAnchors: PdfAnchorRecord[];
  /** The kinds of any anchors that are not a PDF place (none for a reader highlight). */
  otherAnchorKinds: string[];
  quote?: string;
  body?: string;
  /** The colour shown: the chosen name, else the imported colour's nearest name, else yellow. */
  colorName: HighlightColourName;
  /** An imported annotation's own colour, when it differs from the named colour's reference value. */
  importedColour?: string;
  /** It came from an import (Zotero), whether or not it has been changed since. */
  imported: boolean;
  pageLabel?: string;
  /** Absent for an imported annotation its source gave no author for (D22). */
  author?: string;
  createdAt: string;
  modifiedAt?: string;
}

/** One source's annotations, in reading order: by document (file), then page, then position. */
export interface AnnotationListResponse {
  annotations: AnnotationRecord[];
  count: number;
  /** Characters of quote and note text held (against SOURCE_ANNOTATION_TEXT_MAX). */
  textChars: number;
}

export interface AnnotationCreateRequest {
  kind: "highlight" | "note";
  /** A PDF file of this source. */
  assetId: string;
  anchors: Array<{ page: number; rects: PdfRectDto[]; sortIndex?: string }>;
  quote?: string;
  body?: string;
  colorName: HighlightColourName;
  pageLabel?: string;
}

/** A change: the note (`null` removes it) and/or the colour. Nothing else can be changed. */
export interface AnnotationUpdateRequest {
  body?: string | null;
  colorName?: HighlightColourName;
}

export interface AnnotationDeleteResponse {
  deleted: true;
  id: string;
}

/**
 * R473 I1: what is said of a source whose change did not finish and whose roll-back failed (the paths a pending
 * marker names), for as long as the roll-back waits: in a library open for changes, and in one opened without them.
 */
export const SOURCE_CHANGE_UNFINISHED = "A change to this source did not finish and could not be undone. Close the library and open it again to put it back.";
export const SOURCE_CHANGE_UNFINISHED_READ_ONLY = "A change to this source did not finish and could not be undone. It can be put back only when the library is opened for changes.";
