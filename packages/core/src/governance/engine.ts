import type { Provenance } from "../model/source.js";
import { effectivePolicy } from "./merge.js";
import { ENCRYPTION_LEVELS, LOCATION_LEVELS, PROCESSING_OPS, RESIDENCY_KINDS, type GovernanceConfig, type ProcessingOp, type ResidencyKind } from "./schema.js";

export type PolicyAction = "capture" | "process" | "store" | "sync" | "view" | "export" | "share" | "delete" | "move" | "backup" | "restore" | "set-aside";

export interface PolicyRequest {
  action: PolicyAction;
  projectId: string;
  actor: string;
  /** ISO 8601 timestamp. */
  now: string;
  /** IANA time zone of the researcher, used for calendar-date rules (default "UTC"). */
  tz?: string;
  capture?: { method: Provenance["captureMethod"]; platform?: string };
  /** `provider` is 'local' (on-device) or a vendor id. */
  process?: { op: ProcessingOp; provider: string };
  store?: { identifiable: boolean; hasLocation: boolean; legalBasis?: string };
  move?: { destination: ResidencyKind; cloudFolderId?: string };
  export?: { identifiable: boolean; hasLocation: boolean };
  /**
   * A full copy of the project written to `<Library>/Backups/`, i.e. where the library itself lives
   * (R125). `destinations` lists every kind of storage that folder may be on: its path and its real
   * path (symbolic links resolved), and, when a kind could not be determined (`uncertain`), every
   * plausible kind. Each must be allowed.
   */
  backup?: { destinations: Array<{ destination: ResidencyKind; cloudFolderId?: string; uncertain?: boolean }> };
  /**
   * A backup restored as a new project of a library (Task 50b). `destinations` lists every kind of
   * storage the library's folder may be on, as for a backup. Each must be allowed. The caller asks
   * this of the rules the backup carries (they become the new project's; `rules: 'backup'`, the
   * default) and, when the project the backup was made from is in the library, of the rules that
   * project has now (`rules: 'original'`). `rules` only chooses the words of a refusal.
   */
  restore?: { destinations: Array<{ destination: ResidencyKind; cloudFolderId?: string; uncertain?: boolean }>; rules?: "backup" | "original" };
  sync?: Record<string, never>;
  /** Setting aside a mark that cannot be repaired (Task 50, R154 d): the researcher's reason. */
  setAside?: { reason: string };
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

/**
 * The reason a store with location data is refused in a project that hides locations
 * (`locationMetadata` coarsen or strip) but is not encrypted (R85 M5): the decision carries both an
 * `encrypt` and a `location` condition, and an unencrypted project cannot honour them.
 */
export const LOCATION_NEEDS_ENCRYPTION = "This project hides locations, so files with a location can only be stored in an encrypted project.";

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
  const oneOf = (v: unknown, allowed: readonly string[], path: string) => {
    if (typeof v !== "string" || !allowed.includes(v)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  };
  const bool = (v: unknown, path: string) => {
    if (typeof v !== "boolean") throw new Error(`${path} must be true or false`);
  };
  const date = (v: unknown, path: string) => {
    if (v === null) return;
    if (!validDate(v)) throw new Error(`${path} must be a real date or null`);
  };
  oneOf(p.encryption.atRest, ENCRYPTION_LEVELS, "encryption.atRest");
  oneOf(p.sharing.locationMetadata, LOCATION_LEVELS, "sharing.locationMetadata");
  bool(p.consent.requireLegalBasis, "consent.requireLegalBasis");
  bool(p.consent.requireStatus, "consent.requireStatus");
  bool(p.identifiability.containsIdentifiable, "identifiability.containsIdentifiable");
  bool(p.identifiability.pseudonymizeFileNames, "identifiability.pseudonymizeFileNames");
  bool(p.identifiability.deidentifiedExportsOnly, "identifiability.deidentifiedExportsOnly");
  bool(p.protocol.requireBeforeCapture, "protocol.requireBeforeCapture");
  date(p.protocol.expires, "protocol.expires");
  date(p.protocol.approvedFrom, "protocol.approvedFrom");
}

/** True for YYYY-MM-DD that is a real calendar date, or any other string Date can parse. */
function validDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }
  return !Number.isNaN(Date.parse(v));
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new Error(`${what} must be true or false`);
  return v;
};

