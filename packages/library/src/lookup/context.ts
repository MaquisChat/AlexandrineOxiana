import { evaluate, type Biblio, type Creator, type GovernanceConfig, type SourceType } from "@ao/core";
import { lookupPolicyInfo, type Repo } from "../repo/repo.js";
import type { HttpClient } from "./http.js";

/** What a metadata service returned, mapped to the library's model (with the bibliographic detail it gives, R87). */
export interface LookupResult extends Biblio {
  title: string;
  creators: Creator[];
  issued?: string;
  container?: string;
  publisher?: string;
  type: SourceType;
  identifiers: { doi?: string; isbn?: string[]; issn?: string };
  provider: string;
}

/**
 * The policy context every lookup runs in (R50): which project it is made for, that project's
 * effective governance (null when it cannot be read: every provider is then denied), and whether
 * the project is encrypted (`sensitive`: responses are cached in memory only).
 */
export interface LookupContext {
  http: HttpClient;
  policy: GovernanceConfig | null;
  projectId: string;
  actor: string;
  tz?: string;
  clock?: () => Date;
  /**
   * Lookup made for an encrypted project: responses are cached in memory only and the plain-HTTP
   * Library of Congress endpoint is never used (R52). Fail-closed: anything but an explicit
   * `false` counts as sensitive. `lookupContextFor` sets it from the project.
   */
  sensitive?: boolean;
  /**
   * R379 (ii): an import may search for an item by the title from its file name, its embedded
   * metadata or a reference manager's record (`resolveItem` steps 5 and 6) only when this is `true`:
   * the project's rules say it holds no identifiable data. Fail-closed: absent counts as false.
   * Look-ups by identifier (DOI, ISBN, arXiv) are not affected. `lookupContextFor` sets it.
   */
  titleSearchAllowed?: boolean;
  /** Receives a short note when a provider is skipped (denied by policy, or unavailable). */
  debug?: (note: string) => void;
}

export type Provider = "crossref" | "openalex" | "openlibrary" | "loc" | "elicit";

/** True unless the context explicitly says `sensitive: false` (R52, fail-closed). */
export const isSensitive = (ctx: LookupContext): boolean => ctx.sensitive !== false;

/** `evaluate({action:'process', process:{op:'metadata_lookup', provider}})`; a deny is a debug note, never an error. */
export function providerAllowed(ctx: LookupContext, provider: Provider): boolean {
  if (!ctx.policy) {
    ctx.debug?.(`metadata lookup via ${provider} skipped: the project's policy could not be read (not permitted)`);
    return false;
  }
  const d = evaluate(ctx.policy, {
    action: "process",
    projectId: ctx.projectId,
    actor: ctx.actor,
    now: (ctx.clock?.() ?? new Date()).toISOString(),
    tz: ctx.tz,
    process: { op: "metadata_lookup", provider },
  });
  if (d.result === "deny") {
    ctx.debug?.(`metadata lookup via ${provider} skipped: not permitted for this project (${d.reason})`);
    return false;
  }
  return true;
}

/** The lookup context for one of the repository's projects. Throws NotFoundError for an unknown project. */
export async function lookupContextFor(
  repo: Repo,
  projectId: string,
  http: HttpClient,
  opts: { debug?: (note: string) => void } = {},
): Promise<LookupContext> {
  const info = await lookupPolicyInfo(repo, projectId);
  // R379 (ii): only a readable policy that says the project holds no identifiable data allows title
  // searches; R385 c: never for a locked encrypted project (nothing can be stored in it: fail closed).
  const locked = info.sensitive && !repo.isUnlocked(projectId);
  const titleSearchAllowed = !locked && info.policy?.identifiability.containsIdentifiable === false;
  return { http, projectId, ...info, titleSearchAllowed, ...(opts.debug ? { debug: opts.debug } : {}) };
}
