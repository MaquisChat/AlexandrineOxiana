/**
 * Metadata resolution for one imported file (spec 5.4 step 3; R49e, R53). Sources are tried in the
 * spec's order, stopping as soon as the confidence reaches AUTO_ACCEPT_THRESHOLD:
 *
 *   1. reference metadata handed in by the caller (Zotero, BibTeX/RIS, Calibre)   0.90
 *   2. embedded file metadata (PDF Info/XMP, EPUB OPF, EXIF)                        0.70 / 0.55
 *   3. DOI / ISBN / arXiv id (metadata fields, first pages of text) + lookup         0.97
 *   4. sidecar files next to the item (.bib, .ris, .json, .opf)                     0.85
 *   5. file-name patterns (+ title lookup)                                          0.50 / ≤ 0.80
 *   6. title search                                                                  ≤ 0.80
 *
 * A step that scores higher than what is known so far overrides the fields it gives; a weaker step
 * only fills gaps. Every value used is recorded as FieldEvidence (kind per source: `refman` for
 * reference metadata and sidecars, `embedded`, `filename`, `lookup` with the provider's name).
 * Title evidence from every source is kept even when another source's title wins, so a
 * disagreement shows up in verification; other overridden values are dropped (a PDF's Author or
 * CreationDate field is often not the work's). Then `verifyDraft` runs against the extracted
 * document text and the identifier lookups, and `applyVerification` lowers the confidence of a
 * draft that needs review.
 *
 * R49(e): an identifier lookup scores 0.97 only when its title agrees (titleSimilarity ≥ 0.9) with
 * at least one local title (reference, embedded, file name), when any exists. Otherwise the local
 * values stay in the draft, the lookup becomes a candidate, the confidence is 0.6 and `/title` is
 * a conflict: the item goes to review (a DOI in a PDF's first pages may well be a cited work's).
 *
 * Lookups run only through the LookupContext the caller built with `lookupContextFor` (policy per
 * provider, sensitive for encrypted projects); `null` means no lookups at all.
 */
import { basename, extname } from "node:path";
import {
  EdtfLite,
  SourceDraft,
  applyVerification,
  parseFileName,
  primary,
  scoreConfidence,
  titleSimilarity,
  toIsbn13,
  verifyDraft,
  type Creator,
  type Evidence,
  type FieldEvidence,
  type FileNamePattern,
  type LookupEvidence,
  type SourceType,
  type VerificationReport,
} from "@ao/core";
import { extractMetadata, type Extracted } from "../extract/index.js";
import { parseName } from "../extract/names.js";
import { LookupHttpError, lookupDoi, lookupIsbn, searchTitle, type LookupContext, type LookupResult } from "../lookup/index.js";
import { readSidecar, type SidecarMetadata } from "./sidecar.js";

/**
 * Items at or above this confidence are accepted without review. Neither the project model nor the
 * governance model has a per-project setting for it yet (Bulk Import's per-batch
 * `ImportOptions.autoAcceptThreshold` is a batch option), so this is the default (R53).
 */
export const AUTO_ACCEPT_THRESHOLD = 0.9;
/** Candidate matches kept for the review queue. */
export const MAX_CANDIDATES = 3;
/** Identifier lookups tried per item (the first pages may cite other works' DOIs). */
const MAX_IDENTIFIER_LOOKUPS = 3;
/** Confidence of an identifier lookup whose title disagrees with the file's own title (R49e). */
const CONFLICT_CONFIDENCE = 0.6;
const AGREE = 0.9;

export interface ResolveInput {
  path: string;
  /** The sniffed MIME type. */
  mime: string;
  referenceMetadata?: Partial<SourceDraft>;
  sidecarPaths?: string[];
  /** The name file-name patterns are matched against (default: the path's base name). */
  fileName?: string;
}

export interface ResolveContext {
  projectId: string;
  /** User file-name patterns (vetted by the caller, see parseFileName). */
  patterns: FileNamePattern[];
  /** From `lookupContextFor` (project policy per provider; sensitive when encrypted). null: no lookups. */
  lookup: LookupContext | null;
  /** Time stamped on the evidence (default: now). */
  clock?: () => Date;
}

