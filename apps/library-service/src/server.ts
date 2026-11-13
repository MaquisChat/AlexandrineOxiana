/**
 * The local library service (spec 8.2, 2.1; Task 30): an HTTP/JSON API on 127.0.0.1 over
 * `@ao/library`, used by the desktop UI (UI token) and the browser extension (its own token).
 * Security rules (R96) live in the `onRequest` hook below and in auth.ts; errors are always
 * `{ error: { code, message, reason? } }` with absolute paths scrubbed (errors.ts).
 *
 * Request bodies are JSON, at most 1 MB, except: `POST /capture/browser` (32 MB: a full-page
 * screenshot and the page's HTML) and `POST /projects/:id/sources/:sid/transcripts` (10 MB: a
 * whole edited transcript).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { appConfigDir, deviceDeps, deviceNoticesIdle, type Deps, type openLibrary, type rebuildIndexIfNeeded } from "@ao/library";
import { Pairing, SHELL_ORIGINS, bearerOf, hostAllowed, isExtensionOrigin, queryCarriesToken, sameSecret, type PairingOptions } from "./auth.js";
import { ApiError, errorBody, toApiError } from "./errors.js";
import { ServiceState, defaultWorkerProvider, type WorkerProvider } from "./state.js";
import { registerAnnotations } from "./routes/annotations.js";
import { registerAppearance } from "./routes/appearance.js";
import { registerAudit } from "./routes/audit.js";
import { registerLibraryAudit } from "./routes/library-audit.js";
import { registerCapture } from "./routes/capture.js";
import { registerCitations } from "./routes/citations.js";
import { isDocumentPreflight, registerDocuments } from "./routes/documents.js";
import { registerFieldwork } from "./routes/fieldwork.js";
import { registerGovernance } from "./routes/governance.js";
import { registerImport } from "./routes/import.js";
import { registerJobs } from "./routes/jobs.js";
import { registerLibraries } from "./routes/libraries.js";
import { isMediaRoute, mediaRequestRefusal, registerMedia } from "./media.js";
import { registerProjects } from "./routes/projects.js";
import { registerReview } from "./routes/review.js";
import { registerSources } from "./routes/sources.js";
import { registerTools } from "./routes/tools.js";

export type { ServiceWorker, WorkerProvider } from "./state.js";

/** Default JSON body limit (R96). */
export const BODY_LIMIT = 1024 * 1024;

export interface ServiceOptions {
  /** The UI token (main.ts reads it from standard input, R98; see startup-token.ts). */
  token: string;
  deps?: Deps;
  /** Where log lines go (JSON, one per line); default stderr. */
  logStream?: NodeJS.WritableStream;
  logLevel?: string;
  /** The media worker; null: none (worker routes answer 503). Default: the real one. */
  worker?: WorkerProvider | null;
  /** Start the worker when a library opens (default true when a provider is given). */
  autoStartWorker?: boolean;
  now?: () => Date;
  backupCheckMs?: number;
  pairing?: PairingOptions;
  /** How long an import may take to reach a safe point when paused (test seam). */
  suspendTimeoutMs?: number;
  /** Opens a library (test seam). */
  openLibrary?: typeof openLibrary;
  /** How long a close waits for registered work before abandoning what can be (test seam; Task 62). */
  closeGraceMs?: number;
  /** Rebuilds the index when needed (test seam). */
  rebuildIndexIfNeeded?: typeof rebuildIndexIfNeeded;
  /** Test seam (a fake clock) for GET /libraries' wait at start. */
  startupTimer?: (fire: () => void, ms: number) => () => void;
  /** Runs right before a move starts copying (test seam). */
  beforeExecuteMove?: () => Promise<void>;
  /** Test seam: how long a watched folder's new file must stay unchanged (default the library's). */
  watchStabilityMs?: number;
  /** Largest picture the content route serves (default PICTURE_MAX_BYTES; test seam). */
  pictureMaxBytes?: number;
  /** Test seam: runs on the media route after the first slice is read, right before the response starts. */
  mediaBeforeSend?: () => Promise<void>;
  /** Largest PDF the document route serves (default READER_PDF_MAX_BYTES; test seam). */
  readerPdfMaxBytes?: number;
  /** Test seam: runs on the document route after the file is opened, right before its first read. */
  documentBeforeRead?: () => Promise<void>;
}

