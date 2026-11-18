#!/usr/bin/env node
// The desktop shell's launch check (Task 37c, R155), on Linux under a virtual display and on a Mac
// (Task 37f) with the app bundle the Mac build made. It starts the
// built shell (`build:linux` first) the way a person would, with NODE_ENV=test so that the debug
// build reports on its standard output what this check needs (never the token), and checks:
//
//  A. normal close: the service answers and the worker reports ready, through the page itself (the
//     in-page probe: a fetch, the event stream, the worker, a blob: picture, audio and video from
//     media ticket addresses, under the app's origin and content-security policy); the window
//     exists; the page may call only the commands granted to it; the helpers get an allow-listed
//     environment with no token in it or on their command line; a second launch hands over to the
//     first and exits; closing the window stops both helpers cleanly and leaves no process.
//  B. the shell stopped with SIGTERM: the same orderly stop, exit 0, no process left.
//  C. the shell killed with SIGKILL: the service sees its standard input close and stops, and the
//     worker sees the same from the service (R155 rule 3); no process left.
//  D. a service that refuses to start: the shell reports the failure in the service's own plain
//     words, opens no app window, leaves no process, and exits non-zero.
//
//   pnpm --filter @ao/desktop run launch-check            (node apps/desktop/scripts/launch-check.mjs)
//
// On a Mac (Task 37f; no virtual display: GitHub's Mac runners have a logged-in desktop session):
//
//   node apps/desktop/scripts/launch-check.mjs --app <the DEBUG .app>       scenarios A-E
//   node apps/desktop/scripts/launch-check.mjs --release-app <the .app>     scenario R only
//
// With --app the shell runs from inside the bundle and finds Node, the service folder and the worker
// in its Contents/Resources, as a person's copy does (no AO_DESKTOP_* overrides, except scenario D's
// stand-in service). Scenario R takes the release app (from the mounted disk image), which prints
// nothing for this check: it waits for the service (Resources/node/node running
// Resources/library-service/service.mjs) and the worker to appear under the shell, checks that the
// service listens on the loopback address and refuses a request without the token (HTTP 401), stops
// the shell with SIGTERM and checks that no helper is left. Processes are read with ps (and lsof)
// instead of /proc. What the Mac run is expected to show is in apps/desktop/README.md ("Building for macOS").
//
// Needs: xvfb-run, dbus-daemon, the built shell (apps/desktop/src-tauri/target/debug), the built
// service folder (apps/library-service/dist/library-service), Node 22. The worker: AO_DESKTOP_WORKER_BIN
// if set, else the packaged worker in apps/desktop/sidecars/ if built, else the development worker
// (services/media-worker/.venv, `pnpm setup:py`) through a small start script in the temporary folder.
// ffmpeg, when present, makes the audio and video files the probe attaches; without it those two
// checks are skipped and say so. Everything it writes is under one temporary folder, removed at the end.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LINUX_SHELL = join(REPO, "apps", "desktop", "src-tauri", "target", "debug", "alexandrine-oxiana");
const MAC = process.platform === "darwin";
let SHELL = LINUX_SHELL;
/** Whether the shell runs from an app bundle and finds its helpers in its resources (--app on a Mac). */
let PACKAGED = false;
const SERVICE_DIR = join(REPO, "apps", "library-service", "dist", "library-service");
const SHELL_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

// ---------- pure helpers (tested in launch-check.test.mjs) ----------

