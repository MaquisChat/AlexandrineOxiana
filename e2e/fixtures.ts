/**
 * The app end-to-end fixture (R130): the real UI, the real library service and the real media worker.
 *
 * Per test, `app`:
 *  - makes a temporary folder under os.tmpdir() holding the app settings folder (`config/`), a place
 *    for libraries (`libraries/`) and the worker's tools and models folders, and removes it afterwards;
 *  - starts the service as its `start` script does (`node --max-old-space-size=512 --import tsx
 *    src/main.ts`), with a fresh random token written on its standard input as one line (R98: never
 *    in its environment or command line; standard input is left open), port 0, NODE_ENV=test,
 *    AO_CONFIG_DIR in the temporary folder, the recorded lookup answers (AO_LOOKUP_FIXTURES, honoured only in test mode) and the
 *    fake yt-dlp / gallery-dl named in AO_YTDLP_BIN / AO_GALLERYDL_BIN (the worker would otherwise
 *    run the real gallery-dl from its venv) and first on PATH; it waits for
 *    `AO_SERVICE_READY port=<n>`. The service starts the real media worker itself when a library
 *    opens (or a route needs it). If start-up fails, the child and anything it started are killed
 *    before the temporary folder is removed;
 *  - on teardown stops the service with SIGTERM (its graceful shutdown stops the worker), checks it
 *    exited cleanly, and fails the test if any process it started is still running;
 *  - `app.restart()` does the same mid-test and starts a new service on the same settings folder (a
 *    relaunch of the app), with a new port and token that the page is handed on its next load.
 *
 * Per test, `page`: the built UI (packages/ui/dist) under the desktop shell's own origin,
 * http://tauri.localhost, answered from disk by Playwright (pushState paths fall back to index.html),
 * so the page calls the service with `Origin: http://tauri.localhost` exactly as the shell's webview
 * will and R96 stands unchanged. The connection is handed over as the shell will hand it:
 * `window.__AO_SERVICE__ = { baseUrl, token }` set before any app code runs (serviceConnection.ts
 * takes it once and deletes it). Any other request the page makes is refused and fails the test, so
 * nothing reaches the network. The page is opened at "/" before the test starts.
 *
 * Why per test and not per worker: every scenario changes the app settings (registered libraries)
 * and the library it opens, and later scenarios move, lock and break libraries on purpose. A service
 * per test keeps each scenario independent of the order the tests run in, for about two seconds of
 * start-up each.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { test as base, expect, type Page } from "@playwright/test";
import { FAKE_TOOLS, LIBRARY_DIR, LOOKUP_FIXTURES, SERVICE_DIR, UI_DIST } from "./paths.js";

/** The desktop shell's origin (apps/library-service/src/auth.ts SHELL_ORIGINS): the page is served here. */
export const APP_ORIGIN = "http://tauri.localhost";

export interface ApiAnswer<T = unknown> {
  status: number;
  body: T;
}

export interface AppHarness {
  /** The temporary folder holding everything below; removed after the test. */
  root: string;
  /** The app settings folder the service uses (AO_CONFIG_DIR). */
  configDir: string;
  /** An empty folder for the test's libraries. */
  librariesDir: string;
  /** http://127.0.0.1:<port> (of the service running now: a restart changes it). */
  baseUrl: string;
  port: number;
  /** The UI token (for direct calls in test set-up; the page gets it through window.__AO_SERVICE__). A restart changes it. */
  token: string;
  /** A direct call to the service with the UI token, as test set-up (no Origin header: not a browser). */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiAnswer<T>>;
  /** Command lines of the processes the service has started and that are still running (e.g. the media worker). */
  childProcesses(): string[];
  /** The service's output so far (stdout and stderr), for failure messages. */
  log(): string;
  /**
   * Quits and relaunches the service as the desktop shell would: SIGTERM, checked to stop cleanly
   * with everything it started; then `whileStopped` (e.g. renaming the library folder outside the
   * app); then a new service on the same app settings folder, with a new port and token. The page
   * gets the new connection on its next load (navigate or reload after this); the old address is refused.
   */
  restart(whileStopped?: () => Promise<void>): Promise<void>;
  /** Called after each restart (the page fixture hands the new connection over with it). */
  onRestart(listener: () => Promise<void>): void;
}

