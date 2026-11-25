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
  /**
   * Decision 31 (b), R556 (2): "leave-out" — a service that asks to wait is not waited for (the client's
   * `GetOptions.askedToWait`): its lookup ends at once with LookupLeftOutError. Set only by the interactive attach and a
   * watched folder's bringing-in; absent, every lookup waits as before (Bulk Import, Zotero, Find and acquire).
   */
  askedToWait?: "leave-out";
  /** Decision 31 (c), R585 M2: passed to every request of this context (`GetOptions.onSend`): told when a request leaves. */
  onSend?: () => void;
  /**
   * FR-765: the stop of the work this context serves (a Find run: "Stop", a project's lock, a library move, a close).
   * Passed to every request of this context (`GetOptions.signal`): once it is aborted nothing more is sent for it.
   * FR-769: a Bulk Import run (so a device import, a Zotero Web import, its resume, a Zotero sync), an attach and "Look
   * up again" carry their project's lock stop (`Repo.lockStopOf`): at the project's lock nothing more is sent for them.
   * Absent for the settings' test, which behaves as before.
   */
  signal?: AbortSignal;
}

export type Provider = "crossref" | "openalex" | "openlibrary" | "loc" | "elicit";

/** True unless the context explicitly says `sensitive: false` (R52, fail-closed). */
export const isSensitive = (ctx: LookupContext): boolean => ctx.sensitive !== false;

/** The context's stop as request options (FR-765): `{ signal }`, or nothing when the context has none. */
export const stopOf = (ctx: LookupContext): { signal?: AbortSignal } => (ctx.signal ? { signal: ctx.signal } : {});

/** The request options every provider passes from its context: sensitivity (R52), the rule on waits (R556 2), its stop. */
export const requestRules = (ctx: LookupContext): { sensitive: boolean; askedToWait?: "leave-out"; onSend?: () => void; signal?: AbortSignal } => ({
  sensitive: isSensitive(ctx),
  ...(ctx.askedToWait === "leave-out" ? { askedToWait: "leave-out" as const } : {}),
  ...(ctx.onSend ? { onSend: ctx.onSend } : {}),
  ...stopOf(ctx),
});

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

/**
 * FR-759, FR-767 (as R600 I2; R30, R50): called when work that looked things up for `projectId` ends, whether it
 * succeeded, failed or was cancelled. The lock route drops the client's sensitive answers at the lock, but an answer
 * that was in the air then lands after it. So when the project is encrypted and no longer unlocked (or can no longer
 * be read: removed meanwhile), every sensitive answer is dropped again, and nothing looked up for a locked project
 * stays in memory. Coarse, as the lock route's purge is: another unlocked project's sensitive answers go too, and are
 * simply looked up again.
 */
export function forgetSensitiveIfLocked(repo: Repo, http: HttpClient, projectId: string): void {
  let locked: boolean;
  try {
    locked = repo.getProject(projectId).encryption.enabled && !repo.isUnlocked(projectId);
  } catch {
    locked = true; // the project cannot be read: nothing of it is kept either
  }
  if (locked) http.purgeSensitive();
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
