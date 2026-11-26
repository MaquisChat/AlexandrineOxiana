/**
 * The app end-to-end fixture (R130): the real UI, the real library service and the real media worker.
 *
 * Per test, `app`:
 *  - makes a temporary folder under os.tmpdir() holding the app settings folder (`config/`), a place
 *    for libraries (`libraries/`) and the worker's tools and models folders, and removes it afterwards;
 *  - starts the service as its `start` script does (`node --max-old-space-size=512 --import tsx
 *    src/main.ts`), with a fresh random token written on its standard input as one line (R98: never
 *    in its environment or command line; standard input is left open), port 0, NODE_ENV=test,
 *    AO_CONFIG_DIR in the temporary folder, the recorded lookup answers (AO_LOOKUP_FIXTURES, honoured only in test mode), 500 GB
 *    of free space for the download runs (AO_TEST_FREE_BYTES, honoured only in test mode) and the
 *    fake yt-dlp / gallery-dl named in AO_YTDLP_BIN / AO_GALLERYDL_BIN (the worker would otherwise
 *    run the real gallery-dl from its venv) and first on PATH; it waits for
 *    `AO_SERVICE_READY port=<n>`. The service starts the real media worker itself when a library
 *    opens (or a route needs it). If start-up fails, the child and anything it started are killed
 *    before the temporary folder is removed;
 *  - on teardown stops the service with SIGTERM (its graceful shutdown stops the worker), checks it
 *    exited cleanly, and fails the test if any process it started is still running;
 *  - `app.restart()` does the same mid-test and starts a new service on the same settings folder (a
 *    relaunch of the app), with a new port and token that the page is handed on its next load;
 *  - with `test.use({ fakeControl: true })`, `app.fakes` tells the fake downloaders what to answer
 *    (a synthetic profile, a held download) and speech recognition is a fake inside the real worker
 *    (FakeControl);
 *  - `app.grantFolder(dir)` approves a folder for watching as the desktop shell does (a grant line on the
 *    service's open standard input, R207); with `test.use({ shellStub: true })` the page believes it runs in the
 *    shell, whose folder chooser is `app.chooser` (ShellChooser; see the end of this file).
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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { test as base, expect, type Page, type Request } from "@playwright/test";
import { FAKE_SPEECH, FAKE_TOOLS, LIBRARY_DIR, LOOKUP_FIXTURES, SERVICE_DIR, UI_DIST } from "./paths.js";
import { QUIET_SETTLE_MS, QUIET_WAIT_MS, stillOutMessage } from "./quiet.js";

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
  /** What the fake tools answer: only in a test that sets `test.use({ fakeControl: true })`, else undefined. */
  fakes: FakeControl | undefined;
  /**
   * Approves `dir` for watching exactly as the desktop shell does after its folder chooser closes (Task W10; R207,
   * W6): one grant line, `{"type":"folder-grant","id":<32 hex>,"path":<absolute>}\n`, written on the running
   * service's open standard input (the pipe that carried the token, kept open for the service's life). Returns the
   * grant id, which is all the page is ever given. No route, variable or file of the service is involved.
   */
  grantFolder(dir: string): Promise<string>;
  /** The stand-in for the shell's folder chooser: only in a test that sets `test.use({ shellStub: true })`, else undefined. */
  chooser: ShellChooser | undefined;
}

/** The fake downloaders the worker runs. */
export type FakeTool = "yt-dlp" | "gallery-dl";

/**
 * Telling the fakes what to answer, for a test that sets `test.use({ fakeControl: true })`. The
 * service then runs the fake yt-dlp and gallery-dl through small wrappers in the test's folder (the
 * worker passes its tools no test variables, so the wrappers carry them), and the real media worker
 * with the fake speech recognition of packages/library/tests/fixtures/fake-speech first on its
 * PYTHONPATH (through AO_WORKER_BIN, as the packaged app names its worker).
 */
