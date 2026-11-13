/**
 * Incremental re-import (R72; package-internal): what a changed item at its source (e.g. a Zotero
 * item whose version token changed) does to the source it was imported as.
 *
 * Only fields whose current value still equals the value the previous import recorded (the newest
 * field evidence of the item's evidence kind, e.g. 'zotero') are updated: a field the user (or
 * anything else) changed since is kept and reported. A field the previous import did not record is
 * filled only if the source lacks it. Every update adds the new value as evidence of that kind, so
 * the next re-import compares with it. Provenance is never touched. The plan is recorded as a
 * MergeRecord (filled fields with their values before and after, evidence, assets, tags and
 * annotations added), so undo reverts it exactly like a merge (R61).
 *
 * Also here: ScanAnnotation → Annotation, and unique citation keys.
 */
import { isDeepStrictEqual } from "node:util";
import { Annotation, BIBLIO_FIELDS, newId, primary, type Asset, type FieldEvidence, type MultiText, type SourceDraft, type SourceFile } from "@ao/core";
import { annotationHash, getAt, unedited, type FilledField } from "./merge.js";
import type { ScanAnnotation } from "./scan.js";

/** The fields an update may change, as JSON pointers (the ones resolution records evidence for, and the URL). */
export const UPDATABLE = [
  "/type", "/title", "/creators", "/issued", "/container", "/publisher",
  ...BIBLIO_FIELDS.map((k) => `/${k}` as const),
  "/identifiers/doi", "/identifiers/isbn", "/identifiers/issn", "/identifiers/arxiv", "/identifiers/url",
] as const;
/** Fields a source cannot be without: an update changes them but never removes them. */
const REQUIRED = new Set(["/type", "/title", "/creators"]);

const present = (v: unknown) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
const norm = (v: unknown) => (present(v) ? v : undefined);

/** A field's value as evidence records it (titles and containers as their primary text). */
function asEvidence(path: string, v: unknown): unknown {
  if (path === "/title" || path === "/container") return v && typeof v === "object" ? norm(primary(v as MultiText).trim()) : norm(v);
  return norm(v);
}

/** The item's reference values, per updatable field (evidence form). */
export function referenceValues(ref: Partial<SourceDraft>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const ids = (ref.identifiers ?? {}) as Record<string, unknown>;
  const all: Record<string, unknown> = {
    "/type": ref.type,
    "/title": ref.title,
    "/creators": ref.creators,
    "/issued": ref.issued,
    "/container": ref.container,
    "/publisher": ref.publisher,
    ...Object.fromEntries(BIBLIO_FIELDS.map((k) => [`/${k}`, ref[k]])),
    "/identifiers/doi": ids.doi,
    "/identifiers/isbn": ids.isbn,
    "/identifiers/issn": ids.issn,
    "/identifiers/arxiv": ids.arxiv,
    "/identifiers/url": ids.url,
  };
  for (const p of UPDATABLE) {
    const v = asEvidence(p, all[p]);
    if (v !== undefined) out.set(p, v);
  }
  return out;
}

/** A MultiText whose original text becomes `value` (other variants kept). */
function withPrimary(cur: MultiText | undefined, value: string, fallback: MultiText | undefined): MultiText {
  if (!cur) return fallback ?? { variants: [{ lang: "und", kind: "original", value }] };
  const i = cur.variants.findIndex((v) => v.kind === "original");
  const at = i >= 0 ? i : 0;
  const variants = cur.variants.map((v, k) => (k === at ? { lang: v.lang, kind: v.kind, value } : v));
  return { variants: variants.length ? variants : [{ lang: "und", kind: "original", value }] };
}

export interface UpdatePlan {
  filled: FilledField[];
  evidence: FieldEvidence[];
  /** Fields changed since the previous import: kept. */
  kept: string[];
}

/**
 * What an update changes on `cur` (see the module comment). `kind` is the evidence kind the
 * previous import recorded its values under; `source` the evidence source for the new ones.
 */
export function planUpdate(cur: SourceFile, ref: Partial<SourceDraft>, source: FieldEvidence["source"], at: string): UpdatePlan {
  const next = referenceValues(ref);
  const plan: UpdatePlan = { filled: [], evidence: [], kept: [] };
  const s = cur.source;
  for (const path of UPDATABLE) {
    let prev: unknown;
    let recorded = false;
    for (const e of cur.fieldEvidence) {
      if (e.field === path && e.source.kind === source.kind) {
        prev = norm(e.value);
        recorded = true;
      }
    }
    const nv = next.get(path);
    if (recorded && isDeepStrictEqual(nv, prev)) continue; // unchanged at the source
    const now = asEvidence(path, getAt(s, path));
    const evidence = nv === undefined ? [] : [{ field: path, value: nv, source, at }];
    if (isDeepStrictEqual(now, nv)) {
      // Already the new value: only record it (so the next re-import compares with it).
      if (nv !== undefined && !isDeepStrictEqual(prev, nv)) plan.evidence.push(...evidence);
      continue;
    }
    const mayChange = recorded ? isDeepStrictEqual(now, prev) : now === undefined;
    if (!mayChange) {
      // Changed since the previous import (by the user or another step): kept. A field the previous
      // import never recorded is not the import's to change, and not reported.
      if (recorded) plan.kept.push(path);
      continue;
    }
    if (nv === undefined && REQUIRED.has(path)) continue;
    const before = getAt(s, path);
    let after: unknown = nv;
    if (path === "/title") after = withPrimary(s.title, nv as string, ref.title);
    else if (path === "/container") after = withPrimary(s.container, nv as string, ref.container);
    plan.filled.push({ path, ...(before !== undefined ? { before } : {}), after });
    plan.evidence.push(...evidence);
  }
  return plan;
}

