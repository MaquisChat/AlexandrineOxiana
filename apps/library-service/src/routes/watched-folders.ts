/**
 * Watched folders (cloud-drive watched folders, Task W7; R207, R208, R213, R217, R219, R221; Amendments A3, A5,
 * A6, A8). The shapes are @ao/shared's (api/watched-folders.ts). Every route is for the desktop app's token only:
 * none is in server.ts's EXTENSION_ROUTES, so the extension's token is refused (403) before any of them runs.
 *
 * A folder is approved ONLY by a grant from the shell's folder chooser (R207): a body that carries a path is refused
 * whatever else it holds. A grant is taken once (`FolderGrants.take`) and is spent even when its folder is refused.
 * Then, in this order: its real path (`realpath`: `..` and links resolved before any check); a folder; not the
 * library, not inside it, not holding it; not the whole cloud-storage area and not a folder holding it (A3); on
 * Windows, not a cloud-drive folder (Accept 2). Only then the library's own add, with the real path. Every refusal is
 * a plain sentence with no path and no folder name. The path from a grant lives only in this request's locals, the
 * device file the library writes (R69) and the engine's watch; it reaches no log line, error or audit entry, and no
 * answer except `place.display` (the researcher's own choice, R96).
 *
 * Adds, set-folders, removes and retries of the open library run one at a time (`serial`), across projects, so that
 * two adds of one folder at the same instant end as one success and one refusal (R221 — the library's own check is
 * not serialised).
 *
 * `watch.status` carries a WatchStatusEvent: at most one per folder per WATCH_STATUS_INTERVAL_MS, the last state of a
 * burst always delivered, nothing once the library is closed or replaced, nothing for a project that is locked.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  FolderNotAnsweringError,
  WATCH_REASONS,
  WatchedFoldersUnreadableError,
  folderCallOutstanding,
  noteFolderCallOutstanding,
  addWatchedFolder,
  folderRuleRefusal,
  bringInNewVersion,
  classifyLocation,
  getWatchChoices,
  listWatchedFolders,
  removeWatchChoices,
  removeWatchedFolder,
  scrubPaths,
  setWatchChoices,
  setWatchFolder,
  settleWatchedFile,
  updateWatchedFolderEntry,
  watchFolder,
  withProvider,
  withService,
  type FolderWatch,
  type LocationEnv,
  type WatchChoices,
  type WatchFileKind as EngineFileKind,
  type WatchFileProblem,
  type WatchStatus,
  type WatchedFileState as EngineFileState,
} from "@ao/library";
import {
  WATCHED_FILE_LIST_KINDS,
  WATCHED_FILES_LIMIT_MAX,
  type CloudProviderId,
  type SourceWatchOriginResponse,
  type WatchFileKind,
  type WatchedFileActionResponse,
  type WatchedFileListKind,
  type WatchedFileState,
  type WatchedFolderFileItem,
  type WatchedFolderFilesResponse,
  type WatchedFolderPlace,
  type WatchedFolderSummary,
  type WatchedFoldersListResponse,
  type WatchedSourceOrigin,
  type WatchStatusEvent,
} from "@ao/shared";
import { ApiError, badRequest, notFound } from "../errors.js";
import type { Session } from "../state.js";
import { bodyOf, intParam, paramsOf, projectParam, queryOf, type Ctx, type Obj, type Same } from "./util.js";

// The library's types and @ao/shared's declarations are one and the same (Task 47).
true satisfies Same<EngineFileKind, WatchFileKind>;
true satisfies Same<EngineFileState, WatchedFileState>;
true satisfies Same<NonNullable<WatchStatus["provider"]>, CloudProviderId>;
true satisfies Same<WatchStatus["counts"], WatchedFolderSummary["counts"]>;

/** At most one `watch.status` per folder in this time (the plan's WATCH_STATUS_INTERVAL_MS). */
export const WATCH_STATUS_INTERVAL_MS = 1000;
/**
 * R233 I2: how long the file calls made while a grant is redeemed (and the library's own checks of the folder in its
 * add and set-folder) may take. Past it the request answers `notAnswering`, nothing is stored, and the queue moves on;
 * the stuck call's thread stays held until the call settles (A3 d), but nothing waits for it.
 */
export const WATCH_ROUTE_FS_LIMIT_MS = 10_000;
/** R233 I2: how long a route waits for a watch to stop before it goes on (the engine finishes the stop by itself, A6). */
export const WATCH_ROUTE_STOP_LIMIT_MS = 3000;
/** As many problems as the engine keeps (its WATCH_PROBLEMS_MAX): `…/files` sorts them all. */
const PROBLEMS_ALL = 5000;

