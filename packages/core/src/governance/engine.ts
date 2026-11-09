import type { Provenance } from "../model/source.js";
import { effectivePolicy } from "./merge.js";
import { PROCESSING_OPS, RESIDENCY_KINDS, type GovernanceConfig, type ProcessingOp, type ResidencyKind } from "./schema.js";

export type PolicyAction = "capture" | "process" | "store" | "sync" | "view" | "export" | "share" | "delete" | "move";

export interface PolicyRequest {
  action: PolicyAction;
  projectId: string;
  actor: string;
  /** ISO 8601 timestamp. */
  now: string;
  capture?: { method: Provenance["captureMethod"]; platform?: string };
  /** `provider` is 'local' (on-device) or a vendor id. */
  process?: { op: ProcessingOp; provider: string };
  store?: { identifiable: boolean; hasLocation: boolean; legalBasis?: string };
  move?: { destination: ResidencyKind; cloudFolderId?: string };
  export?: { identifiable: boolean; hasLocation: boolean };
  sync?: Record<string, never>;
}

export type Condition =
  | { type: "encrypt" }
  | { type: "pseudonymize-names" }
  | { type: "location"; mode: "coarsen" | "strip" }
  | { type: "deidentified-only" };

export type PolicyDecision = { warnings: string[] } & (
  | { result: "allow" }
  | { result: "deny"; reason: string }
  | { result: "allow_with_conditions"; conditions: Condition[] }
);

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 30;
/** Deterministic order in which conditions are reported. */
const CONDITION_ORDER: Condition["type"][] = ["encrypt", "pseudonymize-names", "location", "deidentified-only"];

const allow = (warnings: string[]): PolicyDecision => ({ result: "allow", warnings });
const deny = (reason: string, warnings: string[] = []): PolicyDecision => ({ result: "deny", reason, warnings });

function withConditions(conditions: Condition[], warnings: string[]): PolicyDecision {
  if (conditions.length === 0) return allow(warnings);
  const sorted = [...conditions].sort((a, b) => CONDITION_ORDER.indexOf(a.type) - CONDITION_ORDER.indexOf(b.type));
  return { result: "allow_with_conditions", conditions: sorted, warnings };
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null) throw new Error(`${what} is required`);
  return v;
}

