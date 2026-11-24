/**
 * The test run's network guard (net-guard.ts, FR-748, R544): inside a test run every request to a host that is not
 * this machine is refused before it leaves, named, and fails the test; requests to this machine still work; and the
 * guard's file does nothing when it is imported outside a test run. The hosts used here are made up (`.invalid`
 * never resolves), so nothing could leave the machine even if the guard were missing.
 */
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { MockAgent, getGlobalDispatcher, request, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { afterTest, beforeTest, guardRefusal, isLoopbackHost, netGuard, takeRefusedHosts } from "./net-guard.js";

const MADE_UP = "no-such-host.ao-net-guard.invalid";

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((_q, s) => s.end("here"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("the network guard of the test run (FR-748, R544)", () => {
  it("is the process's global dispatcher in a test run", () => {
    expect(netGuard()).toBeDefined();
    expect(getGlobalDispatcher()).toBe(netGuard()?.dispatcher);
  });

  it("refuses a request to a host that is not this machine, names the host and says what to do; the test is told", async () => {
    const err = (await request(`https://${MADE_UP}/works?filter=doi:10.1/x`).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(guardRefusal(MADE_UP));
    expect(err.message).toContain(`this test made a real request to ${MADE_UP}`);
    expect(err.message).toMatch(/metadata_lookup: \[\].*recorded answers.*MockAgent/u);
    // Recorded, so the test fails even where the code under test swallows the error (as the lookup client does).
    expect(takeRefusedHosts()).toEqual([MADE_UP]);
  });

  it("refuses Node's own fetch too (it reads the same process-wide dispatcher)", async () => {
    const err = (await fetch(`http://${MADE_UP}:8080/`).catch((e: unknown) => e)) as Error & { cause?: Error };
    expect(err.cause?.message).toBe(guardRefusal(MADE_UP));
    expect(takeRefusedHosts()).toEqual([MADE_UP]);
  });

  it("lets requests to this machine through: 127.0.0.1 and localhost, by undici and by fetch", async () => {
    expect(await (await request(`http://127.0.0.1:${port}/`)).body.text()).toBe("here");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("here");
    expect(await (await request(`http://localhost:${port}/`)).body.text()).toBe("here");
    expect(takeRefusedHosts()).toEqual([]);
  });

  it("knows which hosts are this machine", () => {
    for (const h of ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "service.localhost", "::1", "[::1]"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["api.openalex.org", "0.0.0.0", "10.0.0.1", "128.0.0.1", "localhost.example.com", "::2", "", "127.0.0.1.example.com"])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it("after a test: a refused request fails it, and a dispatcher the test left installed is taken out again", async () => {
    const guard = netGuard()?.dispatcher;
    // A refusal not yet taken fails the test, naming the host.
    beforeTest();
    await request(`https://${MADE_UP}/`).catch(() => {});
    expect(() => afterTest()).toThrow(new RegExp(`real request to ${MADE_UP.replace(/\./gu, "\\.")}`, "u"));
    expect(takeRefusedHosts()).toEqual([]);
    // A test that installs its own dispatcher and does not put the previous one back fails, and the guard is back.
    beforeTest();
    const own = new MockAgent();
    setGlobalDispatcher(own);
    expect(() => afterTest()).toThrow(/left its own global dispatcher/u);
    expect(getGlobalDispatcher()).toBe(guard);
    await own.close();
    // One that puts it back passes.
    beforeTest();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(new MockAgent());
    setGlobalDispatcher(previous);
    expect(() => afterTest()).not.toThrow();
  });

  it("does nothing when its file is imported outside a test run", () => {
    const file = fileURLToPath(new URL("./net-guard.ts", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TEST"));
    // undici itself installs its default dispatcher when first loaded: load it first, then the guard's file.
    const probe = `await import("undici");
const before = globalThis[Symbol.for("undici.globalDispatcher.2")];
const m = await import(${JSON.stringify(file)});
const after = globalThis[Symbol.for("undici.globalDispatcher.2")];
console.log(JSON.stringify({ guard: m.netGuard() !== undefined, same: before !== undefined && before === after }));`;
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { cwd, env, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout.trim())).toEqual({ guard: false, same: true });
  });
});
