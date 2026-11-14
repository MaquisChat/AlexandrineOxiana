/**
 * The service's side of the three test-only switches (Task Z11, Ruling R289 a): main.ts reads AO_SECRETS,
 * AO_ZOTERO_API_ORIGIN and AO_ZOTERO_TICK_MS once at its start (the library's readers, tested in
 * packages/library/src/import/test-switches.test.ts), refuses to start in test mode on a value not in its exact
 * form with a sentence naming the variable, ignores all three outside test mode, and passes the tick on through
 * `ServiceOptions.zoteroTickMs`. Nothing here reaches any host but 127.0.0.1: the "Zotero" is a local server that
 * answers `/keys/current` itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps } from "@ao/library";
import { createService } from "./server.js";

const TOKEN = "switch-token-0123456789abcdefghijklmnopqrstuvwxyz";
const ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../", import.meta.url));
/** A made-up key in the shape the product accepts; never a real one. */
const KEY = "MadeUpSwitchKey012345678";

let tmp: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-service-switches-"));
});

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await rm(tmp, { recursive: true, force: true });
});

/** This environment without any AO_ variable and without NODE_ENV, plus `extra`. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("AO_") && k !== "NODE_ENV" && k !== "VITEST") out[k] = v;
  return { ...out, AO_SERVICE_PORT: "0", AO_CONFIG_DIR: join(tmp, "config"), AO_NO_WORKER: "1", ...extra };
}

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exit: Promise<number | null>;
}

function run(e: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], { cwd: CWD, env: e, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  child.stdin!.on("error", () => {});
  child.stdin!.write(`${TOKEN}\n`);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
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
    void r.exit.then((code) => reject(new Error(`exited early (code ${code}): ${r.err()}`)));
  });
}

async function stop(r: Run): Promise<number | null> {
  r.child.kill("SIGTERM");
  return r.exit;
}

const call = (port: number, method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("the test-only switches at the service's start (Task Z11, R289 a)", () => {
  it("in test mode a switch not in its exact form refuses the start with a sentence naming the variable (never the origin's value)", async () => {
    const cases: Array<[string, string]> = [
      ["AO_ZOTERO_API_ORIGIN", "http://localhost:4567"],
      ["AO_ZOTERO_API_ORIGIN", "https://10.20.30.40:4567"],
      ["AO_SECRETS", "keyring"],
      ["AO_ZOTERO_TICK_MS", "50"],
    ];
    for (const [name, value] of cases) {
      const r = run(env({ NODE_ENV: "test", [name]: value }));
      expect(await r.exit, `${name}=${value}`).toBe(1);
      expect(r.out()).not.toMatch(/AO_SERVICE_READY/u);
      expect(r.err()).toMatch(new RegExp(`^The library service could not start: ${name} `, "u"));
      expect(r.err()).toMatch(/so the library service was not started\.\n$/u);
      if (name === "AO_ZOTERO_API_ORIGIN") expect(r.err()).not.toMatch(/localhost|10\.20\.30\.40|4567/u);
      expect(r.err()).not.toContain(TOKEN);
    }
  }, 120_000);

  it("outside test mode all three are ignored: wrong values start the service as usual", async () => {
    for (const mode of [undefined, "production", "development"]) {
      const r = run(env({ ...(mode ? { NODE_ENV: mode } : {}), AO_ZOTERO_API_ORIGIN: "http://localhost:4567", AO_SECRETS: "keyring", AO_ZOTERO_TICK_MS: "5" }));
      await ready(r);
      expect(await stop(r), String(mode)).toBe(0);
    }
  }, 120_000);

  it("in test mode the origin and memory switches are in force from the start: the key check reaches the loopback stand-in", async () => {
    const seen: Array<{ path: string; keySent: boolean }> = [];
    const zotero: Server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", keySent: req.headers["zotero-api-key"] === KEY });
      if (req.url === "/keys/current") {
        res.writeHead(200, { "content-type": "application/json", "zotero-api-version": "3" });
        res.end(JSON.stringify({ key: KEY, userID: 42, username: "someone", access: { user: { library: true, files: true, notes: true, write: false } } }));
      } else if (req.url?.startsWith("/users/42/groups")) {
        res.writeHead(200, { "content-type": "application/json", "total-results": "0" });
        res.end("[]");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((done) => zotero.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(zotero.address() as AddressInfo).port}`;
    try {
      const r = run(env({ NODE_ENV: "test", AO_ZOTERO_API_ORIGIN: origin, AO_SECRETS: "memory", AO_ZOTERO_TICK_MS: "1000" }));
      const port = await ready(r);
      expect((await call(port, "PUT", "/secrets/zotero-api-key", { apiKey: KEY })).status).toBe(200);
      const check = await call(port, "POST", "/zotero/key-check");
      expect(check.status, await check.clone().text()).toBe(200);
      expect(seen.map((s) => s.path)).toContain("/keys/current");
      expect(seen.every((s) => s.keySent)).toBe(true);
      expect(await stop(r)).toBe(0);
      // The key went nowhere it should not: not in the service's output.
      expect(r.out() + r.err()).not.toContain(KEY);
      // A restart forgets it (memory only).
      const again = run(env({ NODE_ENV: "test", AO_ZOTERO_API_ORIGIN: origin, AO_SECRETS: "memory" }));
      const port2 = await ready(again);
      expect(await (await call(port2, "GET", "/secrets/zotero-api-key")).json()).toEqual({ stored: false });
      expect(await stop(again)).toBe(0);
    } finally {
      await new Promise<void>((done) => zotero.close(() => done()));
    }
  }, 120_000);

  it("createService passes zoteroTickMs on to the scheduler's options", async () => {
    const deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
    const withTick = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent", zoteroTickMs: 1000 });
    expect(withTick.state.opts.zoteroTickMs).toBe(1000);
    await withTick.close();
    const without = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent" });
    expect(without.state.opts.zoteroTickMs).toBeUndefined();
    await without.close();
  });
});
