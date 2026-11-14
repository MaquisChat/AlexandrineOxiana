/**
 * A lock that holds across processes around a read-modify-write of one small file (R299 c): the app's service and the
 * command line are two processes on the same per-computer files, and a change one makes must not overwrite the
 * other's. It sits beside the atomic writer because it is about files, not about any one of them; a module that owns a
 * file (the Zotero sync settings) wraps each of its read-modify-writes in it, inside its own in-process turn.
 *
 *  - The lock is `<guarded file>.lock`, created EXCLUSIVELY (`wx`, 0600) beside the guarded file. It holds a random
 *    token and the time it was taken; nothing else (no path, no name, nothing secret).
 *  - It is held only while `step` runs: the caller's read, change and atomic write (milliseconds). Never across a
 *    request to a server or anything else that can wait.
 *  - A caller that finds it taken tries again every FILE_LOCK_RETRY_MS for up to FILE_LOCK_WAIT_MS, then fails with
 *    FileLockBusyError; `step` has not run, so nothing was written.
 *  - A lock whose FILE time (mtime, set by the system when the lock was created) differs from now by more than
 *    FILE_LOCK_STALE_MS, either way, was left by a process that died, and is taken over (R306 c: dated in the future, it
 *    was left before the clock was set back, and would otherwise hold the file until the clock caught up). The time written inside is for a person looking at the file
 *    and is not trusted: a file that died half-written has none, and the file's own time cannot be malformed.
 *  - Taking over is done by ONE waiter only: to remove a stale lock a waiter must first create, exclusively, the
 *    take-over file `<lock>.break-<the stale lock's token>`. Two waiters that both saw the same stale lock race for that
 *    one name and only one creates it; the other goes back to waiting. The one that has it reads the lock again and
 *    removes it only if it is still the same stale lock (same token, still old), then removes its take-over file. A
 *    token is random and never written twice, so once a stale lock is gone no later file at that place can carry its
 *    token, and a late waiter holding the take-over file for it finds a different token and removes nothing. Nobody
 *    else removes a lock but its holder (who checks its own token first), so between the take-over holder's check and
 *    its removal the lock cannot change. The lock itself is only ever taken by the exclusive create, so whichever
 *    waiter creates it first after the stale one is gone holds it, alone. A take-over file left by a process that died
 *    in the middle of a take-over is taken over in the same way (by `<take-over file>.break-<its token>`), at most
 *    FILE_LOCK_TAKEOVER_DEPTH levels deep.
 *  - It is released when `step` ends, on success and on every failure, and only by its holder: the token in the file is
 *    checked before the file is removed (a lock taken over meanwhile is left to its new holder).
 *  - A READ alone does not take it: the guarded file is replaced atomically (written to a temp file, then renamed), so a
 *    reader sees the old file or the new one, whole.
 *
 * The one case it does not cover is a holder that is alive but silent for more than FILE_LOCK_STALE_MS while it holds
 * the lock (a process stopped in a debugger, a computer put to sleep in those milliseconds): it is taken for dead.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";

/** How long a caller waits for a lock that is taken before it gives up (R299 c: 5 seconds). */
export const FILE_LOCK_WAIT_MS = 5_000;
/** How far (by the lock file's own time, before or after now) a lock must be to count as left by a process that died (R299 c, R306 c: 30 seconds). */
export const FILE_LOCK_STALE_MS = 30_000;
/** How often a waiting caller tries again. */
export const FILE_LOCK_RETRY_MS = 25;
/** How many take-overs of take-overs are followed before a lock is treated as simply taken (each needs a death mid take-over). */
export const FILE_LOCK_TAKEOVER_DEPTH = 3;

/** The guarded file is in use by another program: the wait ran out and nothing was done. The message names no path. */
export class FileLockBusyError extends Error {
  constructor() {
    super("The file is in use by another program. Try again.");
    this.name = "FileLockBusyError";
  }
}

/** The lock file could not be made at all (the folder cannot be written, say): nothing was done. No path. */
export class FileLockUnavailableError extends Error {
  constructor(readonly code: string) {
    super("The lock beside the file could not be made, so the file was not changed.");
    this.name = "FileLockUnavailableError";
  }
}

