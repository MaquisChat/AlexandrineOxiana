/**
 * Client for the local library service (apps/library-service, Task 30).
 *
 * Auth (R96, apps/library-service/src/auth.ts): the UI token goes in `Authorization: Bearer <token>`
 * on every request, including the event stream. It is never put in a URL (the service refuses a
 * token in the query string), so `events()` reads the SSE stream with fetch streaming rather than
 * EventSource, which cannot send headers.
 *
 * Errors: the service always answers errors as `{ error: { code, message, reason? } }`; they are
 * thrown as ApiClientError carrying exactly that.
 *
 * Hardening (R105): the base URL must be loopback http on a port; the token at least 32 characters
 * with no line breaks; paths carry no query or fragment; query keys on the service's credential
 * list are refused; and no URL may contain the token in any form.
 *
 * Typed methods exist for what the UI uses so far (appearance); later screens add theirs on top of
 * `request()` (Tasks 33+).
 */
import { DOCUMENT_RANGE_MAX_BYTES, isCredentialQueryKey, isMediaTicketPath, type ServiceErrorCode } from "@ao/shared";
import type { AppearancePatch, AppearanceSettings } from "../theme/appearance";

/** The codes the service answers with: its own list, declared once in @ao/shared (Task 47). */
export type ErrorCode = ServiceErrorCode;

export interface ServiceError {
  code: ErrorCode | (string & {});
  message: string;
  reason?: string;
}

export class ApiClientError extends Error {
  override name = "ApiClientError";
  readonly code: ServiceError["code"];
  readonly reason?: string;
  constructor(
    /** HTTP status, or 0 when the service could not be reached. */
    readonly status: number,
    readonly error: ServiceError,
  ) {
    super(error.message);
    this.code = error.code;
    if (error.reason !== undefined) this.reason = error.reason;
  }
}

