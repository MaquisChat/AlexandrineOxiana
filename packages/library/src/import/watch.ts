/**
 * Watched folders (spec 5.4; Task 26, R78c, R81): files that appear in a folder the researcher
 * chose are added to a project, one at a time, under the drag-and-drop attach rules (attach.ts:
 * sniffed type, capture/store governance, R55–R58 identification, R56 location refusal, review queue
 * below the confidence threshold, provenance `manual_upload`). Every store goes through the
 * project's queue (project-queue.ts), shared with drag-and-drop and Bulk Import (R81 I4).
 *
 *   - chokidar (pinned) with `awaitWriteFinish` (2000 ms of unchanged size): a file is imported once
 *     it has stopped growing; a file whose content changes later is imported again (its new content
 *     is a new file; unchanged content is recognised by its SHA-256 and skipped);
 *   - when the watch starts, and when a locked encrypted project is unlocked, the folder is scanned
 *     for files not yet in the project (by SHA-256); files already imported are skipped silently;
 *   - partial downloads and temporary names are ignored (`.part`, `.crdownload`, `.download`,
 *     `.tmp`, Office `~$` lock files, `.DS_Store`, any dotfile or dot-folder);
 *   - links: the watched folder is the file's only allowed root (R67). A link to a file elsewhere is
 *     refused (WATCH_REASONS.outside); links to folders are never followed (WATCH_REASONS.folderLink);
 *     a link to a file inside the folder is imported once, like the file itself;
 *   - a folder inside the library, or one that holds the library, is refused (by real path);
 *   - an encrypted project that is locked pauses the watch (`paused`) until it is unlocked;
 *   - the watched folder removed: `stopped` with WATCH_REASONS.removed; it is looked for again every
 *     poll (≤ 10 s) and the watch resumes (`resumed`) when it is back;
 *   - every problem is an event (`failed` / `error`) with a plain reason and the file's name relative
 *     to the folder — never an absolute path — and the watch goes on; nothing is thrown;
 *   - the watch ends by itself when the library is closed or this computer loses its lock.
 *
 * Settings (R69): which folder is watched is an absolute path on this computer, so it is a device
 * setting (`<appConfigDir>/watched-folders.json`, by library id, project id and watch id, 0600 in a
 * 0700 folder), never stored in the library. project.json keeps only each watch's id and options (a
 * governed, audited change); another computer chooses its own folder with setWatchFolder. An
 * unreadable settings file is moved aside (`watched-folders.unreadable-<time>.json`) with a warning,
 * never silently emptied.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { WatchedFolderOptions, type WatchedFolder, type WatchedFolderOptions as WatchedFolderOptionsT } from "@ao/core";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { isClosed, type Library } from "../library.js";
import type { HttpClient } from "../lookup/index.js";
import { addWatchedFolderEntry, projectEncrypted, removeWatchedFolderEntry, type Repo } from "../repo/repo.js";
import { createAttach, type Attach, type AttachStatus } from "./attach.js";
import { proxyQueueFor, type ProxyQueue } from "./proxies.js";

/** How long a file's size must stay unchanged before it is imported (R78). */
export const WATCH_STABILITY_MS = 2000;
/** How often the folder, the project's lock and the library are checked (R81: at most 10 s). */
const POLL_MS = 2000;
const MAX_DEPTH = 20;

export const WATCH_REASONS = {
  outside: "The file is outside the watched folder (it is a link to somewhere else), so it was not imported.",
  folderLink: "This is a link to a folder; links to folders are not followed in a watched folder.",
  failed: "The file could not be imported.",
  watchFailed: "The folder could not be watched (it may have been renamed or disconnected).",
  removed: "The watched folder was removed; watching will continue when it is back.",
  library: "A watched folder cannot be inside the library or contain it. Choose another folder.",
  locked: "The project is locked; new files are imported when it is unlocked.",
  libraryClosed: "The library was closed or another computer took it over, so the folder is no longer watched.",
  settingsUnreadable: "The list of watched folders on this computer could not be read; it was set aside and a new one started.",
} as const;

