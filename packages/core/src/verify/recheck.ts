import type { FieldEvidence, FieldVerification, SourceDraft, SourceFile, SourceType } from "../model/index.js";
import { agree, labelOf, verifyField } from "./checks.js";
import type { CheckCtx } from "./checks.js";
import { DOC_TEXT_LIMIT, getByPointer, isRecord, normalizeTitle } from "./evidence.js";
import type { LookupEvidence } from "./evidence.js";

export const REQUIRED_FIELDS: Record<SourceType, string[]> = {
  book: ["/title", "/creators", "/issued", "/publisher"],
  chapter: ["/title", "/creators", "/issued", "/container"],
  "article-journal": ["/title", "/creators", "/issued", "/container"],
  preprint: ["/title", "/creators", "/issued"],
  report: ["/title", "/creators", "/issued"],
  thesis: ["/title", "/creators", "/issued"],
  webpage: ["/title", "/identifiers/url"],
  "social-post": ["/title", "/creators", "/issued", "/identifiers/platformPostId", "/identifiers/url"],
  video: ["/title", "/creators", "/issued", "/identifiers/platformPostId", "/identifiers/url"],
  audio: ["/title"],
  image: ["/title"],
  dataset: ["/title"],
  "field-photo": ["/issued"],
  "field-video": ["/issued"],
  "field-recording": ["/issued"],
  interview: ["/issued"],
  manuscript: ["/title"],
  presentation: ["/title", "/creators"],
  other: ["/title"],
};

export interface VerifyContext {
  documentText?: string;
  platformSnapshot?: Record<string, unknown>;
  lookups?: LookupEvidence[];
}

export interface VerificationReport {
  fields: Record<string, FieldVerification>;
  overall: "ok" | "needs-review";
  reasons: string[];
}

const normId = (s: string) =>
  s.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:|arxiv:)/, "").replace(/[\s-]/g, "");

function draftIdentifiers(d: Record<string, unknown>): Set<string> {
  const ids = isRecord(d.identifiers) ? d.identifiers : {};
  const out = new Set<string>();
  for (const v of [ids.doi, ids.arxiv, ids.platformPostId, ...(Array.isArray(ids.isbn) ? ids.isbn : [ids.isbn])]) {
    if (typeof v === "string" && v.trim()) out.add(normId(v));
  }
  return out;
}

/**
 * A lookup becomes evidence only if it is tied to this draft: its matchedIdentifier is one of the
 * draft's identifiers, or (no matchedIdentifier) the value it gives agrees with the draft's value.
 */
function lookupEvidence(lookups: LookupEvidence[], d: Record<string, unknown>): FieldEvidence[] {
  const out: FieldEvidence[] = [];
  const ids = draftIdentifiers(d);
  for (const l of lookups) {
    if (!isRecord(l) || typeof l.provider !== "string") continue;
    const tied = typeof l.matchedIdentifier === "string";
    if (tied && !ids.has(normId(l.matchedIdentifier as string))) continue;
    const source = { kind: "lookup" as const, provider: l.provider };
    const add = (field: string, value: unknown) => {
      if (tied || agree(field, value, getByPointer(d, field), typeof d.type === "string" ? d.type : undefined)) out.push({ field, value, source, at: "" });
    };
    if (typeof l.title === "string") add("/title", l.title);
    if (Array.isArray(l.creators) && l.creators.length > 0) add("/creators", l.creators);
    if (typeof l.issued === "string") add("/issued", l.issued);
  }
  return out;
}

function validEvidence(evidence: unknown): FieldEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (e): e is FieldEvidence => isRecord(e) && typeof e.field === "string" && isRecord(e.source) && typeof e.source.kind === "string",
  );
}

/** Structural equality of JSON values (key order ignored). Core stays free of Node built-ins. */
function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => isDeepStrictEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => isDeepStrictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const emptyValue = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * The evidence that counts as a claim (Z6, R236 c). For evidence of kind `zotero`, only the NEWEST value of each field
 * from each Zotero source (`provider` and `ref`) is a claim: every Zotero import or sync records the value it brought,
 * so the earlier ones are history (what Zotero once said, kept so that a re-import knows what it brought last), not
 * claims. A newest value that is empty (Zotero cleared the field) means Zotero claims nothing for it. "Newest" is the
 * last in the list, the order in which imports append evidence. Every other kind is left exactly as it was: a page
 * captured twice or a lookup repeated keeps each value as a claim (R190–R194 rely on a later check's value standing
 * beside the earlier one).
 */
export function currentClaims(evidence: FieldEvidence[]): FieldEvidence[] {
  const newest = new Map<string, FieldEvidence>();
  for (const e of evidence) if (e.source.kind === "zotero") newest.set(`${e.field}\u0000${e.source.provider ?? ""}\u0000${e.source.ref ?? ""}`, e);
  if (!newest.size) return evidence;
  const keep = new Set([...newest.values()].filter((e) => !emptyValue(e.value)));
  return evidence.filter((e) => e.source.kind !== "zotero" || keep.has(e));
}

/**
 * Check every field's evidence against the document text, platform snapshot and lookups.
 * Never throws: anything it cannot make sense of becomes `unverified` with a reason.
 */
