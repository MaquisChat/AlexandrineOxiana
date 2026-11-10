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

/** The text user patterns are matched against: the name without its extension, at most MAX_NAME_LENGTH characters. */
export function patternSubject(name: string): string {
  return stripExtension(name).slice(0, MAX_NAME_LENGTH);
}

/** A user pattern's named groups (`creator`, `year`, `title`) as a parsed name, or null when none is filled. */
export function parsedFromGroups(groups: Record<string, string | undefined> | undefined): ParsedFileName | null {
  return pick(groups, false);
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
 * SECURITY: `FileNamePattern.regex` is user-supplied and runs unguarded here. The 255-character
 * cap only bounds input size; it does NOT prevent catastrophic backtracking. Callers must vet user
 * patterns before use (`vetFileNamePattern` at definition time) and run them under a watchdog
 * (Bulk Import runs them in a worker thread with a time budget, R49d); `vetFileNamePattern` alone
 * does not make a pattern safe (e.g. `(a|a)*` passes it).
 *
 * Parses "Author - Year - Title" style names. User patterns are tried first (invalid regexes are
 * skipped), then the built-ins. Returns null when nothing matches.
 */
export function parseFileName(name: string, patterns: FileNamePattern[] = []): ParsedFileName | null {
  const base = patternSubject(name);

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

/** Longest user pattern accepted. */
export const MAX_PATTERN_LENGTH = 500;

export type PatternVetting = { ok: true } | { ok: false; reason: string };

/**
 * Definition-time check of a user file-name pattern (R49d): it must compile, name at least one of
 * the groups `creator`, `year`, `title`, and pass a structural ReDoS check (in the spirit of
 * safe-regex): no backreferences (`\1`, `\k<name>`) and no nested quantifiers, i.e. no group that
 * contains a quantifier and is itself repeated more than once (`*`, `+`, `{n,}`, `{n,m}` with
 * m > 1). Optional groups (`?`, `{0,1}`) may contain quantifiers. Overlapping alternatives under
 * one quantifier (`(a|a)*`) are not detected: patterns must still run under a watchdog.
 * Reasons are plain sentences for the person who wrote the pattern.
 */
export function vetFileNamePattern(regex: string): PatternVetting {
  if (typeof regex !== "string" || regex.length === 0) return { ok: false, reason: "The pattern is empty." };
  if (regex.length > MAX_PATTERN_LENGTH) return { ok: false, reason: `The pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
  let re: RegExp;
  try {
    re = new RegExp(regex);
  } catch {
    return { ok: false, reason: "The pattern is not a valid regular expression." };
  }
  if (!/\(\?<(?:creator|year|title)>/u.test(re.source)) {
    return { ok: false, reason: "The pattern must name at least one of the groups creator, year or title, e.g. (?<title>.+)." };
  }
  const problem = structuralProblem(regex);
  return problem ? { ok: false, reason: problem } : { ok: true };
}

const NESTED = "The pattern repeats a group that itself contains a repetition (for example (a+)+), which can take extremely long on some file names. Rewrite it without nested repetition.";
const BACKREF = "The pattern uses a backreference (\\1 or \\k<name>), which is not allowed in file-name patterns.";

/** Reads a quantifier at `i` ({n}, {n,}, {n,m}, *, +, ?), with its lazy `?`; returns its length and whether it repeats more than once. */
function quantifierAt(src: string, i: number): { len: number; many: boolean } | null {
  const c = src[i];
  let len = 0;
  let many = false;
  if (c === "*" || c === "+") {
    len = 1;
    many = true;
  } else if (c === "?") {
    len = 1;
  } else if (c === "{") {
    // {digits}, {digits,} or {digits,digits}: read with plain scans (no window, linear).
    const digits = (from: number) => {
      let j = from;
      while (j < src.length && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
      return j;
    };
    const a = digits(i + 1);
    if (a === i + 1) return null; // a literal brace
    const value = (from: number, to: number) => {
      const t = src.slice(from, to).replace(/^0+(?=\d)/u, "");
      return t.length > 15 ? Infinity : Number(t);
    };
    const min = value(i + 1, a);
    let max = min;
    let end = a;
    if (src[a] === ",") {
      const b = digits(a + 1);
      max = b === a + 1 ? Infinity : value(a + 1, b);
      end = b;
    }
    if (src[end] !== "}") return null; // a literal brace
    len = end + 1 - i;
    many = max > 1;
  } else return null;
  if (src[i + len] === "?") len++;
  return { len, many };
}

/** The structural problem of a (compilable) pattern, or undefined. Linear in the pattern's length. */
function structuralProblem(src: string): string | undefined {
  /** Per open group: whether it contains a quantifier (directly or in a nested group). */
  const stack: boolean[] = [false];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (/[1-9]/u.test(n) || n === "k") return BACKREF;
      i += 2;
      // A quantified escape is a quantifier in the enclosing group.
      const q = quantifierAt(src, i);
      if (q) {
        stack[stack.length - 1] = true;
        i += q.len;
      }
      continue;
    }
    if (c === "[") {
      // Character class: skip to its unescaped closing bracket. In JavaScript `[]` (nothing) and
      // `[^]` (anything) are complete classes: a "]" right after "[" or "[^" closes it.
      i++;
      if (src[i] === "^") i++;
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
      i++;
      const q = quantifierAt(src, i);
      if (q) {
        stack[stack.length - 1] = true;
        i += q.len;
      }
      continue;
    }
    if (c === "(") {
      stack.push(false);
      // Skip the group's opener: (?: (?= (?! (?<= (?<! (?<name>
      if (src[i + 1] === "?") {
        if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") {
          const close = src.indexOf(">", i);
          i = close < 0 ? i + 3 : close + 1;
        } else i += src[i + 2] === "<" ? 4 : 3;
      } else i++;
      continue;
    }
    if (c === ")") {
      const inner = stack.length > 1 ? stack.pop()! : false;
      i++;
      const q = quantifierAt(src, i);
      if (q) {
        if (q.many && inner) return NESTED;
        stack[stack.length - 1] = true;
        i += q.len;
      } else if (inner) stack[stack.length - 1] = true;
      continue;
    }
    const q = quantifierAt(src, i);
    if (q) {
      stack[stack.length - 1] = true;
      i += q.len;
      continue;
    }
    i++;
  }
  return undefined;
}
