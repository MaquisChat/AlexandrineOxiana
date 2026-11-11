/**
 * A stand-in for the library service's extension routes. It enforces the rules the real service has
 * after the R111 integration (apps/library-service/src/server.ts + auth.ts, R96/R111):
 *  - Host must be 127.0.0.1:<port>; no query strings;
 *  - the extension token only in `Authorization: Bearer`, valid for GET /projects, POST /capture/browser
 *    and POST /capture/browser/links;
 *  - Origin: every request carries the paired chrome-extension:// origin (pairing: any extension
 *    origin), except GET /projects, where Chrome sends none for a host-permitted request — there a
 *    missing Origin is accepted, a present but different one is not;
 *  - POST bodies are JSON (content-type application/json) of at most 32 MB (bytes).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

export interface StubService {
  port: number;
  code: string;
  requests: Received[];
  captures: Received[];
  linkLists: Received[];
  refusals: string[];
  /** Paths of requests that came without an Origin header. */
  noOriginGets: string[];
  token(): string | undefined;
  origin(): string | undefined;
  close(): Promise<void>;
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
export const STUB_BODY_LIMIT = 32 * 1024 * 1024;

export async function startStubService(): Promise<StubService> {
  const code = "042917";
  let token: string | undefined;
  let pairedOrigin: string | undefined;
  const requests: Received[] = [];
  const captures: Received[] = [];
  const linkLists: Received[] = [];
  const refusals: string[] = [];
  const noOriginGets: string[] = [];
  let port = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown, origin?: string) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    if (origin) res.setHeader("access-control-allow-origin", origin).setHeader("vary", "Origin");
    res.end(JSON.stringify(body));
  };
  const refuse = (res: http.ServerResponse, status: number, code: string, why: string) => {
    refusals.push(`${code}: ${why}`);
    send(res, status, { error: { code, message: why } });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes <= STUB_BODY_LIMIT) chunks.push(c);
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      const route = `${req.method} ${path}`;
      const origin = req.headers.origin;
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });

      if (req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 403, "FORBIDDEN", `host ${req.headers.host}`);
      if ((req.url ?? "").includes("?")) return refuse(res, 401, "UNAUTHORIZED", "query strings are refused here");
      if (bytes > STUB_BODY_LIMIT) return refuse(res, 413, "PAYLOAD_TOO_LARGE", `${bytes} bytes`);
      if (origin === undefined) {
        if (route !== "GET /projects") return refuse(res, 403, "FORBIDDEN", `no Origin on ${route}`);
      } else if (!EXTENSION_ORIGIN.test(origin)) return refuse(res, 403, "FORBIDDEN", `origin ${origin}`);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("access-control-allow-origin", origin!);
        res.setHeader("access-control-allow-methods", "GET, POST");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        return res.end();
      }
      let body: unknown;
      if (req.method === "POST") {
        if (!/^application\/json(\s*;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "UNSUPPORTED_MEDIA_TYPE", `content-type ${req.headers["content-type"]}`);
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return refuse(res, 400, "BAD_REQUEST", "body is not JSON");
        }
      }
      const r: Received = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, ...(body !== undefined ? { body } : {}) };
      requests[requests.length - 1] = r;

      if (route === "POST /extension/pair/confirm") {
        if ((body as { code?: unknown })?.code !== code) return refuse(res, 401, "UNAUTHORIZED", "That code is not valid. Ask the desktop app for a new one.");
        token = randomBytes(32).toString("base64url");
        pairedOrigin = origin;
        return send(res, 200, { token }, origin);
      }

      if (origin !== undefined && origin !== pairedOrigin) return refuse(res, 403, "FORBIDDEN", "not the paired extension");
      if (origin === undefined) noOriginGets.push(path);
      if (!token || req.headers.authorization !== `Bearer ${token}`) return refuse(res, 401, "UNAUTHORIZED", "A valid token is needed.");

      if (route === "GET /projects") {
        return send(
          res,
          200,
          {
            projects: [
              { id: "p-closed", name: "Interviews (no browser capture)", captureMethods: ["manual_upload"] },
              { id: "p-estuary", name: "Estuary study", captureMethods: ["browser_capture"] },
              { id: "p-profiles", name: "Profiles study", captureMethods: ["browser_capture", "downloader"] },
            ],
          },
          origin,
        );
      }
      if (route === "POST /capture/browser") {
        captures.push(r);
        return send(res, 200, { sourceId: "src-0001", status: "created" }, origin);
      }
      if (route === "POST /capture/browser/links") {
        const b = body as { projectId?: unknown; urls?: unknown };
        const okUrls = Array.isArray(b?.urls) && b.urls.length >= 1 && b.urls.length <= 500 && b.urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u) && u.length <= 2048);
        if (typeof b?.projectId !== "string" || !okUrls) return refuse(res, 400, "BAD_REQUEST", "projectId and 1–500 urls are needed");
        linkLists.push(r);
        return send(res, 200, { queueId: `q-${linkLists.length}` }, origin);
      }
      // Like the real service: the extension token reaches nothing else.
      return refuse(res, 403, "FORBIDDEN", "The browser extension cannot use this.");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    code,
    requests,
    captures,
    linkLists,
    refusals,
    noOriginGets,
    token: () => token,
    origin: () => pairedOrigin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
