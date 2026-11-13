/**
 * pdf.js's own guard for a selection let go in blank space (Ruling R223, I1), as pdfjs-dist
 * 6.4.299's `TextLayerBuilder` (web/pdf_viewer.mjs, `#bindMouse` and
 * `#enableGlobalSelectionListener`) does it for its viewer — the reader draws its text layer with
 * the bare `TextLayer`, which has none.
 *
 * Without it, a drag let go past a line's end, in a column's gutter, between two lines or below the
 * last line ends over the layer's blank space, and the browser places the selection's end at
 * whatever text it finds there: Chromium jumps forward over whole lines, WebKit to the text before
 * the press. With it:
 *  - each text layer ends with an empty element (`END_OF_CONTENT_CLASS`, hidden from assistive
 *    technology, with no text, so nothing of it reaches a quote);
 *  - a press on the layer marks it "selecting", which stretches that element over the whole layer,
 *    under the text: blank space is then that element, not other text;
 *  - while a selection is in a layer, the element is moved beside the selection's focus (and may be
 *    selected into), so blank space puts the end where the selection already is. pdf.js leaves this
 *    to Firefox and to Chromium 148 or later; here only Firefox is left to itself (see below):
 *    Chromium 155 dropped a line's last word when let go in a gutter;
 *  - the button let go, the window left, a key let go with no button down, or a selection elsewhere:
 *    the layer is reset (the element back at its end, not selecting).
 */
import "./textLayerSelection.css";

export const END_OF_CONTENT_CLASS = "ao-reader-end-of-content";
const LAYER_SELECTOR = ".ao-reader-text-layer";

/** Every guarded layer and its element. */
const layers = new Map<HTMLElement, HTMLElement>();
let listening: AbortController | undefined;

function reset(end: HTMLElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  layer.classList.remove("selecting");
}

function listen(): void {
  if (listening) return;
  listening = new AbortController();
  const { signal } = listening;
  let pointerDown = false;
  let firefox: boolean | undefined;
  let prevRange: Range | undefined;
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!pointerDown) layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add("selecting");
        else reset(end, layer);
      }
      if (active.size === 0) return;
      // pdf.js leaves this step to Firefox, and to Chromium 148 or later. Firefox only here: in
      // Chromium 155 a drag let go in a column's gutter then lost the line's last word ("…old plane"
      // for "…old plane trees.", probed end to end), and with the step it keeps the whole line.
      if (firefox === undefined) firefox = getComputedStyle(layers.keys().next().value!).getPropertyValue("-moz-user-select") === "none";
      if (firefox) return;
      const range = selection.getRangeAt(0);
      const modifyStart = !!prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE && anchor.parentNode) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0) {
        // The focus at the very start of a node: beside the last node before it that holds something.
        do {
          while (!anchor.previousSibling) {
            if (!anchor.parentNode) return;
            anchor = anchor.parentNode;
          }
          anchor = anchor.previousSibling;
        } while (!anchor.childNodes.length);
      }
      const layer = anchor.parentElement?.closest<HTMLElement>(LAYER_SELECTOR);
      const end = layer ? layers.get(layer) : undefined;
      if (layer && end && anchor.parentElement) {
        end.style.width = layer.style.width;
        end.style.height = layer.style.height;
        end.style.userSelect = "text";
        anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}

/**
 * Guards a text layer that has been laid out: its element appended, its press watched. Returns the
 * guard's undoing (the element removed, the press no longer watched; the document's listeners go
 * with the last guarded layer).
 */
export function guardTextLayer(layer: HTMLElement): () => void {
  const end = layer.ownerDocument.createElement("div");
  end.className = END_OF_CONTENT_CLASS;
  end.setAttribute("aria-hidden", "true");
  layer.append(end);
  const onDown = () => layer.classList.add("selecting");
  layer.addEventListener("mousedown", onDown);
  layers.set(layer, end);
  listen();
  return () => {
    layer.removeEventListener("mousedown", onDown);
    end.remove();
    layer.classList.remove("selecting");
    layers.delete(layer);
    if (layers.size === 0) {
      listening?.abort();
      listening = undefined;
    }
  };
}
