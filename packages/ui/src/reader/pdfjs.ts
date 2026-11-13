/**
 * The one place pdf.js is loaded and configured (Task R6; R192).
 *
 * The legacy build (`pdfjs-dist/legacy/build/pdf.mjs`), so that the macOS 15 WebKit the app runs in
 * is covered, with its minified module worker, which Vite copies into the build (`?url`) and the page
 * starts from its own origin (worker-src falls back to script-src 'self').
 *
 * Every document is opened with PDF_OPTIONS and nothing else that could reach outward:
 *  - no eval (`isEvalSupported: false`; pdf.js 6.4.299 has no eval path left, the option is kept as
 *    the plan lists it), no XFA forms, no WebAssembly (`useWasm: false`: the image decoders'
 *    JavaScript fallbacks are imported from /pdfjs/wasm/ under script-src 'self');
 *  - `useWorkerFetch: false`: the page, not the worker, fetches the bundled character maps and
 *    standard fonts from the app's own files (/pdfjs/…), the one reason connect-src has 'self';
 *  - the document's bytes only through the range transport (rangeTransport.ts) over the service's
 *    ranged route, 1 MiB at a time, only what is needed (`disableAutoFetch`, `disableStream`):
 *    never a URL pdf.js fetches itself, never the token in a URL.
 * pdf.js's annotation layer (links, forms), its editor and XFA layers and its scripting sandbox are
 * never imported or rendered anywhere in the interface (pdfjs.test.ts checks the whole source).
 */
import { getDocument, GlobalWorkerOptions, InvalidPDFException, PasswordException, PasswordResponses, type PDFDataRangeTransport, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { ApiClientError } from "../api/client";
import { onRangeFailure } from "./rangeTransport";

// The worker, from the app's own files. (Under Node, in tests, pdf.js runs its worker code on the
// main thread instead.)
GlobalWorkerOptions.workerSrc = workerUrl;

/** The pdf.js options every document is opened with (the plan's Global Constraints), exactly. */
export const PDF_OPTIONS = Object.freeze({
  isEvalSupported: false,
  enableXfa: false,
  useWasm: false,
  useWorkerFetch: false,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 1048576,
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
} as const);

type DocumentParams = NonNullable<Parameters<typeof getDocument>[0]> & typeof PDF_OPTIONS & { range: PDFDataRangeTransport };

/** What getDocument is given: PDF_OPTIONS, the transport, and the password only when there is one. */
export function pdfDocumentParams(transport: PDFDataRangeTransport, password?: string): DocumentParams {
  return { ...PDF_OPTIONS, range: transport, ...(password !== undefined ? { password } : {}) };
}

export type PdfOpenErrorKind = "password-needed" | "password-wrong" | "damaged" | "too-large" | "missing" | "locked" | "other";

const MESSAGES: Record<PdfOpenErrorKind, string> = {
  "password-needed": "This PDF is protected by a password. Enter it to read it here.",
  "password-wrong": "That password did not open this PDF.",
  damaged: "This PDF is damaged and cannot be shown. The file itself has not been changed.",
  "too-large": "This PDF is larger than 512 MB, too large to open in the app.",
  missing: "The file of this source is not where it was recorded, so it cannot be shown.",
  locked: "This project is locked. Unlock it in the library to read its files.",
  other: "This PDF could not be opened.",
};

/** Why a document did not open, as one of the kinds the reader shows; the message is plain words. */
export class PdfOpenError extends Error {
  override name = "PdfOpenError";
  constructor(readonly kind: PdfOpenErrorKind) {
    super(MESSAGES[kind]);
  }
}

/**
 * The kind of a failure to open: pdf.js's password and invalid-file exceptions, and the service's
 * refusals of a range (413 too large, 404 missing, 423 locked); anything else is "other".
 */
export function toPdfOpenError(err: unknown): PdfOpenError {
  if (err instanceof PdfOpenError) return err;
  if (err instanceof ApiClientError) {
    if (err.status === 413) return new PdfOpenError("too-large");
    if (err.status === 404) return new PdfOpenError("missing");
    if (err.status === 423) return new PdfOpenError("locked");
    return new PdfOpenError("other");
  }
  const name = err instanceof Error ? err.name : undefined;
  if (err instanceof PasswordException || name === "PasswordException") {
    const code = (err as { code?: unknown }).code;
    return new PdfOpenError(code === PasswordResponses.INCORRECT_PASSWORD ? "password-wrong" : "password-needed");
  }
  if (err instanceof InvalidPDFException || name === "InvalidPDFException") return new PdfOpenError("damaged");
  return new PdfOpenError("other");
}

/** An open document. `destroy()` ends it: the worker's copy of the bytes and every range still wanted. */
export interface PdfHandle {
  doc: PDFDocumentProxy;
  pageCount: number;
  /** The printed page labels ("vii", "12"…), one per page, or null when the file has none. */
  pageLabels: string[] | null;
  destroy(): Promise<void>;
}

const aborted = (signal: AbortSignal): Error => (signal.reason instanceof Error && signal.reason.name === "AbortError" ? signal.reason : new DOMException("The document is no longer wanted.", "AbortError"));

/**
 * Opens the document `transport` reads. Rejects with a PdfOpenError (its kind says why), or with an
 * AbortError once `signal` aborts (the document is then destroyed). A range refused while opening
 * (the project locked meanwhile, the file gone) ends the opening at once with that refusal's kind.
 * The password is given to pdf.js in memory only.
 */
export async function openPdf(opts: { transport: PDFDataRangeTransport; password?: string; signal: AbortSignal }): Promise<PdfHandle> {
  const { transport, password, signal } = opts;
  if (signal.aborted) throw aborted(signal);
  const task = getDocument(pdfDocumentParams(transport, password));
  const destroy = () => task.destroy();
  // pdf.js never hears that a range failed, and a loading task destroyed half-way may never settle:
  // an abort or a refused range ends the opening by itself.
  let stop: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = reject;
  });
  stopped.catch(() => {});
  const onAbort = () => stop(aborted(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  const stopListening = onRangeFailure(transport, (error) => stop(toPdfOpenError(error)));
  try {
    const doc = await Promise.race([task.promise, stopped]);
    const pageLabels = await Promise.race([doc.getPageLabels(), stopped]);
    if (signal.aborted) throw aborted(signal);
    return { doc, pageCount: doc.numPages, pageLabels, destroy };
  } catch (err) {
    // Destroyed in the background: its end is not waited for (it may wait on a range that never comes).
    destroy().catch(() => {});
    if (signal.aborted) throw aborted(signal);
    throw toPdfOpenError(err);
  } finally {
    signal.removeEventListener("abort", onAbort);
    stopListening();
  }
}