/** One line of the shell's test output, or null. */
export function parseShellLine(line) {
  let m = /^AO_SHELL_SERVICE pid=(\d+) port=(\d+) shell=(\d+)$/.exec(line);
  if (m) return { kind: "service", pid: Number(m[1]), port: Number(m[2]), shell: Number(m[3]) };
  m = /^AO_SHELL_WINDOW label=(\S+) visible=(true|false)$/.exec(line);
  if (m) return { kind: "window", label: m[1], visible: m[2] === "true" };
  m = /^AO_SHELL_TITLE AO_PROBE (\{.*)$/.exec(line);
  if (m) {
    try {
      return { kind: "probe", result: JSON.parse(m[1]) };
    } catch {
      return { kind: "probe", result: null };
    }
  }
  m = /^AO_SHELL_STOPPED (clean|forced)$/.exec(line);
  if (m) return { kind: "stopped", how: m[1] };
  m = /^AO_SHELL_FAILED (.*)$/.exec(line);
  if (m) return { kind: "failed", message: m[1] };
  if (line === "AO_SHELL_SECOND_LAUNCH") return { kind: "second-launch" };
  if (line === "AO_SHELL_CLOSING") return { kind: "closing" };
  if (line === "AO_SHELL_RELAUNCH_REQUESTED") return { kind: "relaunch-requested" };
  if (line === "AO_SHELL_RELAUNCHING") return { kind: "relaunching" };
  m = /^AO_SHELL_LIBRARY (opened|fetching|handed-over|not-a-pdf|failed|closed)$/.exec(line);
  if (m) return { kind: "library", state: m[1] };
  if (line === "AO_SHELL_BROWSER_OPENED") return { kind: "browser-opened" };
  return null;
}

/** The commands the page may call: exactly these are allowed, the rest are denied (capabilities/main-window.json). */
export const EXPECTED_IPC = {
  "event.listen": "allowed",
  "dialog.save": "denied",
  "dialog.message": "denied",
  "fs.readFile": "denied",
  "path.resolveDirectory": "denied",
  "window.close": "denied",
  "webview.print": "denied",
  "app.version": "denied",
  "event.emit": "denied",
  "watch.pick": "allowed",
  // The sign-in window's six (Task F16; F19): granted to the main window, not probed (below).
  "library.open": "allowed",
  "library.take": "allowed",
  "library.close": "allowed",
  "library.signOut": "allowed",
  "library.stay": "allowed",
  "browser.open": "allowed",
};

/**
 * Commands of the table the probe does not call, with the permission that grants them: the
 * watched-folder chooser (Task W6, R207) would open a dialog and wait for a person, and the sign-in
 * window's six (Task F16) would open that window, fetch, sign out or start the researcher's browser.
 * They are judged from the capability file instead (`capabilityProblems`). (The main window's probe
 * does open the sign-in window once, for the sign-in window's own probe: `libraryWindowOpened`.)
 */
export const NOT_PROBED_IPC = {
  "watch.pick": "allow-pick-watch-folder",
  "library.open": "allow-open-library-window",
  "library.take": "allow-library-window-take-pdf",
  "library.close": "allow-close-library-window",
  "library.signOut": "allow-sign-out-of-library",
  "library.stay": "allow-set-stay-signed-in",
  "browser.open": "allow-open-in-browser",
};

/**
 * What a page in the sign-in window may call (Task F19, R343 b): nothing. Every command of the app
 * (the main window's table above, the six library commands among them), the event system's listen,
 * unlisten, emit and emit-to, the file and folder choosers, the dialog's ask and confirm, and one
 * command each of the image, resources, menu and tray families; the sign-in window's probe
 * (`src-tauri/src/library_probe.js`) tries each and reports what happened. Each must be refused.
 */
export const EXPECTED_LIBRARY_WINDOW_IPC = Object.fromEntries(
  [
    "library.open",
    "library.take",
    "library.close",
    "library.signOut",
    "library.stay",
    "browser.open",
    "watch.pick",
    "event.listen",
    "event.unlisten",
    "event.emit",
    "event.emitTo",
    "dialog.open",
    "dialog.save",
    "dialog.message",
    "fs.readFile",
    "path.resolveDirectory",
    "window.close",
    "webview.print",
    "app.version",
    // One command of each core family the main window is not granted either, and the dialog's other
    // two (R346 h).
    "image.new",
    "resources.close",
    "menu.new",
    "tray.new",
    "dialog.ask",
    "dialog.confirm",
  ].map((k) => [k, "denied"]),
);

/** The sign-in window's probe as compiled into debug builds (the commands it tries are checked against the table). */
export const LIBRARY_PROBE_JS = readFileSync(join(REPO, "apps", "desktop", "src-tauri", "src", "library_probe.js"), "utf8");

/** What is wrong with the sign-in window's probe report (empty when everything was refused). */
export function libraryProbeProblems(r) {
  if (!r || typeof r !== "object") return ["the sign-in window's probe reported nothing"];
  const out = [];
  if (r.probe !== "library") out.push("the report is not the sign-in window's probe");
  if (!/^https?:\/\//.test(String(r.origin))) out.push(`the probe ran in ${r.origin}, not in an outside page`);
  // Without Tauri's IPC object in the page nothing can be called at all: each command is "no IPC".
  const want = r.internals === true ? "denied" : "no IPC";
  for (const cmd of Object.keys(EXPECTED_LIBRARY_WINDOW_IPC)) {
    const got = r.ipc?.[cmd];
    if (got !== want) out.push(`the sign-in window's command ${cmd} is ${got ?? "not reported"}, expected ${want}`);
  }
  if (!r.raw || typeof r.raw !== "object") out.push("the raw entry points were not tried");
  else for (const [k, v] of Object.entries(r.raw)) if (v === "allowed") out.push(`the raw entry point ${k} was allowed`);
  if (r.error) out.push(`the probe failed: ${r.error}`);
  return out;
}

/** The report in a request to the check's report address (`/report?r=<json>`): null when unreadable, undefined for any other address. */
export function libraryReportFrom(path) {
  const u = new URL(path, "http://127.0.0.1");
  if (u.pathname !== "/report") return undefined;
  try {
    return JSON.parse(u.searchParams.get("r") ?? "");
  } catch {
    return null;
  }
}

export const CAPABILITIES_DIR = join(REPO, "apps", "desktop", "src-tauri", "capabilities");
export const TAURI_CONF = join(REPO, "apps", "desktop", "src-tauri", "tauri.conf.json");
/** Exactly what the main window is granted, in this order (the last six: the library sign-in window, Task F16). */
export const MAIN_WINDOW_PERMISSIONS = [
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "dialog:allow-open",
  "allow-pick-watch-folder",
  "allow-open-library-window",
  "allow-library-window-take-pdf",
  "allow-close-library-window",
  "allow-sign-out-of-library",
  "allow-set-stay-signed-in",
  "allow-open-in-browser",
];
const CAPABILITY_KEYS = new Set(["$schema", "identifier", "description", "windows", "local", "permissions"]);

/**
 * What is wrong with the shell's capabilities (empty when all is well): one capability file, the one
 * tauri.conf.json names, for the main window only, local pages only (no remote origin), granting
 * exactly MAIN_WINDOW_PERMISSIONS; and no platform file Tauri merges over the configuration
 * (`platform`: tauri.macos.conf.json and the like) sets anything under app.security.
 */
export function capabilityProblems({ files, capability, conf, platform = [] }) {
  const out = [];
  // Tauri merges tauri.<platform>.conf.* over tauri.conf.json on that platform: none may touch security.
  for (const { name, conf: pc } of platform) {
    if (!pc || typeof pc !== "object") out.push(`${name} could not be checked (not readable as JSON), and Tauri would merge it over the configuration`);
    else if (pc.app && typeof pc.app === "object" && "security" in pc.app) out.push(`${name} sets app.security, which Tauri would merge over the main window's capability`);
  }
  const others = files.filter((f) => f !== "main-window.json");
  if (others.length) out.push(`the capabilities folder holds more than main-window.json: ${others.join(", ")}`);
  const listed = conf?.app?.security?.capabilities;
  if (JSON.stringify(listed) !== JSON.stringify(["main-window"])) out.push(`tauri.conf.json names the capabilities ${JSON.stringify(listed)}, not only "main-window"`);
  if (!capability || typeof capability !== "object") return [...out, "the main window's capability file is not readable"];
  for (const k of Object.keys(capability)) if (!CAPABILITY_KEYS.has(k)) out.push(`the main window's capability has the key ${k} (${k === "remote" ? "a remote origin" : k === "webviews" ? "webviews" : "extra"})`);
  if (capability.identifier !== "main-window") out.push(`the capability's identifier is ${capability.identifier}`);
  if (JSON.stringify(capability.windows) !== JSON.stringify(["main"])) out.push(`the capability applies to the windows ${JSON.stringify(capability.windows)}, not only "main"`);
  if (capability.local !== true) out.push("the capability is not limited to the app's local pages");
  const perms = Array.isArray(capability.permissions) ? capability.permissions : [];
  for (const p of perms) if (!MAIN_WINDOW_PERMISSIONS.includes(typeof p === "string" ? p : p?.identifier)) out.push(`the main window's capability grants ${typeof p === "string" ? p : JSON.stringify(p)}`);
  for (const p of MAIN_WINDOW_PERMISSIONS) if (!perms.includes(p)) out.push(`the main window's capability does not grant ${p}`);
  return out;
}

/** The platform configuration files Tauri merges over tauri.conf.json (any format), present beside it. */
export function platformConfFiles() {
  return readdirSync(dirname(TAURI_CONF)).filter((f) => /^tauri\.(macos|linux|windows|android|ios)\.conf\.(json|json5|toml)$/i.test(f) || /^Tauri\.(macos|linux|windows|android|ios)\.toml$/i.test(f));
}

/** The capability check on the files as they are (see `capabilityProblems`). */
export function capabilityFileProblems() {
  try {
    const platform = platformConfFiles().map((name) => {
      let conf = null;
      if (name.endsWith(".json")) {
        try {
          conf = JSON.parse(readFileSync(join(dirname(TAURI_CONF), name), "utf8"));
        } catch {
          conf = null;
        }
      }
      return { name, conf };
    });
    return capabilityProblems({
      files: readdirSync(CAPABILITIES_DIR),
      capability: JSON.parse(readFileSync(join(CAPABILITIES_DIR, "main-window.json"), "utf8")),
      conf: JSON.parse(readFileSync(TAURI_CONF, "utf8")),
      platform,
    });
  } catch (err) {
    return [`the capability files could not be read: ${err.message}`];
  }
}

/** What is wrong with the probe's result (empty when all is well). */
export function probeProblems(result, { media }) {
  if (!result || typeof result !== "object") return ["the probe reported nothing readable"];
  const out = [];
  if (!SHELL_ORIGINS.includes(result.origin)) out.push(`the page's origin is ${result.origin}, not one of the service's shell origins`);
  if (result.connectionRemovedByApp !== true) out.push("the app did not take (and remove) the connection it was handed");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(result.baseUrl))) out.push("the connection's address is not the loopback address");
  const ok = (k) => typeof result[k] === "string" && result[k].startsWith("ok");
  for (const k of ["fetch", "events", "library", "worker", "picture", ...(media ? ["audio", "video"] : [])]) {
    if (!ok(k)) out.push(`${k}: ${result[k] ?? "not reported"}`);
  }
  for (const [cmd, want] of Object.entries(EXPECTED_IPC)) {
    const got = result.ipc?.[cmd];
    if (got === undefined && cmd in NOT_PROBED_IPC) continue;
    if (got !== want) out.push(`the page's command ${cmd} is ${got ?? "not reported"}, expected ${want}`);
  }
  if (result.error) out.push(`the probe failed: ${result.error}`);
  return out;
}

