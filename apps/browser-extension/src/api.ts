/**
 * Talking to the library service on this computer (R96, R110):
 *  - only http://127.0.0.1:<port>, where <port> is the one the user typed from the desktop app (no
 *    port scanning);
 *  - pairing posts the 6-digit code to /extension/pair/confirm; the token it returns is kept in
 *    storage.local (never storage.sync) and removed by unpair;
 *  - every other request carries the token in the Authorization header only, never in a URL; JSON
 *    bodies; no cookies, no cache, and redirects refused (so the header cannot follow one elsewhere).
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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KEY = "pairing";
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,512}$/;

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

export interface ApiDeps {
  fetch: typeof fetch;
  storage: LocalStorageArea;
}

export function createApi({ fetch: doFetch, storage }: ApiDeps) {
  async function getPairing(): Promise<Pairing | undefined> {
    return asPairing((await storage.get(KEY))[KEY]);
  }

  async function call<T>(port: number, path: string, init: { method: "GET" | "POST"; body?: unknown; token?: string }): Promise<T> {
    if (!path.startsWith("/") || /[?#]/.test(path)) throw new ApiError("BAD_PATH", "Internal error: bad request path.");
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ApiError("UNREACHABLE", `The desktop app is not answering on port ${port}. Is it open?`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof err?.code === "string" ? err.code : `HTTP_${res.status}`;
      const message = typeof err?.message === "string" ? err.message : `The desktop app answered ${res.status}.`;
      throw new ApiError(code, message, res.status);
    }
    return data as T;
  }

  /** A call with the stored token; a token the service no longer accepts is forgotten. */
  async function authed<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const p = await getPairing();
    if (!p) throw new ApiError("NOT_PAIRED", "Pair the extension with the desktop app first.");
    try {
      return await call<T>(p.port, path, { method, token: p.token, ...(body !== undefined ? { body } : {}) });
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
      const r = await authed<{ projects?: unknown }>("/projects", "GET");
      if (!Array.isArray(r?.projects)) throw new ApiError("BAD_REPLY", "The desktop app's answer was not understood.");
      return r.projects
        .filter((p): p is ProjectChoice => typeof p?.id === "string" && typeof p?.name === "string")
        .map((p) => ({ id: p.id, name: p.name, captureMethods: Array.isArray(p.captureMethods) ? p.captureMethods.filter((m): m is string => typeof m === "string") : [] }));
    },

    captureBrowser(body: BrowserCaptureBody): Promise<BrowserCaptureResult> {
      return authed<BrowserCaptureResult>("/capture/browser", "POST", body);
    },

    /** Profile as I scroll: the noted links, queued for the downloader. */
    queueLinks(projectId: string, urls: string[]): Promise<{ queueId: string }> {
      return authed<{ queueId: string }>(`/projects/${encodeURIComponent(projectId)}/capture`, "POST", { urls });
    },
  };
}

export type Api = ReturnType<typeof createApi>;
