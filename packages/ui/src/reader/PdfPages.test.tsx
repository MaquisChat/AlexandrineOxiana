/**
 * The reader's pages (Task R7): drawn lazily, at most 6 at a time, each a region "Page n of N";
 * placeholders sized from page 1 until a page's own size is known; canvases at devicePixelRatio; a
 * page without text says so; a page that leaves is cleaned up (its canvas emptied, its text layer
 * cleared, pdf.js's page.cleanup()); and on the handle's failure (A7) everything drawn is cleared,
 * every render cancelled and nothing that arrives afterwards is kept.
 *
 * The handle is a stand-in with pdf.js's shapes (pdfjs.test.ts covers real pdf.js); jsdom draws
 * nothing, so a canvas context is a stand-in too.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfOpenError, type PdfHandle } from "./pdfjs";
import { PdfPages } from "./PdfPages";

const NO_TEXT = "This page has no text to select. It is probably a scanned image; you can still add a note to it.";

interface FakeOpts {
  pages: number;
  /** The text of page n (1-based); none by default (a scan). */
  text?: (n: number) => string[];
  /** Page n's size in points; A4 by default. */
  size?: (n: number) => [number, number];
  /** Holds every render until released. */
  holdRenders?: boolean;
}

function fakeHandle(o: FakeOpts) {
  const got: number[] = [];
  const cleaned: number[] = [];
  const renders: Array<{ page: number; canvas: HTMLCanvasElement; viewport: { width: number; height: number; scale: number; rotation: number }; transform?: number[]; cancelled: boolean; release(): void }> = [];
  let fail: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((r) => {
    fail = r;
  });
  let dead = false;
  const viewportFor = (n: number, scale: number, rotation: number) => {
    const [w, h] = o.size?.(n) ?? [595, 842];
    const turned = rotation % 180 !== 0;
    return {
      width: (turned ? h : w) * scale,
      height: (turned ? w : h) * scale,
      scale,
      rotation,
      rawDims: { pageWidth: w, pageHeight: h, pageX: 0, pageY: 0 },
      convertToViewportRectangle: (r: number[]) => r.map((v) => v * scale),
    };
  };
  const page = (n: number) => ({
    pageNumber: n,
    rotate: 0,
    getViewport: ({ scale, rotation }: { scale: number; rotation?: number }) => viewportFor(n, scale, rotation ?? 0),
    render: (p: { canvas: HTMLCanvasElement; viewport: ReturnType<typeof viewportFor>; transform?: number[] }) => {
      let release = () => {};
      let reject: (e: Error) => void = () => {};
      const promise = new Promise<void>((res, rej) => {
        release = res;
        reject = rej;
      });
      const entry = { page: n, canvas: p.canvas, viewport: p.viewport, ...(p.transform ? { transform: p.transform } : {}), cancelled: false, release: () => release() };
      renders.push(entry);
      if (!o.holdRenders) queueMicrotask(release);
      return {
        promise,
        cancel: () => {
          entry.cancelled = true;
          reject(Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" }));
        },
      };
    },
    getTextContent: async () => ({ items: (o.text?.(n) ?? []).map((str) => ({ str, dir: "ltr", transform: [10, 0, 0, 10, 50, 700], width: 100, height: 10, fontName: "f1", hasEOL: false })), styles: { f1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } }, lang: null }),
    cleanup: () => {
      cleaned.push(n);
      return true;
    },
  });
  const handle = {
    doc: {
      numPages: o.pages,
      getPage: async (n: number) => {
        if (dead) throw new PdfOpenError("other", "This document was closed.");
        got.push(n);
        return page(n);
      },
    },
    pageCount: o.pages,
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
    got,
    cleaned,
    renders,
    fail: (e: PdfOpenError) => {
      dead = true;
      fail(e);
    },
  };
}

const canvases = (c: HTMLElement) => c.querySelectorAll("canvas");
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

/** jsdom has no 2D context; pdf.js's text layer measures text with one. */
function stubCanvasContext() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, measureText: (t: string) => ({ width: t.length * 5, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }), font: "" } as unknown as CanvasRenderingContext2D;
  } as never);
}

