/**
 * Internal test seams. Not exported from the package; tests reach them through
 * `./testing.js`.
 */

/** Points in a mutation where a simulated crash can be injected. */
export type CrashPoint = "before-changes" | "before-audit" | "between-audit" | "before-marker-delete";

export const seams: { crashAt?: CrashPoint } = {};

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
