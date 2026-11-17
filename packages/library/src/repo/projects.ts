/** Projects: creation, project.json persistence, key files, lock/unlock. */
import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  type AuditEvent,
  diffToChanges,
  effectivePolicy,
  evaluate,
  newId,
  parseGovernance,
  sanitizeSegment,
  withCollisionSuffix,
  type Project,
} from "@ao/core";
import { renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import {
  WrongPassphraseError,
  createRecoveryFile,
  generateProjectKey,
  normalizeRecoveryCode,
  unwrapKey,
  unwrapWithRecovery,
  wrapKey,
  type WrappedKey,
} from "../crypto/keys.js";
import { AuditStore } from "./audit-store.js";
import { appendLibraryRefusal } from "./library-audit.js";
import { appendChanges } from "./changelog-store.js";
import { GovernanceViolationError, InvalidInputError, KeyFileChangedError, PolicyDeniedError, RecoveryPendingError } from "./errors.js";
import { decryptBytes, foldName, namesIn, readMaybe, sealLine } from "./io.js";
import { CHANGE_LOG_MODE, runMutation, type Tx } from "./mutate.js";
import { SimulatedCrash, maybeCrash, seams } from "./seams.js";
import { lockPurges, type Manifest, type ProjectJson, type ProjectState, type RepoCore } from "./state.js";

export interface CreateProjectInput {
  name: string;
  governanceYaml: string;
  encryption: { enabled: boolean; passphrase?: string };
  targetLanguages?: string[];
}

/** `<Project>/keys/project-key.json`. The recovery code itself is never stored. */
export interface ProjectKeyFile {
  keyId: string;
  passphrase: WrappedKey;
  recovery: WrappedKey;
}

const KEY_FILE_MODE = 0o600;

/**
 * Records a refused project creation in the library's audit log (Task 50): who, what (the name
 * asked for, whether encrypted) and the rule's reason; never the passphrase. If it cannot be
 * written the refusal still stands, and the library warns (`refusal-unrecorded`, library-wide).
 * Repeats of the latest entry on the same day are counted, not appended (R154 a).
 */
async function recordCreateRefusal(core: RepoCore, at: string, name: string, encrypted: boolean, reason: string): Promise<void> {
  try {
    await appendLibraryRefusal(core, {
      at,
      actor: core.actor,
      device: core.device,
      action: "store",
      decision: { result: "deny", reason },
      details: { op: "project.create", name, encrypted },
    });
  } catch (err) {
    core.integrityWarnings.push({
      projectId: "*",
      kind: "refusal-unrecorded",
      detail: `a refused project creation could not be recorded in the library's audit log (${err instanceof Error ? err.name : "Error"})`,
    });
  }
}

/**
 * Creates `Projects/<name>/` with project.json, governance.yaml (verbatim),
 * keys/project-key.json (encrypted projects), audit/0001.jsonl and
 * changes/<YYYY-MM>.jsonl. Everything is written into a hidden staging folder
 * that is renamed into place last, so a failure leaves no half-made project.
 */
export async function createProject(
  core: RepoCore,
  input: CreateProjectInput,
): Promise<{ project: Project; recoveryCode?: string }> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    if (typeof input.name !== "string" || input.name.trim() === "") throw new TypeError("project name is required");
    const cfg = parseGovernance(input.governanceYaml);
    const { policy } = effectivePolicy(cfg);
    const enc = input.encryption;
    const now = core.clock();
    const at = now.toISOString();
    // A refusal has no project log to go to: it is recorded in the library's audit log (Task 50).
    const refuse = async (err: GovernanceViolationError | PolicyDeniedError): Promise<never> => {
      await recordCreateRefusal(core, at, input.name, enc.enabled === true, err.message);
      throw err;
    };
    if (!enc.enabled) {
      if (policy.identifiability.containsIdentifiable && policy.identifiability.pseudonymizeFileNames) {
        await refuse(
          new GovernanceViolationError(
            "This project contains identifiable data and pseudonymizes file names; the pseudonym map must be stored encrypted, so enable encryption for this project",
          ),
        );
      }
      if (policy.encryption.atRest === "required") {
        await refuse(new GovernanceViolationError("Governance requires encryption at rest; enable encryption for this project"));
      }
    } else if (typeof enc.passphrase !== "string" || enc.passphrase === "") {
      throw new TypeError("an encrypted project needs a passphrase");
    }

    const id = newId();
    const decision = evaluate(cfg, {
      action: "store",
      projectId: id,
      actor: core.actor,
      now: at,
      tz: core.zoneOf({}), // a new project has no time zone yet (R160)
      store: { identifiable: false, hasLocation: false },
    });
    if (decision.result === "deny") await refuse(new PolicyDeniedError(decision.reason, "store"));

    const projectsDir = join(core.root, "Projects");
    await fsp.mkdir(projectsDir, { recursive: true });
    const taken = await namesIn(projectsDir);
    // A leading dot would hide the folder (and mark it as staging), so prefix it.
    const base = sanitizeSegment(input.name).replace(/^\./, "_.");
    const folderName = withCollisionSuffix(base, (n) => taken.has(foldName(n)), { isFile: false });
    const rel = `Projects/${folderName}`;
    const staging = join(projectsDir, `.creating-${id}`);

    let keyMaterial: { key: Uint8Array; keyId: string } | undefined;
    let recoveryCode: string | undefined;
    try {
      await fsp.mkdir(join(staging, "Sources"), { recursive: true });
      await fsp.mkdir(join(staging, "keys"), { recursive: true });
      const project: Project = {
        id,
        name: input.name,
        folder: rel,
        createdAt: at,
        targetLanguages: input.targetLanguages ?? [],
        encryption: { enabled: enc.enabled },
      };
      if (enc.enabled) {
        keyMaterial = generateProjectKey();
        const wrapOpts = core.scryptN ? { N: core.scryptN } : {};
        const passphrase = await wrapKey(keyMaterial.key, enc.passphrase!, keyMaterial.keyId, wrapOpts);
        const recovery = await createRecoveryFile(keyMaterial.key, keyMaterial.keyId, wrapOpts);
        recoveryCode = recovery.recoveryCode;
        const keyFile: ProjectKeyFile = { keyId: keyMaterial.keyId, passphrase, recovery: recovery.file };
        await writeFileAtomic(join(staging, "keys", "project-key.json"), JSON.stringify(keyFile, null, 2), { mode: KEY_FILE_MODE });
        project.encryption.keyId = keyMaterial.keyId;
        const manifest: Manifest = { formatVersion: 1, sources: [] };
        await writeFileAtomic(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      } else {
        await fsp.rmdir(join(staging, "keys"));
      }
      const data: ProjectJson = { formatVersion: 1, project, collections: [], tags: [], participants: [], sessions: [], consents: [] };
      await writeFileAtomic(join(staging, "governance.yaml"), input.governanceYaml);
      await writeFileAtomic(join(staging, "project.json"), JSON.stringify(data, null, 2));

      const changes = diffToChanges(null, project, {
        at,
        author: core.actor,
        device: core.device,
        projectId: id,
        entity: { type: "project", id },
      });
      const seal = keyMaterial
        ? (json: string) => sealLine(keyMaterial!.key, keyMaterial!.keyId, id, json)
        : undefined;
      await appendChanges(join(staging, "changes"), changes, seal, seal ? undefined : CHANGE_LOG_MODE);
      const audit = new AuditStore(join(staging, "audit"), null, core.auditSegmentSize);
      await audit.append({
        at,
        actor: core.actor,
        device: core.device,
        projectId: id,
        action: "store",
        entity: { type: "project", id },
        decision: decision.result === "allow_with_conditions" ? { result: decision.result, conditions: decision.conditions } : { result: "allow" },
        details: { op: "project.create", encrypted: enc.enabled },
      });

      await renameWithRetry(staging, join(projectsDir, folderName));
      audit.dir = join(projectsDir, folderName, "audit");
      if (keyMaterial) core.keyRing.add(keyMaterial.keyId, keyMaterial.key);
      const st: ProjectState = { project, rel, data, audit, sources: new Map(), manifest: { formatVersion: 1, sources: [] } };
      core.projects.set(id, st);
      await core.updateAnchor(st, at);
      try {
        await core.index.indexProject(project);
      } catch (error) {
        core.indexErrors.push({ op: "project.create", error });
      }
      return recoveryCode ? { project, recoveryCode } : { project };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      keyMaterial?.key.fill(0);
    }
  });
}

