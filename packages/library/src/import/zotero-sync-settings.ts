/**
 * Zotero account sync (Task Z7): this computer's two device files for it. They are about this computer (the key is
 * per computer, R206 6), never library data, and they hold nothing of a library's content: no title, no name, no
 * collection, no file name, no path, no key.
 *
 *   `<appConfigDir>/zotero-sync.json`          `{ v: 1, libraries: { [libraryId]: ZoteroSyncSettings } }`
 *        which Zotero library (`user:<n>` / `group:<n>`) feeds which project, with what import options, how often,
 *        whether automatic runs are on, and each link's pause and `fullDone`.
 *   `<appConfigDir>/zotero-sync-history.json`  `{ v: 1, libraries: { [libraryId]: ZoteroSyncRun[] } }`
 *        newest first, at most ZOTERO_SYNC_HISTORY_MAX per library: ids, times, outcomes, reasons, counts (never for an
 *        encrypted project, Accept 4), host NAMES of refused redirect hosts (at most 5) and the back-off time.
 *
 * Both are 0600 in the 0700 settings folder, written atomically through updateAppSettingStrict, one write at a time
 * per file in this process, and read strictly (Accept 5): a missing file is "nothing yet"; a file that is there but
 * cannot be read (permissions, an I/O error) is refused (ZoteroSyncFileUnreadableError) and nothing is written on its
 * strength; DAMAGED content (not JSON, the wrong shape, an entry this app cannot use, an unknown field) is set aside
 * as `<name>.unreadable-<stamp>` (never deleted or overwritten) and the file starts again empty:
 *   - settings: automatic sync is then off for every library (nothing is linked) until the researcher sets it up
 *     again; the researcher is told through the device notice `zotero-sync-settings-set-aside` (R242), and the caller
 *     through `onSetAside`;
 *   - history: it starts empty, and never blocks a sync.
 *
 * Pauses (R206 4, Accept 3) are written by the runner (`key-refused` on every link of the library, `library-gone` on
 * one link) and by Z8 after an undo of a sync batch (`pauseLink(…, "undone")`). The runner never clears a pause: a
 * pause is cleared only by writeZoteroSyncSettings with that link written without `paused` (the researcher saving
 * the settings again, after the key check for `key-refused`).
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { AppSettingUnreadableError, setAppSettingAside, updateAppSettingStrict } from "../app-settings.js";
import { raiseDeviceNotice } from "../device-notices.js";
import { InvalidInputError } from "../repo/errors.js";

export const ZOTERO_SYNC_FILE = "zotero-sync.json";
export const ZOTERO_SYNC_HISTORY_FILE = "zotero-sync-history.json";
/** Links per library (one per Zotero library). */
export const ZOTERO_SYNC_MAX_LINKS = 20;
/** Runs kept per library (the newest). */
export const ZOTERO_SYNC_HISTORY_MAX = 200;
/** Refused redirect hosts kept in a run's record. */
export const ZOTERO_SYNC_MAX_HOSTS = 5;
export const ZOTERO_SYNC_INTERVALS = [30, 60, 240] as const;

export type ZoteroSyncReason =
  | "offline"
  | "zotero-error"
  | "key-missing"
  | "key-refused"
  | "no-store"
  | "library-gone"
  | "backing-off"
  | "project-locked"
  | "library-read-only"
  | "library-changing"
  | "too-large"
  | "stopped-by-you"
  | "app-closed"
  | "import-running"
  | "error"
  /** NOT in the plan's list (needs the coordinator's ruling): a manual or automatic run refused because the link was paused after an undo of a sync batch. */
  | "sync-undone";

export const ZOTERO_SYNC_REASONS: readonly ZoteroSyncReason[] = [
  "offline",
  "zotero-error",
  "key-missing",
  "key-refused",
  "no-store",
  "library-gone",
  "backing-off",
  "project-locked",
  "library-read-only",
  "library-changing",
  "too-large",
  "stopped-by-you",
  "app-closed",
  "import-running",
  "error",
  "sync-undone",
];

export type ZoteroSyncPause = "key-refused" | "library-gone" | "undone";
const PAUSES: readonly ZoteroSyncPause[] = ["key-refused", "library-gone", "undone"];

