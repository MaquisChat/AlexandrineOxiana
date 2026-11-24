/**
 * Project backups (spec 9, R90 b, R92).
 *
 * `backupProject` zips the whole project folder (everything but temp files `*.tmp-<hex>` and any
 * `.tmp` folder; symbolic links are skipped, never followed) with yazl (Zip64 when needed, so
 * projects over 4 GB and 65,535 files back up) to `<Library>/Backups/<project> - backup - modified
 * <YYYY-MM-DD HHmm>.zip`, written to a temp name and renamed into place (0600, fsync). The zip
 * begins with `backup.json` (project id and name, time, audit head, the ids of the assets whose
 * files it holds). For an encrypted project the ENTIRE zip is sealed with the project key in the
 * encrypted file format (`.zip.enc`): the zip is streamed through the encryption, so no plaintext
 * zip (and no file name) ever reaches the disk.
 *
 * Consistency without holding the library's write queue for the whole zip (R92): the file list
 * with sizes, modification times and inodes, the audit head and the asset ids are taken inside the
 * write queue; the zip is written afterwards, while other changes go on. Append-only logs
 * (`*.jsonl`: audit, change log, review, journals) are copied up to their snapshot size, which is
 * exactly the state of the audit head taken (a rollback never cuts below it). Any other file that
 * changed meanwhile (size, time, inode, gone) makes the backup start again once; if it changes
 * again, the backup is kept with a warning (`warnings`). A backup that fails is recorded in
 * `Backups/backups-state.json` (`failures`, beside each backup's owning project id: a damaged
 * manifest loses neither), which the project shows as the persisted warning `backup-failed` until
 * a backup succeeds. Leftover temp files of interrupted backups are overwritten and removed.
 *
 * Governed (R125): before anything is written, the policy engine decides (`action: 'backup'`): every
 * kind of storage the Backups folder may be on (its path and real path, classified as for a library
 * move; an uncertain kind counts as every plausible one) must be in the project's
 * `residency.allowed`, and `encryption.atRest: required` gives an `encrypt` condition that an
 * unencrypted project cannot honour (refused). A refusal is audited (decision deny, the engine's
 * reason) and thrown as PolicyDeniedError; nothing is created. The allow decision is audited as the
 * event `backup` (with its conditions and a `backupId`). The COMMIT POINT is the audit event
 * `backup.create` (same `backupId`; file name, sha256, size, file count; no path): it is appended
 * once the zip is complete and fsynced under its temp name, and only then is the file renamed to
 * its backup name and listed in the manifest. The steps are recorded beforehand in
 * `backups-state.json` (`pending`), so an interruption is settled the next time the library opens
 * or a backup operation runs, by what the audit log says: committed → renamed and listed;
 * not committed → the temp file is overwritten and removed and the project shows `backup-failed`.
 * No backup is ever listed, or named as one, without its `backup.create` event. If that event
 * cannot be written the backup is not kept (BackupNotRecordedError, `backup-failed`).
 *
 * Pruning stays a plain delete (R91) and is audited by file name: one `backup.prune` event per run
 * listing the files removed, written after they are removed (the run is recorded in `pending`
 * first, so a crash or a failed append is recorded later, `recovered: true`, never lost; until then
 * the project shows `backup-audit-pending` and the caller gets PruneNotRecordedError).
 *
 * The sidecar manifest `Backups/backups-manifest.json` (0600) lists every backup the app made: file
 * name, project id, time, sha256, size, the audit head, the asset ids it holds and, for an
 * encrypted project, the project's key file (the data key wrapped by the passphrase and by the
 * recovery code, as stored in the project — never the key itself; a backup keeps the passphrase
 * the project had when it was made). A manifest that cannot be read is kept aside and rebuilt from
 * each backup's own backup.json (sealed ones with the project key when it is unlocked; the key file
 * is taken from the project again); so is one that is missing while backup files are there (D15,
 * R174 c: a manifest that is merely absent never means "no backups"), before anything is decided
 * from it; files that cannot be read then are listed as `unresolved` and
 * treated as possibly holding the data of the project that owns them (R92 I2): by the owner the
 * state file recorded, else by the key a sealed file names, else by name (R94). They are tried
 * again whenever the manifest is read and when a project is unlocked, and move into the manifest
 * once readable. Pruning keeps the newest `keep`
 * (default 10) by the manifest's project id, and only ever removes manifest-listed files that have
 * a backup's name: nothing else in Backups/ is touched.
 *
 * `restoreBackup` refuses anything that is not a safe archive (extractArchive: traversal, absolute
 * and symbolic-link entries refuse the whole archive; no entry, and no archive, may inflate to more
 * than it declares — bomb protection by actual bytes), checks that the disk has room for what the
 * archive declares, writes runs of zeros as holes, reads a sealed backup in place
 * (crypto/random-access.ts: decrypted chunk by chunk, never written out as a zip), verifies its
 * audit chain, and makes it a NEW project (repo/restore.ts). A restored encrypted project keeps the
 * key (and key id) of the project it was made from: unlocking either unlocks both. The restore
 * itself unlocks nothing (I1): a passphrase given to it reads the backup, and no key stays in the
 * session, so the copy is then locked like the project it was made from. A restore is
 * governed (Task 50b): the policy engine decides before anything is unpacked and again in the commit
 * turn, a refusal is audited, files a recorded destruction destroyed are left out by what the audit
 * logs say, and a copy that inherits backups still to be removed has its warning from the moment it
 * is live (see `restoreBackup`).
 *
 * `backupIfDue(projectId, now)` (Task 30's daily scheduler): a backup when automatic backups are on
 * (`project.backups.automatic`, default on), the project is unlocked, and the last backup is a day
 * old (or there is none).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { datedFileName, formatModified, newId, withCollisionSuffix, type PolicyRequest, type Project } from "@ao/core";
import { KeyNotAvailableError, encryptStream, readKeyId } from "../crypto/format.js";
import { unwrapKey, unwrapWithRecovery, WrongPassphraseError } from "../crypto/keys.js";
import { openSealedZip } from "../crypto/random-access.js";
import { UnsafeFileError } from "../extract/errors.js";
import { extractArchive, readArchiveEntry, type ZipSource } from "../extract/zip.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { scrubPaths } from "../app-settings.js";
import { defaultLocationEnv, type LocationEnv } from "../location.js";
import { candidates, locate } from "../move.js";
import { AuditStore } from "../repo/audit-store.js";
import { LibraryClosedError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { isClosed, onClose, type Library } from "../library.js";
import { backupClosedSentence } from "@ao/shared";
import { SimulatedCrash } from "../repo/seams.js";
import { foldName, namesIn, readMaybe } from "../repo/io.js";
import type { ProjectKeyFile } from "../repo/projects.js";
import { AuditChainInvalidError, DestructionRecordError, RestoreError, UnreadableBackupError, restoreSeams, type RestoreRequest } from "../repo/restore.js";
import { parseProjectJson } from "../repo/state.js";
import {
  DESTRUCTION_BACKUPS_PENDING_WARNING,
  DESTRUCTION_OLD_COPIES_PENDING_WARNING,
  adoptRestoredProject,
  appendLibraryEvent,
  authorizeProcessing,
  authorizeRestore,
  keyFromRing,
  onProjectOpened,
  onProjectUnlocked,
  lookupPolicyInfo,
  refuseRestore,
  refuseUnreadableBackup,
  repoClock,
  repoLibrary,
  repoTz,
  setProjectBackupSettings,
  withProjectQueue,
  type ProjectQueueContext,
  type Repo,
} from "../repo/repo.js";
import { isDue, projectTimeZone } from "../retention-date.js";
// The readers a restore needs: built on the shared reading of the destruction record, and importing
// neither this module nor retention.ts (which imports this module).
import { destroyedOnRecord, inheritedOldCopies, inheritedOutstanding, type DestroyedOnRecord } from "../restore-record.js";

export { AuditChainInvalidError, DestructionRecordError, RestoreError, UnreadableBackupError };

export const BACKUPS_MANIFEST = "backups-manifest.json";
export const DEFAULT_KEEP = 10;
const DAY_MS = 86_400_000;
/** Restore limits: entry count only; sizes are bounded by free space and by what the archive declares (R92). */
export const BACKUP_LIMITS = { maxEntries: 10_000_000, maxEntryBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER } as const;
/** Kept free on the disk beyond what a restore declares. */
const FREE_MARGIN = 64 * 1024 * 1024;
const TEMP_FILE = /\.tmp-[0-9a-f]+$/u;
/** A backup's temp file while it is written (R94: only these are swept). */
const BACKUP_TEMP = /^.+ - backup - modified \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.zip(?:\.enc)?\.tmp-[0-9a-f]+$/u;
/** A backup's file name (any project name, date and collision suffix). */
const BACKUP_NAME = /^.+ - backup - modified \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.zip(?:\.enc)?$/u;

/** Package-internal: whether `name` is a plain file name of the backup naming pattern (the only files in Backups/ the app ever removes). */
export const isBackupFileName = (name: string): boolean => name === basename(name) && BACKUP_NAME.test(name);

/** Points in a backup or a prune where a test can simulate the process dying (R125). */
export type BackupCrashPoint =
  | "after-decision"
  | "after-zip"
  | "before-commit"
  | "after-commit"
  | "before-manifest"
  | "before-prune-audit"
  /** Destruction under retention: a holding backup has been removed and the removal is not yet recorded. */
  | "before-removal-record";

/** Test seams. */
export const backupSeams: {
  failBackup?: boolean;
  /** Runs after each snapshot, outside the write queue, before the zip is written. */
  afterSnapshot?: () => Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
  /** Throws SimulatedCrash once at this point: nothing is cleaned up, as if the process died. */
  crashAt?: BackupCrashPoint;
  /** Runs after old backups are removed, before their `backup.prune` event is written. */
  beforePruneAudit?: () => Promise<void>;
  /** Runs once the archive is complete and recorded, before it is named and committed (R138 probes). */
  beforeCommit?: (hold: MaintenanceHold) => Promise<void>;
  /** Runs before each piece of the zip is written to its temp file (R551 I2 probes: a close in the middle of the zip). */
  zipChunk?: () => Promise<void>;
  /** Runs inside each write of the state file, before it is written (R555 4 probes: a close while one is being made). */
  stateWrite?: () => Promise<void>;
} = {};

function crashPoint(point: BackupCrashPoint): void {
  if (backupSeams.crashAt === point) {
    backupSeams.crashAt = undefined;
    throw new SimulatedCrash(`simulated crash at ${point}`);
  }
}

/** Package-internal (retention): the same test seam, for the steps of a destruction's backups. */
export const backupCrashPoint = crashPoint;

/**
 * R551 I2 (R247 c): the library was closed (or its session began to close: the close, the close inside opening or
 * creating another library or a reconnect, the service's stop) while the backup was being made. It stopped at its next
 * step, before its commit point; its temporary file is removed; neither a success nor a failure is recorded. The
 * message is the one sentence for whoever asked (`backupClosedSentence`).
 */
export class BackupCancelledError extends Error {
  override name = "BackupCancelledError";
  constructor(projectName: string) {
    super(backupClosedSentence(projectName));
  }
}

/**
 * R551 I2: the backups in flight on each library. Its `close()` waits for them (registered once, as a repository's
 * write queue is) before the lock is released: a backup cut by the close removes its temporary file and its pending
 * record first, so nothing under Backups/ changes after the close.
 */
const backupsInFlight = new WeakMap<Library, Set<Promise<unknown>>>();

/**
 * Package-internal (retention, R554): runs `run` as work under Backups/ that the library's `close()` waits for — a
 * backup, or a destruction's backups step (its fresh backup, its removals, its record).
 */
export function inFlight<T>(lib: Library, run: () => Promise<T>): Promise<T> {
  let set = backupsInFlight.get(lib);
  if (!set) {
    const mine = new Set<Promise<unknown>>();
    set = mine;
    backupsInFlight.set(lib, mine);
    onClose(lib, { drain: async () => void (await Promise.allSettled([...mine])), holdsTurn: () => false });
  }
  const work: InFlightWork = { lib, beganOpen: !isClosed(lib), live: true };
  const p = inFlightWork.run(work, run);
  const held = set;
  const forget = () => {
    work.live = false;
    held.delete(p);
  };
  held.add(p);
  p.then(forget, forget);
  return p;
}

/**
 * R555 4: the work in flight the current code runs for. Work that began while its library was open is what the close
 * is waiting for: its own last writes of the state file (a cut backup taking back its pending record; a destruction's
 * step) land before `close()` resolves. A callback that outlives the work carries this context, so `live` says whether
 * the work is still running.
 */
