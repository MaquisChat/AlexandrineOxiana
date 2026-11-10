/**
 * Sidecar files next to an imported item (spec 5.4 step 3.4): `<name>.bib`, `.ris`, `.json`
 * (CSL-JSON) or `.opf` with the same base name. Only the first record is read, only the fields
 * resolution uses, from at most 1 MB; parsing is linear (no backtracking regexes on the input).
 * The full reference-manager importers (all fields, many records) are Task 24's.
 */
import * as fsp from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { biblioOf, toIsbn13, type Biblio, type Creator, type SourceType } from "@ao/core";
import { dcValues } from "../extract/epub.js";
import { clean, decodeEntities, normalizeDate, parseName } from "../extract/names.js";

export const SIDECAR_EXTS = [".bib", ".ris", ".json", ".opf"] as const;
const MAX_SIDECAR_BYTES = 1024 * 1024;
/** Each field is cut to this many characters before anything else looks at it (R55). */
export const MAX_FIELD_CHARS = 2000;
const cap = (s: string) => s.slice(0, MAX_FIELD_CHARS);
/** A table lookup that never reaches Object.prototype. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** `s` without trailing `ch` characters, scanned from the end (no backtracking regex). */
function trimEnd(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

export interface SidecarMetadata extends Biblio {
  type?: SourceType;
  title?: string;
  creators?: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  doi?: string;
  isbn?: string[];
}

/** Existing sidecar files for `path` (same folder, same base name), in SIDECAR_EXTS order. */
export async function findSidecars(path: string): Promise<string[]> {
  const stem = basename(path, extname(path));
  const out: string[] = [];
  for (const ext of SIDECAR_EXTS) {
    const p = join(dirname(path), stem + ext);
    if (p === path) continue;
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isFile()) out.push(p);
  }
  return out;
}