async function readKeyFile(core: RepoCore, st: ProjectState): Promise<ProjectKeyFile> {
  const raw = await readMaybe(core.abs(`${st.rel}/keys/project-key.json`));
  if (!raw) throw new Error(`project ${st.project.id} has no key file`);
  return JSON.parse(raw.toString("utf8")) as ProjectKeyFile;
}

/** Unlocks with the passphrase or, failing that, the recovery code. */
export async function unlockProject(core: RepoCore, projectId: string, secret: string): Promise<void> {
  const st = core.state(projectId);
  if (!core.encrypted(st)) return;
  // Unlocking is audited; that append must wait until the interrupted write is resolved.
  if (st.recoveryPending && core.library.mode === "read-write") throw new RecoveryPendingError(projectId);
  const file = await readKeyFile(core, st);
  let key: Uint8Array;
  try {
    key = await unwrapKey(file.passphrase, secret);
  } catch (err) {
    if (!(err instanceof WrongPassphraseError)) throw err;
    try {
      normalizeRecoveryCode(secret);
    } catch {
      throw err;
    }
    key = await unwrapWithRecovery(file.recovery, secret);
  }
  try {
    // A lock asked before this unlock is done first: then the key is added again (R386 b).
    for (let p = core.pendingLocks.get(projectId); p; p = core.pendingLocks.get(projectId)) await p.catch(() => {});
    // An unlocked project's key is replaced only between turns of the write queue (R379); the same key again
    // changes nothing (KeyRing.add keeps the buffer a change may be sealing with).
    if (core.keyRing.has(file.keyId) && !core.queueIdle()) await core.serialNext(async () => core.keyRing.add(file.keyId, key));
    else core.keyRing.add(file.keyId, key);
  } finally {
    key.fill(0);
  }
  if (core.library.mode === "read-write") {
    await core.serial(async () => {
      const at = core.clock().toISOString();
      await core.auditNow(st, { ...core.auditBase(st, at), action: "key.unlock", entity: { type: "project", id: projectId } });
    });
  }
  try {
    await core.index.projectUnlocked?.(projectId);
  } catch (error) {
    core.indexErrors.push({ op: "project.unlock", error });
  }
}

