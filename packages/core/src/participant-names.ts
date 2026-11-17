/**
 * One rule for "this text names this participant" (R88 I1, R378 a): used for citation and
 * bibliography text (`citation/csl-map.ts`) and for folder and file names (`naming.ts`
 * `pseudonymize`), so a name replaced in one is replaced in the other.
 *
 * - Folding: ł ø đ ß æ œ þ ı transliterated, NFKD (full-width and other compatibility forms
 *   become their plain letters), combining marks dropped, lowercase. "ＬＵＣÍＡ" = "Lucia" = "lucía".
 * - Words: runs of letters and digits; any other character separates them ("lucia_cocina",
 *   "lucia.cocina" and "Lucía Cocina" are the same two words). A name matches whole words only,
 *   so "Ann" is not found in "Annual".
 * - Scripts written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar; the
 *   `NO_SPACE_SCRIPT` that title verification uses): each of their characters is a word of its
 *   own, so a name of two or more such characters is found inside the run it is joined to
 *   ("王小明访谈录"), as `hasTokens` finds it in verification. A name of ONE such character is too
 *   short to be a name inside a run, so it matches only a run of its own.
 * - Word order: a name of two or more words also matches in any rotation ("Lopez, Maria",
 *   "Fernández Ruiz, Lucía") and fully reversed, and with its words joined ("marialopez",
 *   "lopezmaria"); any separator may stand between the words.
 * - Korean (R380): a Hangul name of two or more syllables also matches at the START of a run of
 *   Hangul, the rest of the run taken for a particle or honorific and kept ("김민수의" → "P-001의");
 *   for a name of several words, on its last word. Never in the middle or at the end of a run
 *   ("박김민수": a compound or another name, kept); a one-syllable name only as a run of its own.
 * - Limit: inflected forms in Latin script ("Marian", "Marias") are not matched (FR-657).
 * Platform-neutral: no node: imports.
 */
import { NO_SPACE_SCRIPT } from "./verify/evidence.js";

const IGNORABLE_ONE = /^\p{Default_Ignorable_Code_Point}$/u;
const isNoSpace = (ch: string | undefined): boolean => ch !== undefined && NO_SPACE_SCRIPT.test(ch);

/** Letters NFKD leaves whole, spelled the way names are commonly written without them (R89). */
const TRANSLIT: Readonly<Record<string, string>> = {
  ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", þ: "th", Þ: "TH", ı: "i",
};
/**
 * Characters Unicode marks "default ignorable" (R387 a): invisible when shown — the soft hyphen,
 * U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF, the Mongolian vowel separator, variation
 * selectors, the Hangul fillers. They fold to nothing, so a name with one inside it is one word
 * again. The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) go too: NFKD of a written syllable
 * never gives one, so the Korean rule (R380), which reads syllables from NFKD, never needs them,
 * and a filler typed inside a name ("김\u3164민수") must not split it.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
/**
 * Name comparison key: default-ignorable characters removed, ł ø đ ß æ œ þ ı transliterated, then
 * NFKD, combining marks removed, lowercase.
 */
