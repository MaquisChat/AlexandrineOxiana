/**
 * Making highlights with the mouse on the reader screen (Task R10): a selection of text on a drawn
 * page offers the colour toolbar; a colour sends ONE create through the service's route (the real
 * client, the service mocked with MSW, every request recorded); a draft is drawn meanwhile and the
 * service's answer replaces it, in the list too, and is said in the list's live region; a refusal
 * removes the draft and says the service's sentence; a 423 ends the reader as locked; a late answer
 * (after the document ended) is dropped; read-only and the 50-page limit are said in words; where
 * highlights overlap, a click offers each.
 *
 * pdf.js's own TextLayer lays out the stand-in pages' text here as it does in a browser (one span an
 * item); jsdom has no layout, so a range's rectangles are worked out from each item's place through
 * the page's viewport (the end-to-end tests do it with real mouse selections in Chromium and WebKit).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readerApi, type AnnotationCreateRequest, type AnnotationRecord } from "../api/reader";
import { pdfRectToBox } from "../reader/geometry";
import { PdfOpenError, type PdfHandle } from "../reader/pdfjs";
import { server, serviceError, testClient, url, useMockService } from "../test/service";
import { ReaderScreen } from "./Reader";

const openPdf = vi.hoisted(() => vi.fn());
vi.mock("../reader/pdfjs", async (importOriginal) => ({ ...(await importOriginal<typeof import("../reader/pdfjs")>()), openPdf }));

useMockService();

const DOC = "/projects/:id/sources/:sid/assets/:aid/document";
const LIST = "/projects/:id/sources/:sid/annotations";
const ONE = "/projects/:id/sources/:sid/annotations/:anid";
const LOCKED = "This project is locked. Unlock it in the library to read its files.";
const CHANGED = "The text here has changed since this highlight was made.";

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

/** The create route: each request answered by `answer` (which may hold it). */
function serveCreate(answer: (body: AnnotationCreateRequest) => Response | Promise<Response>) {
  server.use(http.post(url(LIST), async ({ request }) => answer((await request.clone().json()) as AnnotationCreateRequest)));
}

