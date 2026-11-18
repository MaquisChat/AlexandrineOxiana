/**
 * The keyboard's own text selection in the reader (Task R11): a selection made word by word, in the
 * ORDER THE PDF STORES ITS TEXT (for some two-column or unusual layouts that is not the reading
 * order: the reader's "Keyboard help" says so), over the text items of the pages that are drawn.
 *
 *  - An item is one text node of pdf.js's text layer (`textItemsOf`: a span an item with text, in
 *    pdf.js's order; a <br> where pdf.js ends a line). A WORD is a run of characters other than
 *    white space; the end of a line and the end of a page end a word, the end of an item does not
 *    (a word that pdf.js gives in two items is one word). Empty items and items of white space only
 *    hold no word. A LINE is the words between two of pdf.js's line ends (or a page's ends).
 *  - The selection is always whole words, from the ANCHOR word (where it started; always selected)
 *    to the FOCUS word (the end that moves): `extend("word", ±1)` moves the focus a word forward or
 *    back, `extend("line", ±1)` to the word at the same place (counted in words) of the next or the
 *    previous line, to the last (first) word when there is no further line. Past the anchor it turns:
 *    Shift+Left after Shift+Right gives the word back. It crosses into the next and the previous page
 *    of those it was given (a page with no word is passed over) and never past the first or the last
 *    word it was given: `extend` then answers "edge" and changes nothing.
 *  - `start("first-visible-word")`: the first word, in the PDF's order, on the page `options.page`
 *    whose middle is inside `options.view()` (the visible part of the pages, in the same coordinates
 *    as `rectOf`); if none is, the first word below the view's top; else the page's first word.
 *  - `range()`: a DOM Range from the first word's start to the last word's end, in the text layers'
 *    own nodes — what `selectionToAnchors` (Task R10) reads; null when there is no selection, or when
 *    a page it covers is no longer drawn (its text nodes are gone).
 *  - `text()`: the selected text, a line break where pdf.js ends a line or a page ends.
 *
 * Work: the words of a page are found once, when the selection first needs that page (linear in its
 * characters). A key press then costs O(1) for a word, and O(the words of the focus's line) for a line;
 * `start` reads at most one rectangle per item of the page, and one per word of the items it looks
 * into, stopping at the first visible word; `range` is O(1); `text` is linear in what is selected.
 */

/** One text item of a drawn page: its text node in pdf.js's text layer. */
export interface TextItemRef {
  /** 1-based, as anchors store it. */
  page: number;
  node: Text;
  /** pdf.js ends a line after this item (a <br> follows it). */
  eol: boolean;
}

export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface KeyboardSelectionOptions {
  /** The page `start` starts on (1-based); the first item's page when not given. */
  page?: number;
  /** The visible part of the pages, in the coordinates of `rectOf`; everything when not given. */
  view?(): DOMRectLike;
  /** Where characters `from` to `to` of `node` lie (default: a Range's bounding rectangle). */
  rectOf?(node: Text, from: number, to: number): DOMRectLike;
}

export interface KeyboardSelection {
  /** Starts the selection at the page's first visible word; false (no selection) when the page has no word. */
  start(at: "first-visible-word"): boolean;
  /** Moves the focus a word or a line forward (1) or back (-1); "edge" when it cannot (nothing changes). */
  extend(by: "word" | "line", dir: 1 | -1): "moved" | "edge";
  range(): Range | null;
  text(): string;
  cancel(): void;
  /** Whether a selection is held. */
  readonly active: boolean;
  /** The focus word, as a range (to keep it in view); null as `range()` is. */
  focusRange(): Range | null;
  /** The first and the last page of the items given (1-based). */
  readonly pages: { first: number; last: number };
}

/** The text items of one drawn page's text layer, in pdf.js's order. */
export function textItemsOf(page: number, layer: Element): TextItemRef[] {
  const out: TextItemRef[] = [];
  const walker = layer.ownerDocument.createTreeWalker(layer, 0x1 | 0x4);
  for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if ((n as Text).data !== "") out.push({ page, node: n as Text, eol: false });
    } else if ((n as Element).tagName === "BR" && out.length > 0) out[out.length - 1]!.eol = true;
  }
  return out;
}