export interface Resolution {
  draft: SourceDraft;
  /** After verification (`applyVerification`). */
  confidence: number;
  /** Which method produced the identification (stored in provenance). */
  evidence: Evidence;
  /** Up to 3 candidate matches for the review queue. */
  candidates: LookupResult[];
  needsOcr: boolean;
  /** Per-field evidence for every value the draft uses (plus every source's title). */
  fieldEvidence: FieldEvidence[];
  verification: VerificationReport;
  /** An identifier lookup's title disagreed with the file's own title (R49e). */
  titleConflict: boolean;
}

interface Fields {
  type?: SourceType;
  title?: string;
  creators?: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  doi?: string;
  isbn?: string[];
  issn?: string;
  arxiv?: string;
}

type EvidenceSource = FieldEvidence["source"];

const POINTER: Record<keyof Fields, string> = {
  type: "/type",
  title: "/title",
  creators: "/creators",
  issued: "/issued",
  container: "/container",
  publisher: "/publisher",
  doi: "/identifiers/doi",
  isbn: "/identifiers/isbn",
  issn: "/identifiers/issn",
  arxiv: "/identifiers/arxiv",
};

const KEYS = Object.keys(POINTER) as Array<keyof Fields>;

const present = (v: unknown) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

function typeFromMime(mime: string): SourceType {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/epub+zip" || m.includes("mobipocket") || m.includes("amazon")) return "book";
  return "other";
}

function fromLookup(r: LookupResult): Fields {
  return {
    ...(r.type !== "other" ? { type: r.type } : {}),
    title: r.title,
    ...(r.creators.length ? { creators: r.creators } : {}),
    ...(r.issued ? { issued: r.issued } : {}),
    ...(r.container ? { container: r.container } : {}),
    ...(r.publisher ? { publisher: r.publisher } : {}),
    ...(r.identifiers.doi ? { doi: r.identifiers.doi } : {}),
    ...(r.identifiers.isbn?.length ? { isbn: r.identifiers.isbn } : {}),
    ...(r.identifiers.issn ? { issn: r.identifiers.issn } : {}),
  };
}

function fromReference(ref: Partial<SourceDraft>): Fields {
  const title = ref.title ? primary(ref.title).trim() : "";
  const container = ref.container ? primary(ref.container).trim() : "";
  const ids = ref.identifiers ?? {};
  return {
    ...(ref.type ? { type: ref.type } : {}),
    ...(title ? { title } : {}),
    ...(ref.creators?.length ? { creators: ref.creators } : {}),
    ...(ref.issued ? { issued: ref.issued } : {}),
    ...(container ? { container } : {}),
    ...(ref.publisher ? { publisher: ref.publisher } : {}),
    ...(ids.doi ? { doi: ids.doi } : {}),
    ...(ids.isbn?.length ? { isbn: ids.isbn } : {}),
    ...(ids.issn ? { issn: ids.issn } : {}),
    ...(ids.arxiv ? { arxiv: ids.arxiv } : {}),
  };
}

function fromSidecar(m: SidecarMetadata): Fields {
  return {
    ...(m.type && m.type !== "other" ? { type: m.type } : {}),
    ...(m.title ? { title: m.title } : {}),
    ...(m.creators?.length ? { creators: m.creators } : {}),
    ...(m.issued ? { issued: m.issued } : {}),
    ...(m.container ? { container: m.container } : {}),
    ...(m.publisher ? { publisher: m.publisher } : {}),
    ...(m.doi ? { doi: m.doi } : {}),
    ...(m.isbn?.length ? { isbn: m.isbn } : {}),
  };
}

const firstCreatorName = (cs: Creator[] | undefined) => {
  const c = cs?.[0];
  return c ? c.family ?? c.literal ?? c.handle : undefined;
};

/** arXiv id → its DataCite DOI (version dropped), e.g. 2401.12345v2 → 10.48550/arxiv.2401.12345. */
const arxivDoi = (id: string) => `10.48550/arxiv.${id.replace(/v\d+$/u, "").toLowerCase()}`;

