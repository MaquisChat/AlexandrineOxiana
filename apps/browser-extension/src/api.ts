/**
 * Talking to the library service on this computer (R96, R110):
 *  - only http://127.0.0.1:<port>, where <port> is the one the user typed from the desktop app (no
 *    port scanning);
 *  - pairing posts the 6-digit code to /extension/pair/confirm; the token it returns is kept in
 *    storage.local (never storage.sync) and removed by unpair;
 *  - every other request carries the token in the Authorization header only, never in a URL; JSON
 *    bodies; no cookies, no cache, and redirects refused (so the header cannot follow one elsewhere);
 *  - when the desktop app had to change its port (R171: it keeps its port across launches unless
 *    another program took it), the user types the new port shown in the app; `changePort` checks it
 *    with one authorised request (GET /projects) and saves it only if the app accepts the token
 *    there. The token stays as it is; nothing is ever scanned.
 */
import type { BrowserCaptureBody, BrowserCaptureResult, ProjectChoice } from "./types.js";

/** The part of storage.local this module uses (a stand-in in tests). */
export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Pairing {
  port: number;
  token: string;
  pairedAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    /** The service's reason (POLICY_DENIED: the project rule that refused it). */
    readonly reason?: string,
    /** The error answer had the service's own shape, `{ error: { code, message } }` (R96). */
    readonly serviceShaped = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KEY = "pairing";
/** The extension token: at least 32 base64url characters (the service issues 43). */
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

export function parsePort(v: string | number): number | undefined {
  const s = String(v).trim();
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
}

function asPairing(v: unknown): Pairing | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const port = typeof p.port === "number" ? parsePort(p.port) : undefined;
  if (port === undefined || p.port !== port || typeof p.token !== "string" || !TOKEN.test(p.token)) return undefined;
  return { port, token: p.token, pairedAt: typeof p.pairedAt === "string" ? p.pairedAt : "" };
}

/** The app does not answer on the saved port: either cause, in plain words (R171). */
export const unreachable = (port: number) =>
  `The desktop app is not answering on port ${port}. Either the app is closed (open it and try again), or the app's port changed when it was reopened: its “Browser extension” page, at the top of its library window, shows the port it uses now.`;

function projectsOf(r: unknown): ProjectChoice[] | undefined {
  const list = (r as { projects?: unknown } | undefined)?.projects;
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((p): p is ProjectChoice => typeof p?.id === "string" && typeof p?.name === "string")
    .map((p) => ({ id: p.id, name: p.name, captureMethods: Array.isArray(p.captureMethods) ? p.captureMethods.filter((m): m is string => typeof m === "string") : [] }));
}

export interface ApiDeps {
  fetch: typeof fetch;
  storage: LocalStorageArea;
}

