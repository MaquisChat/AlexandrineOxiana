/**
 * Watched folders (cloud-drive watched folders, Task W7; R207, R96): the service's routes, declared
 * once for the service and the interface. Every route is for the desktop app's token only (the
 * browser extension's token gets 403, reads included). A folder is chosen only through the shell's
 * folder chooser, which hands the service a single-use grant: no request ever carries a folder path,
 * and no answer carries one except `place.display` (the researcher's own choice, R96).
 *
 *   GET    /projects/:id/watched-folders                        → WatchedFoldersListResponse
 *   POST   /projects/:id/watched-folders                        WatchedFolderAddRequest → 201 WatchedFolderSummary
 *   PUT    /projects/:id/watched-folders/:wid/folder            WatchedFolderSetFolderRequest → WatchedFolderSummary
 *   PATCH  /projects/:id/watched-folders/:wid                   WatchedFolderPatchRequest → WatchedFolderSummary
 *   POST   /projects/:id/watched-folders/:wid/retry             → WatchedFolderSummary
 *   DELETE /projects/:id/watched-folders/:wid                   → { removed: true }
 *   GET    /projects/:id/watched-folders/:wid/files?kind=&offset=&limit=   → WatchedFolderFilesResponse
 *   GET    /projects/:id/sources/:sid/watch-origin              → SourceWatchOriginResponse
 *   POST   /projects/:id/sources/:sid/watch-origin/action       WatchedFileActionRequest → WatchedFileActionResponse
 *
 * Live updates: the server-sent event `watch.status` with a WatchStatusEvent, at most one per folder
 * per second; the last state of a burst is always delivered.
 */

/** Why a file of a watched folder did not come in (the engine's kinds; `removed-here`: Amendment A8). */
export const WATCH_FILE_KINDS = ["not-downloaded", "online-only-document", "not-supported", "could-not-import", "not-permitted", "could-not-download", "removed-here"] as const;
export type WatchFileKind = (typeof WATCH_FILE_KINDS)[number];

/** What `GET …/files` lists: the files that did not come in, and the files of the register that changed or went away. */
export const WATCHED_FILE_LIST_KINDS = [...WATCH_FILE_KINDS, "changed", "gone"] as const;
export type WatchedFileListKind = (typeof WATCHED_FILE_LIST_KINDS)[number];

/** The most files one page of `GET …/files` lists (`limit`); a larger limit is refused, never cut. */
export const WATCHED_FILES_LIMIT_MAX = 200;

/** A registered file's state (the register, Task W3). */
export type WatchedFileState = "in-library" | "changed" | "may-have-changed" | "gone" | "settled";

/** A folder's state: the engine's, or "not-set-up" when this computer has no folder for the watch. */
export type WatchFolderState = "watching" | "paused" | "unreachable" | "locked" | "not-set-up" | "stopped";

/** The cloud service a folder belongs to (the engine's CloudProvider). */
export type CloudProviderId = "google-drive" | "onedrive" | "dropbox" | "icloud-drive" | "other-cloud";

export interface WatchedFolderPlace {
  provider: CloudProviderId | null;
  providerName: string | null;
  /**
   * Google Drive, OneDrive and Dropbox: the service's name and the path below its folder ("Google
   * Drive/My Drive/Fieldwork"). Any other folder (iCloud Drive, another service below
   * ~/Library/CloudStorage, a plain folder): the absolute path the researcher chose (R96). Outside
   * text: shown only through UserText.
   */
  display: string;
}

export interface WatchedFolderCounts {
  cameIn: number;
  alreadyInLibrary: number;
  notDownloaded: number;
  notDownloadedBytes: number;
  waiting: number;
  didNotComeIn: number;
  changed: number;
  gone: number;
}

export interface WatchedFolderSummary {
  id: string;
  label?: string;
  recursive: boolean;
  collectionId?: string;
  collectionName?: string;
  /** Null when this computer has no folder for the watch ("not-set-up"). */
  place: WatchedFolderPlace | null;
  state: WatchFolderState;
  /** The engine's sentence (plain words, no path). */
  reason?: string;
  scanning: boolean;
  counts: WatchedFolderCounts;
  choices: { paused: boolean; notDownloaded: "leave" | "download" };
  downloadHeld?: { files: number; bytes: number };
}

export interface WatchedFoldersListResponse {
  folders: WatchedFolderSummary[];
}

/** `grantId`: from the shell's folder chooser (`pickWatchFolder`). A body with `dir` (or any path) is refused. */
export interface WatchedFolderAddRequest {
  grantId: string;
  label?: string;
  recursive?: boolean;
  collectionId?: string;
}

export interface WatchedFolderSetFolderRequest {
  grantId: string;
}

/**
 * `label` and `collectionId` (null clears) change project.json; `paused` and `notDownloaded` are this
 * computer's choices. `notDownloaded: "download"` needs `confirmBytes` equal to the folder's current
 * `counts.notDownloadedBytes`.
 */
export interface WatchedFolderPatchRequest {
  label?: string | null;
  collectionId?: string | null;
  paused?: boolean;
  notDownloaded?: "leave" | "download";
  confirmBytes?: number;
}

export interface WatchedFolderFileItem {
  /** Relative to the watched folder, "/"-separated, as on disk (outside text: UserText). */
  file: string;
  kind: WatchFileKind | "changed" | "gone";
  reason: string;
  bytes?: number;
  sourceId?: string;
}

export interface WatchedFolderFilesResponse {
  total: number;
  items: WatchedFolderFileItem[];
}

export interface WatchedSourceOrigin {
  watchId: string;
  /** The folder's label, else the name the service gives it (never an absolute path); "" once the folder is removed. */
  folderLabel: string;
  folderRemoved: boolean;
  file: string;
  state: WatchedFileState;
  newBytes?: number;
  /** The file's content was on this computer when the engine last judged it. */
  local: boolean;
}

export interface SourceWatchOriginResponse {
  origins: WatchedSourceOrigin[];
}

export interface WatchedFileActionRequest {
  watchId: string;
  action: "bring-in-new-version" | "keep-as-it-is";
}

/** What an act on a source's origin did: "already-there" is "bring in the new version" when the library already held that content (nothing was added). */
export const WATCHED_FILE_ACTION_DONE = ["attached", "settled", "already-there"] as const;

export interface WatchedFileActionResponse {
  done: (typeof WATCHED_FILE_ACTION_DONE)[number];
  sourceId: string;
}

/** The data of a `watch.status` event. */
export interface WatchStatusEvent {
  projectId: string;
  folder: WatchedFolderSummary;
}
