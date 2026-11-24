/**
 * The test run's network guard (FR-748, R544). TEST CODE ONLY: a Vitest `setupFiles` entry of the library's, the
 * service's, the command line's and the browser extension's test runs (each package's vitest.config.ts).
 *
 * No unit test may ask a public service over the internet: a test whose project allows metadata lookups once asked
 * OpenAlex for real, met "too many requests", waited a minute and failed one run in three (R541).
 *
 *  - It makes undici's process-wide global dispatcher one that REFUSES every request to a host that is not this
 *    machine, before anything leaves, with an error that names the host and says what to do; requests to 127.0.0.1
 *    (and the rest of 127.0.0.0/8), `localhost` and ::1 go through as before (many tests start real local servers).
 *  - undici keeps the global dispatcher on `globalThis` under `Symbol.for("undici.globalDispatcher.2")`, so every
 *    copy of undici in the process reads the one set here — the library's (the lookup client's `request()` without a
 *    dispatcher, `find/fetch-file.ts`), which is the copy the service and the command line load too. undici also sets
 *    the older `Symbol.for("undici.globalDispatcher.1")` to a wrapper of it, which is what Node's own `fetch` reads:
 *    so the built-in `fetch` is guarded by the same dispatcher (net-guard.test.ts proves both).
 *  - A refused host is also recorded, and the test during which it happened FAILS after its own afterEach hooks —
 *    the lookup client turns every network error into "could not be reached", so the error alone could go unseen.
 *  - A test that installs its own global dispatcher (a MockAgent, a FakeZotero) and does not put the previous one
 *    back fails too, and the guard is put back, so no later test in the file runs unguarded.
 *
 * Imported outside a Vitest run (no `VITEST` in the environment) it does nothing.
 *
 * What it does not cover: a separate process a test starts (the command line spawned by apps/cli tests, the media
 * worker) — those keep off the network by their projects' rules or recorded answers; and requests made with a
 * dispatcher of the code's own that reaches the network (none in the product: the lookup client and the Zotero client
 * take one only from tests).
 */
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

export interface NetGuard {
  /** The guard, as installed as the global dispatcher. */
  dispatcher: Dispatcher;
  /** The hosts refused since the last check (a test's end), in order. */
  refused: string[];
  /** The global dispatcher when the current test started (after the file's beforeAll hooks). */
  atStart?: Dispatcher;
}

const KEY = Symbol.for("ao.test.netGuard");
const holder = globalThis as { [KEY]?: NetGuard };

/** The guard of this test run, or undefined outside one. */
export function netGuard(): NetGuard | undefined {
  return holder[KEY];
}

/** Whether a host name is this machine: 127.0.0.0/8, ::1, `localhost` and names under `.localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  return v4 !== null && v4[1] === "127" && v4.slice(2).every((p) => Number(p) <= 255);
}

/** The guard's error, naming the host and what to do. */
export function guardRefusal(host: string): string {
  return (
    `The test run's network guard (FR-748): this test made a real request to ${host}; ` +
    "give its project `metadata_lookup: []`, recorded answers (AO_LOOKUP_FIXTURES), or its own MockAgent."
  );
}

function hostOf(origin: unknown): string {
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return String(origin);
  }
}

/** Hands back (and forgets) the hosts refused so far: for the guard's own test. */
export function takeRefusedHosts(): string[] {
  const g = netGuard();
  if (!g) return [];
  return g.refused.splice(0);
}

/** Before each test: notes the global dispatcher the test starts with. */
export function beforeTest(): void {
  const g = netGuard();
  if (g) g.atStart = getGlobalDispatcher();
}

/** After each test (after the file's own afterEach hooks): fails a test that was refused or left its dispatcher. */
export function afterTest(): void {
  const g = netGuard();
  if (!g) return;
  const problems: string[] = [];
  const refused = [...new Set(takeRefusedHosts())];
  for (const host of refused) problems.push(guardRefusal(host));
  if (g.atStart !== undefined && getGlobalDispatcher() !== g.atStart) {
    setGlobalDispatcher(g.atStart);
    problems.push("This test left its own global dispatcher installed; it must put back the one it found (getGlobalDispatcher()) when it ends.");
  }
  g.atStart = undefined;
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** After the file: the guard is the global dispatcher again, and nothing refused is left unreported. */
export function afterFile(): void {
  const g = netGuard();
  if (!g) return;
  const problems = [...new Set(takeRefusedHosts())].map(guardRefusal);
  if (getGlobalDispatcher() !== g.dispatcher) {
    setGlobalDispatcher(g.dispatcher);
    problems.push("This test file left its own global dispatcher installed; it must put back the one it found when it ends.");
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

function install(): NetGuard {
  const guard: NetGuard = { dispatcher: undefined as unknown as Dispatcher, refused: [] };
  guard.dispatcher = new Agent().compose(
    (dispatch: Dispatcher["dispatch"]) => (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
      const host = hostOf(opts.origin);
      if (isLoopbackHost(host)) return dispatch(opts, handler);
      guard.refused.push(host);
      throw new Error(guardRefusal(host));
    },
  );
  holder[KEY] = guard;
  setGlobalDispatcher(guard.dispatcher);
  return guard;
}

if (process.env.VITEST) {
  install();
  const { afterAll, afterEach, beforeEach } = await import("vitest");
  // Registered by a set-up file, before the test file's own hooks: so this afterEach runs after theirs (Vitest runs
  // after-hooks in reverse order) and sees the dispatcher they put back.
  beforeEach(beforeTest);
  afterEach(afterTest);
  afterAll(afterFile);
}
