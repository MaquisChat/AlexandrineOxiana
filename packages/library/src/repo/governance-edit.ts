/**
 * Editing a project's governance.yaml (Task 30, R96): the new text must parse with the core schema;
 * a change that loosens any control (the effective policy gets weaker: `loosenedControls`) or asks
 * for less than a selected profile requires (a new effectivePolicy violation) needs a written
 * reason, which is recorded on the audit event. The write itself is one governed change under the
 * rules as they were before it (R26 txn, change log, audit), like any other.
 */
import { DEFAULT_GOVERNANCE, effectivePolicy, loosenedControls, parseGovernance, type GovernanceConfig, type Violation } from "@ao/core";
import { GovernanceViolationError } from "./errors.js";
import { readMaybe } from "./io.js";
import { runMutation } from "./mutate.js";
import type { RepoCore } from "./state.js";

/** Longest governance.yaml accepted (bytes). */
export const GOVERNANCE_MAX_BYTES = 64 * 1024;

export class GovernanceLooseningError extends Error {
  override name = "GovernanceLooseningError";
  constructor(
    /** Controls the edit makes looser than before. */
    readonly loosened: string[],
    /** Controls where the edit asks for less than a selected profile requires. */
    readonly violations: Violation[],
  ) {
    const parts = [
      ...loosened.map((c) => `${c} is looser than before`),
      ...violations.map((v) => `${v.control}: the ${v.profile} profile requires ${JSON.stringify(v.required)} (this asks for ${JSON.stringify(v.actual)})`),
    ];
    super(`This change loosens the project's rules, so it needs a reason: ${parts.join("; ")}`);
  }
}

export interface GovernanceEditResult {
  /** Profile minimums the new text asks to go below (the effective policy still applies them). */
  violations: Violation[];
  /** Controls loosened by the edit (recorded with the reason). */
  loosened: string[];
}

const key = (v: Violation) => `${v.profile}\u0000${v.control}`;

export async function setGovernance(core: RepoCore, projectId: string, yamlText: string, opts: { reason?: string } = {}): Promise<GovernanceEditResult> {
  core.assertWritable();
  if (typeof yamlText !== "string") throw new TypeError("the governance text must be a string");
  if (Buffer.byteLength(yamlText, "utf8") > GOVERNANCE_MAX_BYTES) throw new TypeError(`governance.yaml must be at most ${GOVERNANCE_MAX_BYTES} bytes`);
  const next = parseGovernance(yamlText); // GovernanceParseError for invalid text
  const st = core.state(projectId);
  const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
  const cur: GovernanceConfig = raw ? parseGovernance(raw.toString("utf8")) : DEFAULT_GOVERNANCE;
  const loosened = loosenedControls(cur, next);
  const before = new Set(effectivePolicy(cur).violations.map(key));
  const effective = effectivePolicy(next);
  const fresh = effective.violations.filter((v) => !before.has(key(v)));
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if ((loosened.length || fresh.length) && !reason) throw new GovernanceLooseningError(loosened, fresh);
  if (reason.length > 2000) throw new TypeError("the reason must be at most 2000 characters");
  // The project's own state must still satisfy the new rules (as at creation).
  if (!st.project.encryption.enabled) {
    const p = effective.policy;
    if (p.encryption.atRest === "required") throw new GovernanceViolationError("Governance requires encryption at rest, but this project is not encrypted");
    if (p.identifiability.containsIdentifiable && p.identifiability.pseudonymizeFileNames) {
      throw new GovernanceViolationError("This project contains identifiable data and pseudonymizes file names; that needs an encrypted project");
    }
  }
  await runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      await tx.writeFile(`${st.rel}/governance.yaml`, yamlText);
      tx.record("project", projectId, { governanceYaml: raw ? raw.toString("utf8") : "" }, { governanceYaml: yamlText });
    },
    {
      op: "project.governance",
      entity: { type: "project", id: projectId },
      auditDetails: {
        ...(loosened.length ? { loosened } : {}),
        ...(fresh.length ? { violations: fresh.map((v) => ({ control: v.control, profile: v.profile })) } : {}),
        ...(reason ? { reason } : {}),
      },
    },
  );
  return { violations: effective.violations, loosened };
}
