#!/usr/bin/env node
// The desktop shell's launch check (Task 37c, R155), on Linux under a virtual display. It starts the
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
// Needs: xvfb-run, dbus-daemon, the built shell (apps/desktop/src-tauri/target/debug), the built
// service folder (apps/library-service/dist/library-service), Node 22. The worker: AO_DESKTOP_WORKER_BIN
// if set, else the packaged worker in apps/desktop/sidecars/ if built, else the development worker
// (services/media-worker/.venv, `pnpm setup:py`) through a small start script in the temporary folder.
// ffmpeg, when present, makes the audio and video files the probe attaches; without it those two
// checks are skipped and say so. Everything it writes is under one temporary folder, removed at the end.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHELL = join(REPO, "apps", "desktop", "src-tauri", "target", "debug", "alexandrine-oxiana");
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
};

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
  "AO_SERVICE_PORT", "AO_TOOLS_DIR", "AO_MODELS_DIR", "AO_WORKER_BIN", "AO_NO_WORKER",
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

// ---------- processes (Linux /proc) ----------

function procState(pid) {
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
  for (const p of allPids()) {
    const pp = ppidOf(p);
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
const envNames = (pid) => readProc(pid, "environ").split("\0").filter(Boolean).map((kv) => kv.slice(0, kv.indexOf("=")));
const cmdline = (pid) => readProc(pid, "cmdline").split("\0").join(" ");
/** Running processes whose environment mentions `marker` (the check's temporary folder): any helper of this check. */
function processesMarkedBy(marker) {
  return allPids().filter((p) => p !== process.pid && running(p) && readProc(p, "environ").includes(marker));
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

function startShell(env, label) {
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", SHELL], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  return { child, label, lines, events, log: () => log, exit, find: (kind) => events.find((e) => e.kind === kind) };
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
    AO_DESKTOP_NODE: process.execPath,
    AO_DESKTOP_SERVICE_DIR: SERVICE_DIR,
    ...extra,
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

/** Starts the shell and waits for the service, the window and the probe's result; returns the helpers' pids. */
async function upAndProbed(run, media, problems) {
  const svc = await until("the service's ready report", 120_000, async () => run.find("service") ?? ((await Promise.race([run.exit, sleep(0)])) && Promise.reject(new Error(`the shell exited: ${run.log().slice(-2000)}`)))).catch((err) => {
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

async function main() {
  if (process.platform !== "linux") throw new Error("The launch check runs on Linux (under xvfb-run).");
  for (const [what, p] of [["the built shell (pnpm --filter @ao/desktop run build:linux)", SHELL], ["the built service folder", join(SERVICE_DIR, "service.mjs")]]) {
    if (!existsSync(p)) throw new Error(`Missing ${what}.`);
  }
  const root = mkdtempSync(join(tmpdir(), "ao-launch-check-"));
  const problems = [];
  const dbus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const address = await new Promise((res, rej) => {
      let out = "";
      dbus.stdout.on("data", (d) => {
        out += d.toString();
        const line = out.split("\n")[0];
        if (out.includes("\n")) res(line.trim());
      });
      dbus.once("exit", () => rej(new Error("dbus-daemon did not start")));
    });
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

    // A. Normal close, with the checks of the page, the helpers' environment and a second launch.
    {
      const { dir, env } = scenario("a");
      const run = startShell(env, "A (closed normally)");
      try {
        const { svc, helpers } = await upAndProbed(run, media, problems);
        const envProblems = helpers.flatMap((p) => helperProblems(p === svc.pid ? "the service" : `helper ${p}`, envNames(p), cmdline(p)));
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
        await sleep(1500); // the error window is up; no app window was opened
        report(`${run.label}: no app window was opened`, !run.find("window") && !run.find("service")) || problems.push("window on failure");
        // A person closes the error window; here the shell is asked to stop, and must still exit non-zero.
        const shellPid = descendants(run.child.pid).find((p) => cmdline(p).startsWith(SHELL));
        if (shellPid) process.kill(shellPid, "SIGTERM");
        const { code } = await Promise.race([run.exit, sleep(60_000).then(() => ({ code: "timeout" }))]);
        report(`${run.label}: the shell exits non-zero`, typeof code === "number" && code !== 0, `exit ${code}`) || problems.push("failure exit code");
        await assertGone(run.label, [], dir, problems, 10_000);
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) killTree(run.child.pid);
      }
    }
  } finally {
    dbus.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
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
