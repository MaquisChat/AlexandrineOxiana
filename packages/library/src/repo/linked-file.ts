/**
 * Whether a record's file can be reached now — the Missing files screen's rule, shared with Find and acquire (R470 a).
 * A file is missing when nothing is at its library-relative path (a linked file's path may start with "..", R24):
 * `lstat` answers ENOENT or ENOTDIR. Anything else (a cloud placeholder, a file that cannot be read) is there.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Asset } from "@ao/core";

/** An error that means "nothing is there". */
export const isGone = (err: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");

/** A library-relative path (a linked one may start with "..") under the library's root. */
export const absIn = (root: string, rel: string): string => join(root, ...rel.split("/"));

/** Whether nothing is at `rel` under `root` now (the Missing files screen's "missing"). */
export async function missingAt(root: string, rel: string): Promise<boolean> {
  try {
    await fsp.lstat(absIn(root, rel));
    return false;
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