export type EventType = "library.state" | "job.progress" | "import.progress" | "capture.progress" | "watch.status";
export interface ServiceEvent {
  type: EventType | (string & {});
  data: unknown;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ApiClient {
  /** Any route; `path` starts with "/". Prefer the typed methods. */
  request<T>(method: Method, path: string, opts?: RequestOptions): Promise<T>;
  appearance: {
    /** `opts.signal` (FR-756): cancels the read (the appearance settings' read is given up at its time limit). */
    get(opts?: { signal?: AbortSignal }): Promise<AppearanceSettings>;
    put(patch: AppearancePatch): Promise<AppearanceSettings>;
  };
  /**
   * A streamed NDJSON response (e.g. POST /libraries/locate): each line parsed as JSON, yielded as it
   * arrives, until the stream ends or `signal` aborts. Same URL, header and error rules as request().
   */
  ndjson<T>(method: Method, path: string, opts?: NdjsonOptions): AsyncGenerator<T, void, undefined>;
  /**
   * Server-sent events from GET /events, until the stream ends or `signal` aborts. `onOpen` is
   * called once the service has accepted the stream (events published from then on arrive).
   * `openWithinMs` (FR-756 C, R586 M2): a stream not opened (no answer yet) after that long is given up — its request
   * is cancelled and the stream ends with "The library service did not answer in time." — so that the caller's own
   * reconnect makes a fresh try. A stream that has opened is never ended by it. Without it, no limit (as before).
   */
  events(opts?: EventsOptions): AsyncGenerator<ServiceEvent, void, undefined>;
  /**
   * The address a media element loads for a media ticket (R135): the base URL plus the ticket path
   * the service gave (`/media/<ticket>`), nothing added. Only that exact form is accepted: no query,
   * no fragment, never the service token. The result is a secret (R135 5): give it to the media
   * element only — never show, log, store it or put it in the page address. Fetches nothing.
   */
  mediaUrl(ticketPath: string): string;
  /**
   * A file's content (GET), e.g. a picture for a `blob:` address (R135 1) or a font file (R100):
   * the token in the Authorization header as always, the body as a Blob of the type the service
   * sent. An answer larger than `maxBytes` is refused (PAYLOAD_TOO_LARGE). Same path rules as
   * request(); a bad path throws before anything is sent.
   */
  bytes(path: string, opts?: { signal?: AbortSignal; maxBytes?: number }): Promise<Blob>;
  /**
   * Bytes `start` to `end` (inclusive) of a stored file, e.g. a PDF for the reader (Task R5): one
   * GET with `Range: bytes=start-end` and the token in the Authorization header (never a media
   * ticket, never anything in the URL). The answer must be 206 with `Content-Range` starting at
   * `start` and ending at `end`, or earlier only where the service may cut it (the file's last byte,
   * or DOCUMENT_RANGE_MAX_BYTES), and a body of exactly that length; anything else is refused
   * (status 502, INTERNAL) and never handed on. The service's own refusals (404, 413, 423…) are
   * thrown as they are; a 416 (no body) as VALIDATION with the file's length as `reason`. An answer
   * whose signal was aborted meanwhile is never returned (AbortError). Same path rules as
   * request(); bad arguments throw before anything is sent. `onAnswer` (FR-756) is called once the service's answer has
   * begun (its headers arrived), before its body is read.
   */
  byteRange(path: string, start: number, end: number, opts?: { signal?: AbortSignal; onAnswer?: () => void }): Promise<{ bytes: Uint8Array; start: number; end: number; total: number }>;
}

/** The options of `events()`. */
export interface EventsOptions {
  signal?: AbortSignal;
  onOpen?: () => void;
  openWithinMs?: number;
  /** R641 D2: how long an open stream may stay silent before it is given up (no limit unless asked; see STREAM_QUIET_TIMEOUT_MS). */
  quietWithinMs?: number;
}

/**
 * FR-756 C (R586 M2): how long the event stream is waited for to open before it is given up and tried afresh. The
 * service answers it at once, with the library's state, from the same machine; twenty seconds is long.
 */
export const STREAM_OPEN_TIMEOUT_MS = 20_000;

/**
 * R641 D2: how long an OPEN event stream may deliver nothing before it is taken as lost and given up ("did not answer
 * in time"), so the caller's own reconnect opens it afresh. The service writes a keep-alive comment every 25 seconds
 * (routes/libraries.ts), so a minute of silence is more than two missed beats. Like the opening limit (R597), it is
 * turned on consumer by consumer (`quietWithinMs`), each with its own test, and only where a reconnect follows.
 */
export const STREAM_QUIET_TIMEOUT_MS = 60_000;

/** `onOpen` is called once the service has answered with a stream (its headers arrived), before any line. */
export type NdjsonOptions = RequestOptions & { onOpen?: () => void };

export interface ClientOptions {
  fetch?: typeof fetch;
}


/** The service listens on loopback only (R96): http://127.0.0.1:<port> or http://localhost:<port>. */
function checkBase(baseUrl: string): string {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/.exec(baseUrl);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) {
    throw new Error("The service base URL must be http://127.0.0.1:<port> or http://localhost:<port>, with nothing else.");
  }
  return `http://${m[1]}:${port}`;
}

function checkToken(token: string): void {
  // eslint-disable-next-line no-control-regex
  if (typeof token !== "string" || token.length < 32 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("The service token must be at least 32 characters, with no line breaks or control characters.");
  }
}

