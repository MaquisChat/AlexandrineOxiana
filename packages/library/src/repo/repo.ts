/** `openRepo` and the `Repo` facade: one per open library. */
import * as fsp from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_GOVERNANCE, effectivePolicy, evaluate, parseGovernance, recheckSourceFile, verifyChain, type AuditEvent } from "@ao/core";
import type { Asset, Collection, ConsentRecord, GovernanceConfig, Participant, PendingOcr, PendingProxy, Project, Provenance, Session, SourceDraft, SourceFile, Tag, VerifyContext, WatchedFolder } from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import type { Library } from "../library.js";
import { acknowledge, type AcknowledgementKind } from "./acknowledge.js";
import { addWatchedFolderRecord, recordZoteroWebVersion, removeWatchedFolderRecord } from "./import-settings.js";
import { addDerivedAsset, addOriginalAsset, currentLocationMode, updatePendingOcr, updatePendingOcrMany, updatePendingProxies, type DerivedAssetInput, type OriginalAssetInput } from "./assets.js";
import { AnchorsUnreadableError, AuditStore, checkAnchor, type AnchorProblemKind, type IntegrityWarning } from "./audit-store.js";
import {
  createCollection,
  createTag,
  deleteCollection,
  deleteTag,
  deleteWorkspaceTag,
  moveCollection,
  renameCollection,
  renameTag,
  renameWorkspaceTag,
  setMembership,
  updateCollection,
  workspaceTags,
} from "./collections.js";
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
import { scanIncompleteLines, type IncompleteLine } from "./incomplete-lines.js";
import { foldName, readMaybe } from "./io.js";
import { authorizeOnly, runMutation, type InternalMutateOptions, type MutateOptions, type MutateRequest, type RefuseHook, type Tx } from "./mutate.js";
import { createProject, isUnlocked, lockProject, readFullData, unlockProject, type CreateProjectInput } from "./projects.js";
import {
  createSource,
  createSources,
  deleteSource,
  getSource,
  listSourceIds,
  relinkLinkedAsset as relinkLinkedAssetIn,
  updateSource,
  type CreateInTx,
  type CreateSourceOptions,
  type NewSourceInput,
  type SourceInputFile,
  type SourcePatch,
} from "./sources.js";
import type { InternalOptions } from "./seams.js";
import { runImportChange, type ImportOps } from "./import-ops.js";
import { readReviewEntries, type ReviewEntry } from "./review.js";
import { DELETED_RECORDS_WARNING, deletedRecordsWarning, readTombstones, tombstoneHash } from "./tombstones.js";
import { RepoCore, loadProjects, type RepoOptions } from "./state.js";
import { loadPseudonyms } from "./pseudonyms.js";
import { stampFor, type Stamp } from "../index/changes.js";
import { isStaleWorkDir } from "../tmp-registry.js";
import { RecoveryPendingError } from "./errors.js";
import { pendingWrites, resolvePendingWrite, type PendingWrite, type PendingWriteChoice } from "./pending-writes.js";
import { isOrphanBackup, pendingMarkers, recoverTransactions, type RecoveryOutcome } from "./txn.js";
import { adoptRestoredProject as adoptRestoredIn, type StagedRestore } from "./restore.js";
import { destroyAssets, type DestroyInput } from "./destroy.js";
import { setBackupSettings as setBackupSettingsIn, type BackupSettings } from "./backup-settings.js";
import { readGovernance, setGovernance as setGovernanceIn, type GovernanceEditResult } from "./governance-edit.js";

/** Package-internal: run after a project is unlocked (best effort; failures never undo the unlock). */
const unlockHooks: Array<(repo: Repo, projectId: string) => Promise<void>> = [];
export function onProjectUnlocked(fn: (repo: Repo, projectId: string) => Promise<void>): void {
  unlockHooks.push(fn);
}

/** Repo → its core, for package-internal helpers below (not part of the public Repo API). */
const cores = new WeakMap<Repo, RepoCore>();

export class Repo {
  constructor(private readonly core: RepoCore) {
    cores.set(this, core);
  }

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
  async unlockProject(projectId: string, passphraseOrRecovery: string): Promise<void> {
    await unlockProject(this.core, projectId, passphraseOrRecovery);
    // Work that waited for the key (e.g. sealed backups the backups manifest could not read, R94).
    for (const h of unlockHooks) await h(this, projectId).catch(() => {});
  }
  lockProject(projectId: string): void {
    lockProject(this.core, projectId);
  }
  isUnlocked(projectId: string): boolean {
    return isUnlocked(this.core, projectId);
  }

