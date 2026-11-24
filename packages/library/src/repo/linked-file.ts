/**
 * Whether a record's file can be reached now — the Missing files screen's rule, shared with Find and acquire (R470 a).
 * R503 f as corrected by R510 (FR-727): a recorded LINKED file (its library-relative path may start with "..", R24) is
 * MISSING when nothing is at its path (`lstat` answers ENOENT or ENOTDIR), when ANY symbolic link is at its path
 * (whether or not its target is there: the app opens content without following links, so a file it calls present must
 * be one it can read), and when a folder is there. The rule never looks through a link (`lstat` only), so a link into
 * a mount that does not answer cannot hold it up. Anything else (a cloud placeholder, a file that cannot be read for
 * want of permission) is there: an error other than "nothing is there" is thrown, and the callers count it as there
 * (today's answer — the app has no state that says a source's file "cannot be read").
 */
import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { Asset } from "@ao/core";

/** An error that means "nothing is there". */
export const isGone = (err: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");

/** A library-relative path (a linked one may start with "..") under the library's root. */
export const absIn = (root: string, rel: string): string => join(root, ...rel.split("/"));

/** R510: whether what `lstat` found at a recorded LINKED path is not a file the app can read there (a link, a folder). */
export const linkedNotThere = (st: Pick<Stats, "isSymbolicLink" | "isDirectory">): boolean => st.isSymbolicLink() || st.isDirectory();

/** Whether the linked file recorded at `rel` under `root` is missing now (the Missing files screen's "missing"). */
export async function missingAt(root: string, rel: string): Promise<boolean> {
  try {
    return linkedNotThere(await fsp.lstat(absIn(root, rel)));
  } catch (err) {
    if (isGone(err)) return true;
    throw err;
  }
}

/**
 * R470 a: what a record's originals give now —
 *  - "none": no original that is not destroyed;
 *  - "reachable": a stored original (whatever its file's state: that is the Missing files screen's), or a linked one
 *    whose file is there;
 *  - "linked-missing": its only originals are linked ones whose files cannot be found now (a drive not connected).
 * Reads only the status of the linked files; writes nothing. An error other than "nothing is there" counts as there.
 */
export async function originalsReach(root: string, sf: { assets: readonly Asset[] }): Promise<"none" | "reachable" | "linked-missing"> {
  const originals = sf.assets.filter((a) => a.role === "original" && a.status !== "destroyed");
  if (!originals.length) return "none";
  for (const a of originals) {
    if (!a.linked) return "reachable";
    if (!(await missingAt(root, a.path).catch(() => false))) return "reachable";
  }
  return "linked-missing";
}
