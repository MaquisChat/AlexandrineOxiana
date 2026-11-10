/**
 * Names of `<Library>/.tmp` work folders in use by this process (`capture-<id>`, `worker-<id>`,
 * `batch-<id>`). Sweeps (repository open, worker client resume) remove other such folders as leftovers.
 */
export const activeTemp = new Set<string>();

/**
 * A work folder left by interrupted work, never resumed from: link captures (`capture-*`), worker
 * jobs (`worker-*`) and Bulk Import's unpacked archives (`batch-*`; a resumed batch unpacks again).
 */
export function isStaleWorkDir(name: string): boolean {
  return (name.startsWith("capture-") || name.startsWith("worker-") || name.startsWith("batch-")) && !activeTemp.has(name);
}
