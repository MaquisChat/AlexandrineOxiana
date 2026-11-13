/**
 * Merging an item into an existing source, and reverting exactly that merge (R61). A merge adds
 * originals, the item's tags the source lacks (R66), and fills only the fields the source lacks; it
 * records what it added (asset ids, tag ids, each filled field with its value before and after, the
 * evidence added) in the batch journal. Undo removes those assets and tags and puts back only the
 * fields that still hold the value the merge set: a field the user changed since is kept (and
 * reported), and other batches' files are never touched. Whether a tag the batch created is then
 * deleted is undo's tag rule (kept while a surviving source uses it, R61).
 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { BIBLIO_FIELDS, type Annotation, type Asset, type FieldEvidence, type Source, type SourceDraft, type SourceFile } from "@ao/core";

/** Hash of an annotation's content (kind, text, colour, page label, anchors without their ids): what Annotation.externalHash records. */
export function annotationHash(a: Pick<Annotation, "kind" | "body" | "quote" | "color" | "pageLabel" | "anchors"> & { colorName?: string }): string {
  // The sort index is ordering, not content (R195): giving an annotation one, or a newer one, must not make it read as edited here.
  const anchors = a.anchors.map((x) => {
    const { id: _id, ...rest } = x;
    if ("sortIndex" in rest) delete (rest as { sortIndex?: string }).sortIndex;
    return rest;
  });
  // The colour chosen here is content, but appended only when present: every hash made before it existed stays as it was.
  const parts: unknown[] = [a.kind, a.body ?? null, a.quote ?? null, a.color ?? null, a.pageLabel ?? null, anchors];
  if (a.colorName) parts.push(a.colorName);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Whether an imported annotation is still as it was imported (nobody edited it here). */
export const unedited = (a: Annotation) => !a.externalHash || annotationHash(a) === a.externalHash;

export interface FilledField {
  /** JSON pointer: /type, /creators, /issued, /container, /publisher or /identifiers/<key>. */
  path: string;
  /** The value before the merge (absent: the field was not set). */
  before?: unknown;
  after: unknown;
}

export interface MergeRecord {
  addedAssetIds: string[];
  filled: FilledField[];
  addedEvidence: FieldEvidence[];
  /** Tag ids the merge put on the source (absent in records written before R66). */
  addedTagIds?: string[];
  /** Annotations (and notes) the merge or update added (R72). */
  addedAnnotationIds?: string[];
  /** Imported annotations an update changed (R75): undo puts back `before` while the annotation is still `after`. */
  updatedAnnotations?: Array<{ before: Annotation; after: Annotation }>;
  /** Zotero item keys a merge added to the target's `mergedExternalKeys.zotero` (R74 M5; outside provenance, R76). */
  addedMergedKeys?: string[];
  /** Updates (R72): fields kept because they were changed after the last import (JSON pointers). */
  kept?: string[];
}

type Src = SourceFile["source"];

export function getAt(s: Src, path: string): unknown {
  const [, a, b] = path.split("/");
  const v = (s as unknown as Record<string, unknown>)[a!];
  return b === undefined ? v : (v as Record<string, unknown> | undefined)?.[b];
}

export function setAt(s: Src, path: string, value: unknown): Src {
  const [, a, b] = path.split("/");
  const out = { ...s } as unknown as Record<string, unknown>;
  if (b === undefined) {
    if (value === undefined) delete out[a!];
    else out[a!] = value;
  } else {
    const inner = { ...((out[a!] as Record<string, unknown>) ?? {}) };
    if (value === undefined) delete inner[b];
    else inner[b] = value;
    out[a!] = inner;
  }
  return out as unknown as Src;
}

/** The fields a merge may fill: only those the existing source lacks (its title is never changed). */
export function missingFields(cur: SourceFile, d: SourceDraft): FilledField[] {
  const s: Source = cur.source;
  const out: FilledField[] = [];
  if (s.type === "other" && d.type !== "other") out.push({ path: "/type", before: s.type, after: d.type });
  if (s.creators.length === 0 && d.creators.length) out.push({ path: "/creators", before: s.creators, after: d.creators });
  if (!s.issued && d.issued) out.push({ path: "/issued", after: d.issued });
  if (!s.container && d.container) out.push({ path: "/container", after: d.container });
  if (!s.publisher && d.publisher) out.push({ path: "/publisher", after: d.publisher });
  for (const k of BIBLIO_FIELDS) if (!s[k] && d[k]) out.push({ path: `/${k}`, after: d[k] });
  for (const [k, v] of Object.entries(d.identifiers)) {
    if (v !== undefined && (s.identifiers as Record<string, unknown>)[k] === undefined) out.push({ path: `/identifiers/${k}`, after: v });
  }
  return out;
}

/** The merged source file and the record of what the merge added. */
export function applyMerge(
  cur: SourceFile,
  added: Asset[],
  fill: FilledField[],
  evidence: FieldEvidence[],
  at: string,
  actor: string,
  tagIds: string[] = [],
  /** Zotero item keys merged in (R74 M5): remembered in the target's `mergedExternalKeys` (never provenance, R76), so deleting it keeps them deleted. */
  mergedKeys: string[] = [],
): { next: SourceFile; record: MergeRecord } {
  let source: Src = { ...cur.source, modifiedAt: at, modifiedBy: actor };
  // Merged Zotero keys go on the source file, never into provenance (R76).
  const already = cur.mergedExternalKeys?.zotero ?? [];
  const have = new Set([source.provenance.externalKeys?.zoteroKey, ...already].filter(Boolean));
  const addedMergedKeys = [...new Set(mergedKeys)].filter((k) => !have.has(k));
  const mergedExternalKeys = addedMergedKeys.length ? { ...(cur.mergedExternalKeys ?? {}), zotero: [...already, ...addedMergedKeys] } : cur.mergedExternalKeys;
  for (const f of fill) source = setAt(source, f.path, f.after);
  const addedTagIds = [...new Set(tagIds)].filter((t) => !cur.source.tagIds.includes(t));
  if (addedTagIds.length) source = { ...source, tagIds: [...source.tagIds, ...addedTagIds] };
  const paths = new Set(fill.map((f) => f.path));
  const addedEvidence = evidence.filter((e) => paths.has(e.field));
  return {
    next: {
      ...cur,
      source,
      assets: [...cur.assets, ...added],
      fieldEvidence: [...cur.fieldEvidence, ...addedEvidence],
      ...(mergedExternalKeys ? { mergedExternalKeys } : {}),
    },
    record: {
      addedAssetIds: added.map((a) => a.id),
      filled: fill,
      addedEvidence,
      ...(addedTagIds.length ? { addedTagIds } : {}),
      ...(addedMergedKeys.length ? { addedMergedKeys } : {}),
    },
  };
}

/** Reverts one merge on the source as it is now; returns the assets to remove and the fields kept (changed since). */
export function revertMerge(
  cur: SourceFile,
  rec: MergeRecord,
  at: string,
  actor: string,
): { next: SourceFile; removed: Asset[]; kept: string[]; keptAnnotations: string[]; changed: boolean } {
  const ids = new Set(rec.addedAssetIds);
  // Derived assets made from a removed original (its viewing proxy, R85 I1) go with it.
  for (const a of cur.assets) if (a.derivation?.parents.some((p) => ids.has(p))) ids.add(a.id);
  const removed = cur.assets.filter((a) => ids.has(a.id));
  const pendingLeft = (cur.pendingProxies ?? []).filter((j) => !ids.has(j.assetId));
  let source: Src = cur.source;
  const kept: string[] = [];
  const reverted = new Set<string>();
  for (const f of rec.filled) {
    if (isDeepStrictEqual(getAt(source, f.path), f.after)) {
      source = setAt(source, f.path, f.before);
      reverted.add(f.path);
    } else kept.push(f.path);
  }
  const dropTags = new Set((rec.addedTagIds ?? []).filter((t) => source.tagIds.includes(t)));
  if (dropTags.size) source = { ...source, tagIds: source.tagIds.filter((t) => !dropTags.has(t)) };
  const drop = new Set(rec.addedEvidence.filter((e) => reverted.has(e.field)).map((e) => JSON.stringify(e)));
  // Annotations: added ones go and updated ones are put back — unless edited here since (kept, R74 M3).
  const keptAnnotations: string[] = [];
  const annIds = new Set<string>();
  for (const a of cur.annotations) {
    if (!(rec.addedAnnotationIds ?? []).includes(a.id)) continue;
    if (unedited(a)) annIds.add(a.id);
    else keptAnnotations.push(a.id);
  }
  const restore = new Map<string, Annotation>();
  for (const u of rec.updatedAnnotations ?? []) {
    const now = cur.annotations.find((a) => a.id === u.after.id);
    if (!now) continue;
    if (isDeepStrictEqual(now, u.after)) restore.set(now.id, u.before);
    else keptAnnotations.push(now.id);
  }
  // Merged Zotero keys the merge added come off again (R76: on the source file, not provenance).
  const dropKeys = new Set(rec.addedMergedKeys ?? []);
  let mergedExternalKeys = cur.mergedExternalKeys;
  if (dropKeys.size && mergedExternalKeys?.zotero) {
    const { zotero, ...others } = mergedExternalKeys;
    const left = zotero.filter((k) => !dropKeys.has(k));
    mergedExternalKeys = left.length ? { ...others, zotero: left } : Object.keys(others).length ? others : undefined;
  }
  const droppedAnnotations = annIds.size > 0 || restore.size > 0;
  const droppedPending = pendingLeft.length !== (cur.pendingProxies ?? []).length;
  const changed = removed.length > 0 || reverted.size > 0 || dropTags.size > 0 || droppedAnnotations || dropKeys.size > 0 || droppedPending;
  const { mergedExternalKeys: _m, pendingProxies: _p, ...base } = cur;
  return {
    next: {
      ...base,
      ...(mergedExternalKeys ? { mergedExternalKeys } : {}),
      ...(pendingLeft.length ? { pendingProxies: pendingLeft } : {}),
      source: changed ? { ...source, modifiedAt: at, modifiedBy: actor } : source,
      assets: cur.assets.filter((a) => !ids.has(a.id)),
      // An annotation anchored in a removed asset goes with it.
      annotations: cur.annotations
        .filter((a) => !annIds.has(a.id))
        .map((a) => restore.get(a.id) ?? a)
        .map((a) => ({ ...a, anchors: a.anchors.filter((x) => !ids.has(x.assetId)) })),
      fieldEvidence: cur.fieldEvidence.filter((e) => !drop.has(JSON.stringify(e))),
    },
    removed,
    kept,
    keptAnnotations,
    changed,
  };
}
