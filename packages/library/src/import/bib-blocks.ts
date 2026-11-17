/**
 * Where a BibTeX block ends: the one rule of both BibTeX readers, the export reader (refman.ts) and
 * the sidecar reader (sidecar.ts) (R362 g, R366; refining the recovery of R57/R58).
 *
 * A block (`@type{…}` or `@type(…)`: an entry, @string, @comment, @preamble) is judged at its own
 * level — between its fields, inside no braced value and (for an entry or @string) no quoted value:
 *
 *   - `{` blocks are closed by the brace that brings the count back to their level's (a backslash
 *     escapes the next character, never a line break); `(` blocks by their own ")", parentheses being
 *     counted only at their level outside values.
 *   - A block line (beginsBlockLine: "@type{key," and the forms of @string, @comment, @preamble) at
 *     an entry's or @string's own level ends it there: it is cut, whatever closes later (R366 a).
 *     Inside a value it is part of the value, and a closed entry around it carries the third doubt.
 *     A @comment or @preamble is not cut by such a line (commented-out entries stay comments).
 *   - A block that never closes is cut at the first block line after its opening, at any depth, or
 *     runs to the end of the text.
 *
 * A record so cut, or left unclosed at the end, carries a doubt (BIB_DOUBTS); so does one closed with
 * text after its closing brace that looks like the remains of its fields (R366 e, R374 b), and one closed around a block line inside a value.
 *
 * Linear: one forward scan shared by the reader's queries (they come in increasing order); a block
 * the scan passed inside another is scanned on its own if asked for (bounded by its extent), and all
 * scanning of a text is bounded. Only the block asked for and blocks opened by a block line are
 * tracked, at most `maxTracked` at once.
 */

/** The doubts a BibTeX record carries when the reader could not take it whole (R362 g). */
export const BIB_DOUBTS = {
  cut: 'The BibTeX entry was not closed, so it was cut at a line beginning with "@"; its fields may be incomplete or hold text from what followed it.',
  eof: "The BibTeX entry was not closed before the end of the file; its fields may be incomplete or hold text from what followed it.",
  textAfter: "There is text after this BibTeX entry's closing brace that belongs to no entry; some of the entry's fields may be incomplete.",
  innerEntry:
    'A line inside one of this BibTeX entry\'s fields begins like another entry ("@type{"); it was read as part of the field. If a closing brace is missing in the file, other entries may be inside this one.',
} as const;

export interface BibBlock {
  /** Just past the block's closing delimiter; or, when it never closes, where it was cut (an "@") or the end of the text. */
  end: number;
  state: "closed" | "cut" | "eof";
  /** Closed, with a line inside it that begins an entry (`@type{` or `@type(`). */
  innerEntry: boolean;
  /** A `{` block closed with text after it, before the next "@", other than white space, "}" or a `%` comment (R366 e). */
  textAfter?: boolean;
}

const isLetter = (c: string | undefined) => !!c && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

/** A key's or an @string name's character: none of white space, a brace, a parenthesis, a quote, "=" or ",". */
const isKeyChar = (c: string | undefined) =>
  !!c && !isSpace(c) && c !== "{" && c !== "}" && c !== "(" && c !== ")" && c !== '"' && c !== "=" && c !== ",";

/**
 * Whether the "@" at `at` (first on its line, after optional spaces or tabs) begins a block line (R366 c):
 *   - an entry: "@", the type's letters, optional white space, "{" or "(", optional white space, a key
 *     (isKeyChar, one or more), optional white space, ",";
 *   - `@string{name =` (the same, with "=" for ","), `@comment{` and `@preamble{` ("{" or "(").
 * "@jdoe (2021) wrote back" or "@jdoe {at} the meeting" begins none.
 */
export function beginsBlockLine(src: string, at: number): boolean {
  return blockLineOpen(src, at) >= 0;
}

/** The index of the opening delimiter of the block line whose "@" is at `at` (beginsBlockLine), or -1. */
function blockLineOpen(src: string, at: number): number {
  let j = at + 1;
  const s = j;
  while (isLetter(src[j])) j++;
  if (j === s) return -1;
  const type = src.slice(s, j).toLowerCase();
  while (isSpace(src[j])) j++;
  if (src[j] !== "{" && src[j] !== "(") return -1;
  const open = j;
  if (type === "comment" || type === "preamble") return open;
  j++;
  while (isSpace(src[j])) j++;
  const k = j;
  while (isKeyChar(src[j])) j++;
  if (j === k) return -1;
  while (isSpace(src[j])) j++;
  return src[j] === (type === "string" ? "=" : ",") ? open : -1;
}