export interface FakeControl {
  /** The synthetic profile the fake downloaders list and download (their FAKE_PROFILE_FILE), or a list of them for fake yt-dlp (two channels at once); read at every run, so it can change between captures. */
  setProfile(profile: unknown): Promise<void>;
  /**
   * From now on every run of `tool` (but `--version`) waits before it starts, until `release(tool)`: a capture that is
   * still running for as long as the test needs. With `match`, only a run one of whose arguments contains it waits (one
   * video of a channel, say), and every other run goes on.
   */
  hold(tool: FakeTool, match?: string): Promise<void>;
  release(tool: FakeTool): Promise<void>;
  /** Runs of `tool` waiting at the hold now. */
  held(tool: FakeTool): number;
  /**
   * From now on the fake speech recognition waits before it answers (each transcription stays running), until
   * `releaseSpeech()`; it holds the transcriptions of a service started after a restart too, for as long as the hold is on.
   */
  holdSpeech(): Promise<void>;
  releaseSpeech(): Promise<void>;
  /** Transcriptions waiting at the speech hold now, in a worker that is alive. */
  heldSpeech(): number;
  /** The arguments of every run of `tool` so far, oldest first. */
  runs(tool: FakeTool): string[][];
  /**
   * Plants speech model `name` in the worker's models folder as the tools dialogue would leave it
   * (a snapshot named by refs/main, with the files the worker checks), so the app reports it
   * installed; the fake speech recognition never reads the files.
   */
  installSpeechModel(name: string): Promise<void>;
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
  // pdf.js's bundled data (Task R6, dist/pdfjs/): read with fetch as bytes, whatever their type.
  ".bcmap": "application/octet-stream",
  ".pfb": "application/x-font-type1",
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
  /** Environment for the service on top of the harness's own (e.g. the fake-control wrappers). */
  env?: Record<string, string>;
}

/** The wrapper a `fakeControl` test's service runs as `tool` (CommonJS: the test folder has no package.json). */
function fakeWrapper(tool: FakeTool, control: string): string {
  return [
    "#!/usr/bin/env node",
    '"use strict";',
    'const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    `const CONTROL = ${JSON.stringify(control)};`,
    `const TOOL = ${JSON.stringify(join(FAKE_TOOLS, tool))};`,
    `const NAME = ${JSON.stringify(tool)};`,
    "const args = process.argv.slice(2);",
    'appendFileSync(CONTROL + "/runs-" + NAME + ".jsonl", JSON.stringify(args) + "\\n");',
    "const env = { ...process.env };",
    'if (existsSync(CONTROL + "/profile.json")) env.FAKE_PROFILE_FILE = CONTROL + "/profile.json";',
    "const run = () => {",
    '  const r = spawnSync(process.execPath, [TOOL, ...args], { stdio: "inherit", env });',
    "  process.exit(r.status ?? 1);",
    "};",
    'const hold = CONTROL + "/hold-" + NAME;',
    "// The hold file holds what an argument must contain for this run to wait; empty, every run waits.",
    "const holding = () => {",
    "  let match;",
    "  try {",
    '    match = readFileSync(hold, "utf8");',
    "  } catch {",
    "    return false;",
    "  }",
    '  return match === "" || args.some((a) => a.includes(match));',
    "};",
    'if (!args.includes("--version") && holding()) {',
    '  const marker = CONTROL + "/held-" + NAME + "-" + process.pid;',
    "  writeFileSync(marker, JSON.stringify(args));",
    "  const timer = setInterval(() => {",
    "    if (holding()) return;",
    "    clearInterval(timer);",
    "    rmSync(marker, { force: true });",
    "    run();",
    "  }, 50);",
    "} else run();",
    "",
  ].join("\n");
}

/**
 * The hold markers in `dir` named `<prefix><pid>[-…]` whose process is still running. A marker of a process that is gone
 * (a worker the restart stopped) is not counted, so nothing that polls after a restart passes on a stale marker.
 */
