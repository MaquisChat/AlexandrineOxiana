/**
 * Pictures and audio/video from the service (Task 34a, R135).
 *
 * Pictures: `GET /projects/:id/sources/:sid/assets/:aid/content` with the UI token; the body is the
 * picture itself (raster types only, at most PICTURE_MAX_BYTES), shown by the UI as a blob URL.
 *
 * Audio and video: `POST /projects/:id/sources/:sid/assets/:aid/media-ticket` with the UI token
 * gives a ticket address `/media/<ticket>` (no query string, ever) that a media element loads with
 * GET/HEAD range requests. The ticket is a secret (R135 5): never shown, logged, stored or put in
 * the page address; `POST /media-tickets/revoke` ends it when the player closes.
 */

/** The address form of a ticket: `/media/` and 43 base64url characters (256 random bits). */
export const MEDIA_TICKET_PATH = /^\/media\/[A-Za-z0-9_-]{43}$/;

export function isMediaTicketPath(path: string): boolean {
  return MEDIA_TICKET_PATH.test(path);
}

/** Largest picture the content route serves (a full-page screenshot of a very long page fits). */
export const PICTURE_MAX_BYTES = 48 * 1024 * 1024;

/** Tickets live at once (R135 2); one more is refused (429 RATE_LIMITED) until one ends. */
export const MEDIA_TICKETS_MAX = 16;
/** A ticket not used for this long ends (R135 2). */
export const MEDIA_TICKET_IDLE_MS = 10 * 60_000;
/** A ticket ends this long after it was issued, used or not (R135 2). */
export const MEDIA_TICKET_LIFETIME_MS = 8 * 60 * 60_000;

/** `POST /projects/:id/sources/:sid/assets/:aid/media-ticket` (no body). */
export interface MediaTicketResponse {
  /** `/media/<ticket>`: resolve against the service's base URL, nothing else added. */
  path: string;
  /** The asset's recorded type (audio/* or video/*). */
  mime: string;
  /** Plaintext size in bytes. */
  size: number;
  /** When the ticket ends if it is not used before then (moves on with every use). */
  idleExpiresAt: string;
  /** When the ticket ends whatever happens. */
  expiresAt: string;
}

/** `POST /media-tickets/revoke`. */
export interface MediaTicketRevokeRequest {
  path: string;
}
/**
 * Why a ticket's stream stopped, when the service found the stored file not as the app stored it
 * (its header or a chunk fails its check: changed outside the app, or damaged) (FR-217, FR-219, R467 M1).
 * A code, never a sentence: the player says it in its own words.
 */
export const MEDIA_FILE_CHANGED = "FILE_CHANGED";
/**
 * Why a ticket's stream stopped, when the app itself destroyed the recording's raw data (under the
 * retention rule) while it played: not a change outside the app (R467 M3). A code, never a sentence.
 */
export const MEDIA_FILE_DESTROYED = "FILE_DESTROYED";

export interface MediaTicketRevokeResponse {
  /** False when it had already ended (or never existed). */
  revoked: boolean;
  /** Set when a read for this ticket found the stored file changed, or the app destroyed it. */
  ended?: typeof MEDIA_FILE_CHANGED | typeof MEDIA_FILE_DESTROYED;
}

// Refusals a ticket request names: another token than the UI's (403), a locked project (423), too
// many tickets live (429 RATE_LIMITED).