/** A viewport of an A4 page (view box 0 0 595 842) as pdf.js 6.4.299 makes it, both ways. */
function a4Viewport(scale: number, rotation: number) {
  const [A, B, C, D] = rotation === 90 ? [0, 1, 1, 0] : rotation === 180 ? [-1, 0, 0, 1] : rotation === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const turned = A === 0;
  const [cx, cy] = [297.5, 421];
  const ox = (turned ? cy : cx) * scale;
  const oy = (turned ? cx : cy) * scale;
  const t = [A! * scale, B! * scale, C! * scale, D! * scale, ox - A! * scale * cx - C! * scale * cy, oy - B! * scale * cx - D! * scale * cy] as const;
  const det = t[0] * t[3] - t[1] * t[2];
  return {
    width: (turned ? 842 : 595) * scale,
    height: (turned ? 595 : 842) * scale,
    scale,
    rotation,
    viewBox: [0, 0, 595, 842],
    rawDims: { pageWidth: 595, pageHeight: 842, pageX: 0, pageY: 0 },
    transform: [...t],
    convertToViewportPoint: (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
    convertToPdfPoint: (x: number, y: number) => [(t[3] * (x - t[4]) - t[2] * (y - t[5])) / det, (-t[1] * (x - t[4]) + t[0] * (y - t[5])) / det],
  };
}

const ASCENT = 0.718;
const DESCENT = -0.207;
/** "Words of page n" in 10-point Helvetica at x 50, baseline 700 (73.37 points long) on every page. */
const LINE = { x: 50, y: 700, size: 10, width: 73.37 };
const wordsOf = (n: number) => `Words of page ${n}`;
const textItem = (str: string) => ({ str, dir: "ltr", transform: [LINE.size, 0, 0, LINE.size, LINE.x, LINE.y], width: LINE.width, height: LINE.size, fontName: "f1", hasEOL: false });
/** The glyph box of characters `from` to `to` of a page's line, in PDF space. */
const glyphs = (str: string, from: number, to: number) => ({ x: LINE.x + (LINE.width * from) / str.length, y: LINE.y + DESCENT * LINE.size, w: (LINE.width * (to - from)) / str.length, h: (ASCENT - DESCENT) * LINE.size });

interface Fake {
  handle: PdfHandle;
  fail(e: PdfOpenError): void;
}

function fakeHandle(pages = 3, text: (n: number) => string | undefined = wordsOf): Fake {
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => (fail = r));
  let dead = false;
  const page = (n: number) => ({
    pageNumber: n,
    rotate: 0,
    getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => a4Viewport(scale, rotation ?? 0),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    getTextContent: async () => {
      const s = text(n);
      return { items: s ? [textItem(s)] : [], styles: { f1: { fontFamily: "sans-serif", ascent: ASCENT, descent: DESCENT, vertical: false } }, lang: null };
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

/** The scale the screen draws "100%" at. */
const SCALE = 96 / 72;

/** Where the pieces of text of a range lie: worked out from the page's line through the viewport (jsdom lays nothing out). */
function layOutRanges() {
  // jsdom has no Range.getClientRects at all: given here, taken away after each test.
  Range.prototype.getClientRects = function (this: Range) {
    const n = this.startContainer;
    if (n !== this.endContainer || n.nodeType !== 3 || this.collapsed) return [] as unknown as DOMRectList;
    const pageEl = (n.parentElement as Element).closest<HTMLElement>("[data-page-number]")!;
    const at = pageEl.getBoundingClientRect();
    const b = pdfRectToBox(glyphs((n as Text).data, this.startOffset, this.endOffset), a4Viewport(SCALE, 0) as never);
    return [{ left: at.left + b.left, top: at.top + b.top, width: b.width, height: b.height }] as unknown as DOMRectList;
  };
}

/** The text node of page `n`'s line, once pdf.js's text layer has laid it out. */
async function lineOf(n: number): Promise<Text> {
  return waitFor(() => {
    const span = document.querySelector(`[data-page-number="${n}"] .ao-reader-text-layer span`);
    expect(span?.firstChild?.nodeType).toBe(3);
    return span!.firstChild as Text;
  });
}

/** Selects from (node, offset) to (node, offset) as a mouse would, and lets go of the button there. */
function select(from: [Node, number], to: [Node, number]) {
  const r = document.createRange();
  r.setStart(from[0], from[1]);
  r.setEnd(to[0], to[1]);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
  const target = to[0].nodeType === 3 ? to[0].parentElement! : (to[0] as Element);
  fireEvent.mouseUp(target);
}

let made = 0;
function rec(o: Partial<AnnotationRecord> & { page?: number; pages?: number[] } = {}): AnnotationRecord {
  const id = o.id ?? `an-${++made}`;
  const { page = 1, pages = [page], ...rest } = o;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: pages.map((p, i) => ({ id: `${id}-a${i}`, assetId: "a1", page: p, rects: [glyphs(wordsOf(p), 0, wordsOf(p).length)], sortIndex: `0000${p - 1}|000000|00134`, sortIndexDerived: false })),
    otherAnchorKinds: [],
    quote: wordsOf(page),
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
    ...rest,
  };
}

/** The record the service answers a create with. */
function answerOf(body: AnnotationCreateRequest, id: string): AnnotationRecord {
  return {
    id,
    sourceId: "s1",
    kind: body.kind,
    pdfAnchors: body.anchors.map((a, i) => ({ id: `${id}-a${i}`, assetId: body.assetId, page: a.page, rects: a.rects, sortIndex: a.sortIndex ?? "", sortIndexDerived: false })),
    otherAnchorKinds: [],
    ...(body.quote !== undefined ? { quote: body.quote } : {}),
    colorName: body.colorName,
    imported: false,
    author: "me",
    createdAt: "2026-11-13T11:00:00Z",
  };
}

function screenFor(props: Partial<Parameters<typeof ReaderScreen>[0]> = {}) {
  return render(<ReaderScreen api={readerApi(testClient())} projectId="p1" sourceId="s1" assetId="a1" readOnly={false} {...props} />);
}

const toolbar = () => screen.queryByRole("toolbar", { name: "Highlight the selected text" });
const drawnOn = (n: number) => [...document.querySelectorAll<HTMLElement>(`[data-page-number="${n}"] .ao-hl`)].map((e) => e.dataset.annotation);
const live = () => document.querySelector(".ao-ann-live")!.textContent;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  requests = [];
  made = 0;
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
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 10));
});

