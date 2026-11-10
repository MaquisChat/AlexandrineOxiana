/**
 * Reference-manager exports for Bulk Import (spec 5.4 "Import sources"; Task 24, R65): BibTeX
 * (incl. BibLaTeX, Better BibTeX, JabRef), RIS and CSL-JSON files as `ImportSourceAdapter`s.
 * Zotero RDF is in zotero-rdf.ts and Calibre libraries in calibre.ts; they share the helpers here.
 * The adapters only read: every write goes through the Task 23 engine (provenance `refman_import`;
 * Zotero RDF is `zotero_import`, Calibre `calibre_import`).
 *
 * Parsing is our own and linear (no backtracking regular expressions on the input, no recursion):
 * citation-js was evaluated and set aside, because a 64 KB field nested deeply in braces overflows
 * its recursive-descent parser, one malformed entry aborts the whole file, and its BibTeX → CSL
 * mapping drops the `file` field we need. Limits: an export file is at most 100 MB; every field
 * value is cut to 64 KB before anything else looks at it.
 *
 * Linked files (`file` fields, RIS L1/L2/L4) may be absolute, relative to the export file, or
 * `file:` URLs; the Zotero/JabRef form `desc:path:mime` (several separated by ";", "\:" escapes)
 * is understood. Only regular files are attached. A linked file that is missing, unreadable, or a
 * folder, FIFO or device is left out with a per-item `fileNotes` entry (FILE_NOTES; never the
 * path): the reference itself still imports, metadata-only if no file is left (R66), and the
 * batch report lists the note. Only an export that cannot be read as a whole is an unreadable item.
 *
 * Item keys are `<export file name>@<hash of its absolute path>#<citation key>` (or `#@<n>` for an
 * entry without a key; a repeated key gets `~2`, `~3`, ...): stable across scans of the same export,
 * so resume and re-import recognise items. The engine stores only an HMAC of the key (R63); the
 * citation key itself goes into `externalKeys.citekey` and the draft's `citationKey`.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileTypeFromFile } from "file-type";
import { biblioOf, toIsbn13, type Biblio, type Creator, type ImportBatch, type SourceDraft, type SourceType } from "@ao/core";
import { clean, normalizeDate, parseName } from "../extract/names.js";
import type { ImportSourceAdapter, ScanFile, ScanItem } from "./bulk/scan.js";
import { bibtexBiblio, cslBiblio, risPages } from "./sidecar.js";

export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
export const MAX_FIELD_CHARS = 64 * 1024;
/** Records parsed from one export at most (R70); parsing stops as soon as it is passed. */
export const MAX_EXPORT_RECORDS = 200_000;
const MAX_TAGS = 100;
const MAX_TAG_CHARS = 200;
const MAX_FILES = 50;

/** Per-item notes for linked files that were left out (shown in the batch report; never a path). */
export const FILE_NOTES = {
  missing: "attached file not found",
  location: "attached file location not supported",
  notRegular: "attached file is not a regular file",
  unreadable: "attached file could not be read",
} as const;

export const REFMAN_REASONS = {
  tooMany: "This export has too many references for one import; split it into smaller files.",
  encoding: "The export file is not in a text encoding that can be read (UTF-8 or UTF-16), so nothing was imported from it. Export it again as UTF-8.",
  empty: "The export file contains no references that could be read, so nothing was imported from it.",
  budget: "The export file's @string definitions or field values are too large to import safely, so nothing was imported from it.",
  tooLarge: "The export file is too large to import (more than 100 MB). Split it into smaller exports, then import each.",
  unreadable: "The export file could not be read, so nothing was imported from it.",
} as const;

/** A table lookup that never reaches Object.prototype ("constructor", "__proto__" … are unknown keys). */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export const cap = (s: string) => (s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s);

/** Plain text of a field value: capped, control characters and runs of white space collapsed. */
export const text = (s: string | undefined | null) => (s ? clean(cap(s)) : "");

const mt = (value: string) => ({ variants: [{ lang: "und", kind: "original" as const, value }] });

export class ExportUnreadable extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** Scan note when an old export was read as Windows-1252 (R69). */
export const LEGACY_ENCODING_NOTE = "decoded as Windows-1252 — check accented characters";

/**
 * Export bytes → text: UTF-16 (LE or BE) when it starts with a byte order mark, else UTF-8 (BOM
 * dropped). Bytes that are not valid UTF-8 and have no BOM are read as Windows-1252 when `legacy`
 * is allowed (old BibTeX and RIS exports, R69; `legacy: true` in the result, so the scan notes it),
 * else → ExportUnreadable (never silently mangled). Line endings become "\n" (CRLF and lone CR).
 */
export function decodeExport(buf: Buffer, allowLegacy = false): { text: string; legacy: boolean } {
  let s: string;
  let legacy = false;
  try {
    if (buf[0] === 0xff && buf[1] === 0xfe) s = new TextDecoder("utf-16le", { fatal: true }).decode(buf.subarray(2));
    else if (buf[0] === 0xfe && buf[1] === 0xff) s = new TextDecoder("utf-16be", { fatal: true }).decode(buf.subarray(2));
    else {
      try {
        s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
      } catch (err) {
        if (!allowLegacy) throw err;
        const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        s = new TextDecoder("windows-1252").decode(bom ? buf.subarray(3) : buf);
        legacy = true;
      }
    }
  } catch {
    throw new ExportUnreadable(REFMAN_REASONS.encoding);
  }
  return { text: s.includes("\r") ? s.replace(/\r\n?/gu, "\n") : s, legacy };
}

