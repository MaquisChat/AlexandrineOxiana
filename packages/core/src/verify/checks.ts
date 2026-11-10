import type { FieldEvidence, FieldVerification, SourceType } from "../model/index.js";
import {
  clip, datesEqual, getByPointer, handleKey, isRecord, normalizeTitle, parseEdtf, snapshotDates,
  sourceKey, textOf, textVariants, titleSimilarity, TRUSTED_KINDS,
} from "./evidence.js";
import type { LookupEvidence } from "./evidence.js";

/** Everything one field check needs; built once per verifyDraft call. */
export interface CheckCtx {
  type: string;
  draft: Record<string, unknown>;
  /** Stored evidence plus synthetic evidence from lookups, for ALL fields. */
  evidence: FieldEvidence[];
  documentText?: string;
  /** Normalized, capped document text ("" when absent). */
  docNorm: string;
  snapshot?: Record<string, unknown>;
  lookups: LookupEvidence[];
}

export const FIELD_LABELS: Record<string, string> = {
  "/title": "Title",
  "/creators": "Creators",
  "/issued": "Publication date",
  "/container": "Container (journal or site name)",
  "/publisher": "Publisher",
  "/identifiers/platformPostId": "Post ID",
  "/identifiers/url": "Link",
  "/identifiers/doi": "DOI",
  "/identifiers/isbn": "ISBN",
};
export const labelOf = (field: string): string => FIELD_LABELS[field] ?? `Field ${field}`;

const SOCIAL: ReadonlySet<string> = new Set<SourceType>(["social-post", "video"]);
const PLATFORM_TEXT_KEYS = ["title", "fulltitle", "caption", "description", "text"];
const PLATFORM_NAME_KEYS = ["uploader", "uploader_id", "channel", "owner_username"];

function snapStrings(snap: Record<string, unknown> | undefined, keys: string[]): string[] {
  if (!snap) return [];
  return keys.flatMap((k) => (typeof snap[k] === "string" || typeof snap[k] === "number" ? [String(snap[k])] : []));
}
const snapNorm = (snap: Record<string, unknown> | undefined, keys: string[]) =>
  snapStrings(snap, keys).map(normalizeTitle).filter(Boolean);

function evidenceFor(c: CheckCtx, field: string): FieldEvidence[] {
  return c.evidence.filter((e) => e.field === field);
}

export function creatorList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
function firstFamily(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  const first = creatorList(v)[0];
  if (!first) return undefined;
  for (const k of ["family", "literal", "handle"]) if (typeof first[k] === "string" && first[k]) return first[k] as string;
  return undefined;
}

/** Do two evidence values for this field say the same thing (at the precision we care about)? */
export function agree(field: string, a: unknown, b: unknown): boolean {
  if (field === "/title" || field === "/container") {
    const x = textOf(a), y = textOf(b);
    return x !== undefined && y !== undefined && titleSimilarity(x, y) >= 0.9;
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && datesEqual(x, y);
  }
  if (field === "/creators") {
    const x = firstFamily(a), y = firstFamily(b);
    return x !== undefined && y !== undefined && normalizeTitle(x) === normalizeTitle(y);
  }
  return JSON.stringify(a) === JSON.stringify(b) || (textOf(a) !== undefined && textOf(a)!.trim().toLowerCase() === textOf(b)?.trim().toLowerCase());
}

const result = (status: FieldVerification["status"], checks: string[], reason?: string, values?: FieldVerification["values"]): FieldVerification => ({
  status, checks, ...(reason ? { reason } : {}), ...(values ? { values } : {}),
});

// ---------------------------------------------------------------- platform identity

export function checkPlatformIdentity(field: string, c: CheckCtx): FieldVerification | undefined {
  const snap = c.snapshot;
  if (!snap) return undefined;
  const id = typeof snap.id === "string" || typeof snap.id === "number" ? String(snap.id) : undefined;
  const label = labelOf(field);

  if (field === "/identifiers/platformPostId" || field === "/identifiers/url") {
    if (id === undefined) return undefined;
    const postId = getByPointer(c.draft, "/identifiers/platformPostId");
    const url = getByPointer(c.draft, "/identifiers/url");
    if (field === "/identifiers/platformPostId") {
      if (typeof postId !== "string") return undefined;
      if (postId !== id) return result("conflict", ["platform-id"], `The post ID "${clip(postId)}" does not match the ID recorded when the post was captured ("${clip(id)}").`);
      if (typeof url === "string" && !url.includes(postId)) return result("conflict", ["platform-id"], `The post ID "${clip(postId)}" does not appear in the link.`);
      return result("verified", ["platform-id"]);
    }
    if (typeof url !== "string") return undefined;
    if (!url.includes(id)) return result("conflict", ["platform-id"], `The link does not contain the post ID recorded when the post was captured ("${clip(id)}").`);
    return result("verified", ["platform-id"]);
  }

  if (field === "/issued") {
    const dates = snapshotDates(snap);
    const issued = parseEdtf(c.draft.issued);
    if (dates.length === 0 || !issued) return undefined;
    const ok = dates.some((d) => datesEqual(issued, d));
    return ok
      ? result("verified", ["platform-date"])
      : result("conflict", ["platform-date"], `The date "${clip(c.draft.issued)}" does not match the date recorded by the platform.`);
  }

  if (field === "/creators") {
    const handles = snapStrings(snap, ["uploader_id", "owner_username"]).map(handleKey);
    if (handles.length === 0) return undefined;
    const list = creatorList(c.draft.creators);
    const withHandle = list.filter((x) => typeof x.handle === "string" && x.handle);
    const bad = withHandle.find((x) => !handles.includes(handleKey(x.handle as string)));
    if (bad) return result("conflict", ["platform-handle"], `The handle "${clip(bad.handle)}" does not match the account recorded by the platform.`);
    if (withHandle.length > 0 && withHandle.length === list.length) return result("verified", ["platform-handle"]);
  }
  void label;
  return undefined;
}

