/**
 * Where a BibTeX block ends: the one rule of both BibTeX readers, the export reader (refman.ts) and
 * the sidecar reader (sidecar.ts) (R362 g, refining the recovery of R57/R58).
 *
 * A block (`@type{…}` or `@type(…)`: an entry, @string, @comment, @preamble) ends at its OWN closing
 * delimiter. A line beginning with "@" inside it — a field value quoting an account ("@someuser
 * replied…") or a pasted citation ("@article{smith2020, …}") — is part of it whenever the block closes
 * properly after it:
 *
 *   - `{` blocks: braces are counted (a backslash escapes the next character, never a line break);
 *     the block is closed by the brace that brings the count back to zero, wherever that is.
 *   - `(` blocks: parentheses are counted up to the next line that begins an entry (see below); the
 *     export reader's own field parser decides where a `(` entry closes, within the same bound.
 *
 * Only a block that would otherwise run unclosed is recovered: it is cut at the first line after its
 * opening that begins an entry — "@", a type of letters, optional white space, then "{" or "(" (spaces
 * and tabs may come before the "@") — and with no such line it runs to the end of the text. A line
 * such as "@someuser replied" begins no entry, so it never cuts anything. A record so cut, or left
 * unclosed at the end of the text, carries a doubt (BIB_DOUBTS); so does a record that closed
 * properly around a line that begins an entry (had the file lost a closing brace there, entries would
 * be inside it).
 *
 * Linear in the text: brace matches are found by one forward scan shared by every query (queries come
 * in increasing order), and so are the lines that begin an entry.
 */

/** The doubts a BibTeX record carries when the reader could not take it whole (R362 g). */
export const BIB_DOUBTS = {
  cut: 'The BibTeX entry was not closed, so it was cut at a line beginning with "@"; its fields may be incomplete or hold text from what followed it.',
  eof: "The BibTeX entry was not closed before the end of the file; its fields may be incomplete or hold text from what followed it.",
  innerEntry:
    'A line inside one of this BibTeX entry\'s fields begins like another entry ("@type{"); it was read as part of the field. If a closing brace is missing in the file, other entries may be inside this one.',
} as const;

export interface BibBlock {
  /** Just past the block's closing delimiter; or, when it never closes, where it was cut (an "@") or the end of the text. */
  end: number;
  state: "closed" | "cut" | "eof";
  /** Closed, with a line inside it that begins an entry (`@type{` or `@type(`). */
  innerEntry: boolean;
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
  let j = at + 1;
  const s = j;
  while (isLetter(src[j])) j++;
  if (j === s) return false;
  const type = src.slice(s, j).toLowerCase();
  while (isSpace(src[j])) j++;
  if (src[j] !== "{" && src[j] !== "(") return false;
  if (type === "comment" || type === "preamble") return true;
  j++;
  while (isSpace(src[j])) j++;
  const k = j;
  while (isKeyChar(src[j])) j++;
  if (j === k) return false;
  while (isSpace(src[j])) j++;
  return src[j] === (type === "string" ? "=" : ",");
}

/** The doubt a record carries for its block, if any. */
export function bibDoubt(b: Pick<BibBlock, "state" | "innerEntry">): string | undefined {
  return b.state === "cut" ? BIB_DOUBTS.cut : b.state === "eof" ? BIB_DOUBTS.eof : b.innerEntry ? BIB_DOUBTS.innerEntry : undefined;
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
  readonly stack: Open[] = [];
  /** Blocks resolved and not yet asked for. */
  readonly done = new Map<number, Result>();
  private target = -1;
  private hit = false;

  constructor(
    private readonly src: string,
    private readonly maxTracked: number,
    /** Keep the results of blocks resolved inside another open block. */
    private readonly keepNested: boolean,
    from: number,
  ) {
    this.pos = from;
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

  /** `o` has just been taken off the stack with result `r`. */
  private finish(o: Open, r: Result): void {
    if (o.open === this.target) this.hit = true;
    if (this.keepNested || this.stack.length === 0 || o.open === this.target) this.done.set(o.open, r);
  }

  private closed(o: Open, at: number): BibBlock {
    return { end: at + 1, state: "closed", innerEntry: this.lines > o.lines0 };
  }

  /** A block line at `q`: it ends every block whose own level it is on (outside a quoted value); for the others it is inside a value. */
  private blockLine(q: number): void {
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
      if (this.lineStart) {
        this.lineStart = false;
        let q = p;
        while (src[q] === " " || src[q] === "\t") q++;
        if (src[q] === "@" && beginsBlockLine(src, q)) this.blockLine(q);
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
        const type = p === open ? (openerType(src, p) ?? "") : top?.quote ? undefined : openerType(src, p);
        if (type !== undefined) this.push(p, false, type);
      } else if (c === "}") {
        this.depth--;
        for (let t = this.stack.at(-1); t && t.base > this.depth; t = this.stack.at(-1)) {
          this.stack.pop();
          this.finish(t, t.paren ? "unclosed" : this.closed(t, p));
        }
      } else if (c === "(") {
        const type = p === open ? (openerType(src, p) ?? "") : top?.quote ? undefined : openerType(src, p);
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
    this.scan = new Scanner(src, maxTracked, true, 0);
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
    let r: Result | undefined;
    if (g.done.has(open) || open >= g.pos) {
      if (!g.done.has(open) && !g.stack.length) g.jump(open);
      r = g.runTo(open);
    }
    // A block the shared scan passed inside another (and so did not keep): its own scan.
    r ??= new Scanner(this.src, this.maxTracked, false, open).runTo(open);
    return r === undefined || r === "unclosed" ? this.unclosed(open) : r;
  }

  /** Where a block opening at `open` that never closes ends. */
  unclosed(open: number): BibBlock {
    const at = this.nextEntryLine(open + 1);
    return at < this.n ? { end: at, state: "cut", innerEntry: false } : { end: this.n, state: "eof", innerEntry: false };
  }
}
