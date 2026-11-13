/**
 * This computer's choices for each watched folder (Task W4; R207 5): paused or not; what to do with files that are
 * not downloaded to this Mac ("leave", the default, or "download"); and how many bytes the researcher agreed to have
 * downloaded. They are choices about this computer (a laptop on a slow line pauses; a desktop downloads), so they are
 * a device file, never in the library: `<appConfigDir>/watched-folder-choices.json`, shaped
 * `{ [libraryId]: { [projectId]: { [watchId]: record } } }` — ids, booleans, one word and numbers only (no path, no
 * file name). 0600 in a 0700 folder, written atomically, under the registry rule of the watched-folders list (Task 68,
 * R178 a; watch.ts `readStore`): a missing file means the defaults; a file that cannot be read refuses
 * (WatchedFoldersUnreadableError) and nothing is written on its strength; damaged content (not JSON, the wrong shape,
 * a record this app cannot use) is kept aside as `watched-folder-choices.json.corrupt-<stamp>` with a warning and the
 * device notice `watched-folder-choices-set-aside`, and the defaults apply.
 *
 * Besides the three choices, each record keeps the engine's count for "Download and import them":
 *   - `confirmation`: grows by one each time the researcher confirms a size (`setWatchChoices` with `confirmedBytes`,
 *     even the same number again), so a new confirmation is told from an old one exactly;
 *   - `fetchedBytes`: the bytes the engine has started to download since that confirmation. The engine RESERVES a
 *     file's size here BEFORE it starts the download (`reserveWatchDownload`), and the reservation is checked against
 *     the agreed size in the same turn: this record, not any watch's memory, is the one authority on how much may be
 *     downloaded (I1) — however many watches of the id ask, a download cut short by a crash still counts, and a restart
 *     of the app does not grant the allowance again. No confirmation (`confirmation` 0): nothing at all, 0 bytes
 *     included (I4).
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { raiseDeviceNotice } from "../device-notices.js";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { InvalidInputError } from "../repo/errors.js";
import type { WatchSettingsDeps } from "./watch.js";

export const WATCH_CHOICES_FILE = "watched-folder-choices.json";

/** This computer's choices for one watched folder. */
export interface WatchChoices {
  /** Paused: nothing in the folder is read or imported; a full listing follows the resume. */
  paused: boolean;
  /** Files not downloaded to this Mac: "leave" them (the default), or "download" them up to the agreed size. */
  notDownloaded: "leave" | "download";
  /** The bytes of not-downloaded files the researcher saw and agreed to have downloaded (set by the route). */
  confirmedBytes: number;
}

export const DEFAULT_WATCH_CHOICES: Readonly<WatchChoices> = Object.freeze({ paused: false, notDownloaded: "leave", confirmedBytes: 0 });

/** The engine's count since the last confirmation (see the module's comment). */
export interface WatchDownloadCount {
  confirmation: number;
  fetchedBytes: number;
}

interface Stored extends WatchChoices, WatchDownloadCount {}
type Store = Record<string, Record<string, Record<string, Stored>>>;

const RECORD_KEYS = ["confirmation", "confirmedBytes", "fetchedBytes", "notDownloaded", "paused"];
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function usable(v: unknown): v is Stored {
  if (!isRecord(v)) return false;
  if (Object.keys(v).sort().join() !== RECORD_KEYS.join()) return false;
  return typeof v.paused === "boolean" && (v.notDownloaded === "leave" || v.notDownloaded === "download") && count(v.confirmedBytes) && count(v.confirmation) && count(v.fetchedBytes);
}

/**
 * This computer's list of watched folders, or its choices for them, could not be read: nothing was moved or written.
 * The message carries no path. (Kept here and re-exported by watch.ts, so that the two modules do not import each other.)
 */
export class WatchedFoldersUnreadableError extends Error {
  constructor() {
    super("This computer's list of watched folders could not be read, so it was not changed. Check that the app's settings folder can be read and try again.");
    this.name = "WatchedFoldersUnreadableError";
  }
}

/** The researcher is told, in plain words, when damaged choices were set aside (the words shown are the interface's). */
export const CHOICES_SET_ASIDE_WARNING = "This computer's choices for its watched folders were damaged and were set aside. Folders whose choices could not be kept went back to the defaults.";

