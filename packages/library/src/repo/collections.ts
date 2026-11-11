/**
 * Collections (project.json) and tags: project tags in project.json, workspace
 * tags in `<root>/tags.json` (spec 3.7).
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { Tag, diffToChanges, newId, type Collection } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { appendChanges } from "./changelog-store.js";
import { InvalidInputError, NotFoundError, RecoveryPendingError } from "./errors.js";
import { readMaybe } from "./io.js";
import { CHANGE_LOG_MODE, runMutation, type MutateRequest } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import { editSource, readSourceFile, storeRequest } from "./sources.js";
import type { RepoCore } from "./state.js";

/** Organizing metadata carries no identifiable data of its own. */
const ORGANIZE: MutateRequest = { action: "store", store: { identifiable: false, hasLocation: false } };

export async function createCollection(core: RepoCore, projectId: string, name: string, parentId?: string): Promise<Collection> {
  core.assertWritable();
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("collection name is required");
  return runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      if (parentId !== undefined && !data.collections.some((c) => c.id === parentId)) throw new NotFoundError("Collection", parentId);
      const c: Collection = { id: newId(), projectId, name, ...(parentId ? { parentId } : {}) };
      tx.entity("collection", c.id);
      data.collections.push(c);
      await writeProjectData(core, tx, data);
      tx.record("collection", c.id, null, c);
      return c;
    },
    { op: "collection.create" },
  );
}

/** Moves a collection under `parentId` (or to the top level with null); refuses cycles. */
export async function moveCollection(core: RepoCore, projectId: string, id: string, parentId: string | null): Promise<Collection> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const byId = new Map(data.collections.map((c) => [c.id, c]));
      const c = byId.get(id);
      if (!c) throw new NotFoundError("Collection", id);
      if (parentId !== null) {
        if (!byId.has(parentId)) throw new NotFoundError("Collection", parentId);
        for (let p: string | undefined = parentId; p; p = byId.get(p)?.parentId) {
          if (p === id) throw new Error("Moving a collection under itself would create a cycle");
        }
      }
      const before = structuredClone(c);
      if (parentId === null) delete c.parentId;
      else c.parentId = parentId;
      await writeProjectData(core, tx, data);
      tx.record("collection", id, before, c);
      return c;
    },
    { op: "collection.move", entity: { type: "collection", id } },
  );
}

/** Renames and/or moves a collection in one governed change (R102); refuses cycles. `parentId` null: top level. */
export async function updateCollection(core: RepoCore, projectId: string, id: string, change: { name?: string; parentId?: string | null }): Promise<Collection> {
  core.assertWritable();
  if (change.name !== undefined && (typeof change.name !== "string" || change.name.trim() === "" || change.name.length > 500)) {
    throw new InvalidInputError("a collection name of 1 to 500 characters is required");
  }
  return runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const byId = new Map(data.collections.map((c) => [c.id, c]));
      const c = byId.get(id);
      if (!c) throw new NotFoundError("Collection", id);
      const parentId = change.parentId;
      if (parentId !== undefined && parentId !== null) {
        if (!byId.has(parentId)) throw new NotFoundError("Collection", parentId);
        for (let p: string | undefined = parentId; p; p = byId.get(p)?.parentId) {
          if (p === id) throw new InvalidInputError("Moving a collection under itself would create a cycle");
        }
      }
      const before = structuredClone(c);
      if (change.name !== undefined) c.name = change.name;
      if (parentId === null) delete c.parentId;
      else if (parentId !== undefined) c.parentId = parentId;
      await writeProjectData(core, tx, data);
      tx.record("collection", id, before, c);
      return c;
    },
    { op: "collection.update", entity: { type: "collection", id } },
  );
}

/** Renames a collection. */
export async function renameCollection(core: RepoCore, projectId: string, id: string, name: string): Promise<Collection> {
  core.assertWritable();
  if (typeof name !== "string" || name.trim() === "" || name.length > 500) throw new InvalidInputError("a collection name of 1 to 500 characters is required");
  return runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const c = data.collections.find((x) => x.id === id);
      if (!c) throw new NotFoundError("Collection", id);
      const before = structuredClone(c);
      c.name = name;
      await writeProjectData(core, tx, data);
      tx.record("collection", id, before, c);
      return c;
    },
    { op: "collection.rename", entity: { type: "collection", id } },
  );
}

/** Renames (and optionally recolours) one of the project's tags. */
export async function renameTag(core: RepoCore, projectId: string, id: string, name: string, color?: string): Promise<Tag> {
  core.assertWritable();
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) throw new InvalidInputError("a tag name of 1 to 200 characters is required");
  return runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const t = data.tags.find((x) => x.id === id);
      if (!t) throw new NotFoundError("Tag", id);
      if (data.tags.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new InvalidInputError(`A tag named "${name}" already exists`);
      const before = structuredClone(t);
      const next = Tag.parse({ ...t, name, ...(color !== undefined ? { color } : {}) });
      Object.assign(t, next);
      await writeProjectData(core, tx, data);
      tx.record("tag", id, before, t);
      return t;
    },
    { op: "tag.rename", entity: { type: "tag", id } },
  );
}