export interface FileLockOptions {
  /** Test seam: how long to wait for a taken lock (FILE_LOCK_WAIT_MS). */
  waitMs?: number;
  /** Test seam: how often to try again (FILE_LOCK_RETRY_MS). */
  retryMs?: number;
  /** Test seam: called when a waiter has seen a stale lock, before it acts on it (to make two waiters look first). */
  seenStale?: () => Promise<void>;
}

/** The lock file of `guarded`: `<guarded>.lock`, beside it. */
export const fileLockPath = (guarded: string): string => `${guarded}.lock`;

const TOKEN = /^[0-9a-f]{32}$/u;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (err: unknown): string => String((err as NodeJS.ErrnoException)?.code ?? "");

/** Creates `path` exclusively with a fresh token; undefined when it is already there. */
async function create(path: string): Promise<string | undefined> {
  const token = randomBytes(16).toString("hex");
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(path, "wx", 0o600);
  } catch (err) {
    if (codeOf(err) === "EEXIST") return undefined;
    throw new FileLockUnavailableError(codeOf(err));
  }
  try {
    try {
      await fh.writeFile(JSON.stringify({ token, at: new Date().toISOString() }));
    } finally {
      await fh.close();
    }
  } catch (err) {
    // Ours (the exclusive create succeeded): removed, so it is not left as a lock nobody holds.
    await fsp.unlink(path).catch(() => undefined);
    throw new FileLockUnavailableError(codeOf(err));
  }
  return token;
}

/** The token in a lock file, when it can be read as one. */
async function tokenIn(path: string): Promise<string | undefined> {
  try {
    const v = JSON.parse(await fsp.readFile(path, "utf8")) as { token?: unknown } | null;
    return typeof v?.token === "string" && TOKEN.test(v.token) ? v.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a lock file there now is: its identity (its token; for one with no readable token, which a process that died
 * between creating and writing it leaves, a digest of the file's identity and time) and whether it is stale by its
 * file time (more than FILE_LOCK_STALE_MS from now, either way). Undefined when it is not there.
 */
async function look(path: string): Promise<{ id: string; stale: boolean } | undefined> {
  let st;
  try {
    st = await fsp.lstat(path);
  } catch {
    return undefined;
  }
  const token = await tokenIn(path);
  const id = token ?? `x${createHash("sha256").update(`${st.ino}:${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 32)}`;
  return { id, stale: Math.abs(Date.now() - st.mtimeMs) > FILE_LOCK_STALE_MS };
}

/** Removes the lock at `path` only while it still carries `token` (only its holder removes a lock). Never throws. */
async function release(path: string, token: string): Promise<void> {
  try {
    if ((await tokenIn(path)) === token) await fsp.unlink(path);
  } catch {
    // already gone; or it cannot be removed, and it goes stale in its time
  }
}

/** One attempt to take the lock at `path` (no waiting); a stale lock is taken over first, by one waiter only. */
async function attempt(path: string, depth: number, o: FileLockOptions): Promise<string | undefined> {
  const mine = await create(path);
  if (mine !== undefined) return mine;
  const seen = await look(path);
  if (!seen?.stale || depth >= FILE_LOCK_TAKEOVER_DEPTH) return undefined;
  await o.seenStale?.();
  const takeover = `${path}.break-${seen.id}`;
  const held = await attempt(takeover, depth + 1, o);
  if (held === undefined) return undefined; // another waiter is taking it over
  try {
    const now = await look(path);
    if (now && now.id === seen.id && now.stale) await fsp.unlink(path).catch(() => undefined);
  } finally {
    await release(takeover, held);
  }
  return create(path);
}

/**
 * Runs `step` while holding the lock of `guarded` (see the top of this file). Throws FileLockBusyError when the lock
 * stays taken for the whole wait, and FileLockUnavailableError when it cannot be made; `step` has not run in either
 * case. `step`'s own errors come out unchanged, after the lock is released.
 */
export async function withFileLock<T>(guarded: string, step: () => Promise<T>, o: FileLockOptions = {}): Promise<T> {
  const path = fileLockPath(guarded);
  const until = Date.now() + (o.waitMs ?? FILE_LOCK_WAIT_MS);
  const every = o.retryMs ?? FILE_LOCK_RETRY_MS;
  let token: string | undefined;
  for (;;) {
    token = await attempt(path, 0, o);
    if (token !== undefined) break;
    const left = until - Date.now();
    if (left <= 0) throw new FileLockBusyError();
    await sleep(Math.min(every, left));
  }
  try {
    return await step();
  } finally {
    await release(path, token);
  }
}
