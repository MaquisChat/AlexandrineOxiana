/**
 * The reader's annotations (Task R3): list, create, update and delete the highlights and page notes
 * of one source. Each change is ONE governed change (R26): the policy engine decides first (`store`
 * with the source's provenance for a create or an update, `delete` for a delete, R192 a), the source
 * is read again inside the change, its annotations file is written through `writeSourceFile` (R74 I4),
 * the change log records the annotation, the audit event commits it, and the search index follows.
 * The source's own record is not edited.
 *
 * An audit entry holds the annotation's id, its kind, counts and field names only: never a quote, a
 * note, a page label or anything else typed (R177), in every project.
 *
 * The per-source caps (10,000 annotations, 16 MB of quote and note text; the same as an import's,
 * `capAnnotations`) are enforced whole: a change that would pass one is refused and nothing is written.
 */
import { Annotation, HIGHLIGHT_COLOURS, SORT_INDEX_PATTERN, newId, type HighlightColourName, type SourceFile } from "@ao/core";
import { isPdfMime } from "../asset-content.js";
import { MAX_SOURCE_ANNOTATIONS, MAX_SOURCE_ANNOTATION_TEXT } from "../import/bulk/update.js";
import { InvalidInputError, NotFoundError } from "./errors.js";
import { runMutation, type Tx } from "./mutate.js";
import { readSourceFile, sourceFolderOf, storeRequest, writeSourceFile } from "./sources.js";
import type { ProjectState, RepoCore } from "./state.js";

export const ANNOTATION_CREATE_OP = "annotation.create";
export const ANNOTATION_UPDATE_OP = "annotation.update";
export const ANNOTATION_DELETE_OP = "annotation.delete";

/** Most anchors (pages) one annotation may have. */
const ANCHORS_MAX = 50;
/** Most rectangles one anchor may have. */
const RECTS_MAX = 1000;
const PAGE_MAX = 100_000;
/** Largest coordinate or size, in points, either way. */
const COORD_MAX = 1e6;
/** Longest quote, and longest note, in characters. */
const TEXT_MAX = 65_536;
/** Longest page label (the model's limit). */
const PAGE_LABEL_MAX = 64;
/** Most deleted imported keys a source remembers (the model's limit); the oldest go first. */
const DELETED_KEYS_MAX = 10_000;

const NOTE_NEEDS_BODY = "Write the note first.";

/** A change would pass one of the source's caps (R74 I4). Nothing was written. */
export class AnnotationLimitError extends Error {
  override name = "AnnotationLimitError";
  constructor(readonly kind: "count" | "text") {
    super(
      kind === "count"
        ? "This source already has 10,000 annotations, the most one source can hold. Delete some to add more."
        : "This source's annotations would pass 16 MB of text, the most one source can hold.",
    );
  }
}

/** A new highlight or page note on one PDF of the source. Ids, author and time are set by the library. */
export interface AnnotationDraft {
  kind: "highlight" | "note";
  assetId: string;
  /** One per page (distinct pages, 1 to 50); rectangles in PDF user space (see the pdf anchor). */
  anchors: Array<{ page: number; rects: Array<{ x: number; y: number; w: number; h: number }>; sortIndex?: string }>;
  quote?: string;
  body?: string;
  colorName: HighlightColourName;
  pageLabel?: string;
}

/** A change of an annotation: its note (`null` removes it) and its colour. */
export interface AnnotationPatch {
  body?: string | null;
  colorName?: HighlightColourName;
}

