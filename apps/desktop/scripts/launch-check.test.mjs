// The launch check's own logic: reading the shell's test output and judging the probe's result and
// the helpers' environments. (The check itself needs a display and the built shell: launch-check.mjs.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appProcesses, CAPABILITIES_DIR, capabilityFileProblems, capabilityProblems, platformConfFiles, envEvidenceProblems, envNamesFromEnviron, envNamesFromPsE, EXPECTED_IPC, EXPECTED_LIBRARY_WINDOW_IPC, helperProblems, LIBRARY_PROBE_JS, libraryProbeProblems, libraryReportFrom, MAIN_WINDOW_PERMISSIONS, NOT_PROBED_IPC, parseArgs, parseLsofListen, parsePs, parseShellLine, probeProblems, shellOf, TAURI_CONF } from "./launch-check.mjs";

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
      Object.keys(EXPECTED_IPC).filter((k) => !LIBRARY_SIX.includes(k)).sort(),
      ["app.version", "dialog.message", "dialog.save", "event.emit", "event.listen", "fs.readFile", "path.resolveDirectory", "watch.pick", "webview.print", "window.close"],
    );
    // The probe does not call it (it would open the chooser); the capability file is read instead.
    assert.equal(NOT_PROBED_IPC["watch.pick"], "allow-pick-watch-folder");
    const { files, capability, conf } = read();
    assert.deepEqual(capabilityProblems({ files, capability, conf }), []);
    assert.deepEqual(capability.permissions.slice(0, 4), ["core:event:allow-listen", "core:event:allow-unlisten", "dialog:allow-open", "allow-pick-watch-folder"]);
    // Task F16: the library sign-in window's six commands, and nothing else.
    assert.deepEqual(capability.permissions.slice(4), ["allow-open-library-window", "allow-library-window-take-pdf", "allow-close-library-window", "allow-sign-out-of-library", "allow-set-stay-signed-in", "allow-open-in-browser"]);

    const probed = Object.fromEntries(Object.entries(EXPECTED_IPC).filter(([k]) => !(k in NOT_PROBED_IPC)));
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

  it("reads the platform files Tauri merges over the configuration, and refuses any security setting or capability in them", () => {
    const { files, capability, conf } = read();
    // The real files as they are: tauri.macos.conf.json is read and passes.
    assert.ok(platformConfFiles().includes("tauri.macos.conf.json"));
    assert.deepEqual(capabilityFileProblems(), []);
    const macos = JSON.parse(readFileSync(join(dirname(TAURI_CONF), "tauri.macos.conf.json"), "utf8"));
    const check = (platform) => capabilityProblems({ files, capability, conf, platform });
    assert.deepEqual(check([{ name: "tauri.macos.conf.json", conf: macos }]), []);
    for (const security of [{ capabilities: ["main-window", "other"] }, { capabilities: [{ identifier: "x", windows: ["*"], permissions: ["fs:default"] }] }, { csp: null }, {}]) {
      const p = check([{ name: "tauri.macos.conf.json", conf: { ...macos, app: { security } } }]);
      assert.match(p.join("\n"), /tauri\.macos\.conf\.json sets app\.security/, JSON.stringify(security));
    }
    assert.match(check([{ name: "tauri.linux.conf.json", conf: { app: { security: { capabilities: [] } } } }]).join("\n"), /tauri\.linux\.conf\.json/);
    // A platform file that cannot be read as JSON cannot be checked: it fails.
    assert.match(check([{ name: "tauri.windows.conf.toml", conf: null }]).join("\n"), /tauri\.windows\.conf\.toml could not be checked/);
  });
});

/** The sign-in window's six commands (Task F16) as the main window's table names them. */
const LIBRARY_SIX = ["library.open", "library.take", "library.close", "library.signOut", "library.stay", "browser.open"];

describe("the main window gains exactly six permissions (Task F19)", () => {
  it("the six library commands are allowed and judged from the capability file, not probed", () => {
    for (const k of LIBRARY_SIX) assert.equal(EXPECTED_IPC[k], "allowed", k);
    assert.deepEqual(NOT_PROBED_IPC, {
      "watch.pick": "allow-pick-watch-folder",
      "library.open": "allow-open-library-window",
      "library.take": "allow-library-window-take-pdf",
      "library.close": "allow-close-library-window",
      "library.signOut": "allow-sign-out-of-library",
      "library.stay": "allow-set-stay-signed-in",
      "browser.open": "allow-open-in-browser",
    });
    // Exactly the four the main window had before Task F16, and these six.
    assert.deepEqual(MAIN_WINDOW_PERMISSIONS, ["core:event:allow-listen", "core:event:allow-unlisten", "dialog:allow-open", ...Object.values(NOT_PROBED_IPC)]);
    // Not reported by the probe: no problem; reported, it must be what the table says.
    const probed = Object.fromEntries(Object.entries(EXPECTED_IPC).filter(([k]) => !(k in NOT_PROBED_IPC)));
    assert.deepEqual(probeProblems({ ...GOOD, ipc: probed }, { media: true }), []);
    assert.match(probeProblems({ ...GOOD, ipc: { ...EXPECTED_IPC, "library.take": "denied" } }, { media: true }).join("\n"), /library\.take is denied, expected allowed/);
  });
});

