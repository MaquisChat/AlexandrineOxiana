/**
 * Opening a file named by untrusted input (a font path, a Zotero prefs.js) without being made to
 * wait (Task 57 M1, M4).
 *
 * The file is opened non-blocking, so a named pipe (FIFO) or a device answers at once instead of
 * holding one of the few file threads until a writer comes; what was opened is then checked with
 * fstat and must be a regular file before a byte is read, and every read goes through that one
 * handle, so nothing can be swapped in between the check and the read. With `noFollow`, a symbolic
 * link is refused at the open itself (on systems without O_NOFOLLOW, by an lstat first).
 */
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type OpenedFile = { ok: true; fh: FileHandle; size: number } | { ok: false; why: "cannot-open" | "not-a-file" };

/** Opens `p` for reading without waiting; the handle is given only when it is a regular file (the caller closes it). */
export async function openRegularFile(p: string, o: { noFollow?: boolean } = {}): Promise<OpenedFile> {
  if (o.noFollow && !O_NOFOLLOW) {
    try {
      if ((await lstat(p)).isSymbolicLink()) return { ok: false, why: "not-a-file" };
    } catch {
      return { ok: false, why: "cannot-open" };
    }
  }
  let fh: FileHandle;
  try {
    fh = await open(p, constants.O_RDONLY | O_NONBLOCK | (o.noFollow ? O_NOFOLLOW : 0));
  } catch (e) {
    // ELOOP: the last part of the path is a link and links are not followed.
    return { ok: false, why: (e as NodeJS.ErrnoException).code === "ELOOP" ? "not-a-file" : "cannot-open" };
  }
  try {
    const st = await fh.stat();
    if (st.isFile()) return { ok: true, fh, size: st.size };
  } catch {
    // fall through: closed below
  }
  await fh.close().catch(() => undefined);
  return { ok: false, why: "not-a-file" };
}

/** Reads `count` bytes from the start of an opened file, or fewer when it ends sooner. */
export async function readAll(fh: FileHandle, count: number): Promise<Buffer> {
  const buf = Buffer.alloc(count);
  let off = 0;
  while (off < count) {
    const r = await fh.read(buf, off, count - off, off);
    if (r.bytesRead === 0) break;
    off += r.bytesRead;
  }
  return buf.subarray(0, off);
}

/**
 * The text of a small regular file (UTF-8), or null when it is not one: missing, unreadable, a
 * link, a pipe, a device, a folder, or larger than `maxBytes` (also when it grows past it while read).
 */
export async function readSmallRegularFile(p: string, maxBytes: number): Promise<string | null> {
  const f = await openRegularFile(p, { noFollow: true });
  if (!f.ok) return null;
  try {
    if (f.size > maxBytes) return null;
    const data = await readAll(f.fh, maxBytes + 1);
    return data.length > maxBytes ? null : data.toString("utf8");
  } catch {
    return null;
  } finally {
    await f.fh.close().catch(() => undefined);
  }
}
