/**
 * Highlights and page notes without a mouse on the reader screen (Task R11): "Select text" (or S)
 * starts the keyboard's own selection at the first word visible on the current page, Shift+arrows
 * extend it, Enter opens R10's colour toolbar (the SAME reading of a range, the same create); "Add a
 * note to this page" (or N) opens the note field, the note placed at the top left of the page's
 * visible part or where the researcher clicks, saved by "Save note" through the service's route (the
 * real client, the service mocked with MSW, every request recorded).
 *
 * pdf.js's own TextLayer lays out the stand-in pages' text as it does in a browser (one span an
 * item, a <br> at a line's end); jsdom lays nothing out, so a range's rectangles are worked out from
 * each item's place through the page's viewport, and where the pages are on screen is given where a
 * test needs it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi, type AnnotationCreateRequest, type AnnotationRecord } from "../api/reader";
import { pdfRectToBox } from "../reader/geometry";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { NOTE_FIRST } from "../reader/AnnotationList";
import { KEYBOARD_EDGE, KEYBOARD_HELP_KEYS, KEYBOARD_ORDER_LIMIT, NO_TEXT_TO_SELECT, NOT_ON_A_PAGE, PLACING, PLACING_STOPPED, selectedSentence, SELECTION_CANCELLED } from "../reader/useKeyboardMaking";
import { PAGES_NOT_SHOWN, READ_ONLY_MAKING } from "../reader/useHighlightMaking";
import { server, serviceError, testClient, url, useMockService } from "../test/service";
import { navigate } from "../navigation";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

useMockService();

const DOC = "/projects/:id/sources/:sid/assets/:aid/document";
const LIST = "/projects/:id/sources/:sid/annotations";

let requests: Array<{ method: string; path: string; body: string }> = [];
const record = async ({ request }: { request: Request }) => {
  requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.clone().text() });
};
const creates = () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/annotations")).map((r) => JSON.parse(r.body) as AnnotationCreateRequest);

function serveDocument(total = 4096) {
  server.use(
    http.get(url(DOC), ({ request }) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")!;
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), total - 1);
      return new HttpResponse(new Uint8Array(end - start + 1), { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes ${start}-${end}/${total}` } });
    }),
  );
}
function serveAnnotations(list: () => AnnotationRecord[]) {
  server.use(http.get(url(LIST), () => HttpResponse.json({ annotations: list(), count: list().length, textChars: 0 }) as unknown as Response));
}
function serveCreate(answer: (body: AnnotationCreateRequest) => Response | Promise<Response>) {
  server.use(http.post(url(LIST), async ({ request }) => answer((await request.clone().json()) as AnnotationCreateRequest)));
}

/** A viewport of an A4 page (view box 0 0 595 842), unrotated, as pdf.js makes it. */
function a4Viewport(scale: number) {
  const t = [scale, 0, 0, -scale, 0, 842 * scale] as const;
  return {
    width: 595 * scale,
    height: 842 * scale,
    scale,
    rotation: 0,
    viewBox: [0, 0, 595, 842],
    rawDims: { pageWidth: 595, pageHeight: 842, pageX: 0, pageY: 0 },
    transform: [...t],
    convertToViewportPoint: (x: number, y: number) => [t[0] * x + t[4], t[3] * y + t[5]],
    convertToPdfPoint: (x: number, y: number) => [(x - t[4]) / t[0], (y - t[5]) / t[3]],
  };
}

const ASCENT = 0.718;
const DESCENT = -0.207;
const SIZE = 10;
/** Each line of a page: its text and its baseline (x 50, 10-point Helvetica, 7.337 points a character). */
interface Line {
  str: string;
  y: number;
}
const linesOf = (n: number): Line[] => [
  { str: `Words of page ${n}`, y: 700 },
  { str: `Second line ${n}`, y: 680 },
];
/** Where each line's text is (by its text), for the stand-in measure of ranges. */
const placeOf = new Map<string, Line>();
const item = (l: Line, eol: boolean) => {
  placeOf.set(l.str, l);
  return { str: l.str, dir: "ltr", transform: [SIZE, 0, 0, SIZE, 50, l.y], width: 7.337 * l.str.length, height: SIZE, fontName: "f1", hasEOL: eol };
};
const glyphs = (l: Line, from: number, to: number) => ({ x: 50 + 7.337 * from, y: l.y + DESCENT * SIZE, w: 7.337 * (to - from), h: (ASCENT - DESCENT) * SIZE });

interface Fake {
  handle: PdfHandle;
  fail(e: PdfOpenError): void;
}
function fakeHandle(pages = 3, lines: (n: number) => Line[] = linesOf): Fake {
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => (fail = r));
  let dead = false;
  const page = (n: number) => ({
    pageNumber: n,
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => a4Viewport(scale),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => {
      const ls = lines(n);
      return { items: ls.map((l, i) => item(l, i < ls.length - 1)), styles: { f1: { fontFamily: "sans-serif", ascent: ASCENT, descent: DESCENT, vertical: false } }, lang: null };
    },
    cleanup: () => true,
  });
  const handle = {
    doc: { numPages: pages, getPage: async (n: number) => (dead ? Promise.reject(new PdfOpenError("other", "This document was closed.")) : page(n)), cleanup: async () => {} },
    pageCount: pages,
    pageLabels: null,
    failed,
    get dead() {
      return dead;
    },
    destroy: vi.fn(async () => {
      dead = true;
    }),
  } as unknown as PdfHandle;
  return {
    handle,
    fail: (e) => {
      dead = true;
      fail(e);
    },
  };
}

const SCALE = 96 / 72;
/** Unicode's isolate marks around the selected text in "Selected: …". */
const FSI = "\u2068";
const PDI = "\u2069";

/** jsdom has no Range.getClientRects: each piece of a line is measured from the line's place through the viewport. */
function layOutRanges() {
  Range.prototype.getClientRects = function (this: Range) {
    const n = this.startContainer;
    if (n !== this.endContainer || n.nodeType !== 3 || this.collapsed) return [] as unknown as DOMRectList;
    const l = placeOf.get((n as Text).data);
    if (!l) return [] as unknown as DOMRectList;
    const pageEl = (n.parentElement as Element).closest<HTMLElement>("[data-page-number]")!;
    const at = pageEl.getBoundingClientRect();
    const b = pdfRectToBox(glyphs(l, this.startOffset, this.endOffset), a4Viewport(SCALE) as never);
    return [{ left: at.left + b.left, top: at.top + b.top, width: b.width, height: b.height }] as unknown as DOMRectList;
  };
}

