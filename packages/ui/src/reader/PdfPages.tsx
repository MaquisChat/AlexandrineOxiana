/**
 * The pages of an open PDF (Task R7): one scrolling column, each page a region labelled "Page 3 of
 * 120", drawn lazily.
 *
 *  - Memory is bounded: at most MAX_RENDERED_PAGES pages hold a canvas (and a text layer) at any
 *    time: the pages in view and the current page with its neighbours, nearest first. A page that
 *    leaves is cleaned up at once: its drawing cancelled, its canvas emptied (width and height 0, so
 *    the browser gives its pixels back) and removed, its text layer cancelled and cleared, and
 *    pdf.js's `page.cleanup()` called. Every other page is an empty box of the right size.
 *  - Boxes are sized from page 1 until a page's own size is known (when it is first drawn).
 *  - A canvas is drawn at devicePixelRatio (sharp on a Retina screen), capped at
 *    MAX_CANVAS_PIXELS pixels: past that, at high zoom, the page is drawn at a lower resolution and
 *    stretched, rather than taking hundreds of megabytes.
 *  - Each drawn page carries pdf.js's `TextLayer` for selection (it writes each piece of text with
 *    `textContent` only, never markup). A page with no text says so, in words, on the page.
 *  - `rotation` is a view setting (added to the page's own /Rotate); nothing is written anywhere.
 *  - Stale work is dropped: a drawing started for another zoom, rotation or page window is cancelled
 *    and its late result ignored; leaving the screen cancels and empties everything.
 *  - A7: every read from the handle (a page, its text, a drawing) is raced against `failed`. When it
 *    settles, every drawing is cancelled, every canvas and text layer of the document cleared, the
 *    overlays removed, and nothing that arrives afterwards is kept or drawn; nothing more is asked of
 *    the handle. (The screen then shows the failure and destroys the handle.)
 *
 * `currentPage` is 1-based (as the toolbar shows it); `renderOverlay` gets the 0-based page index
 * (as anchors store it) and that page's viewport, for each drawn page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { TextLayer, type PageViewport, type PDFPageProxy, type RenderTask, type TextContent } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfHandle } from "./pdfjs";
import "./Reader.css";

/** The most pages that hold a canvas at once. */
export const MAX_RENDERED_PAGES = 6;
/** The most pixels one page's canvas holds (2^24: 64 MB at 4 bytes a pixel). */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Said on a drawn page that has no text. */
export const NO_TEXT_SENTENCE = "This page has no text to select. It is probably a scanned image; you can still add a note to it.";
/** The space above, between and below pages, in CSS pixels (Reader.css uses the same). */
const GAP = 16;

export type ViewRotation = 0 | 90 | 180 | 270;

export interface PdfPagesProps {
  handle: PdfHandle;
  /** 1 is 100%. */
  scale: number;
  rotation: ViewRotation;
  /** 1-based. */
  currentPage: number;
  /** Called with the 1-based page the reader scrolled to. */
  onPageChange(n: number): void;
  /** What to draw over a drawn page (highlights, R8): its 0-based index and its viewport. */
  renderOverlay(pageIndex: number, viewport: PageViewport): ReactNode;
}

/** A page's size at 100%, turned by its own /Rotate only. */
interface Size {
  w: number;
  h: number;
}

/** What is drawn for one page now. */
interface Slot {
  /** Moves on whenever the drawing is replaced or dropped: older work is then ignored. */
  gen: number;
  /** The zoom, rotation and pixel ratio it was drawn for. */
  key: string;
  page?: PDFPageProxy;
  canvas?: HTMLCanvasElement;
  task?: RenderTask;
  textLayer?: TextLayer;
}

/** What the page's region shows besides its canvas: the viewport (for the overlay) and whether it has text. */
interface Drawn {
  viewport: PageViewport;
  hasText?: boolean;
}

const isCancelled = (e: unknown) => e instanceof Error && (e.name === "RenderingCancelledException" || e.name === "AbortException");

