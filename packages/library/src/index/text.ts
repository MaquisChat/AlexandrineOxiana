/** Text helpers for the full-text index: CJK bigrams and safe FTS5 query construction. */

import { cjkBigrams, cjkRuns, hasCjk, latinWords } from "@ao/core";

export { cjkBigrams, hasCjk };

/**
 * Turns user text into an FTS5 MATCH expression with no user-controlled syntax: every term is a
 * double-quoted string made only of letters, digits and marks (so quotes, `*`, `-`, `NEAR`,
 * `AND`, `:` etc. are plain text or dropped), terms are ANDed, and Latin terms match as prefixes.
 * CJK runs become a phrase of bigrams against the bigram column (`cjk_bigrams` in the record's
 * table, `annotation_bigrams` in the annotations' one). Returns undefined when nothing searchable
 * remains (the caller then runs a filter-only query).
 */
export function buildMatchQuery(text: string, bigramColumn: "cjk_bigrams" | "annotation_bigrams" = "cjk_bigrams"): string | undefined {
  const parts = matchTerms(text, bigramColumn);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

/**
 * The MATCH expression of each term of `text` (see buildMatchQuery): a Latin word as a prefix, a
 * CJK run as one phrase of bigrams. A query is matched term by term across a source's record and
 * its annotations (N1).
 */
export function matchTerms(text: string, bigramColumn: "cjk_bigrams" | "annotation_bigrams" = "cjk_bigrams"): string[] {
  const parts: string[] = [];
  const cjk = bigramColumn;
  for (const run of cjkRuns(text)) {
    const chars = [...run];
    if (chars.length === 1) parts.push(`${cjk} : "${chars[0]}"*`);
    else {
      const grams: string[] = [];
      for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!);
      parts.push(`${cjk} : "${grams.join(" ")}"`);
    }
  }
  for (const w of latinWords(text)) parts.push(`"${w}"*`);
  return parts;
}

/** Per source, at most this much annotation text (UTF-8) is indexed (R161 b). */
export const ANNOTATION_INDEX_BYTES = 2 * 1024 * 1024;
/** One indexed row of annotation text holds at most this much (UTF-8): the unit of work per statement. */
export const ANNOTATION_CHUNK_BYTES = 64 * 1024;
/** At most this many annotations of a source are indexed (R74 I4's count cap). */
export const MAX_INDEXED_ANNOTATIONS = 10_000;

/** The end of the longest run of `s` from `start` of at most `room` UTF-8 bytes that does not split a character; linear in `room`. */
function endUtf8(s: string, start: number, room: number): number {
  let bytes = 0;
  let i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + n > room) break;
    bytes += n;
    i += pair ? 2 : 1;
  }
  return i;
}

/** The start of the longest run of `s` ending at `end` of at most `room` UTF-8 bytes that does not split a character. */
function tailStart(s: string, end: number, room: number): number {
  let bytes = 0;
  let i = end;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    const pair = (c & 0xfc00) === 0xdc00 && i >= 2 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800;
    const n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + n > room) break;
    bytes += n;
    i -= pair ? 2 : 1;
  }
  return i;
}

/** Bytes a split annotation's next part repeats from the end of the part before (N1): a phrase across the split is still found. */
export const ANNOTATION_CHUNK_OVERLAP = 1024;

/**
 * The indexed text of a source's annotations (Task 58, R74, R161 b): each annotation (its quoted
 * text, then its comment, on separate lines), in the order the source file keeps them (so a write
 * and a rebuild give the same rows), packed into chunks of at most `chunkBytes`. An annotation
 * that fits a chunk is never split across two (N1); a longer one is split, never inside a
 * character, each part starting with the last `overlap` bytes of the part before, so a phrase
 * shorter than that is found across the split. At most `maxBytes` stored in all and `maxCount`
 * annotations; `partial` is true when any annotation text was left out.
 */
export function annotationChunks(
  list: ReadonlyArray<{ quote?: string | undefined; body?: string | undefined }>,
  maxBytes = ANNOTATION_INDEX_BYTES,
  chunkBytes = ANNOTATION_CHUNK_BYTES,
  maxCount = MAX_INDEXED_ANNOTATIONS,
  overlap = ANNOTATION_CHUNK_OVERLAP,
): { chunks: string[]; partial: boolean } {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  let total = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur.join("\n"));
    cur = [];
    curBytes = 0;
  };
  const done = (partial: boolean) => {
    flush();
    return { chunks, partial };
  };
  for (let n = 0; n < list.length; n++) {
    if (n >= maxCount) return done(list.slice(maxCount).some((x) => x.quote || x.body));
    const a = list[n]!;
    const unit = [a.quote, a.body].filter((t): t is string => !!t).join("\n");
    if (!unit) continue;
    const bytes = Buffer.byteLength(unit);
    const sep = cur.length ? 1 : 0;
    if (curBytes + sep + bytes <= chunkBytes) {
      // It fits the current chunk.
      if (total + sep + bytes > maxBytes) return done(true);
      cur.push(unit);
      curBytes += sep + bytes;
      total += sep + bytes;
      continue;
    }
    flush();
    if (bytes <= chunkBytes) {
      // It fits a chunk of its own.
      if (total + bytes > maxBytes) return done(true);
      cur.push(unit);
      curBytes = bytes;
      total += bytes;
      continue;
    }
    // Longer than a chunk: split, with overlap (by offsets into the text, never copying the rest).
    let start = 0;
    let prevEnd = 0;
    for (;;) {
      const end = endUtf8(unit, start, Math.min(chunkBytes, maxBytes - total));
      if (end <= prevEnd) return done(true); // no room for anything new
      const piece = unit.slice(start, end);
      chunks.push(piece);
      total += Buffer.byteLength(piece);
      if (end >= unit.length) break;
      prevEnd = end;
      start = tailStart(unit, end, Math.min(overlap, chunkBytes - 4));
    }
  }
  return done(false);
}
