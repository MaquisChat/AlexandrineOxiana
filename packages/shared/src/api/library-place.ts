/**
 * R447 (Task FR-A23): what "Choose a library" asks the service before a library is open — a suggested folder for a
 * new library, and the free room on the disk under a folder. For the desktop app's screens only.
 */

/** `GET /libraries/suggested-folder`: the folder to offer, absent when there is none to offer. */
export interface LibrarySuggestedFolderResponse {
  folder?: string;
}

/** `POST /libraries/folder-room`: a full local path, in the body (never in the address). */
export interface LibraryFolderRoomRequest {
  path: string;
}

/** Its answer: the free bytes of the disk under the folder (or the nearest existing folder above it), absent when they cannot be told. */
export interface LibraryFolderRoomResponse {
  freeBytes?: number;
}
