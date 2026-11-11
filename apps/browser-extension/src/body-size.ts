/**
 * Keeping POST /capture/browser within the service's 32 MB body limit, measured in UTF-8 bytes
 * (R112): drop the HTML snapshot first, then the extracted media links, and if the screenshot and
 * fields alone are still too big, refuse here with a clear message instead of sending it.
 */
import type { BrowserCaptureBody } from "./types.js";

/** The service's limit (32 MB) less a margin for anything the transport adds. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024 - 64 * 1024;

export class CaptureTooLargeError extends Error {
  constructor() {
    super("This capture is too large to send to the desktop app, even without the page's HTML. Try a shorter page or zoom out.");
    this.name = "CaptureTooLargeError";
  }
}

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function fitCaptureBody(body: BrowserCaptureBody, limit: number = MAX_BODY_BYTES): { body: BrowserCaptureBody; notes: string[] } {
  if (utf8Bytes(body) <= limit) return { body, notes: [] };
  const notes: string[] = [];
  let next: BrowserCaptureBody = body;
  if (next.html !== undefined) {
    const { html: _html, ...rest } = next;
    next = rest;
    notes.push("The page's HTML was left out to keep the capture within the desktop app's size limit.");
    if (utf8Bytes(next) <= limit) return { body: next, notes };
  }
  if (next.extracted.mediaUrls.length) {
    next = { ...next, extracted: { ...next.extracted, mediaUrls: [] } };
    notes.push("The page's media links were left out for the same reason.");
    if (utf8Bytes(next) <= limit) return { body: next, notes };
  }
  throw new CaptureTooLargeError();
}
