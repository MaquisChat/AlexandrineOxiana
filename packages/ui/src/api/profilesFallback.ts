/**
 * TEMPORARY (R114 I2): until GET /projects sends each project's `profiles`, the badges come from
 * the project's governance.yaml, parsed here. Once the service sends them, `projectProfiles` never
 * reaches the fallback; at integration delete `profilesFromGovernance`, the yaml import and the
 * `yaml` dependency of @ao/ui, and make projectProfiles return `knownProfiles(p.profiles)`.
 */
import { parse } from "yaml";
import { knownProfiles, type ProfileId, type ProjectSummary } from "./library";

/** The service's own limit for governance.yaml; anything larger is not parsed at all. */
export const GOVERNANCE_TEXT_MAX_BYTES = 64 * 1024;

/** The compliance profiles a governance.yaml names (`profiles:`); unreadable, unknown or too large → none. */
export function profilesFromGovernance(yaml: string): ProfileId[] {
  if (typeof yaml !== "string" || yaml.length > GOVERNANCE_TEXT_MAX_BYTES || new TextEncoder().encode(yaml).length > GOVERNANCE_TEXT_MAX_BYTES) return [];
  let doc: unknown;
  try {
    doc = parse(yaml, { schema: "core", maxAliasCount: 20 });
  } catch {
    return [];
  }
  return knownProfiles(doc && typeof doc === "object" ? (doc as { profiles?: unknown }).profiles : undefined);
}

/** The project's badges: the service's `profiles` when sent, else (for now) read from its rules. */
export async function projectProfiles(p: Pick<ProjectSummary, "id" | "profiles">, governance: (id: string) => Promise<{ yaml: string }>): Promise<ProfileId[]> {
  if (p.profiles !== undefined) return knownProfiles(p.profiles);
  try {
    return profilesFromGovernance((await governance(p.id)).yaml);
  } catch {
    return [];
  }
}
