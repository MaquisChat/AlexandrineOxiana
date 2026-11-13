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
 *  - image limits (A7, R201), as pdf.js 6.4.299's worker applies them:
 *    `maxImageSize` 2^28: an image whose DECLARED width × height is over 268,435,456 pixels is left
 *    out of the page entirely, before anything of it is decoded (pdf.worker.mjs
 *    `buildPaintImageXObject`: "Image exceeded maximum allowed size and was removed.", a console
 *    warning only), so a hostile file cannot make pdf.js allocate gigabytes; a 600 dpi A3 scan
 *    (70 Mpx) and a 1200 dpi bitonal A4 page (139 Mpx) are kept.
 *    `canvasMaxAreaInBytes` 2^28: pdf.js sets `ImageResizer.MAX_AREA` to it `>> 2`, 67,108,864
 *    pixels; an image larger than that (or wider or taller than the browser's largest canvas) is
 *    scaled down in the worker, by about 2× or more, before it reaches the page. A 600 dpi A4 or
 *    Letter scan (35 and 34 Mpx) is drawn at full size; a 600 dpi A3 scan or a 1200 dpi A4 page is
 *    drawn, scaled down. (`>> 2` means it must stay below 2^31.) pdf.js gives no supported signal
 *    when it leaves an image out: a page whose only picture is over 268 megapixels is drawn blank.
 *  - the document's bytes only through the range transport (rangeTransport.ts) over the service's
 *    ranged route, 1 MiB at a time, only what is needed (`disableAutoFetch`, `disableStream`):
 *    never a URL pdf.js fetches itself, never the token in a URL.
 * pdf.js's annotation layer (links, forms), its editor and XFA layers and its scripting sandbox are
 * never imported or rendered anywhere in the interface (pdfjs.test.ts checks the whole source).
 *
 * The pdf.js objects reachable through a `PdfHandle` (the document proxy and whatever hangs off it:
 * its pages, render tasks, text and image objects) are for the reader's own modules only, and every
 * read of them is always raced against the handle's `failed`.
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
  maxImageSize: 268435456,
  canvasMaxAreaInBytes: 268435456,
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
const NOT_A_PDF = "This file cannot be shown here.";
const CLOSED = "This document was closed.";
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
    // A 400: the asset is not a PDF (the client only ever asks well-formed ranges). A range past the
    // end (416): the file shrank.
    if (err.status === 400) return new PdfOpenError("other", NOT_A_PDF);
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

/**
 * An open document. `destroy()` ends it: the worker (and its copy of the bytes) and every range
 * still wanted. Every call on `doc`, on a page got from it, on a page's render task and text stream
 * goes through a guard: once the handle is dead, each call throws or rejects, and every call still
 * in flight rejects (with the failure, or "This document was closed."), even where pdf.js itself
 * would leave it waiting; nothing resolves with content after that.
 */
export interface PdfHandle {
  doc: PDFDocumentProxy;
  pageCount: number;
  /** The printed page labels ("vii", "12"…), one per page, or null when the file has none. */
  pageLabels: string[] | null;
  /**
   * Settles with the reason once the document can no longer be read: a range refused or failed after
   * it was opened (the project locked, the file gone or changed, the service out of reach), or the
   * worker stopped. At that moment the handle is dead and the document and its worker are destroyed:
   * no range is asked for afterwards, and pdf.js is never handed a byte that did not come from the
   * file. To go on, the reader opens the document again. Never settles after `destroy()`, for an
   * abort, or twice.
   */
  failed: Promise<PdfOpenError>;
  /** True once the document failed or was destroyed: nothing from this handle may be used or stored any more. */
  readonly dead: boolean;
  /** Ends the document; safe to call more than once. */
  destroy(): Promise<void>;
}

/**
 * Guards pdf.js's objects for one handle: a Proxy over the document, over each page got from it and
 * over each render task: once `isDead()`, nothing of pdf.js is called any more (a read rejects, a
 * render returns a task whose promise rejects, a size throws), and every promise (and
 * text stream) is raced against `died`, which rejects at the moment the handle dies. A result that
 * arrives after death is never handed on.
 */
function guard(isDead: () => boolean, deadError: () => Error, died: Promise<never>) {
  const settle = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p.then(
        (v) => {
          if (isDead()) throw deadError();
          return v;
        },
        (e: unknown) => {
          throw isDead() ? deadError() : e;
        },
      ),
      died,
    ]);
  const stream = (source: ReadableStream<unknown>): ReadableStream<unknown> => {
    const reader = source.getReader();
    return new ReadableStream<unknown>(
      {
        async pull(controller) {
          try {
            if (isDead()) throw deadError();
            const { value, done } = await Promise.race([reader.read(), died]);
            if (isDead()) throw deadError();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (e) {
            reader.cancel().catch(() => {});
            controller.error(isDead() ? deadError() : e);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  };
  const proxies = new WeakMap<object, object>();
  const wrap = <T extends object>(target: T, kind: "doc" | "page" | "task"): T => {
    const known = proxies.get(target);
    if (known) return known as T;
    const proxy = new Proxy(target, {
      get(t, prop) {
        const v: unknown = Reflect.get(t, prop, t);
        if (kind === "task" && prop === "promise") return settle(v as Promise<unknown>);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (isDead()) {
            // Dead: nothing is called. A read rejects (a render's task too); a size throws.
            if (prop === "getViewport") throw deadError();
            if (kind === "page" && prop === "render") {
              const promise = Promise.reject(deadError());
              promise.catch(() => {});
              return { promise, cancel() {} };
            }
            if (prop === "streamTextContent") return new ReadableStream({ start: (c) => c.error(deadError()) });
            return Promise.reject(deadError());
          }
          const r: unknown = (v as (...a: unknown[]) => unknown).apply(t, args);
          if (kind === "doc" && prop === "getPage") return settle((r as Promise<object>).then((page) => wrap(page, "page")));
          if (r instanceof Promise) return settle(r);
          if (r instanceof ReadableStream) return stream(r);
          if (kind === "page" && prop === "render" && r && typeof r === "object") return wrap(r, "task");
          return r;
        };
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return (doc: PDFDocumentProxy): PDFDocumentProxy => wrap(doc, "doc");
}

const aborted = (signal: AbortSignal): Error => (signal.reason instanceof Error && signal.reason.name === "AbortError" ? signal.reason : new DOMException("The document is no longer wanted.", "AbortError"));

/** Starts the bundled worker and waits for it to say it is ready; an error (not loaded, refused) is a PdfOpenError. */
function startWorker(signal: AbortSignal): Promise<Worker> {
  if (typeof Worker !== "function") return Promise.reject(new PdfOpenError("other", WORKER_FAILED));
  let worker: Worker;
  try {
    // WebKit throws here, synchronously (a SecurityError), when the policy or an origin check refuses it.
    worker = new Worker(workerUrl, { type: "module" });
  } catch {
    return Promise.reject(new PdfOpenError("other", WORKER_FAILED));
  }
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
  // Ends everything at once (A7): the transport, pdf.js's loading task (not waited for: it may wait on
  // a range that never comes), and the worker with the document's bytes in it (pdf.js does not end a
  // worker it was handed). Calls still in flight in pdf.js may never settle; the guard has already
  // rejected every one the reader holds. Safe to call more than once.
  const destroy = (): Promise<void> =>
    (ending ??= (async () => {
      transport.abort();
      void task.destroy().catch(() => {});
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
  // The handle's life (A7): once it dies (a failure after opening, or destroy()), every guarded call
  // throws or rejects, and every one in flight rejects at once.
  let dead = false;
  let deathError: Error = new PdfOpenError("other", CLOSED);
  let kill: (e: Error) => void = () => {};
  const died = new Promise<never>((_, reject) => {
    kill = reject;
  });
  died.catch(() => {});
  const die = (e: Error) => {
    if (dead) return false;
    dead = true;
    deathError = e;
    kill(e);
    return true;
  };
  const guarded = guard(
    () => dead,
    () => deathError,
    died,
  );
  // After opening: a failure kills the handle and destroys the document and its worker at once.
  const fail = (error: unknown) => {
    if (!opened) return stopOpening(toPdfOpenError(error));
    const failure = toPdfOpenError(error);
    if (!die(failure)) return; // dead already: a second failure, or after destroy(), does nothing more
    reportFailure(failure);
    void destroy();
  };
  const onAbort = () => stopOpening(aborted(signal));
  const onWorkerError = () => fail(new PdfOpenError("other", WORKER_FAILED));
  signal.addEventListener("abort", onAbort, { once: true });
  worker.addEventListener("error", onWorkerError);
  const stopListening = onRangeFailure(transport, (error) => fail(error));
  try {
    const doc = await Promise.race([task.promise, openingStopped]);
    const pageLabels = await Promise.race([doc.getPageLabels(), openingStopped]);
    if (signal.aborted) throw aborted(signal);
    opened = true;
    const handleDestroy = () => {
      die(new PdfOpenError("other", CLOSED));
      stopListening();
      worker.removeEventListener("error", onWorkerError);
      return destroy();
    };
    return {
      doc: guarded(doc),
      pageCount: doc.numPages,
      pageLabels,
      failed,
      get dead() {
        return dead;
      },
      destroy: handleDestroy,
    };
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