interface Word {
  /** Item index and offset of its first character, and of the end of its last. */
  si: number;
  so: number;
  ei: number;
  eo: number;
  /** Its line, an index into the page's lines. */
  line: number;
}
interface PageWords {
  words: Word[];
  lines: Array<{ first: number; last: number }>;
}
/** A word: the index of its page (among the pages given) and its index there. */
interface Pos {
  p: number;
  w: number;
}

/** White space, as the PDF's text has it (every space of Unicode, tabs and line ends); never half a surrogate pair. */
const SPACE = /\s/u;
const cmp = (a: Pos, b: Pos) => a.p - b.p || a.w - b.w;

function boundingRect(node: Text, from: number, to: number): DOMRectLike {
  const r = node.ownerDocument.createRange();
  r.setStart(node, from);
  r.setEnd(node, to);
  // Where a Range cannot be measured (no layout engine), its item's element stands for it.
  const b = typeof r.getBoundingClientRect === "function" ? r.getBoundingClientRect() : (node.parentElement ?? node.ownerDocument.documentElement).getBoundingClientRect();
  return { left: b.left, top: b.top, width: b.width, height: b.height };
}

const intersects = (r: DOMRectLike, v: DOMRectLike) => r.top <= v.top + v.height && r.top + r.height >= v.top && r.left <= v.left + v.width && r.left + r.width >= v.left;
const middleIn = (r: DOMRectLike, v: DOMRectLike) => {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return x >= v.left && x <= v.left + v.width && y >= v.top && y <= v.top + v.height;
};

