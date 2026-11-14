// The desktop end-to-end command's network namespace (netns.mjs, Task F19, R346 c, d): when it makes
// one, when it fails instead, and — where this machine allows it (root, unshare, python3) — the real
// namespace: the loopback brought up, an outside address unreachable at once, the loopback answering.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAILED, interfaces, NAMESPACE_TOOLS, plan, SWITCH, INSIDE } from "./netns.mjs";
import { SETUP_FAILED, SYSTEM_SETUP_SWITCH } from "./system-setup.js";

const NETNS = join(dirname(fileURLToPath(import.meta.url)), "netns.mjs");
const has = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
const CAN = process.platform === "linux" && process.getuid?.() === 0 && NAMESPACE_TOOLS.every(has) && spawnSync("unshare", ["--net", "--", "true"]).status === 0;

describe("when the e2e command makes a loopback-only network namespace (R346 d)", () => {
  const all = () => true;
  it("without the switch: Playwright as before, no namespace", () => {
    for (const v of [undefined, "", "0", "true"]) expect(plan({ env: { [SWITCH]: v }, platform: "linux", uid: 0, has: all })).toEqual({ kind: "direct" });
  });

  it("with the switch: itself again inside a namespace; inside, the check; any obstacle FAILS with its reason (R346 c)", () => {
    expect(plan({ env: { [SWITCH]: "1" }, platform: "linux", uid: 0, has: all })).toEqual({ kind: "reexec" });
    expect(plan({ env: { [SWITCH]: "1", [INSIDE]: "1" }, platform: "linux", uid: 0, has: all })).toEqual({ kind: "inside" });
    const fails = (p: Parameters<typeof plan>[0], why: RegExp) => {
      const o = plan(p);
      expect(o.kind).toBe("fail");
      expect(o.kind === "fail" && o.reason.startsWith(FAILED)).toBe(true);
      expect(o.kind === "fail" && o.reason).toMatch(why);
    };
    fails({ env: { [SWITCH]: "1" }, platform: "darwin", uid: 0, has: all }, /Linux/);
    fails({ env: { [SWITCH]: "1" }, platform: "linux", uid: 1000, has: all }, /root/);
    for (const t of NAMESPACE_TOOLS) fails({ env: { [SWITCH]: "1" }, platform: "linux", uid: 0, has: (x) => x !== t }, new RegExp(`${t} is not installed`));
    // The same switch and the same words as the scenarios' own set-up.
    expect(SWITCH).toBe(SYSTEM_SETUP_SWITCH);
    expect(FAILED).toBe(SETUP_FAILED);
  });

  it("reads the interfaces from /proc/net/dev", () => {
    const dev = "Inter-|   Receive\n face |bytes\n    lo:       0       0\n  eth0: 1 2\n";
    expect(interfaces(dev)).toEqual(["lo", "eth0"]);
  });

  it.skipIf(!CAN)("in a real namespace: the loopback is brought up (with a second loopback address, so that names resolve for the web view), an outside address fails at once, the loopback answers", () => {
    const r = spawnSync("unshare", ["--net", "--", process.execPath, NETNS, "--check-only"], { encoding: "utf8", env: { ...process.env, [SWITCH]: "1", [INSIDE]: "1" } });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/only the loopback interface .*with 127\.0\.0\.2 beside 127\.0\.0\.1\): 192\.0\.2\.1 unreachable \(ENETUNREACH, \d+ ms\); the loopback answers; localhost resolves \(IPv4, AI_ADDRCONFIG\)/);
  });

  it.skipIf(!CAN)("outside such a namespace the check fails, saying why", () => {
    const r = spawnSync(process.execPath, [NETNS, "--check-only"], { encoding: "utf8", env: { ...process.env, [SWITCH]: "1", [INSIDE]: "1" } });
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split("\n").at(-1)).toMatch(/^FAILED: .*not in a network namespace with only the loopback interface/);
  });
});
