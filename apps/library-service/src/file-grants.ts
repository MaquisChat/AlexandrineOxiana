/**
 * File grants (Find and acquire Task F17; plan ruling 1 as settled in A1 and Ruling R329 a, b). The desktop shell's
 * library sign-in window fetches a PDF itself (Task F16), writes it into its private inbox
 * `<AO_CONFIG_DIR>/library-inbox/<grant>.pdf` (the folder 0700, the file 0600, emptied by the shell at its start and at
 * its quit) and names it on the service's standard input with ONE line:
 *
 *   {"type":"file-grant","id":"<32 hex>","ticket":"<32 hex>","path":"<absolute>"}
 *
 * This is the second (and last) line shape the service interprets after its token (R98, R155 as changed by R207 and by
 * ruling 1 for exactly this shape). It is acted on at once or discarded: no grant is kept waiting (R329 a).
 *
 * `parseFileGrantLine` is as strict as `parseGrantLine` (folder-grants.ts): the line must be byte for byte
 * `JSON.stringify` of the four keys in that order — no spaces, no other key, no duplicated key, no other escape form, no
 * byte-order mark — at most GRANT_LINE_MAX_BYTES; `id` and `ticket` 32 lower-case hexadecimal characters; `path`
 * absolute, well-formed text (no lone surrogate, R338 c), without NUL, at most GRANT_PATH_MAX_BYTES in UTF-8 (the
 * shell's own bound, `file_grant_line`). The one tolerance is the line reader's (startup-token.ts): one `\r` before the
 * line end is removed. A `..` in the path is a string like any other here; the check below makes such a path "outside".
 *
 * "Inside the inbox" means a file DIRECTLY in it (R338 a): a path in a subfolder of the inbox is outside, and is neither
 * read nor removed (the shell makes no subfolders).
 *
 * `takeInboxFile` takes the file, in this order, never acting on a path outside the inbox:
 *  1. the inbox: `lstat` — a directory, not a symbolic link, the user's, mode 0700 — else everything is refused and
 *     NOTHING is touched (not even deleted: a folder that is not the shell's private one is not the app's to clean);
 *     then its real path (`realpath` of the inbox itself, the only one ever asked for);
 *  2. the path's folder, AS TEXT (R338 b): `dirname(path)` must equal the inbox as given or the inbox's real path, else
 *     "outside": the path, and its folder, are never looked up, opened, deleted or echoed — no call of the file system
 *     names them (a `..`, a `.`, a doubled `/` or a link in a middle folder is outside). From here on the file is
 *     addressed as `<real inbox>/<its name>` only;
 *  3. its name: exactly the line's `id` + ".pdf";
 *  4. `lstat`: a regular file (not a link, a folder or a FIFO), the user's, one link only (a hard link's other name
 *     may be any file of the user's), at most the limit;
 *  5. `open` with O_NOFOLLOW and O_NONBLOCK (a link put in its place is not followed; a FIFO put in its place does not
 *     block), then `fstat` on the handle: regular, the same device and inode as the `lstat`, one link, within the limit;
 *  6. the bytes are read from that handle only, into a NEW file created exclusively (0600, O_NOFOLLOW), the limit
 *     enforced on what is read (a file that grows meanwhile is cut off and refused);
 *  7. in EVERY outcome from step 3 on — taken or refused — the inbox's entry of that name is removed as ONE entry
 *     (R338 d): `unlink` of a file or of a symbolic link itself (never its target); a folder there is left alone, never
 *     removed as a tree.
 * Every refusal is a code; no message, property or log line carries the path or the line.
 */
import { constants as FS } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { LIBRARY_FILE_MAX_BYTES } from "@ao/shared";
import { FolderGrants, GRANT_LINE_MAX_BYTES, GRANT_PATH_MAX_BYTES, grantLineHandler, parseGrantLine } from "./folder-grants.js";

