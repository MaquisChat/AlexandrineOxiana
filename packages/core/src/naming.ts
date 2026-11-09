/**
 * Human-readable, cross-platform file naming (spec 4.2, 4.4).
 * Platform-neutral: no node: imports.
 */

export interface NamingTemplates {
  /** Placeholders: {date} {creator} {title} {id}. */
  sourceFolder: string;
  /** Placeholder: {source} (source name without its [id]) plus the extension added by the caller. */
  originalFile: string;
  /** Placeholders: {source} {kind} {lang} {tool} {modified}. */
  derivedFile: string;
}

export const defaultTemplates: NamingTemplates = {
  sourceFolder: "{date} {creator} - {title} [{id}]",
  originalFile: "{source}",
  derivedFile: "{source} - {kind} - {lang} - {tool} - modified {modified}",
};

const MAX_FILE_NAME_BYTES = 255;
// Room kept free so a later `.enc` (4 bytes) and a collision suffix up to " (99)" (5 bytes) still fit.
const RESERVED_TAIL_BYTES = 4 + 5;
const MAX_BASE_NAME_BYTES = MAX_FILE_NAME_BYTES - RESERVED_TAIL_BYTES;
const ELLIPSIS = "…";
const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides/embeddings/isolates (LRM and RLM are kept).
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** Longest prefix of `s` within `budget` UTF-8 bytes, cut on a grapheme boundary. */
function truncateBytes(s: string, budget: number): string {
  if (byteLength(s) <= budget) return s;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let kept = "";
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const n = byteLength(segment);
    if (used + n > budget) break;
    kept += segment;
    used += n;
  }
  return kept;
}

export function sanitizeSegment(s: string, maxBytes = 150): string {
  let out = s
    .normalize("NFC")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .replace(ILLEGAL, "-")
    .trim();
  out = out.replace(/[. ]+$/, "");
  if (RESERVED.test(out)) out = `_${out}`;
  if (out === "") return "_";
  if (byteLength(out) <= maxBytes) return out;
  return truncateBytes(out, maxBytes - byteLength(ELLIPSIS)).replace(/[. ]+$/, "") + ELLIPSIS;
}

/** Single-pass substitution so substituted values are never re-scanned for placeholders. */
function render(template: string, values: Record<string, string>): string {
  return template
    .replace(/( - )?\{(\w+)\}/g, (match, sep: string | undefined, key: string) => {
      const value = values[key];
      if (value === undefined) return match;
      if (value === "") return ""; // drop the placeholder with its preceding " - "
      return (sep ?? "") + value;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceFolderName(
  input: { dateOrYear?: string; primaryCreator?: string; shortTitle: string; shortId: string },
  templates: NamingTemplates = defaultTemplates,
): string {
  const creator = input.primaryCreator?.trim() ? input.primaryCreator : "Unknown";
  return render(templates.sourceFolder, {
    date: input.dateOrYear?.trim() ? sanitizeSegment(input.dateOrYear, 40) : "",
    creator: sanitizeSegment(creator, 60),
    title: sanitizeSegment(input.shortTitle, 100),
    id: sanitizeSegment(input.shortId, 16),
  });
}

function sanitizeExt(ext: string): string {
  return sanitizeSegment(ext.replace(/^\.+/, ""), 16);
}

export function originalFileName(
  sourceName: string,
  ext: string,
  templates: NamingTemplates = defaultTemplates,
): string {
  const safeExt = sanitizeExt(ext);
  const stem = sourceName.replace(/\s*\[[^\]]*\]\s*$/, "");
  const budget = MAX_BASE_NAME_BYTES - byteLength(`.${safeExt}`);
  const source = sanitizeSegment(stem, Math.max(budget, 16));
  return `${render(templates.originalFile, { source })}.${safeExt}`;
}

function formatModified(date: Date, tz?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}${get("minute")}`;
}

export function derivedFileName(
  input: {
    sourceName: string;
    kind: string;
    lang?: string;
    tool: string;
    modified: Date;
    ext: string;
    tz?: string;
  },
  templates: NamingTemplates = defaultTemplates,
): string {
  const ext = sanitizeExt(input.ext);
  const values: Record<string, string> = {
    source: "",
    kind: sanitizeSegment(input.kind, 40),
    lang: input.lang?.trim() ? sanitizeSegment(input.lang, 40) : "",
    tool: sanitizeSegment(input.tool, 60),
    modified: formatModified(input.modified, input.tz),
  };
  // The whole name is capped at 246 bytes (255 minus room for ".enc" and " (99)"). With the source
  // empty, render() swallows the separator before {source}'s successor, hence the extra 3 bytes.
  const rest = render(templates.derivedFile, values);
  const budget = MAX_BASE_NAME_BYTES - byteLength(rest) - byteLength(`.${ext}`) - 3;
  values.source = sanitizeSegment(input.sourceName, Math.max(budget, 16));
  return `${render(templates.derivedFile, values)}.${ext}`;
}

/** Splits a name into stem and extension tail (`.vtt`, `.tar.gz`, `.vtt.enc`, ...). */
function splitName(name: string, isFile: boolean): { stem: string; tail: string } {
  if (!isFile) return { stem: name, tail: "" };
  const m = /(\.tar\.(?:gz|bz2|xz)|\.[A-Za-z0-9]{1,5})?(\.enc)?$/.exec(name);
  const tail = m?.[0] ?? "";
  if (tail === "" || tail.length >= name.length) return { stem: name, tail: "" };
  return { stem: name.slice(0, name.length - tail.length), tail };
}

function fit(stem: string, suffix: string, tail: string): string {
  const budget = MAX_FILE_NAME_BYTES - byteLength(suffix) - byteLength(tail);
  return truncateBytes(stem, Math.max(budget, 1)).replace(/[. ]+$/, "") + suffix + tail;
}

export function withCollisionSuffix(
  name: string,
  exists: (n: string) => boolean,
  options: { isFile?: boolean } = {},
): string {
  if (!exists(name)) return name;
  const { stem, tail } = splitName(name, options.isFile ?? true);
  for (let i = 2; ; i++) {
    const candidate = fit(stem, ` (${i})`, tail);
    if (!exists(candidate)) return candidate;
  }
}

export function pseudonymize(text: string, map: ReadonlyMap<string, string>): string {
  const entries: { key: string; code: string; re: RegExp }[] = [];
  const seen = new Set<string>();
  for (const [handle, code] of map) {
    const key = handle.normalize("NFC");
    if (key === "" || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    entries.push({ key, code, re: new RegExp(`^${escapeRe(key)}$`, "iu") });
  }
  const input = text.normalize("NFC");
  if (entries.length === 0) return input;
  const alternatives = entries
    .map((e) => e.key)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_@])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}\\p{M}_]|\\.[\\p{L}\\p{N}\\p{M}_])`,
    "giu",
  );
  return input.replace(re, (m) => {
    // Fail closed: the match used the regex's case folding, so look up with the same folding.
    const hit = entries.find((e) => e.re.test(m));
    if (!hit) throw new Error("pseudonymize: matched handle has no mapping");
    return hit.code;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function encName(name: string): string {
  if (byteLength(name) + 4 <= MAX_FILE_NAME_BYTES) return `${name}.enc`;
  const { stem, tail } = splitName(name, true);
  return fit(stem, "", `${tail}.enc`);
}
