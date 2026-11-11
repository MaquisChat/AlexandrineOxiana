/**
 * The entry point as a launcher starts it (R98): the access token is written on standard input,
 * never put in the environment or the command line; the service refuses every other way, and the
 * token reaches no child process and no line it prints.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    // The launcher closing standard input later is not a reason to stop (it is no longer read).
    r.child.stdin!.end();
    await new Promise((res) => setTimeout(res, 300));
    expect((await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth })).status).toBe(200);
    expect(await stop(r), r.err()).toBe(0);
    expect(r.out()).toMatch(/AO_SERVICE_READY port=\d+\n/);
    expect(r.out()).not.toContain(TOKEN);
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
    expect(ms).toBeLessThan(TOKEN_STDIN_TIMEOUT_MS + 30_000);
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