/** The shell's inbox, under the app's settings folder. */
export const LIBRARY_INBOX = "library-inbox";
export const inboxOf = (appConfigDir: string): string => join(appConfigDir, LIBRARY_INBOX);

const FILE_GRANT_TYPE = "file-grant";
const HEX32 = /^[0-9a-f]{32}$/u;
/** A surrogate that is not half of a pair (R338 c: `!isWellFormed()`; a pair is one code point, never `Cs`). */
const LONE_SURROGATE = /\p{Cs}/u;

export interface FileGrant {
  id: string;
  ticket: string;
  path: string;
}

/** The file grant a line carries, or null for anything that is not exactly a file-grant line. */
export function parseFileGrantLine(line: string): FileGrant | null {
  if (typeof line !== "string" || !line.startsWith("{") || Buffer.byteLength(line, "utf8") > GRANT_LINE_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== 4 || o.type !== FILE_GRANT_TYPE) return null;
  const { id, ticket, path } = o;
  if (typeof id !== "string" || !HEX32.test(id) || typeof ticket !== "string" || !HEX32.test(ticket)) return null;
  if (typeof path !== "string" || path === "" || path.includes("\u0000") || LONE_SURROGATE.test(path) || !isAbsolute(path) || Buffer.byteLength(path, "utf8") > GRANT_PATH_MAX_BYTES) return null;
  // Exactly the shell's text: the keys in order, no spaces, the plain escapes, no duplicated or extra key.
  if (JSON.stringify({ type: FILE_GRANT_TYPE, id, ticket, path }) !== line) return null;
  return { id, ticket, path };
}

/**
 * What the entry point does with each line after the token (R98, R155, R207, ruling 1): the first shape (a folder
 * grant) is kept; the second (a file grant) is handed to `onFile` at once; anything else is discarded without a word.
 * A throw or a rejection of `onFile` is swallowed (nothing is echoed).
 */
export function inputLineHandler(grants: FolderGrants, onFile: (g: FileGrant) => unknown): (line: string) => void {
  const folder = grantLineHandler(grants);
  return (line) => {
    if (parseGrantLine(line)) return folder(line);
    const g = parseFileGrantLine(line);
    if (!g) return;
    try {
      const out = onFile(g);
      if (out instanceof Promise) out.catch(() => undefined);
    } catch {
      // dropped in silence
    }
  };
}

/** The file system as `takeInboxFile` uses it (a seam for tests; the real one by default). */
export interface InboxFs {
  lstat(path: string): Promise<import("node:fs").Stats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number, mode?: number): Promise<fsp.FileHandle>;
  unlink(path: string): Promise<void>;
}
const realFs: InboxFs = {
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  open: (p, flags, mode) => fsp.open(p, flags, mode),
  unlink: (p) => fsp.unlink(p),
};

/** Why a file was not taken. `inbox` and `outside`: nothing was touched; every other: the inbox's entry was removed (a folder is left alone). */
export type InboxRefusal = "inbox" | "outside" | "name" | "not-regular" | "not-yours" | "linked" | "too-large" | "changed" | "unreadable";

const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** The real path of the inbox when it is the shell's private folder (step 1), else null. */
async function inboxReal(inbox: string, fs: InboxFs): Promise<string | null> {
  try {
    const st = await fs.lstat(inbox);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const me = uid();
    if (me !== undefined && st.uid !== me) return null;
    if (process.platform !== "win32" && (st.mode & 0o777) !== 0o700) return null;
    return await fs.realpath(inbox);
  } catch {
    return null;
  }
}

/**
 * `<real inbox>/<name>` when the path's folder IS the inbox — compared as text with the inbox as given or its real path,
 * before (and without) any call of the file system — and its name is a plain one (step 2), else null.
 */
function insideInbox(inbox: string, realInbox: string, path: string): string | null {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\u0000")) return null;
  const name = basename(path);
  if (name === "" || name === "." || name === ".." || name.includes("/")) return null;
  const folder = dirname(path);
  return folder === inbox || folder === realInbox ? join(realInbox, name) : null;
}

