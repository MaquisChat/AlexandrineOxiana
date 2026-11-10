/**
 * One-time acknowledgements of capture explanations (spec 5.1), recorded in project.json
 * (`project.captureAcknowledgements`) and audited like any change to the project.
 */
import type { Project } from "@ao/core";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";

export type AcknowledgementKind = "cookies";

export async function acknowledge(core: RepoCore, projectId: string, kind: AcknowledgementKind): Promise<Project> {
  core.assertWritable();
  if (kind !== "cookies") throw new TypeError(`unknown acknowledgement "${String(kind)}"`);
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const before = structuredClone(data.project);
      data.project.captureAcknowledgements = { ...data.project.captureAcknowledgements, [kind]: { at: tx.at, by: tx.actor } };
      await writeProjectData(core, tx, data);
      tx.record("project", projectId, before, data.project);
      tx.onCommit(() => {
        tx.state.project = data.project;
      });
      return structuredClone(data.project);
    },
    { op: `project.acknowledge.${kind}`, entity: { type: "project", id: projectId } },
  );
}