/** Throws on a config whose shape the rules below depend on; the caller turns that into a deny. */
function assertShape(p: GovernanceConfig): void {
  const arr = (v: unknown, path: string) => {
    if (!Array.isArray(v)) throw new Error(`${path} must be a list`);
  };
  const obj = (v: unknown, path: string) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${path} must be a mapping`);
  };
  arr(p.profiles, "profiles");
  obj(p.residency, "residency");
  arr(p.residency.allowed, "residency.allowed");
  arr(p.residency.approvedCloudFolders, "residency.approvedCloudFolders");
  obj(p.processing, "processing");
  for (const op of PROCESSING_OPS) arr(p.processing[op], `processing.${op}`);
  arr(p.captureMethods, "captureMethods");
  obj(p.protocol, "protocol");
  arr(p.protocol.platforms, "protocol.platforms");
  obj(p.identifiability, "identifiability");
  obj(p.consent, "consent");
  obj(p.encryption, "encryption");
  obj(p.sharing, "sharing");
}

function capture(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const c = need(req.capture, "capture");
  if (!p.captureMethods.includes(c.method)) return deny(`Capture method ${c.method} is not enabled for this project`, warnings);
  if (p.protocol.requireBeforeCapture && !p.protocol.number) {
    return deny("An approved protocol number is required before capture", warnings);
  }
  const now = Date.parse(req.now);
  if (Number.isNaN(now)) throw new Error(`invalid timestamp "${req.now}"`);
  if (p.protocol.expires) {
    const expires = Date.parse(p.protocol.expires);
    if (Number.isNaN(expires)) throw new Error(`invalid protocol expiry "${p.protocol.expires}"`);
    if (now > expires) return deny(`Protocol expired on ${p.protocol.expires}`, warnings);
    const days = Math.ceil((expires - now) / DAY_MS);
    if (days <= EXPIRY_WARNING_DAYS) warnings.push(`Protocol expires in ${days} days`);
  }
  if (c.platform && p.protocol.platforms.length > 0 && !p.protocol.platforms.includes(c.platform)) {
    return deny(`Platform ${c.platform} is outside approved protocol scope`, warnings);
  }
  return allow(warnings);
}

function processOp(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const { op, provider } = need(req.process, "process");
  if (!(PROCESSING_OPS as readonly string[]).includes(op)) throw new Error(`unknown processing op "${op}"`);
  if (!p.processing[op].includes(provider)) {
    return deny(`Processing "${op}" with provider "${provider}" is not permitted for this project`, warnings);
  }
  return allow(warnings);
}

function store(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const s = need(req.store, "store");
  const conditions: Condition[] = [];
  if (p.encryption.atRest === "required") conditions.push({ type: "encrypt" });
  if (s.identifiable && p.identifiability.pseudonymizeFileNames) conditions.push({ type: "pseudonymize-names" });
  if (s.hasLocation && p.sharing.locationMetadata !== "keep") {
    if (p.encryption.atRest === "off") return deny("Location data requires encryption or locationMetadata: keep", warnings);
    conditions.push({ type: "location", mode: p.sharing.locationMetadata });
  }
  if (s.identifiable && p.consent.requireLegalBasis && !s.legalBasis) {
    return deny("Record a legal basis for identifiable data before storing it", warnings);
  }
  return withConditions(conditions, warnings);
}

function exportData(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const e = need(req.export, "export");
  const conditions: Condition[] = [];
  if (e.identifiable && p.identifiability.deidentifiedExportsOnly) conditions.push({ type: "deidentified-only" });
  if (e.hasLocation && p.sharing.locationMetadata !== "keep") conditions.push({ type: "location", mode: p.sharing.locationMetadata });
  return withConditions(conditions, warnings);
}

function move(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const { destination, cloudFolderId } = need(req.move, "move");
  if (!(RESIDENCY_KINDS as readonly string[]).includes(destination) || !p.residency.allowed.includes(destination)) {
    return deny(`Destination ${destination} is not permitted for project ${req.projectId}`, warnings);
  }
  if (destination === "cloud_folder") {
    const approved = p.residency.approvedCloudFolders;
    const hipaa = p.profiles.includes("hipaa");
    const needsList = hipaa || approved.length > 0;
    if (needsList && (cloudFolderId === undefined || !approved.includes(cloudFolderId))) {
      return deny(`Cloud folder ${cloudFolderId ?? "(unspecified)"} is not on this project's approved list`, warnings);
    }
  }
  return allow(warnings);
}

function run(cfg: GovernanceConfig, req: PolicyRequest): PolicyDecision {
  const { policy, violations } = effectivePolicy(cfg);
  assertShape(policy);
  const warnings = violations.map(
    (v) => `Governance setting ${v.control} is stricter than configured because ${v.profile} requires it`,
  );
  switch (req.action) {
    case "capture":
      return capture(policy, req, warnings);
    case "process":
      return processOp(policy, req, warnings);
    case "store":
      return store(policy, req, warnings);
    case "export":
      return exportData(policy, req, warnings);
    case "move":
      return move(policy, req, warnings);
    case "sync":
      return deny("Sync is not enabled in this version", warnings);
    case "delete":
    case "view":
    case "share":
      return allow(warnings);
    default:
      throw new Error(`unknown action "${String((req as { action?: unknown }).action)}"`);
  }
}

/** The governance checkpoint: never throws, and any failure to decide is a deny. */
export function evaluate(cfg: GovernanceConfig, req: PolicyRequest): PolicyDecision {
  try {
    return run(cfg, req);
  } catch (e) {
    return deny(`Policy could not be evaluated: ${e instanceof Error ? e.message : String(e)}`);
  }
}
