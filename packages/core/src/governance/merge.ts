import { PROFILE_MINIMUMS, PROFILE_RULES } from "./profiles/index.js";
import {
  ENCRYPTION_LEVELS,
  LOCATION_LEVELS,
  PROCESSING_OPS,
  PUBLIC_METADATA_SERVICES,
  type GovernanceConfig,
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
const DATE_PATHS = new Set(["retention.rawDataDestroyAfter", "protocol.expires"]);

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

/** Strictest of (actual, required) for one control, and whether `actual` was looser. */
function tighten(path: string, actual: unknown, required: unknown): { value: unknown; loosened: boolean } {
  const order = ORDERS[path];
  if (order) {
    const ra = order.indexOf(actual as string);
    const rr = order.indexOf(required as string);
    return ra >= rr ? { value: actual, loosened: false } : { value: required, loosened: true };
  }
  if (DATE_PATHS.has(path)) {
    if (actual === null || actual === undefined) return { value: required, loosened: false };
    if (required === null || required === undefined) return { value: actual, loosened: false };
    return time(required) < time(actual)
      ? { value: required, loosened: true }
      : { value: actual, loosened: false };
  }
  if (typeof required === "boolean") {
    if (required && actual !== true) return { value: true, loosened: true };
    return { value: actual, loosened: false };
  }
  if (Array.isArray(required)) {
    const cur = Array.isArray(actual) ? actual : [];
    const kept = cur.filter((x) => required.includes(x));
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
  skip: (control: string) => boolean = () => false,
): { value: GovernanceConfig; loosened: string[]; required: Record<string, unknown> } {
  const value = structuredClone(cfg) as unknown as Record<string, unknown>;
  const loosened: string[] = [];
  const required: Record<string, unknown> = {};
  for (const [path, req] of leaves(minimum)) {
    if (skip(path)) continue;
    const r = tighten(path, getPath(cfg, path), req);
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
  const waived = new Set(
    (cfg.exceptions ?? [])
      .filter((e) => typeof e.reason === "string" && e.reason.trim() !== "")
      .map((e) => e.control),
  );
  const isWaived = (c: string) => waived.has(c);

  let policy = structuredClone(cfg) as GovernanceConfig;
  const violations: Violation[] = [];

  for (const profile of cfg.profiles ?? []) {
    const minimum = PROFILE_MINIMUMS[profile];
    const rules = PROFILE_RULES[profile];
    if (!minimum || !rules) continue;

    // Violations are judged against what the project itself asked for.
    const against = applyMinimum(cfg, minimum, isWaived);
    for (const control of against.loosened) {
      violations.push({ control, required: against.required[control], actual: getPath(cfg, control), profile });
    }
    // The policy folds in the same minimum on top of what earlier profiles produced.
    policy = applyMinimum(policy, minimum, isWaived).value;

    // Vendor agreements: external vendors lacking a required agreement are dropped.
    if (rules.vendorRequires.length > 0) {
      const ok = new Set(
        (cfg.vendors ?? []).filter((v) => rules.vendorRequires.every((f) => v[f] === true)).map((v) => v.id),
      );
      for (const op of PROCESSING_OPS) {
        const control = `processing.${op}`;
        if (isWaived(control)) continue;
        const allowed = (id: string) =>
          id === "local" ||
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
      if (!isWaived(control) && isEmpty(getPath(cfg, control))) {
        violations.push({ control, required: "must be set (non-empty)", actual: getPath(cfg, control), profile });
      }
    }
  }
  return { policy, violations };
}
