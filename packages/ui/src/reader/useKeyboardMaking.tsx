/**
 * Highlights and page notes without a mouse on the reader screen (Task R11): what the screen
 * (Reader.tsx) adds, kept here so that the screen's own code stays small.
 *
 * Select text (button, or the key S on the page area). The selection is the app's own
 * (keyboardSelection.ts): word by word, in the order the PDF stores its text, over the text items of
 * the pages drawn when it starts (the current page and the drawn pages next to it, without a gap). It
 * starts at the first word visible on the current page; Shift+Right and Shift+Left extend or shrink it
 * by a word, Shift+Down and Shift+Up by a line, across into the next or the previous page. It is shown
 * on the page as the mouse's selection is (it IS the browser's selection, with the same tint), and
 * its moving end is kept in view by scrolling the pages. At the edge of the drawn pages it stops, with
 * R10's sentence (PAGES_NOT_SHOWN): a page that is not drawn has no text to select (A9).
 *  - Said in the reader's one polite live region (the list's, R9): "Selected: <the first 200
 *    characters>", at most once every ANNOUNCE_MS, the last state always said; "Selection cancelled."
 *    when it ends without a highlight.
 *  - Enter hands its range to R10's making (`takeRange`): the same reading of a range
 *    (`selectionToAnchors`), the same refusals in the same words, the same toolbar (which takes the
 *    focus), the same create, draft, announcement and list update. A further Shift+arrow from the page
 *    area changes the selection, which closes the toolbar (R10, N1); choosing a colour ends the
 *    selection; Escape or "Cancel" end it.
 *  - Escape on the page area ends it; the focus stays on the page area.
 *
 * Add a note to this page (button, or the key N on the page area): a note field ("Note", "Save note",
 * "Cancel": R9's own NoteEditor) for the current page, the note placed at the top left of the page's
 * visible part; "Place by clicking" waits for a click on a page (Escape stops waiting; a click
 * anywhere else places nothing). Nothing is saved by itself (R192): "Save note" or Ctrl/Cmd+Enter
 * sends ONE create (kind "note"), the text as typed (the service's rules, R198: its sentence shown);
 * a changed note is not abandoned (Escape, "Cancel", the app's own navigation) without "Discard this
 * note?" (R216). The saved note is drawn on its page and listed at once (`onCreated`, the same as a
 * highlight), and the focus goes back to the page area.
 *
 * The keys S and N act only on the page area (never in a field, a menu, a dialog or the colour
 * toolbar; never with Ctrl, Cmd or Alt; never while an input method is composing). Read-only: both
 * buttons are disabled, their reason shown; the keys say it once.
 *
 * When the document goes (A7, A9, A10, A13: locked, closed, a failed range, another file, the screen
 * left), nothing is kept: the selection (and the browser's), the note field and its text, the wait
 * for a click, a request on its way (its answer is dropped), the timers.
 */
import { pdfSortIndex } from "@ao/core/annotations/sortIndex";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ApiClientError } from "../api/client";
import type { AnnotationCreateRequest, AnnotationRecord, PdfRectDto, ReaderApi } from "../api/reader";
import { NOTE_BUSY, NoteEditor, Question, useNoteHold } from "./AnnotationList";
import { createKeyboardSelection, textItemsOf, type KeyboardSelection, type TextItemRef } from "./keyboardSelection";
import type { TextContent } from "./PdfPages";
import type { PdfHandle } from "./pdfjs";
import { END_OF_CONTENT_CLASS } from "./textLayerSelection";
import { PAGE_STILL_DRAWING, PAGES_NOT_SHOWN, READ_ONLY_MAKING } from "./useHighlightMaking";

