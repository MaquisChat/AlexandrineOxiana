/**
 * pdf.js's own guard for a selection let go in blank space (Ruling R223, I1), as its
 * TextLayerBuilder does it in pdfjs-dist 6.4.299: an empty `endOfContent` element per text layer, a
 * "selecting" state from the press to its release, and on `selectionchange` the element moved beside
 * the selection's focus — so that the browser, given blank space, keeps the selection where it is
 * instead of jumping to other lines. The jumps themselves are proved end to end in Chromium and
 * WebKit (e2e/reader-highlights.spec.ts); here, the mechanism.
 */
import { afterEach, describe, expect, it } from "vitest";
import { END_OF_CONTENT_CLASS, guardTextLayer } from "./textLayerSelection";

let undo: Array<() => void> = [];
afterEach(() => {
  for (const u of undo) u();
  undo = [];
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

/** A text layer as pdf.js lays it out: a span an item, a line break after an item that ends a line. */
function layer(lines: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "ao-reader-text-layer";
  for (const l of lines) {
    const s = document.createElement("span");
    s.textContent = l;
    el.append(s, document.createElement("br"));
  }
  document.body.append(el);
  return el;
}
const ends = () => [...document.querySelectorAll(`.${END_OF_CONTENT_CLASS}`)];

describe("guardTextLayer", () => {
  it("adds one empty element at the layer's end, hidden from assistive technology, with no text for a quote", () => {
    const el = layer(["first line", "second line"]);
    undo.push(guardTextLayer(el));
    expect(ends()).toHaveLength(1);
    const end = ends()[0]!;
    expect(el.lastElementChild).toBe(end);
    expect(end.getAttribute("aria-hidden")).toBe("true");
    expect(end.textContent).toBe("");
    expect(end.childNodes).toHaveLength(0);
    expect(el.textContent).toBe("first linesecond line");
  });

  it("a press on the layer marks it selecting until the button is let go; then the element goes back to the end", () => {
    const el = layer(["first line", "second line"]);
    undo.push(guardTextLayer(el));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(el.classList.contains("selecting")).toBe(true);
    // The selection's focus in the first line: the element is moved beside it, and may be selected into.
    const first = el.querySelector("span")!;
    const r = document.createRange();
    r.setStart(first.firstChild!, 0);
    r.setEnd(first.firstChild!, 5);
    window.getSelection()!.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    const end = ends()[0] as HTMLElement;
    expect(first.nextSibling).toBe(end);
    expect(end.style.userSelect).toBe("text");
    document.dispatchEvent(new Event("pointerup"));
    expect(el.classList.contains("selecting")).toBe(false);
    expect(el.lastElementChild).toBe(end);
    expect(end.style.userSelect).toBe("");
  });

  it("a selection elsewhere resets the layer; the guard taken away leaves nothing behind", () => {
    const el = layer(["first line"]);
    const other = document.createElement("p");
    other.textContent = "the list";
    document.body.append(other);
    const release = guardTextLayer(el);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const r = document.createRange();
    r.selectNodeContents(other);
    window.getSelection()!.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    expect(el.classList.contains("selecting")).toBe(false);
    release();
    expect(ends()).toHaveLength(0);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(el.classList.contains("selecting")).toBe(false);
  });
});
