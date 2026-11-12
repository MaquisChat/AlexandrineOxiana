// The launch check's own logic: reading the shell's test output and judging the probe's result and
// the helpers' environments. (The check itself needs a display and the built shell: launch-check.mjs.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXPECTED_IPC, envNamesFromPsE, helperProblems, parseArgs, parseLsofListen, parsePs, parseShellLine, probeProblems, shellOf } from "./launch-check.mjs";

const GOOD = {
  origin: "tauri://localhost",
  connectionRemovedByApp: true,
  baseUrl: "http://127.0.0.1:41851",
  ipc: { ...EXPECTED_IPC },
  fetch: "ok",
  events: "ok",
  library: "ok",
  worker: "ok",
  picture: "ok (64x48)",
  audio: "ok (2 s)",
  video: "ok (160x120, 2 s)",
};

describe("parseShellLine", () => {
  it("reads each report the shell prints in test mode, and nothing else", () => {
    assert.deepEqual(parseShellLine("AO_SHELL_SERVICE pid=12 port=4000 shell=11"), { kind: "service", pid: 12, port: 4000, shell: 11 });
    assert.deepEqual(parseShellLine("AO_SHELL_WINDOW label=main visible=true"), { kind: "window", label: "main", visible: true });
    assert.deepEqual(parseShellLine('AO_SHELL_TITLE AO_PROBE {"fetch":"ok"}'), { kind: "probe", result: { fetch: "ok" } });
    assert.deepEqual(parseShellLine("AO_SHELL_TITLE AO_PROBE {broken"), { kind: "probe", result: null });
    assert.deepEqual(parseShellLine("AO_SHELL_STOPPED forced"), { kind: "stopped", how: "forced" });
    assert.deepEqual(parseShellLine("AO_SHELL_FAILED The library service will not start: x."), { kind: "failed", message: "The library service will not start: x." });
    assert.deepEqual(parseShellLine("AO_SHELL_SECOND_LAUNCH"), { kind: "second-launch" });
    assert.deepEqual(parseShellLine("AO_SHELL_CLOSING"), { kind: "closing" });
    assert.deepEqual(parseShellLine("AO_SHELL_RELAUNCH_REQUESTED"), { kind: "relaunch-requested" });
    assert.deepEqual(parseShellLine("AO_SHELL_RELAUNCHING"), { kind: "relaunching" });
    for (const other of ["AO_SHELL_TITLE Alexandrine Oxiana", "[service] {}", "AO_SHELL_SERVICE pid=1 port=2", ""]) assert.equal(parseShellLine(other), null, other);
  });
});

describe("probeProblems", () => {
  it("accepts a complete result", () => {
    assert.deepEqual(probeProblems(GOOD, { media: true }), []);
    const { audio: _a, video: _v, ...noMedia } = GOOD;
    assert.deepEqual(probeProblems(noMedia, { media: false }), []);
  });

  it("names every failed check, a foreign origin, a kept connection and a widened permission", () => {
    const bad = { ...GOOD, origin: "null", connectionRemovedByApp: false, picture: "failed: the blob: picture did not decode", video: undefined, ipc: { ...EXPECTED_IPC, "fs.readFile": "allowed" } };
    const p = probeProblems(bad, { media: true });
    assert.equal(p.length, 5, p.join("\n"));
    assert.match(p.join("\n"), /origin is null/);
    assert.match(p.join("\n"), /did not take/);
    assert.match(p.join("\n"), /picture: failed/);
    assert.match(p.join("\n"), /video: not reported/);
    assert.match(p.join("\n"), /fs\.readFile is allowed, expected denied/);
    assert.deepEqual(probeProblems(null, { media: false }), ["the probe reported nothing readable"]);
  });
});