export interface LibraryService {
  app: FastifyInstance;
  state: ServiceState;
  pairing: Pairing;
  /** Listens on 127.0.0.1 (only); returns the port. */
  listen(port?: number): Promise<number>;
  /** Graceful shutdown: batches cancelled, library closed (lock released), worker and watchers stopped. */
  close(): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Who is calling: the desktop UI, or a paired browser extension. */
    caller?: "ui" | "extension";
    /** The paired extension calling (its pairing id), for its per-caller limits (R116). */
    extensionId?: string;
  }
}

/** What the extension token may reach (R96, R111). */
const EXTENSION_ROUTES = new Set(["POST /capture/browser", "POST /capture/browser/links", "GET /projects"]);
/**
 * Extension routes reached without an Origin header (R111): Chrome sends none on a GET to a host the
 * extension has permission for. Only this read; every POST needs the paired origin.
 */
const EXTENSION_NO_ORIGIN_ROUTES = new Set(["GET /projects"]);
/** Reached without a token: the pairing code is the credential (rate-limited, 5 attempts). */
const OPEN_ROUTES = new Set(["POST /extension/pair/confirm"]);

/** Log redaction (R96): credentials never reach the log, whatever object carries them. */
const REDACT = ["authorization", "secret", "passphrase", "recoveryCode", "apiKey", "token", "code", "cookie"].flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `req.headers.${k}`]);