/** The staged key file of a new recovery code (R141), beside the active one until it is activated. */
const STAGED_KEY_FILE = "keys/project-key.next.json";
/** Present while a new recovery code was activated on open and may never have been shown (R141 b). */
const UNSHOWN_FILE = "keys/recovery-code-unshown.json";
/** The project warning while UNSHOWN_FILE is present. */
export const RECOVERY_CODE_UNSHOWN_WARNING = "recovery-code-unshown";
const ISSUE_OP = "project.recovery-code";

/** `keys/project-key.next.json`: the key file to activate once issue `issueId` is committed. Wrapped keys only. */
interface StagedKeyFile {
  formatVersion: 1;
  issueId: string;
  keyFile: ProjectKeyFile;
}

/**
 * Issues a new recovery code for an unlocked encrypted project (Task 61, R134 c, R141). The researcher
 * gives the passphrase again; it is proved by unwrapping the stored passphrase wrapping (not only by
 * the key being in the key ring). The project key does not change: only the recovery wrapping is
 * replaced, so the old code stops working and the passphrase keeps working.
 *
 * Through the governed write path (`runMutation`): policy `store` of the project (as for its other
 * settings), then the new key file is STAGED as keys/project-key.next.json beside the active one, then
 * the allow audit event carrying this issue's id (the commit point, R26). Only after that is the staged
 * file made active (replacing keys/project-key.json atomically, then removing the staged file), still
 * inside the library's write queue. The active key file is never replaced before the commit point, so
 * an uncommitted change is invisible to every open, read-only included. A crash between the commit
 * and the end of activation is completed by the next writable open (`completeRecoveryActivation`),
 * which raises the project warning `recovery-code-unshown`. The code is returned only once it is
 * active, and is never stored, audited or logged.
 */