const textOf = (a: { body?: string | undefined; quote?: string | undefined }) => (a.body?.length ?? 0) + (a.quote?.length ?? 0);
const blank = (s: string | undefined | null): boolean => s == null || s.trim() === "";
const isColour = (v: unknown): v is HighlightColourName => typeof v === "string" && (HIGHLIGHT_COLOURS as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function invalid(message: string): never {
  throw new InvalidInputError(message);
}

/** Checks a draft's shape and limits (plain words naming the field); returns it with anchors in page order. */
function checkDraft(d: AnnotationDraft): AnnotationDraft {
  if (!isObject(d)) invalid("The annotation is missing.");
  if (d.kind !== "highlight" && d.kind !== "note") invalid("kind must be \"highlight\" or \"note\".");
  if (typeof d.assetId !== "string" || !d.assetId) invalid("assetId must name a file of the source.");
  if (!isColour(d.colorName)) invalid(`colorName must be one of ${HIGHLIGHT_COLOURS.join(", ")}.`);
  if (d.quote !== undefined && (typeof d.quote !== "string" || d.quote.length > TEXT_MAX)) invalid(`quote must be text of at most ${TEXT_MAX} characters.`);
  if (d.body !== undefined && (typeof d.body !== "string" || d.body.length > TEXT_MAX)) invalid(`body must be text of at most ${TEXT_MAX} characters.`);
  if (d.pageLabel !== undefined && (typeof d.pageLabel !== "string" || d.pageLabel.length > PAGE_LABEL_MAX)) invalid(`pageLabel must be text of at most ${PAGE_LABEL_MAX} characters.`);
  if (d.kind === "note" && blank(d.body)) invalid(NOTE_NEEDS_BODY);
  if (!Array.isArray(d.anchors) || d.anchors.length < 1 || d.anchors.length > ANCHORS_MAX) invalid(`anchors must hold between 1 and ${ANCHORS_MAX} pages.`);
  const pages = new Set<number>();
  for (const a of d.anchors) {
    if (!isObject(a)) invalid("Each anchor must give a page and its rectangles.");
    if (!Number.isInteger(a.page) || a.page < 1 || a.page > PAGE_MAX) invalid(`anchors: page must be a whole number from 1 to ${PAGE_MAX}.`);
    if (pages.has(a.page)) invalid("anchors: each page may appear only once.");
    pages.add(a.page);
    if (a.sortIndex !== undefined && (typeof a.sortIndex !== "string" || !SORT_INDEX_PATTERN.test(a.sortIndex))) invalid("anchors: sortIndex is not in the form 00000|000000|00000.");
    if (!Array.isArray(a.rects) || a.rects.length < 1 || a.rects.length > RECTS_MAX) invalid(`anchors: rects must hold between 1 and ${RECTS_MAX} rectangles.`);
    for (const r of a.rects) {
      if (!isObject(r)) invalid("anchors: each rectangle needs x, y, w and h.");
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = r[k];
        if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > COORD_MAX) invalid(`anchors: rects ${k} must be a number between -${COORD_MAX} and ${COORD_MAX}.`);
      }
      if (r.w < 0 || r.h < 0) invalid("anchors: rects w and h cannot be negative.");
    }
  }
  return { ...d, anchors: [...d.anchors].sort((a, b) => a.page - b.page) };
}

function checkPatch(p: AnnotationPatch): AnnotationPatch {
  if (!isObject(p)) invalid("The change is missing.");
  const hasBody = p.body !== undefined;
  const hasColour = p.colorName !== undefined;
  if (!hasBody && !hasColour) invalid("Nothing to change: give a body or a colorName.");
  if (hasBody && p.body !== null && (typeof p.body !== "string" || p.body.length > TEXT_MAX)) invalid(`body must be text of at most ${TEXT_MAX} characters, or null.`);
  if (hasColour && !isColour(p.colorName)) invalid(`colorName must be one of ${HIGHLIGHT_COLOURS.join(", ")}.`);
  return p;
}

/** Refuses a change that would pass a cap; `delta` is the change in text (an update gives back the old note's length). */
function checkCaps(list: readonly Annotation[], added: number, delta: number): void {
  if (added > 0 && list.length + added > MAX_SOURCE_ANNOTATIONS) throw new AnnotationLimitError("count");
  if (delta > 0 && list.reduce((n, a) => n + textOf(a), 0) + delta > MAX_SOURCE_ANNOTATION_TEXT) throw new AnnotationLimitError("text");
}

/** The guards every operation passes before anything is read: a writable library (for a change) and an unlocked project. */
function guard(core: RepoCore, projectId: string, write: boolean): ProjectState {
  if (write) core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  return st;
}

/** The source's annotations, as stored, through the full read (source.json and its annotations file). */
export async function listAnnotations(core: RepoCore, projectId: string, sourceId: string): Promise<Annotation[]> {
  const st = guard(core, projectId, false);
  return (await readSourceFile(core, st, sourceId)).annotations;
}

/** Writes the source with its new annotations inside the change, and has the index follow. */
async function writeAnnotations(core: RepoCore, tx: Tx, sf: SourceFile): Promise<void> {
  await writeSourceFile(core, tx, sf);
  tx.index((sink) => sink.indexSource(sf));
}

export async function createAnnotation(core: RepoCore, projectId: string, sourceId: string, draftIn: AnnotationDraft): Promise<Annotation> {
  const st = guard(core, projectId, true);
  const draft = checkDraft(draftIn);
  // The policy request needs the source's provenance (which never changes, R76); everything else is
  // read again inside the change.
  const current = await readSourceFile(core, st, sourceId);
  let made: Annotation | undefined;
  return runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const cur = await readSourceFile(core, tx.state, sourceId);
      const asset = cur.assets.find((a) => a.id === draft.assetId);
      if (!asset || asset.status === "destroyed") throw new NotFoundError("Asset", draft.assetId);
      if (!isPdfMime(asset.mime)) invalid("Highlights and notes can be made only on a PDF.");
      const quote = draft.quote ? draft.quote : undefined;
      const body = blank(draft.body) ? undefined : draft.body;
      checkCaps(cur.annotations, 1, textOf({ quote, body }));
      const ann = Annotation.parse({
        id: newId(),
        sourceId,
        kind: draft.kind,
        anchors: draft.anchors.map((a) => ({
          kind: "pdf",
          id: newId(),
          assetId: asset.id,
          page: a.page,
          rects: a.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
          ...(a.sortIndex !== undefined ? { sortIndex: a.sortIndex } : {}),
        })),
        ...(quote !== undefined ? { quote } : {}),
        ...(body !== undefined ? { body } : {}),
        colorName: draft.colorName,
        ...(draft.pageLabel ? { pageLabel: draft.pageLabel } : {}),
        author: tx.actor,
        createdAt: tx.at,
      });
      await writeAnnotations(core, tx, { ...cur, annotations: [...cur.annotations, ann] });
      tx.record("annotation", ann.id, null, ann);
      made = ann;
      return ann;
    },
    {
      op: ANNOTATION_CREATE_OP,
      entity: { type: "source", id: sourceId },
      auditDetails: () => ({ annotation: made!.id, kind: made!.kind, anchorCount: made!.anchors.length, hasNote: made!.body !== undefined }),
    },
  );
}