describe("ReaderScreen: making highlights with the mouse (Task R10)", () => {
  it("a selection offers the toolbar; a colour sends one create with the selection's place, quote and sort index; the service's answer replaces the draft at once", async () => {
    serveDocument();
    const stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      const r = answerOf(body, "new-1");
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    const page1 = document.querySelector<HTMLElement>('[data-page-number="1"]')!;
    page1.focus();
    select([line, 0], [line, line.data.length]);
    const bar = await waitFor(() => toolbar()!);
    // Reachable by Tab from the selection.
    await user.tab();
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Highlight" }));
    await user.click(within(bar).getByRole("button", { name: "Highlight in Green" }));
    expect(toolbar()).toBeNull();
    // The draft is drawn at once, marked as one, while the service is asked.
    await waitFor(() => expect(document.querySelector('[data-page-number="1"] .ao-hl--draft')).toBeTruthy());
    await waitFor(() => expect(creates()).toHaveLength(1));
    const [body] = creates();
    expect(Object.keys(body!).sort()).toEqual(["anchors", "assetId", "colorName", "kind", "quote"]);
    expect(body!.kind).toBe("highlight");
    expect(body!.assetId).toBe("a1");
    expect(body!.colorName).toBe("green");
    expect(body!.quote).toBe("Words of page 1");
    expect(body!.anchors).toHaveLength(1);
    const a = body!.anchors[0]!;
    expect(a.page).toBe(1);
    expect(a.sortIndex).toBe("00000|000000|00134");
    expect(a.rects).toHaveLength(1);
    const want = glyphs(wordsOf(1), 0, wordsOf(1).length);
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(a.rects[0]![k] - want[k])).toBeLessThan(0.001);
    // The answer replaces the draft, on the page and in the list (in its sorted place), and is said.
    act(() => release());
    await waitFor(() => expect(drawnOn(1)).toEqual(["new-1"]));
    expect(document.querySelector(".ao-hl--draft")).toBeNull();
    const list = screen.getByRole("region", { name: "Annotations (1)" });
    expect(within(list).getByText("Words of page 1")).toBeTruthy();
    await waitFor(() => expect(live()).toBe("Highlight added: Green, page 1."));
    // Never "changed" when made: R8's own check accepts the quote and the rectangles.
    await flush();
    expect(list.textContent).not.toContain(CHANGED);
    expect(document.querySelector(".ao-hl--changed")).toBeNull();
    // One request for the one press; the focus is back on the page.
    expect(creates()).toHaveLength(1);
    expect(document.activeElement).toBe(page1);
    // The next toolbar's "Highlight" is in the last colour used.
    select([line, 0], [line, 5]);
    const again = await waitFor(() => toolbar()!);
    expect(within(again).getByText("in Green")).toBeTruthy();
  });

  it("each drawn page's text layer carries pdf.js's blank-space guard, hidden and empty, gone with the document (R223, I1)", async () => {
    serveDocument();
    serveAnnotations(() => []);
    const f = fakeHandle(3);
    openPdf.mockResolvedValueOnce(f.handle);
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    await lineOf(1);
    const end = await waitFor(() => {
      const e = document.querySelector('[data-page-number="1"] .ao-reader-text-layer > .ao-reader-end-of-content');
      expect(e).toBeTruthy();
      return e!;
    });
    expect(end.getAttribute("aria-hidden")).toBe("true");
    expect(end.textContent).toBe("");
    // A press on the layer: "selecting" until it is let go.
    const layer = end.parentElement!;
    fireEvent.mouseDown(layer);
    expect(layer.classList.contains("selecting")).toBe(true);
    fireEvent.pointerUp(document);
    expect(layer.classList.contains("selecting")).toBe(false);
    act(() => f.fail(new PdfOpenError("locked")));
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(document.querySelectorAll(".ao-reader-end-of-content")).toHaveLength(0);
  });

  it("Escape and a press elsewhere close the toolbar and nothing is sent", async () => {
    serveDocument();
    serveAnnotations(() => []);
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    const page1 = document.querySelector<HTMLElement>('[data-page-number="1"]')!;
    page1.focus();
    select([line, 0], [line, 5]);
    await waitFor(() => expect(toolbar()).toBeTruthy());
    await user.keyboard("{Escape}");
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(page1);
    select([line, 0], [line, 5]);
    await waitFor(() => expect(toolbar()).toBeTruthy());
    await user.tab();
    await user.keyboard("{Escape}");
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(page1);
    select([line, 0], [line, 5]);
    await waitFor(() => expect(toolbar()).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("toolbar", { name: "Reader" }));
    expect(toolbar()).toBeNull();
    await flush();
    expect(creates()).toHaveLength(0);
  });

  it("a refusal removes the draft and says the service's own sentence in an alert", async () => {
    serveDocument();
    serveAnnotations(() => []);
    const sentence = "This source already has 10,000 annotations, the most one source can hold. Delete some to add more.";
    serveCreate(() => serviceError(409, "CONFLICT", sentence) as unknown as Response);
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    select([line, 0], [line, line.data.length]);
    await user.click(await waitFor(() => within(toolbar()!).getByRole("button", { name: "Highlight" })));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(sentence));
    expect(document.querySelector(".ao-hl")).toBeNull();
    expect(screen.getByRole("region", { name: "Annotations (0)" })).toBeTruthy();
    // The reader goes on: the pages are still there.
    expect(screen.getByRole("region", { name: "Page 1 of 3" })).toBeTruthy();
  });

  it("a 423 answered to a create ends the reader as locked at once", async () => {
    serveDocument();
    serveAnnotations(() => []);
    serveCreate(() => serviceError(423, "PROJECT_LOCKED", "This project is locked.") as unknown as Response);
    const f = fakeHandle(3);
    openPdf.mockResolvedValueOnce(f.handle);
    const user = userEvent.setup();
    const { container } = screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    select([line, 0], [line, line.data.length]);
    await user.click(await waitFor(() => within(toolbar()!).getByRole("button", { name: "Highlight in Red" })));
    await screen.findByRole("heading", { level: 2, name: "Project locked" });
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(f.handle.destroy).toHaveBeenCalled();
    expect(container.querySelectorAll(".ao-hl, .ao-hl-toolbar, .ao-reader-page").length).toBe(0);
  });

  it("a create answered after the document failed and was opened again is dropped: only the new document's highlights are shown", async () => {
    serveDocument();
    let stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      return HttpResponse.json(answerOf(body, "late-1"), { status: 201 }) as unknown as Response;
    });
    const first = fakeHandle(3);
    const second = fakeHandle(3);
    openPdf.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    select([line, 0], [line, line.data.length]);
    await user.click(await waitFor(() => within(toolbar()!).getByRole("button", { name: "Highlight in Blue" })));
    await waitFor(() => expect(creates()).toHaveLength(1));
    // The file fails in mid-read; it is opened again; then the old create's answer arrives.
    act(() => first.fail(new PdfOpenError("other", "The file changed while it was read.")));
    stored = [rec({ id: "kept", page: 2 })];
    await user.click(await screen.findByRole("button", { name: "Open again" }));
    await screen.findByRole("region", { name: "Annotations (1)" });
    act(() => release());
    await flush();
    await flush();
    expect(screen.getByRole("region", { name: "Annotations (1)" })).toBeTruthy();
    expect(document.querySelector('[data-annotation="late-1"]')).toBeNull();
    expect(document.querySelector(".ao-hl--draft")).toBeNull();
    expect(live()).not.toContain("Highlight added");
  });

  it("read-only: no toolbar; the reason is said once", async () => {
    serveDocument();
    serveAnnotations(() => []);
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    screenFor({ readOnly: true });
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    select([line, 0], [line, 5]);
    const why = "This library is read-only, so highlights cannot be made.";
    await waitFor(() => expect(screen.getByText(why)).toBeTruthy());
    expect(toolbar()).toBeNull();
    select([line, 0], [line, 8]);
    await flush();
    expect(screen.getAllByText(why)).toHaveLength(1);
    expect(toolbar()).toBeNull();
    expect(creates()).toHaveLength(0);
  });

  it("a selection over more than 50 pages is refused in words and nothing is made", async () => {
    serveDocument();
    serveAnnotations(() => []);
    openPdf.mockResolvedValueOnce(fakeHandle(60).handle);
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const line = await lineOf(1);
    const far = document.querySelector('[data-page-number="55"]')!;
    select([line, 3], [far, 0]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("A highlight can cover at most 50 pages."));
    expect(toolbar()).toBeNull();
    await flush();
    expect(creates()).toHaveLength(0);
  });

  it("a selection across a page break makes one highlight with an anchor a page; the list says Pages 1–2", async () => {
    serveDocument();
    const stored: AnnotationRecord[] = [];
    serveAnnotations(() => stored);
    serveCreate((body) => {
      const r = answerOf(body, "both");
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    await screen.findByRole("region", { name: "Annotations (0)" });
    const one = await lineOf(1);
    const two = await lineOf(2);
    select([one, 6], [two, 5]);
    await user.click(await waitFor(() => within(toolbar()!).getByRole("button", { name: "Highlight in Yellow" })));
    await waitFor(() => expect(creates()).toHaveLength(1));
    const body = creates()[0]!;
    expect(body.anchors.map((a) => a.page)).toEqual([1, 2]);
    expect(body.anchors.map((a) => a.sortIndex!.slice(0, 13))).toEqual(["00000|000006|", "00001|000000|"]);
    expect(body.quote).toBe("of page 1 Words");
    expect(body.colorName).toBe("yellow");
    const list = await screen.findByRole("region", { name: "Annotations (1)" });
    await waitFor(() => expect(within(list).getByText("Pages 1–2")).toBeTruthy());
    await waitFor(() => expect(live()).toBe("Highlight added: Yellow, pages 1–2."));
    await waitFor(() => expect(drawnOn(1)).toEqual(["both"]));
    expect(drawnOn(2)).toEqual(["both"]);
  });

  it("a selection in the annotation list, or on a page without text, offers nothing", async () => {
    serveDocument();
    serveAnnotations(() => [rec({ id: "noted", body: "A note of mine about the river" })]);
    openPdf.mockResolvedValueOnce(fakeHandle(3, (n) => (n === 1 ? wordsOf(1) : undefined)).handle);
    screenFor();
    const list = await screen.findByRole("region", { name: "Annotations (1)" });
    const note = within(list).getByText("A note of mine about the river").firstChild!;
    select([note, 2], [note, 10]);
    await flush();
    expect(toolbar()).toBeNull();
    const page2 = await screen.findByRole("region", { name: "Page 2 of 3" });
    await waitFor(() => expect(page2.textContent).toContain("This page has no text to select."));
    select([page2, 0], [page2, page2.childNodes.length]);
    await flush();
    expect(toolbar()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a create on its way while 'Discard this note?' is asked does not disturb the question", async () => {
    serveDocument();
    const stored = [rec({ id: "noted", page: 2, body: "first note" })];
    serveAnnotations(() => stored);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    serveCreate(async (body) => {
      await held;
      const r = answerOf(body, "new-2");
      stored.push(r);
      return HttpResponse.json(r, { status: 201 }) as unknown as Response;
    });
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    const list = await screen.findByRole("region", { name: "Annotations (1)" });
    const line = await lineOf(1);
    select([line, 0], [line, line.data.length]);
    await user.click(await waitFor(() => within(toolbar()!).getByRole("button", { name: "Highlight" })));
    await waitFor(() => expect(creates()).toHaveLength(1));
    // The note is changed and Escape asks.
    await user.click(within(list).getByRole("button", { name: /^Edit note of/ }));
    const area = within(list).getByRole("textbox", { name: "Note" });
    await user.type(area, " and more");
    await user.keyboard("{Escape}");
    const dialog = await screen.findByRole("dialog", { name: "Discard this note?" });
    const keep = within(dialog).getByRole("button", { name: "Keep editing" });
    expect(document.activeElement).toBe(keep);
    act(() => release());
    await screen.findByRole("region", { name: "Annotations (2)" });
    await flush();
    expect(screen.getByRole("dialog", { name: "Discard this note?" })).toBe(dialog);
    expect(document.activeElement).toBe(keep);
    await user.click(keep);
    expect((within(screen.getByRole("region", { name: "Annotations (2)" })).getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("first note and more");
  });

  it("where two highlights overlap, a click offers both; choosing one selects it on the page and in the list; Escape gives the focus back", async () => {
    serveDocument();
    serveAnnotations(() => [rec({ id: "under", quote: "Words of page 1" }), rec({ id: "over", colorName: "blue", quote: "of page 1" })]);
    openPdf.mockResolvedValueOnce(fakeHandle(3).handle);
    const user = userEvent.setup();
    screenFor();
    const list = await screen.findByRole("region", { name: "Annotations (2)" });
    const page = await screen.findByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(drawnOn(1)).toEqual(["under", "over"]));
    page.focus();
    const mark = document.querySelector<HTMLElement>('[data-annotation="over"]')!;
    fireEvent.click(page, { clientX: parseFloat(mark.style.left) + 5, clientY: parseFloat(mark.style.top) + 5 });
    const menu = await screen.findByRole("menu", { name: "2 highlights here" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Blue: of page 1", "Yellow: Words of page 1"]);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(page);
    fireEvent.click(page, { clientX: parseFloat(mark.style.left) + 5, clientY: parseFloat(mark.style.top) + 5 });
    await screen.findByRole("menu", { name: "2 highlights here" });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-annotation="under"]')!.classList.contains("ao-hl--selected")).toBe(true));
    expect(list.querySelector('[data-entry="under"]')!.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(page);
  });
});