async function readStore(dir: string): Promise<{ store: Store; damaged: boolean }> {
  const store = Object.create(null) as Store;
  let text: string;
  try {
    text = await fsp.readFile(join(dir, WATCH_CHOICES_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { store, damaged: false };
    throw new WatchedFoldersUnreadableError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { store, damaged: true };
  }
  if (!isRecord(raw)) return { store, damaged: true };
  // An entry this app cannot use is not dropped in silence: the whole file is kept aside (`damaged`).
  let damaged = false;
  for (const libId of Object.keys(raw)) {
    const projects = raw[libId];
    if (!isRecord(projects)) {
      damaged = true;
      continue;
    }
    const p = Object.create(null) as Record<string, Record<string, Stored>>;
    for (const projectId of Object.keys(projects)) {
      const watches = projects[projectId];
      if (!isRecord(watches)) {
        damaged = true;
        continue;
      }
      const w = Object.create(null) as Record<string, Stored>;
      for (const id of Object.keys(watches)) {
        const r = watches[id];
        if (usable(r)) w[id] = { paused: r.paused, notDownloaded: r.notDownloaded, confirmedBytes: r.confirmedBytes, confirmation: r.confirmation, fetchedBytes: r.fetchedBytes };
        else damaged = true;
      }
      p[projectId] = w;
    }
    store[libId] = p;
  }
  return { store, damaged };
}

/** Keeps the damaged file aside (never deleted or overwritten), warns, raises the notice; when it cannot, nothing may be written over it. */
async function setAside(deps: WatchSettingsDeps): Promise<void> {
  const dir = deps.lib.appConfigDir;
  const now = new Date();
  const stamp = now.toISOString().replace(/\.\d+Z$/u, "").replace(/[-:]/gu, "").replace("T", "-");
  let name = `${WATCH_CHOICES_FILE}.corrupt-${stamp}`;
  for (let n = 1; await fsp.lstat(join(dir, name)).then(() => true, () => false); n++) name = `${WATCH_CHOICES_FILE}.corrupt-${stamp}-${n}`;
  try {
    await fsp.rename(join(dir, WATCH_CHOICES_FILE), join(dir, name));
  } catch {
    throw new WatchedFoldersUnreadableError();
  }
  deps.onWarning?.(CHOICES_SET_ASIDE_WARNING);
  await raiseDeviceNotice(dir, "watched-folder-choices-set-aside", now);
}

/** Every read-modify-write of the file, one at a time in this process; a damaged file is set aside first (under the turn). */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(step: () => Promise<T>): Promise<T> {
  const run = turn.then(step);
  turn = run.catch(() => undefined);
  return run;
}
function update<T>(deps: WatchSettingsDeps, fn: (s: Store) => { write: boolean; out: T }): Promise<T> {
  const dir = deps.lib.appConfigDir;
  return inTurn(async () => {
    const { store, damaged } = await readStore(dir); // read again in this turn
    if (damaged) await setAside(deps);
    const { write, out } = fn(store);
    if (write || damaged) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fsp.chmod(dir, 0o700).catch(() => {});
      await writeSmallFileAtomic(join(dir, WATCH_CHOICES_FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
    }
    return out;
  });
}

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const recordOf = (s: Store, deps: WatchSettingsDeps, projectId: string, watchId: string): Stored | undefined => own(own(own(s, deps.lib.id), projectId), watchId);
const choicesOf = (r: Stored | undefined): WatchChoices => (r ? { paused: r.paused, notDownloaded: r.notDownloaded, confirmedBytes: r.confirmedBytes } : { ...DEFAULT_WATCH_CHOICES });
function putRecord(s: Store, deps: WatchSettingsDeps, projectId: string, watchId: string, r: Stored): void {
  const projects = own(s, deps.lib.id) ?? (Object.create(null) as Record<string, Record<string, Stored>>);
  const watches = own(projects, projectId) ?? (Object.create(null) as Record<string, Stored>);
  watches[watchId] = r;
  projects[projectId] = watches;
  s[deps.lib.id] = projects;
}

/** Reads the record (damaged content: set aside under the turn, then the defaults). */
async function readRecord(deps: WatchSettingsDeps, projectId: string, watchId: string): Promise<Stored | undefined> {
  const { store, damaged } = await readStore(deps.lib.appConfigDir);
  if (!damaged) return recordOf(store, deps, projectId, watchId);
  return update(deps, (s) => ({ write: false, out: recordOf(s, deps, projectId, watchId) }));
}

/** This computer's choices for the watch (the defaults when none were made). Throws WatchedFoldersUnreadableError on a read error. */
export async function getWatchChoices(deps: WatchSettingsDeps, projectId: string, watchId: string): Promise<WatchChoices> {
  return choicesOf(await readRecord(deps, projectId, watchId));
}

/** The engine's count since the last confirmation (zeros when none was made). */
export async function getWatchDownloadCount(deps: WatchSettingsDeps, projectId: string, watchId: string): Promise<WatchDownloadCount> {
  const r = await readRecord(deps, projectId, watchId);
  return { confirmation: r?.confirmation ?? 0, fetchedBytes: r?.fetchedBytes ?? 0 };
}

/**
 * Changes this computer's choices for a watch of the project. `confirmedBytes` in the patch is a new confirmation (the
 * engine's count starts again from 0), even when it repeats the number. Refuses an unknown project or watch and a
 * malformed patch (InvalidInputError), and a file it cannot read (WatchedFoldersUnreadableError), writing nothing.
 */
export async function setWatchChoices(deps: WatchSettingsDeps, projectId: string, watchId: string, patch: Partial<WatchChoices>): Promise<WatchChoices> {
  if (!isRecord(patch) || Object.keys(patch).some((k) => k !== "paused" && k !== "notDownloaded" && k !== "confirmedBytes")) throw new InvalidInputError("These are not choices for a watched folder.");
  if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new InvalidInputError("“Paused” must be yes or no.");
  if (patch.notDownloaded !== undefined && patch.notDownloaded !== "leave" && patch.notDownloaded !== "download") throw new InvalidInputError("Files not downloaded are either left alone or downloaded.");
  if (patch.confirmedBytes !== undefined && !count(patch.confirmedBytes)) throw new InvalidInputError("The size agreed to must be a whole number of bytes.");
  if (!(deps.repo.getProject(projectId).watchedFolders ?? []).some((w) => w.id === watchId)) throw new InvalidInputError("This project has no such watched folder.");
  return update(deps, (s) => {
    const cur = recordOf(s, deps, projectId, watchId) ?? { ...DEFAULT_WATCH_CHOICES, confirmation: 0, fetchedBytes: 0 };
    const next: Stored = {
      paused: patch.paused ?? cur.paused,
      notDownloaded: patch.notDownloaded ?? cur.notDownloaded,
      confirmedBytes: patch.confirmedBytes ?? cur.confirmedBytes,
      confirmation: patch.confirmedBytes !== undefined ? cur.confirmation + 1 : cur.confirmation,
      fetchedBytes: patch.confirmedBytes !== undefined ? 0 : cur.fetchedBytes,
    };
    putRecord(s, deps, projectId, watchId, next);
    return { write: true, out: choicesOf(next) };
  });
}

/** Later arrivals may be downloaded up to this many bytes beyond the size the researcher agreed to (R207 5). */
export const LATER_ARRIVALS_BYTES = 1_073_741_824;

/** What a reservation answered: reserved (the count now), or held (past the agreed size, or nothing agreed), or stale (a new confirmation came). */
export type WatchDownloadReservation = { reserved: true; fetchedBytes: number } | { reserved: false; reason: "held" | "stale" };

/**
 * The engine's count (Task W4), BEFORE a download starts: in one turn of the file, `bytes` are added to what was reserved
 * since confirmation `confirmation` — only if that confirmation is still the record's, was ever made (> 0), and the
 * total stays within the agreed size (`confirmedBytes`; for a later arrival, `later`, LATER_ARRIVALS_BYTES beyond it).
 * At the limit is allowed; past it is "held", and nothing is added. Throws WatchedFoldersUnreadableError when the file
 * cannot be read: the engine then does not download.
 */
export async function reserveWatchDownload(deps: WatchSettingsDeps, projectId: string, watchId: string, confirmation: number, bytes: number, later: boolean): Promise<WatchDownloadReservation> {
  if (!count(bytes) || !count(confirmation)) throw new InvalidInputError("Not a number of bytes.");
  return update<WatchDownloadReservation>(deps, (s) => {
    const cur = recordOf(s, deps, projectId, watchId);
    if (!cur || cur.confirmation === 0 || confirmation === 0) return { write: false, out: { reserved: false, reason: "held" } };
    if (cur.confirmation !== confirmation) return { write: false, out: { reserved: false, reason: "stale" } };
    const limit = cur.confirmedBytes + (later ? LATER_ARRIVALS_BYTES : 0);
    const total = cur.fetchedBytes + bytes;
    if (!count(total) || total > limit) return { write: false, out: { reserved: false, reason: "held" } };
    putRecord(s, deps, projectId, watchId, { ...cur, fetchedBytes: total });
    return { write: true, out: { reserved: true, fetchedBytes: total } };
  });
}

/** Forgets this computer's choices for a watch (the folder is no longer watched: W7's removal). */
export async function removeWatchChoices(deps: WatchSettingsDeps, projectId: string, watchId: string): Promise<void> {
  await update(deps, (s) => {
    const watches = own(own(s, deps.lib.id), projectId);
    if (!watches || !Object.hasOwn(watches, watchId)) return { write: false, out: undefined };
    delete watches[watchId];
    return { write: true, out: undefined };
  });
}
