/**
 * FR-331 (Task 57's M10 a): the routes the browser extension must not reach carry their own "desktop app only"
 * check, behind the service's global one (server.ts, step 4: the extension's token reaches only EXTENSION_ROUTES).
 * Both are tested here, route by route:
 *  - the ROUTE's own check: each route module registered on a bare Fastify instance with NO global check, every
 *    request arriving as the extension (`req.caller = "extension"`, as the global hook would set it for one of its own
 *    routes): the route refuses with its own sentence (403), before it touches anything (the context it is given
 *    answers everything and holds nothing);
 *  - the global check, as built: the real service with a paired extension's token and origin refuses each route with
 *    the global sentence, so the route's own check is never reached.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceDeps } from "@ao/library";
import { errorBody, toApiError } from "./errors.js";
import { registerMedia } from "./media.js";
import { registerAnnotations } from "./routes/annotations.js";
import { registerAppearance } from "./routes/appearance.js";
import { registerCapture } from "./routes/capture.js";
import { registerDocuments } from "./routes/documents.js";
import { registerFind } from "./routes/find.js";
import { registerImport } from "./routes/import.js";
import { registerSearchSettings } from "./routes/search-settings.js";
import { registerTools } from "./routes/tools.js";
import type { Ctx } from "./routes/util.js";
import { registerYourLibrary } from "./routes/your-library.js";
import { registerZoteroSync } from "./routes/zotero-sync.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GLOBAL = "The browser extension cannot use this.";
const DESKTOP = "Only the desktop app can do this.";
const FIND = "Find and acquire is used from the desktop app.";
const LIBRARY = "Your library is set from the desktop app.";
const SOURCES = "Search sources are set from the desktop app.";
const TOOLS = "The tools are managed from the desktop app.";

/** Every route with a "desktop app only" check of its own, and the sentence it refuses the extension with. */
const UI_ONLY: ReadonlyArray<readonly [method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, sentence: string]> = [
  ["POST", "/extension/pair", "Pairing is started from the desktop app."],
  ["GET", "/extension/pair/status", "A pairing code's status is shown in the desktop app only."],
  ["GET", "/extension/pair/status/:codeId", "A pairing code's status is shown in the desktop app only."],
  ["GET", "/import/zotero-data-folders", DESKTOP],
  ["POST", "/media-tickets/revoke", DESKTOP],
  ["GET", "/projects/:id/sources/:sid/annotations", DESKTOP],
  ["POST", "/projects/:id/sources/:sid/annotations", DESKTOP],
  ["DELETE", "/projects/:id/sources/:sid/annotations/:anid", DESKTOP],
  ["PATCH", "/projects/:id/sources/:sid/annotations/:anid", DESKTOP],
  ["GET", "/projects/:id/sources/:sid/assets/:aid/content", DESKTOP],
  ["GET", "/projects/:id/sources/:sid/assets/:aid/document", DESKTOP],
  ["POST", "/projects/:id/sources/:sid/assets/:aid/media-ticket", DESKTOP],
  ["DELETE", "/secrets/zotero-api-key", DESKTOP],
  ["GET", "/secrets/zotero-api-key", DESKTOP],
  ["PUT", "/secrets/zotero-api-key", DESKTOP],
  ["GET", "/settings/fonts", DESKTOP],
  ["POST", "/settings/fonts", DESKTOP],
  ["DELETE", "/settings/fonts/:id", DESKTOP],
  ["GET", "/settings/fonts/:id", DESKTOP],
  ["POST", "/settings/notices/dismiss", DESKTOP],
  ["POST", "/settings/reset", DESKTOP],
  ["POST", "/zotero/key-check", DESKTOP],
  ["GET", "/zotero/sync", DESKTOP],
  ["GET", "/zotero/sync/history", DESKTOP],
  ["POST", "/zotero/sync/run", DESKTOP],
  ["PUT", "/zotero/sync/settings", DESKTOP],
  ["POST", "/zotero/sync/stop", DESKTOP],
  ["GET", "/find/screen", FIND],
  ["PUT", "/find/screen", FIND],
  ["GET", "/projects/:id/find", FIND],
  ["POST", "/projects/:id/find", FIND],
  ["DELETE", "/projects/:id/find/:eid", FIND],
  ["POST", "/projects/:id/find/:eid/add-here", FIND],
  ["POST", "/projects/:id/find/:eid/author", FIND],
  ["POST", "/projects/:id/find/:eid/choose", FIND],
  ["POST", "/projects/:id/find/:eid/duplicate", FIND],
  ["GET", "/projects/:id/find/:eid/elsewhere", FIND],
  ["GET", "/projects/:id/find/:eid/options", FIND],
  ["POST", "/projects/:id/find/:eid/person", FIND],
  ["POST", "/projects/:id/find/:eid/retry", FIND],
  ["POST", "/projects/:id/find/:eid/works", FIND],
  ["POST", "/projects/:id/find/:eid/browser/start", LIBRARY],
  ["POST", "/projects/:id/find/:eid/library/cancel", LIBRARY],
  ["POST", "/projects/:id/find/:eid/library/start", LIBRARY],
  ["POST", "/projects/:id/find/:eid/link/start", LIBRARY],
  ["GET", "/settings/your-library", LIBRARY],
  ["PUT", "/settings/your-library", LIBRARY],
  ["POST", "/settings/your-library/derive", LIBRARY],
  ["POST", "/settings/your-library/test", LIBRARY],
  ["DELETE", "/secrets/elicit-api-key", SOURCES],
  ["GET", "/secrets/elicit-api-key", SOURCES],
  ["PUT", "/secrets/elicit-api-key", SOURCES],
  ["DELETE", "/secrets/openalex-api-key", SOURCES],
  ["GET", "/secrets/openalex-api-key", SOURCES],
  ["PUT", "/secrets/openalex-api-key", SOURCES],
  ["GET", "/settings/search-sources", SOURCES],
  ["PUT", "/settings/search-sources", SOURCES],
  ["POST", "/settings/search-sources/:group/:id/test", SOURCES],
  ["GET", "/tools", TOOLS],
  ["POST", "/tools/:toolId/:action", TOOLS],
  ["GET", "/tools/jobs/:jobId", TOOLS],
  ["POST", "/tools/jobs/:jobId/cancel", TOOLS],
];

