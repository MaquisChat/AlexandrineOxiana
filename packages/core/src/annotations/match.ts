import type { Annotation } from "../model/annotation.js";
import { cjkRuns, latinWords } from "./words.js";

/** Compatibility (NFKC) normalisation, invisible format characters (soft hyphen, zero-width, direction marks) removed. */
const normalise = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "");

/** Full case folding of the common cases, then diacritics removed; applied to words outside CJK runs only, so kana and Hangul are never altered. */
const foldWord = (w: string) => w.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}+/gu, "");

interface Terms {
  words: string[];
  runs: string[];
}
function terms(text: string): Terms {
  return { words: latinWords(text).map(foldWord).filter(Boolean), runs: cjkRuns(text) };
}

/**
 * The ids of the annotations whose quote and body together contain every term of `words` (a search
 * hit's words), keeping the order of `list` (the caller sorts first, with `sortAnnotations`). Words
 * are split as the search index splits them (`words.ts`): punctuation separates words; a query word
 * matches the beginning of a word of the text (prefix, as the index does); a run of Chinese,
 * Japanese or Korean characters matches inside a run of the text. Case, compatibility forms and
 * diacritics are folded for words; a hyphen at a line end is joined. No terms match nothing.
 */
export function matchAnnotations(list: readonly Pick<Annotation, "id" | "quote" | "body">[], words: string): string[] {
  const q = terms(normalise(words));
  if (q.words.length === 0 && q.runs.length === 0) return [];
  const ids: string[] = [];
  for (const a of list) {
    const text = normalise(`${a.quote ?? ""}\n${a.body ?? ""}`).replace(/(\p{L})[-‐]\s*\n\s*(\p{L})/gu, "$1$2");
    const t = terms(text);
    if (
      q.runs.every((r) => t.runs.some((tr) => tr.includes(r))) &&
      q.words.every((w) => t.words.some((tw) => tw.startsWith(w)))
    )
      ids.push(a.id);
  }
  return ids;
}