export function liveMarkers(dir: string, prefix: string): number {
  return readdirSync(dir).filter((n) => {
    if (!n.startsWith(prefix)) return false;
    const pid = Number(n.slice(prefix.length).split("-")[0]);
    return Number.isInteger(pid) && pid > 0 && running(pid);
  }).length;
}

/** A `fakeControl` test's wrappers and its FakeControl (see FakeControl). */
async function fakeControlFor(root: string): Promise<{ env: Record<string, string>; control: FakeControl }> {
  const dir = join(root, "fake-control");
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  // AO_FAKE_SPEECH_CONTROL: where the fake speech recognition looks for its hold (the worker is given the AO_ variables).
  const env: Record<string, string> = { AO_WORKER_BIN: join(FAKE_SPEECH, "ao-worker"), AO_FAKE_SPEECH_CONTROL: dir };
  for (const tool of ["yt-dlp", "gallery-dl"] as const) {
    const file = join(bin, tool);
    await writeFile(file, fakeWrapper(tool, dir), { mode: 0o755 });
    env[tool === "yt-dlp" ? "AO_YTDLP_BIN" : "AO_GALLERYDL_BIN"] = file;
  }
  const control: FakeControl = {
    setProfile: (profile) => writeFile(join(dir, "profile.json"), JSON.stringify(profile)),
    hold: (tool, match) => writeFile(join(dir, `hold-${tool}`), match ?? ""),
    release: (tool) => rm(join(dir, `hold-${tool}`), { force: true }),
    held: (tool) => readdirSync(dir).filter((n) => n.startsWith(`held-${tool}-`)).length,
    holdSpeech: () => writeFile(join(dir, "hold-speech"), ""),
    releaseSpeech: () => rm(join(dir, "hold-speech"), { force: true }),
    heldSpeech: () => liveMarkers(dir, "held-speech-"),
    runs: (tool) => {
      const file = join(dir, `runs-${tool}.jsonl`);
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
    },
    async installSpeechModel(name) {
      const repo = join(root, "models", `models--Systran--faster-whisper-${name}`);
      const snapshot = join(repo, "snapshots", "e2e-fake");
      await mkdir(join(repo, "refs"), { recursive: true });
      await mkdir(snapshot, { recursive: true });
      await writeFile(join(repo, "refs", "main"), "e2e-fake");
      for (const f of ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]) await writeFile(join(snapshot, f), "fake speech model file\n");
    },
  };
  return { env, control };
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
    // Test-only (honoured only under NODE_ENV=test): the download runs see 500 GB free, so no scenario depends on this machine's disk (R687 D).
    AO_TEST_FREE_BYTES: "500000000000",
    AO_SERVICE_PORT: "0",
    AO_CONFIG_DIR: join(root, "config"),
    AO_TOOLS_DIR: join(root, "tools"),
    AO_MODELS_DIR: join(root, "models"),
    AO_LOOKUP_FIXTURES: LOOKUP_FIXTURES,
    ...opts.env,
  });
  const [cmd, ...args] = opts.command ?? [process.execPath, "--max-old-space-size=512", "scripts/dev.mjs"]; // 16 file threads, as the product runs (R233 M10)
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

