/** Repository state: the open library, its projects, and helpers every repo module uses. */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  ConsentRecord,
  Collection,
  Participant,
  Project,
  Session,
  Tag,
  dateRuleZone,
  type DateRule,
  type SourceFile,
  type AuditEvent,
} from "@ao/core";
import type { KeyRing } from "../crypto/keys.js";
import { projectMovedAway, type Library } from "../library.js";
import { AnchorStore, AuditStore, type AuditInput, type IntegrityWarning } from "./audit-store.js";
import { NotFoundError, ProjectLockedError, ReadOnlyLibraryError } from "./errors.js";
import { absPath, readMaybe } from "./io.js";
import type { InternalOptions } from "./seams.js";
import type { ReviewItemRow } from "./review.js";

/** Search-index port (Task 12). Called last in a mutation, after files, change log and audit. */
export interface IndexSink {
  indexSource(sf: SourceFile, extractedText?: string): void | Promise<void>;
  removeSource(id: string): void | Promise<void>;
  indexProject(p: Project): void | Promise<void>;
  /**
   * A locked encrypted project that is new to the index (a copy restored with a key that was not
   * kept): the project and, from its manifest alone, its sources (R30: type and year, no titles, no
   * text). Optional; absent means `indexProject` is called instead.
   */
  indexLockedProject?(p: Project, sources: ManifestEntry[]): void | Promise<void>;
  /**
   * Called synchronously when an encrypted project is locked: drop everything held for it beyond
   * manifest-level fields (R30). Optional; absent means nothing to drop.
   */
  purgeProject?(projectId: string): void;
  /** Called after an encrypted project was unlocked so its content can be indexed again. Optional. */
  projectUnlocked?(projectId: string): void | Promise<void>;
  /** A review-queue entry was written to `review/pending.jsonl` (R31). Optional. */
  indexReviewItem?(row: ReviewItemRow): void | Promise<void>;
}

export const NOOP_INDEX: IndexSink = { indexSource() {}, removeSource() {}, indexProject() {} };

export interface RepoOptions {
  index?: IndexSink;
  /** IANA zone used for policy calendar dates and derived-file timestamps (R17). */
  tz?: string;
  clock?: () => Date;
  actor?: string;
  device?: string;
  /**
   * Open without healing anything (`ao verify-audit`): no crash recovery, no trimming, no
   * anchor-mismatch events and no re-anchoring; problems are only reported in integrityWarnings.
   */
  noHeal?: boolean;
}

/** `<Project>/project.json`. */
export interface ProjectJson {
  formatVersion: 1;
  project: Project;
  collections: Collection[];
  tags: Tag[];
  participants: Participant[];
  sessions: Session[];
  consents: ConsentRecord[];
  /**
   * Codes of deleted participants (R117 C1): retired forever, never given to anyone else, so a
   * pseudonym map entry or an old citation can never point at a different person.
   */
  retiredParticipantCodes?: string[];
}

export function parseProjectJson(v: unknown): ProjectJson {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.formatVersion !== 1) throw new Error("project.json: unsupported formatVersion");
  return {
    formatVersion: 1,
    project: Project.parse(o.project),
    collections: Collection.array().parse(o.collections ?? []),
    tags: Tag.array().parse(o.tags ?? []),
    participants: Participant.array().parse(o.participants ?? []),
    sessions: Session.array().parse(o.sessions ?? []),
    consents: ConsentRecord.array().parse(o.consents ?? []),
    ...(Array.isArray(o.retiredParticipantCodes) ? { retiredParticipantCodes: (o.retiredParticipantCodes as unknown[]).filter((c): c is string => typeof c === "string") } : {}),
  };
}

/** `<Project>/manifest.json` (encrypted projects): structure only, nothing identifying. */
export interface ManifestEntry {
  id: string;
  type: string;
  issuedYear?: string;
  /** Library-relative source folder (already pseudonymized). */
  folder: string;
  /** Library-relative file paths (already pseudonymized, `.enc`-suffixed). */
  files: string[];
}
export interface Manifest {
  formatVersion: 1;
  sources: ManifestEntry[];
}

export interface ProjectState {
  project: Project;
  /** Library-relative project folder, e.g. `Projects/My Project`. */
  rel: string;
  data: ProjectJson;
  audit: AuditStore;
  /** Source id → library-relative folder. */
  sources: Map<string, string>;
  manifest: Manifest;
  /**
   * Writes are refused (RecoveryPendingError) until the library is reopened and the cause is
   * resolved: an in-process rollback failed, a write-ahead marker is unresolved, an incomplete
   * audit or change-log line could not be trimmed, or an audit append failed while opening.
   */
  recoveryPending?: boolean;
  /** The project's audit log did not verify when opened: marks cannot be recorded in it (Task 50). */
  auditUnverified?: boolean;
}

/** One turn of a repo's write queue. */
interface Turn {
  readonly core: RepoCore;
}
/**
 * The write-queue turn the current code runs in, if any. A timer or callback started inside a turn carries the
 * turn's context with it, even after the turn has ended.
 */