export const fold = (s: string): string =>
  s
    .replace(IGNORABLE, "")
    .replace(/[łŁøØđĐßẞæÆœŒþÞı]/gu, (c) => TRANSLIT[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ς/gu, "σ"); // final sigma: the same letter, and a character folded alone cannot know it is final
/** The words of a name or text, folded ("@Lucía.Cocina" → ["lucia", "cocina"]). */
export const words = (s: string): string[] => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
/**
 * A name's comparison form: its folded words joined by single spaces (no "@", no punctuation). Words
 * of a script written without spaces are joined without one ("山田 太郎" = "山田太郎"): a space there
 * is not part of the name.
 */
export const normName = (s: string): string =>
  words(s).reduce((acc, w) => (acc === "" ? w : acc + (isNoSpace(acc.at(-1)) && isNoSpace(w[0]) ? "" : " ") + w), "");

/** A name to look for: its folded words, the code that replaces it; `bare`: a lone given or family name. */
export interface NameForm {
  words: string[];
  code: string;
  bare: boolean;
  /** Not the name as written but another order or the words joined (an exact form wins over it). */
  variant?: boolean;
}

/**
 * The forms of one name (R387 b): the ONE place a map entry becomes the forms the matcher looks
 * for, used by citations (csl-map.ts) and folder names (naming.ts) alike. The name as written, then
 * for a name of two or more words every rotation ("Family, Given": "Lopez, Maria", "Fernández Ruiz,
 * Lucía") and the full reverse, and each order with its words joined ("marialopez"). Rotations are
 * made from the words as written ("山田 太郎" gives "太郎山田"), before words of a no-space script
 * are joined into one run.
 */
export function nameForms(name: string, code: string, bare = false): NameForm[] {
  const ws = words(name);
  if (ws.length === 0) return [];
  const out: NameForm[] = [{ words: ws, code, bare }];
  if (ws.length === 1) return out;
  const orders: string[][] = [ws];
  for (let k = 1; k < ws.length; k++) orders.push([...ws.slice(k), ...ws.slice(0, k)]);
  orders.push([...ws].reverse());
  orders.forEach((o, i) => {
    if (i > 0) out.push({ words: o, code, bare, variant: true });
    // A name written as one word ("marialopez", "MariaLopez") is the same name (R89).
    out.push({ words: [o.join("")], code, bare, variant: true });
  });
  return out;
}

export interface ScrubOptions {
  /**
   * A bare single-word form shorter than this is not used ("Li" alone is kept, "Rose Li" is not).
   * 0 uses every form.
   */
  bareMinLength?: number;
  /** Split a run of letters and digits where letters meet digits (addresses: "lucia2024"). */
  splitDigits?: boolean;
}

const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;

/** The units a folded word is matched by: each no-space-script character alone, other runs whole. */
function units(word: string, splitDigits: boolean): string[] {
  const out: string[] = [];
  let run = "";
  let prevDigit: boolean | undefined;
  for (const ch of word) {
    if (isNoSpace(ch)) {
      if (run) out.push(run);
      run = "";
      prevDigit = undefined;
      out.push(ch);
      continue;
    }
    const digit = DIGIT.test(ch);
    if (splitDigits && run && prevDigit !== undefined && digit !== prevDigit) {
      out.push(run);
      run = "";
    }
    run += ch;
    prevDigit = digit;
  }
  if (run) out.push(run);
  return out;
}

interface Token {
  /** Folded text of the unit. */
  w: string;
  /** Span in the original text (UTF-16 indices, end exclusive). */
  start: number;
  end: number;
  /** Another no-space-script character touches it on the left / right (no separator between). */
  gluedLeft: boolean;
  gluedRight: boolean;
}

const foldCache = new Map<string, string>();
function foldChar(cp: string): string {
  let f = foldCache.get(cp);
  if (f === undefined) {
    f = fold(cp);
    if (foldCache.size < 65_536) foldCache.set(cp, f);
  }
  return f;
}

/**
 * The text's word units, folded, with their spans in the original text. Folding is done one code
 * point at a time so that every folded character points back to the original it came from; a
 * combining mark folds to nothing and is taken into the span of the letter before it.
 */
function tokenize(text: string, splitDigits: boolean): Token[] {
  const tokens: Token[] = [];
  let cur: { w: string; start: number; end: number; digit: boolean } | undefined;
  let prevNoSpaceEnd = -1; // end index (original) of the last no-space unit, when nothing came between
  const flush = () => {
    if (cur) tokens.push({ w: cur.w, start: cur.start, end: cur.end, gluedLeft: false, gluedRight: false });
    cur = undefined;
  };
  let i = 0;
  while (i < text.length) {
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    const next = i + cp.length;
    const f = foldChar(cp);
    if (f === "") {
      // A combining mark (or another character that folds away): part of whatever it follows.
      if (cur) cur.end = next;
      else if (tokens.length && tokens[tokens.length - 1]!.end === i) tokens[tokens.length - 1]!.end = next;
      if (prevNoSpaceEnd === i) prevNoSpaceEnd = next;
      i = next;
      continue;
    }
    for (const ch of f) {
      if (isNoSpace(ch)) {
        flush();
        const glued = prevNoSpaceEnd === i;
        if (glued) tokens[tokens.length - 1]!.gluedRight = true;
        tokens.push({ w: ch, start: i, end: next, gluedLeft: glued, gluedRight: false });
        prevNoSpaceEnd = next;
      } else if (WORD.test(ch)) {
        const digit = DIGIT.test(ch);
        if (cur && splitDigits && digit !== cur.digit) flush();
        if (cur) {
          cur.w += ch;
          cur.end = next;
          cur.digit = digit;
        } else cur = { w: ch, start: i, end: next, digit };
        prevNoSpaceEnd = -1;
      } else {
        flush();
        prevNoSpaceEnd = -1;
      }
    }
    i = next;
  }
  flush();
  return tokens;
}

interface Pattern {
  units: string[];
  code: string;
  /** One no-space-script character: matched only as a run of its own. */
  single: boolean;
  /** A Hangul name of two or more syllables: its last word may begin a longer run of Hangul (R380). */
  prefix: boolean;
}

/** A Hangul leading consonant (choseong) as NFKD gives it: where a folded syllable begins. */
const CHOSEONG = /[\u1100-\u115F\uA960-\uA97F]/u;
const ALL_HANGUL = /^\p{Script=Hangul}+$/u;
const syllables = (s: string): number => (s.match(/[\u1100-\u115F\uA960-\uA97F]/gu) ?? []).length;

/**
 * Korean (R380): `u`, the folded last word of a Hangul name, begins the token `w` and the rest of
 * the run is Hangul starting on a new syllable: the rest is taken for a particle or honorific
 * ("김민수의", "김민수씨와의"). Never in the middle or at the end of a run.
 */
const hangulPrefixOf = (w: string, u: string): boolean => {
  if (w.length <= u.length || !w.startsWith(u)) return false;
  const rest = w.slice(u.length);
  return CHOSEONG.test(rest[0]!) && ALL_HANGUL.test(rest);
};

interface Index {
  /** Patterns by first unit, longest first. */
  byFirst: Map<string, Pattern[]>;
  /** One-unit Hangul patterns that may begin a longer run, by that unit. */
  prefixes: Map<string, Pattern[]>;
  /** The longest unit in `prefixes` (bounds the prefixes tried per token). */
  maxPrefix: number;
}

/** Every form's pattern (its units), indexed by first unit, longest first. */
function patterns(forms: readonly NameForm[], opts: ScrubOptions): Index {
  const min = opts.bareMinLength ?? 0;
  const split = opts.splitDigits ?? false;
  const index = new Map<string, Pattern[]>();
  const prefixes = new Map<string, Pattern[]>();
  let maxPrefix = 0;
  const seen = new Set<string>();
  const add = (ws: readonly string[], code: string) => {
    const us = ws.flatMap((w) => units(w, split));
    if (us.length === 0) return;
    const key = us.join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const single = us.length === 1 && [...us[0]!].length === 1 && isNoSpace(us[0]);
    // A Hangul name of one syllable stays whole-run only, like a one-character no-space name.
    const last = us[us.length - 1]!;
    const prefix = ALL_HANGUL.test(last) && syllables(us.join("")) >= 2;
    const pat: Pattern = { units: us, code, single, prefix };
    const list = index.get(us[0]!) ?? [];
    list.push(pat);
    index.set(us[0]!, list);
    if (prefix && us.length === 1) {
      const pl = prefixes.get(last) ?? [];
      pl.push(pat);
      prefixes.set(last, pl);
      maxPrefix = Math.max(maxPrefix, last.length);
    }
  };
  for (const f of forms) {
    const ws = f.words.filter(Boolean);
    if (ws.length === 0) continue;
    if (f.bare && ws.length === 1 && [...ws[0]!].length < min) continue;
    add(ws, f.code);
  }
  for (const list of index.values()) list.sort((a, b) => b.units.length - a.units.length);
  return { byFirst: index, prefixes, maxPrefix };
}

/** The original-text index where the first `n` folded characters of a token starting at `start` end. */
function origEnd(text: string, start: number, n: number): number {
  let i = start;
  let got = 0;
  while (i < text.length && got < n) {
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    got += foldChar(cp).length;
    i += cp.length;
  }
  // Marks folded away belong to the letter before them.
  while (i < text.length) {
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    if (foldChar(cp) !== "") break;
    i += cp.length;
  }
  return i;
}

interface Hit {
  start: number;
  end: number;
  code: string;
}

/** A bidi override (LRO, RLO) and where its effect ends (PDF, a new line, the end of the text). */
const OVERRIDE = /[\u202D\u202E]([^\u202C\n\r]*)/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Text inside a bidi override is shown in the order the override forces, so "\u202EairaM" shows as
 * "Maria" (R387 a). Each override's content is also read reversed (by grapheme), and a name found
 * there is replaced over the original characters it covers. Reversing a region whose content was
 * already in reading order only yields text that is not a name, or that is one reversed (the safe side).
 */
function overrideHits(text: string, find: (t: string) => Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(OVERRIDE)) {
    const base = m.index + 1;
    const segs = [...graphemes.segment(m[1]!)].reverse();
    let rev = "";
    const starts: number[] = []; // per reversed grapheme: [start in rev, original start, original end]
    const origS: number[] = [];
    const origE: number[] = [];
    for (const g of segs) {
      starts.push(rev.length);
      origS.push(base + g.index);
      origE.push(base + g.index + g.segment.length);
      rev += g.segment;
    }
    const at = (i: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= i) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    for (const h of find(rev)) {
      const a = at(h.start);
      const b = at(h.end - 1);
      out.push({ start: Math.min(origS[a]!, origS[b]!), end: Math.max(origE[a]!, origE[b]!), code: h.code });
    }
  }
  return out;
}

