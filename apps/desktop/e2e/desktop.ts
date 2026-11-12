/**
 * The desktop end-to-end harness (Task 37h): the built Linux app, started and driven the way the
 * Tauri project supports on Linux, through WebDriver.
 *
 *   test ──WebDriver──▶ tauri-driver ──▶ WebKitWebDriver ──▶ the app (debug build) in its real web view
 *
 * Per run, under one temporary folder in os.tmpdir() (removed afterwards):
 *  - a private X display (Xvfb, `-displayfd`), so nothing appears on, or types into, a person's own
 *    screen, and a private D-Bus session bus (the shell's single-instance guard and GTK use one);
 *  - the app's home, settings, data and cache folders (HOME and XDG_*): the app keeps its settings,
 *    pairings and tools under its data folder there (R159), and a place for the run's libraries;
 *  - tauri-driver on a free port, given exactly that environment (desktopEnv): WebKitWebDriver starts
 *    the app with it. The app runs as a person's debug build does: NOT in its test mode (no NODE_ENV,
 *    no launch-check probe), so nothing test-only is active in the shell, the page or the service.
 *    WebKitWebDriver passes on the app's standard error (not its standard output), where the shell
 *    writes its start-up failures and the service's log lines (readShellLog); the processes are
 *    found in /proc (the shell under the drivers, the service under the shell, the worker under it).
 * The app starts its own library service with its own fresh token (R155): this harness never sees
 * the token and never calls the service. What the service persisted is read from disk.
 *
 * The native file dialog: WebDriver drives the web view only. The GTK file chooser the shell opens
 * (tauri-plugin-dialog → rfd → GtkFileChooserDialog) is a separate X window; `pickInFileDialog` finds
 * it by its title on the private display and types the file's path into it with xdotool, as a person
 * would type a path into it, then presses Return. Everything from the button to the service is the
 * real app; only the person's key presses are made by the test.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { elementId, newSession, type Session } from "./webdriver.js";
import { requestWindowClose, socketPathFor } from "./x11.js";

/** The main window's title (tauri.conf.json productName, set by the shell). */
export const WINDOW_TITLE = "Alexandrine Oxiana";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The debug build `build:linux` makes: it finds the helpers through AO_DESKTOP_* (paths.rs, debug builds only). */
export const SHELL = join(REPO, "apps", "desktop", "src-tauri", "target", "debug", "alexandrine-oxiana");
export const SERVICE_DIR = join(REPO, "apps", "library-service", "dist", "library-service");
/** The app identifier (tauri.conf.json): the app's data folder under XDG_DATA_HOME is named after it. */
export const APP_IDENTIFIER = "org.alexandrineoxiana.desktop";
/** The tauri-driver version CI installs (cargo install --locked); the README says the same. */
export const TAURI_DRIVER_VERSION = "2.1.0";

// ---------- pure parts (desktop.test.ts) ----------

export interface EnvParts {
  display: string;
  bus: string;
  workerBin: string;
  nodeBin: string;
  serviceDir: string;
  path: string;
}

/** The environment tauri-driver (and so WebKitWebDriver and the app) gets: only this, nothing inherited. */
export function desktopEnv(root: string, p: EnvParts): Record<string, string> {
  return {
    PATH: p.path,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    LANG: "C.UTF-8",
    DISPLAY: p.display,
    DBUS_SESSION_BUS_ADDRESS: p.bus,
    // Where the debug shell finds its helpers (paths.rs: debug builds only; a release build uses its resources).
    AO_DESKTOP_NODE: p.nodeBin,
    AO_DESKTOP_SERVICE_DIR: p.serviceDir,
    AO_DESKTOP_WORKER_BIN: p.workerBin,
  };
}

/** The id of the window titled exactly `title` (the native dialog, the main window), or undefined. */
export function windowTitled(windows: Array<{ id: string; name: string }>, title: string): string | undefined {
  return windows.find((w) => w.name === title)?.id;
}

export interface ShellLog {
  /** The shell's start-up failure, in its own words ("<app> could not start: ..."). */
  startFailure?: string;
  /** The service's port ("Server listening at ..."). */
  port?: number;
  /** Why the service shut down, from its own log ("end of standard input": the shell closed it, R155). */
  serviceStop?: string;
  /** The shell had to force the service's stop. */
  forced: boolean;
}