/** A sign-in window's report in which everything was refused, as the probe sends it. */
const LIBRARY_GOOD = {
  probe: "library",
  origin: "http://127.0.0.1:40125",
  internals: true,
  ipc: { ...EXPECTED_LIBRARY_WINDOW_IPC },
  raw: { "ipc.postMessage": "sent", "fetch.ipc": "refused" },
};

describe("the library window may call nothing (Task F19, R343 b)", () => {
  it("every command of the app, the event system, the folder chooser and one command of each other core family (image, resources, menu, tray) and of the dialog's ask and confirm is expected to be denied there (R346 h)", () => {
    assert.deepEqual(Object.keys(EXPECTED_LIBRARY_WINDOW_IPC).sort(), [
      "app.version",
      "browser.open",
      "dialog.ask",
      "dialog.confirm",
      "dialog.message",
      "dialog.open",
      "dialog.save",
      "event.emit",
      "event.emitTo",
      "event.listen",
      "event.unlisten",
      "fs.readFile",
      "image.new",
      "library.close",
      "library.open",
      "library.signOut",
      "library.stay",
      "library.take",
      "menu.new",
      "path.resolveDirectory",
      "resources.close",
      "tray.new",
      "watch.pick",
      "webview.print",
      "window.close",
    ]);
    for (const [k, v] of Object.entries(EXPECTED_LIBRARY_WINDOW_IPC)) assert.equal(v, "denied", k);
    // Every command of the main window's table is in it, the six library ones included.
    for (const k of Object.keys(EXPECTED_IPC)) assert.ok(k in EXPECTED_LIBRARY_WINDOW_IPC, k);
  });

  it("the probe in the sign-in window tries exactly the commands of the table", () => {
    const tried = [...LIBRARY_PROBE_JS.matchAll(/\btry_\("([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(tried, Object.keys(EXPECTED_LIBRARY_WINDOW_IPC).sort());
  });

  it("accepts a report in which everything was refused", () => {
    assert.deepEqual(libraryProbeProblems(LIBRARY_GOOD), []);
    // Without __TAURI_INTERNALS__ nothing can be called at all: refused as well.
    const none = Object.fromEntries(Object.keys(EXPECTED_LIBRARY_WINDOW_IPC).map((k) => [k, "no IPC"]));
    assert.deepEqual(libraryProbeProblems({ ...LIBRARY_GOOD, internals: false, ipc: none }), []);
  });

  it("fails when the probe reported nothing, ran in the app's own page, or anything was allowed or not answered", () => {
    assert.deepEqual(libraryProbeProblems(null), ["the sign-in window's probe reported nothing"]);
    assert.deepEqual(libraryProbeProblems(undefined), ["the sign-in window's probe reported nothing"]);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, probe: "main" }).join("\n"), /not the sign-in window's probe/);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, origin: "tauri://localhost" }).join("\n"), /ran in tauri:\/\/localhost/);
    const p = libraryProbeProblems({ ...LIBRARY_GOOD, ipc: { ...EXPECTED_LIBRARY_WINDOW_IPC, "library.take": "allowed", "event.listen": "no answer", "watch.pick": "error: x" } });
    assert.equal(p.length, 3, p.join("\n"));
    assert.match(p.join("\n"), /library\.take is allowed, expected denied/);
    assert.match(p.join("\n"), /event\.listen is no answer, expected denied/);
    assert.match(p.join("\n"), /watch\.pick is error: x, expected denied/);
    const { "browser.open": _b, ...missing } = EXPECTED_LIBRARY_WINDOW_IPC;
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, ipc: missing }).join("\n"), /browser\.open is not reported/);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, internals: false }).join("\n"), /library\.open is denied, expected no IPC/);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, raw: { ...LIBRARY_GOOD.raw, "fetch.ipc": "allowed" } }).join("\n"), /fetch\.ipc was allowed/);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, raw: undefined }).join("\n"), /raw entry points were not tried/);
    assert.match(libraryProbeProblems({ ...LIBRARY_GOOD, error: "boom" }).join("\n"), /the probe failed: boom/);
  });

  it("reads the report from the address the probe went to, and nothing else", () => {
    const r = encodeURIComponent(JSON.stringify(LIBRARY_GOOD));
    assert.deepEqual(libraryReportFrom(`/report?r=${r}`), LIBRARY_GOOD);
    assert.equal(libraryReportFrom("/report?r=%7Bbroken"), null);
    assert.equal(libraryReportFrom("/report"), null);
    assert.equal(libraryReportFrom("/page"), undefined);
  });

  it("reads the sign-in window's state lines", () => {
    assert.deepEqual(parseShellLine("AO_SHELL_LIBRARY opened"), { kind: "library", state: "opened" });
    assert.deepEqual(parseShellLine("AO_SHELL_LIBRARY closed"), { kind: "library", state: "closed" });
    assert.deepEqual(parseShellLine("AO_SHELL_BROWSER_OPENED"), { kind: "browser-opened" });
    assert.equal(parseShellLine("AO_SHELL_LIBRARY https://x"), null);
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
