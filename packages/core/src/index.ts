// Placeholder so the package builds and typechecks; real code arrives in later tasks.
export const packageName = "@ao/core";

export { isId, newId, shortId } from "./ids.js";

export * from "./model/index.js";

export {
  defaultTemplates,
  derivedFileName,
  encName,
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
export { applyMinimum, effectivePolicy } from "./governance/merge.js";
export type { EffectivePolicy, Violation } from "./governance/merge.js";
