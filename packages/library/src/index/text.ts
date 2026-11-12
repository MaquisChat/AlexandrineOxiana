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
 * CJK runs become a phrase of bigrams against `cjk_bigrams` (and `annotation_bigrams`). Returns
 * undefined when nothing searchable remains (the caller then runs a filter-only query). With scope
 * `record`, every term is limited to the source's own columns (annotations left out).
 */
export function buildMatchQuery(text: string, scope: "all" | "record" = "all"): string | undefined {
  const parts: string[] = [];
  // `all`: the record and its annotations; `record`: the record alone (to tell an annotation match).
  const cjk = scope === "all" ? "{cjk_bigrams annotation_bigrams}" : "cjk_bigrams";
  const latin = scope === "all" ? "" : `${RECORD_COLUMNS} : `;
  for (const m of text.matchAll(CJK_RUN)) {
    const chars = [...m[0]];
    if (chars.length === 1) parts.push(`${cjk} : "${chars[0]}"*`);
    else {
      const grams: string[] = [];
      for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!);
      parts.push(`${cjk} : "${grams.join(" ")}"`);
    }
  }
  const rest = text.replace(CJK_RUN, " ");
  for (const m of rest.matchAll(WORD)) if (/[\p{L}\p{N}]/u.test(m[0])) parts.push(`${latin}"${m[0]}"*`); // lone marks are dropped
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/** Per source, at most this much annotation text is indexed (R74 I4: 16 MB, the import's own cap). */
export const MAX_INDEXED_ANNOTATION_TEXT = 16 * 1024 * 1024;

/** The full-text columns of the source's own record (everything but its annotations). */
const RECORD_COLUMNS = "{title_all creators container extracted_text cjk_bigrams}";

/**
 * The indexed text of a source's annotations (Task 58, R74): each annotation's quoted text, then
 * its comment, one per line, in the order the source file keeps them, so a write and a rebuild
 * give the same text. At most `max` characters (the per-source cap of R74 I4): an annotation file
 * changed outside the app cannot make the index hold more.
 */
export function annotationText(list: ReadonlyArray<{ quote?: string | undefined; body?: string | undefined }>, max: number): string {
  const out: string[] = [];
  let len = 0;
  for (const a of list) {
    for (const t of [a.quote, a.body]) {
      if (!t) continue;
      const room = max - len - (out.length ? 1 : 0);
      if (room <= 0) return out.join("\n");
      // cut at the cap, never inside a surrogate pair
      const piece = t.length > room ? t.slice(0, room).replace(/[\uD800-\uDBFF]$/u, "") : t;
      out.push(piece);
      len += piece.length + (out.length > 1 ? 1 : 0);
    }
  }
  return out.join("\n");
}
