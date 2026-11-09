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
const ELLIPSIS = "…";
const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function sanitizeSegment(s: string, maxBytes = 150): string {
  let out = s.normalize("NFC").replace(/\s+/g, " ").replace(ILLEGAL, "-").trim();
  out = out.replace(/[. ]+$/, "");
  if (RESERVED.test(out)) out = `_${out}`;
  if (out === "") return "_";
  if (byteLength(out) <= maxBytes) return out;

  const budget = maxBytes - byteLength(ELLIPSIS);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let kept = "";
  let used = 0;
  for (const { segment } of segmenter.segment(out)) {
    const n = byteLength(segment);
    if (used + n > budget) break;
    kept += segment;
    used += n;
  }
  return kept.replace(/[. ]+$/, "") + ELLIPSIS;
}

function render(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const token = `{${key}}`;
    if (value === "") {
      // Drop the placeholder together with a directly preceding " - " separator.
      out = out.split(` - ${token}`).join("").split(token).join("");
    } else {
      out = out.split(token).join(value);
    }
  }
  return out.replace(/\s+/g, " ").trim();
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

export function originalFileName(
  sourceName: string,
  ext: string,
  templates: NamingTemplates = defaultTemplates,
): string {
  const source = sourceName.replace(/\s*\[[^\]]*\]\s*$/, "");
  return `${render(templates.originalFile, { source })}.${ext}`;
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
  const values: Record<string, string> = {
    source: "",
    kind: sanitizeSegment(input.kind, 40),
    lang: input.lang?.trim() ? sanitizeSegment(input.lang, 40) : "",
    tool: sanitizeSegment(input.tool, 60),
    modified: formatModified(input.modified, input.tz),
  };
  // Give the source whatever budget the rest of the name leaves in 255 bytes.
  const rest = render(templates.derivedFile, values);
  const budget = MAX_FILE_NAME_BYTES - byteLength(rest) - byteLength(`.${input.ext}`) - 3; // 3: separator the empty source swallowed
  values.source = sanitizeSegment(input.sourceName, Math.max(budget, 16));
  return `${render(templates.derivedFile, values)}.${input.ext}`;
}

export function withCollisionSuffix(name: string, exists: (n: string) => boolean): string {
  if (!exists(name)) return name;
  let tail = "";
  let stem = name;
  if (stem.endsWith(".enc")) {
    tail = ".enc";
    stem = stem.slice(0, -4);
  }
  const m = /\.[^.\s/\\]{1,16}$/.exec(stem);
  if (m && m.index > 0) {
    tail = m[0] + tail;
    stem = stem.slice(0, m.index);
  }
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${tail}`;
    if (!exists(candidate)) return candidate;
  }
}

export function pseudonymize(text: string, map: ReadonlyMap<string, string>): string {
  if (map.size === 0) return text;
  const lookup = new Map<string, string>();
  for (const [handle, pseudonym] of map) lookup.set(handle.toLowerCase(), pseudonym);
  const alternatives = [...lookup.keys()]
    .sort((a, b) => b.length - a.length)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_@])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_]|\\.[\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(re, (m) => lookup.get(m.toLowerCase()) ?? m);
}

export function encName(name: string): string {
  return `${name}.enc`;
}