/** The first record of a sidecar file, or undefined when it cannot be read or has no title. */
export async function readSidecar(path: string): Promise<SidecarMetadata | undefined> {
  let text: string;
  try {
    const fh = await fsp.open(path, "r");
    try {
      const buf = Buffer.alloc(MAX_SIDECAR_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_SIDECAR_BYTES, 0);
      text = buf.subarray(0, bytesRead).toString("utf8").replace(/^﻿/u, "");
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  let m: SidecarMetadata | undefined;
  try {
    switch (extname(path).toLowerCase()) {
      case ".ris":
        m = parseRis(text);
        break;
      case ".bib":
        m = parseBibtex(text);
        break;
      case ".json":
        m = parseCslJson(text);
        break;
      case ".opf":
        m = parseOpf(text);
        break;
    }
  } catch {
    return undefined;
  }
  return m?.title ? m : undefined;
}

const RIS_TYPES: Record<string, SourceType> = {
  JOUR: "article-journal", EJOUR: "article-journal", MGZN: "article-journal", NEWS: "article-journal",
  BOOK: "book", EBOOK: "book", EDBOOK: "book", CHAP: "chapter", ECHAP: "chapter",
  RPRT: "report", THES: "thesis", CONF: "article-journal", CPAPER: "article-journal",
  DATA: "dataset", ELEC: "webpage", WEB: "webpage", SLIDE: "presentation", MANSCPT: "manuscript",
};

function finish(m: SidecarMetadata, isbns: string[]): SidecarMetadata {
  const isbn = [...new Set(isbns.map((i) => toIsbn13(i)).filter((i): i is string => !!i))];
  return { ...m, ...(isbn.length ? { isbn } : {}) };
}

const doiOf = (v: string | undefined) => {
  const d = v?.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu, "").toLowerCase();
  return d && /^10\.\d{4,9}\/\S+$/u.test(d) ? d : undefined;
};

export function parseRis(text: string): SidecarMetadata {
  const m: SidecarMetadata = {};
  const creators: Creator[] = [];
  const isbns: string[] = [];
  let sp = "";
  let ep = "";
  for (const line of text.split(/\r?\n/u)) {
    if (line.length < 5 || line[2] !== " " || line[3] !== " " || line[4] !== "-") continue;
    const tag = line.slice(0, 2).toUpperCase();
    const v = clean(cap(line.slice(6)));
    if (tag === "ER") break;
    if (!v) continue;
    if (tag === "TY") m.type ??= own(RIS_TYPES, v.toUpperCase()) ?? "other";
    else if ((tag === "TI" || tag === "T1") && !m.title) m.title = v;
    else if (tag === "AU" || tag === "A1") {
      const c = parseName(v);
      if (c) creators.push(c);
    } else if (tag === "A2" || tag === "ED") {
      const c = parseName(v, "editor");
      if (c) creators.push(c);
    } else if ((tag === "PY" || tag === "Y1" || tag === "DA") && !m.issued) m.issued = normalizeDate(trimEnd(v, "/").replaceAll("/", "-"));
    else if ((tag === "JO" || tag === "JF" || tag === "T2" || tag === "BT") && !m.container) m.container = v;
    else if (tag === "PB" && !m.publisher) m.publisher = v;
    else if (tag === "VL" && !m.volume) m.volume = v;
    else if (tag === "IS" && !m.issue) m.issue = v;
    else if (tag === "SP" && !sp) sp = v;
    else if (tag === "EP" && !ep) ep = v;
    else if (tag === "ET" && !m.edition) m.edition = v;
    else if (tag === "CY" && !m.publisherPlace) m.publisherPlace = v;
    else if (tag === "T3" && !m.collectionTitle) m.collectionTitle = v;
    else if (tag === "DO" && !m.doi) m.doi = doiOf(v);
    else if (tag === "SN") isbns.push(...v.split(/[;,\s]+/u));
  }
  if (creators.length) m.creators = creators;
  const page = risPages(sp, ep);
  if (page) m.page = page;
  return finish(m, isbns);
}

/** RIS start and end page → one page range ("201-219"; just the start when there is no end). */
export function risPages(sp: string | undefined, ep: string | undefined): string | undefined {
  const a = sp?.trim() ?? "";
  const b = ep?.trim() ?? "";
  if (!a) return b || undefined;
  return b && b !== a && !/[-–]/u.test(a) ? `${a}-${b}` : a;
}

const BIB_TYPES: Record<string, SourceType> = {
  article: "article-journal", book: "book", inbook: "chapter", incollection: "chapter", inproceedings: "article-journal",
  conference: "article-journal", phdthesis: "thesis", mastersthesis: "thesis", thesis: "thesis", techreport: "report",
  report: "report", misc: "other", online: "webpage", dataset: "dataset", unpublished: "manuscript",
};

/** The first `@type{key, field = {value} | "value" | number, ...}` entry, braces balanced by counting. */
/**
 * Index just past the brace (or parenthesis) block opening at `open`, counting nesting. A block
 * that does not balance before a line starting with "@" (after optional spaces or tabs) ends there,
 * at the "@" (an unbalanced @comment or a quoted brace in @string must not swallow the entries
 * after it); text.length if unclosed.
 */
function blockEnd(text: string, open: number): number {
  const o = text[open]!;
  const c = o === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\n") {
      // Spaces and tabs only, so each character is looked at a bounded number of times (linear).
      let j = i + 1;
      while (text[j] === " " || text[j] === "\t") j++;
      if (text[j] === "@") return j;
    }
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i + 1;
  }
  return text.length;
}

const NON_ENTRIES = new Set(["string", "comment", "preamble"]);

