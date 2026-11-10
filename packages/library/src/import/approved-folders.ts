/**
 * The library's approved import folders (R67): folders outside an import's own roots whose files
 * Bulk Import may attach without asking again ("remember this folder").
 *
 * They are absolute paths on this device, so they are kept with this device's app settings
 * (`<appConfigDir>/approved-import-folders.json`, keyed by library id), never inside the library:
 * the spec stores no absolute paths in the library (only linked files), and a path that is valid on
 * one computer means nothing on another (R69). Read-only for imports, except
 * `rememberApprovedFolders`, which Bulk Import calls for `approveOutside.rememberFolders` and audits
 * (without the paths). Only absolute paths are accepted; the store is read into a null-prototype
 * object (a library id such as `__proto__` is just a key), and each read-modify-write runs under an
 * in-process lock and re-reads the file first (R70).
 */
import * as fsp from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import type { Library } from "../library.js";

const FILE = "approved-import-folders.json";
const MAX_FOLDERS = 1000;

type Store = Record<string, string[]>;

async function readStore(appConfigDir: string): Promise<Store> {
  const out: Store = Object.create(null) as Store;
  try {
    const raw = JSON.parse(await fsp.readFile(join(appConfigDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const k of Object.keys(raw)) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string" && isAbsolute(x));
    }
  } catch {
    // no file yet, or unreadable: no approved folders
  }
  return out;
}

const own = (store: Store, id: string) => (Object.hasOwn(store, id) ? store[id]! : []);

/** The library's approved folders (real paths), on this device. */
export async function approvedFolders(lib: Pick<Library, "id" | "appConfigDir">): Promise<string[]> {
  return [...own(await readStore(lib.appConfigDir), lib.id)];
}

let lock: Promise<unknown> = Promise.resolve();

/** Adds absolute folders (stored as real paths) to the library's approved folders; returns how many were new. */
export function rememberApprovedFolders(lib: Pick<Library, "id" | "appConfigDir">, folders: string[]): Promise<number> {
  const next = lock.then(async () => {
    const reals: string[] = [];
    for (const f of folders) if (isAbsolute(f)) reals.push(await fsp.realpath(f).catch(() => resolve(f)));
    const store = await readStore(lib.appConfigDir); // re-read under the lock
    const list = [...own(store, lib.id)];
    let added = 0;
    for (const r of reals) {
      if (!list.includes(r) && list.length < MAX_FOLDERS) {
        list.push(r);
        added++;
      }
    }
    if (!added) return 0;
    store[lib.id] = list;
    await fsp.mkdir(lib.appConfigDir, { recursive: true });
    await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
    return added;
  });
  lock = next.catch(() => {});
  return next;
}
