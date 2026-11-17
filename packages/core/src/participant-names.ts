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
 * Platform-neutral: no node: imports.
 */
import { NO_SPACE_SCRIPT } from "./verify/evidence.js";

const isNoSpace = (ch: string | undefined): boolean => ch !== undefined && NO_SPACE_SCRIPT.test(ch);

/** Letters NFKD leaves whole, spelled the way names are commonly written without them (R89). */
const TRANSLIT: Readonly<Record<string, string>> = {
  ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", þ: "th", Þ: "TH", ı: "i",
};
/** Name comparison key: those letters transliterated, then NFKD, combining marks removed, lowercase. */
export const fold = (s: string): string =>
  s
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
}

/** Every form's patterns (its order variants and joined forms), indexed by first unit, longest first. */
function patterns(forms: readonly NameForm[], opts: ScrubOptions): Map<string, Pattern[]> {
  const min = opts.bareMinLength ?? 0;
  const split = opts.splitDigits ?? false;
  const index = new Map<string, Pattern[]>();
  const seen = new Set<string>();
  const add = (ws: readonly string[], code: string) => {
    const us = ws.flatMap((w) => units(w, split));
    if (us.length === 0) return;
    const key = us.join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const single = us.length === 1 && [...us[0]!].length === 1 && isNoSpace(us[0]);
    const list = index.get(us[0]!) ?? [];
    list.push({ units: us, code, single });
    index.set(us[0]!, list);
  };
  for (const f of forms) {
    const ws = f.words.filter(Boolean);
    if (ws.length === 0) continue;
    if (f.bare && ws.length === 1 && [...ws[0]!].length < min) continue;
    const orders: string[][] = [ws];
    if (ws.length > 1) {
      // Any rotation ("Family, Given": "Lopez, Maria", "Fernández Ruiz, Lucía") and the full reverse.
      for (let k = 1; k < ws.length; k++) orders.push([...ws.slice(k), ...ws.slice(0, k)]);
      orders.push([...ws].reverse());
    }
    for (const o of orders) {
      add(o, f.code);
      // A name written as one word ("marialopez", "MariaLopez") is the same name (R89).
      if (o.length > 1) add([o.join("")], f.code);
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.units.length - a.units.length);
  return index;
}

interface Hit {
  start: number;
  end: number;
  code: string;
}

/** The non-overlapping matches, left to right, longest first at each position. Linear in the text. */
function findAll(text: string, forms: readonly NameForm[], opts: ScrubOptions, firstOnly: boolean): Hit[] {
  if (forms.length === 0) return [];
  const index = patterns(forms, opts);
  if (index.size === 0) return [];
  const tokens = tokenize(text, opts.splitDigits ?? false);
  const hits: Hit[] = [];
  for (let i = 0; i < tokens.length; ) {
    const cands = index.get(tokens[i]!.w);
    const hit = cands?.find(
      (p) =>
        p.units.every((u, k) => tokens[i + k]?.w === u) &&
        // A single no-space-script character is a name only when it stands alone.
        !(p.single && (tokens[i]!.gluedLeft || tokens[i]!.gluedRight)),
    );
    if (!hit) {
      i++;
      continue;
    }
    hits.push({ start: tokens[i]!.start, end: tokens[i + hit.units.length - 1]!.end, code: hit.code });
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
    while (start > pos && text[start - 1] === "@") start--;
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
