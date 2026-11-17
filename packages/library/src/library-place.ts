/**
 * R447 (Task FR-A23): a place for a new library, and the room on the disk under a chosen folder, for the screen
 * "Choose a library". Both only read: whether a few folders exist and are empty, and the free room of one disk.
 * Nothing is created, and nothing read leaves here but the suggested path or a number.
 */
import { lstat, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import { statfsFree } from "./import/sqlite-copy.js";
import { entriesBesidesFinderFiles } from "./library.js";
import { classifyLocation, type LocationEnv } from "./location.js";

/** The name of a suggested library folder. */
export const LIBRARY_FOLDER_NAME = "Alexandrine Oxiana";

/** What a folder is, as far as the suggestion needs to know. */
export type FolderState = "missing" | "empty" | "not-empty" | "not-a-folder" | "unreadable";

export interface PlaceLooks {
  /** What is at `p` (default: the real file system; the Finder's housekeeping files alone leave a folder empty). */
  folderState?: (p: string) => Promise<FolderState>;
}

/**
 * What is at `p`, by lstat (R449 c): nothing at all is "missing"; a link (to somewhere or to nowhere) or a file is
 * "not-a-folder"; a folder is "empty" or "not-empty". Only a missing name or an empty folder is free.
 */
async function realFolderState(p: string): Promise<FolderState> {
  try {
    if (!(await lstat(p)).isDirectory()) return "not-a-folder";
    // As createLibrary counts it (FR-047): a folder holding only .DS_Store or .localized is empty.
    return (await entriesBesidesFinderFiles(p)).length === 0 ? "empty" : "not-empty";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

/**
 * The folder "Choose a library" suggests for a new library (R447 a as R449 a corrects it), or undefined when there is
 * none: `<home>/Alexandrine Oxiana`; when that is taken, the same name with " 2" … " 9", the first that is free.
 * Nothing under Documents is looked at (R449 a: iCloud's keeping of Documents cannot be told from its path, and a Mac
 * asks the researcher's permission the moment a program looks into it). None when the home folder is not known, or
 * when its own path is a cloud-synced place by classifyLocation (the path and the environment alone; no look).
 */
export async function suggestedLibraryFolder(env: LocationEnv, looks: PlaceLooks = {}): Promise<string | undefined> {
  const home = env.homeDir;
  if (!home) return undefined;
  if (classifyLocation(home, env).kind === "cloud_folder") return undefined;
  const P = env.platform === "win32" ? win32 : posix;
  const folderState = looks.folderState ?? realFolderState;
  const first = P.join(home, LIBRARY_FOLDER_NAME);
  for (const candidate of [first, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${first} ${n}`)]) {
    const s = await folderState(candidate);
    if (s === "missing" || s === "empty") return candidate;
  }
  return undefined;
}

/** How long one look at a disk's free room may take (R447 b: a share that does not answer within it is "cannot tell"). */
export const FOLDER_ROOM_LOOK_MS = 2000;

export interface RoomLooks {
  /** Whether `p` is an existing folder (default: stat). */
  isFolder?: (p: string) => Promise<boolean>;
  /** The free bytes of the disk holding the folder `p` (default: statfsFree; Infinity when it cannot tell). */
  free?: (p: string) => Promise<number>;
}

const isRealFolder = async (p: string) => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

/** The paths whose look is still running in this process: one that does not answer is not looked at again until it does (as R429 e). */
const roomsBeingLookedAt = new Set<string>();

/**
 * The free bytes of the disk under `path` (R447 b), read for the folder, or for the nearest folder above it that
 * exists; undefined when it cannot be told — a path that is not a full local one, a place that cannot be read, a
 * look (the walk up and the read) that has not answered within FOLDER_ROOM_LOOK_MS. Never a guessed figure.
 */
export async function freeRoomFor(path: string, looks: RoomLooks = {}): Promise<number | undefined> {
  if (typeof path !== "string" || path === "" || path.includes("\0") || !isAbsolute(path)) return undefined;
  if (roomsBeingLookedAt.has(path)) return undefined;
  const isFolder = looks.isFolder ?? isRealFolder;
  const free = looks.free ?? statfsFree;
  const look = async (): Promise<number | undefined> => {
    let dir = path;
    while (!(await isFolder(dir))) {
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
    const n = await free(dir);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  roomsBeingLookedAt.add(path);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), FOLDER_ROOM_LOOK_MS);
  });
  const run = look()
    .catch(() => undefined)
    .finally(() => roomsBeingLookedAt.delete(path));
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}