export function createApi({ fetch: doFetch, storage }: ApiDeps) {
  async function getPairing(): Promise<Pairing | undefined> {
    return asPairing((await storage.get(KEY))[KEY]);
  }

  async function call<T>(
    port: number,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; token?: string; signal?: AbortSignal; only200?: boolean; file?: { body: Blob; type: string; headers: Record<string, string> } },
  ): Promise<T> {
    if (!path.startsWith("/") || /[?#]/.test(path)) throw new ApiError("BAD_PATH", "Internal error: bad request path.");
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    // A file's bytes (the browser's fallback, R348 f): its own type and headers, the Blob as the body.
    if (init.file) Object.assign(headers, init.file.headers, { "content-type": init.file.type });
    let res: Response;
    try {
      res = await doFetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method,
        headers,
        ...(init.file ? { body: init.file.body } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch {
      if (init.signal?.aborted) throw new ApiError("ABORTED", "Stopped.");
      throw new ApiError("UNREACHABLE", unreachable(port));
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: unknown; message?: unknown; reason?: unknown } } | undefined)?.error;
      const code = typeof err?.code === "string" ? err.code : `HTTP_${res.status}`;
      const message = typeof err?.message === "string" ? err.message : `The desktop app answered ${res.status}.`;
      const shaped = typeof err?.code === "string" && typeof err?.message === "string";
      throw new ApiError(code, message, res.status, typeof err?.reason === "string" ? err.reason : undefined, shaped);
    }
    if (init.only200 && res.status !== 200) throw new ApiError("BAD_REPLY", "The desktop app's answer was not understood.", res.status);
    return data as T;
  }

  /** A call with the stored token; a token the service no longer accepts is forgotten. */
  async function authed<T>(path: string, method: "GET" | "POST", body?: unknown, more: { signal?: AbortSignal; file?: { body: Blob; type: string; headers: Record<string, string> } } = {}): Promise<T> {
    const p = await getPairing();
    if (!p) throw new ApiError("NOT_PAIRED", "Pair the extension with the desktop app first.");
    try {
      return await call<T>(p.port, path, { method, token: p.token, ...(body !== undefined ? { body } : {}), ...(more.signal ? { signal: more.signal } : {}), ...(more.file ? { file: more.file } : {}) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await storage.remove(KEY);
      throw e;
    }
  }

  return {
    getPairing,

    /** Confirms the code the desktop app shows; keeps the token in storage.local. */
    async pair(portInput: string | number, codeInput: string): Promise<Pairing> {
      const port = parsePort(portInput);
      if (port === undefined) throw new ApiError("BAD_PORT", "The port is a number between 1 and 65535, as shown in the desktop app.");
      if (!/^\d{6}$/.test(codeInput)) throw new ApiError("BAD_CODE", "The pairing code is the 6 digits shown in the desktop app.");
      const r = await call<{ token?: unknown }>(port, "/extension/pair/confirm", { method: "POST", body: { code: codeInput } });
      if (typeof r?.token !== "string" || !TOKEN.test(r.token)) throw new ApiError("BAD_REPLY", "The desktop app's answer was not understood.");
      const pairing: Pairing = { port, token: r.token, pairedAt: new Date().toISOString() };
      await storage.set({ [KEY]: pairing });
      return pairing;
    },

    async unpair(): Promise<void> {
      await storage.remove(KEY);
    },

    async listProjects(): Promise<ProjectChoice[]> {
      const projects = projectsOf(await authed<unknown>("/projects", "GET"));
      if (!projects) throw new ApiError("BAD_REPLY", "The desktop app's answer was not understood.");
      return projects;
    },

    /**
     * The desktop app's port changed (R171): checks `portInput` with one authorised request
     * (GET /projects, the token in the header) and, only if the app accepts the token there, saves
     * it as the pairing's port. The token is kept whatever happens: a refusal on the new port may
     * come from another program, so it is no reason to forget the pairing. `projects` is the list the
     * check returned, or null when the app has no library open (the token was accepted all the same).
     * A limit, accepted: any local program that answers this check as the app would (for example 200
     * with an empty project list) passes it, since being sure it is the app would need a proof tied to
     * the token; the researcher types this one port from the app's own page, and nothing is scanned.
     */
    async changePort(portInput: string | number, opts: { signal?: AbortSignal } = {}): Promise<{ pairing: Pairing; projects: ProjectChoice[] | null }> {
      const port = parsePort(portInput);
      if (port === undefined) throw new ApiError("BAD_PORT", "The port is a number between 1 and 65535, as shown in the desktop app.");
      const before = await getPairing();
      if (!before) throw new ApiError("NOT_PAIRED", "Pair the extension with the desktop app first.");
      const kept = `This browser keeps port ${before.port}.`;
      let projects: ProjectChoice[] | null;
      try {
        const r = await call<unknown>(port, "/projects", { method: "GET", token: before.token, only200: true, ...(opts.signal ? { signal: opts.signal } : {}) });
        const list = projectsOf(r);
        if (!list) throw new ApiError("BAD_REPLY", "");
        projects = list;
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        if (code === "ABORTED" || opts.signal?.aborted) throw new ApiError("ABORTED", "Stopped. Nothing was saved.");
        // "No library open" passes only as the app's own answer to this authorised request: 503 with
        // the service's error shape and that code (fix round 1, I2). Any other status fails.
        if (code === "LIBRARY_OFFLINE" && e instanceof ApiError && e.status === 503 && e.serviceShaped) projects = null;
        // Any other 503 in the service's own shape is the app speaking (e.g. its list of paired
        // browsers cannot be read right now): its own words, and the port kept (Task 68, Rm5).
        else if (e instanceof ApiError && e.status === 503 && e.serviceShaped) throw new ApiError(e.code, `${e.message} ${kept}`, 503);
        else if (code === "UNREACHABLE") throw new ApiError("UNREACHABLE", `Nothing answered on port ${port}. Check the number on the desktop app's “Browser extension” page, and that the app is open. ${kept}`);
        else if (e instanceof ApiError && (e.status === 401 || e.status === 403))
          throw new ApiError("NOT_ACCEPTED", `The program on port ${port} did not accept this browser's pairing. Check the number on the desktop app's “Browser extension” page. If this browser was revoked there, unpair and pair again. ${kept}`, e.status);
        else throw new ApiError("BAD_REPLY", `The answer on port ${port} was not one from the desktop app that this browser understands. Check the number on the desktop app's “Browser extension” page. ${kept}`);
      }
      // Saved only onto the same pairing: one unpaired or replaced meanwhile is not brought back.
      const now = await getPairing();
      if (!now || now.token !== before.token) throw new ApiError("CHANGED", "The pairing changed while the port was being checked, so nothing was saved.");
      // Called off: checked last, with no wait before the save, so a cancelled check never saves (M1).
      if (opts.signal?.aborted) throw new ApiError("ABORTED", "Stopped. Nothing was saved.");
      const pairing: Pairing = { ...now, port };
      await storage.set({ [KEY]: pairing });
      return { pairing, projects };
    },

    captureBrowser(body: BrowserCaptureBody): Promise<BrowserCaptureResult> {
      return authed<BrowserCaptureResult>("/capture/browser", "POST", body);
    },

    /** Profile as I scroll: the noted links, queued for the downloader. */
    queueLinks(projectId: string, urls: string[]): Promise<{ queueId: string }> {
      // R111: the extension-scoped route (the extension token cannot use POST /projects/:id/capture).
      return authed<{ queueId: string }>("/capture/browser/links", "POST", { projectId, urls });
    },

    /**
     * Find and acquire, the browser's fallback (R348 f 1): the works waiting for a PDF from this browser. A POST with
     * exactly `{}` (Chrome sends no Origin on a GET, and the route needs the paired Origin). The answer as it came:
     * find.ts's parseWaiting reads it.
     */
    findWaiting(opts: { signal?: AbortSignal } = {}): Promise<unknown> {
      return authed<unknown>("/find/browser/waiting", "POST", {}, opts.signal ? { signal: opts.signal } : {});
    },

    /**
     * R348 f 2: ONE POST of the PDF for the waiting work — the ticket in the path (as the service's route has it), the
     * token in the Authorization header only, `Content-Type: application/pdf` (the only type the route takes), the
     * tab's address in `x-ao-page`, the bytes as the body. The 200 answer as it came (find.ts's parseFileAnswer reads it).
     */
    sendFindPdf(ticket: string, page: string, body: Blob, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
      if (!/^[0-9a-f]{32}$/.test(ticket)) return Promise.reject(new ApiError("BAD_PATH", "Internal error: bad request path."));
      return authed<unknown>(`/find/browser/file/${ticket}`, "POST", undefined, { ...(opts.signal ? { signal: opts.signal } : {}), file: { body, type: "application/pdf", headers: { "x-ao-page": page } } });
    },
  };
}

export type Api = ReturnType<typeof createApi>;
