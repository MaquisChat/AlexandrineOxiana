/**
 * A stand-in for the library service's extension routes. It enforces the rules the real service has
 * after the R111 integration (apps/library-service/src/server.ts + auth.ts, R96/R111):
 *  - Host must be 127.0.0.1:<port>; no query strings;
 *  - the extension token only in `Authorization: Bearer`, valid for GET /projects, POST /capture/browser
 *    and POST /capture/browser/links;
 *  - Origin: every request carries the paired chrome-extension:// origin (pairing: any extension
 *    origin), except GET /projects, where Chrome sends none for a host-permitted request — there a
 *    missing Origin is accepted, a present but different one is not;
 *  - POST bodies are JSON (content-type application/json) of at most 32 MB (bytes);
 *  - Find and acquire (R348 f, as F20a built it): POST /find/browser/waiting takes exactly `{}` and answers
 *    `{ waiting }` (settable); POST /find/browser/file/<ticket> takes ONLY `application/pdf` (any other type gets the
 *    real service's framework answer, 400 "The request body is not valid JSON."), a ticket of the list (else 404
 *    browser-not-waiting), and records exactly the bytes and headers it received; it answers `fileAnswer` (settable),
 *    and a "held" ends the wait (the list is then empty).
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

export interface ReceivedFile {
  ticket: string;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
}

export interface StubService {
  port: number;
  /** The works waiting for a PDF from the browser, as the list answers them. */
  waiting: Array<{ ticket: string; label: string }>;
  /** The file route's 200 answer. */
  fileAnswer: { outcome: string; sentence: string };
  /** The bodies the list was asked with. */
  waitingAsks: unknown[];
  files: ReceivedFile[];
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
  const files: ReceivedFile[] = [];
  const waitingAsks: unknown[] = [];
  let port = 0;
  // Read and set through the returned object (stub.waiting = [...]).
  const self = { waiting: [] as Array<{ ticket: string; label: string }>, fileAnswer: { outcome: "held", sentence: "Sent. The file waits for your check in the app's review queue." } };

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
      // The file route: the PDF's bytes, never parsed as JSON (R348 f 2).
      const fileRoute = /^\/find\/browser\/file\/([^/]*)$/.exec(path);
      if (req.method === "POST" && fileRoute) {
        if (origin !== pairedOrigin) return refuse(res, 403, "FORBIDDEN", "not the paired extension");
        if (!token || req.headers.authorization !== `Bearer ${token}`) return refuse(res, 401, "UNAUTHORIZED", "A valid token is needed.");
        if (!/^application\/pdf(\s*;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(res, 400, "BAD_REQUEST", "The request body is not valid JSON.");
        const ticket = fileRoute[1] ?? "";
        if (!self.waiting.some((w) => w.ticket === ticket)) return refuse(res, 404, "NOT_FOUND", "That work is no longer waiting for a PDF from your browser. Nothing was kept.");
        files.push({ ticket, headers: req.headers, bytes: Buffer.concat(chunks) });
        if (self.fileAnswer.outcome === "held") self.waiting = self.waiting.filter((w) => w.ticket !== ticket);
        return send(res, 200, self.fileAnswer, origin);
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
      if (route === "POST /find/browser/waiting") {
        waitingAsks.push(body);
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length) return refuse(res, 400, "VALIDATION", "This request takes an empty object ({}) and nothing else.");
        return send(res, 200, { waiting: self.waiting }, origin);
      }
      if (route === "POST /capture/browser") {
        captures.push(r);
        return send(res, 200, { sourceId: "src-0001", status: "created" }, origin);
      }
      if (route === "POST /capture/browser/links") {
        const b = body as { projectId?: unknown; urls?: unknown };
        const okUrls = Array.isArray(b?.urls) && b.urls.length >= 1 && b.urls.length <= 500 && b.urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u) && u.length <= 2048);
        if (typeof b?.projectId !== "string" || !okUrls) return refuse(res, 400, "VALIDATION", "projectId and 1–500 urls are needed");
        linkLists.push(r);
        return send(res, 200, { queueId: `q-${linkLists.length}` }, origin);
      }
      // Like the real service: the extension token reaches nothing else.
      return refuse(res, 403, "FORBIDDEN", "The browser extension cannot use this.");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return Object.assign(self, {
    port,
    code,
    requests,
    captures,
    linkLists,
    refusals,
    noOriginGets,
    waitingAsks,
    files,
    token: () => token,
    origin: () => pairedOrigin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
}