/** Requests the page made to anywhere but the app's origin and the service: refused, and the test fails. */
type Blocked = string[];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** The file in packages/ui/dist that answers `pathname`: a file when there is one, else index.html for an app path. */
export function distFileFor(pathname: string): { file: string; status: 200 } | { status: 404 } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 404 };
  }
  const file = resolve(UI_DIST, `.${decoded}`);
  if (file !== UI_DIST.replace(/[\\/]$/, "") && !file.startsWith(UI_DIST.endsWith(sep) ? UI_DIST : UI_DIST + sep)) return { status: 404 };
  if (existsSync(file) && statSync(file).isFile()) return { file, status: 200 };
  // A pushState path of the app (/library, /import, /settings/appearance …) has no extension; a
  // missing asset (/assets/x.js) is a 404, not the page.
  if (extname(decoded) === "") return { file: join(UI_DIST, "index.html"), status: 200 };
  return { status: 404 };
}

/** The environment the service starts with: this one, minus app settings and proxies, plus the test's. */
function serviceEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u.startsWith("AO_") || u.startsWith("FAKE_") || u.startsWith("PLAYWRIGHT_") || u === "INIT_CWD" || u === "NODE_OPTIONS") delete env[k];
    // The developer's or runner's proxy is not the service's business. (This does not stop a direct
    // connection: the guards against the network are the fake tools and the recorded answers.)
    if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GLOBAL_AGENT_HTTP_PROXY"].includes(u)) delete env[k];
  }
  return {
    ...env,
    PATH: `${FAKE_TOOLS}${delimiter}${process.env.PATH ?? ""}`,
    // The worker runs gallery-dl as `python -m gallery_dl` (the real one, from its venv) unless
    // AO_GALLERYDL_BIN is set, and prefers AO_YTDLP_BIN over a managed binary or PATH
    // (services/media-worker/ao_worker/download.py): both name the fakes, so no capture reaches the network.
    AO_YTDLP_BIN: join(FAKE_TOOLS, "yt-dlp"),
    AO_GALLERYDL_BIN: join(FAKE_TOOLS, "gallery-dl"),
    ...extra,
  };
}

/** pid → [ppid, command] for every process (ps; Linux and macOS). */
function processTable(): Map<number, { ppid: number; command: string }> {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  const out = new Map<number, { ppid: number; command: string }>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! });
  }
  return out;
}

/** Every process descended from `pid`. */
function descendants(pid: number): Array<{ pid: number; command: string }> {
  const table = processTable();
  const out: Array<{ pid: number; command: string }> = [];
  const todo = [pid];
  while (todo.length) {
    const parent = todo.pop()!;
    for (const [p, info] of table) {
      if (info.ppid === parent) {
        out.push({ pid: p, command: info.command });
        todo.push(p);
      }
    }
  }
  return out;
}

/** Whether `pid` is still running (a zombie waiting to be reaped counts as gone). */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc (macOS): kill(0) is the answer
  }
}

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => done({ code, signal }));
  });

