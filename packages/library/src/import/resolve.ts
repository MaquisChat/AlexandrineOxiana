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
 * at least one local title (reference, embedded, file name), when any exists. An identifier found
 * in the file (not given as reference metadata) is confirmed by an embedded or file-name title only
 * when the two are equal after normalizeTitle (R58: a review titled "Review: <work>" citing the
 * work's DOI is not the work); a reference title keeps the ≥ 0.9 rule. A near match (≥ 0.9, not
 * equal) keeps the local values, leaves the identifier a hint and caps the confidence at 0.6, so
 * the item goes to review. Otherwise the local
 * values stay in the draft, the lookup becomes a candidate, the confidence is 0.6 and `/title` is
 * a conflict: the item goes to review (a DOI in a PDF's first pages may well be a cited work's).
 * With no local title, an identifier found only in the file's text is never the item's own (R57):
 * even when its work's title appears in the text (a citation names its title too), the lookup's
 * values are only offered for review, without the identifier, and the confidence is capped at
 * 0.6. A reference identifier with no reference title needs its work's title in the text.
 * Title searches (steps 5 and 6) never give identifiers.
 *
 * R55: an identifier taken from the file is written to the draft (and so used for duplicate
 * detection) only when a lookup confirmed it as above. Unconfirmed ones are returned as
 * `identifierHints` for the review queue, and the item goes to review. Identifiers from reference
 * metadata or a sidecar file are trusted as given.
 *
 * Lookups run only through the LookupContext the caller built with `lookupContextFor` (policy per
 * provider, sensitive for encrypted projects); `null` means no lookups at all.
 */
import { basename, extname } from "node:path";
import {
  AUTO_ACCEPT_THRESHOLD,
  BIBLIO_FIELDS,
  DOC_TEXT_LIMIT,
  biblioOf,
  EdtfLite,
  SourceDraft,
  applyVerification,
  groundedIn,
  normalizeTitle,
  parseFileName,
  primary,
  scoreConfidence,
  titleSimilarity,
  toIsbn13,
  verifyDraft,
  type Biblio,
  type BiblioField,
  type Creator,
  type Evidence,
  type FieldEvidence,
  type FileNamePattern,
  type LookupEvidence,
  type ParsedFileName,
  type SourceType,
  type VerificationReport,
} from "@ao/core";
import { extractMetadata, type Extracted } from "../extract/index.js";
import { parseName } from "../extract/names.js";
import { LookupHttpError, lookupDoi, lookupIsbn, searchTitle, type LookupContext, type LookupResult } from "../lookup/index.js";
import { readSidecar, type SidecarMetadata } from "./sidecar.js";

/**
 * Items at or above this confidence are accepted without review (R53). Defined in core, where it is
 * also the default of Bulk Import's per-batch `ImportOptions.autoAcceptThreshold` (R54, R59).
 */
export { AUTO_ACCEPT_THRESHOLD };
/** Candidate matches kept for the review queue. */
export const MAX_CANDIDATES = 3;
/** Identifier lookups tried per item (the first pages may cite other works' DOIs). */
const MAX_IDENTIFIER_LOOKUPS = 3;
/** Confidence of an identifier lookup whose title disagrees with the file's own title (R49e). */
const CONFLICT_CONFIDENCE = 0.6;
const AGREE = 0.9;

export interface ResolveInput {
  /** The file; absent for a metadata-only item (reference metadata, no file): nothing is extracted. */
  path?: string;
  /** The sniffed MIME type ("" for a metadata-only item). */
  mime?: string;
  referenceMetadata?: Partial<SourceDraft>;
  /** The evidence kind of the reference metadata (default refman; Zotero items: zotero, R72). */
  referenceSource?: FieldEvidence["source"];
  sidecarPaths?: string[];
  /** The name file-name patterns are matched against (default: the path's base name). */
  fileName?: string;
  /**
   * What a user pattern made of the name, when the caller ran the user patterns itself (Bulk Import
   * runs them under a watchdog, R49d). Given: used instead of the user patterns in `ctx.patterns`.
   */
  userParsedName?: ParsedFileName;
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
  /** Identifiers found in the file that no lookup confirmed, e.g. "doi:10.1/x" (never in the draft or used for dedupe). */
  identifierHints: string[];
  /** The file carries location data (GPS): location governance applies when it is stored (R54a). */
  hasLocation: boolean;
  /** The document could not be parsed at all (a damaged or password-protected PDF). */
  unreadable: boolean;
}

interface Fields extends Biblio {
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
  ...(Object.fromEntries(BIBLIO_FIELDS.map((k) => [k, `/${k}`])) as Record<BiblioField, string>),
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
    ...biblioOf(r),
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
    ...biblioOf(ref),
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
    ...biblioOf(m),
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
  const mime = input.mime ?? "";
  const extracted: Extracted = input.path ? await extractMetadata(input.path, mime) : { identifiers: { dois: [], isbns: [], arxiv: [] } };
  const fileName = input.fileName ?? (input.path ? basename(input.path) : "");
  const parsedName = !fileName ? null : (input.userParsedName ?? parseFileName(fileName, ctx.patterns));
  const ref = input.referenceMetadata ?? {};

