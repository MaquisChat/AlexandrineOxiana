import { z } from "zod";
import {
  ALL_DATE_FIELDS,
  DATE_PATHS,
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
  /**
   * When true, `cloud_folder` in residency.allowed is honoured only if the project's
   * residency.approvedCloudFolders is non-empty. Public `cloud` is never re-allowed by this rule.
   */
  cloudFolderNeedsApproval: boolean;
}

const ExtrasSchema = z
  .object({
    vendorRequires: z.array(z.enum(["baa", "dpa"])).optional(),
    require: z.array(z.string()).optional(),
    cloudFolderNeedsApproval: z.boolean().optional(),
  })
  .strict();

function getPath(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), o);
}

function load(profile: Profile): { minimum: PartialGovernance; rules: ProfileRules } {
  const label = `profiles/${profile}.yaml`;
  const raw = parsePartial(PROFILE_YAML[profile], label);
  const { vendorRequires, require, cloudFolderNeedsApproval, ...rest } = raw;
  const r = PartialGovernanceSchema.safeParse(rest);
  const x = ExtrasSchema.safeParse({ vendorRequires, require, cloudFolderNeedsApproval });
  if (!r.success || !x.success) {
    const err = !r.success ? r.error : (x as { error: z.ZodError }).error;
    const issues = formatZodIssues(err, label);
    throw new GovernanceParseError(`${label} is invalid:\n${issues.join("\n")}`, issues);
  }
  // Only DATE_PATHS have "earliest wins" semantics in merge.ts. A profile that set any other
  // date field would be silently treated as fill-if-empty, so refuse to load it instead.
  for (const f of ALL_DATE_FIELDS) {
    if (!DATE_PATHS.has(f) && getPath(r.data, f) != null) {
      throw new GovernanceParseError(`${label}: ${f} is a date with no merge rule; add it to DATE_PATHS first`, [f]);
    }
  }
  return {
    minimum: r.data as PartialGovernance,
    rules: {
      vendorRequires: x.data.vendorRequires ?? [],
      require: x.data.require ?? [],
      cloudFolderNeedsApproval: x.data.cloudFolderNeedsApproval ?? false,
    },
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