export async function resolveItem(input: ResolveInput, ctx: ResolveContext): Promise<Resolution> {
  const at = (ctx.clock?.() ?? new Date()).toISOString();
  const lookup = ctx.lookup;
  const extracted: Extracted = await extractMetadata(input.path, input.mime);
  const fileName = input.fileName ?? basename(input.path);
  const parsedName = parseFileName(fileName, ctx.patterns);
  const ref = input.referenceMetadata ?? {};

  const values: Fields = {};
  /** Evidence per field; title evidence of every source is kept (see the module comment). */
  const evidence = new Map<keyof Fields, FieldEvidence[]>();
  const lookups: LookupEvidence[] = [];
  const candidates: LookupResult[] = [];
  let confidence = 0;
  let method: Evidence = { method: "none" };
  let titleConflict = false;
  const done = () => confidence >= AUTO_ACCEPT_THRESHOLD;

  const record = (k: keyof Fields, value: unknown, source: EvidenceSource) => {
    const list = evidence.get(k) ?? [];
    list.push({ field: POINTER[k], value, source, at });
    evidence.set(k, list);
  };
  /** Uses a source's values: override what is known when it scores higher, else fill gaps only. */
  const offer = (fields: Fields, source: EvidenceSource, override: boolean) => {
    for (const k of KEYS) {
      const v = fields[k];
      if (!present(v)) continue;
      if (override || !present(values[k])) {
        // An overridden value's evidence goes, except for titles (R49e).
        if (k !== "title") evidence.delete(k);
        (values as Record<string, unknown>)[k] = v;
        record(k, v, source);
      } else if (k === "title") {
        record(k, v, source);
      }
    }
  };
  const step = (score: number, e: Evidence, fields: Fields, source: EvidenceSource) => {
    const better = score > confidence;
    offer(fields, source, better);
    if (better) {
      confidence = score;
      method = e;
    }
  };
  const addCandidate = (r: LookupResult) => {
    const key = `${r.provider}|${r.identifiers.doi ?? ""}|${r.title.toLowerCase()}`;
    if (!candidates.some((c) => `${c.provider}|${c.identifiers.doi ?? ""}|${c.title.toLowerCase()}` === key)) candidates.push(r);
  };
  const ask = async <T>(fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LookupHttpError)) throw e;
      lookup?.debug?.(`metadata lookup failed: ${e.message}`);
      return empty;
    }
  };
  const searched = new Set<string>();
  /** Title search; returns the best result and its similarity (results kept as candidates, best first). */
  const search = async (title: string, creator: string | undefined): Promise<{ best?: LookupResult; sim: number }> => {
    const q = `${title}\u0000${creator ?? ""}`.toLowerCase();
    if (!lookup || searched.has(q)) return { sim: 0 };
    searched.add(q);
    const rs = await ask(() => searchTitle(title, creator, lookup), [] as LookupResult[]);
    const ranked = rs.map((r) => ({ r, sim: titleSimilarity(title, r.title) })).sort((a, b) => b.sim - a.sim);
    for (const { r } of ranked) addCandidate(r);
    return ranked[0] ? { best: ranked[0].r, sim: ranked[0].sim } : { sim: 0 };
  };

  // 1. Reference metadata.
  const refFields = fromReference(ref);
  if (refFields.title) step(scoreConfidence({ method: "reference-metadata" }), { method: "reference-metadata" }, refFields, { kind: "refman", ref: "reference" });

  // 2. Embedded metadata.
  if (!done() && (extracted.title || extracted.creators?.length)) {
    const e: Evidence = { method: "embedded", hasTitle: !!extracted.title, hasCreator: !!extracted.creators?.length };
    step(scoreConfidence(e), e, {
      ...(extracted.title ? { title: extracted.title } : {}),
      ...(extracted.creators?.length ? { creators: extracted.creators } : {}),
      ...(extracted.issued ? { issued: extracted.issued } : {}),
    }, { kind: "embedded" });
  } else if (done() && extracted.title) {
    record("title", extracted.title, { kind: "embedded" });
  }

  // 3. Identifiers (+ lookup).
  if (!done()) {
    const localTitles = [refFields.title, extracted.title, parsedName?.title].filter((t): t is string => !!t);
    const agrees = (t: string) => localTitles.length === 0 || localTitles.some((l) => titleSimilarity(l, t) >= AGREE);
    const ids: Array<{ kind: "doi" | "isbn"; id: string; arxiv?: string }> = [];
    for (const d of [refFields.doi, ...extracted.identifiers.dois]) if (d && !ids.some((x) => x.id === d.toLowerCase())) ids.push({ kind: "doi", id: d.toLowerCase() });
    for (const i of [...(refFields.isbn ?? []), ...extracted.identifiers.isbns]) {
      const v = toIsbn13(i);
      if (v && !ids.some((x) => x.id === v)) ids.push({ kind: "isbn", id: v });
    }
    for (const a of [refFields.arxiv, ...extracted.identifiers.arxiv]) if (a) ids.push({ kind: "doi", id: arxivDoi(a), arxiv: a });
    let conflict: { r: LookupResult; id: (typeof ids)[number]; sim: number } | undefined;
    let accepted = false;
    if (lookup) {
      for (const id of ids.slice(0, MAX_IDENTIFIER_LOOKUPS)) {
        const r = await ask(() => (id.kind === "doi" ? lookupDoi(id.id, lookup) : lookupIsbn(id.id, lookup)), null);
        if (!r) continue;
        lookups.push({ provider: r.provider, matchedIdentifier: id.id, title: r.title, ...(r.creators.length ? { creators: r.creators } : {}), ...(r.issued ? { issued: r.issued } : {}) });
        addCandidate(r);
        if (agrees(r.title)) {
          const fields = fromLookup(r);
          if (id.kind === "doi" && !id.arxiv) fields.doi = id.id;
          if (id.kind === "isbn") fields.isbn = [...new Set([id.id, ...(fields.isbn ?? [])])];
          if (id.arxiv) fields.arxiv = id.arxiv;
          step(scoreConfidence({ method: "identifier+lookup" }), { method: "identifier+lookup" }, fields, { kind: "lookup", provider: r.provider });
          accepted = true;
          break;
        }
        conflict ??= { r, id, sim: Math.max(0, ...localTitles.map((l) => titleSimilarity(l, r.title))) };
      }
    }
    if (!accepted && conflict) {
      // R49(e): keep the file's own values; the lookup is a candidate and its title is evidence.
      titleConflict = true;
      const src: EvidenceSource = { kind: "lookup", provider: conflict.r.provider };
      record("title", conflict.r.title, src);
      const idField: Fields = conflict.id.arxiv ? { arxiv: conflict.id.arxiv } : conflict.id.kind === "doi" ? { doi: conflict.id.id } : { isbn: [conflict.id.id] };
      offer(idField, { kind: "embedded", ref: "identifier" }, false);
      confidence = CONFLICT_CONFIDENCE;
      method = { method: "identifier+lookup", titleSimilarity: Math.round(conflict.sim * 1000) / 1000 };
    } else if (!accepted && ids.length === 1) {
      // Nothing confirmed it (lookups off or unanswered): a single identifier is still kept.
      const only = ids[0]!;
      offer(only.arxiv ? { arxiv: only.arxiv } : only.kind === "doi" ? { doi: only.id } : { isbn: [only.id] }, { kind: "embedded", ref: "identifier" }, false);
    }
  }

  // 4. Sidecar files.
  if (!done() && !titleConflict) {
    for (const p of input.sidecarPaths ?? []) {
      const m = await readSidecar(p);
      if (!m) continue;
      step(scoreConfidence({ method: "sidecar" }), { method: "sidecar" }, fromSidecar(m), { kind: "refman", ref: `sidecar${extname(p).toLowerCase()}` });
      break;
    }
  }

  // 5. File name (+ lookup).
  if (!done() && !titleConflict && parsedName) {
    const creator = parsedName.creator ? parseName(parsedName.creator) : undefined;
    const fields: Fields = {
      ...(parsedName.title ? { title: parsedName.title } : {}),
      ...(creator ? { creators: [creator] } : {}),
      ...(parsedName.year && EdtfLite.safeParse(parsedName.year).success ? { issued: parsedName.year } : {}),
    };
    step(scoreConfidence({ method: "filename" }), { method: "filename" }, fields, { kind: "filename" });
    if (parsedName.title) {
      const { best, sim } = await search(parsedName.title, parsedName.creator);
      if (best && sim >= AGREE) {
        const e: Evidence = { method: "filename+lookup", titleSimilarity: sim };
        step(scoreConfidence(e), e, fromLookup(best), { kind: "lookup", provider: best.provider });
      }
    }
  }

  // 6. Title search with the best title known so far.
  if (!done() && !titleConflict && values.title) {
    const { best, sim } = await search(values.title, firstCreatorName(values.creators));
    if (best && sim >= AGREE) {
      const e: Evidence = { method: "lookup-title-match", titleSimilarity: sim };
      const { doi: _d, isbn: _i, issn: _s, ...rest } = fromLookup(best);
      step(scoreConfidence(e), e, rest, { kind: "lookup", provider: best.provider });
    }
  }

  // Nothing named the item: its file name stands in for the title.
  if (!values.title) {
    const stem = basename(fileName, extname(fileName)).trim() || "Untitled";
    offer({ title: stem }, { kind: "filename" }, false);
  }
  if (confidence === 0) confidence = scoreConfidence({ method: "none" });

  const lang = (extracted.language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(extracted.language) ? extracted.language : undefined) ?? ref.title?.variants[0]?.lang ?? "und";
  const mt = (value: string, l = lang) => ({ variants: [{ lang: l, kind: "original" as const, value }] });
  const titleMt = ref.title && values.title === refFields.title ? ref.title : mt(values.title!);
  const issued = values.issued && EdtfLite.safeParse(values.issued).success ? values.issued : undefined;
  if (!issued) evidence.delete("issued");
  const draft = SourceDraft.parse({
    projectIds: [],
    caseAttributes: {},
    collectionIds: [],
    tagIds: [],
    participantIds: [],
    ...stripResolved(ref),
    type: values.type ?? typeFromMime(input.mime),
    title: titleMt,
    creators: values.creators ?? [],
    ...(values.container ? { container: ref.container && values.container === refFields.container ? ref.container : mt(values.container) } : {}),
    ...(values.publisher ? { publisher: values.publisher } : {}),
    ...(issued ? { issued } : {}),
    identifiers: {
      ...(ref.identifiers ?? {}),
      ...(values.doi ? { doi: values.doi } : {}),
      ...(values.isbn?.length ? { isbn: values.isbn } : {}),
      ...(values.issn ? { issn: values.issn } : {}),
      ...(values.arxiv ? { arxiv: values.arxiv } : {}),
    },
  });

  const fieldEvidence = [...evidence.values()].flat();
  const report = verifyDraft(draft, fieldEvidence, { ...(extracted.text ? { documentText: extracted.text } : {}), lookups });
  if (titleConflict && report.fields["/title"]?.status !== "conflict") {
    // verifyDraft normally flags this itself (cross-source); make sure the review sees it.
    const reason = "The identifier found in the file belongs to a work with a different title than the file's own.";
    report.fields["/title"] = { status: "conflict", checks: ["identifier-title"], reason };
    report.reasons.push(reason);
  }
  if (titleConflict) report.overall = "needs-review";
  return {
    draft,
    confidence: applyVerification(confidence, report),
    evidence: method,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    needsOcr: extracted.needsOcr === true,
    fieldEvidence,
    verification: report,
    titleConflict,
  };
}

/** Reference fields resolution does not decide (collections, tags, case attributes ...). */
function stripResolved(ref: Partial<SourceDraft>): Partial<SourceDraft> {
  const { type: _t, title: _ti, creators: _c, issued: _i, container: _co, publisher: _p, identifiers: _id, ...rest } = ref;
  return rest;
}
