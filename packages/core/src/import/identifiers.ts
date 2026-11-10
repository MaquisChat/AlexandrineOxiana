/** Identifier detection in free text. Pure and platform-neutral. */

export type FoundIdentifiers = { dois: string[]; isbns: string[]; arxiv: string[] };

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/g;
const DOI_TRAILING = /[.,;:!?'’”]+$/u;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Trims trailing punctuation, and a trailing closing bracket only when it is unbalanced. */
function trimDoi(raw: string): string {
  let d = raw;
  for (;;) {
    const before = d;
    d = d.replace(DOI_TRAILING, "");
    const last = d.slice(-1);
    const open = CLOSERS[last];
    if (open) {
      let o = 0;
      let c = 0;
      for (const ch of d) {
        if (ch === open) o++;
        else if (ch === last) c++;
      }
      if (c > o) d = d.slice(0, -1);
    }
    if (d === before) return d;
  }
}

// Separators between digits are a single space or hyphen. Candidates may not be glued to other digits.
const ISBN_RE =
  /(?<!\d[ -]?)(?:97[89](?:[ -]?\d){10}|\d(?:[ -]?\d){8}[ -]?[\dXx])(?![ -]?[\dXx])/g;
const ISBN_LABEL = /ISBN(?:-?1[03])?:?/gi;
const ISBN_LABEL_REACH = 20;

// New-style arXiv ids: YYMM.NNNN (to 1412) or YYMM.NNNNN (from 1501); validated after matching.
const ARXIV_NEW = /(?<!\d)(?<!\d\.)(\d{4})\.(\d{4,5})(?:v\d+)?(?!\d)(?!\.\d)(?![A-Za-z])/g;
// Old-style: archive[.CLASS]/YYMMNNN
const ARXIV_OLD = /(?<![A-Za-z0-9-])[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/(\d{7})(?:v\d+)?(?!\d)/g;

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function isbn13Check(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** Validates an ISBN-10 or ISBN-13 (digits, optional trailing X) and returns it as ISBN-13, or null. */
export function toIsbn13(raw: string): string | null {
  const s = raw.replace(/[ -]/g, "").toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) {
    return isbn13Check(s.slice(0, 12)) === Number(s[12]) ? s : null;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
    sum += s[9] === "X" ? 10 : Number(s[9]);
    if (sum % 11 !== 0) return null;
    const body = "978" + s.slice(0, 9);
    return body + String(isbn13Check(body));
  }
  return null;
}

function validNewArxiv(yymm: string, suffix: string): boolean {
  const yy = Number(yymm.slice(0, 2));
  const mm = Number(yymm.slice(2));
  if (mm < 1 || mm > 12) return false;
  const n = yy * 100 + mm;
  if (n < 704) return false;
  return suffix.length === 4 ? n <= 1412 : n >= 1501;
}

function validOldArxiv(digits: string): boolean {
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  return mm >= 1 && mm <= 12 && (yy >= 91 || yy <= 7);
}

export function findIdentifiers(text: string): FoundIdentifiers {
  const dois: string[] = [];
  for (const m of text.matchAll(DOI_RE)) {
    const d = trimDoi(m[0]).toLowerCase();
    if (/^10\.\d{4,9}\/./.test(d)) dois.push(d);
  }

  // Blank out labels (keeping offsets) and remember where each one ends.
  const labelEnds: number[] = [];
  const isbnText = text.replace(ISBN_LABEL, (m, offset: number) => {
    labelEnds.push(offset + m.length);
    return " ".repeat(m.length);
  });
  const isbns: string[] = [];
  for (const m of isbnText.matchAll(ISBN_RE)) {
    const v = toIsbn13(m[0]);
    if (!v) continue;
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length === 10) {
      const idx = m.index ?? 0;
      const labelled = labelEnds.some(
        (e) => e <= idx && idx - e <= ISBN_LABEL_REACH && !/[\r\n]/.test(text.slice(e, idx)),
      );
      if (!labelled) continue;
    }
    if (v.startsWith("9790")) continue; // ISMN, not a book
    isbns.push(v);
  }

  const arxiv: string[] = [];
  for (const m of text.matchAll(ARXIV_NEW)) {
    if (validNewArxiv(m[1]!, m[2]!)) arxiv.push(m[0]);
  }
  for (const m of text.matchAll(ARXIV_OLD)) {
    if (validOldArxiv(m[1]!)) arxiv.push(m[0]);
  }

  return { dois: dedupe(dois), isbns: dedupe(isbns), arxiv: dedupe(arxiv) };
}
