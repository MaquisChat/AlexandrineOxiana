/**
 * Internal test seams. Not exported from the package; tests reach them through
 * `./testing.js`.
 */

/** Points in a mutation where a simulated crash can be injected. */
export type CrashPoint =
  | "before-changes"
  | "before-audit"
  | "between-audit"
  | "before-marker-delete"
  | "torn-audit"
  /** Issuing a new recovery code (R141): before the staged key file is written. */
  | "recovery-before-stage"
  /** After the commit point, before the staged key file is made active. */
  | "recovery-before-activate"
  /** The active key file replaced, the staged one not yet removed. */
  | "recovery-mid-activate"
  /** Activation finished, before the code is returned. */
  | "recovery-after-activate";

export const seams: {
  crashAt?: CrashPoint;
  /** Makes every undo step of this kind fail (until cleared). */
  failUndo?: "created" | "replaced" | "dir" | "trashed" | "append";
  /** Runs after a new folder is recorded in the marker and before it is created (a racing writer, R62). */
  beforeMkdir?: (abs: string) => Promise<void>;
  /** Makes every audit append for this project id fail (until cleared). */
  failAuditAppendFor?: string;
  /** Receives a newly issued recovery code before the change is written (crash tests, Task 61). */
  onRecoveryCode?: (code: string) => void;
} = {};

/** Thrown at a crash point; the mutation does NOT roll back (as if the process died). */
export class SimulatedCrash extends Error {
  override name = "SimulatedCrash";
}

export function maybeCrash(point: CrashPoint): void {
  if (seams.crashAt === point) {
    seams.crashAt = undefined;
    throw new SimulatedCrash(`simulated crash at ${point}`);
  }
}

/** Options that only tests may set (fast scrypt, small audit segments). */
export interface InternalOptions {
  scryptN?: number;
  auditSegmentSize?: number;
}