export interface ZoteroSyncLink {
  ref: string;
  projectId: string;
  paused?: ZoteroSyncPause;
  /** A full run of this link truly finished (the key list whole, nothing held back, the version recorded): later runs are incremental. */
  fullDone: boolean;
  options: { structure: "collections" | "tags" | "none"; duplicates: "merge" | "skip" | "keep-both" };
}

/** One library's settings on this computer. */
export interface ZoteroSyncSettings {
  automatic: boolean;
  everyMinutes: 30 | 60 | 240;
  links: ZoteroSyncLink[];
}

export const DEFAULT_ZOTERO_SYNC_SETTINGS: Readonly<ZoteroSyncSettings> = Object.freeze({ automatic: false, everyMinutes: 60, links: [] as ZoteroSyncLink[] });

/**
 * A run's numbers (plan A8, A9), mapped from the batch in ONE place (zoteroSyncCounts in zotero-sync.ts). The plan's
 * seven plus `back` (returned from Zotero's bin or deletion) and `clearedKept` (a field cleared in Zotero, kept here).
 */
export interface ZoteroSyncCounts {
  new: number;
  changed: number;
  unchanged: number;
  waiting: number;
  conflicts: number;
  goneMarked: number;
  failed: number;
  back: number;
  clearedKept: number;
}
const COUNT_KEYS = ["back", "changed", "clearedKept", "conflicts", "failed", "goneMarked", "new", "unchanged", "waiting"];

export type ZoteroSyncOutcome = "up-to-date" | "finished" | "finished-with-problems" | "stopped" | "failed";
const OUTCOMES: readonly ZoteroSyncOutcome[] = ["up-to-date", "finished", "finished-with-problems", "stopped", "failed"];

export interface ZoteroSyncRun {
  id: string;
  ref: string;
  projectId: string;
  trigger: "manual" | "automatic";
  startedAt: string;
  /** Absent while the run goes on; a record without it read later (another process) is a run the app closed during. */
  finishedAt?: string;
  outcome: ZoteroSyncOutcome;
  reason?: ZoteroSyncReason;
  batchId?: string;
  /** Never written to the device file for an encrypted project (zoteroSyncRunCounts reads them while it is unlocked). */
  counts?: ZoteroSyncCounts;
  refusedHosts?: string[];
  /** ISO time before which no run of any kind may start (Zotero's Backoff / Retry-After, at least an hour). */
  backoffUntil?: string;
}

/** A settings or history file is there but cannot be read (not damaged content: permissions, an I/O error). Nothing was written. No path. */
export class ZoteroSyncFileUnreadableError extends Error {
  constructor(readonly fileName: string) {
    super(`This computer's Zotero sync file "${fileName}" could not be read, so it was not changed. Check that the app's settings folder can be read and try again.`);
    this.name = "ZoteroSyncFileUnreadableError";
  }
}

// ------------------------------------------------------------------------------------------
// Shapes, checked strictly.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysWithin = (o: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const ZOTERO_REF = /^(user|group):[1-9]\d{0,11}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const isTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function isZoteroSyncLink(v: unknown): v is ZoteroSyncLink {
  if (!isObj(v) || !keysWithin(v, ["ref", "projectId", "fullDone", "options"], ["paused"])) return false;
  if (typeof v.ref !== "string" || !ZOTERO_REF.test(v.ref) || typeof v.projectId !== "string" || !ID.test(v.projectId) || typeof v.fullDone !== "boolean") return false;
  if (v.paused !== undefined && !PAUSES.includes(v.paused as ZoteroSyncPause)) return false;
  const o = v.options;
  return isObj(o) && keysWithin(o, ["structure", "duplicates"]) && ["collections", "tags", "none"].includes(o.structure as string) && ["merge", "skip", "keep-both"].includes(o.duplicates as string);
}

export function isZoteroSyncSettings(v: unknown): v is ZoteroSyncSettings {
  if (!isObj(v) || !keysWithin(v, ["automatic", "everyMinutes", "links"])) return false;
  if (typeof v.automatic !== "boolean" || !(ZOTERO_SYNC_INTERVALS as readonly unknown[]).includes(v.everyMinutes)) return false;
  if (!Array.isArray(v.links) || v.links.length > ZOTERO_SYNC_MAX_LINKS || !v.links.every(isZoteroSyncLink)) return false;
  return new Set(v.links.map((l) => (l as ZoteroSyncLink).ref)).size === v.links.length;
}