  /** The governed write path; see mutate.ts for the ordering guarantees. */
  mutate<T>(projectId: string, req: MutateRequest | MutateRequest[], fn: (tx: Tx) => Promise<T>, opts?: MutateOptions): Promise<T> {
    // Only the public options pass: package-internal ones (a refuse hook) are dropped.
    const pub: MutateOptions = { ...(opts?.op !== undefined ? { op: opts.op } : {}), ...(opts?.entity ? { entity: opts.entity } : {}) };
    return runMutation(this.core, projectId, req, fn, pub);
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
  /**
   * The "Recheck" action: recomputes the source's field verification from its stored evidence and,
   * when it changed, saves it as a governed, audited and change-logged update of the source.
   * Returns the source file as stored afterwards. A source whose verification is unchanged is not written.
   */
  async recheckSource(projectId: string, id: string, ctx: VerifyContext = {}): Promise<SourceFile> {
    const cur = await this.getSource(projectId, id);
    if (isDeepStrictEqual(recheckSourceFile(cur, ctx).verification, cur.verification)) return cur;
    return updateSource(this.core, projectId, id, {}, { verification: (next) => recheckSourceFile(next, ctx).verification });
  }
  deleteSource(projectId: string, id: string): Promise<void> {
    return deleteSource(this.core, projectId, id);
  }
  addDerivedAsset(projectId: string, sourceId: string, input: DerivedAssetInput): Promise<Asset> {
    return addDerivedAsset(this.core, projectId, sourceId, input);
  }
  /** Adds a further original (e.g. a refreshed, dated platform-metadata snapshot); originals are never replaced. */
  addOriginalAsset(projectId: string, sourceId: string, input: OriginalAssetInput): Promise<Asset> {
    return addOriginalAsset(this.core, projectId, sourceId, input);
  }
  /**
   * Checks a project's audit log (`ao verify-audit`): the hash chain verifies, and its head matches
   * the anchor recorded outside the library (R12). Reads only; nothing is written.
   */
  verifyAudit(projectId: string): Promise<AuditCheck> {
    const core = this.core;
    return core.serial(async () => {
      const st = core.state(projectId);
      const events = await AuditStore.read(st.audit.dir);
      const verify = verifyChain(events as AuditEvent[]);
      let anchors: Awaited<ReturnType<RepoCore["anchors"]["readAll"]>> | undefined;
      try {
        anchors = await core.anchors.readAll();
      } catch (err) {
        if (!(err instanceof AnchorsUnreadableError)) throw err;
      }
      const anchor = anchors?.[core.anchorKey(projectId)];
      const problem = checkAnchor(events, verify, anchor, core.device);
      // Alterations found (and recorded) when the library was opened earlier.
      const alteredAt = events
        .filter((e): e is AuditEvent => !!e && (e.action === "audit.anchor-mismatch" || e.action === "audit.anchor-missing"))
        .map((e) => e.at)
        .filter((at): at is string => typeof at === "string");
      return {
        ok: !problem && anchors !== undefined && alteredAt.length === 0,
        events: events.length,
        anchored: !!anchor,
        alteredAt,
        ...(problem ? { problem } : anchors === undefined ? { problem: { kind: "anchors-unreadable" as const, detail: "the record of audit heads kept outside the library could not be read" } } : {}),
      };
    });
  }

  /**
   * A page of the project's audit events, newest first: at most `limit` events with a sequence
   * number below `beforeSeq` (default: from the newest). Reads only.
   */
  async readAudit(projectId: string, opts: { limit?: number; beforeSeq?: number } = {}): Promise<{ events: AuditEvent[]; total: number }> {
    const st = this.core.state(projectId);
    const all = (await AuditStore.read(st.audit.dir)).filter((e): e is AuditEvent => !!e);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const before = opts.beforeSeq;
    const older = before === undefined ? all : all.filter((e) => e.seq < before);
    return { events: older.slice(-limit).reverse(), total: all.length };
  }

  /** Records (and audits) that the researcher acknowledged a one-time capture explanation (spec 5.1). */
  acknowledge(projectId: string, kind: AcknowledgementKind): Promise<Project> {
    return acknowledge(this.core, projectId, kind);
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
  /** Renames and/or moves a collection in one change. */
  updateCollection(projectId: string, id: string, change: { name?: string; parentId?: string | null }): Promise<Collection> {
    return updateCollection(this.core, projectId, id, change);
  }
  renameCollection(projectId: string, id: string, name: string): Promise<Collection> {
    return renameCollection(this.core, projectId, id, name);
  }
  /** A project tag's new name (and colour). Workspace tags are not renamed here. */
  renameTag(projectId: string, id: string, name: string, color?: string): Promise<Tag> {
    return renameTag(this.core, projectId, id, name, color);
  }
  /** Deletes a project tag; its sources lose it in the same change. */
  deleteTag(projectId: string, id: string): Promise<void> {
    return deleteTag(this.core, projectId, id);
  }
  /** `scope` is "workspace" or a project id. */
  createTag(scope: string, name: string, color?: string): Promise<Tag> {
    return createTag(this.core, scope, name, color);
  }
  /**
   * Interrupted changes recovery could not settle (R27), with the choices each allows. Reads only;
   * works on a read-only library too.
   */
  pendingWrites(): Promise<PendingWrite[]> {
    return pendingWrites(this.core);
  }
  /**
   * Resolves one by the researcher's choice (R27): "keep" only when it committed, "roll-back" only
   * when it did not and its record is valid; audited as `txn.resolve`. Writable libraries only.
   */
  resolvePendingWrite(txn: string, choice: PendingWriteChoice): Promise<{ txn: string; choice: PendingWriteChoice; projectId: string }> {
    return resolvePendingWrite(this.core, txn, choice);
  }
  listWorkspaceTags(): Promise<Tag[]> {
    return workspaceTags(this.core);
  }
  /**
   * Renames (and recolours) a workspace tag: governed and audited in every project, then tags.json.
   * Refused before anything is written while any project is locked or has an unresolved interrupted change.
   */
  renameWorkspaceTag(id: string, name: string, color?: string): Promise<Tag> {
    return renameWorkspaceTag(this.core, id, name, color);
  }
  /** Deletes a workspace tag: every project's sources lose it (governed, audited per project), then tags.json. */
  deleteWorkspaceTag(id: string): Promise<void> {
    return deleteWorkspaceTag(this.core, id);
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

  /** The project's collections and project tags (needs the key for an encrypted project). */
  listCollectionsAndTags(projectId: string): Promise<{ collections: Collection[]; tags: Tag[] }> {
    return projectCollectionsAndTags(this, projectId);
  }

  /** The project's governance.yaml as written ("" when the project has none: the defaults apply). */
  async getGovernanceText(projectId: string): Promise<string> {
    return (await readGovernance(this.core, projectId)).yaml;
  }
  /** The governance.yaml text and its SHA-256 (the `baseSha256` of an edit). */
  getGovernance(projectId: string): Promise<{ yaml: string; sha256: string }> {
    return readGovernance(this.core, projectId);
  }
  /**
   * Replaces the project's governance.yaml (governed and audited). A change that loosens a control
   * or goes below a profile's minimum needs `reason`, recorded on the audit event
   * (GovernanceLooseningError otherwise); invalid text throws GovernanceParseError; a file changed
   * since `baseSha256` throws GovernanceConflictError.
   */
  setGovernance(projectId: string, yamlText: string, opts: { baseSha256: string; reason?: string }): Promise<GovernanceEditResult> {
    return setGovernanceIn(this.core, projectId, yamlText, opts);
  }
}

/**
 * Removes leftovers of interrupted work: project staging folders, trashed
 * folders and orphan backup copies. Runs after recoverTransactions; while any
 * marker remains (invalid, skipped or incomplete) trash is kept, since that
 * marker may still need it, and backups of existing markers are never removed.
 */
async function sweep(core: RepoCore): Promise<void> {
  const markersLeft = (await pendingMarkers(core.root)) > 0;
  const clear = async (dir: string, match: (n: string) => boolean | Promise<boolean>) => {
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) if (await match(n)) await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
  };
  await clear(join(core.root, "Projects"), (n) => n.startsWith(".creating-"));
  // Work folders of captures and worker jobs interrupted by a crash (decrypted inputs, raw tool
  // output with request headers): never resumed, so removed unless in use in this process.
  // Bulk Import's unpacked archives (batch-*) too: a resumed batch unpacks its archives again.
  const staleWork = isStaleWorkDir;
  await clear(join(core.root, ".tmp"), (n) => staleWork(n) || (n.startsWith("trash-") && !markersLeft) || isOrphanBackup(core.root, n));
}

const RECOVERY_WARNINGS: Partial<Record<RecoveryOutcome, { kind: IntegrityWarning["kind"]; text: string }>> = {
  "committed-destroy-pending": {
    kind: "destroy-incomplete",
    text: "files destroyed under the project's retention rule could not be overwritten yet (the disk refused the write); they are kept out of the project and overwriting is tried again each time the library is opened",
  },
  "rolled-back": { kind: "rolled-back-incomplete-write", text: "a change interrupted before it was audited was rolled back" },
  "rollback-incomplete": {
    kind: "rolled-back-incomplete-write",
    text: "a change interrupted before it was audited could only be partly rolled back; the marker is kept and recovery is retried on the next open",
  },
  invalid: { kind: "invalid-txn-marker", text: "a write-ahead marker is unreadable or points outside its project; it was kept and nothing was changed" },
  "skipped-audit-unverifiable": {
    kind: "txn-recovery-skipped-audit-unverifiable",
    text: "an interrupted change was not rolled back because the audit log cannot be trusted to show it was uncommitted; the marker is kept",
  },
};

/** Reads the anchors; an unreadable file is reported, moved aside (when writable) and replaced. */
async function readAnchors(core: RepoCore, writable: boolean) {
  try {
    return await core.anchors.readAll();
  } catch (err) {
    if (!(err instanceof AnchorsUnreadableError)) throw err;
    let detail = writable
      ? `${err.message}; audit heads could not be compared and are re-recorded from the current logs`
      : `${err.message}; audit heads could not be compared (nothing was changed)`;
    if (writable) {
      try {
        const aside = await core.anchors.moveAside(core.clock().toISOString());
        detail += ` (old file kept as ${basename(aside)})`;
      } catch {
        detail += " (the old file could not be moved aside and is left in place)";
      }
    }
    core.integrityWarnings.push({ projectId: "*", kind: "anchors-unreadable", detail });
    return {};
  }
}

/**
 * Opens the repository for a library. When writable (read-write, and not opened with `noHeal`,
 * which only checks and reports), first finishes or rolls
 * back writes interrupted by a crash (write-ahead markers, see txn.ts), each
 * rollback reported as `rolled-back-incomplete-write`. Then removes incomplete
 * last lines left in audit segments and change logs by a crash outside a
 * transaction (R28: `trimmed-incomplete-audit-line`, audited as
 * `audit.trimmed-incomplete-line`); a read-only library, or a project with an
 * unresolved marker, only reports them (`incomplete-audit-line-pending`). Then verifies every
 * project's audit chain and compares its head with the external anchor (R12):
 * a broken chain, a different event at the anchored position, or a shorter log
 * is reported in `integrityWarnings` and, when writable, recorded as an
 * `audit.anchor-mismatch` event. A missing anchor for a log this device wrote to, or an empty log,
 * is reported too (R82; audited as `audit.anchor-missing` before re-anchoring). Projects without
 * an anchor whose log this device never wrote get one.
 */
export function openRepo(library: Library, keyRing: KeyRing, opts: RepoOptions = {}): Promise<Repo> {
  const { index, tz, clock, actor, device, noHeal } = opts;
  return openRepoInternal(library, keyRing, { index, tz, clock, actor, device, ...(noHeal ? { noHeal } : {}) });
}

/** openRepo plus internal (test-only) options; reached from tests through testing.ts. */
export async function openRepoInternal(
  library: Library,
  keyRing: KeyRing,
  opts: RepoOptions & InternalOptions,
): Promise<Repo> {
  const core = new RepoCore(library, keyRing, opts);
  const writable = library.mode === "read-write" && !opts.noHeal;
  const anchors = await readAnchors(core, writable);
  // Projects with a marker that is still unresolved: no writes, no audit appends and no trimming
  // until it is resolved. An invalid marker may name one project and point into another's folder,
  // so both its projectId and its projectFolder count.
  const pendingIds = new Set<string>();
  const pendingFolders = new Set<string>();
  /** A marker is unresolved and cannot be tied to a project: no file of any project is trimmed. */
  let unattributed = false;
  if (writable) {
    const recovered = await recoverTransactions(core.root, (pid) => anchors[core.anchorKey(pid)]);
    for (const r of recovered) {
      // A committed change whose destroyed files still wait to be overwritten does not block writes.
      if (r.outcome !== "committed" && r.outcome !== "rolled-back" && r.outcome !== "committed-destroy-pending") {
        const folder = r.projectFolder === undefined ? null : folderKey(r.projectFolder);
        if (r.projectId !== "*") pendingIds.add(r.projectId);
        if (folder !== null) pendingFolders.add(folder);
        if (r.projectId === "*" || folder === null) unattributed = true;
      }
      const w = RECOVERY_WARNINGS[r.outcome];
      if (w) {
        core.integrityWarnings.push({
          projectId: r.projectId,
          kind: w.kind,
          detail: `${w.text} (transaction ${r.txn}${r.detail ? `: ${r.detail}` : ""})`,
        });
      }
    }
    await sweep(core);
  } else {
    const markers = await pendingMarkers(core.root);
    if (markers > 0) {
      core.integrityWarnings.push({
        projectId: "*",
        kind: "incomplete-write-pending",
        detail: `${markers} interrupted change(s) will be finished or rolled back when the library is opened read-write`,
      });
    }
  }
  const isPending = (p: { id: string; rel: string }) => pendingIds.has(p.id) || pendingFolders.has(folderKey(p.rel) ?? "");

  // Incomplete last lines (R28). Recovery ran first, so what a transaction appended is already
  // truncated; what is left was cut off outside a transaction and is not a committed record.
  // The workspace change log has no transactions and no audit chain: it is trimmed and reported.
  reportIncompleteLines(core, "*", await scanIncompleteLines(core.root, "", writable), writable);
  const incomplete = new Map<string, IncompleteLine[]>();
  const loaded = await loadProjects(core, async (p) => {
    const lines = await scanIncompleteLines(core.root, p.rel, writable && !unattributed && !isPending(p));
    incomplete.set(p.id, lines);
  });

  for (const { st, events, verify } of loaded) {
    core.projects.set(st.project.id, st);
    const lines = incomplete.get(st.project.id) ?? [];
    reportIncompleteLines(core, st.project.id, lines, writable);
    // An unresolved marker blocks writes. Its integrity findings are kept in memory only: appending
    // an event or moving the anchor could change what recovery decides on a later open. A line that
    // is still incomplete blocks them too: nothing can be appended after it.
    const blocked = isPending({ id: st.project.id, rel: st.rel }) || (writable && lines.some((l) => !l.trimmed));
    if (blocked) st.recoveryPending = true;
    const anchor = anchors[core.anchorKey(st.project.id)];
    const problem = checkAnchor(events, verify, anchor, core.device);
    const at = core.clock().toISOString();
    if (problem) core.integrityWarnings.push({ projectId: st.project.id, ...problem });
    if (!writable || blocked) continue;
    // A failed append here must never keep the whole library from opening: it blocks this project only.
    try {
      let appended = false;
      if (problem) {
        await core.auditNow(st, {
          ...core.auditBase(st, at),
          // A missing anchor is recorded as such before the project is anchored again (never silently, R82).
          action: problem.kind === "anchor-missing" ? "audit.anchor-missing" : "audit.anchor-mismatch",
          entity: { type: "project", id: st.project.id },
          details: { kind: problem.kind, detail: problem.detail, ...(anchor ? { recorded: { seq: anchor.seq, hash: anchor.hash } } : {}) },
        });
        appended = true;
      }
      // Only a chain that verifies gets the trim recorded in it; otherwise the warning stands alone.
      if (verify.ok) {
        for (const l of lines) {
          await core.auditNow(st, {
            ...core.auditBase(st, at),
            action: "audit.trimmed-incomplete-line",
            entity: { type: "project", id: st.project.id },
            details: { file: l.file, bytes: l.bytes, sha256: l.sha256 },
          });
          appended = true;
        }
      }
      if (!problem && !appended && st.audit.head && (anchor?.seq !== st.audit.head.seq || anchor.hash !== st.audit.head.hash)) {
        await core.updateAnchor(st, at);
      }
    } catch (err) {
      st.recoveryPending = true;
      core.integrityWarnings.push({
        projectId: st.project.id,
        kind: "audit-append-failed-at-open",
        detail: `an audit event could not be appended while opening (${err instanceof Error ? err.message : String(err)}); this project refuses changes until the library is reopened`,
      });
    }
  }
  return new Repo(core);
}

/**
 * The project folder name a marker's `projectFolder` points at, folded the way file systems
 * compare names, or null when it is not `Projects/<one folder>` after normalizing separators,
 * `.` and `..`. Used to block that project, so it errs towards matching.
 */
function folderKey(projectFolder: string): string | null {
  const parts = posix.normalize(projectFolder.replaceAll("\\", "/")).split("/").filter((s) => s !== "");
  if (parts.length !== 2 || foldName(parts[0]!) !== "projects" || parts[1] === "..") return null;
  return foldName(parts[1]!);
}

/** Records one warning per incomplete line: trimmed, or left in place (and why). */
function reportIncompleteLines(core: RepoCore, projectId: string, lines: IncompleteLine[], writable: boolean): void {
  for (const l of lines) {
    const what = `${l.file} ended in an incomplete line of ${l.bytes} byte(s) (an interrupted write)`;
    core.integrityWarnings.push({
      projectId,
      kind: l.trimmed ? "trimmed-incomplete-audit-line" : "incomplete-audit-line-pending",
      file: l.file,
      bytes: l.bytes,
      detail: l.trimmed
        ? `${what}; it was never a complete record and was removed`
        : !writable
          ? core.noHeal
            ? `${what}; it was left in place (checked only, nothing changed)`
            : `${what}; it will be removed when the library is opened read-write`
          : l.error
            ? `${what}; it could not be removed (${l.error}) and is left in place`
            : `${what}; it is left in place until the interrupted change reported for this library is resolved`,
    });
  }
}

/**
 * Package-internal (library move): appends a library-level audit event such as
 * `library.move` to one project, with the same guards as any write (read-only
 * library, unresolved recovery) and the external anchor updated. Not exported
 * from the package: callers outside it cannot write arbitrary audit events.
 */
export async function appendLibraryEvent(
  repo: Repo,
  projectId: string,
  action: string,
  details: Record<string, unknown> & { moveId?: string },
): Promise<void> {
  const core = cores.get(repo)!;
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    if (st.recoveryPending) throw new RecoveryPendingError(projectId);
    // Idempotent per move: a move completed after a crash does not record the same step twice.
    if (details.moveId !== undefined) {
      const events = await AuditStore.read(st.audit.dir);
      if (events.some((e) => e?.action === action && e.details?.moveId === details.moveId)) return;
    }
    const at = core.clock().toISOString();
    await core.auditNow(st, {
      ...core.auditBase(st, at),
      action,
      entity: { type: "project", id: projectId },
      decision: { result: "allow" },
      details,
    });
  });
}

