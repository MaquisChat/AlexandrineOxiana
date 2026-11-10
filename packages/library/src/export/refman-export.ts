/**
 * Reference export (spec 5.1 "Zotero export"; Task 26, R78b): a project's sources as BibTeX,
 * RIS or CSL-JSON, for Zotero and other reference managers. Our own writers (citation-js was
 * rejected, R66), each read back exactly by our import adapters (refman.ts; round-trip tests):
 *
 *   - BibTeX: UTF-8; every value braced; `\ { } % & $ # _ ~ ^` escaped (`\textbackslash{}`,
 *     `\{`, `\%` …, `\textasciitilde{}`, `\textasciicircum{}`), `--` kept literal (`-{}-`), line
 *     breaks become spaces; names `{Family}, {Given}` (literal names `{Whole Name}`); URLs and DOIs
 *     verbatim with `{ } \` and spaces percent-encoded. Citation keys are kept; characters BibTeX
 *     cannot hold in a key become `_` (noted).
 *   - RIS: one `TAG  - value` line per value; any line break or control character in a value is a
 *     space, so a value can never start a line (no `ER  -` or `TY  -` injection).
 *   - CSL-JSON: `JSON.stringify` (standard escaping); `id` and `citation-key` = the citation key.
 * Citation keys are made unique within one export (a, b, c … appended, noted).
 *
 * Exported: type, title, creators (author / editor / translator), date, container, publisher,
 * DOI, ISBN, ISSN, URL, arXiv id (BibTeX), the citation key, and tags only with `includeTags`.
 * Never exported: file paths, notes, annotations, provenance.
 *
 * Governance: each source is evaluated with `evaluate({action:'export', export:{identifiable,
 * hasLocation:false}})` (no files or locations are exported). A deny refuses the whole export
 * (PolicyDeniedError, audited, nothing written); `deidentified-only` leaves identifiable sources
 * out with a note. One `export.refman` audit event records the format and counts (never the path).
 * `writeRefmanExport` writes the file atomically (0600) to the path the user chose.
 */
import type { Creator, Source, SourceType } from "@ao/core";
import { primary } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { appendLibraryEvent, authorizeProcessing, projectCollectionsAndTags, type Repo } from "../repo/repo.js";

export type RefmanFormat = "bibtex" | "ris" | "csl-json";
export const REFMAN_FORMATS: readonly RefmanFormat[] = ["bibtex", "ris", "csl-json"];

export interface RefmanExportOptions {
  /** Also export the sources' tags (keywords). Off by default: tag names can identify people (R64). */
  includeTags?: boolean;
}

export interface RefmanExportResult {
  text: string;
  exported: number;
  excluded: Array<{ sourceId: string; reason: string }>;
  notes: string[];
}

export const DEIDENTIFIED_NOTE = "This project allows only de-identified exports, and this source holds identifiable data.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const EXPORT_NOTES = {
  deidentified: (n: number) =>
    `${plural(n, "source was", "sources were")} left out because this project allows only de-identified exports and ${n === 1 ? "it holds" : "they hold"} identifiable data.`,
  keyChanged: (n: number) => `${plural(n, "citation key was", "citation keys were")} changed to be valid or unique in this export.`,
};

/** What one exported reference holds (no files, notes, annotations or provenance). */
interface Ref {
  key: string;
  type: SourceType;
  title: string;
  creators: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  doi?: string;
  isbn: string[];
  issn?: string;
  url?: string;
  arxiv?: string;
  tags: string[];
}

/** Collapses line breaks, tabs and control characters into single spaces. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/gu, " ").replace(/ {2,}/gu, " ").trim();

// ------------------------------------------------------------------------------------------
// BibTeX

const BIB_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** A text value for inside `{…}`: special characters escaped, `--` kept literal, one line. UTF-8 is kept as is. */
export function escapeBibtex(s: string): string {
  const t = oneLine(s);
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === "-" && t[i + 1] === "-") out += "-{}";
    else out += BIB_ESCAPES[c] ?? c;
  }
  return out;
}

/** A URL or DOI, verbatim except what would break the value. */
const bibVerbatim = (s: string) => oneLine(s).replace(/[{}\\ ]/gu, (c) => encodeURIComponent(c));

const BIB_TYPE: Partial<Record<SourceType, string>> = {
  "article-journal": "article", book: "book", chapter: "incollection", thesis: "phdthesis", report: "techreport",
  webpage: "online", dataset: "dataset", manuscript: "unpublished",
};

/** A valid BibTeX key (letters, digits and `_ : . - + /`). */
const bibKey = (k: string) => k.replace(/[^\p{L}\p{N}_:.+/-]/gu, "_");

function bibName(c: Creator): string | undefined {
  if (c.family) return `{${escapeBibtex(c.family)}}, ${c.given ? `{${escapeBibtex(c.given)}}` : ""}`.trimEnd();
  const whole = c.literal ?? c.given;
  return whole ? `{${escapeBibtex(whole)}}` : undefined;
}

