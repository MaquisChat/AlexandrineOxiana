// The desktop end-to-end harness's pure parts (desktop.ts): the app's environment (nothing of the
// real home folder or of this process's settings), finding the native file dialog among the
// display's windows, reading the audit log, and the plain list of what is missing to run at all.
import { describe, expect, it } from "vitest";
import { desktopEnv, dialogWindow, missingPrerequisites, readAuditLines, readShellLog } from "./desktop.js";

describe("desktopEnv", () => {
  const env = desktopEnv("/tmp/ao-desktop-e2e-x", { display: ":42", bus: "unix:path=/tmp/bus", workerBin: "/tmp/w", nodeBin: "/usr/bin/node", serviceDir: "/svc", path: "/usr/bin:/bin" });

  it("puts home, settings, data and cache under the run's temporary folder, never the real home", () => {
    expect(env.HOME).toBe("/tmp/ao-desktop-e2e-x/home");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/ao-desktop-e2e-x/config");
    expect(env.XDG_DATA_HOME).toBe("/tmp/ao-desktop-e2e-x/data");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/ao-desktop-e2e-x/cache");
    expect(env.XDG_RUNTIME_DIR).toBe("/tmp/ao-desktop-e2e-x/runtime");
  });

  it("starts the debug shell on the run's own display and bus, with the built service and the worker", () => {
    expect(env).toMatchObject({ DISPLAY: ":42", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus", AO_DESKTOP_NODE: "/usr/bin/node", AO_DESKTOP_SERVICE_DIR: "/svc", AO_DESKTOP_WORKER_BIN: "/tmp/w", PATH: "/usr/bin:/bin" });
  });

  it("passes nothing else: no test mode (NODE_ENV), no proxy, no token, no other AO_ setting, no launch-check probe", () => {
    expect(Object.keys(env).sort()).toEqual(
      ["AO_DESKTOP_NODE", "AO_DESKTOP_SERVICE_DIR", "AO_DESKTOP_WORKER_BIN", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "HOME", "LANG", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"].sort(),
    );
  });
});

describe("readShellLog", () => {
  const svc = (o: Record<string, unknown>) => `[service] ${JSON.stringify({ level: 30, time: 1, pid: 9, ...o })}`;
  it("finds the service's address and an orderly stop on the end of its standard input", () => {
    const log = ["(alexandrine-oxiana:1): dbind-WARNING **: something", svc({ msg: "Server listening at http://127.0.0.1:43995" }), svc({ signal: "end of standard input", msg: "shutting down" })].join("\n");
    expect(readShellLog(log)).toEqual({ port: 43995, serviceStop: "end of standard input", forced: false });
  });
  it("finds a start-up failure in the shell's own words, and a forced stop", () => {
    const log = "Alexandrine Oxiana could not start: The library service will not start: no node.\nAlexandrine Oxiana: the library service did not stop in time and was stopped forcibly\n";
    expect(readShellLog(log)).toEqual({ startFailure: "The library service will not start: no node.", forced: true });
  });
  it("reads a service line that is not JSON as nothing", () => {
    expect(readShellLog("[service] not json\n")).toEqual({ forced: false });
  });
});

describe("dialogWindow", () => {
  const windows = [
    { id: "1", name: "alexandrine-oxiana" },
    { id: "2", name: "Alexandrine Oxiana" },
    { id: "3", name: "Attach files to Tide-line interviews" },
  ];
  it("finds the native dialog by its exact title", () => {
    expect(dialogWindow(windows, "Attach files to Tide-line interviews")).toBe("3");
  });
  it("is undefined while no window has that title (the app's own windows never match)", () => {
    expect(dialogWindow(windows.slice(0, 2), "Attach files to Tide-line interviews")).toBeUndefined();
    expect(dialogWindow(windows, "Attach files to Tide-line")).toBeUndefined();
  });
});

describe("readAuditLines", () => {
  it("reads one JSON entry per line and says which lines are not JSON", () => {
    const { entries, unreadable } = readAuditLines('{"a":1}\n\n{"b":2}\nnot json\n');
    expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
    expect(unreadable).toEqual([4]);
  });
});

describe("missingPrerequisites", () => {
  it("names each missing piece and how to get it, in plain words", () => {
    const missing = missingPrerequisites({ exists: () => false, onPath: () => false, tauriDriver: undefined, worker: undefined });
    const text = missing.join("\n");
    expect(missing).toHaveLength(8);
    expect(text).toMatch(/built app.*build:linux/);
    expect(text).toMatch(/library service folder.*build:linux/);
    expect(text).toMatch(/tauri-driver.*cargo install tauri-driver --version =2\.1\.0 --locked/);
    expect(text).toMatch(/WebKitWebDriver.*webkit2gtk-driver/);
    expect(text).toMatch(/Xvfb.*xvfb/);
    expect(text).toMatch(/dbus-daemon.*dbus/);
    expect(text).toMatch(/xdotool.*xdotool/);
    expect(text).toMatch(/media worker.*setup:py/);
  });
  it("is empty when everything is there", () => {
    expect(missingPrerequisites({ exists: () => true, onPath: () => true, tauriDriver: "/x/tauri-driver", worker: "/x/w" })).toEqual([]);
  });
});
