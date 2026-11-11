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
 * is taken from the project again); files that cannot be read then are listed as `unresolved` and
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
 * key (and key id) of the project it was made from: unlocking either unlocks both.
 *
 * `backupIfDue(projectId, now)` (Task 30's daily scheduler): a backup when automatic backups are on
 * (`project.backups.automatic`, default on), the project is unlocked, and the last backup is a day
 * old (or there is none).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { datedFileName, formatModified, newId, withCollisionSuffix, type PolicyRequest, type Project } from "@ao/core";
import { encryptStream, readKeyId } from "../crypto/format.js";
import { unwrapKey, unwrapWithRecovery, WrongPassphraseError } from "../crypto/keys.js";
import { openSealedZip } from "../crypto/random-access.js";
import { extractArchive, readArchiveEntry, type ZipSource } from "../extract/zip.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { defaultLocationEnv, type LocationEnv } from "../location.js";
import { candidates, locate } from "../move.js";
import { AuditStore } from "../repo/audit-store.js";
import { PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { SimulatedCrash } from "../repo/seams.js";
import { foldName, namesIn, readMaybe } from "../repo/io.js";
import type { ProjectKeyFile } from "../repo/projects.js";
import { AuditChainInvalidError, RestoreError } from "../repo/restore.js";
import {
  addKeyToRing,
  adoptRestoredProject,
  appendLibraryEvent,
  authorizeProcessing,
  keyFromRing,
  onProjectOpened,
  onProjectUnlocked,
  lookupPolicyInfo,
  repoClock,
  repoLibrary,
  repoTz,
  setProjectBackupSettings,
  withProjectQueue,
  type ProjectQueueContext,
  type Repo,
} from "../repo/repo.js";
import { isDue, projectTimeZone } from "../retention-date.js";

export { AuditChainInvalidError, RestoreError };

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

/** Points in a backup or a prune where a test can simulate the process dying (R125). */
export type BackupCrashPoint = "after-decision" | "after-zip" | "before-commit" | "after-commit" | "before-manifest" | "before-prune-audit";

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
} = {};

function crashPoint(point: BackupCrashPoint): void {
  if (backupSeams.crashAt === point) {
    backupSeams.crashAt = undefined;
    throw new SimulatedCrash(`simulated crash at ${point}`);
  }
}

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
    if (JSON.stringify(m) !== before) await writeManifest(dir, m);
    return out;
  });
  manifestLocks.set(
    dir,
    run.catch(() => {}),
  );
  return run;
}

const writeManifest = async (dir: string, m: BackupManifest) => {
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, BACKUPS_MANIFEST), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
};