/** Package-internal (reconnect): points a linked asset at its new library-relative path, governed and audited. */
export function relinkLinkedAsset(repo: Repo, projectId: string, sourceId: string, assetId: string, libraryRelativePath: string): Promise<SourceFile> {
  return relinkLinkedAssetIn(cores.get(repo)!, projectId, sourceId, assetId, libraryRelativePath);
}

/**
 * Package-internal (worker client): evaluates a request for work that writes nothing by itself,
 * such as local processing; a deny is audited and thrown as PolicyDeniedError. With `auditAllow`, an
 * allow is audited too (link capture: the one audited capture decision).
 */
export function authorizeProcessing(repo: Repo, projectId: string, req: MutateRequest, opts: Parameters<typeof authorizeOnly>[3] = {}): ReturnType<typeof authorizeOnly> {
  return authorizeOnly(cores.get(repo)!, projectId, req, opts);
}

/**
 * Package-internal (worker client): the project's data key when its files are encrypted at rest,
 * else null. Throws ProjectLockedError for a locked encrypted project.
 */
export function projectDataKey(repo: Repo, projectId: string): { key: Uint8Array; keyId: string } | null {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  return core.encrypted(st) ? core.key(st) : null;
}

/**
 * Package-internal (link capture): the project's effective governance policy (profile minimums
 * applied), or null when governance.yaml cannot be read or parsed (every request is then denied).
 */