/** The export file's bytes (size-checked), or ExportUnreadable with a plain reason. */
export async function readExportBytes(path: string): Promise<Buffer> {
  const st = await fsp.stat(path).catch(() => null);
  if (!st?.isFile()) throw new ExportUnreadable(REFMAN_REASONS.unreadable);
  if (st.size > MAX_EXPORT_BYTES) throw new ExportUnreadable(REFMAN_REASONS.tooLarge);
  let buf: Buffer;
  try {
    buf = await fsp.readFile(path);
  } catch {
    throw new ExportUnreadable(REFMAN_REASONS.unreadable);
  }
  if (buf.length > MAX_EXPORT_BYTES) throw new ExportUnreadable(REFMAN_REASONS.tooLarge);
  return buf;
}

/** The export file's text, strictly decoded (decodeExport without the Windows-1252 fallback). */
export async function readExport(path: string): Promise<string> {
  return decodeExport(await readExportBytes(path)).text;
}

/** `<name>@<12 hex of sha256(absolute path)>`: identifies the export (or library) the keys belong to. */
export function exportIdentity(path: string): string {
  const abs = resolve(path);
  return `${basename(abs)}@${createHash("sha256").update(abs).digest("hex").slice(0, 12)}`;
}

/** Unique, stable item keys within one export. */
export class ItemKeys {
  private seen = new Map<string, number>();
  private n = 0;
  constructor(private readonly prefix: string) {}
  next(citekey: string | undefined): string {
    this.n++;
    const base = citekey ? citekey : `@${this.n}`;
    const count = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, count);
    return `${this.prefix}#${count === 1 ? base : `${base}~${count}`}`;
  }
}

/** Tag names: cleaned, capped, de-duplicated (case-insensitive), at most 100. */
export function tagList(raw: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = text(r).slice(0, MAX_TAG_CHARS).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Splits on any of the given single characters (linear). */
function splitOn(s: string, chars: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (chars.includes(s[i]!)) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

export const keywordTags = (s: string | undefined) => (s ? tagList(splitOn(cap(s), ",;")) : []);

export const doiOf = (v: string | undefined) => {
  const d = text(v)
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "")
    .toLowerCase();
  return d && d.length <= 500 && /^10\.\d{4,9}\/\S+$/u.test(d) ? d : undefined;
};

export function isbnsOf(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    for (const part of splitOn(cap(v), ";, \t")) {
      const i = part.length <= 40 ? toIsbn13(part) : undefined;
      if (i) out.add(i);
      if (out.size >= 20) return [...out];
    }
  }
  return [...out];
}

export const issnOf = (v: string | undefined) => {
  const t = text(v).replace(/^issn\s*/iu, "");
  return /^\d{4}-?\d{3}[\dXx]$/u.test(t) ? `${t.slice(0, 4)}-${t.slice(-4).toUpperCase()}` : undefined;
};

const ARXIV = /^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/iu;
export const arxivOf = (v: string | undefined) => {
  const t = text(v);
  return t.length <= 60 ? ARXIV.exec(t)?.[1] : undefined;
};

/** What an adapter knows about one record, before its files are checked. */
export interface RecordFields extends Biblio {
  type?: SourceType;
  title?: string;
  creators?: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  doi?: string;
  isbn?: string[];
  issn?: string;
  url?: string;
  arxiv?: string;
  citekey?: string;
  tags?: string[];
}