export function parseBibtex(text: string): SidecarMetadata {
  // The first real entry: @string, @comment and @preamble blocks are skipped whole.
  let at = text.indexOf("@");
  let open = -1;
  let kind = "";
  while (at >= 0) {
    let j = at + 1;
    while (j < text.length && /[A-Za-z]/u.test(text[j]!)) j++;
    kind = text.slice(at + 1, j).toLowerCase();
    while (j < text.length && /\s/u.test(text[j]!)) j++;
    if (text[j] === "{" || text[j] === "(") {
      if (!NON_ENTRIES.has(kind)) {
        open = j;
        break;
      }
      at = text.indexOf("@", blockEnd(text, j));
    } else {
      at = text.indexOf("@", j);
    }
  }
  if (open < 0) return {};
  const fields = new Map<string, string>();
  let i = text.indexOf(",", open);
  if (i < 0) return {};
  i++;
  const n = text.length;
  while (i < n) {
    while (i < n && /[\s,]/u.test(text[i]!)) i++;
    if (i >= n || text[i] === "}") break;
    const eq = text.indexOf("=", i);
    if (eq < 0) break;
    const name = text.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    while (i < n && /\s/u.test(text[i]!)) i++;
    let value = "";
    if (text[i] === "{") {
      let depth = 0;
      const start = i + 1;
      for (; i < n; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) break;
      }
      value = text.slice(start, i);
      i++;
    } else if (text[i] === '"') {
      const start = i + 1;
      i = start;
      while (i < n && text[i] !== '"') i++;
      value = text.slice(start, i);
      i++;
    } else {
      const start = i;
      while (i < n && text[i] !== "," && text[i] !== "}") i++;
      value = text.slice(start, i);
    }
    if (name && !fields.has(name)) fields.set(name, clean(cap(value).replace(/[{}]/gu, "")));
  }
  const m: SidecarMetadata = { type: own(BIB_TYPES, kind) ?? "other" };
  const get = (k: string) => fields.get(k) || undefined;
  if (get("title")) m.title = get("title");
  const people = (k: string, role: Creator["role"]) =>
    (get(k) ?? "")
      .split(/ and /iu)
      .map((s) => parseName(s, role))
      .filter((c): c is Creator => !!c);
  const creators = [...people("author", "author"), ...people("editor", "editor")];
  if (creators.length) m.creators = creators;
  const issued = normalizeDate(get("date") ?? get("year"));
  if (issued) m.issued = issued;
  const container = get("journal") ?? get("journaltitle") ?? get("booktitle");
  if (container) m.container = container;
  const publisher = get("publisher") ?? get("institution") ?? get("school");
  if (publisher) m.publisher = publisher;
  Object.assign(m, bibtexBiblio(m.type, get));
  const doi = doiOf(get("doi"));
  if (doi) m.doi = doi;
  return finish(m, (get("isbn") ?? "").split(/[;,\s]+/u));
}

/**
 * BibTeX/BibLaTeX bibliographic fields (R87): volume, pages (`--` → en dash), edition, address
 * (place), series, pagetotal; `number` is an article's issue, a report's own number, else the
 * series number (`issue` is read too).
 */
export function bibtexBiblio(type: SourceType | undefined, get: (k: string) => string | undefined): Biblio {
  const out: Biblio = {};
  const set = (k: keyof Biblio, v: string | undefined) => {
    const t = v?.trim();
    if (t) out[k] = t;
  };
  set("volume", get("volume"));
  set("page", get("pages")?.replace(/\s*-{2,3}\s*/gu, "–"));
  set("edition", get("edition"));
  set("publisherPlace", get("address") ?? get("location"));
  set("collectionTitle", get("series"));
  set("numberOfPages", get("pagetotal"));
  const number = get("number");
  if (type === "article-journal" || type === "preprint") set("issue", get("issue") ?? number);
  else if (type === "report") {
    // A @techreport's number is the report's own number (R88), not a series number.
    set("issue", get("issue"));
    set("number", number);
  } else {
    set("issue", get("issue"));
    set("collectionNumber", number);
  }
  return out;
}

const CSL_TYPES: Record<string, SourceType> = {
  "article-journal": "article-journal", "article-magazine": "article-journal", "article-newspaper": "article-journal",
  book: "book", chapter: "chapter", report: "report", thesis: "thesis", webpage: "webpage", dataset: "dataset",
  "paper-conference": "article-journal", manuscript: "manuscript", speech: "presentation", article: "preprint",
};

