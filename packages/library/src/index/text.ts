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
 * CJK runs become a phrase of bigrams against the bigram column (`cjk_bigrams` in the record's
 * table, `annotation_bigrams` in the annotations' one). Returns undefined when nothing searchable
 * remains (the caller then runs a filter-only query).
 */
export function buildMatchQuery(text: string, bigramColumn: "cjk_bigrams" | "annotation_bigrams" = "cjk_bigrams"): string | undefined {
  const parts: string[] = [];
  const cjk = bigramColumn;
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
  for (const m of rest.matchAll(WORD)) if (/[\p{L}\p{N}]/u.test(m[0])) parts.push(`"${m[0]}"*`); // lone marks are dropped
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/** Per source, at most this much annotation text (UTF-8) is indexed (R161 b). */
export const ANNOTATION_INDEX_BYTES = 2 * 1024 * 1024;
/** One indexed row of annotation text holds at most this much (UTF-8): the unit of work per statement. */
export const ANNOTATION_CHUNK_BYTES = 64 * 1024;
/** At most this many annotations of a source are indexed (R74 I4's count cap). */
export const MAX_INDEXED_ANNOTATIONS = 10_000;

/** The longest prefix of `s` of at most `room` UTF-8 bytes that does not split a character; linear in `room`. */
function cutUtf8(s: string, room: number): [string, string] {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + n > room) break;
    bytes += n;
    i += pair ? 2 : 1;
  }
  return [s.slice(0, i), s.slice(i)];
}

/**
 * The indexed text of a source's annotations (Task 58, R74, R161 b): each annotation's quoted text,
 * then its comment, one per line, in the order the source file keeps them (so a write and a
 * rebuild give the same rows), cut into chunks of at most `chunkBytes` (whole annotations where
 * they fit; a longer one is split, never inside a character). At most `maxBytes` in all and
 * `maxCount` annotations; `partial` is true when any annotation text was left out.
 */
export function annotationChunks(
  list: ReadonlyArray<{ quote?: string | undefined; body?: string | undefined }>,
  maxBytes = ANNOTATION_INDEX_BYTES,
  chunkBytes = ANNOTATION_CHUNK_BYTES,
  maxCount = MAX_INDEXED_ANNOTATIONS,
): { chunks: string[]; partial: boolean } {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  let total = 0;
  let partial = false;
  const flush = () => {
    if (cur.length) chunks.push(cur.join("\n"));
    cur = [];
    curBytes = 0;
  };
  let n = 0;
  outer: for (const a of list) {
    if (n >= maxCount) {
      partial = list.slice(maxCount).some((x) => x.quote || x.body);
      break;
    }
    n++;
    for (const t of [a.quote, a.body]) {
      let rest = t ?? "";
      while (rest) {
        const sep = cur.length ? 1 : 0;
        const roomTotal = maxBytes - total - sep;
        const roomChunk = chunkBytes - curBytes - sep;
        const [piece, remainder] = cutUtf8(rest, Math.min(roomTotal, roomChunk));
        if (!piece) {
          if (cur.length && roomChunk < roomTotal) {
            flush(); // the chunk is full: go on in the next one
            continue;
          }
          partial = true; // the total is reached
          break outer;
        }
        const b = Buffer.byteLength(piece) + sep;
        cur.push(piece);
        curBytes += b;
        total += b;
        rest = remainder;
      }
    }
  }
  flush();
  return { chunks, partial };
}