function isCounts(v: unknown): v is ZoteroSyncCounts {
  return isObj(v) && Object.keys(v).sort().join() === COUNT_KEYS.join() && COUNT_KEYS.every((k) => count(v[k]));
}

export function isZoteroSyncRun(v: unknown): v is ZoteroSyncRun {
  if (!isObj(v) || !keysWithin(v, ["id", "ref", "projectId", "trigger", "startedAt", "outcome"], ["finishedAt", "reason", "batchId", "counts", "refusedHosts", "backoffUntil"])) return false;
  if (typeof v.id !== "string" || !ID.test(v.id) || typeof v.ref !== "string" || !ZOTERO_REF.test(v.ref) || typeof v.projectId !== "string" || !ID.test(v.projectId)) return false;
  if (v.trigger !== "manual" && v.trigger !== "automatic") return false;
  if (!isTime(v.startedAt) || (v.finishedAt !== undefined && !isTime(v.finishedAt)) || (v.backoffUntil !== undefined && !isTime(v.backoffUntil))) return false;
  if (!OUTCOMES.includes(v.outcome as ZoteroSyncOutcome)) return false;
  if (v.reason !== undefined && !ZOTERO_SYNC_REASONS.includes(v.reason as ZoteroSyncReason)) return false;
  if (v.batchId !== undefined && (typeof v.batchId !== "string" || !ID.test(v.batchId))) return false;
  if (v.counts !== undefined && !isCounts(v.counts)) return false;
  if (v.refusedHosts !== undefined && !(Array.isArray(v.refusedHosts) && v.refusedHosts.length <= ZOTERO_SYNC_MAX_HOSTS && v.refusedHosts.every((h) => typeof h === "string" && HOST.test(h)))) return false;
  return true;
}

const fileOf =
  <T>(entry: (v: unknown) => boolean) =>
  (v: unknown): v is { v: 1; libraries: Record<string, T> } =>
    isObj(v) && keysWithin(v, ["v", "libraries"]) && v.v === 1 && isObj(v.libraries) && Object.entries(v.libraries).every(([id, e]) => ID.test(id) && entry(e));

const isSettingsFile = fileOf<ZoteroSyncSettings>(isZoteroSyncSettings);
const isHistoryFile = fileOf<ZoteroSyncRun[]>((e) => Array.isArray(e) && e.length <= ZOTERO_SYNC_HISTORY_MAX && e.every(isZoteroSyncRun));

// ------------------------------------------------------------------------------------------
// Reading and writing, strictly.

export interface ZoteroSyncFileOptions {
  /** Told when damaged content was set aside (the file's own name and the name it is kept under; no path). */
  onSetAside?(fileName: string, keptAs: string): void;
  /** Test seam: the clock for the set-aside name. */
  now?: () => Date;
}

/** Missing → undefined; there but not readable → ZoteroSyncFileUnreadableError; damaged → "damaged". */
async function classify<T>(dir: string, name: string, check: (v: unknown) => v is T): Promise<T | undefined | "damaged"> {
  let text: string;
  try {
    text = await fsp.readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new ZoteroSyncFileUnreadableError(name);
  }
  try {
    const v = JSON.parse(text) as unknown;
    return check(v) ? v : "damaged";
  } catch {
    return "damaged";
  }
}

async function setAside(dir: string, name: string, check: (v: unknown) => v is unknown, o: ZoteroSyncFileOptions): Promise<void> {
  let keptAs: string;
  const now = (o.now ?? (() => new Date()))();
  try {
    keptAs = await setAppSettingAside(dir, name, check, now);
  } catch (err) {
    if ((err as Error)?.name === "AppSettingReadableError") return; // put right (or removed) meanwhile
    throw new ZoteroSyncFileUnreadableError(name);
  }
  // The settings: the researcher is told through the device notices (R242; never throws). The history: no notice.
  if (name === ZOTERO_SYNC_FILE) await raiseDeviceNotice(dir, "zotero-sync-settings-set-aside", now);
  o.onSetAside?.(name, keptAs);
}