beforeEach(() => {
  stubCanvasContext();
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PdfPages (Task R7)", () => {
  it("PdfPages keeps at most 6 pages rendered", async () => {
    const f = fakeHandle({ pages: 900 });
    const onPageChange = vi.fn();
    const props = { handle: f.handle, scale: 1, rotation: 0 as const, onPageChange, renderOverlay: () => null };
    const { container, rerender } = render(<PdfPages {...props} currentPage={1} />);
    await flush();
    // Every page has its region, the rendered ones and the placeholders alike.
    expect(screen.getAllByRole("region", { name: /^Page \d+ of 900$/ })).toHaveLength(900);
    expect(screen.getByRole("region", { name: "Page 3 of 900" })).toBeTruthy();
    const first = canvases(container).length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(6);

    // Jumping through the document, and at each step never more than 6 canvases.
    for (const n of [2, 3, 50, 450, 451, 899, 900, 1, 900]) {
      rerender(<PdfPages {...props} currentPage={n} />);
      await flush();
      expect(canvases(container).length, `at page ${n}`).toBeLessThanOrEqual(6);
      const shown = [...container.querySelectorAll<HTMLElement>("[data-rendered]")].map((e) => Number(e.dataset.pageNumber));
      expect(shown.length).toBeLessThanOrEqual(6);
      expect(shown, `page ${n} is among the drawn ones`).toContain(n);
    }
    // Only pages near 900 hold a canvas now; page 1 and page 450 were cleaned up when they left.
    const holding = [...canvases(container)].map((c) => Number(c.closest<HTMLElement>("[data-page-number]")!.dataset.pageNumber));
    expect(holding.every((p) => p >= 894)).toBe(true);
    expect(f.cleaned).toContain(1);
    expect(f.cleaned).toContain(450);
    // Every canvas that left was emptied (its memory given back), not just detached.
    const left = f.renders.filter((r) => !r.canvas.isConnected);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((r) => r.canvas.width === 0 && r.canvas.height === 0)).toBe(true);
    // Only the pages drawn were ever asked of pdf.js, not all 900.
    expect(new Set(f.got).size).toBeLessThan(60);
  });

  it("each scanned page says it has no text, and only the pages drawn say so", async () => {
    const f = fakeHandle({ pages: 900 });
    const { container } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={900} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const page900 = screen.getByRole("region", { name: "Page 900 of 900" });
    await waitFor(() => expect(page900.textContent).toContain(NO_TEXT));
    const notes = [...container.querySelectorAll("[data-page-number]")].filter((e) => e.textContent?.includes(NO_TEXT));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(6);
  });

  it("a page with text gets a text layer of text only, and no no-text sentence", async () => {
    const f = fakeHandle({ pages: 3, text: (n) => [`Words of page ${n}`, "<b>not markup</b>"] });
    const { container } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const page1 = screen.getByRole("region", { name: "Page 1 of 3" });
    await waitFor(() => expect(page1.querySelector(".ao-reader-text-layer")?.textContent).toContain("Words of page 1"));
    expect(page1.textContent).not.toContain(NO_TEXT);
    // The text is text: nothing in it became an element.
    expect(page1.querySelector(".ao-reader-text-layer b")).toBeNull();
    expect(page1.querySelector(".ao-reader-text-layer")!.textContent).toContain("<b>not markup</b>");
    expect(container.querySelectorAll("script, iframe, a").length).toBe(0);
  });

  it("placeholders take page 1's size until a page's own is known; canvases are drawn at devicePixelRatio", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const f = fakeHandle({ pages: 40, size: (n) => (n === 1 ? [600, 800] : n === 2 ? [400, 300] : [600, 800]) });
    render(<PdfPages handle={f.handle} scale={1.5} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const p30 = screen.getByRole("region", { name: "Page 30 of 40" });
    expect(p30.style.width).toBe("900px");
    expect(p30.style.height).toBe("1200px");
    const p2 = screen.getByRole("region", { name: "Page 2 of 40" });
    await waitFor(() => expect(p2.style.width).toBe("600px"));
    expect(p2.style.height).toBe("450px");
    const r1 = f.renders.find((r) => r.page === 1)!;
    expect([r1.canvas.width, r1.canvas.height]).toEqual([1800, 2400]);
    expect(r1.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(r1.canvas.style.width).toBe("900px");
  });

  it("rotation is a view setting: the page's box turns, the drawing is asked at the turned viewport", async () => {
    const f = fakeHandle({ pages: 2 });
    const { rerender } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    rerender(<PdfPages handle={f.handle} scale={1} rotation={90} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const p1 = screen.getByRole("region", { name: "Page 1 of 2" });
    expect([p1.style.width, p1.style.height]).toEqual(["842px", "595px"]);
    expect(f.renders.at(-1)!.viewport.rotation).toBe(90);
  });

  it("the overlay is given each drawn page's index and viewport", async () => {
    const f = fakeHandle({ pages: 3 });
    const overlay = vi.fn((i: number, vp: { scale: number }) => <span data-testid={`overlay-${i}`}>{vp.scale}</span>);
    render(<PdfPages handle={f.handle} scale={2} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={overlay as never} />);
    await flush();
    expect(screen.getByTestId("overlay-0").textContent).toBe("2");
    expect(screen.getByRole("region", { name: "Page 1 of 3" }).contains(screen.getByTestId("overlay-0"))).toBe(true);
  });

  it("a zoom while a page is being drawn cancels that drawing; the new one replaces it", async () => {
    const f = fakeHandle({ pages: 2, holdRenders: true });
    const { container, rerender } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const before = f.renders.filter((r) => r.page === 1);
    expect(before).toHaveLength(1);
    rerender(<PdfPages handle={f.handle} scale={2} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    expect(before[0]!.cancelled).toBe(true);
    const now = f.renders.filter((r) => r.page === 1);
    expect(now.at(-1)!.viewport.scale).toBe(2);
    // The old drawing, let go late, changes nothing: only the new canvas is on the page.
    before[0]!.release();
    await flush();
    const onPage1 = [...canvases(container)].filter((c) => c.closest("[data-page-number='1']"));
    expect(onPage1).toHaveLength(1);
    expect(onPage1[0]).toBe(now.at(-1)!.canvas);
  });

  it("on the handle's failure every drawing is cancelled, every canvas and text layer cleared, and nothing arriving later is kept (A7)", async () => {
    const f = fakeHandle({ pages: 10, holdRenders: true, text: () => ["Some words"] });
    const { container } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={(i) => <span data-testid={`overlay-${i}`} />} />);
    await flush();
    expect(canvases(container).length).toBeGreaterThan(0);
    const pending = [...f.renders];
    f.fail(new PdfOpenError("locked"));
    await flush();
    expect(pending.every((r) => r.cancelled)).toBe(true);
    expect(canvases(container).length).toBe(0);
    expect([...container.querySelectorAll(".ao-reader-text-layer")].every((t) => t.childNodes.length === 0)).toBe(true);
    expect(container.querySelectorAll("[data-testid^=overlay-]").length).toBe(0);
    // Drawings let go afterwards bring nothing back; nothing more is asked of the handle.
    const asked = f.got.length;
    for (const r of pending) r.release();
    await flush();
    expect(canvases(container).length).toBe(0);
    expect(f.got.length).toBe(asked);
  });

  it("leaving cancels every drawing and empties every canvas", async () => {
    const f = fakeHandle({ pages: 10, holdRenders: true });
    const { unmount } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={() => {}} renderOverlay={() => null} />);
    await flush();
    const pending = [...f.renders];
    expect(pending.length).toBeGreaterThan(0);
    unmount();
    expect(pending.every((r) => r.cancelled)).toBe(true);
    expect(pending.every((r) => r.canvas.width === 0 && r.canvas.height === 0)).toBe(true);
  });

  it("scrolling to another page reports it", async () => {
    const f = fakeHandle({ pages: 20 });
    const onPageChange = vi.fn();
    const { container } = render(<PdfPages handle={f.handle} scale={1} rotation={0} currentPage={1} onPageChange={onPageChange} renderOverlay={() => null} />);
    await flush();
    const scroller = container.querySelector<HTMLElement>(".ao-reader-scroll")!;
    // Page 5 starts after four pages of 842 px and their gaps.
    const top = screen.getByRole("region", { name: "Page 5 of 20" }).offsetTop || Number(screen.getByRole("region", { name: "Page 5 of 20" }).dataset.top);
    scroller.scrollTop = top + 10;
    scroller.dispatchEvent(new Event("scroll"));
    await flush();
    expect(onPageChange).toHaveBeenLastCalledWith(5);
  });
});