export async function issueRecoveryCode(core: RepoCore, projectId: string, passphrase: string): Promise<{ recoveryCode: string }> {
  core.assertWritable();
  const st = core.state(projectId);
  if (!core.encrypted(st)) throw new InvalidInputError("This project is not encrypted, so it has no recovery code");
  if (st.recoveryPending) throw new RecoveryPendingError(projectId);
  core.assertUnlocked(st);
  if (typeof passphrase !== "string" || passphrase === "") throw new InvalidInputError("Enter the project's passphrase");

  // The slow key derivations run outside the library's write queue; the file is checked unchanged inside it.
  const rel = `${st.rel}/keys/project-key.json`;
  const raw = await readMaybe(core.abs(rel));
  if (!raw) throw new Error("this project's key file is missing");
  const file = JSON.parse(raw.toString("utf8")) as ProjectKeyFile;
  const key = await unwrapKey(file.passphrase, passphrase); // WrongPassphraseError: nothing written
  let next: { recoveryCode: string; file: WrappedKey };
  try {
    const { key: ringKey, keyId } = core.key(st);
    // Compared in place (no copies of the key are made).
    const same = key.length === ringKey.length && timingSafeEqual(key, ringKey);
    if (file.keyId !== keyId || file.passphrase.keyId !== keyId || !same) {
      throw new Error("this project's key file does not hold the key the project is unlocked with");
    }
    next = await createRecoveryFile(key, keyId, core.scryptN ? { N: core.scryptN } : {});
  } finally {
    key.fill(0);
  }
  seams.onRecoveryCode?.(next.recoveryCode);
  const issueId = newId();
  const keyFile: ProjectKeyFile = { keyId: file.keyId, passphrase: file.passphrase, recovery: next.file };
  const staged: StagedKeyFile = { formatVersion: 1, issueId, keyFile };
  const stagedRel = `${st.rel}/${STAGED_KEY_FILE}`;
  const stagedBytes = JSON.stringify(staged, null, 2);
  const stagedSha256 = sha256Hex(stagedBytes);
  const unshownRel = `${st.rel}/${UNSHOWN_FILE}`;

  /** What stopped activation after the commit (a simulated crash in tests, or a real failure). */
  let activation: unknown = null;
  await runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const now = await readMaybe(core.abs(rel));
      if (!now || !now.equals(raw)) throw new KeyFileChangedError();
      maybeCrash("recovery-before-stage");
      // A staged file left by an earlier issue whose activation failed is superseded by this one.
      await tx.writeFile(stagedRel, stagedBytes, { mode: KEY_FILE_MODE });
      // A new code supersedes one that was activated on open and may not have been shown.
      if (await tx.exists(unshownRel)) await tx.trash(unshownRel);
      // Activation runs after the commit, still inside the write queue. `tx.index` is the only
      // asynchronous after-commit step mutate.ts offers; its failures never undo the commit.
      tx.index(async () => {
        try {
          maybeCrash("recovery-before-activate");
          await activateStaged(core, st, staged);
        } catch (err) {
          activation = err;
        }
      });
    },
    // The staged file's sha256 binds it to this event (R148): only these exact bytes are ever activated.
    { op: ISSUE_OP, entity: { type: "project", id: projectId }, auditDetails: { issueId, stagedSha256 } },
  );
  if (activation instanceof SimulatedCrash) throw activation; // tests: the process "died" here
  if (activation instanceof ActivationIncomplete) {
    // The new file is active but the staged one could not be removed (M-b): the new code works and
    // was not shown; the old one no longer works. The next writable open finishes it, with a warning.
    throw new Error("A new recovery code was put in place, but the app could not finish, so it could not be shown. The earlier recovery code no longer works; the passphrase still does. Ask for a new recovery code again");
  }
  if (activation !== null) {
    // Committed but not active: the old code still works, and this code would not. Asking again supersedes it.
    throw new Error("The new recovery code was recorded but could not be put in place, so it was not shown. The current recovery code still works. Ask for a new recovery code again");
  }
  maybeCrash("recovery-after-activate");
  return { recoveryCode: next.recoveryCode };
}

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The new key file is active, but a later step failed (M-b). */
class ActivationIncomplete extends Error {
  override name = "ActivationIncomplete";
}

