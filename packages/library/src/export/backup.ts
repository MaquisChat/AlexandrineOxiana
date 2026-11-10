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
 * Audited as `backup.create` (sha256, size, file count; no path).
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
import { datedFileName, formatModified, newId, withCollisionSuffix, type Project } from "@ao/core";
import { encryptStream, readKeyId } from "../crypto/format.js";
import { unwrapKey, unwrapWithRecovery, WrongPassphraseError } from "../crypto/keys.js";
import { openSealedZip } from "../crypto/random-access.js";
import { extractArchive, readArchiveEntry, type ZipSource } from "../extract/zip.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { foldName, namesIn, readMaybe } from "../repo/io.js";
import type { ProjectKeyFile } from "../repo/projects.js";
import { AuditChainInvalidError, RestoreError } from "../repo/restore.js";
import {
  addKeyToRing,
  adoptRestoredProject,
  appendLibraryEvent,
  keyFromRing,
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

/** Test seams. */
export const backupSeams: {
  failBackup?: boolean;
  /** Runs after each snapshot, outside the write queue, before the zip is written. */
  afterSnapshot?: () => Promise<void>;
  freeBytes?: (dir: string) => Promise<number>;
} = {};

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

interface BackupState {
  formatVersion: 1;
  /** Backup file → project id (rename-safe: never inferred from the project's current name). */
  owners: Record<string, string>;
  /** Projects whose last backup failed: the warning `backup-failed`. */
  failures: Record<string, { at: string; reason: string }>;
}

export const BACKUPS_STATE = "backups-state.json";

async function readState(dir: string): Promise<BackupState> {
  try {
    const raw = await readMaybe(join(dir, BACKUPS_STATE));
    const s = raw ? (JSON.parse(raw.toString("utf8")) as Partial<BackupState>) : {};
    return {
      formatVersion: 1,
      owners: s.owners && typeof s.owners === "object" ? s.owners : {},
      failures: s.failures && typeof s.failures === "object" ? s.failures : {},
    };
  } catch {
    return { formatVersion: 1, owners: {}, failures: {} };
  }
}

/** Edits the state (in the manifest's queue, so writes never interleave). */
function withState(repo: Repo, fn: (s: BackupState) => void): Promise<void> {
  const dir = backupsDir(repo);
  const prev = manifestLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(async () => {
    const s = await readState(dir);
    fn(s);
    await fsp.mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, BACKUPS_STATE), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  });
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

/** Overwrites and removes temp files left by interrupted backups (they may be plaintext zips). */
async function sweepTemps(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) if (BACKUP_TEMP.test(n) && !activeTemps.has(join(dir, n))) await shredPath(join(dir, n)).catch(() => {});
}

async function recordFailure(repo: Repo, projectId: string, err: unknown): Promise<void> {
  const at = repoClock(repo)().toISOString();
  await withState(repo, (s) => {
    s.failures[projectId] = { at, reason: err instanceof Error ? err.name : "Error" };
  }).catch(() => {});
}

/**
 * Backs up the project to Backups/ and prunes its older backups to the newest `keep`
 * (default: the project's setting, else 10). A failure is recorded as the project's warning
 * `backup-failed` (and thrown).
 */
export async function backupProject(repo: Repo, projectId: string, opts: { keep?: number; prune?: boolean } = {}): Promise<BackupResult> {
  const dir = backupsDir(repo);
  await fsp.mkdir(dir, { recursive: true });
  await sweepTemps(dir);
  const tz = repoTz(repo);
  const warnings: string[] = [];
  let made: { entry: BackupEntry; project: Project };
  try {
    if (backupSeams.failBackup) throw new Error("simulated backup failure");
    let result: { snap: Snapshot; tmp: string; sha256: string; bytes: number; name: string } | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const snap = await snapshot(repo, projectId);
      try {
        await backupSeams.afterSnapshot?.();
        let name = datedFileName(`${snap.project.name} - backup`, new Date(snap.at), "zip", tz);
        if (snap.key) name = `${name}.enc`;
        const taken = await namesIn(dir);
        name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
        const tmp = join(dir, `${name}.tmp-${randomBytes(6).toString("hex")}`);
        activeTemps.add(tmp);
        try {
          const header = { formatVersion: 1, projectId, projectName: snap.project.name, createdAt: snap.at, encrypted: !!snap.key, auditHead: snap.head, files: snap.files.length, assets: snap.assets };
          const r = await writeZip(tmp, snap, header);
          if (await changedSince(snap.files)) {
            if (attempt === 0) {
              await shredPath(tmp);
              continue;
            }
            warnings.push("Some files changed while the backup was made, twice; this backup may not be one consistent state.");
          }
          result = { snap, tmp, name, ...r };
        } catch (err) {
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
    try {
      await fsp.rename(result.tmp, join(dir, result.name));
    } finally {
      activeTemps.delete(result.tmp);
    }
    const { snap } = result;
    await appendLibraryEvent(repo, projectId, "backup.create", { sha256: result.sha256, bytes: result.bytes, encrypted: !!snap.key, files: snap.files.length });
    made = {
      project: snap.project,
      entry: {
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
      },
    };
  } catch (err) {
    await recordFailure(repo, projectId, err);
    throw err;
  }
  await withState(repo, (s) => {
    s.owners[made.entry.file] = projectId;
    delete s.failures[projectId];
  });
  await withManifest(repo, async (m) => {
    m.backups.push(made.entry);
  });
  const pruned = opts.prune === false ? [] : await pruneBackups(repo, projectId, opts.keep ?? made.project.backups?.keep ?? DEFAULT_KEEP);
  return { path: join(dir, made.entry.file), sha256: made.entry.sha256, bytes: made.entry.bytes, pruned, warnings };
}

/** Removes the project's backups beyond the newest `keep`: by the manifest's project id, backup-named files only. */
export async function pruneBackups(repo: Repo, projectId: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError("keep must be a whole number of at least 1");
  const dir = backupsDir(repo);
  return withManifest(repo, async (m) => {
    const mine = m.backups.filter((b) => b.projectId === projectId && BACKUP_NAME.test(b.file) && b.file === basename(b.file));
    mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const removed: string[] = [];
    for (const b of mine.slice(keep)) {
      await fsp.rm(join(dir, b.file), { force: true });
      removed.push(b.file);
    }
    m.backups = m.backups.filter((b) => !(b.projectId === projectId && removed.includes(b.file)));
    return removed;
  });
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
 * when nothing was due (or it could not run now). A failure is thrown and stays as the project's
 * warning `backup-failed`.
 */
export async function backupIfDue(repo: Repo, projectId: string, now: Date): Promise<BackupResult | null> {
  const p = repo.getProject(projectId);
  if (p.backups?.automatic === false) return null;
  if (!repo.isUnlocked(projectId)) return null;
  const [last] = await listBackups(repo, projectId);
  if (last && now.getTime() - Date.parse(last.createdAt) < DAY_MS) return null;
  try {
    return await backupProject(repo, projectId);
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
