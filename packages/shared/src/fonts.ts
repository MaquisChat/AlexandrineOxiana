/**
 * Whether a string can be used as a CSS font-family value (a single name or a comma list): not
 * empty, at most 300 characters, and none of the characters that could end the value or the rule
 * (`; { } < > \`), no C0/C1 control characters, no bidi controls (U+202A–202E, U+2066–2069, LRM/RLM,
 * ALM), no zero-width characters (U+200B–200D, U+2060, U+FEFF) and no line/paragraph separators
 * (U+2028/2029). Shared by the service's appearance validation and the UI (R105, R108).
 */
// eslint-disable-next-line no-control-regex
const REFUSED = /[;{}<>\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\u061c\ufeff]/;

export function isUsableFontFamily(family: string): boolean {
  return family.trim().length > 0 && family.length <= 300 && !REFUSED.test(family);
}

/** The generic families a font choice can fall back to (R105): `fonts.*.generic`. */
export type GenericFamily = "serif" | "sans-serif" | "monospace";
export const GENERIC_FAMILIES: readonly GenericFamily[] = ["serif", "sans-serif", "monospace"];

export function isGenericFamily(v: unknown): v is GenericFamily {
  return typeof v === "string" && (GENERIC_FAMILIES as readonly string[]).includes(v);
}

/** Faces offered in the picker (and common ones) that are not serif, by lower-case name. */
const KNOWN_GENERIC: Readonly<Record<string, GenericFamily>> = {
  inter: "sans-serif",
  "atkinson hyperlegible": "sans-serif",
  opendyslexic: "sans-serif",
  "system-ui": "sans-serif",
  "ui-sans-serif": "sans-serif",
  arial: "sans-serif",
  helvetica: "sans-serif",
  "helvetica neue": "sans-serif",
  "segoe ui": "sans-serif",
  roboto: "sans-serif",
  "ui-monospace": "monospace",
  menlo: "monospace",
  consolas: "monospace",
  "courier new": "monospace",
  sfmono: "monospace",
  "sfmono-regular": "monospace",
};

/** Splits a font-family list on commas outside quotes (each name trimmed, quotes kept). */
export function splitFontFamilies(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (n: string) => n.trim().replace(/^['"]|['"]$/g, "");

/**
 * The generic family a family name (or list) implies: the generic keyword that ends the list, else a
 * known face's kind, else undefined. The UI falls back to serif when this is undefined; the service
 * stores it as it is (R109).
 */
export function inferGenericFamily(family: string): GenericFamily | undefined {
  const names = splitFontFamilies(family).map((n) => unquote(n).toLowerCase());
  for (let i = names.length - 1; i >= 0; i--) {
    const n = names[i]!;
    if (n === "serif" || n === "ui-serif") return "serif";
    if (n === "sans-serif" || n === "ui-sans-serif") return "sans-serif";
    if (n === "monospace") return "monospace";
  }
  for (const n of names) if (KNOWN_GENERIC[n]) return KNOWN_GENERIC[n];
  return undefined;
}

/**
 * Names a typeface from the researcher's own file cannot take (Task 57, R100): a CSS-wide keyword
 * would make the font-family value invalid, a generic family would resolve to the browser's own face
 * instead of the file, and a bundled face's name would replace that face across the whole app. The
 * service refuses them; the interface also quotes a file's family in the stack.
 */
export const CSS_WIDE_KEYWORDS = ["inherit", "initial", "unset", "revert", "revert-layer", "default"] as const;
export const GENERIC_FONT_KEYWORDS = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"] as const;
/** The faces the interface ships (public/fonts, declared in theme/fonts.css). */
export const BUNDLED_FONT_FAMILIES = ["Sorts Mill Goudy", "Atkinson Hyperlegible", "OpenDyslexic"] as const;

export type ReservedFontName = "css-keyword" | "generic-family" | "bundled-face";

/** Why a name cannot be a file's family name (compared case-insensitively, trimmed), or null when it can. */
export function reservedFontName(name: string): ReservedFontName | null {
  const n = name.trim().toLowerCase();
  if ((CSS_WIDE_KEYWORDS as readonly string[]).includes(n)) return "css-keyword";
  if ((GENERIC_FONT_KEYWORDS as readonly string[]).includes(n)) return "generic-family";
  if (BUNDLED_FONT_FAMILIES.some((f) => f.toLowerCase() === n)) return "bundled-face";
  return null;
}
