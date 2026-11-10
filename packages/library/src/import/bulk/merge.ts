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
import type { Asset, FieldEvidence, Source, SourceDraft, SourceFile } from "@ao/core";

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
}

type Src = SourceFile["source"];

function getAt(s: Src, path: string): unknown {
  const [, a, b] = path.split("/");
  const v = (s as unknown as Record<string, unknown>)[a!];
  return b === undefined ? v : (v as Record<string, unknown> | undefined)?.[b];
}

function setAt(s: Src, path: string, value: unknown): Src {
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
): { next: SourceFile; record: MergeRecord } {
  let source: Src = { ...cur.source, modifiedAt: at, modifiedBy: actor };
  for (const f of fill) source = setAt(source, f.path, f.after);
  const addedTagIds = [...new Set(tagIds)].filter((t) => !cur.source.tagIds.includes(t));
  if (addedTagIds.length) source = { ...source, tagIds: [...source.tagIds, ...addedTagIds] };
  const paths = new Set(fill.map((f) => f.path));
  const addedEvidence = evidence.filter((e) => paths.has(e.field));
  return {
    next: { ...cur, source, assets: [...cur.assets, ...added], fieldEvidence: [...cur.fieldEvidence, ...addedEvidence] },
    record: { addedAssetIds: added.map((a) => a.id), filled: fill, addedEvidence, ...(addedTagIds.length ? { addedTagIds } : {}) },
  };
}

/** Reverts one merge on the source as it is now; returns the assets to remove and the fields kept (changed since). */
export function revertMerge(cur: SourceFile, rec: MergeRecord, at: string, actor: string): { next: SourceFile; removed: Asset[]; kept: string[]; changed: boolean } {
  const ids = new Set(rec.addedAssetIds);
  const removed = cur.assets.filter((a) => ids.has(a.id));
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
  const changed = removed.length > 0 || reverted.size > 0 || dropTags.size > 0;
  return {
    next: {
      ...cur,
      source: changed ? { ...source, modifiedAt: at, modifiedBy: actor } : source,
      assets: cur.assets.filter((a) => !ids.has(a.id)),
      fieldEvidence: cur.fieldEvidence.filter((e) => !drop.has(JSON.stringify(e))),
    },
    removed,
    kept,
    changed,
  };
}