export function verifyDraft(draft: SourceDraft, evidence: FieldEvidence[], ctx: VerifyContext): VerificationReport {
  const safeCtx = isRecord(ctx) ? ctx : {};
  const d: Record<string, unknown> = isRecord(draft) ? draft : {};
  const type = typeof d.type === "string" ? d.type : "other";
  const required = Object.prototype.hasOwnProperty.call(REQUIRED_FIELDS, type) ? REQUIRED_FIELDS[type as SourceType] : REQUIRED_FIELDS.other;
  const lookups = Array.isArray(safeCtx.lookups) ? safeCtx.lookups : [];
  const text = typeof safeCtx.documentText === "string" ? safeCtx.documentText : undefined;
  let docNorm = "";
  try {
    docNorm = text ? normalizeTitle(text.slice(0, DOC_TEXT_LIMIT)) : "";
  } catch {
    docNorm = "";
  }
  const stored = currentClaims(validEvidence(evidence));
  const c: CheckCtx = {
    type,
    draft: d,
    evidence: [...stored, ...lookupEvidence(lookups, d)],
    documentText: text,
    docNorm,
    snapshot: isRecord(safeCtx.platformSnapshot) ? safeCtx.platformSnapshot : undefined,
    lookups: lookups.filter(isRecord) as LookupEvidence[],
  };

  const fields = new Set<string>(required);
  for (const e of stored) fields.add(e.field);
  const ident = isRecord(d.identifiers) ? d.identifiers : {};
  if (ident.doi !== undefined) fields.add("/identifiers/doi");
  if (ident.isbn !== undefined) fields.add("/identifiers/isbn");

  const report: VerificationReport = { fields: {}, overall: "ok", reasons: [] };
  for (const field of fields) {
    let v: FieldVerification | undefined;
    try {
      v = verifyField(field, c, required.includes(field));
    } catch {
      v = { status: "unverified", checks: ["error"], reason: `${labelOf(field)} could not be checked because its value is in an unexpected form.` };
    }
    if (!v) continue;
    report.fields[field] = v;
    const bad = v.status === "unverified" || v.status === "conflict";
    if (bad && (v.status === "conflict" || required.includes(field))) report.overall = "needs-review";
    if (bad && v.reason) report.reasons.push(v.reason);
  }
  return report;
}

export function applyVerification(confidence: number, report: VerificationReport): number {
  return report.overall === "needs-review" ? Math.min(confidence, 0.6) : confidence;
}

/**
 * Recompute `verification` from the stored `fieldEvidence` (the "Recheck" action, and after any
 * non-user metadata change). Pure. A stored `user-confirmed` entry is kept exactly, but only while the
 * fresh check itself still says user-confirmed: the user's evidence strictly matches the current value
 * and no integrity check (ISBN checksum, DOI resolving to another work) contradicts it.
 */
export function recheckSourceFile(sf: SourceFile, ctx: VerifyContext): SourceFile {
  const snapshot = ctx.platformSnapshot ?? (isRecord(sf.source.provenance?.platformSnapshot) ? sf.source.provenance.platformSnapshot : undefined);
  const report = verifyDraft(sf.source as unknown as SourceDraft, sf.fieldEvidence, { ...ctx, platformSnapshot: snapshot });
  const verification: Record<string, FieldVerification> = { ...report.fields };
  const claims = currentClaims(validEvidence(sf.fieldEvidence));
  for (const [k, v] of Object.entries(sf.verification)) {
    if (v.status === "conflict" && v.checks.includes(ZOTERO_CONFLICT_CHECK)) {
      // Z6 (R236 c): a field changed in Zotero and here stays as the update recorded it (its reason, the value Zotero
      // gave) while both of its values are still what it recorded: the value here, and Zotero's newest. Settled by the
      // researcher's own evidence, or by either value moving on: then the fresh check speaks.
      // I5 (fix round 2): the researcher's evidence settles it only when it is NEWER than Zotero's newest evidence for
      // the field — later in `fieldEvidence`, the order in which every change appends (a confirm takes its own earlier
      // evidence out and appends the new one). Position, never time: two entries recorded in the same second are still
      // ordered. An older "keep mine" does not answer the question Zotero raised after it.
      const zotero = [...claims].reverse().find((e) => e.field === k && e.source.kind === "zotero");
      const still = zotero && isDeepStrictEqual(zotero.value, v.values?.[0]?.value) && isDeepStrictEqual(getByPointer(sf.source as unknown as Record<string, unknown>, k), v.current);
      const all = validEvidence(sf.fieldEvidence);
      const lastAt = (kind: (e: FieldEvidence) => boolean) => all.reduce((at, e, i) => (e.field === k && kind(e) ? i : at), -1);
      const userNewer = lastAt((e) => e.source.kind === "user") > lastAt((e) => e.source.kind === "zotero");
      if (still && !(userNewer && report.fields[k]?.status === "user-confirmed")) verification[k] = structuredClone(v);
      continue;
    }
    if (v.status !== "user-confirmed") continue;
    // The fresh report is the only authority: it must have reached user-confirmed on its own.
    if (report.fields[k]?.status === "user-confirmed") verification[k] = structuredClone(v);
  }
  return { ...sf, verification };
}

/** Z6: the check name of a field changed in Zotero and here (the conflict the account sync records). */
export const ZOTERO_CONFLICT_CHECK = "zotero-update";
