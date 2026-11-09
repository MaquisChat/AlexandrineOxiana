/** Text helpers for the full-text index: CJK bigrams and safe FTS5 query construction. */

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Space-separated character bigrams of every CJK run in `text` ("料理の" -> "料理 理の の"). The last
 * character of each run is also emitted alone so a single-character query can match it as a prefix.
 * unicode61 would index a whole run as one token, so these go in their own column.
 */
export function cjkBigrams(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(CJK_RUN)) {
    const chars = [...m[0]];
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    out.push(chars[chars.length - 1]!);
  }
  return out.join(" ");
}

/** True when `text` contains a CJK character. */
export function hasCjk(text: string): boolean {
  return new RegExp(`[${CJK}]`, "u").test(text);
}

/**
 * Turns user text into an FTS5 MATCH expression with no user-controlled syntax: every term is a
 * double-quoted string made only of letters, digits and marks (so quotes, `*`, `-`, `NEAR`,
 * `AND`, `:` etc. are plain text or dropped), terms are ANDed, and Latin terms match as prefixes.
 * CJK runs become a phrase of bigrams against `cjk_bigrams`. Returns undefined when nothing
 * searchable remains (the caller then runs a filter-only query).
 */
export function buildMatchQuery(text: string): string | undefined {
  const parts: string[] = [];
  for (const m of text.matchAll(CJK_RUN)) {
    const chars = [...m[0]];
    if (chars.length === 1) parts.push(`cjk_bigrams : "${chars[0]}"*`);
    else {
      const grams: string[] = [];
      for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!);
      parts.push(`cjk_bigrams : "${grams.join(" ")}"`);
    }
  }
  const rest = text.replace(CJK_RUN, " ");
  for (const m of rest.matchAll(WORD)) parts.push(`"${m[0]}"*`);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}
