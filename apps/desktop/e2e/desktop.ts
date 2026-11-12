/**
 * The desktop end-to-end harness (Task 37h): the built Linux app, started and driven the way the
 * Tauri project supports on Linux, through WebDriver.
 *
 *   test ──WebDriver──▶ tauri-driver ──▶ WebKitWebDriver ──▶ the app (debug build) in its real web view
 *
 * Per run, under the run's temporary folder in os.tmpdir() (lifetime.ts: every process it starts
 * gets HOME and the XDG per-user folders there, and is stopped however the test ends):
 *  - a private X display (Xvfb, `-displayfd`), so nothing appears on, or types into, a person's own
 *    screen, and a private D-Bus session bus (the shell's single-instance guard and GTK use one; what
 *    the bus starts, such as dconf with GTK's file-chooser settings, stays in the run's folder too);
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
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Fatal, cmdline, descendants, parentOf, processesMarkedBy, running, runEnv, staleRuns, startedByBus, until, type RunLifetime } from "./lifetime.js";
import { elementId, newSession, WebDriverError, type Session } from "./webdriver.js";
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

/** The environment of Xvfb, the D-Bus session bus (and so what it starts) and xdotool: the run's own folders. */
export function displayEnv(root: string, p: { path: string; display?: string }): Record<string, string> {
  return runEnv(root, { PATH: p.path, ...(p.display ? { DISPLAY: p.display } : {}) });
}

/** The environment tauri-driver (and so WebKitWebDriver and the app) gets: only this, nothing inherited. */
export function desktopEnv(root: string, p: EnvParts): Record<string, string> {
  return {
    ...runEnv(root, { PATH: p.path }),
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

/**
 * What the scenario compares in the real home folder before and after a run: only the places where
 * this run's own programs would write if one of them reached the real home, so that other programs of
 * a person's session (a browser, an editor, a desktop) can run alongside without failing it:
 *  - GTK and GLib: GSettings/dconf (`.config/dconf`, where GTK keeps the file chooser's settings),
 *    `.config/gtk-3.0` (bookmarks), `.config/glib-2.0`, `.local/share/recently-used.xbel`;
 *  - the session services the bus starts: the portals' permission store (`.local/share/flatpak/db`),
 *    the document portal's fallback (`.cache/doc`) and `.config/xdg-desktop-portal`;
 *  - WebKitGTK and the app: its data and cache folders under the app identifier and under its
 *    program name, `webkitgtk` under data and cache, the library service's default settings folder
 *    (`.config/alexandrine-oxiana`) and the app's state folder.
 * Not compared: everything else, including shared caches every GL, GStreamer or GLib program writes
 * (`.cache/mesa_shader_cache`, `.cache/gstreamer-1.0`, `.cache/fontconfig`, `.cache/dconf`). That
 * this run's processes write none of those is shown by the per-process check instead: each of them
 * has HOME and every XDG folder inside the run's folder. A change a person's own GTK programs make to
 * `.config/dconf` during the run would still be reported (it is the file this check exists for).
 */
export const HOME_WATCHED = [
  ".config/dconf",
  ".config/gtk-3.0",
  ".config/glib-2.0",
  ".local/share/recently-used.xbel",
  ".local/share/flatpak/db",
  ".cache/doc",
  ".config/xdg-desktop-portal",
  `.config/${APP_IDENTIFIER}`,
  `.local/share/${APP_IDENTIFIER}`,
  `.cache/${APP_IDENTIFIER}`,
  `.local/state/${APP_IDENTIFIER}`,
  ".config/alexandrine-oxiana",
  ".local/share/alexandrine-oxiana",
  ".cache/alexandrine-oxiana",
  ".local/share/webkitgtk",
  ".cache/webkitgtk",
];

/** Path (relative to `home`) → modification time, of every file and folder under the watched folders. */
export function snapshotHome(home: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (rel: string) => {
    let st;
    try {
      st = lstatSync(join(home, rel));
    } catch {
      return;
    }
    out.set(rel, st.mtimeMs);
    if (!st.isDirectory()) return;
    for (const name of readdirSync(join(home, rel))) walk(`${rel}/${name}`);
  };
  for (const w of HOME_WATCHED) walk(w);
  return out;
}

/** What was created or modified between two snapshots ("created <path>", "modified <path>"), sorted. */
export function homeChanges(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [p, t] of after) {
    if (!before.has(p)) out.push(`created ${p}`);
    else if (before.get(p) !== t && !(after.has(p) && isDirWithOnlyCreatedChildren(p, before, after))) out.push(`modified ${p}`);
  }
  return out.sort();
}

/** A folder whose time changed only because an entry was created in it is reported through that entry. */
function isDirWithOnlyCreatedChildren(dir: string, before: Map<string, number>, after: Map<string, number>): boolean {
  const prefix = `${dir}/`;
  let child = false;
  for (const p of after.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/") && !before.has(p)) child = true;
  return child;
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

export { cmdline, running, until };

// ---------- the run ----------

export interface Desktop {
  /** The run's folder (lifetime.ts). */
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
  /** The processes of this run apart from the display, the bus and the session services it started, and the drivers: the app, its web view processes, the helpers. */
  appProcesses(): number[];
  /** Every process of the run now: the display, the bus and what it started, the drivers, the app and its helpers. */
  runProcesses(): number[];
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
}

export type Role = "button" | "link" | "textbox" | "heading" | "dialog" | "navigation" | "region" | "list" | "listitem" | "table" | "checkbox" | "alert";

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
  link: 'a[href], [role="link"]',
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
  if (["button", "link", "heading", "listitem", "checkbox"].includes(role)) return text(el);
  return "";
};
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
const scope = within || document;
return Array.from(scope.querySelectorAll(SEL[role])).filter((el) => visible(el) && (name === null || nameOf(el) === name));
`;

/** Reads the first line a child prints on standard output (its display number, its bus address). */
function firstLine(child: ReturnType<RunLifetime["spawn"]>, what: string, ms: number): Promise<string> {
  return new Promise((done, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Fatal(`${what} did not report within ${ms / 1000} s`)), ms);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("\n")) {
        clearTimeout(timer);
        done(out.split("\n")[0]!.trim());
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(new Fatal(`${what} could not be started: ${e.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Fatal(`${what} exited (${code}) before it reported`));
    });
  });
}

