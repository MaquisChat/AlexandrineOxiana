import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { newId } from "@ao/core";
import type { Deps } from "./deps.js";
import { writeFileAtomic } from "./fs/atomic.js";
import { acquireLock, peekLock, releaseLock, startHeartbeat } from "./lock.js";
import { registerLibrary } from "./registry.js";

export const FORMAT_VERSION = 1;
const SUBDIRS = ["Projects", "Exports", "Backups", ".cache", ".tmp"];
const MAX_HISTORY = 50;

export interface LibraryJson {
  libraryId: string;
  name: string;
  formatVersion: 1;
  createdAt: string;
  locationHistory: Array<{ at: string; hint: string }>;
}

export interface Library {
  id: string;
  name: string;
  root: string;
  mode: "read-write" | "read-only";
  readOnlyReason?: "locked-by-other-device" | "newer-format" | "offline";
  close(): Promise<void>;
}

export class NotALibraryError extends Error {
  constructor(root: string) {
    super(`Not a library (no library.json): ${root}`);
    this.name = "NotALibraryError";
  }
}
export class CorruptLibraryError extends Error {
  constructor(detail: string) {
    super(`Corrupt library: ${detail}`);
    this.name = "CorruptLibraryError";
  }
}
export class FolderNotEmptyError extends Error {
  constructor(root: string) {
    super(`Folder is not empty: ${root}`);
    this.name = "FolderNotEmptyError";
  }
}
export class AlreadyALibraryError extends Error {
  constructor(root: string) {
    super(`Folder already contains a library: ${root}`);
    this.name = "AlreadyALibraryError";
  }
}

const metaPath = (root: string) => join(root, "library.json");
const hintFor = (root: string, deps: Deps) => `${deps.hostname}:${basename(root)}`;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function createLibrary(root: string, name: string, deps: Deps): Promise<Library> {
  if (await exists(metaPath(root))) throw new AlreadyALibraryError(root);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) throw new FolderNotEmptyError(root);
  for (const d of SUBDIRS) await mkdir(join(root, d), { recursive: true });
  const at = deps.clock().toISOString();
  const meta: LibraryJson = {
    libraryId: newId(),
    name,
    formatVersion: FORMAT_VERSION,
    createdAt: at,
    locationHistory: [{ at, hint: hintFor(root, deps) }],
  };
  await writeFileAtomic(metaPath(root), JSON.stringify(meta, null, 2));
  return openLibrary(root, deps);
}

async function readMeta(root: string): Promise<LibraryJson> {
  let raw: string;
  try {
    raw = await readFile(metaPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new NotALibraryError(root);
    }
    throw err;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new CorruptLibraryError("library.json is not valid JSON");
  }
  const o = v as Partial<LibraryJson> | null;
  if (
    typeof o !== "object" ||
    o === null ||
    typeof o.libraryId !== "string" ||
    typeof o.name !== "string" ||
    typeof o.formatVersion !== "number" ||
    !Number.isInteger(o.formatVersion) ||
    o.formatVersion < 1
  ) {
    throw new CorruptLibraryError("library.json is missing required fields or has a bad formatVersion");
  }
  return {
    ...(o as LibraryJson),
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    locationHistory: Array.isArray(o.locationHistory) ? o.locationHistory : [],
  };
}

export async function openLibrary(root: string, deps: Deps): Promise<Library> {
  const meta = await readMeta(root);
  const base = { id: meta.libraryId, name: meta.name, root };
  const readOnly = (reason: NonNullable<Library["readOnlyReason"]>): Library => ({
    ...base,
    mode: "read-only",
    readOnlyReason: reason,
    close: async () => {},
  });

  // Read-only opens must not touch the library folder at all.
  if ((meta.formatVersion as number) > FORMAT_VERSION) {
    await note(root, meta, deps);
    return readOnly("newer-format");
  }
  if (await peekLock(root, deps)) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device");
  }
  const got = await acquireLock(root, deps);
  if (!got.acquired) {
    await note(root, meta, deps);
    return readOnly("locked-by-other-device");
  }

  const stopHeartbeat = startHeartbeat(root, deps);
  const hint = hintFor(root, deps);
  const history = meta.locationHistory;
  if (history[history.length - 1]?.hint !== hint) {
    history.push({ at: deps.clock().toISOString(), hint });
    meta.locationHistory = history.slice(-MAX_HISTORY);
    await writeFileAtomic(metaPath(root), JSON.stringify(meta, null, 2));
  }
  await note(root, meta, deps);

  let closed = false;
  return {
    ...base,
    mode: "read-write",
    async close() {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      await releaseLock(root, deps);
    },
  };
}

/** Records the library in the app-level registry (outside the library folder). */
async function note(root: string, meta: LibraryJson, deps: Deps): Promise<void> {
  try {
    await registerLibrary({ libraryId: meta.libraryId, name: meta.name, path: root }, deps);
  } catch {
    // the registry is a convenience; never fail an open because of it
  }
}