/** The last index whose value is at most `y` (tops are increasing). */
function indexAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function PdfPages({ handle, scale, rotation, currentPage, onPageChange, renderOverlay }: PdfPagesProps) {
  const count = handle.pageCount;
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(() => new Map());
  const [drawn, setDrawn] = useState<ReadonlyMap<number, Drawn>>(() => new Map());
  const [dead, setDead] = useState(false);
  const [view, setView] = useState({ top: 0, height: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const canvasHosts = useRef(new Map<number, HTMLDivElement>());
  const textHosts = useRef(new Map<number, HTMLDivElement>());
  const slots = useRef(new Map<number, Slot>());
  const deadRef = useRef(false);
  const mounted = useRef(true);
  const reported = useRef(currentPage);
  /** The page (and how far into it, 0-1) at the top of the view: kept there when the layout changes. */
  const anchor = useRef({ page: currentPage, frac: 0 });
  /** The scroll position this component set last: its own scroll events are not the reader's. */
  const ownScroll = useRef<number | undefined>(undefined);
  const pageChange = useRef(onPageChange);
  pageChange.current = onPageChange;

  // Every read from the handle is raced against its failure (A7).
  const failure = useMemo(() => {
    const p = handle.failed.then((e) => {
      throw e;
    });
    p.catch(() => {});
    return p;
  }, [handle]);
  const live = useCallback(<T,>(p: Promise<T>): Promise<T> => Promise.race([p, failure]), [failure]);

  // ---- layout ----------------------------------------------------------------------------------
  const first = sizes.get(1);
  const layout = useMemo(() => {
    const tops: number[] = [];
    const boxes: Array<{ w: number; h: number }> = [];
    if (!first) return { tops, boxes, total: 0 };
    const turned = rotation % 180 !== 0;
    let y = GAP;
    for (let n = 1; n <= count; n++) {
      const s = sizes.get(n) ?? first;
      const w = Math.floor((turned ? s.h : s.w) * scale);
      const h = Math.floor((turned ? s.w : s.h) * scale);
      tops.push(y);
      boxes.push({ w, h });
      y += h + GAP;
    }
    return { tops, boxes, total: y };
  }, [sizes, first, count, scale, rotation]);

  /** Moves the view so that the anchor page is where it was. */
  const scrollToAnchor = useCallback(() => {
    const el = scroller.current;
    if (!el || layout.tops.length === 0) return;
    const i = Math.min(Math.max(anchor.current.page, 1), count) - 1;
    const top = layout.tops[i]! - GAP + anchor.current.frac * (layout.boxes[i]!.h + GAP);
    el.scrollTop = Math.max(0, Math.round(top));
    ownScroll.current = el.scrollTop;
    setView({ top: el.scrollTop, height: el.clientHeight });
  }, [layout, count]);

  // Keep the anchor page in place whenever the layout changes (zoom, rotation, a size learnt).
  useLayoutEffect(() => {
    scrollToAnchor();
  }, [scrollToAnchor]);

  // A page asked for from outside (the toolbar, a key): moved to its top.
  useLayoutEffect(() => {
    if (currentPage === reported.current) return;
    reported.current = currentPage;
    anchor.current = { page: currentPage, frac: 0 };
    scrollToAnchor();
    // Only a change of the page asked for moves the view here; layout changes are handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || layout.tops.length === 0) return;
    const top = el.scrollTop;
    setView({ top, height: el.clientHeight });
    if (ownScroll.current === top) return;
    ownScroll.current = undefined;
    const i = indexAt(layout.tops, top + GAP);
    const span = layout.boxes[i]!.h + GAP;
    anchor.current = { page: i + 1, frac: Math.min(1, Math.max(0, (top - (layout.tops[i]! - GAP)) / span)) };
    const atEnd = el.scrollHeight > 0 && top + el.clientHeight >= el.scrollHeight - 2 && top > 0;
    const page = atEnd ? count : i + 1;
    if (page !== reported.current) {
      reported.current = page;
      pageChange.current(page);
    }
  };

  /** The pages to draw: those in view and the current one with its neighbours, nearest first, at most MAX_RENDERED_PAGES. */
  const wanted = useMemo(() => {
    if (layout.tops.length === 0 || dead) return [] as number[];
    const cur = Math.min(Math.max(currentPage, 1), count);
    const height = view.height > 0 ? view.height : layout.boxes[cur - 1]!.h;
    const set = new Set<number>([cur]);
    if (view.height > 0 || view.top > 0) {
      const from = indexAt(layout.tops, view.top) + 1;
      const to = indexAt(layout.tops, view.top + height) + 1;
      for (let n = from; n <= to; n++) set.add(n);
    }
    if (cur > 1) set.add(cur - 1);
    if (cur < count) set.add(cur + 1);
    const centre = (indexAt(layout.tops, view.top + height / 2) + 1 + cur) / 2;
    return [...set].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b).slice(0, MAX_RENDERED_PAGES).sort((a, b) => a - b);
  }, [layout, view, currentPage, count, dead]);

  // ---- drawing ---------------------------------------------------------------------------------
  /** Drops what is drawn of page `n`: drawing cancelled, canvas emptied, text layer cleared, page cleaned up. */
  const release = useCallback((n: number, keepPage = false) => {
    const s = slots.current.get(n);
    if (!s) return;
    s.gen++;
    s.task?.cancel();
    s.task = undefined;
    s.textLayer?.cancel();
    s.textLayer = undefined;
    if (s.canvas) {
      s.canvas.width = 0;
      s.canvas.height = 0;
      s.canvas.remove();
      s.canvas = undefined;
    }
    canvasHosts.current.get(n)?.replaceChildren();
    textHosts.current.get(n)?.replaceChildren();
    if (!keepPage) {
      slots.current.delete(n);
      const page = s.page;
      s.page = undefined;
      // Called through a promise: on a dead handle the guarded call rejects instead of returning.
      if (page) void Promise.resolve().then(() => page.cleanup()).catch(() => {});
    }
  }, []);

  const releaseAll = useCallback(() => {
    for (const n of [...slots.current.keys()]) release(n);
  }, [release]);

  // On failure (A7): everything cleared at once, nothing drawn again.
  useEffect(() => {
    let on = true;
    handle.failed.then(() => {
      if (!on) return;
      deadRef.current = true;
      releaseAll();
      setDrawn(new Map());
      setDead(true);
    });
    return () => {
      on = false;
    };
  }, [handle, releaseAll]);

  // Learn page 1's size first: every box is sized from it until its own size is known.
  useEffect(() => {
    let on = true;
    live(handle.doc.getPage(1))
      .then((page) => {
        if (!on || deadRef.current) return;
        const vp = page.getViewport({ scale: 1, rotation: page.rotate });
        setSizes((m) => (m.has(1) ? m : new Map(m).set(1, { w: vp.width, h: vp.height })));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [handle, live]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseAll();
      TextLayer.cleanup();
    };
  }, [releaseAll]);

  const draw = useCallback(
    async (n: number, slot: Slot) => {
      const gen = slot.gen;
      const stale = () => !mounted.current || deadRef.current || slots.current.get(n) !== slot || slot.gen !== gen;
      try {
        const page = slot.page ?? (await live(handle.doc.getPage(n)));
        if (stale()) {
          if (!slot.page && slots.current.get(n) !== slot) void Promise.resolve().then(() => page.cleanup()).catch(() => {});
          return;
        }
        slot.page = page;
        const own = page.getViewport({ scale: 1, rotation: page.rotate });
        setSizes((m) => {
          const s = m.get(n);
          return s && s.w === own.width && s.h === own.height ? m : new Map(m).set(n, { w: own.width, h: own.height });
        });
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        setDrawn((m) => new Map(m).set(n, { viewport }));
        const dpr = window.devicePixelRatio || 1;
        const output = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width * output));
        canvas.height = Math.max(1, Math.floor(viewport.height * output));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.setAttribute("aria-hidden", "true");
        slot.canvas = canvas;
        canvasHosts.current.get(n)?.replaceChildren(canvas);
        const task = page.render({ canvas, viewport, ...(output !== 1 ? { transform: [output, 0, 0, output, 0, 0] } : {}) });
        slot.task = task;
        await live(task.promise);
        if (stale()) return;
        slot.task = undefined;
        const text: TextContent = await live(page.getTextContent());
        if (stale()) return;
        const hasText = text.items.some((i) => "str" in i && i.str.trim() !== "");
        if (hasText) {
          const host = textHosts.current.get(n);
          if (host) {
            const layer = new TextLayer({ textContentSource: text, container: host, viewport });
            slot.textLayer = layer;
            await live(layer.render());
            if (stale()) return;
          }
        }
        setDrawn((m) => {
          const d = m.get(n);
          return d ? new Map(m).set(n, { ...d, hasText }) : m;
        });
      } catch (e) {
        if (stale() || isCancelled(e)) return;
        // A page that cannot be drawn (a broken page in an otherwise readable file) stays an empty box.
      }
    },
    [handle, live, scale, rotation],
  );

  const drawKey = `${scale}|${rotation}|${typeof window === "undefined" ? 1 : window.devicePixelRatio || 1}`;
  useEffect(() => {
    if (dead || deadRef.current) return;
    const want = new Set(wanted);
    for (const n of [...slots.current.keys()]) {
      if (!want.has(n)) {
        release(n);
        setDrawn((m) => {
          if (!m.has(n)) return m;
          const next = new Map(m);
          next.delete(n);
          return next;
        });
      }
    }
    for (const n of wanted) {
      const have = slots.current.get(n);
      if (have && have.key === drawKey) continue;
      if (have) release(n, true);
      const slot: Slot = have ?? { gen: 0, key: drawKey };
      slot.key = drawKey;
      slots.current.set(n, slot);
      void draw(n, slot);
    }
  }, [wanted, drawKey, draw, release, dead]);

  if (layout.tops.length === 0) {
    return (
      <div className="ao-reader-scroll" ref={scroller}>
        <p role="status" className="ao-reader-loading">
          Opening the pages…
        </p>
      </div>
    );
  }
  return (
    <div className="ao-reader-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} role="group" aria-label="Pages">
      <div className="ao-reader-stack">
        {layout.boxes.map((box, i) => {
          const n = i + 1;
          const d = dead ? undefined : drawn.get(n);
          return (
            <div
              key={n}
              role="region"
              aria-label={`Page ${n} of ${count}`}
              tabIndex={-1}
              className="ao-reader-page"
              data-page-number={n}
              data-top={layout.tops[i]}
              {...(d ? { "data-rendered": "" } : {})}
              style={{ width: `${box.w}px`, height: `${box.h}px`, "--total-scale-factor": String(scale) } as CSSProperties}
            >
              <div
                className="ao-reader-canvas"
                ref={(el) => {
                  if (el) canvasHosts.current.set(n, el);
                  else canvasHosts.current.delete(n);
                }}
              />
              <div
                className="ao-reader-text-layer"
                ref={(el) => {
                  if (el) textHosts.current.set(n, el);
                  else textHosts.current.delete(n);
                }}
              />
              {d && <div className="ao-reader-overlay">{renderOverlay(i, d.viewport)}</div>}
              {d?.hasText === false && <p className="ao-reader-no-text">{NO_TEXT_SENTENCE}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