const inTurn = new AsyncLocalStorage<Turn>();

/**
 * Run when a project is locked, in the lock's own turn (and when the lock is asked): each module that keeps a
 * project's decrypted content in memory drops it there (R386 a: the watched-folders register, the Find queue).
 */
export const lockPurges: Array<(core: RepoCore, st: ProjectState) => void> = [];

export class RepoCore {
  readonly projects = new Map<string, ProjectState>();
  readonly integrityWarnings: IntegrityWarning[] = [];
  /** Index failures after a committed mutation (the index is rebuildable; the mutation stands). */
  readonly indexErrors: Array<{ op: string; error: unknown }> = [];
  readonly anchors: AnchorStore;
  readonly index: IndexSink;
  readonly tz: string;
  readonly clock: () => Date;
  readonly actor: string;
  readonly device: string;
  readonly scryptN: number | undefined;
  readonly auditSegmentSize: number | undefined;
  /** The library's own audit log (Task 50, R154 a), loaded at open; its latest event. */
  libraryAudit?: AuditStore;
  libraryAuditLast?: AuditEvent | null;
  /** The library log's entries of its latest day, for dropping a repeated refusal (N6). */
  libraryAuditRecent?: AuditEvent[];
  /** The write queue: turns waiting, those asked to go next (`serialNext`) ahead of the rest. */
  private readonly waiting: Array<() => void> = [];
  private readonly urgent: Array<() => void> = [];
  /** A turn is running or about to start. */
  private writing = false;
  /** The turn running now, if any. */
  private running: Turn | undefined;
  /** Locks asked and not yet done (the key is wiped when the turn in progress ends), by project id (R386 b). */
  readonly pendingLocks = new Map<string, Promise<void>>();
  /** Unlocks in progress, per project: a lock asked meanwhile is a new lock after them (R404 c). */
  readonly pendingUnlocks = new Map<string, Promise<void>>();

  constructor(
    readonly library: Library,
    readonly keyRing: KeyRing,
    opts: RepoOptions & InternalOptions,
  ) {
    this.anchors = AnchorStore.forConfigDir(library.appConfigDir);
    this.noHeal = opts.noHeal === true;
    this.index = opts.index ?? NOOP_INDEX;
    this.tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.clock = opts.clock ?? (() => new Date());
    this.actor = opts.actor ?? "local-user";
    this.device = opts.device ?? library.deviceId;
    this.scryptN = opts.scryptN;
    this.auditSegmentSize = opts.auditSegmentSize;
  }

  get root(): string {
    return this.library.root;
  }

  /**
   * The zone a project's date rule is read in (R160 as amended, `dateRuleZone`): its time zone
   * when set, else the computer's zone (`tz`) for protocol and other dates, UTC for retention.
   */
  zoneOf(project: { timeZone?: string | undefined }, rule: DateRule = "protocol"): string {
    return dateRuleZone(project, rule, this.tz);
  }

  abs(rel: string): string {
    return absPath(this.root, rel);
  }

  /** Opened for checking only (RepoOptions.noHeal): nothing is written. */
  readonly noHeal: boolean;

  assertWritable(): void {
    if (this.library.mode !== "read-write" || this.noHeal) throw new ReadOnlyLibraryError(this.noHeal ? "not-writable" : this.library.readOnlyReason);
  }

