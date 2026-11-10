/**
 * Watched folders (spec 5.4; Task 26, R78c): files that appear in a folder the researcher chose are
 * added to a project, one at a time, under the drag-and-drop attach rules (attach.ts: sniffed type,
 * capture/store governance, R55–R58 identification, R56 location refusal, review queue below the
 * confidence threshold, provenance `manual_upload`).
 *
 *   - chokidar (pinned) with `awaitWriteFinish` (2000 ms of unchanged size) and `ignoreInitial`:
 *     only files that arrive after the watch starts, each once it has stopped growing;
 *   - partial downloads and temporary names are ignored (`.part`, `.crdownload`, `.download`,
 *     `.tmp`, Office `~$` lock files, `.DS_Store`, any dotfile or dot-folder);
 *   - the watched folder is the file's only allowed root (R67): a file whose real path (links
 *     followed) is outside it is refused;
 *   - every problem becomes an event (`failed` / `error`) with a plain reason and the file's name
 *     relative to the folder — never an absolute path — and the watch goes on; nothing is thrown;
 *   - the watch stops by itself when the library is closed or this computer loses its lock (the
 *     library turns read-only), with a `stopped` event.
 *
 * Settings (R69): which folder is watched is an absolute path on this computer, so it is a device
 * setting (`<appConfigDir>/watched-folders.json`, by library id, project id and watch id, 0600),
 * never stored in the library. project.json keeps only each watch's id and options (a governed,
 * audited change), so another computer sees the watch but must choose its folder.
 */
import * as fsp from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { WatchedFolderOptions, type WatchedFolder, type WatchedFolderOptions as WatchedFolderOptionsT } from "@ao/core";
import { writeSmallFileAtomic } from "../fs/atomic.js";
import { isClosed, type Library } from "../library.js";
import type { HttpClient } from "../lookup/index.js";
import { addWatchedFolderEntry, removeWatchedFolderEntry, type Repo } from "../repo/repo.js";
import { createAttach, type Attach, type AttachStatus } from "./attach.js";

/** How long a file's size must stay unchanged before it is imported (R78). */
export const WATCH_STABILITY_MS = 2000;
const POLL_MS = 2000;
const MAX_DEPTH = 20;

export const WATCH_REASONS = {
  outside: "The file is outside the watched folder (it is a link to somewhere else), so it was not imported.",
  failed: "The file could not be imported.",
  watchFailed: "The folder could not be watched (it may have been removed, renamed or disconnected).",
  libraryClosed: "The library was closed or another computer took it over, so the folder is no longer watched.",
} as const;

export interface WatchEvent {
  kind: "imported" | "failed" | "error" | "stopped";
  /** The file, relative to the watched folder ("/"-separated). Never absolute. */
  file?: string;
  outcome?: AttachStatus;
  sourceId?: string;
  reason?: string;
}

export interface WatchDeps {
  repo: Repo;
  http: HttpClient;
  lib: Library;
  /** The attach used for each file (default: createAttach({ repo, http })). */
  attach?: Attach;
  onEvent?: (e: WatchEvent) => void;
  debug?: (note: string) => void;
  /** Test seams: the stability period (default WATCH_STABILITY_MS) and how often the library's state is checked. */
  stabilityMs?: number;
  pollMs?: number;
}

export interface FolderWatch {
  /** Settles when the folder is being watched (or the watch failed to start: see the events). */
  readonly ready: Promise<void>;
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
  const attach = deps.attach ?? createAttach({ repo: deps.repo, http: deps.http, ...(deps.debug ? { debug: deps.debug } : {}) });
  let stopped = false;
  let watcher: FSWatcher | undefined;
  let queue: Promise<void> = Promise.resolve();
  let realRoot = root;
  const relName = (p: string) => relative(root, p).split(sep).join("/");

  const libraryGone = () => isClosed(deps.lib) || deps.lib.mode !== "read-write";