/** Hits of `extra` that overlap none of `hits`, merged in, left to right. */
function mergeHits(hits: Hit[], extra: Hit[]): Hit[] {
  if (extra.length === 0) return hits;
  const all = [...hits];
  for (const e of extra) if (!all.some((h) => h.start < e.end && e.start < h.end)) all.push(e);
  return all.sort((x, y) => x.start - y.start);
}

/** The non-overlapping matches, left to right, longest first at each position. Linear in the text. */
function findAll(text: string, forms: readonly NameForm[], opts: ScrubOptions, firstOnly: boolean): Hit[] {
  const hits = findPlain(text, forms, opts, firstOnly);
  if ((firstOnly && hits.length) || !/[\u202D\u202E]/u.test(text)) return hits;
  return mergeHits(hits, overrideHits(text, (t) => findPlain(t, forms, opts, firstOnly)));
}

function findPlain(text: string, forms: readonly NameForm[], opts: ScrubOptions, firstOnly: boolean): Hit[] {
  if (forms.length === 0) return [];
  const { byFirst, prefixes, maxPrefix } = patterns(forms, opts);
  if (byFirst.size === 0) return [];
  const tokens = tokenize(text, opts.splitDigits ?? false);
  const hits: Hit[] = [];
  /** The end of `p` matched at token `i` (exactly, or its last word beginning a Hangul run), or -1. */
  const matchEnd = (p: Pattern, i: number): number => {
    // A single no-space-script character is a name only when it stands alone.
    if (p.single && (tokens[i]!.gluedLeft || tokens[i]!.gluedRight)) return -1;
    const lastK = p.units.length - 1;
    for (let k = 0; k < lastK; k++) if (tokens[i + k]?.w !== p.units[k]) return -1;
    const t = tokens[i + lastK];
    if (!t) return -1;
    const u = p.units[lastK]!;
    if (t.w === u) return t.end;
    return p.prefix && hangulPrefixOf(t.w, u) ? origEnd(text, t.start, u.length) : -1;
  };
  for (let i = 0; i < tokens.length; ) {
    const w = tokens[i]!.w;
    let hit: Pattern | undefined;
    let end = -1;
    for (const p of byFirst.get(w) ?? []) {
      end = matchEnd(p, i);
      if (end >= 0) {
        hit = p;
        break;
      }
    }
    // A one-word Hangul name at the start of a longer run: the prefixes of the token that end on a
    // syllable boundary, longest first, no longer than the longest such name (linear in the text).
    if (!hit && maxPrefix > 0 && CHOSEONG.test(w[0] ?? "")) {
      for (let n = Math.min(w.length - 1, maxPrefix); n > 0 && !hit; n--) {
        if (!CHOSEONG.test(w[n]!)) continue;
        for (const p of prefixes.get(w.slice(0, n)) ?? []) {
          end = matchEnd(p, i);
          if (end >= 0) {
            hit = p;
            break;
          }
        }
      }
    }
    if (!hit) {
      i++;
      continue;
    }
    hits.push({ start: tokens[i]!.start, end, code: hit.code });
    if (firstOnly) break;
    i += hit.units.length;
  }
  return hits;
}

