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
 *   { printf '%s\n' "$TOKEN"; cat; } | node --max-old-space-size=512 --import tsx apps/library-service/src/main.ts
 *
 * It is never taken from the environment or the command line: the service refuses to start if
 * AO_SERVICE_TOKEN is set, if it is given any argument, if standard input is a terminal (a typed
 * token would be echoed: pipe it in), if the token does not arrive within
 * TOKEN_STDIN_TIMEOUT_MS, or if it is not 32–512 characters from `A–Z a–z 0–9 . _ ~ + / = -`. After
 * the one line, anything more on standard input is discarded — except a line that is exactly a
 * folder grant from the shell's folder chooser (R207; folder-grants.ts), which is kept in memory for
 * one use and never logged — and the END of standard input means
 * "shut down cleanly", exactly as SIGTERM does (R155): the launcher keeps its end open while it wants
 * the service, so a launcher that exits, crashes or is force-quit leaves no stray service. A plain
 * `printf ... | node ...` therefore stops the service again at once; keep the pipe open, e.g.
 * `{ printf '%s\n' "$TOKEN"; cat; } | node ...`. The token is never printed: not in a log line, an
 * error, or the ready line.
 *
 * Environment:
 *   AO_SERVICE_PORT   port on 127.0.0.1 (default 0: any port, which is the port used last time when
 *                     it is free, else any free port, remembered in the settings folder; R171,
 *                     port-memory.ts). Any other value is used exactly and not remembered.
 *   AO_LIBRARY        a library folder to open at start (optional; without it the library open
 *                     when the service last ran is reopened, or named as not found)
 *   AO_CONFIG_DIR     the app settings folder (default: the platform's usual place)
 *   AO_NO_WORKER=1    run without the media worker (capture, transcription, proxies and OCR wait)
 *
 * Test-only (honoured ONLY when NODE_ENV is exactly "test"; otherwise not looked at; Task Z11, R289 a):
 *   AO_SECRETS=memory     keys are kept in this process's memory only (a restart forgets them)
 *   AO_ZOTERO_API_ORIGIN  exactly http://127.0.0.1:<port>: a stand-in for Zotero, the API and the only file origin
 *   AO_ZOTERO_TICK_MS     100..60000: the automatic sync scheduler's tick
 * In test mode a value not in that exact form refuses the start, naming the variable.
 *
 * Once listening it prints `AO_SERVICE_READY port=<n>` on stdout. On SIGTERM (or SIGINT) it refuses
 * new requests, pauses running imports (left `paused`, resumable), closes the library (releasing
 * its lock), stops watchers and the media worker, and exits 0. If that takes longer than
 * FORCE_EXIT_MS (longer than the worst-case close: an import reaching a safe point, 60 s, plus the
 * rest) it exits 1. The end of standard input starts the same shutdown.
 */
import { openLibrary, useSecretsFromEnv, useZoteroApiOriginFromEnv, zoteroTickMsFromEnv } from "@ao/library";
import { listenOnRememberedPort } from "./port-memory.js";
import { createService } from "./server.js";
import { FolderGrants, grantLineHandler } from "./folder-grants.js";
import { onInputLines, readStartupToken, startupErrorMessage } from "./startup-token.js";

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
  // The test-only switches (Task Z11, R289 a), read here once: honoured only when NODE_ENV is exactly "test"; a
  // value not in its exact form refuses the start with a sentence naming the variable.
  const zoteroTickMs = zoteroTickMsFromEnv(process.env);
  useSecretsFromEnv(process.env);
  useZoteroApiOriginFromEnv(process.env);
  const folderGrants = new FolderGrants();
  const svc = await createService({ token, folderGrants, ...(process.env.AO_NO_WORKER === "1" ? { worker: null } : {}), ...(zoteroTickMs !== undefined ? { zoteroTickMs } : {}) });

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
  // R155: the launcher's end of standard input is gone (closed, crashed, force-quit): shut down.
  // R207: a line that is exactly a folder grant is kept; every other line is dropped unread.
  onInputLines(process.stdin, grantLineHandler(folderGrants), () => stop("end of standard input"));

  if (process.env.AO_LIBRARY) {
    const lib = await openLibrary(process.env.AO_LIBRARY, svc.state.deps, { onLockLost: () => svc.state.publishState() });
    svc.state.roots.add(lib.root);
    await svc.state.adopt(lib);
  } else {
    // Not awaited: GET /libraries waits for it (D5).
    void svc.state.reopenLast();
  }
  // Any port (0, the shell's request): the port used last time when it is free (R171, port-memory.ts).
  const listening = await listenOnRememberedPort({
    requested: port,
    configDir: svc.state.deps.appConfigDir,
    listen: (p) => svc.listen(p),
    warn: (m) => svc.app.log.warn(m),
  });
  process.stdout.write(`AO_SERVICE_READY port=${listening}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`The library service could not start: ${startupErrorMessage(err, knownToken)}\n`);
  process.exit(1);
});
