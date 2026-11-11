/**
 * Entry point of the local library service (spec 8.2). The desktop shell (Task 37) starts it as a
 * sidecar:
 *
 *   node --max-old-space-size=512 --import tsx apps/library-service/src/main.ts
 *
 * `--max-old-space-size=512` keeps bulk imports from growing the heap without bound (R64, R96);
 * the 10,000-item import runs in about 320 MB.
 *
 * The access token (the UI token) is written on standard input by whoever starts it, as one line
 * (R98; see startup-token.ts), for example:
 *
 *   printf '%s\n' "$TOKEN" | node --max-old-space-size=512 --import tsx apps/library-service/src/main.ts
 *
 * It is never taken from the environment or the command line: the service refuses to start if
 * AO_SERVICE_TOKEN is set, if it is given any argument, if standard input is a terminal (a typed
 * token would be echoed: pipe it in), if the token does not arrive within
 * TOKEN_STDIN_TIMEOUT_MS, or if it is not 32–512 characters from `A–Z a–z 0–9 . _ ~ + / = -`. After
 * the one line, standard input is no longer read but stays open (closing it does not stop the
 * service). The token is never printed: not in a log line, an error, or the ready line.
 *
 * Environment:
 *   AO_SERVICE_PORT   port on 127.0.0.1 (default 0: any free port)
 *   AO_LIBRARY        a library folder to open at start (optional)
 *   AO_CONFIG_DIR     the app settings folder (default: the platform's usual place)
 *   AO_NO_WORKER=1    run without the media worker (capture, transcription, proxies and OCR wait)
 *
 * Once listening it prints `AO_SERVICE_READY port=<n>` on stdout. On SIGTERM (or SIGINT) it refuses
 * new requests, pauses running imports (left `paused`, resumable), closes the library (releasing
 * its lock), stops watchers and the media worker, and exits 0. If that takes longer than
 * FORCE_EXIT_MS (longer than the worst-case close: an import reaching a safe point, 60 s, plus the
 * rest) it exits 1.
 */
import { openLibrary } from "@ao/library";
import { createService } from "./server.js";
import { readStartupToken, startupErrorMessage } from "./startup-token.js";

/** Exceeds the worst-case graceful close (R99): SUSPEND_TIMEOUT_MS for imports plus closing the rest. */
export const FORCE_EXIT_MS = 90_000;

/** The token once read, so that no start-up error message can carry it (it is replaced, R96/R98). */
let knownToken: string | undefined;

async function main(): Promise<void> {
  const token = await readStartupToken({ input: process.stdin, env: process.env, argv: process.argv, execArgv: process.execArgv });
  knownToken = token;
  const rawPort = process.env.AO_SERVICE_PORT ?? "0";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("AO_SERVICE_PORT must be a port number");
  const svc = await createService({ token, ...(process.env.AO_NO_WORKER === "1" ? { worker: null } : {}) });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    svc.app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), FORCE_EXIT_MS);
    force.unref();
    svc.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  if (process.env.AO_LIBRARY) {
    const lib = await openLibrary(process.env.AO_LIBRARY, svc.state.deps, { onLockLost: () => svc.state.publishState() });
    svc.state.roots.add(lib.root);
    await svc.state.adopt(lib);
  }
  const listening = await svc.listen(port);
  process.stdout.write(`AO_SERVICE_READY port=${listening}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`The library service could not start: ${startupErrorMessage(err, knownToken)}\n`);
  process.exit(1);
});