export async function projectPolicy(repo: Repo, projectId: string): Promise<GovernanceConfig | null> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  try {
    const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
    return raw ? effectivePolicy(parseGovernance(raw.toString("utf8"))).policy : null;
  } catch {
    return null;
  }
}

/**
 * Package-internal (link capture): `createSource` for a capture whose `capture` decision the caller
 * has already evaluated and audited (authorizeProcessing with `auditAllow`); only `store` is
 * evaluated and audited here, so the capture has exactly one audited capture decision.
 */
export function createSourcePreAuthorized(
  repo: Repo,
  projectId: string,
  draft: SourceDraft,
  files: SourceInputFile[],
  opts: CreateSourceOptions,
): Promise<SourceFile> {
  return createSource(cores.get(repo)!, projectId, draft, files, opts, { captureAuthorized: true });
}

/**
 * Package-internal (drag-and-drop attach): adds a newly captured file as an original of an existing
 * source in one governed change that evaluates and audits both its capture method and `store`.
 */
export function addCapturedOriginal(
  repo: Repo,
  projectId: string,
  sourceId: string,
  input: OriginalAssetInput,
  captureMethod: Provenance["captureMethod"],
  opts: { hasLocation?: boolean; refuse?: RefuseHook; pendingProxies?: (asset: Asset) => PendingProxy[]; platform?: string } = {},
): Promise<Asset> {
  return addOriginalAsset(cores.get(repo)!, projectId, sourceId, input, {
    captureMethod,
    ...(opts.platform ? { capturePlatform: opts.platform } : {}),
    hasLocation: opts.hasLocation === true,
    ...(opts.refuse ? { refuse: opts.refuse } : {}),
    ...(opts.pendingProxies ? { pendingProxies: opts.pendingProxies } : {}),
  });
}

