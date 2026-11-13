/**
 * Making highlights with the mouse on the reader screen (Task R10): what the screen (Reader.tsx)
 * adds to its pages, kept here so that the screen's own code stays as it was.
 *
 *  - A selection of text on the drawn pages, when the mouse button is let go, is read with
 *    `selectionToAnchors` (only text of the pages' text layers counts: a selection reaching into the
 *    list, the toolbar or the gap between pages is cut to the part inside the pages; nothing is
 *    offered when nothing is left, so a selection in the list or in a note being typed never shows
 *    the toolbar). The colour toolbar (HighlightToolbar) is then shown below its last line.
 *  - Limits said in words, nothing made: a selection over more than 50 pages ("A highlight can cover
 *    at most 50 pages."); one reaching over a page that is not drawn at the moment (its text is not
 *    in the page, so it cannot be quoted); a read-only library or screen shows no toolbar and says
 *    why once ("This library is read-only, so highlights cannot be made.").
 *  - A colour chosen: one create through the service's route (`createAnnotation`, Task R4); a draft
 *    is drawn meanwhile (never chosen, never listed), and the service's answer replaces it — on the
 *    page and in the list (`onCreated`), said in the list's live region ("Highlight added: Yellow,
 *    page 7." or "… pages 4–5."). A refusal removes the draft and says the service's own sentence in
 *    an alert; a 423 ends the reader as locked at once (`onLocked`, the same path as a refused range,
 *    A9, A11); a 404 also asks whether the project is still there (`onProjectInDoubt`, A10).
 *  - A highlight is made only from a live handle, checked again when the answer comes (A7): an
 *    answer arriving after the document failed, was opened again, or the screen ended is dropped.
 *    When the document goes, every draft, toolbar, menu and message goes with it.
 *  - Where highlights overlap, a click offers each (OverlapMenu); choosing one selects it (`onSelect`).
 *
 * The toolbar and the menu are placed in the page area (positioned, HighlightToolbar.css) from the
 * page's box and the PDF rectangles through the page's viewport, so they follow a scroll or a zoom.
 */
import { ANNOTATION_ANCHORS_MAX } from "@ao/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ApiClientError } from "../api/client";
import type { AnnotationCreateRequest, AnnotationRecord, HighlightColourName, ReaderApi } from "../api/reader";
import { HighlightToolbar, OverlapMenu } from "./HighlightToolbar";
import { pdfRectToBox, selectionToAnchors, type Box, type PageGeometry, type SelectionAnchor } from "./geometry";
import type { PdfHandle } from "./pdfjs";
import { END_OF_CONTENT_CLASS } from "./textLayerSelection";

export const TOO_MANY_PAGES = `A highlight can cover at most ${ANNOTATION_ANCHORS_MAX} pages.`;
export const PAGES_NOT_SHOWN = "This selection runs over pages that are not on screen at the moment, so it cannot be highlighted. Select a shorter passage — a few pages at most.";
/** A page that is drawn but whose text layer is still being laid out, or drawn at a zoom other than the one known (R223, M6). */
export const PAGE_STILL_DRAWING = "This page is still being drawn. Select the text again in a moment.";
/** Said through the list's live region when a press begun on a page is let go outside every page (Ruling R229). */
export const LET_GO_ON_PAGE = "To highlight, let go of the mouse over the page.";
/** Said through the list's live region between the press and the service's answer (R223, M3). */
export const ADDING = "Adding the highlight…";
export const READ_ONLY_MAKING = "This library is read-only, so highlights cannot be made.";
const SERVICE_SILENT = "The library service did not answer, so the highlight was not made.";

/** The colour "Highlight" uses: the last one chosen in this session (Yellow at first). */
let lastUsed: HighlightColourName = "yellow";

const label = (c: HighlightColourName) => c.charAt(0).toUpperCase() + c.slice(1);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
/** Most characters of a page label the service stores. */
const PAGE_LABEL_MAX = 64;
/** Rectangles are sent to a thousandth of a point (about a thousandth of a pixel at 100%). */
const round = (v: number) => Math.round(v * 1000) / 1000;

