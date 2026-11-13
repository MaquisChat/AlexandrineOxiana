// The built folder's entry point (scripts/launcher.mjs, shipped as service.mjs): R153 and review M4.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("./launcher.mjs", import.meta.url));
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function libc() {
  if (process.platform !== "linux") return undefined;
  return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
}

function folder(info) {
  const d = mkdtempSync(join(tmpdir(), "ao-launcher-"));
  dirs.push(d);
  copyFileSync(LAUNCHER, join(d, "service.mjs"));
  writeFileSync(join(d, "main.mjs"), 'process.stdout.write("MAIN RAN\\n");\n');
  if (info !== null) {
    const base = { platform: process.platform, arch: process.arch, node: process.version, nodeAbi: process.versions.modules, ...(libc() ? { libc: libc() } : {}) };
    writeFileSync(join(d, "build-info.json"), JSON.stringify({ ...base, ...info }));
  }
  return d;
}

function run(dir, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["NODE_OPTIONS", "NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH"].includes(k)));
  return spawnSync(process.execPath, ["service.mjs"], { cwd: dir, env: { ...clean, ...env }, encoding: "utf8", timeout: 30_000 });
}

describe("the built folder's launcher", () => {
  it("starts the bundled service when the environment and the build match", () => {
    const r = run(folder({}));
    expect(r.stdout).toBe("MAIN RAN\n");
    expect(r.status).toBe(0);
  });

  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH"]) {
    it(`refuses to start, in plain words, when ${name} is set (R153)`, () => {
      const dir = folder({});
      const value = name === "NODE_OPTIONS" ? "--no-warnings" : join(dir, "elsewhere");
      const r = run(dir, { [name]: value });
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("MAIN RAN");
      expect(r.stderr).toMatch(new RegExp(`The library service will not start: ${name} is set`));
      expect(r.stderr).not.toContain(dir);
    });
  }

  it("refuses to start when it was built for another platform, architecture or Node ABI (M4)", () => {
    for (const info of [{ nodeAbi: "1" }, { arch: "not-this-arch" }, { platform: "not-this-os" }]) {
      const r = run(folder(info));
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("MAIN RAN");
      expect(r.stderr).toMatch(/The library service will not start: it was built for /);
    }
  });

  it("refuses to start without its build information", () => {
    const r = run(folder(null));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build information .* missing or damaged/);
  });

  // A3 (d), A5: sixteen file threads, set before the first file call of the process (a stuck call on one watched
  // folder holds one thread; Node has four unless told otherwise). Proved on a started service: the real service
  // (src/main.ts, loaded through tsx after the launcher has run), its libuv threads counted from /proc.
  it.skipIf(process.platform !== "linux")("the thread pool is 16 in a started service; a larger value from the environment is kept", async () => {
    const tsxApi = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "esm", "api", "index.mjs");
    const main = pathToFileURL(fileURLToPath(new URL("../src/main.ts", import.meta.url))).href;
    for (const [given, want] of [[undefined, 16], ["4", 16], ["20", 20]]) {
      const dir = folder({});
      writeFileSync(join(dir, "main.mjs"), `import { register } from ${JSON.stringify(pathToFileURL(tsxApi).href)};\nregister();\nawait import(${JSON.stringify(main)});\n`);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["NODE_OPTIONS", "NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH", "UV_THREADPOOL_SIZE"].includes(k) && !k.toUpperCase().startsWith("AO_")));
      Object.assign(env, { AO_SERVICE_PORT: "0", AO_CONFIG_DIR: join(dir, "config"), AO_NO_WORKER: "1" }, given ? { UV_THREADPOOL_SIZE: given } : {});
      const child = spawn(process.execPath, ["service.mjs"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      try {
        child.stdin.write("threadpool-token-0123456789abcdefghijklmnopqrstuvwxyz\n");
        let out = "";
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        await new Promise((resolve, reject) => {
          child.stdout.on("data", (d) => {
            out += d.toString();
            if (/AO_SERVICE_READY port=\d+/.test(out)) resolve(undefined);
          });
          child.once("exit", (code) => reject(new Error(`exited early (${code}): ${err}`)));
        });
        const names = readdirSync(`/proc/${child.pid}/task`).map((t) => {
          try {
            return readFileSync(`/proc/${child.pid}/task/${t}/comm`, "utf8").trim();
          } catch {
            return "";
          }
        });
        expect(names.filter((n) => n === "libuv-worker").length, `UV_THREADPOOL_SIZE=${given}`).toBe(want);
      } finally {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await exited;
      }
    }
  }, 120_000);

  // R227: the development way of starting (`pnpm start`: tsx, no launcher) runs with sixteen too, from its script's
  // environment; a larger value is kept. The script is run as pnpm runs it (sh -c), and the service it starts is asked.
  it.skipIf(process.platform !== "linux")("the start script's service has 16 file threads; a larger value is kept", async () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const threadsOf = (pid) =>
      readdirSync(`/proc/${pid}/task`).map((t) => {
        try {
          return readFileSync(`/proc/${pid}/task/${t}/comm`, "utf8").trim();
        } catch {
          return "";
        }
      });
    /** The node process: the shell itself when it exec'd it, else its child. */
    const nodeOf = (pid) => {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "sh") return pid;
      return Number(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/)[0]);
    };
    for (const [given, want] of [[undefined, 16], ["4", 16], ["20", 20]]) {
      const dir = mkdtempSync(join(tmpdir(), "ao-start-"));
      dirs.push(dir);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["NODE_OPTIONS", "UV_THREADPOOL_SIZE"].includes(k) && !k.toUpperCase().startsWith("AO_")));
      Object.assign(env, { AO_SERVICE_PORT: "0", AO_CONFIG_DIR: join(dir, "config"), AO_NO_WORKER: "1" }, given ? { UV_THREADPOOL_SIZE: given } : {});
      const child = spawn("sh", ["-c", pkg.scripts.start], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      try {
        child.stdin.write("threadpool-token-0123456789abcdefghijklmnopqrstuvwxyz\n");
        let out = "";
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        await new Promise((resolve, reject) => {
          child.stdout.on("data", (d) => {
            out += d.toString();
            if (/AO_SERVICE_READY port=\d+/.test(out)) resolve(undefined);
          });
          child.once("exit", (code) => reject(new Error(`exited early (${code}): ${err}`)));
        });
        expect(threadsOf(nodeOf(child.pid)).filter((n) => n === "libuv-worker").length, `UV_THREADPOOL_SIZE=${given}`).toBe(want);
      } finally {
        const exited = new Promise((r) => child.once("exit", r));
        child.stdin.end();
        await exited;
      }
    }
  }, 120_000);
});
