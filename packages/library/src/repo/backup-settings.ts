/**
 * Backup settings of a project (R90 b), in project.json (`project.backups`): written through a
 * governed, audited change like any change to the project.
 */
import type { Project } from "@ao/core";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";

export interface BackupSettings {
  /** A daily backup while the app is open (default on). */
  automatic?: boolean;
  /** How many backups of the project are kept (default 10). */
  keep?: number;
}

export async function setBackupSettings(core: RepoCore, projectId: string, settings: BackupSettings): Promise<Project> {
  core.assertWritable();
  const next: NonNullable<Project["backups"]> = {};
  if (settings.automatic !== undefined) {
    if (typeof settings.automatic !== "boolean") throw new TypeError("automatic must be true or false");
    next.automatic = settings.automatic;
  }
  if (settings.keep !== undefined) {
    if (!Number.isInteger(settings.keep) || settings.keep < 1 || settings.keep > 1000) throw new TypeError("keep must be a whole number from 1 to 1000");
    next.keep = settings.keep;
  }
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const before = structuredClone(data.project);
      data.project.backups = { ...data.project.backups, ...next };
      await writeProjectData(core, tx, data);
      tx.record("project", projectId, before, data.project);
      tx.onCommit(() => {
        tx.state.project = data.project;
      });
      return structuredClone(data.project);
    },
    { op: "project.backup-settings", entity: { type: "project", id: projectId } },
  );
}
