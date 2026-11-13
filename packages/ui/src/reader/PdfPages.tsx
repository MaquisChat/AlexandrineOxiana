/**
 * The pages of an open PDF (Task R7): one scrolling column, each page a region labelled "Page 3 of
 * 120", drawn lazily.
 *
 *  - Memory is bounded by number AND by weight (A9, Ruling R203). The pages wanted are those in
 *    view and the current page with its neighbours, the current page first, then nearest first, at
 *    most MAX_RENDERED_PAGES. Of those, only as many are kept drawn as fit RENDER_BUDGET_BYTES of
 *    what a drawn page holds (its canvas, and any decoded pictures pdf.js still keeps for it); the
 *    current page is always drawn. A page not yet drawn is weighed at its canvas plus the heaviest
 *    pictures a page of this document was seen to keep.
 *  - Pictures are let go as soon as a page is drawn: `page.cleanup()` right after its drawing ends
 *    frees pdf.js's decoded images for that page (a 600 dpi A4 page is about 139 MB of them), so a
 *    drawn page holds only its canvas. Pages are drawn ONE AT A TIME, so at most one page's pictures
 *    are decoded at any moment. Should pdf.js not let them go (its cleanup answers false), they count
 *    against the budget, and fewer pages are kept.
 *  - A page that leaves is cleaned up at once: its drawing cancelled, its canvas emptied (width and
 *    height 0, so the browser gives its pixels back) and removed, its text layer cancelled and
 *    cleared, `page.cleanup()` called; and once nothing is being drawn, pdf.js's worker is told to
 *    clean up too (`doc.cleanup(true)`: its caches of parsed objects, images and character maps; the
 *    fonts already loaded in the page are kept). Every other page is an empty box of the right size.
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
 * Each drawn page's region carries what it holds, in bytes: `data-canvas-bytes`,
 * `data-picture-bytes` (the pictures its drawing decoded), `data-held-bytes` (what it holds now).
 *
 * `scale` is CSS pixels per PDF point (the screen passes 96/72 at "100%"); `currentPage` is 1-based
 * (as the toolbar shows it); `renderOverlay` gets the 0-based page index (as anchors store it) and
 * that page's viewport, for each drawn page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { TextLayer, type PageViewport, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfHandle } from "./pdfjs";
import "./Reader.css";

/** A page's text as pdf.js gives it. */
export type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** The most pages that hold a canvas at once. */
export const MAX_RENDERED_PAGES = 6;
/**
 * The most the drawn pages may hold together, in bytes (256 MiB): their canvases and any decoded
 * pictures pdf.js keeps for them. The current page is drawn whatever it weighs.
 *
 * NOT counted (A10, N2): the picture of the one page being drawn at the moment, while pdf.js decodes
 * and paints it (up to about 139 MB for a 600 dpi A4 page, before it is let go), and the buffers the
 * worker uses in passing to decode a picture and hand it to the page. Both last only while a page
 * is being drawn, and only one page is drawn at a time; they come on top of this budget.
 */
export const RENDER_BUDGET_BYTES = 268_435_456;
/** The most pixels one page's canvas holds (2^24: 64 MB at 4 bytes a pixel). */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Said on a drawn page that has no text. */
export const NO_TEXT_SENTENCE = "This page has no text to select. It is probably a scanned image; you can still add a note to it.";
/** The space above, between and below pages, in CSS pixels (Reader.css uses the same). */
const GAP = 16;

export type ViewRotation = 0 | 90 | 180 | 270;

export interface PdfPagesProps {
  handle: PdfHandle;
  /** CSS pixels per PDF point. */
  scale: number;
  rotation: ViewRotation;
  /** 1-based. */
  currentPage: number;
  /** Called with the 1-based page the reader scrolled to. */
  onPageChange(n: number): void;
  /** What to draw over a drawn page (highlights, R8): its 0-based index and its viewport. */
  renderOverlay(pageIndex: number, viewport: PageViewport): ReactNode;
  /**
   * Given a drawn page's text (R8: to check highlights' quotes against it), with its 0-based index:
   * the text its text layer is made from, read once, through the guarded read (raced against the
   * handle's failure, A7); never after the handle failed, a drawing was dropped or the screen left.
   */
  onPageText?(pageIndex: number, text: TextContent): void;
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
  state: "queued" | "drawing" | "done";
  /** What it holds now, in bytes (its canvas, and any pictures pdf.js kept). */
  held: number;
  page?: PDFPageProxy;
  canvas?: HTMLCanvasElement;
  task?: RenderTask;
  textLayer?: TextLayer;
}

