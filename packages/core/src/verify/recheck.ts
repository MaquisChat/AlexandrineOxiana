import type { FieldEvidence, FieldVerification, SourceDraft, SourceFile, SourceType } from "../model/index.js";
import { labelOf, verifyField } from "./checks.js";
import type { CheckCtx } from "./checks.js";
import { DOC_TEXT_LIMIT, isRecord, normalizeTitle } from "./evidence.js";
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

function lookupEvidence(lookups: LookupEvidence[]): FieldEvidence[] {
  const out: FieldEvidence[] = [];
  for (const l of lookups) {
    if (!isRecord(l) || typeof l.provider !== "string") continue;
    const source = { kind: "lookup" as const, provider: l.provider };
    if (typeof l.title === "string") out.push({ field: "/title", value: l.title, source, at: "" });
    if (Array.isArray(l.creators) && l.creators.length > 0) out.push({ field: "/creators", value: l.creators, source, at: "" });
    if (typeof l.issued === "string") out.push({ field: "/issued", value: l.issued, source, at: "" });
  }
  return out;
}

function validEvidence(evidence: unknown): FieldEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (e): e is FieldEvidence => isRecord(e) && typeof e.field === "string" && isRecord(e.source) && typeof e.source.kind === "string",
  );
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
  const stored = validEvidence(evidence);
  const c: CheckCtx = {
    type,
    draft: d,
    evidence: [...stored, ...lookupEvidence(lookups)],
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
 * non-user metadata change). Pure; existing `user-confirmed` entries are kept exactly.
 */
export function recheckSourceFile(sf: SourceFile, ctx: VerifyContext): SourceFile {
  const snapshot = ctx.platformSnapshot ?? (isRecord(sf.source.provenance?.platformSnapshot) ? sf.source.provenance.platformSnapshot : undefined);
  const report = verifyDraft(sf.source as unknown as SourceDraft, sf.fieldEvidence, { ...ctx, platformSnapshot: snapshot });
  const verification: Record<string, FieldVerification> = { ...report.fields };
  for (const [k, v] of Object.entries(sf.verification)) if (v.status === "user-confirmed") verification[k] = structuredClone(v);
  return { ...sf, verification };
}
