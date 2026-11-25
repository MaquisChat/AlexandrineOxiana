/**
 * Typed service calls for the PDF reader (Task R6; R113: the reader's own module, built on the
 * shared client). Addresses carry ids only; the token stays in the Authorization header.
 *
 *  - `documentRange`: bytes `start` to `end` (inclusive) of a stored PDF, through the client's
 *    `byteRange` over `GET /projects/:id/sources/:sid/assets/:aid/document` (Task R5). The answer may
 *    end earlier than asked where the service may cut it (the file's end, DOCUMENT_RANGE_MAX_BYTES).
 *  - The annotation calls over the routes of Task R4 (`/projects/:id/sources/:sid/annotations`).
 *
 * The annotation shapes are Task R4's, imported from `@ao/shared` (packages/shared/src/api/
 * annotations.ts) and re-exported for the reader's modules: there is one declaration of each, so a
 * field renamed there breaks the interface's build (ledger R184, amendment A6).
 */
import type { AnnotationCreateRequest, AnnotationDeleteResponse, AnnotationListResponse, AnnotationRecord, AnnotationUpdateRequest } from "@ao/shared";
import type { ApiClient } from "./client";

export type { AnnotationCreateRequest, AnnotationDeleteResponse, AnnotationKind, AnnotationListResponse, AnnotationRecord, AnnotationUpdateRequest, HighlightColourName, PdfAnchorRecord, PdfRectDto } from "@ao/shared";

// ---- the calls ----

/** A part of a stored PDF: its bytes, where they start and end (inclusive), and the file's length. */
export interface DocumentRange {
  bytes: Uint8Array;
  start: number;
  end: number;
  total: number;
}

export interface ReaderApi {
  /** `onAnswer` (FR-756): called once the service's answer has begun, before its bytes are read. */
  documentRange(projectId: string, sourceId: string, assetId: string, start: number, end: number, signal?: AbortSignal, onAnswer?: () => void): Promise<DocumentRange>;
  /** The source's annotations; `signal` aborts the request (R8: when the document ends). */
  listAnnotations(projectId: string, sourceId: string, signal?: AbortSignal): Promise<AnnotationListResponse>;
  createAnnotation(projectId: string, sourceId: string, req: AnnotationCreateRequest): Promise<AnnotationRecord>;
  updateAnnotation(projectId: string, sourceId: string, id: string, req: AnnotationUpdateRequest): Promise<AnnotationRecord>;
  deleteAnnotation(projectId: string, sourceId: string, id: string): Promise<AnnotationDeleteResponse>;
}

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

export function readerApi(client: ApiClient): ReaderApi {
  const r = client.request;
  return {
    documentRange: (pid, sid, aid, start, end, signal, onAnswer) => client.byteRange(`${src(pid, sid)}/assets/${seg(aid)}/document`, start, end, { ...(signal ? { signal } : {}), ...(onAnswer ? { onAnswer } : {}) }),
    listAnnotations: (pid, sid, signal) => r<AnnotationListResponse>("GET", `${src(pid, sid)}/annotations`, signal ? { signal } : {}),
    createAnnotation: (pid, sid, body) => r<AnnotationRecord>("POST", `${src(pid, sid)}/annotations`, { body }),
    updateAnnotation: (pid, sid, id, body) => r<AnnotationRecord>("PATCH", `${src(pid, sid)}/annotations/${seg(id)}`, { body }),
    deleteAnnotation: (pid, sid, id) => r<AnnotationDeleteResponse>("DELETE", `${src(pid, sid)}/annotations/${seg(id)}`),
  };
}

/**
 * R470 b (FR-490): the ranges of a file Find and acquire holds for pending review entry `reviewId` of the project, over
 * `GET /projects/:id/review/:itemId/held-file/document` — what the reader reads when the researcher LOOKS at a held file
 * before deciding. Read-only: the route records nothing.
 */
export function heldFileRanges(client: ApiClient, projectId: string, reviewId: string): (start: number, end: number, signal?: AbortSignal, onAnswer?: () => void) => Promise<DocumentRange> {
  return (start, end, signal, onAnswer) => client.byteRange(`/projects/${seg(projectId)}/review/${seg(reviewId)}/held-file/document`, start, end, { ...(signal ? { signal } : {}), ...(onAnswer ? { onAnswer } : {}) });
}