/** Calendar date (YYYY-MM-DD) of an instant in a time zone; throws on a bad zone or timestamp. */
function localDate(nowIso: string, tz: string): string {
  const t = Date.parse(nowIso);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp "${nowIso}"`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}

/** Date part of a protocol date: date-only as written, otherwise the UTC date of the instant. */
function datePart(d: string): string {
  if (!validDate(d)) throw new Error(`invalid protocol date "${d}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = Date.parse(d);
  return new Date(t).toISOString().slice(0, 10);
}

function capture(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const c = need(req.capture, "capture");
  const method = str(c.method, "capture.method");
  if (c.platform !== undefined) str(c.platform, "capture.platform");
  if (!(p.captureMethods as string[]).includes(method)) return deny(`Capture method ${method} is not enabled for this project`, warnings);
  if (p.protocol.requireBeforeCapture && !p.protocol.number) {
    return deny("An approved protocol number is required before capture", warnings);
  }
  const today = localDate(req.now, req.tz ?? "UTC");
  if (p.protocol.approvedFrom) {
    const from = datePart(p.protocol.approvedFrom);
    if (today < from) return deny(`Protocol approval starts on ${from}`, warnings);
  }
  if (p.protocol.expires) {
    const exp = datePart(p.protocol.expires);
    if (today > exp) return deny(`Protocol expired on ${exp}`, warnings);
    const days = Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
    if (days <= EXPIRY_WARNING_DAYS) {
      warnings.push(days === 0 ? "Protocol expires today" : days === 1 ? "Protocol expires in 1 day" : `Protocol expires in ${days} days`);
    }
  }
  if (c.platform !== undefined && p.protocol.platforms.length > 0 && !p.protocol.platforms.includes(c.platform)) {
    return deny(`Platform ${c.platform} is outside approved protocol scope`, warnings);
  }
  return allow(warnings);
}

function processOp(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const { op, provider } = need(req.process, "process");
  str(op, "process.op");
  str(provider, "process.provider");
  if (!(PROCESSING_OPS as readonly string[]).includes(op)) throw new Error(`unknown processing op "${op}"`);
  if (!p.processing[op].includes(provider)) {
    return deny(`Processing "${op}" with provider "${provider}" is not permitted for this project`, warnings);
  }
  return allow(warnings);
}

function store(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const s = need(req.store, "store");
  bool(s.identifiable, "store.identifiable");
  bool(s.hasLocation, "store.hasLocation");
  if (s.legalBasis !== undefined) str(s.legalBasis, "store.legalBasis");
  const conditions: Condition[] = [];
  if (p.encryption.atRest === "required") conditions.push({ type: "encrypt" });
  if (s.identifiable && p.identifiability.pseudonymizeFileNames) conditions.push({ type: "pseudonymize-names" });
  if (s.hasLocation && p.sharing.locationMetadata !== "keep") {
    if (p.encryption.atRest === "off") return deny("Location data requires encryption or locationMetadata: keep", warnings);
    // R85 M5: an original that has (or may have) a location is kept only encrypted when the project
    // hides locations; an unencrypted project cannot honour that (LOCATION_NEEDS_ENCRYPTION).
    if (!conditions.some((c) => c.type === "encrypt")) conditions.push({ type: "encrypt" });
    conditions.push({ type: "location", mode: p.sharing.locationMetadata });
  }
  if (s.identifiable && p.consent.requireLegalBasis && !s.legalBasis) {
    return deny("Record a legal basis for identifiable data before storing it", warnings);
  }
  return withConditions(conditions, warnings);
}

function exportData(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const e = need(req.export, "export");
  bool(e.identifiable, "export.identifiable");
  bool(e.hasLocation, "export.hasLocation");
  const conditions: Condition[] = [];
  if (e.identifiable && p.identifiability.deidentifiedExportsOnly) conditions.push({ type: "deidentified-only" });
  if (e.hasLocation && p.sharing.locationMetadata !== "keep") conditions.push({ type: "location", mode: p.sharing.locationMetadata });
  return withConditions(conditions, warnings);
}

