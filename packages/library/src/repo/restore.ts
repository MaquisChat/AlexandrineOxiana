/**
 * Restoring a project backup (spec 9, R90 b), the part inside the repository: a backup already
 * unpacked (and checked against the archive limits) into a staging folder `Projects/.creating-<id>`
 * becomes a NEW project, never replacing one:
 *
 *   1. its audit chain must verify (and match the head the backup recorded, when it did);
 *   1b. the policy engine decides, in this turn (R138 c), against the rules that would go live with
 *      the copy (the `governance.yaml` unpacked from the backup), the rules the project the backup
 *      was made from has now when it is in this library, and where the library is
 *      (`decideRestore`): a refusal is audited and nothing is restored. The same decision was made
 *      before anything was unpacked (`authorizeRestoreIn`);
 *   2. everything the library indexes by id gets a fresh id (the project, its sources, assets,
 *      annotations, collections, project tags, participants, sessions and consents), so the copy
 *      never collides with the project it was made from (the registry stays unique); library-relative
 *      paths move to the new folder `Projects/<name> (restored <YYYY-MM-DD>)`. Ids and paths are
 *      rewritten in every JSON file and JSON-lines record (sealed ones are opened and sealed again
 *      for the new project id); provenance is never touched (R76). Workspace tags keep their ids.
 *      The audit log and everything in `retention/` (destruction certificates and their amendments)
 *      are evidence and are copied byte for byte (R147): the copy's audit log vouches for them;
 *   3. a `project.restored` event naming the backup's sha256 is appended to the copy's audit log;
 *   An encrypted copy keeps the data key, and key id, of the project it was made from (the
 *   backup is sealed with it): unlocking either project unlocks both. The restore itself unlocks
 *   nothing (I1): a key derived from a passphrase comes in as `StagedRestore.key`, is used here and
 *   never put in the key ring, and the copy is then locked. Files a destruction recorded
 *   in this library destroyed are not brought back (marked destroyed, R92): which files is read in
 *   this turn from the audit logs (R174 d; the caller's reader, `StagedRestore.destroyed`). A
 *   certificate file a verified audit log does not record counts for nothing; what can still be
 *   read of the log and the certificate files of a project whose audit log does not verify, or
 *   whose folder could not be loaded, still excludes what it names (R179; fix round 1);
 *   ids of import batches, review entries and pending jobs are new too, and so are the keys of
 *   provenance.fileHashes and its importBatchId (the one exception to R76, restore only);
 *   3b. the copy is anchored (R12) before it goes live, so a crash after the rename is no "missing anchor";
 *   3c. what the copy inherits as still to be done is noted last before it goes live
 *      (`StagedRestore.beforeLive`: the backups a destruction still lists, R175), and taken back if
 *      the rename fails, so the copy never exists without its warning;
 *   4. the staging folder is renamed into place (the commit point: a crash before it leaves only a
 *      staging folder, which the next open removes), the project is loaded and anchored (R12).
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  evaluate,
  newId,
  parseGovernance,
  sanitizeSegment,
  verifyChain,
  withCollisionSuffix,
  type AuditEvent,
  type PolicyDecision,
  type PolicyRequest,
  type Project,
} from "@ao/core";
import { scrubPaths } from "../app-settings.js";
import { renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { AuditStore } from "./audit-store.js";
import { PolicyDeniedError } from "./errors.js";
import { decryptBytes, encryptBytes, foldName, namesIn, openLine, readMaybe, sealLine } from "./io.js";
import { appendLibraryRefusal } from "./library-audit.js";
import { loadProjectFolder, parseProjectJson, type Manifest, type ProjectState, type RepoCore } from "./state.js";
import { listSourceIds, readSourceFile } from "./sources.js";

/** The backup's audit log does not verify (or differs from what the backup recorded). Nothing was restored. */
export class AuditChainInvalidError extends Error {
  constructor(detail: string) {
    super(`The backup's audit log does not verify (${detail}); it was not restored`);
    this.name = "AuditChainInvalidError";
  }
}

/** The backup cannot be restored for another reason (plain message, no paths). */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

/**
 * The file is not a backup this app can read: not a backup at all, damaged, or changed since it was
 * made. Refused, and the refusal is recorded in the library's own audit log (R179). A plain message,
 * no paths.
 */
export class UnreadableBackupError extends RestoreError {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableBackupError";
  }
}

/**
 * What the project a backup belongs to destroyed under a retention rule cannot be read with
 * certainty (its audit log does not hold together, or records a destruction that does not say which
 * files), so the backup is not restored into this library: the app does not guess (R174 d, R179).
 * A plain message that names the way out, no paths.
 */
export class DestructionRecordError extends RestoreError {
  constructor(
    message: string,
    /** The project whose audit log or record it is. */
    readonly projectId: string,
    /** That project's audit log itself does not hold together (the refusal is never recorded in it). */
    readonly logNotIntact: boolean,
  ) {
    super(message);
    this.name = "DestructionRecordError";
  }
}

const SEALED_PURPOSES = ["ao-changes", "ao-review", "ao-import-journal"];

