/** Identifier detection in free text. Pure and platform-neutral. */

export type FoundIdentifiers = { dois: string[]; isbns: string[]; arxiv: string[] };

const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/g;
const DOI_TRAILING = /[)\]}.,;:!?'’”]+$/u;

// Separators between digits are a single space or hyphen. Candidates may not be glued to other digits.
const ISBN_RE =
  /(?<!\d[ -]?)(?:97[89](?:[ -]?\d){10}|\d(?:[ -]?\d){8}[ -]?[\dXx])(?![ -]?[\dXx])/g;
const ISBN_PREFIX = /ISBN(?:-1[03])?\s*:?/gi;

const ARXIV_NEW = /(?<![\w/.-])\d{4}\.\d{4,5}(?:v\d+)?(?![\w.]*\d)/g;
const ARXIV_OLD = /(?<![\w/-])[a-z]+(?:-[a-z]+)*\/\d{7}(?!\d)/g;

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

export function findIdentifiers(text: string): FoundIdentifiers {
  const dois: string[] = [];
  for (const m of text.matchAll(DOI_RE)) {
    const d = m[0].replace(DOI_TRAILING, "").toLowerCase();
    if (/^10\.\d{4,9}\/./.test(d)) dois.push(d);
  }

  const isbns: string[] = [];
  const isbnText = text.replace(ISBN_PREFIX, " ");
  for (const m of isbnText.matchAll(ISBN_RE)) {
    const v = toIsbn13(m[0]);
    if (v) isbns.push(v);
  }

  const arxiv: string[] = [];
  for (const m of text.matchAll(ARXIV_NEW)) arxiv.push(m[0]);
  for (const m of text.matchAll(ARXIV_OLD)) arxiv.push(m[0]);

  return { dois: dedupe(dois), isbns: dedupe(isbns), arxiv: dedupe(arxiv) };
}
