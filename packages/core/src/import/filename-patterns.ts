/** File-name based metadata guesses. Pure and platform-neutral. */

/** User-definable pattern (named groups creator, year, title). Must be vetted by the caller; see parseFileName. */
export type FileNamePattern = { id: string; regex: string };
export type ParsedFileName = { creator?: string; year?: string; title?: string };

/** User regexes only ever see this many characters of the name (ReDoS guard). */
export const MAX_NAME_LENGTH = 255;

const YEAR = "[12]\\d{3}";

// Built-ins run on a whitespace-collapsed, extension-stripped, length-capped name. Each uses
// distinctive literal delimiters and no nested quantifiers, so matching is linear in practice.
const BUILT_INS: { id: string; re: RegExp; underscores?: boolean }[] = [
  { id: "author-year-title", re: new RegExp(`^(?<creator>.+?) - (?<year>${YEAR}) - (?<title>.+)$`) },
  { id: "author_year_title", re: new RegExp(`^(?<creator>[^_]+)_(?<year>${YEAR})_(?<title>.+)$`), underscores: true },
  { id: "author-(year)-title", re: new RegExp(`^(?<creator>[^()]+?) \\((?<year>${YEAR})\\) (?<title>.+)$`) },
  { id: "author-year-title-spaces", re: new RegExp(`^(?<creator>\\S+) (?<year>${YEAR}) (?<title>.+)$`) },
];

function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

function pick(groups: Record<string, string | undefined> | undefined, underscores: boolean): ParsedFileName | null {
  if (!groups) return null;
  const out: ParsedFileName = {};
  const clean = (v: string | undefined) => {
    const t = (underscores ? v?.replace(/_/g, " ") : v)?.trim();
    return t ? t : undefined;
  };
  const cleanTitle = (v: string | undefined) => {
    const t = clean(v)?.replace(/^[\s\-_–—]+/u, "");
    return t ? t : undefined;
  };
  const creator = clean(groups["creator"]);
  const year = clean(groups["year"]);
  const title = cleanTitle(groups["title"]);
  if (creator) out.creator = creator;
  if (year) out.year = year;
  if (title) out.title = title;
  return Object.keys(out).length ? out : null;
}

/**
 * SECURITY: `FileNamePattern.regex` is user-supplied and runs unguarded. The 255-character cap
 * only bounds input size; it does NOT prevent catastrophic backtracking. Callers must vet user
 * patterns before use (a definition-time safety check plus a watchdog, owned by Task 23 or the UI).
 *
 * Parses "Author - Year - Title" style names. User patterns are tried first (invalid regexes are
 * skipped), then the built-ins. Returns null when nothing matches.
 */
export function parseFileName(name: string, patterns: FileNamePattern[] = []): ParsedFileName | null {
  const base = stripExtension(name).slice(0, MAX_NAME_LENGTH);

  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.regex);
    } catch {
      continue;
    }
    const r = pick(re.exec(base)?.groups, false);
    if (r) return r;
  }

  const collapsed = base.replace(/\s+/g, " ").trim();
  for (const b of BUILT_INS) {
    const r = pick(b.re.exec(collapsed)?.groups, b.underscores === true);
    if (r) return r;
  }
  return null;
}