/** What the page's region shows besides its canvas: the viewport (for the overlay), whether it has text, its weight. */
interface Drawn {
  viewport: PageViewport;
  hasText?: boolean;
  canvasBytes: number;
  pictureBytes?: number;
  heldBytes: number;
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

const pixelRatio = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

/** The device pixels a canvas of `cssPixels` takes at this pixel ratio, within MAX_CANVAS_PIXELS. */
const canvasPixels = (cssPixels: number) => Math.min(cssPixels * pixelRatio() ** 2, MAX_CANVAS_PIXELS);

/** The decoded pictures pdf.js holds in a page's objects, in bytes (4 a pixel). */
function pictureBytes(page: PDFPageProxy): number {
  let bytes = 0;
  try {
    for (const [, data] of page.objs as unknown as Iterable<[string, unknown]>) {
      const d = data as { width?: unknown; height?: unknown; bitmap?: unknown; data?: unknown } | null;
      if (d && typeof d.width === "number" && typeof d.height === "number" && (d.bitmap || d.data)) bytes += d.width * d.height * 4;
    }
  } catch {
    // Not readable: counted as none.
  }
  return bytes;
}

/** Calls a guarded pdf.js method that may answer with a rejected promise once the handle is dead. */
function quietly<T>(call: () => T): T | undefined {
  try {
    const r: unknown = call();
    if (r instanceof Promise) r.catch(() => {});
    return r as T;
  } catch {
    return undefined;
  }
}

export function PdfPages({ handle, scale, rotation, currentPage, onPageChange, renderOverlay, onPageText }: PdfPagesProps) {
  const count = handle.pageCount;
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(() => new Map());
  const [drawn, setDrawn] = useState<ReadonlyMap<number, Drawn>>(() => new Map());
  const [dead, setDead] = useState(false);
  const [view, setView] = useState({ top: 0, height: 0 });
  /** Moves on when a drawn page's weight became known: the pages kept are weighed again. */
  const [weighed, setWeighed] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const canvasHosts = useRef(new Map<number, HTMLDivElement>());
  const textHosts = useRef(new Map<number, HTMLDivElement>());
  const hostRefs = useRef(new Map<number, { canvas: (el: HTMLDivElement | null) => void; text: (el: HTMLDivElement | null) => void }>());
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
  const pageText = useRef(onPageText);
  pageText.current = onPageText;
  /** The pages to draw, in the order they are drawn. */
  const order = useRef<number[]>([]);
  const current = useRef(currentPage);
  current.current = currentPage;
  /** Whether a page is being drawn now (one at a time). */
  const busy = useRef(false);
  /** The heaviest pictures pdf.js was seen to keep for one drawn page of this document. */
  const keptPictures = useRef(0);
  /** A page left since pdf.js's worker last cleaned up. */
  const leftSinceCleanup = useRef(false);

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
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** Moves the view so that the anchor page is where it was (not at all when it is there already). */
  const scrollToAnchor = useCallback(() => {
    const el = scroller.current;
    if (!el || layout.tops.length === 0) return;
    const i = Math.min(Math.max(anchor.current.page, 1), count) - 1;
    const top = Math.max(0, Math.round(layout.tops[i]! - GAP + anchor.current.frac * (layout.boxes[i]!.h + GAP)));
    if (Math.abs(el.scrollTop - top) >= 1) {
      el.scrollTop = top;
      ownScroll.current = el.scrollTop;
    }
    const next = { top: el.scrollTop, height: el.clientHeight };
    setView((v) => (v.top === next.top && v.height === next.height ? v : next));
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

  /** The pages wanted: those in view and the current one with its neighbours; the current first, then nearest first; at most MAX_RENDERED_PAGES. */
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
    const rest = [...set].filter((n) => n !== cur).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    return [cur, ...rest].slice(0, MAX_RENDERED_PAGES);
  }, [layout, view, currentPage, count, dead]);

  // ---- drawing ---------------------------------------------------------------------------------
  /** Drops what is drawn of page `n`: drawing cancelled, canvas emptied, text layer cleared, page cleaned up. */
  const release = useCallback((n: number, keepPage = false) => {
    const s = slots.current.get(n);
    if (!s) return;
    s.gen++;
    s.state = "queued";
    s.held = 0;
    // On a dead handle the guarded call does nothing and returns a rejected promise: caught.
    if (s.task) quietly(() => s.task!.cancel());
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
      if (page) {
        leftSinceCleanup.current = true;
        quietly(() => page.cleanup());
      }
    }
  }, []);