/** Removes the inbox's entry `at` (already proved inside the inbox) as one entry: a file or a link; a folder stays. */
async function removeInside(at: string, fs: InboxFs): Promise<void> {
  try {
    if ((await fs.lstat(at)).isDirectory()) return;
    await fs.unlink(at);
  } catch {
    // gone already, or not removable: nothing more is done
  }
}

/**
 * Takes the file a file grant names (steps 1–7 above) into `to`: a new file, created exclusively. On success the
 * inbox's file is gone and `to` holds its bytes; on a refusal `to` does not exist (unless it existed before, which is
 * itself a refusal that leaves it as it was).
 */
export async function takeInboxFile(
  inbox: string,
  grant: { id: string; path: string },
  to: string,
  o: { fs?: InboxFs; maxBytes?: number; readChunk?: number } = {},
): Promise<{ ok: true; bytes: number } | { ok: false; why: InboxRefusal }> {
  const fs = o.fs ?? realFs;
  const max = Math.min(o.maxBytes ?? LIBRARY_FILE_MAX_BYTES, LIBRARY_FILE_MAX_BYTES);
  const realInbox = await inboxReal(inbox, fs);
  if (!realInbox) return { ok: false, why: "inbox" };
  const at = insideInbox(inbox, realInbox, grant.path);
  if (!at) return { ok: false, why: "outside" };
  try {
    return await takeAt(at, grant.id, to, max, o.readChunk ?? 1 << 20, fs);
  } finally {
    await removeInside(at, fs);
  }
}

async function takeAt(at: string, id: string, to: string, max: number, chunk: number, fs: InboxFs): Promise<{ ok: true; bytes: number } | { ok: false; why: InboxRefusal }> {
  if (typeof id !== "string" || !HEX32.test(id) || basename(at) !== `${id}.pdf`) return { ok: false, why: "name" };
  let before: import("node:fs").Stats;
  try {
    before = await fs.lstat(at);
  } catch {
    return { ok: false, why: "unreadable" };
  }
  if (!before.isFile()) return { ok: false, why: "not-regular" };
  const me = uid();
  if (me !== undefined && before.uid !== me) return { ok: false, why: "not-yours" };
  if (before.nlink !== 1) return { ok: false, why: "linked" };
  if (before.size > max) return { ok: false, why: "too-large" };
  let fh: fsp.FileHandle;
  try {
    fh = await fs.open(at, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (err) {
    // ELOOP: a link was put in its place.
    return { ok: false, why: (err as NodeJS.ErrnoException).code === "ELOOP" ? "changed" : "unreadable" };
  }
  let out: fsp.FileHandle | undefined;
  let made = false;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.nlink !== 1) return { ok: false, why: "changed" };
    if (st.size > max) return { ok: false, why: "too-large" };
    try {
      out = await fsp.open(to, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      made = true;
    } catch {
      return { ok: false, why: "unreadable" };
    }
    const buf = Buffer.alloc(Math.max(1, Math.min(chunk, max + 1)));
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) return { ok: false, why: "too-large" };
      await out.write(buf, 0, bytesRead);
    }
    await out.sync();
    made = false;
    return { ok: true, bytes: total };
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    await fh.close().catch(() => undefined);
    await out?.close().catch(() => undefined);
    if (made) await fsp.rm(to, { force: true }).catch(() => undefined);
  }
}

/**
 * Removes the file a refused file grant names — only when it is inside the inbox (steps 1–2); a path outside it, or an
 * inbox that is not the shell's private folder, is left untouched and unread.
 */
export async function discardInboxFile(inbox: string, path: string, fs: InboxFs = realFs): Promise<void> {
  const realInbox = await inboxReal(inbox, fs);
  if (!realInbox) return;
  const at = insideInbox(inbox, realInbox, path);
  if (at) await removeInside(at, fs);
}
