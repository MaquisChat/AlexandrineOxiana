import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWorker, workerEnv } from "./worker-client.js";

describe("workerEnv", () => {
  it("never passes the passphrase or the worker token, but keeps other AO_ settings", () => {
    const env = workerEnv({ PATH: "/bin", AO_PASSPHRASE: "secret", ao_passphrase: "secret2", AO_WORKER_TOKEN: "t", AO_TOOLS_DIR: "/t" });
    expect(Object.keys(env).map((k) => k.toUpperCase()).sort()).toEqual(["AO_TOOLS_DIR", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  it("never passes the library service's own token variable, whatever its case (R98, defence in depth)", () => {
    const env = workerEnv({ PATH: "/bin", AO_SERVICE_TOKEN: "service-secret", ao_service_token: "service-secret2", AO_TOOLS_DIR: "/t" });
    expect(Object.keys(env).map((k) => k.toUpperCase()).sort()).toEqual(["AO_TOOLS_DIR", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("service-secret");
  });

  it("a worker started while the service's token variable is set does not see it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-worker-env-"));
    const dump = join(dir, "env.json");
    // A stand-in worker: it records its environment, says it is ready, and waits to be stopped.
    const script = `require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); console.log("AO_WORKER_READY port=1"); setInterval(() => {}, 1000);`;
    const before = process.env.AO_SERVICE_TOKEN;
    process.env.AO_SERVICE_TOKEN = "service-token-that-must-not-reach-a-child-0123456789";
    try {
      const handle = await startWorker({ command: [process.execPath, "-e", script], readyTimeoutMs: 30_000 });
      await handle.stop();
      const seen = await readFile(dump, "utf8");
      expect(Object.keys(JSON.parse(seen) as Record<string, string>).filter((k) => /SERVICE_TOKEN/i.test(k))).toEqual([]);
      expect(seen).not.toContain("service-token-that-must-not-reach-a-child");
    } finally {
      if (before === undefined) delete process.env.AO_SERVICE_TOKEN;
      else process.env.AO_SERVICE_TOKEN = before;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