/** Page `n`'s text layer, once laid out to its end (the blank-space guard is put there last). */
async function laidOut(n: number): Promise<HTMLElement> {
  return waitFor(() => {
    const end = document.querySelector(`[data-page-number="${n}"] .ao-reader-text-layer > .ao-reader-end-of-content`);
    expect(end).toBeTruthy();
    return end!.parentElement!;
  });
}
const textNode = (n: number, str: string) => [...document.querySelectorAll(`[data-page-number="${n}"] .ao-reader-text-layer span`)].find((s) => s.textContent === str)!.firstChild as Text;

function screenFor(props: Partial<Parameters<typeof ReaderScreen>[0]> = {}) {
  return render(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} {...props} />);
}

const scroller = () => document.querySelector<HTMLElement>(".ao-reader-scroll")!;
const pageBox = (n: number) => document.querySelector<HTMLElement>(`[data-page-number="${n}"]`)!;
const colourBar = () => screen.queryByRole("toolbar", { name: "Highlight the selected text" });
const live = () => document.querySelector(".ao-ann-live")?.textContent ?? "";
const selected = () => window.getSelection()?.toString() ?? "";
const press = (target: Element, key: string, init: Partial<KeyboardEventInit> & { keyCode?: number; isComposing?: boolean } = {}) => fireEvent.keyDown(target, { key, ...init });
const shift = (target: Element, key: string) => press(target, key, { shiftKey: true });
/** Every text said in the live region from now on (in order, each change once). */
function hear(): () => string[] {
  const heard: string[] = [];
  const region = document.querySelector(".ao-ann-live")!;
  // Each saying is a new element in the region (the list keys it by its count): each is heard once.
  const watch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.textContent) heard.push(n.textContent);
  });
  watch.observe(region, { childList: true });
  return () => heard;
}
/** Lets what was said reach the live region (its effects and the observer's records). */
const settle = () => act(async () => {});
/** The listeners of the given kinds on the document now (a count of each, by kind and phase). */
const listening = new Map<string, number>();
function countListeners() {
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  const key = (type: string, o?: boolean | AddEventListenerOptions) => `${type}|${typeof o === "boolean" ? o : !!o?.capture}`;
  const seen = new Set<string>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (l: unknown) => {
    if (typeof l !== "function" && (typeof l !== "object" || l === null)) return -1;
    if (!ids.has(l as object)) ids.set(l as object, ++next);
    return ids.get(l as object)!;
  };
  vi.spyOn(document, "addEventListener").mockImplementation(((type: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    const k = `${key(type, o)}|${idOf(l)}`;
    if (!seen.has(k)) {
      seen.add(k);
      listening.set(key(type, o), (listening.get(key(type, o)) ?? 0) + 1);
      // A listener taken away by its signal (R10's text-layer guard) is gone too.
      const signal = typeof o === "object" ? o.signal : undefined;
      signal?.addEventListener("abort", () => {
        if (!seen.delete(k)) return;
        listening.set(key(type, o), (listening.get(key(type, o)) ?? 0) - 1);
      });
    }
    add(type, l, o);
  }) as typeof document.addEventListener);
  vi.spyOn(document, "removeEventListener").mockImplementation(((type: string, l: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
    const k = `${key(type, o)}|${idOf(l)}`;
    if (seen.has(k)) {
      seen.delete(k);
      listening.set(key(type, o), (listening.get(key(type, o)) ?? 0) - 1);
    }
    remove(type, l, o);
  }) as typeof document.removeEventListener);
  return () => Object.fromEntries([...listening].filter(([k, n]) => n > 0 && /^(keydown|keyup|mousedown|selectionchange)\|/.test(k)).sort());
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

function answerOf(body: AnnotationCreateRequest, id: string): AnnotationRecord {
  return {
    id,
    sourceId: "s1",
    kind: body.kind,
    pdfAnchors: body.anchors.map((a, i) => ({ id: `${id}-a${i}`, assetId: body.assetId, page: a.page, rects: a.rects, sortIndex: a.sortIndex ?? "", sortIndexDerived: false })),
    otherAnchorKinds: [],
    ...(body.quote !== undefined ? { quote: body.quote } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
    colorName: body.colorName,
    imported: false,
    author: "me",
    createdAt: "2026-11-13T11:00:00Z",
  };
}

/** The screen open on a 3-page file, its list in, page 1 laid out and the page area focused. */
async function opened(f: Fake = fakeHandle(3), props: Partial<Parameters<typeof ReaderScreen>[0]> = {}, withText = [1, 2]) {
  serveDocument();
  openPdf.mockResolvedValueOnce(f.handle);
  screenFor(props);
  await screen.findByRole("region", { name: /^Annotations/ });
  for (const n of withText) await laidOut(n);
  act(() => scroller().focus());
  return f;
}

beforeEach(() => {
  listening.clear();
  requests = [];
  placeOf.clear();
  server.events.on("request:start", record);
  openPdf.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, measureText: () => ({ width: 10 }), font: "" } as unknown as CanvasRenderingContext2D;
  } as never);
  layOutRanges();
});
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  delete (Range.prototype as Partial<Range>).getClientRects;
  server.events.removeAllListeners();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 10));
});