export interface WatchEvent {
  kind: "imported" | "failed" | "error" | "stopped" | "paused" | "resumed";
  /** The file, relative to the watched folder ("/"-separated). Never absolute. */
  file?: string;
  outcome?: AttachStatus;
  sourceId?: string;
  reason?: string;
}

export interface WatchDeps {
  /** Viewing proxies (R83); default: the library's queue (proxyQueueFor). */
  proxies?: ProxyQueue;
  repo: Repo;
  http: HttpClient;
  lib: Library;
  /** The attach used for each file (default: createAttach({ repo, http })). */
  attach?: Attach;
  onEvent?: (e: WatchEvent) => void;
  debug?: (note: string) => void;
  /** Test seams: the stability period (default WATCH_STABILITY_MS) and how often the folder and library are checked. */
  stabilityMs?: number;
  pollMs?: number;
}

export interface FolderWatch {
  /** Settles when the folder is being watched and its first scan is queued (or the watch could not start: see the events). */
  readonly ready: Promise<void>;
  /** True once the watch has ended for good (stop(), library closed, folder refused). */
  readonly stopped: boolean;
  /** Stops watching; files being imported finish first. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Names never imported: partial downloads, temporary files, Office lock files and dotfiles (incl. .DS_Store). */
export function ignoredName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith(".") ||
    n.startsWith("~$") ||
    n.endsWith(".part") ||
    n.endsWith(".crdownload") ||
    n.endsWith(".download") ||
    n.endsWith(".tmp") ||
    n === "thumbs.db" ||
    n === "desktop.ini"
  );
}

const within = (folder: string, p: string) => {
  const rel = relative(folder, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Whether `dir` (a real path) is the library, inside it, or holds it. */
async function overlapsLibrary(dir: string, lib: Pick<Library, "root">): Promise<boolean> {
  const root = await fsp.realpath(lib.root).catch(() => resolve(lib.root));
  return dir === root || within(root, dir) || within(dir, root);
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path) as AsyncIterable<Buffer>) h.update(c);
  return h.digest("hex");
}

/**
 * Watches `dir` (absolute) and adds each new file to the project. Errors are reported through
 * `onEvent`, never thrown.
 */
