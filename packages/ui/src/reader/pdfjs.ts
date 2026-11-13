/**
 * The one place pdf.js is loaded and configured (Task R6; R192, R199, R200, A6).
 *
 * The legacy build (`pdfjs-dist/legacy/build/pdf.mjs`), so that the macOS 15 WebKit the app runs in
 * is covered, with its minified module worker, which Vite copies into the build (`?url`).
 *
 * The worker is created HERE, one per document: `new Worker(<bundled worker url>, { type: "module" })`
 * from the app's own origin (worker-src falls back to script-src 'self'), handed to pdf.js as a port.
 * pdf.js is never left to make it: at `tauri://localhost` the page's origin reads as "null", for
 * which pdf.js would wrap its worker in a `blob:` address, which the policy rightly refuses, and then
 * silently parse on the page's own thread (its "fake worker"). Here a worker that cannot start is an
 * error in plain words; there is no fall-back.
 *
 * Every document is opened with PDF_OPTIONS and nothing else that could reach outward:
 *  - no eval (`isEvalSupported: false`; pdf.js 6.4.299 has no eval path left, the option is kept as
 *    the plan lists it), no XFA forms, no WebAssembly (`useWasm: false`: the image decoders'
 *    JavaScript fallbacks are imported from /pdfjs/wasm/ under script-src 'self');
 *  - `useWorkerFetch: false`: the page, not the worker, fetches the bundled character maps and the
 *    Symbol and ZapfDingbats fonts from the app's own files (/pdfjs/…), the one reason connect-src
 *    has 'self';
 *  - `useSystemFonts: true` (R199): a PDF's non-embedded Helvetica, Times or Courier is drawn with the
 *    system's own face (a generic one where the system has none); no GPL font is shipped;
 *  - image limits (A6): `maxImageSize` 2^26 pixels (8192 × 8192): a 600 dpi scan of an A4 or Letter
 *    page is about 35 million pixels and is drawn; one image that declares more is not drawn at all,
 *    decided from its declared size before it is decoded, so a hostile file cannot make pdf.js
 *    allocate gigabytes. `canvasMaxAreaInBytes` 2^27 bytes (128 MiB, about 33 million pixels): an
 *    image drawn larger than that is scaled down in the worker before it reaches the page (a 600 dpi
 *    A4 scan stays sharp at the reader's 400% zoom), so the page never holds a bigger bitmap.
 *    (pdf.js reads it with `>> 2`, so it must stay below 2^31.)
 *  - the document's bytes only through the range transport (rangeTransport.ts) over the service's
 *    ranged route, 1 MiB at a time, only what is needed (`disableAutoFetch`, `disableStream`):
 *    never a URL pdf.js fetches itself, never the token in a URL.
 * pdf.js's annotation layer (links, forms), its editor and XFA layers and its scripting sandbox are
 * never imported or rendered anywhere in the interface (pdfjs.test.ts checks the whole source).
 */