export interface MakingOptions {
  api: () => ReaderApi;
  projectId: string;
  sourceId: string;
  assetId: string | undefined;
  /** The document open now (undefined when none). */
  handle: PdfHandle | undefined;
  /** Whether `h` is still the screen's document and alive (A7). */
  isLive(h: PdfHandle): boolean;
  readOnly: boolean;
  /** The page area (positioned; the toolbar and menu are placed in it). */
  area: RefObject<HTMLDivElement | null>;
  /** This file's annotations (for the overlap menu's words). */
  annotations: AnnotationRecord[] | undefined;
  onCreated(r: AnnotationRecord): void;
  /**
   * A create answered after the document failed and was opened again (its answer dropped, A7): the
   * highlight IS stored, so the screen asks for the list again (R223, M2).
   */
  onStoredMeanwhile(): void;
  onLocked(h: PdfHandle): void;
  onProjectInDoubt(): void;
  onSelect(id: string): void;
  /**
   * The toolbar was given up (Escape, "Cancel", a press elsewhere: `made` false) or a colour chosen
   * (`made` true) — not when the selection changed under it (N1). The keyboard's selection (Task R11)
   * ends with it.
   */
  onPickClosed?(made: boolean): void;
}

interface Pick {
  anchors: SelectionAnchor[];
  /** Where the toolbar goes: the last page's (0-based) last line. */
  pageIndex: number;
  rect: SelectionAnchor["rects"][number];
}