async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => (t = setTimeout(() => done("timeout"), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** Kills `child` and everything it started (SIGKILL), and waits for `child` to exit. */
async function killTree(child: ChildProcess): Promise<void> {
  const started = child.pid ? descendants(child.pid) : [];
  const exit = exited(child);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const p of started) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
  if (child.pid !== undefined) await within(exit, 10_000); // a child that never spawned never exits
}

export interface StartOptions {
  /** The command to start instead of the service (harness tests of the start-up path). */
  command?: string[];
  /** How long to wait for `AO_SERVICE_READY` (default 60 s). */
  readyTimeoutMs?: number;
  /** Told of the child the moment it is spawned, before it is ready (so a caller can always kill it). */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Every service process a test spawned that has not been seen to exit. Teardown closes it: what is
 * still running then (a service still starting when the test timed out, or one still stopping) is
 * killed with everything it started, and a child spawned after that is killed at once.
 */
export class SpawnedServices {
  private readonly live = new Set<ChildProcess>();
  private closed = false;

  track(child: ChildProcess): void {
    if (this.closed) {
      void killTree(child);
      return;
    }
    this.live.add(child);
    child.once("exit", () => this.live.delete(child));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Kills every service still running (and what it started); returns one line per service killed. */
  async close(): Promise<string[]> {
    this.closed = true;
    const left = [...this.live].filter((c) => c.exitCode === null && c.signalCode === null);
    await Promise.all(left.map((c) => killTree(c)));
    this.live.clear();
    return left.map((c) => `A service process (pid ${c.pid}) was still running at teardown and was killed with what it started.`);
  }
}

/**
 * Starts the service and waits for its ready line. On every failure (no ready line in time, early
 * exit, a spawn error) the child and anything it started are killed before the promise rejects, so
 * the caller can remove the temporary folder safely.
 */
export async function startService(root: string, opts: StartOptions = {}): Promise<{ child: ChildProcess; port: number; token: string; log: string[] }> {
  // 64 hex characters: well over the 32 the service requires, and nothing a URL would need to escape.
  const token = randomBytes(32).toString("hex");
  const env = serviceEnv({
    NODE_ENV: "test",
    AO_SERVICE_PORT: "0",
    AO_CONFIG_DIR: join(root, "config"),
    AO_TOOLS_DIR: join(root, "tools"),
    AO_MODELS_DIR: join(root, "models"),
    AO_LOOKUP_FIXTURES: LOOKUP_FIXTURES,
  });
  const [cmd, ...args] = opts.command ?? [process.execPath, "--max-old-space-size=512", "--import", "tsx", "src/main.ts"];
  const child = spawn(cmd!, args, { cwd: SERVICE_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
  opts.onSpawn?.(child);
  // The token is handed over on standard input, as the desktop shell will (R98). The pipe stays open;
  // a child that never reads it (or never started) must not turn the write into an unhandled error.
  child.stdin!.on("error", () => {});
  child.stdin!.write(`${token}\n`);
  const log: string[] = [];
  createInterface({ input: child.stderr! }).on("line", (l) => log.push(`[stderr] ${l}`));
  const readyMs = opts.readyTimeoutMs ?? 60_000;
  try {
    const port = await new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`The service did not print AO_SERVICE_READY within ${readyMs} ms.\n${log.join("\n")}`)), readyMs);
      createInterface({ input: child.stdout! }).on("line", (l) => {
        log.push(l);
        const m = /^AO_SERVICE_READY port=(\d+)\s*$/.exec(l);
        if (m) {
          clearTimeout(timer);
          done(Number(m[1]));
        }
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        fail(new Error(`The service could not be started: ${err.message}`));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        fail(new Error(`The service exited before it was ready (code ${code}, signal ${signal}).\n${log.join("\n")}`));
      });
    });
    return { child, port, token, log };
  } catch (err) {
    await killTree(child);
    throw err;
  }
}

/** Stops the service and everything it started; returns what went wrong (empty when all is well). */
async function stopService(child: ChildProcess): Promise<string[]> {
  const problems: string[] = [];
  const started = child.pid ? descendants(child.pid) : [];
  const exit = exited(child);
  child.kill("SIGTERM");
  let result = await within(exit, 30_000);
  if (result === "timeout") {
    problems.push("The service did not stop within 30 s of SIGTERM; it was killed.");
    child.kill("SIGKILL");
    result = await exit;
  } else if (result.code !== 0) problems.push(`The service exited with code ${result.code} (signal ${result.signal}) on SIGTERM, not 0.`);
  // Everything it started must be gone once it has exited.
  const deadline = Date.now() + 10_000;
  let left = started.filter((p) => running(p.pid));
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    left = left.filter((p) => running(p.pid));
  }
  for (const p of left) {
    problems.push(`Still running after the service stopped: pid ${p.pid} ${p.command}`);
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone meanwhile
    }
  }
  return problems;
}

