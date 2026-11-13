/**
 * The way pdf.js reads a stored PDF (Task R6): a `PDFDataRangeTransport` over the service's ranged
 * document route (Task R5, `byteRange`), so the bytes come only through an authenticated fetch with
 * the token in its header, never through a URL pdf.js fetches itself (R96, R135).
 *
 * pdf.js asks for [begin, end) (end exclusive); `fetchRange(start, end)` is called with inclusive
 * ends, as `byteRange` and `readerApi().documentRange` take them, and may answer with fewer bytes
 * than asked (the service cuts an answer at DOCUMENT_RANGE_MAX_BYTES): the rest is asked for next,
 * and pdf.js is handed the whole range at once, as it expects.
 *
 * A failure (a locked project, a file gone or changed, an answer of the wrong length, the service
 * out of reach) stops the transport: nothing more is fetched, ever. It is told to whoever listens
 * through `onRangeFailure` (openPdf, which puts it on the handle's `failed`, and the reader then
 * destroys the document at once, A7). pdf.js is NEVER handed a byte that did not come from the file:
 * a range that failed, and any range asked for afterwards, is simply never answered (pdf.js 6.4.299
 * has no way to fail a range; feeding it made-up bytes made one page answer with another's text).
 * The reads that waited for it are ended by openPdf, which destroys the document and makes every
 * call on the handle reject.
 * `abort()` (pdf.js calls it when the document is destroyed) stops the transport too, aborts the
 * signal given to every fetch in flight, and reports nothing; so does a fetch that fails because
 * the caller's own signal was aborted (leaving the reader is not a failure).
 */
import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Bytes `start` to `end` (inclusive) of the document, or fewer from `start`; `signal` aborts when the
 * transport stops. Answering `{ bytes, total }` (as `documentRange` does) also gives the file's length
 * now: a length other than the document's means the file changed while it was being read, a failure.
 */
export type FetchRange = (start: number, end: number, signal?: AbortSignal) => Promise<Uint8Array | { bytes: Uint8Array; total: number }>;

/** The file's length changed between two ranges: it was replaced or edited while it was being read. */
export class FileChangedError extends Error {
  override name = "FileChangedError";
  constructor() {
    super("The file changed while it was being read.");
  }
}

type FailureListener = (error: unknown) => void;

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";


class ServiceRangeTransport extends PDFDataRangeTransport {
  readonly #fetchRange: FetchRange;
  readonly #stop = new AbortController();
  readonly #listeners = new Set<FailureListener>();
  #failure: { error: unknown } | undefined;
  /** Each range pdf.js asked for and has not been answered yet: begin → end (exclusive). */


  constructor(first: { bytes: Uint8Array; total: number }, fetchRange: FetchRange) {
    super(first.total, first.bytes);
    this.#fetchRange = fetchRange;
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.#failure) {
      // Failed already: nothing is fetched, nothing is handed on.
      return;
    }
    void this.#load(begin, Math.min(end, this.length));
  }

  /** Hands pdf.js the answer to the range that begins at `begin`. */
  #hand(begin: number, chunk: Uint8Array): void {
    try {
      this.onDataRange(begin, chunk);
    } catch {
      // pdf.js no longer waits for this range (its reader was cancelled meanwhile): nothing to hand on.
    }
  }

  override abort(): void {
    this.#stop.abort();
  }

  /** Listens for the first failure; called at once if there was one already. Returns the way to stop listening. */
  onFailure(listener: FailureListener): () => void {
    if (this.#failure) {
      listener(this.#failure.error);
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #load(begin: number, end: number): Promise<void> {
    const signal = this.#stop.signal;
    if (signal.aborted) return;
    const parts: Uint8Array[] = [];
    let at = begin;
    try {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= end) throw new RangeError(`pdf.js asked for an impossible range (${begin}, ${end}).`);
      while (at < end) {
        const answer = await this.#fetchRange(at, end - 1, signal);
        if (signal.aborted) return;
        const bytes = answer instanceof Uint8Array ? answer : answer?.bytes;
        if (!(answer instanceof Uint8Array) && answer?.total !== this.length) throw new FileChangedError();
        if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > end - at) {
          throw new RangeError("The library service answered with another part of the file than was asked for.");
        }
        parts.push(bytes);
        at += bytes.length;
      }
    } catch (err) {
      if (signal.aborted) return;
      this.#stop.abort();
      if (isAbort(err)) return;
      this.#fail(err);
      return;
    }
    this.#hand(begin, parts.length === 1 ? parts[0]! : concat(parts, end - begin));
  }

  #fail(error: unknown): void {
    if (this.#failure) return;
    this.#failure = { error };
    for (const l of [...this.#listeners]) l(error);
    this.#listeners.clear();
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The transport for a document of `first.total` bytes whose first bytes (from offset 0) are
 * `first.bytes`, the answer to the first range the reader fetched; every other range through
 * `fetchRange`.
 */
export function createRangeTransport(first: { bytes: Uint8Array; total: number }, fetchRange: FetchRange): PDFDataRangeTransport {
  const { bytes, total } = first;
  if (!Number.isSafeInteger(total) || total < 1 || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > total) {
    throw new RangeError("The first part of a document must be its first bytes, no longer than the document.");
  }
  return new ServiceRangeTransport(first, fetchRange);
}

/**
 * Listens for the first range of `transport` that failed (a transport made by createRangeTransport;
 * any other never reports). Called at once if one failed already. Returns the way to stop listening.
 */
export function onRangeFailure(transport: PDFDataRangeTransport, listener: (error: unknown) => void): () => void {
  return transport instanceof ServiceRangeTransport ? transport.onFailure(listener) : () => {};
}
