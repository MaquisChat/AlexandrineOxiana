/**
 * The keyboard's own text selection (Task R11): word by word, in the order the PDF stores its text,
 * over the text items of the drawn pages. The pages here are built as pdf.js's TextLayer builds them
 * (a span an item with text, a <br> where pdf.js ends a line); jsdom lays nothing out, so where an
 * item lies on screen is given by `rectOf`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createKeyboardSelection, textItemsOf, type DOMRectLike, type TextItemRef } from "./keyboardSelection";

/** One item of a page: its text, and whether pdf.js ends a line after it. */
type Item = string | { s: string; eol: true };

/** Builds a text layer as pdf.js does (empty items get no span; a line's end is a <br>) and gives its items. */
function pageOf(n: number, items: Item[]): { layer: HTMLElement; refs: TextItemRef[] } {
  const box = document.createElement("div");
  box.dataset.pageNumber = String(n);
  const layer = document.createElement("div");
  layer.className = "ao-reader-text-layer";
  box.append(layer);
  for (const it of items) {
    const s = typeof it === "string" ? it : it.s;
    if (s !== "") {
      const span = document.createElement("span");
      span.textContent = s;
      layer.append(span);
    }
    if (typeof it !== "string") layer.append(document.createElement("br"));
  }
  document.body.append(box);
  return { layer, refs: textItemsOf(n, layer) };
}

const eol = (s: string) => ({ s, eol: true }) as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe("textItemsOf", () => {
  it("gives each text node of a layer in order, with pdf.js's line ends", () => {
    const { refs } = pageOf(1, ["Alpha", " ", eol("beta"), eol(""), "gamma"]);
    expect(refs.map((r) => [r.page, r.node.data, r.eol])).toEqual([
      [1, "Alpha", false],
      [1, " ", false],
      [1, "beta", true],
      [1, "gamma", false],
    ]);
  });
});

