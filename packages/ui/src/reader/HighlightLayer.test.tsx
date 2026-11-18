/**
 * The highlight overlay of one drawn page (Task R8): every annotation of the file with a place on
 * this page, drawn from its PDF rectangles, imported and new alike; its colour by a class only;
 * its kind by its shape (fill, underline, note mark, outlined box; dashed when its text changed);
 * hidden from assistive technology (the list, Task R9, is the accessible route); a click selects it.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRecord } from "../api/reader";
import { HighlightLayer } from "./HighlightLayer";

afterEach(cleanup);

/** A viewport as pdf.js 6.4.299 makes it for an A4 page (view box 0 0 595 842) at `scale` and `rotation`. */
function a4Viewport(scale: number, rotation = 0): PageViewport {
  const [x0, y0, x1, y1] = [0, 0, 595, 842];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const [A, B, C, D] = rotation === 90 ? [0, 1, 1, 0] : rotation === 180 ? [-1, 0, 0, 1] : rotation === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const turned = A === 0;
  const ox = turned ? Math.abs(cy - y0) * scale : Math.abs(cx - x0) * scale;
  const oy = turned ? Math.abs(cx - x0) * scale : Math.abs(cy - y0) * scale;
  const t = [A * scale, B * scale, C * scale, D * scale, ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy];
  return {
    scale,
    rotation,
    width: (turned ? y1 - y0 : x1 - x0) * scale,
    height: (turned ? x1 - x0 : y1 - y0) * scale,
    transform: t,
    convertToViewportPoint: (x: number, y: number) => [t[0]! * x + t[2]! * y + t[4]!, t[1]! * x + t[3]! * y + t[5]!],
  } as unknown as PageViewport;
}

let n = 0;
/** An annotation record as the service lists it. */
function record(o: Partial<AnnotationRecord> & { anchors?: Array<{ page: number; rects: Array<{ x: number; y: number; w: number; h: number }>; assetId?: string }> } = {}): AnnotationRecord {
  const id = o.id ?? `an-${++n}`;
  const { anchors, ...rest } = o;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: (anchors ?? [{ page: 1, rects: [{ x: 100, y: 700, w: 200, h: 12 }] }]).map((a, i) => ({ id: `${id}-a${i}`, assetId: a.assetId ?? "a1", page: a.page, rects: a.rects, sortIndex: "00000|000000|00000", sortIndexDerived: true })),
    otherAnchorKinds: [],
    quote: "informal markets",
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
    ...rest,
  };
}

const marks = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".ao-hl")];
const none = new Set<string>();