export const test = base.extend<{ app: AppHarness; blocked: Blocked }>({
  app: async ({}, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "ao-e2e-"));
    const configDir = join(root, "config");
    const librariesDir = join(root, "libraries");
    let svc: Awaited<ReturnType<typeof startService>> | undefined;
    const problems: string[] = [];
    /** The output of every service this test started (a restart starts another). */
    const logs: string[][] = [];
    const restartListeners: Array<() => Promise<void>> = [];
    const spawned = new SpawnedServices();
    const start = () => startService(root, { onSpawn: (c) => spawned.track(c) });
    try {
      await Promise.all([configDir, librariesDir, join(root, "tools"), join(root, "models")].map((d) => mkdir(d, { recursive: true })));
      svc = await start();
      logs.push(svc.log);
      const harness: AppHarness = {
        root,
        configDir,
        librariesDir,
        baseUrl: `http://127.0.0.1:${svc.port}`,
        port: svc.port,
        token: svc.token,
        async api<T>(method: string, path: string, body?: unknown) {
          const res = await fetch(`${harness.baseUrl}${path}`, {
            method,
            headers: { authorization: `Bearer ${harness.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // not JSON: the text itself
          }
          return { status: res.status, body: parsed as T };
        },
        childProcesses: () => (svc?.child.pid ? descendants(svc.child.pid).map((p) => p.command) : []),
        log: () => logs.map((l) => l.join("\n")).join("\n--- the service was restarted ---\n"),
        async restart(whileStopped) {
          const old = svc!;
          svc = undefined;
          problems.push(...(await stopService(old.child)));
          expect(problems, "the service and the processes it started stop cleanly before a restart").toEqual([]);
          await whileStopped?.();
          // The test may have ended (timed out) meanwhile: never start a service after teardown began.
          if (spawned.isClosed) throw new Error("The test ended while the service was being restarted.");
          svc = await start();
          logs.push(svc.log);
          harness.port = svc.port;
          harness.baseUrl = `http://127.0.0.1:${svc.port}`;
          harness.token = svc.token;
          for (const l of restartListeners) await l();
        },
        onRestart: (listener) => void restartListeners.push(listener),
      };
      await use(harness);
    } finally {
      try {
        if (svc) problems.push(...(await stopService(svc.child)));
        // Anything else still running: a service still starting or stopping when the test ended.
        problems.push(...(await spawned.close()));
        if (logs.length && (problems.length || testInfo.status !== testInfo.expectedStatus)) {
          await testInfo.attach("service-log", { body: logs.map((l) => l.join("\n")).join("\n--- the service was restarted ---\n"), contentType: "text/plain" });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(problems, "the service and the processes it started stop cleanly").toEqual([]);
  },

  // Automatic, so a test that replaces `page` still fails on a request outside the app and service.
  blocked: [
    async ({}, use) => {
      const list: Blocked = [];
      await use(list);
      expect(list, "the page made no request outside the app and its service").toEqual([]);
    },
    { auto: true },
  ],

  page: async ({ page, app, blocked, browserName }, use) => {
    const context = page.context();
    // Read at each request: a restart moves the service to another port (and the old one is refused).
    const service = () => new URL(app.baseUrl).host;
    // Chromium's Local Network Access treats a page Playwright answers itself as public, so its
    // calls to the loopback service need the permission a user (or the shell) would grant; without
    // it every call fails with "Permission was denied for this request to access the `loopback`
    // address space". Granted to the app's origin only.
    if (browserName === "chromium") await context.grantPermissions(["local-network-access"], { origin: APP_ORIGIN });
    // Everything but the service goes through here: the app's origin is answered from disk, the rest is refused.
    await context.route(
      (url) => url.host !== service(),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== APP_ORIGIN) {
          blocked.push(route.request().url());
          return route.abort("blockedbyclient");
        }
        const hit = distFileFor(url.pathname);
        if (hit.status === 404) return route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "not found" });
        return route.fulfill({ status: 200, contentType: CONTENT_TYPES[extname(hit.file)] ?? "application/octet-stream", body: await readFile(hit.file) });
      },
    );
    // As the desktop shell will: the connection on window before any app code runs, in the app's own
    // top-level document only (never in a snapshot frame or any other origin). After a restart the
    // shell hands over the new connection: a later init script runs after this one and replaces it.
    const handOver = async () => {
      await context.addInitScript(
        ({ baseUrl, token, origin }) => {
          if (window === window.top && window.location.origin === origin) (window as unknown as { __AO_SERVICE__?: unknown }).__AO_SERVICE__ = { baseUrl, token };
        },
        { baseUrl: app.baseUrl, token: app.token, origin: APP_ORIGIN },
      );
    };
    await handOver();
    app.onRestart(handOver);
    // The first-use "Optional tools" question (Task 48b) is a modal dialog over the whole app. These
    // scenarios are about other things, so the harness records it as answered "Not now", exactly as
    // the app records that answer (FirstUseTools.tsx), before any app code runs. An answer already
    // there is left alone, so a scenario about the question itself can set its own state first.
    await context.addInitScript(
      ({ origin }) => {
        if (window !== window.top || window.location.origin !== origin) return;
        try {
          if (window.localStorage.getItem("ao.firstUseTools") === null) window.localStorage.setItem("ao.firstUseTools", "not-now");
        } catch {
          // storage unavailable: the app treats that as unanswered
        }
      },
      { origin: APP_ORIGIN },
    );
    await page.goto(`${APP_ORIGIN}/`);
    await use(page);
  },
});

/**
 * Rules of a project without identifiable data and without online lookups: the default rules
 * require encryption (the service refuses them without it), and a lookup with no recorded answer
 * fails on purpose. Scenarios that need neither use these.
 */
