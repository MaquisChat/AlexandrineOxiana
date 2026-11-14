#!/usr/bin/env node
/**
 * The desktop end-to-end command (`pnpm --filter @ao/desktop run e2e`, and so `pnpm e2e --
 * --desktop-only`): Playwright with `e2e/playwright.config.ts` and the arguments given.
 *
 * With `AO_E2E_SYSTEM_SETUP=1` (the library scenarios asked for; Task F19, R346 d), "no outside
 * request" is made a fact rather than a belief: at its very start this command runs itself again
 * inside a NEW NETWORK NAMESPACE that has only the loopback interface (`unshare --net`; the run is root
 * already), so that everything the desktop scenarios start — the stand-in, the drivers, the virtual
 * display, the shell, its service and worker — can reach no server but those on 127.0.0.1. The
 * made-up names still resolve (the hosts file is the machine's). Inside, before Playwright starts:
 *
 *  1. `/proc/self/net/dev` must list `lo` and nothing else (else nothing is touched and the run fails);
 *  2. the loopback interface is brought up: there is no `ip` or `ifconfig` on this kind of machine, so
 *     with a few lines of the machine's Python (`SIOCGIFFLAGS`/`SIOCSIFFLAGS` on `lo`, `LOOPBACK_UP_PY`),
 *     which also gives `lo` a second loopback address, 127.0.0.2/32 (the alias `lo:1`; no other
 *     interface, no route out). Without it NO name resolves for the web view: GLib (and so WebKitGTK)
 *     looks a name up per address family with `AI_ADDRCONFIG`, and glibc then answers IPv4 names only
 *     when the machine has an IPv4 address other than 127.0.0.1 — even names in the hosts file (seen:
 *     "Error resolving …: Name or service not known" in the sign-in window, in a namespace with
 *     127.0.0.1 alone);
 *  3. the proof: a connection to an outside address (192.0.2.1, TEST-NET-1, never routed) fails AT
 *     ONCE; a server on 127.0.0.1 answers; and `localhost` resolves the way the web view asks (IPv4,
 *     `AI_ADDRCONFIG`).
 *
 * If the namespace cannot be made or the proof fails, the run FAILS with the reason in its last lines
 * (R346 c). Without the switch nothing of this happens: Playwright runs as before, and the library
 * scenarios are reported NOT RUN.
 *
 * SIGTERM and SIGHUP are passed on to the command inside; SIGINT is not (Ctrl+C reaches every process
 * of the terminal's group already, and a second one would make Playwright stop without its clean-up).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ADDRCONFIG, lookup } from "node:dns";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SWITCH = "AO_E2E_SYSTEM_SETUP";
/** Set by this command on itself inside the namespace (so that it does not make another). */
export const INSIDE = "AO_E2E_NETNS";
/** As system-setup.ts SETUP_FAILED (netns.test.ts holds them equal). */
export const FAILED = "FAILED: the library scenarios were asked for (AO_E2E_SYSTEM_SETUP=1) but the machine's set-up cannot be made:";
/** The machine's tools the namespace needs (not dependencies of the project). */
export const NAMESPACE_TOOLS = ["unshare", "python3"];
/** TEST-NET-1 (RFC 5737): an outside address that is never routed anywhere. */
export const OUTSIDE = { host: "192.0.2.1", port: 443 };
/** The loopback's second address (see the file comment): on `lo` itself, so no route leads out. */
export const SECOND_LOOPBACK = "127.0.0.2";
/**
 * Brings `lo` up — SIOCGIFFLAGS, then SIOCSIFFLAGS with IFF_UP (a struct ifreq: 16 bytes of name, the
 * flags) — and gives it its second address: SIOCSIFADDR and SIOCSIFNETMASK (/32) on the alias `lo:1`.
 */
export const LOOPBACK_UP_PY = [
  "import fcntl, socket, struct",
  "s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)",
  'req = struct.pack("16sH22x", b"lo", 0)',
  'flags = struct.unpack("16sH22x", fcntl.ioctl(s, 0x8913, req))[1]',
  'fcntl.ioctl(s, 0x8914, struct.pack("16sH22x", b"lo", flags | 1))',
  'sin = lambda ip: struct.pack("16sH2s4s8x", b"lo:1", socket.AF_INET, b"\\0\\0", socket.inet_aton(ip))',
  `fcntl.ioctl(s, 0x8916, sin("${SECOND_LOOPBACK}"))`,
  'fcntl.ioctl(s, 0x891c, sin("255.255.255.255"))',
].join("\n");

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "playwright.config.ts");

/** What this command does: Playwright directly, itself again inside a namespace, the check inside, or fail. */
export function plan({ env, platform, uid, has }) {
  if (env[SWITCH] !== "1") return { kind: "direct" };
  if (env[INSIDE] === "1") return { kind: "inside" };
  const fail = (why) => ({ kind: "fail", reason: `${FAILED} ${why}` });
  if (platform !== "linux") return fail(`the loopback-only network namespace is made on Linux only (this is ${platform})`);
  if (uid !== 0) return fail("it needs root (it makes a network namespace, and changes /etc/hosts and the system's certificate store)");
  for (const t of NAMESPACE_TOOLS) if (!has(t)) return fail(`${t} is not installed (the loopback-only network namespace needs it)`);
  return { kind: "reexec" };
}

