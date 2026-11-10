/**
 * Rules shared by drag-and-drop attach and Bulk Import (package-internal): the location refusal
 * (R56), the legal-basis category of user files, duplicate keys, the review entry of a resolved
 * item and the item's provenance. Both callers create, merge and queue items under these rules.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { primary, type DupKey, type PolicyDecision, type PolicyRequest, type Provenance, type SourceFile } from "@ao/core";
import type { ReviewInput } from "../repo/review.js";
import { projectPolicy, type Repo } from "../repo/repo.js";
import { AUTO_ACCEPT_THRESHOLD, type Resolution } from "./resolve.js";

/** R56: until GPS coarsening/stripping exists (Task 27), media whose store needs it are refused. */
export const LOCATION_REASON =
  "This file contains location data that this project requires to be coarsened or removed; that step is not available for dropped files yet.";

/** Refuse hook: an allowed `store` carrying a location condition cannot be honoured yet (R56). */
export const refuseLocation = (d: PolicyDecision, req: PolicyRequest): string | undefined =>
  req.action === "store" && d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "location") ? LOCATION_REASON : undefined;

/** The `consent.defaultLegalBasis` category of files from the user's own disk (docs/governance/README.md). */
export const MANUAL_UPLOAD_CATEGORY = "manual-upload";

export const ITEM_REASONS = {
  review: "Some details could not be confirmed, so the source is in the review queue.",
  likelyDuplicate: "This may be a duplicate of a source already in the project, so it is in the review queue.",
  lowConfidence: "The item could not be identified with enough confidence.",
};

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) h.update(chunk);
  return h.digest("hex");
}

/** Projects whose legacy `manual_upload` legal-basis key was already reported. */
const legacyNoted = new WeakMap<Repo, Set<string>>();

/** Whether new sources are identifiable, and the legal basis recorded for a capture category. */
export async function storeInputs(
  repo: Repo,
  projectId: string,
  category: string = MANUAL_UPLOAD_CATEGORY,
  debug?: (note: string) => void,
): Promise<{ identifiable: boolean; legalBasis?: string }> {
  const policy = await projectPolicy(repo, projectId);
  // The governance loader reads the legacy key as `manual-upload` (and warns); say so once here.
  if (policy && Object.prototype.hasOwnProperty.call(policy.consent.defaultLegalBasis, "manual_upload")) {
    const noted = legacyNoted.get(repo) ?? new Set<string>();
    legacyNoted.set(repo, noted);
    if (!noted.has(projectId)) {
      noted.add(projectId);
      debug?.('governance: consent.defaultLegalBasis.manual_upload is the old spelling of "manual-upload"; please rename it');
    }
  }
  const identifiable = policy?.identifiability.containsIdentifiable ?? true;
  const legalBasis = policy?.consent.defaultLegalBasis?.[category]?.trim() || undefined;
  return { identifiable, ...(legalBasis ? { legalBasis } : {}) };
}

/** A stored source's duplicate keys (its originals' hashes, identifiers, title, first creator, year). */
export function dupKey(sf: SourceFile): DupKey & { sourceId: string } {
  const s = sf.source;
  const c = s.creators[0];
  const family = c?.family ?? c?.literal;
  return {
    sourceId: s.id,
    sha256s: sf.assets.filter((a) => a.role === "original").map((a) => a.sha256),
    ...(s.identifiers.doi ? { doi: s.identifiers.doi } : {}),
    ...(s.identifiers.isbn?.length ? { isbns: s.identifiers.isbn } : {}),
    ...(primary(s.title) ? { title: primary(s.title) } : {}),
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(s.issued ? { year: s.issued.slice(0, 4) } : {}),
  };
}

/**
 * A resolved item's duplicate keys. Only the draft's identifiers count: resolution leaves out the
 * ones it could not confirm (R55, R57, R58), so those never find a "certain" duplicate.
 */
export function candidateKey(r: Resolution, sha256s: string[]): DupKey {
  const d = r.draft;
  const c = d.creators[0];
  const family = c?.family ?? c?.literal;
  return {
    sha256s,
    ...(d.identifiers.doi ? { doi: d.identifiers.doi } : {}),
    ...(d.identifiers.isbn?.length ? { isbns: d.identifiers.isbn } : {}),
    title: primary(d.title),
    ...(family ? { firstCreatorFamily: family } : {}),
    ...(d.issued ? { year: d.issued.slice(0, 4) } : {}),
  };
}

/**
 * Whether a resolved item goes to review (a likely duplicate, below the threshold, or its
 * verification needs review) and, if so, its review entry.
 */
export function reviewFor(
  r: Resolution,
  dup: { sourceId: string; reason: string } | null,
  threshold: number = AUTO_ACCEPT_THRESHOLD,
): Omit<ReviewInput, "sourceId"> | undefined {
  const needsReview = !!dup || r.confidence < threshold || r.verification.overall === "needs-review";
  if (!needsReview) return undefined;
  const fields = Object.fromEntries(
    Object.entries(r.verification.fields).filter(([, v]) => v.status === "conflict" || v.status === "unverified").map(([k, v]) => [k, v.status]),
  );
  const reasons = [
    ...(dup ? [ITEM_REASONS.likelyDuplicate] : []),
    ...r.verification.reasons,
    ...(r.confidence < threshold && r.verification.reasons.length === 0 ? [ITEM_REASONS.lowConfidence] : []),
  ];
  return {
    kind: "import" as const,
    fields,
    reasons,
    confidence: r.confidence,
    method: r.evidence.method,
    candidates: r.candidates,
    ...(dup ? { duplicateOf: { sourceId: dup.sourceId, reason: dup.reason } } : {}),
    ...(r.identifierHints.length ? { hints: r.identifierHints } : {}),
  };
}

/** Provenance of a resolved item. */
export function itemProvenance(
  r: Resolution,
  o: { captureMethod: Provenance["captureMethod"]; tool: { name: string; version: string }; identifiable: boolean; legalBasis?: string; importBatchId?: string; externalKeys?: Record<string, string> },
): Provenance {
  return {
    captureMethod: o.captureMethod,
    capturedAt: new Date().toISOString(),
    tool: o.tool,
    fileHashes: {},
    identification: { method: r.evidence.method, confidence: r.confidence },
    ...(o.importBatchId ? { importBatchId: o.importBatchId } : {}),
    ...(o.externalKeys && Object.keys(o.externalKeys).length ? { externalKeys: o.externalKeys } : {}),
    legal: { status: "unknown", ...(o.legalBasis ? { basis: o.legalBasis } : {}) },
    identifiable: o.identifiable,
  };
}
