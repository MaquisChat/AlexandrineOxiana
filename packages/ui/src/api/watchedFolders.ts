/**
 * Watched folders (Task W8, R207): typed methods for W7's routes
 * (apps/library-service/src/routes/watched-folders.ts), with the shapes declared once in @ao/shared.
 * No request carries a folder path: a folder is named only by the grant id the shell's folder
 * chooser gave (`pickWatchFolder`), and a grant is sent once (R233 d: any request that names it
 * spends it, a refused one too). Bodies hold only the keys the handler accepts (it refuses others).
 */
import type {
  SourceWatchOriginResponse,
  WatchedFileActionRequest,
  WatchedFileActionResponse,
  WatchedFileListKind,
  WatchedFolderAddRequest,
  WatchedFolderFilesResponse,
  WatchedFolderPatchRequest,
  WatchedFolderSummary,
  WatchedFoldersListResponse,
  WatchStatusEvent,
} from "@ao/shared";
import { PATHS } from "../navigation";
import type { ApiClient, ServiceEvent } from "./client";

const seg = (s: string) => encodeURIComponent(s);
const folders = (pid: string) => `/projects/${seg(pid)}/watched-folders`;
const folderPath = (pid: string, wid: string) => `${folders(pid)}/${seg(wid)}`;
const originPath = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}/watch-origin`;

/** The screen's address for a project. */
export const watchedFoldersHref = (projectId: string): string => `${PATHS.watchedFolders}?project=${encodeURIComponent(projectId)}`;

export function watchedFoldersApi(client: ApiClient) {
  const r = client.request;
  return {
    /** GET /projects/:id/watched-folders. */
    list: (pid: string, opts: { signal?: AbortSignal } = {}) => r<WatchedFoldersListResponse>("GET", folders(pid), opts.signal ? { signal: opts.signal } : {}),
    /** POST /projects/:id/watched-folders → 201 with the folder's summary. */
    add: (pid: string, body: WatchedFolderAddRequest) => r<WatchedFolderSummary>("POST", folders(pid), { body }),
    /** PUT /projects/:id/watched-folders/:wid/folder: this computer's folder for the watch, by grant. */
    setFolder: (pid: string, wid: string, grantId: string) => r<WatchedFolderSummary>("PUT", `${folderPath(pid, wid)}/folder`, { body: { grantId } }),
    /** PATCH /projects/:id/watched-folders/:wid: label, collection (governed) and this computer's choices. */
    patch: (pid: string, wid: string, body: WatchedFolderPatchRequest) => r<WatchedFolderSummary>("PATCH", folderPath(pid, wid), { body }),
    /** POST /projects/:id/watched-folders/:wid/retry (no body): can take a few seconds. */
    retry: (pid: string, wid: string) => r<WatchedFolderSummary>("POST", `${folderPath(pid, wid)}/retry`),
    /** DELETE /projects/:id/watched-folders/:wid: the sources stay. */
    remove: (pid: string, wid: string) => r<{ removed: true }>("DELETE", folderPath(pid, wid)),
    /** GET /projects/:id/watched-folders/:wid/files?kind=&offset=&limit= (limit at most 200). */
    files: (pid: string, wid: string, q: { kind?: WatchedFileListKind; offset: number; limit: number }, opts: { signal?: AbortSignal } = {}) =>
      r<WatchedFolderFilesResponse>("GET", `${folderPath(pid, wid)}/files`, { query: { kind: q.kind, offset: q.offset, limit: q.limit }, ...(opts.signal ? { signal: opts.signal } : {}) }),
    /** GET /projects/:id/sources/:sid/watch-origin (Task W9). */
    origin: (pid: string, sid: string) => r<SourceWatchOriginResponse>("GET", originPath(pid, sid)),
    /** POST /projects/:id/sources/:sid/watch-origin/action (Task W9). */
    act: (pid: string, sid: string, body: WatchedFileActionRequest) => r<WatchedFileActionResponse>("POST", `${originPath(pid, sid)}/action`, { body }),
  };
}

export type WatchedFoldersApi = ReturnType<typeof watchedFoldersApi>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `watch.status` event of this project, or null (another type, another project, or a shape that is not a summary). */
export function watchStatusOf(ev: ServiceEvent, projectId: string): WatchStatusEvent | null {
  if (ev.type !== "watch.status" || !isObj(ev.data)) return null;
  const { projectId: pid, folder } = ev.data;
  if (pid !== projectId || !isObj(folder)) return null;
  if (typeof folder.id !== "string" || typeof folder.seq !== "number" || typeof folder.state !== "string" || !isObj(folder.counts) || !isObj(folder.choices)) return null;
  return { projectId: pid, folder: folder as unknown as WatchedFolderSummary };
}
