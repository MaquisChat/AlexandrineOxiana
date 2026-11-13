/**
 * The reader's annotations (PDF reader plan, Task R4): list, create, recolour or annotate, and delete
 * the highlights and page notes of one source, over the library's governed operations (R3). The
 * desktop app's token only. Request and response shapes are declared once in @ao/shared
 * (api/annotations.ts); a renamed field there breaks this file's build, optional fields included.
 *
 * The list's order: one document (file) at a time, since page 3 of one PDF is not page 3 of another
 * (A4). The documents come in the order they first appear in the source's stored annotations; the
 * annotations with no PDF place come last. Within a document the order is `sortAnnotations` (R1).
 *
 * What may be typed: a note may hold a line break (U+000A) and a tab, a quote the same (a PDF's text
 * breaks lines), a page label neither; no other control character anywhere, a carriage return
 * included. Nothing is trimmed. A note with nothing visible in it (only white space or invisible characters) is refused; an empty one (or null on update)
 * means no note. R3's own validation accepts any text for a quote, so this is the stricter rule.
 *
 * Nothing typed is ever logged (the request logger holds no body) or audited (R177, in the library).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZOTERO_REFERENCE_COLOURS, highlightColourOf, pdfSortIndex, sortAnnotations, type Annotation, type PdfAnchor } from "@ao/core";
import { NotFoundError, type AnnotationDraft, type AnnotationPatch } from "@ao/library";
import type {
  AnnotationCreateRequest,
  AnnotationDeleteResponse,
  AnnotationListResponse,
  AnnotationRecord,
  AnnotationUpdateRequest,
  PdfAnchorRecord,
} from "@ao/shared";
import { ApiError, badRequest, notFound } from "../errors.js";
import { bodyOf, paramsOf, projectParam, type Ctx, type Same } from "./util.js";

/** A request body of these routes is at most 1 MB (R96). */
export const ANNOTATION_BODY_LIMIT = 1024 * 1024;

// The shared request types and the library's own are one and the same: a change on either side breaks the build.
true satisfies Same<AnnotationCreateRequest, AnnotationDraft>;
true satisfies Same<AnnotationUpdateRequest, AnnotationPatch>;
// Mutual assignability ignores an optional field renamed on one side, so the keys are held equal too
// (a renamed `quote` or `body` would otherwise be silently dropped by the library).
true satisfies Same<keyof AnnotationCreateRequest, keyof AnnotationDraft>;
true satisfies Same<keyof AnnotationCreateRequest["anchors"][number], keyof AnnotationDraft["anchors"][number]>;
true satisfies Same<keyof AnnotationUpdateRequest, keyof AnnotationPatch>;
// The answer's text fields exist, under the same names, on the stored annotation.
true satisfies Same<"quote" | "body" | "pageLabel" | "modifiedAt" extends keyof Annotation ? true : false, true>;

/** Any control character (C0, DEL, C1). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** The same, except a tab and a line break (a carriage return is refused: the interface sends line breaks only). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_TAB_LF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const CREATE_KEYS: ReadonlyArray<keyof AnnotationCreateRequest> = ["kind", "assetId", "anchors", "quote", "body", "colorName", "pageLabel"];
const UPDATE_KEYS: ReadonlyArray<keyof AnnotationUpdateRequest> = ["body", "colorName"];
const ANCHOR_KEYS: ReadonlyArray<keyof AnnotationCreateRequest["anchors"][number]> = ["page", "rects", "sortIndex"];
const RECT_KEYS: ReadonlyArray<keyof AnnotationCreateRequest["anchors"][number]["rects"][number]> = ["x", "y", "w", "h"];

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
 * the named colour's reference value. Built by assignment into a typed object, so that every field
 * of the shared type, the optional ones included, is checked by the compiler (R184).
 */
export function annotationRecord(a: Annotation): AnnotationRecord {
  const colorName = highlightColourOf(a);
  const imported = a.externalKey !== undefined;
  const out: AnnotationRecord = {
    id: a.id,
    sourceId: a.sourceId,
    kind: a.kind,
    pdfAnchors: a.anchors.filter((x): x is PdfAnchor => x.kind === "pdf").map(anchorRecord),
    otherAnchorKinds: a.anchors.filter((x) => x.kind !== "pdf").map((x) => x.kind),
    colorName,
    imported,
    author: a.author,
    createdAt: a.createdAt,
  };
  if (a.quote !== undefined) out.quote = a.quote;
  if (a.body !== undefined) out.body = a.body;
  if (imported && a.color !== undefined && a.color.trim().toLowerCase() !== ZOTERO_REFERENCE_COLOURS[colorName].toLowerCase()) out.importedColour = a.color;
  if (a.pageLabel !== undefined) out.pageLabel = a.pageLabel;
  if (a.modifiedAt !== undefined) out.modifiedAt = a.modifiedAt;
  return out;
}