  const releaseAll = useCallback(() => {
    for (const n of [...slots.current.keys()]) release(n);
  }, [release]);

  const forget = (n: number) =>
    setDrawn((m) => {
      if (!m.has(n)) return m;
      const next = new Map(m);
      next.delete(n);
      return next;
    });

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

  /** What page `n` would hold once drawn: its canvas at the current layout, and the pictures pages of this document were seen to keep. */
  const estimate = useCallback((n: number) => {
    const box = layoutRef.current.boxes[n - 1];
    return (box ? canvasPixels(box.w * box.h) * 4 : 0) + keptPictures.current;
  }, []);
  /** What page `n` weighs now: what it holds once drawn, else its estimate. */
  const weightOf = useCallback((n: number, key: string) => {
    const s = slots.current.get(n);
    return s && s.key === key && s.state === "done" ? s.held : estimate(n);
  }, [estimate]);

  const draw = useCallback(
    async (n: number, slot: Slot) => {
      const gen = slot.gen;
      const stale = () => !mounted.current || deadRef.current || slots.current.get(n) !== slot || slot.gen !== gen;
      try {
        const page = slot.page ?? (await live(handle.doc.getPage(n)));
        if (stale()) {
          if (!slot.page && slots.current.get(n) !== slot) quietly(() => page.cleanup());
          return;
        }
        slot.page = page;
        const own = page.getViewport({ scale: 1, rotation: page.rotate });
        setSizes((m) => {
          const s = m.get(n);
          if (s && s.w === own.width && s.h === own.height) return m;
          // A page the size of page 1 changes nothing: its box is sized from page 1 already.
          const f = m.get(1);
          if (!s && n !== 1 && f && f.w === own.width && f.h === own.height) return m;
          return new Map(m).set(n, { w: own.width, h: own.height });
        });
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const dpr = pixelRatio();
        const output = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width * output));
        canvas.height = Math.max(1, Math.floor(viewport.height * output));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.setAttribute("aria-hidden", "true");
        const canvasBytes = canvas.width * canvas.height * 4;
        slot.canvas = canvas;
        slot.held = canvasBytes;
        setDrawn((m) => new Map(m).set(n, { viewport, canvasBytes, heldBytes: canvasBytes }));
        canvasHosts.current.get(n)?.replaceChildren(canvas);
        const task = page.render({ canvas, viewport, ...(output !== 1 ? { transform: [output, 0, 0, output, 0, 0] } : {}) });
        slot.task = task;
        await live(task.promise);
        if (stale()) return;
        slot.task = undefined;
        // Drawn: its decoded pictures are let go at once; if pdf.js keeps them, they are counted.
        const pictures = pictureBytes(page);
        const letGo = quietly(() => page.cleanup()) !== false;
        const heldBytes = canvasBytes + (letGo ? 0 : pictures);
        slot.held = heldBytes;
        if (!letGo && pictures > keptPictures.current) keptPictures.current = pictures;
        setDrawn((m) => new Map(m).set(n, { viewport, canvasBytes, pictureBytes: pictures, heldBytes }));
        const text: TextContent = await live(page.getTextContent());
        if (stale()) return;
        pageText.current?.(n - 1, text);
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
      } finally {
        if (!stale()) {
          slot.state = "done";
          if (!letGoKnown(slot)) setWeighed((w) => w + 1);
        }
      }
    },
    [handle, live, scale, rotation],
  );

  /**
   * Draws the next page waiting, in order, if it fits the budget beside what is drawn already (the
   * current page always fits); one at a time. When nothing is left to draw, the worker cleans up if
   * a page left meanwhile.
   */
  const pump = useCallback(() => {
    if (busy.current || deadRef.current || !mounted.current) return;
    let used = 0;
    for (const s of slots.current.values()) if (s.state !== "queued") used += s.held;
    for (const n of order.current) {
      const slot = slots.current.get(n);
      if (!slot || slot.state !== "queued") continue;
      const w = estimate(n);
      if (n !== current.current && used + w > RENDER_BUDGET_BYTES) continue;
      busy.current = true;
      slot.state = "drawing";
      void draw(n, slot).finally(() => {
        busy.current = false;
        // The pump of the latest render: a zoom meanwhile has new drawing settings.
        pumpRef.current();
      });
      return;
    }
    if (leftSinceCleanup.current) {
      leftSinceCleanup.current = false;
      // pdf.js's worker lets go of its caches (parsed objects, images, character maps); loaded fonts are kept.
      void Promise.resolve()
        .then(() => handle.doc.cleanup(true))
        .catch(() => {});
    }
  }, [draw, estimate, handle]);

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  const drawKey = `${scale}|${rotation}|${pixelRatio()}`;
  useEffect(() => {
    if (dead || deadRef.current) return;
    // The pages kept: in order, while they fit the budget (the current page always).
    const kept: number[] = [];
    let used = 0;
    for (const n of wanted) {
      const w = weightOf(n, drawKey);
      if (kept.length > 0 && used + w > RENDER_BUDGET_BYTES) continue;
      kept.push(n);
      used += w;
    }
    const keep = new Set(kept);
    for (const n of [...slots.current.keys()]) {
      if (!keep.has(n)) {
        release(n);
        forget(n);
      }
    }
    for (const n of kept) {
      const have = slots.current.get(n);
      if (have && have.key === drawKey) continue;
      if (have) {
        release(n, true);
        forget(n);
      }
      const slot: Slot = have ?? { gen: 0, key: drawKey, state: "queued", held: 0 };
      slot.key = drawKey;
      slot.state = "queued";
      slots.current.set(n, slot);
    }
    order.current = kept;
    pump();
  }, [wanted, drawKey, release, dead, weightOf, pump, weighed]);

  /** Stable ref callbacks for each page's two hosts (not new ones at every render). */
  const refsFor = (n: number) => {
    let r = hostRefs.current.get(n);
    if (!r) {
      r = {
        canvas: (el) => {
          if (el) canvasHosts.current.set(n, el);
          else canvasHosts.current.delete(n);
        },
        text: (el) => {
          if (el) textHosts.current.set(n, el);
          else textHosts.current.delete(n);
        },
      };
      hostRefs.current.set(n, r);
    }
    return r;
  };

  if (layout.tops.length === 0) {
    return (
      <div className="ao-reader-scroll" ref={scroller} tabIndex={0} role="group" aria-label="Pages">
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
          const refs = refsFor(n);
          return (
            <div
              key={n}
              // Only a page drawn now is a landmark region; any other page box is a group with the
              // same label (A10): 900 regions would crowd a screen reader's list of landmarks.
              role={d ? "region" : "group"}
              aria-label={`Page ${n} of ${count}`}
              tabIndex={-1}
              className="ao-reader-page"
              data-page-number={n}
              data-top={layout.tops[i]}
              {...(d
                ? {
                    "data-rendered": "",
                    "data-canvas-bytes": d.canvasBytes,
                    "data-held-bytes": d.heldBytes,
                    ...(d.pictureBytes !== undefined ? { "data-picture-bytes": d.pictureBytes } : {}),
                  }
                : {})}
              style={{ width: `${box.w}px`, height: `${box.h}px`, "--total-scale-factor": String(scale) } as CSSProperties}
            >
              <div className="ao-reader-canvas" ref={refs.canvas} />
              <div className="ao-reader-text-layer" ref={refs.text} />
              {d && <div className="ao-reader-overlay">{renderOverlay(i, d.viewport)}</div>}
              {d?.hasText === false && <p className="ao-reader-no-text">{NO_TEXT_SENTENCE}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Whether a drawn page's weight is no news: it holds only its canvas (nothing to weigh again). */
function letGoKnown(slot: Slot): boolean {
  return slot.canvas !== undefined && slot.held === slot.canvas.width * slot.canvas.height * 4;
}
