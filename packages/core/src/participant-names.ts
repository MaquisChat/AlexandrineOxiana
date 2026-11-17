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
 * - A lone given or family name (R88, R387 c): in citations it is used alone only from two
 *   characters in a no-space script, two syllables in Hangul, four letters otherwise ("Li" alone is
 *   kept, so ordinary words are not blanked). Folder names have the stricter rule: a lone name of
 *   any length is replaced there, as before (the folder stays on disk in the clear and errs toward
 *   the code). That is the one ruled difference between the two.
 * - Partial names (R387 e): for a name of three to ten words, every run of two or more of its words
 *   in order is the name too ("Lucía Fernández" of "Lucía Fernández Ruiz"), unless the run is made
 *   only of words too short to stand alone ("de la"); each word of a creator's family name of
 *   several words counts as a lone family name.
 * - Limits: inflected forms in Latin script ("Marian", "Marias") are not matched (FR-657); nor
 *   initials ("M. Lopez", "Lopez M."), a middle name present in the text but not in the record
 *   ("Maria Isabel Lopez" against "Maria Lopez"), a part dropped from the middle ("Siti Ahmad" of
 *   "Siti binti Ahmad"), an order that is neither a rotation nor the reverse ("Lucía Ruiz
 *   Fernández"), or runs of a name of more than ten words.
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
 * NFKD, combining marks and tatweel removed, katakana read as hiragana, lowercase.
 */
export const fold = (s: string): string =>
  s
    .replace(IGNORABLE, "")
    .replace(/[łŁøØđĐßẞæÆœŒþÞı]/gu, (c) => TRANSLIT[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    // Arabic tatweel (kashida) only stretches a word (R387 M5).
    .replace(/\u0640/gu, "")
    // Katakana and hiragana spell the same sounds: one script for names (R387 M5).
    .replace(/[\u30A1-\u30F6]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase()
    .replace(/ς/gu, "σ"); // final sigma: the same letter, and a character folded alone cannot know it is final
/** The words of a name or text, folded ("@Lucía.Cocina" → ["lucia", "cocina"]). */
export const words = (s: string): string[] => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
const HANGUL = /\p{Script=Hangul}/u;
const joinsWithout = (a: string | undefined, b: string | undefined): boolean =>
  (isNoSpace(a) && isNoSpace(b)) || (a !== undefined && b !== undefined && HANGUL.test(a) && HANGUL.test(b));
/**
 * A name's comparison form: its folded words joined by single spaces (no "@", no punctuation). Words
 * of a script written without spaces are joined without one ("山田 太郎" = "山田太郎"): a space there
 * is not part of the name. So are Hangul words (R387 M6: "김 민수" = "김민수", a family and a given
 * name written apart or together).
 */
export const normName = (s: string): string =>
  words(s).reduce((acc, w) => (acc === "" ? w : acc + (joinsWithout(acc.at(-1), w[0]) ? "" : " ") + w), "");

/** A name to look for: its folded words, the code that replaces it; `bare`: a lone given or family name. */
export interface NameForm {
  words: string[];
  code: string;
  bare: boolean;
  /** Not the name as written but another order or the words joined (an exact form wins over it). */
  variant?: boolean;
}

/** The longest name whose runs of words are made into forms (R387 e); longer names get none. */
const MAX_RUN_WORDS = 10;
/** The Latin-script floor of R88 (4 letters), used to tell a run of particles from a name. */
const LATIN_FLOOR = 4;

/** `ws` in every rotation and reversed, each order also with its words joined. */
function ordersOf(ws: readonly string[], code: string, bare: boolean, variant: boolean, join = true): NameForm[] {
  const out: NameForm[] = [{ words: [...ws], code, bare, ...(variant ? { variant } : {}) }];
  if (ws.length === 1) return out;
  const orders: string[][] = [[...ws]];
  for (let k = 1; k < ws.length; k++) orders.push([...ws.slice(k), ...ws.slice(0, k)]);
  if (ws.length > 2) orders.push([...ws].reverse()); // of two words, the reverse is the rotation
  orders.forEach((o, i) => {
    if (i > 0) out.push({ words: o, code, bare, variant: true });
    // A name written as one word ("marialopez", "MariaLopez") is the same name (R89).
    if (join) out.push({ words: [o.join("")], code, bare, variant: true });
  });
  return out;
}

/**
 * The forms of one name (R387 b): the ONE place a map entry or a creator's name becomes the forms
 * the matcher looks for, used by citations (csl-map.ts) and folder names (naming.ts) alike.
 * - The name as written; for a name of two or more words every rotation ("Family, Given":
 *   "Lopez, Maria", "Fernández Ruiz, Lucía") and the full reverse, and each order with its words
 *   joined ("marialopez"). Rotations are made from the words as written ("山田 太郎" gives
 *   "太郎山田"), before words of a no-space script are joined into one run.
 * - A name of three to ten words (R387 e): every run of two or more of its words in order is a form
 *   too, with the same rotations and joins ("Lucía Fernández" and "Fernández Ruiz" of "Lucía
 *   Fernández Ruiz"), unless every word of the run is shorter than a lone name may be (R88's floor
 *   by script): "de la" of "Juan de la Cruz" is not a name.
 * - A creator (`{ given, family, literal, handle }`): the forms of each of `creatorNameTexts`.
 */
export function nameForms(name: string | CreatorName, code: string, bare = false): NameForm[] {
  if (typeof name !== "string") return creatorNameTexts(name).flatMap((t) => nameForms(t.text, code, t.bare));
  const ws = words(name);
  if (ws.length === 0) return [];
  const out = ordersOf(ws, code, bare, false);
  // A Hangul name written together is the same name written apart at any syllable (R387 M6:
  // "김민수" = "김 민수" = "민수 김").
  if (ws.length === 1 && !bare && ALL_HANGUL.test(ws[0]!)) {
    const w = ws[0]!;
    for (let k = 1; k < w.length; k++) if (CHOSEONG.test(w[k]!)) out.push(...ordersOf([w.slice(0, k), w.slice(k)], code, bare, true, false));
  }
  if (ws.length >= 3 && ws.length <= MAX_RUN_WORDS) {
    for (let len = ws.length - 1; len >= 2; len--) {
      for (let at = 0; at + len <= ws.length; at++) {
        const run = ws.slice(at, at + len);
        if (run.some((w) => standsAlone(w, LATIN_FLOOR))) out.push(...ordersOf(run, code, bare, true));
      }
    }
  }
  return out;
}

/** A creator's name parts (the fields of a source's creator that may name a person). */
export interface CreatorName {
  handle?: string;
  literal?: string;
  given?: string;
  family?: string;
}

/**
 * The texts a creator's name may appear as (R387 d, e), each marked `bare` when it is a lone given
 * or family name: the handle, the literal, "given family", the family name, each word of a family
 * name of several words ("Fernández" and "Ruiz" of "Fernández Ruiz"), the given name. Folder names
 * (through the library's list of participant names) and citations use the same texts.
 */
export function creatorNameTexts(c: CreatorName): Array<{ text: string; bare: boolean }> {
  const out: Array<{ text: string; bare: boolean }> = [];
  const add = (t: string | undefined, bare = false) => {
    if (t?.trim()) out.push({ text: t.trim(), bare });
  };
  add(c.handle);
  add(c.literal);
  if (c.given?.trim() && c.family?.trim()) add(`${c.given.trim()} ${c.family.trim()}`);
  add(c.family, true);
  const fam = words(c.family ?? "");
  if (fam.length > 1) for (const w of fam) add(w, true);
  add(c.given, true);
  return out;
}

export interface ScrubOptions {
  /**
   * R88's floor (citations): a bare single-word form in a script written with spaces shorter than
   * this is not used ("Li" alone is kept, "Rose Li" is not); a no-space-script one needs two
   * characters, a Hangul one two syllables. 0 (folder names) uses every form.
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

/**
 * R88's floor for a lone given or family name, by script (R387 c): two characters in a script
 * written without spaces ("小明", "太郎"), two syllables in Hangul ("민수"), else `min` letters
 * ("Rose"; "Li" alone is kept).
 */
function standsAlone(w: string, min: number): boolean {
  const cps = [...w];
  if (cps.some(isNoSpace)) return cps.length >= 2;
  if (ALL_HANGUL.test(w)) return syllables(w) >= 2;
  return cps.length >= min;
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
  // Every name's exact form before any variant (R387 M1): a name's own form wins over another
  // name's rotation or joined form, whatever the order of the map.
  for (const pass of [false, true]) {
    for (const f of forms) {
      if ((f.variant ?? false) !== pass) continue;
      const ws = f.words.filter(Boolean);
      if (ws.length === 0) continue;
      if (min > 0 && f.bare && !f.variant && ws.length === 1 && !standsAlone(ws[0]!, min)) continue;
      add(ws, f.code);
    }
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

/**
 * The names to look for: a name map (name or handle → code; its forms are made by `nameForms` and
 * indexed once per map, R387 M2) and/or forms made by the caller (a source's creators). On the same
 * length, the map's forms win.
 */
export interface NameSet {
  map?: ReadonlyMap<string, string>;
  forms?: readonly NameForm[];
}
export type Names = readonly NameForm[] | NameSet;

interface MapCache {
  /** The entries the cache was built from: a map changed since is read afresh (never stale). */
  entries: Array<[string, string]>;
  forms: NameForm[];
  indexes: Map<string, Index>;
  keys?: Map<string, string>;
}
const mapCache = new WeakMap<ReadonlyMap<string, string>, MapCache>();
function cacheOf(map: ReadonlyMap<string, string>): MapCache {
  let c = mapCache.get(map);
  if (c && c.entries.length === map.size) {
    let i = 0;
    for (const [k, v] of map) {
      const e = c.entries[i++]!;
      if (e[0] !== k || e[1] !== v) {
        c = undefined;
        break;
      }
    }
  } else c = undefined;
  if (!c) {
    const entries = [...map];
    c = { entries, forms: entries.flatMap(([n, code]) => nameForms(n, code)), indexes: new Map() };
    mapCache.set(map, c);
  }
  return c;
}

/** A name map's comparison keys (normName → code, the first entry of a key wins), built once per map. */
export function mapKeys(map: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const c = cacheOf(map);
  if (!c.keys) {
    c.keys = new Map();
    for (const [k, code] of c.entries) {
      const n = normName(k);
      if (n && !c.keys.has(n)) c.keys.set(n, code);
    }
  }
  return c.keys;
}

function indexesOf(names: Names, opts: ScrubOptions): Index[] {
  const set: NameSet = Array.isArray(names) ? { forms: names as readonly NameForm[] } : (names as NameSet);
  const out: Index[] = [];
  if (set.map && set.map.size) {
    const c = cacheOf(set.map);
    const key = `${opts.bareMinLength ?? 0}|${opts.splitDigits ? 1 : 0}`;
    let ix = c.indexes.get(key);
    if (!ix) c.indexes.set(key, (ix = patterns(c.forms, opts)));
    out.push(ix);
  }
  if (set.forms && set.forms.length) out.push(patterns(set.forms, opts));
  return out.filter((ix) => ix.byFirst.size > 0);
}

/** The non-overlapping matches, left to right, longest first at each position. Linear in the text. */
function findAll(text: string, names: Names, opts: ScrubOptions, firstOnly: boolean): Hit[] {
  const indexes = indexesOf(names, opts);
  if (indexes.length === 0) return [];
  const hits = findPlain(text, indexes, opts, firstOnly);
  if ((firstOnly && hits.length) || !/[\u202D\u202E]/u.test(text)) return hits;
  return mergeHits(hits, overrideHits(text, (t) => findPlain(t, indexes, opts, firstOnly)));
}

function findPlain(text: string, indexes: readonly Index[], opts: ScrubOptions, firstOnly: boolean): Hit[] {
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
  /** The longest pattern of `ix` found at token `i`, with its end. */
  const at = (ix: Index, i: number): { p: Pattern; end: number } | undefined => {
    const w = tokens[i]!.w;
    for (const p of ix.byFirst.get(w) ?? []) {
      const end = matchEnd(p, i);
      if (end >= 0) return { p, end };
    }
    // A one-word Hangul name at the start of a longer run: the prefixes of the token that end on a
    // syllable boundary, longest first, no longer than the longest such name (linear in the text).
    if (ix.maxPrefix > 0 && CHOSEONG.test(w[0] ?? "")) {
      for (let n = Math.min(w.length - 1, ix.maxPrefix); n > 0; n--) {
        if (!CHOSEONG.test(w[n]!)) continue;
        for (const p of ix.prefixes.get(w.slice(0, n)) ?? []) {
          const end = matchEnd(p, i);
          if (end >= 0) return { p, end };
        }
      }
    }
    return undefined;
  };
  for (let i = 0; i < tokens.length; ) {
    let hit: Pattern | undefined;
    let end = -1;
    // Longest across the indexes; on the same length the first index (the name map) wins.
    for (const ix of indexes) {
      const r = at(ix, i);
      if (r && (!hit || r.p.units.length > hit.units.length)) {
        hit = r.p;
        end = r.end;
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
export function scrubNames(text: string, names: Names, opts: ScrubOptions = {}): string {
  const hits = findAll(text, names, opts, false);
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
export function namesAny(text: string, names: Names, opts: ScrubOptions = {}): boolean {
  return findAll(text, names, opts, true).length > 0;
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
export function urlNamesAny(url: string, names: Names): boolean {
  let u = url;
  for (let k = 0; k < 3; k++) {
    const d = safeDecode(u);
    if (d === u) break;
    u = d;
  }
  return namesAny(u.replace(/\+/gu, " "), names, { splitDigits: true });
}