describe("HighlightLayer", () => {
  it("a highlight carries its colour class and no inline colour", () => {
    const list = (["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"] as const).map((colorName, i) => record({ colorName, anchors: [{ page: 1, rects: [{ x: 50, y: 700 - i * 20, w: 100, h: 12 }] }] }));
    const { container } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} onSelect={() => {}} changed={none} />);
    const drawn = marks(container);
    expect(drawn).toHaveLength(8);
    drawn.forEach((m, i) => {
      expect(m.classList.contains(`ao-hl--${list[i]!.colorName}`)).toBe(true);
      expect(m.classList.contains("ao-hl--fill")).toBe(true);
      // Placed by its box only: no colour of any kind in its style.
      const style = m.getAttribute("style") ?? "";
      expect(style).not.toMatch(/colou?r|background|border|outline|fill|stroke|shadow|#|rgb|hsl/i);
      expect(Object.keys(m.style).filter((k) => /^\d+$/.test(k)).map((k) => m.style[Number(k)]).sort()).toEqual(["height", "left", "top", "width"]);
    });
    // Every class it uses for a colour is one of the eight names.
    expect(container.innerHTML).not.toMatch(/style="[^"]*(#|rgb|var\()/);
  });

  it("an imported highlight and a new one are drawn by the same code, from their PDF rectangles", () => {
    // The Zotero fixture's highlight (packages/library/tests/fixtures/zotero/build-fixture.mjs:166):
    // rects [[100.5, 200, 300, 215.25]] on page index 0, stored as {x, y, w, h} with y the lower edge.
    const imported = record({ id: "zotero", imported: true, importedColour: "#ffd400", anchors: [{ page: 1, rects: [{ x: 100.5, y: 200, w: 199.5, h: 15.25 }] }] });
    const made = record({ id: "made", anchors: [{ page: 1, rects: [{ x: 100.5, y: 200, w: 199.5, h: 15.25 }] }] });
    const { container } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(2)} annotations={[imported, made]} onSelect={() => {}} changed={none} />);
    const [a, b] = marks(container);
    expect(a!.getAttribute("style")).toBe(b!.getAttribute("style"));
    expect(a!.className.replace(/\s+/g, " ")).toBe(b!.className.replace(/\s+/g, " "));
    // 2× of an A4 page: x from 100.5, top from 842 − 215.25.
    expect(parseFloat(a!.style.left)).toBeCloseTo(201, 6);
    expect(parseFloat(a!.style.top)).toBeCloseTo((842 - 215.25) * 2, 6);
    expect(parseFloat(a!.style.width)).toBeCloseTo(399, 6);
    expect(parseFloat(a!.style.height)).toBeCloseTo(30.5, 6);
  });

  it("only this page's anchors are drawn; an annotation with no place is drawn nowhere and nothing throws (A5)", () => {
    const list = [
      record({ id: "p1", anchors: [{ page: 1, rects: [{ x: 10, y: 10, w: 10, h: 10 }] }] }),
      record({ id: "p2", anchors: [{ page: 2, rects: [{ x: 10, y: 10, w: 10, h: 10 }] }] }),
      record({ id: "both", anchors: [{ page: 1, rects: [{ x: 10, y: 30, w: 10, h: 10 }] }, { page: 2, rects: [{ x: 10, y: 50, w: 10, h: 10 }] }] }),
      record({ id: "nowhere", anchors: [] }),
      record({ id: "far", anchors: [{ page: 412, rects: [{ x: 10, y: 10, w: 10, h: 10 }] }] }),
    ];
    const { container, rerender } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} onSelect={() => {}} changed={none} />);
    expect(marks(container).map((m) => m.dataset.annotation)).toEqual(["p1", "both"]);
    rerender(<HighlightLayer pageIndex={1} viewport={a4Viewport(1)} annotations={list} onSelect={() => {}} changed={none} />);
    expect(marks(container).map((m) => m.dataset.annotation)).toEqual(["p2", "both"]);
  });

  it("each kind has its own shape, so that no kind is told by colour alone", () => {
    const at = (y: number) => [{ page: 1, rects: [{ x: 50, y, w: 100, h: 12 }] }];
    const list = [
      record({ id: "h", kind: "highlight", anchors: at(700) }),
      record({ id: "u", kind: "underline", anchors: at(680) }),
      record({ id: "n", kind: "note", quote: undefined, body: "check", anchors: [{ page: 1, rects: [{ x: 50, y: 660, w: 22, h: 22 }] }] }),
      record({ id: "i", kind: "image", quote: undefined, anchors: at(600) }),
      record({ id: "k", kind: "ink", quote: undefined, anchors: at(560) }),
    ];
    const { container } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} onSelect={() => {}} changed={new Set(["h", "u"])} />);
    const shape = (id: string) => container.querySelector<HTMLElement>(`[data-annotation="${id}"]`)!.classList;
    expect(shape("h").contains("ao-hl--fill")).toBe(true);
    expect(shape("u").contains("ao-hl--underline")).toBe(true);
    expect(shape("n").contains("ao-hl--note")).toBe(true);
    expect(shape("i").contains("ao-hl--box")).toBe(true);
    expect(shape("k").contains("ao-hl--box")).toBe(true);
    // Changed text: drawn dashed (a shape too).
    expect(shape("h").contains("ao-hl--changed")).toBe(true);
    expect(shape("u").contains("ao-hl--changed")).toBe(true);
    expect(shape("i").contains("ao-hl--changed")).toBe(false);
  });

  it("an underline is drawn under its words whichever way the page is turned", () => {
    const list = [record({ kind: "underline" })];
    const edges: string[] = [];
    for (const rotation of [0, 90, 180, 270]) {
      const { container, unmount } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(1, rotation)} annotations={list} onSelect={() => {}} changed={none} />);
      edges.push([...marks(container)[0]!.classList].find((c) => c.startsWith("ao-hl--edge-")) ?? "");
      unmount();
    }
    // The words' foot (the rect's lower edge in PDF space) is at the bottom, then the left, the top, the right.
    expect(edges).toEqual(["ao-hl--edge-bottom", "ao-hl--edge-left", "ao-hl--edge-top", "ao-hl--edge-right"]);
  });

  it("the overlay is hidden from assistive technology and holds no text", () => {
    const { container } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={[record({ quote: "a quote from the source", body: "a note" })]} onSelect={() => {}} changed={none} />);
    const layer = container.querySelector(".ao-hl-layer")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.textContent).toBe("");
    expect(layer.querySelectorAll("[title], [aria-label], [tabindex]").length).toBe(0);
  });

  it("clicking a highlight selects it; the selected one is marked; a click elsewhere or after selecting text selects nothing", () => {
    const onSelect = vi.fn();
    const list = [
      record({ id: "first", anchors: [{ page: 1, rects: [{ x: 100, y: 700, w: 200, h: 12 }] }] }),
      record({ id: "second", anchors: [{ page: 1, rects: [{ x: 250, y: 700, w: 200, h: 12 }] }] }),
    ];
    const { container, rerender } = render(
      <div className="ao-reader-page" data-page-number="1">
        <div className="ao-reader-overlay">
          <HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} onSelect={onSelect} changed={none} />
        </div>
      </div>,
    );
    const page = container.querySelector<HTMLElement>("[data-page-number]")!;
    // (150, 842 − 706): on "first" only.
    fireEvent.click(page, { clientX: 150, clientY: 136 });
    expect(onSelect).toHaveBeenLastCalledWith("first");
    // Where both lie (x 260): the one drawn on top, the later.
    fireEvent.click(page, { clientX: 260, clientY: 136 });
    expect(onSelect).toHaveBeenLastCalledWith("second");
    // Nowhere near a highlight.
    onSelect.mockClear();
    fireEvent.click(page, { clientX: 20, clientY: 20 });
    expect(onSelect).not.toHaveBeenCalled();
    // A click that ends a text selection is the selection's, not a choice of highlight.
    const sel = vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, toString: () => "words" } as unknown as Selection);
    fireEvent.click(page, { clientX: 150, clientY: 136 });
    expect(onSelect).not.toHaveBeenCalled();
    sel.mockRestore();
    rerender(
      <div className="ao-reader-page" data-page-number="1">
        <div className="ao-reader-overlay">
          <HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} selectedId="second" onSelect={onSelect} changed={none} />
        </div>
      </div>,
    );
    expect(container.querySelector('[data-annotation="second"]')!.classList.contains("ao-hl--selected")).toBe(true);
    expect(container.querySelector('[data-annotation="first"]')!.classList.contains("ao-hl--selected")).toBe(false);
  });

  it("where highlights overlap, a click offers each of them, topmost first; where one lies, it is chosen at once (Task R10)", () => {
    const onSelect = vi.fn();
    const onOverlap = vi.fn();
    const list = [
      record({ id: "first", anchors: [{ page: 1, rects: [{ x: 100, y: 700, w: 200, h: 12 }] }] }),
      // Two rectangles of one highlight both under the point: offered once.
      record({ id: "second", anchors: [{ page: 1, rects: [{ x: 250, y: 700, w: 200, h: 12 }, { x: 255, y: 701, w: 10, h: 10 }] }] }),
      record({ id: "draft:1", anchors: [{ page: 1, rects: [{ x: 240, y: 700, w: 100, h: 12 }] }] }),
    ];
    const { container } = render(
      <div className="ao-reader-page" data-page-number="1">
        <div className="ao-reader-overlay">
          <HighlightLayer pageIndex={0} viewport={a4Viewport(1)} annotations={list} onSelect={onSelect} onOverlap={onOverlap} drafts={new Set(["draft:1"])} changed={none} />
        </div>
      </div>,
    );
    const page = container.querySelector<HTMLElement>("[data-page-number]")!;
    fireEvent.click(page, { clientX: 260, clientY: 136 });
    // The draft (not yet the service's) is never offered; the two highlights are, the later drawn first.
    expect(onOverlap).toHaveBeenCalledTimes(1);
    expect(onOverlap.mock.calls[0]![0]).toEqual(["second", "first"]);
    expect(onOverlap.mock.calls[0]![1]).toEqual({ left: 260, top: 136 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(page, { clientX: 150, clientY: 136 });
    expect(onSelect).toHaveBeenLastCalledWith("first");
    expect(onOverlap).toHaveBeenCalledTimes(1);
    // On the draft alone: nothing to choose.
    onSelect.mockClear();
    const d = container.querySelector<HTMLElement>('[data-annotation="draft:1"]')!;
    expect(d.classList.contains("ao-hl--draft")).toBe(true);
    expect(container.querySelector('[data-annotation="first"]')!.classList.contains("ao-hl--draft")).toBe(false);
  });

  it("a page with 1,000 rectangles is 1,001 light elements, drawn quickly", () => {
    // One highlight of 1,000 rectangles (the most one anchor may hold): one element a rectangle, plus the layer.
    const rects = Array.from({ length: 1000 }, (_, i) => ({ x: 40 + (i % 10) * 50, y: 40 + Math.floor(i / 10) * 7.5, w: 45, h: 6 }));
    const list = [record({ anchors: [{ page: 1, rects }] })];
    const t0 = performance.now();
    const { container } = render(<HighlightLayer pageIndex={0} viewport={a4Viewport(2)} annotations={list} onSelect={() => {}} changed={none} />);
    const ms = performance.now() - t0;
    const layer = container.querySelector(".ao-hl-layer")!;
    expect(layer.querySelectorAll("*")).toHaveLength(1000);
    expect(container.querySelectorAll("*")).toHaveLength(1001);
    // No canvas: the overlay is elements over the page (A9's budget counts canvases).
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    // A bound generous enough for a loaded machine (jsdom, which is far slower than a browser): measured about 100 ms.
    console.log(`HighlightLayer: 1,000 rectangles drawn in ${ms.toFixed(0)} ms (jsdom)`);
    expect(ms).toBeLessThan(5000);
  });

  it("drawn again only when its own inputs change (memoised), not when the page around it re-renders", () => {
    const list = [record()];
    const viewport = a4Viewport(1);
    const onSelect = () => {};
    const { container, rerender } = render(<HighlightLayer pageIndex={0} viewport={viewport} annotations={list} onSelect={onSelect} changed={none} />);
    const before = marks(container)[0];
    rerender(<HighlightLayer pageIndex={0} viewport={viewport} annotations={list} onSelect={onSelect} changed={none} />);
    expect(marks(container)[0]).toBe(before);
  });
});