/**
 * Replaces every participant name form in `text` by its code (the rule above). An "@" in front of a
 * name goes with it. Longer forms win.
 */
export function scrubNames(text: string, forms: readonly NameForm[], opts: ScrubOptions = {}): string {
  const hits = findAll(text, forms, opts, false);
  if (hits.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const h of hits) {
    let start = h.start;
    // An "@" in front goes with the name, and so do invisible characters around it (a bidi isolate).
    while (start > pos && (text[start - 1] === "@" || IGNORABLE_ONE.test(text[start - 1]!))) start--;
    out += text.slice(pos, start) + h.code;
    pos = h.end;
  }
  return out + text.slice(pos);
}

/** Whether `text` names any of the forms (the rule above). */
export function namesAny(text: string, forms: readonly NameForm[], opts: ScrubOptions = {}): boolean {
  return findAll(text, forms, opts, true).length > 0;
}

/** Percent-escapes decoded where they are valid UTF-8; a malformed one is left as written. */
function safeDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // Decode the ASCII escapes of a malformed run one by one; leave the rest as written.
      return run.replace(/%([0-7][0-9A-Fa-f])/gu, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  });
}

/**
 * Whether an address names any of the forms: decoded safely (a malformed escape never throws; up to
 * three times, for an address encoded more than once), "+" read as a space, then matched by the rule
 * above, so every separator is alike (space, "+", "-", ".", "_", "/", none) in either word order.
 * No length floor: every form counts. Letters and digits are split ("lopezmaria2024").
 */
export function urlNamesAny(url: string, forms: readonly NameForm[]): boolean {
  let u = url;
  for (let k = 0; k < 3; k++) {
    const d = safeDecode(u);
    if (d === u) break;
    u = d;
  }
  return namesAny(u.replace(/\+/gu, " "), forms, { splitDigits: true });
}
