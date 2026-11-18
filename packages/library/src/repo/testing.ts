/**
 * Test-only entry point: internal options (fast scrypt, small audit segments)
 * and crash injection. Deliberately not re-exported from `src/index.ts`.
 */
export { openRepoInternal as openTestRepo } from "./repo.js";
export { SimulatedCrash, seams, type CrashPoint, type InternalOptions } from "./seams.js";
export { openingSeam } from "../crypto/format.js";
