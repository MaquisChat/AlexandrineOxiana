/**
 * The single write path. Every repository change runs through `runMutation`:
 *
 *   0. read-only library → ReadOnlyLibraryError; locked encrypted project →
 *      ProjectLockedError (nothing evaluated, nothing written)
 *   1. policy: each request is evaluated with the researcher's tz and `now`
 *      (R17). Conditions the project cannot honour (encrypt / pseudonymize
 *      without project encryption) turn the decision into a deny. A deny is
 *      audited and thrown as PolicyDeniedError; nothing else is written.
 *   2. `fn(tx)` writes files to their final names, each atomically. The tx
 *      journals every file/folder it creates, replaces or moves to the trash.
 *   3. the change log is appended (fsync).
 *   4. the "allow" audit event(s) are appended (fsync): the commit point.
 *   If 2–4 fail, appended audit lines and change log lines are truncated away
 *   and the journal is rolled back in reverse, so no partial state remains and
 *   no "allow" event exists for a change that did not happen.
 *   5. after commit: external audit anchor, in-memory state, trash purge, and
 *      finally the index sink (R22). Failures here never undo the commit.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  diffToChanges,
  evaluate,
  parseGovernance,
  type Change,
  type Condition,
  type EntityType,
  type PolicyDecision,
  type PolicyRequest,
} from "@ao/core";
import { encryptStream } from "../crypto/format.js";
import { copyFileAtomic, writeFileAtomic } from "../fs/atomic.js";
import type { AuditInput } from "./audit-store.js";
import { appendChanges } from "./changelog-store.js";
import { PolicyDeniedError } from "./errors.js";
import { encryptBytes, exists, readMaybe, sealLine } from "./io.js";
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

export interface FileOptions {
  /** Encrypt with the project key (v1 format). */
  encrypt?: boolean;
  /** POSIX mode, e.g. 0o600 for unencrypted identifiable files (R19). */
  mode?: number;
}