/** Package-internal (R83): records a viewing proxy as a derived asset and removes its pending entry, in one governed change. */
export function addProxyAsset(
  repo: Repo,
  projectId: string,
  sourceId: string,
  input: DerivedAssetInput,
  pendingId: string,
  /** The location rule the proxy was checked against (R85 C1). */
  location: "keep" | "coarsen" | "strip",
): Promise<Asset> {
  return addDerivedAsset(cores.get(repo)!, projectId, sourceId, input, { completesPendingProxy: pendingId, location });
}

/** Package-internal (R85 C1): the project's location rule as its governance says now (unreadable → strip). */
export function currentProjectLocationMode(repo: Repo, projectId: string): Promise<"keep" | "coarsen" | "strip"> {
  const core = cores.get(repo)!;
  return currentLocationMode(core, core.state(projectId).rel);
}

/** Package-internal (R83): edits a source's pending viewing proxies in one governed change. */
export function editPendingProxies(
  repo: Repo,
  projectId: string,
  sourceId: string,
  edit: (list: PendingProxy[], sf: SourceFile) => PendingProxy[],
): Promise<SourceFile> {
  return updatePendingProxies(cores.get(repo)!, projectId, sourceId, edit);
}

/** Package-internal (OCR queue): edits a source's pending OCR jobs in one governed change. */
export function editPendingOcr(
  repo: Repo,
  projectId: string,
  sourceId: string,
  edit: (list: PendingOcr[], sf: SourceFile) => PendingOcr[],
): Promise<SourceFile> {
  return updatePendingOcr(cores.get(repo)!, projectId, sourceId, edit);
}

