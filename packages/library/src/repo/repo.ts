/** `openRepo` and the `Repo` facade: one per open library. */
import { DESTRUCTION_OLD_COPIES_PENDING_WARNING as DESTRUCTION_OLD_COPIES_PENDING_WARNING_KIND } from "@ao/shared";
import * as fsp from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_GOVERNANCE, effectivePolicy, evaluate, parseGovernance, recheckSourceFile, verifyChain, type AuditEvent, type AuditVerifyResult } from "@ao/core";
import type { Annotation, Asset, Collection, DateRule, ConsentRecord, EntityType, GovernanceConfig, PolicyDecision, Participant, PendingOcr, PendingProxy, Project, Provenance, Session, Source, SourceDraft, SourceFile, Tag, VerifyContext, WatchedFolder } from "@ao/core";
import { KeyNotAvailableError } from "../crypto/format.js";
import type { KeyRing } from "../crypto/keys.js";
import type { Library } from "../library.js";
import { acknowledge, type AcknowledgementKind } from "./acknowledge.js";
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation, type AnnotationDraft, type AnnotationPatch } from "./annotations.js";
import { addWatchedFolderRecord, recordZoteroWebVersion, removeWatchedFolderRecord, resetZoteroWebVersion, updateWatchedFolderOptions, type WatchedFolderOptionsPatch } from "./import-settings.js";
import { addDerivedAsset, addDerivedAssets, addOriginalAsset, currentLocationMode, updatePendingOcr, updatePendingOcrMany, updatePendingProxies, type DerivedAssetInput, type OriginalAssetInput } from "./assets.js";
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
  deleteParticipant,
  deleteSession,
  getFieldwork,
  linkSourceToFieldwork,
  updateConsent,
  updateParticipant,
  updateSession,
  withdrawConsent,
  type ConsentInput,
  type ConsentPatch,
  type ParticipantInput,
  type ParticipantPatch,
  type SessionInput,
  type SessionPatch,
  setConsentDocument,
} from "./fieldwork.js";
import { scanIncompleteLines, type IncompleteLine } from "./incomplete-lines.js";
import { foldName, readMaybe } from "./io.js";
import { AUDIT_REASONS_FILE, LIBRARY_AUDIT_REASONS_FILE, auditedReason, auditedReasonIn, hasSealedReason, openLibraryReason, readLibraryReasonLines, readProjectReasons, reasonKey, reasonMatches, reasonView } from "./audit-reasons.js";
import { incompleteRollbackOf, type AuditReasonView, type IncompleteRollback } from "@ao/shared";
import { authorizeOnly, decide, runMutation, type InternalMutateOptions, type MutateOptions, type MutateRequest, type RefuseHook, type Tx } from "./mutate.js";
import {
  RECOVERY_CODE_UNSHOWN_WARNING,
  completeRecoveryActivation,
  createProject,
  isUnlocked,
  issueRecoveryCode,
  lockAsksOf,
  lockProject,
  readFullData,
  recoveryCodeUnshown,
  unlockProject,
  type CreateProjectInput,
} from "./projects.js";
import {
  createSource,
  createSources,
  deleteSource,
  getSource,
  getSourceRecord,
  getSourceRecordWithAssets,
  listSourceIds,
  relinkLinkedAsset as relinkLinkedAssetIn,
  sourceRecordStamp,
  updateSource,
  type CreateInTx,
  type CreateSourceOptions,
  type NewSourceInput,
  type SourceInputFile,
  type SourcePatch,
} from "./sources.js";
import type { InternalOptions } from "./seams.js";
import { runImportChange, type ImportOps } from "./import-ops.js";
import { hasSettledCaptureEntries, hasUnlistedConflicts, heldFileToLook, heldWaitingCount, holdMismatchedFile, readReviewEntries, removeFindEntryWithHeld, resolveHeldFile, reviewedAfterWithdrawal, type HoldInput, type ReviewEntry } from "./review.js";
import { readWatchOrigins, readWatchRegister, recordWatchedFiles, type WatchRegisterEntry } from "./watch-register.js";
import { appendFindEntries, mendFindQueueTail, readFindQueue, readFindQueueDetailed } from "../find/queue-store.js";
import type { FindEntry } from "../find/types.js";
import { DELETED_RECORDS_WARNING, deletedRecordsWarning, readTombstones, tombstoneHash } from "./tombstones.js";
import { RepoCore, loadProjects, type ProjectState, type RepoOptions } from "./state.js";
import { loadPseudonyms, participantCodeOf } from "./pseudonyms.js";
import { stampFor, type Stamp } from "../index/changes.js";
import { isStaleWorkDir } from "../tmp-registry.js";
import { InvalidInputError, NotFoundError, PolicyDeniedError, ProjectLockedError, RecoveryPendingError } from "./errors.js";
import { completeRecordedResolves, pendingWrites, resolvePendingWrite, type PendingWrite, type PendingWriteChoice } from "./pending-writes.js";
import { inspectMarkers, isOrphanBackup, markerPaths, pendingMarkers, recoverTransactions, type RecoveryOutcome } from "./txn.js";
import {
  adoptRestoredProject as adoptRestoredIn,
  authorizeRestoreIn,
  recordUnreadableBackup,
  refuseRestoreIn,
  type DestructionRecordError,
  type RestoreRequest,
  type StagedRestore,
} from "./restore.js";
import { amendDestruction, destroyAssets, type AmendInput, type DestroyInput } from "./destroy.js";
import { setBackupSettings as setBackupSettingsIn, type BackupSettings } from "./backup-settings.js";
import { setTimeZone as setTimeZoneIn } from "./time-zone.js";
import { readGovernance, readGovernanceFile, setGovernance as setGovernanceIn, type GovernanceEditResult, type GovernanceFileState } from "./governance-edit.js";
import {
  AUDIT_WAITING_WARNING,
  attentionWarnings,
  holdsLock,
  listMarks,
  markForSetAside,
  moveOutboxIntoProject,
  newAttentionId,
  readOutbox,
  reasonOf,
  removeAttention,
  settleAttention,
  settleOrphanOutbox,
  writeAttention,
  writeOutbox,
  type AttentionMark,
  type AttentionRecord,
} from "./attention.js";
import { SimulatedCrash, maybeCrash } from "./seams.js";
import { LIBRARY_AUDIT_DIR, appendLibraryAudit, appendLibraryAuditWithReason, checkLibraryAudit, libraryAnchorKey, readLibraryAudit } from "./library-audit.js";

/** Package-internal: run after a project is unlocked (best effort; failures never undo the unlock). */
const unlockHooks: Array<(repo: Repo, projectId: string) => Promise<void>> = [];
export function onProjectUnlocked(fn: (repo: Repo, projectId: string) => Promise<void>): void {
  unlockHooks.push(fn);
}