  /** Runs write operations one at a time, so audit sequence numbers and files never interleave. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(fn, false);
  }

  /**
   * Runs `fn` as the next turn of the write queue: after the turn in progress, ahead of the turns already waiting.
   * Locking a project (and unlocking an unlocked one) goes here (R379): it never lands inside a change being saved,
   * and it waits only for that change, not for the queue behind it (each change of a long import is one turn).
   */
  serialNext<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(fn, true);
  }

  /** No turn is running or about to start. */
  queueIdle(): boolean {
    return !this.writing;
  }

  /**
   * A test that admits only the turn running now (none, when none is running) and the code that runs in its
   * context: what still gets a project's key between a lock being asked and the key being wiped (R386 b).
   * A later turn, and any code outside the write queue, is not admitted. A timer or callback started inside the
   * running turn is (it carries that turn's context), until the key is wiped when the turn ends.
   */
  admitsOnlyRunningTurn(): () => boolean {
    const turn = this.running;
    return () => turn !== undefined && inTurn.getStore() === turn;
  }

  private enqueue<T>(fn: () => Promise<T>, next: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Bound to the caller's async context, as a promise reaction would be.
      const start = AsyncResource.bind(() => {
        const turn: Turn = { core: this };
        this.running = turn;
        let run: Promise<T>;
        try {
          run = Promise.resolve(inTurn.run(turn, fn));
        } catch (err) {
          run = Promise.reject(err);
        }
        run.then(resolve, reject).finally(() => {
          if (this.running === turn) this.running = undefined;
          this.startNext();
        });
      });
      (next ? this.urgent : this.waiting).push(start);
      if (!this.writing) {
        this.writing = true;
        queueMicrotask(() => this.startNext());
      }
    });
  }

  private startNext(): void {
    const start = this.urgent.shift() ?? this.waiting.shift();
    this.writing = start !== undefined;
    start?.();
  }

  /** True while running in a turn of this repo's write queue (`serial`): no other write is in progress. */
  holdsTurn(): boolean {
    return inTurn.getStore()?.core === this;
  }

  state(projectId: string): ProjectState {
    const st = this.projects.get(projectId);
    if (!st) throw new NotFoundError("Project", projectId);
    return st;
  }

  encrypted(st: ProjectState): boolean {
    return st.project.encryption.enabled;
  }

  /** The project's data key; throws ProjectLockedError when encrypted and not unlocked. */
  key(st: ProjectState): { key: Uint8Array; keyId: string } {
    const keyId = st.project.encryption.keyId;
    const key = keyId ? this.keyRing.get(keyId) : undefined;
    if (!keyId || !key) throw new ProjectLockedError(st.project.id);
    return { key, keyId };
  }

  assertUnlocked(st: ProjectState): void {
    if (this.encrypted(st)) this.key(st);
  }

  anchorKey(projectId: string): string {
    return `${this.library.id}/${projectId}`;
  }

  /** Base fields of an audit event for this repo. */
  auditBase(st: ProjectState, at: string): Pick<AuditEvent, "at" | "actor" | "device" | "projectId"> {
    return { at, actor: this.actor, device: this.device, projectId: st.project.id };
  }

  /** Appends one audit event and records the new head as the external anchor. */
  async auditNow(st: ProjectState, input: AuditInput): Promise<void> {
    await st.audit.append(input);
    await this.updateAnchor(st, input.at);
  }

  /** Best effort: a failed anchor write must not undo a committed mutation; the next open re-checks. */
  async updateAnchor(st: ProjectState, at: string): Promise<void> {
    if (!st.audit.head) return;
    try {
      await this.anchors.set(this.anchorKey(st.project.id), st.audit.head, at);
    } catch {
      // ignored: the anchor lives outside the library and is advisory
    }
  }
}

/** Reads every project folder under `Projects/` (skipping staging folders that start with "."). */
export async function loadProjects(
  core: RepoCore,
  /** Runs for each project before its audit log is read (openRepo trims incomplete lines here). */
  beforeAudit?: (project: { id: string; rel: string }) => Promise<void>,
): Promise<Array<{ st: ProjectState; events: Array<AuditEvent | null>; verify: Awaited<ReturnType<typeof AuditStore.load>>["verify"] }>> {
  const projectsDir = join(core.root, "Projects");
  let names: string[] = [];
  try {
    names = await fsp.readdir(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const out = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    // A project moved to another library (split move): its old folder is not part of this one.
    if (await projectMovedAway(core.root, name)) continue;
    const loaded = await loadProjectFolder(core, name, beforeAudit);
    if (loaded) out.push(loaded);
  }
  return out;
}

/** Reads one project folder `Projects/<name>` (null when it holds no project.json). */
export async function loadProjectFolder(
  core: RepoCore,
  name: string,
  beforeAudit?: (project: { id: string; rel: string }) => Promise<void>,
): Promise<{ st: ProjectState; events: Array<AuditEvent | null>; verify: Awaited<ReturnType<typeof AuditStore.load>>["verify"] } | null> {
  const projectsDir = join(core.root, "Projects");
  const raw = await readMaybe(join(projectsDir, name, "project.json"));
  if (!raw) return null;
  const data = parseProjectJson(JSON.parse(raw.toString("utf8")));
  const rel = `Projects/${name}`;
  await beforeAudit?.({ id: data.project.id, rel });
  const { store, events, verify } = await AuditStore.load(join(projectsDir, name, "audit"), core.auditSegmentSize);
  const st: ProjectState = {
    project: { ...data.project, folder: rel },
    rel,
    data,
    audit: store,
    sources: new Map(),
    manifest: { formatVersion: 1, sources: [] },
  };
  await loadSourceIndex(core, st);
  return { st, events, verify };
}

/** Source id → folder, from manifest.json (encrypted) or by reading each source.json. */
async function loadSourceIndex(core: RepoCore, st: ProjectState): Promise<void> {
  if (core.encrypted(st)) {
    const raw = await readMaybe(core.abs(`${st.rel}/manifest.json`));
    if (raw) st.manifest = JSON.parse(raw.toString("utf8")) as Manifest;
    for (const e of st.manifest.sources) st.sources.set(e.id, e.folder);
    return;
  }
  let names: string[] = [];
  try {
    names = await fsp.readdir(core.abs(`${st.rel}/Sources`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const name of names) {
    const raw = await readMaybe(core.abs(`${st.rel}/Sources/${name}/source.json`));
    if (!raw) continue;
    try {
      const j = JSON.parse(raw.toString("utf8")) as { source?: { id?: unknown } };
      if (typeof j.source?.id === "string") st.sources.set(j.source.id, `${st.rel}/Sources/${name}`);
    } catch {
      // unreadable source.json: left for "rebuild from folder" to report
    }
  }
}