/** Package-internal (OCR queue, R106): edits the pending OCR jobs of several sources in one governed change. */
export function editPendingOcrMany(repo: Repo, projectId: string, sourceIds: string[], edit: (list: PendingOcr[], sf: SourceFile) => PendingOcr[]): Promise<void> {
  return updatePendingOcrMany(cores.get(repo)!, projectId, sourceIds, edit);
}

/** Package-internal (OCR queue): records the OCR text as a derived asset and removes its pending entry, in one governed change. */
export function addOcrAsset(repo: Repo, projectId: string, sourceId: string, input: DerivedAssetInput, pendingId: string): Promise<Asset> {
  return addDerivedAsset(cores.get(repo)!, projectId, sourceId, input, { completesPendingOcr: pendingId });
}

/** Package-internal: `Repo.mutate` with a refuse hook (see RefuseHook). */
export function mutateRefusing<T>(
  repo: Repo,
  projectId: string,
  req: MutateRequest | MutateRequest[],
  fn: (tx: Tx) => Promise<T>,
  opts: MutateOptions,
  refuse: RefuseHook,
): Promise<T> {
  const internal: InternalMutateOptions = { ...opts, refuse };
  return runMutation(cores.get(repo)!, projectId, req, fn, internal);
}

/**
 * Package-internal (drag-and-drop attach): `createSource` (capture and store evaluated and audited
 * in the change) where `refuse` turns an allowed decision the caller cannot honour into an audited
 * deny before anything is written.
 */
export function createSourceRefusing(
  repo: Repo,
  projectId: string,
  draft: SourceDraft,
  files: SourceInputFile[],
  opts: CreateSourceOptions,
  refuse: RefuseHook,
  /** More writes in the same change (Bulk Import: the batch journal line). */
  inTx?: CreateInTx,
): Promise<SourceFile> {
  return createSource(cores.get(repo)!, projectId, draft, files, opts, { refuse, ...(inTx ? { inTx } : {}) });
}

/**
 * Package-internal (Bulk Import): several new sources in one governed change, each source's capture
 * and store evaluated and audited about it (see sources.ts `createSources`).
 */
export function createSourcesRefusing(repo: Repo, projectId: string, items: NewSourceInput[], refuse: RefuseHook): Promise<SourceFile[]> {
  return createSources(cores.get(repo)!, projectId, items, refuse);
}

/**
 * Package-internal (Bulk Import): one governed change (R26 txn, change log, audit) whose body
 * reads, writes and deletes sources, copies originals in and updates review entries.
 */
export function importChange<T>(
  repo: Repo,
  projectId: string,
  reqs: MutateRequest | MutateRequest[],
  fn: (ops: ImportOps) => Promise<T>,
  opts: { op: string; entity?: { type: "source" | "project" | "asset"; id: string }; refuse?: RefuseHook },
): Promise<T> {
  return runImportChange(cores.get(repo)!, projectId, reqs, fn, opts);
}

/** Package-internal (Bulk Import): the project's collections and tags (project.json). */
export async function projectCollectionsAndTags(repo: Repo, projectId: string): Promise<{ collections: Collection[]; tags: Tag[] }> {
  const core = cores.get(repo)!;
  const data = await readFullData(core, core.state(projectId));
  return { collections: data.collections, tags: data.tags };
}

/** Package-internal (Bulk Import): the project's review entries (newest version per id; needs the unlocked key). */
export function projectReviewEntries(repo: Repo, projectId: string): Promise<ReviewEntry[]> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  core.assertUnlocked(st);
  return readReviewEntries(core, st);
}