export async function createService(opts: ServiceOptions): Promise<LibraryService> {
  const deps = opts.deps ?? deviceDeps(appConfigDir());
  // A notice raised while this device's identity was read (Task 68) is written before the first state.
  await deviceNoticesIdle();
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    // Never echo request bodies or query strings into the log.
    logger: {
      level: opts.logLevel ?? "info",
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: { paths: REDACT, censor: "[redacted]" },
      serializers: {
        // A media ticket is a credential carried in the path (R135): never logged.
        req: (req: { method?: string; url?: string }) => ({ method: req.method, url: logUrl(req.url ?? "") }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    },
    // A proxy is never in front of this service: the socket address is the client.
    trustProxy: false,
    // An address Fastify cannot route (bad percent-encoding, an overlong part): our error shape, and
    // never the address itself echoed back (it may carry a media ticket, R135).
    frameworkErrors: (_err, _req, reply) => {
      void (reply as FastifyReply).status(400).send(errorBody(new ApiError(400, "VALIDATION", "That address is not valid."), []));
    },
    // Open event streams must not keep a shutdown waiting.
    forceCloseConnections: true,
  });
  const workerProvider = opts.worker === undefined ? defaultWorkerProvider() : opts.worker;
  const state = new ServiceState({
    deps,
    worker: workerProvider,
    autoStartWorker: opts.autoStartWorker ?? opts.worker === undefined,
    now: opts.now ?? (() => new Date()),
    backupCheckMs: opts.backupCheckMs ?? 60 * 60_000,
    ...(opts.watchStabilityMs !== undefined ? { watchStabilityMs: opts.watchStabilityMs } : {}),
    ...(opts.suspendTimeoutMs !== undefined ? { suspendTimeoutMs: opts.suspendTimeoutMs } : {}),
    ...(opts.openLibrary ? { openLibrary: opts.openLibrary } : {}),
    ...(opts.closeGraceMs !== undefined ? { closeGraceMs: opts.closeGraceMs } : {}),
    ...(opts.rebuildIndexIfNeeded ? { rebuildIndexIfNeeded: opts.rebuildIndexIfNeeded } : {}),
    ...(opts.startupTimer ? { startupTimer: opts.startupTimer } : {}),
    log: { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) },
  });
  const pairing = new Pairing(deps.appConfigDir, opts.pairing);
  await pairing.load();
  let port: number | undefined;
  /** Set when shutdown starts: new requests are refused before the library is closed (R98). */
  let closingNow = false;
  /** Requests being answered (event streams excepted): shutdown waits for them (R101 M7). */
  let inFlight = 0;
  /** Of those, the ones that may change something (not GET/HEAD/OPTIONS): a move waits for them (R106 I1). */
  let inFlightMutating = 0;
  state.inFlightMutating = () => inFlightMutating;
  let idleWaiters: Array<() => void> = [];
  const requestEnded = () => {
    inFlight--;
    if (inFlight === 0) for (const w of idleWaiters.splice(0)) w();
  };

  const fail = (reply: FastifyReply, e: ApiError) => reply.status(e.status).send(errorBody(e, state.roots));
  /**
   * No pairing could be read since start, and the file still cannot be read: looked at again on each
   * such request, so it heals by itself (M5). Pairings already read keep being checked as usual.
   */
  const pairingsUnreadable = async () => pairing.notLoaded && (await pairing.checkFile());
  const PAIRINGS_UNREADABLE = new ApiError(503, "UNAVAILABLE", "This computer's list of paired browsers cannot be read right now. Your browser stays paired; try again in a moment, or open the desktop app's “Browser extension” page.");

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (closingNow) return fail(reply, new ApiError(503, "UNAVAILABLE", "The library service is shutting down."));
    // The media route itself, by its own configuration (R140 3): no path test decides who skips the token.
    const isMedia = isMediaRoute(req);
    // Event streams and media streams may stay open for hours: shutdown does not wait for them
    // (media streams end when their tickets are revoked, at the start of shutdown).
    if ((req.url.split("?")[0] ?? "") !== "/events" && !isMedia) {
      inFlight++;
      reply.raw.once("close", requestEnded);
    }
    // 1. DNS rebinding: only our own host names, on our port.
    if (!hostAllowed(req.headers.host, port)) return fail(reply, new ApiError(403, "FORBIDDEN", "This host name is not allowed."));
    // Media addresses (R135): the ticket in the path is the credential; their own Origin and
    // fetch-metadata rules (media.ts); no token is looked at.
    if (isMedia) {
      const refused = mediaRequestRefusal(req);
      if (refused) return fail(reply, refused);
      const o = req.headers.origin;
      if (o !== undefined) reply.header("Access-Control-Allow-Origin", o).header("Vary", "Origin");
      return;
    }
    // 2. Origin: the desktop shell, or a paired extension (an unpaired one only to confirm pairing).
    const origin = req.headers.origin;
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    // A preflight has no route of its own: it is judged by the route it asks for.
    const path = req.url.split("?")[0] ?? "";
    const preflightOpen = req.method === "OPTIONS" && OPEN_ROUTES.has(`POST ${path}`);
    if (origin !== undefined) {
      const allowed = () => SHELL_ORIGINS.has(origin) || pairing.isPairedOrigin(origin) || ((OPEN_ROUTES.has(route) || preflightOpen) && isExtensionOrigin(origin));
      let ok = allowed();
      // The pairings file cannot be read (Task 68 fix round 1, M5): an extension is told so, never
      // refused as unpaired, so that it keeps its token; nothing is let through. When the check finds
      // the file readable again, the origin is judged again on what was just read (round 2, Rm1).
      if (!ok && isExtensionOrigin(origin) && pairing.notLoaded) {
        if (await pairingsUnreadable()) return fail(reply, PAIRINGS_UNREADABLE);
        ok = allowed();
      }
      if (!ok) return fail(reply, new ApiError(403, "FORBIDDEN", "Requests from this origin are not allowed."));
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      if (req.method === "OPTIONS") {
        return reply
          .status(204)
          .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
          // `range` only for the shell's preflight of the document route (Task R5 review I1).
          .header("Access-Control-Allow-Headers", SHELL_ORIGINS.has(origin) && isDocumentPreflight(req) ? "authorization, content-type, range" : "authorization, content-type")
          .header("Access-Control-Max-Age", "600")
          .send();
      }
    }
    // 3. Credentials only in the Authorization header.
    if (queryCarriesToken(req.url)) return fail(reply, new ApiError(401, "UNAUTHORIZED", "Credentials are accepted only in the Authorization header."));
    if (OPEN_ROUTES.has(route)) {
      if (!origin || !isExtensionOrigin(origin)) return fail(reply, new ApiError(403, "FORBIDDEN", "Pairing is confirmed from the browser extension."));
      return;
    }
    const token = bearerOf(req.headers.authorization);
    if (!token) return fail(reply, new ApiError(401, "UNAUTHORIZED", "A valid token is needed."));
    if (sameSecret(token, opts.token)) {
      req.caller = "ui";
      return;
    }
    // While no pairing could be read (the file unreadable since start), EVERY request with a token
    // other than the desktop app's gets the same 503, never 401 (an extension forgets its token on a
    // 401): nothing is let through, and nothing tells a known token from an unknown one (M5).
    if (await pairingsUnreadable()) return fail(reply, PAIRINGS_UNREADABLE);
    const ext = pairing.extensionFor(token);
    if (!ext) return fail(reply, new ApiError(401, "UNAUTHORIZED", "A valid token is needed."));
    // 4. The extension token: its own routes only, from its own origin.
    if (!EXTENSION_ROUTES.has(route)) return fail(reply, new ApiError(403, "FORBIDDEN", "The browser extension cannot use this."));
    // From its own origin; with none at all only where Chrome omits it (R111). A different one: 403.
    const originOk = origin === ext.origin || (origin === undefined && EXTENSION_NO_ORIGIN_ROUTES.has(route));
    if (!originOk) return fail(reply, new ApiError(403, "FORBIDDEN", origin === undefined ? "Requests from the browser extension must carry its origin." : "This token belongs to another extension."));
    req.caller = "extension";
    req.extensionId = ext.id;
    // R171: the pairing keeps the port its browser reaches the service on (the app's pairing screen
    // compares it with the port now). Not awaited: the request never waits for it, and its answer
    // (a capture refused for a locked project included) is exactly what it would be without it. A
    // failed write is logged, never a reason to refuse.
    if (port !== undefined && ext.port !== port) {
      pairing.noteReachedOnCurrentPort(ext.id).catch(() => {
        app.log.warn("A paired browser's new port could not be saved; the browser works, but the app may keep saying its port changed.");
      });
    }
  });

  // During a library move nothing may change anything (R102 N2): every non-read request waits it out.
  // A change is counted as in flight only once its body has been read (R108), so a slow upload
  // never holds up a move: it is refused here if a move started meanwhile.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (state.moving) {
      if (`${req.method} ${req.routeOptions.url ?? ""}` === "POST /libraries/move") return fail(reply, new ApiError(409, "CONFLICT", "A move of this library is already running."));
      return fail(reply, new ApiError(503, "MOVE_IN_PROGRESS", "The library is being moved. Try again when the move has finished."));
    }
    inFlightMutating++;
    reply.raw.once("close", () => inFlightMutating--);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = toApiError(err);
    // A file response that failed before its first byte: its content headers (already copied to the
    // raw response when a stream was handed over) must not describe the error body (R140 5).
    if (!reply.raw.headersSent) {
      for (const h of ["content-type", "content-length", "content-range", "content-disposition", "content-security-policy", "accept-ranges"]) {
        reply.removeHeader(h);
        reply.raw.removeHeader(h);
      }
    }
    if (e.status >= 500) req.log.error({ err: state.describe(err) }, "request failed");
    void fail(reply, e);
  });
  app.setNotFoundHandler((_req, reply) => fail(reply, new ApiError(404, "NOT_FOUND", "There is no such route.")));

  const ctx = { state, pairing, token: opts.token, ...(opts.beforeExecuteMove ? { beforeExecuteMove: opts.beforeExecuteMove } : {}), ...(opts.pictureMaxBytes !== undefined ? { pictureMaxBytes: opts.pictureMaxBytes } : {}), ...(opts.mediaBeforeSend ? { mediaBeforeSend: opts.mediaBeforeSend } : {}), ...(opts.readerPdfMaxBytes !== undefined ? { readerPdfMaxBytes: opts.readerPdfMaxBytes } : {}), ...(opts.documentBeforeRead ? { documentBeforeRead: opts.documentBeforeRead } : {}) };
  registerLibraries(app, ctx);
  registerProjects(app, ctx);
  registerSources(app, ctx);
  registerAnnotations(app, ctx);
  registerCapture(app, ctx);
  registerImport(app, ctx);
  registerReview(app, ctx);
  registerGovernance(app, ctx);
  registerAudit(app, ctx);
  registerLibraryAudit(app, ctx);
  registerFieldwork(app, ctx);
  registerCitations(app, ctx);
  registerAppearance(app, ctx);
  registerJobs(app, ctx);
  registerTools(app, ctx);
  registerMedia(app, ctx);
  registerDocuments(app, ctx);

  let closing: Promise<void> | undefined;
  return {
    app,
    state,
    pairing,
    async listen(p = 0) {
      await app.listen({ host: "127.0.0.1", port: p });
      const addr = app.server.address();
      port = typeof addr === "object" && addr ? addr.port : p;
      pairing.setPort(port);
      return port;
    },
    close() {
      closingNow = true;
      state.shuttingDown = true;
      // Every media ticket ends as the service stops (R135 2), and with them their streams.
      state.media.revokeAll();
      closing ??= (async () => {
        // Requests are refused from here on; those already in progress finish (a library being
        // opened is then refused and released); then running work is paused and the library closed.
        if (inFlight > 0) await new Promise<void>((r) => {
          idleWaiters.push(r);
          setTimeout(r, 60_000).unref?.();
        });
        await state.shutdown();
        // A browser's port being recorded (R171) finishes its atomic write before the service exits.
        await pairing.idle();
        // A device-level notice being written (Task 68) is not lost at shutdown.
        await deviceNoticesIdle();
        await app.close();
      })();
      return closing;
    },
  };
}

