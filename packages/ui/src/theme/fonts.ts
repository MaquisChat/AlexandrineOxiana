/**
 * Typefaces (spec 8A.2). The default interface/reading/transcript/notes typeface is Goudy Old Style:
 * a commercial font, so the stack names the user's installed copy first and falls back to the
 * bundled Sorts Mill Goudy (SIL OFL), then Garamond and Georgia. Every stack gets a per-script
 * fallback chain so text in any language renders even when the chosen typeface lacks it; the chain
 * matches the choice's generic family (R105), so a sans or monospace choice never falls back to a
 * serif face.
 */
import { isUsableFontFamily } from "@ao/shared";

export type GenericFamily = "serif" | "sans-serif" | "monospace";

export interface FontChoice {
  family: string;
  source: "bundled" | "system" | "user-file";
  /**
   * For `user-file`: a reference to the font file (where the desktop shell finds it). The UI never
   * reads the file; loading it is wired through the desktop shell/service (Tasks 33, 37).
   */
  file?: string;
  /** Which kind of face this is, for the fallbacks. Inferred when missing (see genericOf). */
  generic?: GenericFamily;
}

export const GOUDY_STACK = "'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif";
export const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Per-script fallbacks for a serif choice: exactly the brief's chain. */
export const SCRIPT_FALLBACKS =
  "'Noto Serif', 'Noto Sans', 'Noto Naskh Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Serif CJK SC', 'Noto Serif CJK JP', 'Noto Serif CJK KR', 'Hiragino Mincho ProN', 'Songti SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Mincho', 'Malgun Gothic', 'Segoe UI Historic', serif";

/** Per-script fallbacks for each generic family; each ends with that generic family. */
export const FALLBACKS_BY_GENERIC: Record<GenericFamily, string> = {
  serif: SCRIPT_FALLBACKS,
  "sans-serif":
    "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Hiragino Sans', 'PingFang SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', 'Segoe UI Historic', sans-serif",
  monospace:
    "'Noto Sans Mono', 'Noto Sans Mono CJK SC', 'Noto Sans Mono CJK JP', 'Noto Sans Mono CJK KR', 'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'MS Gothic', 'Osaka-Mono', 'Segoe UI Historic', monospace",
};

/** Generic families that end a stack; they are dropped from the choice and the right one ends it. */
const TRAILING_GENERICS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace"]);

/** Faces offered in the picker (and common ones) that are not serif. */
const KNOWN_GENERIC: Record<string, GenericFamily> = {
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

/** Whether a family name (or list) can be used; the same rule as the service (@ao/shared). */
export function isUsableFamily(family: string): boolean {
  return isUsableFontFamily(family);
}

/** One family name as CSS: kept if already quoted or a plain identifier, quoted otherwise. */
function cssFamily(name: string): string {
  const n = name.trim();
  if (/^'[^']*'$|^"[^"]*"$/.test(n)) return n;
  if (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(n)) return n;
  return `'${n.replace(/'/g, "\\'")}'`;
}

const unquote = (n: string) => n.trim().replace(/^['"]|['"]$/g, "");

/** Splits a font-family list on commas outside quotes. */
function splitFamilies(list: string): string[] {
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

/**
 * The generic family of a choice: its `generic`, else the generic keyword that ends its list, else a
 * known face's kind, else serif.
 */
export function genericOf(choice: FontChoice): GenericFamily {
  if (choice.generic) return choice.generic;
  const names = splitFamilies(choice.family).map((n) => unquote(n).toLowerCase());
  for (let i = names.length - 1; i >= 0; i--) {
    const n = names[i]!;
    if (n === "serif" || n === "ui-serif") return "serif";
    if (n === "sans-serif" || n === "ui-sans-serif") return "sans-serif";
    if (n === "monospace") return "monospace";
  }
  for (const n of names) if (KNOWN_GENERIC[n]) return KNOWN_GENERIC[n];
  return "serif";
}

/**
 * The CSS font-family value for a choice: the chosen family (or list of families) first, then the
 * per-script fallbacks for its generic family, ending with that generic family.
 */
export function fontStack(choice: FontChoice): string {
  if (!isUsableFamily(choice.family)) throw new Error(`"${choice.family}" is not a font name.`);
  const generic = genericOf(choice);
  const isList = splitFamilies(choice.family).length > 1 || /^['"]/.test(choice.family.trim());
  const families = isList ? splitFamilies(choice.family).map(cssFamily) : [cssFamily(choice.family)];
  while (families.length > 1 && TRAILING_GENERICS.has(families[families.length - 1]!) && families[families.length - 1] !== "ui-monospace") families.pop();
  return [...families, FALLBACKS_BY_GENERIC[generic]].join(", ");
}

export interface FontPreset extends FontChoice {
  /** What the picker shows. */
  label: string;
  generic: GenericFamily;
}

/**
 * Typefaces offered in the picker. Bundled fonts ship with the app (public/fonts, SIL OFL); system
 * fonts are used if installed (otherwise the fallbacks apply).
 */
export const FONT_PRESETS: readonly FontPreset[] = [
  { label: "Goudy Old Style (default; Sorts Mill Goudy if not installed)", family: GOUDY_STACK, source: "bundled", generic: "serif" },
  { label: "Sorts Mill Goudy (bundled)", family: "Sorts Mill Goudy", source: "bundled", generic: "serif" },
  { label: "Atkinson Hyperlegible (bundled, readability)", family: "Atkinson Hyperlegible", source: "bundled", generic: "sans-serif" },
  { label: "OpenDyslexic (bundled, readability)", family: "OpenDyslexic", source: "bundled", generic: "sans-serif" },
  { label: "Inter (if installed)", family: "Inter", source: "system", generic: "sans-serif" },
  { label: "Georgia (if installed)", family: "Georgia", source: "system", generic: "serif" },
  { label: "System interface font", family: "system-ui, sans-serif", source: "system", generic: "sans-serif" },
  { label: "System monospace (default for monospace)", family: MONO_STACK, source: "system", generic: "monospace" },
];
