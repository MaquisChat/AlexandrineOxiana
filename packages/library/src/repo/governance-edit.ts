/**
 * Editing a project's governance.yaml (Task 30, R96, R98, R99): the new text must parse with the
 * core schema; the edit names the version it was made from (`baseSha256`, the SHA-256 of the file
 * as read, "" bytes when there is none) and is refused with GovernanceConflictError when the file
 * changed since. Inside the governed change (under the repository's serial lock) the current file
 * is read again and compared: a change that loosens any control (`loosenedControls`) or asks for
 * less than a selected profile requires (a new effectivePolicy violation) needs a written reason,
 * recorded on the audit event. An unreadable current file may be replaced, but only with a reason
 * (everything counts as loosened); the change is then evaluated under the new rules.
 */
import { createHash } from "node:crypto";
import { DEFAULT_GOVERNANCE, effectivePolicy, loosenedControls, parseGovernance, type GovernanceConfig, type Violation } from "@ao/core";
import { GovernanceViolationError, InvalidInputError } from "./errors.js";
import { readMaybe } from "./io.js";
import { runMutation } from "./mutate.js";
import type { RepoCore } from "./state.js";

/** Longest governance.yaml accepted (bytes). */
export const GOVERNANCE_MAX_BYTES = 64 * 1024;
/** What `loosened` lists when the current file could not be read. */
export const UNREADABLE_GOVERNANCE = "(unreadable governance.yaml)";

export class GovernanceLooseningError extends Error {
  override name = "GovernanceLooseningError";
  constructor(
    /** Controls the edit makes looser than before. */
    readonly loosened: string[],
    /** Controls where the edit asks for less than a selected profile requires. */
    readonly violations: Violation[],
  ) {
    const parts = [
      ...loosened.map((c) => (c === UNREADABLE_GOVERNANCE ? "the current rules file cannot be read, so replacing it" : `${c} is looser than before`)),
      ...violations.map((v) => `${v.control}: the ${v.profile} profile requires ${JSON.stringify(v.required)} (this asks for ${JSON.stringify(v.actual)})`),
    ];
    super(`This change loosens the project's rules, so it needs a reason: ${parts.join("; ")}`);
  }
}

/** The rules file changed since the version the edit was made from. */
export class GovernanceConflictError extends Error {
  override name = "GovernanceConflictError";
  constructor() {
    super("The project's rules were changed since you opened them. Reload them and make your change again.");
  }
}

export interface GovernanceEditResult {
  /** Profile minimums the new text asks to go below (the effective policy still applies them). */
  violations: Violation[];
  /** Controls loosened by the edit (recorded with the reason). */
  loosened: string[];
  /** SHA-256 of the file now (the base for the next edit). */
  sha256: string;
}

export const sha256Of = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** The file as written (the empty text when there is none) and its SHA-256. */
export async function readGovernance(core: RepoCore, projectId: string): Promise<{ yaml: string; sha256: string }> {
  const st = core.state(projectId);
  const raw = (await readMaybe(core.abs(`${st.rel}/governance.yaml`))) ?? Buffer.alloc(0);
  return { yaml: raw.toString("utf8"), sha256: sha256Of(raw) };
}

const key = (v: Violation) => `${v.profile}\u0000${v.control}`;

export async function setGovernance(core: RepoCore, projectId: string, yamlText: string, opts: { baseSha256: string; reason?: string }): Promise<GovernanceEditResult> {
  core.assertWritable();
  if (typeof yamlText !== "string") throw new InvalidInputError("the governance text must be text");
  if (Buffer.byteLength(yamlText, "utf8") > GOVERNANCE_MAX_BYTES) throw new InvalidInputError(`governance.yaml must be at most ${GOVERNANCE_MAX_BYTES} bytes`);
  if (typeof opts?.baseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(opts.baseSha256)) {
    throw new InvalidInputError("the version of the rules this change was made from (baseSha256) is required");
  }
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (reason.length > 2000) throw new InvalidInputError("the reason must be at most 2000 characters");
  const next = parseGovernance(yamlText); // GovernanceParseError for invalid text
  const effective = effectivePolicy(next);
  const st = core.state(projectId);
  // The project's own state must satisfy the new rules (as at creation).
  if (!st.project.encryption.enabled) {
    const p = effective.policy;
    if (p.encryption.atRest === "required") throw new GovernanceViolationError("Governance requires encryption at rest, but this project is not encrypted");
    if (p.identifiability.containsIdentifiable && p.identifiability.pseudonymizeFileNames) {
      throw new GovernanceViolationError("This project contains identifiable data and pseudonymizes file names; that needs an encrypted project");
    }
  }
  // Is the current file readable? (Decides the policy the write itself is evaluated under.)
  const pre = await readGovernance(core, projectId);
  let unreadable = false;
  try {
    if (pre.yaml) parseGovernance(pre.yaml);
  } catch {
    unreadable = true;
  }
  let result: { loosened: string[]; fresh: Violation[]; repaired: boolean } | undefined;
  await runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      // Under the serial lock: the file as it is now, and the decision made against it.
      const raw = (await readMaybe(core.abs(`${st.rel}/governance.yaml`))) ?? Buffer.alloc(0);
      if (sha256Of(raw) !== opts.baseSha256) throw new GovernanceConflictError();
      let cur: GovernanceConfig | undefined;
      try {
        cur = raw.length ? parseGovernance(raw.toString("utf8")) : DEFAULT_GOVERNANCE;
      } catch {
        cur = undefined;
      }
      const loosened = cur ? loosenedControls(cur, next) : [UNREADABLE_GOVERNANCE];
      const before = new Set(cur ? effectivePolicy(cur).violations.map(key) : []);
      const fresh = effective.violations.filter((v) => !before.has(key(v)));
      if ((loosened.length || fresh.length) && !reason) throw new GovernanceLooseningError(loosened, fresh);
      await tx.writeFile(`${st.rel}/governance.yaml`, yamlText);
      tx.record("project", projectId, { governanceYaml: raw.toString("utf8") }, { governanceYaml: yamlText });
      result = { loosened, fresh, repaired: !cur };
    },
    {
      op: "project.governance",
      entity: { type: "project", id: projectId },
      // Known once the decision inside the change is made.
      auditDetails: () => details(),
      // The old rules cannot be read: the write is judged under the new ones (a reason is required).
      ...(unreadable ? { unreadablePolicyFallback: next } : {}),
    },
  );
  function details(): Record<string, unknown> {
    if (!result) return {};
    return {
      ...(result.loosened.length ? { loosened: result.loosened } : {}),
      ...(result.fresh.length ? { violations: result.fresh.map((v) => ({ control: v.control, profile: v.profile })) } : {}),
      ...(result.repaired ? { repairedUnreadable: true } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return { violations: effective.violations, loosened: result!.loosened, sha256: sha256Of(yamlText) };
}
