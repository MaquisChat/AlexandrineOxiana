/**
 * Crash-safe file writes: write to `<dest>.tmp-<random>` in the same
 * directory, fsync it, rename over the destination, then fsync the directory
 * (best effort). A crash leaves either the old file or the new one, plus at
 * worst a stray temp file that cleanupTempFiles removes later.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";

const TEMP_PATTERN = /\.tmp-[0-9a-f]+$/;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

function tempPathFor(dest: string): string {
  return `${dest}.tmp-${randomBytes(8).toString("hex")}`;
}

async function fsyncDir(dir: string): Promise<void> {
  // Not supported on every platform (e.g. Windows); the rename is still atomic.
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(dir, "r");
    await fh.sync();
  } catch {
    // best effort
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await fsp.unlink(path);
  } catch {
    // already gone, or we are crashing anyway
  }
}

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320];

/**
 * Windows rename retry. Antivirus scanners, indexers and sync clients briefly
 * hold files open there, making rename fail with EPERM/EACCES/EBUSY. We retry
 * up to 5 times (20 → 320 ms backoff, ~620 ms in all), only on win32 or when a
 * test sets `force`. Elsewhere those codes are real permission errors. Also
 * used for directory renames (trash, rollback, project staging).
 */
export const _renameRetry = {
  force: false,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function renameWithRetry(from: string, to: string): Promise<void> {
  const retry = process.platform === "win32" || _renameRetry.force;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retry || !RETRY_CODES.has(code) || delay === undefined) throw err;
      await _renameRetry.sleep(delay);
    }
  }
}

async function commit(tmp: string, dest: string): Promise<void> {
  await renameWithRetry(tmp, dest);
  await fsyncDir(dirname(dest));
}

/** Applies `mode` to an open temp file before it is renamed into place (ignored on Windows). */
async function applyMode(fh: fsp.FileHandle, mode: number | undefined): Promise<void> {
  if (mode === undefined || process.platform === "win32") return;
  await fh.chmod(mode);
}

export interface WriteOptions {
  /** POSIX permission bits for the file, e.g. 0o600 for key files. Ignored on Windows. */
  mode?: number;
}

/** Atomically replaces `path` with `data`. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  opts: WriteOptions = {},
): Promise<void> {
  const tmp = tempPathFor(path);
  // If the exclusive open fails, the temp path is not ours: never unlink it.
  const fh = await fsp.open(tmp, "wx", opts.mode);
  try {
    try {
      await applyMode(fh, opts.mode);
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await commit(tmp, path);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

export interface CopyOptions {
  /**
   * Optional transformation of the content on its way to disk (e.g.
   * `r => r.pipe(encryptStream(key, keyId))`). It receives the plaintext
   * stream and returns the stream to write; it must consume all of `r`.
   */
  transform?: (r: Readable) => Readable;
  /**
   * Optional decoding of the source before it is hashed (e.g. `r => r.pipe(decryptStream(getKey))`
   * for a source already in the library's encrypted format): the SHA-256 and byte count are then of
   * the decoded content.
   */
  decode?: (r: Readable) => Readable;
  /** POSIX permission bits for `dest`, e.g. 0o600. Ignored on Windows. */
  mode?: number;
}

/**
 * Atomically copies `src` to `dest`, optionally through `transform`.
 * Returns the SHA-256 (hex) and byte count of the source content, i.e. the
 * plaintext when `transform` encrypts.
 */
export async function copyFileAtomic(
  src: string,
  dest: string,
  opts: CopyOptions = {},
): Promise<{ sha256: string; bytes: number }> {
  // Open the temp file first so that every stream below gets its error
  // listeners attached synchronously, before any error can be emitted.
  const tmp = tempPathFor(dest);
  let fh: fsp.FileHandle | undefined = await fsp.open(tmp, "wx", opts.mode);
  const hash = createHash("sha256");
  let bytes = 0;
  const raw = createReadStream(src);
  const source: Readable = opts.decode ? opts.decode(raw) : raw;
  if (source !== raw) raw.on("error", (err) => source.destroy(err));
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  let out: Readable = hasher;
  try {
    await applyMode(fh, opts.mode);
    // `pipe` does not forward errors; do it by hand so the output fails too.
    source.on("error", (err) => hasher.destroy(err));
    const hashed = source.pipe(hasher);
    out = opts.transform ? opts.transform(hashed) : hashed;
    if (out !== hashed) hashed.on("error", (err) => out.destroy(err));
    for await (const chunk of out as AsyncIterable<Uint8Array>) {
      for (let off = 0; off < chunk.length; ) {
        off += (await fh.write(chunk, off)).bytesWritten;
      }
    }
    if (!hasher.writableFinished) {
      throw new Error("copyFileAtomic: transform did not consume the whole source");
    }
    await fh.sync();
    await fh.close();
    fh = undefined;
    await commit(tmp, dest);
    return { sha256: hash.digest("hex"), bytes };
  } catch (err) {
    raw.destroy();
    source.destroy();
    hasher.destroy();
    out.destroy();
    await fh?.close().catch(() => {});
    await removeQuietly(tmp);
    throw err;
  }
}

/**
 * Removes `*.tmp-*` files in `dir` (not recursive) whose mtime is more than
 * one hour before `now()`. Returns how many were removed.
 */
export async function cleanupTempFiles(
  dir: string,
  opts: { now?: () => number } = {},
): Promise<number> {
  const now = (opts.now ?? Date.now)();
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!TEMP_PATTERN.test(basename(name))) continue;
    const p = join(dir, name);
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile() || now - st.mtimeMs <= TEMP_MAX_AGE_MS) continue;
      await fsp.unlink(p);
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
}
