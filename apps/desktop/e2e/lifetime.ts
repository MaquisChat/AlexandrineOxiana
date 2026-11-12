/**
 * The lifetime of one desktop end-to-end run (Task 37h): one temporary folder under os.tmpdir(),
 * and every process the run starts.
 *
 * - **The real home folder is never reached.** Every process is started with HOME and the XDG
 *   per-user folders (config, data, cache, state, runtime) inside the run's folder (runEnv). This
 *   covers Xvfb, the D-Bus session bus (and whatever the bus starts for the app, such as dconf,
 *   which holds GTK's file-chooser settings), the drivers, the app and through it its helpers, and
 *   xdotool. `spawn` and `run` refuse an environment that would reach outside it (homeEnvProblems).
 * - **Everything is stopped, however the test ends.** Each process is started in its own process
 *   group. `dispose` runs the deferred clean-up steps (ending the WebDriver session), kills those
 *   groups, then sweeps any process whose environment names the run's folder (the app's service
 *   and worker run in a group of their own; a bus-started service may leave its group), and
 *   removes the folder. The `run` fixture (fixtures.ts) calls it from its teardown, which Playwright
 *   runs after a pass, a failure and a time-out alike. As a last resort, a handler at process exit
 *   does the same synchronously for any run not yet disposed of.
 * - **The output is kept.** The drivers' and the app's standard output and error are collected
 *   (`log()`) for the report.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** An error that ends a wait at once: no polling can make it right (the app failed to start, a driver exited). */
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fatal";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Polls `test` until it returns something truthy; fails after `ms` naming `what` and the last error.
 * A Fatal error ends the wait at once, with its own message.
 */
