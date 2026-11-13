/**
 * How text is split into words for search: one rule, used by the library's full-text index (which
 * builds its queries and bigrams from these) and by the reader's matching of a search hit's words
 * to annotations, so the two always agree.
 */

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
const CJK_ANY = new RegExp(`[${CJK}]`, "u");
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** Maximal runs of Han, Hiragana, Katakana and Hangul characters in `text`, in order. */
export function cjkRuns(text: string): string[] {
  return [...text.matchAll(CJK_RUN)].map((m) => m[0]);
}

/** The words of `text` outside its CJK runs: runs of letters, digits and marks; punctuation separates; a lone mark is dropped. */
export function latinWords(text: string): string[] {
  const rest = text.replace(CJK_RUN, " ");
  const out: string[] = [];
  for (const m of rest.matchAll(WORD)) if (/[\p{L}\p{N}]/u.test(m[0])) out.push(m[0]);
  return out;
}

/**
 * Space-separated character bigrams of every CJK run in `text` ("料理の" -> "料理 理の の"). The last
 * character of each run is also emitted alone so a single-character query can match it as a prefix.
 * unicode61 would index a whole run as one token, so these go in their own column.
 */
export function cjkBigrams(text: string): string {
  const out: string[] = [];
  for (const run of cjkRuns(text)) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    out.push(chars[chars.length - 1]!);
  }
  return out.join(" ");
}

/** True when `text` contains a CJK character. */
export function hasCjk(text: string): boolean {
  return CJK_ANY.test(text);
}