/**
 * Setting aside a mark that cannot be repaired (R154 d): allowed in every profile, but only with a
 * reason that is not empty once trimmed, so the decision and its audit record have substance.
 */
function setAside(req: PolicyRequest, warnings: string[]): PolicyDecision {
  const s = need(req.setAside, "setAside");
  str(s.reason, "setAside.reason");
  if (s.reason.trim() === "") return deny("A reason is required to set this aside", warnings);
  return allow(warnings);
}

/**
 * Whether the project's data may be kept on this kind of storage (residency): "kind" when the kind
 * is not in the effective `residency.allowed`; "folder" when it is a cloud folder that must be, and
 * is not, on the approved list (HIPAA, or whenever that list is non-empty); else null.
 */
function residencyProblem(p: GovernanceConfig, destination: string, cloudFolderId: string | undefined): "kind" | "folder" | null {
  if (!(RESIDENCY_KINDS as readonly string[]).includes(destination) || !p.residency.allowed.includes(destination as ResidencyKind)) return "kind";
  if (destination === "cloud_folder") {
    const approved = p.residency.approvedCloudFolders;
    const needsList = p.profiles.includes("hipaa") || approved.length > 0;
    if (needsList && (cloudFolderId === undefined || !approved.includes(cloudFolderId))) return "folder";
  }
  return null;
}

function move(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const { destination, cloudFolderId } = need(req.move, "move");
  str(destination, "move.destination");
  if (cloudFolderId !== undefined) str(cloudFolderId, "move.cloudFolderId");
  const problem = residencyProblem(p, destination, cloudFolderId);
  if (problem === "kind") return deny(`Destination ${destination} is not permitted for project ${req.projectId}`, warnings);
  if (problem === "folder") return deny(`Cloud folder ${cloudFolderId ?? "(unspecified)"} is not on this project's approved list`, warnings);
  return allow(warnings);
}

/** Plain words for a kind of storage, in refusal reasons. */
const STORAGE_WORDS: Record<ResidencyKind, string> = {
  device: "this computer's disk",
  removable: "a removable drive",
  network: "a network drive",
  cloud_folder: "a cloud-synced folder",
  own_server: "your own server",
  cloud: "a cloud service",
};
const storageWords = (kind: string): string => (Object.hasOwn(STORAGE_WORDS, kind) ? STORAGE_WORDS[kind as ResidencyKind] : `storage of kind "${kind}"`);
const onOrIn = (kind: string): string => `${kind === "cloud_folder" ? "in" : "on"} ${storageWords(kind)}`;

/** The words of a refusal for a full copy of a project kept where the library lives (a backup, a restore). */
interface FullCopyWords {
  /** Where the library is could not be determined; `kind` is one it may be, in plain words. */
  uncertain: (kind: string) => string;
  /** The library is in a cloud folder that is not on the approved list. */
  folder: (cloudFolderId: string) => string;
  /** The library is on (or in) a kind of storage the rules do not allow, in plain words. */
  kind: (where: string) => string;
}

/**
 * A full copy of the project's data kept where the library lives: the same questions as storing the
 * data there. Every kind of storage the library's folder may be on must be allowed by the residency
 * rules (as for a move); when the rules require encryption at rest, the copy must be encrypted (an
 * `encrypt` condition, which an unencrypted project cannot honour, so the caller refuses it).
 */