export const test = base.extend<{ app: AppHarness; blocked: Blocked; fakeControl: boolean; shellStub: boolean; serviceEnv: Record<string, string> }>({
  /** `test.use({ fakeControl: true })`: the test tells the fakes what to answer (app.fakes, FakeControl). */
  fakeControl: [false, { option: true }],
  /** `test.use({ shellStub: true })`: the page believes it runs in the desktop app, whose folder chooser is `app.chooser` (ShellChooser). */
  shellStub: [false, { option: true }],
  /**
   * Task Z11: more environment for every service this test starts (a restart included), on top of the harness's own,
   * e.g. the test-only switches AO_SECRETS and AO_ZOTERO_API_ORIGIN (honoured only under
   * NODE_ENV=test, which the harness sets). A spec may override it with a fixture that depends on its own (a stand-in's port).
   */
  serviceEnv: [{}, { option: true }],

  app: async ({ fakeControl, shellStub, serviceEnv }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "ao-e2e-"));
    const configDir = join(root, "config");
    const librariesDir = join(root, "libraries");
    let svc: Awaited<ReturnType<typeof startService>> | undefined;
    const problems: string[] = [];
    /** The output of every service this test started (a restart starts another). */
    const logs: string[][] = [];
    const restartListeners: Array<() => Promise<void>> = [];
    const spawned = new SpawnedServices();
    let fakes: Awaited<ReturnType<typeof fakeControlFor>> | undefined;
    const start = () => startService(root, { onSpawn: (c) => spawned.track(c), ...(fakes || Object.keys(serviceEnv).length ? { env: { ...fakes?.env, ...serviceEnv } } : {}) });
    try {
      await Promise.all([configDir, librariesDir, join(root, "tools"), join(root, "models")].map((d) => mkdir(d, { recursive: true })));
      if (fakeControl) fakes = await fakeControlFor(root);
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
        fakes: fakes?.control,
        grantFolder: (dir) => writeGrantLine(svc, dir),
        chooser: undefined,
      };
      if (shellStub) harness.chooser = shellChooserFor(harness);
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

  page: async ({ page, app, blocked, browserName, shellStub }, use) => {
    const context = page.context();
    if (shellStub) await installShellStub(page, app.chooser!);
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
    // The first-use "Optional tools" question (Tasks 48b, 48c) is a banner on the open library. These
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
    // FR-750 (R579): the page's requests to the service still in the air (the event stream, which never ends, aside),
    // so that a screen is not opened by its address while the page before is still reading (`gotoWhenQuiet`).
    const out = new Set<Request>();
    /**
     * A new document was asked for: once it is in the page, every request the page before still had out is gone
     * (Chromium may not report their end). That holds also for requests the page before sent AFTER the new document was
     * asked for and before it was in the page (R614: a screen between two of its reads) — the new document has sent
     * nothing of its own yet at that moment, so all that is out then is the old page's.
     */
    let loading = false;
    const settled = (r: Request) => void out.delete(r);
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loading = true;
      const u = new URL(r.url());
      if (u.host === service() && u.pathname !== "/events") out.add(r);
    });
    page.on("requestfinished", settled);
    page.on("requestfailed", settled);
    page.on("framenavigated", (f) => {
      if (f !== page.mainFrame() || !loading) return;
      out.clear();
      loading = false;
    });
    inFlight.set(page, out);
    await page.goto(`${APP_ORIGIN}/`);
    await use(page);
  },
});

/** Per page, its requests to the service still in the air (the event stream aside); filled by the `page` fixture. */
const inFlight = new WeakMap<Page, Set<Request>>();

/**
 * FR-750 (R579): opens `url` once the page before has no request to the service in the air — the true state of a page
 * that has finished reading. Loading a new page while the one before still had requests out made WebKit fail the new
 * page's first requests at once ("WebKit encountered an internal error"); no scenario is about that.
 */
export async function gotoWhenQuiet(page: Page, url: string): Promise<void> {
  const out = inFlight.get(page);
  if (out) {
    try {
      // R614: quiet means nothing out now AND nothing out a moment later — a screen between two of its reads (the list
      // answered, the reads that depend on it not yet sent) has nothing out for a few milliseconds and is not quiet.
      await expect
        .poll(
          async () => {
            if (out.size > 0) return out.size;
            await page.waitForTimeout(QUIET_SETTLE_MS);
            return out.size;
          },
          { timeout: QUIET_WAIT_MS },
        )
        .toBe(0);
    } catch {
      // R586 M4: which requests were still out, by method and path (never a query).
      throw new Error(stillOutMessage([...out].map((r) => ({ method: r.method(), url: r.url() }))));
    }
  }
  await page.goto(url);
}

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
  await gotoWhenQuiet(page, `${APP_ORIGIN}/?project=${encodeURIComponent(created.body.project.id)}`);
  await expect(page.getByRole("heading", { level: 1, name: o.library })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: o.project })).toHaveAttribute("aria-current", "true");
  return { libraryPath, projectId: created.body.project.id, projectFolder: created.body.project.folder };
}

