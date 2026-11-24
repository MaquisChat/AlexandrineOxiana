/**
 * Verification, recheck, pictures and background-work retries for the source screen (Task 34d, R113:
 * its own module on createClient's request()). Shapes mirror apps/library-service/src/routes/
 * sources.ts (`PATCH …/fields`, `POST …/recheck`, `POST /projects/:id/recheck`, the picture route
 * `GET …/assets/:aid/content`) and routes/jobs.ts (`POST /jobs/retry`); the source record's
 * `fields` are the shared `FieldReview` (packages/shared/src/api/sources.ts).
 */
import {
  PICTURE_MAX_BYTES,
  type FieldConfirmRequest,
  type FieldReview,
  type JobsRetryRequest,
  type JobsRetryResponse,
  type ProjectRecheckResponse,
  type ProjectRecheckState,
  type RecheckProgressEvent,
  type SourceRecordExtras,
  type VerificationStatus,
} from "@ao/shared";
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
export type RecheckJob = ProjectRecheckResponse;

/** The `job.progress` event of a project recheck (@ao/shared). */
export type RecheckProgress = RecheckProgressEvent;

/** Raster pictures the service serves and a browser can show (never SVG: it is a document, R135 1). */
const SHOWABLE_PICTURES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/apng"]);
export const isShowablePicture = (mime: string | undefined): boolean => !!mime && SHOWABLE_PICTURES.has(mime.toLowerCase().split(";")[0]!.trim());

const seg = (s: string) => encodeURIComponent(s);
const src = (pid: string, sid: string) => `/projects/${seg(pid)}/sources/${seg(sid)}`;

export function verificationApi(client: ApiClient) {
  const r = client.request;
  return {
    /** The researcher's value for one field (recorded as their evidence: "confirmed by you" when it agrees). */
    confirmField: (pid: string, sid: string, field: string, value: unknown) => {
      const body: FieldConfirmRequest = { field, value };
      return r<VerifiedSource>("PATCH", `${src(pid, sid)}/fields`, { body });
    },
    recheckSource: (pid: string, sid: string) => r<VerifiedSource>("POST", `${src(pid, sid)}/recheck`),
    recheckProject: (pid: string) => r<RecheckJob>("POST", `/projects/${seg(pid)}/recheck`),
    /** The project's recheck running now, if any (FR-717): asked when the library screen shows the project. */
    recheckState: (pid: string) => r<ProjectRecheckState>("GET", `/projects/${seg(pid)}/recheck`),
    /** Runs a source's failed viewing-proxy and OCR jobs again (R84). */
    retryJobs: (pid: string, sid: string) => {
      const body: JobsRetryRequest = { projectId: pid, sourceId: sid };
      return r<JobsRetryResponse>("POST", "/jobs/retry", { body });
    },
    /** A stored picture, read with the token and returned as a Blob for a blob: URL (R135 1). */
    picture: async (pid: string, sid: string, aid: string, opts: { signal?: AbortSignal } = {}): Promise<Blob> => {
      // The service refuses a picture larger than this too; the client stops reading past it (R135 1).
      const blob = await client.bytes(`${src(pid, sid)}/assets/${seg(aid)}/content`, { maxBytes: PICTURE_MAX_BYTES, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!isShowablePicture(blob.type)) throw new ApiClientError(200, { code: "VALIDATION", message: "The library service did not send a picture." });
      return blob;
    },
  };
}

export type VerificationApi = ReturnType<typeof verificationApi>;
