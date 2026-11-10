/**
 * Collections (project.json) and tags: project tags in project.json, workspace
 * tags in `<root>/tags.json` (spec 3.7).
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { Tag, diffToChanges, newId, type Collection } from "@ao/core";
import { writeFileAtomic } from "../fs/atomic.js";
import { appendChanges } from "./changelog-store.js";
import { InvalidInputError, NotFoundError } from "./errors.js";
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
    const path = tagsPath(core);
    const old = await readMaybe(path);
    const body: TagsJson = { formatVersion: 1, tags: [...tags, tag] };
    await writeFileAtomic(path, JSON.stringify(body, null, 2));
    try {
      const at = core.clock().toISOString();
      const changes = diffToChanges(null, tag, { at, author: core.actor, device: core.device, projectId: "workspace", entity: { type: "tag", id: tag.id } });
      await appendChanges(join(core.root, "changes"), changes, undefined, CHANGE_LOG_MODE);
    } catch (err) {
      if (old) await writeFileAtomic(path, old);
      else await fsp.rm(path, { force: true });
      throw err;
    }
    return tag;
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