import { READER_PDF_MAX_BYTES } from "@ao/shared";
import { getDocument, InvalidPDFException, PasswordException, PasswordResponses, PDFWorker, type PDFDataRangeTransport, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { ApiClientError } from "../api/client";
import { onRangeFailure } from "./rangeTransport";

/** The pdf.js options every document is opened with (the plan's Global Constraints and A6), exactly. */
export const PDF_OPTIONS = Object.freeze({
  isEvalSupported: false,
  enableXfa: false,
  useWasm: false,
  useWorkerFetch: false,
  useSystemFonts: true,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 1048576,
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  maxImageSize: 67108864,
  canvasMaxAreaInBytes: 134217728,
} as const);

type DocumentParams = NonNullable<Parameters<typeof getDocument>[0]> & typeof PDF_OPTIONS & { range: PDFDataRangeTransport };

/** What getDocument is given (besides the worker): PDF_OPTIONS, the transport, and the password only when there is one. */
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
const WORKER_FAILED = "The PDF reader could not start. Close the reader and open the file again.";
const FILE_CHANGED = "The file changed while it was being read. Open it again to read it as it is now.";

/** Why a document did not open or stopped being readable, as one of the kinds the reader shows; the message is plain words. */
export class PdfOpenError extends Error {
  override name = "PdfOpenError";
  constructor(
    readonly kind: PdfOpenErrorKind,
    message?: string,
  ) {
    super(message ?? MESSAGES[kind]);
  }
}

/**
 * The kind of a failure: pdf.js's password and invalid-file exceptions, and the service's refusals
 * of a range (413 too large, 404 missing, 423 locked); a file that changed while it was read is
 * "other" with its own sentence; anything else (a 400 for a file that is not a PDF, a 416, the
 * service out of reach) is "other".
 */
export function toPdfOpenError(err: unknown): PdfOpenError {
  if (err instanceof PdfOpenError) return err;
  if (err instanceof ApiClientError) {
    if (err.status === 413) return new PdfOpenError("too-large");
    if (err.status === 404) return new PdfOpenError("missing");
    if (err.status === 423) return new PdfOpenError("locked");
    // An asset that is not a PDF: the service's own sentence. A range past the end: the file shrank.
    if (err.status === 400 && err.message === "This file cannot be shown here.") return new PdfOpenError("other", err.message);
    if (err.status === 416) return new PdfOpenError("other", FILE_CHANGED);
    return new PdfOpenError("other");
  }
  const name = err instanceof Error ? err.name : undefined;
  if (name === "FileChangedError") return new PdfOpenError("other", FILE_CHANGED);
  if (err instanceof PasswordException || name === "PasswordException") {
    const code = (err as { code?: unknown }).code;
    return new PdfOpenError(code === PasswordResponses.INCORRECT_PASSWORD ? "password-wrong" : "password-needed");
  }
  if (err instanceof InvalidPDFException || name === "InvalidPDFException") return new PdfOpenError("damaged");
  return new PdfOpenError("other");
}

/** An open document. `destroy()` ends it: the worker (and its copy of the bytes) and every range still wanted. */
export interface PdfHandle {
  doc: PDFDocumentProxy;
  pageCount: number;
  /** The printed page labels ("vii", "12"…), one per page, or null when the file has none. */
  pageLabels: string[] | null;
  /**
   * Settles with the reason once the document can no longer be read: a range refused or failed after
   * it was opened (the project locked, the file gone or changed, the service out of reach), or the
   * worker stopped. From then on no range is asked for, and no page read waits: what pdf.js still
   * needs is answered with blank bytes (never from the file), so reads finish blank or with an
   * error. The reader shows the sentence and calls `destroy()`. Never settles after `destroy()`, or
   * for an abort.
   */
  failed: Promise<PdfOpenError>;
  destroy(): Promise<void>;
}

const aborted = (signal: AbortSignal): Error => (signal.reason instanceof Error && signal.reason.name === "AbortError" ? signal.reason : new DOMException("The document is no longer wanted.", "AbortError"));

/** Starts the bundled worker and waits for it to say it is ready; an error (not loaded, refused) is a PdfOpenError. */
function startWorker(signal: AbortSignal): Promise<Worker> {
  if (typeof Worker !== "function") return Promise.reject(new PdfOpenError("other", WORKER_FAILED));
  const worker = new Worker(workerUrl, { type: "module" });
  return new Promise<Worker>((resolve, reject) => {
    const stop = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { action?: unknown } | null)?.action !== "ready") return;
      stop();
      resolve(worker);
    };
    const onError = () => {
      stop();
      worker.terminate();
      reject(new PdfOpenError("other", WORKER_FAILED));
    };
    const onAbort = () => {
      stop();
      worker.terminate();
      reject(aborted(signal));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long destroying waits for pdf.js to end the document before the worker is ended regardless. */
const DESTROY_WAIT_MS = 2000;


/**
 * Opens the document `transport` reads. Rejects with a PdfOpenError (its kind says why), or with an
 * AbortError once `signal` aborts (everything is then ended). A range refused while opening (the
 * project locked meanwhile, the file gone) ends the opening at once with that refusal's kind; after
 * opening, the handle's `failed` says so. The password is given to pdf.js in memory only.
 */
export async function openPdf(opts: { transport: PDFDataRangeTransport; password?: string; signal: AbortSignal }): Promise<PdfHandle> {
  const { transport, password, signal } = opts;
  if (signal.aborted) throw aborted(signal);
  // pdf.js allocates the whole length in its worker: refused here too, before anything starts.
  if (transport.length > READER_PDF_MAX_BYTES) throw new PdfOpenError("too-large");
  const worker = await startWorker(signal);
  // pdf.js declares `port` as null only, though it takes a Worker there (its documented use).
  const pdfWorker = new PDFWorker({ port: worker } as unknown as ConstructorParameters<typeof PDFWorker>[0]);
  const task = getDocument({ ...pdfDocumentParams(transport, password), worker: pdfWorker });

  let ending: Promise<void> | undefined;
  // pdf.js does not end a worker it was handed: ended here, after pdf.js has had its chance to end
  // the document (which settles the page reads still waiting), but never later than DESTROY_WAIT_MS.
  const destroy = (): Promise<void> =>
    (ending ??= (async () => {
      transport.abort();
      await Promise.race([task.destroy().catch(() => {}), new Promise((r) => setTimeout(r, DESTROY_WAIT_MS))]);
      pdfWorker.destroy();
      worker.terminate();
    })());

  // pdf.js never hears that a range failed, and a loading task destroyed half-way may never settle:
  // an abort, a refused range or a worker error ends the opening by itself.
  let stopOpening: (reason: unknown) => void = () => {};
  const openingStopped = new Promise<never>((_, reject) => {
    stopOpening = reject;
  });
  openingStopped.catch(() => {});
  let opened = false;
  let reportFailure: (e: PdfOpenError) => void = () => {};
  const failed = new Promise<PdfOpenError>((resolve) => {
    reportFailure = resolve;
  });
  // After opening: the transport has stopped all fetching and answers every range still wanted with
  // blank bytes, so no page read waits; the reader shows the sentence and destroys the document. (It
  // is not destroyed here: pdf.js would then leave the reads in flight waiting for ever.) A worker
  // that stopped answers nothing more: the document is destroyed at once.
  const fail = (error: unknown, end = false) => {
    if (!opened) return stopOpening(toPdfOpenError(error));
    if (ending) return; // destroyed already
    reportFailure(toPdfOpenError(error));
    if (end) void destroy();
  };
  const onAbort = () => stopOpening(aborted(signal));
  const onWorkerError = () => fail(new PdfOpenError("other", WORKER_FAILED), true);
  signal.addEventListener("abort", onAbort, { once: true });
  worker.addEventListener("error", onWorkerError);
  const stopListening = onRangeFailure(transport, (error) => fail(error));
  try {
    const doc = await Promise.race([task.promise, openingStopped]);
    const pageLabels = await Promise.race([doc.getPageLabels(), openingStopped]);
    if (signal.aborted) throw aborted(signal);
    opened = true;
    const handleDestroy = () => {
      stopListening();
      worker.removeEventListener("error", onWorkerError);
      return destroy();
    };
    return { doc, pageCount: doc.numPages, pageLabels, failed, destroy: handleDestroy };
  } catch (err) {
    stopListening();
    worker.removeEventListener("error", onWorkerError);
    // Ended in the background: its end is not waited for (it may wait on a range that never comes).
    void destroy();
    if (signal.aborted) throw aborted(signal);
    throw toPdfOpenError(err);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
