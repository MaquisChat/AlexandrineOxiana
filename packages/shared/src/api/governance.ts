/**
 * Whether the policy engine can read a project's rules file (R379 FR-A18, R58). The policy engine
 * reads governance.yaml strictly: an unknown key, a wrong type or a bad value makes the file
 * unreadable, and then every capture, import, change and export in the project is refused
 * (governance fails closed). The rules' answers say so, so the screens can say it too.
 *
 * - `GET /projects/:id/governance` → `{ yaml, sha256, violations, ...GovernanceReadability }` for
 *   the file as it is.
 * - `PUT /projects/:id/governance` → `{ violations, loosened, sha256, ...GovernanceReadability }` for
 *   the text just saved (a saved text is always readable; its warnings may not be empty).
 */
export interface GovernanceReadability {
  /** False when the policy engine cannot read the rules: every request in the project is then refused. */
  readable: boolean;
  /**
   * When not readable: one plain line per problem, each naming the key and what is wrong (no path). Empty otherwise.
   * At most twenty, then a last line "and N more."; each at most 300 characters, cut with "…" (R397 b).
   */
  issues: string[];
  /** Notes from reading readable rules (a key in an old spelling, an exception that waives nothing). Empty when none. Bounded as `issues`. */
  warnings: string[];
}

/** The Governance screen's alert when the rules cannot be read (R379 FR-A18). */
export const GOVERNANCE_UNREADABLE_TEXT = "The app cannot read this project's rules. Until they are corrected it refuses every capture, import, change and export in this project.";
/** The Governance screen's note above the warnings of readable rules. */
export const GOVERNANCE_WARNINGS_TEXT = "The rules were read, with these notes:";
/** The Capture screen's reason when the project's rules cannot be read. */
export const CAPTURE_RULES_UNREADABLE_TEXT = "This project's rules cannot be read, so nothing can be captured here. Correct them on the Governance screen.";
/** The Import screens' reason when the project's rules cannot be read. */
export const IMPORT_RULES_UNREADABLE_TEXT = "This project's rules cannot be read, so nothing can be imported here. Correct them on the Governance screen.";
