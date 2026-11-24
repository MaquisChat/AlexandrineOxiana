import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fs/atomic.js";
import type { Deps } from "./deps.js";
import { raiseDeviceNotice } from "./device-notices.js";

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

/** The list's text as it is now, or null when there is none. */
async function rawNow(deps: RegDeps): Promise<string | null> {
  try {
    return await readFile(file(deps), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Reads the registry; never throws on bad content. `damaged` = something was unusable; `raw` = the text read (null: none). */
async function load(deps: RegDeps): Promise<{ entries: RegistryEntry[]; damaged: boolean; raw: string | null }> {
  const raw = await rawNow(deps);
  if (raw === null) return { entries: [], damaged: false, raw };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { entries: [], damaged: true, raw };
  }
  if (!Array.isArray(v)) return { entries: [], damaged: true, raw };
  const entries = v.filter(validEntry);
  return { entries, damaged: entries.length !== v.length, raw };
}

/**
 * Most recently opened first. Read in this process's turn (R473 M3): a read never falls between a
 * writer's setting a damaged list aside and its save, where the list would look empty.
 */
export async function listLibraries(deps: RegDeps): Promise<RegistryEntry[]> {
  const { entries } = await inTurn(deps, () => load(deps));
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.lastOpenedAt < b.e.lastOpenedAt ? 1 : a.e.lastOpenedAt > b.e.lastOpenedAt ? -1 : a.i - b.i))
    .map((x) => x.e);
}

function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

/**
 * `libraries.json.corrupt-<stamp>`, with `-n` when that name is taken (as the other set-aside files
 * of this package are named): a second damaged list set aside within the same second never
 * overwrites the first (R484 l).
 */
async function corruptName(deps: RegDeps, now: Date): Promise<string> {
  for (let n = 0; ; n++) {
    const name = `${file(deps)}.corrupt-${stamp(now)}${n === 0 ? "" : `-${n}`}`;
    try {
      await lstat(name);
    } catch {
      return name;
    }
  }
}

/**
 * Keeps a damaged registry as libraries.json.corrupt-<stamp>[-n] before it is overwritten, and then,
 * only once that rename has succeeded, raises a device-level notice (Task 68 fix round 2, R181 a):
 * nothing in the settings folder is set aside in silence.
 */
async function backupIfDamaged(deps: RegDeps, damaged: boolean): Promise<void> {
  if (!damaged) return;
  const now = deps.clock();
  try {
    await rename(file(deps), await corruptName(deps, now));
  } catch (err) {
    // FR-721: another process (the command line, or the service) set it aside first, and said so itself.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await raiseDeviceNotice(deps.appConfigDir, "libraries-list-set-aside", now);
}

async function save(deps: RegDeps, entries: RegistryEntry[]): Promise<void> {
  await mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(file(deps), JSON.stringify(entries, null, 2));
}

/**
 * One change of the libraries list at a time within this process (FR-411): each read-modify-write
 * (and the setting aside of a damaged list), and each read, waits for the one before it, per
 * settings folder. Without this, the chooser setting a damaged list aside while a library is opened
 * or created made one of the two renames fail. The service is not the list's only writer: the
 * command line opens and creates libraries too, in a process of its own, and no lock is held
 * between processes: `update` compares what it read with the list as it is just before it changes
 * the file, and merges again on a difference (FR-721).
 */
const turns = new Map<string, Promise<unknown>>();
function inTurn<T>(deps: RegDeps, work: () => Promise<T>): Promise<T> {
  const key = file(deps);
  const run = (turns.get(key) ?? Promise.resolve()).then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  turns.set(key, settled);
  void settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key);
  });
  return run;
}

/** Tries of one change before it is saved over a list that keeps changing under it (FR-721). */
const UPDATE_TRIES = 5;

/**
 * One change of the list, in this process's turn. `apply` changes the entries in place and says
 * whether anything changed (it is also told whether the list was damaged). When a damaged list was
 * set aside, the list is read again after that, just before the save, and the change is applied to
 * what it holds then merged with what was usable of the damaged one (R473 M3): a list another
 * writer saved in the meantime is not lost.
 *
 * Across processes (FR-721; the command line writes the list too): just before a damaged list is
 * set aside and just before the save, the list's text is compared with what was read; on a
 * difference another process has changed it, and the change is made again on the list as it is
 * then (with what was usable of any damaged list this writer set aside). After UPDATE_TRIES it is
 * saved all the same. Each save is an atomic rename, so the list is never unreadable in between; the
 * moment between the last comparison and the rename stays open, as no lock is held.
 */