/** One document (file) at a time (A4); see the header for the order of the documents. */
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

const isObj = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Nothing visible: after removing every Unicode white-space character (`White_Space`) and every
 * invisible format character (`Default_Ignorable_Code_Point`: zero-width spaces and joiners, the word
 * joiner, the byte-order mark, soft hyphen and others), nothing remains. Both are properties the
 * regular-expression engine offers; the empty string is not "nothing visible" (it means no note).
 */
const NOTHING_VISIBLE = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]+$/u;

/** What may be typed: see the header. Nothing is trimmed. */
function checkText(v: { quote?: unknown; body?: unknown; pageLabel?: unknown }): void {
  const control = () => badRequest("A note cannot contain control characters.");
  if (typeof v.quote === "string" && CONTROL_CHARS_EXCEPT_TAB_LF.test(v.quote)) throw control();
  if (typeof v.body === "string") {
    if (CONTROL_CHARS_EXCEPT_TAB_LF.test(v.body)) throw control();
    if (NOTHING_VISIBLE.test(v.body)) throw badRequest("A note cannot be only spaces.");
  }
  if (typeof v.pageLabel === "string" && CONTROL_CHARS.test(v.pageLabel)) throw control();
}

/** A nested object with a key the route does not take is refused too, not dropped. */
function checkAnchors(anchors: unknown): void {
  if (!Array.isArray(anchors)) return;
  for (const a of anchors) {
    if (!isObj(a)) continue;
    onlyKeys(a, ANCHOR_KEYS);
    const rects = (a as { rects?: unknown }).rects;
    if (Array.isArray(rects)) for (const r of rects) if (isObj(r)) onlyKeys(r, RECT_KEYS);
  }
}

/** A library "not found" in plain words that never echo what was typed in the address. */
async function plainNotFound<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    const what = err.message.split(" ")[0];
    if (what === "Asset") throw new ApiError(404, "NOT_FOUND", "That file is not part of this source.");
    throw notFound(what === "Annotation" ? "That highlight or note" : "That source");
  }
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
    const list = await plainNotFound(() => s.repo.listAnnotations(projectId, paramsOf(req).sid ?? ""));
    const text = list.reduce((n, a) => n + (a.body?.length ?? 0) + (a.quote?.length ?? 0), 0);
    return { annotations: inReadingOrder(list).map(annotationRecord), count: list.length, textChars: text };
  });

  app.post(BASE, { bodyLimit: ANNOTATION_BODY_LIMIT }, async (req, reply): Promise<AnnotationRecord> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    onlyKeys(b, CREATE_KEYS);
    checkText(b);
    checkAnchors(b.anchors);
    // Each value's shape and limits are checked by the library, in plain words naming the field; the
    // assignment holds the request type and the library's draft together.
    const draft: AnnotationDraft = b as unknown as AnnotationCreateRequest;
    const made = await plainNotFound(() => s.repo.createAnnotation(projectId, paramsOf(req).sid ?? "", draft));
    void reply.status(201);
    return annotationRecord(made);
  });

  app.patch(`${BASE}/:anid`, { bodyLimit: ANNOTATION_BODY_LIMIT }, async (req): Promise<AnnotationRecord> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    onlyKeys(b, UPDATE_KEYS);
    checkText(b);
    const patch: AnnotationPatch = b as unknown as AnnotationUpdateRequest;
    const p = paramsOf(req);
    return annotationRecord(await plainNotFound(() => s.repo.updateAnnotation(projectId, p.sid ?? "", p.anid ?? "", patch)));
  });

  app.delete(`${BASE}/:anid`, async (req): Promise<AnnotationDeleteResponse> => {
    uiOnly(req);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const p = paramsOf(req);
    const done = await plainNotFound(() => s.repo.deleteAnnotation(projectId, p.sid ?? "", p.anid ?? ""));
    return { deleted: true, id: done.id };
  });
}
