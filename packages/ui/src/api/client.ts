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
 * Typed methods exist for what the UI uses so far (appearance); later screens add theirs on top of
 * `request()` (Tasks 33+).
 */
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
  /** Server-sent events from GET /events, until the stream ends or `signal` aborts. */
  events(opts?: { signal?: AbortSignal }): AsyncGenerator<ServiceEvent, void, undefined>;
}

export interface ClientOptions {
  fetch?: typeof fetch;
}

function checkBase(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("The service base URL is not a URL.");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) {
    throw new Error("The service base URL must be http(s)://host:port with no credentials, query or fragment.");
  }
  return u.href.replace(/\/+$/, "");
}

const unreachable = (): ApiClientError => new ApiClientError(0, { code: "UNAVAILABLE", message: "The library service could not be reached." });

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

/**
 * Splits complete SSE frames off `buf`: the events in them, and the incomplete rest. Comment lines
 * (":" keep-alives) are skipped; several `data:` lines join with "\n" and are parsed as JSON.
 */
export function parseSse(buf: string): { events: ServiceEvent[]; rest: string } {
  const text = buf.replace(/\r\n?/g, "\n");
  const frames = text.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ServiceEvent[] = [];
  for (const frame of frames) {
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) continue;
    const raw = data.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    events.push({ type, data: parsed });
  }
  return { events, rest };
}

export function createClient(baseUrl: string, token: string, opts: ClientOptions = {}): ApiClient {
  const base = checkBase(baseUrl);
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const auth = { Authorization: `Bearer ${token}` };

  function urlFor(path: string, query?: RequestOptions["query"]): string {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`A service path must start with "/" (got "${path}").`);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (/token/i.test(k)) throw new Error("A token is sent in the Authorization header, never in a URL.");
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    return `${base}${path}${s ? `?${s}` : ""}`;
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
    return (await res.json()) as T;
  }

  function request<T>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
    const url = urlFor(path, o.query); // throws synchronously on a bad path or a token in the query
    return send<T>(method, url, o);
  }

  async function* events(o: { signal?: AbortSignal } = {}): AsyncGenerator<ServiceEvent, void, undefined> {
    const init: RequestInit = { method: "GET", headers: { ...auth, Accept: "text/event-stream" } };
    if (o.signal) init.signal = o.signal;
    let res: Response;
    try {
      res = await doFetch(urlFor("/events"), init);
    } catch (err) {
      if (o.signal?.aborted) return;
      throw unreachable();
    }
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
        buf += decoder.decode(chunk.value, { stream: true });
        const { events: evs, rest } = parseSse(buf);
        buf = rest;
        for (const e of evs) {
          yield e;
          if (o.signal?.aborted) return;
        }
      }
      buf += decoder.decode();
      yield* parseSse(`${buf}\n\n`).events;
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
    events,
  };
}