function update(deps: RegDeps, apply: (entries: RegistryEntry[], damaged: boolean) => boolean): Promise<void> {
  return inTurn(deps, async () => {
    /** What was usable of the damaged lists this writer set aside, kept across tries. */
    const salvaged: RegistryEntry[] = [];
    let setAside = false;
    for (let tries = 1; ; tries++) {
      const last = tries >= UPDATE_TRIES;
      const first = await load(deps);
      let entries = first.entries;
      let read = first.raw;
      if (first.damaged) {
        if (!last && (await rawNow(deps)) !== first.raw) continue;
        await backupIfDamaged(deps, true);
        setAside = true;
        salvaged.push(...first.entries.filter((e) => !salvaged.some((x) => x.libraryId === e.libraryId)));
        const latest = await load(deps);
        await backupIfDamaged(deps, latest.damaged);
        entries = latest.damaged ? [] : latest.entries;
        read = latest.damaged ? null : latest.raw;
        if (latest.damaged) salvaged.push(...latest.entries.filter((e) => !salvaged.some((x) => x.libraryId === e.libraryId)));
      }
      const known = new Set(entries.map((e) => e.libraryId));
      entries = [...entries, ...salvaged.filter((e) => !known.has(e.libraryId))];
      if (!apply(entries, setAside)) return;
      if (!last && (await rawNow(deps)) !== read) continue;
      await save(deps, entries);
      return;
    }
  });
}

function withPath(paths: string[], path: string): string[] {
  return [path, ...paths.filter((p) => p !== path)].slice(0, MAX_PATHS);
}

export async function registerLibrary(
  lib: { libraryId: string; name: string; path: string },
  deps: RegDeps,
): Promise<void> {
  return update(deps, (entries) => {
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
    return true;
  });
}

/** Moves `path` to the front of the library's known paths. No-op if unknown. */
export async function recordLocation(libraryId: string, path: string, deps: RegDeps): Promise<void> {
  return update(deps, (entries, damaged) => {
    const e = entries.find((x) => x.libraryId === libraryId);
    if (!e) return damaged;
    e.lastKnownPaths = withPath(e.lastKnownPaths, path);
    e.lastOpenedAt = deps.clock().toISOString();
    return true;
  });
}

/**
 * Adds `path` to the library's known paths right after the current first one
 * (no-op when already known, or when the library is not registered). Used to
 * make a move's destination findable before it becomes the library's location.
 */
export async function addKnownPath(libraryId: string, path: string, deps: RegDeps): Promise<void> {
  return update(deps, (entries, damaged) => {
    const e = entries.find((x) => x.libraryId === libraryId);
    if (!e || e.lastKnownPaths.includes(path)) return damaged;
    e.lastKnownPaths = [...e.lastKnownPaths.slice(0, 1), path, ...e.lastKnownPaths.slice(1)].slice(0, MAX_PATHS);
    return true;
  });
}

/**
 * When the list is damaged, sets it aside now (with its notice) and writes back what was usable, so
 * the chooser never just looks empty (Task 68 fix round 2, R181 a). Does nothing otherwise; a read
 * error other than "missing" throws, as every other registry read does.
 */
export async function settleDamagedRegistry(deps: RegDeps): Promise<void> {
  return update(deps, (_entries, damaged) => damaged);
}

export async function forgetLibrary(libraryId: string, deps: RegDeps): Promise<void> {
  return update(deps, (entries, damaged) => {
    const i = entries.findIndex((e) => e.libraryId === libraryId);
    if (i < 0) return damaged;
    entries.splice(i, 1);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// The library open when the app last ran (spec 4.5: reopened at start, D5)

const lastFile = (d: Pick<Deps, "appConfigDir">) => join(d.appConfigDir, "last-library.json");

/**
 * Remembers which library is open, so the app reopens it at its next start. Only the library's id
 * is kept, in the app settings folder (never in the library); where it is comes from the registry.
 */
export async function rememberLastOpenLibrary(libraryId: string, deps: Pick<Deps, "appConfigDir">): Promise<void> {
  await mkdir(deps.appConfigDir, { recursive: true });
  await writeFileAtomic(lastFile(deps), JSON.stringify({ libraryId }));
}

/** The id of the library open when the app last ran, or undefined (none, or the file is unusable). */
export async function lastOpenLibrary(deps: Pick<Deps, "appConfigDir">): Promise<string | undefined> {
  try {
    const v = JSON.parse(await readFile(lastFile(deps), "utf8")) as { libraryId?: unknown };
    return typeof v.libraryId === "string" && v.libraryId ? v.libraryId : undefined;
  } catch {
    return undefined;
  }
}

/** The researcher closed the library: the next start shows the chooser. */
export async function forgetLastOpenLibrary(deps: Pick<Deps, "appConfigDir">): Promise<void> {
  await rm(lastFile(deps), { force: true });
}