/** Every kind of storage the library's folder may be on, as the policy engine is asked (as for a backup, R125). */
export type RestoreDestinations = NonNullable<PolicyRequest["restore"]>["destinations"];

/** What a restore is decided on: the backup's own project and rules, and where the library is. Never a path. */
export interface RestoreRequest {
  /** The project as the backup's project.json describes it. */
  project: { id: string; name: string; encrypted: boolean; timeZone?: string };
  /** `governance.yaml` as the backup holds it: the rules the new project would have. Null: it holds none. */
  governanceYaml: string | null;
  /** The backup file is sealed with a project key. */
  sealed: boolean;
  destinations: RestoreDestinations;
  backupSha256: string;
  /** The backup's file name, when it is one of this library's backups (a name, never a path). */
  file?: string;
}

/** One source of knowledge about files destroyed in this library: a destruction, or what stands in for one. */
export interface DestroyedSource {
  /** The project whose record it is (empty for a folder that could not be loaded as a project). */
  projectId: string;
  /**
   * `recorded`: a destruction that project's verified audit log records.
   * `unverified`: what can still be read of an audit log that does not verify, or of the log of a
   * folder that could not be loaded, and certificate files taken as they are on disk: nothing
   * vouches for it (R179; fix round 1, rulings 2 and 3). Unverified evidence still excludes,
   * whatever its form: it errs towards not bringing data back.
   * `unrecorded`: a certificate file a verified audit log does not record. It counts for nothing.
   */
  basis: "recorded" | "unverified" | "unrecorded";
  /** Asset id (in the project the data was destroyed in) → when it was destroyed. */
  byId: ReadonlyMap<string, string>;
  /** sha256 of a destroyed file → when. */
  bySha256: ReadonlyMap<string, string>;
  /**
   * A sentence for the restore's notes, given how many files of the backup this source left out
   * (for `unrecorded`: how many it names that the restore brought back). Undefined: it has no
   * bearing on this restore, and nothing is said.
   */
  note?: (files: number) => string | undefined;
  /** What the restore's audit entry says of this source, when it is not a verified record. */
  audit?: (leftOut: number) => Record<string, unknown>;
  /**
   * The project is locked and its destruction certificates are sealed: what it destroyed is known
   * by id from its audit log, but the certificates' list of sha256 could not be read (the restore
   * unlocks nothing, I1). Said in the notes, and named in the restore's audit entry.
   */
  sealed?: true;
}

/** What the destructions on record in this library say a restore must not bring back (R174 d, R179). */
export interface DestroyedRecord {
  sources: readonly DestroyedSource[];
}

export interface StagedRestore {
  /** Absolute staging folder (`<Library>/Projects/.creating-<id>`). */
  staging: string;
  /** sha256 of the backup file, recorded in the project.restored event. */
  backupSha256: string;
  /** The audit head the backup recorded (backup.json), if any. */
  expectedHead?: { seq: number; hash: string } | null;
  /** Local date (YYYY-MM-DD) for the folder name. */
  date: string;
  /** The backup file is sealed. */
  sealed: boolean;
  /** Where the library is, as it was decided on before anything was unpacked: asked again in the commit turn. */
  destinations: RestoreDestinations;
  /** The backup's file name, when it is one of this library's backups. */
  file?: string;
  /**
   * The project key derived from a passphrase for this restore alone (I1): used here to read and
   * seal the copy's files, and never put in the key ring. Absent: the key ring holds the key (the
   * project is unlocked), or the project is not encrypted.
   */
  key?: { keyId: string; key: Uint8Array };
  /**
   * What the destructions on record say must not come back, read in the commit turn (it must not
   * take the write queue), given the id of the project the backup belongs to. Throws
   * DestructionRecordError when that project's own record cannot be read with certainty.
   */
  destroyed: (ownProjectId: string) => Promise<DestroyedRecord>;
  /**
   * Called in the commit turn, last before the copy goes live, with the audit events it starts
   * with: notes what the copy inherits (the warnings that then stand for it), and returns how to
   * take that back should the copy not go live after all. It must not take the write queue.
   */
  beforeLive?: (copy: { projectId: string; folder: string; events: AuditEvent[] }) => Promise<{ warnings: string[]; undo: () => Promise<void> }>;
}

// ------------------------------------------------------------------------------------------
// The decision (Task 50b)

/** Rules that require encryption at rest, for a project that is not encrypted: it would come back unencrypted. */
export const RESTORE_NEEDS_ENCRYPTION = "The rules of the project in this backup require encryption at rest, but the project in it is not encrypted; it was not restored";
/** The same, by the rules the project the backup was made from has now: which rule, and the two ways out (R179). */
export const RESTORE_NEEDS_ENCRYPTION_NOW =
  "The rules the original project has now require encryption at rest, but the project in this backup is not encrypted. Restore the backup into another library, or change that rule in the original project's rules.";
/** The original project's rules cannot be read: the two ways out (R179). */
const REPAIR_OR_ELSEWHERE = "Repair that project's rules in the governance editor, or restore this backup into another library.";
/** A sealed archive whose project is not an encrypted one: unpacking it would write its files unencrypted. */
export const RESTORE_SEALED_BUT_PLAIN = "This backup is sealed, but the project in it is not an encrypted one, so it would come back unencrypted; it was not restored";