/**
 * A scanned annotation as stored: its anchor points into the asset its file became, or, for a file that was
 * not downloaded again (Z4: `assetSha256`), into the asset `assetBySha` finds by that hash (none: no anchor;
 * never a guess).
 */
export function toAnnotation(
  a: ScanAnnotation,
  sourceId: string,
  actor: string,
  assetFor: (file: string) => Asset | undefined,
  assetBySha?: (sha256: string) => Asset | undefined,
): Annotation {
  const asset = a.file ? assetFor(a.file) : a.assetSha256 && assetBySha ? assetBySha(a.assetSha256) : undefined;
  const anchors =
    asset && a.anchor
      ? [a.anchor.kind === "pdf" ? { kind: "pdf" as const, id: newId(), assetId: asset.id, page: a.anchor.page, rects: a.anchor.rects, ...(a.anchor.sortIndex ? { sortIndex: a.anchor.sortIndex } : {}) } : { kind: "epub-cfi" as const, id: newId(), assetId: asset.id, cfi: a.anchor.cfi }]
      : [];
  // A page number with no asset to anchor in is kept as the label.
  const pageLabel = a.pageLabel ?? (a.anchor?.kind === "pdf" && !anchors.length ? String(a.anchor.page) : undefined);
  const content = {
    kind: a.kind,
    anchors,
    ...(a.body ? { body: a.body } : {}),
    ...(a.quote ? { quote: a.quote } : {}),
    ...(a.color ? { color: a.color } : {}),
    ...(pageLabel ? { pageLabel: pageLabel.slice(0, 64) } : {}),
  };
  return Annotation.parse({
    id: newId(),
    sourceId,
    ...content,
    externalKey: a.key.slice(0, 256),
    externalHash: annotationHash(content),
    author: a.author || actor,
    createdAt: a.createdAt ?? new Date().toISOString(),
  });
}

/** Per source (R74 I4): at most this many annotations, and this much of their text in all. */
export const MAX_SOURCE_ANNOTATIONS = 10_000;
export const MAX_SOURCE_ANNOTATION_TEXT = 16 * 1024 * 1024;

const textOf = (a: { body?: string; quote?: string }) => (a.body?.length ?? 0) + (a.quote?.length ?? 0);

/** Takes annotations while the source stays within the caps (given what it already has, or its count and text); counts the rest. */
export function capAnnotations<T extends { body?: string; quote?: string }>(
  have: Array<{ body?: string; quote?: string }> | { count: number; chars: number },
  list: T[],
): { kept: T[]; dropped: number } {
  let count = Array.isArray(have) ? have.length : have.count;
  let chars = Array.isArray(have) ? have.reduce((n, a) => n + textOf(a), 0) : have.chars;
  const kept: T[] = [];
  for (const a of list) {
    const t = textOf(a);
    if (count + 1 > MAX_SOURCE_ANNOTATIONS || chars + t > MAX_SOURCE_ANNOTATION_TEXT) continue;
    count++;
    chars += t;
    kept.push(a);
  }
  return { kept, dropped: list.length - kept.length };
}

export interface AnnotationPlan {
  added: Annotation[];
  updated: Array<{ before: Annotation; after: Annotation }>;
  /**
   * Annotations imported before Zotero's sort index was kept, unchanged since: they gain it (R195). Not a
   * change to report, nor an edit (the hash ignores it), but written and recorded so undo puts it back.
   */
  backfilled: Array<{ before: Annotation; after: Annotation }>;
  /** External keys of annotations changed at the source but edited here: kept. */
  kept: string[];
  dropped: number;
  /** Annotations the researcher deleted here that the source still has: not added again. */
  deletedHere: number;
}

/** `ex` with the sort index of `next`'s anchors where it has none (same place, same rectangles); undefined when there is nothing to add. */
function withSortIndex(ex: Annotation, next: Annotation): Annotation | undefined {
  if (ex.anchors.length !== next.anchors.length) return undefined;
  let any = false;
  const anchors = ex.anchors.map((x, i) => {
    const n = next.anchors[i]!;
    if (x.kind !== "pdf" || n.kind !== "pdf" || x.sortIndex || !n.sortIndex || x.page !== n.page) return x;
    any = true;
    return { ...x, sortIndex: n.sortIndex };
  });
  return any ? { ...ex, anchors } : undefined;
}