  const values: Fields = {};
  /** Evidence per field; title evidence of every source is kept (see the module comment). */
  const evidence = new Map<keyof Fields, FieldEvidence[]>();
  const lookups: LookupEvidence[] = [];
  const candidates: LookupResult[] = [];
  let confidence = 0;
  let method: Evidence = { method: "none" };
  let titleConflict = false;
  /** Identifiers found in the file that no lookup confirmed (never in the draft, R55). */
  const hints: string[] = [];
  /** The item's identity rests on an unconfirmed identifier: it goes to review. */
  let unconfirmed = false;
  /** Upper bound on the final confidence (R58 near match). */
  let cap = 1;
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
  if (refFields.title) step(scoreConfidence({ method: "reference-metadata" }), { method: "reference-metadata" }, refFields, input.referenceSource ?? { kind: "refman", ref: "reference" });

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

  // 3. Identifiers (+ lookup). An identifier from the file (metadata fields or the first pages'
  //    text) is written to the draft only once a lookup confirms it: its title agrees with the
  //    file's own title, or, with no such title, is found in the document text (R55). Anything
  //    else (a cited work's DOI, an unanswered lookup) is only a hint for the review queue.
  if (!done()) {
    const fileTitles = [extracted.title, parsedName?.title].filter((t): t is string => !!t);
    const localTitles = refFields.title ? [refFields.title, ...fileTitles] : fileTitles;
    const docNorm = extracted.text ? normalizeTitle(extracted.text.slice(0, DOC_TEXT_LIMIT)) : "";
    const ids: Array<{ kind: "doi" | "isbn"; id: string; arxiv?: string; trusted: boolean }> = [];
    const addId = (x: (typeof ids)[number]) => {
      if (!ids.some((y) => y.id === x.id)) ids.push(x);
    };
    if (refFields.doi) addId({ kind: "doi", id: refFields.doi.toLowerCase(), trusted: true });
    for (const i of refFields.isbn ?? []) {
      const v = toIsbn13(i);
      if (v) addId({ kind: "isbn", id: v, trusted: true });
    }
    if (refFields.arxiv) addId({ kind: "doi", id: arxivDoi(refFields.arxiv), arxiv: refFields.arxiv, trusted: true });
    for (const d of extracted.identifiers.dois) addId({ kind: "doi", id: d.toLowerCase(), trusted: false });
    for (const i of extracted.identifiers.isbns) {
      const v = toIsbn13(i);
      if (v) addId({ kind: "isbn", id: v, trusted: false });
    }
    for (const x of extracted.identifiers.arxiv) addId({ kind: "doi", id: arxivDoi(x), arxiv: x, trusted: false });

    type Hit = { r: LookupResult; id: (typeof ids)[number]; sim: number };
    let accepted: Hit | undefined;
    let ungrounded: Hit | undefined;
    let conflict: Hit | undefined;
    /** A file identifier whose lookup title only nearly matches the file's own (R58). */
    let nearMatch: Hit | undefined;
    if (lookup) {
      for (const id of ids.slice(0, MAX_IDENTIFIER_LOOKUPS)) {
        const r = await ask(() => (id.kind === "doi" ? lookupDoi(id.id, lookup) : lookupIsbn(id.id, lookup)), null);
        if (!r) continue;
        lookups.push({ provider: r.provider, matchedIdentifier: id.id, title: r.title, ...(r.creators.length ? { creators: r.creators } : {}), ...(r.issued ? { issued: r.issued } : {}) });
        addCandidate(r);
        const sim = Math.max(0, ...localTitles.map((l) => titleSimilarity(l, r.title)));
        const hit = { r, id, sim };
        if (localTitles.length > 0) {
          if (sim >= AGREE) {
            // R58: an identifier from the file needs a reference title that agrees, or an embedded
            // or file-name title equal to the lookup's after normalization.
            const lookupNorm = normalizeTitle(r.title);
            const confirmedBy =
              id.trusted ||
              (!!refFields.title && titleSimilarity(refFields.title, r.title) >= AGREE) ||
              fileTitles.some((t) => normalizeTitle(t) === lookupNorm);
            if (confirmedBy) {
              accepted = hit;
              break;
            }
            nearMatch ??= hit;
            continue;
          }
          conflict ??= hit;
        } else if (id.trusted && docNorm && groundedIn(docNorm, normalizeTitle(r.title), "title")) {
          // A reference identifier whose work's title is in the text.
          accepted = hit;
          break;
        } else {
          // No title of the file's own (R57): a text-only identifier, even one whose work's title is
          // in the text (a citation names its title too), is never the item's own: review.
          ungrounded ??= hit;
        }
      }
    }
    const idFields = (h: Hit, base: Fields): Fields => {
      const fields = { ...base };
      if (h.id.arxiv) fields.arxiv = h.id.arxiv;
      else if (h.id.kind === "doi") fields.doi = h.id.id;
      else fields.isbn = [...new Set([h.id.id, ...(fields.isbn ?? [])])];
      return fields;
    };
    const confirmed = accepted?.id.id;
    for (const id of ids) {
      if (id.trusted || id.id === confirmed) continue;
      hints.push(id.arxiv ? `arxiv:${id.arxiv}` : `${id.kind}:${id.id}`);
    }
    if (accepted) {
      step(scoreConfidence({ method: "identifier+lookup" }), { method: "identifier+lookup" }, idFields(accepted, fromLookup(accepted.r)), {
        kind: "lookup",
        provider: accepted.r.provider,
      });
    } else if (ungrounded) {
      // Nothing of the file's own backs the lookup: its values are offered for review, without its
      // identifiers (unconfirmed), and the confidence is capped at 0.6.
      const { doi: _d, isbn: _i, issn: _s, ...rest } = fromLookup(ungrounded.r);
      offer(ungrounded.id.trusted ? idFields(ungrounded, rest) : rest, { kind: "lookup", provider: ungrounded.r.provider }, true);
      confidence = CONFLICT_CONFIDENCE;
      method = { method: "identifier+lookup" };
      unconfirmed = true;
    } else if (nearMatch) {
      // R58: the file's own values stay; the lookup is a candidate, its title evidence, and its
      // identifier a hint. Review, at most 0.6 whatever later steps find.
      record("title", nearMatch.r.title, { kind: "lookup", provider: nearMatch.r.provider });
      confidence = CONFLICT_CONFIDENCE;
      cap = CONFLICT_CONFIDENCE;
      method = { method: "identifier+lookup", titleSimilarity: Math.round(nearMatch.sim * 1000) / 1000 };
      unconfirmed = true;
    } else if (conflict) {
      // R49(e): keep the file's own values; the lookup is a candidate and its title is evidence.
      titleConflict = true;
      record("title", conflict.r.title, { kind: "lookup", provider: conflict.r.provider });
      confidence = CONFLICT_CONFIDENCE;
      method = { method: "identifier+lookup", titleSimilarity: Math.round(conflict.sim * 1000) / 1000 };
    }
    if (!accepted && hints.length > 0) unconfirmed = true;
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
        // A title search never names the item's identifiers (R57): they stay with the candidate.
        const { doi: _d, isbn: _i, issn: _s, ...rest } = fromLookup(best);
        step(scoreConfidence(e), e, rest, { kind: "lookup", provider: best.provider });
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
    const stem = (fileName ? basename(fileName, extname(fileName)).trim() : "") || "Untitled";
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
    type: values.type ?? typeFromMime(mime),
    title: titleMt,
    creators: values.creators ?? [],
    ...(values.container ? { container: ref.container && values.container === refFields.container ? ref.container : mt(values.container) } : {}),
    ...(values.publisher ? { publisher: values.publisher } : {}),
    ...biblioOf(values),
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
  if (titleConflict || unconfirmed) report.overall = "needs-review";
  if (unconfirmed && !titleConflict) {
    report.reasons.push(
      "An identifier found in the file could not be confirmed as this item's own (it may belong to a cited work), so it was not recorded.",
    );
  }
  return {
    draft,
    confidence: Math.min(applyVerification(confidence, report), cap),
    evidence: method,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    needsOcr: extracted.needsOcr === true,
    fieldEvidence,
    verification: report,
    titleConflict,
    identifierHints: hints.slice(0, 10),
    hasLocation: mayHaveLocation(mime, extracted),
    unreadable: extracted.readFailed === true,
  };
}

/** Media whose metadata may carry a location: images, video and audio (voice memos carry one too, R58). */
export const LOCATED_MEDIA = /^(?:image|video|audio)\//u;

/**
 * GPS found, a place named without coordinates (R85), or an image, video or audio file whose
 * metadata could not be read: location governance must apply (fail closed, R57, R58).
 */
export function mayHaveLocation(mime: string, extracted: Pick<Extracted, "media">): boolean {
  if (extracted.media?.gps || extracted.media?.locationText) return true;
  return LOCATED_MEDIA.test(mime) && extracted.media?.readFailed === true;
}

/** Reference fields resolution does not decide (collections, tags, case attributes ...). */
function stripResolved(ref: Partial<SourceDraft>): Partial<SourceDraft> {
  const { type: _t, title: _ti, creators: _c, issued: _i, container: _co, publisher: _p, identifiers: _id, ...rest } = ref;
  for (const k of BIBLIO_FIELDS) delete rest[k];
  return rest;
}