interface InFlightWork {
  lib: Library;
  beganOpen: boolean;
  live: boolean;
}
const inFlightWork = new AsyncLocalStorage<InFlightWork>();

/** True while the current code runs for work of `lib` that the close waits for (begun while the library was open). */
function waitedForByClose(lib: Library): boolean {
  const w = inFlightWork.getStore();
  return w !== undefined && w.lib === lib && w.beganOpen && w.live;
}

/** A close (or the session's closing) cut the backup: the library refused a step, or the backup saw it between steps. Package-internal (retention, R554). */
export const cutByClose = (err: unknown): boolean => err instanceof BackupCancelledError || err instanceof LibraryClosedError;

/** The `backup.create` event (the commit point) could not be written: the backup was not kept. */
export class BackupNotRecordedError extends Error {
  override name = "BackupNotRecordedError";
  constructor(options?: { cause?: unknown }) {
    super("The backup could not be recorded in the audit log, so it was not kept.", options);
  }
}

/** Old backups were removed (a plain delete, not undone) but the `backup.prune` event could not be written yet. */
export class PruneNotRecordedError extends Error {
  override name = "PruneNotRecordedError";
  constructor(
    /** File names removed. */
    readonly removed: string[],
    options?: { cause?: unknown },
  ) {
    super("Old backups were removed, but their removal could not be recorded in the audit log yet; it is recorded at the next backup.", options);
  }
}

/** The reason kept for a backup interrupted before its commit point. */
export const BACKUP_INTERRUPTED = "The backup was interrupted before it was finished; nothing of it was kept.";

export interface BackupEntry {
  file: string;
  projectId: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  encrypted: boolean;
  files: number;
  auditHead: { seq: number; hash: string } | null;
  /** Ids of the assets whose files the backup holds (retention, R90 d). Absent: unknown (treated as all). */
  assets?: string[];
  /** Encrypted projects: the project's key file (wrapped keys only). */
  keyFile?: ProjectKeyFile;
}

interface BackupManifest {
  formatVersion: 1;
  backups: BackupEntry[];
  /** Backup-named files that could not be read when the manifest was rebuilt (R92 I2). */
  unresolved?: string[];
}

export interface BackupResult {
  path: string;
  sha256: string;
  bytes: number;
  /** Backups removed by pruning (file names). */
  pruned: string[];
  /** E.g. files that kept changing while the backup was made. */
  warnings: string[];
}

const backupsDir = (repo: Repo) => join(repoLibrary(repo).root, "Backups");

// ------------------------------------------------------------------------------------------
// The manifest

/** One manifest writer at a time per library folder (in-process; the library lock keeps other processes out). */
const manifestLocks = new Map<string, Promise<unknown>>();
function withManifest<T>(repo: Repo, fn: (m: BackupManifest) => Promise<T>): Promise<T> {
  const dir = backupsDir(repo);
  const prev = manifestLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(async () => {
    const m = await loadManifest(repo);
    const before = JSON.stringify(m);
    const out = await fn(m);
    // (Never into a library this computer does not hold for writing: its readers change nothing. Nor into a closed one,
    // R560 M1: kept in memory only.)
    if (JSON.stringify(m) !== before && repoLibrary(repo).mode === "read-write") await whileOpenOrWaited(repoLibrary(repo), () => writeManifest(dir, m));
    return out;
  });
  manifestLocks.set(
    dir,
    run.catch(() => {}),
  );
  return run;
}

/**
 * R560 M1 (R247 c; as the state file's one writer, R555 4, R558 a): runs `write` — a write under Backups/ — only while the
 * library is open, counted in the close's wait (`inFlight`, checked and registered in the same tick), or for work the close
 * was already waiting for when it began. Once the library is closed it writes nothing and resolves (the caller's reading
 * stands in memory; whatever it would have tidied is left for the next opening).
 */
function whileOpenOrWaited(lib: Library, write: () => Promise<unknown>): Promise<void> {
  if (waitedForByClose(lib)) return write().then(() => undefined);
  if (isClosed(lib)) return Promise.resolve();
  return inFlight(lib, write).then(() => undefined);
}

const writeManifest = async (dir: string, m: BackupManifest) => {
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, BACKUPS_MANIFEST), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
};

/**
 * The manifest; a damaged one is kept aside and rebuilt from the backups themselves (R92 I2). So is
 * one that is missing while backup files are there (D15, R174 c): "no backups" is never concluded
 * from a file that is merely absent. Everything that decides from the manifest reads it through
 * here (a destruction's list, a retry pass, a prune, a restore's choice of backup), so the rebuild
 * always comes first. Only a Backups folder that holds no backup file gives an empty manifest.
 * In a library this computer does not hold for writing, the rebuilt list is used and nothing is
 * written or moved (R154 e): the computer that holds the library rebuilds the file itself.
 */
async function loadManifest(repo: Repo): Promise<BackupManifest> {
  const dir = backupsDir(repo);
  const mayWrite = repoLibrary(repo).mode === "read-write";
  const raw = await readMaybe(join(dir, BACKUPS_MANIFEST));
  if (!raw) {
    const rebuilt = await rebuildManifest(repo);
    // Nothing to list: nothing is written (a library that never made a backup keeps no manifest).
    if (!rebuilt.backups.length && !rebuilt.unresolved?.length) return { formatVersion: 1, backups: [] };
    if (mayWrite) await whileOpenOrWaited(repoLibrary(repo), () => writeManifest(dir, rebuilt));
    return rebuilt;
  }
  let m: BackupManifest;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as BackupManifest;
    if (parsed.formatVersion !== 1 || !Array.isArray(parsed.backups)) throw new Error("bad manifest");
    m = {
      formatVersion: 1,
      backups: parsed.backups.filter((b) => b && typeof b.file === "string" && typeof b.projectId === "string"),
      ...(Array.isArray(parsed.unresolved) ? { unresolved: parsed.unresolved.filter((x) => typeof x === "string") } : {}),
    };
  } catch {
    if (mayWrite) await whileOpenOrWaited(repoLibrary(repo), () => fsp.rename(join(dir, BACKUPS_MANIFEST), join(dir, `${BACKUPS_MANIFEST}.unreadable-${Date.now()}`)).catch(() => {}));
    const rebuilt = await rebuildManifest(repo);
    if (mayWrite) await whileOpenOrWaited(repoLibrary(repo), () => writeManifest(dir, rebuilt));
    return rebuilt;
  }
  // Files a rebuild could not read are tried again every time (R94): e.g. a sealed backup whose
  // project has been unlocked since.
  if (m.unresolved?.length) {
    const still: string[] = [];
    const added: BackupEntry[] = [];
    let moved = false;
    for (const f of m.unresolved) {
      if (!(await fsp.stat(join(dir, f)).then((x) => x.isFile(), () => false))) {
        moved = true; // gone
        continue;
      }
      const e = await readEntry(repo, f);
      if (e && !m.backups.some((b) => b.file === f)) {
        m.backups.push(e);
        added.push(e);
        moved = true;
      } else if (e) moved = true;
      else still.push(f);
    }
    // Read before a lock that came meanwhile: unreadable now, as the rest (R435 e).
    const back: string[] = [];
    await asLockedNow(repo, dir, added, back);
    if (back.length) m.backups = m.backups.filter((b) => !back.includes(b.file));
    still.push(...back);
    if (moved) {
      if (still.length) m.unresolved = still;
      else delete m.unresolved;
      if (mayWrite) await whileOpenOrWaited(repoLibrary(repo), () => writeManifest(dir, m));
    }
  }
  return m;
}

// ------------------------------------------------------------------------------------------
// Backup state kept beside the manifest (R94): who each backup belongs to and failed backups, in a
// file of its own, so a damaged manifest loses neither (both are plaintext ids, nothing identifying).
// Also the backups and prunes in progress (R125): file names and, once a zip is complete, its
// manifest entry (the same content the manifest holds).

/**
 * A backup or a prune in progress (R125), recorded before its first step so an interruption is
 * settled later by what the audit log says. `create`: the temp file and backup name once chosen,
 * and the manifest entry once the zip is complete. `prune`: the files about to be removed;
 * `auditFailed` once writing their `backup.prune` event failed (the warning `backup-audit-pending`).
 */
type PendingOp =
  | { kind: "create"; projectId: string; at: string; tmp?: string; file?: string; entry?: BackupEntry }
  | { kind: "prune"; projectId: string; at: string; files: string[]; keep: number; auditFailed?: boolean };

interface BackupState {
  formatVersion: 1;
  /** Backup file → project id (rename-safe: never inferred from the project's current name). */
  owners: Record<string, string>;
  /** Projects whose last backup failed or was refused: the warning `backup-failed`. */
  failures: Record<string, BackupFailure>;
  /** Backups and prunes not yet settled, by backup id / prune id. */
  pending: Record<string, PendingOp>;
  /**
   * Per project, per destruction certificate: backups holding destroyed raw data not removed yet
   * (N1, R2-I2): what raises `destruction-backups-pending`. A note for the warning only (R147): what
   * is outstanding is decided from the audit log, and this is rewritten from it at every retry pass.
   */
  undestroyed: Record<string, Record<string, string[]>>;
  /** Per project, per destruction certificate: why the app does not remove those backups by itself (plain words), if so. */
  destructionProblems: Record<string, Record<string, string>>;
  /** Per destruction certificate (`<projectId>:<rel>`): the retry record of its backups step (R2-I1). Bookkeeping, not authority. */
  retries: Record<string, RetentionRetry>;
  /**
   * Per project, per destruction certificate: the old copies of the library left by a move that
   * still hold destroyed files, or a list that could not be checked (R379): what raises
   * `destruction-old-copies-pending`. A note for the warning only, rewritten from the audit log at
   * every retry pass, as `undestroyed` is.
   */
  oldCopiesUndestroyed: Record<string, Record<string, OldCopiesNote>>;
}

/** Package-internal (retention, R379): what the state file notes of one destruction's old copies. */
export interface OldCopiesNote {
  /** Each by the id of this computer's record of it and the time of the move that left it (never a path). */
  copies: Array<{ id: string; movedAt: string }>;
  /** The list of old copies could not be read, so this was not checked yet. */
  unchecked?: true;
}

/** Why the project's last backup failed (plain text; never a path), and when. */
export interface BackupFailure {
  at: string;
  reason: string;
  /** The policy engine refused it (R125). */
  refused?: true;
}

export const BACKUPS_STATE = "backups-state.json";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pendingOf(v: unknown): Record<string, PendingOp> {
  const out: Record<string, PendingOp> = {};
  if (!isObject(v)) return out;
  for (const [id, op] of Object.entries(v)) {
    if (!isObject(op) || typeof op.projectId !== "string" || typeof op.at !== "string") continue;
    // Names only, inside Backups/, of the backup naming pattern: a damaged or edited record never
    // points the settling at any other file.
    const nameOk = (v: unknown, re: RegExp) => v === undefined || (typeof v === "string" && v === basename(v) && re.test(v));
    const entry = op.entry as Partial<BackupEntry> | undefined;
    if (op.kind === "create" && nameOk(op.tmp, BACKUP_TEMP) && nameOk(op.file, BACKUP_NAME) && (entry === undefined || (isObject(entry) && entry.file === op.file && entry.projectId === op.projectId))) {
      out[id] = op as PendingOp;
    }
    else if (op.kind === "prune" && Array.isArray(op.files) && op.files.every((f) => typeof f === "string")) out[id] = op as PendingOp;
  }
  return out;
}

/** Per project, per certificate lists of file names (a project's plain list, as round 2 wrote it, counts under "*"). */
function undestroyedOf(v: unknown): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!isObject(v)) return out;
  const names = (x: unknown) => (Array.isArray(x) ? x.filter((f): f is string => typeof f === "string") : []);
  for (const [pid, per] of Object.entries(v)) {
    if (Array.isArray(per)) out[pid] = { "*": names(per) };
    else if (isObject(per)) out[pid] = Object.fromEntries(Object.entries(per).map(([k, x]) => [k, names(x)]));
  }
  return out;
}

