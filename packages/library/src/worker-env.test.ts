import { describe, expect, it } from "vitest";
import { workerEnv } from "./worker-client.js";

describe("workerEnv", () => {
  it("never passes the passphrase or the worker token, but keeps other AO_ settings", () => {
    const env = workerEnv({ PATH: "/bin", AO_PASSPHRASE: "secret", ao_passphrase: "secret2", AO_WORKER_TOKEN: "t", AO_TOOLS_DIR: "/t" });
    expect(Object.keys(env).map((k) => k.toUpperCase()).sort()).toEqual(["AO_TOOLS_DIR", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("secret");
  });
});
