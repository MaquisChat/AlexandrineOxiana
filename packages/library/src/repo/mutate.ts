/**
 * The single write path. Every repository change runs through `runMutation`:
 *
 *   0. read-only library → ReadOnlyLibraryError; locked encrypted project →
 *      ProjectLockedError (nothing evaluated, nothing written)
 *   1. policy: each request is evaluated with the researcher's tz and `now`
 *      (R17). Conditions the project cannot honour (encrypt / pseudonymize
 *      without project encryption) turn the decision into a deny. A deny is
 *      audited and thrown as PolicyDeniedError; nothing else is written.
 *   2. `fn(tx)` writes files to their final names, each atomically. Before
 *      each step (file created/replaced, folder created, folder trashed) it is
 *      recorded in the write-ahead marker `.tmp/txn-<id>.json` (see txn.ts).
 *   3. the change log is appended (fsync), recorded in the marker first.
 *   4. the "allow" audit event(s), carrying `details.txn = <id>`, are all
 *      appended (fsync): the commit point. Then the marker is deleted.
 *   If 2–4 fail in-process, every marker step is undone in reverse (audit and
 *   change log lines truncated away, files removed or restored), so no partial
 *   state remains and no "allow" event exists for a change that did not happen.
 *   If the process dies instead, the marker survives and openRepo finishes or
 *   rolls back the transaction (recoverTransactions), with a warning.
 *   5. after commit: external audit anchor, in-memory state, trash purge, and
 *      finally the index sink (R22). Failures here never undo the commit.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LOCATION_NEEDS_ENCRYPTION,
  diffToChanges,
  evaluate,
  parseGovernance,
  type Change,
  type Condition,
  type EntityType,
  type GovernanceConfig,
  type PolicyDecision,
  type PolicyRequest,
} from "@ao/core";
import type { Readable } from "node:stream";
import { decryptStream, encryptStream } from "../crypto/format.js";
import { copyFileAtomic, renameWithRetry, writeFileAtomic, writeSmallFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";

const SMALL_FILE_BYTES = 256 * 1024;
import type { AuditInput } from "./audit-store.js";
import { appendChanges } from "./changelog-store.js";
import { AuditStore } from "./audit-store.js";
import { PolicyDeniedError, RecoveryPendingError } from "./errors.js";
import { appendDurable, assertContained, encryptBytes, exists, readMaybe, sealLine, type AppendUndo, type ContainmentCache } from "./io.js";
import { SimulatedCrash, maybeCrash, seams } from "./seams.js";
import { TxnLog } from "./txn.js";
import type { IndexSink, ProjectState, RepoCore } from "./state.js";

/** A policy request without the fields the repository fills in (projectId; actor, now and tz by default). */
export type MutateRequest = Omit<PolicyRequest, "projectId" | "actor" | "now" | "tz"> &
  Partial<Pick<PolicyRequest, "actor" | "now" | "tz">>;

export interface MutateOptions {
  /** Operation name recorded in audit details, e.g. "source.create". */
  op?: string;
  /** Entity for the audit events, when known before `fn` runs (deny events). */
  entity?: { type: EntityType; id: string };
}

/**
 * Package-internal: turns an allowed decision the caller cannot honour into a deny with the returned
 * reason, e.g. attach refusing media whose store carries a location condition until coarsening
 * exists (R56). It receives frozen deep copies, so it cannot change the decision; a hook that
 * throws is a deny too (fail closed), always with REFUSED_GENERIC as its reason (R58). The deny is
 * audited and thrown like any other, before anything is written.
 */
export type RefuseHook = (d: Readonly<PolicyDecision>, req: Readonly<PolicyRequest>) => string | undefined;

/** Options of the package-internal write path; the public `Repo.mutate` takes only MutateOptions. */
export interface InternalMutateOptions extends MutateOptions {
  refuse?: RefuseHook;
  /**
   * The entity each allow event is about, by request index (one change storing several sources,
   * Bulk Import): consulted when the events are written, after `fn` ran. Default: the change's entity.
   */
  entityFor?: (index: number) => { type: EntityType; id: string } | undefined;
  /**
   * A deny is thrown but NOT audited: only for a caller that then retries each request in a change
   * of its own (which audits it), so every refusal is audited exactly once (Bulk Import groups, R62).
   */
  unauditedDeny?: boolean;
  /** More details recorded on the allow audit event(s), e.g. the reason given for loosening governance; a function is called once `fn` has run. */
  auditDetails?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * Only for repairing an unreadable governance.yaml (governance edit, R98): the policy evaluated
   * when the file cannot be read or parsed, instead of denying everything.
   */
  unreadablePolicyFallback?: GovernanceConfig;
}