/** Per project, per certificate: the old copies noted (R379); anything malformed is dropped. */
function oldCopiesNotesOf(v: unknown): Record<string, Record<string, OldCopiesNote>> {
  const out: Record<string, Record<string, OldCopiesNote>> = {};
  if (!isObject(v)) return out;
  for (const [pid, per] of Object.entries(v)) {
    if (!isObject(per)) continue;
    const mine: Record<string, OldCopiesNote> = {};
    for (const [rel, n] of Object.entries(per)) {
      if (!isObject(n)) continue;
      const copies = (Array.isArray(n.copies) ? n.copies : []).filter((c): c is { id: string; movedAt: string } => isObject(c) && typeof c.id === "string" && typeof c.movedAt === "string").map((c) => ({ id: c.id, movedAt: c.movedAt }));
      if (copies.length || n.unchecked === true) mine[rel] = { copies, ...(n.unchecked === true ? { unchecked: true as const } : {}) };
    }
    if (Object.keys(mine).length) out[pid] = mine;
  }
  return out;
}

/** Per project, per certificate: one plain sentence or more. */
function problemsOf(v: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!isObject(v)) return out;
  for (const [pid, per] of Object.entries(v)) {
    if (!isObject(per)) continue;
    const mine = Object.fromEntries(Object.entries(per).filter((e): e is [string, string] => typeof e[1] === "string"));
    if (Object.keys(mine).length) out[pid] = mine;
  }
  return out;
}

async function readState(dir: string): Promise<BackupState> {
  try {
    const raw = await readMaybe(join(dir, BACKUPS_STATE));
    const s = raw ? (JSON.parse(raw.toString("utf8")) as Partial<BackupState>) : {};
    return {
      formatVersion: 1,
      owners: s.owners && typeof s.owners === "object" ? s.owners : {},
      failures: s.failures && typeof s.failures === "object" ? s.failures : {},
      pending: pendingOf(s.pending),
      undestroyed: undestroyedOf(s.undestroyed),
      destructionProblems: problemsOf(s.destructionProblems),
      retries: isObject(s.retries) ? (s.retries as Record<string, RetentionRetry>) : {},
      oldCopiesUndestroyed: oldCopiesNotesOf(s.oldCopiesUndestroyed),
    };
  } catch {
    return { formatVersion: 1, owners: {}, failures: {}, pending: {}, undestroyed: {}, destructionProblems: {}, retries: {}, oldCopiesUndestroyed: {} };
  }
}

/**
 * Reads, edits and writes the state; the caller holds the manifest's queue. The one writer of the state file (R555 4):
 * refused once the library is closed (LibraryClosedError, "cannot run now" for every caller) — except by work the close is
 * already waiting for — and counted in the close's wait while it is being made (`inFlight`), so the file never changes
 * after `close()` resolved.
 */
function editStateNow(repo: Repo, dir: string, fn: (s: BackupState) => void): Promise<void> {
  const lib = repoLibrary(repo);
  // Checked and registered in the same tick: no gap between the check and the close's wait. Work the close already waits
  // for (a backup or a destruction's step begun while the library was open) still finishes its own writes in that wait.
  if (isClosed(lib) && !waitedForByClose(lib)) return Promise.reject(new LibraryClosedError());
  return inFlight(lib, () => writeState(dir, fn));
}

async function writeState(dir: string, fn: (s: BackupState) => void): Promise<void> {
  const s = await readState(dir);
  await backupSeams.stateWrite?.();
  fn(s);
  // Written only when it holds something (R379): a library with no such note keeps the file as before.
  const { oldCopiesUndestroyed, ...rest } = s;
  const out = Object.keys(oldCopiesUndestroyed).length ? s : rest;
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, BACKUPS_STATE), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
}

/** The recorded failure of the project's last backup (the warning `backup-failed`), if any. */
export async function backupFailure(repo: Repo, projectId: string): Promise<BackupFailure | undefined> {
  const f = (await readState(backupsDir(repo))).failures;
  return Object.hasOwn(f, projectId) ? f[projectId] : undefined;
}

/** Edits the state (in the manifest's queue, so writes never interleave). */
function withState(repo: Repo, fn: (s: BackupState) => void): Promise<void> {
  const dir = backupsDir(repo);
  const prev = manifestLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(() => editStateNow(repo, dir, fn));
  manifestLocks.set(
    dir,
    run.catch(() => {}),
  );
  return run;
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}

async function projectKeyFile(repo: Repo, projectId: string): Promise<ProjectKeyFile | undefined> {
  try {
    const p = repo.getProject(projectId);
    const raw = await readMaybe(join(repoLibrary(repo).root, ...p.folder.split("/"), "keys", "project-key.json"));
    return raw ? (JSON.parse(raw.toString("utf8")) as ProjectKeyFile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every backup-named file, read back from its own backup.json; unreadable ones are `unresolved`.
 * An archive that has its name but whose backup is not settled yet (its `backup.create` event may
 * never be written) is not a backup and is left out: settling lists it, or removes it (R125).
 * No Backups folder: no backups. A folder that cannot be listed is an error, never "no backups".
 */
async function rebuildManifest(repo: Repo): Promise<BackupManifest> {
  const dir = backupsDir(repo);
  const m: BackupManifest = { formatVersion: 1, backups: [], unresolved: [] };
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => BACKUP_NAME.test(n)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return m;
    throw new Error(`The Backups folder cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"}), so the app cannot tell which backups exist.`, { cause: err });
  }
  const unsettled = Object.values((await readState(dir)).pending).flatMap((op) => (op.kind === "create" && op.file ? [op] : []));
  for (const file of names) {
    // Left out only while the file under that name is that unsettled backup's own archive: any other
    // file that carries the name is read like every backup file (it may hold the project's data).
    const op = unsettled.find((o) => o.file === file);
    if (op && (await isOurs(join(dir, file), op.tmp ? join(dir, op.tmp) : undefined, op.entry?.sha256).catch(() => false))) continue;
    const e = await readEntry(repo, file);
    if (e) m.backups.push(e);
    else m.unresolved!.push(file);
  }
  await asLockedNow(repo, dir, m.backups, m.unresolved!);
  return m;
}

/**
 * R435 e: a project locked (or being locked) while the manifest was being read: its sealed backups read before the
 * lock count as unreadable now, as all of them would had it been locked from the start, so the listing is never a
 * part of its backups (they are read again at the next load, as every unresolved file is). Moves them from
 * `entries` to `unresolved`.
 */
async function asLockedNow(repo: Repo, dir: string, entries: BackupEntry[], unresolved: string[]): Promise<void> {
  for (const e of [...entries]) {
    if (!e.encrypted) continue;
    const keyId = await readKeyId(join(dir, e.file)).catch(() => undefined);
    if (keyId === undefined || keyFromRing(repo, keyId)) continue;
    entries.splice(entries.indexOf(e), 1);
    unresolved.push(e.file);
  }
}

/** A backup's manifest entry, read back from its own backup.json (undefined: unreadable now). */
async function readEntry(repo: Repo, file: string): Promise<BackupEntry | undefined> {
  const dir = backupsDir(repo);
  {
    const abs = join(dir, file);
    let close: (() => Promise<void>) | undefined;
    try {
      let src: ZipSource = abs;
      if (file.endsWith(".enc")) {
        const keyId = await readKeyId(abs);
        if (!keyFromRing(repo, keyId)) throw new Error("locked");
        const z = await openSealedZip(abs, (id) => keyFromRing(repo, id));
        src = { reader: z.reader, size: z.size };
        close = z.close;
      }
      const raw = await readArchiveEntry(src, "backup.json");
      if (!raw) throw new Error("no backup.json");
      const h = JSON.parse(raw.toString("utf8")) as {
        projectId?: unknown;
        createdAt?: unknown;
        encrypted?: unknown;
        auditHead?: BackupEntry["auditHead"];
        assets?: unknown;
        files?: unknown;
      };
      if (typeof h.projectId !== "string" || typeof h.createdAt !== "string") throw new Error("bad backup.json");
      const keyFile = file.endsWith(".enc") ? await projectKeyFile(repo, h.projectId) : undefined;
      return {
        file,
        projectId: h.projectId,
        createdAt: h.createdAt,
        sha256: await sha256Of(abs),
        bytes: (await fsp.stat(abs)).size,
        encrypted: file.endsWith(".enc"),
        files: typeof h.files === "number" ? h.files : 0,
        auditHead: h.auditHead ?? null,
        ...(Array.isArray(h.assets) ? { assets: h.assets.filter((x): x is string => typeof x === "string") } : {}),
        ...(keyFile ? { keyFile } : {}),
      };
    } catch {
      return undefined;
    } finally {
      await close?.().catch(() => {});
    }
  }
}

/** The project's backups the app made and that still exist, newest first. */
export async function listBackups(repo: Repo, projectId: string): Promise<BackupEntry[]> {
  const dir = backupsDir(repo);
  // A backup interrupted after its commit point is finished first, so it is listed (and found by
  // destruction under retention, R90 d); one interrupted before it is removed (R125).
  await settlePending(repo);
  const m = await withManifest(repo, async (x) => x);
  const out: BackupEntry[] = [];
  for (const b of m.backups) {
    if (b.projectId !== projectId) continue;
    if (await fsp.stat(join(dir, b.file)).then((s) => s.isFile(), () => false)) out.push(b);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Package-internal (here, and retention's look into an old copy, R429 d): whether the sealed backup
 * at `abs` is sealed with the key `keyId` (read from its header; false when it cannot be read or
 * the project has no key).
 */
export async function sealedWithKey(abs: string, keyId: string | undefined): Promise<boolean> {
  return !!keyId && (await readKeyId(abs).catch(() => undefined)) === keyId;
}

/**
 * Package-internal (retention, R92 I2): backup files that could not be read when the manifest was
 * rebuilt and whose name is the project's — they may hold its data.
 */
export async function unresolvedBackupsOf(repo: Repo, projectId: string): Promise<string[]> {
  await settlePending(repo);
  const m = await withManifest(repo, async (x) => x);
  const dir = backupsDir(repo);
  const state = await readState(dir);
  const project = repo.getProject(projectId);
  const stem = datedFileName(`${project.name} - backup`, new Date(0), "zip").replace(/ - modified .*$/u, "");
  const out: string[] = [];
  for (const f of m.unresolved ?? []) {
    const abs = join(dir, f);
    if (!(await fsp.stat(abs).then((s) => s.isFile(), () => false))) continue;
    // Rename-safe (R94): the recorded owner; else, sealed, the key it is sealed with (a restored
    // copy shares its key: both projects count, fail closed); else, last, the project's name.
    const owner = Object.hasOwn(state.owners, f) ? state.owners[f] : undefined;
    let mine: boolean;
    if (owner) mine = owner === projectId;
    else if (f.endsWith(".enc")) mine = await sealedWithKey(abs, project.encryption.keyId);
    else mine = f.startsWith(`${stem} - modified `);
    if (mine) out.push(f);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Writing a backup

interface FileToZip {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  ino: number;
  /** An append-only log: copied up to `size` (its state at the snapshot). */
  appendOnly: boolean;
}

/** The project folder's files (no temp files, no .tmp folder, no symbolic links). */
async function filesOf(dir: string, base = ""): Promise<FileToZip[]> {
  const out: FileToZip[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === ".tmp" || TEMP_FILE.test(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesOf(abs, rel)));
    else if (e.isFile()) {
      const st = await fsp.stat(abs);
      out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, appendOnly: e.name.endsWith(".jsonl") });
    }
  }
  return out;
}

/** Whether a file is no longer as the snapshot saw it (append-only logs: only if shorter). */
async function changedSince(files: FileToZip[]): Promise<boolean> {
  for (const f of files) {
    const st = await fsp.stat(f.abs).catch(() => null);
    if (!st) return true;
    if (f.appendOnly) {
      if (st.size < f.size || st.ino !== f.ino) return true;
    } else if (st.size !== f.size || st.mtimeMs !== f.mtimeMs || st.ino !== f.ino) return true;
  }
  return false;
}

interface Snapshot {
  files: FileToZip[];
  project: Project;
  at: string;
  head: { seq: number; hash: string } | null;
  assets: string[];
  /** A copy of the data key (zeroed after the zip is written), encrypted projects only. */
  key: { key: Buffer; keyId: string } | null;
  keyFile?: ProjectKeyFile;
}

/** Ids of the stored (not destroyed) assets of every source of the project. */
async function storedAssetIds(repo: Repo, projectId: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, id);
    for (const a of sf.assets) if (a.status !== "destroyed" && !a.linked) out.push(a.id);
  }
  return out;
}

async function snapshot(repo: Repo, projectId: string): Promise<Snapshot> {
  return withProjectQueue(repo, projectId, async (ctx: ProjectQueueContext) => {
    const projectDir = join(ctx.root, ...ctx.rel.split("/"));
    const k = ctx.key();
    let keyFile: ProjectKeyFile | undefined;
    if (k) {
      const raw = await readMaybe(join(projectDir, "keys", "project-key.json"));
      if (raw) keyFile = JSON.parse(raw.toString("utf8")) as ProjectKeyFile;
    }
    return {
      files: await filesOf(projectDir),
      project: ctx.project,
      at: ctx.at(),
      head: ctx.head(),
      assets: await storedAssetIds(repo, projectId),
      key: k ? { key: Buffer.from(k.key), keyId: k.keyId } : null,
      ...(keyFile ? { keyFile } : {}),
    };
  });
}

const DOS_EPOCH = new Date("1980-01-02T00:00:00Z");

/** Streams the zip of the snapshot (backup.json first) through the encryption (if any) into `tmp`. */
async function writeZip(tmp: string, snap: Snapshot, header: Record<string, unknown>, step: () => void = () => {}): Promise<{ sha256: string; bytes: number }> {
  // R454: the zip starts reading its files as soon as they are added, so nothing is awaited from here on until its
  // errors are listened to and its output consumed: the temp file is opened first.
  const hash = createHash("sha256");
  let bytes = 0;
  const fh = await fsp.open(tmp, "wx", 0o600);
  try {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(header, null, 2)), "backup.json", { mtime: new Date(snap.at), compress: true });
    for (const f of snap.files) {
      const mtime = new Date(Math.max(f.mtimeMs, DOS_EPOCH.getTime()));
      if (f.size === 0) {
        zip.addBuffer(Buffer.alloc(0), f.rel, { mtime });
        continue;
      }
      // `size` makes yazl fail when the file holds other than the snapshot's bytes; logs are cut at it.
      zip.addReadStreamLazy(f.rel, { mtime, size: f.size, compress: !f.rel.endsWith(".enc") }, (cb) => {
        const s = createReadStream(f.abs, f.appendOnly ? { start: 0, end: f.size - 1 } : {});
        s.once("open", () => cb(null, s));
        s.once("error", (err) => cb(err, s));
      });
    }
    zip.end();
    const sink = new Writable({
      async write(chunk: Buffer, _enc, cb) {
        try {
          // R551 I2: a close cuts the zip between two of its pieces (the stream ends with the error; the caller shreds
          // the temp file).
          await backupSeams.zipChunk?.();
          step();
          hash.update(chunk);
          bytes += chunk.length;
          for (let off = 0; off < chunk.length; ) off += (await fh.write(chunk, off)).bytesWritten;
          cb();
        } catch (e) {
          cb(e as Error);
        }
      },
    });
    const out = zip.outputStream as unknown as Readable;
    // yazl reports a file-size mismatch (a file changed meanwhile) on the zip, not the stream.
    const failed = new Promise<never>((_r, j) => zip.once("error", j));
    failed.catch(() => {});
    const done = snap.key ? pipeline(out, encryptStream(snap.key.key, snap.key.keyId), sink) : pipeline(out, sink);
    done.catch(() => {});
    try {
      await Promise.race([done, failed]);
    } catch (err) {
      out.destroy();
      sink.destroy();
      throw err;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** In-progress temp files of this process (never swept while running). */
const activeTemps = new Set<string>();

/** Backups and prunes running in this process (their pending records are not settled meanwhile). */
const activeOps = new Set<string>();

// ------------------------------------------------------------------------------------------
// The maintenance lock (R138 a): backup, prune, restore and destruction of raw data run one at a
// time per project. It is not the repository's write queue: ordinary changes go on meanwhile.
// Holding it is explicit (N3): the section receives a hold, valid only while it runs, and passes it
// to the steps it makes itself (destruction's fresh backup and prune). Nothing inherits it: work
// scheduled from inside (a timer, a callback) that asks for the lock waits like anyone else.
// In-process only: the library lock keeps other processes out of a writable library.

/** Package-internal: a hold on a project's maintenance lock, valid only while its section runs. */
export interface MaintenanceHold {
  readonly key: string;
  active: boolean;
}

const maintenanceTails = new Map<string, Promise<unknown>>();

/**
 * Package-internal: runs `fn` holding the project's maintenance lock (waits for the one before).
 * With `held` (a hold the caller's own section was given), runs at once under that hold instead.
 */
export function withProjectMaintenance<T>(repo: Repo, projectId: string, fn: (hold: MaintenanceHold) => Promise<T>, held?: MaintenanceHold): Promise<T> {
  const key = `${repoLibrary(repo).root}\u0000${projectId}`;
  if (held) {
    if (held.key !== key || !held.active) return Promise.reject(new Error("The project's maintenance lock is not held by this operation"));
    return fn(held);
  }
  const prev = maintenanceTails.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const hold: MaintenanceHold = { key, active: true };
    try {
      return await fn(hold);
    } finally {
      hold.active = false;
    }
  });
  // A thrown error (or a simulated crash) releases it like a success.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  maintenanceTails.set(key, tail);
  void tail.then(() => {
    if (maintenanceTails.get(key) === tail) maintenanceTails.delete(key);
  });
  return run;
}

/** Overwrites and removes temp files left by interrupted backups (they may be plaintext zips), except those still pending. */
async function sweepTemps(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const pending = new Set(Object.values((await readState(dir)).pending).flatMap((op) => (op.kind === "create" && op.tmp ? [op.tmp] : [])));
  for (const n of names) if (BACKUP_TEMP.test(n) && !activeTemps.has(join(dir, n)) && !pending.has(n)) await shredPath(join(dir, n)).catch(() => {});
}

/** Raw data destroyed since the snapshot, a changed archive (R138 b, d): the backup was not kept. */
export class BackupDiscardedError extends Error {
  override name = "BackupDiscardedError";
}

const DESTROYED_MEANWHILE = "Raw data was destroyed under the retention rule while this backup was being made; the backup was not kept.";
const CHANGED_ON_DISK = "The backup file changed after it was written; the backup was not kept.";

/**
 * Package-internal (also retention): plain text for why a backup was not made: the engine's reason
 * for a refusal, the library's own message for its errors, else what failed with paths scrubbed.
 */
export function backupFailureReason(repo: Repo, err: unknown): string {
  if (err instanceof PolicyDeniedError) return err.reason;
  if (err instanceof BackupNotRecordedError || err instanceof BackupDiscardedError) return err.message;
  const msg = err instanceof Error ? scrubPaths(err.message, [repoLibrary(repo).root]).trim() : "";
  return `The backup could not be made (${msg || (err instanceof Error ? err.name : "unknown error")}).`;
}

async function recordFailure(repo: Repo, projectId: string, err: unknown): Promise<void> {
  // A locked project or a read-only library: nothing failed, it cannot run now (M3). Nor a closed one (R551 I2).
  if (err instanceof ProjectLockedError || err instanceof ReadOnlyLibraryError || cutByClose(err)) return;
  const at = repoClock(repo)().toISOString();
  const f: BackupFailure = { at, reason: backupFailureReason(repo, err), ...(err instanceof PolicyDeniedError ? { refused: true as const } : {}) };
  await withState(repo, (s) => {
    s.failures[projectId] = f;
  }).catch(() => {});
}

const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

/** Whether the project's audit log holds the event `action` whose `details[key]` is `id`. */
async function hasEvent(repo: Repo, projectId: string, action: string, key: string, id: string): Promise<boolean> {
  const p = repo.getProject(projectId);
  const events = await AuditStore.read(join(repoLibrary(repo).root, ...p.folder.split("/"), "audit"));
  return events.some((e) => e?.action === action && (e.details as Record<string, unknown> | undefined)?.[key] === id);
}

const projectExists = (repo: Repo, projectId: string) => repo.listProjects().some((p) => p.id === projectId);

/** Runs `fn` in the manifest's queue (the manifest and the state are written there). */
function underManifestLock<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
  const dir = backupsDir(repo);
  const prev = manifestLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(fn);
  manifestLocks.set(
    dir,
    run.catch(() => {}),
  );
  return run;
}