/**
 * A re-import's annotations (R75): new ones (by external key) are added within the caps; one
 * changed at the source is updated while it is still as last imported (its content hash), and kept
 * (reported) when it was edited here since.
 */
export function planAnnotations(sf: SourceFile, scanned: ScanAnnotation[], make: (a: ScanAnnotation) => Annotation): AnnotationPlan {
  const byKey = new Map(sf.annotations.filter((a) => a.externalKey).map((a) => [a.externalKey!, a]));
  const plan: AnnotationPlan = { added: [], updated: [], backfilled: [], kept: [], dropped: 0, deletedHere: 0 };
  const deleted = new Set(sf.deletedAnnotationKeys ?? []);
  const fresh: Annotation[] = [];
  const seen = new Set<string>();
  for (const s of scanned) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const ex = byKey.get(s.key);
    if (!ex && deleted.has(s.key.slice(0, 256))) {
      plan.deletedHere++; // the researcher deleted it here: not brought back
      continue;
    }
    let next = make(s);
    if (ex && s.assetSha256 && s.anchor && !next.anchors.length && ex.anchors.length) {
      // Z4: the stored file it is anchored in is not among the source's assets (removed here, or a hash that
      // matches none). No asset is guessed: the one stored here keeps the anchors it has, and only what Zotero
      // says of its content is compared.
      // (The page is a label only when there is no anchor: with the anchors kept, only Zotero's own label stays.)
      const { pageLabel: _page, ...rest } = next;
      const base: Annotation = s.pageLabel ? { ...rest, pageLabel: s.pageLabel.slice(0, 64) } : rest;
      const anchors = ex.anchors;
      next = { ...base, anchors, externalHash: annotationHash({ ...base, anchors }) };
    }
    if (!ex) {
      fresh.push(next);
      continue;
    }
    if (ex.externalHash === next.externalHash) {
      // Unchanged at the source. One imported before the sort index was kept, and not changed here, gains it.
      if (ex.externalHash && unedited(ex)) {
        const after = withSortIndex(ex, next);
        if (after) plan.backfilled.push({ before: ex, after });
      }
      continue;
    }
    if (!unedited(ex)) {
      plan.kept.push(s.key);
      continue;
    }
    plan.updated.push({ before: ex, after: { ...next, id: ex.id, author: ex.author, createdAt: ex.createdAt } });
  }
  // Updates may grow the text too: within the 16 MB cap, in order; the rest is left as it is (counted).
  let chars = sf.annotations.reduce((n, a) => n + textOf(a), 0);
  const updates: AnnotationPlan["updated"] = [];
  for (const u of plan.updated) {
    const grown = chars - textOf(u.before) + textOf(u.after);
    if (grown > MAX_SOURCE_ANNOTATION_TEXT) {
      plan.dropped++;
      continue;
    }
    chars = grown;
    updates.push(u);
  }
  plan.updated = updates;
  const capped = capAnnotations({ count: sf.annotations.length, chars }, fresh);
  plan.added = capped.kept;
  plan.dropped += capped.dropped;
  return plan;
}

/**
 * The sort-index back-fills alone (R196), for an item Zotero did not change: no files are read or hashed.
 * Only an annotation that has no index yet, is as last imported and whose scanned content (anchored in the
 * asset it is already anchored in) hashes the same is touched; a source with none costs one pass over its list.
 */
export function planBackfill(sf: SourceFile, scanned: ScanAnnotation[]): Array<{ before: Annotation; after: Annotation }> {
  const out: Array<{ before: Annotation; after: Annotation }> = [];
  const byKey = new Map<string, Annotation>();
  for (const a of sf.annotations) {
    if (a.externalKey && a.externalHash && a.anchors.some((x) => x.kind === "pdf" && !x.sortIndex)) byKey.set(a.externalKey, a);
  }
  if (!byKey.size) return out;
  const seen = new Set<string>();
  for (const s of scanned) {
    const ex = byKey.get(s.key);
    if (!ex || seen.has(s.key) || s.anchor?.kind !== "pdf" || !s.anchor.sortIndex) continue;
    seen.add(s.key);
    const home = ex.anchors.find((x) => x.kind === "pdf");
    if (!home || !unedited(ex)) continue;
    const inHome = () => ({ id: home.assetId }) as Asset;
    const next = toAnnotation(s, sf.source.id, "", inHome, inHome);
    if (next.externalHash !== ex.externalHash) continue;
    const after = withSortIndex(ex, next);
    if (after) out.push({ before: ex, after });
  }
  return out;
}

/** `key`, or `key` + a, b, … z, aa, ab … — the first one not in `taken` (then taken). */
export function uniqueKey(taken: Set<string>, key: string): string {
  let out = key;
  for (let n = 0; taken.has(out); n++) out = key + suffix(n);
  taken.add(out);
  return out;
}

function suffix(n: number): string {
  let s = "";
  let k = n;
  do {
    s = String.fromCharCode(97 + (k % 26)) + s;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return s;
}