async function readFileStrict<T>(dir: string, name: string, check: (v: unknown) => v is T, o: ZoteroSyncFileOptions): Promise<T | undefined> {
  const got = await classify(dir, name, check);
  if (got !== "damaged") return got;
  await setAside(dir, name, check, o);
  return undefined;
}

/** A read-modify-write of the file in its turn; damaged content is set aside first (then `edit` gets undefined). */
async function updateFile<T>(dir: string, name: string, check: (v: unknown) => v is T, edit: (cur: T | undefined) => T, o: ZoteroSyncFileOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // A file there but unreadable (not damaged) is refused before anything is set aside or written.
    if ((await classify(dir, name, check)) === "damaged") await setAside(dir, name, check, o);
    try {
      return await updateAppSettingStrict(dir, name, check, edit);
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError) || attempt >= 2) throw err instanceof AppSettingUnreadableError ? new ZoteroSyncFileUnreadableError(name) : err;
    }
  }
}

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const copyLink = (l: ZoteroSyncLink): ZoteroSyncLink => ({
  ref: l.ref,
  projectId: l.projectId,
  ...(l.paused ? { paused: l.paused } : {}),
  fullDone: l.fullDone,
  options: { structure: l.options.structure, duplicates: l.options.duplicates },
});
const copySettings = (s: ZoteroSyncSettings): ZoteroSyncSettings => ({ automatic: s.automatic, everyMinutes: s.everyMinutes, links: s.links.map(copyLink) });

/**
 * This library's sync settings on this computer: the defaults (automatic off, every hour, nothing linked) when
 * none were saved, or when the file was damaged and has just been set aside. Throws ZoteroSyncFileUnreadableError
 * when the file is there but cannot be read.
 */
export async function readZoteroSyncSettings(dir: string, libraryId: string, o: ZoteroSyncFileOptions = {}): Promise<ZoteroSyncSettings> {
  const f = await readFileStrict(dir, ZOTERO_SYNC_FILE, isSettingsFile, o);
  const s = own(f?.libraries, libraryId);
  return s ? copySettings(s) : copySettings(DEFAULT_ZOTERO_SYNC_SETTINGS);
}

/**
 * Saves this library's sync settings on this computer (other libraries' are kept). Exactly what is given is
 * written: a link written without `paused` is un-paused (the only way a pause is cleared). Refuses settings that are
 * not valid (InvalidInputError naming the field) and writes nothing.
 */
export async function writeZoteroSyncSettings(dir: string, libraryId: string, s: ZoteroSyncSettings, o: ZoteroSyncFileOptions = {}): Promise<ZoteroSyncSettings> {
  if (typeof libraryId !== "string" || !ID.test(libraryId)) throw new InvalidInputError("libraryId is not a library id.");
  if (!isObj(s)) throw new InvalidInputError("The settings are not valid.");
  if (typeof s.automatic !== "boolean") throw new InvalidInputError("automatic must be yes or no.");
  if (!(ZOTERO_SYNC_INTERVALS as readonly unknown[]).includes(s.everyMinutes)) throw new InvalidInputError("everyMinutes must be 30, 60 or 240.");
  if (!Array.isArray(s.links) || s.links.length > ZOTERO_SYNC_MAX_LINKS) throw new InvalidInputError(`links: at most ${ZOTERO_SYNC_MAX_LINKS} Zotero libraries can be linked.`);
  if (!s.links.every(isZoteroSyncLink)) throw new InvalidInputError("links: a link is not valid (ref user:<n> or group:<n>, a project id, the import options).");
  if (new Set(s.links.map((l) => l.ref)).size !== s.links.length) throw new InvalidInputError("links: each Zotero library can be linked to one project only.");
  const next = copySettings(s);
  await updateFile(
    dir,
    ZOTERO_SYNC_FILE,
    isSettingsFile,
    (cur) => ({ v: 1 as const, libraries: { ...(cur?.libraries ?? {}), [libraryId]: next } }),
    o,
  );
  return copySettings(next);
}