/**
 * Reserves a backup name not taken in Backups/ nor by another backup in progress (R138 b), and
 * records it (with the temp file, if given) in the backup's pending record.
 */
function reserveName(repo: Repo, backupId: string, wanted: string, tmp?: string): Promise<string> {
  const dir = backupsDir(repo);
  return underManifestLock(repo, async () => {
    const taken = await namesIn(dir);
    let out = wanted;
    await editStateNow(repo, dir, (s) => {
      const reserved = new Set(
        Object.entries(s.pending).flatMap(([id, op]) => (id !== backupId && op.kind === "create" && op.file ? [foldName(op.file)] : [])),
      );
      out = withCollisionSuffix(wanted, (n) => taken.has(foldName(n)) || reserved.has(foldName(n)));
      const p = s.pending[backupId];
      if (p?.kind === "create") Object.assign(p, { file: out, ...(tmp ? { tmp } : {}) });
    });
    return out;
  });
}

/**
 * Gives the finished temp file its backup name WITHOUT ever replacing a file (R138 b): a hard link
 * (fails if the name exists); where links are not supported, a rename checked under the manifest
 * queue (no other writer in this process; the library lock keeps other processes out). False: taken.
 */
async function placeExclusive(repo: Repo, tmp: string, final: string): Promise<boolean> {
  try {
    await fsp.link(tmp, final);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK", "EACCES"].includes(code ?? "")) throw err;
  }
  return underManifestLock(repo, async () => {
    if (await fsp.lstat(final).then(() => true, () => false)) return false;
    await fsp.rename(tmp, final);
    return true;
  });
}

/** Whether `final` is the backup's own file: the temp file's other name, or (temp gone) the recorded bytes. */
async function isOurs(final: string, tmp: string | undefined, sha256: string | undefined): Promise<boolean> {
  const f = await fsp.stat(final).catch(() => null);
  if (!f) return false;
  const t = tmp ? await fsp.stat(tmp).catch(() => null) : null;
  if (t) return t.ino === f.ino && t.dev === f.dev;
  return sha256 !== undefined && (await sha256Of(final)) === sha256;
}

/** Removes everything of an uncommitted backup: its backup name (only if it is ours) and its temp file. */
async function discardArchive(dir: string, op: { tmp?: string; file?: string; entry?: BackupEntry }): Promise<void> {
  const tmp = op.tmp ? join(dir, op.tmp) : undefined;
  if (op.file) {
    const final = join(dir, op.file);
    if (await isOurs(final, tmp, op.entry?.sha256)) {
      if (tmp && (await exists(tmp))) await fsp.rm(final, { force: true });
      else await shredPath(final);
    }
  }
  if (tmp) await shredPath(tmp);
}

/**
 * Settles backups and prunes that were interrupted (a crash, or a failure this process could not
 * resolve), by what the audit log says (R125). Writable libraries only; each record is tried again
 * next time if settling it fails. Runs when a project opens or is unlocked and before every backup
 * operation.
 */
async function settlePending(repo: Repo): Promise<void> {
  if (repoLibrary(repo).mode !== "read-write") return;
  // R560 M1: not in a closed library (the interrupted record and its files are left for the next opening), unless the
  // close already waits for the caller; otherwise counted in the close's wait while it settles.
  await whileOpenOrWaited(repoLibrary(repo), () => settlePendingNow(repo));
}

async function settlePendingNow(repo: Repo): Promise<void> {
  const state = await readState(backupsDir(repo));
  for (const [id, op] of Object.entries(state.pending)) {
    if (activeOps.has(id)) continue;
    activeOps.add(id);
    try {
      if (op.kind === "create") await settleCreate(repo, id, op);
      else await settlePrune(repo, id, op);
    } catch {
      // stays pending: tried again by the next backup operation or open
    } finally {
      activeOps.delete(id);
    }
  }
}

/**
 * A backup whose `backup.create` event is in the audit log is finished: given its name (if the
 * crash came first), checked against the recorded sha256 (M2) and listed. One without it is not a
 * backup: its files are removed, and the project shows `backup-failed`.
 */
