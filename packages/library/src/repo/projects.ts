/** Projects: creation, project.json persistence, key files, lock/unlock. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
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
import { appendChanges } from "./changelog-store.js";
import { GovernanceViolationError, InvalidInputError, PolicyDeniedError, RecoveryPendingError } from "./errors.js";
import { decryptBytes, foldName, namesIn, readMaybe, sealLine } from "./io.js";
import { CHANGE_LOG_MODE, runMutation, type Tx } from "./mutate.js";
import { seams } from "./seams.js";
import type { Manifest, ProjectJson, ProjectState, RepoCore } from "./state.js";

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
    if (!enc.enabled) {
      if (policy.identifiability.containsIdentifiable && policy.identifiability.pseudonymizeFileNames) {
        throw new GovernanceViolationError(
          "This project contains identifiable data and pseudonymizes file names; the pseudonym map must be stored encrypted, so enable encryption for this project",
        );
      }
      if (policy.encryption.atRest === "required") {
        throw new GovernanceViolationError("Governance requires encryption at rest; enable encryption for this project");
      }
    } else if (typeof enc.passphrase !== "string" || enc.passphrase === "") {
      throw new TypeError("an encrypted project needs a passphrase");
    }

    const id = newId();
    const now = core.clock();
    const at = now.toISOString();
    const decision = evaluate(cfg, {
      action: "store",
      projectId: id,
      actor: core.actor,
      now: at,
      tz: core.tz,
      store: { identifiable: false, hasLocation: false },
    });
    // Not audited: the project and its audit log do not exist yet, and nothing has been written.
    if (decision.result === "deny") throw new PolicyDeniedError(decision.reason, "store");

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
    core.keyRing.add(file.keyId, key);
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

/**
 * Issues a new recovery code for an unlocked encrypted project (Task 61, R134 c). The researcher
 * gives the passphrase again; it is proved by unwrapping the stored passphrase wrapping (not only by
 * the key being in the key ring). The project key does not change: only the recovery wrapping in
 * keys/project-key.json is replaced, so the old code stops working and the passphrase keeps working.
 *
 * Written through the governed write path (`runMutation`): policy `store` of the project (as for
 * other project settings: governance, backup settings), the key file replaced atomically with its old
 * bytes kept aside by the write-ahead marker, then the allow audit event (the commit point, R26). A
 * crash before that event rolls back to the old file (old code valid); after it, the new file is kept
 * (new code valid, possibly never shown: issuing again is safe). The code is returned only after the
 * commit and is never stored, audited or logged.
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
    if (file.keyId !== keyId || file.passphrase.keyId !== keyId || !Buffer.from(key).equals(Buffer.from(ringKey))) {
      throw new Error("this project's key file does not hold the key the project is unlocked with");
    }
    next = await createRecoveryFile(key, keyId, core.scryptN ? { N: core.scryptN } : {});
  } finally {
    key.fill(0);
  }
  seams.onRecoveryCode?.(next.recoveryCode);
  const keyFile: ProjectKeyFile = { keyId: file.keyId, passphrase: file.passphrase, recovery: next.file };

  await runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const now = await readMaybe(core.abs(rel));
      if (!now || !now.equals(raw)) throw new Error("the project's key file changed meanwhile; ask for a new recovery code again");
      await tx.writeFile(rel, JSON.stringify(keyFile, null, 2), { mode: KEY_FILE_MODE });
    },
    { op: "project.recovery-code", entity: { type: "project", id: projectId } },
  );
  return { recoveryCode: next.recoveryCode };
}

export function lockProject(core: RepoCore, projectId: string): void {
  const keyId = core.state(projectId).project.encryption.keyId;
  // Drop the project's in-memory index content first; a failure must not keep the project unlocked.
  try {
    core.index.purgeProject?.(projectId);
  } catch (error) {
    core.indexErrors.push({ op: "project.lock", error });
  }
  if (keyId) core.keyRing.remove(keyId);
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