describe("helperProblems", () => {
  it("accepts the allow-listed names", () => {
    assert.deepEqual(helperProblems("the service", ["PATH", "HOME", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "AO_SERVICE_PORT", "AO_WORKER_BIN", "AO_TOOLS_DIR"], "/node --max-old-space-size=512 /app/service.mjs"), []);
  });

  it("flags a token variable, a name off the list and a token-like argument", () => {
    const p = helperProblems("the worker", ["PATH", "AO_WORKER_TOKEN", "NODE_OPTIONS", "NODE_ENV"], `python -m ao_worker ${"ab".repeat(32)}`);
    assert.equal(p.length, 4, p.join("\n"));
    assert.match(p[0], /AO_WORKER_TOKEN in its environment/);
    assert.match(p[1], /NODE_OPTIONS, which is not on the allow-list/);
    assert.match(p[2], /NODE_ENV/);
    assert.match(p[3], /token-like/);
  });
});

describe("helperProblems on a Mac", () => {
  it("accepts the text-encoding variable CoreFoundation sets inside a process, on macOS only", () => {
    assert.deepEqual(helperProblems("the service", ["PATH", "__CF_USER_TEXT_ENCODING"], "node", "darwin"), []);
    assert.equal(helperProblems("the service", ["PATH", "__CF_USER_TEXT_ENCODING"], "node", "linux").length, 1);
    assert.equal(helperProblems("the service", ["XPC_SERVICE_NAME"], "node", "darwin").length, 1);
  });
});

describe("parseArgs (launch check)", () => {
  it("reads --app and --release-app and refuses anything else", () => {
    assert.deepEqual(parseArgs([]), { app: undefined, releaseApp: undefined });
    assert.deepEqual(parseArgs(["--", "--app", "/x/A.app"]), { app: "/x/A.app", releaseApp: undefined });
    assert.deepEqual(parseArgs(["--release-app=/v/A.app"]), { app: undefined, releaseApp: "/v/A.app" });
    assert.throws(() => parseArgs(["--app"]), /--app needs/);
    assert.throws(() => parseArgs(["--headless"]), /unknown option/);
  });
  it("finds the program inside an app bundle", () => {
    assert.equal(shellOf("/b/Alexandrine Oxiana.app"), "/b/Alexandrine Oxiana.app/Contents/MacOS/alexandrine-oxiana");
  });
});

describe("process listing on a Mac (ps)", () => {
  it("reads pid, parent, state and command line", () => {
    const text = "  101     1 Ss   /Applications/X.app/Contents/MacOS/x --flag\n  202   101 S+   /x/Resources/node/node --max-old-space-size=512 /x/Resources/library-service/service.mjs\n  303   202 Z    (ao-worker)\n\n";
    assert.deepEqual(parsePs(text), [
      { pid: 101, ppid: 1, state: "S", cmd: "/Applications/X.app/Contents/MacOS/x --flag" },
      { pid: 202, ppid: 101, state: "S", cmd: "/x/Resources/node/node --max-old-space-size=512 /x/Resources/library-service/service.mjs" },
      { pid: 303, ppid: 202, state: "Z", cmd: "(ao-worker)" },
    ]);
  });
  it("reads the variable names that `ps -E` appends after the command line", () => {
    const cmd = "/x/node --max-old-space-size=512 /x/service.mjs";
    assert.deepEqual(envNamesFromPsE(`${cmd} PATH=/usr/bin:/bin HOME=/Users/r LANG=en_GB.UTF-8 AO_CONFIG_DIR=/Users/r/Library/Application Support/x/settings __CF_USER_TEXT_ENCODING=0x1F5:0x0:0x2`, cmd), [
      "PATH",
      "HOME",
      "LANG",
      "AO_CONFIG_DIR",
      "__CF_USER_TEXT_ENCODING",
    ]);
    assert.deepEqual(envNamesFromPsE(cmd, cmd), []);
  });
  it("reads the listening ports lsof reports", () => {
    const text = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 202 runner 21u IPv4 0x1 0t0 TCP 127.0.0.1:53817 (LISTEN)\nnode 202 runner 22u IPv6 0x2 0t0 TCP [::1]:53818 (LISTEN)\n";
    assert.deepEqual(parseLsofListen(text), [{ host: "127.0.0.1", port: 53817 }, { host: "::1", port: 53818 }]);
    assert.deepEqual(parseLsofListen(""), []);
  });
});
