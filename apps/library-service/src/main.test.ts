/**
 * The entry point as a launcher starts it (R98): the access token is written on standard input,
 * never put in the environment or the command line; the service refuses every other way, and the
 * token reaches no child process and no line it prints.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary, deviceDeps, type Deps } from "@ao/library";
import { TOKEN_STDIN_TIMEOUT_MS } from "./startup-token.js";

const TOKEN = "stdin-token-0123456789abcdefghijklmnopqrstuvwxyz";
const ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../", import.meta.url));

let tmp: string;
let deps: Deps;
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-service-main-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await rm(tmp, { recursive: true, force: true });
});

/** The environment the test runs in, without any AO_ variable, plus `extra`. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("AO_")) env[k] = v;
  return { ...env, AO_SERVICE_PORT: "0", AO_CONFIG_DIR: deps.appConfigDir, ...extra };
}

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exit: Promise<{ code: number | null; ms: number }>;
}

function run(opts: { env?: NodeJS.ProcessEnv; args?: string[]; stdin?: string | null; stdio0?: "pipe" | "ignore" } = {}): Run {
  const stdio: StdioOptions = [opts.stdio0 ?? "pipe", "pipe", "pipe"];
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...(opts.args ?? [])], { cwd: CWD, env: opts.env ?? baseEnv({ AO_NO_WORKER: "1" }), stdio });
  children.push(child);
  child.stdin?.on("error", () => {});
  if (opts.stdin !== undefined && opts.stdin !== null) child.stdin!.write(opts.stdin);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<{ code: number | null; ms: number }>((resolve) => child.once("exit", (code) => resolve({ code, ms: Date.now() - t0 })));
  return { child, out: () => out, err: () => err, exit };
}

async function ready(r: Run): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const check = () => {
      const m = /AO_SERVICE_READY port=(\d+)/.exec(r.out());
      if (m) resolve(Number(m[1]));
    };
    r.child.stdout!.on("data", check);
    check();
    void r.exit.then(({ code }) => reject(new Error(`exited early (code ${code}): ${r.err()}`)));
  });
}

async function stop(r: Run): Promise<number | null> {
  r.child.kill("SIGTERM");
  return (await r.exit).code;
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("the access token on standard input (R98)", () => {
  it("starts with the token on standard input, serves with it, and never prints it", async () => {
    const r = run({ stdin: `${TOKEN}\n` });
    const port = await ready(r);
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: { authorization: "Bearer not-the-token-0123456789abcdefghijkl" } })).status).toBe(401);
    // Anything written after the token line is not read as anything.
    r.child.stdin!.write("not a command\n");
    await new Promise((res) => setTimeout(res, 300));
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth })).status).toBe(200);
    expect(await stop(r), r.err()).toBe(0);
    expect(r.out()).toMatch(/AO_SERVICE_READY port=\d+\n/);
    expect(r.out()).not.toContain(TOKEN);
    expect(r.err()).not.toContain(TOKEN);
  });

  it("shuts down cleanly when its standard input closes after the token line (the launcher is gone, R155)", async () => {
    const lib = join(tmp, "Lib");
    await (await createLibrary(lib, "Lib", deps)).close();
    const r = run({ env: baseEnv({ AO_NO_WORKER: "1", AO_LIBRARY: lib }), stdin: `${TOKEN}\n` });
    const port = await ready(r);
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth })).status).toBe(200);
    expect(existsSync(join(lib, ".lock"))).toBe(true);
    r.child.stdin!.end();
    const { code } = await r.exit;
    expect(code, r.err()).toBe(0);
    // A clean shutdown: the library's lock was released.
    expect(existsSync(join(lib, ".lock"))).toBe(false);
    expect(r.err()).not.toContain(TOKEN);
  });

  it("refuses to start when the token is in the environment, even with the token on standard input too", async () => {
    const r = run({ env: baseEnv({ AO_NO_WORKER: "1", AO_SERVICE_TOKEN: TOKEN }), stdin: `${TOKEN}\n` });
    const { code } = await r.exit;
    expect(code).not.toBe(0);
    expect(r.out()).not.toMatch(/AO_SERVICE_READY/);
    expect(r.err()).toMatch(/environment/i);
    expect(r.err()).not.toContain(TOKEN);
  });

  it("refuses to start when a command-line argument is given", async () => {
    const r = run({ args: ["--token", TOKEN], stdin: `${TOKEN}\n` });
    const { code } = await r.exit;
    expect(code).not.toBe(0);
    expect(r.out()).not.toMatch(/AO_SERVICE_READY/);
    expect(r.err()).toMatch(/argument|command line/i);
    expect(r.err()).not.toContain(TOKEN);
  });

  it("refuses a too-short or malformed token without printing it", async () => {
    for (const bad of ["short-token", `${TOKEN} with spaces`]) {
      const r = run({ stdin: `${bad}\n` });
      const { code } = await r.exit;
      expect(code).not.toBe(0);
      expect(r.out()).not.toMatch(/AO_SERVICE_READY/);
      expect(r.err()).toMatch(/not a valid access token/i);
      expect(r.err()).not.toContain(bad);
    }
  });

  it("refuses at once when standard input is closed or not connected (an old launcher)", async () => {
    const r = run({ stdio0: "ignore" });
    const { code, ms } = await r.exit;
    expect(code).not.toBe(0);
    expect(r.err()).toMatch(/standard input closed before an access token arrived/i);
    // Not after waiting out the limit: the time is start-up (loading the modules) only.
    expect(ms).toBeLessThan(TOKEN_STDIN_TIMEOUT_MS);
  });

  it("refuses and exits when no token arrives within the time limit", async () => {
    // Standard input stays open and silent.
    const r = run({});
    const { code, ms } = await r.exit;
    expect(code).not.toBe(0);
    expect(r.out()).not.toMatch(/AO_SERVICE_READY/);
    expect(r.err()).toMatch(/no access token arrived on standard input within/i);
    expect(ms).toBeGreaterThanOrEqual(TOKEN_STDIN_TIMEOUT_MS);
    // Start-up (loading the modules) plus the limit; generous for a loaded machine.
    expect(ms).toBeLessThan(TOKEN_STDIN_TIMEOUT_MS + 40_000);
  }, 90_000);

  it("the media worker it starts sees no token: not in its environment, nor in the service's environment or command line", async () => {
    const lib = join(tmp, "Lib");
    await (await createLibrary(lib, "Lib", deps)).close();
    // A stand-in worker: it records what it can see of itself and its parent, then answers like a
    // worker that is ready (every request gets {}), until it is stopped.
    const dump = join(tmp, "worker-saw.json");
    const fake = join(tmp, "fake-worker.mjs");
    await writeFile(
      fake,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
const proc = (p) => { try { return readFileSync(p, "latin1"); } catch { return ""; } };
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
  env: process.env,
  argv: process.argv,
  parentEnviron: proc("/proc/" + process.ppid + "/environ"),
  parentCmdline: proc("/proc/" + process.ppid + "/cmdline"),
  ownEnviron: proc("/proc/self/environ"),
}));
const s = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); });
s.listen(0, "127.0.0.1", () => console.log("AO_WORKER_READY port=" + s.address().port));
`,
    );
    await chmod(fake, 0o755);
    const r = run({ env: baseEnv({ AO_LIBRARY: lib, AO_WORKER_BIN: fake }), stdin: `${TOKEN}\n` });
    await ready(r);
    for (let i = 0; i < 200 && !existsSync(dump); i++) await new Promise((res) => setTimeout(res, 100));
    const saw = JSON.parse(await readFile(dump, "utf8")) as { env: Record<string, string>; argv: string[]; parentEnviron: string; parentCmdline: string; ownEnviron: string };
    expect(Object.keys(saw.env).filter((k) => /SERVICE_TOKEN/i.test(k))).toEqual([]);
    expect(JSON.stringify(saw.env)).not.toContain(TOKEN);
    expect(saw.argv.join(" ")).not.toContain(TOKEN);
    expect(saw.ownEnviron).not.toContain(TOKEN);
    if (process.platform === "linux") {
      // The service's own environment and command line, as any process of the user can read them.
      expect(saw.parentCmdline).toContain("main.ts");
      expect(saw.parentEnviron).toContain("AO_LIBRARY=");
      expect(saw.parentEnviron).not.toContain(TOKEN);
      expect(saw.parentCmdline).not.toContain(TOKEN);
    }
    expect(await stop(r), r.err()).toBe(0);
    expect(r.out()).not.toContain(TOKEN);
    expect(r.err()).not.toContain(TOKEN);
  });
});

describe("the port across launches (R171, defect D13)", () => {
  const portFile = () => join(deps.appConfigDir, "service-port.json");
  const holdPort = (port: number) =>
    new Promise<Server>((resolve, reject) => {
      const s = createNetServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve(s));
    });
  const release = (s: Server) => new Promise<void>((res) => s.close(() => res()));

  it("asked for any port, it listens again on the port it used last time", async () => {
    const a = run({ stdin: `${TOKEN}\n` });
    const first = await ready(a);
    expect(await stop(a), a.err()).toBe(0);
    expect(JSON.parse(await readFile(portFile(), "utf8"))).toEqual({ v: 1, port: first });
    const b = run({ stdin: `${TOKEN}\n` });
    expect(await ready(b)).toBe(first);
    expect((await fetch(`http://127.0.0.1:${first}/libraries`, { headers: auth })).status).toBe(200);
    expect(await stop(b), b.err()).toBe(0);
  }, 60_000);

  it("when the remembered port is taken, it starts on another, says so in the ready line, and remembers the new one", async () => {
    const a = run({ stdin: `${TOKEN}\n` });
    const first = await ready(a);
    expect(await stop(a), a.err()).toBe(0);
    const blocker = await holdPort(first);
    try {
      const b = run({ stdin: `${TOKEN}\n` });
      const second = await ready(b);
      expect(second).not.toBe(first);
      expect(b.out()).toContain(`AO_SERVICE_READY port=${second}\n`);
      expect(JSON.parse(await readFile(portFile(), "utf8"))).toEqual({ v: 1, port: second });
      expect(await stop(b), b.err()).toBe(0);
    } finally {
      await release(blocker);
    }
  }, 60_000);

  it("a settings folder where the port cannot be written does not stop it; its log says so without a path", async () => {
    await mkdir(portFile(), { recursive: true });
    const a = run({ stdin: `${TOKEN}\n` });
    const port = await ready(a);
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth })).status).toBe(200);
    expect(await stop(a), a.err()).toBe(0);
    const all = a.out() + a.err();
    const line = all.split("\n").find((l) => /port could not be remembered/i.test(l));
    expect(line, all).toBeDefined();
    expect(line).not.toContain(tmp);
    expect(line).not.toContain("service-port.json");
  }, 60_000);

  it("two services started at once on the same settings folder both start (both reaching for the remembered port)", async () => {
    const z = run({ stdin: `${TOKEN}\n` });
    const remembered0 = await ready(z);
    expect(await stop(z), z.err()).toBe(0);
    const a = run({ stdin: `${TOKEN}\n` });
    const b = run({ stdin: `${TOKEN}\n` });
    const [pa, pb] = await Promise.all([ready(a), ready(b)]);
    expect(pa).not.toBe(pb);
    // One of them has the port used last time; the other fell back to another.
    expect([pa, pb]).toContain(remembered0);
    expect((await fetch(`http://127.0.0.1:${pa}/libraries`, { headers: auth })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${pb}/libraries`, { headers: auth })).status).toBe(200);
    const remembered = (JSON.parse(await readFile(portFile(), "utf8")) as { port: number }).port;
    expect([pa, pb]).toContain(remembered);
    expect(await stop(a), a.err()).toBe(0);
    expect(await stop(b), b.err()).toBe(0);
  }, 60_000);

  it("the remembered port and the reopen of the last library (Task 46a) do not hold each other up when either file is missing or unreadable", async () => {
    // A remembered port, and the last library's record unreadable (a folder in its place).
    const a = run({ stdin: `${TOKEN}\n` });
    const first = await ready(a);
    expect(await stop(a), a.err()).toBe(0);
    await rm(join(deps.appConfigDir, "last-library.json"), { recursive: true, force: true });
    await mkdir(join(deps.appConfigDir, "last-library.json"));
    const b = run({ stdin: `${TOKEN}\n` });
    expect(await ready(b)).toBe(first);
    expect((await fetch(`http://127.0.0.1:${first}/libraries`, { headers: auth })).status).toBe(200);
    expect(await stop(b), b.err()).toBe(0);
    // The last library remembered at a place that is gone, and the port file unreadable.
    const lib = join(tmp, "Lib");
    await (await createLibrary(lib, "Lib", deps)).close();
    const c = run({ env: baseEnv({ AO_NO_WORKER: "1", AO_LIBRARY: lib }), stdin: `${TOKEN}\n` });
    await ready(c);
    expect(await stop(c), c.err()).toBe(0);
    await rm(lib, { recursive: true, force: true });
    await rm(portFile(), { force: true });
    await mkdir(portFile());
    const d = run({ stdin: `${TOKEN}\n` });
    const port = await ready(d);
    const r = await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth });
    expect(r.status).toBe(200);
    expect(await stop(d), d.err()).toBe(0);
  }, 90_000);

  it("an explicit AO_SERVICE_PORT is used exactly, and neither read from nor written to the remembered port", async () => {
    const probe = await holdPort(0);
    const explicit = (probe.address() as { port: number }).port;
    await release(probe);
    await mkdir(deps.appConfigDir, { recursive: true });
    await writeFile(portFile(), JSON.stringify({ v: 1, port: 50123 }));
    const a = run({ env: baseEnv({ AO_NO_WORKER: "1", AO_SERVICE_PORT: String(explicit) }), stdin: `${TOKEN}\n` });
    expect(await ready(a)).toBe(explicit);
    expect(await stop(a), a.err()).toBe(0);
    expect(JSON.parse(await readFile(portFile(), "utf8"))).toEqual({ v: 1, port: 50123 });
  }, 60_000);
});

describe("this computer's identity cannot be read (Task 68, ruling 2)", () => {
  it("the service does not start with a new identity: it says why in plain words, without a path, and writes nothing", async () => {
    await mkdir(deps.appConfigDir, { recursive: true });
    await rm(join(deps.appConfigDir, "device.json"), { force: true });
    await mkdir(join(deps.appConfigDir, "device.json"));
    const r = run({ stdin: `${TOKEN}\n` });
    const { code } = await r.exit;
    expect(code).not.toBe(0);
    expect(r.out()).not.toMatch(/AO_SERVICE_READY/);
    expect(r.err()).toMatch(/could not start: This computer's identity for the app .* could not be read, so it was not replaced/);
    expect(r.err()).not.toContain(deps.appConfigDir);
    expect(r.err()).not.toContain(TOKEN);
    expect((await stat(join(deps.appConfigDir, "device.json"))).isDirectory()).toBe(true);
  }, 60_000);
});