/** What `plantCaptureConflict` plants: the value the page gave and the one the platform data gave, for the title and the DOI. */
export interface PlantedConflict {
  title: [string, string];
  doi: [string, string];
}

/**
 * Plants a captured source whose title and DOI conflict, with the verification report a capture
 * stores (each field "conflict", both values and their sources) and the review entry a link or
 * profile capture queues for it (createSource's reviewItem, cause capture-conflict), using the
 * library's own code from packages/library. Run it while the service is stopped (`app.restart`'s
 * `whileStopped`): no capture through the fake tools can produce a DOI, so this is the way to plant
 * one (as e2e/review-queue.spec.ts does). The index is updated through the library's own index sink.
 */
export function plantCaptureConflict(app: AppHarness, o: { library: string; projectId: string } & PlantedConflict): void {
  const code = [
    'import { KeyRing, createIndexSink, deviceDeps, openIndexChecked, openLibrary, openRepo } from "./src/index.ts";',
    "const o = JSON.parse(process.env.AO_E2E_PLANT);",
    "const lib = await openLibrary(o.library, deviceDeps(o.configDir));",
    "const checked = await openIndexChecked(lib.root);",
    "const ring = new KeyRing();",
    "const repo = await openRepo(lib, ring, { index: createIndexSink(checked.handle, { root: lib.root, keyRing: ring }) });",
    "const at = new Date().toISOString();",
    "const mt = (value) => ({ variants: [{ lang: 'en', kind: 'original', value }] });",
    "const page = { kind: 'page-dom' }; const platform = { kind: 'platform-json' };",
    "const [t1, t2] = o.title; const [d1, d2] = o.doi;",
    "await repo.createSource(o.projectId, {",
    "  projectIds: [], type: 'webpage', title: mt(t1), creators: [], identifiers: { doi: d1 },",
    "  caseAttributes: {}, availability: { status: 'available' }, collectionIds: [], tagIds: [], participantIds: [],",
    "}, [], {",
    "  provenance: { captureMethod: 'downloader', capturedAt: at, tool: { name: 'e2e-plant', version: '1' }, fileHashes: {}, legal: { status: 'public' }, identifiable: false },",
    "  fieldEvidence: [",
    "    { field: '/title', value: t1, source: page, at }, { field: '/title', value: t2, source: platform, at },",
    "    { field: '/identifiers/doi', value: d1, source: page, at }, { field: '/identifiers/doi', value: d2, source: platform, at },",
    "  ],",
    "  verification: {",
    "    '/title': { status: 'conflict', checks: ['sources-agree'], reason: 'The page and the platform data give different titles.', current: t1, values: [{ value: t1, source: page }, { value: t2, source: platform }] },",
    "    '/identifiers/doi': { status: 'conflict', checks: ['sources-agree'], reason: 'The page and the platform data give different DOIs.', current: d1, values: [{ value: d1, source: page }, { value: d2, source: platform }] },",
    "  },",
    "  reviewItem: { fields: { '/title': 'conflict', '/identifiers/doi': 'conflict' }, reasons: ['The page and the platform data disagree on the title and the DOI.'], cause: { kind: 'capture-conflict' } },",
    "});",
    "checked.handle.close();",
    "await lib.close();",
  ].join("\n");
  const env = { ...process.env, AO_E2E_PLANT: JSON.stringify({ library: o.library, projectId: o.projectId, configDir: app.configDir, title: o.title, doi: o.doi }) };
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: LIBRARY_DIR, env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`Planting the conflict failed (status ${r.status}): ${r.stderr}`);
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

// ---------------------------------------------------------------------------------------------------------------
// Watched folders (Task W10; R207, W6): the shell's grant line, and a stand-in for the shell's folder chooser.