export async function until<T>(what: string, ms: number, test: () => Promise<T | undefined | null | false> | T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await test();
      if (v) return v;
      last = undefined;
    } catch (err) {
      if (err instanceof Fatal) throw err;
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}${last instanceof Error ? ` (last: ${last.message})` : ""}`);
    await sleep(200);
  }
}

// ---------- the environment ----------

/** The per-user variables and the folder (under the run's folder) each points to. */
const PER_USER: Array<[string, string]> = [
  ["HOME", "home"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_CACHE_HOME", "cache"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_RUNTIME_DIR", "runtime"],
];

/** The base environment of every process of a run: PATH, a locale, and the per-user folders under `root`. */
export function runEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const [name, dir] of PER_USER) env[name] = join(root, dir);
  return { ...env, ...extra };
}

/** What in `env` would let a process reach outside the run's folder `root` (empty when nothing). */
export function homeEnvProblems(root: string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [name] of PER_USER) {
    const v = env[name];
    if (!v) out.push(`${name} is not set`);
    else if (v !== root && !v.startsWith(root + sep)) out.push(`${name} is ${v}, not under the run's folder`);
  }
  return out;
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
/** A process's parent pid (-1 when it is gone). */
export function parentOf(pid: number): number {
  return Number(stat(pid)?.[1] ?? -1);
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
    const pp = parentOf(p);
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
/** Running processes whose environment names `marker` (the run's folder), except `except`. */
export function processesMarkedBy(marker: string, except: number[]): number[] {
  return allPids().filter((p) => p !== process.pid && !except.includes(p) && running(p) && readProc(p, "environ").includes(marker));
}
/** homeEnvProblems for a running process, from its environment in /proc ("gone" when it has exited). */
export function processEnvProblems(pid: number, root: string): string[] {
  const raw = readProc(pid, "environ");
  if (!raw) return running(pid) ? ["its environment cannot be read"] : [];
  const env: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return homeEnvProblems(root, env);
}

/**
 * Whether the session bus started `pid` (or its parent did) on someone's request: dconf, the desktop
 * and document portals and the like. D-Bus sets DBUS_STARTER_ADDRESS for what it activates. They
 * belong to the session, as on a desktop, not to the app; `dispose` stops them with the rest.
 */
export function startedByBus(pid: number): boolean {
  return readProc(pid, "environ").split("\0").some((kv) => kv.startsWith("DBUS_STARTER_ADDRESS="));
}

/** The mount points inside `root` in a /proc/self/mounts text, deepest first (they are unmounted in that order). */
export function mountsUnder(root: string, mounts: string): string[] {
  const out: string[] = [];
  for (const line of mounts.split("\n")) {
    const field = line.split(" ")[1];
    if (!field) continue;
    const point = field.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (point.startsWith(root + sep)) out.push(point);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Unmounts (lazily) what is mounted inside `root`: the document portal's FUSE file system, left behind when it is killed. */
function unmountUnder(root: string): string[] {
  let mounts = "";
  try {
    mounts = readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return [];
  }
  const failed: string[] = [];
  for (const m of mountsUnder(root, mounts)) {
    const ok = [["fusermount3", "-u", "-z", m], ["fusermount", "-u", "-z", m], ["umount", "-l", m]].some(([cmd, ...args]) => spawnSync(cmd!, args, { stdio: "ignore", timeout: 10_000 }).status === 0);
    if (!ok) failed.push(m);
  }
  return failed;
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone
  }
}

// ---------- the run ----------

const live = new Set<RunLifetime>();
let exitHandler = false;

export class RunLifetime {
  private readonly groups: number[] = [];
  private readonly deferred: Array<() => Promise<void> | void> = [];
  private output = "";
  private done = false;

  private constructor(readonly root: string) {}

  /** A new run with its own folder (and the per-user folders in it). */
  static create(prefix = "ao-desktop-e2e-"): RunLifetime {
    const r = new RunLifetime(mkdtempSync(join(tmpdir(), prefix)));
    for (const [, dir] of PER_USER) mkdirSync(join(r.root, dir), { recursive: true, mode: 0o700 });
    live.add(r);
    if (!exitHandler) {
      exitHandler = true;
      process.on("exit", () => {
        for (const run of live) run.disposeSync();
      });
    }
    return r;
  }

  get disposed(): boolean {
    return this.done;
  }

  /** The collected output of the processes started with `collect` (and the lifetime's own notes). */
  log(): string {
    return this.output;
  }

  /** Adds a line of the lifetime's own to the log. */
  note(text: string): void {
    this.append(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Adds a process's output as it came (chunks are not lines). */
  private append(raw: string): void {
    this.output += raw;
    if (this.output.length > 2_000_000) this.output = this.output.slice(-1_000_000);
  }

  private check(env: Record<string, string>): void {
    if (this.done) throw new Error("this run has ended");
    const p = homeEnvProblems(this.root, env);
    if (p.length) throw new Error(`refusing to start a process that could reach the real home folder: ${p.join("; ")}`);
  }

  /** Starts `cmd` in its own process group with exactly `env`; its output goes to `log()`. */
  spawn(cmd: string, args: string[], env: Record<string, string>, opts: { cwd?: string; keepStdout?: boolean } = {}): ChildProcess {
    this.check(env);
    const child = spawn(cmd, args, { env, cwd: opts.cwd ?? this.root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) this.groups.push(child.pid);
    child.once("error", (e) => this.note(`[${cmd}] could not be started: ${e.message}`));
    if (!opts.keepStdout) child.stdout!.on("data", (d: Buffer) => this.append(d.toString()));
    child.stderr!.on("data", (d: Buffer) => this.append(d.toString()));
    return child;
  }

  /** Runs `cmd` to its end with exactly `env` (xdotool). */
  run(cmd: string, args: string[], env: Record<string, string>): SpawnSyncReturns<string> {
    this.check(env);
    return spawnSync(cmd, args, { env, encoding: "utf8", timeout: 20_000 });
  }

  /** A clean-up step `dispose` runs first (each limited to 10 s; a failure is noted, not thrown). */
  defer(step: () => Promise<void> | void): void {
    this.deferred.push(step);
  }

  /** Kills the groups, then sweeps what is left by the run's folder; true when nothing is left. */
  private sweep(): boolean {
    for (const g of this.groups) kill(-g);
    for (const p of processesMarkedBy(this.root, [])) kill(p);
    return processesMarkedBy(this.root, []).length === 0;
  }

  /** Ends the run: deferred steps, every process stopped, the folder removed. Safe to call again. */
  async dispose(): Promise<void> {
    if (this.done) return;
    for (const step of this.deferred.splice(0)) {
      try {
        await Promise.race([Promise.resolve().then(step), sleep(10_000).then(() => Promise.reject(new Error("took longer than 10 s")))]);
      } catch (err) {
        this.note(`clean-up step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (let i = 0; i < 25 && !this.sweep(); i++) await sleep(200);
    this.finish();
  }

  /** The same without waiting on promises: for the handler at process exit. */
  disposeSync(): void {
    if (this.done) return;
    for (let i = 0; i < 25 && !this.sweep(); i++) sleepSync(200);
    this.finish();
  }

  private finish(): void {
    this.done = true;
    live.delete(this);
    const left = processesMarkedBy(this.root, []);
    if (left.length) this.note(`still running after the clean-up: ${left.map((p) => `${p} ${cmdline(p)}`).join("; ")}`);
    const stuck = unmountUnder(this.root);
    if (stuck.length) this.note(`could not unmount: ${stuck.join(", ")}`);
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch (err) {
      this.note(`the run's folder could not be removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