/** CSL-JSON's bibliographic variables (R87), strings or numbers, at most MAX_FIELD_CHARS each. */
export function cslBiblio(item: Record<string, unknown>): Biblio {
  const pick = (k: string) => {
    const v = item[k];
    const t = typeof v === "string" ? clean(cap(v)) : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    return t || undefined;
  };
  return biblioOf({
    volume: pick("volume"),
    issue: pick("issue"),
    page: pick("page"),
    edition: pick("edition"),
    numberOfPages: pick("number-of-pages"),
    publisherPlace: pick("publisher-place"),
    collectionTitle: pick("collection-title"),
    collectionNumber: pick("collection-number"),
    genre: pick("genre"),
    medium: pick("medium"),
    number: pick("number"),
  });
}

export function parseCslJson(text: string): SidecarMetadata {
  const parsed = JSON.parse(text) as unknown;
  const item = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") return {};
  const s = (k: string) => (typeof item[k] === "string" && clean(cap(item[k] as string)) ? clean(cap(item[k] as string)) : undefined);
  const m: SidecarMetadata = {};
  if (typeof item.type === "string") m.type = own(CSL_TYPES, item.type) ?? "other";
  if (s("title")) m.title = s("title");
  const people = (k: string, role: Creator["role"]): Creator[] =>
    (Array.isArray(item[k]) ? (item[k] as Array<Record<string, unknown>>) : []).flatMap((p): Creator[] => {
      if (!p || typeof p !== "object") return [];
      const family = typeof p.family === "string" ? clean(cap(p.family)) : "";
      const given = typeof p.given === "string" ? clean(cap(p.given)) : "";
      if (family) return [{ family, ...(given ? { given } : {}), role }];
      return typeof p.literal === "string" && clean(cap(p.literal)) ? [{ literal: clean(cap(p.literal)), role }] : [];
    });
  const creators = [...people("author", "author"), ...people("editor", "editor")];
  if (creators.length) m.creators = creators;
  const parts = (item.issued as { "date-parts"?: unknown } | undefined)?.["date-parts"];
  const first = Array.isArray(parts) && Array.isArray(parts[0]) ? (parts[0] as unknown[]) : [];
  const nums: number[] = [];
  for (const x of first.slice(0, 3)) {
    const v = typeof x === "string" ? Number(x) : x;
    if (typeof v !== "number" || !Number.isInteger(v)) break;
    nums.push(v);
  }
  const issued = nums.length ? normalizeDate(nums.map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-")) : undefined;
  if (issued) m.issued = issued;
  if (s("container-title")) m.container = s("container-title");
  if (s("publisher")) m.publisher = s("publisher");
  Object.assign(m, cslBiblio(item));
  const doi = doiOf(s("DOI"));
  if (doi) m.doi = doi;
  const isbn = item.ISBN;
  return finish(m, typeof isbn === "string" ? isbn.split(/[;,\s]+/u) : Array.isArray(isbn) ? isbn.filter((x): x is string => typeof x === "string") : []);
}

export function parseOpf(text: string): SidecarMetadata {
  const m: SidecarMetadata = { type: "book" };
  const first = (tag: string) => {
    const v = dcValues(text, tag)[0]?.value;
    return v ? cap(v) : undefined;
  };
  const title = first("title");
  if (title) m.title = title;
  const creators = dcValues(text, "creator")
    .map((c) => parseName(cap(c.value)))
    .filter((c): c is Creator => !!c);
  if (creators.length) m.creators = creators;
  const issued = normalizeDate(first("date"));
  if (issued) m.issued = issued;
  const publisher = first("publisher");
  if (publisher) m.publisher = decodeEntities(publisher);
  const isbns: string[] = [];
  for (const id of dcValues(text, "identifier")) {
    const v = cap(id.value).replace(/^urn:/iu, "");
    if (/^isbn[:\s]/iu.test(v) || /opf:scheme\s*=\s*["']isbn/iu.test(cap(id.attrs))) isbns.push(v.replace(/^isbn[:\s]*/iu, ""));
    else if (!m.doi) m.doi = doiOf(v);
  }
  if (!m.doi) delete m.doi;
  return finish(m, isbns);
}