/** Deletes one of the project's tags; its sources keep existing and lose only the tag, in the same change. */
export async function deleteTag(core: RepoCore, projectId: string, id: string): Promise<void> {
  core.assertWritable();
  await runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const t = data.tags.find((x) => x.id === id);
      if (!t) throw new NotFoundError("Tag", id);
      data.tags = data.tags.filter((x) => x.id !== id);
      await writeProjectData(core, tx, data);
      tx.record("tag", id, t, null);
      for (const sid of tx.state.sources.keys()) {
        const sf = await readSourceFile(core, tx.state, sid);
        if (sf.source.tagIds.includes(id)) await editSource(core, tx, sid, (s) => ({ ...s, tagIds: s.tagIds.filter((x) => x !== id) }));
      }
    },
    { op: "tag.delete", entity: { type: "tag", id } },
  );
}

/**
 * Deletes a collection. Its sources keep existing (only their membership is
 * removed); its child collections move up to its parent.
 */
export async function deleteCollection(core: RepoCore, projectId: string, id: string): Promise<void> {
  core.assertWritable();
  await runMutation(
    core,
    projectId,
    ORGANIZE,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const c = data.collections.find((x) => x.id === id);
      if (!c) throw new NotFoundError("Collection", id);
      data.collections = data.collections.filter((x) => x.id !== id);
      for (const child of data.collections.filter((x) => x.parentId === id)) {
        const before = structuredClone(child);
        if (c.parentId) child.parentId = c.parentId;
        else delete child.parentId;
        tx.record("collection", child.id, before, child);
      }
      await writeProjectData(core, tx, data);
      tx.record("collection", id, c, null);
      for (const sid of tx.state.sources.keys()) {
        const sf = await readSourceFile(core, tx.state, sid);
        if (sf.source.collectionIds.includes(id)) {
          await editSource(core, tx, sid, (s) => ({ ...s, collectionIds: s.collectionIds.filter((x) => x !== id) }));
        }
      }
    },
    { op: "collection.delete", entity: { type: "collection", id } },
  );
}

interface TagsJson {
  formatVersion: 1;
  tags: Tag[];
}

const tagsPath = (core: RepoCore) => join(core.root, "tags.json");

export async function workspaceTags(core: RepoCore): Promise<Tag[]> {
  const raw = await readMaybe(tagsPath(core));
  if (!raw) return [];
  return Tag.array().parse((JSON.parse(raw.toString("utf8")) as TagsJson).tags ?? []);
}

/**
 * Creates a tag. `scope` is "workspace" or a project id. Workspace tags have no
 * project, so no project governance or audit chain applies; they are written
 * atomically and change-logged in `<root>/changes/` with projectId "workspace".
 */
export async function createTag(core: RepoCore, scope: string, name: string, color?: string): Promise<Tag> {
  core.assertWritable();
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("tag name is required");
  const tag = Tag.parse({ id: newId(), scope, name, ...(color ? { color } : {}) });
  const clash = (tags: Tag[]) => {
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error(`A tag named "${name}" already exists`);
  };
  if (scope !== "workspace") {
    return runMutation(
      core,
      scope,
      ORGANIZE,
      async (tx) => {
        const data = await readFullData(core, tx.state);
        clash(data.tags);
        data.tags.push(tag);
        tx.entity("tag", tag.id);
        await writeProjectData(core, tx, data);
        tx.record("tag", tag.id, null, tag);
        return tag;
      },
      { op: "tag.create" },
    );
  }
  return core.serial(async () => {
    core.assertWritable();
    const tags = await workspaceTags(core);
    clash(tags);
    await writeWorkspaceTags(core, [...tags, tag], null, tag, tag.id);
    return tag;
  });
}

/**
 * A workspace tag can be on sources of every project, so renaming or deleting one is a change to
 * every project: refused before anything is written unless each project can take a governed change
 * now (no unresolved interrupted change, encrypted projects unlocked).
 */
function workspaceChangeTargets(core: RepoCore): string[] {
  const ids: string[] = [];
  for (const st of core.projects.values()) {
    if (st.recoveryPending) throw new RecoveryPendingError(st.project.id);
    core.assertUnlocked(st);
    ids.push(st.project.id);
  }
  return ids.sort();
}

async function workspaceTag(core: RepoCore, id: string): Promise<{ tags: Tag[]; tag: Tag }> {
  const tags = await workspaceTags(core);
  const tag = tags.find((t) => t.id === id);
  if (!tag) throw new NotFoundError("Tag", id);
  return { tags, tag };
}