/** The sentences of these routes (the plan's, A3's and R221's; the rest proposed here). */
export const WATCH_ROUTE_TEXT = {
  dir: "Choose the folder with “Add a folder…” in the app.",
  expired: "That folder choice has expired. Choose the folder again.",
  notFound: "That folder could not be found. Choose the folder again.",
  notFolder: "That is not a folder. Choose a folder.",
  wholeDrive: "Choose the folder inside your cloud drive that you want watched, not a folder that holds the whole drive.",
  windows: "Watching a cloud-drive folder is not available on Windows yet.",
  sizeChanged: "The number of files not downloaded has changed. Look at the new size and choose again.",
  nothing: "There is nothing to download in this folder at the moment.",
  noCollection: "That collection is not in this project.",
  halfDoneUnreadable: "The folder's name or collection was changed. Its pause or download choice was not saved, because this computer's settings for watched folders could not be read. Try again.",
  halfDone: "The folder's name or collection was changed. Its pause or download choice was not saved. Try again.",
  confirmAlone: "A size can be given only with “Download and import them”.",
  nothingToChange: "There is nothing to change.",
  notSetUp: "This folder has not been chosen on this computer yet. Choose it with “Choose the folder…”.",
  notAnswering: "That folder did not answer. Choose it again when it can be reached.",
  notUsable: "That folder could not be used. Choose it again.",
  label: "The name must be 1 to 200 characters.",
  offset: '"offset" must be a whole number, 0 or more.',
  readOnly: "This library is open read-only, so no folder is watched.",
  changed: "The file in the folder has changed since it was brought in. The library's copy is unchanged.",
  mayHaveChanged: "The file in the folder was replaced or edited, but it is not downloaded to this Mac, so the app cannot yet tell what changed. The library's copy is unchanged.",
  gone: "The file is no longer in the watched folder. The library's copy is unchanged.",
  notBroughtIn: "The new version could not be brought in.",
} as const;

/** Keys that carry a folder path (the old route took `dir`): refused whatever else the body holds. */
const PATH_KEYS = ["dir", "path", "folder", "directory", "root", "realPath"];
const GRANT_ID = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------------------------------------------
// Where a folder is: the cloud service (as the engine's cloudProviderOf says it, from classifyLocation) and the
// place shown for it.

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);
const foldsCase = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/** The segments of `child` below `parent` (`[]` when equal), or null when it is not inside it. */
function below(child: string, parent: string, env: LocationEnv): string[] | null {
  const P = pathFor(env.platform);
  const fold = (s: string) => (foldsCase(env.platform) ? s.toLowerCase() : s);
  const c = P.normalize(child);
  const rel = P.relative(fold(P.normalize(parent)), fold(c));
  if (rel === "") return [];
  // A name that merely starts with ".." (`..inner`) is inside (R233 M2): only ".." itself or "../…" is outside.
  if (rel === ".." || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel)) return null;
  const n = rel.split(P.sep).length;
  const parts = c.split(P.sep).filter((s) => s !== "");
  return parts.slice(parts.length - n);
}

/** The engine's provider for a real path (watch-local's `cloudProviderOf`, which @ao/library does not export). */
export function providerOf(real: string, env: LocationEnv): CloudProviderId | null {
  const loc = classifyLocation(real, env);
  if (loc.kind !== "cloud_folder") return null;
  const id = loc.cloudFolderId ?? "";
  if (id === "googledrive" || id.startsWith("googledrive:")) return "google-drive";
  if (id === "onedrive" || id.startsWith("onedrive:")) return "onedrive";
  if (id === "dropbox") return "dropbox";
  if (id === "icloud") return "icloud-drive";
  return "other-cloud";
}

/** The engine's PROVIDER_NAMES. */
const PROVIDER_NAMES: Record<CloudProviderId, string> = {
  "google-drive": "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "icloud-drive": "iCloud Drive",
  "other-cloud": "the cloud drive",
};

/** The path below the service's own folder, for the three services shown by name; null when it cannot be told. */
function belowProviderRoot(real: string, env: LocationEnv, provider: CloudProviderId): string[] | null {
  const P = pathFor(env.platform);
  const cs = below(real, P.join(env.homeDir, "Library", "CloudStorage"), env);
  if (cs && cs.length > 0) return cs.slice(1);
  if (provider === "dropbox") return below(real, P.join(env.homeDir, "Dropbox"), env);
  if (provider === "onedrive") {
    for (const dir of Object.values(env.vars ?? {})) {
      const r = dir ? below(real, dir, env) : null;
      if (r) return r;
    }
  }
  return null;
}

/**
 * Where a folder is, as the interface shows it (R96: the one field an answer may carry the chosen path in): Google
 * Drive, OneDrive and Dropbox by their name and the path below their own folder; any other folder (iCloud Drive,
 * another service below ~/Library/CloudStorage, a plain folder) by its absolute path, the researcher's own choice.
 */
export function placeOf(real: string, env: LocationEnv): WatchedFolderPlace {
  const provider = providerOf(real, env);
  const providerName = provider ? PROVIDER_NAMES[provider] : null;
  if (provider === "google-drive" || provider === "onedrive" || provider === "dropbox") {
    const rest = belowProviderRoot(real, env, provider);
    if (rest) return { provider, providerName, display: [providerName!, ...rest].join("/") };
  }
  return { provider, providerName, display: real };
}

/** The test seam (R47: honoured only under NODE_ENV=test or VITEST), else this computer. */
function locationEnv(ctx: Ctx): LocationEnv {
  const testing = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  if (testing && ctx.watchLocationEnv) return ctx.watchLocationEnv;
  const vars: NonNullable<LocationEnv["vars"]> = {};
  for (const k of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const) {
    const v = process.env[k];
    if (v) vars[k] = v;
  }
  return { homeDir: homedir(), platform: process.platform, mounts: [], mountsKnown: false, vars };
}

