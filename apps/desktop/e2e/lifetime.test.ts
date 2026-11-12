// The desktop end-to-end run's lifetime (lifetime.ts): every process it starts gets the run's own
// home and XDG folders (never the real ones), and everything it started is gone and its folder
// removed after a teardown, after the test process exits without one, and after a Playwright test
// that hangs until its time limit (through the `run` fixture, fixtures.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Fatal, RunLifetime, findStaleRuns, homeEnvProblems, mountsUnder, processEnvProblems, processesMarkedBy, running, runEnv, startedByBus, until } from "./lifetime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The process tests read /proc and use setsid: Linux only (the desktop end-to-end test runs only on
 * Linux). On any other system they are skipped, and their names say why.
 */
const LINUX = process.platform === "linux";
const onLinux = (name: string, body: () => void) => describe.skipIf(!LINUX)(`${name} [Linux only: reads /proc, uses setsid]`, body);
const made: RunLifetime[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) await r.dispose();
});
const lifetime = () => {
  const r = RunLifetime.create("ao-lifetime-test-");
  made.push(r);
  return r;
};

describe("runEnv and the home-folder rule", () => {
  it("gives every per-user folder a place under the run's folder", () => {
    const env = runEnv("/tmp/ao-x", { PATH: "/usr/bin" });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/ao-x/home",
      XDG_CONFIG_HOME: "/tmp/ao-x/config",
      XDG_DATA_HOME: "/tmp/ao-x/data",
      XDG_CACHE_HOME: "/tmp/ao-x/cache",
      XDG_STATE_HOME: "/tmp/ao-x/state",
      XDG_RUNTIME_DIR: "/tmp/ao-x/runtime",
    });
    expect(homeEnvProblems("/tmp/ao-x", env)).toEqual([]);
  });

  it("names each per-user variable that is missing or points outside the run's folder", () => {
    const env = { ...runEnv("/tmp/ao-x"), HOME: homedir(), XDG_DATA_HOME: "/tmp/ao-xy/data" };
    delete (env as Record<string, string>).XDG_CACHE_HOME;
    expect(homeEnvProblems("/tmp/ao-x", env)).toEqual([`HOME is ${homedir()}, not under the run's folder`, "XDG_DATA_HOME is /tmp/ao-xy/data, not under the run's folder", "XDG_CACHE_HOME is not set"]);
  });

  it("refuses to start a process whose environment would reach the real home folder", () => {
    const r = lifetime();
    expect(() => r.spawn("true", [], { ...runEnv(r.root), HOME: homedir() })).toThrow(/HOME is .* not under the run's folder/);
    expect(() => r.run("true", [], { PATH: process.env.PATH ?? "" })).toThrow(/HOME is not set/);
  });
});

onLinux("processEnvProblems", () => {
  it("reads a running process's per-user folders and names those outside the run's folder", async () => {
    const r = lifetime();
    const good = r.spawn("sleep", ["600"], runEnv(r.root));
    const { spawn } = await import("node:child_process");
    const bad = spawn("sleep", ["600"], { env: { ...runEnv(r.root), XDG_RUNTIME_DIR: "", HOME: homedir() }, stdio: "ignore" });
    try {
      await until("both to run", 5_000, () => running(good.pid!) && running(bad.pid!));
      expect(processEnvProblems(good.pid!, r.root)).toEqual([]);
      expect(processEnvProblems(bad.pid!, r.root)).toEqual([`HOME is ${homedir()}, not under the run's folder`, "XDG_RUNTIME_DIR is not set"]);
    } finally {
      bad.kill("SIGKILL");
    }
  });
});

onLinux("startedByBus", () => {
  it("tells a service the session bus started (D-Bus sets DBUS_STARTER_ADDRESS for it) from the app's own processes", async () => {
    const r = lifetime();
    const bus = r.spawn("sleep", ["600"], { ...runEnv(r.root), DBUS_STARTER_ADDRESS: "unix:path=/tmp/x", DBUS_STARTER_BUS_TYPE: "session" });
    const app = r.spawn("sleep", ["600"], runEnv(r.root));
    await until("both to run", 5_000, () => running(bus.pid!) && running(app.pid!));
    expect(startedByBus(bus.pid!)).toBe(true);
    expect(startedByBus(app.pid!)).toBe(false);
  });
});

describe("findStaleRuns (what a test runner killed outright left behind)", () => {
  it("names the runs whose owner is gone, with their processes and mounts; a run whose owner still runs is someone else's live run", () => {
    const stale = findStaleRuns({
      tmp: "/t",
      prefix: "ao-desktop-e2e-",
      entries: ["ao-desktop-e2e-live", "ao-desktop-e2e-dead", "ao-desktop-e2e-old", "ao-launch-check-x"],
      ownerOf: (root) => ({ "/t/ao-desktop-e2e-live": 10, "/t/ao-desktop-e2e-dead": 20 })[root],
      alive: (pid) => pid === 10,
      mounts: "portal /t/ao-desktop-e2e-dead/runtime/doc fuse.portal rw 0 0\nportal /t/ao-desktop-e2e-live/runtime/doc fuse.portal rw 0 0",
      processesOf: (root) => (root === "/t/ao-desktop-e2e-dead" ? [55, 56] : []),
    });
    expect(stale).toEqual([
      { root: "/t/ao-desktop-e2e-dead", owner: 20, processes: [55, 56], mounts: ["/t/ao-desktop-e2e-dead/runtime/doc"] },
      { root: "/t/ao-desktop-e2e-old", owner: undefined, processes: [], mounts: [] },
    ]);
  });

  it("a new run records its owner, so that it is never taken for a stale one while it lives", () => {
    const r = lifetime();
    expect(readFileSync(join(r.root, "owner.pid"), "utf8").trim()).toBe(String(process.pid));
  });
});