/** Writes tags.json and change-logs the change (projectId "workspace"); tags.json is put back if the log fails. */
async function writeWorkspaceTags(core: RepoCore, tags: Tag[], before: Tag | null, after: Tag | null, id: string): Promise<void> {
  const path = tagsPath(core);
  const old = await readMaybe(path);
  const body: TagsJson = { formatVersion: 1, tags };
  await writeFileAtomic(path, JSON.stringify(body, null, 2));
  try {
    const at = core.clock().toISOString();
    const changes = diffToChanges(before, after, { at, author: core.actor, device: core.device, projectId: "workspace", entity: { type: "tag", id } });
    await appendChanges(join(core.root, "changes"), changes, undefined, CHANGE_LOG_MODE);
  } catch (err) {
    if (old) await writeFileAtomic(path, old);
    else await fsp.rm(path, { force: true });
    throw err;
  }
}

/**
 * Renames (and optionally recolours) a workspace tag (R118). Governed and audited in every project
 * (one governed change each, op "workspace-tag.rename", entity the tag; the names stay out of the
 * audit log); then tags.json is rewritten atomically and change-logged. A copy of the tag listed in
 * a project's own project.json is renamed in that project's change. Each project's change is
 * crash-safe on its own (R26); a crash between them leaves tags.json as it was, and renaming again
 * finishes the job.
 */
export async function renameWorkspaceTag(core: RepoCore, id: string, name: string, color?: string): Promise<Tag> {
  core.assertWritable();
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) throw new InvalidInputError("a tag name of 1 to 200 characters is required");
  const clash = (tags: Tag[]) => {
    if (tags.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new InvalidInputError(`A tag named "${name}" already exists`);
  };
  const first = await workspaceTag(core, id);
  clash(first.tags);
  const next = Tag.parse({ ...first.tag, name, ...(color !== undefined ? { color } : {}) });
  for (const projectId of workspaceChangeTargets(core)) {
    await runMutation(
      core,
      projectId,
      ORGANIZE,
      async (tx) => {
        const data = await readFullData(core, tx.state);
        const copy = data.tags.find((t) => t.id === id);
        if (!copy) return;
        const before = structuredClone(copy);
        Object.assign(copy, Tag.parse({ ...copy, name, ...(color !== undefined ? { color } : {}) }));
        await writeProjectData(core, tx, data);
        tx.record("tag", id, before, copy);
      },
      { op: "workspace-tag.rename", entity: { type: "tag", id } },
    );
  }
  return core.serial(async () => {
    core.assertWritable();
    const { tags, tag } = await workspaceTag(core, id);
    clash(tags);
    const renamed = Tag.parse({ ...tag, name: next.name, ...(next.color !== undefined ? { color: next.color } : {}) });
    await writeWorkspaceTags(core, tags.map((t) => (t.id === id ? renamed : t)), tag, renamed, id);
    return renamed;
  });
}

/**
 * Deletes a workspace tag (R118). Every project, in turn, loses it from its sources (and from its
 * project.json, if listed there) in one governed, audited change (op "workspace-tag.delete"; a
 * project without it still records the deletion); only then is it removed from tags.json and
 * change-logged. Each project's change is crash-safe on its own (R26); an interruption leaves the
 * tag in tags.json, and deleting again finishes the job.
 */
export async function deleteWorkspaceTag(core: RepoCore, id: string): Promise<void> {
  core.assertWritable();
  await workspaceTag(core, id);
  for (const projectId of workspaceChangeTargets(core)) {
    await runMutation(
      core,
      projectId,
      ORGANIZE,
      async (tx) => {
        const data = await readFullData(core, tx.state);
        const copy = data.tags.find((t) => t.id === id);
        if (copy) {
          data.tags = data.tags.filter((t) => t.id !== id);
          await writeProjectData(core, tx, data);
          tx.record("tag", id, copy, null);
        }
        for (const sid of tx.state.sources.keys()) {
          const sf = await readSourceFile(core, tx.state, sid);
          if (sf.source.tagIds.includes(id)) await editSource(core, tx, sid, (src) => ({ ...src, tagIds: src.tagIds.filter((x) => x !== id) }));
        }
      },
      { op: "workspace-tag.delete", entity: { type: "tag", id } },
    );
  }
  await core.serial(async () => {
    core.assertWritable();
    const { tags, tag } = await workspaceTag(core, id);
    await writeWorkspaceTags(core, tags.filter((t) => t.id !== id), tag, null, id);
  });
}

/** Replaces a source's collections and/or tags. Tags may be project or workspace tags. */
export async function setMembership(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  m: { collectionIds?: string[]; tagIds?: string[] },
): Promise<void> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const current = await readSourceFile(core, st, sourceId);
  await runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      for (const c of m.collectionIds ?? []) if (!data.collections.some((x) => x.id === c)) throw new NotFoundError("Collection", c);
      const ws = await workspaceTags(core);
      for (const t of m.tagIds ?? []) if (!data.tags.some((x) => x.id === t) && !ws.some((x) => x.id === t)) throw new NotFoundError("Tag", t);
      await editSource(core, tx, sourceId, (s) => ({
        ...s,
        ...(m.collectionIds ? { collectionIds: [...new Set(m.collectionIds)] } : {}),
        ...(m.tagIds ? { tagIds: [...new Set(m.tagIds)] } : {}),
      }));
    },
    { op: "source.membership", entity: { type: "source", id: sourceId } },
  );
}
