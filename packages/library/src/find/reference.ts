/**
 * A typed reference (Find and acquire, F2): one line such as `Bourdieu, Distinction` or
 * `"weak ties" Granovetter 1973`, split into what the confidence rule compares.
 *
 *  - `text`: the line as typed, with control characters, bidi controls and zero-width characters
 *    removed and spacing tidied (NFC). This, and nothing else, is what a search service receives.
 *  - `tokens`: `normalizeTitle` words (accents and ligatures folded, lower case, punctuation gone),
 *    after separators (commas, colons, slashes, dashes, brackets, quotes) became spaces. Words in
 *    scripts written without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) become character pairs,
 *    as `titleSimilarity` does; a single such character stays itself.
 *  - `year`: the first word that is a 4-digit year from 1000 to 2099.
 *  - `quoted`: the first phrase in double quotes (straight, curly or guillemets).
 */
import { normalizeTitle } from "@ao/core";
import { clean } from "../extract/names.js";

export type Reference = { text: string; tokens: string[]; year?: number; quoted?: string };

/** A word of a normalised text, or a run of characters of a script written without spaces. */
export type Segment = { word: string } | { chars: string[] };

export const REFERENCE_MIN_CHARS = 2;
export const REFERENCE_MAX_CHARS = 500;

/**
 * C1 controls, zero-width space, LRM/RLM, bidi embeddings, overrides and isolates, word joiner and
 * invisible operators, BOM. They change how text is shown without being seen (R113).
 */
const INVISIBLE = /[\u0080-\u009f​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/** Outside text made safe to keep and compare: invisible and control characters gone, spacing tidied, NFC. */
export function cleanText(s: string): string {
  return clean(s.replace(INVISIBLE, "")).normalize("NFC");
}

const NO_SPACE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const NO_SPACE_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+)/u;

/**
 * The words of `s` as the confidence rule compares them. Every character that is not a letter, a
 * number, a mark, an apostrophe or a full stop separates words; then `normalizeTitle` folds the
 * rest (so "Bourdieu's" is "bourdieus" and "U.S." is "us", on both sides of every comparison).
 */
export function segmentsOf(s: string): Segment[] {
  const spaced = cleanText(s)
    .replace(/[‘’ʻʼ]/gu, "'")
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\p{L}\p{N}\p{M}'.]+/gu, " ");
  const out: Segment[] = [];
  for (const word of normalizeTitle(spaced).split(" ")) {
    if (!word) continue;
    if (!NO_SPACE.test(word)) {
      out.push({ word });
      continue;
    }
    word.split(NO_SPACE_RUNS).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) out.push({ chars: Array.from(part) });
      else out.push({ word: part });
    });
  }
  return out;
}

/** The tokens of one segment: the word, or the character pairs of a run (a lone character stays itself). */
export function segmentTokens(seg: Segment): string[] {
  if ("word" in seg) return [seg.word];
  const c = seg.chars;
  if (c.length === 1) return [c[0]!];
  const out: string[] = [];
  for (let i = 0; i + 1 < c.length; i++) out.push(c[i]! + c[i + 1]!);
  return out;
}

/** The distinct tokens of `s`, in order of first appearance. */
export function tokensOf(s: string): string[] {
  return [...new Set(segmentsOf(s).flatMap(segmentTokens))];
}

const YEAR = /^(?:1\d{3}|20\d{2})$/u;
const QUOTED = /["“”„«»]([^"“”„«»]+)["“”„«»]/u;

/** A typed line as a Reference, or null when it is shorter than 2 or longer than 500 characters once tidied. */
export function parseReference(line: string): Reference | null {
  if (typeof line !== "string") return null;
  // A line far beyond the limit is refused before any work on it (500 characters are ≤ 1,000 UTF-16 units).
  if (line.length > REFERENCE_MAX_CHARS * 8) return null;
  const text = cleanText(line);
  const n = Array.from(text).length;
  if (n < REFERENCE_MIN_CHARS || n > REFERENCE_MAX_CHARS) return null;
  const segments = segmentsOf(text);
  const tokens = [...new Set(segments.flatMap(segmentTokens))];
  const yearWord = segments.find((s): s is { word: string } => "word" in s && YEAR.test(s.word));
  const q = QUOTED.exec(text)?.[1]?.trim();
  return { text, tokens, ...(yearWord ? { year: Number(yearWord.word) } : {}), ...(q ? { quoted: q } : {}) };
}