/** RecordFields → the engine's reference metadata (only what is present). */
export function referenceMetadata(f: RecordFields): Partial<SourceDraft> {
  const ids: NonNullable<SourceDraft["identifiers"]> = {};
  if (f.doi) ids.doi = f.doi;
  if (f.isbn?.length) ids.isbn = f.isbn;
  if (f.issn) ids.issn = f.issn;
  if (f.url && f.url.length <= 2000 && /^https?:\/\//iu.test(f.url)) ids.url = f.url;
  if (f.arxiv) ids.arxiv = f.arxiv;
  const issued = f.issued ? normalizeDate(f.issued) : undefined;
  return {
    ...(f.type ? { type: f.type } : {}),
    ...(f.title ? { title: mt(f.title) } : {}),
    ...(f.creators?.length ? { creators: f.creators } : {}),
    ...(issued ? { issued } : {}),
    ...(f.container ? { container: mt(f.container) } : {}),
    ...(f.publisher ? { publisher: f.publisher } : {}),
    ...biblioOf(f),
    ...(Object.keys(ids).length ? { identifiers: ids } : {}),
    ...(f.citekey ? { citationKey: f.citekey } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Linked files

/** Unescapes `\x` → `x` (linear). */
function unescapeBackslashes(s: string): string {
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) i++;
    out += s[i];
  }
  return out;
}

/** Splits at unescaped `sep` (a backslash escapes the next character; escapes are kept). */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === sep) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** One linked file: candidate absolute paths (the first that exists is used), or a note why it cannot be. */
export type Link = { paths: string[] } | { note: string };

const MIME_OR_TYPE = /^[A-Za-z0-9.+/ -]{0,100}$/u;

/**
 * A single linked location → Link: `file:` URLs decoded (a host, or an encoded "/" inside a name,
 * gives the note FILE_NOTES.location), relative paths against the export's folder; undefined for
 * links that are not local files (http(s), EndNote internal-pdf:// …), which are ignored.
 */
export function linkFromPath(raw: string, baseDir: string): Link | undefined {
  const p = raw.trim();
  if (!p || p.includes("\u0000")) return undefined;
  if (/^file:/iu.test(p)) {
    try {
      return { paths: [fileURLToPath(p)] };
    } catch {
      return { note: FILE_NOTES.location };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(p)) return undefined;
  return { paths: [isAbsolute(p) ? p : resolve(baseDir, p)] };
}

/**
 * The links in a `file` field: `path`, `desc:path:mime` (Zotero, JabRef, Mendeley), several of
 * either separated by ";". With `escapes` (BibTeX), `\:` `\;` `\\` are escapes; without (CSL-JSON),
 * backslashes are Windows path separators. Ambiguous colons give several candidates, the one that
 * names an existing file wins: "a:b.pdf" (no mime part) is tried whole, then as "desc:path";
 * Mendeley's ":home/user/x.pdf:pdf" (leading slash dropped) is tried as written, then absolute.
 */
export function fileFieldLinks(raw: string, baseDir: string, escapes = true): Link[] {
  const out: Link[] = [];
  const fix = (x: string) => (escapes ? unescapeBackslashes(x) : x.replaceAll("\\", "/")).trim();
  const split = (x: string, sep: string) => (escapes ? splitUnescaped(x, sep) : splitOn(x, sep));
  for (const entry of split(cap(raw), ";")) {
    if (out.length >= MAX_FILES) break;
    const e = entry.trim();
    if (!e) continue;
    if (/^file:/iu.test(e)) {
      const l = linkFromPath(e, baseDir);
      if (l) out.push(l);
      continue;
    }
    const parts = split(e, ":");
    let candidates: string[];
    if (parts.length === 1) candidates = [fix(e)];
    else if (parts.length >= 3 && MIME_OR_TYPE.test(parts[parts.length - 1]!)) {
      const middle = fix(parts.slice(1, -1).join(":"));
      candidates = [middle];
      if (!parts[0]!.trim() && middle && !isAbsolute(middle) && !/^[A-Za-z]:/u.test(middle)) candidates.push(`/${middle}`);
    } else candidates = [fix(e), fix(parts.slice(1).join(":"))];
    const paths: string[] = [];
    let note: string | undefined;
    for (const c of candidates) {
      const l = c ? linkFromPath(c, baseDir) : undefined;
      if (l && "paths" in l) paths.push(...l.paths);
      else if (l) note ??= l.note;
    }
    if (paths.length) out.push({ paths: [...new Set(paths)] });
    else if (note) out.push({ note });
  }
  return out;
}

/** Checks each link: the regular files as ScanFiles, and a note (FILE_NOTES) for each one left out. */
export async function checkFiles(links: Link[]): Promise<{ files: ScanFile[]; notes: string[] }> {
  const files: ScanFile[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if ("note" in link) {
      notes.push(link.note);
      continue;
    }
    let path = link.paths[0]!;
    let st: import("node:fs").Stats | undefined;
    let code: string | undefined;
    for (const p of link.paths) {
      try {
        st = await fsp.stat(p);
        path = p;
        break;
      } catch (err) {
        code ??= (err as NodeJS.ErrnoException).code;
      }
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!st) {
      notes.push(code === "ENOENT" || code === "ENOTDIR" ? FILE_NOTES.missing : FILE_NOTES.unreadable);
      continue;
    }
    if (!st.isFile()) {
      notes.push(FILE_NOTES.notRegular);
      continue;
    }
    const t = await fileTypeFromFile(path).catch(() => undefined);
    files.push({ path, mime: t?.mime ?? "application/octet-stream", bytes: st.size });
  }
  return { files, notes };
}

/** A record with nothing to identify it: no title, creators, identifiers or linked files (skipped, R68). */
export const isEmptyRecord = (f: RecordFields, links: unknown[]) =>
  !f.title && !f.creators?.length && !f.doi && !f.isbn?.length && !f.issn && !f.url && !f.arxiv && links.length === 0;

/** The scan note for skipped empty records. */
export const skippedNote = (n: number) =>
  n === 1
    ? "1 reference had no title, creators, identifiers or files and was skipped."
    : `${n} references had no title, creators, identifiers or files and were skipped.`;

/**
 * One ScanItem from a parsed record and its links, or undefined for an empty record (isEmptyRecord).
 * `notes` are file notes the adapter already has (e.g. a Calibre path refused).
 */
export async function recordItem(
  key: string,
  f: RecordFields,
  links: Array<Link | undefined>,
  extra: Pick<ScanItem, "folderPath"> & { externalKeys?: Record<string, string>; notes?: string[] } = {},
): Promise<ScanItem | undefined> {
  const real = links.filter((l): l is Link => !!l).slice(0, MAX_FILES);
  if (isEmptyRecord(f, [...real, ...(extra.notes ?? [])])) return undefined;
  const checked = await checkFiles(real);
  const notes = [...(extra.notes ?? []), ...checked.notes];
  const externalKeys = { ...(f.citekey ? { citekey: f.citekey } : {}), ...(extra.externalKeys ?? {}) };
  return {
    key,
    files: checked.files,
    referenceMetadata: referenceMetadata(f),
    ...(f.tags?.length ? { tags: f.tags } : {}),
    ...(extra.folderPath?.length ? { folderPath: extra.folderPath } : {}),
    ...(Object.keys(externalKeys).length ? { externalKeys } : {}),
    ...(notes.length ? { fileNotes: notes } : {}),
  };
}

/**
 * An adapter over a parsed export. The whole file is parsed before the first item is yielded (all
 * budgets are checked up front), so an export that cannot be read or parsed — or that yields no
 * references at all — is one unreadable item and nothing else. Empty records are skipped and
 * counted in a scan note. Roots (R67): the export's folder.
 */
export function exportAdapter<R>(
  kind: ImportBatch["source"]["kind"],
  path: string,
  parse: (text: string) => Iterable<R>,
  toItem: (record: R, keys: ItemKeys, baseDir: string) => Promise<ScanItem | undefined>,
  /** Old exports may be Windows-1252 (BibTeX, RIS; R69). */
  allowLegacy = false,
): ImportSourceAdapter {
  const baseDir = dirname(resolve(path));
  return {
    kind,
    location: path,
    roots: [baseDir],
    async *scan(signal, ctx) {
      const prefix = exportIdentity(path);
      let records: R[];
      try {
        const { text, legacy } = decodeExport(await readExportBytes(path), allowLegacy);
        records = [];
        for (const r of parse(text)) {
          if (records.length >= MAX_EXPORT_RECORDS) throw new ExportUnreadable(REFMAN_REASONS.tooMany);
          records.push(r);
        }
        if (!records.length && text.trim()) throw new ExportUnreadable(REFMAN_REASONS.empty);
        if (legacy) ctx?.note?.(LEGACY_ENCODING_NOTE);
      } catch (err) {
        yield { key: `${prefix}#`, files: [], unreadable: err instanceof ExportUnreadable ? err.reason : REFMAN_REASONS.unreadable };
        return;
      }
      const keys = new ItemKeys(prefix);
      let skipped = 0;
      for (const r of records) {
        signal.throwIfAborted();
        const item = await toItem(r, keys, baseDir);
        if (item) yield item;
        else skipped++;
      }
      if (skipped) ctx?.note?.(skippedNote(skipped));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// BibTeX

const BIB_TYPES: Record<string, SourceType> = {
  article: "article-journal", book: "book", mvbook: "book", inbook: "chapter", incollection: "chapter", inreference: "chapter",
  bookinbook: "chapter", inproceedings: "article-journal", conference: "article-journal", phdthesis: "thesis",
  mastersthesis: "thesis", thesis: "thesis", techreport: "report", report: "report", misc: "other", online: "webpage",
  electronic: "webpage", www: "webpage", dataset: "dataset", unpublished: "manuscript", manual: "report", booklet: "book",
  collection: "book", proceedings: "book", periodical: "book",
};

const MONTH_MACROS: Record<string, string> = {
  jan: "1", feb: "2", mar: "3", apr: "4", may: "5", jun: "6", jul: "7", aug: "8", sep: "9", oct: "10", nov: "11", dec: "12",
};

export interface BibEntry {
  type: string;
  key: string;
  /** Raw field values (macros expanded, braces kept), lower-case names, first occurrence wins. */
  fields: Map<string, string>;
}

const MAX_MACROS = 10_000;
/** Budgets (R68 C1): all @string values together, and all kept field values of one file together. */
export const MAX_MACRO_BYTES = 4 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_FIELDS_PER_ENTRY = 64;
/** The only fields kept (bibFields and the `file` field); others are skipped unexpanded. */
const KNOWN_FIELDS = new Set([
  "title", "author", "editor", "translator", "year", "month", "date", "journal", "journaltitle", "booktitle",
  "publisher", "institution", "school", "organization", "doi", "isbn", "issn", "url", "eprint", "archiveprefix",
  "eprinttype", "keywords", "file",
  // R87: bibliographic detail.
  "volume", "number", "issue", "pages", "edition", "address", "location", "series", "pagetotal",
]);
const isNameChar = (c: string | undefined) => !!c && c !== "," && c !== "=" && c !== "#" && c !== "{" && c !== "}" && c !== "(" && c !== ")" && c !== '"' && c !== "@" && !/\s/u.test(c);
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

/**
 * Entries of a BibTeX file (linear; no recursion). @comment and @preamble are skipped, @string
 * macros are defined and expanded. A block that does not close before a line starting with "@"
 * ends there (the same recovery rule as the sidecar reader, R57/R58), so one broken entry never
 * swallows the rest of the file. Only KNOWN_FIELDS are kept (at most 64 per entry); other values
 * are scanned past without expanding macros. All @string values together are at most 4 MB and all
 * kept values of the file at most 32 MB: past either budget, ExportUnreadable (R68).
 */
export function* parseBibtexEntries(src: string): Generator<BibEntry> {
  const n = src.length;
  let macroBytes = 0;
  let expandedBytes = 0;
  const macros = new Map<string, string>();
  /** Positions of "@" that start a line (after spaces/tabs): block boundaries. */
  const lineAt = (i: number) => {
    let j = i + 1;
    while (src[j] === " " || src[j] === "\t") j++;
    return src[j] === "@" ? j : -1;
  };
  let i = src.indexOf("@");
  while (i >= 0 && i < n) {
    let j = i + 1;
    while (j < n && /[A-Za-z]/u.test(src[j]!)) j++;
    const type = src.slice(i + 1, j).toLowerCase();
    while (isSpace(src[j])) j++;
    if (!type || (src[j] !== "{" && src[j] !== "(")) {
      i = src.indexOf("@", j > i + 1 ? j : i + 1);
      continue;
    }
    const close = src[j] === "(" ? ")" : "}";
    j++;
    /** Index where the block stopped (just past its closing delimiter, or at a line-start "@"). */
    let stop = n;
    if (type === "comment" || type === "preamble") {
      let depth = 1;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "\n" && lineAt(j) >= 0) {
          stop = lineAt(j);
          break;
        }
        if (c === "{" || c === "(") depth++;
        else if ((c === "}" || c === ")") && --depth === 0) {
          stop = j + 1;
          break;
        }
      }
      i = src.indexOf("@", stop === n ? n : stop);
      continue;
    }
    // Key (entries only).
    let key = "";
    if (type !== "string") {
      const ks = j;
      while (j < n && src[j] !== "," && src[j] !== close && src[j] !== "\n" && j - ks < 1000) j++;
      key = text(src.slice(ks, j));
      if (src[j] === "\n") {
        // "@type{key\n  field = ..." with the comma on the next line, or a key-less entry.
        let k = j;
        while (isSpace(src[k])) k++;
        if (src[k] === ",") j = k;
      }
      if (src[j] === ",") j++;
    }
    const fields = new Map<string, string>();
    let ended = false;
    // Fields: name = value [# value ...], separated by commas.
    while (j < n && !ended) {
      while (j < n && (isSpace(src[j]) || src[j] === ",")) {
        if (src[j] === "\n" && lineAt(j) >= 0) {
          stop = lineAt(j);
          ended = true;
          break;
        }
        j++;
      }
      if (ended || j >= n) break;
      if (src[j] === close) {
        stop = j + 1;
        break;
      }
      const ns = j;
      while (j < n && isNameChar(src[j]) && j - ns < 200) j++;
      const name = src.slice(ns, j).toLowerCase();
      while (j < n && isSpace(src[j]) && !(src[j] === "\n" && lineAt(j) >= 0)) j++;
      if (src[j] !== "=" || !name) {
        // Not a field: skip to the next separator.
        if (j === ns) j++;
        continue;
      }
      j++;
      const keep = type === "string" || (KNOWN_FIELDS.has(name) && !fields.has(name) && fields.size < MAX_FIELDS_PER_ENTRY);
      const parts: string[] = [];
      let length = 0;
      const push = (s: string) => {
        if (keep && length < MAX_FIELD_CHARS) {
          const t = s.slice(0, MAX_FIELD_CHARS - length);
          parts.push(t);
          length += t.length;
        }
      };
      for (;;) {
        while (j < n && isSpace(src[j]) && !(src[j] === "\n" && lineAt(j) >= 0)) j++;
        const c = src[j];
        if (c === "{" || c === '"') {
          // Braced or quoted value; braces nest (counted, not recursed).
          const vs = j + 1;
          let depth = c === "{" ? 1 : 0;
          j++;
          for (; j < n; j++) {
            const d = src[j];
            if (d === "\n" && lineAt(j) >= 0) {
              ended = true;
              stop = lineAt(j);
              break;
            }
            if (d === "\\") {
              if (src[j + 1] !== "\n") j++; // a backslash never hides a line break (recovery)
              continue;
            }
            if (d === "{") depth++;
            else if (d === "}") {
              if (depth === 0) break; // stray close brace inside quotes: end of entry
              depth--;
              if (depth === 0 && c === "{") break;
            } else if (d === '"' && c === '"' && depth === 0) break;
          }
          push(src.slice(vs, Math.min(j, n)));
          // Step past the closing brace or quote, but not past a stray "}" ending a quoted value
          // that never closed (that brace closes the entry).
          const strayClose = c === '"' && src[j] === "}";
          if (!ended && j < n && !strayClose) j++;
        } else if (c !== undefined && isNameChar(c)) {
          // Number or macro name.
          const ms = j;
          while (j < n && isNameChar(src[j]) && j - ms < 200) j++;
          const word = src.slice(ms, j);
          if (keep) {
            const lw = word.toLowerCase();
            push(/^\d+$/u.test(word) ? word : (macros.get(lw) ?? own(MONTH_MACROS, lw) ?? word));
          }
        }
        if (ended) break;
        while (j < n && isSpace(src[j]) && !(src[j] === "\n" && lineAt(j) >= 0)) j++;
        if (src[j] === "#") {
          j++;
          continue;
        }
        break;
      }
      if (keep) {
        const value = parts.join("");
        if (type === "string") {
          macroBytes += value.length;
          if (macroBytes > MAX_MACRO_BYTES) throw new ExportUnreadable(REFMAN_REASONS.budget);
          if (macros.size < MAX_MACROS) macros.set(name, value);
        } else {
          expandedBytes += value.length;
          if (expandedBytes > MAX_EXPANDED_BYTES) throw new ExportUnreadable(REFMAN_REASONS.budget);
          fields.set(name, value);
        }
      }
      // Anything else up to the next separator is skipped by the loop above.
      while (j < n && !ended && src[j] !== "," && src[j] !== close && !isSpace(src[j])) j++;
    }
    if (type !== "string") yield { type, key, fields };
    i = src.indexOf("@", stop > i ? stop : i + 1);
  }
}

const ACCENTS: Record<string, string> = {
  "'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊", d: "̣", b: "̱",
};
const SYMBOLS: Record<string, string> = {
  ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ",
  textendash: "–", textemdash: "—", textquoteright: "’", textquoteleft: "‘", ldots: "…", dots: "…", textellipsis: "…",
  textasciitilde: "~", textasciicircum: "^", textbraceleft: "{", textbraceright: "}", textbackslash: "\\", S: "§", P: "¶", copyright: "©", textregistered: "®", texttrademark: "™",
  pounds: "£", euro: "€", textdegree: "°", guillemotleft: "«", guillemotright: "»", dh: "ð", DH: "Ð", th: "þ", TH: "Þ",
  ng: "ŋ", NG: "Ŋ", dj: "đ", DJ: "Đ",
};
const isLetterAscii = (c: string | undefined) => !!c && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

/** LaTeX-ish BibTeX text → plain text (accents, symbols, escapes; braces and $ dropped). Linear. */
export function latexToText(s: string): string {
  let out = "";
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i]!;
    if (c === "\\") {
      const d = s[i + 1];
      if (d === undefined) break;
      if (!isLetterAscii(d)) {
        if (own(ACCENTS, d)) {
          // \'e  \'{e}  \"{\i}
          let j = i + 2;
          while (s[j] === " ") j++;
          let base = "";
          if (s[j] === "{") {
            j++;
            if (s[j] === "\\" && (s[j + 1] === "i" || s[j + 1] === "j") && !isLetterAscii(s[j + 2])) {
              base = s[j + 1]!;
              j += 2;
            } else if (s[j] !== undefined && s[j] !== "}") {
              base = s[j]!;
              j++;
            }
            if (s[j] === "}") j++;
          } else if (s[j] === "\\" && (s[j + 1] === "i" || s[j + 1] === "j") && !isLetterAscii(s[j + 2])) {
            base = s[j + 1]!;
            j += 2;
          } else if (s[j] !== undefined) {
            base = s[j]!;
            j++;
          }
          out += base + own(ACCENTS, d)!;
          i = j - 1;
        } else if (d === "\\") {
          out += " ";
          i++;
        } else {
          out += d; // \& \% \$ \_ \# \{ \} and the like
          i++;
        }
        continue;
      }
      let j = i + 1;
      while (j < n && isLetterAscii(s[j]) && j - i < 40) j++;
      const name = s.slice(i + 1, j);
      if (name.length === 1 && own(ACCENTS, name) && (s[j] === "{" || s[j] === " ")) {
        // \v{S}  \c c
        let k = j;
        while (s[k] === " ") k++;
        let base = "";
        if (s[k] === "{") {
          k++;
          if (s[k] !== undefined && s[k] !== "}") base = s[k++]!;
          if (s[k] === "}") k++;
        } else if (s[k] !== undefined) base = s[k++]!;
        out += base + own(ACCENTS, name)!;
        i = k - 1;
        continue;
      }
      const sym = own(SYMBOLS, name);
      if (sym !== undefined) {
        out += sym;
        if (s[j] === "{" && s[j + 1] === "}") j += 2;
        else if (s[j] === " ") j++;
      }
      // Unknown commands (\emph, \textit ...) drop their name and keep their argument's text.
      i = j - 1;
      continue;
    }
    if (c === "{" || c === "}" || c === "$") continue;
    if (c === "~") {
      out += " ";
      continue;
    }
    if (c === "-" && s[i + 1] === "-") {
      if (s[i + 2] === "-") {
        out += "—";
        i += 2;
      } else {
        out += "–";
        i += 1;
      }
      continue;
    }
    out += c;
  }
  return out.normalize("NFC");
}

const bibText = (v: string | undefined) => (v ? clean(latexToText(cap(v))) : "");

/** Splits at `sep` (a single character) at brace depth 0 (linear). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Splits a BibTeX name list at " and " (any case, any white space) outside braces (linear). */
export function splitBibNames(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isSpace(c) && (s[i + 1] === "a" || s[i + 1] === "A") && (s[i + 2] === "n" || s[i + 2] === "N") && (s[i + 3] === "d" || s[i + 3] === "D") && isSpace(s[i + 4])) {
      out.push(s.slice(start, i));
      start = i + 5;
      i += 4;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Words of a name part at brace depth 0 (a braced group is one word). */
function nameWords(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && isSpace(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** A von-particle: its first letter (outside braces, after commands) is lower case. */
function isVon(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (c === "{") return false;
    if (c === "\\") {
      i++;
      while (isLetterAscii(word[i + 1])) i++;
      continue;
    }
    if (/\p{L}/u.test(c)) return c === c.toLowerCase() && c !== c.toUpperCase();
  }
  return false;
}

/** One BibTeX name ("von Last, Jr, First", "von Last, First", "First von Last", "{Corporate}"). */
export function bibName(raw: string, role: Creator["role"]): Creator | undefined {
  const s = raw.slice(0, 2000).trim();
  if (!s || s.toLowerCase() === "others") return undefined;
  const words0 = nameWords(s);
  if (words0.length === 1 && s.startsWith("{") && s.endsWith("}")) {
    const literal = bibText(s);
    return literal ? { literal, role } : undefined;
  }
  const parts = splitTop(s, ",").map((p) => p.trim());
  let family: string;
  let given: string;
  if (parts.length >= 2) {
    family = bibText(parts[0]);
    given = bibText(parts.length >= 3 ? parts.slice(2).join(", ") : parts[1]);
  } else {
    const words = words0;
    if (words.length === 1) {
      const literal = bibText(words[0]);
      return literal ? { literal, role } : undefined;
    }
    // First von Last: the family name starts at the first von word (if any, not the last word).
    let vonAt = words.findIndex((w, k) => k < words.length - 1 && isVon(w));
    if (vonAt < 0) vonAt = words.length - 1;
    family = bibText(words.slice(vonAt).join(" "));
    given = bibText(words.slice(0, vonAt).join(" "));
  }
  if (!family) return given ? { literal: given, role } : undefined;
  return given ? { family, given, role } : { family, role };
}

export function bibFields(e: BibEntry): RecordFields {
  const get = (k: string) => e.fields.get(k);
  const t = (k: string) => bibText(get(k)) || undefined;
  const people = (k: string, role: Creator["role"]) => splitBibNames(cap(get(k) ?? "")).map((x) => bibName(x, role)).filter((c): c is Creator => !!c);
  const year = t("year");
  const month = t("month");
  const issued = t("date") ?? (year ? (month && /^\d{1,2}$/u.test(month) ? `${year}-${month.padStart(2, "0")}` : year) : undefined);
  const eprint = t("eprint");
  const archive = (t("archiveprefix") ?? t("eprinttype") ?? "").toLowerCase();
  const creators = [...people("author", "author"), ...people("editor", "editor"), ...people("translator", "translator")];
  const f: RecordFields = {
    type: own(BIB_TYPES, e.type) ?? "other",
    ...(t("title") ? { title: t("title")! } : {}),
    ...(creators.length ? { creators } : {}),
    ...(issued ? { issued } : {}),
  };
  const container = t("journaltitle") ?? t("journal") ?? t("booktitle");
  if (container) f.container = container;
  const publisher = t("publisher") ?? t("institution") ?? t("school") ?? t("organization");
  if (publisher) f.publisher = publisher;
  Object.assign(f, bibtexBiblio(f.type, t));
  const doi = doiOf(get("doi"));
  if (doi) f.doi = doi;
  const isbn = isbnsOf([get("isbn") ?? ""]);
  if (isbn.length) f.isbn = isbn;
  const issn = issnOf(get("issn"));
  if (issn) f.issn = issn;
  const url = text(get("url"));
  if (url) f.url = url;
  const arxiv = archive === "arxiv" ? arxivOf(eprint) : undefined;
  if (arxiv) f.arxiv = arxiv;
  const key = text(e.key);
  if (key) f.citekey = key;
  const tags = keywordTags(bibText(get("keywords")) || undefined);
  if (tags.length) f.tags = tags;
  return f;
}

/** BibTeX / BibLaTeX export (Zotero, JabRef, Better BibTeX, Mendeley ...). */
export function bibtexAdapter(path: string): ImportSourceAdapter {
  return exportAdapter("bibtex", path, parseBibtexEntries, async (e, keys, baseDir) => {
    const f = bibFields(e);
    const raw = e.fields.get("file");
    return recordItem(keys.next(f.citekey), f, raw ? fileFieldLinks(raw, baseDir) : []);
  }, true);
}

// ---------------------------------------------------------------------------------------------
// RIS

const RIS_TYPES: Record<string, SourceType> = {
  JOUR: "article-journal", EJOUR: "article-journal", MGZN: "article-journal", NEWS: "article-journal", JFULL: "article-journal",
  BOOK: "book", EBOOK: "book", EDBOOK: "book", CHAP: "chapter", ECHAP: "chapter", RPRT: "report", THES: "thesis",
  CONF: "article-journal", CPAPER: "article-journal", DATA: "dataset", ELEC: "webpage", WEB: "webpage", BLOG: "webpage",
  SLIDE: "presentation", MANSCPT: "manuscript", UNPB: "manuscript", AUDIO: "audio", VIDEO: "video", MPCT: "video",
  ART: "image", FIGURE: "image", GOVDOC: "report", STAND: "report", PAT: "other", GEN: "other",
};

/** One RIS record: tag → values in order. */
export type RisRecord = Map<string, string[]>;

const isTagChar = (c: string | undefined) => !!c && ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9"));
const MAX_VALUES_PER_RECORD = 100_000;

/** Records of a RIS file (`TY` … `ER`), line by line (linear). Lines without a tag continue the previous value. */
export function* parseRisRecords(src: string): Generator<RisRecord> {
  let rec: RisRecord | null = null;
  let last: { tag: string; idx: number } | null = null;
  let count = 0;
  let start = 0;
  const n = src.length;
  while (start <= n) {
    let end = src.indexOf("\n", start);
    if (end < 0) end = n;
    let line = src.slice(start, Math.min(end, start + MAX_FIELD_CHARS + 6));
    start = end + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const tagged = line.length >= 5 && isTagChar(line[0]) && isTagChar(line[1]) && line[2] === " " && line[3] === " " && line[4] === "-";
    if (!tagged) {
      const cont = clean(line);
      if (rec && last && cont) {
        const vals = rec.get(last.tag)!;
        const prev = vals[last.idx]!;
        if (prev.length < MAX_FIELD_CHARS) vals[last.idx] = cap(prev ? `${prev} ${cont}` : cont);
      }
      if (end === n) break;
      continue;
    }
    const tag = line.slice(0, 2);
    const value = clean(line.slice(6));
    if (tag === "TY") {
      if (rec) yield rec;
      rec = new Map([["TY", [value]]]);
      count = 1;
      last = null;
    } else if (tag === "ER") {
      if (rec) yield rec;
      rec = null;
      last = null;
    } else if (rec && count < MAX_VALUES_PER_RECORD) {
      const vals = rec.get(tag) ?? [];
      vals.push(cap(value));
      rec.set(tag, vals);
      last = { tag, idx: vals.length - 1 };
      count++;
    }
    if (end === n) break;
  }
  if (rec) yield rec;
}

export function risFields(r: RisRecord): RecordFields {
  const all = (...tags: string[]) => tags.flatMap((t) => r.get(t) ?? []).filter(Boolean);
  const first = (...tags: string[]) => all(...tags)[0];
  const ty = (first("TY") ?? "").toUpperCase();
  const type = own(RIS_TYPES, ty) ?? "other";
  const people = (role: Creator["role"], ...tags: string[]) => all(...tags).map((v) => parseName(v, role)).filter((c): c is Creator => !!c);
  const creators = [...people("author", "AU", "A1"), ...people("editor", "A2", "ED"), ...people("translator", "A4")];
  const f: RecordFields = { type };
  const title = first("TI", "T1") ?? (type === "book" ? first("BT") : undefined);
  if (title) f.title = title;
  if (creators.length) f.creators = creators;
  const date = first("PY", "Y1", "DA");
  if (date) {
    // "2019///" and "2019/03/01/" → 2019, 2019-03-01
    const parts = splitOn(date.slice(0, 100), "/").filter(Boolean);
    f.issued = parts.length > 1 && /^\d{4}$/u.test(parts[0]!) ? parts.join("-") : date;
  }
  const container = first("T2", "JO", "JF", "JA", "J2") ?? (type !== "book" ? first("BT") : undefined);
  if (container) f.container = container;
  const publisher = first("PB");
  if (publisher) f.publisher = publisher;
  Object.assign(
    f,
    biblioOf({ volume: first("VL"), issue: first("IS"), page: risPages(first("SP"), first("EP")), edition: first("ET"), publisherPlace: first("CY"), collectionTitle: first("T3") }),
  );
  const doi = doiOf(first("DO"));
  if (doi) f.doi = doi;
  const sn = all("SN");
  const isbn = isbnsOf(sn);
  if (isbn.length) f.isbn = isbn;
  const issn = sn.map(issnOf).find(Boolean);
  if (issn) f.issn = issn;
  const url = first("UR");
  if (url) f.url = url;
  const id = first("ID");
  if (id) f.citekey = id.slice(0, 1000);
  const tags = tagList(all("KW"));
  if (tags.length) f.tags = tags;
  return f;
}

/** RIS export (EndNote, Mendeley, Zotero, Paperpile ...). L1/L2/L4 links that are local files are attached. */
export function risAdapter(path: string): ImportSourceAdapter {
  return exportAdapter("ris", path, parseRisRecords, async (r, keys, baseDir) => {
    const f = risFields(r);
    const links = ["L1", "L2", "L4", "LK"].flatMap((t) => r.get(t) ?? []).slice(0, MAX_FILES);
    return recordItem(keys.next(f.citekey), f, links.map((l) => linkFromPath(l, baseDir)));
  }, true);
}

// ---------------------------------------------------------------------------------------------
// CSL-JSON

const CSL_TYPES: Record<string, SourceType> = {
  "article-journal": "article-journal", "article-magazine": "article-journal", "article-newspaper": "article-journal",
  book: "book", chapter: "chapter", report: "report", thesis: "thesis", webpage: "webpage", "post-weblog": "webpage",
  dataset: "dataset", "paper-conference": "article-journal", manuscript: "manuscript", speech: "presentation",
  article: "preprint", song: "audio", motion_picture: "video", graphic: "image", interview: "interview", post: "social-post",
};

type Json = Record<string, unknown>;

/** JSON values (containers and comma-separated items) parsed from one CSL-JSON export at most. */
const MAX_JSON_VALUES = 4_000_000;

/**
 * Before JSON.parse builds anything (R70): the number of top-level items (≤ MAX_EXPORT_RECORDS) and
 * of values in all (≤ 4,000,000), counted by a linear scan that skips strings.
 */
function checkJsonSize(src: string): void {
  let depth = 0;
  let top = 0;
  let values = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote (escapes skipped)
      for (i++; i < src.length && src.charCodeAt(i) !== 0x22; i++) if (src.charCodeAt(i) === 0x5c) i++;
    } else if (c === 0x5b || c === 0x7b) {
      if (depth === 1) top++;
      depth++;
      values++;
    } else if (c === 0x5d || c === 0x7d) depth--;
    else if (c === 0x2c) {
      values++;
      if (depth === 1) top++;
    }
    if (top > MAX_EXPORT_RECORDS || values > MAX_JSON_VALUES) throw new ExportUnreadable(REFMAN_REASONS.tooMany);
  }
}

/** Items of a CSL-JSON export (an array, or one object). V8's JSON.parse is linear and non-recursive. */
export function parseCslItems(src: string): Json[] {
  checkJsonSize(src);
  const parsed = JSON.parse(src) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((x): x is Json => !!x && typeof x === "object" && !Array.isArray(x));
}

const str = (v: unknown) => (typeof v === "string" ? text(v) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

function cslDate(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return typeof v === "string" ? text(v) || undefined : undefined;
  const d = v as Json;
  const parts = d["date-parts"];
  const first = Array.isArray(parts) && Array.isArray(parts[0]) ? (parts[0] as unknown[]) : [];
  const nums: number[] = [];
  for (const x of first.slice(0, 3)) {
    const y = typeof x === "string" ? Number(x) : x;
    if (typeof y !== "number" || !Number.isInteger(y)) break;
    nums.push(y);
  }
  if (nums.length) return nums.map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-");
  return str(d.raw) || str(d.literal) || undefined;
}

export function cslFields(item: Json): RecordFields {
  const s = (k: string) => str(item[k]) || undefined;
  const people = (k: string, role: Creator["role"]): Creator[] => {
    const list = Array.isArray(item[k]) ? (item[k] as unknown[]) : [];
    const out: Creator[] = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const o = p as Json;
      const family = [str(o["non-dropping-particle"]), str(o.family)].filter(Boolean).join(" ");
      const given = [str(o.given), str(o["dropping-particle"])].filter(Boolean).join(" ");
      if (family) out.push(given ? { family, given, role } : { family, role });
      else if (str(o.literal)) out.push({ literal: str(o.literal), role });
      else if (given) out.push({ literal: given, role });
    }
    return out;
  };
  const f: RecordFields = { type: own(CSL_TYPES, s("type") ?? "") ?? "other" };
  if (s("title")) f.title = s("title");
  const creators = [...people("author", "author"), ...people("editor", "editor"), ...people("translator", "translator")];
  if (creators.length) f.creators = creators;
  const issued = cslDate(item.issued);
  if (issued) f.issued = issued;
  if (s("container-title")) f.container = s("container-title");
  if (s("publisher")) f.publisher = s("publisher");
  Object.assign(f, cslBiblio(item));
  const doi = doiOf(s("DOI"));
  if (doi) f.doi = doi;
  const isbnRaw = item.ISBN;
  const isbn = isbnsOf(typeof isbnRaw === "string" ? [isbnRaw] : Array.isArray(isbnRaw) ? isbnRaw.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
  if (isbn.length) f.isbn = isbn;
  const issn = issnOf(s("ISSN"));
  if (issn) f.issn = issn;
  if (s("URL")) f.url = s("URL");
  const key = s("citation-key") ?? s("citationKey") ?? s("id");
  if (key) f.citekey = key.slice(0, 1000);
  const tags = keywordTags(s("keyword"));
  if (tags.length) f.tags = tags;
  return f;
}

/** CSL-JSON export. A non-standard `file` (string in the BibTeX form, or an array of paths) is attached. */
export function cslJsonAdapter(path: string): ImportSourceAdapter {
  return exportAdapter("csl-json", path, parseCslItems, async (item, keys, baseDir) => {
    const f = cslFields(item);
    const raw = item.file;
    const strings = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX_FILES) : [];
    const links: Link[] = [];
    for (const x of strings) {
      if (links.length >= MAX_FILES) break;
      links.push(...fileFieldLinks(x, baseDir, false));
    }
    return recordItem(keys.next(f.citekey), f, links.slice(0, MAX_FILES));
  });
}