/** Makes a staged key file active: the active file replaced atomically (0600), then the staged one removed. Idempotent. */
async function activateStaged(core: RepoCore, st: ProjectState, staged: StagedKeyFile): Promise<void> {
  await writeFileAtomic(core.abs(`${st.rel}/keys/project-key.json`), JSON.stringify(staged.keyFile, null, 2), { mode: KEY_FILE_MODE });
  maybeCrash("recovery-mid-activate");
  try {
    if (seams.failRecoveryCleanup) throw new Error("simulated failure removing the staged key file");
    await fsp.rm(core.abs(`${st.rel}/${STAGED_KEY_FILE}`), { force: true });
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    throw new ActivationIncomplete(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Writable open, for a project with no unresolved interrupted change (R141 b, R148). A staged key
 * file is activated only if ALL hold:
 *   1. its sha256 equals `stagedSha256` in the allow event of its issue;
 *   2. that event is the newest allowed issue of the project, and no `key.recovery-activated` event
 *      follows it;
 *   3. its key id and passphrase wrapping are identical to the active key file's;
 *   4. the audit chain verifies (`chainOk`).
 * Then the persistent warning that the code may never have been shown is raised (UNSHOWN_FILE, until
 * another code is issued), the active file is replaced and the completion audited. Otherwise the active
 * file is untouched: with a chain that verifies the staged file is not the committed one, so it is
 * removed and reported ('recovery-staging-discarded'); with a chain that does not verify nothing can
 * be decided, so it is left in place and reported ('recovery-staging-unverifiable'). The replaced
 * active file is never kept aside: that would keep a revoked code usable. Throws when the audit
 * append fails (the caller blocks the project, R28); the activation and warning are then already done.
 */
export async function completeRecoveryActivation(
  core: RepoCore,
  st: ProjectState,
  events: ReadonlyArray<AuditEvent | null>,
  chainOk: boolean,
  at: string,
): Promise<void> {
  const stagedAbs = core.abs(`${st.rel}/${STAGED_KEY_FILE}`);
  const raw = await readMaybe(stagedAbs);
  if (!raw) return;
  const report = (kind: "recovery-staging-discarded" | "recovery-staging-unverifiable", detail: string) =>
    core.integrityWarnings.push({ projectId: st.project.id, kind, detail });
  if (!chainOk) {
    report("recovery-staging-unverifiable", "a new recovery code waiting to be put in place was left as it is, because the project's audit log does not verify, so it cannot show whether that code was really issued; the current recovery code is unchanged");
    return;
  }
  const why = await stagedProblem(core, st, raw, events);
  if (why) {
    await fsp.rm(stagedAbs, { force: true });
    report("recovery-staging-discarded", `a key file waiting to be put in place was removed and not used (${why}); the current recovery code and passphrase are unchanged`);
    return;
  }
  const staged = JSON.parse(raw.toString("utf8")) as StagedKeyFile;
  await writeFileAtomic(core.abs(`${st.rel}/${UNSHOWN_FILE}`), JSON.stringify({ formatVersion: 1, issueId: staged.issueId, activatedAt: at }), { mode: KEY_FILE_MODE });
  await writeFileAtomic(core.abs(`${st.rel}/keys/project-key.json`), JSON.stringify(staged.keyFile, null, 2), { mode: KEY_FILE_MODE });
  await core.auditNow(st, {
    ...core.auditBase(st, at),
    action: "key.recovery-activated",
    entity: { type: "project", id: st.project.id },
    details: { issueId: staged.issueId, reason: "a new recovery code was issued, but the app stopped before it could be shown; it was put in place when the library was next opened" },
  });
  await fsp.rm(stagedAbs, { force: true });
}

/** Why a staged key file is not the committed one (R148 conditions 1–3), or null when it is. */
async function stagedProblem(core: RepoCore, st: ProjectState, raw: Buffer, events: ReadonlyArray<AuditEvent | null>): Promise<string | null> {
  let staged: StagedKeyFile;
  try {
    staged = JSON.parse(raw.toString("utf8")) as StagedKeyFile;
  } catch {
    return "it could not be read";
  }
  if (staged?.formatVersion !== 1 || typeof staged.issueId !== "string" || typeof staged.keyFile !== "object" || staged.keyFile === null) return "it is not in the expected form";
  // 2. The newest allowed issue, with no activation recorded after it.
  let newest = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const d = e?.details as { op?: unknown } | undefined;
    if (e && e.decision?.result !== "deny" && d?.op === ISSUE_OP) newest = i;
  }
  if (newest < 0) return "no new recovery code was recorded as issued";
  const issue = events[newest]!.details as { issueId?: unknown; stagedSha256?: unknown };
  if (issue.issueId !== staged.issueId) return "it belongs to an earlier new recovery code, not the latest one recorded";
  if (events.slice(newest + 1).some((e) => e?.action === "key.recovery-activated")) return "the latest new recovery code was already put in place";
  // 1. Exactly the bytes recorded with the issue.
  if (typeof issue.stagedSha256 !== "string" || issue.stagedSha256 !== sha256Hex(raw)) return "its content is not what was recorded when the code was issued";
  // 3. Same key, same passphrase wrapping as the active file.
  const activeRaw = await readMaybe(core.abs(`${st.rel}/keys/project-key.json`));
  let active: ProjectKeyFile | undefined;
  try {
    active = activeRaw ? (JSON.parse(activeRaw.toString("utf8")) as ProjectKeyFile) : undefined;
  } catch {
    active = undefined;
  }
  if (!active) return "the project's key file could not be read";
  if (staged.keyFile.keyId !== active.keyId || staged.keyFile.keyId !== st.project.encryption.keyId) return "it is for another key";
  if (!isDeepStrictEqual(staged.keyFile.passphrase, active.passphrase)) return "its passphrase wrapping differs from the project's";
  return null;
}

/** Whether the project carries the warning that a new recovery code may never have been shown (R141 b). */
export async function recoveryCodeUnshown(core: RepoCore, st: ProjectState): Promise<boolean> {
  return core.encrypted(st) && (await readMaybe(core.abs(`${st.rel}/${UNSHOWN_FILE}`))) !== null;
}

/**
 * Locks the project: its in-memory content (index, kept registers and queues) is dropped and its key zeroed in the
 * key ring. R379: the key is wiped only between turns of the write queue, never under a change being saved: at once
 * when no write is running, else as the next turn (after the change in progress, ahead of those waiting, which then
 * find the project locked). R386 b: locking is immediate for everyone but that change: before this returns, the
 * project counts as locked for every read and every new change (the key ring answers only the turn running now);
 * the returned promise settles when the key is wiped. An unknown project is a rejected promise, never a throw.
 */
export function lockProject(core: RepoCore, projectId: string): Promise<void> {
  let st: ProjectState;
  try {
    st = core.state(projectId);
  } catch (err) {
    return Promise.reject(err);
  }
  const pending = core.pendingLocks.get(projectId);
  if (pending) return pending;
  const keyId = st.project.encryption.keyId;
  const purge = () => {
    // A failure must not keep the project unlocked.
    try {
      core.index.purgeProject?.(projectId);
    } catch (error) {
      core.indexErrors.push({ op: "project.lock", error });
    }
    for (const p of lockPurges) {
      try {
        p(core, st);
      } catch (error) {
        core.indexErrors.push({ op: "project.lock", error });
      }
    }
  };
  const lock = () => {
    purge();
    if (keyId) core.keyRing.remove(keyId);
  };
  if (core.queueIdle()) {
    lock();
    return Promise.resolve();
  }
  // Locked for everyone at once but the turn running now, which may still be sealing with the key.
  if (keyId) core.keyRing.markLocking(keyId, core.admitsOnlyRunningTurn());
  purge();
  const done = core.serialNext(async () => lock()).finally(() => core.pendingLocks.delete(projectId));
  core.pendingLocks.set(projectId, done);
  return done;
}

export function isUnlocked(core: RepoCore, projectId: string): boolean {
  const st = core.state(projectId);
  return !core.encrypted(st) || core.keyRing.has(st.project.encryption.keyId ?? "");
}

// ---- project.json and fieldwork secrets ------------------------------------------------

/** `<Project>/fieldwork.json.enc` (encrypted projects): identifying fieldwork fields. */
interface FieldworkSecrets {
  formatVersion: 1;
  participants: Record<string, Record<string, string>>;
  sessions: Record<string, { place?: string; notes?: string }>;
  /** Withdrawal reasons of consent records (R117). */
  consents?: Record<string, { withdrawnReason?: string }>;
}

async function readSecrets(core: RepoCore, st: ProjectState): Promise<FieldworkSecrets> {
  const raw = await readMaybe(core.abs(`${st.rel}/fieldwork.json.enc`));
  if (!raw) return { formatVersion: 1, participants: {}, sessions: {} };
  const { key, keyId } = core.key(st);
  const plain = await decryptBytes((id) => (id === keyId ? key : undefined), raw);
  return JSON.parse(plain.toString("utf8")) as FieldworkSecrets;
}

/**
 * The full project data, with identifying fieldwork fields merged back from
 * fieldwork.json.enc when the project is encrypted. When `allowLocked` and the
 * project is locked, those fields are left out instead of throwing.
 */
export async function readFullData(core: RepoCore, st: ProjectState, allowLocked = false): Promise<ProjectJson> {
  const data = structuredClone(st.data);
  if (!core.encrypted(st)) return data;
  if (allowLocked && !isUnlocked(core, st.project.id)) return data;
  const secrets = await readSecrets(core, st);
  for (const p of data.participants) {
    const d = secrets.participants[p.id];
    if (d) p.details = d;
  }
  for (const s of data.sessions) Object.assign(s, secrets.sessions[s.id] ?? {});
  for (const c of data.consents) {
    const r = secrets.consents?.[c.id]?.withdrawnReason;
    if (r && c.withdrawn) c.withdrawn.reason = r;
  }
  return data;
}

/**
 * Writes project.json. In encrypted projects, participant details and session
 * place/notes go to fieldwork.json.enc and never into project.json. Unencrypted
 * project.json holding participant details or session place/notes is written 0600 (R19).
 */
export async function writeProjectData(core: RepoCore, tx: Tx, full: ProjectJson): Promise<void> {
  const st = tx.state;
  const plain = structuredClone(full);
  if (core.encrypted(st)) {
    const secrets: FieldworkSecrets = { formatVersion: 1, participants: {}, sessions: {}, consents: {} };
    for (const c of plain.consents) {
      if (c.withdrawn?.reason) secrets.consents![c.id] = { withdrawnReason: c.withdrawn.reason };
      if (c.withdrawn) delete c.withdrawn.reason;
    }
    for (const p of plain.participants) {
      if (p.details) secrets.participants[p.id] = p.details;
      delete p.details;
    }
    for (const s of plain.sessions) {
      const sec: { place?: string; notes?: string } = {};
      if (s.place !== undefined) sec.place = s.place;
      if (s.notes !== undefined) sec.notes = s.notes;
      if (Object.keys(sec).length) secrets.sessions[s.id] = sec;
      delete s.place;
      delete s.notes;
    }
    const hasSecrets = Object.keys(secrets.participants).length + Object.keys(secrets.sessions).length + Object.keys(secrets.consents!).length > 0;
    if (hasSecrets || (await tx.exists(`${st.rel}/fieldwork.json.enc`))) {
      await tx.writeFile(`${st.rel}/fieldwork.json.enc`, JSON.stringify(secrets), { encrypt: true });
    }
  }
  const identifying =
    !core.encrypted(st) &&
    (plain.participants.some((p) => p.details && Object.keys(p.details).length > 0) ||
      plain.sessions.some((s) => !!s.place?.trim() || !!s.notes?.trim()) ||
      plain.consents.some((c) => !!c.withdrawn?.reason));
  await tx.writeFile(`${st.rel}/project.json`, JSON.stringify(plain, null, 2), identifying ? { mode: 0o600 } : {});
  tx.onCommit(() => {
    st.data = plain;
  });
}
