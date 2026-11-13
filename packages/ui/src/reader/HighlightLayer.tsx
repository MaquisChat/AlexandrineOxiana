/**
 * The highlights of one drawn page (Task R8): every annotation of the open file with a place on
 * this page, drawn from its PDF rectangles through `pdfRectToBox` — the same code for highlights
 * imported from Zotero and for those made in the reader, right at every zoom, view rotation, /Rotate
 * and crop box.
 *
 *  - Light: one absolutely placed element per rectangle, inside the page's overlay (no canvas, so
 *    the reader's memory budget, A9, is untouched). A page with 1,000 rectangles is 1,001 elements.
 *    The layer is memoised: scrolling never re-creates its marks; a zoom or a rotation does (the page
 *    is drawn anew at its new size, and its overlay with it).
 *  - Colour by class only (`ao-hl--yellow` … `ao-hl--grey`, Reader.css, from the `--hl-*` tokens);
 *    the style carries the box and nothing else.
 *  - Never by colour alone: each kind has its shape — a highlight is a fill, an underline a line at
 *    the words' foot (whichever way the page is turned), a note a note mark, an imported area or
 *    drawing (and anything else with a place) an outlined box; a highlight whose text has changed
 *    is drawn dashed; the chosen one has a ring.
 *  - Hidden from assistive technology (`aria-hidden`), with no text in it: the list of annotations
 *    (Task R9) is the accessible route, and says what the shapes show.
 *  - A click on the page that lands on a highlight selects it (the topmost where several lie); a
 *    click that ends a text selection does not. The marks take no pointer events, so text under a
 *    highlight can still be selected.
 *
 * `annotations` are the open file's only (the caller filters by file, A4); an annotation with no
 * place (A5) or a place on another page is not drawn here.
 *
 * What the shapes show (the text changed, a page the file does not have) is said in the annotation
 * list (Task R9, AnnotationList.tsx), which replaced R8's temporary region (A11).
 */
import { memo, useEffect, useMemo, useRef } from "react";
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AnnotationKind, AnnotationRecord } from "../api/reader";
import { footEdge, pdfRectToBox, type Box } from "./geometry";

export interface HighlightLayerProps {
  /** 0-based, as PdfPages gives it (anchors store 1-based pages). */
  pageIndex: number;
  viewport: PageViewport;
  /** The open file's annotations. */
  annotations: AnnotationRecord[];
  selectedId?: string;
  onSelect(id: string): void;
  /** Annotations whose quote no longer matches the text under them. */
  changed: ReadonlySet<string>;
}

type Shape = "fill" | "underline" | "note" | "box";
const shapeOf = (kind: AnnotationKind): Shape => (kind === "highlight" ? "fill" : kind === "underline" ? "underline" : kind === "note" ? "note" : "box");

interface Mark {
  key: string;
  id: string;
  box: Box;
  className: string;
}

const finite = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h].every(Number.isFinite);

function HighlightLayerImpl({ pageIndex, viewport, annotations, selectedId, onSelect, changed }: HighlightLayerProps) {
  const root = useRef<HTMLDivElement>(null);
  const page = pageIndex + 1;
  const marks = useMemo(() => {
    const edge = footEdge(viewport);
    const out: Mark[] = [];
    for (const a of annotations) {
      const shape = shapeOf(a.kind);
      const classes = ["ao-hl", `ao-hl--${shape}`, `ao-hl--${a.colorName}`];
      if (shape === "underline") classes.push(`ao-hl--edge-${edge}`);
      if (changed.has(a.id)) classes.push("ao-hl--changed");
      if (a.id === selectedId) classes.push("ao-hl--selected");
      const className = classes.join(" ");
      for (const anchor of a.pdfAnchors) {
        if (anchor.page !== page) continue;
        anchor.rects.forEach((r, i) => {
          if (finite(r)) out.push({ key: `${anchor.id}:${i}`, id: a.id, box: pdfRectToBox(r, viewport), className });
        });
      }
    }
    return out;
  }, [annotations, viewport, page, changed, selectedId]);

  const latest = useRef({ marks, onSelect });
  latest.current = { marks, onSelect };

  // A click on the page that lands on a highlight selects it (the marks themselves take no pointer events).
  useEffect(() => {
    const el = root.current;
    const target = el?.closest<HTMLElement>("[data-page-number]") ?? el?.parentElement;
    if (!el || !target) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed && sel.toString() !== "") return;
      const at = el.getBoundingClientRect();
      const x = e.clientX - at.left;
      const y = e.clientY - at.top;
      const { marks: list, onSelect: select } = latest.current;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i]!.box;
        if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
          select(list[i]!.id);
          return;
        }
      }
    };
    target.addEventListener("click", onClick);
    return () => target.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="ao-hl-layer" aria-hidden="true" ref={root}>
      {marks.map((m) => (
        <div key={m.key} className={m.className} data-annotation={m.id} style={{ left: `${m.box.left}px`, top: `${m.box.top}px`, width: `${m.box.width}px`, height: `${m.box.height}px` }} />
      ))}
    </div>
  );
}

export const HighlightLayer = memo(HighlightLayerImpl);