export const REFUSED_GENERIC = "Refused by an internal check";

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

function runRefuse(refuse: RefuseHook | undefined, d: PolicyDecision, req: PolicyRequest): string | undefined {
  if (!refuse || d.result === "deny") return undefined;
  try {
    return refuse(deepFreeze(structuredClone(d)), deepFreeze(structuredClone(req)));
  } catch {
    // Never the error's message: it may name files or data.
    return REFUSED_GENERIC;
  }
}

export interface FileOptions {
  /** Encrypt with the project key (v1 format). */
  encrypt?: boolean;
  /** POSIX mode, e.g. 0o600 for unencrypted identifiable files (R19). */
  mode?: number;
  /** copyFile: the source is already in the project's encrypted format (decrypted on the way; hash of the plaintext). */
  sourceEncrypted?: boolean;
  /** copyFile: open the source without following a symbolic link (O_NOFOLLOW where available). */
  noFollow?: boolean;
}

export interface Tx {
  readonly projectId: string;
  readonly state: ProjectState;
  /** Conditions from the policy decisions (deduplicated). */
  readonly conditions: Condition[];
  readonly encrypted: boolean;
  /** True when the decision requires pseudonymized file and folder names. */
  readonly pseudonymize: boolean;
  readonly now: Date;
  /** `now` as ISO UTC with milliseconds. */
  readonly at: string;
  readonly actor: string;
  readonly device: string;
  key(): { key: Uint8Array; keyId: string };
  exists(rel: string): Promise<boolean>;
  mkdir(rel: string): Promise<void>;
  writeFile(rel: string, data: Uint8Array | string, opts?: FileOptions): Promise<void>;
  /** Copies (or encrypts) a file to a new library path; refuses to overwrite. */
  copyFile(src: string, rel: string, opts?: FileOptions): Promise<{ sha256: string; bytes: number }>;
  /** Appends one line (a newline is added) to a project file, durably; undone on rollback. */
  appendLine(rel: string, line: string, opts?: { mode?: number }): Promise<void>;
  /** Moves a file or folder to `.tmp/` (restored on rollback, purged after commit). */
  trash(rel: string): Promise<void>;
  /**
   * Like `trash`, but the file or folder is destroyed once the change commits (R90 d): overwritten,
   * then removed, before the write-ahead marker goes (a crash after the commit finishes it on the
   * next open). Restored on rollback like trash.
   */
  destroy(rel: string): Promise<void>;
  /** Records the change(s) between `before` and `after` (null = create/delete). */
  record(type: EntityType, id: string, before: object | null, after: object | null): void;
  /** The entity the audit events are about. */
  entity(type: EntityType, id: string): void;
  /** Runs after commit, before the index (in-memory state updates). Must not throw. */
  onCommit(fn: () => void): void;
  /** Index work after commit. */
  index(fn: (sink: IndexSink) => void | Promise<void>): void;
}

class TxImpl implements Tx {
  readonly changes: Change[] = [];
  readonly commitHooks: Array<() => void> = [];
  readonly indexHooks: Array<(sink: IndexSink) => void | Promise<void>> = [];
  readonly trashed: string[] = [];
  /** Trash entries to overwrite before they are removed (`destroy`). */
  readonly shred: string[] = [];
  auditEntity?: { type: EntityType; id: string };

  constructor(
    private readonly core: RepoCore,
    readonly state: ProjectState,
    readonly conditions: Condition[],
    readonly now: Date,
    readonly log: TxnLog,
  ) {}

  get projectId() {
    return this.state.project.id;
  }
  get encrypted() {
    return this.core.encrypted(this.state);
  }
  get pseudonymize() {
    return this.conditions.some((c) => c.type === "pseudonymize-names");
  }
  get at() {
    return this.now.toISOString();
  }
  get actor() {
    return this.core.actor;
  }
  get device() {
    return this.core.device;
  }
  key() {
    return this.core.key(this.state);
  }
  private readonly containment: ContainmentCache = { dirs: new Set() };
  /** PathEscapeError unless `abs` stays inside the project folder (no symlink escapes). */
  guard(abs: string): Promise<void> {
    return assertContained(this.core.abs(this.state.rel), abs, this.containment);
  }
  exists(rel: string) {
    return exists(this.core.abs(rel));
  }