describe("createKeyboardSelection", () => {
  it("extends by word and by line, across a page", () => {
    const p1 = pageOf(1, ["One two", eol(" three"), "four five", eol(" six")]);
    const p2 = pageOf(2, [eol("Seven eight"), "nine"]);
    const sel = createKeyboardSelection([...p1.refs, ...p2.refs], { page: 1, view: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
    expect(sel.start("first-visible-word")).toBe(true);
    expect(sel.text()).toBe("One");
    expect(sel.extend("word", 1)).toBe("moved");
    expect(sel.text()).toBe("One two");
    expect(sel.extend("word", 1)).toBe("moved");
    expect(sel.text()).toBe("One two three");
    // A line down: the same place in the next line (the third word there is none: its last).
    expect(sel.extend("line", 1)).toBe("moved");
    expect(sel.text()).toBe("One two three\nfour five six");
    // A line down from the page's last line: the next page's first line.
    expect(sel.extend("line", 1)).toBe("moved");
    expect(sel.text()).toBe("One two three\nfour five six\nSeven eight");
    expect(sel.extend("word", 1)).toBe("moved");
    expect(sel.text()).toBe("One two three\nfour five six\nSeven eight\nnine");
    // Back up a line, and a word: shrinks again.
    expect(sel.extend("line", -1)).toBe("moved");
    expect(sel.text()).toBe("One two three\nfour five six\nSeven");
    expect(sel.extend("word", -1)).toBe("moved");
    expect(sel.text()).toBe("One two three\nfour five six");
    // The range is the browser's: from the first word's start to the last's end, in the layers' own text nodes.
    const r = sel.range()!;
    expect(r.startContainer).toBe(p1.refs[0]!.node);
    expect(r.startOffset).toBe(0);
    expect(r.endContainer).toBe(p1.refs[3]!.node);
    expect(r.endOffset).toBe(" six".length);
    // (A <br> is no text of a range.)
    expect(r.toString()).toBe("One two threefour five six");
  });

  it("never selects past the document's end, nor before its start", () => {
    const p1 = pageOf(1, [eol("First line"), "last words"]);
    const sel = createKeyboardSelection(p1.refs);
    sel.start("first-visible-word");
    for (let i = 0; i < 10; i++) sel.extend("word", 1);
    expect(sel.text()).toBe("First line\nlast words");
    expect(sel.extend("word", 1)).toBe("edge");
    expect(sel.extend("line", 1)).toBe("edge");
    expect(sel.text()).toBe("First line\nlast words");
    // Back past the anchor: the selection turns, the first word always in it, and stops at the start.
    for (let i = 0; i < 10; i++) sel.extend("word", -1);
    expect(sel.text()).toBe("First");
    expect(sel.extend("word", -1)).toBe("edge");
    expect(sel.extend("line", -1)).toBe("edge");
  });

  it("Shift+Left gives back a word: the anchor word stays, and the selection can turn backwards", () => {
    const p1 = pageOf(1, ["alpha beta gamma delta"]);
    const sel = createKeyboardSelection(p1.refs);
    sel.start("first-visible-word");
    sel.extend("word", 1);
    sel.extend("word", 1);
    expect(sel.text()).toBe("alpha beta gamma");
    sel.extend("word", -1);
    expect(sel.text()).toBe("alpha beta");
    sel.extend("word", -1);
    expect(sel.text()).toBe("alpha");
  });

  it("starts at the first word visible in the view, not the page's first", () => {
    // Five lines of 20 px (16 high) from the top; the view starts at 50 px: line 2 (40 to 56, middle 48) is cut off, line 3 is the first in it.
    const p1 = pageOf(1, [eol("zero a"), eol("one b"), eol("two c"), eol("three d"), "four e"]);
    const lineOfNode = new Map(p1.refs.map((r, i) => [r.node, i]));
    let measured = 0;
    const rectOf = (node: Text, from: number, to: number): DOMRectLike => {
      measured++;
      const i = lineOfNode.get(node)!;
      return { left: 10 + from * 8, top: i * 20, width: (to - from) * 8, height: 16 };
    };
    const sel = createKeyboardSelection(p1.refs, { page: 1, view: () => ({ left: 0, top: 50, width: 500, height: 200 }), rectOf });
    sel.start("first-visible-word");
    expect(sel.text()).toBe("three");
    expect(measured).toBeLessThan(12);
    // A word of a line cut off at the top of the view is not taken: its middle is above the view.
    const sel2 = createKeyboardSelection(p1.refs, { page: 1, view: () => ({ left: 0, top: 30, width: 500, height: 200 }), rectOf });
    sel2.start("first-visible-word");
    expect(sel2.text()).toBe("two");
    // Scrolled sideways (zoomed in): the first word whose middle is in view.
    const sel3 = createKeyboardSelection(p1.refs, { page: 1, view: () => ({ left: 60, top: 50, width: 500, height: 200 }), rectOf });
    sel3.start("first-visible-word");
    expect(sel3.text()).toBe("d");
    // Only the page asked for: page 2's words are not where it starts.
    const p2 = pageOf(2, ["page two"]);
    const sel4 = createKeyboardSelection([...p1.refs, ...p2.refs], { page: 2, view: () => ({ left: 0, top: -1000, width: 5000, height: 5000 }), rectOf: () => ({ left: 0, top: 0, width: 1, height: 1 }) });
    sel4.start("first-visible-word");
    expect(sel4.text()).toBe("page");
  });

  it("a word split across two text items is one word; empty items and a hyphenated line end skip nothing and take nothing twice", () => {
    const p1 = pageOf(1, ["exam", "ple", "", " ", "", eol("self-"), "evident", " ", "ﬁnd 😀x"]);
    const sel = createKeyboardSelection(p1.refs);
    sel.start("first-visible-word");
    expect(sel.text()).toBe("example");
    const r = sel.range()!;
    expect(r.startContainer).toBe(p1.refs[0]!.node);
    expect(r.endContainer).toBe(p1.refs[1]!.node);
    expect(r.endOffset).toBe(3);
    sel.extend("word", 1);
    expect(sel.text()).toBe("example self-");
    sel.extend("word", 1);
    expect(sel.text()).toBe("example self-\nevident");
    sel.extend("word", 1);
    // A ligature is a character of its word; a character outside the basic plane is never cut in half.
    expect(sel.text()).toBe("example self-\nevident ﬁnd");
    sel.extend("word", 1);
    expect(sel.text()).toBe("example self-\nevident ﬁnd 😀x");
    expect(sel.extend("word", 1)).toBe("edge");
  });

  it("right-to-left text is taken word by word in the order the PDF stores it, its characters as they are", () => {
    const p1 = pageOf(1, ["שלום עולם", " ", "مرحبا"]);
    const sel = createKeyboardSelection(p1.refs);
    sel.start("first-visible-word");
    expect(sel.text()).toBe("שלום");
    sel.extend("word", 1);
    expect(sel.text()).toBe("שלום עולם");
    sel.extend("word", 1);
    expect(sel.text()).toBe("שלום עולם مرحبا");
  });

  it("a page with no words between two pages is passed over; a page with no words cannot be started on", () => {
    const p1 = pageOf(1, ["end"]);
    const p2 = pageOf(2, [" ", eol("")]);
    const p3 = pageOf(3, ["next"]);
    const all = [...p1.refs, ...p2.refs, ...p3.refs];
    const sel = createKeyboardSelection(all, { page: 1, view: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
    sel.start("first-visible-word");
    sel.extend("word", 1);
    expect(sel.text()).toBe("end\n \nnext");
    expect(sel.range()!.toString()).toBe("end next");
    const none = createKeyboardSelection(all, { page: 2, view: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
    expect(none.start("first-visible-word")).toBe(false);
    expect(none.active).toBe(false);
    expect(none.range()).toBeNull();
    expect(none.text()).toBe("");
  });

  it("gives no range once a page it covers is no longer drawn, and nothing once cancelled", () => {
    const p1 = pageOf(1, ["one"]);
    const p2 = pageOf(2, ["two"]);
    const sel = createKeyboardSelection([...p1.refs, ...p2.refs]);
    sel.start("first-visible-word");
    sel.extend("word", 1);
    expect(sel.range()!.toString()).toBe("onetwo");
    p2.layer.replaceChildren();
    expect(sel.range()).toBeNull();
    sel.cancel();
    expect(sel.active).toBe(false);
    expect(sel.range()).toBeNull();
    expect(sel.text()).toBe("");
    expect(sel.extend("word", 1)).toBe("edge");
  });

  it("a page of 20,000 items: a key press costs the words it passes, not the page", () => {
    const items: Item[] = [];
    for (let i = 0; i < 10_000; i++) items.push(`w${i}`, i % 50 === 49 ? eol(" ") : " ");
    const p1 = pageOf(1, items);
    expect(p1.refs).toHaveLength(20_000);
    let measured = 0;
    const sel = createKeyboardSelection(p1.refs, {
      page: 1,
      view: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      rectOf: () => {
        measured++;
        return { left: 1, top: 1, width: 1, height: 1 };
      },
    });
    sel.start("first-visible-word");
    expect(measured).toBeLessThan(4);
    for (let i = 0; i < 30; i++) sel.extend("word", 1);
    expect(sel.text().split(/\s+/)).toHaveLength(31);
    expect(sel.text().startsWith("w0 w1 w2")).toBe(true);
    sel.extend("line", 1);
    expect(sel.text().split(/\s+/).at(-1)).toBe("w80");
    for (let i = 0; i < 200; i++) sel.extend("line", 1);
    expect(sel.extend("line", 1)).toBe("edge");
    expect(sel.text().split(/\s+/).at(-1)).toBe("w9999");
  });
});
