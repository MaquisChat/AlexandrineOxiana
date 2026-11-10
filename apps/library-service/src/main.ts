/**
 * Entry point of the local library service (spec 8.2). The desktop shell (Task 37) starts it as a
 * sidecar:
 *
 *   node --max-old-space-size=512 --import tsx apps/library-service/src/main.ts
 *
 * `--max-old-space-size=512` keeps bulk imports from growing the heap without bound (R64, R96);
 * the 10,000-item import runs in about 320 MB.
 *
 * Environment:
 *   AO_SERVICE_TOKEN  the UI token (≥ 32 random characters); read once, then removed from the
 *                     environment so the media worker and other children never see it. Removing it
 *                     from process.env does NOT remove it from /proc/<pid>/environ (Linux keeps the
 *                     environment the process started with): Task 37 will pass the token on stdin
 *                     instead (R98), and this variable stays for development and tests.
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
import { readServiceToken } from "./auth.js";
import { createService } from "./server.js";

/** Exceeds the worst-case graceful close (R99): SUSPEND_TIMEOUT_MS for imports plus closing the rest. */
export const FORCE_EXIT_MS = 90_000;

async function main(): Promise<void> {
  const token = readServiceToken(process.env);
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
  process.stderr.write(`The library service could not start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