  async mkdir(rel: string): Promise<void> {
    const abs = this.core.abs(rel);
    await this.guard(abs);
    // Record the outermost folder this call will create, before creating it. That folder is created
    // on its own (not recursively): EEXIST means someone else made it, so it is not ours to remove
    // on undo; its step is taken back and the next missing folder below it is tried.
    for (;;) {
      let first: string | undefined;
      for (let cur = abs; !(await exists(cur)); cur = dirname(cur)) first = cur;
      if (!first) return;
      await this.log.createdDir(first);
      await seams.beforeMkdir?.(first);
      try {
        await fsp.mkdir(first);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        await this.log.retractDir(first);
        continue;
      }
      if (first !== abs) await fsp.mkdir(abs, { recursive: true });
      return;
    }
  }

  private async payload(data: Uint8Array | string, opts: FileOptions): Promise<Uint8Array | string> {
    if (!opts.encrypt) return data;
    const { key, keyId } = this.key();
    return encryptBytes(key, keyId, data);
  }

  async writeFile(rel: string, data: Uint8Array | string, opts: FileOptions = {}): Promise<void> {
    const abs = this.core.abs(rel);
    await this.guard(abs);
    const bytes = await this.payload(data, opts);
    if (await exists(abs)) await this.log.replaced(abs, (await fsp.stat(abs)).mode & 0o777);
    else await this.log.created(abs);
    // Small files (source.json, project.json, batch records) are written synchronously: cheaper
    // than the thread-pool round trips of the asynchronous path, with the same guarantees.
    if (bytes.length <= SMALL_FILE_BYTES) await writeSmallFileAtomic(abs, bytes, { mode: opts.mode });
    else await writeFileAtomic(abs, bytes, { mode: opts.mode });
  }

  async copyFile(src: string, rel: string, opts: FileOptions = {}): Promise<{ sha256: string; bytes: number }> {
    const abs = this.core.abs(rel);
    await this.guard(abs);
    if (await exists(abs)) throw new Error(`refusing to overwrite ${rel}`);
    await this.log.created(abs);
    let decode: ((r: Readable) => Readable) | undefined;
    if (opts.sourceEncrypted) {
      const { key, keyId } = this.key();
      decode = (r) => r.pipe(decryptStream((id) => (id === keyId ? key : undefined)));
    }
    const nf = opts.noFollow ? { noFollow: true } : {};
    if (!opts.encrypt) return copyFileAtomic(src, abs, { mode: opts.mode, ...nf, ...(decode ? { decode } : {}) });
    const { key, keyId } = this.key();
    return copyFileAtomic(src, abs, { mode: opts.mode, ...nf, ...(decode ? { decode } : {}), transform: (r) => r.pipe(encryptStream(key, keyId)) });
  }

  async appendLine(rel: string, line: string, opts: { mode?: number } = {}): Promise<void> {
    if (line.includes("\n")) throw new TypeError("appendLine: the line must not contain a newline");
    const abs = this.core.abs(rel);
    await this.mkdir(rel.slice(0, rel.lastIndexOf("/")));
    await this.guard(abs);
    await appendDurable(abs, `${line}\n`, opts.mode, (u) => this.log.append(u));
  }

  trash(rel: string): Promise<void> {
    return this.moveToTrash(rel, false);
  }

  destroy(rel: string): Promise<void> {
    return this.moveToTrash(rel, true);
  }

  private async moveToTrash(rel: string, shred: boolean): Promise<void> {
    const from = this.core.abs(rel);
    await this.guard(from);
    this.containment.dirs.clear(); // folders move away: check again from here on
    const dir = join(this.core.root, ".tmp");
    await fsp.mkdir(dir, { recursive: true });
    const to = join(dir, `trash-${this.log.id}-${randomBytes(8).toString("hex")}`);
    await assertContained(dir, to);
    await this.log.trashed(from, to, shred);
    await renameWithRetry(from, to);
    this.trashed.push(to);
    if (shred) this.shred.push(to);
  }

  record(type: EntityType, id: string, before: object | null, after: object | null): void {
    this.changes.push(
      ...diffToChanges(before, after, { at: this.at, author: this.actor, device: this.device, projectId: this.projectId, entity: { type, id } }),
    );
  }

  entity(type: EntityType, id: string): void {
    this.auditEntity = { type, id };
  }

  onCommit(fn: () => void): void {
    this.commitHooks.push(fn);
  }

