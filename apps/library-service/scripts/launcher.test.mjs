// The built folder's entry point (scripts/launcher.mjs, shipped as service.mjs): R153 and review M4.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
});
