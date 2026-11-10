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
import { appConfigDir, deviceDeps, type Deps } from "@ao/library";
import { Pairing, SHELL_ORIGINS, bearerOf, hostAllowed, isExtensionOrigin, queryCarriesToken, sameSecret, type PairingOptions } from "./auth.js";
import { ApiError, errorBody, toApiError } from "./errors.js";
import { ServiceState, defaultWorkerProvider, type WorkerProvider } from "./state.js";
import { registerAppearance } from "./routes/appearance.js";
import { registerAudit } from "./routes/audit.js";
import { registerCapture } from "./routes/capture.js";
import { registerCitations } from "./routes/citations.js";
import { registerFieldwork } from "./routes/fieldwork.js";
import { registerGovernance } from "./routes/governance.js";
import { registerImport } from "./routes/import.js";
import { registerJobs } from "./routes/jobs.js";
import { registerLibraries } from "./routes/libraries.js";
import { registerProjects } from "./routes/projects.js";
import { registerReview } from "./routes/review.js";
import { registerSources } from "./routes/sources.js";

export type { ServiceWorker, WorkerProvider } from "./state.js";

/** Default JSON body limit (R96). */
export const BODY_LIMIT = 1024 * 1024;

export interface ServiceOptions {
  /** The UI token (from AO_SERVICE_TOKEN, see readServiceToken). */
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
  }
}

/** What the extension token may reach (R96). */
const EXTENSION_ROUTES = new Set(["POST /capture/browser", "GET /projects"]);
/** Reached without a token: the pairing code is the credential (rate-limited, 5 attempts). */
const OPEN_ROUTES = new Set(["POST /extension/pair/confirm"]);

/** Log redaction (R96): credentials never reach the log, whatever object carries them. */
const REDACT = ["authorization", "secret", "passphrase", "recoveryCode", "apiKey", "token", "code", "cookie"].flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `req.headers.${k}`]);

export async function createService(opts: ServiceOptions): Promise<LibraryService> {
  const deps = opts.deps ?? deviceDeps(appConfigDir());
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    // Never echo request bodies or query strings into the log.
    logger: {
      level: opts.logLevel ?? "info",
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: { paths: REDACT, censor: "[redacted]" },
      serializers: {
        req: (req: { method?: string; url?: string }) => ({ method: req.method, url: (req.url ?? "").split("?")[0] }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    },
    // A proxy is never in front of this service: the socket address is the client.
    trustProxy: false,
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
    log: { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m) },
  });
  const pairing = new Pairing(deps.appConfigDir, opts.pairing);
  await pairing.load();
  let port: number | undefined;

  const fail = (reply: FastifyReply, e: ApiError) => reply.status(e.status).send(errorBody(e, state.roots));

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. DNS rebinding: only our own host names, on our port.
    if (!hostAllowed(req.headers.host, port)) return fail(reply, new ApiError(403, "FORBIDDEN", "This host name is not allowed."));
    // 2. Origin: the desktop shell, or a paired extension (an unpaired one only to confirm pairing).
    const origin = req.headers.origin;
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (origin !== undefined) {
      const ok = SHELL_ORIGINS.has(origin) || pairing.isPairedOrigin(origin) || (OPEN_ROUTES.has(route) && isExtensionOrigin(origin));
      if (!ok) return fail(reply, new ApiError(403, "FORBIDDEN", "Requests from this origin are not allowed."));
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      if (req.method === "OPTIONS") {
        return reply
          .status(204)
          .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
          .header("Access-Control-Allow-Headers", "authorization, content-type")
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
    const ext = pairing.extensionFor(token);
    if (!ext) return fail(reply, new ApiError(401, "UNAUTHORIZED", "A valid token is needed."));
    // 4. The extension token: its own routes only, from its own origin.
    if (!EXTENSION_ROUTES.has(route)) return fail(reply, new ApiError(403, "FORBIDDEN", "The browser extension cannot use this."));
    if (origin !== ext.origin) return fail(reply, new ApiError(403, "FORBIDDEN", "This token belongs to another extension."));
    req.caller = "extension";
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = toApiError(err);
    if (e.status >= 500) req.log.error({ err: state.describe(err) }, "request failed");
    void fail(reply, e);
  });
  app.setNotFoundHandler((_req, reply) => fail(reply, new ApiError(404, "NOT_FOUND", "There is no such route.")));

  const ctx = { state, pairing, token: opts.token };
  registerLibraries(app, ctx);
  registerProjects(app, ctx);
  registerSources(app, ctx);
  registerCapture(app, ctx);
  registerImport(app, ctx);
  registerReview(app, ctx);
  registerGovernance(app, ctx);
  registerAudit(app, ctx);
  registerFieldwork(app, ctx);
  registerCitations(app, ctx);
  registerAppearance(app, ctx);
  registerJobs(app, ctx);

  let closing: Promise<void> | undefined;
  return {
    app,
    state,
    pairing,
    async listen(p = 0) {
      await app.listen({ host: "127.0.0.1", port: p });
      const addr = app.server.address();
      port = typeof addr === "object" && addr ? addr.port : p;
      return port;
    },
    close() {
      closing ??= (async () => {
        await state.shutdown();
        await app.close();
      })();
      return closing;
    },
  };
}

export type RouteContext = { state: ServiceState; pairing: Pairing; token: string };