async function settleCreate(repo: Repo, id: string, op: Extract<PendingOp, { kind: "create" }>): Promise<"committed" | "dropped"> {
  const dir = backupsDir(repo);
  const known = projectExists(repo, op.projectId);
  const committed = known && (await hasEvent(repo, op.projectId, "backup.create", "backupId", id));
  const at = repoClock(repo)().toISOString();
  const fail = (reason: string) =>
    withState(repo, (s) => {
      if (known) s.failures[op.projectId] = { at, reason };
      delete s.pending[id];
    });
  if (committed && op.file && op.entry) {
    const entry = op.entry;
    const tmp = op.tmp ? join(dir, op.tmp) : undefined;
    const final = join(dir, op.file);
    if (tmp && (await exists(tmp))) {
      if (await exists(final)) {
        if (await isOurs(final, tmp, entry.sha256)) await fsp.rm(tmp, { force: true });
      } else if (!(await placeExclusive(repo, tmp, final))) throw new Error("the backup's name is taken");
      else if (await exists(tmp)) await fsp.rm(tmp, { force: true });
    }
    if (!(await exists(final))) {
      await fail("The finished backup is missing from the Backups folder; it was not listed.");
      return "dropped";
    }
    if ((await sha256Of(final)) !== entry.sha256) {
      // Changed on disk after it was made: never listed as a backup (it would not restore).
      await shredPath(final);
      await fail("The finished backup was damaged on disk before it was listed; it was removed.");
      return "dropped";
    }
    await withManifest(repo, async (m) => list(m, entry));
    await withState(repo, (s) => {
      s.owners[entry.file] = op.projectId;
      delete s.failures[op.projectId]; // a backup succeeded
      delete s.pending[id];
    });
    return "committed";
  }
  await discardArchive(dir, op);
  await fail(BACKUP_INTERRUPTED);
  return "dropped";
}

/** Removed files of an interrupted prune whose `backup.prune` event is missing are recorded now (`recovered`). */
async function settlePrune(repo: Repo, id: string, op: Extract<PendingOp, { kind: "prune" }>): Promise<void> {
  const dir = backupsDir(repo);
  const gone: string[] = [];
  for (const f of op.files) if (f === basename(f) && !(await exists(join(dir, f)))) gone.push(f);
  if (gone.length && projectExists(repo, op.projectId) && !(await hasEvent(repo, op.projectId, "backup.prune", "pruneId", id))) {
    try {
      await appendLibraryEvent(repo, op.projectId, "backup.prune", { pruneId: id, files: gone, keep: op.keep, recovered: true });
    } catch (err) {
      await withState(repo, (s) => {
        const p = s.pending[id];
        if (p?.kind === "prune") p.auditFailed = true;
      });
      throw err;
    }
  }
  await withState(repo, (s) => {
    delete s.pending[id];
  });
}

/** Every kind of storage the Backups folder may be on (R125): its path and real path; an uncertain kind as every plausible one. */
async function backupDestinations(dir: string, env: LocationEnv): Promise<NonNullable<PolicyRequest["backup"]>["destinations"]> {
  const { destinations } = await locate(dir, env);
  return candidates(destinations).map(({ loc, guessed }) => ({
    destination: loc.kind,
    ...(loc.cloudFolderId ? { cloudFolderId: loc.cloudFolderId } : {}),
    ...(guessed ? { uncertain: true } : {}),
  }));
}

export interface BackupOptions {
  /** How many of the project's backups to keep (default: the project's setting, else 10). */
  keep?: number;
  /** False: no pruning after the backup (retention). */
  prune?: boolean;
  /** Where things are on this machine, to classify the library's folder (default: probed). */
  locationEnv?: LocationEnv;
  /**
   * R551 I2: the closing signal of the library's session (the service's). Once it is aborted the backup stops at its
   * next step, as when the library itself is closed: BackupCancelledError, nothing kept, nothing recorded.
   */
  signal?: AbortSignal;
}

/** The commit could not be appended (as opposed to a refusal or a discard at the commit point). */
class CommitAppendError extends Error {}

/**
 * Backs up the project to Backups/ and prunes its older backups to the newest `keep`
 * (default: the project's setting, else 10). Governed and audited (R125, R138; see the top of this
 * file): a refusal throws PolicyDeniedError and creates nothing. One at a time per project, with
 * pruning, restore and destruction (the maintenance lock). A failure or refusal is recorded as the
 * project's warning `backup-failed` (and thrown).
 */
export function backupProject(repo: Repo, projectId: string, opts: BackupOptions = {}): Promise<BackupResult> {
  return withProjectMaintenance(repo, projectId, (hold) => backupLocked(repo, projectId, opts, hold));
}

function backupLocked(repo: Repo, projectId: string, opts: BackupOptions, hold: MaintenanceHold): Promise<BackupResult> {
  const lib = repoLibrary(repo);
  return inFlight(lib, () => backupRun(repo, projectId, opts, hold, lib));
}

async function backupRun(repo: Repo, projectId: string, opts: BackupOptions, hold: MaintenanceHold, lib: Library): Promise<BackupResult> {
  // R551 I2: between its steps, up to its commit point, the backup stops once its library is closed or its session
  // closing (nothing is written by this check itself; what was written is taken back below).
  const projectName = repo.getProject(projectId).name;
  const cut = () => isClosed(lib) || opts.signal?.aborted === true;
  const step = () => {
    if (cut()) throw new BackupCancelledError(projectName);
  };
  step();
  const dir = backupsDir(repo);
  await fsp.mkdir(dir, { recursive: true });
  await settlePending(repo);
  await sweepTemps(dir);
  const tz = repoTz(repo);
  const warnings: string[] = [];
  const backupId = newId();
  let made: { entry: BackupEntry; project: Project };
  /** The pending record exists. */
  let recorded = false;
  /** The commit could not be confirmed either way: the pending record stays for the audit log to decide. */
  let undecided = false;
  const temps: string[] = [];
  try {
    step();
    if (backupSeams.failBackup) throw new Error("simulated backup failure");
    const destinations = await backupDestinations(dir, opts.locationEnv ?? (await defaultLocationEnv()));
    const request = { action: "backup" as const, backup: { destinations } };
    const entity = { type: "project" as const, id: projectId };
    // Recorded first, so an interruption from here on is settled (and shown) later.
    activeOps.add(backupId);
    await withState(repo, (s) => {
      s.pending[backupId] = { kind: "create", projectId, at: repoClock(repo)().toISOString() };
    });
    recorded = true;
    // 1. The decision, audited either way (a deny is audited and thrown by authorizeProcessing).
    const decision = await authorizeProcessing(repo, projectId, request, { op: "backup.create", entity, auditAllow: { details: { backupId } } });
    const mustSeal = decision.result === "allow_with_conditions" && decision.conditions.some((c) => c.type === "encrypt");
    crashPoint("after-decision");
    step();

    // 2. The zip, complete and fsynced under its temp name; the backup name reserved.
    let result: { snap: Snapshot; tmp: string; sha256: string; bytes: number; name: string; wanted: string } | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const snap = await snapshot(repo, projectId);
      try {
        // Never an unsealed backup of a project whose rules require encryption (the engine's condition).
        if (mustSeal && !snap.key) throw new PolicyDeniedError("Governance requires encryption at rest, but this project is not encrypted", "backup");
        await backupSeams.afterSnapshot?.();
        step();
        let wanted = datedFileName(`${snap.project.name} - backup`, new Date(snap.at), "zip", tz);
        if (snap.key) wanted = `${wanted}.enc`;
        const tmp = join(dir, `${wanted}.tmp-${randomBytes(6).toString("hex")}`);
        activeTemps.add(tmp);
        temps.push(tmp);
        const name = await reserveName(repo, backupId, wanted, basename(tmp));
        try {
          const header = { formatVersion: 1, projectId, projectName: snap.project.name, createdAt: snap.at, encrypted: !!snap.key, auditHead: snap.head, files: snap.files.length, assets: snap.assets };
          const r = await writeZip(tmp, snap, header, step);
          if (await changedSince(snap.files)) {
            if (attempt === 0) {
              await shredPath(tmp);
              activeTemps.delete(tmp);
              continue;
            }
            warnings.push("Some files changed while the backup was made, twice; this backup may not be one consistent state.");
          }
          result = { snap, tmp, name, wanted, ...r };
        } catch (err) {
          if (err instanceof SimulatedCrash) throw err;
          await shredPath(tmp).catch(() => {});
          activeTemps.delete(tmp);
          if (cutByClose(err)) throw err;
          // A file that changed size or went away while it was read: start again once.
          if (attempt === 0 && (await changedSince(snap.files))) continue;
          throw err;
        }
      } finally {
        snap.key?.key.fill(0);
      }
    }
    if (!result) throw new Error("the project kept changing while it was backed up");
    crashPoint("after-zip");
    const { snap } = result;
    const entryOf = (file: string): BackupEntry => ({
      file,
      projectId,
      createdAt: snap.at,
      sha256: result.sha256,
      bytes: result.bytes,
      encrypted: !!snap.key,
      files: snap.files.length,
      auditHead: snap.head,
      assets: snap.assets,
      ...(snap.keyFile ? { keyFile: snap.keyFile } : {}),
    });
    await withState(repo, (s) => {
      const p = s.pending[backupId];
      if (p?.kind === "create") Object.assign(p, { tmp: basename(result.tmp), file: result.name, entry: entryOf(result.name) });
    });
    await backupSeams.beforeCommit?.(hold);
    step();

    // 3. Its name, never over an existing file (a taken name gets the next counter), then the
    // bytes under that name checked against what was recorded (R138 b).
    let name = result.name;
    while (!(await placeExclusive(repo, result.tmp, join(dir, name)))) {
      name = await reserveName(repo, backupId, result.wanted);
      await withState(repo, (s) => {
        const p = s.pending[backupId];
        if (p?.kind === "create") Object.assign(p, { file: name, entry: entryOf(name) });
      });
    }
    const entry = entryOf(name);
    const final = join(dir, name);
    /** The attempt, so a refusal or a discard can be matched to its allow decision (N4). */
    const attempt = { op: "backup.create", backupId, file: name, at: "commit" };
    if ((await sha256Of(final)) !== result.sha256) {
      await withProjectQueue(repo, projectId, (ctx) => ctx.record("backup.discarded", { result: "deny", reason: CHANGED_ON_DISK }, attempt)).catch(() => {});
      throw new BackupDiscardedError(CHANGED_ON_DISK);
    }
    crashPoint("before-commit");
    step();

    // 4. The commit point, in one write-queue turn (R138 c, d): the decision again, against the
    // governance in force now (a deny is audited, with this attempt's id and name, and thrown); no
    // raw data destroyed since the snapshot (else audited as discarded); then the `backup.create` event.
    await withProjectQueue(repo, projectId, async (ctx) => {
      try {
        await ctx.decide(request, { op: "backup.create", entity, unaudited: true });
      } catch (err) {
        if (err instanceof PolicyDeniedError) await ctx.record("backup", { result: "deny", reason: err.reason }, attempt);
        throw err;
      }
      const destroyed = await destroyedAssetIds(repo, projectId);
      if (snap.assets.some((id) => destroyed.has(id))) {
        await ctx.record("backup.discarded", { result: "deny", reason: DESTROYED_MEANWHILE }, attempt);
        throw new BackupDiscardedError(DESTROYED_MEANWHILE);
      }
      try {
        await ctx.audit("backup.create", { backupId, file: name, sha256: result.sha256, bytes: result.bytes, encrypted: !!snap.key, files: snap.files.length });
      } catch (err) {
        throw new CommitAppendError("append failed", { cause: err });
      }
    }).catch(async (err: unknown) => {
      if (!(err instanceof CommitAppendError)) throw err;
      // The audit log decides: the event may have been written after all.
      activeTemps.delete(result.tmp);
      const outcome = await settleCreate(repo, backupId, { kind: "create", projectId, at: snap.at, tmp: basename(result.tmp), file: name, entry }).catch(() => "unsettled" as const);
      if (outcome === "unsettled") undecided = true;
      if (outcome !== "committed") throw new BackupNotRecordedError({ cause: err.cause });
    });
    crashPoint("after-commit");

    // 5. The temp name goes; the manifest lists it.
    try {
      if ((await exists(result.tmp)) && (await isOurs(final, result.tmp, undefined))) await fsp.rm(result.tmp, { force: true });
    } finally {
      activeTemps.delete(result.tmp);
    }
    crashPoint("before-manifest");
    await withManifest(repo, async (m) => list(m, entry));
    await withState(repo, (s) => {
      s.owners[entry.file] = projectId;
      delete s.failures[projectId];
      delete s.pending[backupId];
    });
    made = { project: snap.project, entry };
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err; // tests: the process "died" here
    if (recorded && !undecided) {
      // Nothing was committed (a committed backup does not get here): anything left of it goes.
      const p = (await readState(dir)).pending[backupId];
      if (p?.kind === "create") await discardArchive(dir, p).catch(() => {});
      await withState(repo, (s) => {
        delete s.pending[backupId];
      }).catch(() => {});
    }
    // R551 I2: cut by a close: neither a success nor a failure is recorded; whoever asked reads the one sentence.
    if (cutByClose(err)) throw err instanceof BackupCancelledError ? err : new BackupCancelledError(projectName);
    await recordFailure(repo, projectId, err);
    throw err;
  } finally {
    activeOps.delete(backupId);
    for (const t of temps) activeTemps.delete(t);
  }
  let pruned: string[] = [];
  // R551 I2: the backup is made and recorded; with the library closing, its older backups are left for the next one.
  if (opts.prune !== false && !cut()) {
    try {
      pruned = await pruneLocked(repo, projectId, opts.keep ?? made.project.backups?.keep ?? DEFAULT_KEEP);
    } catch (err) {
      // The backup itself is made and recorded; a removal that could not be recorded is said, not hidden.
      if (!(err instanceof PruneNotRecordedError)) throw err;
      pruned = err.removed;
      warnings.push(err.message);
    }
  }
  return { path: join(dir, made.entry.file), sha256: made.entry.sha256, bytes: made.entry.bytes, pruned, warnings };
}

