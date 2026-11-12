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
 *
 * The registry's rule (Task 68 fix round 1, found by its wider search): reading approves nothing it
 * cannot read (an import then asks again) and never writes; a change refuses on a read error other
 * than "missing" (ApprovedFoldersUnreadableError) and writes nothing; damaged content (not JSON,
 * the wrong shape, an entry this app cannot use) is kept aside as
 * `approved-import-folders.json.corrupt-<stamp>` before a fresh store is written, and a device-level
 * notice says so.
 */
import * as fsp from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { raiseDeviceNotice } from "../device-notices.js";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import type { Library } from "../library.js";

const FILE = "approved-import-folders.json";
const MAX_FOLDERS = 1000;

type Store = Record<string, string[]>;

/** The list of folders approved for imports could not be read: nothing was written. No path in the message. */
export class ApprovedFoldersUnreadableError extends Error {
  constructor() {
    super("This computer's list of folders approved for imports could not be read, so it was not changed. Check that the app's settings folder can be read and try again.");
    this.name = "ApprovedFoldersUnreadableError";
  }
}

/** The store and whether its content is damaged; throws on a read error other than "missing". */
async function readStoreStrict(appConfigDir: string): Promise<{ store: Store; damaged: boolean }> {
  const out: Store = Object.create(null) as Store;
  let text: string;
  try {
    text = await fsp.readFile(join(appConfigDir, FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { store: out, damaged: false };
    throw new ApprovedFoldersUnreadableError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { store: out, damaged: true };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { store: out, damaged: true };
  let damaged = false;
  for (const k of Object.keys(raw)) {
    const v = (raw as Record<string, unknown>)[k];
    if (!Array.isArray(v)) {
      damaged = true;
      continue;
    }
    out[k] = v.filter((x): x is string => typeof x === "string" && isAbsolute(x));
    if (out[k].length !== v.length) damaged = true;
  }
  return { store: out, damaged };
}

/** For reading: anything it cannot read approves nothing (an import then asks again). */
async function readStore(appConfigDir: string): Promise<Store> {
  return (await readStoreStrict(appConfigDir).catch(() => ({ store: Object.create(null) as Store }))).store;
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
    const { store, damaged } = await readStoreStrict(lib.appConfigDir); // re-read under the lock
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
    if (damaged) {
      // Kept aside (never deleted, never overwritten), and only then a fresh store; never silent.
      const now = new Date();
      const stamp = now.toISOString().replace(/\.\d+Z$/u, "").replace(/[-:]/gu, "").replace("T", "-");
      let name = `${FILE}.corrupt-${stamp}`;
      for (let n = 1; await fsp.lstat(join(lib.appConfigDir, name)).then(() => true, () => false); n++) name = `${FILE}.corrupt-${stamp}-${n}`;
      try {
        await fsp.rename(join(lib.appConfigDir, FILE), join(lib.appConfigDir, name));
      } catch {
        throw new ApprovedFoldersUnreadableError();
      }
      await raiseDeviceNotice(lib.appConfigDir, "approved-folders-list-set-aside", now);
    }
    await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
    return added;
  });
  lock = next.catch(() => {});
  return next;
}