const denyOf = (reason: string, warnings: string[] = []): PolicyDecision => ({ result: "deny", reason, warnings });
/** The longest text of a parse error kept in a refusal's reason. */
const REASON_MAX = 600;

/**
 * One set of rules asked about a restore: the engine's decision (`action: 'restore'`), with a
 * condition the project in the backup cannot honour turned into a deny, as for every governed
 * write. Rules that are missing or cannot be parsed, and any failure to decide, are a deny.
 */
function askRules(core: RepoCore, r: RestoreRequest, at: string, yaml: string | null, rules: "backup" | "original", zone: { timeZone?: string | undefined }): PolicyDecision {
  let d: PolicyDecision;
  try {
    if (yaml === null) throw new Error(rules === "backup" ? "the backup holds no governance.yaml" : "its governance.yaml is missing");
    d = evaluate(parseGovernance(yaml), {
      action: "restore",
      projectId: r.project.id,
      actor: core.actor,
      now: at,
      tz: core.zoneOf(zone),
      restore: { destinations: r.destinations, rules },
    });
  } catch (e) {
    // The text may come from a file brought from outside (the backup's rules): scrubbed of paths,
    // and kept short, before it becomes a recorded reason.
    const why = scrubPaths(e instanceof Error ? e.message : String(e), [core.root]);
    const short = why.length > REASON_MAX ? `${why.slice(0, REASON_MAX)}…` : why;
    // Which rules could not be read; for the original's, what can be done about it (R179).
    return denyOf(
      rules === "original"
        ? `Policy could not be evaluated: the rules the original project has now cannot be read (${short}). ${REPAIR_OR_ELSEWHERE}`
        : `Policy could not be evaluated: the rules in this backup cannot be read (${short}).`,
    );
  }
  if (d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "encrypt") && !r.project.encrypted) {
    return denyOf(rules === "backup" ? RESTORE_NEEDS_ENCRYPTION : RESTORE_NEEDS_ENCRYPTION_NOW, d.warnings);
  }
  return d;
}

/**
 * The policy decision for a restore (Task 50b). Two sets of rules are asked, and both must allow it:
 *   - the rules the backup carries, which become the new project's;
 *   - the rules the project the backup was made from has now, when that project is in this library
 *     (read here, so in the commit turn they are the governance then in force, R138 c).
 * Each is asked the same thing: every kind of storage the library's folder may be on must be
 * allowed, and rules that require encryption at rest need the project in the backup to be an
 * encrypted one. A sealed archive whose project is not encrypted is refused as well. Never throws:
 * rules that are missing or cannot be read, and any failure to decide, are a deny (fail closed).
 * Caller holds the write queue.
 */
export async function decideRestore(core: RepoCore, r: RestoreRequest, at: string): Promise<PolicyDecision> {
  const own = askRules(core, r, at, r.governanceYaml, "backup", r.project);
  if (own.result === "deny") return own;
  if (r.sealed && !r.project.encrypted) return denyOf(RESTORE_SEALED_BUT_PLAIN, own.warnings);
  const st = core.projects.get(r.project.id);
  if (!st) return own;
  let yaml: string | null;
  try {
    const raw = await readMaybe(core.abs(`${st.rel}/governance.yaml`));
    yaml = raw ? raw.toString("utf8") : null;
  } catch (e) {
    return denyOf(
      `Policy could not be evaluated: the rules the original project has now cannot be read (${scrubPaths(e instanceof Error ? e.message : String(e), [core.root])}). ${REPAIR_OR_ELSEWHERE}`,
      own.warnings,
    );
  }
  const now = askRules(core, r, at, yaml, "original", st.project);
  const warnings = [...new Set([...own.warnings, ...now.warnings])];
  if (now.result === "deny") return denyOf(now.reason, warnings);
  // Both allow: every condition of either stands (only `encrypt` can be given).
  const conditions = [...(own.result === "allow_with_conditions" ? own.conditions : []), ...(now.result === "allow_with_conditions" ? now.conditions : [])].filter(
    (c, i, all) => all.findIndex((x) => x.type === c.type) === i,
  );
  return conditions.length ? { result: "allow_with_conditions", conditions, warnings } : { result: "allow", warnings };
}

/** Whether the project's audit log, read now, verifies and ends at the head this process holds. Caller holds the write queue. */
async function logHoldsTogether(st: ProjectState): Promise<boolean> {
  try {
    const verify = verifyChain((await AuditStore.read(st.audit.dir)) as AuditEvent[]);
    const head = st.audit.head;
    return verify.ok && (verify.head?.seq ?? 0) === (head?.seq ?? 0) && (verify.head?.hash ?? "") === (head?.hash ?? "");
  } catch {
    return false;
  }
}