/** Ids of the project's destroyed assets (retention). */
async function destroyedAssetIds(repo: Repo, projectId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, id);
    for (const a of sf.assets) if (a.status === "destroyed") out.add(a.id);
  }
  return out;
}

/**
 * Removes the project's backups beyond the newest `keep`: by the manifest's project id, backup-named
 * files only; a plain delete (R91). Audited by file name: one `backup.prune` event per run that
 * removed anything (R125). If that event cannot be written, the files stay removed and
 * PruneNotRecordedError is thrown; the removal is recorded later. Holds the maintenance lock (R138).
 */
export function pruneBackups(repo: Repo, projectId: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) return Promise.reject(new TypeError("keep must be a whole number of at least 1"));
  return withProjectMaintenance(repo, projectId, () => pruneLocked(repo, projectId, keep));
}

/** Package-internal (retention): a backup made under the hold the caller's own section has on the project. */
export function backupProjectHeld(repo: Repo, hold: MaintenanceHold, projectId: string, opts: BackupOptions = {}): Promise<BackupResult> {
  return withProjectMaintenance(repo, projectId, (h) => backupLocked(repo, projectId, opts, h), hold);
}

/** Package-internal (retention): pruning under the hold the caller's own section has on the project. */
export function pruneBackupsHeld(repo: Repo, hold: MaintenanceHold, projectId: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) return Promise.reject(new TypeError("keep must be a whole number of at least 1"));
  return withProjectMaintenance(repo, projectId, () => pruneLocked(repo, projectId, keep), hold);
}

async function pruneLocked(repo: Repo, projectId: string, keep: number): Promise<string[]> {
  const dir = backupsDir(repo);
  // Never in a library this computer does not hold for writing (R154 e): nothing is removed or noted.
  const lib = repoLibrary(repo);
  if (lib.mode !== "read-write") throw new ReadOnlyLibraryError(lib.readOnlyReason);
  if (isClosed(lib)) throw new LibraryClosedError(); // R551 I2: nothing removed from a closed library
  await settlePending(repo);
  const pruneId = newId();
  activeOps.add(pruneId);
  try {
    const removed = await withManifest(repo, async (m) => {
      const mine = m.backups.filter((b) => b.projectId === projectId && BACKUP_NAME.test(b.file) && b.file === basename(b.file));
      mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      const doomed = mine.slice(keep).map((b) => b.file);
      const out: string[] = [];
      if (!doomed.length) return out;
      // Recorded before the first removal, so a crash cannot lose the record of it.
      await editStateNow(repo, dir, (s) => {
        s.pending[pruneId] = { kind: "prune", projectId, at: repoClock(repo)().toISOString(), files: doomed, keep };
      });
      try {
        for (const f of doomed) {
          await fsp.rm(join(dir, f), { force: true });
          out.push(f);
        }
      } finally {
        m.backups = m.backups.filter((b) => !(b.projectId === projectId && out.includes(b.file)));
      }
      return out;
    });
    if (!removed.length) return removed;
    crashPoint("before-prune-audit");
    await backupSeams.beforePruneAudit?.();
    try {
      await appendLibraryEvent(repo, projectId, "backup.prune", { pruneId, files: removed, keep });
    } catch (err) {
      await withState(repo, (s) => {
        const p = s.pending[pruneId];
        if (p?.kind === "prune") Object.assign(p, { files: removed, auditFailed: true });
      }).catch(() => {});
      throw new PruneNotRecordedError(removed, { cause: err });
    }
    await withState(repo, (s) => {
      delete s.pending[pruneId];
    });
    return removed;
  } finally {
    activeOps.delete(pruneId);
  }
}


/**
 * Package-internal (retention, R147): removes backups named on a destruction's list (decided at the
 * destruction and recorded in the audit log), one by one, the manifest updated after each. A file
 * that is there is overwritten and removed (`removed`). One that is not there is `gone`: the app did
 * not remove it. Either way the manifest lists it no longer. A failure does not stop the others.
 * Only plain names of the backup pattern, inside Backups/, are ever touched. With `expect` (name →
 * sha256, for a list inherited through a restore, R175) a file is removed only when its bytes are
 * those: one of another content is `other` and is left alone, with its manifest entry. With `step`, it is called
 * before each file; what it throws ends the removals there (R554: the library's close), the ones made standing.
 */
export async function removeHoldingBackups(
  repo: Repo,
  files: string[],
  expect?: ReadonlyMap<string, string>,
  step?: () => void,
): Promise<{ removed: string[]; gone: string[]; other: string[]; failed: Array<{ file: string; error: unknown }> }> {
  const dir = backupsDir(repo);
  const removed: string[] = [];
  const gone: string[] = [];
  const other: string[] = [];
  const failed: Array<{ file: string; error: unknown }> = [];
  for (const f of files) {
    // R554: before each removal (never in the middle of one), the caller's step may stop the rest by throwing.
    step?.();
    if (!isBackupFileName(f) || (expect && !expect.has(f))) {
      failed.push({ file: f, error: new Error(isBackupFileName(f) ? "the making of this backup is not on record" : "this is not the name of a backup") });
      continue;
    }
    try {
      await withManifest(repo, async (m) => {
        const abs = join(dir, f);
        const present = await isThere(abs);
        // Another file under this name: not the backup that was meant. Left alone, with its manifest entry.
        if (present && expect && (await sha256Of(abs)) !== expect.get(f)) {
          other.push(f);
          return;
        }
        if (present) await shredPath(abs);
        forget(m, f);
        (present ? removed : gone).push(f);
      });
    } catch (error) {
      // The others are still tried; each failure is reported with its file (N1).
      failed.push({ file: f, error });
    }
  }
  return { removed, gone, other, failed };
}

/** Package-internal (retention, R147): clears the manifest entries of backups that are no longer in Backups/ (and only of those). */
export async function forgetMissingBackups(repo: Repo, files: string[]): Promise<void> {
  const dir = backupsDir(repo);
  const names = files.filter(isBackupFileName);
  if (!names.length) return;
  await withManifest(repo, async (m) => {
    for (const f of names) if (!(await isThere(join(dir, f)))) forget(m, f);
  });
}

/**
 * Lists a backup that was just made and recorded. A name is only ever given while no file has it
 * (R138 b), so an entry already under this name is of a backup removed outside the app: replaced.
 */
function list(m: BackupManifest, entry: BackupEntry): void {
  forget(m, entry.file);
  m.backups.push(entry);
}

function forget(m: BackupManifest, file: string): void {
  m.backups = m.backups.filter((b) => b.file !== file);
  if (m.unresolved) {
    m.unresolved = m.unresolved.filter((x) => x !== file);
    if (!m.unresolved.length) delete m.unresolved;
  }
}