/** Package-internal: run for each readable project when a repo opens read-write, and after an unlock (best effort). */
const openHooks: Array<(repo: Repo, projectId: string) => Promise<void>> = [];
export function onProjectOpened(fn: (repo: Repo, projectId: string) => Promise<void>): void {
  openHooks.push(fn);
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

  /** The library's own audit log (refused project creations, Task 50) and whether its chain verifies. */
  /** What the project needs attention for (Task 50): marks, as the audit screen lists them. */
  attentionMarks(projectId: string): Promise<AttentionMark[]> {
    return listMarks(this.core, this.core.state(projectId));
  }

  /**
   * Sets a mark aside with a reason (R154 d): decided by the policy engine (`delete`, op
   * `attention.set-aside`) and audited with the reason, who, when and the mark itself, in the
   * project's log when it is intact, else in the library's log; only then is the mark removed.
   */
  setAsideMark(projectId: string, markId: string, reason: string): Promise<{ recordedIn: "project" | "library" }> {
    return setAsideMarkIn(this.core, projectId, markId, reason);
  }

  /** A page of the library's own audit log, newest first (like `readAudit`). */
  async readLibraryAuditPage(opts: { limit?: number; beforeSeq?: number } = {}): Promise<{ events: ShownAuditEvent[]; total: number }> {
    const { events: all } = await readLibraryAudit(this.core.root);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const older = opts.beforeSeq === undefined ? all : all.filter((e) => e.seq < opts.beforeSeq!);
    return { events: await withLibraryReasons(this.core, older.slice(-limit).reverse()), total: all.length };
  }

  /** Checks the library's own audit log against its anchor, like `verifyAudit` for a project (R154 a). Reads only. */
  verifyLibraryAudit(): Promise<AuditCheck> {
    const core = this.core;
    return core.serial(async () => {
      const raw = await AuditStore.read(join(core.root, LIBRARY_AUDIT_DIR));
      const verify = verifyChain(raw as AuditEvent[]);
      let anchors: Awaited<ReturnType<RepoCore["anchors"]["readAll"]>> | undefined;
      try {
        anchors = await core.anchors.readAll();
      } catch (err) {
        if (!(err instanceof AnchorsUnreadableError)) throw err;
      }
      const anchor = anchors?.[libraryAnchorKey(core)];
      const problem = raw.length === 0 && !anchor ? null : checkAnchor(raw, verify, anchor, core.device);
      const alteredAt = raw
        .filter((e): e is AuditEvent => !!e && (e.action === "audit.anchor-mismatch" || e.action === "audit.anchor-missing"))
        .map((e) => e.at);
      return {
        ok: !problem && anchors !== undefined && alteredAt.length === 0,
        events: raw.length,
        anchored: !!anchor,
        alteredAt,
        ...(problem ? { problem } : anchors === undefined ? { problem: { kind: "anchors-unreadable" as const, detail: "the record of audit heads kept outside the library could not be read" } } : {}),
      };
    });
  }

  libraryAudit(): Promise<{ events: AuditEvent[]; verify: AuditVerifyResult }> {
    return readLibraryAudit(this.core.root);
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
  /** `lockAsksAtRequest` (R443 a): the count `lockAsksOf` gave when the request arrived; every later lock overtakes this unlock. */
  async unlockProject(projectId: string, passphraseOrRecovery: string, lockAsksAtRequest?: number): Promise<void> {
    await unlockProject(this.core, projectId, passphraseOrRecovery, lockAsksAtRequest);
    // Work that waited for the key (e.g. sealed backups the backups manifest could not read, R94).
    for (const h of unlockHooks) await h(this, projectId).catch(() => {});
  }
  /**
   * Issues a new recovery code for an unlocked encrypted project, given its passphrase again
   * (governed and audited; the project key is unchanged and the old code stops working). The code is
   * returned once and never stored.
   */
  issueRecoveryCode(projectId: string, passphrase: string): Promise<{ recoveryCode: string }> {
    return issueRecoveryCode(this.core, projectId, passphrase);
  }
  lockProject(projectId: string): Promise<void> {
    return lockProject(this.core, projectId);
  }
  isUnlocked(projectId: string): boolean {
    return isUnlocked(this.core, projectId);
  }
  /** The project's count of locks asked so far (read-only): noted by an unlock when its request arrives (R443 a). */
  lockAsksOf(projectId: string): number {
    return lockAsksOf(this.core, projectId);
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
  /** The source's own record (source.json alone; no annotations, no integrity check: R186). */
  getSourceRecord(projectId: string, id: string): Promise<Source> {
    return getSourceRecord(this.core, projectId, id);
  }
  /** The light read with the assets `source.json` holds (no annotations, no integrity check: R186, R222). */
  getSourceRecordWithAssets(projectId: string, id: string): Promise<{ source: Source; assets: Asset[] }> {
    return getSourceRecordWithAssets(this.core, projectId, id);
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
   * Returns the source file as stored afterwards. A source whose verification is unchanged is not
   * written, unless one of its capture review entries is settled by it (R176 1), or a field of it in
   * conflict is listed in no pending capture-conflict entry (R193 b: a source D19 left behind): the
   * recheck's own governed change resolves or queues them.
   */
  async recheckSource(projectId: string, id: string, ctx: VerifyContext = {}): Promise<SourceFile> {
    const cur = await this.getSource(projectId, id);
    const next = recheckSourceFile(cur, ctx);
    const st = this.core.state(projectId);
    if (isDeepStrictEqual(next.verification, cur.verification) && !(await hasSettledCaptureEntries(this.core, st, next)) && !(await hasUnlistedConflicts(this.core, st, next))) return cur;
    return updateSource(this.core, projectId, id, {}, { verification: (n) => recheckSourceFile(n, ctx).verification, resolveReview: "recheck" });
  }
  deleteSource(projectId: string, id: string): Promise<void> {
    return deleteSource(this.core, projectId, id);
  }
  /** One source's annotations, as stored (the full read: source.json and its annotations file). */
  listAnnotations(projectId: string, sourceId: string): Promise<Annotation[]> {
    return listAnnotations(this.core, projectId, sourceId);
  }
  /** Adds a highlight or a page note on a PDF of the source: one governed, audited change (Task R3). */
  createAnnotation(projectId: string, sourceId: string, draft: AnnotationDraft): Promise<Annotation> {
    return createAnnotation(this.core, projectId, sourceId, draft);
  }
  /** Recolours an annotation, or sets or removes its note: one governed, audited change. */
  updateAnnotation(projectId: string, sourceId: string, annotationId: string, patch: AnnotationPatch): Promise<Annotation> {
    return updateAnnotation(this.core, projectId, sourceId, annotationId, patch);
  }
  /** Deletes an annotation (an imported one's key is remembered, so a re-import does not bring it back). */
  deleteAnnotation(projectId: string, sourceId: string, annotationId: string): Promise<{ id: string; external: boolean }> {
    return deleteAnnotation(this.core, projectId, sourceId, annotationId);
  }
  addDerivedAsset(projectId: string, sourceId: string, input: DerivedAssetInput): Promise<Asset> {
    return addDerivedAsset(this.core, projectId, sourceId, input);
  }
  /** Several derived assets of one source in one governed change: all of them or none (FR-393, R464 c). */
  addDerivedAssets(projectId: string, sourceId: string, inputs: DerivedAssetInput[]): Promise<Asset[]> {
    return addDerivedAssets(this.core, projectId, sourceId, inputs);
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
  async readAudit(projectId: string, opts: { limit?: number; beforeSeq?: number } = {}): Promise<{ events: ShownAuditEvent[]; total: number }> {
    const st = this.core.state(projectId);
    const all = (await AuditStore.read(st.audit.dir)).filter((e): e is AuditEvent => !!e);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const before = opts.beforeSeq;
    const older = before === undefined ? all : all.filter((e) => e.seq < before);
    return { events: await withProjectReasons(this.core, st, older.slice(-limit).reverse()), total: all.length };
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
  /** A watched folder's register, folded by key (Task W3; sealed in encrypted projects: refused while locked). */
  watchRegister(projectId: string, watchId: string): Promise<Map<string, WatchRegisterEntry>> {
    return readWatchRegister(this.core, projectId, watchId);
  }
  /** Appends entries to a watched folder's register: one governed, audited change (counts only in the audit). */
  recordWatchedFiles(projectId: string, watchId: string, entries: WatchRegisterEntry[]): Promise<void> {
    return recordWatchedFiles(this.core, projectId, watchId, entries);
  }
  /** Which watched folders, and which file in each, a source came from. */
  watchOrigins(projectId: string, sourceId: string): Promise<Array<{ watchId: string; entry: WatchRegisterEntry }>> {
    return readWatchOrigins(this.core, projectId, sourceId);
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
  updateParticipant(projectId: string, id: string, patch: ParticipantPatch): Promise<Participant> {
    return updateParticipant(this.core, projectId, id, patch);
  }
  updateSession(projectId: string, id: string, patch: SessionPatch): Promise<Session> {
    return updateSession(this.core, projectId, id, patch);
  }
  updateConsent(projectId: string, id: string, patch: ConsentPatch): Promise<ConsentRecord> {
    return updateConsent(this.core, projectId, id, patch);
  }
  /** Marks the consent withdrawn and queues every source linked to its participant for review; deletes nothing. */
  withdrawConsent(projectId: string, id: string, opts?: { reason?: string }): Promise<{ consent: ConsentRecord; flaggedSourceIds: string[] }> {
    return withdrawConsent(this.core, projectId, id, opts);
  }
  /**
   * "Reviewed after the withdrawal" (R176 2): resolves a review entry a consent withdrawal queued,
   * with the researcher's reason (required, stored as typed). Changes nothing else about the source.
   */
  reviewedAfterWithdrawal(projectId: string, entryId: string, reason: string): Promise<ReviewEntry> {
    return reviewedAfterWithdrawal(this.core, projectId, entryId, reason);
  }
  /** Only when no consent record, session or source links to it (FieldworkInUseError otherwise). */
  deleteParticipant(projectId: string, id: string): Promise<void> {
    return deleteParticipant(this.core, projectId, id);
  }
  /** Only when no source links to it (FieldworkInUseError otherwise). */
  deleteSession(projectId: string, id: string): Promise<void> {
    return deleteSession(this.core, projectId, id);
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
  /**
   * The governance.yaml text, its SHA-256 (the `baseSha256` of an edit), and whether the file is there
   * at all (R397 a) or something that cannot be opened is in its place (R397 e: the empty text).
   */
  getGovernance(projectId: string): Promise<{ yaml: string; sha256: string; file: GovernanceFileState }> {
    return readGovernanceFile(this.core, projectId);
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
  // FR-736: the detail of an incomplete undo says its state (the command line prints it); see INCOMPLETE_DETAIL.
  invalid: { kind: "invalid-txn-marker", text: "a write-ahead marker is unreadable or points outside its project; it was kept and nothing was changed" },
  "skipped-audit-unverifiable": {
    kind: "txn-recovery-skipped-audit-unverifiable",
    text: "an interrupted change was not rolled back because the audit log cannot be trusted to show it was uncommitted; the marker is kept",
  },
  "resolve-incomplete": {
    kind: "incomplete-write-pending",
    text: "the choice made for an interrupted change could not be completed when the library opened; the marker keeps the choice, and it is completed by resolving it again or on the next open",
  },
};

/**
 * FR-736: the detail of an undo left incomplete at the opening, by its state (the command line prints it; the screens say
 * the shared sentence of the state). Never a retry where retrying cannot help.
 */
const INCOMPLETE_DETAIL: Record<IncompleteRollback, string> = {
  "try-again": RECOVERY_WARNINGS["rollback-incomplete"]!.text,
  "in-the-way":
    "a change interrupted before it was audited could only be partly rolled back, because a file changed or put there outside the app is in the way; the marker is kept, and the roll-back completes once that file is moved away (the app's list of interrupted changes names it)",
  lost: "a change interrupted before it was audited could only be partly rolled back: the copy the app kept of a file it removed is gone, so that file cannot be put back; the marker is kept until the change is closed in the app's list of interrupted changes",
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
  /** The paths each project's unresolved (readable) markers name: half changed until resolved (R473 I1). */
  const unfinished = new Map<string, string[]>();
  const noteUnfinished = (projectId: string, paths: readonly string[]) => unfinished.set(projectId, [...(unfinished.get(projectId) ?? []), ...paths]);
  if (writable) {
    // Choices the researcher recorded but a crash or failed audit append left unfinished are
    // completed and audited first (R131 c); recovery never acts on a recorded choice itself.
    await completeRecordedResolves(core, (pid) => anchors[core.anchorKey(pid)]);
    const recovered = await recoverTransactions(core.root, (pid) => anchors[core.anchorKey(pid)]);
    for (const r of recovered) {
      // A committed change whose destroyed files still wait to be overwritten does not block writes.
      if (r.outcome !== "committed" && r.outcome !== "rolled-back" && r.outcome !== "committed-destroy-pending") {
        const folder = r.projectFolder === undefined ? null : folderKey(r.projectFolder);
        if (r.projectId !== "*") pendingIds.add(r.projectId);
        if (folder !== null) pendingFolders.add(folder);
        if (r.projectId === "*" || folder === null) unattributed = true;
        if (r.paths) noteUnfinished(r.projectId, r.paths);
      }
      const w = RECOVERY_WARNINGS[r.outcome];
      // FR-736: an undo not complete, at this opening or for a choice to roll back recorded earlier (its latest attempt
      // was made just now, by completeRecordedResolves), carries its state; the list of interrupted changes its causes.
      if (r.outcome === "rollback-incomplete") core.rollbackAttempts.set(r.txn, { causes: r.causes ?? [], stepFailed: r.stepFailed === true });
      const attempt = r.outcome === "rollback-incomplete" || r.outcome === "resolve-incomplete" ? core.rollbackAttempts.get(r.txn) : undefined;
      const rollback = attempt ? incompleteRollbackOf(attempt.causes, attempt.stepFailed) : undefined;
      if (w) {
        const text = r.outcome === "rollback-incomplete" && rollback ? INCOMPLETE_DETAIL[rollback] : w.text;
        core.integrityWarnings.push({
          projectId: r.projectId,
          kind: w.kind,
          detail: `${text} (transaction ${r.txn}${r.detail ? `: ${r.detail}` : ""})`,
          // R519: what kept the roll-back from completing, path by path (the list of interrupted changes shows them).
          ...(attempt?.causes.length ? { causes: attempt.causes } : {}),
          ...(rollback ? { rollback } : {}),
        });
      }
    }
    await sweep(core);
  } else {
    const markers = await pendingMarkers(core.root);
    // Not acted on here (no writes): the changes they name stay half done until a writable open (R473 I1).
    for (const i of await inspectMarkers(core.root, (pid) => anchors[core.anchorKey(pid)]).catch(() => [])) {
      if (i.marker && (i.status === "uncommitted" || i.status === "unverifiable")) noteUnfinished(i.projectId, markerPaths(i.marker));
    }
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
  const rootLines = await scanIncompleteLines(core.root, "", writable);
  reportIncompleteLines(core, "*", rootLines, writable);
  // The library's own audit log (Task 50, R154 a): compared with its anchor like a project's log.
  await checkLibraryAudit(
    core,
    anchors[libraryAnchorKey(core)],
    writable,
    rootLines.filter((l) => l.trimmed && l.file.startsWith(`${LIBRARY_AUDIT_DIR}/`)),
  );
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
    if (unfinished.has(st.project.id)) st.unfinished = new Set(unfinished.get(st.project.id));
    const anchor = anchors[core.anchorKey(st.project.id)];
    const problem = checkAnchor(events, verify, anchor, core.device);
    const at = core.clock().toISOString();
    if (problem) core.integrityWarnings.push({ projectId: st.project.id, ...problem });
    if (!verify.ok) st.auditUnverified = true;
    // Marks this device kept for this library (R154 e): a project that cannot be settled now takes them into its folder.
    if (writable && (blocked || !verify.ok)) {
      await moveOutboxIntoProject(core, st).catch((err: unknown) => {
        if (err instanceof SimulatedCrash) throw err;
      });
    }
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
      // A new recovery code committed but not yet put in place when the app stopped (R141 b).
      if (core.encrypted(st)) {
        const headBefore = st.audit.head?.seq;
        await completeRecoveryActivation(core, st, events, verify.ok, at);
        if (st.audit.head?.seq !== headBefore) appended = true;
      }
      // Audit events an action could not write, and permissions a restore could not set (Task 50).
      if (verify.ok) {
        const settled = await settleAttention(core, st, events, at);
        if (settled > 0) {
          appended = true;
          core.integrityWarnings.push({
            projectId: st.project.id,
            kind: "audit-recorded-late",
            detail: `${settled} action(s) whose audit entry or file permissions could not be written at the time were recorded now`,
          });
        }
      }
      if (!problem && !appended && st.audit.head && (anchor?.seq !== st.audit.head.seq || anchor.hash !== st.audit.head.hash)) {
        await core.updateAnchor(st, at);
      }
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err; // test seam: the process died here
      st.recoveryPending = true;
      core.integrityWarnings.push({
        projectId: st.project.id,
        kind: "audit-append-failed-at-open",
        detail: `an audit event could not be appended while opening (${err instanceof Error ? err.message : String(err)}); this project refuses changes until the library is reopened`,
      });
    }
  }
  // This device's outbox entries for projects the library no longer has (N9).
  if (writable) {
    await settleOrphanOutbox(core).catch((err: unknown) => {
      if (err instanceof SimulatedCrash) throw err;
    });
  }
  const repo = new Repo(core);
  // Package-internal reconcilers (e.g. consent forms whose link to the consent was interrupted, R117 I5).
  if (writable) {
    for (const st of core.projects.values()) {
      if (st.recoveryPending || (core.encrypted(st) && !isUnlocked(core, st.project.id))) continue;
      for (const h of openHooks) await h(repo, st.project.id).catch(() => {});
    }
  }
  return repo;
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

/**
 * Package-internal (library move, Task 50): audits a refusal of a library-level action for one
 * project (a deny event: who, what, the rule's reason), with the same guards as any append.
 */
export async function appendRefusalEvent(repo: Repo, projectId: string, action: string, reason: string, details: Record<string, unknown>): Promise<void> {
  const core = cores.get(repo)!;
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    if (st.recoveryPending) throw new RecoveryPendingError(projectId);
    const at = core.clock().toISOString();
    await core.auditNow(st, {
      ...core.auditBase(st, at),
      action,
      entity: { type: "project", id: projectId },
      decision: { result: "deny", reason },
      details,
    });
  });
}

/** Package-internal: the project's library-relative folder, actor and device in this repo. */
export function repoProjectInfo(repo: Repo, projectId: string): { rel: string; actor: string; device: string; at: string } {
  const core = cores.get(repo)!;
  return { rel: core.state(projectId).rel, actor: core.actor, device: core.device, at: core.clock().toISOString() };
}

/**
 * Package-internal (Task 50, R28, R82): appends a library-level event; when that fails, the action is
 * not undone but the project is marked (`<Project>/attention/`, warning `audit-unrecorded`) and the
 * next writable open records the event late. Returns a plain warning when the event was not
 * recorded now (and says whether the mark could be written), else undefined.
 */
export async function recordOrMark(
  repo: Repo,
  projectId: string,
  action: string,
  details: Record<string, unknown>,
  refusal?: { reason: string },
): Promise<string | undefined> {
  try {
    if (refusal) await appendRefusalEvent(repo, projectId, action, refusal.reason, details);
    else await appendLibraryEvent(repo, projectId, action, details);
    return undefined;
  } catch (err) {
    const core = cores.get(repo)!;
    const st = core.projects.get(projectId);
    const what = `The ${action} audit event could not be recorded for project ${projectId} (${err instanceof Error ? err.message : String(err)})`;
    if (!st) return `${what}; the project could not be marked as needing attention`;
    try {
      maybeCrash("before-attention-mark");
      // Never into a library another device holds (N1): checked now, not by the repo handed in.
      if (!(await holdsLock(core.library))) throw new Error("this computer does not hold the library's lock");
      await writeAttention(core.root, st.rel, {
        formatVersion: 1,
        id: newAttentionId(),
        kind: "audit-unrecorded",
        occurredAt: core.clock().toISOString(),
        actor: core.actor,
        device: core.device,
        action,
        ...(refusal ? { decision: { result: "deny" as const, reason: refusal.reason } } : {}),
        details,
        state: "ready",
        reason: reasonOf(err),
      });
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      // The project folder cannot take it: kept on this device instead (R154 e, M1).
      try {
        await writeOutbox(core.library.appConfigDir, core.library.id, projectId, {
          formatVersion: 1,
          id: newAttentionId(),
          kind: "audit-unrecorded",
          occurredAt: core.clock().toISOString(),
          actor: core.actor,
          device: core.device,
          action,
          ...(refusal ? { decision: { result: "deny" as const, reason: refusal.reason } } : {}),
          details,
          state: "ready",
          reason: reasonOf(err),
        });
      } catch (e2) {
        return `${what}; it could not be kept for later either (${e2 instanceof Error ? e2.message : String(e2)})`;
      }
      return `${what}; it is kept on this computer and recorded when the library is next opened here with write access`;
    }
    return `${what}; the project is marked as needing attention and the event is recorded when the library is next opened`;
  }
}

/** Package-internal: the project's standing attention warnings, read through this repo. */
export async function writeProjectAttention(repo: Repo, projectId: string, rec: AttentionRecord): Promise<void> {
  const core = cores.get(repo)!;
  if (!(await holdsLock(core.library))) throw new Error("this computer does not hold the library's lock");
  await writeAttention(core.root, core.state(projectId).rel, rec);
}

/** Package-internal: removes a record written before an action, once its event is recorded. */
export async function removeProjectAttention(repo: Repo, projectId: string, id: string): Promise<void> {
  const core = cores.get(repo)!;
  await removeAttention(core.root, core.state(projectId).rel, id);
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
  opts: { op: string; entity?: { type: "source" | "project" | "asset"; id: string }; refuse?: RefuseHook; auditDetails?: Record<string, unknown> },
): Promise<T> {
  return runImportChange(cores.get(repo)!, projectId, reqs, fn, opts);
}

/**
 * Package-internal (Bulk Import): before a change that may remove a source holding a found file (a duplicate's
 * "merge" or "skip", an undo's removal), the Find queue's torn last line is cut by a change of its own, so the
 * removal's line for the queue entry is always written (R503 a, R505 b).
 */
export function mendFindQueue(repo: Repo, projectId: string): Promise<void> {
  return mendFindQueueTail(cores.get(repo)!, projectId);
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
 * Persisted in `Backups/backups-state.json` (`pending`) when old backups were removed but their
 * `backup.prune` audit event could not be written yet (R125, R82); cleared once it is recorded.
 */
export const BACKUP_AUDIT_PENDING_WARNING = "backup-audit-pending";

/**
 * Noted in `Backups/backups-state.json` (`undestroyed`) while a backup listed at a destruction under
 * the retention rule is not yet verifiably gone (R138 e, N1, R147). The note is rewritten from the
 * audit log at every retry pass, and cleared once every listed backup is recorded as removed or as
 * no longer present.
 */
export const DESTRUCTION_BACKUPS_PENDING_WARNING = "destruction-backups-pending";

/**
 * Noted in `Backups/backups-state.json` (`oldCopiesUndestroyed`) while an old copy of the library
 * left by a move, which this computer lists, still holds files a destruction under the retention
 * rule destroyed, or while that list could not be checked (R379). Rewritten from the audit log at
 * every retry pass, as the backups' note is; its sentences are in @ao/shared (oldCopiesPendingText).
 */
export { DESTRUCTION_OLD_COPIES_PENDING_WARNING } from "@ao/shared";

/**
 * The project's standing warnings (persisted ones: 'deleted-records-unreadable', R74 I2;
 * 'backup-failed', R92; 'backup-audit-pending', R125; 'destruction-backups-pending', R147; 'destruction-old-copies-pending', R379;
 * 'recovery-code-unshown', R141 b; 'audit-unrecorded' and 'permissions-not-set', Task 50).
 */
export async function projectWarnings(repo: Repo, projectId: string): Promise<string[]> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  const out = (await deletedRecordsWarning(core, st)) ? [DELETED_RECORDS_WARNING] : [];
  if (await recoveryCodeUnshown(core, st)) out.push(RECOVERY_CODE_UNSHOWN_WARNING);
  // Actions not undone whose audit event, or permissions, could not be written (Task 50).
  out.push(...(await attentionWarnings(core.root, st.rel, st.recoveryPending === true || st.auditUnverified === true)));
  // Marks waiting on this device for this library's lock (R154 e).
  if ((await readOutbox(core.library.appConfigDir, core.library.id)).some((e) => e.projectId === projectId)) out.push(AUDIT_WAITING_WARNING);
  try {
    const raw = await readMaybe(join(core.root, "Backups", "backups-state.json"));
    const m = raw ? (JSON.parse(raw.toString("utf8")) as { failures?: Record<string, unknown>; pending?: Record<string, unknown>; undestroyed?: Record<string, unknown> }) : undefined;
    if (m?.failures && Object.hasOwn(m.failures, projectId)) out.push(BACKUP_FAILED_WARNING);
    const stuck = m?.undestroyed && typeof m.undestroyed === "object" && Object.hasOwn(m.undestroyed, projectId) ? m.undestroyed[projectId] : undefined;
    // Per destruction certificate (R2-I2): the warning stands while any of them has a backup left.
    const lists = Array.isArray(stuck) ? [stuck] : stuck && typeof stuck === "object" ? Object.values(stuck as Record<string, unknown>) : [];
    if (lists.some((l) => Array.isArray(l) && l.length > 0)) out.push(DESTRUCTION_BACKUPS_PENDING_WARNING);
    // Old copies of the library left by a move (R379), per certificate: a copy listed, or a list not checked.
    const copies = (m as { oldCopiesUndestroyed?: Record<string, unknown> } | undefined)?.oldCopiesUndestroyed;
    const mine = copies && typeof copies === "object" && Object.hasOwn(copies, projectId) ? copies[projectId] : undefined;
    const noted = mine && typeof mine === "object" ? Object.values(mine as Record<string, { copies?: unknown; unchecked?: unknown } | null>) : [];
    if (noted.some((n) => (Array.isArray(n?.copies) && n.copies.length > 0) || n?.unchecked === true)) out.push(DESTRUCTION_OLD_COPIES_PENDING_WARNING_KIND);
    const pending = m?.pending && typeof m.pending === "object" ? Object.values(m.pending) : [];
    if (pending.some((op) => (op as { kind?: unknown; projectId?: unknown; auditFailed?: unknown } | null)?.kind === "prune" && (op as { projectId?: unknown }).projectId === projectId && (op as { auditFailed?: unknown }).auditFailed === true)) {
      out.push(BACKUP_AUDIT_PENDING_WARNING);
    }
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
    tz: core.zoneOf(core.state(projectId).project),
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
  patch: Parameters<typeof updateSource>[3],
  extra: Parameters<typeof updateSource>[4],
): Promise<SourceFile> {
  return updateSource(cores.get(repo)!, projectId, id, patch, extra);
}

/**
 * Package-internal (profile capture): the participant code the project's pseudonym map gives the
 * first of `names` that names one, each looked up by `participantCodeOf` (as written, then the strict
 * key; R427 a), if any. It decides nothing about which spellings to try: the profile capture passes
 * exactly one, the `creatorKey` of the creator its source will carry, so the answer is the record
 * `assignCodes` links that source to (R437 b). Needs the unlocked project key.
 */
export async function pseudonymCodeFor(repo: Repo, projectId: string, names: string[]): Promise<string | undefined> {
  const core = cores.get(repo)!;
  const st = core.state(projectId);
  if (!core.encrypted(st)) return undefined;
  const map = await loadPseudonyms(core, st);
  for (const n of names) {
    const code = n?.trim() ? participantCodeOf(map, n) : undefined;
    if (code) return code;
  }
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
  return { policy, actor: core.actor, tz: core.zoneOf(st.project), clock: core.clock, sensitive: core.encrypted(st) };
}

/** Package-internal (Task F15, R328 e): a stamp of a source's record file (one `stat`, nothing read), or null when it is gone. */
export function sourceRecordStampIn(repo: Repo, projectId: string, id: string): string | null {
  return sourceRecordStamp(cores.get(repo)!, projectId, id);
}

/** Package-internal (Zotero Web import): records the library version a finished import saw (governed, audited). */
export function recordZoteroWebLibraryVersion(repo: Repo, projectId: string, ref: string, version: number): Promise<void> {
  return recordZoteroWebVersion(cores.get(repo)!, projectId, ref, version);
}

/**
 * Task Z5 (R206 4): forgets the Zotero library version recorded for `ref` (op
 * `project.import-settings.zotero-web.reset`), so the next Web import of that library is a full one.
 */
export function clearZoteroWebVersion(repo: Repo, projectId: string, ref: string): Promise<void> {
  return resetZoteroWebVersion(cores.get(repo)!, projectId, ref);
}

/** Package-internal (watched folders): adds a watch's id + options to project.json (governed, audited). */
export function addWatchedFolderEntry(repo: Repo, projectId: string, options: unknown): Promise<WatchedFolder> {
  return addWatchedFolderRecord(cores.get(repo)!, projectId, options);
}

/** Package-internal (watched folders, W7 round 2): changes a watch's label and/or collection in project.json (governed, audited by field names only). */
export function updateWatchedFolderEntry(repo: Repo, projectId: string, id: string, patch: WatchedFolderOptionsPatch): Promise<WatchedFolder> {
  return updateWatchedFolderOptions(cores.get(repo)!, projectId, id, patch);
}

/** Package-internal (watched folders): removes a watch's record from project.json (governed, audited). */
export function removeWatchedFolderEntry(repo: Repo, projectId: string, id: string): Promise<void> {
  return removeWatchedFolderRecord(cores.get(repo)!, projectId, id);
}

/** Package-internal (Find and acquire, R237 e): the project's queue, its live entries (see find/queue-store.ts). */
export function readFindQueueIn(repo: Repo, projectId: string): Promise<Map<string, FindEntry>> {
  return readFindQueue(cores.get(repo)!, projectId);
}

/** Package-internal (Find and acquire): the live entries and how many lines could not be read. */
export function readFindQueueDetailedIn(repo: Repo, projectId: string): Promise<{ entries: Map<string, FindEntry>; unreadableLines: number }> {
  return readFindQueueDetailed(cores.get(repo)!, projectId);
}

/**
 * Package-internal (Find and acquire): one governed change of the queue (`project.find.add|update|remove`); with an
 * add, `alongside` are new lines of live entries written in the same change (F8: the author's entry whose works are added).
 */
export function appendFindEntriesIn(repo: Repo, projectId: string, entries: FindEntry[], op: "add" | "update" | "remove" | "library-start", alongside: FindEntry[] = [], method: "library_access" | "free_copy" = "library_access"): Promise<void> {
  return appendFindEntries(cores.get(repo)!, projectId, entries, op, alongside, method);
}

/** Package-internal (Find and acquire F11): the held file, its review entry and the entry's line, in one change (review.ts). */
export function holdMismatchedFileIn(repo: Repo, projectId: string, input: HoldInput): Promise<{ reviewId: string; held: string }> {
  return holdMismatchedFile(cores.get(repo)!, projectId, input);
}

/** Package-internal (F11, R296 d): how many files wait for the researcher's check in the project (one read; review.ts). */
export function heldWaitingCountIn(repo: Repo, projectId: string): Promise<number> {
  return heldWaitingCount(cores.get(repo)!, projectId);
}

/** Package-internal (R470 b): where a held file is, to be looked at; one read, nothing written (review.ts). */
export function heldFileToLookIn(repo: Repo, projectId: string, reviewId: string): Promise<{ rel: string; kind: "pdf" | "epub"; encrypted: boolean }> {
  return heldFileToLook(cores.get(repo)!, projectId, reviewId);
}

/** Package-internal (F11): "Use this file" / "Not this file" on a held file, one change each (review.ts). */
export function resolveHeldFileIn(repo: Repo, projectId: string, reviewId: string, decision: "attach" | "discard"): Promise<{ entry: FindEntry | null; asset?: Asset }> {
  return resolveHeldFile(cores.get(repo)!, projectId, reviewId, decision);
}

/** Package-internal (F11, R277 c): removes a queue entry, its held file and its review entry in one change (review.ts). */
export function removeFindEntryIn(repo: Repo, projectId: string, entry: FindEntry): Promise<void> {
  return removeFindEntryWithHeld(cores.get(repo)!, projectId, entry);
}

/**
 * Package-internal: the zone a project's date rule is read in (R160 as amended): its time zone
 * when set, else the computer's for protocol dates and UTC for retention (`dateRuleZone`).
 */
export function projectDateZone(repo: Repo, projectId: string, rule: DateRule): string {
  const core = cores.get(repo)!;
  return core.zoneOf(core.state(projectId).project, rule);
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
  /**
   * Evaluates a request in this turn, against the governance in force now (a backup's commit
   * point, R138 c): a deny is audited and thrown as PolicyDeniedError, as in any governed write.
   */
  decide(req: MutateRequest, opts: { op: string; entity?: { type: EntityType; id: string }; unaudited?: boolean }): Promise<PolicyDecision>;
  /** Appends one audit event about the project with the given decision (e.g. a deny with what it refused), anchored. */
  record(action: string, decision: { result: "allow" } | { result: "deny"; reason: string }, details: Record<string, unknown>): Promise<void>;
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
      decide: async (req, o) => {
        const [first] = await decide(core, st, req, core.clock().toISOString(), o.op, o.entity, undefined, o.unaudited === true);
        return first!.d;
      },
      record: async (action, decision, details) => {
        const at = core.clock().toISOString();
        await core.auditNow(st, { ...core.auditBase(st, at), action, entity: { type: "project", id: projectId }, decision, details });
      },
    });
  });
}

/**
 * A way into the repository's write queue for a read that confirms what it found (FR-420, R469 b): `fn` runs in
 * a turn of the queue, after any change in progress, so nothing is half written while it reads. Called from inside
 * a turn, `fn` runs there and then (the queue is not re-entrant: a second turn would wait for the first forever).
 */
export function writeQueueTurn(repo: Repo): <T>(fn: () => Promise<T>) => Promise<T> {
  const core = cores.get(repo)!;
  return <T>(fn: () => Promise<T>) => (core.holdsTurn() ? fn() : core.serial(fn));
}

/** Package-internal (restore): a key in the repo's key ring, if unlocked. */
export function keyFromRing(repo: Repo, keyId: string): Uint8Array | undefined {
  return cores.get(repo)!.keyRing.get(keyId);
}

/** Package-internal (restore, R90 b): makes an unpacked backup a new project of the library. */
export function adoptRestoredProject(repo: Repo, s: StagedRestore): ReturnType<typeof adoptRestoredIn> {
  return adoptRestoredIn(cores.get(repo)!, s);
}

/**
 * Package-internal (restore, Task 50b): the policy decision for a restore, made before anything of
 * the backup is unpacked. A deny is audited and thrown as PolicyDeniedError.
 */
export function authorizeRestore(repo: Repo, r: RestoreRequest): ReturnType<typeof authorizeRestoreIn> {
  return authorizeRestoreIn(cores.get(repo)!, r);
}

/** Package-internal (restore): audits a restore refused because the record of destructions cannot be read. */
export function refuseRestore(repo: Repo, r: RestoreRequest, err: DestructionRecordError): Promise<void> {
  return refuseRestoreIn(cores.get(repo)!, r, err);
}

/** Package-internal (restore, R179): audits, in the library's own log, the refusal of a file that is not a readable backup. */
export function refuseUnreadableBackup(repo: Repo, f: { file: string; sha256?: string; reason: string }): Promise<void> {
  return recordUnreadableBackup(cores.get(repo)!, f);
}

/** Package-internal (restore): the head of the project's audit log as this process holds it. */
export function auditHeadOf(repo: Repo, projectId: string): { seq: number; hash: string } | null {
  const head = cores.get(repo)!.state(projectId).audit.head;
  return head ? { seq: head.seq, hash: head.hash } : null;
}

/** Package-internal (retention, R90 d): the governed destruction change. */
export function destroyProjectAssets(repo: Repo, projectId: string, input: DestroyInput): ReturnType<typeof destroyAssets> {
  return destroyAssets(cores.get(repo)!, projectId, input);
}

/** Package-internal (retention, R147): the governed change that writes an amendment beside a destruction certificate. */
export function amendProjectDestruction(repo: Repo, projectId: string, input: AmendInput): ReturnType<typeof amendDestruction> {
  return amendDestruction(cores.get(repo)!, projectId, input);
}

/**
 * Package-internal (retention, R147): the project's audit events whose line contains one of
 * `needles`. `headMatches`: the log on disk ends at the head this process holds (the one checked
 * against the anchor at open, moved on only by this process's own appends); false means the log
 * changed outside the app since. The log is read outside the write queue (it can be long, and this
 * runs hourly for every project); only the comparison with the head runs in the queue. If the two do
 * not match, an entry may have been appended while the log was read: it is read once more, in the
 * queue, where nothing is appended meanwhile.
 */
export async function auditEventsMentioning(repo: Repo, projectId: string, needles: readonly string[]): Promise<{ events: AuditEvent[]; headMatches: boolean }> {
  const core = cores.get(repo)!;
  const first = await AuditStore.readMatching(core.state(projectId).audit.dir, needles);
  return core.serial(async () => {
    const st = core.state(projectId);
    if (endsAt(first.last, st.audit.head)) return { events: first.events, headMatches: true };
    const { events, last } = await AuditStore.readMatching(st.audit.dir, needles);
    return { events, headMatches: endsAt(last, st.audit.head) };
  });
}

/**
 * Package-internal (retention, FR-420): `fn` runs in a turn of the write queue, given the project's audit events whose
 * line contains one of `needles`, read in that turn (nothing is appended meanwhile), so what `fn` reads from disk is
 * taken together with them. A locked project is refused (ProjectLockedError) before anything is read.
 */
export function inTurnWithAuditEventsMentioning<T>(repo: Repo, projectId: string, needles: readonly string[], fn: (events: AuditEvent[]) => Promise<T>): Promise<T> {
  const core = cores.get(repo)!;
  return writeQueueTurn(repo)(async () => {
    const st = core.state(projectId);
    core.assertUnlocked(st);
    return fn((await AuditStore.readMatching(st.audit.dir, needles)).events);
  });
}

/**
 * Package-internal (retention, R147): every audit event of the project, only when its chain of
 * hashes verifies and it ends at the head this process holds; otherwise `ok: false` (the log is not
 * what the app wrote, so nothing may be removed on its word). Read and verified outside the write
 * queue, the head compared in it; a reading that does not pass is made once more in the queue, so an
 * entry appended meanwhile is never taken for a change made outside the app.
 */
export async function verifiedAuditEvents(repo: Repo, projectId: string): Promise<{ ok: true; events: AuditEvent[] } | { ok: false }> {
  const core = cores.get(repo)!;
  const read = async () => {
    const events = (await AuditStore.read(core.state(projectId).audit.dir)) as AuditEvent[];
    return { events, verify: verifyChain(events) };
  };
  let r = await read();
  return core.serial(async () => {
    const head = core.state(projectId).audit.head;
    if (!r.verify.ok || !endsAt(r.verify.head, head)) r = await read();
    if (!r.verify.ok || !endsAt(r.verify.head, head)) return { ok: false as const };
    return { ok: true as const, events: r.events };
  });
}

/**
 * Package-internal (restore, in its commit turn): `verifiedAuditEvents` for a caller that already
 * holds the write queue, where nothing is appended meanwhile. Never call it outside the queue.
 */
export async function verifiedAuditEventsInQueue(repo: Repo, projectId: string): Promise<{ ok: true; events: AuditEvent[] } | { ok: false }> {
  const st = cores.get(repo)!.state(projectId);
  const events = (await AuditStore.read(st.audit.dir)) as AuditEvent[];
  const verify = verifyChain(events);
  return verify.ok && endsAt(verify.head, st.audit.head) ? { ok: true, events } : { ok: false };
}

const endsAt = (last: { seq: number; hash: string } | null, head: { seq: number; hash: string } | null): boolean =>
  (last?.seq ?? 0) === (head?.seq ?? 0) && (last?.hash ?? "") === (head?.hash ?? "");

/** Sets a project's backup settings (daily automatic backup, how many to keep); governed and audited. */
export function setProjectBackupSettings(repo: Repo, projectId: string, settings: BackupSettings): Promise<Project> {
  return setBackupSettingsIn(cores.get(repo)!, projectId, settings);
}

/**
 * Sets (a real IANA zone name) or clears (null) the project's time zone, in which its calendar
 * rules such as the retention date are read (R92, R93); governed and audited. Absent: UTC.
 */
export function setProjectTimeZone(repo: Repo, projectId: string, tz: string | null): Promise<Project> {
  return setTimeZoneIn(cores.get(repo)!, projectId, tz);
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

/** Package-internal (consent forms, R117 I3): records the signed form's asset on the consent. */
export function setConsentDocumentAsset(repo: Repo, projectId: string, consentId: string, assetId: string, opts: { reattach?: boolean } = {}): Promise<ConsentRecord> {
  return setConsentDocument(cores.get(repo)!, projectId, consentId, assetId, opts);
}

/** Package-internal: records an integrity warning once (same project, kind and detail). */
export function noteIntegrityWarning(repo: Repo, w: IntegrityWarning): void {
  const list = cores.get(repo)!.integrityWarnings;
  if (!list.some((x) => x.projectId === w.projectId && x.kind === w.kind && x.detail === w.detail)) list.push(w);
}

const SET_ASIDE_OP = "attention.set-aside";

/** An audit event as the audit screen reads it: with the reason the researcher typed, when it carries one (R362 b). */
export type ShownAuditEvent = AuditEvent & { reasonShown?: AuditReasonView };

/** The project's key, or "locked". */
function keyOrLocked(core: RepoCore, st: ProjectState): { key: Uint8Array; keyId: string } | "locked" {
  try {
    return core.key(st);
  } catch {
    return "locked";
  }
}

/**
 * R362 b: each event of a project's log with the reason it carries: as typed; or, sealed, read with the project key
 * (from the review entry for "Reviewed after the withdrawal", R177 b; else from the store of reasons, by the entry's
 * seq and hash), shown only when it matches the entry's digest (keyed, R369 b; or SHA-256 in earlier entries). Locked:
 * the sentence; nothing is read without the key.
 */
async function withProjectReasons(core: RepoCore, st: ProjectState, events: AuditEvent[]): Promise<ShownAuditEvent[]> {
  const sealed = events.filter(hasSealedReason);
  let k: { key: Uint8Array; keyId: string } | "locked" = "locked";
  // A read that fails is said as such (R369 d), never as a text that is no longer there.
  let store: Map<string, { text: string }> | "unreadable" = new Map();
  let review: ReviewEntry[] | "unreadable" = [];
  if (sealed.length && core.encrypted(st)) {
    k = keyOrLocked(core, st);
    if (k !== "locked") {
      const key = k.key;
      // A read a lock cut short (a wiped key) is "locked", never "unreadable" (R386 a).
      const failed = (e: unknown): "unreadable" => {
        if (e instanceof KeyNotAvailableError || e instanceof ProjectLockedError) throw new ProjectLockedError(st.project.id);
        return "unreadable";
      };
      if (sealed.some((e) => typeof e.details?.reviewEntry !== "string")) store = await readProjectReasons(core.abs(`${st.rel}/${AUDIT_REASONS_FILE}`), key, st.project.id).catch(failed);
      if (sealed.some((e) => typeof e.details?.reviewEntry === "string")) review = await readReviewEntries(core, st).catch(failed);
      // The digests below are checked with this key: wiped meanwhile, the read is refused as locked.
      if (key.every((b) => b === 0)) throw new ProjectLockedError(st.project.id);
    }
  }
  return events.map((e) => {
    const shown = reasonView(e, () => {
      if (k === "locked") return "locked";
      const key = k.key;
      const entry = e.details?.reviewEntry;
      if (typeof entry === "string") {
        if (review === "unreadable") return "unreadable";
        // A restored copy gives its review entries new ids (R92) while its audit log keeps the old: then the entry
        // resolved by this decision at this entry's time, with the text whose digest the entry records.
        const byId = review.find((r) => r.id === entry);
        if (byId) return { key, text: byId.reason };
        return { key, text: review.find((r) => r.decision === "reviewed-after-withdrawal" && r.resolvedAt === e.at && typeof r.reason === "string" && reasonMatches(e.details, r.reason, key))?.reason };
      }
      if (store === "unreadable") return "unreadable";
      return { key, text: store.get(reasonKey(e.seq, e.hash))?.text };
    });
    return shown ? { ...e, reasonShown: shown } : e;
  });
}

/** R362 b: the library's log: a sealed reason is read with the key of the project the entry names. */
async function withLibraryReasons(core: RepoCore, events: AuditEvent[]): Promise<ShownAuditEvent[]> {
  // A read that fails is said as such (R369 d), never as a text that is no longer there.
  const lines = events.some(hasSealedReason) ? await readLibraryReasonLines(join(core.root, LIBRARY_AUDIT_REASONS_FILE)).catch(() => "unreadable" as const) : [];
  return events.map((e) => {
    const shown = reasonView(e, () => {
      const st = e.projectId ? core.projects.get(e.projectId) : undefined;
      if (!st) return { key: new Uint8Array(0), text: undefined };
      const k = keyOrLocked(core, st);
      if (k === "locked") return "locked";
      if (lines === "unreadable") return "unreadable";
      const line = lines.find((l) => l.seq === e.seq && l.hash === e.hash && l.projectId === e.projectId);
      return { key: k.key, text: line ? openLibraryReason(line.sealed, k.key, st.project.id)?.text : undefined };
    });
    return shown ? { ...e, reasonShown: shown } : e;
  });
}

async function setAsideMarkIn(core: RepoCore, projectId: string, markId: string, reason: string): Promise<{ recordedIn: "project" | "library" }> {
  core.assertWritable();
  // The policy engine decides on the reason itself (N7): a blank one is refused there, and audited.
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length > 1000) throw new InvalidInputError("Give a reason of up to 1000 characters for setting this aside");
  const st = core.state(projectId);
  if (typeof markId !== "string") throw new NotFoundError("Mark", String(markId));
  const intact = st.recoveryPending !== true && st.auditUnverified !== true;
  if (intact) {
    const m = await markForSetAside(core, st, markId);
    if (!m) throw new NotFoundError("Mark", markId);
    // Decided and audited in the project's log (a deny is audited there and thrown).
    if (core.encrypted(st)) {
      // R362 b: the entry records the reason's SHA-256; its text is sealed in the same change, under the marker (R26).
      await runMutation(core, projectId, { action: "set-aside", setAside: { reason: why } }, async () => undefined, {
        op: SET_ASIDE_OP,
        entity: { type: "project", id: projectId },
        // Keyed with the project's key, known once the change runs (a locked project is refused there).
        auditDetails: () => ({ ...auditedReasonIn(core, st, why), mark: m.summary }),
        sealedReason: why,
      });
    } else {
      await authorizeOnly(
        core,
        projectId,
        { action: "set-aside", setAside: { reason: why } },
        { op: SET_ASIDE_OP, entity: { type: "project", id: projectId }, auditAllow: { details: { reason: why, mark: m.summary } } },
      );
    }
    await core.serial(() => m.remove());
    return { recordedIn: "project" };
  }
  // The project's log cannot take it: decided against the project's governance, recorded in the library's log.
  return core.serial(async () => {
    core.assertWritable();
    // R362 b: an encrypted project's reason is sealed with its key; locked, nothing is written.
    const encrypted = core.encrypted(st);
    if (encrypted) core.assertUnlocked(st);
    const m = await markForSetAside(core, st, markId);
    if (!m) throw new NotFoundError("Mark", markId);
    const at = core.clock().toISOString();
    let decision: { result: "allow" } | { result: "deny"; reason: string };
    try {
      const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
      if (!raw) throw new Error("governance.yaml is missing");
      const d = evaluate(parseGovernance(raw.toString("utf8")), { action: "set-aside", projectId, actor: core.actor, now: at, tz: core.zoneOf(st.project), setAside: { reason: why } });
      decision = d.result === "deny" ? { result: "deny", reason: d.reason } : { result: "allow" };
    } catch (e) {
      // Never an error message here: it can name an absolute path (N5).
      decision = { result: "deny", reason: `Policy could not be evaluated (${reasonOf(e)})` };
    }
    const input = {
      at,
      actor: core.actor,
      device: core.device,
      projectId,
      action: "set-aside",
      entity: { type: "project" as const, id: projectId },
      decision,
      details: { op: SET_ASIDE_OP, ...(encrypted && why === "" ? {} : auditedReason(encrypted ? core.key(st).key : undefined, why)), mark: m.summary, projectLogNotIntact: true },
    };
    if (encrypted && why !== "") await appendLibraryAuditWithReason(core, input, core.key(st), why);
    else await appendLibraryAudit(core, input);
    if (decision.result === "deny") throw new PolicyDeniedError(decision.reason, "set-aside");
    await m.remove();
    return { recordedIn: "library" as const };
  });
}
