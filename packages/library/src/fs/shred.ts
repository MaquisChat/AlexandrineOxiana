/**
 * Overwrite-then-unlink (spec 6.3(5), R90 d): every regular file is overwritten in place with
 * zeros (its full length, flushed to the device with fsync) before it is removed; folders are
 * walked (symbolic links are removed, never followed).
 *
 * This is a best effort, and the destruction certificate says so: on SSDs (wear levelling), on
 * copy-on-write file systems (APFS, Btrfs, ZFS), with snapshots, and in folders a cloud sync
 * client or a backup tool copies, earlier copies of the bytes can survive an overwrite.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";

const CHUNK = 1024 * 1024;

/** Test seam: overwriting fails for the paths it matches (as an I/O error would). */
export const shredSeams: { failFor?: (path: string) => boolean } = {};

async function overwriteFile(path: string): Promise<void> {
  const fh = await fsp.open(path, "r+");
  try {
    const { size } = await fh.stat();
    const zeros = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    for (let off = 0; off < size; ) {
      const n = Math.min(zeros.length, size - off);
      off += (await fh.write(zeros, 0, n, off)).bytesWritten;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Overwrites and removes the file or folder at `path` (missing: nothing to do). */
export async function shredPath(path: string): Promise<void> {
  let st;
  try {
    st = await fsp.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(path)) await shredPath(join(path, name));
    await fsp.rm(path, { recursive: true, force: true });
    return;
  }
  if (shredSeams.failFor?.(path)) throw new Error("simulated overwrite failure");
  if (st.isFile()) await overwriteFile(path);
  await fsp.rm(path, { force: true });
}