export const NO_TEXT_TO_SELECT = "This page has no text to select.";
export const SELECTION_CANCELLED = "Selection cancelled.";
/** The stated limit (Accept 4), in the reader's "Keyboard help". */
export const KEYBOARD_ORDER_LIMIT = "Text is selected in the order the PDF stores it, which for some two-column or unusual layouts is not the reading order.";
export const READ_ONLY_NOTES = "This library is read-only, so notes cannot be added.";
export const SELECTING_NOW = "Text is being selected. Press Escape to end the selection first.";
export const NOTE_OPEN = "A note is being written. Save it or cancel it first.";
export const PLACING = "Click on a page to place the note. Press Escape to stop.";
export const PLACING_STOPPED = "The note stays where it was.";
export const NOT_ON_A_PAGE = "Nothing was placed: the click was not on a page.";
export const NOTE_PAGE_DRAWING = "This page is still being drawn. Add the note again in a moment.";
export const ADDING_NOTE = "Adding the note…";
const SERVICE_SILENT = "The library service did not answer, so the note was not added.";
/** At most one "Selected: …" a this many milliseconds; the last one is always said. */
export const ANNOUNCE_MS = 500;
/** How many characters of the selection are said. */
export const SELECTED_CHARS = 200;
/** A page note's mark, in points (Zotero's own size). */
export const NOTE_SIZE_PT = 22;
/** How far inside the visible part of a page a note placed by keyboard goes, in CSS pixels. */
const NOTE_INSET_PX = 8;
/** How far from the view's edge the selection's moving end is kept, in CSS pixels. */
const KEEP_IN_VIEW_PX = 24;
const PAGE_LABEL_MAX = 64;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
const round = (v: number) => Math.round(v * 1000) / 1000;
/** Unicode's isolate marks: the selected text keeps its own direction inside the sentence. */
const FSI = "⁨";
const PDI = "⁩";

/** "Selected: <the first 200 characters>": white space made single, cut by characters (never in the middle of one). */
export function selectedSentence(text: string): string {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  const cut = chars.slice(0, SELECTED_CHARS).join("");
  return `Selected: ${FSI}${cut}${PDI}${chars.length > SELECTED_CHARS ? "…" : ""}`;
}

/**
 * A page note's square of NOTE_SIZE_PT points with its top left corner at (`x`, `y`) of the page as
 * drawn (CSS pixels from the page's inner corner), kept on the page, in PDF space (whatever the view's
 * and the page's own rotation).
 */
export function noteRectAt(vp: PageViewport, x: number, y: number): PdfRectDto {
  const size = NOTE_SIZE_PT * vp.scale;
  const left = Math.min(Math.max(0, x), Math.max(0, vp.width - size));
  const top = Math.min(Math.max(0, y), Math.max(0, vp.height - size));
  const [x0, y0] = vp.convertToPdfPoint(left, top) as [number, number];
  const [x1, y1] = vp.convertToPdfPoint(left + size, top + size) as [number, number];
  return { x: round(Math.min(x0, x1)), y: round(Math.min(y0, y1)), w: round(Math.abs(x1 - x0)), h: round(Math.abs(y1 - y0)) };
}

/**
 * A page note's sort index (A1, R195 c), in the same form as a highlight's: its page, the offset in
 * the page's text of the first item (in pdf.js's order) whose top is not above the note's top, and
 * the note's distance from the page's top.
 */
export function noteSortIndex(pageIndex: number, rect: PdfRectDto, vp: PageViewport, text: TextContent | undefined): string {
  const noteTop = rect.y + rect.h;
  let offset = 0;
  for (const item of text?.items ?? []) {
    if (!("str" in item)) continue;
    const top = item.transform[5]! + (item.height || Math.hypot(item.transform[2]!, item.transform[3]!));
    if (item.str.trim() !== "" && top <= noteTop + 0.5) break;
    offset += item.str.length;
  }
  const pageTop = Array.isArray(vp.viewBox) ? Math.max(vp.viewBox[1]!, vp.viewBox[3]!) : noteTop;
  return pdfSortIndex(pageIndex, offset, pageTop - noteTop);
}

