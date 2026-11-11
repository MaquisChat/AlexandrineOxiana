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
import { isCredentialQueryKey } from "@ao/shared";
import type { AppearancePatch, AppearanceSettings } from "../theme/appearance";

export type ErrorCode =
  | "POLICY_DENIED"
  | "READ_ONLY"
  | "LIBRARY_OFFLINE"
  | "WRONG_PASSPHRASE"
  | "NOT_FOUND"
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "PROJECT_LOCKED"
  | "CONFLICT"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "WORKER_UNAVAILABLE"
  | "UNAVAILABLE"
  | "INTERNAL";

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

export type EventType = "library.state" | "job.progress" | "import.progress" | "capture.progress";
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
    get(): Promise<AppearanceSettings>;
    put(patch: AppearancePatch): Promise<AppearanceSettings>;
  };
  /**
   * A streamed NDJSON response (e.g. POST /libraries/locate): each line parsed as JSON, yielded as it
   * arrives, until the stream ends or `signal` aborts. Same URL, header and error rules as request().
   */
  ndjson<T>(method: Method, path: string, opts?: RequestOptions): AsyncGenerator<T, void, undefined>;
  /** Server-sent events from GET /events, until the stream ends or `signal` aborts. */
  events(opts?: { signal?: AbortSignal }): AsyncGenerator<ServiceEvent, void, undefined>;
}

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

const unreachable = (): ApiClientError => new ApiClientError(0, { code: "UNAVAILABLE", message: "The library service could not be reached." });
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
  async function* ndjson<T>(method: Method, path: string, o: RequestOptions = {}): AsyncGenerator<T, void, undefined> {
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
    const aborted = new Promise<"aborted">((resolve) => o.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array> | "aborted";
        try {
          chunk = await Promise.race([reader.read(), aborted]);
        } catch (err) {
          if (o.signal?.aborted) return;
          throw err instanceof ApiClientError ? err : unreachable();
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
        throw new ApiClientError(0, { code: "INTERNAL", message: "The library service's answer was cut off before it finished." });
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async function* events(o: { signal?: AbortSignal } = {}): AsyncGenerator<ServiceEvent, void, undefined> {
    const init: RequestInit = { method: "GET", headers: { ...auth, Accept: "text/event-stream" } };
    if (o.signal) init.signal = o.signal;
    let res: Response;
    try {
      res = await doFetch(urlFor("/events"), init);
    } catch {
      if (o.signal?.aborted) return;
      throw unreachable();
    }
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (o.signal?.aborted) return;
          throw err;
        }
        if (chunk.done) break;
        for (const e of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          yield e;
          if (o.signal?.aborted) return;
        }
      }
      // Whatever is left is an event the stream ended in the middle of: discarded.
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  return {
    request,
    appearance: {
      get: () => request<AppearanceSettings>("GET", "/settings/appearance"),
      put: (patch) => request<AppearanceSettings>("PUT", "/settings/appearance", { body: patch }),
    },
    ndjson,
    events,
  };
}
