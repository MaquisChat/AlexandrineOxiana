// Public entry point of @ao/core: re-exports the platform-neutral domain model and helpers.
export const packageName = "@ao/core";

export { isId, newId, shortId } from "./ids.js";

export * from "./model/index.js";

export {
  datedFileName,
  defaultTemplates,
  derivedFileName,
  encName,
  formatModified,
  originalFileName,
  pseudonymize,
  sanitizeSegment,
  sourceFolderName,
  withCollisionSuffix,
} from "./naming.js";
export type { NamingTemplates } from "./naming.js";

export { GENESIS_HASH, sealEvent, verifyChain } from "./audit.js";
export type { AuditEvent, AuditBreakReason, AuditVerifyResult } from "./audit.js";

export { RICH_TEXT_FIELDS, diffToChanges, mergeConcurrent } from "./changelog.js";
export type { Change, ChangeMeta, EntityType, MergeConflict } from "./changelog.js";

export {
  CAPTURE_METHODS,
  DEFAULT_GOVERNANCE,
  GovernanceParseError,
  PROCESSING_OPS,
  PROFILES,
  PUBLIC_METADATA_SERVICES,
  RESIDENCY_KINDS,
  parseGovernance,
  parseGovernanceWithWarnings,
} from "./governance/schema.js";
export type {
  GovernanceConfig,
  GovernanceException,
  PartialGovernance,
  ProcessingOp,
  Profile,
  ResidencyKind,
  Vendor,
} from "./governance/schema.js";
export { PROFILE_MINIMUMS, PROFILE_RULES } from "./governance/profiles/index.js";
export type { ProfileRules } from "./governance/profiles/index.js";
export { applyMinimum, effectivePolicy, loosenedControls } from "./governance/merge.js";
export type { EffectivePolicy, Violation } from "./governance/merge.js";

export { LOCATION_NEEDS_ENCRYPTION, evaluate } from "./governance/engine.js";
export type { Condition, PolicyAction, PolicyDecision, PolicyRequest } from "./governance/engine.js";

export { DOC_TEXT_LIMIT, groundedIn, normalizeTitle, titleSimilarity } from "./verify/evidence.js";
export type { LookupEvidence } from "./verify/evidence.js";
export { REQUIRED_FIELDS, applyVerification, recheckSourceFile, verifyDraft } from "./verify/recheck.js";
export type { VerificationReport, VerifyContext } from "./verify/recheck.js";

export * from "./import/index.js";

export * from "./citation/index.js";
