/**
 * Typefaces (spec 8A.2). The default interface/reading/transcript/notes typeface is Goudy Old Style:
 * a commercial font, so the stack names the user's installed copy first and falls back to the
 * bundled Sorts Mill Goudy (SIL OFL), then Garamond and Georgia. Every stack gets a per-script
 * fallback chain so text in any language renders even when the chosen typeface lacks it.
 */
export interface FontChoice {
  family: string;
  source: "bundled" | "system" | "user-file";
  /**
   * For `user-file`: a reference to the font file (where the desktop shell finds it). The UI never
   * reads the file; loading it is wired through the desktop shell/service (Tasks 33, 37).
   */
  file?: string;
}

export const GOUDY_STACK = "'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif";
export const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Per-script fallbacks appended to every stack (Noto families first, then common OS fonts). */
export const SCRIPT_FALLBACKS =
  "'Noto Serif', 'Noto Sans', 'Noto Naskh Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Serif CJK SC', 'Noto Serif CJK JP', 'Noto Serif CJK KR', 'Hiragino Mincho ProN', 'Songti SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Mincho', 'Malgun Gothic', 'Segoe UI Historic', serif";

/** Generic families that end a stack; they are moved after the per-script fallbacks. */
const TRAILING_GENERICS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

/** What the service accepts as a family (apps/library-service/src/routes/appearance.ts). */
function checkFamily(family: string): void {
  if (!family.trim() || family.length > 300 || /[;{}<>\\]/.test(family)) throw new Error(`"${family}" is not a font name.`);
}

/** One family name as CSS: kept if already quoted or a plain identifier, quoted otherwise. */
function cssFamily(name: string): string {
  const n = name.trim();
  if (/^'[^']*'$|^"[^"]*"$/.test(n)) return n;
  if (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(n)) return n;
  return `'${n.replace(/'/g, "\\'")}'`;
}

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
 * The CSS font-family value for a choice: the chosen family (or list of families) first, then the
 * per-script fallbacks, then the choice's own generic family (when it is not serif), then serif.
 */
export function fontStack(choice: FontChoice): string {
  checkFamily(choice.family);
  const isList = splitFamilies(choice.family).length > 1 || /^['"]/.test(choice.family.trim());
  const families = isList ? splitFamilies(choice.family).map(cssFamily) : [cssFamily(choice.family)];
  const generics: string[] = [];
  while (families.length > 1 && TRAILING_GENERICS.has(families[families.length - 1]!)) generics.unshift(families.pop()!);
  const tail = generics.filter((g) => g !== "serif");
  const fallbacks = SCRIPT_FALLBACKS.slice(0, SCRIPT_FALLBACKS.lastIndexOf(", serif"));
  return [...families, fallbacks, ...tail, "serif"].join(", ");
}

export interface FontPreset extends FontChoice {
  /** What the picker shows. */
  label: string;
}

/**
 * Typefaces offered in the picker. Bundled fonts ship with the app (public/fonts, SIL OFL); system
 * fonts are used if installed (otherwise the fallbacks apply).
 */
export const FONT_PRESETS: readonly FontPreset[] = [
  { label: "Goudy Old Style (default; Sorts Mill Goudy if not installed)", family: GOUDY_STACK, source: "bundled" },
  { label: "Sorts Mill Goudy (bundled)", family: "Sorts Mill Goudy", source: "bundled" },
  { label: "Atkinson Hyperlegible (bundled, readability)", family: "Atkinson Hyperlegible", source: "bundled" },
  { label: "OpenDyslexic (bundled, readability)", family: "OpenDyslexic", source: "bundled" },
  { label: "Inter (if installed)", family: "Inter", source: "system" },
  { label: "Georgia (if installed)", family: "Georgia", source: "system" },
  { label: "System interface font", family: "system-ui, sans-serif", source: "system" },
  { label: "System monospace (default for monospace)", family: MONO_STACK, source: "system" },
];
