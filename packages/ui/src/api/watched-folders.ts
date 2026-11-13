/**
 * Typed service calls for watched folders (Task W9: the two calls a source's screen makes; Task W8
 * adds the folder screen's). Addresses carry ids only. The shapes are the shared ones
 * (packages/shared/src/api/watched-folders.ts), declared once for the service and the interface.
 *
 *  - `GET  /projects/:id/sources/:sid/watch-origin`          → SourceWatchOriginResponse
 *  - `POST /projects/:id/sources/:sid/watch-origin/action`   WatchedFileActionRequest → WatchedFileActionResponse
 */
import type { SourceWatchOriginResponse, WatchedFileActionRequest, WatchedFileActionResponse } from "@ao/shared";
import type { ApiClient } from "./client";

export type { SourceWatchOriginResponse, WatchedFileActionRequest, WatchedFileActionResponse, WatchedSourceOrigin } from "@ao/shared";

export interface WatchedFoldersApi {
  /** Where the source came from (an empty list for a source from no watched folder). */
  sourceOrigin(projectId: string, sourceId: string, signal?: AbortSignal): Promise<SourceWatchOriginResponse>;
  /** The researcher's act on one origin: bring in the new version, or keep the library's copy. */
  actOnSourceOrigin(projectId: string, sourceId: string, req: WatchedFileActionRequest): Promise<WatchedFileActionResponse>;
}

const seg = (s: string) => encodeURIComponent(s);
const origin = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}/watch-origin`;

export function watchedFoldersApi(client: ApiClient): WatchedFoldersApi {
  const r = client.request;
  return {
    sourceOrigin: (pid, sid, signal) => r<SourceWatchOriginResponse>("GET", origin(pid, sid), signal ? { signal } : {}),
    actOnSourceOrigin: (pid, sid, body) => r<WatchedFileActionResponse>("POST", `${origin(pid, sid)}/action`, { body }),
  };
}
