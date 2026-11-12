/**
 * The project's time zone setting (R93; R92: the retention date is read in it), in project.json
 * (`project.timeZone`): written through a governed, audited change like any change to the project.
 * Only a real IANA zone name is accepted (stored in its usual spelling); null clears the setting,
 * and the project's dates are read in UTC again. project.json is plaintext in encrypted projects
 * too, so the setting can be read while the project is locked (its retention warning needs it).
 */
import { timeZoneName, type Project } from "@ao/core";
import { InvalidInputError } from "./errors.js";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";

export async function setTimeZone(core: RepoCore, projectId: string, tz: string | null): Promise<Project> {
  core.assertWritable();
  const zone = tz === null ? null : typeof tz === "string" ? timeZoneName(tz) : undefined;
  if (zone === undefined) throw new InvalidInputError("That is not a time zone name (for example Europe/Berlin or America/New_York).");
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const before = structuredClone(data.project);
      if (zone === null) delete data.project.timeZone;
      else data.project.timeZone = zone;
      await writeProjectData(core, tx, data);
      tx.record("project", projectId, before, data.project);
      tx.onCommit(() => {
        tx.state.project = data.project;
      });
      return structuredClone(data.project);
    },
    { op: "project.time-zone", entity: { type: "project", id: projectId } },
  );
}