type JournalEntry =
  | { kind: "created"; abs: string }
  | { kind: "replaced"; abs: string; old: Buffer; mode?: number }
  | { kind: "dir"; abs: string }
  | { kind: "trashed"; from: string; to: string };

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
  /** Moves a file or folder to `.tmp/` (restored on rollback, purged after commit). */
  trash(rel: string): Promise<void>;
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
  readonly journal: JournalEntry[] = [];
  readonly changes: Change[] = [];
  readonly commitHooks: Array<() => void> = [];
  readonly indexHooks: Array<(sink: IndexSink) => void | Promise<void>> = [];
  readonly trashed: string[] = [];
  auditEntity?: { type: EntityType; id: string };

  constructor(
    private readonly core: RepoCore,
    readonly state: ProjectState,
    readonly conditions: Condition[],
    readonly now: Date,
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
  exists(rel: string) {
    return exists(this.core.abs(rel));
  }

  async mkdir(rel: string): Promise<void> {
    const first = await fsp.mkdir(this.core.abs(rel), { recursive: true });
    if (first) this.journal.push({ kind: "dir", abs: first });
  }

  private async payload(data: Uint8Array | string, opts: FileOptions): Promise<Uint8Array | string> {
    if (!opts.encrypt) return data;
    const { key, keyId } = this.key();
    return encryptBytes(key, keyId, data);
  }

  async writeFile(rel: string, data: Uint8Array | string, opts: FileOptions = {}): Promise<void> {
    const abs = this.core.abs(rel);
    const bytes = await this.payload(data, opts);
    const old = await readMaybe(abs);
    if (old) {
      const mode = (await fsp.stat(abs)).mode & 0o777;
      this.journal.push({ kind: "replaced", abs, old, mode });
    } else {
      this.journal.push({ kind: "created", abs });
    }
    await writeFileAtomic(abs, bytes, { mode: opts.mode });
  }

  async copyFile(src: string, rel: string, opts: FileOptions = {}): Promise<{ sha256: string; bytes: number }> {
    const abs = this.core.abs(rel);
    if (await exists(abs)) throw new Error(`refusing to overwrite ${rel}`);
    this.journal.push({ kind: "created", abs });
    if (!opts.encrypt) return copyFileAtomic(src, abs, { mode: opts.mode });
    const { key, keyId } = this.key();
    return copyFileAtomic(src, abs, { mode: opts.mode, transform: (r) => r.pipe(encryptStream(key, keyId)) });
  }

  async trash(rel: string): Promise<void> {
    const from = this.core.abs(rel);
    const dir = join(this.core.root, ".tmp");
    await fsp.mkdir(dir, { recursive: true });
    const to = join(dir, `trash-${randomBytes(8).toString("hex")}`);
    await fsp.rename(from, to);
    this.journal.push({ kind: "trashed", from, to });
    this.trashed.push(to);
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

  /** Undo every journaled step in reverse. Best effort: keeps going past individual failures. */
  async rollback(): Promise<void> {
    for (const j of [...this.journal].reverse()) {
      try {
        if (j.kind === "created") await fsp.rm(j.abs, { force: true });
        else if (j.kind === "replaced") await writeFileAtomic(j.abs, j.old, { mode: j.mode });
        else if (j.kind === "dir") await fsp.rm(j.abs, { recursive: true, force: true });
        else await fsp.rename(j.to, j.from);
      } catch {
        // continue: leave as much as possible restored
      }
    }
  }
}

function denyOf(reason: string, warnings: string[] = []): PolicyDecision {
  return { result: "deny", reason, warnings };
}

/** Conditions the project cannot honour make the decision a deny (fail closed). */
function enforceConditions(core: RepoCore, st: ProjectState, d: PolicyDecision): PolicyDecision {
  if (d.result !== "allow_with_conditions") return d;
  const encrypted = core.encrypted(st);
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

export async function runMutation<T>(
  core: RepoCore,
  projectId: string,
  reqs: MutateRequest | MutateRequest[],
  fn: (tx: Tx) => Promise<T>,
  opts: MutateOptions = {},
): Promise<T> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const st = core.state(projectId);
    core.assertUnlocked(st);
    const now = core.clock();
    const at = now.toISOString();
    const op = opts.op ?? "mutate";

    // 1. Policy. A governance file that cannot be read or parsed denies (fail closed).
    let cfg: ReturnType<typeof parseGovernance> | undefined;
    let cfgError: string | undefined;
    try {
      cfg = await governanceOf(core, st);
    } catch (e) {
      cfgError = `Policy could not be evaluated: ${e instanceof Error ? e.message : String(e)}`;
    }
    const allowed: Array<{ req: PolicyRequest; d: PolicyDecision }> = [];
    for (const r of Array.isArray(reqs) ? reqs : [reqs]) {
      const req: PolicyRequest = { ...r, projectId, actor: r.actor ?? core.actor, now: r.now ?? at, tz: r.tz ?? core.tz };
      const d = enforceConditions(core, st, cfg ? evaluate(cfg, req) : denyOf(cfgError!));
      if (d.result === "deny") {
        await core.auditNow(st, {
          ...core.auditBase(st, at),
          action: req.action,
          entity: opts.entity,
          decision: auditDecision(d),
          details: { op, ...(d.warnings.length ? { warnings: d.warnings } : {}) },
        });
        throw new PolicyDeniedError(d.reason, req.action);
      }
      allowed.push({ req, d });
    }
    const conditions: Condition[] = [];
    for (const { d } of allowed) {
      if (d.result !== "allow_with_conditions") continue;
      for (const c of d.conditions) if (!conditions.some((x) => JSON.stringify(x) === JSON.stringify(c))) conditions.push(c);
    }

    // 2–4. Files, change log, audit (commit point); roll everything back on failure.
    const tx = new TxImpl(core, st, conditions, now);
    if (opts.entity) tx.entity(opts.entity.type, opts.entity.id);
    const auditUndos: Array<() => Promise<void>> = [];
    let undoChanges: (() => Promise<void>) | undefined;
    let result: T;
    try {
      result = await fn(tx);
      const seal = core.encrypted(st)
        ? (() => {
            const { key, keyId } = core.key(st);
            return (json: string) => sealLine(key, keyId, projectId, json);
          })()
        : undefined;
      // Unencrypted change logs of identifiable projects hold entity values in the clear (R19).
      const mode = !seal && cfg!.identifiability.containsIdentifiable ? 0o600 : undefined;
      undoChanges = await appendChanges(core.abs(`${st.rel}/changes`), tx.changes, seal, mode);
      for (const { req, d } of allowed) {
        const { undo } = await st.audit.append({
          ...core.auditBase(st, at),
          action: req.action,
          entity: tx.auditEntity,
          decision: auditDecision(d),
          details: { op, changes: tx.changes.length, ...(d.warnings.length ? { warnings: d.warnings } : {}) },
        });
        auditUndos.push(undo);
      }
    } catch (err) {
      for (const u of auditUndos.reverse()) await u().catch(() => {});
      await undoChanges?.().catch(() => {});
      await tx.rollback();
      throw err;
    }

    // 5. Committed.
    await core.updateAnchor(st, at);
    for (const h of tx.commitHooks) h();
    for (const t of tx.trashed) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
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