function toBibtex(refs: Ref[]): string {
  const out: string[] = ["% Exported by Alexandrine Oxiana (UTF-8)", ""];
  for (const r of refs) {
    const f: Array<[string, string]> = [];
    const text = (name: string, v: string | undefined) => {
      if (v) f.push([name, `{${escapeBibtex(v)}}`]);
    };
    const names = (role: "author" | "editor" | "translator") =>
      roleOf(r.creators, role)
        .map(bibName)
        .filter((x): x is string => !!x)
        .join(" and ");
    text("title", r.title);
    for (const role of ["author", "editor", "translator"] as const) {
      const n = names(role);
      if (n) f.push([role, `{${n}}`]);
    }
    if (r.issued) {
      f.push(["date", `{${escapeBibtex(r.issued)}}`]);
      f.push(["year", `{${escapeBibtex(r.issued.slice(0, 4))}}`]);
    }
    text(r.type === "article-journal" || r.type === "preprint" ? "journal" : "booktitle", r.container);
    text("publisher", r.publisher);
    if (r.doi) f.push(["doi", `{${bibVerbatim(r.doi)}}`]);
    if (r.isbn.length) f.push(["isbn", `{${escapeBibtex(r.isbn.join(", "))}}`]);
    text("issn", r.issn);
    if (r.url) f.push(["url", `{${bibVerbatim(r.url)}}`]);
    if (r.arxiv) {
      f.push(["eprint", `{${escapeBibtex(r.arxiv)}}`]);
      f.push(["archiveprefix", "{arXiv}"]);
    }
    if (r.tags.length) text("keywords", r.tags.join(", "));
    out.push(`@${BIB_TYPE[r.type] ?? "misc"}{${r.key},`, ...f.map(([k, v]) => `  ${k} = ${v},`), "}", "");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------
// RIS

const RIS_TYPE: Partial<Record<SourceType, string>> = {
  "article-journal": "JOUR", book: "BOOK", chapter: "CHAP", report: "RPRT", thesis: "THES", dataset: "DATA", webpage: "ELEC",
  presentation: "SLIDE", manuscript: "MANSCPT", audio: "AUDIO", video: "VIDEO", image: "ART",
};

/** One RIS line: the value on one line, so it can never start a new tag (no `ER  -` injection). */
export function risLine(tag: string, value: string): string {
  return `${tag}  - ${oneLine(value)}`;
}

function risName(c: Creator): string | undefined {
  if (c.family) return c.given ? `${c.family}, ${c.given}` : c.family;
  return c.literal ?? c.given;
}

function toRis(refs: Ref[]): string {
  const out: string[] = [];
  for (const r of refs) {
    const add = (tag: string, v: string | undefined) => {
      if (v && oneLine(v)) out.push(risLine(tag, v));
    };
    out.push(risLine("TY", RIS_TYPE[r.type] ?? "GEN"));
    add("ID", r.key);
    add("TI", r.title);
    for (const [role, tag] of [["author", "AU"], ["editor", "ED"], ["translator", "A4"]] as const) for (const c of roleOf(r.creators, role)) add(tag, risName(c));
    if (r.issued) add("PY", r.issued.split("-").join("/"));
    add("T2", r.container);
    add("PB", r.publisher);
    add("DO", r.doi);
    for (const i of r.isbn) add("SN", i);
    add("SN", r.issn);
    add("UR", r.url);
    for (const t of r.tags) add("KW", t);
    out.push("ER  - ", "");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------
// CSL-JSON

const CSL_TYPE: Partial<Record<SourceType, string>> = {
  "article-journal": "article-journal", book: "book", chapter: "chapter", report: "report", thesis: "thesis", webpage: "webpage",
  dataset: "dataset", manuscript: "manuscript", presentation: "speech", preprint: "article", audio: "song", video: "motion_picture",
  image: "graphic", interview: "interview", "social-post": "post",
};

function cslName(c: Creator): Record<string, string> | undefined {
  if (c.family) return { family: c.family, ...(c.given ? { given: c.given } : {}) };
  const literal = c.literal ?? c.given;
  return literal ? { literal } : undefined;
}

function toCslJson(refs: Ref[]): string {
  const items = refs.map((r) => {
    const people = (role: "author" | "editor" | "translator") => roleOf(r.creators, role).map(cslName).filter((x) => !!x);
    const parts = r.issued ? r.issued.split("-").map(Number).filter((n) => Number.isInteger(n)) : [];
    const o: Record<string, unknown> = { id: r.key, "citation-key": r.key, type: CSL_TYPE[r.type] ?? "document", title: r.title };
    for (const role of ["author", "editor", "translator"] as const) {
      const p = people(role);
      if (p.length) o[role] = p;
    }
    if (parts.length) o.issued = { "date-parts": [parts] };
    if (r.container) o["container-title"] = r.container;
    if (r.publisher) o.publisher = r.publisher;
    if (r.doi) o.DOI = r.doi;
    if (r.isbn.length) o.ISBN = r.isbn.join(", ");
    if (r.issn) o.ISSN = r.issn;
    if (r.url) o.URL = r.url;
    if (r.tags.length) o.keyword = r.tags.join(", ");
    return o;
  });
  return `${JSON.stringify(items, null, 2)}\n`;
}

// ------------------------------------------------------------------------------------------

/** Creators that go in the `role` list: editors and translators in theirs, everyone else as authors. */
function roleOf(creators: Creator[], role: "author" | "editor" | "translator"): Creator[] {
  return creators.filter((c) => (role === "author" ? c.role !== "editor" && c.role !== "translator" : c.role === role));
}

function refOf(s: Source, tagNames: Map<string, string>, includeTags: boolean): Omit<Ref, "key"> {
  return {
    type: s.type,
    title: primary(s.title),
    creators: s.creators,
    ...(s.issued ? { issued: s.issued } : {}),
    ...(s.container && primary(s.container) ? { container: primary(s.container) } : {}),
    ...(s.publisher ? { publisher: s.publisher } : {}),
    ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}),
    isbn: s.identifiers.isbn ?? [],
    ...(s.identifiers.issn ? { issn: s.identifiers.issn } : {}),
    ...(s.identifiers.url ? { url: s.identifiers.url } : {}),
    ...(s.identifiers.arxiv ? { arxiv: s.identifiers.arxiv } : {}),
    tags: includeTags ? s.tagIds.map((id) => tagNames.get(id)).filter((t): t is string => !!t) : [],
  };
}

/**
 * The export text of `sourceIds` (in that order). Throws PolicyDeniedError when the project's
 * rules refuse the export of any of them (audited; nothing is produced).
 */
export async function exportRefman(
  repo: Repo,
  projectId: string,
  sourceIds: string[],
  format: RefmanFormat,
  opts: RefmanExportOptions = {},
): Promise<RefmanExportResult> {
  if (!REFMAN_FORMATS.includes(format)) throw new TypeError(`unknown export format "${String(format)}"`);
  repo.getProject(projectId);
  const tagNames = new Map<string, string>();
  if (opts.includeTags) for (const t of (await projectCollectionsAndTags(repo, projectId)).tags) tagNames.set(t.id, t.name);
  const refs: Ref[] = [];
  const excluded: RefmanExportResult["excluded"] = [];
  const used = new Set<string>();
  let changedKeys = 0;
  for (const id of [...new Set(sourceIds)]) {
    const sf = await repo.getSource(projectId, id);
    const s = sf.source;
    // No files or locations are exported, only reference metadata.
    const d = await authorizeProcessing(
      repo,
      projectId,
      { action: "export", export: { identifiable: s.provenance.identifiable, hasLocation: false } },
      { op: "export.refman", entity: { type: "source", id } },
    );
    if (d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "deidentified-only")) {
      excluded.push({ sourceId: id, reason: DEIDENTIFIED_NOTE });
      continue;
    }
    const wanted = s.citationKey.trim() || `ref${refs.length + 1}`;
    let key = format === "bibtex" ? bibKey(wanted) : oneLine(wanted);
    if (used.has(key.toLowerCase())) {
      let n = 0;
      const base = key;
      do key = `${base}${suffix(n++)}`;
      while (used.has(key.toLowerCase()));
    }
    if (key !== s.citationKey) changedKeys++;
    used.add(key.toLowerCase());
    refs.push({ key, ...refOf(s, tagNames, opts.includeTags === true) });
  }
  const text = format === "bibtex" ? toBibtex(refs) : format === "ris" ? toRis(refs) : toCslJson(refs);
  const notes: string[] = [];
  if (excluded.length) notes.push(EXPORT_NOTES.deidentified(excluded.length));
  if (changedKeys) notes.push(EXPORT_NOTES.keyChanged(changedKeys));
  await appendLibraryEvent(repo, projectId, "export.refman", { format, exported: refs.length, excluded: excluded.length, includeTags: opts.includeTags === true });
  return { text, exported: refs.length, excluded, notes };
}

/** a … z, aa, ab … */
function suffix(n: number): string {
  let s = "";
  for (let i = n; ; i = Math.floor(i / 26) - 1) {
    s = String.fromCharCode(97 + (i % 26)) + s;
    if (i < 26) return s;
  }
}

/** exportRefman, then the text written atomically (0600) to `outputPath`. Nothing is written when the export is refused. */
export async function writeRefmanExport(
  repo: Repo,
  projectId: string,
  sourceIds: string[],
  format: RefmanFormat,
  outputPath: string,
  opts: RefmanExportOptions = {},
): Promise<RefmanExportResult> {
  const r = await exportRefman(repo, projectId, sourceIds, format, opts);
  await writeFileAtomic(outputPath, r.text, { mode: 0o600 });
  return r;
}