export function watchFolder(deps: WatchDeps, projectId: string, dir: string, options: Partial<WatchedFolderOptionsT> = {}): FolderWatch {
  const opts = WatchedFolderOptions.parse(options);
  const root = resolve(dir);
  const emit = (e: WatchEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // a listener's error never stops the watch
    }
  };
  // Viewing proxies go through the library's one queue (R85), unless the caller gives one.
  const attach = deps.attach ?? createAttach({ repo: deps.repo, http: deps.http, proxies: deps.proxies ?? proxyQueueFor(deps.repo), ...(deps.debug ? { debug: deps.debug } : {}) });
  const stability = deps.stabilityMs ?? WATCH_STABILITY_MS;
  let stopped = false;
  /** The folder is gone (waiting for it to come back). */
  let removed = false;
  /** Paused because the project is locked: a full scan follows the unlock. */
  let locked = false;
  let watcher: FSWatcher | undefined;
  let queue: Promise<void> = Promise.resolve();
  let realRoot = root;
  /** SHA-256 of every file already in the project (read when first needed, kept up to date). */
  let known: Set<string> | null = null;
  /**
   * Files handled in this session by real path, with the size and modification time they had then:
   * an unchanged file is not hashed again by a scan, and one that failed is not retried (nor
   * reported again) until its size or modification time changes.
   */
  const handled = new Map<string, { size: number; mtimeMs: number; failed: boolean }>();
  const note = (real: string, st: { size: number; mtimeMs: number }, failed: boolean) => handled.set(real, { size: st.size, mtimeMs: st.mtimeMs, failed });
  const relName = (p: string) => relative(root, p).split(sep).join("/");
  const libraryGone = () => isClosed(deps.lib) || deps.lib.mode !== "read-write";
  const projectLocked = () => projectEncrypted(deps.repo, projectId) && !deps.repo.isUnlocked(projectId);

  async function knownHashes(): Promise<Set<string>> {
    if (known) return known;
    const out = new Set<string>();
    for (const id of deps.repo.listSourceIds(projectId)) {
      try {
        for (const a of (await deps.repo.getSource(projectId, id)).assets) out.add(a.sha256);
      } catch {
        // unreadable source: its files are compared by attach itself
      }
    }
    known = out;
    return out;
  }

  /**
   * `quiet`: from a scan or a change — a file whose content is already in the project is skipped
   * without an event. A new file (`add`) always gets an event (attach reports a duplicate).
   */
  async function importOne(path: string, quiet: boolean): Promise<void> {
    if (stopped || removed) return;
    if (libraryGone()) {
      void stopWith(WATCH_REASONS.libraryClosed);
      return;
    }
    if (projectLocked()) {
      if (!locked) {
        locked = true;
        known = null;
        emit({ kind: "paused", reason: WATCH_REASONS.locked });
      }
      return;
    }
    const file = relName(path);
    try {
      const real = await fsp.realpath(path).catch(() => null);
      if (!real) return; // gone again before it could be read (a temporary file renamed away)
      const st = await fsp.stat(real).catch(() => null);
      if (!st) return;
      if (st.isDirectory()) {
        emit({ kind: "failed", file, reason: WATCH_REASONS.folderLink });
        return;
      }
      if (!within(realRoot, real)) {
        emit({ kind: "failed", file, reason: WATCH_REASONS.outside });
        return;
      }
      if (!st.isFile()) return;
      const before = handled.get(real);
      if (before && before.size === st.size && before.mtimeMs === st.mtimeMs && (quiet || before.failed)) return;
      const sha = await sha256Of(real);
      if (quiet && (await knownHashes()).has(sha)) {
        note(real, st, false);
        return;
      }
      const [o] = await attach.attachFiles(projectId, [real]);
      if (!o) return;
      note(real, st, o.outcome === "failed");
      if (o.outcome !== "failed") (await knownHashes()).add(sha);
      emit({
        kind: o.outcome === "failed" ? "failed" : "imported",
        file,
        outcome: o.outcome,
        ...(o.sourceId ? { sourceId: o.sourceId } : {}),
        ...(o.reason ? { reason: o.reason } : {}),
      });
    } catch (err) {
      deps.debug?.(`watched folder: import failed (${err instanceof Error ? err.name : "error"})`);
      emit({ kind: "failed", file, reason: WATCH_REASONS.failed });
    }
  }

  const enqueue = (path: string, quiet: boolean) => {
    queue = queue.then(() => importOne(path, quiet));
  };

  /** Queues every file in the folder (quietly: what is already in the project is skipped), 100 at a time. */
  async function scanFolder(): Promise<void> {
    let n = 0;
    const walk = async (d: string, depth: number): Promise<void> => {
      const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (ignoredName(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (opts.recursive && depth < MAX_DEPTH) await walk(p, depth + 1);
        } else if (e.isFile() || e.isSymbolicLink()) {
          enqueue(p, true);
          if (++n % 100 === 0) await queue; // never more than a chunk waiting in memory
          if (stopped || removed) return;
        }
      }
    };
    await walk(root, 0);
  }

  /** The folder's checks (at start and on every resume): real path, a folder, apart from the library. Null when fine. */
  async function checkRoot(): Promise<string | null> {
    try {
      realRoot = await fsp.realpath(root);
      if (!(await fsp.stat(realRoot)).isDirectory()) return WATCH_REASONS.watchFailed;
    } catch {
      return WATCH_REASONS.watchFailed;
    }
    return (await overlapsLibrary(realRoot, deps.lib)) ? WATCH_REASONS.library : null;
  }

  let stopping: Promise<void> | undefined;
  function stopWith(reason?: string): Promise<void> {
    stopping ??= (async () => {
      stopped = true;
      clearInterval(timer);
      await watcher?.close().catch(() => {});
      await queue.catch(() => {});
      emit({ kind: "stopped", ...(reason ? { reason } : {}) });
    })();
    return stopping;
  }

  async function startWatcher(): Promise<void> {
    watcher = chokidarWatch(root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: opts.recursive ? MAX_DEPTH : 0,
      awaitWriteFinish: { stabilityThreshold: stability, pollInterval: Math.min(100, stability) },
      // The folder itself is never ignored; anything below it with an ignored name (or in a dot-folder) is.
      ignored: (p: string) => resolve(p) !== root && relName(resolve(p)).split("/").some(ignoredName),
    });
    const onFile = (quiet: boolean) => (p: string) => {
      const abs = resolve(root, p);
      if (ignoredName(basename(abs))) return;
      enqueue(abs, quiet);
    };
    watcher.on("add", onFile(false));
    watcher.on("change", onFile(true));
    watcher.on("error", () => {
      if (!removed) emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
    });
    await new Promise<void>((r) => watcher!.once("ready", () => r()));
  }

  let polling = false;
  const timer = setInterval(() => {
    if (stopped || polling) return;
    polling = true;
    void (async () => {
      if (libraryGone()) {
        await stopWith(WATCH_REASONS.libraryClosed);
        return;
      }
      const present = !!(await fsp.stat(root).catch(() => null))?.isDirectory();
      if (!removed && !present) {
        removed = true;
        const w = watcher;
        watcher = undefined;
        await w?.close().catch(() => {});
        emit({ kind: "stopped", reason: WATCH_REASONS.removed });
      } else if (removed && present) {
        // What came back may not be the folder that went away (e.g. a link into the library): checked again.
        const bad = await checkRoot();
        if (bad) {
          await stopWith(bad);
          return;
        }
        removed = false;
        await startWatcher();
        emit({ kind: "resumed" });
        await scanFolder();
      }
      if (locked && !projectLocked()) {
        locked = false;
        emit({ kind: "resumed" });
        await scanFolder();
      }
    })()
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, Math.min(deps.pollMs ?? POLL_MS, 10_000));
  timer.unref?.();

  const ready = (async () => {
    const bad = await checkRoot();
    if (bad) {
      emit({ kind: "error", reason: bad });
      await stopWith();
      return;
    }
    if (stopped) return;
    await startWatcher();
    // Files that arrived while nothing was watching.
    await scanFolder();
  })().catch(() => {
    emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
  });

  return {
    ready,
    get stopped() {
      return stopped;
    },
    stop: () => stopWith(),
  };
}