/** The route's address with every parameter filled in (a well-formed id: nothing is ever looked up). */
const addressOf = (url: string) => url.replace(/:[A-Za-z]+/gu, "01234567-89ab-7def-8123-456789abcdef");
const bodyOf = (method: string) => (method === "GET" || method === "DELETE" ? {} : { payload: "{}", headers: { "content-type": "application/json" } });

/**
 * A context that answers every property, call and value with itself and holds nothing: the route modules register with
 * it, and a route that refuses before touching its context answers exactly as it would in the service. `touched` lists
 * what a request reached (nothing, for a refused one).
 */
function inertContext(touched: string[], armed: { on: boolean }): Ctx {
  const node = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, k) => {
        if (k === "then") return undefined;
        if (armed.on) touched.push(`${path}.${String(k)}`);
        return node(`${path}.${String(k)}`);
      },
      apply: () => node(`${path}()`),
    });
  return node("ctx") as Ctx;
}

describe("FR-331: the browser extension and the routes for the desktop app only", () => {
  const touched: string[] = [];
  const armed = { on: false };
  let bare: FastifyInstance;
  let tmp: string;
  let svc: LibraryService;
  let extToken: string;

  beforeAll(async () => {
    // The route modules alone: no global check, every request arriving as the extension.
    bare = Fastify();
    bare.addHook("onRequest", async (req) => {
      req.caller = "extension";
      req.extensionId = "ext-1";
    });
    bare.setErrorHandler((err, _req, reply) => {
      const e = toApiError(err);
      void reply.status(e.status).send(errorBody(e, []));
    });
    const ctx = inertContext(touched, armed);
    for (const register of [registerAnnotations, registerCapture, registerImport, registerAppearance, registerTools, registerMedia, registerDocuments, registerFind, registerZoteroSync, registerSearchSettings, registerYourLibrary]) {
      register(bare, ctx);
    }
    await bare.ready();
    armed.on = true;

    // The service as built, with a paired extension.
    tmp = await mkdtemp(join(tmpdir(), "ao-ui-only-"));
    svc = await createService({ token: TOKEN, deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 }, worker: null });
    const code = await svc.app.inject({ method: "POST", url: "/extension/pair", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(code.statusCode, code.body).toBe(200);
    const confirmed = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json().code }) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    extToken = confirmed.json().token as string;
  });

  afterAll(async () => {
    await bare?.close();
    await svc?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  describe("the route's own check, with no global check in front of it", () => {
    for (const [method, url, sentence] of UI_ONLY) {
      it(`${method} ${url}: refused by the route itself, before it touches anything`, async () => {
        touched.length = 0;
        // From the desktop shell's own origin, so that only the caller can be what a route refuses.
        const res = await bare.inject({ method, url: addressOf(url), ...bodyOf(method), headers: { ...bodyOf(method).headers, origin: "tauri://localhost" } });
        expect([res.statusCode, res.json()]).toEqual([403, { error: { code: "FORBIDDEN", message: sentence } }]);
        expect(touched).toEqual([]);
      });
    }
  });

  describe("the global check, as built: the extension's token never reaches the route", () => {
    for (const [method, url] of UI_ONLY) {
      it(`${method} ${url}: refused by the service's global check`, async () => {
        const res = await svc.app.inject({ method, url: addressOf(url), ...bodyOf(method), headers: { ...bodyOf(method).headers, authorization: `Bearer ${extToken}`, origin: EXT } });
        expect([res.statusCode, res.json()]).toEqual([403, { error: { code: "FORBIDDEN", message: GLOBAL } }]);
      });
    }
  });
});
