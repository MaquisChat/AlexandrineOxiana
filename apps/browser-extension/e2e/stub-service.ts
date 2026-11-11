/**
 * A stand-in for the library service's extension routes, enforcing the same rules the real one does
 * (apps/library-service/src/auth.ts, R96): Host 127.0.0.1:<port>, Origin a chrome-extension:// id
 * (the paired one after pairing), the token only in `Authorization: Bearer`, never in the URL, and
 * the extension token limited to GET /projects and POST /capture/browser.
 *
 * One difference, on purpose: Chrome sends no Origin header on a GET from an extension that holds
 * host permission for the address, so GET /projects arrives without one. The stub accepts a missing
 * Origin on GET (a present one must still be the paired extension); the real service currently
 * refuses it (auth.ts step 4: origin !== ext.origin). Reported to the controller with a proposed fix.
 * Every POST must carry the paired extension's Origin.
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
  refusals: string[];
  /** Paths of requests that came without an Origin header (GETs only). */
  noOriginGets: string[];
  token(): string | undefined;
  origin(): string | undefined;
  close(): Promise<void>;
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export async function startStubService(): Promise<StubService> {
  const code = "042917";
  let token: string | undefined;
  let pairedOrigin: string | undefined;
  const requests: Received[] = [];
  const captures: Received[] = [];
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
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return refuse(res, 400, "BAD_REQUEST", "body is not JSON");
      }
      const r: Received = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, ...(body !== undefined ? { body } : {}) };
      requests.push(r);
      const path = (req.url ?? "").split("?")[0];
      const origin = req.headers.origin;

      if (req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 403, "FORBIDDEN", `host ${req.headers.host}`);
      if ((req.url ?? "").includes("?")) return refuse(res, 401, "UNAUTHORIZED", "query strings are refused here");
      if (origin === undefined && req.method === "GET") {
        // Allowed only with the paired token (checked below).
      } else if (typeof origin !== "string" || !EXTENSION_ORIGIN.test(origin)) return refuse(res, 403, "FORBIDDEN", `origin ${origin}`);
      if (req.method === "OPTIONS" && origin) {
        res.statusCode = 204;
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-methods", "GET, POST");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        return res.end();
      }

      if (req.method === "POST" && path === "/extension/pair/confirm") {
        if ((body as { code?: unknown })?.code !== code) return refuse(res, 401, "UNAUTHORIZED", "That code is not valid. Ask the desktop app for a new one.");
        token = randomBytes(32).toString("base64url");
        pairedOrigin = origin;
        return send(res, 200, { token }, origin);
      }

      if (origin !== undefined && origin !== pairedOrigin) return refuse(res, 403, "FORBIDDEN", "not the paired extension");
      if (origin === undefined) noOriginGets.push(path ?? "");
      const auth = req.headers.authorization;
      if (!token || auth !== `Bearer ${token}`) return refuse(res, 401, "UNAUTHORIZED", "A valid token is needed.");

      if (req.method === "GET" && path === "/projects") {
        return send(
          res,
          200,
          {
            projects: [
              { id: "p-closed", name: "Interviews (no browser capture)", captureMethods: ["manual_upload"] },
              { id: "p-estuary", name: "Estuary study", captureMethods: ["browser_capture"] },
            ],
          },
          origin,
        );
      }
      if (req.method === "POST" && path === "/capture/browser") {
        captures.push(r);
        return send(res, 200, { sourceId: "src-0001", status: "created" }, origin);
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
