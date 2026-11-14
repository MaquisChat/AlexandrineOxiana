// The machine's set-up for the library scenarios (system-setup.ts, Task F19, R343 a): its pure parts —
// when it may run at all, the hosts block, the leftovers it refuses, the store's comparison — and the
// throw-away certificates (made with the system's openssl in a temporary folder; nothing of the
// machine is touched here).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STANDIN_NAMES } from "./library-standin.js";
import { hostsHoldsLeftover, hostsWith, makeCertificates, NOT_ASKED, refusal, snapshotDiff, snapshotDir, standinNamesOk, STANDIN_DOMAIN } from "./system-setup.js";

describe("when the machine's set-up may run", () => {
  it("only with AO_E2E_SYSTEM_SETUP exactly 1, on Linux, as root; otherwise NOT RUN with the reason", () => {
    expect(refusal({ env: { AO_E2E_SYSTEM_SETUP: "1" }, platform: "linux", uid: 0 })).toBeUndefined();
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) expect(refusal({ env: { AO_E2E_SYSTEM_SETUP: v }, platform: "linux", uid: 0 }), String(v)).toBe(NOT_ASKED);
    expect(NOT_ASKED.startsWith("not run:")).toBe(true);
    expect(refusal({ env: { AO_E2E_SYSTEM_SETUP: "1" }, platform: "darwin", uid: 0 })).toMatch(/^not run: .*Linux/);
    expect(refusal({ env: { AO_E2E_SYSTEM_SETUP: "1" }, platform: "linux", uid: 1000 })).toMatch(/^not run: .*root/);
  });
});

describe("the hosts block", () => {
  it("maps only the stand-in's made-up names, appended after the file's own bytes, marked", () => {
    expect(standinNamesOk(STANDIN_NAMES)).toBe(true);
    expect(STANDIN_NAMES.every((n) => n.endsWith(`.${STANDIN_DOMAIN}`))).toBe(true);
    const original = "127.0.0.1 localhost\n10.0.0.2 other\n";
    const out = hostsWith(original, STANDIN_NAMES, "abc123");
    expect(out.startsWith(original)).toBe(true);
    expect(out.slice(original.length)).toBe(`# ao-e2e-library-standin abc123 begin (the desktop library scenarios; removed when they end)\n127.0.0.1 ${STANDIN_NAMES.join(" ")}\n# ao-e2e-library-standin abc123 end\n`);
    // A file without a last newline keeps its bytes; the block starts on a line of its own.
    expect(hostsWith("127.0.0.1 localhost", ["a.ao-library-standin.test"], "r").startsWith("127.0.0.1 localhost\n# ao-e2e")).toBe(true);
  });

  it("never maps a real name, or anything that is not a plain host name", () => {
    for (const bad of [["api.crossref.org"], ["doi.org"], ["x.ao-library-standin.test.evil.org"], ["ao-library-standin.test"], ["a b.ao-library-standin.test"], ["x.ao-library-standin.test\n1.2.3.4 doi.org"], []]) {
      expect(standinNamesOk(bad), JSON.stringify(bad)).toBe(false);
      expect(() => hostsWith("", bad, "r"), JSON.stringify(bad)).toThrow(/made-up domain/);
    }
  });

  it("recognises what an earlier run left in the hosts file", () => {
    expect(hostsHoldsLeftover("127.0.0.1 localhost\n")).toBe(false);
    expect(hostsHoldsLeftover(hostsWith("127.0.0.1 localhost\n", STANDIN_NAMES, "r"))).toBe(true);
    expect(hostsHoldsLeftover("127.0.0.1 login.proxy.ao-library-standin.test\n")).toBe(true);
  });
});

describe("the store's comparison", () => {
  it("sees an added, a removed and a changed entry, a link's new target and a new mode; nothing when all is as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-store-test-"));
    try {
      writeFileSync(join(dir, "a.pem"), "A");
      writeFileSync(join(dir, "bundle.crt"), "A\nB\n");
      symlinkSync("a.pem", join(dir, "1234abcd.0"));
      mkdirSync(join(dir, "java"));
      writeFileSync(join(dir, "java", "cacerts"), "j");
      const before = snapshotDir(dir);
      expect(snapshotDiff(before, snapshotDir(dir))).toEqual([]);
      writeFileSync(join(dir, "bundle.crt"), "A\nB\nC\n");
      symlinkSync("/usr/local/share/ca-certificates/x.crt", join(dir, "x.pem"));
      rmSync(join(dir, "1234abcd.0"));
      symlinkSync("b.pem", join(dir, "1234abcd.0"));
      chmodSync(join(dir, "a.pem"), 0o600);
      rmSync(join(dir, "java", "cacerts"));
      expect(snapshotDiff(before, snapshotDir(dir))).toEqual(["added x.pem", "changed 1234abcd.0", "changed a.pem", "changed bundle.crt", "removed java/cacerts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the throw-away certificates", () => {
  it("an authority, and a certificate for every stand-in name that the authority verifies (one day)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-certs-test-"));
    try {
      const c = makeCertificates(dir, STANDIN_NAMES, "test");
      writeFileSync(join(dir, "check-ca.pem"), c.caPem);
      writeFileSync(join(dir, "check-server.pem"), c.certPem);
      const verify = spawnSync("openssl", ["verify", "-CAfile", join(dir, "check-ca.pem"), "-purpose", "sslserver", join(dir, "check-server.pem")], { encoding: "utf8" });
      expect(verify.stdout.trim(), verify.stderr).toMatch(/: OK$/);
      const text = spawnSync("openssl", ["x509", "-in", join(dir, "check-server.pem"), "-noout", "-ext", "subjectAltName"], { encoding: "utf8" }).stdout;
      for (const n of STANDIN_NAMES) expect(text).toContain(`DNS:${n}`);
      expect(c.keyPem).toMatch(/PRIVATE KEY/);
      expect(() => makeCertificates(dir, ["doi.org"], "test")).toThrow(/made-up domain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
