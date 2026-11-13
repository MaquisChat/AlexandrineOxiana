import type { Annotation } from "../model/annotation.js";
import type { PdfAnchor } from "../model/anchor.js";

/** The form of a Zotero sort index: "PPPPP|OOOOOO|TTTTT". */
export const SORT_INDEX_PATTERN = /^\d{5}\|\d{6}\|\d{5}$/;

const clampInt = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : n === Infinity ? max : 0);
const pad = (n: number, digits: number) => String(n).padStart(digits, "0");

/** Zotero's sort index, "PPPPP|OOOOOO|TTTTT" (page index from 0, character offset, distance from the page top); each part is clamped to its digits. */
export function pdfSortIndex(pageIndex: number, charOffset: number, top: number): string {
  return `${pad(clampInt(pageIndex, 99_999), 5)}|${pad(clampInt(charOffset, 999_999), 6)}|${pad(clampInt(top, 99_999), 5)}`;
}

interface Entry<T> {
  item: T;
  /** Earliest page of a pdf anchor; Infinity when it has none. */
  page: number;
  anchor?: PdfAnchor;
  top: number;
  left: number;
  time: number;
}

function entryOf<T extends Annotation>(item: T): Entry<T> {
  let anchor: PdfAnchor | undefined;
  for (const x of item.anchors) if (x.kind === "pdf" && (!anchor || x.page < anchor.page)) anchor = x;
  let top = -Infinity;
  let left = Infinity;
  if (anchor) {
    for (const r of anchor.rects) {
      if (r.y + r.h > top) top = r.y + r.h;
      if (r.x < left) left = r.x;
    }
  }
  const time = Date.parse(item.createdAt);
  return { item, page: anchor ? anchor.page : Infinity, anchor, top, left, time: Number.isNaN(time) ? 0 : time };
}

const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A copy of `list` in reading order. By page first (the earliest page of an annotation's pdf
 * anchors; annotations with no pdf anchor come last). Within a page: by stored `sortIndex` if EVERY
 * annotation of that page has one, otherwise the whole page geometrically (the highest rectangle
 * edge first, then the leftmost), never the two rules mixed (R195, A1). Ties go to creation time,
 * then id, so the order is total and stable.
 */
export function sortAnnotations<T extends Annotation>(list: readonly T[]): T[] {
  const entries = list.map(entryOf);
  const allStored = new Map<number, boolean>();
  for (const e of entries) allStored.set(e.page, (allStored.get(e.page) ?? true) && !!e.anchor?.sortIndex);
  return entries
    .sort((a, b) => {
      if (a.page !== b.page) return cmp(a.page, b.page);
      if (a.anchor && b.anchor) {
        const c = allStored.get(a.page) ? cmp(a.anchor.sortIndex!, b.anchor.sortIndex!) : cmp(b.top, a.top) || cmp(a.left, b.left);
        if (c) return c;
      }
      return cmp(a.time, b.time) || cmp(a.item.createdAt, b.item.createdAt) || cmp(a.item.id, b.item.id);
    })
    .map((e) => e.item);
}