// ---------------------------------------------------------------- identifier integrity

export function isbnValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === "X" ? 10 : Number(s[i]));
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
  }
  return false;
}

const normDoi = (d: string) => d.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "");

export function checkIdentifier(field: string, c: CheckCtx): FieldVerification | undefined {
  if (field === "/identifiers/isbn") {
    const raw = c.draft.identifiers && isRecord(c.draft.identifiers) ? c.draft.identifiers.isbn : undefined;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const bad = list.find((x) => typeof x !== "string" || !isbnValid(x));
    if (bad !== undefined) return result("conflict", ["isbn-checksum"], `The ISBN "${clip(bad)}" is not valid (its check digit does not add up), so it may be mistyped or invented.`);
    return undefined;
  }
  if (field === "/identifiers/doi") {
    const doi = getByPointer(c.draft, "/identifiers/doi");
    if (typeof doi !== "string") return undefined;
    const hit = c.lookups.find((l) => typeof l.matchedIdentifier === "string" && normDoi(l.matchedIdentifier) === normDoi(doi) && typeof l.title === "string");
    if (!hit) return undefined;
    const titles = textVariants(c.draft.title);
    let sim = Math.max(0, ...titles.map((t) => titleSimilarity(t, hit.title!)));
    const lt = normalizeTitle(hit.title!);
    if (lt && c.docNorm.includes(lt)) sim = Math.max(sim, 1);
    if (sim >= 0.9) return result("verified", ["doi-lookup"]);
    if (sim < 0.6) return result("conflict", ["doi-lookup"], `The DOI resolves to a different work ("${clip(hit.title)}") than the title recorded here.`);
    return result("unverified", ["doi-lookup"], `The DOI resolves to a work whose title only partly matches ("${clip(hit.title)}").`);
  }
  return undefined;
}

// ---------------------------------------------------------------- cross-source conflict

function conflicts(field: string, a: unknown, b: unknown): boolean {
  if (field === "/title") {
    const x = textOf(a), y = textOf(b);
    return x !== undefined && y !== undefined && titleSimilarity(x, y) < 0.6;
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && Math.abs(x.y - y.y) > 1;
  }
  if (field === "/creators") {
    const x = firstFamily(a), y = firstFamily(b);
    return x !== undefined && y !== undefined && !!normalizeTitle(x) && !!normalizeTitle(y) && normalizeTitle(x) !== normalizeTitle(y);
  }
  return false;
}

export function checkCrossSource(field: string, c: CheckCtx): FieldVerification | undefined {
  const evs = evidenceFor(c, field).filter((e) => e.source.kind !== "user");
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i]!, b = evs[j]!;
      if (conflicts(field, a.value, b.value)) {
        const show = (e: FieldEvidence) => `"${clip(field === "/creators" ? firstFamily(e.value) ?? "" : e.value)}" (from ${sourceName(e)})`;
        return result("conflict", ["cross-source"], `Two sources disagree about the ${labelOf(field).toLowerCase()}: ${show(a)} versus ${show(b)}.`, [
          { value: a.value, source: a.source },
          { value: b.value, source: b.source },
        ]);
      }
    }
  }
  return undefined;
}

export function sourceName(e: Pick<FieldEvidence, "source">): string {
  const k = e.source.kind;
  const base: Record<string, string> = {
    embedded: "the file's embedded data", lookup: "an online lookup", "platform-json": "the platform data",
    "page-dom": "the web page", filename: "the file name", ai: "AI", zotero: "Zotero", refman: "Reference Manager", ocr: "text recognition", user: "the researcher",
  };
  return k === "lookup" && e.source.provider ? `an online lookup (${e.source.provider})` : base[k] ?? k;
}