export const OPEN_RULES = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\nprocessing:\n  metadata_lookup: []\n";

/**
 * Test set-up through the service: a library at `librariesDir/<folder>` and a project in it with
 * `governanceYaml` (encrypted with `passphrase` when one is given, else not), then the page loaded
 * onto the library screen with that project selected. (The library chooser and the New project dialog
 * are covered by the smoke test; the scenarios here are about what comes after.)
 */
export async function libraryWithProject(
  app: AppHarness,
  page: Page,
  o: { library: string; folder?: string; project: string; governanceYaml?: string; passphrase?: string },
): Promise<{ libraryPath: string; projectId: string; projectFolder: string }> {
  const libraryPath = join(app.librariesDir, o.folder ?? o.library);
  const lib = await app.api("POST", "/libraries", { path: libraryPath, name: o.library });
  expect(lib.status, JSON.stringify(lib.body)).toBe(200);
  const encryption = o.passphrase ? { enabled: true, passphrase: o.passphrase } : { enabled: false };
  const created = await app.api<{ project: { id: string; folder: string } }>("POST", "/projects", { name: o.project, governanceYaml: o.governanceYaml ?? OPEN_RULES, encryption });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(created.body.project.id)}`);
  await expect(page.getByRole("heading", { level: 1, name: o.library })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: o.project })).toHaveAttribute("aria-current", "true");
  return { libraryPath, projectId: created.body.project.id, projectFolder: created.body.project.folder };
}

/** A recorded defect (Task 45 report): its id and the step it blocks, in words. */
export interface Defect {
  id: string;
  title: string;
}

/** How long the assertion that decides a defect test may wait: the state it reads is already there. */
export const DEFECT_TIMEOUT = 5_000;

/**
 * Inside a scenario, where a step cannot be done yet because of `d`: the step shows in the report as
 * skipped, "BLOCKED <id>: <title>", and the test carries a "blocked" annotation. The scenario goes on
 * after it as far as it can. The step itself runs in its own test, `defectTest(d, …)`, which notices
 * when the defect is fixed.
 */
export async function blockedBy(d: Defect): Promise<void> {
  test.info().annotations.push({ type: "blocked", description: `${d.id}: ${d.title}` });
  await test.step.skip(`BLOCKED ${d.id}: ${d.title} (checked by the test "${d.id}: …")`, async () => {});
}

/**
 * From this call on, the running test is expected to fail because of `d` (Playwright's test.fail):
 * it is reported "expected to fail" while the defect reproduces, and it fails the run as soon as it
 * passes, i.e. once the defect is fixed (then turn the step in its scenario back into a test.step and
 * delete the defect test). Set-up done before this call fails the test as usual, so only the
 * assertions after it are covered. Use `DEFECT_TIMEOUT` on them.
 */
export function expectDefect(d: Defect): void {
  test.info().annotations.push({ type: "defect", description: `${d.id}: ${d.title}` });
  test.fail(true, `${d.id}: ${d.title}`);
}

/**
 * The plaintext of a file the service stored encrypted, decrypted with the library's own code (the
 * project key unwrapped from `keys/project-key.json` with the passphrase) in a child process run from
 * packages/library, so the test reads exactly what the app would. The plaintext is written to
 * `output`, which must be inside the test's temporary folder; the passphrase goes by environment,
 * never on a command line.
 */
export function decryptStoredFile(app: AppHarness, o: { projectRoot: string; file: string; passphrase: string; output: string }): void {
  if (!resolve(o.output).startsWith(app.root + sep)) throw new Error("decryptStoredFile writes only inside the test's temporary folder");
  const code = [
    'import { readFile, writeFile } from "node:fs/promises";',
    'import { unwrapKey } from "./src/crypto/keys.ts";',
    'import { decryptBytes } from "./src/repo/io.ts";',
    "const o = JSON.parse(process.env.AO_E2E_DECRYPT);",
    'const kf = JSON.parse(await readFile(o.keyFile, "utf8"));',
    "const key = await unwrapKey(kf.passphrase, o.passphrase);",
    "await writeFile(o.output, await decryptBytes((id) => (id === kf.keyId ? key : undefined), await readFile(o.file)));",
  ].join("\n");
  const env = { ...process.env, AO_E2E_DECRYPT: JSON.stringify({ keyFile: join(o.projectRoot, "keys", "project-key.json"), passphrase: o.passphrase, file: o.file, output: o.output }) };
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Decrypting a stored file failed (status ${r.status}): ${r.stderr}`);
}

export { expect, type Page };
