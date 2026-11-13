import type { Annotation } from "../model/annotation.js";
import type { Anchor } from "../model/anchor.js";

type PdfAnchor = Extract<Anchor, { kind: "pdf" }>;

const clampInt = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : n === Infinity ? max : 0);
const pad = (n: number, digits: number) => String(n).padStart(digits, "0");

/** Zotero's sort index, "PPPPP|OOOOOO|TTTTT" (page index from 0, character offset, distance from the page top); each part is clamped to its digits. */
export function pdfSortIndex(pageIndex: number, charOffset: number, top: number): string {
  return `${pad(clampInt(pageIndex, 99_999), 5)}|${pad(clampInt(charOffset, 999_999), 6)}|${pad(clampInt(top, 99_999), 5)}`;
}

/**
 * The anchor's stored sort index, or one derived from its geometry: the page, offset 0, and, since the
 * page height is not kept, `100000 - floor(maxY)` of its highest rectangle (PDF user space has y up),
 * so a higher rectangle sorts first.
 */
export function derivedSortIndex(anchor: PdfAnchor): string {
  if (anchor.sortIndex) return anchor.sortIndex;
  const maxY = Math.max(...anchor.rects.map((r) => r.y + r.h));
  return pdfSortIndex(anchor.page - 1, 0, 100_000 - Math.floor(Number.isFinite(maxY) ? maxY : 0));
}

/** A string that orders annotations by reading position: first anchor's index, then createdAt, then id. Annotations with no pdf anchor sort last. */
export function annotationSortKey(a: Annotation): string {
  const first = a.anchors.find((x): x is PdfAnchor => x.kind === "pdf");
  const idx = first ? derivedSortIndex(first) : "99999|999999|99999~";
  return `${idx}|${a.createdAt}|${a.id}`;
}
