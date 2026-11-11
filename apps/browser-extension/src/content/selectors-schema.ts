/**
 * The schema of selectors.json, checked every time the file is loaded (R110). The file is the only
 * place CSS selectors live, so a platform's markup change is fixed by editing it, not the code; a
 * file that does not match this schema is refused as a whole rather than half-used.
 *
 * Hand-written rather than a JSON-Schema library: such libraries compile validators with
 * `new Function`, which the extension's CSP (script-src 'self') forbids.
 */

export const PLATFORMS = ["instagram", "tiktok", "youtube", "generic"] as const;
export type PlatformName = (typeof PLATFORMS)[number];

/** The page kinds each platform's extractor knows. */
export const KINDS: Record<PlatformName, readonly string[]> = {
  instagram: ["post", "profile"],
  tiktok: ["video", "profile"],
  youtube: ["video", "channel"],
  generic: ["page"],
};

export const FIELDS = ["canonicalUrl", "handle", "displayName", "caption", "postedAt", "likes", "comments", "views", "shares", "mediaUrls"] as const;
export type FieldName = (typeof FIELDS)[number];

/** One way of reading a field: the first alternative that yields a valid value wins. */
export interface Alternative {
  css: string;
  /** "text" (default) or "attr:<name>" for a safe attribute. */
  read?: string;
  /** A regular expression with one capture group applied to what was read; no match → nothing. */
  pattern?: string;
}

export interface PageSelectors {
  fields: Partial<Record<FieldName, Alternative[]>>;
  /** Profile pages: the links to individual posts (profile as I scroll). */
  postLinks?: Alternative[];
}

export interface PlatformSelectors {
  pages: Record<string, PageSelectors>;
}

export interface SelectorsConfig {
  version: 1;
  platforms: Record<PlatformName, PlatformSelectors>;
}

export class SelectorsError extends Error {
  constructor(path: string, problem: string) {
    super(`selectors.json ${path}: ${problem}`);
    this.name = "SelectorsError";
  }
}

const SAFE_ATTRS = new Set(["content", "datetime", "href", "src", "poster", "title", "alt", "aria-label", "itemprop", "dir"]);
const DATA_ATTR = /^data-[a-z0-9-]{1,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new SelectorsError(path, `unknown key "${k}"`);
}

/** CSS syntax check where a DOM is available (the page, tests); elsewhere only basic sanity. */
function checkCss(css: string, path: string): void {
  if (css.trim() === "" || css.length > 500) throw new SelectorsError(`${path}.css`, "must be a CSS selector of 1–500 characters");
  if (typeof document !== "undefined" && typeof document.createDocumentFragment === "function") {
    try {
      document.createDocumentFragment().querySelector(css);
    } catch {
      throw new SelectorsError(`${path}.css`, `"${css}" is not a valid CSS selector`);
    }
  }
}

/**
 * Why `src` could backtrack catastrophically, or undefined: a backreference, or a repeated group that
 * itself contains a repetition ("(a+)+", "(?:x*)*", "(a{1,5})+"). Repetition = *, + or {…}.
 */
export function unsafePatternReason(src: string): string | undefined {
  const groups: Array<{ repeats: boolean }> = [{ repeats: false }];
  const quantifierAt = (i: number): { len: number; repeats: boolean } | undefined => {
    const c = src[i];
    if (c === "*" || c === "+") return { len: src[i + 1] === "?" ? 2 : 1, repeats: true };
    if (c === "?") return { len: src[i + 1] === "?" ? 2 : 1, repeats: false };
    const m = c === "{" ? /^\{(\d+)(,(\d*))?\}\??/.exec(src.slice(i)) : null;
    if (m) return { len: m[0].length, repeats: m[2] !== undefined || Number(m[1]) > 1 };
    return undefined;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    let atomRepeats = false; // the atom just read contains a repetition (groups only)
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (/[1-9]/.test(n) || (n === "k" && src[i + 2] === "<")) return "backreferences are not allowed";
      i += 2;
    } else if (c === "[") {
      i++;
      if (src[i] === "^") i++;
      if (src[i] === "]") i++;
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "(") {
      groups.push({ repeats: false });
      i++;
      const head = /^\?(:|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(src.slice(i));
      if (head) i += head[0].length;
      continue;
    } else if (c === ")") {
      const g = groups.pop();
      if (!g || groups.length === 0) return "unbalanced parentheses";
      atomRepeats = g.repeats;
      i++;
    } else {
      i++;
      if (c === "|" || c === "^" || c === "$") continue;
    }
    const q = quantifierAt(i);
    const top = groups[groups.length - 1]!;
    if (atomRepeats) top.repeats = true;
    if (q) {
      if (q.repeats && atomRepeats) return "nested quantifiers are not allowed";
      if (q.repeats) top.repeats = true;
      i += q.len;
    }
  }
  return undefined;
}

