/**
 * Typed service calls for the PDF reader (Task R6; R113: the reader's own module, built on the
 * shared client). Addresses carry ids only; the token stays in the Authorization header.
 *
 *  - `documentRange`: bytes `start` to `end` (inclusive) of a stored PDF, through the client's
 *    `byteRange` over `GET /projects/:id/sources/:sid/assets/:aid/document` (Task R5). The answer may
 *    end earlier than asked where the service may cut it (the file's end, DOCUMENT_RANGE_MAX_BYTES).
 *  - The annotation calls over the routes of Task R4 (`/projects/:id/sources/:sid/annotations`).
 *
 * The annotation shapes are Task R4's (`@ao/shared`, packages/shared/src/api/annotations.ts). That
 * task runs beside this one and has not landed here yet, so they are declared below exactly as the
 * plan's R4 Interfaces give them; when R4 lands, these declarations are replaced by the import from
 * `@ao/shared` with no change for any caller.
 */
import type { ApiClient } from "./client";

// ---- Task R4's shapes (to come from @ao/shared once R4 lands) ----

/**
 * The named highlight colours: R4's shared `HIGHLIGHT_COLOUR_NAMES`, equal to @ao/core's
 * `HIGHLIGHT_COLOURS` (the interface may not import the root of @ao/core, Task 47).
 */
export type HighlightColourName = "yellow" | "red" | "green" | "blue" | "purple" | "magenta" | "orange" | "grey";

/** A rectangle in PDF user space: points, origin bottom-left, on the unrotated page. */
export interface PdfRectDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnchorRecord {
  id: string;
  assetId: string;
  page: number;
  rects: PdfRectDto[];
  sortIndex: string;
  sortIndexDerived: boolean;
}

export interface AnnotationRecord {
  id: string;
  sourceId: string;
  kind: string;
  pdfAnchors: PdfAnchorRecord[];
  otherAnchorKinds: string[];
  quote?: string;
  body?: string;
  colorName: HighlightColourName;
  importedColour?: string;
  imported: boolean;
  pageLabel?: string;
  author: string;
  createdAt: string;
  modifiedAt?: string;
}

export interface AnnotationListResponse {
  annotations: AnnotationRecord[];
  count: number;
  textChars: number;
}

export interface AnnotationCreateRequest {
  kind: "highlight" | "note";
  assetId: string;
  anchors: Array<{ page: number; rects: PdfRectDto[]; sortIndex?: string }>;
  quote?: string;
  body?: string;
  colorName: HighlightColourName;
  pageLabel?: string;
}

export interface AnnotationUpdateRequest {
  body?: string | null;
  colorName?: HighlightColourName;
}

export interface AnnotationDeleteResponse {
  deleted: true;
  id: string;
}

// ---- the calls ----

/** A part of a stored PDF: its bytes, where they start and end (inclusive), and the file's length. */
export interface DocumentRange {
  bytes: Uint8Array;
  start: number;
  end: number;
  total: number;
}

export interface ReaderApi {
  documentRange(projectId: string, sourceId: string, assetId: string, start: number, end: number, signal?: AbortSignal): Promise<DocumentRange>;
  listAnnotations(projectId: string, sourceId: string): Promise<AnnotationListResponse>;
  createAnnotation(projectId: string, sourceId: string, req: AnnotationCreateRequest): Promise<AnnotationRecord>;
  updateAnnotation(projectId: string, sourceId: string, id: string, req: AnnotationUpdateRequest): Promise<AnnotationRecord>;
  deleteAnnotation(projectId: string, sourceId: string, id: string): Promise<AnnotationDeleteResponse>;
}

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

export function readerApi(client: ApiClient): ReaderApi {
  const r = client.request;
  return {
    documentRange: (pid, sid, aid, start, end, signal) => client.byteRange(`${src(pid, sid)}/assets/${seg(aid)}/document`, start, end, signal ? { signal } : {}),
    listAnnotations: (pid, sid) => r<AnnotationListResponse>("GET", `${src(pid, sid)}/annotations`),
    createAnnotation: (pid, sid, body) => r<AnnotationRecord>("POST", `${src(pid, sid)}/annotations`, { body }),
    updateAnnotation: (pid, sid, id, body) => r<AnnotationRecord>("PATCH", `${src(pid, sid)}/annotations/${seg(id)}`, { body }),
    deleteAnnotation: (pid, sid, id) => r<AnnotationDeleteResponse>("DELETE", `${src(pid, sid)}/annotations/${seg(id)}`),
  };
}