/** Variable names the service may receive from the shell (helper_env.rs) or the service passes to the worker. */
const HELPER_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE", "TZ", "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "TESSDATA_PREFIX",
  "AO_SERVICE_PORT", "AO_CONFIG_DIR", "AO_TOOLS_DIR", "AO_MODELS_DIR", "AO_WORKER_BIN", "AO_NO_WORKER",
  // set by the service for the worker (worker-client.ts)
  "AO_WORKER_PORT", "PYTHONUNBUFFERED",
]);

/** Problems with a helper's environment names and command line (a token, or a name off the allow-list). */
export function helperProblems(who, envNames, cmdline) {
  const out = [];
  for (const n of envNames) {
    if (/TOKEN|PASSPHRASE/i.test(n)) out.push(`${who} has ${n} in its environment`);
    else if (!HELPER_NAMES.has(n) && !/^(LC_|XDG_)/.test(n)) out.push(`${who} received ${n}, which is not on the allow-list`);
  }
  if (/[0-9a-f]{64}/i.test(cmdline)) out.push(`${who}'s command line carries a token-like value`);
  return out;
}

export function parseArgs(argv) {
  const out = { app: undefined, releaseApp: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v) throw new Error(`${flag} needs the path of an app bundle (.app)`);
      return v;
    };
    if (flag === "--") continue;
    else if (flag === "--app") out.app = value();
    else if (flag === "--release-app") out.releaseApp = value();
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return out;
}

/** The shell's program inside an app bundle. */
export const shellOf = (app) => join(app, "Contents", "MacOS", "alexandrine-oxiana");

/** `ps -o pid=,ppid=,stat=,command=` lines: [{pid, ppid, state (first letter of stat), cmd}]. */
export function parsePs(text) {
  return text.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3][0], cmd: m[4] }));
}

/**
 * The names of the variables `ps -E` prints after a process's command line (`withEnv`), given the
 * command line alone (`cmd`). A value holding " NAME=" would read as one more name: the check then
 * reports a name too many, never one too few.
 */
export function envNamesFromPsE(withEnv, cmd) {
  if (!withEnv) return null;
  const tail = withEnv.startsWith(cmd) ? withEnv.slice(cmd.length) : withEnv;
  const names = [...tail.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
  return names.length ? names : null;
}

/** The names in a Linux /proc/<pid>/environ (NUL-separated NAME=value), or null when nothing could be read. */
export function envNamesFromEnviron(text) {
  const names = text.split("\0").filter(Boolean).map((kv) => kv.slice(0, kv.indexOf("=")));
  return names.length ? names : null;
}

/**
 * Fail closed: an environment that could not be read, or that lacks names the helper is known to
 * have (so what was read cannot be trusted), is a failure, never a pass.
 */
export function envEvidenceProblems(who, names, required) {
  if (names === null) return [`could not check: ${who}'s environment could not be read`];
  const missing = required.filter((n) => !names.includes(n));
  return missing.length ? [`could not check: ${who}'s environment as read lacks ${missing.join(", ")}, which it must have`] : [];
}

/** The names the service and the worker always have (helper_env.rs; worker-client.ts). */
export const SERVICE_MUST_HAVE = ["PATH", "AO_SERVICE_PORT", "AO_CONFIG_DIR"];
export const WORKER_MUST_HAVE = ["AO_WORKER_PORT"];

/** Processes of any copy of the app: its program, and the helpers in its resources. */
export function appProcesses(table, binary = "alexandrine-oxiana") {
  return table.filter((p) => p.cmd.includes(`.app/Contents/MacOS/${binary}`) || /\.app\/Contents\/Resources\/(node\/node|ao-worker\/ao-worker)\b/.test(p.cmd));
}

/** `lsof -iTCP -sTCP:LISTEN` lines: the addresses a process listens on. */
export function parseLsofListen(text) {
  return [...text.matchAll(/TCP (\[[^\]]+\]|[^\s:]+):(\d+) \(LISTEN\)/g)].map((m) => ({ host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) }));
}

// ---------- a Mac crash at start-up: where (Task MAC5) ----------
//
// When the shell dies on a Mac before its service is ready (scenarios A-C) or before its service
// started (R), the check prints what can say where: the system's crash report, a debugger's
// backtrace, and the bundle's context. Diagnostics only: nothing here changes a result or an exit
// code, every command has a time limit, every step is wrapped, and none of it runs anywhere else
// than on a Mac or when the check passes.

/** Where macOS writes the user's crash reports (ReportCrash; the real home, not the shell's HOME). */
export const CRASH_REPORT_DIR = join(homedir(), "Library", "Logs", "DiagnosticReports");
const CRASH_PROCESS = "alexandrine-oxiana";

/** At most `max` lines of a text, then one line saying how many were left out. */
export function capLines(text, max) {
  const s = String(text ?? "").replace(/\n+$/, "");
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines not shown)`;
}

/** Whether a file in the crash-report folder is a report of the app's program (.ips; .crash on older systems). */
export function isCrashReportOf(name, proc = CRASH_PROCESS) {
  return name.startsWith(proc) && /\.(ips|crash)$/.test(name);
}

/** The newest crash report of the app that was not in the folder before the start (`before`), or null. */
export function newCrashReport(before, now, proc = CRASH_PROCESS) {
  const seen = new Set(before);
  // The names end with the time of the crash (…-YYYY-MM-DD-HHMMSS…): the last by name is the newest.
  return now.filter((n) => isCrashReportOf(n, proc) && !seen.has(n)).sort().at(-1) ?? null;
}

/**
 * An .ips crash report: one line of JSON (the header), then the body as one JSON document
 * (`exception`, `termination`, `faultingThread`, `threads[n].frames[]`, `usedImages[]`). Null when
 * it cannot be read; the caller then shows the file as it is.
 */
export function parseIps(text) {
  const s = String(text ?? "");
  const nl = s.indexOf("\n");
  let body = null;
  for (const candidate of [nl === -1 ? null : s.slice(nl + 1), s]) {
    if (candidate === null) continue;
    try {
      body = JSON.parse(candidate);
      break;
    } catch {}
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const threads = Array.isArray(body.threads) ? body.threads : [];
  const thread = Number.isInteger(body.faultingThread) ? body.faultingThread : threads.findIndex((t) => t?.triggered);
  const used = Array.isArray(body.usedImages) ? body.usedImages : [];
  const imageName = (i) => used[i]?.name ?? (used[i]?.path ? String(used[i].path).split("/").at(-1) : `image ${i}`);
  const hex = (n) => (typeof n === "number" ? `0x${n.toString(16)}` : "?");
  const frames = (threads[thread]?.frames ?? []).map((f) => ({
    image: imageName(f?.imageIndex),
    symbol: f?.symbol ?? "?",
    offset: f?.symbolLocation !== undefined ? `+${f.symbolLocation} (image offset ${hex(f.imageOffset)})` : `image offset ${hex(f?.imageOffset)}`,
  }));
  const e = body.exception ?? {};
  const t = body.termination ?? {};
  return {
    exception: [e.type, e.signal && `(${e.signal})`].filter(Boolean).join(" ") + [e.codes && `, codes ${e.codes}`, e.subtype && `, ${e.subtype}`].filter(Boolean).join(""),
    termination: [[t.namespace, t.code].filter((x) => x !== undefined).join(" "), t.indicator, t.byProc && `by ${t.byProc}`].filter(Boolean).join(", "),
    thread,
    frames,
    images: used.map((_, i) => imageName(i)),
  };
}

/** The parsed report as text: at most 60 frames of the crashed thread and 40 image names. */
export function formatCrashReport(p) {
  const frames = p.frames.slice(0, 60).map((f, i) => `  #${i} ${f.image.padEnd(28)} ${f.symbol} ${f.offset}`);
  if (p.frames.length > 60) frames.push(`  … (${p.frames.length - 60} more frames not shown)`);
  const images = p.images.slice(0, 40).join(", ") + (p.images.length > 40 ? `, … (${p.images.length - 40} more)` : "");
  return [`exception: ${p.exception || "?"}`, `termination: ${p.termination || "?"}`, `crashed thread ${p.thread}:`, ...frames, `loaded images (${p.images.length}): ${images}`].join("\n");
}

