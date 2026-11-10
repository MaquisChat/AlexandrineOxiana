/**
 * Project backups (spec 9, R90 b).
 *
 * `backupProject` zips the whole project folder (everything but temp files `*.tmp-<hex>` and any
 * `.tmp` folder; symbolic links are skipped, never followed) to `<Library>/Backups/<project> -
 * backup - modified <YYYY-MM-DD HHmm>.zip`, written to a temp name and renamed into place (0600,
 * fsync). The zip begins with `backup.json` (project id, time, audit head). For an encrypted project
 * the ENTIRE zip is sealed with the project key in the encrypted file format (`.zip.enc`): the zip
 * is streamed through the encryption, so no plaintext zip (and no file name) ever reaches the disk.
 * The project is read inside the repository's write queue, so the backup is one consistent state.
 * Audited as `backup.create` (sha256, size, file count; no path).
 *
 * The sidecar manifest `Backups/backups-manifest.json` (0600) lists every backup the app made: file
 * name, project id, time, sha256, size, the audit head, the ids of the assets whose files it holds
 * (retention: backups holding destroyed data are found by it) and, for an encrypted project, the
 * project's key file (the data key wrapped by the passphrase and by the recovery code, as stored
 * in the project; never the key itself), so a backup can be restored with the passphrase even after
 * the project is gone. Pruning keeps the newest `keep` (default 10) and only ever removes files that
 * are listed in the manifest AND have the backup name of that project: nothing else in Backups/ is
 * touched.
 *
 * `restoreBackup` refuses anything that is not a safe archive (extractArchive: traversal, absolute
 * and symbolic-link entries refuse the whole archive; at most 100,000 entries and 2 GB in all —
 * the Bulk Import limits, except that one file may be as large as the whole, since field videos
 * exceed 50 MB), a sealed backup is read in place (crypto/random-access.ts: decrypted chunk by
 * chunk, never written out as a zip), its audit chain must verify (and match the head it
 * recorded), and it becomes a NEW project (repo/restore.ts): folder `<name> (restored <date>)`,
 * new ids, a `project.restored` event naming the backup's sha256. Nothing existing is overwritten.
 *
 * `backupIfDue(projectId, now)` (Task 30's daily scheduler): a backup when automatic backups are on
 * (`project.backups.automatic`, default on), the project is unlocked, and the last backup is a day
 * old (or there is none).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { datedFileName, formatModified, newId, type Project } from "@ao/core";
import { encryptStream, readKeyId } from "../crypto/format.js";
import { unwrapKey, unwrapWithRecovery, WrongPassphraseError } from "../crypto/keys.js";
import { openSealedZip } from "../crypto/random-access.js";
import { ARCHIVE_LIMITS, extractArchive, type ZipSource } from "../extract/zip.js";
import { UnsafeFileError } from "../extract/errors.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { foldName, namesIn, readMaybe } from "../repo/io.js";
import type { ProjectKeyFile } from "../repo/projects.js";
import { AuditChainInvalidError, RestoreError } from "../repo/restore.js";
import {
  addKeyToRing,
  adoptRestoredProject,
  keyFromRing,
  lookupPolicyInfo,
  repoClock,
  repoLibrary,
  repoTz,
  setProjectBackupSettings,
  withProjectQueue,
  type ProjectQueueContext,
  type Repo,
} from "../repo/repo.js";
import { withCollisionSuffix } from "@ao/core";

export { AuditChainInvalidError, RestoreError };

export const BACKUPS_MANIFEST = "backups-manifest.json";
export const DEFAULT_KEEP = 10;
const DAY_MS = 86_400_000;
/** Restore limits: the Bulk Import archive limits, one file up to the whole (see above). */
export const BACKUP_LIMITS = { ...ARCHIVE_LIMITS, maxEntryBytes: ARCHIVE_LIMITS.maxTotalBytes } as const;
const TEMP_FILE = /\.tmp-[0-9a-f]+$/u;

export interface BackupEntry {
  file: string;
  projectId: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  encrypted: boolean;
  files: number;
  auditHead: { seq: number; hash: string } | null;
  /** Ids of the assets whose files the backup holds (retention, R90 d). */
  assets: string[];
  /** Encrypted projects: the project's key file (wrapped keys only). */
  keyFile?: ProjectKeyFile;
}

interface BackupManifest {
  formatVersion: 1;
  backups: BackupEntry[];
}

export interface BackupResult {
  path: string;
  sha256: string;
  bytes: number;
  /** Backups removed by pruning (file names). */
  pruned: string[];
}

const backupsDir = (repo: Repo) => join(repoLibrary(repo).root, "Backups");