// ---------------------------------------------------------------------------------------------------------------
// Redeeming a grant (A5).

function refusePath(b: Obj): void {
  if (PATH_KEYS.some((k) => Object.hasOwn(b, k))) throw badRequest(WATCH_ROUTE_TEXT.dir);
}

function onlyKeys(b: Obj, keys: readonly string[]): void {
  for (const k of Object.keys(b)) if (!keys.includes(k)) throw badRequest(`"${k}" is not part of this request.`);
}

/**
 * Takes the grant a request names, FIRST (R233 M1: a request that names a grant spends it, whatever else is wrong with
 * it). Null when the body names none, or nothing that could be one. Never logs or answers the path.
 */
function takeGrant(ctx: Ctx, body: unknown): string | null {
  const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Obj).grantId : undefined;
  if (typeof id !== "string" || !GRANT_ID.test(id)) return null;
  return ctx.folderGrants.take(id);
}

/** The folder did not answer within the route's limit (R233 I2). */
class NotAnswering extends Error {}

/** `p`, or NotAnswering after `ms` (and `ac` aborted); a late answer or failure of `p` is dropped. */
function withLimit<T>(p: Promise<T>, ms: number, ac?: AbortController): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      ac?.abort();
      reject(new NotAnswering());
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const fsLimit = (ctx: Ctx) => {
  const testing = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  return testing && ctx.watchFsTimeoutMs !== undefined ? ctx.watchFsTimeoutMs : WATCH_ROUTE_FS_LIMIT_MS;
};
const stopLimit = (ctx: Ctx) => Math.min(WATCH_ROUTE_STOP_LIMIT_MS, fsLimit(ctx));

/**
 * The real path of a grant's folder, checked (A5, A3, Accept 2), each file call under the route's limit (R233 I2). The
 * grant was taken already: whatever is refused here, it is spent. No sentence names the path or the folder.
 */
async function checkGranted(ctx: Ctx, s: Session, given: string): Promise<string> {
  const ms = fsLimit(ctx);
  const env = locationEnv(ctx);
  // A folder with a call still outstanding (the engine's, or one of ours given up on) is not asked again: one call per
  // folder, whoever made it (R234 I-A). Said in the engine's words.
  const outstanding = (dir: string) => {
    if (folderCallOutstanding(dir)) throw new ApiError(409, "CONFLICT", withProvider(WATCH_REASONS.notResponding, providerOf(dir, env)));
  };
  /** One call on the folder, under the limit; given up on, it is recorded as outstanding until it settles. */
  const onFolder = async <T>(dir: string, call: Promise<T>): Promise<T> => {
    try {
      return await withLimit(call, ms);
    } catch (err) {
      if (err instanceof NotAnswering) {
        noteFolderCallOutstanding(dir, call);
        throw badRequest(WATCH_ROUTE_TEXT.notAnswering);
      }
      throw badRequest(WATCH_ROUTE_TEXT.notFound);
    }
  };
  outstanding(given);
  const real = await onFolder(given, realpath(given));
  outstanding(real);
  const isDir = (await onFolder(real, stat(real))).isDirectory();
  if (!isDir) throw badRequest(WATCH_ROUTE_TEXT.notFolder);
  // The library: not it, not inside it, not holding it (both as real paths).
  const libRoot = await realpath(s.lib.root).catch(() => path.resolve(s.lib.root));
  if (below(real, libRoot, env) !== null || below(libRoot, real, env) !== null) throw badRequest(WATCH_REASONS.library);
  // The one rule on where a folder may be, shared with the engine (R233 M3): the whole cloud-storage area (A3) and,
  // on Windows, a cloud-drive folder (R207 6).
  const homeReal = await withLimit(realpath(env.homeDir), ms).catch(() => env.homeDir);
  const rule = folderRuleRefusal(real, env, [env.homeDir, homeReal]);
  if (rule) throw badRequest(rule);
  return real;
}

/**
 * The library's add or set-folder (R234 I-B): its calls on the FOLDER run under the route's limit (FolderNotAnsweringError,
 * nothing written); once they have passed, its governed write is awaited like every other governed write, inside the
 * service's queue — never raced.
 */