/**
 * Starts the app under WebDriver on a private display and bus, inside `run` (see the file comment).
 * Every process is started through `run`, so the `run` fixture stops all of them whatever happens.
 */
export async function startDesktop(run: RunLifetime): Promise<Desktop> {
  const missing = checkPrerequisites();
  if (missing.length) throw new Error(`The desktop end-to-end test cannot run here:\n- ${missing.join("\n- ")}`);
  // What an earlier test runner killed outright left behind (nothing in-process can clean that up):
  // said plainly here, before this run adds to it, with how to remove it (apps/desktop/README.md).
  const stale = staleRuns();
  if (stale.length) {
    const lines = stale.map((r) => `${r.root} (owner ${r.owner ?? "unknown"}, gone): ${r.processes.length} process(es) still running${r.processes.length ? ` [${r.processes.map((p) => `${p} ${cmdline(p).slice(0, 60)}`).join("; ")}]` : ""}${r.mounts.length ? `, still mounted: ${r.mounts.join(", ")}` : ""}`);
    throw new Fatal(
      `An earlier desktop end-to-end run was killed and left this behind:\n- ${lines.join("\n- ")}\n` +
        `Remove it as apps/desktop/README.md says ("If a run was killed"), then run the test again.`,
    );
  }
  const root = run.root;
  for (const d of ["libraries", "files"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  const path = process.env.PATH ?? "/usr/bin:/bin";

  // The private display and the private session bus, both with the run's own folders.
  const xvfb = run.spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1400x900x24", "-nolisten", "tcp"], displayEnv(root, { path }), { keepStdout: true });
  const display = `:${await firstLine(xvfb, "Xvfb", 30_000)}`;
  const dbus = run.spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], displayEnv(root, { path, display }), { keepStdout: true });
  const bus = await firstLine(dbus, "dbus-daemon", 30_000);
  // The worker (the development one through a small start script, as the launch check does).
  const w = findWorker()!;
  let workerBin = w.bin;
  if (w.dev) {
    workerBin = join(root, "dev-worker.sh");
    writeFileSync(workerBin, `#!/bin/sh\nexec env -u PWD '${w.dev.replaceAll("'", "'\\''")}' -m ao_worker\n`);
    chmodSync(workerBin, 0o755);
  }
  const env = desktopEnv(root, { display, bus, workerBin, nodeBin: process.execPath, serviceDir: SERVICE_DIR, path });
  const port = await freePort();
  const nativePort = await freePort();
  const driver = run.spawn(findTauriDriver()!, ["--port", String(port), "--native-port", String(nativePort)], env);
  const base = `http://127.0.0.1:${port}`;
  // tauri-driver listens shortly after it starts. Only "not listening yet" is waited out; any other
  // answer (a refused session, a driver that exited) fails at once with its cause.
  const session = await until("tauri-driver to start a session", 90_000, async () => {
    if (driver.exitCode !== null || driver.signalCode !== null) throw new Fatal(`tauri-driver exited (${driver.exitCode ?? driver.signalCode})`);
    try {
      return await newSession(base, { "tauri:options": { application: SHELL } }, { commandTimeoutMs: 120_000 });
    } catch (err) {
      if (err instanceof Error && !(err instanceof WebDriverError) && /ECONNREFUSED|fetch failed/.test(err.message)) return undefined;
      throw new Fatal(`the app could not be started through WebDriver: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // On every way out of the run: end the WebDriver session, so that WebKitWebDriver ends cleanly
  // before its process group is stopped (an error here is expected once the app has closed).
  run.defer(() => session.delete());
  const failedStart = () => {
    const f = readShellLog(run.log()).startFailure;
    if (f) throw new Fatal(`the app could not start: ${f}`);
  };
  const shellPid = await until("the app's process under the drivers", 60_000, () => {
    failedStart();
    return descendants(driver.pid!).find((p) => running(p) && cmdline(p).startsWith(SHELL));
  });
  const servicePid = await until("the library service under the app", 120_000, () => {
    failedStart();
    if (!running(shellPid)) throw new Fatal("the app exited before its service started");
    return readShellLog(run.log()).port !== undefined ? descendants(shellPid).find((p) => running(p) && /service\.mjs/.test(cmdline(p))) : undefined;
  });
  const shell = { shellPid, servicePid };
  const isUnder = (p: number, ancestor: number) => {
    for (let q = p, i = 0; q > 1 && i < 64; i++) {
      if (q === ancestor) return true;
      q = parentOf(q);
    }
    return false;
  };
  const infrastructure = () => [xvfb.pid!, dbus.pid!, ...descendants(dbus.pid!), driver.pid!, ...descendants(driver.pid!)].filter((p) => p !== shell.shellPid && !isUnder(p, shell.shellPid));
  // A window or session that is gone cannot come back: that ends any wait at once.
  const find = (role: Role, name: string | null, opts: { level?: number; within?: string } = {}) =>
    session.execute<unknown[]>(FIND_SCRIPT, [role, name, opts.level ?? null, opts.within ? session.element(opts.within) : null]).catch((err: unknown) => {
      if (err instanceof WebDriverError && ["no such window", "invalid session id"].includes(err.code)) throw new Fatal(err.message);
      throw err;
    });
  const xEnv = displayEnv(root, { path, display });
  const X = (args: string[]) => run.run("xdotool", args, xEnv);
  /** The visible windows on the private display, with their titles. */
  const windows = () => X(["search", "--onlyvisible", "--name", "."]).stdout.split("\n").filter(Boolean).map((id) => ({ id, name: X(["getwindowname", id]).stdout.trim() }));
  const xdo = (args: string[]) => {
    const r = X(args);
    if (r.status !== 0) throw new Error(`xdotool ${args.join(" ")} failed: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
    return r.stdout.trim();
  };
  /** Fails loudly unless `win` has the keyboard focus (no window manager: focus is set directly). */
  const focused = async (win: string, title: string) => {
    xdo(["windowfocus", "--sync", win]);
    await until(`the keyboard focus on "${title}"`, 5_000, () => {
      if (windowTitled(windows(), title) !== win) throw new Fatal(`the window "${title}" is gone`);
      return xdo(["getwindowfocus"]) === win;
    });
  };

  return {
    root,
    librariesDir: join(root, "libraries"),
    filesDir: join(root, "files"),
    appDataDir: join(root, "data", APP_IDENTIFIER),
    session,
    shell,
    log: () => run.log(),
    shellLog: () => readShellLog(run.log()),
    helpers: () => [shell.servicePid, ...descendants(shell.servicePid)].filter(running),
    appProcesses: () => processesMarkedBy(root, infrastructure()).filter((p) => !startedByBus(p)),
    runProcesses: () => [...new Set([...[xvfb.pid!, dbus.pid!, driver.pid!].flatMap((p) => [p, ...descendants(p)]), ...processesMarkedBy(root, [])])].filter(running),
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
      // Each key press goes to the window with the focus: confirm it is the dialog before each part.
      await focused(win, title);
      xdo(["key", "--clearmodifiers", "ctrl+l"]);
      await sleep(200);
      await focused(win, title);
      xdo(["type", "--delay", "25", path]);
      await sleep(200);
      await focused(win, title);
      xdo(["key", "--clearmodifiers", "Return"]);
      await until(`the native file dialog "${title}" to close`, 30_000, () => windowTitled(windows(), title) === undefined);
    },
    async closeWithCloseButton() {
      const win = windowTitled(windows(), WINDOW_TITLE);
      if (!win) throw new Error(`no visible window titled "${WINDOW_TITLE}" on the display`);
      await requestWindowClose(socketPathFor(display), Number(win));
    },
  };
}