/** Said when the library service could not be reached (no answer at all). */
export const SERVICE_UNREACHABLE = "The library service could not be reached.";
/** R586 M5: said where a read was given up at its time limit (it neither answered nor failed). */
export const SERVICE_NO_ANSWER = "The library service did not answer in time.";
/** The error of a request that got no answer at all (status 0, UNAVAILABLE). */
export const unreachable = (): ApiClientError => new ApiClientError(0, { code: "UNAVAILABLE", message: SERVICE_UNREACHABLE });
/** The error of a read given up at its time limit (status 0, UNAVAILABLE): the service may only have been slow. */
export const noAnswerInTime = (): ApiClientError => new ApiClientError(0, { code: "UNAVAILABLE", message: SERVICE_NO_ANSWER });
/** Said of an answer that began and then broke off (FR-350); also said by the reader (R481 a). */
export const ANSWER_CUT_OFF = "The library service's answer was cut off before it finished.";
/** An answer that began and then broke off: the service was reached, so it is not said to be out of reach (FR-350). */
const cutOff = (): ApiClientError => new ApiClientError(0, { code: "INTERNAL", message: ANSWER_CUT_OFF });
const unexpected = (status: number): ApiClientError =>
  new ApiClientError(status, { code: "INTERNAL", message: `The library service answered with something unexpected (HTTP ${status}).` });

async function errorFrom(res: Response): Promise<ApiClientError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = (body as { error?: Partial<ServiceError> } | undefined)?.error;
  if (e && typeof e.code === "string" && typeof e.message === "string") {
    return new ApiClientError(res.status, { code: e.code, message: e.message, ...(typeof e.reason === "string" ? { reason: e.reason } : {}) });
  }
  return new ApiClientError(res.status, { code: "INTERNAL", message: `The library service answered with an unexpected error (HTTP ${res.status}).` });
}

/** Largest single event the client accepts (R105); a bigger one is an error, not unbounded memory. */
export const MAX_SSE_EVENT_BYTES = 1024 * 1024;
/** Largest single NDJSON line, in UTF-8 bytes (R114 I5). */
export const MAX_NDJSON_LINE_BYTES = 1024 * 1024;

/**
 * Incremental parser for a text/event-stream (WHATWG HTML §9.2): lines end with CRLF, LF or CR (a
 * CRLF split across chunks counts once); a blank line dispatches the event; `:` lines are comments;
 * several `data:` lines join with "\n" and are parsed as JSON when they are JSON. Only new text is
 * scanned on each push, and an event over MAX_SSE_EVENT_BYTES throws. An event the stream ends in the
 * middle of is never dispatched.
 */
export class SseParser {
  private parts: string[] = [];
  private lineLength = 0;
  private afterCR = false;
  private type = "";
  private data: string[] = [];
  private eventLength = 0;

  push(text: string): ServiceEvent[] {
    const out: ServiceEvent[] = [];
    let i = 0;
    if (text === "") return out; // an empty chunk changes nothing (a pending CR stays pending)
    if (this.afterCR && text.startsWith("\n")) i = 1;
    this.afterCR = false;
    const eol = /\r\n|\r|\n/g;
    eol.lastIndex = i;
    for (let m = eol.exec(text); m; m = eol.exec(text)) {
      this.add(text.slice(i, m.index));
      i = m.index + m[0].length;
      if (m[0] === "\r" && i === text.length) this.afterCR = true;
      this.line(this.parts.join(""), out);
      this.parts = [];
      this.lineLength = 0;
    }
    this.add(text.slice(i));
    return out;
  }

  private add(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.lineLength += s.length;
    if (this.lineLength + this.eventLength > MAX_SSE_EVENT_BYTES) {
      throw new ApiClientError(0, { code: "PAYLOAD_TOO_LARGE", message: "The library service sent an event larger than 1 MB; the event stream was closed." });
    }
  }