/** Thrown inside a change that turns out to change nothing: it is abandoned (nothing written or audited). */
class Unchanged extends Error {
  constructor(readonly annotation: Annotation) {
    super("unchanged");
  }
}

export async function updateAnnotation(core: RepoCore, projectId: string, sourceId: string, annotationId: string, patchIn: AnnotationPatch): Promise<Annotation> {
  const st = guard(core, projectId, true);
  const patch = checkPatch(patchIn);
  const current = await readSourceFile(core, st, sourceId);
  let done: { kind: Annotation["kind"]; changed: Array<"body" | "colorName"> } | undefined;
  try {
    return await runMutation(
      core,
      projectId,
      storeRequest(current.source.provenance),
      async (tx) => {
        const cur = await readSourceFile(core, tx.state, sourceId);
        const before = cur.annotations.find((a) => a.id === annotationId);
        if (!before) throw new NotFoundError("Annotation", annotationId);
        const changed: Array<"body" | "colorName"> = [];
        let body = before.body;
        if (patch.body !== undefined) {
          // An empty or blank note is no note.
          const next = blank(patch.body) ? undefined : (patch.body as string);
          if (before.kind === "note" && next === undefined) invalid(NOTE_NEEDS_BODY);
          if (next !== before.body) changed.push("body");
          body = next;
        }
        if (patch.colorName !== undefined && patch.colorName !== before.colorName) changed.push("colorName");
        if (!changed.length) throw new Unchanged(before);
        checkCaps(cur.annotations, 0, (body?.length ?? 0) - (before.body?.length ?? 0));
        const { body: _old, ...rest } = before;
        const after = Annotation.parse({
          ...rest,
          ...(body !== undefined ? { body } : {}),
          ...(patch.colorName !== undefined ? { colorName: patch.colorName } : {}),
          modifiedAt: tx.at,
          modifiedBy: tx.actor,
        });
        await writeAnnotations(core, tx, { ...cur, annotations: cur.annotations.map((a) => (a.id === annotationId ? after : a)) });
        tx.record("annotation", annotationId, before, after);
        done = { kind: after.kind, changed };
        return after;
      },
      {
        op: ANNOTATION_UPDATE_OP,
        entity: { type: "source", id: sourceId },
        auditDetails: () => ({ annotation: annotationId, kind: done!.kind, changed: done!.changed }),
      },
    );
  } catch (err) {
    if (err instanceof Unchanged) return err.annotation;
    throw err;
  }
}

export async function deleteAnnotation(core: RepoCore, projectId: string, sourceId: string, annotationId: string): Promise<{ id: string; external: boolean }> {
  const st = guard(core, projectId, true);
  sourceFolderOf(st, sourceId);
  let done: { kind: Annotation["kind"]; external: boolean } | undefined;
  return runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      const cur = await readSourceFile(core, tx.state, sourceId);
      const before = cur.annotations.find((a) => a.id === annotationId);
      if (!before) throw new NotFoundError("Annotation", annotationId);
      const key = before.externalKey;
      let sf: SourceFile = { ...cur, annotations: cur.annotations.filter((a) => a.id !== annotationId) };
      // An imported annotation deleted here is remembered, so a re-import does not bring it back (R192 c);
      // a key already remembered moves to the newest end, and the oldest go past the limit.
      if (key !== undefined) sf = { ...sf, deletedAnnotationKeys: [...(cur.deletedAnnotationKeys ?? []).filter((k) => k !== key), key].slice(-DELETED_KEYS_MAX) };
      await writeAnnotations(core, tx, sf);
      tx.record("annotation", annotationId, before, null);
      done = { kind: before.kind, external: key !== undefined };
      return { id: annotationId, external: key !== undefined };
    },
    {
      op: ANNOTATION_DELETE_OP,
      entity: { type: "source", id: sourceId },
      auditDetails: () => ({ annotation: annotationId, kind: done!.kind, external: done!.external }),
    },
  );
}
