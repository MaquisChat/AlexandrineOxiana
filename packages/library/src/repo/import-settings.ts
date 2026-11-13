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
import { InvalidInputError, NotFoundError } from "./errors.js";
import { runMutation } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import type { RepoCore } from "./state.js";
import type { Tx } from "./mutate.js";

const REQ = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

async function changeProject<T>(core: RepoCore, projectId: string, op: string, fn: (p: Project, tx: Tx) => T, auditDetails?: Record<string, unknown>): Promise<T> {
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
    { op, entity: { type: "project", id: projectId }, ...(auditDetails ? { auditDetails } : {}) },
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

/** The options of a watched folder that can be changed after it was added (null clears). */
export interface WatchedFolderOptionsPatch {
  label?: string | null;
  collectionId?: string | null;
}

/**
 * Changes a watched folder's label and/or collection (Task W7 round 2, R227): one governed, audited change of
 * project.json, op "project.watched-folder.options". The audit holds `{ watch, fields }` only, never the label's
 * text (R177, R69): the audit event carries no diff (runMutation records only the op, these details, the txn and a
 * count of changes); the label's before and after are in the project's change log, which is sealed in an encrypted
 * project (and 0600 in the clear otherwise, like every other value of project.json, R19). A patch that changes
 * nothing writes and audits nothing. Refuses an unknown watch (NotFoundError), a collection that is not the
 * project's and a malformed value (InvalidInputError), before anything is written; a read-only library and a locked
 * project are refused by the write path before anything is written.
 */
export async function updateWatchedFolderOptions(core: RepoCore, projectId: string, id: string, patch: WatchedFolderOptionsPatch): Promise<WatchedFolder> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((k) => k !== "label" && k !== "collectionId")) {
    throw new InvalidInputError("Only the name and the collection of a watched folder can be changed.");
  }
  const { label, collectionId } = patch;
  if (label !== undefined && label !== null && (typeof label !== "string" || label.trim() === "" || label.length > 200)) throw new InvalidInputError("The name of a watched folder must be 1 to 200 characters.");
  if (collectionId !== undefined && collectionId !== null && typeof collectionId !== "string") throw new InvalidInputError("That collection is not in this project.");
  const st = core.state(projectId);
  const current = (st.project.watchedFolders ?? []).find((w) => w.id === id);
  if (!current) throw new NotFoundError("Watched folder", id);
  const fields: Array<"label" | "collectionId"> = [];
  if (label !== undefined && (label ?? undefined) !== current.options.label) fields.push("label");
  if (collectionId !== undefined && (collectionId ?? undefined) !== current.options.collectionId) fields.push("collectionId");
  if (fields.length === 0) return structuredClone(current);
  core.assertWritable();
  if (fields.includes("collectionId") && collectionId !== null && !st.data.collections.some((c) => c.id === collectionId)) throw new InvalidInputError("That collection is not in this project.");
  return changeProject(
    core,
    projectId,
    "project.watched-folder.options",
    (p) => {
      const list = p.watchedFolders ?? [];
      const i = list.findIndex((w) => w.id === id);
      if (i < 0) throw new NotFoundError("Watched folder", id);
      const options = { ...list[i]!.options };
      if (fields.includes("label")) {
        if (label === null) delete options.label;
        else options.label = label!;
      }
      if (fields.includes("collectionId")) {
        if (collectionId === null) delete options.collectionId;
        else options.collectionId = collectionId!;
      }
      const next: WatchedFolder = { ...list[i]!, options: WatchedFolderOptions.parse(options) };
      p.watchedFolders = list.map((w, j) => (j === i ? next : w));
      return structuredClone(next);
    },
    { watch: id, fields },
  );
}