// ------------------------------------------------------------------------------------------
// Settings: project.json (id + options) and this device's folder for each watch (R69).

const FILE = "watched-folders.json";
type Store = Record<string, Record<string, Record<string, string>>>;

/** The store; `corrupt` when a file exists but cannot be read as one (it is then moved aside before any write). */
async function readStore(appConfigDir: string): Promise<{ store: Store; corrupt: boolean }> {
  const out = Object.create(null) as Store;
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(join(appConfigDir, FILE), "utf8")) as unknown;
  } catch (err) {
    return { store: out, corrupt: (err as NodeJS.ErrnoException)?.code !== "ENOENT" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { store: out, corrupt: true };
  for (const libId of Object.keys(raw)) {
    const projects = (raw as Record<string, unknown>)[libId];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) continue;
    const p = Object.create(null) as Record<string, Record<string, string>>;
    for (const projectId of Object.keys(projects)) {
      const watches = (projects as Record<string, unknown>)[projectId];
      if (!watches || typeof watches !== "object" || Array.isArray(watches)) continue;
      const w = Object.create(null) as Record<string, string>;
      for (const id of Object.keys(watches)) {
        const d = (watches as Record<string, unknown>)[id];
        if (typeof d === "string" && isAbsolute(d)) w[id] = d;
      }
      p[projectId] = w;
    }
    out[libId] = p;
  }
  return { store: out, corrupt: false };
}

export interface WatchSettingsDeps {
  repo: Repo;
  lib: Pick<Library, "id" | "appConfigDir" | "root">;
  /** Receives plain warnings (an unreadable settings file set aside). */
  onWarning?: (warning: string) => void;
}

/** Moves an unreadable settings file aside (never deleted) and warns. */
async function setAside(deps: WatchSettingsDeps): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  await fsp.rename(join(deps.lib.appConfigDir, FILE), join(deps.lib.appConfigDir, `watched-folders.unreadable-${stamp}.json`)).catch(() => {});
  deps.onWarning?.(WATCH_REASONS.settingsUnreadable);
}

