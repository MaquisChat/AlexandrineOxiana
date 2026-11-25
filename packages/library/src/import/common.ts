/**
 * Rules shared by drag-and-drop attach and Bulk Import (package-internal): the location note
 * (R83), the legal-basis category of user files, duplicate keys, the review entry of a resolved
 * item and the item's provenance. Both callers create, merge and queue items under these rules.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { nonBlank, primary, type DupKey, type PolicyDecision, type PolicyRequest, type Provenance, type SourceFile } from "@ao/core";
import { LOOKUP_WAITING_TEXT } from "@ao/shared";
import type { ReviewInput } from "../repo/review.js";
import { projectPolicy, type Repo } from "../repo/repo.js";
import { AUTO_ACCEPT_THRESHOLD, type Resolution } from "./resolve.js";

/**
 * R83 (replaces the R56 refusal): media whose store carries a location condition are stored as the
 * decision allows, and their viewing proxies are made with the location coarsened or removed. Only
 * when no media worker is configured at all can those proxies not be queued: the original is still
 * stored, the source is "proxy pending" (the jobs are kept in its source.json and run once a worker
 * is available), and the outcome carries this note.
 */
export const LOCATION_REASON =
  "This file contains location data. It was stored as this project's rules allow; its viewing copy, with the location coarsened or removed, will be made once the media helper is available.";

export type LocationMode = "keep" | "coarsen" | "strip";

/**
 * Watches the `store` decisions of one governed change for a location condition (R83): the hook
 * never refuses; `mode()` is the condition's mode once the change was decided (undefined: none).
 */
export function locationRule(): { hook: (d: PolicyDecision, req: PolicyRequest) => string | undefined; mode: () => LocationMode | undefined } {
  let mode: LocationMode | undefined;
  return {
    hook: (d, req) => {
      if (req.action === "store" && d.result === "allow_with_conditions") {
        for (const c of d.conditions) if (c.type === "location") mode = c.mode;
      }
      return undefined;
    },
    mode: () => mode,
  };
}

/** The `consent.defaultLegalBasis` category of files from the user's own disk (docs/governance/README.md). */
export const MANUAL_UPLOAD_CATEGORY = "manual-upload";

export const ITEM_REASONS = {
  review: "Some details could not be confirmed, so the source is in the review queue.",
  likelyDuplicate: "This may be a duplicate of a source already in the project, so it is in the review queue.",
  lowConfidence: "The item could not be identified with enough confidence.",
  /** Decision 31 (b), R556 (2) iii: in review while a service it would have asked had asked to wait (the owner's words). */
  waiting: LOOKUP_WAITING_TEXT,
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
  // A blank basis (invisible characters only) is none: core's one `blank()` (R391 c, R415 d).
  const legalBasis = nonBlank(policy?.consent.defaultLegalBasis?.[category]);
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
 * verification needs review) and, if so, its review entry. Decision 31 (b), R556 (2) iii, iv: an item in review whose
 * resolution left lookups out (their services asked to wait) says so first after a likely duplicate (ITEM_REASONS.waiting)
 * and keeps what was left out (`leftOut`). An item not in review shows nothing of it. Only the attach and watched folders
 * leave lookups out; Bulk Import's resolutions never have any.
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
  const waiting = r.leftOut.length > 0;
  const reasons = [
    ...(dup ? [ITEM_REASONS.likelyDuplicate] : []),
    ...(waiting ? [ITEM_REASONS.waiting] : []),
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
    ...(waiting ? { leftOut: r.leftOut } : {}),
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
