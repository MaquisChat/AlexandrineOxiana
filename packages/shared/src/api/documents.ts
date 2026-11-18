/**
 * A stored PDF's bytes for the reader (Task R5; R96, R135, R140, R192 d).
 *
 * `GET /projects/:id/sources/:sid/assets/:aid/document` with the UI token in the Authorization
 * header (never a media ticket, never anything in the address but ids) and exactly one byte range
 * (`Range: bytes=a-b`, `bytes=a-` or `bytes=-n`). The answer is 206 with
 * `Content-Range: bytes a-b/total` and `Content-Type: application/pdf`; the range is cut to
 * DOCUMENT_RANGE_MAX_BYTES (the `Content-Range` says where it ends). An encrypted project's file is
 * decrypted by the service for exactly that range. Reading changes nothing and audits nothing.
 *
 * Refusals: no `Range`, several ranges, another unit, a malformed one, or an `If-Range` → 400
 * VALIDATION "Ask for a byte range."; a range starting past the end → 416 with
 * `Content-Range: bytes * /total` (no space); an asset not recorded as `application/pdf` → 400 "This
 * file cannot be shown here."; a destroyed file, or a linked file that is gone or moved → 404 "The
 * file of this source is not where it was recorded."; a file over READER_PDF_MAX_BYTES (decided from
 * the recorded size, before the file is opened) → 413 PAYLOAD_TOO_LARGE "This PDF is larger than
 * 512 MB, too large to open in the app."; a locked project → 423 PROJECT_LOCKED.
 */

/** The most bytes one answer of the document route carries (4 MiB); a longer range is cut to it. */
export const DOCUMENT_RANGE_MAX_BYTES = 4194304;

/** The largest PDF the reader opens (512 MiB, R192 d): pdf.js allocates the whole length in its worker. */
export const READER_PDF_MAX_BYTES = 536870912;

/**
 * The one rule for a PDF the reader can open (R222): an original file, not destroyed, recorded as
 * `application/pdf` (the document route serves only those). The service computes a list row's
 * `hasReadablePdf` with it and the interface's "Read the PDF" and the reader's file choice use it.
 */
export const isReadablePdfAsset = (a: { role: string; mime?: string | undefined; status?: unknown }): boolean => a.role === "original" && a.status !== "destroyed" && a.mime === "application/pdf";
