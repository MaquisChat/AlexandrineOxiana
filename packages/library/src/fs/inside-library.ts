/**
 * "Inside the library" (R310 h, R362 c): the one rule by which watched folders, the attach and the folder import keep
 * out what is already the library's — every project, the files found and held for the researcher's check
 * (`find/held/`), the backups, the index and the caches. Compared by REAL path (links followed; a path that does not
 * exist yet by its nearest existing parent), so a link outside the library that leads into it, a path written with
 * `..`, or (on macOS and Windows, whose disks usually ignore letter case) the same path in another case, is inside.
 *
 * Two uses (R368 d):
 * - The attach, the imports, the consent form's and the protocol document's drop (`realInsideLibrary`, `insideLibrary`,
 *   `importOverlapsLibrary`) also ask the disk: a path is inside when any existing folder on its real path, from the path
 *   up to the root, IS the library's folder by device and inode. That sees a second spelling of the same folder that no
 *   comparison of names can: a mount or bind mount of the library, macOS's `/System/Volumes/Data/…` (a firmlink, which
 *   realpath does not rewrite), a case-insensitive volume on Linux. A few stats per path (a path has few ancestors); a
 *   stat that fails is "not that folder", never an error.
 * - Watched folders (`overlapsLibrary`, watch.ts) compare names only: every call they make on their folder goes through
 *   that folder's one gate (R208 d), so this module adds no file-system call to their check.
 *
 * Limit: a HARD link to a library file, made outside the library, is a second name of the same file, not of a folder:
 * no check of paths can see it (the file's own inode would have to be compared with every file in the library). Nothing
 * in the app makes one.
 */
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

/** Whether `p` lies strictly below `folder` (both absolute, compared as written). */
export const within = (folder: string, p: string) => {
  const rel = relative(folder, p);
  // A name that merely starts with ".." (`..inner`) is inside (R233 M2): only ".." itself or "../…" is outside.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * The real path of `p`; for a path that does not exist (yet), the real path of its nearest existing parent with the
 * rest appended (a work folder not yet created, under a library reached through a symbolic link, still compares equal
 * to the files later found in it; R70).
 */
export async function realOrNearest(p: string): Promise<string> {
  const abs = resolve(p);
  const rest: string[] = [];
  for (let cur = abs; ; ) {
    try {
      const r = await fsp.realpath(cur);
      return rest.length ? join(r, ...rest.reverse()) : r;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** macOS and Windows disks usually ignore letter case (and macOS the Unicode form): the safe side is to ignore it too. */
const foldsCase = (platform: NodeJS.Platform) => platform === "darwin" || platform === "win32";

/**
 * Whether `p` is `folder` or lies below it, by name (both real paths). On macOS and Windows the names are compared
 * without regard to letter case or Unicode form (a real path normally comes back in the disk's own spelling already;
 * this is for a disk or a call that does not), so at worst a folder that only differs in case counts as inside.
 */
export function insideFolder(folder: string, p: string, platform: NodeJS.Platform = process.platform): boolean {
  const P = platform === "win32" ? win32 : posix;
  const fold = (s: string) => (foldsCase(platform) ? s.normalize("NFC").toLowerCase() : s);
  const [f, q] = [fold(folder), fold(p)];
  if (f === q) return true;
  const rel = P.relative(f, q);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel);
}

/** The library's own folder as a real path. */
export const libraryRealRoot = (root: string): Promise<string> => fsp.realpath(root).catch(() => resolve(root));

/** A folder's identity on disk. */
export interface FolderId {
  dev: bigint;
  ino: bigint;
}
/** Device and inode of a path (links followed); rejects when the path cannot be stat'ed. */
export type StatId = (p: string) => Promise<FolderId>;
const statId: StatId = (p) => fsp.stat(p, { bigint: true });

/** The library's folder by device and inode, or null when it cannot be stat'ed. */
export const folderId = (dir: string, stat: StatId = statId): Promise<FolderId | null> =>
  stat(dir).then(
    (st) => ({ dev: st.dev, ino: st.ino }),
    () => null,
  );

/**
 * Whether any existing folder on `real` (the path itself, then each parent up to the root) is the folder `id`, by
 * device and inode. Bounded by the path's depth; a stat that fails on one of them counts as "not that folder".
 */
export async function onFolderPath(real: string, id: FolderId | null, stat: StatId = statId): Promise<boolean> {
  if (!id) return false;
  for (let cur = resolve(real); ; ) {
    const st = await stat(cur).catch(() => null);
    if (st && st.dev === id.dev && st.ino === id.ino) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Whether `dir` (a real path) is the library, inside it, or holds it — by name only (watched folders, R208 d). */
export async function overlapsLibrary(dir: string, lib: { root: string }): Promise<boolean> {
  const root = await libraryRealRoot(lib.root);
  return insideFolder(root, dir) || insideFolder(dir, root);
}

/**
 * Whether `real`, a path already resolved (by `realOrNearest`), is inside the library. For a caller that checks a path
 * and then reads it (the attach, R368 c): it resolves the real path ONCE, checks that, and reads through it, so a link
 * re-pointed after the check changes nothing.
 */
export async function realInsideLibrary(real: string, lib: { root: string }, stat: StatId = statId): Promise<boolean> {
  if (insideFolder(await libraryRealRoot(lib.root), real)) return true;
  return onFolderPath(real, await folderId(lib.root, stat), stat);
}

/** Whether `path`'s real path (links followed; a path not there yet, by its nearest existing parent) is inside the library. */
export async function insideLibrary(path: string, lib: { root: string }, stat: StatId = statId): Promise<boolean> {
  return realInsideLibrary(await realOrNearest(path), lib, stat);
}

/**
 * An import's own folder (R362 c, R368 d): `dir` (a real path) is the library, inside it or holds it — by name, or by
 * device and inode (a folder on `dir`'s path is the library's folder, or a folder on the library's path is `dir`).
 */
export async function importOverlapsLibrary(dir: string, lib: { root: string }, stat: StatId = statId): Promise<boolean> {
  const root = await libraryRealRoot(lib.root);
  if (insideFolder(root, dir) || insideFolder(dir, root)) return true;
  return (await onFolderPath(dir, await folderId(lib.root, stat), stat)) || (await onFolderPath(root, await folderId(dir, stat), stat));
}