// ---------- processes (Linux /proc; ps on a Mac) ----------

const ps = (args) => spawnSync("ps", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
const macTable = () => parsePs(ps(["-axww", "-o", "pid=,ppid=,stat=,command="]));

function procState(pid) {
  if (MAC) return macTable().find((p) => p.pid === pid)?.state ?? null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return null;
  }
}
const running = (pid) => {
  const s = procState(pid);
  return s !== null && s !== "Z" && s !== "X";
};
function ppidOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return -1;
  }
}
function allPids() {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
}
function descendants(root) {
  const kids = new Map();
  const table = MAC ? macTable() : allPids().map((pid) => ({ pid, ppid: ppidOf(pid) }));
  for (const { pid: p, ppid: pp } of table) {
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const out = [];
  const walk = (p) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(root);
  return out;
}
const readProc = (pid, f) => {
  try {
    return readFileSync(`/proc/${pid}/${f}`, "latin1");
  } catch {
    return "";
  }
};
const cmdline = (pid) => (MAC ? ps(["-ww", "-o", "command=", "-p", String(pid)]).trim() : readProc(pid, "cmdline").split("\0").join(" "));
/** A process's variable names, or null when they could not be read. */
const envNames = (pid) => (MAC ? envNamesFromPsE(ps(["-E", "-ww", "-o", "command=", "-p", String(pid)]).trim(), cmdline(pid)) : envNamesFromEnviron(readProc(pid, "environ")));

/** The helpers' environment check (R153), with the evidence that it could read them. */
function helperEnvProblems(svcPid, helpers) {
  return helpers.flatMap((p) => {
    const cmd = cmdline(p);
    const isWorker = p !== svcPid && /ao[-_]worker/.test(cmd);
    const who = p === svcPid ? "the service" : isWorker ? `the worker (${p})` : `helper ${p}`;
    const names = envNames(p);
    return [...envEvidenceProblems(who, names, p === svcPid ? SERVICE_MUST_HAVE : isWorker ? WORKER_MUST_HAVE : []), ...helperProblems(who, names ?? [], cmd)];
  });
}

/**
 * Whether the leftover-process search can see a process by its environment here: a stand-in process
 * carrying the marker must be found. Without that, "no process is left" would be a pass with
 * nothing checked.
 */
async function leftoverSearchWorks(marker) {
  const child = spawn("sleep", ["30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AO_LAUNCH_CHECK_MARK: marker }, stdio: "ignore" });
  try {
    await sleep(300);
    return processesMarkedBy(marker).includes(child.pid);
  } finally {
    child.kill("SIGKILL");
  }
}

/** On a Mac: stops every process of any copy of the app; returns what was found running. */
function stopAppProcesses() {
  if (!MAC) return [];
  const left = appProcesses(macTable()).filter((p) => p.pid !== process.pid);
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
  return left;
}
/** Running processes whose environment mentions `marker` (the check's temporary folder): any helper of this check. */
function processesMarkedBy(marker) {
  if (MAC) {
    return ps(["-axE", "-ww", "-o", "pid=,command="]).split("\n").filter((l) => l.includes(marker)).map((l) => Number(l.trim().split(/\s/, 1)[0])).filter((p) => p !== process.pid && running(p));
  }
  return allPids().filter((p) => p !== process.pid && running(p) && readProc(p, "environ").includes(marker));
}

/** The names in the crash-report folder ([] when it cannot be read). */
function listCrashReports(dir = CRASH_REPORT_DIR) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Runs a command with a time limit and never throws: {ok, out (standard output, then error), reason}. */
function runCapped(cmd, args, { env = process.env, timeout = 20_000 } = {}) {
  const r = spawnSync(cmd, args, { env, timeout, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error?.code === "ETIMEDOUT") return { ok: false, out, reason: `timed out after ${Math.round(timeout / 1000)} s` };
  if (r.error) return { ok: false, out, reason: r.error.code === "ENOENT" ? `not found (${r.error.message})` : r.error.message };
  if (r.status !== 0) return { ok: false, out, reason: `exit ${r.status ?? r.signal}` };
  return { ok: true, out };
}

/** The context is printed once per run of the check. */
const MAC_DIAG_STATE = { contextShown: false };

/**
 * Task MAC5: on a Mac, after the shell died before its service was ready, prints (a) the new crash
 * report in the system's folder (waiting up to 40 s for it), (b) a backtrace of the program run once
 * more under lldb with the shell's own environment and arguments (a debug build; a release build only
 * when no report came), (c) the bundle's context, once. Returns false, doing nothing, on any other
 * system. Never throws; never changes a result.
 */
export async function macCrashDiagnostics({
  platform = process.platform,
  app,
  binary,
  env,
  args = [],
  baseline = [],
  debug = false,
  reportDir = CRASH_REPORT_DIR,
  waitMs = 40_000,
  print = (s) => process.stdout.write(s),
  listDir = listCrashReports,
  readText = (p) => readFileSync(p, "utf8"),
  run = runCapped,
  sleep: wait = sleep,
  now = Date.now,
  stopApp = stopAppProcesses,
  state = MAC_DIAG_STATE,
} = {}) {
  if (platform !== "darwin") return false;
  const note = (s) => print(`launch-check: note ${s}\n`);
  const block = (title, text) => print(`--- ${title} ---\n${text}${text.endsWith("\n") ? "" : "\n"}--- end ---\n`);
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      try {
        note(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      } catch {}
    }
  };
  let reportFound = false;
  // (a) The system's crash report: a new file, written a few seconds after the crash.
  await step("the crash report", async () => {
    const end = now() + waitMs;
    let name = null;
    for (;;) {
      name = newCrashReport(baseline, listDir(reportDir));
      if (name || now() >= end) break;
      await wait(1000);
    }
    if (!name) {
      note(`no new crash report of ${CRASH_PROCESS} appeared in ${reportDir} within ${Math.round(waitMs / 1000)} s`);
      return;
    }
    reportFound = true;
    const path = join(reportDir, name);
    // Give ReportCrash a moment to finish writing the file.
    await wait(1000);
    const text = readText(path);
    const parsed = parseIps(text);
    block(`crash report: ${path}`, parsed && parsed.frames.length ? formatCrashReport(parsed) : `(not read as .ips, or no frames: the first 250 lines as they are)\n${capLines(text, 250)}`);
  });
  // (b) A debugger's backtrace: the debug build has symbols; the release build only when nothing else came.
  if (debug || !reportFound) {
    await step("lldb", async () => {
      const r = run("lldb", ["--batch", "-o", "run", "-k", "thread backtrace all", "-k", "image list -b", "-k", "quit", "--", binary, ...args], { env, timeout: 90_000 });
      const launchError = /^error: .*(launch|attach).*$/im.exec(r.out ?? "");
      if (!r.ok) note(`lldb: ${r.reason}`);
      else if (launchError) note(`lldb could not launch the program: ${launchError[0]}`);
      if (r.out?.trim()) block(`lldb ${debug ? "(the debug build)" : "(the release build, no symbols)"}`, capLines(r.out, 400));
    });
    await step("stopping what lldb started", async () => {
      const left = stopApp();
      if (left.length) note(`stopped ${left.length} process(es) of the app left after lldb`);
    });
  }
  // (c) The bundle's context, once.
  if (!state.contextShown) {
    state.contextShown = true;
    const ctx = [
      ["sw_vers", []],
      ["plutil", ["-p", join(app, "Contents", "Info.plist")]],
      ["codesign", ["-d", "--entitlements", "-", "-v", app]],
      ["otool", ["-L", binary]],
      ["ls", ["-la", join(app, "Contents", "MacOS"), join(app, "Contents", "Resources"), join(app, "Contents", "Frameworks")]],
    ];
    for (const [cmd, a] of ctx) {
      await step(cmd, async () => {
        const r = run(cmd, a, { timeout: 20_000 });
        if (!r.ok) note(`${cmd}: ${r.reason}${cmd === "ls" ? " (a missing folder is expected)" : ""}`);
        if (r.out?.trim()) block(`${cmd} ${a.join(" ")}`, capLines(r.out, 80));
      });
    }
  }
  return true;
}

/** The diagnostics for a run of the shell that died before its service (`startShell` noted what it needs). */
async function diagnoseMacCrash(run, { debug }) {
  if (!MAC) return;
  try {
    process.stdout.write(`launch-check: ${run.label}: the shell exited (${run.child.signalCode ?? `exit ${run.child.exitCode}`}); what macOS can say follows (Task MAC5)\n`);
    await macCrashDiagnostics({ app: resolve(run.shell, "..", "..", ".."), binary: run.shell, env: run.env, args: run.args, baseline: run.crashBaseline, debug });
  } catch {}
}

// ---------- running the shell ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, ms, test) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await sleep(200);
  }
}

/** Starts the shell under xvfb-run, or directly on `env.DISPLAY` when `direct` (a display the check owns). */
function startShell(env, label, { direct = MAC, shell = SHELL } = {}) {
  // Task MAC5: the crash reports already there, so that a crash of this run is told by a new one.
  const crashBaseline = MAC ? listCrashReports() : [];
  const child = direct ? spawn(shell, [], { env, stdio: ["pipe", "pipe", "pipe"] }) : spawn("xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", shell], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const events = [];
  let log = "";
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const ev = parseShellLine(line);
      if (ev) events.push(ev);
    }
  });
  child.stderr.on("data", (d) => {
    log += d.toString();
    if (log.length > 400_000) log = log.slice(-200_000);
  });
  child.stdin.on("error", () => {});
  const exit = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, label, shell, env, args: [], crashBaseline, lines, events, log: () => log, exit, find: (kind) => events.find((e) => e.kind === kind), all: (kind) => events.filter((e) => e.kind === kind) };
}

