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
  cut: 'The BibTeX entry was not closed, so it was cut at a line beginning with "@"; some of its fields may be incomplete.',
  eof: "The BibTeX entry was not closed before the end of the file; some of its fields may be incomplete.",
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

/** The doubt a record carries for its block, if any. */
export function bibDoubt(b: Pick<BibBlock, "state" | "innerEntry">): string | undefined {
  return b.state === "cut" ? BIB_DOUBTS.cut : b.state === "eof" ? BIB_DOUBTS.eof : b.innerEntry ? BIB_DOUBTS.innerEntry : undefined;
}

/** More blocks are open at once (or closed ahead of the reader) than any export can hold: see BibBlocks. */
export class TooManyBibBlocks extends Error {
  constructor() {
    super("too many BibTeX blocks");
  }
}

export class BibBlocks {
  private readonly n: number;
  /** The brace scan: next index to look at, and the brace depth there (relative; may go below zero). */
  private scan = 0;
  private started = false;
  private depth = 0;
  /** Opening braces of blocks (`@type{`) not yet closed (in increasing order), with the depth just inside them. */
  private readonly openAt: number[] = [];
  private readonly openDepth: number[] = [];
  /** Blocks the scan found closed that no query has asked for yet. */
  private readonly closedAt = new Map<number, number>();
  /** The last line-start search: from `from`, the first entry line is at `at` (n: none). */
  private memo = { from: -1, at: -1 };

  /**
   * `maxTracked`: at most this many blocks are held open or closed ahead of the reader (memory stays
   * bounded on a hostile file); past it, TooManyBibBlocks.
   */
  constructor(
    private readonly src: string,
    private readonly maxTracked = Number.POSITIVE_INFINITY,
  ) {
    this.n = src.length;
  }

  /** Whether the brace at `at` is open and tracked (binary search: openAt is in increasing order). */
  private isOpen(at: number): boolean {
    let lo = 0;
    let hi = this.openAt.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.openAt[mid]!;
      if (v === at) return true;
      if (v < at) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** Whether the "{" at `k` opens a block: "@", letters, optional white space before it (looked at once per brace). */
  private opensBlock(k: number): boolean {
    let j = k - 1;
    while (j >= 0 && isSpace(this.src[j])) j--;
    const last = j;
    while (j >= 0 && isLetter(this.src[j])) j--;
    return last > j && this.src[j] === "@";
  }

  private step(force = -1): void {
    const c = this.src[this.scan];
    if (c === "\\") {
      this.scan += this.src[this.scan + 1] === "\n" ? 1 : 2;
      return;
    }
    if (c === "{") {
      this.depth++;
      if (this.scan === force || this.opensBlock(this.scan)) {
        if (this.openAt.length + this.closedAt.size >= this.maxTracked) throw new TooManyBibBlocks();
        this.openAt.push(this.scan);
        this.openDepth.push(this.depth);
      }
    } else if (c === "}") {
      this.depth--;
      while (this.openDepth.length && this.openDepth[this.openDepth.length - 1]! > this.depth) {
        this.openDepth.pop();
        this.closedAt.set(this.openAt.pop()!, this.scan);
      }
    }
    this.scan++;
  }

  /** Index of the "}" that closes the "{" at `open`, or -1 when it never closes. Queries come in increasing order. */
  matchBrace(open: number): number {
    const known = this.closedAt.get(open);
    if (known !== undefined) {
      this.closedAt.delete(open);
      return known;
    }
    if (!this.isOpen(open)) {
      if (!this.started || open >= this.scan) {
        if (!this.started) {
          this.started = true;
          this.scan = open;
        }
        while (this.scan < open) this.step();
        if (this.scan === open) this.step(open);
      } else return this.countFrom(open); // a brace the scan passed without taking it as a block's (not used by the readers)
    }
    while (this.scan < this.n && !this.closedAt.has(open)) this.step();
    const m = this.closedAt.get(open) ?? -1;
    this.closedAt.delete(open);
    return m;
  }

  /** The plain count from `open` (the same rule as the scan). */
  private countFrom(open: number): number {
    let depth = 0;
    for (let k = open; k < this.n; k++) {
      const c = this.src[k];
      if (c === "\\") {
        if (this.src[k + 1] !== "\n") k++;
      } else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return k;
    }
    return -1;
  }

  /** Whether the "@" at `at` begins an entry: letters, optional white space, then "{" or "(". */
  private beginsEntry(at: number): boolean {
    let j = at + 1;
    const s = j;
    while (isLetter(this.src[j])) j++;
    if (j === s) return false;
    while (isSpace(this.src[j])) j++;
    return this.src[j] === "{" || this.src[j] === "(";
  }

  /**
   * Index of the "@" of the first line at or after `from` that begins an entry (spaces and tabs may
   * come first), or the text's length. `from` is just past an opening delimiter.
   */
  nextEntryLine(from: number): number {
    if (from >= this.memo.from && from <= this.memo.at && this.memo.from >= 0) return this.memo.at;
    let at = this.n;
    for (let nl = this.src.indexOf("\n", from); nl >= 0; nl = this.src.indexOf("\n", nl + 1)) {
      let j = nl + 1;
      while (this.src[j] === " " || this.src[j] === "\t") j++;
      if (this.src[j] === "@" && this.beginsEntry(j)) {
        at = j;
        break;
      }
    }
    this.memo = { from, at };
    return at;
  }

  /** The block whose opening delimiter ("{" or "(") is at `open`. */
  block(open: number): BibBlock {
    if (this.src[open] === "{") {
      const m = this.matchBrace(open);
      if (m >= 0) return { end: m + 1, state: "closed", innerEntry: this.nextEntryLine(open + 1) < m };
    } else {
      const limit = this.nextEntryLine(open + 1);
      let depth = 0;
      for (let k = open; k < limit; k++) {
        const c = this.src[k];
        if (c === "(") depth++;
        else if (c === ")" && --depth === 0) return { end: k + 1, state: "closed", innerEntry: false };
      }
    }
    return this.unclosed(open);
  }

  /** Where a block opening at `open` that never closes ends. */
  unclosed(open: number): BibBlock {
    const at = this.nextEntryLine(open + 1);
    return at < this.n ? { end: at, state: "cut", innerEntry: false } : { end: this.n, state: "eof", innerEntry: false };
  }
}