/** One manifest writer at a time per library folder (in-process; the library lock keeps other processes out). */
const manifestLocks = new Map<string, Promise<unknown>>();
function withManifest<T>(dir: string, fn: (m: BackupManifest) => Promise<T>): Promise<T> {
  const prev = manifestLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(async () => {
    const m = await readManifest(dir);
    const before = JSON.stringify(m);
    const out = await fn(m);
    if (JSON.stringify(m) !== before) await writeFileAtomic(join(dir, BACKUPS_MANIFEST), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
    return out;
  });
  manifestLocks.set(
    dir,
    run.catch(() => {}),
  );
  return run;
}

async function readManifest(dir: string): Promise<BackupManifest> {
  const raw = await readMaybe(join(dir, BACKUPS_MANIFEST));
  if (!raw) return { formatVersion: 1, backups: [] };
  try {
    const m = JSON.parse(raw.toString("utf8")) as BackupManifest;
    if (m.formatVersion !== 1 || !Array.isArray(m.backups)) throw new Error("bad manifest");
    return { formatVersion: 1, backups: m.backups.filter((b) => b && typeof b.file === "string" && typeof b.projectId === "string") };
  } catch {
    // Unreadable: it is kept aside (never silently emptied), and nothing is pruned meanwhile.
    const aside = join(dir, `${BACKUPS_MANIFEST}.unreadable-${Date.now()}`);
    await fsp.rename(join(dir, BACKUPS_MANIFEST), aside).catch(() => {});
    return { formatVersion: 1, backups: [] };
  }
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The backup name of a project (any date, any collision suffix). */
function backupNamePattern(projectName: string): RegExp {
  const stem = datedFileName(`${projectName} - backup`, new Date(0), "zip").replace(/ - modified .*$/u, "");
  return new RegExp(`^${escRe(stem)} - modified \\d{4}-\\d{2}-\\d{2} \\d{4}(?: \\(\\d+\\))?\\.zip(?:\\.enc)?$`, "u");
}

/** The project's backups the app made and that still exist, newest first. */
export async function listBackups(repo: Repo, projectId: string): Promise<BackupEntry[]> {
  const dir = backupsDir(repo);
  const m = await readManifest(dir);
  const out: BackupEntry[] = [];
  for (const b of m.backups) {
    if (b.projectId !== projectId) continue;
    if (await fsp.stat(join(dir, b.file)).then((s) => s.isFile(), () => false)) out.push(b);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

interface FileToZip {
  rel: string;
  abs: string;
  mtime: Date;
  size: number;
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
      out.push({ rel, abs, mtime: st.mtime, size: st.size });
    }
  }
  return out;
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

const DOS_EPOCH = new Date("1980-01-02T00:00:00Z");

/** Streams the zip of `files` (+ backup.json first) through `encrypt` (if any) into `tmp`. */
async function writeZip(tmp: string, header: Record<string, unknown>, files: FileToZip[], encrypt?: Transform): Promise<{ sha256: string; bytes: number }> {
  const out = new PassThrough();
  let zipError: Error | undefined;
  const zip = new Zip((err, data, final) => {
    if (err) {
      zipError = err;
      out.destroy(err);
      return;
    }
    out.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    if (final) out.end();
  });
  const hash = createHash("sha256");
  let bytes = 0;
  const fh = await fsp.open(tmp, "wx", 0o600);
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
  const writing = encrypt ? pipeline(out, encrypt, sink) : pipeline(out, sink);
  writing.catch(() => {}); // awaited below; errors also stop the producer
  const add = async (name: string, mtime: Date, deflate: boolean, chunks: AsyncIterable<Uint8Array> | Uint8Array[]) => {
    const f: ZipDeflate | ZipPassThrough = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    f.mtime = mtime < DOS_EPOCH ? DOS_EPOCH : mtime;
    zip.add(f);
    for await (const c of chunks) {
      if (zipError) throw zipError;
      f.push(c);
      if (out.writableNeedDrain) await new Promise<void>((r, j) => (out.once("drain", r), out.once("error", j)));
    }
    f.push(new Uint8Array(0), true);
  };
  try {
    await add("backup.json", new Date(), true, [Buffer.from(JSON.stringify(header, null, 2))]);
    for (const f of files) {
      // Encrypted files do not compress.
      await add(f.rel, f.mtime, !f.rel.endsWith(".enc"), createReadStream(f.abs) as AsyncIterable<Buffer>);
    }
    zip.end();
    await writing;
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Backs up the project to Backups/ and prunes its older backups to the newest `keep`
 * (default: the project's setting, else 10).
 */
export async function backupProject(repo: Repo, projectId: string, opts: { keep?: number; prune?: boolean } = {}): Promise<BackupResult> {
  const dir = backupsDir(repo);
  await fsp.mkdir(dir, { recursive: true });
  const { tz } = await lookupPolicyInfo(repo, projectId);
  const made = await withProjectQueue(repo, projectId, async (ctx: ProjectQueueContext) => {
    const projectDir = join(ctx.root, ...ctx.rel.split("/"));
    const files = await filesOf(projectDir);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > BACKUP_LIMITS.maxTotalBytes || files.length + 1 > BACKUP_LIMITS.maxEntries) {
      throw new UnsafeFileError("zip-too-large", "This project is too large to back up as one file (more than 2 GB or 100,000 files)");
    }
    const assets = await storedAssetIds(repo, projectId);
    const key = ctx.key();
    const at = ctx.at();
    const head = ctx.head();
    let name = datedFileName(`${ctx.project.name} - backup`, new Date(at), "zip", tz);
    if (key) name = `${name}.enc`;
    const taken = await namesIn(dir);
    name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
    const tmp = join(dir, `${name}.tmp-${randomBytes(6).toString("hex")}`);
    let result: { sha256: string; bytes: number };
    try {
      result = await writeZip(tmp, { formatVersion: 1, projectId, createdAt: at, encrypted: !!key, auditHead: head }, files, key ? encryptStream(key.key, key.keyId) : undefined);
      await fsp.rename(tmp, join(dir, name));
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    let keyFile: ProjectKeyFile | undefined;
    if (key) {
      const raw = await readMaybe(join(projectDir, "keys", "project-key.json"));
      if (raw) keyFile = JSON.parse(raw.toString("utf8")) as ProjectKeyFile;
    }
    await ctx.audit("backup.create", { sha256: result.sha256, bytes: result.bytes, encrypted: !!key, files: files.length });
    const entry: BackupEntry = {
      file: name,
      projectId,
      createdAt: at,
      sha256: result.sha256,
      bytes: result.bytes,
      encrypted: !!key,
      files: files.length,
      auditHead: head,
      assets,
      ...(keyFile ? { keyFile } : {}),
    };
    return { entry, project: ctx.project };
  });
  await withManifest(dir, async (m) => {
    m.backups.push(made.entry);
  });
  const pruned = opts.prune === false ? [] : await pruneBackups(repo, projectId, opts.keep ?? made.project.backups?.keep ?? DEFAULT_KEEP);
  return { path: join(dir, made.entry.file), sha256: made.entry.sha256, bytes: made.entry.bytes, pruned };
}

/** Removes the project's backups beyond the newest `keep` (manifest-listed, backup-named files only). */
export async function pruneBackups(repo: Repo, projectId: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError("keep must be a whole number of at least 1");
  const dir = backupsDir(repo);
  const pattern = backupNamePattern(repo.getProject(projectId).name);
  return withManifest(dir, async (m) => {
    const mine = m.backups.filter((b) => b.projectId === projectId && pattern.test(b.file) && b.file === basename(b.file));
    mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const removed: string[] = [];
    for (const b of mine.slice(keep)) {
      await fsp.rm(join(dir, b.file), { force: true });
      removed.push(b.file);
    }
    m.backups = m.backups.filter((b) => !removed.includes(b.file) || b.projectId !== projectId);
    return removed;
  });
}

/**
 * Package-internal (retention, R90 d): overwrites and removes the named backups of the project
 * (manifest-listed ones only) and drops them from the manifest. Returns the names removed.
 */
export async function destroyBackups(repo: Repo, projectId: string, files: string[]): Promise<string[]> {
  const dir = backupsDir(repo);
  return withManifest(dir, async (m) => {
    const removed: string[] = [];
    for (const b of m.backups) {
      if (b.projectId !== projectId || !files.includes(b.file) || b.file !== basename(b.file)) continue;
      await shredPath(join(dir, b.file));
      removed.push(b.file);
    }
    m.backups = m.backups.filter((b) => !(b.projectId === projectId && removed.includes(b.file)));
    return removed;
  });
}

/** Sets the project's backup settings (governed, audited): `automatic` daily backups, how many to `keep`. */
export function setBackupSettings(repo: Repo, projectId: string, settings: { automatic?: boolean; keep?: number }): Promise<Project> {
  return setProjectBackupSettings(repo, projectId, settings);
}

/**
 * For the daily scheduler (Task 30): backs the project up when automatic backups are on (default),
 * the project is open for writing and unlocked, and its last backup is at least a day old. Null
 * when nothing was due (or it could not run now).
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

export interface RestoreResult {
  projectId: string;
  /** Library-relative folder of the new project. */
  folder: string;
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
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
  const entry = resolve(dirname(abs)) === resolve(backupsDir(repo)) ? (await readManifest(backupsDir(repo))).backups.find((b) => b.file === basename(abs)) : undefined;
  if (entry && entry.sha256 !== backupSha256) throw new RestoreError("This backup was changed after it was made; it was not restored");

  let source: ZipSource = abs;
  let close: (() => Promise<void>) | undefined;
  if (sealed) {
    const keyId = await readKeyId(abs);
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
    const z = await openSealedZip(abs, (id) => keyFromRing(repo, id));
    source = { reader: z.reader, size: z.size };
    close = z.close;
  }
  const staging = join(lib.root, "Projects", `.creating-${newId()}`);
  try {
    let entries;
    try {
      entries = await extractArchive(source, staging, BACKUP_LIMITS);
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
    const project = await adoptRestoredProject(repo, { staging, backupSha256, ...(expectedHead !== undefined ? { expectedHead } : {}), date });
    return { projectId: project.id, folder: project.folder };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