/** What the app's standard error says (the shell's own lines and the service's, prefixed "[service] "). */
export function readShellLog(text: string): ShellLog {
  const out: ShellLog = { forced: false };
  for (const line of text.split("\n")) {
    const fail = /could not start: (.*)$/.exec(line);
    if (fail && out.startFailure === undefined) out.startFailure = fail[1]!.trim();
    if (/the library service did not stop in time and was stopped forcibly/.test(line)) out.forced = true;
    if (!line.startsWith("[service] {")) continue;
    let entry: { msg?: unknown; signal?: unknown };
    try {
      entry = JSON.parse(line.slice("[service] ".length)) as typeof entry;
    } catch {
      continue;
    }
    const listening = typeof entry.msg === "string" ? /^Server listening at http:\/\/127\.0\.0\.1:(\d+)$/.exec(entry.msg) : null;
    if (listening && out.port === undefined) out.port = Number(listening[1]);
    if (entry.msg === "shutting down" && typeof entry.signal === "string") out.serviceStop = entry.signal;
  }
  return out;
}

/** An audit log (.jsonl): its entries, and the line numbers (1-based) that are not JSON. */
export function readAuditLines(text: string): { entries: unknown[]; unreadable: number[] } {
  const entries: unknown[] = [];
  const unreadable: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unreadable.push(i + 1);
    }
  });
  return { entries, unreadable };
}

export interface PrerequisiteChecks {
  exists(path: string): boolean;
  onPath(program: string): boolean;
  tauriDriver: string | undefined;
  worker: string | undefined;
}

/** What is missing to run the desktop scenario at all, each with how to get it. */
export function missingPrerequisites(c: PrerequisiteChecks): string[] {
  const out: string[] = [];
  if (!c.exists(SHELL)) out.push("The built app (debug build) is missing: run `pnpm --filter @ao/desktop run build:linux`.");
  if (!c.exists(join(SERVICE_DIR, "service.mjs"))) out.push("The built library service folder is missing: run `pnpm --filter @ao/desktop run build:linux`.");
  if (!c.tauriDriver) out.push(`tauri-driver is missing: run \`cargo install tauri-driver --version =${TAURI_DRIVER_VERSION} --locked\` (or set TAURI_DRIVER to its path).`);
  if (!c.onPath("WebKitWebDriver")) out.push("WebKitWebDriver is missing: install the system package webkit2gtk-driver.");
  if (!c.onPath("Xvfb")) out.push("Xvfb (the virtual display) is missing: install the system package xvfb.");
  if (!c.onPath("dbus-daemon")) out.push("dbus-daemon is missing: install the system package dbus.");
  if (!c.onPath("xdotool")) out.push("xdotool (types into the native file dialog) is missing: install the system package xdotool.");
  if (!c.worker) out.push("No media worker: set up the development one (`pnpm setup:py`), build the packaged one (`pnpm --filter @ao/desktop build:sidecars`) or set AO_DESKTOP_WORKER_BIN.");
  return out;
}

// ---------- the machine ----------

