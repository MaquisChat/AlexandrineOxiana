/**
 * "Inside the library" (R310 h, R362 c): the one rule by which watched folders, the attach and the folder import keep
 * out what is already the library's — every project, the files found and held for the researcher's check
 * (`find/held/`), the backups, the index and the caches. Compared by REAL path (links followed; a path that does not
 * exist yet by its nearest existing parent), so a link outside the library that leads into it, a path written with
 * `..`, or (on macOS and Windows, whose disks usually ignore letter case) the same path in another case, is inside.
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

/** Whether `dir` (a real path) is the library, inside it, or holds it. */
export async function overlapsLibrary(dir: string, lib: { root: string }): Promise<boolean> {
  const root = await libraryRealRoot(lib.root);
  return insideFolder(root, dir) || insideFolder(dir, root);
}

/**
 * Whether `real`, a path already resolved (by `realOrNearest`), is inside the library. For a caller that checks a path
 * and then reads it (the attach, R368 c): it resolves the real path ONCE, checks that, and reads through it, so a link
 * re-pointed after the check changes nothing.
 */
export async function realInsideLibrary(real: string, lib: { root: string }): Promise<boolean> {
  return insideFolder(await libraryRealRoot(lib.root), real);
}

/** Whether `path`'s real path (links followed; a path not there yet, by its nearest existing parent) is inside the library. */
export async function insideLibrary(path: string, lib: { root: string }): Promise<boolean> {
  return realInsideLibrary(await realOrNearest(path), lib);
}