  index(fn: (sink: IndexSink) => void | Promise<void>): void {
    this.indexHooks.push(fn);
  }
}

/** Change log files in unencrypted projects are always owner-only (R19). */
export const CHANGE_LOG_MODE = 0o600;

function denyOf(reason: string, warnings: string[] = []): PolicyDecision {
  return { result: "deny", reason, warnings };
}

/** Conditions the project cannot honour make the decision a deny (fail closed). */
function enforceConditions(core: RepoCore, st: ProjectState, d: PolicyDecision): PolicyDecision {
  if (d.result !== "allow_with_conditions") return d;
  const encrypted = core.encrypted(st);
  if (!encrypted && d.conditions.some((c) => c.type === "location")) return denyOf(LOCATION_NEEDS_ENCRYPTION, d.warnings);
  for (const c of d.conditions) {
    if (c.type === "encrypt" && !encrypted) {
      return denyOf("Governance requires encryption at rest, but this project is not encrypted", d.warnings);
    }
    if (c.type === "pseudonymize-names" && !encrypted) {
      return denyOf("Pseudonymized names need the encrypted pseudonym map, but this project is not encrypted", d.warnings);
    }
  }
  return d;
}

function auditDecision(d: PolicyDecision): AuditInput["decision"] {
  if (d.result === "deny") return { result: "deny", reason: d.reason };
  if (d.result === "allow_with_conditions") return { result: d.result, conditions: d.conditions };
  return { result: "allow" };
}

async function governanceOf(core: RepoCore, st: ProjectState) {
  const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
  if (!raw) throw new Error("governance.yaml is missing");
  return parseGovernance(raw.toString("utf8"));
}

/**
 * Step 1 of a mutation: evaluates each request with the researcher's tz and `now` (R17). A
 * governance file that cannot be read or parsed denies (fail closed); conditions the project cannot
 * honour deny. A deny is audited and thrown as PolicyDeniedError. Caller holds `core.serial`.
 */
async function decide(
  core: RepoCore,
  st: ProjectState,
  reqs: MutateRequest | MutateRequest[],
  at: string,
  op: string,
  entity: MutateOptions["entity"],
  refuse?: RefuseHook,
  unauditedDeny = false,
  fallback?: GovernanceConfig,
): Promise<Array<{ req: PolicyRequest; d: PolicyDecision }>> {
  let cfg: ReturnType<typeof parseGovernance> | undefined;
  let cfgError: string | undefined;
  try {
    cfg = await governanceOf(core, st);
  } catch (e) {
    cfgError = `Policy could not be evaluated: ${e instanceof Error ? e.message : String(e)}`;
    if (fallback) cfg = fallback;
  }
  const allowed: Array<{ req: PolicyRequest; d: PolicyDecision }> = [];
  for (const r of Array.isArray(reqs) ? reqs : [reqs]) {
    const req: PolicyRequest = { ...r, projectId: st.project.id, actor: r.actor ?? core.actor, now: r.now ?? at, tz: r.tz ?? core.tz };
    let d = enforceConditions(core, st, cfg ? evaluate(cfg, req) : denyOf(cfgError!));
    const refused = runRefuse(refuse, d, req);
    if (refused) d = denyOf(refused, d.warnings);
    if (d.result === "deny") {
      if (unauditedDeny) throw new PolicyDeniedError(d.reason, req.action);
      await core.auditNow(st, {
        ...core.auditBase(st, at),
        action: req.action,
        entity,
        decision: auditDecision(d),
        details: { op, ...(d.warnings.length ? { warnings: d.warnings } : {}) },
      });
      throw new PolicyDeniedError(d.reason, req.action);
    }
    allowed.push({ req, d });
  }
  return allowed;
}

/**
 * Package-internal: a policy decision for work that writes nothing to the library by itself (local
 * processing by the media worker). Same guards and evaluation as `runMutation` step 1: a deny is
 * audited and thrown as PolicyDeniedError; an allow is returned (not audited; whatever the work
 * produces is stored, and audited, through `runMutation`).
 */