export type RouteContext = { state: ServiceState; pairing: Pairing; token: string; beforeExecuteMove?: () => Promise<void>; pictureMaxBytes?: number; mediaBeforeSend?: () => Promise<void>; readerPdfMaxBytes?: number; documentBeforeRead?: () => Promise<void> };

/** A path with its percent-encoding undone (as far as it decodes), so a spelling cannot hide anything. */
function decodedPath(path: string): string {
  let cur = path;
  for (let i = 0; i < 4; i++) {
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

/** Whether a request path is (any spelling of) a media address: `/media/…`, decoded, any case, repeated slashes. */
export function isMediaPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path.startsWith("/media/") || /^\/+media\//i.test(decodedPath(path));
}

/**
 * The path of a request as logged (R135): no query string; any spelling of a media address
 * becomes `/media/[redacted]`; and anywhere else, a run of 40 or more ticket characters (no id of
 * ours is that long) is replaced too, so a ticket sent to another route is not logged either.
 */
export function logUrl(url: string): string {
  const path = url.split("?")[0] ?? "";
  if (isMediaPath(path)) return "/media/[redacted]";
  // An encoded separator could split a ticket into halves shorter than 40: then every run of 16 or
  // more ticket characters is replaced (review M4).
  const run = /%2f|%5c/i.test(path) ? /[A-Za-z0-9_-]{16,}/g : /[A-Za-z0-9_-]{40,}/g;
  return decodedPath(path).replace(run, "[redacted]");
}