/**
 * Audits a refused restore (never silent, R154): in the log of the project the backup belongs to,
 * when that project is in this library and its log is intact and takes it; otherwise in the
 * library's own log (where the same refusal is listed once a day, R157). "Intact" is checked here,
 * by reading the log (fix round 1, M4): a log changed outside the app while it runs is never
 * appended to. The library's entry says why the project's log did not take it:
 * `projectLogNotIntact` (it does not verify), or `projectLogNotWritable` (an interrupted write is
 * pending, or the append failed). If neither log can be written the refusal still stands and the
 * library warns (`refusal-unrecorded`). The backup is named by its sha256, and by its file name
 * only when it is one of this library's backups: never a path. Caller holds the write queue.
 */
export async function recordRestoreRefusal(
  core: RepoCore,
  r: RestoreRequest,
  reason: string,
  stage: "decision" | "commit",
  opts: { warnings?: string[]; logNotIntact?: string } = {},
): Promise<void> {
  const at = core.clock().toISOString();
  const what = { op: "project.restore", backupSha256: r.backupSha256, ...(r.file ? { file: r.file } : {}), at: stage };
  const st = core.projects.get(r.project.id);
  /** Why the project's own log does not take the entry (undefined: there is no such project here). */
  let notTaken: "projectLogNotIntact" | "projectLogNotWritable" | undefined;
  if (st) {
    if (st.auditUnverified === true || opts.logNotIntact === st.project.id || !(await logHoldsTogether(st))) notTaken = "projectLogNotIntact";
    else if (st.recoveryPending === true) notTaken = "projectLogNotWritable";
    else {
      try {
        await core.auditNow(st, {
          ...core.auditBase(st, at),
          action: "restore",
          entity: { type: "project", id: st.project.id },
          decision: { result: "deny", reason },
          details: { ...what, ...(opts.warnings?.length ? { warnings: opts.warnings } : {}) },
        });
        return;
      } catch {
        // the library's own log takes it
        notTaken = "projectLogNotWritable";
      }
    }
  }
  try {
    await appendLibraryRefusal(core, {
      at,
      actor: core.actor,
      device: core.device,
      ...(st ? { projectId: st.project.id } : {}),
      action: "restore",
      decision: { result: "deny", reason },
      details: { ...what, name: r.project.name, encrypted: r.project.encrypted, ...(notTaken ? { [notTaken]: true } : {}) },
    });
  } catch (err) {
    core.integrityWarnings.push({
      projectId: "*",
      kind: "refusal-unrecorded",
      detail: `a refused restore could not be recorded in the library's audit log (${err instanceof Error ? err.name : "Error"})`,
    });
  }
}

/**
 * Before anything of a backup is unpacked: the decision. A deny is audited and thrown as
 * PolicyDeniedError; nothing has been written.
 */
export async function authorizeRestoreIn(core: RepoCore, r: RestoreRequest): Promise<PolicyDecision> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const d = await decideRestore(core, r, core.clock().toISOString());
    if (d.result === "deny") {
      await recordRestoreRefusal(core, r, d.reason, "decision", { warnings: d.warnings });
      throw new PolicyDeniedError(d.reason, "restore");
    }
    return d;
  });
}

/**
 * Audits the refusal of a file that is not a readable backup (R179; never silent, R154): in the
 * library's own audit log, because such a file is no backup of any project here. The entry holds
 * the file's base name (never a path), its sha256 and what that covers (the whole file; or nothing,
 * when the file could not be read at all), and the plain reason. The same refusal is listed once a
 * day (R157). If the entry cannot be written the refusal stands and the library warns.
 */
export function recordUnreadableBackup(core: RepoCore, f: { file: string; sha256?: string; reason: string }): Promise<void> {
  return core.serial(async () => {
    try {
      await appendLibraryRefusal(core, {
        at: core.clock().toISOString(),
        actor: core.actor,
        device: core.device,
        action: "restore",
        decision: { result: "deny", reason: f.reason },
        details: {
          op: "project.restore",
          notABackup: true,
          file: f.file,
          ...(f.sha256 ? { backupSha256: f.sha256, sha256Covers: "the whole file" } : { sha256Covers: "nothing: the file could not be read" }),
        },
      });
    } catch (err) {
      core.integrityWarnings.push({
        projectId: "*",
        kind: "refusal-unrecorded",
        detail: `a refused restore could not be recorded in the library's audit log (${err instanceof Error ? err.name : "Error"})`,
      });
    }
  });
}

/** Before anything is unpacked: a refusal because the record of destructions cannot be read, audited like a deny. */
export function refuseRestoreIn(core: RepoCore, r: RestoreRequest, err: DestructionRecordError): Promise<void> {
  return core.serial(() => recordRestoreRefusal(core, r, err.message, "decision", err.logNotIntact ? { logNotIntact: err.projectId } : {}));
}

type Json = unknown;

/** Deep copy with ids mapped and library-relative paths moved; `provenance` is left as it is. */
function rewrite(v: Json, ids: ReadonlyMap<string, string>, oldRel: string, newRel: string): Json {
  if (typeof v === "string") {
    const id = ids.get(v);
    if (id) return id;
    if (v === oldRel) return newRel;
    if (v.startsWith(`${oldRel}/`)) return newRel + v.slice(oldRel.length);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => rewrite(x, ids, oldRel, newRel));
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, Json>)) {
      out[ids.get(k) ?? k] = k === "provenance" ? provenanceOf(x, ids) : rewrite(x, ids, oldRel, newRel);
    }
    return out;
  }
  return v;
}

