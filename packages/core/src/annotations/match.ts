import type { Annotation } from "../model/annotation.js";

const CJK = /[⺀-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}぀-ヿ]/u;

/** Case, compatibility (NFKC) and diacritic folding. */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");

/**
 * The ids of the annotations whose quote and body together contain every word of `words` (a search
 * hit's words), keeping the order of `list`, which the caller has already sorted. A word with CJK
 * characters matches as a substring; any other word must equal a whole word of the text, after
 * folding case, compatibility forms and diacritics. No words match nothing.
 */
export function matchAnnotations(list: readonly Pick<Annotation, "id" | "quote" | "body">[], words: string): string[] {
  const wanted = fold(words).split(/\s+/).filter(Boolean);
  if (wanted.length === 0) return [];
  const ids: string[] = [];
  for (const a of list) {
    const text = fold(`${a.quote ?? ""} ${a.body ?? ""}`);
    const tokens = new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    if (wanted.every((w) => (CJK.test(w) ? text.includes(w) : tokens.has(w)))) ids.push(a.id);
  }
  return ids;
}