interface Menu {
  pageIndex: number;
  /** The click, on the page (CSS pixels). */
  at: { left: number; top: number };
  ids: string[];
}

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export function useHighlightMaking(o: MakingOptions) {
  const opts = useRef(o);
  opts.current = o;
  const { handle } = o;
  /** The viewport each drawn page is drawn at now (0-based index), as the pages hand it to their overlay. */
  const viewports = useRef(new Map<number, PageViewport>());
  const [pick, setPick] = useState<Pick | undefined>(undefined);
  const [menu, setMenu] = useState<Menu | undefined>(undefined);
  const [drafts, setDrafts] = useState<AnnotationRecord[]>([]);
  const [alert, setAlert] = useState<string | undefined>(undefined);
  const [readOnlySaid, setReadOnlySaid] = useState(false);
  const [announcement, setAnnouncement] = useState<{ text: string; n: number } | undefined>(undefined);
  const [lastColour, setLastColour] = useState<HighlightColourName>(lastUsed);
  const [, setTick] = useState(0);
  const seq = useRef(0);

  // Everything of the making goes with the document (A7, A9).
  useEffect(() => {
    const vps = viewports.current;
    return () => {
      vps.clear();
      setPick(undefined);
      setMenu(undefined);
      setDrafts([]);
      setAlert(undefined);
      setAnnouncement(undefined);
    };
  }, [handle]);

  /** Called by the screen's overlay for each drawn page: the viewport it is drawn at. */
  const noteViewport = useCallback((pageIndex: number, viewport: PageViewport) => {
    viewports.current.set(pageIndex, viewport);
  }, []);

  /**
   * A page of a selection: its geometry when it is drawn and its text layer laid out to its end (the
   * blank-space guard is put there last, PdfPages); "no-text" for a drawn page without text;
   * "drawing" for a drawn page whose text layer is still being laid out or which is drawn at a zoom
   * other than the viewport known (M6); undefined for a page not drawn at all (not on screen).
   */
  const geometryOf = (el: HTMLElement): PageGeometry | "no-text" | "drawing" | undefined => {
    const n = Number(el.dataset.pageNumber);
    if (!el.hasAttribute("data-rendered")) return undefined;
    const vp = viewports.current.get(n - 1);
    if (el.querySelector(".ao-reader-no-text")) return "no-text";
    const layer = el.querySelector(".ao-reader-text-layer");
    if (!vp || !layer || !layer.querySelector(`:scope > .${END_OF_CONTENT_CLASS}`)) return "drawing";
    const w = parseFloat(el.style.width);
    if (Number.isFinite(w) && Math.abs(w - Math.floor(vp.width)) > 1) return "drawing";
    return { page: n, element: el, textLayer: layer, viewport: vp };
  };
  /** Whether the press now ending began in a page's text layer (I2): only then is the selection read. */
  const pressInPage = useRef(false);
  /** The selection the toolbar was opened for (a live Range, moved with the page's DOM as the selection is): N1. */
  const pickedRange = useRef<Range | undefined>(undefined);
  /** Whether the last press began in the colour toolbar (its buttons must not count as a change of selection). */
  const pressInToolbar = useRef(false);

  /** Reads the selection when the mouse button is let go. */
  const takeSelection = (target: EventTarget | null) => {
    if (typing(target)) return;
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    offer(sel.getRangeAt(0));
  };

  /**
   * What a selection's range offers: the toolbar, or a limit said in words. The mouse's path hands it
   * the browser's selection at the end of a press begun on a page (I2); the keyboard's (Task R11)
   * hands it its own range (`takeRange`). True when the toolbar is offered.
   */
  const offer = (range: Range): boolean => {
    const { area, readOnly, handle: h, isLive } = opts.current;
    const root = area.current;
    if (!root || !h || !isLive(h) || range.collapsed) return false;
    const boxes = [...root.querySelectorAll<HTMLElement>("[data-page-number]")].filter((el) => range.intersectsNode(el));
    if (boxes.length === 0) return false;
    const geoms = boxes.map(geometryOf);
    const pages = geoms.filter((g): g is PageGeometry => typeof g === "object");
    const anchors = selectionToAnchors(range, pages);
    const unsure = geoms.some((g) => g === undefined || g === "drawing");
    if (anchors.length === 0 && boxes.length <= ANNOTATION_ANCHORS_MAX && !unsure) return false;
    setMenu(undefined);
    if (readOnly) {
      setReadOnlySaid(true);
      return false;
    }
    if (boxes.length > ANNOTATION_ANCHORS_MAX) {
      setPick(undefined);
      setAlert(TOO_MANY_PAGES);
      return false;
    }
    // A page in the selection that is not drawn now: its text cannot be quoted (R223 d). One drawn
    // but not yet laid out at the zoom shown: in a moment it can (M6).
    if (geoms.some((g) => g === undefined)) {
      setPick(undefined);
      setAlert(PAGES_NOT_SHOWN);
      return false;
    }
    if (geoms.some((g) => g === "drawing")) {
      setPick(undefined);
      setAlert(PAGE_STILL_DRAWING);
      return false;
    }
    setAlert(undefined);
    const last = anchors[anchors.length - 1]!;
    pickedRange.current = range.cloneRange();
    setPick({ anchors, pageIndex: last.page - 1, rect: last.rects[last.rects.length - 1]! });
    return true;
  };

  // The selection is read only at the end of a press that BEGAN in a page's text layer (I2): a
  // press anywhere else (the reader's toolbar, the list, a note) never reads it. A selection made or
  // changed by the keyboard is not read here (the keyboard's own way to highlight is Task R11's).
  useEffect(() => {
    if (!handle) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      pressInPage.current = e.button === 0 && !!t?.closest(".ao-reader-text-layer") && !!opts.current.area.current?.contains(t);
      pressInToolbar.current = !!t?.closest(".ao-hl-toolbar");
    };
    const onUp = (e: MouseEvent) => {
      const began = pressInPage.current;
      pressInPage.current = false;
      if (e.button !== 0 || !began) return;
      // Ruling R229: a drag must end on a page. Let go anywhere else (the list, the toolbar, beyond the
      // view's edge, the gap between pages, the backdrop beside a page), it stores nothing: the
      // browser's selection is removed and the reason said once.
      const t = e.target instanceof Element ? e.target : null;
      const page = t?.closest("[data-page-number]");
      if (!page || !opts.current.area.current?.contains(page)) {
        window.getSelection?.()?.removeAllRanges();
        setPick(undefined);
        say(LET_GO_ON_PAGE);
        return;
      }
      takeSelection(e.target);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp);
    };
    // takeSelection reads the latest options through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // N1: the toolbar offers to store what is tinted, nothing else: when the selection changes after it
  // opened (Shift+Arrow, a click elsewhere on the page), it closes.
  useEffect(() => {
    if (!pick) return;
    const onChange = () => {
      // Using the toolbar (a press on it, the focus moved into it by Tab) is not a change of what is selected.
      if (pressInToolbar.current || document.activeElement?.closest(".ao-hl-toolbar")) return;
      const was = pickedRange.current;
      const sel = window.getSelection?.();
      const now = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : undefined;
      const same = !!was && !!now && now.compareBoundaryPoints(Range.START_TO_START, was) === 0 && now.compareBoundaryPoints(Range.END_TO_END, was) === 0;
      if (!same) setPick(undefined);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [pick]);

  /** The toolbar given up (Escape, "Cancel", a press elsewhere): the browser's selection goes too (I2). */
  const dropPick = () => {
    setPick(undefined);
    opts.current.onPickClosed?.(false);
    window.getSelection?.()?.removeAllRanges();
  };
  const cancel = (): boolean => {
    if (!pick && !menu) return false;
    if (pick) dropPick();
    setMenu(undefined);
    return true;
  };
  const say = (text: string) => setAnnouncement((s) => ({ text, n: (s?.n ?? 0) + 1 }));

  const create = async (colour: HighlightColourName) => {
    const p = pick;
    setPick(undefined);
    opts.current.onPickClosed?.(true);
    lastUsed = colour;
    setLastColour(colour);
    const { api, projectId, sourceId, assetId, handle: h, isLive, readOnly } = opts.current;
    // A7: only from a live handle, checked again now.
    if (!p || !h || !isLive(h) || !assetId || readOnly) return;
    window.getSelection?.()?.removeAllRanges();
    const first = p.anchors[0]!;
    const printed = h.pageLabels?.[first.page - 1];
    const body: AnnotationCreateRequest = {
      kind: "highlight",
      assetId,
      anchors: p.anchors.map((a) => ({ page: a.page, rects: a.rects.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })), sortIndex: a.sortIndex })),
      quote: p.anchors.map((a) => a.quote).join(" "),
      colorName: colour,
      ...(printed && printed !== String(first.page) && printed.length <= PAGE_LABEL_MAX && !CONTROL.test(printed) ? { pageLabel: printed } : {}),
    };
    const id = `draft:${++seq.current}`;
    const draft: AnnotationRecord = {
      id,
      sourceId,
      kind: "highlight",
      pdfAnchors: body.anchors.map((a, i) => ({ id: `${id}:${i}`, assetId, page: a.page, rects: a.rects, sortIndex: a.sortIndex ?? "", sortIndexDerived: false })),
      otherAnchorKinds: [],
      colorName: colour,
      imported: false,
      author: "",
      createdAt: new Date().toISOString(),
    };
    setDrafts((d) => [...d, draft]);
    setAlert(undefined);
    say(ADDING);
    const dropDraft = () => setDrafts((d) => d.filter((x) => x.id !== id));
    let made: AnnotationRecord;
    try {
      made = await api().createAnnotation(projectId, sourceId, body);
    } catch (e) {
      // An answer after the document ended, failed or was opened again is dropped (A7).
      if (!isLive(h) || opts.current.handle !== h) return;
      dropDraft();
      if (e instanceof ApiClientError && e.status === 423) {
        opts.current.onLocked(h);
        return;
      }
      if (e instanceof ApiClientError && e.status === 404) opts.current.onProjectInDoubt();
      setAlert(e instanceof Error && e.message ? e.message : SERVICE_SILENT);
      return;
    }
    if (!isLive(h) || opts.current.handle !== h) {
      // Dropped (A7) — but stored: if this file was opened again meanwhile, its list is asked for again (M2).
      const now = opts.current.handle;
      if (now && now !== h && opts.current.isLive(now) && opts.current.assetId === assetId) opts.current.onStoredMeanwhile();
      return;
    }
    dropDraft();
    opts.current.onCreated(made);
    const pages = made.pdfAnchors.filter((a) => a.assetId === assetId).map((a) => a.page);
    const lo = Math.min(...pages);
    const hi = Math.max(...pages);
    const where = pages.length === 0 ? "" : lo === hi ? `, page ${lo}` : `, pages ${lo}–${hi}`;
    say(`Highlight added: ${label(made.colorName)}${where}.`);
  };

  /** Where a point of page `pageIndex` lies in the page area (CSS pixels), or nothing when the page is not there. */
  const inArea = (pageIndex: number, left: number, top: number): { left: number; top: number } | undefined => {
    const root = opts.current.area.current;
    const el = root?.querySelector<HTMLElement>(`[data-page-number="${pageIndex + 1}"]`);
    if (!root || !el) return undefined;
    const a = root.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    return { left: p.left - a.left + el.clientLeft + left, top: p.top - a.top + el.clientTop + top };
  };
  /** The pages' view (the scroller's inside) in the page area's coordinates: the toolbar and the menu stay in it (M5). */
  const viewBounds = (): Box | undefined => {
    const root = opts.current.area.current;
    const sc = root?.querySelector<HTMLElement>(".ao-reader-scroll");
    if (!root || !sc) return undefined;
    const a = root.getBoundingClientRect();
    const v = sc.getBoundingClientRect();
    return { left: v.left - a.left + sc.clientLeft, top: v.top - a.top + sc.clientTop, width: sc.clientWidth, height: sc.clientHeight };
  };

  /** HighlightLayer's `onOverlap` for page `pageIndex` (one function a page, so that a page's layer is not drawn again for nothing). */
  const overlapFns = useRef(new Map<number, (ids: string[], at: { left: number; top: number }) => void>());
  const onOverlapAt = useCallback((pageIndex: number) => {
    let f = overlapFns.current.get(pageIndex);
    if (!f) {
      f = (ids, at) => {
        setPick(undefined);
        setMenu({ pageIndex, at, ids });
      };
      overlapFns.current.set(pageIndex, f);
    }
    return f;
  }, []);
  const draftIds = useMemo(() => new Set(drafts.map((d) => d.id)), [drafts]);

  let floating: ReactNode = null;
  if (pick) {
    const vp = viewports.current.get(pick.pageIndex);
    const b = vp ? pdfRectToBox(pick.rect, vp) : undefined;
    const at = b ? inArea(pick.pageIndex, b.left, b.top) : undefined;
    if (b && at) {
      const anchorBox: Box = { left: at.left, top: at.top, width: b.width, height: b.height };
      const bounds = viewBounds();
      floating = <HighlightToolbar anchorBox={anchorBox} {...(bounds ? { bounds } : {})} lastColour={lastColour} onHighlight={(c) => void create(c)} onCancel={dropPick} />;
    }
  } else if (menu) {
    const at = inArea(menu.pageIndex, menu.at.left, menu.at.top);
    const byId = new Map((opts.current.annotations ?? []).map((a) => [a.id, a]));
    const items = menu.ids.flatMap((id) => {
      const a = byId.get(id);
      return a ? [{ id, colorName: a.colorName, words: a.quote || a.body || "" }] : [];
    });
    const bounds = viewBounds();
    if (at && items.length > 1)
      floating = (
        <OverlapMenu
          at={at}
          {...(bounds ? { bounds } : {})}
          items={items}
          onChoose={(id) => {
            setMenu(undefined);
            opts.current.onSelect(id);
          }}
          onClose={() => setMenu(undefined)}
        />
      );
  }

  const notices: ReactNode = (
    <>
      {readOnlySaid && (
        <p role="status" className="ao-reader-making-note">
          {READ_ONLY_MAKING}
        </p>
      )}
      {alert !== undefined && (
        <p role="alert" className="ao-reader-making-note">
          {alert}
        </p>
      )}
    </>
  );

  return {
    noteViewport,
    drafts,
    draftIds,
    onOverlapAt,
    floating,
    notices,
    announcement,
    cancel,
    /** The keyboard's path (Task R11): its own range, read exactly as a mouse selection is (`offer`). */
    takeRange: offer,
    /** Says `text` in the list's live region (the one polite region of the reader). */
    say,
    /** Whether the colour toolbar is shown. */
    picking: pick !== undefined,
    /** Placed again on a scroll of the pages (the toolbar and the menu follow their page). */
    onScroll: () => {
      if (pick || menu) setTick((n) => n + 1);
    },
  };
}