/** The doubt a record carries for its block, if any. */
export function bibDoubt(b: Pick<BibBlock, "state" | "innerEntry" | "textAfter">): string | undefined {
  if (b.state === "cut") return BIB_DOUBTS.cut;
  if (b.state === "eof") return BIB_DOUBTS.eof;
  return b.textAfter ? BIB_DOUBTS.textAfter : b.innerEntry ? BIB_DOUBTS.innerEntry : undefined;
}

/** A character of a field name after its first letter. */
function isNameChar(c: string | undefined): boolean {
  return c !== undefined && (isLetter(c) || (c >= "0" && c <= "9") || c === "_" || c === ":" || c === "." || c === "+" || c === "-");
}

/** Whether `src[a, e)` (one stretch of a line, outside any `%` comment) looks like the remains of an entry's fields (R374 b). */
function looksLikeFields(src: string, a: number, e: number): boolean {
  let s = a;
  while (s < e && isSpace(src[s])) s++;
  let t = e;
  while (t > s && isSpace(src[t - 1])) t--;
  if (t === s) return false;
  // (ii) ends with ","
  if (src[t - 1] === ",") return true;
  // (iii) ends with "}" after other text on the line
  if (src[t - 1] === "}") {
    for (let k = s; k < t; k++) if (src[k] !== "}" && !isSpace(src[k])) return true;
  }
  // (i) a field assignment: a name, optional white space, "=", optional white space, then "{", a quote, a letter or a digit
  for (let k = s; k < t; k++) {
    if (src[k] !== "=") continue;
    let j = k + 1;
    while (j < t && isSpace(src[j])) j++;
    const v = src[j];
    if (j >= t || !(v === "{" || v === '"' || isLetter(v) || (v! >= "0" && v! <= "9"))) continue;
    j = k - 1;
    while (j >= s && isSpace(src[j])) j--;
    let letter = false;
    while (j >= s && isNameChar(src[j])) {
      if (isLetter(src[j])) letter = true;
      j--;
    }
    if (letter) return true;
  }
  return false;
}

/**
 * Whether text that looks like the remains of the entry's fields follows a block closed at `end`,
 * before the next "@" (or the end) (R374 b): outside `%` comments (to the end of the line), a line that
 * holds a field assignment ("name = {", "name = 2020"), ends with "," or ends with "}" after other
 * text. Free text between entries (notes, section headers) and extra closing braces are not a doubt.
 * One pass; each line is scanned a constant number of times.
 */
function textAfter(src: string, end: number): boolean {
  const n = src.length;
  let k = end;
  while (k < n) {
    let e = k;
    while (e < n && src[e] !== "\n" && src[e] !== "\r" && src[e] !== "%" && src[e] !== "@") e++;
    if (looksLikeFields(src, k, e)) return true;
    if (src[e] === "@") return false;
    if (src[e] === "%") {
      while (e < n && src[e] !== "\n" && src[e] !== "\r" && src[e] !== "@") e++;
      if (src[e] === "@") return false;
    }
    k = e + 1;
  }
  return false;
}

/** More blocks are open at once (or resolved ahead of the reader) than any export can hold: see BibBlocks. */
export class TooManyBibBlocks extends Error {
  constructor() {
    super("too many BibTeX blocks");
  }
}

/** The type letters of a block opened by the delimiter at `k` ("@", letters, optional white space before it), or undefined. */
function openerType(src: string, k: number): string | undefined {
  let j = k - 1;
  while (j >= 0 && isSpace(src[j])) j--;
  const last = j;
  while (j >= 0 && isLetter(src[j])) j--;
  return last > j && src[j] === "@" ? src.slice(j + 1, last + 1).toLowerCase() : undefined;
}

