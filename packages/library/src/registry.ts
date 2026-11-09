import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fs/atomic.js";
import type { Deps } from "./deps.js";

export interface RegistryEntry {
  libraryId: string;
  name: string;
  /** Most recent first, max 5. */
  lastKnownPaths: string[];
  lastOpenedAt: string;
}

type RegDeps = Pick<Deps, "appConfigDir" | "clock">;
const MAX_PATHS = 5;
const file = (d: RegDeps) => join(d.appConfigDir, "libraries.json");

export async function listLibraries(deps: RegDeps): Promise<RegistryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file(deps), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as RegistryEntry[]) : [];
  } catch {
    return []; // a damaged registry is only a convenience list
  }
}

async function save(deps: RegDeps, entries: RegistryEntry[]): Promise<void> {
  await mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(file(deps), JSON.stringify(entries, null, 2));
}

function withPath(paths: string[], path: string): string[] {
  return [path, ...paths.filter((p) => p !== path)].slice(0, MAX_PATHS);
}

export async function registerLibrary(
  lib: { libraryId: string; name: string; path: string },
  deps: RegDeps,
): Promise<void> {
  const entries = await listLibraries(deps);
  const at = deps.clock().toISOString();
  const i = entries.findIndex((e) => e.libraryId === lib.libraryId);
  const prev = i >= 0 ? entries[i]! : undefined;
  const entry: RegistryEntry = {
    libraryId: lib.libraryId,
    name: lib.name,
    lastKnownPaths: withPath(prev?.lastKnownPaths ?? [], lib.path),
    lastOpenedAt: at,
  };
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
  await save(deps, entries);
}

/** Moves `path` to the front of the library's known paths. No-op if unknown. */
export async function recordLocation(libraryId: string, path: string, deps: RegDeps): Promise<void> {
  const entries = await listLibraries(deps);
  const e = entries.find((x) => x.libraryId === libraryId);
  if (!e) return;
  e.lastKnownPaths = withPath(e.lastKnownPaths, path);
  e.lastOpenedAt = deps.clock().toISOString();
  await save(deps, entries);
}

export async function forgetLibrary(libraryId: string, deps: RegDeps): Promise<void> {
  const entries = await listLibraries(deps);
  const rest = entries.filter((e) => e.libraryId !== libraryId);
  if (rest.length !== entries.length) await save(deps, rest);
}