let lock: Promise<unknown> = Promise.resolve();
function updateStore(deps: WatchSettingsDeps, fn: (s: Store) => void): Promise<void> {
  const lib = deps.lib;
  const next = lock.then(async () => {
    const { store, corrupt } = await readStore(lib.appConfigDir); // re-read under the lock
    if (corrupt) await setAside(deps);
    fn(store);
    await fsp.mkdir(lib.appConfigDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(lib.appConfigDir, 0o700).catch(() => {});
    await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
  });
  lock = next.catch(() => {});
  return next;
}

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** The folder's real path, checked: absolute, a folder, not inside the library nor holding it. */
async function checkedFolder(deps: WatchSettingsDeps, dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new TypeError("The watched folder must be an absolute path.");
  const real = await fsp.realpath(dir);
  if (!(await fsp.stat(real)).isDirectory()) throw new TypeError("The watched folder must be a folder.");
  if (await overlapsLibrary(real, deps.lib)) throw new TypeError(WATCH_REASONS.library);
  return real;
}

function putFolder(deps: WatchSettingsDeps, projectId: string, id: string, real: string): Promise<void> {
  return updateStore(deps, (s) => {
    const projects = own(s, deps.lib.id) ?? (Object.create(null) as Record<string, Record<string, string>>);
    const watches = own(projects, projectId) ?? (Object.create(null) as Record<string, string>);
    watches[id] = real;
    projects[projectId] = watches;
    s[deps.lib.id] = projects;
  });
}

/** Adds a watched folder: its id and options to project.json (governed, audited), its folder to this device's settings. */
export async function addWatchedFolder(deps: WatchSettingsDeps, projectId: string, dir: string, options: Partial<WatchedFolderOptionsT> = {}): Promise<WatchedFolder> {
  const real = await checkedFolder(deps, dir);
  deps.repo.getProject(projectId); // NotFoundError for an unknown project
  const wf = await addWatchedFolderEntry(deps.repo, projectId, options);
  await putFolder(deps, projectId, wf.id, real);
  return wf;
}

/** Chooses this computer's folder for a watch the project already has (e.g. one added on another computer). */
export async function setWatchFolder(deps: WatchSettingsDeps, projectId: string, id: string, dir: string): Promise<void> {
  if (!(deps.repo.getProject(projectId).watchedFolders ?? []).some((w) => w.id === id)) throw new TypeError("This project has no such watched folder.");
  await putFolder(deps, projectId, id, await checkedFolder(deps, dir));
}

/** Removes a watched folder from project.json and from this device's settings. */
export async function removeWatchedFolder(deps: WatchSettingsDeps, projectId: string, id: string): Promise<void> {
  await removeWatchedFolderEntry(deps.repo, projectId, id);
  await updateStore(deps, (s) => {
    const watches = own(own(s, deps.lib.id) ?? {}, projectId);
    if (watches && Object.hasOwn(watches, id)) delete watches[id];
  });
}

/** The project's watched folders, each with its folder on this computer (`dir` undefined when none was chosen here). */
export async function listWatchedFolders(deps: WatchSettingsDeps, projectId: string): Promise<Array<WatchedFolder & { dir?: string }>> {
  const { store, corrupt } = await readStore(deps.lib.appConfigDir);
  if (corrupt) await updateStore(deps, () => {}); // set aside (with the warning) under the lock
  const watches = own(own(store, deps.lib.id) ?? {}, projectId) ?? {};
  return (deps.repo.getProject(projectId).watchedFolders ?? []).map((w) => {
    const dir = own(watches, w.id);
    return { ...structuredClone(w), ...(dir ? { dir } : {}) };
  });
}

/** Starts every watched folder of the project that has a folder on this computer. */
export async function startWatchedFolders(deps: WatchDeps & Pick<WatchSettingsDeps, "onWarning">, projectId: string): Promise<FolderWatch[]> {
  const out: FolderWatch[] = [];
  for (const w of await listWatchedFolders(deps, projectId)) if (w.dir) out.push(watchFolder(deps, projectId, w.dir, w.options));
  return out;
}