/** Changes the stored links of a library in one turn (nothing is written when the library has none or nothing changes). */
async function editLinks(dir: string, libraryId: string, fn: (l: ZoteroSyncLink) => ZoteroSyncLink, o: ZoteroSyncFileOptions): Promise<void> {
  await updateFile(
    dir,
    ZOTERO_SYNC_FILE,
    isSettingsFile,
    (cur) => {
      const s = own(cur?.libraries, libraryId);
      if (!cur || !s) return cur ?? { v: 1 as const, libraries: {} };
      return { v: 1 as const, libraries: { ...cur.libraries, [libraryId]: { ...s, links: s.links.map((l) => fn(copyLink(l))) } } };
    },
    o,
  );
}

/**
 * Pauses one link (`library-gone`: Zotero says the key can no longer read it; `undone`: the researcher undid one of
 * its sync batches — Z8 calls this, so the sync does not at once bring back what was undone; `key-refused`: see
 * pauseAllZoteroSyncLinks). A paused link refuses every run until the settings are written with it un-paused.
 */
export async function pauseLink(dir: string, libraryId: string, ref: string, reason: ZoteroSyncPause, o: ZoteroSyncFileOptions = {}): Promise<void> {
  if (!PAUSES.includes(reason)) throw new TypeError("not a pause");
  await editLinks(dir, libraryId, (l) => (l.ref === ref ? { ...l, paused: reason } : l), o);
}

/** Zotero refused the key: every link of the library is paused (`key-refused`). */
export async function pauseAllZoteroSyncLinks(dir: string, libraryId: string, o: ZoteroSyncFileOptions = {}): Promise<void> {
  await editLinks(dir, libraryId, (l) => ({ ...l, paused: "key-refused" }), o);
}

/** Package-internal (the runner): a full run of the link truly finished. */
export async function markZoteroSyncFullDone(dir: string, libraryId: string, ref: string, projectId: string, o: ZoteroSyncFileOptions = {}): Promise<void> {
  await editLinks(dir, libraryId, (l) => (l.ref === ref && l.projectId === projectId ? { ...l, fullDone: true } : l), o);
}

// ------------------------------------------------------------------------------------------
// History.

/** Runs going on in this process (their records have no `finishedAt` yet and are not "closed during"). */
export const runningZoteroSyncRuns = new Set<string>();

/** A record without an end, not running in this process: the app closed during it (it continues next time). */
function settled(r: ZoteroSyncRun): ZoteroSyncRun {
  if (r.finishedAt !== undefined || runningZoteroSyncRuns.has(r.id)) return r;
  return { ...r, outcome: "stopped", reason: "app-closed" };
}

/**
 * This library's sync runs on this computer, newest first (at most ZOTERO_SYNC_HISTORY_MAX). A record started by an
 * earlier process and never finished reads as `stopped` / `app-closed`. A damaged file is set aside and the history
 * starts empty; a file that cannot be read throws ZoteroSyncFileUnreadableError.
 */
export async function readZoteroSyncHistory(dir: string, libraryId: string, o: ZoteroSyncFileOptions = {}): Promise<ZoteroSyncRun[]> {
  const f = await readFileStrict(dir, ZOTERO_SYNC_HISTORY_FILE, isHistoryFile, o);
  return (own(f?.libraries, libraryId) ?? []).map((r) => settled(structuredClone(r)));
}

/**
 * Package-internal (the runner): puts `run` in the library's history (replacing the record with its id, else as the
 * newest), keeps the newest ZOTERO_SYNC_HISTORY_MAX, and turns records an earlier process left unfinished into
 * `stopped` / `app-closed` on the way. A damaged file is set aside first.
 */
export async function putZoteroSyncRun(dir: string, libraryId: string, run: ZoteroSyncRun, o: ZoteroSyncFileOptions = {}): Promise<void> {
  if (!isZoteroSyncRun(run)) throw new TypeError("not a sync run record");
  await updateFile(
    dir,
    ZOTERO_SYNC_HISTORY_FILE,
    isHistoryFile,
    (cur) => {
      const list = (own(cur?.libraries, libraryId) ?? []).filter((r) => r.id !== run.id).map(settled);
      const at = (own(cur?.libraries, libraryId) ?? []).findIndex((r) => r.id === run.id);
      if (at >= 0 && at <= list.length) list.splice(at, 0, run);
      else list.unshift(run);
      return { v: 1 as const, libraries: { ...(cur?.libraries ?? {}), [libraryId]: list.slice(0, ZOTERO_SYNC_HISTORY_MAX) } };
    },
    o,
  );
}