// ---------------------------------------------------------------- AI quotes

function quoteFound(quote: unknown, c: CheckCtx): boolean {
  if (typeof quote !== "string") return false;
  const q = normalizeTitle(quote);
  if (!q) return false;
  if (c.docNorm.includes(q)) return true;
  return snapNorm(c.snapshot, [...PLATFORM_TEXT_KEYS, ...PLATFORM_NAME_KEYS]).some((s) => s.includes(q));
}

// ---------------------------------------------------------------- grounding

function creatorNames(c: CheckCtx): (string | undefined)[] {
  const social = SOCIAL.has(c.type);
  return creatorList(c.draft.creators).map((x) => {
    const order = social ? ["handle", "family", "literal"] : ["family", "literal", "handle"];
    for (const k of order) if (typeof x[k] === "string" && x[k]) return x[k] as string;
    return undefined;
  });
}

/** Is the field's current value found in the document text or the platform snapshot? */
export function checkGrounding(field: string, c: CheckCtx): FieldVerification | undefined {
  if (field === "/title") {
    const titles = textVariants(c.draft.title).map(normalizeTitle).filter(Boolean);
    if (titles.some((t) => c.docNorm.includes(t))) return result("verified", ["found-in-document-text"]);
    const snaps = snapNorm(c.snapshot, PLATFORM_TEXT_KEYS);
    if (titles.some((t) => snaps.some((s) => s.includes(t)))) return result("verified", ["found-in-platform-data"]);
    return undefined;
  }
  if (field === "/creators") {
    const names = creatorNames(c);
    if (names.length === 0 || names.some((n) => n === undefined)) return undefined;
    const snaps = snapNorm(c.snapshot, PLATFORM_NAME_KEYS);
    const ok = names.every((n) => {
      const nn = normalizeTitle(n!);
      return !!nn && (c.docNorm.includes(nn) || snaps.some((s) => s.includes(nn)));
    });
    return ok ? result("verified", ["found-in-document-or-platform-data"]) : undefined;
  }
  return undefined;
}

export function independentAgreement(field: string, evs: FieldEvidence[]): boolean {
  const usable = evs.filter((e) => TRUSTED_KINDS.has(e.source.kind));
  for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++)
      if (sourceKey(usable[i]!) !== sourceKey(usable[j]!) && agree(field, usable[i]!.value, usable[j]!.value)) return true;
  return false;
}

// ---------------------------------------------------------------- one field

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  const t = textOf(v);
  return t !== undefined && t.trim() === "";
}

function aiUnverified(label: string, aiEvs: FieldEvidence[]): FieldVerification {
  const hasQuote = aiEvs.some((e) => typeof e.quote === "string" && e.quote.trim() !== "");
  return result("unverified", ["ai-quote"], hasQuote
    ? `${label} was suggested by AI, but the passage it quoted could not be found in the document.`
    : `${label} was suggested by AI without a quoted passage from the document to back it up.`);
}

export function verifyField(field: string, c: CheckCtx, required: boolean): FieldVerification | undefined {
  const label = labelOf(field);
  const evs = evidenceFor(c, field);
  if (evs.some((e) => e.source.kind === "user")) return result("user-confirmed", ["user"]);
  const value = getByPointer(c.draft, field);
  const empty = isEmpty(value);

  if (empty) {
    return required || evs.length > 0 ? result("unverified", ["present"], `${label} is missing.`) : undefined;
  }
  const hit = checkPlatformIdentity(field, c) ?? checkIdentifier(field, c) ?? checkCrossSource(field, c);
  if (hit) return hit;

  const aiEvs = evs.filter((e) => e.source.kind === "ai");
  const goodAi = aiEvs.filter((e) => quoteFound(e.quote, c));
  if (goodAi.length > 0) return result("verified", ["ai-quote-found"]);

  const solid = evs.filter((e) => e.source.kind !== "filename" && e.source.kind !== "ai");
  // AI-only values are judged by their quote alone, never by the value merely appearing in the text.
  if (aiEvs.length > 0 && evs.every((e) => e.source.kind === "ai")) return aiUnverified(label, aiEvs);

  const grounded = checkGrounding(field, c);
  if (grounded) return grounded;

  if (independentAgreement(field, solid)) return result("verified", ["independent-sources-agree"]);
  if (solid.some((e) => TRUSTED_KINDS.has(e.source.kind))) return result("single-source", ["single-trusted-source"]);

  if (evs.length === 0) {
    return required ? result("unverified", ["evidence"], `${label} has no recorded source, so it could not be checked.`) : undefined;
  }
  if (aiEvs.length > 0) return aiUnverified(label, aiEvs);
  return result("unverified", ["filename-only"], c.docNorm
    ? `${label} from the file name could not be found in the document text.`
    : `${label} comes only from the file name and nothing else confirms it.`);
}
