import { z } from "zod";
import {
  GovernanceParseError,
  PartialGovernanceSchema,
  PROFILES,
  formatZodIssues,
  parsePartial,
  type PartialGovernance,
  type Profile,
} from "../schema.js";
import { DMP_YAML, GDPR_YAML, HIPAA_YAML, IRB_YAML } from "./yaml-text.js";

export { DMP_YAML, GDPR_YAML, HIPAA_YAML, IRB_YAML };

export const PROFILE_YAML: Record<Profile, string> = {
  irb: IRB_YAML,
  gdpr: GDPR_YAML,
  hipaa: HIPAA_YAML,
  dmp: DMP_YAML,
};

export interface ProfileRules {
  /** Which vendor agreement flags an external vendor must have: baa, dpa. */
  vendorRequires: Array<"baa" | "dpa">;
  /** Control paths that must be present (non-null, non-empty). */
  require: string[];
}

const ExtrasSchema = z
  .object({
    vendorRequires: z.array(z.enum(["baa", "dpa"])).optional(),
    require: z.array(z.string()).optional(),
  })
  .strict();

function load(profile: Profile): { minimum: PartialGovernance; rules: ProfileRules } {
  const label = `profiles/${profile}.yaml`;
  const raw = parsePartial(PROFILE_YAML[profile], label);
  const { vendorRequires, require, ...rest } = raw;
  const r = PartialGovernanceSchema.safeParse(rest);
  const x = ExtrasSchema.safeParse({ vendorRequires, require });
  if (!r.success || !x.success) {
    const err = !r.success ? r.error : (x as { error: z.ZodError }).error;
    const issues = formatZodIssues(err, label);
    throw new GovernanceParseError(`${label} is invalid:\n${issues.join("\n")}`, issues);
  }
  return {
    minimum: r.data as PartialGovernance,
    rules: { vendorRequires: x.data.vendorRequires ?? [], require: x.data.require ?? [] },
  };
}

const loaded = Object.fromEntries(PROFILES.map((p) => [p, load(p)])) as Record<
  Profile,
  { minimum: PartialGovernance; rules: ProfileRules }
>;

export const PROFILE_MINIMUMS: Record<Profile, PartialGovernance> = Object.fromEntries(
  PROFILES.map((p) => [p, loaded[p].minimum]),
) as Record<Profile, PartialGovernance>;

export const PROFILE_RULES: Record<Profile, ProfileRules> = Object.fromEntries(
  PROFILES.map((p) => [p, loaded[p].rules]),
) as Record<Profile, ProfileRules>;