  private line(line: string, out: ServiceEvent[]): void {
    if (line === "") {
      if (this.data.length) {
        const raw = this.data.join("\n");
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        out.push({ type: this.type || "message", data });
      }
      this.type = "";
      this.data = [];
      this.eventLength = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
    if (field === "event") this.type = value;
    else if (field === "data") {
      this.data.push(value);
      this.eventLength += value.length + 1;
    }
  }
}

/**
 * A path with every layer of percent-encoding removed (decoded until it stops changing), so a token
 * cannot hide behind double encoding. A path that does not decode at all is refused.
 */
function fullyDecoded(path: string): string {
  let cur: string;
  try {
    cur = decodeURIComponent(path);
  } catch {
    throw new Error("A service path must be valid percent-encoding."); // the path is not echoed: it could carry a secret
  }
  for (let i = 0; i < 8; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

export function createClient(baseUrl: string, token: string, opts: ClientOptions = {}): ApiClient {
  const base = checkBase(baseUrl);
  checkToken(token);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const auth = { Authorization: `Bearer ${token}` };
  // The token as it could appear in a URL: raw, percent-encoded, and as URLSearchParams writes it.
  const tokenForms = [token, encodeURIComponent(token), new URLSearchParams({ t: token }).toString().slice(2)];

  function urlFor(path: string, query?: RequestOptions["query"]): string {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#]|%3f|%23/i.test(path)) {
      throw new Error('A service path must start with "/" and have no query or fragment; pass query values in opts.query.'); // not echoed
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (isCredentialQueryKey(k) || /token/i.test(k)) throw new Error(`"${k}" is a credential key: a token is sent in the Authorization header, never in a URL.`);
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    const url = `${base}${path}${s ? `?${s}` : ""}`;
    if (tokenForms.some((t) => url.includes(t)) || fullyDecoded(path).includes(token)) throw new Error("Refusing a URL that contains the service token: it is sent in the Authorization header only.");
    return url;
  }

  async function send<T>(method: Method, url: string, o: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { ...auth, Accept: "application/json" };
    const init: RequestInit = { method, headers };
    if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    if (o.signal) init.signal = o.signal;
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw unreachable();
    }
    if (!res.ok) throw await errorFrom(res);
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw unexpected(res.status);
    }
  }

  function request<T>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
    const url = urlFor(path, o.query); // throws synchronously on a bad path or a credential in the URL
    return send<T>(method, url, o);
  }