async function governedFolderStep<T>(ctx: Ctx, step: (timeoutMs: number) => Promise<T>): Promise<T> {
  try {
    return await step(fsLimit(ctx));
  } catch (err) {
    if (err instanceof FolderNotAnsweringError) throw badRequest(WATCH_ROUTE_TEXT.notAnswering);
    // The library's own checks of the folder (R233 M9): plain refusals, never a 500.
    if (err instanceof TypeError) {
      if (err.message === WATCH_REASONS.library) throw badRequest(WATCH_REASONS.library);
      if (err.message === "This project has no such watched folder.") throw notFound("That watched folder");
      throw badRequest(WATCH_ROUTE_TEXT.notUsable);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One at a time (R221), and the running watches.

const queues = new WeakMap<object, Promise<unknown>>();
/** Runs `fn` after every earlier serial step of this service (adds, set-folders, removes, retries). */
function serial<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/** The project's watch for `wid` (a running one first; else the last one, which may have stopped with a reason). */
export function watchOf(s: Session, projectId: string, wid: string): FolderWatch | undefined {
  const mine = (s.watches.get(projectId) ?? []).filter((w) => w.status().watchId === wid);
  return mine.find((w) => !w.stopped) ?? mine.at(-1);
}

/** Stops the watch(es) of `wid` (only that folder: the project's other watches keep running). */
async function stopOne(ctx: Ctx, s: Session, projectId: string, wid: string): Promise<void> {
  const all = s.watches.get(projectId) ?? [];
  const mine = all.filter((w) => w.status().watchId === wid);
  // A stop that does not settle in time (a call on the folder is stuck) is not waited for: the watch has already
  // stopped working and its settled call cleans up (A6); the queue moves on (R233 I2).
  await Promise.race([Promise.allSettled(mine.map((w) => w.stop())), new Promise((r) => setTimeout(r, stopLimit(ctx)).unref?.())]);
  s.watches.set(
    projectId,
    (s.watches.get(projectId) ?? []).filter((w) => !mine.includes(w)),
  );
}

/** Starts the watch of one folder (with its id: its register, A8). */
function startOne(ctx: Ctx, s: Session, projectId: string, w: { id: string; options: Parameters<typeof watchFolder>[3] }, dir: string): FolderWatch {
  const watch = watchFolder(ctx.state.watchDeps(s, projectId), projectId, dir, w.options, w.id);
  if (ctx.state.session !== s) {
    void watch.stop();
    return watch;
  }
  s.watches.set(projectId, [...(s.watches.get(projectId) ?? []).filter((x) => x.status().watchId !== w.id), watch]);
  return watch;
}

/** A folder whose file-system call has not answered (A6): its status says so in the engine's own words. */
function stuck(st: WatchStatus): boolean {
  return st.state === "unreachable" && (st.reason === withProvider(WATCH_REASONS.notResponding, st.provider) || st.reason === withService(WATCH_REASONS.fetchNotResponding, st.provider));
}

// ---------------------------------------------------------------------------------------------------------------
// Summaries.

type Rec = Awaited<ReturnType<typeof listWatchedFolders>>[number];
const ZERO: WatchedFolderSummary["counts"] = { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 };

function settingsDeps(s: Session) {
  return { repo: s.repo, lib: s.lib };
}

async function choicesOf(s: Session, projectId: string, wid: string): Promise<WatchChoices> {
  try {
    return await getWatchChoices(settingsDeps(s), projectId, wid);
  } catch {
    // The engine pauses a folder whose choices cannot be read (W4's choicesUnreadable): said the same way here.
    return { paused: true, notDownloaded: "leave", confirmedBytes: 0 };
  }
}

/** A folder's summary, built from the engine's status (`st`: given, or the watch's now). */
async function summaryOf(ctx: Ctx, s: Session, projectId: string, rec: Rec, collections: Map<string, string>, st?: WatchStatus): Promise<WatchedFolderSummary> {
  const roots = ctx.state.roots;
  const watch = rec.dir ? watchOf(s, projectId, rec.id) : undefined;
  const status = rec.dir ? (st ?? watch?.status()) : undefined;
  const choices = await choicesOf(s, projectId, rec.id);
  const cid = rec.options.collectionId;
  let state: WatchedFolderSummary["state"];
  let reason: string | undefined;
  if (!rec.dir) state = "not-set-up";
  else if (status?.state === "stopped" && status.reason === WATCH_REASONS.notWhereChosen) {
    // The stored folder is no longer the one chosen (R234 c): not set up on this computer; PUT …/folder chooses it again.
    state = "not-set-up";
    reason = status.reason;
  } else if (status) {
    state = status.state;
    reason = status.reason;
  } else {
    state = "stopped";
    if (s.lib.mode !== "read-write") reason = WATCH_ROUTE_TEXT.readOnly;
  }
  const c = status?.counts ?? ZERO;
  // Exactly the plan's eight counts.
  const counts: WatchedFolderSummary["counts"] = { cameIn: c.cameIn, alreadyInLibrary: c.alreadyInLibrary, notDownloaded: c.notDownloaded, notDownloadedBytes: c.notDownloadedBytes, waiting: c.waiting, didNotComeIn: c.didNotComeIn, changed: c.changed, gone: c.gone };
  return {
    id: rec.id,
    ...(rec.options.label !== undefined ? { label: rec.options.label } : {}),
    recursive: rec.options.recursive ?? false,
    ...(cid !== undefined ? { collectionId: cid } : {}),
    ...(cid !== undefined && collections.has(cid) ? { collectionName: collections.get(cid)! } : {}),
    place: rec.dir && state !== "not-set-up" ? placeOf(rec.dir, locationEnv(ctx)) : null,
    state,
    ...(reason !== undefined ? { reason: scrubPaths(reason, roots) } : {}),
    scanning: status?.scanning ?? false,
    counts,
    choices: { paused: choices.paused, notDownloaded: choices.notDownloaded },
    ...(status?.downloadHeld ? { downloadHeld: { files: status.downloadHeld.files, bytes: status.downloadHeld.bytes } } : {}),
  };
}

async function collectionsOf(s: Session, projectId: string): Promise<Map<string, string>> {
  return new Map((await s.repo.listCollectionsAndTags(projectId)).collections.map((c) => [c.id, c.name]));
}

async function summaryById(ctx: Ctx, s: Session, projectId: string, wid: string, st?: WatchStatus): Promise<WatchedFolderSummary> {
  const rec = (await listWatchedFolders(settingsDeps(s), projectId)).find((w) => w.id === wid);
  if (!rec) throw notFound("That watched folder");
  return summaryOf(ctx, s, projectId, rec, await collectionsOf(s, projectId), st);
}

// ---------------------------------------------------------------------------------------------------------------
// Files.

const listOrder = (k: WatchedFileListKind) => WATCHED_FILE_LIST_KINDS.indexOf(k);
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A file the engine lists as not come in, as answered: its reason scrubbed; no size when the size is not known (W4). */
export function fileItemOf(p: WatchFileProblem, roots: Iterable<string>): WatchedFolderFileItem {
  const known = p.bytes !== undefined && p.reason !== WATCH_REASONS.sizeUnknown;
  return { file: p.file, kind: p.kind, reason: scrubPaths(p.reason, roots), ...(known ? { bytes: p.bytes } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// watch.status, coalesced.

/**
 * At most one value per key per `intervalMs`; a value pushed sooner waits, replaced by any later one, so the last
 * value of a burst is always sent (at most `intervalMs` late). `clear()` drops whatever waits.
 */
export class WatchStatusCoalescer<T> {
  private readonly m = new Map<string, { last: number; n: number; pending?: { v: T }; timer?: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly intervalMs: number,
    private readonly send: (key: string, v: T, n: number) => void,
  ) {}
  /** Whether `n` is still the last value sent for `key` (a send overtaken, or a key forgotten, is not). */
  latest(key: string, n: number): boolean {
    return this.m.get(key)?.n === n;
  }
  push(key: string, v: T): void {
    const now = Date.now();
    let e = this.m.get(key);
    if (!e) this.m.set(key, (e = { last: Number.NEGATIVE_INFINITY, n: 0 }));
    if (!e.timer && now - e.last >= this.intervalMs) {
      e.last = now;
      this.send(key, v, ++e.n);
      return;
    }
    e.pending = { v };
    if (!e.timer) {
      e.timer = setTimeout(() => this.fire(key), Math.max(0, e.last + this.intervalMs - now));
      e.timer.unref?.();
    }
  }
  private fire(key: string): void {
    const e = this.m.get(key);
    if (!e) return;
    e.timer = undefined;
    const p = e.pending;
    e.pending = undefined;
    if (!p) return;
    e.last = Date.now();
    this.send(key, p.v, ++e.n);
  }
  /** Drops one key and whatever waits for it (a removed folder). */
  forget(key: string): void {
    const e = this.m.get(key);
    if (e?.timer) clearTimeout(e.timer);
    this.m.delete(key);
  }
  /** Drops every key that starts with `prefix` (the keys of one library session, R233 M4). */
  forgetPrefix(prefix: string): void {
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.forget(k);
  }
  has(key: string): boolean {
    return this.m.has(key);
  }
  get size(): number {
    return this.m.size;
  }
  clear(): void {
    for (const e of this.m.values()) if (e.timer) clearTimeout(e.timer);
    this.m.clear();
  }
}

const coalescers = new WeakMap<object, WatchStatusCoalescer<unknown>>();
/** The service's `watch.status` coalescer (for tests: that it keeps nothing for a removed folder or a closed library). */
export const coalescerOf = (state: object): WatchStatusCoalescer<unknown> | undefined => coalescers.get(state);

// ---------------------------------------------------------------------------------------------------------------

function requireUnlocked(s: Session, projectId: string): void {
  if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
}

function sourceParam(s: Session, projectId: string, req: FastifyRequest): string {
  const sid = paramsOf(req).sid ?? "";
  if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
  return sid;
}

async function folderParam(s: Session, projectId: string, req: FastifyRequest): Promise<Rec> {
  const wid = paramsOf(req).wid ?? "";
  const rec = (await listWatchedFolders(settingsDeps(s), projectId)).find((w) => w.id === wid);
  if (!rec) throw notFound("That watched folder");
  return rec;
}

/** The folder's name when it has no label (its last part; never the path). */
const folderName = (rec: Rec | undefined) => rec?.options.label ?? (rec?.dir ? path.basename(rec.dir) : "");

export function registerWatchedFolders(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  // ---- watch.status ----
  // Keys carry the library session's number, so a late status from a closed library touches only its own keys (M4).
  const sessionNos = new WeakMap<Session, number>();
  let nextNo = 0;
  const noOf = (s: Session) => {
    let n = sessionNos.get(s);
    if (n === undefined) sessionNos.set(s, (n = ++nextNo));
    return n;
  };
  const keyOf = (s: Session, projectId: string, wid: string) => `${noOf(s)}\u0000${projectId}\u0000${wid}`;
  const coalescer = new WatchStatusCoalescer<{ s: Session; projectId: string; st: WatchStatus }>(WATCH_STATUS_INTERVAL_MS, (key, { s, projectId, st }, n) => {
    const live = () => state.session === s && !state.shuttingDown && s.repo.isUnlocked(projectId) && coalescer.latest(key, n);
    if (!live()) return;
    void summaryById(ctx, s, projectId, st.watchId!, st).then(
      (folder) => {
        // Built after awaits: published only if nothing closed, locked, removed or overtook it meanwhile.
        if (live()) state.events.publish("watch.status", { projectId, folder } satisfies WatchStatusEvent as unknown as Record<string, unknown>);
      },
      () => {},
    );
  });
  coalescers.set(state, coalescer as WatchStatusCoalescer<unknown>);
  state.onWatchStatus = (s, projectId, st) => {
    // A status from a library that is no longer open (its watches stop as it closes): that library's keys go; the
    // open library's are not touched.
    if (state.session !== s) {
      coalescer.forgetPrefix(`${noOf(s)}\u0000`);
      return;
    }
    if (!st.watchId) return;
    coalescer.push(keyOf(s, projectId, st.watchId), { s, projectId, st });
  };

  // ---- the list ----
  app.get("/projects/:id/watched-folders", async (req): Promise<WatchedFoldersListResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const recs = await listWatchedFolders(settingsDeps(s), projectId);
    const cols = await collectionsOf(s, projectId);
    return { folders: await Promise.all(recs.map((r) => summaryOf(ctx, s, projectId, r, cols))) };
  });

  // ---- add, by grant ----
  app.post("/projects/:id/watched-folders", async (req, reply): Promise<WatchedFolderSummary> => {
    // The grant is taken first: whatever is refused below, it is spent (R233 M1).
    const given = takeGrant(ctx, req.body);
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const b = bodyOf(req);
    refusePath(b);
    onlyKeys(b, ["grantId", "label", "recursive", "collectionId"]);
    const label = b.label === undefined ? undefined : typeof b.label === "string" && b.label.trim() !== "" && b.label.length <= 200 ? b.label : null;
    if (label === null) throw badRequest(WATCH_ROUTE_TEXT.label);
    if (b.recursive !== undefined && typeof b.recursive !== "boolean") throw badRequest('"recursive" must be true or false.');
    const collectionId = b.collectionId;
    if (collectionId !== undefined && (typeof collectionId !== "string" || !(await collectionsOf(s, projectId)).has(collectionId))) throw badRequest(WATCH_ROUTE_TEXT.noCollection);
    if (given === null) throw badRequest(WATCH_ROUTE_TEXT.expired);
    const options = { ...(label !== undefined ? { label } : {}), ...(b.recursive !== undefined ? { recursive: b.recursive as boolean } : {}), ...(collectionId !== undefined ? { collectionId: collectionId as string } : {}) };
    const w = await serial(state, async () => {
      const real = await checkGranted(ctx, s, given);
      const added = await governedFolderStep(ctx, (timeoutMs) => addWatchedFolder(settingsDeps(s), projectId, real, options, { timeoutMs }));
      startOne(ctx, s, projectId, added, real);
      return added;
    });
    void reply.code(201);
    return summaryById(ctx, s, projectId, w.id);
  });

  // ---- this computer's folder for a watch, by grant ----
  app.put("/projects/:id/watched-folders/:wid/folder", async (req): Promise<WatchedFolderSummary> => {
    const given = takeGrant(ctx, req.body); // first: spent whatever is refused below (R233 M1)
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const b = bodyOf(req);
    refusePath(b);
    onlyKeys(b, ["grantId"]);
    const rec = await folderParam(s, projectId, req);
    if (given === null) throw badRequest(WATCH_ROUTE_TEXT.expired);
    await serial(state, async () => {
      // Checked again inside the queue: a remove may have come first (R233 M9).
      if (!(await listWatchedFolders(settingsDeps(s), projectId)).some((w) => w.id === rec.id)) throw notFound("That watched folder");
      const real = await checkGranted(ctx, s, given);
      await governedFolderStep(ctx, (timeoutMs) => setWatchFolder(settingsDeps(s), projectId, rec.id, real, { timeoutMs }));
      await stopOne(ctx, s, projectId, rec.id);
      startOne(ctx, s, projectId, rec, real);
    });
    return summaryById(ctx, s, projectId, rec.id);
  });

  // ---- options and this computer's choices ----
  app.patch("/projects/:id/watched-folders/:wid", async (req): Promise<WatchedFolderSummary> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const b = bodyOf(req);
    onlyKeys(b, ["label", "collectionId", "paused", "notDownloaded", "confirmBytes"]);
    if (b.paused !== undefined && typeof b.paused !== "boolean") throw badRequest('"paused" must be true or false.');
    if (b.notDownloaded !== undefined && b.notDownloaded !== "leave" && b.notDownloaded !== "download") throw badRequest('"notDownloaded" must be "leave" or "download".');
    if (b.confirmBytes !== undefined && (typeof b.confirmBytes !== "number" || !Number.isSafeInteger(b.confirmBytes) || b.confirmBytes < 0)) throw badRequest('"confirmBytes" must be a whole number of bytes.');
    if (b.confirmBytes !== undefined && b.notDownloaded !== "download") throw badRequest(WATCH_ROUTE_TEXT.confirmAlone);
    if (b.label !== undefined && b.label !== null && (typeof b.label !== "string" || b.label.trim() === "" || b.label.length > 200)) throw badRequest(WATCH_ROUTE_TEXT.label);
    if (b.collectionId !== undefined && b.collectionId !== null && (typeof b.collectionId !== "string" || !(await collectionsOf(s, projectId)).has(b.collectionId))) throw badRequest(WATCH_ROUTE_TEXT.noCollection);
    const rec = await folderParam(s, projectId, req);
    const options: { label?: string | null; collectionId?: string | null } = {
      ...(b.label !== undefined ? { label: b.label as string | null } : {}),
      ...(b.collectionId !== undefined ? { collectionId: b.collectionId as string | null } : {}),
    };
    const patch: Partial<WatchChoices> = {};
    if (b.paused !== undefined) patch.paused = b.paused as boolean;
    if (b.notDownloaded === "leave") patch.notDownloaded = "leave";
    if (b.notDownloaded === "download") {
      // What is confirmed is the folder's CURRENT size, and only when the researcher saw exactly that (Accept 3).
      const current = watchOf(s, projectId, rec.id)?.status().counts.notDownloadedBytes ?? 0;
      if (current === 0) throw new ApiError(409, "CONFLICT", WATCH_ROUTE_TEXT.nothing);
      if (b.confirmBytes !== current) throw new ApiError(409, "CONFLICT", WATCH_ROUTE_TEXT.sizeChanged);
      patch.notDownloaded = "download";
      patch.confirmedBytes = current;
    }
    if (Object.keys(patch).length === 0 && Object.keys(options).length === 0) throw badRequest(WATCH_ROUTE_TEXT.nothingToChange);
    // Everything is checked above; then the governed change of project.json, then this computer's choices.
    if (Object.keys(options).length > 0) {
      await serial(state, async () => {
        const u = await updateWatchedFolderEntry(s.repo, projectId, rec.id, options);
        // The running watch learns its collection at once, whatever it is doing (stuck, downloading, paused): nothing
        // restarts (R233 I3). A watch that is not running reads it from project.json when it next starts.
        for (const w of s.watches.get(projectId) ?? []) if (!w.stopped && w.status().watchId === rec.id) w.setCollection(u.options.collectionId);
      });
    }
    if (Object.keys(patch).length > 0) {
      try {
        await setWatchChoices(settingsDeps(s), projectId, rec.id, patch);
      } catch (err) {
        if (Object.keys(options).length === 0) throw err;
        // The governed change was made; the device choice was not: said in plain words (R227).
        throw new ApiError(503, "UNAVAILABLE", err instanceof WatchedFoldersUnreadableError ? WATCH_ROUTE_TEXT.halfDoneUnreadable : WATCH_ROUTE_TEXT.halfDone);
      }
      // The change holds at once (W4: otherwise a running watch reads its choices only every 10 s).
      await watchOf(s, projectId, rec.id)?.refreshChoices();
    }
    return summaryById(ctx, s, projectId, rec.id);
  });

  // ---- try again ----
  app.post("/projects/:id/watched-folders/:wid/retry", async (req): Promise<WatchedFolderSummary> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const rec = await folderParam(s, projectId, req);
    if (!rec.dir) throw new ApiError(409, "CONFLICT", WATCH_ROUTE_TEXT.notSetUp);
    const dir = rec.dir;
    const fresh = await serial(state, async () => {
      const cur = watchOf(s, projectId, rec.id);
      // A folder whose call is still outstanding (A6): a second watch would only join the thread it holds. Its
      // status already says so in the engine's words; nothing is started.
      if (cur && !cur.stopped && stuck(cur.status())) return undefined;
      // Only this folder restarts: the engine needs no restart of the project's other watches.
      await stopOne(ctx, s, projectId, rec.id);
      return startOne(ctx, s, projectId, rec, dir);
    });
    if (fresh) await Promise.race([fresh.ready.catch(() => {}), new Promise((r) => setTimeout(r, Math.min(5000, fsLimit(ctx))).unref?.())]);
    return summaryById(ctx, s, projectId, rec.id);
  });

  // ---- remove ----
  app.delete("/projects/:id/watched-folders/:wid", async (req): Promise<{ removed: true }> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const wid = paramsOf(req).wid ?? "";
    await serial(state, async () => {
      // The device list is read BEFORE the watch is stopped: one that cannot be read refuses with the folder still
      // watched and listed (R233 M8).
      const rec = (await listWatchedFolders(settingsDeps(s), projectId)).find((w) => w.id === wid);
      if (!rec) throw notFound("That watched folder");
      // The watch stops before its records go; the register and the sources stay (Accept 4).
      await stopOne(ctx, s, projectId, wid);
      try {
        await removeWatchedFolder(settingsDeps(s), projectId, wid);
      } catch (err) {
        // Not removed after all: watched again, as it was (never stopped-but-listed).
        if (rec.dir && (s.repo.getProject(projectId).watchedFolders ?? []).some((w) => w.id === wid)) startOne(ctx, s, projectId, rec, rec.dir);
        throw err;
      }
      // Removed. This computer's choices for it are cleaned up when they can be; a failure here does not undo the
      // removal (the choices of a watch that no longer exists are never read).
      await removeWatchChoices(settingsDeps(s), projectId, wid).catch(() => {
        app.log.warn("the choices of a removed watched folder could not be cleaned up");
      });
      coalescer.forget(keyOf(s, projectId, wid));
    });
    return { removed: true };
  });

  // ---- files that did not come in, and registered files that changed or went away ----
  app.get("/projects/:id/watched-folders/:wid/files", async (req): Promise<WatchedFolderFilesResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const q = queryOf(req);
    const kind = q.kind === undefined || q.kind === "" ? undefined : (q.kind as WatchedFileListKind);
    if (kind !== undefined && !WATCHED_FILE_LIST_KINDS.includes(kind)) throw badRequest(`"kind" must be one of: ${WATCHED_FILE_LIST_KINDS.join(", ")}.`);
    if (q.offset !== undefined && q.offset !== "" && !/^\d{1,15}$/u.test(q.offset)) throw badRequest(WATCH_ROUTE_TEXT.offset);
    const offset = q.offset === undefined || q.offset === "" ? 0 : Number(q.offset);
    const limit = intParam(q.limit, "limit", 1, WATCHED_FILES_LIMIT_MAX, WATCHED_FILES_LIMIT_MAX);
    const rec = await folderParam(s, projectId, req);
    const items: WatchedFolderFileItem[] = [];
    // What the engine holds in memory (never a read of the folder).
    const watch = rec.dir ? watchOf(s, projectId, rec.id) : undefined;
    if (watch && (kind === undefined || (kind !== "changed" && kind !== "gone"))) {
      const probs = watch.problems({ ...(kind ? { kind: kind as WatchFileKind } : {}), offset: 0, limit: PROBLEMS_ALL }).items;
      for (const p of probs) items.push(fileItemOf(p, state.roots));
    }
    // The folded register (A8).
    if (kind === undefined || kind === "changed" || kind === "gone") {
      for (const e of (await s.repo.watchRegister(projectId, rec.id)).values()) {
        if ((e.state === "changed" || e.state === "may-have-changed") && kind !== "gone") {
          items.push({ file: e.file, kind: "changed", reason: e.state === "changed" ? WATCH_ROUTE_TEXT.changed : WATCH_ROUTE_TEXT.mayHaveChanged, ...(e.newSize !== undefined ? { bytes: e.newSize } : {}), sourceId: e.sourceId });
        } else if (e.state === "gone" && kind !== "changed") {
          items.push({ file: e.file, kind: "gone", reason: WATCH_ROUTE_TEXT.gone, sourceId: e.sourceId });
        }
      }
    }
    // A stable order between pages: by kind (in WATCHED_FILE_LIST_KINDS' order), then by name.
    items.sort((a, b) => listOrder(a.kind) - listOrder(b.kind) || byName(a.file, b.file));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  });

  // ---- a source's origin in a watched folder, and the researcher's two acts ----
  app.get("/projects/:id/sources/:sid/watch-origin", async (req): Promise<SourceWatchOriginResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const sid = sourceParam(s, projectId, req);
    const recs = await listWatchedFolders(settingsDeps(s), projectId);
    const origins: WatchedSourceOrigin[] = [];
    for (const { watchId, entry } of await s.repo.watchOrigins(projectId, sid)) {
      const rec = recs.find((w) => w.id === watchId);
      const watch = rec?.dir ? watchOf(s, projectId, watchId) : undefined;
      // `local`: from what the engine last judged — a running watch, a state that implies the content was read
      // (the register's "in-library", "changed", "settled"), and the file not listed as not downloaded. The file is
      // never looked at for this answer.
      const listed = watch && !watch.stopped ? watch.problems({ kind: "not-downloaded", offset: 0, limit: PROBLEMS_ALL }).items.some((p) => p.file === entry.file) : true;
      const local = !!watch && !watch.stopped && (entry.state === "in-library" || entry.state === "changed" || entry.state === "settled") && !listed;
      origins.push({
        watchId,
        folderLabel: rec ? folderName(rec) : "",
        folderRemoved: !rec,
        file: entry.file,
        state: entry.state,
        ...(entry.newSize !== undefined ? { newBytes: entry.newSize } : {}),
        local,
      });
    }
    return { origins };
  });

  app.post("/projects/:id/sources/:sid/watch-origin/action", async (req): Promise<WatchedFileActionResponse> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    requireUnlocked(s, projectId);
    const b = bodyOf(req);
    onlyKeys(b, ["watchId", "action"]);
    if (typeof b.watchId !== "string" || b.watchId.length === 0 || b.watchId.length > 64) throw badRequest('"watchId" is required (text).');
    if (b.action !== "bring-in-new-version" && b.action !== "keep-as-it-is") throw badRequest('"action" must be "bring-in-new-version" or "keep-as-it-is".');
    const sid = sourceParam(s, projectId, req);
    const origin = (await s.repo.watchOrigins(projectId, sid)).find((o) => o.watchId === b.watchId);
    if (!origin) throw notFound("That file of a watched folder");
    const deps = state.watchDeps(s, projectId);
    if (b.action === "keep-as-it-is") {
      await settleWatchedFile(deps, projectId, origin.watchId, origin.entry.key);
      return { done: "settled", sourceId: sid };
    }
    const out = await bringInNewVersion(deps, projectId, origin.watchId, origin.entry.key);
    if (out.outcome !== "attached" && out.outcome !== "duplicate") throw new ApiError(409, "CONFLICT", out.reason ? scrubPaths(out.reason, state.roots) : WATCH_ROUTE_TEXT.notBroughtIn);
    return { done: "attached", sourceId: sid };
  });
}