/** Whether the browser's selection `now` is still the keyboard's `mine` (a browser may express the same place another way). */
function sameSelection(now: Range, mine: Range): boolean {
  if (now.compareBoundaryPoints(Range.START_TO_START, mine) === 0 && now.compareBoundaryPoints(Range.END_TO_END, mine) === 0) return true;
  return now.toString() === mine.toString() && now.intersectsNode(mine.startContainer) && now.intersectsNode(mine.endContainer);
}

const isComposing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

export interface KeyboardMakingOptions {
  api: () => ReaderApi;
  projectId: string;
  sourceId: string;
  assetId: string | undefined;
  handle: PdfHandle | undefined;
  isLive(h: PdfHandle): boolean;
  readOnly: boolean;
  /** The page area (positioned; the note field is placed in it). */
  area: RefObject<HTMLDivElement | null>;
  /** The current page (1-based) and the page count. */
  page: number;
  count: number;
  /** A drawn page's text as the pages read it (0-based index), if it is still kept. */
  pageText(pageIndex: number): TextContent | undefined;
  /** R10's making: the range reader, the live region, whether its toolbar is shown. */
  making: { takeRange(range: Range): boolean; say(text: string): void; picking: boolean };
  onCreated(r: AnnotationRecord): void;
  onStoredMeanwhile(): void;
  onLocked(h: PdfHandle): void;
  onProjectInDoubt(): void;
}

interface NoteDraft {
  /** Moves on with each note field opened (a new field, a new text). */
  seq: number;
  page: number;
  rect: PdfRectDto;
  how: "view" | "click";
}