/**
 * Provenance never changes (R76), with one documented exception for a restore (R92): its
 * `fileHashes` are keyed by asset id and the import batch is named by id, and both ids are new in
 * the copy — so those keys and `importBatchId` follow; the hashes and everything else stay as captured.
 */
function provenanceOf(v: Json, ids: ReadonlyMap<string, string>): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const p = { ...(v as Record<string, Json>) };
  if (p.fileHashes && typeof p.fileHashes === "object" && !Array.isArray(p.fileHashes)) {
    p.fileHashes = Object.fromEntries(Object.entries(p.fileHashes as Record<string, Json>).map(([k, h]) => [ids.get(k) ?? k, h]));
  }
  if (typeof p.importBatchId === "string" && ids.has(p.importBatchId)) p.importBatchId = ids.get(p.importBatchId)!;
  return p;
}

/**
 * The audit log may span earlier restores: each `project.restored` event moves it to the copy's
 * project id (its `restoredFrom` naming the one before). Every other event must name the project
 * the log belongs to at that point, and the last one this backup's project.
 */
function auditProjectProblem(events: AuditEvent[], projectId: string): string | null {
  let current = events[0]?.projectId;
  for (const e of events) {
    if (e.action === "project.restored" && (e.details as { restoredFrom?: unknown } | undefined)?.restoredFrom === current) current = e.projectId;
    else if (e.projectId !== current) return "an event names another project";
  }
  return current === projectId ? null : "it belongs to another project";
}

/**
 * Test seams. `crashAfterRename`: the process "dies" right after the copy was renamed into place.
 * `failBeforeRename`: the last step before the rename fails. `beforeAdopt`: runs once the backup is
 * unpacked, before the commit turn (given the staging folder).
 */
export const restoreSeams: { crashAfterRename?: boolean; failBeforeRename?: boolean; beforeAdopt?: (staging: string) => Promise<void> } = {};

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const pretty = (text: string) => /\n\s/u.test(text);

/**
 * Turns the unpacked backup in `s.staging` into a new project of the library. Caller holds nothing;
 * this runs in the repository's write queue. The staging folder is removed on failure.
 */
