/**
 * The project's automation (spec 5.2; whole channels, Task 7): the switch "Transcribe captured audio and
 * video automatically" (`project.automation.transcribeNewMedia`), in project.json, written through a
 * governed, audited change like any change to the project (op `project.automation`).
 */
import type { Project } from "@ao/core";
import type { ProjectAutomation } from "@ao/shared";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";

export async function setProjectAutomation(core: RepoCore, projectId: string, a: ProjectAutomation): Promise<Project> {
  core.assertWritable();
  if (typeof a?.transcribeNewMedia !== "boolean") throw new TypeError("transcribeNewMedia must be true or false");
  const transcribeNewMedia = a.transcribeNewMedia;
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const before = structuredClone(data.project);
      data.project.automation = { ...data.project.automation, transcribeNewMedia };
      await writeProjectData(core, tx, data);
      tx.record("project", projectId, before, data.project);
      tx.onCommit(() => {
        tx.state.project = data.project;
      });
      return structuredClone(data.project);
    },
    { op: "project.automation", entity: { type: "project", id: projectId } },
  );
}