  async function importOne(path: string): Promise<void> {
    if (stopped) return;
    if (libraryGone()) {
      void stopWith(WATCH_REASONS.libraryClosed);
      return;
    }
    const file = relName(path);
    try {
      const real = await fsp.realpath(path).catch(() => null);
      if (!real) return; // gone again before it could be read (a temporary file renamed away)
      if (!within(realRoot, real)) {
        emit({ kind: "failed", file, reason: WATCH_REASONS.outside });
        return;
      }
      const [o] = await attach.attachFiles(projectId, [real]);
      if (!o) return;
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

  const timer = setInterval(() => {
    if (!stopped && libraryGone()) void stopWith(WATCH_REASONS.libraryClosed);
  }, deps.pollMs ?? POLL_MS);
  timer.unref?.();

  const ready = (async () => {
    try {
      realRoot = await fsp.realpath(root);
      const st = await fsp.stat(realRoot);
      if (!st.isDirectory()) throw new Error("not a folder");
    } catch {
      emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
      await stopWith();
      return;
    }
    if (stopped) return;
    const stability = deps.stabilityMs ?? WATCH_STABILITY_MS;
    watcher = chokidarWatch(root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: opts.recursive ? MAX_DEPTH : 0,
      awaitWriteFinish: { stabilityThreshold: stability, pollInterval: Math.min(100, stability) },
      // The folder itself is never ignored; anything below it with an ignored name (or in a dot-folder) is.
      ignored: (p: string) => resolve(p) !== root && relName(resolve(p)).split("/").some(ignoredName),
    });
    watcher.on("add", (p: string) => {
      const abs = resolve(root, p);
      if (ignoredName(basename(abs))) return;
      queue = queue.then(() => importOne(abs));
    });
    watcher.on("error", () => {
      emit({ kind: "error", reason: WATCH_REASONS.watchFailed });
    });
    await new Promise<void>((r) => watcher!.once("ready", () => r()));
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

async function readStore(appConfigDir: string): Promise<Store> {
  const out = Object.create(null) as Store;
  try {
    const raw = JSON.parse(await fsp.readFile(join(appConfigDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
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
  } catch {
    // no file yet, or unreadable: no folders on this computer
  }
  return out;
}

let lock: Promise<unknown> = Promise.resolve();
function updateStore(lib: Pick<Library, "id" | "appConfigDir">, fn: (s: Store) => void): Promise<void> {
  const next = lock.then(async () => {
    const store = await readStore(lib.appConfigDir); // re-read under the lock
    fn(store);
    await fsp.mkdir(lib.appConfigDir, { recursive: true });
    await writeSmallFileAtomic(join(lib.appConfigDir, FILE), JSON.stringify(store, null, 2), { mode: 0o600 });
  });
  lock = next.catch(() => {});
  return next;
}

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

export interface WatchSettingsDeps {
  repo: Repo;
  lib: Pick<Library, "id" | "appConfigDir">;
}

/** Adds a watched folder: its id and options to project.json (governed, audited), its folder to this device's settings. */
export async function addWatchedFolder(deps: WatchSettingsDeps, projectId: string, dir: string, options: Partial<WatchedFolderOptionsT> = {}): Promise<WatchedFolder> {
  if (!isAbsolute(dir)) throw new TypeError("The watched folder must be an absolute path.");
  const real = await fsp.realpath(dir);
  if (!(await fsp.stat(real)).isDirectory()) throw new TypeError("The watched folder must be a folder.");
  deps.repo.getProject(projectId); // NotFoundError for an unknown project
  const wf = await addWatchedFolderEntry(deps.repo, projectId, options);
  await updateStore(deps.lib, (s) => {
    const projects = own(s, deps.lib.id) ?? (Object.create(null) as Record<string, Record<string, string>>);
    const watches = own(projects, projectId) ?? (Object.create(null) as Record<string, string>);
    watches[wf.id] = real;
    projects[projectId] = watches;
    s[deps.lib.id] = projects;
  });
  return wf;
}

/** Removes a watched folder from project.json and from this device's settings. */
export async function removeWatchedFolder(deps: WatchSettingsDeps, projectId: string, id: string): Promise<void> {
  await removeWatchedFolderEntry(deps.repo, projectId, id);
  await updateStore(deps.lib, (s) => {
    const watches = own(own(s, deps.lib.id) ?? {}, projectId);
    if (watches && Object.hasOwn(watches, id)) delete watches[id];
  });
}

/** The project's watched folders, each with its folder on this computer (`dir` undefined when none was chosen here). */
export async function listWatchedFolders(deps: WatchSettingsDeps, projectId: string): Promise<Array<WatchedFolder & { dir?: string }>> {
  const store = await readStore(deps.lib.appConfigDir);
  const watches = own(own(store, deps.lib.id) ?? {}, projectId) ?? {};
  return (deps.repo.getProject(projectId).watchedFolders ?? []).map((w) => {
    const dir = own(watches, w.id);
    return { ...structuredClone(w), ...(dir ? { dir } : {}) };
  });
}

/** Starts every watched folder of the project that has a folder on this computer. */
export async function startWatchedFolders(deps: WatchDeps, projectId: string): Promise<FolderWatch[]> {
  const out: FolderWatch[] = [];
  for (const w of await listWatchedFolders(deps, projectId)) if (w.dir) out.push(watchFolder(deps, projectId, w.dir, w.options));
  return out;
}