/** The manifest; a damaged one is kept aside and rebuilt from the backups themselves (R92 I2). */
async function loadManifest(repo: Repo): Promise<BackupManifest> {
  const dir = backupsDir(repo);
  const raw = await readMaybe(join(dir, BACKUPS_MANIFEST));
  if (!raw) return { formatVersion: 1, backups: [] };
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
    await fsp.rename(join(dir, BACKUPS_MANIFEST), join(dir, `${BACKUPS_MANIFEST}.unreadable-${Date.now()}`)).catch(() => {});
    const rebuilt = await rebuildManifest(repo);
    await writeManifest(dir, rebuilt);
    return rebuilt;
  }
  // Files a rebuild could not read are tried again every time (R94): e.g. a sealed backup whose
  // project has been unlocked since.
  if (m.unresolved?.length) {
    const still: string[] = [];
    let moved = false;
    for (const f of m.unresolved) {
      if (!(await fsp.stat(join(dir, f)).then((x) => x.isFile(), () => false))) {
        moved = true; // gone
        continue;
      }
      const e = await readEntry(repo, f);
      if (e && !m.backups.some((b) => b.file === f)) {
        m.backups.push(e);
        moved = true;
      } else if (e) moved = true;
      else still.push(f);
    }
    if (moved) {
      if (still.length) m.unresolved = still;
      else delete m.unresolved;
      await writeManifest(dir, m);
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

async function readState(dir: string): Promise<BackupState> {
  try {
    const raw = await readMaybe(join(dir, BACKUPS_STATE));
    const s = raw ? (JSON.parse(raw.toString("utf8")) as Partial<BackupState>) : {};
    return {
      formatVersion: 1,
      owners: s.owners && typeof s.owners === "object" ? s.owners : {},
      failures: s.failures && typeof s.failures === "object" ? s.failures : {},
      pending: pendingOf(s.pending),
    };
  } catch {
    return { formatVersion: 1, owners: {}, failures: {}, pending: {} };
  }
}

/** Reads, edits and writes the state; the caller holds the manifest's queue. */
async function editStateNow(dir: string, fn: (s: BackupState) => void): Promise<void> {
  const s = await readState(dir);
  fn(s);
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, BACKUPS_STATE), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
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
  const run = prev.then(() => editStateNow(dir, fn));
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

/** Every backup-named file, read back from its own backup.json; unreadable ones are `unresolved`. */
async function rebuildManifest(repo: Repo): Promise<BackupManifest> {
  const dir = backupsDir(repo);
  const m: BackupManifest = { formatVersion: 1, backups: [], unresolved: [] };
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => BACKUP_NAME.test(n)).sort();
  } catch {
    return m;
  }
  for (const file of names) {
    const e = await readEntry(repo, file);
    if (e) m.backups.push(e);
    else m.unresolved!.push(file);
  }
  return m;
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
    else if (f.endsWith(".enc")) mine = !!project.encryption.keyId && (await readKeyId(abs).catch(() => undefined)) === project.encryption.keyId;
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
async function writeZip(tmp: string, snap: Snapshot, header: Record<string, unknown>): Promise<{ sha256: string; bytes: number }> {
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
  const hash = createHash("sha256");
  let bytes = 0;
  const fh = await fsp.open(tmp, "wx", 0o600);
  try {
    const sink = new Writable({
      async write(chunk: Buffer, _enc, cb) {
        try {
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

/** Plain text kept with `backup-failed`: the engine's reason for a refusal, else what failed (never a message that may hold a path). */
function failureOf(err: unknown, at: string): BackupFailure {
  if (err instanceof PolicyDeniedError) return { at, reason: err.reason, refused: true };
  if (err instanceof BackupNotRecordedError) return { at, reason: err.message };
  return { at, reason: err instanceof Error ? err.name : "Error" };
}

async function recordFailure(repo: Repo, projectId: string, err: unknown): Promise<void> {
  const f = failureOf(err, repoClock(repo)().toISOString());
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

/**
 * Settles backups and prunes that were interrupted (a crash, or a failure this process could not
 * resolve), by what the audit log says (R125). Writable libraries only; each record is tried again
 * next time if settling it fails. Runs when a project opens or is unlocked and before every backup
 * operation.
 */
async function settlePending(repo: Repo): Promise<void> {
  if (repoLibrary(repo).mode !== "read-write") return;
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
 * A backup whose `backup.create` event is in the audit log is finished: renamed to its backup name
 * (if the crash came first) and listed in the manifest. One without it is not a backup: its temp
 * file is overwritten and removed, and the project shows `backup-failed`.
 */
async function settleCreate(repo: Repo, id: string, op: Extract<PendingOp, { kind: "create" }>): Promise<"committed" | "dropped"> {
  const dir = backupsDir(repo);
  const known = projectExists(repo, op.projectId);
  const committed = known && (await hasEvent(repo, op.projectId, "backup.create", "backupId", id));
  if (committed && op.file && op.entry) {
    const tmp = op.tmp ? join(dir, op.tmp) : undefined;
    const final = join(dir, op.file);
    if (tmp && !(await exists(final)) && (await exists(tmp))) await fsp.rename(tmp, final);
    const entry = op.entry;
    if (await exists(final)) {
      await withManifest(repo, async (m) => {
        if (!m.backups.some((b) => b.file === entry.file)) m.backups.push(entry);
      });
    }
    await withState(repo, (s) => {
      s.owners[entry.file] = op.projectId;
      delete s.failures[op.projectId]; // a backup succeeded
      delete s.pending[id];
    });
    return "committed";
  }
  if (op.tmp) await shredPath(join(dir, op.tmp));
  const at = repoClock(repo)().toISOString();
  await withState(repo, (s) => {
    if (known) s.failures[op.projectId] = { at, reason: BACKUP_INTERRUPTED };
    delete s.pending[id];
  });
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
}

/**
 * Backs up the project to Backups/ and prunes its older backups to the newest `keep`
 * (default: the project's setting, else 10). Governed and audited (R125, see the top of this file):
 * a refusal throws PolicyDeniedError and creates nothing. A failure or refusal is recorded as the
 * project's warning `backup-failed` (and thrown).
 */
export async function backupProject(repo: Repo, projectId: string, opts: BackupOptions = {}): Promise<BackupResult> {
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
    if (backupSeams.failBackup) throw new Error("simulated backup failure");
    const destinations = await backupDestinations(dir, opts.locationEnv ?? (await defaultLocationEnv()));
    // Recorded first, so an interruption from here on is settled (and shown) later.
    activeOps.add(backupId);
    await withState(repo, (s) => {
      s.pending[backupId] = { kind: "create", projectId, at: repoClock(repo)().toISOString() };
    });
    recorded = true;
    // 1. The decision, audited either way (a deny is audited and thrown by authorizeProcessing).
    const decision = await authorizeProcessing(
      repo,
      projectId,
      { action: "backup", backup: { destinations } },
      { op: "backup.create", entity: { type: "project", id: projectId }, auditAllow: { details: { backupId } } },
    );
    const mustSeal = decision.result === "allow_with_conditions" && decision.conditions.some((c) => c.type === "encrypt");
    crashPoint("after-decision");

    // 2. The zip, complete and fsynced under its temp name.
    let result: { snap: Snapshot; tmp: string; sha256: string; bytes: number; name: string } | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const snap = await snapshot(repo, projectId);
      try {
        // Never an unsealed backup of a project whose rules require encryption (the engine's condition).
        if (mustSeal && !snap.key) throw new PolicyDeniedError("Governance requires encryption at rest, but this project is not encrypted", "backup");
        await backupSeams.afterSnapshot?.();
        let name = datedFileName(`${snap.project.name} - backup`, new Date(snap.at), "zip", tz);
        if (snap.key) name = `${name}.enc`;
        const taken = await namesIn(dir);
        name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
        const tmp = join(dir, `${name}.tmp-${randomBytes(6).toString("hex")}`);
        activeTemps.add(tmp);
        temps.push(tmp);
        await withState(repo, (s) => {
          const p = s.pending[backupId];
          if (p?.kind === "create") p.tmp = basename(tmp);
        });
        try {
          const header = { formatVersion: 1, projectId, projectName: snap.project.name, createdAt: snap.at, encrypted: !!snap.key, auditHead: snap.head, files: snap.files.length, assets: snap.assets };
          const r = await writeZip(tmp, snap, header);
          if (await changedSince(snap.files)) {
            if (attempt === 0) {
              await shredPath(tmp);
              activeTemps.delete(tmp);
              continue;
            }
            warnings.push("Some files changed while the backup was made, twice; this backup may not be one consistent state.");
          }
          result = { snap, tmp, name, ...r };
        } catch (err) {
          if (err instanceof SimulatedCrash) throw err;
          await shredPath(tmp).catch(() => {});
          activeTemps.delete(tmp);
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
    const entry: BackupEntry = {
      file: result.name,
      projectId,
      createdAt: snap.at,
      sha256: result.sha256,
      bytes: result.bytes,
      encrypted: !!snap.key,
      files: snap.files.length,
      auditHead: snap.head,
      assets: snap.assets,
      ...(snap.keyFile ? { keyFile: snap.keyFile } : {}),
    };
    await withState(repo, (s) => {
      const p = s.pending[backupId];
      if (p?.kind === "create") Object.assign(p, { tmp: basename(result.tmp), file: result.name, entry });
    });
    crashPoint("before-commit");

    // 3. The commit point: the `backup.create` event. If it cannot be written, the audit log decides
    // (it may have been written after all); without it the backup is not kept.
    try {
      await appendLibraryEvent(repo, projectId, "backup.create", { backupId, file: result.name, sha256: result.sha256, bytes: result.bytes, encrypted: !!snap.key, files: snap.files.length });
    } catch (err) {
      activeTemps.delete(result.tmp);
      const outcome = await settleCreate(repo, backupId, { kind: "create", projectId, at: snap.at, tmp: basename(result.tmp), file: result.name, entry }).catch(() => "unsettled" as const);
      if (outcome === "unsettled") undecided = true;
      if (outcome !== "committed") throw new BackupNotRecordedError({ cause: err });
    }
    crashPoint("after-commit");

    // 4. Its name, then the manifest.
    try {
      if (await exists(result.tmp)) await fsp.rename(result.tmp, join(dir, result.name));
    } finally {
      activeTemps.delete(result.tmp);
    }
    crashPoint("before-manifest");
    await withManifest(repo, async (m) => {
      if (!m.backups.some((b) => b.file === entry.file)) m.backups.push(entry);
    });
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
      if (p?.kind === "create" && p.tmp) await shredPath(join(dir, p.tmp)).catch(() => {});
      await withState(repo, (s) => {
        delete s.pending[backupId];
      }).catch(() => {});
    }
    await recordFailure(repo, projectId, err);
    throw err;
  } finally {
    activeOps.delete(backupId);
    for (const t of temps) activeTemps.delete(t);
  }
  let pruned: string[] = [];
  if (opts.prune !== false) {
    try {
      pruned = await pruneBackups(repo, projectId, opts.keep ?? made.project.backups?.keep ?? DEFAULT_KEEP);
    } catch (err) {
      // The backup itself is made and recorded; a removal that could not be recorded is said, not hidden.
      if (!(err instanceof PruneNotRecordedError)) throw err;
      pruned = err.removed;
      warnings.push(err.message);
    }
  }
  return { path: join(dir, made.entry.file), sha256: made.entry.sha256, bytes: made.entry.bytes, pruned, warnings };
}

/**
 * Removes the project's backups beyond the newest `keep`: by the manifest's project id, backup-named
 * files only; a plain delete (R91). Audited by file name: one `backup.prune` event per run that
 * removed anything (R125). If that event cannot be written, the files stay removed and
 * PruneNotRecordedError is thrown; the removal is recorded later.
 */
export async function pruneBackups(repo: Repo, projectId: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError("keep must be a whole number of at least 1");
  const dir = backupsDir(repo);
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
      await editStateNow(dir, (s) => {
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
 * Package-internal (retention, R90 d, R92 I3): overwrites and removes the named backups of the
 * project one by one (manifest-listed ones), the manifest updated after each; a failure does not
 * stop the others. Returns the names removed, and the first error, if any.
 */
export async function destroyBackups(repo: Repo, projectId: string, files: string[]): Promise<{ deleted: string[]; error?: unknown }> {
  const dir = backupsDir(repo);
  const deleted: string[] = [];
  let first: unknown;
  for (const f of files) {
    if (f !== basename(f)) continue;
    try {
      await withManifest(repo, async (m) => {
        if (!m.backups.some((b) => b.projectId === projectId && b.file === f)) return;
        await shredPath(join(dir, f));
        m.backups = m.backups.filter((b) => !(b.projectId === projectId && b.file === f));
        deleted.push(f);
      });
    } catch (error) {
      // The others are still tried; the first failure is reported.
      first ??= error;
    }
  }
  return first === undefined ? { deleted } : { deleted, error: first };
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
export async function backupIfDue(repo: Repo, projectId: string, now: Date, opts: Pick<BackupOptions, "locationEnv"> = {}): Promise<BackupResult | null> {
  const p = repo.getProject(projectId);
  if (p.backups?.automatic === false) return null;
  if (!repo.isUnlocked(projectId)) return null;
  const [last] = await listBackups(repo, projectId);
  if (last && now.getTime() - Date.parse(last.createdAt) < DAY_MS) return null;
  const failed = await backupFailure(repo, projectId);
  if (failed?.refused && now.getTime() - Date.parse(failed.at) < DAY_MS) return null;
  try {
    return await backupProject(repo, projectId, opts);
  } catch (err) {
    if (err instanceof ProjectLockedError || err instanceof ReadOnlyLibraryError) return null;
    throw err;
  }
}

// ------------------------------------------------------------------------------------------
// Restore

export interface RestoreResult {
  projectId: string;
  /** Library-relative folder of the new project. */
  folder: string;
  /** What the restore left out or changed (plain text). */
  notes: string[];
  /** `retention-due`: the restored project's retention date has passed. */
  warnings: string[];
}

async function freeBytes(dir: string): Promise<number> {
  if (backupSeams.freeBytes) return backupSeams.freeBytes(dir);
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Restores a backup made by backupProject as a NEW project of this library (never over an existing
 * one). A sealed backup needs the project's key: the project unlocked in this app, or `passphrase`
 * (or the recovery code), checked against the key file the backup manifest kept.
 */
export async function restoreBackup(repo: Repo, path: string, opts: { passphrase?: string } = {}): Promise<RestoreResult> {
  const lib = repoLibrary(repo);
  if (lib.mode !== "read-write") throw new ReadOnlyLibraryError(lib.readOnlyReason);
  const abs = resolve(path);
  const sealed = abs.endsWith(".enc");
  const backupSha256 = await sha256Of(abs);
  // The manifest entry, when the backup is one of this library's.
  const entry = resolve(dirname(abs)) === resolve(backupsDir(repo)) ? (await withManifest(repo, async (m) => m)).backups.find((b) => b.file === basename(abs)) : undefined;
  if (entry && entry.sha256 !== backupSha256) throw new RestoreError("This backup was changed after it was made; it was not restored");

  let source: ZipSource = abs;
  let close: (() => Promise<void>) | undefined;
  let decryptFailure: (() => unknown) | undefined;
  if (sealed) {
    const keyId = await readKeyId(abs).catch(() => {
      throw new RestoreError("This backup cannot be decrypted: it is damaged, or it is not a backup made by this app");
    });
    if (!keyFromRing(repo, keyId)) {
      const kf = entry?.keyFile;
      if (!opts.passphrase || !kf || kf.keyId !== keyId) throw new RestoreError("This backup is encrypted: unlock its project, or give the project's passphrase");
      let key: Uint8Array;
      try {
        key = await unwrapKey(kf.passphrase, opts.passphrase);
      } catch (err) {
        if (!(err instanceof WrongPassphraseError)) throw err;
        key = await unwrapWithRecovery(kf.recovery, opts.passphrase).catch(() => {
          throw new RestoreError("The passphrase does not open this backup");
        });
      }
      addKeyToRing(repo, keyId, key);
      key.fill(0);
    }
    const z = await openSealedZip(abs, (id) => keyFromRing(repo, id)).catch(() => {
      throw new RestoreError("This backup cannot be decrypted: it is damaged, or it was sealed with another key");
    });
    source = { reader: z.reader, size: z.size };
    close = z.close;
    decryptFailure = z.failure;
  }
  const projectsDir = join(lib.root, "Projects");
  const staging = join(projectsDir, `.creating-${newId()}`);
  try {
    let entries;
    try {
      entries = await extractArchive(source, staging, BACKUP_LIMITS, undefined, {
        sparse: true,
        beforeWrite: async (declared) => {
          if ((await freeBytes(projectsDir)) < declared + FREE_MARGIN) {
            throw new RestoreError("There is not enough free space on this disk to restore this backup");
          }
        },
      });
    } catch (err) {
      if (decryptFailure?.()) throw new RestoreError("This backup cannot be decrypted: it is damaged, or it was sealed with another key");
      throw err;
    } finally {
      await close?.();
    }
    if (entries.some((e) => e.refused)) throw new RestoreError("The backup holds two files with the same name; it was not restored");
    const headerRaw = await readMaybe(join(staging, "backup.json"));
    let expectedHead: { seq: number; hash: string } | null | undefined;
    if (headerRaw) {
      try {
        expectedHead = (JSON.parse(headerRaw.toString("utf8")) as { auditHead?: { seq: number; hash: string } | null }).auditHead;
      } catch {
        throw new RestoreError("The backup's description (backup.json) cannot be read");
      }
    }
    const date = formatModified(repoClock(repo)(), repoTz(repo)).slice(0, 10);
    const { project, notes } = await adoptRestoredProject(repo, { staging, backupSha256, ...(expectedHead !== undefined ? { expectedHead } : {}), date });
    const warnings: string[] = [];
    const { policy } = await lookupPolicyInfo(repo, project.id);
    const due = policy?.retention.rawDataDestroyAfter;
    if (due && isDue(due, repoClock(repo)(), projectTimeZone(repo, project.id))) warnings.push("retention-due");
    return { projectId: project.id, folder: project.folder, notes, warnings };
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
