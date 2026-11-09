import { PROFILE_MINIMUMS, PROFILE_RULES } from "./profiles/index.js";
import {
  DATE_PATHS,
  ENCRYPTION_LEVELS,
  LOCATION_LEVELS,
  PROCESSING_OPS,
  PUBLIC_METADATA_SERVICES,
  type GovernanceConfig,
  type GovernanceException,
  type PartialGovernance,
  type Profile,
} from "./schema.js";

export interface Violation {
  control: string;
  required: unknown;
  actual: unknown;
  profile: Profile;
}

export interface EffectivePolicy {
  policy: GovernanceConfig;
  violations: Violation[];
}

/** Higher index = stricter. */
const ORDERS: Record<string, readonly string[]> = {
  "encryption.atRest": [...ENCRYPTION_LEVELS].reverse(), // off < optional < required
  "sharing.locationMetadata": [...LOCATION_LEVELS].reverse(), // keep < coarsen < strip
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1] as string] = value;
}

function leaves(o: unknown, prefix = ""): Array<[string, unknown]> {
  if (!isObj(o)) return [];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) out.push(...leaves(v, p));
    else out.push([p, v]);
  }
  return out;
}

const time = (s: unknown): number => (typeof s === "string" ? Date.parse(s) : Number.NaN);

/**
 * Strictest of (actual, required) for one control, and whether `actual` was looser.
 * An exception lowers the bar only to the exact value it approved.
 */
function tighten(
  path: string,
  actual: unknown,
  required: unknown,
  exc?: GovernanceException,
): { value: unknown; loosened: boolean } {
  const order = ORDERS[path];
  if (order) {
    let req = required;
    if (exc && order.indexOf(exc.value as string) >= 0 && order.indexOf(exc.value as string) < order.indexOf(req as string)) {
      req = exc.value;
    }
    const ra = order.indexOf(actual as string);
    const rr = order.indexOf(req as string);
    return ra >= rr ? { value: actual, loosened: false } : { value: req, loosened: true };
  }
  if (DATE_PATHS.has(path)) {
    let req = required;
    if (exc && time(exc.value) > time(req)) req = exc.value;
    if (actual === null || actual === undefined) return { value: req, loosened: false };
    if (req === null || req === undefined) return { value: actual, loosened: false };
    return time(req) < time(actual) ? { value: req, loosened: true } : { value: actual, loosened: false };
  }
  if (typeof required === "boolean") {
    // The exception must approve exactly the value the project chose.
    if (exc && exc.value === actual) return { value: actual, loosened: false };
    if (required && actual !== true) return { value: true, loosened: true };
    return { value: actual, loosened: false };
  }
  if (Array.isArray(required)) {
    const cur = Array.isArray(actual) ? actual : [];
    const approved = exc && Array.isArray(exc.value) ? exc.value : [];
    const kept = cur.filter((x) => required.includes(x) || approved.includes(x));
    return { value: kept, loosened: kept.length !== cur.length };
  }
  // Plain values (strings, null): fill where empty, otherwise keep the project's value.
  if (actual === null || actual === undefined || actual === "") return { value: required, loosened: false };
  return { value: actual, loosened: false };
}

/**
 * Apply one partial minimum to a config: returns the strictest result and the control
 * paths where the incoming value was looser than the minimum. Pure.
 */
export function applyMinimum(
  cfg: GovernanceConfig,
  minimum: PartialGovernance,
  exceptionFor: (control: string) => GovernanceException | undefined = () => undefined,
): { value: GovernanceConfig; loosened: string[]; required: Record<string, unknown> } {
  const value = structuredClone(cfg) as unknown as Record<string, unknown>;
  const loosened: string[] = [];
  const required: Record<string, unknown> = {};
  for (const [path, req] of leaves(minimum)) {
    const r = tighten(path, getPath(cfg, path), req, exceptionFor(path));
    setPath(value, path, r.value);
    if (r.loosened) {
      loosened.push(path);
      required[path] = r.value;
    }
  }
  return { value: value as unknown as GovernanceConfig, loosened, required };
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Strictest-wins: combine the project's settings with every selected profile's minimums.
 * Never throws on a parsed config.
 */
export function effectivePolicy(cfg: GovernanceConfig): EffectivePolicy {
  // Only exceptions with a written reason count, and only for their exact control path.
  const excs = new Map<string, GovernanceException>();
  for (const e of cfg.exceptions ?? []) {
    if (typeof e.reason === "string" && e.reason.trim() !== "" && !excs.has(e.control)) excs.set(e.control, e);
  }
  const exceptionFor = (c: string) => excs.get(c);

  let policy = structuredClone(cfg) as GovernanceConfig;
  const violations: Violation[] = [];

  for (const profile of cfg.profiles ?? []) {
    const baseMinimum = PROFILE_MINIMUMS[profile];
    const rules = PROFILE_RULES[profile];
    if (!baseMinimum || !rules) continue;
    let minimum = baseMinimum;
    if (rules.cloudFolderNeedsApproval && (cfg.residency?.approvedCloudFolders ?? []).length === 0 && minimum.residency?.allowed) {
      minimum = {
        ...minimum,
        residency: { ...minimum.residency, allowed: minimum.residency.allowed.filter((k) => k !== "cloud_folder") },
      };
    }

    // Violations are judged against what the project itself asked for.
    const against = applyMinimum(cfg, minimum, exceptionFor);
    for (const control of against.loosened) {
      violations.push({ control, required: against.required[control], actual: getPath(cfg, control), profile });
    }
    // The policy folds in the same minimum on top of what earlier profiles produced.
    policy = applyMinimum(policy, minimum, exceptionFor).value;

    // Vendor agreements: external vendors lacking a required agreement are dropped.
    if (rules.vendorRequires.length > 0) {
      const ok = new Set(
        (cfg.vendors ?? []).filter((v) => rules.vendorRequires.every((f) => v[f] === true)).map((v) => v.id),
      );
      for (const op of PROCESSING_OPS) {
        const control = `processing.${op}`;
        const exc = exceptionFor(control);
        const approved = exc && Array.isArray(exc.value) ? (exc.value as unknown[]) : [];
        const allowed = (id: string) =>
          id === "local" ||
          approved.includes(id) ||
          ok.has(id) ||
          (op === "metadata_lookup" && (PUBLIC_METADATA_SERVICES as readonly string[]).includes(id));
        const original = cfg.processing?.[op] ?? [];
        const kept = original.filter(allowed);
        if (kept.length !== original.length) {
          violations.push({ control, required: kept, actual: original, profile });
        }
        policy.processing[op] = (policy.processing[op] ?? []).filter(allowed);
      }
    }

    // Presence checks: the software cannot make these stricter, only report them.
    for (const control of rules.require) {
      if (!exceptionFor(control) && isEmpty(getPath(cfg, control))) {
        violations.push({ control, required: "must be set (non-empty)", actual: getPath(cfg, control), profile });
      }
    }
  }
  return { policy, violations };
}