interface Open {
  /** Its opening delimiter. */
  open: number;
  /** The brace depth of the block's own level (between its fields): just inside its "{", or at its "(". */
  base: number;
  paren: boolean;
  /** An entry or @string (not @comment, @preamble): a block line at its own level ends it, and a quote there opens a value. */
  fields: boolean;
  /** Inside a quoted value at the block's own level. */
  quote: boolean;
  /** `(` blocks: parentheses open at the block's own level outside values (its own included). */
  parens: number;
  /** The scanner's count of block lines when it was opened. */
  lines0: number;
}

type Result = BibBlock | "unclosed";

/** What the scans of one text share: results not yet asked for, and the work done (bounded). */
interface Shared {
  done: Map<number, Result>;
  steps: number;
  budget: number;
}

/**
 * One forward scan over the text from a block's opening delimiter. Brace depth is absolute (it may go
 * below zero); every block is judged relative to its own level, so what a block's scan finds depends
 * only on the text from its opening on.
 */
class Scanner {
  pos: number;
  private depth = 0;
  private lineStart = false;
  /** Count of block lines (beginsBlockLine) passed. */
  private lines = 0;
  /** The opening delimiter of the last block line passed. */
  private lineOpen = -1;
  readonly stack: Open[] = [];
  private target = -1;
  private hit = false;

  constructor(
    private readonly src: string,
    private readonly maxTracked: number,
    from: number,
    private readonly shared: Shared,
  ) {
    this.pos = from;
  }

  private get done(): Map<number, Result> {
    return this.shared.done;
  }

  /** Moves the scan to `at` (only with nothing open: what lies between is not inside any block). */
  jump(at: number): void {
    this.pos = at;
    this.lineStart = false;
  }

  private push(open: number, paren: boolean, type: string): void {
    if (this.stack.length + this.done.size >= this.maxTracked) throw new TooManyBibBlocks();
    this.stack.push({ open, base: this.depth, paren, fields: type !== "comment" && type !== "preamble", quote: false, parens: paren ? 1 : 0, lines0: this.lines });
  }

  /**
   * `o` has just been taken off the stack with result `r`. A block resolved inside another open block
   * is forgotten (R366 g): the reader asks for it only if the outer one never closes, and then its own
   * scan finds the same result (bounded by its extent).
   */
  private finish(o: Open, r: Result): void {
    if (o.open === this.target) this.hit = true;
    if (this.stack.length === 0 || o.open === this.target) this.done.set(o.open, r);
  }

  private closed(o: Open, at: number): BibBlock {
    return { end: at + 1, state: "closed", innerEntry: this.lines > o.lines0 };
  }

  /** A block line at `q`: it ends every block whose own level it is on (outside a quoted value); for the others it is inside a value. */
  private blockLine(q: number): void {
    this.lineOpen = blockLineOpen(this.src, q);
    for (let t = this.stack.at(-1); t && t.base === this.depth && t.fields && !t.quote; t = this.stack.at(-1)) {
      this.stack.pop();
      this.finish(t, { end: q, state: "cut", innerEntry: this.lines > t.lines0 });
    }
    this.lines++;
  }