export function useKeyboardMaking(o: KeyboardMakingOptions) {
  const opts = useRef(o);
  opts.current = o;
  const { handle, readOnly } = o;
  const id = useId();
  const viewports = useRef(new Map<number, PageViewport>());
  const ksel = useRef<KeyboardSelection | undefined>(undefined);
  const [selecting, setSelecting] = useState(false);
  const [alert, setAlert] = useState<string | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [note, setNote] = useState<NoteDraft | undefined>(undefined);
  const [notePending, setNotePending] = useState(false);
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const [noteDirty, setNoteDirty] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<{ then: () => void } | undefined>(undefined);
  const [placing, setPlacing] = useState(false);
  const sending = useRef(false);
  const noteSeq = useRef(0);
  const focusToolbar = useRef(false);
  /** The keys already refused for read-only (each said once). */
  const saidReadOnly = useRef(new Set<string>());
  const noteRoot = useRef<HTMLElement>(null);

  // ---- saying, at most once every ANNOUNCE_MS, the last state always ------------------------------
  const lastSaid = useRef(Number.NEGATIVE_INFINITY);
  const waiting = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (text: string) => opts.current.making.say(text);
  const flush = () => {
    timer.current = undefined;
    const t = waiting.current;
    waiting.current = undefined;
    if (t === undefined) return;
    lastSaid.current = Date.now();
    say(t);
  };
  const announce = (text: string) => {
    const now = Date.now();
    if (timer.current === undefined && now - lastSaid.current >= ANNOUNCE_MS) {
      lastSaid.current = now;
      say(text);
      return;
    }
    waiting.current = text;
    timer.current ??= setTimeout(flush, Math.max(0, lastSaid.current + ANNOUNCE_MS - now));
  };
  const hush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    waiting.current = undefined;
  };

  // ---- the page area -------------------------------------------------------------------------------
  const scroller = () => opts.current.area.current?.querySelector<HTMLElement>(".ao-reader-scroll") ?? null;
  const focusArea = () => {
    const sc = scroller();
    if (sc && !sc.contains(document.activeElement)) sc.focus({ preventScroll: true });
  };
  const pageBox = (n: number) => opts.current.area.current?.querySelector<HTMLElement>(`[data-page-number="${n}"]`) ?? null;
  /** A drawn page's text items, once its text layer is laid out ([] for a drawn page with no text); undefined when it is not. */
  const itemsOfPage = (n: number): TextItemRef[] | undefined => {
    const el = pageBox(n);
    if (!el?.hasAttribute("data-rendered")) return undefined;
    if (el.querySelector(".ao-reader-no-text")) return [];
    const layer = el.querySelector(".ao-reader-text-layer");
    if (!layer?.querySelector(`:scope > .${END_OF_CONTENT_CLASS}`)) return undefined;
    return textItemsOf(n, layer);
  };

  /** Called by the screen's overlay for each drawn page: the viewport it is drawn at now. */
  const noteViewport = useCallback((pageIndex: number, viewport: PageViewport) => {
    viewports.current.set(pageIndex, viewport);
  }, []);

  // ---- the selection --------------------------------------------------------------------------------
  /** Ends the keyboard's selection; `quietly`: nothing said; `keepBrowser`: the browser's selection is no longer ours to remove. */
  const endSelection = (how: { quietly?: boolean; keepBrowser?: boolean } = {}) => {
    const sel = ksel.current;
    if (!sel) return;
    sel.cancel();
    ksel.current = undefined;
    setSelecting(false);
    hush();
    if (!how.keepBrowser) window.getSelection?.()?.removeAllRanges();
    if (!how.quietly) say(SELECTION_CANCELLED);
  };

  /** Shows the selection as the browser's own (the same tint as the mouse's); false when a page of it is no longer drawn. */
  const show = (): boolean => {
    const r = ksel.current?.range();
    if (!r) {
      endSelection();
      setAlert(PAGES_NOT_SHOWN);
      return false;
    }
    const s = window.getSelection?.();
    s?.removeAllRanges();
    s?.addRange(r);
    return true;
  };

  /** Scrolls the pages so that the selection's moving end is in view. */
  const keepInView = () => {
    const fr = ksel.current?.focusRange();
    const sc = scroller();
    if (!fr || !sc || typeof fr.getBoundingClientRect !== "function") return;
    const b = fr.getBoundingClientRect();
    const v = sc.getBoundingClientRect();
    const bottom = v.top + sc.clientHeight;
    const right = v.left + sc.clientWidth;
    if (b.bottom > bottom - KEEP_IN_VIEW_PX) sc.scrollTop += b.bottom - bottom + KEEP_IN_VIEW_PX;
    else if (b.top < v.top + KEEP_IN_VIEW_PX) sc.scrollTop -= v.top + KEEP_IN_VIEW_PX - b.top;
    if (b.right > right - KEEP_IN_VIEW_PX) sc.scrollLeft += b.right - right + KEEP_IN_VIEW_PX;
    else if (b.left < v.left + KEEP_IN_VIEW_PX) sc.scrollLeft -= v.left + KEEP_IN_VIEW_PX - b.left;
  };

  /** Whether page `n` (the current one) is known to have no text. */
  const noText = (n: number) => {
    const t = opts.current.pageText(n - 1);
    return !!t && !t.items.some((i) => "str" in i && i.str.trim() !== "");
  };

  /** Why "Select text" cannot act now, or nothing. */
  const selectWhy = (): string | undefined => {
    if (opts.current.readOnly) return READ_ONLY_MAKING;
    if (note) return NOTE_OPEN;
    if (selecting) return SELECTING_NOW;
    if (noText(opts.current.page)) return NO_TEXT_TO_SELECT;
    return undefined;
  };
  /** Why "Add a note to this page" cannot act now, or nothing. */
  const noteWhy = (): string | undefined => {
    if (opts.current.readOnly) return READ_ONLY_NOTES;
    if (selecting) return SELECTING_NOW;
    return undefined;
  };
  /** Says why a key cannot act (read-only: once a key). */
  const refuse = (key: string, why: string) => {
    if (opts.current.readOnly) {
      if (saidReadOnly.current.has(key)) return;
      saidReadOnly.current.add(key);
    }
    say(why);
  };

  const startSelection = (key: string) => {
    const why = selectWhy();
    if (why) return refuse(key, why);
    const { handle: h, isLive, page: n } = opts.current;
    if (!h || !isLive(h)) return;
    const here = itemsOfPage(n);
    if (here === undefined) {
      setAlert(PAGE_STILL_DRAWING);
      return;
    }
    // The drawn pages next to the current one, without a gap.
    const before: TextItemRef[][] = [];
    for (let p = n - 1; p >= 1; p--) {
      const items = itemsOfPage(p);
      if (items === undefined) break;
      before.unshift(items);
    }
    const after: TextItemRef[][] = [];
    for (let p = n + 1; p <= opts.current.count; p++) {
      const items = itemsOfPage(p);
      if (items === undefined) break;
      after.push(items);
    }
    const sc = scroller();
    const sel = createKeyboardSelection([...before.flat(), ...here, ...after.flat()], {
      page: n,
      view: () => {
        const b = sc?.getBoundingClientRect();
        return b ? { left: b.left, top: b.top, width: sc!.clientWidth, height: sc!.clientHeight } : { left: 0, top: 0, width: 0, height: 0 };
      },
    });
    if (!sel.start("first-visible-word")) {
      say(NO_TEXT_TO_SELECT);
      return;
    }
    setAlert(undefined);
    ksel.current = sel;
    setSelecting(true);
    focusArea();
    if (!show()) return;
    keepInView();
    announce(selectedSentence(sel.text()));
  };

  const extend = (by: "word" | "line", dir: 1 | -1) => {
    const sel = ksel.current;
    if (!sel) return;
    if (sel.extend(by, dir) === "edge") {
      // The document's start or end: nothing to say. The edge of the drawn pages: R10's sentence.
      if (dir > 0 ? sel.pages.last < opts.current.count : sel.pages.first > 1) setAlert(PAGES_NOT_SHOWN);
      return;
    }
    setAlert(undefined);
    if (!show()) return;
    keepInView();
    announce(selectedSentence(sel.text()));
  };

  const offerColours = () => {
    const sel = ksel.current;
    const r = sel?.range();
    if (!sel || !r) {
      endSelection();
      setAlert(PAGES_NOT_SHOWN);
      return;
    }
    hush();
    if (opts.current.making.takeRange(r)) focusToolbar.current = true;
  };

  // The toolbar opened by Enter takes the focus (on "Highlight").
  const { picking } = o.making;
  useEffect(() => {
    if (!picking || !focusToolbar.current) return;
    focusToolbar.current = false;
    opts.current.area.current?.querySelector<HTMLElement>(".ao-hl-toolbar button")?.focus();
  }, [picking]);

  /** R10's toolbar given up or used: the keyboard's selection ends with it (said only when nothing was made). */
  const onPickClosed = (made: boolean) => {
    focusToolbar.current = false;
    if (ksel.current) endSelection({ quietly: made, keepBrowser: true });
  };

  // The selection changed by anything else (a click, the page drawn again at another zoom): it ends.
  useEffect(() => {
    if (!selecting) return;
    const onChange = () => {
      const sel = ksel.current;
      // The focus moved into the colour toolbar (some engines then report a change): not a change.
      if (!sel || document.activeElement?.closest(".ao-hl-toolbar")) return;
      const mine = sel.range();
      const s = window.getSelection?.();
      const now = s && s.rangeCount > 0 ? s.getRangeAt(0) : undefined;
      if (mine && now && sameSelection(now, mine)) return;
      // A page of it no longer drawn (another zoom, the window of pages moved): what is left of it is
      // still the keyboard's, and goes. A selection made by anything else is left as it is.
      endSelection({ keepBrowser: mine !== null });
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
    // endSelection reads the latest state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  // ---- the page note ---------------------------------------------------------------------------------
  const textArea = () => noteRoot.current?.querySelector<HTMLTextAreaElement>("textarea") ?? null;

  /** The top left of the visible part of page `n`, as a note's square in PDF space; undefined when the page is not drawn. */
  const visibleTopLeft = (n: number): PdfRectDto | undefined => {
    const el = pageBox(n);
    const sc = scroller();
    const vp = viewports.current.get(n - 1);
    if (!el?.hasAttribute("data-rendered") || !sc || !vp) return undefined;
    const p = el.getBoundingClientRect();
    const v = sc.getBoundingClientRect();
    const x = Math.max(0, v.left - (p.left + el.clientLeft)) + NOTE_INSET_PX;
    const y = Math.max(0, v.top - (p.top + el.clientTop)) + NOTE_INSET_PX;
    return noteRectAt(vp, x, y);
  };

  const openNote = (key: string) => {
    const why = noteWhy();
    if (why) return refuse(key, why);
    if (note) {
      textArea()?.focus();
      return;
    }
    const { handle: h, isLive, page: n } = opts.current;
    if (!h || !isLive(h)) return;
    const rect = visibleTopLeft(n);
    if (!rect) {
      setAlert(NOTE_PAGE_DRAWING);
      return;
    }
    setAlert(undefined);
    setNoteError(undefined);
    setNoteDirty(false);
    setNote({ seq: ++noteSeq.current, page: n, rect, how: "view" });
  };

  const closeNote = (focus: boolean) => {
    setNote(undefined);
    setNoteDirty(false);
    setNoteError(undefined);
    setPlacing(false);
    setDiscardAsk(undefined);
    if (focus) focusArea();
  };

  // Waiting for a click on a page ("Place by clicking"): Escape stops; a click elsewhere places nothing.
  useEffect(() => {
    if (!placing) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".ao-reader-note")) return;
      setPlacing(false);
      const el = t?.closest<HTMLElement>("[data-page-number]");
      const n = el ? Number(el.dataset.pageNumber) : NaN;
      const vp = viewports.current.get(n - 1);
      if (!el || !opts.current.area.current?.contains(el) || !el.hasAttribute("data-rendered") || !vp) {
        say(NOT_ON_A_PAGE);
        return;
      }
      // The press places the note; it starts no selection.
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const rect = noteRectAt(vp, e.clientX - b.left - el.clientLeft, e.clientY - b.top - el.clientTop);
      setNote((d) => (d ? { ...d, page: n, rect, how: "click" } : d));
      say(`Note placed on page ${n}.`);
      setTimeout(() => textArea()?.focus(), 0);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPlacing(false);
      say(PLACING_STOPPED);
      textArea()?.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // say and textArea read the latest state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing]);

  const saveNote = async (text: string) => {
    const d = note;
    const { api, projectId, sourceId, assetId, handle: h, isLive, readOnly: ro } = opts.current;
    // One request a press; only from a live handle (A7).
    if (!d || sending.current || !h || !isLive(h) || !assetId || ro) return;
    const vp = viewports.current.get(d.page - 1);
    const printed = h.pageLabels?.[d.page - 1];
    const body: AnnotationCreateRequest = {
      kind: "note",
      assetId,
      anchors: [{ page: d.page, rects: [d.rect], ...(vp ? { sortIndex: noteSortIndex(d.page - 1, d.rect, vp, opts.current.pageText(d.page - 1)) } : {}) }],
      body: text,
      colorName: "yellow",
      ...(printed && printed !== String(d.page) && printed.length <= PAGE_LABEL_MAX && !CONTROL.test(printed) ? { pageLabel: printed } : {}),
    };
    sending.current = true;
    setNotePending(true);
    setNoteError(undefined);
    say(ADDING_NOTE);
    let made: AnnotationRecord;
    try {
      made = await api().createAnnotation(projectId, sourceId, body);
    } catch (e) {
      // An answer after the document ended, failed or was opened again is dropped (A7).
      if (!isLive(h) || opts.current.handle !== h) return;
      sending.current = false;
      setNotePending(false);
      if (e instanceof ApiClientError && e.status === 423) {
        opts.current.onLocked(h);
        return;
      }
      if (e instanceof ApiClientError && e.status === 404) opts.current.onProjectInDoubt();
      setNoteError(e instanceof Error && e.message ? e.message : SERVICE_SILENT);
      return;
    }
    if (!isLive(h) || opts.current.handle !== h) {
      // Dropped (A7) — but stored: if this file was opened again meanwhile, its list is asked for again.
      const now = opts.current.handle;
      if (now && now !== h && opts.current.isLive(now) && opts.current.assetId === assetId) opts.current.onStoredMeanwhile();
      return;
    }
    sending.current = false;
    setNotePending(false);
    closeNote(true);
    opts.current.onCreated(made);
    say(`Note added, page ${d.page}.`);
  };

  /** "Cancel" or Escape in the note field: asked first when something was typed (R216). */
  const abandonNote = (text: string) => {
    if (text !== "") setDiscardAsk({ then: () => closeNote(true) });
    else closeNote(true);
  };
  // A typed note holds the app's own way out (R192 e, R216); the reader ending lets go of it unasked.
  useNoteHold(noteDirty && note !== undefined, (then) =>
    setDiscardAsk({
      then: () => {
        closeNote(false);
        then();
      },
    }),
  );

  // ---- everything goes with the document (A7, A9, A10, A13) ------------------------------------------
  useEffect(() => {
    const vps = viewports.current;
    return () => {
      vps.clear();
      if (ksel.current) {
        ksel.current.cancel();
        ksel.current = undefined;
        window.getSelection?.()?.removeAllRanges();
      }
      hush();
      sending.current = false;
      focusToolbar.current = false;
      setSelecting(false);
      setAlert(undefined);
      setNote(undefined);
      setNoteDirty(false);
      setNotePending(false);
      setNoteError(undefined);
      setPlacing(false);
      setDiscardAsk(undefined);
    };
    // hush reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // ---- keys on the page area ---------------------------------------------------------------------------
  /** The page area's keys (Reader.tsx calls it first, after its own checks for fields and modifier keys); true when the key was used. */
  const onKey = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (isComposing(e) || e.ctrlKey || e.metaKey || e.altKey) return false;
    const t = e.target instanceof Element ? e.target : null;
    const onPages = !!t?.closest(".ao-reader-scroll");
    const k = e.key;
    if (ksel.current) {
      if (e.shiftKey && onPages && (k === "ArrowRight" || k === "ArrowLeft" || k === "ArrowDown" || k === "ArrowUp")) {
        extend(k === "ArrowRight" || k === "ArrowLeft" ? "word" : "line", k === "ArrowRight" || k === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (k === "Enter" && !e.shiftKey && onPages) {
        offerColours();
        return true;
      }
      if (k === "Escape") {
        endSelection();
        focusArea();
        return true;
      }
    }
    if (!onPages) return false;
    if (k === "s" || k === "S") {
      if (ksel.current) say(SELECTING_NOW);
      else startSelection("s");
      return true;
    }
    if (k === "n" || k === "N") {
      openNote("n");
      return true;
    }
    return false;
  };

  // ---- what the screen shows -----------------------------------------------------------------------------
  const sWhy = selectWhy();
  const nWhy = noteWhy();
  const buttons: ReactNode = (
    <span className="ao-reader-toolbar__group">
      <button
        type="button"
        aria-keyshortcuts="S"
        disabled={readOnly}
        aria-disabled={sWhy && !readOnly ? true : undefined}
        aria-describedby={sWhy ? `${id}-select-why` : undefined}
        onClick={() => (sWhy ? say(sWhy) : startSelection("button"))}
      >
        Select text
      </button>
      <button
        type="button"
        aria-keyshortcuts="N"
        disabled={readOnly}
        aria-disabled={nWhy && !readOnly ? true : undefined}
        aria-describedby={nWhy ? `${id}-note-why` : undefined}
        onClick={() => (nWhy ? say(nWhy) : openNote("button"))}
      >
        Add a note to this page
      </button>
      <button type="button" aria-expanded={helpOpen} aria-controls={`${id}-help`} onClick={() => setHelpOpen((x) => !x)}>
        Keyboard help
      </button>
    </span>
  );

  const reasons: ReactNode =
    sWhy || nWhy ? (
      <div className="ao-reader-why">
        {sWhy && <p id={`${id}-select-why`}>Select text: {sWhy}</p>}
        {nWhy && <p id={`${id}-note-why`}>Add a note to this page: {nWhy}</p>}
      </div>
    ) : null;

  const help: ReactNode = (
    <section id={`${id}-help`} aria-label="Keyboard help" className="ao-reader-help" hidden={!helpOpen}>
      <h2>Keyboard help</h2>
      <p>These keys work when the pages have the focus.</p>
      <dl>
        <dt>Page Down, Page Up</dt>
        <dd>Next page, previous page</dd>
        <dt>Home, End</dt>
        <dd>First page, last page</dd>
        <dt>+ and −</dt>
        <dd>Zoom in, zoom out</dd>
        <dt>Arrow keys</dt>
        <dd>Scroll the pages</dd>
        <dt>S</dt>
        <dd>Select text, starting at the first word you can see on the page</dd>
        <dt>Shift+Right Arrow, Shift+Left Arrow</dt>
        <dd>Make the selection a word longer or shorter</dd>
        <dt>Shift+Down Arrow, Shift+Up Arrow</dt>
        <dd>Make the selection a line longer or shorter, into the next or the previous page</dd>
        <dt>Enter</dt>
        <dd>Highlight the selected text: choose a colour</dd>
        <dt>Escape</dt>
        <dd>End the selection</dd>
        <dt>N</dt>
        <dd>Add a note to this page, at the top left of what you can see</dd>
        <dt>Ctrl+Enter (Cmd+Enter on a Mac)</dt>
        <dd>Save the note</dd>
      </dl>
      <p>{KEYBOARD_ORDER_LIMIT}</p>
    </section>
  );

  let panel: ReactNode = null;
  if (note) {
    const where = note.how === "view" ? `On page ${note.page}, at the top left of what is shown.` : `On page ${note.page}, where you clicked.`;
    panel = (
      <section ref={noteRoot} className="ao-reader-note" aria-label={`Note on page ${note.page}`}>
        <p className="ao-reader-note__where">{where}</p>
        <NoteEditor key={note.seq} saved="" pending={notePending} onSave={(text) => void saveNote(text)} onAbandon={abandonNote} onBusy={() => say(NOTE_BUSY)} onDraft={(_text, dirty) => setNoteDirty(dirty)} />
        <button type="button" aria-pressed={placing} aria-disabled={notePending || undefined} onClick={() => !notePending && setPlacing((x) => !x)}>
          Place by clicking
        </button>
        {placing && (
          <p role="status" className="ao-reader-note__placing">
            {PLACING}
          </p>
        )}
        {noteError !== undefined && (
          <p role="alert" className="ao-reader-making-note">
            {noteError}
          </p>
        )}
      </section>
    );
  }

  const notices: ReactNode = (
    <>
      {panel}
      {alert !== undefined && (
        <p role="alert" className="ao-reader-making-note">
          {alert}
        </p>
      )}
      {discardAsk && (
        <Question
          title="Discard this note?"
          yes="Discard"
          no="Keep editing"
          onYes={() => {
            const then = discardAsk.then;
            setDiscardAsk(undefined);
            then();
          }}
          onNo={() => setDiscardAsk(undefined)}
        />
      )}
    </>
  );

  /** The note being written, drawn on its page as a draft (never chosen, never listed). */
  const draft: AnnotationRecord | undefined =
    note && o.assetId
      ? {
          id: `note-draft:${note.seq}`,
          sourceId: o.sourceId,
          kind: "note",
          pdfAnchors: [{ id: `note-draft:${note.seq}:0`, assetId: o.assetId, page: note.page, rects: [note.rect], sortIndex: "", sortIndexDerived: false }],
          otherAnchorKinds: [],
          colorName: "yellow",
          imported: false,
          author: "",
          createdAt: "",
        }
      : undefined;

  return {
    noteViewport,
    onKey,
    onPickClosed,
    buttons,
    reasons,
    help,
    notices,
    draft,
    selecting,
    placing,
  };
}
