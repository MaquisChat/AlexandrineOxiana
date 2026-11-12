/**
 * The service listens again on the port it used last time (R171, defect D13): remembered in the
 * app's settings folder, only when it is asked for any port.
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenOnRememberedPort, PORT_SETTING, rememberedPort, usablePort } from "./port-memory.js";

let tmp: string;
const servers: Server[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-port-memory-"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(tmp, { recursive: true, force: true });
});

/** A plain net server on 127.0.0.1, standing in for the service (or for another program on the port). */
function listener(): (port: number) => Promise<number> {
  return (port) =>
    new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => {
        servers.push(s);
        const a = s.address();
        resolve(typeof a === "object" && a ? a.port : port);
      });
    });
}

async function close(port: number): Promise<void> {
  const i = servers.findIndex((s) => {
    const a = s.address();
    return typeof a === "object" && a?.port === port;
  });
  const [s] = servers.splice(i, 1);
  await new Promise<void>((r) => s!.close(() => r()));
}

const quiet = { warn: () => {} };

describe("usablePort", () => {
  it("takes an integer from 1024 to 65535 only", () => {
    expect(usablePort(4318)).toBe(4318);
    expect(usablePort(1024)).toBe(1024);
    expect(usablePort(65535)).toBe(65535);
    for (const bad of ["4318", 0, 80, 1023, 70000, 65536, 4318.5, -1, null, undefined, NaN, {}]) expect(usablePort(bad)).toBeUndefined();
  });
});

describe("listenOnRememberedPort (any port asked for)", () => {
  it("first run: any free port, and that port is remembered", async () => {
    const port = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    expect(port).toBeGreaterThan(0);
    expect(await rememberedPort(tmp)).toBe(port);
    expect(JSON.parse(await readFile(join(tmp, PORT_SETTING), "utf8"))).toEqual({ v: 1, port });
  });

  it("the same port again after a restart with the same settings folder", async () => {
    const first = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    await close(first);
    const second = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    expect(second).toBe(first);
  });

  it("a remembered port that is taken: another free port, and the new one is remembered (no flapping back)", async () => {
    const first = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    // `first` stays taken (another program holds it).
    const second = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    expect(second).not.toBe(first);
    expect(await rememberedPort(tmp)).toBe(second);
    await close(first);
    await close(second);
    const third = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    expect(third).toBe(second);
  });

  it("ignores a remembered port held through a symbolic link (review M4)", async () => {
    await writeFile(join(tmp, "elsewhere.json"), JSON.stringify({ v: 1, port: 40000 }));
    await symlink(join(tmp, "elsewhere.json"), join(tmp, PORT_SETTING));
    expect(await rememberedPort(tmp)).toBeUndefined();
  });

  it("ignores a remembered value that is not a usable port (text, 0, 70000, a privileged port, broken JSON, another version, an oversized file)", async () => {
    for (const raw of [`{"v":1,"port":"4318"}`, `{"v":1,"port":0}`, `{"v":1,"port":70000}`, `{"v":1,"port":80}`, `not json`, `[]`, `null`, `{"v":2,"port":40000}`, `{"port":40000}`, `{"v":1,"port":40000,"pad":"${"x".repeat(5000)}"}`]) {
      await writeFile(join(tmp, PORT_SETTING), raw);
      const tried: number[] = [];
      const base = listener();
      const port = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: (p) => (tried.push(p), base(p)), ...quiet });
      expect(tried, raw).toEqual([0]);
      expect(await rememberedPort(tmp)).toBe(port);
      await close(port);
    }
  });

  it("a settings folder that cannot be written does not stop it: it listens, and warns without a path", async () => {
    // A folder where the settings file should be: the file can be neither read nor replaced (works as root too).
    await mkdir(join(tmp, PORT_SETTING));
    const warnings: string[] = [];
    const port = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), warn: (m) => warnings.push(m) });
    expect(port).toBeGreaterThan(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/port could not be remembered/i);
    expect(warnings[0]).not.toContain(tmp);
    expect(warnings[0]).not.toMatch(/[/\\]/);
  });

  it("does not write again when the port did not change", async () => {
    const first = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    await close(first);
    // An atomic write replaces the file (a new inode); an untouched file keeps its own.
    const before = (await stat(join(tmp, PORT_SETTING))).ino;
    const again = await listenOnRememberedPort({ requested: 0, configDir: tmp, listen: listener(), ...quiet });
    expect(again).toBe(first);
    expect((await stat(join(tmp, PORT_SETTING))).ino).toBe(before);
  });
});

describe("listenOnRememberedPort (an explicit port)", () => {
  it("is used exactly, neither read from nor written to the remembered value", async () => {
    const probe = await listener()(0);
    await close(probe);
    await writeFile(join(tmp, PORT_SETTING), JSON.stringify({ v: 1, port: 50000 }));
    const tried: number[] = [];
    const base = listener();
    const port = await listenOnRememberedPort({ requested: probe, configDir: tmp, listen: (p) => (tried.push(p), base(p)), ...quiet });
    expect(port).toBe(probe);
    expect(tried).toEqual([probe]);
    expect(JSON.parse(await readFile(join(tmp, PORT_SETTING), "utf8"))).toEqual({ v: 1, port: 50000 });
  });

  it("an explicit port that is taken fails as before (no fallback)", async () => {
    const taken = await listener()(0);
    await expect(listenOnRememberedPort({ requested: taken, configDir: tmp, listen: listener(), ...quiet })).rejects.toThrow();
    await expect(readFile(join(tmp, PORT_SETTING), "utf8")).rejects.toThrow();
  });
});
