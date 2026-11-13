// The launch check's own logic: reading the shell's test output and judging the probe's result and
// the helpers' environments. (The check itself needs a display and the built shell: launch-check.mjs.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appProcesses, CAPABILITIES_DIR, capabilityProblems, envEvidenceProblems, envNamesFromEnviron, envNamesFromPsE, EXPECTED_IPC, helperProblems, NOT_PROBED_IPC, parseArgs, parseLsofListen, parsePs, parseShellLine, probeProblems, shellOf, TAURI_CONF } from "./launch-check.mjs";

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

describe("what the page may ask of the shell (capabilities/main-window.json; Task W6, R207)", () => {
  const read = () => ({
    files: readdirSync(CAPABILITIES_DIR),
    capability: JSON.parse(readFileSync(join(CAPABILITIES_DIR, "main-window.json"), "utf8")),
    conf: JSON.parse(readFileSync(TAURI_CONF, "utf8")),
  });

  it("the page may pick a watched folder and nothing more", () => {
    // The expected table changes by exactly this one entry.
    assert.equal(EXPECTED_IPC["watch.pick"], "allowed");
    assert.deepEqual(
      Object.keys(EXPECTED_IPC).sort(),
      ["app.version", "dialog.message", "dialog.save", "event.emit", "event.listen", "fs.readFile", "path.resolveDirectory", "watch.pick", "webview.print", "window.close"],
    );
    // The probe does not call it (it would open the chooser); the capability file is read instead.
    assert.deepEqual(NOT_PROBED_IPC, { "watch.pick": "allow-pick-watch-folder" });
    const { files, capability, conf } = read();
    assert.deepEqual(capabilityProblems({ files, capability, conf }), []);
    assert.deepEqual(capability.permissions, ["core:event:allow-listen", "core:event:allow-unlisten", "dialog:allow-open", "allow-pick-watch-folder"]);

    const { "watch.pick": _w, ...probed } = EXPECTED_IPC;
    assert.deepEqual(probeProblems({ ...GOOD, ipc: probed }, { media: true }), []);
    // Should a probe ever report it, its answer must still be the expected one.
    assert.match(probeProblems({ ...GOOD, ipc: { ...EXPECTED_IPC, "watch.pick": "denied" } }, { media: true }).join("\n"), /watch\.pick is denied, expected allowed/);
  });

  it("flags a capability that grants more, reaches another window or a remote page, or loses the chooser", () => {
    const { files, capability, conf } = read();
    const with_ = (over) => capabilityProblems({ files, capability: { ...capability, ...over }, conf });
    for (const extra of ["fs:default", "dialog:allow-save", "dialog:default", "core:window:allow-close", "shell:allow-open"]) {
      assert.match(with_({ permissions: [...capability.permissions, extra] }).join("\n"), new RegExp(`grants ${extra.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), extra);
    }
    assert.match(with_({ permissions: capability.permissions.filter((p) => p !== "allow-pick-watch-folder") }).join("\n"), /does not grant allow-pick-watch-folder/);
    assert.match(with_({ windows: ["main", "second"] }).join("\n"), /windows/);
    assert.match(with_({ windows: ["*"] }).join("\n"), /windows/);
    assert.match(with_({ webviews: ["other"] }).join("\n"), /webviews/);
    assert.match(with_({ local: false }).join("\n"), /local/);
    assert.match(with_({ remote: { urls: ["https://example.org/*"] } }).join("\n"), /remote/);
    assert.match(with_({ platforms: ["macOS"], extra: 1 }).join("\n"), /extra/);
    assert.match(capabilityProblems({ files: [...files, "second.json"], capability, conf }).join("\n"), /second\.json/);
    assert.match(capabilityProblems({ files, capability, conf: { ...conf, app: { ...conf.app, security: { ...conf.app.security, capabilities: ["main-window", "other"] } } } }).join("\n"), /tauri\.conf\.json/);
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
  it("allows no name the shell does not pass, on macOS as on Linux (ps -E shows the environment given at start)", () => {
    assert.equal(helperProblems("the service", ["PATH", "__CF_USER_TEXT_ENCODING"], "node").length, 1);
    assert.equal(helperProblems("the service", ["XPC_SERVICE_NAME"], "node").length, 1);
  });
});

// Sample outputs. Linux: /proc/<pid>/environ is NUL-separated NAME=value entries (proc(5)); an
// unreadable file reads as "" here. macOS: `ps -E -ww -o command= -p <pid>` prints the command line
// followed by the environment; these samples follow ps(1)'s format and were not captured on a Mac.
const LINUX_ENVIRON = "PATH=/usr/bin:/bin\0HOME=/tmp/x/home\0AO_SERVICE_PORT=0\0AO_CONFIG_DIR=/tmp/x/settings\0LANG=C.UTF-8\0";
const MAC_CMD = "/Applications/Alexandrine Oxiana.app/Contents/Resources/node/node --max-old-space-size=512 /Applications/Alexandrine Oxiana.app/Contents/Resources/library-service/service.mjs";
const MAC_PS_E = `${MAC_CMD} PATH=/usr/bin:/bin HOME=/Users/runner AO_SERVICE_PORT=0 AO_CONFIG_DIR=/Users/runner/Library/Application Support/org.alexandrineoxiana.desktop/settings LANG=en_US.UTF-8`;

describe("reading a helper's environment, failing closed", () => {
  it("reads the names on each system", () => {
    assert.deepEqual(envNamesFromEnviron(LINUX_ENVIRON), ["PATH", "HOME", "AO_SERVICE_PORT", "AO_CONFIG_DIR", "LANG"]);
    assert.deepEqual(envNamesFromPsE(MAC_PS_E, MAC_CMD), ["PATH", "HOME", "AO_SERVICE_PORT", "AO_CONFIG_DIR", "LANG"]);
  });
  it("says null, not an empty list, when nothing could be read", () => {
    assert.equal(envNamesFromEnviron(""), null);
    assert.equal(envNamesFromPsE(MAC_CMD, MAC_CMD), null);
    assert.equal(envNamesFromPsE("", MAC_CMD), null);
  });
  it("reports an environment that could not be read, or lacks what the helper must have, as a failure", () => {
    const service = ["PATH", "AO_SERVICE_PORT", "AO_CONFIG_DIR"];
    assert.deepEqual(envEvidenceProblems("the service", envNamesFromEnviron(LINUX_ENVIRON), service), []);
    assert.deepEqual(envEvidenceProblems("the service", envNamesFromPsE(MAC_PS_E, MAC_CMD), service), []);
    assert.match(envEvidenceProblems("the service", null, service).join(), /could not check: the service's environment could not be read/);
    const p = envEvidenceProblems("the worker", ["PATH"], ["AO_WORKER_PORT"]);
    assert.equal(p.length, 1);
    assert.match(p[0], /could not check: the worker's environment as read lacks AO_WORKER_PORT/);
  });
});

describe("appProcesses", () => {
  it("finds every process of any copy of the app (its program and the helpers in its resources), and nothing else", () => {
    const table = parsePs(
      [
        "  10     1 S    /Users/runner/work/r/r/apps/desktop/src-tauri/target/debug/bundle/macos/Alexandrine Oxiana.app/Contents/MacOS/alexandrine-oxiana",
        "  11    10 S    /Users/runner/work/r/r/apps/desktop/src-tauri/target/debug/bundle/macos/Alexandrine Oxiana.app/Contents/Resources/node/node --max-old-space-size=512 x/service.mjs",
        "  12     1 S    /Volumes/Alexandrine Oxiana/Alexandrine Oxiana.app/Contents/MacOS/alexandrine-oxiana",
        "  13     1 S    /usr/bin/ssh-agent",
        "  14     1 S    node apps/desktop/scripts/launch-check.mjs --app /x/Alexandrine Oxiana.app",
      ].join("\n"),
    );
    assert.deepEqual(appProcesses(table).map((p) => p.pid), [10, 11, 12]);
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
    assert.equal(envNamesFromPsE(cmd, cmd), null);
  });
  it("reads the listening ports lsof reports", () => {
    const text = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 202 runner 21u IPv4 0x1 0t0 TCP 127.0.0.1:53817 (LISTEN)\nnode 202 runner 22u IPv6 0x2 0t0 TCP [::1]:53818 (LISTEN)\n";
    assert.deepEqual(parseLsofListen(text), [{ host: "127.0.0.1", port: 53817 }, { host: "::1", port: 53818 }]);
    assert.deepEqual(parseLsofListen(""), []);
  });
});