function checkPattern(pattern: string, path: string): void {
  const unsafe = unsafePatternReason(pattern);
  if (unsafe) throw new SelectorsError(`${path}.pattern`, unsafe);
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    throw new SelectorsError(`${path}.pattern`, "is not a valid regular expression");
  }
  // Exactly one capture group: what it captures is the value.
  const groups = new RegExp(`${re.source}|`).exec("")!.length - 1;
  if (groups !== 1) throw new SelectorsError(`${path}.pattern`, "needs exactly one capture group");
}

function alternatives(v: unknown, path: string): Alternative[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) throw new SelectorsError(path, "must be a list of 1–10 alternatives");
  return v.map((a, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(a)) throw new SelectorsError(p, "must be an object");
    onlyKeys(a, ["css", "read", "pattern"], p);
    if (typeof a.css !== "string") throw new SelectorsError(`${p}.css`, "must be text");
    checkCss(a.css, p);
    const out: Alternative = { css: a.css };
    if (a.read !== undefined) {
      if (typeof a.read !== "string") throw new SelectorsError(`${p}.read`, "must be text");
      const attr = a.read.startsWith("attr:") ? a.read.slice(5) : undefined;
      if (a.read !== "text" && !(attr && (SAFE_ATTRS.has(attr) || DATA_ATTR.test(attr)))) throw new SelectorsError(`${p}.read`, `"${a.read}" must be "text" or "attr:" with a plain attribute`);
      out.read = a.read;
    }
    if (a.pattern !== undefined) {
      if (typeof a.pattern !== "string" || a.pattern.length > 300) throw new SelectorsError(`${p}.pattern`, "must be text of at most 300 characters");
      checkPattern(a.pattern, p);
      out.pattern = a.pattern;
    }
    return out;
  });
}

/** Checks `raw` against the schema; returns it typed, or throws SelectorsError naming the problem. */
export function validateSelectors(raw: unknown): SelectorsConfig {
  if (!isObject(raw)) throw new SelectorsError("(root)", "must be an object");
  onlyKeys(raw, ["$comment", "version", "platforms"], "(root)");
  if (raw.version !== 1) throw new SelectorsError("version", "must be 1");
  if (!isObject(raw.platforms)) throw new SelectorsError("platforms", "must be an object");
  onlyKeys(raw.platforms, PLATFORMS, "platforms");
  const platforms = {} as Record<PlatformName, PlatformSelectors>;
  for (const name of PLATFORMS) {
    const pl = raw.platforms[name];
    const path = `platforms.${name}`;
    if (!isObject(pl)) throw new SelectorsError(path, "is missing");
    onlyKeys(pl, ["pages"], path);
    if (!isObject(pl.pages)) throw new SelectorsError(`${path}.pages`, "must be an object");
    onlyKeys(pl.pages, KINDS[name], `${path}.pages`);
    const pages: Record<string, PageSelectors> = {};
    for (const [kind, pg] of Object.entries(pl.pages)) {
      const pp = `${path}.pages.${kind}`;
      if (!isObject(pg)) throw new SelectorsError(pp, "must be an object");
      onlyKeys(pg, ["fields", "postLinks"], pp);
      if (!isObject(pg.fields)) throw new SelectorsError(`${pp}.fields`, "must be an object");
      onlyKeys(pg.fields, FIELDS, `${pp}.fields`);
      const fields: PageSelectors["fields"] = {};
      for (const [f, alts] of Object.entries(pg.fields)) fields[f as FieldName] = alternatives(alts, `${pp}.fields.${f}`);
      pages[kind] = { fields, ...(pg.postLinks !== undefined ? { postLinks: alternatives(pg.postLinks, `${pp}.postLinks`) } : {}) };
    }
    platforms[name] = { pages };
  }
  return { version: 1, platforms };
}
