/** `openRepo` and the `Repo` facade: one per open library. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Collection, ConsentRecord, Participant, Project, Session, SourceDraft, SourceFile, Tag } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import type { Library } from "../library.js";
import { addDerivedAsset, type DerivedAssetInput } from "./assets.js";
import { checkAnchor, type IntegrityWarning } from "./audit-store.js";
import { createCollection, createTag, deleteCollection, moveCollection, setMembership, workspaceTags } from "./collections.js";
import {
  createConsent,
  createParticipant,
  createSession,
  getFieldwork,
  linkSourceToFieldwork,
  type ConsentInput,
  type ParticipantInput,
  type SessionInput,
} from "./fieldwork.js";
import { runMutation, type MutateOptions, type MutateRequest, type Tx } from "./mutate.js";
import { createProject, isUnlocked, lockProject, unlockProject, type CreateProjectInput } from "./projects.js";
import {
  createSource,
  deleteSource,
  getSource,
  listSourceIds,
  updateSource,
  type CreateSourceOptions,
  type SourceInputFile,
  type SourcePatch,
} from "./sources.js";
import { RepoCore, loadProjects, type RepoOptions } from "./state.js";

export class Repo {
  constructor(private readonly core: RepoCore) {}

  /** Audit logs that changed outside the app, found when the repo was opened (R12). */
  get integrityWarnings(): readonly IntegrityWarning[] {
    return this.core.integrityWarnings;
  }
  /** Index sink failures after committed mutations (the index is rebuildable). */
  get indexErrors(): ReadonlyArray<{ op: string; error: unknown }> {
    return this.core.indexErrors;
  }

  listProjects(): Project[] {
    return [...this.core.projects.values()].map((s) => structuredClone(s.project));
  }
  getProject(projectId: string): Project {
    return structuredClone(this.core.state(projectId).project);
  }
  createProject(input: CreateProjectInput): Promise<{ project: Project; recoveryCode?: string }> {
    return createProject(this.core, input);
  }
  unlockProject(projectId: string, passphraseOrRecovery: string): Promise<void> {
    return unlockProject(this.core, projectId, passphraseOrRecovery);
  }
  lockProject(projectId: string): void {
    lockProject(this.core, projectId);
  }
  isUnlocked(projectId: string): boolean {
    return isUnlocked(this.core, projectId);
  }

  /** The governed write path; see mutate.ts for the ordering guarantees. */
  mutate<T>(projectId: string, req: MutateRequest | MutateRequest[], fn: (tx: Tx) => Promise<T>, opts?: MutateOptions): Promise<T> {
    return runMutation(this.core, projectId, req, fn, opts);
  }

  createSource(projectId: string, draft: SourceDraft, files: SourceInputFile[], opts: CreateSourceOptions): Promise<SourceFile> {
    return createSource(this.core, projectId, draft, files, opts);
  }
  getSource(projectId: string, id: string): Promise<SourceFile> {
    return getSource(this.core, projectId, id);
  }
  listSourceIds(projectId: string): string[] {
    return listSourceIds(this.core, projectId);
  }
  updateSource(projectId: string, id: string, patch: SourcePatch): Promise<SourceFile> {
    return updateSource(this.core, projectId, id, patch);
  }
  deleteSource(projectId: string, id: string): Promise<void> {
    return deleteSource(this.core, projectId, id);
  }
  addDerivedAsset(projectId: string, sourceId: string, input: DerivedAssetInput): Promise<Asset> {
    return addDerivedAsset(this.core, projectId, sourceId, input);
  }

  createCollection(projectId: string, name: string, parentId?: string): Promise<Collection> {
    return createCollection(this.core, projectId, name, parentId);
  }
  moveCollection(projectId: string, id: string, parentId: string | null): Promise<Collection> {
    return moveCollection(this.core, projectId, id, parentId);
  }
  deleteCollection(projectId: string, id: string): Promise<void> {
    return deleteCollection(this.core, projectId, id);
  }
  /** `scope` is "workspace" or a project id. */
  createTag(scope: string, name: string, color?: string): Promise<Tag> {
    return createTag(this.core, scope, name, color);
  }
  listWorkspaceTags(): Promise<Tag[]> {
    return workspaceTags(this.core);
  }
  setMembership(projectId: string, sourceId: string, m: { collectionIds?: string[]; tagIds?: string[] }): Promise<void> {
    return setMembership(this.core, projectId, sourceId, m);
  }

  createParticipant(projectId: string, input: ParticipantInput): Promise<Participant> {
    return createParticipant(this.core, projectId, input);
  }
  createSession(projectId: string, input: SessionInput): Promise<Session> {
    return createSession(this.core, projectId, input);
  }
  createConsent(projectId: string, input: ConsentInput): Promise<ConsentRecord> {
    return createConsent(this.core, projectId, input);
  }
  linkSourceToFieldwork(projectId: string, sourceId: string, link: { participantIds?: string[]; sessionId?: string }): Promise<SourceFile> {
    return linkSourceToFieldwork(this.core, projectId, sourceId, link);
  }
  getFieldwork(projectId: string): ReturnType<typeof getFieldwork> {
    return getFieldwork(this.core, projectId);
  }
}

/** Removes leftovers of interrupted work: project staging folders and trashed source folders. */
async function sweep(core: RepoCore): Promise<void> {
  const clear = async (dir: string, prefix: string) => {
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) if (n.startsWith(prefix)) await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
  };
  await clear(join(core.root, "Projects"), ".creating-");
  await clear(join(core.root, ".tmp"), "trash-");
}

/**
 * Opens the repository for a library. Verifies every project's audit chain and
 * compares its head with the external anchor (R12): a broken chain, a different
 * event at the anchored position, or a shorter log is reported in
 * `integrityWarnings` and, when writable, recorded as an `audit.anchor-mismatch`
 * event. Projects without an anchor get one.
 */
export async function openRepo(library: Library, keyRing: KeyRing, opts: RepoOptions = {}): Promise<Repo> {
  const core = new RepoCore(library, keyRing, opts);
  const writable = library.mode === "read-write";
  if (writable) await sweep(core);
  const loaded = await loadProjects(core);
  const anchors = await core.anchors.readAll();
  for (const { st, events, verify } of loaded) {
    core.projects.set(st.project.id, st);
    const anchor = anchors[core.anchorKey(st.project.id)];
    const problem = checkAnchor(events, verify, anchor);
    const at = core.clock().toISOString();
    if (problem) {
      core.integrityWarnings.push({ projectId: st.project.id, ...problem });
      if (writable) {
        await core.auditNow(st, {
          ...core.auditBase(st, at),
          action: "audit.anchor-mismatch",
          entity: { type: "project", id: st.project.id },
          details: { kind: problem.kind, detail: problem.detail, ...(anchor ? { recorded: { seq: anchor.seq, hash: anchor.hash } } : {}) },
        });
      }
    } else if (writable && st.audit.head && (anchor?.seq !== st.audit.head.seq || anchor.hash !== st.audit.head.hash)) {
      await core.updateAnchor(st, at);
    }
  }
  return new Repo(core);
}

export type { RepoOptions };