export async function authorizeOnly(
  core: RepoCore,
  projectId: string,
  req: MutateRequest,
  opts: InternalMutateOptions & {
    /** Also audit an allow, as this one event (the caller then skips re-evaluating the request when storing). */
    auditAllow?: { details: Record<string, unknown> };
  } = {},
): Promise<PolicyDecision> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    if (st.recoveryPending) throw new RecoveryPendingError(projectId);
    core.assertUnlocked(st);
    const at = core.clock().toISOString();
    const op = opts.op ?? "authorize";
    const [first] = await decide(core, st, req, at, op, opts.entity, opts.refuse);
    if (opts.auditAllow) {
      await core.auditNow(st, {
        ...core.auditBase(st, at),
        action: req.action,
        entity: opts.entity ?? { type: "project", id: projectId },
        decision: auditDecision(first!.d),
        details: { op, ...opts.auditAllow.details, ...(first!.d.warnings.length ? { warnings: first!.d.warnings } : {}) },
      });
    }
    return first!.d;
  });
}

export async function runMutation<T>(
  core: RepoCore,
  projectId: string,
  reqs: MutateRequest | MutateRequest[],
  fn: (tx: Tx) => Promise<T>,
  opts: InternalMutateOptions = {},
): Promise<T> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    if (st.recoveryPending) throw new RecoveryPendingError(projectId);
    core.assertUnlocked(st);
    const now = core.clock();
    const at = now.toISOString();
    const op = opts.op ?? "mutate";

    // 1. Policy (a deny is audited and thrown).
    const allowed = await decide(core, st, reqs, at, op, opts.entity, opts.refuse, opts.unauditedDeny === true, opts.unreadablePolicyFallback);
    const conditions: Condition[] = [];
    for (const { d } of allowed) {
      if (d.result !== "allow_with_conditions") continue;
      for (const c of d.conditions) if (!conditions.some((x) => JSON.stringify(x) === JSON.stringify(c))) conditions.push(c);
    }

    // 2–4. Files, change log, audit (commit point); roll everything back on failure.
    const headBefore = st.audit.head;
    const log = new TxnLog(core.root, projectId, st.rel, allowed.length, st.audit.head?.seq ?? 0);
    const tx = new TxImpl(core, st, conditions, now, log);
    if (opts.entity) tx.entity(opts.entity.type, opts.entity.id);
    const onPlan = (u: AppendUndo) => log.append(u);
    let result: T;
    try {
      result = await fn(tx);
      const seal = core.encrypted(st)
        ? (() => {
            const { key, keyId } = core.key(st);
            return (json: string) => sealLine(key, keyId, projectId, json);
          })()
        : undefined;
      maybeCrash("before-changes");
      // Unencrypted change logs hold entity values in the clear: always 0600 (R19).
      // The change log and audit folders must be real folders inside the project too.
      await tx.guard(core.abs(`${st.rel}/changes/x`));
      await tx.guard(join(st.audit.dir, "x"));
      await appendChanges(core.abs(`${st.rel}/changes`), tx.changes, seal, seal ? undefined : CHANGE_LOG_MODE, onPlan);
      maybeCrash("before-audit");
      for (const [i, { req, d }] of allowed.entries()) {
        if (i > 0) maybeCrash("between-audit");
        await st.audit.append({
          ...core.auditBase(st, at),
          action: req.action,
          entity: opts.entityFor?.(i) ?? tx.auditEntity,
          decision: auditDecision(d),
          details: { op, ...(typeof opts.auditDetails === "function" ? opts.auditDetails() : opts.auditDetails), txn: log.id, changes: tx.changes.length, ...(d.warnings.length ? { warnings: d.warnings } : {}) },
        }, onPlan);
      }
      maybeCrash("before-marker-delete");
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err; // tests: the process "died" here
      if (await log.undo()) {
        st.audit.head = headBefore;
        await log.finish().catch(() => {});
      } else {
        // Keep the marker so the next open can finish the rollback, and stop writing to this
        // project until then: later writes could otherwise be undone by that recovery.
        st.recoveryPending = true;
        st.audit.head = (await AuditStore.load(st.audit.dir).catch(() => null))?.store.head ?? headBefore;
      }
      throw err;
    }
    // Destroyed files are overwritten before the marker goes; if that fails the marker stays, and
    // the next open (which resolves it as committed) overwrites them then.
    let shredded = true;
    for (const t of tx.shred) {
      try {
        await shredPath(t);
      } catch {
        shredded = false;
      }
    }
    if (shredded) await log.finish().catch(() => {}); // a leftover marker is resolved as committed on next open

    // 5. Committed.
    await core.updateAnchor(st, at);
    for (const h of tx.commitHooks) h();
    for (const t of tx.trashed) if (shredded || !tx.shred.includes(t)) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
    for (const h of tx.indexHooks) {
      try {
        await h(core.index);
      } catch (error) {
        core.indexErrors.push({ op, error });
      }
    }
    return result;
  });
}