function writeProbeFiles(dir) {
  mkdirSync(dir, { recursive: true });
  const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (!haveFfmpeg) {
    // A 1×1 PNG (no tool needed); audio and video are skipped.
    writeFileSync(join(dir, "probe.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    return false;
  }
  const ff = (args) => {
    const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("ffmpeg could not make a probe file");
  };
  ff(["-f", "lavfi", "-i", "testsrc=size=64x48:rate=1", "-frames:v", "1", join(dir, "probe.png")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "-ar", "16000", join(dir, "probe.wav")]);
  ff(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-f", "lavfi", "-i", "sine=duration=2", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", join(dir, "probe.mp4")]);
  return true;
}

function workerBin(root) {
  if (PACKAGED) return { bin: undefined, kind: "packaged, in the app's resources" };
  if (process.env.AO_DESKTOP_WORKER_BIN) return { bin: process.env.AO_DESKTOP_WORKER_BIN, kind: "given" };
  const sidecars = join(REPO, "apps", "desktop", "sidecars");
  if (existsSync(sidecars)) {
    for (const d of readdirSync(sidecars)) {
      const exe = join(sidecars, d, "ao-worker");
      if (d.startsWith("ao-worker-") && existsSync(exe)) return { bin: exe, kind: "packaged" };
    }
  }
  const py = join(REPO, "services", "media-worker", ".venv", "bin", "python");
  if (!existsSync(py)) throw new Error("No media worker: build it (pnpm --filter @ao/desktop build:sidecars) or set up the development one (pnpm setup:py).");
  const script = join(root, "dev-worker.sh");
  // `env -u PWD`: the shell running this script exports PWD, which the worker would otherwise see.
  writeFileSync(script, `#!/bin/sh\nexec env -u PWD '${py.replaceAll("'", "'\\''")}' -m ao_worker\n`);
  chmodSync(script, 0o755);
  return { bin: script, kind: "development (services/media-worker/.venv)" };
}

/** The shell's environment for one run: a private home and settings under `dir`. */
function shellEnv(dir, extra) {
  for (const d of ["home", "config", "data", "cache"]) mkdirSync(join(dir, d), { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
    LANG: "C.UTF-8",
    NODE_ENV: "test",
    // A packaged app (--app) uses the Node.js and the service folder in its own resources.
    ...(PACKAGED ? {} : { AO_DESKTOP_NODE: process.execPath, AO_DESKTOP_SERVICE_DIR: SERVICE_DIR }),
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  };
}

/** Kills a process and everything under it (cleanup after a failed check: Xvfb, the shell, helpers). */
function killTree(pid) {
  for (const p of [pid, ...descendants(pid)]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
}

function report(label, ok, detail = "") {
  process.stdout.write(`launch-check: ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}\n`);
  return ok;
}

/**
 * The sign-in window's probe reports here (Task F19): plain HTTP on the loopback address. `/page` is
 * an outside page for the probe to run in; `/report?r=<json>` is its report (the first one is kept).
 * Anything else, the window's first https address included (a TLS greeting this server cannot
 * read), gets no page.
 */
async function startReportServer() {
  const { createServer } = await import("node:http");
  let got;
  const server = createServer((req, res) => {
    const r = libraryReportFrom(req.url ?? "/");
    if (r !== undefined && got === undefined) got = r;
    const page = r !== undefined ? "Reported." : new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/page" ? "An outside page." : null;
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(page ? `<!doctype html><title>Library probe</title><p>${page}</p>` : "");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    address: `http://127.0.0.1:${server.address().port}/report`,
    report: () => got,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/** Starts the shell and waits for the service, the window and the probe's result; returns the helpers' pids. */
async function upAndProbed(run, media, problems) {
  const svc = await until("the service's ready report", 120_000, async () => {
    // A start-up failure is reported at once (the shell's own report), not as a time-out.
    const failed = run.find("failed");
    if (failed) throw new Error(`the shell could not start: ${failed.message}`);
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error("the shell exited before the service was ready");
    return run.find("service");
  }).catch(async (err) => {
    // Task MAC5: a shell that died (not one that reported a failure) is examined on a Mac first.
    if ((run.child.exitCode !== null || run.child.signalCode !== null) && !run.find("failed")) await diagnoseMacCrash(run, { debug: true });
    throw new Error(`${run.label}: ${err.message}\n--- the shell's output (end) ---\n${run.lines.slice(-20).join("\n")}\n${run.log().slice(-3000)}`);
  });
  const win = await until("the window", 60_000, async () => run.find("window"));
  report(`${run.label}: the window exists and is visible`, win.label === "main" && win.visible) || problems.push("window");
  const probe = await until("the page's probe", 180_000, async () => run.find("probe"));
  const pp = probeProblems(probe.result, { media });
  report(`${run.label}: the page reached the service and the worker (fetch, events, worker, picture${media ? ", audio, video" : ""}; origin ${probe.result?.origin})`, pp.length === 0, pp.join("; ")) || problems.push(...pp);
  const helpers = [svc.pid, ...descendants(svc.pid)].filter(running);
  const worker = helpers.find((p) => p !== svc.pid && /ao[-_]worker/.test(cmdline(p)));
  report(`${run.label}: the worker runs under the service`, worker !== undefined, `helpers ${helpers.join(", ")}`) || problems.push("no worker process");
  return { svc, helpers };
}

async function assertGone(label, pids, marker, problems, ms = 30_000) {
  try {
    await until("the helpers to exit", ms, async () => pids.every((p) => !running(p)) && processesMarkedBy(marker).length === 0);
    const zombies = pids.filter((p) => procState(p) === "Z");
    report(`${label}: no helper process is left`, true, zombies.length ? `${zombies.length} exited, not yet reaped by the system` : "");
  } catch {
    const left = [...new Set([...pids.filter(running), ...processesMarkedBy(marker)])];
    report(`${label}: no helper process is left`, false, left.map((p) => `${p} ${cmdline(p).slice(0, 120)}`).join("; "));
    problems.push(`${label}: processes left`);
    for (const p of left) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
  }
}

/** A D-Bus session bus for the run (Linux: the keychain and the web view use it); none on a Mac. */
function startBus() {
  if (MAC) return { proc: undefined, address: Promise.resolve(undefined) };
  const dbus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "inherit"] });
  return {
    proc: dbus,
    address: new Promise((res, rej) => {
      let out = "";
      dbus.stdout.on("data", (d) => {
        out += d.toString();
        const line = out.split("\n")[0];
        if (out.includes("\n")) res(line.trim());
      });
      dbus.once("exit", () => rej(new Error("dbus-daemon did not start")));
    }),
  };
}

/**
 * R (a Mac, --release-app): the release app as shipped. It prints nothing for this check, so the
 * check reads the process table: the service must start from the app's own resources, listen on the
 * loopback address and refuse a request without its token, and after SIGTERM to the shell no helper
 * may be left.
 *
 * No worker is expected here. The service starts the worker when a library is opened
 * (apps/library-service/src/state.ts), and nothing opens one in this scenario: the release app has
 * no probe page and the check has no token. (The first Mac run, 2026-11-12, waited 180 s for a
 * worker that could not come.) The worker from an app's own resources is proved by scenarios A-D on
 * the debug app, which is staged and signed by the same steps; if a worker is running here all the
 * same, it must be the app's own.
 */
async function releaseCheck(app, problems) {
  const shell = shellOf(app);
  if (!existsSync(shell)) throw new Error(`Missing ${shell}.`);
  const resources = join(app, "Contents", "Resources");
  const root = mkdtempSync(join(tmpdir(), "ao-launch-check-"));
  const label = "R (the release app)";
  if (!(await leftoverSearchWorks(root))) problems.push(`could not check: the search for leftover processes cannot read environments here (${label})`);
  const before = stopAppProcesses();
  if (before.length) {
    report(`${label}: no copy of the app was running before the check`, false, before.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`).join("; "));
    problems.push("R: the app was already running");
  }
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"), LANG: "en_US.UTF-8", TMPDIR: join(root, "tmp") };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const run = startShell(env, label, { direct: true, shell });
  try {
    const under = () => descendants(run.child.pid).filter(running).map((pid) => ({ pid, cmd: cmdline(pid) }));
    const found = await until("the service under the shell", 120_000, async () => {
      if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`the app exited (${run.child.exitCode ?? run.child.signalCode}) before its service started:\n${run.log().slice(-3000)}`);
      const kids = under();
      const svc = kids.find((k) => k.cmd.includes(join(resources, "library-service", "service.mjs")));
      return svc ? { svc, kids } : null;
    }).catch(async (err) => {
      // Task MAC5: the release app died before its service started: what macOS can say, first.
      if (run.child.exitCode !== null || run.child.signalCode !== null) await diagnoseMacCrash(run, { debug: false });
      // The release app says nothing by itself: show what the check could see.
      const seen = under().map((k) => `${k.pid} ${k.cmd.slice(0, 300)}`).join("\n") || "(none)";
      throw new Error(`${err.message}\n--- processes under the shell ---\n${seen}\n--- the shell's output (end) ---\n${run.lines.slice(-20).join("\n")}\n${run.log().slice(-3000)}`);
    });
    report(`${label}: the service runs the app's own Node.js and service folder`, found.svc.cmd.startsWith(join(resources, "node", "node")), found.svc.cmd.slice(0, 200)) || problems.push("R: service not from the app");
    report(`${label}: the service runs with the 512 MB ceiling`, /--max-old-space-size=512/.test(found.svc.cmd)) || problems.push("R: memory ceiling");
    const envProblems = helperEnvProblems(found.svc.pid, found.kids.map((k) => k.pid));
    report(`${label}: the helpers got an allow-listed environment and no token outside standard input`, envProblems.length === 0, envProblems.join("; ")) || problems.push(...envProblems);
    const listen = await until("the service to listen", 60_000, async () => {
      const l = parseLsofListen(spawnSync("lsof", ["-nP", "-a", "-p", String(found.svc.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "");
      return l.length ? l : null;
    });
    report(`${label}: the service listens on the loopback address only`, listen.every((l) => l.host === "127.0.0.1"), listen.map((l) => `${l.host}:${l.port}`).join(", ")) || problems.push("R: not loopback only");
    const port = listen[0].port;
    const status = await fetch(`http://127.0.0.1:${port}/libraries`).then((r) => r.status, (e) => `no answer (${e.message})`);
    report(`${label}: the service answers, and refuses a request without its token`, status === 401, `HTTP ${status}`) || problems.push("R: no token refusal");
    const worker = under().find((k) => k.pid !== found.svc.pid && /ao[-_]worker/.test(k.cmd));
    if (worker) report(`${label}: the worker that is running is the app's own`, worker.cmd.startsWith(join(resources, "ao-worker", "ao-worker")), worker.cmd.slice(0, 200)) || problems.push("R: worker not from the app");
    else process.stdout.write(`launch-check: note ${label}: no worker is running, as expected: it starts when a library is opened, which this check cannot do in the release app (scenarios A-D do it in the debug app)\n`);
    const helpers = [found.svc.pid, ...descendants(found.svc.pid)].filter(running);
    process.kill(run.child.pid, "SIGTERM");
    const { code, signal } = await Promise.race([run.exit, sleep(120_000).then(() => ({ code: "timeout" }))]);
    report(`${label}: SIGTERM stops the app`, code === 0, `exit ${code ?? signal}`) || problems.push("R: exit");
    await assertGone(label, helpers, root, problems);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
    const left = stopAppProcesses();
    report(`${label}: no process of the app is left at the end`, left.length === 0, left.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`).join("; ")) || problems.push("R: app processes left");
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const problems = [];
  if (MAC) {
    if (args.releaseApp) {
      await releaseCheck(realpathSync(args.releaseApp), problems);
      return finish(problems);
    }
    if (!args.app) throw new Error("On a Mac the launch check runs an app bundle: --app <the debug .app> (scenarios A-E) or --release-app <the .app> (scenario R).");
    // The real path: tauri-utils refuses a program path with a symbolic link in it on macOS.
    SHELL = shellOf(realpathSync(args.app));
    PACKAGED = true;
  } else if (process.platform !== "linux") {
    throw new Error("The launch check runs on Linux (under xvfb-run) and on a Mac.");
  } else if (args.app || args.releaseApp) {
    throw new Error("--app and --release-app are for a Mac.");
  }
  for (const [what, p] of [[MAC ? "the app's program" : "the built shell (pnpm --filter @ao/desktop run build:linux)", SHELL], ...(PACKAGED ? [] : [["the built service folder", join(SERVICE_DIR, "service.mjs")]])]) {
    if (!existsSync(p)) throw new Error(`Missing ${what}.`);
  }
  // The watched-folder chooser is not called by the probe (it would open a dialog): its grant is
  // judged from the capability files the shell was built with.
  const caps = capabilityFileProblems();
  report("the main window's capability grants exactly the expected commands, the watched-folder chooser included", caps.length === 0, caps.join("; ")) || problems.push(...caps);
  const root = mkdtempSync(join(tmpdir(), "ao-launch-check-"));
  if (!(await leftoverSearchWorks(root))) {
    report("the search for leftover processes can see a process by its environment", false, "it could not; every 'no process is left' check would be blind");
    problems.push("could not check: leftover processes");
  }
  const before = stopAppProcesses();
  if (before.length) {
    report("no copy of the app was running before the check", false, before.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`).join("; "));
    problems.push("the app was already running");
  }
  const bus = startBus();
  try {
    const address = await bus.address;
    const worker = workerBin(root);
    process.stdout.write(`launch-check: shell ${SHELL}\nlaunch-check: worker: ${worker.kind}\n`);
    const media = writeProbeFiles(join(root, "files"));
    if (!media) process.stdout.write("launch-check: ffmpeg not found: the audio and video checks are skipped\n");

    const scenario = (name) => {
      const dir = join(root, name);
      const probe = join(dir, "probe");
      mkdirSync(probe, { recursive: true });
      for (const f of readdirSync(join(root, "files"))) writeFileSync(join(probe, f), readFileSync(join(root, "files", f)));
      return { dir, env: shellEnv(dir, { DBUS_SESSION_BUS_ADDRESS: address, AO_DESKTOP_WORKER_BIN: worker.bin, AO_SHELL_PROBE_DIR: probe }) };
    };

    // A. Normal close, with the checks of the page, the helpers' environment and a second launch;
    //    and (Task F19) the sign-in window, opened once by the page, may call nothing of the app.
    {
      const { dir, env } = scenario("a");
      const reports = await startReportServer();
      env.AO_SHELL_LIBRARY_PROBE = reports.address;
      const run = startShell(env, "A (closed normally)");
      try {
        const { svc, helpers } = await upAndProbed(run, media, problems);
        const opened = run.find("probe")?.result?.libraryWindowOpened;
        report(`${run.label}: the page opened the sign-in window`, opened === "ok", String(opened)) || problems.push("the sign-in window was not opened");
        const libraryReport = await until("the sign-in window's probe report", 120_000, async () => reports.report() !== undefined).then(
          () => reports.report(),
          () => null,
        );
        const lp = libraryProbeProblems(libraryReport);
        report(`${run.label}: a page in the sign-in window can call nothing of the app (${Object.keys(EXPECTED_LIBRARY_WINDOW_IPC).length} commands and events, and the raw entry points; origin ${libraryReport?.origin})`, lp.length === 0, lp.length ? lp.join("; ") : `IPC object ${libraryReport.internals ? "present, every command refused" : "absent"}; raw ${JSON.stringify(libraryReport.raw)}`) || problems.push(...lp);
        // What the raw attempts would have done is printed by the shell in test mode: nothing may be.
        const effects = [...(run.find("browser-opened") ? ["the researcher's browser would have been started"] : []), ...run.all("library").filter((e) => e.state !== "opened").map((e) => `the sign-in window said ${e.state}`), ...(run.all("library").length !== 1 ? [`the sign-in window was opened ${run.all("library").filter((e) => e.state === "opened").length} times`] : [])];
        report(`${run.label}: the sign-in window's attempts changed nothing (no browser started, no fetch, the window still open)`, effects.length === 0, effects.join("; ")) || problems.push(...effects);
        const envProblems = helperEnvProblems(svc.pid, helpers);
        report(`${run.label}: the helpers got an allow-listed environment and no token outside standard input`, envProblems.length === 0, envProblems.join("; ")) || problems.push(...envProblems);
        report(`${run.label}: the service runs with the 512 MB ceiling`, /--max-old-space-size=512/.test(cmdline(svc.pid))) || problems.push("memory ceiling");
        const second = startShell(env, "A (second launch)");
        const r2 = await Promise.race([second.exit, sleep(60_000).then(() => null)]);
        if (!r2) second.child.kill("SIGKILL");
        await until("the first window to be brought forward", 10_000, async () => run.find("second-launch")).catch(() => null);
        report("A: a second launch hands over to the first and exits", r2?.code === 0 && !second.find("service") && !!run.find("second-launch"), `exit ${r2?.code ?? "timeout"}`) || problems.push("second launch");
        run.child.stdin.write("close\n");
        const { code } = await Promise.race([run.exit, sleep(120_000).then(() => ({ code: "timeout" }))]);
        const stopped = run.find("stopped");
        report(`${run.label}: closing the window stops the helpers cleanly and the shell exits 0`, code === 0 && stopped?.how === "clean", `exit ${code}, stop ${stopped?.how ?? "not reported"}`) || problems.push("normal close");
        await assertGone(run.label, helpers, dir, problems, 10_000);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
        await reports.close();
      }
    }

    // B. SIGTERM, C. SIGKILL to the shell.
    for (const [name, signal, label] of [["b", "SIGTERM", "B (shell stopped with SIGTERM)"], ["c", "SIGKILL", "C (shell killed with SIGKILL)"]]) {
      const { dir, env } = scenario(name);
      const run = startShell(env, label);
      try {
        const { svc, helpers } = await upAndProbed(run, media, problems);
        process.kill(svc.shell, signal);
        const { code, signal: sig } = await Promise.race([run.exit, sleep(120_000).then(() => ({ code: "timeout" }))]);
        if (signal === "SIGTERM") {
          const stopped = run.find("stopped");
          report(`${label}: an orderly stop`, stopped?.how === "clean", `xvfb-run exit ${code ?? sig}, stop ${stopped?.how ?? "not reported"}`) || problems.push(`${label}: not orderly`);
        } else {
          report(`${label}: the shell is gone`, !running(svc.shell), `xvfb-run exit ${code ?? sig}`);
        }
        await assertGone(label, helpers, dir, problems);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
      }
    }

    // D. A service that refuses to start.
    {
      const dir = join(root, "d");
      const fake = join(dir, "service");
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "service.mjs"), 'process.stderr.write("The library service will not start: this is the launch check\'s stand-in.\\n"); process.exit(1);\n');
      const env = shellEnv(dir, { DBUS_SESSION_BUS_ADDRESS: address, AO_DESKTOP_SERVICE_DIR: fake });
      const run = startShell(env, "D (the service refuses to start)");
      try {
        const failed = await until("the failure report", 60_000, async () => run.find("failed"));
        report(`${run.label}: the failure is reported in the service's own words`, failed.message === "The library service will not start: this is the launch check's stand-in.", failed.message) || problems.push("failure message");
        // Nobody closes the error window: in test mode the shell exits by itself after a few seconds, non-zero.
        const { code } = await Promise.race([run.exit, sleep(30_000).then(() => ({ code: "timeout" }))]);
        report(`${run.label}: no app window was opened`, !run.find("window") && !run.find("service")) || problems.push("window on failure");
        // (xvfb-run passes the shell's standard error on its standard output.)
        report(`${run.label}: the failure is also on standard error`, /could not start: The library service will not start/.test(`${run.log()}\n${run.lines.join("\n")}`)) || problems.push("failure not on standard error");
        report(`${run.label}: the shell exits non-zero by itself when the error window is not answered`, typeof code === "number" && code !== 0, `exit ${code}`) || problems.push("failure exit code");
        await assertGone(run.label, [], dir, problems, 10_000);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
      }
    }

    // E. Opened again during a (deliberately slowed) quit: no second service beside the first;
    //    the first stops its helpers, then starts the app again. On a display the check owns,
    //    because the restarted shell outlives the first process (xvfb-run would end the display).
    //    Not on a Mac: there the shell relaunches a bundled app through LaunchServices (`open -n`;
    //    tauri 2.12.5 src/process.rs, restart_macos_app), so the restarted app's output never reaches
    //    this check and the app would run on outside it.
    if (MAC) {
      process.stdout.write("launch-check: skip E (opened again while closing): on macOS the restarted app is started by LaunchServices (open -n), outside this check, so its reports cannot be read\n");
    } else {
      const dir = join(root, "e");
      const xvfb = MAC ? undefined : spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1400x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
      const display = MAC
        ? undefined
        : await new Promise((res, rej) => {
            xvfb.stdout.once("data", (d) => res(`:${String(d).trim()}`));
            xvfb.once("exit", () => rej(new Error("Xvfb did not start")));
          });
      const env = shellEnv(dir, { DBUS_SESSION_BUS_ADDRESS: address, AO_DESKTOP_WORKER_BIN: worker.bin, AO_SHELL_TEST_SLOW_STOP_MS: "6000", DISPLAY: display });
      const run = startShell(env, "E (opened again while closing)", { direct: true });
      const shells = [];
      try {
        const first = await until("the service's ready report", 120_000, async () => run.find("service"));
        await until("the window", 60_000, async () => run.find("window"));
        shells.push(first.shell);
        const firstHelpers = [first.pid, ...descendants(first.pid)].filter(running);
        run.child.stdin.write("close\n");
        await until("the quit to begin", 30_000, async () => run.find("closing"));
        const second = startShell(env, "E (second launch while closing)", { direct: true });
        const r2 = await Promise.race([second.exit, sleep(60_000).then(() => null)]);
        if (!r2) killTree(second.child.pid);
        report(`${run.label}: the second launch hands over and starts no service of its own`, r2?.code === 0 && !second.find("service"), `exit ${r2?.code ?? "timeout"}`) || problems.push("E: second launch");
        await until("the relaunch to be noted", 10_000, async () => run.find("relaunch-requested")).catch(() => null);
        report(`${run.label}: the first instance notes the relaunch and keeps closing`, !!run.find("relaunch-requested")) || problems.push("E: relaunch not noted");
        await until("the first instance's helpers to stop", 120_000, async () => run.find("stopped"));
        const stillUp = firstHelpers.filter(running);
        report(`${run.label}: the first helpers stop cleanly before anything starts again`, run.find("stopped").how === "clean" && stillUp.length === 0 && run.all("service").length === 1, stillUp.join(", ")) || problems.push("E: helpers not stopped first");
        const again = await until("the app to start again", 120_000, async () => run.all("service")[1]);
        shells.push(again.shell);
        report(`${run.label}: the app starts again with a new service once the first is gone`, !!run.find("relaunching") && again.pid !== first.pid && !firstHelpers.some(running), `service ${first.pid} then ${again.pid}`) || problems.push("E: no clean restart");
        await until("the restarted window", 60_000, async () => run.all("window")[1]);
        const againHelpers = [again.pid, ...descendants(again.pid)].filter(running);
        // The first process's standard input ended with it, so the restarted shell is stopped the
        // other orderly way (SIGTERM: the same close path, scenario B).
        process.kill(again.shell, "SIGTERM");
        await until("the restarted shell to stop its helpers", 120_000, async () => run.all("stopped")[1]);
        await until("the restarted shell to exit", 30_000, async () => !running(again.shell));
        await assertGone(run.label, [...firstHelpers, ...againHelpers], dir, problems, 15_000);
      } catch (err) {
        report(`${run.label}`, false, `${err instanceof Error ? err.message : String(err)}\n${run.lines.slice(-20).join("\n")}`);
        problems.push("E");
      } finally {
        for (const pid of shells) if (running(pid)) killTree(pid);
        if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
        xvfb?.kill("SIGTERM");
      }
    }
  } finally {
    bus.proc?.kill("SIGTERM");
    const left = stopAppProcesses();
    if (MAC) report("no process of the app is left at the end", left.length === 0, left.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`).join("; ")) || problems.push("app processes left");
    rmSync(root, { recursive: true, force: true });
  }
  finish(problems);
}

function finish(problems) {
  if (problems.length) {
    process.stdout.write(`launch-check: FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"})\n`);
    process.exit(1);
  }
  process.stdout.write("launch-check: all checks passed\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`launch-check: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
