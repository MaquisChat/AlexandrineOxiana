/**
 * Where a stored rectangle lies on a drawn page (Task R8).
 *
 * Every annotation's place is stored as rectangles in PDF user space: points, origin at the bottom
 * left, y up, the page unrotated, `{x, y, w, h}` with (x, y) the lower-left corner — Zotero's
 * rectangles as imported (Task R2) and the reader's own alike (packages/shared PdfRectDto). The one
 * way such a rectangle reaches the screen is `pdfRectToBox`, through the page's own pdf.js viewport,
 * so that zoom, the view's rotation, the page's /Rotate, its crop box (which need not start at the
 * origin) and its UserUnit are all applied exactly as pdf.js draws the page itself.
 *
 * pdf.js 6.4.299's PageViewport no longer has `convertToViewportRectangle` (the plan names it); it
 * was the two corners through `convertToViewportPoint`, ordered, which is what this does.
 */
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfRectDto } from "../api/reader";

/** A box on the drawn page, in CSS pixels from the page's top-left corner. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A PDF rectangle (user space) as a box on the page drawn at `viewport`. */
export function pdfRectToBox(rect: PdfRectDto, viewport: PageViewport): Box {
  const [ax, ay] = viewport.convertToViewportPoint(rect.x, rect.y) as [number, number];
  const [bx, by] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h) as [number, number];
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

/**
 * Which side of a box is the foot of the words in it (the rectangle's lower edge in PDF space), for
 * the view's total rotation (the page's /Rotate and the view's own): bottom, left, top or right.
 */
export function footEdge(viewport: PageViewport): "bottom" | "left" | "top" | "right" {
  const r = (((viewport.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  return r === 90 ? "left" : r === 180 ? "top" : r === 270 ? "right" : "bottom";
}