  /**
   * NDJSON (R114 I5): an abort ends the generator quietly; a stream that ends in the middle of a
   * line is an error (truncated); every line — and any unfinished line — is capped at
   * MAX_NDJSON_LINE_BYTES of UTF-8, measured with TextEncoder, however it arrives.
   */
  async function* ndjson<T>(method: Method, path: string, o: NdjsonOptions = {}): AsyncGenerator<T, void, undefined> {
    const url = urlFor(path, o.query);
    const headers: Record<string, string> = { ...auth, Accept: "application/x-ndjson" };
    const init: RequestInit = { method, headers };
    if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    if (o.signal) init.signal = o.signal;
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch {
      if (o.signal?.aborted) return;
      throw unreachable();
    }
    if (!res.ok) throw await errorFrom(res);
    o.onOpen?.();
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const tooLarge = () => new ApiClientError(0, { code: "PAYLOAD_TOO_LARGE", message: "The library service sent a line larger than 1 MB; the stream was closed." });
    const parse = (line: string): T => {
      if (encoder.encode(line).length > MAX_NDJSON_LINE_BYTES) throw tooLarge();
      try {
        return JSON.parse(line) as T;
      } catch {
        throw unexpected(res.status);
      }
    };
    let buf = "";
    // A read the body never answers still ends promptly on abort.
    // The listener is removed when the generator ends, so a long-lived signal does not collect one per call (41b1 M13).
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      o.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array> | "aborted";
        try {
          chunk = await Promise.race([reader.read(), aborted]);
        } catch (err) {
          if (o.signal?.aborted) return;
          // The answer had begun (R467 M6): a read that breaks off is a cut-off, as in bytes().
          throw err instanceof ApiClientError ? err : cutOff();
        }
        if (chunk === "aborted" || o.signal?.aborted) return;
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.trim()) yield parse(line);
          if (o.signal?.aborted) return;
          nl = buf.indexOf("\n");
        }
        // An unfinished line: characters are at least one byte each, so measure only when it could be over.
        if (buf.length > MAX_NDJSON_LINE_BYTES / 4 && encoder.encode(buf).length > MAX_NDJSON_LINE_BYTES) throw tooLarge();
      }
      buf += decoder.decode();
      if (buf.trim()) {
        throw cutOff();
      }
    } finally {
      if (onAbort) o.signal?.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => {});
    }
  }

  async function* events(o: EventsOptions = {}): AsyncGenerator<ServiceEvent, void, undefined> {
    const init: RequestInit = { method: "GET", headers: { ...auth, Accept: "text/event-stream" } };
    if (o.signal) init.signal = o.signal;
    // FR-756 C: with a limit, the request has a signal of its own, aborted by the caller's or at the limit (until open).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    let unlink = () => {};
    const quietMs = o.quietWithinMs;
    let silence: (() => void) | undefined;
    if (o.openWithinMs !== undefined || quietMs !== undefined) {
      const ac = new AbortController();
      const stop = () => ac.abort();
      if (o.signal?.aborted) ac.abort();
      else o.signal?.addEventListener("abort", stop, { once: true });
      unlink = () => o.signal?.removeEventListener("abort", stop);
      init.signal = ac.signal;
      if (o.openWithinMs !== undefined) {
        timer = setTimeout(() => {
          gaveUp = true;
          ac.abort();
        }, o.openWithinMs);
      }
      silence = () => {
        gaveUp = true;
        ac.abort();
      };
    }
    let res: Response;
    try {
      res = await doFetch(urlFor("/events"), init);
    } catch {
      unlink();
      if (o.signal?.aborted) return;
      throw gaveUp ? noAnswerInTime() : unreachable();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) unlink();
    if (!res.ok) throw await errorFrom(res);
    o.onOpen?.();
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    // R641 D2: each wait for the next piece of the stream (an event or a keep-alive) is limited by `quietMs`; at the
    // limit the request is cancelled (and the read too, should the body not end with it) and the stream given up.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        if (quietMs !== undefined && silence) {
          const giveUp = silence;
          quiet = setTimeout(() => {
            giveUp();
            reader.cancel().catch(() => {});
          }, quietMs);
        }
        try {
          chunk = await reader.read();
        } catch (err) {
          if (o.signal?.aborted) return;
          if (gaveUp) throw noAnswerInTime();
          throw err;
        } finally {
          clearTimeout(quiet);
        }
        if (gaveUp && !o.signal?.aborted) throw noAnswerInTime();
        if (chunk.done) break;
        for (const e of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          yield e;
          if (o.signal?.aborted) return;
        }
      }
      // Whatever is left is an event the stream ended in the middle of: discarded.
    } finally {
      unlink();
      reader.cancel().catch(() => {});
    }
  }

  /** R135: a ticket address is `/media/` and 43 base64url characters; the token is never in it. */
  function mediaUrl(ticketPath: string): string {
    if (typeof ticketPath !== "string" || !isMediaTicketPath(ticketPath)) throw new Error("Not a media address: expected /media/<ticket> and nothing else."); // not echoed
    if (tokenForms.some((t) => ticketPath.includes(t))) throw new Error("Refusing a media address that contains the service token.");
    return `${base}${ticketPath}`;
  }

  function bytes(path: string, o: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Blob> {
    const url = urlFor(path); // throws synchronously on a bad path or a credential in the URL
    const tooLarge = () => new ApiClientError(0, { code: "PAYLOAD_TOO_LARGE", message: "The file is too large to show here." });
    return (async () => {
      const init: RequestInit = { method: "GET", headers: { ...auth, Accept: "*/*" } };
      if (o.signal) init.signal = o.signal;
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch (err) {
        if (o.signal?.aborted) throw err;
        throw unreachable();
      }
      if (!res.ok) throw await errorFrom(res);
      const declared = Number(res.headers.get("content-length"));
      if (o.maxBytes !== undefined && Number.isFinite(declared) && declared > o.maxBytes) {
        res.body?.cancel().catch(() => {});
        throw tooLarge();
      }
      const type = res.headers.get("content-type") ?? "";
      if (o.maxBytes === undefined || !res.body) {
        let blob: Blob;
        try {
          blob = await res.blob();
        } catch (err) {
          if (o.signal?.aborted) throw err;
          throw cutOff();
        }
        if (o.maxBytes !== undefined && blob.size > o.maxBytes) throw tooLarge();
        return blob;
      }
      // With a limit, the body is read in chunks and given up as soon as it passes the limit, so a
      // body that does not say its length is never held whole first (M11).
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > o.maxBytes) {
            reader.cancel().catch(() => {});
            throw tooLarge();
          }
          parts.push(value);
        }
      } catch (err) {
        if (err instanceof ApiClientError || o.signal?.aborted) throw err;
        throw cutOff();
      }
      return new Blob(parts as BlobPart[], { type });
    })();
  }

  async function byteRange(path: string, start: number, end: number, o: { signal?: AbortSignal; onAnswer?: () => void } = {}): Promise<{ bytes: Uint8Array; start: number; end: number; total: number }> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error("A byte range needs whole numbers with 0 ≤ start ≤ end.");
    }
    const url = urlFor(path); // throws on a bad path or a credential in the URL
    const mismatch = () => new ApiClientError(502, { code: "INTERNAL", message: "The library service answered with another part of the file than was asked for." });
    const init: RequestInit = { method: "GET", headers: { ...auth, Accept: "*/*", Range: `bytes=${start}-${end}` }, cache: "no-store" };
    if (o.signal) init.signal = o.signal;
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      throw unreachable();
    }
    o.onAnswer?.();
    if (res.status === 416) {
      // No error body: said in plain words, with the file's length (`bytes */<total>`) as the reason.
      res.body?.cancel().catch(() => {});
      const total = /^bytes \*\/(\d{1,16})$/.exec(res.headers.get("content-range") ?? "")?.[1];
      throw new ApiClientError(416, { code: "VALIDATION", message: "The part of the file asked for is past its end.", ...(total !== undefined ? { reason: total } : {}) });
    }
    if (!res.ok) throw await errorFrom(res);
    const refuse = (): never => {
      res.body?.cancel().catch(() => {});
      throw mismatch();
    };
    if (res.status !== 206) refuse();
    const m = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/.exec(res.headers.get("content-range") ?? "");
    if (!m) return refuse();
    const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // The start asked; an end no later than asked and inside the file; cut short only where the service may cut.
    if (a !== start || b < a || b > end || b >= total || !Number.isSafeInteger(total)) refuse();
    const length = b - a + 1;
    if (b < end && b !== total - 1 && length !== DOCUMENT_RANGE_MAX_BYTES) refuse();
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) !== length) refuse();
    // Read into exactly `length` bytes; a body longer or shorter than that is refused.
    const bytes = new Uint8Array(length);
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (got + value.byteLength > length) {
            reader.cancel().catch(() => {});
            throw mismatch();
          }
          bytes.set(value, got);
          got += value.byteLength;
        }
      } catch (err) {
        if (err instanceof ApiClientError || o.signal?.aborted) throw err;
        // The 206 had begun (R467 M6): a body that breaks off is a cut-off, as in bytes().
        throw cutOff();
      }
    }
    if (got !== length) throw mismatch();
    // Aborted while the body was being read: the answer is stale, never handed back.
    if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new DOMException("The range was no longer wanted.", "AbortError");
    return { bytes, start: a, end: b, total };
  }

  return {
    request,
    bytes,
    byteRange,
    appearance: {
      get: (opts = {}) => request<AppearanceSettings>("GET", "/settings/appearance", opts.signal ? { signal: opts.signal } : {}),
      put: (patch) => request<AppearanceSettings>("PUT", "/settings/appearance", { body: patch }),
    },
    ndjson,
    events,
    mediaUrl,
  };
}
