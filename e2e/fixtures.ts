/**
 * The app end-to-end fixture (R130): the real UI, the real library service and the real media worker.
 *
 * Per test, `app`:
 *  - makes a temporary folder under os.tmpdir() holding the app settings folder (`config/`), a place
 *    for libraries (`libraries/`) and the worker's tools and models folders, and removes it afterwards;
 *  - starts the service as its `start` script does (`node --max-old-space-size=512 --import tsx
 *    src/main.ts`), with a fresh random token, port 0, NODE_ENV=test, AO_CONFIG_DIR in the temporary
 *    folder, the recorded lookup answers (AO_LOOKUP_FIXTURES, honoured only in test mode) and the
 *    fake yt-dlp / gallery-dl named in AO_YTDLP_BIN / AO_GALLERYDL_BIN (the worker would otherwise
 *    run the real gallery-dl from its venv) and first on PATH; it waits for
 *    `AO_SERVICE_READY port=<n>`. The service starts the real media worker itself when a library
 *    opens (or a route needs it). If start-up fails, the child and anything it started are killed
 *    before the temporary folder is removed;
 *  - on teardown stops the service with SIGTERM (its graceful shutdown stops the worker), checks it
 *    exited cleanly, and fails the test if any process it started is still running.
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
import { FAKE_TOOLS, LOOKUP_FIXTURES, SERVICE_DIR, UI_DIST } from "./paths.js";

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
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  port: number;
  /** The UI token (for direct calls in test set-up; the page gets it through window.__AO_SERVICE__). */
  token: string;
  /** A direct call to the service with the UI token, as test set-up (no Origin header: not a browser). */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiAnswer<T>>;
  /** Command lines of the processes the service has started and that are still running (e.g. the media worker). */
  childProcesses(): string[];
  /** The service's output so far (stdout and stderr), for failure messages. */
  log(): string;
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
    AO_SERVICE_TOKEN: token,
    AO_SERVICE_PORT: "0",
    AO_CONFIG_DIR: join(root, "config"),
    AO_TOOLS_DIR: join(root, "tools"),
    AO_MODELS_DIR: join(root, "models"),
    AO_LOOKUP_FIXTURES: LOOKUP_FIXTURES,
  });
  const [cmd, ...args] = opts.command ?? [process.execPath, "--max-old-space-size=512", "--import", "tsx", "src/main.ts"];
  const child = spawn(cmd!, args, { cwd: SERVICE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
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
    let problems: string[] = [];
    try {
      await Promise.all([configDir, librariesDir, join(root, "tools"), join(root, "models")].map((d) => mkdir(d, { recursive: true })));
      svc = await startService(root);
      const { port, token, log, child } = svc;
      const baseUrl = `http://127.0.0.1:${port}`;
      const harness: AppHarness = {
        root,
        configDir,
        librariesDir,
        baseUrl,
        port,
        token,
        async api<T>(method: string, path: string, body?: unknown) {
          const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
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
        childProcesses: () => (child.pid ? descendants(child.pid).map((p) => p.command) : []),
        log: () => log.join("\n"),
      };
      await use(harness);
    } finally {
      try {
        if (svc) problems = await stopService(svc.child);
        if (svc && (problems.length || testInfo.status !== testInfo.expectedStatus)) {
          await testInfo.attach("service-log", { body: svc.log.join("\n"), contentType: "text/plain" });
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
    const service = new URL(app.baseUrl).host;
    // Chromium's Local Network Access treats a page Playwright answers itself as public, so its
    // calls to the loopback service need the permission a user (or the shell) would grant; without
    // it every call fails with "Permission was denied for this request to access the `loopback`
    // address space". Granted to the app's origin only.
    if (browserName === "chromium") await context.grantPermissions(["local-network-access"], { origin: APP_ORIGIN });
    // Everything but the service goes through here: the app's origin is answered from disk, the rest is refused.
    await context.route(
      (url) => url.host !== service,
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
    // top-level document only (never in a snapshot frame or any other origin).
    await context.addInitScript(
      ({ baseUrl, token, origin }) => {
        if (window === window.top && window.location.origin === origin) (window as unknown as { __AO_SERVICE__?: unknown }).__AO_SERVICE__ = { baseUrl, token };
      },
      { baseUrl: app.baseUrl, token: app.token, origin: APP_ORIGIN },
    );
    await page.goto(`${APP_ORIGIN}/`);
    await use(page);
  },
});

export { expect, type Page };