function onPath(program: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** tauri-driver: TAURI_DRIVER, else cargo's install folder, else PATH. */
export function findTauriDriver(): string | undefined {
  if (process.env.TAURI_DRIVER) return existsSync(process.env.TAURI_DRIVER) ? process.env.TAURI_DRIVER : undefined;
  const cargo = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin", "tauri-driver");
  if (existsSync(cargo)) return cargo;
  return onPath("tauri-driver") ? "tauri-driver" : undefined;
}

/** The media worker, found as the launch check finds it: given, packaged, or the development one. */
function findWorker(): { bin: string; dev?: string } | undefined {
  if (process.env.AO_DESKTOP_WORKER_BIN) return { bin: process.env.AO_DESKTOP_WORKER_BIN };
  const sidecars = join(REPO, "apps", "desktop", "sidecars");
  if (existsSync(sidecars)) {
    for (const d of readdirSync(sidecars)) {
      const exe = join(sidecars, d, "ao-worker");
      if (d.startsWith("ao-worker-") && existsSync(exe)) return { bin: exe };
    }
  }
  const py = join(REPO, "services", "media-worker", ".venv", "bin", "python");
  return existsSync(py) ? { bin: "", dev: py } : undefined;
}

export function checkPrerequisites(): string[] {
  return missingPrerequisites({ exists: existsSync, onPath, tauriDriver: findTauriDriver(), worker: findWorker() ? "found" : undefined });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? done(a.port) : fail(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `test` until it returns something truthy; fails after `ms` naming `what`. */
export async function until<T>(what: string, ms: number, test: () => Promise<T | undefined | null | false> | T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await test();
      if (v) return v;
      last = undefined;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}${last instanceof Error ? ` (last: ${last.message})` : ""}`);
    await sleep(200);
  }
}

// ---------- processes (Linux /proc) ----------

function stat(pid: number): string[] | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}
/** Running (a zombie waiting to be reaped counts as gone: it runs nothing). */
export function running(pid: number): boolean {
  const s = stat(pid);
  return s !== null && s[0] !== "Z" && s[0] !== "X";
}
const readProc = (pid: number, f: string) => {
  try {
    return readFileSync(`/proc/${pid}/${f}`, "latin1");
  } catch {
    return "";
  }
};
export const cmdline = (pid: number) => readProc(pid, "cmdline").split("\0").join(" ").trim();
const allPids = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
export function descendants(root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of allPids()) {
    const pp = Number(stat(p)?.[1] ?? -1);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp)!.push(p);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(root);
  return out;
}
/** Running processes whose environment mentions `marker` (the run's temporary folder), except `except`. */
export function processesMarkedBy(marker: string, except: number[]): number[] {
  return allPids().filter((p) => p !== process.pid && !except.includes(p) && running(p) && readProc(p, "environ").includes(marker));
}
function killAll(pids: number[]): void {
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
  }
}

// ---------- the run ----------

export interface Desktop {
  root: string;
  /** An empty folder for the run's libraries. */
  librariesDir: string;
  /** Files the scenario attaches (outside any library). */
  filesDir: string;
  /** The app's data folder (XDG_DATA_HOME/<identifier>): settings/, tools/, models/ (R159). */
  appDataDir: string;
  session: Session;
  /** The shell's and the service's pids (found in /proc). */
  shell: { shellPid: number; servicePid: number };
  /** tauri-driver's, WebKitWebDriver's and the app's output so far (the shell and the service log to it). */
  log(): string;
  /** What the app's standard error says so far. */
  shellLog(): ShellLog;
  /** The service and what it started (the worker), still running. */
  helpers(): number[];
  /** The processes of this run apart from the drivers (the app, its web view processes, the helpers). */
  appProcesses(): number[];
  /** The one visible element with this role and accessible name (polls; see FIND_SCRIPT). */
  byRole(role: Role, name: string | null, opts?: { level?: number; within?: string; timeoutMs?: number }): Promise<string>;
  /** How many visible elements have this role and name now. */
  countByRole(role: Role, name: string | null, opts?: { level?: number; within?: string }): Promise<number>;
  /** The text of the visible elements with this role inside `within` (or the page). */
  textsByRole(role: Role, opts?: { within?: string }): Promise<string[]>;
  /** Types `path` into the native file dialog titled `title` and confirms it (see the file comment). */
  pickInFileDialog(title: string, path: string): Promise<void>;
  /** Closes the main window as its close button does: the window manager's WM_DELETE_WINDOW (x11.ts). */
  closeWithCloseButton(): Promise<void>;
  /** Stops everything this run started that is still running, and removes the temporary folder. */
  dispose(): Promise<void>;
}

export type Role = "button" | "textbox" | "heading" | "dialog" | "navigation" | "region" | "list" | "listitem" | "table" | "checkbox" | "alert";

/**
 * Finds visible elements by role and accessible name in the page, as a keyboard or screen-reader
 * user finds them (the browser suite's getByRole, reduced to what this scenario needs): the role
 * from the element (or its role attribute), the name from aria-labelledby, aria-label, its labels,
 * a table's caption, or its own text. `name` null: any name.
 */
const FIND_SCRIPT = `
const [role, name, level, within] = arguments;
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const SEL = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  textbox: 'input:not([type]), input[type="text"], input[type="search"], textarea, [role="textbox"]',
  heading: level ? 'h' + level : 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  dialog: 'dialog, [role="dialog"], [role="alertdialog"]',
  navigation: 'nav, [role="navigation"]',
  region: 'section[aria-label], section[aria-labelledby], [role="region"]',
  list: 'ul, ol, [role="list"]',
  listitem: 'li, [role="listitem"]',
  table: 'table, [role="table"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  alert: '[role="alert"]',
};
const text = (el) => norm(el.innerText !== undefined ? el.innerText : el.textContent);
const nameOf = (el) => {
  const by = el.getAttribute("aria-labelledby");
  if (by) return norm(by.split(/\\s+/).map((id) => { const t = document.getElementById(id); return t ? text(t) : ""; }).join(" "));
  const label = el.getAttribute("aria-label");
  if (label) return norm(label);
  if (el.labels && el.labels.length) return norm(Array.from(el.labels).map(text).join(" "));
  if (el.tagName === "TABLE" && el.caption) return text(el.caption);
  if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit")) return norm(el.value);
  if (["button", "heading", "listitem", "checkbox"].includes(role)) return text(el);
  return "";
};
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
const scope = within || document;
return Array.from(scope.querySelectorAll(SEL[role])).filter((el) => visible(el) && (name === null || nameOf(el) === name));
`;

/** Starts the app under WebDriver on a private display and bus; see the file comment. */
export async function startDesktop(): Promise<Desktop> {
  const missing = checkPrerequisites();
  if (missing.length) throw new Error(`The desktop end-to-end test cannot run here:\n- ${missing.join("\n- ")}`);
  const root = mkdtempSync(join(tmpdir(), "ao-desktop-e2e-"));
  for (const d of ["home", "config", "data", "cache", "runtime", "libraries", "files"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  const children: ChildProcess[] = [];
  let output = "";
  const collect = (child: ChildProcess) => {
    const take = (d: Buffer) => {
      output += d.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
  };
  const dispose = async () => {
    // The drivers, the display and the bus; then anything of this run still running (a failed run's app and helpers).
    for (const c of [...children].reverse()) if (c.pid && c.exitCode === null && c.signalCode === null) killAll([...descendants(c.pid), c.pid]);
    await sleep(200);
    killAll(processesMarkedBy(root, []));
    rmSync(root, { recursive: true, force: true });
  };

  try {
    // The private display.
    const xvfb = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1400x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(xvfb);
    const display = await Promise.race([
      new Promise<string>((done, fail) => {
        xvfb.stdout!.once("data", (d) => done(`:${String(d).trim()}`));
        xvfb.once("exit", () => fail(new Error("Xvfb did not start")));
      }),
      sleep(30_000).then(() => Promise.reject(new Error("Xvfb did not report its display within 30 s"))),
    ]);
    // The private session bus.
    const dbus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(dbus);
    const bus = await Promise.race([
      new Promise<string>((done, fail) => {
        let out = "";
        dbus.stdout!.on("data", (d) => {
          out += String(d);
          if (out.includes("\n")) done(out.split("\n")[0]!.trim());
        });
        dbus.once("exit", () => fail(new Error("dbus-daemon did not start")));
      }),
      sleep(30_000).then(() => Promise.reject(new Error("dbus-daemon did not report its address within 30 s"))),
    ]);
    // The worker (the development one through a small start script, as the launch check does).
    const w = findWorker()!;
    let workerBin = w.bin;
    if (w.dev) {
      workerBin = join(root, "dev-worker.sh");
      writeFileSync(workerBin, `#!/bin/sh\nexec env -u PWD '${w.dev.replaceAll("'", "'\\''")}' -m ao_worker\n`);
      chmodSync(workerBin, 0o755);
    }
    const env = desktopEnv(root, { display, bus, workerBin, nodeBin: process.execPath, serviceDir: SERVICE_DIR, path: process.env.PATH ?? "/usr/bin:/bin" });
    const port = await freePort();
    const nativePort = await freePort();
    const driver = spawn(findTauriDriver()!, ["--port", String(port), "--native-port", String(nativePort)], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    children.push(driver);
    collect(driver);
    const base = `http://127.0.0.1:${port}`;
    // tauri-driver listens shortly after it starts; the session request then starts WebKitWebDriver and the app.
    const session = await until("tauri-driver to start a session", 90_000, async () => {
      if (driver.exitCode !== null) throw new Error(`tauri-driver exited (${driver.exitCode})`);
      try {
        return await newSession(base, { "tauri:options": { application: SHELL } }, { commandTimeoutMs: 120_000 });
      } catch (err) {
        if (err instanceof Error && /ECONNREFUSED|fetch failed/.test(err.message)) return undefined;
        throw err;
      }
    });
    const failedStart = () => {
      const f = readShellLog(output).startFailure;
      if (f) throw new Error(`the app could not start: ${f}`);
    };
    const shellPid = await until("the app's process under the drivers", 60_000, () => {
      failedStart();
      return descendants(driver.pid!).find((p) => running(p) && cmdline(p).startsWith(SHELL));
    });
    const servicePid = await until("the library service under the app", 120_000, () => {
      failedStart();
      if (!running(shellPid)) throw new Error("the app exited before its service started");
      return readShellLog(output).port !== undefined ? descendants(shellPid).find((p) => running(p) && /service\.mjs/.test(cmdline(p))) : undefined;
    });
    const shell = { shellPid, servicePid };
    const drivers = () => [driver.pid!, ...descendants(driver.pid!)].filter((p) => p !== shell.shellPid && !isUnder(p, shell.shellPid));
    const isUnder = (p: number, ancestor: number) => {
      for (let q = p, i = 0; q > 1 && i < 64; i++) {
        if (q === ancestor) return true;
        q = Number(stat(q)?.[1] ?? 0);
      }
      return false;
    };
    const find = (role: Role, name: string | null, opts: { level?: number; within?: string } = {}) =>
      session.execute<unknown[]>(FIND_SCRIPT, [role, name, opts.level ?? null, opts.within ? session.element(opts.within) : null]);
    const X = (args: string[]) => spawnSync("xdotool", args, { env: { PATH: env.PATH!, DISPLAY: display }, encoding: "utf8", timeout: 20_000 });
    /** The visible windows on the private display, with their titles. */
    const windows = () => X(["search", "--onlyvisible", "--name", "."]).stdout.split("\n").filter(Boolean).map((id) => ({ id, name: X(["getwindowname", id]).stdout.trim() }));

    const desktop: Desktop = {
      root,
      librariesDir: join(root, "libraries"),
      filesDir: join(root, "files"),
      appDataDir: join(root, "data", APP_IDENTIFIER),
      session,
      shell,
      log: () => output,
      shellLog: () => readShellLog(output),
      helpers: () => [shell.servicePid, ...descendants(shell.servicePid)].filter(running),
      appProcesses: () => processesMarkedBy(root, drivers()),
      async byRole(role, name, opts = {}) {
        let count = 0;
        const el = await until(`one ${role}${name === null ? "" : ` named "${name}"`}`, opts.timeoutMs ?? 30_000, async () => {
          const hits = await find(role, name, opts);
          count = hits.length;
          return hits.length === 1 ? hits[0] : undefined;
        }).catch((err: Error) => {
          throw new Error(`${err.message}${count > 1 ? ` (found ${count})` : ""}`);
        });
        return elementId(el);
      },
      async countByRole(role, name, opts = {}) {
        return (await find(role, name, opts)).length;
      },
      async textsByRole(role, opts = {}) {
        const hits = await find(role, null, opts);
        return Promise.all(hits.map((h) => session.text(elementId(h))));
      },
      async pickInFileDialog(title, path) {
        const win = await until(`the native file dialog "${title}"`, 30_000, () => windowTitled(windows(), title));
        // No window manager on the private display: give the dialog the keyboard focus directly.
        for (const args of [["windowfocus", "--sync", win], ["key", "--clearmodifiers", "ctrl+l"], ["type", "--delay", "25", path]]) {
          const r = X(args);
          if (r.status !== 0) throw new Error(`xdotool ${args[0]} failed: ${r.stderr}`);
          await sleep(300);
        }
        const r = X(["key", "--clearmodifiers", "Return"]);
        if (r.status !== 0) throw new Error(`xdotool key Return failed: ${r.stderr}`);
        await until(`the native file dialog "${title}" to close`, 30_000, () => windowTitled(windows(), title) === undefined);
      },
      async closeWithCloseButton() {
        const win = windowTitled(windows(), WINDOW_TITLE);
        if (!win) throw new Error(`no visible window titled "${WINDOW_TITLE}" on the display`);
        await requestWindowClose(socketPathFor(display), Number(win));
      },
      dispose,
    };
    return desktop;
  } catch (err) {
    const tail = output.slice(-6000);
    await dispose();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- the drivers' and the app's output (end) ---\n${tail}`);
  }
}