/** Whether anything is at `path` (a link is not followed); an error other than "not there" is thrown. */
async function isThere(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Package-internal (retention, R147): how each named file in Backups/ stands now: whether it is
 * there, and its manifest entry when it can be read (one the manifest could not read before is
 * tried again). No entry: it cannot be read now.
 */
export async function backupFilesNow(repo: Repo, files: string[]): Promise<Map<string, { present: boolean; entry?: BackupEntry }>> {
  const dir = backupsDir(repo);
  await settlePending(repo);
  const m = await withManifest(repo, async (x) => x);
  const out = new Map<string, { present: boolean; entry?: BackupEntry }>();
  for (const f of files) {
    // Anything but a plain name is never looked for outside Backups/, and never counted as gone.
    const present = f === basename(f) ? await isThere(join(dir, f)) : true;
    let entry = present && isBackupFileName(f) ? m.backups.find((b) => b.file === f) : undefined;
    // One the manifest does not know at all (it was replaced, say) is read here; one it lists as unreadable was just tried.
    if (present && !entry && isBackupFileName(f) && !(m.unresolved ?? []).includes(f)) entry = await readEntry(repo, f);
    out.set(f, { present, ...(entry ? { entry } : {}) });
  }
  return out;
}

/** Package-internal (retention): what the state file notes of one destruction's backups still to remove, and why the app does not remove them by itself, if so. */
export interface DestructionNote {
  files: string[];
  problem?: string;
}

/**
 * Package-internal (retention, N1, R2-I2, R147): notes, for the warning `destruction-backups-pending`,
 * the backups one destruction (its certificate) still has to see removed. Kept per certificate, so
 * one destruction settling never clears another's.
 */
export function noteDestruction(repo: Repo, projectId: string, certificateRel: string, note: DestructionNote): Promise<void> {
  return withState(repo, (s) => {
    const mine = { ...(s.undestroyed[projectId] ?? {}) };
    const why = { ...(s.destructionProblems[projectId] ?? {}) };
    if (note.files.length) mine[certificateRel] = note.files;
    else delete mine[certificateRel];
    if (note.files.length && note.problem) why[certificateRel] = note.problem;
    else delete why[certificateRel];
    setOrDrop(s.undestroyed, projectId, mine);
    setOrDrop(s.destructionProblems, projectId, why);
  });
}

function setOrDrop<T>(all: Record<string, Record<string, T>>, projectId: string, mine: Record<string, T>): void {
  if (Object.keys(mine).length) all[projectId] = mine;
  else delete all[projectId];
}

/** Package-internal (retention, R147): the project's notes, by certificate (library-relative). */
export async function destructionNotes(repo: Repo, projectId: string): Promise<Record<string, DestructionNote>> {
  const s = await readState(backupsDir(repo));
  const files = Object.hasOwn(s.undestroyed, projectId) ? s.undestroyed[projectId]! : {};
  const why = Object.hasOwn(s.destructionProblems, projectId) ? s.destructionProblems[projectId]! : {};
  const out: Record<string, DestructionNote> = {};
  for (const [rel, list] of Object.entries(files)) out[rel] = { files: [...list], ...(Object.hasOwn(why, rel) ? { problem: why[rel]! } : {}) };
  return out;
}

/**
 * Package-internal (retention, R147): replaces the project's notes with what the audit log says
 * (every certificate at once: a stale or edited note does not survive a retry pass). Written only
 * when something differs.
 */
export async function setDestructionNotes(repo: Repo, projectId: string, notes: Record<string, DestructionNote>): Promise<void> {
  const wanted = Object.fromEntries(Object.entries(notes).filter(([, n]) => n.files.length));
  const same = (a: Record<string, DestructionNote>, b: Record<string, DestructionNote>) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const sorted = (x: Record<string, DestructionNote>) => Object.keys(x).sort().map((k) => [k, x[k]!.files, x[k]!.problem ?? null]);
  if (same(await destructionNotes(repo, projectId), wanted)) return;
  await withState(repo, (s) => {
    setOrDrop(s.undestroyed, projectId, Object.fromEntries(Object.entries(wanted).map(([k, n]) => [k, n.files])));
    setOrDrop(s.destructionProblems, projectId, Object.fromEntries(Object.entries(wanted).flatMap(([k, n]) => (n.problem ? [[k, n.problem]] : []))));
  });
}

/** Package-internal (retention, R379): the project's notes of old copies still holding destroyed files, by certificate (library-relative). */
export async function oldCopiesNotes(repo: Repo, projectId: string): Promise<Record<string, OldCopiesNote>> {
  const u = (await readState(backupsDir(repo))).oldCopiesUndestroyed;
  return Object.hasOwn(u, projectId) ? structuredClone(u[projectId]!) : {};
}

/**
 * Package-internal (retention, R379): replaces the project's notes of old copies (every certificate
 * at once, from the audit log, as setDestructionNotes does for backups). Written only when something differs.
 */
export async function setOldCopiesNotes(repo: Repo, projectId: string, notes: Record<string, OldCopiesNote>): Promise<void> {
  const wanted = Object.fromEntries(Object.entries(notes).filter(([, n]) => n.copies.length || n.unchecked));
  const key = (x: Record<string, OldCopiesNote>) => JSON.stringify(Object.keys(x).sort().map((k) => [k, x[k]!.copies.map((c) => [c.id, c.movedAt]), x[k]!.unchecked === true]));
  if (key(await oldCopiesNotes(repo, projectId)) === key(wanted)) return;
  await withState(repo, (s) => setOrDrop(s.oldCopiesUndestroyed, projectId, wanted));
}

/**
 * Package-internal (move, retention, R409 a): whether the notes in the Backups folder `dir` (any
 * project of that library) still name the old copy `id` as holding destroyed files. A note file
 * that is missing names none; one that cannot be read or parsed counts as naming it (the record of
 * the old copy is then kept: the warning errs toward staying, R147).
 */
export async function oldCopyNotedIn(dir: string, id: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsp.readFile(join(dir, BACKUPS_STATE), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!isObject(s)) return true;
  const notes = oldCopiesNotesOf(s.oldCopiesUndestroyed);
  return Object.values(notes).some((per) => Object.values(per).some((n) => n.copies.some((c) => c.id === id)));
}

/** Package-internal: every backup of the project still to be removed for a destruction (all certificates). */
export async function holdingNotRemoved(repo: Repo, projectId: string): Promise<string[]> {
  const u = (await readState(backupsDir(repo))).undestroyed;
  return Object.hasOwn(u, projectId) ? [...new Set(Object.values(u[projectId]!).flat())].sort() : [];
}

/**
 * Package-internal (retention, R2-I1): the retry record of one destruction's backups step: when it
 * was last tried, and how many tries since the audit log last heard of it. Bookkeeping for the
 * back-off only; what is outstanding, and when it was last recorded, come from the audit log (R147).
 */
export interface RetentionRetry {
  firstFailedAt: string;
  lastAttemptAt?: string;
  lastRecordedAt: string;
  attemptsSinceRecord: number;
  lastFreshAt?: string;
}

export async function retentionRetry(repo: Repo, key: string): Promise<RetentionRetry | undefined> {
  const r = (await readState(backupsDir(repo))).retries;
  return Object.hasOwn(r, key) ? r[key] : undefined;
}

export function setRetentionRetry(repo: Repo, key: string, rec: RetentionRetry | undefined): Promise<void> {
  return withState(repo, (s) => {
    if (rec) s.retries[key] = rec;
    else delete s.retries[key];
  });
}

/** Package-internal: an error's message in plain words, paths in the library scrubbed (its class name when it has none). */
export function plainErrorText(repo: Repo, err: unknown): string {
  const msg = err instanceof Error ? scrubPaths(err.message, [repoLibrary(repo).root]).trim() : "";
  return msg || (err instanceof Error ? err.name : "unknown error");
}

/** Sets the project's backup settings (governed, audited): `automatic` daily backups, how many to `keep`. */
export function setBackupSettings(repo: Repo, projectId: string, settings: { automatic?: boolean; keep?: number }): Promise<Project> {
  return setProjectBackupSettings(repo, projectId, settings);
}

/**
 * For the daily scheduler (Task 30): backs the project up when automatic backups are on (default),
 * the project is open for writing and unlocked, and its last backup is at least a day old. Null
 * when nothing was due (or it could not run now). A failure or a refusal (R125) is thrown and stays
 * as the project's warning `backup-failed`, with its reason. A refused one is asked again a day
 * later, not at every pass of the scheduler (one denial in the audit log a day, not one an hour).
 */
export function backupIfDue(repo: Repo, projectId: string, now: Date, opts: Pick<BackupOptions, "locationEnv" | "signal"> = {}): Promise<BackupResult | null> {
  // Whether one is due is decided while holding the project (R138 a): a manual backup running at
  // the same time makes this one not due, instead of a second backup.
  return withProjectMaintenance(repo, projectId, (hold) => backupIfDueLocked(repo, projectId, now, opts, hold));
}

async function backupIfDueLocked(repo: Repo, projectId: string, now: Date, opts: Pick<BackupOptions, "locationEnv" | "signal">, hold: MaintenanceHold): Promise<BackupResult | null> {
  const p = repo.getProject(projectId);
  if (p.backups?.automatic === false) return null;
  if (!repo.isUnlocked(projectId)) return null;
  const [last] = await listBackups(repo, projectId);
  if (last && now.getTime() - Date.parse(last.createdAt) < DAY_MS) return null;
  const failed = await backupFailure(repo, projectId);
  if (failed?.refused && now.getTime() - Date.parse(failed.at) < DAY_MS) return null;
  try {
    return await backupLocked(repo, projectId, opts, hold);
  } catch (err) {
    // Cannot run now: locked, read-only, or the library closed under it (R551 I2: nothing kept, nothing recorded).
    if (err instanceof ProjectLockedError || err instanceof ReadOnlyLibraryError || cutByClose(err)) return null;
    throw err;
  }
}

// ------------------------------------------------------------------------------------------
// Restore

export interface RestoreResult {
  projectId: string;
  /** Library-relative folder of the new project. */
  folder: string;
  /** What the restore left out or changed, and why (plain text). */
  notes: string[];
  /**
   * `retention-due`: the restored project's retention date has passed.
   * `destruction-backups-pending`: it inherits backups a destruction still lists for removal (R175).
   * `destruction-old-copies-pending`: it inherits old copies of the library a destruction named as not destroyed (R379).
   */
  warnings: string[];
  /**
   * Files not brought back because a destruction recorded in this library destroyed them (R174 d):
   * the source and asset (by their ids in the new project, where the asset is marked destroyed) and
   * when it was destroyed. `unverified`: the file was left out only because records the app cannot
   * vouch for name it as destroyed (a log that does not verify, a folder that could not be loaded,
   * a certificate taken as it is); that it was destroyed is not established, and `destroyedAt` is
   * what those records say (R182 d).
   */
  leftOut: Array<{ sourceId: string; assetId: string; destroyedAt: string; unverified?: true }>;
  /**
   * Complete lines of the Find and acquire queue and of watch registers that the restore could not open
   * and copied through unchanged (still unreadable in the copy). Showing it is a later task's.
   */
  linesCopiedUnread: { findQueue: number; watchRegister: number };
}

export interface RestoreOptions {
  /** A sealed backup of a locked project: its passphrase (or recovery code). */
  passphrase?: string;
  /** Where things are on this machine, to classify the library's folder (default: probed). */
  locationEnv?: LocationEnv;
}

async function freeBytes(dir: string): Promise<number> {
  if (backupSeams.freeBytes) return backupSeams.freeBytes(dir);
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** A backup's project.json is read whole to decide on it; larger than this it is not a backup the app made. */
const PROJECT_JSON_MAX = 256 * 1024 * 1024;

/** How a restore finds the key a sealed backup needs: from the key ring, or the one derived for this restore alone. */
type KeyOf = (keyId: string) => Uint8Array | undefined;

/** The answer for a sealed backup whose project is locked and no passphrase was given (as from the start). */
const lockedBackup = () => new RestoreError("This backup is encrypted: unlock its project, or give the project's passphrase");

/**
 * R435 b: a sealed backup refused for want of its key because ITS project (a project of this library with that key
 * id) was locked, or is being locked, while it was being read: a lock, never damage. Not the answer for a key id no
 * project here has, nor for any other failure (truncated, a flipped byte), which stay `UnreadableBackupError`.
 */
async function lockedMeanwhile(repo: Repo, abs: string, err: unknown, keyOf: KeyOf): Promise<boolean> {
  if (!(err instanceof KeyNotAvailableError)) return false;
  const keyId = await readKeyId(abs).catch(() => undefined);
  return keyId !== undefined && keyOf(keyId) === undefined && repo.listProjects().some((p) => p.encryption.keyId === keyId);
}

/** A backup file opened for reading single entries: as it is, or through the project key when sealed. */
async function openBackup(repo: Repo, abs: string, keyOf: KeyOf = (id) => keyFromRing(repo, id)): Promise<{ src: ZipSource; failure: () => unknown; close: () => Promise<void> }> {
  if (!abs.endsWith(".enc")) return { src: abs, failure: () => undefined, close: async () => {} };
  const z = await openSealedZip(abs, keyOf);
  return { src: { reader: z.reader, size: z.size }, failure: z.failure, close: z.close };
}

/**
 * The project a backup file says it is of (its backup.json, else its project.json), when it can be
 * read now: a sealed one only while its key is unlocked. Undefined otherwise.
 */
async function projectIdIn(repo: Repo, abs: string): Promise<string | undefined> {
  let z: Awaited<ReturnType<typeof openBackup>> | undefined;
  try {
    if (abs.endsWith(".enc") && !keyFromRing(repo, await readKeyId(abs))) return undefined;
    z = await openBackup(repo, abs);
    const header = await readArchiveEntry(z.src, "backup.json");
    const id = header ? (JSON.parse(header.toString("utf8")) as { projectId?: unknown }).projectId : undefined;
    if (typeof id === "string") return id;
    const pj = await readArchiveEntry(z.src, "project.json", PROJECT_JSON_MAX);
    const own = pj ? (JSON.parse(pj.toString("utf8")) as { project?: { id?: unknown } }).project?.id : undefined;
    return typeof own === "string" ? own : undefined;
  } catch (err) {
    // Locked meanwhile (R435 b): answered as for a project locked from the start, not run without its maintenance lock.
    // Defensive (R443 d, no test): without it the restore's key check answers locked too, but an unlock before that check would restore without the maintenance lock.
    if (await lockedMeanwhile(repo, abs, err, (id) => keyFromRing(repo, id))) throw lockedBackup();
    return undefined;
  } finally {
    await z?.close().catch(() => {});
  }
}

/**
 * What a restore is decided on (Task 50b), read from the archive itself before anything is
 * unpacked: the project it holds and the rules it carries (`governance.yaml`; none: the decision
 * is a refusal). The archive's names were checked already (extractArchive's first pass).
 */
async function restoreRequestOf(repo: Repo, abs: string, sealed: boolean, rest: Pick<RestoreRequest, "destinations" | "backupSha256" | "file">, keyOf: KeyOf): Promise<RestoreRequest> {
  const undecryptable = () => new UnreadableBackupError("This backup cannot be decrypted: it is damaged, or it was sealed with another key");
  const z = await openBackup(repo, abs, keyOf).catch(async (err: unknown) => {
    throw (await lockedMeanwhile(repo, abs, err, keyOf)) ? lockedBackup() : undecryptable();
  });
  try {
    const raw = await readArchiveEntry(z.src, "project.json", PROJECT_JSON_MAX);
    if (!raw) throw new UnreadableBackupError("This file is not a project backup (it has no project.json)");
    let project: Project;
    try {
      project = parseProjectJson(JSON.parse(raw.toString("utf8"))).project;
    } catch {
      throw new UnreadableBackupError("The backup's project.json cannot be read");
    }
    const rules = await readArchiveEntry(z.src, "governance.yaml");
    return {
      project: { id: project.id, name: project.name, encrypted: project.encryption.enabled, ...(project.timeZone ? { timeZone: project.timeZone } : {}) },
      governanceYaml: rules ? rules.toString("utf8") : null,
      sealed,
      ...rest,
    };
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    if (z.failure()) throw undecryptable();
    throw new UnreadableBackupError("The backup could not be read; it was not restored");
  } finally {
    await z.close().catch(() => {});
  }
}

/**
 * Restores a backup made by backupProject as a NEW project of this library (never over an existing
 * one). A sealed backup needs the project's key: the project unlocked in this app, or `passphrase`
 * (or the recovery code), checked against the key file the backup manifest kept.
 *
 * A restore never changes any project's lock state (I1). The key derived from `passphrase` reads
 * the backup and seals the copy's files, is held by this call alone and never put in the key ring,
 * and is zeroed when the call ends: allowed, refused or failed, every project is as locked or
 * unlocked afterwards as before, and nothing is readable that was not. The copy made that way is
 * locked until it is unlocked itself (audited as `key.unlock`). A locked original whose audit log
 * records no destruction does not stand in the way: its rules and its audit log are not sealed, and
 * nothing needs its key. One whose log records a destruction refuses the restore (R182 a): its
 * destruction certificate is sealed, the backup cannot be checked against it, and a destroyed file
 * must not come back because a project happened to be locked. The refusal names both ways out:
 * unlock that project and restore again, or restore into another library. Any other locked
 * project's sealed certificates are not read: the files it destroyed are known by id from its
 * audit log, and the restore says that the certificates were not read (R182 b).
 *
 * Governed (Task 50b, R138): before anything is written, the policy engine decides
 * (`action: 'restore'`) on the rules the backup carries, which become the new project's, and on the
 * rules the project it was made from has now when that project is in this library; both must allow
 * it. Every kind of storage the library's folder may be on must be in their `residency.allowed`, and
 * `encryption.atRest: required` gives an `encrypt` condition that a project which is not encrypted
 * cannot honour (refused: nothing comes back unencrypted under such rules). Rules that are missing
 * or cannot be read refuse it too. The decision is made again in the commit turn, under the write
 * queue, against the rules as unpacked and the original's rules then in force; the allow is recorded with its conditions in the copy's
 * `project.restored` event. A refusal throws PolicyDeniedError and is audited as a `restore` deny:
 * in the log of the project the backup belongs to when it is in this library, else in the library's
 * own log (never a path: the backup's sha256, and its file name when it is one of this library's).
 *
 * What is not brought back (R174 d, R179): files a destruction recorded in this library destroyed,
 * read from the audit logs (restore-record.ts `destroyedOnRecord`) before anything is unpacked and
 * again in the commit turn. While the audit log of the project the backup belongs to does not
 * verify, the restore is refused (DestructionRecordError, audited the same way; the backup can be
 * restored into another library). Another project's log that does not verify does not stop it, nor
 * does a folder in `Projects/` that could not be loaded as a project: whatever can still be read of
 * its audit log and its certificate files is taken as it is, and whatever that names is left out
 * (unverified evidence excludes, whatever its form). The answer says what was left out, and why.
 *
 * A file that is not a readable backup (no project in it, damaged, unsafe, changed since it was
 * made, its own audit log not verifying) is refused and recorded in the library's audit log by its
 * base name and the sha256 of the whole file (R179).
 *
 * A copy that inherits backups a destruction still lists for removal has its
 * `destruction-backups-pending` warning from the moment it is live (R175): the note behind it is
 * written in the commit turn, last before the rename, and taken back if the rename fails. (The note
 * lives in `Backups/backups-state.json`, outside every project folder, so no project transaction
 * can hold it; and no retry pass is run here, because a pass makes a backup and removes files.)
 *
 * One at a time with a backup, a prune and a destruction of the project the backup belongs to (the
 * maintenance lock, R138 a): by the manifest for one of this library's backups, else by what the
 * file itself says it is a backup of.
 */
export async function restoreBackup(repo: Repo, path: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const abs = resolve(path);
  const listed =
    resolve(dirname(abs)) === resolve(backupsDir(repo)) ? (await withManifest(repo, async (m) => m)).backups.find((b) => b.file === basename(abs))?.projectId : undefined;
  const owner = listed ?? (await projectIdIn(repo, abs));
  if (owner && projectExists(repo, owner)) return withProjectMaintenance(repo, owner, () => restoreLocked(repo, path, opts));
  return restoreLocked(repo, path, opts);
}

/** A refusal of the file itself: it is not a backup this app can read (not a backup, damaged, unsafe, or its own audit log does not verify). */
const notABackup = (err: unknown): err is Error => err instanceof UnreadableBackupError || err instanceof AuditChainInvalidError || err instanceof UnsafeFileError;

async function restoreLocked(repo: Repo, path: string, opts: RestoreOptions): Promise<RestoreResult> {
  const lib = repoLibrary(repo);
  if (lib.mode !== "read-write") throw new ReadOnlyLibraryError(lib.readOnlyReason);
  const abs = resolve(path);
  let backupSha256: string | undefined;
  try {
    // Of the whole file: what the restore records, and what a refusal of the file records (R179).
    backupSha256 = await sha256Of(abs).catch(() => {
      throw new UnreadableBackupError("This file could not be read; nothing was restored");
    });
    return await restoreHashed(repo, abs, backupSha256, opts);
  } catch (err) {
    // No refusal is silent (R154, R179): a file that is not a readable backup is recorded in the
    // library's own audit log by its base name and sha256, with the plain reason. Never its path.
    if (notABackup(err)) await refuseUnreadableBackup(repo, { file: basename(abs), ...(backupSha256 ? { sha256: backupSha256 } : {}), reason: err.message });
    throw err;
  }
}

async function restoreHashed(repo: Repo, abs: string, backupSha256: string, opts: RestoreOptions): Promise<RestoreResult> {
  const sealed = abs.endsWith(".enc");
  // The manifest entry, when the backup is one of this library's.
  const inBackups = resolve(dirname(abs)) === resolve(backupsDir(repo));
  const entry = inBackups ? (await withManifest(repo, async (m) => m)).backups.find((b) => b.file === basename(abs)) : undefined;
  if (entry && entry.sha256 !== backupSha256) throw new UnreadableBackupError("This backup was changed after it was made; it was not restored");

  /**
   * The key derived from the passphrase, for this restore alone (I1): it reads the backup and seals
   * the copy's files, and is never put in the key ring. So the restore unlocks nothing: the project
   * the backup was made from, and every other project, is as locked afterwards as before, whether
   * the restore is allowed, refused or fails; and the copy is locked until it is unlocked itself
   * (which is audited, as every unlock is). Zeroed when the restore ends.
   */
  let derived: { keyId: string; key: Uint8Array } | undefined;
  const keyOf: KeyOf = (id) => (derived && id === derived.keyId ? derived.key : keyFromRing(repo, id));
  try {
    if (sealed) {
      const keyId = await readKeyId(abs).catch(() => {
        throw new UnreadableBackupError("This backup cannot be decrypted: it is damaged, or it is not a backup made by this app");
      });
      if (!keyFromRing(repo, keyId)) {
        const kf = entry?.keyFile;
        if (!opts.passphrase || !kf || kf.keyId !== keyId) throw lockedBackup();
        let key: Uint8Array;
        try {
          key = await unwrapKey(kf.passphrase, opts.passphrase);
        } catch (err) {
          if (!(err instanceof WrongPassphraseError)) throw err;
          key = await unwrapWithRecovery(kf.recovery, opts.passphrase).catch(() => {
            throw new RestoreError("The passphrase does not open this backup");
          });
        }
        derived = { keyId, key };
      }
    }
    return await restoreOpened(repo, abs, backupSha256, opts, { sealed, inBackups, keyOf, ...(derived ? { key: derived } : {}) });
  } finally {
    derived?.key.fill(0);
  }
}

/** The restore itself, once the key a sealed backup needs is at hand (`keyOf`). */
async function restoreOpened(
  repo: Repo,
  abs: string,
  backupSha256: string,
  opts: RestoreOptions,
  how: { sealed: boolean; inBackups: boolean; keyOf: KeyOf; key?: { keyId: string; key: Uint8Array } },
): Promise<RestoreResult> {
  const lib = repoLibrary(repo);
  const { sealed, inBackups, keyOf } = how;
  let source: ZipSource = abs;
  let close: (() => Promise<void>) | undefined;
  let decryptFailure: (() => unknown) | undefined;
  if (sealed) {
    const z = await openSealedZip(abs, keyOf).catch(async (err: unknown) => {
      if (await lockedMeanwhile(repo, abs, err, keyOf)) throw lockedBackup(); // R435 b: locked, not audited as damage
      throw new UnreadableBackupError("This backup cannot be decrypted: it is damaged, or it was sealed with another key");
    });
    source = { reader: z.reader, size: z.size };
    close = z.close;
    decryptFailure = z.failure;
  }
  const projectsDir = join(lib.root, "Projects");
  const staging = join(projectsDir, `.creating-${newId()}`);
  const file = inBackups && isBackupFileName(basename(abs)) ? basename(abs) : undefined;
  /** Where the project would live, as the decision was asked: classified as for a backup (R125). */
  let destinations: RestoreRequest["destinations"] | undefined;
  /** The record of destructions as read before anything was unpacked; the commit turn reads again only what changed since. */
  let prior: DestroyedOnRecord | undefined;
  try {
    let entries;
    try {
      entries = await extractArchive(source, staging, BACKUP_LIMITS, undefined, {
        sparse: true,
        beforeWrite: async (declared) => {
          // Nothing is written yet. The policy engine decides, on the backup's own rules, the rules
          // its project has now if it is in this library, and where the library is; and what was
          // destroyed in this library must be readable with certainty. A refusal of either is
          // audited and thrown from here: nothing is unpacked.
          destinations = await backupDestinations(projectsDir, opts.locationEnv ?? (await defaultLocationEnv()));
          const request = await restoreRequestOf(repo, abs, sealed, { destinations, backupSha256, ...(file ? { file } : {}) }, keyOf);
          await authorizeRestore(repo, request);
          try {
            prior = await destroyedOnRecord(repo, { own: request.project.id });
          } catch (err) {
            if (err instanceof DestructionRecordError) await refuseRestore(repo, request, err);
            throw err;
          }
          if ((await freeBytes(projectsDir)) < declared + FREE_MARGIN) {
            throw new RestoreError("There is not enough free space on this disk to restore this backup");
          }
        },
      });
    } catch (err) {
      if (decryptFailure?.()) throw new UnreadableBackupError("This backup cannot be decrypted: it is damaged, or it was sealed with another key");
      throw err;
    } finally {
      await close?.();
    }
    if (entries.some((e) => e.refused)) throw new UnreadableBackupError("The backup holds two files with the same name; it was not restored");
    const headerRaw = await readMaybe(join(staging, "backup.json"));
    let expectedHead: { seq: number; hash: string } | null | undefined;
    if (headerRaw) {
      try {
        expectedHead = (JSON.parse(headerRaw.toString("utf8")) as { auditHead?: { seq: number; hash: string } | null }).auditHead;
      } catch {
        throw new UnreadableBackupError("The backup's description (backup.json) cannot be read");
      }
    }
    // Decided before the first file was written, or nothing was unpacked at all.
    if (!destinations) throw new UnreadableBackupError("The backup could not be read; it was not restored");
    const date = formatModified(repoClock(repo)(), repoTz(repo)).slice(0, 10);
    await restoreSeams.beforeAdopt?.(staging);
    const { project, notes, leftOut, warnings: inherited, linesCopiedUnread } = await adoptRestoredProject(repo, {
      staging,
      backupSha256,
      ...(expectedHead !== undefined ? { expectedHead } : {}),
      date,
      sealed,
      destinations,
      ...(file ? { file } : {}),
      // The key derived for this restore alone, when the project's own is not in the key ring.
      ...(how.key ? { key: how.key } : {}),
      // In the commit turn (it holds the write queue): what was destroyed, as the audit logs say now.
      destroyed: (own) => destroyedOnRecord(repo, { own, inQueue: true, ...(prior ? { prior } : {}) }),
      // In the commit turn, last before the copy goes live: the backups it inherits as still to be
      // removed are noted, so its warning stands from that moment (R175); taken back if it does not go live.
      beforeLive: async (copy) => {
        const outstanding = inheritedOutstanding(copy.events, copy.folder);
        // The old copies of the library a destruction named as not destroyed are inherited the same way (R379).
        const copies = inheritedOldCopies(copy.events, copy.folder);
        const warnings: string[] = [];
        if (Object.keys(outstanding).length) {
          await setDestructionNotes(repo, copy.projectId, outstanding);
          warnings.push(DESTRUCTION_BACKUPS_PENDING_WARNING);
        }
        if (Object.keys(copies).length) {
          await setOldCopiesNotes(repo, copy.projectId, copies);
          warnings.push(DESTRUCTION_OLD_COPIES_PENDING_WARNING);
        }
        if (!warnings.length) return { warnings, undo: async () => {} };
        return {
          warnings,
          undo: async () => {
            if (Object.keys(outstanding).length) await setDestructionNotes(repo, copy.projectId, {});
            if (Object.keys(copies).length) await setOldCopiesNotes(repo, copy.projectId, {});
          },
        };
      },
    });
    const warnings: string[] = [...inherited];
    const { policy } = await lookupPolicyInfo(repo, project.id);
    const due = policy?.retention.rawDataDestroyAfter;
    if (due && isDue(due, repoClock(repo)(), projectTimeZone(repo, project.id))) warnings.push("retention-due");
    return { projectId: project.id, folder: project.folder, notes, warnings, leftOut, linesCopiedUnread };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// Unresolved sealed backups are tried again as soon as a project is unlocked (R94).
onProjectUnlocked(async (repo) => {
  await withManifest(repo, async () => {});
});

// Backups and prunes interrupted by a crash are settled when the library opens (R125).
onProjectOpened(async (repo) => {
  await settlePending(repo);
});
