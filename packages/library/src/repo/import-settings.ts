/**
 * Import settings kept in project.json (Task 26, R78), each written as one governed, audited
 * change like any other change to the project:
 *   - `importSettings.zoteroWeb[<user|group>:<id>]`: the Zotero library version the last finished
 *     Web API import saw (the next import asks for `?since=` that version);
 *   - `watchedFolders`: a watch's id and options. Never its folder: absolute paths are device
 *     settings (import/watch.ts, R69).
 * Nothing secret is ever written here (the Zotero API key lives only in the OS keyring, secrets.ts).
 */
import { WatchedFolderOptions, newId, type Project, type WatchedFolder } from "@ao/core";
import { NotFoundError } from "./errors.js";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";
import type { Tx } from "./mutate.js";

const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

async function changeProject<T>(core: RepoCore, projectId: string, op: string, fn: (p: Project, tx: Tx) => T): Promise<T> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    REQ,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const before = structuredClone(data.project);
      const out = fn(data.project, tx);
      await writeProjectData(core, tx, data);
      tx.record("project", projectId, before, data.project);
      tx.onCommit(() => {
        tx.state.project = data.project;
      });
      return out;
    },
    { op, entity: { type: "project", id: projectId } },
  );
}

/** Records the Zotero library version a finished Web API import saw (`ref` is "user:<id>" or "group:<id>"). */
export function recordZoteroWebVersion(core: RepoCore, projectId: string, ref: string, version: number): Promise<void> {
  if (!/^(user|group):\d{1,12}$/u.test(ref) || !Number.isInteger(version) || version < 0) throw new TypeError("invalid Zotero library reference or version");
  return changeProject(core, projectId, "project.import-settings.zotero-web", (p, tx) => {
    const zoteroWeb = { ...(p.importSettings?.zoteroWeb ?? {}) };
    zoteroWeb[ref] = { lastLibraryVersion: version, at: tx.at };
    p.importSettings = { ...p.importSettings, zoteroWeb };
  });
}

/**
 * Forgets the Zotero library version recorded for `ref` (Task Z5, R206 4: undoing a batch that recorded it), so
 * that the next Web import of that library is a full one. One governed, audited change; nothing is written when
 * no version is recorded.
 */
export async function resetZoteroWebVersion(core: RepoCore, projectId: string, ref: string): Promise<void> {
  if (!/^(user|group):\d{1,12}$/u.test(ref)) throw new TypeError("invalid Zotero library reference");
  const zw = core.state(projectId).project.importSettings?.zoteroWeb;
  if (!zw || !Object.hasOwn(zw, ref)) return;
  await changeProject(core, projectId, "project.import-settings.zotero-web.reset", (p) => {
    const zoteroWeb = { ...(p.importSettings?.zoteroWeb ?? {}) };
    delete zoteroWeb[ref];
    p.importSettings = { ...p.importSettings, zoteroWeb };
  });
}

/** Adds a watched folder's record (id + options; the folder itself is a device setting). */
export function addWatchedFolderRecord(core: RepoCore, projectId: string, options: unknown): Promise<WatchedFolder> {
  const parsed = WatchedFolderOptions.parse(options ?? {});
  return changeProject(core, projectId, "project.watched-folder.add", (p, tx) => {
    const w: WatchedFolder = { id: newId(), options: parsed, createdAt: tx.at };
    p.watchedFolders = [...(p.watchedFolders ?? []), w];
    return structuredClone(w);
  });
}

/** Removes a watched folder's record. */
export function removeWatchedFolderRecord(core: RepoCore, projectId: string, id: string): Promise<void> {
  if (!(core.state(projectId).project.watchedFolders ?? []).some((w) => w.id === id)) return Promise.reject(new NotFoundError("Watched folder", id));
  return changeProject(core, projectId, "project.watched-folder.remove", (p) => {
    p.watchedFolders = (p.watchedFolders ?? []).filter((w) => w.id !== id);
  });
}