describe("ReaderScreen: selecting text by keyboard (Task R11)", () => {
  it("S starts a selection at the first word; Shift+arrows extend it by word and by line, into the next page; it is the browser's selection; Escape ends it", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "s");
    expect(selected()).toBe("Words");
    await waitFor(() => expect(live()).toBe(selectedSentence("Words")));
    shift(scroller(), "ArrowRight");
    expect(selected()).toBe("Words of");
    shift(scroller(), "ArrowDown");
    // The same place (the second word) on the next line.
    expect(selected()).toBe("Words of page 1Second line");
    shift(scroller(), "ArrowDown");
    // Into the next page's first line.
    expect(selected()).toBe("Words of page 1Second line 1Words of");
    shift(scroller(), "ArrowLeft");
    expect(selected()).toBe("Words of page 1Second line 1Words");
    // Plain arrows do what they did (they scroll): the selection stays.
    press(scroller(), "ArrowDown");
    expect(selected()).toBe("Words of page 1Second line 1Words");
    // Escape: ended, said, the focus left on the page area.
    press(scroller(), "Escape");
    expect(selected()).toBe("");
    await waitFor(() => expect(live()).toBe(SELECTION_CANCELLED));
    expect(document.activeElement).toBe(scroller());
    // Enter with nothing selected does nothing.
    press(scroller(), "Enter");
    await flush();
    expect(colourBar()).toBeNull();
    expect(creates()).toHaveLength(0);
  });

  it("starts at the first word visible, not the page's first", async () => {
    serveAnnotations(() => []);
    await opened();
    // The view begins below page 1's first line: its middle is above the view's top.
    const sc = scroller();
    Object.defineProperty(sc, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(sc, "clientWidth", { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const text = this.textContent ?? "";
      const top = this === sc ? 0 : this.tagName === "SPAN" && text.startsWith("Words of page 1") ? -30 : this.tagName === "SPAN" ? 50 : 0;
      return { left: 0, top, width: 300, height: 14, right: 300, bottom: top + 14, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    press(sc, "s");
    expect(selected()).toBe("Second");
  });

  it("Select text, the button: the same selection, the focus put on the page area; ended by a click elsewhere on the page", async () => {
    serveAnnotations(() => []);
    await opened();
    const button = screen.getByRole("button", { name: "Select text" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("S");
    act(() => button.focus());
    fireEvent.click(button);
    expect(selected()).toBe("Words");
    expect(document.activeElement).toBe(scroller());
    // While selecting, the button says why it cannot act.
    expect(screen.getByRole("button", { name: "Select text" }).getAttribute("aria-disabled")).toBe("true");
    // A click elsewhere on the page changes the browser's selection: the keyboard's ends.
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await waitFor(() => expect(live()).toBe(SELECTION_CANCELLED));
    expect(screen.getByRole("button", { name: "Select text" }).getAttribute("aria-disabled")).toBeNull();
    // Shift+arrows now do nothing of the app's.
    shift(scroller(), "ArrowRight");
    expect(selected()).toBe("");
  });

  it("Select text is disabled on a page with no text, with its reason", async () => {
    serveAnnotations(() => []);
    await opened(fakeHandle(3, (n) => (n === 1 ? [] : linesOf(n))), {}, [2]);
    const button = await waitFor(() => {
      const b = screen.getByRole("button", { name: "Select text" });
      expect(b.getAttribute("aria-disabled")).toBe("true");
      return b;
    });
    const why = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(why.textContent).toBe(`Select text: ${NO_TEXT_TO_SELECT}`);
    press(scroller(), "s");
    await waitFor(() => expect(live()).toBe(NO_TEXT_TO_SELECT));
    expect(selected()).toBe("");
    // A note can still be added to it.
    expect(screen.getByRole("button", { name: "Add a note to this page" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("the toolbar opened with Enter is not closed by its own opening, and is closed by a further Shift+arrow", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "s");
    shift(scroller(), "ArrowRight");
    press(scroller(), "Enter");
    const bar = await waitFor(() => colourBar()!);
    // The toolbar takes the focus, on "Highlight".
    await waitFor(() => expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Highlight" })));
    // Its own opening and moving inside it change nothing.
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Highlight in Yellow" }));
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    expect(colourBar()).toBeTruthy();
    // (jsdom, unlike a browser, moves the document's selection to an element given the focus: what the
    // browser shows is not asserted here; the keyboard's own selection is still held, as the next step shows.)
    expect(screen.getByRole("button", { name: "Select text" }).getAttribute("aria-disabled")).toBe("true");
    // Back on the page area, a further Shift+arrow changes the selection: the toolbar closes, the selection goes on.
    act(() => scroller().focus());
    shift(scroller(), "ArrowRight");
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    await waitFor(() => expect(colourBar()).toBeNull());
    expect(selected()).toBe("Words of page");
    // Enter again: the toolbar for the longer selection.
    press(scroller(), "Enter");
    await waitFor(() => expect(colourBar()).toBeTruthy());
    expect(creates()).toHaveLength(0);
  });

  it("a keyboard highlight goes through the same create as a mouse highlight (one request, same body shape)", async () => {
    const stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    serveCreate((body) => {
      const r = answerOf(body, `new-${stored.length + 1}`);
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    await opened();
    press(scroller(), "s");
    for (let i = 0; i < 3; i++) shift(scroller(), "ArrowRight");
    expect(selected()).toBe("Words of page 1");
    press(scroller(), "Enter");
    const bar = await waitFor(() => colourBar()!);
    fireEvent.click(within(bar).getByRole("button", { name: "Highlight in Green" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Highlight in Green" }));
    await waitFor(() => expect(live()).toBe("Highlight added: Green, page 1."));
    expect(creates()).toHaveLength(1);
    // The selection ended with the highlight (nothing more said of it), the browser's too; the focus back on the page area.
    expect(selected()).toBe("");
    expect(document.activeElement).toBe(scroller());
    expect(screen.getByRole("button", { name: "Select text" }).getAttribute("aria-disabled")).toBeNull();
    const list = screen.getByRole("region", { name: "Annotations (1)" });
    expect(within(list).getByText("Words of page 1")).toBeTruthy();
    // The same words with the mouse: the same body.
    const line = textNode(1, "Words of page 1");
    fireEvent.mouseDown(line.parentElement!);
    const r = document.createRange();
    r.setStart(line, 0);
    r.setEnd(line, line.data.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    fireEvent.mouseUp(line.parentElement!);
    fireEvent.click(within(await waitFor(() => colourBar()!)).getByRole("button", { name: "Highlight in Green" }));
    await waitFor(() => expect(creates()).toHaveLength(2));
    const [byKeys, byMouse] = creates();
    expect(byKeys).toEqual(byMouse);
    expect(byKeys!.quote).toBe("Words of page 1");
    expect(byKeys!.anchors[0]!.sortIndex).toBe("00000|000000|00134");
  });

  it("a selection into a page that is not drawn stops at the drawn pages and says so once, truly (R240 c); Enter highlights the part selected", async () => {
    serveAnnotations(() => []);
    serveCreate((body) => HttpResponse.json(answerOf(body, "part"), { status: 201 }) as unknown as Response);
    await opened();
    // Pages 1 and 2 are drawn (the current page and its neighbour); page 3 is not.
    expect(pageBox(3).hasAttribute("data-rendered")).toBe(false);
    const heard = hear();
    press(scroller(), "s");
    for (let i = 0; i < 6; i++) shift(scroller(), "ArrowDown");
    expect(selected()).toBe("Words of page 1Second line 1Words of page 2Second line 2");
    await waitFor(() => expect(live()).toBe(KEYBOARD_EDGE));
    expect(KEYBOARD_EDGE).toBe("The selection stops at the pages on screen. Highlight this part, then carry on from the next page.");
    // Said once, not as an alarm, and never R10's "cannot be highlighted".
    shift(scroller(), "ArrowDown");
    await flush();
    expect(heard().filter((t) => t === KEYBOARD_EDGE)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain(PAGES_NOT_SHOWN);
    // The part selected is highlighted.
    press(scroller(), "Enter");
    fireEvent.click(within(await waitFor(() => colourBar()!)).getByRole("button", { name: "Highlight in Blue" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.anchors.map((a) => a.page)).toEqual([1, 2]);
    await waitFor(() => expect(live()).toBe("Highlight added: Blue, pages 1–2."));
  });

  it("the edge is not said when the pages beyond are drawn pages without text, at the document's end", async () => {
    serveAnnotations(() => []);
    // Two pages: page 2 has no text. Past page 1's last word there is nothing more to select.
    await opened(fakeHandle(2, (n) => (n === 2 ? [] : linesOf(n))), {}, [1]);
    await waitFor(() => expect(pageBox(2).querySelector(".ao-reader-no-text")).toBeTruthy());
    const heard = hear();
    press(scroller(), "s");
    for (let i = 0; i < 4; i++) shift(scroller(), "ArrowDown");
    await flush();
    expect(heard()).not.toContain(KEYBOARD_EDGE);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(selected()).toBe("Words of page 1Second line 1");
  });

  it("never past the document's start: Shift+Left and Shift+Up on its first word say nothing", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "s");
    shift(scroller(), "ArrowLeft");
    shift(scroller(), "ArrowUp");
    expect(selected()).toBe("Words");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ten presses in a burst say the last selection once", async () => {
    serveAnnotations(() => []);
    await opened();
    const heard: string[] = [];
    const region = document.querySelector(".ao-ann-live")!;
    const watch = new MutationObserver(() => {
      const t = region.textContent ?? "";
      if (t !== "" && heard[heard.length - 1] !== t) heard.push(t);
    });
    watch.observe(region, { childList: true, characterData: true, subtree: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    press(scroller(), "s");
    for (let i = 0; i < 10; i++) {
      act(() => vi.advanceTimersByTime(30));
      shift(scroller(), i < 8 ? "ArrowRight" : "ArrowLeft");
    }
    // Eight words on (into page 2), two back: the last state is not the longest one.
    expect(selected()).toBe("Words of page 1Second line 1");
    // Within the burst: only the first state was said.
    await act(async () => {});
    expect(heard).toEqual([selectedSentence("Words")]);
    act(() => vi.advanceTimersByTime(500));
    await act(async () => {});
    watch.disconnect();
    vi.useRealTimers();
    const lastSaid = selectedSentence("Words of page 1\nSecond line 1");
    expect(heard).toEqual([selectedSentence("Words"), lastSaid]);
    expect(lastSaid).toBe(`Selected: ${FSI}Words of page 1 Second line 1${PDI}`);
  });

  it("the selected text is said as text, cut at 200 characters, a right-to-left run keeping its own direction", () => {
    const long = "word ".repeat(60);
    const s = selectedSentence(long);
    expect(Array.from(s.slice("Selected: \u2068".length, s.indexOf("\u2069")))).toHaveLength(200);
    expect(s.endsWith("\u2069…")).toBe(true);
    expect(selectedSentence("<b>שלום</b> עולם")).toBe("Selected: \u2068<b>שלום</b> עולם\u2069");
  });

  it("S and N do nothing inside the note field, the page-number field, the colour toolbar and a dialog; nor with Ctrl, Cmd or Alt held, nor while composing", async () => {
    serveAnnotations(() => []);
    await opened();
    const field = screen.getByRole("spinbutton", { name: "Page" });
    press(field, "s");
    press(field, "n");
    expect(selected()).toBe("");
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      press(scroller(), "s", mod);
      press(scroller(), "n", mod);
    }
    expect(selected()).toBe("");
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    // The colour toolbar: its keys are its own.
    press(scroller(), "s");
    press(scroller(), "Enter");
    const bar = await waitFor(() => colourBar()!);
    press(within(bar).getByRole("button", { name: "Highlight" }), "n");
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(live()).toBe(SELECTION_CANCELLED));
    // The note field: typing S and N there writes them.
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    expect(document.activeElement).toBe(note);
    press(note, "s");
    press(note, "n");
    expect(selected()).toBe("");
    expect(screen.getAllByRole("textbox", { name: "Note" })).toHaveLength(1);
    // A dialog: "Discard this note?" — keys there never reach the page area.
    fireEvent.change(note, { target: { value: "typed" } });
    press(note, "Escape");
    const dialog = await screen.findByRole("dialog", { name: "Discard this note?" });
    press(within(dialog).getByRole("button", { name: "Keep editing" }), "s");
    expect(selected()).toBe("");
  });
});

describe("ReaderScreen: a page note by keyboard (Task R11)", () => {
  it("a page note placed by keyboard is at the visible top left; Save note sends one create; it is drawn and listed at once; the focus goes back to the page area", async () => {
    const stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      const r = answerOf(body, "note-1");
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    await opened();
    // The pages scrolled: page 1's box begins 300 px above the view's top, 20 px right of its left.
    const sc = scroller();
    const page1 = pageBox(1);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const [left, top] = this === sc ? [0, 100] : this === page1 ? [20, -200] : [0, 0];
      return { left, top, width: 800, height: 500, right: left + 800, bottom: top + 500, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const button = screen.getByRole("button", { name: "Add a note to this page" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("N");
    press(sc, "n");
    const group = await screen.findByRole("region", { name: "Note on page 1" });
    expect(group.textContent).toContain("On page 1, at the top left of what is shown.");
    const note = within(group).getByRole("textbox", { name: "Note" });
    expect(document.activeElement).toBe(note);
    // The place is drawn on the page as a draft note mark.
    await waitFor(() => expect(document.querySelector('[data-page-number="1"] .ao-hl--draft')).toBeTruthy());
    fireEvent.change(note, { target: { value: "  A thought, kept as typed  " } });
    // Ctrl+Enter saves; a second press while it is on its way sends nothing more.
    press(note, "Enter", { ctrlKey: true });
    fireEvent.click(within(group).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    await waitFor(() => expect(live()).toBe("Adding the note…"));
    const [body] = creates();
    expect(Object.keys(body!).sort()).toEqual(["anchors", "assetId", "body", "colorName", "kind"]);
    expect(body!.kind).toBe("note");
    expect(body!.body).toBe("  A thought, kept as typed  ");
    // The visible part's top left, 8 px in: (0 - 20 -> 0) + 8 across, (100 - -200) + 8 = 308 px down, in points.
    const r = body!.anchors[0]!.rects[0]!;
    expect(r.x).toBeCloseTo(8 / SCALE, 2);
    expect(r.y + r.h).toBeCloseTo(842 - 308 / SCALE, 2);
    expect(r.w).toBeCloseTo(22, 2);
    expect(r.h).toBeCloseTo(22, 2);
    expect(body!.anchors[0]!.page).toBe(1);
    // Below both lines of the page (their tops at 710 and 690 points): after all of its text.
    expect(body!.anchors[0]!.sortIndex).toBe(`00000|${String("Words of page 1".length + "Second line 1".length).padStart(6, "0")}|${String(Math.trunc(308 / SCALE)).padStart(5, "0")}`);
    act(() => release());
    await waitFor(() => expect(live()).toBe("Note added, page 1."));
    expect(screen.queryByRole("region", { name: "Note on page 1" })).toBeNull();
    const list = screen.getByRole("region", { name: "Annotations (1)" });
    expect(within(list).getByText("A thought, kept as typed", { exact: false })).toBeTruthy();
    expect(list.textContent).toContain("Note");
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[data-page-number="1"] .ao-hl')].map((e) => e.dataset.annotation)).toEqual(["note-1"]));
    expect(document.querySelector(".ao-hl--draft")).toBeNull();
    expect(document.activeElement).toBe(sc);
    expect(creates()).toHaveLength(1);
  });

  it("Place by clicking: Escape leaves; a click outside a page places nothing; a click on a page places it there", async () => {
    serveAnnotations(() => []);
    serveCreate((body) => HttpResponse.json(answerOf(body, "n1"), { status: 201 }) as unknown as Response);
    await opened();
    fireEvent.click(screen.getByRole("button", { name: "Add a note to this page" }));
    const group = await screen.findByRole("region", { name: "Note on page 1" });
    const place = within(group).getByRole("button", { name: "Place by clicking" });
    fireEvent.click(place);
    expect(place.getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("status").textContent).toBe("Click on a page to place the note. Press Escape to stop.");
    expect(document.querySelector(".ao-reader-area--placing")).toBeTruthy();
    // Escape stops waiting; the note stays where it was.
    press(document.body, "Escape");
    expect(place.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".ao-reader-area--placing")).toBeNull();
    expect(screen.getByRole("region", { name: "Note on page 1" })).toBeTruthy();
    // A click outside every page: nothing placed.
    fireEvent.click(place);
    fireEvent.mouseDown(screen.getByRole("toolbar", { name: "Reader" }));
    expect(place.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(live()).toBe("Nothing was placed: the click was not on a page."));
    expect(group.textContent).toContain("at the top left of what is shown");
    // A click on page 2: placed there, at the click.
    fireEvent.click(place);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this === pageBox(2) ? 1000 : 0;
      return { left: 0, top, width: 800, height: 500, right: 800, bottom: top + 500, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    fireEvent.mouseDown(pageBox(2), { clientX: 100, clientY: 1040, button: 0 });
    const moved = await screen.findByRole("region", { name: "Note on page 2" });
    expect(moved.textContent).toContain("On page 2, where you clicked.");
    await waitFor(() => expect(document.activeElement).toBe(within(moved).getByRole("textbox", { name: "Note" })));
    fireEvent.change(within(moved).getByRole("textbox", { name: "Note" }), { target: { value: "Here" } });
    fireEvent.click(within(moved).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    const a = creates()[0]!.anchors[0]!;
    expect(a.page).toBe(2);
    expect(a.rects[0]!.x).toBeCloseTo(100 / SCALE, 2);
    expect(a.rects[0]!.y + a.rects[0]!.h).toBeCloseTo(842 - 40 / SCALE, 2);
  });

  it("Discard this note? on Escape with a changed note; Keep editing keeps it; an unchanged note closes without a question", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "n");
    let note = await screen.findByRole("textbox", { name: "Note" });
    // Unchanged: closes at once, the focus back on the page area.
    press(note, "Escape");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(scroller());
    press(scroller(), "n");
    note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "half a thought" } });
    press(note, "Escape");
    let dialog = await screen.findByRole("dialog", { name: "Discard this note?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep editing" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("half a thought");
    // "Cancel" asks too; Discard closes it and nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    dialog = await screen.findByRole("dialog", { name: "Discard this note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(scroller()));
    expect(creates()).toHaveLength(0);
  });

  it("the service's sentence is shown for a note it refuses, the text kept as typed", async () => {
    serveAnnotations(() => []);
    serveCreate(() => serviceError(400, "VALIDATION", "A note cannot be only spaces.") as unknown as Response);
    await opened();
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "A note cannot be only spaces.");
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("   ");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.body).toBe("   ");
  });

  it("a 423 on saving the note ends the reader as locked", async () => {
    serveAnnotations(() => []);
    serveCreate(() => serviceError(423, "PROJECT_LOCKED", "This project is locked.") as unknown as Response);
    const f = await opened();
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "locked out" } });
    press(note, "Enter", { metaKey: true });
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(f.handle.destroy).toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a page note made while the list is filtered to a search's words is shown in it at once (R223 f)", async () => {
    const stored: AnnotationRecord[] = [
      { id: "match", sourceId: "s1", kind: "highlight", pdfAnchors: [{ id: "m-a", assetId: "a1", page: 2, rects: [glyphs(linesOf(2)[0]!, 0, 5)], sortIndex: "00001|000000|00134", sortIndexDerived: false }], otherAnchorKinds: [], quote: "Words", body: "about the riverbank", colorName: "yellow", imported: false, author: "me", createdAt: "2026-11-13T10:00:00Z" },
    ];
    serveAnnotations(() => stored);
    serveCreate((body) => {
      const r = answerOf(body, "page-note");
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    await opened(fakeHandle(3), { findWords: "riverbank" });
    await screen.findByRole("region", { name: "Annotations matching your search (1)" });
    act(() => scroller().focus());
    press(scroller(), "n");
    fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), { target: { value: "beside the bridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    const list = await screen.findByRole("region", { name: "Annotations matching your search (2)" });
    await waitFor(() => expect(list.querySelector('[data-entry="page-note"]')).toBeTruthy());
  });
});

describe("ReaderScreen: the keyboard's making ends with the reader (A7, A9, A10, A13)", () => {
  it("nothing of a selection is left when the reader ends (locked)", async () => {
    serveAnnotations(() => []);
    const f = await opened();
    press(scroller(), "s");
    shift(scroller(), "ArrowRight");
    expect(selected()).toBe("Words of");
    act(() => f.fail(new PdfOpenError("locked")));
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(selected()).toBe("");
    expect(screen.queryByRole("button", { name: "Select text" })).toBeNull();
  });

  it("nothing of a selection is left when the document fails in mid-read and is opened again", async () => {
    serveAnnotations(() => []);
    const f = await opened();
    press(scroller(), "s");
    shift(scroller(), "ArrowRight");
    expect(selected()).toBe("Words of");
    act(() => f.fail(new PdfOpenError("other", "The file changed while it was read.")));
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    fireEvent.click(await screen.findByRole("button", { name: "Open again" }));
    await screen.findByRole("region", { name: "Annotations (0)" });
    await laidOut(1);
    act(() => scroller().focus());
    // No selection is held: "Select text" can act, Shift+arrows and Enter do nothing of the app's, Escape says nothing.
    expect(screen.getByRole("button", { name: "Select text" }).getAttribute("aria-disabled")).toBeNull();
    shift(scroller(), "ArrowRight");
    press(scroller(), "Enter");
    press(scroller(), "Escape");
    await flush();
    expect(selected()).toBe("");
    expect(colourBar()).toBeNull();
    expect(live()).toBe("");
  });

  it("nothing of a selection is left when the screen is left: the browser's selection goes too", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "s");
    shift(scroller(), "ArrowRight");
    expect(selected()).toBe("Words of");
    cleanup();
    expect(window.getSelection()!.rangeCount).toBe(0);
  });

  it("nothing of a note, the wait for a click or a request on its way is left when the reader ends; the late answer is dropped", async () => {
    let stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      const r = answerOf(body, "late");
      stored = [...stored, r];
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    const f = await opened();
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "on its way" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    // The file failed in mid-read: the reader ends. Nothing asked, nothing kept.
    act(() => f.fail(new PdfOpenError("other", "The file changed while it was read.")));
    await screen.findByRole("button", { name: "Open again" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    // Opened again, then the old answer arrives: the new document holds no field, no draft, and the note
    // is not listed from the old answer (the list is asked for again, since it was stored).
    stored = [];
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    fireEvent.click(screen.getByRole("button", { name: "Open again" }));
    await screen.findByRole("region", { name: "Annotations (0)" });
    const before = requests.filter((r) => r.method === "GET" && r.path.endsWith("/annotations")).length;
    act(() => release());
    await waitFor(() => expect(requests.filter((r) => r.method === "GET" && r.path.endsWith("/annotations")).length).toBe(before + 1));
    await flush();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(document.querySelector(".ao-hl--draft")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(live()).not.toContain("Note added");
  });

  it("the wait for a click and the note field go when the screen is left", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "n");
    fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Place by clicking" }));
    cleanup();
    // Nothing is held: the app's own navigation goes where it is sent, unasked.
    expect(document.querySelector(".ao-reader-note")).toBeNull();
    navigate("/elsewhere");
    expect(window.location.pathname).toBe("/elsewhere");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    navigate("/");
  });
});

describe("ReaderScreen: read-only and help (Task R11)", () => {
  it("read-only: both disabled, referring to the reader's one read-only sentence, shown once; S and N say it once (R240 f)", async () => {
    serveAnnotations(() => [{ id: "h", sourceId: "s1", kind: "highlight", pdfAnchors: [{ id: "h-a", assetId: "a1", page: 1, rects: [glyphs(linesOf(1)[0]!, 0, 5)], sortIndex: "00000|000000|00134", sortIndexDerived: false }], otherAnchorKinds: [], quote: "Words", colorName: "yellow", imported: false, author: "me", createdAt: "2026-11-13T10:00:00Z" }]);
    await opened(fakeHandle(3), { readOnly: true });
    const select = screen.getByRole("button", { name: "Select text" });
    const add = screen.getByRole("button", { name: "Add a note to this page" });
    expect(select).toHaveProperty("disabled", true);
    expect(add).toHaveProperty("disabled", true);
    expect(READ_ONLY_MAKING).toBe("This library is read-only, so highlights and notes cannot be added or changed.");
    const shown = screen.getAllByText(READ_ONLY_MAKING, { selector: ":not(.ao-ann-live, .ao-ann-live *)" });
    expect(shown).toHaveLength(1);
    expect(select.getAttribute("aria-describedby")).toBe(shown[0]!.id);
    expect(add.getAttribute("aria-describedby")).toBe(shown[0]!.id);
    // The list's disabled controls refer to the same sentence; the list shows none of its own.
    for (const b of screen.getAllByRole("button", { name: /^(Edit note|Add note|Colour|Delete)/ })) expect(b.getAttribute("aria-describedby")).toBe(shown[0]!.id);
    const heard = hear();
    press(scroller(), "s");
    await waitFor(() => expect(live()).toBe(READ_ONLY_MAKING));
    press(scroller(), "n");
    press(scroller(), "s");
    press(scroller(), "n");
    await flush();
    expect(heard().filter((t) => t === READ_ONLY_MAKING)).toHaveLength(1);
    expect(selected()).toBe("");
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(creates()).toHaveLength(0);
  });

  it("Keyboard help lists every key and the stated limit, exactly", async () => {
    serveAnnotations(() => []);
    await opened();
    const button = screen.getByRole("button", { name: "Keyboard help" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const help = screen.getByRole("region", { name: "Keyboard help" });
    for (const key of ["S", "N", "Shift+Right Arrow, Shift+Left Arrow", "Shift+Down Arrow, Shift+Up Arrow", "Enter", "Escape", "Page Down, Page Up", "Home, End", "Ctrl+Enter (Cmd+Enter on a Mac)"]) expect(within(help).getByText(key)).toBeTruthy();
    expect(within(help).getByText(KEYBOARD_ORDER_LIMIT)).toBeTruthy();
    expect(KEYBOARD_ORDER_LIMIT).toBe("Text is selected in the order the PDF stores it, which for some two-column or unusual layouts is not the reading order.");
    // R240 (M10): what the letters are on other layouts, and that the buttons do the same.
    expect(within(help).getByText(KEYBOARD_HELP_KEYS)).toBeTruthy();
  });
});

/** A highlight on page 1 of the stand-in file, with no note yet (its list entry offers "Add note"). */
const stored1 = (): AnnotationRecord => ({ id: "h1", sourceId: "s1", kind: "highlight", pdfAnchors: [{ id: "h1-a", assetId: "a1", page: 1, rects: [glyphs(linesOf(1)[0]!, 0, 5)], sortIndex: "00000|000000|00134", sortIndexDerived: false }], otherAnchorKinds: [], quote: "Words", colorName: "yellow", imported: false, author: "me", createdAt: "2026-11-13T10:00:00Z" });
const FAKE = { toFake: ["setTimeout", "clearTimeout", "Date"] } as Parameters<typeof vi.useFakeTimers>[0];

describe("ReaderScreen: by keyboard, fix round 1 (Ruling R240)", () => {
  it("I1: the wait for a click goes when the reader ends and is opened again — no placing state, no listener of the earlier document, Escape works", async () => {
    serveAnnotations(() => []);
    const count = countListeners();
    const f = await opened();
    const base = count();
    press(scroller(), "n");
    await screen.findByRole("textbox", { name: "Note" });
    fireEvent.click(screen.getByRole("button", { name: "Place by clicking" }));
    expect(document.querySelector(".ao-reader-area--placing")).toBeTruthy();
    act(() => f.fail(new PdfOpenError("other", "The file changed while it was read.")));
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    fireEvent.click(await screen.findByRole("button", { name: "Open again" }));
    await screen.findByRole("region", { name: "Annotations (0)" });
    await laidOut(1);
    await laidOut(2);
    act(() => scroller().focus());
    expect(document.querySelector(".ao-reader-area--placing")).toBeNull();
    expect(count()).toEqual(base);
    // Escape reaches the new document's selection.
    press(scroller(), "s");
    expect(selected()).toBe("Words");
    press(scroller(), "Escape");
    expect(selected()).toBe("");
    await waitFor(() => expect(live()).toBe(SELECTION_CANCELLED));
  });

  it("I1: a 'Selected: …' waiting to be said goes when the reader ends: its timer is cleared, nothing is said later", async () => {
    serveAnnotations(() => []);
    const f = await opened();
    press(scroller(), "s");
    // The press within 500 ms of the first saying: what it selects waits to be said, on a timer.
    const set = vi.spyOn(globalThis, "setTimeout");
    shift(scroller(), "ArrowRight");
    const i = set.mock.calls.findIndex((c) => typeof c[1] === "number" && c[1] > 100 && c[1] <= 500);
    expect(i).toBeGreaterThanOrEqual(0);
    const waiting = set.mock.results[i]!.value as ReturnType<typeof setTimeout>;
    set.mockRestore();
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    act(() => f.fail(new PdfOpenError("locked")));
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(cleared.mock.calls.some((c) => c[0] === waiting)).toBe(true);
  });

  it("M6: Escape ends the selection and what was waiting to be said goes with it: nothing is said after 'Selection cancelled.'", async () => {
    serveAnnotations(() => []);
    await opened();
    const heard = hear();
    vi.useFakeTimers(FAKE);
    press(scroller(), "s");
    await settle();
    shift(scroller(), "ArrowRight");
    press(scroller(), "Escape");
    await settle();
    act(() => vi.advanceTimersByTime(600));
    await settle();
    vi.useRealTimers();
    expect(heard()).toEqual([selectedSentence("Words"), SELECTION_CANCELLED]);
  });

  it("M4: Enter says the selection's last state before the toolbar opens", async () => {
    serveAnnotations(() => []);
    await opened();
    const heard = hear();
    vi.useFakeTimers(FAKE);
    press(scroller(), "s");
    await settle();
    shift(scroller(), "ArrowRight");
    shift(scroller(), "ArrowRight");
    press(scroller(), "Enter");
    await settle();
    vi.useRealTimers();
    expect(heard()).toEqual([selectedSentence("Words"), selectedSentence("Words of page")]);
    await waitFor(() => expect(colourBar()).toBeTruthy());
  });

  it("M3: a held S or N acts once; Shift+arrows repeat as they should", async () => {
    serveAnnotations(() => []);
    await opened();
    const heard = hear();
    press(scroller(), "s", { code: "KeyS" });
    await settle();
    for (let i = 0; i < 4; i++) press(scroller(), "s", { code: "KeyS", repeat: true });
    fireEvent.keyUp(scroller(), { key: "s", code: "KeyS" });
    await flush();
    expect(heard()).toEqual([selectedSentence("Words")]);
    for (let i = 0; i < 2; i++) press(scroller(), "ArrowRight", { shiftKey: true, repeat: true });
    expect(selected()).toBe("Words of page");
    press(scroller(), "Escape");
    // N held: the field opens once and the repeats type nothing into it.
    press(scroller(), "n", { code: "KeyN" });
    const note = await screen.findByRole("textbox", { name: "Note" });
    expect(document.activeElement).toBe(note);
    expect(fireEvent.keyDown(note, { key: "n", code: "KeyN", repeat: true })).toBe(false);
    fireEvent.keyUp(note, { key: "n", code: "KeyN" });
    // Let go, a new N in the field is typed as usual.
    expect(fireEvent.keyDown(note, { key: "n", code: "KeyN" })).toBe(true);
    expect(screen.getAllByRole("textbox", { name: "Note" })).toHaveLength(1);
  });

  it("M10: S and N by the character typed, whatever the case, or by the key's place when the layout has no Latin letter for it", async () => {
    serveAnnotations(() => []);
    await opened();
    // A Dvorak layout: the key in S's place types "o": not S.
    press(scroller(), "o", { code: "KeyS" });
    expect(selected()).toBe("");
    // Cyrillic: the key in S's place types "ы": S.
    press(scroller(), "ы", { code: "KeyS" });
    expect(selected()).toBe("Words");
    press(scroller(), "Escape");
    press(scroller(), "Т", { code: "KeyN", shiftKey: true });
    expect(await screen.findByRole("textbox", { name: "Note" })).toBeTruthy();
  });

  it("M8: one note at a time — a note in the list being written: N, S and a selection's toolbar say so once and give it the focus", async () => {
    serveAnnotations(() => [stored1()]);
    await opened();
    const list = screen.getByRole("region", { name: "Annotations (1)" });
    fireEvent.click(within(list).getByRole("button", { name: /^Add note to/ }));
    const listNote = await within(list).findByRole("textbox", { name: "Note" });
    act(() => scroller().focus());
    const heard = hear();
    press(scroller(), "n");
    await waitFor(() => expect(live()).toBe(NOTE_FIRST));
    await settle();
    expect(NOTE_FIRST).toBe("Finish or cancel the note you are writing first.");
    expect(document.activeElement).toBe(listNote);
    expect(screen.getAllByRole("textbox", { name: "Note" })).toHaveLength(1);
    act(() => scroller().focus());
    press(scroller(), "s");
    await settle();
    expect(selected()).toBe("");
    expect(document.activeElement).toBe(listNote);
    // A mouse selection on the page: no toolbar either.
    const line = textNode(1, "Words of page 1");
    fireEvent.mouseDown(line.parentElement!);
    const r = document.createRange();
    r.setStart(line, 0);
    r.setEnd(line, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    fireEvent.mouseUp(line.parentElement!);
    await flush();
    expect(colourBar()).toBeNull();
    expect(heard().filter((t) => t === NOTE_FIRST)).toHaveLength(3);
  });

  it("M8: one note at a time — a page note being written: the list's Add note says so and gives it the focus; leaving asks one question", async () => {
    serveAnnotations(() => [stored1()]);
    await opened();
    press(scroller(), "n");
    const pageNote = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(pageNote, { target: { value: "half" } });
    const list = screen.getByRole("region", { name: "Annotations (1)" });
    fireEvent.click(within(list).getByRole("button", { name: /^Add note to/ }));
    await waitFor(() => expect(live()).toBe(NOTE_FIRST));
    expect(document.activeElement).toBe(pageNote);
    expect(screen.getAllByRole("textbox", { name: "Note" })).toHaveLength(1);
    // The app's own way out: one question.
    navigate("/elsewhere");
    await screen.findByRole("dialog", { name: "Discard this note?" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("M9: Add a note to this page closes the colour toolbar first; the wait for a click is said when it starts and ends", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "s");
    press(scroller(), "Enter");
    await waitFor(() => expect(colourBar()).toBeTruthy());
    act(() => scroller().focus());
    press(scroller(), "n");
    await screen.findByRole("textbox", { name: "Note" });
    expect(colourBar()).toBeNull();
    const heard = hear();
    const place = screen.getByRole("button", { name: "Place by clicking" });
    fireEvent.click(place);
    await waitFor(() => expect(live()).toBe(PLACING));
    fireEvent.click(place);
    await waitFor(() => expect(live()).toBe(PLACING_STOPPED));
    expect(heard()).toEqual([PLACING, PLACING_STOPPED]);
  });

  it("M5: Escape in 'Discard this note?' is the dialog's: the wait for a click ends when the question opens; focus stays in the dialog under Tab and Shift+Tab (R145)", async () => {
    serveAnnotations(() => []);
    await opened();
    const user = userEvent.setup();
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Place by clicking" }));
    expect(document.querySelector(".ao-reader-area--placing")).toBeTruthy();
    act(() => navigate("/elsewhere"));
    const dialog = await screen.findByRole("dialog", { name: "Discard this note?" });
    expect(document.querySelector(".ao-reader-area--placing")).toBeNull();
    const keep = within(dialog).getByRole("button", { name: "Keep editing" });
    expect(document.activeElement).toBe(keep);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => keep.focus());
    // A click on the dialog places nothing and says nothing of placing.
    fireEvent.mouseDown(keep);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("unsaved");
    expect(live()).not.toBe(NOT_ON_A_PAGE);
  });

  it("M1: a note's sort index is worked out where it is placed, even when the page's text is no longer kept by the time it is saved", async () => {
    serveAnnotations(() => []);
    serveCreate((body) => HttpResponse.json(answerOf(body, "n1"), { status: 201 }) as unknown as Response);
    await opened(fakeHandle(12));
    // Placed below both lines of page 1 (as in the visible-top-left test): after all of its text.
    const sc = scroller();
    const page1 = pageBox(1);
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const [left, top] = this === sc ? [0, 100] : this === page1 ? [20, -200] : [0, 0];
      return { left, top, width: 800, height: 500, right: left + 800, bottom: top + 500, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    });
    press(sc, "n");
    await screen.findByRole("textbox", { name: "Note" });
    spy.mockRestore();
    // The pages read on: page 1's text is let go (at most six pages' texts are kept).
    act(() => sc.focus());
    press(sc, "End");
    for (const n of [12, 11]) await laidOut(n);
    for (const n of [10, 9, 8, 7]) {
      press(sc, "PageUp");
      await laidOut(n);
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "kept in its place" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0]!.anchors[0]!.sortIndex).toBe(`00000|${String("Words of page 1".length + "Second line 1".length).padStart(6, "0")}|${String(Math.trunc(308 / SCALE)).padStart(5, "0")}`);
  });

  it("M6: S and N on a control of the page area outside the pages (the note's 'Place by clicking') do nothing", async () => {
    serveAnnotations(() => []);
    await opened();
    press(scroller(), "n");
    await screen.findByRole("textbox", { name: "Note" });
    const place = screen.getByRole("button", { name: "Place by clicking" });
    act(() => place.focus());
    const heard = hear();
    press(place, "s");
    press(place, "n");
    await flush();
    expect(document.activeElement).toBe(place);
    expect(heard()).toEqual([]);
    expect(selected()).toBe("");
  });

  it("M6: a second save in the same moment sends nothing more (the one-request guard, not only the button's pending state)", async () => {
    serveAnnotations(() => []);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      return HttpResponse.json(answerOf(body, "n1"), { status: 201 }) as unknown as Response;
    });
    await opened();
    press(scroller(), "n");
    const note = await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "once" } });
    act(() => {
      press(note, "Enter", { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Save note" }));
      press(note, "Enter", { metaKey: true });
    });
    await flush();
    await waitFor(() => expect(creates()).toHaveLength(1));
    act(() => release());
    await waitFor(() => expect(live()).toBe("Note added, page 1."));
    expect(creates()).toHaveLength(1);
  });
});
