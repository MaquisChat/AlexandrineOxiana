/**
 * Verification, recheck, pictures and background-work retries for the source screen (Task 34d, R113:
 * its own module on createClient's request()). Shapes mirror apps/library-service/src/routes/
 * sources.ts (`PATCH …/fields`, `POST …/recheck`, `POST /projects/:id/recheck`, the picture route
 * `GET …/assets/:aid/content`) and routes/jobs.ts (`POST /jobs/retry`); the source record's
 * `fields` are the shared `FieldReview` (packages/shared/src/api/sources.ts).
 */
import type { FieldReview, SourceRecordExtras, VerificationStatus } from "@ao/shared";
import { ApiClientError, type ApiClient } from "./client";
import type { SourceFile } from "./library";

export type { FieldReview, VerificationStatus };

/** A viewing-proxy or OCR job kept in the source record until it is done (R31); `failed` after its retries (R84). */
export interface PendingJob {
  id: string;
  /** "image.proxy" | "video.proxy" for proxies; absent for OCR. */
  type?: string;
  assetId: string;
  queuedAt: string;
  failed?: { code: string; at: string; attempts?: number };
}

/** A source record as the service sends it: the stored record plus each field's review (Task 34a d). */
export type VerifiedSource = SourceFile &
  SourceRecordExtras & {
    pendingProxies?: PendingJob[];
    pendingOcr?: PendingJob[];
  };

/** `POST /projects/:id/recheck`: the job runs in the background; `job.progress` events (kind "recheck") report it (R99). */
export interface RecheckJob {
  jobId: string;
  total: number;
}

/** The `job.progress` event of a project recheck (routes/sources.ts). */
export interface RecheckProgress {
  kind: "recheck";
  jobId: string;
  projectId: string;
  done: number;
  total: number;
  finished: boolean;
  changed?: number;
  failed?: number;
}

/** Raster pictures the service serves and a browser can show (never SVG: it is a document, R135 1). */
const SHOWABLE_PICTURES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/apng"]);
export const isShowablePicture = (mime: string | undefined): boolean => !!mime && SHOWABLE_PICTURES.has(mime.toLowerCase().split(";")[0]!.trim());

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

export function verificationApi(client: ApiClient) {
  const r = client.request;
  return {
    /** The researcher's value for one field (recorded as their evidence: "confirmed by you" when it agrees). */
    confirmField: (pid: string, sid: string, field: string, value: unknown) => r<VerifiedSource>("PATCH", `${src(pid, sid)}/fields`, { body: { field, value } }),
    recheckSource: (pid: string, sid: string) => r<VerifiedSource>("POST", `${src(pid, sid)}/recheck`),
    recheckProject: (pid: string) => r<RecheckJob>("POST", `/projects/${seg(pid)}/recheck`),
    /** Runs a source's failed viewing-proxy and OCR jobs again (R84). */
    retryJobs: (pid: string, sid: string) => r<{ retrying: true }>("POST", "/jobs/retry", { body: { projectId: pid, sourceId: sid } }),
    /** A stored picture, read with the token and returned as a Blob for a blob: URL (R135 1). */
    picture: async (pid: string, sid: string, aid: string, opts: { signal?: AbortSignal } = {}): Promise<Blob> => {
      const blob = await client.blob(`${src(pid, sid)}/assets/${seg(aid)}/content`, opts);
      if (!isShowablePicture(blob.type)) throw new ApiClientError(200, { code: "VALIDATION", message: "The library service did not send a picture." });
      return blob;
    },
  };
}

export type VerificationApi = ReturnType<typeof verificationApi>;