describe("mountsUnder", () => {
  it("finds the file systems mounted inside the run's folder (the document portal mounts one in XDG_RUNTIME_DIR), deepest first", () => {
    const mounts = [
      "sysfs /sys sysfs rw 0 0",
      "portal /tmp/ao-x/runtime/doc fuse.portal rw,nosuid 0 0",
      "portal /tmp/ao-xy/runtime/doc fuse.portal rw 0 0",
      "tmpfs /tmp/ao-x/runtime/doc/by\\040app tmpfs rw 0 0",
    ].join("\n");
    expect(mountsUnder("/tmp/ao-x", mounts)).toEqual(["/tmp/ao-x/runtime/doc/by app", "/tmp/ao-x/runtime/doc"]);
  });
});

describe("until", () => {
  it("stops at once on a Fatal error, with its message", async () => {
    const t = Date.now();
    await expect(until("x", 10_000, () => { throw new Fatal("the app could not start: no node"); })).rejects.toThrow(/^the app could not start: no node$/);
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it("keeps polling through other errors and names the last one when time is up", async () => {
    let n = 0;
    await expect(until("the thing", 500, () => { n++; throw new Error("not yet"); })).rejects.toThrow(/timed out after .* waiting for the thing \(last: not yet\)/);
    expect(n).toBeGreaterThan(1);
  });
});

/** Stand-ins: a shell with a child in its group, and a process that leaves the group (setsid). */
async function standIns(r: RunLifetime): Promise<number[]> {
  const env = runEnv(r.root);
  r.spawn("sh", ["-c", "echo stand-in started; sleep 600 & sleep 600"], env);
  r.spawn("setsid", ["sleep", "600"], env);
  return until("the stand-ins to run", 10_000, () => {
    const p = processesMarkedBy(r.root, []);
    return p.length >= 3 ? p : undefined;
  });
}

onLinux("RunLifetime", () => {
  it("dispose stops everything it started, also what left its process group, and removes the folder (twice is harmless)", async () => {
    const r = lifetime();
    const pids = await standIns(r);
    await until("the stand-in's output", 5_000, () => r.log().includes("stand-in started"));
    await r.dispose();
    expect(pids.filter(running)).toEqual([]);
    expect(existsSync(r.root)).toBe(false);
    await r.dispose();
  });

  it("runs deferred clean-up first, and an error in one does not stop the rest", async () => {
    const r = lifetime();
    const order: string[] = [];
    r.defer(() => { order.push("a"); throw new Error("boom"); });
    r.defer(async () => { order.push("b"); });
    await r.dispose();
    expect(order).toEqual(["a", "b"]);
    expect(r.log()).toMatch(/clean-up step failed: boom/);
  });

  it("the last-resort sweep at process exit stops what a run left behind", async () => {
    const script = join(HERE, "lifetime-exit.fixture.ts");
    const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 60_000, cwd: HERE });
    expect(r.status, r.stderr).toBe(0);
    const { root, pids } = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { root: string; pids: number[] };
    expect(pids.length).toBeGreaterThanOrEqual(3);
    await until("the stand-ins to be gone", 5_000, () => pids.every((p) => !running(p)));
    expect(existsSync(root)).toBe(false);
  });
});

onLinux("the run fixture when a test hangs until its time limit", () => {
  it("still stops everything, removes the folder and saves the output", async () => {
    const results = mkdtempSync(join(tmpdir(), "ao-lifetime-probe-"));
    const out = join(results, "probe.json");
    try {
      const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
      const r = spawnSync(process.execPath, [cli, "test", "-c", join(HERE, "probe", "playwright.config.ts")], {
        encoding: "utf8",
        timeout: 120_000,
        cwd: resolve(HERE, ".."),
        env: { ...process.env, AO_PROBE_OUT: out, AO_PROBE_RESULTS: join(results, "test-results"), PLAYWRIGHT_JSON_OUTPUT_NAME: "" },
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stdout).toMatch(/Test timeout of 3000ms exceeded/);
      const { root, pids } = JSON.parse(readFileSync(out, "utf8")) as { root: string; pids: number[] };
      expect(pids.length).toBeGreaterThanOrEqual(3);
      expect(pids.filter(running)).toEqual([]);
      expect(existsSync(root)).toBe(false);
      const saved = findFile(join(results, "test-results"), "shell-output.txt");
      expect(saved, "the output was saved").toBeDefined();
      const text = readFileSync(saved!, "utf8");
      expect(text).toContain("stand-in started");
      expect(text, "the clean-up's own notes are saved too").toContain("clean-up step failed: PROBE deferred boom");
    } finally {
      rmSync(results, { recursive: true, force: true });
    }
  }, 150_000);
});

function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e === name) return p;
  }
  return undefined;
}