  /** Scans until the block opening at `open` is resolved (or the text ends); its result, taken. */
  runTo(open: number): Result | undefined {
    this.target = open;
    this.hit = this.done.has(open);
    const { src } = this;
    const n = src.length;
    while (!this.hit && this.pos < n) {
      const p = this.pos;
      if (++this.shared.steps > this.shared.budget) throw new TooManyBibBlocks();
      if (this.lineStart) {
        this.lineStart = false;
        let q = p;
        while (src[q] === " " || src[q] === "\t") q++;
        if (src[q] === "@" && beginsBlockLine(src, q)) this.blockLine(q);
        this.shared.steps += q - p;
      }
      const c = src[p];
      const top = this.stack.at(-1);
      if (c === "\\") {
        const d = src[p + 1];
        this.pos += d === undefined || d === "\n" || d === "\r" ? 1 : 2; // a backslash never hides a line break
        continue;
      }
      if (c === "\n" || c === "\r") this.lineStart = true;
      else if (c === "{") {
        this.depth++;
        // Tracked: the block asked for, and blocks opened by a block line (R366 g: never one opened
        // mid-line inside a value, such as "a@b{c}"; the reader asks for those only after an unclosed
        // block, and then their own scan finds the same).
        const type = p === open ? (openerType(src, p) ?? "") : p === this.lineOpen ? openerType(src, p) : undefined;
        if (type !== undefined) this.push(p, false, type);
      } else if (c === "}") {
        this.depth--;
        for (let t = this.stack.at(-1); t && t.base > this.depth; t = this.stack.at(-1)) {
          this.stack.pop();
          this.finish(t, t.paren ? "unclosed" : this.closed(t, p));
        }
      } else if (c === "(") {
        // A "(" inside a quoted value at the block's level is not tracked (its own quotes would be the value's).
        const type = p === open ? (openerType(src, p) ?? "") : p === this.lineOpen && !top?.quote ? openerType(src, p) : undefined;
        if (type !== undefined) this.push(p, true, type);
        else if (top?.paren && top.base === this.depth && !top.quote) top.parens++;
      } else if (c === ")") {
        if (top?.paren && top.base === this.depth && !top.quote && --top.parens === 0) {
          this.stack.pop();
          this.finish(top, this.closed(top, p));
        }
      } else if (c === '"') {
        if (top?.fields && top.base === this.depth) top.quote = !top.quote;
      }
      this.pos++;
    }
    if (!this.hit && this.pos >= n) {
      // The end of the text: every block still open never closed (all kept: the reader may ask for any of them).
      for (const o of this.stack) this.done.set(o.open, "unclosed");
      this.stack.length = 0;
    }
    const r = this.done.get(open);
    this.done.delete(open);
    return r;
  }
}

export class BibBlocks {
  private readonly n: number;
  /** The scan shared by the reader's queries (they come in increasing order). */
  private readonly scan: Scanner;
  private readonly shared: Shared;
  /** The last line-start search: from `from`, the first block line is at `at` (n: none). */
  private memo = { from: -1, at: -1 };

  /**
   * `maxTracked`: at most this many blocks are held open or resolved ahead of the reader (memory stays
   * bounded on a hostile file); past it, TooManyBibBlocks.
   */
  constructor(
    private readonly src: string,
    private readonly maxTracked = Number.POSITIVE_INFINITY,
  ) {
    this.n = src.length;
    // The scans' work is bounded: one pass, plus the own scans of blocks inside an unclosed one (a
    // hostile file that would need more is refused like one with too many blocks).
    this.shared = { done: new Map(), steps: 0, budget: 8 * this.n + 64 * 1024 * 1024 };
    this.scan = new Scanner(src, maxTracked, 0, this.shared);
  }

  /**
   * Index of the "@" of the first line at or after `from` that is a block line (beginsBlockLine; spaces
   * and tabs may come first), or the text's length. `from` is just past an opening delimiter.
   */
  nextEntryLine(from: number): number {
    if (from >= this.memo.from && from <= this.memo.at && this.memo.from >= 0) return this.memo.at;
    let at = this.n;
    for (let k = from; k < this.n; k++) {
      const c = this.src[k];
      if (c !== "\n" && c !== "\r") continue;
      let j = k + 1;
      while (this.src[j] === " " || this.src[j] === "\t") j++;
      if (this.src[j] === "@" && beginsBlockLine(this.src, j)) {
        at = j;
        break;
      }
    }
    this.memo = { from, at };
    return at;
  }

  /** The block whose opening delimiter ("{" or "(") is at `open`. Queries come in increasing order. */
  block(open: number): BibBlock {
    const g = this.scan;
    const known = this.shared.done.has(open);
    let r: Result | undefined;
    if (known || open >= g.pos) {
      if (!known && !g.stack.length) g.jump(open);
      r = g.runTo(open);
    }
    // A block the shared scan passed inside another (and so did not keep): its own scan.
    r ??= new Scanner(this.src, this.maxTracked, open, this.shared).runTo(open);
    if (r === undefined || r === "unclosed") return this.unclosed(open);
    return r.state === "closed" && this.src[open] === "{" && textAfter(this.src, r.end) ? { ...r, textAfter: true } : r;
  }

  /** Where a block opening at `open` that never closes ends. */
  unclosed(open: number): BibBlock {
    const at = this.nextEntryLine(open + 1);
    return at < this.n ? { end: at, state: "cut", innerEntry: false } : { end: this.n, state: "eof", innerEntry: false };
  }
}