function fullCopy(p: GovernanceConfig, payload: unknown, what: "backup" | "restore", words: FullCopyWords, warnings: string[]): PolicyDecision {
  const b = payload as { destinations?: unknown };
  if (typeof b !== "object" || b === null || !Array.isArray(b.destinations) || b.destinations.length === 0) {
    throw new Error(`${what}.destinations must be a non-empty list`);
  }
  for (const d of b.destinations as Array<{ destination?: unknown; cloudFolderId?: unknown; uncertain?: unknown } | null>) {
    if (typeof d !== "object" || d === null) throw new Error(`${what}.destinations entries must be mappings`);
    const destination = str(d.destination, `${what}.destinations.destination`);
    const cloudFolderId = d.cloudFolderId === undefined ? undefined : str(d.cloudFolderId, `${what}.destinations.cloudFolderId`);
    const uncertain = d.uncertain === undefined ? false : bool(d.uncertain, `${what}.destinations.uncertain`);
    const problem = residencyProblem(p, destination, cloudFolderId);
    if (problem === null) continue;
    if (uncertain) return deny(words.uncertain(storageWords(destination)), warnings);
    if (problem === "folder") return deny(words.folder(cloudFolderId ?? "(unknown)"), warnings);
    return deny(words.kind(onOrIn(destination)), warnings);
  }
  return withConditions(p.encryption.atRest === "required" ? [{ type: "encrypt" }] : [], warnings);
}

/**
 * A backup (R125): the same questions as storing the project's data where the library lives. Every
 * kind of storage the Backups folder may be on must be allowed by the project's residency rules (as
 * for a move); when the rules require encryption at rest, the backup must be sealed (an `encrypt`
 * condition, which an unencrypted project cannot honour, so the caller refuses it).
 */
function backup(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  return fullCopy(
    p,
    need(req.backup, "backup"),
    "backup",
    {
      uncertain: (kind) =>
        `Where the library's folder is stored could not be determined (it may be ${kind}), and this project's rules do not allow its data there. To make backups, move the library to storage the rules allow, or allow that kind of storage in the project's rules.`,
      folder: (id) => `Backups are kept in the library's folder, which is in cloud folder ${id}; it is not on this project's approved list`,
      kind: (where) => `Backups are kept in the library's folder, which is ${where}; this project's rules do not allow its data there`,
    },
    warnings,
  );
}

/**
 * A restore (Task 50b): a backup becomes a new project of this library. The questions are a
 * backup's, the other way round: every kind of storage the library's folder may be on must be
 * allowed by the residency rules, and rules that require encryption at rest give an `encrypt`
 * condition, which a project that is not encrypted cannot honour (the caller refuses it: nothing
 * comes back unencrypted under such rules). The caller asks this of the rules the backup brings
 * with it, which become the new project's, and of the rules the project it was made from has now
 * when that project is in the library; `restore.rules` says which, for the words of a refusal.
 */
function restore(p: GovernanceConfig, req: PolicyRequest, warnings: string[]): PolicyDecision {
  const r = need(req.restore, "restore") as { rules?: unknown };
  const which = r === null || typeof r !== "object" || r.rules === undefined ? "backup" : str(r.rules, "restore.rules");
  if (which !== "backup" && which !== "original") throw new Error('restore.rules must be "backup" or "original"');
  const rules = which === "backup" ? "the rules of the project in this backup" : "the rules the original project has now";
  const list = which === "backup" ? "the approved list of the project in this backup" : "the approved list the original project has now";
  return fullCopy(
    p,
    r,
    "restore",
    {
      uncertain: (kind) =>
        `Where the library's folder is stored could not be determined (it may be ${kind}), and ${rules} do not allow its data there. To restore it, use a library on storage those rules allow.`,
      folder: (id) => `The project would be restored into the library's folder, which is in cloud folder ${id}; it is not on ${list}`,
      kind: (where) => `The project would be restored into the library's folder, which is ${where}; ${rules} do not allow its data there`,
    },
    warnings,
  );
}

function run(cfg: GovernanceConfig, req: PolicyRequest): PolicyDecision {
  if (typeof req.now !== "string" || !ISO_UTC.test(req.now) || Number.isNaN(Date.parse(req.now))) {
    throw new Error("now must be an ISO 8601 UTC timestamp (e.g. 2026-11-09T09:30:00Z)");
  }
  if (req.tz !== undefined) str(req.tz, "tz");
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
    case "backup":
      return backup(policy, req, warnings);
    case "restore":
      return restore(policy, req, warnings);
    case "sync":
      return deny("Sync is not enabled in this version", warnings);
    case "set-aside":
      return setAside(req, warnings);
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