/**
 * The stand-in for the desktop shell's folder chooser (`pick_watch_folder`), in a test that sets
 * `test.use({ shellStub: true })`. The test says beforehand what the person picks; when the page opens the chooser,
 * the harness writes the grant line for that folder (`app.grantFolder`, as the shell does once its chooser closes)
 * and the page receives only `{ grantId, name }` — the folder's last name, never its path.
 */
export interface ShellChooser {
  /** What the next opening of the chooser picks: `dir` (absolute), or null for "Cancel". Used once; after it the chooser is cancelled. */
  willPick(dir: string | null): void;
  /** The title the page gave each opening of the chooser, oldest first. */
  readonly titles: string[];
  /** The grant ids handed to the page, oldest first. */
  readonly grants: string[];
}

/** One grant line on the running service's standard input, byte for byte as the shell writes it (grant.rs `grant_line`). */
async function writeGrantLine(svc: { child: ChildProcess } | undefined, dir: string): Promise<string> {
  if (!svc) throw new Error("No service is running to hand a folder to.");
  if (!isAbsolute(dir)) throw new Error("A grant names an absolute folder, as the shell's chooser gives it.");
  const stdin = svc.child.stdin!;
  if (stdin.destroyed || stdin.writableEnded) throw new Error("The service's standard input is closed.");
  const id = randomBytes(16).toString("hex");
  const line = `${JSON.stringify({ type: "folder-grant", id, path: dir })}\n`;
  await new Promise<void>((done, fail) => stdin.write(line, (err) => (err ? fail(err) : done())));
  return id;
}

function shellChooserFor(app: AppHarness): ShellChooser & { pick(title: string): Promise<{ grantId: string; name: string } | null> } {
  let next: string | null = null;
  const titles: string[] = [];
  const grants: string[] = [];
  return {
    willPick: (dir) => void (next = dir),
    titles,
    grants,
    async pick(title) {
      titles.push(String(title));
      const dir = next;
      next = null;
      if (dir === null) return null;
      const grantId = await app.grantFolder(dir);
      grants.push(grantId);
      return { grantId, name: basename(dir) };
    },
  };
}

/**
 * Makes this test's page believe it runs in the desktop shell, before any app code: `isTauri`, and a
 * `__TAURI_INTERNALS__.invoke` that answers ONLY `pick_watch_folder` (through `app.chooser`) and refuses every other
 * command as the shell refuses one it does not know. The stand-in is set up in the app's own top-level document
 * only. The page's channel to the harness (`__aoShellStubPick`, a Playwright binding) is visible in every frame, as
 * bindings are, but it ANSWERS only a call from the page's main frame at the app's origin: from any other frame it
 * refuses, opens no chooser and writes no grant. A test without `shellStub` never reaches here, so its page is a
 * plain browser.
 */
async function installShellStub(page: Page, chooser: ShellChooser): Promise<void> {
  const context = page.context();
  await context.exposeBinding("__aoShellStubPick", (source, title: unknown) => {
    let origin = "";
    try {
      origin = new URL(source.frame.url()).origin;
    } catch {
      origin = "";
    }
    if (source.frame !== source.page.mainFrame() || origin !== APP_ORIGIN) throw new Error("Command pick_watch_folder not found");
    return (chooser as ReturnType<typeof shellChooserFor>).pick(String(title ?? ""));
  });
  await context.addInitScript(
    ({ origin }) => {
      if (window !== window.top || window.location.origin !== origin) return;
      const w = window as unknown as Record<string, unknown> & { __aoShellStubPick: (title: string) => Promise<unknown> };
      let callbacks = 0;
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args?: { title?: unknown }) => {
          if (cmd === "pick_watch_folder") return w.__aoShellStubPick(String(args?.title ?? ""));
          throw `Command ${cmd} not found`;
        },
        transformCallback: () => ++callbacks,
        unregisterCallback: () => {},
      };
    },
    { origin: APP_ORIGIN },
  );
}

export { expect, type Page };