/**
 * Package-internal (Bulk Import link preflight): the effective policy, the default policy when the
 * project has no governance.yaml, or null when the file cannot be read or parsed (fail closed).
 */
export async function projectPolicyOrDefault(repo: Repo, projectId: string): Promise<GovernanceConfig | null> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  try {
    const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
    return effectivePolicy(raw ? parseGovernance(raw.toString("utf8")) : DEFAULT_GOVERNANCE).policy;
  } catch {
    return null;
  }
}

/** Package-internal: whether the project has this source now (in memory, O(1)). */
/**
 * Package-internal (R73): whether a Zotero item's source was deleted in this app (its deletion
 * record), by item key; null when the record exists but cannot be read (fail closed, R74 I2).
 */
export async function deletedHere(repo: Repo, projectId: string): Promise<((zoteroKey: string) => boolean) | null> {
  const core = cores.get(repo)!;
  const r = await readTombstones(core, core.state(projectId));
  if (r.status === "unreadable") return null;
  if (r.status === "missing" || !r.t.zotero.length) return () => false;
  const { secret } = r.t;
  const set = new Set(r.t.zotero);
  return (k) => set.has(tombstoneHash(secret, k));
}

/** Package-internal (R74 I2): whether the record of sources deleted here is unreadable, or its warning stands. */
export async function deletedRecordsTrouble(repo: Repo, projectId: string): Promise<boolean> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  return (await readTombstones(core, st)).status === "unreadable" || (await deletedRecordsWarning(core, st));
}

/** Persisted in `Backups/backups-state.json` (`failures`) when a backup of the project failed (R92); cleared by the next success. */
export const BACKUP_FAILED_WARNING = "backup-failed";

/**
 * The project's standing warnings (persisted ones: 'deleted-records-unreadable', R74 I2;
 * 'backup-failed', R92).
 */
export async function projectWarnings(repo: Repo, projectId: string): Promise<string[]> {
  const core = cores.get(repo)!;
  const out = (await deletedRecordsWarning(core, core.state(projectId))) ? [DELETED_RECORDS_WARNING] : [];
  try {
    const raw = await readMaybe(join(core.root, "Backups", "backups-state.json"));
    const m = raw ? (JSON.parse(raw.toString("utf8")) as { failures?: Record<string, unknown> }) : undefined;
    if (m?.failures && Object.hasOwn(m.failures, projectId)) out.push(BACKUP_FAILED_WARNING);
  } catch {
    // an unreadable manifest is handled (and rebuilt) by the backups module
  }
  return out;
}

/**
 * Package-internal (citations, exports, R92): whether the project's rules pseudonymize the names of
 * identifiable data — the engine's own decision for storing identifiable data carries the
 * `pseudonymize-names` condition (not audited: nothing is stored). Unreadable rules: true (fail closed).
 */
export async function pseudonymizesIdentifiable(repo: Repo, projectId: string): Promise<boolean> {
  const core = cores.get(repo)!;
  const policy = await projectPolicy(repo, projectId);
  if (!policy) return true;
  const d = evaluate(policy, {
    action: "store",
    projectId,
    actor: core.actor,
    now: core.clock().toISOString(),
    tz: core.tz,
    store: { identifiable: true, hasLocation: false, legalBasis: "(evaluated for naming only)" },
  });
  if (d.result === "deny") return true;
  return d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "pseudonymize-names");
}

export function hasSource(repo: Repo, projectId: string, id: string): boolean {
  return cores.get(repo)!.state(projectId).sources.has(id);
}

/** Package-internal: whether the project's files are encrypted at rest. */
export function projectEncrypted(repo: Repo, projectId: string): boolean {
  const core = cores.get(repo)!;
  return core.encrypted(core.state(projectId));
}

/** Package-internal (link capture): the project's change stamp as the index would record it now. */
export async function projectStampNow(repo: Repo, projectId: string): Promise<Stamp> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  return stampFor(core.root, st.rel, st.data, core.keyRing);
}

/**
 * Package-internal (profile capture): `updateSource` that also recomputes the source file's field
 * evidence and verification inside the same governed change (a machine edit, then its recheck).
 */
export function updateSourceRechecked(
  repo: Repo,
  projectId: string,
  id: string,
  patch: SourcePatch,
  extra: Parameters<typeof updateSource>[4],
): Promise<SourceFile> {
  return updateSource(cores.get(repo)!, projectId, id, patch, extra);
}

/**
 * Package-internal (profile capture): the participant code the project's pseudonym map gives one
 * of `names` (compared case-insensitively), if any. Needs the unlocked project key.
 */
export async function pseudonymCodeFor(repo: Repo, projectId: string, names: string[]): Promise<string | undefined> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  if (!core.encrypted(st)) return undefined;
  const map = await loadPseudonyms(core, st);
  const wanted = new Set(names.filter(Boolean).map((n) => n.normalize("NFC").toLowerCase()));
  for (const [k, code] of map) if (wanted.has(k.normalize("NFC").toLowerCase())) return code;
  return undefined;
}

/**
 * Package-internal (metadata lookups, R50): the project's effective policy (null when unreadable),
 * the acting user, time zone and clock, and whether the project is encrypted (lookups for it are
 * then `sensitive`: cached in memory only).
 */
export async function lookupPolicyInfo(
  repo: Repo,
  projectId: string,
): Promise<{ policy: GovernanceConfig | null; actor: string; tz?: string; clock: () => Date; sensitive: boolean }> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  const policy = await projectPolicy(repo, projectId);
  return { policy, actor: core.actor, ...(core.tz ? { tz: core.tz } : {}), clock: core.clock, sensitive: core.encrypted(st) };
}

