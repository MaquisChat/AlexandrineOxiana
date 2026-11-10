/**
 * Names of `<Library>/.tmp` work folders in use by this process (`capture-<id>`, `worker-<id>`).
 * Sweeps (repository open, worker client resume) remove other such folders as leftovers.
 */
export const activeTemp = new Set<string>();
