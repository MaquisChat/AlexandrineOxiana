/**
 * Link-capture errors and the plain-language reasons shown to the researcher. Reasons are fixed
 * sentences: they never carry cookies, tokens, URLs or file paths from the tools' output.
 */

import { COOKIES_ACKNOWLEDGEMENT } from "@ao/core";

/** The one-time explanation (spec 5.1): defined once in @ao/core for the library and the interface (R146). */
export { COOKIES_ACKNOWLEDGEMENT };

/**
 * Capturing with the browser session needs the researcher's one-time acknowledgement, recorded in
 * the project (`repo.acknowledge(projectId, kind)`). Nothing was downloaded.
 */
export class AcknowledgementRequiredError extends Error {
  override name = "AcknowledgementRequiredError";
  readonly explanation: string;
  constructor(
    readonly projectId: string,
    readonly kind: "cookies" = "cookies",
  ) {
    super(COOKIES_ACKNOWLEDGEMENT);
    this.explanation = COOKIES_ACKNOWLEDGEMENT;
  }
}

const REASONS: Record<string, string> = {
  LOGIN_REQUIRED: "This post needs a signed-in session. Try again with 'Use my browser session'.",
  PRIVATE: "This post is private. It can only be saved through a signed-in session that is allowed to see it.",
  RATE_LIMITED: "The platform is limiting requests right now. Wait a while, then try again.",
  NOT_FOUND_OR_REMOVED: "This post could not be found. It may have been removed, or the link may be wrong.",
  GEO_BLOCKED: "This post is not available in your country or region.",
  EXTRACTOR_ERROR: "The downloader could not read this page. The platform may have changed; updating the capture tools may help.",
  WORKER_UNAVAILABLE: "The media helper is not running, so nothing was downloaded. Restart the app and try again.",
  UNSUPPORTED_URL: "This link is not a YouTube, Instagram or TikTok post, so the downloader cannot capture it.",
  PROFILE_CAPTURE_UNAVAILABLE: "Whole profiles, channels and playlists are captured with the profile archive, which is not available here.",
  NOTHING_SAVED: "The downloader finished but saved no media or platform data for this link.",
  CANCELLED: "The capture was cancelled. Nothing was saved.",
  NO_MEDIA: "The post's details were saved, but no media file came back from the platform.",
  LEGAL_BASIS_REQUIRED: "Record a legal basis for this project's social-media data, then try again.",
  INTERRUPTED: "The capture was interrupted before it finished. Capture the link again.",
  POLICY_CHANGED: "This project's rules changed during the download, so nothing was saved.",
  POLICY_CHANGED_RUN: "This project's rules changed during the capture. Posts saved before the change are kept; nothing else was saved.",
  RATE_LIMITED_PAUSED: "The platform is limiting requests, so the profile capture was paused. Run it again later; it continues where it stopped.",
  INVALID_OPTIONS: "Some profile capture options are not valid. Check the dates (YYYY-MM-DD) and the maximum number of items.",
};
const FALLBACK = "Something went wrong while saving this link. Nothing was saved.";

/** The fixed plain-language sentence for an error code (a generic one for unknown codes). */
export function plainReason(code: string): string {
  return REASONS[code] ?? FALLBACK;
}

/** The availability reason of a source whose capture stopped part-way. */
export function incompleteReason(code: string): string {
  const why = REASONS[code];
  return why ? `Only part of this post was saved. ${why}` : "Only part of this post was saved.";
}
