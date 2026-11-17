/**
 * Editing a project's governance.yaml (Task 30, R96, R98, R99): the new text must parse with the
 * core schema; the edit names the version it was made from (`baseSha256`, the SHA-256 of the file
 * as read, "" bytes when there is none) and is refused with GovernanceConflictError when the file
 * changed since. Inside the governed change (under the repository's serial lock) the current file
 * is read again and compared: a change that loosens any control (`loosenedControls`) or asks for
 * less than a selected profile requires (a new effectivePolicy violation) needs a written reason,
 * recorded on the audit event.
 *
 * R397 a: a current file that is missing (or a link that leads nowhere) or that the engine cannot
 * read may be replaced by readable rules: the edit is then decided as a change from the default
 * rules (DEFAULT_GOVERNANCE, the strictest) to the new ones, ALWAYS needs a reason (whatever the new
 * rules say), and is audited with `rulesFile: "missing" | "unreadable"`. The write itself is
 * evaluated under the new rules (`unreadablePolicyFallback`): the engine has no rules of the project
 * to judge it by, and the defaults would refuse it in any project that is not encrypted (they ask
 * for encryption at rest). Every other change in the project stays refused until then.
 */
import { createHash } from "node:crypto";
import { DEFAULT_GOVERNANCE, effectivePolicy, loosenedControls, parseGovernance, type GovernanceConfig, type Violation } from "@ao/core";
import { GovernanceViolationError, InvalidInputError } from "./errors.js";
import { readMaybe } from "./io.js";
import { auditedReasonIn } from "./audit-reasons.js";
import { runMutation } from "./mutate.js";
import type { RepoCore } from "./state.js";

/** Longest governance.yaml accepted (bytes). */
export const GOVERNANCE_MAX_BYTES = 64 * 1024;
/** Why the current rules file is being replaced without rules to compare with (R397 a). */
export type GovernanceRepair = "missing" | "unreadable";