/** Package-internal (Zotero Web import): records the library version a finished import saw (governed, audited). */
export function recordZoteroWebLibraryVersion(repo: Repo, projectId: string, ref: string, version: number): Promise<void> {
  return recordZoteroWebVersion(cores.get(repo)!, projectId, ref, version);
}

/** Package-internal (watched folders): adds a watch's id + options to project.json (governed, audited). */
export function addWatchedFolderEntry(repo: Repo, projectId: string, options: unknown): Promise<WatchedFolder> {
  return addWatchedFolderRecord(cores.get(repo)!, projectId, options);
}

/** Package-internal (watched folders): removes a watch's record from project.json (governed, audited). */
export function removeWatchedFolderEntry(repo: Repo, projectId: string, id: string): Promise<void> {
  return removeWatchedFolderRecord(cores.get(repo)!, projectId, id);
}

/** Package-internal: the researcher's time zone the repo names dated files in. */
export function repoTz(repo: Repo): string | undefined {
  return cores.get(repo)!.tz;
}

/** Package-internal: the repo's clock (tests set it). */
export function repoClock(repo: Repo): () => Date {
  return cores.get(repo)!.clock;
}

/** Package-internal: the library a repo was opened on. */
export function repoLibrary(repo: Repo): Library {
  return cores.get(repo)!.library;
}

/** Package-internal: ids of projects that refuse writes until the library is reopened. */
export function recoveryPendingProjects(repo: Repo): string[] {
  return [...cores.get(repo)!.projects.values()].filter((s) => s.recoveryPending).map((s) => s.project.id);
}

/** Package-internal (backups, R90 b): what a backup sees of its project while it holds the write queue. */
export interface ProjectQueueContext {
  /** Library root (absolute). */
  root: string;
  /** Library-relative project folder. */
  rel: string;
  project: Project;
  encrypted: boolean;
  /** The data key (encrypted projects; throws ProjectLockedError when locked), else null. */
  key(): { key: Uint8Array; keyId: string } | null;
  /** The audit head now. */
  head(): { seq: number; hash: string } | null;
  /** ISO time from the repo's clock. */
  at(): string;
  /** Appends one audit event about the project (decision allow), anchored. */
  audit(action: string, details: Record<string, unknown>): Promise<void>;
}

/**
 * Package-internal (backups): runs `fn` in the repository's write queue, so no change to any project
 * happens meanwhile (a backup then reads one consistent state). Same guards as a write.
 */
export function withProjectQueue<T>(repo: Repo, projectId: string, fn: (ctx: ProjectQueueContext) => Promise<T>): Promise<T> {
  const core = cores.get(repo)!;
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    if (st.recoveryPending) throw new RecoveryPendingError(projectId);
    core.assertUnlocked(st);
    return fn({
      root: core.root,
      rel: st.rel,
      project: structuredClone(st.project),
      encrypted: core.encrypted(st),
      key: () => (core.encrypted(st) ? core.key(st) : null),
      head: () => (st.audit.head ? { ...st.audit.head } : null),
      at: () => core.clock().toISOString(),
      audit: async (action, details) => {
        const at = core.clock().toISOString();
        await core.auditNow(st, { ...core.auditBase(st, at), action, entity: { type: "project", id: projectId }, decision: { result: "allow" }, details });
      },
    });
  });
}

/** Package-internal (restore): a key in the repo's key ring, if unlocked. */
export function keyFromRing(repo: Repo, keyId: string): Uint8Array | undefined {
  return cores.get(repo)!.keyRing.get(keyId);
}

/** Package-internal (restore with a passphrase): puts a project key in the repo's key ring. */
export function addKeyToRing(repo: Repo, keyId: string, key: Uint8Array): void {
  cores.get(repo)!.keyRing.add(keyId, key);
}

/** Package-internal (restore, R90 b): makes an unpacked backup a new project of the library. */
export function adoptRestoredProject(repo: Repo, s: StagedRestore): ReturnType<typeof adoptRestoredIn> {
  return adoptRestoredIn(cores.get(repo)!, s);
}

/** Package-internal (retention, R90 d): the governed destruction change. */
export function destroyProjectAssets(repo: Repo, projectId: string, input: DestroyInput): ReturnType<typeof destroyAssets> {
  return destroyAssets(cores.get(repo)!, projectId, input);
}

/** Sets a project's backup settings (daily automatic backup, how many to keep); governed and audited. */
export function setProjectBackupSettings(repo: Repo, projectId: string, settings: BackupSettings): Promise<Project> {
  return setBackupSettingsIn(cores.get(repo)!, projectId, settings);
}

/** Package-internal (citations, exports): the project's pseudonym map (handle or name → code); empty unless encrypted. */
export async function projectPseudonymMap(repo: Repo, projectId: string): Promise<Map<string, string>> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  if (!core.encrypted(st)) return new Map();
  return loadPseudonyms(core, st);
}

export type { RepoOptions };

/** The result of `Repo.verifyAudit`. */
export interface AuditCheck {
  ok: boolean;
  /** Events in the log. */
  events: number;
  /** Whether a head was recorded outside the library to compare with (false: unverified on this device). */
  anchored: boolean;
  /** When earlier opens of the library found the log altered (its `audit.anchor-mismatch` events). */
  alteredAt: string[];
  problem?: { kind: AnchorProblemKind | "anchors-unreadable"; detail: string };
}
