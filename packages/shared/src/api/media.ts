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
export interface MediaTicketRevokeResponse {
  /** False when it had already ended (or never existed). */
  revoked: boolean;
}
