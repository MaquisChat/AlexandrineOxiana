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