export async function adoptRestoredProject(
  core: RepoCore,
  s: StagedRestore,
): Promise<{ project: Project; notes: string[]; leftOut: Array<{ sourceId: string; assetId: string; destroyedAt: string }>; warnings: string[] }> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const staging = s.staging;
    /** The copy is in place under its own name. */
    let live = false;
    let undoInherited: (() => Promise<void>) | undefined;
    try {
      const raw = await readMaybe(join(staging, "project.json"));
      if (!raw) throw new UnreadableBackupError("This file is not a project backup (it has no project.json)");
      let data;
      try {
        data = parseProjectJson(JSON.parse(raw.toString("utf8")));
      } catch {
        throw new UnreadableBackupError("The backup's project.json cannot be read");
      }
      const old = data.project;

      // 1. The audit chain.
      const events = await AuditStore.read(join(staging, "audit"));
      if (events.length === 0) throw new AuditChainInvalidError("it is empty");
      const verify = verifyChain(events as AuditEvent[]);
      if (!verify.ok) throw new AuditChainInvalidError(`event ${verify.brokenAt + 1}: ${verify.reason}`);
      if (s.expectedHead && (verify.head?.seq !== s.expectedHead.seq || verify.head.hash !== s.expectedHead.hash)) {
        throw new AuditChainInvalidError("it differs from the log the backup recorded");
      }
      const wrongProject = auditProjectProblem(events as AuditEvent[], old.id);
      if (wrongProject) throw new AuditChainInvalidError(wrongProject);

      // 1b. The decision again, in this turn (R138 c): against the rules that would go live with the
      // copy, and the rules the project the backup was made from has at this moment.
      // (Anything there that cannot be read as a file counts as no rules: refused.)
      const rules = await readMaybe(join(staging, "governance.yaml")).catch(() => null);
      const request: RestoreRequest = {
        project: { id: old.id, name: old.name, encrypted: old.encryption.enabled, ...(old.timeZone ? { timeZone: old.timeZone } : {}) },
        governanceYaml: rules ? rules.toString("utf8") : null,
        sealed: s.sealed,
        destinations: s.destinations,
        backupSha256: s.backupSha256,
        ...(s.file ? { file: s.file } : {}),
      };
      const decided = await decideRestore(core, request, core.clock().toISOString());
      if (decided.result === "deny") {
        await recordRestoreRefusal(core, request, decided.reason, "commit", { warnings: decided.warnings });
        throw new PolicyDeniedError(decided.reason, "restore");
      }

      // The key, for an encrypted project: the one derived for this restore alone, else the key
      // ring's (the project is unlocked). The restore puts no key in the ring (I1).
      const keyId = old.encryption.enabled ? old.encryption.keyId : undefined;
      const key = keyId ? (s.key && s.key.keyId === keyId ? s.key.key : core.keyRing.get(keyId)) : undefined;
      if (old.encryption.enabled && (!keyId || !key)) throw new RestoreError("The project's key is needed to restore this backup: unlock the project or give its passphrase");
      const getKey = (id: string) => (id === keyId ? key : undefined);
      const readText = async (abs: string): Promise<string> => {
        const b = await fsp.readFile(abs);
        return abs.endsWith(".enc") ? (await decryptBytes(getKey, b)).toString("utf8") : b.toString("utf8");
      };
      const writeText = async (abs: string, text: string) => {
        await writeFileAtomic(abs, abs.endsWith(".enc") ? await encryptBytes(key!, keyId!, text) : text, { mode: 0o600 });
      };

      // 2. Fresh ids, new folder.
      const newProjectId = newId();
      const ids = new Map<string, string>([[old.id, newProjectId]]);
      for (const x of [...data.collections, ...data.tags.filter((t) => t.scope !== "workspace"), ...data.participants, ...data.sessions, ...data.consents]) ids.set(x.id, newId());
      // The job journal (R31) records the original's worker jobs, with absolute paths into the
      // original's files and the library's temp folder: resubmitting them from the copy would
      // write into the original. The copy starts with no jobs (its viewing proxies still pending
      // are kept in its source files, below).
      await fsp.rm(join(staging, "jobs"), { recursive: true, force: true });
      const files = await walkFiles(staging);
      const sourceFiles = files.filter((f) => /^Sources\/[^/]+\/source\.json(\.enc)?$/u.test(f));
      const parsedSources = new Map<string, Record<string, unknown>>();
      for (const f of sourceFiles) {
        const sf = JSON.parse(await readText(join(staging, f))) as { source: { id: string }; assets: Array<{ id: string }>; annotations: Array<{ id: string }> };
        parsedSources.set(f, sf as unknown as Record<string, unknown>);
        ids.set(sf.source.id, newId());
        for (const a of sf.assets) ids.set(a.id, newId());
        for (const a of sf.annotations) ids.set(a.id, newId());
        // Pending viewing-proxy jobs (R31's file record of worker jobs).
        for (const j of (sf as { pendingProxies?: Array<{ id: string }> }).pendingProxies ?? []) ids.set(j.id, newId());
        const annFile = f.replace(/source\.json(\.enc)?$/u, (_m, enc: string | undefined) => `annotations.json${enc ?? ""}`);
        if (files.includes(annFile)) for (const a of JSON.parse(await readText(join(staging, annFile))) as Array<{ id: string }>) ids.set(a.id, newId());
      }
      // Import batches and review entries (R92: no id is shared with the original in the index).
      for (const f of files.filter((x) => /(^|\/)batch\.json(\.enc)?$/u.test(x))) {
        try {
          const id = (JSON.parse(await readText(join(staging, f))) as { id?: unknown }).id;
          if (typeof id === "string") ids.set(id, newId());
        } catch {
          throw new UnreadableBackupError("An import record in the backup cannot be read");
        }
      }
      for (const f of files.filter((x) => x.endsWith(".jsonl") && !x.startsWith("audit/"))) {
        for (const line of (await fsp.readFile(join(staging, f), "utf8")).split("\n")) {
          if (!line.trim()) continue;
          let o: { id?: unknown; ct?: unknown };
          try {
            o = JSON.parse(line) as { id?: unknown; ct?: unknown };
          } catch {
            continue; // an incomplete last line is kept as it is
          }
          if (typeof o.ct === "string" && key && f.startsWith("review/")) {
            try {
              o = JSON.parse(openLine(key, old.id, line, "ao-review")) as { id?: unknown };
            } catch {
              continue;
            }
          }
          if (f.startsWith("review/") && typeof o.id === "string" && !ids.has(o.id)) ids.set(o.id, newId());
        }
      }

      // Files destroyed under a retention rule are not brought back (R92, R174 d, R179). Which files
      // is read now, in the commit turn, from this library's record of destructions: an asset a
      // destruction's own audit entry names (by its id), or whose sha256 a certificate the audit log
      // vouches for lists; and, for a project whose audit log does not verify or whose folder could
      // not be loaded, whatever can still be read of its log and its certificate files names
      // (unverified evidence still excludes, whatever its form). If the backup's own project's
      // record cannot be read with certainty nothing is restored, and the refusal is audited.
      let record: DestroyedRecord;
      try {
        record = await s.destroyed(old.id);
      } catch (err) {
        if (err instanceof DestructionRecordError) await recordRestoreRefusal(core, request, err.message, "commit", err.logNotIntact ? { logNotIntact: err.projectId } : {});
        throw err;
      }
      const notes: string[] = [];
      // A verified record decides first; evidence the audit log cannot vouch for only ever adds to what is left out.
      const excluding = [...record.sources.filter((x) => x.basis === "recorded"), ...record.sources.filter((x) => x.basis === "unverified")];
      const leftBy = new Map<DestroyedSource, number>();
      /** What the copy keeps: the ids and sha256 of the stored files that are brought back. */
      const kept = { ids: new Set<string>(), sha256: new Set<string>() };
      /** What was left out, by the ids the backup holds (given as the copy's ids in the answer). */
      const left: Array<{ sourceId: string; assetId: string; destroyedAt: string }> = [];
      for (const [f, raw] of parsedSources) {
        const sf = raw as { source: { id: string }; assets: Array<{ id: string; path: string; sha256: string; status?: string; destroyedAt?: string; linked?: unknown }> };
        for (const a of sf.assets) {
          if (a.status === "destroyed" || a.linked) continue;
          const by = excluding.find((x) => x.byId.has(a.id) || x.bySha256.has(a.sha256));
          if (!by) {
            kept.ids.add(a.id);
            kept.sha256.add(a.sha256);
            continue;
          }
          const at = by.byId.get(a.id) ?? by.bySha256.get(a.sha256)!;
          if (a.path.startsWith(`${old.folder}/`)) await shredPath(join(staging, ...a.path.slice(old.folder.length + 1).split("/")));
          a.status = "destroyed";
          a.destroyedAt = at;
          left.push({ sourceId: sf.source.id, assetId: a.id, destroyedAt: at });
          leftBy.set(by, (leftBy.get(by) ?? 0) + 1);
        }
        parsedSources.set(f, sf as unknown as Record<string, unknown>);
      }
      const skipped = left.length;
      if (skipped) notes.push(`${skipped} ${skipped === 1 ? "file was" : "files were"} destroyed earlier under a retention rule and ${skipped === 1 ? "was" : "were"} not restored.`);
      // What each source has to say about this restore (nothing, when it has no bearing on it), and
      // what the audit entry records of evidence the audit log could not vouch for.
      const notVerified: Array<Record<string, unknown>> = [];
      for (const src of record.sources) {
        const files =
          src.basis === "unrecorded"
            ? [...src.byId.keys()].filter((id) => kept.ids.has(id)).length + [...src.bySha256.keys()].filter((h) => kept.sha256.has(h)).length
            : (leftBy.get(src) ?? 0);
        const note = src.note?.(files);
        if (note) notes.push(note);
        if (src.audit) notVerified.push(src.audit(files));
      }
      const sealedIn = [...new Set(record.sources.filter((x) => x.sealed).map((x) => x.projectId))];

      const projectsDir = join(core.root, "Projects");
      const taken = await namesIn(projectsDir);
      const base = sanitizeSegment(`${old.name} (restored ${s.date})`).replace(/^\./u, "_.");
      const folderName = withCollisionSuffix(base, (n) => taken.has(foldName(n)), { isFile: false });
      const oldRel = old.folder;
      const newRel = `Projects/${folderName}`;
      const map = (v: Json) => rewrite(v, ids, oldRel, newRel);

      // Sources: annotations first (their hash goes into source.json).
      const written: Array<{ source: { id: string; type: string; folder: string; issued?: string }; assets: Array<{ path: string; status?: string }> }> = [];
      for (const f of sourceFiles) {
        const sf = map(parsedSources.get(f)) as Record<string, unknown>;
        written.push(sf as unknown as (typeof written)[number]);
        const annFile = f.replace(/source\.json(\.enc)?$/u, (_m, enc: string | undefined) => `annotations.json${enc ?? ""}`);
        if (files.includes(annFile)) {
          const annJson = JSON.stringify(map(JSON.parse(await readText(join(staging, annFile)))));
          await writeText(join(staging, annFile), annJson);
          if (sf.annotationsSha256) sf.annotationsSha256 = createHash("sha256").update(annJson).digest("hex");
        }
        await writeText(join(staging, f), JSON.stringify(sf, null, 2));
      }
      // project.json: new id, name and folder.
      const nextData = map(data) as typeof data;
      nextData.project = { ...nextData.project, id: newProjectId, name: `${old.name} (restored ${s.date})`, folder: newRel };
      await writeText(join(staging, "project.json"), JSON.stringify(nextData, null, 2));
      // Every other JSON file and JSON-lines record. Two things are evidence and are never rewritten,
      // not a byte: the audit log, and the destruction certificates with the amendments beside them
      // (R147): their sha256 is in the audit log the copy inherits, and must keep verifying there.
      // They go on naming the ids and the folder of the project the data was destroyed in.
      for (const f of files) {
        if (f.startsWith("audit/") || f.startsWith("retention/") || f === "project.json" || f === "backup.json" || sourceFiles.includes(f) || /^Sources\/[^/]+\/annotations\.json(\.enc)?$/u.test(f)) continue;
        const abs = join(staging, f);
        if (/\.json(\.enc)?$/u.test(f)) {
          const text = await readText(abs);
          const next = JSON.stringify(map(JSON.parse(text)), null, pretty(text) ? 2 : undefined);
          if (next !== text) await writeText(abs, next);
        } else if (f.endsWith(".jsonl")) {
          const text = (await fsp.readFile(abs)).toString("utf8");
          const lines = text.split("\n");
          const out: string[] = [];
          for (const [i, line] of lines.entries()) {
            // The last piece after the final newline is "" (or an incomplete line, kept as it is).
            if (i === lines.length - 1 || !line.trim()) {
              out.push(line);
              continue;
            }
            const o = JSON.parse(line) as { ct?: unknown; nonce?: unknown };
            if (typeof o.ct === "string" && typeof o.nonce === "string") {
              if (!key) throw new UnreadableBackupError("The backup holds sealed records but no key");
              let opened: { json: string; purpose: string } | undefined;
              for (const purpose of SEALED_PURPOSES) {
                try {
                  opened = { json: openLine(key, old.id, line, purpose), purpose };
                  break;
                } catch {
                  // another purpose
                }
              }
              if (!opened) throw new UnreadableBackupError("A sealed record in the backup cannot be read");
              out.push(sealLine(key, keyId!, newProjectId, JSON.stringify(map(JSON.parse(opened.json))), opened.purpose));
            } else out.push(JSON.stringify(map(o)));
          }
          const next = out.join("\n");
          if (next !== text) await writeFileAtomic(abs, next, { mode: 0o600 });
        }
      }
      // manifest.json (encrypted projects) is made again from the sources as restored, so it never
      // lists a file that was left out because it had been destroyed (R94).
      if (files.includes("manifest.json")) {
        const manifest: Manifest = {
          formatVersion: 1,
          sources: written.map((sf) => ({
            id: sf.source.id,
            type: sf.source.type,
            ...(sf.source.issued ? { issuedYear: sf.source.issued.slice(0, 4) } : {}),
            folder: sf.source.folder,
            files: sf.assets.filter((a) => a.status !== "destroyed").map((a) => a.path),
          })),
        };
        await writeFileAtomic(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      }
      await fsp.rm(join(staging, "backup.json"), { force: true });
      await fsp.mkdir(join(staging, "Sources"), { recursive: true });

      // 3. The restore is recorded in the copy's own log, before it goes live.
      const at = core.clock().toISOString();
      const { store } = await AuditStore.load(join(staging, "audit"), core.auditSegmentSize);
      await store.append({
        at,
        actor: core.actor,
        device: core.device,
        projectId: newProjectId,
        action: "project.restored",
        entity: { type: "project", id: newProjectId },
        // The engine's decision (1b), with its conditions: this event is the restore's allow record.
        decision: decided.result === "allow_with_conditions" ? { result: decided.result, conditions: decided.conditions } : { result: "allow" },
        details: {
          op: "project.restore",
          backupSha256: s.backupSha256,
          restoredFrom: old.id,
          fromAuditHead: verify.head ? { seq: verify.head.seq, hash: verify.head.hash } : null,
          ...(skipped ? { leftOutDestroyed: skipped } : {}),
          // Projects whose record of destructions the audit log could not vouch for, and what the
          // list of files left out rests on for each (R179).
          ...(notVerified.length ? { destructionsNotVerified: notVerified } : {}),
          // Locked projects whose sealed certificates were not read: their destroyed files were known by id only.
          ...(sealedIn.length ? { destructionCertificatesSealed: sealedIn } : {}),
          ...(decided.warnings.length ? { warnings: decided.warnings } : {}),
        },
      });

      // Anchored before it goes live: a crash after the rename never looks like a missing anchor (R92).
      if (store.head) await core.anchors.set(core.anchorKey(newProjectId), store.head, at).catch(() => {});

      // 4. Into place (never over an existing folder), then loaded.
      const final = join(projectsDir, folderName);
      try {
        await fsp.mkdir(final);
      } catch {
        throw new RestoreError("A project folder with this name appeared meanwhile; nothing was restored");
      }
      await fsp.rmdir(final);
      // 3c. What the copy inherits is noted last before it goes live (R175), and taken back below
      // if it does not: the copy never exists without the warning for backups it must see removed.
      const inherited = await s.beforeLive?.({ projectId: newProjectId, folder: newRel, events: events as AuditEvent[] });
      undoInherited = inherited?.undo;
      if (restoreSeams.failBeforeRename) throw new Error("simulated failure before the rename");
      await renameWithRetry(staging, final);
      live = true;
      if (restoreSeams.crashAfterRename) throw new Error("simulated crash after the rename");
      const loaded = await loadProjectFolder(core, folderName);
      if (!loaded) throw new RestoreError("The restored project could not be opened");
      const st = loaded.st;
      core.projects.set(st.project.id, st);
      await core.updateAnchor(st, at);
      try {
        if (!core.encrypted(st) || core.keyRing.has(st.project.encryption.keyId ?? "")) {
          await core.index.indexProject(st.project);
          for (const id of listSourceIds(core, st.project.id)) await core.index.indexSource(await readSourceFile(core, st, id));
        } else if (core.index.indexLockedProject) {
          // Restored with a key derived for the restore alone: the copy is locked, and the index
          // holds of it what it holds of any locked project (its manifest, R30).
          await core.index.indexLockedProject(st.project, st.manifest.sources);
        } else await core.index.indexProject(st.project);
      } catch (error) {
        core.indexErrors.push({ op: "project.restored", error });
      }
      return {
        project: structuredClone(st.project),
        notes,
        leftOut: left.map((x) => ({ sourceId: ids.get(x.sourceId) ?? x.sourceId, assetId: ids.get(x.assetId) ?? x.assetId, destroyedAt: x.destroyedAt })),
        warnings: inherited?.warnings ?? [],
      };
    } catch (err) {
      if (!live) await undoInherited?.().catch(() => {});
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}