/** The interfaces `/proc/net/dev` lists. */
export function interfaces(netDev) {
  return netDev
    .split("\n")
    .slice(2)
    .map((l) => l.split(":")[0].trim())
    .filter(Boolean);
}

function outsideFails() {
  return new Promise((done) => {
    const t0 = Date.now();
    const c = connect(OUTSIDE.port, OUTSIDE.host);
    const timer = setTimeout(() => {
      c.destroy();
      done({ ok: false, why: `a connection to ${OUTSIDE.host} did not fail at once (no answer in 3 s)` });
    }, 3000);
    c.on("connect", () => {
      clearTimeout(timer);
      c.destroy();
      done({ ok: false, why: `${OUTSIDE.host} could be reached` });
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: true, code: e.code, ms: Date.now() - t0 });
    });
  });
}

function loopbackAnswers() {
  return new Promise((done) => {
    const s = createServer((x) => x.end("ok"));
    const timer = setTimeout(() => {
      s.close();
      done(false);
    }, 3000);
    s.on("error", () => done(false));
    s.listen(0, "127.0.0.1", () => {
      const c = connect(s.address().port, "127.0.0.1");
      let got = "";
      c.on("data", (d) => (got += d));
      c.on("error", () => {
        clearTimeout(timer);
        s.close();
        done(false);
      });
      c.on("end", () => {
        clearTimeout(timer);
        s.close();
        done(got === "ok");
      });
    });
  });
}

/** Inside the namespace: the loopback brought up, then the proof. The line to print, or throws with the reason. */
export async function checkNamespace() {
  // Looked at first: outside such a namespace nothing is touched, not even the loopback's flags.
  const names = interfaces(readFileSync("/proc/self/net/dev", "utf8"));
  const other = names.filter((n) => n !== "lo");
  if (other.length || !names.includes("lo")) throw new Error(`not in a network namespace with only the loopback interface (it has: ${names.join(", ") || "none"})`);
  const up = spawnSync("python3", ["-I", "-c", LOOPBACK_UP_PY], { encoding: "utf8" });
  if (up.status !== 0) throw new Error(`the loopback interface could not be brought up: ${(up.stderr || up.error?.message || `exit ${up.status}`).trim().slice(0, 300)}`);
  const out = await outsideFails();
  if (!out.ok) throw new Error(out.why);
  if (!(await loopbackAnswers())) throw new Error("the loopback interface does not answer");
  const resolved = await new Promise((done) => lookup("localhost", { family: 4, hints: ADDRCONFIG }, (e, a) => done(e ? `not (${e.code})` : a)));
  if (resolved !== "127.0.0.1") throw new Error(`localhost does not resolve the way the web view asks (IPv4, AI_ADDRCONFIG): ${resolved}`);
  return `e2e: in a network namespace with only the loopback interface (brought up with python3's SIOCSIFFLAGS, with ${SECOND_LOOPBACK} beside 127.0.0.1): ${OUTSIDE.host} unreachable (${out.code}, ${out.ms} ms); the loopback answers; localhost resolves (IPv4, AI_ADDRCONFIG)`;
}

/** Runs `cmd`, passing on SIGTERM and SIGHUP (not SIGINT, see the file comment); resolves its exit status. */
function runChild(cmd, args, env) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    const pass = (sig) => () => child.kill(sig);
    const handlers = { SIGTERM: pass("SIGTERM"), SIGHUP: pass("SIGHUP"), SIGINT: () => {} };
    for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);
    child.on("error", (e) => {
      process.stderr.write(`e2e: ${cmd} could not be started: ${e.message}\n`);
      done(1);
    });
    child.on("exit", (code, signal) => {
      for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
      done(code ?? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 0));
    });
  });
}

const failWith = (reason) => {
  process.stdout.write(`\n  ${reason}\n`);
  process.exit(1);
};

async function main(argv) {
  const has = (t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
  const p = plan({ env: process.env, platform: process.platform, uid: process.getuid?.(), has });
  const checkOnly = argv[0] === "--check-only";
  if (p.kind === "fail") return failWith(p.reason);
  if (p.kind === "reexec") {
    const tried = spawnSync("unshare", ["--net", "--", "true"], { encoding: "utf8" });
    if (tried.status !== 0) return failWith(`${FAILED} a network namespace cannot be made here (unshare --net: ${(tried.stderr || tried.error?.message || `exit ${tried.status}`).trim().slice(0, 300)})`);
  }
  if (p.kind === "reexec") process.exit(await runChild("unshare", ["--net", "--", process.execPath, fileURLToPath(import.meta.url), ...argv], { ...process.env, [INSIDE]: "1" }));
  if (p.kind === "inside") {
    try {
      process.stdout.write(`${await checkNamespace()}\n`);
    } catch (err) {
      return failWith(`${FAILED} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (checkOnly) process.exit(0);
  process.exit(await runChild("playwright", ["test", "-c", CONFIG, ...argv], process.env));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