export class GovernanceLooseningError extends Error {
  override name = "GovernanceLooseningError";
  constructor(
    /** Controls the edit makes looser than before. */
    readonly loosened: string[],
    /** Controls where the edit asks for less than a selected profile requires. */
    readonly violations: Violation[],
    /** Set when the current file is missing or cannot be read: the change is compared with the default rules (R397 a). */
    readonly repair?: GovernanceRepair,
  ) {
    const parts = [
      ...loosened.map((c) => `${c} is looser than ${repair ? "the strictest rules" : "before"}`),
      ...violations.map((v) => `${v.control}: the ${v.profile} profile requires ${JSON.stringify(v.required)} (this asks for ${JSON.stringify(v.actual)})`),
    ];
    const head = repair
      ? `The project's rules file ${repair === "missing" ? "is missing" : "cannot be read"}, so putting rules back needs a reason`
      : "This change loosens the project's rules, so it needs a reason";
    super(parts.length ? `${head}: ${parts.join("; ")}` : `${head}.`);
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

/**
 * The rules file as read: there, missing (no file, or a link that leads nowhere; R397 a), or
 * something that cannot be opened in its place (a folder, a file without permission; R397 e).
 */
export type GovernanceFileState = "present" | "missing" | "unopenable";

/** Why a save cannot replace what is in the rules file's place (R397 e). */
export const GOVERNANCE_UNOPENABLE_SAVE =
  "The rules file could not be opened (something other than a readable file, such as a folder, is in its place), so it cannot be replaced from here. Remove it from the project's folder, then save the rules again.";

/**
 * The file as written (the empty text when there is none), its SHA-256, and whether it is there at
 * all. Throws when something that cannot be opened is in its place (callers fail closed on that).
 */
export async function readGovernance(core: RepoCore, projectId: string): Promise<{ yaml: string; sha256: string; file: "present" | "missing" }> {
  const st = core.state(projectId);
  const buf = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
  const raw = buf ?? Buffer.alloc(0);
  return { yaml: raw.toString("utf8"), sha256: sha256Of(raw), file: buf ? "present" : "missing" };
}

/**
 * As `readGovernance`, but something that cannot be opened in the file's place is answered as
 * `file: "unopenable"` with the empty text, never thrown (R397 e: the rules' screen says so).
 */
export async function readGovernanceFile(core: RepoCore, projectId: string): Promise<{ yaml: string; sha256: string; file: GovernanceFileState }> {
  try {
    return await readGovernance(core, projectId);
  } catch (err) {
    if (!isFsError(err)) throw err;
    return { yaml: "", sha256: sha256Of(Buffer.alloc(0)), file: "unopenable" };
  }
}

/** A file-system error (EISDIR, EACCES, ELOOP, …), not a project that is unknown or locked. */
const isFsError = (err: unknown): boolean => typeof (err as NodeJS.ErrnoException | null)?.code === "string" && /^E[A-Z]+$/.test((err as NodeJS.ErrnoException).code!);

/** The rules file's bytes for the edit; something that cannot be opened in its place refuses the save (R397 e). */
async function readForEdit(path: string): Promise<Buffer | null> {
  try {
    return await readMaybe(path);
  } catch (err) {
    if (isFsError(err)) throw new InvalidInputError(GOVERNANCE_UNOPENABLE_SAVE);
    throw err;
  }
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
  // Is the current file there and readable? (Decides the policy the write itself is evaluated under.)
  const pre = await readGovernanceFile(core, projectId);
  if (pre.file === "unopenable") throw new InvalidInputError(GOVERNANCE_UNOPENABLE_SAVE);
  let repairing = pre.file === "missing";
  try {
    if (pre.yaml) parseGovernance(pre.yaml);
  } catch {
    repairing = true;
  }
  let result: { loosened: string[]; fresh: Violation[]; repair: GovernanceRepair | undefined } | undefined;
  await runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      // Under the serial lock: the file as it is now, and the decision made against it.
      const buf = await readForEdit(core.abs(`${st.rel}/governance.yaml`));
      const raw = buf ?? Buffer.alloc(0);
      if (sha256Of(raw) !== opts.baseSha256) throw new GovernanceConflictError();
      let cur: GovernanceConfig | undefined;
      let repair: GovernanceRepair | undefined = buf ? undefined : "missing";
      if (buf) {
        try {
          cur = raw.length ? parseGovernance(raw.toString("utf8")) : DEFAULT_GOVERNANCE;
        } catch {
          repair = "unreadable";
        }
      }
      // R397 a: no rules to compare with → compared with the default (strictest) rules, and a reason is always needed.
      const from = cur ?? DEFAULT_GOVERNANCE;
      const loosened = loosenedControls(from, next);
      const before = new Set(effectivePolicy(from).violations.map(key));
      const fresh = effective.violations.filter((v) => !before.has(key(v)));
      if ((repair || loosened.length || fresh.length) && !reason) throw new GovernanceLooseningError(loosened, fresh, repair);
      await tx.writeFile(`${st.rel}/governance.yaml`, yamlText);
      tx.record("project", projectId, { governanceYaml: raw.toString("utf8") }, { governanceYaml: yamlText });
      result = { loosened, fresh, repair };
    },
    {
      op: "project.governance",
      entity: { type: "project", id: projectId },
      // Known once the decision inside the change is made.
      auditDetails: () => details(),
      ...(reason ? { sealedReason: reason } : {}),
      // The old rules are missing or cannot be read: the write is judged under the new ones (a reason is required).
      ...(repairing ? { unreadablePolicyFallback: next } : {}),
    },
  );
  function details(): Record<string, unknown> {
    if (!result) return {};
    return {
      ...(result.loosened.length ? { loosened: result.loosened } : {}),
      ...(result.fresh.length ? { violations: result.fresh.map((v) => ({ control: v.control, profile: v.profile })) } : {}),
      // R397 a: the file was replaced while the engine could not read it, and why (a word, never a path).
      ...(result.repair ? { repairedUnreadable: true, rulesFile: result.repair } : {}),
      // R362 b: in an encrypted project only that a reason was given and its keyed digest (R369 b); the text is sealed in this change.
      ...(reason ? auditedReasonIn(core, st, reason) : {}),
    };
  }
  return { violations: effective.violations, loosened: result!.loosened, sha256: sha256Of(yamlText) };
}
