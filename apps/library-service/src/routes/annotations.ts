/**
 * The reader's annotations (PDF reader plan, Task R4): list, create, recolour or annotate, and delete
 * the highlights and page notes of one source, over the library's governed operations (R3). The
 * desktop app's token only. Request and response shapes are declared once in @ao/shared
 * (api/annotations.ts); a renamed field there breaks this file's build.
 *
 * Nothing typed is ever logged (the request logger holds no body) or audited (R177, in the library).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZOTERO_REFERENCE_COLOURS, highlightColourOf, pdfSortIndex, sortAnnotations, type Annotation, type PdfAnchor } from "@ao/core";
import type { AnnotationDraft, AnnotationPatch } from "@ao/library";
import type {
  AnnotationCreateRequest,
  AnnotationDeleteResponse,
  AnnotationListResponse,
  AnnotationRecord,
  AnnotationUpdateRequest,
  PdfAnchorRecord,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyAs, paramsOf, projectParam, type Ctx } from "./util.js";

/** A request body of these routes is at most 1 MB (R96). */
export const ANNOTATION_BODY_LIMIT = 1024 * 1024;

/** Every control character except a line break (and its carriage return) and a tab. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const CREATE_KEYS: ReadonlyArray<keyof AnnotationCreateRequest> = ["kind", "assetId", "anchors", "quote", "body", "colorName", "pageLabel"];
const UPDATE_KEYS: ReadonlyArray<keyof AnnotationUpdateRequest> = ["body", "colorName"];

/** The stored index of a pdf anchor, or one worked out from where its highest rectangle is (R1: higher sorts first). */
function anchorRecord(a: PdfAnchor): PdfAnchorRecord {
  const maxY = a.rects.reduce((m, r) => Math.max(m, r.y + r.h), -Infinity);
  return {
    id: a.id,
    assetId: a.assetId,
    page: a.page,
    rects: a.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    sortIndex: a.sortIndex ?? pdfSortIndex(a.page - 1, 0, 100_000 - Math.floor(Number.isFinite(maxY) ? maxY : 0)),
    sortIndexDerived: a.sortIndex === undefined,
  };
}

/**
 * An annotation as sent to the UI. `colorName` is always the one shown (`highlightColourOf`);
 * `importedColour` is the imported value only for an imported annotation whose colour differs from
 * the named colour's reference value.
 */
export function annotationRecord(a: Annotation): AnnotationRecord {
  const colorName = highlightColourOf(a);
  const imported = a.externalKey !== undefined;
  const showImported = imported && a.color !== undefined && a.color.trim().toLowerCase() !== ZOTERO_REFERENCE_COLOURS[colorName].toLowerCase();
  return {
    id: a.id,
    sourceId: a.sourceId,
    kind: a.kind,
    pdfAnchors: a.anchors.filter((x): x is PdfAnchor => x.kind === "pdf").map(anchorRecord),
    otherAnchorKinds: a.anchors.filter((x) => x.kind !== "pdf").map((x) => x.kind),
    ...(a.quote !== undefined ? { quote: a.quote } : {}),
    ...(a.body !== undefined ? { body: a.body } : {}),
    colorName,
    ...(showImported ? { importedColour: a.color! } : {}),
    imported,
    ...(a.pageLabel !== undefined ? { pageLabel: a.pageLabel } : {}),
    author: a.author,
    createdAt: a.createdAt,
    ...(a.modifiedAt !== undefined ? { modifiedAt: a.modifiedAt } : {}),
  };
}

/**
 * The reading order of a source's annotations: one document (file) at a time, since page 3 of one
 * PDF is not page 3 of another (A4); the documents in the order they first appear, annotations with
 * no PDF place last. Each document is ordered by `sortAnnotations` (R1).
 */
function inReadingOrder(list: readonly Annotation[]): Annotation[] {
  const groups = new Map<string, Annotation[]>();
  for (const a of list) {
    let first: PdfAnchor | undefined;
    for (const x of a.anchors) if (x.kind === "pdf" && (!first || x.page < first.page)) first = x;
    const key = first ? `a:${first.assetId}` : "";
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  const keys = [...groups.keys()].sort((x, y) => (x === "" ? 1 : y === "" ? -1 : 0));
  return keys.flatMap((k) => sortAnnotations(groups.get(k)!));
}

/** A request with a key the route does not take is refused, never silently ignored. */
function onlyKeys(b: object, allowed: readonly string[]): void {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw badRequest(`"${k}" is not part of an annotation request.`);
}

/** A quote, a note or a page label may hold a line break and a tab, no other control character; nothing is trimmed here. */
function noControlChars(...values: unknown[]): void {
  for (const v of values) if (typeof v === "string" && CONTROL_CHARS.test(v)) throw badRequest("A note cannot contain control characters.");
}

const uiOnly = (req: FastifyRequest): void => {
  if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
};

export function registerAnnotations(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const BASE = "/projects/:id/sources/:sid/annotations";

  app.get(BASE, async (req): Promise<AnnotationListResponse> => {
    uiOnly(req);
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const list = await s.repo.listAnnotations(projectId, paramsOf(req).sid ?? "");
    const text = list.reduce((n, a) => n + (a.body?.length ?? 0) + (a.quote?.length ?? 0), 0);
    return { annotations: inReadingOrder(list).map(annotationRecord), count: list.length, textChars: text };
  });

  app.post(BASE, { bodyLimit: ANNOTATION_BODY_LIMIT }, async (req, reply): Promise<AnnotationRecord> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyAs<AnnotationCreateRequest>(req);
    onlyKeys(b, CREATE_KEYS);
    noControlChars(b.quote, b.body, b.pageLabel);
    // Each value's shape and limits are checked by the library, in plain words naming the field.
    const draft = {
      kind: b.kind,
      assetId: b.assetId,
      anchors: b.anchors,
      colorName: b.colorName,
      ...(b.quote !== undefined ? { quote: b.quote } : {}),
      ...(b.body !== undefined ? { body: b.body } : {}),
      ...(b.pageLabel !== undefined ? { pageLabel: b.pageLabel } : {}),
    } as unknown as AnnotationDraft;
    const made = await s.repo.createAnnotation(projectId, paramsOf(req).sid ?? "", draft);
    void reply.status(201);
    return annotationRecord(made);
  });

  app.patch(`${BASE}/:anid`, { bodyLimit: ANNOTATION_BODY_LIMIT }, async (req): Promise<AnnotationRecord> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyAs<AnnotationUpdateRequest>(req);
    onlyKeys(b, UPDATE_KEYS);
    noControlChars(b.body);
    const patch = {
      ...(b.body !== undefined ? { body: b.body } : {}),
      ...(b.colorName !== undefined ? { colorName: b.colorName } : {}),
    } as unknown as AnnotationPatch;
    const p = paramsOf(req);
    return annotationRecord(await s.repo.updateAnnotation(projectId, p.sid ?? "", p.anid ?? "", patch));
  });

  app.delete(`${BASE}/:anid`, async (req): Promise<AnnotationDeleteResponse> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const p = paramsOf(req);
    const done = await s.repo.deleteAnnotation(projectId, p.sid ?? "", p.anid ?? "");
    return { deleted: true, id: done.id };
  });
}
