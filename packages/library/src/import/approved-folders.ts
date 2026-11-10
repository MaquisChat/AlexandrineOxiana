/**
 * The library's approved import folders (R67): folders outside an import's own roots whose files
 * Bulk Import may attach without asking again ("remember this folder").
 *
 * They are absolute paths on this device, so they are kept with this device's app settings
 * (`<appConfigDir>/approved-import-folders.json`, keyed by library id), never inside the library:
 * the spec stores no absolute paths in the library (only linked files), and a path that is valid on
 * one computer means nothing on another. Read-only for imports, except `rememberApprovedFolders`,
 * which Bulk Import calls for `approveOutside.rememberFolders` and audits (without the paths).
 */
import * as fsp from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import type { Library } from "../library.js";

const FILE = "approved-import-folders.json";
const MAX_FOLDERS = 1000;

type Store = Record<string, string[]>;

async function readStore(appConfigDir: string): Promise<Store> {
  try {
    const raw = JSON.parse(await fsp.readFile(join(appConfigDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** The library's approved folders (real paths), on this device. */
export async function approvedFolders(lib: Pick<Library, "id" | "appConfigDir">): Promise<string[]> {
  return (await readStore(lib.appConfigDir))[lib.id] ?? [];
}

/** Adds folders (stored as real paths) to the library's approved folders; returns how many were new. */
export async function rememberApprovedFolders(lib: Pick<Library, "id" | "appConfigDir">, folders: string[]): Promise<number> {
  const store = await readStore(lib.appConfigDir);
  const list = store[lib.id] ?? [];
  let added = 0;
  for (const f of folders) {
    const real = await fsp.realpath(f).catch(() => resolve(f));
    if (!list.includes(real) && list.length < MAX_FOLDERS) {
      list.push(real);
      added++;
    }
  }
  if (!added) return 0;
  store[lib.id] = list;
  await fsp.mkdir(lib.appConfigDir, { recursive: true });
  await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
  return added;
}
