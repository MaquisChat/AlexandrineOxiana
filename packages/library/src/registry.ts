import { mkdir, readFile, rename } from "node:fs/promises";
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

function validEntry(e: unknown): e is RegistryEntry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.libraryId === "string" &&
    typeof o.name === "string" &&
    typeof o.lastOpenedAt === "string" &&
    Array.isArray(o.lastKnownPaths) &&
    o.lastKnownPaths.every((p) => typeof p === "string")
  );
}

/** Reads the registry; never throws on bad content. `damaged` = something was unusable. */
async function load(deps: RegDeps): Promise<{ entries: RegistryEntry[]; damaged: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file(deps), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], damaged: false };
    throw err;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { entries: [], damaged: true };
  }
  if (!Array.isArray(v)) return { entries: [], damaged: true };
  const entries = v.filter(validEntry);
  return { entries, damaged: entries.length !== v.length };
}

/** Most recently opened first. */
export async function listLibraries(deps: RegDeps): Promise<RegistryEntry[]> {
  const { entries } = await load(deps);
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.lastOpenedAt < b.e.lastOpenedAt ? 1 : a.e.lastOpenedAt > b.e.lastOpenedAt ? -1 : a.i - b.i))
    .map((x) => x.e);
}

function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/** Keeps a damaged registry as libraries.json.corrupt-<stamp> before it is overwritten. */
async function backupIfDamaged(deps: RegDeps, damaged: boolean): Promise<void> {
  if (!damaged) return;
  await rename(file(deps), `${file(deps)}.corrupt-${stamp(deps.clock())}`);
}

async function save(deps: RegDeps, entries: RegistryEntry[]): Promise<void> {
  await mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(file(deps), JSON.stringify(entries, null, 2));
}

async function loadForUpdate(deps: RegDeps): Promise<RegistryEntry[]> {
  const { entries, damaged } = await load(deps);
  await backupIfDamaged(deps, damaged);
  return entries;
}

function withPath(paths: string[], path: string): string[] {
  return [path, ...paths.filter((p) => p !== path)].slice(0, MAX_PATHS);
}

export async function registerLibrary(
  lib: { libraryId: string; name: string; path: string },
  deps: RegDeps,
): Promise<void> {
  const entries = await loadForUpdate(deps);
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
  const entries = await loadForUpdate(deps);
  const e = entries.find((x) => x.libraryId === libraryId);
  if (!e) return;
  e.lastKnownPaths = withPath(e.lastKnownPaths, path);
  e.lastOpenedAt = deps.clock().toISOString();
  await save(deps, entries);
}

export async function forgetLibrary(libraryId: string, deps: RegDeps): Promise<void> {
  const entries = await loadForUpdate(deps);
  const rest = entries.filter((e) => e.libraryId !== libraryId);
  if (rest.length !== entries.length) await save(deps, rest);
}