export function createKeyboardSelection(items: TextItemRef[], options: KeyboardSelectionOptions = {}): KeyboardSelection {
  /** The pages given, in order, each with its items' span. */
  const pages: Array<{ page: number; from: number; to: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const last = pages[pages.length - 1];
    if (last && last.page === items[i]!.page) last.to = i + 1;
    else pages.push({ page: items[i]!.page, from: i, to: i + 1 });
  }
  const found = new Map<number, PageWords>();
  let anchor: Pos | undefined;
  let focus: Pos | undefined;

  /** The words of the p-th page given, found once. */
  const wordsOf = (p: number): PageWords => {
    let pw = found.get(p);
    if (pw) return pw;
    pw = { words: [], lines: [] };
    const { from, to } = pages[p]!;
    /** pdf.js's line count so far, and the one the page's last listed line is. */
    let line = 0;
    let listed = -1;
    let open: { si: number; so: number; ei: number; eo: number } | undefined;
    const close = () => {
      if (!open) return;
      const { lines, words } = pw!;
      if (listed !== line) {
        lines.push({ first: words.length, last: words.length });
        listed = line;
      }
      lines[lines.length - 1]!.last = words.length;
      words.push({ ...open, line: lines.length - 1 });
      open = undefined;
    };
    for (let i = from; i < to; i++) {
      const d = items[i]!.node.data;
      for (let k = 0; k < d.length; k++) {
        if (SPACE.test(d[k]!)) close();
        else if (open) {
          open.ei = i;
          open.eo = k + 1;
        } else open = { si: i, so: k, ei: i, eo: k + 1 };
      }
      if (items[i]!.eol) {
        close();
        line++;
      }
    }
    close();
    found.set(p, pw);
    return pw;
  };
  const wordAt = (x: Pos) => wordsOf(x.p).words[x.w]!;
  /** The next (dir 1) or previous page index from `p` that has words. */
  const pageWithWords = (p: number, dir: 1 | -1): number | undefined => {
    for (let q = p + dir; q >= 0 && q < pages.length; q += dir) if (wordsOf(q).words.length > 0) return q;
    return undefined;
  };
  /** The first (dir -1) or last (dir 1) word given. */
  const outermost = (dir: 1 | -1): Pos | undefined => {
    const q = pageWithWords(dir > 0 ? pages.length : -1, dir > 0 ? -1 : 1);
    if (q === undefined) return undefined;
    return { p: q, w: dir > 0 ? wordsOf(q).words.length - 1 : 0 };
  };

  const rangeOf = (s: Word, e: Word): Range | null => {
    const a = items[s.si]!.node;
    const b = items[e.ei]!.node;
    if (!a.isConnected || !b.isConnected) return null;
    const r = a.ownerDocument.createRange();
    r.setStart(a, s.so);
    r.setEnd(b, e.eo);
    return r;
  };
  /** Every page between the selection's ends still drawn (its text nodes still in the page). */
  const allThere = (lo: Pos, hi: Pos): boolean => {
    for (let p = lo.p; p <= hi.p; p++) {
      const { from, to } = pages[p]!;
      if (!items[from]!.node.isConnected || !items[to - 1]!.node.isConnected) return false;
    }
    return true;
  };
  const ends = (): [Pos, Pos] | undefined => (anchor && focus ? (cmp(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor]) : undefined);

  const sel: KeyboardSelection = {
    get active() {
      return anchor !== undefined;
    },
    pages: { first: pages[0]?.page ?? 0, last: pages[pages.length - 1]?.page ?? 0 },

    start() {
      anchor = focus = undefined;
      const want = options.page ?? pages[0]?.page;
      const p = pages.findIndex((x) => x.page === want);
      if (p < 0) return false;
      const { words } = wordsOf(p);
      if (words.length === 0) return false;
      const view = options.view?.();
      let chosen: number | undefined;
      if (view) {
        const rectOf = options.rectOf ?? boundingRect;
        let below: number | undefined;
        let w = 0;
        for (let i = pages[p]!.from; i < pages[p]!.to && chosen === undefined; i++) {
          // The words that touch item i (words are in item order).
          while (w < words.length && words[w]!.ei < i) w++;
          if (w >= words.length) break;
          if (words[w]!.si > i) continue;
          const node = items[i]!.node;
          const r = rectOf(node, 0, node.data.length);
          if (below === undefined && r.top >= view.top) below = w;
          if (!intersects(r, view)) continue;
          for (let x = w; x < words.length && words[x]!.si <= i; x++) {
            const word = words[x]!;
            const from = word.si === i ? word.so : 0;
            const to = word.ei === i ? word.eo : node.data.length;
            if (middleIn(rectOf(node, from, to), view)) {
              chosen = x;
              break;
            }
          }
        }
        chosen ??= below;
      }
      anchor = focus = { p, w: chosen ?? 0 };
      return true;
    },

    extend(by, dir) {
      if (!focus) return "edge";
      const pw = wordsOf(focus.p);
      let to: Pos | undefined;
      if (by === "word") {
        const w = focus.w + dir;
        if (w >= 0 && w < pw.words.length) to = { p: focus.p, w };
        else {
          const q = pageWithWords(focus.p, dir);
          if (q !== undefined) to = { p: q, w: dir > 0 ? 0 : wordsOf(q).words.length - 1 };
        }
      } else {
        const L = pw.words[focus.w]!.line;
        const k = focus.w - pw.lines[L]!.first;
        let target: { p: number; line: { first: number; last: number } } | undefined;
        if (pw.lines[L + dir]) target = { p: focus.p, line: pw.lines[L + dir]! };
        else {
          const q = pageWithWords(focus.p, dir);
          if (q !== undefined) {
            const lines = wordsOf(q).lines;
            target = { p: q, line: lines[dir > 0 ? 0 : lines.length - 1]! };
          }
        }
        // No further line: to the last (first) word there is.
        to = target ? { p: target.p, w: Math.min(target.line.first + k, target.line.last) } : outermost(dir);
      }
      if (!to || cmp(to, focus) === 0) return "edge";
      focus = to;
      return "moved";
    },

    range() {
      const e = ends();
      if (!e || !allThere(e[0], e[1])) return null;
      return rangeOf(wordAt(e[0]), wordAt(e[1]));
    },

    focusRange() {
      const e = ends();
      if (!e || !focus || !allThere(e[0], e[1])) return null;
      const w = wordAt(focus);
      return rangeOf(w, w);
    },

    text() {
      const e = ends();
      if (!e) return "";
      const s = wordAt(e[0]);
      const t = wordAt(e[1]);
      let out = "";
      for (let i = s.si; i <= t.ei; i++) {
        const it = items[i]!;
        out += it.node.data.slice(i === s.si ? s.so : 0, i === t.ei ? t.eo : undefined);
        if (i < t.ei && (it.eol || items[i + 1]!.page !== it.page)) out += "\n";
      }
      return out;
    },

    cancel() {
      anchor = focus = undefined;
    },
  };
  return sel;
}
